/**
 * Lot账本：批次核销（FIFO核销，口径一）。
 * 纯函数，快照+流水回放推导，不持久化，防止与db.json修正数据撕裂。
 * 核销结果返回新Lot数组；lotId由sourceTxId派生，多次重建保持稳定。
 *
 * 批次字段：lotId / buyDate / sharesRemaining / costRemaining / adjustedNavAtBuy / sourceTxId；
 * ADD批次附带addAmount / addRiskConsumed，作为释放精确化标记。
 *
 * 释放精确化：赎回按法定FIFO队首消耗，**仅释放被消耗ADD批次的预算占用**；
 * 赎回未碰到ADD批次则零释放。等比释放会引发bug：卖老底仓但ADD不动时误释放；ADD先卖出时释放不足。
 *
 * Lot输出用于summarize判定「是否仍有盈利底仓」，不可替代基金级复权NAV的HWM。
 */
const EPS = 1e-4; // 浮点碎份额截断（与 riskMetrics 同阈值）
const RISK_FLOOR = 0.08; // 分母底线（归因批次的增量损失消耗按保守底线计，与 correct-reserve 双记同口径）

/**
 * 回放建账。
 * @param {object} p
 * @param {object} p.snapshot 基线快照（hold_shares/total_invested/created）
 * @param {Array} p.transactions 交易流水（buy/sell/dividend{reinvest}）
 * @param {Array} [p.addAttribution] ADD 归因买入标注 [{txId, amount}]，由任务层按归因窗口
 *   （reserveUsedAsOf 锚后、封顶 reserveUsed）从 txBuys 中归集；命中批次的 lot 附预算标注
 * @param {number} [p.stopAtTxId] 建账止于该流水之前（对账核销用：还原卖出前账面）
 */
export function buildLotLedger({ snapshot, transactions, addAttribution = [], stopAtTxId = null }) {
  const addByTx = new Map((addAttribution || []).map((a) => [a.txId, a.amount]));
  const lots = [];
  const baseline = Number(snapshot?.hold_shares) || 0;
  if (baseline > 0) {
    const dates = (transactions || [])
      .map((t) => t?.date)
      .filter(Boolean)
      .sort();
    lots.push({
      lotId: 'baseline',
      buyDate: snapshot?.created ?? dates[0] ?? null,
      sharesRemaining: baseline,
      costRemaining: Number(snapshot?.total_invested) || 0,
      adjustedNavAtBuy: baseline > 0 ? (Number(snapshot?.total_invested) || 0) / baseline : 0,
      sourceTxId: null,
      addAmount: 0,
      addRiskConsumed: 0,
    });
  }
  const sorted = [...(transactions || [])].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  for (const tx of sorted) {
    if (!tx?.date || !tx.type) continue;
    if (stopAtTxId != null && tx.id === stopAtTxId) break; // 对账核销：还原该笔卖出前的账面
    if (tx.type === 'buy' || (tx.type === 'dividend' && tx.method === 'reinvest')) {
      const sh = Number(tx.shares) || 0;
      if (sh > 0) {
        const amt = Number(tx.amount) || 0;
        const addAmt = addByTx.has(tx.id) ? Math.min(addByTx.get(tx.id), amt) : 0;
        lots.push({
          lotId: `tx:${tx.id ?? tx.date}`,
          buyDate: tx.date,
          sharesRemaining: sh,
          costRemaining: amt,
          adjustedNavAtBuy: sh > 0 ? amt / sh : 0,
          sourceTxId: tx.id ?? null,
          addAmount: addAmt,
          addRiskConsumed: Math.round(addAmt * RISK_FLOOR * 100) / 100,
        });
      }
    } else if (tx.type === 'sell') {
      consumeFifoInPlace(lots, Number(tx.shares) || 0);
    }
  }
  return lots.filter((l) => l.sharesRemaining > EPS);
}

/** 原地 FIFO 消耗（内部用）——返回消耗明细 */
function consumeFifoInPlace(lots, shares) {
  const consumed = [];
  let remain = shares;
  while (remain > EPS && lots.length) {
    const head = lots[0];
    const take = Math.min(head.sharesRemaining, remain);
    const frac = take / head.sharesRemaining;
    consumed.push({
      lotId: head.lotId,
      buyDate: head.buyDate,
      shares: Math.round(take * 1e6) / 1e6,
      cost: Math.round(head.costRemaining * frac * 100) / 100,
      addAmount: Math.round(head.addAmount * frac * 100) / 100,
      addRiskConsumed: Math.round(head.addRiskConsumed * frac * 100) / 100,
    });
    head.sharesRemaining -= take;
    head.costRemaining = Math.max(
      0,
      Math.round((head.costRemaining - consumed[consumed.length - 1].cost) * 100) / 100,
    );
    head.addAmount = Math.max(
      0,
      Math.round((head.addAmount - consumed[consumed.length - 1].addAmount) * 100) / 100,
    );
    head.addRiskConsumed = Math.max(
      0,
      Math.round((head.addRiskConsumed - consumed[consumed.length - 1].addRiskConsumed) * 100) /
        100,
    );
    remain -= take;
    if (head.sharesRemaining <= EPS) lots.shift();
  }
  return consumed;
}

/**
 * FIFO 核销（纯函数形态）：不改动入参，返回 { consumed, lots }（写回后的新账本）。
 */
export function consumeFifo(lots, shares) {
  const copy = (lots || []).map((l) => ({ ...l }));
  const consumed = consumeFifoInPlace(copy, shares);
  return { consumed, lots: copy.filter((l) => l.sharesRemaining > EPS) };
}

/** 释放路径 精确化：按实际消耗的 ADD 批次释放两账本（零标注消耗 ⇒ 零释放） */
export function releaseFromConsumption(consumed) {
  const addRiskRelease =
    Math.round((consumed || []).reduce((s, c) => s + c.addRiskConsumed, 0) * 100) / 100;
  const reserveRelease =
    Math.round((consumed || []).reduce((s, c) => s + c.addAmount, 0) * 100) / 100;
  return { addRiskRelease, reserveRelease };
}

/** Lot 摘要："是否仍有盈利底仓"（成本价 < 现净值 的存活批次）——只作展示判定，不替代 HWM */
export function summarizeLots(lots, nav) {
  const alive = (lots || []).filter((l) => l.sharesRemaining > EPS);
  const totalShares = alive.reduce((s, l) => s + l.sharesRemaining, 0);
  const costBasis = Math.round(alive.reduce((s, l) => s + l.costRemaining, 0) * 100) / 100;
  const profitable =
    nav != null && nav > 0
      ? alive.filter((l) => l.adjustedNavAtBuy > 0 && nav > l.adjustedNavAtBuy)
      : [];
  return {
    lotCount: alive.length,
    totalShares: Math.round(totalShares * 100) / 100,
    costBasis,
    profitableBaseLots: profitable.length, // 盈利底仓批次数（底仓峰值利润仍以 HWM 为准）
    addLotsRemaining: alive.filter((l) => l.addAmount > 0).length, // 尚有预算占用的 ADD 批次
  };
}
