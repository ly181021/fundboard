/**
 * 定时快照探测（只读，不写任何文件）：抓真实行情，按 lib/snapshot.js 同口径
 * 计算快照记录，并与 data/db.json 现有 daily 对比，排查"任务不落盘"类问题。
 *
 * 用法：node tools/snapshot-probe.mjs
 */
import { readFile } from 'node:fs/promises';
import { createDatasource } from '../lib/datasource.js';
import { computeSnapshotRecord, upsertRecord } from '../lib/snapshot.js';

const db = JSON.parse(await readFile(new URL('../data/db.json', import.meta.url), 'utf8'));
const funds = (db.assets || []).filter((a) => a.asset_type === 'fund');
console.log(`持仓基金：${funds.map((a) => `${a.name}(${a.code})`).join('、') || '无'}`);

const { quotes, errors } = await createDatasource().fetchQuoteBatch([
  ...new Set(funds.map((a) => a.code)),
]);
for (const e of errors) console.log(`行情失败：${e.code} ${e.error}`);
for (const q of quotes)
  console.log(`行情 ${q.code}：nav=${q.nav} nav_date=${q.nav_date}（${q.source}）`);

const record = computeSnapshotRecord(db.assets, Object.fromEntries(quotes.map((q) => [q.code, q])));
if (!record) {
  console.log('本次未生成记录（缺行情或净值日期不一致），任务会跳过等待下轮。');
} else {
  console.log(`计算记录：${JSON.stringify(record)}`);
  const { list, changed } = upsertRecord(db.daily, record);
  if (!changed) console.log('与库内现有记录一致 → 任务不会重复落盘。');
  else {
    const old = (db.daily || []).find((d) => d.date === record.date);
    console.log(`与库内记录不同（库内：${old ? JSON.stringify(old) : '无'}）→ 任务将写入/覆盖。`);
    console.log(`写入后 daily 共 ${list.length} 条。`);
  }
}
