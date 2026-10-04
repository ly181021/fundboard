/**
 * 每日行情分析纯函数。
 * 输入均为已算好的结构化数据（fundStates / 历史净值序列），零副作用可单测。
 */
import { applyBuy, applySell, applyDividend, computeState, nextWorkdayOf } from './calculator.js';

const fmt2 = (v) => {
  const s = Math.abs(v).toFixed(2);
  return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
};

/**
 * 盈亏归因：按当日收益绝对值降序分组。
 * 返回 { gainers: [{name, dailyProfit}], losers: [...] }；无行情返回空分组。
 */
export function computeAttribution(fundStates) {
  const rows = (fundStates || [])
    .filter((f) => f.state && f.state.dailyProfit != null)
    .map((f) => ({ name: f.name, dailyProfit: f.state.dailyProfit }));
  const byAbs = (a, b) => Math.abs(b.dailyProfit) - Math.abs(a.dailyProfit);
  return {
    gainers: rows.filter((r) => r.dailyProfit > 0).sort(byAbs),
    losers: rows.filter((r) => r.dailyProfit < 0).sort(byAbs),
  };
}

/**
 * 持仓集中度：按最新市值算 top1/top3 占比。
 * top1 > 60% 或 top3 > 90% 视为集中告警。
 */
export function computeConcentration(fundStates) {
  const values = (fundStates || []).map((f) => f.state?.holdAmount).filter((v) => v != null);
  if (values.length === 0) return { top1: 0, top3: 0, alert: false };
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return { top1: 0, top3: 0, alert: false };
  const sorted = [...values].sort((a, b) => b - a);
  const top1 = sorted[0] / total;
  const top3 = sorted.slice(0, 3).reduce((s, v) => s + v, 0) / total;
  return { top1, top3, alert: top1 > 0.6 || top3 > 0.9 };
}

/**
 * 区间最大回撤：max((峰值 − 谷值) ÷ 峰值)，峰值在前。
 * 返回 { maxDrawdown, peakDate, troughDate }；序列不足两点时 maxDrawdown 为 0，空序列为 null。
 */
export function computeDrawdown(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return { maxDrawdown: null, peakDate: null, troughDate: null };
  }
  let peak = -Infinity;
  let peakDate = null;
  let maxDrawdown = 0;
  let peakDateAtMax = null;
  let troughDateAtMax = null;
  for (const point of series) {
    if (point.nav == null) continue;
    if (point.nav > peak) {
      peak = point.nav;
      peakDate = point.date;
    }
    if (peak > 0) {
      const dd = (peak - point.nav) / peak;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        peakDateAtMax = peakDate;
        troughDateAtMax = point.date;
      }
    }
  }
  return { maxDrawdown, peakDate: peakDateAtMax, troughDate: troughDateAtMax };
}

/**
 * 今日报告条目（规则填充非 AI；逐条输出，供无序列表渲染）。
 * 返回 string[]：0–4 条，顺序为 ①持仓统计 ②归因极值 ③大盘参照 ④集中度告警。
 * 无指数数据略去大盘句；无集中度告警略去提示句；空持仓返回 []（卡片不渲染）。
 * 口径随数据日期：dataDate === today（估值/当日确认净值）→ "当日"；
 * 净值滞后（QDII 等）→ "最新净值日（MM-DD）"；昨日副注统一写"前一日"（相对数据日期）。
 * redactMoney=true：金额位置替换为占位（AI 解读「金额不出网」用；比例/占比/计数/涨跌幅不受影响）。
 */
export function buildReportLines({
  today,
  dataDate,
  summary,
  attribution,
  indexData,
  concentration,
  redactMoney = false,
}) {
  const s = summary;
  if (!s || s.fundCount === 0) return [];
  const money = (v) => (redactMoney ? MONEY_REDACTED : fmt2(v));
  const dayLabel = !dataDate || dataDate === today ? '当日' : `最新净值日（${dataDate.slice(5)}）`;
  const lines = [];
  lines.push(
    `持仓 ${s.fundCount} 只：${s.upCount} 涨 ${s.downCount} 跌，${dayLabel}盈亏 ${money(s.dailyProfit ?? 0)} 元` +
      (s.yesterdayProfit != null ? `（前一日 ${money(s.yesterdayProfit)}）` : '') +
      '。',
  );
  const g = attribution?.gainers?.[0];
  const l = attribution?.losers?.[0];
  if (g && l) {
    lines.push(
      `贡献最大：${g.name} ${money(g.dailyProfit)}；拖累最多：${l.name} ${money(l.dailyProfit)}。`,
    );
  }
  if (Array.isArray(indexData) && indexData.length > 0) {
    lines.push(
      `大盘参照：${indexData.map((i) => `${i.name} ${fmt2(i.change_pct)}%`).join('、')}。`,
    );
  }
  if (concentration?.alert) {
    lines.push(`⚠ 持仓集中度较高（top1 占 ${Math.round(concentration.top1 * 100)}%）。`);
  }
  return lines;
}

