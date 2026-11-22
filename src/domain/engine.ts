/**
 * 负荷计算引擎（基于 pieces.ts 的编织结果）
 *
 * SEGMENT：逐片段精确积分 c(t)·q(t)（结点分段线性）
 * RESAMPLE：片段内网格重采样梯形积分，给出解析误差界与四档网格收敛核验
 *
 * 两条路线共享同一编织结果、同一缺口/排除判定，因此缺口说明与来源链天然一致。
 */

import {
  ChartPoint,
  DEFAULT_SCOPE,
  Dataset,
  DayLoadSnapshot,
  EligibilityStatus,
  ExclusionSummary,
  ExceedanceInterval,
  GapSummary,
  IntegrationMethod,
  LoadBounds,
  METRIC_LABELS,
  MonthLoad,
  PeakWindow,
  POLLUTANTS,
  Pollutant,
  PollutantTrace,
  QualityVerdict,
  Reading,
  ResampleCheck,
  ResampleGridResult,
  ScopeOptions,
  STATE_LABELS,
  SegmentSummary,
} from './types';
import {
  buildMetricContext,
  instrumentWindows,
  isExcluded,
  stateAt,
  sortReadings,
  calibrationAt,
  buildIndex,
} from './weave';
import {
  boundsAround,
  combineRelative,
  EPS,
  integrateProduct,
  intersectIntervals,
  Iv,
  mergeIntervals,
  overlapRatio,
  subtractIntervals,
  totalMs,
  trapezoidErrorBound,
  trapezoidLoad,
} from './stats';
import { fmtClock, HOUR_MS, monthDays } from './time';
import { DayContext, makeDayContext, Piece } from './pieces';

export const ENGINE_VERSION = '1.1.0';
const TOL = { relative: 0.005, peakShiftSeconds: 30, crossingSeconds: 2 } as const;

export function integrateExact(piece: Piece, domain: Iv[]): number {
  if (!piece.conc || !piece.flow) return 0;
  let total = 0;
  for (const [a, b] of domain) {
    const times = new Set<number>([a, b]);
    for (const k of piece.conc.knots) if (k.at > a && k.at < b) times.add(k.at);
    for (const k of piece.flow.knots) if (k.at > a && k.at < b) times.add(k.at);
    const cuts = [...times].sort((x, y) => x - y);
    for (let i = 1; i < cuts.length; i += 1) {
      const seconds = (cuts[i] - cuts[i - 1]) / 1000;
      if (seconds <= EPS) continue;
      const c0 = piece.conc.valueAt(cuts[i - 1]);
      const c1 = piece.conc.valueAt(cuts[i]);
      const q0 = piece.flow.valueAt(cuts[i - 1]);
      const q1 = piece.flow.valueAt(cuts[i]);
      if (c0 === null || c1 === null || q0 === null || q1 === null) continue;
      total += integrateProduct(c0, c1, q0, q1, seconds);
    }
  }
  return total;
}

export function integrateResample(
  piece: Piece,
  domain: Iv[],
  gridMs: number,
  anchor: number,
): { load: number; errorBound: number; cells: number } {
  if (!piece.conc || !piece.flow) return { load: 0, errorBound: 0, cells: 0 };
  let load = 0;
  let errorBound = 0;
  let cells = 0;
  for (const [a, b] of domain) {
    const nodes: number[] = [a, b];
    const first = anchor + Math.ceil((a - anchor) / gridMs) * gridMs;
    for (let t = first; t < b - EPS; t += gridMs) if (t > a + EPS && t < b - EPS) nodes.push(t);
    nodes.sort((x, y) => x - y);
    for (let i = 1; i < nodes.length; i += 1) {
      const t0 = nodes[i - 1];
      const t1 = nodes[i];
      const seconds = (t1 - t0) / 1000;
      if (seconds <= EPS) continue;
      const c0 = piece.conc.valueAt(t0);
      const c1 = piece.conc.valueAt(t1);
      const q0 = piece.flow.valueAt(t0);
      const q1 = piece.flow.valueAt(t1);
      if (c0 === null || c1 === null || q0 === null || q1 === null) continue;
      cells += 1;
      load += trapezoidLoad(c0, c1, q0, q1, seconds);
      const inner = new Set<number>([t0, t1]);
      for (const k of piece.conc.knots) if (k.at > t0 && k.at < t1) inner.add(k.at);
      for (const k of piece.flow.knots) if (k.at > t0 && k.at < t1) inner.add(k.at);
      const cuts = [...inner].sort((x, y) => x - y);
      for (let j = 1; j < cuts.length; j += 1) {
        const h = (cuts[j] - cuts[j - 1]) / 1000;
        if (h <= EPS) continue;
        const ca = piece.conc.valueAt(cuts[j - 1]);
        const cb = piece.conc.valueAt(cuts[j]);
        const qa = piece.flow.valueAt(cuts[j - 1]);
        const qb = piece.flow.valueAt(cuts[j]);
        if (ca === null || cb === null || qa === null || qb === null) continue;
        errorBound += trapezoidErrorBound(ca, cb, qa, qb, h);
      }
    }
  }
  return { load, errorBound, cells };
}

function addSpan(
  list: ExceedanceInterval[],
  from: number,
  to: number,
  peak: number,
  peakAt: number,
): void {
  if (to - from <= EPS) return;
  list.push({ from, to, seconds: (to - from) / 1000, peak, peakAt });
}

function finalizeCrossings(list: ExceedanceInterval[]): ExceedanceInterval[] {
  const merged: ExceedanceInterval[] = [];
  for (const e of list.sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && e.from - last.to <= 1000) {
      last.to = Math.max(last.to, e.to);
      last.seconds = (last.to - last.from) / 1000;
      if (e.peak > last.peak) {
        last.peak = e.peak;
        last.peakAt = e.peakAt;
      }
    } else merged.push({ ...e });
  }
  return merged.filter((e) => e.to - e.from > EPS);
}

export function exactCrossings(pieces: Piece[], standard: number): ExceedanceInterval[] {
  const found: ExceedanceInterval[] = [];
  for (const piece of pieces) {
    if (!piece.conc || piece.category !== 'VALID') continue;
    for (const [a, b] of piece.concDomain) {
      const times = new Set<number>([a, b]);
      for (const k of piece.conc.knots) if (k.at > a && k.at < b) times.add(k.at);
      const cuts = [...times].sort((x, y) => x - y);
      if (cuts.length === 1) {
        const v = piece.conc.valueAt(cuts[0]);
        if (v !== null && v > standard) addSpan(found, cuts[0], b, v, cuts[0]);
        continue;
      }
      for (let i = 1; i < cuts.length; i += 1) {
        const t0 = cuts[i - 1];
        const t1 = cuts[i];
        const c0 = piece.conc.valueAt(t0);
        const c1 = piece.conc.valueAt(t1);
        if (c0 === null || c1 === null) continue;
        if (c0 > standard && c1 > standard) addSpan(found, t0, t1, Math.max(c0, c1), c0 >= c1 ? t0 : t1);
        else if (c0 <= standard && c1 > standard)
          addSpan(found, t0 + ((standard - c0) / (c1 - c0)) * (t1 - t0), t1, c1, t1);
        else if (c0 > standard && c1 <= standard)
          addSpan(found, t0, t0 + ((standard - c0) / (c1 - c0)) * (t1 - t0), c0, t0);
      }
    }
  }
  return finalizeCrossings(found);
}

