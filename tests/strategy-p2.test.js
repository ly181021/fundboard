/**
 * 策略引擎整改 P2 批次验收用例（Lot 账本：FIFO 核销定一，释放精确化）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLotLedger,
  consumeFifo,
  releaseFromConsumption,
  summarizeLots,
} from '../js/lotLedger.js';
import { createDatabase } from '../lib/database.js';
import { createStrategyStore } from '../lib/strategyStore.js';
import { createStrategyTask } from '../lib/strategyTask.js';
import { DEFAULT_STRATEGY_CONFIG } from '../js/strategy.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

test('建账与 FIFO 核销写回：lotId 稳定、sharesRemaining/costRemaining 递减、碎份额出队', () => {
  const ledger = buildLotLedger({
    snapshot: { hold_shares: 0, total_invested: 0 },
    transactions: [
      { id: 'b1', type: 'buy', date: '2026-01-10', amount: 1000, shares: 1000 },
      { id: 'b2', type: 'buy', date: '2026-06-01', amount: 500, shares: 400 },
    ],
  });
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].lotId, 'tx:b1');
  assert.equal(ledger[0].adjustedNavAtBuy, 1.0);
  const { consumed, lots } = consumeFifo(ledger, 1200); // 吃穿 b1 + b2 的 200
  assert.equal(consumed.length, 2);
  assert.equal(consumed[0].lotId, 'tx:b1');
  assert.equal(consumed[0].shares, 1000);
  assert.equal(lots.length, 1, 'b1 归零出队，b2 剩 200');
  assert.equal(Math.round(lots[0].sharesRemaining), 200);
  assert.equal(Math.round(lots[0].costRemaining), 250, '成本按比例核销 500×(200/400)');
  assert.equal(ledger[0].sharesRemaining, 1000, '纯函数：入参账本不被改动');
});

test('释放路径①精确化：未触及 ADD 批次 ⇒ 零释放；吃穿 ADD 批次 ⇒ 精确释放其占用', () => {
  const ledger = buildLotLedger({
    snapshot: { hold_shares: 0, total_invested: 0 },
    transactions: [
      { id: 'base', type: 'buy', date: '2025-01-10', amount: 10000, shares: 10000 },
      { id: 'add1', type: 'buy', date: '2026-06-01', amount: 500, shares: 500 },
    ],
    addAttribution: [{ txId: 'add1', amount: 500 }],
  });
  // 赎回 2000 份（FIFO 队首=老底仓，未触及 ADD 批）→ 零释放
  const r1 = releaseFromConsumption(consumeFifo(ledger, 2000).consumed);
  assert.equal(r1.addRiskRelease, 0);
  assert.equal(r1.reserveRelease, 0, '卖老底仓不动 ADD 预算——P1 等比释放会错误释放 10%');
  // 赎回 10500 份（吃穿整个 ADD 批）→ 精确释放 500 + 500×8%
  const r2 = releaseFromConsumption(consumeFifo(ledger, 10500).consumed);
  assert.equal(r2.reserveRelease, 500);
  assert.equal(
    r2.addRiskRelease,
    40,
    'addRiskConsumed = 500×0.08（D1 底线口径同 correct-reserve）',
  );
  // 部分吃 ADD 批（10250 份：消耗 ADD 批 250/500）→ 按比例精确释放 250
  const r3 = releaseFromConsumption(consumeFifo(ledger, 10250).consumed);
  assert.equal(r3.reserveRelease, 250);
});

test('stopAtTxId 还原卖出前账面（对账核销：该笔卖出本身未入账）', () => {
  const ledger = buildLotLedger({
    snapshot: { hold_shares: 0, total_invested: 0 },
    transactions: [
      { id: 'b1', type: 'buy', date: '2026-01-10', amount: 1000, shares: 1000 },
      { id: 's1', type: 'sell', date: '2026-09-10', shares: 600 },
    ],
    stopAtTxId: 's1',
  });
  assert.equal(
    Math.round(ledger[0].sharesRemaining),
    1000,
    '还原卖出前账面——再对 600 份核销即得本次消耗',
  );
});

test('底仓摘要：盈利底仓判定（成本价 vs 现净值）——不替代 HWM', () => {
  const ledger = buildLotLedger({
    snapshot: { hold_shares: 0, total_invested: 0 },
    transactions: [
      { id: 'old', type: 'buy', date: '2025-01-10', amount: 1000, shares: 1000 }, // 成本 1.0
      { id: 'new', type: 'buy', date: '2026-08-01', amount: 1200, shares: 1000 }, // 成本 1.2
      { id: 'add1', type: 'buy', date: '2026-06-01', amount: 600, shares: 500 }, // 成本 1.2（标注封顶 500）
    ],
    addAttribution: [{ txId: 'add1', amount: 500 }],
  });
  const sum = summarizeLots(ledger, 1.1); // 现净值 1.1
  assert.equal(sum.lotCount, 3);
  assert.equal(sum.profitableBaseLots, 1, '只有成本 1.0 的老批盈利（两个 1.2 批都亏）');
  assert.equal(sum.addLotsRemaining, 1);
  assert.ok(Math.abs(sum.costBasis - 2800) < 1e-6); // 1000+1200+600
});

// ---- 任务层端到端：ADD 归因标注 → 卖出对账批次核销 ----

test('Lot 账本端到端：归因买入建标注批次，卖出对账按批次精确核销（lot_write_off 凭证）', async () => {
  const FUND = {
    id: 'fp2',
    asset_type: 'fund',
    name: 'P2测试',
    code: '110020',
    snapshot: {
      hold_amount: 10000,
      pending_amount: 0,
      cost_price: 1.0,
      hold_shares: 10000,
      total_invested: 10000,
    },
    transactions: [
      { id: 'addbuy', type: 'buy', amount: 500, shares: 500, date: '2026-08-20' }, // ADD 归因买入（基线=快照存量，不再重复买）
      { id: 'sellout', type: 'sell', shares: 6000, date: '2026-09-09' }, // FIFO：全吃老底仓
    ],
    strategy_config: { ...DEFAULT_STRATEGY_CONFIG },
  };
  const dir = await mkdtemp(pjoin(tmpdir(), 'p2task-'));
  try {
    const db = createDatabase({ dataDir: dir, now: () => new Date('2026-09-10T20:00:00') });
    await db.save([FUND], null, []);
    const store = createStrategyStore({ dataDir: dir });
    // 预置：reserveUsed 500（归因已计）、reserveUsedAsOf 在 addbuy 前
    const st0 = await store.loadState();
    st0.funds['110020'] = {
      ...st0.funds['110020'],
      reserveUsed: 500,
      reserveUsedAsOf: '2026-08-01',
      addRiskUsed: 40,
      cooldowns: { STOP_LOSS: '2026-09-01' },
      posShares: 10500,
      posInvested: 10500,
      sellAttributionAsOf: '2026-08-01',
      sellExec: null,
    }; // 预置止损事件冷却 + 卖出前仓位指纹（归因窗口成立）
    await store.saveState(st0);
    const b = new Date('2026-09-10T00:00:00');
    const dates = Array.from({ length: 6 }, (_, i) =>
      new Date(b.getTime() - (5 - i) * 86400000).toISOString().slice(0, 10),
    );
    const s = dates.map((d, i) => ({
      date: d,
      nav: [1, 1, 1, 1, 1, 0.79][i],
      acc_nav: [1, 1, 1, 1, 1, 0.79][i],
    }));
    const task = createStrategyTask({
      db,
      strategyStore: store,
      fetchHistory: async () => ({ series: s }),
      now: () => new Date('2026-09-10T20:00:00'),
      xirrFn: () => null,
    });
    await task.runOnce();
    const st = (await store.loadState()).funds['110020'];
    // 卖出 6000 份全部来自老底仓（FIFO）→ ADD 批未动 → 双账本零释放
    assert.equal(
      st.addRiskUsed,
      40,
      'P2 精确核销：卖老底仓不释放 ADD 风险预算（P1 等比会按 6000/10500≈57% 误放）',
    );
    assert.equal(st.reserveUsed, 500);
    const rel = (st.releaseLog || []).find(
      (x) => x.kind === 'lot_write_off' || x.kind === 'sell_flow',
    );
    assert.ok(rel, '卖出对账凭证在位');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
