/**
 * 策略预警徽章渲染器。
 * 纯函数模块：输入引擎原始数据，输出 HTML 字符串，不触碰 DOM，可在 Node 环境直接单测。
 *
 * 合规约束：预估金额必须附带「预估 · T+1 净值成交 · 以基金公司确认为准」；雷达图文案必须附带「不构成买卖建议」。
 */

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const pct1 = (v) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(1) + '%');
const money = (v) => '≈ ¥' + (Math.round(v * 100) / 100).toLocaleString('zh-CN');

/** 比例值 → 展示文案：0.5、1/3 特判，≥1 为全额，其余取整百分比 */
export function ratioLabel(ratio) {
  if (ratio == null) return '';
  if (ratio >= 1) return '全额';
  if (Math.abs(ratio - 0.5) < 0.01) return '1/2';
  if (Math.abs(ratio - 1 / 3) < 0.01) return '1/3';
  return `${Math.round(ratio * 100)}%`;
}

/** 引擎状态 → 徽章文案与样式类名 */
export const STATE_BADGES = {
  HOLD: { label: '持有', cls: 'hold' },
  WATCH: { label: '关注', cls: 'watch' },
  ALERT: { label: '警戒', cls: 'alert' },
  TAKE_PROFIT: { label: '止盈', cls: 'tp' },
  STOP_LOSS: { label: '止损', cls: 'sl' },
  ADD: { label: '补仓', cls: 'add' },
  EXIT: { label: '清空', cls: 'exit' },
};

/** 将引擎状态与执行信息转换为徽章副标题文案；文案映射集中在当前模块维护，其他模块不得重复实现 */
export function plainSub(entry) {
  if (entry.error) return '策略数据暂不可用';
  // addBlockReason 枚举 → 副标题文案
  const addBlockSub = {
    missing_reserve: '补仓区缺预算——先到「策略」里设置预留资金',
    cap_reached: '补仓预算已用完，规则收手',
  };
  if (entry.addBlockReason && addBlockSub[entry.addBlockReason])
    return addBlockSub[entry.addBlockReason];
  const executed = entry.executed && entry.executedInfo;
  const base =
    {
      HOLD: '一切正常，不用操作',
      WATCH: '小幅回调，先观察',
      ALERT: '跌得不轻，但先别动',
      TAKE_PROFIT: `涨多了又回落，建议落袋${ratioLabel(entry.ratio)}`,
      STOP_LOSS: `亏过头了，先卖 ${ratioLabel(entry.ratio)} 止血`,
      ADD:
        entry.addAmount != null
          ? `按计划补一小口 ¥${Math.round(entry.addAmount).toLocaleString('zh-CN')}`
          : '处于补仓观察区',
      EXIT: '亏到最大容忍度，全部退出',
    }[entry.state] || '—';
  if (executed)
    return `已执行，冷却中（第 ${entry.executedInfo.day}/${entry.executedInfo.total} 天）`;
  return base;
}

// tone 枚举 → 口径文案（当前无引用）
const toneText = {
  ok: '距触发线尚远',
  warn: '接近触发线',
  hot: '临近触发线',
  over: '已越过触发线',
};

// 雷达角标文案：优先使用引擎的 trigger 字段；旧数据无该字段时按默认阈值兜底，避免自定义阈值被误判
function radarText(r) {
  if (r.trigger === 'd5' && r.downDays >= 2) return `连跌 ${r.downDays} 日`;
  if (r.trigger === 'peak60') return `峰值回撤 ${pct1(r.peak60Drawdown)}`;
  if (r.trigger === 'd20') return `20 日跌 ${pct1(Math.abs(r.d20Drop))}`;
  if (r.trigger === 'd5') return `连跌 ${pct1(Math.abs(r.d5Drop))}`;
  if (r.peak60Drawdown != null && r.peak60Drawdown >= 0.08)
    return `峰值回撤 ${pct1(r.peak60Drawdown)}`;
  if (r.d20Drop != null && Math.abs(r.d20Drop) >= 0.1)
    return `20 日跌 ${pct1(Math.abs(r.d20Drop))}`;
  if (r.d5Drop != null) return `连跌 ${pct1(Math.abs(r.d5Drop))}`;
  return '近期下跌较急';
}

