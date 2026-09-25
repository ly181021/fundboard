/**
 * 静态守卫：不许有"死导入"（import 了却没在文件里用过）。
 *
 * 为什么单独守这一条：本项目零构建、零 lint，ESM 具名导入拼错或改用别的函数后忘了删，
 * 不会有任何运行时症状（node --check 与单测都放行），只会在 import 列表里越积越脏。
 * 同族的"漏 return setup 绑定"（模板用了但没 return）已由浏览器回归兜底，本条是它的静态补充。
 *
 * 判定：逐个 ESM 具名导入（含 `as` 别名取本地名）统计标识符在整文件（含模板字符串）中的出现次数，
 * 出现 1 次 = 只有 import 行本身 = 死导入。词边界匹配保证 buildPrincipalCorrection 不会误命中 principalCorrection。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath 必需：仓库路径含中文，URL.pathname 会是百分号编码（%E7%90%86%E8%B4%A2）导致 scandir ENOENT
const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;

function deadImports(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const dead = [];
  for (const m of src.matchAll(NAMED_IMPORT_RE)) {
    for (const raw of m[1].split(',')) {
      const local = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (!local) continue;
      const hits = (src.match(new RegExp(`\\b${local}\\b`, 'g')) || []).length;
      if (hits <= 1) dead.push(local);
    }
  }
  return dead;
}

test('静态守卫：源码目录无死导入（import 了必须至少被用一次）', () => {
  const files = ['js', 'lib', 'tools', 'tests'].flatMap((d) => walk(join(ROOT, d)));
  assert.ok(files.length > 30, `扫描文件数异常：${files.length}`); // 防路径写错导致"空集通过"
  const offenders = [];
  for (const f of files) {
    for (const name of deadImports(f)) offenders.push(`${f.slice(ROOT.length)}: ${name}`);
  }
  assert.deepEqual(offenders, [], `发现死导入（删掉或补上调用点）：\n${offenders.join('\n')}`);
});
