import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../../lib/database.js';
import { createStrategyStore } from '../../lib/strategyStore.js';
import { createStrategyTask } from '../../lib/strategyTask.js';

// 夹具：一只盈利中的基金（买入 10000 @1.00，份额 10000）
const FUND = {
  id: 'fund_a',
  asset_type: 'fund',
  name: '测试基金A',
  code: '110020',
  snapshot: {
    hold_amount: 10000,
    pending_amount: 0,
    cost_price: 1.0,
    hold_shares: 10000,
    total_invested: 10000,
  },
  transactions: [{ id: 'tx1', type: 'buy', amount: 10000, shares: 10000, date: '2026-01-10' }],
  strategy_config: null,
};

function mkDates(n, end) {
  const base = new Date(end + 'T00:00:00');
  return Array.from({ length: n }, (_, i) =>
    new Date(base.getTime() - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
  );
}

async function makeHarness({
  seriesByCall,
  seriesByCode,
  config = null,
  funds = null,
  endDate = '2026-09-10',
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'strategytask-'));
  const db = createDatabase({ dataDir: dir, now: () => new Date('2026-09-10T20:00:00') });
  await db.save(funds ?? [{ ...FUND, strategy_config: config }], null, []);
  const store = createStrategyStore({ dataDir: dir });
  const seriesQueue = Array.isArray(seriesByCall)
    ? [...seriesByCall]
    : [seriesByCall].filter(Boolean);
  let fetchCalls = 0;
  const fetchHistory = async (code) => {
    fetchCalls++;
    if (seriesByCode && seriesByCode[code]) return { series: seriesByCode[code] };
    const s = seriesQueue.length ? seriesQueue.shift() : seriesQueue[seriesQueue.length - 1];
    return { series: s }; // 依次出队；队列耗尽后重复最后一份（与真实 datasource 同形：{ code, series }）
  };
  let simNow = new Date(endDate + 'T20:00:00'); // 可变时钟：跨"天"测试用（每日缓存按天分桶）
  const task = createStrategyTask({
    db,
    strategyStore: store,
    fetchHistory,
    now: () => new Date(simNow),
    xirrFn: () => null,
  }); // XIRR 注入 null：本组用例只验证移动止盈/幂等/读写链路
  return {
    db,
    store,
    task,
    fetchHistory,
    setDay: (d) => {
      simNow = new Date(d + 'T20:00:00');
    },
    setTime: (d, h, m = 0) => {
      simNow = new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
    },
    fetchCount: () => fetchCalls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('runOnce：移动止盈触发 → 事件写入 alerts + 持久态更新（hwmDate/冷却/lastEvalNavDate）', async () => {
  const d1 = mkDates(6, '2026-09-09'); // 净值 1.00→1.20（启动，峰值=当日）
  const d2 = mkDates(7, '2026-09-10'); // 末日用 1.10：从峰值 1.20 回撤 8.3% ≥5%
  const s1 = d1.map((d, i) => ({
    date: d,
    nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2][i],
    acc_nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2][i],
  })); // acc=nav：无分红，1.20→1.10 是真实回撤
  const s2 = d2.map((d, i) => ({
    date: d,
    nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1][i],
    acc_nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1][i],
  }));
  const h = await makeHarness({ seriesByCall: [s1, s2] });
  try {
    const r1 = await h.task.runOnce();
    assert.equal(r1.evaluated, 1);
    assert.equal(r1.events, 0); // 启动轮：drawdown=0 不触发
    let st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.hwmDate, d1[5]); // 峰值落盘（序列末日）
    h.setDay('2026-09-11'); // 跨天（缓存按天分桶失效）+ 新净值日推进 → 回撤触发
    const r2 = await h.task.runOnce(); // 净值推进到 09-10 → 回撤触发
    assert.equal(r2.events, 1);
    const alerts = await h.store.loadAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].state, 'TAKE_PROFIT');
    assert.equal(alerts[0].ratio, 0.5);
    st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.lastEvalNavDate, d2[6]);
    assert.equal(st.cooldowns.TAKE_PROFIT, d2[6]);
  } finally {
    await h.cleanup();
  }
});

test('runOnce：净值未推进 → 幂等跳过（不重复评估、不重复写事件）', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s] });
  try {
    await h.task.runOnce();
    const before = (await h.store.loadState()).funds['110020'];
    await h.task.runOnce(); // 同序列再跑：navDate 未推进
    const st = (await h.store.loadState()).funds['110020'];
    assert.deepEqual(st.lastEvalNavDate, before.lastEvalNavDate); // 未变化（仍为 09-10）
    const alerts = await h.store.loadAlerts();
    assert.ok(alerts.every((a) => a.state !== 'TAKE_PROFIT'));
  } finally {
    await h.cleanup();
  }
});

test('runOnce：strategy_config.enabled=false → 跳过该基金', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s], config: { enabled: false } });
  try {
    const r = await h.task.runOnce();
    assert.equal(r.evaluated, 0);
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st?.lastEvalNavDate ?? null, null);
  } finally {
    await h.cleanup();
  }
});

test('status：只读实时评估（七态不落盘，不更新 lastEvalNavDate）', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s] });
  try {
    const payload = await h.task.status();
    assert.equal(payload.funds.length, 1);
    assert.equal(payload.funds[0].state, 'HOLD'); // 启动轮峰值=当日
    assert.deepEqual((await h.store.loadState()).funds, {}); // status 只读，不写持久态
  } finally {
    await h.cleanup();
  }
});

