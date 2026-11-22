/**
 * 片段编织层：把浓度、流量、状态、校准边界编织为原子片段，并给出可积序列。
 *
 * 片段划分依据（每一类都必须是片段边界）：
 *   自然日起止 / 仪表实例与绑定交接 / 校准生效 / 状态切换 / 采样空档起止
 *
 * 片段内“浓度实例、流量实例、浓度校准、流量校准、两侧状态”唯一。
 * 序列只使用同一校准体制内的读数，绝不跨校准边界插值；
 * 相邻读数间隔超过 nominal×2.5 即判为空档：空档自“上一读数 + 一个标称间隔”起算，
 * 空档不参与积分，也不向两端无限外推。
 */

import {
  Calibration,
  DEFAULT_SCOPE,
  Dataset,
  Instrument,
  Metric,
  OutfallPoint,
  Pollutant,
  Reading,
  ScopeOptions,
  SegmentBoundary,
  SegmentCategory,
  StatePeriod,
} from './types';
import {
  buildIndex,
  buildMetricContext,
  calibrationAt,
  edgeHoldMs,
  gapThresholdMs,
  isExcluded,
  MetricContext,
  sortReadings,
  stateAt,
  TimelineIndex,
  weaveBoundaries,
  windowAt,
  InstrumentWindow,
} from './weave';
import { EPS, intersectIntervals, Iv, mergeIntervals } from './stats';
import { dayEndMs, dayStartMs } from './time';

export type PieceState = 'OK' | 'FLUSH' | 'CALIB' | 'BYPASS' | 'FAULT' | null;

export interface Knot {
  at: number;
  value: number;
  readingId: string;
}

export interface Series {
  knots: Knot[];
  /** 可积分覆盖域（已与片段窗口求交） */
  coverage: Iv[];
  valueAt: (t: number) => number | null;
  /** 结点间最大绝对斜率（值/秒），用于阈值穿越的 Lipschitz 上界 */
  maxSlope: number;
  /** 最近结点（不论是否在覆盖内），用于缺口影响量化 */
  nearest: (t: number) => Knot | null;
}

export interface Piece {
  from: number;
  to: number;
  category: SegmentCategory;
  state: PieceState;
  flowState: PieceState;
  stateId: string | null;
  flowStateId: string | null;
  stateReason: string | null;
  flowStateReason: string | null;
  concInstrument: Instrument | null;
  flowInstrument: Instrument | null;
  calibration: Calibration | null;
  flowCalibration: Calibration | null;
  conc: Series | null;
  flow: Series | null;
  /** 浓度∩流量都可积的域 */
  domain: Iv[];
  /** 仅浓度可积的域（阈值穿越与峰值用） */
  concDomain: Iv[];
  concReadings: Reading[];
  flowReadings: Reading[];
  boundaries: SegmentBoundary[];
  segmentId: string;
  /** 片段起点是否由校准生效切出 */
  calibrationCut: boolean;
}

export interface DayContext {
  dataset: Dataset;
  index: TimelineIndex;
  point: OutfallPoint;
  scope: ScopeOptions;
  windowFrom: number;
  windowTo: number;
  standards: Record<Pollutant, number>;
  pieces: Map<Pollutant, Piece[]>;
  readingsByInstrument: Map<string, Reading[]>;
}

export function makeDayContext(
  dataset: Dataset,
  pointCode: string,
  day: string,
  scopeInput: Partial<ScopeOptions> = {},
): DayContext {
  const point = dataset.points.find((p) => p.pointCode === pointCode);
  if (!point) throw new Error(`未知点位 ${pointCode}`);
  const plant = dataset.plants.find((p) => p.plantId === point.plantId);
  const scope: ScopeOptions = { ...DEFAULT_SCOPE, ...scopeInput };
  const index = buildIndex(
    dataset.readings,
    dataset.instruments,
    dataset.calibrations,
    dataset.states,
    dataset.bindings,
  );
  const readingsByInstrument = new Map<string, Reading[]>();
  for (const [id, list] of index.byInstrument) readingsByInstrument.set(id, [...list].sort(sortReadings));
  const ctx: DayContext = {
    dataset,
    index,
    point,
    scope,
    windowFrom: dayStartMs(day),
    windowTo: dayEndMs(day),
    standards: {
      COD: plant?.dischargeStandard.COD ?? 50,
      NH3N: plant?.dischargeStandard.NH3N ?? 5,
    },
    pieces: new Map(),
    readingsByInstrument,
  };
  ctx.pieces.set('COD', buildPieces(ctx, 'COD'));
  ctx.pieces.set('NH3N', buildPieces(ctx, 'NH3N'));
  return ctx;
}

