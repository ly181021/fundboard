/**
 * 核算四口径 + FIFO 批次服务 + D_pool 分红池（全系统唯一来源，引擎/回测/UI 消费）。
 *   R_book = (MV − C) / C                       账面浮盈（仅展示）
 *   R_econ = (MV + D_pool + ΣD_pending − C) / C 经济收益率（成本分区/盈利门）
 *   R_exec = R_econ − feeAmount / (C × ratio)   赎回决策门（部分赎回按被赎回资本基数折算摩擦）
 *   D_price = (HWM_adj − adjNav) / HWM_adj      价格回撤（复权序列，引擎侧取值）
 * FIFO 批次服务一份实现三处消费：holdDays 加权 / feeFIFO 费率 / D_pool 扣减。
 * 纯函数、依赖全注入。
 */
import { parseISODate } from './analysis.js';

const DAY_MS = 86400000;
const EPS = 1e-4; // 单批剩余碎份额截断阈值（浮点防护）

const daysBetween = (a, b) => Math.round((parseISODate(b) - parseISODate(a)) / DAY_MS);

/**
 * FIFO 批次回放：买入入队（快照存量归批到建仓日，导入/缺早期流水的兜底）；
 * 赎回自队首 FIFO 消耗；单批剩余 < 1e-4 强制出队归零。
 * @param {object} p { snapshot, transactions }
 * @returns {Array<{date: string, shares: number}>} 剩余批次（升序，仅存活批次）
 */
export function buildFifoLots({ snapshot, transactions }) {
  const lots = [];
  const baseline = Number(snapshot?.hold_shares) || 0;
  if (baseline > 0) {
    // 快照存量归批到建仓日：优先快照创建日，缺则最早流水日（保守长持有兜底）
    const dates = (transactions || [])
      .map((t) => t?.date)
      .filter(Boolean)
      .sort();
    lots.push({ date: snapshot?.created ?? dates[0] ?? null, shares: baseline });
  }
  const sorted = [...(transactions || [])].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  for (const tx of sorted) {
    if (!tx?.date || !tx.type) continue;
    if (tx.type === 'buy' || (tx.type === 'dividend' && tx.method === 'reinvest')) {
      const sh = Number(tx.shares) || 0;
      if (sh > 0) lots.push({ date: tx.date, shares: sh });
    } else if (tx.type === 'sell') {
      let remain = Number(tx.shares) || 0;
      // lotHint（渠道指定份额/人工纠偏声明）是唯一例外：按指定批次扣（后续 Lot 账本接入）
      while (remain > EPS && lots.length) {
        const head = lots[0];
        const take = Math.min(head.shares, remain);
        head.shares -= take;
        remain -= take;
        if (head.shares <= EPS) lots.shift();
      }
    }
  }
  return lots.filter((l) => l.shares > EPS && l.date);
}

/**
 * 全仓加权持有期（天）：Σ(份额×持有天数) ÷ Σ份额；空仓短路 0（不产 NaN）。
 * @param {Array} lots FIFO 批次
 * @param {string} asOf 截止日
 * @returns {number} 加权持有天数
 */
export function holdDaysWeighted(lots, asOf) {
  const total = (lots || []).reduce((s, l) => s + l.shares, 0);
  if (!(total > 0)) return 0;
  const acc = (lots || []).reduce(
    (s, l) => s + l.shares * Math.max(0, daysBetween(l.date, asOf)),
    0,
  );
  return acc / total;
}

/**
 * 阶梯独立试算：按候选档 targetRatio 虚拟 FIFO 切片，只对"将被卖出的批次"加权；
 * 各档各自试算，判定与份额互不前置。
 * @param {Array} lots FIFO 批次
 * @param {number} ratio 候选档拟赎回比例
 * @param {string} asOf 截止日
 * @returns {number} 拟赎回批次的加权持有天数
 */
export function tierHoldDays(lots, ratio, asOf) {
  const total = (lots || []).reduce((s, l) => s + l.shares, 0);
  if (!(total > 0) || !(ratio > 0)) return 0;
  let need = total * Math.min(ratio, 1);
  let acc = 0,
    got = 0;
  for (const l of lots) {
    if (need <= EPS) break;
    const take = Math.min(l.shares, need);
    acc += take * Math.max(0, daysBetween(l.date, asOf));
    got += take;
    need -= take;
  }
  return got > 0 ? acc / got : 0;
}

/**
 * feeFIFO 费率：按将被卖出份额覆盖的全部批次加权；
 * 各批按自身持有期查 redemptionFeeTiers（minDays 降序取首个满足档），仅查队首会漏算短期惩罚批次。
 * @param {object} p { lots, sharesToSell, asOf, feeTiers }
 * @returns {number} 加权费率
 */
