/**
 * 行情解析与字段映射纯函数（服务端）。
 * 职责：JSONP 解析、涨跌幅计算、组装 /api/quote 的单条 quote 结构。
 * 零副作用、零依赖，可被 node:test 直接测试。
 */
import { marketOfIndex, INDEX_SESSIONS } from '../js/marketClock.js'; // 市场映射与分段单一来源（同构模块；分段常量在本文件末尾再导出）

/**
 * 解析天天基金 fundgz JSONP 文本（jsonpgz({...});）。
 * 空响应、404 页面 HTML 等非法内容返回 null（fundgz 已下线，接口可能返回 HTML 404 页且 HTTP 仍 200）。
 * @param {string} text 响应文本
 * @returns {object|null} 解析出的对象或 null
 */
export function parseFundgz(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('jsonpgz(');
  if (start === -1) return null;
  const open = text.indexOf('(', start);
  const close = text.lastIndexOf(')');
  if (close <= open + 1) return null;
  try {
    const obj = JSON.parse(text.slice(open + 1, close));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** 估值输入统一形状：{nav, change_pct, time}（与 buildQuote 的 estimate 字段同口径，时间 YYYY-MM-DD HH:mm[:ss]） */
const toEstimate = (nav, changePct, time) => {
  const n = num(nav);
  const pct = num(changePct);
  if (n == null && pct == null) return null;
  return { nav: n, change_pct: pct, time: time ?? null };
};

/**
 * 解析天天基金新版批量估值接口（FundValuationLast，替代已下线的 fundgz JSONP）。
 * 入参为接口响应 JSON 对象；返回：
 * @property {Object<string, {nav: number, change_pct: number, time: string}>} estimates - code → estimate（{nav, change_pct, time}）
 * @property {Array<string>} noEstimateCodes - 名称含 QDII 且无估值的代码集合——QDII 基金不走新浪兜底
 *   （新浪对 QDII 的估值是自算且滞后失真）；国内基金无估值（如中欧系）仍走新浪兜底。
 *   响应整体非法时两者皆为空。
 */
export function parseValuationLast(payload) {
  const estimates = {};
  const noEstimateCodes = [];
  if (!payload || payload.success !== true || !Array.isArray(payload.data)) {
    return { estimates, noEstimateCodes };
  }
  for (const item of payload.data) {
    const code = item?.FCODE != null ? String(item.FCODE).trim() : '';
    if (!code) continue;
    const est = toEstimate(item.GSZ, item.GSZZL, item.GZTIME ?? null);
    if (est) {
      estimates[code] = est;
    } else if (
      (item.GSZ === null || item.GSZ === undefined || item.GSZ === '') &&
      /QDII/i.test(String(item.SHORTNAME ?? ''))
    ) {
      noEstimateCodes.push(code); // QDII：在场但无估值
    }
  }
  return { estimates, noEstimateCodes };
}

/**
 * 解析新浪估算曲线接口（FdFundService.getEstimateNetworthPic，无 callback 时为纯 JSON）。
 * 取曲线末点：口径 2 用 pre_nav/growthrate，口径 3 用 pre_nav2/growthrate2（growthrate 为小数比例）。
 * 返回 {nav, change_pct, time} 或 null（结构非法/末点无效）。
 */
export function parseSinaEstimate(payload, variant = 2) {
  const data = payload?.result?.data;
  const nw = data?.networth;
  if (!Array.isArray(nw) || nw.length === 0) return null;
  const last = nw[nw.length - 1];
  if (!last || typeof last !== 'object') return null;
  const nav = variant === 3 ? last.pre_nav2 : last.pre_nav;
  const rate = variant === 3 ? last.growthrate2 : last.growthrate;
  const time =
    last.pre_date && last.min_time
      ? `${last.pre_date} ${String(last.min_time).padStart(8, '0')}`
      : null;
  const pct = rate != null ? num(rate) * 100 : null;
  return toEstimate(nav, pct, time);
}

/**
 * 解析新浪估算曲线（同接口 getEstimateNetworthPic）为当天分时序列（实时估值盘「当天估值走势」用）。
 * 四条硬规则：
 * 规则 0（只保留当天）：点的 `pre_date` 必须 === `today`（YYYY-MM-DD）；缺 `pre_date` 的点一律丢弃
 *    （fail-visible：宁可空态，也不把上一交易日/周末的曲线当今天画）。被丢弃的"非当天"点计入 `droppedOtherDay`。
 * 规则 1（只用口径2）：`pre_nav` / `nav_pct`（后者是源已归整的百分数字符串，优先直取，避开 `growthrate × 100` 的浮点尾差）；
 *    `pre_nav2` / `growthrate2` 一律不读（口径3 末点有断裂脏值，且 `growthrate2` 是字符串）。
 * 规则 2（只保留交易时段内的点）：`t ∈ [09:30, 11:30] ∪ [13:00, 15:00]`（闭区间），源会多给收盘后的尾巴 tick。
 * 规则 3（丢弃无效点）：`nav`、`change_pct` 任一为 null/NaN 即丢（残缺点进入 `pnl = shares × (nav − worth)` 会被
 *    JS 隐式转换放大成"全仓归零"级假值，null 当 0 用）。
 *
 * @param {object} payload 新浪响应 JSON（已 JSON.parse）
 * @param {string} today 北京时间当日 `YYYY-MM-DD`（调用方注入；本函数不取系统时间，保持纯函数）
 * @returns {{ points: Array<{t: string, nav: number, change_pct: number}>, worth: number|null,
 *             worthDate: string|null, range: Array<[string, string]>|null, droppedOtherDay: boolean }}
 */
export function parseSinaCurve(payload, today) {
  const empty = { points: [], worth: null, worthDate: null, range: null, droppedOtherDay: false };
  const data = payload?.result?.data;
  const nw = data?.networth;
  if (!Array.isArray(nw)) return empty;

  const byTime = new Map(); // 同 t 去重（后者覆盖），顺带保证升序输出
  let droppedOtherDay = false;
  for (const p of nw) {
    if (!p || typeof p !== 'object') continue;
    const date = typeof p.pre_date === 'string' ? p.pre_date : '';
    if (date !== today) {
      if (date) droppedOtherDay = true;
      continue;
    } // 规则 0
    const t = String(p.min_time ?? '').slice(0, 5);
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m) continue;
    const min = Number(m[1]) * 60 + Number(m[2]);
    if (!((min >= 570 && min <= 690) || (min >= 780 && min <= 900))) continue; // 规则 2
    const nav = num(p.pre_nav);
    const rawRate =
      num(p.nav_pct) ??
      (num(p.growthrate) != null ? Number((num(p.growthrate) * 100).toFixed(4)) : null);
    if (nav == null || rawRate == null) continue; // 规则 3（规则 1：只读口径2 字段）
    byTime.set(t, { t, nav, change_pct: rawRate });
  }
  const points = [...byTime.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const wd = String(data?.worth_date ?? '');
  return {
    points,
    worth: num(data?.worth),
    worthDate: /^\d{8}$/.test(wd) ? `${wd.slice(0, 4)}-${wd.slice(4, 6)}-${wd.slice(6, 8)}` : null,
    range: Array.isArray(data?.time_range) ? data.time_range : null,
    droppedOtherDay,
  };
}

/**
 * 大盘指数新浪备源映射表（push2 被限流时降级）。
 * 顺序与 push2 secids 一致（A 股 6 + 海外 5，NDX 在前 HSI 在尾），保证降级时卡片位置不变。
 * @property {string} code - 与 push2 f12 同值（前端 marketClock.marketOfIndex 按此映射开市状态，备源必须返回相同 code）
 * @property {string} name - 标准名（覆盖新浪返回名，避免降级时卡片名称跳变）
 * @property {string} varName - 新浪 hq 变量名（`hq_str_<varName>="..."`）；美股含 `$` 须原样、不可 URL 编码（%24 返回空）
 * @property {'a'|'us'|'hk'} fmt - 字段格式：'a' A 股全量（点位 idx3、昨收 idx2、日期 idx30 + 时间 idx31）；
 *   'us' 美股 gb_（点位 idx1、涨跌幅 idx2、日期时间 idx3）；'hk' 港股 int_（点位 idx1、涨跌幅 idx3、无时间）。
 */
export const SINA_INDEX_SPECS = [
  { code: '000300', name: '沪深300', varName: 'sh000300', fmt: 'a' },
  { code: '000905', name: '中证500', varName: 'sh000905', fmt: 'a' },
  { code: '000001', name: '上证指数', varName: 'sh000001', fmt: 'a' },
  { code: '399001', name: '深证成指', varName: 'sz399001', fmt: 'a' },
  { code: '399006', name: '创业板指', varName: 'sz399006', fmt: 'a' },
  { code: '000688', name: '科创50', varName: 'sh000688', fmt: 'a' },
  { code: 'NDX', name: '纳斯达克100', varName: 'gb_ndx', fmt: 'us' },
  { code: 'IXIC', name: '纳斯达克综合', varName: 'gb_$ixic', fmt: 'us' },
  { code: 'SOX', name: '费城半导体', varName: 'gb_$sox', fmt: 'us' },
  { code: 'HXC', name: '纳斯达克中国金龙', varName: 'gb_$hxc', fmt: 'us' },
  { code: 'HSI', name: '恒生指数', varName: 'int_hangseng', fmt: 'hk' }, // int_ 简版四字段（名/点位/涨跌额/涨跌幅）；rt_hkHSI 字段布局不同，不可混用
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 源侧日期时间串 → Unix 秒（与 push2 f124 同为绝对 epoch，供前端 formatIndexTime）。
 * 源侧是北京墙钟（A 股 hq `f[30]`+`f[31]`、美股 `gb_` `f[3]` 均为北京时间），必须显式
 * 按 `+08:00` 解析。若按运行时时区解析，部署在非 +08:00 容器（Docker/UTC）时会整体偏移
 * （TZ=UTC 下把北京 15:00 解析成 UTC 15:00 = 北京 23:00，时间文案偏 8 小时、同日判断失效）。
 * 已带时区标记的字符串（Z / ±HH:MM）不重复追加，无效输入返回 null。
 * @param {string} dateTimeStr 源侧日期时间串
 * @returns {number|null} Unix 秒
 */
function toEpochSec(dateTimeStr) {
  if (!dateTimeStr) return null;
  const s = String(dateTimeStr).replace(' ', 'T');
  const hasTz = /[Zz]$|[+-]\d\d:?\d\d$/.test(s);
  const t = Date.parse(hasTz ? s : s + '+08:00');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * 解析新浪 hq 指数响应（GBK 已在调用方解码为字符串）→ 与 push2 同构的 [{code,name,price,change_pct,time}]。
 * 逐 spec 定位 `hq_str_<varName>="..."`；空内容/无效点位（如该只已下架）跳过，
 * 表现与 push2 坏 secid 一致（卡片少一张，不出错数据）。
 * 涨跌幅：A 股由 (点位−昨收)/昨收 补算（复用 computeChangePct），美股/港股源侧直接给。
 * @param {string} text GBK 解码后的响应文本
 * @param {Array} [specs] 映射表（默认 SINA_INDEX_SPECS）
 * @returns {Array} 指数列表
 */
export function parseSinaIndexes(text, specs = SINA_INDEX_SPECS) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const spec of specs) {
    const m = text.match(new RegExp(`hq_str_${escapeRe(spec.varName)}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split(',');
    let price = null;
    let pct = null;
    let amt = null;
    let time = null;
    if (spec.fmt === 'a') {
      price = num(f[3]);
      pct = computeChangePct(price, num(f[2])); // (点位 − 昨收) / 昨收
      const prev = num(f[2]);
      amt = price != null && prev != null ? Math.round((price - prev) * 100) / 100 : null;
      time = f[30] && f[31] ? toEpochSec(`${f[30]} ${f[31]}`) : null;
    } else if (spec.fmt === 'us') {
      price = num(f[1]);
      pct = num(f[2]);
      time = toEpochSec(f[3]);
      amt = null; // gb_ 无涨跌额字段（备源降级：胶囊只显示涨幅）
    } else {
      // hk：int_hangseng 无时间字段（f[2]=涨跌额）
      price = num(f[1]);
      pct = num(f[3]);
      amt = num(f[2]);
    }
    if (price == null) continue; // 无效点位（空内容/下架）→ 跳过该只
    out.push({ code: spec.code, name: spec.name, price, change_pct: pct, change_amt: amt, time });
  }
  return out;
}

/** 涨跌幅% = (cur − prev) ÷ prev × 100，保留 4 位小数；prev 无效或为零时返回 null。 */
export function computeChangePct(cur, prev) {
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 100 * 10000) / 10000;
}

const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 组装 /api/quote 的单条 quote。
 * navs/navDates/changePcts 均为新→旧排列；changePcts 缺省项由相邻净值差补算；
 * estimate 为源侧估值输入（{nav, changePct, time}，camelCase）或 null（QDII 等无估值品种）。
 * navs 无有效净值时返回 null。
 */
export function buildQuote({
  code,
  name,
  navs,
  navDates,
  changePcts,
  estimate,
  fetchedAt,
  source,
}) {
  const nav = num(navs?.[0]);
  if (nav == null) return null;
  const prev = num(navs[1]);
  const prev2 = num(navs[2]);
  const changePct = num(changePcts?.[0]) ?? (prev != null ? computeChangePct(nav, prev) : null);
  const prevChangePct =
    num(changePcts?.[1]) ?? (prev != null && prev2 != null ? computeChangePct(prev, prev2) : null);
  return {
    code,
    name: name ?? null,
    nav,
    nav_date: navDates?.[0] ?? null,
    prev_nav: prev,
    prev2_nav: prev2,
    change_pct: changePct,
    prev_change_pct: prevChangePct,
    estimate: estimate
      ? { nav: num(estimate.nav), change_pct: num(estimate.changePct), time: estimate.time ?? null }
      : null,
    source,
    fetched_at: fetchedAt ?? null,
  };
}

// ===== 核心指数「当天迷你分时」=====
// 缩略图只需「时间 + 相对昨收的涨跌幅」：不取 OHLC/成交额，故 fields2 固定 f51,f53。

// 各市场交易时段分段：单一来源在 js/marketClock.js（前端渲染与服务端解析共用同一份）
export { INDEX_SESSIONS } from '../js/marketClock.js';

/** 迷你图点数上限（卡片宽 ~120–168px、图高 34px → 约 2.5–3.5px 一点） */
export const SPARK_MAX_POINTS = 48;

/**
 * 指数代码 → 市场（白名单：只认 SINA_INDEX_SPECS 登记的 11 只；未登记返回 null）。
 * 市场映射复用 marketClock.marketOfIndex（单一来源），此处只做"在白名单内"的校验。
 * @param {string} code 指数代码
 * @returns {string|null} 'cn' | 'hk' | 'us' | null
 */
export function sparkMarketOf(code) {
  if (!SINA_INDEX_SPECS.some((x) => x.code === code)) return null;
  return marketOfIndex(code);
}

const hmMin = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const inSegments = (t, segments) =>
  segments.some(([a, b]) => hmMin(t) >= hmMin(a) && hmMin(t) <= hmMin(b));
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * JSONP 剥取（切片实现，不用正则）。
 * 上游返 502 HTML / `var t=(null)` / 截断响应时，`raw.match(...)` 会返 null，直取 `[1]` 抛 TypeError，
 * 会把路由打挂 → 本函数永不抛：异常/非数组一律 null。
 * @param {string} raw 响应文本
 * @returns {Array|null} 剥出的数组或 null
 */
export function sliceJsonp(raw) {
  if (typeof raw !== 'string') return null;
  const k = raw.indexOf('var t=');
  const s = raw.indexOf('(', k < 0 ? 0 : k);
  const e = raw.lastIndexOf(')');
  if (s < 0 || e <= s) return null;
  try {
    const v = JSON.parse(raw.slice(s + 1, e));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 东财 push2his trends2（`fields2=f51,f53`，每项 `时间,收盘`）→ `{ preClose, rows: [[t,price]] }`。
 * 按会话段过滤：该接口会带 09:15–09:29 集合竞价、盘后尾巴与脏值（返回窗口不稳定），
 * 不过滤则开盘段形状是错的。
 * @param {object} payload 接口响应 JSON
 * @param {Array} segments 会话段 [[open, close], ...]
 * @returns {object} { preClose, rows }
 */
export function parseEmTrends(payload, segments) {
  const d = payload?.data;
  if (!d || !Array.isArray(d.trends) || d.trends.length === 0) throw new Error('东财分时无数据');
  const preClose = Number(d.preClose);
  if (!Number.isFinite(preClose) || preClose <= 0)
    throw new Error('东财分时缺昨收（fields1 需带全）');
  const rows = [];
  for (const s of d.trends) {
    const f = String(s).split(',');
    const t = f[0].slice(11, 16);
    const c = Number(f[1]);
    if (!Number.isFinite(c) || c <= 0 || !inSegments(t, segments)) continue;
    rows.push([t, c]);
  }
  if (rows.length === 0) throw new Error('东财分时无有效点');
  return { preClose, rows };
}

/**
 * 新浪美股 1 分钟线（JSONP）→ `{ preClose, sessionDate, rows }`。
 * 响应给近 3 个交易日：取最后一个美东日组为"当天"（要画的那一场），其前一组末值即为本场昨收。
 * 时间字段是美东本地时间，轴是"会话相对"的，不做时区换算。
 *
 * 昨收优先级：① 前一日分组的末值（分时数据自带、按定义就是本场昨收，且与曲线同源）；
 * ② 调用方注入的兜底 `fallbackPreClose`（仅在窗口里没有前一日时用）；③ 本场首个有效点（最后手段）。
 * 不得用"hq 现价 − 涨跌额"当首选：美股开盘前上游会把涨跌额清零，该式会算出会话自身收盘，
 * 整条曲线塌到 0 附近。
 * @param {string} raw JSONP 文本
 * @param {Array} segments 会话段
 * @param {object} [opts] { fallbackPreClose }
 * @returns {object} { preClose, sessionDate, rows }
 */
export function parseSinaUsMinutes(raw, segments, { fallbackPreClose = null } = {}) {
  const all = sliceJsonp(raw);
  if (!all || all.length === 0) throw new Error('新浪美股分时不可解析');
  const byDay = new Map();
  for (const r of all) {
    const d = String(r?.d || '');
    if (d.length < 16) continue;
    const day = d.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push([d.slice(11, 16), Number(r.c)]);
  }
  const days = [...byDay.keys()].sort();
  if (days.length === 0) throw new Error('新浪美股分时无有效点');
  const today = byDay
    .get(days[days.length - 1])
    .filter(([t, c]) => Number.isFinite(c) && inSegments(t, segments));
  if (today.length === 0) throw new Error('新浪美股分时无有效点');
  // 昨收优先级见函数头注释：① 前一日分组末值（首选）→ ② 调用方注入的兜底 → ③ 本场首个有效点。
  // 先剔非有限值再取末值：源侧末行可能是脏数据，而 `NaN ?? x` 不会回落（?? 只拦 null/undefined），
  // 会让 preClose=NaN 穿透到 thinBySegment（那里判非有限直接返 []）→ 整只误报 fetch_failed。
  const prevAll = days.length >= 2 ? byDay.get(days[days.length - 2]) : [];
  const prevFinite = prevAll.filter(([, c]) => Number.isFinite(c));
  const prevLast = prevFinite.length ? prevFinite[prevFinite.length - 1][1] : null;
  const injected = Number(fallbackPreClose);
  const fallback = byDay.get(days[days.length - 1]).find(([, c]) => Number.isFinite(c));
  const preClose = Number.isFinite(prevLast)
    ? prevLast
    : Number.isFinite(injected) && injected > 0
      ? injected
      : fallback
        ? fallback[1]
        : null;
  if (!Number.isFinite(preClose)) throw new Error('新浪美股分时无有效昨收'); // 双保险：NaN 绝不出本函数
  return { preClose, sessionDate: days[days.length - 1], rows: today };
}

/**
 * 腾讯 `appstock/app/minute/query`（A股/港股备源）→ `{ preClose, rows }`。
 * `data[code].data.data` 每项为 `"HHMM 价 量 额"`；昨收取 `qt[code][4]`。
 * @param {object} payload 接口响应 JSON
 * @param {Array} segments 会话段
 * @param {string} code 指数代码
 * @returns {object} { preClose, rows }
 */
export function parseTencentMinutes(payload, segments, code) {
  const blk = payload?.data?.[code];
  const list = blk?.data?.data;
  if (!Array.isArray(list) || list.length === 0) throw new Error('腾讯分时无数据');
  const preClose = Number(blk?.qt?.[code]?.[4]);
  if (!Number.isFinite(preClose) || preClose <= 0) throw new Error('腾讯分时缺昨收');
  const rows = [];
  for (const line of list) {
    const f = String(line).trim().split(/\s+/);
    const hm = f[0];
    if (!/^\d{4}$/.test(hm)) continue;
    const t = `${hm.slice(0, 2)}:${hm.slice(2)}`;
    const c = Number(f[1]);
    if (!Number.isFinite(c) || c <= 0 || !inSegments(t, segments)) continue;
    rows.push([t, c]);
  }
  if (rows.length === 0) throw new Error('腾讯分时无有效点');
  return { preClose, rows };
}

/**
 * 分段抽稀：预算按各段分钟数比例分配（A 股 24+24、港股 22+26），
 * 且每段保留该段实际的首末点（源侧没有 13:00 整点，A 股下午首点是 13:01；
 * 全局等距抽稀会把接缝抽成 11:27→13:03、横向错位，故"保实际首末、不假设整点"）。
 * 输出 `[[t, pct], ...]`（pct 相对昨收，归整 4 位）。
 * @param {Array} rows [[t, price]] 升序
 * @param {Array} segments 会话段
 * @param {object} [opts] { total, preClose }
 * @returns {Array} [[t, pct]] 抽稀后序列
 */
export function thinBySegment(rows, segments, { total = SPARK_MAX_POINTS, preClose } = {}) {
  const pre = Number(preClose);
  if (!Number.isFinite(pre) || pre <= 0 || !Array.isArray(rows) || rows.length === 0) return [];
  const segs = segments.map(([a, b]) =>
    rows.filter(([t]) => hmMin(t) >= hmMin(a) && hmMin(t) <= hmMin(b)),
  );
  const mins = segments.map(([a, b]) => Math.max(1, hmMin(b) - hmMin(a)));
  const sum = mins.reduce((x, y) => x + y, 0);
  const out = [];
  segs.forEach((seg, i) => {
    if (seg.length === 0) return;
    const budget = Math.max(2, Math.round((total * mins[i]) / sum));
    const k = Math.min(budget, seg.length);
    const take =
      seg.length <= k
        ? seg
        : Array.from({ length: k }, (_, j) => seg[Math.round((j * (seg.length - 1)) / (k - 1))]);
    for (const [t, c] of take) out.push([t, r4(((c - pre) / pre) * 100)]);
  });
  return out;
}

/**
 * 子缓存「终局」判据：items中每条有效分时（≥2点）的末点到达市场时段末尾（tolMin分钟容差），判定为完整场次。
 *
 * 背景：旧逻辑出时段直接复用缓存，隐含假设收盘前完成最后刷新。美股北京时间21:30–04:00，页面/机器休眠会冻结半场缓存长达12h，曲线停在盘中。
 * 放弃「写入时刻vs时段起始」对比（跨午夜恒假，上游压力放大5.5倍），改为从数据本身判定：
 * 完整场次 = 真终局；半场缓存交由调用方冷却刷新补齐。
 * 早休/半日市按标准时段比对会持续判定半场，同样依靠调用方冷却兜底。
 * spark为null/单点条目（no_source、fetch_failed）不参与判定，防止单条坏源阻塞整个市场终局判断。
 * @param {Array} items 指数分时结果集
 * @param {string} market 'cn' | 'hk' | 'us'
 * @param {object} [opts] { tolMin?: number }
 * @returns {boolean} 是否覆盖完整场次
 */
export function sparkCoversSession(items, market, { tolMin = 2 } = {}) {
  const segs = INDEX_SESSIONS[market] || INDEX_SESSIONS.cn;
  const end = hmMin(segs[segs.length - 1][1]);
  const sparks = (Array.isArray(items) ? items : [])
    .map((it) => it?.spark)
    .filter((sp) => Array.isArray(sp) && sp.length >= 2);
  if (sparks.length === 0) return false;
  return sparks.every((sp) => {
    const m = hmMin(sp[sp.length - 1]?.[0]);
    return Number.isFinite(m) && m >= end - tolMin;
  });
}

/**
 * 指数行情时间钳制：沪市指数盘后源侧时间戳仍滚动（新浪实测沪市给 16:19 而深市停 15:00），恒生 f124 同理；
 * 行情时间口径是最后成交时点，超市场收盘时刻的源侧处理时间钳回收盘时刻。美股跨午夜会话无此噪音，不处理。
 * @param {Array} indexes push2/parseSinaIndexes 同构列表（{ code, time(Unix 秒|null), ... }）
 * @returns {Array} 同构列表；cn/hk 中时钟超过收盘时刻(+30s 容忍)的项钳到当日收盘，其余原样返回
 */
export function clampIndexTimes(indexes) {
  return (Array.isArray(indexes) ? indexes : []).map((idx) => {
    if (idx?.time == null) return idx;
    const market = marketOfIndex(idx.code);
    if (market !== 'cn' && market !== 'hk') return idx;
    const segs = INDEX_SESSIONS[market];
    const [ch, cm] = segs[segs.length - 1][1].split(':').map(Number);
    const closeSec = ch * 3600 + cm * 60;
    const bj = new Date((idx.time + 8 * 3600) * 1000); // 源侧是北京墙钟，epoch+8h 后按 UTC 读即北京时间
    const daySec = bj.getUTCHours() * 3600 + bj.getUTCMinutes() * 60 + bj.getUTCSeconds();
    if (daySec <= closeSec + 30) return idx;
    return { ...idx, time: idx.time - (daySec - closeSec) };
  });
}
