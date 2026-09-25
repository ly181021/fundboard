/**
 * 截图识别：通用 OpenAI 兼容视觉大模型适配器。
 * 配置三要素 baseUrl / apiKey / model：
 *   优先读 ocr.config.json（改完即生效，无需重启；该文件已 gitignore，key 不入库）
 *   其次环境变量 OCR_API_BASE / OCR_API_KEY / OCR_MODEL
 * 默认适配阿里云 DashScope 兼容模式（qwen-vl 系列）；任何 OpenAI 兼容视觉接口换三个字段即可。
 * 服务端不落截图：请求转发后即弃；key 只存服务端，前端永不接触。
 */
import { readFile } from 'node:fs/promises';

export const OCR_EXTRACT_PROMPT = `你是基金理财截图识别助手。先判断截图类型，再提取信息，严格只输出 JSON（无其它文字、无 markdown 代码块）。

若是【交易记录/成交记录】页（含买入/卖出/成交等字样），输出：
{"kind":"trades","trades":[{"code":"6位基金代码","name":"基金名称","type":"buy|sell|dividend","amount":数字或null,"shares":数字或null,"date":"YYYY-MM-DD","method":"cash|reinvest"}],"snapshot":null}
规则：买入/申购=buy 填 amount+shares；卖出/赎回=sell 只填 shares；分红=dividend 填 amount，红利再投 method="reinvest" 且 shares 填再投份额，现金分红 method="cash"；date 取成交/确认日期。
重要：若图片是交易列表被切开后的【中间片段】（没有页面标题，只有一行行记录），不要因此判 none——直接按表格行提取每一行可见记录，行首的类型文字即类型。
基金转换：转换(转入)=buy（钱进入本基金），转换(转出)=sell（钱离开本基金）；截图没有份额列时 shares 填 null，不要编造。
date 只取 YYYY-MM-DD 日期部分，忽略时分秒。

若是【分红记录/分红明细/红利到账】页（含 每份分红、每10份派发、分红方式、权益登记日、除息日、现金红利 等字样），同样输出 kind:"trades"：
{"kind":"trades","trades":[{"code":"6位基金代码","name":"基金名称","type":"dividend","amount":数字或null,"shares":数字或null,"date":"YYYY-MM-DD","method":"cash|reinvest"}],"snapshot":null}
规则：分红方式为现金分红 → method="cash"，amount 填现金红利实发金额；红利再投 → method="reinvest"，shares 填红利再投份额（页面只给每份分红金额时 shares 填 null）；date 取发放/确认日期；页面含多笔分红时全部列入。

若是【资产详情/持仓】页（含 持有金额、持仓成本价、持有份额 等字样，无成交记录），输出：
{"kind":"snapshot","trades":[],"snapshot":{"code":"6位基金代码","name":"基金名称","hold_amount":持有金额,"cost_price":持仓成本价,"hold_shares":持有份额,"nav":基金净值}}

两者都不是（如收益走势页、其它页面），输出 {"kind":"none","trades":[],"snapshot":null}。

所有缺失字段填 null，不要编造；交易页含多笔时全部列入 trades。`;

const TYPE_ALIAS = {
  buy: 'buy',
  买入: 'buy',
  申购: 'buy',
  转入: 'buy',
  转换转入: 'buy',
  sell: 'sell',
  卖出: 'sell',
  赎回: 'sell',
  转出: 'sell',
  转换转出: 'sell',
  dividend: 'dividend',
  分红: 'dividend',
};

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const dateOrNull = (v) => {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/); // 容忍模型偶尔输出的时分秒
  return m ? m[1] : null;
};

const normType = (v) => {
  const norm = String(v ?? '')
    .replace(/[()（）]/g, '')
    .trim()
    .toLowerCase(); // 兼容「转换(转入)」等带括号写法
  return TYPE_ALIAS[norm] ?? null;
};

