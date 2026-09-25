import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExitStrategy, DEFAULT_STRATEGY_CONFIG, prepareHistory } from '../js/strategy.js';

// ---- 夹具 ----

/** 生成n个连续日历日（截至end，含end），YYYY-MM-DD；雷达/冷却按"序列索引"计数，日期仅作锚点 */
function mkDates(n, end = '2026-09-10') {
  const base = new Date(end + 'T00:00:00');
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

/** 由 navs（升序）生成净值序列，accs 缺省 = nav（无分红） */
function mkSeries(dates, navs, accs) {
  return dates.map((date, i) => ({
    date,
    nav: navs[i],
    acc_nav: accs == null ? navs[i] : accs[i],
  }));
}

/** 标准资产：市值 = shares×nav；无 flows → XIRR 策略静默跳过（非 XIRR 用例不受年化干扰） */
function mkAsset(over = {}) {
  return {
    code: 'T001',
    name: '测试基金',
    qdii: false,
    shares: 10000,
    invested: 9700,
    cashDividend: 0,
    nav: 1.05,
    navDate: '2026-09-10',
    ...over,
  };
}

const BASE = {
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: true,
  riskClass: 'balanced',
  addEnabled: true,
  reserveCash: 3000,
};

// ---- 移动止盈（启动后峰值，3.1）----

test('1 启动：profitRate≥8% 首次满足 → hwmDate 落盘，当轮不触发（drawdown=0）', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [0.98, 0.99, 1.0, 1.005, 1.01, 1.015, 1.02, 1.03, 1.04, 1.05];
  const r = evaluateExitStrategy(mkAsset(), mkSeries(dates, navs), BASE, { state: {} });
  assert.equal(r.state, 'HOLD'); // 启动轮 drawdown=0，只记峰值
  assert.equal(r.nextState.hwmDate, '2026-09-10');
  assert.equal(r.drawdown, 0);
});

test('2 峰值回撤≥5%（默认阈值）→ TAKE_PROFIT 1/2', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9] }; // 峰值 2.00 所在净值日
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(r.ratio, 0.5);
  assert.ok(Math.abs(r.drawdown - 0.055) < 1e-9);
});

test('2c 触发日 profitRate < 启动点（市价回撤跌破启动点，无现金流）→ 回撤判定照常触发、峰值不清（P0 修复）', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.0, 1.02, 1.04, 1.06, 1.09, 1.1, 1.12, 1.12, 1.12, 1.06];
  // 峰值 +12%（<13.7% 界）：回撤 5.36% 触线当日profit +6% < 8%；旧实现的前置门会吞掉信号并清峰
  const state = { hwmDate: dates[6], posShares: 10000, posInvested: 10000 }; // 仓位指纹一致 = 无现金流
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.06, navDate: dates[9] }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.ok(Math.abs(r.drawdown - (1.12 - 1.06) / 1.12) < 1e-9);
  assert.equal(r.nextState.hwmDate, dates[6]); // 峰值保留（回撤触发不以启动点为前置门）
});

test('2d 零轴门（止盈/止损互斥）：回撤达阈值但 profitRate≤0 → 不触发止盈、成本分区接管，反弹回正后照常触发', () => {
  const dates = mkDates(11, '2026-09-10');
  const navs = [1.0, 1.02, 1.04, 1.06, 1.09, 1.1, 1.12, 1.12, 0.95, 0.88, 1.02];
  let state = {};
  const results = [];
  for (let i = 0; i < navs.length; i++) {
    const r = evaluateExitStrategy(
      mkAsset({ invested: 10000, shares: 10000, nav: navs[i], navDate: dates[i] }),
      mkSeries(dates.slice(0, i + 1), navs.slice(0, i + 1)),
      {},
      { state },
    );
    results.push(r);
    state = r.nextState;
  }
  // 跳空至 −5%（回撤 15.2%，QDII 长假补跌形态）：止盈被零轴门拦下 → 浅跌区 WATCH，峰值保留
  assert.equal(results[8].state, 'WATCH');
  assert.ok(results[8].profitRate <= 0);
  assert.equal(results[8].nextState.hwmDate, dates[7]);
  // 继续阴跌至 −12%（回撤 21.4%）：观望带 ALERT，而非"止盈赎 1/2"压掉成本分区
  assert.equal(results[9].state, 'ALERT');
  assert.equal(results[9].nextState.hwmDate, dates[7]); // 峰值仍保留（不清、不上移）
  // 反弹回正 +2%（回撤 8.9% ≥ 5%）：照常触发止盈，锁利为正
  assert.equal(results[10].state, 'TAKE_PROFIT');
  assert.ok(Math.abs(results[10].drawdown - (1.12 - 1.02) / 1.12) < 1e-9);
});

test('3 回撤 4.5%（<5%）不触发，继续守峰值', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.96, 1.91];
  const state = { hwmDate: dates[9] };
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.91,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17190 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state, xirrFn: () => null },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.nextState.hwmDate, dates[9]); // 峰值保留
});

test('4 profitRate 7.9% 未达启动点 → 休眠（无 hwmDate、不算回撤）', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.075, 1.079];
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.079 }),
    mkSeries(dates, navs),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.nextState.hwmDate ?? null, null);
  assert.equal(r.drawdown, null);
});

test('5 创新高：峰值上移，hwmDate 更新为当日', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.0, 1.02, 1.04, 1.06, 1.08, 1.1, 1.12, 1.14, 1.16, 1.3];
  const state = { hwmDate: dates[2] }; // 旧峰值远低于当前
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.3 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.nextState.hwmDate, '2026-09-10'); // 创新高 → hwmDate 上移
});

test('6 加仓摊薄跌破启动点 → 锚只升不降（申购/分红/摊薄一律不动 hwmDate）', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.15, 1.15, 1.15, 1.15, 1.15, 1.15, 1.15, 1.15, 1.15, 1.15];
  // 监控已启动（hwmDate 有值 + 上次评估的仓位指纹 10000/10000），加仓后 invested 12000 → 摊薄 profitRate −4.2% < 8%
  const r = evaluateExitStrategy(
    mkAsset({ invested: 12000, shares: 10000, nav: 1.15 }),
    mkSeries(dates, navs),
    BASE,
    { state: { hwmDate: dates[9], posShares: 10000, posInvested: 10000 } },
  );
  assert.equal(r.state, 'HOLD');
  assert.ok(r.nextState.hwmDate != null, '锚保留（平盘日=等高，锚日平移到当日合法）');
});

test('6b 摊薄后：监控继续按旧峰值算回撤、创新高才上移（无休眠路径）', () => {
  const dates = mkDates(14, '2026-09-10');
  const navs = [1.0, 1.02, 1.04, 1.06, 1.08, 1.1, 1.1, 1.09, 0.9, 0.88, 1.0, 1.05, 1.1, 1.13];
  // 启动 @1.10（+10%，仓位指纹 10000/10000 落盘）
  let r = evaluateExitStrategy(
    mkAsset({ nav: 1.1, navDate: dates[5] }),
    mkSeries(dates.slice(0, 6), navs.slice(0, 6)),
    BASE,
    { state: {} },
  );
  assert.equal(r.nextState.hwmDate, dates[5]);
  // 1.09 加仓 2000 元（invested 12000）→ 摊薄 +7.5% < 8%——锚保留
  const diluted = { invested: 12000, shares: 10000 + 2000 / 1.09 };
  r = evaluateExitStrategy(
    mkAsset({ ...diluted, nav: 1.09, navDate: dates[7] }),
    mkSeries(dates.slice(0, 8), navs.slice(0, 8)),
    BASE,
    { state: r.nextState },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.nextState.hwmDate, dates[5], '锚保留——摊薄不清峰');
  // 继续深跌（0.88，−13.2%）：零轴门挡住止盈（R_econ<0）→ 观望带 ALERT；回撤照常按旧峰值监控（20%）
  r = evaluateExitStrategy(
    mkAsset({ ...diluted, nav: 0.88, navDate: dates[9] }),
    mkSeries(dates.slice(0, 10), navs.slice(0, 10)),
    BASE,
    { state: r.nextState },
  );
  assert.equal(r.state, 'ALERT');
  assert.ok(Math.abs(r.drawdown - (1.1 - 0.88) / 1.1) < 1e-9, '回撤继续按旧峰值监控');
  // 创新高（1.13 > 1.10）→ 峰值上移当日，回撤归零
  r = evaluateExitStrategy(
    mkAsset({ ...diluted, nav: 1.13, navDate: dates[13] }),
    mkSeries(dates, navs),
    BASE,
    { state: r.nextState },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.drawdown, 0);
  assert.equal(r.nextState.hwmDate, dates[13]);
});

