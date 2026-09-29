import {
  computeState,
  applyQuote,
  applyBuy,
  applySell,
  applyDividend,
  computeXIRR,
  buildFundFlows,
  findDuplicateTrade,
  missingTradeFields,
  buildEmptyFundAsset,
  unifyTradeMeta,
  normalizeFundName,
  pickFundCode,
} from './calculator.js';
import { createStore, createServerStore } from './store.js';
import { createQuoteService } from './quotes.js';
import { prepareOcrImage } from './ocr-image.js';
import { createTradingCalendar } from './tradingCalendar.js';
import {
  overseasIndexWindowOpen,
  formatIndexTime,
  marketStatusOf,
  marketOfIndex,
  marketPhaseOf,
  beijingToday,
  beijingMinutes,
} from './marketClock.js';
import { indexMonitorCardHtml } from './components/indexMonitorCard.js';
import {
  strategyBadgeHtml,
  strategyDetailHtml,
  strategyTimelineHtml,
} from './components/badgeRenderer.js';
import {
  STRATEGY_CFG_MODAL,
  CFG_FIELD_DEFS,
  CFG_RISK_OPTIONS,
  cfgDefaultOf,
  cfgDefaults,
  cfgToValues,
  cfgToConfig,
  cfgSafetyPad,
  cfgValidate,
  cfgDeviates,
} from './components/strategyConfigPanel.js';
import {
  renderNavChart,
  renderAssetChart,
  renderReturnCompareChart,
  renderHoldingChart,
} from './charts.js';
import { healthStripHtml } from './components/healthStrip.js';
import { buildEstimateBoard } from './components/estimateBoard.js';
import { displayChangePct } from './components/indexMonitorCard.js';
import {
  buildEstimateCurve,
  estimateCurveSvg,
  estimateCurveHitAt,
  CURVE_LAYOUT,
  METRICS,
  fmtCurveValue,
  EMPTY_REASON_TEXT,
  pnlBlockReason,
} from './components/estimateCurve.js';
import {
  maskText,
  loadBool,
  saveBool,
  loadBlockOrder,
  saveBlockOrder,
  visibleOrderOf,
  moveInOrder,
  dropInOrder,
} from './uiPrefs.js';
import {
  computeAttribution,
  computeConcentration,
  computeDrawdown,
  buildReportLines,
  redactAnalysisContext,
  buildReturnRows,
  buildProfitByDate,
  buildMonthCells,
  buildWeekCells,
  buildYearBlocks,
  dayDetailRows,
  parseISODate,
  isoDate,
  addDays,
  startOfWeek,
  bookArrivals,
  aggregateDaily,
  computeHoldingProfitSeries,
  resolveCorrections,
  buildPrincipalCorrection,
  pendingCorrections,
  auditPrincipalJumps,
} from './analysis.js';
import {
  buildPortfolioSummary,
  buildRealizedProfit,
  buildPortfolioFlows,
  sliceSeries,
  rangeStats,
  dayProfitState,
  SOURCE_GROUPS,
} from './portfolio.js';

const { createApp, ref, computed, reactive, onMounted, onUnmounted, nextTick, watch } = Vue;

