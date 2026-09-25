import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOcrConfig,
  parseOcrResponse,
  createOcrClient,
  OCR_EXTRACT_PROMPT,
  buildAnalysisMessages,
  createAnalysisClient,
  dedupeTrades,
} from '../../lib/ocr.js';

// ---- 配置加载 ----

test('loadOcrConfig：配置文件优先且字段齐全', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const p = join(dir, 'ocr.config.json');
    await writeFile(
      p,
      JSON.stringify({ baseUrl: 'http://x/v1/', apiKey: 'sk-1', model: 'qwen-vl-max' }),
    );
    const c = await loadOcrConfig({ configPath: p });
    assert.equal(c.baseUrl, 'http://x/v1'); // 尾部斜杠去除
    assert.equal(c.apiKey, 'sk-1');
    assert.equal(c.model, 'qwen-vl-max');
    assert.equal(c.analysis, null); // 未写 analysis 段 → AI 解读与截图识别同模型
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadOcrConfig：无文件走环境变量；key 缺失视为未配置', async () => {
  const r1 = await loadOcrConfig({
    configPath: join(tmpdir(), 'not-exist-ocr.json'),
    env: { OCR_API_BASE: 'http://y/v1', OCR_API_KEY: 'k', OCR_MODEL: 'm' },
  });
  assert.deepEqual(r1, { baseUrl: 'http://y/v1', apiKey: 'k', model: 'm', analysis: null });

  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const p = join(dir, 'c.json');
    await writeFile(p, JSON.stringify({ baseUrl: 'http://x', apiKey: '', model: 'm' })); // 空 key
    const r2 = await loadOcrConfig({ configPath: p, env: {} });
    assert.equal(r2, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- analysis 段可选覆盖 ----

test('loadOcrConfig：analysis 段可只覆盖 model，其余回落顶层', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const p = join(dir, 'c.json');
    await writeFile(
      p,
      JSON.stringify({
        baseUrl: 'http://x/v1/',
        apiKey: 'sk-1',
        model: 'qwen-vl-max',
        analysis: { model: 'deepseek-chat' },
      }),
    );
    const c = await loadOcrConfig({ configPath: p });
    assert.equal(c.model, 'qwen-vl-max'); // 截图识别仍用顶层
    assert.deepEqual(c.analysis, {
      baseUrl: 'http://x/v1',
      apiKey: 'sk-1',
      model: 'deepseek-chat',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadOcrConfig：analysis 段可换网关与 key（三要素全覆盖）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const p = join(dir, 'c.json');
    await writeFile(
      p,
      JSON.stringify({
        baseUrl: 'http://x/v1',
        apiKey: 'sk-1',
        model: 'qwen-vl-max',
        analysis: { baseUrl: 'http://z/v1/', apiKey: 'sk-2', model: 'text-mini' },
      }),
    );
    const c = await loadOcrConfig({ configPath: p });
    assert.deepEqual(c.analysis, { baseUrl: 'http://z/v1', apiKey: 'sk-2', model: 'text-mini' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadOcrConfig：analysis 段非法（key 缺失/中文占位）时整段忽略，回落同模型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const p = join(dir, 'c.json');
    // apiKey 显式置空且顶层不可回落 → 合并后非法 → 忽略
    await writeFile(
      p,
      JSON.stringify({ baseUrl: 'http://x', apiKey: 'sk-1', model: 'm', analysis: { apiKey: '' } }),
    );
    const c = await loadOcrConfig({ configPath: p });
    assert.equal(c.analysis, null);
    assert.equal(c.model, 'm');

    // analysis 非对象/为 null 同样按缺省处理
    await writeFile(
      p,
      JSON.stringify({ baseUrl: 'http://x', apiKey: 'sk-1', model: 'm', analysis: null }),
    );
    assert.equal((await loadOcrConfig({ configPath: p })).analysis, null);
    await writeFile(
      p,
      JSON.stringify({ baseUrl: 'http://x', apiKey: 'sk-1', model: 'm', analysis: 'x' }),
    );
    assert.equal((await loadOcrConfig({ configPath: p })).analysis, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadOcrConfig：apiKey 为中文占位符（非 ASCII）视为未配置，避免晦涩的 ByteString 报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const p = join(dir, 'c.json');
    await writeFile(
      p,
      JSON.stringify({
        baseUrl: 'http://x',
        apiKey: '这里重新填入你的 key（中转站的 sk-3...）',
        model: 'm',
      }),
    );
    assert.equal(await loadOcrConfig({ configPath: p, env: {} }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- 模型返回文本解析 ----

test('parseOcrResponse：裸 JSON / 代码块 / 带前后噪声都能提取', () => {
  const json =
    '{"trades":[{"code":"110020","name":"沪深300联接","type":"买入","amount":"500","shares":"265","date":"2026-08-30"}]}';
  for (const text of [json, '```json\n' + json + '\n```', '识别结果如下：' + json + ' 以上。']) {
    const { trades } = parseOcrResponse(text);
    assert.equal(trades.length, 1);
    assert.equal(trades[0].type, 'buy'); // 中文别名归一
    assert.equal(trades[0].amount, 500);
    assert.equal(trades[0].date, '2026-08-30');
  }
});

test('parseOcrResponse：非法条目丢弃、坏输出返回空', () => {
  const text = JSON.stringify({
    trades: [
      { code: '110', type: 'buy' }, // 代码非6位 → 丢
      { code: '161017', type: '赎回', shares: '300' }, // 卖出别名
    ],
  });
  const { trades } = parseOcrResponse(text);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].type, 'sell');
  assert.equal(trades[0].amount, null);
  assert.deepEqual(parseOcrResponse('模型胡言乱语没有JSON'), { trades: [], snapshot: null });
});

test('parseOcrResponse：资产详情页 → 规范化 snapshot，代码非法则丢弃', () => {
  const good = parseOcrResponse(
    JSON.stringify({
      kind: 'snapshot',
      trades: [],
      snapshot: {
        code: '110020',
        name: '演示医疗健康混合C',
        hold_amount: '93.35',
        cost_price: '2.8834',
        hold_shares: '50.00',
        nav: 1.8669,
      },
    }),
  );
  assert.deepEqual(good.snapshot, {
    code: '110020',
    name: '演示医疗健康混合C',
    hold_amount: 93.35,
    cost_price: 2.8834,
    hold_shares: 50,
    nav: 1.8669,
  });
  const bad = parseOcrResponse(
    JSON.stringify({ kind: 'snapshot', snapshot: { code: '00309', hold_amount: 1 } }),
  );
  assert.equal(bad.snapshot, null); // 代码非6位
  assert.deepEqual(
    parseOcrResponse(JSON.stringify({ kind: 'snapshot', snapshot: null })).snapshot,
    null,
  );
});

test('parseOcrResponse：红利再投 method 归一', () => {
  const { trades } = parseOcrResponse(
    JSON.stringify({
      trades: [{ code: '110020', type: 'dividend', amount: 50, method: 'reinvest', shares: '40' }],
    }),
  );
  assert.equal(trades[0].method, 'reinvest');
  assert.equal(trades[0].shares, 40);
});

// ---- 客户端 ----

test('createOcrClient.extract：POST chat/completions，解析 choices 内容', async () => {
  let captured = null;
  const fetchFn = async (url, opts = {}) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"trades":[{"code":"110020","type":"买入","amount":500,"shares":265,"date":"2026-08-30"}]}',
            },
          },
        ],
      }),
    };
  };
  const client = createOcrClient({
    fetchFn,
    config: { baseUrl: 'http://x/v1', apiKey: 'sk', model: 'qwen-vl-max' },
  });
  const { trades } = await client.extract('data:image/png;base64,AAAA');
  assert.equal(trades.length, 1);
  assert.equal(captured.url, 'http://x/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer sk');
  assert.equal(captured.body.model, 'qwen-vl-max');
  assert.equal(captured.body.messages[0].content[0].type, 'text');
  assert.ok(captured.body.messages[0].content[0].text.includes('JSON'));
  assert.equal(captured.body.messages[0].content[1].type, 'image_url');
  assert.equal(captured.body.messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.ok(OCR_EXTRACT_PROMPT.length > 50);
});

test('createOcrClient.extract：HTTP 失败抛错（由路由转 502）', async () => {
  const client = createOcrClient({
    fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    config: { baseUrl: 'http://x/v1', apiKey: 'bad', model: 'm' },
  });
  await assert.rejects(() => client.extract('data:image/png;base64,A'), /HTTP 401/);
});

// ---- AI 今日解读（/api/analysis，复用同一模型配置）----

test('buildAnalysisMessages：提示词 + 结构化数据组装', () => {
  const msgs = buildAnalysisMessages({
    date: '8月31日',
    report: '持仓 2 只…',
    summary: { dailyProfit: -165.34 },
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('解读'));
  assert.ok(msgs[0].content.includes('"dailyProfit":-165.34'));
  assert.ok(msgs[0].content.includes('持仓 2 只'));
});

test('createAnalysisClient.interpret：返回模型文本；HTTP 失败抛错', async () => {
  let captured = null;
  const good = createAnalysisClient({
    fetchFn: async (url, opts = {}) => {
      captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '今日医疗仓位拖累明显，建议关注集中度。' } }],
        }),
      };
    },
    config: { baseUrl: 'http://x/v1', apiKey: 'sk', model: 'm' },
  });
  const { text } = await good.interpret({ report: 'x' });
  assert.ok(text.includes('集中度'));
  assert.equal(captured.url, 'http://x/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer sk');
  assert.equal(captured.body.model, 'm');

  const bad = createAnalysisClient({
    fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    config: { baseUrl: 'http://x/v1', apiKey: 'sk', model: 'm' },
  });
  await assert.rejects(() => bad.interpret({}), /HTTP 429/);
});

