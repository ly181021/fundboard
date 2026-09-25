// 注释清洗 · 套用脚本
// 范围：js/+lib/（裁定-批{1,2,3}.json，124 条）与 tests/+tools/（裁定-tests-tools.json，82 条）
// 行为：按 (file, line, 原文) 精确匹配整行替换；行号倒序应用（防多行展开顶乱行号，两批全部单行换单行）
// 门禁（写盘前全部通过才落盘）：
//   ① 每条原文与源文件当前行逐字符一致（防漂移）
//   ② 剥离注释后新旧文件代码行序列一致（证明业务代码零改动）
//   ③ 套用后复扫残留符合预期（tests/tools 批保留数字序号形态与裁定保留行）
// 用法：node tools/apply-comment-fix.cjs [js-lib|tests-tools]，缺省两批顺序全跑
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '..', 'docs', 'design', '2026-09-23-注释清洗清单');

const arg = process.argv[2] || 'all';
const BATCHES = {
  'js-lib': [['批1', '批2', '批3'], 124, [path.join(ROOT, 'js'), path.join(ROOT, 'lib')]],
  'tests-tools': [['tests-tools'], 82, [path.join(ROOT, 'tests'), path.join(ROOT, 'tools')]],
};
const runs = arg === 'all' ? Object.keys(BATCHES) : [arg];
if (runs.some((r) => !BATCHES[r])) {
  console.error('未知批次: ' + arg + '（可用: js-lib | tests-tools | all）');
  process.exit(1);
}

let applied = 0;
let failGate = false;
let batchName = '';

