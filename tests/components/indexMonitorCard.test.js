import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexMonitorCardHtml, displayChangePct } from '../../js/components/indexMonitorCard.js';

const items = [
  {
    name: '沪深300',
    priceText: '4548.05',
    chgText: '-0.10%',
    chgColor: 'var(--color-down)',
    timeText: '09-04 16:11',
    open: false,
  },
  {
    name: '纳斯达克',
    priceText: '26506.99',
    chgText: '+0.50%',
    chgColor: 'var(--color-up)',
    timeText: '09-05 04:00',
    open: true,
  },
];
const status = [
  { label: 'A股', open: false },
  { label: '港股', open: false },
  { label: '美股', open: true },
];

test('indexMonitorCardHtml：渲染头部/状态/摘要/卡体，HTML 与展开状态无关', () => {
  const html = indexMonitorCardHtml(items, { status });
  assert.equal(html.match(/class="idxm-card"/g).length, 2);
  assert.ok(html.includes('4548.05') && html.includes('26506.99') && html.includes('09-05 04:00'));
  // 收起/展开双文案 span 都存在（外层 .is-collapsed 类由 CSS 切换，切换时 v-html 不变）
  assert.ok(html.includes('收起') && html.includes('展开'));
  assert.ok(!html.includes('is-collapsed'));
  // 涨跌色沿用调用方传入的色值（profitColor 的 CSS 变量）
  assert.ok(
    html.includes('style="color:var(--color-up)"') &&
      html.includes('style="color:var(--color-down)"'),
  );
});

test('摘要胶囊：每个指数一枚，带涨跌箭头与颜色', () => {
  const html = indexMonitorCardHtml(items, { status });
  assert.equal(html.match(/idxm-chip/g).length, 2);
  assert.ok(html.includes('↑') && html.includes('↓'));
});

