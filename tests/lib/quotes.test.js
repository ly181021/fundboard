import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFundgz,
  computeChangePct,
  buildQuote,
  parseValuationLast,
  parseSinaEstimate,
  parseSinaIndexes,
  parseSinaCurve,
  SINA_INDEX_SPECS,
  INDEX_SESSIONS,
  SPARK_MAX_POINTS,
  sparkMarketOf,
  sliceJsonp,
  parseEmTrends,
  parseSinaUsMinutes,
  parseTencentMinutes,
  thinBySegment,
  sparkCoversSession,
} from '../../lib/quotes.js';

test('parseFundgz：解析 JSONP 文本为对象', () => {
  const text =
    'jsonpgz({"fundcode":"110020","name":"演示沪深300","jzrq":"2026-08-28","dwjz":"1.2340","gsz":"1.2400","gszzl":"0.49","gztime":"2026-08-30 15:00"});';
  const raw = parseFundgz(text);
  assert.equal(raw.fundcode, '110020');
  assert.equal(raw.dwjz, '1.2340');
  assert.equal(raw.gszzl, '0.49');
});

test('parseFundgz：空响应/坏格式/404页面 返回 null（fundgz 下线后返回 HTML 404 页）', () => {
  assert.equal(parseFundgz(''), null);
  assert.equal(parseFundgz('jsonpgz();'), null);
  assert.equal(parseFundgz('<!doctype html><title>页面未找到 - 东方财富网</title>'), null);
});

test('computeChangePct：涨跌幅计算与除零保护', () => {
  assert.ok(Math.abs(computeChangePct(1.05, 1.03) - 1.9417) < 1e-3);
  assert.equal(computeChangePct(1.05, 0), null);
  assert.equal(computeChangePct(1.05, null), null);
});

test('buildQuote：合并净值序列 → /api/quote 单条结构（源提供涨跌幅优先）', () => {
  const q = buildQuote({
    code: '110020',
    name: null,
    navs: ['1.05', '1.03', '1.02'],
    navDates: ['2026-08-28', '2026-08-27', '2026-08-26'],
    changePcts: ['1.94', '0.98'],
    estimate: null,
    fetchedAt: '2026-08-30T15:01:00+08:00',
    source: 'eastmoney',
  });
  assert.equal(q.nav, 1.05);
  assert.equal(q.nav_date, '2026-08-28');
  assert.equal(q.prev_nav, 1.03);
  assert.equal(q.prev2_nav, 1.02);
  assert.equal(q.change_pct, 1.94);
  assert.equal(q.prev_change_pct, 0.98);
  assert.equal(q.estimate, null);
  assert.equal(q.source, 'eastmoney');
  assert.equal(q.fetched_at, '2026-08-30T15:01:00+08:00');
});

test('buildQuote：源未提供涨跌幅时由相邻净值差补算', () => {
  const q = buildQuote({
    code: 'x',
    name: null,
    navs: ['1.05', '1.03', '1.02'],
    navDates: ['d0', 'd1', 'd2'],
    changePcts: [],
    estimate: null,
    fetchedAt: 't',
    source: 'danjuan',
  });
  assert.ok(q.change_pct > 1.9 && q.change_pct < 2.0);
  assert.ok(q.prev_change_pct > 0.97 && q.prev_change_pct < 0.99);
});

test('buildQuote：净值不足三条时缺省字段为 null，不抛错', () => {
  const q = buildQuote({
    code: 'x',
    name: null,
    navs: ['1.05'],
    navDates: ['d0'],
    changePcts: [],
    estimate: null,
    fetchedAt: 't',
    source: 's',
  });
  assert.equal(q.nav, 1.05);
  assert.equal(q.prev_nav, null);
  assert.equal(q.prev2_nav, null);
  assert.equal(q.prev_change_pct, null);
});

test('buildQuote：无净值数据返回 null', () => {
  assert.equal(
    buildQuote({
      code: 'x',
      name: null,
      navs: [],
      navDates: [],
      changePcts: [],
      estimate: null,
      fetchedAt: 't',
      source: 's',
    }),
    null,
  );
});