test('7 加仓摊薄仍≥启动点 → 峰值正常计算（保留语义）', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9] };
  // 加仓后 profitRate 仍高达 40%（invested 12000 / 市值 17010）
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 12000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -12000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'TAKE_PROFIT'); // 峰值回撤 5.5% 仍触发
  assert.equal(r.nextState.hwmDate, dates[9]);
});

test('8 除息日复权序列平滑，分红假摔不触发（峰值跨除息保护）', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.2, 1.18, 1.16, 1.15, 1.15];
  const accs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.3, 1.28, 1.26, 1.25, 1.25]; // 除息 0.10/份
  const state = { hwmDate: dates[6] }; // 复权峰值 1.20
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 10000,
      shares: 10000,
      cashDividend: 1000,
      nav: 1.15,
      flows: [
        { date: '2026-05-01', amount: -10000 },
        { date: '2026-09-10', amount: 11500 },
      ],
    }),
    mkSeries(dates, navs, accs),
    BASE,
    { state, xirrFn: () => null },
  );
  assert.equal(r.state, 'HOLD'); // 复权回撤 (1.20−1.15)/1.20 = 4.2% <5%；未复权会误算 11.5% 假触发
  assert.ok(Math.abs(r.drawdown - 0.0417) < 0.001);
});

test('9 无分红窗口：复权价 = 原净值（prepareHistory 恒等）', () => {
  const dates = mkDates(5, '2026-09-10');
  const series = mkSeries(dates, [1.0, 1.01, 1.02, 1.03, 1.04]);
  const p = prepareHistory(series);
  assert.deepEqual(
    p.adj.map((x) => x.adj),
    [1.0, 1.01, 1.02, 1.03, 1.04],
  );
  assert.equal(p.dividends.length, 0);
});

test('10 局部前复权手工验算：3 年分红老基金回撤不被 LJJZ 稀释', () => {
  const dates = [
    '2024-01-01',
    '2024-06-01',
    '2024-12-01',
    '2025-06-01',
    '2025-12-01',
    '2026-06-01',
  ];
  const navs = [1.0, 1.1, 0.99, 1.05, 0.9, 0.8];
  const accs = [1.0, 1.1, 1.1, 1.16, 1.11, 1.01]; // 两次分红：0.11/份、0.10/份
  const state = { hwmDate: '2025-06-01' }; // 复权峰值 0.95（idx3：其后无分红 → 原始净值）
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 7000,
      shares: 10000,
      cashDividend: 2100,
      nav: 0.8,
      navDate: '2026-06-01',
      flows: [
        { date: '2024-01-01', amount: -7000 },
        { date: '2026-06-01', amount: 8000 },
      ],
    }),
    mkSeries(dates, navs, accs),
    BASE,
    { state, xirrFn: () => null },
  );
  assert.equal(r.state, 'TAKE_PROFIT'); // 复权回撤 (0.95−0.80)/0.95 = 15.8% ≥5%；未复权口径 (1.05−0.80)/1.05 = 23.8%
  assert.ok(Math.abs(r.drawdown - (0.95 - 0.8) / 0.95) < 1e-9);
  // 手工验算复权价：idx3 = 0.95（其后的 0.10 分红只折算 idx3 之前）；idx4 = 0.90×f(0.11) = 0.81
  const p = prepareHistory(mkSeries(dates, navs, accs));
  const adjAt = (d) => p.adj.find((x) => x.date === d).adj;
  assert.ok(Math.abs(adjAt('2024-06-01') - 1.1 * (0.99 / 1.1) * (0.95 / 1.05)) < 1e-9);
  assert.ok(Math.abs(adjAt('2025-12-01') - 0.9) < 1e-9); // 除息日当天不受该次分红折算（其后再无分红）
});

test('11 执行归因后（hwmDate 被调用方清空）→ 重新启动，不沿用旧峰值', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09];
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.09 }),
    mkSeries(dates, navs),
    BASE,
    { state: { hwmDate: null } },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.nextState.hwmDate, '2026-09-10'); // 从执行价重新起算
});

test('12 用户忽略（冷却期内）→ 徽章照常显示 TAKE_PROFIT、不重复写事件', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9], cooldowns: { TAKE_PROFIT: dates[11] } }; // 昨日刚提示
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'TAKE_PROFIT'); // 状态照常
  assert.equal(r.event, false); // 不重复写事件
});

// ---- 分红检测 ----

test('13 差值跳增≥0.001 识别分红并算出每份分红', () => {
  const p = prepareHistory([
    { date: '2026-08-01', nav: 1.0, acc_nav: 1.0 },
    { date: '2026-08-02', nav: 0.96, acc_nav: 1.01 },
  ]);
  assert.equal(p.dividends.length, 1);
  assert.equal(p.dividends[0].perShare, 0.05);
  assert.equal(p.dividends[0].date, '2026-08-02');
});

test('14 差值跳增<0.001（浮点噪声）不误判', () => {
  const p = prepareHistory([
    { date: '2026-08-01', nav: 1.0, acc_nav: 1.0 },
    { date: '2026-08-02', nav: 0.9997, acc_nav: 1.0002 },
  ]);
  assert.equal(p.dividends.length, 0);
});

test('15 疑似未录入分红：快照带 detectedDividends（双分支选择器的数据源）', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 0.96, 0.96, 0.96];
  const accs = [1.0, 1.0, 1.0, 1.01, 1.01, 1.01]; // 09-06 分红 0.05
  const r = evaluateExitStrategy(mkAsset(), mkSeries(dates, navs, accs), BASE, { state: {} });
  assert.deepEqual(r.snapshot.detectedDividends, [{ date: dates[3], perShare: 0.05 }]);
});

test('16 未确认期间按原记录计算：lossRate 只用 asset.cashDividend，不自动改数', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 0.96, 0.96, 0.96];
  const accs = [1.0, 1.0, 1.0, 1.01, 1.01, 1.01];
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, cashDividend: 0, nav: 0.96 }),
    mkSeries(dates, navs, accs),
    BASE,
    { state: {} },
  );
  assert.ok(Math.abs(r.lossRate - -0.04) < 1e-9); // 不把检测到的 0.05/份 加进去
});

test('17 拆分/折算日不误判为分红', () => {
  const p = prepareHistory([
    { date: '2026-08-01', nav: 2.0, acc_nav: 2.5 },
    { date: '2026-08-02', nav: 1.0, acc_nav: 1.25 },
  ]);
  assert.equal(p.dividends.length, 0); // 差值跳变为负（-0.25）→ 非分红
});

// ---- XIRR 阶梯 ----

test('18 xirr≥15% 首次 → 赎 1/3，tier15 标记消耗', () => {
  const dates = mkDates(6, '2026-09-10');
  const asset = mkAsset({
    flows: [
      { date: '2026-01-10', amount: -10000 },
      { date: '2026-09-10', amount: 10500 },
    ],
  });
  const r = evaluateExitStrategy(asset, mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]), BASE, {
    state: {},
    xirrFn: () => 0.16,
  });
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.ok(Math.abs(r.ratio - 1 / 3) < 1e-6);
  assert.deepEqual(r.nextState.consumedTiers, [15]);
});

test('19 tier15 已消耗、xirr≥20% 且绝对净收益 ≥10% → 赎剩余的 1/2，tier20 标记（P13.4 绝对门）', () => {
  const dates = mkDates(6, '2026-09-10');
  const asset = mkAsset({
    invested: 9000,
    flows: [
      { date: '2026-01-10', amount: -9000 },
      { date: '2026-09-10', amount: 10500 },
    ],
  });
  const r = evaluateExitStrategy(asset, mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]), BASE, {
    state: { consumedTiers: [15] },
    xirrFn: () => 0.22,
  });
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(r.ratio, 0.5);
  assert.deepEqual(r.nextState.consumedTiers, [15, 20]);
});

test('20 跳档直接≥20%（绝对净收益过二档门）→ 只执行最高档、tier15 一并标记', () => {
  const dates = mkDates(6, '2026-09-10');
  const asset = mkAsset({
    invested: 9000,
    flows: [
      { date: '2026-01-10', amount: -9000 },
      { date: '2026-09-10', amount: 10500 },
    ],
  });
  const r = evaluateExitStrategy(asset, mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]), BASE, {
    state: { consumedTiers: [] },
    xirrFn: () => 0.22,
  });
  assert.equal(r.ratio, 0.5);
  assert.deepEqual(r.nextState.consumedTiers, [15, 20]);
});

