import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createServerStore } from '../js/store.js';

// 测试用内存 storage 模拟 localStorage
function makeMemoryStorage() {
  const data = {};
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, val) => {
      data[key] = String(val);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

// ---- localStorage 存储后端（既有行为）----

test('saveAssets + loadAssets：存取往返一致', () => {
  const storage = makeMemoryStorage();
  const store = createStore({ storage });
  const data = { assets: [{ id: 'f1', name: '测试基金', asset_type: 'fund' }] };
  store.saveAssets(data);
  const loaded = store.loadAssets();
  assert.deepEqual(loaded, data);
});

test('loadAssets：无数据时返回空结构', () => {
  const storage = makeMemoryStorage();
  const store = createStore({ storage });
  const loaded = store.loadAssets();
  assert.deepEqual(loaded, { assets: [] });
});

test('exportJSON：导出格式化 JSON 字符串', () => {
  const storage = makeMemoryStorage();
  const store = createStore({ storage });
  store.saveAssets({ assets: [{ id: 'f1', name: '测试' }] });
  const json = store.exportJSON();
  const parsed = JSON.parse(json);
  assert.equal(parsed.assets[0].id, 'f1');
});

test('importJSON：从 JSON 字符串导入并覆盖', () => {
  const storage = makeMemoryStorage();
  const store = createStore({ storage });
  const jsonStr = JSON.stringify({ assets: [{ id: 'f2', name: '导入基金' }] });
  const data = store.importJSON(jsonStr);
  assert.equal(data.assets[0].id, 'f2');
  // 验证已写入 storage
  const loaded = store.loadAssets();
  assert.equal(loaded.assets[0].id, 'f2');
});

// ---- 服务端存储后端 ----

const ASSETS = [
  {
    id: 'f1',
    asset_type: 'fund',
    name: '测试基金',
    code: '110020',
    snapshot: {},
    transactions: [],
  },
];

function okFetch(payload = {}) {
  return async (url, opts = {}) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes('/api/data') && opts.method === 'PUT'
        ? { ok: true, updated_at: '2026-08-30T12:00:00Z' }
        : {
            data: { version: 1, assets: ASSETS, daily: [] },
            updated_at: '2026-08-30T11:00:00Z',
            ...payload,
          },
  });
}

test('serverStore.loadAssets：拉取服务端数据并写镜像，reachable=true', async () => {
  const storage = makeMemoryStorage();
  const store = createServerStore({ fetchFn: okFetch(), fallbackStorage: storage });
  const data = await store.loadAssets();
  assert.deepEqual(data.assets, ASSETS);
  assert.equal(store.reachable, true);
  const mirror = JSON.parse(storage.getItem('fund-tracker-data'));
  assert.deepEqual(mirror.assets, ASSETS); // 镜像复用主数据键：旧 localStorage 数据天然是迁移源/兜底
});

test('serverStore：ai_log 随 loadAssets/saveAssets 往返（PUT 体与镜像均携带）', async () => {
  const storage = makeMemoryStorage();
  const calls = [];
  const store = createServerStore({
    fetchFn: async (url, opts = {}) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/api/data') && opts.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, updated_at: '2026-08-30T12:00:00Z' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            version: 1,
            assets: ASSETS,
            daily: [],
            ai_log: [{ date: '2026-08-29', text: '昨天解读' }],
          },
          updated_at: '2026-08-30T11:00:00Z',
        }),
      };
    },
    fallbackStorage: storage,
  });
  const loaded = await store.loadAssets();
  assert.deepEqual(loaded.ai_log, [{ date: '2026-08-29', text: '昨天解读' }]);
  await store.saveAssets({
    assets: ASSETS,
    daily: [],
    ai_log: [{ date: '2026-08-30', text: '今天解读' }],
  });
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body.ai_log, [{ date: '2026-08-30', text: '今天解读' }]);
  const mirror = JSON.parse(storage.getItem('fund-tracker-data'));
  assert.deepEqual(mirror.ai_log, [{ date: '2026-08-30', text: '今天解读' }]);
});