/** 金额脱敏占位（AI 解读外发时替代一切绝对金额） */
export const MONEY_REDACTED = '•••';

/**
 * 今日报告整段文案（多句拼接，供 AI 解读的上下文使用；网页按逐条列表展示）。
 * date 非空时前缀 "8月30日 · "。
 */
export function generateDailyReport({
  date,
  today,
  dataDate,
  summary,
  attribution,
  indexData,
  concentration,
  redactMoney = false,
}) {
  const lines = buildReportLines({
    today,
    dataDate,
    summary,
    attribution,
    indexData,
    concentration,
    redactMoney,
  });
  if (lines.length === 0) return null;
  return `${date ? date + ' · ' : ''}${lines.join('')}`;
}

/**
 * AI 解读出网脱敏（「金额不出网」）：绝对金额一律不外发，
 * 只保留比例 / 占比 / 计数 / 指数涨跌幅等非金额口径。
 * 规则报告文案另由 buildReportLines({redactMoney:true}) 生成；此处处理结构化字段。
 * 纯函数：返回新对象，不改入参。
 */
export function redactAnalysisContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const s = c.summary && typeof c.summary === 'object' ? c.summary : {};
  const funds = Array.isArray(c.funds) ? c.funds : [];
  return {
    date: c.date ?? null,
    // 规则报告（金额已替换为占位）
    report: typeof c.report === 'string' ? c.report : null,
    summary: {
      returnRate: numOrNull(s.returnRate), // 组合持有收益率（比例，非金额）
      anyEstimate: !!s.anyEstimate,
      dailyReturnPct: numOrNull(s.dailyReturnPct), // 组合单日涨跌幅（比例；金额口径的异常波动判断用它）
    },
    // 归因只留顺序（顺序本身即"盈亏集中在哪几只"的信号），金额去除
    attribution: {
      gainers: (c.attribution?.gainers ?? []).map((r) => ({ name: r?.name ?? null })),
      losers: (c.attribution?.losers ?? []).map((r) => ({ name: r?.name ?? null })),
    },
    concentration: {
      top1: numOrNull(c.concentration?.top1),
      top3: numOrNull(c.concentration?.top3),
      alert: !!c.concentration?.alert,
    },
    indexes: (Array.isArray(c.indexes) ? c.indexes : []).map((i) => ({
      name: i?.name ?? null,
      change_pct: numOrNull(i?.change_pct),
    })),
    portfolioXirr: numOrNull(c.portfolioXirr),
    strategy: {
      actionCount: Number.isFinite(Number(c.strategy?.actionCount))
        ? Number(c.strategy.actionCount)
        : 0,
      summary: { ...(c.strategy?.summary ?? {}) },
    },
    // 基金只留名称与收益口径；持仓规模改以占比表达（金额不出网，但保留"试仓"判断所需的大小信号）
    funds: funds.map((f) => ({
      name: f?.name ?? null,
      returnRate: numOrNull(f?.returnRate),
      xirr: numOrNull(f?.xirr),
      weightPct: numOrNull(f?.weightPct), // 持仓占比（比例，非金额）——调用方按市值算出后传入
    })),
  };
}

const numOrNull = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);

/* ==================== 收益率可视化 ==================== */

const round2 = (v) => Math.round(v * 100) / 100;

/** 日期辅助（本地时区）：'YYYY-MM-DD' ↔ Date；startOfWeek 取周一 */
export function parseISODate(s) {
  const p = String(s).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}
export function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
export function startOfWeek(d) {
  const r = new Date(d);
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

/**
 * 收益率对比条形图数据：基金按持有收益率降序；收益率为 null 的基金不参与。
 * funds: [{name, state:{returnRate, xirr}}]（returnRate 为小数比例）。
 * （组合行已移除——组合收益率在汇总卡与 AI 解读里已有展示。）
 */
export function buildReturnRows(funds) {
  return (funds || [])
    .filter((f) => f.state && f.state.returnRate != null)
    .sort((a, b) => b.state.returnRate - a.state.returnRate)
    .map((f) => ({ name: f.name, returnRate: f.state.returnRate, xirr: f.state.xirr ?? null }));
}

/** 当日盈亏金额分级（0 中性；1–4 随金额增大；阈值固定，色阶不随数据积累漂移） */
export function profitLevel(v) {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a === 0) return 0;
  if (a <= 30) return 1;
  if (a <= 80) return 2;
  if (a <= 150) return 3;
  return 4;
}

/**
 * 逐基金到账收益日志，data.daily 单条元素。
 * 前端 js/app.js 与服务端 lib/snapshot.js 统一口径。
 * @property {string} date - 到账日：收益拉取入账日期。
 * @property {string} navDate - 收益对应的净值日期，业绩走势以此归属。
 * @property {number} earnings - 该净值日持仓盈亏（元，round2舍入至分）。
 * @property {number} invested - 入账时刻累计本金快照，作为当日收益率分母。
 * @property {number} assets - 入账时刻基金市值（份额×确认净值），供资产曲线前向填充。
 */
