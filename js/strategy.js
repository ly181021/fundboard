/**
 * 止盈止损策略引擎（浏览器/服务端同构纯函数）。
 * 主入口：evaluateExitStrategy(asset, quotesHistory, config, ctx)。
 * 口径：只用确认净值；价格回撤按复权净值计算（窗口内局部前复权）；市值 = 份额 × 最后确认净值。
 * 七态输出：持有（HOLD）、关注（WATCH）、警戒（ALERT）、止盈（TAKE_PROFIT）、
 *  止损（STOP_LOSS）、补仓（ADD）、清空（EXIT），多信号同时命中时按分层优先级仲裁。
 * 连跌雷达只写入 radar 字段做预警角标，不改变主状态。
 * 冷却只闸事件（event=false 不落预警日志），徽章状态永远实时；清空可穿透冷却。
 * ctx.state 为 strategy_state.json 持久条目。
 * asset.txBuys 为纯买入交易流 [{date, amount>0}]，是预留资金已用（reserveUsed）的归因数据源，
 * 不含基线本金流与期末市值。
 */
import { computeXIRR } from './calculator.js';
import { parseISODate } from './analysis.js';
import { riskMetrics, tierHoldDays } from './riskMetrics.js';

const round2 = (v) => Math.round(v * 100) / 100;

/** 雷达同级别冷却窗口，固定 5 个净值日。
 *  与动作冷却（actionCooldownDays）解耦：自定义动作冷却不改变雷达口径。 */
const RADAR_COOLDOWN_DAYS = 5;

export const DEFAULT_STRATEGY_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  riskClass: 'balanced',
  addEnabled: false,
  reserveCash: null,
  reserveCap: 0.5,
  minRetainShares: 10,
  trailing: { startProfit: 0.08, drawdownThreshold: 0.05 },
  safetyPad: { estFee: 0.005, minMargin: 0.01 },
  xirrLadder: {
    tiers: [
      { threshold: 0.15, sellRatio: 1 / 3 },
      { threshold: 0.2, sellRatio: 0.5 },
    ],
    minHoldDays: 90,
    resetLine: 0.1,
    profitGate: false,
  },
  costBands: {
    balanced: {
      addTop: -0.05,
      addStep: 0.025,
      addBottom: -0.1,
      stop1: -0.15,
      stop2: -0.2,
      exitFloor: -0.3,
    },
    stable: { stop1: -0.03, stop2: -0.05, exitFloor: -0.1, noAdd: true },
  },
  /* 状态机参数：深回撤失效 25%、立起峰值所需反弹 8%、反弹确认阈值 4.5%、
   * 破位缓冲 2%、单边下跌兜底 5%，全部可配置 */
  hwm: { deepResetDrawdown: 0.25, reboundFromTrough: 0.08 },
  trendEnd: { reboundConfirm: 0.045, breakBuffer: 0.02, waterfallDrop: 0.05 },
  radar: { stable: [0.02, 0.04], balanced: [0.05, 0.1], sector: [0.08, 0.15], peak60: 0.08 },
  actionCooldownDays: 5,
  /* 增量损失预算率：新增资金在首档止损时的累计新增损失不超过启用时本金的 3%；附渠道起购线 */
  addRiskBudgetRate: 0.03,
  minPurchaseAmount: 100,
  /* 份额元数据（保守缺省，基金级元数据接入后覆盖） */
  minRedeemShares: 0.01,
  minHoldingShares: null, // 缺省回落 minRetainShares（10 份）
  sharePrecision: 2,
};

/** 配置浅合并（段级覆盖），并校验安全垫不变量。
 *  配置保存与引擎评估双重校验，违反即拒绝。 */
function mergeConfig(config) {
  const d = DEFAULT_STRATEGY_CONFIG;
  const c = { ...d, ...(config || {}) };
  c.trailing = { ...d.trailing, ...(config?.trailing || {}) };
  c.safetyPad = { ...d.safetyPad, ...(config?.safetyPad || {}) };
  c.xirrLadder = { ...d.xirrLadder, ...(config?.xirrLadder || {}) };
  c.costBands = { ...d.costBands, ...(config?.costBands || {}) };
  c.radar = { ...d.radar, ...(config?.radar || {}) };
  c.hwm = { ...d.hwm, ...(config?.hwm || {}) };
  c.trendEnd = { ...d.trendEnd, ...(config?.trendEnd || {}) };
  const triggerPrice = (1 + c.trailing.startProfit) * (1 - c.trailing.drawdownThreshold);
  const floor = 1 + c.safetyPad.estFee + c.safetyPad.minMargin;
  if (triggerPrice < floor) {
    throw new Error(
      `安全垫不变量违反：(1+${c.trailing.startProfit})×(1−${c.trailing.drawdownThreshold}) = ${triggerPrice.toFixed(4)} < ${floor.toFixed(4)}，"名为止盈实为亏损"的参数组合不允许存在`,
    );
  }
  return c;
}

/** 净值序列预处理：按日期去重（保留最后一条）、升序、局部前复权、分红检测 */
export function prepareHistory(history) {
  const byDate = new Map();
  for (const r of history || []) {
    if (!r || !r.date || !Number.isFinite(Number(r.nav))) continue;
    byDate.set(r.date, {
      date: r.date,
      nav: Number(r.nav),
      acc: r.acc_nav == null ? null : Number(r.acc_nav),
    });
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const adj = series.map((r) => ({ date: r.date, adj: r.nav }));
  const dividends = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1],
      cur = series[i];
    if (prev.acc == null || cur.acc == null) continue; // 缺 LJJZ 的段无法检测分红
    const jump = cur.acc - cur.nav - (prev.acc - prev.nav);
    if (jump >= 0.001) {
      dividends.push({ date: cur.date, perShare: Math.round(jump * 1e6) / 1e6 });
      const factor = (prev.nav - jump) / prev.nav; // 前复权：除息日之前的净值按除息因子折算
      for (let j = 0; j < i; j++) adj[j].adj *= factor;
    }
  }
  return { series, adj, dividends };
}

const peakOf = (adj, fromIdx, toIdx) => {
  let m = -Infinity;
  for (let i = Math.max(0, fromIdx); i <= toIdx; i++) if (adj[i].adj > m) m = adj[i].adj;
  return m;
};

/** 冷却判定：eventDate（净值日）距序列末尾不足 cooldownDays 个净值日即冷却中；
 *  日期不在序列内视为已过期，不拦截。 */
function inCooldown(eventDate, series, lastIdx, cooldownDays) {
  if (!eventDate) return false;
  const idx = series.findIndex((r) => r.date === eventDate);
  if (idx < 0) return false;
  return lastIdx - idx < cooldownDays;
}

/**
 * 事件标识（fingerprint）：{state}_{tier}_{navDate} 复合键。
 * 同一天、同一状态、同一档位视为同一条告警；同日跳空多档各算一条标识，互不混淆。
 * @param {string} state 状态
 * @param {number|null} tier 命中档位（止损档或止盈档值，如 15/20）
 * @param {string} navDate 净值日
 * @returns {string} 事件标识串
 */
export function buildFingerprint(state, tier, navDate) {
  return `${state}_${tier ?? '-'}_${navDate}`;
}

/**
 * 生成场外执行计划：下单截止与成交归属日均以生成时刻 now 推导。
 * 日历经 ctx 注入（复用 js/tradingCalendar.js）；缺省退化为工作日判定，
 * 并标记 calendarEstimated（降级可识别）。
 * @param {object} win 命中的建议信号
 * @param {object} cfg 合并后的策略配置
 * @param {object} ctx { now, isTradingDay?, nextTradingDay? }
 * @returns {object} 执行计划，含 orderDeadline、orderExpired、expectedExecutionNavDate、
 *   priceKnown、safetyPad、calendarEstimated 六字段。
 */
