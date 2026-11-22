/**
 * Node 侧样例装载：直接读 CSV 并复用浏览器同一套解析器（src/sample/ingest.ts）。
 * 用于 verify-sample 与单元测试，确保“脚本核验”和“界面导入”走同一条解析路径。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  mergeDataset,
  parseBindings,
  parseCalibrations,
  parseInstruments,
  parsePlants,
  parsePoints,
  parseReadings,
  parseStates,
} from '../src/sample/ingest';
import type { Dataset, Reading, SampleManifest } from '../src/domain/types';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function parseSampleFromDisk(dir: string, manifest: SampleManifest): {
  baseDataset: Dataset;
  lateReadings: Reading[];
  fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[];
} {
  let dataset: Dataset = {
    plants: [],
    points: [],
    instruments: [],
    calibrations: [],
    states: [],
    bindings: [],
    readings: [],
    files: [],
  };
  const fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[] = [];
  const read = (name: string) => readFileSync(resolve(dir, name), 'utf8');
  const sha = (name: string) => sha256File(resolve(dir, name));

  for (const meta of manifest.baseFiles) {
    const text = read(meta.fileName);
    const actual = sha(meta.fileName);
    fingerprints.push({ fileName: meta.fileName, expected: meta.sha256, actual, ok: actual === meta.sha256 });
    const fileId = `file:${meta.fileName}:${actual.slice(0, 16)}`;
    const file = {
      fileId,
      fileName: meta.fileName,
      sha256: actual,
      sizeBytes: Buffer.byteLength(text),
      kind: meta.kind,
      receivedAt: Date.parse(meta.receivedAt),
      rowCount: meta.rowCount,
      acceptedRows: meta.rowCount,
      rejectedRows: 0,
      rejectedReasons: [] as string[],
      note: meta.note,
      ingestedAt: Date.now(),
      ingestedBy: '核验脚本',
      sample: true,
    };
    if (meta.kind === 'PLANT_REGISTER') {
      const p = parsePlants(text, fileId);
      dataset = mergeDataset(dataset, { plants: p.plants, files: [file] });
    } else if (meta.kind === 'POINT_REGISTER') {
      const p = parsePoints(text);
      dataset = mergeDataset(dataset, { points: p.points, files: [file] });
    } else if (meta.kind === 'INSTRUMENT_REGISTER') {
      const p = parseInstruments(text);
      dataset = mergeDataset(dataset, { instruments: p.instruments, files: [file] });
    } else if (meta.kind === 'BINDING_REGISTER') {
      const p = parseBindings(text);
      dataset = mergeDataset(dataset, { bindings: p.bindings, files: [file] });
    } else if (meta.kind === 'CALIBRATION_REGISTER') {
      const p = parseCalibrations(text);
      dataset = mergeDataset(dataset, { calibrations: p.calibrations, files: [file] });
    } else if (meta.kind === 'STATE_LOG') {
      const p = parseStates(text);
      dataset = mergeDataset(dataset, { states: p.states, files: [file] });
    }
  }
  for (const meta of manifest.baseFiles.filter((f) => f.kind === 'READINGS')) {
    const text = read(meta.fileName);
    const actual = sha(meta.fileName);
    const fileId = `file:${meta.fileName}:${actual.slice(0, 16)}`;
    const parsed = parseReadings(
      text,
      { fileId, kind: meta.kind, receivedAt: Date.parse(meta.receivedAt) },
      dataset.instruments,
      dataset.bindings,
    );
    const file = {
      fileId,
      fileName: meta.fileName,
      sha256: actual,
      sizeBytes: Buffer.byteLength(text),
      kind: meta.kind,
      receivedAt: Date.parse(meta.receivedAt),
      rowCount: meta.rowCount,
      acceptedRows: parsed.readings.length,
      rejectedRows: parsed.rejected,
      rejectedReasons: parsed.errors.slice(0, 20),
      note: meta.note,
      ingestedAt: Date.now(),
      ingestedBy: '核验脚本',
      sample: true,
    } as Dataset['files'][number];
    dataset = mergeDataset(dataset, { readings: parsed.readings, files: [file] });
  }

  const lateMeta = manifest.lateFile;
  const lateText = read(lateMeta.fileName);
  const lateActual = sha(lateMeta.fileName);
  fingerprints.push({ fileName: lateMeta.fileName, expected: lateMeta.sha256, actual: lateActual, ok: lateActual === lateMeta.sha256 });
  const lateParsed = parseReadings(
    lateText,
    { fileId: `file:${lateMeta.fileName}:${lateActual.slice(0, 16)}`, kind: lateMeta.kind, receivedAt: Date.parse(lateMeta.receivedAt) },
    dataset.instruments,
    dataset.bindings,
    { lateMode: true },
  );
  return { baseDataset: dataset, lateReadings: lateParsed.readings, fingerprints };
}