/**
 * 到账入账逻辑：基金净值日更新时生成单条记录，与 tools/migrate‑daily‑arrival.mjs 存量重建同源。
 * 国内基金：到账日等于净值日，净值于晚间披露；
 * QDII，entries携带qdii:true，通过基金名称辅助识别：到账日取navDate之后第一个A股交易日。
 * 使用nextWorkdayOf计算，节假日集合由调用方通过js/tradingCalendar.js注入，缺失输入则仅跳过周末做降级处理。
 * 与js/calculator.js applyQuote的当日、昨日列复用同一套实现，避免前后端口径漂移。
 *
 * 收益仅归属对应交易日。周末、节假日执行补拉，不会将上一交易日净值记录至补拉当日。
 * entries：[{code, navDate, earnings, invested, assets, qdii}]，估值模式下不传入该字段集合。
 * 幂等逻辑：code加navDate已存在则跳过新增；返回 { list, changed }。
 */

export function bookArrivals(daily, entries, holidays) {
  const list = Array.isArray(daily) ? [...daily] : [];
  let changed = false;
  for (const e of entries || []) {
    if (!e || !e.code || !e.navDate) continue;
    let lastNav = null;
    for (const r of list) {
      if (r?.code === e.code && r.navDate != null && (lastNav == null || r.navDate > lastNav))
        lastNav = r.navDate;
    }
    if (lastNav != null && !(e.navDate > lastNav)) continue; // 净值日期未推进 → 不重复入账
    list.push({
      code: e.code,
      date: e.qdii ? nextWorkdayOf(e.navDate, holidays) : e.navDate,
      navDate: e.navDate,
      earnings: round2(e.earnings ?? 0),
      invested: round2(e.invested ?? 0),
      assets: round2(e.assets ?? 0),
    });
    changed = true;
  }
  return { list, changed };
}

/**
 * 本金跳变巡检（口径Ⅰ）。
 * 服务端定时巡检、页面「未留痕」徽标、tools/check-daily-invested.mjs 共用同一判定规则。
 *
 * 逐基金对比相邻到账日志 invested 本金：
 * 窗口 (上一行日期, 本行日期] 内有交易 → 交易解释；
 * 无交易但被 corrections 认领 → 修正留痕；
 * 无交易且无留痕 → 未留痕（仅手动改本金无记录场景，需补录）。
 *
 * 返回 { jumps: [{code,name,date,from,to,txCount,claimed,status}], unexplained: [...] }
 * status 可选值：交易解释 / 修正留痕 / 未留痕。
 */
export function auditPrincipalJumps(daily, corrections = [], assets = []) {
  const log = (Array.isArray(daily) ? daily : []).filter(
    (r) => r && r.code && r.date && r.invested != null,
  );
  const resolved = resolveCorrections(log, corrections);
  const assetList = Array.isArray(assets) ? assets : [];
  const nameOf = new Map(assetList.map((a) => [a?.code, a?.name]));
  const txOf = new Map(
    assetList.map((a) => [a?.code, Array.isArray(a?.transactions) ? a.transactions : []]),
  );

  const byFund = new Map();
  for (const r of log) {
    if (!byFund.has(r.code)) byFund.set(r.code, []);
    byFund.get(r.code).push(r);
  }

  const jumps = [];
  for (const [code, list] of byFund) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const txs = txOf.get(code) || [];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const from = round2(prev.invested);
      const to = round2(cur.invested);
      if (from === to) continue;
      const windowTxs = txs.filter((t) => t && t.date && t.date > prev.date && t.date <= cur.date);
      const claimed = (resolved[cur.date] || []).some(
        (x) => x.code === code && round2(x.to) === to,
      );
      jumps.push({
        code,
        name: nameOf.get(code) ?? code,
        date: cur.date,
        from,
        to,
        txCount: windowTxs.length,
        claimed,
        status: claimed ? '修正留痕' : windowTxs.length > 0 ? '交易解释' : '未留痕',
      });
    }
  }
  return { jumps, unexplained: jumps.filter((j) => j.status === '未留痕') };
}

/**
 * 修正留痕的"体现状态"（供页面"本金修正待体现"徽标）：返回尚未在到账日志中体现的修正记录。
 * 已体现 = 该基金存在一条 date ≥ 修正生效日、且 invested == 修正后本金 的日志行（下次入账写入新本金即达成）；
 * 被覆盖 = 同一基金存在一条更晚（at/date 更大）且已体现的修正——例如连改两次，日志直接从旧值跳到最新值，
 *   中间那条永远不会被认领，但它已被后续修正覆盖，不该让徽标一直挂着；
 * 其余即"待体现"：徽标显示，待入账日志写入新本金后由 resolveCorrections 认领、徽标自动消失。
 * 入参非法（缺 to）的记录不计入（避免脏数据让徽标永久驻留）。
 */