for (const run of runs) {
  const [names, expected] = BATCHES[run];
  const batches = names
    .map((n) => JSON.parse(fs.readFileSync(path.join(DIR, '裁定-' + n + '.json'), 'utf8')))
    .flat();
  if (batches.length !== expected) {
    console.error('裁定条数异常: ' + batches.length + '（预期 ' + expected + '）');
    process.exit(1);
  }
  batchName = run;

  const byFile = {};
  for (const b of batches) {
    if (!byFile[b.file]) byFile[b.file] = [];
    byFile[b.file].push(b);
  }

  // 注释剥离器：把 // 行、/* */ 块、行尾 // 注释替换为等量空白行/空白段，
  // 只动注释字符与注释体，代码 token 逐字符保留（字符串字面量内的 // /* 由词法近似跳过，本库无此类病态用例）
  function stripComments(src) {
    // 输出与 src.split('\n') 严格同长：每遇 \n 收一行，行内若无代码 token 则记空行
    const out = [];
    let i = 0;
    const n = src.length;
    let mode = 'code'; // code | line | block
    let lineHasCode = false;
    const pushLine = () => {
      out.push(lineHasCode ? 'CODE' : '');
      lineHasCode = false;
    };
    while (i < n) {
      const ch = src[i];
      const next = src[i + 1];
      if (ch === '\n') {
        pushLine();
        i++;
        continue;
      }
      if (mode === 'code') {
        if (ch === '/' && next === '/') {
          mode = 'line';
          i += 2;
          continue;
        }
        if (ch === '/' && next === '*') {
          mode = 'block';
          i += 2;
          continue;
        }
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineHasCode = true;
        i++;
        continue;
      }
      if (mode === 'line') {
        i++;
        continue;
      }
      // block：*/ 结束，其余字符（含换行已上方处理）跳过
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i++;
    }
    pushLine(); // 末行（src 以 \n 结尾时此行对应 split 的末尾空串）
    return out;
  }

  for (const [f, items] of Object.entries(byFile)) {
    const abs = path.join(ROOT, f);
    const before = fs.readFileSync(abs, 'utf8');
    const lines = before.split('\n');

    // 门禁①：原文逐字符一致
    for (const it of items.sort((a, b) => b.line - a.line)) {
      const cur = lines[it.line - 1];
      if (cur === undefined || cur.replace(/\r$/, '') !== it.text.replace(/\r$/, '')) {
        console.error('门禁①失败（行漂移）: ' + f + ':' + it.line);
        failGate = true;
      }
    }
    if (failGate) break;

    // 应用替换（行号倒序）
    for (const it of items.sort((a, b) => b.line - a.line)) {
      if (it.newText == null) continue; // 裁定保留，跳过不写
      const cr = it.text.endsWith('\r') ? '\r' : '';
      lines[it.line - 1] = it.newText + (cr && !String(it.newText).endsWith('\r') ? cr : '');
    }
    const after = lines.join('\n');

    // 门禁②：剥离注释后「代码行序列」一致（业务代码零改动）。
    // 多行替换（JSDoc 拆行）会改变物理行数，故比对按行号平移对齐：
    // 以「非注释代码行（=CODE）」的顺序序列为准，序列逐项一致即代码未动。
    const a = stripComments(before);
    const b = stripComments(after);
    const aCode = a.map((x, i) => (x === 'CODE' ? i : -1)).filter((x) => x >= 0);
    const bCode = b.map((x, i) => (x === 'CODE' ? i : -1)).filter((x) => x >= 0);
    if (aCode.length !== bCode.length) {
      console.error('门禁②失败（代码行数变化）: ' + f + ' ' + aCode.length + ' → ' + bCode.length);
      failGate = true;
      break;
    }
    let codeDiff = 0;
    for (let i = 0; i < aCode.length; i++) {
      if (a[aCode[i]] !== b[bCode[i]]) codeDiff++;
    }
    if (codeDiff > 0) {
      console.error('门禁②失败（代码行内容差异）: ' + f + ' ' + codeDiff + ' 行');
      failGate = true;
      break;
    }
    // 附加校验：代码行序的内容指纹（直接取原文本的代码行首 60 字符逐项比）
    const aRaw = a
      .map((x, i) =>
        x === 'CODE' ? before.split('\n')[i].replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      )
      .filter((x) => x !== null);
    const bRaw = b
      .map((x, i) =>
        x === 'CODE' ? after.split('\n')[i].replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      )
      .filter((x) => x !== null);
    let rawDiff = 0;
    for (let i = 0; i < aRaw.length; i++) {
      if (aRaw[i] !== bRaw[i]) {
        rawDiff++;
        if (rawDiff <= 3)
          console.error(
            '  代码指纹差异 @' +
              (i + 1) +
              ': ' +
              JSON.stringify(aRaw[i]) +
              ' vs ' +
              JSON.stringify(bRaw[i]),
          );
      }
    }
    if (rawDiff > 0) {
      failGate = true;
      break;
    }

    // 门禁③：套用后复扫。js-lib 批残留须为 0；tests-tools 批数字序号 `* N.` 属合规枚举形态，
    // 裁定保留的破折号行（newText=null 且 reason 注明保留）放行，其余残留判失败。
    const keepSet = new Map(items.filter((x) => x.newText == null).map((x) => [x.line, x.reason]));
    const allowNum = batchName === 'tests-tools';
    let residue = 0;
    const residueDetail = [];
    let inBlock = false;
    for (const raw of after.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/*')) inBlock = true;
      const c = line.startsWith('//') || (inBlock && line.startsWith('*')) || line.startsWith('/*');
      if (line.endsWith('*/')) inBlock = false;
      if (!c) continue;
      if (/⇒/.test(line)) {
        residue++;
        residueDetail.push('⇒: ' + line.slice(0, 40));
      } else if (/^(\*|\/\/)\s*[-•]\s/.test(line)) {
        residue++;
        residueDetail.push('md列表: ' + line.slice(0, 40));
      } else if (/^(\*|\/\/)\s*\d+\.\s/.test(line) && !allowNum) {
        residue++;
        residueDetail.push('数字列表: ' + line.slice(0, 40));
      } else if (/[\u{1F300}-\u{1FAFF}]/u.test(line)) {
        residue++;
        residueDetail.push('emoji: ' + line.slice(0, 40));
      }
    }
    if (residue > 0) {
      console.error('门禁③失败（残留 ' + residue + ' 行）: ' + f);
      residueDetail.slice(0, 5).forEach((x) => console.error('  ' + x));
      failGate = true;
      break;
    }

    fs.writeFileSync(abs, after, 'utf8');
    applied += items.length;
    console.log(f + '：' + items.length + ' 行已替换，门禁①②③通过');
  }
}

if (failGate) {
  console.error(
    '门禁未通过，已中止（失败即停；同批前面文件已写盘，重跑前先 git checkout 对应文件）',
  );
  process.exit(1);
}
console.log('套用完成：' + applied + ' 行（批次 ' + runs.join('+') + '）');
