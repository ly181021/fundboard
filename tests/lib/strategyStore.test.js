import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStrategyStore, fundStateDefaults } from '../../lib/strategyStore.js';

async function mkStore() {
  const dir = await mkdtemp(join(tmpdir(), 'strategystore-'));
  return {
    store: createStrategyStore({ dataDir: dir }),
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('loadState：文件缺失返回空库（首启零迁移）', async () => {
  const { store, cleanup } = await mkStore();
  try {
    const s = await store.loadState();
    assert.deepEqual(s, { schemaVersion: 1, rev: 0, funds: {} });
  } finally {
    await cleanup();
  }
});

test('save → load 往返一致（原子写，无 .tmp 残留）', async () => {
  const { store, dir, cleanup } = await mkStore();
  try {
    await store.saveState({ funds: { T001: { hwmDate: '2026-09-10', reserveUsed: 1000 } } });
    const s = await store.loadState();
    assert.equal(s.funds.T001.hwmDate, '2026-09-10');
    const raw = JSON.parse(await readFile(join(dir, 'strategy_state.json'), 'utf8'));
    assert.equal(raw.schemaVersion, 1);
  } finally {
    await cleanup();
  }
});

test('saveState 继承 schemaVersion：库中现值不被硬编码降级（与 db.json 同规则）', async () => {
  const { store, cleanup } = await mkStore();
  try {
    await store.saveState({ schemaVersion: 2, funds: { T001: { hwmDate: '2026-09-10' } } });
    const s = await store.loadState();
    assert.equal(s.schemaVersion, 2);
  } finally {
    await cleanup();
  }
});

test('saveState 缺省 schemaVersion：从现文件继承——手工构造 state（不经 loadState 往返）不降级 v2 库', async () => {
  const { store, dir, cleanup } = await mkStore();
  try {
    await writeFile(
      join(dir, 'strategy_state.json'),
      JSON.stringify({ schemaVersion: 2, funds: {} }),
    );
    await store.saveState({ funds: { T001: { hwmDate: '2026-09-10' } } }); // 不带 schemaVersion
    const raw = JSON.parse(await readFile(join(dir, 'strategy_state.json'), 'utf8'));
    assert.equal(raw.schemaVersion, 2);
  } finally {
    await cleanup();
  }
});

test('fundState：缺失字段补默认（旧条目前向兼容）', async () => {
  const { store, cleanup } = await mkStore();
  try {
    await store.saveState({ funds: { T001: { hwmDate: '2026-09-10' } } });
    const s = await store.loadState();
    const f = store.fundState(s.funds, 'T001');
    assert.deepEqual(f, { ...fundStateDefaults(), hwmDate: '2026-09-10' });
    const missing = store.fundState(s.funds, 'X999');
    assert.deepEqual(missing, fundStateDefaults());
  } finally {
    await cleanup();
  }
});

test('alerts 只追加：多条依次累加，文件缺失从空开始', async () => {
  const { store, cleanup } = await mkStore();
  try {
    assert.deepEqual(await store.loadAlerts(), []);
    await store.appendAlerts({ ts: 't1', code: 'T001', state: 'TAKE_PROFIT' });
    await store.appendAlerts([{ ts: 't2', code: 'T001', state: 'STOP_LOSS' }]);
    const list = await store.loadAlerts();
    assert.equal(list.length, 2);
    assert.equal(list[1].state, 'STOP_LOSS');
  } finally {
    await cleanup();
  }
});