/** 持仓表预警列单元格 HTML */
export function strategyBadgeHtml(entry) {
  if (!entry || entry.error) {
    const msg = entry?.error ? esc(entry.error.slice(0, 40)) : '未评估';
    return `<div class="al"><div class="al-top"><span class="badge hold dim" title="${msg}">未评估</span></div><span class="al-sub">策略数据暂不可用</span></div>`;
  }
  const b = STATE_BADGES[entry.state] || STATE_BADGES.HOLD;
  const executed = entry.executed && entry.executedInfo;
  // 比例仅随动作态展示，EXIT 恒为「全额」
  const showRatio = ['TAKE_PROFIT', 'STOP_LOSS', 'EXIT'].includes(entry.state);
  const badgeText = executed
    ? `${b.label}锁定中 · 第 ${entry.executedInfo.day}/${entry.executedInfo.total} 天`
    : `${b.label}${showRatio ? ` <span class="ratio">${ratioLabel(entry.ratio)}</span>` : ''}`;
  const dimCls = executed ? ' dim' : '';
  const radar = entry.radar?.level
    ? `<span class="radar ${entry.radar.level}">⚠ ${esc(radarText(entry.radar))}</span>`
    : '';
  const near =
    !executed && entry.progress?.tone === 'hot' ? '<span class="near">临近触发线</span>' : '';
  const bar = entry.progress
    ? `<div class="al-bar"><i class="${entry.progress.tone}" style="width:${entry.progress.pct}%"></i></div>
       <span class="al-bar-note">${esc(entry.progress.label)}${entry.progress.tone === 'hot' ? '（临近）' : ''}</span>`
    : '';
  return `<div class="al">
      <div class="al-top"><span class="badge ${b.cls}${dimCls}" data-strategy-detail="${esc(entry.code)}" title="点击看为什么与建议">${badgeText}</span>${near}${radar}</div>
      <span class="al-sub">${esc(plainSub(entry))}</span>
      ${bar}
    </div>`;
}

/** 触发历史时间线标题，例：「9 月 4 日 · 止损提醒：亏过头了，先卖 1/3」 */
export function storyTitle(alert) {
  const d =
    String(alert.navDate || alert.ts || '')
      .slice(5, 10)
      .replace('-', ' 月 ') + ' 日';
  const head = {
    TAKE_PROFIT: '止盈提醒',
    STOP_LOSS: '止损提醒',
    EXIT: '清空提醒',
    ADD: '补仓提醒',
  };
  const tail = {
    TAKE_PROFIT: `涨多了又回落，先落袋${ratioLabel(alert.ratio)}`,
    STOP_LOSS: `亏过头了，先卖 ${ratioLabel(alert.ratio)}`,
    EXIT: '亏到最大容忍度，全部退出',
    ADD:
      alert.addAmount != null
        ? `按计划补一小口 ¥${Math.round(alert.addAmount).toLocaleString('zh-CN')}`
        : '按计划补一小口',
  };
  const h = head[alert.state];
  if (!h) return `${d} · ${alert.state}`;
  return `${d} · ${h}：${tail[alert.state] || ''}`;
}

const triggerLabel = {
  trailing: '移动止盈',
  xirrLadder: 'XIRR 年化台阶',
  stop1: '首档止损',
  stop2: '二档止损',
  exitFloor: '清空兜底线',
  trendEnd: '趋势终结（破位）',
};

/** 预警中心时间线 HTML；记录顺序由接口保证（最新在前） */
export function strategyTimelineHtml(alerts) {
  const items = (alerts || [])
    .map((a) => {
      const cls =
        { TAKE_PROFIT: 'm-tp', STOP_LOSS: 'm-sl', EXIT: 'm-exit', ADD: 'm-add' }[a.state] ||
        'm-other';
      const navDate = esc(a.navDate || '');
      const idx = [];
      if (a.nav != null) idx.push(`净值 ${a.nav}`);
      if (a.lossRate != null) idx.push(`亏损率 ${pct1(a.lossRate)}`);
      if (a.drawdown != null) idx.push(`回撤 ${pct1(a.drawdown)}`);
      if (a.profitRate != null) idx.push(`浮盈 ${pct1(a.profitRate)}`);
      if (a.trigger) idx.push(`规则：${triggerLabel[a.trigger] || a.trigger}`);
      idx.push(`使用的配置：${a.configUsed?._custom ? '含自定义参数' : '默认参数（未自定义）'}`);
      return `<div class="item ${cls}">
        <div class="head"><b>${esc(storyTitle(a))}</b><span class="t">净值日 ${navDate}</span></div>
        <div class="story">${esc(a.reasonText || '')}</div>
        <div class="snap">当时快照：${idx.map(esc).join(' ｜ ')}</div>
      </div>`;
    })
    .join('');
  return `<div class="tl">${items || '<div class="tl-empty">还没有触发记录——策略触发时会在这里留痕，可回看"当时为什么喊你操作"。</div>'}</div>`;
}