test('status：巡检（runOnce）后仍返回实时七态——幂等门只闸写路径', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s] });
  try {
    await h.task.runOnce(); // 巡检盖章 lastEvalNavDate = 09-10
    const payload = await h.task.status();
    assert.equal(payload.funds.length, 1); // status 不得复用写路径幂等门（否则恒返回空列表，通道 B 失效）
    assert.equal(payload.funds[0].state, 'HOLD');
    assert.equal((await h.store.loadState()).funds['110020'].lastEvalNavDate, d[5]); // status 仍不落盘
  } finally {
    await h.cleanup();
  }
});

test('runOnce/status：单基金配置违反安全垫 → 只降级该基金，不阻断整轮', async () => {
  const d = mkDates(6, '2026-09-10');
  const sGood = mkDates2Fix(d, [1.0, 1.0, 1.0, 0.97, 0.96, 0.84]); // −16% → STOP_LOSS
  const sBad = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const funds = [
    {
      ...FUND,
      id: 'fund_bad',
      code: '161017',
      name: '坏配置基金',
      strategy_config: { trailing: { startProfit: 0.08, drawdownThreshold: 0.08 } },
    }, // 8%/8% 违反安全垫不变量
    { ...FUND, id: 'fund_a', code: '110020', name: '测试基金A', strategy_config: null },
  ];
  const h = await makeHarness({ funds, seriesByCode: { 161017: sBad, 110020: sGood } });
  try {
    const r = await h.task.runOnce();
    assert.equal(r.evaluated, 1); // 坏基金跳过，好基金照常评估
    assert.equal(r.events, 1); // −16% 止损事件照常落盘（单只基金拉取失败不得拖垮整轮）
    const alerts = await h.store.loadAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].state, 'STOP_LOSS');
    assert.ok(alerts[0].configUsed); //7.3 全量留痕：触发时刻配置快照
    assert.equal(alerts[0].configUsed._custom, false); // 默认参数组
    const st = await h.store.loadState();
    assert.ok(st.funds['110020']); // 好基金持久态已保存
    assert.equal(st.funds['161017'], undefined); // 坏基金不写状态
    const s = await h.task.status();
    const bad = s.funds.find((f) => f.code === '161017');
    assert.equal(bad.state, null); // 降级条目（不炸整个接口）
    assert.ok(bad.error.includes('安全垫'));
    assert.equal(s.funds.find((f) => f.code === '110020').state, 'STOP_LOSS'); // status 实时返回（净值未推进也算）
  } finally {
    await h.cleanup();
  }
});

// 日期工具与上面 mkDates 一致（独立实现避免闭包共享）
function mkDates2Fix(dates, navs) {
  return dates.map((d, i) => ({ date: d, nav: navs[i], acc_nav: navs[i] }));
}

// ---- status 扩展字段 + ack 已执行归因 + alerts 时间线数据 ----

test('status：详情卡字段全量（progress/executed/nav/shares/customParams）', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s] });
  try {
    const payload = await h.task.status();
    const f = payload.funds[0];
    assert.equal(f.state, 'HOLD');
    assert.ok('progress' in f && 'executed' in f && 'executedInfo' in f);
    assert.equal(f.nav, 1.2); // K8：确认净值口径
    assert.equal(f.shares, 20000); // 夹具：快照基线 10000 + 买入 10000
    assert.equal(f.customParams, false); // strategy_config null → 默认参数
    assert.ok(f.navDate && f.invested > 0);
  } finally {
    await h.cleanup();
  }
});

// ---- 当日缓存晚间刷新 + 立即巡检强制重拉（15:30 首拉的旧序列会把当晚新净值挡到次日）----

test('当日缓存：首拉早于晚间档位时，19:00 档补拉一次拿到新净值', async () => {
  const d1 = mkDates(6, '2026-09-09');
  const s1 = mkDates2Fix(d1, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]); // 峰值 1.20 落盘）
  const d2 = mkDates(7, '2026-09-10');
  const s2 = mkDates2Fix(d2, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1]); // 09-10 回撤 8.3% → 触发
  const h = await makeHarness({ seriesByCall: [s1, s2] });
  try {
    h.setTime('2026-09-10', 15); // 15:30 首拉：净值未公布 → 序列止于 09-09
    const r1 = await h.task.runOnce();
    assert.equal(r1.evaluated, 1);
    assert.equal(r1.events, 0);
    h.setTime('2026-09-10', 19); // 当晚 19:00：19:00 档后 → 允许重拉一次
    const r2 = await h.task.runOnce();
    assert.equal(r2.evaluated, 1);
    assert.equal(r2.events, 1); // 19:00 档必须重拉当日序列（若恒复用旧序列会幂等跳过、触发事件丢失）
    h.setTime('2026-09-10', 21); // 当晚再巡：19:00 档已记指纹、未到 21:45 档 → 不再重拉
    await h.task.runOnce();
    assert.equal(h.fetchCount(), 2);
  } finally {
    await h.cleanup();
  }
});

test('当日缓存：21:45 第二档补拉（判据为当日分钟数，逐档至多一次）', async () => {
  const d1 = mkDates(6, '2026-09-09');
  const s1 = mkDates2Fix(d1, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const d2 = mkDates(8, '2026-09-10');
  const s2 = mkDates2Fix(d2, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1, 1.05]);
  const h = await makeHarness({ seriesByCall: [s1, s2, s2] });
  try {
    h.setTime('2026-09-10', 15);
    await h.task.runOnce(); // 首拉（fetch 1）
    h.setTime('2026-09-10', 19);
    await h.task.runOnce(); // 19:00 档（fetch 2）
    h.setTime('2026-09-10', 21, 50); // 21:50 ≥ 21:45 档、该档未补过 → 补拉（fetch 3）
    await h.task.runOnce();
    assert.equal(h.fetchCount(), 3);
    h.setTime('2026-09-10', 22, 20); // 双档均已记指纹 → 不再重拉
    await h.task.runOnce();
    assert.equal(h.fetchCount(), 3);
  } finally {
    await h.cleanup();
  }
});

