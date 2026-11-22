/**
 * 混凝剂投加：CSV 解析（浏览器导入与 Node 核验共用同一解析器）
 *
 * 每张表都保留来源文件与行号，便于复盘追溯；时间列统一按带时区 ISO 解析，
 * 读数另按点位台账的传感器时间偏移换算为 alignedAt。
 */

import { parseCsv, parseIso } from '../sample/csv';
import { dayKeyFromMs } from '../domain/time';
import type {
  BypassDirection,
  BypassPeriod,
  ChemicalBatch,
  CoagDataset,
  CoagManifest,
  CoagPlant,
  CoagPoint,
  CoagReading,
  CoagTank,
  ConditionSegment,
  DosingMetric,
  DosingPulse,
  LabSample,
  MixingPeriod,
  PumpCalibration,
  ShiftAction,
  ShiftDefinition,
  StorageStocktake,
  StorageTank,
  StorageTransfer,
  StorageTransferKind,
  UpsetEvent,
} from './types';

export interface ParseIssue {
  file: string;
  row: number;
  message: string;
}

function n(value: string | undefined, field: string, file: string, row: number, issues: ParseIssue[]): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    issues.push({ file, row, message: `${field} 不是有效数字：${value ?? ''}` });
    return 0;
  }
  return parsed;
}

function t(value: string, field: string, file: string, row: number, issues: ParseIssue[]): number {
  try {
    return parseIso(value);
  } catch (error) {
    issues.push({ file, row, message: `${field} 无法解析：${(error as Error).message}` });
    return 0;
  }
}

function tn(value: string, field: string, file: string, row: number, issues: ParseIssue[]): number | null {
  if (!value || value.trim() === '') return null;
  try {
    return parseIso(value);
  } catch (error) {
    issues.push({ file, row, message: `${field} 无法解析：${(error as Error).message}` });
    return null;
  }
}

export function emptyCoagDataset(): CoagDataset {
  return {
    plants: [],
    tanks: [],
    points: [],
    readings: [],
    bypasses: [],
    mixing: [],
    upsets: [],
    batches: [],
    storageTanks: [],
    transfers: [],
    stocktakes: [],
    pulses: [],
    pumpCalibrations: [],
    labs: [],
    shifts: [],
    shiftActions: [],
    lateLabs: [],
  };
}

export function parseCoagPlants(text: string): CoagPlant[] {
  return parseCsv(text).rows.map((row) => ({
    plantId: row.plant_id,
    name: row.name,
    shortName: row.short_name || row.name,
  }));
}

export function parseTanks(text: string, file: string, issues: ParseIssue[]): CoagTank[] {
  return parseCsv(text).rows.map((row, i) => ({
    tankId: row.tank_id,
    plantId: row.plant_id,
    name: row.name,
    effectiveVolumeM3: n(row.effective_volume_m3, 'effective_volume_m3', file, i + 2, issues),
    minResidenceSeconds: n(row.min_residence_s, 'min_residence_s', file, i + 2, issues),
    maxResidenceSeconds: n(row.max_residence_s, 'max_residence_s', file, i + 2, issues),
    recycleRatio: n(row.recycle_ratio, 'recycle_ratio', file, i + 2, issues),
    inletPointCode: row.inlet_point_code,
    outletPointCode: row.outlet_point_code,
    volumeUncertainty: n(row.volume_uncertainty, 'volume_uncertainty', file, i + 2, issues),
    storageId: row.storage_id,
    note: row.note ?? '',
  }));
}

export function parsePoints(text: string, file: string, issues: ParseIssue[]): CoagPoint[] {
  return parseCsv(text).rows.map((row, i) => ({
    pointCode: row.point_code,
    tankId: row.tank_id,
    plantId: row.plant_id,
    role: row.role === 'OUTLET' ? 'OUTLET' : 'INLET',
    name: row.name,
    metrics: (row.metrics || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean) as DosingMetric[],
    clockOffsetMs: n(row.clock_offset_ms, 'clock_offset_ms', file, i + 2, issues),
    clockOffsetUncertaintyMs: n(row.clock_offset_uncertainty_ms, 'clock_offset_uncertainty_ms', file, i + 2, issues),
    nominalIntervalSeconds: n(row.nominal_interval_seconds, 'nominal_interval_seconds', file, i + 2, issues),
    valueUncertainty: n(row.value_uncertainty, 'value_uncertainty', file, i + 2, issues),
    note: row.note ?? '',
  }));
}

