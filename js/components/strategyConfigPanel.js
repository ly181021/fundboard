/**
 * 策略参数配置弹窗。
 *
 * 组件化约定拆分：
 * 本文件：纯逻辑（字段定义/预设/表单值↔strategy_config 互转/安全垫/校验/偏离判定）+ 弹窗模板字符串，
 *   全部可 node 单测；默认值唯一来源 = js/strategy.js 的 DEFAULT_STRATEGY_CONFIG（引擎与 UI 同源）。
 * app.js：cfg* 状态与处理器接线（打开/保存走既有 persist() 乐观锁链路），模板经 ${STRATEGY_CFG_MODAL} 拼接。
 *
 * 数值口径：表单值一律为"百分数"（8 表示 8%）；strategy_config 一律为小数（0.08），互转在此集中。
 */
import { DEFAULT_STRATEGY_CONFIG } from '../strategy.js';

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** 风险类型预设（%口径；来源 costBands/radar 默认值，sector 档位沿用 DEFAULT.radar.sector） */
export const CFG_PRESETS = {
  balanced: {
    stop1: -15,
    stop2: -20,
    exitFloor: -30,
    addTop: -5,
    addStep: 2.5,
    addBottom: -10,
    radar5: DEFAULT_STRATEGY_CONFIG.radar.balanced[0] * 100,
    radar20: DEFAULT_STRATEGY_CONFIG.radar.balanced[1] * 100,
  },
  stable: {
    stop1: -3,
    stop2: -5,
    exitFloor: -10,
    addTop: null,
    addStep: null,
    addBottom: null,
    radar5: DEFAULT_STRATEGY_CONFIG.radar.stable[0] * 100,
    radar20: DEFAULT_STRATEGY_CONFIG.radar.stable[1] * 100,
  },
  sector: {
    stop1: -15,
    stop2: -20,
    exitFloor: -30,
    addTop: -5,
    addStep: 2.5,
    addBottom: -10,
    radar5: DEFAULT_STRATEGY_CONFIG.radar.sector[0] * 100,
    radar20: DEFAULT_STRATEGY_CONFIG.radar.sector[1] * 100,
  },
};

/** 非预设字段的静态默认（%口径） */
const CFG_STATIC_DEFAULTS = {
  startProfit: DEFAULT_STRATEGY_CONFIG.trailing.startProfit * 100,
  drawdown: DEFAULT_STRATEGY_CONFIG.trailing.drawdownThreshold * 100,
  tier1: DEFAULT_STRATEGY_CONFIG.xirrLadder.tiers[0].threshold * 100,
  tier2: DEFAULT_STRATEGY_CONFIG.xirrLadder.tiers[1].threshold * 100,
  minHoldDays: DEFAULT_STRATEGY_CONFIG.xirrLadder.minHoldDays,
  resetLine: DEFAULT_STRATEGY_CONFIG.xirrLadder.resetLine * 100,
  reserveCap: DEFAULT_STRATEGY_CONFIG.reserveCap * 100,
  peak60: DEFAULT_STRATEGY_CONFIG.radar.peak60 * 100,
  cooldown: DEFAULT_STRATEGY_CONFIG.actionCooldownDays,
  retain: DEFAULT_STRATEGY_CONFIG.minRetainShares,
  estFee: DEFAULT_STRATEGY_CONFIG.safetyPad.estFee * 100,
  minMargin: DEFAULT_STRATEGY_CONFIG.safetyPad.minMargin * 100,
};

