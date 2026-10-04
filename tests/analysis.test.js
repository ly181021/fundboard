import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAttribution,
  computeConcentration,
  computeDrawdown,
  generateDailyReport,
  buildReportLines,
  redactAnalysisContext,
  buildReturnRows,
  buildProfitByDate,
  buildMonthCells,
  buildWeekCells,
  buildYearBlocks,
  dayDetailRows,
  parseISODate,
  isoDate,
  addDays,
  startOfWeek,
  profitLevel,
  sumKnownProfits,
  bookArrivals,
  aggregateDaily,
  computeHoldingProfitSeries,
  resolveCorrections,
  principalCorrection,
  pendingCorrections,
  auditPrincipalJumps,
  buildPrincipalCorrection,
  reAddCorrection,
  jumpsLostByTxRemoval,
  correctionsForTxRemoval,
  correctionsForFundRemoval,
  pendingAnchorCorrection,
} from '../js/analysis.js';
import { computeState, applyQuote } from '../js/calculator.js';

// ---- 盈亏归因 ----

const FUNDS = [
  {
    name: '甲基金',
    state: { dailyProfit: 89.1, latestNav: 1.0, holdShares: 10000, holdAmount: 10000, alert: null },
  },
  {
    name: '乙基金',
    state: { dailyProfit: -32.7, latestNav: 1.0, holdShares: 5000, holdAmount: 5000, alert: null },
  },
  {
    name: '丙基金',
    state: { dailyProfit: 12.0, latestNav: 1.0, holdShares: 2000, holdAmount: 2000, alert: null },
  },
];

test('computeAttribution：按当日收益绝对值排序输出涨/跌分组', () => {
  const r = computeAttribution(FUNDS);
  assert.deepEqual(
    r.gainers.map((g) => g.name),
    ['甲基金', '丙基金'],
  );
  assert.deepEqual(
    r.losers.map((g) => g.name),
    ['乙基金'],
  );
  assert.equal(r.gainers[0].dailyProfit, 89.1);
});

test('computeAttribution：无行情（dailyProfit 全 null）返回空', () => {
  const r = computeAttribution([{ name: 'x', state: { dailyProfit: null } }]);
  assert.deepEqual(r, { gainers: [], losers: [] });
});

// ---- 集中度 ----

test('computeConcentration：top1/top3 占比与阈值提示', () => {
  const funds = [
    { state: { holdAmount: 6300 } },
    { state: { holdAmount: 2700 } },
    { state: { holdAmount: 1000 } },
  ];
  const r = computeConcentration(funds);
  assert.ok(Math.abs(r.top1 - 0.63) < 1e-9);
  assert.ok(Math.abs(r.top3 - 1) < 1e-9);
  assert.equal(r.alert, true); // top1 > 60%
});

test('computeConcentration：分散持仓不告警，无市值返回零', () => {
  const r = computeConcentration([
    { state: { holdAmount: 3000 } },
    { state: { holdAmount: 3000 } },
    { state: { holdAmount: 3000 } },
    { state: { holdAmount: 3000 } },
  ]);
  assert.ok(Math.abs(r.top1 - 0.25) < 1e-9);
  assert.ok(Math.abs(r.top3 - 0.75) < 1e-9);
  assert.equal(r.alert, false);
  assert.deepEqual(computeConcentration([]), { top1: 0, top3: 0, alert: false });
});

// ---- 回撤 ----

test('generateDailyReport：净值滞后（QDII 等）时标注最新净值日，昨日副注写前一日', () => {
  const text = generateDailyReport({
    date: '8月31日',
    today: '2026-08-31',
    dataDate: '2026-08-30',
    summary: SUMMARY,
    attribution: ATTR,
    indexData: [],
    concentration: { top1: 0.5, top3: 0.9, alert: false },
  });
  assert.ok(text.includes('最新净值日（08-30）盈亏 +68.40 元'));
  assert.ok(text.includes('（前一日 +58.20）'));
  assert.ok(!text.includes('当日盈亏'));
});

test('generateDailyReport：数据属于今天时仍写当日', () => {
  const text = generateDailyReport({
    date: '8月31日',
    today: '2026-08-31',
    dataDate: '2026-08-31',
    summary: SUMMARY,
    attribution: ATTR,
    indexData: [],
    concentration: { top1: 0.5, top3: 0.9, alert: false },
  });
  assert.ok(text.includes('当日盈亏 +68.40 元'));
  assert.ok(text.includes('（前一日 +58.20）'));
});

test('computeDrawdown：最大回撤 = (峰值 − 谷值) ÷ 峰值，附区间', () => {
  const series = [
    { date: 'd1', nav: 1.0 },
    { date: 'd2', nav: 1.2 },
    { date: 'd3', nav: 0.9 },
    { date: 'd4', nav: 1.1 },
  ];
  const dd = computeDrawdown(series);
  assert.ok(Math.abs(dd.maxDrawdown - 0.25) < 1e-9);
  assert.equal(dd.peakDate, 'd2');
  assert.equal(dd.troughDate, 'd3');
});

test('computeDrawdown：单边上涨无回撤为 0，数据不足返回 null', () => {
  const up = computeDrawdown([
    { date: 'a', nav: 1 },
    { date: 'b', nav: 1.1 },
    { date: 'c', nav: 1.2 },
  ]);
  assert.equal(up.maxDrawdown, 0);
  assert.equal(computeDrawdown([{ date: 'a', nav: 1 }]).maxDrawdown, 0);
  assert.equal(computeDrawdown([]).maxDrawdown, null);
});

// ---- 今日报告 ----

const SUMMARY = {
  fundCount: 3,
  upCount: 2,
  downCount: 1,
  dailyProfit: 68.4,
  yesterdayProfit: 58.2,
};
const ATTR = {
  gainers: [{ name: '甲基金', dailyProfit: 89.1 }],
  losers: [{ name: '乙基金', dailyProfit: -32.7 }],
};

test('generateDailyReport：完整文案（含大盘与集中度告警）', () => {
  const text = generateDailyReport({
    date: '8月30日',
    summary: SUMMARY,
    attribution: ATTR,
    indexData: [
      { name: '沪深300', change_pct: 0.42 },
      { name: '中证500', change_pct: -0.18 },
    ],
    concentration: { top1: 0.63, top3: 1, alert: true },
  });
  assert.ok(text.includes('持仓 3 只：2 涨 1 跌'));
  assert.ok(text.includes('+68.40'));
  assert.ok(text.includes('甲基金 +89.10'));
  assert.ok(text.includes('乙基金 -32.70'));
  assert.ok(text.includes('大盘参照'));
  assert.ok(text.includes('沪深300 +0.42%'));
  assert.ok(text.includes('集中度较高'));
});

test('generateDailyReport：无指数数据略去大盘句；无告警略去集中度句', () => {
  const text = generateDailyReport({
    date: '8月30日',
    summary: SUMMARY,
    attribution: ATTR,
    indexData: null,
    concentration: { top1: 0.2, top3: 0.5, alert: false },
  });
  assert.ok(!text.includes('大盘'));
  assert.ok(!text.includes('集中度'));
});

