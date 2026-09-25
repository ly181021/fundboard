import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatasource, isAbortError } from '../../lib/datasource.js';

// ---- 按实测响应结构构造的夹具 ----
const LSJZ_OK = JSON.stringify({
  Data: {
    LSJZList: [
      {
        FSRQ: '2026-08-28',
        DWJZ: '1.0500',
        LJJZ: '1.0500',
        JZZZL: '1.94',
        SGZT: '开放申购',
        SHZT: '开放赎回',
      },
      { FSRQ: '2026-08-27', DWJZ: '1.0300', LJJZ: '1.0300', JZZZL: '0.98' },
      { FSRQ: '2026-08-26', DWJZ: '1.0200', LJJZ: '1.0200', JZZZL: '-0.10' },
    ],
  },
});
const LSJZ_ERR = JSON.stringify({ Data: '', ErrCode: -999, ErrMsg: '', TotalCount: 0 });
const EMPTY_PAGE = JSON.stringify({ Data: { LSJZList: [] } });
const DJ_HISTORY = JSON.stringify({
  data: {
    items: [
      { date: '2026-08-28', nav: '1.8874', percentage: '-0.41', value: '1.8874' },
      { date: '2026-08-27', nav: '1.8952', percentage: '0.85', value: '1.8952' },
      { date: '2026-08-26', nav: '1.8793', percentage: '0.82', value: '1.8793' },
    ],
  },
  result_code: 0,
});

/** 按 URL 子串匹配返回预设响应，并记录调用（url + headers）供断言 */
function fakeFetch(routes, log = []) {
  return async (url, opts = {}) => {
    log.push({ url, headers: opts.headers || {} });
    for (const [pattern, body, status = 200] of routes) {
      if (url.includes(pattern)) {
        const bytes = new TextEncoder().encode(body);
        return {
          ok: status < 400,
          status,
          text: async () => body,
          json: async () => JSON.parse(body),
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

test('fetchQuote：lsjz 组装 quote，必须带 Referer 头', async () => {
  const log = [];
  const ds = createDatasource({ fetchFn: fakeFetch([['f10/lsjz', LSJZ_OK]], log) });
  const q = await ds.fetchQuote('110020');
  assert.equal(q.code, '110020');
  assert.equal(q.nav, 1.05);
  assert.equal(q.nav_date, '2026-08-28');
  assert.equal(q.prev_nav, 1.03);
  assert.equal(q.prev2_nav, 1.02);
  assert.equal(q.change_pct, 1.94);
  assert.equal(q.estimate, null); // fundgz 盘中估值已下线
  assert.equal(q.source, 'eastmoney');
  const call = log.find((c) => c.url.includes('f10/lsjz'));
  assert.ok(String(call.headers.Referer).includes('fund.eastmoney.com/f10/jjjz_110020'));
  assert.ok(call.url.includes('fundCode=110020') && call.url.includes('pageSize=3'));
});

test('fetchQuote：业务码异常（ErrCode -999，HTTP 仍 200）→ 抛错', async () => {
  const ds = createDatasource({ fetchFn: fakeFetch([['f10/lsjz', LSJZ_ERR]]) });
  await assert.rejects(() => ds.fetchQuote('110020'));
});

test('fetchHistory：接口每页固定 20 条时分页凑满，升序返回', async () => {
  // page1: 最近 20 天，page2: 再 20 天，page3: 末页 4 条（真实日期串，保证排序断言可靠）
  const dayStr = (offset) =>
    new Date(Date.UTC(2026, 7, 28) - offset * 86400000).toISOString().slice(0, 10);
  const mkPage = (startOffset, n) =>
    JSON.stringify({
      Data: {
        LSJZList: Array.from({ length: n }, (_, i) => ({
          FSRQ: dayStr(startOffset + i),
          DWJZ: '1.0000',
          LJJZ: '1.0000',
          JZZZL: '0.10',
        })),
      },
    });
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['pageIndex=1', mkPage(0, 20)],
      ['pageIndex=2', mkPage(20, 20)],
      ['pageIndex=3', mkPage(40, 4)],
    ]),
  });
  const h = await ds.fetchHistory('110020', 44); // 20+20+4，days 与数据量自洽
  assert.equal(h.series.length, 44);
  assert.equal(h.series[0].date, dayStr(43)); // 最旧
  assert.equal(h.series[43].date, dayStr(0)); // 最新
});

test('fetchQuote：pageSize=3 单页即停，不触发翻页', async () => {
  const log = [];
  const ds = createDatasource({
    fetchFn: fakeFetch(
      [
        ['f10/lsjz', LSJZ_OK],
        ['pageIndex=2', EMPTY_PAGE],
      ],
      log,
    ),
  });
  await ds.fetchQuote('110020');
  const lsjzCalls = log.filter((c) => c.url.includes('f10/lsjz'));
  assert.equal(lsjzCalls.length, 1); // 3 条拿到即够，不翻页
});

test('fetchQuote：主源失败自动切蛋卷备源', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['f10/lsjz', LSJZ_ERR],
      ['danjuanfunds.com', DJ_HISTORY],
    ]),
  });
  const q = await ds.fetchQuote('110020');
  assert.equal(q.source, 'danjuan');
  assert.equal(q.nav, 1.8874);
  assert.equal(q.prev_nav, 1.8952);
  assert.equal(q.change_pct, -0.41);
});

test('fetchQuote：全源失败 → 抛错', async () => {
  const ds = createDatasource({ fetchFn: fakeFetch([]) });
  await assert.rejects(() => ds.fetchQuote('110020'));
});

test('fetchHistory：升序返回 {date,nav,acc_nav,change_pct}', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['pageIndex=2', EMPTY_PAGE],
      ['f10/lsjz', LSJZ_OK],
    ]),
  });
  const h = await ds.fetchHistory('110020', 90);
  assert.equal(h.code, '110020');
  assert.deepEqual(
    h.series.map((s) => s.date),
    ['2026-08-26', '2026-08-27', '2026-08-28'],
  );
  assert.equal(h.series[2].nav, 1.05);
  assert.equal(h.series[2].acc_nav, 1.05);
  assert.equal(h.series[2].change_pct, 1.94);
});

