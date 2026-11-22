/**
 * 区间编织：浓度、流量、状态与校准边界 → 可追溯原子片段
 *
 * 边界集合 = 自然日端点 ∪ 仪表实例/绑定交接点 ∪ 校准生效点 ∪ 状态切换点 ∪ 采样空档端点。
 * 相邻边界两两成段后，段内“仪表实例、校准、状态”三者唯一，可以精确积分并引用单一来源。
 *
 * 采样空档 = 同一仪表实例相邻有效读数间隔 > nominalInterval × 2.5。缺口从“上一个有效读数
 * + 一个标称间隔”起算（即应到未到的采样点），到下一个有效读数为止；段端最多保持
 * 一个标称间隔，且绝不跨校准系数插值。
 */

import {
  Binding,
  Calibration,
  DeviceState,
  EXCLUDING_STATES,
  Instrument,
  Metric,
  Reading,
  StatePeriod,
} from './types';
import { EPS, Iv } from './stats';

export const GAP_FACTOR = 2.5;
export const EDGE_HOLD_FACTOR = 1.0;

export interface TimelineIndex {
  readings: Reading[];
  byMetric: Record<Metric, Reading[]>;
  byInstrument: Map<string, Reading[]>;
  instrumentsById: Map<string, Instrument>;
  calibrationsById: Map<string, Calibration>;
  calibrationsByInstrument: Map<string, Calibration[]>;
  statesByInstrument: Map<string, StatePeriod[]>;
  bindingsByMetric: Record<Metric, Binding[]>;
}

export interface MetricContext {
  metric: Metric;
  pointCode: string;
  plantId: string;
  instruments: Instrument[];
  bindings: Binding[];
  calibrations: Calibration[];
  states: StatePeriod[];
  readings: Reading[];
  effectiveReadings: Reading[];
}

export interface InstrumentWindow {
  instrumentId: string;
  from: number;
  to: number;
  bindingId: string;
}

export interface SampleGap {
  instrumentId: string;
  from: number;
  to: number;
  leftReadingId: string;
  rightReadingId: string;
}

export function sortReadings(a: Reading, b: Reading): number {
  return a.alignedAt - b.alignedAt || a.receivedAt - b.receivedAt || a.readingId.localeCompare(b.readingId);
}

export function buildIndex(
  readings: Reading[],
  instruments: Instrument[],
  calibrations: Calibration[],
  states: StatePeriod[],
  bindings: Binding[],
): TimelineIndex {
  const instrumentsById = new Map(instruments.map((i) => [i.instrumentId, i]));
  const calibrationsById = new Map(calibrations.map((c) => [c.calibrationId, c]));
  const calibrationsByInstrument = new Map<string, Calibration[]>();
  for (const c of calibrations) {
    const arr = calibrationsByInstrument.get(c.instrumentId) ?? [];
    arr.push(c);
    calibrationsByInstrument.set(c.instrumentId, arr);
  }
  for (const arr of calibrationsByInstrument.values()) arr.sort((a, b) => a.effectiveAt - b.effectiveAt);
  const statesByInstrument = new Map<string, StatePeriod[]>();
  for (const s of states) {
    const arr = statesByInstrument.get(s.instrumentId) ?? [];
    arr.push(s);
    statesByInstrument.set(s.instrumentId, arr);
  }
  for (const arr of statesByInstrument.values()) arr.sort((a, b) => a.from - b.from);
  const byInstrument = new Map<string, Reading[]>();
  const byMetric: Record<Metric, Reading[]> = { COD: [], NH3N: [], FLOW: [] };
  const sorted = [...readings].sort(sortReadings);
  for (const r of sorted) {
    const arr = byInstrument.get(r.instrumentId) ?? [];
    arr.push(r);
    byInstrument.set(r.instrumentId, arr);
    byMetric[r.metric].push(r);
  }
  const bindingsByMetric: Record<Metric, Binding[]> = { COD: [], NH3N: [], FLOW: [] };
  for (const b of bindings) bindingsByMetric[b.metric]?.push(b);
  for (const arr of Object.values(bindingsByMetric)) arr.sort((a, b) => a.from - b.from);
  return {
    readings: sorted,
    byMetric,
    byInstrument,
    instrumentsById,
    calibrationsById,
    calibrationsByInstrument,
    statesByInstrument,
    bindingsByMetric,
  };
}

