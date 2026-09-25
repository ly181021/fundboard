import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthStripHtml } from '../../js/components/healthStrip.js';

const base = (over = {}) => ({
  push2: { lastOkAt: '2026-09-08T15:32:10+08:00', lastErrAt: null, lastErrMsg: null, errCount: 0 },
  estimate: {
    lastOkAt: '2026-09-08T15:32:10+08:00',
    lastErrAt: null,
    lastErrMsg: null,
    errCount: 0,
  },
  sina: { lastOkAt: null, lastErrAt: null, lastErrMsg: null, errCount: 0 },
  lsjz: {
    lastOkAt: '2026-09-08T09:05:02+08:00',
    lastErrAt: null,
    lastErrMsg: null,
    errCount: 0,
    fallbackUsedAt: null,
  },
  ...over,
});

test('healthStrip：全部 ok（lastErrAt=null）→ 绿点 + 成功时间，无 banner', () => {
  const html = healthStripHtml(base(), '2026-09-08T15:32:10+08:00');
  assert.equal((html.match(/class="pill ok"/g) || []).length, 3); // push2/estimate/lsjz 三个 ok
  assert.equal(html.includes('health-banner'), false);
  assert.equal(html.includes('指数行情'), true);
  assert.equal(html.includes('行情 push2'), false); // push2 只服务指数，展示名不叫"行情"（反例守卫）
  assert.equal(html.includes('✓'), true);
});

test('healthStrip：单源 fail（lastErrAt > lastOkAt）→ 红点 + banner 点名失败源', () => {
  const html = healthStripHtml(
    base({
      estimate: {
        lastOkAt: '2026-09-08T10:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: 'HTTP 500',
        errCount: 3,
      },
    }),
    '2026-09-08T15:36:00+08:00',
  );
  assert.equal(html.includes('class="pill fail"'), true);
  assert.equal(html.includes('失败'), true);
  assert.equal(html.includes('health-banner'), true);
  assert.equal(html.includes('盘中估值'), true); // banner 点名失败源
  assert.equal(html.includes('最近一次拉取失败'), true);
});

test('healthStrip：全 null → 灰点"等待首次拉取"，无 banner', () => {
  const allNull = { push2: {}, estimate: {}, sina: {}, lsjz: {} };
  const html = healthStripHtml(allNull, '2026-09-08T15:32:10+08:00');
  assert.equal((html.match(/等待首次拉取/g) || []).length, 4);
  assert.equal(html.includes('pill ok'), false);
  assert.equal(html.includes('pill fail'), false);
  assert.equal(html.includes('health-banner'), false);
});

test('healthStrip：空对象 / 非对象 → .health 容器 + "健康信息暂不可用"（不裸字符串）', () => {
  const h1 = healthStripHtml({}, '2026-09-08T15:32:10+08:00');
  assert.equal(h1.includes('health-muted'), false);
  assert.equal(h1.includes('等待首次拉取'), true); // 空对象按四源全 null 处理
  const h2 = healthStripHtml(null, '2026-09-08T15:32:10+08:00');
  assert.equal(h2.startsWith('<div class="health">'), true);
  assert.equal(h2.includes('健康信息暂不可用'), true);
});

test('healthStrip：XSS——lastErrMsg 含 <script>/引号 → 输出被转义', () => {
  const html = healthStripHtml(
    base({
      lsjz: {
        lastOkAt: '2026-09-08T09:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: `<script>alert("x")</script>`,
        errCount: 1,
        fallbackUsedAt: null,
      },
    }),
    '2026-09-08T15:36:00+08:00',
  );
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('&lt;script&gt;'), true);
  assert.equal(html.includes('&quot;'), true);
});

test('healthStrip：错误摘要超 60 字 → 截断（防御性，与服务端同口径）', () => {
  const long = 'X'.repeat(200);
  const html = healthStripHtml(
    base({
      push2: {
        lastOkAt: '2026-09-08T09:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: long,
        errCount: 1,
      },
    }),
    '2026-09-08T15:36:00+08:00',
  );
  assert.equal(html.includes('X'.repeat(61)), false); // 不出现 61 连串
  assert.equal(html.includes('X'.repeat(60)), true);
});

