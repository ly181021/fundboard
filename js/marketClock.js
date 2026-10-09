/**
 * 多市场指数交易时钟。
 *
 * 浏览器/服务端同构纯函数。仅做大概率开市近似判断，用于指数轮询分流：
 * 覆盖周末与每日开闭市时段；A 股法定节假日感知（chinese-days 由调用方注入，10-06 国庆实证假期显示"开盘中"缺陷）；
 * 港/美股节假日不感知（各自历法未建模，港股不随内地假期休市）；数据陈旧由行情时间戳（push2 f124）可见。
 *
 * 恒生UTC+8，周一至五 9:30–12:00 / 13:00–16:00（午休分流）；
 * 纳指美东周一至五9:30–16:00：夏令时UTC-4，北京时间21:30–次日04:00；冬令时UTC-5，北京时间22:30–次日05:00。
 * DST遵循2007起美国规则，UTC精确表达：
 * 3月第二个周日07:00Z开启，11月第一个周日06:00Z结束；
 * 切换发生在美东周日凌晨休市时段，不影响开市判定。
 */

const HOUR_MS = 60 * 60 * 1000;

/** 某年某月（0 起）第 n 个周日的 UTC 时刻，hourUtc 为切换发生的 UTC 小时 */
function nthSundayUtc(year, month, n, hourUtc) {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const day = 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
  return Date.UTC(year, month, day, hourUtc);
}

/** 美东是否夏令时：3 月第二个周日 07:00Z ≤ t < 11 月第一个周日 06:00Z */
export function isUsEasternDst(now = new Date()) {
  const t = now.getTime();
  const y = now.getUTCFullYear();
  return t >= nthSundayUtc(y, 2, 2, 7) && t < nthSundayUtc(y, 10, 1, 6);
}

/** 固定偏移时区的"当地钟面"：把 UTC 时刻平移后按 UTC getter 读取 */
function shifted(now, offsetHours) {
  return new Date(now.getTime() + offsetHours * HOUR_MS);
}

function weekdayMinutes(shiftedDate) {
  return {
    dow: shiftedDate.getUTCDay(),
    min: shiftedDate.getUTCHours() * 60 + shiftedDate.getUTCMinutes(),
  };
}

/**
 * 北京（UTC+8）当日 'YYYY-MM-DD'。
 * 与运行时时区无关（平移 +8h 后读 UTC getter）；中国无夏令时，等价于锁 Asia/Shanghai，
 * 但不依赖 ICU/环境时区（UTC 容器、CI、海外客户端下都得到同一个"北京交易日"）。
 */
