/**
 * 页面偏好纯函数。
 * 约定：零 Node 全局、零副作用——storage 由调用方注入（浏览器传 localStorage），双端 ESM 可载、可 node 单测。
 * 内容：资产总览折叠/打码布尔偏好 + 首页三区块排序（顺序解析/序列化）+ 数字打码。
 */

/** 收益总览偏好键（localStorage；收益页 M1 的折叠/打码与首页收益条的眼睛按钮双入口共用，键名不变） */
export const SUMMARY_BOOL_KEYS = { hidden: 'ui-summary-hidden', collapsed: 'ui-summary-collapsed' };

/** '1'/'true' → true；其余 → false */
export function parseBoolFlag(raw) {
  return raw === '1' || raw === 'true';
}

/** 读布尔偏好：缺省/非法/存储异常一律 false（防隐私模式等抛错） */
export function loadBool(storage, key) {
  try {
    return parseBoolFlag(storage.getItem(key));
  } catch {
    return false;
  }
}

/** 写布尔偏好：true 存 '1'、false 存 ''；写入失败静默（隐私模式） */
export function saveBool(storage, key, value) {
  try {
    storage.setItem(key, value ? '1' : '');
  } catch {
    /* 静默 */
  }
}

/**
 * 首页区块 key（顺序即默认顺序：数据源健康条 → 核心指数）。
 * 'summary'（资产总览）已迁入收益页 M1 并退役——旧存储含 summary 时由
 * parseBlockOrder 白名单过滤保序（仅当过滤后键数不足才整体回退默认）。
 */
export const BLOCK_KEYS = ['health', 'idx'];

/** 默认顺序（与 BLOCK_KEYS 同序副本，防外部改写） */
export const DEFAULT_BLOCK_ORDER = BLOCK_KEYS.slice();

/**
 * 区块顺序解析：兼容 string（JSON）与 array 双入参；
 * 非法/缺键/重复键/含陌生键 → 回退默认顺序。
 */
export function parseBlockOrder(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return DEFAULT_BLOCK_ORDER.slice();
    const keys = [...new Set(arr)].filter((k) => BLOCK_KEYS.includes(k)); // 去重 + 白名单
    return keys.length === BLOCK_KEYS.length ? keys : DEFAULT_BLOCK_ORDER.slice();
  } catch {
    return DEFAULT_BLOCK_ORDER.slice();
  }
}

export function serializeBlockOrder(order) {
  return JSON.stringify(order);
}

/** 读区块顺序（key 缺省 ui-block-order）；非法/异常回退默认 */
export function loadBlockOrder(storage, key = 'ui-block-order') {
  try {
    return parseBlockOrder(storage.getItem(key));
  } catch {
    return DEFAULT_BLOCK_ORDER.slice();
  }
}

/** 写区块顺序；失败静默 */
export function saveBlockOrder(storage, key, order) {
  try {
    storage.setItem(key, serializeBlockOrder(order));
  } catch {
    /* 静默 */
  }
}

/** 数字打码：隐藏时恒 '••••••'（长度 6）；显示时透传字符串化 */
export function maskText(value, hidden) {
  return hidden ? '••••••' : String(value ?? '');
}

// ---- 排序运算（隐藏块不占排序槽位，见 visibleOrderOf 注释）----

/** 可见块序列：按 order 顺序过滤出 visible[k] 为真的 key（隐藏块不占槽位） */
export function visibleOrderOf(order, visible) {
  return order.filter((k) => visible[k]);
}

/** 可见块按 nextVisible 定序，隐藏块保持相对次序缀尾（视觉等价；结果仍是全键排列） */
function mergeVisibleOrder(order, nextVisible) {
  return [...nextVisible, ...order.filter((k) => !nextVisible.includes(k))];
}

/**
 * ↑↓ 按钮：在可见序列内切除-插入（dir=-1 上移 / +1 下移），隐藏块缀尾。
 * 越界或未知 key → 原顺序副本（不抛、不首尾倒置）。
 * 关键点：若按含隐藏块的全序列移动，会与被隐藏的邻居互换 —— 首次点击无任何视觉变化。
 */
export function moveInOrder(order, visible, key, dir) {
  const vis = visibleOrderOf(order, visible);
  const from = vis.indexOf(key);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= vis.length) return order.slice();
  vis.splice(from, 1);
  vis.splice(to, 0, key);
  return mergeVisibleOrder(order, vis);
}

/** 拖放落位：可见序列内切除-插入（A 拖到 C 后 → [B,C,A]，非 swap）；非法落点/同键 → 原顺序副本 */
export function dropInOrder(order, visible, sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return order.slice();
  const vis = visibleOrderOf(order, visible);
  const from = vis.indexOf(sourceKey),
    to = vis.indexOf(targetKey);
  if (from < 0 || to < 0) return order.slice();
  vis.splice(from, 1);
  vis.splice(to, 0, sourceKey);
  return mergeVisibleOrder(order, vis);
}