test('generateDailyReport：全部平盘时涨跌为 0 也能生成', () => {
  const text = generateDailyReport({
    date: 'd',
    summary: { fundCount: 2, upCount: 0, downCount: 0, dailyProfit: 0, yesterdayProfit: null },
    attribution: { gainers: [], losers: [] },
    indexData: null,
    concentration: { top1: 0.5, top3: 1, alert: false },
  });
  assert.ok(text.includes('0 涨 0 跌'));
  assert.ok(!text.includes('贡献最大'));
});

// ---- 收益率可视化（对比条形图 + 收益日历）----

test('buildReturnRows：基金按收益率降序、null 过滤（无组合行）', () => {
  const funds = [
    { name: '乙基金', state: { returnRate: 0.05, xirr: 0.03 } },
    { name: '甲基金', state: { returnRate: 0.12, xirr: null } },
    { name: '丙基金', state: { returnRate: null, xirr: 0.02 } }, // returnRate null → 不参与
  ];
  assert.deepEqual(buildReturnRows(funds), [
    { name: '甲基金', returnRate: 0.12, xirr: null },
    { name: '乙基金', returnRate: 0.05, xirr: 0.03 },
  ]);
});

test('buildReturnRows：无有效收益率返回空数组', () => {
  assert.deepEqual(buildReturnRows([]), []);
  assert.deepEqual(buildReturnRows([{ name: 'X', state: { returnRate: null, xirr: null } }]), []);
});

test('profitLevel：金额分级与异常输入', () => {
  assert.equal(profitLevel(0), 0);
  assert.equal(profitLevel(30), 1);
  assert.equal(profitLevel(-30.1), 2);
  assert.equal(profitLevel(80), 2);
  assert.equal(profitLevel(150), 3);
  assert.equal(profitLevel(-151), 4);
  assert.equal(profitLevel(null), 0);
  assert.equal(profitLevel(NaN), 0);
});

test('buildProfitByDate：到账日志按日求和 + 本金变动标记（乱序输入自动排序）', () => {
  const daily = [
    {
      code: 'A',
      date: '2026-08-31',
      navDate: '2026-08-30',
      earnings: 150,
      invested: 900,
      assets: 1200,
    },
    {
      code: 'A',
      date: '2026-08-28',
      navDate: '2026-08-28',
      earnings: 100,
      invested: 900,
      assets: 1000,
    },
    {
      code: 'A',
      date: '2026-08-30',
      navDate: '2026-08-29',
      earnings: 50,
      invested: 950,
      assets: 1100,
    },
  ];
  const byDate = buildProfitByDate(daily);
  assert.deepEqual(byDate['2026-08-28'], { profit: 100, hasTx: false, correction: null }); // 日志起点无前一日可比较
  assert.deepEqual(byDate['2026-08-30'], { profit: 50, hasTx: true, correction: null }); // 950 ≠ 900
  assert.deepEqual(byDate['2026-08-31'], { profit: 150, hasTx: true, correction: null }); // 900 ≠ 950
});

test('buildProfitByDate：多基金同日到账求和；QDII 净值滞后一天仍按到账日计入', () => {
  const daily = [
    {
      code: '国内甲',
      date: '2026-09-02',
      navDate: '2026-09-02',
      earnings: -252.39,
      invested: 10500,
      assets: 19045.05,
    },
    {
      code: 'QDII乙',
      date: '2026-09-03',
      navDate: '2026-09-02',
      earnings: 0.94,
      invested: 200,
      assets: 208.13,
    },
  ];
  const byDate = buildProfitByDate(daily);
  assert.deepEqual(byDate['2026-09-02'], { profit: -252.39, hasTx: false, correction: null });
  assert.deepEqual(byDate['2026-09-03'], { profit: 0.94, hasTx: false, correction: null }); // QDII 9.2 收益归属 9.3 到账日
});

test('sumKnownProfits：只累计已知日期', () => {
  const byDate = buildProfitByDate([
    {
      code: 'A',
      date: '2026-08-28',
      navDate: '2026-08-28',
      earnings: 100,
      invested: 900,
      assets: 1000,
    },
    {
      code: 'A',
      date: '2026-08-31',
      navDate: '2026-08-31',
      earnings: 200,
      invested: 900,
      assets: 1200,
    },
  ]);
  assert.deepEqual(sumKnownProfits(byDate, ['2026-08-28', '2026-08-29', '2026-08-31']), {
    sum: 300,
    count: 2,
  });
  assert.deepEqual(sumKnownProfits(byDate, ['2026-08-01']), { sum: 0, count: 0 });
});

test('buildMonthCells：周一列首空位 + 今日/选中/交易标记 + 月和', () => {
  const byDate = buildProfitByDate([
    {
      code: 'A',
      date: '2026-08-28',
      navDate: '2026-08-28',
      earnings: 100,
      invested: 900,
      assets: 1000,
    },
    {
      code: 'A',
      date: '2026-08-30',
      navDate: '2026-08-29',
      earnings: 50,
      invested: 950,
      assets: 1100,
    },
    {
      code: 'A',
      date: '2026-08-31',
      navDate: '2026-08-30',
      earnings: 150,
      invested: 900,
      assets: 1200,
    },
  ]);
  const { cells, sum } = buildMonthCells(byDate, {
    year: 2026,
    month: 7,
    today: '2026-08-31',
    selected: '2026-08-28',
  });
  assert.equal(cells.length, 36); // 2026-08-01 是周六 → 5 空位 + 31 天
  assert.equal(cells.filter((c) => c.blank).length, 5);
  const d30 = cells.find((c) => c.day === 30);
  assert.equal(d30.amount, 50);
  assert.equal(d30.hasTx, true);
  assert.equal(d30.level, 2);
  const d31 = cells.find((c) => c.day === 31);
  assert.equal(d31.isToday, true);
  assert.equal(d31.amount, 150);
  const d28 = cells.find((c) => c.day === 28);
  assert.equal(d28.isSelected, true);
  assert.equal(d28.amount, 100);
  assert.deepEqual(sum, { sum: 300, count: 3 });
});

test('buildWeekCells：周一起 7 天 + 周标签 + maxAbs + 周和', () => {
  const byDate = buildProfitByDate([
    {
      code: 'A',
      date: '2026-08-28',
      navDate: '2026-08-28',
      earnings: 100,
      invested: 900,
      assets: 1000,
    },
    {
      code: 'A',
      date: '2026-08-30',
      navDate: '2026-08-29',
      earnings: 50,
      invested: 950,
      assets: 1100,
    },
    {
      code: 'A',
      date: '2026-08-31',
      navDate: '2026-08-30',
      earnings: 150,
      invested: 900,
      assets: 1200,
    },
  ]);
  const week = buildWeekCells(byDate, { anchor: parseISODate('2026-08-28'), today: '2026-08-31' }); // 周五 → 周一 08-24
  assert.equal(week.cells.length, 7);
  assert.equal(week.cells[0].date, '2026-08-24');
  assert.equal(week.cells[6].date, '2026-08-30');
  assert.equal(week.label, '08-24 ~ 08-30');
  assert.equal(week.maxAbs, 100);
  assert.deepEqual(week.sum, { sum: 150, count: 2 });
  assert.equal(week.cells[4].weekday, '五');
  assert.equal(
    week.cells.find((c) => c.date === '2026-08-31'),
    undefined,
  ); // 08-31 属下一周
});

