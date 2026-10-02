import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inSnapshotWindow,
  nextSnapshotWindowStart,
  computeArrivalEntries,
  createSnapshotTask,
} from '../../lib/snapshot.js';
import { createDatabase, ConflictError } from '../../lib/database.js';

// 2026-08-31 是周一（2026-01-01 周四起算）
const mon10 = new Date(2026, 7, 31, 10, 0);
const mon1459 = new Date(2026, 7, 31, 14, 59, 59);
const mon15 = new Date(2026, 7, 31, 15, 0);
const mon2359 = new Date(2026, 7, 31, 23, 59, 59);
const fri16 = new Date(2026, 7, 28, 16, 0);
const sat10 = new Date(2026, 7, 29, 10, 0);
const sun12 = new Date(2026, 7, 30, 12, 0);

const A = {
  id: 'fund_a',
  asset_type: 'fund',
  name: '基金A',
  code: '110020',
  snapshot: {
    hold_amount: 1100,
    pending_amount: 0,
    cost_price: 10,
    hold_shares: 100,
    total_invested: 1000,
  },
  transactions: [{ id: 'tx1', type: 'buy', amount: 200, shares: 20, date: '2026-08-20' }],
};
const B = {
  id: 'fund_b',
  asset_type: 'fund',
  name: '基金B',
  code: '161017',
  snapshot: {
    hold_amount: 520,
    pending_amount: 0,
    cost_price: 10,
    hold_shares: 50,
    total_invested: 500,
  },
  transactions: [],
};
const QA = { code: '110020', nav: 1.5, nav_date: '2026-08-31', prev_nav: 1.4, estimate: null };
const QB = { code: '161017', nav: 2.0, nav_date: '2026-08-31', prev_nav: 1.9, estimate: null };

// ---- 窗口与调度时刻 ----

test('inSnapshotWindow：工作日 15:00–24:00 为窗口期', () => {
  assert.equal(inSnapshotWindow(mon10), false);
  assert.equal(inSnapshotWindow(mon1459), false);
  assert.equal(inSnapshotWindow(mon15), true);
  assert.equal(inSnapshotWindow(mon2359), true);
  assert.equal(inSnapshotWindow(fri16), true);
  assert.equal(inSnapshotWindow(sat10), false);
  assert.equal(inSnapshotWindow(sun12), false);
});

test('nextSnapshotWindowStart：取严格晚于当前时刻的下个工作日 15:00', () => {
  assert.deepEqual(nextSnapshotWindowStart(mon10), mon15); // 今天还没到 15 点 → 今天 15 点
  assert.deepEqual(
    nextSnapshotWindowStart(new Date(2026, 7, 31, 15, 0)),
    new Date(2026, 8, 1, 15, 0),
  ); // 恰好 15 点 → 下个工作日
  assert.deepEqual(nextSnapshotWindowStart(fri16), new Date(2026, 7, 31, 15, 0)); // 周五午后 → 下周一
  assert.deepEqual(nextSnapshotWindowStart(sat10), new Date(2026, 7, 31, 15, 0)); // 周六 → 下周一
  assert.deepEqual(nextSnapshotWindowStart(sun12), new Date(2026, 7, 31, 15, 0)); // 周日 → 次日（周一）
});

// ---- 到账候选计算 ----

test('computeArrivalEntries：确认口径的逐基金到账候选（本金/份额/市值）', () => {
  // A：份额 100 + 20 = 120 → 收益 120 × (1.5−1.4) = 12；本金 1000+200=1200；市值 120×1.5=180
  // B：份额 50 → 收益 50 × (2.0−1.9) = 5；本金 500；市值 100
  const entries = computeArrivalEntries([A, B], { 110020: QA, 161017: QB });
  assert.deepEqual(entries, [
    {
      code: '110020',
      navDate: '2026-08-31',
      earnings: 12,
      invested: 1200,
      assets: 180,
      qdii: false,
    },
    { code: '161017', navDate: '2026-08-31', earnings: 5, invested: 500, assets: 100, qdii: false },
  ]);
});

test('computeArrivalEntries：缺行情/缺净值日期/缺前一日净值/零份额 → 跳过该基金', () => {
  assert.deepEqual(computeArrivalEntries([A, B], { 110020: QA }), [
    {
      code: '110020',
      navDate: '2026-08-31',
      earnings: 12,
      invested: 1200,
      assets: 180,
      qdii: false,
    },
  ]); // B 缺行情
  assert.deepEqual(computeArrivalEntries([A], { 110020: { ...QA, nav_date: null } }), []);
  assert.deepEqual(computeArrivalEntries([A], { 110020: { ...QA, prev_nav: null } }), []); // 无前一日净值算不出变动
  const zero = { ...A, transactions: [], snapshot: { ...A.snapshot, hold_shares: 0 } };
  assert.deepEqual(computeArrivalEntries([zero], { 110020: QA }), []); // 零份额不入账
  assert.deepEqual(computeArrivalEntries([{ ...A, asset_type: 'gold_etf' }], { 110020: QA }), []); // 非基金品类过滤
});

// ---- 任务 runOnce（真实 database + 假行情 + 假时钟）----