test('serverStore：corrections 随 loadAssets/saveAssets 往返（PUT 体与镜像均携带）', async () => {
  const storage = makeMemoryStorage();
  const calls = [];
  const corrections = [
    { code: '110020', field: 'total_invested', date: '2026-09-06', from: 144.17, to: 142.84 },
  ];
  const store = createServerStore({
    fetchFn: async (url, opts = {}) => {
      calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/api/data') && opts.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, updated_at: '2026-08-30T12:00:00Z' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { version: 1, assets: ASSETS, daily: [], corrections },
          updated_at: '2026-08-30T11:00:00Z',
        }),
      };
    },
    fallbackStorage: storage,
  });
  const loaded = await store.loadAssets();
  assert.deepEqual(loaded.corrections, corrections); // 读：服务端文档字段透传
  const next = [
    { code: '110020', field: 'total_invested', date: '2026-09-10', from: 10000, to: 10500 },
  ];
  await store.saveAssets({ assets: ASSETS, daily: [], corrections: next });
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body.corrections, next); // 写：PUT 体携带
  const mirror = JSON.parse(storage.getItem('fund-tracker-data'));
  assert.deepEqual(mirror.corrections, next); // 镜像兜底携带（审计留痕不丢）
});

test('serverStore.loadAssets：断连时读镜像，reachable=false，不抛异常', async () => {
  const storage = makeMemoryStorage();
  storage.setItem('fund-tracker-data', JSON.stringify({ assets: ASSETS }));
  const store = createServerStore({
    fetchFn: async () => {
      throw new Error('ECONNREFUSED');
    },
    fallbackStorage: storage,
  });
  const data = await store.loadAssets();
  assert.deepEqual(data.assets, ASSETS);
  assert.equal(store.reachable, false);
});

test('serverStore.loadAssets：401 → authRequired=true 回落镜像，且请求带口令头', async () => {
  const storage = makeMemoryStorage();
  storage.setItem('fund-tracker-data', JSON.stringify({ assets: ASSETS }));
  const seenHeaders = [];
  const fetchFn = async (url, opts = {}) => {
    seenHeaders.push(opts.headers || {});
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const store = createServerStore({
    fetchFn,
    fallbackStorage: storage,
    getHeaders: () => ({ 'X-App-Token': 'tk' }),
  });
  const data = await store.loadAssets();
  assert.deepEqual(data.assets, ASSETS); // 回落镜像
  assert.equal(store.reachable, false);
  assert.equal(store.authRequired, true);
  assert.equal(seenHeaders[0]['X-App-Token'], 'tk'); // 请求带上了口令头
});

test('serverStore.saveAssets：PUT 带 base_updated_at，成功后镜像同步', async () => {
  const storage = makeMemoryStorage();
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (opts.method === 'PUT')
      return { ok: true, status: 200, json: async () => ({ ok: true, updated_at: 'T2' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { version: 1, assets: [], daily: [] }, updated_at: 'T1' }),
    };
  };
  const store = createServerStore({ fetchFn, fallbackStorage: storage });
  await store.loadAssets(); // serverUpdatedAt = T1
  const r = await store.saveAssets({ assets: ASSETS });
  assert.equal(r.ok, true);
  assert.equal(store.pendingSync, false);
  const put = calls.find((c) => c.opts.method === 'PUT');
  const body = JSON.parse(put.opts.body);
  assert.equal(body.base_updated_at, 'T1'); // 乐观锁
  assert.deepEqual(body.assets, ASSETS);
  assert.deepEqual(JSON.parse(storage.getItem('fund-tracker-data')).assets, ASSETS);
});

test('serverStore.saveAssets：断连 → pendingDoc + 镜像兜底，恢复后自动重推', async () => {
  let down = true;
  const methods = [];
  const fetchFn = async (url, opts = {}) => {
    methods.push(opts.method || 'GET');
    if (down) throw new Error('ECONNREFUSED');
    if (opts.method === 'PUT')
      return { ok: true, status: 200, json: async () => ({ ok: true, updated_at: 'T9' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { version: 1, assets: [], daily: [] }, updated_at: null }),
    };
  };
  const storage = makeMemoryStorage();
  const store = createServerStore({ fetchFn, fallbackStorage: storage });
  await store.loadAssets(); // 断连启动 → 镜像模式
  assert.equal(store.reachable, false);

  const r = await store.saveAssets({ assets: ASSETS }); // 断连保存
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.equal(store.pendingSync, true);
  assert.deepEqual(JSON.parse(storage.getItem('fund-tracker-data')).assets, ASSETS); // 镜像兜底

  down = false; // 服务恢复
  methods.length = 0; // 只统计恢复后的请求
  const r2 = await store.saveAssets({ assets: ASSETS }); // 再次保存：先推 pending，再推当前
  assert.equal(r2.ok, true);
  assert.equal(store.pendingSync, false);
  assert.equal(methods.filter((m) => m === 'PUT').length, 2); // pending 重推 + 当前数据
});

