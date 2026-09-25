import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strategyBadgeHtml,
  strategyDetailHtml,
  strategyTimelineHtml,
  ratioLabel,
  plainSub,
  storyTitle,
  STATE_BADGES,
} from '../../js/components/badgeRenderer.js';

const base = {
  code: '110020',
  name: '演示基金',
  state: 'HOLD',
  ratio: null,
  addAmount: null,
  radar: { level: null, d5Drop: null },
  progress: null,
  reasonText: '',
  executed: false,
  executedInfo: null,
  trigger: null,
  fullRedemption: false,
  nav: 1.05,
  navDate: '2026-09-10',
  shares: 10000,
  invested: 9700,
  profitRate: 0.081,
  lossRate: -0.03,
  xirr: null,
  customParams: false,
};

test('七态徽章：文案/样式类/比例展示映射', () => {
  const mk = (over) => strategyBadgeHtml({ ...base, ...over });
  assert.ok(mk({ state: 'HOLD' }).includes('>持有<'));
  assert.ok(mk({ state: 'WATCH' }).includes('>关注<'));
  assert.ok(mk({ state: 'ALERT' }).includes('>警戒<'));
  assert.ok(
    mk({ state: 'TAKE_PROFIT', ratio: 0.5 }).includes('止盈 <span class="ratio">1/2</span>'),
  );
  assert.ok(
    mk({ state: 'STOP_LOSS', ratio: 1 / 3 }).includes('止损 <span class="ratio">1/3</span>'),
  );
  assert.ok(mk({ state: 'EXIT', ratio: 1 }).includes('清空 <span class="ratio">全额</span>'));
  assert.ok(mk({ state: 'ADD', addAmount: 1000 }).includes('>补仓<')); // 补仓徽章不带比例
  // 非动作态不显示比例
  assert.ok(!mk({ state: 'HOLD' }).includes('ratio'));
  // 副标题人话
  assert.ok(mk({ state: 'TAKE_PROFIT', ratio: 0.5 }).includes('涨多了又回落，建议落袋1/2'));
  assert.ok(mk({ state: 'EXIT', ratio: 1 }).includes('亏到最大容忍度'));
});

test('执行归因：徽章转"锁定中 · 第 x/5 天"弱化态，副标题显示冷却进度', () => {
  const html = strategyBadgeHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    executed: true,
    executedInfo: { day: 2, total: 5 },
  });
  assert.ok(html.includes('止盈锁定中 · 第 2/5 天'));
  assert.ok(html.includes('badge tp dim'));
  assert.ok(html.includes('已执行，冷却中（第 2/5 天）'));
  assert.ok(!html.includes('data-strategy-detail=""')); // dim 态仍可点开详情
});

test('进度条与临近触发：80%+ 显示 hot 临近角标，100% 显示 over', () => {
  const near = strategyBadgeHtml({
    ...base,
    state: 'HOLD',
    progress: { label: '回撤 4.1% / 落袋线 5%', pct: 82, tone: 'hot', cur: 0.041, line: 0.05 },
  });
  assert.ok(near.includes('<span class="near">临近触发线</span>'));
  assert.ok(near.includes('width:82%'));
  assert.ok(near.includes('（临近）'));
  const over = strategyBadgeHtml({
    ...base,
    state: 'STOP_LOSS',
    ratio: 1 / 3,
    progress: { label: '亏 16.2% / 首档线 -15%', pct: 100, tone: 'over', cur: 0.162, line: 0.15 },
  });
  assert.ok(over.includes('class="over"'));
  assert.ok(!over.includes('临近触发线'));
});

test('雷达角标：黄/橙胶囊 + 不构成买卖建议语义在详情层', () => {
  const html = strategyBadgeHtml({ ...base, radar: { level: 'orange', d5Drop: -0.062 } });
  assert.ok(html.includes('radar orange'));
  assert.ok(html.includes('连跌 6.2%'));
  const yellow = strategyBadgeHtml({ ...base, radar: { level: 'yellow', d5Drop: -0.055 } });
  assert.ok(yellow.includes('radar yellow'));
  assert.ok(yellow.includes('连跌 5.5%'));
});

test('错误/无数据降级：显示"未评估"灰徽章，不炸', () => {
  assert.ok(strategyBadgeHtml({ error: '评估失败：安全垫' }).includes('未评估'));
  assert.ok(strategyBadgeHtml(null).includes('未评估'));
});