export function buildMetricContext(
  index: TimelineIndex,
  metric: Metric,
  pointCode: string,
  plantId: string,
  options: { includeSuspect: boolean },
): MetricContext {
  const bindings = index.bindingsByMetric[metric].filter((b) => b.pointCode === pointCode);
  const instrumentIds = new Set(bindings.map((b) => b.instrumentId));
  const instruments = [...instrumentIds]
    .map((id) => index.instrumentsById.get(id))
    .filter((i): i is Instrument => Boolean(i));
  const calibrations = instruments.flatMap((i) => index.calibrationsByInstrument.get(i.instrumentId) ?? []);
  const states = instruments.flatMap((i) => index.statesByInstrument.get(i.instrumentId) ?? []);
  const readings = index.byMetric[metric].filter(
    (r) => r.pointCode === pointCode && r.plantId === plantId && instrumentIds.has(r.instrumentId),
  );
  const effectiveReadings = readings.filter(
    (r) => r.qualityFlag !== 'INVALID' && (r.qualityFlag !== 'SUSPECT' || options.includeSuspect),
  );
  return { metric, pointCode, plantId, instruments, bindings, calibrations, states, readings, effectiveReadings };
}

/** 仪表实例窗口：binding ∩ instrument 安装/拆除 ∩ 查询窗口 */
export function instrumentWindows(
  ctx: MetricContext,
  windowFrom: number,
  windowTo: number,
): InstrumentWindow[] {
  const windows: InstrumentWindow[] = [];
  for (const b of ctx.bindings) {
    const inst = ctx.instruments.find((i) => i.instrumentId === b.instrumentId);
    if (!inst) continue;
    const from = Math.max(windowFrom, b.from, inst.installedAt);
    const to = Math.min(windowTo, b.to ?? Number.POSITIVE_INFINITY, inst.removedAt ?? Number.POSITIVE_INFINITY);
    if (to > from) windows.push({ instrumentId: b.instrumentId, from, to, bindingId: b.bindingId });
  }
  windows.sort((a, b) => a.from - b.from || a.instrumentId.localeCompare(b.instrumentId));
  return windows;
}

export function windowAt(windows: InstrumentWindow[], at: number): InstrumentWindow | null {
  let found: InstrumentWindow | null = null;
  for (const w of windows) if (w.from <= at && at < w.to) found = w;
  return found;
}

export function stateAt(index: TimelineIndex, instrumentId: string, at: number): StatePeriod | null {
  const list = index.statesByInstrument.get(instrumentId) ?? [];
  let found: StatePeriod | null = null;
  for (const s of list) if (s.from <= at && (s.to === null || at < s.to)) found = s;
  return found;
}

export function calibrationAt(index: TimelineIndex, instrumentId: string, at: number): Calibration | null {
  const list = index.calibrationsByInstrument.get(instrumentId) ?? [];
  let found: Calibration | null = null;
  for (const c of list) {
    if (c.effectiveAt <= at) found = c;
    else break;
  }
  return found;
}

export function calibratedValue(raw: number, inst: Instrument | null, cal: Calibration | null): number {
  const scale = cal?.scale ?? inst?.scale ?? 1;
  const offset = cal?.offset ?? inst?.offset ?? 0;
  return raw * scale + offset;
}

export function relativeUncertainty(inst: Instrument | null, cal: Calibration | null): number {
  return cal?.coefficientUncertainty ?? inst?.valueUncertainty ?? 0.02;
}

