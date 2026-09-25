/**
 * 策略回测工具。
 *
 * 把过去一年的真实净值挂上策略引擎（评估→T+1 净值成交），输出：
 * 1. 触发事件明细（日期/状态/T日净值/T+1成交净值）
 * 2. 策略终值vs全仓死拿vs沪深300标杆（--benchmark传一只指数基金代码做代理）
 * 3. 最大回撤对比、默认参数组vs自定义参数组（db里的strategy_config）对比
 *
 * 简化与已知口径（工具说明）：
 * 1. 窗口内假设用户未做真实交易（以窗口起点快照仓位为初始）；窗口内现金分红未单独计入
 * 2. 赎回费率未建模；沉淀现金按货基 1.5% 年化日计息
 * 3. --add加仓资金按外部注资口径：组合初始现金为 0，加仓金额记负现金（策略终值/曲线已扣减）、负现金不计沉淀利息；
 *   XIRR 现金流只记加仓买入流出、不记外部流入（--add 组的 XIRR 视加仓为自有追加投入，偏保守）
 * 4. Gate：底仓本金口径人工核对完成前，回测结果仅供参数校准参考；--yes表示已知悉
 *
 * 用法（在本项目目录下）：
 *   node tools/backtest-strategy.mjs --yes                    # 全部持仓
 *   node tools/backtest-strategy.mjs --yes --code 110020     # 单只
 *   node tools/backtest-strategy.mjs --yes --benchmark 510300
 *   node tools/backtest-strategy.mjs --yes --add --reserve=3000   # 启用加仓回测（--reserve 缺省按预算上限：起始本金×reserveCap）
 */
import { createDatabase } from '../lib/database.js';
import { createDatasource } from '../lib/datasource.js';
import { evaluateExitStrategy, DEFAULT_STRATEGY_CONFIG } from '../js/strategy.js';
import { computeState } from '../js/calculator.js';

// ---- 参数 ----
// 同时支持 --key=value 与 --key value 两种形式（裸 token 不得被静默丢弃）
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-zA-Z]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) args[m[1]] = m[2];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[m[1]] = argv[++i];
    else args[m[1]] = true;
  }
}
if (!args.yes) {
  console.error(
    'Gate 未确认：底仓本金口径人工核对完成前，回测结果仅供参数校准参考。\n已知悉请加 --yes 重新运行。',
  );
  process.exit(1);
}
const CODE = args.code || null;
const DAYS = Math.min(Number(args.days) || 365, 365);
const BENCH = args.benchmark || null;
const ADD = args.add === true; // --add：回测中启用加仓策略（默认关，加仓为 opt-in）
const RESERVE =
  args.reserve != null && Number.isFinite(Number(args.reserve)) ? Number(args.reserve) : null; // --add 的模拟预留资金
const YEAR_INTEREST = 0.015; // 沉淀现金：货基 1.5% 年化日计息

const db = createDatabase({ dataDir: './data' });
const ds = createDatasource();

/** lsjz 反爬会间歇性返回空列表（分钟级窗口）→ 每基金重试 4 次、退避 5s、基金间小间隔 */
async function fetchHistoryRetry(code, days, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await ds.fetchHistory(code, days);
      console.log(`  [${code}] 第 ${i} 次拉取成功（${r.series.length} 条）`);
      return r.series;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  lastErr.attempts = attempts;
  throw lastErr;
}

/** 历史仓位回放（口径同 tools/migrate-daily-arrival.mjs：snapshot 基线 + 交易回放） */
function stateAt(snapshot, transactions, date) {
  let invested = snapshot.total_invested;
  let shares = snapshot.hold_shares;
  let cost = snapshot.cost_price;
  for (const tx of [...(transactions || [])].sort((a, b) => a.date.localeCompare(b.date))) {
    if (tx.date > date) break;
    if (tx.type === 'buy') {
      invested += tx.amount;
      shares += tx.shares;
    } else if (tx.type === 'sell') {
      invested -= tx.shares * cost;
      shares -= tx.shares;
    } else if (tx.type === 'dividend' && tx.method === 'reinvest') shares += tx.shares;
    cost = shares > 0 ? invested / shares : 0;
  }
  return { invested, shares };
}

