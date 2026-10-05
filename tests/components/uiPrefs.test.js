import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUMMARY_BOOL_KEYS,
  parseBoolFlag,
  loadBool,
  saveBool,
  BLOCK_KEYS,
  DEFAULT_BLOCK_ORDER,
  parseBlockOrder,
  serializeBlockOrder,
  loadBlockOrder,
  saveBlockOrder,
  maskText,
  visibleOrderOf,
  moveInOrder,
  dropInOrder,
  MSG_READ_KEY,
  parseMsgReadSigs,
  loadMsgReadSigs,
  saveMsgReadSigs,
} from '../../js/uiPrefs.js';

const mockStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem(k, v) {
      data[k] = String(v);
    },
  };
};

// parseBoolFlag 边界
test("uiPrefs U1：parseBoolFlag——'1'/'true' 为真，其余（null/'0'/'yes'/空串）为假", () => {
  assert.equal(parseBoolFlag('1'), true);
  assert.equal(parseBoolFlag('true'), true);
  assert.equal(parseBoolFlag(null), false);
  assert.equal(parseBoolFlag(undefined), false);
  assert.equal(parseBoolFlag('0'), false);
  assert.equal(parseBoolFlag('yes'), false);
  assert.equal(parseBoolFlag(''), false);
});

// loadBool：缺省/合法/异常
test("uiPrefs U2：loadBool——缺省 false、'1' 为真、存储异常静默回退 false", () => {
  const s1 = mockStorage();
  assert.equal(loadBool(s1, 'k'), false);
  const s2 = mockStorage({ k: '1' });
  assert.equal(loadBool(s2, 'k'), true);
  const broken = {
    getItem() {
      throw new Error('denied');
    },
  };
  assert.equal(loadBool(broken, 'k'), false);
});

// saveBool：写 '1'/''、异常静默
test("uiPrefs U3：saveBool——true 写 '1'、false 写 ''、存储异常静默", () => {
  const s = mockStorage();
  saveBool(s, 'k', true);
  assert.equal(s.data.k, '1');
  saveBool(s, 'k', false);
  assert.equal(s.data.k, '');
  const broken = {
    setItem() {
      throw new Error('denied');
    },
  };
  saveBool(broken, 'k', true); // 不抛
});

// parseBlockOrder：默认/合法/非数组/缺键/重复键/陌生键（summary 退役，白名单过滤保序）
test('uiPrefs U4：parseBlockOrder——缺省回默认；非法形态一律回退默认', () => {
  assert.deepEqual(parseBlockOrder(undefined), DEFAULT_BLOCK_ORDER);
  assert.deepEqual(parseBlockOrder('{"a":1}'), DEFAULT_BLOCK_ORDER); // 非数组
  assert.deepEqual(parseBlockOrder('["summary"]'), DEFAULT_BLOCK_ORDER); // 过滤后键数不足 → 回退
  assert.deepEqual(parseBlockOrder('["summary","summary"]'), DEFAULT_BLOCK_ORDER); // 重复（去重后缺键）
  assert.deepEqual(parseBlockOrder('["health","zzz"]'), DEFAULT_BLOCK_ORDER); // 陌生键（去重白名单后缺键）
  assert.deepEqual(parseBlockOrder('not json'), DEFAULT_BLOCK_ORDER); // 解析失败
});

// U4b 旧存顺序兼容：summary 在白名单中被丢弃、剩余键保序（只有键数不足才整体回退）
test('uiPrefs U4b：parseBlockOrder——旧顺序含已退役 summary → 白名单过滤保序', () => {
  assert.deepEqual(parseBlockOrder('["health","summary","idx"]'), ['health', 'idx']);
  assert.deepEqual(parseBlockOrder('["idx","summary","health"]'), ['idx', 'health']); // 用户自定义顺序保留，不回退默认
  assert.deepEqual(parseBlockOrder('["health","idx"]'), ['health', 'idx']);
});

// parseBlockOrder 数组入参透传（兼容路径）
test('uiPrefs U5：parseBlockOrder——数组入参直接透传（不二次 JSON.parse）', () => {
  assert.deepEqual(parseBlockOrder(['idx', 'health']), ['idx', 'health']);
  assert.deepEqual(parseBlockOrder(['summary', 'idx']), DEFAULT_BLOCK_ORDER); // 过滤后仅 idx → 键数不足 → 回退
});

// serialize roundtrip
test('uiPrefs U6：serializeBlockOrder 与 parseBlockOrder 互逆', () => {
  const order = ['idx', 'health'];
  const raw = serializeBlockOrder(order);
  assert.equal(typeof raw, 'string');
  assert.deepEqual(parseBlockOrder(raw), order);
});

// loadBlockOrder/saveBlockOrder 对称 + 异常回退
test('uiPrefs U7：loadBlockOrder——合法存储读出、非法/异常回退默认；saveBlockOrder 落 JSON', () => {
  const s = mockStorage({ 'ui-block-order': '["idx","health"]' });
  assert.deepEqual(loadBlockOrder(s), ['idx', 'health']);
  assert.deepEqual(loadBlockOrder(mockStorage()), DEFAULT_BLOCK_ORDER);
  assert.deepEqual(
    loadBlockOrder(mockStorage({ 'ui-block-order': '["summary"]' })),
    DEFAULT_BLOCK_ORDER,
  );
  assert.deepEqual(
    loadBlockOrder({
      getItem() {
        throw new Error('denied');
      },
    }),
    DEFAULT_BLOCK_ORDER,
  );
  const s2 = mockStorage();
  saveBlockOrder(s2, 'ui-block-order', ['idx', 'health']);
  assert.deepEqual(parseBlockOrder(s2.data['ui-block-order']), ['idx', 'health']);
  saveBlockOrder(
    {
      setItem() {
        throw new Error('denied');
      },
    },
    'k',
    DEFAULT_BLOCK_ORDER,
  ); // 不抛
});

