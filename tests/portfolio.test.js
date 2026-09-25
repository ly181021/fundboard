/**
 * 收益页汇总层纯函数测试（对应 js/portfolio.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_GROUPS,
  buildPortfolioSummary,
  alignGroupsToTotal,
  sliceSeries,
  twrIndex,
  resolveSellProceeds,
  buildRealizedProfit,
  buildPortfolioFlows,
  rangeStats,
  dayProfitState,
} from '../js/portfolio.js';

const fund = (over = {}) => ({ assetType: 'fund', ...over });

/* ==================== buildPortfolioSummary ==================== */

test('summary：空持仓 → total 全 null、supported 组 sharePct 全 0（防 NaN%）、未支持组 null', () => {
  const s = buildPortfolioSummary([]);
  assert.equal(s.total.invested, null);
  assert.equal(s.total.value, null);
  assert.equal(s.total.returnRate, null);
  assert.equal(s.total.cumulativeProfit, null);
  assert.equal(s.groups.length, SOURCE_GROUPS.length);
  for (const g of s.groups) {
    assert.equal(g.sharePct, g.supported ? 0 : null); // total.value=0 → 0，不得 NaN；未支持组保持 null
  }
});

test('summary：单来源 → fund 组承接、未支持分组全 null（M5 不显示 0）', () => {
  const s = buildPortfolioSummary([fund({ invested: 1000, value: 1100, holdProfit: 100 })]);
  const f = s.groups.find((g) => g.key === 'fund');
  assert.equal(f.invested, 1000);
  assert.equal(f.value, 1100);
  assert.equal(f.holdProfit, 100);
  assert.equal(f.sharePct, 100);
  assert.equal(f.returnRate, 0.1);
  const gold = s.groups.find((g) => g.key === 'gold_etf');
  for (const k of [
    'invested',
    'value',
    'holdProfit',
    'dailyProfit',
    'dayProfit',
    'prevDayProfit',
    'returnRate',
    'sharePct',
  ]) {
    assert.equal(gold[k], null, `gold_etf.${k} 应为 null`);
  }
});

test('summary：多来源合计 = 总计，sharePct 合计 100%（含舍入尾差并入）', () => {
  // 1/3 + 1/3 + 1/3 → 每组 33.33，合计 99.99 → 尾差 0.01 并入最大组
  const states = [
    fund({ invested: 100, value: 100 }),
    fund({ invested: 100, value: 100 }),
    fund({ invested: 100, value: 100.01 }),
  ];
  const s = buildPortfolioSummary(states);
  const pctSum = s.groups.filter((g) => g.supported).reduce((a, g) => a + g.sharePct, 0);
  assert.equal(Math.round(pctSum * 100) / 100, 100);
  const moneySum = s.groups.reduce((a, g) => a + (g.value ?? 0), 0);
  assert.equal(Math.round(moneySum * 100) / 100, s.total.value);
});

test('summary：金额尾差并入绝对值最大的分组（alignGroupsToTotal 直测，含负数）', () => {
  const total = {
    invested: 300.01,
    value: 300.01,
    holdProfit: -0.03,
    dailyProfit: null,
    dayProfit: null,
    prevDayProfit: null,
  };
  const groups = [
    { supported: true, invested: 100, value: 100, holdProfit: -0.01 },
    { supported: true, invested: 200, value: 200, holdProfit: -0.01 },
  ];
  const aligned = alignGroupsToTotal(groups, total);
  assert.equal(Math.round(aligned.reduce((a, g) => a + g.invested, 0) * 100) / 100, total.invested);
  // holdProfit 负数：尾差 -0.01 并入 |−0.01| 最大的首个
  assert.equal(Math.round(aligned.reduce((a, g) => a + g.holdProfit, 0) * 100) / 100, -0.03);
});