// ---- 盘中估值解析（FundValuationLast + 新浪估算）----

test('parseValuationLast：正常响应 → 估值映射 + QDII（在场但估值空）信号', () => {
  const payload = {
    success: true,
    data: [
      {
        FCODE: '110020',
        SHORTNAME: '演示沪深300',
        GSZ: '1.8657',
        GSZZL: '0.10',
        GZTIME: '2026-09-03 14:30',
        NAV: '1.8638',
        PDATE: '2026-09-02',
      },
      {
        FCODE: '110020',
        SHORTNAME: '演示QDII',
        GSZ: null,
        GSZZL: null,
        GZTIME: null,
        NAV: '2.0381',
        PDATE: '2026-09-01',
      },
    ],
  };
  assert.deepEqual(parseValuationLast(payload), {
    estimates: { 110020: { nav: 1.8657, change_pct: 0.1, time: '2026-09-03 14:30' } },
    noEstimateCodes: ['110020'],
  });
});

test('parseValuationLast：失败/非法结构返回空结构', () => {
  assert.deepEqual(parseValuationLast(null), { estimates: {}, noEstimateCodes: [] });
  assert.deepEqual(parseValuationLast({ success: false, data: [] }), {
    estimates: {},
    noEstimateCodes: [],
  });
  assert.deepEqual(
    parseValuationLast({ success: true, data: [{ FCODE: '110020', GSZ: null, GSZZL: null }] }),
    { estimates: {}, noEstimateCodes: [] },
  ); // 名称非 QDII → 不算 QDII 信号（走新浪兜底）
});

test('parseSinaEstimate：取曲线末点（口径 2/3 分别用 pre_nav/growthrate 与 pre_nav2/growthrate2）', () => {
  const payload = {
    result: {
      status: { code: 0 },
      data: {
        networth: [
          {
            symbol: '110020',
            min_time: '09:31:00',
            pre_nav: '1.8500',
            pre_nav2: '1.8505',
            pre_date: '2026-09-03',
            growthrate: 0.001,
            growthrate2: '0.0012',
          },
          {
            symbol: '110020',
            min_time: '14:30:00',
            pre_nav: '1.8657',
            pre_nav2: '1.8661',
            pre_date: '2026-09-03',
            growthrate: 0.00105,
            growthrate2: '0.00155',
          },
        ],
      },
    },
  };
  assert.deepEqual(parseSinaEstimate(payload, 2), {
    nav: 1.8657,
    change_pct: 0.105,
    time: '2026-09-03 14:30:00',
  });
  assert.deepEqual(parseSinaEstimate(payload, 3), {
    nav: 1.8661,
    change_pct: 0.155,
    time: '2026-09-03 14:30:00',
  });
});

test('parseSinaEstimate：非法结构/空曲线返回 null', () => {
  assert.equal(parseSinaEstimate(null), null);
  assert.equal(parseSinaEstimate({ result: { data: {} } }), null);
  assert.equal(parseSinaEstimate({ result: { data: { networth: [] } } }), null);
  assert.equal(
    parseSinaEstimate({ result: { data: { networth: [{ pre_nav: null, growthrate: null }] } } }),
    null,
  );
});

// ---- 指数新浪备源解析（push2 遭 IP 级封锁时的降级数据源）----

const SINA_A =
  'var hq_str_sh000300="沪深300,4550.1865,4572.5995,4548.3898,4569.8328,4533.6586,0,0,146922552,390616200774,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-09-10,15:40:14,00,";';
const SINA_US =
  'var hq_str_gb_$ixic="纳斯达克,26141.3026,-0.43,2026-09-10 22:47:21,-112.0372,26021.0524";';
const SINA_HK = 'var hq_str_int_hangseng="恒生指数,24954.47,-320.49,-1.27";';

