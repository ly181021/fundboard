/**
 * 实时估值盘视图模型：state + quote → 视图数据。纯函数，不产出 HTML（面板由 app.js 模板渲染）。
 *
 * 入参：state 为 applyQuote 合并后的状态；quote 为原始行情，接口失败或未拉到时为 undefined；
 * opts.today 为本地日 YYYY-MM-DD，opts.name 用于识别 QDII。
 *
 * status 四态：estimate 表示估值属于当日且当日确认净值未发布；confirmed 表示当日确认净值已发布；
 * lagged 表示净值滞后品种（QDII 等）新到账，数据属其自身净值日；pending 表示两者皆无。
 *
 * 涨跌额与盈亏沿用 applyQuote 已算好的口径（份额 × 涨跌额），本函数只做取数与分支，不重复计算，
 * 避免出现第二份盈亏口径。
 */

/** 行情源标识 → 中文标签；未知源取原值透出，便于排障 */
const SOURCE_LABELS = { eastmoney: '天天基金', danjuan: '蛋卷', sina: '新浪', push2: '天天基金' };

export function buildEstimateBoard(state, quote, { today, name } = {}) {
  if (!state) return null;
  const isQdii = /QDII/i.test(name ?? '');
  const hasQuote = !!quote;
  const q = quote ?? {};

  const status =
    state.mode === 'estimate'
      ? 'estimate'
      : state.dataDate === today
        ? 'confirmed'
        : state.dayChangePct != null
          ? 'lagged'
          : 'pending';

  const navDelta =
    state.latestNav != null && q.nav != null
      ? Math.round((state.latestNav - q.nav) * 10000) / 10000
      : null;

  let statusNote = '';
  if (status === 'estimate') statusNote = '盘中估值，官方净值今日晚间公布后自动让位';
  else if (status === 'confirmed')
    statusNote = '今日官方净值已发布，估值已让位（本页数字为确认净值口径）';
  else if (status === 'lagged')
    statusNote = `净值滞后品种：数据属其净值日 ${state.dataDate ?? '—'}（按到账口径）`;
  else if (isQdii)
    statusNote = 'QDII 基金不使用盘中估值（第三方自算滞后失真），按确认净值与到账口径展示';
  else if (!hasQuote) statusNote = '尚未拉到行情——可点「刷新」或等下一轮轮询（60 秒）';
  else statusNote = '该基金暂无盘中估值数据，且今日确认净值尚未发布';

  return {
    code: q.code ?? null,
    name: name ?? q.name ?? null,
    isQdii,
    hasQuote,
    status,
    statusLabel: {
      estimate: '估值中',
      confirmed: '已更新',
      lagged: '净值滞后到账',
      pending: '待更新',
    }[status],
    statusNote,
    // 净值口径：估值模式下取估值净值，其余取确认净值
    mainNav: state.latestNav ?? null,
    mainIsEstimate: status === 'estimate',
    mainChangePct: state.dailyChangePct ?? null,
    navDelta,
    // 金额口径
    holdShares: state.holdShares ?? null,
    marketValue: state.holdAmount ?? null,
    holdProfit: state.holdProfit ?? null,
    totalInvested: state.totalInvested ?? null,
    lossRate: state.lossRate ?? null,
    dayProfit: state.dayProfit ?? null,
    dayChangePct: state.dayChangePct ?? null,
    // 确认净值对照
    confirmedNav: q.nav ?? null,
    confirmedNavDate: q.nav_date ?? null,
    confirmedChangePct: q.change_pct ?? null,
    prevNav: q.prev_nav ?? null,
    // 元信息
    estimateTime: state.estimateTime ?? null,
    sourceLabel: q.source ? (SOURCE_LABELS[q.source] ?? q.source) : null,
    fetchedAt: q.fetched_at ?? null,
  };
}