test('summary：prevDayProfit 逐基金回退（周一盘前 null → dailyProfit 兜底）', () => {
  const s = buildPortfolioSummary([
    fund({ invested: 100, value: 110, holdProfit: 10, prevDayProfit: null, dailyProfit: 5 }),
    fund({ invested: 100, value: 105, holdProfit: 5, prevDayProfit: 3, dailyProfit: 2 }),
  ]);
  assert.equal(s.total.prevDayProfit, 8); // (null→5) + 3
  assert.equal(s.total.dayProfit, null); // 全 null → null（不是 0）
});

test('summary：cumulativeProfit 注入组合与 null 传播', () => {
  const states = [fund({ invested: 100, value: 110, holdProfit: 10 })];
  assert.equal(buildPortfolioSummary(states).total.cumulativeProfit, null);
  assert.equal(
    buildPortfolioSummary(states, { totalRealizedProfit: 90 }).total.cumulativeProfit,
    100,
  );
  assert.equal(
    buildPortfolioSummary(states, { totalRealizedProfit: null }).total.cumulativeProfit,
    null,
  );
});

test('summary：total 仅含 supported 分组（未支持行不计入，不变量 B）', () => {
  const s = buildPortfolioSummary([
    fund({ invested: 100, value: 110, holdProfit: 10 }),
    { assetType: 'gold_etf', invested: 999, value: 999, holdProfit: 999 },
  ]);
  assert.equal(s.total.value, 110);
  const pctSum = s.groups.filter((g) => g.supported).reduce((a, g) => a + g.sharePct, 0);
  assert.equal(pctSum, 100);
});

/* ==================== twrIndex（T1 自检三例 + 边界） ==================== */

test('twr：自检① 清仓上涨日收益保留（+10% 不被抹杀）', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-15', total_assets: 0 }, // 当日涨到 110 后全赎（F=-110）
  ];
  const idx = twrIndex(series, [{ date: '2026-09-15', amount: -110 }]);
  assert.ok(Math.abs(idx[1].nav - 1.1) < 1e-6, `I=1.1 实得 ${idx[1].nav}`);
});

test('twr：自检② 大额减仓不放大（-20% 真实传导）', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-15', total_assets: 32 }, // 跌 20% 后赎回 48（F=-48）
  ];
  const idx = twrIndex(series, [{ date: '2026-09-15', amount: -48 }]);
  assert.ok(Math.abs(idx[1].nav - 0.8) < 1e-6, `I=0.8 实得 ${idx[1].nav}`);
});

test('twr：自检③ 大额申购不稀释（+10% 真实传导）', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-15', total_assets: 160 }, // 涨 10% 后申购 50（F=+50）
  ];
  const idx = twrIndex(series, [{ date: '2026-09-15', amount: 50 }]);
  assert.ok(Math.abs(idx[1].nav - 1.1) < 1e-6, `I=1.1 实得 ${idx[1].nav}`);
});

test('twr：除息日分红回加（现金分红不计为亏损）', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-15', total_assets: 98 }, // 除息 3 元 + 净值波动 1 元（真实 +1%）
  ];
  const idx = twrIndex(series, [{ date: '2026-09-15', amount: -3 }]);
  assert.ok(Math.abs(idx[1].nav - 1.01) < 1e-6, `I=1.01 实得 ${idx[1].nav}`);
});

test('twr：A_{t-1}=0（首笔入金日/清仓后再起）→ 当日 r=0', () => {
  const series = [
    { date: '2026-09-14', total_assets: 0 },
    { date: '2026-09-15', total_assets: 100 }, // 首笔入金 100（F=+100），当日无收益
    { date: '2026-09-16', total_assets: 110 },
  ];
  const idx = twrIndex(series, [{ date: '2026-09-15', amount: 100 }]);
  assert.equal(idx[0].nav, 1);
  assert.equal(idx[1].nav, 1); // 入金日 r=0
  assert.ok(Math.abs(idx[2].nav - 1.1) < 1e-6);
});

test('twr：无现金流时退化为普通收益率序列', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-15', total_assets: 105 },
  ];
  const idx = twrIndex(series, []);
  assert.ok(Math.abs(idx[1].nav - 1.05) < 1e-6);
});

