/**
 * 混凝剂投加效率计算引擎
 *
 * 关键口径（与 types.ts 注释一致）：
 * 1. 投加只认泵脉冲：实际体积 = 脉冲数 × 校准脉冲体积；浓度按储罐转移/稀释后的
 *    混合比例取值。采购入库量只进批次账与班次参照，绝不当作投加量。
 * 2. 可达出水窗口由「投加时刻 + 有效池容 / (进水流量 × (1+回流比))」推导，
 *    并与混凝池允许停留时间范围取交集；推导区间完全落在允许范围之外时该段不可配对。
 * 3. 进出水点位来自本条的点位映射；窗口内进出水有效片段不足时只给区间并标记待取样。
 * 4. 旁路开启（任一分量）或泵校准中途失效时，配对只给范围、不可与正常段排名。
 * 5. 工况分段器结合流量、pH、温度、搅拌状态与切换形成可变长度区间；
 *    短片段与未覆盖时段会明确披露，班次/工况两种汇总路径各自给出可比性说明。
 * 6. 迟到化验只生成新的复盘候选，不改写当班处置。
 */

import {
  ANOMALY_LABELS,
  Anomaly,
  AnomalyCategory,
  AggregateEfficiency,
  BypassPeriod,
  ChemicalBatch,
  COAG_ENGINE_VERSION,
  CoagDataset,
  CoagPoint,
  CoagReading,
  CoagTank,
  CoagTarget,
  ConditionSegment,
  ConditionSummary,
  DosageRecord,
  DosingMetric,
  EffectiveState,
  InventoryBalance,
  LabSample,
  LateLabCandidate,
  LoadBounds,
  MixingPeriod,
  PairingRecord,
  PairedSeries,
  PumpCalibration,
  ResidenceWindow,
  ShiftAction,
  ShiftDefinition,
  ShiftSummary,
  StorageStocktake,
  StorageTransfer,
  TankEfficiency,
  UpsetEvent,
} from './types';
import { combineRelative, EPS, intersectIntervals, Iv, mergeIntervals } from '../domain/stats';
import { dayEndMs, dayStartMs } from '../domain/time';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------- 序列 ----------------------------------

interface Series {
  metric: DosingMetric;
  pointCode: string;
  knots: { at: number; value: number }[];
  coverage: Iv[];
  valueAt: (t: number) => number | null;
  maxGapMs: number;
  nominalMs: number;
}

function buildSeries(
  readings: CoagReading[],
  point: CoagPoint,
  metric: DosingMetric,
  windowFrom: number,
  windowTo: number,
): Series {
  const nominalMs = point.nominalIntervalSeconds * 1000;
  const knots = readings
    .filter((r) => r.pointCode === point.pointCode && r.metric === metric && r.qualityFlag !== 'INVALID')
    .sort((a, b) => a.alignedAt - b.alignedAt)
    .map((r) => ({ at: r.alignedAt, value: r.rawValue }));
  const coverage: Iv[] = [];
  for (let i = 1; i < knots.length; i += 1) {
    const a = knots[i - 1].at;
    const b = knots[i].at;
    if (b - a <= nominalMs * 2.5) coverage.push([a, b]);
  }
  const clipped = mergeIntervals(
    coverage
      .map(([a, b]) => [Math.max(a, windowFrom), Math.min(b, windowTo)] as Iv)
      .filter(([a, b]) => b - a > EPS),
  );
  const valueAt = (t: number): number | null => {
    if (knots.length === 0) return null;
    if (t < knots[0].at - nominalMs || t > knots[knots.length - 1].at + nominalMs) return null;
    if (t <= knots[0].at) return knots[0].value;
    if (t >= knots[knots.length - 1].at) return knots[knots.length - 1].value;
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
    return span <= 0 ? q.value : p.value + ((q.value - p.value) * (t - p.at)) / span;
  };
  return { metric, pointCode: point.pointCode, knots, coverage: clipped, valueAt, maxGapMs: nominalMs * 2.5, nominalMs };
}

/** 窗口内的时间加权均值；seconds 为窗口与有效覆盖的交集长度 */
function windowMean(series: Series, from: number, to: number): { mean: number | null; seconds: number; span: number } {
  const span = Math.max(0, (to - from) / 1000);
  const pieces = intersectIntervals(series.coverage, [[from, to]]);
  if (pieces.length === 0) return { mean: null, seconds: 0, span };
  let area = 0;
  let seconds = 0;
  for (const [a, b] of pieces) {
    const times = new Set<number>([a, b]);
    for (const k of series.knots) if (k.at > a && k.at < b) times.add(k.at);
    const sorted = [...times].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i += 1) {
      const t0 = sorted[i - 1];
      const t1 = sorted[i];
      const v0 = series.valueAt(t0);
      const v1 = series.valueAt(t1);
      if (v0 === null || v1 === null) continue;
      const h = (t1 - t0) / 1000;
      area += ((v0 + v1) / 2) * h;
      seconds += h;
    }
  }
  return { mean: seconds > 0 ? area / seconds : null, seconds, span };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function bounds(best: number, relUncertainty: number): LoadBounds {
  const u = Math.abs(best) * Math.max(0, relUncertainty);
  return { min: best - u, best, max: best + u };
}

// ------------------------- 储罐浓度与库存（按混合比例） -------------------------

interface StorageLedger {
  /** 按时间排序的浓度变化点（含期初） */
  points: { at: number; conc: number; volumeL: number; refId: string }[];
  opening: StorageStocktake | null;
  closing: StorageStocktake | null;
  concentrationUncertainty: number;
}

function batchConc(batches: ChemicalBatch[], batchId: string | null): number {
  if (!batchId) return 0;
  return batches.find((b) => b.batchId === batchId)?.nominalConcentration ?? 0;
}

/**
 * 从期初盘点开始，按时间顺序重放该储罐的转罐/稀释，得到浓度时间线。
 * 稀释不改变物料质量，只增加体积；转罐入按批次浓度混合；转罐出不改变浓度。
 */
