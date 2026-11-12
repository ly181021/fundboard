/**
 * 黄金区块 · 金价卡渲染器（纯函数，返回 HTML 字符串，支持 Node 单测）。
 * 卡片与网格复用核心指数监控的视觉形态（同令牌、同胶囊、同断点）：首卡上金所 Au99.99（元/克）、
 * 次卡国际金价（伦敦金现 XAU/USD，美元/盎司）；二期银行积存金金额卡将按需加入同一网格，
 * 网格列数随卡数自适应撑满（is-2/is-3/is-4）。
 *
 * sge / intl: 源侧行情（{price, change_pct, change_amt, time(Unix 秒), degraded?}）或 null（未取到，骨架屏态）；
 *       degraded=true 为降级态（主备源均失败，前端保留最近成功值照常展示并加黄条提示）。
 * phase: 'open' | 'lunch' | 'closed'（marketClock.sgePhase），null 视为行情获取中；
 *       intlPhase: 'open' | 'closed'（marketClock.comexGoldPhase，近连续交易无午休）。
 * 折叠与排序手柄均与 indexMonitorCard 同款：输出 HTML 不随展开状态变化（收起/展开双文案 span
 * ＋外层 .is-collapsed 由 CSS 切换），折叠交互与持久化由 app.js 的 Vue 层接管。
 */
import { formatIndexTime } from '../marketClock.js';

const CARD_DEFS = [
  { key: 'sge', name: '上金所 Au99.99', unit: '元/克' },
  { key: 'intl', name: '国际金价', unit: '美元/盎司' },
];

/** 阶段 → 状态文案：午间休市不是收盘；null（未取到时段）单列"行情获取中" */
const phaseTextOf = (phase) =>
  phase === 'open'
    ? '开盘中'
    : phase === 'lunch'
      ? '午间休市'
      : phase === 'closed'
        ? '已收盘'
        : '行情获取中';

/** 卡内状态点（开市亮绿，title 为状态文案） */
const dotOf = (phase) =>
  `<i class="idxm-dot ${phase === 'open' ? 'open' : ''}" title="${phaseTextOf(phase)}"></i>`;

/** 带符号定长数字：正数补 +，负数与零原样（与指数胶囊同形态） */
const fmtSigned = (n, digits) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/** 涨跌胶囊：方向类（涨 up / 跌 dn / 平 none）与文案；涨跌额缺失只显示涨跌幅，两者皆缺显示 "—" */
function pillOf(item) {
  const amt = Number.isFinite(item.change_amt) ? item.change_amt : null;
  const pct = Number.isFinite(item.change_pct) ? item.change_pct : null;
  // 方向取首个非零值：涨跌额为 0 而涨跌幅非 0 时以涨跌幅定向，防箭头与百分比矛盾
  const dir = amt != null && amt !== 0 ? amt : pct != null && pct !== 0 ? pct : (amt ?? pct);
  const cls = dir == null || dir === 0 ? 'none' : dir > 0 ? 'up' : 'dn';
  const arrow = cls === 'up' ? '▲' : cls === 'dn' ? '▼' : '—';
  const parts = [];
  if (amt != null) parts.push(fmtSigned(Math.round(amt * 100) / 100, 2));
  if (pct != null) parts.push(`${fmtSigned(Math.round(pct * 100) / 100, 2)}%`);
  return { cls, text: parts.length > 0 ? `${arrow} ${parts.join(' · ')}` : '—' };
}

/**
 * 源侧金价 → 卡面视图项（价格两位小数、涨跌胶囊、时间戳格式化）。
 * @param {object} item 源侧行情（{price, change_pct, change_amt, time}）
 * @param {Date} now 当前时刻（时间戳跨日判定用，注入保纯函数）
 * @returns {{priceText: string, pillCls: string, pillText: string, timeText: string}} 视图项
 */
export function goldCardOf(item, now = new Date()) {
  const pill = pillOf(item);
  return {
    priceText: Number.isFinite(item.price) ? item.price.toFixed(2) : '--',
    pillCls: pill.cls,
    pillText: pill.text,
    timeText: formatIndexTime(item.time, now),
  };
}