export function parseCoagReadings(
  text: string,
  file: string,
  fileId: string,
  points: CoagPoint[],
  issues: ParseIssue[],
): CoagReading[] {
  const pointById = new Map(points.map((p) => [p.pointCode, p]));
  const readings: CoagReading[] = [];
  parseCsv(text).rows.forEach((row, i) => {
    const line = i + 2;
    const point = pointById.get(row.point_code);
    if (!point) {
      issues.push({ file, row: line, message: `点位 ${row.point_code} 未登记，拒绝入库` });
      return;
    }
    const sampledAt = t(row.sampled_at, 'sampled_at', file, line, issues);
    if (!sampledAt) return;
    const rawValue = Number(row.raw_value);
    if (!Number.isFinite(rawValue)) {
      issues.push({ file, row: line, message: `raw_value 不是有效数字` });
      return;
    }
    const alignedAt = sampledAt + point.clockOffsetMs;
    const flag = (row.quality_flag || 'VALID').toUpperCase();
    readings.push({
      readingId: row.reading_id || `${fileId}-${line}`,
      pointCode: point.pointCode,
      plantId: point.plantId,
      tankId: point.tankId,
      role: point.role,
      metric: row.metric as DosingMetric,
      sampledAt,
      alignedAt,
      receivedAt: row.received_at ? t(row.received_at, 'received_at', file, line, issues) : sampledAt,
      dayKey: dayKeyFromMs(alignedAt),
      rawValue,
      qualityFlag: flag === 'SUSPECT' ? 'SUSPECT' : flag === 'INVALID' ? 'INVALID' : 'VALID',
      sourceFileId: fileId,
      sourceRow: line,
    });
  });
  return readings;
}

export function parseBypasses(text: string, file: string, issues: ParseIssue[]): BypassPeriod[] {
  return parseCsv(text).rows.map((row, i) => ({
    bypassId: row.bypass_id,
    tankId: row.tank_id,
    from: t(row.from, 'from', file, i + 2, issues),
    to: tn(row.to, 'to', file, i + 2, issues),
    direction: (row.direction === 'INLET' || row.direction === 'BOTH' ? row.direction : 'OUTLET') as BypassDirection,
    fraction: n(row.fraction, 'fraction', file, i + 2, issues),
    reason: row.reason ?? '',
    workOrder: row.work_order ?? '',
    recordedBy: row.recorded_by ?? '',
  }));
}

export function parseMixing(text: string, file: string, issues: ParseIssue[]): MixingPeriod[] {
  return parseCsv(text).rows.map((row, i) => ({
    mixingId: row.mixing_id,
    tankId: row.tank_id,
    from: t(row.from, 'from', file, i + 2, issues),
    to: tn(row.to, 'to', file, i + 2, issues),
    state: (row.state === 'OFF' ? 'OFF' : row.state === 'REDUCED' ? 'REDUCED' : 'ON') as MixingPeriod['state'],
    reason: row.reason ?? '',
    workOrder: row.work_order ?? '',
  }));
}

export function parseUpsets(text: string, file: string, issues: ParseIssue[]): UpsetEvent[] {
  return parseCsv(text).rows.map((row, i) => ({
    upsetId: row.upset_id,
    tankId: row.tank_id,
    from: t(row.from, 'from', file, i + 2, issues),
    to: t(row.to, 'to', file, i + 2, issues),
    kind: row.kind as UpsetEvent['kind'],
    severity: (row.severity === 'MINOR' || row.severity === 'MAJOR' ? row.severity : 'INFO') as UpsetEvent['severity'],
    note: row.note ?? '',
  }));
}