export function beijingToday(now = new Date()) {
  const d = shifted(now, 8);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 北京墙钟的当日分钟数（0..1439）：盘前 / 午休 / 收盘判定用；同样与运行时时区无关。 */
export function beijingMinutes(now = new Date()) {
  return weekdayMinutes(shifted(now, 8)).min;
}

/**
 * 港股阶段（UTC+8）：'open' 9:30–12:00 / 13:00–16:00、'lunch' 12:00–13:00、'closed' 其余/周末。
 * lunch 态：午休期间确实"未开市"，但不是收盘，界面不该显示"已收盘"。
 */
export function hkMarketPhase(now = new Date()) {
  const { dow, min } = weekdayMinutes(shifted(now, 8));
  if (dow === 0 || dow === 6) return 'closed';
  if ((min >= 570 && min < 720) || (min >= 780 && min < 960)) return 'open';
  if (min >= 720 && min < 780) return 'lunch';
  return 'closed';
}

/** 恒生指数（UTC+8）大概率开市：周一至五 9:30–12:00 / 13:00–16:00 */
export function hkIndexWindowOpen(now = new Date()) {
  return hkMarketPhase(now) === 'open';
}

/** A 股阶段（UTC+8）：'open' 9:30–11:30 / 13:00–15:00、'lunch' 11:30–13:00、'closed' 其余/周末。
 * holidays（Set/Array，'YYYY-MM-DD'）：法定节假日集合（chinese-days，调用方注入；集合内日期判 'closed'）
 * （10-06 国庆假期实证 A 股休市而卡片显示"开盘中"）；缺省退化只跳周末（旧行为，交易日历未加载时不误报）。 */
export function cnMarketPhase(now = new Date(), holidays = null) {
  const { dow, min } = weekdayMinutes(shifted(now, 8));
  if (dow === 0 || dow === 6) return 'closed';
  if (dayInHolidays(holidays, beijingToday(now))) return 'closed';
  if ((min >= 570 && min < 690) || (min >= 780 && min < 900)) return 'open';
  if (min >= 690 && min < 780) return 'lunch';
  return 'closed';
}

/** 节假日集合成员判定（Set/Array 双形态；空值安全） */
function dayInHolidays(holidays, dateStr) {
  if (!holidays) return false;
  if (holidays instanceof Set) return holidays.has(dateStr);
  return Array.isArray(holidays) && holidays.includes(dateStr);
}

/** A 股指数（UTC+8）大概率开市：周一至五 9:30–11:30 / 13:00–15:00（午休分流） */
export function cnIndexWindowOpen(now = new Date()) {
  return cnMarketPhase(now) === 'open';
}

/** 纳斯达克（美东）大概率开市：周一至五 9:30–16:00，自动切换夏令时 */
export function usIndexWindowOpen(now = new Date()) {
  const offset = isUsEasternDst(now) ? -4 : -5;
  const { dow, min } = weekdayMinutes(shifted(now, offset));
  if (dow === 0 || dow === 6) return false;
  return min >= 570 && min < 960;
}

/** 任一海外市场开市（指数轮询分流用；A 股窗口沿用 inQuoteWindow + tradingCalendar） */
export function overseasIndexWindowOpen(now = new Date()) {
  return hkIndexWindowOpen(now) || usIndexWindowOpen(now);
}

/**
 * push2 指数代码 → 所属市场（'us' | 'hk' | 'cn'）：海外白名单，其余默认 A 股窗口。
 * 新增海外指数必须在此登记；未登记会落进 A 股窗口，导致开收盘状态显示错误。
 * A 股代码不用登记（默认分支即是）。
 */
const US_INDEX_CODES = new Set(['NDX', 'IXIC', 'SOX', 'HXC']); // 纳指100 / 纳指综合 / 费城半导体 / 纳斯达克中国金龙
const HK_INDEX_CODES = new Set(['HSI']); // 恒生指数
export function marketOfIndex(code) {
  if (US_INDEX_CODES.has(code)) return 'us';
  if (HK_INDEX_CODES.has(code)) return 'hk';
  return 'cn';
}

/** 指数所属市场的交易阶段（'open' | 'lunch' | 'closed'）：卡片上那枚状态点的文案依据。
 * holidays 仅作用于 A 股（chinese-days 注入）；港股不跟内地假期（内地休市日港股照常开市），
 * 美股假期未建模，两者沿用周末近似，行情时间戳兜底。 */
export function marketPhaseOf(code, now = new Date(), holidays = null) {
  const m = marketOfIndex(code);
  if (m === 'us') return usIndexWindowOpen(now) ? 'open' : 'closed'; // 美股无午休
  if (m === 'hk') return hkMarketPhase(now);
  return cnMarketPhase(now, holidays);
}

/**
 * 各市场交易时段分段（指数分时缩略图口径的单一来源）。
 * 缩略图按"每段等宽拼接、午休不占宽度"绘制；服务端解析层按同一份分段过滤（剔集合竞价/盘后）。
 * 注意：分段描述的是交易时段，不是"每段时长相同"（港股上午 150 分、下午 180 分）。
 */
export const INDEX_SESSIONS = {
  cn: [
    ['09:30', '11:30'],
    ['13:00', '15:00'],
  ],
  hk: [
    ['09:30', '12:00'],
    ['13:00', '16:00'],
  ],
  us: [['09:30', '16:00']], // 美股无午休（美东时间；缩略图轴是"会话相对"的，不做时区换算）
};

/** 指数代码 → 该市场的分时分段（未登记代码按 A 股窗口，与 marketOfIndex 同口径） */
export function indexSegmentsOf(code) {
  return INDEX_SESSIONS[marketOfIndex(code)] || INDEX_SESSIONS.cn;
}

/** 三市场开市状态（核心指数监控头部徽标用）。
 *  items 另带 phase（'open'|'lunch'|'closed'），午间休市不能显示成"已收盘"。
 *  holidays 仅注入 A 股（chinese-days）；港股不跟内地假期、美股未建模（见 marketPhaseOf 注）。 */
export function marketStatusOf(now = new Date(), holidays = null) {
  const cnPhase = cnMarketPhase(now, holidays);
  const hkPhase = hkMarketPhase(now);
  const us = usIndexWindowOpen(now);
  const cn = cnPhase === 'open';
  const hk = hkPhase === 'open';
  return {
    cn,
    hk,
    us,
    items: [
      { label: 'A股', open: cn, phase: cnPhase },
      { label: '港股', open: hk, phase: hkPhase },
      { label: '美股', open: us, phase: us ? 'open' : 'closed' },
    ],
  };
}

/**
 * 指数行情时间戳（push2 f124，秒）→ 当日 "HH:mm"，跨日 "MM-DD HH:mm"，无效返回 ''。
 * 用本机时区展示；休市时时间戳停在过去时刻，跨日显示即为"数据陈旧"的可见信号。
 */
export function formatIndexTime(sec, now = new Date()) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const t = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  return sameDay ? hm : `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${hm}`;
}