function buildExecutionPlan(win, cfg, ctx) {
  const p2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const now = (ctx.now || (() => new Date()))();
  const isTradingDay =
    ctx.isTradingDay ||
    ((d) => {
      const w = new Date(`${d}T00:00:00`).getDay();
      return w >= 1 && w <= 5;
    });
  let calendarEstimated = false;
  const nextTradingDay =
    ctx.nextTradingDay ||
    ((d) => {
      let dt = new Date(`${d}T00:00:00`);
      do {
        dt = new Date(dt.getTime() + 86400000);
      } while (![1, 2, 3, 4, 5].includes(dt.getDay()));
      calendarEstimated = true; // 无日历注入，退化为工作日判定
      return fmtDate(dt);
    });
  const today = fmtDate(now);
  const beforeCutoff = isTradingDay(today) && now.getHours() * 60 + now.getMinutes() < 15 * 60;
  const execDate = beforeCutoff ? today : nextTradingDay(today); // 成交归属日：盘中生成取当日，盘后生成取下一交易日
  const deadlineDate = beforeCutoff ? today : execDate;
  const deadline = `${deadlineDate}T15:00`;
  const orderExpired = new Date(`${deadline}:00`).getTime() < now.getTime(); // 极端滞后时标记订单已过期，不再按过期建议触发操作
  const triggerPrice = (1 + cfg.trailing.startProfit) * (1 - cfg.trailing.drawdownThreshold);
  return {
    orderDeadline: deadline,
    orderExpired,
    expectedExecutionNavDate: execDate,
    priceKnown: false, // 成交价未知（T+1 净值在提交时点尚未可知），恒为 false
    estimatedFeeRate: null, // 预估费率按将卖份额覆盖批次加权（feeFIFO），批次数据在任务层，此处留空
    safetyPad:
      win?.trigger === 'trailing' ? { triggerPrice, lockedProfit: triggerPrice - 1 } : null, // 移动止盈建议必产安全垫
    calendarEstimated,
  };
}

/**
 * 事件闸（预警去重与防漏报）：判定本次信号是否落盘为事件。
 * 判定顺序：事件标识去重、危险告警放行、档位与周期锁、已执行回执、冷却。
 * 危险放行名单（清空、全额赎回、止损越级、止盈跳档）只豁免冷却压制，
 * 不豁免同一事件标识的重复落盘。
 * @param {object} a
 * @param {string} a.state 状态
 * @param {boolean} a.fullRedemption 升级全额赎回（与清空同享放行）
 * @param {string|null} a.existingCooldown 该状态已有冷却锚（净值日）
 * @param {number|null} a.currentTier 本次命中档位（止损档或止盈档值，如 15/20）
 * @param {number[]} a.stopLossConsumedTiers 止损档位记录（独立于止盈的 consumedTiers）
 * @param {number[]} a.consumedTiers 已消耗止盈档位（跳档判定用）
 * @param {string} a.fingerprint 事件标识（buildFingerprint）
 * @param {Set<string>} a.emittedFingerprints 已落盘事件标识表
 * @param {{active:boolean, state:string}|null} a.executedInfo 已执行回执锁定标记（ack/归因）
 * @param {boolean} a.inCooldownFlag 现有冷却锚是否处于冷却窗口内（调用方以 inCooldown 预算）
 */
export function shouldSuppressEvent({
  state,
  fullRedemption = false,
  existingCooldown = null,
  currentTier = null,
  stopLossConsumedTiers = [],
  consumedTiers = [],
  fingerprint,
  emittedFingerprints = new Set(),
  executedInfo = null,
  inCooldownFlag = false,
  tierLocked = false,
  periodLocked = false,
}) {
  if (fingerprint && emittedFingerprints.has(fingerprint)) return true; // 事件标识去重（任何状态都不豁免）
  const maxSL = stopLossConsumedTiers.length ? Math.max(...stopLossConsumedTiers) : 0;
  const maxTier = consumedTiers.length ? Math.max(...consumedTiers) : 0;
  const penetrate =
    state === 'EXIT' ||
    fullRedemption === true ||
    (state === 'STOP_LOSS' && currentTier != null && currentTier > maxSL) ||
    (state === 'TAKE_PROFIT' && currentTier != null && currentTier > maxTier);
  if (penetrate) return false; // 放行判定前置于已执行回执，越级不漏报
  if (tierLocked || periodLocked) return true; // 档位与周期锁：同档或同一峰值周期不因冷却流逝重复触发
  if (executedInfo?.active && executedInfo.state === state) return true; // 已执行回执锁定期内同一状态不再提醒
  return inCooldownFlag; // 冷却期内不再提醒
}

