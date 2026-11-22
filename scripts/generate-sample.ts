#!/usr/bin/env tsx
/**
 * 生成可回放的虚构资料：public/sample/*.csv + manifest.json
 *
 * 数据设计（2026-11-18，Asia/Shanghai）：
 *  - 三个厂站、四个点位，上报频率 10s / 60s / 300s，浓度与流量时钟各有偏移
 *  - CC-E01：04:00 浓度探头整机更换（点位编号复用，按实例衔接）
 *            09:15:00–09:15:40 高浓度冲击（COD 边界 50→140→145→132→50，恰 40 秒超限）
 *            13:00:00 校准中途生效（切开片段，两侧系数不同）
 *            01:00–01:08 冲洗（排除）、20:00–20:04 旁路（排除）
 *            02:00–02:03 三分钟缺测；迟到补录文件在申报后到达（16:40）
 *  - CC-E02：12:00 浓度探头更换；15:00–15:03 冲洗
 *  - HX-OUT：07:00–07:30 流量故障；10:00 校准
 *  - ZB-01：16:00–16:20 缺测；04:00–04:30 旁路
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeCsv, isoLocal } from '../src/sample/csv';
import type {
  Binding,
  Calibration,
  Instrument,
  OutfallPoint,
  Plant,
  Pollutant,
  Reading,
  SampleManifest,
  StatePeriod,
} from '../src/domain/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/sample');

const DAY = '2026-11-18';
const SHANGHAI = 8 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 10, 18) - SHANGHAI; // 2026-11-18T00:00+08:00
const HOUR = 3_600_000;
const SEC = 1000;
const MIN = 60_000;

function at(h: number, m = 0, s = 0, ms = 0): number {
  return D0 + h * HOUR + m * MIN + s * SEC + ms;
}

const plants: Plant[] = [
  {
    plantId: 'P1',
    name: '澄川水务第一净水厂',
    shortName: '一厂',
    timezone: 'Asia/Shanghai',
    dischargeStandard: { COD: 50, NH3N: 5 },
  },
  {
    plantId: 'P2',
    name: '澄川水务河西分厂',
    shortName: '河西厂',
    timezone: 'Asia/Shanghai',
    dischargeStandard: { COD: 50, NH3N: 5 },
  },
  {
    plantId: 'P3',
    name: '澄川水务北滩厂',
    shortName: '北滩厂',
    timezone: 'Asia/Shanghai',
    dischargeStandard: { COD: 60, NH3N: 8 },
  },
];

const points: OutfallPoint[] = [
  {
    pointCode: 'CC-E01',
    plantId: 'P1',
    name: '一厂总排口',
    reused: true,
    designFlowM3h: 450,
    note: '点位编号沿用，2026-11-18 04:00 更换 COD 探头、12:00 更换 CC-E02 探头，按设备实例衔接。',
  },
  {
    pointCode: 'CC-E02',
    plantId: 'P1',
    name: '一厂二期排口',
    reused: true,
    designFlowM3h: 320,
    note: '分钟级上报；12:00 更换 COD 探头；15:00 冲洗 3 分钟。',
  },
  {
    pointCode: 'HX-OUT',
    plantId: 'P2',
    name: '河西厂总排口',
    reused: false,
    designFlowM3h: 280,
    note: '分钟级上报；07:00–07:30 流量计故障；10:00 浓度校准。',
  },
  {
    pointCode: 'ZB-01',
    plantId: 'P3',
    name: '北滩厂排口',
    reused: false,
    designFlowM3h: 520,
    note: '五分钟级上报；16:00–16:20 缺测；04:00–04:30 旁路。',
  },
];

const instruments: Instrument[] = [
  {
    instrumentId: 'C-CO1',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2100',
    serial: 'A1901',
    scale: 0.97,
    offset: 0.4,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 10,
    installedAt: at(0) - 400 * 24 * HOUR,
    removedAt: at(4),
    clockOffsetMs: -7200,
    clockOffsetUncertaintyMs: 400,
    note: '旧探头，设备时钟快 7.2 秒；04:00 整机更换。',
  },
  {
    instrumentId: 'C-CO2',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2200',
    serial: 'B2107',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.025,
    nominalIntervalSeconds: 10,
    installedAt: at(4),
    removedAt: null,
    clockOffsetMs: 2500,
    clockOffsetUncertaintyMs: 250,
    note: '新探头，设备时钟慢 2.5 秒；13:00 校准生效。',
  },
  {
    instrumentId: 'N-NH1',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 80',
    serial: 'N5521',
    scale: 1.02,
    offset: -0.05,
    valueUncertainty: 0.035,
    nominalIntervalSeconds: 10,
    installedAt: at(0) - 300 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -1500,
    clockOffsetUncertaintyMs: 300,
    note: '设备时钟快 1.5 秒。',
  },
  {
    instrumentId: 'F-FL1',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Ultrasonic Flow U8',
    serial: 'F7710',
    scale: 1.01,
    offset: -1.2,
    valueUncertainty: 0.02,
    nominalIntervalSeconds: 10,
    installedAt: at(0) - 500 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 3200,
    clockOffsetUncertaintyMs: 500,
    note: '设备时钟慢 3.2 秒；20:00–20:04 旁路。',
  },
  {
    instrumentId: 'C-CO3',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2100',
    serial: 'A2033',
    scale: 0.99,
    offset: 0.2,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 200 * 24 * HOUR,
    removedAt: at(12),
    clockOffsetMs: 4000,
    clockOffsetUncertaintyMs: 600,
    note: '旧探头，时钟慢 4 秒；12:00 更换。',
  },
  {
    instrumentId: 'C-CO4',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2300',
    serial: 'C3301',
    scale: 1.03,
    offset: -0.5,
    valueUncertainty: 0.02,
    nominalIntervalSeconds: 60,
    installedAt: at(12),
    removedAt: null,
    clockOffsetMs: -6000,
    clockOffsetUncertaintyMs: 600,
    note: '新探头，时钟快 6 秒。',
  },
  {
    instrumentId: 'N-NH2',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 80',
    serial: 'N5610',
    scale: 0.98,
    offset: 0.1,
    valueUncertainty: 0.04,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 300 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 1800,
    clockOffsetUncertaintyMs: 400,
    note: '时钟慢 1.8 秒。',
  },
  {
    instrumentId: 'F-FL2',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Ultrasonic Flow U8',
    serial: 'F7822',
    scale: 1.0,
    offset: 0.8,
    valueUncertainty: 0.02,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 500 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -2200,
    clockOffsetUncertaintyMs: 500,
    note: '时钟快 2.2 秒。',
  },
  {
    instrumentId: 'C-CO5',
    pointCode: 'HX-OUT',
    plantId: 'P2',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2200',
    serial: 'B2288',
    scale: 1.01,
    offset: -0.3,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 150 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 5000,
    clockOffsetUncertaintyMs: 700,
    note: '时钟慢 5 秒；10:00 校准。',
  },
  {
    instrumentId: 'N-NH3',
    pointCode: 'HX-OUT',
    plantId: 'P2',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 80',
    serial: 'N5802',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.035,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 300 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -2500,
    clockOffsetUncertaintyMs: 400,
    note: '时钟快 2.5 秒。',
  },
  {
    instrumentId: 'F-FL3',
    pointCode: 'HX-OUT',
    plantId: 'P2',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Doppler Flow D2',
    serial: 'F8033',
    scale: 0.995,
    offset: 1.5,
    valueUncertainty: 0.025,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 500 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 1200,
    clockOffsetUncertaintyMs: 500,
    note: '07:00–07:30 故障。',
  },
  {
    instrumentId: 'C-CO6',
    pointCode: 'ZB-01',
    plantId: 'P3',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2100',
    serial: 'A2455',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.04,
    nominalIntervalSeconds: 300,
    installedAt: at(0) - 600 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -8000,
    clockOffsetUncertaintyMs: 1000,
    note: '五分钟级上报；16:00–16:20 缺测；04:00–04:30 旁路。',
  },
  {
    instrumentId: 'N-NH4',
    pointCode: 'ZB-01',
    plantId: 'P3',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 70',
    serial: 'N5901',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.045,
    nominalIntervalSeconds: 300,
    installedAt: at(0) - 600 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 6000,
    clockOffsetUncertaintyMs: 1000,
    note: '时钟慢 6 秒。',
  },
  {
    instrumentId: 'F-FL4',
    pointCode: 'ZB-01',
    plantId: 'P3',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Ultrasonic Flow U10',
    serial: 'F8410',
    scale: 1.02,
    offset: -2.0,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 300,
    installedAt: at(0) - 700 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -3500,
    clockOffsetUncertaintyMs: 800,
    note: '时钟快 3.5 秒。',
  },
];

const bindings: Binding[] = [
  { bindingId: 'B-CO1', pointCode: 'CC-E01', instrumentId: 'C-CO1', metric: 'COD', from: instruments[0].installedAt, to: at(4) },
  { bindingId: 'B-CO2', pointCode: 'CC-E01', instrumentId: 'C-CO2', metric: 'COD', from: at(4), to: null },
  { bindingId: 'B-NH1', pointCode: 'CC-E01', instrumentId: 'N-NH1', metric: 'NH3N', from: instruments[2].installedAt, to: null },
  { bindingId: 'B-FL1', pointCode: 'CC-E01', instrumentId: 'F-FL1', metric: 'FLOW', from: instruments[3].installedAt, to: null },
  { bindingId: 'B-CO3', pointCode: 'CC-E02', instrumentId: 'C-CO3', metric: 'COD', from: instruments[4].installedAt, to: at(12) },
  { bindingId: 'B-CO4', pointCode: 'CC-E02', instrumentId: 'C-CO4', metric: 'COD', from: at(12), to: null },
  { bindingId: 'B-NH2', pointCode: 'CC-E02', instrumentId: 'N-NH2', metric: 'NH3N', from: instruments[6].installedAt, to: null },
  { bindingId: 'B-FL2', pointCode: 'CC-E02', instrumentId: 'F-FL2', metric: 'FLOW', from: instruments[7].installedAt, to: null },
  { bindingId: 'B-CO5', pointCode: 'HX-OUT', instrumentId: 'C-CO5', metric: 'COD', from: instruments[8].installedAt, to: null },
  { bindingId: 'B-NH3', pointCode: 'HX-OUT', instrumentId: 'N-NH3', metric: 'NH3N', from: instruments[9].installedAt, to: null },
  { bindingId: 'B-FL3', pointCode: 'HX-OUT', instrumentId: 'F-FL3', metric: 'FLOW', from: instruments[10].installedAt, to: null },
  { bindingId: 'B-CO6', pointCode: 'ZB-01', instrumentId: 'C-CO6', metric: 'COD', from: instruments[11].installedAt, to: null },
  { bindingId: 'B-NH4', pointCode: 'ZB-01', instrumentId: 'N-NH4', metric: 'NH3N', from: instruments[12].installedAt, to: null },
  { bindingId: 'B-FL4', pointCode: 'ZB-01', instrumentId: 'F-FL4', metric: 'FLOW', from: instruments[13].installedAt, to: null },
];

const calibrations: Calibration[] = [
  {
    calibrationId: 'CAL-CO2-20261118',
    instrumentId: 'C-CO2',
    effectiveAt: at(13),
    scale: 1.08,
    offset: -1.2,
    coefficientUncertainty: 0.018,
    operator: '王笛',
    certificate: 'CC-2026-11-18-COD-02',
    note: '中途校准：13:00 生效，生效前后必须切开片段，两侧系数不同。',
  },
  {
    calibrationId: 'CAL-CO5-20261118',
    instrumentId: 'C-CO5',
    effectiveAt: at(10),
    scale: 0.98,
    offset: 0.6,
    coefficientUncertainty: 0.022,
    operator: '李哲',
    certificate: 'HX-2026-11-18-COD-01',
    note: '10:00 校准生效。',
  },
  {
    calibrationId: 'CAL-FL1-20261001',
    instrumentId: 'F-FL1',
    effectiveAt: at(0) - 48 * 24 * HOUR,
    scale: 1.01,
    offset: -1.2,
    coefficientUncertainty: 0.02,
    operator: '周岚',
    certificate: 'CC-2026-10-01-FLOW-01',
    note: '流量计季度率定。',
  },
  {
    calibrationId: 'CAL-NH1-20261001',
    instrumentId: 'N-NH1',
    effectiveAt: at(0) - 48 * 24 * HOUR,
    scale: 1.02,
    offset: -0.05,
    coefficientUncertainty: 0.035,
    operator: '周岚',
    certificate: 'CC-2026-10-01-NH3N-01',
    note: '氨氮季度校准。',
  },
];

const states: StatePeriod[] = [
  ...instruments.map<StatePeriod>((inst) => ({
    stateId: `ST-${inst.instrumentId}-OK-BASE`,
    instrumentId: inst.instrumentId,
    state: 'OK',
    from: at(0) - 24 * HOUR,
    to: at(0) + 48 * HOUR,
    reason: '运行正常（台账基线）',
    workOrder: 'WO-118-000',
  })),
  {
    stateId: 'ST-CCE01-FLUSH-0100',
    instrumentId: 'C-CO1',
    state: 'FLUSH',
    from: at(1),
    to: at(1, 8),
    reason: '自动冲洗程序',
    workOrder: 'WO-118-001',
  },
  {
    stateId: 'ST-CCE01-FL1-BYPASS-2000',
    instrumentId: 'F-FL1',
    state: 'BYPASS',
    from: at(20),
    to: at(20, 4),
    reason: '超越管切换，流量计旁路',
    workOrder: 'WO-118-014',
  },
  {
    stateId: 'ST-CCE02-FLUSH-1500',
    instrumentId: 'C-CO3',
    state: 'FLUSH',
    from: at(15),
    to: at(15, 3),
    reason: '探头清洗',
    workOrder: 'WO-118-009',
  },
  {
    stateId: 'ST-HX-FL3-FAULT-0700',
    instrumentId: 'F-FL3',
    state: 'FAULT',
    from: at(7),
    to: at(7, 30),
    reason: '多普勒探头信号丢失',
    workOrder: 'WO-118-005',
  },
  {
    stateId: 'ST-ZB-CO6-BYPASS-0400',
    instrumentId: 'C-CO6',
    state: 'BYPASS',
    from: at(4),
    to: at(4, 30),
    reason: '旁路超越作业',
    workOrder: 'WO-118-003',
  },
];

interface PointProfile {
  pointCode: string;
  plantId: string;
  cadenceSec: number;
  metrics: MetricProfile[];
  events: {
    gap?: [number, number];
    shock?: { from: number; to: number; pollutant: Pollutant };
  };
}

interface MetricProfile {
  metric: 'COD' | 'NH3N' | 'FLOW';
  instrumentIds: { from: number; instrumentId: string }[];
  base: number;
  amplitude: number;
  phaseHour: number;
}

const profiles: PointProfile[] = [
  {
    pointCode: 'CC-E01',
    plantId: 'P1',
    cadenceSec: 10,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO1' }, { from: at(4), instrumentId: 'C-CO2' }], base: 29, amplitude: 3.4, phaseHour: 7 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH1' }], base: 3.1, amplitude: 0.5, phaseHour: 9 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL1' }], base: 430, amplitude: 42, phaseHour: 11 },
    ],
    events: {
      gap: [at(2), at(2, 3)],
      shock: { from: at(9, 15), to: at(9, 15, 40), pollutant: 'COD' },
    },
  },
  {
    pointCode: 'CC-E02',
    plantId: 'P1',
    cadenceSec: 60,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO3' }, { from: at(12), instrumentId: 'C-CO4' }], base: 37, amplitude: 2.1, phaseHour: 8 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH2' }], base: 4.1, amplitude: 0.3, phaseHour: 10 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL2' }], base: 305, amplitude: 22, phaseHour: 12 },
    ],
    events: {},
  },
  {
    pointCode: 'HX-OUT',
    plantId: 'P2',
    cadenceSec: 60,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO5' }], base: 44, amplitude: 3.0, phaseHour: 9 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH3' }], base: 4.5, amplitude: 0.4, phaseHour: 13 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL3' }], base: 258, amplitude: 18, phaseHour: 10 },
    ],
    events: {},
  },
  {
    pointCode: 'ZB-01',
    plantId: 'P3',
    cadenceSec: 300,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO6' }], base: 41, amplitude: 4.0, phaseHour: 6 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH4' }], base: 2.7, amplitude: 0.3, phaseHour: 8 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL4' }], base: 505, amplitude: 30, phaseHour: 12 },
    ],
    events: { gap: [at(16), at(16, 20)] },
  },
];

const instrumentById = new Map(instruments.map((i) => [i.instrumentId, i]));
const calibrationByInstrument = new Map<string, Calibration[]>();
for (const c of calibrations) {
  const arr = calibrationByInstrument.get(c.instrumentId) ?? [];
  arr.push(c);
  calibrationByInstrument.set(c.instrumentId, arr);
}
for (const arr of calibrationByInstrument.values()) arr.sort((a, b) => a.effectiveAt - b.effectiveAt);

function activeCalibration(instrumentId: string, t: number): Calibration | null {
  let found: Calibration | null = null;
  for (const c of calibrationByInstrument.get(instrumentId) ?? []) {
    if (c.effectiveAt <= t) found = c;
    else break;
  }
  return found;
}

function trueValue(profile: MetricProfile, t: number, pointProfile: PointProfile): number {
  const hourOfDay = (t - D0) / HOUR;
  let value =
    profile.base +
    profile.amplitude * Math.sin((2 * Math.PI * (hourOfDay - profile.phaseHour)) / 24);
  // 冲击：边界读数等于限值，内部抬升，形成恰 40 秒超限
  const shock = pointProfile.events.shock;
  if (shock && profile.metric === shock.pollutant) {
    const offsetSec = (t - shock.from) / 1000;
    const durationSec = (shock.to - shock.from) / 1000;
    const limit = plants.find((p) => p.plantId === pointProfile.plantId)!.dischargeStandard[shock.pollutant];
    if (offsetSec === 0 || offsetSec === durationSec) value = limit;
    else if (offsetSec > 0 && offsetSec < durationSec) {
      if (shock.pollutant === 'COD') value = [140, 145, 132][Math.min(2, Math.floor(offsetSec / 10))];
      else value = [9.2, 10.5, 8.6][Math.min(2, Math.floor(offsetSec / 10))];
    }
  }
  // 旁路期间浓度计仍在取样，但状态排除；给一个可辨识值
  return Math.round(value * 1000) / 1000;
}

function instrumentFor(profile: MetricProfile, t: number): string {
  let id = profile.instrumentIds[0].instrumentId;
  for (const seg of profile.instrumentIds) if (seg.from <= t) id = seg.instrumentId;
  return id;
}

function rawOf(instrumentId: string, t: number, trueVal: number): number {
  const inst = instrumentById.get(instrumentId)!;
  const cal = activeCalibration(instrumentId, t);
  const scale = cal?.scale ?? inst.scale;
  const offset = cal?.offset ?? inst.offset;
  const raw = (trueVal - offset) / scale;
  return Math.round(raw * 100) / 100;
}

function makeReadingId(instrumentId: string, alignedAt: number): string {
  return `rd-${instrumentId}-${Math.floor(alignedAt / 1000)}`;
}

interface Generated {
  pointCode: string;
  plantId: string;
  fileName: string;
  receivedAt: number;
  readings: Reading[];
  rowCount: number;
}

const BASE_RECEIVED = at(0) + 31 * HOUR + 20 * MIN; // 2026-11-19 07:20+08 的批次接收
const LATE_RECEIVED = at(0) + 40 * HOUR + 40 * MIN; // 2026-11-19 16:40+08

function generatePoint(profile: PointProfile): Generated {
  const readings: Reading[] = [];
  let row = 0;
  const fileKey = `${profile.pointCode}_${DAY}`;
  const step = profile.cadenceSec * 1000;
  // 起点保留一个标称间隔的余量，避免负时钟偏移把首条读数推到前一日
  for (let aligned = D0 + step; aligned < D0 + 24 * HOUR; aligned += step) {
    const gap = profile.events.gap;
    if (gap && aligned >= gap[0] && aligned < gap[1]) continue;
    for (const metricProfile of profile.metrics) {
      const instrumentId = instrumentFor(metricProfile, aligned);
      const trueVal = trueValue(metricProfile, aligned, profile);
      const raw = rawOf(instrumentId, aligned, trueVal);
      const inst = instrumentById.get(instrumentId)!;
      const sampledAt = aligned - inst.clockOffsetMs;
      row += 1;
      readings.push({
        readingId: makeReadingId(instrumentId, aligned),
        pointCode: profile.pointCode,
        plantId: profile.plantId,
        instrumentId,
        metric: metricProfile.metric,
        sampledAt,
        receivedAt: BASE_RECEIVED,
        rawValue: raw,
        qualityFlag: 'VALID',
        sourceFileId: `pending:${fileKey}`,
        sourceRow: row,
        alignedAt: aligned,
        dayKey: DAY,
      });
    }
  }
  // 把某个读数的质量标记为 SUSPECT，演示不确定度膨胀
  const suspect = readings.find((r) => r.metric === 'NH3N' && r.alignedAt === at(18));
  if (suspect) suspect.qualityFlag = 'SUSPECT';
  return {
    pointCode: profile.pointCode,
    plantId: profile.plantId,
    fileName: `readings_${profile.pointCode}_${DAY}.csv`,
    receivedAt: BASE_RECEIVED + (profile.pointCode === 'CC-E01' ? 0 : 5 * MIN),
    readings,
    rowCount: row,
  };
}

function generateLate(): Reading[] {
  const readings: Reading[] = [];
  const profile = profiles[0];
  for (let aligned = at(2); aligned < at(2, 3); aligned += 10 * SEC) {
    for (const metricProfile of profile.metrics) {
      const instrumentId = instrumentFor(metricProfile, aligned);
      const trueVal = trueValue(metricProfile, aligned, profile);
      const inst = instrumentById.get(instrumentId)!;
      readings.push({
        readingId: `late-${instrumentId}-${Math.floor(aligned / 1000)}`,
        pointCode: profile.pointCode,
        plantId: profile.plantId,
        instrumentId,
        metric: metricProfile.metric,
        sampledAt: aligned - inst.clockOffsetMs,
        receivedAt: LATE_RECEIVED,
        rawValue: rawOf(instrumentId, aligned, trueVal),
        qualityFlag: 'VALID',
        sourceFileId: 'pending:late_CC-E01_2026-11-19.csv',
        sourceRow: readings.length + 1,
        alignedAt: aligned,
        dayKey: DAY,
      });
    }
  }
  return readings;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const manifestBase: SampleManifest['baseFiles'] = [];

  const plantCsv = serializeCsv(
    ['plant_id', 'name', 'short_name', 'timezone', 'cod_limit', 'nh3n_limit'],
    plants.map((p) => ({
      plant_id: p.plantId,
      name: p.name,
      short_name: p.shortName,
      timezone: p.timezone,
      cod_limit: p.dischargeStandard.COD,
      nh3n_limit: p.dischargeStandard.NH3N,
    })),
  );
  const pointCsv = serializeCsv(
    ['point_code', 'plant_id', 'name', 'reused', 'design_flow_m3h', 'note'],
    points.map((p) => ({
      point_code: p.pointCode,
      plant_id: p.plantId,
      name: p.name,
      reused: p.reused ? 'true' : 'false',
      design_flow_m3h: p.designFlowM3h,
      note: p.note,
    })),
  );
  const instrumentCsv = serializeCsv(
    [
      'instrument_id',
      'point_code',
      'plant_id',
      'kind',
      'metric',
      'model',
      'serial',
      'scale',
      'offset',
      'value_uncertainty',
      'nominal_interval_seconds',
      'installed_at',
      'removed_at',
      'clock_offset_ms',
      'clock_offset_uncertainty_ms',
      'note',
    ],
    instruments.map((i) => ({
      instrument_id: i.instrumentId,
      point_code: i.pointCode,
      plant_id: i.plantId,
      kind: i.kind,
      metric: i.metric,
      model: i.model,
      serial: i.serial,
      scale: i.scale,
      offset: i.offset,
      value_uncertainty: i.valueUncertainty,
      nominal_interval_seconds: i.nominalIntervalSeconds,
      installed_at: isoLocal(i.installedAt),
      removed_at: i.removedAt === null ? '' : isoLocal(i.removedAt),
      clock_offset_ms: i.clockOffsetMs,
      clock_offset_uncertainty_ms: i.clockOffsetUncertaintyMs,
      note: i.note,
    })),
  );
  const bindingCsv = serializeCsv(
    ['binding_id', 'point_code', 'instrument_id', 'metric', 'from', 'to'],
    bindings.map((b) => ({
      binding_id: b.bindingId,
      point_code: b.pointCode,
      instrument_id: b.instrumentId,
      metric: b.metric,
      from: isoLocal(b.from),
      to: b.to === null ? '' : isoLocal(b.to),
    })),
  );
  const calibrationCsv = serializeCsv(
    [
      'calibration_id',
      'instrument_id',
      'effective_at',
      'scale',
      'offset',
      'coefficient_uncertainty',
      'operator',
      'certificate',
      'note',
    ],
    calibrations.map((c) => ({
      calibration_id: c.calibrationId,
      instrument_id: c.instrumentId,
      effective_at: isoLocal(c.effectiveAt),
      scale: c.scale,
      offset: c.offset,
      coefficient_uncertainty: c.coefficientUncertainty,
      operator: c.operator,
      certificate: c.certificate,
      note: c.note,
    })),
  );
  const stateCsv = serializeCsv(
    ['state_id', 'instrument_id', 'state', 'from', 'to', 'reason', 'work_order'],
    states.map((s) => ({
      state_id: s.stateId,
      instrument_id: s.instrumentId,
      state: s.state,
      from: isoLocal(s.from),
      to: s.to === null ? '' : isoLocal(s.to),
      reason: s.reason,
      work_order: s.workOrder,
    })),
  );

  const registers: { name: string; text: string; kind: SampleManifest['baseFiles'][number]['kind']; note: string }[] = [
    { name: 'plants.csv', text: plantCsv, kind: 'PLANT_REGISTER', note: '厂站与排放限值台账' },
    { name: 'points.csv', text: pointCsv, kind: 'POINT_REGISTER', note: '排口点位实体（含编号复用标记）' },
    { name: 'instruments.csv', text: instrumentCsv, kind: 'INSTRUMENT_REGISTER', note: '仪表实例台账（含时钟偏移）' },
    { name: 'bindings.csv', text: bindingCsv, kind: 'BINDING_REGISTER', note: '仪表—点位—指标绑定有效期' },
    { name: 'calibrations.csv', text: calibrationCsv, kind: 'CALIBRATION_REGISTER', note: '校准系数与生效时刻' },
    { name: 'states.csv', text: stateCsv, kind: 'STATE_LOG', note: '冲洗/校准/旁路/故障状态台账' },
  ];
  for (const reg of registers) {
    writeFileSync(resolve(outDir, reg.name), reg.text, 'utf8');
    manifestBase.push({
      fileName: reg.name,
      kind: reg.kind,
      receivedAt: isoLocal(at(0) + 30 * HOUR + 10 * MIN),
      rowCount: reg.text.trim().split('\n').length - 1,
      sha256: sha256(reg.text),
      note: reg.note,
    });
  }

  const generated = profiles.map(generatePoint);
  for (const g of generated) {
    const text = serializeCsv(
      [
        'reading_id',
        'point_code',
        'plant_id',
        'instrument_id',
        'metric',
        'sampled_at',
        'received_at',
        'raw_value',
        'quality_flag',
      ],
      g.readings.map((r) => ({
        reading_id: r.readingId,
        point_code: r.pointCode,
        plant_id: r.plantId,
        instrument_id: r.instrumentId,
        metric: r.metric,
        sampled_at: isoLocal(r.sampledAt, true),
        received_at: isoLocal(r.receivedAt),
        raw_value: r.rawValue,
        quality_flag: r.qualityFlag,
      })),
    );
    writeFileSync(resolve(outDir, g.fileName), text, 'utf8');
    manifestBase.push({
      fileName: g.fileName,
      kind: 'READINGS',
      receivedAt: isoLocal(g.receivedAt),
      rowCount: g.rowCount,
      sha256: sha256(text),
      note: `${g.pointCode} 2026-11-18 原始读数（${g.readings.length} 行，含三指标）`,
    });
  }

  const lateReadings = generateLate();
  const lateFileName = 'late_CC-E01_2026-11-19.csv';
  const lateText = serializeCsv(
    [
      'reading_id',
      'point_code',
      'plant_id',
      'instrument_id',
      'metric',
      'sampled_at',
      'received_at',
      'raw_value',
      'quality_flag',
    ],
    lateReadings.map((r) => ({
      reading_id: r.readingId,
      point_code: r.pointCode,
      plant_id: r.plantId,
      instrument_id: r.instrumentId,
      metric: r.metric,
      sampled_at: isoLocal(r.sampledAt, true),
      received_at: isoLocal(r.receivedAt),
      raw_value: r.rawValue,
      quality_flag: r.qualityFlag,
    })),
  );
  writeFileSync(resolve(outDir, lateFileName), lateText, 'utf8');

  const manifest: SampleManifest = {
    name: '排口负荷离线复核样例（虚构）',
    description:
      '2026-11-18 澄川水务三个厂站、四个排口的接入资料。CC-E01 含 40 秒高浓度冲击、13:00 校准中途生效、02:00–02:03 三分钟缺测、04:00 探头更换与 20:00 旁路；迟到补录在申报后到达。',
    generatedAt: new Date(Date.UTC(2026, 10, 20, 1, 0, 0)).toISOString(),
    timezone: 'Asia/Shanghai',
    baseFiles: manifestBase,
    lateFile: {
      fileName: lateFileName,
      kind: 'LATE_BATCH',
      receivedAt: isoLocal(LATE_RECEIVED),
      rowCount: lateReadings.length,
      sha256: sha256(lateText),
      note: '迟到补录：CC-E01 02:00–02:03 缺测段的 10 秒读数，申报出具后才到达。',
    },
    focus: {
      pointCode: 'CC-E01',
      day: DAY,
      declarationCutoff: isoLocal(at(0) + 31 * HOUR + 20 * MIN),
      scenario: [
        '40 秒高浓度冲击：09:15:00–09:15:40，边界读数等于限值，内部 140/145/132 mg/L',
        '校准中途生效：13:00:00，切开片段，前后系数分别为 1.00/0.00 与 1.08/-1.20',
        '三分钟缺测：02:00–02:03，负荷与覆盖率均扣除，缺口影响单独量化',
        '设备交接：04:00 COD 探头整机更换，点位编号复用按实例衔接',
        '排除时段：01:00–01:08 冲洗、20:00–20:04 旁路，均不并入排放',
        '迟到补录：16:40 到达的 02:00–02:03 读数，只能形成锁定来源范围的重算候选',
      ],
    },
  };
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const totalRows = manifestBase.filter((f) => f.kind === 'READINGS').reduce((a, f) => a + f.rowCount, 0);
  console.log(`样例已生成：${outDir}`);
  console.log(`读数 ${totalRows} 行；迟到补录 ${lateReadings.length} 行；台账 ${registers.length} 份`);
}

main();
