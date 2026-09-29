import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBuy } from '../js/calculator.js';

test('买入：本金和份额增加，成本价重算', () => {
  const state = { totalInvested: 1000, holdShares: 1000, costPrice: 1.0 };
  const tx = { type: 'buy', amount: 600, shares: 500 };
  const result = applyBuy(state, tx);
  assert.equal(result.totalInvested, 1600);
  assert.equal(result.holdShares, 1500);
  assert.equal(result.costPrice, 1600 / 1500);
});

test('买入：份额缺失（当日买入净值未公布）视为 0——本金照记、成本价暂虚高，补份额后重算修正', () => {
  const state = { totalInvested: 1000, holdShares: 1000, costPrice: 1.0 };
  const result = applyBuy(state, { type: 'buy', amount: 600, shares: null });
  assert.equal(result.totalInvested, 1600, '本金照记（钱已付出）');
  assert.equal(result.holdShares, 1000, '份额不动（待补）');
  assert.equal(result.costPrice, 1.6, '成本价暂虚高（1600/1000）');
  // 补份额 500 后重算：成本价回落到真实摊薄
  const fixed = applyBuy(result, { type: 'buy', amount: 0, shares: 500 });
  assert.equal(fixed.totalInvested, 1600);
  assert.equal(fixed.costPrice, 1600 / 1500);
});

import { applySell } from '../js/calculator.js';

test('卖出：按成本价反推卖出本金，本金和份额等比减少', () => {
  const state = { totalInvested: 1600, holdShares: 1500, costPrice: 1600 / 1500 };
  const tx = { type: 'sell', shares: 300 };
  const result = applySell(state, tx);
  const expectedSellCost = 300 * (1600 / 1500);
  assert.equal(result.totalInvested, 1600 - expectedSellCost);
  assert.equal(result.holdShares, 1200);
  // 成本价不变（等比减少）
  assert.ok(Math.abs(result.costPrice - state.costPrice) < 1e-9);
});

test('卖出：全部卖出后份额为0，成本价为0避免除零', () => {
  const state = { totalInvested: 1000, holdShares: 1000, costPrice: 1.0 };
  const tx = { type: 'sell', shares: 1000 };
  const result = applySell(state, tx);
  assert.equal(result.holdShares, 0);
  assert.equal(result.costPrice, 0);
});

import { applyDividend } from '../js/calculator.js';

test('现金分红：本金和份额都不变', () => {
  const state = { totalInvested: 1000, holdShares: 1000, costPrice: 1.0 };
  const tx = { type: 'dividend', method: 'cash' };
  const result = applyDividend(state, tx);
  assert.equal(result.totalInvested, 1000);
  assert.equal(result.holdShares, 1000);
  assert.equal(result.costPrice, 1.0);
});

test('红利再投：本金不变，份额增加，成本价摊薄', () => {
  const state = { totalInvested: 1000, holdShares: 1000, costPrice: 1.0 };
  const tx = { type: 'dividend', method: 'reinvest', shares: 50 };
  const result = applyDividend(state, tx);
  assert.equal(result.totalInvested, 1000);
  assert.equal(result.holdShares, 1050);
  assert.equal(result.costPrice, 1000 / 1050);
});

import { computeState } from '../js/calculator.js';
test('computeState：快照基线 + 多笔交易 → 完整状态', () => {
  const snapshot = {
    hold_amount: 10500,
    pending_amount: 0,
    cost_price: 1.05,
    hold_shares: 10000,
    total_invested: 10000, // 用户手动填入的累计投入本金
  };
  const transactions = [
    { type: 'buy', amount: 600, shares: 500, date: '2026-02-10' },
    { type: 'sell', shares: 300, date: '2026-03-15' },
    { type: 'dividend', method: 'reinvest', shares: 50, date: '2026-04-01' },
  ];
  const result = computeState(snapshot, transactions);
  // 基线本金 = 10000（手动填入，不用 cost_price×hold_shares 反推）
  // 买入后：本金=10600, 份额=10500, 成本价=10600/10500
  // 卖出300份：卖出本金=300*(10600/10500); 本金和份额减
  // 红利再投50份：本金不变，份额+50
  assert.ok(result.totalInvested > 0);
  assert.ok(result.holdShares > 0);
  assert.ok(result.costPrice > 0);
  // 持有收益 = holdAmount - totalInvested
  // holdAmount = 10500(快照) + 600(买入) - 300*(10600/10500)(卖出本金)
  assert.equal(typeof result.holdProfit, 'number');
  assert.equal(typeof result.lossRate, 'number');
});

