/**
 * 极简 TTL 内存缓存（服务端）。
 * now 可注入，便于测试过期逻辑；单进程内生效，重启即清空（行情数据可随时重取）。
 */
export function createCache({ now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      map.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  };
}
