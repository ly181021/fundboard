/**
 * 实时估值盘「当天估值走势」：视图模型 + 内联 SVG 渲染（纯函数，可 node 单测）。
 *
 * 【三条不可修改约定，均来自历史踩坑】
 * 1. 几何常量统一维护在 CURVE_LAYOUT：渲染、点击命中检测共用同一套，防止坐标偏移；
 * 2. 坐标映射函数统一复用（timeToX / valToY / getSplitLineX）
 *    - Y轴基线：PT + PLOT_H/2 = 70，不是画布总高 HEIGHT/2 = 75；
 *    - halfWidth 已包含 GAP，坐标映射时禁止再次扣除 GAP/2，避免15:00末端点缩进；
 *    - GAP = 0：午休时段无横向空隙，上午半场终点与下午半场起点重合于分隔线X；
 *    - 使用虚线作为午休边界标识；午休处不中断路径，增加竖直连接段；
 *    - 整体日线为单个M子路径；仅真实数据断流时才新建M路径；
 *    - halfWidth 计算公式固定为 (W−PL−PR−GAP)/2，方便后续调整GAP时保持几何自洽。
 * 3. 模块无副作用，不操作DOM；时间参数 nowMinutes / marketDate 全部由外部注入，保证可测试性。
 */

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export const CURVE_LAYOUT = {
  PL: 48, // padding-left：绘图区域左侧内边距
  PR: 10, // padding-right：绘图区域右侧内边距
  PT: 12, // padding-top：绘图区域顶部内边距
  PB: 22, // padding-bottom：绘图区域底部内边距
  GAP: 0, // 午休横向留白宽度：上下午交易半场之间的水平空隙。GAP>0时中间留白；GAP=0则上下午端点共用分隔线X坐标
  HEIGHT: 150, // SVG画布总高度
};
const PLOT_H = CURVE_LAYOUT.HEIGHT - CURVE_LAYOUT.PT - CURVE_LAYOUT.PB; // 116
const AM_OPEN_MIN = 570; // 09:30
const AM_CLOSE_MIN = 690; // 11:30
const PM_OPEN_MIN = 780; // 13:00
const GAP_BREAK_MIN = 5; // 相邻点间隔 > 5 分钟视为断流（正常约 1~2 分钟一点）
const HIT_RADIUS = 10; // 命中吸附半径（px）
const XTICK_INSET = 3; // 中缝两个时间标签各自向外让出的间距（GAP=0 时防"11:3013:00"贴成一句）

export const METRICS = [
  { key: 'pct', label: '涨跌幅%' },
  { key: 'nav', label: '估值净值' },
  { key: 'pnl', label: '估算当日盈亏' },
];

/** 单半场净宽：整个 GAP 只在此扣一次（映射展开时不得再扣） */
export function halfWidth(width) {
  return (width - CURVE_LAYOUT.PL - CURVE_LAYOUT.PR - CURVE_LAYOUT.GAP) / 2;
}

/** 半场分隔线 x（GAP = 0 时即两半场的接缝）；必须按响应式 width 计算，不得做成模块级常量 */
export function getSplitLineX(width) {
  return CURVE_LAYOUT.PL + halfWidth(width) + CURVE_LAYOUT.GAP / 2;
}

/** 时间 → X：入参兼容数字分钟与 'HH:mm' 字符串（传 `point.t` 不会 NaN） */
export function timeToX(tOrMins, width) {
  const mins =
    typeof tOrMins === 'number'
      ? tOrMins
      : Number(String(tOrMins).slice(0, 2)) * 60 + Number(String(tOrMins).slice(3, 5));
  const half = halfWidth(width);
  return mins <= AM_CLOSE_MIN
    ? CURVE_LAYOUT.PL + ((mins - AM_OPEN_MIN) / 120) * half
    : CURVE_LAYOUT.PL + half + CURVE_LAYOUT.GAP + ((mins - PM_OPEN_MIN) / 120) * half;
}

/** 值 → Y（SVG 原点在左上，值越大 Y 越小）；渲染与命中反查必须共用 */
export function valToY(val, { lo, hi }) {
  return CURVE_LAYOUT.PT + ((hi - val) / (hi - lo)) * PLOT_H;
}

