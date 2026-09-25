/**
 * 收益页汇总层纯函数。
 * 同构无副作用：无Node全局、无网络I/O；到账日志、净值字典由调用方预取同步注入。
 * Vue页面summary是computed，函数内fetch会断裂响应式链。
 *
 * 口径速查：
 * TWR期末现金流模型：场外申赎/分红按当日收盘净值确认。
 * r_t = (A_t − F_t − A_{t−1}) ÷ A_{t−1}；A_{t−1}=0 → r_t=0。
 * F_t：净外部现金流（流入为正）= Σ买入 − Σ卖出所得(resolveSellProceeds) − Σ现金分红。
 *
 * 现金流归属：买入/卖出取首次体现行navDate（回退tx.date）；现金分红按tx.date。
 */
import { applyBuy, applySell, applyDividend, computeXIRR } from './calculator.js';
import { computeDrawdown } from './analysis.js';
import { parseISODate, addDays, isoDate } from './analysis.js';
import { beijingMinutes } from './marketClock.js';

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;

/** 来源分组：汇总用的"来源维度"，与导航用的 categories 是两个概念，不得合并 */
export const SOURCE_GROUPS = [
  { key: 'fund', label: '场外基金', supported: true },
  { key: 'gold_etf', label: '场内ETF', supported: false },
  { key: 'gold_accum', label: '银行积存金', supported: false },
];

const MONEY_FIELDS = [
  'invested',
  'value',
  'holdProfit',
  'dailyProfit',
  'dayProfit',
  'prevDayProfit',
];
const GROUP_NULLABLE_FIELDS = [...MONEY_FIELDS, 'returnRate', 'sharePct'];

/** 空分组骨架：未支持分组的数值字段一律 null（赋 0 会被格式化成 ¥0.00/0.00%，违反"不显示 0"） */
function emptyGroup(def) {
  const g = { key: def.key, label: def.label, supported: def.supported };
  for (const f of GROUP_NULLABLE_FIELDS) g[f] = null;
  return g;
}

function sumField(rows, field, { requireAll = false } = {}) {
  let sum = 0;
  let has = false;
  let all = true;
  for (const r of rows) {
    const v = r[field];
    if (v == null || !Number.isFinite(Number(v))) {
      all = false;
      continue;
    }
    sum += Number(v);
    has = true;
  }
  // value 走 requireAll（任一基金无行情 → 总资产 null"待更新"），与首页口径一致
  if (requireAll) return rows.length > 0 && all ? sum : null;
  return has ? sum : null;
}

/**
 * 汇总层：首页收益条、收益页共用同一实现。
 * states: [{ assetType, invested, value, holdProfit, dailyProfit, dayProfit, prevDayProfit, returnRate }]
 * options.totalRealizedProfit：调用方注入 Σ buildRealizedProfit；前置未就绪则为null。
 *
 * 不变量：A.总计行固定置顶，渲染层不得过滤；B.显示合计对齐，alignGroupsToTotal处理尾差。
 * prevDayProfit出参已内置兜底 s.prevDayProfit ?? s.dailyProfit；周一盘前/长假首日prevDayProfit可为null，
 * 收口在本函数内部，UI禁止二次回退。
 */