export function isExcluded(state: DeviceState | null): boolean {
  return state === null || EXCLUDING_STATES.has(state);
}

export function gapThresholdMs(inst: Instrument | null): number {
  return (inst?.nominalIntervalSeconds ?? 60) * 1000 * GAP_FACTOR;
}

export function edgeHoldMs(inst: Instrument | null): number {
  return (inst?.nominalIntervalSeconds ?? 60) * 1000 * EDGE_HOLD_FACTOR;
}

/** 采样空档：按同一仪表实例的相邻有效读数检测（不跨实例） */
export function detectSampleGaps(
  ctx: MetricContext,
  index: TimelineIndex,
  windowFrom: number,
  windowTo: number,
): SampleGap[] {
  const gaps: SampleGap[] = [];
  const byInst = new Map<string, Reading[]>();
  for (const r of ctx.effectiveReadings) {
    if (r.alignedAt < windowFrom || r.alignedAt >= windowTo) continue;
    const arr = byInst.get(r.instrumentId) ?? [];
    arr.push(r);
    byInst.set(r.instrumentId, arr);
  }
  for (const [instrumentId, list] of byInst) {
    const inst = index.instrumentsById.get(instrumentId) ?? null;
    const threshold = gapThresholdMs(inst);
    list.sort(sortReadings);
    for (let i = 1; i < list.length; i += 1) {
      const left = list[i - 1];
      const right = list[i];
      if (right.alignedAt - left.alignedAt > threshold) {
        // 缺口自“上一读数 + 一个标称间隔”起算：更早的部分仍有零阶保持证据
        const nominalMs = (inst?.nominalIntervalSeconds ?? 60) * 1000;
        const gapFrom = Math.min(left.alignedAt + nominalMs, right.alignedAt);
        gaps.push({
          instrumentId,
          from: gapFrom,
          to: right.alignedAt,
          leftReadingId: left.readingId,
          rightReadingId: right.readingId,
        });
      }
    }
  }
  return gaps.sort((a, b) => a.from - b.from);
}

export type BoundaryKind =
  | 'DAY_START'
  | 'DAY_END'
  | 'CALIBRATION'
  | 'STATE'
  | 'INSTRUMENT_SWAP'
  | 'GAP';

export interface BoundaryPoint {
  at: number;
  kind: BoundaryKind;
  refId: string | null;
  label: string;
}

export interface WeaveResult {
  boundaries: BoundaryPoint[];
  concWindows: InstrumentWindow[];
  flowWindows: InstrumentWindow[];
  concGaps: SampleGap[];
  flowGaps: SampleGap[];
}