test('21 tier15 已消耗、xirr 仍 16% → 不重复触发', () => {
  const dates = mkDates(6, '2026-09-10');
  const asset = mkAsset({
    flows: [
      { date: '2026-01-10', amount: -10000 },
      { date: '2026-09-10', amount: 10500 },
    ],
  });
  const r = evaluateExitStrategy(asset, mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]), BASE, {
    state: { consumedTiers: [15] },
    xirrFn: () => 0.16,
  });
  assert.equal(r.state, 'HOLD');
});

test('21b 自定义非 5 倍数台阶（15.5%/18%）→ 命中档正确入列消耗，不重复触发', () => {
  const dates = mkDates(6, '2026-09-10');
  const cfg = {
    ...BASE,
    xirrLadder: {
      ...BASE.xirrLadder,
      tiers: [
        { threshold: 0.155, sellRatio: 1 / 3 },
        { threshold: 0.18, sellRatio: 0.5 },
      ],
    },
  };
  const asset = mkAsset({
    flows: [
      { date: '2026-01-10', amount: -10000 },
      { date: '2026-09-10', amount: 10500 },
    ],
  });
  const series = mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
  const r1 = evaluateExitStrategy(asset, series, cfg, { state: {}, xirrFn: () => 0.19 });
  assert.equal(r1.state, 'TAKE_PROFIT');
  assert.equal(r1.ratio, 0.5);
  assert.deepEqual(r1.nextState.consumedTiers, [16, 18]); // 0.155→16、0.18→18（命中档必须全部入列，否则 18 永不消耗）
  const r2 = evaluateExitStrategy(asset, series, cfg, {
    state: { consumedTiers: r1.nextState.consumedTiers },
    xirrFn: () => 0.19,
  });
  assert.equal(r2.state, 'HOLD'); // 已消耗档不得在每个冷却周期重复弹
});

test('22 P1 滞回窗口：15 净值日内 ≥10 日 R_econ 低于 5% → consumedTiers 重置（窗口计数）', () => {
  const dates = mkDates(16, '2026-09-10');
  const navs = [
    1.1, 1.1, 1.1, 1.1, 1.1, 0.95, 0.95, 0.95, 1.1, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95,
  ]; // 末 15 日（idx1-15）中 11 日 rEcon<5%、4 日 ≥5%（单日回升不清零）
  const asset = mkAsset({
    flows: [
      { date: '2026-01-10', amount: -9700 },
      { date: '2026-09-10', amount: 9500 },
    ],
  });
  const r = evaluateExitStrategy(asset, mkSeries(dates, navs), BASE, {
    state: { consumedTiers: [15, 20] },
    xirrFn: () => 0.05,
  });
  assert.deepEqual(
    r.nextState.consumedTiers,
    [],
    '窗口计数达标 → 台阶重新武装（xirr 标量回落不再是判据）',
  );
  assert.equal(r.state, 'HOLD');
});

test('23 持有<90 天 → XIRR 策略跳过（年化爆炸防护）', () => {
  const dates = mkDates(6, '2026-09-10');
  const asset = mkAsset({
    flows: [
      { date: '2026-08-20', amount: -10000 },
      { date: '2026-09-10', amount: 11500 },
    ],
  }); // 21 天
  const r = evaluateExitStrategy(asset, mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]), BASE, {
    state: {},
    xirrFn: () => 5.0,
  });
  assert.equal(r.state, 'HOLD'); // 年化再高也不触发
});

test('24 computeXIRR 无解（null）→ 静默降级不崩', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ flows: [{ date: '2026-01-01', amount: -10000 }] }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
    BASE,
    { state: {}, xirrFn: () => null },
  );
  assert.equal(r.xirr, null);
  assert.equal(r.state, 'HOLD');
});

test('25 止盈两路同触 → 取大比例、被覆盖的 XIRR 档一并标记消耗', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9], consumedTiers: [] };
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state, xirrFn: () => 0.16 },
  );
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(r.ratio, 0.5); // 移动止盈 1/2 > XIRR 1/3
  assert.deepEqual(r.nextState.consumedTiers, [15]); // 被覆盖的 tier15 标记消耗
});

test('26 市值口径 K8：profitRate/lossRate 一律 = shares×nav 推导', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.05];
  const r = evaluateExitStrategy(
    mkAsset({ invested: 9700, shares: 10000, nav: 1.05 }),
    mkSeries(dates, navs),
    BASE,
    { state: {} },
  );
  assert.ok(Math.abs(r.profitRate - (10000 * 1.05 - 9700) / 9700) < 1e-12);
});

test('27 profitGate=true 且 profitRate≤0 → XIRR 策略跳过', () => {
  const dates = mkDates(6, '2026-09-10');
  const cfg = { ...BASE, xirrLadder: { ...BASE.xirrLadder, profitGate: true } };
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 10000,
      shares: 10000,
      nav: 0.95,
      flows: [
        { date: '2026-01-01', amount: -10000 },
        { date: '2026-09-10', amount: 9500 },
      ],
    }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.95]),
    cfg,
    { state: {}, xirrFn: () => 0.5 },
  );
  assert.notEqual(r.state, 'TAKE_PROFIT'); // profitGate 闸住（−5% 落加仓区 → 预算未设 → WATCH）
});

// ---- 成本分档止损/加仓 ----

test('28 亏损率 −14%（观望带）→ ALERT 无动作', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.86 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.86]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'ALERT');
  assert.equal(r.ratio, null);
});

test('29 亏损率 −16% → 首档 STOP_LOSS 赎 1/3', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.84 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.84]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'STOP_LOSS');
  assert.ok(Math.abs(r.ratio - 1 / 3) < 1e-6);
});

test('30 亏损率 −21% → 二档 STOP_LOSS 赎 1/2', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.79 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.79]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'STOP_LOSS');
  assert.equal(r.ratio, 0.5);
});

test('31 盈利区不产生止损信号（互斥）', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.05, cashDividend: 0 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.05]),
    BASE,
    { state: {} },
  );
  assert.notEqual(r.state, 'STOP_LOSS');
  assert.notEqual(r.state, 'EXIT');
});

test('32 addEnabled=false → 浅跌区（−6%）为 WATCH 无 ADD', () => {
  const dates = mkDates(6, '2026-09-10');
  const cfg = { ...BASE, addEnabled: false };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    cfg,
    { state: {} },
  );
  assert.equal(r.state, 'WATCH');
});

test('33 达预留上限 → 不再 ADD，且 reasonText 报"已达计划上限"', () => {
  const dates = mkDates(6, '2026-09-10');
  const state = { reserveUsed: 5000, reserveBase: 10000, lastReserveCash: 3000 }; // cap 0.5×10000 = 5000 → 已达
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    BASE,
    { state },
  );
  assert.notEqual(r.state, 'ADD'); // 预算空 → WATCH
  assert.equal(r.snapshot.addBlockReason, 'cap_reached');
  assert.ok(r.snapshot.reasonText.includes('已达计划上限'));
});

test('34 档间冷却：ADD 冷却期内徽章照常、不重复写事件', () => {
  const dates = mkDates(6, '2026-09-10');
  const state = {
    cooldowns: { ADD: dates[4] },
    lastAddNavDate: dates[3],
    reserveUsed: 0,
    reserveBase: 10000,
  };
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 10000,
      shares: 10000,
      nav: 0.94,
      flows: [{ date: '2026-08-20', amount: -1000 }],
    }),
    mkSeries(dates, [1.0, 1.0, 1.0, 0.97, 0.96, 0.94]),
    BASE,
    { state },
  );
  assert.equal(r.state, 'ADD'); // 状态照常
  assert.equal(r.event, false); // 冷却期内不重复写事件
});

test('35 止损优先于加仓（同区不同档不冲突，深跌必出止损）', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.84 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.84]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'STOP_LOSS'); // −16%：止损胜出，绝不给 ADD
});

test('36 ADD 建议日后的买入自动归因：reserveUsed 增大 → 建议金额变小', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 0.97, 0.96, 0.94];
  const mk = (used) =>
    evaluateExitStrategy(
      mkAsset({
        invested: 10000,
        shares: 10000,
        nav: 0.94,
        flows: [{ date: '2026-08-20', amount: -1000 }],
      }),
      mkSeries(dates, navs),
      BASE,
      { state: { reserveUsed: used, reserveBase: 10000, lastAddNavDate: null } },
    );
  const a1 = mk(0),
    a2 = mk(2000); // P1 两档制：配比上限 planBudget×1/2=1500；used=2000 ⇒ 剩余 1000 < 1500 开始压减
  assert.equal(a1.snapshot.addAmount, 1500);
  assert.ok(a2.snapshot.addAmount < a1.snapshot.addAmount); // 剩余预算变小 → 单次金额变小
});