/** 字段定义（sec=分组；preset=true 跟随风险类型三套预设；noDefault=无默认值不设默认） */
export const CFG_FIELD_DEFS = [
  {
    key: 'startProfit',
    sec: 'trailing',
    label: '启动点（浮盈达此值开始跟踪峰值）',
    grade: 'A',
    unit: '%',
    step: 0.5,
    min: 0,
    max: 100,
    precision: 1,
    src: '欧奈尔 3:1 非对称盈亏比纪律同源（浮盈不足 8% 不启用移动止盈）',
  },
  {
    key: 'drawdown',
    sec: 'trailing',
    label: '峰值回撤阈值（触发即赎 1/2）',
    grade: 'A',
    unit: '%',
    step: 0.5,
    min: 0.5,
    max: 50,
    precision: 1,
    src: '最大回撤止盈法（广发基金投教示例 5%/8%，常用区间 5%–10%）；5% 由安全垫不变量推导',
  },

  {
    key: 'tier1',
    sec: 'xirr',
    label: '首档年化（触发赎 1/3）',
    grade: 'A',
    unit: '%',
    step: 0.5,
    min: 1,
    max: 100,
    precision: 1,
    src: '偏股混合型基金指数 885001 基日以来年化 12.7%–14%（15% = 跑赢全体主动权益基金平均）',
  },
  {
    key: 'tier2',
    sec: 'xirr',
    label: '二档年化（触发赎剩余 1/2）',
    grade: 'A',
    unit: '%',
    step: 0.5,
    min: 2,
    max: 200,
    precision: 1,
    src: '20% ≈ 巴菲特长期年化量级',
  },
  {
    key: 'minHoldDays',
    sec: 'xirr',
    label: '最短持有期',
    grade: 'B',
    unit: '天',
    step: 10,
    min: 1,
    max: 730,
    precision: 0,
    src: '防短持有期年化爆炸（持两周赚 2% 年化可超 50% 误触首档）；是否上调 180 天由回测校准',
  },
  {
    key: 'resetLine',
    sec: 'xirr',
    label: '消耗位重置线',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: 0,
    max: 50,
    precision: 1,
    src: '年化回落到此线以下，已消耗档位重新武装',
  },

  {
    key: 'stop1',
    sec: 'stops',
    label: '首档止损（赎 1/3）',
    grade: 'A',
    unit: '%',
    step: 0.5,
    min: -99,
    max: -0.5,
    precision: 1,
    preset: true,
    src: '私募基金合同通行预警线 0.85（股票多头常见 0.80–0.85，触线减仓）',
  },
  {
    key: 'stop2',
    sec: 'stops',
    label: '二档止损（赎 1/2）',
    grade: 'A',
    unit: '%',
    step: 0.5,
    min: -99,
    max: -1,
    precision: 1,
    preset: true,
    src: '私募通行止损线/平仓线 0.80；个人分批 = 把机构"一次砍光"拆成两步',
  },
  {
    key: 'exitFloor',
    sec: 'stops',
    label: '清空兜底线',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: -99,
    max: -5,
    precision: 1,
    preset: true,
    src: '无权威单一数值；清空以双条件为主、此线仅兜底',
  },

  {
    key: 'reserveCash',
    sec: 'add',
    label: '预留资金',
    grade: 'B',
    unit: '元',
    step: 100,
    noDefault: true,
    src: '不设默认值：未设置时加仓建议不触发',
  },
  {
    key: 'reserveCap',
    sec: 'add',
    label: '预算帽（占启用时本金比例）',
    grade: 'B',
    unit: '%',
    step: 5,
    min: 5,
    max: 100,
    precision: 0,
    src: '累计加仓 ≤ 启用时本金快照 × 此比例；预算帽防"越跌越补、小亏补成重仓"',
  },
  {
    key: 'addTop',
    sec: 'add',
    label: '加仓区上沿',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: -30,
    max: -0.5,
    precision: 1,
    preset: true,
    src: '浅跌区起点（balanced −5%）',
  },
  {
    key: 'addStep',
    sec: 'add',
    label: '档位间隔',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: 0.5,
    max: 10,
    precision: 2,
    preset: true,
    src: '每档 2.5%，3 档制（−5%/−7.5%/−10%）；间隔亦要求 5 个净值日冷却',
  },
  {
    key: 'addBottom',
    sec: 'add',
    label: '加仓区下沿（观望带起点）',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: -50,
    max: -2,
    precision: 1,
    preset: true,
    src: '深于该线只警戒不建议（防震荡市"先喊补后喊割"打脸）',
  },

  {
    key: 'radar5',
    sec: 'radar',
    label: '5 个净值日累计跌幅（黄色）',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: 0.5,
    max: 50,
    precision: 1,
    preset: true,
    src: '经验参数（回测校准）',
  },
  {
    key: 'radar20',
    sec: 'radar',
    label: '20 个净值日累计跌幅（橙色）',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: 1,
    max: 90,
    precision: 1,
    preset: true,
    src: '经验参数（回测校准）',
  },
  {
    key: 'peak60',
    sec: 'radar',
    label: '60 日峰值回撤（橙色）',
    grade: 'B',
    unit: '%',
    step: 0.5,
    min: 1,
    max: 90,
    precision: 1,
    src: '经验参数（回测校准）',
  },

  {
    key: 'cooldown',
    sec: 'advanced',
    label: '动作冷却期',
    grade: 'B',
    unit: '净值日',
    step: 1,
    min: 1,
    max: 30,
    precision: 0,
    src: '同级别动作 5 个净值日内不重复提示（清空信号不受冷却限制）',
  },
  {
    key: 'retain',
    sec: 'advanced',
    label: '最低保留份额',
    grade: 'B',
    unit: '份',
    step: 1,
    min: 1,
    max: 1000,
    precision: 0,
    src: '碎份额归整：分批赎回后剩余低于此值 → 改为全额赎回',
  },
  {
    key: 'estFee',
    sec: 'advanced',
    label: '安全垫·预估赎回费',
    grade: 'B',
    unit: '%',
    step: 0.1,
    min: 0,
    max: 3,
    precision: 2,
    src: '保守赎回费估计（参与安全垫不变量）',
  },
  {
    key: 'minMargin',
    sec: 'advanced',
    label: '安全垫·最小锁利垫',
    grade: 'B',
    unit: '%',
    step: 0.1,
    min: 0,
    max: 10,
    precision: 2,
    src: '最坏触发价至少高于本金此幅度（参与安全垫不变量）',
  },
];