test('XSS 防护：基金名/错误信息经转义', () => {
  const html = strategyBadgeHtml({ ...base, name: '<img src=x onerror=alert(1)>', error: null });
  assert.ok(!html.includes('<img src=x'));
  const err = strategyBadgeHtml({ error: '<script>x</script>' });
  assert.ok(!err.includes('<script>'));
});

test('详情卡：三大板块结构 + 到手预估 + 合规标注 + ack 数据', () => {
  const entry = {
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    drawdown: 0.055,
    trigger: 'trailing',
    progress: { label: '回撤 5.5% / 落袋线 5%', pct: 110, tone: 'over', cur: 0.055, line: 0.05 },
  };
  const { html, ackState, ackNavDate } = strategyDetailHtml(entry);
  assert.ok(html.includes('涨多了又回落'));
  // 三大板块结构（决策/证据/行动）
  assert.ok(
    html.includes('sd-decision') && html.includes('sd-evidence') && html.includes('sd-action'),
  );
  // 头部：横向头（状态色带+身份+数据时点）+ 状态药丸（.sd-head）
  assert.ok(html.includes('sd-head') && html.includes('演示基金') && html.includes('数据时点'));
  assert.ok(html.includes('>止盈 · 1/2<')); // 药丸比例用 · 分隔（对稿）
  // 证据层主干：现状触发 / 规则动作；单容器表格化.sd-stream（三段+雷达行同容器）；风控初衷折叠在容器内
  assert.ok(
    html.includes('现状触发') && html.includes('规则动作') && html.includes('为什么这么建议'),
  );
  const streamHtml = html.slice(html.indexOf('sd-stream'), html.indexOf('sd-action'));
  assert.ok(streamHtml.includes('sd-tag">现状触发') && streamHtml.includes('sd-tag">规则动作'));
  assert.ok(html.includes('5,000 份（持有 10,000 的 1/2）'));
  assert.ok(html.includes('≈ ¥5,250')); // 5000 × 1.05
  assert.ok(html.includes('估算') && html.includes('以基金公司确认为准')); // 估算说明收进 ⚠ 角标悬浮气泡（data-tip）
  assert.ok(html.includes('sd-tip') && !html.includes('sd-note est')); // 不再常驻整行
  assert.ok(!html.includes('最终决定权')); // 页脚删"最终决定权在你"
  assert.ok(html.includes('sd-gauge') && html.includes('sd-gauge-mark')); // 70% 触发线刻度
  assert.ok(
    html.includes('data-strategy-ack="TAKE_PROFIT"') && html.includes('data-navdate="2026-09-10"'),
  );
  assert.equal(ackState, 'TAKE_PROFIT');
  assert.equal(ackNavDate, '2026-09-10');
});

test('详情卡仪表（.sd-meter）：值轴 cur/line、70% 锚、游标+跟随气泡、越界点亮', () => {
  const entry = {
    ...base,
    state: 'STOP_LOSS',
    ratio: 1 / 3,
    lossRate: -0.195,
    progress: { label: 'x', pct: 100, tone: 'over', cur: 0.195, line: 0.15 },
  };
  const { html } = strategyDetailHtml(entry);
  assert.ok(html.includes('已越过'));
  assert.ok(html.includes('data-over="1"')); // 越界：根 data-over 驱动 填充/游标/气泡/斜纹 点亮
  assert.ok(html.includes('sd-gauge-cursor') && html.includes('sd-gauge-callout')); // 游标 + 跟随气泡（稿 .cursor/.callout）
  assert.ok(html.includes('当前 亏损 19.5%')); // 气泡值 = cur（非被钳 pct），人话轴名
  assert.ok(html.includes('阈值 −15.0%'));
  const inner = {
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    progress: { label: 'x', pct: 60, tone: 'ok', cur: 0.03, line: 0.05 },
  };
  const h2 = strategyDetailHtml(inner).html;
  assert.ok(h2.includes('距触发线还差'));
  assert.ok(h2.includes('data-over="0"')); // 未越界：中性灰填充、灰游标灰气泡
  assert.ok(h2.includes('当前 回撤 3.0%') && h2.includes('阈值 5.0%')); // 回撤轴无负号
});