test('buildYearBlocks：12 个月 + 8 月求和 + 全年和', () => {
  const byDate = buildProfitByDate([
    {
      code: 'A',
      date: '2026-08-28',
      navDate: '2026-08-28',
      earnings: 100,
      invested: 900,
      assets: 1000,
    },
    {
      code: 'A',
      date: '2026-08-30',
      navDate: '2026-08-29',
      earnings: 50,
      invested: 950,
      assets: 1100,
    },
    {
      code: 'A',
      date: '2026-08-31',
      navDate: '2026-08-30',
      earnings: 150,
      invested: 900,
      assets: 1200,
    },
  ]);
  const year = buildYearBlocks(byDate, { year: 2026 });
  assert.equal(year.blocks.length, 12);
  const aug = year.blocks[7];
  assert.equal(aug.month, 8);
  assert.equal(aug.cells.length, 36); // 5 空位 + 31 天
  assert.deepEqual(aug.sum, { sum: 300, count: 3 });
  assert.deepEqual(year.sum, { sum: 300, count: 3 });
  assert.equal(year.blocks[0].sum.count, 0);
});

test('bookArrivals：标准到账日（口径 A）——国内=净值日、QDII=下一工作日，幂等', () => {
  const daily = [
    {
      code: 'A',
      date: '2026-09-02',
      navDate: '2026-09-02',
      earnings: 10,
      invested: 100,
      assets: 110,
    },
  ];
  // navDate 未推进 → 不重复入账（幂等）
  const same = bookArrivals(daily, [
    { code: 'A', navDate: '2026-09-02', earnings: 10, invested: 100, assets: 110 },
  ]);
  assert.deepEqual(same, { list: daily, changed: false });
  // 国内基金：周六补拉周五净值 → 到账日 = 净值日，不记到补拉日
  const cn = bookArrivals(daily, [
    { code: 'A', navDate: '2026-09-04', earnings: 5, invested: 100, assets: 115 },
  ]);
  assert.equal(cn.changed, true);
  assert.deepEqual(cn.list[1], {
    code: 'A',
    date: '2026-09-04',
    navDate: '2026-09-04',
    earnings: 5,
    invested: 100,
    assets: 115,
  });
  // QDII：周五净值 → 跳过周末记下周一；周四净值 → 记周五
  const qdii = bookArrivals(daily, [
    { code: 'Q1', navDate: '2026-09-04', earnings: 1, invested: 50, assets: 51, qdii: true },
    { code: 'Q2', navDate: '2026-09-03', earnings: 2, invested: 60, assets: 62, qdii: true },
  ]);
  assert.equal(qdii.list.find((r) => r.code === 'Q1').date, '2026-09-07');
  assert.equal(qdii.list.find((r) => r.code === 'Q2').date, '2026-09-04');
  // 新基金首次入账 / 缺失字段跳过
  const multi = bookArrivals(daily, [
    { code: 'B', navDate: '2026-09-03', earnings: 1, invested: 50, assets: 51 },
    { code: 'C', navDate: null, earnings: 1, invested: 50, assets: 51 },
  ]);
  assert.equal(multi.list.length, 2); // B 入账（1+1 条），C 跳过
});

test('bookArrivals：节假日感知（holidays 注入）——QDII 节前净值记节后首个交易日', () => {
  const holidays = new Set([
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
  ]);
  const entry = [
    { code: 'Q9', navDate: '2026-09-30', earnings: 3, invested: 70, assets: 73, qdii: true },
  ];
  assert.equal(bookArrivals([], entry, holidays).list[0].date, '2026-10-08'); // 国庆：错记 10-01 的口径已修
  assert.equal(bookArrivals([], entry).list[0].date, '2026-10-01'); // 缺省（未注入/降级）：维持只跳周末
});

test('到账口径 A 两端一致：QDII 入账行（date/navDate/earnings）↔ 「当日」列取值', () => {
  // 2026-09-11 是周五、09-14 是周一：QDII 周五净值的到账日 = 周一（跨周末差 3 个日历日）
  const shares = 100;
  const nav = 1.05,
    prevNav = 1.03;
  const state = { totalInvested: 10000, holdShares: shares, costPrice: 1, holdAmount: 10000 };
  const quote = {
    nav,
    nav_date: '2026-09-11',
    prev_nav: prevNav,
    prev2_nav: 1.02,
    change_pct: 1.94,
    prev_change_pct: 0.98,
    estimate: null,
  };
  const monday = applyQuote(state, quote, '2026-09-14', '演示全球科技互联混合(QDII)人民币C');
  const { list } = bookArrivals(
    [],
    [
      {
        code: '110020',
        navDate: '2026-09-11',
        earnings: monday.dayProfit,
        invested: 10000,
        assets: shares * nav,
        qdii: true,
      },
    ],
  );
  const row = list[0];
  assert.equal(row.date, '2026-09-14'); // 到账日 = 净值日的下一工作日
  assert.equal(row.navDate, '2026-09-11');
  assert.equal(monday.dayProfit, 2); // 当日列拿到的正是这笔（100 × (1.05−1.03)）
  assert.equal(row.earnings, monday.dayProfit); // 两端同源：日志行金额 ≡ 当日列金额
  // 到账日不是今天（如 09-15 白天再看）→ 当日列不重复计入该笔（由汇总层的「上一净值日」回退承担）
  assert.equal(
    applyQuote(state, quote, '2026-09-15', '演示全球科技互联混合(QDII)人民币C').dayProfit,
    null,
  );
});

test('aggregateDaily：逐基金前向填充生成组合日序列（资产曲线口径）', () => {
  const daily = [
    {
      code: 'A',
      date: '2026-09-01',
      navDate: '2026-09-01',
      earnings: -10,
      invested: 900,
      assets: 990,
    },
    {
      code: 'B',
      date: '2026-09-02',
      navDate: '2026-09-01',
      earnings: 5,
      invested: 100,
      assets: 105,
    }, // QDII 补发
    {
      code: 'A',
      date: '2026-09-02',
      navDate: '2026-09-02',
      earnings: 8,
      invested: 900,
      assets: 998,
    },
  ];
  const series = aggregateDaily(daily);
  assert.deepEqual(series, [
    { date: '2026-09-01', total_assets: 990, total_invested: 900, total_profit: 90 }, // B 尚无记录不计入
    { date: '2026-09-02', total_assets: 1103, total_invested: 1000, total_profit: 103 }, // B 前向填充进入
  ]);
});

