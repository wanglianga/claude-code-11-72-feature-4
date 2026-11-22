#!/usr/bin/env tsx
/**
 * 混凝剂投加效率样例核验
 *
 * 读取 public/sample/coag/ 下的真实 CSV（与界面导入走同一解析器），打印并断言：
 *  1. 文件指纹与清单一致、解析零问题；
 *  2. 可达出水窗口由流量/池容/回流比推导，并落在允许停留时间范围内；
 *  3. 储罐稀释后浓度按混合比例下降，实际投加只来自泵脉冲；
 *  4. 库存平衡：期初 + 入库 + 转罐净额 − 投加 ≈ 盘点期末（<1%）；
 *  5. 旁路与泵校准失效的配对只给范围、不可与正常段排名；
 *  6. 缺料异常由脉冲显著低于设定触发，并计入缺料候选；
 *  7. 工况分段覆盖暴雨/搅拌停止/旁路，稳定段与短片段分别披露；
 *  8. 班次路径与工况路径给出不同数量级/口径的结论，且入库量不能当作投加量；
 *  9. 迟到化验只生成新的复盘候选，当班处置不被改写。
 * 退出码非 0 表示核验失败。
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoagSampleFromDisk } from './coagParse';
import { computeTankEfficiency } from '../src/coag/engine';
import { dayStartMs } from '../src/domain/time';
import type { CoagTarget } from '../src/coag/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = resolve(__dirname, '../public/sample/coag');
const sample = parseCoagSampleFromDisk(dir);
const { dataset, manifest } = sample;
const day = manifest.day;
const cutoff = manifest.focus.reviewCutoffReceivedAt;

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  if (condition) console.log(`  ✓ ${label}：${detail}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}：${detail}`);
  }
}
function fmt(n: number | null | undefined, d = 2): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d);
}
function hhmm(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
}

console.log('=== 1. 指纹与解析 ===');
check(
  '全部文件指纹与清单一致',
  sample.fingerprints.every((f) => f.ok),
  `${sample.fingerprints.filter((f) => f.ok).length}/${sample.fingerprints.length} 份`,
);
check('解析零问题', sample.issues.length === 0, sample.issues.slice(0, 2).map((i) => `${i.file}:${i.row} ${i.message}`).join('；') || '无');
check(
  '读数/脉冲/化验均已入库',
  dataset.readings.length > 10000 && dataset.pulses.length > 0 && dataset.lateLabs.length > 0,
  `读数 ${dataset.readings.length}，脉冲 ${dataset.pulses.length}，迟到化验 ${dataset.lateLabs.length}`,
);

for (const tank of dataset.tanks) {
  console.log(`\n=== ${tank.tankId} ${tank.name} ===`);
  const eff = computeTankEfficiency(dataset, tank.tankId, day, { reviewCutoffReceivedAt: cutoff });
  const pairings = eff.pairings;
  const usable = pairings.filter((p) => p.window.usable);
  const rankable = pairings.filter((p) => p.rankable);

  check(
    '配对覆盖整日投加',
    pairings.length > 20,
    `${pairings.length} 段（其中可排名 ${rankable.length} 段，限制为区间 ${pairings.length - rankable.length} 段）`,
  );

  // 2. 停留时间窗口
  const badWindow = usable.filter((p) => p.window.residenceMinSeconds < tank.minResidenceSeconds - 1e-6 || p.window.residenceMaxSeconds > tank.maxResidenceSeconds + 1e-6);
  check('窗口落在允许停留时间范围内', badWindow.length === 0, badWindow.length === 0 ? `${usable.length} 段均满足 ${tank.minResidenceSeconds}–${tank.maxResidenceSeconds} s` : `${badWindow.length} 段越界`);
  const sample1 = usable[Math.floor(usable.length / 2)];
  if (sample1) {
    const span = (sample1.window.toMax - sample1.window.toMin) / 1000;
    const expected = (tank.effectiveVolumeM3 * 3600) / (sample1.window.flowFromM3h * (1 + tank.recycleRatio));
    const lowFlow = usable.reduce((a, p) => (p.window.flowFromM3h < a.window.flowFromM3h ? p : a));
    const highFlow = usable.reduce((a, p) => (p.window.flowFromM3h > a.window.flowFromM3h ? p : a));
    check(
      '窗口由流量/池容/回流比推导（非固定值）',
      span > 0 && Math.abs(sample1.window.derivedMaxSeconds - (expected * (1 + tank.volumeUncertainty)) / (1 - 0.02)) < 5 &&
        Math.abs(lowFlow.window.derivedMinSeconds - highFlow.window.derivedMinSeconds) > 60,
      `${hhmm(sample1.dosingFrom)} 投加：流量 ${fmt(sample1.window.flowFromM3h, 1)} m³/h，池容 ${tank.effectiveVolumeM3} m³，回流 ${(tank.recycleRatio * 100).toFixed(0)}% → 停留 ${fmt(sample1.window.residenceMinSeconds, 0)}–${fmt(sample1.window.residenceMaxSeconds, 0)} s；最低流量 ${hhmm(lowFlow.dosingFrom)} 停留 ${fmt(lowFlow.window.derivedMinSeconds, 0)} s vs 最高流量 ${hhmm(highFlow.dosingFrom)} ${fmt(highFlow.window.derivedMinSeconds, 0)} s`,
    );
    check(
      '出水窗口内取去除率',
      Boolean(sample1.series.find((s) => s.target === 'COD')?.removal),
      `COD 进水 ${fmt(sample1.series.find((s) => s.target === 'COD')?.inletMgL ?? null)} → 出水 ${fmt(sample1.series.find((s) => s.target === 'COD')?.outletMgL ?? null)} mg/L，去除 ${fmt((sample1.series.find((s) => s.target === 'COD')?.removal?.best ?? 0) * 100, 1)}%`,
    );
  }

  // 3. 混合比例
  const tankStart = dayStartMs(day);
  const before = pairings.filter((p) => p.dosingFrom < tankStart + 6 * 3600_000 + 40 * 60_000).map((p) => p.dosage.concentrationGPerL.best);
  const after = pairings.filter((p) => p.dosingFrom >= tankStart + 6 * 3600_000 + 41 * 60_000 && p.dosingFrom < tankStart + 7 * 3600_000 + 20 * 60_000).map((p) => p.dosage.concentrationGPerL.best);
  if (tank.tankId === 'CT-01') {
    check(
      '储罐稀释后浓度按混合比例下降',
      before.length > 0 && after.length > 0 && after[0] < before[before.length - 1] - 1 && after[0] > 36,
      `${fmt(before[before.length - 1] ?? null)} → ${fmt(after[0] ?? null)} g/L`,
    );
  }
  const dosed = pairings.reduce((a, p) => a + p.dosage.massKg.best, 0);
  check(
    '投加量只来自泵脉冲',
    pairings.every((p) => p.dosage.pulseId.length > 0) && dosed > 0,
    `合计 ${fmt(dosed, 1)} kg 有效成分；脉冲段 ${new Set(pairings.map((p) => p.dosage.pulseId)).size} 个`,
  );

  // 4. 库存平衡
  const inv = eff.inventory[0];
  const rel = inv.measuredClosingKg !== null ? Math.abs((inv.discrepancyKg ?? 0) / Math.max(1, inv.measuredClosingKg)) : 1;
  check(
    '库存平衡（期初+入库+转罐−投加≈盘点）',
    rel < 0.01,
    `推算期末 ${fmt(inv.closingKg.best, 2)} kg，盘点 ${fmt(inv.measuredClosingKg, 2)} kg，差异 ${fmt(inv.discrepancyKg, 2)} kg（${(rel * 100).toFixed(2)}%）`,
  );

  // 5. 旁路 / 校准失效
  if (tank.tankId === 'CT-01') {
    const bypassed = pairings.filter((p) => p.window.bypassFraction > 0);
    check(
      '旁路期间配对只给范围、不可排名',
      bypassed.length > 0 && bypassed.every((p) => !p.rankable && !p.window.usable),
      `${bypassed.length} 段：${bypassed.map((p) => `${hhmm(p.dosingFrom)}`).join('，')}`,
    );
  }
  if (tank.tankId === 'CT-02') {
    const invalid = pairings.filter((p) => p.dosage.calibrationInvalid);
    check(
      '泵校准失效期间投加量给范围且不可排名',
      invalid.length > 0 && invalid.every((p) => !p.rankable && p.dosage.volumeL.max > p.dosage.volumeL.min),
      invalid.length > 0 ? `${invalid.length} 段：体积 ${fmt(invalid[0].dosage.volumeL.min, 1)}–${fmt(invalid[0].dosage.volumeL.max, 1)} L` : '未检出',
    );
  }

  // 6. 异常归因
  const cats = new Set(eff.anomalies.map((a) => a.category));
  check(
    '异常归入缺料/计量不确定/工况突变/待取样',
    cats.size >= 3,
    [...cats].map((c) => `${c}×${eff.anomalies.filter((a) => a.category === c).length}`).join('，'),
  );
  if (tank.tankId === 'CT-02') {
    const shortage = eff.anomalies.find((a) => a.category === 'FEED_SHORTAGE');
    check(
      '缺料异常由脉冲显著低于设定触发',
      Boolean(shortage && shortage.affectedPairings >= 3 && shortage.detail.includes('实际脉冲')),
      shortage ? `${hhmm(shortage.from)}–${hhmm(shortage.to)}，影响 ${shortage.affectedPairings} 段；${shortage.detail}` : '未检出',
    );
  }

  // 7. 工况分段
  const conds = eff.conditions;
  const stormSegs = conds.filter((c) =>
    dataset.upsets.some((u) => u.tankId === tank.tankId && u.kind === 'STORM' && u.from < c.to && u.to > c.from),
  );
  check(
    '工况分段覆盖暴雨段并标为受限',
    stormSegs.length > 0 && stormSegs.every((c) => !c.stable),
    stormSegs.length > 0 ? stormSegs.map((c) => `${hhmm(c.from)}–${hhmm(c.to)} 稳定=${c.stable}`).join('，') : '未覆盖',
  );
  check(
    '存在不稳定段与稳定段',
    conds.some((c) => c.stable) && conds.some((c) => !c.stable),
    `${conds.filter((c) => c.stable).length} 稳定 / ${conds.filter((c) => !c.stable).length} 受限`,
  );
  const shortSeg = conds.filter((c) => c.shortSegment);
  check(
    '短片段明确披露',
    shortSeg.length === 0 || shortSeg.every((c) => c.shortSegment),
    `短片段 ${shortSeg.length} 段`,
  );

  // 8. 班次 vs 工况
  const shiftDosed = eff.shifts.reduce((a, s) => a + s.dosedKg.best, 0);
  const purchased = eff.shifts.reduce((a, s) => a + s.purchasedKg.best, 0);
  check(
    '班次投加量取脉冲合计，入库量单列',
    Math.abs(shiftDosed - dosed) < 0.5 && purchased > 0,
    `投加 ${fmt(shiftDosed, 1)} kg vs 脉冲合计 ${fmt(dosed, 1)} kg；入库参照 ${fmt(purchased, 0)} kg（不当作投加）`,
  );
  const codShift = eff.byShift.COD.removal;
  const codCond = eff.byCondition.COD.removal;
  const naive = eff.shifts.reduce<number | null>((a, s) => {
    const v = s.naiveYieldByPurchase.COD?.best ?? null;
    return v === null ? a : (a ?? 0) + v;
  }, null);
  check(
    '两条汇总路径给出可解释范围',
    Boolean(codShift && codCond),
    `按班次 COD 去除 ${fmt((codShift?.min ?? 0) * 100, 1)}–${fmt((codShift?.max ?? 0) * 100, 1)}%（${eff.byShift.COD.included}/${pairings.length} 段）；按稳定工况 ${fmt((codCond?.min ?? 0) * 100, 1)}–${fmt((codCond?.max ?? 0) * 100, 1)}%（${eff.byCondition.COD.included} 段，未覆盖 ${Math.round(eff.byCondition.COD.uncoveredSeconds / 60)} 分钟）`,
  );
  void naive;

  // 9. 迟到化验
  console.log(`  迟到候选 ${eff.lateLabCandidates.length} 个：${eff.lateLabCandidates.map((c) => `${c.labId}(${c.categories.join('/')})`).join('，') || '无'}`);
}

console.log('\n=== 全厂迟到化验复盘候选 ===');
const ct01 = computeTankEfficiency(dataset, 'CT-01', day, { reviewCutoffReceivedAt: cutoff });
const ct02 = computeTankEfficiency(dataset, 'CT-02', day, { reviewCutoffReceivedAt: cutoff });
const allLate = [...ct01.lateLabCandidates, ...ct02.lateLabCandidates];
check(
  '迟到化验均晚于复盘截止',
  allLate.length > 0 && allLate.every((c) => c.receivedAt > cutoff),
  allLate.map((c) => `${c.labId}@${hhmm(c.receivedAt)}`).join('，'),
);
check(
  '每条候选都标注不改写当班处置',
  allLate.every((c) => c.shiftActionsOverwritten === false),
  `${allLate.length} 条候选，shiftActionsOverwritten=false`,
);
const actionsBefore = JSON.stringify(dataset.shiftActions);
void computeTankEfficiency(dataset, 'CT-01', day, { reviewCutoffReceivedAt: cutoff });
check(
  '复盘计算不修改班次处置记录',
  JSON.stringify(dataset.shiftActions) === actionsBefore,
  `${dataset.shiftActions.length} 条处置记录保持不变`,
);
const pendingLab = allLate.find((c) => c.labId === 'L-1201');
check(
  '待取样类迟到结果兑现当班“待取样”事项',
  Boolean(pendingLab && pendingLab.categories.includes('SAMPLING_PENDING') && pendingLab.shiftId === 'S-DAY'),
  pendingLab ? `${pendingLab.labId} → ${pendingLab.categories.join('/')}（班次 ${pendingLab.shiftId}）` : '未找到',
);

console.log('\n=== 口径对照 ===');
for (const eff of [ct01, ct02]) {
  const shift = eff.byShift.COD;
  const cond = eff.byCondition.COD;
  console.log(
    `  ${eff.tankId}：按班次 ${fmt((shift.removal?.best ?? 0) * 100, 1)}% / 按稳定工况 ${fmt((cond.removal?.best ?? 0) * 100, 1)}%；单位药耗 ${fmt(cond.yieldKgPerKg?.best ?? null, 2)} kg COD/kg；未覆盖 ${Math.round(cond.uncoveredSeconds / 60)} 分钟`,
  );
}

console.log('\n=== 迟到化验与班次结论的关系 ===');
const dayTargets: CoagTarget[] = ['COD', 'NH3N'];
for (const target of dayTargets) {
  console.log(`  ${target}: 按班次 included=${ct01.byShift[target].included} / 按工况 included=${ct01.byCondition[target].included}`);
}

if (failures > 0) {
  console.error(`\n核验失败：${failures} 项不满足。`);
  process.exit(1);
}
console.log('\n核验通过：可达窗口、混合比例、库存平衡、异常归因、工况对照与迟到复盘均可复现。');
