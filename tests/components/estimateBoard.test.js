import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEstimateBoard } from '../../js/components/estimateBoard.js';

const TODAY = '2026-09-10';
// applyQuote 估值模式产物（国内基金：估值净值 1.5420、源报涨幅 +1.23%、估值时间今天 14:32、最近确认净值 1.5233）
const estState = {
  mode: 'estimate',
  dataDate: TODAY,
  latestNav: 1.542,
  dailyChangePct: 1.23,
  dayProfit: 58.7,
  dayChangePct: 1.23,
  holdShares: 3120.5,
  holdAmount: 4811.81,
  holdProfit: -188.19,
  totalInvested: 5000,
  lossRate: 0.0376,
  estimateTime: '2026-09-10 14:32',
  confirmedNav: 1.5233,
  navDate: '2026-09-09',
  prevDayProfit: -12.4,
};
const estQuote = {
  code: '110020',
  name: '演示沪深300ETF联接A',
  nav: 1.5233,
  nav_date: '2026-09-09',
  prev_nav: 1.5299,
  change_pct: -0.43,
  estimate: { nav: 1.542, change_pct: 1.23, time: '2026-09-10 14:32' },
  source: 'eastmoney',
  fetched_at: '2026-09-10T06:32:10.000Z',
};

test('估值盘：估值模式——主数字取估值净值、标注估值中、给出每份涨跌额与源标签', () => {
  const b = buildEstimateBoard(estState, estQuote, { today: TODAY, name: '演示沪深300ETF联接A' });
  assert.equal(b.status, 'estimate');
  assert.equal(b.statusLabel, '估值中');
  assert.equal(b.mainNav, 1.542);
  assert.equal(b.mainIsEstimate, true);
  assert.equal(b.mainChangePct, 1.23);
  assert.equal(b.navDelta, 0.0187); // 1.542 - 1.5233，四位小数
  assert.equal(b.dayProfit, 58.7);
  assert.equal(b.confirmedNav, 1.5233);
  assert.equal(b.confirmedNavDate, '2026-09-09');
  assert.equal(b.estimateTime, '2026-09-10 14:32');
  assert.equal(b.sourceLabel, '天天基金');
  assert.equal(b.hasQuote, true);
  assert.match(b.statusNote, /官方净值今日晚间/);
});

test('估值盘：今日确认净值已发布 → confirmed，主数字为确认净值且不再标估值', () => {
  const s = {
    ...estState,
    mode: 'confirmed',
    latestNav: 1.5233,
    dailyChangePct: -0.43,
    estimateTime: null,
    dataDate: TODAY,
  };
  const b = buildEstimateBoard(
    s,
    { ...estQuote, nav_date: TODAY },
    { today: TODAY, name: '演示沪深300ETF联接A' },
  );
  assert.equal(b.status, 'confirmed');
  assert.equal(b.statusLabel, '已更新');
  assert.equal(b.mainIsEstimate, false);
  assert.equal(b.mainNav, 1.5233);
  assert.match(b.statusNote, /估值已让位/);
});

test('估值盘：净值滞后品种（QDII 新到账）→ lagged，注明按其净值日口径', () => {
  const s = {
    ...estState,
    mode: 'confirmed',
    latestNav: 1.1142,
    dailyChangePct: 1.02,
    estimateTime: null,
    dataDate: '2026-09-09',
  };
  const b = buildEstimateBoard(s, estQuote, { today: TODAY, name: '演示全球科技精选(QDII)C' });
  assert.equal(b.status, 'lagged');
  assert.equal(b.statusLabel, '净值滞后到账');
  assert.equal(b.isQdii, true);
  assert.match(b.statusNote, /净值日 2026-09-09/);
});

test('估值盘：pending 分三种原因——QDII / 未拉到行情 / 有行情但无估值且净值未出', () => {
  const base = {
    ...estState,
    mode: 'confirmed',
    dataDate: '2026-09-09',
    dailyChangePct: null,
    dayProfit: null,
    dayChangePct: null,
    latestNav: 1.5233,
  };
  const qdii = buildEstimateBoard(base, estQuote, { today: TODAY, name: '某某(QDII)' });
  assert.equal(qdii.status, 'pending');
  assert.match(qdii.statusNote, /QDII 基金不使用盘中估值/);

  const noQuote = buildEstimateBoard(base, undefined, { today: TODAY, name: '演示医疗健康混合C' });
  assert.equal(noQuote.status, 'pending');
  assert.equal(noQuote.hasQuote, false);
  assert.equal(noQuote.mainNav, 1.5233); // 仍给出最近确认净值
  assert.match(noQuote.statusNote, /尚未拉到行情/);

  const noEst = buildEstimateBoard(
    base,
    { ...estQuote, estimate: null },
    { today: TODAY, name: '演示医疗健康混合C' },
  );
  assert.equal(noEst.status, 'pending');
  assert.match(noEst.statusNote, /暂无盘中估值数据/);
  assert.equal(noEst.sourceLabel, '天天基金');
});

test('估值盘：入参容错——state 缺失返回 null；quote 缺 nav 时 navDelta 为 null；未知源原样透出', () => {
  assert.equal(buildEstimateBoard(null, estQuote, { today: TODAY }), null);
  const noNavQuote = { ...estQuote };
  delete noNavQuote.nav;
  const b = buildEstimateBoard(estState, noNavQuote, { today: TODAY, name: 'X' });
  assert.equal(b.navDelta, null);
  const c = buildEstimateBoard(
    estState,
    { ...estQuote, source: 'weird' },
    { today: TODAY, name: 'X' },
  );
  assert.equal(c.sourceLabel, 'weird');
});