/** 字段默认值（风险类型感知；无默认值字段返回 null） */
export function cfgDefaultOf(key, riskClass = 'balanced') {
  const f = CFG_FIELD_DEFS.find((x) => x.key === key);
  if (!f || f.noDefault) return null;
  if (f.preset) {
    const v = CFG_PRESETS[riskClass] ? CFG_PRESETS[riskClass][key] : null;
    return v == null ? null : v;
  }
  return CFG_STATIC_DEFAULTS[key] ?? null;
}

/** 表单全部字段默认值（%口径，预留资金 null） */
export function cfgDefaults(riskClass = 'balanced') {
  const out = {};
  for (const f of CFG_FIELD_DEFS) out[f.key] = cfgDefaultOf(f.key, riskClass);
  return out;
}

/**
 * strategy_config → 表单值（%口径）。
 * config 为 null/空 = 按默认参数运行；riskClass 未配置时用 balanced。
 * 已保存的自定义档位按 riskClass 取对应 costBands/radar 段。
 */
export function cfgToValues(config, riskClass) {
  const c = config && typeof config === 'object' ? config : {};
  const rc = riskClass || c.riskClass || 'balanced';
  const band = { ...cfgDefaults(rc) };
  const saved = c.costBands?.[rc];
  if (saved) {
    for (const k of ['stop1', 'stop2', 'exitFloor', 'addTop', 'addStep', 'addBottom']) {
      if (saved[k] != null) band[k] = r6(saved[k] * 100);
    }
  }
  const radarPreset = c.radar?.[rc];
  const radarDef = CFG_PRESETS[rc] || CFG_PRESETS.balanced;
  const values = {
    ...band,
    startProfit:
      c.trailing?.startProfit != null
        ? r6(c.trailing.startProfit * 100)
        : CFG_STATIC_DEFAULTS.startProfit,
    drawdown:
      c.trailing?.drawdownThreshold != null
        ? r6(c.trailing.drawdownThreshold * 100)
        : CFG_STATIC_DEFAULTS.drawdown,
    tier1:
      c.xirrLadder?.tiers?.[0]?.threshold != null
        ? r6(c.xirrLadder.tiers[0].threshold * 100)
        : CFG_STATIC_DEFAULTS.tier1,
    tier2:
      c.xirrLadder?.tiers?.[1]?.threshold != null
        ? r6(c.xirrLadder.tiers[1].threshold * 100)
        : CFG_STATIC_DEFAULTS.tier2,
    minHoldDays: c.xirrLadder?.minHoldDays ?? CFG_STATIC_DEFAULTS.minHoldDays,
    resetLine:
      c.xirrLadder?.resetLine != null
        ? r6(c.xirrLadder.resetLine * 100)
        : CFG_STATIC_DEFAULTS.resetLine,
    reserveCash: c.reserveCash ?? null,
    reserveCap: c.reserveCap != null ? r6(c.reserveCap * 100) : CFG_STATIC_DEFAULTS.reserveCap,
    radar5: radarPreset ? r6(radarPreset[0] * 100) : radarDef.radar5,
    radar20: radarPreset ? r6(radarPreset[1] * 100) : radarDef.radar20,
    peak60: c.radar?.peak60 != null ? r6(c.radar.peak60 * 100) : CFG_STATIC_DEFAULTS.peak60,
    cooldown: c.actionCooldownDays ?? CFG_STATIC_DEFAULTS.cooldown,
    retain: c.minRetainShares ?? CFG_STATIC_DEFAULTS.retain,
    estFee: c.safetyPad?.estFee != null ? r6(c.safetyPad.estFee * 100) : CFG_STATIC_DEFAULTS.estFee,
    minMargin:
      c.safetyPad?.minMargin != null
        ? r6(c.safetyPad.minMargin * 100)
        : CFG_STATIC_DEFAULTS.minMargin,
  };
  return {
    enabled: c.enabled !== false,
    riskClass: rc,
    addEnabled: !!c.addEnabled,
    profitGate: !!c.xirrLadder?.profitGate,
    values,
  };
}