test('开市状态：头部三市场徽标 + 卡内微徽标（open 点亮）', () => {
  const html = indexMonitorCardHtml(items, { status });
  assert.ok(html.includes('A股 已收盘') && html.includes('美股 开盘中'));
  assert.equal(html.match(/idxm-dot open/g).length, 2); // 头部美股 + 卡内纳斯达克
  assert.equal(html.match(/class="idxm-dot[^"]*"/g).length, 5); // 头部 3 + 卡内 2（闭合态带尾随空格）
  // map结果必须join('')：逗号文本节点会变成grid匿名项破坏布局（视觉回归点）
  assert.ok(!/>\s*,/.test(html));
});

test('市场阶段：午间休市显示"午间休市"而非"已收盘"）', () => {
  const lunchItems = [
    {
      name: '沪深300',
      priceText: '4476.18',
      chgText: '-1.59%',
      chgColor: 'var(--color-down)',
      timeText: '11:36',
      open: false,
      phase: 'lunch',
    },
  ];
  const lunchStatus = [
    { label: 'A股', open: false, phase: 'lunch' },
    { label: '港股', open: false, phase: 'lunch' },
    { label: '美股', open: false, phase: 'closed' },
  ];
  const html = indexMonitorCardHtml(lunchItems, { status: lunchStatus });
  assert.ok(html.includes('A股 午间休市') && html.includes('港股 午间休市'));
  assert.ok(html.includes('美股 已收盘')); // 美股不误伤
  assert.ok(html.includes('title="午间休市"')); // 卡内状态点 title
  assert.equal((html.match(/午间休市/g) || []).length, 3); // 头部 2 + 卡内 1
});

test('空数据不炸：无指数时只渲染头部骨架', () => {
  const html = indexMonitorCardHtml([], { status });
  assert.ok(html.includes('核心指数监控'));
  assert.equal(html.match(/idxm-card\b/g), null);
});

// ---- 排序手柄 ----

test('indexMonitorCardHtml：handles 手柄恒输出 + 单参调用不抛（= {} 兜底）+ 缺省不禁用', () => {
  const html = indexMonitorCardHtml(items); // 单参调用：解构兜底不抛
  assert.ok(html.includes('data-blk="idx"'));
  assert.ok(html.includes('class="drag" draggable="true"'));
  assert.ok(html.includes('data-move="-1"') && html.includes('data-move="1"'));
  assert.equal((html.match(/ disabled/g) || []).length, 0);
});

test('indexMonitorCardHtml：disabled 边界——pos=0 禁 ↑、pos=len-1 禁 ↓、中间态不禁', () => {
  const first = indexMonitorCardHtml(items, { status, orderCtx: { pos: 0, len: 3 } });
  assert.ok(first.includes('data-move="-1" title="上移" disabled'));
  assert.ok(!first.includes('data-move="1" title="下移" disabled'));
  const last = indexMonitorCardHtml(items, { status, orderCtx: { pos: 2, len: 3 } });
  assert.ok(last.includes('data-move="1" title="下移" disabled'));
  const mid = indexMonitorCardHtml(items, { status, orderCtx: { pos: 1, len: 3 } });
  assert.equal((mid.match(/ disabled/g) || []).length, 0);
});

// ---- 当天迷你分时槽位 ----

test('迷你分时槽位：键缺省 → 空槽位（不写"暂无分时"）；spark:null → 暂无分时；有曲线 → 内联 SVG', () => {
  const items = [
    {
      code: '000300',
      name: '沪深300',
      priceText: '4510.16',
      chgText: '-0.84%',
      chgColor: 'var(--color-down)',
      timeText: '15:35',
      open: false,
      phase: 'closed',
    },
    {
      code: 'HXC',
      name: '纳斯达克中国金龙',
      priceText: '5788.60',
      chgText: '-0.66%',
      chgColor: 'var(--color-down)',
      timeText: '05:16',
      open: false,
      phase: 'closed',
    },
    {
      code: 'HSI',
      name: '恒生指数',
      priceText: '24805.32',
      chgText: '-0.60%',
      chgColor: 'var(--color-down)',
      timeText: '—',
      open: false,
      phase: 'closed',
    },
  ];
  // ① 未接线（无 sparkByCode）→ 三张卡都是空槽位，且不出现"暂无分时"
  const bare = indexMonitorCardHtml(items, { status: [] });
  assert.equal((bare.match(/class="idxm-spark"/g) || []).length, 3);
  assert.equal(bare.includes('暂无分时'), false);
  // ② 有数据：000300 画线、HXC 无源写"暂无分时"、HSI 未返回（键缺省）→ 空槽位
  const html = indexMonitorCardHtml(items, {
    status: [],
    sparkByCode: {
      '000300': {
        market: 'cn',
        last_pct: -0.84,
        spark: [
          ['09:30', -0.2],
          ['11:30', -1.5],
          ['13:01', -1.4],
          ['15:00', -0.84],
        ],
      },
      HXC: { market: 'us', last_pct: null, spark: null },
    },
  });
  assert.equal((html.match(/class="idxm-spark"/g) || []).length, 3);
  assert.equal((html.match(/spark-svg/g) || []).length, 1);
  assert.equal((html.match(/暂无分时/g) || []).length, 1);
  assert.ok(html.includes('vector-effect="non-scaling-stroke"'));
  assert.ok(
    html.includes('vector-effect="non-scaling-stroke"') && html.includes('var(--color-down)'),
  );
  // ③ 单点不画线（按"暂无分时"处理）
  const one = indexMonitorCardHtml([items[0]], {
    status: [],
    sparkByCode: { '000300': { market: 'cn', last_pct: -1, spark: [['09:30', -1]] } },
  });
  assert.equal(one.includes('spark-svg'), false);
  assert.equal((one.match(/暂无分时/g) || []).length, 1);
});

test('displayChangePct：美股休市时改用「最近完成场次」涨幅；盘中或缺值则照上游', () => {
  // 休市 + 有曲线值 → 用曲线那一路（上游给的是新场次的 0%，不能照显示）
  assert.equal(displayChangePct(0, { lastSessionPct: -1.09, useLastSession: true }), -1.09);
  // 盘中（useLastSession=false）→ 一律照上游实时值
  assert.equal(displayChangePct(0.35, { lastSessionPct: -1.09, useLastSession: false }), 0.35);
  // 曲线还没取到（首屏/折叠）→ 回落上游值，不显示 undefined
  assert.equal(displayChangePct(0, { lastSessionPct: null, useLastSession: true }), 0);
  assert.equal(displayChangePct(0, { lastSessionPct: NaN, useLastSession: true }), 0);
  assert.equal(displayChangePct(null, { lastSessionPct: -0.5, useLastSession: true }), -0.5);
  assert.equal(displayChangePct(null, { lastSessionPct: null, useLastSession: true }), null);
  assert.equal(displayChangePct(-0.84), -0.84); // 默认参数：A 股/港股路径不受影响
});