test('dayDetailRows：读到账日志中选中日的逐基金记录（与格子同源，天然一致）', () => {
  const daily = [
    {
      code: '110020',
      date: '2026-09-02',
      navDate: '2026-09-02',
      earnings: -252.39,
      invested: 10500,
      assets: 19045.05,
    },
    {
      code: '161017',
      date: '2026-09-03',
      navDate: '2026-09-02',
      earnings: 0.94,
      invested: 200,
      assets: 208.13,
    },
  ];
  const funds = [
    { code: '110020', name: '演示沪深300' },
    { code: '161017', name: '演示QDII' },
  ];
  assert.deepEqual(dayDetailRows(daily, funds, '2026-09-02'), [
    { name: '演示沪深300', profit: -252.39, navDate: '2026-09-02' },
  ]);
  assert.deepEqual(dayDetailRows(daily, funds, '2026-09-03'), [
    { name: '演示QDII', profit: 0.94, navDate: '2026-09-02' }, // 净值 09-02，到账 09-03
  ]);
  assert.deepEqual(dayDetailRows(daily, funds, '2026-08-28'), []); // 无到账记录
  assert.deepEqual(dayDetailRows([], funds, '2026-09-02'), []);
});

test('日期辅助：parseISODate/isoDate/addDays/startOfWeek（本地时区）', () => {
  assert.equal(isoDate(parseISODate('2026-08-31')), '2026-08-31');
  assert.equal(isoDate(addDays(parseISODate('2026-08-31'), 1)), '2026-09-01');
  assert.equal(isoDate(addDays(parseISODate('2026-01-01'), -1)), '2025-12-31');
  assert.equal(isoDate(startOfWeek(parseISODate('2026-08-28'))), '2026-08-24'); // 周五 → 周一
  assert.equal(isoDate(startOfWeek(parseISODate('2026-08-31'))), '2026-08-31'); // 周一不变
  assert.equal(isoDate(startOfWeek(parseISODate('2026-08-30'))), '2026-08-24'); // 周日 → 周一
});

// ---- 持有收益走势按日回放 ----

const mkNavs = (dates, navs) => dates.map((d, i) => ({ date: d, nav: navs[i] }));
const SNAP = (over = {}) => ({ hold_shares: 100, total_invested: 100, cost_price: 1.0, ...over });
const r2 = (v) => Math.round(v * 100) / 100;

test('持有收益回放 1：纯快照无交易 → 按快照基线正常产出（随净值波动，非空态）', () => {
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.1, 1.2]);
  const s = computeHoldingProfitSeries(SNAP(), [], navs);
  assert.deepEqual(s, [
    { date: '2026-09-01', profit: 0 },
    { date: '2026-09-02', profit: 10 },
    { date: '2026-09-03', profit: 20 },
  ]);
});

test('持有收益回放 2：买入交易——买入日（含）起生效，之前各点不受影响', () => {
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.0, 1.1]);
  const s = computeHoldingProfitSeries(
    { hold_shares: 0, total_invested: 0, cost_price: 0 },
    [{ type: 'buy', date: '2026-09-02', amount: 100, shares: 100 }],
    navs,
  );
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 0, 10],
  );
});

test('持有收益回放 3：卖出——本金按当时成本价等比扣减，与 computeState 口径一致', () => {
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.0, 1.1]);
  const txs = [{ type: 'sell', date: '2026-09-02', shares: 50 }];
  const s = computeHoldingProfitSeries(SNAP(), txs, navs);
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 0, 5],
  ); // 50 份 × 1.1 − 50 本金
  const st = computeState({ ...SNAP(), hold_amount: 100 }, txs);
  assert.equal(st.totalInvested, 50);
  assert.equal(st.holdShares, 50);
});

test('持有收益回放 4：红利再投——份额增、本金不变 → 成本摊薄、曲线连续', () => {
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.0, 1.0]);
  const s = computeHoldingProfitSeries(
    SNAP(),
    [{ type: 'dividend', method: 'reinvest', date: '2026-09-02', shares: 20 }],
    navs,
  );
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 20, 20],
  ); // 120 份 × 1.0 − 100 本金
});

test('持有收益回放 5：现金分红——曲线与无该笔交易完全一致（不参与）', () => {
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.1, 1.2]);
  const base = computeHoldingProfitSeries(SNAP(), [], navs);
  const withCash = computeHoldingProfitSeries(
    SNAP(),
    [{ type: 'dividend', method: 'cash', date: '2026-09-02', amount: 5 }],
    navs,
  );
  assert.deepEqual(withCash, base);
});

test('持有收益回放 6：交易日期落在净值间隙（周末）→ 计入下一净值日', () => {
  // 09-04 周五、09-07 周一有净值；09-05 周六买入 → 周一净值日才生效
  const navs = mkNavs(['2026-09-04', '2026-09-07'], [1.0, 1.1]);
  const s = computeHoldingProfitSeries(
    { hold_shares: 0, total_invested: 0, cost_price: 0 },
    [{ type: 'buy', date: '2026-09-05', amount: 100, shares: 100 }],
    navs,
  );
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 10],
  );
});

test('持有收益回放 7：交易日期带时间（脏数据）→ slice(0,10) 归一后正确归属当日', () => {
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.0, 1.1]);
  const s = computeHoldingProfitSeries(
    { hold_shares: 0, total_invested: 0, cost_price: 0 },
    [{ type: 'buy', date: '2026-09-02T14:30:00', amount: 100, shares: 100 }],
    navs,
  );
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 0, 10],
  ); // 当日生效，不滑到次日
});

test('持有收益回放 8：早于窗口首日的交易并入首点基线', () => {
  const navs = mkNavs(['2026-09-08', '2026-09-09', '2026-09-10'], [1.0, 1.0, 1.1]);
  const s = computeHoldingProfitSeries(
    { hold_shares: 0, total_invested: 0, cost_price: 0 },
    [{ type: 'buy', date: '2026-09-01', amount: 100, shares: 100 }],
    navs,
  );
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 0, 10],
  ); // 首点已含 09-01 买入
});

test('持有收益回放 9：空态——序列 <2 点或全零持仓 → []', () => {
  assert.deepEqual(computeHoldingProfitSeries(SNAP(), [], [{ date: '2026-09-01', nav: 1.0 }]), []);
  assert.deepEqual(computeHoldingProfitSeries(SNAP(), [], null), []);
  assert.deepEqual(
    computeHoldingProfitSeries(
      { hold_shares: 0, total_invested: 0, cost_price: 0 },
      [],
      mkNavs(['2026-09-01', '2026-09-02'], [1.0, 1.0]),
    ),
    [],
  );
});

test('持有收益回放 10：半分舍入——外层 round2 消除卖出成本浮点尾差', () => {
  // 3 份 100 元 → 成本 33.333…；卖 1 份后 invested = 66.666…，2 份 × 1.0 = 2
  const s = computeHoldingProfitSeries(
    { hold_shares: 3, total_invested: 100, cost_price: 100 / 3 },
    [{ type: 'sell', date: '2026-09-02', shares: 1 }],
    mkNavs(['2026-09-01', '2026-09-02'], [1.0, 1.0]),
  );
  assert.equal(s[1].profit, r2(r2(2) - 66.66666666666667)); // -64.67，无尾差
  assert.notEqual(s[1].profit, 2 - 66.66666666666667);
});