async function makeTask({
  assets = [A, B],
  quotes = { 110020: QA, 161017: QB },
  today = new Date(2026, 7, 31, 16, 0),
  isTradingDay = async () => true,
  fetchHolidays = async () => new Set(),
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fund-arr-'));
  const db = createDatabase({ dataDir: dir });
  if (assets) await db.save(assets, null, []);
  const logs = [];
  const calls = [];
  const fetchQuotes = async (codes) => {
    calls.push(codes);
    return {
      quotes: codes.map((c) => quotes[c]).filter(Boolean),
      errors: codes.filter((c) => !quotes[c]).map((c) => ({ code: c, error: 'boom' })),
    };
  };
  const task = createSnapshotTask({
    db,
    fetchQuotes,
    now: () => today,
    isTradingDay,
    fetchHolidays,
    log: (m) => logs.push(m),
  });
  return { db, logs, calls, task, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('runOnce：QDII 到账日节假日感知（fetchHolidays 注入）——节前净值记节后首个交易日', async () => {
  const qdiiA = { ...A, name: '演示全球精选(QDII)C' };
  const holidays = new Set([
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
  ]);
  const h = await makeTask({
    assets: [qdiiA],
    quotes: { 110020: { ...QA, nav_date: '2026-09-30' } },
    fetchHolidays: async () => holidays,
  });
  try {
    await h.task.runOnce();
    const { data } = await h.db.load();
    assert.equal(data.daily.length, 1);
    assert.equal(data.daily[0].date, '2026-10-08'); // 假期不算工作日，到账日记节后首个交易日
  } finally {
    await h.cleanup();
  }
});

test('runOnce：行情齐全时按当天到账日入账', async () => {
  const h = await makeTask();
  try {
    await h.task.runOnce();
    const { data } = await h.db.load();
    assert.deepEqual(data.daily, [
      {
        code: '110020',
        date: '2026-08-31',
        navDate: '2026-08-31',
        earnings: 12,
        invested: 1200,
        assets: 180,
      },
      {
        code: '161017',
        date: '2026-08-31',
        navDate: '2026-08-31',
        earnings: 5,
        invested: 500,
        assets: 100,
      },
    ]);
    assert.match(h.logs[0], /新增 2 条到账记录/);
  } finally {
    await h.cleanup();
  }
});

test('runOnce：净值日期未推进时重复执行不重复入账', async () => {
  const h = await makeTask();
  try {
    await h.task.runOnce();
    const before = (await h.db.load()).updated_at;
    await h.task.runOnce();
    const after = (await h.db.load()).updated_at;
    assert.equal(after, before);
  } finally {
    await h.cleanup();
  }
});

test('runOnce：标准到账日（口径 A）——国内=净值日、QDII=下一工作日', async () => {
  // 9.3（周四）拉到 9.2（周三）净值：国内 A 到账 9.2；QDII B（名称含 QDII 才识别）到账 9.3
  const h = await makeTask({
    assets: [A, { ...B, name: '基金B(QDII)' }],
    quotes: {
      110020: { ...QA, nav_date: '2026-09-02', prev_nav: 1.3 },
      161017: { ...QB, nav_date: '2026-09-02', prev_nav: 1.85 },
    },
    today: new Date(2026, 8, 3, 16, 0),
  });
  try {
    await h.task.runOnce();
    const { data } = await h.db.load();
    assert.equal(data.daily.length, 2);
    const byCode = Object.fromEntries(data.daily.map((r) => [r.code, r]));
    assert.equal(byCode['110020'].date, '2026-09-02'); // 国内 = 净值日
    assert.equal(byCode['161017'].date, '2026-09-03'); // QDII = 下一工作日（9.2 周三 → 9.3 周四）
    assert.ok(data.daily.every((r) => r.navDate === '2026-09-02')); // 净值日期保持 9.2
  } finally {
    await h.cleanup();
  }
});

test('runOnce：有基金行情失败时跳过该基金并记日志', async () => {
  const h = await makeTask({ quotes: { 110020: QA } });
  try {
    await h.task.runOnce();
    const { data } = await h.db.load();
    assert.equal(data.daily.length, 1);
    assert.equal(data.daily[0].code, '110020');
    assert.match(h.logs[0], /161017/);
  } finally {
    await h.cleanup();
  }
});

test('runOnce：无基金持仓时不请求行情', async () => {
  const h = await makeTask({ assets: [], quotes: {} });
  try {
    await h.task.runOnce();
    assert.equal(h.calls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('start：先补漏跑一轮再进入定时循环，返回 stop 可清理', async () => {
  const h = await makeTask();
  try {
    const stop = await h.task.start();
    assert.equal(typeof stop, 'function');
    assert.equal(h.calls.length, 1); // 启动补漏发起了行情请求
    stop();
  } finally {
    await h.cleanup();
  }
});

test('start：非交易日（节假日）启动仍先补漏一轮——到账日本义是实际拉取日', async () => {
  // 今天 10-01 非交易日，明天 10-02 是交易日（调度睡到下个交易日，不无限循环）
  const h = await makeTask({
    isTradingDay: async (d) => d !== '2026-10-01',
    today: new Date(2026, 9, 1, 16, 0),
  });
  try {
    const stop = await h.task.start();
    assert.equal(h.calls.length, 1); // 补漏不受交易日闸门限制
    stop();
  } finally {
    await h.cleanup();
  }
});

test('runOnce：乐观锁冲突（页面在写）→ 记日志跳过，不抛错', async () => {
  const fakeDb = {
    load: async () => ({ data: { version: 1, assets: [A], daily: [] }, updated_at: null }),
    save: async () => {
      throw new ConflictError('t');
    },
  };
  const logs = [];
  const task = createSnapshotTask({
    db: fakeDb,
    fetchQuotes: async () => ({ quotes: [QA], errors: [] }),
    now: () => new Date(2026, 7, 31, 16, 0),
    log: (m) => logs.push(m),
  });
  await task.runOnce(); // 不应抛错
  assert.match(logs[0], /页面正在写入/);
});