/** 编织全部边界；每个边界保留来源 ID 与标签，用于片段追溯 */
export function weaveBoundaries(
  concCtx: MetricContext,
  flowCtx: MetricContext,
  index: TimelineIndex,
  windowFrom: number,
  windowTo: number,
): WeaveResult {
  const points: BoundaryPoint[] = [];
  const push = (at: number, kind: BoundaryKind, refId: string | null, label: string) => {
    if (at >= windowFrom && at <= windowTo) points.push({ at, kind, refId, label });
  };
  const concWindows = instrumentWindows(concCtx, windowFrom, windowTo);
  const flowWindows = instrumentWindows(flowCtx, windowFrom, windowTo);
  const tag = (metric: Metric) => (metric === 'FLOW' ? '流量' : metric === 'COD' ? 'COD' : '氨氮');
  for (const w of concWindows) {
    push(w.from, 'INSTRUMENT_SWAP', w.instrumentId, `${tag(concCtx.metric)}仪表 ${w.instrumentId} 接管`);
    push(w.to, 'INSTRUMENT_SWAP', w.instrumentId, `${tag(concCtx.metric)}仪表 ${w.instrumentId} 交回`);
  }
  for (const w of flowWindows) {
    push(w.from, 'INSTRUMENT_SWAP', w.instrumentId, `流量计 ${w.instrumentId} 接管`);
    push(w.to, 'INSTRUMENT_SWAP', w.instrumentId, `流量计 ${w.instrumentId} 交回`);
  }
  for (const c of concCtx.calibrations) {
    push(c.effectiveAt, 'CALIBRATION', c.calibrationId, `${tag(concCtx.metric)}校准生效 ${c.certificate}`);
  }
  for (const c of flowCtx.calibrations) {
    push(c.effectiveAt, 'CALIBRATION', c.calibrationId, `流量校准生效 ${c.certificate}`);
  }
  for (const s of concCtx.states) {
    push(s.from, 'STATE', s.stateId, `${tag(concCtx.metric)}状态 ${s.state}`);
    if (s.to !== null) push(s.to, 'STATE', s.stateId, `${tag(concCtx.metric)}状态结束 ${s.state}`);
  }
  for (const s of flowCtx.states) {
    push(s.from, 'STATE', s.stateId, `流量状态 ${s.state}`);
    if (s.to !== null) push(s.to, 'STATE', s.stateId, `流量状态结束 ${s.state}`);
  }
  const concGaps = detectSampleGaps(concCtx, index, windowFrom, windowTo);
  const flowGaps = detectSampleGaps(flowCtx, index, windowFrom, windowTo);
  for (const g of concGaps) {
    push(g.from, 'GAP', g.leftReadingId, `${tag(concCtx.metric)}采样空档开始`);
    push(g.to, 'GAP', g.rightReadingId, `${tag(concCtx.metric)}采样空档结束`);
  }
  for (const g of flowGaps) {
    push(g.from, 'GAP', g.leftReadingId, '流量采样空档开始');
    push(g.to, 'GAP', g.rightReadingId, '流量采样空档结束');
  }
  points.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  const dedup: BoundaryPoint[] = [];
  for (const p of points) {
    const last = dedup[dedup.length - 1];
    if (last && last.at === p.at && last.kind === p.kind && last.refId === p.refId) continue;
    dedup.push(p);
  }
  return { boundaries: dedup, concWindows, flowWindows, concGaps, flowGaps };
}

/** 某仪表窗口内按校准切分的“系数体制”，用于设备履历与来源核对 */
export function calibrationRegimes(
  ctx: MetricContext,
  index: TimelineIndex,
  windowFrom: number,
  windowTo: number,
): { instrumentId: string; calibrationId: string | null; from: number; to: number; readingIds: string[] }[] {
  const out: { instrumentId: string; calibrationId: string | null; from: number; to: number; readingIds: string[] }[] = [];
  for (const w of instrumentWindows(ctx, windowFrom, windowTo)) {
    const cals = (index.calibrationsByInstrument.get(w.instrumentId) ?? []).filter(
      (c) => c.effectiveAt > w.from && c.effectiveAt < w.to,
    );
    const cuts = [w.from, ...cals.map((c) => c.effectiveAt), w.to];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const from = cuts[i];
      const to = cuts[i + 1];
      if (to - from <= EPS) continue;
      const cal = calibrationAt(index, w.instrumentId, (from + to) / 2);
      const readingIds = ctx.effectiveReadings
        .filter((r) => r.instrumentId === w.instrumentId && r.alignedAt >= from && r.alignedAt < to)
        .map((r) => r.readingId);
      out.push({ instrumentId: w.instrumentId, calibrationId: cal?.calibrationId ?? null, from, to, readingIds });
    }
  }
  return out;
}

export function coverageOfWindows(windows: InstrumentWindow[], window: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const [a, b] of window) {
    for (const w of windows) {
      const lo = Math.max(a, w.from);
      const hi = Math.min(b, w.to);
      if (hi > lo) out.push([lo, hi]);
    }
  }
  return out;
}

export function isInstrumentExcludedAt(
  index: TimelineIndex,
  instrumentId: string,
  at: number,
): boolean {
  return isExcluded(stateAt(index, instrumentId, at)?.state ?? null);
}