export function parseBatches(text: string, file: string, issues: ParseIssue[]): ChemicalBatch[] {
  return parseCsv(text).rows.map((row, i) => ({
    batchId: row.batch_id,
    plantId: row.plant_id,
    productName: row.product_name,
    nominalConcentration: n(row.nominal_concentration, 'nominal_concentration', file, i + 2, issues),
    concentrationUncertainty: n(row.concentration_uncertainty, 'concentration_uncertainty', file, i + 2, issues),
    manufacturedAt: t(row.manufactured_at, 'manufactured_at', file, i + 2, issues),
    receivedAt: t(row.received_at, 'received_at', file, i + 2, issues),
    receivedVolumeL: n(row.received_volume_l, 'received_volume_l', file, i + 2, issues),
    supplier: row.supplier ?? '',
    certificate: row.certificate ?? '',
    note: row.note ?? '',
  }));
}

export function parseStorageTanks(text: string, file: string, issues: ParseIssue[]): StorageTank[] {
  return parseCsv(text).rows.map((row, i) => ({
    storageId: row.storage_id,
    plantId: row.plant_id,
    name: row.name,
    capacityL: n(row.capacity_l, 'capacity_l', file, i + 2, issues),
    note: row.note ?? '',
  }));
}

export function parseTransfers(text: string, file: string, issues: ParseIssue[]): StorageTransfer[] {
  return parseCsv(text).rows.map((row, i) => ({
    transferId: row.transfer_id,
    plantId: row.plant_id,
    storageId: row.storage_id,
    kind: row.kind as StorageTransferKind,
    at: t(row.at, 'at', file, i + 2, issues),
    batchId: row.batch_id ? row.batch_id : null,
    volumeL: n(row.volume_l, 'volume_l', file, i + 2, issues),
    resultingConcentration: n(row.resulting_concentration, 'resulting_concentration', file, i + 2, issues),
    note: row.note ?? '',
    recordedBy: row.recorded_by ?? '',
  }));
}

export function parseStocktakes(text: string, file: string, issues: ParseIssue[]): StorageStocktake[] {
  return parseCsv(text).rows.map((row, i) => ({
    stocktakeId: row.stocktake_id,
    storageId: row.storage_id,
    at: t(row.at, 'at', file, i + 2, issues),
    volumeL: n(row.volume_l, 'volume_l', file, i + 2, issues),
    concentrationGPerL: n(row.concentration_g_per_l, 'concentration_g_per_l', file, i + 2, issues),
    measuredBy: row.measured_by ?? '',
  }));
}

export function parsePulses(text: string, file: string, issues: ParseIssue[]): DosingPulse[] {
  return parseCsv(text).rows.map((row, i) => ({
    pulseId: row.pulse_id,
    tankId: row.tank_id,
    pumpId: row.pump_id,
    from: t(row.from, 'from', file, i + 2, issues),
    to: tn(row.to, 'to', file, i + 2, issues),
    setpointLh: n(row.setpoint_lh, 'setpoint_lh', file, i + 2, issues),
    pulseVolumeMl: n(row.pulse_volume_ml, 'pulse_volume_ml', file, i + 2, issues),
    pulseCount: n(row.pulse_count, 'pulse_count', file, i + 2, issues),
    averageFlowM3h: n(row.average_flow_m3h, 'average_flow_m3h', file, i + 2, issues),
    note: row.note ?? '',
  }));
}

export function parsePumpCalibrations(text: string, file: string, issues: ParseIssue[]): PumpCalibration[] {
  return parseCsv(text).rows.map((row, i) => ({
    pumpCalibrationId: row.pump_calibration_id,
    tankId: row.tank_id,
    pumpId: row.pump_id,
    effectiveAt: t(row.effective_at, 'effective_at', file, i + 2, issues),
    invalidatedAt: tn(row.invalidated_at, 'invalidated_at', file, i + 2, issues),
    pulseVolumeMl: n(row.pulse_volume_ml, 'pulse_volume_ml', file, i + 2, issues),
    uncertainty: n(row.uncertainty, 'uncertainty', file, i + 2, issues),
    operator: row.operator ?? '',
    certificate: row.certificate ?? '',
    note: row.note ?? '',
  }));
}

