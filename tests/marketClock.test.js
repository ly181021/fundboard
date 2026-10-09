import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsEasternDst,
  hkIndexWindowOpen,
  usIndexWindowOpen,
  cnIndexWindowOpen,
  marketStatusOf,
  overseasIndexWindowOpen,
  formatIndexTime,
  marketOfIndex,
  cnMarketPhase,
  hkMarketPhase,
  marketPhaseOf,
  beijingToday,
  beijingMinutes,
} from '../js/marketClock.js';

test('美东夏令时判定：2026 年 3 月第二个周日 07:00Z 起、11 月第一个周日 06:00Z 止', () => {
  assert.equal(isUsEasternDst(new Date('2026-03-08T06:59:00Z')), false);
  assert.equal(isUsEasternDst(new Date('2026-03-08T07:00:00Z')), true);
  assert.equal(isUsEasternDst(new Date('2026-11-01T05:59:00Z')), true);
  assert.equal(isUsEasternDst(new Date('2026-11-01T06:00:00Z')), false);
  assert.equal(isUsEasternDst(new Date('2026-07-15T12:00:00Z')), true);
  assert.equal(isUsEasternDst(new Date('2026-01-15T12:00:00Z')), false);
});

test('恒生窗口（UTC+8）：周一至五 9:30–12:00 / 13:00–16:00，周末关闭', () => {
  const d = (s) => new Date(s);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T09:29:00+08:00')), false);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T09:30:00+08:00')), true);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T11:59:00+08:00')), true);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T12:00:00+08:00')), false); // 午休开始（不含）
  assert.equal(hkIndexWindowOpen(d('2026-09-04T12:30:00+08:00')), false);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T13:00:00+08:00')), true);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T15:59:00+08:00')), true);
  assert.equal(hkIndexWindowOpen(d('2026-09-04T16:00:00+08:00')), false);
  assert.equal(hkIndexWindowOpen(d('2026-09-05T10:00:00+08:00')), false); // 周六
});

test('纳指窗口：夏令 21:30–次日 04:00、冬令 22:30–次日 05:00（北京时间），周末关闭', () => {
  const d = (s) => new Date(s);
  // 夏令时（7 月）
  assert.equal(usIndexWindowOpen(d('2026-07-15T21:29:00+08:00')), false);
  assert.equal(usIndexWindowOpen(d('2026-07-15T21:30:00+08:00')), true); // ET 周三 09:30
  assert.equal(usIndexWindowOpen(d('2026-07-16T03:59:00+08:00')), true); // ET 周三 15:59
  assert.equal(usIndexWindowOpen(d('2026-07-16T04:00:00+08:00')), false); // ET 16:00 收
  // 冬令时（1 月）：21:30 未开、22:30 开，次日 05:00 收
  assert.equal(usIndexWindowOpen(d('2026-01-14T21:30:00+08:00')), false);
  assert.equal(usIndexWindowOpen(d('2026-01-14T22:30:00+08:00')), true);
  assert.equal(usIndexWindowOpen(d('2026-01-15T04:59:00+08:00')), true);
  assert.equal(usIndexWindowOpen(d('2026-01-15T05:00:00+08:00')), false);
  // 跨日关键用例：北京周六凌晨 = 美东周五晚间 → 仍在交易；北京周日晚 = 美东周日上午 → 休市
  assert.equal(usIndexWindowOpen(d('2026-07-18T03:00:00+08:00')), true);
  assert.equal(usIndexWindowOpen(d('2026-07-19T21:30:00+08:00')), false);
});

test('A股窗口（UTC+8）：9:30–11:30 / 13:00–15:00（午休分流），周末关闭', () => {
  const d = (s) => new Date(s);
  assert.equal(cnIndexWindowOpen(d('2026-09-04T09:29:00+08:00')), false);
  assert.equal(cnIndexWindowOpen(d('2026-09-04T09:30:00+08:00')), true);
  assert.equal(cnIndexWindowOpen(d('2026-09-04T11:00:00+08:00')), true);
  assert.equal(cnIndexWindowOpen(d('2026-09-04T11:45:00+08:00')), false); // 午休
  assert.equal(cnIndexWindowOpen(d('2026-09-04T13:00:00+08:00')), true);
  assert.equal(cnIndexWindowOpen(d('2026-09-04T14:59:00+08:00')), true);
  assert.equal(cnIndexWindowOpen(d('2026-09-04T15:00:00+08:00')), false);
  assert.equal(cnIndexWindowOpen(d('2026-09-05T10:00:00+08:00')), false); // 周六
});