/** 三条横线固定 Y：topY 12 / zeroY 70（不是 HEIGHT/2 = 75）/ bottomY 128 */
export function getYGridLines() {
  return {
    topY: CURVE_LAYOUT.PT,
    zeroY: CURVE_LAYOUT.PT + PLOT_H / 2,
    bottomY: CURVE_LAYOUT.HEIGHT - CURVE_LAYOUT.PB,
  };
}

/** 该口径下某点的值（无值/非有限 → null） */
export function curveValueOf(point, metric) {
  if (!point) return null;
  const v = metric === 'nav' ? point.nav : metric === 'pnl' ? point.pnl : point.change_pct;
  return v == null || !Number.isFinite(v) ? null : v;
}

/** 该口径的展示格式（null → '—'）：'pct' → `+0.00%`；'nav' → `0.0000`；'pnl' → `±¥0.00` */
export function fmtCurveValue(v, metric) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (metric === 'nav') return v.toFixed(4);
  if (metric === 'pnl') return (v > 0 ? '+' : v < 0 ? '-' : '') + '¥' + Math.abs(v).toFixed(2);
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

const round2 = (n) => Math.round(n * 100) / 100;
const minutesOf = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));

/** 空态默认量纲：不对空数组跑 Math.min/max（`Math.min(...[])` = Infinity） */
const DEFAULT_METRICS = {
  pct: { lo: -0.5, hi: 0.5 },
  pnl: { lo: -10, hi: 10 },
  nav: { lo: 0.995, hi: 1.005 },
};

/** 各口径的 Y 域：pct/pnl 零轴绝对居中（0 线恒在正中）+ 分口径保底；nav 自适应 + 极值兜底 */
function metricsOf(points, pnlAvailable) {
  if (points.length === 0)
    return {
      pct: { ...DEFAULT_METRICS.pct },
      pnl: { ...DEFAULT_METRICS.pnl },
      nav: { ...DEFAULT_METRICS.nav },
    };
  const valsOf = (metric) => points.map((p) => curveValueOf(p, metric)).filter((v) => v != null);
  const symmetric = (arr, floor) => {
    if (arr.length === 0) return { lo: -floor, hi: floor };
    const b = Math.max(Math.max(...arr.map((v) => Math.abs(v))) * 1.12, floor);
    return { lo: -b, hi: b };
  };
  const auto = (arr) => {
    if (arr.length === 0) return { lo: 0.995, hi: 1.005 };
    let lo = Math.min(...arr);
    let hi = Math.max(...arr);
    if (hi - lo < 1e-9) {
      const d = Math.max(Math.abs(hi) * 0.005, 1e-4);
      lo -= d;
      hi += d;
    }
    const pad = (hi - lo) * 0.12;
    return { lo: lo - pad, hi: hi + pad };
  };
  return {
    pct: symmetric(valsOf('pct'), 0.5),
    pnl: symmetric(pnlAvailable ? valsOf('pnl') : [], 10),
    nav: auto(valsOf('nav')),
  };
}

/**
 * 视图模型：数据 → 数据（不产出 HTML）。
 * @param {object|null} curve `/api/estimate-curve` 响应体（接口字段是下划线：`worth_date`/`dropped_other_day`）
 * @param {{shares?:number|null, isQdii?:boolean, status?:string|null, hasQuote?:boolean, loading?:boolean,
 *          error?:string|null, marketDate?:string|null, isTradingDay?:boolean, nowMinutes?:number|null}} [opts]
 * @returns {{ points: Array<{t:string,nav:number|null,change_pct:number|null,pnl:number|null}>,
 *   worth:number|null, worthDate:string|null, isConfirmed:boolean, pnlAvailable:boolean, hasData:boolean,
 *   hasMorningPoints:boolean, hasAfternoonPoints:boolean, showAfternoonPlaceholder:boolean,
 *   emptyReason:'loading'|'error'|'qdii'|'not_trading_day'|'pre_open'|'no_quote'|'no_estimate'|null,
 *   metrics:{pct:{lo,hi},pnl:{lo,hi},nav:{lo,hi}} }}
 */
