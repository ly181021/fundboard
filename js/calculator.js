/**
 * 对当前状态应用一笔买入交易。
 * 买入：累计投入本金 += amount；持有份额 += shares；成本价重算。
 */
export function applyBuy(state, tx) {
  const totalInvested = state.totalInvested + tx.amount;
  const holdShares = state.holdShares + tx.shares;
  const costPrice = holdShares > 0 ? totalInvested / holdShares : 0;
  return { ...state, totalInvested, holdShares, costPrice };
}

/**
 * 对当前状态应用一笔卖出交易。
 * 卖出本金 = 卖出份额 × 当前成本价；累计投入本金和份额等比减少。
 * 成本价不变（因本金与份额等比减少）。
 */
export function applySell(state, tx) {
  const sellCost = tx.shares * state.costPrice;
  const totalInvested = state.totalInvested - sellCost;
  const holdShares = state.holdShares - tx.shares;
  const costPrice = holdShares > 0 ? totalInvested / holdShares : 0;
  return { ...state, totalInvested, holdShares, costPrice };
}

/**
 * 对当前状态应用一笔分红交易。
 * 现金分红：累计投入本金不变，份额不变（分红是收益不是本金回收）。
 * 红利再投：累计投入本金不变，份额增加，成本价摊薄。
 */
export function applyDividend(state, tx) {
  if (tx.method === 'cash') {
    return { ...state };
  }
  // 红利再投
  const holdShares = state.holdShares + tx.shares;
  const costPrice = holdShares > 0 ? state.totalInvested / holdShares : 0;
  return { ...state, holdShares, costPrice };
}

/**
 * 从快照基线出发，按日期顺序叠加所有交易，计算当前完整状态。
 *
 * 基线本金 = snapshot.total_invested（用户初次导入时手动填入的累计投入本金）。
 * 注意：不用 cost_price × hold_shares 反推——持有金额 ≠ 本金（持有金额 = 本金 + 利润）。
 *
 * 卖出按净投入逻辑：卖出收回的钱按成本价反推卖出本金，从累计投入本金里扣减。
 *
 * 返回：
 *   totalInvested  累计投入本金（基线 + 交易增量）
 *   holdShares     当前持有份额
 *   costPrice      当前持仓成本价（加权平均，用于卖出本金反推）
 *   holdAmount     当前持有金额（快照 + 买入增 - 卖出本金）
 *   holdProfit     持有收益 = holdAmount - totalInvested
 *   lossRate       亏损率 = (totalInvested - holdAmount) / totalInvested
 *   alert          预警级别对象或 null
 */
export function computeState(snapshot, transactions) {
  // 基线：用户手动填入的累计投入本金
  let state = {
    totalInvested: snapshot.total_invested,
    holdShares: snapshot.hold_shares,
    costPrice: snapshot.cost_price,
    holdAmount: snapshot.hold_amount,
  };

  // 按日期排序后逐笔叠加
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const tx of sorted) {
    if (tx.type === 'buy') {
      state = applyBuy(state, tx);
      state.holdAmount += tx.amount;
    } else if (tx.type === 'sell') {
      const sellCost = tx.shares * state.costPrice;
      state = applySell(state, tx);
      state.holdAmount -= sellCost;
    } else if (tx.type === 'dividend') {
      state = applyDividend(state, tx);
      // 分红不影响 holdAmount（现金分红离开基金，红利再投份额增加但市值近似不变）
    }
  }

  const holdProfit = state.holdAmount - state.totalInvested;
  const lossRate =
    state.totalInvested > 0 ? (state.totalInvested - state.holdAmount) / state.totalInvested : 0;

  return {
    totalInvested: state.totalInvested,
    holdShares: state.holdShares,
    costPrice: state.costPrice,
    holdAmount: state.holdAmount,
    holdProfit,
    lossRate,
  };
}

/** 涨跌幅% = (cur − prev) ÷ prev × 100，保留 4 位小数；无效输入返回 null。 */
function changePct(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100 * 10000) / 10000;
}

/**
 * 当日/昨日收益 = 持有份额 × 当日涨跌额，按金额四舍五入到分（消除净值差浮点噪声）。
 * 涨跌额缺失（null）时返回 null（UI 显示"待更新"）。
 */
export function computeDailyProfit(holdShares, changeAmount) {
  if (holdShares == null || changeAmount == null) return null;
  return Math.round(holdShares * changeAmount * 100) / 100;
}