test('parseSinaIndexes：A股全量格式——点位 idx3、涨跌幅由昨收 idx2 补算、日期 idx30+时间 idx31 转 Unix 秒', () => {
  const specs = [{ code: '000300', name: '沪深300', varName: 'sh000300', fmt: 'a' }];
  const [r] = parseSinaIndexes(SINA_A, specs);
  assert.equal(r.code, '000300');
  assert.equal(r.name, '沪深300');
  assert.equal(r.price, 4548.3898);
  assert.equal(r.change_pct, computeChangePct(4548.3898, 4572.5995)); // -0.53% 同款口径
  assert.equal(r.time, Math.floor(new Date('2026-09-10T15:40:14').getTime() / 1000)); // 本地时区
});

test('parseSinaIndexes：美股 gb_ 格式——点位 idx1、涨跌幅源侧给 idx2、日期时间 idx3', () => {
  const specs = [{ code: 'IXIC', name: '纳斯达克综合', varName: 'gb_$ixic', fmt: 'us' }];
  const [r] = parseSinaIndexes(SINA_US, specs); // varName 含 $：正则须转义后精确命中
  assert.equal(r.code, 'IXIC');
  assert.equal(r.price, 26141.3026);
  assert.equal(r.change_pct, -0.43);
  assert.equal(r.time, Math.floor(new Date('2026-09-10T22:47:21').getTime() / 1000));
});

test('parseSinaIndexes：港股 int_ 格式——点位 idx1、涨跌幅 idx3、无时间（time=null）', () => {
  const specs = [{ code: 'HSI', name: '恒生指数', varName: 'int_hangseng', fmt: 'hk' }];
  const [r] = parseSinaIndexes(SINA_HK, specs);
  assert.equal(r.price, 24954.47);
  assert.equal(r.change_pct, -1.27);
  assert.equal(r.time, null);
});

test('parseSinaIndexes：缺行/空内容/坏点位跳过——与 push2 坏 secid 同款降级（少一张卡，不出错数据）', () => {
  const specs = SINA_INDEX_SPECS;
  // 只喂 3 行：其余 8 只缺失 → 只返回这 3 只；顺序跟随 specs（与 push2 secids 同序）
  const partial = parseSinaIndexes([SINA_A, SINA_US, SINA_HK].join('\n'), specs);
  assert.deepEqual(
    partial.map((r) => r.code),
    ['000300', 'IXIC', 'HSI'],
  );
  // 空内容行（该只下架/代码无效时新浪返回 ""）→ 跳过不抛
  assert.deepEqual(
    parseSinaIndexes('var hq_str_sh000300="";', [
      { code: '000300', name: 'x', varName: 'sh000300', fmt: 'a' },
    ]),
    [],
  );
  // 非字符串入参 → 空数组
  assert.deepEqual(parseSinaIndexes(null), []);
});

test('SINA_INDEX_SPECS：11 只与 push2 secids 同序同码（前端 marketOfIndex 按 code 映射开市状态）', () => {
  assert.deepEqual(
    SINA_INDEX_SPECS.map((s) => s.code),
    [
      '000300',
      '000905',
      '000001',
      '399001',
      '399006',
      '000688',
      'NDX',
      'IXIC',
      'SOX',
      'HXC',
      'HSI',
    ],
  );
  assert.ok(
    SINA_INDEX_SPECS.every((s) => s.varName && s.name && ['a', 'us', 'hk'].includes(s.fmt)),
  );
});

// ---- 实时估值盘「当天估值走势」：parseSinaCurve ----

/** 构造新浪曲线响应；点用 cpt() 生成 */
const curvePayload = (points, extra = {}) => ({
  result: {
    status: { code: 0 },
    data: {
      worth: '1.8653',
      worth_date: '20260910',
      time_range: [
        ['09:30', '11:30'],
        ['13:00', '15:00'],
      ],
      networth: points,
      ...extra,
    },
  },
});
const cpt = (min_time, pre_nav, growthrate, date = '2026-09-11', nav_pct = null) => ({
  symbol: '110020',
  min_time,
  pre_nav,
  nav_pct,
  pre_nav2: '9.9',
  nav2_pct: '99',
  growthrate,
  growthrate2: '-0.5',
  pre_date: date,
});

