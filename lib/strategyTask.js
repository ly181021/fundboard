/**
 * 策略评估任务（双通道）。
 * 通道A：start()定时巡检，复用快照窗口，工作日15:00–24:00，净值晚间才公布。
 * 通道B：runOnce()供服务启动钩子，或POST /api/strategy/evaluate-now随时调用。
 * status()：只读实时评估，七态不落盘，供/api/strategy/status。
 *
 * 幂等：基金净值日未推进，小于等于lastEvalNavDate则跳过，复用bookArrivals的navDate推进模式。
 * 触发事件event=true，strategy_alerts.json只追加，strategy_state.json更新持久态。
 * 两者均为服务端单写方，不碰db.json乐观锁。
 * 历史序列按净值日增量缓存，当日内存复用，次日重拉，防止全量全部基金每日重拉打爆数据源。
 */
import { computeState, buildFundFlows } from '../js/calculator.js';
import { evaluateExitStrategy, prepareHistory } from '../js/strategy.js';
import { buildFifoLots, feeFifoRate, computeDPool } from '../js/riskMetrics.js';
import {
  buildLotLedger,
  consumeFifo,
  releaseFromConsumption,
  summarizeLots,
} from '../js/lotLedger.js';
import { parseISODate } from '../js/analysis.js';
import { inSnapshotWindow } from './snapshot.js';
import { fundStateDefaults } from './strategyStore.js';

/** 锚日期距今天自然日差（锚为 null → 0 天；parseISODate 双方同口径，差值恒为整天） */
const daysSince = (anchor, today) =>
  anchor ? Math.max(0, Math.round((parseISODate(today) - parseISODate(anchor)) / 86400000)) : 0;

/**
 * 自适应取数深度。
 * 公式 min(365, max(61, hwm 距今天数, lastStop 距今天数, 80)) 中 61 ≤ 80 恒成立（冗余项），
 * 等价简化为 min(365, max(80, ...))，语义不变。
 */
export function depthOf(entry, today) {
  return Math.min(
    365,
    Math.max(80, daysSince(entry?.hwmDate, today), daysSince(entry?.lastStopDate, today)),
  );
}

/** 序列合并：按 date 去重（新值覆盖旧值）→ 升序 → 恒按 365 上限截断（slice(-365)）；导出供单测内容断言 */
export function mergeSeries(cachedSeries, freshSeries) {
  const byDate = new Map();
  for (const r of cachedSeries) if (r && r.date) byDate.set(r.date, r);
  for (const r of freshSeries) if (r && r.date) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-365);
}

/**
 * 残余窗口闭合：交易回放检测 afterDate 之后是否出现过份额归零的卖出。
 * 服务器全程关机错过清仓巡检、重建仓后才恢复时，依靠交易记录识别旧仓位、重置僵尸锚。
 * 份额口径与 calculator.computeState 同源，买入加、卖出减、红利再投加，现金分红不动。
 */
export function hasLiquidationAfter(snapshot, transactions, afterDate) {
  if (!afterDate) return false;
  let shares = Number(snapshot?.hold_shares) || 0;
  const sorted = [...(transactions || [])].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  for (const tx of sorted) {
    if (!tx?.date || !tx.type) continue;
    const prev = shares;
    if (tx.type === 'buy') shares += Number(tx.shares) || 0;
    else if (tx.type === 'sell') shares -= Number(tx.shares) || 0;
    else if (tx.type === 'dividend' && tx.method === 'reinvest') shares += Number(tx.shares) || 0;
    if (tx.date > afterDate && prev > 0 && shares <= 1e-6) return true;
  }
  return false;
}