test('详情卡复制备忘：动作态出 ⧉ 按钮 + 文案按态取（卖出份额/买入金额/全额）', () => {
  const sell = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.055,
  }).html;
  assert.ok(sell.includes('data-copy-memo="演示基金 赎回 5000 份"'));
  const buy = strategyDetailHtml({ ...base, state: 'ADD', addAmount: 800 }).html;
  assert.ok(buy.includes('data-copy-memo="演示基金 买入 ¥800"'));
  const full = strategyDetailHtml({ ...base, state: 'EXIT', ratio: 1, lossRate: -0.31 }).html;
  assert.ok(full.includes('data-copy-memo="演示基金 赎回全部 10000 份"'));
  const hold = strategyDetailHtml({ ...base, state: 'HOLD' }).html;
  assert.ok(!hold.includes('data-copy-memo')); // 非动作态不出
  const exec = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    executed: true,
    executedInfo: { day: 1, total: 5 },
  }).html;
  assert.ok(!exec.includes('data-copy-memo')); // 已执行不出
});

test('详情卡到手金额计算：5000 份 × 1.05 净值 = 5250', () => {
  const entry = {
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    progress: { label: 'x', pct: 100, tone: 'over', cur: 0.055, line: 0.05 },
  };
  const { html } = strategyDetailHtml(entry);
  assert.ok(html.includes('≈ ¥5,250'));
});

test('详情卡主按钮：已在代销平台×（标记进入冷却）句式；说明收进 title 悬浮，不再常驻小字', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.052,
  }).html;
  assert.ok(html.includes('已在代销平台卖出（标记进入冷却）'));
  assert.ok(html.includes('不会替你下单')); // 收进按钮 title
  assert.ok(!html.includes('本按钮只做登记')); // 不再常驻整行小字
  assert.ok(html.includes('class="btn-primary" data-strategy-ack'));
  const buy = strategyDetailHtml({ ...base, state: 'ADD', addAmount: 500 }).html;
  assert.ok(buy.includes('已在代销平台买入（标记进入冷却）'));
  const exit = strategyDetailHtml({ ...base, state: 'EXIT', ratio: 1, lossRate: -0.31 }).html;
  assert.ok(exit.includes('已在代销平台全部卖出（标记进入冷却）'));
  const sl = strategyDetailHtml({ ...base, state: 'STOP_LOSS', ratio: 0.5, lossRate: -0.16 }).html;
  assert.ok(sl.includes('已在代销平台卖出（标记进入冷却）'));
});

test('详情卡冷却步进器：executed 出步进格与净值日说明，撤下按钮', () => {
  const { html } = strategyDetailHtml({
    ...base,
    state: 'STOP_LOSS',
    ratio: 0.5,
    executed: true,
    executedInfo: { day: 2, total: 5 },
  });
  assert.ok(html.includes('sd-steps'));
  assert.ok(html.includes('第 2 / 5 个净值日'));
  assert.ok(html.includes('净值日非自然日'));
  assert.ok(!html.includes('data-strategy-ack'));
  assert.ok(!html.includes('data-copy-memo'));
});

test('详情卡状态分支：观望带/补仓缺预算/达上限/执行中各有专属文案', () => {
  const alert = strategyDetailHtml({ ...base, state: 'ALERT', lossRate: -0.14 }).html;
  assert.ok(alert.includes('观望带') && alert.includes('只提醒，不建议动作'));
  // 缺预算/达上限时引擎不产出ADD（状态恒为WATCH），原因只随addBlockReason传来；归位WATCH分支
  const missing = strategyDetailHtml({
    ...base,
    state: 'WATCH',
    addBlockReason: 'missing_reserve',
  }).html;
  assert.ok(missing.includes('未设预留资金'));
  const capped = strategyDetailHtml({
    ...base,
    state: 'WATCH',
    addBlockReason: 'cap_reached',
  }).html;
  assert.ok(capped.includes('已达预算上限'));
  const executed = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    executed: true,
    executedInfo: { day: 3, total: 5 },
  });
  assert.ok(executed.html.includes('冷却中'));
  assert.ok(!executed.html.includes('data-strategy-ack')); // 执行中不再出按钮
});

test('详情卡合规底线：非动作态无预估金额块；动作态必带估算标注', () => {
  const hold = strategyDetailHtml({ ...base, state: 'HOLD' }).html;
  assert.ok(!hold.includes('预估到手'));
  assert.ok(hold.includes('不构成投资指令'));
  const exit = strategyDetailHtml({ ...base, state: 'EXIT', ratio: 1, lossRate: -0.31 }).html;
  assert.ok(exit.includes('估算'));
});

