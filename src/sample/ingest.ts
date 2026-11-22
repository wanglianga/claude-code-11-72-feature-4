/**
 * 接入层：CSV → 账本实体 → 数据集
 *
 * 台账（厂站/点位/仪表/绑定/校准/状态）均可从对应 CSV 导入；读数文件按 instrument_id 归属，
 * 并以仪表实例台账的时钟偏移把 sampled_at 换算为 alignedAt，再确定自然日。
 * 文件指纹由 WebCrypto 计算（SHA-256），作为接入账主键的一部分。
 */

import {
  Binding,
  Calibration,
  Dataset,
  FileKind,
  Instrument,
  IntakeFile,
  OutfallPoint,
  Plant,
  Reading,
  ScopeOptions,
  StatePeriod,
} from '../domain/types';
import { parseCsv, parseIso, parseIsoOrNull } from './csv';
import { dayKeyFromMs } from '../domain/time';

export interface IngestResult {
  dataset: Dataset;
  readings: Reading[];
  files: IntakeFile[];
  accepted: number;
  rejected: number;
  errors: string[];
  warnings: string[];
}

function num(value: string, field: string, errors: string[], row: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    errors.push(`第 ${row} 行 ${field} 不是有效数字：${value}`);
    return 0;
  }
  return n;
}

