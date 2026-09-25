import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURVE_LAYOUT,
  METRICS,
  halfWidth,
  getSplitLineX,
  timeToX,
  valToY,
  getYGridLines,
  curveValueOf,
  fmtCurveValue,
  buildEstimateCurve,
  estimateCurveSvg,
  estimateCurveHitAt,
  EMPTY_REASON_TEXT,
  pnlBlockReason,
} from '../../js/components/estimateCurve.js';

// ---- 夹具 ----

const P = (t, nav, change_pct) => ({ t, nav, change_pct });
/** 默认夹具：点间隔 ≤1 分钟（真实源约 1~2 分钟一点），否则会被"Δt>5min 断笔"规则切成多段 */
const CURVE = (over = {}) => ({
  code: '110020',
  market_date: '2026-09-11',
  points: [
    P('09:58', 1.845, -1.1),
    P('09:59', 1.8442, -1.2),
    P('10:00', 1.8434, -1.3),
    P('10:01', 1.8426, -1.4),
    P('10:02', 1.8418, -1.45),
  ],
  worth: 1.8653,
  worth_date: '2026-09-10',
  dropped_other_day: false,
  ...over,
});
/** 默认：有持仓、交易日盘中 11:40、已拿到行情 */
const V = (opts = {}) =>
  buildEstimateCurve(opts.curve === undefined ? CURVE() : opts.curve, {
    shares: 10218.4,
    marketDate: '2026-09-11',
    isTradingDay: true,
    hasQuote: true,
    nowMinutes: 700,
    ...opts,
  });
const SVG = (view, metric = 'pct', width = 600) => estimateCurveSvg(view, { metric, width });
const countM = (d) => (d.match(/M/g) || []).length;

// ---- 视图模型（13 条）----

test('① 三口径数值：pct=change_pct、nav=nav、pnl=round2(shares×(nav−worth))', () => {
  const v = V();
  const p = v.points.find((x) => x.t === '10:00');
  assert.equal(curveValueOf(p, 'pct'), -1.3);
  assert.equal(curveValueOf(p, 'nav'), 1.8434);
  // 10218.4 × (1.8434 − 1.8653)
  assert.equal(curveValueOf(p, 'pnl'), Math.round(10218.4 * (1.8434 - 1.8653) * 100) / 100);
});

test('② pnlAvailable 三条件：worth 缺失 / shares=0 / worth_date===marketDate 均不可用', () => {
  assert.equal(V({ worth: undefined, curve: { ...CURVE(), worth: null } }).pnlAvailable, false);
  assert.equal(V({ shares: 0 }).pnlAvailable, false);
  assert.equal(V({ curve: { ...CURVE(), worth_date: '2026-09-11' } }).pnlAvailable, false);
  assert.equal(V().pnlAvailable, true);
});

test('③ 字段归一：只给接口形态 worth_date 也能让 isConfirmed 生效', () => {
  assert.equal(
    V({ curve: { ...CURVE(), worth_date: '2026-09-11' }, status: null }).isConfirmed,
    true,
  );
  // 驼峰形态：接口没给 worth_date 时才回退（两者都在时以接口 snake_case 为准）
  assert.equal(
    V({ curve: { ...CURVE(), worth_date: undefined, worthDate: '2026-09-11' } }).isConfirmed,
    true,
  );
  assert.equal(V().isConfirmed, false);
});

test('④ loading 守卫最优先：loading 时不因 marketDate 未到而误报"非交易日"', () => {
  const v = V({ curve: null, loading: true, marketDate: null });
  assert.equal(v.emptyReason, 'loading');
  assert.equal(EMPTY_REASON_TEXT.loading, '正在加载走势…');
});

test('⑤ error 次优先：拉取失败且无数据 → error（不是"无曲线"）', () => {
  assert.equal(V({ curve: null, error: 'boom' }).emptyReason, 'error');
});