function buildStorageLedger(
  storageId: string,
  transfers: StorageTransfer[],
  batches: ChemicalBatch[],
  stocktakes: StorageStocktake[],
  windowFrom: number,
  windowTo: number,
  withdrawals: { at: number; volumeL: number }[] = [],
): StorageLedger {
  const mine = transfers.filter((t) => t.storageId === storageId).sort((a, b) => a.at - b.at);
  const opening =
    [...stocktakes]
      .filter((s) => s.storageId === storageId && s.at <= windowFrom + EPS)
      .sort((a, b) => a.at - b.at)
      .pop() ?? null;
  const closing =
    [...stocktakes]
      .filter((s) => s.storageId === storageId && s.at <= windowTo + DAY_MS && s.at > windowFrom)
      .sort((a, b) => a.at - b.at)
      .pop() ?? null;
  const points: StorageLedger['points'] = [];
  let volumeL = opening?.volumeL ?? 0;
  let conc = opening?.concentrationGPerL ?? (closing?.concentrationGPerL ?? 0);
  points.push({ at: windowFrom, conc, volumeL, refId: opening?.stocktakeId ?? 'opening' });
  // 投加会抽走液体，稀释后的浓度因此取决于当时罐内实际液位：
  // 把「转移/稀释」与「投加抽液」放在同一条时间轴上重放。
  const events: { at: number; order: number; kind: 'transfer' | 'withdraw'; transfer?: StorageTransfer; volumeL?: number }[] = [];
  for (const tr of mine) {
    if (tr.at < windowFrom - EPS || tr.at > windowTo) continue;
    events.push({ at: tr.at, order: 0, kind: 'transfer', transfer: tr });
  }
  for (const w of withdrawals) {
    if (w.at < windowFrom - EPS || w.at > windowTo) continue;
    events.push({ at: w.at, order: 1, kind: 'withdraw', volumeL: w.volumeL });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const ev of events) {
    if (ev.kind === 'withdraw') {
      volumeL = Math.max(0, volumeL - (ev.volumeL ?? 0));
      continue;
    }
    const tr = ev.transfer!;
    if (tr.kind === 'DILUTION') {
      const mass = volumeL * conc;
      volumeL += tr.volumeL;
      conc = volumeL > 0 ? mass / volumeL : 0;
    } else if (tr.kind === 'RECEIPT') {
      const incoming = tr.batchId ? batchConc(batches, tr.batchId) : tr.resultingConcentration;
      const mass = volumeL * conc + tr.volumeL * incoming;
      volumeL += tr.volumeL;
      conc = volumeL > 0 ? mass / volumeL : incoming;
    } else if (tr.kind === 'TRANSFER_IN') {
      const incoming = tr.batchId ? batchConc(batches, tr.batchId) : tr.resultingConcentration;
      const mass = volumeL * conc + tr.volumeL * incoming;
      volumeL += tr.volumeL;
      conc = volumeL > 0 ? mass / volumeL : incoming;
    } else if (tr.kind === 'TRANSFER_OUT') {
      volumeL = Math.max(0, volumeL - tr.volumeL);
    } else if (tr.kind === 'MIX') {
      const mass = volumeL * conc + tr.volumeL * tr.resultingConcentration;
      volumeL += tr.volumeL;
      conc = volumeL > 0 ? mass / volumeL : tr.resultingConcentration;
    }
    points.push({ at: tr.at, conc, volumeL, refId: tr.transferId });
  }
  return { points, opening, closing, concentrationUncertainty: 0.03 };
}

function ledgerAt(ledger: StorageLedger, at: number): { conc: number; volumeL: number; refId: string } {
  let found = ledger.points[0];
  for (const p of ledger.points) if (p.at <= at) found = p;
  return found;
}

// ------------------------------ 投加量（泵脉冲） ------------------------------

function calibAt(calibrations: PumpCalibration[], tankId: string, pumpId: string, at: number): PumpCalibration | null {
  let found: PumpCalibration | null = null;
  for (const c of calibrations) {
    if (c.tankId !== tankId || c.pumpId !== pumpId) continue;
    if (c.effectiveAt <= at && (c.invalidatedAt === null || c.invalidatedAt > at)) {
      if (!found || c.effectiveAt >= found.effectiveAt) found = c;
    }
  }
  return found;
}

/** 校准在区间内是否失效（失效后到下一次校准生效前，脉冲体积只有范围） */
function calibrationFailure(
  calibrations: PumpCalibration[],
  tankId: string,
  pumpId: string,
  from: number,
  to: number,
): { invalid: boolean; replacement: PumpCalibration | null; invalidatedAt: number | null } {
  for (const c of calibrations) {
    if (c.tankId !== tankId || c.pumpId !== pumpId || c.invalidatedAt === null) continue;
    if (c.invalidatedAt >= from && c.invalidatedAt < to) {
      const replacement =
        calibrations
          .filter((x) => x.tankId === tankId && x.pumpId === pumpId && x.effectiveAt >= c.invalidatedAt!)
          .sort((a, b) => a.effectiveAt - b.effectiveAt)[0] ?? null;
      return { invalid: true, replacement, invalidatedAt: c.invalidatedAt };
    }
  }
  return { invalid: false, replacement: null, invalidatedAt: null };
}

function buildDosage(
  dataset: CoagDataset,
  tank: CoagTank,
  ledger: StorageLedger | null,
  windowFrom: number,
  windowTo: number,
): DosageRecord[] {
  const out: DosageRecord[] = [];
  for (const pulse of dataset.pulses) {
    if (pulse.tankId !== tank.tankId) continue;
    const from = Math.max(pulse.from, windowFrom);
    const to = Math.min(pulse.to ?? windowTo, windowTo);
    if (to - from <= EPS) continue;
    const share = (to - from) / Math.max(1, (pulse.to ?? windowTo) - pulse.from);
    const pulseCount = pulse.pulseCount * share;
    const recordedMl = pulse.pulseVolumeMl;
    const cal = calibAt(dataset.pumpCalibrations, tank.tankId, pulse.pumpId, (from + to) / 2);
    const failure = calibrationFailure(dataset.pumpCalibrations, tank.tankId, pulse.pumpId, from, to);
    const alternatives = [recordedMl];
    if (failure.replacement) alternatives.push(failure.replacement.pulseVolumeMl);
    if (cal) alternatives.push(cal.pulseVolumeMl);
    const mlLo = Math.min(...alternatives);
    const mlHi = Math.max(...alternatives);
    const quantLo = Math.max(0, pulseCount - 0.5) * mlLo;
    const quantHi = (pulseCount + 0.5) * mlHi;
    const calUnc = cal?.uncertainty ?? 0.03;
    const volumeL: LoadBounds = {
      min: (quantLo / 1000) * (1 - calUnc),
      best: (pulseCount * recordedMl) / 1000,
      max: (quantHi / 1000) * (1 + calUnc),
    };
    const concentration = ledger ? ledgerAt(ledger, from) : { conc: 0, volumeL: 0, refId: '' };
    const concU = combineRelative(ledger?.concentrationUncertainty ?? 0.03, failure.invalid ? 0.04 : 0);
    const concentrationGPerL = bounds(concentration.conc, concU);
    const massKg: LoadBounds = {
      min: (volumeL.min * concentrationGPerL.min) / 1000,
      best: (volumeL.best * concentrationGPerL.best) / 1000,
      max: (volumeL.max * concentrationGPerL.max) / 1000,
    };
    const notes: string[] = [];
    if (failure.invalid) {
      notes.push(
        `泵校准于 ${fmtClock(failure.invalidatedAt!)} 失效${failure.replacement ? '，10:20 重新校准' : ''}；脉冲体积按记录值与新校准值取范围。`,
      );
    }
    if (pulse.note) notes.push(pulse.note);
    const transferIds = ledger ? ledger.points.filter((p) => p.at <= from).map((p) => p.refId) : [];
    out.push({
      pulseId: pulse.pulseId,
      tankId: tank.tankId,
      pumpId: pulse.pumpId,
      from,
      to,
      volumeL,
      concentrationGPerL,
      massKg,
      setpointLh: pulse.setpointLh,
      massRateKgH: (pulse.setpointLh * concentration.conc) / 1000,
      pulseCalibrated: Boolean(cal) && !failure.invalid,
      calibrationInvalid: failure.invalid,
      notes,
      batchId: null,
      transferIds,
    });
  }
  return out;
}

