// 注释清洗 · tests/ + tools/ 批次抽清单脚本
// 口径：《注释规范》＋《注释清洗.md》第 6 节本仓补充口径
null;
//       AI 腔虚词、阶段/审查编号残留（U1/P0/K8/BUG/R1xx 类）
// 产出：docs/design/2026-09-23-注释清洗清单/tests-tools-清单.json
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'design', '2026-09-23-注释清洗清单');

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) {
    out.push(p);
    return;
  }
  for (const f of fs.readdirSync(p)) walk(path.join(p, f), out);
}

const RE_LIST = /^(\*|\/\/)\s*[-•]\s/;
const RE_NUM = /^(\*|\/\/)\s*\d+\.\s/;
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}]/u;
const RE_DASH = /——/;
const RE_AI = /此外|然而|从而|彰显|赋能|抓手|颗粒度|至关重要/;
const RE_STAGE = /^(\*|\/\/)\s*(U\d|P[012]\b|K8|S\d|E\b|G[0-2]|阶段|批次|BUG-\d|R\d{2,3})\s*[：:]/;

const files = [];
for (const t of ['tests', 'tools']) walk(path.join(ROOT, t), files);
files.sort();

const items = [];
const byFile = {};

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const n = i + 1;
    if (line.startsWith('/*')) inBlock = true;
    const isSlash = line.startsWith('//');
    const isStar = inBlock && line.startsWith('*');
    const isBlockOpen = line.startsWith('/*');
    if (line.endsWith('*/')) inBlock = false;
    if (!isSlash && !isStar && !isBlockOpen) continue;

    const kinds = [];
    if (RE_LIST.test(line)) kinds.push('md-list');
    if (RE_NUM.test(line)) kinds.push('num-list');
    if (RE_EMOJI.test(line)) kinds.push('emoji-review');
    if (RE_DASH.test(line)) kinds.push('dash');
    if (RE_AI.test(line)) kinds.push('ai-word');
    if (RE_STAGE.test(line)) kinds.push('stage-id');

    if (kinds.length > 0) {
      items.push({ file: rel, line: n, kinds, text: raw.replace(/\r$/, '') });
      byFile[rel] = (byFile[rel] || 0) + 1;
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = {
  generated: '2026-09-23',
  scope: ['tests/', 'tools/'],
  rule: '注释规范 + 注释清洗.md §6（md列表/数字列表/emoji/破折号串联/AI腔/阶段编号）',
  total: items.length,
  files: Object.keys(byFile).length,
  byFile,
  items,
};
fs.writeFileSync(
  path.join(OUT_DIR, 'tests-tools-清单.json'),
  JSON.stringify(out, null, 2) + '\n',
  'utf8',
);

const cnt = (k) => items.filter((x) => x.kinds.includes(k)).length;
console.log('范围: tests/ + tools/');
console.log('命中行数:', items.length, '涉及文件:', Object.keys(byFile).length);
console.log(
  '分类: md列表',
  cnt('md-list'),
  '/ 数字列表',
  cnt('num-list'),
  '/ emoji',
  cnt('emoji-review'),
  '/ 破折号',
  cnt('dash'),
  '/ AI腔',
  cnt('ai-word'),
  '/ 阶段编号',
  cnt('stage-id'),
);
console.log('逐文件分布:');
Object.entries(byFile)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log('  ' + k + ' ' + v));
console.log('清单已写入:', path.join(OUT_DIR, 'tests-tools-清单.json'));