export function pendingCorrections(daily, corrections = []) {
  const list = (Array.isArray(corrections) ? corrections : []).filter(
    (c) => c && c.code && Number.isFinite(Number(c.to)),
  );
  const logs = (Array.isArray(daily) ? daily : []).filter((r) => r && r.code && r.date);
  const reflected = (c) =>
    logs.some(
      (r) =>
        r.code === c.code &&
        String(r.date) >= String(c.date ?? '') &&
        round2(r.invested) === round2(c.to),
    );
  const keyOf = (c) => String(c.at ?? c.date ?? '');
  return list.filter(
    (c) =>
      !reflected(c) &&
      !list.some((o) => o !== c && o.code === c.code && keyOf(o) > keyOf(c) && reflected(o)),
  );
}

/**
 * 构造一条本金修正留痕记录（口径Ⅰ；app.js编辑本金时调用）。
 *
 * from/to 必须是「生效本金」：到账日志 invested、resolveCorrections、巡检比对统一使用生效值
 * 生效本金 = 快照基线 + 买入 − 卖出成本。
 * 编辑入口请优先使用 buildPrincipalCorrection（内部处理换算）；
 * 直接调用本函数传入快照基线，有交易基金留痕无法认领，导致徽标常驻、巡检误报。
 *
 * round2后本金相等（防止浮点尾差产生假记录）或入参非法 → 返回 null，不生成留痕。
 * at：审计记录时间戳，可为 null。
 */
export function principalCorrection({ code, prevInvested, nextInvested, date, at = null }) {
  const from = Number(prevInvested);
  const to = Number(nextInvested);
  if (!code || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (round2(from) === round2(to)) return null;
  return {
    code,
    field: 'total_invested',
    date: String(date ?? ''),
    from: round2(from),
    to: round2(to),
    at,
  };
}

/**
 * 编辑本金，生成修正留痕记录（编辑入口专用，内部按生效口径换算）。
 *
 * 本金双口径说明：
 * snapshot.total_invested：快照基线（用户手填）；
 * computeState().totalInvested：生效本金 = 基线 + 买入 − 卖出成本，到账日志 invested 使用该口径。
 *
 * 二者仅在基金无交易时相等。留痕必须使用生效口径；口径错误会导致有交易基金无法认领记录，
 * 徽标永久驻留、巡检误报「未留痕」。换算收敛在此函数，调用方只需传入修改前后快照。
 */
export function buildPrincipalCorrection({
  code,
  prevSnapshot,
  nextSnapshot,
  transactions,
  date,
  at = null,
}) {
  const prevInvested = computeState(prevSnapshot, transactions).totalInvested;
  const nextInvested = computeState(nextSnapshot, transactions).totalInvested;
  return principalCorrection({ code, prevInvested, nextInvested, date, at });
}
/**
 * 重加已有到账日志的基金时生成本金修正留痕，口径Ⅰ，由submitSnapshot新增分支调用。
 *
 * 末行取值：按（到账日，净值日）双键升序取末行。同日多行为节假日合并到账的真实形态，
 * QDII多个连续净值日的到账日会落在同一个首个A股交易日，取净值日更新的行作为最新本金快照。
 * 仅按到账日排序会依赖数组插入顺序，双键排序消除该隐式依赖。
 *
 * 幂等闸：corrections已存在相同code、生效日、前后本金的记录，比对忽略at时间戳，则返回null。
 * 服务端并集去重基于完整记录比对，时间戳不同不会触发去重。corrections集合只增不减，重复记录会形成永久噪声。
 *
 * 记录生成复用principalCorrection。round2舍入后本金相等，用于规避同本金重加产生虚假记录；入参非法时直接透传null。
 * 本函数为纯函数，无副作用，承诺不抛出异常。date与at由调用方注入，函数内部不读取系统时间。
 *
 * @param {Array} daily 到账日志 [{code, date, navDate, invested}]
 * @param {Array} corrections 既有修正留痕记录
 * @param {string} code 基金代码
 * @param {number} nextInvested 重加快照的生效本金，新增基金无交易增量，取自快照total_invested
 * @param {string} date 修正生效日，为重加操作当日
 * @param {string|null} at 审计时间戳
 * @returns {Object|null} 留痕记录；无日志、同本金重加、重复提交、入参非法场景均返回null
 */
export function reAddCorrection(daily, corrections, code, nextInvested, date, at = null) {
  const rows = (Array.isArray(daily) ? daily : []).filter(
    (r) => r && r.code === code && r.date && r.invested != null,
  );
  if (rows.length === 0) return null;
  const last = rows
    .sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        String(a.navDate ?? '').localeCompare(String(b.navDate ?? '')),
    )
    .pop();
  const from = round2(last.invested);
  const to = round2(nextInvested);
  const isDup = (Array.isArray(corrections) ? corrections : []).some(
    (c) =>
      c &&
      c.code === code &&
      String(c.date) === String(date) &&
      round2(c.from) === from &&
      round2(c.to) === to,
  );
  if (isDup) return null;
  return principalCorrection({ code, prevInvested: last.invested, nextInvested, date, at });
}