test('36a 买入自动归因（引擎侧）：ADD 建议日后的买入累入 reserveUsed，跨评估不重复计数（P0 修复）', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 0.97, 0.96, 0.94, 0.93, 0.92];
  // 第一轮：−6% 首档触发 ADD 事件（建议 3000 的 1/3 = 1000）
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94, navDate: dates[5] }),
    mkSeries(dates.slice(0, 6), navs.slice(0, 6)),
    BASE,
    { state: {} },
  );
  assert.equal(r1.state, 'ADD');
  assert.equal(r1.event, true);
  assert.equal(r1.nextState.reserveUsed ?? 0, 0); // 事件本身不消耗预算——只有真实买入才消耗
  // 第二轮：按建议买入 600 元（dates[6] 成交），净值推进到 0.92（−8%，第 2 档）。
  // 归因只读 txBuys（纯买入交易流）；初始建仓买入（2026-01-01，锚之前）不计
  const txBuys = [
    { date: '2026-01-01', amount: 10000 },
    { date: dates[6], amount: 600 },
  ];
  const after = { invested: 10600, shares: 10000 + 600 / 0.93 };
  const r2 = evaluateExitStrategy(
    mkAsset({ ...after, nav: 0.92, navDate: dates[7], txBuys }),
    mkSeries(dates, navs),
    BASE,
    { state: r1.nextState },
  );
  assert.equal(r2.nextState.reserveUsed, 600);
  // 第三轮（无新买入重评）：不重复累加
  const r3 = evaluateExitStrategy(
    mkAsset({ ...after, nav: 0.92, navDate: dates[7], txBuys }),
    mkSeries(dates, navs),
    BASE,
    { state: r2.nextState },
  );
  assert.equal(r3.nextState.reserveUsed, 600);
});

test('36b 买入自动归因封顶：reserveUsed ≤ min(reserveCash, reserveBase×reserveCap)，达帽后提示已达上限', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 0.97, 0.96, 0.94, 0.93, 0.92];
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94, navDate: dates[5] }),
    mkSeries(dates.slice(0, 6), navs.slice(0, 6)),
    BASE,
    { state: {} },
  );
  assert.equal(r1.state, 'ADD');
  // 一次性买入 4000 元 > 预算 3000 → 封顶记 3000
  const txBuys = [
    { date: '2026-01-01', amount: 10000 },
    { date: dates[6], amount: 4000 },
  ];
  const r2 = evaluateExitStrategy(
    mkAsset({ invested: 14000, shares: 10000 + 4000 / 0.93, nav: 0.92, navDate: dates[7], txBuys }),
    mkSeries(dates, navs),
    BASE,
    { state: r1.nextState },
  );
  assert.equal(r2.nextState.reserveUsed, 3000); // min(4000, min(3000, 10000×0.5))
  assert.equal(r2.snapshot.addBlockReason, 'cap_reached');
});

test('36c 归因数据源隔离：基线本金流不计入、停用期买入不追溯、启用后买入照常计', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 0.97, 0.96, 0.94, 0.93, 0.92];
  // 停用期评估：归因不运行，但锚照常推进（否则停用窗口的买入会在重启后被一次性追溯）
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94, navDate: dates[5] }),
    mkSeries(dates.slice(0, 6), navs.slice(0, 6)),
    { ...BASE, addEnabled: false },
    { state: {} },
  );
  assert.equal(r1.nextState.reserveUsedAsOf, dates[5]);
  // 启用后评估：flows是buildFundFlows形态（新导入基金基线-10000@dates[6]+期末市值），引擎归因不读flows；
  // txBuys 里停用期的 2000（dates[4] ≤ 锚）不追溯，启用后的 600（dates[6]）照常计
  const flows = [
    { date: dates[6], amount: -10000 },
    { date: dates[7], amount: 9300 },
  ];
  const txBuys = [
    { date: dates[4], amount: 2000 },
    { date: dates[6], amount: 600 },
  ];
  const r2 = evaluateExitStrategy(
    mkAsset({ invested: 12600, shares: 12000, nav: 0.92, navDate: dates[7], flows, txBuys }),
    mkSeries(dates, navs),
    BASE,
    { state: r1.nextState },
  );
  assert.equal(r2.nextState.reserveUsed, 600); // 基线 -10000 与停用期 2000 都不吃预算
  assert.notEqual(r2.snapshot.addBlockReason, 'cap_reached');
});

test('37 reserveBase=启用时本金快照：加仓不自我扩张 cap', () => {
  const dates = mkDates(6, '2026-09-10');
  const state = { reserveUsed: 4900, reserveBase: 10000, lastReserveCash: 6000 }; // cap = 5000
  const cfg = { ...BASE, reserveCash: 6000 }; // reserveCash 巨大也受 cap 管制
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 10000,
      shares: 10000,
      nav: 0.94,
      flows: [{ date: '2026-08-20', amount: -1000 }],
    }),
    mkSeries(dates, [1.0, 1.0, 1.0, 0.97, 0.96, 0.94]),
    cfg,
    { state },
  );
  assert.equal(r.snapshot.addAmount, 100); // P1：剩余预算 = 5000−4900 = 100（配比 3000/风险 3333 均未 binding）；恰在起购线
});

test('38 riskClass=stable：止损 −3%/−5% 低敏感档 + 雷达 2% 阈值', () => {
  const dates = mkDates(6, '2026-09-10');
  const cfg = { ...BASE, riskClass: 'stable' };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.96 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.96]),
    cfg,
    { state: {} },
  );
  assert.equal(r.state, 'STOP_LOSS'); // −4% 落在 −3%~−5%：首档已过 → 1/3
  assert.ok(Math.abs(r.ratio - 1 / 3) < 1e-6);
});

test('58 riskClass=stable：雷达 2%/4% 预设生效——balanced 5% 阈以下的 2.5% 连跌也亮黄灯', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [1.0, 1.0, 1.0, 1.0, 0.995, 0.975]; // d5 = 2.5%：≥ stable 2%、< balanced 5%
  const cfg = { ...BASE, riskClass: 'stable' };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 9000, shares: 10000, nav: 0.975 }),
    mkSeries(dates, navs),
    cfg,
    { state: {} },
  );
  assert.equal(r.radar.level, 'yellow');
  assert.equal(r.radar.trigger, 'd5');
  assert.equal(r.state, 'HOLD'); // 雷达不改变主状态（stable 浅跌不亮 WATCH）
});

// 用例 58 的"EXIT>STOP_LOSS>TAKE_PROFIT>ADD 全序仲裁"覆盖对照（仲裁与 riskClass 无关，balanced 用例对 stable 同样成立）：
// EXIT 压止损 = 用例 40（趋势终结论）；止损压加仓 = 用例 35（同区不同档）；止盈/加仓盈利亏损区天然互斥（零轴门）；EXIT 冷却穿透 = 用例 62。

// ---- 清空 ----

test('39 lossRate≤−30%（绝对兜底线）→ EXIT 清空', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.69 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.69]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'EXIT');
  assert.equal(r.ratio, 1);
});

test('40 "收复再破位"场景：四条件状态机接管，判为首档止损信号', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 0.95, 0.9, 0.87, 0.85, 0.87, 0.88, 0.88, 0.86, 0.84, 0.83, 0.83];
  const state = { lastStopDate: dates[4] }; // 止损日净值 0.85；后收复至 0.88，再跌破 0.833
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.83, cashDividend: 0 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  // 新口径：−17% 未及二档（−20%）→ 首档止损；趋势终结需 stop2 消耗＋反弹确认＋破固化谷底（见 strategy-p0）
  assert.equal(r.state, 'STOP_LOSS');
  assert.ok(Math.abs(r.ratio - 1 / 3) < 1e-4, 'P1 归整：3333.33/10000（sharePrecision=2）');
});

test('41 lastStopDate 跨除息：复权比较不误判破位', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [1.0, 0.95, 0.9, 0.88, 0.85, 0.75, 0.8, 0.8];
  const accs = [1.0, 0.95, 0.9, 0.88, 0.85, 0.87, 0.92, 0.92]; // 止损后分红 0.12/份：复权价 0.87 ≥ 0.85（收复），未破位
  const state = { lastStopDate: dates[4] };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, cashDividend: 1200, nav: 0.8 }),
    mkSeries(dates, navs, accs),
    BASE,
    { state },
  );
  assert.notEqual(r.state, 'EXIT'); // 未复权会误判"暴跌破位"，复权后无破位
});