test('twr：归属日不在序列轴上 → 前滚到下一序列日（防御）', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-16', total_assets: 110 },
  ];
  const idx = twrIndex(series, [{ date: '2026-09-15', amount: 0 }]); // 空隙日零流不影响
  assert.ok(Math.abs(idx[1].nav - 1.1) < 1e-6);
});

/* ==================== resolveSellProceeds（量纲 + 恢复链） ==================== */

test('proceeds：① tx.amount 直接返回（金额，不乘份额）', () => {
  const p = resolveSellProceeds(
    { type: 'sell', date: '2026-09-15', shares: 4000, amount: 5000 },
    [],
    {},
  );
  assert.equal(p, 5000);
});

test('proceeds：② 首次体现行恢复 (assets÷shares)×tx.shares', () => {
  const logRows = [
    { date: '2026-09-14', navDate: '2026-09-14', invested: 1000, assets: 1000, shares: 1000 },
    { date: '2026-09-15', navDate: '2026-09-15', invested: 500, assets: 625, shares: 500 }, // 卖 500 份，净值 1.25
  ];
  const p = resolveSellProceeds({ type: 'sell', date: '2026-09-15', shares: 500 }, logRows, {});
  assert.equal(p, 625); // 1.25 × 500
});

test('proceeds：③ 全部清仓走历史净值，QDII 按日志行 navDate 查（非 tx.date）', () => {
  const logRows = [
    { date: '2026-09-16', navDate: '2026-09-15', invested: 0, assets: 0, shares: 0 }, // QDII：T 日净值 T+1 入账
  ];
  const history = { '2026-09-15': 1.25, '2026-09-14': 1.2 };
  const p = resolveSellProceeds(
    { type: 'sell', date: '2026-09-14', shares: 4000 },
    logRows,
    history,
  );
  assert.equal(p, 5000); // 1.25（navDate 09-15）× 4000，而非 tx.date 的 1.2
});

test('proceeds：无日志行可依 → 回退 tx.date 查历史净值；查不到 → null（T4）', () => {
  assert.equal(
    resolveSellProceeds({ type: 'sell', date: '2026-09-14', shares: 100 }, [], {
      '2026-09-14': 1.5,
    }),
    150,
  );
  assert.equal(
    resolveSellProceeds({ type: 'sell', date: '2026-09-14', shares: 100 }, [], {}),
    null,
  );
  assert.equal(
    resolveSellProceeds({ type: 'sell', date: '2026-09-14', shares: null }, [], {
      '2026-09-14': 1.5,
    }),
    null,
  );
});

test('proceeds：amount 为 0 是合法值（finite），不得跳 ②③', () => {
  const p = resolveSellProceeds({ type: 'sell', date: '2026-09-15', shares: 100, amount: 0 }, [], {
    '2026-09-15': 9.9,
  });
  assert.equal(p, 0);
});

/* ==================== buildRealizedProfit / buildPortfolioFlows ==================== */

test('realized：纯买入 → 0；卖出获利计入', () => {
  const snap = { total_invested: 0, hold_shares: 0, cost_price: 0 };
  const base = { snapshot: snap, logRows: [], historyNavByDate: {} };
  assert.equal(
    buildRealizedProfit({
      ...base,
      transactions: [{ type: 'buy', date: '2026-09-10', amount: 1000, shares: 1000 }],
    }),
    0,
  );
  // 买入 1000 份 @1 → 卖 500 份 @1.25（amount 记账）→ realized = 625 − 500 = 125
  assert.equal(
    buildRealizedProfit({
      ...base,
      transactions: [
        { type: 'buy', date: '2026-09-10', amount: 1000, shares: 1000 },
        { type: 'sell', date: '2026-09-15', shares: 500, amount: 625 },
      ],
    }),
    125,
  );
});