export function buildPortfolioSummary(states, { totalRealizedProfit = null } = {}) {
  const rows = Array.isArray(states) ? states : [];
  const groupOf = (r) => SOURCE_GROUPS.find((d) => d.key === (r.assetType ?? 'fund'));
  const supportedRows = rows.filter((r) => groupOf(r)?.supported); // 未支持分组不计入总计（保证不变量 B）
  const groups = SOURCE_GROUPS.map((def) => {
    const g = emptyGroup(def);
    if (!def.supported) return g; // 未开发品类：占位，字段全 null
    const owned = rows.filter((r) => (r.assetType ?? 'fund') === def.key);
    g.invested = sumField(owned, 'invested');
    g.value = sumField(owned, 'value', { requireAll: true });
    g.holdProfit = sumField(owned, 'holdProfit');
    g.dailyProfit = sumField(owned, 'dailyProfit');
    g.dayProfit = sumField(owned, 'dayProfit');
    // prevday 逐基金回退：先 ?? 再累加，保证分组/总计对齐的是同一份回退后的值
    g.prevDayProfit = sumField(
      owned.map((s) => ({ prevDayProfit: s.prevDayProfit ?? s.dailyProfit })),
      'prevDayProfit',
    );
    g.returnRate =
      g.invested != null && g.invested > 0 && g.holdProfit != null
        ? round4(g.holdProfit / g.invested)
        : null; // invested ≤ 0 → null（0% 会暗示"持平"）
    return g;
  });

  const total = {
    invested: sumField(supportedRows, 'invested'),
    value: sumField(supportedRows, 'value', { requireAll: true }),
    holdProfit: sumField(supportedRows, 'holdProfit'),
    returnRate: null,
    dailyProfit: sumField(supportedRows, 'dailyProfit'),
    dayProfit: sumField(supportedRows, 'dayProfit'),
    prevDayProfit: sumField(
      supportedRows.map((s) => ({ prevDayProfit: s.prevDayProfit ?? s.dailyProfit })),
      'prevDayProfit',
    ),
    cumulativeProfit: null,
  };
  total.returnRate =
    total.invested != null && total.invested > 0 && total.holdProfit != null
      ? round4(total.holdProfit / total.invested)
      : null;
  total.cumulativeProfit =
    totalRealizedProfit != null && total.holdProfit != null
      ? round2(total.holdProfit + Number(totalRealizedProfit))
      : null; // 前置未就绪 → null → 显示"—"

  // sharePct：仅 supported 分组参与；total.value === 0 → 全 0（防除零/NaN%）
  const supported = groups.filter((g) => g.supported);
  if (total.value != null && total.value > 0) {
    for (const g of supported) g.sharePct = round2(((g.value ?? 0) / total.value) * 100);
  } else {
    for (const g of supported) g.sharePct = 0;
  }

  return { total, groups: alignGroupsToTotal(groups, total) };
}

/**
 * 尾差并入（不变量 B）：分组显示值之和与总计（或 sharePct 目标 100）出现 round2 级尾差时，
 * 并入该字段绝对值最大的分组（金额最大者对尾差最不敏感；含负数场景按 |·| 取）。
 * 纯函数：返回新数组，不改入参。仅 supported 分组参与（未支持分组字段为 null）。
 */
export function alignGroupsToTotal(groups, total, { sharePctTotal = 100 } = {}) {
  const out = groups.map((g) => ({ ...g }));
  const supported = out.filter((g) => g.supported);
  for (const f of MONEY_FIELDS) {
    if (total[f] == null) continue;
    const withValue = supported.filter((g) => g[f] != null);
    if (withValue.length === 0) continue;
    const sum = round2(withValue.reduce((s, g) => s + g[f], 0));
    const diff = round2(total[f] - sum);
    if (diff === 0) continue;
    const target = withValue.reduce(
      (m, g) => (Math.abs(g[f]) > Math.abs(m[f]) ? g : m),
      withValue[0],
    );
    target[f] = round2(target[f] + diff);
  }
  // sharePct 尾差并入占比最大的分组：仅 total.value > 0 时目标 100
  //（空仓/全清仓时 supported 组 sharePct 已置 0，不得被拉成 100）
  if (total.value != null && total.value > 0) {
    const withPct = supported.filter((g) => g.sharePct != null);
    if (withPct.length > 0) {
      const pctSum = round2(withPct.reduce((s, g) => s + g.sharePct, 0));
      const pctDiff = round2(sharePctTotal - pctSum);
      if (pctDiff !== 0) {
        const target = withPct.reduce((m, g) => (g.sharePct > m.sharePct ? g : m), withPct[0]);
        target.sharePct = round2(target.sharePct + pctDiff);
      }
    }
  }
  return out;
}

/**
 * 区间切片，返回 { baselinePoint, series }。
 * range为数字：按档位天数取日期窗，t0 = 末日 − (days−1) 天，保留 date ≥ t0 的点。
 * range='all'：全量数据，baselinePoint = null。
 * baselinePoint：切片前最近可用点，区间XIRR a₀、A₀取值源；区间从首点开始则为null。
 * rangeStats退化公式 a₀ = 首点资产 − 首点当日净现金流，保障a₀与[t0,t1]现金流不重不漏。
 * 样本不足返回实际可用区间，不返回空。
 * series: [{date, ...}]，升序。
 */
export function sliceSeries(series, range) {
  const list = Array.isArray(series) ? series : [];
  if (range === 'all' || list.length === 0) return { baselinePoint: null, series: list.slice() };
  const days = Number(range);
  if (!Number.isFinite(days) || days <= 0) return { baselinePoint: null, series: list.slice() };
  const last = parseISODate(list[list.length - 1].date);
  const t0 = isoDate(addDays(last, -(days - 1)));
  let cut = 0;
  while (cut < list.length && list[cut].date < t0) cut++;
  return {
    baselinePoint: cut > 0 ? list[cut - 1] : null,
    series: list.slice(cut),
  };
}