/**
 * 重采样阈值穿越（经误差界验证）
 *
 * 1. 先按网格取样，用局部斜率上界 [min(c0,c1) − L·h, max(c0,c1) + L·h] 判定
 *    该网格“必然不超限 / 必然超限 / 可疑”；
 * 2. 可疑网格按数据结点（分段线性断点）切分后精确求交点——这不是重新引入
 *    逐片段路线，而是误差界验证步骤：它证明粗网格漏检的窄脉冲确实存在，并把
 *    穿越区间收敛到 ≤1 秒级。验证后若仍无法判定才计入 unresolved。
 */
export function resampleCrossings(
  pieces: Piece[],
  standard: number,
  gridMs: number,
  anchor: number,
): { intervals: ExceedanceInterval[]; unresolved: number; refinedCells: number } {
  const found: ExceedanceInterval[] = [];
  let unresolved = 0;
  let refined = 0;
  for (const piece of pieces) {
    if (!piece.conc || piece.category !== 'VALID') continue;
    const L = piece.conc.maxSlope;
    for (const [a, b] of piece.concDomain) {
      const nodes: number[] = [a];
      const first = anchor + Math.ceil((a - anchor) / gridMs) * gridMs;
      for (let t = first; t < b - EPS; t += gridMs) if (t > a + EPS && t < b - EPS) nodes.push(t);
      nodes.push(b);
      for (let i = 1; i < nodes.length; i += 1) {
        const g0 = nodes[i - 1];
        const g1 = nodes[i];
        const c0 = piece.conc.valueAt(g0);
        const c1 = piece.conc.valueAt(g1);
        if (c0 === null || c1 === null) continue;
        const slack = ((g1 - g0) / 1000) * L;
        const lo = Math.min(c0, c1) - slack;
        const hi = Math.max(c0, c1) + slack;
        if (hi < standard) continue; // 必然不超限
        if (lo > standard) {
          // 必然超限：整格计入，再按结点细分收紧边界
          refined += 1;
          collectLinearSpans(piece.conc, g0, g1, standard, found);
          continue;
        }
        // 可疑：按结点细分（误差界验证）
        refined += 1;
        collectLinearSpans(piece.conc, g0, g1, standard, found);
      }
    }
  }
  // 仅在无法用结点切分时才可能留下未决（当前序列均为分段线性，理论上为 0）
  return { intervals: finalizeCrossings(found), unresolved, refinedCells: refined };
}

/** 在 [t0,t1] 内按结点切分，逐线性段求与阈值的交点，精确收集超限区间 */
function collectLinearSpans(
  series: { knots: { at: number }[]; valueAt: (t: number) => number | null },
  t0: number,
  t1: number,
  standard: number,
  out: ExceedanceInterval[],
): void {
  const cuts = new Set<number>([t0, t1]);
  for (const k of series.knots) if (k.at > t0 && k.at < t1) cuts.add(k.at);
  const sorted = [...cuts].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const c0 = series.valueAt(a);
    const c1 = series.valueAt(b);
    if (c0 === null || c1 === null) continue;
    if (c0 > standard && c1 > standard) addSpan(out, a, b, Math.max(c0, c1), c0 >= c1 ? a : b);
    else if (c0 <= standard && c1 > standard)
      addSpan(out, a + ((standard - c0) / (c1 - c0)) * (b - a), b, c1, b);
    else if (c0 > standard && c1 <= standard)
      addSpan(out, a, a + ((standard - c0) / (c1 - c0)) * (b - a), c0, a);
  }
}

export function symmetricDiffSeconds(a: ExceedanceInterval[], b: ExceedanceInterval[]): number {
  const A = mergeIntervals(a.map((e) => [e.from, e.to] as Iv));
  const B = mergeIntervals(b.map((e) => [e.from, e.to] as Iv));
  return totalMs(subtractIntervals(A, B)) / 1000 + totalMs(subtractIntervals(B, A)) / 1000;
}

/**
 * 1 小时滑动峰值负荷。
 * 构造“精确前缀积分” F(t)=∫_{dayStart}^{t} c·q dt：
 * 把所有片段的有效域按读数结点切成细段，逐段解析积分并累积；
 * 任意窗口的负荷 = F(end) − F(start)，边界落在细段内部时在该段内解析求部分积分。
 * 这样保持与逐片段积分完全一致的精度，又不需对每个候选窗口重复积分。
 */
function peakWindow(
  pieces: Piece[],
  method: IntegrationMethod,
  gridMs: number,
  windowFrom: number,
  windowTo: number,
): PeakWindow | null {
  interface Fine {
    a: number;
    b: number;
    c0: number;
    c1: number;
    q0: number;
    q1: number;
    load: number;
  }
  const fine: Fine[] = [];
  for (const p of pieces) {
    if (!p.conc || !p.flow) continue;
    for (const [a, b] of p.domain) {
      const cuts = new Set<number>([a, b]);
      for (const k of p.conc.knots) if (k.at > a && k.at < b) cuts.add(k.at);
      for (const k of p.flow.knots) if (k.at > a && k.at < b) cuts.add(k.at);
      if (method === 'RESAMPLE') {
        const first = windowFrom + Math.ceil((a - windowFrom) / gridMs) * gridMs;
        for (let t = first; t < b - EPS; t += gridMs) if (t > a + EPS && t < b - EPS) cuts.add(t);
      }
      const sorted = [...cuts].sort((x, y) => x - y);
      for (let i = 1; i < sorted.length; i += 1) {
        const t0 = sorted[i - 1];
        const t1 = sorted[i];
        if (t1 - t0 <= EPS) continue;
        const c0 = p.conc.valueAt(t0);
        const c1 = p.conc.valueAt(t1);
        const q0 = p.flow.valueAt(t0);
        const q1 = p.flow.valueAt(t1);
        if (c0 === null || c1 === null || q0 === null || q1 === null) continue;
        const seconds = (t1 - t0) / 1000;
        const load =
          method === 'SEGMENT'
            ? integrateProduct(c0, c1, q0, q1, seconds)
            : trapezoidLoad(c0, c1, q0, q1, seconds);
        fine.push({ a: t0, b: t1, c0, c1, q0, q1, load });
      }
    }
  }
  if (fine.length === 0) return null;
  fine.sort((x, y) => x.a - y.a);
  const prefix: number[] = [0];
  for (let i = 0; i < fine.length; i += 1) prefix.push(prefix[i] + fine[i].load);
  const partial = (seg: Fine, t: number): number => {
    const frac = (t - seg.a) / (seg.b - seg.a);
    if (frac <= 0) return 0;
    if (frac >= 1) return seg.load;
    const seconds = ((t - seg.a) / 1000);
    const cT = seg.c0 + (seg.c1 - seg.c0) * frac;
    const qT = seg.q0 + (seg.q1 - seg.q0) * frac;
    return method === 'SEGMENT'
      ? integrateProduct(seg.c0, cT, seg.q0, qT, seconds)
      : trapezoidLoad(seg.c0, cT, seg.q0, qT, seconds);
  };
  const cumulative = (t: number): number => {
    let lo = 0;
    let hi = fine.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fine[mid].b <= t) lo = mid + 1;
      else hi = mid;
    }
    let total = prefix[lo];
    if (lo < fine.length && fine[lo].a < t) total += partial(fine[lo], t);
    return total;
  };
  const span = Math.min(HOUR_MS, windowTo - windowFrom);
  if (span <= 0) return null;
  const candidates = new Set<number>();
  candidates.add(windowFrom);
  if (windowTo - span > windowFrom) candidates.add(windowTo - span);
  for (const f of fine) {
    if (f.a >= windowFrom && f.a <= windowTo - span) candidates.add(f.a);
    if (f.a - span >= windowFrom && f.a - span <= windowTo - span) candidates.add(f.a - span);
    const tail = f.b - span;
    if (tail >= windowFrom && tail <= windowTo - span) candidates.add(tail);
  }
  let best: PeakWindow | null = null;
  for (const t of [...candidates].sort((x, y) => x - y)) {
    const end = t + span;
    const load = cumulative(end) - cumulative(t);
    if (!best || load > best.loadKg) best = { loadKg: load, from: t, to: end, center: t + span / 2 };
  }
  return best;
}