/**
 * 表单值 → strategy_config（完整嵌套对象，引擎 mergeConfig 浅合并兼容）。
 * costBands 只写当前风险类型段（其余段交引擎默认）；radar 全量写（当前段覆盖、其余段回默认）。
 * dirtyFlags = 各字段自定义标记（审计用，落 customFlags）。
 */
export function cfgToConfig(state) {
  const { enabled, riskClass, addEnabled, profitGate, values, dirtyFlags = {} } = state;
  const p = (v) => r6(v / 100); // 百分数 → 小数
  let band;
  if (riskClass === 'stable') {
    band = {
      stop1: p(values.stop1),
      stop2: p(values.stop2),
      exitFloor: p(values.exitFloor),
      noAdd: true,
    };
  } else {
    band = {
      addTop: p(values.addTop),
      addStep: p(values.addStep),
      addBottom: p(values.addBottom),
      stop1: p(values.stop1),
      stop2: p(values.stop2),
      exitFloor: p(values.exitFloor),
    };
  }
  const radarOther = { ...DEFAULT_STRATEGY_CONFIG.radar };
  delete radarOther[riskClass];
  delete radarOther.peak60;
  return {
    schemaVersion: DEFAULT_STRATEGY_CONFIG.schemaVersion,
    enabled: !!enabled,
    riskClass,
    addEnabled: !!addEnabled,
    reserveCash: values.reserveCash == null ? null : values.reserveCash,
    reserveCap: p(values.reserveCap),
    trailing: { startProfit: p(values.startProfit), drawdownThreshold: p(values.drawdown) },
    safetyPad: { estFee: p(values.estFee), minMargin: p(values.minMargin) },
    minRetainShares: values.retain,
    xirrLadder: {
      tiers: [
        {
          threshold: p(values.tier1),
          sellRatio: DEFAULT_STRATEGY_CONFIG.xirrLadder.tiers[0].sellRatio,
        },
        {
          threshold: p(values.tier2),
          sellRatio: DEFAULT_STRATEGY_CONFIG.xirrLadder.tiers[1].sellRatio,
        },
      ],
      minHoldDays: values.minHoldDays,
      resetLine: p(values.resetLine),
      profitGate: !!profitGate,
    },
    costBands: { [riskClass]: band },
    radar: {
      ...radarOther,
      [riskClass]: [p(values.radar5), p(values.radar20)],
      peak60: p(values.peak60),
    },
    actionCooldownDays: values.cooldown,
    customFlags: { ...dirtyFlags },
  };
}

/** 安全垫不变量（%口径入）：(1+startProfit)×(1−drawdown) ≥ 1+estFee+minMargin */
export function cfgSafetyPad(values) {
  const price = (1 + values.startProfit / 100) * (1 - values.drawdown / 100);
  const floor = 1 + values.estFee / 100 + values.minMargin / 100;
  return { price, floor, ok: price >= floor, marginPct: r6((price - 1) * 100) };
}