/**
 * 合并单条行情（/api/quote结构）到持仓状态，得到行情口径完整状态。
 * today（YYYY-MM-DD）由调用方注入，用于盘中/收盘判定：
 * 估值模式：estimate属于今天，且今日确认净值未发布（nav_date !== today）→ 使用估算净值；
 * 确认模式：其余情况（今日净值已发布则优先确认净值）→ 使用相邻确认净值差值。
 * 同步更新市值 holdAmount = 份额 × 最新净值，并重算预警。
 *
 * 附带输出净值对齐展示字段，用于表格/汇总卡当日、昨日列：
 * dataDate：当日数据归属日期；估值模式为today，否则nav_date，日视图明细以此对齐。
 * dayProfit / dayChangePct：仅行情属于今日（估值模式 或 nav_date === today）有值，其余null。
 * 场外基金净值晚间公布，开盘不可把昨日行情当作当日展示。
 * prevDayProfit：行情是今日 → 昨日变动（prev_nav − prev2_nav）；nav_date为昨天 → 使用该日变动；更早则null。
 */
export function applyQuote(state, quote, today, name) {
  // QDII（基金名称含 QDII）不使用任何估值源——其估值是第三方自算且滞后失真，
  // 只走确认净值 + 到账口径；国内基金（含天天基金无估值的中欧系等）正常用估值。
  const isQdii = /QDII/i.test(name ?? '');
  const est = isQdii ? null : quote.estimate;
  // 估值模式 = 估值属于今天 且 今天的确认净值尚未发布（nav_date === today 时确认净值优先于估值）
  const estimateMode = !!(
    est &&
    est.nav != null &&
    typeof est.time === 'string' &&
    est.time.startsWith(today) &&
    quote.nav_date !== today
  );

  const prevNav = quote.prev_nav;
  const prev2Nav = quote.prev2_nav;
  let dayChange; // 当日涨跌额
  let prevChange; // 昨日涨跌额
  let latestNav; // 市值采用的"最新净值"
  let dailyChange;
  if (estimateMode) {
    latestNav = est.nav;
    dayChange = est.nav - quote.nav;
    prevChange = prevNav != null ? quote.nav - prevNav : null;
    dailyChange = est.change_pct != null ? est.change_pct : changePct(est.nav, quote.nav);
  } else {
    latestNav = quote.nav;
    dayChange = prevNav != null ? quote.nav - prevNav : null;
    prevChange = prevNav != null && prev2Nav != null ? prevNav - prev2Nav : null;
    dailyChange = quote.change_pct != null ? quote.change_pct : changePct(quote.nav, prevNav);
  }

  // 市值按分舍入后再参与收益/亏损率计算：与支付宝等渠道发布的两位小数市值口径对齐，
  // 避免份额×4位净值产生的半分中间值（如 50×1.8369=91.845）让收益显示差一分（-50.995→-51.00）
  const holdAmount = Math.round(state.holdShares * latestNav * 100) / 100;
  const holdProfit = holdAmount - state.totalInvested;
  const lossRate =
    state.totalInvested > 0 ? (state.totalInvested - holdAmount) / state.totalInvested : 0;

  const dayProfit = computeDailyProfit(state.holdShares, dayChange);
  const prevDayProfitRaw = computeDailyProfit(state.holdShares, prevChange);
  const navToday = estimateMode || quote.nav_date === today;
  const navYesterday = !navToday && quote.nav_date === yesterdayOf(today);
  // QDII 到账口径（与 js/analysis.js 到账日志的口径 A 同源）：到账日 = 净值日的下一个工作日。
  // 判据不能用"nav_date === 昨天"：QDII 净值 T+1 个交易日公布，周五净值要到周日晚/周一才到账
  // （跨周末差 3 个日历日），按"昨天"判会在周一漏判成"未到账"、当日列误显「待更新」（实测发现）。
  // QDII 新到账当天："当日"列显示新到账的确认收益与它自己净值日的涨幅，昨日列 = 再前一天的变动（到账口径）
  const qdiiLate =
    isQdii && !navToday && quote.nav_date != null && nextWorkdayOf(quote.nav_date) === today;

  return {
    ...state,
    holdAmount,
    holdProfit,
    lossRate,
    latestNav,
    navDate: quote.nav_date ?? null,
    mode: estimateMode ? 'estimate' : 'confirmed',
    dataDate: estimateMode ? today : (quote.nav_date ?? null), // "当日"数据所属的日期（估值属于今天）
    estimateTime: estimateMode ? est.time : null, // 估值时间（YYYY-MM-DD HH:mm[:ss]），确认模式为 null
    confirmedNav: estimateMode ? quote.nav : null, // 估值模式下同时保留最近确认净值（净值列副行展示）
    dailyProfit: dayProfit,
    dailyChangePct: dailyChange,
    yesterdayProfit: prevDayProfitRaw,
    dayProfit: navToday || qdiiLate ? dayProfit : null,
    dayChangePct: navToday || qdiiLate ? dailyChange : null,
    prevDayProfit: navToday
      ? prevDayProfitRaw
      : qdiiLate
        ? prevDayProfitRaw
        : navYesterday
          ? dayProfit
          : null,
  };
}