test('时间线：故事标题 + 当时快照（含配置自定义标记），空数据有占位', () => {
  const html = strategyTimelineHtml([
    {
      ts: '2026-09-04T20:00:00+08:00',
      code: '110020',
      name: '演示',
      state: 'STOP_LOSS',
      ratio: 1 / 3,
      navDate: '2026-09-04',
      nav: 0.838,
      lossRate: -0.162,
      trigger: 'stop1',
      reasonText: '亏损率 -16.2% 触及首档止损线 -15%',
      configUsed: { _custom: false },
    },
  ]);
  assert.ok(html.includes('9 月 04 日 · 止损提醒：亏过头了，先卖 1/3'));
  assert.ok(html.includes('净值 0.838'));
  assert.ok(html.includes('规则：首档止损'));
  assert.ok(html.includes('默认参数（未自定义）'));
  const custom = strategyTimelineHtml([
    {
      ts: 't',
      state: 'TAKE_PROFIT',
      ratio: 0.5,
      navDate: '2026-08-29',
      nav: 1.834,
      drawdown: 0.083,
      trigger: 'trailing',
      reasonText: 'x',
      configUsed: { _custom: true },
    },
  ]);
  assert.ok(custom.includes('含自定义参数'));
  const empty = strategyTimelineHtml([]);
  assert.ok(empty.includes('还没有触发记录'));
});

test('storyTitle / ratioLabel / plainSub 边界', () => {
  assert.equal(ratioLabel(0.5), '1/2');
  assert.equal(ratioLabel(1 / 3), '1/3');
  assert.equal(ratioLabel(1), '全额');
  assert.equal(ratioLabel(null), '');
  assert.ok(storyTitle({ state: 'EXIT', ratio: 1, navDate: '2026-09-10' }).includes('清空提醒'));
  assert.ok(storyTitle({ state: 'OTHER', navDate: '2026-09-10' }).includes('OTHER'));
  assert.equal(plainSub({ ...base, state: 'ADD', addAmount: 1000 }), '按计划补一小口 ¥1,000');
  assert.equal(plainSub({ ...base, error: 'x' }), '策略数据暂不可用');
  assert.ok(Object.keys(STATE_BADGES).length === 7);
});

test('雷达角标文案：按触发阈值说人话（峰值回撤/20 日跌/连跌）', () => {
  const peak = strategyBadgeHtml({
    ...base,
    radar: { level: 'orange', d5Drop: -0.016, peak60Drawdown: 0.12 },
  });
  assert.ok(peak.includes('峰值回撤 12.0%')); // 橙色由峰值回撤触发时不误标"连跌"
  const d20 = strategyBadgeHtml({
    ...base,
    radar: { level: 'orange', d5Drop: -0.02, d20Drop: -0.11, peak60Drawdown: null },
  });
  assert.ok(d20.includes('20 日跌 11.0%'));
  const d5 = strategyBadgeHtml({
    ...base,
    radar: { level: 'yellow', d5Drop: -0.055, d20Drop: null, peak60Drawdown: null },
  });
  assert.ok(d5.includes('连跌 5.5%'));
});

test('雷达角标 trigger 优先：自定义阈值触发时按实际指标说人话（硬编码兜底会误标）', () => {
  // peak60 自定义 4% 触发：回撤 5.0% < 硬编码 8% → 旧逻辑会误标"连跌 1.6%"
  const peak = strategyBadgeHtml({
    ...base,
    radar: { level: 'orange', trigger: 'peak60', peak60Drawdown: 0.05, d5Drop: -0.016 },
  });
  assert.ok(peak.includes('峰值回撤 5.0%'));
  const d20 = strategyBadgeHtml({
    ...base,
    radar: { level: 'orange', trigger: 'd20', d20Drop: -0.11 },
  });
  assert.ok(d20.includes('20 日跌 11.0%'));
  const d5 = strategyBadgeHtml({
    ...base,
    radar: { level: 'yellow', trigger: 'd5', d5Drop: -0.055 },
  });
  assert.ok(d5.includes('连跌 5.5%'));
});

test('plainSub：WATCH + addBlockReason 走补仓区专属副标题（缺预算/达上限）', () => {
  assert.equal(
    plainSub({ ...base, state: 'WATCH', addBlockReason: 'missing_reserve' }),
    '补仓区缺预算——先到「策略」里设置预留资金',
  );
  assert.equal(
    plainSub({ ...base, state: 'WATCH', addBlockReason: 'cap_reached' }),
    '补仓预算已用完，规则收手',
  );
  assert.equal(plainSub({ ...base, state: 'WATCH' }), '小幅回调，先观察');
});

