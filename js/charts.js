/**
 * Chart.js封装，渲染净值走势、资产/收益曲线。
 * Chart由CDN全局引入；加载失败静默跳过，不影响页面其余功能。
 * canvas挂载_chart实例，重复渲染前销毁旧实例。
 *
 * 约定：
 * 颜色token化，全部读取CSS变量（cssVar + hexToRgba）；主题/涨跌色切换，重绘即可生效。
 * 资产收益曲线双线条：总资产 + 累计投入；持有收益为两线间距，不单独画线。
 * 净值走势Y轴span-based平移扩展：保证成本线可见，避免净值域负截断。
 * 单基金弹窗Tab2持有收益走势：零轴=回本线；正负混合值域采用span-based扩展。
 */

function destroyPrev(canvas) {
  if (canvas._chart) {
    canvas._chart.destroy();
    canvas._chart = null;
  }
}

/**
 * 悬停十字竖线插件：index 模式下在 tooltip 命中当日位置画一条可见虚线竖线
 * （Chart.js 自带 crosshair 颜色默认过淡，显式绘制）。
 */
const crosshairPlugin = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.();
    if (!active || !active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = cssVar('--chart-tick', '#999');
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/** 读取 CSS 变量（trim 必须，自定义属性值带前导空格）；失败回退 fallback */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v ? v.trim() : fallback;
}

/**
 * 6 位 hex → rgba(r,g,b,α)；非法入参返回 null（调用方兜底色）。
 * @param {string} hex 颜色值
 * @param {number} alpha 透明度
 * @returns {string|null} rgba 字符串或 null
 */
function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return null;
  const h = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * 净值走势：单位净值折线（主题色）+ 持仓成本灰虚线。
 * series: [{date, nav}] 升序。成本线 Y 轴扩展：span-based 平移（净值域恒正防负截断）。
 */
export function renderNavChart(canvas, series, costPrice) {
  if (typeof Chart === 'undefined' || !canvas) return null;
  destroyPrev(canvas);
  const labels = series.map((s) => s.date.slice(5)); // MM-DD
  const datasets = [
    {
      label: '单位净值',
      data: series.map((s) => s.nav),
      borderColor: cssVar('--chart-line', '#d4380d'),
      backgroundColor: hexToRgba(cssVar('--chart-line', '#d4380d'), 0.07) ?? 'rgba(212,56,13,0.07)',
      fill: true,
      tension: 0.25,
      pointRadius: 0,
      pointHitRadius: 8,
      borderWidth: 2,
    },
  ];
  const scales = {
    x: {
      border: { display: true, color: cssVar('--chart-tick', '#999') },
      ticks: { maxTicksLimit: 6, color: cssVar('--chart-tick', '#999'), font: { size: 10 } },
      grid: { display: false },
    },
    y: {
      border: { display: true, color: cssVar('--chart-tick', '#999') },
      ticks: { color: cssVar('--chart-tick', '#999'), font: { size: 10 } },
      grid: { color: cssVar('--chart-grid', '#f0f0f0') },
    },
  };
  if (costPrice > 0) {
    datasets.push({
      label: '持仓成本（摊薄）',
      data: labels.map(() => costPrice),
      borderColor: cssVar('--chart-invest', '#8a919c'),
      borderDash: [6, 4],
      pointRadius: 0,
      borderWidth: 1.2,
    });
  }
  // Y 轴留白无条件生效（无成本价时同样 5% headroom，最高点不贴顶；有效值过滤 + span-based 平移扩展 + 净值域防负截断）
  const validNavs = series.map((p) => Number(p.nav)).filter((n) => Number.isFinite(n) && n > 0);
  if (costPrice > 0) validNavs.push(Number(costPrice));
  if (validNavs.length > 0) {
    const lo = Math.min(...validNavs),
      hi = Math.max(...validNavs);
    const span = hi - lo || Math.abs(hi) || 1;
    const pad = span * 0.05;
    scales.y.suggestedMin = Math.max(0, lo - pad);
    scales.y.suggestedMax = hi + pad;
  }
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      animation: false,
      maintainAspectRatio: false, // 由 .chart-box 容器定高（否则按宽度等比撑得过高）
      interaction: { mode: 'index', intersect: false }, // 图表任意位置悬停即显示当日竖线（不限于曲线点）
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items?.length ? String(series[items[0].dataIndex]?.date ?? '') : ''),
            label: (ctx) =>
              ctx.dataset.label === '持仓成本（摊薄）'
                ? `持仓成本 ${Number(ctx.raw).toFixed(4)}`
                : `净值 ${Number(ctx.raw).toFixed(4)}`,
          },
        },
      },
      scales,
    },
    plugins: [crosshairPlugin],
  });
  return canvas._chart;
}