/** today（YYYY-MM-DD）的前一日（本地时区），供净值日期对齐用 */
function yesterdayOf(today) {
  const [y, m, d] = String(today).split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * 净值日的下一个工作日（跳周末；本地时区）。到账口径 A 的单一实现：
 * 到账日志（`js/analysis.js bookArrivals`：QDII 到账日 = 净值日下一工作日）与当日/昨日列
 * （本文件 applyQuote）共用本函数，两处口径不得各写一份。
 * 法定节假日暂不感知（与存量重建工具同口径，只跳周末）。
 */
export function nextWorkdayOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

const DAY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 重复交易判重：指纹 = type + date + amount + shares + method 全等，
 * 缺失字段视为 null 参与比较。返回命中下标，无命中 -1；excludeIdx 供编辑模式排除自身。
 * 与 lib/ocr.js 的 dedupeTrades 同口径（跨分块合并 / 批量判重 / 手动判重共用）。
 */
export function findDuplicateTrade(transactions, tx, excludeIdx = -1) {
  const key = (t) =>
    JSON.stringify([
      t?.type ?? null,
      t?.date ?? null,
      t?.amount ?? null,
      t?.shares ?? null,
      t?.method ?? null,
    ]);
  const k = key(tx);
  for (let i = 0; i < transactions.length; i++) {
    if (i === excludeIdx) continue;
    if (key(transactions[i]) === k) return i;
  }
  return -1;
}

/**
 * 交易字段完整性校验（批量入库闸门）：返回缺失字段名数组，空数组 = 可入库。
 * 买入必须 amount+shares；卖出必须 shares；分红按方式要求 amount（现金）或 shares（再投）。
 * 支付宝交易记录页常无份额列，识别出的买入缺 shares 时由用户在批量面板补齐后才允许保存（防 NaN 入库）。
 */
export function missingTradeFields(tx) {
  const missing = [];
  if (tx.type === 'buy') {
    if (!Number.isFinite(tx.amount)) missing.push('amount');
    if (!Number.isFinite(tx.shares)) missing.push('shares');
  } else if (tx.type === 'sell') {
    if (!Number.isFinite(tx.shares)) missing.push('shares');
  } else if (tx.type === 'dividend') {
    if (tx.method === 'reinvest') {
      if (!Number.isFinite(tx.shares)) missing.push('shares');
    } else {
      if (!Number.isFinite(tx.amount)) missing.push('amount');
    }
  }
  return missing;
}

/**
 * 为批量识别中"不在持仓"的基金创建零快照持仓。
 * 快照全 0，本金/份额完全由交易历史驱动；id 带 code 后缀且不可解析为时间戳，
 * XIRR 基线日期自动回落到首笔交易日期（creationDateFromId 返回 null 的兜底路径）。
 */
export function buildEmptyFundAsset({ code, name = null }, now = Date.now()) {
  return {
    id: `fund_${now}_${code}`,
    asset_type: 'fund',
    name: name || code,
    code,
    snapshot: {
      hold_amount: 0,
      pending_amount: 0,
      cost_price: 0,
      hold_shares: 0,
      total_invested: 0,
    },
    transactions: [],
  };
}

/**
 * 跨块识别合并后补齐缺失元数据：code/name 为 null 的行用唯一非空值填充。
 * 长截图的基金代码与名称只在页头（第一块）出现，中间片段的每一行都会是 null。
 */
export function unifyTradeMeta(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const codes = [...new Set(list.map((t) => t?.code).filter(Boolean))];
  const names = [...new Set(list.map((t) => t?.name).filter(Boolean))];
  return list.map((t) => ({
    ...t,
    code: t.code || (codes.length === 1 ? codes[0] : t.code),
    name: t.name || (names.length === 1 ? names[0] : t.name),
  }));
}

/** 基金名称规范化：去空白、全角括号转半角（OCR 名称与持仓/搜索名称对比前统一口径） */
export function normalizeFundName(name) {
  return String(name ?? '')
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')');
}

/**
 * 从基金搜索候选，为截图只有名称、无代码的基金匹配代码，供多图导入自动建持仓。
 * 保守消歧原则：宁可不填，绝不填错。
 * 匹配规则：①名称规范化精确相等；②OCR名称以字母结尾（如 (QDII)C），取唯一同尾候选；
 *  ③候选仅1条直接使用。其余情况返回 null，留给用户手动补全。
 */
