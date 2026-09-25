/**
 * 策略持久态与触发快照存储。
 * data/strategy_state.json：服务端单写方（定时巡检/evaluate-now），前端仅/api/strategy/status读取；
 *   独立db.json，与前端乐观锁保存零交叉。
 * data/strategy_alerts.json：append-only只追加，触发事件全量留痕可回看。
 * 均原子写（tmp+rename）；文件缺失返回默认值，首启零迁移。
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 进程内异步互斥：strategy_state.json所有load/save统一排队，消除load→改→save竞态覆写。
 * 异常隔离：锁队列和业务Promise异常解耦（queue = next.catch(…)）
 * 单次I/O异常只返回当次调用方，队列永不reject，后续写入照常入队。
 */
export class AsyncMutex {
  constructor() {
    this.queue = Promise.resolve();
  }
  lock(fn) {
    const next = this.queue.then(() => fn());
    this.queue = next.catch(() => {});
    return next;
  }
}
export const stateFileMutex = new AsyncMutex();

/** 单基金持久态默认字段（缺省即"从未评估过"） */
export function fundStateDefaults() {
  return {
    consumedTiers: [],
    cooldowns: {},
    hwmDate: null,
    lastStopDate: null,
    lastAddNavDate: null,
    lastEvalNavDate: null,
    reserveUsed: 0,
    reserveBase: null,
    lastReserveCash: null, // reserveCash 改设检测（改设时重新快照 reserveBase）
    radarLevel: null, // 雷达上次级别（同级别冷却/升级判定的依据）
    ack: null, // 「已执行」标记 { state, navDate, ts }：驱动降级文案
    sellExec: null, // 卖出自动归因标记 { state, navDate }：事件后检测到卖出交易时落盘
    sellAttributionAsOf: null, // 卖出归因窗口锚（上次归因到的净值日，防同一笔卖出跨轮重复归因）
    posShares: null, // 仓位指纹（份额）：清仓归零标记（巡检写 0）+ 现金流摊薄检测
    posInvested: null, // 仓位指纹（本金）：与 posShares 配对
    reserveUsedAsOf: null, // 买入归因窗口锚（上次归因到的净值日）
    // ---- 状态机字段 ----
    trailingConsumedAtHwmDate: null, // HWM 周期锁（触发时的 hwmDate；新高自然失效）
    stopLossConsumedTiers: [], // 止损档位消耗集（吞并写入；ADD 破位闭锁依据）
    reboundedAfterStop: false, // 趋势终结反弹确认标记（stop1/stop2 落地置 false）
    lockedTroughDate: null, // 趋势终结谷底日（反弹确认瞬间固化；stop2 落地清空）
    resetTroughDate: null, // 筑底谷底日（随新低动态更新、立新锚清空）
    addRiskUsed: 0, // 增量损失预算已消耗（双写，非负钳制）
    lastExecutionPlan: null, // 信号态执行计划快照（ack 自闭环数据源；内存缓存＋事件路径持久化）
    releaseLog: [], // 释放凭证（append-only 并集；D4 分流：申购 {amount,dateRange} / 赎回 {shares,dateRange}）
    emittedFingerprints: [], // 事件指纹表（顶层指纹闸；防同指纹重复落盘）
    addConsumedTiers: [], // ADD 档消耗集（跳空吞并标记；出区清空）
    lastAddTier: null, // 上次加仓档位（跨档弹性步进 1.25% 判定）
    pendingRelease: [], // ack 赎回的 reserveUsed 待确认释放（T+N 交易日超时冲正）
  };
}