test('runOnce({refreshHistory:true})：立即巡检强制重拉当日缓存（refreshAfterHour 之前也能拿到新净值）', async () => {
  const d1 = mkDates(6, '2026-09-09');
  const s1 = mkDates2Fix(d1, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const d2 = mkDates(7, '2026-09-10');
  const s2 = mkDates2Fix(d2, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1]);
  const h = await makeHarness({ seriesByCall: [s1, s2] });
  try {
    h.setTime('2026-09-10', 15);
    await h.task.runOnce(); // 缓存 15 点首拉（旧序列）
    h.setTime('2026-09-10', 18); // 还没到 refreshAfterHour，但用户点了「立即巡检」
    const r = await h.task.runOnce({ refreshHistory: true });
    assert.equal(r.evaluated, 1);
    assert.equal(r.events, 1); // 强制重拉拿到 09-10 净值 → 触发
    assert.equal(h.fetchCount(), 2);
    // 重拉结果回填缓存：随后的 status 直接复用，不产生第三次拉取
    await h.task.status();
    assert.equal(h.fetchCount(), 2);
  } finally {
    await h.cleanup();
  }
});

test('ack → status executed=true → 冷却窗口外自动失效；alerts 返回触发历史', async () => {
  const d1 = mkDates(6, '2026-09-09');
  const s1 = d1.map((d, i) => ({
    date: d,
    nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2][i],
    acc_nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2][i],
  }));
  const d2 = mkDates(7, '2026-09-10');
  const s2 = d2.map((d, i) => ({
    date: d,
    nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1][i],
    acc_nav: [1.0, 1.02, 1.04, 1.06, 1.08, 1.2, 1.1][i],
  }));
  const h = await makeHarness({ seriesByCall: [s1, s2] });
  try {
    await h.task.runOnce(); // 第一轮：峰值落盘
    h.setDay('2026-09-11');
    const r = await h.task.runOnce(); // 第二轮：止盈触发 → alerts 落盘
    assert.equal(r.events, 1);
    // 未 ack：徽章正常（executed=false）
    let st = (await h.task.status()).funds[0];
    assert.equal(st.state, 'TAKE_PROFIT');
    assert.equal(st.executed, false);
    // ack 已执行 → State Demotion（navDate 从持久态取实际净值日，避免日期字面量与 UTC 偏移错位）
    const ackNav = (await h.store.loadState()).funds['110020'].cooldowns.TAKE_PROFIT;
    await h.task.ack('110020', 'TAKE_PROFIT', ackNav);
    st = (await h.task.status()).funds[0];
    assert.equal(st.executed, true);
    assert.equal(st.executedInfo.day, 1);
    assert.equal(st.executedInfo.total, 5);
    // alerts 时间线数据
    const a = await h.task.alerts(20);
    assert.equal(a.total, 1);
    assert.equal(a.alerts[0].state, 'TAKE_PROFIT');
    assert.equal(a.alerts[0].trigger, 'trailing');
    assert.equal(a.alerts[0].configUsed._custom, false);
  } finally {
    await h.cleanup();
  }
});

test('runOnce：清仓归零 → 持久进度重置 + posShares=0 标记，重建仓后旧僵尸态不生效（4.3，P0 修复）', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = d.map((x, i) => ({
    date: x,
    nav: [1.0, 1.01, 1.02, 1.03, 1.04, 1.05][i],
    acc_nav: [1.0, 1.01, 1.02, 1.03, 1.04, 1.05][i],
  }));
  const clearedFund = {
    id: 'fund_b',
    asset_type: 'fund',
    name: '已清仓基金',
    code: '110020',
    snapshot: {
      hold_amount: 0,
      pending_amount: 0,
      cost_price: 1.0,
      hold_shares: 0,
      total_invested: 0,
    },
    transactions: [
      { id: 'tx1', type: 'buy', amount: 10000, shares: 10000, date: '2026-01-10' },
      { id: 'tx2', type: 'sell', amount: 9500, shares: 10000, date: '2026-03-01' },
    ],
    strategy_config: null,
  };
  const h = await makeHarness({ funds: [clearedFund], seriesByCode: { 110020: s } });
  try {
    // 预置旧仓位的僵尸持久态（若未重置：lastStopDate@idx1 + 其后收复再破位 → 会向新仓位误发 EXIT）
    await h.store.saveState({
      funds: {
        110020: {
          lastStopDate: d[1],
          hwmDate: d[3],
          consumedTiers: [15],
          cooldowns: { STOP_LOSS: d[1] },
          lastEvalNavDate: null,
        },
      },
    });
    const r1 = await h.task.runOnce();
    assert.equal(r1.evaluated, 0); // 清仓基金不评估，只重置进度
    let st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.posShares, 0); // 清仓标记（引擎重建仓兜底的依据）
    assert.equal(st.hwmDate, null);
    assert.equal(st.lastStopDate, null);
    assert.deepEqual(st.consumedTiers, []);
    // 重建仓（快照归零、由新交易建仓：10000 份 @1.00，现价 1.05 = +5% < 启动点）；db.save带乐观锁基线
    const cur = await h.db.load();
    await h.db.save(
      [
        {
          ...clearedFund,
          snapshot: {
            hold_amount: 0,
            pending_amount: 0,
            cost_price: 1.0,
            hold_shares: 0,
            total_invested: 0,
          },
          transactions: [
            { id: 'tx3', type: 'buy', amount: 10000, shares: 10000, date: '2026-09-01' },
          ],
        },
      ],
      cur.updated_at,
      [],
    );
    h.setDay('2026-09-11');
    const r2 = await h.task.runOnce();
    assert.equal(r2.evaluated, 1);
    assert.equal(r2.events, 0); // 无旧峰值虚算回撤、无旧破位链 EXIT
    st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.hwmDate ?? null, null); // +5% 未启动（键缺省 = 语义 null，读取时 fundState 补默认）
    assert.equal(st.lastStopDate ?? null, null);
    assert.equal(st.posShares, 10000); // 新仓位指纹落盘
  } finally {
    await h.cleanup();
  }
});

