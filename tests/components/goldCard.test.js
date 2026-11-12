import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goldBlockHtml, goldCardOf } from '../../js/components/goldCard.js';

// 时间轴基准：now 与被格式化的时间戳同源构造，断言不依赖运行时区
const NOW = new Date(2026, 10, 11, 14, 32);
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

test('goldCardOf：涨跌胶囊三态与格式化（涨 up / 跌 dn / 平 none / 额缺失只显幅）', () => {
  const up = goldCardOf({ price: 907.32, change_pct: 0.26, change_amt: 2.35, time: NOW_SEC }, NOW);
  assert.equal(up.priceText, '907.32');
  assert.equal(up.pillCls, 'up');
  assert.equal(up.pillText, '▲ +2.35 · +0.26%');
  assert.equal(up.timeText, '14:32'); // 当日只显示时分
  const dn = goldCardOf(
    { price: 873.45, change_pct: -1.1286, change_amt: -9.97, time: NOW_SEC },
    NOW,
  );
  assert.equal(dn.pillCls, 'dn');
  assert.equal(dn.pillText, '▼ -9.97 · -1.13%');
  const flat = goldCardOf({ price: 880.0, change_pct: 0, change_amt: 0, time: NOW_SEC }, NOW);
  assert.equal(flat.pillCls, 'none');
  assert.equal(flat.pillText, '— 0.00 · 0.00%');
  const noAmt = goldCardOf(
    { price: 880.0, change_pct: 0.26, change_amt: null, time: NOW_SEC },
    NOW,
  );
  assert.equal(noAmt.pillText, '▲ +0.26%'); // 涨跌额缺失只显示涨跌幅
  // 涨跌额恰为 0 而涨跌幅非 0：方向以涨跌幅定向，防箭头与百分比矛盾
  const zeroAmt = goldCardOf({ price: 880.0, change_pct: 0.5, change_amt: 0, time: NOW_SEC }, NOW);
  assert.equal(zeroAmt.pillCls, 'up');
  assert.ok(zeroAmt.pillText.startsWith('▲ '));
  const zeroDn = goldCardOf({ price: 880.0, change_pct: -0.3, change_amt: 0, time: NOW_SEC }, NOW);
  assert.equal(zeroDn.pillCls, 'dn');
});