// maskText
test("uiPrefs U8：maskText——隐藏恒 '••••••'、显示透传字符串化", () => {
  assert.equal(maskText('¥48,000.00', true), '••••••');
  assert.equal(maskText('¥48,000.00', false), '¥48,000.00');
  assert.equal(maskText(null, true), '••••••');
  assert.equal(maskText(null, false), '');
  assert.equal(maskText(0, false), '0');
});

// 附：BLOCK_KEYS 与默认顺序一致性（summary 退役 → 两键）
test('uiPrefs 附：BLOCK_KEYS 两键（health→idx）、DEFAULT_BLOCK_ORDER 同序', () => {
  assert.deepEqual(BLOCK_KEYS, ['health', 'idx']);
  assert.deepEqual(DEFAULT_BLOCK_ORDER, ['health', 'idx']);
  assert.deepEqual(SUMMARY_BOOL_KEYS, {
    hidden: 'ui-summary-hidden',
    collapsed: 'ui-summary-collapsed',
  });
});

// ---- 排序按「可见块」计算（隐藏块不占槽位）----

const ALL_VIS = { health: true, idx: true };
const NO_HEALTH = { health: false, idx: true }; // 本地模式：数据源条整体隐藏

test('visibleOrderOf：按顺序过滤隐藏块（隐藏块不占排序槽位）', () => {
  assert.deepEqual(visibleOrderOf(DEFAULT_BLOCK_ORDER, ALL_VIS), ['health', 'idx']);
  assert.deepEqual(visibleOrderOf(DEFAULT_BLOCK_ORDER, NO_HEALTH), ['idx']);
  assert.deepEqual(visibleOrderOf(['idx', 'health'], NO_HEALTH), ['idx']);
});

test('moveInOrder：全可见时切除-插入；越界/未知 key/唯一可见块返回原顺序副本', () => {
  assert.deepEqual(moveInOrder(['health', 'idx'], ALL_VIS, 'idx', -1), ['idx', 'health']);
  assert.deepEqual(moveInOrder(['health', 'idx'], ALL_VIS, 'health', -1), ['health', 'idx']); // 顶部 ↑ 越界
  assert.deepEqual(moveInOrder(['health', 'idx'], ALL_VIS, 'idx', 1), ['health', 'idx']); // 底部 ↓ 越界
  assert.deepEqual(moveInOrder(['health', 'idx'], ALL_VIS, 'nope', -1), ['health', 'idx']); // 未知 key
  assert.deepEqual(moveInOrder(DEFAULT_BLOCK_ORDER, NO_HEALTH, 'idx', -1), DEFAULT_BLOCK_ORDER); // 唯一可见块 ↑ 越界
});

test('dropInOrder：切除-插入语义（A 拖到 C 后 → [B,C,A]）；同键/空源/未知键原样', () => {
  assert.deepEqual(dropInOrder(['health', 'idx'], ALL_VIS, 'health', 'idx'), ['idx', 'health']);
  // 健康条隐藏时：唯一可见块，拖放无从发生 → 原样
  assert.deepEqual(
    dropInOrder(DEFAULT_BLOCK_ORDER, NO_HEALTH, 'health', 'idx'),
    DEFAULT_BLOCK_ORDER,
  );
  assert.deepEqual(dropInOrder(DEFAULT_BLOCK_ORDER, ALL_VIS, 'idx', 'idx'), DEFAULT_BLOCK_ORDER);
  assert.deepEqual(dropInOrder(DEFAULT_BLOCK_ORDER, ALL_VIS, '', 'idx'), DEFAULT_BLOCK_ORDER);
  assert.deepEqual(
    dropInOrder(DEFAULT_BLOCK_ORDER, ALL_VIS, 'health', 'nope'),
    DEFAULT_BLOCK_ORDER,
  );
});

test('消息已读签名（MSG_READ_KEY）：解析过滤非字符串；读写往返；截尾防增长；异常回退空', () => {
  const storage = mockStorage();
  // 空存储 → 空数组
  assert.deepEqual(loadMsgReadSigs(storage), []);
  // 解析器直测：非法 JSON / 非数组 → 空数组；非字符串项过滤
  assert.deepEqual(parseMsgReadSigs('{broken'), []);
  assert.deepEqual(parseMsgReadSigs(JSON.stringify({ nope: 1 })), []);
  assert.deepEqual(parseMsgReadSigs(JSON.stringify(['ok', 42, null])), ['ok']);
  // 写入 → 往返一致
  saveMsgReadSigs(storage, ['a|1|2', 'b|2|3']);
  assert.deepEqual(loadMsgReadSigs(storage), ['a|1|2', 'b|2|3']);
  // 非法 JSON / 非数组 / 含非字符串项 → 过滤或回退空
  storage.setItem(MSG_READ_KEY, '{broken');
  assert.deepEqual(loadMsgReadSigs(storage), []);
  storage.setItem(MSG_READ_KEY, JSON.stringify({ nope: 1 }));
  assert.deepEqual(loadMsgReadSigs(storage), []);
  storage.setItem(MSG_READ_KEY, JSON.stringify(['ok', 42, null]));
  assert.deepEqual(loadMsgReadSigs(storage), ['ok']);
  // 截尾：超过 200 条只留最近 200 条
  const many = Array.from({ length: 260 }, (_, i) => `s${i}`);
  saveMsgReadSigs(storage, many);
  assert.equal(loadMsgReadSigs(storage).length, 200);
  assert.equal(loadMsgReadSigs(storage)[0], 's60');
});