test('computeState：无交易时返回快照基线状态', () => {
  // 本金由用户手动填入 total_invested，不靠 cost_price×hold_shares 反推
  const snapshot = {
    hold_amount: 5500,
    pending_amount: 0,
    cost_price: 1.1,
    hold_shares: 5000,
    total_invested: 5000,
  };
  const result = computeState(snapshot, []);
  assert.equal(result.totalInvested, 5000); // 用的是 total_invested，不是 1.1×5000=5500
  assert.equal(result.holdShares, 5000);
  assert.equal(result.costPrice, 1.1);
  assert.equal(result.holdAmount, 5500);
  assert.equal(result.holdProfit, 500); // 5500 - 5000 = 500（持有金额含利润）
  assert.equal(result.lossRate, -0.1); // (5000-5500)/5000 = -0.1，负值代表盈利 10%
});

test('computeState：交易按日期排序后叠加', () => {
  const snapshot = {
    hold_amount: 1000,
    pending_amount: 0,
    cost_price: 1.0,
    hold_shares: 1000,
    total_invested: 1000,
  };
  const transactions = [
    { type: 'buy', amount: 200, shares: 200, date: '2026-03-01' },
    { type: 'buy', amount: 100, shares: 100, date: '2026-02-01' },
  ];
  const result = computeState(snapshot, transactions);
  // 应先处理 02-01 的买入，再处理 03-01
  assert.equal(result.holdShares, 1300);
  assert.equal(result.totalInvested, 1300); // 1000 基线 + 200 + 100
});

// ---- 收益率维度：XIRR 年化 与 现金流构建 ----

import { computeXIRR, buildFundFlows } from '../js/calculator.js';

test('computeXIRR：一年 -100 → +110 ≈ +10%', () => {
  const r = computeXIRR([
    { date: '2025-08-31', amount: -100 },
    { date: '2026-08-31', amount: 110 },
  ]);
  assert.ok(Math.abs(r - 0.1) < 1e-3, '实际 ' + r);
});

test('computeXIRR：半年 -100 → +105 ≈ +10.5%（年化放大）', () => {
  const r = computeXIRR([
    { date: '2026-03-01', amount: -100 },
    { date: '2026-08-30', amount: 105 },
  ]);
  assert.ok(Math.abs(r - 0.105) < 0.003, '实际 ' + r);
});

test('computeXIRR：一年 -100 → +90 ≈ -10%', () => {
  const r = computeXIRR([
    { date: '2025-08-31', amount: -100 },
    { date: '2026-08-31', amount: 90 },
  ]);
  assert.ok(Math.abs(r + 0.1) < 1e-3, '实际 ' + r);
});

test('computeXIRR：全流出/空/单条 → null', () => {
  assert.equal(
    computeXIRR([
      { date: '2026-01-01', amount: -100 },
      { date: '2026-02-01', amount: -50 },
    ]),
    null,
  );
  assert.equal(computeXIRR([]), null);
  assert.equal(computeXIRR([{ date: '2026-01-01', amount: -100 }]), null);
});

test('buildFundFlows：基线本金(创建日)+买入+期末市值', () => {
  const fund = {
    id: 'fund_1756500000000',
    code: '110020',
    snapshot: { total_invested: 10000, hold_shares: 10000, cost_price: 1.0 },
    transactions: [{ type: 'buy', date: '2026-02-01', amount: 500, shares: 476 }],
  };
  const state = { holdShares: 10476, holdAmount: 11000 };
  const flows = buildFundFlows(fund, state, '2026-08-30');
  assert.equal(flows.length, 3);
  assert.equal(flows[0].amount, -10000); // 基线本金（流出）
  assert.match(flows[0].date, /^\d{4}-\d{2}-\d{2}$/); // 日期取自 id 创建时间戳
  assert.equal(flows[1].amount, -500); // 买入（流出）
  assert.equal(flows[2].amount, 11000); // 期末市值（流入）
  assert.equal(flows[2].date, '2026-08-30');
});

