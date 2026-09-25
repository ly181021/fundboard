const STORAGE_KEY = 'fund-tracker-data';

/**
 * 创建存储实例。可注入 storage 对象（默认用浏览器 localStorage）。
 * 测试时传入内存模拟的 storage。
 */
export function createStore({ storage } = {}) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) throw new Error('无可用存储后端');

  return {
    /** 读取全部资产数据，无数据时返回 { assets: [] } */
    loadAssets() {
      const raw = s.getItem(STORAGE_KEY);
      if (!raw) return { assets: [] };
      try {
        return JSON.parse(raw);
      } catch {
        return { assets: [] };
      }
    },

    /** 保存全部资产数据 */
    saveAssets(data) {
      s.setItem(STORAGE_KEY, JSON.stringify(data));
    },

    /** 导出为 JSON 字符串（用于下载备份） */
    exportJSON() {
      return JSON.stringify(
        s.getItem(STORAGE_KEY) ? JSON.parse(s.getItem(STORAGE_KEY)) : { assets: [] },
        null,
        2,
      );
    },

    /** 从 JSON 字符串导入（覆盖现有数据） */
    importJSON(jsonStr) {
      const data = JSON.parse(jsonStr);
      this.saveAssets(data);
      return data;
    },
  };
}

/**
 * 服务端存储后端。接口与 createStore 一致。
 * @returns {object}
 * @property {Function} loadAssets - GET /api/data → 内存态 + 写镜像（复用 fund-tracker-data 键，
 *   旧 localStorage 数据天然成为迁移源与离线兜底）；失败 → 读镜像，不抛异常
 * @property {Function} saveAssets - PUT /api/data（带 base_updated_at 乐观锁）；失败 → pendingDoc +
 *   镜像兜底，返回 {ok:false, pending:true}；恢复后下次保存自动先重推 pendingDoc。
 *   409 冲突向上抛（err.conflict=true），由 UI 提示刷新
 * @property {Function} exportJSON - 基于当前内存态导出全量 JSON
 * @property {Function} importJSON - 解析 JSON 并写入服务端（409 冲突会抛出）
 */
