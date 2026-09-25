/**
 * 服务端数据库模块（data/db.json全文档存储）。
 * 原子写：先写.tmp再rename，进程崩溃不会残留半截文件。
 * 乐观锁：baseUpdatedAt和文件updated_at不匹配抛ConflictError，避免多窗口互相覆盖。
 * 每日备份：每日首次覆盖前旧文件保存为backups/db-YYYY-MM-DD.json，保留backupKeep份。
 */
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class ConflictError extends Error {
  constructor(serverUpdatedAt) {
    super('conflict: 服务端数据已被其他窗口修改');
    this.name = 'ConflictError';
    this.serverUpdatedAt = serverUpdatedAt;
  }
}

const localDateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 核心数值必须是有限数（NaN 会被 JSON.stringify 变 null，此处按 null 拒收）
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const isValidAsset = (a) =>
  a &&
  typeof a === 'object' &&
  a.id &&
  a.asset_type &&
  a.code &&
  a.snapshot &&
  typeof a.snapshot === 'object' &&
  finite(a.snapshot.hold_amount) &&
  finite(a.snapshot.cost_price) &&
  finite(a.snapshot.hold_shares) &&
  finite(a.snapshot.total_invested);

// AI 解读历史：{date: 'YYYY-MM-DD', text: 非空字符串}；同日只保留最后一条（按日期升序），最多 keepAiLog 条
const isValidAiEntry = (e) =>
  e &&
  typeof e === 'object' &&
  /^\d{4}-\d{2}-\d{2}$/.test(String(e.date ?? '')) &&
  typeof e.text === 'string' &&
  e.text.trim() !== '';

export function normalizeAiLog(v, keep = 90) {
  if (!Array.isArray(v)) return [];
  const byDate = new Map();
  for (const e of v) {
    if (isValidAiEntry(e)) byDate.set(e.date, { date: e.date, text: e.text.trim() });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-keep);
}

export function createDatabase({ dataDir, backupKeep = 30, now = () => new Date() }) {
  const dbPath = join(dataDir, 'db.json');
  const backupDir = join(dataDir, 'backups');

  /** 读原始文档；文件不存在返回 null；坏文件向上抛错（避免静默当空库覆盖真实数据） */
  async function readDb() {
    try {
      const raw = await readFile(dbPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  return {
    /** 读取全量数据；无文件时返回空库 */
    async load() {
      const doc = await readDb();
      if (!doc) {
        return {
          data: {
            version: 1,
            schemaVersion: 1,
            assets: [],
            daily: [],
            ai_log: [],
            corrections: [],
          },
          updated_at: null,
        };
      }
      return {
        data: {
          version: doc.version ?? 1,
          schemaVersion: doc.schemaVersion ?? 1, // 透传文档版本——迁移逻辑据此分派
          assets: Array.isArray(doc.assets) ? doc.assets : [],
          daily: Array.isArray(doc.daily) ? doc.daily : [],
          ai_log: normalizeAiLog(doc.ai_log),
          corrections: Array.isArray(doc.corrections) ? doc.corrections : [], // 本金修正留痕（口径 Ⅰ）
        },
        updated_at: doc.updated_at ?? null,
      };
    },

    /**
     * 全量保存：结构校验 → 乐观锁 → 每日备份 → 原子写。
     * 返回 { ok: true, updated_at }；数据非法抛 Error('invalid_assets…')；锁冲突抛 ConflictError。
     * aiLog/corrections 不传（如定时快照任务）时保留库中原值；传入则校验后整体替换。
     */
    async save(assets, baseUpdatedAt, daily, aiLog, corrections) {
      if (!Array.isArray(assets) || !assets.every(isValidAsset)) {
        throw new Error('invalid_assets: assets 必须为数组且每项含 id/asset_type/code/snapshot');
      }
      if (aiLog !== undefined && !Array.isArray(aiLog)) {
        throw new Error('invalid_ai_log: ai_log 必须为数组');
      }
      if (corrections !== undefined && !Array.isArray(corrections)) {
        throw new Error('invalid_corrections: corrections 必须为数组');
      }
      const old = await readDb();
      if (old && baseUpdatedAt !== (old.updated_at ?? null)) {
        throw new ConflictError(old.updated_at ?? null);
      }

      await mkdir(dataDir, { recursive: true });

      // 每日备份：当日还没备过才备（备份的是被覆盖前的旧文件）
      if (old) {
        const today = localDateStr(now());
        await mkdir(backupDir, { recursive: true });
        const existing = await readdir(backupDir).catch(() => []);
        if (!existing.includes(`db-${today}.json`)) {
          await writeFile(join(backupDir, `db-${today}.json`), JSON.stringify(old, null, 2));
          // 清理超出保留数量的最老备份（文件名即日期，可直接排序）
          const kept = existing.concat(`db-${today}.json`).sort().slice(-backupKeep);
          for (const f of existing) {
            if (!kept.includes(f)) await unlink(join(backupDir, f)).catch(() => {});
          }
        }
      }

      const updatedAt = now().toISOString();
      // corrections 为追加型审计留痕（口径 Ⅰ，"历史不动、修正留痕"）：与库中现有记录取并集。
      // 防的是真实存在的覆盖路径——某页面在留痕写入前已加载（内存 corrections=[]），其下一次整体保存
      // 会把留痕抹掉（daily 无此保护是因为它可按日期重算；修正记录不可重算）。
      const storedCorrections = Array.isArray(old?.corrections) ? old.corrections : [];
      const incomingCorrections = corrections !== undefined ? corrections : storedCorrections;
      const mergedCorrections = [];
      const seenCorrections = new Set();
      for (const c of [...storedCorrections, ...incomingCorrections]) {
        const k = JSON.stringify(
          Object.keys(c || {})
            .sort()
            .map((key) => [key, c[key]]),
        ); // 键序无关去重
        if (seenCorrections.has(k)) continue;
        seenCorrections.add(k);
        mergedCorrections.push(c);
      }
      const out = {
        version: old?.version ?? 1,
        schemaVersion: old?.schemaVersion ?? 1, // 版本只继承不自增：硬编码 1 会让未来迁移被前端保存静默降级；升版仅归服务端迁移代码
        assets,
        daily: Array.isArray(daily) ? daily : Array.isArray(old?.daily) ? old.daily : [],
        ai_log:
          aiLog !== undefined
            ? normalizeAiLog(aiLog)
            : Array.isArray(old?.ai_log)
              ? old.ai_log
              : [],
        corrections: mergedCorrections,
        updated_at: updatedAt,
      };
      const tmpPath = `${dbPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(out, null, 2));
      await rename(tmpPath, dbPath);
      return { ok: true, updated_at: updatedAt };
    },
  };
}