/** 表单值合法性（安全垫之外的结构约束），返回错误文案数组（空 = 可保存） */
export function cfgValidate(values, riskClass) {
  const errs = [];
  if (!(values.tier2 > values.tier1)) errs.push('二档年化必须高于首档年化');
  if (!(values.stop2 < values.stop1)) errs.push('二档止损必须深于首档止损');
  if (!(values.exitFloor < values.stop2)) errs.push('清空兜底线必须深于二档止损线');
  if (riskClass !== 'stable' && !(values.addBottom > values.stop1))
    errs.push('加仓区下沿必须浅于首档止损（中间要留观望带）');
  // 上下沿倒置会产生负档数（"第 -199/-399 档"）或空加仓区，必须在保存层拦截
  if (
    riskClass !== 'stable' &&
    values.addTop != null &&
    values.addBottom != null &&
    !(values.addTop > values.addBottom)
  )
    errs.push('加仓区上沿必须浅于下沿（addTop 高于 addBottom）');
  if (!(values.radar20 > values.radar5)) errs.push('20 日跌幅阈值必须大于 5 日跌幅阈值');
  if (
    riskClass !== 'stable' &&
    values.addEnabled &&
    values.reserveCash != null &&
    !(values.reserveCash > 0)
  )
    errs.push('预留资金必须大于 0');
  return errs;
}

/** 偏离判定（确认弹窗口径）：与默认差 ≥5 个百分点，或相对偏差 >50%；无默认值字段 = 填了即偏离 */
export function cfgDeviates(value, def) {
  if (def == null) return value != null;
  if (value == null) return false;
  const dev = Math.abs(value - def);
  return dev >= 5 || dev / Math.abs(def) > 0.5;
}

/** 风险类型选项（a-segmented） */
export const CFG_RISK_OPTIONS = [
  { label: '稳健 stable', value: 'stable' },
  { label: '均衡 balanced', value: 'balanced' },
  { label: '行业 sector', value: 'sector' },
];

/**
 * 弹窗模板（app.js 根模板经 ${STRATEGY_CFG_MODAL} 拼接；全部状态/处理器 cfg* 前缀，见 app.js 接线）。
 * 注意：零构建 in-DOM 教训——自定义组件标签一律显式闭合，禁止自闭合写法。
 */