test('serverStore.saveAssets：409 冲突向上抛（err.conflict=true + serverUpdatedAt）', async () => {
  const fetchFn = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: 'conflict', server_updated_at: 'SERVER-T' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { version: 1, assets: [], daily: [] }, updated_at: 'T1' }),
    };
  };
  const store = createServerStore({ fetchFn, fallbackStorage: makeMemoryStorage() });
  await store.loadAssets();
  await assert.rejects(
    () => store.saveAssets({ assets: ASSETS }),
    (e) => e.conflict === true && e.serverUpdatedAt === 'SERVER-T',
  );
});

test('serverStore.exportJSON：基于当前内存态', async () => {
  const store = createServerStore({ fetchFn: okFetch(), fallbackStorage: makeMemoryStorage() });
  await store.loadAssets();
  assert.deepEqual(JSON.parse(store.exportJSON()).assets, ASSETS);
});

test('serverStore.importJSON：解析后走 saveAssets 写服务端', async () => {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push(opts.method || 'GET');
    if (opts.method === 'PUT')
      return { ok: true, status: 200, json: async () => ({ ok: true, updated_at: 'T2' }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { version: 1, assets: [], daily: [] }, updated_at: 'T1' }),
    };
  };
  const store = createServerStore({ fetchFn, fallbackStorage: makeMemoryStorage() });
  await store.loadAssets();
  const data = await store.importJSON(JSON.stringify({ assets: ASSETS }));
  assert.deepEqual(data.assets, ASSETS);
  assert.ok(calls.includes('PUT'));
});

// ---- 409 字段级合流 ----

/** 服务端模拟：serverDoc + 可编排的 PUT 响应序列 */
function makeServerHarness({ serverDoc, putStatuses }) {
  let puts = 0;
  let lastBody = null;
  const fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      puts++;
      lastBody = JSON.parse(opts.body || '{}');
      const status = Array.isArray(putStatuses)
        ? (putStatuses[puts - 1] ?? putStatuses[putStatuses.length - 1])
        : putStatuses;
      if (status === 409)
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'conflict', server_updated_at: serverDoc.updated_at }),
        };
      // 成功 PUT：把 body 落进 serverDoc（模拟真实服务端）
      serverDoc.assets = lastBody.assets;
      serverDoc.daily = lastBody.daily;
      serverDoc.ai_log = lastBody.ai_log;
      serverDoc.updated_at = (serverDoc.updated_at || 0) + 1;
      return { ok: true, status: 200, json: async () => ({ updated_at: serverDoc.updated_at }) };
    }
    // GET
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: serverDoc, updated_at: serverDoc.updated_at }),
    };
  };
  const store = createServerStore({ baseUrl: '', getHeaders: () => ({}), fetchFn: fetch });
  return {
    store,
    serverDoc,
    get puts() {
      return puts;
    },
    get lastBody() {
      return lastBody;
    },
  };
}

const ASSETS_A = [{ id: 'f1', name: '甲', asset_type: 'fund' }];

test('409 合流：远端仅推进 daily → 自动合流重推成功（本地 assets/ai_log 保留 + 服务端 daily 采纳）', async () => {
  const serverDoc = {
    version: 1,
    assets: ASSETS_A,
    daily: [{ code: '110020', date: '2026-09-08', earnings: 1 }],
    ai_log: [],
    updated_at: 10,
  };
  const h = makeServerHarness({ serverDoc, putStatuses: [409, 200] });
  await h.store.loadAssets(); // 建立基准
  // 快照任务推进 daily（模拟服务端被巡检写入）
  serverDoc.daily = [{ code: '110020', date: '2026-09-08', earnings: 2 }];
  serverDoc.updated_at = 11;
  const r = await h.store.saveAssets({
    assets: ASSETS_A,
    daily: [],
    ai_log: [{ date: '2026-09-08', text: 'AI' }],
  });
  assert.equal(r.ok, true);
  assert.equal(h.puts, 2); // 第一次 409 → 合流重推
  assert.deepEqual(h.serverDoc.assets, ASSETS_A); // 本地 assets 保留
  assert.equal(h.serverDoc.daily[0].earnings, 2); // 服务端 daily 采纳
  assert.equal(h.serverDoc.ai_log.length, 1); // 本地 ai_log 保留
});