test('marketStatusOf：三市场状态徽标（16:30 港股已收、深夜仅美股开）', () => {
  const s = marketStatusOf(new Date('2026-09-04T16:30:00+08:00'));
  assert.deepEqual(
    s.items.map((i) => i.label),
    ['A股', '港股', '美股'],
  );
  assert.deepEqual(
    s.items.map((i) => i.open),
    [false, false, false],
  );
  const night = marketStatusOf(new Date('2026-07-15T23:00:00+08:00'));
  assert.deepEqual(
    night.items.map((i) => i.open),
    [false, false, true],
  );
});

test('任一海外开市即真：A 股收盘后恒生仍在交易、深夜纳指单独开市', () => {
  assert.equal(overseasIndexWindowOpen(new Date('2026-09-04T15:30:00+08:00')), true); // 恒生下午盘（A 股 15:00 已收）
  assert.equal(overseasIndexWindowOpen(new Date('2026-07-15T23:00:00+08:00')), true); // 恒生已收、纳指夏令时段
  assert.equal(overseasIndexWindowOpen(new Date('2026-09-04T16:30:00+08:00')), false); // 港美均闭市（港股 16:00 已收）
  assert.equal(overseasIndexWindowOpen(new Date('2026-09-05T12:00:00+08:00')), false); // 周六
});

test('formatIndexTime：当日 HH:mm、跨日 MM-DD HH:mm、无效空串', () => {
  const now = new Date('2026-09-05T10:00:00');
  assert.equal(formatIndexTime(new Date('2026-09-05T09:47:00').getTime() / 1000, now), '09:47');
  assert.equal(
    formatIndexTime(new Date('2026-09-04T22:35:00').getTime() / 1000, now),
    '09-04 22:35',
  );
  assert.equal(formatIndexTime(null, now), '');
  assert.equal(formatIndexTime(0, now), '');
});

test('marketOfIndex：海外指数白名单映射（11 只白名单）', () => {
  // 美股四只：纳指100 / 纳指综合 / 费城半导体 / 纳斯达克中国金龙；老两分支实现漏了后三只
  assert.equal(marketOfIndex('NDX'), 'us');
  assert.equal(marketOfIndex('IXIC'), 'us');
  assert.equal(marketOfIndex('SOX'), 'us');
  assert.equal(marketOfIndex('HXC'), 'us');
  // 港股与 A 股
  assert.equal(marketOfIndex('HSI'), 'hk');
  for (const cn of ['000300', '000905', '000001', '399001', '399006', '000688']) {
    assert.equal(marketOfIndex(cn), 'cn');
  }
  // 未知代码默认 A 股窗口（不抛）
  assert.equal(marketOfIndex('WHATEVER'), 'cn');
  assert.equal(marketOfIndex(undefined), 'cn');
});

test('市场阶段：午间休市("lunch") ≠ 已收盘（A股 12:03 不得显示"已收盘"）', () => {
  const d = (s) => new Date(s);
  // A 股：11:30–13:00 午休
  assert.equal(cnMarketPhase(d('2026-09-11T11:29:00+08:00')), 'open');
  assert.equal(cnMarketPhase(d('2026-09-11T11:30:00+08:00')), 'lunch');
  assert.equal(cnMarketPhase(d('2026-09-11T12:03:00+08:00')), 'lunch');
  assert.equal(cnMarketPhase(d('2026-09-11T12:59:00+08:00')), 'lunch');
  assert.equal(cnMarketPhase(d('2026-09-11T13:00:00+08:00')), 'open');
  assert.equal(cnMarketPhase(d('2026-09-11T15:00:00+08:00')), 'closed');
  assert.equal(cnMarketPhase(d('2026-09-05T12:00:00+08:00')), 'closed'); // 周六：午间也不是 lunch
  // 港股：12:00–13:00 午休（与 A 股错开）
  assert.equal(hkMarketPhase(d('2026-09-11T11:45:00+08:00')), 'open');
  assert.equal(hkMarketPhase(d('2026-09-11T12:30:00+08:00')), 'lunch');
  assert.equal(hkMarketPhase(d('2026-09-11T13:30:00+08:00')), 'open');
  // 指数 → 阶段（卡片状态点用）；美股无午休
  assert.equal(marketPhaseOf('000300', d('2026-09-11T12:00:00+08:00')), 'lunch');
  assert.equal(marketPhaseOf('HSI', d('2026-09-11T12:00:00+08:00')), 'lunch');
  assert.equal(marketPhaseOf('NDX', d('2026-09-11T12:00:00+08:00')), 'closed');
  // marketStatusOf.items 带 phase（头部徽标用），open 语义不变
  const st = marketStatusOf(d('2026-09-11T12:00:00+08:00'));
  assert.deepEqual(
    st.items.map((i) => i.phase),
    ['lunch', 'lunch', 'closed'],
  );
  assert.deepEqual(
    st.items.map((i) => i.open),
    [false, false, false],
  );
});