test('parseSinaCurve ① 正常样本：升序输出、首尾 t 与口径2 数值正确', () => {
  const r = parseSinaCurve(
    curvePayload([
      cpt('09:30:00', '1.8522', -0.007008, '2026-09-11', '-0.7008'),
      cpt('10:00:00', '1.8450', -0.011, '2026-09-11', '-1.1000'),
      cpt('11:30:00', '1.8373', -0.014995, '2026-09-11', '-1.4995'),
    ]),
    '2026-09-11',
  );
  assert.deepEqual(
    r.points.map((p) => p.t),
    ['09:30', '10:00', '11:30'],
  );
  assert.equal(r.points[0].nav, 1.8522);
  assert.equal(r.points[2].change_pct, -1.4995);
  assert.equal(r.droppedOtherDay, false);
});

test('parseSinaCurve ② 日期校验：非当天点（周末/盘前会拿到上一交易日）全丢并置 droppedOtherDay', () => {
  const r = parseSinaCurve(
    curvePayload([
      cpt('09:30:00', '1.85', -0.007, '2026-09-10'),
      cpt('09:31:00', '1.851', -0.006, '2026-09-10'),
    ]),
    '2026-09-11',
  );
  assert.deepEqual(r.points, []);
  assert.equal(r.droppedOtherDay, true);
});

test('parseSinaCurve ③ 缺 pre_date 的点一律丢弃（fail-visible，不猜日期）', () => {
  const r = parseSinaCurve(curvePayload([cpt('09:30:00', '1.85', -0.007, '')]), '2026-09-11');
  assert.deepEqual(r.points, []);
  assert.equal(r.droppedOtherDay, false); // 缺日期不算"非当天"
});

test('parseSinaCurve ④ 只保留交易时段内的点：11:31/11:32/15:01 剔除，09:30/11:30/13:00/15:00 闭区间保留', () => {
  const r = parseSinaCurve(
    curvePayload([
      cpt('09:29:00', '1.85', -0.007),
      cpt('09:30:00', '1.85', -0.007),
      cpt('11:30:00', '1.83', -0.014),
      cpt('11:31:00', '1.83', -0.014),
      cpt('11:32:00', '1.83', -0.014),
      cpt('13:00:00', '1.84', -0.012),
      cpt('15:00:00', '1.84', -0.012),
      cpt('15:01:00', '1.84', -0.012),
    ]),
    '2026-09-11',
  );
  assert.deepEqual(
    r.points.map((p) => p.t),
    ['09:30', '11:30', '13:00', '15:00'],
  );
});

test('parseSinaCurve ⑤ 只用口径2（反例：不得读 pre_nav2 / nav2_pct / growthrate2）', () => {
  const r = parseSinaCurve(
    curvePayload([
      // pre_nav2=9.9、nav2_pct=99、growthrate2='-0.5' 都是诱饵；正确结果是 1.5 / +1.23
      {
        symbol: '110020',
        min_time: '09:30:00',
        pre_nav: '1.5000',
        nav_pct: '1.2300',
        pre_nav2: '9.9000',
        nav2_pct: '99',
        growthrate: 0.0123,
        growthrate2: '-0.5',
        pre_date: '2026-09-11',
      },
    ]),
    '2026-09-11',
  );
  assert.equal(r.points[0].nav, 1.5);
  assert.equal(r.points[0].change_pct, 1.23);
});

test('parseSinaCurve ⑥ 百分数优先直取 nav_pct（等号断言，杜绝 ×100 浮点尾差）', () => {
  const r = parseSinaCurve(
    curvePayload([cpt('09:30:00', '1.85', -0.007008, '2026-09-11', '-1.2455')]),
    '2026-09-11',
  );
  assert.equal(r.points[0].change_pct, -1.2455); // 严格相等（非近似）
});