test('goldCardOf：跨日时间戳显示「MM-DD HH:mm」，无效时间显示空串', () => {
  const old = goldCardOf({ price: 880, change_pct: 0, change_amt: 0, time: 1e9 }, NOW);
  assert.match(old.timeText, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  const none = goldCardOf({ price: 880, change_pct: 0, change_amt: 0, time: null }, NOW);
  assert.equal(none.timeText, '');
});

test('goldBlockHtml：开市态渲染固定名/单位/涨跌胶囊/头部状态条；无标注行', () => {
  const html = goldBlockHtml(
    { price: 907.32, change_pct: 0.26, change_amt: 2.35, time: NOW_SEC },
    { phase: 'open', now: NOW },
  );
  assert.ok(html.includes('上金所 Au99.99'));
  assert.ok(html.includes('907.32'));
  assert.ok(html.includes('元/克'));
  assert.ok(html.includes('▲ +2.35 · +0.26%'));
  assert.ok(html.includes('idxm-pill up'));
  assert.ok(html.includes('上金所 开盘中'));
  assert.ok(html.includes('idxm-dot open'));
  assert.ok(!html.includes('goldm-note')); // 卡底解释文字已按用户指令移除
});

test('goldBlockHtml：午休/收盘态文案与状态点；休市不亮开市点', () => {
  const g = { price: 907.32, change_pct: 0, change_amt: 0, time: NOW_SEC };
  assert.ok(goldBlockHtml(g, { phase: 'lunch', now: NOW }).includes('午间休市'));
  const closed = goldBlockHtml(g, { phase: 'closed', now: NOW });
  assert.ok(closed.includes('已收盘'));
  assert.ok(!closed.includes('idxm-dot open'));
});

test('goldBlockHtml：加载态骨架屏（gold 为 null），头部「行情获取中」', () => {
  const html = goldBlockHtml(null, { phase: null, now: NOW });
  assert.ok(html.includes('sk-price'));
  assert.ok(html.includes('sk-pill'));
  assert.ok(html.includes('行情获取中'));
  assert.ok(html.includes('--:--'));
  assert.ok(!html.includes('907'));
});

test('goldBlockHtml：降级态黄条在卡底，最近成功价照常展示', () => {
  const html = goldBlockHtml(
    { price: 872.98, change_pct: -1.18, change_amt: -10.44, time: NOW_SEC, degraded: true },
    { phase: 'closed', now: NOW },
  );
  assert.ok(html.includes('goldm-degraded'));
  assert.ok(html.includes('872.98'));
  assert.ok(html.includes('最近成功价'));
});

test('goldBlockHtml：降级黄条时间戳缺值时不留空位', () => {
  const html = goldBlockHtml(
    { price: 872.98, change_pct: -1.18, change_amt: -10.44, time: null, degraded: true },
    { phase: 'closed', now: NOW },
  );
  assert.ok(html.includes('行情源暂不可用，恢复后自动刷新')); // 无「最近成功价 ，」空位
  assert.ok(!html.includes('最近成功价 ，'));
});

test('goldBlockHtml：冷启动失败占位卡（价格 --、胶囊 —、黄条无「最近成功价」）', () => {
  const item = { price: NaN, change_pct: null, change_amt: null, time: null, degraded: true };
  assert.equal(goldCardOf(item, NOW).priceText, '--');
  // 两卡同为冷启动失败：全块零骨架屏（骨架只表示加载中，不表达失败）
  const html = goldBlockHtml(item, { intl: item, phase: 'closed', intlPhase: 'closed', now: NOW });
  assert.equal((html.match(/goldm-card"/g) || []).length, 2);
  assert.equal((html.match(/sk-price/g) || []).length, 0);
  assert.equal((html.match(/goldm-degraded/g) || []).length, 2);
  assert.ok(html.includes('行情源暂不可用，恢复后自动刷新'));
  assert.ok(!html.includes('最近成功价'));
});

test('goldBlockHtml：区块排序手柄（data-blk=gold；唯一可见块上下移全禁用）', () => {
  const html = goldBlockHtml(null, { phase: 'open', orderCtx: { pos: 0, len: 1 }, now: NOW });
  assert.ok(html.includes('data-blk="gold"'));
  assert.equal((html.match(/disabled/g) || []).length, 2);
  const mid = goldBlockHtml(null, {
    phase: 'open',
    orderCtx: { pos: 1, len: 3 },
    now: NOW,
  });
  assert.equal((mid.match(/disabled/g) || []).length, 0);
});

test('goldBlockHtml：国际金价次卡（美元/盎司、状态条第二项、独立降级）', () => {
  const html = goldBlockHtml(
    { price: 872.98, change_pct: -1.18, change_amt: -10.44, time: NOW_SEC },
    {
      intl: { price: 4056.1, change_pct: 0.64, change_amt: 25.9, time: NOW_SEC },
      phase: 'closed',
      intlPhase: 'open',
      now: NOW,
    },
  );
  assert.ok(html.includes('国际金价'));
  assert.ok(html.includes('4056.10'));
  assert.ok(html.includes('美元/盎司'));
  assert.ok(html.includes('▲ +25.90 · +0.64%'));
  assert.ok(html.includes('国际金价 开盘中')); // 头部状态条第二项（Globex 与上金所时段独立）
  // 国际金价降级：黄条只在次卡，上金所卡不受影响
  const html2 = goldBlockHtml(
    { price: 872.98, change_pct: -1.18, change_amt: -10.44, time: NOW_SEC },
    {
      intl: { price: 4056.1, change_pct: 0.64, change_amt: 25.9, time: NOW_SEC, degraded: true },
      phase: 'closed',
      intlPhase: 'open',
      now: NOW,
    },
  );
  assert.equal((html2.match(/goldm-degraded/g) || []).length, 1);
});

test('goldBlockHtml：国际金价 null → 骨架卡占位（两卡网格卡位恒定）', () => {
  const html = goldBlockHtml(null, { intl: null, phase: 'open', intlPhase: 'open', now: NOW });
  assert.equal((html.match(/sk-price/g) || []).length, 2);
  assert.equal((html.match(/goldm-card"/g) || []).length, 2);
});

test('goldBlockHtml：收起按钮双文案与折叠容器（与指数监控同款）', () => {
  const html = goldBlockHtml(null, { phase: 'open', now: NOW });
  assert.ok(html.includes('goldm-btn'));
  assert.ok(html.includes('t-open'));
  assert.ok(html.includes('t-closed'));
  assert.ok(html.includes('goldm-chev'));
  assert.ok(html.includes('goldm-body')); // 折叠动画容器（.is-collapsed 由外层 CSS 切换）
  assert.ok(html.includes('goldm-clip'));
});

test('goldBlockHtml：网格列数类随卡数写入（两卡 is-2 自适应撑满）', () => {
  const html = goldBlockHtml(null, { intl: null, phase: 'open', now: NOW });
  assert.ok(html.includes('goldm-grid is-2'));
});