/**
 * 资产/收益曲线（两线）：总资产实线 + 累计投入灰虚线（成本参考线）；
 * 持有收益不单画线——两线间距即持有收益。days: [{date, total_assets, total_invested}] 升序。
 * correctionsByDate（口径 Ⅰ 留痕）：{ [date]: [{code, from, to}] } —— 修正生效日
 * 在累计投入线上打点，tooltip footer 显示"本金修正 A→B"。
 */
export function renderAssetChart(canvas, days, correctionsByDate = {}, { masked = false } = {}) {
  if (typeof Chart === 'undefined' || !canvas) return null;
  destroyPrev(canvas);
  const corrTextOf = (date) => {
    const items = correctionsByDate?.[date];
    if (!Array.isArray(items) || items.length === 0) return null;
    return '本金修正 ' + items.map((x) => `${x.from ?? '—'}→${x.to ?? '—'}`).join('、');
  };
  const hasInvested = days.some((d) => Number(d.total_invested) > 0);
  const datasets = [
    {
      label: '总资产',
      data: days.map((d) => d.total_assets),
      borderColor: cssVar('--chart-line', '#d4380d'),
      fill: false, // 只画曲线不画覆盖区（两线间距 = 持有收益 的读法不受影响）
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 2,
    },
  ];
  if (hasInvested) {
    datasets.push({
      label: '累计投入',
      data: days.map((d) => d.total_invested),
      borderColor: cssVar('--chart-invest', '#8a919c'),
      borderDash: [6, 4],
      tension: 0.25,
      pointRadius: days.map((d) => (corrTextOf(d.date) ? 4 : 0)), // 修正生效日打点（其余位置不显点）
      pointBackgroundColor: cssVar('--chart-invest', '#8a919c'),
      pointBorderColor: cssVar('--chart-invest', '#8a919c'),
      borderWidth: 1.4,
    });
  }
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: days.map((d) => d.date.slice(5)), datasets },
    options: {
      animation: false,
      maintainAspectRatio: false, // 由 .chart-box 容器定高
      interaction: { mode: 'index', intersect: false }, // 悬停任意位置定位当日：修正日标注的 footer 才可达（原 intersect:true + 半径 0 实际唤不出 tooltip）
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items?.length ? String(days[items[0].dataIndex]?.date ?? '') : ''),
            // 打码出口：提示框读数遮蔽（标签保留、数值打码，本金修正的金额同样打码）
            // v4 的 label 回调返回 null 会"跳过该项"——两态都必须显式返回字符串
            label: (item) => {
              const v = Number(item.parsed.y).toLocaleString('zh-CN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
              return masked ? item.dataset.label + ' ••••••' : item.dataset.label + ' ¥' + v;
            },
            afterBody: (items) => {
              if (!items?.length || !hasInvested) return '';
              const d = days[items[0].dataIndex];
              if (!d) return '';
              if (masked) return '持有收益 ••••••';
              const profit = Number(d.total_assets) - Number(d.total_invested);
              const s = Math.abs(profit).toLocaleString('zh-CN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
              return '持有收益 ' + (profit > 0 ? '+¥' : profit < 0 ? '-¥' : '¥') + s;
            },
            footer: (items) => {
              if (!items?.length) return '';
              const corr = corrTextOf(days[items[0].dataIndex]?.date);
              if (!corr) return '';
              return masked ? '本金修正 ••••→••••' : corr;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8, color: cssVar('--chart-tick', '#999'), font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: cssVar('--chart-tick', '#999'),
            font: { size: 10 },
            // 打码出口：纵轴刻度遮蔽（等宽占位保持轴结构稳定，不引起布局跳动）
            callback(value) {
              return masked ? '•••' : Number(value).toLocaleString('zh-CN');
            },
          },
          grid: { color: cssVar('--chart-grid', '#f0f0f0') },
        },
      },
    },
  });
  return canvas._chart;
}