// ---- 通道 A 增量拉取 ----
import { depthOf } from '../../lib/strategyTask.js';

/** 本地时区 N 天前（避免 mkDates 的 UTC 移位） */
function daysAgo(n, endDate = '2026-09-10') {
  const d = new Date(endDate + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}

test('depthOf：自适应深度公式（6.1 等价简化）', () => {
  const today = '2026-09-10';
  assert.equal(depthOf({}, today), 80); // 无锚 → 基线 80
  assert.equal(depthOf({ hwmDate: daysAgo(30) }, today), 80); // 锚 30 天前 → 仍 80
  assert.equal(depthOf({ hwmDate: daysAgo(300) }, today), 300); // 锚 300 天前 → 300
  assert.equal(depthOf({ lastStopDate: daysAgo(500) }, today), 365); // 锚 500 天前 → 365 封顶
  assert.equal(depthOf(null, today), 80); // entry 为空安全访问
});

/** 拉取行为测试台：fetchHistory spy 记录 (code, days)；
 *  序列模拟真实形态：仅工作日有净值行（周末留空），缓存头通常早于锚（与lsjz交易日稀疏性一致） */
async function makeFetchHarness({ endDate = '2026-09-10' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'strategytask-fetch-'));
  const db = createDatabase({ dataDir: dir, now: () => new Date(endDate + 'T20:00:00') });
  await db.save([{ ...FUND }], null, []);
  const store = createStrategyStore({ dataDir: dir });
  const rows = [];
  for (let i = 510; i >= 0; i--) {
    const d = new Date('2026-09-20T00:00:00');
    d.setDate(d.getDate() - i);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue; // 周末无净值
    rows.push({ date: d.toLocaleDateString('sv-SE'), nav: 1.0, acc_nav: 1.0 });
  }
  const calls = [];
  let simNow = new Date(endDate + 'T20:00:00');
  // 数据源只返回当前时钟之前已存在的行（模拟真实接口：拿不到未来净值）
  const fetchHistory = async (code, days) => {
    calls.push({ code, days });
    const visible = rows.filter((r) => r.date <= simNow.toLocaleDateString('sv-SE'));
    return { series: visible.slice(-days) };
  };
  const task = createStrategyTask({
    db,
    strategyStore: store,
    fetchHistory,
    now: () => new Date(simNow),
    xirrFn: () => null,
  });
  return {
    task,
    calls,
    dir,
    setDay: (d) => {
      simNow = new Date(d + 'T20:00:00');
    },
    eval: (entry = {}) => task.evaluateFund({ ...FUND }, { 110020: entry }, { forStatus: true }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('增量拉取：无缓存首拉全 depth（80）；同日复用零新增请求', async () => {
  const h = await makeFetchHarness();
  try {
    const r1 = await h.eval({});
    assert.equal(r1.code, '110020');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].days, 80); // 无锚首拉 = 基线深度
    await h.eval({}); // 同日再次评估 → 复用缓存
    assert.equal(h.calls.length, 1); // 零新增请求（status 高频轮询不反复重拉）
  } finally {
    await h.cleanup();
  }
});

test('增量拉取：跨天尾部增量——只拉缺口 +5（非全量）', async () => {
  const h = await makeFetchHarness();
  try {
    await h.eval({});
    h.setDay('2026-09-11'); // 新的一天
    await h.eval({});
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].days, 6); // min(80, 缺口1天+5) = 6，绝不 365
  } finally {
    await h.cleanup();
  }
});

test('增量拉取：锚点日更自增不触发回补（缓存头在锚上=覆盖）', async () => {
  const h = await makeFetchHarness();
  try {
    const anchor100 = daysAgo(100);
    await h.eval({ hwmDate: anchor100 });
    assert.equal(h.calls[0].days, 100);
    h.setDay('2026-09-11'); // 自然日推移：daysSince 100→101，但缓存头（交易日稀疏、早于锚）已覆盖
    await h.eval({ hwmDate: anchor100 });
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].days, 6); // 尾部增量而非 101 全量（锚点覆盖判定）
  } finally {
    await h.cleanup();
  }
});

test('增量拉取：新锚超出缓存头 → 回补一次全 depth', async () => {
  const h = await makeFetchHarness();
  try {
    await h.eval({}); // 无锚 → 缓存 80 天
    const anchor200 = daysAgo(200);
    await h.eval({ hwmDate: anchor200 }); // 锚在 200 天前，缓存头（约 110 天前）晚于锚 → 回补
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].days, 200);
  } finally {
    await h.cleanup();
  }
});