test('⑥ emptyReason 七分支齐全且文案齐备', () => {
  assert.equal(V({ curve: null, loading: true }).emptyReason, 'loading');
  assert.equal(V({ curve: null, error: 'x' }).emptyReason, 'error');
  assert.equal(V({ curve: null, isQdii: true }).emptyReason, 'qdii');
  assert.equal(
    V({ curve: null, isTradingDay: false, nowMinutes: 600 }).emptyReason,
    'not_trading_day',
  );
  assert.equal(V({ curve: null, nowMinutes: 500 }).emptyReason, 'pre_open');
  assert.equal(V({ curve: null, hasQuote: false, nowMinutes: 700 }).emptyReason, 'no_quote');
  assert.equal(V({ curve: null, nowMinutes: 700 }).emptyReason, 'no_estimate');
  assert.equal(V().emptyReason, null); // 有数据 → 无空态
  for (const k of [
    'loading',
    'error',
    'qdii',
    'not_trading_day',
    'pre_open',
    'no_quote',
    'no_estimate',
  ]) {
    assert.ok(EMPTY_REASON_TEXT[k], k + ' 文案缺失');
  }
});

test('⑦ pct/pnl 零轴对称：hi === −lo（0 线恒在画布正中），并含 12% 余量与分口径保底', () => {
  const v = V();
  assert.equal(v.metrics.pct.hi, -v.metrics.pct.lo);
  assert.equal(v.metrics.pnl.hi, -v.metrics.pnl.lo);
  // 平盘（全 0）→ 走保底 0.5% / 10 元，而不是 0 或 Infinity
  const flat = V({ curve: { ...CURVE(), points: [P('09:30', 1.8653, 0), P('10:00', 1.8653, 0)] } });
  assert.equal(flat.metrics.pct.hi, 0.5);
  assert.equal(flat.metrics.pnl.hi, 10);
});

test('⑧ nav 域自适应；单点/横盘除零兜底（hi !== lo）', () => {
  const v = V();
  assert.ok(v.metrics.nav.hi > v.metrics.nav.lo);
  const one = V({ curve: { ...CURVE(), points: [P('09:30', 1.85, -0.1)] } });
  assert.ok(one.metrics.nav.hi > one.metrics.nav.lo); // 单点也不除零
  const flat = V({ curve: { ...CURVE(), points: [P('09:30', 1.85, 0), P('10:00', 1.85, 0)] } });
  assert.ok(flat.metrics.nav.hi > flat.metrics.nav.lo); // 全天横盘
});

test('⑨ 空 points → 默认 metrics（绝不 Infinity：不对空数组跑 Math.min/max）', () => {
  const v = V({ curve: { ...CURVE(), points: [] } });
  assert.deepEqual(v.metrics.pct, { lo: -0.5, hi: 0.5 });
  assert.deepEqual(v.metrics.pnl, { lo: -10, hi: 10 });
  assert.deepEqual(v.metrics.nav, { lo: 0.995, hi: 1.005 });
  for (const k of ['pct', 'pnl', 'nav']) {
    assert.ok(
      Number.isFinite(v.metrics[k].lo) && Number.isFinite(v.metrics[k].hi),
      k + ' 出现非有限值',
    );
  }
});

test('⑩ showAfternoonPlaceholder：仅"有上午点 + 无下午点 + 墙钟 ∈ [690, 785)"为 true', () => {
  assert.equal(V({ nowMinutes: 690 }).showAfternoonPlaceholder, true);
  assert.equal(V({ nowMinutes: 784 }).showAfternoonPlaceholder, true);
  assert.equal(V({ nowMinutes: 689 }).showAfternoonPlaceholder, false);
  assert.equal(V({ nowMinutes: 785 }).showAfternoonPlaceholder, false);
  assert.equal(V({ nowMinutes: 960 }).showAfternoonPlaceholder, false); // 收盘后不再提示
  const withPm = V({
    curve: { ...CURVE(), points: [...CURVE().points, P('13:01', 1.84, -1.2)] },
    nowMinutes: 790,
  });
  assert.equal(withPm.showAfternoonPlaceholder, false); // 有下午点就不提示
});

test('⑪ hasMorningPoints / hasAfternoonPoints 判定（≤11:30 / ≥13:00）', () => {
  const v = V();
  assert.equal(v.hasMorningPoints, true);
  assert.equal(v.hasAfternoonPoints, false);
  assert.equal(v.hasMorningPoints, true); // 11:30 计入上午
  const withPm = V({ curve: { ...CURVE(), points: [P('13:00', 1.84, -1.2)] } });
  assert.equal(withPm.hasMorningPoints, false);
  assert.equal(withPm.hasAfternoonPoints, true);
});

test('⑫ isConfirmed 与 pnlAvailable 同源判据（今日净值已出 → 两者同时翻转）', () => {
  const today = V({ curve: { ...CURVE(), worth_date: '2026-09-11' } });
  assert.equal(today.isConfirmed, true);
  assert.equal(today.pnlAvailable, false);
  const past = V();
  assert.equal(past.isConfirmed, false);
  assert.equal(past.pnlAvailable, true);
});