test('parseSinaCurve ⑦ 无 nav_pct 才回退 growthrate × 100，并 toFixed(4) 归整', () => {
  const r = parseSinaCurve(
    curvePayload([cpt('09:30:00', '1.85', -0.014956, '2026-09-11', null)]),
    '2026-09-11',
  );
  assert.equal(r.points[0].change_pct, -1.4956); // 不是 -1.4956000000000001
});

test('parseSinaCurve ⑧ 脏值收紧：nav 与 change_pct 任一无效即丢（反例：只有 change_pct 不得放行）', () => {
  const r = parseSinaCurve(
    curvePayload([
      cpt('09:30:00', null, -0.007, '2026-09-11', null), // nav 缺、只有涨跌幅 → 必须丢
      cpt('09:31:00', '1.85', null, '2026-09-11', null), // 两者皆无 → 丢
      cpt('09:32:00', '1.86', -0.006, '2026-09-11', '0.6'), // 完好 → 留
    ]),
    '2026-09-11',
  );
  assert.deepEqual(
    r.points.map((p) => p.t),
    ['09:32'],
  );
});

test('parseSinaCurve ⑨ 防御与归一：非法入参不抛返回空结构；min_time 非法丢弃；worth/worth_date 归一', () => {
  for (const bad of [
    null,
    {},
    { result: {} },
    { result: { data: { networth: [] } } },
    { result: { data: { networth: 'x' } } },
  ]) {
    const r = parseSinaCurve(bad, '2026-09-11');
    assert.deepEqual(r.points, []);
    assert.equal(r.worth, null);
    assert.equal(r.worthDate, null);
  }
  const badTime = parseSinaCurve(curvePayload([cpt('09:3', '1.85', -0.007)]), '2026-09-11');
  assert.deepEqual(badTime.points, []);
  const ok = parseSinaCurve(
    curvePayload([cpt('09:30:00', '1.85', -0.007, '2026-09-11', '-0.7')]),
    '2026-09-11',
  );
  assert.equal(ok.worth, 1.8653);
  assert.equal(ok.worthDate, '2026-09-10');
  assert.deepEqual(ok.range, [
    ['09:30', '11:30'],
    ['13:00', '15:00'],
  ]);
  assert.equal(
    parseSinaCurve(curvePayload([], { worth_date: 'bad' }), '2026-09-11').worthDate,
    null,
  );
});

// ===== 核心指数「当天迷你分时」解析 =====

test('sliceJsonp：正常剥取；502 HTML / null / 非数组 / 截断一律返 null 且绝不抛', () => {
  assert.deepEqual(
    sliceJsonp(
      '/*<script>location.href=\'//sina.com\';</script>*/\nvar t=([{"d":"2026-09-10 16:00:00","c":"1"}]);',
    ),
    [{ d: '2026-09-10 16:00:00', c: '1' }],
  );
  // 上游抖动的三种真实形态（正则写法会在此抛TypeError，故直取 1 ）
  assert.equal(
    sliceJsonp('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>'),
    null,
  );
  assert.equal(sliceJsonp('var t=(null);'), null);
  assert.equal(sliceJsonp('var t=({"err":1});'), null); // 非数组
  assert.equal(sliceJsonp('var t=([{"d":"2026-09'), null); // 截断
  assert.equal(sliceJsonp(''), null);
  assert.equal(sliceJsonp(null), null);
  assert.equal(sliceJsonp(123), null);
  assert.doesNotThrow(() => sliceJsonp('var t=('));
});