test('realized：现金分红计入、红利再投资不计入、卖出亏损为负', () => {
  const snap = { total_invested: 0, hold_shares: 0, cost_price: 0 };
  const base = { snapshot: snap, logRows: [], historyNavByDate: {} };
  assert.equal(
    buildRealizedProfit({
      ...base,
      transactions: [
        { type: 'buy', date: '2026-09-10', amount: 1000, shares: 1000 },
        { type: 'dividend', date: '2026-09-12', method: 'cash', amount: 50 },
        { type: 'sell', date: '2026-09-15', shares: 1000, amount: 900 },
      ],
    }),
    -50,
  ); // (900−1000) + 50
  assert.equal(
    buildRealizedProfit({
      ...base,
      transactions: [
        { type: 'buy', date: '2026-09-10', amount: 1000, shares: 1000 },
        { type: 'dividend', date: '2026-09-12', method: 'reinvest', shares: 50 },
      ],
    }),
    0,
  ); // 再投不计入
});

test('realized：卖出所得不可得（交易不全）→ null（T4）', () => {
  const snap = { total_invested: 0, hold_shares: 0, cost_price: 0 };
  const p = buildRealizedProfit({
    snapshot: snap,
    logRows: [],
    historyNavByDate: {},
    transactions: [
      { type: 'buy', date: '2026-09-10', amount: 1000, shares: 1000 },
      { type: 'sell', date: '2026-09-15', shares: 500 }, // 无 amount、无日志、无历史
    ],
  });
  assert.equal(p, null);
});

test('flows：买入为正流入、卖出所得为负、分红为负；归属按首次体现行 navDate', () => {
  const snap = { total_invested: 0, hold_shares: 0, cost_price: 0 };
  const logRows = [
    { date: '2026-09-14', navDate: '2026-09-14', invested: 1000, assets: 1000, shares: 1000 }, // 买入体现行
    { date: '2026-09-16', navDate: '2026-09-15', invested: 500, assets: 625, shares: 500 }, // 卖出体现行（QDII：T+1 入账）
  ];
  const f = buildPortfolioFlows({
    snapshot: snap,
    logRows,
    historyNavByDate: {},
    transactions: [
      { type: 'buy', date: '2026-09-14', amount: 1000, shares: 1000 },
      { type: 'sell', date: '2026-09-15', shares: 500, amount: 625 },
      { type: 'dividend', date: '2026-09-15', method: 'cash', amount: 10 },
    ],
  });
  // 买入归属 09-14（首次体现行）；卖出归属首次体现行 navDate=09-15；分红按 tx.date
  assert.deepEqual(f, [
    { date: '2026-09-14', amount: 1000 },
    { date: '2026-09-15', amount: -625 },
    { date: '2026-09-15', amount: -10 },
  ]);
});

/* ==================== sliceSeries / rangeStats ==================== */

const mkSeries = (dates) => dates.map((d, i) => ({ date: d, total_assets: 100 + i * 10 }));

test('slice：恰好等于档位天数 / 少一天 / baselinePoint 提取', () => {
  const s = mkSeries(['2026-08-01', '2026-08-02', '2026-08-15', '2026-08-30', '2026-08-31']);
  const r30 = sliceSeries(s, 30); // t0 = 08-02（31 − 29）
  assert.deepEqual(
    r30.series.map((p) => p.date),
    ['2026-08-02', '2026-08-15', '2026-08-30', '2026-08-31'],
  );
  assert.equal(r30.baselinePoint.date, '2026-08-01');
  const r90 = sliceSeries(s, 90);
  assert.equal(r90.baselinePoint, null);
  assert.equal(r90.series.length, 5);
});

test('slice：样本不足返回实际区间、单点/空序列、all', () => {
  const one = mkSeries(['2026-08-30']);
  const r = sliceSeries(one, 30);
  assert.equal(r.series.length, 1);
  assert.equal(r.baselinePoint, null);
  assert.deepEqual(sliceSeries([], 30).series, []);
  const all = sliceSeries(one, 'all');
  assert.equal(all.series.length, 1);
  assert.equal(all.baselinePoint, null);
});