test('409 合流：远端改动 assets（真冲突）→ 不合流抛 conflict', async () => {
  const serverDoc = { version: 1, assets: ASSETS_A, daily: [], ai_log: [], updated_at: 10 };
  const h = makeServerHarness({ serverDoc, putStatuses: [409] });
  await h.store.loadAssets();
  serverDoc.assets = [{ id: 'f2', name: '乙', asset_type: 'fund' }]; // 另一窗口改了持仓
  serverDoc.updated_at = 11;
  await assert.rejects(
    () => h.store.saveAssets({ assets: ASSETS_A, daily: [], ai_log: [] }),
    (e) => e.conflict === true,
  );
  assert.equal(h.puts, 1); // 不合流、不重推
});

test('409 合流：合流重推仍 409 → 抛 conflict（只试一次防循环）', async () => {
  const serverDoc = { version: 1, assets: ASSETS_A, daily: [], ai_log: [], updated_at: 10 };
  const h = makeServerHarness({ serverDoc, putStatuses: [409, 409] });
  await h.store.loadAssets();
  serverDoc.daily = [{ code: '110020', date: '2026-09-08', earnings: 3 }];
  serverDoc.updated_at = 11;
  await assert.rejects(
    () => h.store.saveAssets({ assets: ASSETS_A, daily: [], ai_log: [] }),
    (e) => e.conflict === true,
  );
  assert.equal(h.puts, 2);
});

test('409 合流：键序免疫——本地对象属性插入序不同也能正确判定仅 daily 变动', async () => {
  const serverDoc = {
    version: 1,
    assets: ASSETS_A,
    daily: [{ code: '110020', date: '2026-09-08', earnings: 1 }],
    ai_log: [],
    updated_at: 10,
  };
  const h = makeServerHarness({ serverDoc, putStatuses: [409, 200] });
  await h.store.loadAssets();
  serverDoc.daily = [{ code: '110020', date: '2026-09-08', earnings: 2 }];
  serverDoc.updated_at = 11;
  // 本地 assets 以不同键序构造（stableStringify 免疫插入序）
  const reordered = [{ asset_type: 'fund', name: '甲', id: 'f1' }];
  const r = await h.store.saveAssets({ assets: reordered, daily: [], ai_log: [] });
  assert.equal(r.ok, true);
  assert.equal(h.puts, 2); // 判定为"仅 daily 变动"→ 合流成功
});

test('409 合流：回流与基准防污染——合流后 daily 回流客户端、本地后续改动不污染基准', async () => {
  const serverDoc = {
    version: 1,
    assets: ASSETS_A,
    daily: [{ code: '110020', date: '2026-09-08', earnings: 1 }],
    ai_log: [],
    updated_at: 10,
  };
  const h = makeServerHarness({ serverDoc, putStatuses: [409, 200, 409, 200] });
  await h.store.loadAssets();
  // 第一次保存：远端仅 daily 变动 → 合流
  serverDoc.daily = [{ code: '110020', date: '2026-09-08', earnings: 2 }];
  serverDoc.updated_at = 11;
  const r1 = await h.store.saveAssets({ assets: ASSETS_A, daily: [], ai_log: [] });
  assert.equal(r1.ok, true);
  assert.equal(r1.daily[0].earnings, 2); // daily 回流调用方
  // 第二次保存：本地 assets 改动（键序打乱）+ 服务端 daily 再推进 → 仍判定"仅 daily 变动"（基准未被污染）
  serverDoc.daily = [{ code: '110020', date: '2026-09-08', earnings: 3 }];
  serverDoc.updated_at = 12;
  const assetsB = [{ asset_type: 'fund', name: '丙', id: 'f3' }];
  const r2 = await h.store.saveAssets({ assets: assetsB, daily: r1.daily, ai_log: [] });
  assert.equal(r2.ok, true);
  assert.deepEqual(h.serverDoc.assets, assetsB); // 本地 assets 保留
  assert.equal(h.serverDoc.daily[0].earnings, 3); // 服务端 daily 采纳（baseDoc 深拷贝未受本地 mutation 污染）
});