/**
 * TWR指数序列（期末现金流模型）：构造指数后送入computeDrawdown，不可直接用总资产算比率。
 * series：aggregateDaily输出 [{date, total_assets}]，升序；
 * flows：[{date, amount}]净外部现金流（流入为正：买入+、卖出所得−、现金分红−，金额量纲，buildPortfolioFlows产出）。
 *
 * r_t = (A_t − F_t − A_{t−1}) ÷ A_{t−1}；
 * A_{t−1}=0（首笔入金/清仓重建）→ r_t=0，新资金确认当日不产生收益。
 *
 * 落在序列间隙的现金流前滚到下一序列日；QDII日轴上游已对齐，此处仅防御。
 * 全量重算约束：QDII补录会新增历史navDate点，调用方不得增量缓存本序列。
 * 返回 [{date, nav: I_t}]，I₀ = 1。
 */
export function twrIndex(series, flows) {
  const list = Array.isArray(series) ? series : [];
  const flowByDate = new Map();
  for (const f of Array.isArray(flows) ? flows : []) {
    if (!f || !f.date) continue;
    flowByDate.set(f.date, (flowByDate.get(f.date) ?? 0) + (Number(f.amount) || 0));
  }
  const out = [];
  let prev = 0;
  let I = 1;
  for (const p of list) {
    const date = p.date;
    let F = flowByDate.get(date) ?? 0;
    if (!flowByDate.has(date)) {
      // 前滚：归属日不在序列轴上 → 计入其后第一个序列日（其后无序列日则丢弃——不影响区间内收益）
      const next = list.find((q) => q.date > date);
      if (next) flowByDate.set(next.date, (flowByDate.get(next.date) ?? 0) + F);
      F = 0;
    } else {
      flowByDate.delete(date); // 同日多笔已合并；删除防重复消费
    }
    const A = Number(p.total_assets ?? p.assets ?? 0);
    const r = prev > 0 ? (A - F - prev) / prev : 0;
    I = I * (1 + r);
    out.push({ date, nav: round4(I * 10000) / 10000 });
    prev = A;
  }
  return out;
}

const byDateAsc = (a, b) => String(a.date).localeCompare(String(b.date));

/**
 * 现金流归属日（归属轴）：
 * 买入/卖出按首次体现行navDate：基金日志中 date ≥ tx.date 的首行；回退行取该行navDate，不用tx.date。
 * 现金分红按tx.date（除息日即净值日）。
 */
function attributionDate(tx, logRows) {
  if (tx.type === 'dividend') return tx.date;
  const rows = (Array.isArray(logRows) ? logRows : []).slice().sort(byDateAsc);
  const hit = rows.find((r) => String(r.date) >= String(tx.date));
  if (hit) return hit.navDate || hit.date;
  return tx.date;
}

/**
 * 单笔卖出所得恢复（量纲统一为金额；①②③全程同量纲，下游禁止再乘份额）：
 * ① tx.amount：卖出仅强制shares，amount可选，缺失交由missingTradeFields；
 * ② 首次体现行shares>0 → (assets ÷ shares) × tx.shares（同净值日的行内取值）；
 * ③ 全额清仓（本行shares=0/无后续行）→ 历史净值 × tx.shares；优先首次体现行navDate（QDII确认日≠tx.date），无日志才回退tx.date；
 * ④ 均不可得 → null（交易不全信号T4）；所有分支禁止产出NaN。
 *
 * logRows：基金到账日志 [{date, navDate, invested, assets, shares?}]；
 * shares由调用方computeState回放生成，本纯函数不回放；historyNavByDate: { 'YYYY-MM-DD': nav }。
 */