test('42 仅观望带深跌（−14%）→ 不 EXIT', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.86 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.86]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'ALERT');
});

test('43 lastStopDate 超窗（早于序列起点）→ 反弹采样自序列首起算，不崩不误判（P0 改写）', () => {
  const dates = mkDates(10, '2026-09-10');
  const state = { lastStopDate: '2026-06-01' }; // 早于序列起点
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.78 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.78]),
    BASE,
    { state },
  );
  assert.equal(r.state, 'STOP_LOSS'); // −22% 触及二档（−25% 及更深由单边瀑布兜底直接 EXIT，见 strategy-p0）
  assert.equal(r.ratio, 0.5);
});

test('44 破位缓冲：收复后单日跌幅 <2% 不触发 EXIT', () => {
  const dates = mkDates(10, '2026-09-10');
  const navs = [1.0, 0.95, 0.9, 0.87, 0.85, 0.87, 0.88, 0.86, 0.85, 0.846];
  const state = { lastStopDate: dates[4] };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.846 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  // 0.846 > 0.85×0.98 = 0.833 → 未破位；lossRate −15.4% → 首档止损 1/3
  assert.notEqual(r.state, 'EXIT');
  assert.equal(r.state, 'STOP_LOSS');
});

test('45 清仓执行后（无持仓）→ 自动休眠', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ shares: 0, invested: 0, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'HOLD');
});

test('45c 重建仓兜底：posShares=0（清仓标记）+ 新持仓 → 旧 lastStopDate/hwmDate/消耗位不跨仓位存活', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [1.3, 1.1, 1.2, 1.35, 1.05, 1.06, 1.07, 1.09];
  // 旧仓位留下僵尸态：破位链（lastStopDate@1.10，其后收复至 1.35 又跌破）+ 峰值（1.35）+ 消耗位
  // 新仓位 +9%：不得因旧破位链误发 EXIT、不得因旧峰值虚算 19.3% 回撤误发 TAKE_PROFIT
  const state = {
    lastStopDate: dates[1],
    hwmDate: dates[3],
    cooldowns: { TAKE_PROFIT: dates[3] },
    consumedTiers: [15],
    posShares: 0,
    posInvested: 0,
  };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.09, navDate: dates[7] }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'HOLD'); // +9% ≥ 8% → 从当日正常启动
  assert.equal(r.drawdown, 0);
  assert.equal(r.nextState.hwmDate, dates[7]);
  assert.equal(r.nextState.lastStopDate ?? null, null);
  assert.deepEqual(r.nextState.consumedTiers ?? [], []);
});

// ---- 雷达/仲裁/集成 ----

test('46 5 个净值日累计跌幅≥5% → 雷达黄灯角标（不改主状态）', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [2.0, 1.98, 1.96, 1.94, 1.92, 1.89];
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
    mkSeries(dates, navs),
    BASE,
    { state: {} },
  );
  assert.equal(r.radar.level, 'yellow');
  assert.equal(r.state, 'HOLD'); // 雷达不改变主状态
  assert.ok(Math.abs(r.radar.d5Drop - 0.055) < 1e-9);
});

test('47 20 个净值日累计跌幅≥10% 或 60 日峰值回撤≥8% → 橙灯', () => {
  const dates = mkDates(21, '2026-09-10');
  const navs = Array.from({ length: 21 }, (_, i) => 2.0 - i * 0.01); // 2.00 → 1.80
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.8 }),
    mkSeries(dates, navs),
    BASE,
    { state: {} },
  );
  assert.equal(r.radar.level, 'orange');
});

test('47b 雷达 trigger：d5/d20 命中时标记实际触发指标', () => {
  const dates6 = mkDates(6, '2026-09-10');
  const navs6 = [2.0, 1.98, 1.96, 1.94, 1.92, 1.89]; // d5 = 5.5%
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
    mkSeries(dates6, navs6),
    BASE,
    { state: {} },
  );
  assert.equal(r1.radar.level, 'yellow');
  assert.equal(r1.radar.trigger, 'd5');
  const dates21 = mkDates(21, '2026-09-10');
  const navs21 = Array.from({ length: 21 }, (_, i) => 2.0 - i * 0.011); // d20 = 11%（避开 0.10 阈值浮点边界）
  const r2 = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.78 }),
    mkSeries(dates21, navs21),
    BASE,
    { state: {} },
  );
  assert.equal(r2.radar.level, 'orange');
  assert.equal(r2.radar.trigger, 'd20'); // d20 判定先于 peak60
});

test('47c 雷达 trigger：自定义 peak60=3% 触发时标记 peak60（展示层不再用硬编码阈值误标连跌）', () => {
  const dates = mkDates(61, '2026-09-10');
  const navs = [];
  for (let i = 0; i < 61; i++) {
    if (i < 20)
      navs.push(1.9 + i * 0.015); // 1.90 → 2.185
    else if (i < 55)
      navs.push(2.2); // 平台峰值 2.20
    else navs.push(2.2 - (i - 55) * (0.08 / 5)); // 2.20 → 2.12（峰值回撤 3.64%）
  }
  const cfg = { ...BASE, radar: { ...BASE.radar, peak60: 0.03 } };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 2.12 }),
    mkSeries(dates, navs),
    cfg,
    { state: {} },
  );
  assert.equal(r.radar.level, 'orange');
  assert.equal(r.radar.trigger, 'peak60'); // d20=3.64%<10%、d5=3.64%<5%，仅 peak60（自定义 3%）触发
});

test('48 雷达冷却：同级别冷却期内不重复提示（active=false）', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [2.0, 1.98, 1.96, 1.94, 1.92, 1.89];
  const state = { cooldowns: { RADAR: dates[4] } }; // 昨日刚提示黄灯
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.radar.level, 'yellow');
  assert.equal(r.radar.active, false);
});

test('51 per-action 冷却互不压制：止损冷却不闸止盈事件', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9], cooldowns: { STOP_LOSS: dates[10] } }; // 止损冷却中
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(r.event, true); // 止盈事件不受止损冷却压制
});

test('52 冷却/窗口按净值序列索引计数：长假空洞不空耗也不提前', () => {
  const dates = mkDates(14, '2026-09-10');
  dates[12] = '2026-09-25';
  dates[13] = '2026-10-12'; // 人造长假空洞
  const navs = [2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 1.99, 1.94, 1.93, 1.89]; // 末 5 日跌 5.03%
  const mk = (coolDate) =>
    evaluateExitStrategy(
      mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
      mkSeries(dates, navs),
      BASE,
      { state: { cooldowns: { RADAR: coolDate } } },
    );
  const near = mk(dates[12]); // 索引距 1 → 冷却内
  const far = mk(dates[6]); // 索引距 7 → 已过期
  assert.equal(near.radar.active, false);
  assert.equal(far.radar.active, true);
});

test('53 冷却持久化为 navDate：引擎按日期回查序列索引', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [2.0, 1.98, 1.96, 1.94, 1.92, 1.89];
  const state = { cooldowns: { RADAR: '2026-09-09' } }; // dates[4]
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.radar.active, false);
});

test('53b 雷达冷却与 actionCooldownDays 解耦：自定义动作冷却 3 日，雷达仍按 5 净值日闸', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [2.0, 2.0, 2.0, 2.0, 2.0, 1.98, 1.94, 1.89]; // 末 5 净值日跌 5.5% → 黄灯
  const cfg = { ...BASE, actionCooldownDays: 3 };
  const state = { cooldowns: { RADAR: dates[4] } }; // 3 个净值日前提示过：5 日窗内应仍被闸
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
    mkSeries(dates, navs),
    cfg,
    { state },
  );
  assert.equal(r.radar.level, 'yellow');
  assert.equal(r.radar.active, false); // 雷达按自身 5 净值日窗判定，不随 actionCooldownDays=3 缩短
});

test('53c 雷达冷却与 actionCooldownDays 解耦：自定义动作冷却 10 日，不延长雷达 5 日窗', () => {
  const dates = mkDates(9, '2026-09-10');
  const navs = [2.0, 2.0, 2.0, 2.0, 2.0, 1.98, 1.94, 1.89, 1.89]; // 末 5 净值日跌 5.5% → 黄灯
  const cfg = { ...BASE, actionCooldownDays: 10 };
  const state = { cooldowns: { RADAR: dates[3] } }; // 5 个净值日前提示过：5 日窗已过
  const r = evaluateExitStrategy(
    mkAsset({ invested: 8000, shares: 10000, nav: 1.89 }),
    mkSeries(dates, navs),
    cfg,
    { state },
  );
  assert.equal(r.radar.level, 'yellow');
  assert.equal(r.radar.active, true); // 雷达按自身 5 净值日窗判定，不被 actionCooldownDays=10 连带压制
});