test('增量拉取：超窗锚（>365 天）次日不再全量；depth 单调递增不降级', async () => {
  const h = await makeFetchHarness();
  try {
    const anchor500 = daysAgo(500);
    await h.eval({ lastStopDate: anchor500 });
    assert.equal(h.calls[0].days, 365); // 封顶
    h.setDay('2026-09-11');
    await h.eval({ lastStopDate: anchor500 });
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].days, 6); // cached.depth ≥ 365 → 覆盖，尾部增量（单调深度）
    h.setDay('2026-09-12');
    await h.eval({}); // 无锚（depth 收缩 80）→ 尾部增量
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].days, 6);
    await h.eval({ lastStopDate: anchor500 }); // 再遇超窗锚：cached.depth 仍为 365（单调）→ 同日复用、零新请求
    assert.equal(h.calls.length, 3); // 不触发全量也不触发尾部（缓存头已覆盖，收缩不降级）
  } finally {
    await h.cleanup();
  }
});

// ---- 人工纠偏通道路由 ----

test('ignore 路由：写标记 + 冷却锚推进，hwmDate 不动', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s] });
  try {
    await h.task.runOnce(); // 评估一轮：hwmDate 落盘 d[5]
    const r = await h.task.ignore('110020', 'TAKE_PROFIT', d[4]);
    assert.equal(r.ok, true);
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.ignore.state, 'TAKE_PROFIT');
    assert.equal(st.ignore.navDate, d[4]);
    assert.equal(st.cooldowns.TAKE_PROFIT, d[4]); // 冷却锚推进（"这轮已消化"）
    assert.equal(st.hwmDate, d[5]); // 忽略 ≠ 执行：峰值不动
  } finally {
    await h.cleanup();
  }
});

test('ack 清除同动作 ignore（已执行解除忽略残留）', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ seriesByCall: [s] });
  try {
    await h.task.runOnce();
    await h.task.ignore('110020', 'TAKE_PROFIT', d[4]);
    await h.task.ack('110020', 'TAKE_PROFIT', d[5]);
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.ignore, null);
    assert.ok(st.ack);
  } finally {
    await h.cleanup();
  }
});

test('resetTiers：单档/全量/幂等/tier 类型校验', async () => {
  const h = await makeHarness({});
  try {
    const st0 = await h.store.loadState();
    st0.funds['110020'] = { consumedTiers: [15, 20] };
    await h.store.saveState(st0);
    let r = await h.task.resetTiers('110020', 15);
    assert.deepEqual(r.consumedTiers, [20]);
    r = await h.task.resetTiers('110020', 15); // 幂等：不在列表仍 200 不报错
    assert.deepEqual(r.consumedTiers, [20]);
    await assert.rejects(() => h.task.resetTiers('110020', '15%'), /invalid_tier/);
    await assert.rejects(() => h.task.resetTiers('110020', 0.15), /invalid_tier/);
    r = await h.task.resetTiers('110020'); // 全重置
    assert.deepEqual(r.consumedTiers, []);
  } finally {
    await h.cleanup();
  }
});

test('correctReserve：严格校验（类型/未启用/比例缺基准/越界）+ 锚初始化', async () => {
  const cfgAdd = { addEnabled: true, reserveCash: 2000, reserveCap: 0.5 };
  const d21 = mkDates(6, '2026-09-10');
  const s21 = mkDates2Fix(d21, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ config: cfgAdd, seriesByCall: [s21] });
  try {
    // 未评估：配置了比例但 reserveBase 缺失 → 拒绝（防定额击穿底仓比例）
    await assert.rejects(() => h.task.correctReserve('110020', 500), /reserve_base_not_ready/);
    // 类型守卫
    await assert.rejects(() => h.task.correctReserve('110020', '500'), /invalid_reserve_used/);
    await assert.rejects(() => h.task.correctReserve('110020', NaN), /invalid_reserve_used/);
    // 评估一轮（落盘 reserveBase/lastEvalNavDate）后成功
    await h.task.runOnce();
    const r = await h.task.correctReserve('110020', 1200);
    assert.equal(r.reserveUsed, 1200);
    assert.equal(r.cap, 2000); // min(2000, 10000×0.5)
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.reserveUsed, 1200);
    assert.ok(st.reserveUsedAsOf); // 锚已初始化
    // 越界 → 抛错带 cap（严格校验不静默钳制）
    await assert.rejects(
      () => h.task.correctReserve('110020', 99999),
      (e) => /out_of_cap/.test(e.message) && e.cap === 2000,
    );
    await assert.rejects(() => h.task.correctReserve('110020', -1), /out_of_cap/);
  } finally {
    await h.cleanup();
  }
});

test('correctReserve：仅定额（无比例）可即时纠偏，锚为空降级本地自然日；未启用加仓拒绝', async () => {
  const h = await makeHarness({ config: { addEnabled: true, reserveCash: 1500 } });
  try {
    const r = await h.task.correctReserve('110020', 1000);
    assert.equal(r.cap, 1500);
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.reserveUsed, 1000);
    assert.equal(st.reserveUsedAsOf, '2026-09-10'); // 锚为空 → 降级本地自然日 today（非 UTC）
  } finally {
    await h.cleanup();
  }
  const h2 = await makeHarness({ config: { addEnabled: false, reserveCash: 1500 } });
  try {
    await assert.rejects(() => h2.task.correctReserve('110020', 1000), /add_not_enabled/); // 曾设定额但已停用 → 拒绝
  } finally {
    await h2.cleanup();
  }
});