export function resolveSellProceeds(tx, logRows, historyNavByDate) {
  if (!tx || tx.type !== 'sell') return null;
  const shares = Number(tx.shares);
  if (!Number.isFinite(shares) || shares <= 0) return null; // Number(null)=0，必须显式拦
  const amount = Number(tx.amount);
  if (Number.isFinite(amount)) return round2(amount);

  const rows = (Array.isArray(logRows) ? logRows : []).slice().sort(byDateAsc);
  let prevInvested = null;
  let hit = null;
  for (const r of rows) {
    if (String(r.date) < String(tx.date)) {
      prevInvested = Number(r.invested);
      continue;
    }
    const invested = Number(r.invested);
    // 首次体现行：有前行时看 invested 下降（卖出成本入账；同日买卖净增时漏检，落入 ③ 级兜底）；
    // 无前行（日志窗口起点即本行）时以 invested=0（清仓关户签名）认定
    const reflects = prevInvested != null ? invested < prevInvested : invested === 0;
    if (reflects) {
      hit = r;
      break;
    }
    prevInvested = invested;
  }

  if (hit) {
    const rowShares = Number(hit.shares);
    if (Number.isFinite(rowShares) && rowShares > 0 && Number.isFinite(Number(hit.assets))) {
      return round2((Number(hit.assets) / rowShares) * shares);
    }
    // ③：历史净值（navDate 优先；全部清仓时 shares=0，② 不可用）
    const navDay = hit.navDate || hit.date;
    const nav = Number(historyNavByDate?.[navDay]);
    if (Number.isFinite(nav) && nav > 0) return round2(nav * shares);
    return null;
  }
  // 无日志行可依 → 回退 tx.date 查历史净值
  const nav = Number(historyNavByDate?.[tx.date]);
  if (Number.isFinite(nav) && nav > 0) return round2(nav * shares);
  return null;
}

/**
 * 单基金已实现盈亏：回放交易（applyBuy/applySell/applyDividend 与主表同源），
 * realized = Σ[卖出所得 − 摊薄成本 × 份额] + Σ现金分红；红利再投资不计入（增份额不进本金）。
 * 卖出所得经 resolveSellProceeds 恢复，不可得 → 返回 null（交易不全，T4 信号）。
 * 入参 { snapshot, transactions, logRows, historyNavByDate } 全部同步注入（纯函数，零 I/O）。
 */
export function buildRealizedProfit({ snapshot, transactions, logRows, historyNavByDate }) {
  const snap = snapshot || {};
  let state = {
    totalInvested: Number(snap.total_invested) || 0,
    holdShares: Number(snap.hold_shares) || 0,
    costPrice: Number(snap.cost_price) || 0,
  };
  let realized = 0;
  const txs = (Array.isArray(transactions) ? transactions : [])
    .filter((t) => t && t.type && t.date)
    .slice()
    .sort(byDateAsc);
  for (const tx of txs) {
    if (tx.type === 'buy') {
      const amount = Number(tx.amount);
      const shares = Number(tx.shares);
      if (!Number.isFinite(amount) || !Number.isFinite(shares)) continue;
      state = applyBuy(state, { amount, shares });
    } else if (tx.type === 'sell') {
      const shares = Number(tx.shares);
      if (!Number.isFinite(shares)) continue;
      const proceeds = resolveSellProceeds(tx, logRows, historyNavByDate);
      if (proceeds == null) return null; // 交易不全（T4）→ 累计收益显示"—"
      const cost = shares * state.costPrice;
      realized += proceeds - cost;
      state = applySell(state, { shares });
    } else if (tx.type === 'dividend') {
      if (tx.method === 'reinvest') {
        const shares = Number(tx.shares);
        if (!Number.isFinite(shares)) continue;
        state = applyDividend(state, { method: 'reinvest', shares });
      } else {
        const cash = Number(tx.amount);
        if (Number.isFinite(cash)) realized += cash; // 只入已实现（派生规则）
      }
    }
  }
  return round2(realized);
}

/**
 * 组合级净外部现金流序列（F_t，TWR喂料）：逐基金回放交易。
 * F_t = 买入(+amount) − 卖出所得(resolveSellProceeds) − 现金分红(amount)。
 * 归属日attributionDate：买卖取首次体现行navDate，分红按tx.date。
 * 返回 [{date, amount}]，流入为正。
 * 符号约定与XIRR相反（XIRR投入为负），调用方严禁混用。
 */
