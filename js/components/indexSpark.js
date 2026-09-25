/**
 * 核心指数卡内「当天迷你分时」内联SVG渲染，纯函数，支持Node单测。
 *
 * 四条不可修改约定（均来自实测与回归踩坑）：
 * 1. 固定 viewBox + preserveAspectRatio="none"：图形随卡片宽度伸缩，无需实测宽度、无需resize监听；
 *    缩略图无坐标轴、无命中反查，独立于估值走势图「实测宽度 + hitAt」体系。
 * 2. 非等比缩放会拉变形线宽，必须添加 vector-effect="non-scaling-stroke"。
 * 3. 动态零轴对称：bound = max(max|pct|, 0.5%)。中线固定为昨收，保证幅度可比；
 *    值域宽度恒 ≥1%，消除除零、平盘场景NaN问题。
 * 4. Y方向预留2px内边距：overflow:hidden + 1.4px描边，贴边波峰波谷会被裁掉约0.7px。
 *
 * 无轴、网格、刻度、标签、交互（主动设计，非遗漏）；颜色采用全站令牌，亮暗自动适配。
 * 模块零副作用，不操作DOM；交易分段由 marketClock.INDEX_SESSIONS 注入，口径单一来源。
 */
import { INDEX_SESSIONS } from '../marketClock.js';

export const SPARK_LAYOUT = { W: 120, H: 34, PAD: 2 };
/** 视觉底噪：半天不动时也别把 0.0x% 的抖动放大成巨震（同时保证域宽恒 ≥1%） */
export const SPARK_MIN_BOUND = 0.5;

const hmMin = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));

/**
 * 零轴对称域半宽：`max(max|pct|, 0.5%)`；空数组也返回底噪（不产生 Infinity/NaN）。
 * @param {Array<number>} pcts 涨跌幅序列
 * @returns {number} 域半宽
 */
export function sparkBound(pcts) {
  let m = 0;
  for (const v of pcts || []) {
    const a = Math.abs(Number(v));
    if (Number.isFinite(a) && a > m) m = a;
  }
  return Math.max(m, SPARK_MIN_BOUND);
}

/** 值 → y：中线（pct=0）恒为画布正中；±bound 落在内边距上（不贴边、不被裁） */
export function sparkY(pct, bound, { H = SPARK_LAYOUT.H, PAD = SPARK_LAYOUT.PAD } = {}) {
  const b = bound > 0 ? bound : SPARK_MIN_BOUND;
  return PAD + (1 - (Number(pct) + b) / (2 * b)) * (H - PAD * 2);
}

/** 时间 → x：每段等宽（午休不占宽度），段内线性；时间段非法 → 归到段首 */
export function sparkX(segments, t, W = SPARK_LAYOUT.W) {
  const segs = Array.isArray(segments) && segments.length ? segments : INDEX_SESSIONS.cn;
  const segW = W / segs.length;
  const v = hmMin(t);
  for (let i = 0; i < segs.length; i++) {
    const a = hmMin(segs[i][0]);
    const b = hmMin(segs[i][1]);
    if (v <= b || i === segs.length - 1) {
      const c = Math.min(Math.max(v, a), b);
      return i * segW + (b - a > 0 ? (c - a) / (b - a) : 0) * segW;
    }
  }
  return 0;
}

/**
 * 渲染迷你分时。
 * @param {Array<[string, number]>|null} pts `[[t, pct], …]`（服务端已抽稀 ≤48 点，相对昨收的涨跌幅）
 * @param {{market?:string, pct?:number|null}} [opts] `market` 决定分段（cn/hk 两段、us 单段）；
 *        `pct` 为最新涨跌幅，决定线条颜色（>0 涨 / <0 跌 / 其余 中性）
 * @returns {string} 内联 SVG；点数不足 2 或入参非法 → 空串（调用方渲染「暂无分时」）
 */
export function indexSparkSvg(pts, { market = 'cn', pct = null } = {}) {
  if (!Array.isArray(pts) || pts.length < 2) return '';
  const segs = INDEX_SESSIONS[market] || INDEX_SESSIONS.cn;
  const bound = sparkBound(pts.map((p) => p[1]));
  const d = pts
    .map(
      ([t, v], i) => `${i ? 'L' : 'M'}${sparkX(segs, t).toFixed(2)} ${sparkY(v, bound).toFixed(2)}`,
    )
    .join(' ');
  const n = Number(pct);
  const color =
    !Number.isFinite(n) || n === 0
      ? 'var(--color-muted)'
      : n > 0
        ? 'var(--color-up)'
        : 'var(--color-down)';
  return (
    `<svg class="spark-svg" viewBox="0 0 ${SPARK_LAYOUT.W} ${SPARK_LAYOUT.H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
  );
}