export function parseLabs(text: string, file: string, issues: ParseIssue[]): LabSample[] {
  return parseCsv(text).rows.map((row, i) => ({
    labId: row.lab_id,
    tankId: row.tank_id,
    pointCode: row.point_code,
    kind: row.kind as LabSample['kind'],
    sampledAt: t(row.sampled_at, 'sampled_at', file, i + 2, issues),
    receivedAt: t(row.received_at, 'received_at', file, i + 2, issues),
    codMgL: row.cod_mg_l ? n(row.cod_mg_l, 'cod_mg_l', file, i + 2, issues) : null,
    nh3nMgL: row.nh3n_mg_l ? n(row.nh3n_mg_l, 'nh3n_mg_l', file, i + 2, issues) : null,
    turbidityNtu: row.turbidity_ntu ? n(row.turbidity_ntu, 'turbidity_ntu', file, i + 2, issues) : null,
    chemicalConcentrationGPerL: row.chemical_concentration_g_per_l
      ? n(row.chemical_concentration_g_per_l, 'chemical_concentration_g_per_l', file, i + 2, issues)
      : null,
    uncertainty: n(row.uncertainty, 'uncertainty', file, i + 2, issues),
    labName: row.lab_name ?? '',
    note: row.note ?? '',
  }));
}

export function parseShifts(text: string, file: string, issues: ParseIssue[]): ShiftDefinition[] {
  return parseCsv(text).rows.map((row, i) => ({
    shiftId: row.shift_id,
    plantId: row.plant_id,
    code: row.code,
    name: row.name,
    startMinute: n(row.start_minute, 'start_minute', file, i + 2, issues),
    endMinute: n(row.end_minute, 'end_minute', file, i + 2, issues),
  }));
}

export function parseShiftActions(text: string, file: string, issues: ParseIssue[]): ShiftAction[] {
  return parseCsv(text).rows.map((row, i) => ({
    actionId: row.action_id,
    shiftId: row.shift_id,
    plantId: row.plant_id,
    at: t(row.at, 'at', file, i + 2, issues),
    recordedBy: row.recorded_by ?? '',
    category: row.category as ShiftAction['category'],
    text: row.text ?? '',
    refIds: (row.ref_ids || '').split(';').map((s) => s.trim()).filter(Boolean),
  }));
}

export function mergeCoagDataset(base: CoagDataset, patch: Partial<CoagDataset>): CoagDataset {
  const mergeById = <T>(a: T[], b: T[] | undefined, key: (x: T) => string): T[] => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((x) => [key(x), x]));
    for (const x of b) map.set(key(x), x);
    return [...map.values()];
  };
  return {
    plants: mergeById(base.plants, patch.plants, (x) => x.plantId),
    tanks: mergeById(base.tanks, patch.tanks, (x) => x.tankId),
    points: mergeById(base.points, patch.points, (x) => x.pointCode),
    readings: mergeById(base.readings, patch.readings, (x) => x.readingId),
    bypasses: mergeById(base.bypasses, patch.bypasses, (x) => x.bypassId),
    mixing: mergeById(base.mixing, patch.mixing, (x) => x.mixingId),
    upsets: mergeById(base.upsets, patch.upsets, (x) => x.upsetId),
    batches: mergeById(base.batches, patch.batches, (x) => x.batchId),
    storageTanks: mergeById(base.storageTanks, patch.storageTanks, (x) => x.storageId),
    transfers: mergeById(base.transfers, patch.transfers, (x) => x.transferId),
    stocktakes: mergeById(base.stocktakes, patch.stocktakes, (x) => x.stocktakeId),
    pulses: mergeById(base.pulses, patch.pulses, (x) => x.pulseId),
    pumpCalibrations: mergeById(base.pumpCalibrations, patch.pumpCalibrations, (x) => x.pumpCalibrationId),
    labs: mergeById(base.labs, patch.labs, (x) => x.labId),
    shifts: mergeById(base.shifts, patch.shifts, (x) => x.shiftId),
    shiftActions: mergeById(base.shiftActions, patch.shiftActions, (x) => x.actionId),
    lateLabs: mergeById(base.lateLabs, patch.lateLabs, (x) => x.labId),
  };
}