/** 交易指纹（与 js/calculator.js 的 findDuplicateTrade 同口径）：type+date+amount+shares+method 全等 */
export function dedupeTrades(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const k = JSON.stringify([
      t?.type ?? null,
      t?.date ?? null,
      t?.amount ?? null,
      t?.shares ?? null,
      t?.method ?? null,
    ]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * 从模型返回文本中提取并规范化 trades / snapshot（校验闸：代码必须 6 位、类型必须合法）。
 * 无法解析时返回 { trades: [], snapshot: null }，不抛错。
 */
export function parseOcrResponse(text) {
  if (typeof text !== 'string') return { trades: [], snapshot: null };
  let t = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return { trades: [], snapshot: null };
  let json;
  try {
    json = JSON.parse(t.slice(start, end + 1));
  } catch {
    return { trades: [], snapshot: null };
  }
  const list = Array.isArray(json?.trades) ? json.trades : [];
  const trades = [];
  for (const r of list) {
    const rawCode = String(r?.code ?? '').replace(/\D/g, '');
    const type = normType(r?.type);
    if (!type) continue;
    // 长截图中间片段没有页头，模型会返回 code:null——保留（由前端用其他块识别到的代码补齐）；
    // 只有 code 字段存在但不是 6 位数字时才视为垃圾丢弃
    const code = /^\d{6}$/.test(rawCode) ? rawCode : null;
    if (code === null && r?.code != null && String(r.code).trim() !== '') continue;
    trades.push({
      code,
      name: String(r?.name ?? '') || null,
      type,
      amount: numOrNull(r?.amount),
      shares: numOrNull(r?.shares),
      date: dateOrNull(r?.date),
      // method 仅对分红有意义；模型常给买入/卖出乱填 cash，统一置 null 保证跨块判重指纹稳定
      method:
        type === 'dividend'
          ? r?.method === 'reinvest'
            ? 'reinvest'
            : r?.method === 'cash'
              ? 'cash'
              : null
          : null,
    });
  }
  // 卫生规则：金额与份额全空的噪声条目丢弃；同指纹（含长截图相邻分块重叠）去重
  return {
    trades: dedupeTrades(trades).filter((t) => t.amount != null || t.shares != null),
    snapshot: normalizeSnapshot(json?.snapshot),
  };
}

/** 资产详情页识别结果（快照预填用） */
function normalizeSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  const code = String(s.code ?? '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  return {
    code,
    name: String(s.name ?? '') || null,
    hold_amount: numOrNull(s.hold_amount),
    cost_price: numOrNull(s.cost_price),
    hold_shares: numOrNull(s.hold_shares),
    nav: numOrNull(s.nav),
  };
}

/** apiKey 必须是可打印 ASCII（占位符/中文会进 Authorization 头，fetch 会报晦涩的 ByteString 错，提前拦下） */
const printableAscii = (v) => typeof v === 'string' && /^[\x21-\x7e]+$/.test(v);

/** 读取识别配置：ocr.config.json 优先（apiKey 等三要素齐全才有效），环境变量兜底；均无返回 null */
/** 三要素是否齐全可用（baseUrl/model 非空 + apiKey 为可打印 ASCII，避免晦涩的 ByteString 报错） */
function isValidTriple(o) {
  return !!(o?.baseUrl && o?.model && printableAscii(o?.apiKey));
}
function normalizeTriple(o) {
  return {
    baseUrl: String(o.baseUrl).replace(/\/+$/, ''),
    apiKey: String(o.apiKey),
    model: String(o.model),
  };
}

/**
 * 读取模型配置。
 * 顶层 baseUrl/apiKey/model 为默认；配置文件可另加可选的 analysis 段单独指定 AI 解读的三要素
 * （可只覆盖部分字段，其余回落顶层）；合并后仍须是合法三要素，否则整段忽略。
 * analysis 为 null 表示「AI 解读与截图识别同模型」（默认，向后兼容）。
 * 返回 { baseUrl, apiKey, model, analysis: {baseUrl,apiKey,model}|null }；完全未配置返回 null。
 * @param {object} opts { configPath, env }
 * @returns {Promise<object|null>} 配置或 null
 */
export async function loadOcrConfig({ configPath, env = process.env } = {}) {
  let fileRaw = null;
  try {
    fileRaw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    /* 无配置文件或坏 JSON，走环境变量 */
  }

  let primary = null;
  if (isValidTriple(fileRaw)) primary = normalizeTriple(fileRaw);
  else if (env.OCR_API_BASE && env.OCR_MODEL && printableAscii(env.OCR_API_KEY)) {
    primary = normalizeTriple({
      baseUrl: env.OCR_API_BASE,
      apiKey: env.OCR_API_KEY,
      model: env.OCR_MODEL,
    });
  }
  if (!primary) return null;

  // analysis 段：逐字段回落顶层；任一段缺失/非法则整段忽略（静默降级为「同模型」）
  const ov =
    fileRaw && typeof fileRaw.analysis === 'object' && fileRaw.analysis !== null
      ? fileRaw.analysis
      : null;
  let analysis = null;
  if (ov) {
    const merged = {
      baseUrl: ov.baseUrl ?? primary.baseUrl,
      apiKey: ov.apiKey ?? primary.apiKey,
      model: ov.model ?? primary.model,
    };
    if (isValidTriple(merged)) analysis = normalizeTriple(merged);
  }
  return { ...primary, analysis };
}

export function createOcrClient({ fetchFn = fetch, config }) {
  if (!config) throw new Error('ocr_not_configured');
  const { baseUrl, apiKey, model } = config;
  return {
    /** dataUrl: data:image/...;base64,xxx → { trades }；HTTP/网络失败抛错（由路由转 502） */
    async extract(dataUrl) {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: OCR_EXTRACT_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`视觉模型 HTTP ${res.status}`);
      const payload = await res.json();
      const content = payload?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : content;
      return parseOcrResponse(typeof text === 'string' ? text : '');
    },
  };
}

