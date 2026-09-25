/**
 * 历史本金修正留痕补录（一次性工具；口径 Ⅰ：不改历史到账日志、不改快照，只向data.corrections追加记录）。
 *
 * 适用：用户在「编辑」入口修正过本金，但当时还没有自动留痕
 * （之后的修正由 app.js submitSnapshot 自动记录，不再需要本工具）。
 *
 * 安全设计：
 * 1. 默认dry-run：只打印将追加的记录、以及它会被标注到哪个日志日期；--yes才写库；
 * 2. 写前自动备份db.json → data/backups/db-manual-before-correction-<ts>.json；
 * 3. 自检闸门：先用resolveCorrections验证该记录能被某个日志日期认领（本金值/时序必须对得上），
 *   认领不到即拒绝写入（防止录错金额/日期，落一条永远不会被标注的记录）；
 * 4. 幂等：同code+date+from+to已存在则跳过；
 * 5. 服务端/工具写入的corrections为追加型并集（database.save），旧页面整体保存不会抹掉留痕。
 *
 * 用法（在本项目目录下）：
 *   node tools/backfill-corrections.mjs --code 110020 --date 2026-09-06 --from 144.17 --to 142.84
 *   node tools/backfill-corrections.mjs --code 110020 --date 2026-09-06 --from 144.17 --to 142.84 --yes
 * 注意 `--from/--to` 填生效本金（= 快照基线 + 已记录交易的累计增量，即到账日志 `invested` 的口径），
 *    不是持仓快照里手填的基线值（含交易的基金两者不同，如基线 10000 + 买入 500 → 生效 10500）；
 *    填错口径会被自检闸门拒绝（这正是闸门的作用）。
 * 注意：执行后请刷新所有已打开的页面；页面内存里的旧corrections不会自动更新（留痕本身不会丢，但页面标注要刷新才显示）。
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from '../lib/database.js';
import { computeState } from '../js/calculator.js';
import { resolveCorrections } from '../js/analysis.js';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 极简参数解析：--key value / --flag */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.code || !args.date || args.to === undefined) {
  console.error(
    '参数不足：需 --code <基金代码> --date <修正生效日 YYYY-MM-DD> --to <修正后生效本金> [--from <修正前生效本金>] [--yes]',
  );
  console.error(
    '（--from/--to 是生效本金：快照基线 + 已记录交易增量，即到账日志 invested 的口径；不是快照里手填的基线值）',
  );
  process.exit(1);
}
const record = {
  code: String(args.code),
  field: 'total_invested',
  date: String(args.date),
  from: args.from !== undefined ? round2(args.from) : null,
  to: round2(args.to),
  at: new Date().toISOString(),
};

const db = createDatabase({ dataDir: './data' });
const { data, updated_at } = await db.load();
const daily = Array.isArray(data.daily) ? data.daily : [];
const corrections = Array.isArray(data.corrections) ? data.corrections : [];

const fund = (data.assets || []).find((a) => a.code === record.code);
if (!fund) {
  console.error(`未找到基金 ${record.code}，终止`);
  process.exit(1);
}
const cur = round2(computeState(fund.snapshot, fund.transactions).totalInvested);

// 幂等：同 code+date+from+to 已存在
const dup = corrections.find(
  (c) =>
    c &&
    c.code === record.code &&
    String(c.date) === record.date &&
    round2(c.from) === record.from &&
    round2(c.to) === record.to,
);
if (dup) {
  console.log('已存在同 code+date+from+to 的修正记录，无需重复补录：');
  console.log('  ' + JSON.stringify(dup));
  process.exit(0);
}

// 自检闸门：该记录必须能被某个日志日期认领，否则拒绝（防录错金额/日期）
const probe = resolveCorrections(daily, [...corrections, record]);
const markDates = Object.entries(probe)
  .filter(([, items]) => items.some((x) => x.code === record.code && round2(x.to) === record.to))
  .map(([d]) => d);

console.log(
  `基金：${fund.name}（${record.code}）  当前生效本金：${cur}（= 快照基线 + 已记录交易增量）`,
);
console.log(`将追加修正记录：${JSON.stringify(record)}`);
if (markDates.length === 0) {
  console.error(
    '自检未通过：该记录无法被任何到账日志日期认领（检查 --from/--to 是否与日志中的本金变化一致、--date 是否不晚于变化日）。已拒绝写入。',
  );
  process.exit(2);
}
console.log(`自检通过：将标注到日志日期 ${markDates.join('、')}（日历圆标 + 资产曲线打点）`);

if (args.yes !== true) {
  console.log('（dry-run：未写库。确认无误后加 --yes 执行）');
  process.exit(0);
}

const src = join('./data', 'db.json');
if (!existsSync(src)) {
  console.error('未找到 data/db.json，终止');
  process.exit(1);
}
mkdirSync(join('./data', 'backups'), { recursive: true });
const backupPath = join('./data', 'backups', `db-manual-before-correction-${Date.now()}.json`);
copyFileSync(src, backupPath);
console.log('已备份 →', backupPath);

await db.save(data.assets, updated_at, daily, data.ai_log, [...corrections, record]);
const after = await db.load();
console.log(
  `完成：corrections ${corrections.length} → ${(after.data.corrections || []).length} 条`,
);
console.log('请刷新所有已打开的页面，使图表/日历标注生效。');