test('fetchHistory：源缺日涨幅（JZZZL 为空）时由相邻净值差补算', async () => {
  const noPct = JSON.stringify({
    Data: {
      LSJZList: [
        { FSRQ: '2026-08-28', DWJZ: '1.0500', LJJZ: '1.0500', JZZZL: '' },
        { FSRQ: '2026-08-27', DWJZ: '1.0300', LJJZ: '1.0300', JZZZL: '' },
      ],
    },
  });
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['pageIndex=2', EMPTY_PAGE],
      ['f10/lsjz', noPct],
    ]),
  });
  const h = await ds.fetchHistory('110020', 10);
  assert.ok(h.series[1].change_pct > 1.9 && h.series[1].change_pct < 2.0);
  assert.equal(h.series[0].change_pct, null); // 无更早净值可算
});

test('fetchQuoteBatch：单只失败不拖垮整批', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['fundCode=110020', LSJZ_OK],
      ['f10/lsjz', LSJZ_ERR],
    ]),
  });
  const r = await ds.fetchQuoteBatch(['110020', '161017']);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].code, '110020');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, '161017');
});

test('fetchQuoteBatch：附带盘中估值（FundValuationLast 批量），估值源失败不影响净值', async () => {
  const VALUATION = {
    success: true,
    data: [
      {
        FCODE: '110020',
        GSZ: '1.8657',
        GSZZL: '0.10',
        GZTIME: '2026-09-03 14:30',
        NAV: '1.8638',
        PDATE: '2026-09-02',
      },
    ],
  };
  const fn = async (url) => {
    if (url.includes('f10/lsjz')) return { ok: true, status: 200, text: async () => LSJZ_OK };
    if (url.includes('FundValuationLast'))
      return { ok: true, status: 200, json: async () => VALUATION };
    return { ok: false, status: 404 };
  };
  const ds = createDatasource({ fetchFn: fn, intervalMs: 0 });
  const r = await ds.fetchQuoteBatch(['110020']);
  assert.equal(r.quotes.length, 1);
  assert.deepEqual(r.quotes[0].estimate, {
    nav: 1.8657,
    change_pct: 0.1,
    time: '2026-09-03 14:30',
  });
});

test('fetchQuoteBatch：批量估值缺失时新浪兜底；两源皆无 → estimate null', async () => {
  const SINA_OK = {
    result: {
      status: { code: 0 },
      data: {
        networth: [
          {
            pre_nav: '1.9',
            pre_nav2: '1.901',
            growthrate: 0.001,
            growthrate2: '0.0015',
            pre_date: '2026-09-03',
            min_time: '10:00:00',
          },
        ],
      },
    },
  };
  const fn = async (url) => {
    if (url.includes('f10/lsjz')) return { ok: true, status: 200, text: async () => LSJZ_OK };
    if (url.includes('FundValuationLast'))
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
    if (url.includes('symbol=110020')) return { ok: true, status: 200, json: async () => SINA_OK };
    if (url.includes('symbol=161017'))
      return { ok: true, status: 200, json: async () => ({ result: { data: { networth: [] } } }) };
    return { ok: false, status: 404 };
  };
  const ds = createDatasource({ fetchFn: fn, intervalMs: 0 });
  const r = await ds.fetchQuoteBatch(['110020', '161017']);
  const q1 = r.quotes.find((q) => q.code === '110020');
  const q2 = r.quotes.find((q) => q.code === '161017');
  assert.deepEqual(q1.estimate, { nav: 1.9, change_pct: 0.1, time: '2026-09-03 10:00:00' });
  assert.equal(q2.estimate, null);
});

test('fetchQuoteBatch：在场但无估值且为 QDII → 不走新浪兜底；国内基金无估值 → 仍走新浪', async () => {
  const VALUATION = {
    success: true,
    data: [
      {
        FCODE: '110020',
        SHORTNAME: '演示沪深300ETF联接A',
        GSZ: '1.8657',
        GSZZL: '0.10',
        GZTIME: '2026-09-03 14:30',
      },
      { FCODE: '110026', SHORTNAME: '演示全球QDII', GSZ: null, GSZZL: null, GZTIME: null }, // QDII：在场但无估值
      { FCODE: '161017', SHORTNAME: '演示医疗健康混合C', GSZ: null, GSZZL: null, GZTIME: null }, // 国内：无估值但可走新浪
    ],
  };
  const SINA_OK = {
    result: {
      status: { code: 0 },
      data: {
        networth: [
          {
            pre_nav: '1.9',
            pre_nav2: '1.901',
            growthrate: 0.001,
            growthrate2: '0.0015',
            pre_date: '2026-09-03',
            min_time: '10:00:00',
          },
        ],
      },
    },
  };
  const sinaCalled = [];
  const fn = async (url) => {
    if (url.includes('f10/lsjz')) return { ok: true, status: 200, text: async () => LSJZ_OK };
    if (url.includes('FundValuationLast'))
      return { ok: true, status: 200, json: async () => VALUATION };
    if (url.includes('sina.com.cn')) {
      sinaCalled.push(url);
      return { ok: true, status: 200, json: async () => SINA_OK };
    }
    return { ok: false, status: 404 };
  };
  const ds = createDatasource({ fetchFn: fn, intervalMs: 0 });
  const r = await ds.fetchQuoteBatch(['110020', '110026', '161017']);
  const q1 = r.quotes.find((q) => q.code === '110020');
  const q2 = r.quotes.find((q) => q.code === '110026');
  const q3 = r.quotes.find((q) => q.code === '161017');
  assert.ok(q1.estimate);
  assert.equal(q2.estimate, null); // QDII 不打新浪（新浪对 QDII 的估值滞后失真）
  assert.ok(q3.estimate); // 国内基金无估值 → 新浪兜底
  assert.deepEqual(
    sinaCalled.map((u) => u.includes('symbol=161017')),
    [true],
  );
});

