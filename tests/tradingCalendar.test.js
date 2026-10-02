import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTradingCalendar } from '../js/tradingCalendar.js';

const YEAR_2026 = JSON.stringify({
  holidays: {
    '2026-01-01': "New Year's Day,元旦,1",
    '2026-10-01': 'National Day,国庆,1',
  },
});

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url.includes('2026.json'))
      return { ok: true, status: 200, json: async () => JSON.parse(YEAR_2026) };
    return { ok: false, status: 404, json: async () => null };
  };
}

test('isTradingDay：周一至周五非节假日为交易日，周末/节假日为非交易日', async () => {
  const calls = [];
  const cal = createTradingCalendar({ fetchFn: fakeFetch(calls) });
  assert.equal(await cal.isTradingDay('2026-09-03'), true); // 周四
  assert.equal(await cal.isTradingDay('2026-09-05'), false); // 周六
  assert.equal(await cal.isTradingDay('2026-09-06'), false); // 周日
  assert.equal(await cal.isTradingDay('2026-10-01'), false); // 国庆
  assert.equal(await cal.isTradingDay('2026-01-02'), true); // 周五，非节假日
  // 同年数据只拉一次（缓存）
  assert.equal(calls.filter((u) => u.includes('2026.json')).length, 1);
});

test('isTradingDay：节假日数据拉取失败 → 降级为周一至周五粗判（不阻塞业务）', async () => {
  const cal = createTradingCalendar({
    fetchFn: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(await cal.isTradingDay('2026-10-01'), true); // 国庆（未知）按工作日粗判
  assert.equal(await cal.isTradingDay('2026-09-05'), false); // 周末仍排除
});

test('isTradingDay：节假日字段缺失按工作日粗判；格式非法返回 null', async () => {
  const noHolidays = createTradingCalendar({
    fetchFn: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(await noHolidays.isTradingDay('2026-10-01'), true);
  const cal = createTradingCalendar({
    fetchFn: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(await cal.isTradingDay('2026/09/03'), null);
  assert.equal(await cal.isTradingDay(''), null);
});

test('holidaysOfYears：多年节假日并集（跨年推进用），按年缓存，失败年份贡献空集', async () => {
  const calls = [];
  const cal = createTradingCalendar({ fetchFn: fakeFetch(calls) });
  const set = await cal.holidaysOfYears([2025, 2026]);
  assert.equal(set.has('2026-01-01'), true); // 元旦
  assert.equal(set.has('2026-10-01'), true); // 国庆
  assert.equal(set.size, 2); // 2025 拉取失败（404）→ 空集并入不抛错
  await cal.holidaysOfYears([2026]); // 同年重复调用走缓存
  assert.equal(calls.filter((u) => u.includes('2025.json') || u.includes('2026.json')).length, 2);
});
