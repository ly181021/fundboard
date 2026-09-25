import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CFG_FIELD_DEFS,
  CFG_PRESETS,
  CFG_RISK_OPTIONS,
  STRATEGY_CFG_MODAL,
  cfgDefaultOf,
  cfgDefaults,
  cfgToValues,
  cfgToConfig,
  cfgSafetyPad,
  cfgValidate,
  cfgDeviates,
} from '../../js/components/strategyConfigPanel.js';
import { DEFAULT_STRATEGY_CONFIG } from '../../js/strategy.js';

test('cfgToValues(null)：按 balanced 默认参数出表单值（%口径）', () => {
  const st = cfgToValues(null);
  assert.equal(st.enabled, true);
  assert.equal(st.riskClass, 'balanced');
  assert.equal(st.addEnabled, false);
  assert.equal(st.profitGate, false);
  assert.equal(st.values.startProfit, 8);
  assert.equal(st.values.drawdown, 5);
  assert.equal(st.values.tier1, 15);
  assert.equal(st.values.tier2, 20);
  assert.equal(st.values.stop1, -15);
  assert.equal(st.values.stop2, -20);
  assert.equal(st.values.exitFloor, -30);
  assert.equal(st.values.radar5, 5);
  assert.equal(st.values.reserveCash, null);
  assert.equal(st.values.reserveCap, 50);
  assert.equal(st.values.minHoldDays, 90);
});

test('roundtrip：默认值 values → config → values 恒等（小数↔百分数互转无损）', () => {
  const st = cfgToValues(null);
  const config = cfgToConfig({ ...st, values: st.values, dirtyFlags: {} });
  const back = cfgToValues(config);
  assert.deepEqual(back.values, st.values);
  assert.equal(back.enabled, true);
  assert.equal(back.riskClass, 'balanced');
});

test('cfgToConfig 产物与引擎 DEFAULT 合并后生效值 = 表单意图（自定义 6% 回撤 / sector 雷达）', () => {
  const st = cfgToValues(null);
  st.riskClass = 'sector';
  st.values.drawdown = 6;
  st.values.stop1 = -18;
  st.values.radar5 = 9;
  st.values.reserveCash = 3000;
  const config = cfgToConfig({
    ...st,
    values: st.values,
    dirtyFlags: { drawdown: true, stop1: true },
  });
  // 引擎 mergeConfig 同式浅合并
  const eff = {
    ...DEFAULT_STRATEGY_CONFIG,
    ...config,
    trailing: { ...DEFAULT_STRATEGY_CONFIG.trailing, ...config.trailing },
    safetyPad: { ...DEFAULT_STRATEGY_CONFIG.safetyPad, ...config.safetyPad },
    xirrLadder: { ...DEFAULT_STRATEGY_CONFIG.xirrLadder, ...config.xirrLadder },
    costBands: { ...DEFAULT_STRATEGY_CONFIG.costBands, ...config.costBands },
    radar: { ...DEFAULT_STRATEGY_CONFIG.radar, ...config.radar },
  };
  assert.equal(eff.trailing.drawdownThreshold, 0.06);
  assert.equal(eff.costBands.sector.stop1, -0.18);
  assert.equal(eff.radar.sector[0], 0.09);
  assert.equal(eff.radar.balanced[0], 0.05); // 未改的段保持默认（radar 全量写但不串段）
  assert.equal(eff.reserveCash, 3000);
  assert.deepEqual(config.customFlags, { drawdown: true, stop1: true });
  // 自定义组合须能过引擎安全垫校验（6% 回撤：最坏触发价 1.08×0.94 = 1.0152 ≥ 1.015）
  const trigger = (1 + eff.trailing.startProfit) * (1 - eff.trailing.drawdownThreshold);
  assert.ok(trigger >= 1 + eff.safetyPad.estFee + eff.safetyPad.minMargin);
});

test('stable：costBands 只有止损三线 + noAdd，无加仓字段；radar.stable 覆盖', () => {
  const st = cfgToValues(null, 'stable');
  const config = cfgToConfig({ ...st, values: st.values, dirtyFlags: {} });
  const band = config.costBands.stable;
  assert.equal(band.stop1, -0.03);
  assert.equal(band.stop2, -0.05);
  assert.equal(band.exitFloor, -0.1);
  assert.equal(band.noAdd, true);
  assert.equal('addTop' in band, false);
  assert.deepEqual(config.radar.stable, [0.02, 0.04]);
});

test('cfgSafetyPad：默认组合通过（锁利 2.6%），8%/8% 拦截', () => {
  const okPad = cfgSafetyPad(cfgDefaults('balanced'));
  assert.equal(okPad.ok, true);
  assert.ok(Math.abs(okPad.marginPct - 2.6) < 1e-9);
  const bad = cfgSafetyPad({ ...cfgDefaults('balanced'), drawdown: 8 });
  assert.equal(bad.ok, false);
  assert.ok(Math.abs(bad.price - 0.9936) < 1e-9);
});

test('cfgValidate：结构约束（档序/区间/观望带/预算）', () => {
  assert.deepEqual(cfgValidate(cfgDefaults('balanced'), 'balanced'), []);
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), tier2: 15, tier1: 20 }, 'balanced').length > 0,
  );
  assert.ok(cfgValidate({ ...cfgDefaults('balanced'), stop2: -10 }, 'balanced').length > 0); // stop2(-10) 浅于 stop1(-15)
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), addBottom: -15, stop1: -15 }, 'balanced').length > 0,
  ); // 无观望带
  assert.ok(cfgValidate({ ...cfgDefaults('stable'), stop1: -4 }, 'stable').length === 0); // stable 无加仓区不校验档位（stop1 -4 仍深于 stop2 -5 之上）
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), addEnabled: true, reserveCash: 0 }, 'balanced')
      .length > 0,
  );
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), addEnabled: true, reserveCash: null }, 'balanced')
      .length === 0,
  ); // 未设置=警告不拦截
});

