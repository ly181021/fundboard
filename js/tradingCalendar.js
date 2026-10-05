/**
 * A 股交易日历（chinese-days 节假日数据，jsDelivr CDN）。
 * 交易日 = 周一至周五 且 不在法定节假日；调休补班日（周末变工作日）A 股仍休市，
 * 故只认"周末 + 节假日"两类非交易日（与基估宝 tradingCalendar 同口径）。
 *
 * 零依赖、fetchFn 可注入（测试用假响应）；节假日数据按年缓存；
 * 加载失败降级为"周一至周五"粗判（宁可用旧口径也不阻塞业务）。
 * 浏览器（js/app.js）与服务端（lib/snapshot.js）共用。
 */
const CDN = 'https://cdn.jsdelivr.net/npm/chinese-days@1/dist/years';

export function createTradingCalendar({ fetchFn, cache = new Map() } = {}) {
  const f = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  /** 某年法定节假日集合（YYYY-MM-DD）；拉取失败返回空集合（按周一至周五粗判） */
  async function holidaysOf(year) {
    if (cache.has(year)) return cache.get(year);
    let set = new Set();
    if (f) {
      try {
        const res = await f(`${CDN}/${year}.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && typeof data.holidays === 'object') {
          set = new Set(Object.keys(data.holidays));
        }
      } catch {
        // 静默降级：无节假日数据时按工作日粗判
      }
    }
    cache.set(year, set);
    return set;
  }

  /** dateStr（YYYY-MM-DD）是否为 A 股交易日；格式非法返回 null */
  async function isTradingDay(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) return false;
    const holidays = await holidaysOf(y);
    return !holidays.has(dateStr);
  }

  /** 若干年份法定节假日日期的并集（YYYY-MM-DD Set）；跨年推进场景由调用方传入相邻年份。按年缓存，重复调用不重复请求。 */
  async function holidaysOfYears(years) {
    const set = new Set();
    for (const y of new Set((years || []).map(Number))) {
      for (const d of await holidaysOf(y)) set.add(d);
    }
    return set;
  }

  return { isTradingDay, holidaysOf, holidaysOfYears };
}