export function createServerStore({
  fetchFn,
  baseUrl = '',
  fallbackStorage,
  now = () => new Date(),
  getHeaders,
} = {}) {
  const f = fetchFn ?? (typeof window !== 'undefined' ? window.fetch.bind(window) : undefined);
  const mirror = fallbackStorage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  const MIRROR_KEY = STORAGE_KEY; // 复用主数据键
  const extraHeaders = () => (typeof getHeaders === 'function' ? getHeaders() : {});

  let serverUpdatedAt = null;
  let currentDoc = { version: 1, assets: [], daily: [], ai_log: [], corrections: [] };
  let baseDoc = { version: 1, assets: [], daily: [], ai_log: [], corrections: [] }; // 最近一次已知服务端态（409 合流比对基准，必须深拷贝维护）
  let pendingDoc = null;
  let reachable = false;
  let authRequired = false; // 服务端返回 401（局域网模式要求口令）

  /** 稳定序列化（键排序递归）——比对不受对象属性插入序影响 */
  function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
        .join(',') +
      '}'
    );
  }

  /** 两个文档顶层键中取值不同者的集合（version/assets/daily/ai_log/corrections）。
   *  列表键缺省（老文档无该字段）按空数组归一化——否则"服务端无 corrections + 本地 []"会被误判为变更，
   *  使既有"远端仅推进 daily 自动合流"失效（向后兼容）。 */
  function changedKeys(a, b) {
    const keys = ['version', 'assets', 'daily', 'ai_log', 'corrections'];
    const norm = (doc, k) => {
      const v = doc?.[k];
      return v === undefined && k !== 'version' ? [] : v;
    };
    return keys.filter((k) => stableStringify(norm(a, k)) !== stableStringify(norm(b, k)));
  }

  /** GET 服务端当前文档（合流用，只读探测）；失败返回 null */
  async function fetchServerDoc() {
    try {
      const res = await f(`${baseUrl}/api/data`, { headers: extraHeaders() });
      if (!res.ok) return null;
      const payload = await res.json();
      return { data: payload?.data ?? {}, updated_at: payload?.updated_at ?? null };
    } catch {
      return null;
    }
  }

  function saveMirror(doc) {
    try {
      mirror?.setItem(
        MIRROR_KEY,
        JSON.stringify({
          version: doc.version ?? 1,
          assets: doc.assets ?? [],
          ai_log: Array.isArray(doc.ai_log) ? doc.ai_log : [],
          corrections: Array.isArray(doc.corrections) ? doc.corrections : [], // 修正留痕小且属审计数据，镜像一并保留
        }),
      );
    } catch {
      /* 镜像写失败不影响主流程 */
    }
  }

  function loadMirror() {
    try {
      const raw = mirror?.getItem(MIRROR_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return Array.isArray(obj?.assets)
        ? {
            version: obj.version ?? 1,
            assets: obj.assets,
            daily: [],
            ai_log: Array.isArray(obj.ai_log) ? obj.ai_log : [],
            corrections: Array.isArray(obj.corrections) ? obj.corrections : [],
          }
        : null;
    } catch {
      return null;
    }
  }

  /** PUT 当前文档；返回是否成功；401 抛 auth 错误；409 抛 conflict 错误；其余失败返回 false */
  async function push(doc) {
    try {
      const res = await f(`${baseUrl}/api/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...extraHeaders() },
        body: JSON.stringify({ ...doc, base_updated_at: serverUpdatedAt }),
      });
      if (res.status === 401) {
        const err = new Error('unauthorized');
        err.auth = true;
        throw err;
      }
      if (res.status === 409) {
        // ---- 字段级合流：远端仅推进 daily 时自动合流重推一次 ----
        const fresh = await fetchServerDoc();
        if (fresh && fresh.data) {
          const diffKeys = changedKeys(baseDoc, fresh.data);
          if (diffKeys.length === 1 && diffKeys[0] === 'daily') {
            serverUpdatedAt = fresh.updated_at ?? serverUpdatedAt;
            const mergedBody = JSON.stringify({
              ...doc,
              daily: Array.isArray(fresh.data.daily) ? fresh.data.daily : [],
              base_updated_at: serverUpdatedAt,
            });
            let retryRes;
            try {
              retryRes = await f(`${baseUrl}/api/data`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...extraHeaders() },
                body: mergedBody,
              });
            } catch {
              retryRes = null;
            }
            if (retryRes && retryRes.ok) {
              const p = await retryRes.json().catch(() => ({}));
              serverUpdatedAt = p.updated_at ?? serverUpdatedAt;
              // 合流成功后回流 currentDoc.daily——否则下次保存用旧 daily 整体替换，回滚快照任务刚入账的台账行
              currentDoc = structuredClone({
                ...doc,
                daily: Array.isArray(fresh.data.daily) ? fresh.data.daily : [],
              });
              baseDoc = structuredClone(currentDoc); // 深拷贝，防污染基准
              reachable = true;
              return true;
            }
          }
        }
        const p = await res.json().catch(() => ({}));
        const err = new Error('conflict: 服务端数据已被其他窗口修改');
        err.conflict = true;
        err.serverUpdatedAt = p.server_updated_at ?? null;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = await res.json();
      serverUpdatedAt = p.updated_at ?? serverUpdatedAt;
      baseDoc = structuredClone(doc); // 成功落盘即刷新基准
      reachable = true;
      return true;
    } catch (e) {
      if (e.conflict) throw e;
      reachable = false;
      return false;
    }
  }

  return {
    /** 服务端最近一次探测是否可达 */
    get reachable() {
      return reachable;
    },
    /** 是否有断连期间待重推的数据 */
    get pendingSync() {
      return pendingDoc != null;
    },
    /** 服务端要求访问口令（401），需设置后重试 */
    get authRequired() {
      return authRequired;
    },

    /** 读取全量数据；断连时回落镜像；401 置 authRequired 并回落镜像 */
    async loadAssets() {
      try {
        const res = await f(`${baseUrl}/api/data`, { headers: extraHeaders() });
        if (res.status === 401) {
          reachable = false;
          authRequired = true;
          const mirrored = loadMirror();
          if (mirrored) currentDoc = mirrored;
          return currentDoc;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        authRequired = false;
        const payload = await res.json();
        const data = payload?.data ?? {};
        currentDoc = {
          version: data.version ?? 1,
          assets: Array.isArray(data.assets) ? data.assets : [],
          daily: Array.isArray(data.daily) ? data.daily : [],
          ai_log: Array.isArray(data.ai_log) ? data.ai_log : [],
          corrections: Array.isArray(data.corrections) ? data.corrections : [],
        };
        serverUpdatedAt = payload?.updated_at ?? null;
        baseDoc = structuredClone(currentDoc); // 基准 = 服务端当前态深拷贝
        reachable = true;
        saveMirror(currentDoc);
        return currentDoc;
      } catch {
        reachable = false;
        const mirrored = loadMirror();
        if (mirrored) currentDoc = mirrored;
        return currentDoc;
      }
    },

    /** 保存全量数据；断连时存 pendingDoc 并写镜像，恢复后自动先重推 */
    async saveAssets(data) {
      const doc = {
        version: data?.version ?? 1,
        assets: Array.isArray(data?.assets) ? data.assets : [],
        daily: Array.isArray(data?.daily) ? data.daily : [],
        ai_log: Array.isArray(data?.ai_log) ? data.ai_log : [],
        corrections: Array.isArray(data?.corrections) ? data.corrections : [],
      };
      if (pendingDoc) {
        const pendDaily = pendingDoc.daily; // 重推前的 daily 引用——合流会整体替换 currentDoc（daily 引用必变），普通成功不会
        const pushed = await push(pendingDoc);
        if (!pushed) {
          saveMirror(doc);
          return { ok: false, pending: true };
        }
        pendingDoc = null;
        // 判别基准取pendingDoc自身daily引用，而非本次doc。
        // 普通重推（无409）currentDoc仍是旧文档；currentDoc.daily !== doc.daily恒真，会把调用方新入账daily覆盖回旧值。
        // 仅真实回流合流（currentDoc整体替换、daily引用变更），才采纳回流值。
        if (currentDoc.daily !== pendDaily) doc.daily = currentDoc.daily;
      }
      currentDoc = doc;
      const pushed = await push(doc);
      if (!pushed) {
        pendingDoc = doc;
        saveMirror(doc);
        return { ok: false, pending: true };
      }
      // 合流可能更新currentDoc.daily（服务端采纳值），回传给调用方；前端采纳后下次保存不再带旧daily。
      doc.daily = currentDoc.daily;
      saveMirror(doc);
      return { ok: true, daily: currentDoc.daily };
    },

    /** 导出当前内存态为 JSON 字符串 */
    exportJSON() {
      return JSON.stringify(
        {
          version: currentDoc.version,
          assets: currentDoc.assets,
          daily: currentDoc.daily,
          ai_log: Array.isArray(currentDoc.ai_log) ? currentDoc.ai_log : [],
          corrections: Array.isArray(currentDoc.corrections) ? currentDoc.corrections : [],
        },
        null,
        2,
      );
    },

    /** 解析 JSON 并写入服务端（409 冲突会抛出） */
    async importJSON(jsonStr) {
      const data = JSON.parse(jsonStr);
      await this.saveAssets(data);
      return data;
    },
  };
}