test('cfgValidate：上下沿/雷达阈值/兜底线顺序（倒置会产生负档数或空加仓区）', () => {
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), addTop: -12, addBottom: -10 }, 'balanced').some((e) =>
      e.includes('上沿'),
    ),
  );
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), addTop: -10, addBottom: -10 }, 'balanced').some((e) =>
      e.includes('上沿'),
    ),
  );
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), radar20: 5, radar5: 10 }, 'balanced').some((e) =>
      e.includes('20 日'),
    ),
  );
  assert.ok(
    cfgValidate({ ...cfgDefaults('balanced'), exitFloor: -5 }, 'balanced').some((e) =>
      e.includes('兜底'),
    ),
  );
  assert.deepEqual(cfgValidate(cfgDefaults('sector'), 'sector'), []); // sector 默认组合仍合法
});

test('cfgDeviates：≥5 个百分点或相对偏差 >50%（严格），无默认字段填了即偏离', () => {
  assert.equal(cfgDeviates(13, 8), true); // 差 5pp
  assert.equal(cfgDeviates(12.5, 8), true); // 4.5pp，相对 56% > 50%
  assert.equal(cfgDeviates(12, 8), false); // 4pp，相对恰 50%（严格大于不算）
  assert.equal(cfgDeviates(10, 8), false); // 2pp / 25%
  assert.equal(cfgDeviates(-18, -15), false); // 3pp / 20%：轻微偏离不打扰
});

test('cfgDeviates 修正：-18 vs -15 为 3pp/20% → 不算显著偏离', () => {
  assert.equal(cfgDeviates(-18, -15), false);
  assert.equal(cfgDeviates(-23, -15), true); // 8pp
  assert.equal(cfgDeviates(3000, null), true); // 预留资金：填了即自定义
  assert.equal(cfgDeviates(null, null), false);
});

test('cfgDefaultOf：预设字段风险类型感知、stable 无加仓默认（null）、非预设字段静态', () => {
  assert.equal(cfgDefaultOf('stop1', 'balanced'), -15);
  assert.equal(cfgDefaultOf('stop1', 'stable'), -3);
  assert.equal(cfgDefaultOf('addTop', 'stable'), null);
  assert.equal(cfgDefaultOf('startProfit', 'stable'), 8); // 静态默认不随风险类型
  assert.equal(cfgDefaultOf('reserveCash', 'balanced'), null); // 不设默认
});

test('字段定义完整性：每组字段齐全、preset 字段在 PRESETS 中有值（stable 档位除外）', () => {
  const secs = new Set(CFG_FIELD_DEFS.map((f) => f.sec));
  assert.deepEqual(
    [...secs].sort(),
    ['add', 'advanced', 'radar', 'stops', 'trailing', 'xirr'].sort(),
  );
  for (const f of CFG_FIELD_DEFS) {
    if (!f.preset) continue;
    for (const rc of ['balanced', 'stable', 'sector']) {
      if (rc === 'stable' && ['addTop', 'addStep', 'addBottom'].includes(f.key)) {
        assert.equal(CFG_PRESETS.stable[f.key], null);
        continue;
      }
      assert.equal(typeof CFG_PRESETS[rc][f.key], 'number', `${f.key}@${rc}`);
    }
  }
});

test('STRATEGY_CFG_MODAL 模板：六面板/全字段绑定/处理器齐全，无反引号与 ${}（可安全拼入 app.js 模板）', () => {
  for (const sec of ['trailing', 'xirr', 'stops', 'add', 'radar', 'advanced']) {
    assert.ok(STRATEGY_CFG_MODAL.includes(`key="${sec}"`), sec);
  }
  for (const f of CFG_FIELD_DEFS) {
    assert.ok(STRATEGY_CFG_MODAL.includes(`cfg.values[f.key]`), '字段经 v-for 统一绑定');
    break;
  }
  for (const name of [
    'cfgSave',
    'cfgResetAll',
    'cfgCancel',
    'cfgConfirmKeep',
    'cfgConfirmRevert',
    'cfgBacktestHint',
    'cfgOnRiskClassChange',
    'cfgDef',
    'cfgFieldsOf',
    'cfgIsCustom',
    'cfgSafety',
    'cfgErrors',
    'cfgCanSave',
    'cfgCustomizedCount',
    'cfgCustomizedList',
    'CFG_RISK_OPTIONS',
  ]) {
    assert.ok(STRATEGY_CFG_MODAL.includes(name), name);
  }
  assert.ok(!STRATEGY_CFG_MODAL.includes('`'));
  assert.ok(!STRATEGY_CFG_MODAL.includes('${'));
  // 零构建教训：模板串内自定义组件不允许自闭合（统一显式闭合）
  assert.ok(!/<a-[a-z-]+[^>]*\/>/.test(STRATEGY_CFG_MODAL));
});

test('CFG_RISK_OPTIONS 与引擎风险类型对齐', () => {
  assert.deepEqual(
    CFG_RISK_OPTIONS.map((o) => o.value),
    ['stable', 'balanced', 'sector'],
  );
});