/**
 * 持有收益走势（单基金弹窗 Tab 2）：持有收益实线 + 零轴虚线 = 回本线。
 * series: [{date, profit}] 升序；混合符号域：Y 轴含 0，余量 span-based 平移扩展（禁用正数乘法）。
 */
export function renderHoldingChart(canvas, series) {
  if (typeof Chart === 'undefined' || !canvas || !Array.isArray(series) || series.length === 0)
    return null;
  destroyPrev(canvas);
  const labels = series.map((s) => String(s.date).slice(5));
  const datasets = [
    {
      label: '持有收益',
      data: series.map((s) => s.profit),
      borderColor: cssVar('--chart-line', '#d4380d'),
      backgroundColor: hexToRgba(cssVar('--chart-line', '#d4380d'), 0.06) ?? 'rgba(212,56,13,0.06)',
      fill: true,
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 2,
    },
  ];
  const zeroColor = cssVar('--chart-invest', '#8a919c');
  const scales = {
    x: {
      border: { display: true, color: cssVar('--chart-tick', '#999') },
      ticks: { maxTicksLimit: 6, color: cssVar('--chart-tick', '#999'), font: { size: 10 } },
      grid: { display: false },
    },
    y: {
      border: { display: true, color: cssVar('--chart-tick', '#999') },
      ticks: { color: cssVar('--chart-tick', '#999'), font: { size: 10 } },
      grid: { color: cssVar('--chart-grid', '#f0f0f0') },
    },
  };
  const validProfits = series.map((p) => Number(p.profit)).filter(Number.isFinite);
  if (validProfits.length > 0) {
    validProfits.push(0); // 收益归零线（成本线）恒落在可视区内——全浮盈时 Y 轴下沿也必须 ≤ 0
    const rawLo = Math.min(...validProfits),
      rawHi = Math.max(...validProfits);
    const span = rawHi - rawLo || Math.abs(rawHi) || 100; // 全平/全零退化为 100 元缓冲
    const pad = span * 0.05;
    scales.y.suggestedMin = rawLo - pad; // 最低点下方留 5% 区间
    scales.y.suggestedMax = rawHi + pad; // 回本线（0 轴）上方留呼吸空间
  }
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        ...datasets,
        {
          label: '回本线',
          data: labels.map(() => 0),
          borderColor: zeroColor,
          borderDash: [6, 4],
          pointRadius: 0,
          borderWidth: 1.2,
        },
      ],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false }, // 图表任意位置悬停即显示当日竖线（不限于曲线点）
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items?.length ? String(series[items[0].dataIndex]?.date ?? '') : ''),
            // 按数据集区分：回本线不显示"持有收益 ¥0.00"
            label: (ctx) =>
              ctx.dataset.label === '回本线'
                ? '回本线（0）'
                : `持有收益：¥${(ctx.raw ?? 0).toFixed(2)}`,
          },
        },
      },
      scales,
    },
    plugins: [crosshairPlugin],
  });
  return canvas._chart;
}

/**
 * 收益率对比：横向条形图（单基金按持有收益率降序）。
 * rows: [{name, returnRate, xirr}] 小数比例，null 项不画条。
 * 单数据集：持有收益率%（实色）；正负色读 --color-up/--color-down（涨跌色预设联动）。
 * 名称超 8 字截断加省略号（悬停 tooltip 显示全名），避免半宽卡片里 y 轴过宽。
 */
