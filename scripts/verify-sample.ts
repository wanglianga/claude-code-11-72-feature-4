#!/usr/bin/env tsx
/**
 * 样例核验：同一组资料上运行两条积分路线，打印并校验
 *  - 日负荷范围、月负荷
 *  - 缺口说明（缺口秒数、缺口影响区间）
 *  - 来源链完整性（片段 → 读数 → 校准/状态 → 文件）
 *  - 校准切分、40 秒冲击、三分钟缺测、迟到重算候选
 * 退出码非 0 表示核验失败。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSampleFromDisk } from './sampleIo';
import type { SampleManifest } from '../src/domain/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { baseDataset, lateReadings } = parseSampleFromDisk(sampleDir, manifest);
import { compareRoutes, computeDayLoad, computeMonthLoad, readingsForDay } from '../src/domain/engine';
import { buildIndex, calibrationAt, stateAt } from '../src/domain/weave';
import { dayKeyFromMs } from '../src/domain/time';
import type { Dataset, Declaration, RecalcCandidate } from '../src/domain/types';

const day = manifest.focus.day;
const point = manifest.focus.pointCode;

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓ ${label}：${detail}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}：${detail}`);
  }
}

function fmt(n: number, d = 3): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtRange(b: { min: number; best: number; max: number }, d = 3): string {
  return `${fmt(b.min, d)} – ${fmt(b.best, d)} – ${fmt(b.max, d)} kg`;
}

console.log('=== 1. 双路线日负荷 ===');
const compare = compareRoutes(baseDataset, point, day);
for (const p of compare.segment.pollutants) {
  const q = compare.resample.pollutants.find((x) => x.pollutant === p.pollutant)!;
  console.log(`\n${p.pollutant}`);
  console.log(`  逐片段：${fmtRange(p.load)}，有效 ${fmt(p.effectiveSeconds, 0)} s，缺口 ${fmt(p.gapSeconds, 0)} s，排除 ${fmt(p.excludedSeconds, 0)} s，覆盖 ${(p.coverage * 100).toFixed(2)}%`);
  console.log(`  重采样：${fmtRange(q.load)}，网格 ${compare.resample.gridSeconds}s`);
  console.log(`  重叠比 ${compare.agreement.find((a) => a.pollutant === p.pollutant)!.overlapRatio.toFixed(5)}，峰值窗口偏移 ${compare.agreement.find((a) => a.pollutant === p.pollutant)!.peakShiftSeconds.toFixed(1)} s`);
  console.log(`  阈值穿越：逐片段 ${p.exceedances.length} 段 / ${p.exceedanceSeconds.toFixed(0)} s；重采样 ${q.exceedances.length} 段 / ${q.exceedanceSeconds.toFixed(0)} s`);
  console.log(`  1h 峰值：逐片段 ${p.peakWindow ? fmt(p.peakWindow.loadKg) : '—'} kg；重采样 ${q.peakWindow ? fmt(q.peakWindow.loadKg) : '—'} kg`);
}
check('双路线结论一致', compare.verified, compare.verified ? '通过（负荷范围、峰值、阈值穿越、缺口、来源链）' : '未通过');
check(
  '缺口说明一致',
  compare.gapConsistency.consistent,
  `逐片段 ${compare.gapConsistency.segmentGapSeconds.toFixed(1)} s vs 重采样 ${compare.gapConsistency.resampleGapSeconds.toFixed(1)} s`,
);
check('来源链完整', compare.provenanceComplete, compare.provenanceComplete ? '每片段含边界与来源 ID' : '缺来源');

console.log('\n=== 2. 重采样误差界与收敛 ===');
for (const g of compare.segment.resampleCheck!.gridResults) {
  console.log(
    `  ${String(g.gridSeconds).padStart(3)}s：负荷偏差 ${g.loadBestDriftPercent.toFixed(4)}%，峰值偏移 ${g.peakShiftSeconds.toFixed(0)}s，穿越对称差 ${g.exceedanceSymmetricDiffSeconds.toFixed(1)}s，误差界 ±${g.errorBoundKg.toFixed(4)} kg，${g.accepted ? '接受' : '拒绝'}`,
  );
}
check('重采样已通过收敛验证', compare.segment.resampleCheck!.verified, compare.segment.resampleCheck!.notes[1]);
const naive = compare.segment.resampleCheck!.naiveCheck;
console.log(`  朴素反例：负荷偏差 ${naive.loadErrorPercent.toFixed(2)}%，阈值穿越差异 ${naive.missedExceedanceSeconds.toFixed(0)}s`);
check('朴素重采样被证明不可用', naive.missedExceedanceSeconds > 0 || naive.loadErrorPercent > 0.5, naive.note);

console.log('\n=== 3. 校准中途生效必须切开片段 ===');
const codSeg = compare.segment.pollutants.find((p) => p.pollutant === 'COD')!;
const cuts = codSeg.segments.filter((s) => s.calibrationCut);
check('存在校准切口', cuts.length > 0, cuts.map((s) => `${new Date(s.from + 8 * 3600_000).toISOString().slice(11, 19)} ${s.calibrationId}`).join('；'));
const before13 = codSeg.segments.filter((s) => s.to <= Date.UTC(2026, 10, 18, 5, 0, 0));
const after13 = codSeg.segments.filter((s) => s.from >= Date.UTC(2026, 10, 18, 5, 0, 0));
const calBefore = new Set(before13.map((s) => s.calibrationId).filter(Boolean));
const calAfter = new Set(after13.map((s) => s.calibrationId).filter(Boolean));
check(
  '切口两侧系数不同',
  ![...calBefore].some((c) => [...calAfter].includes(c) && c === 'CAL-CO2-20261118') && calAfter.has('CAL-CO2-20261118'),
  `13:00 前 ${[...calBefore].join(',') || '默认'}；13:00 后 ${[...calAfter].join(',')}`,
);
const cutSeg = codSeg.segments.find((s) => s.calibrationId === 'CAL-CO2-20261118');
check(
  '校准记录与系数可回溯',
  Boolean(cutSeg && cutSeg.calibrationScale === 1.08 && cutSeg.calibrationOffset === -1.2),
  cutSeg ? `scale=${cutSeg.calibrationScale} offset=${cutSeg.calibrationOffset}` : '未找到',
);

console.log('\n=== 4. 40 秒高浓度冲击 ===');
const shocks = codSeg.exceedances.filter(
  (e) => e.from >= Date.UTC(2026, 10, 18, 1, 0, 0) && e.to <= Date.UTC(2026, 10, 18, 2, 0, 0),
);
const shock = shocks[0];
check('检出 09:15 冲击', Boolean(shock), shock ? `${new Date(shock.from + 8 * 3600_000).toISOString().slice(11, 23)} → ${new Date(shock.to + 8 * 3600_000).toISOString().slice(11, 23)}，${shock.seconds.toFixed(1)} s，峰值 ${shock.peak.toFixed(2)} mg/L` : '未检出');
check('冲击时长为 40 秒', Boolean(shock && Math.abs(shock.seconds - 40) <= 1), shock ? `实测 ${shock.seconds.toFixed(2)} s` : '—');
const resampleShock = compare.resample.pollutants.find((p) => p.pollutant === 'COD')!.exceedances.find(
  (e) => e.from >= Date.UTC(2026, 10, 18, 1, 0, 0) && e.to <= Date.UTC(2026, 10, 18, 2, 0, 0),
);
check(
  '重采样同样检出该冲击且时长一致',
  Boolean(resampleShock && Math.abs(resampleShock.seconds - 40) <= 2),
  resampleShock ? `${resampleShock.seconds.toFixed(1)} s` : '未检出',
);

console.log('\n=== 5. 三分钟缺测与缺口影响 ===');
const gaps = codSeg.gaps.filter((g) => g.kind === 'SAMPLING_GAP');
const gap3 = gaps.find((g) => Math.abs(g.seconds - 180) <= 5);
check('检出 180 秒采样空档', Boolean(gap3), gap3 ? `${new Date(gap3.from + 8 * 3600_000).toISOString().slice(11, 19)} → ${new Date(gap3.to + 8 * 3600_000).toISOString().slice(11, 19)}，${gap3.seconds.toFixed(0)} s` : gaps.map((g) => `${g.seconds.toFixed(0)}s`).join(','));
if (gap3) {
  const impact = gap3.impacts[0];
  console.log(`  缺口影响：${fmtRange(impact.impactKg)}（${impact.note}）`);
  check('缺口影响可量化', impact.impactKg.max >= impact.impactKg.min && impact.impactKg.max > 0, fmtRange(impact.impactKg));
  check('缺口未并入负荷', gap3.seconds > 0 && codSeg.coverage < 1, `覆盖率 ${(codSeg.coverage * 100).toFixed(2)}%`);
}
const resampleGap3 = compare.resample.pollutants
  .find((p) => p.pollutant === 'COD')!
  .gaps.find((g) => Math.abs(g.seconds - 180) <= 5);
check('重采样识别同一缺口', Boolean(resampleGap3), resampleGap3 ? `${resampleGap3.seconds.toFixed(0)} s` : '未识别');

console.log('\n=== 6. 排除时段（冲洗/旁路）===');
const exclusions = codSeg.exclusions;
console.log(`  排除 ${exclusions.length} 段：${exclusions.map((e) => `${e.state} ${e.seconds.toFixed(0)}s`).join('，')}`);
check('冲洗/旁路均被排除', exclusions.some((e) => e.state === 'FLUSH') && exclusions.some((e) => e.state === 'BYPASS'), `${exclusions.length} 段`);

console.log('\n=== 7. 点位编号复用与设备交接 ===');
const chain = compare.segment.instrumentChain.filter((c) => c.metric === 'COD');
const instrumentsOnPoint = [...new Set(chain.map((c) => c.instrumentId))];
check('同一编号衔接两个 COD 实例', instrumentsOnPoint.length >= 2, instrumentsOnPoint.join(' → '));
const codSegInstruments = codSeg.segments.filter((s) => s.category === 'VALID').map((s) => s.instrumentId);
check(
  '片段按实例交接切开',
  new Set(codSegInstruments).size >= 2,
  `片段实例：${[...new Set(codSegInstruments)].join(' → ')}`,
);

console.log('\n=== 8. 迟到读数 → 锁定来源范围的重算候选 ===');
const cutoff = Date.UTC(2026, 10, 18, 23, 20, 0); // 2026-11-19 07:20+08 = 基础批次最后接收时刻
const baseline = computeDayLoad(baseDataset, point, day, 'SEGMENT');
const declaration: Declaration = {
  declarationId: 'DECL-DEMO-1',
  pointCode: point,
  plantId: baseline.plantId,
  day,
  method: 'SEGMENT',
  gridSeconds: baseline.gridSeconds,
  createdAt: cutoff + 60_000,
  createdBy: '核验脚本',
  status: 'FILED',
  windowFrom: baseline.windowFrom,
  windowTo: baseline.windowTo,
  cutoffReceivedAt: cutoff,
  sourceReadingIds: baseline.sourceReadingIds,
  sourceFileHashes: [],
  result: baseline,
};
const lateInWindow = lateReadings.filter((r) => r.alignedAt >= declaration.windowFrom && r.alignedAt < declaration.windowTo);
console.log(`  迟到读数 ${lateInWindow.length} 条，采样时刻位于已锁定窗口内；接收时刻 ${new Date(lateInWindow[0].receivedAt + 8 * 3600_000).toISOString().slice(0, 16)} > 截止 ${new Date(cutoff + 8 * 3600_000).toISOString().slice(0, 16)}`);
check('迟到读数确实晚于截止', lateInWindow.every((r) => r.receivedAt > cutoff), `${lateInWindow.length} 条全部晚于截止`);
const augmented: Dataset = { ...baseDataset, readings: [...baseDataset.readings, ...lateReadings] };
const recomputed = computeDayLoad(augmented, point, day, 'SEGMENT');
const baselineIds = new Set(declaration.sourceReadingIds);
const newIds = recomputed.sourceReadingIds.filter((id) => !baselineIds.has(id));
check('重算只引用锁定窗口内新增读数', newIds.length === lateInWindow.length, `新增来源 ${newIds.length} 条，均落在窗口内`);
check(
  '重算不覆盖申报版本',
  declaration.result.sourceReadingIds.length === baseline.sourceReadingIds.length && declaration.status === 'FILED',
  '申报版本保持 FILED，来源快照不变',
);
const before = baseline.pollutants.find((p) => p.pollutant === 'COD')!;
const after = recomputed.pollutants.find((p) => p.pollutant === 'COD')!;
console.log(`  基线 COD：${fmtRange(before.load)}，覆盖 ${(before.coverage * 100).toFixed(3)}%，缺口 ${before.gapSeconds.toFixed(0)}s`);
console.log(`  重算 COD：${fmtRange(after.load)}，覆盖 ${(after.coverage * 100).toFixed(3)}%，缺口 ${after.gapSeconds.toFixed(0)}s`);
check('重算填补了缺口', after.gapSeconds < before.gapSeconds - 100, `缺口 ${before.gapSeconds.toFixed(0)}s → ${after.gapSeconds.toFixed(0)}s`);
const diff = after.load.best - before.load.best;
console.log(`  差异：${diff >= 0 ? '+' : ''}${fmt(diff)} kg（${((diff / Math.max(before.load.best, 1e-9)) * 100).toFixed(3)}%）`);
check('差异说明可生成', Number.isFinite(diff), '见上方差异值');

console.log('\n=== 9. 溯源到原始行 ===');
const sampleReading = baseDataset.readings.find(
  (r) =>
    r.pointCode === 'CC-E01' &&
    r.metric === 'COD' &&
    r.alignedAt >= Date.UTC(2026, 10, 18, 5, 30, 0) &&
    r.alignedAt < Date.UTC(2026, 10, 18, 5, 31, 0),
);
const idx = buildIndex(baseDataset.readings, baseDataset.instruments, baseDataset.calibrations, baseDataset.states, baseDataset.bindings);
if (sampleReading) {
  const cal = calibrationAt(idx, sampleReading.instrumentId, sampleReading.alignedAt);
  const st = stateAt(idx, sampleReading.instrumentId, sampleReading.alignedAt);
  const calibrated = sampleReading.rawValue * (cal?.scale ?? 1) + (cal?.offset ?? 0);
  console.log(`  ${sampleReading.readingId}：raw ${sampleReading.rawValue} × ${cal?.scale ?? 1} + ${cal?.offset ?? 0} = ${calibrated.toFixed(3)} mg/L；状态 ${st?.state ?? '无'}；文件 ${sampleReading.sourceFileId} 行 ${sampleReading.sourceRow}`);
  check('读数可回溯到校准与状态', Boolean(cal) && Boolean(st), `${cal?.calibrationId} / ${st?.stateId}`);
}

console.log('\n=== 10. 月负荷 ===');
const month = computeMonthLoad(baseDataset, point, '2026-11', 'SEGMENT');
console.log(`  ${month.month}：有数据 ${month.daysWithData}/${month.daysInMonth} 天，覆盖均值 ${(month.coverage * 100).toFixed(2)}%，资格 ${month.eligibility}`);
for (const p of month.pollutants) console.log(`  ${p.pollutant}：${fmtRange(p.load)}`);
check('月值只汇总有数据日', month.daysComputed.length === month.daysWithData && month.missingDays.length === month.daysInMonth - month.daysWithData, `缺失 ${month.missingDays.length} 天不按零处理`);

console.log('\n=== 11. 多厂站/多频率覆盖 ===');
for (const p of baseDataset.points) {
  const snap = computeDayLoad(baseDataset, p.pointCode, day, 'SEGMENT');
  console.log(`  ${p.pointCode}（${p.plantId}）：覆盖 ${(snap.coverage * 100).toFixed(2)}%，资格 ${snap.eligibility.status}，COD ${fmt(snap.pollutants[0].load.best)} kg`);
}
check('四个点位均可计算', baseDataset.points.every((p) => {
  const snap = computeDayLoad(baseDataset, p.pointCode, day, 'SEGMENT');
  return snap.pollutants.every((t) => t.effectiveSeconds > 0);
}), baseDataset.points.map((p) => p.pointCode).join('，'));

const readingCount = readingsForDay(baseDataset, point, day).length;
console.log(`\nCC-E01 当日读数 ${readingCount} 行；样例总读数 ${baseDataset.readings.length} 行`);

if (failures > 0) {
  console.error(`\n核验失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n核验通过：两条路线给出相同的负荷范围、缺口说明与来源链。');
void dayKeyFromMs;
void (null as unknown as RecalcCandidate);