test('持有收益回放 11：与 computeState 对账（无晚于净值日的交易）——末点双层舍入一致', () => {
  // 前置条件：夹具中不存在晚于净值序列末日的交易。
  // 存在超前交易（盘中录单晚于最新净值日）时属预期不等：回放末点 = 至最新净值日的历史结算状态，
  // 主表 computeState 实时计入超前交易，两者差异即该笔在途交易。
  const txs = [
    { type: 'buy', date: '2026-09-02', amount: 50, shares: 50 },
    { type: 'sell', date: '2026-09-03', shares: 10 },
  ];
  const snap = { hold_shares: 100, total_invested: 100, cost_price: 1.0, hold_amount: 100 };
  const navs = mkNavs(
    ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'],
    [1.0, 1.0, 1.1, 1.2],
  );
  const s = computeHoldingProfitSeries(snap, txs, navs);
  const st = computeState(snap, txs);
  const expected = r2(r2(st.holdShares * navs[3].nav) - st.totalInvested);
  assert.equal(s[s.length - 1].profit, expected);
});

test('持有收益回放 12：navSeries 降序传入 → 输出仍升序、数值与升序输入一致', () => {
  const asc = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.1, 1.2]);
  const a = computeHoldingProfitSeries(SNAP(), [], asc);
  const b = computeHoldingProfitSeries(SNAP(), [], [...asc].reverse());
  assert.deepEqual(b, a);
  assert.equal(b[0].date, '2026-09-01');
});

test('持有收益回放 13：入参不可变——深冻结 transactions 正常回放、原数组不变', () => {
  const txs = Object.freeze([
    Object.freeze({ type: 'buy', date: '2026-09-02', amount: 100, shares: 100 }),
  ]);
  const navs = mkNavs(['2026-09-01', '2026-09-02', '2026-09-03'], [1.0, 1.0, 1.1]);
  const s = computeHoldingProfitSeries(
    { hold_shares: 0, total_invested: 0, cost_price: 0 },
    txs,
    navs,
  );
  assert.deepEqual(
    s.map((p) => p.profit),
    [0, 0, 10],
  );
  assert.equal(txs.length, 1); // 未被 shift/splice 消费
  assert.equal(txs[0].date, '2026-09-02');
});

// ---- 口径 Ⅰ：本金修正留痕（历史到账日志不可变，修正对齐后打标）----

test('resolveCorrections：修正生效日对齐到"日志首次体现新本金的日期"（修正日可无日志行）', () => {
  const daily = [
    {
      code: '110022',
      date: '2026-09-04',
      navDate: '2026-09-04',
      earnings: -1,
      invested: 144.17,
      assets: 91.85,
    },
    {
      code: '110022',
      date: '2026-09-07',
      navDate: '2026-09-07',
      earnings: -0.38,
      invested: 142.84,
      assets: 91.47,
    },
  ];
  // 09-06（周日，无净值日、日志无行）修正本金 144.17 → 142.84
  const resolved = resolveCorrections(daily, [
    { code: '110022', date: '2026-09-06', from: 144.17, to: 142.84 },
  ]);
  assert.deepEqual(resolved, { '2026-09-07': [{ code: '110022', from: 144.17, to: 142.84 }] });
});

test('resolveCorrections：买入/卖出造成的变化不得误标为修正（值不匹配即不认领）', () => {
  const daily = [
    { code: 'A', date: '2026-09-04', invested: 1000 },
    { code: 'A', date: '2026-09-07', invested: 1500 }, // 买入 500，非修正
  ];
  assert.deepEqual(
    resolveCorrections(daily, [{ code: 'A', date: '2026-09-05', from: 1000, to: 1428.4 }]),
    {},
  );
});

test('resolveCorrections：一次修正只消费一次；修正日不得晚于日志体现日', () => {
  const daily = [
    { code: 'A', date: '2026-09-04', invested: 100 },
    { code: 'A', date: '2026-09-07', invested: 200 },
    { code: 'A', date: '2026-09-08', invested: 100 },
    { code: 'A', date: '2026-09-09', invested: 200 },
  ];
  // 仅一条修正（100→200）→ 只认领 09-07；09-09 的再次变化属交易
  assert.deepEqual(
    resolveCorrections(daily, [{ code: 'A', date: '2026-09-05', from: 100, to: 200 }]),
    { '2026-09-07': [{ code: 'A', from: 100, to: 200 }] },
  );
  // 修正日晚于日志体现日 → 不认领 09-07（时序不符），顺延到 09-09
  assert.deepEqual(
    resolveCorrections(daily, [{ code: 'A', date: '2026-09-08', from: 100, to: 200 }]),
    { '2026-09-09': [{ code: 'A', from: 100, to: 200 }] },
  );
});

test('buildProfitByDate：修正日带 correction 明细；hasTx 语义不变；缺省入参 correction 恒 null', () => {
  const daily = [
    {
      code: 'A',
      date: '2026-09-04',
      navDate: '2026-09-04',
      earnings: 1,
      invested: 100,
      assets: 101,
    },
    {
      code: 'A',
      date: '2026-09-07',
      navDate: '2026-09-07',
      earnings: 2,
      invested: 200,
      assets: 202,
    },
  ];
  const byDate = buildProfitByDate(daily, [{ code: 'A', date: '2026-09-05', from: 100, to: 200 }]);
  assert.deepEqual(byDate['2026-09-07'].correction, [{ code: 'A', from: 100, to: 200 }]);
  assert.equal(byDate['2026-09-07'].hasTx, true); // 修正也是本金变动，hasTx 语义保持
  assert.equal(byDate['2026-09-04'].correction, null);
  assert.deepEqual(buildProfitByDate(daily)['2026-09-07'].correction, null); // 旧调用（不传 corrections）
});

test('buildMonthCells：单元格携带 correction——修正日与普通交易日可区分', () => {
  const daily = [
    { code: 'A', date: '2026-09-04', invested: 100, earnings: 1 },
    { code: 'A', date: '2026-09-07', invested: 200, earnings: 2 },
  ];
  const byDate = buildProfitByDate(daily, [{ code: 'A', date: '2026-09-05', from: 100, to: 200 }]);
  const { cells } = buildMonthCells(byDate, { year: 2026, month: 8 });
  assert.deepEqual(cells.find((c) => c.day === 7).correction, [{ code: 'A', from: 100, to: 200 }]);
  assert.equal(cells.find((c) => c.day === 4).correction, null);
});

test('principalCorrection：本金变化才产出记录；无变化/非法入参 → null（编辑本金写入口的唯一分支）', () => {
  assert.deepEqual(
    principalCorrection({
      code: '110022',
      prevInvested: 144.17,
      nextInvested: 142.84,
      date: '2026-09-06',
      at: 'X',
    }),
    {
      code: '110022',
      field: 'total_invested',
      date: '2026-09-06',
      from: 144.17,
      to: 142.84,
      at: 'X',
    },
  );
  assert.equal(
    principalCorrection({
      code: '110022',
      prevInvested: 142.84,
      nextInvested: 142.84,
      date: '2026-09-06',
    }),
    null,
  ); // 无变化
  assert.equal(
    principalCorrection({
      code: '110022',
      prevInvested: 144.1700000001,
      nextInvested: 144.17,
      date: '2026-09-06',
    }),
    null,
  ); // 浮点尾差不算变化
  assert.equal(
    principalCorrection({ code: '', prevInvested: 1, nextInvested: 2, date: '2026-09-06' }),
    null,
  ); // 缺 code
  assert.equal(
    principalCorrection({ code: 'A', prevInvested: NaN, nextInvested: 2, date: '2026-09-06' }),
    null,
  ); // 非法前值
  assert.equal(
    principalCorrection({ code: 'A', prevInvested: 1, nextInvested: 'abc', date: '2026-09-06' }),
    null,
  ); // 非法后值
});