export const STRATEGY_CFG_MODAL = `
      <a-modal :open="!!cfgModal" :width="780" :mask-closable="false" @cancel="cfgCancel">
        <template #title><span>{{ cfgModal ? cfgModal.name : '' }}（{{ cfgModal ? cfgModal.code : '' }}）· 策略配置</span></template>
        <template #footer>
          <div class="cfg-footer">
            <div class="cfg-footer-left">
              <template v-if="cfgCustomizedCount">
                <span class="cfg-cnt">{{ cfgCustomizedCount }} 项自定义</span>
                <a-tooltip :title="cfgCustomizedList.join('、')"><span class="cfg-detail">明细</span></a-tooltip>
              </template>
              <span v-else>全部为默认参数</span>
            </div>
            <div class="cfg-footer-right">
              <a-button size="small" @click="cfgResetAll">恢复默认</a-button>
              <a-button size="small" @click="cfgBacktestHint">回测此配置</a-button>
              <a-button size="small" @click="cfgCancel">取消</a-button>
              <a-button size="small" type="primary" :disabled="!cfgCanSave" @click="cfgSave">{{ cfgSafety.ok ? '保存' : '禁止保存（安全垫）' }}</a-button>
            </div>
          </div>
        </template>

        <a-alert v-if="cfgModal && cfgModal.unconfigured" type="info" show-icon class="cfg-block"
          message="该基金尚未配置策略"
          description="当前按【均衡 balanced】默认参数评估（止盈止损默认开启、加仓默认关闭）。改动并保存后生效；保存动作会记入之后的触发快照（可审计）。"></a-alert>

        <a-alert v-if="cfgSavedOk" type="success" show-icon class="cfg-block"
          :message="'已保存——' + (cfgCustomizedCount ? '含 ' + cfgCustomizedCount + ' 项自定义' : '全默认参数') + '。之后每次触发都会在快照里记录本配置。'"></a-alert>

        <div class="cfg-top">
          <span class="grp"><span class="lb">策略引擎</span>
            <a-switch v-model:checked="cfg.enabled" size="small"></a-switch>
            <span class="cfg-enabled-hint">{{ cfg.enabled ? '评估中' : '已停用（该基金不参与止盈止损/雷达评估）' }}</span>
          </span>
          <span class="grp">
            <span class="lb">风险类型</span>
            <a-segmented v-model:value="cfg.riskClass" size="small" :options="CFG_RISK_OPTIONS" @change="cfgOnRiskClassChange"></a-segmented>
          </span>
          <span class="cfg-note">三套预设联动止损线与雷达阈值；切换后未自定义的字段自动跟随新预设，已自定义字段保留。</span>
        </div>

        <a-collapse v-model:active-key="cfgOpenSections" class="cfg-collapse">
          <a-collapse-panel key="trailing" header="移动止盈（峰值回撤）">
            <div class="frow" v-for="f in cfgFieldsOf('trailing')" :key="f.key">
              <div class="fmain">
                <span class="flabel">{{ f.label }}</span>
                <span :class="['grade', f.grade]" :title="f.grade === 'A' ? 'A 级 = 可查证的行业准则/公开数据' : 'B 级 = 经验参数，由回测校准定稿'">{{ f.grade }}</span>
                <span v-if="cfgIsCustom(f.key)" class="custom-chip">自定义</span>
                <span class="fill"></span>
                <a-input-number v-model:value="cfg.values[f.key]" :step="f.step" :min="f.min" :max="f.max"
                  :precision="f.precision" size="small" class="cfg-num" :addon-after="f.unit" :disabled="!cfg.enabled"></a-input-number>
              </div>
              <div class="fhint">默认 <b>{{ cfgDef(f.key) }}{{ f.unit }}</b> · {{ f.src }}</div>
            </div>
            <div :class="['pad-line', cfgSafety.ok ? 'ok' : 'bad']">
              <template v-if="cfgSafety.ok">✓ 安全垫不变量满足：最坏触发价 (1+{{ cfg.values.startProfit }}%)×(1−{{ cfg.values.drawdown }}%) = {{ cfgSafety.price.toFixed(4) }} ≥ {{ cfgSafety.floor.toFixed(4) }}（赎回费 {{ cfg.values.estFee }}% + 最小垫 {{ cfg.values.minMargin }}%）——最坏仍锁利 {{ cfgSafety.marginPct }}%</template>
              <template v-else>✗ 违反安全垫不变量：最坏触发价 {{ cfgSafety.price.toFixed(4) }} &lt; {{ cfgSafety.floor.toFixed(4) }}——「名为止盈实为保本亏损」。请下调回撤阈值（当前组合 {{ cfg.values.startProfit }}% / {{ cfg.values.drawdown }}% 不允许保存）</template>
            </div>
            <div class="sec-note">无窗口参数：峰值自启动日起持续跟踪；加仓摊薄跌破启动点会休眠并重置峰值（重新爬上启动点再起算）。</div>
          </a-collapse-panel>

          <a-collapse-panel key="xirr" header="目标年化分批止盈（XIRR 阶梯）">
            <div class="frow" v-for="f in cfgFieldsOf('xirr')" :key="f.key">
              <div class="fmain">
                <span class="flabel">{{ f.label }}</span>
                <span :class="['grade', f.grade]" :title="f.grade === 'A' ? 'A 级 = 可查证的行业准则/公开数据' : 'B 级 = 经验参数，由回测校准定稿'">{{ f.grade }}</span>
                <span v-if="cfgIsCustom(f.key)" class="custom-chip">自定义</span>
                <span class="fill"></span>
                <a-input-number v-model:value="cfg.values[f.key]" :step="f.step" :min="f.min" :max="f.max"
                  :precision="f.precision" size="small" class="cfg-num" :addon-after="f.unit" :disabled="!cfg.enabled"></a-input-number>
              </div>
              <div class="fhint">默认 <b>{{ cfgDef(f.key) }}{{ f.unit }}</b> · {{ f.src }}</div>
            </div>
            <div class="frow">
              <div class="fmain">
                <span class="flabel">账面盈利闸门（profitGate）</span>
                <span class="grade B" title="经验参数，回测校准">B</span>
                <span class="fill"></span>
                <a-switch v-model:checked="cfg.profitGate" size="small" :disabled="!cfg.enabled"></a-switch>
              </div>
              <div class="fhint">默认 <b>关闭</b> · 开启后账面亏损时不触发 XIRR 止盈（防"先卖后买"极端现金流的别扭止盈）</div>
            </div>
            <div class="sec-note">跳档语义：年化直接 ≥ 二档时只执行最高档（剩余 1/2）；档位触发即消耗，回落到重置线以下重新武装。</div>
          </a-collapse-panel>

          <a-collapse-panel key="stops" header="止损与清空（成本分档）">
            <div class="frow" v-for="f in cfgFieldsOf('stops')" :key="f.key">
              <div class="fmain">
                <span class="flabel">{{ f.label }}</span>
                <span :class="['grade', f.grade]" :title="f.grade === 'A' ? 'A 级 = 可查证的行业准则/公开数据' : 'B 级 = 经验参数，由回测校准定稿'">{{ f.grade }}</span>
                <span v-if="cfgIsCustom(f.key)" class="custom-chip">自定义</span>
                <span class="fill"></span>
                <a-input-number v-model:value="cfg.values[f.key]" :step="f.step" :min="f.min" :max="f.max"
                  :precision="f.precision" size="small" class="cfg-num" :addon-after="f.unit" :disabled="!cfg.enabled"></a-input-number>
              </div>
              <div class="fhint">默认 <b>{{ cfgDef(f.key) }}{{ f.unit }}</b> · {{ f.src }}</div>
            </div>
            <div class="sec-note">亏损率 = (市值 + 累计现金分红 − 加权平均成本) / 成本；破位缓冲 2% 为固定口径（不可配）；清空双条件：止损后收复再破位（趋势终结）或触及兜底线。</div>
          </a-collapse-panel>

          <a-collapse-panel key="add" header="加仓评估区（默认关闭 · 唯一让你掏钱的建议）">
            <div class="frow">
              <div class="fmain">
                <span class="flabel">启用加仓建议</span>
                <span class="grade B" title="经验参数，回测校准">B</span>
                <span class="fill"></span>
                <a-switch v-model:checked="cfg.addEnabled" size="small" :disabled="!cfg.enabled || cfgIsStable"></a-switch>
              </div>
              <div class="fhint">默认 <b>关闭</b> · 开启需自行承担左侧加仓风险；{{ cfgIsStable ? '稳健类（stable）无加仓区，不可开启' : '开启后浅跌区按档位给金额建议' }}</div>
            </div>
            <div class="frow" v-for="f in cfgFieldsOf('add')" :key="f.key">
              <div class="fmain">
                <span class="flabel">{{ f.label }}</span>
                <span :class="['grade', f.grade]" :title="f.grade === 'A' ? 'A 级 = 可查证的行业准则/公开数据' : 'B 级 = 经验参数，由回测校准定稿'">{{ f.grade }}</span>
                <span v-if="cfgIsCustom(f.key)" class="custom-chip">自定义</span>
                <span class="fill"></span>
                <a-input-number v-model:value="cfg.values[f.key]" :step="f.step" :min="f.min == null ? 0 : f.min"
                  :precision="f.precision" size="small" class="cfg-num" :addon-after="f.unit"
                  :disabled="!cfg.enabled || !cfg.addEnabled || cfgIsStable"></a-input-number>
              </div>
              <div class="fhint">默认 <b>{{ cfgDef(f.key) == null ? '未设置' : cfgDef(f.key) + (f.unit || '') }}</b> · {{ f.src }}</div>
            </div>
            <div v-if="cfg.addEnabled && !cfgIsStable && cfg.values.reserveCash == null" class="sec-note warn">
              ⚠ 未设置预留资金：加仓建议不会触发。请先填写「预留资金」（不设默认值，用户对自己的预算负责）。
            </div>
            <div class="sec-note">三重护栏：默认关闭 · 预算帽（累计加仓 ≤ 启用时本金 × 预算比例，到顶只报"已达上限"）· 金额口径（每次 = 剩余额 ÷ 剩余档数，如 3000 元预算在 −6% 档建议 1000 元）。每次建议附效果预演与风险预演。</div>
          </a-collapse-panel>

          <a-collapse-panel key="radar" header="连跌雷达（只提示不动作）">
            <div class="frow" v-for="f in cfgFieldsOf('radar')" :key="f.key">
              <div class="fmain">
                <span class="flabel">{{ f.label }}</span>
                <span :class="['grade', f.grade]" :title="f.grade === 'A' ? 'A 级 = 可查证的行业准则/公开数据' : 'B 级 = 经验参数，由回测校准定稿'">{{ f.grade }}</span>
                <span v-if="cfgIsCustom(f.key)" class="custom-chip">自定义</span>
                <span class="fill"></span>
                <a-input-number v-model:value="cfg.values[f.key]" :step="f.step" :min="f.min" :max="f.max"
                  :precision="f.precision" size="small" class="cfg-num" :addon-after="f.unit" :disabled="!cfg.enabled"></a-input-number>
              </div>
              <div class="fhint">默认 <b>{{ cfgDef(f.key) }}{{ f.unit }}</b> · {{ f.src }}</div>
            </div>
            <div class="sec-note">雷达只做徽章角标（如"连跌 4 日 −6.2%"），永不产生买卖建议、不参与七态仲裁；同级别 5 个净值日冷却，黄→橙升级不受冷却限制。</div>
          </a-collapse-panel>

          <a-collapse-panel key="advanced" header="高级">
            <div class="frow" v-for="f in cfgFieldsOf('advanced')" :key="f.key">
              <div class="fmain">
                <span class="flabel">{{ f.label }}</span>
                <span :class="['grade', f.grade]" :title="f.grade === 'A' ? 'A 级 = 可查证的行业准则/公开数据' : 'B 级 = 经验参数，由回测校准定稿'">{{ f.grade }}</span>
                <span v-if="cfgIsCustom(f.key)" class="custom-chip">自定义</span>
                <span class="fill"></span>
                <a-input-number v-model:value="cfg.values[f.key]" :step="f.step" :min="f.min" :max="f.max"
                  :precision="f.precision" size="small" class="cfg-num" :addon-after="f.unit" :disabled="!cfg.enabled"></a-input-number>
              </div>
              <div class="fhint">默认 <b>{{ cfgDef(f.key) }}{{ f.unit }}</b> · {{ f.src }}</div>
            </div>
            <div class="sec-note">冷却按基金自身净值日计数（跨周末/长假不空耗）；最低保留份额用于碎份额归整（分批赎回后剩余 &lt; 该值 → 改为全额赎回建议）。</div>
          </a-collapse-panel>
        </a-collapse>

        <div v-if="cfgErrors.length" class="cfg-err-list">
          <div v-for="e in cfgErrors" :key="e" class="cfg-err">✗ {{ e }}</div>
        </div>
      </a-modal>

      <a-modal :open="cfgConfirm.open" :width="460" :mask-closable="false">
        <template #title>偏离提醒</template>
        <template #footer>
          <a-button @click="cfgConfirmRevert">改回默认（{{ cfgConfirm.field ? cfgDef(cfgConfirm.field.key) : '' }}）</a-button>
          <a-button type="primary" danger @click="cfgConfirmKeep">坚持使用</a-button>
        </template>
        <p class="cfg-confirm-p">
          「{{ cfgConfirm.field ? cfgConfirm.field.label : '' }}」已从默认
          <b>{{ cfgConfirm.field ? cfgDef(cfgConfirm.field.key) : '' }}{{ cfgConfirm.field ? cfgConfirm.field.unit : '' }}</b>
          改为 <b class="cfg-dev-val">{{ cfgConfirm.field ? cfg.values[cfgConfirm.field.key] : '' }}{{ cfgConfirm.field ? cfgConfirm.field.unit : '' }}</b>。
        </p>
        <p class="cfg-confirm-src">默认值出处：{{ cfgConfirm.field ? cfgConfirm.field.src : '' }}。每字段只提醒一次，你的选择会被尊重并记入触发快照。</p>
      </a-modal>`;
