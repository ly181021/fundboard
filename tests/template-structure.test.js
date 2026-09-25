/**
 * 模板结构回归测试（收益页改版后新增）。
 * 动机：一次性补丁脚本曾用「切片替换」改模板，越界删掉了 M2 整卡且未被任何测试发现；
 * 更早还发生过 div 嵌套崩坏。单测只跑纯函数，DOM 层零覆盖，所以这里用零依赖的静态检查兜住这一类：
 *  1) app.js 根模板的 HTML 标签必须闭合且嵌套匹配；
 *  2) 模板内所有 Vue 表达式（插值 / :prop / v-if / v-for 列表 / @event）必须是合法 JS；
 *  3) 收益页的模块卡必须齐全（防止再次被误删）。
 * 说明：真实模板编译校验需要 @vue/compiler-dom（非项目依赖），故此处只做零依赖可复现的部分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

/** 提取根组件模板字面量的内容（去掉首尾定界符） */
function extractTemplate(src) {
  const start = src.indexOf('template: `');
  assert.ok(start >= 0, 'app.js 未找到 template: ` 模板起点');
  const end = src.indexOf('\n});', start);
  assert.ok(end > start, 'app.js 未找到模板结束标记 \\n});');
  const raw = src.slice(start + 'template: `'.length, end);
  const close = raw.lastIndexOf('`');
  assert.ok(close >= 0, '模板缺少收尾反引号');
  return raw.slice(0, close);
}

const tpl = extractTemplate(appSrc);

test('模板结构：HTML 标签全部闭合且嵌套匹配', () => {
  const VOID = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  const stack = [];
  const errors = [];
  const lineOf = (i) => tpl.slice(0, i).split('\n').length;
  for (const m of tpl.matchAll(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g,
  )) {
    const [, close, rawName, , selfClose] = m;
    const name = rawName.toLowerCase();
    if (selfClose === '/' || VOID.has(name)) continue;
    if (close === '/') {
      const top = stack.pop();
      if (!top) errors.push(`L${lineOf(m.index)}: </${name}> 无匹配开标签`);
      else if (top.name !== name)
        errors.push(`L${lineOf(m.index)}: </${name}> 与 <${top.name}>（L${top.line}）不匹配`);
    } else {
      stack.push({ name, line: lineOf(m.index) });
    }
  }
  for (const s of stack) errors.push(`L${s.line}: <${s.name}> 未闭合`);
  assert.deepEqual(errors, [], '模板标签结构异常（多轮插入/切片替换后常见）');
});

test('模板结构：Vue 表达式均为合法 JS', () => {
  const bad = [];
  const checkExpr = (expr, kind) => {
    const e = String(expr).trim();
    if (!e) return;
    try {
      new Function(`return (${e})`);
    } catch (err) {
      bad.push(`[${kind}] ${e} -> ${err.message}`);
    }
  };
  const checkStmt = (code, kind) => {
    const c = String(code).trim();
    if (!c) return;
    try {
      new Function(c);
    } catch (err) {
      bad.push(`[${kind}] ${c} -> ${err.message}`);
    }
  };
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) checkExpr(m[1], 'interp');
  for (const m of tpl.matchAll(/(?:^|\s):([\w-]+)="([^"]*)"/g)) checkExpr(m[2], `:${m[1]}`);
  for (const m of tpl.matchAll(/\sv-(?:if|show|else-if)="([^"]*)"/g)) checkExpr(m[1], 'v-if/show');
  for (const m of tpl.matchAll(/\sv-for="([^"]*)"/g)) {
    const mm = m[1].match(/^([\s\S]+?)\s+in\s+([\s\S]+)$/);
    if (!mm) bad.push(`[v-for] ${m[1]} -> 缺少 in 子句`);
    else checkExpr(mm[2], 'v-for list');
  }
  for (const m of tpl.matchAll(/\s@[\w.-]+="([^"]*)"/g)) checkStmt(m[1], '@event');
  assert.deepEqual(bad, [], 'Vue 表达式语法错误');
});

test('收益页模块卡齐全（防误删：M1/M2/M4/M5/M6/M7/阶段G）', () => {
  const start = tpl.indexOf('class="returns-page"');
  assert.ok(start >= 0, '模板中未找到收益页根容器 .returns-page');
  const page = tpl.slice(start, tpl.indexOf('</a-config-provider>'));
  const required = [
    '收益总览',
    '资产 / 收益走势',
    '当日盈亏归因',
    '收益日历',
    '持仓构成与收益贡献',
    '收益率对比',
    '阶段 G 预留位',
  ];
  const missing = required.filter((t) => !page.includes(t));
  assert.deepEqual(missing, [], `收益页缺少模块卡：${missing.join('、')}`);
  // M2 曲线 canvas 的绘制钩子（函数 ref）必须在模板里挂上，否则 renderReturnsCharts 永远取不到画布
  assert.ok(page.includes('setReturnsCanvasEl'), 'M2 canvas 未挂 setReturnsCanvasEl 函数 ref');
});