// ---- 人工纠偏区渲染 + 忽略置灰态 ----

test('详情卡：ignored=true → 已忽略置灰 chip 替换操作按钮组（后端布尔）', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.052,
    ignored: true,
  }).html;
  assert.ok(html.includes('已忽略 · 本轮不再提醒'));
  assert.ok(!html.includes('data-strategy-ack')); // 操作按钮不再出现
  assert.ok(!html.includes('data-strategy-ignore'));
});

test('详情卡：ignored=false → 操作按钮组照常（已执行/忽略）', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.052,
    ignored: false,
  }).html;
  assert.ok(html.includes('data-strategy-ack'));
  assert.ok(html.includes('data-strategy-ignore'));
});

test('详情卡：纠偏区——消耗位 chips + 全部重置 + 预留资金校正行（cap 存在时）', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'xirrLadder',
    xirr: 0.18,
    consumedTiers: [15, 20],
    reserveUsed: 1200,
    cap: 2000,
  }).html;
  assert.ok(html.includes('人工纠偏'));
  assert.ok(html.includes('15%'));
  assert.ok(html.includes('data-reset-tier="15"'));
  assert.ok(html.includes('data-reset-tiers="1"'));
  assert.ok(html.includes('预留资金已用'));
  assert.ok(html.includes('¥ 1200 / 上限 ¥ 2000'));
  assert.ok(html.includes('data-correct-value'));
  assert.ok(html.includes('data-correct-reserve'));
});

test('详情卡：纠偏区——无消耗位且 cap 为 null 时整体不渲染', () => {
  const html = strategyDetailHtml({ ...base, state: 'HOLD' }).html;
  assert.ok(!html.includes('人工纠偏'));
});

test('详情卡：纠偏区 XSS——消耗位数值与校正值转义', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'xirrLadder',
    xirr: 0.18,
    consumedTiers: [15],
    reserveUsed: 1200,
    cap: 2000,
    navDate: '"><script>',
  }).html;
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&quot;&gt;'));
});

// ---- 雷达 ⚠ 角标 + 按钮类名 ----

test('雷达角标：输出 ⚠ 图标、无圆点 <i>、class 与文案不变', () => {
  const orange = strategyBadgeHtml({ ...base, radar: { level: 'orange', d5Drop: -0.062 } });
  assert.ok(orange.includes('radar orange'));
  assert.ok(orange.includes('⚠'));
  assert.ok(!orange.includes('<i></i>'));
  const yellow = strategyBadgeHtml({ ...base, radar: { level: 'yellow', d5Drop: -0.055 } });
  assert.ok(yellow.includes('radar yellow') && yellow.includes('⚠'));
});

test('详情卡按钮：已执行/忽略改绑 btn-primary/btn-secondary（.btn 基类缺失修复）', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.052,
    ignored: false,
  }).html;
  assert.ok(html.includes('class="btn-primary" data-strategy-ack'));
  assert.ok(html.includes('class="btn-secondary" data-strategy-ignore="1"'));
  assert.ok(!html.includes('class="btn primary"'));
  assert.ok(!html.includes('class="btn" data-strategy'));
});

test('详情卡纠偏区按钮：全部重置改 btn-secondary、保存改 btn-primary', () => {
  const html = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'xirrLadder',
    xirr: 0.18,
    consumedTiers: [15],
    reserveUsed: 1200,
    cap: 2000,
  }).html;
  assert.ok(html.includes('class="btn-secondary" data-reset-tiers="1"'));
  assert.ok(html.includes('class="btn-primary" data-correct-reserve="1"'));
});

// ---- 对稿修齐：药丸文案 / 头部结构 / 已执行回执 / 已忽略可复制 ----