// ---- AI 解读超时兜底（不用裸 fetch：网关不返回会一直挂着）----

test('createAnalysisClient.interpret：传 signal 且超时后主动中止并抛出可读错误', async () => {
  let sawSignal = null;
  const client = createAnalysisClient({
    // 模拟真实 fetch：挂住不返回，只有 signal 中止时才 reject（忽略 signal 的实现不会触发超时兜底）
    fetchFn: (url, opts = {}) =>
      new Promise((_, reject) => {
        sawSignal = opts.signal;
        opts.signal.addEventListener('abort', () =>
          reject(new Error('The operation was aborted.')),
        );
      }),
    config: { baseUrl: 'http://x/v1', apiKey: 'sk', model: 'm' },
    timeoutMs: 20,
  });
  await assert.rejects(() => client.interpret({}), /模型响应超时/);
  assert.ok(sawSignal, '必须把 AbortController.signal 传给 fetch');
  assert.equal(sawSignal.aborted, true, '超时后 signal 应为已中止');
});

test('createAnalysisClient.interpret：网络错误原样抛出（不被误报成超时）', async () => {
  const client = createAnalysisClient({
    fetchFn: async () => {
      throw new Error('fetch failed');
    },
    config: { baseUrl: 'http://x/v1', apiKey: 'sk', model: 'm' },
    timeoutMs: 1000,
  });
  await assert.rejects(() => client.interpret({}), /fetch failed/);
});