test('parseEmTrends：剔集合竞价与盘后、保实际点（不假设 13:00）、缺昨收抛错', () => {
  const trends = [
    '2026-09-11 09:15,4548.00', // 集合竞价 → 必须剔
    '2026-09-11 09:29,4549.00', // 集合竞价 → 必须剔
    '2026-09-11 09:30,4514.30',
    '2026-09-11 11:30,4510.00',
    '2026-09-11 13:01,4509.50', // 实测下午首点是 13:01（源侧无 13:00）
    '2026-09-11 15:00,4508.68',
    '2026-09-11 15:01,4508.00', // 盘后尾巴 → 必须剔
    '2026-09-11 09:31,not-a-number', // 脏值 → 必须剔
  ];
  const r = parseEmTrends({ data: { preClose: 4548.39, trends } }, INDEX_SESSIONS.cn);
  assert.equal(r.preClose, 4548.39);
  assert.deepEqual(
    r.rows.map(([t]) => t),
    ['09:30', '11:30', '13:01', '15:00'],
  );
  assert.deepEqual(r.rows[0], ['09:30', 4514.3]);
  // 契约破坏 → 抛错（路由据此转 502 / 单只降级）
  assert.throws(
    () => parseEmTrends({ data: { preClose: null, trends } }, INDEX_SESSIONS.cn),
    /昨收/,
  );
  assert.throws(
    () => parseEmTrends({ data: { preClose: 1, trends: [] } }, INDEX_SESSIONS.cn),
    /无数据/,
  );
  assert.throws(
    () =>
      parseEmTrends({ data: { preClose: 1, trends: ['2026-09-11 09:15,1'] } }, INDEX_SESSIONS.cn),
    /无有效点/,
  );
});

test('parseSinaUsMinutes：取末个美东日组为当天、昨收取前一组末值；只有一日时用首点兜底', () => {
  const bar = (d, c) => ({
    d,
    o: String(c),
    h: String(c),
    l: String(c),
    c: String(c),
    v: '1',
    a: '0',
  });
  const three = [
    bar('2026-09-08 09:30:00', 100),
    bar('2026-09-08 16:00:00', 101),
    bar('2026-09-09 09:30:00', 102),
    bar('2026-09-09 16:00:00', 103), // ← 昨收应为 103
    bar('2026-09-10 09:31:00', 104),
    bar('2026-09-10 16:00:00', 105),
  ];
  const raw = 'var t=(' + JSON.stringify(three) + ');';
  const r = parseSinaUsMinutes(raw, INDEX_SESSIONS.us);
  assert.equal(r.sessionDate, '2026-09-10');
  assert.equal(r.preClose, 103);
  assert.deepEqual(
    r.rows.map(([t]) => t),
    ['09:31', '16:00'],
  ); // 源侧首点就是 09:31
  // 只有一日 → 用该日首点兜底（不抛）
  const one = parseSinaUsMinutes(
    'var t=(' + JSON.stringify([bar('2026-09-10 09:31:00', 104)]) + ');',
    INDEX_SESSIONS.us,
  );
  assert.equal(one.preClose, 104);
  assert.equal(one.rows.length, 1);
  // 不可解析 → 抛
  assert.throws(() => parseSinaUsMinutes('var t=(null);', INDEX_SESSIONS.us), /不可解析/);
  assert.throws(() => parseSinaUsMinutes('<html>502</html>', INDEX_SESSIONS.us), /不可解析/);
});

test('parseTencentMinutes：A 股/港股两形态；昨收取 qt[4]；缺昨收抛错', () => {
  const mk = (pre, list) => ({
    data: {
      sh000300: {
        data: { data: list },
        qt: { sh000300: ['1', '沪深300', '000300', '4510.16', pre] },
      },
    },
  });
  const cn = parseTencentMinutes(
    mk('4548.39', [
      '0930 4514.30 100 1',
      '1130 4510.00 200 2',
      '1301 4509.50 300 3',
      '1500 4508.68 400 4',
      '1501 4508.00 500 5',
    ]),
    INDEX_SESSIONS.cn,
    'sh000300',
  );
  assert.equal(cn.preClose, 4548.39);
  assert.deepEqual(
    cn.rows.map(([t]) => t),
    ['09:30', '11:30', '13:01', '15:00'],
  );
  assert.throws(
    () =>
      parseTencentMinutes(
        { data: { sh000300: { data: { data: ['0930 1 1 1'] }, qt: {} } } },
        INDEX_SESSIONS.cn,
        'sh000300',
      ),
    /昨收/,
  );
  assert.throws(() => parseTencentMinutes({ data: {} }, INDEX_SESSIONS.cn, 'sh000300'), /无数据/);
});