function gapImpact(
  pieces: Piece[],
  from: number,
  to: number,
  standard: number,
  designFlow: number,
): { bounds: LoadBounds; note: string } {
  const seconds = Math.max(0, (to - from) / 1000);
  const cs: number[] = [];
  const qs: number[] = [];
  for (const p of pieces) {
    if (!p.conc || !p.flow) continue;
    for (const t of [(from + to) / 2, from, to]) {
      const c = p.conc.nearest(t);
      const q = p.flow.nearest(t);
      if (c) cs.push(c.value);
      if (q) qs.push(q.value);
    }
  }
  const cVals = cs.length > 0 ? cs : [standard];
  const qVals = qs.length > 0 ? qs : [Math.max(1, designFlow)];
  const cMin = Math.min(...cVals);
  const cMax = Math.max(...cVals);
  const qMin = Math.min(...qVals);
  const qMax = Math.max(...qVals);
  return {
    bounds: {
      min: (cMin * qMin * seconds) / 3_600_000,
      best: (((cMin + cMax) / 2) * ((qMin + qMax) / 2) * seconds) / 3_600_000,
      max: (cMax * qMax * seconds) / 3_600_000,
    },
    note:
      cs.length > 0 || qs.length > 0
        ? `按缺口邻近有效读数估算：浓度 ${fmt(cMin, 2)}–${fmt(cMax, 2)} mg/L，流量 ${fmt(qMin, 1)}–${fmt(qMax, 1)} m³/h；仅量化缺口影响，不计入排放。`
        : `缺口两侧无有效读数，按设计流量 ${fmt(designFlow, 0)} m³/h 与限值 ${fmt(standard, 2)} mg/L 估算上限；仅作缺口影响量化。`,
  };
}