test('buildFundFlows：卖出按当时成本价收回，现金分红为流入，红利再投无现金流', () => {
  const fund = {
    id: 'fund_1756500000000',
    code: '161017',
    snapshot: { total_invested: 1600, hold_shares: 1500, cost_price: 1600 / 1500 },
    transactions: [
      { type: 'sell', date: '2026-03-15', shares: 300 },
      { type: 'dividend', method: 'cash', date: '2026-04-01', amount: 50 },
    ],
  };
  const state = { holdShares: 1200, holdAmount: 1300 };
  const flows = buildFundFlows(fund, state, '2026-08-30');
  const sell = flows.find((f) => f.date === '2026-03-15');
  assert.ok(Math.abs(sell.amount - 320) < 1e-6, '卖出收回=300×成本价'); // 300 × 1.0667
  const div = flows.find((f) => f.date === '2026-04-01');
  assert.equal(div.amount, 50);
  assert.equal(flows.filter((f) => f.amount < 0).length, 1); // 只有基线是流出
});

// ---- 行情口径：computeDailyProfit / applyQuote ----

import { computeDailyProfit, applyQuote, nextWorkdayOf } from '../js/calculator.js';

const offlineState = {
  totalInvested: 10000,
  holdShares: 10000,
  costPrice: 1.0,
};

test('nextWorkdayOf：净值日的下一个工作日（跳周末；到账口径 A 的单一实现）', () => {
  assert.equal(nextWorkdayOf('2026-08-28'), '2026-08-31'); // 周五 → 周一
  assert.equal(nextWorkdayOf('2026-08-27'), '2026-08-28'); // 周四 → 周五
  assert.equal(nextWorkdayOf('2026-08-31'), '2026-09-01'); // 周一 → 周二
  assert.equal(nextWorkdayOf('2026-01-02'), '2026-01-05'); // 跨年：周五 → 周一
});

test('computeDailyProfit：份额 × 涨跌额', () => {
  assert.equal(computeDailyProfit(10000, 0.02), 200);
  assert.equal(computeDailyProfit(10000, -0.01), -100);
  assert.equal(computeDailyProfit(0, 0.02), 0);
  assert.equal(computeDailyProfit(10000, null), null);
});

test('applyQuote：确认净值模式——当日/昨日收益用相邻净值差', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-28',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: null,
  };
  const r = applyQuote(offlineState, quote, '2026-08-30');
  assert.equal(r.dailyProfit, 200); // 10000 × (1.05−1.03)
  assert.equal(r.yesterdayProfit, 100); // 10000 × (1.03−1.02)
  assert.equal(r.dailyChangePct, 1.94);
  assert.equal(r.latestNav, 1.05);
  assert.equal(r.navDate, '2026-08-28');
  assert.equal(r.mode, 'confirmed');
});

test('applyQuote：盘中估值模式——当日收益用 estimate.nav − nav', () => {
  const quote = {
    nav: 1.03,
    nav_date: '2026-08-28',
    prev_nav: 1.02,
    prev2_nav: 1.01,
    change_pct: 0.98,
    prev_change_pct: 0.99,
    estimate: { nav: 1.05, change_pct: 1.94, time: '2026-08-30 14:00' },
  };
  const r = applyQuote(offlineState, quote, '2026-08-30');
  assert.equal(r.dailyProfit, 200); // 10000 × (1.05−1.03)，估值为今天 → 估值模式
  assert.equal(r.yesterdayProfit, 100); // 10000 × (1.03−1.02)
  assert.equal(r.latestNav, 1.05);
  assert.equal(r.mode, 'estimate');
});

test('applyQuote：估值时间非今天 → 按确认净值模式处理', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-28',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: { nav: 1.04, change_pct: 0.5, time: '2026-08-29 15:00' },
  };
  const r = applyQuote(offlineState, quote, '2026-08-30');
  assert.equal(r.mode, 'confirmed');
  assert.equal(r.dailyProfit, 200);
});

test('applyQuote：市值口径升级——holdAmount = 份额 × 最新净值，预警重算', () => {
  const quote = {
    nav: 0.95,
    nav_date: '2026-08-28',
    prev_nav: 1.0,
    prev2_nav: 1.01,
    change_pct: -5.0,
    prev_change_pct: -0.99,
    estimate: null,
  };
  const r = applyQuote(offlineState, quote, '2026-08-30');
  assert.equal(r.holdAmount, 9500); // 10000 × 0.95
  assert.equal(r.holdProfit, -500);
  assert.ok(Math.abs(r.lossRate - 0.05) < 1e-9);
});