// ---- AI 今日解读（/api/analysis）：复用同一模型配置，纯文本交互 ----

export const AI_INTERPRET_PROMPT = `你是个人基金看板的解读助手。下面 JSON 是今天的持仓与行情数据（null 表示该字段暂无数据，不要编造）。
任务：写一段今天的个性化解读。规则报告已展示涨跌统计与归因排名，不要复述这些数字，只做增量解读：
1. 指出组合层面的关键信号（如：单日波动是否异常（看 dailyReturnPct）、盈亏是否集中在一两只基金（看 attribution 顺序与 concentration）、持有收益率与年化 XIRR 背离大时说明资金进出时点影响大）
2. 给一条带基金名和数值的风险提示（优先引用 strategy 汇总——"N 只持仓触发策略建议"及其中止盈/止损/清空/补仓的分布，结合集中度；weightPct 很小（如不足 1%）的持仓弱化预警语气，可能是试仓或预估本金）
3. 给一条贴合当前持仓的中性建议（可执行：如部分止盈、再平衡、补全交易记录；不荐股、不预测涨跌、不用夸张语气）
约束：不超过 180 字；直接输出正文，不要标题、不要 markdown、不要客套；所有数值必须来自数据。
重要：为保护隐私，本数据刻意不含任何绝对金额（金额位置显示为 •••）。禁止编造、推算或提及任何金额数字；需要描述规模时只用比例、占比（weightPct）、涨跌幅或只数。`;

export function buildAnalysisMessages(context) {
  return [
    {
      role: 'user',
      content: `${AI_INTERPRET_PROMPT}\n\n数据：\n${JSON.stringify(context)}`,
    },
  ];
}

/** AI 解读请求超时（毫秒，兜底）：网关或网络挂住时不至于让页面无限等待；可用环境变量 ANALYSIS_TIMEOUT_MS 覆盖 */
export const ANALYSIS_TIMEOUT_MS = 60000;

export function createAnalysisClient({ fetchFn = fetch, config, timeoutMs = ANALYSIS_TIMEOUT_MS }) {
  if (!config) throw new Error('ocr_not_configured');
  const { baseUrl, apiKey, model } = config;
  return {
    /** context: 结构化分析数据 → { text }；HTTP/网络失败/超时抛错（由路由转 502） */
    async interpret(context) {
      // 超时兜底：不用裸 fetch（网关不返回会一直挂着）；超时后转 524。
      // 用 AbortController 主动掐断并给出可读原因；真实 fetch 会因 signal 中止而 reject。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          // enable_thinking:false 关推理模型思考区：deepseek 系网关渠道默认烧 reasoning_tokens
          // （实测 800 预算全进思考区、正文为空，10~15s 撞网关 15s 窗口 → 524）；关掉后 2~4s 出全文。
          // 非推理模型忽略该参数，不影响其他网关。
          body: JSON.stringify({
            model,
            messages: buildAnalysisMessages(context),
            enable_thinking: false,
          }),
          signal: ac.signal,
        });
      } catch (e) {
        if (ac.signal.aborted)
          throw new Error(
            `模型响应超时（${Math.round(timeoutMs / 1000)} 秒未返回，可稍后重试或换模型）`,
          );
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // 524 = 网关侧「源站超时」（上游模型没在网关窗口内返回，实测该网关约 15s 就快失败）：
        // 与一般 HTTP 错误区分开，直接给出可操作建议，避免只看到一句裸状态码。
        const hint =
          res.status === 524
            ? '（上游网关超时：该模型对当前提示词生成过慢，可稍后重试或在 ocr.config.json 的 analysis 段换更快的模型）'
            : '';
        throw new Error(`模型 HTTP ${res.status}${hint}`);
      }
      const payload = await res.json();
      const content = payload?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : content;
      return { text: (typeof text === 'string' ? text : '').trim() };
    },
  };
}