/**
 * 策略详情卡 HTML 渲染，由 app.js 绑定徽章点击唤起。
 *
 * 数据来源：/api/strategy/status。引擎字段缺失时按缺省分支降级，不自行臆造或重算数据口径。
 * 契约：返回结构与 DOM 钩子（data-strategy-*）保持不变。
 *
 * @returns {object}
 * @property {string} html - 详情卡 HTML 字符串
 * @property {string|null} ackState - 非空时由 app.js 绑定「已执行」按钮
 * @property {string|null} ackNavDate
 */

/** 进度轴映射：cur/line ≤ 1 映射到 0~70%，越界部分映射到 70~100%（对应 line × 1.3 上限）；不使用被钳位的 progress.pct */
function sdGauge(entry) {
  const p = entry.progress;
  if (!p || p.cur == null || p.line == null || !(p.line > 0)) return '';
  const ratio = p.cur / p.line;
  // 越界区右端对应 line × 1.3
  const pos = ratio <= 1 ? ratio * 70 : 70 + Math.min((ratio - 1) / 0.3, 1) * 30;
  const over = ratio > 1;
  // 游标过近两端时气泡贴边，避免溢出容器
  const edge = pos <= 18 ? ' edge-start' : pos >= 82 ? ' edge-end' : '';
  const curTxt = (p.cur * 100).toFixed(1);
  const lineTxt = (p.line * 100).toFixed(1);
  const gap = Math.abs(p.cur - p.line) * 100;
  const headTxt = over
    ? `已越过 ${gap.toFixed(1)} 个百分点（阈值的 ${ratio.toFixed(2)} 倍）`
    : `距触发线还差 ${gap.toFixed(1)} 个百分点`;
  const axisKind =
    entry.state === 'TAKE_PROFIT' && entry.trigger === 'trailing' ? 'drawdown' : 'loss';
  const sign = axisKind === 'drawdown' ? '' : '−';
  const curKind = axisKind === 'drawdown' ? '回撤' : '亏损';
  return `<div class="sd-gauge" data-over="${over ? 1 : 0}" role="img" aria-label="${esc(headTxt)}">
    <div class="sd-gauge-head"><span>${esc(headTxt)}</span></div>
    <div class="sd-gauge-track">
      <div class="sd-gauge-fill" style="width:${Math.min(pos, 100).toFixed(1)}%"></div>
      <span class="sd-gauge-overrun"></span>
      <span class="sd-gauge-mark"></span>
      <div class="sd-gauge-callout${edge}" style="left:${pos.toFixed(1)}%">当前 ${curKind} ${curTxt}%</div>
      <div class="sd-gauge-cursor" style="left:${pos.toFixed(1)}%"></div>
    </div>
    <div class="sd-gauge-scale"><span class="s0">0%</span><span style="left:70%">阈值 ${sign}${lineTxt}%</span><span class="sEnd">越界 +30%</span></div>
  </div>`;
}