export interface CoagParseBundle {
  dataset: CoagDataset;
  issues: ParseIssue[];
  /** 每份文件的接收时刻（用于迟到判定） */
  fileReceivedAt: Record<string, number>;
}

/** 按 manifest 的顺序解析全部基础文件；缺表按空表处理 */
export function parseCoagBundle(
  manifest: CoagManifest,
  read: (fileName: string) => string,
  shaFor: (fileName: string) => string,
): CoagParseBundle {
  const issues: ParseIssue[] = [];
  const dataset = emptyCoagDataset();
  const fileReceivedAt: Record<string, number> = {};
  for (const meta of manifest.baseFiles) {
    const text = read(meta.fileName);
    const fileId = `file:${meta.fileName}:${shaFor(meta.fileName).slice(0, 16)}`;
    fileReceivedAt[meta.fileName] = meta.receivedAt;
    switch (meta.kind) {
      case 'PLANTS':
        dataset.plants.push(...parseCoagPlants(text));
        break;
      case 'TANKS':
        dataset.tanks.push(...parseTanks(text, meta.fileName, issues));
        break;
      case 'POINTS':
        dataset.points.push(...parsePoints(text, meta.fileName, issues));
        break;
      case 'READINGS':
        dataset.readings.push(...parseCoagReadings(text, meta.fileName, fileId, dataset.points, issues));
        break;
      case 'BYPASS':
        dataset.bypasses.push(...parseBypasses(text, meta.fileName, issues));
        break;
      case 'MIXING':
        dataset.mixing.push(...parseMixing(text, meta.fileName, issues));
        break;
      case 'UPSETS':
        dataset.upsets.push(...parseUpsets(text, meta.fileName, issues));
        break;
      case 'BATCHES':
        dataset.batches.push(...parseBatches(text, meta.fileName, issues));
        break;
      case 'STORAGE':
        dataset.storageTanks.push(...parseStorageTanks(text, meta.fileName, issues));
        break;
      case 'TRANSFERS':
        dataset.transfers.push(...parseTransfers(text, meta.fileName, issues));
        break;
      case 'STOCKTAKES':
        dataset.stocktakes.push(...parseStocktakes(text, meta.fileName, issues));
        break;
      case 'PULSES':
        dataset.pulses.push(...parsePulses(text, meta.fileName, issues));
        break;
      case 'PUMP_CALIBRATIONS':
        dataset.pumpCalibrations.push(...parsePumpCalibrations(text, meta.fileName, issues));
        break;
      case 'LABS':
        dataset.labs.push(...parseLabs(text, meta.fileName, issues));
        break;
      case 'SHIFTS':
        dataset.shifts.push(...parseShifts(text, meta.fileName, issues));
        break;
      case 'SHIFT_ACTIONS':
        dataset.shiftActions.push(...parseShiftActions(text, meta.fileName, issues));
        break;
      default:
        issues.push({ file: meta.fileName, row: 0, message: `未知文件类型 ${meta.kind}` });
    }
  }
  return { dataset, issues, fileReceivedAt };
}

/** 读取迟到化验批次（单独导入） */
export function parseLateLabs(
  manifest: CoagManifest,
  read: (fileName: string) => string,
  shaFor: (fileName: string) => string,
): { labs: LabSample[]; issues: ParseIssue[]; sha: string; receivedAt: number } {
  const issues: ParseIssue[] = [];
  if (!manifest.lateFile) return { labs: [], issues, sha: '', receivedAt: 0 };
  const meta = manifest.lateFile;
  const text = read(meta.fileName);
  return {
    labs: parseLabs(text, meta.fileName, issues),
    issues,
    sha: shaFor(meta.fileName),
    receivedAt: meta.receivedAt,
  };
}

/** 供界面显示：某储罐在某时刻的有效浓度（按最近一次转移/混合记录） */
export function concentrationAt(transfers: StorageTransfer[], storageId: string, at: number): StorageTransfer | null {
  let found: StorageTransfer | null = null;
  for (const tr of transfers) {
    if (tr.storageId !== storageId) continue;
    if (tr.at <= at && (!found || tr.at >= found.at)) found = tr;
  }
  return found;
}

export type { ConditionSegment };