/**
 * 删除一笔交易将失去解释的历史跳变（删除自动留痕用）。
 * 删除前后各跑一次 auditPrincipalJumps，对比该代码"未留痕"集合的增量：
 * 删除前后都未留痕的跳变非本次删除造成，不返回。
 * 纯函数无副作用，承诺不抛出异常；入参不可变。
 */
export function jumpsLostByTxRemoval(daily, corrections, assets, code, txIndex) {
  const fund = (Array.isArray(assets) ? assets : []).find((a) => a && a.code === code);
  if (!fund || !Array.isArray(fund.transactions)) return [];
  if (txIndex == null || txIndex < 0 || txIndex >= fund.transactions.length) return [];
  const key = (j) => `${j.date}|${round2(j.from)}|${round2(j.to)}`;
  const beforeKeys = new Set(
    auditPrincipalJumps(daily, corrections, assets)
      .unexplained.filter((j) => j.code === code)
      .map(key),
  );
  const reduced = (Array.isArray(assets) ? assets : []).map((a) =>
    a && a.code === code
      ? { ...a, transactions: a.transactions.filter((_, i) => i !== txIndex) }
      : a,
  );
  return auditPrincipalJumps(daily, corrections, reduced)
    .unexplained.filter((j) => j.code === code && !beforeKeys.has(key(j)))
    .map(({ date, from, to }) => ({ date, from, to }));
}

/**
 * 删除一笔交易的自动留痕（口径Ⅰ；deleteTx 落库前调用）：
 * ① 失解释的历史跳变 → 记 {date: 跳变日, from, to}，即时认领标注；
 * ② 本金回落/抬升 → 删除改变生效本金且与日志末行不等时记 {date: 当日, from: 末行, to: 删除后生效本金}
 *    （待体现形态，下次入账写入新本金时认领；删现金分红等本金不变场景不记）。
 * 幂等：同 code+生效日+前后本金已存在即跳过（与补录工具、reAddCorrection 同口径）。
 * 纯函数无副作用，承诺不抛出异常；date/at 由调用方注入。
 * @returns {Array} 待追加的修正记录，可能为空数组
 */
export function correctionsForTxRemoval(
  daily,
  corrections,
  assets,
  code,
  txIndex,
  date,
  at = null,
) {
  const known = Array.isArray(corrections) ? corrections : [];
  const fund = (Array.isArray(assets) ? assets : []).find((a) => a && a.code === code);
  if (!fund || !Array.isArray(fund.transactions)) return [];
  if (txIndex == null || txIndex < 0 || txIndex >= fund.transactions.length) return [];
  const recs = jumpsLostByTxRemoval(daily, known, assets, code, txIndex).map((j) => ({
    code,
    field: 'total_invested',
    date: String(j.date),
    from: round2(j.from),
    to: round2(j.to),
    at,
  }));
  const rows = (Array.isArray(daily) ? daily : []).filter(
    (r) => r && r.code === code && r.date && r.invested != null,
  );
  const tail =
    rows.length > 0
      ? rows
          .slice()
          .sort(
            (a, b) =>
              String(a.date).localeCompare(String(b.date)) ||
              String(a.navDate ?? '').localeCompare(String(b.navDate ?? '')),
          )
          .pop()
      : null;
  const remaining = fund.transactions.filter((_, i) => i !== txIndex);
  const effectiveAfter = round2(computeState(fund.snapshot, remaining).totalInvested);
  if (tail && round2(tail.invested) !== effectiveAfter) {
    recs.push({
      code,
      field: 'total_invested',
      date: String(date ?? ''),
      from: round2(tail.invested),
      to: effectiveAfter,
      at,
    });
  }
  return recs.filter(
    (r) =>
      !known.some(
        (c) =>
          c &&
          c.code === r.code &&
          String(c.date) === r.date &&
          round2(c.from) === r.from &&
          round2(c.to) === r.to,
      ),
  );
}

/**
 * 删除基金的封账留痕（口径Ⅰ；deleteFund 落库前调用）：
 * 该基金全部非"修正留痕"状态的跳变逐跳补修正记录——交易解释的将随交易一并删除而失解释，
 * 未留痕的本来就缺解释；已认领的跳过。删除后不再产生新入账行，无未来回落形态。
 * 纯函数无副作用，承诺不抛出异常；date/at 由调用方注入。
 * @returns {Array} 待追加的修正记录，可能为空数组
 */
export function correctionsForFundRemoval(daily, corrections, assets, code, date, at = null) {
  const known = Array.isArray(corrections) ? corrections : [];
  const recs = auditPrincipalJumps(daily, known, assets)
    .jumps.filter((j) => j.code === code && j.status !== '修正留痕')
    .map((j) => ({
      code,
      field: 'total_invested',
      date: String(j.date),
      from: round2(j.from),
      to: round2(j.to),
      at,
    }));
  return recs.filter(
    (r) =>
      !known.some(
        (c) =>
          c &&
          c.code === r.code &&
          String(c.date) === r.date &&
          round2(c.from) === r.from &&
          round2(c.to) === r.to,
      ),
  );
}

