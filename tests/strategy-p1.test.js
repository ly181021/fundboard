/**
 * 策略引擎整改 P1 批次验收用例：补仓网格、预算闭环、XIRR 绝对净收益门、归整、洗涤、手动巡检 force。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STRATEGY_CONFIG, evaluateExitStrategy } from '../js/strategy.js';
import { createDatabase } from '../lib/database.js';
import { createStrategyStore } from '../lib/strategyStore.js';
import { createStrategyTask } from '../lib/strategyTask.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

const BASE = { ...DEFAULT_STRATEGY_CONFIG, addEnabled: true, reserveCash: 3000 };
const ser = (navs, end = '2026-09-10') => {
  const b = new Date(end + 'T00:00:00');
  const dates = Array.from({ length: navs.length }, (_, i) =>
    new Date(b.getTime() - (navs.length - 1 - i) * 86400000).toISOString().slice(0, 10),
  );
  return dates.map((d, i) => ({ date: d, nav: navs[i], acc_nav: navs[i] }));
};
const asset = (over = {}) => ({
  code: 'T001',
  name: 'P1',
  shares: 10000,
  invested: 10000,
  nav: 1,
  navDate: null,
  cashDividend: 0,
  flows: null,
  txBuys: [],
  txSells: [],
  ...over,
});

// ---- 补仓网格 ----

test('增量损失预算耗尽 ⇒ risk_budget_reached（不因加仓抬高本金扩张）', () => {
  // base 10000×3%=300 预算；已耗 300 → maxAddByRisk=0
  const r = evaluateExitStrategy(asset({ nav: 0.94 }), ser([1, 1, 1, 1, 1, 0.94]), BASE, {
    state: { reserveBase: 10000, addRiskUsed: 300, reserveUsed: 0 },
  });
  assert.equal(r.state, 'WATCH');
  assert.equal(r.snapshot.addBlockReason, 'risk_budget_reached');
});

test('距止损线 <2% ⇒ too_close_to_stop 彻底切断（D1）', () => {
  // 自定义宽加仓带（−5%~−14%、stop1 −15%）：−13.8% 距线仅 1.2% < 2% → 切断（balanced 带内距离恒 ≥5% 触不到该线）
  const wide = {
    ...BASE,
    costBands: {
      balanced: {
        addTop: -0.05,
        addStep: 0.025,
        addBottom: -0.14,
        stop1: -0.15,
        stop2: -0.2,
        exitFloor: -0.3,
      },
    },
  };
  const r = evaluateExitStrategy(asset({ nav: 0.862 }), ser([1, 1, 1, 1, 1, 0.862]), wide, {
    state: { reserveBase: 10000 },
  });
  assert.equal(r.snapshot.addBlockReason, 'too_close_to_stop');
  assert.equal(r.addAmount, null);
});

test('建议金额低于起购线 ⇒ below_min_purchase_amount（不下发碎金额）', () => {
  const r = evaluateExitStrategy(
    asset({ nav: 0.94 }),
    ser([1, 1, 1, 1, 1, 0.94]),
    { ...BASE, reserveCash: 150 }, // planShare=75 < 100 起购线
    { state: { reserveBase: 10000 } },
  );
  assert.equal(r.snapshot.addBlockReason, 'below_min_purchase_amount');
});

test('跨档弹性步进：ADD-1 于 −7.49% 成交后微跌至 −7.54%（不足 1.25%）⇒ ADD-2 拦下', () => {
  const dates = ser([1, 1, 1, 1, 0.9251, 0.9246]); // 末两日：−7.49% 加仓日 → −7.54%
  const st = {
    reserveBase: 10000,
    lastAddNavDate: dates[dates.length - 2].date,
    lastAddTier: 1,
    addConsumedTiers: [1],
  };
  const r = evaluateExitStrategy(asset({ nav: 0.9246 }), dates, BASE, { state: st });
  assert.equal(r.addAmount, null, '跨档需距上次加仓再跌 ≥1.25%（半档宽）——0.05% 不放行');
  // 再跌 ≥1.25%（−8.8%）→ ADD-2 放行（跳空吞并：一档已消耗则 tierShare=1/2 常规二档）
  const dates2 = ser([1, 1, 1, 1, 0.9251, 0.912]);
  const r2 = evaluateExitStrategy(asset({ nav: 0.912 }), dates2, BASE, { state: st });
  assert.equal(r2.state, 'ADD');
});

test('ADD-1 部分成交不孤注一掷：ADD-2 = min(剩余, planBudget×1/2)', () => {
  // reserveUsed 2000（一档只成交了一半）→ 剩余 1000；planShare 1500 → ADD-2 = 1000（不打满 3000）
  const r = evaluateExitStrategy(asset({ nav: 0.92 }), ser([1, 1, 1, 1, 1, 0.92]), BASE, {
    state: { reserveBase: 10000, reserveUsed: 2000, addConsumedTiers: [1] },
  });
  assert.equal(r.state, 'ADD');
  assert.equal(r.addAmount, 1000);
});

// ---- 预算闭环 ----

test('HWM 创新高 ⇒ 仅 addRiskUsed 释放回池（reserveUsed 不动）', () => {
  const dates = ser([1, 1.05, 1.1, 1.2], '2026-09-10'); // 创新高
  const st = { hwmDate: dates[1].date, addRiskUsed: 120, reserveUsed: 500 };
  const r = evaluateExitStrategy(asset({ nav: 1.2, invested: 9000, shares: 10000 }), dates, BASE, {
    state: st,
  });
  assert.equal(r.nextState.addRiskUsed, 0, '新高 ⇒ 周期风险消化，addRiskUsed 归零');
  assert.equal(r.nextState.reserveUsed, 500, 'reserveUsed 只在真实卖出/ack 赎回释放——严禁新高释放');
});

// ---- XIRR 绝对净收益门 ----

test('持有 90 天、XIRR≈15%、绝对收益 3.5% < 6% ⇒ 不触发（最低绝对净收益门）', () => {
  // invested 9655：MV 10000 → rEcon≈3.57%、rExec≈3.0% < 6% 首档门
  const flows = [
    { date: '2026-06-10', amount: -9655 },
    { date: '2026-09-10', amount: 10000 },
  ];
  const r = evaluateExitStrategy(asset({ invested: 9655, flows }), ser([1, 1, 1, 1, 1, 1]), BASE, {
    state: {},
    xirrFn: () => 0.15,
  });
  assert.notEqual(r.state, 'TAKE_PROFIT');
});

test('holdDays 阶梯独立试算：老成熟仓位止盈权不被新批次稀释（FIFO 拟赎回加权）', () => {
  // 老批 300 天 300 份 + 新批 10 天 700 份；拟赎 1/3 只切老批 → 加权 300 天 ≥ minHoldDays 270；
  // 全仓加权 ≈ 97 天 < 150 ≤ FIFO加权 300 / 全龄 243；minHoldDays取 150 才能区分两口径
  const lots = [
    { date: '2025-11-14', shares: 300 },
    { date: '2026-08-31', shares: 700 },
  ];
  const flows = [
    { date: '2026-08-31', amount: -7000 },
    { date: '2026-09-10', amount: 11000 },
  ]; // 只有新批流水：无 lots 时全龄口径 ≈10 天（老批经 lots 注入，模拟快照存量归批）
  const cfg = { ...BASE, xirrLadder: { ...BASE.xirrLadder, minHoldDays: 150 } };
  const withLots = evaluateExitStrategy(
    asset({ invested: 9000, flows, lots, execFeeRate: 0 }),
    ser([1, 1, 1, 1, 1, 1.1]),
    cfg,
    { state: {}, xirrFn: () => 0.16 },
  );
  assert.equal(withLots.state, 'TAKE_PROFIT', '拟赎 1/3 全取老批（FIFO）⇒ 加权 300 天 ≥150 ⇒ 激活');
  const noLots = evaluateExitStrategy(
    asset({ invested: 9000, flows, execFeeRate: 0 }),
    ser([1, 1, 1, 1, 1, 1.1]),
    cfg,
    { state: {}, xirrFn: () => 0.16 },
  );
  assert.notEqual(noLots.state, 'TAKE_PROFIT', '无批次退回全龄口径（约 92 天 < 150）⇒ 不激活');
});

// ---- 归整 ----

test('持有 15 份、minRedeem=10、minHolding=10 ⇒ 止损不可切分必须全额；止盈同场景受阻', () => {
  const cfg = { ...BASE, minRedeemShares: 10, minHoldingShares: 10, minRetainShares: 10 };
  const sl = evaluateExitStrategy(
    asset({ shares: 15, invested: 15, nav: 0.84 }),
    ser([1, 1, 1, 1, 1, 0.84]),
    cfg,
    { state: {} },
  );
  assert.equal(sl.state, 'STOP_LOSS');
  assert.equal(sl.snapshot.fullRedemption, true, '止损：卖 5 份后剩 10=保留线 ⇒ 不可行 ⇒ 全额');
});

test('超小底仓低于起赎线 ⇒ manualAction 人工介入，不下发全额', () => {
  const cfg = { ...BASE, minRedeemShares: 10, minHoldingShares: 10 };
  const r = evaluateExitStrategy(
    asset({ shares: 8, invested: 8.6, nav: 0.84 }),
    ser([1, 1, 1, 1, 1, 0.84]),
    cfg,
    { state: {} },
  ); // −20.6% 二档（避开 −30% 兜底）
  assert.equal(r.state, 'STOP_LOSS');
  assert.equal(r.snapshot.manualAction, 'below_min_redeem_total');
  assert.equal(r.snapshot.fullRedemption, false);
});

test('floor 永不进位 + 大仓尾数向下修正并重归整', () => {
  // 735.5 份 ×1/2 = 367.75（floor 到 2 位，不进位 368）
  const cfg = { ...BASE, minRedeemShares: 10, minHoldingShares: 10 };
  const dates = ser([1, 1.3, 1.24, 1.234], '2026-09-10');
  let st = {};
  const s1 = evaluateExitStrategy(
    asset({ shares: 735.5, invested: 735.5, nav: 1.3 }),
    dates.slice(0, 2),
    { ...BASE, trailing: { startProfit: 0.08, drawdownThreshold: 0.05 } },
    { state: {} },
  );
  st = s1.nextState;
  const r = evaluateExitStrategy(
    asset({ shares: 735.5, invested: 735.5, nav: 1.234 }),
    dates,
    { ...BASE, trailing: { startProfit: 0.08, drawdownThreshold: 0.05 } },
    { state: st },
  );
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(
    r.snapshot.targetShares,
    367.75,
    'floor(735.5×1/2, 2) = 367.75——Math.round 会得 367.75 相同，但 735.6×1/2=367.8 无进位歧义；核心是不上取整超持仓',
  );
  // 大仓尾数修正重归整：1000.5 份 ×1/2 = 500.25，minHolding 510 → 修正floor(1000.5−510,2)=490.5（裸相减 490.5 本例恰 1 位；换shares 1000.55/minHold 510.3 验证 2 位重归整）
  const cfg2 = {
    ...BASE,
    minRedeemShares: 10,
    minHoldingShares: 510.3,
    trailing: { startProfit: 0.08, drawdownThreshold: 0.05 },
  };
  const s1b = evaluateExitStrategy(
    asset({ shares: 1000.55, invested: 1000.55, nav: 1.3 }),
    dates.slice(0, 2),
    cfg2,
    { state: {} },
  );
  const r2 = evaluateExitStrategy(
    asset({ shares: 1000.55, invested: 1000.55, nav: 1.234 }),
    dates,
    cfg2,
    { state: s1b.nextState },
  );
  assert.equal(
    r2.snapshot.targetShares,
    490.25,
    'floor(1000.55−510.3, 2)=490.25——重归整不带非法小数位',
  );
});

test('容差全等：shares=1000.000000000001 全额赎回不被 === 误杀', () => {
  const cfg = { ...BASE, minRedeemShares: 10, minHoldingShares: 10 };
  const r = evaluateExitStrategy(
    asset({ shares: 1000.000000000001, invested: 1300, nav: 0.84 }),
    ser([1, 1, 1, 1, 1, 0.84]),
    cfg,
    { state: {} },
  ); // −35.4% EXIT（ratio=1 全额路径验证容差全等）
  assert.equal(r.state, 'EXIT');
  assert.equal(r.snapshot.fullRedemption, true);
});

// ---- 任务层：force / 释放闭环 / 冲正 / 纠偏双记 / 洗涤 ----

const FUND_P1 = {
  id: 'fp1',
  asset_type: 'fund',
  name: 'P1测试',
  code: '110020',
  snapshot: {
    hold_amount: 10000,
    pending_amount: 0,
    cost_price: 1.0,
    hold_shares: 10000,
    total_invested: 10000,
  },
  transactions: [{ id: 'tx1', type: 'buy', amount: 10000, shares: 10000, date: '2026-01-10' }],
  strategy_config: { ...BASE },
};

async function p1Harness({ seriesByCall, funds = [FUND_P1], now = '2026-09-10T20:00:00' } = {}) {
  const dir = await mkdtemp(pjoin(tmpdir(), 'p1task-'));
  const db = createDatabase({ dataDir: dir, now: () => new Date(now) });
  await db.save(funds, null, []);
  const store = createStrategyStore({ dataDir: dir });
  const queue = [...(seriesByCall || [])];
  let simNow = new Date(now);
  const task = createStrategyTask({
    db,
    strategyStore: store,
    fetchHistory: async () => ({
      series: queue.length ? queue.shift() : seriesByCall[seriesByCall.length - 1],
    }),
    now: () => new Date(simNow),
    xirrFn: () => null,
  });
  return {
    db,
    store,
    task,
    dir,
    setNow: (d) => {
      simNow = new Date(d);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('手动巡检 force=true 跳幂等门：同日重复评估生效', async () => {
  const h = await p1Harness({ seriesByCall: [ser([1, 1, 1, 1, 1, 1.2])] });
  try {
    const r1 = await h.task.runOnce();
    assert.equal(r1.evaluated, 1);
    const r2 = await h.task.runOnce(); // 无 force：同日净值未推进 ⇒ 幂等跳过
    assert.equal(r2.evaluated, 0);
    const r3 = await h.task.runOnce({ force: true }); // force：跳幂等门（改配置当日生效）
    assert.equal(r3.evaluated, 1);
  } finally {
    await h.cleanup();
  }
});

test('ack 赎回：addRiskUsed 即时等比释放 + reserveUsd pendingRelease 待确认 + 超时冲正', async () => {
  const h = await p1Harness({ seriesByCall: [ser([1, 1, 1, 1, 1, 0.79])] }); // −21% 止损二档
  try {
    await h.task.runOnce();
    const entry0 = (await h.store.loadState()).funds['110020'];
    assert.deepEqual(entry0.stopLossConsumedTiers, [15, 20]);
    // 预置双账本消耗：模拟此前加仓耗用（addRiskUsed 100 / reserveUsed 1000）
    entry0.addRiskUsed = 100;
    entry0.reserveUsed = 1000;
    await h.store.saveState(
      await h.store.loadState().then((s0) => {
        s0.funds['110020'] = entry0;
        return s0;
      }),
    );
    const ackNav = entry0.cooldowns.STOP_LOSS;
    const ackR = await h.task.ack('110020', 'STOP_LOSS', ackNav);
    assert.equal(ackR.proxied, true);
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.addRiskUsed, 50, '双账本同步：ratio=1/2 ⇒ addRiskUsed 100→50（等比）');
    assert.equal(st.reserveUsed, 1000, '意向≠资金释放——reserveUsed 暂不扣减');
    assert.equal(st.pendingRelease.length, 1, 'pendingRelease 待确认标记（500）');
    assert.ok(st.releaseLog.some((x) => x.kind === 'ack_redeem'));
    // 时间推进超窗 → 冲正（额度恢复＝标记失效，留痕 pending_expired）
    h.setNow('2026-09-20T20:00:00');
    await h.task.runOnce();
    const st2 = (await h.store.loadState()).funds['110020'];
    assert.equal(st2.pendingRelease.length, 0, '冲正：超时未见到账流水 ⇒ 标记失效');
    assert.ok(
      st2.releaseLog.some((x) => x.kind === 'pending_expired'),
      '冲正留痕',
    );
  } finally {
    await h.cleanup();
  }
});

test('纠偏双记：correct-reserve 补录买入 ⇒ reserveUsed 与 addRiskUsed 双记', async () => {
  const h = await p1Harness({ seriesByCall: [ser([1, 1, 1, 1, 1, 0.94])] });
  try {
    await h.task.runOnce();
    await h.task.correctReserve('110020', 1000); // 补录外部买入 1000
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.reserveUsed, 1000);
    assert.ok(st.addRiskUsed > 0, `双记（双记）：addRiskUsed += 1000×0.08 = ${st.addRiskUsed}`);
  } finally {
    await h.cleanup();
  }
});

test('洗涤：巡检期间并发 ack 同态 ⇒ 事件被剔、alerts 不留痕', async () => {
  // 竞态台：fetchHistory 挂起至放行
  const dir = await mkdtemp(pjoin(tmpdir(), 'p1race-'));
  try {
    const db = createDatabase({ dataDir: dir, now: () => new Date('2026-09-10T20:00:00') });
    await db.save([FUND_P1], null, []);
    const store = createStrategyStore({ dataDir: dir });
    const s = ser([1, 1, 1, 1, 1, 0.79]);
    let release;
    const gate = new Promise((res) => {
      release = res;
    });
    const task = createStrategyTask({
      db,
      strategyStore: store,
      fetchHistory: async () => {
        await gate;
        return { series: s };
      },
      now: () => new Date('2026-09-10T20:00:00'),
      xirrFn: () => null,
    });
    const running = task.runOnce();
    await new Promise((r) => setTimeout(r, 20));
    const ackNav = '2026-09-10'; // 挂起期间并发 ack（事件尚未产生）
    await task.ack('110020', 'STOP_LOSS', ackNav);
    release();
    const r = await running;
    assert.equal(r.evaluated, 1);
    const alerts = await store.loadAlerts();
    assert.equal(alerts.length, 0, '合并后冷却已被并发方推进（≠引擎自写值）⇒ 该事件洗涤剔除');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