export function parsePlants(text: string, fileId: string): { plants: Plant[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const plants: Plant[] = rows.map((row, i) => ({
    plantId: row.plant_id,
    name: row.name,
    shortName: row.short_name || row.name,
    timezone: row.timezone || 'Asia/Shanghai',
    dischargeStandard: {
      COD: num(row.cod_limit, 'cod_limit', errors, i + 2),
      NH3N: num(row.nh3n_limit, 'nh3n_limit', errors, i + 2),
    },
  }));
  void fileId;
  return { plants, errors };
}

export function parsePoints(text: string): { points: OutfallPoint[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const points: OutfallPoint[] = rows.map((row, i) => ({
    pointCode: row.point_code,
    plantId: row.plant_id,
    name: row.name,
    reused: row.reused === 'true' || row.reused === '1',
    designFlowM3h: num(row.design_flow_m3h, 'design_flow_m3h', errors, i + 2),
    note: row.note ?? '',
  }));
  return { points, errors };
}

export function parseInstruments(text: string): { instruments: Instrument[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const instruments: Instrument[] = rows.map((row, i) => {
    let installedAt = 0;
    try {
      installedAt = parseIso(row.installed_at);
    } catch (e) {
      errors.push(`第 ${i + 2} 行 installed_at 无法解析：${(e as Error).message}`);
    }
    let removedAt: number | null = null;
    try {
      removedAt = parseIsoOrNull(row.removed_at);
    } catch (e) {
      errors.push(`第 ${i + 2} 行 removed_at 无法解析：${(e as Error).message}`);
    }
    return {
      instrumentId: row.instrument_id,
      pointCode: row.point_code,
      plantId: row.plant_id,
      kind: row.kind === 'FLOW' ? 'FLOW' : 'CONCENTRATION',
      metric: (row.metric as Instrument['metric']) ?? (row.kind === 'FLOW' ? 'FLOW' : 'COD'),
      model: row.model,
      serial: row.serial,
      scale: Number(row.scale || 1),
      offset: Number(row.offset || 0),
      valueUncertainty: Number(row.value_uncertainty || 0.02),
      nominalIntervalSeconds: Number(row.nominal_interval_seconds || 60),
      installedAt,
      removedAt,
      clockOffsetMs: Number(row.clock_offset_ms || 0),
      clockOffsetUncertaintyMs: Number(row.clock_offset_uncertainty_ms || 0),
      note: row.note ?? '',
    };
  });
  return { instruments, errors };
}

export function parseBindings(text: string): { bindings: Binding[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const bindings: Binding[] = rows.map((row, i) => {
    let from = 0;
    let to: number | null = null;
    try {
      from = parseIso(row.from);
      to = parseIsoOrNull(row.to);
    } catch (e) {
      errors.push(`第 ${i + 2} 行绑定有效期无法解析：${(e as Error).message}`);
    }
    return {
      bindingId: row.binding_id,
      pointCode: row.point_code,
      instrumentId: row.instrument_id,
      metric: row.metric as Binding['metric'],
      from,
      to,
    };
  });
  return { bindings, errors };
}

export function parseCalibrations(text: string): { calibrations: Calibration[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const calibrations: Calibration[] = rows.map((row, i) => {
    let effectiveAt = 0;
    try {
      effectiveAt = parseIso(row.effective_at);
    } catch (e) {
      errors.push(`第 ${i + 2} 行 effective_at 无法解析：${(e as Error).message}`);
    }
    return {
      calibrationId: row.calibration_id,
      instrumentId: row.instrument_id,
      effectiveAt,
      scale: num(row.scale, 'scale', errors, i + 2),
      offset: num(row.offset, 'offset', errors, i + 2),
      coefficientUncertainty: num(row.coefficient_uncertainty, 'coefficient_uncertainty', errors, i + 2),
      operator: row.operator ?? '',
      certificate: row.certificate ?? '',
      note: row.note ?? '',
    };
  });
  return { calibrations, errors };
}

export function parseStates(text: string): { states: StatePeriod[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const states: StatePeriod[] = rows.map((row, i) => {
    let from = 0;
    let to: number | null = null;
    try {
      from = parseIso(row.from);
      to = parseIsoOrNull(row.to);
    } catch (e) {
      errors.push(`第 ${i + 2} 行状态有效期无法解析：${(e as Error).message}`);
    }
    return {
      stateId: row.state_id,
      instrumentId: row.instrument_id,
      state: row.state as StatePeriod['state'],
      from,
      to,
      reason: row.reason ?? '',
      workOrder: row.work_order ?? '',
    };
  });
  return { states, errors };
}

export interface ParsedReadings {
  readings: Reading[];
  errors: string[];
  rejected: number;
}

/** 读数解析：依赖已入库的仪表台账（时钟校正、归属）与绑定（点位/厂站） */
export function parseReadings(
  text: string,
  file: { fileId: string; kind: FileKind; receivedAt: number },
  instruments: Instrument[],
  bindings: Binding[],
  options: { lateMode?: boolean } = {},
): ParsedReadings {
  const { rows, headers } = parseCsv(text);
  const errors: string[] = [];
  const readings: Reading[] = [];
  let rejected = 0;
  const instById = new Map(instruments.map((i) => [i.instrumentId, i]));
  const bindingByInstrument = new Map(bindings.map((b) => [b.instrumentId, b]));
  const required = ['reading_id', 'instrument_id', 'metric', 'sampled_at', 'raw_value'];
  for (const h of required) {
    if (!headers.includes(h)) {
      return { readings: [], errors: [`文件缺少必需列 ${h}`], rejected: rows.length };
    }
  }
  rows.forEach((row, idx) => {
    const line = idx + 2;
    const inst = instById.get(row.instrument_id);
    if (!inst) {
      rejected += 1;
      errors.push(`第 ${line} 行仪表 ${row.instrument_id} 未在设备履历中登记，拒绝入库`);
      return;
    }
    const binding = bindingByInstrument.get(row.instrument_id);
    if (!binding) {
      rejected += 1;
      errors.push(`第 ${line} 行仪表 ${row.instrument_id} 没有点位绑定，拒绝入库`);
      return;
    }
    let sampledAt = 0;
    try {
      sampledAt = parseIso(row.sampled_at);
    } catch (e) {
      rejected += 1;
      errors.push(`第 ${line} 行 sampled_at：${(e as Error).message}`);
      return;
    }
    const rawValue = Number(row.raw_value);
    if (!Number.isFinite(rawValue)) {
      rejected += 1;
      errors.push(`第 ${line} 行 raw_value 不是有效数字`);
      return;
    }
    const alignedAt = sampledAt + inst.clockOffsetMs;
    const dayKey = dayKeyFromMs(alignedAt);
    const flag = (row.quality_flag || 'VALID').toUpperCase();
    const qualityFlag: Reading['qualityFlag'] =
      flag === 'SUSPECT' ? 'SUSPECT' : flag === 'INVALID' ? 'INVALID' : 'VALID';
    readings.push({
      readingId: row.reading_id || `auto-${file.fileId}-${line}`,
      pointCode: binding.pointCode,
      plantId: inst.plantId,
      instrumentId: inst.instrumentId,
      metric: (row.metric as Reading['metric']) ?? binding.metric,
      sampledAt,
      alignedAt,
      dayKey,
      receivedAt: row.received_at ? parseIso(row.received_at) : file.receivedAt,
      rawValue,
      qualityFlag,
      sourceFileId: file.fileId,
      sourceRow: line,
      rawText: undefined,
    });
    if (options.lateMode && row.received_at) {
      // 迟到文件仍以文件接收时刻为准进行“迟到”判断，避免旧文件伪造接收时间
      readings[readings.length - 1].receivedAt = file.receivedAt;
    }
  });
  return { readings, errors, rejected };
}

export function emptyDataset(): Dataset {
  return {
    plants: [],
    points: [],
    instruments: [],
    calibrations: [],
    states: [],
    bindings: [],
    readings: [],
    files: [],
  };
}

export function mergeDataset(base: Dataset, patch: Partial<Dataset>, options: { dedupeReadings?: boolean } = {}): Dataset {
  const dedupe = options.dedupeReadings !== false;
  const readings = dedupe ? uniqueReadings([...base.readings, ...(patch.readings ?? [])]) : [...base.readings, ...(patch.readings ?? [])];
  return {
    plants: mergeBy(base.plants, patch.plants ?? [], (p) => p.plantId),
    points: mergeBy(base.points, patch.points ?? [], (p) => p.pointCode),
    instruments: mergeBy(base.instruments, patch.instruments ?? [], (i) => i.instrumentId),
    calibrations: mergeBy(base.calibrations, patch.calibrations ?? [], (c) => c.calibrationId),
    states: mergeBy(base.states, patch.states ?? [], (s) => s.stateId),
    bindings: mergeBy(base.bindings, patch.bindings ?? [], (b) => b.bindingId),
    readings,
    files: mergeBy(base.files, patch.files ?? [], (f) => f.fileId),
  };
}

function mergeBy<T>(base: T[], patch: T[], key: (item: T) => string): T[] {
  const map = new Map(base.map((i) => [key(i), i]));
  for (const item of patch) map.set(key(item), item);
  return [...map.values()];
}

export function uniqueReadings(readings: Reading[]): Reading[] {
  const map = new Map<string, Reading>();
  for (const r of readings) {
    const existing = map.get(r.readingId);
    if (!existing || r.receivedAt >= existing.receivedAt) map.set(r.readingId, r);
  }
  return [...map.values()];
}

export interface ExpectedCounts {
  points: number;
  instruments: number;
  calibrations: number;
  states: number;
  bindings: number;
  readings: number;
}

export function datasetCounts(dataset: Dataset): ExpectedCounts {
  return {
    points: dataset.points.length,
    instruments: dataset.instruments.length,
    calibrations: dataset.calibrations.length,
    states: dataset.states.length,
    bindings: dataset.bindings.length,
    readings: dataset.readings.length,
  };
}

/** 覆盖判断所需的读数总量（按点位与日） */
export function readingsFor(dataset: Dataset, pointCode: string, day: string): Reading[] {
  return dataset.readings.filter((r) => r.pointCode === pointCode && r.dayKey === day);
}

export function latestReceivedAt(dataset: Dataset): number {
  return dataset.readings.reduce((acc, r) => Math.max(acc, r.receivedAt), 0);
}

export type { ScopeOptions };