test('fetchIndexes：解析 push2 指数点位/涨跌幅/行情时间戳（含纳斯达克与恒生）', async () => {
  const PUSH2 = JSON.stringify({
    data: {
      diff: [
        { f12: '000300', f14: '沪深300', f2: 4609.18, f3: -0.46, f124: 1788509302 },
        { f12: '000905', f14: '中证500', f2: 5234.4, f3: 0.31, f124: 1788509302 },
        { f12: 'NDX', f14: '纳斯达克', f2: 26584.06, f3: -0.29, f124: 1788552000 },
        { f12: 'HSI', f14: '恒生指数', f2: 25650.87, f3: 1.74, f124: 1788509302 },
      ],
    },
  });
  const ds = createDatasource({ fetchFn: fakeFetch([['push2.eastmoney.com', PUSH2]]) });
  const idx = await ds.fetchIndexes();
  assert.deepEqual(
    idx.map((i) => i.name),
    ['沪深300', '中证500', '纳斯达克', '恒生指数'],
  );
  assert.equal(idx[0].change_pct, -0.46);
  assert.equal(idx[1].price, 5234.4);
  assert.equal(idx[2].time, 1788552000);
});

test('fetchFundSearch：按名称搜索返回 {code,name} 候选，key 正确编码进 URL', async () => {
  const SEARCH_OK = JSON.stringify({
    ErrCode: 0,
    Datas: [
      { CODE: '110025', NAME: '演示全球科技精选(QDII)A' },
      { CODE: '110026', NAME: '演示全球科技精选(QDII)C' },
    ],
  });
  const log = [];
  const ds = createDatasource({ fetchFn: fakeFetch([['FundSearchAPI.ashx', SEARCH_OK]], log) });
  const r = await ds.fetchFundSearch('演示全球科技');
  assert.deepEqual(r.results, [
    { code: '110025', name: '演示全球科技精选(QDII)A' },
    { code: '110026', name: '演示全球科技精选(QDII)C' },
  ]);
  assert.ok(log[0].url.includes(`key=${encodeURIComponent('演示全球科技')}`));
});

test('fetchFundSearch：业务码异常（HTTP 仍 200）或响应非 JSON → 抛错', async () => {
  const err = createDatasource({
    fetchFn: fakeFetch([['FundSearchAPI.ashx', JSON.stringify({ ErrCode: -1, Datas: [] })]]),
  });
  await assert.rejects(() => err.fetchFundSearch('任意基金'));
  const bad = createDatasource({
    fetchFn: fakeFetch([['FundSearchAPI.ashx', '<html>网关超时</html>']]),
  });
  await assert.rejects(() => bad.fetchFundSearch('任意基金'));
  // 非法代码候选被过滤后为空结果不抛错
  const junk = createDatasource({
    fetchFn: fakeFetch([
      ['FundSearchAPI.ashx', JSON.stringify({ ErrCode: 0, Datas: [{ CODE: 'abc', NAME: 'x' }] })],
    ]),
  });
  assert.deepEqual((await junk.fetchFundSearch('任意基金')).results, []);
});

test('fetchFundNames：按代码精确匹配官方名；未命中/接口异常跳过不拖垮整批', async () => {
  const byKey = {
    110020: JSON.stringify({
      ErrCode: 0,
      Datas: [
        { CODE: '110020', NAME: '演示沪深300ETF联接A' },
        { CODE: '110022', NAME: '演示沪深300ETF联接C' },
      ],
    }),
    161017: JSON.stringify({ ErrCode: 0, Datas: [] }), // 无结果
    999999: '<html>网关超时</html>', // 非 JSON
  };
  const fn = async (url) => {
    const key = decodeURIComponent(new URL(url).searchParams.get('key'));
    return { ok: true, status: 200, text: async () => byKey[key] ?? '{}' };
  };
  const ds = createDatasource({ fetchFn: fn });
  const r = await ds.fetchFundNames(['110020', '161017', '999999', '888888']);
  // 只精确匹配同名代码（110022 不能串进来）
  assert.deepEqual(r.names, { 110020: '演示沪深300ETF联接A' });
});

// ---- fetchHistory 蛋卷备源回退 ----

test('fetchHistory：lsjz 被反爬挡（返回空页）→ 降级蛋卷备源，acc_nav=null、source=danjuan', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['f10/lsjz', EMPTY_PAGE],
      ['nav/history', DJ_HISTORY],
    ]),
  });
  const h = await ds.fetchHistory('110020', 3);
  assert.equal(h.source, 'danjuan');
  assert.equal(h.series.length, 3);
  assert.equal(h.series[0].date, '2026-08-26'); // 升序
  assert.equal(h.series[2].nav, 1.8874);
  assert.equal(h.series[2].acc_nav, null); // 蛋卷无累计净值 → 分红检测停用
  assert.equal(h.series[2].change_pct, -0.41); // percentage 优先，相邻差值兜底
});

test('fetchHistory：主源正常时不走备源（source=eastmoney，行为不变）', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['f10/lsjz', LSJZ_OK],
      ['nav/history', DJ_HISTORY],
    ]),
  });
  const h = await ds.fetchHistory('110020', 3);
  assert.equal(h.source, 'eastmoney');
  assert.equal(h.series[2].acc_nav, 1.05);
});

test('fetchHistory：双源全挂 → 抛错（蛋卷错误信息）', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['f10/lsjz', EMPTY_PAGE],
      ['nav/history', EMPTY_PAGE],
    ]),
  });
  await assert.rejects(() => ds.fetchHistory('110020', 3), /蛋卷历史无数据/);
});

