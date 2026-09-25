/**
 * 一次性修复：到账日志切标准口径 A 之前，周末补拉把国内基金
 * 09-04（周五）净值记到了 09-05（周六）：运行时旧口径"到账日=实际拉取日"的遗留脏数据。
 *
 * 修复规则：date='2026-09-05' 且 navDate='2026-09-04' 的记录改期 date → '2026-09-04'
 * （口径 A：国内基金到账日 = 净值日）；QDII 记录不动（navDate 已正确）。
 * 冲突保护：目标日期已存在同 code+navDate 记录则跳过并提示，不覆盖。
 * 跑前自动备份 db.json → data/backups/db-manual-before-repair-0905-<ts>.json，失败即终止。
 *
 * 用法（在本项目目录下）：node tools/repair-daily-0905.mjs
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from '../lib/database.js';

const db = createDatabase({ dataDir: './data' });
const { data, updated_at } = await db.load();
const daily = data.daily || [];

// 备份（手动快照，独立于每日自动备份；db.json 不在 git 里，备份是唯一回滚手段）
const src = join('./data', 'db.json');
if (!existsSync(src)) {
  console.error('未找到 data/db.json，终止');
  process.exit(1);
}
mkdirSync(join('./data', 'backups'), { recursive: true });
const backupPath = join('./data', 'backups', `db-manual-before-repair-0905-${Date.now()}.json`);
copyFileSync(src, backupPath);
console.log('已备份 →', backupPath);

const target = new Set(
  daily.filter((r) => r.date === '2026-09-04').map((r) => `${r.code}|${r.navDate}`),
);
let moved = 0,
  skipped = 0;
for (const r of daily) {
  if (r.date !== '2026-09-05' || r.navDate !== '2026-09-04') continue;
  const key = `${r.code}|${r.navDate}`;
  if (target.has(key)) {
    console.log('冲突跳过（已存在同 code+navDate）:', r.code);
    skipped++;
    continue;
  }
  console.log(`改期: ${r.code} 09-05 → 09-04（earnings ${r.earnings}）`);
  r.date = '2026-09-04';
  target.add(key);
  moved++;
}

if (moved === 0) {
  console.log('无需修复：未发现目标记录');
  process.exit(0);
}
await db.save(data.assets, updated_at, data.daily, data.ai_log);
console.log(`完成：改期 ${moved} 条，跳过 ${skipped} 条`);