test('详情卡头部对稿：色带+雷达居药丸左侧、药丸 · 比例、QDII 滞后角标、决策依据标签行', () => {
  const { html } = strategyDetailHtml({
    ...base,
    state: 'STOP_LOSS',
    ratio: 0.5,
    lossRate: -0.16,
    navLag: true,
    radar: { level: 'yellow', trigger: 'd5', d5Drop: -0.042 },
  });
  assert.ok(html.includes('sd-band')); // 顶部状态色带
  assert.ok(html.includes('>止损 · 1/2<')); // 药丸 · 分隔
  const radarAt = html.indexOf('sd-radar yellow');
  assert.ok(radarAt > html.indexOf('sd-name')); // 雷达角标挂基金名称右侧（只做角标）
  assert.ok(html.includes('QDII 净值滞后')); //对照表 2，与主表 navIsLagged 同口径
  assert.ok(html.includes('决策依据')); // 证据层板块标签行（参数随行）
  assert.ok(!html.includes('sd-row radar')); // 证据流不再单列雷达行（合规句进角标 tooltip 与页脚）
  assert.ok(
    html.includes('data-sd-close') && html.indexOf('data-sd-close') > html.indexOf('sd-pill'),
  ); // 关闭钮入流居药丸右侧（对稿 .sd-side，非浮层）
  const noRatio = strategyDetailHtml({
    ...base,
    state: 'STOP_LOSS',
    ratio: null,
    lossRate: -0.16,
  }).html;
  assert.ok(noRatio.includes('>止损<')); // 比例 null 不出尾随分隔符
});

test('详情卡已执行态对稿（对照表 4）：撤动作数字改执行回执，药丸仍报状态真话', () => {
  const { html } = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.055,
    executed: true,
    executedInfo: { day: 2, total: 5, navDate: '2026-09-10', auto: true },
  });
  assert.ok(!html.includes('拟赎回份额') && !html.includes('预估到手')); // 动作数字与估算注记整体撤下（shares 是执行后剩余份额，×ratio 会算成"还要再卖一半"）
  assert.ok(html.includes('当前持有份额') && html.includes('止盈卖出已完成'));
  assert.ok(html.includes('系统自动归因'));
  assert.ok(html.includes('冷却锁定中')); // 标题改执行口径
  assert.ok(html.includes('>止盈 · 1/2<')); // 药丸不改写，冷却进度由步进器表达
  assert.ok(!html.includes('锁定中 · 第')); // 不带主表徽章的锁定句式
});

test('详情卡已忽略态对稿：标题改"已被手动忽略"，备忘仍可复制（主动行为）', () => {
  const { html } = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.052,
    ignored: true,
  });
  assert.ok(html.includes('已被手动忽略'));
  assert.ok(html.includes('忽略本轮信号'));
  assert.ok(html.includes('data-copy-memo'));
});

// ---- P1 引擎字段接入（D5/契约/归整）----

test('P1 详情卡引擎字段接入：preview 三联 / executionPlan 摘要 / safetyPad / retainRounded 归整微标签', () => {
  const baseP1 = {
    ...base,
    state: 'ADD',
    addAmount: 500,
    preview: {
      newCost: 1.5012,
      breakevenGain: 0.043,
      stop1Price: 1.276,
      stop1Loss: -56.69,
      addTier: { crossed: 0, total: 2 },
    },
    executionPlan: {
      signalNavDate: '2026-09-10',
      orderDeadline: '2026-09-11T15:00',
      expectedExecutionNavDate: '2026-09-11',
      priceKnown: false,
      estimatedFeeRate: null,
      safetyPad: null,
      calendarEstimated: false,
      orderExpired: false,
    },
  };
  const add = strategyDetailHtml(baseP1).html;
  assert.ok(add.includes('补仓效果与风险预演'), '预演三联块');
  assert.ok(
    add.includes('1.5012') && add.includes('+4.3%') && add.includes('-56.69'),
    '摊薄成本/回本涨幅/首档亏损',
  );
  assert.ok(
    add.includes('下单窗口：2026-09-11 15:00 前') && add.includes('未知价'),
    'executionPlan 摘要行',
  );
  const tp = strategyDetailHtml({
    ...base,
    state: 'TAKE_PROFIT',
    ratio: 0.5,
    trigger: 'trailing',
    drawdown: 0.055,
    executionPlan: {
      signalNavDate: '2026-09-10',
      orderDeadline: '2026-09-11T15:00',
      priceKnown: false,
      safetyPad: { triggerPrice: 1.026, lockedProfit: 0.026 },
    },
  }).html;
  assert.ok(
    tp.includes('安全垫不变量承诺') && tp.includes('+2.6%'),
    'safetyPad 行（引擎必产、前端直读不重算）',
  );
  const rr = strategyDetailHtml({
    ...base,
    state: 'STOP_LOSS',
    ratio: 1,
    lossRate: -0.173,
    fullRedemption: true,
    retainRounded: { minRetainShares: 10, rawRatio: 0.5 },
  }).html;
  assert.ok(
    rr.includes('触发保留份额归整') && rr.includes('本应卖 1/2'),
    'retainRounded 微标签（D5）',
  );
});