// ---- 数据健康块：埋点 spy 用例 ----

/** 构造带 recordSource spy 的 datasource；spy 记录全部埋点调用 */
function dsWithSpy(routes, spy) {
  return createDatasource({
    fetchFn: fakeFetch(routes),
    recordSource: (...args) => {
      spy.push(args);
    },
  });
}

test('埋点：fetchIndexes 主源成功记一次；主备皆败 → push2 与 sina 各记一次失败）', async () => {
  const spy = [];
  const ok = dsWithSpy(
    [
      [
        'push2.eastmoney.com/api/qt/ulist',
        JSON.stringify({
          data: {
            diff: [{ f12: '000300', f14: '沪深300', f2: 4548.05, f3: -0.1, f124: 1756977071 }],
          },
        }),
      ],
    ],
    spy,
  );
  await ok.fetchIndexes();
  assert.deepEqual(spy, [['push2', true, null]]);
  spy.length = 0;
  // 主源 500 + 新浪无路由（404 → 视为失败）→ 两个源各如实记一次失败
  const bad = dsWithSpy([['push2.eastmoney.com/api/qt/ulist', '坏响应', 500]], spy);
  await assert.rejects(() => bad.fetchIndexes());
  assert.equal(spy.length, 2);
  assert.equal(spy[0][0], 'push2');
  assert.equal(spy[0][1], false);
  assert.ok(spy[0][2] instanceof Error);
  assert.equal(spy[1][0], 'sina');
  assert.equal(spy[1][1], false);
  assert.ok(spy[1][2] instanceof Error);
});

test('埋点 lsjz：fetchHistory 主源成功不带 fallback、备源成功带 fallback、主备皆败报 fail', async () => {
  const spy = [];
  // 主源成功
  const main = dsWithSpy([['api.fund.eastmoney.com/f10/lsjz', LSJZ_OK]], spy);
  await main.fetchHistory('110020', 3);
  assert.deepEqual(spy[0], ['lsjz', true, null]);
  spy.length = 0;
  // 主源失败 + 备源成功 → meta.fallback
  const fb = dsWithSpy(
    [
      ['api.fund.eastmoney.com/f10/lsjz', LSJZ_ERR],
      ['danjuanfunds.com/djapi/fund/nav/history', DJ_HISTORY],
    ],
    spy,
  );
  await fb.fetchHistory('110020', 3);
  assert.deepEqual(spy[0], ['lsjz', true, null, { fallback: true }]);
  spy.length = 0;
  // 主备皆败
  const both = dsWithSpy(
    [
      ['api.fund.eastmoney.com/f10/lsjz', LSJZ_ERR],
      ['danjuanfunds.com/djapi/fund/nav/history', 'x', 500],
    ],
    spy,
  );
  await assert.rejects(() => both.fetchHistory('110020', 3));
  assert.equal(spy.length, 1);
  assert.equal(spy[0][0], 'lsjz');
  assert.equal(spy[0][1], false);
});

test('埋点 estimate：任一批次 200 即 ok；全部批次失败记 fail；空列表不埋点', async () => {
  const spy = [];
  const ok = dsWithSpy([['FundValuationLast', JSON.stringify({ Datas: [], ErrCode: 0 })]], spy);
  await ok.fetchValuationLast(['110020']);
  assert.deepEqual(spy, [['estimate', true, null]]);
  spy.length = 0;
  const bad = dsWithSpy([['FundValuationLast', 'x', 500]], spy);
  await bad.fetchValuationLast(['110020']);
  assert.equal(spy.length, 1);
  assert.equal(spy[0][0], 'estimate');
  assert.equal(spy[0][1], false);
  assert.ok(spy[0][2] instanceof Error);
  spy.length = 0;
  const empty = dsWithSpy([], spy);
  await empty.fetchValuationLast([]);
  assert.equal(spy.length, 0); // 空列表不触发任何埋点
});

test('埋点 sina：HTTP 通即 ok（无估值不算失败）、HTTP 失败记 fail、未调用不埋点', async () => {
  const spy = [];
  const ok = dsWithSpy(
    [
      [
        'FdFundService.getEstimateNetworthPic',
        JSON.stringify({ result: { status: { code: 0 }, data: {} } }),
      ],
    ],
    spy,
  );
  await ok.fetchSinaEstimate('110020');
  assert.deepEqual(spy, [['sina', true, null]]);
  spy.length = 0;
  const bad = dsWithSpy([['FdFundService.getEstimateNetworthPic', 'x', 500]], spy);
  await bad.fetchSinaEstimate('110020');
  assert.equal(spy.length, 1);
  assert.equal(spy[0][0], 'sina');
  assert.equal(spy[0][1], false);
});

test('埋点不反噬业务：recordSource 抛异常时 fetchQuote 照常返回', async () => {
  const routes = [['api.fund.eastmoney.com/f10/lsjz', LSJZ_OK]];
  const boom = () => {
    throw new Error('spy 崩了');
  };
  const ds = createDatasource({ fetchFn: fakeFetch(routes), recordSource: boom });
  const q = await ds.fetchQuote('110020');
  assert.equal(q.code, '110020'); // 业务结果不受埋点异常影响
});

// ---- 外部数据源超时熔断 ----

/** 尊重 signal 的假 fetch：mode='timeout' 的路由挂起直到 abort（cause.name=AbortError，undici 形态） */
function abortableFetch(routes) {
  return (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const hit = routes.find(([pat]) => url.includes(pat));
      if (!hit) {
        resolve({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
        return;
      }
      const [, body, status = 200, mode] = hit;
      if (mode === 'timeout') {
        opts.signal?.addEventListener('abort', () => {
          const err = new TypeError('fetch failed');
          err.cause = { name: 'AbortError' };
          reject(err);
        });
        return; // 挂起直到 abort
      }
      resolve({
        ok: status < 400,
        status,
        text: async () => body,
        json: async () => JSON.parse(body),
      });
    });
}

test('isAbortError：四种形态全判（name/cause × AbortError/TimeoutError）', () => {
  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.equal(isAbortError({ name: 'TimeoutError' }), true);
  const t1 = new TypeError('fetch failed');
  t1.cause = { name: 'AbortError' };
  assert.equal(isAbortError(t1), true);
  const t2 = new TypeError('fetch failed');
  t2.cause = { name: 'TimeoutError' };
  assert.equal(isAbortError(t2), true);
  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(null), false);
});