export function pickFundCode(name, results) {
  const list = (Array.isArray(results) ? results : []).filter(
    (r) => r && /^\d{6}$/.test(String(r.code)),
  );
  if (!name || list.length === 0) return null;
  const n = normalizeFundName(name);
  const exact = list.find((r) => normalizeFundName(r.name) === n);
  if (exact) return String(exact.code);
  const tail = n.match(/[A-Za-z]$/);
  if (tail) {
    const same = list.filter((r) => {
      const rn = normalizeFundName(r.name);
      return /[A-Za-z]$/.test(rn) && rn.slice(-1).toLowerCase() === tail[0].toLowerCase();
    });
    if (same.length === 1) return String(same[0].code);
  }
  if (list.length === 1) return String(list[0].code);
  return null;
}

/** 从 fund_时间戳 形式的 id 提取创建日期（本地时区 YYYY-MM-DD）；无法解析返回 null */
export function creationDateFromId(id) {
  if (typeof id !== 'string' || !id.startsWith('fund_')) return null;
  const ts = Number(id.slice(5));
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 年化收益率（XIRR，不规则现金流，二分法求解）。
 * flows: [{ date: 'YYYY-MM-DD', amount: number }]，amount 正=流入（卖出/分红/期末市值）、负=流出（买入/期初本金）。
 * 在 (-0.9999, 10] 区间求 NPV=0；无解（全流入/全流出/数据不足）返回 null。
 */
export function computeXIRR(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;
  const items = flows
    .filter((f) => Number.isFinite(f.amount) && f.amount !== 0 && f.date)
    .map((f) => ({ t: new Date(f.date).getTime(), amount: f.amount }))
    .filter((f) => Number.isFinite(f.t) && f.amount !== 0);
  if (items.length < 2) return null;
  const t0 = Math.min(...items.map((i) => i.t));
  const npv = (r) =>
    items.reduce((s, i) => s + i.amount * Math.pow(1 + r, -(i.t - t0) / DAY_MS), 0);

  let lo = -0.9999;
  let hi = 10;
  let nLo = npv(lo);
  let nHi = npv(hi);
  if (!Number.isFinite(nLo) || !Number.isFinite(nHi) || nLo * nHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const nMid = npv(mid);
    if (Math.abs(nMid) < 1e-7) break;
    if (nLo * nMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      nLo = nMid;
    }
  }
  const r = (lo + hi) / 2;
  return Math.abs(r) < 1e-6 ? 0 : Math.round(r * 10000) / 10000;
}

/**
 * 单只基金的 XIRR 现金流（配合 computeXIRR）。
 * 快照基线本金：流出，日期取基金创建日（id 时间戳；无法解析则用最早交易日期，均无则省略基线）
 * 买入为流出；卖出按"当时成本价"收回为流入（与本金模型口径一致）；现金分红为流入；红利再投无现金流
 * 期末市值（state.holdAmount，行情或推演口径）为流入，日期取 endDate
 */
export function buildFundFlows(fund, state, endDate) {
  const flows = [];
  const txs = [...(fund.transactions || [])]
    .filter((tx) => tx.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  let shares = Number(fund.snapshot?.hold_shares) || 0;
  let invested = Number(fund.snapshot?.total_invested) || 0;
  let cost = shares > 0 ? invested / shares : 0;

  const baselineDate = creationDateFromId(fund.id) || txs[0]?.date || null;
  if (baselineDate && invested > 0) {
    flows.push({ date: baselineDate, amount: -invested });
  }

  for (const tx of txs) {
    if (tx.type === 'buy') {
      const amount = Number(tx.amount);
      const buyShares = Number(tx.shares);
      if (!Number.isFinite(amount) || !Number.isFinite(buyShares)) continue;
      invested += amount;
      shares += buyShares;
      cost = shares > 0 ? invested / shares : 0;
      flows.push({ date: tx.date, amount: -amount });
    } else if (tx.type === 'sell') {
      const sellShares = Number(tx.shares);
      if (!Number.isFinite(sellShares)) continue;
      const sellCost = sellShares * cost;
      invested -= sellCost;
      shares -= sellShares;
      flows.push({ date: tx.date, amount: sellCost });
    } else if (tx.type === 'dividend') {
      if (tx.method === 'reinvest') {
        const reShares = Number(tx.shares);
        if (!Number.isFinite(reShares)) continue;
        shares += reShares;
        cost = shares > 0 ? invested / shares : 0;
      } else {
        const cash = Number(tx.amount);
        if (Number.isFinite(cash)) flows.push({ date: tx.date, amount: cash });
      }
    }
  }

  const endValue = Number(state?.holdAmount);
  if (Number.isFinite(endValue) && endValue !== 0) {
    flows.push({ date: endDate, amount: endValue });
  }
  return flows;
}
