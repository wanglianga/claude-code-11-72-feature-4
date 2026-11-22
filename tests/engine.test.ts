import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dataset, SampleManifest } from '../src/domain/types';
import { parseSampleFromDisk } from '../scripts/sampleIo';
import { compareRoutes, computeDayLoad, computeMonthLoad } from '../src/domain/engine';
import { detectLateReadings, buildRecalcCandidate, buildDeclaration, diffSnapshots } from '../src/domain/service';
import { mergeDataset } from '../src/sample/ingest';

const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { baseDataset, lateReadings, fingerprints } = parseSampleFromDisk(sampleDir, manifest);
const DAY = manifest.focus.day;
const POINT = manifest.focus.pointCode;

describe('样例资料', () => {
  it('文件指纹与清单一致', () => {
    expect(fingerprints.length).toBeGreaterThan(0);
    for (const f of fingerprints) expect(f.ok, f.fileName).toBe(true);
  });

  it('所有读数落在同一自然日', () => {
    const days = new Set(baseDataset.readings.map((r) => r.dayKey));
    expect([...days]).toEqual([DAY]);
  });

  it('覆盖三种上报频率', () => {
    const intervals = new Set(
      baseDataset.instruments.map((i) => i.nominalIntervalSeconds),
    );
    expect(intervals).toEqual(new Set([10, 60, 300]));
  });

  it('点位编号复用由两个实例衔接', () => {
    const chain = baseDataset.bindings.filter((b) => b.pointCode === POINT && b.metric === 'COD');
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(new Set(chain.map((b) => b.instrumentId)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('双路线负荷一致性', () => {
  const comparison = compareRoutes(baseDataset, POINT, DAY);

  it('两条路线均通过收敛与来源链核验', () => {
    expect(comparison.segment.resampleCheck?.verified).toBe(true);
    expect(comparison.provenanceComplete).toBe(true);
    expect(comparison.gapConsistency.consistent).toBe(true);
    expect(comparison.verified).toBe(true);
  });

  it('负荷范围重叠 ≥ 0.99', () => {
    for (const a of comparison.agreement) {
      expect(a.overlapRatio, a.pollutant).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('缺口秒数按污染物一致', () => {
    for (const t of comparison.segment.pollutants) {
      const other = comparison.resample.pollutants.find((x) => x.pollutant === t.pollutant)!;
      expect(Math.abs(t.gapSeconds - other.gapSeconds)).toBeLessThan(1);
    }
  });

  it('重采样误差界随网格变化且可接受', () => {
    const grids = comparison.segment.resampleCheck!.gridResults;
    expect(grids.map((g) => g.gridSeconds)).toEqual([15, 30, 60, 120]);
    expect(grids.every((g) => g.errorBoundKg >= 0)).toBe(true);
    expect(grids.filter((g) => g.accepted).length).toBeGreaterThan(0);
  });

  it('朴素反例给出可量化偏差', () => {
    const naive = comparison.segment.resampleCheck!.naiveCheck;
    expect(naive.loadErrorPercent + naive.missedExceedanceSeconds).toBeGreaterThan(0);
  });
});

describe('40 秒冲击与校准切分', () => {
  const snap = computeDayLoad(baseDataset, POINT, DAY, 'SEGMENT');
  const cod = snap.pollutants.find((p) => p.pollutant === 'COD')!;

  it('09:15 冲击恰好 40 秒', () => {
    const shock = cod.exceedances.find(
      (e) => e.from >= Date.UTC(2026, 10, 18, 1, 0, 0) && e.to <= Date.UTC(2026, 10, 18, 2, 0, 0),
    );
    expect(shock).toBeDefined();
    expect(shock!.seconds).toBeGreaterThan(39);
    expect(shock!.seconds).toBeLessThan(41);
    expect(shock!.peak).toBeGreaterThan(50);
  });

  it('13:00 校准生效处切开片段并引用新系数', () => {
    const after = cod.segments.filter((s) => s.from >= Date.UTC(2026, 10, 18, 5, 0, 0));
    expect(after.some((s) => s.calibrationCut)).toBe(true);
    const cal = after.find((s) => s.calibrationId === 'CAL-CO2-20261118');
    expect(cal).toBeDefined();
    expect(cal!.calibrationScale).toBe(1.08);
    expect(cal!.calibrationOffset).toBe(-1.2);
  });

  it('校验和：所有片段都有边界与来源', () => {
    for (const s of cod.segments) {
      expect(s.boundaries.length).toBeGreaterThanOrEqual(1);
      expect(s.sourceReadingIds.length + s.sourceStateIds.length).toBeGreaterThan(0);
    }
  });
});

describe('缺口与排除', () => {
  const snap = computeDayLoad(baseDataset, POINT, DAY, 'SEGMENT');
  const cod = snap.pollutants.find((p) => p.pollutant === 'COD')!;

  it('识别 3 分钟缺测并给出影响区间', () => {
    const gap = cod.gaps.find((g) => g.seconds >= 178 && g.seconds <= 181 && g.kind === 'SAMPLING_GAP');
    expect(gap).toBeDefined();
    expect(gap!.impacts[0].impactKg.max).toBeGreaterThan(gap!.impacts[0].impactKg.min);
  });

  it('冲洗与旁路均被排除且记录状态 ID', () => {
    const flush = cod.exclusions.find((e) => e.state === 'FLUSH');
    const bypass = cod.exclusions.find((e) => e.state === 'BYPASS');
    expect(flush?.stateId).toBe('ST-CCE01-FLUSH-0100');
    expect(bypass?.stateId).toBe('ST-CCE01-FL1-BYPASS-2000');
  });

  it('覆盖率低于 1 且资格可判定', () => {
    expect(snap.coverage).toBeLessThan(1);
    expect(['ELIGIBLE', 'CONDITIONAL', 'INELIGIBLE']).toContain(snap.eligibility.status);
  });
});

describe('迟到读数与重算候选', () => {
  const baseline = computeDayLoad(baseDataset, POINT, DAY, 'SEGMENT');
  const declaration = buildDeclaration(
    baseDataset,
    { pointCode: POINT, day: DAY, method: 'SEGMENT', createdBy: 'test', cutoffReceivedAt: Date.UTC(2026, 10, 19, 1, 20, 0) },
    Date.UTC(2026, 10, 19, 1, 21, 0),
  );

  it('申报版本锁定来源窗口与快照', () => {
    expect(declaration.status).toBe('FILED');
    expect(declaration.sourceReadingIds.length).toBe(baseline.sourceReadingIds.length);
    expect(declaration.windowTo - declaration.windowFrom).toBe(86_400_000);
  });

  it('迟到读数在窗口内但晚于截止', () => {
    const det = detectLateReadings(baseDataset, declaration);
    // 基础数据集本身不含迟到文件，因此这里为 0；并入后方可检出
    expect(det.lateReadings.length).toBe(0);
    const augmented = mergeDataset(baseDataset, { readings: lateReadings });
    const det2 = detectLateReadings(augmented, declaration);
    expect(det2.lateReadings.length).toBe(lateReadings.length);
    for (const r of det2.lateReadings) {
      expect(r.alignedAt).toBeGreaterThanOrEqual(declaration.windowFrom);
      expect(r.alignedAt).toBeLessThan(declaration.windowTo);
      expect(r.receivedAt).toBeGreaterThan(declaration.cutoffReceivedAt);
    }
  });

  it('重算只引用锁定窗口内读数且不覆盖申报版本', () => {
    const augmented: Dataset = mergeDataset(baseDataset, { readings: lateReadings });
    const candidate = buildRecalcCandidate(augmented, {
      declaration,
      createdBy: 'test',
      now: Date.UTC(2026, 10, 19, 9, 0, 0),
      autoDetected: true,
    });
    const baselineIds = new Set(candidate.baseline.sourceReadingIds);
    const added = candidate.recomputed.sourceReadingIds.filter((id) => !baselineIds.has(id));
    expect(added.length).toBe(lateReadings.length);
    expect(candidate.declarationOverwritten).toBe(false);
    expect(candidate.lateReadingIds.length).toBe(lateReadings.length);
    expect(candidate.baseline.sourceReadingIds).toEqual(declaration.sourceReadingIds);
    expect(candidate.recomputed.eligibility.status).not.toBe('INELIGIBLE');
    expect(candidate.diff.note).toContain('申报版本未被改写');
    expect(Math.abs(candidate.diff.coverageDelta)).toBeGreaterThan(0);
  });

  it('差异说明包含两个污染物的负荷变化', () => {
    const diff = diffSnapshots(baseline, baseline);
    expect(diff.byPollutant.map((d) => d.pollutant)).toEqual(['COD', 'NH3N']);
    expect(diff.byPollutant.every((d) => Math.abs(d.deltaKg) < 1e-9)).toBe(true);
  });
});

describe('覆盖判断与月度', () => {
  it('冲洗、旁路、缺口都不计入覆盖率', () => {
    const snap = computeDayLoad(baseDataset, POINT, DAY, 'SEGMENT');
    const cod = snap.pollutants.find((p) => p.pollutant === 'COD')!;
    // 有效 + 缺口 + 排除 正好铺满自然日（互不重叠、无遗漏）
    expect(cod.effectiveSeconds + cod.excludedSeconds + cod.gapSeconds).toBeCloseTo(86_400, 0);
    expect(cod.coverage).toBeCloseTo(cod.effectiveSeconds / 86_400, 5);
    expect(cod.coverage).toBeLessThan(1);
  });

  it('月值只汇总有数据日', () => {
    const month = computeMonthLoad(baseDataset, POINT, '2026-11', 'SEGMENT');
    expect(month.daysWithData).toBe(1);
    expect(month.missingDays.length).toBe(month.daysInMonth - 1);
    expect(month.eligibility).not.toBe('ELIGIBLE');
  });

  it('点位编号复用：实例链按时间衔接不间断', () => {
    const snap = computeDayLoad(baseDataset, POINT, DAY, 'SEGMENT');
    const codChain = snap.instrumentChain.filter((c) => c.metric === 'COD').sort((a, b) => a.from - b.from);
    expect(codChain.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < codChain.length; i += 1) {
      expect(codChain[i].from).toBeGreaterThanOrEqual(codChain[i - 1].to);
    }
  });
});