test('applyQuote：change_pct 缺失（新基金仅一条净值）→ 收益字段为 null 不抛错', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-28',
    prev_nav: null,
    prev2_nav: null,
    change_pct: null,
    prev_change_pct: null,
    estimate: null,
  };
  const r = applyQuote(offlineState, quote, '2026-08-30');
  assert.equal(r.holdAmount, 10500);
  assert.equal(r.dailyProfit, null);
  assert.equal(r.yesterdayProfit, null);
  assert.equal(r.dailyChangePct, null);
});

test('applyQuote：当日/昨日展示字段按到账口径（QDII 以"下一工作日"为到账日）', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-28',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: null,
  };
  const QDII_NAME = '演示全球科技精选(QDII)C';
  // 跨周末到账（周一查周五净值，2026-08-28 五 → 08-31 一）：到账日就是今天 → 当日列 = 新到账收益
  // （到账判据须覆盖跨周末，否则当日列误显「待更新」）
  const w = applyQuote(offlineState, quote, '2026-08-31', QDII_NAME);
  assert.equal(w.dayProfit, 200); // 10000 × (1.05−1.03) 按到账日计入当日
  assert.equal(w.dayChangePct, 1.94); // 涨幅仍是该净值日自己的
  assert.equal(w.prevDayProfit, 100); // 昨日 = 再前一天变动
  // 到账日已过（逾两日未推进，如净值停更）→ 当日/昨日列都无值（待更新）
  const lagged = applyQuote(offlineState, quote, '2026-09-02', QDII_NAME);
  assert.equal(lagged.dayProfit, null);
  assert.equal(lagged.dayChangePct, null);
  assert.equal(lagged.prevDayProfit, null);
  // QDII 净值日期是昨天（T+1 补发）：当日列 = 新到账收益 + 该净值日涨幅；昨日列 = 再前一天
  const y = applyQuote(offlineState, { ...quote, nav_date: '2026-08-30' }, '2026-08-31', QDII_NAME);
  assert.equal(y.dayProfit, 200); // 10000 × (1.05−1.03) 按到账日计入当日
  assert.equal(y.dayChangePct, 1.94); // 涨幅仍是该净值日自己的
  assert.equal(y.prevDayProfit, 100); // 昨日 = 再前一天变动
  // 净值日期就是今天 → 当日列正常，昨日列 = 相邻净值差
  const t = applyQuote(offlineState, { ...quote, nav_date: '2026-08-31' }, '2026-08-31', QDII_NAME);
  assert.equal(t.dayProfit, 200);
  assert.equal(t.dayChangePct, 1.94);
  assert.equal(t.prevDayProfit, 100); // 10000 × (1.03−1.02)
});

test('applyQuote：到账口径只对 QDII 生效——国内基金周五净值周一查看仍「待更新」', () => {
  // 国内基金净值当晚公布：周一白天查到的最新净值仍是上周五的，属"最新净值日"而非"新到账"
  // （若把到账口径误用到国内基金，周一会把上周五的变动重复算进当日）
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-28',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: null,
  };
  const r = applyQuote(offlineState, quote, '2026-08-31', '演示沪深300ETF联接A');
  assert.equal(r.dayProfit, null);
  assert.equal(r.dayChangePct, null);
  assert.equal(r.prevDayProfit, null);
  assert.equal(r.dailyProfit, 200); // 最近净值日变动仍可取（汇总层「上一净值日」回退用）
});

test('applyQuote：QDII 忽略一切估值源（含新浪兜底），只走确认净值', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-30',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: { nav: 1.04, change_pct: 0.97, time: '2026-08-31 15:00' }, // 即使给了估值也不采用
  };
  const r = applyQuote(offlineState, quote, '2026-08-31', '演示QDII');
  assert.equal(r.mode, 'confirmed');
  assert.equal(r.latestNav, 1.05);
  assert.equal(r.dayProfit, 200); // 到账口径：新到账的确认收益计入当日
  assert.equal(r.dayChangePct, 1.94);
  assert.equal(r.prevDayProfit, 100);
});

