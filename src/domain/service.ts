/**
 * 复核服务：把 IndexedDB 中的资料组装为 Dataset，计算日/月负荷，
 * 出具申报版本（锁定来源窗口），并在迟到读数到达时生成重算候选与差异说明。
 *
 * 关键不变量：
 *  - 申报版本 FILED 后绝不覆盖；重复出具只会返回既有版本。
 *  - 重算候选只能引用 [windowFrom, windowTo) 内的读数，且只能使用申报截止后到达的迟到读数。
 *  - 重算结果永远作为候选保存，与原申报版本并列展示差异。
 */

import {
  DEFAULT_SCOPE,
  Dataset,
  Declaration,
  IntegrationMethod,
  LoadBounds,
  LoadDiff,
  MonthLoad,
  Pollutant,
  RecalcCandidate,
  Reading,
  ScopeOptions,
  DayLoadSnapshot,
  POLLUTANTS,
} from '../domain/types';
import { compareRoutes, computeDayLoad, computeMonthLoad } from '../domain/engine';
import { overlapRatio } from '../domain/stats';
import { dayStartMs, fmtDateTime } from '../domain/time';

export interface WorkbenchData {
  dataset: Dataset;
}

export function snapshotIds(snapshot: DayLoadSnapshot): string[] {
  return [...snapshot.sourceReadingIds].sort();
}

function boundsDelta(base: LoadBounds, next: LoadBounds): { deltaKg: number; deltaPercent: number; overlapKg: LoadBounds } {
  const overlapKg: LoadBounds = {
    min: Math.max(base.min, next.min),
    best: Math.max(base.min, Math.min(base.best, next.max)),
    max: Math.min(base.max, next.max),
  };
  const deltaKg = next.best - base.best;
  return {
    deltaKg,
    deltaPercent: Math.abs(base.best) > 1e-9 ? (deltaKg / base.best) * 100 : 0,
    overlapKg,
  };
}

export function diffSnapshots(baseline: DayLoadSnapshot, recomputed: DayLoadSnapshot): LoadDiff {
  const byPollutant = POLLUTANTS.map((pollutant: Pollutant) => {
    const a = baseline.pollutants.find((t) => t.pollutant === pollutant)!;
    const b = recomputed.pollutants.find((t) => t.pollutant === pollutant)!;
    return { pollutant, baseline: a.load, recomputed: b.load, ...boundsDelta(a.load, b.load) };
  });
  const baseGap = baseline.pollutants.reduce((acc, t) => acc + t.gapSeconds, 0);
  const nextGap = recomputed.pollutants.reduce((acc, t) => acc + t.gapSeconds, 0);
  const parts = byPollutant.map(
    (d) =>
      `${d.pollutant} ${d.deltaKg >= 0 ? '+' : ''}${d.deltaKg.toFixed(3)} kg（${d.deltaPercent.toFixed(3)}%），区间重叠比 ${overlapRatio(d.baseline, d.recomputed).toFixed(4)}`,
  );
  return {
    byPollutant,
    coverageDelta: recomputed.coverage - baseline.coverage,
    gapSecondsDelta: nextGap - baseGap,
    note: `差异说明：${parts.join('；')}。覆盖率 ${(baseline.coverage * 100).toFixed(3)}% → ${(recomputed.coverage * 100).toFixed(3)}%，未覆盖秒数 ${baseGap.toFixed(0)} → ${nextGap.toFixed(0)}。申报版本未被改写。`,
  };
}

export interface CreateDeclarationInput {
  pointCode: string;
  day: string;
  method: IntegrationMethod;
  createdBy: string;
  scope?: Partial<ScopeOptions>;
  cutoffReceivedAt?: number;
}

export function buildDeclaration(
  dataset: Dataset,
  input: CreateDeclarationInput,
  now: number,
): Declaration {
  const scope = { ...DEFAULT_SCOPE, ...input.scope };
  const snapshot = computeDayLoad(dataset, input.pointCode, input.day, input.method, { scope, withChart: true });
  const cutoff = input.cutoffReceivedAt ?? dataset.readings
    .filter((r) => r.pointCode === input.pointCode && r.dayKey === input.day)
    .reduce((acc, r) => Math.max(acc, r.receivedAt), 0);
  const fileHashes = dataset.files
    .filter((f) => snapshot.sourceFileIds.includes(f.fileId))
    .map((f) => `${f.fileId}:${f.sha256}`);
  return {
    declarationId: `DECL-${input.pointCode}-${input.day}-${now}`,
    pointCode: input.pointCode,
    plantId: snapshot.plantId,
    day: input.day,
    method: input.method,
    gridSeconds: snapshot.gridSeconds,
    createdAt: now,
    createdBy: input.createdBy,
    status: 'FILED',
    windowFrom: snapshot.windowFrom,
    windowTo: snapshot.windowTo,
    cutoffReceivedAt: cutoff,
    sourceReadingIds: snapshot.sourceReadingIds,
    sourceFileHashes: fileHashes,
    result: snapshot,
  };
}