test('createAnalysisClient.interpret：524 给出可操作提示（区别于一般 HTTP 错误）', async () => {
  const client = createAnalysisClient({
    fetchFn: async () => ({ ok: false, status: 524, json: async () => ({}) }),
    config: { baseUrl: 'http://x/v1', apiKey: 'sk', model: 'm' },
  });
  await assert.rejects(
    () => client.interpret({}),
    (e) => {
      assert.ok(e.message.includes('HTTP 524'));
      assert.ok(e.message.includes('上游网关超时'), '应提示这是网关侧超时');
      assert.ok(e.message.includes('analysis'), '应给出换模型的建议');
      return true;
    },
  );
});

// ---- 分红页提示词 / 卫生规则 / 去重 ----

test('OCR_EXTRACT_PROMPT：含分红记录页专段（每10份派发/红利再投/现金红利）', () => {
  assert.ok(OCR_EXTRACT_PROMPT.includes('分红记录/分红明细/红利到账'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('每10份派发'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('红利再投份额'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('现金红利实发金额'));
});

test('parseOcrResponse：金额与份额全空的噪声条目丢弃', () => {
  const text = JSON.stringify({
    kind: 'trades',
    trades: [
      { code: '110020', type: 'buy', amount: 500, shares: 265 },
      { code: '110020', type: 'buy', amount: null, shares: null },
    ],
  });
  const r = parseOcrResponse(text);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].amount, 500);
});

test('parseOcrResponse：重复条目（长截图相邻块重叠）按指纹去重', () => {
  const t = {
    code: '110020',
    name: '沪深300',
    type: 'buy',
    amount: 500,
    shares: 265.1,
    date: '2026-08-20',
    method: null,
  };
  const r = parseOcrResponse(JSON.stringify({ kind: 'trades', trades: [t, { ...t }] }));
  assert.equal(r.trades.length, 1);
});

test('dedupeTrades：缺失字段视为 null 参与指纹；保留首次出现', () => {
  const list = [
    { type: 'buy', date: '2026-08-20', amount: 500, shares: 265 },
    { type: 'buy', date: '2026-08-20', amount: 500, shares: 265, method: null }, // 同指纹（method 缺省=null）
    { type: 'buy', date: '2026-08-20', amount: 500, shares: 265, method: 'cash' }, // method 不同 → 保留
  ];
  assert.equal(dedupeTrades(list).length, 2);
  assert.equal(dedupeTrades([]).length, 0);
});

// ---- 转换别名 / 片段与日期规则 ----

test('parseOcrResponse：转换(转入)归一 buy、转换(转出)归一 sell', () => {
  const text = JSON.stringify({
    kind: 'trades',
    trades: [
      { code: '161017', type: '转换(转入)', amount: 323.49, date: '2026-05-13' },
      { code: '161017', type: '转出', shares: 100, date: '2026-05-12' },
    ],
  });
  const r = parseOcrResponse(text);
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].type, 'buy');
  assert.equal(r.trades[0].amount, 323.49);
  assert.equal(r.trades[1].type, 'sell');
});