test('409 合流链式形态：离线落 pending → 服务端推进 daily → 恢复保存不回滚 daily', async () => {
  const serverDoc = {
    version: 1,
    assets: ASSETS_A,
    daily: [{ code: '110020', date: '2026-09-08', earnings: 1 }],
    ai_log: [],
    updated_at: 10,
  };
  let offline = true;
  let puts = 0;
  const seq = [409, 200, 200]; // pending 重推：409 → 合流 200；随后 doc push：200
  const fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      if (offline) throw new Error('network down'); // 断连：push 返回 false → 落 pending
      const status = seq[puts] ?? 200;
      puts++;
      const body = JSON.parse(opts.body || '{}');
      if (status === 409)
        return {
          ok: false,
          status: 409,
          json: async () => ({ server_updated_at: serverDoc.updated_at }),
        };
      serverDoc.assets = body.assets;
      serverDoc.daily = body.daily;
      serverDoc.ai_log = body.ai_log;
      serverDoc.updated_at = (serverDoc.updated_at || 0) + 1;
      return { ok: true, status: 200, json: async () => ({ updated_at: serverDoc.updated_at }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: serverDoc, updated_at: serverDoc.updated_at }),
    };
  };
  const store = createServerStore({ baseUrl: '', getHeaders: () => ({}), fetchFn: fetch });
  await store.loadAssets();
  const r1 = await store.saveAssets({ assets: ASSETS_A, daily: [], ai_log: [] }); // 断连 → pending
  assert.equal(r1.ok, false);
  assert.equal(r1.pending, true);
  // 断连期间快照任务推进服务端 daily 至 2 行
  serverDoc.daily = [
    { code: '110020', date: '2026-09-08', earnings: 1 },
    { code: '161017', date: '2026-09-08', earnings: 0.5 },
  ];
  serverDoc.updated_at = 11;
  offline = false;
  const r2 = await store.saveAssets({ assets: ASSETS_A, daily: [], ai_log: [] }); // 恢复：pending 合流 → doc push
  assert.equal(r2.ok, true);
  assert.equal(serverDoc.daily.length, 2); // 快照行保留（回流 daily 并入第二次 push）
  assert.equal(r2.daily.length, 2); // 返回给前端的 daily 也是回流值
});

test('普通 pendingDoc 重推（无 409）：恢复期间本地 daily 增长 → 新 daily 不被覆盖', async () => {
  const serverDoc = {
    version: 1,
    assets: ASSETS_A,
    daily: [{ code: '110020', date: '2026-09-07', earnings: 1 }],
    ai_log: [],
    updated_at: 10,
  };
  let offline = true;
  const seq = [200, 200]; // 恢复后：pending 重推直接成功（无 409）→ doc push 成功
  let puts = 0;
  const fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      if (offline) throw new Error('network down');
      const status = seq[puts] ?? 200;
      puts++;
      const body = JSON.parse(opts.body || '{}');
      serverDoc.assets = body.assets;
      serverDoc.daily = body.daily;
      serverDoc.ai_log = body.ai_log;
      serverDoc.updated_at = (serverDoc.updated_at || 0) + 1;
      return { ok: true, status, json: async () => ({ updated_at: serverDoc.updated_at }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: serverDoc, updated_at: serverDoc.updated_at }),
    };
  };
  const store = createServerStore({ baseUrl: '', getHeaders: () => ({}), fetchFn: fetch });
  await store.loadAssets();
  const d1 = [{ code: '110020', date: '2026-09-07', earnings: 1 }];
  const r1 = await store.saveAssets({ assets: ASSETS_A, daily: d1, ai_log: [] }); // 断连 → pending
  assert.equal(r1.pending, true);
  // 断连期间前端又入账 2 行（D2 ⊃ D1）
  const d2 = [
    ...d1,
    { code: '161017', date: '2026-09-08', earnings: 0.5 },
    { code: '110020', date: '2026-09-08', earnings: 0.3 },
  ];
  offline = false;
  const r2 = await store.saveAssets({ assets: ASSETS_A, daily: d2, ai_log: [] });
  assert.equal(r2.ok, true);
  assert.equal(serverDoc.daily.length, 3); // 服务端新入账行保留（本地快照不得整体覆盖）
  assert.equal(r2.daily.length, 3);
  assert.ok(serverDoc.daily.some((r) => r.date === '2026-09-08'));
});