test('超时熔断：主源超时 → 备源成功返回（超时与网络错误同走降级，健康埋点带 fallback）', async () => {
  const spy = [];
  const ds = createDatasource({
    fetchFn: abortableFetch([
      ['api.fund.eastmoney.com/f10/lsjz', '', 200, 'timeout'],
      ['danjuanfunds.com/djapi/fund/nav/history', DJ_HISTORY],
    ]),
    recordSource: (...a) => spy.push(a),
    timeouts: { lsjzPage: 30, quote: 30 },
  });
  const q = await ds.fetchQuote('110020');
  assert.equal(q.code, '110020');
  assert.equal(spy[0][0], 'lsjz');
  assert.equal(spy[0][1], true);
  assert.deepEqual(spy[0][3], { fallback: true }); // 备源成功 = 成功的降级
});

test('超时熔断：主备皆超时 → 抛 AbortError 且健康埋点标注"超时"', async () => {
  const spy = [];
  const ds = createDatasource({
    fetchFn: abortableFetch([
      ['api.fund.eastmoney.com/f10/lsjz', '', 200, 'timeout'],
      ['danjuanfunds.com/djapi/fund/nav/history', '', 200, 'timeout'],
    ]),
    recordSource: (...a) => spy.push(a),
    timeouts: { lsjzPage: 30, quote: 30 },
  });
  await assert.rejects(
    () => ds.fetchHistory('110020', 3),
    (e) => isAbortError(e),
  );
  assert.equal(spy[0][1], false);
  assert.ok(/超时/.test(spy[0][2].message));
});

test('超时熔断：正常响应不受影响（signal 为多余参数，既有 mock 兼容）', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([['api.fund.eastmoney.com/f10/lsjz', LSJZ_OK]]),
    timeouts: { lsjzPage: 30 },
  });
  const { series } = await ds.fetchHistory('110020', 3);
  assert.equal(series.length, 3);
});