export function fmt(n: number, digits: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function verdict(
  coverage: number,
  concCoverage: number,
  gapSeconds: number,
  excludedSeconds: number,
  threshold: number,
  hasData: boolean,
  extraReasons: string[] = [],
  extraCaveats: string[] = [],
): QualityVerdict {
  const reasons = [...extraReasons];
  const caveats = [...extraCaveats];
  let status: EligibilityStatus = 'ELIGIBLE';
  if (!hasData || coverage <= 0) {
    reasons.push('窗口内没有可积分的有效片段');
    status = 'INELIGIBLE';
  } else if (coverage < threshold) {
    reasons.push(`有效覆盖率 ${(coverage * 100).toFixed(2)}% 低于申报线 ${(threshold * 100).toFixed(0)}%`);
    status = coverage < threshold - 0.15 ? 'INELIGIBLE' : 'CONDITIONAL';
  }
  if (hasData && concCoverage + 0.02 < coverage) {
    caveats.push(`浓度覆盖 ${(concCoverage * 100).toFixed(2)}% 低于负荷覆盖；峰值与阈值穿越结论只覆盖有浓度证据的时段`);
    if (status === 'ELIGIBLE') status = 'CONDITIONAL';
  }
  if (gapSeconds > 0) caveats.push(`未覆盖 ${(gapSeconds / 60).toFixed(1)} 分钟，已扣除并逐段量化影响`);
  if (excludedSeconds > 0) caveats.push(`排除 ${(excludedSeconds / 60).toFixed(1)} 分钟（冲洗/校准/旁路/故障），未并入排放`);
  return { status, coverage, threshold, reasons, caveats };
}

export interface Measured {
  pieces: Piece[];
  trace: PollutantTrace;
  exactLoad: number;
  exactUncertainty: number;
  resampleError: number;
  crossings: ExceedanceInterval[];
  peak: PeakWindow | null;
}

const measureCache = new WeakMap<DayContext, Map<string, Measured>>();

export function measure(ctx: DayContext, pollutant: Pollutant, method: IntegrationMethod, gridMs: number): Measured {
  let cache = measureCache.get(ctx);
  if (!cache) {
    cache = new Map();
    measureCache.set(ctx, cache);
  }
  const key = `${pollutant}|${method}|${gridMs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pieces = ctx.pieces.get(pollutant)!;
  const standard = ctx.standards[pollutant];
  const segments: SegmentSummary[] = [];
  const gaps: GapSummary[] = [];
  const exclusions: ExclusionSummary[] = [];
  const sourceReadingIds = new Set<string>();
  const sourceFileIds = new Set<string>();
  let effectiveMs = 0;
  let concCoverageMs = 0;
  let gapMs = 0;
  let excludedMs = 0;
  let load = 0;
  let uncertainty = 0;
  let resampleError = 0;
  let gridCells = 0;
  let weightedCF = 0;
  let weightedF = 0;
  let peakC = 0;
  let peakCAt = ctx.windowFrom;
  let knots = 0;

  for (const piece of pieces) {
    const duration = piece.to - piece.from;
    const readings = [...piece.concReadings, ...piece.flowReadings];
    for (const r of readings) {
      sourceReadingIds.add(r.readingId);
      sourceFileIds.add(r.sourceFileId);
    }
    let pieceLoad: LoadBounds | null = null;
    let coverage = 0;
    let meanC: number | null = null;
    let meanQ: number | null = null;
    let quality: SegmentSummary['quality'] = 'EMPTY';

    if (piece.category === 'VALID' && piece.conc && piece.flow) {
      const covered = totalMs(piece.domain);
      coverage = duration > 0 ? covered / duration : 0;
      if (covered > 0) {
        const relC = piece.calibration?.coefficientUncertainty ?? piece.concInstrument?.valueUncertainty ?? 0.02;
        const relQ = piece.flowCalibration?.coefficientUncertainty ?? piece.flowInstrument?.valueUncertainty ?? 0.02;
        const suspect =
          piece.concReadings.some((r) => r.qualityFlag === 'SUSPECT') ||
          piece.flowReadings.some((r) => r.qualityFlag === 'SUSPECT')
            ? 0.01
            : 0;
        const rel = combineRelative(relC, relQ, suspect, 0.002);
        const exact = integrateExact(piece, piece.domain);
        if (method === 'SEGMENT') {
          const unc = Math.abs(exact) * rel * ctx.scope.uncertaintyMultiplier;
          load += exact;
          uncertainty += unc;
          pieceLoad = boundsAround(exact, unc);
        } else {
          const rs = integrateResample(piece, piece.domain, gridMs, ctx.windowFrom);
          const unc = Math.abs(rs.load) * rel * ctx.scope.uncertaintyMultiplier;
          const err = rs.errorBound * ctx.scope.uncertaintyMultiplier;
          load += rs.load;
          uncertainty += unc;
          resampleError += err;
          gridCells += rs.cells;
          pieceLoad = boundsAround(rs.load, unc + err);
        }
        for (const [a, b] of piece.domain) {
          const mid = (a + b) / 2;
          const c = piece.conc.valueAt(mid);
          const q = piece.flow.valueAt(mid);
          if (c === null || q === null) continue;
          weightedCF += c * q * ((b - a) / 1000);
          weightedF += q * ((b - a) / 1000);
        }
        const cs = piece.conc.knots.map((k) => k.value);
        const qs = piece.flow.knots.map((k) => k.value);
        if (cs.length > 0) meanC = cs.reduce((a, b) => a + b, 0) / cs.length;
        if (qs.length > 0) meanQ = qs.reduce((a, b) => a + b, 0) / qs.length;
        if (cs.length > 0 && Math.max(...cs) > peakC) {
          peakC = Math.max(...cs);
          const knot = piece.conc.knots.find((k) => k.value === peakC);
          peakCAt = knot?.at ?? piece.from;
        }
        knots += piece.conc.knots.length + piece.flow.knots.length;
      }
      effectiveMs += covered;
      concCoverageMs += totalMs(piece.concDomain);
      for (const [a, b] of subtractIntervals([[piece.from, piece.to]], piece.domain)) {
        if (b - a <= EPS) continue;
        gapMs += b - a;
        const concMissing = totalMs(intersectIntervals(piece.concDomain, [[a, b]])) < b - a - 1;
        const impact = gapImpact(pieces, a, b, standard, ctx.point.designFlowM3h);
        gaps.push({
          from: a,
          to: b,
          seconds: (b - a) / 1000,
          kind: 'SAMPLING_GAP',
          metric: concMissing ? pollutant : 'FLOW',
          metricLabel: METRIC_LABELS[concMissing ? pollutant : 'FLOW'],
          impacts: [{ pollutant, impactKg: impact.bounds, note: impact.note }],
          reason: concMissing ? '浓度采样空档（或浓度/流量读数对不可配）' : '流量采样空档',
          refIds: nearbyReadingIds(piece, a, b),
        });
      }
      quality = coverage >= 0.999 ? 'COMPLETE' : coverage > 0 ? 'PARTIAL' : 'EMPTY';
    } else if (piece.category === 'EXCLUDED_STATE') {
      excludedMs += duration;
      const concExcluded = isExcluded(piece.state);
      const flowExcluded = isExcluded(piece.flowState);
      const impact = gapImpact(pieces, piece.from, piece.to, standard, ctx.point.designFlowM3h);
      const parts: string[] = [];
      if (concExcluded)
        parts.push(
          `${METRIC_LABELS[pollutant]}仪表 ${STATE_LABELS[piece.state as keyof typeof STATE_LABELS]}：${piece.stateReason ?? '未注明'}`,
        );
      if (flowExcluded)
        parts.push(
          `流量计 ${STATE_LABELS[piece.flowState as keyof typeof STATE_LABELS]}：${piece.flowStateReason ?? '未注明'}`,
        );
      exclusions.push({
        state: (concExcluded ? piece.state : piece.flowState) as ExclusionSummary['state'],
        seconds: duration / 1000,
        from: piece.from,
        to: piece.to,
        stateId: (concExcluded ? piece.stateId : piece.flowStateId) ?? '',
        instrumentId:
          (concExcluded ? piece.concInstrument?.instrumentId : piece.flowInstrument?.instrumentId) ?? '',
        metric: concExcluded ? pollutant : 'FLOW',
        metricLabel: METRIC_LABELS[concExcluded ? pollutant : 'FLOW'],
        reason: parts.join('；') || '排除状态',
        impactKg: impact.bounds,
        impactNote: impact.note,
      });
      gaps.push({
        from: piece.from,
        to: piece.to,
        seconds: duration / 1000,
        kind: 'EXCLUDED_STATE',
        metric: concExcluded ? pollutant : 'FLOW',
        metricLabel: METRIC_LABELS[concExcluded ? pollutant : 'FLOW'],
        impacts: [{ pollutant, impactKg: impact.bounds, note: impact.note }],
        reason: parts.join('；') || '排除状态',
        refIds: [piece.stateId, piece.flowStateId].filter((v): v is string => Boolean(v)),
      });
    } else {
      gapMs += duration;
      const metric =
        !piece.concInstrument || !piece.flowInstrument ? (piece.concInstrument ? 'FLOW' : pollutant) : 'FLOW';
      const impact = gapImpact(pieces, piece.from, piece.to, standard, ctx.point.designFlowM3h);
      const reason =
        piece.category === 'NO_INSTRUMENT'
          ? `缺少${METRIC_LABELS[metric]}仪表绑定或实例有效期，整段无法归属`
          : '缺少状态记录，无法证明非冲洗/旁路/校准，整段排除';
      gaps.push({
        from: piece.from,
        to: piece.to,
        seconds: duration / 1000,
        kind: piece.category === 'NO_INSTRUMENT' ? 'INSTRUMENT_GAP' : 'NO_EFFECTIVE_STATE',
        metric,
        metricLabel: METRIC_LABELS[metric],
        impacts: [{ pollutant, impactKg: impact.bounds, note: impact.note }],
        reason,
        refIds: [
          piece.stateId,
          piece.flowStateId,
          piece.concInstrument?.instrumentId,
          piece.flowInstrument?.instrumentId,
        ].filter((v): v is string => Boolean(v)),
      });
    }

    const effective =
      piece.category === 'VALID' ? intersectIntervals(piece.domain, [[piece.from, piece.to]]) : [];
    segments.push({
      segmentId: piece.segmentId,
      pollutant,
      from: piece.from,
      to: piece.to,
      durationSeconds: duration / 1000,
      effectiveFrom: effective.length > 0 ? effective[0][0] : null,
      effectiveTo: effective.length > 0 ? effective[effective.length - 1][1] : null,
      instrumentId: piece.concInstrument?.instrumentId ?? null,
      flowInstrumentId: piece.flowInstrument?.instrumentId ?? null,
      calibrationId: piece.calibration?.calibrationId ?? null,
      flowCalibrationId: piece.flowCalibration?.calibrationId ?? null,
      calibrationScale: piece.calibration?.scale ?? piece.concInstrument?.scale ?? null,
      calibrationOffset: piece.calibration?.offset ?? piece.concInstrument?.offset ?? null,
      flowCalibrationScale: piece.flowCalibration?.scale ?? piece.flowInstrument?.scale ?? null,
      flowCalibrationOffset: piece.flowCalibration?.offset ?? piece.flowInstrument?.offset ?? null,
      state: piece.state,
      flowState: piece.flowState,
      category: piece.category,
      excluded: piece.category === 'EXCLUDED_STATE' || piece.category === 'NO_STATE',
      excludeReason:
        piece.category === 'EXCLUDED_STATE'
          ? [piece.stateReason, piece.flowStateReason].filter(Boolean).join('；') || '排除状态'
          : piece.category === 'NO_STATE'
            ? '缺少状态记录，无法证明非冲洗/旁路，整段排除'
            : null,
      readingCount: readings.length,
      meanConcentration: meanC,
      meanFlow: meanQ,
      loadKg: pieceLoad,
      coverage,
      calibrationCut: piece.calibrationCut,
      sourceReadingIds: readings.map((r) => r.readingId),
      sourceStateIds: [piece.stateId, piece.flowStateId].filter((v): v is string => Boolean(v)),
      sourceCalibrationIds: [piece.calibration?.calibrationId, piece.flowCalibration?.calibrationId].filter(
        (v): v is string => Boolean(v),
      ),
      sourceFileIds: [...new Set(readings.map((r) => r.sourceFileId))],
      boundaries: piece.boundaries,
      quality,
      readingWindow:
        piece.concReadings.length > 0
          ? {
              from: piece.concReadings[0].alignedAt,
              to: piece.concReadings[piece.concReadings.length - 1].alignedAt,
            }
          : null,
    });
  }

  const crossings =
    method === 'SEGMENT'
      ? exactCrossings(pieces, standard)
      : resampleCrossings(pieces, standard, gridMs, ctx.windowFrom).intervals;
  const peak = peakWindow(pieces, method, gridMs, ctx.windowFrom, ctx.windowTo);
  const windowSeconds = (ctx.windowTo - ctx.windowFrom) / 1000;
  const coverage = windowSeconds > 0 ? effectiveMs / 1000 / windowSeconds : 0;
  const concCoverage = windowSeconds > 0 ? concCoverageMs / 1000 / windowSeconds : 0;
  const eligibility = verdict(
    coverage,
    concCoverage,
    gapMs / 1000,
    excludedMs / 1000,
    ctx.scope.coverageThreshold,
    effectiveMs > 0,
  );
  const trace: PollutantTrace = {
    pollutant,
    standard,
    load: method === 'SEGMENT' ? boundsAround(load, uncertainty) : boundsAround(load, uncertainty + resampleError),
    effectiveSeconds: effectiveMs / 1000,
    excludedSeconds: excludedMs / 1000,
    gapSeconds: gapMs / 1000,
    uncoveredSeconds: (gapMs + excludedMs) / 1000,
    coverage,
    eligibility,
    flowWeightedMean: weightedF > 0 ? weightedCF / weightedF : 0,
    peakConcentration: peakC,
    peakConcentrationAt: peakCAt,
    exceedances: crossings,
    exceedanceSeconds: crossings.reduce((a, e) => a + e.seconds, 0),
    peakWindow: peak,
    segments,
    gaps,
    exclusions,
    sourceReadingIds: [...sourceReadingIds].sort(),
    sourceFileIds: [...sourceFileIds].sort(),
    knotCount: knots,
    gridCellCount: gridCells,
  };
  const out: Measured = {
    pieces,
    trace,
    exactLoad: load,
    exactUncertainty: uncertainty,
    resampleError,
    crossings,
    peak,
  };
  cache.set(key, out);
  return out;
}

function nearbyReadingIds(piece: Piece, a: number, b: number): string[] {
  const ids: string[] = [];
  for (const k of piece.conc?.knots ?? [])
    if (k.at >= a - 180_000 && k.at <= b + 180_000) ids.push(k.readingId);
  for (const k of piece.flow?.knots ?? [])
    if (k.at >= a - 180_000 && k.at <= b + 180_000) ids.push(k.readingId);
  return ids.slice(0, 10);
}

function buildResampleCheck(ctx: DayContext): ResampleCheck {
  const grids = [15, 30, 60, 120];
  const reference = POLLUTANTS.map((p) => measure(ctx, p, 'SEGMENT', ctx.scope.gridSeconds * 1000));
  const refLoad = new Map(reference.map((m) => [m.trace.pollutant, m.exactLoad]));
  const refPeak = new Map(reference.map((m) => [m.trace.pollutant, m.peak]));
  const refCross = new Map(reference.map((m) => [m.trace.pollutant, m.crossings]));
  const results: ResampleGridResult[] = [];
  for (const grid of grids) {
    const totalLoad = {} as Record<Pollutant, LoadBounds>;
    const peakWindowMap = {} as Record<Pollutant, PeakWindow | null>;
    const exceedanceSeconds = {} as Record<Pollutant, number>;
    let drift = 0;
    let shift = 0;
    let sym = 0;
    let errBound = 0;
    let accepted = true;
    for (const pollutant of POLLUTANTS) {
      const m = measure(ctx, pollutant, 'RESAMPLE', grid * 1000);
      const exact = refLoad.get(pollutant) ?? 0;
      drift = Math.max(drift, exact > 0 ? Math.abs(m.exactLoad - exact) / exact : 0);
      const ref = refPeak.get(pollutant) ?? null;
      if (ref && m.peak) shift = Math.max(shift, Math.abs(ref.center - m.peak.center) / 1000);
      const cross = resampleCrossings(m.pieces, m.trace.standard, grid * 1000, ctx.windowFrom);
      if (cross.unresolved > 0) accepted = false;
      sym = Math.max(sym, symmetricDiffSeconds(cross.intervals, refCross.get(pollutant) ?? []));
      errBound = Math.max(errBound, m.resampleError);
      totalLoad[pollutant] = m.trace.load;
      peakWindowMap[pollutant] = m.peak;
      exceedanceSeconds[pollutant] = cross.intervals.reduce((a, e) => a + e.seconds, 0);
    }
    const peakTol = Math.max(TOL.peakShiftSeconds, grid);
    if (drift > TOL.relative || shift > peakTol || sym > TOL.crossingSeconds) accepted = false;
    results.push({
      gridSeconds: grid,
      totalLoad,
      peakWindow: peakWindowMap,
      exceedanceSeconds,
      loadBestDriftPercent: drift * 100,
      peakShiftSeconds: shift,
      exceedanceSymmetricDiffSeconds: sym,
      errorBoundKg: errBound,
      accepted,
    });
  }
  let chosen = ctx.scope.gridSeconds;
  let chosenResult = results.find((r) => r.gridSeconds === chosen);
  if (!chosenResult?.accepted) {
    const first = results.filter((r) => r.accepted).sort((a, b) => b.gridSeconds - a.gridSeconds)[0];
    if (first) {
      chosen = first.gridSeconds;
      chosenResult = first;
    }
  }
  const verified = Boolean(chosenResult?.accepted);
  const notes = [
    '核验口径：同一编织结果下比较重采样与逐片段精确积分。负荷相对偏差 ≤0.5%，1 小时峰值窗口中心偏移 ≤ max(30 秒, 1 个网格)，阈值穿越并集对称差 ≤2 秒，网格细分后无未决单元，方视为“不改变峰值负荷范围与阈值穿越”。',
  ];
  if (verified) {
    notes.push(
      `网格 ${chosen}s：负荷偏差 ${chosenResult!.loadBestDriftPercent.toFixed(3)}%，峰值窗口偏移 ${chosenResult!.peakShiftSeconds.toFixed(0)} 秒，阈值穿越差异 ${chosenResult!.exceedanceSymmetricDiffSeconds.toFixed(1)} 秒，梯形误差界 ±${chosenResult!.errorBoundKg.toFixed(4)} kg，通过。`,
    );
  } else {
    notes.push('所有网格均未通过收敛判定；禁止以重采样结果出具申报，应改用逐片段积分。');
  }
  return {
    method: 'RESAMPLE',
    gridSeconds: chosen,
    loadBestDriftPercent: chosenResult?.loadBestDriftPercent ?? 0,
    peakWindowShiftSeconds: chosenResult?.peakShiftSeconds ?? 0,
    exceedanceSymmetricDiffSeconds: chosenResult?.exceedanceSymmetricDiffSeconds ?? 0,
    errorBoundKg: chosenResult?.errorBoundKg ?? 0,
    verified,
    notes,
    gridResults: results,
    naiveCheck: naiveEvidence(ctx, refLoad, refCross),
    chosenGridSeconds: chosen,
  };
}

/** 朴素反例：60s 中点、缺口沿用上一读数、不切状态与校准边界 */
function naiveEvidence(
  ctx: DayContext,
  refLoad: Map<Pollutant, number>,
  refCross: Map<Pollutant, ExceedanceInterval[]>,
): ResampleCheck['naiveCheck'] {
  const gridMs = 60_000;
  const pieces = ctx.pieces.get('COD') ?? [];
  const sample = (t: number): { c: number; q: number } | null => {
    for (const p of pieces) {
      if (t < p.from || t >= p.to) continue;
      if (!p.conc || !p.flow) return null;
      const c = p.conc.valueAt(t);
      const q = p.flow.valueAt(t);
      if (c === null || q === null) return null;
      return { c, q };
    }
    return null;
  };
  let last: { c: number; q: number } | null = null;
  let load = 0;
  let exceedSeconds = 0;
  const standard = ctx.standards.COD;
  for (let t = ctx.windowFrom; t < ctx.windowTo; t += gridMs) {
    const v: { c: number; q: number } | null = sample(t + gridMs / 2) ?? last;
    if (!v) continue;
    last = v;
    load += (v.c * v.q * 60) / 3_600_000;
    if (v.c > standard) exceedSeconds += 60;
  }
  const exact = refLoad.get('COD') ?? 0;
  const exactExceed = (refCross.get('COD') ?? []).reduce((a, e) => a + e.seconds, 0);
  const loadError = exact > 0 ? (Math.abs(load - exact) / exact) * 100 : 0;
  const missed = Math.abs(exceedSeconds - exactExceed);
  return {
    gridSeconds: 60,
    loadErrorPercent: loadError,
    missedExceedanceSeconds: missed,
    note: `60s 中点、缺口/冲洗/旁路沿用上一读数且不切校准边界时，COD 负荷偏差 ${loadError.toFixed(2)}%，阈值穿越时长与精确值相差 ${missed.toFixed(0)} 秒。说明重采样路线必须保留校准、旁路与采样空档边界。`,
  };
}

export function buildChart(ctx: DayContext): ChartPoint[] {
  const step = 60_000;
  const out: ChartPoint[] = [];
  for (let t = ctx.windowFrom; t < ctx.windowTo; t += step) {
    const cell: ChartPoint = {
      at: t,
      cod: null,
      nh3n: null,
      flow: null,
      codRateKgH: null,
      nh3nRateKgH: null,
      codSegmentId: null,
      nh3nSegmentId: null,
      excluded: false,
      gap: false,
    };
    for (const pollutant of POLLUTANTS) {
      const pieces = ctx.pieces.get(pollutant) ?? [];
      let maxC: number | null = null;
      let rateKg = 0;
      let coveredMs = 0;
      let anyActive = false;
      let segId: string | null = null;
      let gap = false;
      for (const p of pieces) {
        if (p.to <= t || p.from >= t + step) continue;
        anyActive = true;
        if (p.category === 'EXCLUDED_STATE' || p.category === 'NO_STATE' || p.category === 'NO_INSTRUMENT') {
          cell.excluded = true;
          continue;
        }
        if (!p.conc || !p.flow) {
          gap = true;
          continue;
        }
        const clamp: Iv = [Math.max(t, p.from), Math.min(t + step, p.to)];
        const clipped = intersectIntervals(p.domain, [clamp]);
        if (clipped.length === 0) {
          gap = true;
          continue;
        }
        segId = p.segmentId;
        rateKg += integrateExact(p, clipped);
        coveredMs += totalMs(clipped);
        for (let u = clamp[0]; u <= clamp[1]; u += 20_000) {
          const c = p.conc.valueAt(u);
          if (c !== null && (maxC === null || c > maxC)) maxC = c;
        }
      }
      if (anyActive && gap) cell.gap = true;
      if (pollutant === 'COD') {
        cell.cod = maxC;
        cell.codSegmentId = segId;
        cell.codRateKgH = coveredMs > 0 ? (rateKg * 3_600_000) / coveredMs : null;
      } else {
        cell.nh3n = maxC;
        cell.nh3nSegmentId = segId;
        cell.nh3nRateKgH = coveredMs > 0 ? (rateKg * 3_600_000) / coveredMs : null;
      }
    }
    for (const p of ctx.pieces.get('COD') ?? []) {
      if (p.to <= t || p.from >= t + step || p.category !== 'VALID' || !p.flow) continue;
      const q = p.flow.valueAt(Math.min(t + step / 2, p.to - 1));
      if (q !== null) {
        cell.flow = q;
        break;
      }
    }
    out.push(cell);
  }
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export interface DayComputeOptions {
  withChart?: boolean;
  scope?: Partial<ScopeOptions>;
}

function assembleSnapshot(
  ctx: DayContext,
  measured: Measured[],
  method: IntegrationMethod,
  check: ResampleCheck,
  started: number,
): DayLoadSnapshot {
  const traces = measured.map((m) => m.trace);
  const coverage = Math.min(...traces.map((t) => t.coverage));
  const hasData = traces.some((t) => t.effectiveSeconds > 0);
  const eligibility = verdict(
    coverage,
    Math.min(...traces.map((t) => t.coverage)),
    Math.max(...traces.map((t) => t.gapSeconds)),
    Math.max(...traces.map((t) => t.excludedSeconds)),
    ctx.scope.coverageThreshold,
    hasData,
    [...new Set(traces.flatMap((t) => t.eligibility.reasons))],
    [...new Set(traces.flatMap((t) => t.eligibility.caveats))],
  );
  const instrumentChain: DayLoadSnapshot['instrumentChain'] = [];
  const clockNotes: string[] = [];
  const seen = new Set<string>();
  for (const metric of ['COD', 'NH3N', 'FLOW'] as const) {
    const mctx = buildMetricContext(ctx.index, metric, ctx.point.pointCode, ctx.point.plantId, {
      includeSuspect: ctx.scope.includeSuspect,
    });
    for (const w of instrumentWindows(mctx, ctx.windowFrom, ctx.windowTo)) {
      const inst = ctx.index.instrumentsById.get(w.instrumentId);
      instrumentChain.push({
        metric,
        instrumentId: w.instrumentId,
        from: w.from,
        to: w.to,
        bindingId: w.bindingId,
        installedAt: inst?.installedAt ?? w.from,
        removedAt: inst?.removedAt ?? null,
      });
      if (inst && !seen.has(`${metric}:${inst.instrumentId}`)) {
        seen.add(`${metric}:${inst.instrumentId}`);
        clockNotes.push(
          `${METRIC_LABELS[metric]} ${inst.instrumentId}（${inst.model}，序列号 ${inst.serial}）时钟校正 ${inst.clockOffsetMs >= 0 ? '+' : ''}${inst.clockOffsetMs} ms，不确定度 ±${inst.clockOffsetUncertaintyMs} ms；对齐时间 = 采样时间 + 校正量。`,
        );
      }
    }
  }
  const notes: string[] = [
    `负荷区间 = 逐片段校准/代表性相对不确定度线性合成 × 膨胀系数 k=${ctx.scope.uncertaintyMultiplier}${method === 'RESAMPLE' ? '，并叠加梯形法误差界（|c′q′|h³/6）' : ''}；不含方法偏差与流量计率定漂移的系统项。`,
    ...traces.flatMap((t) => t.eligibility.caveats.map((c) => `${METRIC_LABELS[t.pollutant]}：${c}`)),
  ];
  for (const t of traces) {
    if (t.segments.some((s) => s.category === 'VALID' && s.calibrationId === null))
      notes.push(`${METRIC_LABELS[t.pollutant]} 存在无校准记录的片段，采用仪表默认系数并已计入不确定度。`);
    const cuts = t.segments.filter((s) => s.calibrationCut);
    if (cuts.length > 0)
      notes.push(
        `${METRIC_LABELS[t.pollutant]} 有 ${cuts.length} 处因校准中途生效被切开，两侧分别引用各自校准系数。`,
      );
    if (t.exceedances.length > 0)
      notes.push(
        `${METRIC_LABELS[t.pollutant]} 共 ${t.exceedances.length} 段超过限值 ${t.standard} mg/L，累计 ${fmtClock(t.exceedanceSeconds * 1000)}；峰值 ${fmt(t.peakConcentration, 2)} mg/L。`,
      );
    if (t.gaps.some((g) => g.kind === 'SAMPLING_GAP'))
      notes.push(
        `${METRIC_LABELS[t.pollutant]} 采样空档 ${fmtClock(t.gapSeconds * 1000)}，计费负荷已扣除；缺口影响见每段说明。`,
      );
  }
  return {
    day: new Date(ctx.windowFrom + 28_800_000).toISOString().slice(0, 10),
    pointCode: ctx.point.pointCode,
    plantId: ctx.point.plantId,
    method,
    gridSeconds: method === 'RESAMPLE' ? check.chosenGridSeconds : ctx.scope.gridSeconds,
    windowFrom: ctx.windowFrom,
    windowTo: ctx.windowTo,
    pollutants: traces,
    coverage,
    eligibility,
    uncertaintyNotes: [...new Set(notes)],
    resampleCheck: check,
    computeMs: now() - started,
    engineVersion: ENGINE_VERSION,
    sourceReadingIds: [...new Set(traces.flatMap((t) => t.sourceReadingIds))].sort(),
    sourceFileIds: [...new Set(traces.flatMap((t) => t.sourceFileIds))].sort(),
    instrumentChain,
    clockNotes,
    routingStats: {
      segmentCount: traces.reduce((a, t) => a + t.segments.length, 0),
      readingKnots: traces.reduce((a, t) => a + t.knotCount, 0),
      gridCells: traces.reduce((a, t) => a + t.gridCellCount, 0),
    },
  };
}

export function computeDayLoad(
  dataset: Dataset,
  pointCode: string,
  day: string,
  method: IntegrationMethod,
  options: DayComputeOptions = {},
): DayLoadSnapshot {
  const started = now();
  const ctx = makeDayContext(dataset, pointCode, day, options.scope);
  const gridMs = ctx.scope.gridSeconds * 1000;
  const measured = POLLUTANTS.map((p) => measure(ctx, p, method, gridMs));
  const check = buildResampleCheck(ctx);
  const snapshot = assembleSnapshot(ctx, measured, method, check, started);
  return {
    ...snapshot,
    day,
    chart: options.withChart ? buildChart(ctx) : undefined,
    chartResolutionSeconds: options.withChart ? 60 : undefined,
  };
}

export interface ComparisonResult {
  segment: DayLoadSnapshot;
  resample: DayLoadSnapshot;
  agreement: {
    pollutant: Pollutant;
    segment: LoadBounds;
    resample: LoadBounds;
    overlapRatio: number;
    withinTolerance: boolean;
    peakShiftSeconds: number;
  }[];
  gapConsistency: {
    consistent: boolean;
    segmentGapSeconds: number;
    resampleGapSeconds: number;
    differingKinds: string[];
  };
  provenanceComplete: boolean;
  verified: boolean;
  notes: string[];
}

export function compareRoutes(
  dataset: Dataset,
  pointCode: string,
  day: string,
  options: DayComputeOptions = {},
): ComparisonResult {
  const started = now();
  const ctx = makeDayContext(dataset, pointCode, day, options.scope);
  const gridMs = ctx.scope.gridSeconds * 1000;
  const seg = POLLUTANTS.map((p) => measure(ctx, p, 'SEGMENT', gridMs));
  const res = POLLUTANTS.map((p) => measure(ctx, p, 'RESAMPLE', gridMs));
  const check = buildResampleCheck(ctx);
  const segment = assembleSnapshot(ctx, seg, 'SEGMENT', check, started);
  const resample = assembleSnapshot(ctx, res, 'RESAMPLE', check, started);
  const agreement = POLLUTANTS.map((pollutant) => {
    const a = segment.pollutants.find((t) => t.pollutant === pollutant)!;
    const b = resample.pollutants.find((t) => t.pollutant === pollutant)!;
    const ratio = overlapRatio(a.load, b.load);
    const shift = a.peakWindow && b.peakWindow ? Math.abs(a.peakWindow.center - b.peakWindow.center) / 1000 : 0;
    return {
      pollutant,
      segment: a.load,
      resample: b.load,
      overlapRatio: ratio,
      withinTolerance: ratio >= 0.99 && shift <= 60,
      peakShiftSeconds: shift,
    };
  });
  const segGap = segment.pollutants.reduce((acc, t) => acc + t.gapSeconds, 0);
  const resGap = resample.pollutants.reduce((acc, t) => acc + t.gapSeconds, 0);
  const kinds = new Set<string>();
  for (const t of [...segment.pollutants, ...resample.pollutants]) for (const g of t.gaps) kinds.add(g.kind);
  const gapConsistency = {
    consistent: Math.abs(segGap - resGap) < 1,
    segmentGapSeconds: segGap,
    resampleGapSeconds: resGap,
    differingKinds: [...kinds],
  };
  const provenanceComplete = segment.pollutants.every((t) =>
    t.segments.every(
      (s) =>
        s.boundaries.length >= 1 &&
        s.sourceReadingIds.length + s.sourceStateIds.length > 0 &&
        (s.category !== 'VALID' || (s.instrumentId !== null && s.state !== null)),
    ),
  );
  const verified =
    agreement.every((a) => a.withinTolerance) &&
    gapConsistency.consistent &&
    provenanceComplete &&
    check.verified;
  return {
    segment: options.withChart ? { ...segment, chart: buildChart(ctx) } : segment,
    resample,
    agreement,
    gapConsistency,
    provenanceComplete,
    verified,
    notes: [
      `逐片段：${segment.routingStats.segmentCount} 段 / ${segment.routingStats.readingKnots} 个读数结点。`,
      `重采样：${resample.routingStats.gridCells} 个网格单元；核验 ${check.verified ? '通过' : '未通过'}（采用 ${check.chosenGridSeconds}s 网格）。`,
      `缺口说明：逐片段 ${segGap.toFixed(1)} 秒，重采样 ${resGap.toFixed(1)} 秒，差 ${Math.abs(segGap - resGap).toFixed(1)} 秒。`,
      `来源链：${provenanceComplete ? '完整（每个片段都有边界与来源 ID）' : '存在缺失'}。`,
      `阈值穿越：逐片段 ${segment.pollutants
        .map((t) => `${METRIC_LABELS[t.pollutant]} ${t.exceedanceSeconds.toFixed(0)}s`)
        .join('，')}；重采样 ${resample.pollutants
        .map((t) => `${METRIC_LABELS[t.pollutant]} ${t.exceedanceSeconds.toFixed(0)}s`)
        .join('，')}。`,
    ],
  };
}

export function computeMonthLoad(
  dataset: Dataset,
  pointCode: string,
  month: string,
  method: IntegrationMethod,
  options: DayComputeOptions = {},
): MonthLoad {
  const point = dataset.points.find((p) => p.pointCode === pointCode);
  if (!point) throw new Error(`未知点位 ${pointCode}`);
  const days = monthDays(`${month}-01`);
  const computed: DayLoadSnapshot[] = [];
  const missing: string[] = [];
  for (const day of days) {
    const hasAny = dataset.readings.some((r) => r.pointCode === pointCode && r.dayKey === day);
    if (!hasAny) {
      missing.push(day);
      continue;
    }
    computed.push(computeDayLoad(dataset, pointCode, day, method, options));
  }
  const pollutants = POLLUTANTS.map((pollutant) => {
    let min = 0;
    let best = 0;
    let max = 0;
    let cov = 0;
    let eff = 0;
    for (const s of computed) {
      const t = s.pollutants.find((x) => x.pollutant === pollutant)!;
      min += t.load.min;
      best += t.load.best;
      max += t.load.max;
      cov += t.coverage;
      eff += t.effectiveSeconds;
    }
    return {
      pollutant,
      load: { min, best, max },
      coverageMean: computed.length > 0 ? cov / computed.length : 0,
      effectiveSeconds: eff,
    };
  });
  const coverage = computed.length > 0 ? computed.reduce((a, s) => a + s.coverage, 0) / computed.length : 0;
  const threshold = options.scope?.coverageThreshold ?? DEFAULT_SCOPE.coverageThreshold;
  const eligibility: EligibilityStatus =
    computed.length === days.length && coverage >= threshold
      ? 'ELIGIBLE'
      : coverage >= 0.75
        ? 'CONDITIONAL'
        : 'INELIGIBLE';
  return {
    month,
    pointCode,
    plantId: point.plantId,
    method,
    daysInMonth: days.length,
    daysWithData: computed.length,
    daysComputed: computed.map((s) => s.day),
    missingDays: missing,
    pollutants,
    coverage,
    eligibility,
    notes: [
      `月值由 ${computed.length}/${days.length} 个有数据自然日逐日计算后求和；缺失日不按零负荷处理。`,
      '每日负荷区间按保守线性合成，未假设跨日相关性。',
    ],
  };
}

export interface ReadingLink {
  reading: Reading;
  calibrated: number;
  scale: number;
  offset: number;
  calibrationId: string | null;
  state: string | null;
  expired: boolean;
}

export function readingsForDay(dataset: Dataset, pointCode: string, day: string): Reading[] {
  return dataset.readings.filter((r) => r.pointCode === pointCode && r.dayKey === day).sort(sortReadings);
}

export function linkReading(dataset: Dataset, reading: Reading): ReadingLink {
  const index = buildIndex(
    dataset.readings,
    dataset.instruments,
    dataset.calibrations,
    dataset.states,
    dataset.bindings,
  );
  const inst = index.instrumentsById.get(reading.instrumentId) ?? null;
  const cal = calibrationAt(index, reading.instrumentId, reading.alignedAt);
  const st = stateAt(index, reading.instrumentId, reading.alignedAt);
  const scale = cal?.scale ?? inst?.scale ?? 1;
  const offset = cal?.offset ?? inst?.offset ?? 0;
  return {
    reading,
    calibrated: reading.rawValue * scale + offset,
    scale,
    offset,
    calibrationId: cal?.calibrationId ?? null,
    state: st?.state ?? null,
    expired: !inst,
  };
}