test('56 QDII 重复净值日期去重（保留最后一条）', () => {
  const p = prepareHistory([
    { date: '2026-09-08', nav: 1.0, acc_nav: 1.0 },
    { date: '2026-09-09', nav: 0.95, acc_nav: 0.95 },
    { date: '2026-09-09', nav: 0.9, acc_nav: 0.9 }, // 同日重复，应保留最后
    { date: '2026-09-10', nav: 0.89, acc_nav: 0.89 },
  ]);
  assert.deepEqual(
    p.adj.map((x) => x.date),
    ['2026-09-08', '2026-09-09', '2026-09-10'],
  );
  assert.equal(p.adj[1].adj, 0.9);
});

test('59 安全垫不变量：8%/8% 组合被拒绝、8%/5% 通过（引擎双重校验）', () => {
  const dates = mkDates(6, '2026-09-10');
  const series = mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
  assert.throws(
    () =>
      evaluateExitStrategy(
        mkAsset(),
        series,
        { ...BASE, trailing: { startProfit: 0.08, drawdownThreshold: 0.08 } },
        { state: {} },
      ),
    /安全垫/,
  );
  const ok = evaluateExitStrategy(
    mkAsset(),
    series,
    { ...BASE, trailing: { startProfit: 0.08, drawdownThreshold: 0.05 } },
    { state: {} },
  );
  assert.ok(ok.state);
});

test('60 STOP_LOSS 后 actionCooldownDays 内不产生 ADD（先撤退后进攻）', () => {
  const dates = mkDates(8, '2026-09-10');
  // 止损发生在 4 天前（idx3，nav 0.84），现反弹回 −6%（加仓区）
  const navs = [1.0, 1.0, 0.9, 0.84, 0.85, 0.9, 0.93, 0.94];
  const state = { lastStopDate: dates[3], cooldowns: { STOP_LOSS: dates[3] } };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'WATCH'); // 止损后间隔期内不给 ADD，降为关注
});

test('64 ADD 步进：箱体震荡未再跌一档 → 不重复 ADD', () => {
  const dates = mkDates(6, '2026-09-10');
  const navs = [1.0, 1.0, 0.97, 0.945, 0.945, 0.945];
  // 上次加仓净值 0.945，当前仍 0.945（未再跌 ≥ addStep 2.5%）→ 步进未满足不触发
  const state = { lastAddNavDate: dates[4], reserveUsed: 0, reserveBase: 10000 };
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 10000,
      shares: 10000,
      nav: 0.945,
      flows: [{ date: '2026-08-20', amount: -1000 }],
    }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.notEqual(r.state, 'ADD'); // 步进未满足
  assert.equal(r.state, 'WATCH'); // −5.5% 仍在加仓区 → 关注
});

test('62 EXIT 冷却穿透：止损冷却期内满足双条件 → EXIT 照常输出并落盘', () => {
  const dates = mkDates(8, '2026-09-10');
  const navs = [1.0, 1.0, 0.9, 0.85, 0.8, 0.75, 0.7, 0.66];
  const state = {
    lastStopDate: dates[3],
    cooldowns: { STOP_LOSS: dates[4], TAKE_PROFIT: dates[4] },
  };
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.66 }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'EXIT'); // lossRate −34% 兜底线 + 穿透一切冷却
  assert.equal(r.event, true);
});

test('63 碎份额归整：按比例赎回后剩余 < 最低保留额（10 份）→ 改为全额赎回', () => {
  const dates = mkDates(6, '2026-09-10');
  // shares 15 / 成本 0.80：nav 0.64 → lossRate −20% → 二档止损 1/2（7.5 份）
  // 赎回后剩余 7.5 份 < 最低保留 10 份 → 归整为全额赎回（ratio 1）
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 12,
      shares: 15,
      nav: 0.64,
      flows: [
        { date: '2026-06-01', amount: -12 },
        { date: '2026-09-10', amount: 9.6 },
      ],
    }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.64]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'STOP_LOSS');
  assert.equal(r.ratio, 1); // 归整：1/2 → 全额
  assert.equal(r.snapshot.fullRedemption, true);
});

test('50 冷却只闸事件落盘：TAKE_PROFIT 冷却期内徽章照常（快照含 executed 通道说明）', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9], cooldowns: { TAKE_PROFIT: dates[11] } };
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state },
  );
  assert.equal(r.state, 'TAKE_PROFIT'); // 徽章照常（状态实时）
  assert.equal(r.event, false); // 只闸事件
  assert.ok(r.snapshot.reasonText.includes('赎回 1/2'));
});

// ---- 回归：N 档方向 / reserveBase 快照 / 提示通道 / 事件级持久进度 / 雷达同级别冷却 ----

test('65 ADD 金额阶梯（P1 两档制）：−6% 首档配比 1/2；−7.5% 跳空直入二档吞并一档配额', () => {
  const dates = mkDates(6, '2026-09-10');
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    BASE,
    { state: {} },
  );
  assert.equal(r1.state, 'ADD');
  assert.equal(r1.snapshot.addAmount, 1500); // P1：planBudget 3000 × 1/2 = 1500（基数是预算承诺额——非剩余÷档数）
  const r2 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.92 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.92]),
    BASE,
    { state: { reserveUsed: 1000, reserveBase: 10000, lastReserveCash: 3000 } },
  );
  assert.equal(r2.snapshot.addAmount, 2000); // −8% 跳空直入二档吞并一档配额：tierShare=1 ⇒ 配比 3000；剩余预算 2000 binding ⇒ 2000
});

test('66 reserveBase 本金快照：启用加仓+已设预留资金即落盘（引擎侧，不依赖调用方）', () => {
  const dates = mkDates(6, '2026-09-10');
  // 盈利区同样快照（不要求已跌进加仓区才生效）
  const r0 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 1.05 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.04, 1.05]),
    BASE,
    { state: {} },
  );
  assert.equal(r0.nextState.reserveBase, 10000);
  assert.equal(r0.nextState.lastReserveCash, 3000);
  // 改设 reserveCash → 重新快照
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    { ...BASE, reserveCash: 5000 },
    { state: { reserveBase: 8000, lastReserveCash: 3000 } },
  );
  assert.equal(r1.nextState.reserveBase, 10000);
  assert.equal(r1.nextState.lastReserveCash, 5000);
});

test('67 未设置预留资金：ADD 不触发，reasonText 提示先设置', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    { ...BASE, reserveCash: null },
    { state: {} },
  );
  assert.notEqual(r.state, 'ADD');
  assert.equal(r.snapshot.addBlockReason, 'missing_reserve');
  assert.ok(r.snapshot.reasonText.includes('预留资金'));
});

test('48b 雷达同级别冷却：orange→orange 5 净值日内不重复，yellow→orange 升级不受限（3.4）', () => {
  const dates = mkDates(21, '2026-09-10');
  const navs = dates.map((_, i) => 2.0 - i * 0.01); // 20 日跌 10% → orange
  const asset = mkAsset({ invested: 18000, shares: 10000, nav: navs[20] });
  const mk = (radarLevel) =>
    evaluateExitStrategy(asset, mkSeries(dates, navs), BASE, {
      state: { cooldowns: { RADAR: dates[19] }, radarLevel },
    });
  assert.equal(mk('orange').radar.active, false); // 同级别重复：冷却期内不重复提示
  assert.equal(mk('yellow').radar.active, true); // 升级（黄→橙）：穿透冷却
});

test('61a 冷却压制的止盈信号不消耗 XIRR 档（消耗位跟随事件）', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const state = { hwmDate: dates[9], consumedTiers: [], cooldowns: { TAKE_PROFIT: dates[11] } }; // 昨日止盈事件已落盘
  const r = evaluateExitStrategy(
    mkAsset({
      invested: 9000,
      shares: 9000,
      nav: 1.89,
      flows: [
        { date: '2026-05-01', amount: -9000 },
        { date: '2026-09-10', amount: 17010 },
      ],
    }),
    mkSeries(dates, navs),
    BASE,
    { state, xirrFn: () => 0.16 },
  );
  assert.equal(r.state, 'TAKE_PROFIT'); // 徽章照常
  assert.equal(r.event, false); // 冷却闸事件
  assert.deepEqual(r.nextState.consumedTiers, []); // 被压制的信号不得无声消耗 XIRR 档（事件落盘时才消耗）
});

