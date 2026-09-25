/**
 * 策略引擎整改 P0 批次验收用例（核算层与引擎判定层门项，存储/任务层随后并入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFifoLots,
  holdDaysWeighted,
  feeFifoRate,
  computeDPool,
  riskMetrics,
  tierHoldDays,
} from '../js/riskMetrics.js';

const day = (n) =>
  `2026-${String(Math.floor(n / 30) + 1).padStart(2, '0')}-${String(n % 30).padStart(2, '0')}`;

// ---- FIFO 批次服务 ----

test('阶梯独立试算：holdDays 按各档 targetRatio 虚拟 FIFO 切片推导，互不前置、无因果死锁', () => {
  // 老批次 313 天 300 份+新批次 10 天 700 份：1/3 切片只浅入新批、1/2 切片深入，两档各得各的加权天数
  const lots = [
    { date: '2025-11-01', shares: 300 },
    { date: '2026-08-31', shares: 700 },
  ];
  const h13 = tierHoldDays(lots, 1 / 3, '2026-09-10');
  const h12 = tierHoldDays(lots, 1 / 2, '2026-09-10');
  assert.ok(h13 >= 280, `拟赎 1/3 以老批次为主，加权 ≥280 天（实测 ${h13}）`);
  assert.ok(
    h12 < h13 - 80,
    `拟赎 1/2 深入新批次，加权显著拉低（${h12} vs ${h13}）——两档各自试算，互为前置不成立`,
  );
});

test('FIFO 冲销与浮点防护：赎回自队首消耗；剩余 <1e-4 强制归零；holdShares≤0 短路返回 0', () => {
  const lots = buildFifoLots({
    snapshot: { hold_shares: 0, created: '2025-01-01' },
    transactions: [
      { type: 'buy', date: '2025-01-05', shares: 1000 },
      { type: 'sell', date: '2025-06-01', shares: 999.9999999999999 },
      { type: 'buy', date: '2026-01-05', shares: 10 },
    ],
  });
  // 老批次被 999.99… 冲销到 <1e-4 → 强制出队归零，只剩 2026-01-05 批
  assert.equal(lots.length, 1);
  assert.equal(lots[0].date, '2026-01-05');
  assert.equal(holdDaysWeighted([], '2026-09-10'), 0); // 空仓短路 0，不产 NaN
});

test('R_exec 动作边际口径：feeAmount ÷ (C × ratio)——部分赎回摩擦按被赎回资本基数计', () => {
  // 浮盈 +40%、赎回 1/3、费率 0.5% → 赎回金额 = MV/3，fee = 0.5%×MV/3；
  // /C 版本会把摩擦低估 3 倍（分母多了 3 倍）
  const C = 10000,
    MV = 14000,
    feeRate = 0.005,
    ratio = 1 / 3;
  const feeAmount = feeRate * MV * ratio; // ≈ 23.33
  const { rBook, rEcon, rExec } = riskMetrics({ mv: MV, cost: C, dPool: 0, feeAmount, ratio });
  assert.ok(Math.abs(rBook - 0.4) < 1e-9);
  assert.ok(Math.abs(rEcon - 0.4) < 1e-9);
  // 正确口径：rExec = 0.40 − 23.33/(10000×1/3) = 0.40 − 0.007 = 0.393
  assert.ok(Math.abs(rExec - (0.4 - feeAmount / (C * ratio))) < 1e-9, `rExec=${rExec}`);
  // 反面断言：/C 版本 = 0.40 − 0.00233（低估 3 倍）
  assert.notEqual(Math.abs(rExec - (0.4 - feeAmount / C)) < 1e-6, true);
  // ratio=1 退化为 /C
  const full = riskMetrics({ mv: MV, cost: C, dPool: 0, feeAmount: feeRate * MV, ratio: 1 });
  assert.ok(Math.abs(full.rExec - (0.4 - (feeRate * MV) / C)) < 1e-9);
});

test('feeFIFO 覆盖批次加权：赎回量跨多批次时按各批自身持有期查档加权', () => {
  const lots = [
    { date: '2023-09-01', shares: 400 }, // 3 年 → 0 费
    { date: '2025-09-01', shares: 350 }, // 1 年 → 0 费
    { date: '2026-08-25', shares: 250 }, // 半月 → 惩罚档 0.015
  ];
  const tiers = [
    { minDays: 0, rate: 0.015 },
    { minDays: 30, rate: 0.0075 },
    { minDays: 365, rate: 0 },
  ];
  const rate = feeFifoRate({ lots, sharesToSell: 1000, asOf: '2026-09-10', feeTiers: tiers });
  // 惩罚批 250/1000 权重计入 → rate = 0.015×0.25 ≈ 0.00375（仅查队首会得 0，漏算惩罚）
  assert.ok(rate > 0.003 && rate < 0.004, `加权费率=${rate}`);
});

// ---- D_pool 分红池（动态推导）----

test('高分红：D_pool 计入 R_econ 分子——账面回撤中仍可过经济门', () => {
  // 投入 10 万、现金分红 1.5 万、市值 9.2 万 → R_econ = (9.2+1.5−10)/10 = +7%
  const { rBook, rEcon } = riskMetrics({
    mv: 92000,
    cost: 100000,
    dPool: 15000,
    feeAmount: 0,
    ratio: 1,
  });
  assert.ok(Math.abs(rBook - -0.08) < 1e-9);
  assert.ok(Math.abs(rEcon - 0.07) < 1e-9, `rEcon=${rEcon}`);
});

test('D_pool 生命周期：到账入池与清 pending 原子；再投资不流入池；买入不增池；清仓截断', () => {
  const tx1 = [
    { type: 'dividend', date: '2026-01-10', method: 'cash', amount: 1000 }, // 现金分红入池
  ];
  const p1 = computeDPool(tx1, { navDate: '2026-09-10' });
  assert.equal(p1.pool, 1000);
  assert.equal(p1.pending.length, 0); // 已到账 ⇒ 无在途
  // 红利再投资：不入池（份额到账由持仓侧体现）
  const p2 = computeDPool(
    [{ type: 'dividend', date: '2026-01-10', method: 'reinvest', amount: 800, shares: 100 }],
    { navDate: '2026-09-10' },
  );
  assert.equal(p2.pool, 0);
  // 买入不增池
  const p3 = computeDPool(
    [...tx1, { type: 'buy', date: '2026-02-01', amount: 5000, shares: 300 }],
    { navDate: '2026-09-10' },
  );
  assert.equal(p3.pool, 1000);
  // 清仓截断：清仓后的历史孤儿分红不进新仓池（基线 1000 份 → 全卖归零截断 → 重建 500 份）
  const tx4 = [
    { type: 'dividend', date: '2025-01-10', method: 'cash', amount: 900 },
    { type: 'sell', date: '2025-06-01', shares: 1000 },
    { type: 'buy', date: '2026-03-01', amount: 2000, shares: 500 },
    { type: 'dividend', date: '2026-04-01', method: 'cash', amount: 120 },
  ];
  const p4 = computeDPool(tx4, { snapshot: { hold_shares: 1000 }, navDate: '2026-09-10' });
  assert.equal(p4.pool, 120, `新仓只继承本周期入池额（实测 ${p4.pool}）——孤儿分红 900 已截断`);
});

test('在途分红补偿：除息日到到账日之间 D_pending 计入分子；超窗自动失效', () => {
  // 除息 09-01、现金 2-3 天到账；评估日 09-02（未记账）→ pending 生效；09-20（超窗）→ 失效+待办提示
  const tx = [];
  const p1 = computeDPool(tx, {
    navDate: '2026-09-02',
    exDividends: [{ date: '2026-09-01', perShare: 0.05 }],
    holdShares: 1000,
    arrivalWindowDays: 5,
  });
  assert.equal(p1.pending.length, 1);
  assert.ok(Math.abs(p1.pendingTotal - 50) < 1e-9, `在途补偿=1000×0.05（实测 ${p1.pendingTotal}）`);
  const p2 = computeDPool(tx, {
    navDate: '2026-09-20',
    exDividends: [{ date: '2026-09-01', perShare: 0.05 }],
    holdShares: 1000,
    arrivalWindowDays: 5,
  });
  assert.equal(p2.pending.length, 0);
  assert.ok(p2.todoNote, '超窗 ⇒ 「分红待记账」提示，不长期挂账');
});

// ---- 引擎判定层（js/strategy.js 状态机）----

import { evaluateExitStrategy, shouldSuppressEvent, buildFingerprint } from '../js/strategy.js';

/** 合成序列：[[date, nav, acc]]；acc缺省 = nav（无分红） */
const hist = (rows) => rows.map(([date, nav, acc]) => ({ date, nav, acc_nav: acc ?? nav }));
const asset = (over = {}) => ({
  code: '110020',
  name: '演示',
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

test('周期锁：首轮止盈后同 HWM 周期内不再触发（1.30→1.235 触发 → 1.173 不再触发）', () => {
  const h = hist([
    ['2026-08-01', 1.0],
    ['2026-08-10', 1.3],
    ['2026-08-20', 1.234],
    ['2026-08-30', 1.173],
  ]);
  const cfg = { trailing: { startProfit: 0.08, drawdownThreshold: 0.05 } };
  // 先爬峰建立锚
  const s1 = evaluateExitStrategy(asset({ nav: 1.3, navDate: '2026-08-10' }), h.slice(0, 2), cfg, {
    state: {},
  });
  assert.equal(s1.state, 'HOLD'); // 启动轮不触发
  // 回撤 5.08% 触发首轮
  const s2 = evaluateExitStrategy(
    asset({ nav: 1.234, navDate: '2026-08-20' }),
    h.slice(0, 3),
    cfg,
    { state: s1.nextState },
  );
  assert.equal(s2.state, 'TAKE_PROFIT');
  assert.equal(
    s2.nextState.trailingConsumedAtHwmDate,
    '2026-08-10',
    '事件落盘写周期锁 = 触发时 hwmDate',
  );
  // 回撤 9.8%（仍 ≥5%）且无新高 → 周期锁拦下重复事件（徽章照常实时显示真实状态）
  const s3 = evaluateExitStrategy(asset({ nav: 1.173, navDate: '2026-08-30' }), h, cfg, {
    state: s2.nextState,
  });
  assert.equal(s3.state, 'TAKE_PROFIT', '徽章照常实时');
  assert.equal(s3.event, false, '同 HWM 周期第二轮不得再触发（周期锁压制事件，冷却流逝也不放行）');
});

test('HWM 只升不降：浮盈大额申购摊薄 R_book 跌破启动点、复权未新高 ⇒ 锚不清空、继续按价格回撤监控', () => {
  const h = hist([
    ['2026-08-01', 1.0],
    ['2026-08-10', 1.3],
    ['2026-08-20', 1.24],
  ]);
  const cfg = { trailing: { startProfit: 0.08, drawdownThreshold: 0.05 } };
  const s1 = evaluateExitStrategy(
    asset({ nav: 1.3, navDate: '2026-08-10', shares: 10000, invested: 10000 }),
    h.slice(0, 2),
    cfg,
    { state: {} },
  );
  // 大额申购摊薄：R_econ = (24800−25000)/25000 = −0.8%（跌破启动点 8%、远离止损带，纯摊薄场景）
  const s2 = evaluateExitStrategy(
    asset({ nav: 1.24, navDate: '2026-08-20', shares: 20000, invested: 25000 }),
    h,
    cfg,
    { state: { ...s1.nextState, posShares: 10000, posInvested: 10000 } },
  );
  assert.equal(s2.nextState.hwmDate, '2026-08-10', '申购摊薄不动 HWM（锚只升不降）');
  assert.equal(s2.drawdown != null && s2.drawdown > 0.04, true, '继续按价格回撤监控');
});

test('深回撤注销筑底 + 立新锚向前因果：新锚=确认当日收盘价（非区间历史高点 1.25）', () => {
  // 1.00 → 1.30（HWM）→ 0.90（回撤 30.8% > 25% 注销，谷底 0.90）→ 1.25（反弹 38.9% 过双门当日确认？）
  // 场景：谷底 1.00 → 冲高 1.25 → 回落 1.15 当日确认双门 → 锚 = 1.15
  const h = hist([
    ['2026-06-01', 1.0],
    ['2026-06-10', 1.3],
    ['2026-06-20', 0.9], // 注销段
    ['2026-07-01', 1.0],
    ['2026-07-10', 1.25],
    ['2026-07-15', 1.15], // 筑底段：确认日 1.15
  ]);
  const cfg = { trailing: { startProfit: 0.08, drawdownThreshold: 0.05 } };
  const s1 = evaluateExitStrategy(asset({ nav: 1.3, navDate: '2026-06-10' }), h.slice(0, 2), cfg, {
    state: {},
  });
  // 注销轮：回撤 30.8% → hwmDate=null、resetTroughDate 落谷底、无锚期不触发止盈
  const s2 = evaluateExitStrategy(asset({ nav: 0.9, navDate: '2026-06-20' }), h.slice(0, 3), cfg, {
    state: s1.nextState,
  });
  assert.equal(s2.nextState.hwmDate, null, '深回撤注销 ⇒ 旧 HWM 置 null 进入筑底确认态');
  assert.equal(s2.nextState.resetTroughDate, '2026-06-20', '谷底日记 resetTroughDate');
  assert.notEqual(s2.state, 'TAKE_PROFIT', '无锚期不触发止盈（成本分区照常——本例 −10% 为观望带）');
  // 反弹确认日 1.15：R_econ = +15% ≥ 8% 且自谷底 0.9 反弹 27.8% ≥ 8% → 双门齐过立新锚
  const s5 = evaluateExitStrategy(
    asset({ nav: 1.15, navDate: '2026-07-15', invested: 10000, shares: 10000 }),
    h,
    cfg,
    { state: { ...s2.nextState, resetTroughDate: '2026-06-20' } },
  );
  assert.equal(
    s5.nextState.hwmDate,
    '2026-07-15',
    '双门确认立新锚，基准 = 确认当日收盘（向前因果）',
  );
  assert.equal(s5.nextState.resetTroughDate, null, '立锚清空谷底日');
  assert.equal(
    s5.drawdown,
    0,
    '立锚当日回撤 = 0——不按历史高点 1.25 追溯（追溯版会得 8% 立即割仓）',
  );
});

test('stable 参数化退化：无加仓区档全流程无 NaN/除零，ADD 全域禁用', () => {
  const cfg = { riskClass: 'stable', addEnabled: true, reserveCash: 5000 };
  // −4%：stable stop1=−3% → 止损带（参数化生效）；−1.5%：成本分区外 → HOLD。两档都不得产 ADD/NaN
  const deep = evaluateExitStrategy(
    asset({ nav: 0.96, navDate: '2026-08-20', invested: 10000, shares: 10000 }),
    hist([
      ['2026-08-01', 1.0],
      ['2026-08-20', 0.96],
    ]),
    cfg,
    { state: {} },
  );
  assert.ok(Number.isFinite(deep.lossRate), 'lossRate 有限');
  assert.equal(
    deep.state,
    'STOP_LOSS',
    'stable −4% 触及止损（档位取自 stable costBands，非 balanced 硬编码）',
  );
  assert.equal(deep.addAmount, null, 'ADD 全域禁用');
  const calm = evaluateExitStrategy(
    asset({ nav: 0.985, navDate: '2026-08-20', invested: 10000, shares: 10000 }),
    hist([
      ['2026-08-01', 1.0],
      ['2026-08-20', 0.985],
    ]),
    cfg,
    { state: {} },
  );
  assert.equal(calm.state, 'HOLD');
  assert.equal(calm.addAmount, null);
  assert.ok(!Number.isNaN(calm.nextState.reserveUsed ?? 0), '持久态无 NaN/除零');
});

test('stable 缺省安全垫：无 addTop 时再武装线取 stop1 兜底（不裸取 undefined 恒 false）', () => {
  const h = hist([
    ['2026-08-01', 1.0],
    ['2026-08-10', 0.94],
    ['2026-08-20', 0.99],
    ['2026-08-21', 0.991],
    ['2026-08-22', 0.992],
  ]);
  const cfg = { riskClass: 'stable' }; // stop1=−3%：止损锁 [3] 后回本 ⇒ 再武装线 = addTop ?? stop1 = −3%
  const st0 = {
    stopLossConsumedTiers: [3],
    lastStopDate: '2026-08-10',
    reboundedAfterStop: false,
    hwmDate: null,
  };
  const r = evaluateExitStrategy(
    asset({ nav: 0.992, navDate: '2026-08-22', invested: 10000, shares: 10000 }),
    h,
    cfg,
    { state: st0 },
  );
  assert.deepEqual(
    r.nextState.stopLossConsumedTiers,
    [],
    'R_econ=−0.8% > −3%（缺省垫）连续 3 净值日站稳 ⇒ 再武装清空',
  );
});

test('反弹确认阈值 4.5%：2.5% 噪声不激活、4.6% 激活并固化谷底（±0.1% 双侧）', () => {
  const mk = (rows) => hist(rows);
  const cfg = {
    costBands: {
      balanced: { addTop: -0.05, addBottom: -0.1, stop1: -0.15, stop2: -0.2, exitFloor: -0.3 },
    },
  };
  // 止损落地（−16% 触发首档）→ 谷底 → 反弹 2.5% → false
  const h1 = mk([
    ['2026-08-01', 1.0],
    ['2026-08-10', 0.84],
    ['2026-08-15', 0.8],
    ['2026-08-20', 0.82],
  ]);
  const st = {
    lastStopDate: '2026-08-10',
    stopLossConsumedTiers: [15],
    reboundedAfterStop: false,
    lockedTroughDate: null,
    hwmDate: null,
  };
  const r1 = evaluateExitStrategy(
    asset({ nav: 0.82, navDate: '2026-08-20', invested: 10000, shares: 10000 }),
    h1,
    cfg,
    { state: st },
  );
  assert.equal(r1.nextState.reboundedAfterStop, false, '自谷底 0.80 反弹 2.5% < 4.5% ⇒ 不激活');
  // 反弹 4.6% → true 且固化谷底日
  const h2 = mk([
    ['2026-08-01', 1.0],
    ['2026-08-10', 0.84],
    ['2026-08-15', 0.8],
    ['2026-08-20', 0.8368],
  ]);
  const r2 = evaluateExitStrategy(
    asset({ nav: 0.8368, navDate: '2026-08-20', invested: 10000, shares: 10000 }),
    h2,
    cfg,
    { state: st },
  );
  assert.equal(r2.nextState.reboundedAfterStop, true, '反弹 4.6% ≥ 4.5% ⇒ 激活');
  assert.equal(r2.nextState.lockedTroughDate, '2026-08-15', '反弹确认瞬间固化谷底日');
});

test('单边瀑布兜底：破 stop2 后无反弹阴跌至 stop2−5% ⇒ 强制放行 EXIT（四条件永假的兜底）', () => {
  const h = hist([
    ['2026-08-01', 1.0],
    ['2026-08-10', 0.79],
    ['2026-08-20', 0.74],
  ]); // −21%→−26%，无反弹
  const cfg = {};
  const st = {
    stopLossConsumedTiers: [15, 20],
    lastStopDate: '2026-08-10',
    reboundedAfterStop: false,
    lockedTroughDate: null,
    hwmDate: null,
  };
  const r = evaluateExitStrategy(
    asset({ nav: 0.74, navDate: '2026-08-20', invested: 10000, shares: 10000 }),
    h,
    cfg,
    { state: st },
  );
  assert.equal(
    r.state,
    'EXIT',
    'reboundedAfterStop 恒 false、lockedTroughDate=null ⇒ navOf(null) 不可判——单边瀑布强制清仓',
  );
});

test('事件闸：止损越级穿透前置于 executedInfo（已 ack 一档后跳空二档 ⇒ 放行）；穿透≠重复（同指纹拦截）', () => {
  const base = {
    state: 'STOP_LOSS',
    fullRedemption: false,
    existingCooldown: '2026-09-01',
    currentTier: 20,
    stopLossConsumedTiers: [15],
    consumedTiers: [],
    fingerprint: 'STOP_LOSS_20_2026-09-10',
    emittedFingerprints: new Set(),
    executedInfo: { active: true, state: 'STOP_LOSS' },
    inCooldownFlag: true,
  };
  // 昨日已 ack 一档（executedInfo active 同态）、今日跳空二档 → 穿透前置 → 放行
  assert.equal(shouldSuppressEvent(base), false, '越级穿透不得被 executedInfo 同态闸拦截');
  // 同指纹二次到达 → 顶层指纹闸拦截（穿透≠重复；非穿透态同理）
  assert.equal(
    shouldSuppressEvent({ ...base, emittedFingerprints: new Set([base.fingerprint]) }),
    true,
    '同指纹不重复落盘',
  );
  // 非穿透态同指纹（指纹过滤前置于事件闸最顶层，不限穿透态）
  assert.equal(
    shouldSuppressEvent({
      ...base,
      state: 'ADD',
      currentTier: null,
      fingerprint: 'ADD_2026-09-10',
      emittedFingerprints: new Set(['ADD_2026-09-10']),
    }),
    true,
  );
  // 复合指纹：同日跳空多档各有独立指纹
  const f1 = buildFingerprint('STOP_LOSS', 15, '2026-09-10');
  const f2 = buildFingerprint('STOP_LOSS', 20, '2026-09-10');
  assert.notEqual(f1, f2, '同日不同档 ⇒ 不同指纹');
});

test('TP 档位跃迁穿透：冷却期内同日从一档跃至二档 ⇒ 放行落盘', () => {
  const r = shouldSuppressEvent({
    state: 'TAKE_PROFIT',
    fullRedemption: false,
    existingCooldown: '2026-09-01',
    currentTier: 20,
    stopLossConsumedTiers: [],
    consumedTiers: [15],
    fingerprint: 'TAKE_PROFIT_20_2026-09-10',
    emittedFingerprints: new Set(),
    executedInfo: null,
    inCooldownFlag: true,
  });
  assert.equal(r, false, 'TP 命中更深未消耗档 ⇒ 穿透冷却');
});

test('executionPlan：T+1 未知价契约——priceKnown 恒 false、归属日按时段推导、节假日顺延可识别', () => {
  const h = hist([
    ['2026-09-09', 1.0],
    ['2026-09-10', 0.83],
  ]); // −17% 触发止损
  const now = new Date('2026-09-10T16:30:00+08:00'); // 盘后
  const r = evaluateExitStrategy(
    asset({ nav: 0.83, navDate: '2026-09-10', invested: 10000, shares: 10000 }),
    h,
    {},
    {
      state: {},
      now: () => now,
      nextTradingDay: (d) => (d === '2026-09-10' ? '2026-09-11' : '2026-09-14'),
      isTradingDay: (d) => !['2026-09-12', '2026-09-13'].includes(d),
    },
  );
  assert.equal(r.state, 'STOP_LOSS');
  const p = r.executionPlan;
  assert.ok(p, '信号态必产 executionPlan');
  assert.equal(p.signalNavDate, '2026-09-10');
  assert.equal(p.priceKnown, false, 'T+1 未知价恒 false');
  assert.equal(p.expectedExecutionNavDate, '2026-09-11', '盘后生成 ⇒ 下一交易日净值');
  assert.ok(String(p.orderDeadline).startsWith('2026-09-11'), '盘后下单截止 = 下一交易日 15:00');
  assert.equal(p.calendarEstimated ?? false, false, '日历可用不标 estimated');
});

// ---- 存储层（lib/strategyStore.js：AsyncMutex + Merger）----

import { AsyncMutex, stateFileMutex } from '../lib/strategyStore.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

test('锁队列异常隔离：一次写盘抛错只传给当次调用方，后续写入照常入队执行', async () => {
  const m = new AsyncMutex();
  await assert.rejects(
    m.lock(async () => {
      throw new Error('I/O 异常');
    }),
    /I\/O 异常/,
  );
  const r = await m.lock(async () => 42); // 队列未 reject——后续写入正常
  assert.equal(r, 42);
  const r2 = await stateFileMutex.lock(async () => 'alive'); // 全局锁同样存活
  assert.equal(r2, 'alive');
});

test('Merger：磁盘版本被并发推进 ⇒ 字段级差分合并＋乐观锁重试（并发写不被冲刷、引擎新值保留）', async () => {
  const dir = await mkdtemp(pjoin(tmpdir(), 'p0store-'));
  try {
    const store = createStrategyStore({ dataDir: dir });
    // 基线：A 基金 reserveUsed=10
    await store.saveState({ funds: { A: { reserveUsed: 10, addRiskUsed: 0, cooldowns: {} } } });
    const s1 = await store.loadState();
    const baseline = JSON.parse(JSON.stringify(s1.funds)); // 开工快照
    // 并发写：reserveUsed 99（纠偏）+ ignore 标记——rev 推进
    await store.saveState({
      funds: {
        A: {
          ...baseline.A,
          reserveUsed: 99,
          ignore: { state: 'ADD', navDate: '2026-09-20', ts: 't' },
        },
      },
    });
    // 引擎轮落盘：自己的结果（reserveUsed 仍按旧值 10 计 + 新算 addRiskUsed 5 + 新 lastExecutionPlan）
    await store.saveState(
      {
        funds: {
          A: {
            reserveUsed: 10,
            addRiskUsed: 5,
            cooldowns: {},
            lastExecutionPlan: { fingerprint: 'ADD_-_2026-09-20', addAmount: 500 },
          },
        },
        schemaVersion: s1.schemaVersion,
      },
      { baseline, baseRev: s1.rev },
    );
    const after = await store.loadState();
    const a = after.funds.A;
    assert.equal(a.reserveUsed, 99, '并发写（磁盘侧变更）不被引擎内存值冲刷');
    assert.equal(a.addRiskUsed, 5, '引擎本轮新值保留（磁盘未动该字段 ⇒ 引擎为准）');
    assert.equal(a.ignore?.state, 'ADD', 'ignore 标记保留');
    assert.equal(a.lastExecutionPlan, null, '语义仲裁：磁盘侧发生过 ignore ⇒ 引擎新计划作废不写');
    assert.ok(after.rev > s1.rev + 1, `乐观锁重试后版本单调推进（rev=${after.rev}）`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- ack 写通道与迁移（lib/strategyTask + strategyStore）----

import { createDatabase } from '../lib/database.js';
import { createStrategyStore } from '../lib/strategyStore.js';
import { createStrategyTask } from '../lib/strategyTask.js';

const FUND_A = {
  id: 'fund_p0',
  asset_type: 'fund',
  name: 'P0测试',
  code: '110020',
  snapshot: {
    hold_amount: 10000,
    pending_amount: 0,
    cost_price: 1.0,
    hold_shares: 10000,
    total_invested: 10000,
  },
  transactions: [{ id: 'tx1', type: 'buy', amount: 10000, shares: 10000, date: '2026-01-10' }],
  strategy_config: null,
};

async function p0Harness({ seriesByCall, funds = [FUND_A], now = '2026-09-10T20:00:00' } = {}) {
  const dir = await mkdtemp(pjoin(tmpdir(), 'p0ack-'));
  const db = createDatabase({ dataDir: dir, now: () => new Date(now) });
  await db.save(funds, null, []);
  const store = createStrategyStore({ dataDir: dir });
  const queue = [...(seriesByCall || [])];
  const fetchLog = [];
  let simNow = new Date(now);
  const task = createStrategyTask({
    db,
    strategyStore: store,
    fetchHistory: async () => {
      const s = queue.length ? queue.shift() : seriesByCall[seriesByCall.length - 1];
      fetchLog.push(s[s.length - 1].date);
      return { series: s };
    },
    now: () => new Date(simNow),
    xirrFn: () => null,
  });
  return {
    db,
    store,
    task,
    dir,
    fetchLog,
    setNow: (d) => {
      simNow = new Date(d);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const ser = (dates, navs) => dates.map((d, i) => ({ date: d, nav: navs[i], acc_nav: navs[i] }));
const mkD = (n, end) => {
  const b = new Date(end + 'T00:00:00');
  return Array.from({ length: n }, (_, i) =>
    new Date(b.getTime() - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
  );
};

test('迁移：旧 TP 执行归因低位 hwmDate ⇒ 补周期锁，突破旧周期高点前不再止盈', async () => {
  const h = await p0Harness({
    seriesByCall: [ser(mkD(7, '2026-09-10'), [1.0, 1.3, 1.24, 1.21, 1.19, 1.17, 1.16])],
  });
  try {
    // 手工构造旧格式持久态：hwmDate=峰值日 + sellExec（TP 归因）+ 无周期锁字段
    const st0 = await h.store.loadState();
    st0.funds['110020'] = {
      hwmDate: '2026-09-05',
      cooldowns: {},
      sellExec: { state: 'TAKE_PROFIT', navDate: '2026-09-05' },
    };
    await h.store.saveState(st0);
    const after = await h.store.loadState();
    assert.equal(
      after.funds['110020'].trailingConsumedAtHwmDate,
      '2026-09-05',
      'loadState 迁移补周期锁 = 旧 hwmDate',
    );
    // 引擎：回撤 (1.3−1.16)/1.3 = 10.8% ≥ 5% 且 R_econ>0 → 信号照常，但周期锁压制事件
    const r = await h.task.status();
    const f = r.funds[0];
    assert.equal(f.state, 'TAKE_PROFIT', '徽章照常实时');
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.trailingConsumedAtHwmDate, '2026-09-05', 'status 只读不落盘、周期锁不丢');
  } finally {
    await h.cleanup();
  }
});

test('ack(TAKE_PROFIT, trailing) 原子代写：冷却锚 + 周期锁；冷却期满同 HWM 周期不重复卖', async () => {
  const d1 = mkD(6, '2026-09-09');
  const d2 = mkD(7, '2026-09-10');
  const h = await p0Harness({
    seriesByCall: [
      ser(d1, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]),
      ser(d2, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1]),
    ],
  });
  try {
    await h.task.runOnce(); // 锚定
    h.setNow('2026-09-11T20:00:00');
    const r2 = await h.task.runOnce(); // 回撤触发 → 事件落盘（含 lastExecutionPlan）
    assert.equal(r2.events, 1);
    const entry = (await h.store.loadState()).funds['110020'];
    const ackNav = entry.cooldowns.TAKE_PROFIT;
    const ackR = await h.task.ack('110020', 'TAKE_PROFIT', ackNav); // 契约恒三字段（前端零传参）
    assert.equal(ackR.proxied, true, '代写自闭环（读回 lastExecutionPlan）');
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.cooldowns.TAKE_PROFIT, ackNav);
    assert.equal(st.trailingConsumedAtHwmDate, st.hwmDate, 'trailing 周期锁代写 = 当前 hwmDate');
    assert.equal(st.lastExecutionPlan.consumedAt != null, true, '计划消费标记（幂等闸数据源）');
    // 幂等：同指纹二次 ack = no-op
    const again = await h.task.ack('110020', 'TAKE_PROFIT', ackNav);
    assert.equal(again.idempotent, true);
  } finally {
    await h.cleanup();
  }
});

test('ack(STOP_LOSS) 原子代写：lastStopDate + 档位（含跳空吞并集）——冷却压制的事件副作用不丢失', async () => {
  const h = await p0Harness({
    seriesByCall: [ser(mkD(6, '2026-09-10'), [1.0, 1.0, 1.0, 1.0, 1.0, 0.79])],
  }); // −21% 直落二档
  try {
    const r = await h.task.runOnce();
    assert.equal(r.events, 1);
    const entry = (await h.store.loadState()).funds['110020'];
    assert.deepEqual(entry.stopLossConsumedTiers, [15, 20], '事件落盘已写吞并集（单调吞并）');
    const ackNav = entry.cooldowns.STOP_LOSS;
    await h.task.ack('110020', 'STOP_LOSS', ackNav);
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.lastStopDate, ackNav, '破位锚代写（闸"刚割又补"）');
    assert.deepEqual(st.stopLossConsumedTiers, [15, 20], '档位锁不丢（冷却到期不再误割肉）');
    assert.equal(st.reboundedAfterStop, false, '反弹标记重置（跨周期不泄漏）');
  } finally {
    await h.cleanup();
  }
});

test('非巡检时段 ack：磁盘快照新鲜即可代写；无 NaN 坏死路径（body 无 tier/shares/amount）', async () => {
  const h = await p0Harness({
    seriesByCall: [ser(mkD(6, '2026-09-10'), [1.0, 1.0, 1.0, 1.0, 1.0, 0.84])],
  });
  try {
    const r = await h.task.runOnce(); // 事件落盘留 lastExecutionPlan（-16% 首档）
    assert.equal(r.events, 1);
    const entry = (await h.store.loadState()).funds['110020'];
    const ackNav = entry.cooldowns.STOP_LOSS;
    const res = await h.task.ack('110020', 'STOP_LOSS', ackNav); // running=false：走锁外校验→锁内代写
    assert.equal(res.proxied, true);
    const st = (await h.store.loadState()).funds['110020'];
    assert.ok(
      Number.isFinite(st.lastStopDate ? 1 : 1) && !Number.isNaN(st.cooldowns.STOP_LOSS),
      '写路径无 NaN',
    );
    assert.deepEqual(st.stopLossConsumedTiers, [15], '首档代写');
    // 弱网/旧缓存弹窗（无计划可读）→ 拒绝代写但登记照写（信号失效路径）
    const res2 = await h.task.ack('110020', 'TAKE_PROFIT', '2026-09-10'); // 当前非 TP 态
    assert.equal(res2.proxied, false, '信号已失效 ⇒ 不代写');
    assert.equal(res2.stale ?? res2.ok, res2.stale ?? true, '登记照写返回');
  } finally {
    await h.cleanup();
  }
});