test('超时熔断：headers 已回、body 挂起形态同样被截断', async () => {
  const spy = [];
  const ds = createDatasource({
    fetchFn: (url, opts = {}) =>
      new Promise((resolve, reject) => {
        if (url.includes('FundValuationLast')) {
          // 立即回 headers（200），json() 挂起直到 abort
          opts.signal?.addEventListener('abort', () => {
            const err = new TypeError('fetch failed');
            err.cause = { name: 'AbortError' };
            reject(err);
          });
          resolve({
            ok: true,
            status: 200,
            text: async () => '',
            json: () =>
              new Promise((_, rej) => {
                opts.signal?.addEventListener('abort', () => {
                  const err = new TypeError('fetch failed');
                  err.cause = { name: 'AbortError' };
                  rej(err);
                });
              }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          text: async () => '',
          json: async () => ({}),
        });
      }),
    recordSource: (...a) => spy.push(a),
    timeouts: { estimate: 30 },
  });
  const out = await ds.fetchValuationLast(['110020']); // 超时后应静默降级为无估值，不抛
  assert.deepEqual(out.estimates, {});
  assert.equal(spy[0][0], 'estimate');
  assert.equal(spy[0][1], false);
  assert.ok(/超时/.test(spy[0][2].message)); // 埋点标注"超时"
});

// ---- 指数新浪备源降级（push2 遭 IP 级封锁时指数卡不再陈旧）----

test('fetchIndexes：push2 连续失败 3 次 → 熔断（冷却期内不再打扰 push2，直接走新浪备源）', async () => {
  const log = [];
  const spy = [];
  let t = 0;
  const ds = createDatasource({
    fetchFn: fakeFetch(
      [
        ['push2.eastmoney.com', '坏响应', 500],
        ['hq.sinajs.cn', SINA_IDX_BODY],
      ],
      log,
    ),
    now: () => new Date(1700000000000 + t),
    recordSource: (...args) => {
      spy.push(args);
    },
  });
  const push2Calls = () => log.filter((c) => c.url.includes('push2.eastmoney.com')).length;
  const sinaCalls = () => log.filter((c) => c.url.includes('hq.sinajs.cn')).length;
  // 前 3 次：每次都探测 push2（失败照常上报）→ 走备源；第 3 次触发熔断
  for (let i = 0; i < 3; i++) {
    const r = await ds.fetchIndexes();
    assert.equal(r.length, 3); // 备源数据照常返回（SINA_IDX_BODY 解析出 3 只）
  }
  assert.equal(push2Calls(), 3);
  assert.equal(sinaCalls(), 3);
  // 熔断摘要写明"已暂停自动重试"（健康条 tooltip 可见）
  const lastFail = spy.filter((s) => s[0] === 'push2' && s[1] === false).pop();
  assert.ok(/已暂停自动重试/.test(lastFail[2].message));
  // 第 4 次：冷却期内 → 一次 push2 请求都不发，直接走新浪
  log.length = 0;
  await ds.fetchIndexes();
  assert.equal(push2Calls(), 0);
  assert.equal(sinaCalls(), 1);
  // 冷却结束（+16 分钟 > 默认 15 分钟）→ 放行一次探测
  t += 16 * 60 * 1000;
  log.length = 0;
  await ds.fetchIndexes();
  assert.equal(push2Calls(), 1);
});

test('fetchIndexes：resetIndexBreaker 复位熔断 → 立即重探主源（运维"立即重试主源"入口）', async () => {
  const log = [];
  let t = 0;
  const ds = createDatasource({
    fetchFn: fakeFetch(
      [
        ['push2.eastmoney.com', '坏响应', 500],
        ['hq.sinajs.cn', SINA_IDX_BODY],
      ],
      log,
    ),
    now: () => new Date(1700000000000 + t),
  });
  const push2Calls = () => log.filter((c) => c.url.includes('push2.eastmoney.com')).length;
  for (let i = 0; i < 3; i++) await ds.fetchIndexes(); // 3 连败 → 熔断
  log.length = 0;
  await ds.fetchIndexes();
  assert.equal(push2Calls(), 0); // 冷却期内不发 push2
  ds.resetIndexBreaker(); // 运维复位（等价于 /api/index?refresh=1）
  log.length = 0;
  await ds.fetchIndexes();
  assert.equal(push2Calls(), 1); // 复位后立即重探主源
});

const SINA_IDX_BODY = [
  'var hq_str_sh000300="沪深300,4550.1865,4572.5995,4548.3898,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-09-10,15:40:14,00,";',
  'var hq_str_gb_ndx="纳斯达克100,29205.8206,-0.73,2026-09-10 22:47:21,-206.4797";',
  'var hq_str_int_hangseng="恒生指数,24954.47,-320.49,-1.27";',
].join('\n');

test('fetchIndexes：push2 失败 → 新浪备源降级（同构输出 + Referer 头 + $ 原样不编码）', async () => {
  const log = [];
  const ds = createDatasource({
    fetchFn: fakeFetch(
      [
        ['push2.eastmoney.com', '坏响应', 500],
        ['hq.sinajs.cn', SINA_IDX_BODY],
      ],
      log,
    ),
  });
  const idx = await ds.fetchIndexes();
  // 与 push2 同构：code/name/price/change_pct/time；顺序跟随 specs，缺失的只跳过
  assert.deepEqual(
    idx.map((i) => i.code),
    ['000300', 'NDX', 'HSI'],
  );
  assert.equal(idx[0].name, '沪深300'); // 名称用 specs 标准名（不取新浪返回名）
  assert.equal(idx[0].price, 4548.3898);
  assert.equal(idx[1].change_pct, -0.73);
  assert.equal(idx[2].time, null); // 港股 int_ 无时间字段
  // 请求形态：Referer 必带（无则 Forbidden）；$ 原样（%24 实测返回空）
  const call = log.find((c) => c.url.includes('hq.sinajs.cn'));
  assert.equal(call.headers.Referer, 'https://finance.sina.com.cn/');
  assert.ok(call.url.includes('gb_$ixic') && !call.url.includes('%24'));
});

test('fetchIndexes：主备皆败 → 抛错（新浪错误信息），push2 主源成功时不打新浪', async () => {
  const log = [];
  const bad = createDatasource({
    fetchFn: fakeFetch(
      [
        ['push2.eastmoney.com', '坏响应', 500],
        ['hq.sinajs.cn', '', 403],
      ],
      log,
    ),
  });
  await assert.rejects(() => bad.fetchIndexes(), /hq\.sinajs\.cn/);
  // 主源成功：新浪一次都不打
  const log2 = [];
  const ok = createDatasource({
    fetchFn: fakeFetch(
      [
        [
          'push2.eastmoney.com',
          JSON.stringify({
            data: {
              diff: [{ f12: '000300', f14: '沪深300', f2: 4548.05, f3: -0.1, f124: 1756977071 }],
            },
          }),
        ],
        ['hq.sinajs.cn', SINA_IDX_BODY],
      ],
      log2,
    ),
  });
  const idx = await ok.fetchIndexes();
  assert.equal(idx.length, 1);
  assert.equal(
    log2.some((c) => c.url.includes('hq.sinajs.cn')),
    false,
  );
});

test('埋点：指数降级 → push2 如实记失败、新浪备源成功记到 sina 键（健康条"新浪备源"）', async () => {
  const spy = [];
  const fb = dsWithSpy(
    [
      ['push2.eastmoney.com', '坏响应', 500],
      ['hq.sinajs.cn', SINA_IDX_BODY],
    ],
    spy,
  );
  await fb.fetchIndexes();
  assert.equal(spy.length, 2);
  assert.equal(spy[0][0], 'push2');
  assert.equal(spy[0][1], false); // 主源失败不再被备源成功掩盖
  assert.ok(spy[0][2] instanceof Error);
  assert.deepEqual(spy[1], ['sina', true, null]); // 备源成功记在新浪键
  spy.length = 0;
  const ok = dsWithSpy(
    [
      [
        'push2.eastmoney.com',
        JSON.stringify({
          data: { diff: [{ f12: '000300', f14: '沪深300', f2: 1, f3: 0.1, f124: 1 }] },
        }),
      ],
    ],
    spy,
  );
  await ok.fetchIndexes();
  assert.deepEqual(spy, [['push2', true, null]]); // 主源成功：3 参形态、不打新浪
});

// ---- 实时估值盘「当天估值走势」：fetchEstimateCurve ----

const SINA_CURVE_BODY = JSON.stringify({
  result: {
    status: { code: 0 },
    data: {
      worth: '1.8653',
      worth_date: '20260910',
      time_range: [
        ['09:30', '11:30'],
        ['13:00', '15:00'],
      ],
      networth: [
        {
          symbol: '110020',
          min_time: '09:30:00',
          pre_nav: '1.8522',
          nav_pct: '-0.7008',
          growthrate: -0.007008,
          pre_nav2: '9.9',
          growthrate2: '-0.5',
          pre_date: '2026-09-11',
        },
        {
          symbol: '110020',
          min_time: '11:30:00',
          pre_nav: '1.8373',
          nav_pct: '-1.4995',
          growthrate: -0.014995,
          pre_nav2: '9.9',
          growthrate2: '-0.5',
          pre_date: '2026-09-11',
        },
        {
          symbol: '110020',
          min_time: '11:32:00',
          pre_nav: '1.8374',
          nav_pct: '-1.4960',
          growthrate: -0.01496,
          pre_nav2: '9.9',
          growthrate2: '-0.5',
          pre_date: '2026-09-11',
        },
      ],
    },
  },
});

test('fetchEstimateCurve：解析当天曲线（尾巴 tick 11:32 被剔），worth/worth_date 归一', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([['getEstimateNetworthPic', SINA_CURVE_BODY]]),
  });
  const r = await ds.fetchEstimateCurve('110020', { today: '2026-09-11' });
  assert.deepEqual(
    r.points.map((p) => p.t),
    ['09:30', '11:30'],
  );
  assert.equal(r.points[0].nav, 1.8522);
  assert.equal(r.worth, 1.8653);
  assert.equal(r.worthDate, '2026-09-10');
  assert.equal(r.droppedOtherDay, false);
});

