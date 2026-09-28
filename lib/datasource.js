/**
 * 行情数据源适配器（服务端）。fetchFn 可注入（测试用假响应）。
 * 盘中估值：主源天天基金批量接口 FundValuationLast，失败逐只降级新浪
 *   getEstimateNetworthPic；QDII 两源都不给估值，estimate 为 null（前端按净值日期对齐展示）
 * 历史净值：主源天天基金 lsjz（必须带 Referer 头，否则 HTTP 200 但业务码 ErrCode=-999），备源蛋卷
 * 指数：主源东财 push2，备源新浪 hq
 */
import {
  buildQuote,
  clampIndexTimes,
  computeChangePct,
  parseValuationLast,
  parseSinaEstimate,
  parseSinaIndexes,
  parseSinaCurve,
  SINA_INDEX_SPECS,
  INDEX_SESSIONS,
  SPARK_MAX_POINTS,
  sparkMarketOf,
  parseEmTrends,
  parseSinaUsMinutes,
  parseTencentMinutes,
  thinBySegment,
} from './quotes.js';
import { beijingToday } from '../js/marketClock.js'; // 同构模块（lib/snapshot.js 等已有先例）：北京日口径单一来源

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const numOr = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 超时熔断常量：可经 timeouts 注入覆盖（测试用短时长） */
const DEFAULT_TIMEOUTS = {
  quote: 8000,
  lsjzPage: 15000,
  estimate: 8000,
  sina: 8000,
  index: 8000,
  search: 8000,
};

/**
 * undici AbortError / Node AbortSignal.timeout TimeoutError 多态判定（name 或 cause 包装）。
 * @param {Error} err 待判错误
 * @returns {boolean} 是否超时中断
 */
export const isAbortError = (err) =>
  err?.name === 'AbortError' ||
  err?.name === 'TimeoutError' ||
  err?.cause?.name === 'AbortError' ||
  err?.cause?.name === 'TimeoutError';

