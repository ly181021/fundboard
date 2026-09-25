/**
 * 数据健康细条渲染器。
 * 纯函数：接收数据，返回 HTML 字符串，支持 Node 单测，遵循与 badgeRenderer 相同约定，不依赖 Node 全局。
 *
 * 状态判定：服务端只上报各源最后成功/失败时间；ok/fail/idle 在客户端基于时间戳归一化对比。
 * 时间戳统一使用 Date.getTime()，禁止字符串、null 直接算术比较，防止出现 NaN，判断恒 false。
 *
 * 备源 tooltip 双保险：isOk 守卫 + 毫秒容差；fail 态只展示错误摘要，不追加备源提示。文案按源区分（lsjz→蛋卷备源），无登记备源则不展示。
 *
 * 覆盖式降级：主源失败但备源可用（push2 → 新浪备源），源标记 ✗，tooltip 标注「已切…数据正常」，不展示红条；避免误报“盯盘数字可能过期”。
 *
 * 所有状态（错误/空态在内）都输出 .health 容器，保证 DOM 结构与高度稳定。
 *
 * 指数主源重试按钮：仅 push2 失败时渲染「↻ 重试指数源」。存在红条则嵌入红条，否则放在细条右侧；重试中按钮禁用并显示“重试中…”，结果通过 flash 行内提示。
 * 点击交给 app.js `[data-idx-retry]` 事件委托，组件零副作用。
 *
 * 样式 class：.health/.pill/.ok/.fail/.health-banner，颜色由 css/style.css 令牌管理，暗色自动适配。
 */

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** 健康细条的四源展示顺序与标签。
 *  标签用「指数行情」而非「行情 push2」：push2 只服务大盘指数，基金的
 *  最新行情/历史净值走的是 `lsjz`（备源蛋卷）——叫"行情"容易被读成"基金行情源"。 */
const SRC_ORDER = [
  ['push2', '指数行情'],
  ['estimate', '盘中估值'],
  ['sina', '新浪备源'],
  ['lsjz', '历史净值'],
];

/** 各源备源名称（tooltip 用）：只登记确实存在备源的源，未登记的不展示备源提示（防口径错配）。
 *  注：指数走备源改记 'sina' 键后，push2 不再上报 fallback，故此处已无 push2 条目。 */
const FALLBACK_LABEL = { lsjz: '蛋卷备源' };

/** 主源 → 备源键：失败源若其备源当前可用，视为"已覆盖"，不触发"数字可能过期"告警 */
const BACKUP_OF = { push2: 'sina' };
const LABEL_OF = Object.fromEntries(SRC_ORDER);

const parseTime = (iso) => {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0; // Date 解析失败兜底
};

// 时间一律按北京墙钟（UTC+8）渲染：服务端给的是绝对 ISO，
// 不能用 getHours()/toLocaleTimeString()：那会跟随浏览器所在时区，非 +08:00 的环境下时间就偏了。
// 与全站口径同源（js/marketClock.formatIndexTime / beijingToday 同一套 +8 平移 + UTC getter）。
const BJ_OFFSET_MS = 8 * 3600 * 1000;
const bjOf = (iso) => new Date(new Date(iso).getTime() + BJ_OFFSET_MS);
const pad2 = (n) => String(n).padStart(2, '0');