test('61b 冷却压制的止损不推进 lastStopDate（破位锚点跟随事件日，与 alerts 可对账）', () => {
  const dates = mkDates(6, '2026-09-10');
  const state = { cooldowns: { STOP_LOSS: dates[4] }, stopLossConsumedTiers: [15] }; // 昨日止损事件已落盘（新世界：档位锁同轮写入）
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.84 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.84]),
    BASE,
    { state },
  );
  assert.equal(r.state, 'STOP_LOSS'); // 徽章照常
  assert.equal(r.event, false);
  assert.equal(r.nextState.lastStopDate ?? null, null); // 锚点不被压制期的重复信号漂移
});

test('45b 休眠路径（invested=0）也推进 lastEvalNavDate（幂等锚，防巡检每轮空转重评）', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 0, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    BASE,
    { state: {} },
  );
  assert.equal(r.state, 'HOLD');
  assert.equal(r.nextState.lastEvalNavDate, '2026-09-10');
});

// ---- 进度（progress）与已执行归因（ack → State Demotion）----

test('65b progress：止盈触发 = 回撤越线（over），持有监控中 = 距落袋线进度', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const flows = [
    { date: '2026-05-01', amount: -9000 },
    { date: '2026-09-10', amount: 17010 },
  ];
  const r1 = evaluateExitStrategy(
    mkAsset({ invested: 9000, shares: 9000, nav: 1.89, flows }),
    mkSeries(dates, navs),
    BASE,
    { state: { hwmDate: dates[9] }, xirrFn: () => null },
  );
  assert.equal(r1.state, 'TAKE_PROFIT');
  assert.equal(r1.progress.tone, 'over'); // 回撤 5.5% ≥ 5%
  assert.ok(Math.abs(r1.progress.cur - 0.055) < 1e-9 && Math.abs(r1.progress.line - 0.05) < 1e-9);
  const r2 = evaluateExitStrategy(
    { ...mkAsset({ nav: 1.95 }), flows: undefined },
    mkSeries(dates.slice(0, 11), navs.slice(0, 11)),
    BASE,
    { state: { hwmDate: dates[9] }, xirrFn: () => null },
  );
  assert.equal(r2.state, 'HOLD');
  assert.equal(r2.progress.tone, 'ok'); // 回撤 2.5% / 5%
  assert.ok(r2.progress.pct >= 40 && r2.progress.pct <= 60);
});

test('65c progress：观望带与止损各有档位刻度文案', () => {
  const dates = mkDates(6, '2026-09-10');
  const a = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.86 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.86]),
    BASE,
    { state: {} },
  );
  assert.equal(a.state, 'ALERT');
  assert.ok(a.progress.label.includes('观望带 -10%~-15%'));
  const s = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.79 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.79]),
    BASE,
    { state: {} },
  );
  assert.ok(s.progress.label.includes('二档线 -20%'));
});

test('65d progress：补仓带档位（第 i/N 档）', () => {
  const dates = mkDates(6, '2026-09-10');
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, shares: 10000, nav: 0.94 }),
    mkSeries(dates, [1.0, 1.0, 1.0, 1.0, 1.0, 0.94]),
    { ...BASE, addEnabled: true, reserveCash: 3000 },
    { state: {} },
  );
  assert.equal(r.state, 'ADD');
  assert.ok(r.progress.label.includes('补仓区第 1/2 档'), '两档制（P13.3）');
});

test('61c ack 已执行归因：冷却窗口内 executed=true（day/total），窗口外自动失效', () => {
  const dates = mkDates(12, '2026-09-10');
  const navs = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 1.7, 1.9, 2.0, 1.95, 1.89];
  const flows = [
    { date: '2026-05-01', amount: -9000 },
    { date: '2026-09-10', amount: 17010 },
  ];
  const mk = (ack) =>
    evaluateExitStrategy(
      mkAsset({ invested: 9000, shares: 9000, nav: 1.89, flows }),
      mkSeries(dates, navs),
      BASE,
      {
        state: { hwmDate: dates[9], cooldowns: { TAKE_PROFIT: dates[11] }, ack },
        xirrFn: () => null,
      },
    );
  const ackYesterday = mk({ state: 'TAKE_PROFIT', navDate: dates[10] }); // 第 2/5 天（mkDates 尾日因 UTC 转换比标签早一天）
  assert.equal(ackYesterday.executed, true);
  assert.deepEqual(ackYesterday.executedInfo, { day: 2, total: 5, navDate: dates[10] });
  assert.equal(ackYesterday.snapshot.executed, true);
  const ackStale = mk({ state: 'TAKE_PROFIT', navDate: dates[2] }); // 超过 5 个净值日 → 失效
  assert.equal(ackStale.executed, false);
  assert.equal(ackStale.executedInfo, null);
  const ackOther = mk({ state: 'STOP_LOSS', navDate: dates[11] }); // 动作不匹配 → 不降级
  assert.equal(ackOther.executed, false);
});

// ---- 卖出交易自动归因（执行检测与重置 / 在途确认期 / State Demotion）----
// 语义：卖出建议事件（TAKE_PROFIT/STOP_LOSS）之后出现卖出交易 → 自动归因"已执行"（降级显示）；
// TAKE_PROFIT 另把 hwmDate 重置为执行日净值日（峰值从执行价重计）；冷却从执行日重计（锁定中不重复喊）。
// 执行日净值日 = 序列中首个 ≥ 卖出记录日的净值日（交易台账"确认日"口径）；净值未公布 = 在途 → 本轮不归因。

test('11b 卖出自动归因：TP 事件后出现卖出 → 自动"已执行" + hwmDate 重置为执行日（旧峰值不再触发）', () => {
  const d = mkDates(14, '2026-09-10');
  const navs = [1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 1.015, 1.01, 1.02, 1.03, 1.04];
  const state0 = {
    hwmDate: d[4],
    cooldowns: { TAKE_PROFIT: d[6] },
    posShares: 10000,
    posInvested: 9700,
  };
  const sells = [{ date: d[8], shares: 5000 }];
  // 第 1 轮（评估日 d[12]）：卖出已录入（份额/本金减半），旧峰值回撤 6.4% 本应再触发
  const r1 = evaluateExitStrategy(
    mkAsset({ shares: 5000, invested: 4850, nav: 1.03, navDate: d[12], txSells: sells }),
    mkSeries(d.slice(0, 13), navs.slice(0, 13)),
    BASE,
    { state: state0 },
  );
  assert.equal(r1.state, 'TAKE_PROFIT'); // 徽章照常显示真实状态（降级在文案层）
  assert.equal(r1.executed, true); // 自动归因"已执行"
  assert.equal(r1.executedInfo.day, 5); // 执行日 d[8] → 第 5/5 天
  assert.equal(r1.executedInfo.navDate, d[8]);
  assert.equal(r1.executedInfo.auto, true);
  assert.equal(r1.event, false); // 已执行 → 本轮不重复写事件（冷却从执行日重计）
  assert.equal(r1.nextState.hwmDate, d[8]); //3.1 峰值从执行价重计
  assert.equal(r1.nextState.cooldowns.TAKE_PROFIT, d[8]);
  assert.equal(r1.nextState.sellAttributionAsOf, d[8]);
  assert.deepEqual(r1.nextState.sellExec, { state: 'TAKE_PROFIT', navDate: d[8] });
  // 第 2 轮（评估日d[13]，净值 1.04）：旧峰值（1.10）回撤 5.5% 仍超线；若未重置本应再触发
  const r2 = evaluateExitStrategy(
    mkAsset({ shares: 5000, invested: 4850, nav: 1.04, navDate: d[13], txSells: sells }),
    mkSeries(d, navs),
    BASE,
    { state: r1.nextState },
  );
  assert.equal(r2.state, 'HOLD'); // 峰值已从执行价重计 → 旧峰值不再触发
  assert.equal(r2.executed, false); // 动作已不在当前状态 → 无降级
  assert.equal(r2.nextState.hwmDate, d[13]); // 1.04 创新高 → 峰值正常上移
});

test('12b 无卖出（忽略）→ hwmDate 不重置、无归因标记', () => {
  const d = mkDates(13, '2026-09-10');
  const navs = [1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 1.015, 1.01, 1.02, 1.03];
  const state0 = {
    hwmDate: d[4],
    cooldowns: { TAKE_PROFIT: d[6] },
    posShares: 10000,
    posInvested: 9700,
  };
  const r = evaluateExitStrategy(mkAsset({ nav: 1.03, navDate: d[12] }), mkSeries(d, navs), BASE, {
    state: state0,
  });
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(r.event, true); // 冷却期外照常再触发
  assert.equal(r.executed, false);
  assert.equal(r.nextState.hwmDate, d[4]); // 无卖出 → 峰值不重置
  assert.equal(r.nextState.sellExec ?? null, null);
});