test('applyQuote：有估值品种（估值过期）净值日期为昨天 → 当日待更新、昨日 = 最新确认变动', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-30',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: { nav: 1.04, change_pct: 0.97, time: '2026-08-30 15:00' }, // 估值属于昨天（过期）
  };
  const r = applyQuote(offlineState, quote, '2026-08-31');
  assert.equal(r.mode, 'confirmed');
  assert.equal(r.dayProfit, null); // 国内基金：今天净值未发布 → 当日待更新
  assert.equal(r.dayChangePct, null);
  assert.equal(r.prevDayProfit, 200); // 昨日 = 最新确认净值日的变动
});

test('applyQuote：盘中估值属于今天 → 当日列按估值展示', () => {
  const quote = {
    nav: 1.03,
    nav_date: '2026-08-28',
    prev_nav: 1.02,
    prev2_nav: 1.01,
    change_pct: 0.98,
    prev_change_pct: 0.99,
    estimate: { nav: 1.05, change_pct: 1.9417, time: '2026-08-31 14:00' },
  };
  const r = applyQuote(offlineState, quote, '2026-08-31');
  assert.equal(r.dayProfit, 200);
  assert.equal(r.dayChangePct, 1.9417); // 估值模式涨幅 = changePct(1.05, 1.03)
  assert.equal(r.prevDayProfit, 100); // 昨日 = nav − prev_nav
});

test('applyQuote：确认净值已发布到当天 → 估值让位于确认净值（confirmed）', () => {
  const quote = {
    nav: 1.05,
    nav_date: '2026-08-31',
    prev_nav: 1.03,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: { nav: 1.06, change_pct: 2.91, time: '2026-08-31 15:00' },
  };
  const r = applyQuote(offlineState, quote, '2026-08-31');
  assert.equal(r.mode, 'confirmed');
  assert.equal(r.latestNav, 1.05); // 用确认净值而不是估值
  assert.equal(r.dataDate, '2026-08-31');
  assert.equal(r.dailyProfit, 200);
  assert.equal(r.estimateTime, null);
  assert.equal(r.confirmedNav, null);
});

test('applyQuote：估值模式输出 dataDate=今天 与 估值时间/确认净值 展示字段', () => {
  const quote = {
    nav: 1.03,
    nav_date: '2026-08-28',
    prev_nav: 1.02,
    prev2_nav: 1.01,
    change_pct: 0.98,
    prev_change_pct: 0.99,
    estimate: { nav: 1.05, change_pct: 1.9417, time: '2026-08-31 14:30' },
  };
  const r = applyQuote(offlineState, quote, '2026-08-31');
  assert.equal(r.mode, 'estimate');
  assert.equal(r.dataDate, '2026-08-31'); // "当日数据"属于今天（估值）
  assert.equal(r.navDate, '2026-08-28'); // 确认净值日期保持不变
  assert.equal(r.estimateTime, '2026-08-31 14:30');
  assert.equal(r.confirmedNav, 1.03);
  assert.equal(r.dayProfit, 200);
});

import { findDuplicateTrade } from '../js/calculator.js';

// ---- 重复交易判重 ----

test('findDuplicateTrade：买入同指纹命中，字段差异不算重', () => {
  const list = [
    { type: 'buy', date: '2026-08-20', amount: 500, shares: 265.12 },
    { type: 'sell', date: '2026-08-20', shares: 100 },
  ];
  assert.equal(
    findDuplicateTrade(list, { type: 'buy', date: '2026-08-20', amount: 500, shares: 265.12 }),
    0,
  );
  assert.equal(
    findDuplicateTrade(list, { type: 'buy', date: '2026-08-20', amount: 501, shares: 265.12 }),
    -1,
  ); // 金额不同
  assert.equal(
    findDuplicateTrade(list, { type: 'buy', date: '2026-08-21', amount: 500, shares: 265.12 }),
    -1,
  ); // 日期不同
});