test('⑬ round2 精度：pnl 两位小数（不成串尾差）', () => {
  const v = V();
  for (const p of v.points) {
    assert.equal(Number(p.pnl.toFixed(2)), p.pnl);
  }
});

// ---- 渲染（14 条）----

test('渲染① 折线只有 1 条 path 且 fill="none"（反例：不得出现第二条填充 path）', () => {
  const html = SVG(V());
  assert.equal((html.match(/<path/g) || []).length, 1);
  assert.ok(html.includes('fill="none"'));
});

test('渲染② 0 基线与折线共用 valToY：getYGridLines() = 12 / 70 / 128（不是 HEIGHT/2=75）', () => {
  assert.deepEqual(getYGridLines(), { topY: 12, zeroY: 70, bottomY: 128 });
  const v = V();
  assert.equal(valToY(0, v.metrics.pct), 70); // 对称域下 0 线落在 zeroY
  assert.ok(SVG(v).includes('y1="70"'));
});

test('渲染③ x 轴四标签与 anchor（11:30 右对齐、13:00 左对齐，防中缝叠字）', () => {
  const html = SVG(V());
  for (const t of ['09:30', '11:30', '13:00', '15:00']) assert.ok(html.includes(`>${t}</text>`), t);
  assert.ok(html.includes(`text-anchor="end" font-size="10" fill="currentColor">11:30`));
  assert.ok(html.includes(`text-anchor="start" font-size="10" fill="currentColor">13:00`));
  // GAP=0 后两标签在接缝同位 → 各向外让 3px，否则渲染成"11:3013:00"贴成一句
  const xOf = (t) =>
    Number(
      html.match(
        new RegExp(`x="([\\d.]+)" y="144" text-anchor="[a-z]+" font-size="10"[^>]*>${t}<`),
      )[1],
    );
  assert.equal(getSplitLineX(600) - xOf('11:30'), 3);
  assert.equal(xOf('13:00') - getSplitLineX(600), 3);
});

test('渲染④ 投影锚点：width=600 时 11:30=13:00=319（午休挨着）、15:00=590=W−PR；入参兼容', () => {
  assert.equal(timeToX(690, 600), 319);
  assert.equal(timeToX(780, 600), 319); // GAP=0：下午起点与上午终点同位（挨着，不空 12px）
  assert.equal(timeToX(900, 600), 590);
  assert.equal(590, 600 - CURVE_LAYOUT.PR);
  assert.equal(timeToX('11:30', 600), timeToX(690, 600)); // 字符串入参
  assert.equal(getSplitLineX(600), 319);
  assert.equal(halfWidth(600), 271);
});