test('收益页模板不直接裸取 analysis / returnsStats（空态不得让根组件渲染抛错）', () => {
  const start = tpl.indexOf('class="returns-page"');
  const page = tpl.slice(start, tpl.indexOf('</a-config-provider>'));
  // analysis 在 quoteStatus≠ok / 无持仓时为 null；裸解引用会让整页白屏
  const guarded = /v-if="analysis"/.test(page) || /analysis\?\./.test(page);
  assert.ok(guarded, '收益页缺少 analysis 空值守卫（会整页白屏）');
  const guardedStats = /v-if="returnsStats"/.test(page) || /returnsStats\?\./.test(page);
  assert.ok(guardedStats, '收益页缺少 returnsStats 空值守卫');
});

test('模板引用的根标识符都已在 setup 中暴露（防静默失效：未暴露的 ref 取到 undefined）', () => {
  // 动机：calSelected 未出现在 setup 返回对象里，模板里 `r.navDate !== calSelected` 恒为真，
  // 「净值 MM-DD」小标签的隐藏条件静默失效。这类问题只在 dev 控制台留一条 warning。
  const src = appSrc;
  const anchor = src.lastIndexOf('maskText,');
  const rStart = src.lastIndexOf('return {', anchor);
  assert.ok(rStart > 0, '未定位到 setup 的 return 对象');
  let depth = 0;
  let quote = null;
  let end = -1;
  for (let i = src.indexOf('{', rStart); i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > rStart, 'setup return 对象括号未配对');
  const exposed = new Set(src.slice(rStart, end).match(/[A-Za-z_$][\w$]*/g) || []);

  const locals = new Set();
  for (const m of tpl.matchAll(/\sv-for="([^"]*)"/g)) {
    const mm = m[1].match(/^([\s\S]+?)\s+in\s/);
    if (!mm) continue;
    for (const tok of mm[1].replace(/[()]/g, ' ').split(/[\s,]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(tok)) locals.add(tok);
    }
  }
  for (const m of tpl.matchAll(/(?:#[\w-]*|v-slot(?::[\w-]+)?)="\{([^}]*)\}"/g)) {
    for (const tok of m[1].split(/[\s,]+/)) if (/^[A-Za-z_$][\w$]*$/.test(tok)) locals.add(tok);
  }
  for (const m of tpl.matchAll(/(?:#[\w-]*|v-slot(?::[\w-]+)?)="([A-Za-z_$][\w$]*)"/g))
    locals.add(m[1]);

  const GLOBALS = new Set([
    'Math',
    'Number',
    'String',
    'JSON',
    'Date',
    'Boolean',
    'Object',
    'Array',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'undefined',
    'null',
    'true',
    'false',
    'NaN',
    'Infinity',
  ]);
  const exprs = [];
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.push(m[1]);
  for (const m of tpl.matchAll(/(?:^|\s):([\w-]+)="([^"]*)"/g)) exprs.push(m[2]);
  for (const m of tpl.matchAll(/\sv-(?:if|show|else-if)="([^"]*)"/g)) exprs.push(m[1]);
  for (const m of tpl.matchAll(/\sv-for="([^"]*)"/g)) {
    const mm = m[1].match(/\sin\s([\s\S]+)$/);
    if (mm) exprs.push(mm[1]);
  }
  for (const m of tpl.matchAll(/\s@[\w.-]+="([^"]*)"/g)) exprs.push(m[1]);

  const unknown = new Set();
  for (const e of exprs) {
    const cleaned = e
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/\b[A-Za-z_$][\w$]*:(?!:)/g, '') // 对象字面量的键
      .replace(/\.\s*[A-Za-z_$][\w$]*/g, ''); // 属性访问
    for (const m of cleaned.matchAll(/(?<![\w$.'"])([A-Za-z_$][\w$]*)/g)) {
      const id = m[1];
      if (GLOBALS.has(id) || locals.has(id) || exposed.has(id)) continue;
      unknown.add(id);
    }
  }
  assert.deepEqual([...unknown], [], '模板引用了 setup 未暴露的标识符（会静默取到 undefined）');
});