/** 单基金回测：返回 { events, curve, final, buyHoldFinal, startShares, startNav, maxDD } */
function walkFund(fund, series, cfg) {
  const start = stateAt(fund.snapshot, fund.transactions, series[0].date);
  let pos = { shares: start.shares, invested: start.invested };
  const startShares = start.shares;
  let cash = 0;
  let cashDays = 0; // 沉淀计息天数（简化：现金余额非零起累计）
  let simState = {};
  const simTxs = []; // 策略模拟成交（T+1）：进 XIRR 现金流——否则分批止盈后卖出回流凭空消失、XIRR 被低估
  const events = [];
  const curve = [];
  const holdCurve = [];
  let ended = false;

  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    if (pos.shares <= 0) {
      curve.push({ date: row.date, value: cash });
      holdCurve.push({ date: row.date, value: startShares * row.nav });
      continue;
    }
    const asset = {
      code: fund.code,
      name: fund.name,
      qdii: /QDII/i.test(fund.name ?? ''),
      shares: pos.shares,
      invested: pos.invested,
      cashDividend: 0,
      nav: row.nav,
      navDate: row.date,
      flows: buildFlows(fund, pos, row, simTxs),
      txBuys: txBuysUpTo(fund, simTxs, row.date), // reserveUsed 归因：真实买入 + 模拟 ADD 成交（无基线流）
    };
    const r = evaluateExitStrategy(asset, series.slice(0, i + 1), cfg, { state: simState });
    simState = { ...r.nextState };

    // 事件执行：T+1 净值成交（末日信号无法成交，仅记录）
    if (r.event && r.state !== 'HOLD' && i + 1 < series.length) {
      const execNav = series[i + 1].nav;
      const execDate = series[i + 1].date;
      if (r.state === 'EXIT') {
        const proceeds = round2(pos.shares * execNav);
        cash += proceeds;
        simTxs.push({ date: execDate, amount: proceeds });
        events.push({
          date: row.date,
          execDate,
          state: 'EXIT',
          shares: pos.shares,
          proceeds,
          nav: row.nav,
          execNav,
          reason: r.snapshot.reasonText,
        });
        pos.shares = 0;
        pos.invested = 0;
        ended = true;
      } else if (r.state === 'TAKE_PROFIT' || r.state === 'STOP_LOSS') {
        const sellShares = pos.shares * r.ratio;
        const proceeds = round2(sellShares * execNav);
        cash += proceeds;
        simTxs.push({ date: execDate, amount: proceeds });
        pos.shares -= sellShares;
        pos.invested -= pos.invested * r.ratio; // 按比例减本金（成本价不变）
        events.push({
          date: row.date,
          execDate,
          state: r.state,
          shares: round2(sellShares),
          proceeds,
          nav: row.nav,
          execNav,
          reason: r.snapshot.reasonText,
        });
        if (r.state === 'TAKE_PROFIT') simState.hwmDate = execDate; // 执行归因：峰值从成交价重计
      } else if (r.state === 'ADD') {
        const buyAmount = r.addAmount ?? 0;
        pos.shares += buyAmount / execNav;
        pos.invested += buyAmount;
        cash -= buyAmount;
        simTxs.push({ date: execDate, amount: -buyAmount });
        events.push({
          date: row.date,
          execDate,
          state: 'ADD',
          amount: buyAmount,
          nav: row.nav,
          execNav,
          reason: r.snapshot.reasonText,
        });
      }
    }

    // 沉淀日计息
    if (cash > 0) {
      const interest = (cash * YEAR_INTEREST) / 365;
      cash += interest;
      cashDays++;
    }
    curve.push({ date: row.date, value: round2(pos.shares * row.nav + cash) });
    holdCurve.push({ date: row.date, value: round2(startShares * row.nav) });
    if (ended) break;
  }

  const lastNav = series[series.length - 1].nav;
  const final = round2(pos.shares * lastNav + cash);
  const buyHoldFinal = round2(startShares * lastNav);
  return {
    events,
    curve,
    holdCurve,
    final,
    buyHoldFinal,
    startShares,
    startNav: series[0].nav,
    lastNav,
    ended,
  };
}