test('pendingCorrections：已体现 → 不计；日志未写入新本金 → 待体现（徽标依据）', () => {
  const daily = [
    { code: 'A', date: '2026-09-04', invested: 100 },
    { code: 'A', date: '2026-09-07', invested: 200 },
  ];
  // 日志 09-07 已是 200（≥ 修正日 09-05）→ 已体现
  assert.deepEqual(
    pendingCorrections(daily, [{ code: 'A', date: '2026-09-05', from: 100, to: 200 }]),
    [],
  );
  // 改成 300、日志还没写过 300 → 待体现
  const c300 = { code: 'A', date: '2026-09-08', from: 200, to: 300 };
  assert.deepEqual(pendingCorrections(daily, [c300]), [c300]);
  // 修正日晚于日志所有行（今天刚改、尚未入账）→ 待体现
  const fresh = { code: 'A', date: '2026-09-10', from: 200, to: 350 };
  assert.deepEqual(pendingCorrections(daily, [fresh]), [fresh]);
  // 脏记录（缺 to）不计入，避免徽标永久驻留
  assert.deepEqual(pendingCorrections(daily, [{ code: 'A', date: '2026-09-10' }]), []);
});

test('pendingCorrections：连改两次时，被后续已体现修正覆盖的中间记录不再挂徽标', () => {
  // 日志直接从 100 跳到 300（中间 200 从未写入日志）
  const daily = [
    { code: 'A', date: '2026-09-04', invested: 100 },
    { code: 'A', date: '2026-09-07', invested: 300 },
  ];
  const c1 = { code: 'A', date: '2026-09-05', from: 100, to: 200, at: '2026-09-05T10:00:00.000Z' };
  const c2 = { code: 'A', date: '2026-09-06', from: 200, to: 300, at: '2026-09-06T10:00:00.000Z' };
  assert.deepEqual(pendingCorrections(daily, [c1, c2]), []); // c2 已体现；c1 被覆盖 → 不像徽标一样永久驻留
  // 只有 c1（没有后续修正）→ 仍属待体现（日志确实还没体现 200）
  assert.deepEqual(pendingCorrections(daily, [c1]), [c1]);
});

test('auditPrincipalJumps：交易解释 / 修正留痕 / 未留痕 三种判定（服务端定时巡检与工具共用）', () => {
  const daily = [
    { code: 'T', date: '2026-09-04', invested: 1000 },
    { code: 'T', date: '2026-09-07', invested: 1500 }, // 窗口内有买入 → 交易解释
    { code: 'C', date: '2026-09-04', invested: 100 },
    { code: 'C', date: '2026-09-07', invested: 142.84 }, // 有留痕 → 修正留痕
    { code: 'U', date: '2026-09-04', invested: 5000 },
    { code: 'U', date: '2026-09-07', invested: 6000 }, // 无交易、无留痕 → 未留痕
  ];
  const assets = [
    {
      code: 'T',
      name: '有交易的基金',
      transactions: [{ type: 'buy', date: '2026-09-05', amount: 500, shares: 100 }],
    },
    { code: 'C', name: '已留痕的基金', transactions: [] },
    { code: 'U', name: '漏留痕的基金', transactions: [] },
  ];
  const corrections = [
    { code: 'C', field: 'total_invested', date: '2026-09-06', from: 100, to: 142.84 },
  ];
  const { jumps, unexplained } = auditPrincipalJumps(daily, corrections, assets);
  assert.equal(jumps.length, 3);
  assert.deepEqual(
    jumps.map((j) => j.status),
    ['交易解释', '修正留痕', '未留痕'],
  );
  assert.deepEqual(unexplained, [
    {
      code: 'U',
      name: '漏留痕的基金',
      date: '2026-09-07',
      from: 5000,
      to: 6000,
      txCount: 0,
      claimed: false,
      status: '未留痕',
    },
  ]);
});

test('auditPrincipalJumps：窗口外的交易不算解释；首行不参与比较；缺 assets 不炸（名字回退 code）', () => {
  const daily = [
    { code: 'A', date: '2026-09-04', invested: 100 }, // 首行 → 跳过
    { code: 'A', date: '2026-09-07', invested: 200 }, // 改动发生在窗口内但交易在窗口之前 → 未留痕
    { code: 'B', date: '2026-09-07', invested: 300 },
  ];
  const assets = [
    { code: 'A', transactions: [{ type: 'buy', date: '2026-09-01', amount: 100, shares: 10 }] },
  ];
  const { unexplained } = auditPrincipalJumps(daily, [], assets);
  assert.deepEqual(
    unexplained.map((j) => j.code),
    ['A'],
  );
  assert.equal(unexplained[0].name, 'A'); // 缺 name → 回退 code
  assert.deepEqual(auditPrincipalJumps(null, null, null), { jumps: [], unexplained: [] }); // 容缺省
});

test('buildPrincipalCorrection：有交易的基金必须按"生效本金"留痕（口径分叉回归——否则永远认领不到）', () => {
  // 110020：快照基线 10000 + 一笔买入 500 → 生效本金 10500（到账日志写的就是 10500）
  const txs = [{ type: 'buy', date: '2026-09-01', amount: 500, shares: 476.19 }];
  const prevSnapshot = {
    hold_amount: 10500,
    cost_price: 1.05,
    hold_shares: 10000,
    total_invested: 10000,
  };
  const nextSnapshot = { ...prevSnapshot, total_invested: 9500 }; // 基线改成 9500
  const daily = [
    { code: '110020', date: '2026-09-04', invested: 10500 },
    { code: '110020', date: '2026-09-07', invested: 10000 }, // 编辑后的生效本金（9500 + 500）
  ];
  const assets = [{ code: '110020', name: '沪深300', transactions: txs }];

  const rec = buildPrincipalCorrection({
    code: '110020',
    prevSnapshot,
    nextSnapshot,
    transactions: txs,
    date: '2026-09-06',
    at: 'X',
  });
  // 记的是生效值 10500→10000，而不是基线 10000→9500
  assert.deepEqual(rec, {
    code: '110020',
    field: 'total_invested',
    date: '2026-09-06',
    from: 10500,
    to: 10000,
    at: 'X',
  });
  assert.deepEqual(resolveCorrections(daily, [rec]), {
    '2026-09-07': [{ code: '110020', from: 10500, to: 10000 }],
  });
  assert.deepEqual(pendingCorrections(daily, [rec]), []); // 徽标不驻留
  assert.deepEqual(
    auditPrincipalJumps(daily, [rec], assets).jumps.map((j) => j.status),
    ['修正留痕'],
  ); // 巡检不误报

  // 反例锁死：若误按基线值记（旧实现），认领/待体现/巡检三处全错
  const baselineRec = {
    code: '110020',
    field: 'total_invested',
    date: '2026-09-06',
    from: 10000,
    to: 9500,
    at: 'X',
  };
  assert.deepEqual(resolveCorrections(daily, [baselineRec]), {});
  assert.equal(pendingCorrections(daily, [baselineRec]).length, 1);
  assert.equal(auditPrincipalJumps(daily, [baselineRec], assets).unexplained.length, 1);
});