/** 详情卡头部渲染 */
function sdHead(entry) {
  const navTxt = entry.nav != null ? Number(entry.nav).toFixed(4) : '—';
  const radar = entry.radar?.level
    ? `<span class="sd-radar ${entry.radar.level}" title="连跌雷达（${entry.radar.level === 'orange' ? '橙色' : '黄色'}）：不改变主状态，只作角标提示；不构成买卖建议">⚠ ${esc(radarText(entry.radar))}</span>`
    : '';
  const lag = entry.navLag
    ? '<span class="sd-lag" title="净值更新滞后：当日/昨日按该基金自己的净值日口径">QDII 净值滞后</span>'
    : '';
  const b = STATE_BADGES[entry.state] || STATE_BADGES.HOLD;
  // 状态与比例置于 sd-pill；冷却进度由 sdSteps 表达，已执行态不改写该处文案
  const ratioPart =
    ['TAKE_PROFIT', 'STOP_LOSS', 'EXIT'].includes(entry.state) && entry.ratio != null
      ? ` · ${ratioLabel(entry.ratio)}`
      : '';
  return `<div class="sd-head">
    <div class="sd-id">
      <div class="sd-name"><b>${esc(entry.name || entry.code)}</b>${radar}${lag}</div>
      <div class="sd-meta"><span class="mono">${esc(entry.code)}</span><span class="sep">/</span><span>最新净值 <b>${esc(navTxt)}</b></span><span class="sep">/</span><span>数据时点 ${esc(entry.navDate || '—')}</span></div>
    </div>
    <div class="sd-side"><span class="sd-pill${['WATCH', 'ALERT'].includes(entry.state) ? ' soft' : ''}">${esc(b.label + ratioPart)}</span><button type="button" class="sd-close" data-sd-close="1" aria-label="关闭">✕</button></div>
  </div>`;
}

/** 估算口径角标：说明文字置于 data-tip，hover 或聚焦时显示 */
const EST_TIP =
  '<span class="sd-tip" tabindex="0" data-tip="到手金额为估算：实际按 T+1 日净值成交，以基金公司确认为准（也可能高于或低于此数）。非官方数据，仅供参考。">⚠</span>';

/** 交易备忘文本；写剪贴板由 app.js 事件委托完成。无可复制内容时返回 null */
function sdMemoText(entry) {
  if (entry.state === 'ADD')
    return `${entry.name || entry.code} 买入 ¥${entry.addAmount != null ? Math.round(entry.addAmount) : '—'}`;
  if (entry.state === 'EXIT' || entry.fullRedemption)
    return `${entry.name || entry.code} 赎回全部 ${entry.shares != null ? Math.round(entry.shares * 100) / 100 : '—'} 份`;
  if (entry.shares != null && entry.ratio != null)
    return `${entry.name || entry.code} 赎回 ${Math.round(entry.shares * entry.ratio * 100) / 100} 份`;
  return null;
}

/** 冷却步进器；计数单位为净值日（非自然日），由 executedInfo 提供 */
function sdSteps(info, total5) {
  const total = info.total || 5;
  const day = Math.min(info.day, total);
  const cells = Array.from(
    { length: total },
    (_, i) => `<i class="${i < day ? 'done' : ''}${i === day - 1 ? ' now' : ''}"></i>`,
  ).join('');
  return `<div class="sd-steps">
    <div class="sd-steps-bar">${cells}</div>
    <div class="sd-steps-note">第 ${info.day} / ${total} 个净值日${info.auto ? ' · 系统已自动识别你的卖出交易' : ' · 手动确认'}（净值日非自然日）</div>
  </div>`;
}