export function feeFifoRate({ lots, sharesToSell, asOf, feeTiers }) {
  const sortedTiers = [...(feeTiers || [])].sort((a, b) => (b.minDays ?? 0) - (a.minDays ?? 0));
  const rateOf = (days) => {
    for (const t of sortedTiers) if (days >= (t.minDays ?? 0)) return t.rate ?? 0;
    return sortedTiers.length ? (sortedTiers[sortedTiers.length - 1].rate ?? 0) : 0;
  };
  let remain = Number(sharesToSell) || 0;
  let acc = 0,
    got = 0;
  for (const l of lots || []) {
    if (remain <= EPS) break;
    const take = Math.min(l.shares, remain);
    acc += take * rateOf(Math.max(0, daysBetween(l.date, asOf)));
    got += take;
    remain -= take;
  }
  return got > 0 ? acc / got : 0;
}

/**
 * D_pool 分红池动态推导（不持久化，回放流水恒与账本一致）。
 * 现金分红入池；红利再投资不入池（份额侧体现，防双重虚增）；
 * 赎回按当次份额占比扣减（批次感知扣减随 Lot 账本精确化）；
 * 回放遇份额归零即截断（新仓不继承孤儿分红）；
 * 在途补偿 D_pending：除息日至到账窗口内把"已除息未到账"计入分子，
 *   超窗自动失效并给「分红待记账」提示（不长期挂账）。
 * @param {Array} transactions 交易流水
 * @param {object} opts { snapshot, navDate, exDividends, holdShares, arrivalWindowDays }
 * @returns {object} { pool, pending, pendingTotal, todoNote }
 */
export function computeDPool(
  transactions,
  { snapshot, navDate, exDividends = [], holdShares = null, arrivalWindowDays = 5 } = {},
) {
  const txs = [...(transactions || [])].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  let shares = Number(snapshot?.hold_shares) || 0;
  let pool = 0;
  for (const tx of txs) {
    if (!tx?.date || !tx.type) continue;
    if (tx.type === 'dividend' && tx.method !== 'reinvest') {
      pool += Number(tx.amount) || 0; // 现金分红入池（买入不增池）
    } else if (tx.type === 'buy' || (tx.type === 'dividend' && tx.method === 'reinvest')) {
      shares += Number(tx.shares) || 0; // 不增池：只抬市值与成本分母
    } else if (tx.type === 'sell') {
      const sh = Number(tx.shares) || 0;
      const before = shares;
      shares -= sh;
      if (before > 0 && sh > 0) pool = Math.max(0, pool * Math.max(0, (before - sh) / before)); // 等比扣减 + 非负钳制
      if (shares <= EPS) pool = 0; // 清仓截断：孤儿分红不跨仓位存活
    }
  }
  // 在途补偿：除息事件在窗口内且无对应现金分红流水 ⇒ pending；到账（流水已入池）或超窗 ⇒ 不计
  const cashDates = new Set(
    txs.filter((t) => t.type === 'dividend' && t.method !== 'reinvest').map((t) => t.date),
  );
  const pending = [];
  let todoNote = null;
  for (const ex of exDividends || []) {
    if (!ex?.date || cashDates.has(ex.date)) continue; // 已到账（入池与清 pending 原子，同一轮只计一次）
    const span = daysBetween(ex.date, navDate);
    if (span < 0) continue;
    if (span <= arrivalWindowDays)
      pending.push({
        exDate: ex.date,
        perShare: ex.perShare,
        amount: (holdShares ?? shares) * ex.perShare,
      });
    else
      todoNote = `分红待记账：${ex.date} 除息 ${span} 天未见到账流水——请核对交易记录（超窗补偿已失效）`;
  }
  const pendingTotal = pending.reduce((s, p) => s + p.amount, 0);
  return { pool: Math.round(pool * 100) / 100, pending, pendingTotal, todoNote };
}

/**
 * 四口径计算（全系统唯一来源，禁止在各处重算）。
 * @param {object} p { mv, cost, dPool, pendingTotal, feeAmount, ratio }
 * @returns {object} { rBook, rEcon, rExec }
 */
export function riskMetrics({ mv, cost, dPool = 0, pendingTotal = 0, feeAmount = 0, ratio = 1 }) {
  const C = cost > 0 ? cost : 1; // 防御：C≤0 时按 1 计（上游已闸 invested>0）
  const rBook = (mv - cost) / C;
  const rEcon = (mv + dPool + pendingTotal - cost) / C;
  const denom = C * (ratio > 0 ? ratio : 1);
  const rExec = rEcon - feeAmount / denom; // 动作边际口径（ratio=1 时退化 /C）
  return { rBook, rEcon, rExec };
}