export function evaluateExitStrategy(asset, quotesHistory, config = {}, ctx = {}) {
  const cfg = mergeConfig(config);
  let state = ctx.state || {};
  // 清仓后重建仓的兜底：上次评估标记持仓为零（posShares=0）而本次已有持仓时，进度整体清零。
  // 旧止损链、旧峰值、已消耗档位不跨仓位存活，防止向重建仓误发清空或止盈建议。
  if (state.posShares === 0) state = { lastEvalNavDate: state.lastEvalNavDate ?? null };
  const cooldowns = state.cooldowns || {};
  const nextState = { ...state, cooldowns: { ...cooldowns } };
  const { series, adj, dividends } = prepareHistory(quotesHistory);
  const lastIdx = series.length - 1;
  const navDate = asset.navDate || (lastIdx >= 0 ? series[lastIdx].date : null);
  const adjNav = lastIdx >= 0 ? adj[lastIdx].adj : null;
  const idxOf = (date) => series.findIndex((r) => r.date === date);
  const marketValue = asset.shares * asset.nav;
  const profitRate = (marketValue - asset.invested) / asset.invested; // 账面收益率（R_book，仅展示）
  // 经济收益率（R_econ）：分子含分红池与在途分红补偿；
  // 成本分档、止损判定、档位最低实际收益率门统一用这个口径。
  // 过渡兜底：调用方未传 dPool 时退回 cashDividend（无赎回场景两者等值；任务层已全量传池）。
  const dPoolAmt = asset.dPool != null ? asset.dPool : asset.cashDividend || 0;
  const rm = riskMetrics({
    mv: marketValue,
    cost: asset.invested,
    dPool: dPoolAmt,
    pendingTotal: asset.pendingTotal ?? 0,
    feeAmount: 0,
    ratio: 1,
  });
  const lossRate = rm.rEcon;
  const bands = cfg.costBands[cfg.riskClass] || cfg.costBands.balanced;
  let drawdown = null;
  let xirr = null;
  let truncated = false;
  const radar = {
    level: null,
    trigger: null,
    d5Drop: null,
    d20Drop: null,
    peak60Drawdown: null,
    active: false,
    suppressed: false,
  };
  const empty = {
    state: 'HOLD',
    ratio: null,
    radar,
    drawdown: null,
    profitRate: null,
    lossRate: null,
    xirr: null,
    progress: null,
    executed: false,
    executedInfo: null,
    ignored: false,
    snapshot: { ...snapshotBase(asset, navDate), radar },
    nextState,
    event: false,
    truncated: false,
  };
  const xirrFn = ctx.xirrFn || computeXIRR;

  // 安全垫不变量：默认配置不得退化（与配置保存处同一校验）
  const triggerPrice = (1 + cfg.trailing.startProfit) * (1 - cfg.trailing.drawdownThreshold);
  const padFloor = 1 + cfg.safetyPad.estFee + cfg.safetyPad.minMargin;
  if (triggerPrice < padFloor) {
    throw new Error(
      `安全垫不变量违反：触发价 ${triggerPrice.toFixed(4)} < ${padFloor.toFixed(4)}（estFee ${cfg.safetyPad.estFee} + minMargin ${cfg.safetyPad.minMargin}），"名为止盈实为亏损"的参数组合不允许存在`,
    );
  }

  // 无持仓、引擎停用或无净值序列时休眠（无持仓基金不监控）
  if (
    !cfg.enabled ||
    series.length === 0 ||
    !(asset.shares > 0) ||
    !(asset.invested > 0) ||
    adjNav == null
  ) {
    if (navDate) nextState.lastEvalNavDate = navDate; // 休眠基金也推进上次评估净值日（评估去重基准），防巡检每轮空转重评
    return empty;
  }

  // ---- 预留资金基准（reserveBase）快照：上限基准取启用加仓或改设预留资金时的本金，不用动态本金 ----
  if (
    cfg.addEnabled &&
    cfg.reserveCash != null &&
    (state.reserveBase == null || state.lastReserveCash !== cfg.reserveCash)
  ) {
    nextState.reserveBase = asset.invested;
    nextState.lastReserveCash = cfg.reserveCash;
  }

  // ---- 买入自动归因：补仓建议日之后的买入交易金额累入预留资金已用（reserveUsed，封顶），
  // 预算上限跨周期生效 ----
  // 数据源为 asset.txBuys（纯买入交易，由调用方合成）。不能用 flows：buildFundFlows 合成的 flows
  // 含基线本金流（创建日的 -total_invested）与期末市值，新导入基金的基线会落进归因窗口，把预算无声吃光。
  // 归因窗口为（上次对账截止日, 本次净值日]；对账截止日在加仓停用期间也推进，
  // 停用期的自主买入不追溯计入。从未给过补仓建议且无锚时不归因；
  // 补录到已评估净值日之前的买入会漏计，留待手动纠偏入口。
  nextState.reserveUsedAsOf = navDate;
  if (cfg.addEnabled && cfg.reserveCash != null) {
    const anchor = state.reserveUsedAsOf ?? state.lastAddNavDate ?? null;
    if (anchor != null && asset.txBuys) {
      const buys = asset.txBuys
        .filter((f) => f.date > anchor && f.date <= navDate)
        .reduce((s, f) => s + f.amount, 0);
      if (buys > 0) {
        const cap = Math.min(
          cfg.reserveCash,
          (nextState.reserveBase ?? asset.invested) * cfg.reserveCap,
        );
        nextState.reserveUsed = round2(Math.min((state.reserveUsed || 0) + buys, cap));
      }
    }
  }

  // ---- 连跌雷达（只写入 radar 字段做预警角标，不改变主状态）----
  const radarPresets = cfg.radar[cfg.riskClass] || cfg.radar.balanced;
  const dropOver = (k) =>
    lastIdx >= k ? (adj[lastIdx - k].adj - adjNav) / adj[lastIdx - k].adj : null;
  radar.d5Drop = dropOver(5);
  radar.d20Drop = dropOver(20);
  const win60 = adj.slice(Math.max(0, lastIdx - 60), lastIdx + 1);
  const peak60 = Math.max(...win60.map((x) => x.adj));
  radar.peak60Drawdown = (peak60 - adjNav) / peak60;
  {
    // 连续下跌天数：自序列末向前数复权净值连降的净值日数；d5 触发时供角标「连跌 N 日」文案
    let dd = 0;
    for (let i = lastIdx; i > 0 && adj[i].adj < adj[i - 1].adj; i--) dd++;
    radar.downDays = dd;
  }
  if (radar.d20Drop != null && radar.d20Drop >= radarPresets[1]) {
    radar.level = 'orange';
    radar.trigger = 'd20';
  } else if (radar.peak60Drawdown >= cfg.radar.peak60) {
    radar.level = 'orange';
    radar.trigger = 'peak60';
  } else if (radar.d5Drop != null && radar.d5Drop >= radarPresets[0]) {
    radar.level = 'yellow';
    radar.trigger = 'd5';
  }
  if (radar.level) {
    // 级别升级（黄升橙）不受冷却限制；同级别 5 个净值日内不重复提示。
    // 上次级别持久化于 radarLevel，未存级别按同级别保守处理。
    const upgraded = radar.level === 'orange' && state.radarLevel === 'yellow';
    const cooled = inCooldown(cooldowns.RADAR, series, lastIdx, RADAR_COOLDOWN_DAYS);
    radar.active = upgraded || !cooled;
    radar.suppressed = !radar.active;
    if (radar.active) {
      nextState.cooldowns.RADAR = navDate;
      nextState.radarLevel = radar.level;
    }
  }

  // ---- 移动止盈（HWM 生命周期：峰值基准只升不降、周期止盈标记、深回撤失效进筑底观察期、
  // 新锚取确认日收盘复权净值）----
  // 零轴门：经济收益率（R_econ）不大于 0 时不触发止盈，交成本分档接管。
  // 申购、部分赎回、分红一律不改变峰值基准日（交易事件不清峰）。
  let tpSignal = null;
  if (!state.hwmDate) {
    // 无峰值期（首锚，或深回撤失效后的筑底观察期）：重新立起峰值须同时满足两个条件，
    // 一是收益率达移动止盈启动点（startProfit），二是自谷底反弹幅度达 8%（reboundFromTrough）。
    // 新峰值以确认当日收盘复权净值为基准，仅使用确认日当天及之后的数据，不追溯历史高点。
    if (lossRate >= cfg.trailing.startProfit) {
      let anchorOk = true;
      if (state.resetTroughDate) {
        const tIdx = idxOf(state.resetTroughDate);
        if (tIdx >= 0) {
          const troughAdj = adj[tIdx].adj;
          anchorOk = (adjNav - troughAdj) / troughAdj >= (cfg.hwm.reboundFromTrough ?? 0.08);
        }
      }
      if (anchorOk) {
        nextState.hwmDate = navDate;
        nextState.resetTroughDate = null; // 立起峰值时清空筑底观察期谷底日
        drawdown = 0; // 立起峰值当日的回撤为 0
      }
    }
    // 筑底观察期谷底动态更新：净值创新低时，resetTroughDate 随新低下移
    if (!nextState.hwmDate && state.resetTroughDate) {
      const tIdx = idxOf(state.resetTroughDate);
      if (tIdx >= 0 && adjNav < adj[tIdx].adj) nextState.resetTroughDate = navDate;
    }
  } else {
    const hwmIdx = idxOf(state.hwmDate);
    let hwm;
    if (hwmIdx < 0) {
      truncated = true;
      hwm = peakOf(adj, 0, lastIdx);
    } // 峰值基准日超出净值窗口（取数不足）：取可得窗口峰值降级
    else hwm = peakOf(adj, hwmIdx, lastIdx);
    drawdown = (hwm - adjNav) / hwm;
    if (drawdown > (cfg.hwm.deepResetDrawdown ?? 0.25)) {
      // 深回撤失效（默认 25%）：旧峰值置空，进入筑底观察期；
      // 无峰值期间不计算回撤、不触发止盈（UI 不显仪表）。
      // 失效日常在下坠途中，谷底日（resetTroughDate）先记当日，随新低动态下移。
      nextState.hwmDate = null;
      nextState.trailingConsumedAtHwmDate = null;
      const prevTroughIdx = state.resetTroughDate ? idxOf(state.resetTroughDate) : -1;
      nextState.resetTroughDate =
        prevTroughIdx >= 0 && adj[prevTroughIdx].adj <= adjNav ? state.resetTroughDate : navDate;
      drawdown = null; // 无峰值期间回撤不可判（UI 不显仪表）
    } else if (drawdown >= cfg.trailing.drawdownThreshold && lossRate > 0) {
      // 回撤达阈值即出信号（徽章照常实时）；周期止盈标记在事件闸层压制重复事件
      tpSignal = {
        ratio: 0.5,
        tier: null,
        reason: `自 ${state.hwmDate} 峰值回撤 ${(drawdown * 100).toFixed(1)}%，触发移动止盈，建议赎回 1/2`,
      };
    } else if (adjNav >= hwm) {
      nextState.hwmDate = navDate; // 复权净值创新高时峰值基准日上移（周期止盈标记自然失效）
      if ((state.addRiskUsed ?? 0) > 0) nextState.addRiskUsed = 0; // 峰值创新高释放：只释放增量损失预算（addRiskUsed）
    }
  }

  // ---- XIRR 阶梯止盈（档位复位滞回 15 日窗 + 档位最低实际收益率门 + 持有天数按档独立试算）----
  let xirrSignal = null;
  // 被覆盖档：阈值不高于命中档的全部台阶一并标记为已消耗，按配置台阶本身取数
  // （自定义非 5 倍数阈值如 15.5/18 也能正确入列）。
  const coveredTiersOf = (tierNo) =>
    cfg.xirrLadder.tiers
      .filter((t) => Math.round(t.threshold * 100) <= tierNo)
      .map((t) => Math.round(t.threshold * 100));
  const consumed = state.consumedTiers || [];
  // 档位复位（滞回）：判定指标为静态标量经济收益率，不逐日解 XIRR 方程（防算力雪崩）。
  // 最近 15 个净值日（rearmWindow）内至少 10 个净值日（rearmConfirmDays）经济收益率低于
  // 复位线 5%（rearmLine）时，清空已消耗档位（consumedTiers）。
  // 窗口内单日回升不清零（抗窄幅振荡）；数据不足窗口长度时按可得天数计。
  const xirrRearmLine = cfg.xirrLadder.rearmLine ?? 0.05;
  const rearmWin = cfg.xirrLadder.rearmWindow ?? 15;
  const rearmNeed = cfg.xirrLadder.rearmConfirmDays ?? 10;
  if (consumed.length && lastIdx >= 0) {
    const rEconAt = (i) =>
      (asset.shares * series[i].nav + dPoolAmt - asset.invested) / asset.invested;
    let below = 0;
    for (let i = Math.max(0, lastIdx - rearmWin + 1); i <= lastIdx; i++)
      if (rEconAt(i) < xirrRearmLine) below++;
    if (below >= rearmNeed) nextState.consumedTiers = []; // 窗口计数达标，已消耗档位复位
  }
  if (asset.flows && asset.flows.length >= 2) {
    // 持有天数口径：按候选档目标赎回比例（targetRatio）的 FIFO 拟赎回批次加权，
    // 各档独立试算（补仓新批次不稀释老仓位的止盈机会）；无批次数据时退回全龄口径兜底。
    const lots = Array.isArray(asset.lots) ? asset.lots : [];
    const holdDaysOf = (ratio) =>
      lots.length
        ? tierHoldDays(lots, ratio, navDate)
        : Math.round(
            (parseISODate(navDate) -
              parseISODate(
                asset.flows.reduce(
                  (m, f) => (f.date && f.date < m ? f.date : m),
                  asset.flows[0].date,
                ),
              )) /
              86400000,
          );
    // 档位最低实际收益率门：卖出收益率（R_exec）不低于 tier.minAbsoluteProfitRate
    // （第一档 6%、第二档 10%），即扣预估赎回费后的动作边际收益。
    const feeRate = asset.execFeeRate ?? cfg.safetyPad.estFee ?? 0.005;
    const rExecXirr = rm.rEcon - (feeRate * marketValue) / asset.invested; // 动作边际（比例缩放时分子分母抵消）
    if (cfg.xirrLadder.profitGate && profitRate <= 0) {
      // profitGate 闸门：账面亏损时跳过 XIRR 止盈（先卖后买的极端现金流防护）
    } else {
      xirr = xirrFn(asset.flows); // 按现金流口径计算年化（赎回视作现金流入，不用「收益÷残余份额」静态回算）
      if (xirr != null && Number.isFinite(xirr)) {
        let hit = null;
        for (const t of [...cfg.xirrLadder.tiers].sort((a, b) => a.threshold - b.threshold)) {
          const tierNo = Math.round(t.threshold * 100);
          const minAbs = t.minAbsoluteProfitRate ?? (tierNo >= 20 ? 0.1 : 0.06);
          if (
            xirr >= t.threshold &&
            !consumed.includes(tierNo) &&
            holdDaysOf(t.sellRatio) >= cfg.xirrLadder.minHoldDays &&
            rExecXirr >= minAbs
          )
            hit = { ...t, tierNo }; // 持有期与最低实际收益率双门逐档验证
        }
        if (hit)
          xirrSignal = {
            ratio: hit.sellRatio,
            tier: hit.tierNo,
            reason: `年化 ${(xirr * 100).toFixed(1)}% 触及 XIRR 台阶 ${Math.round(hit.threshold * 100)}%（加权持有达标、净收益 ≥ ${Math.round((hit.minAbsoluteProfitRate ?? (hit.tierNo >= 20 ? 0.1 : 0.06)) * 100)}%），建议赎回 ${hit.sellRatio > 0.4 ? '剩余的 1/2' : '1/3'}`,
          };
      }
    }
  }

  // ---- 成本分档止损与趋势终结（止损档位记录 + 复位 + 破位期间禁止补仓 + 趋势终结四条件 + 单边下跌兜底）----
  let exitSignal = null;
  let stopSignal = null;
  // 档位值参数化（随 costBands：平衡型 15/20、稳健型 3/5）
  const stop1Tier = Math.round(Math.abs(bands.stop1) * 100);
  const stop2Tier = Math.round(Math.abs(bands.stop2) * 100);
  let slConsumed = Array.isArray(state.stopLossConsumedTiers)
    ? [...state.stopLossConsumedTiers]
    : [];
  // 止损复位（重新启用）：经济收益率回升到重新启用线（addTop，稳健型取 stop1）以上，
  // 且连续 3 个净值日站稳时，原子清空止损档位记录。
  const rearmLine = bands.addTop ?? bands.stop1;
  if (slConsumed.length && lossRate > rearmLine) {
    const rEconAt = (i) =>
      (asset.shares * series[i].nav + dPoolAmt - asset.invested) / asset.invested;
    const last3 = [lastIdx - 2, lastIdx - 1, lastIdx].filter((i) => i >= 0);
    if (last3.length === 3 && last3.every((i) => rEconAt(i) > rearmLine)) {
      slConsumed = [];
      nextState.stopLossConsumedTiers = [];
      nextState.reboundedAfterStop = false; // 原子复位（配套标记一并清空，跨周期不泄漏）
      nextState.lockedTroughDate = null;
      if ((state.addRiskUsed ?? 0) > 0) nextState.addRiskUsed = 0; // 复位达成只释放增量损失预算（addRiskUsed）
    }
  }
  // 反弹确认与谷底日锁定：自最近止损日后的最低点反弹达阈值（默认 4.5%）时，
  // 反弹确认标记置为已触发，并锁定该谷底日。
  if ((slConsumed.length || state.lastStopDate) && state.reboundedAfterStop !== true) {
    const fromIdx = state.lastStopDate ? Math.max(0, idxOf(state.lastStopDate)) : 0;
    let troughIdx = null;
    for (let i = fromIdx; i <= lastIdx; i++)
      if (troughIdx == null || adj[i].adj < adj[troughIdx].adj) troughIdx = i;
    if (troughIdx != null && troughIdx < lastIdx) {
      const rebound = (adjNav - adj[troughIdx].adj) / adj[troughIdx].adj;
      if (rebound >= (cfg.trendEnd.reboundConfirm ?? 0.045)) {
        nextState.reboundedAfterStop = true;
        if (!state.lockedTroughDate) nextState.lockedTroughDate = series[troughIdx].date; // 确认瞬间锁定谷底日
      }
    }
  }
  // 趋势终结（四条件需同时满足 + 单边下跌兜底）
  {
    const lockedIdx = state.lockedTroughDate ? idxOf(state.lockedTroughDate) : -1;
    const lockAdj = lockedIdx >= 0 ? adj[lockedIdx].adj : null;
    const eligible =
      slConsumed.includes(stop2Tier) &&
      lossRate <= bands.stop2 &&
      state.reboundedAfterStop === true &&
      lockAdj != null &&
      adjNav < lockAdj * (1 - (cfg.trendEnd.breakBuffer ?? 0.02)); // 第四条件唯一准则：跌破锁定谷底日净值的 98%（量纲同为当期复权序列）
    const waterfall =
      lossRate <= bands.stop2 - (cfg.trendEnd.waterfallDrop ?? 0.05) &&
      state.reboundedAfterStop !== true; // 无反弹的单边阴跌使四条件永假，此为强制放行兜底
    if (eligible || waterfall) {
      exitSignal = {
        cond: 'trendEnd',
        reason: eligible
          ? '止损后反弹确认、再度跌破固化谷底 2%，趋势终结，建议清空剩余份额'
          : `亏损 ${(lossRate * 100).toFixed(1)}% 已跌破二档线再 5% 且无反弹（单边下坠兜底），建议清仓`,
      };
    }
  }
  if (!exitSignal && lossRate <= bands.exitFloor) {
    exitSignal = {
      cond: 'exitFloor',
      reason: `亏损率 ${(lossRate * 100).toFixed(1)}% 触及绝对兜底线 ${bands.exitFloor * 100}%`,
    };
  }
  // 止损档位触发：信号照常出（徽章实时）；止损档位记录在事件闸层压制重复事件（震荡市不重复切仓）
  const hitTier = lossRate <= bands.stop2 ? stop2Tier : lossRate <= bands.stop1 ? stop1Tier : null;
  if (hitTier != null) {
    stopSignal =
      hitTier === stop2Tier
        ? {
            ratio: 0.5,
            tier: stop2Tier,
            reason: `亏损率 ${(lossRate * 100).toFixed(1)}% 触及二档止损线 ${bands.stop2 * 100}%，建议再赎 1/2`,
          }
        : {
            ratio: 1 / 3,
            tier: stop1Tier,
            reason: `亏损率 ${(lossRate * 100).toFixed(1)}% 触及首档止损线 ${bands.stop1 * 100}%，建议赎回 1/3`,
          };
  }

  // ---- 加仓评估区（两档网格 + 增量损失预算 + 距止损过近切断 + 预算分母底线 + 起购线阻断 + 弹性步进 + 跳空配额合并）----
  let addSignal = null;
  let capReached = false;
  let missingReserve = false;
  let addTier = null; // { crossed, total } 供进度展示（两档制恒为 1/2）
  let addBlockOut = null; // too_close_to_stop / risk_budget_reached / below_min_purchase_amount（阻断原因）
  const bandMid =
    Number.isFinite(bands.addTop) && Number.isFinite(bands.addBottom)
      ? (bands.addTop + bands.addBottom) / 2
      : null; // 参数化两档中界（平衡型 −7.5%）
  const addConsumed = Array.isArray(state.addConsumedTiers) ? [...state.addConsumedTiers] : [];
  // 破位期间禁止补仓：止损档位记录未清空时补仓一律禁用（避免下跌途中越补越深）；
  // 稳健型无加仓区，全域禁用。
  const rawInAdd =
    bandMid != null && lossRate <= bands.addTop && lossRate > bands.addBottom && !bands.noAdd;
  const curAddTier = rawInAdd ? (lossRate <= bandMid ? 2 : 1) : null;
  const inAddZone = rawInAdd && slConsumed.length === 0;
  // 出区（回本到加仓区上沿之上）时，加仓档消耗集清空（新周期重新启用）
  if (!rawInAdd && addConsumed.length) nextState.addConsumedTiers = [];
  if (inAddZone && cfg.addEnabled) {
    if (cfg.reserveCash == null) {
      missingReserve = true; // 未设置预留资金不给补仓建议，只提示先设置
    } else {
      const distanceToStop = Math.abs(bands.stop1 - lossRate); // 两个负数相减取绝对值，保证分母恒为正
      addTier = { crossed: curAddTier - 1, total: 2 };
      if (distanceToStop < 0.02) {
        addBlockOut = 'too_close_to_stop'; // 距止损线不足 2% 彻底切断（禁止补仓，非缩额）
      } else {
        const floorD = Math.max(distanceToStop, 0.08); // 预算分母底线 8%（对应最大杠杆 12.5 倍）
        const base = nextState.reserveBase ?? asset.invested;
        const riskBudget = base * (cfg.addRiskBudgetRate ?? 0.03); // 增量损失预算（预留资金基准为总承诺资本口径）
        const maxAddByRisk = (riskBudget - (state.addRiskUsed ?? 0)) / floorD;
        const cap = Math.min(cfg.reserveCash, base * cfg.reserveCap);
        const remainingBudget = round2(
          Math.min(cfg.reserveCash, cap) - (nextState.reserveUsed ?? state.reserveUsed ?? 0),
        );
        const gapMerge = curAddTier === 2 && !addConsumed.includes(1); // 跳空直入二档时合并一档配额
        const tierShare = gapMerge ? 1 : 0.5; // 两档基础配比各 1/2（跳空跨档配比合并为 1）
        const planShare = cfg.reserveCash * tierShare; // 配比基数 = 预留预算承诺额（planBudget），不用预留资金基准（reserveBase）
        let addAmount = Math.min(remainingBudget, planShare, maxAddByRisk);
        // 步进闸：同档防抖阈值 2.5%（addStep）；跨档（含跳空）弹性底线为半档宽 1.25%
        const stepAbs = Math.abs(Number(bands.addStep)) || 0.025;
        const stepNeed =
          state.lastAddTier == null || state.lastAddTier === curAddTier ? stepAbs : stepAbs / 2;
        const stepOk =
          !state.lastAddNavDate ||
          (() => {
            const i = idxOf(state.lastAddNavDate);
            if (i < 0) return true; // 上次加仓净值日超出窗口视为满足
            return adjNav <= adj[i].adj * (1 - stepNeed);
          })();
        const stopInterval = inCooldown(
          state.lastStopDate,
          series,
          lastIdx,
          cfg.actionCooldownDays,
        ); // 止损后间隔（防「刚割又补」）
        const tierDone =
          addConsumed.includes(curAddTier) || (gapMerge ? false : addConsumed.includes(curAddTier));
        if (remainingBudget <= 0)
          capReached = true; // 已达计划上限（reserveCap / reserveCash）
        else if (maxAddByRisk <= 0)
          addBlockOut = 'risk_budget_reached'; // 增量损失预算已耗尽
        else if (addAmount < (cfg.minPurchaseAmount ?? 100))
          addBlockOut = 'below_min_purchase_amount'; // 低于起购额阻断，不下发碎金额
        else if (!stepOk || stopInterval || addConsumed.includes(curAddTier)) {
          /* 步进、间隔或档位已消耗，不产生建议 */
        } else {
          addAmount = Math.floor(addAmount); // 加仓金额向下取整到元（起购口径）
          addSignal = {
            amount: addAmount,
            tier: curAddTier,
            gapMerge,
            reason: `亏损率 ${(lossRate * 100).toFixed(1)}% 处于补仓区第 ${curAddTier}/2 档${gapMerge ? '（跳空吞并一档配额）' : ''}，建议动用预留资金 ${addAmount} 元（预算配比 ${Math.round(tierShare * 100)}%）`,
          };
        }
      }
    }
  }

  // ---- 仲裁（优先级：清空 > 止损 > 止盈 > 补仓 > 警戒 > 关注 > 持有）----
  const PRIORITY = { EXIT: 6, STOP_LOSS: 5, TAKE_PROFIT: 4, ADD: 3, ALERT: 2, WATCH: 1, HOLD: 0 };
  const signals = [];
  if (exitSignal)
    signals.push({ state: 'EXIT', ratio: 1, reason: exitSignal.reason, trigger: exitSignal.cond });
  if (stopSignal)
    signals.push({
      state: 'STOP_LOSS',
      ratio: stopSignal.ratio,
      reason: stopSignal.reason,
      tier: stopSignal.tier,
    });
  if (tpSignal)
    signals.push({
      state: 'TAKE_PROFIT',
      ratio: tpSignal.ratio,
      reason: tpSignal.reason,
      trigger: 'trailing',
      coveredTiers: [],
    });
  if (xirrSignal)
    signals.push({
      state: 'TAKE_PROFIT',
      ratio: xirrSignal.ratio,
      reason: xirrSignal.reason,
      trigger: 'xirrLadder',
      coveredTiers: coveredTiersOf(xirrSignal.tier),
    });
  if (addSignal)
    signals.push({
      state: 'ADD',
      ratio: null,
      addAmount: addSignal.amount,
      reason: addSignal.reason,
      tier: addSignal.tier,
      gapMerge: addSignal.gapMerge,
    });
  const tpSignals = signals
    .filter((s) => s.state === 'TAKE_PROFIT')
    .sort((a, b) => b.ratio - a.ratio);
  const win =
    [
      ...signals.filter((s) => s.state !== 'TAKE_PROFIT'),
      ...(tpSignals.length ? [tpSignals[0]] : []),
    ].sort((a, b) => PRIORITY[b.state] - PRIORITY[a.state])[0] || null;

  // ---- 份额取整（向下取整只舍不入 + 起赎线前置门 + 按状态分流 + 微仓放行 + 大仓重归整 + 容差全等）----
  let fullRedemption = false;
  let manualAction = null; // 总量不足起赎线（below_min_redeem_total）：超小底仓人工介入，不下发注定拒单的指令
  let blockedByShareRules = false; // 止盈大仓尾数不可行且修正无效时阻断
  let retainRounded = null; // 归整微标签数据：{ minRetainShares, rawRatio }
  const minRedeem = cfg.minRedeemShares ?? 0.01;
  const minHold = cfg.minHoldingShares ?? cfg.minRetainShares ?? 10;
  const sharePrec = cfg.sharePrecision ?? 2;
  if (win && win.state !== 'ADD' && win.ratio != null) {
    const shares = asset.shares;
    if (shares < minRedeem) {
      manualAction = 'below_min_redeem_total'; // 前置门：连全额赎回都低于起赎线
    } else {
      const pw = Math.pow(10, sharePrec);
      const rawRatio = win.ratio;
      let target = Math.floor(shares * rawRatio * pw + 1e-6) / pw; // 向下取整防进位拒单；ε 守护防浮点表示误差下探
      if (target < minRedeem) target = minRedeem;
      if (win.state === 'STOP_LOSS' || win.state === 'EXIT') {
        if (shares - target < minHold) {
          target = shares;
          fullRedemption = true;
        } // 止损或清空不得停摆，无条件全额
      } else if (win.state === 'TAKE_PROFIT' && shares - target < minHold) {
        if (shares < minRedeem + minHold) {
          target = shares;
          fullRedemption = true;
        } // 微仓允许全额止盈（切分无意义）
        else {
          target = Math.floor((shares - minHold) * pw + 1e-6) / pw; // 大仓向下修正并重归整（ε 守护防表示误差）
          if (target < minRedeem || shares - target < minHold) blockedByShareRules = true; // 修正后仍不可行时阻断并展示兜底信息
        }
      }
      const isFullyRedeemed = Math.abs(target - shares) < 1e-4; // 浮点微差容差比较（分红、拆分浮点微差不误杀全额）
      const isValidRedeem = target >= minRedeem && shares - target >= minHold;
      if (isFullyRedeemed) {
        target = shares;
        fullRedemption = true;
      } else if (!isValidRedeem && win.state === 'TAKE_PROFIT' && !manualAction)
        blockedByShareRules = true;
      if (fullRedemption && rawRatio < 1 - 1e-9)
        retainRounded = { minRetainShares: minHold, rawRatio }; // 碎份额归整数据
      win.targetShares = target;
      win.ratio = target / shares; // 输出口径同源：引擎、UI、备忘共用归整后份额
    }
  }

  // ---- 卖出交易自动归因 ----
  // 卖出建议（止盈、止损）落盘后出现卖出交易时，自动归因为「已执行」；清空由清仓归零闭环。
  // 卖出归因标记（sellExec）落盘驱动降级文案，冷却从执行日重计；
  // 止盈另把峰值基准日重置为执行日净值日（峰值从执行价重计，防旧峰值立即再触发）。
  // 执行日净值日取序列中首个不早于卖出记录日的净值日（交易台账「确认日」口径）；
  // 净值未公布即视为在途，本轮不归因。
  // 归因起始日（sellAttributionAsOf）防同一笔卖出跨轮重复归因；新一轮事件（冷却推进）自然重新启用。
  const SELL_STATES = ['TAKE_PROFIT', 'STOP_LOSS'];
  let sellExec = null;
  let attribState = win && SELL_STATES.includes(win.state) ? win.state : null;
  if (!attribState) {
    // 当前无卖出动作（已回落关注、警戒、补仓等）时，仍按最近一次卖出事件归因；
    // 否则卖出后市场转亏会留下旧峰值，下次反弹时以旧峰值误触止盈。
    let latest = null;
    for (const s of SELL_STATES) {
      const d = cooldowns[s];
      if (d && (!latest || d > latest.date)) latest = { state: s, date: d };
    }
    if (latest) attribState = latest.state;
  }
  if (attribState && Array.isArray(asset.txSells) && cooldowns[attribState]) {
    const from =
      state.sellAttributionAsOf && state.sellAttributionAsOf > cooldowns[attribState]
        ? state.sellAttributionAsOf
        : cooldowns[attribState];
    const sells = asset.txSells.filter((t) => t && t.date > from && t.date <= navDate);
    if (sells.length) {
      const latestSell = sells.reduce((m, t) => (t.date > m.date ? t : m), sells[0]);
      const execIdx = series.findIndex((r) => r.date >= latestSell.date);
      if (execIdx >= 0) {
        sellExec = { state: attribState, navDate: series[execIdx].date };
        nextState.sellExec = sellExec;
        nextState.sellAttributionAsOf = series[execIdx].date;
        nextState.cooldowns[attribState] = series[execIdx].date; // 冷却从执行日重计
        // 峰值从执行价重计；现金流摊薄已把峰值基准日清空（休眠）时不复活
        if (attribState === 'TAKE_PROFIT' && nextState.hwmDate !== null)
          nextState.hwmDate = series[execIdx].date;
      }
    }
  }

  // 冷却与事件闸（判定顺序：事件标识去重、危险放行、档位与周期锁、已执行回执、冷却）。
  // 冷却锚读 nextState（卖出归因本轮可能已把锚重置到执行日）；
  // 已执行回执闸的数据源为 ack 标记（锁定期内同一状态恒抑制）。
  const emittedSet = new Set(
    Array.isArray(state.emittedFingerprints) ? state.emittedFingerprints : [],
  );
  const fingerprint = win ? buildFingerprint(win.state, win.tier ?? null, navDate) : null;
  const ackActiveForWin = !!(
    win &&
    state.ack &&
    state.ack.state === win.state &&
    inCooldown(state.ack.navDate, series, lastIdx, cfg.actionCooldownDays)
  );
  const event =
    !!win &&
    !shouldSuppressEvent({
      state: win.state,
      fullRedemption,
      existingCooldown: nextState.cooldowns[win.state],
      currentTier: win.tier ?? null,
      stopLossConsumedTiers: slConsumed,
      consumedTiers: state.consumedTiers || [],
      fingerprint,
      emittedFingerprints: emittedSet,
      executedInfo: ackActiveForWin ? { active: true, state: win.state } : null,
      tierLocked: win.state === 'STOP_LOSS' && win.tier != null && slConsumed.includes(win.tier),
      periodLocked:
        win.state === 'TAKE_PROFIT' &&
        win.trigger === 'trailing' &&
        state.trailingConsumedAtHwmDate === state.hwmDate &&
        state.hwmDate != null,
      inCooldownFlag: inCooldown(
        nextState.cooldowns[win.state],
        series,
        lastIdx,
        cfg.actionCooldownDays,
      ),
    });

  // ---- 执行计划（建议日与成交日时间错位契约）：动作态必产，
  // 成交归属日按时段推导，下单截止以生成时刻 now 推导 ----
  let executionPlan = null;
  if (win && ['TAKE_PROFIT', 'STOP_LOSS', 'EXIT', 'ADD'].includes(win.state)) {
    executionPlan = {
      ...buildExecutionPlan(win, cfg, ctx),
      signalNavDate: navDate,
      state: win.state,
    };
  }

  // 事件落盘才推进持久进度：已消耗档位、上次止损日、步进基准、冷却、周期止盈标记、
  // 止损档位记录全部跟随「事件」而非「信号」（被压制的信号不得无声消耗止盈档位、漂移锚点）。
  if (win && event) {
    nextState.cooldowns[win.state] = navDate;
    nextState.emittedFingerprints = [...emittedSet, fingerprint].slice(-50);
    if (win.state === 'TAKE_PROFIT') {
      // 被覆盖的止盈档位一并标记消耗；移动止盈路写周期止盈标记（与已执行登记的连带写入同款）
      const covered = new Set([
        ...(state.consumedTiers || []),
        ...tpSignals.flatMap((s) => s.coveredTiers || []),
      ]);
      nextState.consumedTiers = [...covered].sort((a, b) => a - b);
      if (win.trigger === 'trailing') nextState.trailingConsumedAtHwmDate = state.hwmDate;
    }
    if (win.state === 'STOP_LOSS') {
      nextState.lastStopDate = navDate; // 上次止损日跟随事件日
      // 档位写入（跳空向下吞并：命中二档时同步记录首档）
      const hit = win.tier ?? stop1Tier;
      nextState.stopLossConsumedTiers = [
        ...new Set([...slConsumed, ...[stop1Tier, stop2Tier].filter((t) => t <= hit)]),
      ].sort((a, b) => a - b);
      nextState.reboundedAfterStop = false; // 首档、二档落地均重置反弹确认标记
      if (hit === stop2Tier) nextState.lockedTroughDate = null; // 二档落地清除锁定谷底日，采样自执行日重起
      // 止损触发时旧峰值置空进筑底观察期（谷底日随新低动态下移）
      nextState.hwmDate = null;
      nextState.trailingConsumedAtHwmDate = null;
      nextState.resetTroughDate = nextState.resetTroughDate ?? navDate;
    }
    if (win.state === 'ADD') {
      nextState.lastAddNavDate = navDate; // 步进基准（上次加仓净值日）跟随事件日
      nextState.lastAddTier = win.tier ?? null;
      nextState.addConsumedTiers = [
        ...new Set([...addConsumed, win.tier ?? 1, ...(win.gapMerge ? [1] : [])]),
      ].sort((a, b) => a - b); // 跳空跨档配额合并一并标记
      const floorD = Math.max(Math.abs(bands.stop1 - lossRate), 0.08); // 与配额同源的预算分母底线
      nextState.addRiskUsed = Math.max(
        0,
        Math.round(((state.addRiskUsed ?? 0) + (win.addAmount ?? 0) * floorD) * 100) / 100,
      );
    }
    // 最近一次执行计划快照留存（已执行登记的服务端自闭环数据源：事件标识 + 计划体 + 消费标记）
    if (executionPlan) {
      const planBody = {
        ...executionPlan,
        fingerprint,
        ratio: win.ratio ?? null,
        addAmount: win.addAmount ?? null,
        tier: win.tier ?? null,
        shares: asset.shares,
        ts: (ctx.now ? ctx.now() : new Date()).toISOString(),
        consumedAt: null,
      };
      if (win.state === 'ADD' && win.addAmount != null) {
        // 增量损失预算消耗额（与配额同源公式，分母底线 max(abs(stop1 − R_econ), 0.08)）
        planBody.riskConsumed =
          Math.round(win.addAmount * Math.max(Math.abs(bands.stop1 - lossRate), 0.08) * 100) / 100;
      }
      if (win.state === 'STOP_LOSS')
        planBody.coveredStopTiers = [stop1Tier, stop2Tier].filter(
          (t) => t <= (win.tier ?? stop1Tier),
        ); // 跳空吞并集
      nextState.lastExecutionPlan = planBody;
    }
  } else if (
    !win &&
    state.lastExecutionPlan &&
    navDate > String(state.lastExecutionPlan.signalNavDate ?? '')
  ) {
    nextState.lastExecutionPlan = null; // 回非信号态且净值推进时作废
  }

  // ---- 主状态（非动作态由成本分档驱动：观望带为加仓区下沿至首档止损线，浅跌区为加仓区上沿以深）----
  let outState = win ? win.state : 'HOLD';
  if (!win) {
    if (lossRate > bands.stop1 && lossRate <= bands.addBottom)
      outState = 'ALERT'; // 观望带
    else if (lossRate <= bands.addTop) outState = 'WATCH'; // 浅跌与加仓区
  }

  nextState.lastEvalNavDate = navDate;
  nextState.posShares = asset.shares; // 持仓快照（份额）：现金流摊薄检测与清仓归零标记（巡检写 0）
  nextState.posInvested = asset.invested;

  // ---- 进度（徽章进度条数据：label + pct + tone ok·warn·hot·over + 原始 cur/line）----
  const pctClamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const toneOf = (pct) => (pct >= 100 ? 'over' : pct >= 80 ? 'hot' : pct >= 60 ? 'warn' : 'ok');
  const P = (label, pct, cur, line) => ({
    label,
    pct: pctClamp(pct),
    tone: toneOf(pctClamp(pct)),
    cur,
    line,
  });
  const absLoss = Math.abs(lossRate);
  const lossTxt = `亏 ${(absLoss * 100).toFixed(1)}%`;
  let progress = null;
  if (win?.state === 'EXIT') {
    progress =
      exitSignal?.cond === 'trendEnd'
        ? P('止损后反弹无力再破位（趋势终结）', 100, null, null)
        : P(
            `${lossTxt} / 兜底线 ${(bands.exitFloor * 100).toFixed(0)}%`,
            (absLoss / Math.abs(bands.exitFloor)) * 100,
            absLoss,
            Math.abs(bands.exitFloor),
          );
  } else if (win?.state === 'STOP_LOSS') {
    const deep = lossRate <= bands.stop2;
    const lineAbs = Math.abs(deep ? bands.stop2 : bands.stop1);
    progress = P(
      `${lossTxt} / ${deep ? '二档' : '首档'}线 ${(deep ? bands.stop2 : bands.stop1) * 100}%`,
      (absLoss / lineAbs) * 100,
      absLoss,
      lineAbs,
    );
  } else if (win?.state === 'TAKE_PROFIT' && win.trigger === 'trailing') {
    progress = P(
      `回撤 ${((drawdown || 0) * 100).toFixed(1)}% / 落袋线 ${(cfg.trailing.drawdownThreshold * 100).toFixed(0)}%`,
      ((drawdown || 0) / cfg.trailing.drawdownThreshold) * 100,
      drawdown || 0,
      cfg.trailing.drawdownThreshold,
    );
  } else if (win?.state === 'TAKE_PROFIT') {
    const tierAbs = xirrSignal ? xirrSignal.tier / 100 : cfg.xirrLadder.tiers[0].threshold;
    progress =
      xirr != null
        ? P(
            `年化 ${(xirr * 100).toFixed(1)}% / 台阶 ${tierAbs * 100}%`,
            (xirr / tierAbs) * 100,
            xirr,
            tierAbs,
          )
        : null;
  } else if (win?.state === 'ADD' && addTier) {
    progress = P(
      `${lossTxt} · 补仓区第 ${addTier.crossed + 1}/${addTier.total} 档`,
      (absLoss / Math.abs(bands.addBottom)) * 100,
      absLoss,
      Math.abs(bands.addBottom),
    );
  } else if (outState === 'ALERT') {
    progress = P(
      `${lossTxt} / 观望带 ${(bands.addBottom * 100).toFixed(0)}%~${(bands.stop1 * 100).toFixed(0)}%`,
      ((absLoss - Math.abs(bands.addBottom)) /
        (Math.abs(bands.stop1) - Math.abs(bands.addBottom))) *
        100,
      absLoss,
      Math.abs(bands.stop1),
    );
  } else if (outState === 'WATCH') {
    progress = P(
      `${lossTxt} / 观察区 ${(bands.addTop * 100).toFixed(0)}%~${(bands.addBottom * 100).toFixed(0)}%`,
      ((absLoss - Math.abs(bands.addTop)) / (Math.abs(bands.addBottom) - Math.abs(bands.addTop))) *
        100,
      absLoss,
      Math.abs(bands.addBottom),
    );
  } else if (outState === 'HOLD' && drawdown != null) {
    // 止盈监控中（含未触发的正常跟踪）：显示回撤进度，达 80% 以上即「临近落袋线」
    progress = P(
      `回撤 ${((drawdown || 0) * 100).toFixed(1)}% / 落袋线 ${(cfg.trailing.drawdownThreshold * 100).toFixed(0)}%`,
      ((drawdown || 0) / cfg.trailing.drawdownThreshold) * 100,
      drawdown || 0,
      cfg.trailing.drawdownThreshold,
    );
  }

  // ---- 已执行回执：卖出归因（本轮或此前落盘）优先，其次已执行登记（ack）----
  // 动作与当前信号一致且在其冷却窗口内时显示降级文案（徽章「锁定中」，不重复诱导操作）。
  let executedInfo = null;
  const execMarker = sellExec ?? state.sellExec ?? null;
  if (win && execMarker && execMarker.state === win.state) {
    const execIdx = idxOf(execMarker.navDate);
    if (execIdx >= 0) {
      const day = lastIdx - execIdx + 1;
      if (day >= 1 && day <= cfg.actionCooldownDays)
        executedInfo = {
          day,
          total: cfg.actionCooldownDays,
          navDate: execMarker.navDate,
          auto: true,
        };
    }
  }
  if (!executedInfo && win && state.ack && state.ack.state === win.state) {
    const ackIdx = idxOf(state.ack.navDate);
    if (ackIdx >= 0) {
      const day = lastIdx - ackIdx + 1;
      if (day >= 1 && day <= cfg.actionCooldownDays)
        executedInfo = { day, total: cfg.actionCooldownDays, navDate: state.ack.navDate };
    }
  }

  // ---- 忽略收敛：强绑定「本轮忽略」触发的冷却 ----
  // 冷却锚必须仍是本轮 ignore 写入的净值日；已执行登记或卖出归因把锚推进后自然解绑，
  // 防「已执行」被误渲染为「已忽略」。恒输出布尔；inCooldown 复用既有函数
  // （内含 idx<0 返回 false 的越界防护）。
  const ignored = Boolean(
    state.ignore &&
    state.ignore.state === outState &&
    nextState.cooldowns?.[outState] === state.ignore.navDate &&
    inCooldown(state.ignore.navDate, series, lastIdx, cfg.actionCooldownDays),
  );

  // 补仓效果与风险预演（preview 三数：摊薄后加权成本、回本涨幅、跌至首档止损时本次加仓亏损）
  let preview = null;
  if (win && win.state === 'ADD' && win.addAmount != null && asset.nav > 0 && asset.shares > 0) {
    const addShares = win.addAmount / asset.nav;
    const newShares = asset.shares + addShares;
    const newCost = (asset.invested + win.addAmount) / newShares;
    const stop1Price = newCost * (1 + bands.stop1); // 首档止损价位按摊薄后本金反解
    preview = {
      newCost: Math.round(newCost * 1e4) / 1e4,
      breakevenGain: Math.round((newCost / asset.nav - 1) * 1e4) / 1e4,
      stop1Price: Math.round(stop1Price * 1e4) / 1e4,
      stop1Loss: Math.round(addShares * (stop1Price - asset.nav) * 100) / 100, // 负值为亏损额（幅度随涨跌色由前端着色）
      addTier: { crossed: (win.tier ?? 1) - 1, total: 2 },
    };
  }
  const snapshot = {
    ...snapshotBase(asset, navDate),
    detectedDividends: dividends,
    truncated,
    trigger: win?.trigger ?? null,
    tier: win?.tier ?? null,
    drawdown,
    profitRate,
    lossRate,
    xirr,
    radar,
    reasonText: win
      ? win.reason
      : missingReserve
        ? '已进入加仓评估区，但未设置预留资金，请先在策略配置中设置 reserveCash'
        : capReached
          ? `亏损率 ${(lossRate * 100).toFixed(1)}% 处于加仓评估区，但累计加仓已达计划上限（reserveCap），不再提示补仓`
          : '',
    addAmount: win?.addAmount ?? null,
    addBlockReason: missingReserve ? 'missing_reserve' : capReached ? 'cap_reached' : addBlockOut,
    fullRedemption,
    manualAction,
    blockedByShareRules,
    retainRounded,
    preview,
    targetShares: win?.targetShares ?? null,
    executed: !!executedInfo, // 卖出交易自动归因与已执行登记（ack）双通道
    executedInfo,
    executionPlan,
    progress,
    configUsed: configUsedOf(cfg),
  };

  return {
    state: outState,
    ratio: win && win.state !== 'ADD' ? (win.ratio ?? null) : null,
    addAmount: win?.state === 'ADD' ? (win.addAmount ?? null) : null,
    radar,
    drawdown,
    profitRate,
    lossRate,
    xirr,
    progress,
    executed: !!executedInfo,
    executedInfo,
    ignored,
    executionPlan,
    snapshot,
    nextState,
    event,
    truncated,
  };
}

/** 碎份额归整见上方仲裁后主流程：按比例赎回后剩余份额低于最低保留份额时转全额赎回 */

/** 触发快照的配置留痕（可审计：记录当时生效的阈值与是否自定义） */
function configUsedOf(cfg) {
  const flat = (c) => {
    const b = c.costBands[c.riskClass] || c.costBands.balanced;
    return {
      riskClass: c.riskClass,
      addEnabled: c.addEnabled,
      'trailing.startProfit': c.trailing.startProfit,
      'trailing.drawdownThreshold': c.trailing.drawdownThreshold,
      'xirrLadder.tiers': c.xirrLadder.tiers.map((t) => t.threshold),
      'xirrLadder.minHoldDays': c.xirrLadder.minHoldDays,
      costBands: { ...b },
      radar: { ...c.radar },
      actionCooldownDays: c.actionCooldownDays,
    };
  };
  const used = flat(cfg);
  used._custom = JSON.stringify(used) !== JSON.stringify(flat(mergeConfig({})));
  return used;
}

function snapshotBase(asset, navDate) {
  return { code: asset.code, name: asset.name ?? null, navDate, nav: asset.nav ?? null };
}
