/**
 * 定时入账任务（服务端）：工作日收盘时段自动抓取净值，落盘逐基金到账收益，后台自动积累，无需页面在线。
 *
 * 口径与前端bookDailyArrivals（js/app.js）完全一致；复用js/calculator.js computeState算本金份额、js/analysis.js bookArrivals入账，
 * 不复制实现，避免两端口径漂移（口径偏差最难排查）。
 *
 * 到账日志：{ code, date, navDate, earnings, invested, assets }（详见analysis.js）。
 * date为到账日（国内=净值日；QDII净值滞后一天，记净值日后首个 A 股交易日，节假日感知）。
 * 同基金navDate未推进不重复入账（幂等，周末/净值未到不产生空记录）；只采用确认净值，盘中估值不计入。
 *
 * 零依赖自调度：交易日15:00–24:00按intervalMs轮询；覆盖国内基金、QDII净值发布时段。
 * 按A股交易日历跳过节假日；数据源异常降级为周一至周五粗判。
 * 不在窗口则休眠至下一交易日15:00；start启动先补跑一轮，不做交易日闸门，适配收盘后启动场景。
 * 到账日按拉取到的净值日期按标准映射推算，不记拉取当日。
 */
import { computeState } from '../js/calculator.js';
import { bookArrivals, auditPrincipalJumps } from '../js/analysis.js';
import { createTradingCalendar } from '../js/tradingCalendar.js';
import { ConflictError } from './database.js';

const tradingCalendar = createTradingCalendar();