test('fetchEstimateCurve：today 注入生效——传别的日期则点全被丢弃（不画昨天的曲线）', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([['getEstimateNetworthPic', SINA_CURVE_BODY]]),
  });
  const r = await ds.fetchEstimateCurve('110020', { today: '2026-09-10' });
  assert.deepEqual(r.points, []);
  assert.equal(r.droppedOtherDay, true);
});

test('fetchEstimateCurve：HTTP 500 → 抛错（信息含主机名，供路由转 502）', async () => {
  const ds = createDatasource({ fetchFn: fakeFetch([['getEstimateNetworthPic', 'boom', 500]]) });
  await assert.rejects(
    () => ds.fetchEstimateCurve('110020', { today: '2026-09-11' }),
    /stock\.finance\.sina\.com\.cn/,
  );
});

test('fetchEstimateCurve：无曲线（networth: []）→ 空 points 且不抛', async () => {
  const body = JSON.stringify({
    result: { data: { worth: '2.1109', worth_date: '20260909', networth: [] } },
  });
  const ds = createDatasource({ fetchFn: fakeFetch([['getEstimateNetworthPic', body]]) });
  const r = await ds.fetchEstimateCurve('110026', { today: '2026-09-11' });
  assert.deepEqual(r.points, []);
  assert.equal(r.worth, 2.1109);
});

// ===== 核心指数「当天迷你分时」取数 =====

const EM_TRENDS = (pre, lines) => JSON.stringify({ data: { preClose: pre, trends: lines } });
test('fetchIndexSparksForMarket：A 股走东财（含集合竞价剔除后的抽稀）、HXC 无源不发请求', async () => {
  const log = [];
  // 上午 121 点 + 下午 120 点（每点 +1），并塞入集合竞价与盘后尾巴
  const lines = [];
  for (let m = 555; m <= 690; m++)
    lines.push(
      `2026-09-11 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},${4400 + (m - 555)}`,
    );
  for (let m = 781; m <= 900; m++)
    lines.push(
      `2026-09-11 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},${4536 + (m - 781)}`,
    );
  lines.push('2026-09-11 15:01,9999');
  const fetchFn = fakeFetch([['push2his.eastmoney.com', EM_TRENDS(4400, lines)]], log);
  const ds = createDatasource({ fetchFn, now: () => new Date('2026-09-11T08:00:00Z') });
  const cn = await ds.fetchIndexSparksForMarket('cn');
  assert.equal(cn.ok, true);
  assert.equal(cn.items.length, 6);
  assert.ok(cn.items.every((i) => i.spark.length === 48));
  assert.equal(cn.items[0].code, '000300');
  assert.equal(cn.items[0].spark[0][0], '09:30'); // 集合竞价被剔
  assert.equal(cn.items[0].spark[47][0], '15:00'); // 盘后尾巴被剔
  assert.equal(cn.items[0].session_date, '2026-09-11'); // 北京日（now 注入 → 与运行时时区无关）
  assert.equal(cn.items[0].spark[0][1], 0.3409); // 首点 4415 vs 昨收 4400 → +0.3409%（09:15 竞价点已剔）
  const us = await ds.fetchIndexSparksForMarket('us');
  const hxc = us.items.find((i) => i.code === 'HXC');
  assert.equal(hxc.empty_reason, 'no_source');
  assert.equal(hxc.spark, null);
  assert.equal(
    log.some((l) => l.url.includes('hxc')),
    false,
  ); // 无源 → 一次请求都不发
});

test('fetchIndexSparksForMarket：东财失败逐只降级腾讯；单只坏响应不影响同市场其余', async () => {
  const log = [];
  const tLines = ['0930 4514.30 1 1', '1130 4510.00 1 1', '1301 4509.50 1 1', '1500 4508.68 1 1'];
  const tc = (code, pre) =>
    JSON.stringify({
      data: { [code]: { data: { data: tLines }, qt: { [code]: ['1', 'x', 'x', '4508.68', pre] } } },
    });
  // 东财整站失败（502）→ 每只都应改走腾讯
  const fetchFn = fakeFetch(
    [
      ['push2his.eastmoney.com', 'error', 502],
      ['sh000300', tc('sh000300', '4500')],
      ['sh000905', tc('sh000905', '4500')],
      ['sh000001', tc('sh000001', '4500')],
      ['sz399001', tc('sz399001', '4500')],
      ['sz399006', tc('sz399006', '4500')],
      ['sh000688', 'not-json'], // 该只两源都坏 → 仅它 fetch_failed
    ],
    log,
  );
  const ds = createDatasource({ fetchFn });
  const cn = await ds.fetchIndexSparksForMarket('cn');
  assert.equal(cn.ok, true);
  const bad = cn.items.filter((i) => i.empty_reason === 'fetch_failed');
  assert.deepEqual(
    bad.map((i) => i.code),
    ['000688'],
  ); // 只坏一只
  assert.equal(cn.items.filter((i) => i.spark).length, 5);
  assert.ok(cn.items.find((i) => i.code === '000300').spark.length === 4);
  // 逐只降级：每只先打东财、失败后打腾讯（可证"逐只"而非"整批切换"）
  assert.equal(log.filter((l) => l.url.includes('push2his')).length, 6);
  assert.equal(log.filter((l) => l.url.includes('gtimg')).length, 6);
});