/** XIRR 现金流（全历史口径）：真实交易回放 + 策略模拟成交（amount 带符号）+ 期末市值（K8） */
function buildFlows(fund, pos, row, simTxs = []) {
  const flows = [];
  let invested = fund.snapshot.total_invested;
  let shares = fund.snapshot.hold_shares;
  let cost = fund.snapshot.cost_price;
  for (const tx of [...(fund.transactions || [])].sort((a, b) => a.date.localeCompare(b.date))) {
    if (tx.date > row.date) break;
    if (tx.type === 'buy') {
      invested += tx.amount;
      shares += tx.shares;
      flows.push({ date: tx.date, amount: -tx.amount });
    } else if (tx.type === 'sell') {
      invested -= tx.shares * cost;
      shares -= tx.shares;
      flows.push({ date: tx.date, amount: tx.shares * cost });
    } else if (tx.type === 'dividend' && tx.method !== 'reinvest')
      flows.push({ date: tx.date, amount: Number(tx.amount) || 0 });
    cost = shares > 0 ? invested / shares : 0;
  }
  for (const tx of simTxs) {
    if (tx.date > row.date) continue;
    flows.push({ date: tx.date, amount: tx.amount });
  }
  flows.push({ date: row.date, amount: pos.shares * row.nav }); // K8 期末市值
  return flows;
}

/** reserveUsed归因的纯买入流：真实买入交易+模拟ADD成交（正金额），不含基线本金流与期末市值 */
function txBuysUpTo(fund, simTxs = [], date) {
  const real = (fund.transactions || [])
    .filter((t) => t.type === 'buy' && t.date && t.date <= date && Number(t.amount) > 0)
    .map((t) => ({ date: t.date, amount: Number(t.amount) }));
  const sim = simTxs
    .filter((t) => t.amount < 0 && t.date <= date)
    .map((t) => ({ date: t.date, amount: -t.amount }));
  return real.concat(sim);
}

function maxDrawdown(curve) {
  let peak = -Infinity,
    mdd = 0;
  for (const p of curve) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) mdd = Math.max(mdd, (peak - p.value) / peak);
  }
  return mdd;
}

function groupMaxDD(curves) {
  return Math.max(...curves.map(maxDrawdown));
}

// ---- 主流程 ----
const { data } = await db.load();
const funds = data.assets
  .filter((f) => f.asset_type === 'fund' && computeState(f.snapshot, f.transactions).holdShares > 0)
  .filter((f) => !CODE || f.code === CODE);
if (funds.length === 0) {
  console.error('无可回测的持仓基金', CODE ? `（code=${CODE}）` : '');
  process.exit(1);
}

console.log(`=== 策略回测（近 ${DAYS} 天，T+1 净值成交，沉淀现金 1.5% 年化；费用未建模）===`);
if (ADD)
  console.log(
    `⚠ --add 加仓资金按外部注资口径：记负现金（终值已扣减）、不计息；XIRR 视加仓为自有追加投入（偏保守）`,
  );
console.log(`⚠ Gate：底仓本金口径人工核对若未完成，涉及其本金口径的回测结果仅供参数校准参考\n`);