export function strategyDetailHtml(entry) {
  if (!entry || entry.error)
    return {
      html: '<div class="empty-hint">策略数据暂不可用</div>',
      ackState: null,
      ackNavDate: null,
    };
  const navTxt = entry.nav != null ? esc(Number(entry.nav).toFixed(4)) : '—';
  const dateTxt = esc(entry.navDate || '—');
  const sharesFmt =
    entry.shares != null ? (Math.round(entry.shares * 100) / 100).toLocaleString('zh-CN') : '—';
  let title = '';
  const what = [];
  const dos = [];
  const est = [];
  const why = [];
  let ackState = null;
  let ackNavDate = entry.navDate || null;
  const cfgTxt = entry.customParams ? '你自定义过的参数' : '默认参数';
  const ACTION_STATES = ['TAKE_PROFIT', 'STOP_LOSS', 'EXIT', 'ADD'];

  if (entry.state === 'TAKE_PROFIT' && entry.trigger === 'trailing') {
    title = '涨多了又回落，规则建议先卖一半落袋';
    what.push(
      `净值 <b>${navTxt}</b>（${dateTxt}），自峰值回撤 <b>${pct1(entry.drawdown)}</b>，越过落袋线。`,
    );
    dos.push(`建议<b>赎回${ratioLabel(entry.ratio)}份额</b>；剩余继续持有，创新高后规则重新跟踪。`);
    if (entry.shares != null && entry.ratio != null && entry.nav != null) {
      est.push([
        '拟赎回份额',
        `${(Math.round(entry.shares * entry.ratio * 100) / 100).toLocaleString('zh-CN')} 份（持有 ${sharesFmt} 的 ${ratioLabel(entry.ratio)}）`,
      ]);
      est.push([
        `预估到手 ${EST_TIP}`,
        money(entry.shares * entry.ratio * entry.nav) + '（按净值 ' + navTxt + '）',
      ]);
    }
    why.push(
      '移动止盈的目的不是卖在最高点，而是涨起来之后<b>守住大部分利润</b>：跌回去之前先拿走一部分，剩下的继续跟。',
    );
    ackState = 'TAKE_PROFIT';
  } else if (entry.state === 'TAKE_PROFIT') {
    title = '年化收益到了预设台阶，规则建议分批落袋';
    what.push(`年化收益（XIRR）达 <b>${pct1(entry.xirr)}</b>，触发落袋台阶。`);
    dos.push(`建议<b>赎回${ratioLabel(entry.ratio)}份额</b>；该台阶触发后即消耗，不重复提示。`);
    if (entry.shares != null && entry.ratio != null && entry.nav != null) {
      est.push([
        '拟赎回份额',
        `${(Math.round(entry.shares * entry.ratio * 100) / 100).toLocaleString('zh-CN')} 份`,
      ]);
      est.push([`预估到手 ${EST_TIP}`, money(entry.shares * entry.ratio * entry.nav)]);
    }
    why.push(
      '年化台阶把"赚够了没有"量化成可执行的线：<b>15%/20% 台阶来自长期市场平均收益的量级</b>——超过它落袋一部分，防止坐过山车。',
    );
    ackState = 'TAKE_PROFIT';
  } else if (entry.state === 'STOP_LOSS') {
    title = '亏损越过了止损线，规则建议分批撤';
    what.push(`亏损 <b>${pct1(entry.lossRate)}</b>（市值＋分红−本金口径），越过首档止损线。`);
    dos.push(`建议<b>先赎回${ratioLabel(entry.ratio)}</b>；续跌破下一档再卖一批，反弹回本则不动。`);
    if (entry.shares != null && entry.ratio != null && entry.nav != null) {
      est.push([
        '拟赎回份额',
        `${(Math.round(entry.shares * entry.ratio * 100) / 100).toLocaleString('zh-CN')} 份`,
      ]);
      est.push([`预估到手 ${EST_TIP}`, money(entry.shares * entry.ratio * entry.nav)]);
    }
    why.push(
      '止损分批走：<b>机构到线是一次全砍，个人拆成两步</b>——先控制伤害，再给反弹留余地。止盈和止损天然互斥，不会同时出现。',
    );
    ackState = 'STOP_LOSS';
  } else if (entry.state === 'EXIT') {
    title = '亏幅达到这套策略的最大容忍度，建议全部退出';
    what.push(`亏损 <b>${pct1(entry.lossRate)}</b>，触发清空条件。`);
    dos.push('建议<b>清空全部剩余份额</b>，取回剩余本金。');
    if (entry.shares != null && entry.nav != null) {
      est.push(['全部剩余份额', `${sharesFmt} 份`]);
      est.push([`预估到手 ${EST_TIP}`, money(entry.shares * entry.nav)]);
    }
    why.push(
      '-30% 需要涨约 43% 才能回本。这条线的意义是<b>宁可在此认错离场，不让小亏拖成无法翻身的深亏</b>——保住剩余本金，才有下一次机会。',
    );
    ackState = 'EXIT';
  } else if (entry.state === 'ADD') {
    title = '跌到了补仓观察区，按计划可以补一小口';
    what.push(`亏损 <b>${pct1(entry.lossRate)}</b>，处于补仓区。`);
    dos.push(
      `建议动用预算 <b>¥${entry.addAmount != null ? Math.round(entry.addAmount).toLocaleString('zh-CN') : '—'}</b>；到上限自动收手。`,
    );
    est.push([
      `本次建议金额 ${EST_TIP}`,
      entry.addAmount != null ? '¥' + Math.round(entry.addAmount).toLocaleString('zh-CN') : '—',
    ]);
    why.push(
      '补仓摊低成本的同时也<b>放大了亏损敞口</b>——若继续跌到止损线，亏的是更大一笔钱。规则不回避坏消息，先看账再掏钱。加仓默认关闭，是唯一让你掏钱的建议。',
    );
    ackState = 'ADD';
  } else if (entry.state === 'ALERT') {
    title = '跌得不轻，但这段走势规则也看不准';
    what.push(`亏损 <b>${pct1(entry.lossRate)}</b>，处于<b>观望带</b>（补仓区与止损线之间）。`);
    dos.push('<b>只提醒，不建议动作</b>；跌到止损线会明确提醒。');
    why.push('观望带是系统明说"这段我也看不清"：补仓和止损之间留一段缓冲，防止震荡市里来回打脸。');
  } else if (entry.state === 'WATCH') {
    // 缺预算/达上限时引擎不产出 ADD 建议（状态恒为 WATCH）
    if (entry.addBlockReason === 'missing_reserve') {
      title = '跌到补仓观察区，但还没设置预算';
      what.push(`亏损 <b>${pct1(entry.lossRate)}</b>，已进补仓区。`);
      dos.push('加仓已开启但<b>未设预留资金</b>——到「策略」设置预算后才会触发。');
      why.push('补仓摊低成本的同时也放大了亏损敞口——先把预算定好，规则才敢开口。');
    } else if (entry.addBlockReason === 'cap_reached') {
      title = '补仓预算已用完，规则收手';
      what.push(`亏损 <b>${pct1(entry.lossRate)}</b>，仍在补仓区。`);
      dos.push('累计加仓<b>已达预算上限</b>，规则收手，只提示不再建议。');
      why.push('补仓摊低成本的同时也放大了亏损敞口——到顶即止，弹药留给更有把握的时候。');
    } else {
      title = '小幅回调中，先观察不用操作';
      what.push(`回落 <b>${pct1(entry.lossRate)}</b>，处于浅跌观察区。`);
      dos.push('<b>不用操作</b>；开了补仓会按计划提示"补一小口"。');
      why.push('浅跌是市场日常波动，系统保持安静——<b>安静本身就是信息</b>。');
    }
  } else {
    title = entry.executed ? '动作冷却中' : '一切正常，不用操作';
    what.push(
      entry.progress ? esc(entry.progress.label) : `最近确认净值 ${navTxt}（${dateTxt}）。`,
    );
    dos.push('<b>不用操作</b>。');
    why.push('系统保持安静——安静本身就是信息。触发条件满足时会主动提醒你。');
  }

  // 人工纠偏区：已消耗台阶与 reserveUsed 校正
  const moneyNum = (v) => (v == null || !Number.isFinite(v) ? 0 : Math.round(v * 100) / 100);
  const tiers = Array.isArray(entry.consumedTiers) ? entry.consumedTiers : [];
  const tierRow = tiers.length
    ? `<div class="corr-row"><span class="l">已消耗台阶</span>${tiers.map((t) => `<span class="chip">${esc(Math.round(t))}% <span class="x" data-reset-tier="${esc(Math.round(t))}" title="重置该档">×</span></span>`).join('')}<button class="btn-secondary" data-reset-tiers="1">全部重置</button></div>`
    : '';
  const reserveRow =
    entry.cap != null && Number.isFinite(entry.cap)
      ? `<div class="corr-row"><span class="l">预留资金已用</span><span>¥ ${esc(moneyNum(entry.reserveUsed))} / 上限 ¥ ${esc(moneyNum(entry.cap))}</span><input class="money-input" data-correct-value="1" value="${esc(entry.reserveUsed ?? 0)}" placeholder="校正为"><button class="btn-primary" data-correct-reserve="1">保存</button></div>`
      : '';
  const corrBody =
    tierRow || reserveRow
      ? `<details class="corr sd-corr"><summary><b>人工纠偏</b>（归因漏计时的兜底 · 默认收起）</summary><div class="corr-body">${tierRow}${reserveRow}<div class="sd-note">校正不改归因锚（锚为空时自动初始化到当前净值日）——已评估净值日之前的补录买入漏计时才需要动这里；改错可再改，越界保存会被拒绝（0 ~ 上限）。</div></div></details>`
      : '';

  // 已执行/已忽略态以回执口径改写标题与规则动作文案
  const executed = entry.executed && entry.executedInfo;
  const stateLabel = (STATE_BADGES[entry.state] || STATE_BADGES.HOLD).label;
  if (executed) {
    // 已执行态改用回执口径：payload.shares 为执行后剩余份额，再乘 ratio 会重复扣减
    title = `${stateLabel}动作已确认执行，冷却锁定中`;
    what.length = 0;
    what.push(
      entry.executedInfo.auto
        ? `系统已自动归因 <b>${dateTxt}</b> 的交易，基准按执行日推进。`
        : `已于 <b>${dateTxt}</b> 手动登记执行。`,
    );
    dos.length = 0;
    dos.push(
      `冷却窗口内（第 ${entry.executedInfo.day}/${entry.executedInfo.total} 个净值日）不重复推送建议。`,
    );
  } else if (entry.ignored) {
    title = `本轮${stateLabel}建议已被手动忽略`;
    dos.length = 0;
    dos.push('已<b>忽略本轮信号</b>，冷却结束前不再提醒。');
  }
  const actName =
    { TAKE_PROFIT: '止盈卖出', STOP_LOSS: '止损赎回', ADD: '加仓买入', EXIT: '清空清仓' }[
      entry.state
    ] || '动作';
  // 已执行态不提供备忘复制；已忽略为非推送的主动行为，仍可复制
  const memoText = executed ? null : sdMemoText(entry);
  const copyBtn =
    memoText && ACTION_STATES.includes(entry.state)
      ? `<button type="button" class="sd-copy" data-copy-memo="${esc(memoText)}" title="复制交易备忘（去代销平台下单时粘贴）">⧉</button>`
      : '';
  const actionVerb = {
    TAKE_PROFIT: '已在代销平台卖出',
    STOP_LOSS: '已在代销平台卖出',
    ADD: '已在代销平台买入',
    EXIT: '已在代销平台全部卖出',
  }[ackState];
  const executedBlock = executed
    ? `<div class="sd-feedback ok">
        <b>已执行（${stateLabel}）· 冷却中</b>
        ${sdSteps(entry.executedInfo)}
        <span class="sd-note">期间不重复提醒，徽章照常显示真实状态。</span>
      </div>`
    : '';
  const ignoredBlock = entry.ignored
    ? `<div class="sd-actions"><span class="chip off">已忽略 · 本轮不再提醒</span><span class="sd-note">徽章照常显示真实状态；冷却窗口后按状态再次提醒</span></div>`
    : '';
  const buttons = executedBlock
    ? ''
    : ignoredBlock ||
      (ackState
        ? `<div class="sd-actions">
        <button class="btn-primary" data-strategy-ack="${esc(ackState)}" data-navdate="${esc(ackNavDate || '')}" data-code="${esc(entry.code)}" title="只做登记与冷却/预算推进，不会替你下单">${actionVerb}（标记进入冷却）</button>
        <button class="btn-secondary" data-strategy-ignore="1" title="本轮忽略：冷却期内不再提醒">本轮忽略</button>
      </div>`
        : '');
  const receiptRows = executed
    ? `<div class="sd-nums">
        <div class="sd-num"><div class="l">当前持有份额</div><div class="v">${sharesFmt}<small> 份</small></div><div class="sub">${entry.shares != null && entry.nav != null ? `按净值 ${navTxt} 约 ¥${(Math.round(entry.shares * entry.nav * 100) / 100).toLocaleString('zh-CN')}` : ''}</div></div>
        <div class="sd-num"><div class="l">本次动作</div><div class="v sm">${actName}已完成</div><div class="sub">执行日 ${esc(entry.executedInfo.navDate || entry.navDate || '—')}${entry.executedInfo.auto ? ' · 系统自动归因' : ' · 手动确认'}；实际成交份额以你的交易记录为准</div></div>
      </div>`
    : '';
  // 引擎未提供 preview 字段时整块不渲染
  const prevRows = entry.preview
    ? `<div class="sd-preview">
        <div class="t">补仓效果与风险预演（加权平均成本口径）</div>
        <div class="row"><span>摊薄后加权成本估算</span><b>${Number(entry.preview.newCost).toFixed(4)}</b></div>
        <div class="row"><span>补仓后回本所需涨幅</span><b>+${(entry.preview.breakevenGain * 100).toFixed(1)}%</b></div>
        <div class="row"><span>跌至首档止损时本次加仓亏损</span><b class="loss">¥${entry.preview.stop1Loss}</b></div>
        <div class="note">摊薄口径：本次金额按最近确认净值折算份额；首档止损价位 ${Number(entry.preview.stop1Price).toFixed(4)} 按摊薄后本金反解。亏损额着色随涨跌色预设。</div>
      </div>`
    : '';
  const planNote =
    entry.executionPlan && !executed
      ? `<div class="sd-note plan">下单窗口：${esc(String(entry.executionPlan.orderDeadline ?? '').replace('T', ' '))} 前 · 按下一净值日<b>未知价</b>成交${entry.executionPlan.estimatedFeeRate != null ? ` · 预估费率 ${(entry.executionPlan.estimatedFeeRate * 100).toFixed(2)}%` : ''}${entry.executionPlan.calendarEstimated ? '（截止日按工作日估算）' : ''}${entry.executionPlan.orderExpired ? ' · ⚠ 下单窗口已过，等待下一信号' : ''}</div>`
      : '';
  const safetyRow =
    entry.state === 'TAKE_PROFIT' && entry.trigger === 'trailing' && entry.executionPlan?.safetyPad
      ? `<div class="sd-safety">安全垫不变量承诺：本轮最坏锁利 <b>+${(entry.executionPlan.safetyPad.lockedProfit * 100).toFixed(1)}%</b>（触发价 = 成本价 ×${Number(entry.executionPlan.safetyPad.triggerPrice).toFixed(4)}）</div>`
      : '';
  const retainTag = entry.retainRounded
    ? ` <span class="sd-tagx warn" title="按比例卖出后剩余不足最低保留份额（${entry.retainRounded.minRetainShares} 份），规则改为全额赎回">触发保留份额归整</span><div class="sub">本应卖 ${ratioLabel(entry.retainRounded.rawRatio)}，剩余不足最低保留份额 → 改为全额赎回</div>`
    : '';
  const manualNote =
    entry.manualAction === 'below_min_redeem_total'
      ? `<div class="sd-note">份额低于起赎线，需柜台/客服人工处理——不自动下发注定被拒单的指令</div>`
      : '';
  const estRows = executed
    ? receiptRows
    : est.length
      ? `<div class="sd-nums">${est.map(([l, v]) => `<div class="sd-num"><div class="l">${l}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>${retainTag}${prevRows}${planNote}`
      : entry.manualAction || entry.blockedByShareRules
        ? `${manualNote}${entry.blockedByShareRules ? '<div class="sd-note">按比例赎回无法同时满足最低赎回与最低保留份额——请人工处理</div>' : ''}`
        : '';
  const b = STATE_BADGES[entry.state] || STATE_BADGES.HOLD;
  const html = `<div class="sd" data-state="${esc(entry.state || '')}" style="--sd-accent:var(--st-${b.cls});--sd-soft-bg:color-mix(in srgb,var(--st-${b.cls}) 10%,transparent);--sd-soft-line:color-mix(in srgb,var(--st-${b.cls}) 32%,transparent)">
      <i class="sd-band" aria-hidden="true"></i>
      ${sdHead(entry)}
      <div class="sd-decision">
        <div class="sd-hero"><h3>${esc(title)}</h3>${copyBtn}</div>
        ${estRows}
      </div>
      <div class="sd-evidence">
        <div class="sd-seclabel"><span>决策依据</span><span class="r">${cfgTxt}</span></div>
        ${sdGauge(entry)}
        <div class="sd-stream">
          <div class="sd-row"><span class="sd-tag">现状触发</span><div class="sd-txt">${what.join('')}</div></div>
          <div class="sd-row act"><span class="sd-tag">规则动作</span><div class="sd-txt">${dos.join('')}${safetyRow}</div></div>
          ${why.length ? `<details class="sd-why"><summary><span class="chev">›</span>为什么这么建议？<span class="f">（风控初衷，需要解惑时点开）</span></summary><div class="body"><span class="quote">${why.join('')}</span></div></details>` : ''}
        </div>
      </div>
      <div class="sd-action">
        ${executedBlock}
        ${buttons}
        ${corrBody}
        <div class="sd-foot">依据：${dateTxt} 确认净值 · ${cfgTxt} · 建议 = 规则输出，不构成投资指令。</div>
      </div>
    </div>`;
  return { html, ackState, ackNavDate };
}