const app = createApp({
  setup() {
    // ---- 存储后端：服务端优先（A1），启动探测不可达则回退 localStorage（老体验）----
    const localStorageStore = createStore();
    // 局域网口令：服务端 APP_TOKEN 开启后，前端从 localStorage 读取并随 /api/data 请求发送
    function apiHeaders() {
      try {
        const t = localStorage.getItem('fund-tracker-token');
        return t ? { 'X-App-Token': t } : {};
      } catch {
        return {};
      }
    }
    const serverStore = createServerStore({ baseUrl: '', getHeaders: apiHeaders });
    const storeMode = ref('local'); // 'server' | 'local'，initStore() 后确定
    const data = reactive({ assets: [], daily: [], ai_log: [], corrections: [] }); // daily：每日资产快照；ai_log：AI 解读历史（按日留存）；corrections：本金修正留痕（口径 Ⅰ）

    // ---- 主题与涨跌色 ----
    // 首访默认 = 跟随系统 prefers-color-scheme；手动选择后持久化覆盖；localStorage 不可用降级会话内变量。
    const sysDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const readPref = (key, fallback) => {
      try {
        return localStorage.getItem(key) || fallback;
      } catch {
        return fallback;
      }
    };
    const writePref = (key, v) => {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* 隐私模式：降级会话内变量 */
      }
    };
    let uiTheme = readPref('ui-theme', 'system'); // 'system' | 'light' | 'dark'
    const uiUpdown = ref(readPref('ui-updown', 'cn')); // 'cn' | 'intl' | 'soft'
    const themeLabel = ref('');
    const updownLabel = ref('');
    function applyTheme() {
      const eff = uiTheme === 'system' ? (sysDarkQuery.matches ? 'dark' : 'light') : uiTheme;
      document.documentElement.dataset.theme = eff;
      themeLabel.value = uiTheme === 'system' ? '跟随系统' : uiTheme === 'dark' ? '暗色' : '亮色';
    }
    function applyUpdown() {
      document.documentElement.dataset.updown = uiUpdown.value;
      updownLabel.value =
        uiUpdown.value === 'cn' ? '红涨绿跌' : uiUpdown.value === 'intl' ? '绿涨红跌' : '柔和国际';
    }
    // matchMedia 守卫：手动选择后绝不因系统切换被覆盖
    sysDarkQuery.addEventListener('change', () => {
      if (uiTheme !== 'system') return;
      applyTheme();
      nextTick(redrawVisibleCharts);
    });
    function toggleTheme() {
      uiTheme = uiTheme === 'system' ? 'light' : uiTheme === 'light' ? 'dark' : 'system';
      writePref('ui-theme', uiTheme);
      applyTheme();
      nextTick(redrawVisibleCharts);
    }
    function cycleUpdown() {
      uiUpdown.value = uiUpdown.value === 'cn' ? 'intl' : uiUpdown.value === 'intl' ? 'soft' : 'cn';
      writePref('ui-updown', uiUpdown.value);
      applyUpdown();
      nextTick(redrawVisibleCharts);
    }
    /** 主题/涨跌色切换后重建可见图表（token 化颜色即时生效）——
     *  含收益率对比图：其条形色在渲染时烘焙进 canvas，不随数据 watch 触发 */
    function redrawVisibleCharts() {
      if (navModal.value && !navModal.value.loading) renderNav();
      if (returnCanvas.value && returnRows.value.length > 0) renderReturn();
    }
    applyTheme();
    applyUpdown();

    // Ant Design Vue 主题 token：对齐自有调色板（--color-primary 支付宝橙红）
    const antTheme = {
      token: { colorPrimary: '#d4380d', colorLink: '#d4380d', borderRadius: 6, fontSize: 13 },
    };

    // 主基金表列配置：名称左固定、操作右固定；净值不固定（操作前最后一个可滚动列）；
    // 「当日」列合并收益(上)+涨幅(下)。窄屏列隐藏用 matchMedia 自行控制（见 fundColumnsShown）；
    // 手机断点（<560px）列宽整体收窄一档：名称/预警/当日/持有/本金/操作压缩，否则名称+操作
    // 就占满整个手机视口，中间的数据列全被挤出屏幕（fundColumnsShown 里按 isPhone 替换宽度）
    const PHONE_COL_WIDTHS = {
      name: 92,
      alert: 96,
      daily: 84,
      hold: 96,
      principal: 76,
      actions: 124,
    };
    const fundColumns = [
      { key: 'name', title: '基金名称', width: 120, fixed: 'left' },
      { key: 'alert', title: '预警', align: 'right', width: 150 },
      { key: 'daily', title: '当日', align: 'right', width: 130 },
      { key: 'hold', title: '持有收益', align: 'right', width: 160 },
      { key: 'principal', title: '本金', align: 'right', width: 120 },
      { key: 'yesterday', title: '昨日', align: 'right', width: 110, hideBelow: 'md' },
      { key: 'nav', title: '净值', align: 'right', width: 120, hideBelow: 'lg' },
      { key: 'actions', title: '操作', align: 'right', width: 190, fixed: 'right' },
    ];

    // 响应式断点：md=768px、lg=992px（matchMedia 实时跟随，窄屏隐藏次要列）；phone=560px 收窄列宽
    const mqMd = window.matchMedia('(min-width: 768px)');
    const mqLg = window.matchMedia('(min-width: 992px)');
    const mqPhone = window.matchMedia('(max-width: 559px)');
    const isMd = ref(mqMd.matches);
    const isLg = ref(mqLg.matches);
    const isPhone = ref(mqPhone.matches);
    const onMqMd = (e) => {
      isMd.value = e.matches;
    };
    const onMqLg = (e) => {
      isLg.value = e.matches;
    };
    const onMqPhone = (e) => {
      isPhone.value = e.matches;
    };

    const fundColumnsShown = computed(() => {
      const hidden = new Set();
      if (!isMd.value) hidden.add('yesterday');
      if (!isLg.value) hidden.add('nav');
      // 「昨日」列表头跟随数据日期：回退口径下值是最近净值日的，标题不能写「昨日」。
      // 返回新对象，不改动 fundColumns 本体（avoids 共享引用被就地改写）
      return fundColumns
        .filter((c) => !hidden.has(c.key))
        .map((c) => {
          let col = c;
          if (c.key === 'yesterday' && prevDayFallback.value) col = { ...col, title: '上一净值日' };
          if (isPhone.value && PHONE_COL_WIDTHS[c.key] != null)
            col = { ...col, width: PHONE_COL_WIDTHS[c.key] };
          return col;
        });
    });

    // 交易记录弹窗表列配置（全部常显，容器内横向滚动兜底）
    const txColumns = [
      { key: 'date', title: '日期', width: 110 },
      { key: 'type', title: '类型', align: 'right', width: 90 },
      { key: 'amount', title: '金额（元）', align: 'right', width: 120 },
      { key: 'shares', title: '份额', align: 'right', width: 100 },
      { key: 'actions', title: '操作', align: 'right', width: 110 },
    ];
    const needMigration = ref(false); // 服务端为空 & 本地有数据 → 提示一键上传
    const pendingSync = ref(false); // 断连期间改动暂存本地镜像

    let localSnapshot = null; // 启动时的本地数据快照（迁移源；镜像随后会被服务端数据覆盖，不能重读）

    async function initStore() {
      // 先快照本地数据再探测服务端——loadAssets 成功后会写镜像，
      // 若顺序颠倒，空服务端会先覆盖掉本地旧数据，迁移检测就永远读不到
      localSnapshot = localStorageStore.loadAssets();
      let remote = await serverStore.loadAssets();
      // 局域网模式：服务端要求口令（401）→ 询问一次并存入 localStorage 后重试
      if (serverStore.authRequired) {
        const t = prompt('服务已开启局域网访问口令（APP_TOKEN），请输入：');
        if (t) {
          try {
            localStorage.setItem('fund-tracker-token', t);
          } catch {
            /* 忽略 */
          }
          remote = await serverStore.loadAssets();
        }
      }
      if (serverStore.reachable) {
        storeMode.value = 'server';
        data.assets.splice(0, data.assets.length, ...remote.assets);
        data.daily = Array.isArray(remote.daily) ? remote.daily : [];
        data.ai_log = Array.isArray(remote.ai_log) ? remote.ai_log : [];
        data.corrections = Array.isArray(remote.corrections) ? remote.corrections : [];
        needMigration.value = remote.assets.length === 0 && localSnapshot.assets.length > 0;
      } else {
        storeMode.value = 'local';
        data.assets.splice(0, data.assets.length, ...localSnapshot.assets);
        data.daily = Array.isArray(localSnapshot.daily) ? localSnapshot.daily : [];
        data.ai_log = Array.isArray(localSnapshot.ai_log) ? localSnapshot.ai_log : [];
        data.corrections = Array.isArray(localSnapshot.corrections)
          ? localSnapshot.corrections
          : [];
      }
    }

    async function migrateLocalToServer() {
      const assets = localSnapshot?.assets ?? [];
      if (assets.length === 0) {
        needMigration.value = false;
        return;
      }
      const r = await serverStore.saveAssets({ assets });
      if (r.ok) {
        needMigration.value = false;
        data.assets.splice(0, data.assets.length, ...assets);
      } else {
        alert('上传失败，请确认服务正常后重试');
      }
    }

    // 持久化收敛：所有写入口都走这里（server 模式走服务端并同步镜像，local 模式走 localStorage）
    function persist() {
      if (storeMode.value !== 'server') {
        localStorageStore.saveAssets(data);
        return;
      }
      serverStore
        .saveAssets({
          assets: data.assets,
          daily: data.daily,
          ai_log: data.ai_log,
          corrections: data.corrections,
        })
        .then((r) => {
          pendingSync.value = !r.ok;
          if (r?.daily) {
            data.daily = r.daily;
          } // 采纳服务端合流后的 daily，防下次保存回滚台账新行
        })
        .catch((e) => {
          if (e.conflict) {
            alert('服务端数据已被其他窗口修改，请刷新页面后再操作（本机改动可先「导出」备份）');
          } else {
            pendingSync.value = true;
          }
        });
    }

    // 持仓名称回填：lsjz 行情不含名称，按代码查官方名称替换演示名/OCR 缺字名（每次进页面检查，无差异不写）
    async function backfillFundNames() {
      const codes = [
        ...new Set(
          data.assets
            .filter((a) => a.asset_type === 'fund' && /^\d{6}$/.test(a.code || ''))
            .map((a) => a.code),
        ),
      ];
      if (codes.length === 0) return;
      let names = {};
      try {
        const res = await fetch(`/api/fund-names?codes=${codes.join(',')}`, {
          headers: apiHeaders(),
        });
        if (res.ok) names = (await res.json()).names ?? {};
      } catch {
        return; // 离线/接口失败：跳过，下次进页面再试
      }
      let changed = false;
      for (const a of data.assets) {
        const official = names[a.code];
        if (official && a.name !== official) {
          a.name = official;
          changed = true;
        }
      }
      if (changed) persist();
    }

    // ---- 交易记录管理（列表 / 编辑 / 删除单笔）----
    const txModal = ref(null); // { fundId, name, code, list: [{idx, tx}] }
    const txEdit = ref(null); // 编辑模式：{ idx }，非 null 时交易表单为替换原记录

    function txLabel(tx) {
      if (tx.type === 'dividend') return tx.method === 'reinvest' ? '红利再投' : '现金分红';
      return tx.type === 'buy' ? '买入' : tx.type === 'sell' ? '卖出' : tx.type || '—';
    }

    function openTxModal(f) {
      openModalFocus('.modal-overlay [data-modal="tx"]');
      txModal.value = {
        fundId: f.id,
        name: f.name,
        code: f.code,
        list: f.transactions
          .map((tx, idx) => ({ idx, tx }))
          .sort((a, b) => (a.tx.date || '').localeCompare(b.tx.date || '')),
      };
    }

    function refreshTxModal() {
      if (!txModal.value) return;
      const fund = data.assets.find((a) => a.id === txModal.value.fundId);
      if (!fund) {
        txModal.value = null;
        return;
      }
      txModal.value.list = fund.transactions
        .map((tx, idx) => ({ idx, tx }))
        .sort((a, b) => (a.tx.date || '').localeCompare(b.tx.date || ''));
    }

    function deleteTx(item) {
      const fund = data.assets.find((a) => a.id === txModal.value?.fundId);
      if (!fund) return;
      const tx = fund.transactions[item.idx];
      const ok = confirm(
        `确定删除这笔「${txLabel(tx)} ${tx.date || ''}」记录吗？\n删除后本金与收益将按剩余记录重新计算。`,
      );
      if (!ok) return;
      fund.transactions.splice(item.idx, 1);
      persist();
      refreshTxModal();
    }

    function editTx(item) {
      const fund = data.assets.find((a) => a.id === txModal.value?.fundId);
      const tx = fund?.transactions[item.idx];
      if (!tx) return;
      txEdit.value = { idx: item.idx };
      tradeForm.fundId = fund.id;
      tradeForm.type = tx.type;
      tradeForm.amount = tx.amount != null ? String(tx.amount) : '';
      tradeForm.shares = tx.shares != null ? String(tx.shares) : '';
      tradeForm.date = tx.date || tradeForm.date;
      tradeForm.dividendMethod = tx.method || 'cash';
      ocrImage.value = null;
      ocrMsg.value = '';
      ocrIsErr.value = false;
      txModal.value = null; // 关列表，开编辑表单
      showTradeForm.value = true;
    }

    const activeCategory = ref('fund');

    // ---- 策略参数配置弹窗（逻辑在 components/strategyConfigPanel.js，此处只接线）----
    const cfgModal = ref(null); // { fundId, name, code, unconfigured }
    const cfgOpenSections = ref(['trailing', 'xirr', 'stops']);
    const cfg = reactive({
      enabled: true,
      riskClass: 'balanced',
      addEnabled: false,
      profitGate: false,
      values: {},
      dirty: {},
    });
    const cfgConfirm = reactive({ open: false, field: null });
    const cfgAsked = {}; // 偏离确认每字段只问一次（会话内）
    const cfgSavedOk = ref(false);
    let cfgSwitching = false; // 载入/预设切换期间挂起 dirty 与偏离确认 watch
    const cfgIsStable = computed(() => cfg.riskClass === 'stable');

    function cfgDef(key) {
      return cfgDefaultOf(key, cfg.riskClass);
    }
    function cfgFieldsOf(sec) {
      return CFG_FIELD_DEFS.filter((f) => {
        if (f.sec !== sec) return false;
        if (sec === 'add') {
          if (cfgIsStable.value) return false; // 稳健类无加仓区：字段整体隐藏
          if (['addTop', 'addStep', 'addBottom'].includes(f.key)) return cfg.addEnabled; // 档位参数随开关显隐
        }
        return true;
      });
    }
    const cfgIsCustom = (key) => !!cfg.dirty[key];
    const cfgSafety = computed(() => cfgSafetyPad(cfg.values));
    const cfgErrors = computed(() => cfgValidate(cfg.values, cfg.riskClass));
    const cfgCanSave = computed(() => cfgSafety.value.ok && cfgErrors.value.length === 0);
    const cfgCustomizedList = computed(() =>
      CFG_FIELD_DEFS.filter((f) => cfg.dirty[f.key]).map((f) => f.label.replace(/（.*）/, '')),
    );
    const cfgCustomizedCount = computed(() => cfgCustomizedList.value.length);

    function openCfgModal(f) {
      const fund = data.assets.find((a) => a.id === f.id);
      if (!fund) return;
      cfgSwitching = true;
      const st = cfgToValues(fund.strategy_config);
      cfg.enabled = st.enabled;
      cfg.riskClass = st.riskClass;
      cfg.addEnabled = st.addEnabled;
      cfg.profitGate = st.profitGate;
      cfg.values = st.values;
      // 自定义标记 = 已保存 customFlags ∪ 当前值对预设的偏离（旧数据无 customFlags 也能正确点亮）
      const dirty = {};
      for (const fd of CFG_FIELD_DEFS) {
        const saved = fund.strategy_config?.customFlags?.[fd.key];
        if (saved || cfgDeviates(st.values[fd.key], cfgDefaultOf(fd.key, st.riskClass)))
          dirty[fd.key] = true;
      }
      cfg.dirty = dirty;
      for (const k of Object.keys(cfgAsked)) delete cfgAsked[k];
      cfgSavedOk.value = false;
      cfgConfirm.open = false;
      cfgModal.value = {
        fundId: fund.id,
        name: fund.name,
        code: fund.code,
        unconfigured: !fund.strategy_config,
      };
      setTimeout(() => {
        cfgSwitching = false;
      }, 50);
    }
    function cfgCancel() {
      cfgModal.value = null;
    }

    watch(
      () => cfg.values,
      () => {
        if (cfgSwitching) return;
        if (cfgSavedOk.value) cfgSavedOk.value = false;
        // dirty 跟随实际改动（改回默认自动摘除）；偏离确认每字段一次
        for (const fd of CFG_FIELD_DEFS) {
          const v = cfg.values[fd.key];
          if (fd.noDefault) {
            if (v != null) cfg.dirty[fd.key] = true;
            else delete cfg.dirty[fd.key];
            continue;
          }
          const d = cfgDef(fd.key);
          if (d == null || v == null) continue;
          if (Math.abs(v - d) > 1e-9) cfg.dirty[fd.key] = true;
          else delete cfg.dirty[fd.key];
        }
        for (const fd of CFG_FIELD_DEFS) {
          if (fd.noDefault || cfgAsked[fd.key] || !cfg.dirty[fd.key]) continue;
          if (cfgDeviates(cfg.values[fd.key], cfgDef(fd.key))) {
            cfgAsked[fd.key] = true;
            cfgConfirm.field = fd;
            cfgConfirm.open = true;
            break;
          }
        }
      },
      { deep: true },
    );

    function cfgOnRiskClassChange() {
      cfgSwitching = true;
      for (const fd of CFG_FIELD_DEFS) {
        if (fd.preset && !cfg.dirty[fd.key]) {
          const v = cfgDef(fd.key); // 未自定义的预设字段跟随新风险类型
          if (v != null) cfg.values[fd.key] = v;
        }
      }
      if (cfgIsStable.value) {
        cfg.addEnabled = false;
        cfg.values.reserveCash = null;
        delete cfg.dirty.reserveCash;
      }
      setTimeout(() => {
        cfgSwitching = false;
      }, 50);
    }
    function cfgConfirmKeep() {
      cfgConfirm.open = false;
    }
    function cfgConfirmRevert() {
      if (cfgConfirm.field) cfg.values[cfgConfirm.field.key] = cfgDef(cfgConfirm.field.key);
      cfgConfirm.open = false;
    }
    function cfgResetAll() {
      cfgSwitching = true;
      cfg.values = cfgDefaults(cfg.riskClass);
      cfg.addEnabled = false;
      cfg.profitGate = false;
      cfg.dirty = {};
      for (const k of Object.keys(cfgAsked)) delete cfgAsked[k];
      cfgSavedOk.value = false;
      setTimeout(() => {
        cfgSwitching = false;
      }, 50);
    }
    function cfgSave() {
      if (!cfgModal.value || !cfgCanSave.value) return;
      const fund = data.assets.find((a) => a.id === cfgModal.value.fundId);
      if (!fund) {
        cfgModal.value = null;
        return;
      }
      fund.strategy_config = cfgToConfig({
        enabled: cfg.enabled,
        riskClass: cfg.riskClass,
        addEnabled: cfg.addEnabled,
        profitGate: cfg.profitGate,
        values: cfg.values,
        dirtyFlags: cfg.dirty,
      });
      cfgModal.value.unconfigured = false;
      persist();
      cfgSavedOk.value = true;
    }
    function cfgBacktestHint() {
      if (!cfgModal.value) return;
      antd.message.info(
        `回测此配置：node tools/backtest-strategy.mjs --yes --code ${cfgModal.value.code}（自定义参数组即读本配置）`,
      );
    }

    // ---- 策略预警落地：七态徽章 + 详情卡 + 触发时间线 ----
    // 数据：/api/strategy/status（只读实时七态，badgeRenderer 渲染）+ /api/strategy/alerts（触发快照时间线）；
    // 徽章点击 → 详情卡（人话三段式 + 效果预演 + 已执行/忽略，ack 驱动 State Demotion）。
    const strategyStatus = ref({ byCode: {}, ts: null, loading: false, err: null });
    const strategyAlerts = ref({ list: [], ts: null, loading: false });
    const strategyDetail = ref(null); // { entry, name, detailHtml, ackState, ackNavDate }
    const strategyTimeline = ref('');
    const apiGet = async (url) => {
      const r = await fetch(url, { headers: apiHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    async function refreshStrategyStatus() {
      if (storeMode.value !== 'server') return; // 本地模式无策略服务
      strategyStatus.value.loading = true;
      try {
        const payload = await apiGet('/api/strategy/status');
        const byCode = {};
        for (const f of payload.funds || []) byCode[f.code] = f;
        strategyStatus.value = { byCode, ts: payload.ts, loading: false, err: null };
      } catch (e) {
        strategyStatus.value = {
          ...strategyStatus.value,
          loading: false,
          err: String(e.message || e),
        };
      }
    }
    async function refreshStrategyAlerts() {
      if (storeMode.value !== 'server') return;
      strategyAlerts.value.loading = true;
      try {
        const payload = await apiGet('/api/strategy/alerts?limit=20');
        strategyAlerts.value = { list: payload.alerts || [], ts: payload.ts, loading: false };
        strategyTimeline.value = strategyTimelineHtml(payload.alerts || []);
      } catch {
        strategyAlerts.value.loading = false;
      }
    }
    // ---- 首页三区块排序 + 资产总览偏好 ----
    // 资产总览已迁入收益页 M1，BLOCK_KEYS 收缩为 health/idx（summary 键由 parseBlockOrder 白名单兼容）
    const blockOrder = ref(loadBlockOrder(localStorage));
    watch(blockOrder, (v) => saveBlockOrder(localStorage, 'ui-block-order', v), { deep: true });
    // 可见块：隐藏块（本地模式无健康条 / 无指数无指数卡）不占排序槽位，
    // 否则 ↑↓ 会与被隐藏的邻居互换——首次点击无任何视觉变化、首尾禁用态也会误判。
    const blockVisible = computed(() => ({
      health: storeMode.value === 'server',
      idx: indexes.value.length > 0,
    }));

    // ---- 视图态与 hash 路由（收益页）----
    const viewMode = ref(location.hash === '#/returns' ? 'returns' : 'board'); // 直链/F5 保位
    const scrollMemo = { board: 0, returns: 0 };
    function setView(p) {
      if (viewMode.value === p) return;
      scrollMemo[viewMode.value] = window.scrollY; // 各页保留自己的滚动位置
      viewMode.value = p;
      location.hash = p === 'returns' ? '#/returns' : '#/';
      nextTick(() => {
        if (p === 'returns') renderReturnsCharts();
        window.scrollTo(0, scrollMemo[p] || 0);
      });
    }
    const onHashChange = () => setView(location.hash === '#/returns' ? 'returns' : 'board');

    // 三态当日收益：30s 心跳驱动墙钟判定自动迁移（盘前→预估→更新中→已更新）
    const clockTick = ref(0);
    const profitState = computed(() => {
      clockTick.value; // 心跳依赖收集：跨过 9:30/15:00/22:00 边界时标签自动变化
      return dayProfitState({
        now: new Date(),
        isTradingDay: tradingDayFlag.value === false ? false : true,
        flipMinute: 22 * 60,
      });
    });
    const profitStateLabel = computed(
      () =>
        ({
          closed: '休市',
          prevday: '已确认',
          est: '预估',
          mixed: '更新中',
          done: '已更新',
        })[profitState.value],
    );
    const visibleOrder = computed(() => visibleOrderOf(blockOrder.value, blockVisible.value));
    const orderCtxOf = (key) => ({
      pos: visibleOrder.value.indexOf(key),
      len: visibleOrder.value.length,
    });
    const summaryHidden = ref(loadBool(localStorage, 'ui-summary-hidden'));
    const summaryCollapsed = ref(loadBool(localStorage, 'ui-summary-collapsed'));
    watch(summaryHidden, (v) => saveBool(localStorage, 'ui-summary-hidden', v));
    watch(summaryCollapsed, (v) => saveBool(localStorage, 'ui-summary-collapsed', v));
    function onDragStart(e) {
      const blk = e.target.closest('.drag')?.closest('[data-blk]');
      if (!blk) return;
      e.dataTransfer.setData('text/plain', blk.dataset.blk);
    }
    function onDrop(e) {
      e.preventDefault(); // Firefox 对 text/plain 落放默认走搜索/导航，必须阻止
      const sourceKey = e.dataTransfer.getData('text/plain');
      const targetKey = e.target.closest('.blk')?.dataset?.blk;
      blockOrder.value = dropInOrder(blockOrder.value, blockVisible.value, sourceKey, targetKey);
    }
    function onSummaryHeadClick(e) {
      // 参考核心指数监控：头部点击折叠/展开；操作按钮（眼睛/收起按钮/排序手柄）自身已处理，不触发折叠
      if (e.target.closest('.icon-btn, .sp-fold-btn, .handles')) return;
      summaryCollapsed.value = !summaryCollapsed.value;
    }
    // 键盘折叠：仅事件源为头部自身时才响应——内部按钮（眼睛/收起/↑↓ 手柄）自带 Enter/Space 激活，
    // 若在此无条件 preventDefault 会连它们的原生激活一起吞掉（回车点了没反应）
    function onSummaryHeadKey(e) {
      if (e.target.closest('.icon-btn, .sp-fold-btn, .handles')) return;
      e.preventDefault();
      summaryCollapsed.value = !summaryCollapsed.value;
    }
    function onMoveClick(e) {
      if (e.target.closest('[data-idx-retry]')) return retryIndexSource(); // 09-11：指数源重试（v-html 内事件委托）
      const mv = e.target.closest('[data-move]');
      if (!mv || mv.disabled) return;
      const key = mv.closest('[data-blk]')?.dataset?.blk;
      if (!key) return;
      const dir = Number(mv.dataset.move);
      blockOrder.value = moveInOrder(blockOrder.value, blockVisible.value, key, dir); // 越界/未知 key 内部已兜底（原顺序）
    }

    // ---- 数据健康块：汇总卡与主表之间的数据源细条 ----
    // healthStrip 以 computed 注入 orderCtx；未就绪/失败走组件骨架（首屏即有 .health 容器，无 CLS）
    const sourceHealth = ref(null); // /api/source-health 载荷
    // 指数主源重试：进行中态 + 结果 flash（4 秒后自动消失）
    const indexRetryBusy = ref(false);
    const indexRetryFlash = ref(null);
    let indexRetryFlashTimer = null;
    const healthStrip = computed(() => {
      if (storeMode.value !== 'server') return ''; // 本地模式无服务端，整体隐藏（既有约定）
      return healthStripHtml(
        sourceHealth.value?.sources ?? null,
        sourceHealth.value?.ts ?? null,
        orderCtxOf('health'),
        { retrying: indexRetryBusy.value, flash: indexRetryFlash.value },
      );
    });
    async function refreshSourceHealth() {
      if (storeMode.value !== 'server') {
        sourceHealth.value = null;
        return;
      }
      try {
        sourceHealth.value = await apiGet('/api/source-health');
      } catch {
        sourceHealth.value = null; // 接口失败 → .health 容器 + "健康信息暂不可用"
      }
    }
    function showIndexRetryFlash(cls, text) {
      indexRetryFlash.value = { cls, text };
      clearTimeout(indexRetryFlashTimer);
      indexRetryFlashTimer = setTimeout(() => {
        indexRetryFlash.value = null;
      }, 4000);
    }
    /**
     * "重试指数源"（运维入口，/api/index?refresh=1 前端落点）：复位服务端熔断，绕过5min缓存重探push2。
     * 成功后刷新健康条、指数卡，按push2实际状态展示内联反馈；切换网络时可使用，无需重启服务。
     */
    async function retryIndexSource() {
      if (indexRetryBusy.value) return;
      indexRetryBusy.value = true;
      indexRetryFlash.value = null;
      clearTimeout(indexRetryFlashTimer);
      try {
        await apiGet('/api/index?refresh=1'); // 带本页 token 头；该变体免鉴权，冷却内平滑返回缓存
        await Promise.all([refreshSourceHealth(), loadIndexes()]);
        const t = (v) => {
          const n = v ? new Date(v).getTime() : 0;
          return Number.isFinite(n) ? n : 0;
        };
        const p = sourceHealth.value?.sources?.push2 || {};
        const recovered = !!p.lastOkAt && t(p.lastOkAt) >= t(p.lastErrAt);
        showIndexRetryFlash(
          recovered ? 'ok' : 'warn',
          recovered ? '指数主源已恢复（东财 push2）' : '主源仍不可用——继续走新浪备源',
        );
      } catch (e) {
        showIndexRetryFlash('warn', `重试失败：${e.message || e}`);
      } finally {
        indexRetryBusy.value = false;
      }
    }
    // ---- 七态汇总（未处理有效动作数）----
    const ACTION_STATES = ['EXIT', 'STOP_LOSS', 'TAKE_PROFIT', 'ADD'];
    const strategyActionCount = computed(() => {
      const by = strategyStatus.value.byCode || {};
      return Object.values(by).filter((f) => ACTION_STATES.includes(f.state) && !f.ignored).length;
    });
    const strategyActionSummary = computed(() => {
      const by = strategyStatus.value.byCode || {};
      const sum = { exit: 0, stopLoss: 0, takeProfit: 0, add: 0 };
      for (const f of Object.values(by)) {
        if (f.ignored) continue; // 已忽略本轮不计入（后端收敛布尔）
        if (f.state === 'EXIT') sum.exit++;
        else if (f.state === 'STOP_LOSS') sum.stopLoss++;
        else if (f.state === 'TAKE_PROFIT') sum.takeProfit++;
        else if (f.state === 'ADD') sum.add++;
      }
      return sum;
    });
    async function runStrategyNow() {
      try {
        const r = await fetch('/api/strategy/evaluate-now', {
          method: 'POST',
          headers: apiHeaders(),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        antd.message.info(`巡检完成：评估 ${data.evaluated} 只，新增触发 ${data.events} 条`);
        await Promise.all([refreshStrategyStatus(), refreshStrategyAlerts()]);
      } catch (e) {
        antd.message.error(`巡检失败：${e.message}`);
      }
    }
    function strategyEntryOf(record) {
      return strategyStatus.value.byCode[record.code] ?? null;
    }
    function strategyBadgeOf(record) {
      const entry = strategyEntryOf(record);
      if (!entry) {
        // 本地模式（localStorage）无策略引擎、永不评估——说明真实原因，不写"打开页面后自动评估"误导
        const sub =
          storeMode.value === 'server'
            ? '打开页面后自动评估'
            : '本地模式无策略引擎——启动服务（npm start）后自动评估';
        return `<div class="al"><div class="al-top"><span class="badge hold dim">未评估</span></div><span class="al-sub">${sub}</span></div>`;
      }
      return strategyBadgeHtml(entry);
    }
    function openStrategyDetail(record) {
      const entry = strategyEntryOf(record);
      if (!entry || entry.error) {
        antd.message.info(
          entry?.error
            ? `策略数据暂不可用：${entry.error}`
            : storeMode.value === 'server'
              ? '尚未评估（稍后自动刷新）'
              : '本地模式无策略引擎——启动服务（npm start）后自动评估',
        );
        return;
      }
      // navLag 与主表 navIsLagged 同口径：净值日落后组合最新数据日的基金（QDII 等）在详情头部出滞后角标
      const d = strategyDetailHtml({ ...entry, navLag: navIsLagged(record.state) });
      strategyDetail.value = {
        entry,
        name: entry.name ?? record.name,
        html: d.html,
        ackState: d.ackState,
        ackNavDate: d.ackNavDate,
      };
    }
    async function ackStrategy() {
      const d = strategyDetail.value;
      if (!d?.ackState) return;
      try {
        const r = await fetch('/api/strategy/ack', {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: d.entry.code, state: d.ackState, navDate: d.ackNavDate }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        antd.message.success('已标记执行——冷却期内不重复提醒，徽章转"锁定中"');
        strategyDetail.value = null;
        await refreshStrategyStatus();
      } catch (e) {
        antd.message.error(`标记失败：${e.message}`);
      }
    }
    // 详情卡按钮是 v-html 注入的裸 HTML（无 Vue 绑定），用事件委托接"关闭/已执行/忽略/复制备忘"
    function onStrategyDetailClick(e) {
      if (e.target.closest('[data-sd-close]')) {
        strategyDetail.value = null;
        return;
      } // 关闭钮在稿内 .sd-side 流内（雷达→药丸→✕）
      if (e.target.closest('[data-strategy-ignore]')) ignoreStrategy();
      if (e.target.closest('[data-strategy-ack]')) ackStrategy();
      if (e.target.closest('[data-reset-tier]'))
        resetStrategyTier(Number(e.target.closest('[data-reset-tier]').dataset.resetTier));
      if (e.target.closest('[data-reset-tiers]')) resetStrategyTiers();
      if (e.target.closest('[data-correct-reserve]'))
        correctStrategyReserve(e.target.closest('[data-correct-reserve]'));
      const copyBtn = e.target.closest('[data-copy-memo]');
      if (copyBtn) copyTradeMemo(copyBtn.dataset.copyMemo || '', copyBtn);
    }
    // 一键复制交易备忘：非安全上下文回退 textarea+execCommand
    async function copyTradeMemo(text, btn) {
      if (!text) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (_) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {
          ok = false;
        }
      }
      if (ok) {
        antd.message.success(
          `已复制交易备忘：${text}（2.6 秒后消失，可去代销平台下单时粘贴）`,
          2.6,
        );
        if (btn) {
          const old = btn.textContent;
          btn.textContent = '✓';
          btn.disabled = true;
          setTimeout(() => {
            btn.textContent = old;
            btn.disabled = false;
          }, 2600);
        }
      } else {
        antd.message.warning(`请手动复制：${text}`, 5);
      }
    }

    // ---- 人工纠偏通道：忽略持久化 + 消耗位重置 + reserveUsed 校正 ----
    async function ignoreStrategy() {
      const d = strategyDetail.value;
      if (!d?.ackState) return;
      try {
        const r = await fetch('/api/strategy/ignore', {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: d.entry.code, state: d.ackState, navDate: d.ackNavDate }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        antd.message.success('已忽略——本轮不再提醒（徽章照常显示真实状态，冷却窗口后再次提醒）');
        strategyDetail.value = null;
        await refreshStrategyStatus();
      } catch (e) {
        antd.message.error(`忽略失败：${e.message}`);
      }
    }
    async function resetStrategyTier(tier) {
      const d = strategyDetail.value;
      if (!d) return;
      try {
        const r = await fetch('/api/strategy/reset-tiers', {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: d.entry.code, tier }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({}));
          throw new Error(p.detail || `HTTP ${r.status}`);
        }
        antd.message.success(`已重置 ${tier}% 台阶——满足条件将重新建议`);
        await refreshStrategyStatus();
      } catch (e) {
        antd.message.error(`重置失败：${e.message}`);
      }
    }
    async function resetStrategyTiers() {
      const d = strategyDetail.value;
      if (!d) return;
      if (!confirm('重置全部已消耗台阶？重置后满足条件将重新提醒。')) return;
      try {
        const r = await fetch('/api/strategy/reset-tiers', {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: d.entry.code }),
        });
        if (!r.ok) {
          const p = await r.json().catch(() => ({}));
          throw new Error(p.detail || `HTTP ${r.status}`);
        }
        antd.message.success('已全部重置');
        await refreshStrategyStatus();
      } catch (e) {
        antd.message.error(`重置失败：${e.message}`);
      }
    }
    async function correctStrategyReserve(btnEl) {
      const d = strategyDetail.value;
      if (!d) return;
      const input = btnEl.parentElement?.querySelector('[data-correct-value]');
      const raw = input ? Number(input.value) : NaN;
      if (!Number.isFinite(raw)) {
        antd.message.error('请输入有效金额');
        return;
      }
      if (d.entry.cap != null && (raw < 0 || raw > d.entry.cap)) {
        antd.message.error(`超出上限（0 ~ ${d.entry.cap} 元），已拒绝保存`);
        return;
      } // 前端预提示，服务端仍严格校验
      try {
        const r = await fetch('/api/strategy/correct-reserve', {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: d.entry.code, reserveUsed: raw }),
        });
        if (!r.ok) {
          const payload = await r.json().catch(() => ({}));
          throw new Error(payload.detail || `HTTP ${r.status}`);
        }
        antd.message.success('已校正——下次巡检按新值计算建议额');
        await refreshStrategyStatus();
      } catch (e) {
        antd.message.error(`校正失败：${e.message}`);
      }
    }

    // ---- 单基金走势弹窗（点击列表行触发，数据 /api/history；双 Tab：净值走势 + 持有收益走势）----
    const navModal = ref(null); // { fund, loading, error, range, series, tab }
    const navCanvas = ref(null);

    // 弹窗焦点管理：打开时聚焦弹窗容器（键盘流从弹窗内开始 Tab），关闭时还原触发点
    let lastModalTrigger = null;
    function openModalFocus(selector) {
      lastModalTrigger = document.activeElement;
      nextTick(() => document.querySelector(selector)?.focus());
    }
    function closeModalRestore() {
      if (lastModalTrigger instanceof HTMLElement) lastModalTrigger.focus();
      lastModalTrigger = null;
    }
    /** 主表行键盘入口：Enter/Space 等价行点击（净值弹窗） */
    function fundRowKeydown(e, r) {
      if (e.key === 'Enter' || e.key === ' ') openNavModal(r);
    }
    async function openNavModal(f) {
      openModalFocus('.modal-overlay [data-modal="nav"]');
      navModal.value = { fund: f, loading: true, error: null, range: 30, series: [], tab: 'nav' };
      const r = await quoteService.fetchHistory(f.code, 90);
      if (!navModal.value || navModal.value.fund.code !== f.code) return; // 已关闭/切换
      navModal.value.loading = false;
      navModal.value.error = r.error ?? null;
      navModal.value.series = r.series;
      await nextTick();
      renderNav();
    }

    const navSeries = computed(() =>
      navModal.value ? navModal.value.series.slice(-navModal.value.range) : [],
    );
    const navRangeChange = computed(() => {
      const s = navSeries.value;
      if (s.length < 2) return null;
      const pct = ((s[s.length - 1].nav - s[0].nav) / s[0].nav) * 100;
      return (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
    });

    // 持有收益 Tab：按日回放——输入即当前展示窗口的净值序列，窗口前交易在首点并入基线
    const navHoldingSeries = computed(() => {
      if (!navModal.value || navModal.value.tab !== 'hold') return [];
      return computeHoldingProfitSeries(
        navModal.value.fund.snapshot,
        navModal.value.fund.transactions,
        navSeries.value,
      );
    });
    // 空态文案分流在接线层：纯函数只返回数据
    const navHoldingEmpty = computed(() => {
      if (!navModal.value || navModal.value.tab !== 'hold') return null;
      const snap = navModal.value.fund.snapshot || {};
      const shares = snap.hold_shares ?? snap.holdShares ?? 0; // 仓库契约恒 snake_case，驼峰兜底防重构
      const invested = snap.total_invested ?? snap.totalInvested ?? 0;
      if (navSeries.value.length < 2 || navHoldingSeries.value.length === 0)
        return '净值历史不足，无法绘制'; // 后者兜全部净值点无效的防御场景
      if (!(shares > 0) && !(invested > 0) && !navModal.value.fund.transactions?.length)
        return '未持有该基金（快照与交易均为空）';
      return null;
    });
    const navHoldingLatest = computed(() => {
      const s = navHoldingSeries.value;
      return s.length ? s[s.length - 1].profit : null;
    });
    // 图注只在图表确实绘制时显示：加载中 / 接口失败 / 净值不足 / 未持有 → 是空态提示，不该配"虚线"说明
    const navCaption = computed(() => {
      const m = navModal.value;
      if (!m || m.loading) return '';
      if (m.tab === 'nav') {
        if (m.error || navSeries.value.length === 0) return '';
        return (m.fund.state?.costPrice ?? 0) > 0
          ? '虚线为持仓成本（摊薄）——净值高于虚线 = 浮盈，低于 = 浮亏'
          : '';
      }
      if (m.error || navHoldingEmpty.value) return '';
      return '虚线为持仓成本（收益归零线）——上方浮盈，下方浮亏';
    });

    function renderNav() {
      if (navCanvas.value && navModal.value) {
        if (navModal.value.tab === 'hold') {
          renderHoldingChart(navCanvas.value, navHoldingSeries.value);
        } else {
          renderNavChart(navCanvas.value, navSeries.value, navModal.value.fund.state.costPrice);
        }
      }
    }

    function setRange(r) {
      if (navModal.value) {
        navModal.value.range = r;
        nextTick(renderNav);
      }
    }

    function setFundTab(t) {
      if (navModal.value) {
        navModal.value.tab = t;
        nextTick(renderNav);
      }
    }

    // 弹窗内近 90 日最大回撤
    const navDrawdown = computed(() => {
      if (!navModal.value) return null;
      const dd = computeDrawdown(navModal.value.series);
      return dd.maxDrawdown == null ? null : (dd.maxDrawdown * 100).toFixed(1) + '%';
    });

    const categories = [
      { key: 'fund', label: '基金', enabled: true },
      { key: 'gold_etf', label: '黄金ETF', enabled: false },
      { key: 'gold_accum', label: '黄金积存金', enabled: false },
    ];

    /** 删除基金：连同快照与交易记录一并移除；confirm 确认后走统一持久化 */
    function deleteFund(fund) {
      const ok = confirm(
        `确定删除「${fund.name}（${fund.code}）」吗？\n将同时删除其快照与全部交易记录，且不可撤销。\n（删除前可先点"导出"备份）`,
      );
      if (!ok) return;
      const idx = data.assets.findIndex((a) => a.id === fund.id);
      if (idx >= 0) {
        data.assets.splice(idx, 1);
        persist();
      }
    }

    // ---- 行情状态：打开拉取 + 净值发布时段轮询 + 失败降级 ----
    const quoteService = createQuoteService({ baseUrl: '' });
    const quotesMap = ref({}); // code → quote
    const quoteStatus = ref('loading'); // loading | ok | failed
    const quoteFetchedAt = ref(null);

    function todayStr() {
      return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
    }

    // 行情轮询时段：交易日 9:30 起（盘中估值随行情更新 + 晚间确认净值发布），节假日按 A 股交易日历跳过
    const tradingCalendar = createTradingCalendar();
    const tradingDayCache = { date: null, ok: true }; // 未知日期按工作日粗判（乐观，下一轮校正）
    async function refreshTradingDay() {
      const d = todayStr();
      if (tradingDayCache.date === d) return;
      tradingDayCache.date = d;
      tradingDayCache.ok = await tradingCalendar.isTradingDay(d);
      tradingDayFlag.value = tradingDayCache.ok !== false; // 未决/非法（null）→ 保持 true（宁可不报"非交易日"）
    }
    function inQuoteWindow() {
      const now = new Date();
      return (
        now.getDay() >= 1 &&
        now.getDay() <= 5 &&
        now.getHours() * 60 + now.getMinutes() >= 570 && // 9:30
        tradingDayCache.ok
      );
    }

    // 计算当前品类下所有基金的当前状态（离线口径 + 行情口径合并）
    const fundStates = computed(() => {
      return data.assets
        .filter((a) => a.asset_type === 'fund')
        .map((a) => {
          const state = computeState(a.snapshot, a.transactions);
          const quote = quotesMap.value[a.code];
          const merged = quote
            ? applyQuote(state, quote, todayStr(), a.name)
            : {
                ...state,
                latestNav: null,
                navDate: null,
                mode: null,
                dailyProfit: null,
                dailyChangePct: null,
                yesterdayProfit: null,
              };
          merged.returnRate =
            merged.totalInvested > 0 ? merged.holdProfit / merged.totalInvested : null;
          merged.xirr = computeXIRR(buildFundFlows(a, merged, todayStr()));
          return { ...a, state: merged };
        });
    });

    // 汇总：投入总本金 / 当日收益（副行昨日）/ 持有收益 / 总资产
    // 汇总层接线：委托 buildPortfolioSummary（首页收益条与收益页 M1 同源），
    // 字段名映射保持现网契约，首页既有数字一字不变（接线验收基线）。
    const summary = computed(() => {
      const states = fundStates.value.map((f) => ({
        assetType: f.asset_type ?? 'fund',
        invested: f.state.totalInvested,
        value: f.state.latestNav != null ? f.state.holdShares * f.state.latestNav : null,
        holdProfit: f.state.holdProfit,
        dailyProfit: f.state.dailyProfit,
        dayProfit: f.state.dayProfit,
        prevDayProfit: f.state.prevDayProfit,
      }));
      const s = buildPortfolioSummary(states, { totalRealizedProfit: realizedProfit.value });
      // totalYesterdayProfit 保持现网口径（Σ state.yesterdayProfit 原始昨日变动，非日期对齐的
      // prevDayProfit——后者周日为 null，会让 AI 报告的"前一日"副注在周末消失，v9 自检修复）
      const yesterdays = fundStates.value
        .map((f) => f.state.yesterdayProfit)
        .filter((v) => v != null);
      return {
        totalInvested: s.total.invested,
        totalHoldProfit: s.total.holdProfit,
        returnRate: s.total.returnRate,
        totalDailyProfit: s.total.dailyProfit,
        totalYesterdayProfit:
          yesterdays.length > 0 ? yesterdays.reduce((acc, v) => acc + v, 0) : null,
        totalAssets: s.total.value,
        totalDayProfit: s.total.dayProfit,
        totalPrevDayProfit: s.total.prevDayProfit,
        anyEstimate: fundStates.value.some((f) => f.state.mode === 'estimate'),
        portfolio: s, // 收益条 / 收益页 M1·M5 消费（三态取数契约）
      };
    });

    // portfolio.groups 仍保留全部 SOURCE_GROUPS 供总计口径使用，过滤只发生在展示层。
    const m5Groups = computed(() => summary.value.portfolio.groups.filter((g) => g.supported));

    // 组合最新数据日期：数据日期落后于此的基金（QDII 等），其"当日/昨日"列按自己的数据日口径，加角标提示
    const maxNavDate = computed(() => {
      const dates = fundStates.value
        .map((f) => f.state.dataDate ?? f.state.navDate)
        .filter(Boolean);
      return dates.length > 0 ? dates.reduce((m, d) => (d > m ? d : m)) : null;
    });
    function navIsLagged(state) {
      const d = state?.dataDate ?? state?.navDate;
      return !!maxNavDate.value && !!d && d < maxNavDate.value;
    }

    // 「昨日」口径（周末与长假时会显示周五的数）：
    // prevDayProfit 依 nav_date 与 today 的关系在 js/calculator.js 给出，周末/长假/周一盘前为 null，
    // 汇总层回退到 dailyProfit（= 最近净值日的单日变动，js/portfolio.js:89）。
    // 该回退保留信息但会让「昨日」这个标签失真——此时数值属于「最近净值日」而非日历昨天，
    // 所以标签必须跟着数据日期走（收益条早已用「净值日 MM-DD」的做法，此处对齐）。
    const prevDayFallback = computed(() =>
      fundStates.value.some((f) => f.state.prevDayProfit == null && f.state.dailyProfit != null),
    );
    const prevDayLabel = computed(() => {
      if (!prevDayFallback.value) return '昨日';
      const d = maxNavDate.value;
      return d ? `上一净值日 ${d.slice(5)}` : '上一净值日';
    });
    /** 「昨日」列取值：与汇总层同口径（prevDayProfit 为 null → 最近净值日单日变动） */
    function prevDayProfitOf(state) {
      return state?.prevDayProfit ?? state?.dailyProfit ?? null;
    }

    // ---- 收益页数据层（TWR/净值日/集中度与 XIRR）----
    const round2p = (v) => Math.round(v * 100) / 100;

    // 到账日志行 + 回放份额（resolveSellProceeds ② 级需要"该行时点持有份额"；纯函数不做回放）
    function logRowsWithShares(asset) {
      const txs = [...(asset.transactions || [])]
        .filter((t) => t && t.date)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const rows = data.daily
        .filter((r) => r.code === asset.code && r.date)
        .slice()
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      let state = computeState(asset.snapshot, []);
      let ti = 0;
      return rows.map((r) => {
        while (ti < txs.length && String(txs[ti].date) <= String(r.date)) {
          const t = txs[ti];
          ti++;
          if (
            t.type === 'buy' &&
            Number.isFinite(Number(t.amount)) &&
            Number.isFinite(Number(t.shares))
          ) {
            state = applyBuy(state, { amount: Number(t.amount), shares: Number(t.shares) });
          } else if (t.type === 'sell' && Number.isFinite(Number(t.shares))) {
            state = applySell(state, { shares: Number(t.shares) });
          } else if (
            t.type === 'dividend' &&
            t.method === 'reinvest' &&
            Number.isFinite(Number(t.shares))
          ) {
            state = applyDividend(state, { method: 'reinvest', shares: Number(t.shares) });
          }
        }
        return { ...r, shares: state.holdShares };
      });
    }

    // 历史净值字典（恢复链 ③ 级）：仅预取"存在无 amount 卖出单"的基金——/api/history 上限 365 天
    const navHistoryMap = ref({});
    const historyNeededCodes = computed(() =>
      data.assets
        .filter(
          (a) =>
            a.asset_type === 'fund' &&
            (a.transactions || []).some(
              (t) => t.type === 'sell' && !Number.isFinite(Number(t.amount)),
            ),
        )
        .map((a) => a.code),
    );
    async function ensureNavHistory() {
      for (const code of historyNeededCodes.value) {
        if (navHistoryMap.value[code]) continue;
        try {
          const res = await quoteService.fetchHistory(code, 365);
          const map = {};
          for (const p of res.series || []) map[String(p.date).slice(0, 10)] = Number(p.nav);
          if (Object.keys(map).length)
            navHistoryMap.value = { ...navHistoryMap.value, [code]: map };
        } catch {
          /* 保持缺失 → ③ 级不可得 → 累计收益 '—' */
        }
      }
    }

    // 已实现盈亏（T4：任一基金恢复链走不通 → null → 累计收益 '—'，不假装完整）
    const realizedProfit = computed(() => {
      let sum = 0;
      for (const a of data.assets) {
        if (a.asset_type !== 'fund') continue;
        const r = buildRealizedProfit({
          snapshot: a.snapshot,
          transactions: a.transactions,
          logRows: logRowsWithShares(a),
          historyNavByDate: navHistoryMap.value[a.code] ?? {},
        });
        if (r == null) return null;
        sum += r;
      }
      return round2p(sum);
    });

    // M2 走势（净值日聚合）+ TWR 现金流 + 区间四档 + 区间指标
    const returnsDailySeries = computed(() => aggregateDaily(data.daily, { dateKey: 'navDate' }));
    const returnsFlows = computed(() =>
      data.assets
        .filter((a) => a.asset_type === 'fund')
        .flatMap((a) =>
          buildPortfolioFlows({
            snapshot: a.snapshot,
            transactions: a.transactions,
            logRows: logRowsWithShares(a),
            historyNavByDate: navHistoryMap.value[a.code] ?? {},
          }),
        ),
    );
    const returnsRange = ref('all'); // 30 | 90 | 365 | all
    const returnsSlice = computed(() => sliceSeries(returnsDailySeries.value, returnsRange.value));
    function setReturnsRange(r) {
      returnsRange.value = r;
      nextTick(renderReturnsCharts); // 区间切换重绘
    }
    // 区间 XIRR 现金流：单基金 buildFundFlows 区间子集（剔除基线外的期末市值流）+ 组合级虚拟 ±A
    const returnsXirrFlows = computed(() => {
      const slice = returnsSlice.value;
      if (slice.series.length === 0) return null;
      const t0 = slice.series[0].date;
      const t1 = slice.series[slice.series.length - 1].date;
      const out = [];
      for (const a of data.assets) {
        if (a.asset_type !== 'fund') continue;
        const f = buildFundFlows(a, { holdAmount: a.state?.holdAmount }, t1);
        if (f.length && String(f[f.length - 1].date) === String(t1)) f.pop(); // 单基金期末市值流剔除，组合级 +A₁ 唯一
        for (const x of f) {
          if (String(x.date) >= String(t0))
            out.push({ date: String(x.date) < String(t0) ? t0 : x.date, amount: x.amount });
        }
      }
      const a0 = slice.baselinePoint ? slice.baselinePoint.total_assets : null;
      if (a0 != null) out.push({ date: t0, amount: -a0 }); // 虚拟期初流出：取值前点、时间戳 t₀
      out.push({ date: t1, amount: slice.series[slice.series.length - 1].total_assets }); // 虚拟期末流入
      return out;
    });
    const returnsStats = computed(() =>
      rangeStats({
        baselinePoint: returnsSlice.value.baselinePoint,
        series: returnsSlice.value.series,
        flows: returnsFlows.value,
        xirrFlows: returnsXirrFlows.value,
      }),
    );
    // M7 金额排序方向（升序/降序按钮；默认降序＝|金额| 从大到小）
    const attrSortDesc = ref(true);
    function setAttrSort(desc) {
      attrSortDesc.value = desc;
    }

    const returnsCanvas = ref(null);
    const returnsCorrections = computed(() => {
      const resolved = resolveCorrections(data.daily, data.corrections || []);
      const out = {};
      for (const r of data.daily) {
        // 只取该行所属基金的修正——同一到账日/净值日下其他基金的行不得重复拼接（否则同条会重复显示）
        const items = (resolved[r.date] || []).filter((x) => x.code === r.code);
        if (items.length && r.navDate) out[r.navDate] = (out[r.navDate] || []).concat(items);
      }
      return out;
    });
    function renderReturnsCharts() {
      // M2 + M6（canvas 在 v-if 下重挂载，必须 nextTick 后绘制）
      // canvas ref 兜底：字符串/函数 ref 在直链首渲时序下曾失效，querySelector 永远可达（DOM 已证明元素存在）
      const cv =
        returnsCanvas.value || document.querySelector('.returns-page .chart-box.asset canvas');
      if (cv && returnsSlice.value.series.length >= 2) {
        if (typeof Chart === 'undefined') {
          setTimeout(renderReturnsCharts, 800);
          return;
        } // CDN 未就绪：延迟重试一次
        renderAssetChart(cv, returnsSlice.value.series, returnsCorrections.value, {
          masked: summaryHidden.value,
        }); // 打码态即 summaryHidden（勿再直读 localStorage：SUMMARY_BOOL_KEYS 未导入）
      }
      if (returnCanvas.value && returnRows.value.length > 0) {
        renderReturnCompareChart(returnCanvas.value, returnRows.value, {
          masked: summaryHidden.value,
        });
      }
    }
    // summaryHidden 入 watch：切换打码时 M2 重绘（纵轴刻度/提示框读数遮蔽，打码出口）
    watch(
      [returnsSlice, viewMode, themeLabel, updownLabel, summaryHidden],
      () => {
        if (viewMode.value === 'returns') nextTick(renderReturnsCharts);
      },
      { immediate: true },
    );
    // M2 canvas 用函数 ref：v-if 翻真挂载时必回调（字符串 ref 在"直链进收益页"首渲时序下可能未绑定），
    // 挂载即绘制——render 触发时机可能早于 canvas 挂载，函数 ref 是"canvas 就绪"的权威钩子，消除时序竞争
    function setReturnsCanvasEl(el) {
      returnsCanvas.value = el;
      if (el && viewMode.value === 'returns') {
        nextTick(() => {
          if (returnsCanvas.value === el && returnsSlice.value.series.length >= 2) {
            renderAssetChart(el, returnsSlice.value.series, returnsCorrections.value, {
              masked: summaryHidden.value,
            }); // 首帧同样带打码态（原漏传会在打码下明文画一帧）
          }
        });
      }
    }

    // 三态收益条取数（closed→dailyProfit / prevday→prevDayProfit / est·mixed·done→dayProfit）
    const stripDayProfit = computed(() => {
      const t = summary.value.portfolio?.total;
      if (!t) return null;
      if (profitState.value === 'closed') return t.dailyProfit;
      if (profitState.value === 'prevday') return t.prevDayProfit;
      return t.dayProfit;
    });
    const stripDayText = computed(() =>
      stripDayProfit.value != null
        ? maskText(formatMoney(stripDayProfit.value), summaryHidden.value)
        : '—',
    );
    const stripPrevText = computed(() => {
      const v = summary.value.portfolio?.total?.prevDayProfit;
      return v != null ? maskText(formatMoney(v), summaryHidden.value) : '—';
    });
    const stripDateLabel = computed(() => {
      // 日期标注：closed/prevday 展示数据所属净值日
      const st = profitState.value;
      if (st !== 'closed' && st !== 'prevday') return '';
      const d = maxNavDate.value;
      return d ? `净值日 ${d.slice(5)}` : '';
    });

    // 收益配色
    function profitColor(val) {
      if (val > 0) return 'var(--color-up)';
      if (val < 0) return 'var(--color-down)';
      return 'var(--color-text)';
    }
    function formatMoney(val) {
      return (
        '¥' +
        Number(val)
          .toFixed(2)
          .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      );
    }
    function pctText(r) {
      if (r == null) return '';
      return (r > 0 ? '+' : '') + (r * 100).toFixed(2) + '%';
    }

    // ---- 实时估值盘（主表「当日」单元格点击打开：整列可点、面板按状态分支）----
    // 刷新策略：打开时对该只基金拉一次行情，之后跟随页面 60s 轮询自动更新；另给手动刷新按钮。
    // 只拉单只、不改页面级行情状态（quoteStatus/pendingSync 不动），避免点一下格子就整页刷新。
    const estimateBoardCode = ref(null);
    const estRefreshing = ref(false);
    const estRefreshErr = ref('');
    const estimateBoardFund = computed(() =>
      estimateBoardCode.value
        ? (fundStates.value.find((f) => f.code === estimateBoardCode.value) ?? null)
        : null,
    );
    const estimateBoardView = computed(() =>
      buildEstimateBoard(estimateBoardFund.value?.state, quotesMap.value[estimateBoardCode.value], {
        today: todayStr(),
        name: estimateBoardFund.value?.name,
      }),
    );
    /** 百分数（已是百分比单位，非比例）→ 带符号两位：1.23 → "+1.23%" */
    function pct2(v) {
      return v == null || !Number.isFinite(Number(v))
        ? '—'
        : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
    }
    /** ISO 时间戳 → HH:mm（本地）；非法/缺省给 '—' */
    function isoTimeShort(iso) {
      const t = new Date(iso);
      if (!iso || Number.isNaN(t.getTime())) return '—';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }
    function closeEstimateBoard() {
      closeModalRestore();
      estimateBoardCode.value = null;
      estRefreshErr.value = '';
      // 曲线状态与 30 秒心跳一并收掉（否则关闭后 setInterval 永久空转）
      curveData.value = null;
      curveErr.value = null;
      curveTip.value = null;
      curveLoading.value = false;
      stopCurveClock();
    }
    function openEstimateBoard(record) {
      estimateBoardCode.value = record.code;
      // 入口重置：不清的话切基金时旧曲线会常驻；切到 QDII 更糟（QDII 不请求，旧数据永不被覆盖），
      // 结果是在 QDII 面板里画出上一只 A 股基金的走势（与"QDII 不使用估值源"文案自相矛盾）
      curveData.value = null;
      curveErr.value = null;
      curveTip.value = null;
      curveMetric.value = 'pct';
      openModalFocus('.modal-overlay [data-modal="estimate"]');
      startCurveClock();
      measureCurveWidth(); // 先给保底宽度
      nextTick(measureCurveWidth); // 弹窗挂载后再实测
      refreshEstimateQuote(); // 打开即拉一次
      loadEstimateCurve(); // 曲线：打开即拉一次
    }
    /** 单只基金行情刷新（面板内「刷新」与打开时共用） */
    async function refreshEstimateQuote() {
      const code = estimateBoardCode.value;
      if (!code || estRefreshing.value) return;
      estRefreshing.value = true;
      estRefreshErr.value = '';
      const r = await quoteService.fetchQuotes([code]);
      const q = r.quotes.find((x) => x.code === code);
      if (q) quotesMap.value = { ...quotesMap.value, [code]: q };
      else estRefreshErr.value = r.errors?.[0]?.error ?? 'no_data';
      estRefreshing.value = false;
    }
    // 基金被删/不在持仓 → 自动收起（不留下指向不存在基金的面板）
    watch(fundStates, () => {
      if (estimateBoardCode.value && !estimateBoardFund.value) closeEstimateBoard();
    });
    watch([navModal, txModal], ([nav, tx], [prevNav, prevTx]) => {
      if ((prevNav && !nav) || (prevTx && !tx)) closeModalRestore();
    });

    // ---- 实时估值盘 · 当天估值走势 ----
    // 响应式墙钟（30 秒心跳）驱动空态文案与静默轮询；curveWidth 由实测得到（SVG 用像素坐标，不能用 100%）
    const CURVE_TIP_W = 132; // tooltip 估宽/高（clamp 用，与 CSS 的 max-width 对齐）
    const CURVE_TIP_H = 26;
    const curveData = ref(null);
    const curveLoading = ref(false);
    const curveWidth = ref(0);
    const curveMetric = ref('pct');
    const curveErr = ref(null);
    const curveTip = ref(null);
    const tradingDayFlag = ref(true); // 初值 true：交易日历异步预算，未决期不报"非交易日"
    const curveClock = ref(Date.now());
    let curveClockTimer = null;
    const clockMinutes = computed(() => beijingMinutes(new Date(curveClock.value)));
    const curveView = computed(() =>
      buildEstimateCurve(curveData.value, {
        shares: estimateBoardView.value?.holdShares ?? null,
        isQdii: estimateBoardView.value?.isQdii === true,
        status: estimateBoardView.value?.status ?? null,
        hasQuote: estimateBoardView.value?.hasQuote === true,
        loading: curveLoading.value,
        error: curveErr.value,
        marketDate: curveData.value?.market_date || beijingToday(),
        isTradingDay: tradingDayFlag.value,
        nowMinutes: clockMinutes.value,
      }),
    );
    const curveSvg = computed(() =>
      curveView.value?.hasData
        ? estimateCurveSvg(curveView.value, { metric: curveMetric.value, width: curveWidth.value })
        : '',
    );
    /** 盈亏口径禁用原因（'' = 可用）：未持仓 / 今日确认净值已出（此时 worth 由昨收变今收，再算只有估算误差） */
    const curvePnlBlock = computed(() =>
      pnlBlockReason({
        shares: estimateBoardView.value?.holdShares ?? null,
        worthDate: curveData.value?.worth_date ?? curveData.value?.worthDate ?? null,
        marketDate: curveData.value?.market_date ?? beijingToday(),
      }),
    );
    const curveEmptyText = computed(() =>
      curveMetric.value === 'pnl' && curvePnlBlock.value
        ? curvePnlBlock.value
        : (EMPTY_REASON_TEXT[curveView.value?.emptyReason] ?? ''),
    );
    /** 图下状态提示：已让位确认净值 / 曲线停在上午收盘（午休与收盘后同一句） */
    const curveNote = computed(() => {
      const v = curveView.value;
      if (!v?.hasData) return '';
      if (v.isConfirmed) return '盘中估值已让位于确认净值，曲线仅供回看';
      return v.hasMorningPoints && !v.hasAfternoonPoints && clockMinutes.value >= 690
        ? '当前不在交易时段，曲线停在上午收盘'
        : '';
    });
    /**
     * 测量走势图容器宽度，供给SVG viewBox使用。
     * 不设置宽度下限：SVG viewBox = curveWidth，搭配CSS width:100%，二者必须匹配。
     * 若钳位到320，但容器实际更窄（小窗/窄弹窗），SVG等比缩放；命中反查直接把页面像素当作viewBox坐标，
     * 会产生X方向线性偏移：容器300px时右端偏移20px，超出10px吸附半径，造成取错点或命中失效。
     * 未挂载时取值0：上层组件有守卫，width <=0 返回空SVG；由nextTick/resize触发重新测量。
     */
    function measureCurveWidth() {
      const el = document.querySelector('.curve-wrap');
      curveWidth.value = el?.clientWidth || 0;
    }
    function startCurveClock() {
      // 单例：连点不同基金不得叠加心跳
      if (curveClockTimer) clearInterval(curveClockTimer);
      curveClock.value = Date.now();
      curveClockTimer = setInterval(() => {
        curveClock.value = Date.now();
      }, 30000);
    }
    function stopCurveClock() {
      if (curveClockTimer) {
        clearInterval(curveClockTimer);
        curveClockTimer = null;
      }
    }
    /** 拉曲线：入口守卫 → QDII 跳过 → 首屏才阻断 loading → 身份校验（含 finally） */
    async function loadEstimateCurve({ force = false } = {}) {
      const code = estimateBoardCode.value;
      if (!code) return; // 面板未打开：绝不发请求（否则 ?code=null → 400）
      if (estimateBoardView.value?.isQdii) return; // QDII 无估值源，不请求
      if (!curveData.value) curveLoading.value = true; // 只在首屏/切基金时阻断；跟随轮询不闪 loading
      curveErr.value = null;
      try {
        const r = await apiGet(`/api/estimate-curve?code=${code}${force ? '&force=1' : ''}`);
        if (estimateBoardCode.value !== code) return; // 期间切了基金/关了面板 → 丢弃旧响应
        curveData.value = r;
        if (curveWidth.value <= 0) measureCurveWidth();
        // 盈亏口径失效（worth 缺失/今日净值已出）→ 回落，界面不停留在被禁用的口径上
        // （只能写在回调里：computed getter 内改状态会触发 Vue 反模式告警）
        if (curveView.value?.pnlAvailable === false && curveMetric.value === 'pnl')
          curveMetric.value = 'pct';
        curveTip.value = null; // 数据换了，旧读数作废
      } catch (e) {
        if (estimateBoardCode.value !== code) return;
        curveErr.value = String(e?.message || e);
      } finally {
        if (estimateBoardCode.value === code) curveLoading.value = false; // try 内 return 也会走 finally
      }
    }
    /** 静默条件：非交易日 / 收盘后已有数据 / 午休已有上午数据 → 不再发请求（手动刷新不受限） */
    function curvePollSilent() {
      const mins = clockMinutes.value;
      return (
        !tradingDayFlag.value ||
        (mins >= 900 && !!curveData.value) ||
        (mins >= 691 && mins < 779 && curveView.value?.hasMorningPoints === true)
      );
    }
    function onCurveHover(e) {
      const wrap = e.currentTarget;
      const svgEl = wrap?.querySelector?.('svg');
      if (!svgEl) return;
      // TouchEvent 无 offsetX（真机必须自己算），且触摸端抬手不清读数（否则永远看不到）
      const clientX = e.touches?.[0]?.clientX ?? e.clientX;
      if (!Number.isFinite(clientX)) return;
      // 渲染像素 → viewBox 坐标：正常 1:1（ratio=1）；万一 viewBox 与渲染宽不一致（CSS 变动/缩放），
      // 这一步也能自纠，不再产生随 x 放大的系统性偏移。
      const rect = svgEl.getBoundingClientRect();
      const ratio = curveWidth.value > 0 && rect.width > 0 ? curveWidth.value / rect.width : 1;
      const hit = estimateCurveHitAt(
        curveView.value,
        (clientX - rect.left) * ratio,
        curveWidth.value,
        curveMetric.value,
      );
      if (!hit) {
        curveTip.value = null;
        return;
      }
      // tooltip 双向 clamp：贴边不超出容器（09:30/15:00 两端与上下极值点都看得到）
      const wrapW = wrap.clientWidth || curveWidth.value;
      const wrapH = wrap.clientHeight || CURVE_LAYOUT.HEIGHT;
      const left = Math.min(Math.max(hit.x + 12, 8), Math.max(8, wrapW - CURVE_TIP_W - 8));
      const top = Math.min(
        Math.max(hit.y < 50 ? hit.y + 10 : hit.y - 40, 4),
        Math.max(4, wrapH - CURVE_TIP_H - 4),
      );
      curveTip.value = {
        x: left,
        y: top,
        text: `${hit.t} · ${fmtCurveValue(hit.value, curveMetric.value)}`,
      };
    }
    function onCurveLeave() {
      if (curveTip.value) curveTip.value = null;
    }
    function setCurveMetric(key) {
      curveMetric.value = key;
      curveTip.value = null;
    }
    function onPanelClick(e) {
      if (!e.target?.closest?.('.curve-wrap') && curveTip.value) curveTip.value = null;
    }
    function onWindowResize() {
      if (estimateBoardCode.value) measureCurveWidth();
    }

    const sortKey = ref('holdProfit');
    const sortDesc = ref(true);

    const sortedFunds = computed(() => {
      const list = [...fundStates.value];
      list.sort((a, b) => {
        let va, vb;
        if (sortKey.value === 'holdProfit') {
          va = a.state.holdProfit;
          vb = b.state.holdProfit;
        } else if (sortKey.value === 'principal') {
          va = a.state.totalInvested;
          vb = b.state.totalInvested;
        } else if (sortKey.value === 'dailyChange') {
          va = a.state.dailyChangePct ?? -Infinity;
          vb = b.state.dailyChangePct ?? -Infinity;
        }
        return sortDesc.value ? vb - va : va - vb;
      });
      return list;
    });

    function setSort(key) {
      if (sortKey.value === key) {
        sortDesc.value = !sortDesc.value;
      } else {
        sortKey.value = key;
        sortDesc.value = true;
      }
    }

    const sortOptions = [
      { key: 'holdProfit', label: '持有收益' },
      { key: 'principal', label: '本金' },
      { key: 'dailyChange', label: '当日涨幅' },
    ];

    const showTradeForm = ref(false);

    // ---- 截图识别录入（/api/ocr/extract 预填表单，人工核对后保存）----
    const ocrImage = ref([]); // 多张截图 dataUrl（可多选/多次粘贴，逐张识别后合并去重）
    const MAX_OCR_IMAGES = 10;
    const ocrBusy = ref(false);
    const ocrMsg = ref('');
    const ocrIsErr = ref(false);
    const ocrBatch = ref(null); // 多笔识别结果：[{ tx, fund, isDup }]，逐笔核对后批量保存
    const totalInvestedAuto = ref(false); // 累计投入本金为自动计算值（成本价×份额），字段旁提示可自行修改

    /**
     * 新建模式必须从干净状态开始。
     * 取消、遮罩点击、ESC关闭均不清表单；仅保存成功才清空。
     * 残留上次录入数据，会误导下一次「+ 导入基金」/「+ 录入交易」。
     * 故把重置收敛为两个原子操作，在打开入口时调用。
     */
    function resetSnapshotForm() {
      Object.keys(snapshotForm).forEach((k) => (snapshotForm[k] = ''));
      totalInvestedAuto.value = false;
    }
    function resetTradeForm() {
      tradeForm.fundId = '';
      tradeForm.type = 'buy';
      tradeForm.amount = '';
      tradeForm.shares = '';
      tradeForm.dividendMethod = 'cash';
      tradeForm.date = todayStr(); // 打开时重取今天（本地时区；比模型初始值的 UTC 取法更准）
    }

    function openTradeForm() {
      txEdit.value = null; // 新录入模式
      resetTradeForm(); // 清空上次残留（取消关闭不会清，见上）
      ocrImage.value = [];
      ocrMsg.value = '';
      ocrIsErr.value = false;
      ocrBatch.value = null;
      showTradeForm.value = true;
    }

    function openSnapshotForm() {
      snapshotEditing.value = null; // 初次导入模式（编辑模式走 openSnapshotEdit）
      resetSnapshotForm(); // 清空上次残留（取消关闭不会清，见上）
      ocrImage.value = [];
      ocrMsg.value = '';
      ocrIsErr.value = false;
      ocrBatch.value = null;
      showSnapshotForm.value = true;
    }

    function onOcrFile(e) {
      const files = e.target.files;
      for (const f of files || []) loadOcrFile(f);
      e.target.value = '';
    }

    function loadOcrFile(file) {
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        ocrMsg.value = '请选择图片文件';
        ocrIsErr.value = true;
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        ocrMsg.value = '图片超过 8MB，请压缩后再试';
        ocrIsErr.value = true;
        return;
      }
      if (ocrImage.value.length >= MAX_OCR_IMAGES) {
        ocrMsg.value = `最多同时识别 ${MAX_OCR_IMAGES} 张截图，请先移除部分截图`;
        ocrIsErr.value = true;
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        if (!ocrImage.value.includes(dataUrl)) ocrImage.value.push(dataUrl); // 同一张图重复选择/粘贴自动忽略
        ocrMsg.value = '';
        ocrIsErr.value = false;
      };
      reader.readAsDataURL(file);
    }

    function removeOcrImage(i) {
      ocrImage.value.splice(i, 1);
    }

    function onWindowPaste(e) {
      if (!showTradeForm.value && !showSnapshotForm.value) return;
      const items = e.clipboardData?.items || [];
      for (const it of items) {
        if (it.type?.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            loadOcrFile(file);
            e.preventDefault();
          }
          return;
        }
      }
    }

    /** 把识别结果预填进交易表单；返回提示语（如基金不在持仓） */
    function applyOcrTrade(t) {
      const hit = resolveFundAsset(t);
      if (hit) tradeForm.fundId = hit.id;
      if (t.type) tradeForm.type = t.type;
      if (t.type === 'dividend')
        tradeForm.dividendMethod = t.method === 'reinvest' ? 'reinvest' : 'cash';
      if (t.amount != null && (t.type === 'buy' || t.type === 'dividend'))
        tradeForm.amount = String(t.amount);
      if (t.shares != null) tradeForm.shares = String(t.shares);
      if (t.date) tradeForm.date = t.date;
      if (!hit) return `识别到 ${t.name ?? t.code}，但不在持仓列表，请手动选择基金`;
      return '';
    }

    /** 按名称找已有持仓（截图没有代码时兜底）：规范化精确匹配优先，其次唯一包含匹配（防挂错基金） */
    function matchFundByName(name) {
      const n = normalizeFundName(name);
      if (!n || n.length < 4) return null;
      const exact = data.assets.find((a) => normalizeFundName(a.name) === n);
      if (exact) return exact;
      const contains = data.assets.filter((a) => {
        const an = normalizeFundName(a.name);
        return an && an.length >= 4 && (an.includes(n) || n.includes(an));
      });
      return contains.length === 1 ? contains[0] : null;
    }

    /** 解析交易所属持仓：先按代码精确匹配，代码缺失时按名称兜底 */
    function resolveFundAsset(t) {
      if (t.code) {
        const byCode = data.assets.find((a) => a.code === t.code);
        if (byCode) return byCode;
      }
      return matchFundByName(t.name);
    }

    /** 按名称搜索基金代码并预填到批量面板（自动创建持仓用）：搜索失败或结果歧义时留空，由用户手动补 */
    async function lookupFundCode(items) {
      const names = [
        ...new Set(items.filter((i) => !i.fund && !i.tx.code && i.tx.name).map((i) => i.tx.name)),
      ];
      for (const name of names) {
        let results = [];
        try {
          const res = await fetch(`/api/fund-search?key=${encodeURIComponent(name)}`, {
            headers: apiHeaders(),
          });
          if (res.ok) results = (await res.json()).results ?? [];
        } catch {
          /* 离线或接口失败：留空手填，不打断识别流程 */
        }
        const code = pickFundCode(name, results);
        if (code) {
          const cand = results.find((r) => String(r.code) === code);
          for (const i of items) {
            if (!i.fund && !i.tx.code && i.tx.name === name) {
              i.fundCode = code;
              if (cand?.name) i.fundName = cand.name; // 用官方名称建仓，OCR 名称可能缺字
            }
          }
        }
      }
    }

    /** 把识别出的资产详情预填进「持仓快照」表单；累计投入本金按成本价×份额预估（可修正） */
    function applyOcrSnapshot(snap) {
      snapshotForm.name = snap.name ?? '';
      snapshotForm.code = snap.code ?? '';
      snapshotForm.holdAmount = snap.hold_amount != null ? String(snap.hold_amount) : '';
      snapshotForm.costPrice = snap.cost_price != null ? String(snap.cost_price) : '';
      snapshotForm.holdShares = snap.hold_shares != null ? String(snap.hold_shares) : '';
      totalInvestedAuto.value = snap.cost_price != null && snap.hold_shares != null;
      snapshotForm.totalInvested = totalInvestedAuto.value
        ? String(Math.round(snap.cost_price * snap.hold_shares * 100) / 100)
        : '';
    }

    /** 单块截图识别请求（60s 超时，长截图多块串行时单块失败不拖垮整批） */
    async function ocrRequest(imageDataUrl) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const res = await fetch('/api/ocr/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({ image: imageDataUrl }),
          signal: ctrl.signal,
        });
        const payload = await res.json().catch(() => ({}));
        if (res.status === 503) throw new Error(payload.hint || '识别服务未配置');
        // detail 为服务端转写的人话提示（模型下线等）；无 detail 才回退裸状态码
        if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
        return payload;
      } finally {
        clearTimeout(timer);
      }
    }

    async function runOcr() {
      if (ocrImage.value.length === 0 || ocrBusy.value) return;
      ocrBusy.value = true;
      ocrMsg.value = '';
      ocrIsErr.value = false;
      ocrBatch.value = null;
      try {
        // 每张截图独立预处理（长图切块 / 超大图压缩）后逐块识别（支持多张单笔截图）
        const pieces = [];
        for (const img of ocrImage.value) {
          pieces.push(...(await prepareOcrImage(img)));
        }
        const merged = { trades: [], snapshot: null };
        const errors = [];
        for (const p of pieces) {
          let payload = null;
          let lastErr = null;
          for (let attempt = 0; attempt < 2 && !payload; attempt++) {
            try {
              payload = await ocrRequest(p);
            } catch (e) {
              lastErr = e;
            }
          }
          if (payload) {
            if (Array.isArray(payload.trades)) merged.trades.push(...payload.trades);
            if (payload.snapshot) merged.snapshot = payload.snapshot;
          } else {
            errors.push(String(lastErr?.message || lastErr));
          }
        }
        if (errors.length === pieces.length) {
          ocrMsg.value = '识别失败：' + errors[0];
          ocrIsErr.value = true;
          return;
        }
        // 跨块合并：中间片段没有基金代码/名称（只在页头出现），用其他块识别到的唯一值补齐
        const allTrades = unifyTradeMeta(merged.trades);
        // 去重（相邻块重叠区会被识别两次；指纹含 code，避免不同基金的同值记录误合并；
        // method 仅分红参与比较，防止模型对买入/卖出乱填 method 导致同一行判重失败）
        const trades = [];
        const seen = new Set();
        for (const t of allTrades) {
          const k = JSON.stringify([
            t.code ?? null,
            t.type ?? null,
            t.date ?? null,
            t.amount ?? null,
            t.shares ?? null,
            t.type === 'dividend' ? (t.method ?? null) : null,
          ]);
          if (seen.has(k)) continue;
          seen.add(k);
          trades.push(t);
        }
        if (trades.length > 0) {
          // 成交记录 → 交易表单（若当前在快照表单则自动切换）
          if (showSnapshotForm.value) {
            showSnapshotForm.value = false;
            showTradeForm.value = true;
          }
          resetTradeForm(); // 预填前先清空：预填只覆盖识别到的字段，残留会被一并存进交易
          if (trades.length === 1) {
            const t = trades[0];
            const hit = resolveFundAsset(t);
            if (!hit) {
              // 基金不在持仓：与长截图批量路径一致，走批量面板（保存时确认后自动创建零快照持仓）。
              // 截图没有代码（单笔截图常见）时按名称搜索自动补码，补不到留空让用户手动填
              ocrBatch.value = [
                {
                  tx: t,
                  fund: null,
                  isDup: false, // 新基金无历史交易
                  fundCode: '',
                  fillShares:
                    t.shares == null && (t.type === 'buy' || t.type === 'sell') ? '' : null,
                },
              ];
              const pieceNote =
                errors.length > 0 ? `有 ${errors.length} 块识别失败，已用成功部分。` : '';
              ocrMsg.value =
                pieceNote +
                `「${t.name || '未识别名称'}」不在持仓中，${t.code ? '' : '补全基金代码后'}保存将自动创建持仓（快照为 0，可后续补全）`;
              lookupFundCode(ocrBatch.value);
              return;
            }
            const note = applyOcrTrade(t);
            const fund = data.assets.find((a) => a.id === tradeForm.fundId);
            const isDup = !!fund && findDuplicateTrade(fund.transactions, t) >= 0;
            const pieceNote =
              errors.length > 0 ? `有 ${errors.length} 块识别失败，已用成功部分。` : '';
            ocrMsg.value =
              pieceNote +
              (isDup ? '疑似重复录入（与已有记录相同），' : '') +
              (note ? note + ' ' : '') +
              '识别完成，请核对无误后保存';
            return;
          }
          ocrBatch.value = trades.map((t) => {
            const fund = resolveFundAsset(t);
            return {
              tx: t,
              fund: fund ?? null,
              isDup: !!fund && findDuplicateTrade(fund.transactions, t) >= 0,
              fundCode: '', // 不在持仓且截图没有代码的行：按名称搜索自动补码，补不到手填
              fillShares: t.shares == null && (t.type === 'buy' || t.type === 'sell') ? '' : null, // 缺份额的买入/卖出行在面板补份额
            };
          });
          lookupFundCode(ocrBatch.value);
          ocrMsg.value =
            (errors.length > 0 ? `有 ${errors.length} 块识别失败，已用成功部分。` : '') +
            `共识别 ${trades.length} 笔交易，请在下方核对后批量保存`;
          return;
        }
        if (merged.snapshot) {
          // 资产详情页 → 持仓快照表单（若当前在交易表单则自动切换）
          if (showTradeForm.value) {
            showTradeForm.value = false;
            showSnapshotForm.value = true;
          }
          resetSnapshotForm(); // 预填前先清空：applyOcrSnapshot 不覆盖"待确认金额"，残留会被存进快照
          applyOcrSnapshot(merged.snapshot);
          ocrMsg.value =
            '识别到资产详情页，已按持仓快照预填；「累计投入本金」按 成本价×份额 预估，请核对修正后保存';
          return;
        }
        ocrMsg.value = '未从截图中识别到成交记录或持仓信息，请手动填写';
        ocrIsErr.value = true;
      } catch (e) {
        ocrMsg.value = '识别失败：' + (e?.message || '网络错误');
        ocrIsErr.value = true;
      } finally {
        ocrBusy.value = false;
      }
    }

    /** 批量保存：跳过重复、未匹配持仓与缺份额（未补齐）的笔，一次持久化；不在持仓的基金确认后自动创建零快照持仓 */
    function saveOcrBatch() {
      if (!ocrBatch.value) return;
      // 行的基金代码：优先识别到的 code，否则取面板补填的 fundCode（仅接受 6 位数字）
      const itemCode = (item) => {
        const raw = String(item.tx.code ?? item.fundCode ?? '').replace(/\D/g, '');
        return /^\d{6}$/.test(raw) ? raw : null;
      };
      // 不在持仓的基金：确认后按识别到的名称/代码创建零快照持仓（同 code 的所有行共享新持仓）；
      // 截图没有代码的行以面板补填的 fundCode 为准，仍未补码的留待补齐后重试
      const missingAssets = new Map();
      for (const item of ocrBatch.value) {
        if (item.fund) continue;
        const code = itemCode(item);
        if (!code || missingAssets.has(code)) continue;
        missingAssets.set(code, buildEmptyFundAsset({ code, name: item.fundName || item.tx.name }));
      }
      let created = 0;
      if (missingAssets.size > 0) {
        const names = [...missingAssets.values()].map((a) => `${a.name}（${a.code}）`).join('、');
        const ok = confirm(
          `检测到 ${missingAssets.size} 只基金不在持仓中（${names}），保存时将自动创建持仓（快照为 0，可后续补全）。\n继续？`,
        );
        if (!ok) return;
        for (const asset of missingAssets.values()) data.assets.push(asset);
        created = missingAssets.size;
        for (const item of ocrBatch.value) {
          const asset = !item.fund ? missingAssets.get(itemCode(item)) : null;
          if (asset) {
            item.fund = asset;
            item.isDup = false; // 新基金无历史交易
          }
        }
      }
      let added = 0;
      let dup = 0;
      let unmatched = 0;
      let incomplete = 0;
      const remain = []; // 缺份额/缺代码等未能保存的行留在面板，补齐后可再次保存
      for (const item of ocrBatch.value) {
        if (!item.fund) {
          unmatched++;
          remain.push(item);
          continue;
        }
        const tx = { ...item.tx };
        if (item.fillShares !== null) {
          const s = parseFloat(item.fillShares);
          if (Number.isFinite(s) && s > 0) tx.shares = s;
        }
        // 保存前最终闸门：字段完整（买入必须有金额+份额）且不与已有记录重复
        const clean = { type: tx.type, date: tx.date }; // 入库只保留交易字段，与手动录入结构一致
        if (tx.amount != null) clean.amount = tx.amount;
        if (tx.shares != null) clean.shares = tx.shares;
        if (tx.method != null) clean.method = tx.method;
        if (missingTradeFields(clean).length > 0) {
          incomplete++;
          remain.push(item);
          continue;
        }
        if (findDuplicateTrade(item.fund.transactions, clean) >= 0) {
          dup++;
          continue;
        }
        item.fund.transactions.push(clean);
        added++;
      }
      if (added > 0 || created > 0) persist();
      const parts = [`已添加 ${added} 笔`];
      if (dup > 0) parts.push(`跳过重复 ${dup} 笔`);
      if (unmatched > 0) parts.push(`未匹配持仓 ${unmatched} 笔（补全基金代码后重试）`);
      if (incomplete > 0) parts.push(`缺份额未添加 ${incomplete} 笔（可在面板补份额后重试）`);
      if (created > 0) parts.push(`自动创建持仓 ${created} 只`);
      ocrMsg.value = `批量保存完成：${parts.join('，')}`;
      ocrBatch.value = remain.length > 0 ? remain : null;
      if (added > 0 && remain.length === 0 && unmatched === 0) showTradeForm.value = false;
    }

    /** 回退到单笔录入：填第一笔进表单，其余丢弃 */
    function ocrBatchSingle() {
      const first = ocrBatch.value?.find((i) => !i.isDup && i.fund) ?? ocrBatch.value?.[0];
      if (!first) return;
      applyOcrTrade(first.tx);
      ocrMsg.value = '已填入一笔，请核对后保存（其余识别结果已丢弃）';
      ocrBatch.value = null;
    }

    const tradeForm = reactive({
      fundId: '',
      type: 'buy',
      amount: '',
      shares: '',
      date: new Date().toISOString().slice(0, 10),
    });

    function submitTrade() {
      const fund = data.assets.find((a) => a.id === tradeForm.fundId);
      if (!fund) {
        alert('请选择基金');
        return;
      }
      const amount = parseFloat(tradeForm.amount);
      const shares = parseFloat(tradeForm.shares);
      const tx = { type: tradeForm.type, date: tradeForm.date };
      if (tradeForm.type === 'buy') {
        if (!Number.isFinite(amount) || !Number.isFinite(shares)) {
          alert('请填写买入金额和买入份额');
          return;
        }
        tx.amount = amount;
        tx.shares = shares;
      } else if (tradeForm.type === 'sell') {
        if (!Number.isFinite(shares)) {
          alert('请填写卖出份额');
          return;
        }
        tx.shares = shares;
      } else if (tradeForm.type === 'dividend') {
        tx.method = tradeForm.dividendMethod || 'cash';
        if (tx.method === 'reinvest') {
          if (!Number.isFinite(shares)) {
            alert('请填写再投份额');
            return;
          }
          tx.shares = shares;
        } else {
          if (!Number.isFinite(amount)) {
            alert('请填写分红金额');
            return;
          }
          tx.amount = amount;
        }
      }
      if (txEdit.value) {
        // 编辑模式：替换原记录（非追加）
        fund.transactions.splice(txEdit.value.idx, 1, tx);
        txEdit.value = null;
      } else {
        // 重复录入判重：与已有记录指纹全等时二次确认
        if (findDuplicateTrade(fund.transactions, tx) >= 0) {
          const ok = confirm(
            '检测到与已有记录完全相同（同日期、同金额、同类型），可能是重复录入。\n仍要添加吗？',
          );
          if (!ok) return;
        }
        fund.transactions.push(tx);
      }
      persist();
      showTradeForm.value = false;
      resetTradeForm(); // 保存后同样收敛到干净态（与打开入口共用同一重置）
    }

    const showSnapshotForm = ref(false);
    const snapshotForm = reactive({
      name: '',
      code: '',
      holdAmount: '',
      pendingAmount: '',
      costPrice: '',
      holdShares: '',
      totalInvested: '',
    });
    const snapshotEditing = ref(null); // 编辑模式：被编辑基金 id（null = 初次导入）
    const snapshotCostMismatch = computed(() => {
      // 摊薄成本（成本价×份额）≠ 累计投入本金 → 通常有卖出/现金分红；非阻断黄条，仅提醒
      if (!snapshotEditing.value) return false;
      const cp = parseFloat(snapshotForm.costPrice),
        hs = parseFloat(snapshotForm.holdShares),
        ti = parseFloat(snapshotForm.totalInvested);
      if (![cp, hs, ti].every(Number.isFinite)) return false;
      return Math.abs(cp * hs - ti) > 0.005;
    });
    const snapshotAutoInvested = computed(() => {
      const v = parseFloat(snapshotForm.costPrice) * parseFloat(snapshotForm.holdShares);
      return Number.isFinite(v) ? (Math.round(v * 100) / 100).toLocaleString('zh-CN') : '—';
    });

    // ---- 录入/导入输入联动：名称↔代码自动互补（fund-search 保守消歧，与 OCR 补码同款能力）----
    const fundLink = { seq: 0, timer: null, lastQueried: '' };
    /** 防抖 400ms 触发联动；编辑模式身份字段只读，无需联动 */
    function scheduleFundLink(source) {
      if (snapshotEditing.value) return;
      clearTimeout(fundLink.timer);
      fundLink.timer = setTimeout(() => runFundLink(source), 400);
    }
    /**
     * 拿另一字段的当前值查 /api/fund-search，用 pickFundCode 保守消歧后回填空着的另一字段。
     * 只填空字段、绝不覆盖已输入内容；候选无把握（无精确/多义）留空手填；离线静默跳过。
     * @param {'name'|'code'} source 触发源字段（互补另一侧）
     */
    async function runFundLink(source) {
      fundLink.seq += 1;
      const seq = fundLink.seq;
      const query = String(source === 'name' ? snapshotForm.name : snapshotForm.code).trim();
      if (!query || query === fundLink.lastQueried) return;
      fundLink.lastQueried = query;
      let results = [];
      try {
        const res = await fetch(`/api/fund-search?key=${encodeURIComponent(query)}`, {
          headers: apiHeaders(),
        });
        if (res.ok) results = (await res.json()).results ?? [];
      } catch {
        return; // 离线/接口失败：静默，不打断录入
      }
      if (seq !== fundLink.seq) return; // 迟到响应丢弃（用户又输入了）
      if (source === 'name') {
        const code = pickFundCode(query, results);
        if (code && !snapshotForm.code.trim()) snapshotForm.code = code;
        return;
      }
      // 按代码查：fund-search 对 6 位代码返回精确候选，取官方名回填空名称
      const exact = results.find((r) => String(r.code) === query);
      if (exact?.name && !snapshotForm.name.trim()) snapshotForm.name = exact.name;
    }

    /** 编辑已有基金的持仓快照（本金修正入口） */
    function openSnapshotEdit(f) {
      const fund = data.assets.find((a) => a.id === f.id);
      if (!fund) return;
      snapshotEditing.value = fund.id;
      snapshotForm.name = fund.name;
      snapshotForm.code = fund.code;
      snapshotForm.holdAmount = String(fund.snapshot.hold_amount ?? '');
      snapshotForm.pendingAmount = String(fund.snapshot.pending_amount ?? 0);
      snapshotForm.costPrice = String(fund.snapshot.cost_price ?? '');
      snapshotForm.holdShares = String(fund.snapshot.hold_shares ?? '');
      snapshotForm.totalInvested = String(fund.snapshot.total_invested ?? '');
      ocrImage.value = [];
      ocrMsg.value = '';
      ocrIsErr.value = false;
      ocrBatch.value = null;
      totalInvestedAuto.value = false;
      showSnapshotForm.value = true;
    }

    function submitSnapshot() {
      const holdAmount = parseFloat(snapshotForm.holdAmount);
      const costPrice = parseFloat(snapshotForm.costPrice);
      const holdShares = parseFloat(snapshotForm.holdShares);
      const totalInvested = parseFloat(snapshotForm.totalInvested);
      const missing = [];
      if (!snapshotForm.code) missing.push('基金代码');
      if (!Number.isFinite(holdAmount)) missing.push('持有金额');
      if (!Number.isFinite(costPrice)) missing.push('持仓成本价');
      if (!Number.isFinite(holdShares)) missing.push('持有份额');
      if (!Number.isFinite(totalInvested)) missing.push('累计投入本金');
      if (missing.length > 0) {
        alert('请填写：' + missing.join('、'));
        return;
      }
      validateFundIdentity().then((problem) => {
        if (problem) {
          alert(problem);
          return;
        }
        doSubmitSnapshot({ holdAmount, costPrice, holdShares, totalInvested });
      });
    }

    /**
     * 录入身份校验（保存前拦截）：代码必须是 6 位数字；名称与官方名不符时给出明确提示。
     * 接口失败/离线降级放行（校验是防错，不是可用性门禁）。
     * @returns {Promise<string|null>} 拦截提示文案；null = 通过
     */
    async function validateFundIdentity() {
      const code = String(snapshotForm.code).trim();
      if (!/^\d{6}$/.test(code)) {
        return `基金代码须为 6 位数字（当前「${code}」）——请核对后重填`;
      }
      if (snapshotEditing.value) return null; // 编辑模式只改持仓数值，身份字段不可改
      const name = String(snapshotForm.name || '').trim();
      if (!name) return null; // 名称缺省交给缺项检查；不在此重复拦截
      try {
        const res = await fetch(`/api/fund-names?codes=${code}`, { headers: apiHeaders() });
        if (!res.ok) return null;
        const official = (await res.json()).names?.[code];
        if (!official) {
          return `未查到代码 ${code} 的官方基金——请确认代码无误（可能输错位数）`;
        }
        if (official !== name) {
          const confirmUse = window.confirm(
            `名称与官方不符：\n您填的：${name}\n官方名：${official}\n\n点「确定」用官方名保存，点「取消」返回修改`,
          );
          if (confirmUse) snapshotForm.name = official;
          return confirmUse ? null : '已取消保存——请核对名称后重试';
        }
        return null;
      } catch {
        return null; // 离线/接口失败：放行（校验降级，不阻断录入）
      }
    }

    function doSubmitSnapshot({ holdAmount, costPrice, holdShares, totalInvested }) {
      if (snapshotEditing.value) {
        // 编辑模式：快照原地更新（id/交易记录/策略配置都不动），新本金即时刷新策略徽章
        const fund = data.assets.find((a) => a.id === snapshotEditing.value);
        if (!fund) {
          snapshotEditing.value = null;
          showSnapshotForm.value = false;
          return;
        }
        const prevSnapshot = fund.snapshot;
        const nextSnapshot = {
          hold_amount: holdAmount,
          pending_amount: parseFloat(snapshotForm.pendingAmount) || 0,
          cost_price: costPrice,
          hold_shares: holdShares,
          total_invested: totalInvested,
        };
        // 本金修正留痕（口径Ⅰ）：本金变更时写入修正记录，历史到账日志不可变。
        // 由 analysis.resolveCorrections 对齐到日志首次体现新本金的日期，供日历、资产曲线标注。
        // from/to 必须用 buildPrincipalCorrection 换算生效本金（基线+交易增量）；
        // 到账日志、巡检比对均使用生效值。直接传快照基线会导致有交易基金留痕认领失败、口径分叉。
        const correctionRec = buildPrincipalCorrection({
          code: fund.code,
          prevSnapshot,
          nextSnapshot,
          transactions: fund.transactions,
          date: todayStr(),
          at: new Date().toISOString(),
        });
        fund.snapshot = nextSnapshot;
        if (correctionRec) {
          if (!Array.isArray(data.corrections)) data.corrections = [];
          data.corrections.push(correctionRec);
        }
        persist();
        showSnapshotForm.value = false;
        snapshotEditing.value = null;
        resetSnapshotForm();
        // 反馈分叉：本金有修正时说明留痕已记 + 标注何时出现（当天该基金已入账 → 顺延到下次入账）
        if (correctionRec) {
          const todayBooked = data.daily.some(
            (r) => r && r.code === fund.code && r.date === todayStr(),
          );
          antd.message.success(
            `已保存，并记录本金修正 ${correctionRec.from}→${correctionRec.to}——` +
              (todayBooked ? '今日已入账，将在下次入账后标注' : '日历/曲线将在本次入账写入后标注') +
              '（策略引擎已按新本金重算）',
          );
        } else {
          antd.message.success('快照已保存——策略引擎按新本金重算中');
        }
        refreshStrategyStatus();
        return;
      }
      const newFund = {
        id: 'fund_' + Date.now(),
        asset_type: 'fund',
        name: snapshotForm.name,
        code: snapshotForm.code,
        snapshot: {
          hold_amount: holdAmount,
          pending_amount: parseFloat(snapshotForm.pendingAmount) || 0,
          cost_price: costPrice,
          hold_shares: holdShares,
          total_invested: totalInvested,
        },
        transactions: [],
      };
      data.assets.push(newFund);
      persist();
      showSnapshotForm.value = false;
      resetSnapshotForm(); // 重置
    }

    function exportData() {
      const json =
        storeMode.value === 'server' ? serverStore.exportJSON() : localStorageStore.exportJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fund-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function importData(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const imported = JSON.parse(e.target.result);
          if (!Array.isArray(imported.assets)) throw new Error('bad_format');
          data.assets.splice(0, data.assets.length, ...imported.assets);
          persist();
        } catch (err) {
          alert(
            '导入失败：无法识别为有效的 JSON 备份（需含 assets 字段）。请用工具栏「导出」生成的文件再试。',
          );
        }
      };
      reader.readAsText(file);
    }

    async function loadQuotes() {
      const codes = [
        ...new Set(fundStates.value.map((f) => f.code).filter((c) => /^\d{6}$/.test(c))),
      ];
      if (codes.length === 0) return;
      quoteStatus.value = 'loading';
      const r = await quoteService.fetchQuotes(codes);
      if (r.quotes.length > 0) {
        const map = {};
        for (const q of r.quotes) map[q.code] = q;
        quotesMap.value = map;
        quoteFetchedAt.value = new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        });
        quoteStatus.value = 'ok';
        bookDailyArrivals();
        loadIndexes();
      } else {
        quoteStatus.value = 'failed';
      }
    }

    function refreshQuotes() {
      loadQuotes();
      refreshStrategyStatus(); // 通道 B：行情刷新时即时重算七态
    }

    // 指数与持仓行情解耦：A 股闭市但海外开市时也能单独刷新（服务端 /api/index 60s 缓存兜底频率）
    function loadIndexes() {
      quoteService.fetchIndexes().then((r) => {
        if (r.indexes.length > 0) indexes.value = r.indexes;
      });
    }

    // 核心指数监控折叠卡：折叠状态持久化 + 三市场开市状态随轮询刷新
    const indexExpanded = ref(true);
    try {
      const saved = JSON.parse(localStorage.getItem('indexMonitor.expanded'));
      if (typeof saved === 'boolean') indexExpanded.value = saved;
    } catch {
      // localStorage 禁用或损坏时保持默认展开，无需处理
    }
    function toggleIndexMonitor(e) {
      if (e && e.target.closest('.handles')) return; // 排序手柄区点击不触发折叠
      indexExpanded.value = !indexExpanded.value;
      try {
        localStorage.setItem('indexMonitor.expanded', JSON.stringify(indexExpanded.value));
      } catch {
        // 持久化失败只影响下次打开的初始折叠态，不影响当次切换
      }
      if (indexExpanded.value) loadIndexSparks(); // 展开才取迷你分时（折叠不请求、不轮询）
    }
    // 键盘折叠：↑↓ 手柄按钮自带 Enter/Space 原生激活，仅在事件源非手柄时接管（并阻止默认，避免 Space 滚屏）
    function onIndexHeadKey(e) {
      if (e.target.closest('.handles')) return;
      e.preventDefault();
      toggleIndexMonitor();
    }
    const indexStatus = ref(marketStatusOf(new Date()));
    // 核心指数「当天迷你分时」：仅在监控展开时请求
    // 折叠态不发请求、不随轮询（缩略图非关键路径）；失败保留上次图形，下一轮自然重试。
    const indexSparks = ref({}); // code → { market, last_pct, spark }
    let sparkBusy = false;
    async function loadIndexSparks() {
      if (!indexExpanded.value || sparkBusy) return;
      sparkBusy = true;
      try {
        const payload = await apiGet('/api/index-spark');
        const map = {};
        for (const it of payload?.items || [])
          map[it.code] = { market: it.market, last_pct: it.last_pct, spark: it.spark ?? null };
        if (Object.keys(map).length > 0) indexSparks.value = map;
      } catch {
        /* 缩略图失败静默（快照数字不受影响） */
      } finally {
        sparkBusy = false;
      }
    }
    // 指数卡展示白名单与顺序：只展示这 4 只、按此顺序。
    // 其余 7 只仍由 `/api/index` 与 `/api/index-spark` 照常取回（留接口备用），只是前端不渲染；
    // 因此后端一行未改；日后要恢复展示，改这一行数组即可。
    // 注：这 4 只都在 push2 覆盖范围内、新浪备源也都有 ⇒ 主源可用与否都出全 4 张，张数不会跳。
    const INDEX_CARD_CODES = ['000001', '000688', 'NDX', 'HSI']; // 上证指数 / 科创50 / 纳斯达克100 / 恒生指数
    const indexMonitorHtml = computed(() =>
      indexMonitorCardHtml(
        INDEX_CARD_CODES.map((code) => indexes.value.find((i) => i.code === code))
          .filter(Boolean) // 该只本轮没取到就少一张（与既有"坏 secid 少一张"表现一致）
          .map((idx) => {
            // 卡面涨跌幅：美股休市/开盘前显示"最近完成场次"的涨幅
            // "新的、无成交的场次"（涨跌幅 0.00 而价格仍是上一场收盘），曲线那一路的 last_pct 才是本场涨幅，
            // 且与卡面价格同属一场（口径自洽）；盘中照上游实时值。规则本体在 displayChangePct（纯函数、有单测）。
            const sp = indexSparks.value[idx.code];
            const pctVal = displayChangePct(idx.change_pct, {
              lastSessionPct: sp?.last_pct ?? null,
              useLastSession:
                marketOfIndex(idx.code) === 'us' && marketPhaseOf(idx.code) === 'closed',
            });
            return {
              code: idx.code, // 迷你分时按 code 取槽位数据
              name: idx.name,
              priceText: idx.price?.toFixed(2) ?? '—',
              chgText: pctVal == null ? '—' : `${pctVal > 0 ? '+' : ''}${pctVal.toFixed(2)}%`,
              amtText:
                idx.change_amt == null || pctVal == null
                  ? null
                  : `${idx.change_amt > 0 ? '+' : ''}${idx.change_amt.toFixed(2)}`,
              chgColor: profitColor(pctVal),
              timeText: formatIndexTime(idx.time),
              open: indexStatus.value[marketOfIndex(idx.code)], // 海外指数白名单映射（marketClock）——老的 A 股/港股两分支不覆盖美股，会错拿 A 股窗口
              phase: marketPhaseOf(idx.code), // 午间休市 11:30–13:00 不该显示"已收盘"（与上面 open 同源，随 indexStatus 刷新重算）
            };
          }),
        {
          status: indexStatus.value.items,
          orderCtx: orderCtxOf('idx'),
          sparkByCode: indexSparks.value,
        },
      ),
    );

    // 到账日志天数（收益日历"不足 2 天暂不绘制"的判据）
    const dailyLen = computed(() => aggregateDaily(data.daily).length);
    // 待体现徽标：改完本金数字立刻更新，但圆标/打点要等入账把新本金写进日志才出现；
    // 这段空窗期用一枚徽标明确"已记录、待体现"，避免"改了没反应"分不清是没记录还是没到标注日。
    const corrPending = computed(() => pendingCorrections(data.daily, data.corrections));
    const corrPendingTitle = computed(
      () =>
        corrPending.value
          .map((c) => `${c.code} ${c.from ?? '—'}→${c.to ?? '—'}（修正日 ${c.date ?? '—'}）`)
          .join('；') + '——下次入账把新本金写入到账日志后，自动在日历与资产曲线标注',
    );
    // 本金跳变自动巡检（口径 Ⅰ）：判定与服务端每轮入账后的巡检同源（analysis.auditPrincipalJumps），
    // 检出"无交易解释且无修正留痕"的跳变时提示补录——页面开着就自动发现，不必手动跑工具。
    const principalAudit = computed(() =>
      auditPrincipalJumps(data.daily, data.corrections, data.assets),
    );
    const jumpAuditTitle = computed(
      () =>
        principalAudit.value.unexplained
          .map((j) => `${j.code} ${j.date} ${j.from}→${j.to}`)
          .join('；') +
        '——该本金变化既无交易解释、也无修正留痕（通常是手动改过本金但未补录）；确认后可用 node tools/backfill-corrections.mjs 补录',
    );

    const round2 = (v) => Math.round(v * 100) / 100;

    // ---- 今日行情分析（规则版）----
    const indexes = ref([]); // 大盘指数参照

    const analysis = computed(() => {
      if (quoteStatus.value !== 'ok') return null;
      const states = fundStates.value;
      const withDaily = states.filter((f) => f.state.dailyProfit != null);
      if (states.length === 0 || withDaily.length === 0) return null;
      const attribution = computeAttribution(states);
      const concentration = computeConcentration(states);
      const summaryData = {
        fundCount: states.length,
        upCount: withDaily.filter((f) => f.state.dailyProfit > 0).length,
        downCount: withDaily.filter((f) => f.state.dailyProfit < 0).length,
        dailyProfit: summary.value.totalDailyProfit ?? 0,
        yesterdayProfit: summary.value.totalYesterdayProfit,
      };
      // 分析口径的数据日期：估值模式为今天、确认模式为最新净值日期（QDII 等滞后品种自然靠后）
      const dataDate =
        states
          .map((f) => f.state.dataDate ?? f.state.navDate)
          .filter(Boolean)
          .reduce((m, d) => (d > m ? d : m), null) ?? todayStr();
      const reportParts = {
        today: todayStr(),
        dataDate,
        summary: summaryData,
        attribution,
        indexData: indexes.value,
        concentration,
      };
      // 展示用：逐条（网页渲染无序列表）；出网用：金额替换为占位（「金额不出网」）
      const reportLines = buildReportLines({ ...reportParts });
      const reportLinesRedacted = buildReportLines({ ...reportParts, redactMoney: true });
      const report = reportLines.length > 0 ? reportLines.join('') : null;
      // 归因横条：涨/跌各取前 3，宽度按绝对值占比
      // 排序带正负号：升序＝最亏在前、降序＝最赚在前
      const rows = [...attribution.gainers, ...attribution.losers].sort((a, b) =>
        attrSortDesc.value ? b.dailyProfit - a.dailyProfit : a.dailyProfit - b.dailyProfit,
      );
      const maxAbs = Math.max(...rows.map((r) => Math.abs(r.dailyProfit)), 1);
      const attributionRows = rows.map((r) => ({
        name: r.name,
        signed: (r.dailyProfit > 0 ? '+' : '') + r.dailyProfit.toFixed(2),
        pct: Math.max(4, Math.round((Math.abs(r.dailyProfit) / maxAbs) * 100)),
        dir: r.dailyProfit >= 0 ? 'up' : 'down',
      }));
      return {
        today: todayStr(),
        date: new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }),
        dataDate,
        dataDateLabel: parseISODate(dataDate).toLocaleDateString('zh-CN', {
          month: 'long',
          day: 'numeric',
        }),
        report,
        reportLines,
        reportLinesRedacted,
        attributionRows,
        concentration,
      };
    });

    /**
     * 逐基金到账入账（与服务端 lib/snapshot.js 同口径，共用 analysis.js 的 bookArrivals）：
     * 确认净值模式下，基金净值日期比日志里最新一条更新 → 按标准到账日记一条
     * （口径 A：国内=净值日、QDII=下一工作日，收益明细只落在交易日）；估值模式不参与。
     */
    function bookDailyArrivals() {
      const entries = [];
      for (const f of fundStates.value) {
        if (f.state.mode === 'estimate') continue; // 估值不入账，只记确认净值
        if (f.state.holdShares <= 0) continue;
        if (f.state.navDate == null || f.state.dailyProfit == null) continue;
        entries.push({
          code: f.code,
          navDate: f.state.navDate,
          earnings: f.state.dailyProfit,
          invested: f.state.totalInvested,
          assets: f.state.holdShares * f.state.latestNav,
          qdii: /QDII/i.test(f.name ?? ''),
        });
      }
      if (entries.length === 0) return;
      const { list, changed } = bookArrivals(data.daily, entries);
      if (!changed) return; // 净值日期均未推进，不触发持久化
      data.daily = list;
      persist();
    }

    const portfolioXirr = computed(() => {
      if (fundStates.value.length === 0) return null;
      const flows = [];
      for (const f of fundStates.value) flows.push(...buildFundFlows(f, f.state, todayStr()));
      return computeXIRR(flows);
    });

    // 组合单日涨跌幅（比例，非金额）：AI 解读判断"单日波动是否异常"用。
    // 金额不出网后金额口径的波动信号消失，故以「当日盈亏 ÷ 期初资产」的比例补上（期初 = 期末资产 − 当日盈亏）。
    const portfolioDailyReturnPct = computed(() => {
      const dp = summary.value.totalDailyProfit;
      const assets = summary.value.portfolio?.total?.value;
      if (dp == null || assets == null) return null;
      const base = assets - dp;
      return base > 0 ? Math.round((dp / base) * 10000) / 10000 : null;
    });

    // ---- 收益率可视化：对比条形图 + 收益日历（年/月/周/日）----
    const returnCanvas = ref(null);
    const returnRows = computed(() => buildReturnRows(fundStates.value));

    const calView = ref('month'); // month | week | day | year
    const calMonth = ref(new Date().getFullYear());
    const calMon = ref(new Date().getMonth());
    const calWeek = ref(isoDate(startOfWeek(new Date())));
    const calYear = ref(new Date().getFullYear());
    const calSelected = ref(todayStr());

    const calByDate = computed(() => buildProfitByDate(data.daily, data.corrections));
    /** 日历圆标文案：本金修正优先标注（口径 Ⅰ 留痕），其余本金变动按交易提示 */
    function calMarkerLabel(c) {
      if (c?.correction?.length) {
        return '（本金修正 ' + c.correction.map((x) => `${x.from}→${x.to}`).join('、') + '）';
      }
      return c?.hasTx ? '（含交易）' : '';
    }
    const calMonthCells = computed(() =>
      buildMonthCells(calByDate.value, {
        year: calMonth.value,
        month: calMon.value,
        today: todayStr(),
        selected: calSelected.value,
      }),
    );
    const calWeekCells = computed(() =>
      buildWeekCells(calByDate.value, {
        anchor: parseISODate(calWeek.value),
        today: todayStr(),
      }),
    );
    const calYearBlocks = computed(() => buildYearBlocks(calByDate.value, { year: calYear.value }));
    const calSelectedProfit = computed(() => calByDate.value[calSelected.value]?.profit ?? null);
    // 日视图明细 = 到账日志中"到账日 = 选中日"的逐基金记录，与格子总额天然一致
    const calDetailRows = computed(() =>
      dayDetailRows(data.daily, fundStates.value, calSelected.value),
    );
    // 「本期合计」随档位取数：日档 = 选中日（原缺 day 分支时，日视图显示的是全年合计且翻日不变）
    const calSum = computed(() =>
      calView.value === 'month'
        ? calMonthCells.value.sum
        : calView.value === 'week'
          ? calWeekCells.value.sum
          : calView.value === 'day'
            ? { sum: calSelectedProfit.value, count: calSelectedProfit.value != null ? 1 : 0 }
            : calYearBlocks.value.sum,
    );
    const calNavLabel = computed(() => {
      if (calView.value === 'month') return `${calMonth.value}年${calMon.value + 1}月`;
      if (calView.value === 'week') return calWeekCells.value.label;
      if (calView.value === 'year') return `${calYear.value}年`;
      const d = parseISODate(calSelected.value);
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 周${'日一二三四五六'[d.getDay()]}`;
    });

    function signed(v) {
      if (summaryHidden.value) return '••••••'; // 日历金额出口接打码（含格子/合计/明细/悬停 title）
      return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2);
    }

    function setCalView(v) {
      calView.value = v;
    }
    function calPrev() {
      if (calView.value === 'month') {
        calMon.value -= 1;
        if (calMon.value < 0) {
          calMon.value = 11;
          calMonth.value -= 1;
        }
      } else if (calView.value === 'week') {
        calWeek.value = isoDate(addDays(parseISODate(calWeek.value), -7));
      } else if (calView.value === 'year') {
        calYear.value -= 1;
      } else {
        calSelected.value = isoDate(addDays(parseISODate(calSelected.value), -1));
      }
    }
    function calNext() {
      if (calView.value === 'month') {
        calMon.value += 1;
        if (calMon.value > 11) {
          calMon.value = 0;
          calMonth.value += 1;
        }
      } else if (calView.value === 'week') {
        calWeek.value = isoDate(addDays(parseISODate(calWeek.value), 7));
      } else if (calView.value === 'year') {
        calYear.value += 1;
      } else {
        calSelected.value = isoDate(addDays(parseISODate(calSelected.value), 1));
      }
    }
    function calToday() {
      const now = new Date();
      calSelected.value = todayStr();
      calWeek.value = isoDate(startOfWeek(now));
      calMonth.value = now.getFullYear();
      calMon.value = now.getMonth();
      calYear.value = now.getFullYear();
      // 「今天」= 回到今天的日明细：若只重置周期，在默认月视图（已是当月）里
      // 不产生任何可见变化，看起来像按钮失效；切到日视图后任何时候按都有明确结果。
      calView.value = 'day';
    }
    function pickDay(cell) {
      if (!cell || cell.blank || !cell.date) return;
      calSelected.value = cell.date;
      calView.value = 'day';
    }

    function renderReturn() {
      if (returnCanvas.value && returnRows.value.length > 0) {
        renderReturnCompareChart(returnCanvas.value, returnRows.value, {
          masked: summaryHidden.value,
        });
      }
    }
    watch(returnRows, () => nextTick(renderReturn), { immediate: true });

    // ---- AI 今日解读（/api/analysis，复用截图识别的模型配置）----
    const aiText = ref('');
    const aiBusy = ref(false);
    const aiErr = ref(false);

    /** 解读历史（新→旧），details 折叠列表展示用 */
    const aiLogList = computed(() =>
      [...(Array.isArray(data.ai_log) ? data.ai_log : [])].sort((a, b) =>
        b.date.localeCompare(a.date),
      ),
    );

    /** 当日解读入库：同日覆盖（重跑解读只留最新一条）、升序、上限 90 条；只存真正的解读文本 */
    function saveAiLog(text) {
      const date = todayStr();
      const t = typeof text === 'string' ? text.trim() : '';
      if (
        !t ||
        t.startsWith('AI 解读失败') ||
        t.startsWith('AI 解读未配置') ||
        t.startsWith('（模型未返回内容）')
      )
        return;
      const list = (Array.isArray(data.ai_log) ? data.ai_log : []).filter((e) => e?.date !== date);
      list.push({ date, text: t });
      list.sort((a, b) => a.date.localeCompare(b.date));
      data.ai_log = list.slice(-90);
      persist();
    }

    async function runAiAnalysis() {
      if (!analysis.value || aiBusy.value) return;
      aiBusy.value = true;
      aiErr.value = false;
      aiText.value = '';
      try {
        // 金额不出网：绝对金额字段在此一律剔除，只发比例/占比/计数/指数涨跌幅；
        // 规则报告用 reportLinesRedacted（金额已替换为占位）。新增字段必须同时更新 redactAnalysisContext 的白名单。
        const totalAmount = fundStates.value.reduce((s2, f) => s2 + (f.state.holdAmount ?? 0), 0);
        const context = redactAnalysisContext({
          date: analysis.value.dataDate,
          report: analysis.value.reportLinesRedacted.join(''),
          summary: {
            returnRate: summary.value.returnRate,
            anyEstimate: summary.value.anyEstimate,
            dailyReturnPct: portfolioDailyReturnPct.value,
          },
          attribution: (() => {
            const a = computeAttribution(fundStates.value);
            return { gainers: a.gainers.slice(0, 3), losers: a.losers.slice(0, 3) };
          })(),
          concentration: analysis.value.concentration,
          indexes: indexes.value,
          portfolioXirr: portfolioXirr.value,
          strategy: {
            actionCount: strategyActionCount.value,
            summary: strategyActionSummary.value,
          },
          funds: fundStates.value.map((f) => ({
            name: f.name,
            returnRate: f.state.returnRate,
            xirr: f.state.xirr,
            // 持仓规模只以占比表达（占比非金额，既能判断"试仓"又不泄露金额）
            weightPct:
              totalAmount > 0 && f.state.holdAmount != null
                ? Math.round((f.state.holdAmount / totalAmount) * 10000) / 10000
                : null,
          })),
        });
        const res = await fetch('/api/analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({ context }),
        });
        const payload = await res.json().catch(() => ({}));
        if (res.status === 503) {
          aiText.value = payload.hint || 'AI 解读未配置';
          aiErr.value = true;
          return;
        }
        if (!res.ok) {
          // detail 已是服务端转写的人话提示（如"模型不可用…更换 model"）；无 detail 才回退裸状态码
          aiText.value = payload.detail
            ? `AI 解读失败：${payload.detail}`
            : `AI 解读失败：HTTP ${res.status}`;
          aiErr.value = true;
          return;
        }
        aiText.value = payload.text || '（模型未返回内容）';
        saveAiLog(payload.text); // 解读成功即按日留存，供历史回看
      } catch (e) {
        aiText.value = 'AI 解读失败：' + (e?.message || '网络错误');
        aiErr.value = true;
      } finally {
        aiBusy.value = false;
      }
    }

    let quoteTimer = null;
    let clockTimer = null;
    let ocrCleanup = null;
    onMounted(async () => {
      await initStore(); // 先确定存储后端（服务端优先/本地回退），再谈行情
      backfillFundNames(); // 持仓名称回填（lsjz 不含名称，官方名替换演示名；失败静默跳过）
      window.addEventListener('paste', onWindowPaste);
      ocrCleanup = () => window.removeEventListener('paste', onWindowPaste);
      mqMd.addEventListener('change', onMqMd);
      mqLg.addEventListener('change', onMqLg);
      mqPhone.addEventListener('change', onMqPhone);
      // 先展示上次缓存，再后台更新
      const cached = quoteService.loadCachedQuotes();
      if (Object.keys(cached.quotes).length > 0) {
        quotesMap.value = cached.quotes;
        quoteFetchedAt.value = cached.fetched_at
          ? new Date(cached.fetched_at).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '缓存';
        quoteStatus.value = 'ok';
      }
      loadQuotes();
      refreshTradingDay();
      refreshStrategyStatus(); // U1：七态徽章数据（服务端实时评估，失败静默降级为"未评估"）
      refreshStrategyAlerts(); // U1：触发历史时间线
      refreshSourceHealth(); // U1：数据源健康细条（服务端只报事实）
      loadIndexes(); // 挂载即拉一次：不依赖 A 股窗口（晚间盯纳指/恒指），也覆盖无 6 位代码持仓时 loadQuotes 提前返回的情况
      if (indexExpanded.value) loadIndexSparks(); // 迷你分时（折叠态不请求）
      quoteTimer = setInterval(() => {
        if (inQuoteWindow()) loadQuotes();
        refreshTradingDay();
        refreshSourceHealth(); // 随行情轮询周期更新（约 60s）
        indexStatus.value = marketStatusOf(new Date()); // 开市状态点随时间刷新
        if (overseasIndexWindowOpen(new Date())) loadIndexes(); // 恒生/纳指开市时段：A 股闭市不挡指数刷新
        if (indexExpanded.value) loadIndexSparks(); // 迷你分时随轮询刷新（折叠态静默；服务端 5 分钟子缓存兜底）
        if (estimateBoardCode.value && !curvePollSilent()) loadEstimateCurve(); // 估值盘开着才拉；午休/收盘/非交易日静默
      }, 60000);
      // 收益页：hashchange 路由 + 三态墙钟心跳 + 直链/F5 首渲 + 恢复链历史净值预取
      window.addEventListener('hashchange', onHashChange);
      clockTimer = setInterval(() => {
        clockTick.value++;
      }, 30000);
      ensureNavHistory();
      if (viewMode.value === 'returns') nextTick(renderReturnsCharts);
    });
    // ---- ESC 关闭最上层弹窗（输入法合成中不响应，防误关丢表单内容）----
    function onKeydown(e) {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (estimateBoardCode.value) {
        closeEstimateBoard();
        return;
      } // 估值盘为最上层弹窗
      if (navModal.value) {
        navModal.value = null;
        return;
      }
      if (txModal.value) {
        txModal.value = null;
        return;
      }
      if (strategyDetail.value) {
        strategyDetail.value = null;
        return;
      }
      if (showSnapshotForm.value) {
        showSnapshotForm.value = false;
        return;
      }
      if (showTradeForm.value) {
        showTradeForm.value = false;
        return;
      }
    }
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onWindowResize); // 曲线宽随容器走（不用 ResizeObserver，避免弹窗卸载后回调）
    onUnmounted(() => {
      clearInterval(quoteTimer);
      clearInterval(clockTimer);
      stopCurveClock();
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('hashchange', onHashChange); // 路由监听随组件卸载移除
      ocrCleanup?.();
      mqMd.removeEventListener('change', onMqMd);
      mqLg.removeEventListener('change', onMqLg);
      mqPhone.removeEventListener('change', onMqPhone);
    });

    return {
      activeCategory,
      categories,
      fundStates,
      summary,
      profitColor,
      formatMoney,
      pctText,
      sortedFunds,
      sortKey,
      sortDesc,
      setSort,
      sortOptions,
      antTheme,
      fundColumnsShown,
      txColumns,
      showTradeForm,
      tradeForm,
      submitTrade,
      showSnapshotForm,
      snapshotForm,
      submitSnapshot,
      exportData,
      importData,
      quoteStatus,
      quoteFetchedAt,
      refreshQuotes,
      storeMode,
      needMigration,
      pendingSync,
      migrateLocalToServer,
      navModal,
      navCanvas,
      openNavModal,
      fundRowKeydown,
      navSeries,
      navRangeChange,
      setRange,
      setFundTab,
      navHoldingEmpty,
      navHoldingLatest,
      navCaption,
      dailyLen,
      // 收益页：视图态/三态/收益条/汇总层/M1-M7
      viewMode,
      setView,
      profitState,
      profitStateLabel,
      stripDayText,
      stripPrevText,
      stripDateLabel,
      stripDayProfit,
      toggleMask: () => {
        summaryHidden.value = !summaryHidden.value;
      },
      portfolio: computed(() => summary.value.portfolio),
      SOURCE_GROUPS,
      setReturnsRange,
      returnsRange,
      returnsSlice,
      returnsStats,
      returnsCanvas,
      setReturnsCanvasEl,
      attrSortDesc,
      setAttrSort,
      realizedProfit,
      summaryHidden,
      summaryCollapsed,
      estimateBoardCode,
      estimateBoardView,
      estRefreshing,
      estRefreshErr,
      openEstimateBoard,
      closeEstimateBoard,
      refreshEstimateQuote,
      curveView,
      curveSvg,
      curveEmptyText,
      curveNote,
      curveMetric,
      curvePnlBlock,
      curveTip,
      curveLoading,
      curveErr,
      METRICS,
      onCurveHover,
      onCurveLeave,
      setCurveMetric,
      onPanelClick,
      loadEstimateCurve,
      pct2,
      isoTimeShort,
      analysis,
      indexes,
      formatIndexTime,
      indexExpanded,
      toggleIndexMonitor,
      indexMonitorHtml,
      indexSparks,
      loadIndexSparks,
      navDrawdown,
      deleteFund,
      openTradeForm,
      openSnapshotForm,
      ocrImage,
      ocrBusy,
      ocrMsg,
      ocrIsErr,
      onOcrFile,
      removeOcrImage,
      runOcr,
      totalInvestedAuto,
      txModal,
      txEdit,
      txLabel,
      openTxModal,
      deleteTx,
      editTx,
      portfolioXirr,
      aiText,
      aiBusy,
      aiErr,
      runAiAnalysis,
      aiLogList,
      returnCanvas,
      returnRows,
      calView,
      calNavLabel,
      calMonthCells,
      calWeekCells,
      calYearBlocks,
      calSelectedProfit,
      calDetailRows,
      calSum,
      calMarkerLabel,
      signed,
      setCalView,
      calPrev,
      calNext,
      calToday,
      pickDay,
      m5Groups,
      calSelected,
      ocrBatch,
      saveOcrBatch,
      ocrBatchSingle,
      navIsLagged,
      prevDayLabel,
      prevDayProfitOf,
      todayStr,
      cfgModal,
      cfgOpenSections,
      cfg,
      cfgConfirm,
      cfgSavedOk,
      cfgIsStable,
      CFG_RISK_OPTIONS,
      cfgDef,
      cfgFieldsOf,
      cfgIsCustom,
      cfgSafety,
      cfgErrors,
      cfgCanSave,
      cfgCustomizedCount,
      cfgCustomizedList,
      openCfgModal,
      cfgCancel,
      cfgOnRiskClassChange,
      cfgConfirmKeep,
      cfgConfirmRevert,
      cfgResetAll,
      cfgSave,
      cfgBacktestHint,
      strategyStatus,
      strategyAlerts,
      strategyDetail,
      strategyTimeline,
      strategyBadgeOf,
      strategyEntryOf,
      openStrategyDetail,
      refreshStrategyStatus,
      refreshStrategyAlerts,
      runStrategyNow,
      ackStrategy,
      onStrategyDetailClick,
      healthStrip,
      strategyActionCount,
      themeLabel,
      updownLabel,
      toggleTheme,
      cycleUpdown,
      snapshotEditing,
      snapshotCostMismatch,
      snapshotAutoInvested,
      scheduleFundLink,
      openSnapshotEdit,
      maskText,
      summaryHidden,
      summaryCollapsed,
      blockOrder,
      visibleOrder,
      corrPending,
      corrPendingTitle,
      principalAudit,
      jumpAuditTitle,
      onDragStart,
      onDrop,
      onMoveClick,
      onSummaryHeadClick,
      onSummaryHeadKey,
      onIndexHeadKey,
    };
  },
  template: `
    <a-config-provider :theme="antTheme">
    <div>
      <div class="category-tabs view-tabs">
        <button :class="['tab', 'view-tab', { active: viewMode === 'board' }]" @click="setView('board')" :aria-current="viewMode === 'board' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
          看板
        </button>
        <button :class="['tab', 'view-tab', { active: viewMode === 'returns' }]" @click="setView('returns')" :aria-current="viewMode === 'returns' ? 'page' : undefined">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12l3.5-4 3 2.5L14 4"/></svg>
          收益
        </button>
        <div class="tab-tools">
          <button class="theme-btn" @click="toggleTheme" :title="'主题（当前：' + themeLabel + '，点击切换）'"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 010 12z" fill="currentColor"/></svg>{{ themeLabel }}</button>
          <button class="theme-btn" @click="cycleUpdown" :title="'涨跌色（当前：' + updownLabel + '，点击切换）'"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 6l3-3 3 3M5 10l3 3 3-3"/></svg>{{ updownLabel }}</button>
          <button class="privacy-btn" @click.stop="toggleMask" :title="summaryHidden ? '显示金额' : '隐藏金额（防窥）'"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>{{ summaryHidden ? '显示金额' : '隐藏金额' }}</span></button>
        </div>
      </div>
      <!-- 首页收益条已移至核心指数监控卡下方（order:3；顶部固定非排序区块） -->
      <div v-if="viewMode === 'board'" class="blocks-wrap" @dragstart="onDragStart" @dragover.prevent @drop.prevent="onDrop" @click="onMoveClick">
        <!-- 资产总览位于收益页 M1；本金徽标留在首页、置于健康条旁 -->
        <div v-if="corrPending.length || principalAudit.unexplained.length" class="principal-badges">
          <span v-if="corrPending.length" class="corr-pending" :title="corrPendingTitle">本金修正待体现 {{ corrPending.length }} 条</span>
          <span v-if="principalAudit.unexplained.length" class="corr-audit" :title="jumpAuditTitle">本金跳变未留痕 {{ principalAudit.unexplained.length }} 处</span>
        </div>
        <div v-if="healthStrip" class="health-wrap blk" data-blk="health" :style="{ order: visibleOrder.indexOf('health') + 1 }" v-html="healthStrip"></div>
        <div v-if="indexes.length" class="idxm-wrap blk" data-blk="idx" :style="{ order: visibleOrder.indexOf('idx') + 1 }" :class="{ 'is-collapsed': !indexExpanded }" role="button" tabindex="0" :aria-expanded="String(indexExpanded)" aria-label="核心指数监控，点击折叠或展开" @click="toggleIndexMonitor" @keydown.enter="onIndexHeadKey" @keydown.space="onIndexHeadKey" v-html="indexMonitorHtml"></div>
        <!-- 收益条：置于核心指数监控卡下方（order:3），与各卡片同一间距；👁 与收益页 M1 双入口共用；非点击跳转区块 -->
        <div class="profit-strip" style="order: 3">
          <div class="ps-main">
            <span class="ps-label">当日收益</span>
            <span class="ps-tag" :class="'ps-' + profitState">{{ profitStateLabel }}</span>
            <b class="ps-num" :style="stripDayProfit != null && !summaryHidden ? { color: profitColor(stripDayProfit) } : {}">{{ stripDayText }}</b>
          </div>
          <div class="ps-sub">
            <span>昨日 <b :style="!summaryHidden && summary.portfolio?.total?.prevDayProfit != null ? { color: profitColor(summary.portfolio.total.prevDayProfit) } : {}">{{ stripPrevText }}</b></span>
            <span v-if="stripDateLabel" class="ps-date">{{ stripDateLabel }}</span>
            <span class="ps-flex"></span>
            <button type="button" class="icon-btn" :title="summaryHidden ? '显示金额' : '隐藏金额（防窥）'" @click.stop="toggleMask"><svg v-if="summaryHidden" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="4" y1="20" x2="20" y2="4"/></svg><svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        </div>
        <div v-if="quoteStatus === 'failed'" class="offline-tip sys-tip">
          行情获取失败，请确认 npm start 服务已启动。其余功能（录入 / 预警 / 导入导出）不受影响。
        </div>
        <div v-if="needMigration" class="offline-tip sys-tip">
          检测到本浏览器存有持仓数据，服务端还是空的——数据只存浏览器容易丢失。
          <button class="btn-primary tip-btn" @click="migrateLocalToServer">一键上传到服务端</button>
        </div>
        <div v-if="pendingSync" class="offline-tip sys-tip">
          部分改动暂存在本地镜像（服务暂不可达），服务恢复后再次操作会自动重推。
        </div>
      </div>

      <div v-if="viewMode === 'board'" class="toolbar">
        <div class="sort-group">
          <span class="sort-label">排序：</span>
          <button
            v-for="opt in sortOptions"
            :key="opt.key"
            :class="['sort-btn', { active: sortKey === opt.key }]"
            @click="setSort(opt.key)"
          >
            {{ opt.label }}{{ sortKey === opt.key ? (sortDesc ? ' ↓' : ' ↑') : '' }}
          </button>
        </div>
        <div class="action-group">
          <span class="quote-status">
            <span :class="['dot', quoteStatus === 'ok' ? 'ok' : quoteStatus === 'loading' ? 'busy' : 'fail']"></span>
            {{ quoteStatus === 'ok' ? '行情 ' + quoteFetchedAt : quoteStatus === 'loading' ? '更新中…' : '行情失败' }}
          </span>
          <button class="btn-secondary" @click="refreshQuotes" :disabled="quoteStatus === 'loading'">刷新行情</button>
          <button class="btn-secondary" @click="exportData">导出</button>
          <label class="btn-secondary file-label">
            导入
            <input type="file" accept=".json" @change="importData" hidden>
          </label>
          <button class="btn-primary" @click="openSnapshotForm">+ 导入基金</button>
          <button class="btn-primary" @click="openTradeForm">+ 录入交易</button>
        </div>
      </div>

      <div v-if="viewMode === 'board'" class="table-wrap">
        <a-table
          class="fund-table"
          :columns="fundColumnsShown"
          :data-source="sortedFunds"
          :pagination="false"
          :scroll="{ x: 'max-content' }"
          :row-key="r => r.id"
          size="middle"
          :custom-row="r => ({ onClick: () => openNavModal(r), tabindex: 0, onKeydown: (e) => fundRowKeydown(e, r) })"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div class="fund-name">{{ record.name }}</div>
              <div class="fund-code">{{ record.code }}</div>
            </template>
            <template v-else-if="column.key === 'principal'">
              {{ maskText(formatMoney(record.state.totalInvested), summaryHidden) }}
            </template>
            <template v-else-if="column.key === 'daily'">
              <!-- 当日列：上面收益、下面涨幅（合并展示）；净值未发布到当天时显示待更新。
                   整列可点 → 实时估值盘（估值中/已更新/净值滞后/待更新 四种状态面板按状态分支） -->
              <div class="cell-est" title="查看实时估值盘（估值净值与确认净值明细）" @click.stop="openEstimateBoard(record)">
                <div>
                  <span v-if="record.state.dayProfit != null" class="d-main" :style="summaryHidden ? {} : { color: profitColor(record.state.dayProfit) }">
                    {{ maskText(formatMoney(record.state.dayProfit), summaryHidden) }}
                  </span>
                  <span v-else class="muted">待更新</span>
                </div>
                <div class="nav-date">
                  <template v-if="record.state.dayChangePct != null">
                    <span :style="summaryHidden ? {} : { color: profitColor(record.state.dayChangePct) }">
                      {{ maskText((record.state.dayChangePct > 0 ? '+' : '') + record.state.dayChangePct.toFixed(2) + '%', summaryHidden) }}
                    </span>
                    <span v-if="record.state.mode === 'estimate'" class="tag-est">估</span>
                    <span v-else-if="record.state.dataDate === todayStr()" class="tag-confirmed">已更新</span>
                    <span v-if="navIsLagged(record.state)" class="tag-lag" :title="'净值更新滞后：当日/昨日按 ' + record.state.navDate + ' 口径'">净值 {{ record.state.navDate.slice(5) }}</span>
                  </template>
                  <span v-else class="muted">—</span>
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'yesterday'">
              <!-- 取值与汇总层同口径回退（prevDayProfit ?? dailyProfit）：周末/长假/周一盘前
                   prevDayProfit 为 null，显示的是「最近净值日」单日变动——列标题此时显示为「上一净值日」 -->
              <span v-if="prevDayProfitOf(record.state) != null" :style="summaryHidden ? {} : { color: profitColor(prevDayProfitOf(record.state)) }">
                {{ maskText(formatMoney(prevDayProfitOf(record.state)), summaryHidden) }}
              </span>
              <span v-else class="muted">待更新</span>
              <span v-if="navIsLagged(record.state)" class="tag-lag" :title="'净值更新滞后：当日/昨日按 ' + record.state.navDate + ' 口径'">净值 {{ record.state.navDate.slice(5) }}</span>
            </template>
            <template v-else-if="column.key === 'hold'">
              <span class="d-main" :style="summaryHidden ? {} : { color: profitColor(record.state.holdProfit) }">
                {{ maskText(formatMoney(record.state.holdProfit), summaryHidden) }}
              </span>
              <div v-if="record.state.returnRate != null" class="nav-date">
                {{ maskText(pctText(record.state.returnRate), summaryHidden) }}<template v-if="record.state.xirr != null"> · 年化 {{ maskText(pctText(record.state.xirr), summaryHidden) }}</template>
              </div>
            </template>
            <template v-else-if="column.key === 'alert'">
              <span class="al-cell" @click.stop="openStrategyDetail(record)" v-html="strategyBadgeOf(record)"></span>
            </template>
            <template v-else-if="column.key === 'nav'">
              <template v-if="record.state.latestNav != null">
                <b>{{ record.state.latestNav.toFixed(4) }}<span v-if="record.state.mode === 'estimate'" class="tag-est">估</span></b>
                <div class="nav-date">
                  <template v-if="record.state.mode === 'estimate' && record.state.confirmedNav != null">
                    净值 {{ record.state.confirmedNav.toFixed(4) }} · {{ record.state.navDate ? record.state.navDate.slice(5) : '' }}
                  </template>
                  <template v-else>{{ record.state.navDate ? record.state.navDate.slice(5) : '' }}</template>
                </div>
              </template>
              <span v-else class="muted">待更新</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <button class="btn-mini" @click.stop="openTxModal(record)">记录</button>
              <button class="btn-mini" @click.stop="openSnapshotEdit(record)">编辑</button>
              <button class="btn-mini" @click.stop="openCfgModal(record)">策略</button>
              <button class="btn-del" @click.stop="deleteFund(record)">删除</button>
            </template>
          </template>
        </a-table>
      </div>

      <div v-if="viewMode === 'board' && analysis" class="analysis-card">
        <div class="analysis-head">
          <b>{{ analysis.dataDate === analysis.today ? '今日行情分析' : '最新行情分析' }}</b>
          <span class="analysis-head-right">
            <span class="date">{{ analysis.dataDateLabel }} · 规则生成</span>
            <button class="btn-mini" :disabled="aiBusy" @click="runAiAnalysis">{{ aiBusy ? 'AI 解读生成中…' : '✨ AI 解读' }}</button>
          </span>
        </div>
        <!-- 规则报告：4 条内容以无序列表逐条呈现；金额只在屏幕显示，不外发见 runAiAnalysis -->
        <ul class="report-list">
          <li v-for="(line, i) in analysis.reportLines" :key="i">{{ line }}</li>
        </ul>
        <div v-if="aiText || aiBusy" :class="['ai-block', { err: aiErr }]">
          <span class="ai-badge">✨ AI</span><span>{{ aiBusy ? '解读生成中，请稍候…' : aiText }}</span>
        </div>
        <details v-if="aiLogList.length > 0" class="ai-history">
          <summary>AI 解读历史（{{ aiLogList.length }} 天）</summary>
          <div v-for="e in aiLogList" :key="e.date" class="ai-history-item">
            <div class="ai-history-date">{{ e.date }}</div>
            <div class="ai-history-text">{{ e.text }}</div>
          </div>
        </details>
        <!-- 归因条迁入收益页 M7 -->
        <div class="metric-tags">
          <span v-if="strategyActionCount > 0" class="metric-tag alert">⚠ {{ strategyActionCount }} 只持仓触发策略建议</span>
        </div>
      </div>



      <div v-if="viewMode === 'board'" class="strategy-timeline-card">
        <div class="analysis-head">
          <b>策略触发记录</b>
          <span class="analysis-head-right">
            <span class="date">触发即留痕 · 可回看「当时为什么喊你操作」</span>
            <button class="btn-mini" :disabled="strategyStatus.loading" @click="runStrategyNow">{{ strategyStatus.loading ? '巡检中…' : '立即巡检' }}</button>
          </span>
        </div>
        <div class="strategy-timeline-body" v-html="strategyTimeline"></div>
      </div>

      <div v-if="navModal" class="modal-overlay" @click.self="navModal = null">
        <div class="modal modal-wide" data-modal="nav" tabindex="-1">
          <div class="modal-header">
            <div class="m-title">
              <span class="t">{{ navModal.fund.name }}（{{ navModal.fund.code }}）</span>
            </div>
            <button type="button" class="modal-close" aria-label="关闭" @click="navModal = null">✕</button>
          </div>
          <div class="m-toolbar">
            <div class="modal-tabs">
              <button :class="['range-btn', { active: navModal.tab === 'nav' }]" @click="setFundTab('nav')">净值走势</button>
              <button :class="['range-btn', { active: navModal.tab === 'hold' }]" @click="setFundTab('hold')">持有收益走势</button>
            </div>
            <div class="range-toggle">
              <button :class="['range-btn', { active: navModal.range === 30 }]" @click="setRange(30)">近30日</button>
              <button :class="['range-btn', { active: navModal.range === 90 }]" @click="setRange(90)">近90日</button>
            </div>
          </div>
          <!-- 图注行固定图表上方，随 Tab/持仓条件切换；navCaption 已含"确有图可画"判定（无图不显示） -->
          <div v-if="navCaption" class="m-caption">{{ navCaption }}</div>
          <div v-if="navModal.loading" class="empty-hint">加载中…</div>
          <template v-else-if="navModal.tab === 'nav'">
            <div v-if="navModal.error || navSeries.length === 0" class="empty-hint">走势数据获取失败（新基金可能还没有历史净值）</div>
            <template v-else>
              <div class="chart-box"><canvas ref="navCanvas"></canvas></div>
              <div class="chart-foot">
                <span class="metric-tag info">最新净值 {{ navModal.fund.state.latestNav ?? '—' }}（{{ navModal.fund.state.navDate ?? '—' }}）</span>
                <span v-if="navRangeChange" class="metric-tag info">区间涨幅 {{ navRangeChange }}</span>
                <span v-if="navDrawdown" class="metric-tag info">近90日最大回撤 {{ navDrawdown }}</span>
                <span v-if="navModal.fund.state.xirr != null" class="metric-tag info">年化(XIRR) {{ maskText(pctText(navModal.fund.state.xirr), summaryHidden) }}</span>
              </div>
            </template>
          </template>
          <template v-else>
            <div v-if="navModal.error" class="empty-hint">走势数据获取失败（新基金可能还没有历史净值）</div>
            <div v-else-if="navHoldingEmpty" class="empty-hint">{{ navHoldingEmpty }}</div>
            <template v-else>
              <div class="chart-box"><canvas ref="navCanvas"></canvas></div>
              <div class="chart-foot">
                <span class="metric-tag info">最新持有收益 {{ navHoldingLatest != null ? maskText(formatMoney(navHoldingLatest), summaryHidden) : '—' }}</span>
              </div>
            </template>
          </template>
        </div>
      </div>

      <!-- 实时估值盘（主表「当日」单元格 → 点击打开）：
           整列可点，面板按 state.mode/dataDate 分支（估值中 / 已更新 / 净值滞后到账 / 待更新）；
           数字随页面 60s 轮询自动更新（视图模型读 quotesMap），另有单只刷新按钮 -->
      <div v-if="estimateBoardCode" class="modal-overlay" @click.self="closeEstimateBoard()">
        <div class="modal modal-wide" data-modal="estimate" tabindex="-1" @click="onPanelClick">
          <div class="modal-header">
            <span>{{ estimateBoardView?.name ?? '' }}（{{ estimateBoardCode }}）· 实时估值盘</span>
            <button type="button" class="modal-close" aria-label="关闭" @click="closeEstimateBoard()">✕</button>
          </div>
          <template v-if="estimateBoardView">
            <div class="est-head">
              <span :class="['est-badge', estimateBoardView.status === 'estimate' ? 'tag-est' : (estimateBoardView.status === 'confirmed' ? 'tag-confirmed' : 'tag-lag')]">{{ estimateBoardView.statusLabel }}</span>
              <span class="est-note">{{ estimateBoardView.statusNote }}</span>
            </div>
            <div class="est-grid">
              <div class="est-box">
                <div class="l">{{ estimateBoardView.mainIsEstimate ? '估算净值（盘中）' : '确认净值' }}</div>
                <div class="v" :style="{ color: profitColor(estimateBoardView.mainChangePct) }">
                  {{ estimateBoardView.mainNav != null ? estimateBoardView.mainNav.toFixed(4) : '—' }}
                  <small>{{ pct2(estimateBoardView.mainChangePct) }}</small>
                </div>
                <div class="s">估值时间 {{ estimateBoardView.estimateTime ? estimateBoardView.estimateTime.slice(11) : '—' }}</div>
              </div>
              <div class="est-box">
                <div class="l">{{ estimateBoardView.mainIsEstimate ? '估算当日盈亏' : '当日盈亏' }}</div>
                <div class="v" :style="summaryHidden ? {} : { color: profitColor(estimateBoardView.dayProfit) }">{{ estimateBoardView.dayProfit != null ? maskText(formatMoney(estimateBoardView.dayProfit), summaryHidden) : '—' }}</div>
                <div class="s">持有份额 {{ estimateBoardView.holdShares != null ? estimateBoardView.holdShares.toFixed(2) : '—' }} · 持有收益
                  <span :style="summaryHidden ? {} : { color: profitColor(estimateBoardView.holdProfit) }">{{ estimateBoardView.holdProfit != null ? maskText(formatMoney(estimateBoardView.holdProfit), summaryHidden) : '—' }}</span>
                </div>
              </div>
              <div class="est-box">
                <div class="l">{{ estimateBoardView.mainIsEstimate ? '估算市值' : '市值' }}</div>
                <div class="v">{{ estimateBoardView.marketValue != null ? maskText(formatMoney(estimateBoardView.marketValue), summaryHidden) : '—' }}</div>
                <div class="s">累计投入 {{ estimateBoardView.totalInvested != null ? maskText(formatMoney(estimateBoardView.totalInvested), summaryHidden) : '—' }}</div>
              </div>
              <div class="est-box">
                <div class="l">最近确认净值</div>
                <div class="v">
                  {{ estimateBoardView.confirmedNav != null ? estimateBoardView.confirmedNav.toFixed(4) : '—' }}
                  <small :style="{ color: profitColor(estimateBoardView.confirmedChangePct) }">{{ pct2(estimateBoardView.confirmedChangePct) }}</small>
                </div>
                <div class="s">净值日 {{ estimateBoardView.confirmedNavDate ?? '—' }}<template v-if="estimateBoardView.navDelta != null"> · 每份较其 {{ estimateBoardView.navDelta > 0 ? '+' : '' }}{{ estimateBoardView.navDelta.toFixed(4) }}</template></div>
              </div>
            </div>
            <div class="curve-block">
              <div class="curve-head">
                <span class="curve-title">当天估值走势</span>
                <span class="curve-tabs">
                  <button v-for="m in METRICS" :key="m.key" type="button"
                    :class="['curve-tab', { 'is-on': curveMetric === m.key }]"
                    :aria-pressed="curveMetric === m.key ? 'true' : 'false'"
                    :disabled="m.key === 'pnl' && !!curvePnlBlock"
                    :title="m.key === 'pnl' && curvePnlBlock ? curvePnlBlock : m.label"
                    @click="setCurveMetric(m.key)">{{ m.label }}</button>
                </span>
              </div>
              <div class="curve-wrap" @mousemove="onCurveHover" @mouseleave="onCurveLeave"
                   @touchstart.passive="onCurveHover" @touchmove.passive="onCurveHover">
                <div v-if="curveSvg" v-html="curveSvg"></div>
                <div v-else class="curve-empty">{{ curveEmptyText }}</div>
                <div v-if="curveTip" class="curve-tip"
                     :style="{ left: curveTip.x + 'px', top: curveTip.y + 'px' }">{{ curveTip.text }}</div>
              </div>
              <div class="curve-legend">
                <span><i class="ln"></i>新浪估算曲线（口径2）</span>
                <span><i class="ln dash"></i>0 基线</span>
                <span class="curve-hint">仅当天 09:30–15:00 · 每 60 秒随轮询更新</span>
                <span v-if="curveErr" class="curve-err">走势刷新失败：{{ curveErr }}{{ curveView?.hasData ? '（当前显示上次成功的数据）' : '' }}</span>
              </div>
              <div v-if="curveNote" class="curve-note">{{ curveNote }}</div>
              <div class="curve-note">
                ⚠ 曲线为<b>新浪估算</b>（口径2），与上方大数字（主源天天基金）是两套算法，末尾可能差零点几个百分点；两者都属「盘中参考」，官方净值以基金公司晚间公布为准。
              </div>
            </div>
            <div class="est-meta">
              <span>数据源 {{ estimateBoardView.sourceLabel ?? '—' }}</span>
              <span>行情取数 {{ isoTimeShort(estimateBoardView.fetchedAt) }}</span>
              <span>每 60 秒随页面轮询自动更新</span>
              <span v-if="estRefreshErr" class="est-err">刷新失败：{{ estRefreshErr }}</span>
            </div>
            <div class="est-foot">
              <span class="est-warn">估值为盘中参考，官方净值以基金公司晚间公布为准。</span>
              <button type="button" class="btn-secondary" :disabled="estRefreshing" @click="refreshEstimateQuote(); loadEstimateCurve({ force: true })">{{ estRefreshing ? '刷新中…' : '刷新' }}</button>
            </div>
          </template>
          <div v-else class="empty-hint">该基金已不在持仓列表</div>
        </div>
      </div>

      <div v-if="txModal" class="modal-overlay" @click.self="txModal = null">
        <div class="modal modal-wide" data-modal="tx" tabindex="-1">
          <div class="modal-header">
            <span>{{ txModal.name }}（{{ txModal.code }}）· 交易记录</span>
            <button type="button" class="modal-close" aria-label="关闭" @click="txModal = null">✕</button>
          </div>
          <div v-if="txModal.list.length" class="tx-table-wrap">
            <a-table
              class="tx-table"
              :columns="txColumns"
              :data-source="txModal.list"
              :pagination="false"
              :scroll="{ x: 'max-content' }"
              :row-key="r => r.idx"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'date'">
                  {{ record.tx.date || '—' }}
                </template>
                <template v-else-if="column.key === 'type'">
                  <span :class="record.tx.type === 'buy' ? 'up' : record.tx.type === 'sell' ? 'down' : 'muted'">{{ txLabel(record.tx) }}</span>
                </template>
                <template v-else-if="column.key === 'amount'">
                  {{ record.tx.amount != null ? maskText(formatMoney(record.tx.amount), summaryHidden) : '—' }}
                </template>
                <template v-else-if="column.key === 'shares'">
                  {{ record.tx.shares != null ? record.tx.shares : '—' }}
                </template>
                <template v-else-if="column.key === 'actions'">
                  <button class="btn-mini" @click="editTx(record)">编辑</button>
                  <button class="btn-del" @click="deleteTx(record)">删除</button>
                </template>
              </template>
            </a-table>
          </div>
          <div v-else class="empty-hint">该基金暂无交易记录（只有初始快照）</div>
          <div class="chart-foot">
            <span class="metric-tag info">删除 / 修改后，本金与收益将按剩余记录自动重算</span>
          </div>
        </div>
      </div>

      <div v-if="strategyDetail" class="modal-overlay" @click.self="strategyDetail = null">
        <div class="modal modal-wide">
          <!-- 标题行取消；关闭钮由稿内 .sd-side 流内承担（data-sd-close，走 onStrategyDetailClick 委托） -->
          <div class="modal-body-flat" v-html="strategyDetail.html" @click="onStrategyDetailClick"></div>
        </div>
      </div>

${STRATEGY_CFG_MODAL}

      <div v-if="showTradeForm" class="modal-overlay" @click.self="showTradeForm = false">
        <div class="modal">
          <div class="modal-header">
            <span>{{ txEdit ? '编辑交易' : '录入交易' }}</span>
          </div>
          <div class="form-grid">
            <div class="form-field">
              <label>基金</label>
              <select v-model="tradeForm.fundId" :disabled="!!txEdit">
                <option v-for="f in fundStates" :key="f.id" :value="f.id">{{ f.name }} ({{ f.code }})</option>
              </select>
            </div>
            <div class="form-field">
              <label>交易类型</label>
              <div class="radio-group">
                <button :class="['radio-btn', { active: tradeForm.type === 'buy' }]" @click="tradeForm.type = 'buy'">买入</button>
                <button :class="['radio-btn', { active: tradeForm.type === 'sell' }]" @click="tradeForm.type = 'sell'">卖出</button>
                <button :class="['radio-btn', { active: tradeForm.type === 'dividend' }]" @click="tradeForm.type = 'dividend'">分红</button>
              </div>
            </div>
            <div class="form-field" v-if="tradeForm.type === 'buy'">
              <label>买入金额（元）</label>
              <input type="number" step="0.01" v-model="tradeForm.amount" placeholder="1000.00">
            </div>
            <div class="form-field" v-if="tradeForm.type === 'buy'">
              <label>买入份额</label>
              <input type="number" step="0.01" v-model="tradeForm.shares" placeholder="952.38">
            </div>
            <div class="form-field" v-if="tradeForm.type === 'sell'">
              <label>卖出份额</label>
              <input type="number" step="0.01" v-model="tradeForm.shares" placeholder="300.00">
            </div>
            <div class="form-field" v-if="tradeForm.type === 'dividend'">
              <label>分红方式</label>
              <div class="radio-group">
                <button :class="['radio-btn', { active: tradeForm.dividendMethod === 'cash' }]" @click="tradeForm.dividendMethod = 'cash'">现金分红</button>
                <button :class="['radio-btn', { active: tradeForm.dividendMethod === 'reinvest' }]" @click="tradeForm.dividendMethod = 'reinvest'">红利再投</button>
              </div>
            </div>
            <div class="form-field" v-if="tradeForm.type === 'dividend' && tradeForm.dividendMethod === 'reinvest'">
              <label>再投份额</label>
              <input type="number" step="0.01" v-model="tradeForm.shares" placeholder="50.00">
            </div>
            <div class="form-field">
              <label>日期</label>
              <input type="date" v-model="tradeForm.date">
            </div>
          </div>
          <div class="ocr-block">
            <div class="ocr-row">
              <span class="ocr-label">截图识别（可选）：</span>
              <label class="btn-secondary ocr-btn">选择截图<input type="file" accept="image/*" multiple hidden @change="onOcrFile"></label>
              <span class="ocr-hint">可多选 / 多次 Ctrl+V 粘贴（多张单笔截图、长截图均可，自动切换表单）</span>
              <button class="btn-primary" :disabled="ocrImage.length === 0 || ocrBusy" @click="runOcr">{{ ocrBusy ? '识别中…' : '识别并填入' }}</button>
            </div>
            <div v-if="ocrImage.length > 0" class="ocr-preview-list">
              <div v-for="(img, i) in ocrImage" :key="i" class="ocr-preview-item">
                <img :src="img" class="ocr-preview" alt="截图预览">
                <button class="ocr-remove" title="移除这张" @click="removeOcrImage(i)">✕</button>
              </div>
            </div>
            <div v-if="ocrMsg" :class="['ocr-msg', { err: ocrIsErr }]">{{ ocrMsg }}</div>
            <div v-if="ocrBatch" class="ocr-batch">
              <div class="ocr-batch-head">共 {{ ocrBatch.length }} 笔{{ ocrBatch.some(i => !i.fund) ? '，其中未匹配持仓补全基金代码后保存将自动创建' : '' }}，核对后保存：</div>
              <div class="ocr-batch-list">
              <div v-for="(item, i) in ocrBatch" :key="i" :class="['ocr-batch-row', { dup: item.isDup }]">
                <span class="t">{{ item.tx.date }} · {{ txLabel(item.tx) }}</span>
                <span class="v">
                  {{ item.tx.amount != null ? '¥' + item.tx.amount : '' }}{{ item.tx.amount != null && item.tx.shares != null ? ' · ' : '' }}{{ item.tx.shares != null ? item.tx.shares + ' 份' : '' }}
                </span>
                <input v-if="item.fillShares !== null && !item.isDup" v-model="item.fillShares" type="number" step="0.01" min="0" class="ocr-shares-input" placeholder="补份额">
                <span class="f">{{ item.fund ? item.fund.name : (item.tx.name || item.tx.code || '未匹配持仓') }}</span>
                <input v-if="!item.fund && !item.tx.code" v-model="item.fundCode" class="ocr-shares-input ocr-code-input" type="text" inputmode="numeric" maxlength="6" placeholder="6位基金代码" title="截图没有基金代码，补全后保存将自动创建持仓">
                <span v-if="!item.fund && (item.tx.code || item.fundCode)" class="ocr-new-tag">将自动创建</span>
                <span v-if="item.isDup" class="ocr-dup-tag">重复</span>
              </div>
              </div>
              <div class="ocr-batch-actions">
                <button class="btn-primary" @click="saveOcrBatch">全部保存</button>
                <button class="btn-secondary" @click="ocrBatchSingle">逐笔录入</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-cancel" @click="showTradeForm = false">取消</button>
            <button class="btn-primary" @click="submitTrade">保存</button>
          </div>
        </div>
      </div>

      <div v-if="showSnapshotForm" class="modal-overlay" @click.self="showSnapshotForm = false">
        <div class="modal">
          <div class="modal-header">{{ snapshotEditing ? '编辑持仓快照 · ' + snapshotForm.name + '（' + snapshotForm.code + '）' : '初次导入 · 持仓快照' }}</div>
          <div class="form-grid">
            <div class="form-field">
              <label>基金名称</label>
              <input type="text" v-model="snapshotForm.name" placeholder="沪深300指数" :disabled="!!snapshotEditing" @input="scheduleFundLink('name')">
              <div v-if="snapshotEditing" class="field-hint">编辑模式锁定（改名/改码=换基金，请删除后重录）</div>
            </div>
            <div class="form-field">
              <label>基金代码</label>
              <input type="text" v-model="snapshotForm.code" placeholder="110020" :disabled="!!snapshotEditing" @input="scheduleFundLink('code')">
            </div>
            <div class="form-field">
              <label>持有金额（元）</label>
              <input type="number" step="0.01" v-model="snapshotForm.holdAmount" placeholder="10500.00">
            </div>
            <div class="form-field">
              <label>待确认金额（元）</label>
              <input type="number" step="0.01" v-model="snapshotForm.pendingAmount" placeholder="0.00">
            </div>
            <div class="form-field">
              <label>持仓成本价</label>
              <input type="number" step="0.0001" v-model="snapshotForm.costPrice" placeholder="1.0500">
            </div>
            <div class="form-field">
              <label>持有份额</label>
              <input type="number" step="0.01" v-model="snapshotForm.holdShares" placeholder="10000.00">
            </div>
            <div class="form-field">
              <label>累计投入本金（元）</label>
              <input type="number" step="0.01" v-model="snapshotForm.totalInvested" placeholder="10000.00" @input="totalInvestedAuto = false">
              <div v-if="snapshotEditing" class="field-hint">支付宝查法：本金 = 市值 − 累计收益（基金详情页两数同框）</div>
              <div v-else-if="totalInvestedAuto" class="field-hint">此值由 成本价×份额 自动计算，仅供参考，可直接修改为实际投入</div>
            </div>
          </div>
          <div v-if="snapshotCostMismatch" class="mismatch-note">
            ⚠ 摊薄成本口径不一致：成本价 × 份额 = <b>{{ snapshotAutoInvested }}</b> 元，与累计投入本金 <b>{{ snapshotForm.totalInvested }}</b> 元不同——通常因为有过<b>卖出或现金分红</b>（摊薄成本会被摊低）。确认「累计投入本金」是真实累计投入即可保存；若手上有现金分红未记录，先用「+ 录入交易」补一条分红。
          </div>
          <div v-if="snapshotEditing" class="dividend-hint-line">
            持有期间如有<b>现金分红</b>未记录，请用「+ 录入交易」补录分红——亏损率计算会把分红从亏损中扣除，漏录会显得亏得更多。
          </div>
          <p class="form-hint">注：快照只录一次，之后只录交易。「累计投入本金」是你截至快照时点一共投进这只基金的本金（不是持有金额，持有金额=本金+利润）。日涨幅、基金净值联网后自动更新。</p>
          <div v-if="!snapshotEditing" class="ocr-block">
            <div class="ocr-row">
              <span class="ocr-label">截图识别（可选）：</span>
              <label class="btn-secondary ocr-btn">选择截图<input type="file" accept="image/*" multiple hidden @change="onOcrFile"></label>
              <span class="ocr-hint">可多选 / 多次 Ctrl+V 粘贴（资产详情 / 成交记录均可，自动切换表单）</span>
              <button class="btn-primary" :disabled="ocrImage.length === 0 || ocrBusy" @click="runOcr">{{ ocrBusy ? '识别中…' : '识别并填入' }}</button>
            </div>
            <div v-if="ocrImage.length > 0" class="ocr-preview-list">
              <div v-for="(img, i) in ocrImage" :key="i" class="ocr-preview-item">
                <img :src="img" class="ocr-preview" alt="截图预览">
                <button class="ocr-remove" title="移除这张" @click="removeOcrImage(i)">✕</button>
              </div>
            </div>
            <div v-if="ocrMsg" :class="['ocr-msg', { err: ocrIsErr }]">{{ ocrMsg }}</div>
          </div>
          <div class="modal-footer">
            <span v-if="snapshotEditing" style="font-size:12px; color:var(--color-muted); margin-right:auto;">保存后策略引擎按新本金即时重算徽章</span>
            <button class="btn-cancel" @click="showSnapshotForm = false">取消</button>
            <button class="btn-primary" @click="submitSnapshot">保存</button>
          </div>
        </div>
      </div>

      <!-- ==================== 收益页（视图态/三态/收益条/汇总层/M1-M7） ==================== -->
      <div v-if="viewMode === 'returns'" class="returns-page">
        <!-- M1 收益总览（原首页资产总览迁入 + 累计收益 + 组合年化；打码/折叠沿用既有偏好键，双入口同步） -->
        <div class="sp3 blk m-block col-full">
          <div class="sp3-head" role="button" tabindex="0" :aria-expanded="String(!summaryCollapsed)" aria-label="收益总览，点击折叠或展开" @click="onSummaryHeadClick" @keydown.enter="onSummaryHeadKey" @keydown.space="onSummaryHeadKey">
            <span class="sp3-title">收益总览</span>
            <span class="sp-sum">总资产 <b>{{ portfolio.total.value != null ? maskText(formatMoney(portfolio.total.value), summaryHidden) : '待更新' }}</b> · 累计 <b>{{ portfolio.total.cumulativeProfit != null ? maskText(formatMoney(portfolio.total.cumulativeProfit), summaryHidden) : '—' }}</b></span>
            <button type="button" class="icon-btn" :title="summaryHidden ? '显示金额' : '隐藏金额（防窥）'" @click.stop="toggleMask"><svg v-if="summaryHidden" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="4" y1="20" x2="20" y2="4"/></svg><svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button type="button" class="sp-fold-btn" :title="summaryCollapsed ? '展开' : '收起'" @click.stop="summaryCollapsed = !summaryCollapsed"><span class="t-open">收起</span><span class="t-closed">展开</span><span class="chev">▲</span></button>
          </div>
          <div v-show="!summaryCollapsed" class="sp3-body"><div class="sp3-in hero">
            <div class="hero-primary">
              <div class="metric-title">总资产</div>
              <!-- 任一基金无行情 → total.value 走 requireAll 置 null，必须显「待更新」而不是 ¥0.00 -->
              <div class="hero-value">{{ summary.totalAssets != null ? maskText(formatMoney(summary.totalAssets), summaryHidden) : '待更新' }}</div>
              <div class="card-sub">投入总本金 {{ maskText(formatMoney(summary.totalInvested), summaryHidden) }}</div>
            </div>
            <div class="hero-metric">
              <div class="metric-title">持有收益</div>
              <div class="metric-row">
                <span class="metric-stat" :style="summaryHidden || summary.totalHoldProfit == null ? {} : { color: profitColor(summary.totalHoldProfit) }">{{ summary.totalHoldProfit != null ? maskText(formatMoney(summary.totalHoldProfit), summaryHidden) : '—' }}</span>
                <!-- null >= 0 为 true，直接比大小会把「不可算」渲染成涨色 -->
                <span class="tag-badge" :class="summary.returnRate > 0 ? 'up' : summary.returnRate < 0 ? 'down' : ''">{{ summary.returnRate != null ? maskText(pctText(summary.returnRate), summaryHidden) : '—' }}</span>
              </div>
            </div>
            <div class="hero-metric">
              <div class="metric-title">当日收益<span v-if="summary.anyEstimate" class="tag-est">估</span></div>
              <div class="metric-stat" :style="summaryHidden || summary.totalDayProfit == null ? {} : { color: profitColor(summary.totalDayProfit) }">{{ summary.totalDayProfit != null ? maskText(formatMoney(summary.totalDayProfit), summaryHidden) : '待更新' }}</div>
              <div class="card-sub">{{ prevDayLabel }} {{ summary.totalPrevDayProfit != null ? maskText(formatMoney(summary.totalPrevDayProfit), summaryHidden) : '—' }}</div>
            </div>
            <div class="hero-metric">
              <div class="metric-title">累计收益（含已赎回）</div>
              <div class="metric-stat" :style="summaryHidden || (summary.portfolio && summary.portfolio.total.cumulativeProfit) == null ? {} : { color: profitColor(summary.portfolio.total.cumulativeProfit) }">{{ summary.portfolio && summary.portfolio.total.cumulativeProfit != null ? maskText(formatMoney(summary.portfolio.total.cumulativeProfit), summaryHidden) : '—（交易记录不全）' }}</div>
              <div class="card-sub">组合年化(XIRR) {{ portfolioXirr != null ? maskText(pctText(portfolioXirr), summaryHidden) : '—' }}</div>
            </div>
          </div></div>
        </div>

        <!-- M2 资产 / 收益走势（按净值日聚合；区间四档；回撤 = TWR 口径） -->
        <div class="blk m-block chart-card col-full">
          <div class="chart-head">
            <b>资产 / 收益走势</b>
            <span class="chart-legend">
              <span><i style="background:var(--chart-line)"></i>总资产</span>
              <span><i style="height:0;border-top:2px dashed var(--chart-invest)"></i>累计投入</span>
              <span class="legend-hint">两线间距 = 持有收益</span>
            </span>
            <span class="ctl-label">区间：</span>
            <button class="seg" :class="{ active: returnsRange === 30 }" @click="setReturnsRange(30)">近30日</button>
            <button class="seg" :class="{ active: returnsRange === 90 }" @click="setReturnsRange(90)">近90日</button>
            <button class="seg" :class="{ active: returnsRange === 365 }" @click="setReturnsRange(365)">近1年</button>
            <button class="seg" :class="{ active: returnsRange === 'all' }" @click="setReturnsRange('all')">全部</button>
          </div>
          <div v-if="returnsSlice.series.length >= 2" class="chart-box asset"><canvas :ref="setReturnsCanvasEl" role="img" aria-label="资产与收益走势折线图：橙色实线为总资产、灰虚线为累计投入，两线间距为持有收益；各区间数值见下方指标行"></canvas></div>
          <div v-else class="empty-hint">曲线随每日打开看板逐渐积累（每日首次拿到行情时自动记录当日资产）</div>
          <div v-if="returnsStats" class="metrics-row">
            <span>期初 {{ maskText(formatMoney(returnsStats.a0), summaryHidden) }}</span>
            <span>期末 {{ maskText(formatMoney(returnsStats.a1), summaryHidden) }}</span>
            <span>区间变动 <b :style="!summaryHidden && returnsStats.dAsset !== 0 ? { color: profitColor(returnsStats.dAsset) } : {}">{{ maskText(formatMoney(returnsStats.dAsset), summaryHidden) }}</b><template v-if="returnsStats.changePct != null">（{{ maskText(pctText(returnsStats.changePct), summaryHidden) }}）</template></span>
            <span>最大回撤 <b v-if="returnsStats.mddPct != null">{{ maskText(pctText(-returnsStats.mddPct), summaryHidden) }}</b><template v-else>—</template>（TWR）</span>
            <span>年化(XIRR) {{ returnsStats.xirr != null ? maskText(pctText(returnsStats.xirr), summaryHidden) : '—' }}</span>
            <span class="legend-hint">按净值日绘制</span>
          </div>
        </div>

        <!-- M7 盈亏归因 + 集中度 / 组合年化（卡片形式与 M6 一致；标注数据日期沿用首页文案规则）
             v-if="analysis" 守卫：analysis 在 quoteStatus≠ok / 无持仓时为 null，
             模板裸解引用会让根组件渲染抛错 → 整页白屏（直链 #/returns 首帧、60s 轮询在途期间必现） -->
        <div v-if="analysis" class="chart-card m-block">
          <div class="chart-head"><b>{{ analysis.dataDate === analysis.today ? '当日盈亏归因' : '最新净值日盈亏归因' }}</b><span class="hint">数据日期：{{ analysis.dataDate === analysis.today ? '当日（最近净值日）' : '最新净值日 ' + (analysis.dataDate || '').slice(5) }}</span><span class="ctl-label">金额排序：</span><button class="seg" :class="{ active: !attrSortDesc }" @click="setAttrSort(false)">升序</button><button class="seg" :class="{ active: attrSortDesc }" @click="setAttrSort(true)">降序</button></div>
          <div v-if="analysis.attributionRows.length > 0" class="attr-block">
            <div v-for="row in analysis.attributionRows" :key="row.name" class="attr-row">
              <span class="attr-name">{{ row.name }}</span>
              <div class="attr-track"><div :class="['attr-fill', row.dir]" :style="{ width: row.pct + '%' }"></div></div>
              <span class="attr-val" :style="summaryHidden ? {} : { color: profitColor(row.dir === 'up' ? 1 : -1) }">{{ maskText(row.signed, summaryHidden) }}</span>
            </div>
          </div>
          <div v-else class="empty-hint">暂无盈亏归因：等待行情数据到位后自动生成</div>
          <div class="metric-tags">
            <span class="metric-tag info">持仓集中度：top1 占 {{ maskText(Math.round(analysis.concentration.top1 * 100) + '%', summaryHidden) }} · top3 占 {{ maskText(Math.round(analysis.concentration.top3 * 100) + '%', summaryHidden) }}</span>
            <span v-if="portfolioXirr != null" class="metric-tag info">组合年化(XIRR) {{ maskText(pctText(portfolioXirr), summaryHidden) }}</span>
          </div>
        </div>
        <div v-else class="chart-card m-block">
          <div class="chart-head"><b>{{ analysis.dataDate === analysis.today ? '当日盈亏归因' : '最新净值日盈亏归因' }}</b><span class="hint">数据日期：—</span></div>
          <div class="empty-hint">行情数据加载中或暂无持仓：数据到位后自动生成归因</div>
        </div>

        <!-- M4 收益日历（年/月/周/日四档；到账日口径） -->
        <div class="chart-card m-block">
          <div class="chart-head"><b>收益日历</b>
            <span class="ctl seg-control"><button class="seg" :class="{ active: calView === 'year' }" @click="setCalView('year')">年</button><button class="seg" :class="{ active: calView === 'month' }" @click="setCalView('month')">月</button><button class="seg" :class="{ active: calView === 'week' }" @click="setCalView('week')">周</button><button class="seg" :class="{ active: calView === 'day' }" @click="setCalView('day')">日</button></span>
          </div>
          <template v-if="dailyLen >= 2">
            <div class="cal-toolbar">
              <div class="cal-nav"><button class="cal-arrow" @click="calPrev">‹</button><span class="cal-ym">{{ calNavLabel }}</span><button class="cal-arrow" @click="calNext">›</button><button class="cal-today" @click="calToday">今天</button></div>
              <div class="cal-sum">本期合计 <b :style="calSum.count > 0 ? { color: profitColor(calSum.sum) } : {}">{{ signed(calSum.sum) }}</b> <span class="hint">（{{ calSum.count }} 天）</span></div>
            </div>
            <div v-if="calView === 'month'" class="cal-month">
              <div class="cal-weekdays"><span v-for="w in ['一','二','三','四','五','六','日']" :key="w">{{ w }}</span></div>
              <div class="cal-mgrid">
                <template v-for="(c, i) in calMonthCells.cells" :key="i">
                  <div v-if="!c.blank" class="m-cell" :class="[{ today: c.isToday, selected: c.isSelected, tx: c.hasTx }, c.amount > 0 ? 'pos' + c.level : (c.amount < 0 ? 'neg' + c.level : '')]" :title="c.date + (c.amount != null ? ' · ' + signed(c.amount) : '') + calMarkerLabel(c)" tabindex="0" @click="pickDay(c)" @keydown.enter="pickDay(c)">
                    <div class="d"><em>{{ c.day }}</em></div>
                    <div class="amt" :class="{ none: c.amount == null }" :style="{ color: c.amount > 0 ? 'var(--color-up)' : c.amount < 0 ? 'var(--color-down)' : '' }">{{ signed(c.amount) }}</div>
                  </div>
                  <div v-else class="m-cell blank"></div>
                </template>
              </div>
            </div>
            <div v-if="calView === 'week'" class="cal-week">
              <div v-for="c in calWeekCells.cells" :key="c.date" class="week-col" :class="{ tx: c.hasTx, today: c.isToday }" :title="c.date + calMarkerLabel(c)">
                <div :class="['bar', c.amount == null ? 'none' : (c.amount >= 0 ? 'up' : 'down')]" :style="{ height: c.amount == null ? '3px' : Math.max(4, Math.round(Math.abs(c.amount) / (calWeekCells.maxAbs || 1) * 60)) + 'px' }"></div>
                <div class="amt" :class="{ none: c.amount == null }" :style="{ color: c.amount > 0 ? 'var(--color-up)' : c.amount < 0 ? 'var(--color-down)' : '' }">{{ signed(c.amount) }}</div>
                <div class="wd">{{ c.weekday }}</div>
                <div class="dd">{{ String(c.day).padStart(2, '0') }}</div>
              </div>
            </div>
            <div v-if="calView === 'year'" class="cal-year">
              <div v-for="b in calYearBlocks.blocks" :key="b.month" class="ym-block">
                <div class="ym-title">{{ b.month }}月 <span class="ym-sum">{{ b.sum.count > 0 ? signed(b.sum.sum) : '—' }}</span></div>
                <div class="ym-grid">
                  <div v-for="(c, i) in b.cells" :key="i" class="ym-cell" :class="[c.amount > 0 ? 'pos' + c.level : (c.amount < 0 ? 'neg' + c.level : '')]" :style="[c.blank ? { visibility: 'hidden' } : {}, !c.blank && c.amount === 0 ? { background: 'var(--color-card)', border: '1px solid var(--color-border)' } : {}]" :title="c.blank ? '' : c.date + (c.amount != null ? ' · ' + signed(c.amount) : '')"></div>
                </div>
              </div>
            </div>
            <div v-if="calView === 'day'" class="cal-day">
              <div class="cal-day-head"><span class="big" :style="{ color: calSelectedProfit != null ? profitColor(calSelectedProfit) : '' }">{{ signed(calSelectedProfit) }}</span></div>
              <div v-if="calDetailRows.length > 0" class="day-rows">
                <div v-for="r in calDetailRows" :key="r.name" class="day-row">
                  <span class="nm">{{ r.name }}<span v-if="r.navDate && r.navDate !== calSelected" class="tag-lag" title="该笔收益来自该净值日，于当日到账">净值 {{ r.navDate.slice(5) }}</span></span>
                  <span class="am" :style="{ color: profitColor(r.profit) }">{{ signed(r.profit) }}</span>
                </div>
              </div>
              <div v-else class="cal-note-empty">{{ calSelectedProfit != null ? '该日期无单基金明细，仅显示组合总额' : '该日期暂无到账记录' }}</div>
            </div>
          </template>
          <div v-else class="empty-hint">收益日历随逐基金到账记录积累（服务端定时入账已自动落盘），不足 2 天时暂不绘制</div>
        </div>
        <!-- M5 持仓构成与收益贡献（只列已支持来源；总计恒在最上，分组数据仍覆盖全量 SOURCE_GROUPS） -->
        <div class="chart-card m-block">
          <div class="chart-head"><b>持仓构成与收益贡献</b></div>
          <div class="m5-scroll">
            <table class="m5-table">
              <thead><tr><th>来源</th><th>总资产</th><th>占比</th><th>持有收益</th><th>收益率</th></tr></thead>
              <tbody>
                <tr class="m5-total"><td>总计</td><td>{{ portfolio.total.value != null ? maskText(formatMoney(portfolio.total.value), summaryHidden) : '待更新' }}</td><td>100%</td><td :style="summaryHidden || portfolio.total.holdProfit == null ? {} : { color: profitColor(portfolio.total.holdProfit) }">{{ maskText(formatMoney(portfolio.total.holdProfit), summaryHidden) }}</td><td>{{ portfolio.total.returnRate != null ? maskText(pctText(portfolio.total.returnRate), summaryHidden) : '—' }}</td></tr>
                <tr v-for="g in m5Groups" :key="g.key">
                  <td>{{ g.label }}</td>
                  <td>{{ g.value != null ? maskText(formatMoney(g.value), summaryHidden) : '—' }}</td>
                  <td>{{ g.sharePct != null ? maskText(g.sharePct + '%', summaryHidden) : '—' }}</td>
                  <td :style="summaryHidden || g.holdProfit == null ? {} : { color: profitColor(g.holdProfit) }">{{ maskText(formatMoney(g.holdProfit ?? 0), summaryHidden) }}</td>
                  <td>{{ g.returnRate != null ? maskText(pctText(g.returnRate), summaryHidden) : '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- M6 收益率对比（持有收益率 = 持有收益 ÷ 投入总本金） -->
        <div class="chart-card return-card m-block">
          <div class="chart-head"><b>收益率对比</b></div>
          <div v-if="returnRows.length > 0" class="chart-box return"><canvas ref="returnCanvas" role="img" aria-label="各基金持有收益率对比条形图，按持有收益率从高到低排序"></canvas></div>
          <div v-else class="empty-hint">暂无收益率数据：录入基金并成功获取行情后，这里显示单基金对比</div>
        </div>

        <div class="blk m-block m-placeholder col-full">
          <div class="g-banner" style="border-radius:10px; margin:10px; padding:12px 16px">
            <span><b>阶段 G 预留位</b> · 黄金专属模块（克重与净值双视角、综合持仓成本 元/克、相对 SGE AU99.99 折溢价）将在此呈现</span>
            <span class="hint">PHASE G SPEC</span>
          </div>
        </div>
      </div>
    </div>
    </a-config-provider>
  `,
});

// Ant Design Vue（UMD 挂在全局 Vue 上，零构建直接注册全量组件；cssinjs 运行时出样式）
app.use(window.antd);
app.mount('#app');