test('fetchIndexSparksForMarket：美股昨收以「前一日分组末值」为准，gb_ 显式值只作兜底', async () => {
  const bar = (d, c) => ({
    d,
    o: String(c),
    h: String(c),
    l: String(c),
    c: String(c),
    v: '1',
    a: '0',
  });
  const usRaw =
    'var t=(' +
    JSON.stringify([
      bar('2026-09-09 16:00:00', 100),
      bar('2026-09-10 09:31:00', 104),
      bar('2026-09-10 16:00:00', 105),
    ]) +
    ');';
  // 快照给的是开盘前形态：涨跌额已清零 → `现价 − 涨跌额` 会等于会话自身收盘（105），不可当昨收
  const hqZeroed =
    'var hq_str_gb_ndx="纳斯达克100,105.0000,0.00,2026-09-11 09:43:22,0.0000,x";' +
    'var hq_str_gb_$ixic="纳斯达克,105.0000,0.00,2026-09-11 09:43:22,0.0000,x";' +
    'var hq_str_gb_$sox="费城半导体,105.0000,0.00,2026-09-11 09:43:22,0.0000,x";';
  const ds1 = createDatasource({
    fetchFn: fakeFetch([
      ['hq.sinajs.cn', hqZeroed],
      ['US_MinKService', usRaw],
    ]),
  });
  const us1 = await ds1.fetchIndexSparksForMarket('us');
  const ndx = us1.items.find((i) => i.code === 'NDX');
  assert.equal(ndx.session_date, '2026-09-10'); // 美东会话日
  assert.equal(ndx.pre_close, 100); // ★ 前一日末值（不是 105 = 会话自身收盘）
  assert.ok(ndx.last_pct > 0 && ndx.last_pct < 6); // 曲线回到真实量级（不再是 ~0 的塌陷）
  assert.equal(ndx.spark[ndx.spark.length - 1][1], 5); // (105 − 100)/100 = +5%
  // 窗口里没有前一日（只有一天）→ 才用 gb_ 显式兜底
  const oneDay =
    'var t=(' +
    JSON.stringify([bar('2026-09-10 09:31:00', 104), bar('2026-09-10 16:00:00', 105)]) +
    ');';
  const ds2 = createDatasource({
    fetchFn: fakeFetch([
      [
        'hq.sinajs.cn',
        'var hq_str_gb_ndx="纳斯达克100,105.0000,-1.00,2026-09-11 09:43:22,-1.0600,x";'.repeat(1) +
          'var hq_str_gb_$ixic="纳斯达克,105.0000,0.00,2026-09-11 09:43:22,0.0000,x";var hq_str_gb_$sox="费城半导体,105.0000,0.00,2026-09-11 09:43:22,0.0000,x";',
      ],
      ['US_MinKService', oneDay],
    ]),
  });
  const us2 = await ds2.fetchIndexSparksForMarket('us');
  assert.equal(us2.items.find((i) => i.code === 'NDX').pre_close, 105 + 1.06); // 兜底：gb_ 显式（105 − (−1.06)）
  assert.equal(us2.ok, true);
});

test('fetchIndexSparksForMarket：全市场都拿不到 → ok=false 且不抛（路由据此转 502/负缓存）', async () => {
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['push2his', 'x', 500],
      ['gtimg', 'x', 500],
    ]),
  });
  const cn = await ds.fetchIndexSparksForMarket('cn');
  assert.equal(cn.ok, false);
  assert.equal(cn.items.length, 6);
  assert.ok(cn.items.every((i) => i.spark === null && i.empty_reason === 'fetch_failed'));
});

test('fetchIndexes：push2 连续失败 → 暂停时长递进并封顶（限制连续请求次数、避免被更严封）', async () => {
  const spy = [];
  let t = 0;
  const ds = createDatasource({
    fetchFn: fakeFetch([
      ['push2.eastmoney.com', '坏响应', 500],
      ['hq.sinajs.cn', SINA_IDX_BODY],
    ]),
    now: () => new Date(1700000000000 + t),
    recordSource: (...args) => {
      spy.push(args);
    },
  });
  const minutesSeen = [];
  // 每轮先把时钟推过任何冷却（7 小时 > 封顶 6 小时）→ 每次都是"真探测 + 失败"，正好走完递进阶梯。
  // 前两次失败尚未触发熔断（摘要里没有"暂停自动重试"）→ 只收集带摘要的那几次。
  for (let i = 0; i < 9; i++) {
    t += 7 * 60 * 60 * 1000;
    await ds.fetchIndexes();
    const trips = spy.filter(
      (s) => s[0] === 'push2' && s[1] === false && /暂停自动重试/.test(s[2].message),
    );
    if (trips.length)
      minutesSeen.push(Number(trips.pop()[2].message.match(/暂停自动重试 (\d+) 分钟/)[1]));
  }
  assert.deepEqual(minutesSeen, [15, 30, 60, 120, 240, 360, 360]); // 第 3 次起 15 分钟、逐次翻倍、封顶 6 小时
  // 人工入口仍能立刻复位（计数清零 → 重新从 15 分钟档起步；复位后前两次失败还不触发熔断）
  ds.resetIndexBreaker();
  for (let i = 0; i < 3; i++) {
    t += 7 * 60 * 60 * 1000;
    await ds.fetchIndexes();
  }
  const after = spy
    .filter((s) => s[0] === 'push2' && s[1] === false && /暂停自动重试/.test(s[2].message))
    .pop();
  assert.equal(Number(after[2].message.match(/暂停自动重试 (\d+) 分钟/)[1]), 15);
});