/** 本地时区日期串 YYYY-MM-DD */
function localDateStr(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 净值发布/入账时段：工作日 15:00–24:00（与前端 js/app.js 轮询窗口重叠） */
export function inSnapshotWindow(now = new Date()) {
  const day = now.getDay();
  const h = now.getHours();
  return day >= 1 && day <= 5 && h >= 15;
}

/** 严格晚于 now 的下一个窗口开始时刻（工作日 15:00） */
export function nextSnapshotWindowStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(15, 0, 0, 0);
  while (d.getTime() <= now.getTime() || d.getDay() < 1 || d.getDay() > 5) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * 由持仓 + 行情计算本轮到账候选（确认口径）。
 * quotesByCode: code → /api/quote 结构（lib/quotes.js buildQuote 产物）。
 * 返回 [{code, navDate, earnings, invested, assets}]：
 * 零份额基金不看行情、不入账；缺行情/缺净值日期/缺前一日净值（无法算变动）的基金跳过，
 * 由 bookArrivals 按"navDate 推进才入账"的规则决定是否真正落盘。
 */
export function computeArrivalEntries(assets, quotesByCode) {
  const entries = [];
  const round2 = (v) => Math.round(v * 100) / 100;
  for (const a of (assets || []).filter((x) => x.asset_type === 'fund')) {
    const state = computeState(a.snapshot, a.transactions);
    if (state.holdShares <= 0) continue;
    const q = quotesByCode?.[a.code];
    if (!q || !Number.isFinite(q.nav) || q.nav_date == null || !Number.isFinite(q.prev_nav))
      continue;
    entries.push({
      code: a.code,
      navDate: q.nav_date,
      earnings: round2(state.holdShares * (q.nav - q.prev_nav)),
      invested: round2(state.totalInvested),
      assets: round2(state.holdShares * q.nav),
      qdii: /QDII/i.test(a.name),
    });
  }
  return entries;
}

/**
 * 创建入账任务。
 * fetchQuotes(codes) → { quotes, errors }（与 datasource.fetchQuoteBatch 同签名）；
 * 日志/时钟/间隔/窗口判定/节假日取数均可注入（测试用假时钟、假行情）。
 * 返回 { runOnce, start, stop }；是否启用由调用方决定（server.js 按 SNAPSHOT_TASK）。
 */
export function createSnapshotTask({
  db,
  fetchQuotes,
  log = () => {},
  now = () => new Date(),
  intervalMs = 30 * 60 * 1000,
  windowFn = inSnapshotWindow,
  isTradingDay = (d) => tradingCalendar.isTradingDay(d),
  fetchHolidays = (years) => tradingCalendar.holidaysOfYears(years),
} = {}) {
  let running = false;
  let timer = null;
  let started = false;
  let stopped = false;
  let lastJumpSig = ''; // 巡检告警去重：同一组未留痕跳变只在变化时打一行（每轮 30min 重打会刷屏）

  /** 本金跳变自动巡检（口径 Ⅰ）：无交易解释且无修正留痕的本金跳变 = 漏记修正 → 落日志告警 */
  function auditAndWarn(daily, corrections, assets) {
    const { unexplained } = auditPrincipalJumps(daily, corrections, assets);
    const sig = unexplained
      .map((j) => `${j.code}|${j.date}|${j.from}->${j.to}`)
      .sort()
      .join(',');
    if (sig === lastJumpSig) return; // 集合未变化：不重复打日志
    lastJumpSig = sig;
    if (unexplained.length > 0) {
      log(
        `[巡检] 发现 ${unexplained.length} 处未留痕本金跳变（无交易解释、也无修正留痕）：` +
          `${unexplained.map((j) => `${j.code} ${j.date} ${j.from}→${j.to}`).join('、')}` +
          '——请核对是否手动改过本金；确认后可用 tools/backfill-corrections.mjs 补录留痕',
      );
    } else {
      log('[巡检] 本金跳变全部有解释（交易或修正留痕）');
    }
  }

  async function runOnce() {
    if (running) return; // 上一轮未结束就跳过（行情慢时防重入）
    running = true;
    try {
      const { data, updated_at } = await db.load();
      auditAndWarn(data.daily, data.corrections, data.assets); // 每轮先检：页面不在线也能自动发现漏留痕
      const codes = [
        ...new Set(data.assets.filter((a) => a.asset_type === 'fund').map((a) => a.code)),
      ];
      if (codes.length === 0) return;

      const { quotes, errors } = await fetchQuotes(codes);
      if (errors.length > 0) {
        log(
          `[入账] ${errors.length} 只基金行情获取失败，本次跳过：${errors.map((e) => e.code).join('、')}`,
        );
      }
      const entries = computeArrivalEntries(
        data.assets,
        Object.fromEntries(quotes.map((q) => [q.code, q])),
      );
      if (entries.length === 0) return;

      const y = now().getFullYear();
      // 今去年三年并集：覆盖元旦/跨年两端的净值日与到账日
      const holidays = await fetchHolidays([y - 1, y, y + 1]);
      const { list, changed } = bookArrivals(data.daily, entries, holidays);
      if (!changed) return; // 净值日期均未推进，不落盘

      await db.save(data.assets, updated_at, list);
      log(
        `[入账] 新增 ${list.length - data.daily.length} 条到账记录（${entries.map((e) => e.code).join('、')}）`,
      );
      auditAndWarn(list, data.corrections, data.assets); // 落盘后再检：新行可能引入新的本金跳变
    } catch (e) {
      if (e instanceof ConflictError) {
        log('[入账] 页面正在写入数据，本次跳过（下轮重试）');
        return;
      }
      log(`[入账] 任务失败：${e?.message || e}`);
    } finally {
      running = false;
    }
  }

  async function scheduleNext() {
    if (stopped) return;
    const t = now();
    const ds = localDateStr(t);
    let delay;
    if (windowFn(t) && (await isTradingDay(ds))) {
      delay = intervalMs; // 交易日窗口内：按间隔轮询
    } else {
      // 睡到严格晚于当前时刻的下个交易日 15:00（周末/节假日整体跳过；370 天上限防呆）
      const d = new Date(t);
      d.setHours(15, 0, 0, 0);
      for (
        let guard = 0;
        guard < 370 && (d.getTime() <= t || !(await isTradingDay(localDateStr(d))));
        guard++
      ) {
        d.setDate(d.getDate() + 1);
      }
      delay = Math.max(1, d.getTime() - t);
    }
    timer = setTimeout(async () => {
      try {
        const n = now();
        if (windowFn(n) && (await isTradingDay(localDateStr(n)))) await runOnce();
      } finally {
        scheduleNext();
      }
    }, delay);
    // 不让定时器吊住进程：http 服务才负责保活（测试/异常退出时干净收场）
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    /** 立即补漏跑一轮（服务可能在收盘后才启动），随后进入定时循环 */
    async start() {
      if (started) return stop;
      started = true;
      await runOnce();
      scheduleNext();
      return stop;
    },
    runOnce,
    stop,
  };
}