test('thinBySegment：分段预算（A 股 24+24 / 港股 22+26）、保各段实际首末、总数 ≤48', () => {
  const perMin = (a, b, base) => {
    const out = [];
    for (let m = a; m <= b; m++)
      out.push([
        String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'),
        base + (m - a),
      ]);
    return out;
  };
  const cnRows = [...perMin(570, 690, 4500), ...perMin(781, 900, 4500)]; // 上午 121 点、下午 120 点（13:01 起）；每点 +1
  const cn = thinBySegment(cnRows, INDEX_SESSIONS.cn, { total: 48, preClose: 4500 });
  assert.equal(cn.length, 48);
  assert.equal(cn.filter(([t]) => t <= '11:30').length, 24);
  assert.equal(cn.filter(([t]) => t >= '13:00').length, 24);
  assert.equal(cn[0][0], '09:30'); // 段首必保
  assert.equal(cn[23][0], '11:30'); // 上午段末必保
  assert.equal(cn[24][0], '13:01'); // 下午段首 = 实际首点（源侧无 13:00）
  assert.equal(cn[47][0], '15:00'); // 全天末必保
  assert.equal(cn[0][1], 0); // 首点=昨收 → 0%
  assert.ok(cn[47][1] > 1); // 每点 +1、末点 +119 → 约 +2.6%
  assert.equal(
    thinBySegment(cnRows, INDEX_SESSIONS.cn, { preClose: 4500 }).length,
    SPARK_MAX_POINTS,
  ); // 缺省即 48
  const hkRows = [...perMin(570, 720, 24800), ...perMin(781, 960, 24800)]; // 150 + 180 分钟
  const hk = thinBySegment(hkRows, INDEX_SESSIONS.hk, { total: 48, preClose: 24954.47 });
  assert.equal(hk.length, 48);
  assert.equal(hk.filter(([t]) => t <= '12:00').length, 22);
  assert.equal(hk.filter(([t]) => t >= '13:00').length, 26);
  // 退化与守卫
  assert.deepEqual(thinBySegment(cnRows, INDEX_SESSIONS.cn, { total: 48, preClose: 0 }), []);
  assert.deepEqual(thinBySegment([], INDEX_SESSIONS.cn, { total: 48, preClose: 1 }), []);
  const single = thinBySegment([['10:00', 100]], INDEX_SESSIONS.cn, { total: 48, preClose: 100 });
  assert.deepEqual(single, [['10:00', 0]]);
});

test('sparkMarketOf：11 只白名单映射（a→cn / hk→hk / us→us），未登记 → null', () => {
  assert.equal(sparkMarketOf('000300'), 'cn');
  assert.equal(sparkMarketOf('399006'), 'cn');
  assert.equal(sparkMarketOf('HSI'), 'hk');
  assert.equal(sparkMarketOf('NDX'), 'us');
  assert.equal(sparkMarketOf('HXC'), 'us');
  assert.equal(sparkMarketOf('999999'), null);
  assert.equal(sparkMarketOf(''), null);
  assert.equal(SINA_INDEX_SPECS.filter((s) => sparkMarketOf(s.code)).length, 11);
});