const report = [];
for (const fund of funds) {
  const st = computeState(fund.snapshot, fund.transactions);
  if (!(st.holdShares > 0)) continue;
  const userCfg = fund.strategy_config || {};
  let defCfg, usrCfg;
  if (ADD) {
    const simReserve = RESERVE ?? round2(st.totalInvested * DEFAULT_STRATEGY_CONFIG.reserveCap);
    if (RESERVE == null)
      console.log(
        `  [${fund.code}] --add 未传 --reserve，按预算上限模拟预留资金 ${simReserve} 元（起始本金 × reserveCap）`,
      );
    defCfg = { ...DEFAULT_STRATEGY_CONFIG, addEnabled: true, reserveCash: simReserve };
    usrCfg = {
      ...DEFAULT_STRATEGY_CONFIG,
      ...userCfg,
      addEnabled: userCfg.addEnabled ?? true,
      reserveCash: userCfg.reserveCash ?? simReserve,
    };
  } else {
    defCfg = { ...DEFAULT_STRATEGY_CONFIG, addEnabled: false };
    usrCfg = { ...DEFAULT_STRATEGY_CONFIG, ...userCfg, addEnabled: userCfg.addEnabled ?? false };
  }
  let series;
  try {
    series = await fetchHistoryRetry(fund.code, DAYS);
  } catch (e) {
    console.error(`[${fund.code}] 净值拉取失败（重试 ${e.attempts ?? 4} 次后）：${e.message}`);
    continue;
  }
  if (series.length < 10) {
    console.error(`[${fund.code}] 序列过短，跳过`);
    continue;
  }

  // 窗口起点无持仓（建仓晚于窗口起点，新导入的基金）→ 跳过并明示：
  // 当前输出全 0 的"策略终值 0 vs 死拿 0"易误读为策略失效，实为窗口内无参考仓位
  if (!(stateAt(fund.snapshot, fund.transactions, series[0].date).shares > 0)) {
    console.log(
      `\n■ ${fund.name}（${fund.code}）窗口起点无持仓（建仓晚于 ${series[0].date}），回测无参考——已跳过`,
    );
    continue;
  }

  const defRun = walkFund(fund, series, defCfg);
  const usrRun = walkFund(fund, series, usrCfg);

  console.log(
    `\n■ ${fund.name}（${fund.code}） 窗口 ${series[0].date} ~ ${series[series.length - 1].date}（起始 ${startSharesStr(defRun.startShares)} 份 @ ${defRun.startNav}）`,
  );
  for (const run of [defRun, usrRun]) {
    const tag = run === defRun ? '默认参数组' : '自定义参数组';
    console.log(`  〔${tag}〕事件 ${run.events.length} 次：`);
    for (const e of run.events)
      console.log(
        `    ${e.date} → ${e.state}${e.shares != null ? ` ${e.shares} 份` : ''}${e.proceeds != null ? `（${e.proceeds} 元）` : ''}${e.amount != null ? ` ${e.amount} 元` : ''}｜T+1 成交 @ ${e.execNav}`,
      );
    console.log(
      `    策略终值 ${run.final} vs 死拿 ${run.buyHoldFinal}（差 ${round2(run.final - run.buyHoldFinal)}）｜最大回撤 ${(groupMaxDD([run.curve]) * 100).toFixed(1)}%（死拿 ${(groupMaxDD([run.holdCurve]) * 100).toFixed(1)}%）`,
    );
  }
  report.push({ name: fund.name, code: fund.code, defRun, usrRun });
}

if (BENCH) {
  try {
    const bSeries = (await ds.fetchHistory(BENCH, DAYS)).series;
    if (bSeries.length > 1) {
      for (const r of report) {
        const benchShares = (r.defRun.startShares * r.defRun.startNav) / bSeries[0].nav;
        const benchFinal = round2(benchShares * bSeries[bSeries.length - 1].nav);
        console.log(
          `\n标杆 ${BENCH}：等额投入终值 ${benchFinal}（${r.name} 死拿 ${r.defRun.buyHoldFinal} / 策略 ${r.defRun.final}）`,
        );
      }
    }
  } catch (e) {
    console.error(`标杆拉取失败：${e.message}`);
  }
}

function startSharesStr(n) {
  return String(n);
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