test('rangeStats：期初=期末变动 0；dInvest=ΣF 恒等式（含减仓日守护）', () => {
  // 200（成本 100）净值不变卖一半：dAsset=-100，dInvest=-100（所得流出），contrib=0
  const series = [
    { date: '2026-09-14', total_assets: 200 },
    { date: '2026-09-15', total_assets: 100 },
  ];
  const st = rangeStats({
    baselinePoint: null,
    series,
    flows: [{ date: '2026-09-15', amount: -100 }],
  });
  assert.equal(st.dAsset, -100);
  assert.equal(st.dInvest, -100);
  assert.equal(st.contrib, 0); // 用成本差(−50)会得 −50，吞掉真实 0 收益
  assert.equal(st.n, 2);
  assert.equal(st.startDate, '2026-09-14');
  assert.equal(st.endDate, '2026-09-15');
});

test('rangeStats：a₀ 退化路径（baselinePoint=null 且首点有现金流）与 changePct 防护', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 }, // 首点即建仓：a₀ = 100 − 100 = 0
    { date: '2026-09-15', total_assets: 110 },
  ];
  const st = rangeStats({
    baselinePoint: null,
    series,
    flows: [{ date: '2026-09-14', amount: 100 }],
  });
  assert.equal(st.a0, 0);
  assert.equal(st.changePct, null); // a₀ ≤ 0 → null（"—"，不编 0%）
  assert.equal(st.contrib, 10); // dAsset=10 − dInvest=100 → 收益 10，不重不漏
});

test('rangeStats：mddPct 来自 TWR（清仓上涨日不产生幻影回撤）', () => {
  const series = [
    { date: '2026-09-14', total_assets: 100 },
    { date: '2026-09-15', total_assets: 0 }, // +10% 后全赎
  ];
  const st = rangeStats({
    baselinePoint: null,
    series,
    flows: [{ date: '2026-09-15', amount: -110 }],
  });
  assert.equal(st.mddPct, 0);
});

test('rangeStats：xirrFlows 注入则求解、缺失为 null（一日翻倍超求解区间 → null 属预期）', () => {
  const series = [
    { date: '2026-09-01', total_assets: 100 },
    { date: '2026-12-10', total_assets: 130 }, // 100 天 +30% → 年化在求解区间内
  ];
  const ok = rangeStats({
    series,
    flows: [],
    xirrFlows: [
      { date: '2026-09-01', amount: -100 },
      { date: '2026-12-10', amount: 130 },
    ],
  });
  assert.ok(ok.xirr != null && ok.xirr > 0.2 && ok.xirr < 2);
  const none = rangeStats({ series, flows: [], xirrFlows: null });
  assert.equal(none.xirr, null);
});

/* ==================== dayProfitState ==================== */

const at = (h, min = 0) =>
  new Date(`2026-09-14T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+08:00`);

test('dayProfitState：五区间边界（9:29/9:30、午休、14:59/15:00、21:59/22:00）', () => {
  const trading = true;
  assert.equal(dayProfitState({ now: at(9, 29), isTradingDay: trading }), 'prevday');
  assert.equal(dayProfitState({ now: at(9, 30), isTradingDay: trading }), 'est');
  assert.equal(dayProfitState({ now: at(11, 50), isTradingDay: trading }), 'est'); // 午休归 est
  assert.equal(dayProfitState({ now: at(14, 59), isTradingDay: trading }), 'est');
  assert.equal(dayProfitState({ now: at(15, 0), isTradingDay: trading }), 'mixed');
  assert.equal(dayProfitState({ now: at(21, 59), isTradingDay: trading }), 'mixed');
  assert.equal(dayProfitState({ now: at(22, 0), isTradingDay: trading }), 'done');
  assert.equal(dayProfitState({ now: at(23, 30), isTradingDay: trading }), 'done');
});

test('dayProfitState：休市日 closed；交易日历未决（null）按交易日处理', () => {
  assert.equal(dayProfitState({ now: at(10, 0), isTradingDay: false }), 'closed');
  assert.equal(dayProfitState({ now: at(10, 0), isTradingDay: null }), 'est'); // 乐观口径
});