// ---- 口径 Ⅰ：重加已有日志代码的自动留痕（reAddCorrection）----

test('reAddCorrection：无日志 / 入参非法 / 同本金重加（两位小数相等）均返回空', () => {
  assert.equal(reAddCorrection(null, null, 'D1', 100, '2026-10-04', 'at1'), null);
  const daily = [{ code: 'D1', date: '2026-09-28', navDate: '2026-09-26', invested: 10500 }];
  assert.equal(reAddCorrection(daily, [], 'D1', 10500, '2026-10-04', 'at1'), null);
  assert.equal(reAddCorrection(daily, [], 'D1', 10500.001, '2026-10-04', 'at1'), null); // round2 相等
  assert.equal(reAddCorrection(daily, [], 'D1', '非数值', '2026-10-04', 'at1'), null);
});

test('reAddCorrection：不同本金重加生成记录，字段取日志末行与传入值；乱序日志按日期取末行', () => {
  const daily = [
    { code: 'D1', date: '2026-09-29', navDate: '2026-09-26', invested: 300 },
    { code: 'D1', date: '2026-08-28', navDate: '2026-08-28', invested: 10000 },
    { code: 'D1', date: '2026-08-31', navDate: '2026-08-29', invested: 10500 },
  ];
  assert.deepEqual(reAddCorrection(daily, [], 'D1', 50, '2026-10-04', 'at1'), {
    code: 'D1',
    field: 'total_invested',
    date: '2026-10-04',
    from: 300,
    to: 50,
    at: 'at1',
  });
});

test('reAddCorrection：同日多行按净值日双键取最新；幂等闸拦同 code+生效日+前后本金（忽略时间戳）', () => {
  // 同日多行 = 节假日合并到账（连续多个净值日的到账日落在同一首个 A 股交易日）
  const daily = [
    { code: 'D2', date: '2026-09-28', navDate: '2026-09-25', invested: 8000 },
    { code: 'D2', date: '2026-09-28', navDate: '2026-09-26', invested: 8500 }, // 净值日较新 → 末行
  ];
  assert.equal(reAddCorrection(daily, [], 'D2', 100, '2026-10-04', 'at1').from, 8500);

  const corrections = [
    { code: 'D2', field: 'total_invested', date: '2026-10-04', from: 8500, to: 100, at: 'at0' },
  ];
  // 同 code + 生效日 + 前后本金已存在（at 不同）→ 拦
  assert.equal(reAddCorrection(daily, corrections, 'D2', 100, '2026-10-04', 'at1'), null);
  // 生效日或本金不同 → 放行
  assert.ok(reAddCorrection(daily, corrections, 'D2', 100, '2026-10-05', 'at1'));
  assert.ok(reAddCorrection(daily, corrections, 'D2', 200, '2026-10-04', 'at1'));
});

// ---- 口径 Ⅰ：删除自动留痕（交易/基金/重锚）----

const DEL_DAILY = [
  { code: 'X', date: '2026-09-28', navDate: '2026-09-28', invested: 142.84 },
  { code: 'X', date: '2026-09-29', navDate: '2026-09-29', invested: 242.84 },
  { code: 'X', date: '2026-09-30', navDate: '2026-09-30', invested: 242.84 },
];
const DEL_SNAPSHOT = {
  hold_amount: 91.85,
  pending_amount: 0,
  cost_price: 2.8834,
  hold_shares: 50,
  total_invested: 142.84,
};

test('correctionsForTxRemoval：删唯一解释买入 → 失解释跳变 + 本金回落两条；幂等过滤', () => {
  const assets = [
    {
      code: 'X',
      name: '演示',
      snapshot: DEL_SNAPSHOT,
      transactions: [{ type: 'buy', date: '2026-09-29', amount: 100, shares: 0 }],
    },
  ];
  assert.deepEqual(
    jumpsLostByTxRemoval(DEL_DAILY, [], assets, 'X', 0).map((j) => j.date),
    ['2026-09-29'],
  );
  const recs = correctionsForTxRemoval(DEL_DAILY, [], assets, 'X', 0, '2026-10-04', 'at1');
  assert.deepEqual(recs, [
    { code: 'X', field: 'total_invested', date: '2026-09-29', from: 142.84, to: 242.84, at: 'at1' },
    { code: 'X', field: 'total_invested', date: '2026-10-04', from: 242.84, to: 142.84, at: 'at1' },
  ]);
  // 幂等：同 code+date+from+to 已存在（at 不同）→ 空数组
  const seeded = recs.map((r) => ({ ...r, at: 'at0' }));
  assert.deepEqual(
    correctionsForTxRemoval(DEL_DAILY, seeded, assets, 'X', 0, '2026-10-04', 'at1'),
    [],
  );
});

test('correctionsForTxRemoval：窗口多笔删一笔不记历史跳变；删现金分红本金不变不记回落；无日志空数组', () => {
  const assets = [
    {
      code: 'X',
      name: '演示',
      snapshot: { ...DEL_SNAPSHOT, total_invested: 92.84 },
      transactions: [
        { type: 'buy', date: '2026-09-29', amount: 100, shares: 0 },
        { type: 'buy', date: '2026-09-29', amount: 50, shares: 0 },
      ],
    },
  ];
  assert.deepEqual(correctionsForTxRemoval(DEL_DAILY, [], assets, 'X', 0, '2026-10-04', 'at1'), [
    { code: 'X', field: 'total_invested', date: '2026-10-04', from: 242.84, to: 142.84, at: 'at1' },
  ]);
  const dividendAssets = [
    {
      code: 'X',
      name: '演示',
      snapshot: { ...DEL_SNAPSHOT, total_invested: 242.84 },
      transactions: [{ type: 'dividend', method: 'cash', date: '2026-09-29', amount: 50 }],
    },
  ];
  assert.deepEqual(
    correctionsForTxRemoval(DEL_DAILY, [], dividendAssets, 'X', 0, '2026-10-04', 'at1'),
    [
      {
        code: 'X',
        field: 'total_invested',
        date: '2026-09-29',
        from: 142.84,
        to: 242.84,
        at: 'at1',
      },
    ],
  );
  assert.deepEqual(correctionsForTxRemoval([], [], assets, 'X', 0, '2026-10-04', 'at1'), []);
});

test('correctionsForFundRemoval：封账只记非"修正留痕"跳变；无日志空数组', () => {
  const daily = [
    { code: 'X', date: '2026-09-01', navDate: '2026-09-01', invested: 100 },
    { code: 'X', date: '2026-09-02', navDate: '2026-09-02', invested: 200 }, // 已有留痕认领 → 跳过
    { code: 'X', date: '2026-09-03', navDate: '2026-09-03', invested: 300 }, // 未留痕 → 补
  ];
  const corrections = [
    { code: 'X', field: 'total_invested', date: '2026-09-01', from: 100, to: 200, at: 'a0' },
  ];
  assert.deepEqual(correctionsForFundRemoval(daily, corrections, [], 'X', '2026-10-04', 'at1'), [
    { code: 'X', field: 'total_invested', date: '2026-09-03', from: 200, to: 300, at: 'at1' },
  ]);
  assert.deepEqual(correctionsForFundRemoval([], corrections, [], 'X', '2026-10-04', 'at1'), []);
});

