/**
 * 前端行情拉取与降级。
 * fetchFn / storage 可注入便于 node:test；任何失败路径都不抛异常，
 * 失败归入 errors，由 UI 显示"待更新"占位。
 */
const QUOTES_KEY = 'fund-tracker-quotes';

export function createQuoteService({
  fetchFn,
  baseUrl = '',
  storage,
  now = () => new Date(),
} = {}) {
  const f = fetchFn ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : undefined);
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);

  return {
    /**
     * 拉取一批基金行情，返回 { quotes, errors }。
     * 网络 / HTTP 非 200 / JSON 解析失败 → quotes 为空并逐只给出 error；绝不抛异常。
     */
    async fetchQuotes(codes) {
      const list = [...new Set(codes || [])];
      if (list.length === 0) return { quotes: [], errors: [] };
      try {
        const res = await f(`${baseUrl}/api/quote?codes=${list.join(',')}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
        const errors = Array.isArray(payload?.errors) ? [...payload.errors] : [];
        // 请求了但响应里缺失的代码也计入 errors，UI 才能逐只降级（源侧已报错的不重复计）
        const got = new Set(quotes.map((q) => q.code));
        const errCodes = new Set(errors.map((e) => e.code));
        for (const c of list) {
          if (!got.has(c) && !errCodes.has(c)) errors.push({ code: c, error: 'no_data' });
        }
        if (quotes.length > 0 && s) {
          // 合并写入：单只刷新（refreshEstimateQuote复用）禁止整体覆盖。
          // 旧实现会抹除缓存其他基金行情，冷启动仅最后刷新基金支持「先显示再更新」。
          // 坏缓存/无缓存从空对象起底；同code新值覆盖旧值。
          let prev = {};
          try {
            const old = JSON.parse(s.getItem(QUOTES_KEY));
            if (old && old.quotes && typeof old.quotes === 'object') prev = old.quotes;
          } catch {
            /* 坏缓存视为空 */
          }
          const map = { ...prev };
          for (const q of quotes) map[q.code] = q;
          s.setItem(QUOTES_KEY, JSON.stringify({ quotes: map, fetched_at: now().toISOString() }));
        }
        return { quotes, errors };
      } catch (e) {
        return {
          quotes: [],
          errors: list.map((c) => ({ code: c, error: String(e?.message || e) })),
        };
      }
    },

    /** 读最近一次行情缓存（页面刷新时先显示再更新）；无缓存/坏缓存返回空结构 */
    loadCachedQuotes() {
      if (!s) return { quotes: {} };
      try {
        const obj = JSON.parse(s.getItem(QUOTES_KEY));
        return obj && obj.quotes && typeof obj.quotes === 'object'
          ? { quotes: obj.quotes, fetched_at: obj.fetched_at ?? null }
          : { quotes: {} };
      } catch {
        return { quotes: {} };
      }
    },

    /** 历史净值序列（走势弹窗用）；失败返回空序列，不抛异常 */
    async fetchHistory(code, days = 90) {
      try {
        const res = await f(`${baseUrl}/api/history?code=${code}&days=${days}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        return { series: Array.isArray(payload?.series) ? payload.series : [] };
      } catch (e) {
        return { series: [], error: String(e?.message || e) };
      }
    },

    /** 大盘指数（今日分析参照用）；失败返回空数组，不抛异常 */
    async fetchIndexes() {
      try {
        const res = await f(`${baseUrl}/api/index`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        return { indexes: Array.isArray(payload?.indexes) ? payload.indexes : [] };
      } catch {
        return { indexes: [] };
      }
    },
  };
}