export function buildEstimateCurve(curve, opts = {}) {
  const {
    shares = null,
    isQdii = false,
    status = null,
    hasQuote = false,
    loading = false,
    error = null,
    marketDate = null,
    isTradingDay = true,
    nowMinutes = null,
  } = opts;

  const raw = Array.isArray(curve?.points) ? curve.points : [];
  const worth = Number.isFinite(curve?.worth) ? curve.worth : null;
  const worthDate = curve?.worth_date ?? curve?.worthDate ?? null; // 接口下划线 + 解析器驼峰都兼容
  const isConfirmed = status === 'confirmed' || (!!worthDate && worthDate === marketDate);
  const pnlAvailable = !!(
    shares != null &&
    shares > 0 &&
    worth != null &&
    worthDate !== marketDate
  );

  const points = raw
    .filter((p) => p && typeof p.t === 'string' && Number.isFinite(minutesOf(p.t)))
    .map((p) => ({
      t: p.t,
      nav: p.nav ?? null,
      change_pct: p.change_pct ?? null,
      pnl: pnlAvailable && p.nav != null ? round2(shares * (p.nav - worth)) : null,
    }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  const hasData = points.length > 0;
  const hasMorningPoints = points.some((p) => p.t <= '11:30');
  const hasAfternoonPoints = points.some((p) => p.t >= '13:00');
  const showAfternoonPlaceholder =
    hasMorningPoints &&
    !hasAfternoonPoints &&
    typeof nowMinutes === 'number' &&
    nowMinutes >= AM_CLOSE_MIN &&
    nowMinutes < 785;

  // emptyReason：先挡加载与失败，再谈交易日（否则首屏 marketDate 未到时误报"非交易日"）
  let emptyReason = null;
  if (!hasData) {
    if (loading) emptyReason = 'loading';
    else if (error) emptyReason = 'error';
    else if (isQdii) emptyReason = 'qdii';
    else if (isTradingDay === false) emptyReason = 'not_trading_day';
    else if (typeof nowMinutes === 'number' && nowMinutes < AM_OPEN_MIN) emptyReason = 'pre_open';
    else if (!hasQuote) emptyReason = 'no_quote';
    else emptyReason = 'no_estimate';
  }

  return {
    points,
    worth,
    worthDate,
    isConfirmed,
    pnlAvailable,
    hasData,
    hasMorningPoints,
    hasAfternoonPoints,
    showAfternoonPlaceholder,
    emptyReason,
    metrics: metricsOf(points, pnlAvailable),
  };
}

/**
 * 盈亏口径禁用原因（`''` = 可用）：① 未持仓 → 换算不出金额；② 今日确认净值已发布 → `worth` 由"昨收"变"今收"，
 * `nav − worth` 只剩估算误差（曲线会塌成一条 0 附近的假线）。两条都置灰按钮并给同一句文案。
 * 与 `buildEstimateCurve` 的 `pnlAvailable` 同向（此处多一个"为什么不可用"的可读原因）。
 */
export function pnlBlockReason({ shares = null, worthDate = null, marketDate = null } = {}) {
  if (!(shares > 0)) return '未持仓，无法计算金额';
  return worthDate && marketDate && worthDate === marketDate
    ? '今日净值已确认，盘中估算盈亏已失效'
    : '';
}

/** 空态文案（集中一处，避免 app.js 各写一份） */ export const EMPTY_REASON_TEXT = {
  loading: '正在加载走势…',
  error: '走势加载失败——可点「刷新」重试',
  qdii: '该基金暂无盘中估值走势（QDII 不使用估值源）',
  not_trading_day: '今天不是交易日，没有当日走势',
  pre_open: '今日尚未开盘（09:30 开盘后走势会自动出现）',
  no_quote: '尚未拉到行情，暂时画不出走势——可点「刷新」或等下一轮轮询',
  no_estimate: '该基金今日暂无盘中估值曲线',
};

/**
 * 连续有效段（该口径下）：同一半场内相邻点间隔 > 5 分钟（断流）→ 断笔；
 * 跨午休不断笔：上午末点与下午首点
 * 在接缝处同 x（GAP=0），连接段是一条竖直线段，不占用横向时间轴、不伪造任何插值斜率，
 * 只是把"上午收在这里、下午从这里继续"如实连起来（与常见 A 股分时图一致）。
 */
function segmentsOf(view, metric, width) {
  const segs = [];
  let cur = [];
  let prevMin = null;
  for (const p of view.points) {
    const v = curveValueOf(p, metric);
    if (v == null) {
      if (cur.length) segs.push(cur);
      cur = [];
      prevMin = null;
      continue;
    }
    const min = minutesOf(p.t);
    const crossesLunch = prevMin != null && prevMin <= AM_CLOSE_MIN && min >= PM_OPEN_MIN;
    const broke = !crossesLunch && prevMin != null && min - prevMin > GAP_BREAK_MIN;
    if (broke && cur.length) {
      segs.push(cur);
      cur = [];
    }
    cur.push([timeToX(p.t, width), valToY(v, view.metrics[metric])]);
    prevMin = min;
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * 纯函数，输出SVG字符串。
 * width <= 0（首屏未挂载）或 !hasData 返回空串，交由调用方渲染占位。
 * 绘制顺序：0基线(盈亏基准) → 半场分隔线 → 上下刻度 → 折线（单path多子路径，单点补笔）
 * → 末点圆点+数值 → X轴四标签（11:30右对齐 /13:00左对齐防文字重叠）→ 午后占位文案。
 */
export function estimateCurveSvg(view, { metric = 'pct', width = 0 } = {}) {
  if (!view || !view.hasData || !(width > 0)) return '';
  const domain = view.metrics[metric] ?? { lo: 0, hi: 1 };
  const { topY, zeroY, bottomY } = getYGridLines();
  const splitX = getSplitLineX(width);
  const rightX = width - CURVE_LAYOUT.PR;
  const stateCls = view.isConfirmed ? ' is-confirmed' : '';
  const p = [];

  if (metric !== 'nav') {
    // 0 基线只对含 0 的口径（pct/pnl 域对称，0 线恒在 zeroY）
    p.push(
      `<line class="zero" x1="${CURVE_LAYOUT.PL}" y1="${zeroY}" x2="${rightX}" y2="${zeroY}" stroke="currentColor" stroke-dasharray="4 3" stroke-width="1"/>`,
    );
    p.push(
      `<text class="ztick" x="${CURVE_LAYOUT.PL - 6}" y="${zeroY + 3.5}" text-anchor="end" font-size="10" fill="currentColor">0</text>`,
    );
  }
  p.push(
    `<line class="split" x1="${splitX.toFixed(1)}" y1="${topY}" x2="${splitX.toFixed(1)}" y2="${bottomY}" stroke="currentColor" stroke-dasharray="3 3" stroke-width="1"/>`,
  );
  const tick = (v) =>
    metric === 'pct'
      ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
      : metric === 'nav'
        ? v.toFixed(3)
        : String(Math.round(v));
  for (const [y, v] of [
    [topY, domain.hi],
    [bottomY, domain.lo],
  ]) {
    p.push(
      `<line class="grid" x1="${CURVE_LAYOUT.PL}" y1="${y}" x2="${rightX}" y2="${y}" stroke="currentColor" stroke-width="1"/>`,
    );
    p.push(
      `<text class="ytick" x="${CURVE_LAYOUT.PL - 6}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="currentColor">${esc(tick(v))}</text>`,
    );
  }

  // 折线：一个 path、多子路径；单点子路径补笔（只有 moveto 的子路径不发笔）
  const d = segmentsOf(view, metric, width)
    .map((seg) => {
      if (seg.length === 1) {
        const [x, y] = seg[0];
        return `M${x.toFixed(1)} ${y.toFixed(1)} L${(x + 0.01).toFixed(2)} ${y.toFixed(1)}`;
      }
      return seg.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    })
    .join(' ');
  if (d)
    p.push(
      `<path class="curve${stateCls}" d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
    );

  // 末点圆点 + 数值（靠右缘时翻到左侧，防超 viewBox 被裁）
  const last = view.points[view.points.length - 1];
  const lastV = curveValueOf(last, metric);
  if (lastV != null) {
    const lx = timeToX(last.t, width);
    const ly = valToY(lastV, domain);
    p.push(
      `<circle class="dot${stateCls}" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>`,
    );
    const flip = lx > CURVE_LAYOUT.PL + (rightX - CURVE_LAYOUT.PL) * 0.8;
    const signCls = metric === 'nav' ? '' : lastV > 0 ? ' up' : lastV < 0 ? ' down' : '';
    p.push(
      `<text class="last${signCls}${stateCls}" x="${(flip ? lx - 6 : lx + 6).toFixed(1)}" y="${(flip ? ly + 12 : ly - 6).toFixed(1)}" text-anchor="${flip ? 'end' : 'start'}" font-size="11" font-weight="600" fill="currentColor">${esc(fmtCurveValue(lastV, metric))}</text>`,
    );
  }

  const half = halfWidth(width);
  // GAP=0 时 11:30 与 13:00 的标签会贴成一句（"11:3013:00"）→ 各向外让 3px（XTICK_INSET），只影响标签、不动几何
  for (const [x, t, anchor] of [
    [CURVE_LAYOUT.PL, '09:30', 'start'],
    [CURVE_LAYOUT.PL + half - XTICK_INSET, '11:30', 'end'],
    [CURVE_LAYOUT.PL + half + CURVE_LAYOUT.GAP + XTICK_INSET, '13:00', 'start'],
    [rightX, '15:00', 'end'],
  ]) {
    p.push(
      `<text class="xtick" x="${x.toFixed(1)}" y="${CURVE_LAYOUT.HEIGHT - 6}" text-anchor="${anchor}" font-size="10" fill="currentColor">${t}</text>`,
    );
  }
  if (view.showAfternoonPlaceholder) {
    p.push(
      `<text class="ph" x="${(splitX + half / 2).toFixed(1)}" y="${(CURVE_LAYOUT.HEIGHT / 2).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="currentColor">午后 13:00 开市后继续</text>`,
    );
  }
  return `<svg class="curve-svg${stateCls}" viewBox="0 0 ${width} ${CURVE_LAYOUT.HEIGHT}" role="img" aria-label="当天估值走势">${p.join('')}</svg>`;
}

/**
 * 命中反查：将画布坐标反向解析为行情点位，渲染与反查必须共用同一套几何与映射规则。
 * @returns { { index: number; x: number; y: number; value: number; t: number } | null }
 * 返回点位信息对象；不满足命中条件时返回 null。
 *
 * 三道命中校验规则：
 * ① 点击落在图表左右留白区域 → 返回 null
 * ② 点击落在半场之间的12px缝隙区域 → 返回 null
 * ③ 最近数据点超出吸附半径（10px） → 返回 null
 *
 * 兜底：无数据或最近点位无有效值时返回 null，避免 valToY(null) 产生 NaN，造成 tooltip 样式 top: NaNpx。
 */
export function estimateCurveHitAt(view, offsetX, width, metric = 'pct') {
  if (!view || !view.hasData || !(width > 0) || !Number.isFinite(offsetX)) return null;
  if (offsetX < CURVE_LAYOUT.PL || offsetX > width - CURVE_LAYOUT.PR) return null;
  // 中缝不设死区（GAP = 0，两半场挨着）：在分隔线处按最近点取值（11:30 与 13:00 同位，取先出现的 11:30）
  let best = -1;
  let bd = Infinity;
  view.points.forEach((p, i) => {
    if (curveValueOf(p, metric) == null) return;
    const dist = Math.abs(timeToX(p.t, width) - offsetX);
    if (dist < bd) {
      bd = dist;
      best = i;
    }
  });
  if (best < 0 || bd > HIT_RADIUS) return null;
  const point = view.points[best];
  const value = curveValueOf(point, metric);
  return {
    index: best,
    x: timeToX(point.t, width),
    y: valToY(value, view.metrics[metric]),
    value,
    t: point.t,
  };
}