test('status：人工纠偏四字段下发（ignored 恒布尔/reserveUsed/cap/consumedTiers）', async () => {
  const cfgAdd = { addEnabled: true, reserveCash: 2000, reserveCap: 0.5 };
  const d23 = mkDates(6, '2026-09-10');
  const s23 = mkDates2Fix(d23, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  const h = await makeHarness({ config: cfgAdd, seriesByCall: [s23] });
  try {
    await h.task.runOnce();
    await h.task.correctReserve('110020', 800);
    const st0 = await h.store.loadState();
    st0.funds['110020'] = { ...st0.funds['110020'], consumedTiers: [15] };
    await h.store.saveState(st0);
    const payload = await h.task.status();
    const f = payload.funds[0];
    assert.equal(f.ignored, false); // 恒布尔
    assert.equal(f.reserveUsed, 800);
    assert.equal(f.cap, 2000);
    assert.deepEqual(f.consumedTiers, [15]);
  } finally {
    await h.cleanup();
  }
});

// ---- mergeSeries 内容断言 ----
import { mergeSeries } from '../../lib/strategyTask.js';

test('mergeSeries：合并去重（新值覆盖旧值）+ 升序 + slice(-365) 截断', () => {
  // 去重与覆盖：同 date 新值胜出
  const cached = [
    { date: '2026-09-01', nav: 1.0 },
    { date: '2026-09-02', nav: 1.1 },
  ];
  const fresh = [
    { date: '2026-09-02', nav: 1.2 },
    { date: '2026-09-03', nav: 1.3 },
  ];
  const m1 = mergeSeries(cached, fresh);
  assert.deepEqual(m1, [
    { date: '2026-09-01', nav: 1.0 },
    { date: '2026-09-02', nav: 1.2 }, // 新值覆盖
    { date: '2026-09-03', nav: 1.3 },
  ]);
  // 升序（乱序输入）
  const m2 = mergeSeries([{ date: '2026-09-03', nav: 1.3 }], [{ date: '2026-09-01', nav: 1.0 }]);
  assert.deepEqual(
    m2.map((r) => r.date),
    ['2026-09-01', '2026-09-03'],
  );
  // slice(-365)：超 365 条截断保留最后 365
  const big = Array.from({ length: 400 }, (_, i) => {
    const d = new Date('2025-01-01T00:00:00');
    d.setDate(d.getDate() + i);
    return { date: d.toLocaleDateString('sv-SE'), nav: i };
  });
  const m3 = mergeSeries(big, []);
  assert.equal(m3.length, 365);
  assert.equal(m3[0].nav, 35); // 保留最后 365 条（400-365=35 起）
  // 空数组安全
  assert.deepEqual(mergeSeries([], []), []);
});

// ---- ack/ignore/reset-tiers/correct-reserve 与巡检读改写竞态（并发防线）----

/** 竞态测试台：fetchHistory 挂起至测试放行，模拟 runOnce 评估进行中与并发路由落盘 */
async function makeRaceHarness({ config = null, funds = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'strategytask-race-'));
  const db = createDatabase({ dataDir: dir, now: () => new Date('2026-09-10T20:00:00') });
  await db.save(funds ?? [{ ...FUND, strategy_config: config }], null, []);
  const store = createStrategyStore({ dataDir: dir });
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.02, 1.04, 1.06, 1.08, 1.2]);
  let release;
  const gate = new Promise((res) => {
    release = res;
  });
  const task = createStrategyTask({
    db,
    strategyStore: store,
    fetchHistory: async () => {
      await gate;
      return { series: s };
    },
    now: () => new Date('2026-09-10T20:00:00'),
    xirrFn: () => null,
  });
  return {
    db,
    store,
    task,
    d,
    dir,
    release: () => release(),
    settle: () => new Promise((r) => setTimeout(r, 10)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('并发防线：runOnce 评估挂起期间 ack 落盘 → saveState 不回退 ack，引擎字段照常落盘', async () => {
  const h = await makeRaceHarness();
  try {
    const running = h.task.runOnce(); // 不 await：评估挂起在 fetchHistory
    await h.settle(); // 等 runOnce 越过 loadState 进入拉取挂起
    await h.task.ack('110020', 'TAKE_PROFIT', h.d[5]); // 并发落盘 ack
    h.release();
    const r = await running;
    assert.equal(r.evaluated, 1);
    const st = (await h.store.loadState()).funds['110020'];
    assert.ok(st.ack, '并发 ack 不得被 runOnce 的 saveState 整包回退');
    assert.equal(st.ack.state, 'TAKE_PROFIT');
    assert.equal(st.hwmDate, h.d[5]); // 本轮引擎计算字段照常落盘
    assert.equal(st.lastEvalNavDate, h.d[5]);
  } finally {
    await h.cleanup();
  }
});

test('并发防线：ignore 并发落盘 → ignore 标记与冷却锚合并回（hwmDate 不动）', async () => {
  const h = await makeRaceHarness();
  try {
    const running = h.task.runOnce();
    await h.settle();
    await h.task.ignore('110020', 'TAKE_PROFIT', h.d[5]);
    h.release();
    await running;
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.ignore?.state, 'TAKE_PROFIT');
    assert.equal(st.cooldowns.TAKE_PROFIT, h.d[5]); // ignore 的冷却锚推进不被回退
    assert.equal(st.hwmDate, h.d[5]); // 忽略 ≠ 执行：峰值照常
  } finally {
    await h.cleanup();
  }
});

test('并发防线：resetTiers 并发落盘 → 重置后的消耗位不被回退', async () => {
  const h = await makeRaceHarness();
  try {
    const st0 = await h.store.loadState();
    st0.funds['110020'] = { consumedTiers: [15, 20] };
    await h.store.saveState(st0);
    const running = h.task.runOnce();
    await h.settle();
    await h.task.resetTiers('110020', 15); // 并发：清掉 15
    h.release();
    await running;
    const st = (await h.store.loadState()).funds['110020'];
    assert.deepEqual(st.consumedTiers, [20]); // runOnce 不得用开工快照 [15,20] 整包覆盖（须差分合并）
  } finally {
    await h.cleanup();
  }
});

test('并发防线：correctReserve 并发落盘 → 校正的 reserveUsed 不被回退', async () => {
  const h = await makeRaceHarness({ config: { addEnabled: true, reserveCash: 1500 } });
  try {
    const running = h.task.runOnce();
    await h.settle();
    await h.task.correctReserve('110020', 1000); // 并发：手动校正（无比例仅定额，可即时纠偏）
    h.release();
    await running;
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.reserveUsed, 1000); // 校正结果不被巡检整包覆盖回 0
    assert.ok(st.reserveUsedAsOf);
  } finally {
    await h.cleanup();
  }
});