test('11c 在途确认期：卖出日晚于最新净值日（净值未公布）→ 本轮不归因；净值公布后归因', () => {
  const d = mkDates(14, '2026-09-10');
  const navs = [1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 1.015, 1.01, 1.02, 1.03, 1.03];
  const state0 = {
    hwmDate: d[4],
    cooldowns: { TAKE_PROFIT: d[6] },
    posShares: 10000,
    posInvested: 9700,
  };
  const sells = [{ date: d[13], shares: 5000 }]; // 卖出记录日晚于序列末净值日
  const r1 = evaluateExitStrategy(
    mkAsset({ shares: 5000, invested: 4850, nav: 1.03, navDate: d[12], txSells: sells }),
    mkSeries(d.slice(0, 13), navs.slice(0, 13)),
    BASE,
    { state: state0 },
  );
  assert.equal(r1.executed, false); // 在途：T+1 净值未公布，不归因
  assert.equal(r1.nextState.hwmDate, d[4]); // 峰值暂不重置
  assert.equal(r1.event, true); // 冷却期外照常触发（不因在途卖出而静默）
  const r2 = evaluateExitStrategy(
    mkAsset({ shares: 5000, invested: 4850, nav: 1.03, navDate: d[13], txSells: sells }),
    mkSeries(d, navs),
    BASE,
    { state: r1.nextState },
  );
  assert.equal(r2.executed, true); // 净值公布 → 归因
  assert.equal(r2.nextState.hwmDate, d[13]); // 峰值从执行价重计
});

test('61d 卖出归因窗口外失效：执行超过冷却窗口 → 降级消失、峰值重置保留', () => {
  const d = mkDates(13, '2026-09-10');
  const navs = [1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 1.015, 1.01, 1.02, 1.03];
  const state0 = {
    hwmDate: d[4],
    cooldowns: { TAKE_PROFIT: d[6] },
    posShares: 10000,
    posInvested: 9700,
  };
  const r = evaluateExitStrategy(
    mkAsset({
      shares: 5000,
      invested: 4850,
      nav: 1.03,
      navDate: d[12],
      txSells: [{ date: d[7], shares: 5000 }],
    }),
    mkSeries(d, navs),
    BASE,
    { state: state0 },
  );
  assert.equal(r.executed, false); // day=6 超窗 → 降级失效
  assert.equal(r.executedInfo, null);
  assert.equal(r.nextState.hwmDate, d[7]); // 归因本身保留：峰值从执行价重计
});

test('61e 止损卖出归因：STOP_LOSS 事件后卖出 → 降级显示；同档档位锁压制重复事件、锚点不动', () => {
  const d = mkDates(10, '2026-09-10');
  const navs = [1.0, 0.98, 0.96, 0.94, 0.92, 0.9, 0.88, 0.86, 0.85, 0.84];
  const state0 = {
    hwmDate: null,
    cooldowns: { STOP_LOSS: d[8] },
    lastStopDate: d[8],
    stopLossConsumedTiers: [15],
    posShares: 10000,
    posInvested: 10000,
  };
  const r = evaluateExitStrategy(
    mkAsset({
      shares: 6667,
      invested: 6667,
      nav: 0.84,
      navDate: d[9],
      txSells: [{ date: d[9], shares: 3333 }],
    }),
    mkSeries(d, navs),
    BASE,
    { state: state0 },
  );
  assert.equal(r.state, 'STOP_LOSS');
  assert.equal(r.executed, true);
  assert.equal(r.executedInfo.auto, true);
  assert.equal(r.executedInfo.day, 1);
  assert.equal(r.nextState.sellExec.state, 'STOP_LOSS');
  assert.equal(r.nextState.hwmDate, null); // 止损不碰移动止盈峰值
  assert.equal(r.nextState.lastStopDate, d[8]); // 破位锚点不动
});

test('11e 卖出后转亏（当前非卖出动作）→ 仍按最近卖出事件归因：休眠峰值不复活、标记留痕', () => {
  const d = mkDates(13, '2026-09-10');
  const navs = [1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 0.99, 0.95, 0.9, 0.88];
  const state0 = {
    hwmDate: d[4],
    cooldowns: { TAKE_PROFIT: d[6] },
    posShares: 10000,
    posInvested: 9700,
  };
  const r = evaluateExitStrategy(
    mkAsset({
      shares: 5000,
      invested: 4850,
      nav: 0.88,
      navDate: d[12],
      txSells: [{ date: d[8], shares: 5000 }],
    }),
    mkSeries(d, navs),
    BASE,
    { state: state0 },
  );
  assert.equal(r.state, 'ADD'); // 亏损区零轴门挡住止盈 → 成本分区接管
  assert.equal(r.nextState.hwmDate, d[8]); // 卖出归因把峰值重计到执行日
  assert.equal(r.nextState.sellExec?.state, 'TAKE_PROFIT'); // 归因留痕（审计：该事件已执行）
  assert.equal(r.executed, false); // 动作不在当前状态 → 无降级
});

// ---- 忽略收敛 ignored 输出 ----

test('71 忽略收敛：ignore 匹配当前动作态且冷却锚仍为本轮 ignore 的 navDate → ignored=true，跨天不失效', () => {
  const d = mkDates(16, '2026-09-10');
  const navs = [
    1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 1.015, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06,
  ];
  const mk = (seriesLen) =>
    evaluateExitStrategy(
      mkAsset({ nav: navs[seriesLen - 1], navDate: d[seriesLen - 1] }),
      mkSeries(d.slice(0, seriesLen), navs.slice(0, seriesLen)),
      BASE,
      {
        state: {
          hwmDate: d[3],
          cooldowns: { TAKE_PROFIT: d[10] },
          ignore: { state: 'TAKE_PROFIT', navDate: d[10] },
        },
      },
    );
  const r1 = mk(13); // 忽略后第 3 天
  assert.equal(r1.state, 'TAKE_PROFIT');
  assert.equal(r1.ignored, true);
  const r2 = mk(14); // 次日：锚不变、仍处 5 净值日冷却窗口内 → 置灰不失效（跨天口径）
  assert.equal(r2.ignored, true);
  const r3 = mk(16); // 冷却窗口过（索引差 5）→ 自动回 false，按状态再次提醒
  assert.equal(r3.ignored, false);
});

test('72 忽略收敛：ack/卖出归因把冷却锚推进后自然解绑——已执行不再显示已忽略', () => {
  const d = mkDates(13, '2026-09-10');
  const navs = [1.0, 1.02, 1.05, 1.1, 1.09, 1.05, 1.045, 1.03, 1.02, 1.015, 1.01, 1.02, 1.03];
  const r = evaluateExitStrategy(mkAsset({ nav: 1.03, navDate: d[12] }), mkSeries(d, navs), BASE, {
    state: {
      hwmDate: d[4],
      cooldowns: { TAKE_PROFIT: d[12] },
      ignore: { state: 'TAKE_PROFIT', navDate: d[10] },
    },
  });
  assert.equal(r.state, 'TAKE_PROFIT');
  assert.equal(r.ignored, false); // 冷却锚（d[12]）≠ 本轮 ignore 锚（d[10]）→ 解绑
});

test('73 忽略收敛：动作态不匹配 → ignored=false', () => {
  const d = mkDates(10, '2026-09-10');
  const navs = [1.0, 0.98, 0.96, 0.94, 0.92, 0.9, 0.88, 0.86, 0.85, 0.84];
  const r = evaluateExitStrategy(
    mkAsset({ invested: 10000, nav: 0.84, navDate: d[9] }),
    mkSeries(d, navs),
    BASE,
    {
      state: {
        cooldowns: { STOP_LOSS: d[8] },
        lastStopDate: d[8],
        ignore: { state: 'TAKE_PROFIT', navDate: d[8] },
      },
    },
  );
  assert.equal(r.state, 'STOP_LOSS');
  assert.equal(r.ignored, false); // ignore 是 TP、当前是 SL → 不匹配
});

test('74 忽略收敛：无 ignore 标记 → ignored 恒为布尔 false', () => {
  const d = mkDates(10, '2026-09-10');
  const navs = [0.98, 0.99, 1.0, 1.005, 1.01, 1.015, 1.02, 1.03, 1.04, 1.05];
  const r = evaluateExitStrategy(mkAsset(), mkSeries(d, navs), BASE, { state: {} });
  assert.equal(r.ignored, false); // 严格 false，非 undefined
});
