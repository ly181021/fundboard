import http from 'node:http';
import dns from 'node:dns';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createCache } from './lib/cache.js';
import { createDatasource } from './lib/datasource.js';
import { createDatabase, ConflictError } from './lib/database.js';
import { createSnapshotTask } from './lib/snapshot.js';
import { createStrategyStore } from './lib/strategyStore.js';
import { createStrategyTask } from './lib/strategyTask.js';
import { createSourceHealth } from './lib/sourceHealth.js';
import { loadOcrConfig, createOcrClient, createAnalysisClient } from './lib/ocr.js';
import { networkInterfaces } from 'node:os';
import { sparkCoversSession } from './lib/quotes.js';
import {
  beijingToday,
  beijingMinutes,
  cnIndexWindowOpen,
  hkIndexWindowOpen,
  usIndexWindowOpen,
  cnMarketPhase,
  hkMarketPhase,
} from './js/marketClock.js';

// AAAA记录：DNS用于返回IPv6地址的解析记录；该域名属于双栈域名同时返回IPv4(A记录)、IPv6(AAAA记录)。
// 本机IPv6出口路由异常，undici不会像curl执行happy‑eyeballs自动回退，优先AAAA会直接连接挂死UND_ERR_SOCKET。
// 全局配置全进程IPv4优先解析，强制优先选用A记录，规避该网络缺陷。
dns.setDefaultResultOrder('ipv4first');

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.PORT || 8123; // 默认端口固定 8123，PORT 环境变量可覆盖
const HOST = process.env.HOST || '127.0.0.1';
const APP_TOKEN = process.env.APP_TOKEN || '';
// 数据目录可用环境变量覆盖（联调/测试指向临时副本，避免动真实 db.json）
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
// 配置路径可用环境变量覆盖（联调/测试指向临时配置，避免误动真实 key）
const OCR_CONFIG_PATH = process.env.OCR_CONFIG_PATH || join(ROOT, 'ocr.config.json');
// AI 解读请求超时（毫秒）：网关/网络挂住时的兜底，默认 60s，ANALYSIS_TIMEOUT_MS 可覆盖
const ANALYSIS_TIMEOUT_MS = Number(process.env.ANALYSIS_TIMEOUT_MS) || 60000;
// push2 熔断冷却（分钟）：基准 15 起每次失败翻倍、封顶 360（6 小时），注入 createDatasource
const PUSH2_COOLDOWN_MIN = process.env.PUSH2_COOLDOWN_MIN || 15;
const PUSH2_COOLDOWN_MAX_MIN = process.env.PUSH2_COOLDOWN_MAX_MIN || 360;

