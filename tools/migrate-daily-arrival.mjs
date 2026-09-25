/**
 * 一次性迁移：data.daily 从"组合级快照"迁移为"逐基金到账收益日志"。
 *
 * 到账口径（用户确认）：净值数据本身归属净值日（业绩走势层），
 * 由它算出的持仓盈亏记录归属"数据拉取到账的日期"（收益台账层）。
 * 存量重建采用标准公布时刻假设：国内基金 = 净值日当晚到账；QDII = 下一工作日到账。
 *
 * 用法（在本项目目录下）：node tools/migrate-daily-arrival.mjs
 * 依赖：lib/datasource 直连天天基金 lsjz 取历史净值（无需服务在跑）。
 */
import { createDatabase } from '../lib/database.js';
import { createDatasource } from '../lib/datasource.js';
import { computeState } from '../js/calculator.js';
import { parseISODate, isoDate, addDays } from '../js/analysis.js';

const round2 = (v) => Math.round(v * 100) / 100;
const FROM = '2026-08-28'; // 重建起点（最早净值日）
const TO = '2026-09-03'; // 含今天（QDII 9.2 净值今日到账）

const db = createDatabase({ dataDir: './data' });
const { data, updated_at } = await db.load();
const ds = createDatasource();

/** 回放交易到指定日期，得到 {invested, shares}（口径与 computeState 一致） */
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
      invested -= tx.shares * cost; // 卖出本金按卖出时成本价反推
      shares -= tx.shares;
    } else if (tx.type === 'dividend' && tx.method === 'reinvest') {
      shares += tx.shares;
    }
    cost = shares > 0 ? invested / shares : 0;
  }
  return { invested, shares };
}

const isQdii = (name) => /QDII/i.test(name ?? '');

/** 到账日：国内 = 净值日当天；QDII = 下一工作日（任务窗口只跑工作日） */
function arrivalOf(navDate, qdii) {
  if (!qdii) return navDate;
  let d = addDays(parseISODate(navDate), 1);
  while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
  return isoDate(d);
}

const log = [];
for (const a of data.assets.filter((x) => x.asset_type === 'fund')) {
  const cur = computeState(a.snapshot, a.transactions);
  if (cur.holdShares <= 0) continue;
  const h = await ds.fetchHistory(a.code, 60);
  const full = h.series.filter((s) => s.nav != null && s.date);
  const qdii = isQdii(a.name);
  for (let i = 0; i < full.length; i++) {
    const s = full[i];
    if (s.date < FROM || s.date > TO) continue;
    const prev = full[i - 1];
    if (!prev) continue; // 无前一日净值则无法算变动
    const arrival = arrivalOf(s.date, qdii);
    const st = stateAt(a.snapshot, a.transactions, arrival);
    log.push({
      code: a.code,
      date: arrival,
      navDate: s.date,
      earnings: round2(st.shares * (s.nav - prev.nav)),
      invested: round2(st.invested),
      assets: round2(st.shares * s.nav),
    });
  }
}
log.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));

// 打印迁移结果与按日汇总供核对
const byDate = {};
for (const r of log) byDate[r.date] = round2((byDate[r.date] ?? 0) + r.earnings);
console.log('迁移后日志（条）：', log.length);
for (const r of log)
  console.log(
    ' ',
    r.date,
    r.code,
    'navDate=' + r.navDate,
    'earnings=' + r.earnings,
    'invested=' + r.invested,
    'assets=' + r.assets,
  );
console.log('按日收益汇总：');
for (const d of Object.keys(byDate).sort()) console.log(' ', d, byDate[d]);

await db.save(data.assets, updated_at, log, data.ai_log);
console.log('已保存（走正常备份与乐观锁流程）');
