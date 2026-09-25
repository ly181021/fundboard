/**
 * 数据源健康存储。
 * data/source_health.json：服务端单写方，与db.json乐观锁零交叉（写隔离红线）；
 *   前端仅GET /api/source-health读取，客户端归一判定ok/fail/idle。
 * 落盘并发安全：串行写队列+随机后缀tmp，防止rename冲突、Windows EBUSY；
 *   写失败只console.error，绝不抛异常（健康监控不得反噬行情/策略业务）。
 * 单次record仅取一次now：lastOkAt与fallbackUsedAt恒同值。
 * 备源标识：meta.fallback=true 本次成功走备源（lsjz→蛋卷、push2指数→新浪）。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_KEYS = ['push2', 'estimate', 'sina', 'lsjz'];

/** 错误只存摘要不存原文：去空白 + 截断 60 字（防敏感信息落盘） */
function summarize(err) {
  return String(err?.message || err || '')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

function blankSources() {
  const m = {};
  for (const k of SOURCE_KEYS)
    m[k] = { lastOkAt: null, lastErrAt: null, lastErrMsg: null, errCount: 0, fallbackUsedAt: null };
  return m;
}

export function createSourceHealth({ dataDir }) {
  const filePath = join(dataDir, 'source_health.json');
  let sources = null; // null = 尚未有数据（文件缺失/读失败）
  let writeQueue = Promise.resolve();

  const nowIso = () => new Date().toISOString();

  /** 启动即读盘：健康状态跨重启保留；缺失/坏 JSON 按空处理 */
  const ready = (async () => {
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      const m = {};
      for (const k of SOURCE_KEYS) {
        const s = raw?.sources?.[k] || {};
        m[k] = {
          lastOkAt: s.lastOkAt ?? null,
          lastErrAt: s.lastErrAt ?? null,
          lastErrMsg: s.lastErrMsg ?? null,
          errCount: Number(s.errCount) || 0,
          fallbackUsedAt: s.fallbackUsedAt ?? null,
        };
      }
      sources = m;
    } catch (e) {
      if (e.code !== 'ENOENT')
        console.error(`[sourceHealth] 健康文件读取失败（按空处理）：${e.message}`);
      sources = null;
    }
  })();

  /** 落盘：串行写队列 + 唯一随机后缀 tmp；失败仅日志（测试注入 dataDir 指向文件可触发） */
  function save() {
    const snapshot = JSON.stringify({ schemaVersion: 1, sources }, null, 2);
    writeQueue = writeQueue.then(async () => {
      const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, filePath);
      } catch (e) {
        console.error(`[sourceHealth] 落盘失败（不影响业务）：${e.message}`);
      }
    });
    return writeQueue;
  }

  /**
   * @param {'push2'|'estimate'|'sina'|'lsjz'} key
   * @param {boolean} ok 本次请求是否成功
   * @param {Error} [err] 失败时的错误对象（成功时忽略）
   * @param {{ fallback?: boolean }} [meta] 本次成功走的是备源：lsjz→蛋卷、push2 指数→新浪（主源直接成功不传）
   */
  async function record(key, ok, err, meta = {}) {
    await ready;
    if (!SOURCE_KEYS.includes(key)) return;
    if (!sources) sources = blankSources();
    const s = sources[key];
    const now = nowIso(); // 单次调用只取一次：lastOkAt 与 fallbackUsedAt 恒同值
    if (ok) {
      s.lastOkAt = now;
      s.errCount = 0;
      s.fallbackUsedAt = meta.fallback ? now : null; // 主源直接成功 → 清除备源标记（各源通用）
    } else {
      s.lastErrAt = now;
      s.lastErrMsg = summarize(err);
      s.errCount += 1;
    }
    await save();
  }

  /** 供 GET /api/source-health：返回 { ts, sources }。
   *  ts = 最近一次记录时刻（各源 lastOkAt/lastErrAt 取最大）——无任何记录时为 null，前端显示"最后更新 —"。 */
  async function read() {
    await ready;
    const srcs = sources ?? blankSources();
    let latest = null;
    for (const k of SOURCE_KEYS) {
      for (const v of [srcs[k].lastOkAt, srcs[k].lastErrAt]) {
        if (v && (!latest || v > latest)) latest = v;
      }
    }
    return { ts: latest, sources: srcs };
  }

  return { record, read };
}