test('回归：美股昨收兜底不得被 NaN 穿透；新浪墙钟必须按 +08:00 解析', () => {
  // ① 前一日末行脏数据 + 显式昨收取不到 → 必须回落"当日首个有效点"，绝不产出 NaN
  const bar = (d, c) => ({
    d,
    o: String(c),
    h: String(c),
    l: String(c),
    c: String(c),
    v: '1',
    a: '0',
  });
  const dirty =
    'var t=(' +
    JSON.stringify([
      bar('2026-09-09 09:31:00', 100),
      bar('2026-09-09 16:00:00', 'oops'), // ← 末行脏
      bar('2026-09-10 09:31:00', 104),
      bar('2026-09-10 16:00:00', 105),
    ]) +
    ');';
  const r = parseSinaUsMinutes(dirty, INDEX_SESSIONS.us);
  assert.equal(r.preClose, 100); // 取前一日最后一个有效值（跳过脏尾行）
  assert.ok(Number.isFinite(r.preClose)); // 反例守卫：NaN ?? 104 不会回落，故必须先过滤
  // 前一日全脏 → 退回当日首个有效点
  const allDirty =
    'var t=(' +
    JSON.stringify([
      bar('2026-09-09 09:31:00', 'x'),
      bar('2026-09-10 09:31:00', 104),
      bar('2026-09-10 16:00:00', 105),
    ]) +
    ');';
  assert.equal(parseSinaUsMinutes(allDirty, INDEX_SESSIONS.us).preClose, 104);
  // ② 新浪墙钟（北京时间）→ 绝对 epoch：与运行时时区无关（本机 +08:00 下旧实现也"碰巧对"，故断言数值本身）
  const line = 'var hq_str_gb_ndx="纳斯达克100,29103.5128,-1.08,2026-09-10 15:00:00,-318.04,x";';
  const out = parseSinaIndexes(line, SINA_INDEX_SPECS);
  assert.equal(out[0].time, Date.UTC(2026, 8, 10, 7, 0, 0) / 1000); // 北京 15:00 == UTC 07:00
  // 已带时区标记的串不重复追加偏移；无效输入仍 null
  assert.equal(
    parseSinaIndexes('var hq_str_gb_ndx="x,1,1,2026-09-10T15:00:00Z,0,0";', SINA_INDEX_SPECS)[0]
      .time,
    Date.UTC(2026, 8, 10, 15, 0, 0) / 1000,
  );
  assert.equal(
    parseSinaIndexes('var hq_str_gb_ndx="x,1,1,not-a-date,0,0";', SINA_INDEX_SPECS)[0].time,
    null,
  );
});

test('sparkCoversSession：出时段「终局」判据——每条有效分时末点须到达时段末尾（±2 分钟容差）', () => {
  // 回归：us 子缓存末点停在 15:29（盘中最后刷新被冻结成终局）→ 必须判"半场"
  const one = (last) => [
    {
      spark: [
        ['09:31', 0],
        [last, 1],
      ],
    },
    { spark: null },
  ]; // spark:null（no_source/失败项）不拦终局
  assert.equal(sparkCoversSession(one('16:00'), 'us'), true);
  assert.equal(sparkCoversSession(one('15:59'), 'us'), true); // 容差内：1 分钟级数据收在 15:58+ 即算完整
  assert.equal(sparkCoversSession(one('15:29'), 'us'), false); // ← 实测半场缓存
  assert.equal(sparkCoversSession(one('15:00'), 'cn'), true); // A 股完整场次（两段、末段收 15:00）
  assert.equal(sparkCoversSession(one('14:00'), 'cn'), false);
  assert.equal(sparkCoversSession(one('16:00'), 'hk'), true);
  // 多只取全员到位：一只收在盘中 → 整市场不算终局
  const mixed = [
    {
      spark: [
        ['09:30', 0],
        ['15:00', 1],
      ],
    },
    {
      spark: [
        ['09:30', 0],
        ['14:00', 1],
      ],
    },
  ];
  assert.equal(sparkCoversSession(mixed, 'cn'), false);
  // 全失败 / 无有效分时（单点不算）→ 不算终局；未登记市场按 A 股窗口兜底（与 indexSegmentsOf 同口径）
  assert.equal(sparkCoversSession([], 'us'), false);
  assert.equal(sparkCoversSession([{ spark: [['09:31', 0]] }, { spark: null }], 'us'), false);
  assert.equal(sparkCoversSession(null, 'us'), false);
  assert.equal(sparkCoversSession(one('15:00'), 'xx'), true);
});