test('渲染⑤ 4-A 全天样本：跨午休不断笔 → `M` 仅 1 次，接缝处为一段竖直连线', () => {
  const v = V({
    curve: {
      ...CURVE(),
      points: [
        P('11:29', 1.857, -1.45),
        P('11:30', 1.856, -1.5),
        P('13:00', 1.848, -0.9),
        P('13:02', 1.841, -1.1),
      ],
    },
  });
  const d = SVG(v).match(/<path class="curve[^"]*" d="([^"]+)"/)[1];
  assert.equal(countM(d), 1, '整条日线一个子路径（午休不再断笔）');
  // 上午末点与下午首点同 x → 连接段竖直：`... L319.0 y1 L319.0 y2 ...`
  assert.ok(/L319\.0 [\d.]+ L319\.0 [\d.]+/.test(d), '接缝处有竖直连接段');
});

test('渲染⑥ 4-B 午休窗口：右半场含「午后 13:00 开市后继续」', () => {
  const html = SVG(V({ nowMinutes: 700 }));
  assert.ok(html.includes('午后 13:00 开市后继续'));
});

test('渲染⑦ 4-C 收盘后仍无下午点：右半场静默、无该文案', () => {
  const html = SVG(V({ nowMinutes: 960 }));
  assert.equal(html.includes('午后 13:00 开市后继续'), false);
});

test('渲染⑧ 零轴对称：上下两档 y 刻度互为相反数', () => {
  const v = V();
  assert.equal(v.metrics.pct.hi.toFixed(1), (-v.metrics.pct.lo).toFixed(1));
  const html = SVG(v, 'pct');
  const ticks = [...html.matchAll(/class="ytick"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0], '+' + v.metrics.pct.hi.toFixed(1) + '%');
  assert.equal(ticks[1], v.metrics.pct.lo.toFixed(1) + '%');
});

test('渲染⑨ 断流：同一半场内相邻点间隔 > 5 分钟 → 断笔（`M` 数 +1）', () => {
  const dense = V({
    curve: { ...CURVE(), points: [P('10:00', 1.85, -0.5), P('10:03', 1.849, -0.6)] },
  });
  assert.equal(countM(SVG(dense)), 1);
  const gap = V({
    curve: { ...CURVE(), points: [P('10:00', 1.85, -0.5), P('10:06', 1.849, -0.6)] },
  });
  assert.equal(countM(SVG(gap)), 2); // 不跨空白直连
});

test('渲染⑩ isConfirmed → 折线/末点带 .is-confirmed', () => {
  const html = SVG(V({ curve: { ...CURVE(), worth_date: '2026-09-11' } }));
  assert.ok(html.includes('class="curve is-confirmed"'));
  assert.ok(html.includes('class="dot is-confirmed"'));
  assert.equal(html.includes('class="curve"'), false);
});

test('渲染⑪ 末点数值与 fmtCurveValue 一致（各口径）', () => {
  const v = V();
  const last = v.points[v.points.length - 1];
  assert.ok(SVG(v, 'pct').includes(fmtCurveValue(curveValueOf(last, 'pct'), 'pct')));
  assert.ok(SVG(v, 'nav').includes(fmtCurveValue(curveValueOf(last, 'nav'), 'nav')));
  assert.ok(SVG(v, 'pnl').includes(fmtCurveValue(curveValueOf(last, 'pnl'), 'pnl')));
});

test('渲染⑫ 三口径 y 标签量纲正确（% / 小数 / 取整）', () => {
  const v = V();
  assert.ok(/-?\d+\.\d%/.test(SVG(v, 'pct')));
  assert.ok(/1\.\d{3}/.test(SVG(v, 'nav')));
  assert.ok(/\d/.test(SVG(v, 'pnl')) && !/%/.test(SVG(v, 'pnl')));
});

test('渲染⑬ pnlAvailable === false → 不画 pnl 折线（且无 0 基线可画）', () => {
  const v = V({ shares: 0 });
  assert.equal(v.pnlAvailable, false);
  const html = SVG(v, 'pnl');
  assert.equal((html.match(/<path/g) || []).length, 0);
});

test('渲染⑭ 空 points / width<=0 不抛、不产出畸变 SVG', () => {
  assert.equal(SVG(V({ curve: null })), '');
  assert.equal(estimateCurveSvg(V(), { metric: 'pct', width: 0 }), '');
  assert.equal(estimateCurveSvg(V(), { metric: 'pct', width: -5 }), '');
});

// ---- 命中反查（渲染与反查共用几何）----

test('命中：返回 {index,x,y,value,t}，x/y 与渲染同源（valToY/timeToX）', () => {
  const v = V();
  const x = timeToX('10:00', 600);
  const hit = estimateCurveHitAt(v, x, 600, 'pct');
  assert.equal(hit.t, '10:00');
  assert.equal(hit.x, x);
  assert.equal(hit.value, -1.3);
  assert.equal(hit.y, valToY(hit.value, v.metrics.pct));
});

test('命中闸：留白区 / 超出吸附半径 → null；中缝无死区（GAP=0，两半场挨着）', () => {
  const v = V();
  assert.equal(estimateCurveHitAt(v, 10, 600, 'pct'), null); // 左侧留白（< PL）
  assert.equal(estimateCurveHitAt(v, 598, 600, 'pct'), null); // 右侧留白（> W−PR）
  // 10:00 与 11:30 之间取中点 → 距最近点远超 10px
  const mid = (timeToX('10:00', 600) + timeToX('11:30', 600)) / 2;
  assert.equal(estimateCurveHitAt(v, mid, 600, 'pct'), null);
  // 中缝：旧 GAP=12 时这里是 12px 死区；GAP=0 后 11:30 与 13:00 同位，分隔线处应有读数
  const seamV = V({
    curve: {
      ...CURVE(),
      points: [
        P('11:29', 1.857, -1.45),
        P('11:30', 1.856, -1.5),
        P('13:00', 1.85, -0.9),
        P('13:01', 1.851, -0.85),
      ],
    },
  });
  const seam = estimateCurveHitAt(seamV, getSplitLineX(600), 600, 'pct');
  assert.ok(seam, '中缝处应有读数');
  assert.equal(seam.t, '11:30'); // 同位时取先出现者（points 已按时间升序）
  assert.equal(seam.x, getSplitLineX(600));
});

test('午休接缝：GAP=0（两半场挨着不空档）、分隔线在接缝且为虚线、跨午休连线（不断笔）', () => {
  assert.equal(CURVE_LAYOUT.GAP, 0);
  assert.equal(timeToX('11:30', 600), getSplitLineX(600));
  assert.equal(timeToX('13:00', 600), getSplitLineX(600)); // 下午起点不右移 12px
  const v = V({
    curve: {
      ...CURVE(),
      points: [
        P('11:29', 1.857, -1.45),
        P('11:30', 1.856, -1.5),
        P('13:00', 1.85, -0.9),
        P('13:01', 1.851, -0.85),
      ],
    },
  });
  const html = SVG(v);
  assert.ok(
    html.includes(`<line class="split" x1="${getSplitLineX(600).toFixed(1)}"`),
    '分隔线在接缝 x',
  );
  assert.ok(/class="split"[^>]*stroke-dasharray="3 3"/.test(html), '分隔线为虚线');
  const d = html.match(/<path class="curve[^"]*" d="([^"]+)"/)[1];
  assert.equal(countM(d), 1, '跨午休连线（不断笔）');
  assert.equal((d.match(/319\.0/g) || []).length, 2, '上午末点与下午首点都落在接缝上（无空档）');
});

test('命中守卫：无数据 / 该口径无有效值 → null（不得产出 NaN）', () => {
  assert.equal(estimateCurveHitAt(V({ curve: null }), 300, 600, 'pct'), null);
  const v = V({ shares: 0 }); // pnl 全 null
  const x = timeToX('10:00', 600);
  assert.equal(estimateCurveHitAt(v, x, 600, 'pnl'), null);
  assert.equal(estimateCurveHitAt(v, NaN, 600, 'pct'), null);
});

test('METRICS 三口径标签固定（前端切换按钮直接渲染）', () => {
  assert.deepEqual(
    METRICS.map((m) => m.key),
    ['pct', 'nav', 'pnl'],
  );
  assert.deepEqual(
    METRICS.map((m) => m.label),
    ['涨跌幅%', '估值净值', '估算当日盈亏'],
  );
});

test('pnlBlockReason：未持仓 / 今日净值已发布 → 置灰文案；否则空串（可用）', () => {
  // 未持仓（null / 0 / 负数都是"没有份额"）；真实持仓里没有这种基金，UI回归跑不到，只能在此覆盖
  assert.equal(
    pnlBlockReason({ shares: null, worthDate: '2026-09-10', marketDate: '2026-09-11' }),
    '未持仓，无法计算金额',
  );
  assert.equal(
    pnlBlockReason({ shares: 0, worthDate: '2026-09-10', marketDate: '2026-09-11' }),
    '未持仓，无法计算金额',
  );
  assert.equal(
    pnlBlockReason({ shares: -1, worthDate: '2026-09-10', marketDate: '2026-09-11' }),
    '未持仓，无法计算金额',
  );
  // 今日确认净值已出：worth 由昨收变今收，再算 nav−worth 只剩估算误差
  assert.equal(
    pnlBlockReason({ shares: 10218.4, worthDate: '2026-09-11', marketDate: '2026-09-11' }),
    '今日净值已确认，盘中估算盈亏已失效',
  );
  // 未持仓优先于日期（两条都命中时给"未持仓"）
  assert.equal(
    pnlBlockReason({ shares: 0, worthDate: '2026-09-11', marketDate: '2026-09-11' }),
    '未持仓，无法计算金额',
  );
  // 可用：worth 是昨日 / worthDate 缺失（加载中）→ 不禁用
  assert.equal(
    pnlBlockReason({ shares: 10218.4, worthDate: '2026-09-10', marketDate: '2026-09-11' }),
    '',
  );
  assert.equal(pnlBlockReason({ shares: 10218.4, worthDate: null, marketDate: '2026-09-11' }), '');
  assert.equal(pnlBlockReason({ shares: 10218.4, worthDate: '2026-09-11', marketDate: null }), '');
  assert.equal(pnlBlockReason(), '未持仓，无法计算金额'); // 无参（面板未打开）兜底
});