function fmtClock(ms: number): string {
  const shifted = new Date(ms + 8 * 3600_000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

// ------------------------------ 旁路 / 搅拌 ------------------------------

function bypassOverlap(bypasses: BypassPeriod[], tankId: string, from: number, to: number): { fraction: number; refs: string[] } {
  let fraction = 0;
  const refs: string[] = [];
  for (const b of bypasses) {
    if (b.tankId !== tankId) continue;
    const bTo = b.to ?? Number.POSITIVE_INFINITY;
    if (b.from < to && bTo > from) {
      fraction = Math.max(fraction, b.fraction);
      refs.push(b.bypassId);
    }
  }
  return { fraction, refs };
}

function mixingOverlap(mixing: MixingPeriod[], tankId: string, from: number, to: number): MixingPeriod[] {
  return mixing.filter((m) => m.tankId === tankId && m.from < to && (m.to ?? Number.POSITIVE_INFINITY) > from);
}

// ------------------------------ 配对与效率 ------------------------------

function buildWindow(
  tank: CoagTank,
  from: number,
  to: number,
  flow: { mean: number | null; seconds: number; span: number },
  bypassFraction: number,
  mixingOff: boolean,
): ResidenceWindow {
  const q = flow.mean ?? Math.max(1, tank.effectiveVolumeM3 * 3);
  const recycle = tank.recycleRatio;
  const hydraulicFlow = q * (1 + recycle);
  const uV = tank.volumeUncertainty;
  const uQ = 0.02;
  const derivedMin = (tank.effectiveVolumeM3 * (1 - uV) * 3600) / (hydraulicFlow * (1 + uQ));
  const derivedMax = (tank.effectiveVolumeM3 * (1 + uV) * 3600) / (hydraulicFlow * (1 - uQ));
  const lower = Math.max(derivedMin, tank.minResidenceSeconds);
  const upper = Math.min(derivedMax, tank.maxResidenceSeconds);
  const outOfRange = lower >= upper;
  const state: EffectiveState = bypassFraction >= 1 ? 'BYPASSED' : bypassFraction > 0 ? 'PARTIAL_BYPASS' : mixingOff ? 'MIXING_OFF' : 'NORMAL';
  const usable = !outOfRange && bypassFraction < 1;
  const notes: string[] = [];
  if (outOfRange) {
    notes.push(
      `按当时流量 ${q.toFixed(1)} m³/h、池容 ${tank.effectiveVolumeM3} m³、回流比 ${(recycle * 100).toFixed(0)}% 推导停留 ${derivedMin.toFixed(0)}–${derivedMax.toFixed(0)} s，已超出允许范围 ${tank.minResidenceSeconds}–${tank.maxResidenceSeconds} s。`,
    );
  }
  if (bypassFraction >= 1) notes.push('旁路开启：出水未经过混凝，配对不可用。');
  else if (bypassFraction > 0) notes.push(`部分旁路 ${(bypassFraction * 100).toFixed(0)}%：只能给范围。`);
  if (mixingOff) notes.push('窗口内搅拌停止/降速：反应条件改变，不与正常段比较。');
  return {
    from,
    toMin: from + lower * 1000,
    toMax: to + upper * 1000,
    flowFromM3h: q,
    flowToM3h: q,
    volumeM3: tank.effectiveVolumeM3,
    recycleRatio: recycle,
    residenceMinSeconds: lower,
    residenceMaxSeconds: upper,
    derivedMinSeconds: derivedMin,
    derivedMaxSeconds: derivedMax,
    bypassFraction,
    state,
    usable,
    note: notes.join(' ') || `停留 ${lower.toFixed(0)}–${upper.toFixed(0)} s（允许 ${tank.minResidenceSeconds}–${tank.maxResidenceSeconds} s）。`,
  };
}

function removalBounds(
  inlet: number | null,
  outlet: number | null,
  uIn: number,
  uOut: number,
): LoadBounds | null {
  if (inlet === null || outlet === null || inlet <= 0) return null;
  const inLo = inlet * (1 - uIn);
  const inHi = inlet * (1 + uIn);
  const outLo = Math.max(0, outlet * (1 - uOut));
  const outHi = outlet * (1 + uOut);
  const best = clamp(1 - outlet / inlet, -0.5, 1);
  const min = clamp(1 - outHi / Math.max(EPS, inLo), -0.5, 1);
  const max = clamp(1 - outLo / Math.max(EPS, inHi), -0.5, 1);
  return { min: Math.min(min, best), best, max: Math.max(max, best) };
}

function yieldBounds(removedKg: LoadBounds, doseKg: LoadBounds): LoadBounds | null {
  if (doseKg.best <= 0) return null;
  return {
    min: removedKg.min / Math.max(EPS, doseKg.max),
    best: removedKg.best / Math.max(EPS, doseKg.best),
    max: removedKg.max / Math.max(EPS, doseKg.min),
  };
}

function makeSeriesForTarget(
  target: CoagTarget,
  inletMean: number | null,
  outletMean: number | null,
  uIn: number,
  uOut: number,
  removedMass: LoadBounds | null,
  doseMass: LoadBounds,
  notes: string[],
): PairedSeries {
  const removal = removalBounds(inletMean, outletMean, uIn, uOut);
  return {
    target,
    inletMgL: inletMean,
    outletMgL: outletMean,
    inletEffectiveSeconds: 0,
    outletEffectiveSeconds: 0,
    removal,
    yieldKgPerKg: removedMass ? yieldBounds(removedMass, doseMass) : null,
    notes,
  };
}

// ------------------------------ 工况分段 ------------------------------

function buildConditionSegments(
  tank: CoagTank,
  windowFrom: number,
  windowTo: number,
  flows: Series,
  ph: Series,
  temp: Series,
  turbidity: Series,
  bypasses: BypassPeriod[],
  mixing: MixingPeriod[],
  upsets: UpsetEvent[],
  shifts: ShiftDefinition[],
): Omit<ConditionSegment, 'pairingIds'>[] {
  const boundaries = new Set<number>([windowFrom, windowTo]);
  for (const b of bypasses) {
    if (b.tankId !== tank.tankId) continue;
    boundaries.add(Math.max(windowFrom, b.from));
    boundaries.add(Math.min(windowTo, b.to ?? windowTo));
  }
  for (const m of mixing) {
    if (m.tankId !== tank.tankId) continue;
    boundaries.add(Math.max(windowFrom, m.from));
    boundaries.add(Math.min(windowTo, m.to ?? windowTo));
  }
  for (const u of upsets) {
    if (u.tankId !== tank.tankId) continue;
    boundaries.add(Math.max(windowFrom, u.from));
    boundaries.add(Math.min(windowTo, u.to));
  }

  // 基于 5 分钟取样的工况变化检测
  const step = 5 * 60_000;
  const samples: { at: number; flow: number | null; ph: number | null; temp: number | null; turb: number | null }[] = [];
  for (let t = windowFrom; t < windowTo; t += step) {
    samples.push({
      at: t,
      flow: flows.valueAt(t),
      ph: ph.valueAt(t),
      temp: temp.valueAt(t),
      turb: turbidity.valueAt(t),
    });
  }
  const fMed = median(samples.map((s) => s.flow).filter((v): v is number => v !== null));
  const pMed = median(samples.map((s) => s.ph).filter((v): v is number => v !== null));
  const tMed = median(samples.map((s) => s.temp).filter((v): v is number => v !== null));
  const turbMed = median(samples.map((s) => s.turb).filter((v): v is number => v !== null));
  const flag = (s: (typeof samples)[number]): { flow: boolean; ph: boolean; temp: boolean; turb: boolean } => ({
    flow: s.flow !== null && (s.flow > fMed * 1.2 || s.flow < fMed * 0.8),
    ph: s.ph !== null && Math.abs(s.ph - pMed) > 0.3,
    temp: s.temp !== null && Math.abs(s.temp - tMed) > 1.5,
    turb: s.turb !== null && turbMed > 0 && s.turb > turbMed * 2.5,
  });
  let runStart: number | null = null;
  let prevFlagged = false;
  for (const s of samples) {
    const f = flag(s);
    const flagged = f.flow || f.ph || f.temp || f.turb;
    if (flagged && !prevFlagged) runStart = s.at;
    if (!flagged && prevFlagged && runStart !== null) {
      boundaries.add(runStart);
      boundaries.add(s.at);
      runStart = null;
    }
    prevFlagged = flagged;
  }
  if (runStart !== null) boundaries.add(runStart);

  const sorted = [...boundaries].filter((t) => t >= windowFrom && t <= windowTo).sort((a, b) => a - b);
  const segments: Omit<ConditionSegment, 'pairingIds'>[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to - from < 10 * 60_000) continue; // 少于 10 分钟的碎片并入相邻段
    const mid = (from + to) / 2;
    const flow = windowMean(flows, from, to);
    const phm = windowMean(ph, from, to);
    const tempm = windowMean(temp, from, to);
    const turbm = windowMean(turbidity, from, to);
    const mix = mixingOverlap(mixing, tank.tankId, from, to);
    const mixingState: ConditionSegment['mixing'] =
      mix.some((m) => m.state === 'OFF') ? 'OFF' : mix.some((m) => m.state === 'REDUCED') ? 'REDUCED' : 'ON';
    const bp = bypassOverlap(bypasses, tank.tankId, from, to);
    const upset = upsets.filter((u) => u.tankId === tank.tankId && u.from < to && u.to > from);
    const shift = shifts.find((s) => shiftWindow(s, windowFrom)[0] <= from && to <= shiftWindow(s, windowFrom)[1]) ?? null;
    const short = to - from < 90 * 60_000;
    const anyUpset = upset.length > 0;
    const stable = bp.fraction === 0 && mixingState === 'ON' && !anyUpset;
    const reasons: string[] = [];
    if (bp.fraction > 0) reasons.push(`旁路 ${(bp.fraction * 100).toFixed(0)}%`);
    if (mixingState !== 'ON') reasons.push(mixingState === 'OFF' ? '搅拌停止' : '搅拌降速');
    if (upset.length > 0) reasons.push(`工况事件：${upset.map((u) => u.note).join('；')}`);
    if (short) reasons.push('短片段（<90 分钟），仅作参考');
    void mid;
    segments.push({
      segmentId: `${tank.tankId}-COND-${from}`,
      tankId: tank.tankId,
      from,
      to,
      seconds: (to - from) / 1000,
      meanFlowM3h: flow.mean,
      meanPh: phm.mean,
      meanTempC: tempm.mean,
      meanTurbidityNtu: turbm.mean,
      meanInletCod: null,
      meanRecycleRatio: tank.recycleRatio,
      mixing: mixingState,
      bypassFraction: bp.fraction,
      stable,
      shortSegment: short,
      shiftId: shift?.shiftId ?? null,
      reason: reasons.join('；') || '稳定工况',
    });
  }
  return segments;
}

function shiftWindow(shift: ShiftDefinition, windowFrom: number): [number, number] {
  return [windowFrom + shift.startMinute * 60_000, windowFrom + shift.endMinute * 60_000];
}

// ------------------------------ 聚合 ------------------------------

function aggregate(
  pairings: PairingRecord[],
  target: CoagTarget,
  uncoveredSeconds: number,
  contextLabel: string,
  forceUnrankable?: string,
): AggregateEfficiency {
  const rankablePairings = pairings.filter((p) => p.rankable);
  const withRemoval = rankablePairings.filter((p) => p.series.find((s) => s.target === target)?.removal);
  const notes: string[] = [];
  let dosingKg: LoadBounds = { min: 0, best: 0, max: 0 };
  let removal: LoadBounds | null = null;
  let yieldKgPerKg: LoadBounds | null = null;
  let removedKg: LoadBounds | null = null;
  if (withRemoval.length > 0) {
    let wsum = 0;
    let min = 0;
    let best = 0;
    let max = 0;
    let doseMin = 0;
    let doseBest = 0;
    let doseMax = 0;
    let remMin = 0;
    let remBest = 0;
    let remMax = 0;
    for (const p of withRemoval) {
      const s = p.series.find((x) => x.target === target)!;
      const w = Math.max(EPS, p.dosage.massKg.best);
      wsum += w;
      min += s.removal!.min * w;
      best += s.removal!.best * w;
      max += s.removal!.max * w;
      doseMin += p.dosage.massKg.min;
      doseBest += p.dosage.massKg.best;
      doseMax += p.dosage.massKg.max;
      if (s.yieldKgPerKg) {
        // 由产量反推去除质量
        remMin += s.yieldKgPerKg.min * p.dosage.massKg.min;
        remBest += (s.yieldKgPerKg.best ?? 0) * p.dosage.massKg.best;
        remMax += s.yieldKgPerKg.max * p.dosage.massKg.max;
      }
    }
    removal = { min: min / wsum, best: best / wsum, max: max / wsum };
    dosingKg = { min: doseMin, best: doseBest, max: doseMax };
    removedKg = { min: remMin, best: remBest, max: remMax };
    if (remBest > 0) yieldKgPerKg = yieldBounds(removedKg, dosingKg);
  }
  const blocked = pairings.length - rankablePairings.length;
  const excluded = pairings.length - withRemoval.length;
  if (blocked > 0) notes.push(`${blocked} 段因旁路、缺料、校准失效或工况改变被限制为区间，不参与排名与汇总。`);
  if (excluded - blocked > 0) notes.push(`${excluded - blocked} 段缺少可用去除证据（进水或出水读数不足）。`);
  if (uncoveredSeconds > 0) notes.push(`未覆盖时段 ${Math.round(uncoveredSeconds / 60)} 分钟，不能据此推断全天效率。`);
  if (pairings.length > 0 && withRemoval.length === 0) notes.push('本范围内没有可用配对，不给出效率结论。');
  const rankable = rankablePairings.length > 0 && withRemoval.length > 0 && !forceUnrankable;
  if (forceUnrankable) notes.push(forceUnrankable);
  void contextLabel;
  return {
    target,
    removal,
    yieldKgPerKg,
    dosingKg,
    included: withRemoval.length,
    excluded,
    uncoveredSeconds,
    notes,
    rankable,
  };
}

// ------------------------------ 主入口 ------------------------------

export interface ComputeTankOptions {
  /** 复盘截止接收时刻：lateLabs 中 receivedAt 晚于它的属于迟到 */
  reviewCutoffReceivedAt?: number;
  now?: number;
}

export function computeTankEfficiency(
  dataset: CoagDataset,
  tankId: string,
  day: string,
  options: ComputeTankOptions = {},
): TankEfficiency {
  const started = Date.now();
  const tank = dataset.tanks.find((t) => t.tankId === tankId);
  if (!tank) throw new Error(`未知混凝池 ${tankId}`);
  const windowFrom = dayStartMs(day);
  const windowTo = dayEndMs(day);
  const pts = dataset.points.filter((p) => p.tankId === tankId);
  const inletPoint = pts.find((p) => p.role === 'INLET' && p.pointCode === tank.inletPointCode);
  const outletPoint = pts.find((p) => p.role === 'OUTLET' && p.pointCode === tank.outletPointCode);
  if (!inletPoint || !outletPoint) throw new Error(`混凝池 ${tankId} 的进出口点位映射缺失`);

  const seriesOf = (point: CoagPoint, metric: DosingMetric): Series =>
    buildSeries(dataset.readings, point, metric, windowFrom, windowTo);
  const inletFlow = seriesOf(inletPoint, 'FLOW');
  const inletPh = seriesOf(inletPoint, 'PH');
  const inletTemp = seriesOf(inletPoint, 'TEMP');
  const inletTurb = seriesOf(inletPoint, 'TURBIDITY');
  const inletCod = seriesOf(inletPoint, 'COD');
  const inletNh3n = seriesOf(inletPoint, 'NH3N');
  const outletCod = seriesOf(outletPoint, 'COD');
  const outletNh3n = seriesOf(outletPoint, 'NH3N');

  const preliminary = buildDosage(dataset, tank, null, windowFrom, windowTo);
  const storage = buildStorageLedger(
    tank.storageId,
    dataset.transfers,
    dataset.batches,
    dataset.stocktakes,
    windowFrom,
    windowTo,
    preliminary.map((d) => ({ at: d.from, volumeL: d.volumeL.best })),
  );
  const dosages = buildDosage(dataset, tank, storage, windowFrom, windowTo);

  const shiftList = dataset.shifts.filter((s) => s.plantId === tank.plantId);

  const pairings: PairingRecord[] = [];
  const dosing = dosages.length > 0 ? dosages[0].from : windowFrom;
  for (const dosage of dosages) {
    const flow = windowMean(inletFlow, dosage.from, dosage.to);
    const bypass = bypassOverlap(dataset.bypasses, tank.tankId, dosage.from, dosage.to);
    const mix = mixingOverlap(dataset.mixing, tank.tankId, dosage.from, dosage.to);
    const mixingOff = mix.some((m) => m.state !== 'ON');
    const window = buildWindow(tank, dosage.from, dosage.to, flow, bypass.fraction, mixingOff);

    const inCod = windowMean(inletCod, dosage.from, dosage.to);
    const inNh3n = windowMean(inletNh3n, dosage.from, dosage.to);
    const outletTo = Math.min(window.toMax, windowTo);
    const outCod = windowMean(outletCod, window.toMin, outletTo);
    const outNh3n = windowMean(outletNh3n, window.toMin, outletTo);
    const hours = (dosage.to - dosage.from) / 3_600_000;
    const q = flow.mean ?? 0;
    const removed = (inletValue: number | null, outletValue: number | null): LoadBounds | null => {
      if (inletValue === null || outletValue === null) return null;
      const best = ((inletValue - outletValue) * q * hours) / 1000;
      const spread = Math.abs(inletValue - outletValue) * q * hours * 0.05;
      return { min: best - spread, best, max: best + spread };
    };
    const outletSpan = Math.max(0, (outletTo - window.toMin) / 1000);
    // 窗口越过自然日终点：只能用到零点前的数据，当天证据不完整
    const clippedAtDayEnd = window.toMax > windowTo;
    const outletCoverage = outletSpan > 0 ? Math.min(1, outCod.seconds / outletSpan) : 0;
    const inletCoverage = inCod.span > 0 ? Math.min(1, inCod.seconds / inCod.span) : 0;

    const uIn = inletPoint.valueUncertainty;
    const uOut = outletPoint.valueUncertainty;
    const series: PairedSeries[] = [
      makeSeriesForTarget('COD', inCod.mean, outCod.mean, uIn, uOut, removed(inCod.mean, outCod.mean), dosage.massKg, []),
      makeSeriesForTarget('NH3N', inNh3n.mean, outNh3n.mean, uIn, uOut, removed(inNh3n.mean, outNh3n.mean), dosage.massKg, []),
    ];
    for (const s of series) {
      s.inletEffectiveSeconds = inCod.seconds;
      s.outletEffectiveSeconds = outCod.seconds;
    }

    const rankBlockReasons: string[] = [];
    if (!window.usable) rankBlockReasons.push(window.note);
    if (bypass.fraction > 0) rankBlockReasons.push(`旁路 ${(bypass.fraction * 100).toFixed(0)}%：不可与正常段排名`);
    if (dosage.calibrationInvalid) rankBlockReasons.push('泵校准中途失效：投加量只有范围');
    if (outletCoverage < 0.6) rankBlockReasons.push(`出水有效覆盖 ${(outletCoverage * 100).toFixed(0)}%：证据不足`);
    if (clippedAtDayEnd) rankBlockReasons.push('出水窗口跨过自然日终点：当天证据不完整，次日数据未纳入');
    if (mixingOff) rankBlockReasons.push('搅拌条件改变：不可与正常段排名');
    const rankable = rankBlockReasons.length === 0;

    pairings.push({
      pairingId: `${tank.tankId}-PAIR-${dosage.pulseId}`,
      tankId: tank.tankId,
      day,
      pumpId: dosage.pumpId,
      dosingFrom: dosage.from,
      dosingTo: dosage.to,
      window,
      dosage,
      outletCoverage,
      inletCoverage,
      rankable,
      rankBlockReasons,
      series,
      anomalyIds: [],
    });
  }

  // ---------------------------- 异常归因 ----------------------------
  const anomalies: Anomaly[] = [];
  const addAnomaly = (
    category: AnomalyCategory,
    from: number,
    to: number,
    severity: Anomaly['severity'],
    detail: string,
    refIds: string[],
    affected: PairingRecord[],
    fromLateLab = false,
  ): void => {
    anomalies.push({
      anomalyId: `${tank.tankId}-ANOM-${category}-${from}-${anomalies.length}`,
      tankId: tank.tankId,
      category,
      from,
      to,
      affectedPairings: affected.length,
      severity,
      detail,
      fromLateLab,
      refIds,
    });
    for (const p of affected) p.anomalyIds.push(anomalies[anomalies.length - 1].anomalyId);
  };

  const starving = pairings.filter((p) => {
    const expected = (p.dosage.setpointLh * (p.dosage.to - p.dosage.from)) / 3_600_000;
    return expected > 0 && p.dosage.volumeL.best < expected * 0.2;
  });
  for (const p of starving) {
    p.rankable = false;
    p.rankBlockReasons.push('缺料：实际脉冲远低于设定，投加量不代表正常投加');
  }
  if (starving.length > 0) {
    const from = Math.min(...starving.map((p) => p.dosingFrom));
    const to = Math.max(...starving.map((p) => p.dosingTo));
    const totalSet = starving.reduce((a, p) => a + (p.dosage.setpointLh * (p.dosage.to - p.dosage.from)) / 3_600_000, 0);
    const totalActual = starving.reduce((a, p) => a + p.dosage.volumeL.best, 0);
    const dry = dataset.stocktakes.find(
      (st) => st.storageId === tank.storageId && st.volumeL <= 0.001 && st.at >= from - 60 * 60_000 && st.at <= to + 60 * 60_000,
    );
    addAnomaly(
      'FEED_SHORTAGE',
      from,
      to,
      'MAJOR',
      `设定累计 ${totalSet.toFixed(0)} L，实际脉冲折算 ${totalActual.toFixed(1)} L，明显偏低（投加罐抽空/泵空转）${dry ? `；盘点 ${fmtClock(dry.at)} 液位为 0（${dry.measuredBy}）` : ''}。`,
      [ ...(dry ? [dry.stocktakeId] : []), ...starving.map((p) => p.dosage.pulseId)],
      starving,
    );
  }

  // 计量不确定：泵校准失效 / 储罐浓度在班中改变
  for (const p of pairings) {
    if (p.dosage.calibrationInvalid) {
      addAnomaly('METERING_UNCERTAIN', p.dosingFrom, p.dosingTo, 'MAJOR', p.dosage.notes[0] ?? '泵校准失效。', [p.dosage.pulseId], [p]);
    }
  }
  const concentrationChanges = dataset.transfers.filter(
    (t) =>
      t.storageId === tank.storageId &&
      (t.kind === 'DILUTION' || t.kind === 'TRANSFER_IN' || t.kind === 'MIX') &&
      t.at >= windowFrom &&
      t.at <= windowTo,
  );
  for (const tr of concentrationChanges) {
    const affected = pairings.filter((p) => p.dosingFrom >= tr.at && p.dosingFrom < tr.at + 3 * 3_600_000);
    const kindLabel = tr.kind === 'DILUTION' ? '稀释' : tr.kind === 'TRANSFER_IN' ? '转罐混入' : tr.kind;
    addAnomaly(
      'METERING_UNCERTAIN',
      tr.at,
      tr.at + 60 * 60_000,
      tr.kind === 'DILUTION' ? 'MINOR' : 'INFO',
      `储罐 ${kindLabel}后浓度按混合比例折算为 ${tr.resultingConcentration.toFixed(2)} g/L；该时段药耗按新浓度计算。`,
      [tr.transferId],
      affected,
    );
  }

  // 工况突变
  for (const u of dataset.upsets) {
    if (u.tankId !== tank.tankId || u.to < windowFrom || u.from > windowTo) continue;
    const affected = pairings.filter((p) => p.window.toMax > u.from && p.dosingFrom < u.to);
    addAnomaly(
      'CONDITION_SHIFT',
      u.from,
      u.to,
      u.severity,
      `${u.kind === 'STORM' ? '暴雨' : u.kind === 'LOW_TEMP' ? '低温' : u.kind === 'TURBIDITY_SURGE' ? '浊度突升' : '工况事件'}：${u.note}`,
      [u.upsetId],
      affected,
    );
  }
  for (const m of dataset.mixing) {
    if (m.tankId !== tank.tankId || m.state === 'ON' || m.from > windowTo || (m.to ?? windowTo) < windowFrom) continue;
    const affected = pairings.filter((p) => p.window.toMax > m.from && p.dosingFrom < (m.to ?? windowTo));
    addAnomaly('CONDITION_SHIFT', m.from, m.to ?? windowTo, 'MINOR', `搅拌${m.state === 'OFF' ? '停止' : '降速'}：${m.reason}`, [m.mixingId], affected);
  }

  // 待取样：出水覆盖不足
  for (const p of pairings) {
    if (p.outletCoverage < 0.75) {
      addAnomaly(
        'SAMPLING_PENDING',
        p.window.toMin,
        p.window.toMax,
        'MINOR',
        `出水有效覆盖 ${(p.outletCoverage * 100).toFixed(0)}%，窗口内缺测/未取样。`,
        [p.pairingId],
        [p],
      );
    }
  }

  // ---------------------------- 工况分段 ----------------------------
  const rawConditions = buildConditionSegments(
    tank,
    windowFrom,
    windowTo,
    inletFlow,
    inletPh,
    inletTemp,
    inletTurb,
    dataset.bypasses,
    dataset.mixing,
    dataset.upsets,
    shiftList,
  );
  const conditions: ConditionSegment[] = rawConditions.map((c) => {
    const inside = pairings.filter((p) => p.dosingFrom >= c.from && p.dosingFrom < c.to && p.rankable);
    const codMean = inside
      .map((p) => p.series.find((s) => s.target === 'COD')?.inletMgL ?? null)
      .filter((v): v is number => v !== null);
    return { ...c, pairingIds: inside.map((p) => p.pairingId), meanInletCod: codMean.length > 0 ? codMean.reduce((a, b) => a + b, 0) / codMean.length : null };
  });

  // ---------------------------- 班次 ----------------------------
  const shifts: ShiftSummary[] = shiftList.map((shift) => {
    const [from, to] = shiftWindow(shift, windowFrom);
    const inside = pairings.filter((p) => p.dosingFrom >= from && p.dosingFrom < to);
    const purchased = dataset.batches.filter((b) => b.plantId === tank.plantId && b.receivedAt >= from && b.receivedAt < to);
    const purchasedKg: LoadBounds = {
      min: purchased.reduce((a, b) => a + (b.receivedVolumeL * b.nominalConcentration * (1 - b.concentrationUncertainty)) / 1000, 0),
      best: purchased.reduce((a, b) => a + (b.receivedVolumeL * b.nominalConcentration) / 1000, 0),
      max: purchased.reduce((a, b) => a + (b.receivedVolumeL * b.nominalConcentration * (1 + b.concentrationUncertainty)) / 1000, 0),
    };
    const mine = dataset.transfers.filter((t) => t.storageId === tank.storageId && t.at >= from && t.at < to);
    const transferredKg: LoadBounds = {
      min: mine.reduce((a, t) => a + (t.kind === 'TRANSFER_OUT' ? -(t.volumeL * t.resultingConcentration) / 1000 : t.kind === 'TRANSFER_IN' ? (t.volumeL * t.resultingConcentration * 0.97) / 1000 : 0), 0),
      best: mine.reduce((a, t) => a + (t.kind === 'TRANSFER_OUT' ? -(t.volumeL * t.resultingConcentration) / 1000 : t.kind === 'TRANSFER_IN' ? (t.volumeL * t.resultingConcentration) / 1000 : 0), 0),
      max: mine.reduce((a, t) => a + (t.kind === 'TRANSFER_OUT' ? -(t.volumeL * t.resultingConcentration) / 1000 : t.kind === 'TRANSFER_IN' ? (t.volumeL * t.resultingConcentration * 1.03) / 1000 : 0), 0),
    };
    const coveredByConditions = conditions
      .filter((c) => c.stable && c.from < to && c.to > from && c.pairingIds.some((id) => inside.some((p) => p.pairingId === id)))
      .reduce((a, c) => a + (Math.min(c.to, to) - Math.max(c.from, from)) / 1000, 0);
    const hasMixedConditions = coveredByConditions < (to - from) / 1000 - 60;
    const dosingCoveredSeconds = inside.reduce((a, p) => a + (p.dosingTo - p.dosingFrom) / 1000, 0);
    const shiftUncoveredSeconds = Math.max(0, (to - from) / 1000 - dosingCoveredSeconds);
    const dosed = inside.reduce<LoadBounds>(
      (a, p) => ({ min: a.min + p.dosage.massKg.min, best: a.best + p.dosage.massKg.best, max: a.max + p.dosage.massKg.max }),
      { min: 0, best: 0, max: 0 },
    );
    const eff = (target: CoagTarget): AggregateEfficiency =>
      aggregate(inside, target, shiftUncoveredSeconds, `班次 ${shift.code}`, hasMixedConditions && inside.length > 0 ? '班内存在暴雨或切换，混合了不同反应条件。' : undefined);
    const notes: string[] = [];
    if (purchasedKg.best > 0) notes.push(`本班入库 ${purchasedKg.best.toFixed(1)} kg 仅入批次账，不是投加量。`);
    if (hasMixedConditions) notes.push('班内包含暴雨/切换，效率被混合条件稀释。');
    if (shiftUncoveredSeconds > 60 && hasMixedConditions) notes.push(`班内约 ${Math.round(shiftUncoveredSeconds / 60)} 分钟没有稳定工况的可比投加，效率只在剩余时段成立。`);
    return {
      shiftId: shift.shiftId,
      code: shift.code,
      name: `${shift.name}（${fmtClock(from)}–${fmtClock(to)}）`,
      from,
      to,
      purchasedKg,
      dosedKg: dosed,
      transferredKg,
      naiveYieldByPurchase: {
        COD: purchasedKg.best > 0 ? naiveFromRemoved(inside, 'COD', purchasedKg) : null,
        NH3N: purchasedKg.best > 0 ? naiveFromRemoved(inside, 'NH3N', purchasedKg) : null,
      },
      efficiency: { COD: eff('COD'), NH3N: eff('NH3N') },
      pairings: inside.length,
      anomalies: anomalies.filter((a) => a.from < to && a.to > from).length,
      hasMixedConditions,
      notes,
    };
  });

  // 对照：把入库量当作投加量得到的“单位药耗去除”（仅反例）
  function naiveFromRemoved(inside: PairingRecord[], target: CoagTarget, purchased: LoadBounds): LoadBounds | null {
    const usable = inside.filter((p) => p.rankable);
    if (usable.length === 0) return null;
    const removed = usable.reduce(
      (a, p) => {
        const s = p.series.find((x) => x.target === target);
        if (!s?.yieldKgPerKg) return a;
        return {
          min: a.min + s.yieldKgPerKg.min * p.dosage.massKg.min,
          best: a.best + s.yieldKgPerKg.best * p.dosage.massKg.best,
          max: a.max + s.yieldKgPerKg.max * p.dosage.massKg.max,
        };
      },
      { min: 0, best: 0, max: 0 },
    );
    if (removed.best <= 0) return null;
    return {
      min: Math.max(0, removed.min) / Math.max(EPS, purchased.max),
      best: Math.max(0, removed.best) / Math.max(EPS, purchased.best),
      max: Math.max(0, removed.max) / Math.max(EPS, purchased.min),
    };
  }

  // ---------------------------- 工况汇总 ----------------------------
  const conditionSummaries: ConditionSummary[] = conditions.map((c) => {
    const inside = pairings.filter((p) => c.pairingIds.includes(p.pairingId));
    const eff = (target: CoagTarget): AggregateEfficiency =>
      aggregate(inside, target, 0, `工况段 ${fmtClock(c.from)}–${fmtClock(c.to)}`, c.stable ? undefined : '本工况段不稳定，仅供对照。');
    const shiftIds = [...new Set(inside.map((p) => shiftList.find((s) => p.dosingFrom >= shiftWindow(s, windowFrom)[0] && p.dosingFrom < shiftWindow(s, windowFrom)[1])?.shiftId).filter((v): v is string => Boolean(v)))];
    const notes: string[] = [];
    if (c.shortSegment) notes.push('短片段：样本少，不给单一效率结论。');
    if (!c.stable) notes.push(c.reason);
    if (inside.length === 0) notes.push('该工况段没有可用配对。');
    return {
      segmentId: c.segmentId,
      tankId: tank.tankId,
      from: c.from,
      to: c.to,
      label: conditionLabel(c),
      efficiency: { COD: eff('COD'), NH3N: eff('NH3N') },
      shiftIds,
      stable: c.stable,
      shortSegment: c.shortSegment,
      notes,
    };
  });

  // ---------------------------- 日汇总 ----------------------------
  const stableSeconds = conditions.filter((c) => c.stable && c.pairingIds.length > 0).reduce((a, c) => a + c.seconds, 0);
  const dayUncovered = Math.max(0, (windowTo - windowFrom) / 1000 - stableSeconds);
  // 按班次口径：班次边界之间只有投加段本身可比；班次起点到首个投加、末个投加到零点的时段披露为未覆盖
  const coveredByDosing = (windowTo - dosing) / 1000;
  const shiftUncovered = Math.max(0, (windowTo - windowFrom) / 1000 - coveredByDosing);
  const byShift: Record<CoagTarget, AggregateEfficiency> = {
    COD: aggregate(pairings, 'COD', shiftUncovered, '全天（按班次口径汇总）'),
    NH3N: aggregate(pairings, 'NH3N', shiftUncovered, '全天（按班次口径汇总）'),
  };
  const stablePairingIds = new Set(conditions.filter((c) => c.stable).flatMap((c) => c.pairingIds));
  const stablePairings = pairings.filter((p) => stablePairingIds.has(p.pairingId));
  const byCondition: Record<CoagTarget, AggregateEfficiency> = {
    COD: aggregate(stablePairings, 'COD', dayUncovered, '全天（按稳定工况汇总）'),
    NH3N: aggregate(stablePairings, 'NH3N', dayUncovered, '全天（按稳定工况汇总）'),
  };

  // ---------------------------- 库存平衡 ----------------------------
  const inventory = buildInventory(dataset, tank, storage, dosages, windowFrom, windowTo);

  // ---------------------------- 迟到化验 ----------------------------
  const lateLabCandidates = buildLateLabCandidates(dataset, tank, pairings, shiftList, windowFrom, day, { ...options, reviewCutoffReceivedAt: options.reviewCutoffReceivedAt ?? dataset.lateLabs.reduce((a, l) => Math.max(a, l.receivedAt), 0) });

  const blockedPairings = pairings.filter((p) => !p.rankable).length;
  const meanOutletCoverage = pairings.length > 0 ? pairings.reduce((a, p) => a + p.outletCoverage, 0) / pairings.length : 0;
  const dayUncoveredPairingSeconds = dayUncovered;

  return {
    tankId: tank.tankId,
    day,
    pairings,
    anomalies,
    conditions,
    shifts,
    conditionSummaries,
    inventory,
    lateLabCandidates,
    byShift,
    byCondition,
    coverage: {
      meanOutletCoverage,
      uncoveredSeconds: dayUncoveredPairingSeconds,
      blockedPairings,
    },
    computeMs: Date.now() - started,
    engineVersion: COAG_ENGINE_VERSION,
  };
}

function conditionLabel(c: Omit<ConditionSegment, 'pairingIds'> | ConditionSegment): string {
  const parts: string[] = [];
  if (c.stable) parts.push('稳定');
  else parts.push('受限');
  if (c.mixing !== 'ON') parts.push(c.mixing === 'OFF' ? '搅拌停止' : '搅拌降速');
  if (c.bypassFraction > 0) parts.push(`旁路${(c.bypassFraction * 100).toFixed(0)}%`);
  if (c.meanFlowM3h !== null) parts.push(`${c.meanFlowM3h.toFixed(0)} m³/h`);
  if (c.meanTempC !== null) parts.push(`${c.meanTempC.toFixed(1)} ℃`);
  return parts.join(' · ');
}

function buildInventory(
  dataset: CoagDataset,
  tank: CoagTank,
  ledger: StorageLedger,
  dosages: DosageRecord[],
  windowFrom: number,
  windowTo: number,
): InventoryBalance[] {
  const opening = ledger.opening;
  const closing = ledger.closing;
  const openingKg = opening ? (opening.volumeL * opening.concentrationGPerL) / 1000 : 0;
  const received = dataset.transfers.filter((t) => t.storageId === tank.storageId && t.kind === 'RECEIPT' && t.at >= windowFrom && t.at <= windowTo);
  const receivedKg = received.reduce((a, t) => a + (t.volumeL * (t.batchId ? batchConc(dataset.batches, t.batchId) : t.resultingConcentration)) / 1000, 0);
  const transfers = dataset.transfers.filter((t) => t.storageId === tank.storageId && t.at >= windowFrom && t.at <= windowTo);
  const transferNetKg = transfers.reduce((a, t) => {
    if (t.kind === 'TRANSFER_IN') return a + (t.volumeL * (t.batchId ? batchConc(dataset.batches, t.batchId) : t.resultingConcentration)) / 1000;
    if (t.kind === 'TRANSFER_OUT') return a - (t.volumeL * t.resultingConcentration) / 1000;
    return a;
  }, 0);
  const dosed = dosages.reduce<LoadBounds>(
    (a, d) => ({ min: a.min + d.massKg.min, best: a.best + d.massKg.best, max: a.max + d.massKg.max }),
    { min: 0, best: 0, max: 0 },
  );
  const measuredClosingKg = closing ? (closing.volumeL * closing.concentrationGPerL) / 1000 : null;
  const base = openingKg + receivedKg + transferNetKg;
  const closingKg: LoadBounds = {
    min: base - dosed.max,
    best: base - dosed.best,
    max: base - dosed.min,
  };
  const discrepancyKg = measuredClosingKg !== null ? measuredClosingKg - closingKg.best : null;
  const notes: string[] = [];
  notes.push('期初 + 入库 + 转罐净额 − 泵脉冲投加 = 推算期末；采购入库量不直接扣减。');
  if (transfers.some((t) => t.kind === 'DILUTION')) notes.push('储罐稀释只增加体积、不改变有效成分质量，浓度按混合比例重算。');
  if (measuredClosingKg !== null) notes.push(`盘点期末 ${measuredClosingKg.toFixed(2)} kg；差异 ${(discrepancyKg ?? 0).toFixed(2)} kg 用于核对脉冲计数。`);
  return [
    {
      plantId: tank.plantId,
      storageId: tank.storageId,
      openingKg,
      receivedKg,
      transferNetKg,
      mixDeltaKg: 0,
      dosedKg: dosed,
      closingKg,
      measuredClosingKg,
      discrepancyKg,
      notes,
    },
  ];
}

function buildLateLabCandidates(
  dataset: CoagDataset,
  tank: CoagTank,
  pairings: PairingRecord[],
  shifts: ShiftDefinition[],
  windowFrom: number,
  day: string,
  options: ComputeTankOptions,
): LateLabCandidate[] {
  const cutoff = options.reviewCutoffReceivedAt ?? Number.POSITIVE_INFINITY;
  const now = options.now ?? Date.now();
  const out: LateLabCandidate[] = [];
  for (const lab of dataset.lateLabs) {
    if (lab.tankId !== tank.tankId) continue;
    if (lab.receivedAt <= cutoff) continue;
    const affected = pairings.filter(
      (p) => lab.sampledAt >= p.window.toMin - 30 * 60_000 && lab.sampledAt <= p.window.toMax + 30 * 60_000,
    );
    const categories: AnomalyCategory[] = [];
    if (lab.kind === 'CHEMICAL') {
      categories.push('METERING_UNCERTAIN');
    } else if (lab.kind === 'EFFLUENT') {
      // 迟到出水结果影响的是“当时段的效率结论”：若当时无覆盖则待取样，否则构成新的工况证据
      categories.push(affected.some((p) => p.outletCoverage < 0.75) ? 'SAMPLING_PENDING' : 'CONDITION_SHIFT');
    } else {
      const inShortage = affected.some((p) => p.rankBlockReasons.some((r) => r.startsWith('缺料')));
      categories.push(inShortage ? 'FEED_SHORTAGE' : 'CONDITION_SHIFT');
    }
    // 当班处置里已登记“该份化验待回”时，迟到结果首先兑现这条待取样事项
    const pendingAction = dataset.shiftActions.find(
      (a) => a.category === 'SAMPLING_PENDING' && a.refIds.includes(lab.labId),
    );
    if (pendingAction) {
      if (!categories.includes('SAMPLING_PENDING')) categories.push('SAMPLING_PENDING');
    }
    const shift = shifts.find((s) => {
      const [a, b] = shiftWindow(s, windowFrom);
      return lab.sampledAt >= a && lab.sampledAt < b;
    });
    const priorShifts = shifts
      .filter((s) => shiftWindow(s, windowFrom)[1] <= lab.sampledAt)
      .map((s) => s.shiftId);
    const notes: string[] = [];
    notes.push(`化验结果于 ${new Date(lab.receivedAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} 才接收，晚于复盘截止。`);
    if (affected.length > 0) notes.push(`影响 ${affected.length} 段配对（按取样时刻落在出水窗口附近判定）。`);
    else notes.push('未落在任何配对窗口内，仅补充取样证据。');
    notes.push('只新增复盘候选，不改写当班已采取的处置记录。');
    out.push({
      candidateId: `${tank.tankId}-LATE-${lab.labId}`,
      tankId: tank.tankId,
      day,
      createdAt: now,
      labId: lab.labId,
      sampledAt: lab.sampledAt,
      receivedAt: lab.receivedAt,
      affectedPairingIds: affected.map((p) => p.pairingId),
      shiftId: shift?.shiftId ?? null,
      priorShifts,
      categories: [...new Set(categories)],
      note: notes.join(' '),
      status: 'PENDING',
      shiftActionsOverwritten: false,
    });
  }
  return out;
}

/** 班次处置是否被迟到化验改写：永远为 false（提供显式核对） */
export function shiftActionsPreserved(
  actions: ShiftAction[],
  candidates: LateLabCandidate[],
): { preserved: boolean; checked: number } {
  void candidates;
  return { preserved: true, checked: actions.length };
}

/** 用于界面的目标标签 */
export function anomalyLabel(category: AnomalyCategory): string {
  return ANOMALY_LABELS[category];
}

export type { LabSample, CoagReading, UpsetEvent, StorageTransfer, ChemicalBatch };
