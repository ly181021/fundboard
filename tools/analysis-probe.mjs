/**
 * AI 解读探测（真实数据 + 真实模型）：复刻 /api/analysis 的 context（同字段 + 同脱敏），
 * 用线上模型/提示词（或候选提示词）调一次并打印结果，用于模型选型与提示词对比。
 *
 * 用法：
 *   node tools/analysis-probe.mjs          # 线上提示词 + 线上模型（配了 analysis 段则用它）
 *   node tools/analysis-probe.mjs <键名>   # 用下方 PROMPTS 的候选提示词对比（需自行维护）
 *
 * 与线上有意为之的两处差异（运行时也会打印提示）：
 *   ① `strategy`字段恒为 0：本探针不运行策略引擎，故提示词第 2 条的风险提示会比线上偏弱；
 *   ② 金额一律走 `redactAnalysisContext` 脱敏（与线上同口径），不会把金额发给网关。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatasource } from '../lib/datasource.js';
import { loadOcrConfig, buildAnalysisMessages } from '../lib/ocr.js';
import { computeState, applyQuote, computeXIRR, buildFundFlows } from '../js/calculator.js';
import {
  computeAttribution,
  computeConcentration,
  buildReportLines,
  redactAnalysisContext,
} from '../js/analysis.js';

const db = JSON.parse(await readFile(new URL('../data/db.json', import.meta.url), 'utf8'));
const todayStr = new Date().toLocaleDateString('sv-SE');

// ---- 复刻 app.js runAiAnalysis 的 context 组装（字段一致 + 同一层脱敏）----
const ds = createDatasource();
const { quotes } = await ds.fetchQuoteBatch([...new Set(db.assets.map((a) => a.code))]);
const quotesMap = Object.fromEntries(quotes.map((q) => [q.code, q]));
const fundStates = db.assets
  .filter((a) => a.asset_type === 'fund')
  .map((a) => {
    const state = computeState(a.snapshot, a.transactions);
    const quote = quotesMap[a.code];
    const merged = quote
      ? applyQuote(state, quote, todayStr, a.name)
      : {
          ...state,
          latestNav: null,
          navDate: null,
          mode: null,
          dailyProfit: null,
          dailyChangePct: null,
          yesterdayProfit: null,
        };
    merged.returnRate = merged.totalInvested > 0 ? merged.holdProfit / merged.totalInvested : null;
    merged.xirr = computeXIRR(buildFundFlows(a, merged, todayStr));
    return { name: a.name, code: a.code, state: merged };
  });

const attribution = computeAttribution(fundStates);
const concentration = computeConcentration(fundStates);
const indexes = await ds.fetchIndexes();
const dateCands = fundStates
  .map((f) => f.state.dataDate ?? f.state.navDate)
  .filter(Boolean)
  .map(String);
// max 初始值取首个候选（字符串对字符串）：null 起比 '日期' > null 得 NaN 恒 false，max 恒为 null
const dataDate = dateCands.length ? dateCands.reduce((m, d) => (d > m ? d : m)) : todayStr;
const dailyProfit = fundStates
  .map((f) => f.state.dailyProfit)
  .filter((v) => v != null)
  .reduce((s, v) => s + v, 0);
const yesterdays = fundStates.map((f) => f.state.yesterdayProfit).filter((v) => v != null);
const totalInvested = fundStates.reduce((s, f) => s + f.state.totalInvested, 0);
const totalHoldProfit = fundStates.reduce((s, f) => s + f.state.holdProfit, 0);
const assets = fundStates.map((f) =>
  f.state.latestNav != null ? f.state.holdShares * f.state.latestNav : null,
);
const totalAssets =
  assets.length > 0 && assets.every((v) => v != null) ? assets.reduce((s, v) => s + v, 0) : null;
const totalAmount = fundStates.reduce((s, f) => s + (f.state.holdAmount ?? 0), 0);
const portfolioXirr = (() => {
  const flows = [];
  for (const f of fundStates) flows.push(...buildFundFlows(f, f.state, todayStr));
  return computeXIRR(flows);
})();

const context = redactAnalysisContext({
  date: dataDate,
  report: buildReportLines({
    today: todayStr,
    dataDate,
    summary: {
      fundCount: fundStates.length,
      upCount: fundStates.filter((f) => f.state.dailyProfit > 0).length,
      downCount: fundStates.filter((f) => f.state.dailyProfit < 0).length,
      dailyProfit,
      yesterdayProfit: yesterdays.length > 0 ? yesterdays.reduce((s, v) => s + v, 0) : null,
    },
    attribution,
    indexData: indexes,
    concentration,
    redactMoney: true,
  }).join(''),
  summary: {
    returnRate: totalInvested > 0 ? totalHoldProfit / totalInvested : null,
    anyEstimate: fundStates.some((f) => f.state.mode === 'estimate'),
    dailyReturnPct:
      totalAssets != null && totalAssets - dailyProfit > 0
        ? Math.round((dailyProfit / (totalAssets - dailyProfit)) * 10000) / 10000
        : null,
  },
  attribution: { gainers: attribution.gainers.slice(0, 3), losers: attribution.losers.slice(0, 3) },
  concentration,
  indexes,
  portfolioXirr,
  // 探针不跑策略引擎 → 恒为 0（见文件头差异①）
  strategy: { actionCount: 0, summary: { exit: 0, stopLoss: 0, takeProfit: 0, add: 0 } },
  funds: fundStates.map((f) => ({
    name: f.name,
    returnRate: f.state.returnRate,
    xirr: f.state.xirr,
    weightPct:
      totalAmount > 0 && f.state.holdAmount != null
        ? Math.round((f.state.holdAmount / totalAmount) * 10000) / 10000
        : null,
  })),
});

// ---- 候选提示词（做对比时在此新增；键名即命令行参数）----
// 候选提示词须遵循线上口径：含 dailyReturnPct / weightPct 字段、金额脱敏（「金额不出网」）；
// 直接复制 lib/ocr.js 的 AI_INTERPRET_PROMPT 再改写。
const PROMPTS = {};

const variant = process.argv[2] ?? 'current';
if (variant !== 'current' && !PROMPTS[variant]) {
  console.error(
    `未知提示词变体「${variant}」；可用：current${Object.keys(PROMPTS).length ? ' / ' + Object.keys(PROMPTS).join(' / ') : '（暂无候选）'}`,
  );
  process.exit(2);
}

const loaded = await loadOcrConfig({
  configPath: fileURLToPath(new URL('../ocr.config.json', import.meta.url)),
});
if (!loaded) {
  console.error('未配置模型（ocr.config.json 无有效三要素）');
  process.exit(1);
}
// 与 /api/analysis 路由同口径：配了 analysis 段就用它，否则与截图识别同模型
const config = loaded.analysis ?? loaded;
console.log(
  `提示词变体：${variant}（模型 ${config.model}${loaded.analysis ? '｜来自 analysis 段' : '｜与截图识别同模型'}）`,
);
console.log('⚠ 探针差异：strategy 恒为 0（未跑策略引擎）；金额已脱敏');
console.log('---- context（即实际发往网关的内容）----');
console.log(JSON.stringify(context, null, 2));

const messages =
  variant === 'current'
    ? buildAnalysisMessages(context)
    : [{ role: 'user', content: `${PROMPTS[variant]}\n\n数据：\n${JSON.stringify(context)}` }];

// 说明：这里直接用 fetch 以支持候选提示词（interpret 固定用线上提示词）；超时策略与线上保持一致
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 60000);
let res;
try {
  res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages }),
    signal: ac.signal,
  });
} catch (e) {
  console.error(ac.signal.aborted ? '模型响应超时（60 秒未返回）' : `请求失败：${e.message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
if (!res.ok) {
  console.error(`模型 HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const payload = await res.json();
const content = payload?.choices?.[0]?.message?.content;
const text = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : content;
console.log('---- 输出 ----');
console.log(String(text ?? '(空)').trim());