/** 行情卡（正常/降级共用骨架：降级时底部加黄条，数值照常展示最近成功价） */
function valueCard(def, item, { phase, now }) {
  const { priceText, pillCls, pillText, timeText } = goldCardOf(item, now);
  const lastAt = timeText ? ` · 最近成功价 ${timeText}` : ''; // 时间戳缺值时不留空位
  const foot =
    item.degraded === true
      ? `<div class="goldm-degraded">行情源暂不可用${lastAt}，恢复后自动刷新</div>`
      : '';
  return `<div class="goldm-card">
      <div class="goldm-card-top">
        <span class="goldm-name">${def.name}${dotOf(phase)}</span>
        <span class="goldm-time">${timeText}</span>
      </div>
      <div class="goldm-main">
        <span class="goldm-price">${priceText}<span class="unit">${def.unit}</span></span>
        <span class="idxm-pill ${pillCls}">${pillText}</span>
      </div>
      ${foot}
    </div>`;
}

/** 加载卡：骨架屏占位（首屏 / 刷新中），高度与行情卡一致避免数据到达时跳动 */
function loadingCard(def) {
  return `<div class="goldm-card">
      <div class="goldm-card-top">
        <span class="goldm-name">${def.name}<i class="idxm-dot"></i></span>
        <span class="goldm-time">--:--</span>
      </div>
      <div class="goldm-main"><span class="sk sk-price"></span><span class="sk sk-pill"></span></div>
    </div>`;
}

/**
 * 黄金区块 HTML（头部状态条＋收起按钮＋卡片网格：上金所卡 + 国际金价卡）。
 * 国际金价未上线数据时（intl=null 且从未取到）渲染骨架卡占位，网格卡位恒定；
 * 列数类 is-2/is-3/is-4 随渲染卡数写入，网格自适应撑满整行。
 * @param {object|null} sge 上金所源侧行情或 null（加载态）
 * @param {object} [opts] { intl, phase, intlPhase, now, orderCtx }
 * @param {object|null} [opts.intl] 国际金价源侧行情或 null
 * @param {string} [opts.phase] 上金所阶段（'open'|'lunch'|'closed'|null）
 * @param {string} [opts.intlPhase] 国际金价阶段（'open'|'closed'|null）
 * @param {Date} [opts.now] 当前时刻（时间戳格式化用）
 * @param {object} [opts.orderCtx] 区块排序上下文 { pos, len }（pos 非 number 时两键均不禁用）
 * @returns {string} 区块 HTML 字符串
 */
export function goldBlockHtml(
  sge,
  { intl = null, phase = null, intlPhase = null, now = new Date(), orderCtx = {} } = {},
) {
  const [sgeDef, intlDef] = CARD_DEFS;
  const statusItem = (label, isOpen, phaseVal) =>
    `<span><i class="idxm-dot ${isOpen ? 'open' : ''}"></i>${label} ${phaseTextOf(phaseVal)}</span>`;
  const statusHtml =
    statusItem('上金所', phase === 'open', phase) +
    statusItem('国际金价', intlPhase === 'open', intlPhase);
  const btn = `<span class="goldm-btn">
      <span class="t-open">收起</span><span class="t-closed">展开</span><span class="goldm-chev">▲</span>
    </span>`;
  const pos = orderCtx.pos;
  const len = orderCtx.len ?? 2;
  const upDisabled = typeof pos === 'number' && pos <= 0;
  const downDisabled = typeof pos === 'number' && pos >= len - 1;
  const upAttr = upDisabled ? ' disabled' : '';
  const downAttr = downDisabled ? ' disabled' : '';
  const handles = `<span class="handles" data-blk="gold">
      <span class="drag" draggable="true" title="拖拽排序（触屏点 ↑↓）">⋮⋮</span>
      <button type="button" class="mv-btn" data-move="-1" title="上移"${upAttr}>↑</button>
      <button type="button" class="mv-btn" data-move="1" title="下移"${downAttr}>↓</button>
    </span>`;
  const sgeCard = sge == null ? loadingCard(sgeDef) : valueCard(sgeDef, sge, { phase, now });
  const intlCard =
    intl == null ? loadingCard(intlDef) : valueCard(intlDef, intl, { phase: intlPhase, now });
  const count = 2; // 当前恒两张行情卡；二期银行卡入格后按实际卡数写 is-N
  return `<div class="goldm">
      <div class="goldm-head">
        <span class="goldm-title">黄金</span><span class="goldm-status">${statusHtml}</span>${btn}${handles}
      </div>
      <div class="goldm-body"><div class="goldm-clip">
        <div class="goldm-grid is-${count}">${sgeCard}${intlCard}</div>
      </div></div>
    </div>`;
}