export interface LateDetection {
  lateReadings: Reading[];
  lateFileIds: string[];
  fillsGapSeconds: number;
}

/** 找出“采样时刻在已锁定窗口内、接收时刻晚于申报截止”的读数 */
export function detectLateReadings(dataset: Dataset, declaration: Declaration): LateDetection {
  const inWindow = dataset.readings.filter(
    (r) =>
      r.pointCode === declaration.pointCode &&
      r.alignedAt >= declaration.windowFrom &&
      r.alignedAt < declaration.windowTo &&
      r.receivedAt > declaration.cutoffReceivedAt,
  );
  const fills = inWindow.reduce((acc, r) => {
    const snapshot = declaration.result;
    let covered = false;
    for (const t of snapshot.pollutants) {
      for (const seg of t.segments) {
        if (seg.category !== 'VALID') continue;
        if (r.alignedAt >= (seg.effectiveFrom ?? seg.from) && r.alignedAt < (seg.effectiveTo ?? seg.to)) {
          covered = true;
        }
      }
    }
    return covered ? acc : acc + 1;
  }, 0);
  return {
    lateReadings: inWindow,
    lateFileIds: [...new Set(inWindow.map((r) => r.sourceFileId))],
    fillsGapSeconds: fills,
  };
}

export interface BuildRecalcInput {
  declaration: Declaration;
  createdBy: string;
  now: number;
  scope?: Partial<ScopeOptions>;
  autoDetected?: boolean;
}

/**
 * 重算候选：锁定来源窗口不变，只把迟到读数并入；结果作为候选。
 * 若没有迟到读数，也允许生成候选以便人工确认（差异应为 0）。
 */
export function buildRecalcCandidate(
  dataset: Dataset,
  input: BuildRecalcInput,
): RecalcCandidate {
  const decl = input.declaration;
  const scope = { ...DEFAULT_SCOPE, ...input.scope, ...(decl.method === 'RESAMPLE' ? { gridSeconds: decl.gridSeconds } : {}) };
  const inWindow = dataset.readings.filter(
    (r) =>
      r.pointCode === decl.pointCode &&
      r.alignedAt >= decl.windowFrom &&
      r.alignedAt < decl.windowTo,
  );
  const late = inWindow.filter((r) => r.receivedAt > decl.cutoffReceivedAt);
  const recomputed = computeDayLoad(dataset, decl.pointCode, decl.day, decl.method, { scope, withChart: true });
  const baseline = decl.result;
  const diff = diffSnapshots(baseline, recomputed);
  const lateIds = new Set(late.map((r) => r.readingId));
  const fillsGap = recomputed.pollutants.reduce((acc, t) => {
    return acc + t.segments.filter((s) => s.sourceReadingIds.some((id) => lateIds.has(id))).length;
  }, 0);
  return {
    candidateId: `RC-${decl.declarationId}-${input.now}`,
    declarationId: decl.declarationId,
    pointCode: decl.pointCode,
    plantId: decl.plantId,
    day: decl.day,
    method: decl.method,
    gridSeconds: decl.gridSeconds,
    createdAt: input.now,
    createdBy: input.createdBy,
    status: 'PENDING',
    windowFrom: decl.windowFrom,
    windowTo: decl.windowTo,
    cutoffReceivedAt: decl.cutoffReceivedAt,
    lateReadingIds: late.map((r) => r.readingId),
    lateFileIds: [...new Set(late.map((r) => r.sourceFileId))],
    fillsGapSeconds: fillsGap,
    baseline,
    recomputed,
    diff,
    autoDetected: Boolean(input.autoDetected),
    declarationOverwritten: false,
  };
}

export function describeWindow(from: number, to: number): string {
  return `${fmtDateTime(from)} → ${fmtDateTime(to)}`;
}

export { compareRoutes, computeDayLoad, computeMonthLoad, dayStartMs };

export type { MonthLoad };