function buildSeries(
  ctx: DayContext,
  instrument: Instrument,
  calibration: Calibration | null,
  run: Iv,
): Series {
  const [a, b] = run;
  const hold = edgeHoldMs(instrument);
  const gapMs = gapThresholdMs(instrument);
  const all = ctx.readingsByInstrument.get(instrument.instrumentId) ?? [];
  const excludedStates = (ctx.index.statesByInstrument.get(instrument.instrumentId) ?? []).filter((s) =>
    isExcluded(s.state),
  );
  const blocked = (t1: number, t2: number): boolean => {
    for (const s of excludedStates) {
      const to = s.to ?? Number.POSITIVE_INFINITY;
      if (s.from < t2 && to > t1) return true;
    }
    return false;
  };
  const calId = calibration?.calibrationId ?? null;
  const candidates = all.filter(
    (r) =>
      r.alignedAt >= a - hold &&
      r.alignedAt <= b + hold &&
      r.qualityFlag !== 'INVALID' &&
      (r.qualityFlag !== 'SUSPECT' || ctx.scope.includeSuspect) &&
      (calibrationAt(ctx.index, instrument.instrumentId, r.alignedAt)?.calibrationId ?? null) === calId &&
      !isExcluded(stateAt(ctx.index, instrument.instrumentId, r.alignedAt)?.state ?? null),
  );
  const scale = calibration?.scale ?? instrument.scale;
  const offset = calibration?.offset ?? instrument.offset;
  const knots: Knot[] = candidates
    .sort(sortReadings)
    .map((r) => ({ at: r.alignedAt, value: r.rawValue * scale + offset, readingId: r.readingId }));
  const coverage: Iv[] = [];
  for (let i = 1; i < knots.length; i += 1) {
    const t1 = knots[i - 1].at;
    const t2 = knots[i].at;
    if (t2 - t1 > EPS && t2 - t1 <= gapMs && !blocked(t1, t2)) coverage.push([t1, t2]);
  }
  if (knots.length > 0) {
    const first = knots[0];
    const last = knots[knots.length - 1];
    if (first.at > a && first.at - a <= hold && !blocked(a, first.at)) coverage.push([a, first.at]);
    if (last.at < b && b - last.at <= hold && !blocked(last.at, b)) coverage.push([last.at, b]);
  }
  const clipped = mergeIntervals(
    coverage.map(([x, y]) => [Math.max(a, x), Math.min(b, y)] as Iv).filter(([x, y]) => y - x > EPS),
  );
  let maxSlope = 0;
  for (let i = 1; i < knots.length; i += 1) {
    const dt = (knots[i].at - knots[i - 1].at) / 1000;
    if (dt > EPS) maxSlope = Math.max(maxSlope, Math.abs(knots[i].value - knots[i - 1].value) / dt);
  }
  const valueAt = (t: number): number | null => {
    if (knots.length === 0) return null;
    if (knots.length === 1) return Math.abs(t - knots[0].at) <= hold ? knots[0].value : null;
    const first = knots[0];
    const last = knots[knots.length - 1];
    if (t < first.at) return first.at - t <= hold ? first.value : null;
    if (t > last.at) return t - last.at <= hold ? last.value : null;
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid].at <= t) lo = mid;
      else hi = mid;
    }
    const p = knots[lo];
    const q = knots[hi];
    const span = q.at - p.at;
    if (span <= 0) return q.value;
    return p.value + ((q.value - p.value) * (t - p.at)) / span;
  };
  const nearest = (t: number): Knot | null => {
    if (knots.length === 0) return null;
    let best = knots[0];
    let dist = Math.abs(best.at - t);
    for (const k of knots) {
      const d = Math.abs(k.at - t);
      if (d < dist) {
        best = k;
        dist = d;
      }
    }
    return best;
  };
  return { knots, coverage: clipped, valueAt, maxSlope, nearest };
}

function classify(
  concWindow: InstrumentWindow | null,
  flowWindow: InstrumentWindow | null,
  concState: PieceState,
  flowState: PieceState,
): SegmentCategory {
  if (!concWindow || !flowWindow) return 'NO_INSTRUMENT';
  if (concState === null || flowState === null) return 'NO_STATE';
  if (isExcluded(concState) || isExcluded(flowState)) return 'EXCLUDED_STATE';
  return 'VALID';
}