/**
 * 悬空待体现修正的重锚（口径Ⅰ；submitTrade 落库前调用）：
 * 待体现修正的 to 与当前生效本金不等时永远无法被日志认领（悬空），"待体现"橙标将永久驻留
 * （典型：删除交易后按修正后的金额重录）。此时追加一条 to = 当前生效本金的锚记录，
 * 下次入账认领后按"被覆盖"规则使悬空记录退出。无悬空记录返回 null（常规录交易零动作）。
 * 纯函数无副作用，承诺不抛出异常；date/at 由调用方注入。
 */
export function pendingAnchorCorrection(
  daily,
  corrections,
  code,
  currentEffective,
  date,
  at = null,
) {
  const known = Array.isArray(corrections) ? corrections : [];
  const doomed = pendingCorrections(daily, known).filter(
    (p) => p.code === code && round2(p.to) !== round2(currentEffective),
  );
  if (doomed.length === 0) return null;
  const rows = (Array.isArray(daily) ? daily : []).filter(
    (r) => r && r.code === code && r.date && r.invested != null,
  );
  const tail =
    rows.length > 0
      ? rows
          .slice()
          .sort(
            (a, b) =>
              String(a.date).localeCompare(String(b.date)) ||
              String(a.navDate ?? '').localeCompare(String(b.navDate ?? '')),
          )
          .pop()
      : null;
  return {
    code,
    field: 'total_invested',
    date: String(date ?? ''),
    from: tail ? round2(tail.invested) : null,
    to: round2(currentEffective),
    at,
  };
}

/**
 * 本金修正对齐（口径Ⅰ：历史到账日志不可变，修正只留痕）。
 * 将编辑本金产生的修正记录映射到到账日志中首次体现新本金的日期。
 * 修正生效日可能是周末/无净值日，当日无日志；直接用修正日打标会匹配空记录。
 *
 * corrections: [{code, date, from, to}]，date=用户保存的修正生效日；to=修正后本金。
 * 返回 { [date]: [{code, from, to}] }，同一天多基金修正聚合到数组。
 *
 * 匹配准则：基金本行 invested 较上一行发生变动，变动后值等于未消费修正的 to，
 * 且修正date ≤ 本行date，匹配成功并一次性消费修正；避免买卖交易带来的变动被误标为本金修正。
 */
export function resolveCorrections(daily, corrections = []) {
  const log = (Array.isArray(daily) ? daily : []).filter((r) => r && r.code && r.date);
  const queueByFund = new Map();
  for (const c of Array.isArray(corrections) ? corrections : []) {
    if (!c || !c.code || !Number.isFinite(Number(c.to))) continue;
    if (!queueByFund.has(c.code)) queueByFund.set(c.code, []);
    queueByFund.get(c.code).push({
      date: String(c.date ?? ''),
      from: c.from == null ? null : round2(Number(c.from)),
      to: round2(Number(c.to)),
    });
  }
  for (const q of queueByFund.values()) q.sort((a, b) => a.date.localeCompare(b.date));

  const byFund = new Map();
  for (const r of log) {
    if (!byFund.has(r.code)) byFund.set(r.code, []);
    byFund.get(r.code).push(r);
  }
  const out = {};
  for (const [code, list] of byFund) {
    const queue = queueByFund.get(code);
    if (!queue || queue.length === 0) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    let prev = null;
    for (const r of list) {
      const cur = round2(Number(r.invested) || 0);
      if (prev != null && cur !== prev) {
        const idx = queue.findIndex((c) => c.to === cur && c.date <= r.date);
        if (idx >= 0) {
          const [hit] = queue.splice(idx, 1);
          if (!out[r.date]) out[r.date] = [];
          out[r.date].push({ code, from: hit.from, to: hit.to });
        }
      }
      prev = cur;
    }
  }
  return out;
}

/**
 * 逐基金到账日志 → 按日盈亏表 { date: {profit, hasTx, correction} }（到账口径）。
 * profit = Σ 到账日为当天的逐基金 earnings；
 * hasTx = 组合本金（逐基金 invested 前向填充）较前一日变化（当日含买入/卖出/本金修正）；
 * correction = 当日本金修正明细 [{code, from, to}] 或 null——resolveCorrections 对齐后的留痕出口（口径 Ⅰ）。
 */