test('healthStrip：备源 tooltip（isOk 守卫 + 毫秒容差）', () => {
  // ok 且 fallbackUsedAt 与 lastOkAt 同值（<1000ms）→ 含"经蛋卷备源"
  const ok = base({
    lsjz: {
      lastOkAt: '2026-09-08T09:05:02+08:00',
      lastErrAt: null,
      lastErrMsg: null,
      errCount: 0,
      fallbackUsedAt: '2026-09-08T09:05:02+08:00',
    },
  });
  const h1 = healthStripHtml(ok, '2026-09-08T15:36:00+08:00');
  assert.equal(h1.includes('上次经蛋卷备源'), true);
  // fail 态（lastErrAt 最新）→ 不含备源提示，只显示错误摘要
  const fail = base({
    lsjz: {
      lastOkAt: '2026-09-08T09:05:02+08:00',
      lastErrAt: '2026-09-08T15:36:00+08:00',
      lastErrMsg: 'HTTP 500',
      errCount: 1,
      fallbackUsedAt: '2026-09-08T09:05:02+08:00',
    },
  });
  const h2 = healthStripHtml(fail, '2026-09-08T15:36:00+08:00');
  assert.equal(h2.includes('上次经蛋卷备源'), false);
  assert.equal(h2.includes('HTTP 500'), true);
  // ok 但 fallbackUsedAt 与 lastOkAt 相差 ≥1000ms（主源已恢复残留）→ 不含
  const stale = base({
    lsjz: {
      lastOkAt: '2026-09-08T09:05:02+08:00',
      lastErrAt: null,
      lastErrMsg: null,
      errCount: 0,
      fallbackUsedAt: '2026-09-07T21:10:00+08:00',
    },
  });
  const h3 = healthStripHtml(stale, '2026-09-08T15:36:00+08:00');
  assert.equal(h3.includes('上次经蛋卷备源'), false);
});

test('healthStrip：push2 失败但新浪备源可用 → 显示 ✗ 但不报"可能过期"（覆盖式降级）', () => {
  const html = healthStripHtml(
    base({
      push2: {
        lastOkAt: '2026-09-08T09:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: 'fetch failed',
        errCount: 0,
      },
      sina: {
        lastOkAt: '2026-09-08T15:36:30+08:00',
        lastErrAt: null,
        lastErrMsg: null,
        errCount: 0,
      },
    }),
    '2026-09-08T15:36:30+08:00',
  );
  assert.equal(html.includes('class="pill fail"'), true); // push2 如实显示失败（不再被备源成功掩盖）
  assert.equal(html.includes('✗'), true);
  assert.equal(html.includes('已切新浪备源，数据正常'), true); // tooltip 说明已被备源覆盖
  assert.equal(html.includes('health-banner'), false); // 数据没断 → 不误报"盯盘数字可能过期"
});

test('healthStrip：push2 失败且新浪备源也不可用 → 红条照常告警（未覆盖）', () => {
  const html = healthStripHtml(
    base({
      push2: {
        lastOkAt: '2026-09-08T09:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: 'fetch failed',
        errCount: 0,
      },
      sina: {
        lastOkAt: '2026-09-08T08:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:10+08:00',
        lastErrMsg: 'HTTP 403',
        errCount: 1,
      },
    }),
    '2026-09-08T15:36:30+08:00',
  );
  assert.equal(html.includes('health-banner'), true);
  assert.equal(html.includes('指数行情'), true); // 红条点名未覆盖的源
  assert.equal(html.includes('新浪备源'), true);
});

test('healthStrip：未登记备源名称的源不展示备源提示（防口径错配）', () => {
  const html = healthStripHtml(
    base({
      estimate: {
        lastOkAt: '2026-09-08T15:32:10+08:00',
        lastErrAt: null,
        lastErrMsg: null,
        errCount: 0,
        fallbackUsedAt: '2026-09-08T15:32:10+08:00',
      },
    }),
    '2026-09-08T15:32:10+08:00',
  );
  assert.equal(html.includes('上次经'), false);
});

// ---- 指数主源「重试指数源」入口 ----

test('healthStrip：指数主源失败 → 出现「重试指数源」按钮（已覆盖时在细条内、不报红条）', () => {
  const html = healthStripHtml(
    base({
      push2: {
        lastOkAt: '2026-09-08T09:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: 'fetch failed',
        errCount: 0,
      },
      sina: {
        lastOkAt: '2026-09-08T15:36:30+08:00',
        lastErrAt: null,
        lastErrMsg: null,
        errCount: 0,
      },
    }),
    '2026-09-08T15:36:30+08:00',
  );
  assert.equal(html.includes('data-idx-retry'), true);
  assert.equal(html.includes('↻ 重试指数源'), true);
  assert.equal(html.includes('health-banner'), false); // 数据没断 → 无红条
  assert.equal(html.indexOf('data-idx-retry') < html.indexOf('最后更新'), true); // 位置：细条右侧（在"最后更新"之前）
});

test('healthStrip：push2 与新浪备源同时失败 → 按钮进红条（贴着告警文案）', () => {
  const html = healthStripHtml(
    base({
      push2: {
        lastOkAt: '2026-09-08T09:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:00+08:00',
        lastErrMsg: 'fetch failed',
        errCount: 1,
      },
      sina: {
        lastOkAt: '2026-09-08T08:00:00+08:00',
        lastErrAt: '2026-09-08T15:36:10+08:00',
        lastErrMsg: 'HTTP 403',
        errCount: 1,
      },
    }),
    '2026-09-08T15:36:30+08:00',
  );
  assert.equal(html.includes('health-banner'), true);
  assert.equal(html.indexOf('health-banner') < html.indexOf('data-idx-retry'), true); // 按钮在红条内部
  assert.equal(html.indexOf('data-idx-retry') < html.indexOf('最后更新'), false); // 而非细条里
});