export function renderReturnCompareChart(canvas, rows, { masked = false } = {}) {
  if (typeof Chart === 'undefined' || !canvas || !Array.isArray(rows) || rows.length === 0)
    return null;
  destroyPrev(canvas);
  // 条端数值标签（着色加粗；打码时不绘制）。
  // 历史注：早期补丁只把引用插进了 renderHoldingChart、定义从未落地（valueLabels 全仓库无定义，
  // 打开净值弹窗「持有收益走势」必抛 ReferenceError）；这里按补丁原意把定义补进正确的函数。
  const valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw(c) {
      if (masked) return;
      c.data.datasets[0].data.forEach((v, i) => {
        if (v == null) return;
        const meta = c.getDatasetMeta(0).data[i];
        if (!meta) return;
        const { ctx } = c;
        ctx.save();
        ctx.fillStyle =
          v >= 0 ? cssVar('--color-up', '#f5222d') : cssVar('--color-down', '#389e0d');
        ctx.font = '700 12px sans-serif';
        ctx.textAlign = v >= 0 ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText((v > 0 ? '+' : '') + v.toFixed(2) + '%', meta.x + (v >= 0 ? 6 : -6), meta.y);
        ctx.restore();
      });
    },
  };
  const shorten = (name) => (name.length > 8 ? name.slice(0, 8) + '…' : name);
  const pct = (r) => (r == null ? null : Math.round(r * 10000) / 100);
  const signColor = (v, alpha) => {
    const hex = v >= 0 ? cssVar('--color-up', '#f5222d') : cssVar('--color-down', '#389e0d');
    return (
      hexToRgba(hex, alpha) ?? (v >= 0 ? `rgba(245,34,45,${alpha})` : `rgba(56,158,13,${alpha})`)
    );
  };
  const values = rows.map((r) => pct(r.returnRate)).filter((v) => v != null);
  const maxAbs = values.length > 0 ? Math.max(...values.map(Math.abs)) : 0;
  const raw = maxAbs * 1.15;
  const step = raw > 60 ? 20 : raw > 25 ? 10 : raw > 6 ? 5 : 1;
  // 对称范围让 0 居中（零轴即 x 轴）；上限向上取整到整刻度，避免出现 112.78% 这类刻度标签
  const limit = Math.max(Math.ceil(raw / step) * step, step);
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: rows.map((r) => shorten(r.name)),
      datasets: [
        {
          label: '持有收益率%',
          data: rows.map((r) => pct(r.returnRate)),
          backgroundColor: rows.map((r) =>
            r.returnRate == null ? 'transparent' : signColor(r.returnRate, 1),
          ),
          borderRadius: 4, // 圆角条
          barThickness: 26,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      animation: false,
      maintainAspectRatio: false, // 由 .chart-box.return 容器定高
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items.length > 0 ? rows[items[0].dataIndex].name : ''),
            // 打码出口：标签保留、读数遮蔽
            label: (ctx) =>
              masked
                ? `${ctx.dataset.label}：••••••`
                : `${ctx.dataset.label}：${ctx.raw == null ? '—' : (ctx.raw > 0 ? '+' : '') + ctx.raw.toFixed(2) + '%'}`,
          },
        },
      },
      scales: {
        x: {
          min: -limit,
          max: limit,
          ticks: {
            color: cssVar('--chart-tick', '#999'),
            font: { size: 10 },
            // 打码出口：横轴刻度遮蔽（等宽占位保持轴结构稳定）
            callback: (v) => (masked ? '•••' : v + '%'),
            // 范围足够宽时加倍步长，避免刻度过密（如 ±120 用 40 一格）
            stepSize: limit >= step * 6 ? step * 2 : step,
          },
          grid: { color: cssVar('--chart-grid', '#f0f0f0') },
        },
        y: {
          reverse: true, // 收益率最高显示在最上方
          ticks: {
            color: cssVar('--chart-tick', '#999'),
            font: { size: 11 },
          },
          grid: { display: false },
        },
      },
    },
    plugins: [valueLabels],
  });
  return canvas._chart;
}