export function buildPieces(ctx: DayContext, pollutant: Pollutant): Piece[] {
  const concCtx: MetricContext = buildMetricContext(
    ctx.index,
    pollutant,
    ctx.point.pointCode,
    ctx.point.plantId,
    { includeSuspect: ctx.scope.includeSuspect },
  );
  const flowCtx: MetricContext = buildMetricContext(
    ctx.index,
    'FLOW' as Metric,
    ctx.point.pointCode,
    ctx.point.plantId,
    { includeSuspect: ctx.scope.includeSuspect },
  );
  const weave = weaveBoundaries(concCtx, flowCtx, ctx.index, ctx.windowFrom, ctx.windowTo);
  const times = new Set<number>([ctx.windowFrom, ctx.windowTo]);
  for (const b of weave.boundaries) times.add(b.at);
  const sorted = [...times].sort((x, y) => x - y);
  const byTime = new Map<number, SegmentBoundary[]>();
  for (const b of weave.boundaries) {
    const arr = byTime.get(b.at) ?? [];
    arr.push({ kind: b.kind, at: b.at, refId: b.refId, label: b.label });
    byTime.set(b.at, arr);
  }
  const pieces: Piece[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to - from <= EPS) continue;
    const mid = (from + to) / 2;
    const concWindow = windowAt(weave.concWindows, mid);
    const flowWindow = windowAt(weave.flowWindows, mid);
    const concInstrument = concWindow ? ctx.index.instrumentsById.get(concWindow.instrumentId) ?? null : null;
    const flowInstrument = flowWindow ? ctx.index.instrumentsById.get(flowWindow.instrumentId) ?? null : null;
    const cState = concInstrument ? stateAt(ctx.index, concInstrument.instrumentId, mid) : null;
    const fState = flowInstrument ? stateAt(ctx.index, flowInstrument.instrumentId, mid) : null;
    const category = classify(concWindow, flowWindow, cState?.state ?? null, fState?.state ?? null);
    const calibration = concInstrument ? calibrationAt(ctx.index, concInstrument.instrumentId, mid) : null;
    const flowCalibration = flowInstrument ? calibrationAt(ctx.index, flowInstrument.instrumentId, mid) : null;
    let conc: Series | null = null;
    let flow: Series | null = null;
    if (category === 'VALID' && concInstrument && flowInstrument) {
      conc = buildSeries(ctx, concInstrument, calibration, [from, to]);
      flow = buildSeries(ctx, flowInstrument, flowCalibration, [from, to]);
    }
    const domain = conc && flow ? intersectIntervals(conc.coverage, flow.coverage) : ([] as Iv[]);
    const concDomain = conc ? mergeIntervals(conc.coverage) : ([] as Iv[]);
    const concReadings = concInstrument
      ? (ctx.readingsByInstrument.get(concInstrument.instrumentId) ?? []).filter(
          (r) => r.alignedAt >= from - 1 && r.alignedAt < to,
        )
      : [];
    const flowReadings = flowInstrument
      ? (ctx.readingsByInstrument.get(flowInstrument.instrumentId) ?? []).filter(
          (r) => r.alignedAt >= from - 1 && r.alignedAt < to,
        )
      : [];
    const boundaries: SegmentBoundary[] = [...(byTime.get(from) ?? [])];
    if (i === 0) boundaries.unshift({ kind: 'DAY_START', at: from, refId: null, label: '自然日起点' });
    if (i === sorted.length - 2)
      boundaries.push({ kind: 'DAY_END', at: to, refId: null, label: '自然日终点' });
    pieces.push({
      from,
      to,
      category,
      state: cState?.state ?? null,
      flowState: fState?.state ?? null,
      stateId: cState?.stateId ?? null,
      flowStateId: fState?.stateId ?? null,
      stateReason: cState?.reason ?? null,
      flowStateReason: fState?.reason ?? null,
      concInstrument,
      flowInstrument,
      calibration,
      flowCalibration,
      conc,
      flow,
      domain,
      concDomain,
      concReadings,
      flowReadings,
      boundaries,
      segmentId: `seg-${pollutant}-${from}-${to}`,
      calibrationCut: (byTime.get(from) ?? []).some((b) => b.kind === 'CALIBRATION'),
    });
  }
  return pieces;
}

export function isPieceActive(piece: Piece, from: number, to: number): boolean {
  return piece.to > from && piece.from < to;
}

export function coversAny(domain: Iv[], from: number, to: number): boolean {
  return intersectIntervals(domain, [[from, to]]).length > 0;
}

export { type StatePeriod };