test('beijingToday / beijingMinutes：时区无关的北京交易日与墙钟（估值曲线日期判定用）', () => {
  // 用"北京日期 ≠ UTC 日期"的瞬间来证明做的是 +8 平移（而非读运行时时区/UTC）
  assert.equal(beijingToday(new Date('2026-09-10T17:00:00Z')), '2026-09-11'); // 北京次日 01:00
  assert.equal(beijingToday(new Date('2026-09-10T15:59:59Z')), '2026-09-10'); // 北京 23:59:59
  assert.equal(beijingToday(new Date('2026-09-11T00:00:00+08:00')), '2026-09-11');
  assert.equal(beijingToday(new Date('2026-09-11T23:59:59+08:00')), '2026-09-11');
  // 墙钟分钟：开盘 / 午休中 / 收盘后 / 午夜边界
  assert.equal(beijingMinutes(new Date('2026-09-11T09:30:00+08:00')), 570);
  assert.equal(beijingMinutes(new Date('2026-09-11T12:03:00+08:00')), 723);
  assert.equal(beijingMinutes(new Date('2026-09-11T15:00:00+08:00')), 900);
  assert.equal(beijingMinutes(new Date('2026-09-11T00:05:00+08:00')), 5);
});

test('marketOfIndex × marketStatusOf：映射结果可直接索引三市场状态（app.js 用法回归）', () => {
  const status = marketStatusOf(new Date('2026-07-15T23:00:00+08:00')); // 深夜：仅美股开
  // 老实现：IXIC/SOX/HXC 落到 cn → false（美股明明开盘却显示"已收盘"）；修复后三只均为 us → true
  for (const us of ['NDX', 'IXIC', 'SOX', 'HXC']) {
    assert.equal(status[marketOfIndex(us)], true);
  }
  assert.equal(status[marketOfIndex('HSI')], false);
  assert.equal(status[marketOfIndex('000300')], false);
});

// ---- 法定节假日感知（chinese-days 由调用方注入；2026-10-06 周二＝国庆假期，实证 A 股休市、港股照常）----

const HOLIDAY_NOW = new Date('2026-10-06T02:30:00Z'); // 北京 10-06（周二）10:30，A 股交易时段内
const CN_HOLIDAYS = new Set(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']);

test('cnMarketPhase：假期日在交易时段内 → 注入节假日集合判 closed；缺省退化只跳周末（旧行为）', () => {
  assert.equal(cnMarketPhase(HOLIDAY_NOW), 'open'); // 无节假日数据：工作日粗判（旧行为兜底）
  assert.equal(cnMarketPhase(HOLIDAY_NOW, CN_HOLIDAYS), 'closed');
  assert.equal(cnMarketPhase(HOLIDAY_NOW, ['2026-10-06']), 'closed'); // 数组注入同效
});

test('marketStatusOf / marketPhaseOf：假期日 A 股 closed；港股不跟内地假期照常 open；美股不受影响', () => {
  const st = marketStatusOf(HOLIDAY_NOW, CN_HOLIDAYS);
  const cnItem = st.items.find((i) => i.label === 'A股');
  const hkItem = st.items.find((i) => i.label === '港股');
  assert.equal(cnItem.open, false);
  assert.equal(cnItem.phase, 'closed');
  assert.equal(hkItem.open, true); // 10-06 港股实证开市（时间戳实时更新），不因内地假期误判休市
  assert.equal(hkItem.phase, 'open');
  assert.equal(marketPhaseOf('000300', HOLIDAY_NOW, CN_HOLIDAYS), 'closed');
  assert.equal(marketPhaseOf('000001', HOLIDAY_NOW, CN_HOLIDAYS), 'closed');
  // 港股相位忽略内地节假日集合（香港自有历法未建模，行情时间戳兜底）
  assert.equal(marketPhaseOf('HSI', HOLIDAY_NOW, CN_HOLIDAYS), 'open');
  // 美股分支不受集合影响（美东 10-05 周一 22:30 = 北京 10-06 10:30，冬令时盘前）
  assert.equal(marketPhaseOf('NDX', HOLIDAY_NOW, CN_HOLIDAYS), 'closed');
});