test('pendingAnchorCorrection：悬空待体现触发重锚；未悬空或无待体现返回空', () => {
  const daily = [{ code: 'X', date: '2026-09-30', navDate: '2026-09-30', invested: 242.84 }];
  const pending = [
    { code: 'X', field: 'total_invested', date: '2026-10-04', from: 242.84, to: 142.84, at: 'a1' },
  ];
  assert.deepEqual(pendingAnchorCorrection(daily, pending, 'X', 642.84, '2026-10-04', 'at2'), {
    code: 'X',
    field: 'total_invested',
    date: '2026-10-04',
    from: 242.84,
    to: 642.84,
    at: 'at2',
  });
  assert.equal(pendingAnchorCorrection(daily, pending, 'X', 142.84, '2026-10-04', 'at2'), null);
  assert.equal(pendingAnchorCorrection(daily, [], 'X', 642.84, '2026-10-04', 'at2'), null);
});

// ---- 规则报告逐条（网页为无序列表）----

test('buildReportLines：四类内容各成一条，顺序为 统计/归因/大盘/集中度', () => {
  const args = {
    today: '2026-08-30',
    dataDate: '2026-08-30',
    summary: SUMMARY,
    attribution: ATTR,
    indexData: [
      { name: '沪深300', change_pct: 0.42 },
      { name: '中证500', change_pct: -0.18 },
    ],
    concentration: { top1: 0.63, top3: 1, alert: true },
  };
  const lines = buildReportLines(args);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith('持仓 3 只：2 涨 1 跌'));
  assert.ok(lines[1].startsWith('贡献最大：甲基金'));
  assert.ok(lines[2].startsWith('大盘参照：沪深300 +0.42%'));
  assert.ok(lines[3].startsWith('⚠ 持仓集中度较高'));
  // 与整段文案同源：join 后等于 generateDailyReport（无日期前缀时）
  assert.equal(lines.join(''), generateDailyReport(args));
});

test('buildReportLines：可选条目缺数据时略去，空持仓返回空数组', () => {
  const bare = buildReportLines({
    today: '2026-08-30',
    dataDate: '2026-08-30',
    summary: SUMMARY,
    attribution: null,
    indexData: [],
    concentration: { top1: 0.5, top3: 0.9, alert: false },
  });
  assert.equal(bare.length, 1); // 只剩持仓统计
  assert.deepEqual(buildReportLines({ summary: { fundCount: 0 } }), []);
});

test('buildReportLines：redactMoney 抹掉金额，保留比例/占比/计数/涨跌幅', () => {
  const text = buildReportLines({
    today: '2026-08-30',
    dataDate: '2026-08-30',
    summary: SUMMARY,
    attribution: ATTR,
    indexData: [{ name: '沪深300', change_pct: 0.42 }],
    concentration: { top1: 0.63, top3: 1, alert: true },
    redactMoney: true,
  }).join('');
  assert.ok(text.includes('盈亏 ••• 元'), '金额位置应为占位');
  assert.ok(text.includes('（前一日 •••）'));
  assert.ok(!text.includes('+68.40') && !text.includes('+58.20'), '原始金额不得残留');
  assert.ok(!text.includes('+89.10') && !text.includes('-32.70'), '归因金额不得残留');
  assert.ok(text.includes('持仓 3 只：2 涨 1 跌'), '计数不受影响');
  assert.ok(text.includes('沪深300 +0.42%'), '指数涨跌幅不受影响');
  assert.ok(text.includes('top1 占 63%'), '占比不受影响');
});

// ---- AI 解读出网脱敏（「金额不出网」）----

test('redactAnalysisContext：剥掉一切绝对金额，只留比例/占比/计数', () => {
  const out = redactAnalysisContext({
    date: '2026-09-11',
    report: '持仓 3 只…盈亏 ••• 元。',
    summary: {
      returnRate: 0.0512,
      anyEstimate: true,
      dailyReturnPct: -0.0121,
      totalAssets: 123456.78,
      totalInvested: 100000,
      totalHoldProfit: 23456.78,
      portfolio: { total: { value: 123456.78 } },
    },
    attribution: {
      gainers: [{ name: '甲基金', dailyProfit: 89.1 }],
      losers: [{ name: '乙基金', dailyProfit: -32.7 }],
    },
    concentration: { top1: 0.63, top3: 1, alert: true },
    indexes: [{ name: '沪深300', change_pct: 0.42, amount: 999 }],
    portfolioXirr: 0.0834,
    strategy: { actionCount: 2, summary: { exit: 0, stopLoss: 1, takeProfit: 1, add: 0 } },
    funds: [
      {
        name: '甲基金',
        code: '110020',
        invested: 10000,
        holdProfit: 890.1,
        returnRate: 0.08,
        xirr: 0.11,
        weightPct: 0.62,
      },
    ],
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'attribution',
    'concentration',
    'date',
    'funds',
    'indexes',
    'portfolioXirr',
    'report',
    'strategy',
    'summary',
  ]);
  assert.deepEqual(Object.keys(out.summary).sort(), [
    'anyEstimate',
    'dailyReturnPct',
    'returnRate',
  ]);
  assert.deepEqual(Object.keys(out.funds[0]).sort(), ['name', 'returnRate', 'weightPct', 'xirr']);
  assert.deepEqual(out.attribution.gainers, [{ name: '甲基金' }]); // 归因只留顺序，金额去除
  assert.equal(out.concentration.top1, 0.63);
  assert.equal(out.portfolioXirr, 0.0834);
  // 序列化后不得出现任何原始金额或金额字段名
  const json = JSON.stringify(out);
  for (const leak of [
    '123456.78',
    '100000',
    '23456.78',
    '89.1',
    '-32.7',
    '10000',
    '890.1',
    '999',
    'invested',
    'holdProfit',
    'totalAssets',
    'totalInvested',
    'code',
  ]) {
    assert.ok(!json.includes(leak), `金额/字段外泄：${leak}`);
  }
});

test('redactAnalysisContext：缺字段/畸形入参不抛错，null 归一为 null', () => {
  const out = redactAnalysisContext({});
  assert.equal(out.date, null);
  assert.equal(out.report, null);
  assert.equal(out.summary.returnRate, null);
  assert.deepEqual(out.attribution, { gainers: [], losers: [] });
  assert.equal(out.concentration.top1, null);
  assert.equal(out.concentration.alert, false);
  assert.deepEqual(out.indexes, []);
  assert.deepEqual(out.funds, []);
  assert.equal(out.strategy.actionCount, 0);
  assert.doesNotThrow(() => redactAnalysisContext(null));
  assert.doesNotThrow(() => redactAnalysisContext({ summary: null, funds: [null] }));
});
