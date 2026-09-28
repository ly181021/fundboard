/**
 * 核心指数监控 · 可折叠父卡片渲染器（市场状态增强）。
 *
 * 组件约定：纯函数，入参为数据，返回 HTML 字符串，支持 Node 单测。
 * 折叠交互、持久化 onToggle 由 app.js 的 Vue 层接管。
 * 输出 HTML 不随展开状态变化：收起/展开双文案 span + 外层 .is-collapsed 由 CSS 切换；
 * 保证切换时 v-html 字符串不变，高度过渡动画不受 DOM 重建影响。
 *
 * items: [{ code, name, priceText, chgText, chgColor, amtText, timeText, open, phase }]
 *        文字、颜色已预格式化；phase='lunch' 状态点显示「午间休市」。
 * status: [{ label, open, phase }]，取自 marketClock.marketStatusOf().items
 * sparkByCode: { [code]: { market, last_pct, spark: [[t,pct], …] | null } }
 *        当日迷你分时；key不存在为空槽位（未接线/加载中，保持版面高度不跳动）；
 *        spark: null = 暂无分时。
 */
import { indexSparkSvg } from './indexSpark.js';

/**
 * 卡面涨跌幅取值：美股休市/开盘前改显示"最近完成场次"的涨幅。
 * 背景：上游快照在美股开盘前会把报价滚到"新的、尚无成交的场次"（`涨跌幅 0.00`、而价格仍是上一场收盘），
 * 卡面读起来像"平盘"；曲线那一路的 `last_pct` 正是"最近完成场次"的涨幅，且与卡面价格同属一场（口径自洽）。
 * 盘中（`useLastSession === false`）一律照上游实时值；`lastSessionPct` 缺失时也回落到上游值（首屏/未取到曲线）。
 */
export function displayChangePct(
  snapshotPct,
  { lastSessionPct = null, useLastSession = false } = {},
) {
  return useLastSession && Number.isFinite(lastSessionPct) ? lastSessionPct : snapshotPct;
}

const arrowOf = (chgText) => {
  const t = String(chgText).trim();
  return t.startsWith('+') ? '↑' : t.startsWith('-') ? '↓' : '—';
};

/** 涨跌胶囊方向类：符号判定与 arrowOf 同源（涨 up / 跌 dn / 平 none） */
const pillClsOf = (chgText) => {
  const t = String(chgText).trim();
  return t.startsWith('+') ? 'up' : t.startsWith('-') ? 'dn' : 'none';
};

/** 涨跌胶囊文案：有涨跌额显示「▲ 涨跌额 · 涨跌幅」，额缺失（美股新浪备源）只显示「▲ 涨跌幅」 */
const pillTextOf = (it) => {
  const arrow = it.chgText.startsWith('+') ? '▲' : it.chgText.startsWith('-') ? '▼' : '—';
  const pct = String(it.chgText).trim();
  const amt = it.amtText != null ? `${String(it.amtText).trim()} · ` : '';
  return `${arrow} ${amt}${pct}`;
};

/** 市场阶段 → 状态文案：午间休市不是收盘，不能写成"已收盘"（缺 phase 时按 open 兜底） */
const phaseText = (open, phase) =>
  open || phase === 'open' ? '开盘中' : phase === 'lunch' ? '午间休市' : '已收盘';

export function indexMonitorCardHtml(items, { status = [], orderCtx = {}, sparkByCode = {} } = {}) {
  const chips = (items || [])
    .map(
      (it) => `
      <span class="idxm-chip"><span class="n">${it.name}</span><b>${it.priceText}</b><i class="chg" style="color:${it.chgColor}">${arrowOf(it.chgText)}</i></span>`,
    )
    .join('');
  const cards = (items || [])
    .map((it) => {
      // 当天迷你分时：槽位恒定占位（高 34px，由 CSS 决定）——未接线时空槽、无曲线时写"暂无分时"，
      // 两者都不改变卡片高度，避免数据到达时整块跳动。
      const sp = sparkByCode[it.code];
      const inner =
        sp === undefined
          ? ''
          : Array.isArray(sp.spark) && sp.spark.length >= 2
            ? indexSparkSvg(sp.spark, { market: sp.market, pct: sp.last_pct })
            : '<div class="idxm-spark-empty">暂无分时</div>';
      return `
      <div class="idxm-card">
        <div class="idxm-card-top"><span class="idxm-name">${it.name}<i class="idxm-dot ${it.open ? 'open' : ''}" title="${phaseText(it.open, it.phase)}"></i></span><span class="idxm-time">${it.timeText}</span></div>
        <div class="idxm-main"><span class="idxm-price">${it.priceText}</span><span class="idxm-pill ${pillClsOf(it.chgText)}">${pillTextOf(it)}</span></div>
        <div class="idxm-spark">${inner}</div>
      </div>`;
    })
    .join('');
  const statusHtml = (status || [])
    .map(
      (s) =>
        `<span><i class="idxm-dot ${s.open ? 'open' : ''}"></i>${s.label} ${phaseText(s.open, s.phase)}</span>`,
    )
    .join('');
  // 首页排序手柄：pos 非 number 时两键均不禁用；disabled 由纯函数按位置写死（v-html 内无 Vue 绑定）
  const pos = orderCtx.pos;
  const len = orderCtx.len ?? 3;
  const upDisabled = typeof pos === 'number' && pos <= 0;
  const downDisabled = typeof pos === 'number' && pos >= len - 1;
  const handles = `<span class="handles" data-blk="idx"><span class="drag" draggable="true" title="拖拽排序（触屏点 ↑↓）">⋮⋮</span><button type="button" class="mv-btn" data-move="-1" title="上移"${upDisabled ? ' disabled' : ''}>↑</button><button type="button" class="mv-btn" data-move="1" title="下移"${downDisabled ? ' disabled' : ''}>↓</button></span>`;
  return `<div class="idxm">
      <div class="idxm-head">
        <span class="idxm-title">核心指数监控</span>
        <span class="idxm-status">${statusHtml}</span>
        <span class="idxm-sum">${chips}</span>
        <span class="idxm-btn"><span class="t-open">收起</span><span class="t-closed">展开</span><span class="idxm-chev">▲</span></span>${handles}
      </div>
      <div class="idxm-body"><div class="idxm-clip"><div class="idxm-grid">${cards}</div></div></div>
    </div>`;
}
