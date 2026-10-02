/**
 * 一次性修复：到账口径节假日感知上线前，「只跳周末」的旧口径把 QDII 节前净值记到了假期日
 * （例：2026-09-24（周四）净值 → 09-25 中秋假期当天到账）。
 *
 * 修复规则：date ≠ navDate 的到账行（QDII 形态），到账日按 nextWorkdayOf(navDate, 节假日集合)
 * 重算，与现值不同则改期；国内行（date = navDate）不动。与运行时 bookArrivals 共用同一实现。
 * 冲突保护：目标日期已存在同 code+navDate 记录则跳过并提示，不覆盖。
 * 安全栏：默认 dry-run 只打印计划改动；--apply 才执行，执行前自动备份 db.json（唯一回滚手段）。
 * 节假日数据（chinese-days CDN）拉取失败（空集合）时拒绝运行，避免按错误口径改期。
 *
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from '../lib/database.js';
import { createTradingCalendar } from '../js/tradingCalendar.js';
import { nextWorkdayOf } from '../js/calculator.js';

const apply = process.argv.includes('--apply');

const db = createDatabase({ dataDir: './data' });
const { data, updated_at } = await db.load();
const daily = data.daily || [];

// 节假日数据：覆盖存量 navDate 涉及年份及其相邻年（跨年推进场景）
const calendar = createTradingCalendar();
const years = [
  ...new Set(daily.map((r) => Number(String(r?.navDate || '').slice(0, 4))).filter(Boolean)),
];
const holidays = await calendar.holidaysOfYears(years.flatMap((y) => [y - 1, y, y + 1]));
if (holidays.size === 0) {
  console.error('节假日数据拉取失败（空集合），拒绝运行：避免按「只跳周末」的错误口径改期');
  process.exit(1);
}

// 计划改动：QDII 形态行（date ≠ navDate）按节假日感知口径重算到账日
const planned = [];
for (const r of daily) {
  if (!r || !r.code || r.date == null || r.navDate == null) continue;
  if (r.date === r.navDate) continue; // 国内行不动
  const correct = nextWorkdayOf(r.navDate, holidays);
  if (correct === r.date) continue;
  const conflict = daily.some(
    (x) => x !== r && x.code === r.code && x.navDate === r.navDate && x.date === correct,
  );
  planned.push({ row: r, correct, conflict });
}

if (planned.length === 0) {
  console.log('无需修复：未发现口径偏差的到账行');
  process.exit(0);
}

console.log(`计划改期 ${planned.length} 条：`);
for (const { row, correct, conflict } of planned) {
  console.log(
    `${row.code} ${row.date} → ${correct}（navDate ${row.navDate}）` +
      (conflict ? '［冲突：目标日期已存在同 code+navDate，将跳过］' : ''),
  );
}

if (!apply) {
  console.log('dry-run 完成；加 --apply 执行改期（执行前自动备份）');
  process.exit(0);
}

// 备份（手动快照，独立于每日自动备份；db.json 不在 git 里，备份是唯一回滚手段）
const src = join('./data', 'db.json');
if (!existsSync(src)) {
  console.error('未找到 data/db.json，终止');
  process.exit(1);
}
mkdirSync(join('./data', 'backups'), { recursive: true });
const backupPath = join('./data', 'backups', `db-manual-before-repair-1002-${Date.now()}.json`);
copyFileSync(src, backupPath);
console.log('已备份 →', backupPath);

let moved = 0,
  skipped = 0;
for (const { row, correct, conflict } of planned) {
  if (conflict) {
    skipped++;
    continue;
  }
  row.date = correct;
  moved++;
}
await db.save(data.assets, updated_at, data.daily, data.ai_log);
console.log(`完成：改期 ${moved} 条，跳过 ${skipped} 条`);