export function createDatasource({
  fetchFn = fetch,
  now = () => new Date(),
  intervalMs = 200,
  recordSource = () => {},
  timeouts = {},
} = {}) {
  const T = { ...DEFAULT_TIMEOUTS, ...timeouts };
  // 埋点异常吞掉不反噬业务（埋点抛错不影响行情主流程）
  const safeRecord = (...args) => {
    try {
      recordSource(...args);
    } catch {
      /* 静默 */
    }
  };
  /** 带超时熔断的请求：AbortController 触发即抛，与网络错误同走既有降级路径 */
  const fetchText = async (url, headers = {}, timeoutMs = T.quote) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}（${new URL(url).host}）`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 天天基金 lsjz：返回新→旧净值行；业务码异常或无数据时抛错。
   * 注意：该接口现在每页固定只返回 20 条（pageSize 传大也会被截断），
   * 需要更多历史时按 pageIndex 翻页凑满。
   */
  async function lsjzRows(code, pageSize) {
    const rows = [];
    const referer = `https://fund.eastmoney.com/f10/jjjz_${code}.html`;
    for (let pageIndex = 1; pageIndex <= 50; pageIndex++) {
      // 50 页上限防呆
      const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${pageIndex}&pageSize=${pageSize}`;
      const text = await fetchText(url, { Referer: referer }, T.lsjzPage);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('lsjz 响应非 JSON');
      }
      const page = json?.Data?.LSJZList;
      if (!Array.isArray(page) || page.length === 0) break; // 到底了
      rows.push(...page);
      if (rows.length >= pageSize) break;
    }
    if (rows.length === 0) {
      throw new Error(`lsjz 无数据（ErrCode=未知）`);
    }
    return rows.slice(0, pageSize);
  }

  async function eastmoneyQuoteRaw(code) {
    const rows = await lsjzRows(code, 3);
    return {
      code,
      name: null, // lsjz 不含基金名称，前端回退用持仓名称
      navs: rows.map((r) => r.DWJZ),
      navDates: rows.map((r) => r.FSRQ),
      changePcts: rows.map((r) => r.JZZZL),
      estimate: null,
      fetchedAt: now().toISOString(),
      source: 'eastmoney',
    };
  }

  async function danjuanQuoteRaw(code) {
    const text = await fetchText(
      `https://danjuanfunds.com/djapi/fund/nav/history/${code}?page=1&size=3`,
    );
    const json = JSON.parse(text);
    const items = json?.data?.items;
    if (!Array.isArray(items) || items.length === 0) throw new Error('蛋卷无数据');
    return {
      code,
      name: null,
      navs: items.map((i) => i.nav),
      navDates: items.map((i) => i.date),
      changePcts: items.map((i) => i.percentage),
      estimate: null,
      fetchedAt: now().toISOString(),
      source: 'danjuan',
    };
  }

  /** 单只基金最新行情（含最近三个净值日）；所有源失败时抛错。
   *  数据域 = lsjz（基金行情主源 + 蛋卷备源）——健康埋点按"主源成功/备源成功/主备皆败"三态上报。 */
  async function fetchQuote(code) {
    let mainFailed = false;
    let q = null;
    try {
      q = buildQuote(await eastmoneyQuoteRaw(code));
    } catch {
      mainFailed = true; // 主源失败，走备源
    }
    if (q) {
      safeRecord('lsjz', true, null, { fallback: mainFailed });
      return q;
    }
    let fb = null;
    try {
      fb = buildQuote(await danjuanQuoteRaw(code));
    } catch (e) {
      safeRecord('lsjz', false, isAbortError(e) ? new Error('超时: ' + (e.message || e.name)) : e); // 主备皆败
      throw e;
    }
    if (!fb) {
      const e = new Error('所有行情源均无数据');
      safeRecord('lsjz', false, e);
      throw e;
    }
    safeRecord('lsjz', true, null, { fallback: true }); // 备源成功 = 成功的降级
    return fb;
  }

  /**
   * 盘中估值批量：天天基金 FundValuationLast（50 只/批，替代已下线的 fundgz）。
   * 返回 { estimates: code → estimate, noEstimateCodes: [QDII 等无估值品种] }；
   * 接口失败返回空结构（估值失败不影响净值主流程）。
   */
  async function fetchValuationLast(codes) {
    const estimates = {};
    const noEstimateCodes = [];
    const list = (codes || []).filter((c) => /^\d{6}$/.test(c));
    if (list.length === 0) return { estimates, noEstimateCodes };
    let attempted = false;
    let anySuccess = false;
    let firstErr = null;
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      attempted = true;
      const url = `https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast?FCODES=${chunk.join(',')}&FIELDS=${encodeURIComponent('FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE')}`;
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), T.estimate);
      try {
        // 响应体读取（res.json）必须在定时器存活期内——"headers 已回、body 挂起"形态同样被 abort 截断
        const res = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        if (!res.ok) {
          firstErr = firstErr || new Error(`HTTP ${res.status}`);
          continue;
        }
        const parsed = parseValuationLast(await res.json());
        anySuccess = true;
        Object.assign(estimates, parsed.estimates);
        noEstimateCodes.push(...parsed.noEstimateCodes);
      } catch (e) {
        firstErr = firstErr || e; // 含 body 读取阶段超时/网络错误；单批次失败不阻断其余批次
      } finally {
        clearTimeout(tm);
      }
    }
    // 健康埋点：任一批次 HTTP 200 且解析成功 = 源可达（ok）；全部失败才记 fail；无估值品种不算失败
    if (attempted)
      safeRecord(
        'estimate',
        anySuccess,
        firstErr && isAbortError(firstErr)
          ? new Error('超时: ' + (firstErr.message || firstErr.name))
          : firstErr,
      );
    return { estimates, noEstimateCodes };
  }

  /** 新浪估值（单只兜底，无 callback 时接口返回纯 JSON）；失败/无估值返回 null。
   *  健康埋点：HTTP 通即 ok（无估值不算失败）；HTTP/解析失败才记 fail。 */
  async function fetchSinaEstimate(code) {
    const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=${code}`;
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), T.sina);
    try {
      // res.json() 在定时器存活期内——body 挂起同样被 abort 截断
      const res = await fetchFn(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        safeRecord('sina', false, new Error(`HTTP ${res.status}`));
        return null;
      }
      const payload = await res.json();
      const est = parseSinaEstimate(payload, 2) ?? parseSinaEstimate(payload, 3);
      safeRecord('sina', true, null); // 源已通
      return est;
    } catch (e) {
      safeRecord('sina', false, isAbortError(e) ? new Error('超时: ' + (e.message || e.name)) : e);
      return null;
    } finally {
      clearTimeout(tm);
    }
  }

  /**
   * 当天估算曲线（实时估值盘「当天估值走势」用）：与估值兜底同一新浪接口，解析见 lib/quotes.js parseSinaCurve。
   * 只读；失败抛错（由路由转 502），与 fetchSinaEstimate 的"失败返回 null"不同：曲线失败要让用户看到"加载失败"；
   * `today` 由调用方注入（纯函数式，便于单测断言"非当天点被丢弃"）；
   * 曲线只有新浪一源，不做备源；不发健康埋点（`sina` 键专用于估值兜底，混入指数/曲线会串口径）。
   * @param {string} code 基金代码
   * @param {object} opts { today }
   * @returns {Promise<object>} 曲线数据
   */
  async function fetchEstimateCurve(code, { today } = {}) {
    const url = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=${code}`;
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), T.sina);
    try {
      const res = await fetchFn(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}（stock.finance.sina.com.cn）`);
      return parseSinaCurve(await res.json(), today);
    } finally {
      clearTimeout(tm);
    }
  }

  /** 批量行情：逐只请求（间隔 intervalMs 防限频），单只失败记入 errors 不拖垮整批；附带盘中估值 */
  async function fetchQuoteBatch(codes) {
    const quotes = [];
    const errors = [];
    for (let i = 0; i < codes.length; i++) {
      if (i > 0) await sleep(intervalMs);
      const code = codes[i];
      try {
        quotes.push(await fetchQuote(code));
      } catch (e) {
        errors.push({ code, error: String(e.message || e) });
      }
    }
    // 盘中估值：天天基金批量为主；"在场但无估值"（QDII）不再走新浪（新浪对 QDII 的估值滞后失真），
    // 仅对缺席的代码（接口临时失败等）逐只走新浪兜底；估值仅附加，不改变净值主流程
    const got = new Set(quotes.map((q) => q.code));
    const { estimates, noEstimateCodes } = await fetchValuationLast([...got]);
    const noEst = new Set(noEstimateCodes);
    const missing = [...got].filter((c) => !estimates[c] && !noEst.has(c));
    for (let i = 0; i < missing.length; i++) {
      if (i > 0) await sleep(intervalMs);
      const est = await fetchSinaEstimate(missing[i]);
      if (est) estimates[missing[i]] = est;
    }
    for (const q of quotes) q.estimate = estimates[q.code] ?? null;
    return { quotes, errors };
  }

  /** 历史净值（升序）；days 默认 90，上限 365 */
  /** 蛋卷历史净值（fetchHistory 备源）：单次可拉 365 条、免特殊头（实测 node 稳定可达）；无累计净值字段 */
  async function danjuanHistoryRaw(code, days) {
    const text = await fetchText(
      `https://danjuanfunds.com/djapi/fund/nav/history/${code}?page=1&size=${days}`,
    );
    const json = JSON.parse(text);
    const items = json?.data?.items;
    if (!Array.isArray(items) || items.length === 0) throw new Error('蛋卷历史无数据');
    return items; // 新→旧：{ date, nav, percentage, value（实测恒=nav，非累计净值）}
  }

  async function fetchHistory(code, days = 90) {
    const size = Math.min(Math.max(1, Number(days) || 90), 365);
    let rows, source;
    try {
      rows = await lsjzRows(code, size);
      source = 'eastmoney';
      safeRecord('lsjz', true, null); // 主源成功
    } catch (e) {
      // lsjz 反爬指纹封锁（curl 通 node 不通、分钟级窗口）时降级蛋卷。
      // 蛋卷无累计净值 → acc_nav=null，该轮分红检测自动停用（引擎 prepareHistory 对 null acc 跳过）；
      // 每日缓存过期后主源恢复即自动切回。有近期分红的基金在备源轮次可能出现除息假摔，主源恢复后重评即纠正。
      try {
        rows = await danjuanHistoryRaw(code, size);
        source = 'danjuan';
        safeRecord('lsjz', true, null, { fallback: true }); // 备源成功 = 成功的降级
      } catch (e2) {
        safeRecord(
          'lsjz',
          false,
          isAbortError(e2) ? new Error('超时: ' + (e2.message || e2.name)) : e2,
        ); // 主备皆败
        throw e2;
      }
    }
    const asc = [...rows].reverse(); // 新→旧 反转为升序
    const series = asc.map((r, i) => {
      const nav = Number(r.DWJZ ?? r.nav);
      const prev = asc[i - 1];
      return {
        date: r.FSRQ ?? r.date,
        nav,
        acc_nav: r.LJJZ ? Number(r.LJJZ) : null, // 蛋卷行无 LJJZ → null
        change_pct:
          numOr(r.JZZZL) ??
          numOr(r.percentage) ??
          computeChangePct(nav, prev ? Number(prev.DWJZ ?? prev.nav) : null),
      };
    });
    return { code, series, source };
  }

  // 指数主源 push2 熔断：连续失败 PUSH2_TRIP_AFTER 次后暂停重试，期间直接走新浪备源；
  // 冷却结束放行一次探测，成功即复位。冷却时长按失败次数递进翻倍、封顶 6 小时（对端按来源 IP
  // 间歇限流，固定短周期探测易换来更严封锁）。人工重探入口 `/api/index?refresh=1`（同时复位计数）。
  const PUSH2_TRIP_AFTER = 3;
  const PUSH2_COOLDOWN_MS = Math.max(1, Number(process.env.PUSH2_COOLDOWN_MIN || 15)) * 60 * 1000;
  const PUSH2_COOLDOWN_MAX_MS = Math.max(
    PUSH2_COOLDOWN_MS,
    Math.max(1, Number(process.env.PUSH2_COOLDOWN_MAX_MIN || 360)) * 60 * 1000,
  );
  let push2Fails = 0;
  let push2SkipUntil = 0;

  /** 连续失败 `fails` 次时的暂停时长：第 3 次起 15 分钟，之后每次翻倍、封顶（默认 6 小时） */
  const push2CooldownMsOf = (fails) =>
    Math.min(PUSH2_COOLDOWN_MS * 2 ** Math.max(0, fails - PUSH2_TRIP_AFTER), PUSH2_COOLDOWN_MAX_MS);

  /**
   * 复位指数主源熔断（运维入口 `/api/index?refresh=1`）：换出口 IP 后立即重探 push2，不必重启服务。
   */
  function resetIndexBreaker() {
    push2Fails = 0;
    push2SkipUntil = 0;
  }

  /**
   * 大盘指数（11 只：A 股 6 = 上证指数/深证成指/创业板指/科创50/沪深300/中证500；
   * 海外 5 = 纳斯达克100/纳斯达克综合/费城半导体/纳斯达克中国金龙/恒生）。
   * 主源 push2；time = 行情时间戳 f124（秒，休市停在过去时刻）。
   * 坏 secid 的表现是"该只不返回、卡片少一张"，不会出现错数据。
   *
   * 备源新浪 hq：
   * 必须带 Referer: finance.sina.com.cn（无 Referer 返回 Forbidden 空体）；
   * 响应为 GBK 编码，须 arrayBuffer + TextDecoder('gbk')（res.text() 按 UTF-8 解码会乱码）；
   * 代码/名称映射与解析在 lib/quotes.js（SINA_INDEX_SPECS / parseSinaIndexes），返回与 push2 同构；
   * 埋点：主源失败如实记 'push2' 失败；备源新浪的成功/失败记 'sina' 键
   *   （与估值兜底共用一个源键，健康条"新浪备源"一枚）。备源成功不记在 push2 名下，
   *   否则 push2 被封时健康条仍显示"主源正常"（故障不可见）。
   */
  async function fetchIndexes() {
    const t = now().getTime();
    if (t >= push2SkipUntil) {
      try {
        const url =
          'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000300,1.000905,1.000001,0.399001,0.399006,1.000688,100.NDX,100.IXIC,100.SOX,100.HXC,100.HSI&fields=f12,f14,f2,f3,f4,f124';
        const text = await fetchText(url, {}, T.index); // 指数走独立超时键
        const json = JSON.parse(text);
        const diff = json?.data?.diff;
        if (!Array.isArray(diff) || diff.length === 0) throw new Error('指数无数据');
        push2Fails = 0; // 主源恢复 → 计数复位
        safeRecord('push2', true, null); // 主源成功（不带 meta）
        return clampIndexTimes(
          diff.map((d) => ({
            code: String(d.f12),
            name: String(d.f14),
            price: numOr(d.f2),
            change_pct: numOr(d.f3),
            change_amt: numOr(d.f4),
            time: numOr(d.f124),
          })),
        );
      } catch (e) {
        push2Fails += 1;
        const tripped = push2Fails >= PUSH2_TRIP_AFTER;
        const cooldownMs = tripped ? push2CooldownMsOf(push2Fails) : 0;
        if (tripped) push2SkipUntil = t + cooldownMs;
        // 失败如实上报（不把备源成功记在主源名下）；熔断时摘要写明"暂停多久 + 人工重探入口"，健康条悬停可见
        safeRecord(
          'push2',
          false,
          tripped
            ? new Error(
                `连续 ${push2Fails} 次失败，已暂停自动重试 ${Math.round(cooldownMs / 60000)} 分钟（走新浪备源；可点「重试指数源」立即重探）`,
              )
            : isAbortError(e)
              ? new Error('超时: ' + (e.message || e.name))
              : e,
        );
      }
    }
    // 备源新浪：熔断期直接走到这里；成功/失败都记 'sina' 键（健康条"新浪备源"）
    try {
      const out = await sinaIndexes();
      safeRecord('sina', true, null);
      return out;
    } catch (e2) {
      safeRecord(
        'sina',
        false,
        isAbortError(e2) ? new Error('超时: ' + (e2.message || e2.name)) : e2,
      ); // 超时统一标注
      throw e2;
    }
  }

  /**
   * 新浪指数备源：GBK 解码 → parseSinaIndexes；解析出空列表视同失败（源可达但无数据不能当成功埋点）。
   * @returns {Promise<Array>} 指数列表（与 push2 同构）
   */
  async function sinaIndexes() {
    const url = `https://hq.sinajs.cn/list=${SINA_INDEX_SPECS.map((s) => s.varName).join(',')}`; // `$` 必须原样（%24 实测返回空）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), T.index);
    try {
      const res = await fetchFn(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, // 无 Referer → Forbidden
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer()); // GBK 字节流：res.text() 会按 UTF-8 解出乱码
      if (!res.ok) throw new Error(`HTTP ${res.status}（hq.sinajs.cn）`);
      const text = new TextDecoder('gbk').decode(buf);
      const out = parseSinaIndexes(text);
      if (out.length === 0) throw new Error('新浪指数无数据');
      return clampIndexTimes(out);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 基金搜索（东财 fundsuggest）：按名称/代码搜基金，返回候选列表（上限 10 条）。
   * 用途：截图识别的基金不在持仓时，按识别到的名称自动查代码（多图导入自动创建持仓）；
   * 响应校验看内容：ErrCode 非 0 或 Datas 非数组都要抛错，不能只看 HTTP 状态。
   */
  async function fetchFundSearch(key) {
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(key)}`;
    const text = await fetchText(url, {}, T.search); // 搜索走独立超时键
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('基金搜索响应非 JSON');
    }
    if (json?.ErrCode !== 0 || !Array.isArray(json?.Datas)) throw new Error('基金搜索无数据');
    return {
      results: json.Datas.slice(0, 10)
        .map((d) => ({ code: String(d?.CODE ?? ''), name: String(d?.NAME ?? '') }))
        .filter((r) => /^\d{6}$/.test(r.code)),
    };
  }

  /**
   * 按代码批量查官方基金名称（lsjz 行情不含名称，持仓名称回填用）。
   * 逐只走 fundsuggest 搜索（key=代码）并精确匹配 CODE；单只失败/未命中跳过，不拖垮整批。
   */
  async function fetchFundNames(codes) {
    const names = {};
    for (const code of codes) {
      try {
        const { results } = await fetchFundSearch(code);
        const hit = results.find((r) => r.code === code);
        if (hit) names[code] = hit.name;
      } catch {
        // 名称回填失败不影响行情主流程
      }
    }
    return { names };
  }

  /**
   * 核心指数「当天迷你分时」· 按市场取数。
   * cn/hk：东财 `push2his` trends2（主）→ 腾讯 `appstock/app/minute/query`（备），逐只容错。
   *   注意：主机 `push2his.eastmoney.com` 与被限流的 `push2.eastmoney.com` 是两个主机；
   *   `fields1` 必须带全 f1..f13（只给 f1..f4 时响应没有 `preClose`，涨跌幅算不出）；
   *   返回窗口不稳定（可能含 09:15–09:29 集合竞价）→ 解析层按会话段过滤。
   * us：新浪 `US_MinKService.getMinK`（单源，近 3 个交易日取末段）。昨收优先显式值
   *   （同族快照 `gb_$` 的「现价 − 涨跌额」）；取不到才用"前一会话末值"兜底。
   * HXC：该端点无数据 → 标 `no_source`，不发请求。
   * 返回 `{ items, ok }`：`ok` = 至少一只拿到曲线；本函数不抛（网络/解析失败落成该只 `fetch_failed`），
   * 由路由按 `ok` 决定正/负缓存。只读、不落库；缩略图非关键路径，不新增健康条源键，失败只在服务端日志留痕。
   * @param {string} market 'cn' | 'hk' | 'us'
   * @returns {Promise<object>} { items, ok, err? }
   */
  const SPARK_EM_SECID = {
    '000300': '1.000300',
    '000905': '1.000905',
    '000001': '1.000001',
    399001: '0.399001',
    399006: '0.399006',
    '000688': '1.000688',
    HSI: '100.HSI',
  };
  const SPARK_TENCENT_CODE = {
    '000300': 'sh000300',
    '000905': 'sh000905',
    '000001': 'sh000001',
    399001: 'sz399001',
    399006: 'sz399006',
    '000688': 'sh000688',
    HSI: 'hkHSI',
  };
  const SPARK_SINA_US = { NDX: '.ndx', IXIC: '.ixic', SOX: '.sox' };
  const SPARK_NO_SOURCE = new Set(['HXC']);

  /** 东财分时（cn/hk 主源） */
  async function emSpark(secid, segments) {
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' +
      secid +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53&ndays=1';
    return parseEmTrends(JSON.parse(await fetchText(url, {}, T.index)), segments);
  }
  /** 腾讯分时（cn/hk 备源） */
  async function tencentSpark(tcode, segments) {
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + tcode;
    return parseTencentMinutes(JSON.parse(await fetchText(url, {}, T.index)), segments, tcode);
  }
  /** 美股显式昨收（`gb_$` 快照：现价 − 涨跌额）；失败 → null（解析层用前一会话末值兜底） */
  async function sinaUsPreCloses() {
    const specs = SINA_INDEX_SPECS.filter((s) => SPARK_SINA_US[s.code]);
    if (specs.length === 0) return null;
    const url = `https://hq.sinajs.cn/list=${specs.map((s) => s.varName).join(',')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), T.sina);
    try {
      const res = await fetchFn(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer()); // GBK：res.text() 会解出乱码
      if (!res.ok) throw new Error(`HTTP ${res.status}（hq.sinajs.cn）`);
      const text = new TextDecoder('gbk').decode(buf);
      const out = {};
      for (const s of specs) {
        const m = text.match(new RegExp(`hq_str_${s.varName.replace('$', '\\$')}="([^"]*)"`));
        const f = (m?.[1] || '').split(',');
        const price = numOr(f[1]);
        const chgAmt = numOr(f[4]);
        if (price != null && chgAmt != null) out[s.code] = price - chgAmt;
      }
      return Object.keys(out).length ? out : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchIndexSparksForMarket(market) {
    const segments = INDEX_SESSIONS[market] || INDEX_SESSIONS.cn;
    const specs = SINA_INDEX_SPECS.filter((s) => sparkMarketOf(s.code) === market);
    const usPre = market === 'us' ? await sinaUsPreCloses().catch(() => null) : null;
    const items = [];
    for (const s of specs) {
      const item = {
        code: s.code,
        name: s.name,
        market,
        session_date: null,
        pre_close: null,
        last_pct: null,
        spark: null,
        empty_reason: null,
      };
      if (SPARK_NO_SOURCE.has(s.code)) {
        item.empty_reason = 'no_source';
        items.push(item);
        continue;
      }
      try {
        let raw;
        if (market === 'us') {
          const url =
            'https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20t=/US_MinKService.getMinK?symbol=' +
            SPARK_SINA_US[s.code] +
            '&type=1';
          raw = parseSinaUsMinutes(
            await fetchText(url, { Referer: 'https://finance.sina.com.cn/' }, T.sina),
            segments,
            { fallbackPreClose: usPre?.[s.code] ?? null },
          );
          // 昨收以"前一日分组的末值"为准（见 parseSinaUsMinutes 头注）；`gb_` 显式值只作兜底：
          // 美股开盘前上游把「涨跌额」清零，`现价 − 涨跌额` 会算成会话自身收盘、曲线塌成 0。
        } else {
          try {
            raw = await emSpark(SPARK_EM_SECID[s.code], segments);
          } catch {
            raw = await tencentSpark(SPARK_TENCENT_CODE[s.code], segments); // 备源
          }
        }
        const spark = thinBySegment(raw.rows, segments, {
          total: SPARK_MAX_POINTS,
          preClose: raw.preClose,
        });
        if (spark.length < 2) throw new Error('分时点不足');
        item.session_date = market === 'us' ? (raw.sessionDate ?? null) : beijingToday(now());
        item.pre_close = raw.preClose;
        item.last_pct = spark[spark.length - 1][1];
        item.spark = spark;
      } catch (e) {
        item.empty_reason = 'fetch_failed';
        try {
          console.error(
            `[index-spark] ${market}/${s.code} 取数失败：${String(e?.message || e).slice(0, 120)}`,
          );
        } catch {
          /* 静默 */
        }
      }
      items.push(item);
    }
    return { items, ok: items.some((i) => Array.isArray(i.spark) && i.spark.length >= 2) };
  }

  return {
    fetchQuote,
    fetchQuoteBatch,
    fetchValuationLast,
    fetchSinaEstimate,
    fetchEstimateCurve,
    fetchHistory,
    fetchIndexes,
    fetchIndexSparksForMarket,
    fetchFundSearch,
    fetchFundNames,
    resetIndexBreaker,
  };
}