test('findDuplicateTrade：卖出按份额、分红按方式+金额/份额判重；类型不同不算重', () => {
  const list = [
    { type: 'sell', date: '2026-08-21', shares: 100 },
    { type: 'dividend', date: '2026-08-22', amount: 30.5, method: 'cash' },
    { type: 'dividend', date: '2026-08-23', shares: 15.2, method: 'reinvest' },
  ];
  assert.equal(findDuplicateTrade(list, { type: 'sell', date: '2026-08-21', shares: 100 }), 0);
  assert.equal(
    findDuplicateTrade(list, {
      type: 'dividend',
      date: '2026-08-22',
      amount: 30.5,
      method: 'cash',
    }),
    1,
  );
  assert.equal(
    findDuplicateTrade(list, {
      type: 'dividend',
      date: '2026-08-23',
      shares: 15.2,
      method: 'reinvest',
    }),
    2,
  );
  assert.equal(
    findDuplicateTrade(list, { type: 'dividend', date: '2026-08-23', shares: 15.2 }),
    -1,
  ); // method 缺失视为 null ≠ reinvest
  assert.equal(
    findDuplicateTrade(list, { type: 'buy', date: '2026-08-21', amount: 100, shares: 100 }),
    -1,
  ); // 类型不同不算重
});

test('findDuplicateTrade：excludeIdx 排除自身（编辑模式），空列表返回 -1', () => {
  const list = [{ type: 'buy', date: '2026-08-20', amount: 500, shares: 265.12 }];
  assert.equal(
    findDuplicateTrade(list, { type: 'buy', date: '2026-08-20', amount: 500, shares: 265.12 }, 0),
    -1,
  );
  assert.equal(
    findDuplicateTrade([], { type: 'buy', date: '2026-08-20', amount: 1, shares: 1 }),
    -1,
  );
});

import {
  missingTradeFields,
  buildEmptyFundAsset,
  unifyTradeMeta,
  creationDateFromId,
} from '../js/calculator.js';

// ---- 交易字段完整性（批量入库闸门）----

test('missingTradeFields：买入必须金额+份额，卖出必须份额，分红按方式要求', () => {
  assert.deepEqual(missingTradeFields({ type: 'buy', amount: 500, shares: 265 }), []);
  assert.deepEqual(missingTradeFields({ type: 'buy', amount: 500, shares: null }), ['shares']);
  assert.deepEqual(missingTradeFields({ type: 'buy', amount: null, shares: null }), [
    'amount',
    'shares',
  ]);
  assert.deepEqual(missingTradeFields({ type: 'sell', shares: 100 }), []);
  assert.deepEqual(missingTradeFields({ type: 'sell', shares: undefined }), ['shares']);
  assert.deepEqual(missingTradeFields({ type: 'dividend', method: 'cash', amount: 30.5 }), []);
  assert.deepEqual(missingTradeFields({ type: 'dividend', method: 'cash', amount: null }), [
    'amount',
  ]);
  assert.deepEqual(missingTradeFields({ type: 'dividend', method: 'reinvest', shares: 15 }), []);
  assert.deepEqual(missingTradeFields({ type: 'dividend', method: 'reinvest', shares: null }), [
    'shares',
  ]);
  assert.deepEqual(missingTradeFields({ type: 'buy', amount: 100, shares: NaN }), ['shares']);
});

test('buildEmptyFundAsset：零快照持仓，id 带时间戳与 code 后缀，XIRR 基线回落首笔交易日期', () => {
  const a = buildEmptyFundAsset({ code: '110020', name: '新基金' }, 1756700000000);
  assert.equal(a.code, '110020');
  assert.equal(a.name, '新基金');
  assert.equal(a.asset_type, 'fund');
  assert.deepEqual(a.snapshot, {
    hold_amount: 0,
    pending_amount: 0,
    cost_price: 0,
    hold_shares: 0,
    total_invested: 0,
  });
  assert.deepEqual(a.transactions, []);
  assert.equal(a.id, 'fund_1756700000000_110020');
  // creationDateFromId 无法解析该 id → null → XIRR 基线自动用首笔交易日期
  assert.equal(creationDateFromId(a.id), null);
  // 缺名称时用 code 兜底
  assert.equal(buildEmptyFundAsset({ code: '110020' }, 1).name, '110020');
});

test('buildEmptyFundAsset：零快照 + 交易历史可驱动 computeState（本金=买入合计、份额=买入份额）', () => {
  const a = buildEmptyFundAsset({ code: '110020', name: '新基金' }, 1);
  a.transactions.push(
    { type: 'buy', amount: 100, shares: 50, date: '2026-08-01' },
    { type: 'buy', amount: 200, shares: 90, date: '2026-08-02' },
  );
  const s = computeState(a.snapshot, a.transactions);
  assert.equal(s.totalInvested, 300);
  assert.equal(s.holdShares, 140);
});