test('healthStrip：主源正常 → 不出现重试按钮（正常态不打扰）', () => {
  const html = healthStripHtml(base(), '2026-09-08T15:32:10+08:00');
  assert.equal(html.includes('data-idx-retry'), false);
  assert.equal(html.includes('retry-btn'), false);
});

test('healthStrip：重试进行中 → 按钮禁用并显示「重试中…」；结果 flash 内联输出', () => {
  const sources = base({
    push2: {
      lastOkAt: '2026-09-08T09:00:00+08:00',
      lastErrAt: '2026-09-08T15:36:00+08:00',
      lastErrMsg: 'fetch failed',
      errCount: 0,
    },
    sina: { lastOkAt: '2026-09-08T15:36:30+08:00', lastErrAt: null, lastErrMsg: null, errCount: 0 },
  });
  const busy = healthStripHtml(sources, '2026-09-08T15:36:30+08:00', {}, { retrying: true });
  assert.equal(busy.includes('重试中…'), true);
  assert.equal(/data-idx-retry[^>]*disabled/.test(busy), true);
  assert.equal(busy.includes('↻ 重试指数源'), false);
  const ok = healthStripHtml(
    sources,
    '2026-09-08T15:36:30+08:00',
    {},
    { flash: { cls: 'ok', text: '指数主源已恢复（东财 push2）' } },
  );
  assert.equal(ok.includes('class="flash ok"'), true);
  assert.equal(ok.includes('指数主源已恢复'), true);
  const warn = healthStripHtml(
    sources,
    '2026-09-08T15:36:30+08:00',
    {},
    { flash: { cls: 'warn', text: '主源仍不可用——继续走新浪备源' } },
  );
  assert.equal(warn.includes('class="flash warn"'), true);
  assert.equal(warn.includes('继续走新浪备源'), true);
  // flash 文本走 esc：< > 被转义（与其它文案同口径）
  const xss = healthStripHtml(
    sources,
    '2026-09-08T15:36:30+08:00',
    {},
    { flash: { cls: 'ok', text: '<script>x</script>' } },
  );
  assert.equal(xss.includes('<script>'), false);
});

// ---- 排序手柄 ----

test('healthStrip：handles 手柄恒输出——正常态缺省 orderCtx 两键均不禁用', () => {
  const html = healthStripHtml(base(), '2026-09-08T15:32:10+08:00');
  assert.ok(html.includes('data-blk="health"'));
  assert.ok(html.includes('class="drag" draggable="true"'));
  assert.ok(html.includes('data-move="-1"'));
  assert.ok(html.includes('data-move="1"'));
  assert.equal((html.match(/ disabled/g) || []).length, 0); // 缺省 orderCtx 不禁用（保既有基线）
});

test('healthStrip：disabled 边界——pos=0 禁 ↑、pos=len-1 禁 ↓、中间态不禁', () => {
  const first = healthStripHtml(base(), '2026-09-08T15:32:10+08:00', { pos: 0, len: 3 });
  assert.ok(first.includes('data-move="-1" title="上移" disabled'));
  assert.ok(!first.includes('data-move="1" title="下移" disabled'));
  const last = healthStripHtml(base(), '2026-09-08T15:32:10+08:00', { pos: 2, len: 3 });
  assert.ok(last.includes('data-move="1" title="下移" disabled'));
  assert.ok(!last.includes('data-move="-1" title="上移" disabled'));
  const mid = healthStripHtml(base(), '2026-09-08T15:32:10+08:00', { pos: 1, len: 3 });
  assert.equal((mid.match(/ disabled/g) || []).length, 0);
});

test('healthStrip：空态骨架同样带 handles（结构恒定）', () => {
  const html = healthStripHtml(null, null);
  assert.ok(html.includes('健康信息暂不可用'));
  assert.ok(html.includes('data-blk="health"'));
});

test('时间一律按北京墙钟（UTC+8）渲染：pill 的 HH:MM 与 tooltip 的"最后成功"都不跟随浏览器时区', () => {
  // 输入用 UTC（Z）形态：北京 = UTC + 8
  const html = healthStripHtml(
    {
      push2: {
        lastOkAt: '2026-09-11T04:24:08.362Z',
        lastErrAt: '2026-09-11T06:50:00.000Z',
        lastErrMsg: 'fetch failed',
        errCount: 1,
      },
      sina: {
        lastOkAt: '2026-09-11T06:52:00.000Z',
        lastErrAt: null,
        lastErrMsg: null,
        errCount: 0,
      },
    },
    '2026-09-11T06:55:00.000Z',
  );
  assert.ok(html.includes('✗ 14:50 失败')); // UTC 06:50 → 北京 14:50
  assert.ok(html.includes('最后成功 09-11 12:24（北京）')); // UTC 04:24 → 北京 12:24
  assert.equal(html.includes('2026-09-11T04:24'), false); // 不再直接吐原始 ISO（带 Z 的 UTC 串）
  assert.ok(html.includes('已切新浪备源，数据正常')); // 覆盖式降级提示仍在
});
