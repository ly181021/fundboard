import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, ConflictError } from '../../lib/database.js';

const ASSETS = [
  {
    id: 'fund_001',
    asset_type: 'fund',
    name: '演示沪深300联接A',
    code: '110020',
    snapshot: {
      hold_amount: 10466,
      pending_amount: 0,
      cost_price: 1.0515,
      hold_shares: 9953.4,
      total_invested: 10000,
    },
    transactions: [],
  },
];

/** 真实临时目录 + 可推进的假时钟 */
async function makeDb({ backupKeep = 30, startAt = '2026-08-30T10:00:00' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fund-db-'));
  let t = new Date(startAt);
  const db = createDatabase({
    dataDir: dir,
    backupKeep,
    now: () => t,
  });
  return {
    dir,
    db,
    setNow(s) {
      t = new Date(s);
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('load：无 db.json 时返回空库', async () => {
  const h = await makeDb();
  try {
    const r = await h.db.load();
    assert.deepEqual(r.data, {
      version: 1,
      schemaVersion: 1,
      assets: [],
      daily: [],
      ai_log: [],
      corrections: [],
    });
    assert.equal(r.updated_at, null);
  } finally {
    await h.cleanup();
  }
});

test('schemaVersion 继承：库中非默认版本不被保存降级，load 透传返回（升版只归服务端迁移代码）', async () => {
  const h = await makeDb();
  try {
    // 模拟未来迁移后的库（schemaVersion 2）
    const dbPath = join(h.dir, 'db.json');
    await writeFile(
      dbPath,
      JSON.stringify({
        version: 1,
        schemaVersion: 2,
        assets: ASSETS,
        daily: [],
        ai_log: [],
        updated_at: '2026-08-30T08:00:00.000Z',
      }),
    );
    const r1 = await h.db.load();
    assert.equal(r1.data.schemaVersion, 2); // load 透传——迁移逻辑据此分派
    const r2 = await h.db.save(ASSETS, r1.updated_at, [], []);
    assert.ok(r2.ok);
    const raw = JSON.parse(await readFile(dbPath, 'utf8'));
    assert.equal(raw.schemaVersion, 2); // save 继承现值——前端 PUT 不携带该字段，不得静默降级
  } finally {
    await h.cleanup();
  }
});

test('save → load 往返一致，文件含 version/assets/daily/updated_at', async () => {
  const h = await makeDb();
  try {
    const r = await h.db.save(ASSETS, null);
    assert.equal(r.ok, true);
    assert.ok(r.updated_at);
    const back = await h.db.load();
    assert.deepEqual(back.data.assets, ASSETS);
    assert.equal(back.data.version, 1);
    assert.deepEqual(back.data.daily, []);
    assert.equal(back.updated_at, r.updated_at);
    const raw = JSON.parse(await readFile(join(h.dir, 'db.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.ok(raw.updated_at);
    // 原子写不留临时文件
    const files = await readdir(h.dir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
  } finally {
    await h.cleanup();
  }
});

test('save：结构校验拒绝非法数据', async () => {
  const h = await makeDb();
  try {
    await assert.rejects(() => h.db.save('nope', null), /invalid_assets/);
    await assert.rejects(() => h.db.save([{ id: 'x' }], null), /invalid_assets/); // 缺 asset_type/code/snapshot
  } finally {
    await h.cleanup();
  }
});

test('save：快照数值字段为 null/缺失（NaN 序列化结果）→ 拒绝', async () => {
  const h = await makeDb();
  try {
    const noInvested = [
      { ...ASSETS[0], snapshot: { ...ASSETS[0].snapshot, total_invested: null } },
    ];
    await assert.rejects(() => h.db.save(noInvested, null), /invalid_assets/);
    const noShares = [{ ...ASSETS[0], snapshot: { ...ASSETS[0].snapshot, hold_shares: null } }];
    await assert.rejects(() => h.db.save(noShares, null), /invalid_assets/);
  } finally {
    await h.cleanup();
  }
});

test('乐观锁：baseUpdatedAt 与服务端不符 → ConflictError（带 serverUpdatedAt）', async () => {
  const h = await makeDb();
  try {
    const first = await h.db.save(ASSETS, null);
    await assert.rejects(
      () => h.db.save(ASSETS, '2020-01-01T00:00:00.000Z'),
      (e) => e instanceof ConflictError && e.serverUpdatedAt === first.updated_at,
    );
    // 正确的 baseUpdatedAt 可写（推进时钟，updated_at 变化）
    h.setNow('2026-08-30T11:00:00');
    const second = await h.db.save(ASSETS, first.updated_at);
    assert.equal(second.ok, true);
    assert.notEqual(second.updated_at, first.updated_at);
  } finally {
    await h.cleanup();
  }
});

test('每日备份：跨天写入触发备份（按生成日命名），同天重复写不重复备份', async () => {
  const h = await makeDb();
  try {
    await h.db.save(ASSETS, null); // 首次写入（无旧文件，不备份）
    h.setNow('2026-08-31T10:00:00');
    await h.db.save(ASSETS, (await h.db.load()).updated_at); // 跨天首次写入 → 备份旧文件
    let files = await readdir(join(h.dir, 'backups'));
    assert.deepEqual(files.sort(), ['db-2026-08-31.json']);
    const bak = JSON.parse(await readFile(join(h.dir, 'backups', 'db-2026-08-31.json'), 'utf8'));
    assert.deepEqual(bak.assets, ASSETS); // 备份的是被覆盖前的旧版本
    await h.db.save(ASSETS, (await h.db.load()).updated_at); // 同天再写 → 不新增备份
    files = await readdir(join(h.dir, 'backups'));
    assert.deepEqual(files.sort(), ['db-2026-08-31.json']);
  } finally {
    await h.cleanup();
  }
});

test('备份保留数量：超出 backupKeep 的最老备份被清理', async () => {
  const h = await makeDb({ backupKeep: 2 });
  try {
    await h.db.save(ASSETS, null);
    const days = ['2026-08-28', '2026-08-29', '2026-08-30'];
    for (const day of days) {
      h.setNow(`${day}T10:00:00`);
      await h.db.save(ASSETS, (await h.db.load()).updated_at);
    }
    const files = (await readdir(join(h.dir, 'backups'))).sort();
    assert.deepEqual(files, ['db-2026-08-29.json', 'db-2026-08-30.json']);
  } finally {
    await h.cleanup();
  }
});

test('save：daily 预留区透传保存，未提供时保留旧值', async () => {
  const h = await makeDb();
  try {
    await h.db.save(ASSETS, null, [{ date: '2026-08-30', total_assets: 34170 }]);
    await h.db.save(ASSETS, (await h.db.load()).updated_at); // 不带 daily
    const back = await h.db.load();
    assert.equal(back.data.daily.length, 1); // 保留旧 daily
  } finally {
    await h.cleanup();
  }
});

test('save：ai_log 校验归一化（同日取最后一条、非法条目丢弃、升序、上限 90）', async () => {
  const h = await makeDb();
  try {
    const entries = [
      { date: '2026-08-30', text: ' 旧文本 ' },
      { date: '2026-08-30', text: '新文本' }, // 同日覆盖
      { date: 'bad-date', text: '非法日期' }, // 丢弃
      { date: '2026-08-29', text: '' }, // 空文本丢弃
      { date: '2026-08-31', text: '尾日' },
    ];
    await h.db.save(ASSETS, null, [], entries);
    const back = await h.db.load();
    assert.deepEqual(back.data.ai_log, [
      { date: '2026-08-30', text: '新文本' }, // trim + 同日覆盖
      { date: '2026-08-31', text: '尾日' },
    ]);
  } finally {
    await h.cleanup();
  }
});

test('save：ai_log 传 95 条只留最近 90；未传 ai_log 时保留旧值（快照任务路径）', async () => {
  const h = await makeDb();
  try {
    const mk = (i) => ({
      date: `2026-0${String(Math.floor(i / 28) + 1)}-${String((i % 28) + 1).padStart(2, '0')}`,
      text: `d${i}`,
    });
    const many = Array.from({ length: 95 }, (_, i) => mk(i));
    await h.db.save(ASSETS, null, [], many);
    let back = await h.db.load();
    assert.equal(back.data.ai_log.length, 90);
    assert.equal(back.data.ai_log[0].text, 'd5'); // 最老的 5 条被截掉
    // 快照任务不带 ai_log 保存 → 保留
    await h.db.save(ASSETS, back.updated_at);
    back = await h.db.load();
    assert.equal(back.data.ai_log.length, 90);
    assert.equal(back.data.ai_log[0].text, 'd5');
  } finally {
    await h.cleanup();
  }
});

test('save：ai_log 非数组 → 拒绝', async () => {
  const h = await makeDb();
  try {
    await assert.rejects(() => h.db.save(ASSETS, null, [], 'nope'), /invalid_ai_log/);
  } finally {
    await h.cleanup();
  }
});

// ---- 口径 Ⅰ：corrections（本金修正留痕）随全文档透传 ----

test('save/load：corrections 往返一致；不传时保留库中原值（定时快照任务式写入不丢留痕）', async () => {
  const h = await makeDb();
  try {
    const corrections = [
      {
        code: '110020',
        field: 'total_invested',
        date: '2026-09-06',
        from: 144.17,
        to: 142.84,
        at: '2026-09-06T20:00:00.000Z',
      },
    ];
    await h.db.save(ASSETS, null, [], [], corrections);
    const r1 = await h.db.load();
    assert.deepEqual(r1.data.corrections, corrections);
    await h.db.save(ASSETS, r1.updated_at, [], undefined); // 第 5 参缺省
    const r2 = await h.db.load();
    assert.deepEqual(r2.data.corrections, corrections);
  } finally {
    await h.cleanup();
  }
});

test('save：corrections 非数组 → 拒绝（服务端 400 invalid_data 依据）', async () => {
  const h = await makeDb();
  try {
    await assert.rejects(() => h.db.save(ASSETS, null, [], [], 'nope'), /invalid_corrections/);
  } finally {
    await h.cleanup();
  }
});

test('save：corrections 追加型并集——旧页面提交空数组不会抹掉已落盘留痕；重复记录去重', async () => {
  const h = await makeDb();
  try {
    const c = [
      { code: '110020', field: 'total_invested', date: '2026-09-06', from: 144.17, to: 142.84 },
    ];
    await h.db.save(ASSETS, null, [], [], c);
    let r = await h.db.load();
    await h.db.save(ASSETS, r.updated_at, [], [], []); // 模拟"留痕写入前已加载"的页面（内存 corrections=[]）
    r = await h.db.load();
    assert.deepEqual(r.data.corrections, c);
    const c2 = { code: 'A', field: 'total_invested', date: '2026-09-10', from: 1, to: 2 };
    await h.db.save(ASSETS, r.updated_at, [], [], [...c, c2]);
    r = await h.db.load();
    assert.deepEqual(r.data.corrections, [...c, c2]); // 并集 + 去重
  } finally {
    await h.cleanup();
  }
});