export function buildProfitByDate(daily, corrections = []) {
  const log = (Array.isArray(daily) ? daily : []).filter((r) => r && r.code && r.date);
  const byDate = {};
  for (const r of log) {
    if (!byDate[r.date]) byDate[r.date] = { profit: 0, hasTx: false, correction: null };
    byDate[r.date].profit = round2(byDate[r.date].profit + (Number(r.earnings) || 0));
  }
  // hasTx：任一基金当天的入账记录里，本金较该基金上一笔记录发生变化（买入/卖出/本金修正）。
  // 按基金自身的前后记录比较，新基金首笔记录不触发（避免"首笔出现"被误判为本金变动）。
  const byFund = new Map();
  for (const r of log) {
    if (!byFund.has(r.code)) byFund.set(r.code, []);
    byFund.get(r.code).push(r);
  }
  for (const list of byFund.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let prev = null;
    for (const r of list) {
      if (prev && round2(Number(r.invested) || 0) !== round2(Number(prev.invested) || 0)) {
        byDate[r.date].hasTx = true;
      }
      prev = r;
    }
  }
  const resolved = resolveCorrections(daily, corrections);
  for (const [date, items] of Object.entries(resolved)) {
    if (byDate[date]) byDate[date].correction = items;
  }
  return byDate;
}

/**
 * 逐基金到账日志 → 组合级日序列（前向填充）：资产/收益曲线用。
 * 返回 [{date, total_assets, total_invested, total_profit}]，按日期升序。
 * dateKey：'date'（到账日，默认，现网行为不变）| 'navDate'（净值日，走势图用）。
 * 三处同轴必须同 key：轴集合、逐基金排序、扫描比较；
 * 脏数据缺 navDate 时该行回退到账日（r[dateKey] || r.date）。
 */
export function aggregateDaily(daily, { dateKey = 'date' } = {}) {
  const log = (Array.isArray(daily) ? daily : []).filter((r) => r && r.code && r.date);
  const keyOf = (r) => String(r[dateKey] || r.date);
  const byFund = new Map();
  const dates = new Set();
  for (const r of log) {
    if (!byFund.has(r.code)) byFund.set(r.code, []);
    byFund.get(r.code).push(r);
    dates.add(keyOf(r));
  }
  const series = [];
  for (const d of [...dates].sort()) {
    let assets = 0;
    let invested = 0;
    let hasAny = false;
    for (const list of byFund.values()) {
      list.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
      let rec = null;
      for (const r of list) {
        if (keyOf(r) <= d) rec = r;
        else break;
      }
      if (!rec) continue;
      hasAny = true;
      assets += Number(rec.assets) || 0;
      invested += Number(rec.invested) || 0;
    }
    if (!hasAny) continue;
    series.push({
      date: d,
      total_assets: round2(assets),
      total_invested: round2(invested),
      total_profit: round2(assets - invested),
    });
  }
  return series;
}

/** 求和已知日期的盈亏；count = 已知天数（0 时 UI 显示"—"） */
export function sumKnownProfits(byDate, dates) {
  let sum = 0;
  let count = 0;
  for (const d of dates) {
    const rec = byDate[d];
    if (rec && rec.profit != null) {
      sum += rec.profit;
      count++;
    }
  }
  return { sum: round2(sum), count };
}

/** 月视图格子（周一列首，前置空位补 blank；today/selected 打标；附月收益和） */
export function buildMonthCells(byDate, { year, month, today = null, selected = null }) {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysIn = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ blank: true });
  for (let d = 1; d <= daysIn; d++) {
    const date = isoDate(new Date(year, month, d));
    const rec = byDate[date];
    const amount = rec?.profit ?? null;
    cells.push({
      blank: false,
      date,
      day: d,
      amount,
      hasTx: !!rec?.hasTx,
      correction: rec?.correction ?? null,
      level: amount != null ? profitLevel(amount) : 0,
      isToday: date === today,
      isSelected: date === selected,
    });
  }
  return {
    cells,
    sum: sumKnownProfits(
      byDate,
      cells.filter((c) => !c.blank).map((c) => c.date),
    ),
  };
}

/** 周视图：anchor 所在周（周一起 7 天），附周标签 / 最大金额 / 周收益和 */
export function buildWeekCells(byDate, { anchor, today = null }) {
  const mon = startOfWeek(anchor);
  const WEEKDAYS = '一二三四五六日';
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const date = isoDate(d);
    const rec = byDate[date];
    const amount = rec?.profit ?? null;
    cells.push({
      date,
      day: d.getDate(),
      weekday: WEEKDAYS[i],
      amount,
      hasTx: !!rec?.hasTx,
      correction: rec?.correction ?? null,
      level: amount != null ? profitLevel(amount) : 0,
      isToday: date === today,
    });
  }
  return {
    cells,
    label: `${isoDate(mon).slice(5)} ~ ${isoDate(addDays(mon, 6)).slice(5)}`,
    maxAbs: cells.reduce((m, c) => (c.amount != null ? Math.max(m, Math.abs(c.amount)) : m), 0),
    sum: sumKnownProfits(
      byDate,
      cells.map((c) => c.date),
    ),
  };
}