export function createStrategyStore({ dataDir }) {
  const statePath = join(dataDir, 'strategy_state.json');
  const alertsPath = join(dataDir, 'strategy_alerts.json');

  /** 裸读（调用方须已持锁）：文件缺失返回空库；含旧版迁移，TP归因留下的低位hwmDate。
   * 无周期锁，补 trailingConsumedAtHwmDate = hwmDate，阻止再次止盈，复权创出新高后重启止盈判定。 */
  async function rawLoad() {
    let raw;
    try {
      raw = JSON.parse(await readFile(statePath, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return { schemaVersion: 1, rev: 0, funds: {} };
      throw e;
    }
    const funds = raw.funds && typeof raw.funds === 'object' ? raw.funds : {};
    for (const entry of Object.values(funds)) {
      if (
        entry &&
        typeof entry === 'object' &&
        entry.sellExec?.state === 'TAKE_PROFIT' &&
        entry.hwmDate &&
        !('trailingConsumedAtHwmDate' in entry)
      ) {
        entry.trailingConsumedAtHwmDate = entry.hwmDate; // 迁移后可被阻止再次止盈，直到突破旧周期高点
      }
    }
    return {
      schemaVersion: raw.schemaVersion ?? 1,
      rev: Number.isFinite(raw.rev) ? raw.rev : 0,
      funds,
    };
  }

  /** 读持久态（经 stateFileMutex 排队）；文件缺失返回空库（funds 空 = 全部按默认评估） */
  function loadState() {
    return stateFileMutex.lock(rawLoad);
  }

  /**
   * 读改写事务入口：fn 收到免锁的 {load, save}，
   * 整段在同一把锁内完成"重读→先验后写→原子写"，不自嵌套加锁（不可重入死锁防护）。
   * @param {Function} fn 事务体
   */
  function withState(fn) {
    return stateFileMutex.lock(() => fn({ load: rawLoad, save: rawSave }));
  }

  /**
   * 双写字段差分合并器（字段级差分 + 乐观锁重试，不用磁盘胜整体覆盖）。
   * 只有磁盘侧相对开工快照baseline变更过的字段才并入引擎结果；冲突裁决：
   * 并发方重置档位清空最高优先；冷却锚点单调取较新；releaseLog并集append-only。
   * 语义仲裁：磁盘侧本轮发生过ack或ignore，引擎新产lastExecutionPlan作废不写。
   */
  const DOUBLE_WRITE_FIELDS = [
    'trailingConsumedAtHwmDate',
    'stopLossConsumedTiers',
    'reboundedAfterStop',
    'lockedTroughDate',
    'resetTroughDate',
    'addRiskUsed',
    'lastExecutionPlan',
    'reserveUsed',
    'reserveUsedAsOf',
    'consumedTiers',
    'ack',
    'ignore',
    'emittedFingerprints',
    'hwmDate',
    'lastStopDate',
    'lastAddNavDate',
  ];
  const same = (a, b) =>
    JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); // undefined≡null：缺键与默认空值不算"用户改过"
  function mergeFundEntry(engineEntry, diskEntry, baseEntry) {
    const out = { ...engineEntry };
    let userTouchedAckIgnore = false;
    for (const f of DOUBLE_WRITE_FIELDS) {
      if (same(diskEntry?.[f], baseEntry?.[f])) continue; // 磁盘侧未动 ⇒ 引擎本轮为准
      if (!same(diskEntry?.[f], engineEntry?.[f])) {
        if (f === 'releaseLog' || f === 'emittedFingerprints') {
          out[f] = [...new Set([...(engineEntry?.[f] ?? []), ...(diskEntry?.[f] ?? [])])]; // 并集（append-only）
        } else if (f === 'cooldowns') {
          const merged = { ...(engineEntry?.cooldowns ?? {}) };
          for (const [k, v] of Object.entries(diskEntry?.cooldowns ?? {})) {
            if ((baseEntry?.cooldowns ?? {})[k] !== v)
              merged[k] = String(merged[k] ?? '') > String(v) ? merged[k] : v; // 单调取新
          }
          out.cooldowns = merged;
        } else {
          out[f] = diskEntry?.[f]; // 并发方重置/写入 ⇒ 磁盘胜（含档位清空，合法清空不"复活"）
        }
        if (f === 'ack' || f === 'ignore') userTouchedAckIgnore = true;
      }
    }
    // cooldowns 单列（不在字段表内，按键差分）
    const outCooldowns = { ...(out.cooldowns ?? {}) };
    for (const [k, v] of Object.entries(diskEntry?.cooldowns ?? {})) {
      if ((baseEntry?.cooldowns ?? {})[k] !== v && !same(outCooldowns[k], v)) {
        outCooldowns[k] = String(outCooldowns[k] ?? '') > String(v) ? outCooldowns[k] : v;
      }
    }
    out.cooldowns = outCooldowns;
    // releaseLog 并集（字段表外单列——append-only 只增不清）
    if (
      Array.isArray(diskEntry?.releaseLog) &&
      !same(diskEntry.releaseLog, baseEntry?.releaseLog)
    ) {
      out.releaseLog = [...new Set([...(engineEntry?.releaseLog ?? []), ...diskEntry.releaseLog])];
    }
    // 语义仲裁：磁盘侧本轮 ack/ignore ⇒ 引擎本轮新计划作废（磁盘不并存"已忽略＋新鲜计划"）
    if (
      userTouchedAckIgnore &&
      !same(engineEntry?.lastExecutionPlan, diskEntry?.lastExecutionPlan)
    ) {
      out.lastExecutionPlan = diskEntry?.lastExecutionPlan ?? null;
    }
    return out;
  }

  /**
   * 原子写（裸写，调用方须已持锁）。opts.baseline = 开工快照 funds，传入即启用差分合并加乐观锁重试最多3次：
   * 写前重读磁盘，rev 已被并发推进，以 baseline 差分合并磁盘新值后重试；重试耗尽抛 conflict 告警。
   */
  async function rawSave(state, opts = {}) {
    await mkdir(dataDir, { recursive: true });
    const baseline = opts.baseline ?? null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let disk = null;
      try {
        disk = JSON.parse(await readFile(statePath, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const diskRev = Number.isFinite(disk?.rev) ? disk.rev : 0;
      const baseRev = Number.isFinite(opts.baseRev) ? opts.baseRev : diskRev;
      let funds = state.funds || {};
      if (baseline && disk && diskRev !== baseRev && disk.funds) {
        // 并发写已推进：字段级差分合并（引擎结果 ⊕ 磁盘侧用户变更）；清仓重置码不合并（引擎本轮为准）
        const skip = new Set(opts.skipMergeCodes || []);
        const merged = {};
        for (const code of new Set([...Object.keys(disk.funds), ...Object.keys(funds)])) {
          if (skip.has(code)) {
            merged[code] = funds[code] ?? JSON.parse(JSON.stringify(disk.funds[code]));
            continue;
          }
          merged[code] = funds[code]
            ? mergeFundEntry(funds[code], disk.funds[code] ?? {}, {
                ...fundStateDefaults(),
                ...(baseline[code] ?? {}),
              }) // 基线补默认形状：磁盘侧纯默认值（如 [] 档位）不算"用户改过"
            : JSON.parse(JSON.stringify(disk.funds[code])); // 引擎未处理的新条目整体带入
        }
        funds = merged;
      } else if (baseline && disk && disk.funds) {
        // rev 未变但保险起见并入引擎未覆盖的新条目（如并发新增基金）
        for (const code of Object.keys(disk.funds))
          if (!funds[code]) funds[code] = JSON.parse(JSON.stringify(disk.funds[code]));
      }
      const schemaVersion = state.schemaVersion ?? disk?.schemaVersion ?? 1;
      const out = { schemaVersion, rev: Math.max(diskRev, baseRev) + 1, funds };
      const tmp = `${statePath}.tmp`;
      await writeFile(tmp, JSON.stringify(out, null, 2));
      await rename(tmp, statePath);
      state.rev = out.rev; // 回填供调用方后续差分基准
      state.funds = funds; // 回填合并后结果：调用方（洗涤/读通道）须看到合并态而非引擎内存态
      return out.rev;
    }
    throw new Error('save_conflict: 乐观锁重试耗尽（3 次版本不符），本轮落盘跳过');
  }

  /** 原子写（经 stateFileMutex 排队） */
  function saveState(state, opts = {}) {
    return stateFileMutex.lock(() => rawSave(state, opts));
  }

  /** 取单基金持久态：缺失字段补默认（旧条目前向兼容） */
  function fundState(funds, code) {
    return { ...fundStateDefaults(), ...(funds[code] || {}) };
  }

  async function loadAlerts() {
    try {
      const raw = JSON.parse(await readFile(alertsPath, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** 只追加：返回追加后的总条数 */
  async function appendAlerts(entries) {
    const list = await loadAlerts();
    const next = list.concat(Array.isArray(entries) ? entries : [entries]);
    await mkdir(dataDir, { recursive: true });
    const tmp = `${alertsPath}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, alertsPath);
    return next.length;
  }

  return { loadState, saveState, withState, fundState, loadAlerts, appendAlerts };
}