test('OCR_EXTRACT_PROMPT：含无页头片段提取、转换映射与日期只取日期部分规则', () => {
  assert.ok(OCR_EXTRACT_PROMPT.includes('中间片段'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('转换(转入)=buy'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('转换(转出)=sell'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('忽略时分秒'));
  assert.ok(OCR_EXTRACT_PROMPT.includes('截图没有份额列时 shares 填 null'));
});

test('parseOcrResponse：code 缺失（中间片段无页头）保留为 null；code 存在但不合法才丢弃', () => {
  const text = JSON.stringify({
    kind: 'trades',
    trades: [
      { code: null, type: 'buy', amount: 50, date: '2026-03-24' }, // 缺 code → 保留
      { code: '01899', type: 'buy', amount: 60, date: '2026-03-25' }, // 5 位垃圾 code → 丢弃
      { code: '', type: 'buy', amount: 70, date: '2026-03-26' }, // 空串 → 保留（视为缺 code）
    ],
  });
  const r = parseOcrResponse(text);
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].code, null);
  assert.equal(r.trades[0].amount, 50);
  assert.equal(r.trades[1].amount, 70);
});

test('parseOcrResponse：日期带时分秒时截取日期部分（跨块判重稳定性）', () => {
  const text = JSON.stringify({
    kind: 'trades',
    trades: [
      { code: '161017', type: 'buy', amount: 100, date: '2026-03-03 12:28:20' },
      { code: '161017', type: 'buy', amount: 200, date: '2026-02-26T09:00:00' },
      { code: '161017', type: 'buy', amount: 300, date: '不是日期' },
    ],
  });
  const r = parseOcrResponse(text);
  assert.equal(r.trades[0].date, '2026-03-03');
  assert.equal(r.trades[1].date, '2026-02-26');
  assert.equal(r.trades[2].date, null);
});

test('parseOcrResponse：非分红交易的 method 强制 null，分红的保留', () => {
  const text = JSON.stringify({
    kind: 'trades',
    trades: [
      { code: '161017', type: 'buy', amount: 100, method: 'cash' },
      { code: '161017', type: 'dividend', amount: 30, method: 'cash' },
      { code: '161017', type: 'dividend', shares: 15, method: 'reinvest' },
    ],
  });
  const r = parseOcrResponse(text);
  assert.equal(r.trades[0].method, null); // 买入乱填的 cash 被清掉
  assert.equal(r.trades[1].method, 'cash');
  assert.equal(r.trades[2].method, 'reinvest');
});
