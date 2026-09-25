import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPARK_LAYOUT,
  SPARK_MIN_BOUND,
  sparkBound,
  sparkY,
  sparkX,
  indexSparkSvg,
} from '../../js/components/indexSpark.js';
import { INDEX_SESSIONS } from '../../js/marketClock.js';

// ---- 夹具 ----
const P = (t, pct) => [t, pct];
/** A股全天两段夹具：上午段 3 个采样点 + 下午段 3 个采样点 */
const CN = [
  P('09:30', -0.2),
  P('10:30', -1.0),
  P('11:30', -1.5),
  P('13:01', -1.4),
  P('14:00', -0.9),
  P('15:00', -0.84),
];
const US = [P('09:31', -1.0), P('12:00', -0.5), P('16:00', -1.07)];
const SVG = (pts, o) => indexSparkSvg(pts, o);
const ys = (html) => [...html.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
const xs = (html) => [...html.matchAll(/[ML]([\d.]+) [\d.]+/g)].map((m) => Number(m[1]));

test('域半宽：零轴对称取 max|pct| 与底噪 0.5%（空/非法输入不产生 Infinity/NaN）', () => {
  assert.equal(sparkBound([-1.2, 0.3]), 1.2);
  assert.equal(sparkBound([-2.97, -1.79]), 2.97);
  assert.equal(sparkBound([0.01, -0.02]), SPARK_MIN_BOUND); // 窄幅横盘 → 底噪兜底
  assert.equal(sparkBound([]), SPARK_MIN_BOUND); // 空数组（Math.max(...[]) 会给 -Infinity）
  assert.equal(sparkBound(null), SPARK_MIN_BOUND);
  assert.equal(sparkBound(['x', NaN, Infinity]), SPARK_MIN_BOUND);
});

test('映射：中线恒为昨收（y=17）；±bound 落在 2px 内边距上（不贴边、不被裁）', () => {
  const mid = SPARK_LAYOUT.H / 2;
  assert.equal(sparkY(0, 2), mid); // 0% → 画布正中
  assert.equal(sparkY(2, 2), SPARK_LAYOUT.PAD); // +bound → 顶内边距（=2，避开描边裁切）
  assert.equal(sparkY(-2, 2), SPARK_LAYOUT.H - SPARK_LAYOUT.PAD); // −bound → 底内边距（=32）
  // 全天平盘（pct 全 0）→ 落在正中且无 NaN
  const flat = [P('09:30', 0), P('10:30', 0), P('15:00', 0)];
  const html = SVG(flat, { market: 'cn', pct: 0 });
  assert.equal(html.includes('NaN'), false);
  assert.ok(ys(html).every((y) => Math.abs(y - mid) < 1e-9));
});

test('x 映射：每段等宽（午休不占宽度）、段内线性；两段市场接缝落在段宽处', () => {
  const W = SPARK_LAYOUT.W;
  assert.equal(sparkX(INDEX_SESSIONS.cn, '09:30'), 0); // 上午段首
  assert.equal(sparkX(INDEX_SESSIONS.cn, '11:30'), W / 2); // 上午段末 = 接缝
  assert.equal(sparkX(INDEX_SESSIONS.cn, '13:00'), W / 2); // 下午段首 = 同一接缝（挨着）
  assert.equal(sparkX(INDEX_SESSIONS.cn, '15:00'), W); // 全天末
  assert.equal(sparkX(INDEX_SESSIONS.hk, '12:00'), W / 2); // 港股上午段末（150 分）
  assert.equal(sparkX(INDEX_SESSIONS.hk, '16:00'), W); // 港股下午段末（180 分）
  assert.equal(sparkX(INDEX_SESSIONS.us, '16:00'), W); // 美股单段
  assert.equal(sparkX(INDEX_SESSIONS.us, '09:30'), 0);
  assert.equal(sparkX(INDEX_SESSIONS.cn, '01:00'), 0); // 非法时间 → 归段首（不 NaN）
});

test('渲染：单个 path、跨段连线（M 仅 1）、无填充、无坐标轴/网格/刻度/标签', () => {
  const html = SVG(CN, { market: 'cn', pct: -0.84 });
  assert.equal((html.match(/<path/g) || []).length, 1);
  assert.equal((html.match(/M/g) || []).length, 1); // 跨午休连线，不新增子路径
  assert.ok(html.includes('fill="none"'));
  // 缩略图明确不画这些（反例断言：防日后"顺手加上"）
  for (const bad of ['<circle', '<line', '<text', '<rect', 'stroke-dasharray']) {
    assert.equal(html.includes(bad), false, `不应出现 ${bad}`);
  }
});

test('渲染：固定 viewBox + preserveAspectRatio=none + non-scaling-stroke（缺一不可）', () => {
  const html = SVG(CN, { market: 'cn', pct: -0.84 });
  assert.ok(html.includes(`viewBox="0 0 ${SPARK_LAYOUT.W} ${SPARK_LAYOUT.H}"`));
  assert.ok(html.includes('preserveAspectRatio="none"'));
  assert.ok(html.includes('vector-effect="non-scaling-stroke"'));
  assert.ok(html.includes('aria-hidden="true"'));
});

test('渲染：涨/跌/平三色；点数不足或入参非法 → 空串', () => {
  assert.ok(SVG(CN, { market: 'cn', pct: 1.2 }).includes('var(--color-up)'));
  assert.ok(SVG(CN, { market: 'cn', pct: -1.2 }).includes('var(--color-down)'));
  assert.ok(SVG(CN, { market: 'cn', pct: 0 }).includes('var(--color-muted)'));
  assert.ok(SVG(CN, { market: 'cn', pct: null }).includes('var(--color-muted)'));
  assert.equal(SVG(null, { pct: 1 }), '');
  assert.equal(SVG([], { pct: 1 }), '');
  assert.equal(SVG([P('09:30', -1)], { pct: -1 }), ''); // 单点 → 画不出线
  assert.equal(indexSparkSvg('not-array', { pct: 1 }), '');
});

test('渲染：未知 market 退回 A 股分段（不抛）；点数多时 y 全部落在 [PAD, H−PAD] 内', () => {
  const one = [P('09:31', -1.0), P('12:00', -0.5), P('16:00', -1.07)];
  const html = SVG(one, { market: 'unknown-market', pct: -1.07 });
  assert.ok(html.includes('<path'));
  const dense = Array.from({ length: 48 }, (_, i) =>
    P(
      `${String(9 + Math.floor((i * 5 + 30) / 60)).padStart(2, '0')}:${String((i * 5 + 30) % 60).padStart(2, '0')}`,
      (i % 7) - 3,
    ),
  );
  const h2 = SVG(dense, { market: 'cn', pct: 1 });
  for (const y of ys(h2))
    assert.ok(
      y >= SPARK_LAYOUT.PAD - 1e-9 && y <= SPARK_LAYOUT.H - SPARK_LAYOUT.PAD + 1e-9,
      `y=${y} 越界`,
    );
});
