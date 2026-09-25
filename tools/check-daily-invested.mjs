/**
 * 只读巡检（口径 Ⅰ：历史到账日志不可变，本金修正只留痕）。
 *
 * 判定逻辑在js/analysis.js的auditPrincipalJumps，与服务端定时巡检（lib/snapshot.js每轮入账后）
 * 和页面"未留痕"徽标共用同一份实现，防口径漂移；本工具只负责"读库 + 打印报告"，零副作用（不改库、不写文件）。
 *
 * 目标问题：到账日志里某只基金的invested在相邻两条之间跳变，但该窗口内没有任何交易，只可能来自
 * "手动改了本金"，口径 Ⅰ 要求这种跳变必须有 corrections 留痕（否则日历/曲线会把它当普通交易，无法解释）。
 *
 * 用法（在本项目目录下）：node tools/check-daily-invested.mjs [--json]
 */
import { createDatabase } from '../lib/database.js';
import { computeState } from '../js/calculator.js';
import { auditPrincipalJumps } from '../js/analysis.js';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const asJson = process.argv.includes('--json');

const db = createDatabase({ dataDir: './data' });
const { data } = await db.load();
const daily = Array.isArray(data.daily) ? data.daily : [];
const corrections = Array.isArray(data.corrections) ? data.corrections : [];
const funds = (data.assets || []).filter((a) => a.asset_type === 'fund');

/** 与判定共用同一实现（服务端定时巡检/页面徽标同源） */
const { jumps, unexplained } = auditPrincipalJumps(daily, corrections, data.assets);

/** 尾部对齐（本工具特有视图）：日志最新一条 invested vs 当前快照本金 */
const tail = funds.map((f) => {
  const list = daily
    .filter((r) => r && r.code === f.code && r.date && r.invested != null)
    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const cur = round2(computeState(f.snapshot, f.transactions).totalInvested);
  const name = f.name ? `${f.name}(${f.code})` : f.code;
  if (list.length === 0)
    return {
      code: f.code,
      name,
      current: cur,
      logDate: null,
      logInvested: null,
      status: '无到账日志',
    };
  const last = list[list.length - 1];
  const logInvested = round2(last.invested);
  return {
    code: f.code,
    name,
    current: cur,
    logDate: last.date,
    logInvested,
    status: logInvested === cur ? '一致' : '未入账差异（下次入账修正）',
  };
});

if (asJson) {
  console.log(JSON.stringify({ jumps, unexplained, tail, corrections }, null, 2));
  process.exit(0);
}

const clip = (s, n) => String(s).slice(0, n).padEnd(n);
console.log('本金一致性巡检（只读）  data/db.json');
console.log('─'.repeat(96));
console.log('【1】本金跳变清单（相邻到账日志行 invested 变化）');
if (jumps.length === 0) console.log('  （无本金跳变）');
for (const j of jumps) {
  console.log(
    `  ${clip(j.name, 22)} ${String(j.date).padEnd(11)} ${`${j.from} → ${j.to}`.padStart(21)}  窗口内交易 ${j.txCount} 笔   ${j.status}`,
  );
}
console.log('─'.repeat(96));
console.log('【2】未留痕跳变（无交易解释且无 corrections 认领 → 需补录）');
if (unexplained.length === 0) console.log('  （无：所有非交易跳变均有修正留痕）');
for (const j of unexplained) {
  console.log(
    `  ${j.name}  ${j.date}  ${j.from} → ${j.to}   建议：node tools/backfill-corrections.mjs --code ${j.code} --date <修正生效日> --from ${j.from} --to ${j.to} --yes`,
  );
}
console.log('─'.repeat(96));
console.log('【3】尾部对齐（日志最新一条 vs 当前快照本金）');
for (const t of tail) {
  console.log(
    `  ${clip(t.name, 22)} 当前 ${String(t.current).padStart(10)} 日志 ${String(t.logInvested ?? '—').padStart(10)} ${String(t.logDate ?? '—').padEnd(11)} ${t.status}`,
  );
}
console.log('─'.repeat(96));
console.log(
  `修正留痕：${corrections.length} 条（其中 ${jumps.filter((j) => j.claimed).length} 条已在日志中认领）｜未留痕跳变：${unexplained.length} 处`,
);
console.log(
  '（口径 Ⅰ：历史日志的 invested 是当时本金快照，与当前本金不同属正常；本巡检只追究"无交易解释的本金跳变是否有留痕"）',
);
console.log(
  '（同一判定已内置于服务端：每轮入账后自动巡检并写日志，页面资产总览在检出时显示"本金跳变未留痕"徽标）',
);