/** 年视图：12 个月迷你热力格 + 各月与全年求和 */
export function buildYearBlocks(byDate, { year }) {
  const blocks = [];
  for (let m = 0; m < 12; m++) {
    const lead = (new Date(year, m, 1).getDay() + 6) % 7;
    const daysIn = new Date(year, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push({ blank: true });
    for (let d = 1; d <= daysIn; d++) {
      const date = isoDate(new Date(year, m, d));
      const rec = byDate[date];
      const amount = rec?.profit ?? null;
      cells.push({
        blank: false,
        date,
        day: d,
        amount,
        level: amount != null ? profitLevel(amount) : 0,
      });
    }
    blocks.push({
      month: m + 1,
      cells,
      sum: sumKnownProfits(
        byDate,
        cells.filter((c) => !c.blank).map((c) => c.date),
      ),
    });
  }
  const allDates = blocks.flatMap((b) => b.cells.filter((c) => !c.blank).map((c) => c.date));
  return { blocks, sum: sumKnownProfits(byDate, allDates) };
}

/**
 * 日视图单基金明细：直接读逐基金到账日志中"到账日 = 选中日"的记录，
 * 与日历格子（同一日志按日求和）天然一致。历史明细随日志保留，任意日期可回看。
 * daily：到账日志；fundStates：基金名映射（code → name）；返回 [{name, profit, navDate}]。
 */
export function dayDetailRows(daily, fundStates, date) {
  const nameByCode = new Map((fundStates || []).map((f) => [f.code, f.name]));
  const rows = [];
  for (const r of Array.isArray(daily) ? daily : []) {
    if (!r || r.date !== date || !r.code) continue;
    rows.push({
      name: nameByCode.get(r.code) ?? r.code,
      profit: Number(r.earnings) || 0,
      navDate: r.navDate ?? null,
    });
  }
  return rows;
}

/**
 * 单基金每日持有收益序列（按日回放）。
 * 口径与主表 computeState 同源：快照为基线，交易按日期升序叠加（applyBuy/applySell/applyDividend）。
 *
 * 每日 profit = round2(round2(份额 × 净值) − 累计投入)，双层舍入防止多笔卖出累积浮点尾差。
 * 日期比较前统一 slice(0,10) 归一；契约本无时间，防御手录/迁移脏数据带时间戳导致当日交易滑到次日。
 *
 * 入参不可变：navSeries/transactions 浅拷贝排序；交易消费使用索引游标，严禁 shift/splice（破坏Vue响应式引用）。
 *
 * 降级：净值序列 <2点，或全零持仓（无快照无交易）→ 返回[]；空态文案分流放在接线层。
 */
export function computeHoldingProfitSeries(snapshot, transactions, navSeries) {
  if (!Array.isArray(navSeries) || navSeries.length < 2) return [];
  const txs = Array.isArray(transactions) ? transactions : [];
  const snap = snapshot || {};
  const shares0 = Number(snap.hold_shares) || 0;
  const invested0 = Number(snap.total_invested) || 0;
  if (!(shares0 > 0) && !(invested0 > 0) && txs.length === 0) return []; // 全零持仓 → 空态

  const dayOf = (v) => String(v ?? '').slice(0, 10);
  // 入口防御：升序排序——接口降序返回/传参颠倒也不破坏状态机单向推进
  const sortedNavs = [...navSeries].sort((a, b) => dayOf(a?.date).localeCompare(dayOf(b?.date)));
  const sortedTx = [...txs].sort((a, b) => dayOf(a?.date).localeCompare(dayOf(b?.date)));

  let state = {
    totalInvested: invested0,
    holdShares: shares0,
    costPrice: Number(snap.cost_price) || 0,
  };
  let txIdx = 0;
  const out = [];
  for (const item of sortedNavs) {
    const navDay = dayOf(item?.date);
    const navVal = Number(item?.nav);
    if (!navDay || !Number.isFinite(navVal)) continue; // 缺值净值日跳过不产出点
    // 游标线性推进：date <= navDay 且未应用的交易；脏数据交易跳过但照常消费（防死循环）
    while (txIdx < sortedTx.length && dayOf(sortedTx[txIdx]?.date) <= navDay) {
      const tx = sortedTx[txIdx];
      txIdx++;
      if (
        tx.type === 'buy' &&
        Number.isFinite(Number(tx.amount)) &&
        Number.isFinite(Number(tx.shares))
      ) {
        state = applyBuy(state, { amount: Number(tx.amount), shares: Number(tx.shares) });
      } else if (tx.type === 'sell' && Number.isFinite(Number(tx.shares))) {
        state = applySell(state, { shares: Number(tx.shares) });
      } else if (
        tx.type === 'dividend' &&
        tx.method === 'reinvest' &&
        Number.isFinite(Number(tx.shares))
      ) {
        state = applyDividend(state, { method: 'reinvest', shares: Number(tx.shares) });
      }
      // 现金分红不改变状态（与主表「持有收益 = 市值 − 本金」口径一致，曲线无跳变）
    }
    const marketVal = round2(state.holdShares * navVal); // 市值先按分舍入（applyQuote 同款口径）
    out.push({ date: navDay, profit: round2(marketVal - state.totalInvested) }); // 差值再按分舍入
  }
  return out;
}