export function buildPortfolioFlows({ snapshot, transactions, logRows, historyNavByDate }) {
  const snap = snapshot || {};
  let state = {
    totalInvested: Number(snap.total_invested) || 0,
    holdShares: Number(snap.hold_shares) || 0,
    costPrice: Number(snap.cost_price) || 0,
  };
  const out = [];
  const txs = (Array.isArray(transactions) ? transactions : [])
    .filter((t) => t && t.type && t.date)
    .slice()
    .sort(byDateAsc);
  for (const tx of txs) {
    const date = attributionDate(tx, logRows);
    if (tx.type === 'buy') {
      const amount = Number(tx.amount);
      const shares = Number(tx.shares);
      if (!Number.isFinite(amount) || !Number.isFinite(shares)) continue;
      state = applyBuy(state, { amount, shares });
      out.push({ date, amount });
    } else if (tx.type === 'sell') {
      const shares = Number(tx.shares);
      if (!Number.isFinite(shares)) continue;
      const proceeds = resolveSellProceeds(tx, logRows, historyNavByDate);
      state = applySell(state, { shares });
      if (proceeds != null) out.push({ date, amount: -proceeds });
      // 所得不可得（交易不全）→ 该笔现金流缺失，twrIndex 消费方据 buildRealizedProfit===null 显示"—"
    } else if (tx.type === 'dividend') {
      if (tx.method === 'reinvest') {
        const shares = Number(tx.shares);
        if (Number.isFinite(shares)) state = applyDividend(state, { method: 'reinvest', shares });
      } else {
        const cash = Number(tx.amount);
        if (Number.isFinite(cash)) {
          out.push({ date, amount: -cash });
        }
      }
    }
  }
  return out;
}

/**
 * 区间指标：{a0,a1,dAsset,changePct,dInvest,contrib,mddPct,xirr,n,startDate,endDate}。
 * a₀ = baselinePoint?.total_assets ?? (首点资产 − 首点当日净现金流)；退化路径保证与[t0,t1]现金流不重不漏。
 * dInvest = Σ F_t（[t0,t1]净外部现金流，TWR同源）；MUST NOT用invested期末差（同源陷阱）。
 * contrib = dAsset − dInvest，期末现金流模型恒等式严格成立。
 * changePct = (a1−a0)/a0 区间资产变动率，round4，和区间变动金额配对；a₀ ≤0 → null，页面显示"—"。
 * 页面文案必须命名「区间变动」，收益评估交给xirr/mddPct（v9）。
 * mddPct：baselinePoint为种子生成TWR指数，传入computeDrawdown；禁止直接对总资产算比率。
 * xirrFlows：调用方构造区间现金流（虚拟±A+真实流，投入为负），复用computeXIRR。
 */
export function rangeStats({ baselinePoint = null, series, flows = [], xirrFlows = null } = {}) {
  const list = Array.isArray(series) ? series : [];
  if (list.length === 0) return null;
  const first = list[0];
  const last = list[list.length - 1];
  const start = first.date;
  const inRange = (Array.isArray(flows) ? flows : []).filter((f) => f && f.date >= start);
  const F0 = inRange
    .filter((f) => f.date === start)
    .reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const a0 = round2(
    baselinePoint ? Number(baselinePoint.total_assets ?? 0) : Number(first.total_assets ?? 0) - F0,
  );
  const a1 = round2(Number(last.total_assets ?? 0));
  const dAsset = round2(a1 - a0);
  const changePct = a0 > 0 ? round4((a1 - a0) / a0) : null;
  const dInvest = round2(inRange.reduce((s, f) => s + (Number(f.amount) || 0), 0));
  const contrib = round2(dAsset - dInvest);

  // TWR：以 baselinePoint 为种子（无则 prev=0 → 首日 r=0），指数仅覆盖区间
  const seedSeries = baselinePoint ? [baselinePoint, ...list] : list;
  const twr = twrIndex(seedSeries, flows);
  const twrRange = baselinePoint ? twr.slice(1) : twr;
  const dd = computeDrawdown(twrRange.map((p) => ({ date: p.date, nav: p.nav })));
  const mddPct = dd.maxDrawdown == null ? null : round4(dd.maxDrawdown);

  const xirr = Array.isArray(xirrFlows) && xirrFlows.length >= 2 ? computeXIRR(xirrFlows) : null;
  return {
    a0,
    a1,
    dAsset,
    changePct,
    dInvest,
    contrib,
    mddPct,
    xirr: xirr == null ? null : round4(xirr),
    n: list.length,
    startDate: start,
    endDate: last.date,
  };
}

/**
 * 三态当日收益判定（beijingMinutes五区间划界；22:00时间翻转是上游行为）。
 * isTradingDay：交易日历判定。false→休市；null/未决按交易日乐观处理，宁可不报休市，和inQuoteWindow口径一致。
 * 午休（690–780）归预估态：估值仍属今日，显示「预估」贴合数据实态。
 */
export function dayProfitState({
  now = new Date(),
  isTradingDay = null,
  flipMinute = 22 * 60,
} = {}) {
  if (isTradingDay === false) return 'closed';
  const m = beijingMinutes(now);
  if (m < 570) return 'prevday';
  if (m < 900) return 'est';
  if (m < flipMinute) return 'mixed';
  return 'done';
}
