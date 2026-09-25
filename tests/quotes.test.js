import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteService } from '../js/quotes.js';

const QUOTE_OK = {
  quotes: [{ code: '110020', nav: 1.05, nav_date: '2026-08-28', estimate: null }],
  errors: [],
};

function memoryStorage() {
  const d = {};
  return {
    getItem: (k) => (k in d ? d[k] : null),
    setItem: (k, v) => {
      d[k] = String(v);
    },
    removeItem: (k) => {
      delete d[k];
    },
  };
}

test('fetchQuotes：正常返回 quotes 并写入缓存', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => QUOTE_OK });
  const storage = memoryStorage();
  const svc = createQuoteService({ fetchFn, baseUrl: '', storage });
  const r = await svc.fetchQuotes(['110020']);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.errors.length, 0);
  const cached = JSON.parse(storage.getItem('fund-tracker-quotes'));
  assert.equal(cached.quotes['110020'].nav, 1.05);
  assert.ok(cached.fetched_at);
});

test('fetchQuotes：网络失败不抛异常，返回 errors（降级约定）', async () => {
  const fetchFn = async () => {
    throw new Error('ECONNREFUSED');
  };
  const storage = memoryStorage();
  const svc = createQuoteService({ fetchFn, storage });
  const r = await svc.fetchQuotes(['110020']);
  assert.deepEqual(r.quotes, []);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, '110020');
  // 失败不得污染缓存
  assert.equal(storage.getItem('fund-tracker-quotes'), null);
});

test('fetchQuotes：HTTP 非 200 同样降级', async () => {
  const svc = createQuoteService({
    fetchFn: async () => ({ ok: false, status: 502, json: async () => ({}) }),
    storage: memoryStorage(),
  });
  const r = await svc.fetchQuotes(['110020']);
  assert.deepEqual(r.quotes, []);
  assert.equal(r.errors.length, 1);
});

test('fetchQuotes：无 storage 时照常返回，只跳过缓存', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => QUOTE_OK });
  const svc = createQuoteService({ fetchFn, storage: null });
  const r = await svc.fetchQuotes(['110020']);
  assert.equal(r.quotes.length, 1);
});

test('fetchQuotes：请求了但响应缺失的代码计入 errors', async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      quotes: QUOTE_OK.quotes,
      errors: [{ code: '161017', error: 'lsjz 无数据' }],
    }),
  });
  const svc = createQuoteService({ fetchFn, storage: memoryStorage() });
  const r = await svc.fetchQuotes(['110020', '161017', '000001']);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.errors.length, 2); // 161017（源报错）+ 000001（响应缺失）
});

test('loadCachedQuotes：从缓存恢复上次行情（先显示再更新）', () => {
  const storage = memoryStorage();
  storage.setItem(
    'fund-tracker-quotes',
    JSON.stringify({ quotes: { 110020: { code: '110020', nav: 1.04 } }, fetched_at: 't0' }),
  );
  const svc = createQuoteService({
    fetchFn: async () => {
      throw new Error('x');
    },
    storage,
  });
  const cached = svc.loadCachedQuotes();
  assert.equal(cached.quotes['110020'].nav, 1.04);
});

test('loadCachedQuotes：无缓存/坏缓存返回空结构', () => {
  const svc = createQuoteService({ fetchFn: async () => ({}), storage: memoryStorage() });
  assert.deepEqual(svc.loadCachedQuotes().quotes, {});
});

test('fetchQuotes：缓存合并写入——单只刷新不抹掉其余基金（估值盘复用路径）', async () => {
  const storage = memoryStorage();
  // 既有缓存：两只基金（上一轮全量拉取的产物）
  storage.setItem(
    'fund-tracker-quotes',
    JSON.stringify({
      quotes: {
        110020: { code: '110020', nav: 1.04 },
        161017: { code: '161017', nav: 2.11 },
      },
      fetched_at: 't0',
    }),
  );
  // 单只刷新：只拉 110020（新值 nav=1.05 覆盖旧值）
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => QUOTE_OK });
  const svc = createQuoteService({ fetchFn, storage });
  await svc.fetchQuotes(['110020']);
  const cached = JSON.parse(storage.getItem('fund-tracker-quotes'));
  assert.equal(cached.quotes['110020'].nav, 1.05); // 同 code 新值覆盖
  assert.equal(cached.quotes['161017'].nav, 2.11); // 未请求的基金保留（旧实现整体覆盖 → 此键丢失）
  assert.ok(cached.fetched_at && cached.fetched_at !== 't0'); // 取数时间已刷新
});

test('fetchQuotes：坏缓存不阻断合并写入——按空对象起底重建', async () => {
  const storage = memoryStorage();
  storage.setItem('fund-tracker-quotes', '{不是JSON');
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => QUOTE_OK });
  const svc = createQuoteService({ fetchFn, storage });
  const r = await svc.fetchQuotes(['110020']);
  assert.equal(r.quotes.length, 1);
  const cached = JSON.parse(storage.getItem('fund-tracker-quotes'));
  assert.deepEqual(Object.keys(cached.quotes), ['110020']);
});

test('fetchHistory：正常返回序列；失败返回空序列不抛异常', async () => {
  const good = createQuoteService({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: '110020', series: [{ date: '2026-08-28', nav: 1.05 }] }),
    }),
    storage: memoryStorage(),
  });
  assert.equal((await good.fetchHistory('110020', 30)).series.length, 1);

  const bad = createQuoteService({
    fetchFn: async () => {
      throw new Error('ECONNREFUSED');
    },
    storage: memoryStorage(),
  });
  const r = await bad.fetchHistory('110020');
  assert.deepEqual(r.series, []);
  assert.ok(r.error);
});

test('fetchIndexes：正常返回；失败返回空数组不抛异常', async () => {
  const good = createQuoteService({
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ indexes: [{ code: '000300', name: '沪深300', change_pct: -0.46 }] }),
    }),
    storage: memoryStorage(),
  });
  assert.equal((await good.fetchIndexes()).indexes.length, 1);

  const bad = createQuoteService({
    fetchFn: async () => {
      throw new Error('x');
    },
    storage: memoryStorage(),
  });
  assert.deepEqual((await bad.fetchIndexes()).indexes, []);
});
