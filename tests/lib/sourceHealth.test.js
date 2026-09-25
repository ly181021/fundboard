import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceHealth } from '../../lib/sourceHealth.js';

async function makeHealth() {
  const dir = await mkdtemp(join(tmpdir(), 'fund-health-'));
  const h = createSourceHealth({ dataDir: dir });
  const read = async () => JSON.parse(await readFile(join(dir, 'source_health.json'), 'utf8'));
  return { h, dir, read };
}

test('sourceHealth：记录成功/失败 → 文件字段正确、errCount 递增、错误摘要截断 60 字', async () => {
  const { h, dir, read } = await makeHealth();
  await h.record('lsjz', true, null);
  await h.record(
    'estimate',
    false,
    new Error(
      'HTTP 500 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十',
    ),
  );
  const f = await read();
  assert.equal(f.schemaVersion, 1);
  assert.equal(f.sources.lsjz.lastOkAt != null, true);
  assert.equal(f.sources.lsjz.errCount, 0);
  assert.equal(f.sources.estimate.lastErrAt != null, true);
  assert.equal(f.sources.estimate.errCount, 1);
  assert.equal(f.sources.estimate.lastErrMsg.includes('HTTP 500'), true);
  assert.equal(f.sources.estimate.lastErrMsg.length <= 60, true);
  assert.equal(f.sources.sina.lastOkAt, null); // 未调用的源保持空
  assert.equal(f.sources.sina.lastErrAt, null);
  const mem = await h.read();
  assert.equal(mem.ts != null, true); // ts = 最近一次记录时刻
  assert.equal(mem.ts >= f.sources.estimate.lastErrAt, true);
  await rm(dir, { recursive: true, force: true });
});

test('sourceHealth：lsjz 主源成功清 fallbackUsedAt，备源成功置位且与 lastOkAt 同值（单次 now）', async () => {
  const { h, read } = await makeHealth();
  await h.record('lsjz', true, null, { fallback: true }); // 备源成功
  let f = await read();
  assert.equal(f.sources.lsjz.fallbackUsedAt != null, true);
  assert.equal(f.sources.lsjz.fallbackUsedAt, f.sources.lsjz.lastOkAt); // 同一次 record 内恒同值
  await h.record('lsjz', true, null); // 主源直接成功 → 清除
  f = await read();
  assert.equal(f.sources.lsjz.fallbackUsedAt, null);
  assert.equal(f.sources.lsjz.lastOkAt != null, true);
});

test('sourceHealth：备源标记泛化到 push2 指数源——备源置位、主源成功清除、各源字段恒定', async () => {
  const { h, read } = await makeHealth();
  await h.record('push2', true, null, { fallback: true }); // 指数走新浪备源成功
  let f = await read();
  assert.equal(f.sources.push2.fallbackUsedAt != null, true);
  assert.equal(f.sources.push2.fallbackUsedAt, f.sources.push2.lastOkAt); // 单次 record 内恒同值
  const mem = await h.read();
  for (const k of ['push2', 'estimate', 'sina', 'lsjz']) {
    assert.equal('fallbackUsedAt' in mem.sources[k], true); // 接口结构恒定，前端可安全读取
  }
  await h.record('push2', true, null); // 主源直接成功 → 清除备源标记
  f = await read();
  assert.equal(f.sources.push2.fallbackUsedAt, null);
  assert.equal(f.sources.push2.lastOkAt != null, true);
});

test('sourceHealth：并发 record 串行落盘无异常，文件 JSON 完整且终值与内存一致', async () => {
  const { h, read } = await makeHealth();
  await Promise.all([
    h.record('push2', true, null),
    h.record('estimate', false, new Error('boom')),
    h.record('lsjz', true, null, { fallback: true }),
    h.record('sina', false, new Error('bad')),
  ]);
  const f = await read();
  const mem = await h.read();
  assert.deepEqual(f.sources, mem.sources); // 文件终值 = 内存终值
  assert.equal(f.sources.push2.lastOkAt != null, true);
  assert.equal(f.sources.sina.lastErrAt != null, true);
  assert.equal(f.sources.lsjz.fallbackUsedAt != null, true);
});

test('sourceHealth：文件缺失 → 全 null 空态；坏 JSON → 按空处理不抛错', async () => {
  const { h, dir, read } = await makeHealth();
  const r1 = await h.read();
  assert.equal(r1.sources.lsjz.lastOkAt, null);
  assert.equal(r1.sources.push2.lastErrMsg, null);
  assert.equal(r1.ts, null); // 无任何记录 → ts 为 null（前端显示"最后更新 —"）
  await writeFile(join(dir, 'source_health.json'), '{坏 JSON', 'utf8');
  const h2 = createSourceHealth({ dataDir: dir }); // 新实例读坏文件
  const r2 = await h2.read();
  assert.equal(r2.sources.lsjz.lastOkAt, null);
  await rm(dir, { recursive: true, force: true });
});

test('sourceHealth：落盘失败（dataDir 指向文件）→ record 不抛、内存状态仍可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fund-health-'));
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'x', 'utf8');
  const h = createSourceHealth({ dataDir: blocker }); // mkdir/writeFile 必失败
  await h.record('push2', true, null); // 不得抛
  const r = await h.read();
  assert.equal(r.sources.push2.lastOkAt != null, true); // 内存状态仍在
  await rm(dir, { recursive: true, force: true });
});