test('并发防线：并发路由为未被巡检处理的基金新建条目 → 条目整体带入不丢', async () => {
  // 基金B零持仓且无持久态：runOnce跳过评估也不写状态；并发ack写入的条目若不带入将被saveState丢弃
  const funds = [
    { ...FUND },
    {
      id: 'fund_b',
      asset_type: 'fund',
      name: '已清仓基金',
      code: '110022',
      snapshot: {
        hold_amount: 0,
        pending_amount: 0,
        cost_price: 1,
        hold_shares: 0,
        total_invested: 0,
      },
      transactions: [],
      strategy_config: null,
    },
  ];
  const h = await makeRaceHarness({ funds });
  try {
    const running = h.task.runOnce();
    await h.settle();
    await h.task.ack('110022', 'EXIT', h.d[5]); // 并发：给无状态基金写 ack（条目新建）
    h.release();
    await running;
    const st = (await h.store.loadState()).funds;
    assert.equal(st['110022']?.ack?.state, 'EXIT'); // 并发新建条目不得被 saveState 整包丢弃
  } finally {
    await h.cleanup();
  }
});

test('并发防线：手工构造裸条目缺 cooldowns 键 + 并发路由写冷却锚 → 巡检不炸且锚合并', async () => {
  // 坏配置基金：评估被跳过、store 保留手工构造的裸条目（缺 cooldowns 键，防手工编辑路径）
  const badFund = {
    ...FUND,
    id: 'fund_bad',
    code: '161017',
    strategy_config: { trailing: { startProfit: 0.08, drawdownThreshold: 0.08 } },
  }; // 违反安全垫 → 引擎 throw
  const h = await makeRaceHarness({ funds: [badFund] });
  try {
    await h.store.saveState({ funds: { 161017: { lastEvalNavDate: '2026-02-01' } } }); // 手工构造：无 cooldowns
    const running = h.task.runOnce();
    await h.settle();
    await h.task.ignore('161017', 'TAKE_PROFIT', h.d[5]); // 并发：写入冷却锚
    h.release();
    await running; // 合并循环须容忍缺 cooldowns 字段的旧条目（不得 TypeError 拖垮整轮巡检）
    const st = (await h.store.loadState()).funds['161017'];
    assert.equal(st.cooldowns?.TAKE_PROFIT, h.d[5]); // 锚合并进裸条目
    assert.equal(st.ignore?.state, 'TAKE_PROFIT');
  } finally {
    await h.cleanup();
  }
});

// ---- 雷达冷却持久化（服务重启不失效） ----

test('49 雷达冷却持久化：服务重启（新任务实例重读磁盘）后同级别仍不重复提示', async () => {
  const d = mkDates(8, '2026-09-10');
  const s = mkDates2Fix(d, [2.0, 2.0, 2.0, 2.0, 2.0, 1.98, 1.94, 1.89]); // 末 5 净值日跌 5.5% → 黄灯
  const h = await makeHarness({ seriesByCode: { 110020: s } }); // 按码返回同一序列：重启后的新实例重拉也能拿到
  try {
    await h.task.runOnce();
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.cooldowns.RADAR, d[7]); // 触发轮落盘冷却锚
    assert.equal(st.radarLevel, 'yellow');
    // 模拟服务重启：新任务实例（histCache 清空、持久态从磁盘重读）
    const task2 = createStrategyTask({
      db: h.db,
      strategyStore: h.store,
      fetchHistory: h.fetchHistory,
      now: () => new Date('2026-09-10T20:00:00'),
      xirrFn: () => null,
    });
    const payload = await task2.status();
    const r = payload.funds[0].radar;
    assert.equal(r.level, 'yellow');
    assert.equal(r.active, false); // 磁盘冷却锚生效：不重复提示
    assert.equal(r.suppressed, true);
  } finally {
    await h.cleanup();
  }
});

// ---- 清仓残余窗口用交易记录闭合 ----
import { hasLiquidationAfter } from '../../lib/strategyTask.js';