export function createStrategyTask({
  db,
  strategyStore,
  fetchHistory,
  log = () => {},
  now = () => new Date(),
  intervalMs = 30 * 60 * 1000,
  windowFn = inSnapshotWindow,
  xirrFn = undefined,
  refreshMinutes = [19 * 60, 21 * 60 + 45],
}) {
  let timer = null;
  let running = false;
  let histCache = { map: new Map() }; // 跨天保留：code → { series, depth, fetchedMinute, fetchedDay, refreshedMinutes }（服务重启即空，首拉全 depth 一次性）

  const p2 = (n) => String(n).padStart(2, '0');
  const dayKey = (nowFn) => {
    const t = nowFn();
    return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
  }; // 必须补零：参与 daysSince 日期运算，'2026-8-11' 会与锚日期相减失真

  /** 深度序列：跨天增量缓存防反爬连打，lsjz存在分钟级反爬窗口。
   * 自适应深度depthOf，由锚点距离今日的天数动态计算；头部回补用锚点覆盖判定，深度标量是随自然日自增的移动目标，
   * 不能作回补基准；锚恒是引擎从序列写出的日期，缓存头小于等于锚即覆盖、日更自增不触发回补；
   * 尾部增量needDays等于缺口加5，净值日空窗缓冲，lsjz每页20条通常1页追上；
   * 晚间刷新refreshMinutes档位制与refresh=true立即巡检共用同一增量路径；
   * cached.depth单调递增，内存恒保留365条永不降级，防止超窗锚大于等于365判定偶发失效。 */
  async function fetchCached(code, entry, { refresh = false } = {}) {
    const today = dayKey(now);
    const cached = histCache.map.get(code) ?? null;
    const depth = depthOf(entry, today);
    const series = cached?.series ?? [];
    const latestCached = series.length ? series[series.length - 1].date : null;
    const earliestCached = series.length ? series[0].date : null;
    const isAnchorCovered = (anchor) => {
      if (!anchor) return true;
      const span = daysSince(anchor, today);
      if (span > 365) return (cached?.depth ?? 0) >= 365; // 超窗锚：已拉满 365 上限即视为覆盖，不再天天回补
      return !!earliestCached && earliestCached <= anchor; // 窗内锚：缓存头必须早于或等于锚点日期
    };
    const needHeadBackfill =
      !cached?.series?.length ||
      !isAnchorCovered(entry?.hwmDate) ||
      !isAnchorCovered(entry?.lastStopDate);
    const nowTs = now();
    const minuteOfDay = nowTs.getHours() * 60 + nowTs.getMinutes();
    // 拉取触发条件，每天至多三次，跨天首评一次加晚间两档补拉：
    // 新的一天，fetchedDay不等于today，执行尾部增量，每日首评只拉缺失页；
    // 晚间档位refreshMinutes为19点、21点45分，判据使用当日分钟数，整点小时粒度会让21点45分档
    // 实际22点才触发。当日某次拉取早于档位，现时已过档位，且该档今日未补过，补拉一次
    // 获取当晚新净值；
    // refresh等于true立即巡检，强制尾部增量；头部缺口执行全量depth。
    // 其余场景，包含同日status高频轮询，一律复用缓存。尾部缺口在下一轮触发，绝不随轮询反复重拉。
    const newDay = !!cached && cached.fetchedDay !== today;
    const dueTiers =
      cached && cached.fetchedDay === today
        ? refreshMinutes.filter(
            (M) =>
              minuteOfDay >= M &&
              (cached.fetchedMinute ?? 0) < M &&
              !(cached.refreshedMinutes ?? []).includes(M),
          )
        : [];
    if (!refresh && cached && !newDay && dueTiers.length === 0 && !needHeadBackfill)
      return cached.series;
    const needDays =
      latestCached && !needHeadBackfill
        ? Math.min(depth, daysSince(latestCached, today) + 5)
        : depth;
    const { series: fresh } = await fetchHistory(code, needDays);
    const merged = mergeSeries(series, fresh);
    histCache.map.set(code, {
      series: merged,
      depth: Math.max(cached?.depth ?? 0, depth),
      fetchedMinute: minuteOfDay,
      fetchedDay: today,
      // 跨天重置（newDay 时丢弃昨日档位指纹）；双档同时到期只拉一次、两档同记（服务中断跨档恢复，防 30 分钟后再次重拉）
      refreshedMinutes: newDay
        ? [...dueTiers]
        : [...new Set([...(cached?.refreshedMinutes ?? []), ...dueTiers])],
    });
    return merged;
  }

  /**
   * 单基金输入合成：确认净值口径的持仓/现金流/累计现金分红。
   * @param {object} fund 基金（snapshot + transactions）
   * @param {Array} series 净值序列
   * @param {object|null} entry 持久态条目（ADD 归因标注用）
   * @returns {object} 引擎入参 asset
   */
  function buildAsset(fund, series, entry = null) {
    const st = computeState(fund.snapshot, fund.transactions);
    const last = series[series.length - 1];
    const marketValue = st.holdShares * last.nav; // 确认净值口径（估值不参与）
    const cashDividend = (fund.transactions || [])
      .filter((tx) => tx.type === 'dividend' && tx.method !== 'reinvest')
      .reduce((s, tx) => s + (Number(tx.amount) || 0), 0);
    const flows = buildFundFlows(fund, { holdAmount: marketValue }, last.date);
    // 纯买入交易流（reserveUsed 归因数据源）。不含 buildFundFlows 的基线本金流/期末市值，
    // 否则新导入基金的基线（-total_invested @ 创建日）会落进归因窗口、把加仓预算无声吃光
    const txBuys = (fund.transactions || [])
      .filter((tx) => tx.type === 'buy' && tx.date && Number(tx.amount) > 0)
      .map((tx) => ({ date: tx.date, amount: Number(tx.amount) }));
    // 纯卖出交易流（卖出自动归因数据源）：sell 交易只记份额（本金由 computeState 按加权成本折算），归因只用日期
    const txSells = (fund.transactions || [])
      .filter((tx) => tx.type === 'sell' && tx.date)
      .map((tx) => ({ date: tx.date, shares: Number(tx.shares) || 0 }));
    // FIFO 批次（holdDays 加权/费率）、D_pool + 在途（exDividends 自复权检测）、赎回费率（拟赎 1/2 覆盖批次加权）
    const lots = buildFifoLots({ snapshot: fund.snapshot, transactions: fund.transactions });
    const { dividends: exDividends } = prepareHistory(series);
    const pool = computeDPool(fund.transactions, {
      snapshot: fund.snapshot,
      navDate: last.date,
      exDividends,
      holdShares: st.holdShares,
    });
    const execFeeRate = feeFifoRate({
      lots,
      sharesToSell: st.holdShares / 2,
      asOf: last.date,
      feeTiers: [
        { minDays: 0, rate: 0.015 },
        { minDays: 30, rate: 0.0075 },
        { minDays: 365, rate: 0.005 },
        { minDays: 730, rate: 0 },
      ],
    }); // 持有期费率档（保守默认；基金级元数据接入后覆盖）
    // Lot 账本：ADD 归因买入标注（reserveUsedAsOf 锚后、封顶 reserveUsed，与引擎归因同窗）+ 批次账（FIFO 核销）
    const addAttribution = [];
    if (entry && entry.reserveUsedAsOf && (Number(entry.reserveUsed) || 0) > 0) {
      let acc = 0;
      const cap = Number(entry.reserveUsed);
      for (const b of fund.transactions || []) {
        if (b?.type === 'buy' && b.id && b.date > entry.reserveUsedAsOf && Number(b.amount) > 0) {
          const amt = Math.min(Number(b.amount), cap - acc);
          if (amt > 0) {
            addAttribution.push({ txId: b.id, amount: amt });
            acc += amt;
          }
          if (acc >= cap - 1e-9) break;
        }
      }
    }
    const lotLedger = buildLotLedger({
      snapshot: fund.snapshot,
      transactions: fund.transactions,
      addAttribution,
    });
    return {
      code: fund.code,
      name: fund.name,
      qdii: /QDII/i.test(fund.name ?? ''),
      shares: st.holdShares,
      invested: st.totalInvested,
      cashDividend,
      dPool: pool.pool,
      pendingTotal: pool.pendingTotal,
      nav: last.nav,
      navDate: last.date,
      flows,
      lots,
      lotLedger,
      lotSummary: summarizeLots(lotLedger, last.nav),
      _addAttribution: addAttribution,
      execFeeRate,
      txBuys,
      txSells,
    };
  }

  /**
   * 单基金评估（巡检与 status 共用）：返回 { fund, code, result } 或 null（跳过）。
   * forStatus=true 只读实时评估：不做"净值推进"幂等门（引擎纯函数无副作用，status 永远重算）；
   * 幂等门只闸写路径（runOnce），否则巡检盖章 lastEvalNavDate 后 status 恒返回空列表。
   * @param {object} fund 基金
   * @param {object} storeFunds 持久态 funds
   * @param {object} opts { forStatus, refresh, force }
   * @returns {Promise<object|null>} 评估结果或 null
   */
  async function evaluateFund(
    fund,
    storeFunds,
    { forStatus = false, refresh = false, force = false } = {},
  ) {
    const code = fund.code;
    if (!code || !/^\d{6}$/.test(String(code))) return null;
    const cfg = fund.strategy_config || {};
    if (cfg.enabled === false) return null; // 显式停用
    const st = computeState(fund.snapshot, fund.transactions);
    if (!(st.holdShares > 0)) return null; // 无持仓不监控（清仓后自然休眠）
    const entry = strategyStore.fundState(storeFunds, code);
    const series = await fetchCached(code, entry, { refresh });
    if (!series || series.length === 0) return null;
    const lastDate = series[series.length - 1].date;
    if (!forStatus && !force && entry.lastEvalNavDate && lastDate <= entry.lastEvalNavDate)
      return null; // 净值未推进 → 幂等跳过（force=true 显式跳过：改配置当日生效）
    const asset = buildAsset(fund, series, entry);
    const result = evaluateExitStrategy(asset, series, cfg, { state: entry, now, xirrFn });
    return {
      fund,
      code,
      result,
      asset,
      metrics: {
        nav: asset.nav,
        navDate: asset.navDate,
        shares: asset.shares,
        invested: asset.invested,
      },
    };
  }

  /** 内存执行计划缓存：status 只读通道零磁盘写；ack 自闭环优先读内存，miss 才实时评估 */
  const planCache = new Map(); // code → lastExecutionPlan（status 信号态实时刷新）

  /**
   * 「已执行」写通道：两段式——锁外预评估刷新快照 → 锁内先验后写原子代写（按态接管副作用）。
   * 契约恒 { code, state, navDate }：前端零传参，代写数值一律读 lastExecutionPlan 自闭环，无 undefined/NaN 路径。
   * @param {string} code 基金代码
   * @param {string} state 信号态
   * @param {string} navDate 信号净值日
   * @returns {Promise<object>} { ok, ack, proxied?, stale?, idempotent? }
   */
  async function ack(code, state, navDate) {
    if (!/^\d{6}$/.test(String(code)) || !state || !navDate)
      throw new Error('invalid_ack: 需要 code/state/navDate');
    // ---- 第一段（锁外，只读）：快照校验 + 必要时实时评估刷新（非巡检时段 ack 不读旧数据） ----
    const store0 = await strategyStore.loadState();
    const entry0 = strategyStore.fundState(store0.funds, code);
    let plan =
      entry0.lastExecutionPlan &&
      entry0.lastExecutionPlan.state === state &&
      entry0.lastExecutionPlan.signalNavDate === navDate &&
      !entry0.lastExecutionPlan.consumedAt
        ? entry0.lastExecutionPlan
        : null;
    if (!plan) {
      const cached = planCache.get(code);
      if (
        cached &&
        cached.state === state &&
        cached.signalNavDate === navDate &&
        !cached.consumedAt
      )
        plan = cached;
    }
    let signalStale = false;
    if (!plan && !running) {
      // 巡检在途 ⇒ 快照即将由巡检落盘，ack 不重复评估（防争同一取数闸门死锁）
      // 兜底：实时只读评估（不落盘）刷新快照；评估回非同态 ⇒ 信号已失效（拒绝代写，登记照写）
      const { data } = await db.load();
      const fund = (data.assets || []).find(
        (f) => f.code === String(code) && f.asset_type === 'fund',
      );
      if (fund) {
        // 兜底评估限时 3s（防与在途巡检争同一取数闸门死锁；超时放弃预评估，登记照写、不代写）
        let ev = null;
        try {
          ev = await Promise.race([
            evaluateFund(fund, store0.funds, { forStatus: true }).catch(() => null),
            new Promise((res) => {
              const t = setTimeout(() => res(null), 3000);
              if (t.unref) t.unref();
            }),
          ]);
        } catch (e) {
          ev = null;
        }
        if (ev && ev.result.state === state && ev.result.nextState.lastExecutionPlan)
          plan = ev.result.nextState.lastExecutionPlan;
        else if (ev && ev.result.state !== state) signalStale = true;
      }
    }
    const planForLog = plan;
    // ack 精确核销账本（锁外只读构建，计划有效时才有意义）
    let lotLedgerAtAck = null;
    if (plan) {
      const { data: dbAck } = await db.load();
      const fundAck = (dbAck.assets || []).find(
        (f) => f.code === String(code) && f.asset_type === 'fund',
      );
      if (fundAck) {
        const attr = [];
        if (entry0.reserveUsedAsOf && (Number(entry0.reserveUsed) || 0) > 0) {
          let accA = 0;
          const capA = Number(entry0.reserveUsed);
          for (const b of fundAck.transactions || []) {
            if (
              b?.type === 'buy' &&
              b.id &&
              b.date > entry0.reserveUsedAsOf &&
              Number(b.amount) > 0
            ) {
              const amt = Math.min(Number(b.amount), capA - accA);
              if (amt > 0) {
                attr.push({ txId: b.id, amount: amt });
                accA += amt;
              }
              if (accA >= capA - 1e-9) break;
            }
          }
        }
        lotLedgerAtAck = buildLotLedger({
          snapshot: fundAck.snapshot,
          transactions: fundAck.transactions,
          addAttribution: attr,
        });
      }
    }
    // ---- 第二段（锁内）：重读先验后写 + 幂等 + 原子代写 ----
    return strategyStore.withState(async ({ load, save }) => {
      const store = await load();
      const entry = strategyStore.fundState(store.funds, code);
      // 幂等：信号指纹已消费 ⇒ no-op 返回（连击/网络重试不双重扣损）
      const fp = state + '_' + navDate + '_' + (planForLog?.fingerprint ?? '');
      if (entry.lastAckFingerprint === fp && entry.ack?.state === state) {
        return { ok: true, idempotent: true, ack: entry.ack };
      }
      entry.ack = { state, navDate, ts: now().toISOString() };
      if (entry.ignore?.state === state) entry.ignore = null; // 已执行解除忽略残留
      entry.cooldowns = entry.cooldowns || {};
      entry.cooldowns[state] = navDate;
      // 锁内先验后写：磁盘快照与本次信号匹配（且未被消费）方可代写；失效 ⇒ 只登记不代写
      const diskPlan = entry.lastExecutionPlan;
      const diskValid = !!(
        diskPlan &&
        diskPlan.state === state &&
        diskPlan.signalNavDate === navDate &&
        !diskPlan.consumedAt
      );
      const valid = !signalStale && !!(diskValid || planForLog);
      const p = valid ? (diskValid ? diskPlan : planForLog) : null;
      if (p) {
        entry.lastAckFingerprint = fp;
        if (state === 'TAKE_PROFIT') {
          if (p.tier != null)
            entry.consumedTiers = [...new Set([...(entry.consumedTiers || []), p.tier])].sort(
              (a, b) => a - b,
            ); // XIRR 档代写（无 tier ⇒ trailing 路）
          else if (entry.hwmDate) entry.trailingConsumedAtHwmDate = entry.hwmDate; // 周期锁代写（冷却期满不重复卖 1/2）
        }
        if (state === 'STOP_LOSS') {
          entry.lastStopDate = navDate; // 破位锚代写（闸"刚割又补"）
          const tiers =
            Array.isArray(p.coveredStopTiers) && p.coveredStopTiers.length
              ? p.coveredStopTiers
              : p.tier != null
                ? [p.tier]
                : [];
          entry.stopLossConsumedTiers = [
            ...new Set([...(entry.stopLossConsumedTiers || []), ...tiers]),
          ].sort((a, b) => a - b); // 档位代写（含吞并集）
          entry.reboundedAfterStop = false;
        }
        if (state === 'ADD') {
          entry.lastAddNavDate = navDate; // 步进锚代写（防同价连加）
          const amt = Number(p.addAmount) || 0;
          entry.reserveUsed = Math.round(((entry.reserveUsed || 0) + amt) * 100) / 100; // 记账（防横盘循环催促）
          const risk = Number(p.riskConsumed) || amt * 0.08; // 引擎同源公式产物；缺产按底线 8% 兜底
          entry.addRiskUsed = Math.max(
            0,
            Math.round(((entry.addRiskUsed || 0) + risk) * 100) / 100,
          );
          if (String(entry.reserveUsedAsOf ?? '') < navDate) entry.reserveUsedAsOf = navDate; // 水位线单调不回退
        }
        if (state !== 'ADD') {
          // 赎回类 ack：addRiskUsed 即时等比释放；reserveUsed 只记 pendingRelease 待确认
          // （意向 ≠ 资金释放，超时冲正、真实流水认领转正式）
          // 有 ADD 标注批次 ⇒ 按拟赎份额 FIFO 精确核销（lotLedgerAtAck 锁外只读构建）；无标注回退等比
          let riskRel = 0,
            cashRel = 0;
          if (Array.isArray(lotLedgerAtAck) && lotLedgerAtAck.some((l) => l.addAmount > 0)) {
            const sharesToSell = (Number(p.shares) || 0) * (Number(p.ratio) || 1);
            const { consumed } = consumeFifo(lotLedgerAtAck, sharesToSell);
            const rel = releaseFromConsumption(consumed);
            riskRel = Math.min(rel.addRiskRelease, entry.addRiskUsed || 0);
            cashRel = Math.min(rel.reserveRelease, entry.reserveUsed || 0);
          } else {
            const relRatio = Number(p.ratio) || 1;
            riskRel = (entry.addRiskUsed || 0) * relRatio;
            cashRel = (entry.reserveUsed || 0) * relRatio;
          }
          entry.addRiskUsed = Math.max(
            0,
            Math.round(((entry.addRiskUsed || 0) - riskRel) * 100) / 100,
          );
          if (cashRel > 0.005) {
            const exp = new Date(now().getTime() + 4 * 86400000).toISOString().slice(0, 10); // T+2 交易日自然日近似（含周末缓冲）
            entry.pendingRelease = [
              ...(entry.pendingRelease || []),
              { amount: Math.round(cashRel * 100) / 100, ts: now().toISOString(), expiresAt: exp },
            ];
          }
          entry.releaseLog = [
            ...(entry.releaseLog || []),
            { kind: 'ack_redeem', ratio: Number(p.ratio) || 1, fingerprint: p.fingerprint ?? null },
          ];
        }
        // 计划消费标记（幂等闸数据源）
        if (diskPlan && diskPlan.fingerprint === (p.fingerprint ?? null))
          entry.lastExecutionPlan = { ...diskPlan, consumedAt: now().toISOString() };
      }
      store.funds[code] = entry;
      await save(store);
      return { ok: true, ack: entry.ack, proxied: !!p, stale: signalStale };
    });
  }

  // ---- 人工纠偏通道：ignore / reset-tiers / correct-reserve ----
  const ACTION_STATES = ['TAKE_PROFIT', 'STOP_LOSS', 'EXIT', 'ADD'];

  /**
   * 「忽略」：写 ignore 标记 + 冷却锚推进到当日（"这轮已消化"）；hwmDate/lastStopDate 不动。
   * @param {string} code 基金代码
   * @param {string} state 信号态
   * @param {string} navDate 净值日
   * @returns {Promise<object>} { ok, ignore }
   */
  async function ignore(code, state, navDate) {
    if (!/^\d{6}$/.test(String(code)) || !state || !navDate)
      throw new Error('invalid_ignore: 需要 code/state/navDate');
    if (!ACTION_STATES.includes(state)) throw new Error('invalid_ignore: state 必须是动作态');
    const store = await strategyStore.loadState();
    const entry = strategyStore.fundState(store.funds, code);
    entry.ignore = { state, navDate, ts: now().toISOString() };
    entry.cooldowns = entry.cooldowns || {}; // 显式兜底（fundState 合并后恒为对象，防手工构造路径）
    entry.cooldowns[state] = navDate;
    store.funds[code] = entry;
    await strategyStore.saveState(store);
    return { ok: true, ignore: entry.ignore };
  }

  /**
   * 重置阶梯消耗位：tier 缺省全重置；单档重置幂等（不在列表仍 200）；tier 必须为整数 number。
   * @param {string} code 基金代码
   * @param {number} [tier] 档位（如 15 = 15%）
   * @returns {Promise<object>} { ok, consumedTiers }
   */
  async function resetTiers(code, tier) {
    if (!/^\d{6}$/.test(String(code))) throw new Error('invalid_code: code 必须为 6 位');
    const store = await strategyStore.loadState();
    const entry = strategyStore.fundState(store.funds, code);
    const tiers = Array.isArray(entry.consumedTiers) ? entry.consumedTiers : [];
    if (tier === undefined || tier === null) {
      entry.consumedTiers = [];
    } else {
      if (typeof tier !== 'number' || !Number.isFinite(tier) || Math.round(tier) !== tier) {
        throw new Error('invalid_tier: tier 必须是整数数值（15 = 15%）');
      }
      if (tiers.includes(tier)) entry.consumedTiers = tiers.filter((t) => t !== tier);
      // 幂等：档不在列表 → 保持现状、仍 200
    }
    store.funds[code] = entry;
    await strategyStore.saveState(store);
    return { ok: true, consumedTiers: entry.consumedTiers };
  }

  /**
   * 手动校正 reserveUsed（归因漏计兜底）：严格校验不静默钳制；锚为空时初始化。
   * @param {string} code 基金代码
   * @param {number} reserveUsed 校正值
   * @returns {Promise<object>} { ok, reserveUsed, cap }
   */
  async function correctReserve(code, reserveUsed) {
    if (!/^\d{6}$/.test(String(code))) throw new Error('invalid_code: code 必须为 6 位');
    if (typeof reserveUsed !== 'number' || !Number.isFinite(reserveUsed)) {
      throw new Error('invalid_reserve_used: reserveUsed 必须为数值'); // 类型守卫
    }
    const { data } = await db.load();
    const fund = (data.assets || []).find(
      (f) => f.code === String(code) && f.asset_type === 'fund',
    );
    if (!fund) throw new Error('fund_not_found');
    const cfg = fund.strategy_config || {};
    if (!cfg.addEnabled) throw new Error('add_not_enabled'); // 前置中断
    const store = await strategyStore.loadState();
    const entry = strategyStore.fundState(store.funds, code);
    // 配置了比例上限但底仓基准未就绪（基金尚未完成首次评估）→ 拒绝，防定额击穿底仓比例
    if (typeof cfg.reserveCap === 'number' && typeof entry.reserveBase !== 'number') {
      throw new Error('reserve_base_not_ready');
    }
    const caps = [];
    if (typeof cfg.reserveCash === 'number') caps.push(cfg.reserveCash);
    if (typeof cfg.reserveCap === 'number') caps.push(entry.reserveBase * cfg.reserveCap);
    const cap = caps.length > 0 ? Math.min(...caps) : null;
    if (cap === null) throw new Error('add_not_enabled');
    if (reserveUsed < 0 || reserveUsed > cap) {
      const e = new Error(`out_of_cap: 0 ~ ${cap}`);
      e.cap = cap;
      throw e;
    }
    const delta = reserveUsed - (entry.reserveUsed ?? 0);
    entry.reserveUsed = reserveUsed;
    if (delta > 0)
      entry.addRiskUsed = Math.max(
        0,
        Math.round(((entry.addRiskUsed || 0) + delta * 0.08) * 100) / 100,
      ); // 双记：补录增量按 D1 底线 8% 计增量损失
    // 锚为空时初始化：lastEvalNavDate ?? 本地自然日（toLocaleDateString('sv-SE')，禁用 toISOString 取日防 UTC 陷阱）
    if (entry.reserveUsedAsOf == null) {
      entry.reserveUsedAsOf = entry.lastEvalNavDate ?? now().toLocaleDateString('sv-SE');
    }
    store.funds[code] = entry;
    await strategyStore.saveState(store);
    return { ok: true, reserveUsed, cap };
  }

  /**
   * 巡检一轮（通道 A/B 共用）：触发事件落盘 + 持久态更新；返回 { evaluated, events }。
   * refreshHistory=true：强制重拉当日缓存（净值当晚公布后手动巡检能拿到新数据）。
   * @param {object} [opts] { refreshHistory, force }
   * @returns {Promise<object>} { evaluated, events, skipped? }
   */
  async function runOnce({ refreshHistory = false, force = false } = {}) {
    if (running) return { evaluated: 0, events: 0, skipped: 'running' };
    running = true;
    try {
      const { data } = await db.load();
      const store = await strategyStore.loadState();
      // 并发防线：评估期间 ack/ignore/reset-tiers/correct-reserve 可能已落盘，saveState 前
      // 以"开工快照"为基准重读最新持久态，只把用户路由并发写入的字段合并回来，防整包覆盖回退。
      // 合并面 = 用户可写字段（ack/ignore/consumedTiers/reserveUsed/reserveUsedAsOf + cooldowns 按键）；
      // 引擎本轮计算的峰值/破位链/幂等锚不受影响；清仓重置（resetCodes）以本轮为准不合并。
      const fundsAtStart = JSON.parse(JSON.stringify(store.funds));
      const resetCodes = new Set();
      const funds = data.assets.filter((f) => f.asset_type === 'fund');
      const events = [];
      let evaluated = 0;
      for (const fund of funds) {
        // 清仓归零 → 持久进度重置：runOnce 是唯一写路径，见到零持仓即重置并标记 posShares=0，
        // 重建仓后旧破位链/旧峰值/消耗位不复活（引擎按 posShares=0 兜底二次清零）。
        // 残余窗口闭合：清仓与重建仓之间一次巡检都没跑（如服务器全程关机）时，
        // 靠交易记录检测"lastEvalNavDate 之后份额归零的卖出"识别旧仓位，同样重置；重建仓本轮照常评估。
        if (fund.code && /^\d{6}$/.test(String(fund.code)) && store.funds[fund.code]) {
          const entry = store.funds[fund.code];
          // pendingRelease 冲正：超时未见到账流水 ⇒ 标记失效、额度恢复、留痕
          if (Array.isArray(entry.pendingRelease) && entry.pendingRelease.length) {
            const todayKey = dayKey(now);
            const alive = entry.pendingRelease.filter((m) => m.expiresAt >= todayKey);
            if (alive.length !== entry.pendingRelease.length) {
              entry.releaseLog = [
                ...(entry.releaseLog || []),
                ...entry.pendingRelease
                  .filter((m) => m.expiresAt < todayKey)
                  .map((m) => ({ kind: 'pending_expired', amount: m.amount, ts: m.ts })),
              ];
              entry.pendingRelease = alive;
            }
          }
          const cleared = !(computeState(fund.snapshot, fund.transactions).holdShares > 0);
          const rebuilt =
            !cleared &&
            hasLiquidationAfter(fund.snapshot, fund.transactions, entry.lastEvalNavDate ?? null);
          if (cleared || rebuilt) {
            store.funds[fund.code] = {
              ...fundStateDefaults(),
              posShares: 0,
              posInvested: 0,
              lastEvalNavDate: entry.lastEvalNavDate ?? null,
            };
            resetCodes.add(fund.code);
            log(
              `[策略] ${fund.name ?? fund.code} ${cleared ? '持仓已清零' : '检测到清仓后重建仓（残余窗口闭合）'} → 策略进度重置（重建仓从零起算）`,
            );
            if (cleared) continue; // 无持仓不评估；重建仓本轮照常评估（引擎 posShares=0 兜底二次清零）
          }
        }
        let ev;
        try {
          ev = await evaluateFund(fund, store.funds, { refresh: refreshHistory, force });
        } catch (e) {
          // 单基金配置异常（如安全垫不变量 throw）只降级该基金，不阻断整轮——否则一只坏配置让全部基金的持久态与事件永远落不了盘
          log(`[策略] ${fund.name ?? fund.code} 评估失败（本轮跳过）：${e.message}`);
          continue;
        }
        if (!ev) continue;
        evaluated++;
        const { code, result } = ev;
        // ---- 卖出流水对账释放——引擎本轮新归因卖出 ⇒ 双账本释放 + 凭证 ----
        const prevEntry = store.funds[code] ? strategyStore.fundState(store.funds, code) : null;
        const newSellExec = result.nextState.sellExec && prevEntry && !prevEntry.sellExec;
        if (newSellExec && prevEntry && (prevEntry.posShares ?? 0) > (ev.metrics.shares || 0)) {
          const prevPos = prevEntry.posShares;
          const soldShares = Math.round((prevPos - ev.metrics.shares) * 100) / 100;
          const e0 = strategyStore.fundState(store.funds, code);
          let riskRel = 0,
            cashRel = 0,
            releaseKind = 'sell_flow',
            consumedLotIds = [];
          const ledger = Array.isArray(ev.asset?.lotLedger) ? ev.asset.lotLedger : null;
          const annotated = (ledger || []).some((l) => l.addAmount > 0);
          if (ledger && annotated) {
            // 释放精确化：还原卖出前账面按 FIFO 核销，只释放实际被消耗的 ADD 批次
            const sellTx = [...(ev.fund.transactions || [])]
              .filter(
                (t) =>
                  t?.type === 'sell' &&
                  t.id &&
                  t.date > (prevEntry.sellAttributionAsOf ?? '') &&
                  t.date <= ev.metrics.navDate,
              )
              .pop();
            const before = sellTx
              ? buildLotLedger({
                  snapshot: ev.fund.snapshot,
                  transactions: ev.fund.transactions,
                  addAttribution: ev.asset._addAttribution || [],
                  stopAtTxId: sellTx.id,
                })
              : ledger;
            const { consumed } = consumeFifo(before, soldShares);
            const rel = releaseFromConsumption(consumed);
            riskRel = Math.min(rel.addRiskRelease, e0.addRiskUsed || 0);
            cashRel = Math.min(rel.reserveRelease, e0.reserveUsed || 0);
            releaseKind = 'lot_write_off';
            consumedLotIds = consumed.filter((c) => c.addAmount > 0).map((c) => c.lotId);
          } else {
            // 回退口径：无 ADD 标注批次 ⇒ 等比释放（老基金/未启用加仓）
            const soldRatio = Math.min(1, Math.max(0, soldShares / prevPos));
            riskRel = (e0.addRiskUsed || 0) * soldRatio;
            cashRel = (e0.reserveUsed || 0) * soldRatio;
          }
          result.nextState.addRiskUsed = Math.max(
            0,
            Math.round(((e0.addRiskUsed || 0) - riskRel) * 100) / 100,
          ); // 非负钳制
          result.nextState.reserveUsed = Math.max(
            0,
            Math.round(((e0.reserveUsed || 0) - cashRel) * 100) / 100,
          );
          result.nextState.releaseLog = [
            ...(e0.releaseLog || []),
            {
              kind: releaseKind,
              sharesSold: soldShares,
              consumedLotIds,
              dateRange: [
                prevEntry.sellAttributionAsOf ?? result.nextState.sellExec.navDate,
                result.nextState.sellExec.navDate,
              ],
            },
          ]; // D4 赎回凭证 {shares, dateRange}
          log(
            '[策略] ' +
              (ev.fund.name ?? code) +
              ' 卖出对账：' +
              (releaseKind === 'lot_write_off' ? '批次核销' : '等比释放') +
              ' addRiskUsed −' +
              riskRel.toFixed(2) +
              ' / reserveUsed −' +
              cashRel.toFixed(2),
          );
        }
        store.funds[code] = { ...result.nextState }; // 持久态（含 lastEvalNavDate，幂等锚）
        if (result.event) {
          events.push({
            ts: now().toISOString(),
            code,
            name: ev.fund.name ?? null,
            state: result.state,
            ratio: result.ratio,
            tier: result.snapshot.tier ?? null,
            addAmount: result.addAmount ?? null,
            _own: {
              // 洗涤比对基线：本事件自身落盘的持久副作用（区分"引擎自写"与"用户并发覆写"）
              cooldown: result.nextState.cooldowns?.[result.state] ?? null,
              stopTiers: result.nextState.stopLossConsumedTiers ?? [],
            },
            ...result.snapshot, // 全量留痕：navDate/nav/trigger/drawdown/profitRate/lossRate/xirr/radar/configUsed/truncated/reasonText
          });
          log(
            `[策略] ${ev.fund.name ?? code} → ${result.state}${result.ratio != null ? ` 赎 ${Math.round(result.ratio * 100)}%` : ''}${result.addAmount != null ? ` 补 ${result.addAmount} 元` : ''}`,
          );
        }
      }
      // 并发合并：saveState携带开工快照做字段级差分合并加乐观锁重试。
      // 并发路由ack、ignore、reset-tiers、correct-reserve轮中写入的双写字段由存储层合并器裁决。
      // 重置最高优先，冷却单调取新，releaseLog并集，语义仲裁，引擎内存新值不被磁盘旧快照冲刷，
      // 合法清空不被复活，清仓重置码以本轮为准不合并resetCodes。
      await strategyStore.saveState(store, {
        baseline: fundsAtStart,
        baseRev: store.rev ?? 0,
        skipMergeCodes: [...resetCodes],
      });
      // 告警二次洗涤：以合并后最新态复检事件前置，已ack或ignore或破位锁成立则剔除。
      const washed = events.filter((e0) => {
        const fin = store.funds[e0.code] || {};
        const own = e0._own || { cooldown: null, stopTiers: [] };
        // 与引擎自写值比对：合并后的值不等于本事件自身落盘值，判定为并发覆写，直接洗掉。
        if ((fin.cooldowns?.[e0.state] ?? null) !== own.cooldown) return false; // ack/ignore 推进的冷却
        if (e0.state === 'ADD' && (fin.stopLossConsumedTiers || []).length > own.stopTiers.length)
          return false; // 代写破位锁 ⇒ 撤加仓推送
        if (
          e0.state === 'STOP_LOSS' &&
          e0.tier != null &&
          (fin.stopLossConsumedTiers || []).includes(e0.tier) &&
          !own.stopTiers.includes(e0.tier)
        )
          return false; // 用户代写同档
        delete e0._own; // 不入库
        return true;
      });
      if (washed.length) await strategyStore.appendAlerts(washed);
      return { evaluated, events: events.length };
    } finally {
      running = false;
    }
  }

  /**
   * status 展示用预算上限（数据不完整返回 null；纠偏路由 correctReserve 有严格校验）。
   * reserveCap 已配但 reserveBase 未就绪时返回 null（与 correct-reserve 的 400 口径一致，
   * 不显示"可输入但必被拒"的上限）。
   */
  const capForDisplay = (fund, entry) => {
    const cfg = fund?.strategy_config || {};
    if (!cfg.addEnabled) return null;
    if (typeof cfg.reserveCap === 'number' && typeof entry.reserveBase !== 'number') return null;
    const caps = [];
    if (typeof cfg.reserveCash === 'number') caps.push(cfg.reserveCash);
    if (typeof cfg.reserveCap === 'number') caps.push(entry.reserveBase * cfg.reserveCap);
    return caps.length > 0 ? Math.min(...caps) : null;
  };

  /**
   * 只读实时评估，status路由：不落盘，不更新冷却、lastEvalNavDate；单基金异常降级为error条目，不中断整体流程。
   * @returns {Promise<object>} { ts, funds }
   */
  async function status() {
    const { data } = await db.load();
    const store = await strategyStore.loadState();
    const out = [];
    for (const fund of data.assets.filter((f) => f.asset_type === 'fund')) {
      let ev;
      try {
        ev = await evaluateFund(fund, store.funds, { forStatus: true });
      } catch (e) {
        out.push({
          code: fund.code,
          name: fund.name ?? null,
          state: null,
          error: `评估失败：${e.message}`,
        });
        continue;
      }
      if (!ev) continue;
      const r = ev.result;
      if (r.event && r.executionPlan)
        planCache.set(ev.code, r.nextState.lastExecutionPlan ?? { ...r.executionPlan }); // 内存快照缓存（读端零磁盘写）

      const entry = strategyStore.fundState(store.funds, ev.code); // 纠偏区展示字段（持久态读值）
      out.push({
        code: ev.code,
        name: ev.fund.name ?? null,
        state: r.state,
        ratio: r.ratio,
        addAmount: r.addAmount ?? null,
        radar: r.radar,
        drawdown: r.drawdown,
        progress: r.progress ?? null,
        reasonText: r.snapshot.reasonText,
        addBlockReason: r.snapshot.addBlockReason ?? null,
        executed: r.executed,
        executedInfo: r.executedInfo ?? null,
        ignored: r.ignored, // 后端收敛布尔（恒真/假）
        consumedTiers: entry.consumedTiers ?? [],
        reserveUsed: entry.reserveUsed ?? 0,
        cap: capForDisplay(ev.fund, entry),
        trigger: r.snapshot.trigger ?? null,
        fullRedemption: r.snapshot.fullRedemption ?? false,
        // 详情卡数据（人话三段式 + 效果预演）
        nav: ev.metrics.nav,
        navDate: ev.metrics.navDate,
        shares: ev.metrics.shares,
        invested: ev.metrics.invested,
        profitRate: r.profitRate,
        lossRate: r.lossRate,
        xirr: r.xirr,
        customParams: r.snapshot.configUsed?._custom ?? false,
        preview: r.snapshot.preview ?? null,
        retainRounded: r.snapshot.retainRounded ?? null,
        manualAction: r.snapshot.manualAction ?? null,
        blockedByShareRules: r.snapshot.blockedByShareRules ?? false,
        targetShares: r.snapshot.targetShares ?? null,
        executionPlan: r.executionPlan ?? null,
        addRiskUsed: entry.addRiskUsed ?? 0,
        lotSummary: ev.asset?.lotSummary ?? null, // 盈利底仓判定（不替代 HWM）
      });
    }
    return { ts: now().toISOString(), funds: out };
  }

  /**
   * 触发历史（预警中心时间线）：只读，最新在前，默认最多 50 条。
   * @param {number} [limit] 条数上限
   * @returns {Promise<object>} { ts, total, alerts }
   */
  async function alerts(limit = 50) {
    const list = await strategyStore.loadAlerts();
    return { ts: now().toISOString(), total: list.length, alerts: list.slice(-limit).reverse() };
  }

  function start() {
    if (timer) return;
    runOnce().catch((e) => log(`[策略] 启动评估失败：${e.message}`));
    timer = setInterval(() => {
      if (windowFn(now())) runOnce().catch((e) => log(`[策略] 巡检失败：${e.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    runOnce,
    status,
    ack,
    alerts,
    start,
    stop,
    evaluateFund,
    ignore,
    resetTiers,
    correctReserve,
  };
}
