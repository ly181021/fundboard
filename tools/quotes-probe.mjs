/**
 * 行情数据源探针脚本（手工排查用，不属于正式功能代码）
 *
 * 用法：node tools/quotes-probe.mjs [基金代码 ...]   （默认 110020 161017）
 *
 * 验证目标：
 * 1. 天天基金盘中估值fundgz：是否仍返回gsz/gszzl；是否需要Referer
 * 2. 天天基金历史净值lsjz：无/有Referer的行为；字段FSRQ/DWJZ/LJJZ/JZZZL
 * 3. 蛋卷基金（备选源）：详情与历史净值接口
 * 4. push2大盘指数接口
 * 5. 连续请求限频表现
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const codes = process.argv.slice(2);
if (codes.length === 0) codes.push('110020', '161017');

const cut = (s, n = 500) => (s.length > n ? s.slice(0, n) + ` …(共${s.length}字符)` : s);

async function probe(label, url, headers = {}) {
  const t0 = Date.now();
  console.log(`\n=== ${label}`);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    console.log(`HTTP ${res.status} · ${Date.now() - t0}ms · ${text.length} 字符`);
    console.log(cut(text.trim()));
    return { status: res.status, text };
  } catch (e) {
    console.log(
      `FAILED: ${e.name}: ${e.message}${e.cause ? ` / cause: ${e.cause.code || e.cause.message}` : ''}`,
    );
    return { status: 0, text: '' };
  }
}

for (const code of codes) {
  console.log(`\n########## 基金 ${code} ##########`);

  // 1. 天天基金盘中估值（JSONP）
  await probe(
    '1a. fundgz 盘中估值（带 Referer）',
    `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`,
    { Referer: 'https://fund.eastmoney.com/' },
  );
  await probe(
    '1b. fundgz 盘中估值（无 Referer）',
    `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`,
  );

  // 2. 天天基金历史净值
  await probe(
    '2a. lsjz 历史净值（无 Referer）',
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=3`,
  );
  const lsjz = await probe(
    '2b. lsjz 历史净值（带 Referer）',
    `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=3`,
    { Referer: `https://fund.eastmoney.com/f10/jjjz_${code}.html` },
  );
  try {
    const j = JSON.parse(lsjz.text);
    console.log(`   -> 解析: TotalDatas=${j.TotalDatas} 首条=${JSON.stringify(j.LSJZList?.[0])}`);
  } catch {
    /* 原文已打印 */
  }

  // 3. 蛋卷基金（备选源）
  await probe('3a. 蛋卷 基金详情', `https://danjuanfunds.com/djapi/fund/${code}`);
  await probe(
    '3b. 蛋卷 历史净值',
    `https://danjuanfunds.com/djapi/fund/nav/history/${code}?page=1&size=3`,
  );
}

// 4. 大盘指数
await probe(
  '4. push2 大盘指数（沪深300 / 中证500）',
  'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000300,0.399006&fields=f12,f14,f2,f3',
);

// 5. 限频测试：连续 10 次请求fundgz
console.log('\n=== 5. 限频测试：连续 10 次请求 fundgz（110020）');
const results = [];
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://fundgz.1234567.com.cn/js/110020.js?rt=${Date.now()}`, {
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(5000),
    });
    results.push(`${res.status}(${Date.now() - t0}ms)`);
  } catch (e) {
    results.push(`ERR(${e.name})`);
  }
}
console.log(results.join(' '));