test('hasLiquidationAfter：交易回放检测 afterDate 之后的份额归零卖出（单元）', () => {
  const snap = { total_invested: 0, hold_shares: 0, cost_price: 1 };
  const tx = (type, shares, date) => ({ type, shares, date, amount: shares });
  // 全清仓发生在 afterDate 之后 → true
  assert.equal(
    hasLiquidationAfter(
      snap,
      [tx('buy', 10000, '2026-01-10'), tx('sell', 10000, '2026-03-01')],
      '2026-02-01',
    ),
    true,
  );
  // 部分卖出（未归零）→ false
  assert.equal(
    hasLiquidationAfter(
      snap,
      [tx('buy', 10000, '2026-01-10'), tx('sell', 5000, '2026-03-01')],
      '2026-02-01',
    ),
    false,
  );
  // 归零发生在 afterDate 当日及之前 → false（只看"之后"）
  assert.equal(
    hasLiquidationAfter(
      snap,
      [tx('buy', 10000, '2026-01-10'), tx('sell', 10000, '2026-01-15')],
      '2026-02-01',
    ),
    false,
  );
  // afterDate 为空 → false（从未评估过，无从谈"之后"）
  assert.equal(
    hasLiquidationAfter(
      snap,
      [tx('buy', 10000, '2026-01-10'), tx('sell', 10000, '2026-03-01')],
      null,
    ),
    false,
  );
  // 红利再投不清零
  assert.equal(
    hasLiquidationAfter(
      snap,
      [
        tx('buy', 10000, '2026-01-10'),
        { type: 'dividend', method: 'reinvest', shares: 100, date: '2026-03-01' },
      ],
      '2026-02-01',
    ),
    false,
  );
});

test('runOnce：清仓残余窗口闭合——lastEvalNavDate 之后份额归零（服务器关机错过巡检）→ 重建仓本轮重置并照常评估', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.01, 1.02, 1.03, 1.04, 1.05]);
  const rebuiltFund = {
    id: 'fund_c',
    asset_type: 'fund',
    name: '重建仓基金',
    code: '110020',
    snapshot: {
      hold_amount: 0,
      pending_amount: 0,
      cost_price: 1.0,
      hold_shares: 0,
      total_invested: 0,
    },
    transactions: [
      { id: 'tx1', type: 'buy', amount: 10000, shares: 10000, date: '2026-01-10' },
      { id: 'tx2', type: 'sell', amount: 9500, shares: 10000, date: '2026-03-01' }, // 全清仓：服务器关机期间，巡检从未见过零持仓
      { id: 'tx3', type: 'buy', amount: 10000, shares: 10000, date: '2026-09-01' }, // 重建仓
    ],
    strategy_config: null,
  };
  const h = await makeHarness({ funds: [rebuiltFund], seriesByCode: { 110020: s } });
  try {
    // 预置旧仓位僵尸持久态：lastEvalNavDate 停在清仓前，破位链/峰值/消耗位齐全
    await h.store.saveState({
      funds: {
        110020: {
          lastStopDate: '2026-01-20',
          hwmDate: '2026-01-15',
          consumedTiers: [15],
          cooldowns: { STOP_LOSS: '2026-01-20' },
          lastEvalNavDate: '2026-02-01',
        },
      },
    });
    const r = await h.task.runOnce();
    assert.equal(r.evaluated, 1); // 清仓后的僵尸态不得直接参与评估
    assert.equal(r.events, 0); // 无僵尸 EXIT/TAKE_PROFIT
    const st = (await h.store.loadState()).funds['110020'];
    assert.equal(st.posShares, 10000); // 新仓位指纹
    assert.equal(st.lastStopDate ?? null, null);
    assert.equal(st.hwmDate ?? null, null); // +5% < 8% 未启动
    assert.deepEqual(st.consumedTiers ?? [], []); // 重建仓兜底清零（键缺省 = 语义空，读取时 fundState 补默认）
    assert.equal(st.lastEvalNavDate, d[5]); // 本轮照常推进幂等锚
  } finally {
    await h.cleanup();
  }
});

test('runOnce：部分卖出（份额未归零）不触发清仓重置——旧锚照常存续（防误伤）', async () => {
  const d = mkDates(6, '2026-09-10');
  const s = mkDates2Fix(d, [1.0, 1.01, 1.02, 1.03, 1.04, 1.05]);
  const partialFund = {
    id: 'fund_d',
    asset_type: 'fund',
    name: '部分卖出基金',
    code: '110020',
    snapshot: {
      hold_amount: 0,
      pending_amount: 0,
      cost_price: 1.0,
      hold_shares: 0,
      total_invested: 0,
    },
    transactions: [
      { id: 'tx1', type: 'buy', amount: 10000, shares: 10000, date: '2026-01-10' },
      { id: 'tx2', type: 'sell', amount: 5000, shares: 5000, date: '2026-03-01' }, // 部分卖出
      { id: 'tx3', type: 'buy', amount: 2000, shares: 2000, date: '2026-09-01' },
    ],
    strategy_config: null,
  };
  const h = await makeHarness({ funds: [partialFund], seriesByCode: { 110020: s } });
  try {
    await h.store.saveState({
      funds: { 110020: { consumedTiers: [15], lastEvalNavDate: '2026-02-01' } },
    });
    const r = await h.task.runOnce();
    assert.equal(r.evaluated, 1);
    const st = (await h.store.loadState()).funds['110020'];
    assert.deepEqual(st.consumedTiers, [15]); // 未重置：旧消耗位照常存续
    assert.equal(st.posShares, 7000); // 新仓位指纹 = 10000 − 5000 + 2000
  } finally {
    await h.cleanup();
  }
});