// 局域网暴露必须配 token，防止财务数据在内网暴露
if (HOST === '0.0.0.0' && !APP_TOKEN) {
  console.error('监听 0.0.0.0（局域网访问）必须同时设置 APP_TOKEN，例如：');
  console.error('  set HOST=0.0.0.0 && set APP_TOKEN=你的口令 && npm start');
  console.error('若仅本机使用，去掉 HOST 环境变量即可（默认只监听 127.0.0.1）。');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- 行情 API：静态托管 + 行情代理，/api/* 在静态文件分支前拦截 ----
// 数据源健康：recordSource 埋点 → source_health.json（服务端单写方，写隔离红线）
const sourceHealth = createSourceHealth({ dataDir: DATA_DIR });
const datasource = createDatasource({
  push2CooldownMin: PUSH2_COOLDOWN_MIN,
  push2CooldownMaxMin: PUSH2_COOLDOWN_MAX_MIN,
  recordSource: (key, ok, err, meta) => {
    sourceHealth.record(key, ok, err, meta).catch(() => {});
  }, // 埋点失败不反噬业务
});
const apiCache = createCache();

// 实时估值盘「当天估值走势」：手动刷新（?force=1）的按 code 冷却（进程内，重启即清）
const CURVE_FORCE_COOLDOWN_MS = 5 * 1000;
const curveForcedAt = new Map();

// 指数源手动重试接口 /api/index?refresh=1，按来源做冷却，该接口变体不配置访问口令。
// 不配置口令的依据同 /api/estimate-curve?force=1。公开行情路由增加口令校验会引发界面死循环。
// 口令补全弹窗仅适配 /api/data，对应store.js authRequired，重试操作路径不存在口令补全入口。
// 防滥用采用按来源5秒冷却。冷却期重复refresh请求降级读取缓存，返回200，不会返回401。
const INDEX_FORCE_COOLDOWN_MS = 5 * 1000;
let indexForcedAt = 0;

// 核心指数「当天迷你分时」：按市场拆子缓存 + 按市场粒度 SingleFlight。
// 判据（实证）：该市场在交易时段 → 缓存龄 < 5 分钟；不在时段 → 命中即用（终局，无视龄）。
//   刻意不做"写入时刻 vs 本时段开始"的比较：美股跨北京午夜时该判据恒假、缓存形同虚设（实测上游压力 5.5 倍）。
//   "是否在时段内"复用 marketClock 的窗口函数（UTC/DST 精确、含周末节假日），零日期字符串逻辑。
// 单飞挂各市场子任务而非全量入口：三个子缓存状态天然不同步（A 股/港股收盘后即终局，美股等到北京次日 04:00），
//   粗粒度"整批单飞"会在 us 到期时把 cn/hk 一起重拉，吃掉"夜间只 3 个上游请求"的收益。
const SPARK_TTL_MS = 5 * 60 * 1000;
const SPARK_NEG_TTL_MS = 30 * 1000;
const SPARK_CACHE_MAX_MS = 12 * 60 * 60 * 1000;
const sparkInflight = new Map();

function sparkMarketInSession(market, d = new Date()) {
  if (market === 'hk') return hkIndexWindowOpen(d);
  if (market === 'us') return usIndexWindowOpen(d);
  return cnIndexWindowOpen(d);
}
/** 午间休市（已暂停、非收盘）：场次暂停时上游同样不再出新点，缓存即终局，不参与补收。
 *  否则午休的半场缓存会被判「半场」，每个 5 分钟冷却到期就重拉一次
 *  （cn 90 分钟 ≈ 18 次/日、hk 60 分钟 ≈ 12 次/日），违反「收盘后至多一次补收」的上游限频约束。 */
function sparkMarketPaused(market, d = new Date()) {
  if (market === 'hk') return hkMarketPhase(d) === 'lunch';
  if (market === 'us') return false; // 美股无午休
  return cnMarketPhase(d) === 'lunch';
}
function sparkMarketCached(market) {
  const key = `index-spark:${market}`;
  const hit = apiCache.get(key);
  if (hit) {
    // 在时段：仅 5 分钟内的算数（跨入新时段后旧记录自然过期 → 自动刷新）。
    // 出时段：数据覆盖完整场次才算终局命中。原「命中即用（无视龄）」会把
    // 盘中最后一次刷新留下的半场缓存冻结成终局（美股场次在北京深夜，实测末点停在 15:29 →
    // 缩略图比其余三卡提前收口，实测发现）；半场缓存改按 5 分钟冷却补收一次（早休日不至于
    // 每次请求都打上游），判据 sparkCoversSession 看数据本身、不做日期比较。
    if (sparkMarketInSession(market)) {
      if (Date.now() - hit.at < SPARK_TTL_MS) return Promise.resolve(hit);
    } else if (
      sparkMarketPaused(market) ||
      sparkCoversSession(hit.items, market) ||
      Date.now() - hit.at < SPARK_TTL_MS
    ) {
      return Promise.resolve(hit);
    }
  }
  const inflight = sparkInflight.get(market);
  if (inflight) return inflight;
  const p = datasource
    .fetchIndexSparksForMarket(market)
    .then((r) => {
      const rec = { items: r.items, ok: r.ok, at: Date.now() };
      apiCache.set(key, rec, r.ok ? SPARK_CACHE_MAX_MS : SPARK_NEG_TTL_MS); // 失败走负缓存，压住重试频率
      return rec;
    })
    .catch((e) => {
      const rec = {
        items: [],
        ok: false,
        at: Date.now(),
        err: String(e?.message || e).slice(0, 60),
      };
      apiCache.set(key, rec, SPARK_NEG_TTL_MS);
      return rec;
    })
    .finally(() => {
      sparkInflight.delete(market);
    });
  sparkInflight.set(market, p);
  return p;
}

const db = createDatabase({
  dataDir: DATA_DIR,
  backupKeep: parseInt(process.env.BACKUP_KEEP, 10) || 30,
});

const strategyStore = createStrategyStore({ dataDir: DATA_DIR });
const strategyTask = createStrategyTask({
  db,
  strategyStore,
  fetchHistory: datasource.fetchHistory,
  log: (msg) =>
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`),
});

// ---- 定时快照任务：每日收盘后自动抓净值落盘，摆脱"当天打开页面才积累快照" ----
// SNAPSHOT_TASK=off 关闭；SNAPSHOT_INTERVAL_MIN 调检查间隔（默认 30 分钟，下限 5）
const SNAPSHOT_TASK = (process.env.SNAPSHOT_TASK ?? 'on') !== 'off';
const STRATEGY_TASK = (process.env.STRATEGY_TASK ?? 'on') !== 'off';
const SNAPSHOT_INTERVAL_MIN = Math.max(5, parseInt(process.env.SNAPSHOT_INTERVAL_MIN, 10) || 30);

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// 模型调用失败的统一出口：原始报错进服务端日志（定位用），前端只收可读中文提示
// （网关常把"渠道下线"报成 model_not_found / No available channel，裸透传对用户是天书）
// 人话转写规则（按序匹配）：
//   渠道下线   model_not_found / No available channel / 无可用渠道
//   网关超时   模型 HTTP 524（上游生成过慢，网关先掐断）
//   鉴权失败   HTTP 401 / 403（key 无效或额度问题）
//   找不到模型 HTTP 404（模型名不存在）
//   其余 HTTP 5xx 网关临时故障
//   其余        原文已是人话（如"模型响应超时（60 秒未返回）"），直接透传
function humanizeModelError(raw) {
  if (/model_not_found|No available channel|无可用渠道/i.test(raw))
    return '模型不可用：配置的模型已下线或网关无可用渠道，请更换 ocr.config.json 里的 model 后重试（详情见服务端日志）';
  if (/HTTP 524/.test(raw))
    return '模型生成太慢，网关先超时断开了：可稍后重试，或换一个生成更快的模型（详情见服务端日志）';
  if (/HTTP 40[13]/.test(raw))
    return '模型服务拒绝了请求：请检查 ocr.config.json 里的 apiKey 是否有效、账户是否有额度（详情见服务端日志）';
  if (/HTTP 404/.test(raw))
    return '模型不存在：ocr.config.json 里的 model 名字有误或已下线，请更换后重试（详情见服务端日志）';
  if (/HTTP 5\d\d/.test(raw)) return '模型服务临时不可用，请稍后重试（详情见服务端日志）';
  return raw;
}

function sendModelError(res, code, e) {
  const raw = String(e?.message || e);
  console.error(`[模型调用失败] ${code}: ${raw}`);
  return sendJson(res, 502, { error: code, detail: humanizeModelError(raw) });
}

/** 读取请求体（JSON），超限拒绝 */
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  return !APP_TOKEN || req.headers['x-app-token'] === APP_TOKEN;
}

// 当日净值已拿到 → 缓存 1 小时；否则 60 秒（晚间净值发布时段轮询重取）
function quoteTtlMs(q) {
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
  return q.nav_date === today ? 60 * 60 * 1000 : 60 * 1000;
}

function msUntilMidnight() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) - d;
}

async function handleApi(req, res, url) {
  // ---- 数据持久化 ----
  if (url.pathname === '/api/data') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') {
      return sendJson(res, 200, await db.load());
    }
    if (req.method === 'PUT') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.message === 'payload_too_large')
          return sendJson(res, 413, { error: 'payload_too_large' });
        return sendJson(res, 400, { error: 'invalid_json' });
      }
      try {
        return sendJson(
          res,
          200,
          await db.save(
            body.assets,
            body.base_updated_at ?? null,
            body.daily,
            body.ai_log,
            body.corrections,
          ),
        );
      } catch (e) {
        if (e instanceof ConflictError) {
          return sendJson(res, 409, { error: 'conflict', server_updated_at: e.serverUpdatedAt });
        }
        if (
          String(e.message).startsWith('invalid_assets') ||
          String(e.message).startsWith('invalid_ai_log') ||
          String(e.message).startsWith('invalid_corrections')
        ) {
          return sendJson(res, 400, { error: 'invalid_data', detail: String(e.message) });
        }
        throw e;
      }
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  if (url.pathname === '/api/quote') {
    const codes = (url.searchParams.get('codes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s))
      .slice(0, 50);
    if (codes.length === 0) return sendJson(res, 400, { error: 'invalid_codes' });

    const quotes = [];
    const errors = [];
    const missing = [];
    for (const c of codes) {
      const hit = apiCache.get(`quote:${c}`);
      if (hit) quotes.push(hit);
      else missing.push(c);
    }
    if (missing.length > 0) {
      const { quotes: fresh, errors: errs } = await datasource.fetchQuoteBatch(missing);
      for (const q of fresh) {
        apiCache.set(`quote:${q.code}`, q, quoteTtlMs(q));
        quotes.push(q);
      }
      errors.push(...errs);
    }
    return sendJson(res, 200, { quotes, errors });
  }

  // ---- 实时估值盘「当天估值走势」：当天估算曲线（只读、公开行情，不鉴权）----
  // 契约：code 非 6 位数字 → 400；无当天曲线 → 200 且 points: []；上游失败 → 502。
  // `?force=1`（手动刷新）：绕缓存读直接打上游，但按 code 冷却 5 秒；冷却内的重复 force 平滑降级返回缓存 200，
  //   绝不吐 401（公开行情路由上加鉴权，会把"图正常、一刷新就报错"变成死循环）。
  if (url.pathname === '/api/estimate-curve') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    const code = (url.searchParams.get('code') || '').trim();
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'invalid_code' });

    const key = `curve:${code}`;
    const nowMs = Date.now();
    const lastForce = curveForcedAt.get(code) || 0;
    const bypass =
      url.searchParams.get('force') === '1' && nowMs - lastForce >= CURVE_FORCE_COOLDOWN_MS;
    if (bypass) curveForcedAt.set(code, nowMs);
    if (!bypass) {
      const hit = apiCache.get(key);
      if (hit) return sendJson(res, hit.__status || 200, hit.__status ? hit.body : hit); // 负缓存照原状态回
    }

    try {
      const today = beijingToday();
      const c = await datasource.fetchEstimateCurve(code, { today });
      const body = {
        code,
        market_date: today,
        points: c.points,
        worth: c.worth,
        worth_date: c.worthDate,
        dropped_other_day: c.droppedOtherDay,
        source: 'sina',
        fetched_at: new Date().toISOString(),
      };
      // 缓存：常规 60 秒；开盘临界（09:29–09:31 且尚无当天点）降为 5 秒；否则 09:29:40 存的空响应会挡到
      // 09:30:40，开盘后头 40 秒只能看到"尚未开盘"。（不另判交易日：该窗口在周末只多几次上游调用，代价可忽略。）
      const mins = beijingMinutes();
      const openEdge = c.points.length === 0 && mins >= 569 && mins <= 571;
      apiCache.set(key, body, openEdge ? 5 * 1000 : 60 * 1000);
      return sendJson(res, 200, body);
    } catch (e) {
      const body = {
        error: 'curve_failed',
        detail: String(e?.message || e)
          .replace(/\s+/g, ' ')
          .slice(0, 60),
      };
      apiCache.set(key, { __status: 502, body }, 30 * 1000); // 负向缓存 30 秒：压住上游故障期的重试频率
      return sendJson(res, 502, body);
    }
  }

  if (url.pathname === '/api/history') {
    const code = url.searchParams.get('code') || '';
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'invalid_code' });
    const days = Math.min(Math.max(1, parseInt(url.searchParams.get('days'), 10) || 90), 365);
    const key = `history:${code}:${days}`;
    const hit = apiCache.get(key);
    if (hit) return sendJson(res, 200, hit);
    const data = await datasource.fetchHistory(code, days);
    apiCache.set(key, data, msUntilMidnight()); // 历史净值当日有效
    return sendJson(res, 200, data);
  }

  if (url.pathname === '/api/index') {
    // 运维入口：`?refresh=1` = 复位主源熔断 + 绕过 5min 缓存，强制重探 push2。
    // 换出口 IP / 网络后不必重启服务即可让主源"复活"。该变体免鉴权（加口令
    // 会造成"图正常、一点就 401"的死循环，见上方 INDEX_FORCE_COOLDOWN_MS 处的说明），
    // 防滥用采用按来源 5 秒冷却：冷却内重复 refresh 平滑降级为常规缓存读（200）。
    // 常规无参拉取（公开行情）行为完全不变。注意：它真的会打一次上游，勿循环调用。
    const refresh = url.searchParams.get('refresh') === '1';
    const nowMs = Date.now();
    const bypass = refresh && nowMs - indexForcedAt >= INDEX_FORCE_COOLDOWN_MS;
    if (bypass) {
      indexForcedAt = nowMs; // 真穿透：复位熔断 + 绕过缓存（冷却内不重复穿透）
      datasource.resetIndexBreaker();
    } else {
      const hit = apiCache.get('index');
      if (hit) return sendJson(res, 200, hit);
    }
    const payload = { indexes: await datasource.fetchIndexes() };
    // 指数缓存降频：60s → 300s。前端每 60s 轮询 + 快照任务同窗口都在打东财系域名，
    // push2 当晚即遭 IP 级封锁（errCount 600+）；指数卡是"参照"性质，分钟级延迟无感，
    // 5 分钟缓存把上游请求密度降为 1/5（前端轮询 5 次才穿透 1 次）。
    apiCache.set('index', payload, 5 * 60 * 1000);
    return sendJson(res, 200, payload);
  }

  // ---- 核心指数「当天迷你分时」（批量 11 只；只读、公开行情，不鉴权）----
  // 契约：200 + items[]（单只失败落成该项 spark:null + empty_reason，不拖垮整批）；
  //   三个市场全失败 → 502 spark_failed（前端保留上次图形）。缓存/单飞/时段判据见上方常量区。
  if (url.pathname === '/api/index-spark') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    const recs = await Promise.all(['cn', 'hk', 'us'].map((m) => sparkMarketCached(m)));
    if (recs.every((r) => !r.ok)) {
      const detail =
        recs
          .map((r) => r.err)
          .filter(Boolean)
          .join(' | ')
          .slice(0, 60) || 'all_markets_failed';
      return sendJson(res, 502, { error: 'spark_failed', detail });
    }
    return sendJson(res, 200, {
      items: recs.flatMap((r) => r.items || []),
      source: 'em-trends+sina-us-min',
      fetched_at: new Date().toISOString(),
    });
  }

  // ---- 数据源健康：服务端只报事实（各源最后成功/失败时间），状态判定在客户端 ----
  if (url.pathname === '/api/source-health') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    return sendJson(res, 200, await sourceHealth.read());
  }

  // ---- 策略引擎：状态查询（只读实时评估）与手动巡检（双通道）----
  if (url.pathname === '/api/strategy/status') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, await strategyTask.status());
  }
  if (url.pathname === '/api/strategy/evaluate-now' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    // 手动巡检：强制重拉当日缓存 + force 跳幂等门（改配置后当日生效；事件重复仍由冷却闸/指纹闸防）
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      // body 非法 JSON 时按无参数处理（force 默认 false），不报错打断巡检
    }
    const r = await strategyTask.runOnce({ refreshHistory: true, force: body?.force === true });
    return sendJson(res, 200, {
      ok: true,
      evaluated: r.evaluated,
      events: r.events,
      status: await strategyTask.status(),
    });
  }
  // 已执行标记（State Demotion 降级文案驱动源）与触发历史时间线
  if (url.pathname === '/api/strategy/ack' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      try {
        const { code, state, navDate } = JSON.parse(body || '{}');
        return sendJson(res, 200, await strategyTask.ack(code, state, navDate));
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid_ack', detail: String(e.message || e) });
      }
    });
    return;
  }
  // ---- 人工纠偏通道：ignore / reset-tiers / correct-reserve ----
  if (url.pathname === '/api/strategy/ignore' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      try {
        const { code, state, navDate } = JSON.parse(body || '{}');
        return sendJson(res, 200, await strategyTask.ignore(code, state, navDate));
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid_ignore', detail: String(e.message || e) });
      }
    });
    return;
  }
  if (url.pathname === '/api/strategy/reset-tiers' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      try {
        const { code, tier } = JSON.parse(body || '{}');
        return sendJson(res, 200, await strategyTask.resetTiers(code, tier));
      } catch (e) {
        const msg = String(e.message || e);
        return sendJson(res, 400, { error: msg.split(':')[0].trim(), detail: msg }); // invalid_code / invalid_tier 与契约一致
      }
    });
    return;
  }
  if (url.pathname === '/api/strategy/correct-reserve' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      try {
        const { code, reserveUsed } = JSON.parse(body || '{}');
        return sendJson(res, 200, await strategyTask.correctReserve(code, reserveUsed));
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.startsWith('fund_not_found'))
          return sendJson(res, 404, { error: 'fund_not_found' });
        const errCode = msg.split(':')[0].trim(); // invalid_reserve_used / add_not_enabled / reserve_base_not_ready / out_of_cap / invalid_code
        return sendJson(res, 400, {
          error: errCode,
          detail: msg,
          ...(e.cap != null ? { cap: e.cap } : {}),
        });
      }
    });
    return;
  }
  if (url.pathname === '/api/strategy/alerts') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const limit = Math.min(
      Math.max(
        parseInt(new URL(req.url, 'http://localhost').searchParams.get('limit'), 10) || 50,
        1,
      ),
      200,
    );
    return sendJson(res, 200, await strategyTask.alerts(limit));
  }

  // ---- 基金搜索：截图识别到的名称 → 候选代码（多图导入自动创建持仓补码用）----
  if (url.pathname === '/api/fund-search') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const key = (url.searchParams.get('key') || '').trim().slice(0, 40);
    if (!key) return sendJson(res, 400, { error: 'invalid_key' });
    const cacheKey = `fundsearch:${key}`;
    const hit = apiCache.get(cacheKey);
    if (hit) return sendJson(res, 200, hit);
    const data = await datasource.fetchFundSearch(key);
    apiCache.set(cacheKey, data, 24 * 60 * 60 * 1000); // 基金名单基本稳定，缓存一天
    return sendJson(res, 200, data);
  }

  // ---- 基金名称回填：lsjz 行情不含名称，按代码批量查官方名称 ----
  if (url.pathname === '/api/fund-names') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const codes = (url.searchParams.get('codes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s))
      .slice(0, 50);
    if (codes.length === 0) return sendJson(res, 400, { error: 'invalid_codes' });
    const names = {};
    const missing = [];
    for (const c of codes) {
      const hit = apiCache.get(`fundname:${c}`);
      if (hit) names[c] = hit;
      else missing.push(c);
    }
    if (missing.length > 0) {
      const { names: fresh } = await datasource.fetchFundNames(missing);
      for (const [c, n] of Object.entries(fresh)) {
        apiCache.set(`fundname:${c}`, n, 24 * 60 * 60 * 1000);
        names[c] = n;
      }
    }
    return sendJson(res, 200, { names });
  }

  // ---- 截图识别（视觉大模型代理；key 只在服务端，截图转发后即弃）----
  if (url.pathname === '/api/ocr/extract') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    // 每次请求重读配置：填好 ocr.config.json 即生效，无需重启
    const config = await loadOcrConfig({ configPath: OCR_CONFIG_PATH });
    if (!config) {
      return sendJson(res, 503, {
        error: 'ocr_not_configured',
        hint: '识别服务未配置：复制 ocr.config.example.json 为 ocr.config.json，填入 baseUrl/apiKey/model 后即可使用',
      });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 9 * 1024 * 1024));
    } catch (e) {
      if (e.message === 'payload_too_large')
        return sendJson(res, 413, { error: 'payload_too_large' });
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    if (!body?.image || !String(body.image).startsWith('data:image/')) {
      return sendJson(res, 400, { error: 'invalid_image' });
    }
    const client = createOcrClient({ config });
    try {
      return sendJson(res, 200, await client.extract(body.image));
    } catch (e) {
      return sendModelError(res, 'ocr_failed', e);
    }
  }

  // ---- AI 今日解读（与截图识别同款模型配置，纯文本交互；context 由前端组装）----
  if (url.pathname === '/api/analysis') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    // 模型拆分：配置文件若有 analysis 段则 AI 解读用它，否则与截图识别同模型
    const cfg = await loadOcrConfig({ configPath: OCR_CONFIG_PATH });
    const config = cfg?.analysis ?? cfg;
    if (!config) {
      return sendJson(res, 503, {
        error: 'analysis_not_configured',
        hint: 'AI 解读复用 ocr.config.json 的模型配置，请先填入 baseUrl/apiKey/model（可用 analysis 段单独指定解读模型）',
      });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 1024 * 1024));
    } catch (e) {
      if (e.message === 'payload_too_large')
        return sendJson(res, 413, { error: 'payload_too_large' });
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    if (!body?.context || typeof body.context !== 'object')
      return sendJson(res, 400, { error: 'invalid_context' });
    try {
      const client = createAnalysisClient({ config, timeoutMs: ANALYSIS_TIMEOUT_MS });
      return sendJson(res, 200, await client.interpret(body.context));
    } catch (e) {
      return sendModelError(res, 'analysis_failed', e);
    }
  }

  return sendJson(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, u);
    } catch (e) {
      sendJson(res, 502, { error: '行情源请求失败', detail: String(e.message || e) });
    }
    return;
  }

  // 防目录穿越（畸形百分号编码会让 decodeURIComponent 抛 URIError，
  // 该 handler 是 async 且未 await → unhandled rejection → Node 22 默认退出进程，
  // 局域网模式下等于远程 DoS；前缀判据补分隔符，避免同前缀兄弟目录绕过）
  let urlPath;
  try {
    urlPath = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const safePath = normalize(join(ROOT, urlPath));
  if (safePath !== ROOT && !safePath.startsWith(ROOT + sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let filePath = safePath;
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // 文件不存在，尝试补 index.html
    filePath = join(safePath, 'index.html');
  }

  try {
    const buf = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    // no-cache：零构建项目改动 js/css/html 后，浏览器刷新必须拿到新版本（否则访客会看到旧页面）
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用（可能是之前没关的服务还在跑）。`);
    console.error('两种解决办法：');
    console.error('  1. 换端口启动：  set PORT=8124 && npm start');
    console.error(
      '  2. 关掉占用进程：在 cmd 执行  netstat -ano | findstr :8123  找到 PID，再  taskkill /PID <PID> /F',
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`理财看板已启动：http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const nets of Object.values(networkInterfaces())) {
      for (const net of nets || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  局域网访问：http://${net.address}:${PORT}（需 X-App-Token）`);
        }
      }
    }
  }
  if (SNAPSHOT_TASK) {
    const log = (msg) =>
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    // fetchQuoteBatch 是 datasource 闭包方法，不依赖 this，可直接解耦传递
    createSnapshotTask({
      db,
      fetchQuotes: datasource.fetchQuoteBatch,
      intervalMs: SNAPSHOT_INTERVAL_MIN * 60 * 1000,
      log,
    }).start();
    console.log(
      `定时快照已启用：工作日 15:00–24:00 每 ${SNAPSHOT_INTERVAL_MIN} 分钟检查，启动时先补漏（SNAPSHOT_TASK=off 可关）`,
    );
  }
  if (STRATEGY_TASK) {
    strategyTask.start(); // 通道 B：启动即评估一轮；通道 A：窗口内定时巡检（均幂等，只处理净值推进的基金）
    console.log(
      '策略巡检已启用：工作日 15:00–24:00 每 30 分钟评估（STRATEGY_TASK=off 可关；/api/strategy/status 可查）',
    );
  }
  console.log('按 Ctrl+C 停止');
});