test('unifyTradeMeta：code/name 为 null 的行用唯一非空值补齐；多值不补', () => {
  const trades = [
    { code: '110020', name: '演示数字经济混合A', type: 'buy', amount: 100 },
    { code: null, name: null, type: 'buy', amount: 200 },
    { code: null, name: '演示数字经济混合A', type: 'buy', amount: 300 },
  ];
  const r = unifyTradeMeta(trades);
  assert.equal(r[0].code, '110020');
  assert.equal(r[1].code, '110020'); // 补 code
  assert.equal(r[1].name, '演示数字经济混合A'); // 补 name
  assert.equal(r[2].code, '110020');
  // 多只基金混合时不做任何补齐
  const multi = unifyTradeMeta([
    { code: '110020', name: null, type: 'buy', amount: 1 },
    { code: '110020', name: null, type: 'buy', amount: 2 },
  ]);
  assert.equal(multi[0].name, null);
  assert.equal(multi[1].name, null);
  assert.deepEqual(unifyTradeMeta([]), []);
  assert.deepEqual(unifyTradeMeta(null), []);
});

import { normalizeFundName, pickFundCode } from '../js/calculator.js';

test('normalizeFundName：去空白、全角括号转半角', () => {
  assert.equal(normalizeFundName(' 演示 全球科技 (QDII) C '), '演示全球科技(QDII)C');
  assert.equal(normalizeFundName('演示全球（QDII）C'), '演示全球(QDII)C');
  assert.equal(normalizeFundName(''), '');
  assert.equal(normalizeFundName(null), '');
});

test('pickFundCode：名称精确相等（含全角括号归一）直接选中', () => {
  const results = [
    { code: '110025', name: '演示全球科技精选(QDII)A' },
    { code: '161017', name: '演示沪深300指数增强(A)' },
  ];
  assert.equal(pickFundCode('演示沪深300指数增强（A）', results), '161017');
  assert.equal(pickFundCode('演示全球科技精选(QDII)A', results), '110025');
});

test('pickFundCode：OCR 名称少字但以份额字母结尾（C）→ 唯一同尾字母候选选中', () => {
  const results = [
    { code: '110025', name: '演示全球科技精选(QDII)A' },
    { code: '161017', name: '演示沪深300指数增强A' },
  ];
  // 真实场景：单笔截图 OCR 名称缺"发起式"，模型返回 code:null
  assert.equal(pickFundCode('演示沪深300指数增强A', results), '161017');
});

test('pickFundCode：候选唯一时直接用；候选多条且无法消歧时返回 null（宁可不填也不填错）', () => {
  assert.equal(pickFundCode('某基金', [{ code: '110020', name: '某基金' }]), '110020');
  const two = [
    { code: '110025', name: '演示全球科技精选(QDII)A' },
    { code: '161017', name: '演示沪深300指数增强A' },
  ];
  assert.equal(pickFundCode('演示全球科技精选', two), null); // 无尾字母、两条候选
  assert.equal(pickFundCode('某基金', []), null);
  assert.equal(pickFundCode('', two), null);
  // 非法代码候选被过滤
  assert.equal(pickFundCode('某基金', [{ code: 'abc', name: '某基金' }]), null);
});

// 行情口径市值先按分舍入（与支付宝两位市值对齐）：半分中间值不让收益差一分
test('applyQuote 市值按分舍入：50份×1.8369=91.845 → 收益按 91.85 计（-50.99 而非 -51.00）', () => {
  const state = computeState(
    {
      hold_amount: 91.85,
      pending_amount: 0,
      cost_price: 2.8834,
      hold_shares: 50,
      total_invested: 142.84,
    },
    [],
  );
  const q = applyQuote(
    state,
    {
      nav: 1.8369,
      nav_date: '2026-09-04',
      prev_nav: 1.8569,
      prev2_nav: 1.86,
      change_pct: -1.08,
    },
    '2026-09-06',
    '演示医疗健康混合C',
  );
  assert.ok(Math.abs(q.holdAmount - 91.85) < 1e-9); // 91.845 → 按分舍入
  assert.ok(Math.abs(q.holdProfit - -50.99) < 1e-9); // 而非 -51.00（展示层 toFixed(2) 即 -50.99）
});