/** ISO → 北京 HH:MM（pill 上的短时间；非法值返回 —） */
const timeShort = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const b = bjOf(iso);
  return `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
};

/** ISO → 北京 `MM-DD HH:mm（北京）`（tooltip 用：带日期与来源标注——原始 ISO 是带 Z 的 UTC 时间，读起来要换算） */
const stampShort = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const b = bjOf(iso);
  return `${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())} ${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}（北京）`;
};

/** 失败源是否被"当前可用的备源"覆盖：返回提示语或 null。
 *  指数主源 push2 被封时新浪备源仍在供数——数据没断，不该报"盯盘数字可能过期"。 */
function coveredNote(key, sources) {
  const bk = BACKUP_OF[key];
  if (!bk) return null;
  const b = sources?.[bk];
  if (!b) return null;
  const ok = (b.lastOkAt || b.lastErrAt) && parseTime(b.lastOkAt) >= parseTime(b.lastErrAt);
  return ok ? `已切${LABEL_OF[bk] || bk}，数据正常` : null;
}

/**
 * @param {object|null} sources /api/source-health 的 sources 对象
 * @param {string} ts 接口 ts（右端"最后更新"）
 * @param {{pos?: number, len?: number}} orderCtx 首页排序上下文：pos 非 number 时两键均不生效
 * @param {{retrying?: boolean, flash?: {cls: string, text: string}|null}} [ui] 交互态：
 *   retrying = 重试指数主源进行中；flash = 重试结果的内联提示（``cls`` 取 'ok' | 'warn'）
 */
export function healthStripHtml(sources, ts, orderCtx = {}, ui = {}) {
  const pos = orderCtx.pos;
  const len = orderCtx.len ?? 3;
  const upDisabled = typeof pos === 'number' && pos <= 0;
  const downDisabled = typeof pos === 'number' && pos >= len - 1;
  const handles = `<span class="handles" data-blk="health"><span class="drag" draggable="true" title="拖拽排序（触屏点 ↑↓）">⋮⋮</span><button type="button" class="mv-btn" data-move="-1" title="上移"${upDisabled ? ' disabled' : ''}>↑</button><button type="button" class="mv-btn" data-move="1" title="下移"${downDisabled ? ' disabled' : ''}>↓</button></span>`;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    return `<div class="health"><span class="h-lbl">数据源</span><span class="t" style="flex:1">健康信息暂不可用</span>${handles}</div>`;
  }
  const pills = [];
  const failed = [];
  let push2Fail = false; // 指数主源是否处于失败态（决定是否给"重试指数源"按钮）
  for (const [key, label] of SRC_ORDER) {
    const s = sources[key] || {};
    const okTime = parseTime(s.lastOkAt);
    const errTime = parseTime(s.lastErrAt);
    const isIdle = !s.lastOkAt && !s.lastErrAt; // 从未被调用
    const isOk = !isIdle && okTime >= errTime; // 含 lastErrAt=null（errTime=0）
    const isFail = !isIdle && errTime > okTime;
    const msg = String(s.lastErrMsg ?? '').slice(0, 60); // 防御性截断（服务端已 60 字，同口径）
    const isFallback =
      isOk &&
      !!s.fallbackUsedAt &&
      okTime > 0 &&
      Math.abs(parseTime(s.fallbackUsedAt) - okTime) < 1000; // 毫秒容差（单次 record 内两时间戳同值）
    let cls = '';
    let txt = '';
    let tip = '';
    if (isIdle) {
      txt = '等待首次拉取';
    } else if (isOk) {
      cls = 'ok';
      txt = `✓ ${timeShort(s.lastOkAt)}`;
      const parts = [];
      if (s.lastErrAt) parts.push(`最近错误：${msg || '—'}`);
      if (isFallback && FALLBACK_LABEL[key]) parts.push(`上次经${FALLBACK_LABEL[key]}`);
      if (parts.length)
        tip = ` title="最后成功 ${esc(stampShort(s.lastOkAt))} ｜ ${esc(parts.join(' ｜ '))}"`;
    } else if (isFail) {
      cls = 'fail';
      txt = `✗ ${timeShort(s.lastErrAt)} 失败`;
      const cov = coveredNote(key, sources); // 备源当前可用 → 数据没断
      tip = ` title="最后成功 ${s.lastOkAt ? esc(stampShort(s.lastOkAt)) : '—'} ｜ 最近错误：${esc(msg || '未知')}${cov ? ` ｜ ${esc(cov)}` : ''}"`;
      if (key === 'push2') push2Fail = true;
      if (!cov) failed.push(label); // 已覆盖的不算"异常"，不触发红条
    }
    pills.push(
      `<span class="pill ${cls}"${tip}><i></i>${label}<span class="t">${esc(txt)}</span></span>`,
    );
  }
  // 指数主源重试按钮：只在 push2 失败时出现；有红条时进红条，否则放细条右侧
  const retryBtn = `<button type="button" class="retry-btn" data-idx-retry title="重新探测指数主源（东财 push2）——换网络后用它立即重试，不必重启服务"${ui.retrying ? ' disabled' : ''}>${ui.retrying ? '重试中…' : '↻ 重试指数源'}</button>`;
  const bannerShown = failed.length > 0;
  const banner = bannerShown
    ? `<div class="health-banner"><span class="hb-text">数据源异常：${esc(failed.join('、'))} 最近一次拉取失败——盯盘数字可能过期（悬停红点看详情）</span>${push2Fail ? retryBtn : ''}</div>`
    : '';
  const stripBtn = push2Fail && !bannerShown ? retryBtn : '';
  // "最后更新"：有按钮时由按钮吃 margin-left:auto（两个 auto 会把中间空隙劈成两半）
  const tail = stripBtn
    ? `${stripBtn}<span class="t">最后更新 ${esc(timeShort(ts))}</span>`
    : `<span class="t" style="margin-left:auto">最后更新 ${esc(timeShort(ts))}</span>`;
  const flash = ui.flash
    ? `<div class="flash ${ui.flash.cls === 'ok' ? 'ok' : 'warn'}">${esc(ui.flash.text)}</div>`
    : '';
  return `<div class="health"><span class="h-lbl">数据源</span>${pills.join('')}${tail}${handles}</div>${banner}${flash}`;
}
