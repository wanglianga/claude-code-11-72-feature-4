#!/usr/bin/env tsx
/**
 * 生成混凝剂投加效率复核样例：public/sample/coag/*.csv + coag-manifest.json
 *
 * 全部数值由确定性分段函数给出（无随机数），因此每次生成结果与清单指纹一致。
 *
 * 场景（2026-11-18，Asia/Shanghai，一厂 P1，两个混凝池）：
 *  - CT-01：05:50–08:30 暴雨（进水浊度 6→85 NTU、流量 420→700 m³/h、COD 110→220 mg/L）
 *           03:30–05:00 搅拌停止；13:30–14:30 浊度突升；16:30–17:10 出水旁路
 *           06:40 储罐稀释（浓度 42→38.11 g/L）、07:10 转罐混入 40 g/L 批次
 *           02:00–02:20 出水 COD 采样空档；20:30 起低温（水温 <10 ℃）
 *  - CT-02：09:40 泵校准失效、10:20 重新校准（期间投加量只有范围）
 *           11:03–12:10 储罐抽空（缺料），12:10 转罐补料
 *           10:15 出水化验迟到（11-19 15:20 才接收），形成复盘候选
 *  - 泵脉冲决定实际投加；入库/转罐/稀释只进批次账与库存平衡，不得当作投加量
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialCsv, isoLocal } from './coagSampleIo';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/sample/coag');

const DAY = '2026-11-18';
const SHANGHAI = 8 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 10, 18) - SHANGHAI;
const HOUR = 3_600_000;
const SEC = 1000;
const MIN = 60_000;

const H = (h: number, m = 0, s = 0): number => D0 + h * HOUR + m * MIN + s * SEC;

// ------------------------------ 台账 ------------------------------

const plants = [
  ['P1', '澄川水务第一净水厂', '一厂'],
];

const tanks = [
  {
    tankId: 'CT-01',
    plantId: 'P1',
    name: '一期混凝池 A',
    volume: 200,
    minRes: 600,
    maxRes: 1800,
    recycle: 0.12,
    inlet: 'IN-01',
    outlet: 'OUT-01',
    volumeU: 0.04,
    storage: 'SS-01',
    note: '有效池容 200 m³；回流比 12%；设计停留 10–30 分钟。暴雨期流量抬升会压缩停留时间。',
  },
  {
    tankId: 'CT-02',
    plantId: 'P1',
    name: '二期混凝池 B',
    volume: 180,
    minRes: 720,
    maxRes: 2400,
    recycle: 0.1,
    inlet: 'IN-02',
    outlet: 'OUT-02',
    volumeU: 0.05,
    storage: 'SS-02',
    note: '有效池容 180 m³；回流比 10%；设计停留 12–40 分钟。储罐容量小，需要白班转罐补料。',
  },
];

const points = [
  { code: 'IN-01', tank: 'CT-01', role: 'INLET', name: '一期混凝池 A 进口', metrics: 'FLOW;TURBIDITY;PH;TEMP;COD;NH3N', off: 1200, offU: 200, nominal: 60, unc: 0.02 },
  { code: 'OUT-01', tank: 'CT-01', role: 'OUTLET', name: '一期混凝池 A 出水', metrics: 'COD;NH3N;TURBIDITY;PH', off: -900, offU: 250, nominal: 300, unc: 0.03 },
  { code: 'IN-02', tank: 'CT-02', role: 'INLET', name: '二期混凝池 B 进口', metrics: 'FLOW;TURBIDITY;PH;TEMP;COD;NH3N', off: -1500, offU: 300, nominal: 60, unc: 0.02 },
  { code: 'OUT-02', tank: 'CT-02', role: 'OUTLET', name: '二期混凝池 B 出水', metrics: 'COD;NH3N;TURBIDITY;PH', off: 2400, offU: 300, nominal: 300, unc: 0.03 },
];

const storages = [
  { storageId: 'SS-BULK', plantId: 'P1', name: '药剂库房储罐', capacityL: 20000, note: '批量入库与转罐起点。' },
  { storageId: 'SS-01', plantId: 'P1', name: '一期投加罐', capacityL: 8000, note: '供 CT-01；班中出现稀释与转罐混配。' },
  { storageId: 'SS-02', plantId: 'P1', name: '二期投加罐', capacityL: 4000, note: '供 CT-02；容量小，白班需转罐补料。' },
];

const CONC_NOISE: Record<string, number> = { 'SS-BULK': 1.0, 'SS-01': 0.999, 'SS-02': 1.002 };

const batches = [
  { batchId: 'B-2026-1115', plantId: 'P1', product: '聚合氯化铝（液体，以 Al2O3 计）', conc: 42, concU: 0.02, manuf: H(-72), received: H(-72), volume: 12000, supplier: '澄川化工', cert: 'COA-1115-01', note: '库房批量入库。' },
  { batchId: 'B-2026-1117', plantId: 'P1', product: '聚合氯化铝（液体）', conc: 40, concU: 0.02, manuf: H(-26), received: H(-26), volume: 8000, supplier: '澄川化工', cert: 'COA-1117-02', note: '07:10 转罐至 SS-01。' },
  { batchId: 'B-2026-1118', plantId: 'P1', product: '聚合氯化铝（液体）', conc: 41, concU: 0.02, manuf: H(-18), received: H(9), volume: 6000, supplier: '澄川化工', cert: 'COA-1118-03', note: '11-18 09:00 入库；只入批次账，不直接视为投加。' },
  { batchId: 'B-2026-1119', plantId: 'P1', product: '聚合氯化铝（液体）', conc: 39.5, concU: 0.025, manuf: H(-10), received: H(11, 45), volume: 4000, supplier: '河西化工', cert: 'COA-1119-04', note: '11-18 11:45 入库；12:10 转罐 3000 L 至 SS-02。' },
];

const shifts = [
  { shiftId: 'S-NIGHT', plantId: 'P1', code: '夜班', name: '00:00–08:00', start: 0, end: 480 },
  { shiftId: 'S-DAY', plantId: 'P1', code: '白班', name: '08:00–16:00', start: 480, end: 960 },
  { shiftId: 'S-EVENING', plantId: 'P1', code: '晚班', name: '16:00–24:00', start: 960, end: 1440 },
];

// ------------------------------ 工况曲线 ------------------------------

function sinNoise(minute: number, seed: number): number {
  return 1 + 0.006 * Math.sin(minute / 7 + seed) + 0.004 * Math.cos(minute / 11 + seed * 2);
}

interface TankProfile {
  tankId: string;
  flow(minute: number): number;
  turbidity(minute: number): number;
  ph(minute: number): number;
  temp(minute: number): number;
  inletCod(minute: number): number;
  inletNh3n(minute: number): number;
  removalCod(atMinute: number): number;
  removalNh3n(atMinute: number): number;
  residenceSeconds(flowM3h: number): number;
  /** 出水读数缺失的分钟区间（半开） */
  outletGaps: [number, number][];
}

const ct01: TankProfile = {
  tankId: 'CT-01',
  flow(minute) {
    const h = minute / 60;
    let q = 420;
    if (h < 5.8) q = 415 + 12 * Math.sin((minute / 1440) * Math.PI * 2);
    else if (h < 6.25) q = 415 + ((h - 5.8) / 0.45) * 290;
    else if (h < 7.3) q = 705;
    else if (h < 8.5) q = 705 - ((h - 7.3) / 1.2) * 250;
    else if (h < 12) q = 455 + 10 * Math.sin(minute / 55);
    else if (h < 16) q = 440 + 14 * Math.sin(minute / 40);
    else if (h < 20) q = 465 + 10 * Math.cos(minute / 50);
    else q = 430 + 8 * Math.cos(minute / 60);
    return Math.max(250, q * sinNoise(minute, 1.1));
  },
  turbidity(minute) {
    const h = minute / 60;
    let v = 6.2 + 0.6 * Math.sin(minute / 33);
    if (h >= 5.83 && h < 8.6) {
      const up = Math.min(1, (h - 5.83) / 0.5);
      const down = h > 7.4 ? Math.max(0, 1 - (h - 7.4) / 1.2) : 1;
      v += 78 * up * down;
    }
    if (h >= 13.5 && h < 14.6) v += 30 * Math.sin(((h - 13.5) / 1.1) * Math.PI);
    return Math.max(1, v * sinNoise(minute, 2.3));
  },
  ph(minute) {
    const h = minute / 60;
    let v = 7.25 + 0.08 * Math.sin(minute / 61);
    if (h >= 5.9 && h < 8.4) v -= 0.55 * Math.sin(((h - 5.9) / 2.5) * Math.PI);
    return v;
  },
  temp(minute) {
    if (minute < 1080) return 13.8 + 0.35 * Math.sin(minute / 120);
    if (minute < 1230) return 13.8 - ((minute - 1080) / 150) * 4.6;
    return 9.2 + 0.2 * Math.sin(minute / 90);
  },
  inletCod(minute) {
    const base = 118 + 9 * Math.sin(minute / 47) + 4 * Math.cos(minute / 23);
    const turb = this.turbidity(minute);
    return base + Math.max(0, turb - 8) * 1.25;
  },
  inletNh3n(minute) {
    return 29 + 2.4 * Math.sin(minute / 70) + Math.max(0, this.turbidity(minute) - 10) * 0.06;
  },
  removalCod(at) {
    let r = 0.625;
    if (at >= 210 && at < 300) r = Math.min(r, 0.3); // 03:30–05:00 搅拌停止
    if (at >= 350 && at < 510) r = Math.min(r, 0.42); // 05:50–08:30 暴雨
    if (at >= 810 && at < 870) r = Math.min(r, 0.52); // 13:30–14:30 浊度突升
    if (at >= 990 && at < 1030) r = Math.min(r, 0.02); // 16:30–17:10 旁路
    if (this.temp(at) < 10) r = Math.min(r, 0.5); // 低温
    return r;
  },
  removalNh3n(at) {
    let r = 0.35;
    if (at >= 210 && at < 300) r = Math.min(r, 0.15);
    if (at >= 350 && at < 510) r = Math.min(r, 0.22);
    if (at >= 810 && at < 870) r = Math.min(r, 0.28);
    if (at >= 990 && at < 1030) r = Math.min(r, 0.02);
    if (this.temp(at) < 10) r = Math.min(r, 0.2);
    return r;
  },
  residenceSeconds(flow) {
    return (200 * 3600) / (flow * (1 + 0.12));
  },
  outletGaps: [
    [120, 140], // 02:00–02:20 出水采样空档
  ],
};

const ct02: TankProfile = {
  tankId: 'CT-02',
  flow(minute) {
    const h = minute / 60;
    let q = 285;
    if (h >= 5.9 && h < 8.4) q = 285 + 90 * Math.sin(((h - 5.9) / 2.5) * Math.PI);
    else if (h >= 8.4) q = 295 + 9 * Math.sin(minute / 44);
    return Math.max(180, q * sinNoise(minute, 3.7));
  },
  turbidity(minute) {
    const h = minute / 60;
    let v = 7.5 + 0.7 * Math.cos(minute / 29);
    if (h >= 5.9 && h < 8.4) v += 45 * Math.sin(((h - 5.9) / 2.5) * Math.PI);
    return Math.max(1, v * sinNoise(minute, 4.1));
  },
  ph(minute) {
    return 7.35 + 0.09 * Math.cos(minute / 53);
  },
  temp(minute) {
    return 14.1 + 0.3 * Math.sin(minute / 130);
  },
  inletCod(minute) {
    return 112 + 8 * Math.cos(minute / 51) + Math.max(0, this.turbidity(minute) - 9) * 1.15;
  },
  inletNh3n(minute) {
    return 27.5 + 2.1 * Math.cos(minute / 64);
  },
  removalCod(at) {
    let r = 0.6;
    if (at >= 350 && at < 510) r = Math.min(r, 0.53);
    if (at >= 663 && at < 730) r = Math.min(r, 0.38); // 11:03–12:10 缺料
    return r;
  },
  removalNh3n(at) {
    let r = 0.34;
    if (at >= 350 && at < 510) r = Math.min(r, 0.28);
    if (at >= 663 && at < 730) r = Math.min(r, 0.18);
    return r;
  },
  residenceSeconds(flow) {
    return (180 * 3600) / (flow * (1 + 0.1));
  },
  outletGaps: [],
};

/** 上一分钟值：出水读数 = 进口值(进入时刻) × (1 − 去除率(进入时刻)) */
function solveEntryMinute(tMinute: number, profile: TankProfile): number {
  let entry = tMinute;
  for (let i = 0; i < 6; i += 1) {
    const q = profile.flow(entry);
    const res = profile.residenceSeconds(q);
    entry = tMinute - res / 60;
  }
  return Math.max(0, entry);
}

// ------------------------------ 读数 ------------------------------

function readingsFor(tankId: string, profile: TankProfile): string[][] {
  const rows: string[][] = [];
  const add = (
    minute: number,
    second: number,
    point: string,
    metric: string,
    value: number,
    nominal: number,
    quality = 'VALID',
  ): void => {
    const sampledAt = D0 + Math.round(minute * MIN) + second * SEC;
    rows.push([
      `${tankId}-${point}-${metric}-${minute}-${second}`,
      point,
      metric,
      isoLocal(sampledAt),
      value.toFixed(3),
      isoLocal(D0 + 40 * MIN),
      quality,
    ]);
    void nominal;
  };
  // 进口：流量/浊度 60s，pH/温度 300s
  for (let minute = 0; minute < 1440; minute += 1) {
    const sec = (minute * 37) % 60;
    add(minute, sec, profile.tankId === 'CT-01' ? 'IN-01' : 'IN-02', 'FLOW', profile.flow(minute), 60);
    add(minute, sec, profile.tankId === 'CT-01' ? 'IN-01' : 'IN-02', 'TURBIDITY', profile.turbidity(minute), 60);
    add(minute, (sec + 5) % 60, profile.tankId === 'CT-01' ? 'IN-01' : 'IN-02', 'COD', profile.inletCod(minute), 60);
    add(minute, (sec + 9) % 60, profile.tankId === 'CT-01' ? 'IN-01' : 'IN-02', 'NH3N', profile.inletNh3n(minute), 60);
  }
  for (let minute = 0; minute < 1440; minute += 5) {
    add(minute, 10, profile.tankId === 'CT-01' ? 'IN-01' : 'IN-02', 'PH', profile.ph(minute), 300);
    add(minute, 20, profile.tankId === 'CT-01' ? 'IN-01' : 'IN-02', 'TEMP', profile.temp(minute), 300);
  }
  // 出口：COD/氨氮/浊度/pH 均 300s，含采样空档
  const inGap = (minute: number): boolean => profile.outletGaps.some(([a, b]) => minute >= a && minute < b);
  for (let minute = 0; minute < 1440; minute += 5) {
    if (inGap(minute)) continue;
    const entry = solveEntryMinute(minute, profile);
    const cod = profile.inletCod(entry) * (1 - profile.removalCod(entry));
    const nh = profile.inletNh3n(entry) * (1 - profile.removalNh3n(entry));
    const turb = Math.max(0.8, profile.turbidity(entry) * (1 - profile.removalCod(entry) * 1.6));
    const outPoint = profile.tankId === 'CT-01' ? 'OUT-01' : 'OUT-02';
    add(minute, 30, outPoint, 'COD', cod * (1 + 0.004 * Math.sin(minute / 9)), 300);
    add(minute, 35, outPoint, 'NH3N', nh * (1 + 0.004 * Math.cos(minute / 13)), 300);
    add(minute, 40, outPoint, 'TURBIDITY', turb, 300);
    add(minute, 45, outPoint, 'PH', profile.ph(entry) + 0.05, 300);
  }
  return rows;
}

// ------------------------------ 状态与事件 ------------------------------

const bypasses = [
  { bypassId: 'BP-01', tank: 'CT-01', from: H(16, 30), to: H(17, 10), direction: 'OUTLET', fraction: 1, reason: '滤池反冲洗导致出水旁路，混凝出水未进入取样点', workOrder: 'WO-118-031', by: '钱宁' },
];

const mixing = [
  { mixingId: 'MX-01', tank: 'CT-01', from: H(3, 30), to: H(5, 0), state: 'OFF', reason: '搅拌器轴承过热停机', workOrder: 'WO-118-012' },
  { mixingId: 'MX-02', tank: 'CT-01', from: H(13, 30), to: H(14, 10), state: 'REDUCED', reason: '变频器降速运行', workOrder: 'WO-118-024' },
];

const upsets = [
  { upsetId: 'UP-01', tank: 'CT-01', from: H(5, 50), to: H(8, 30), kind: 'STORM', severity: 'MAJOR', note: '短时暴雨：进水浊度 6→85 NTU，流量 420→705 m³/h，pH 降至 6.7。' },
  { upsetId: 'UP-02', tank: 'CT-01', from: H(20, 30), to: H(23, 59), kind: 'LOW_TEMP', severity: 'MINOR', note: '夜间水温降至 9 ℃，絮体形成变慢。' },
  { upsetId: 'UP-03', tank: 'CT-01', from: H(13, 30), to: H(14, 30), kind: 'TURBIDITY_SURGE', severity: 'MINOR', note: '回流污泥扰动造成进水浊度突升。' },
  { upsetId: 'UP-04', tank: 'CT-02', from: H(5, 54), to: H(8, 24), kind: 'STORM', severity: 'MINOR', note: '同一场降雨：流量与浊度短时抬升。' },
  { upsetId: 'UP-05', tank: 'CT-02', from: H(11, 3), to: H(12, 10), kind: 'OTHER', severity: 'MAJOR', note: '投加罐抽空，泵空转（缺料）。' },
];

// ------------------------------ 储罐与投加 ------------------------------

interface StorageState {
  storageId: string;
  volumeL: number;
  conc: number;
}

/** CT-02 的设定投加率（L/h）：白天 90 L/h，暴雨段 120 L/h；11:03 抽空 */
function ct02Setpoint(minute: number): number {
  if (minute >= 663 && minute < 730) return 30;
  if (minute >= 350 && minute < 510) return 120;
  return 90;
}

/** SS-02 期初液位由“恰好支撑到 11:03 抽空”反推（12:10 之前没有转罐） */
const SS02_DRY_MINUTE = 663;
const ss02OpeningL = (() => {
  let consumed = 0;
  for (let m = 0; m < SS02_DRY_MINUTE; m += 1) consumed += ct02Setpoint(m) / 60;
  return Math.ceil(consumed + 2);
})();

const stocktakes = [
  { id: 'ST-BULK-OPEN', storage: 'SS-BULK', at: H(0), volume: 8000, conc: 40, by: '库房盘点' },
  { id: 'ST-01-OPEN', storage: 'SS-01', at: H(0), volume: 6000, conc: 42, by: '夜班接班' },
  { id: 'ST-02-OPEN', storage: 'SS-02', at: H(0), volume: ss02OpeningL, conc: 38, by: '夜班接班' },
  { id: 'ST-02-DRY', storage: 'SS-02', at: H(11, 3), volume: 0, conc: 38, by: '白班巡检' },
];

const transfers: {
  id: string;
  storage: string;
  kind: string;
  at: number;
  batch: string;
  volume: number;
  conc: number;
  note: string;
  by: string;
}[] = [
  { id: 'TR-00A', storage: 'SS-BULK', kind: 'RECEIPT', at: H(9, 0), batch: 'B-2026-1118', volume: 6000, conc: 41, note: '批次入库至库房储罐 6000 L；仅入批次账，不是投加。', by: '库房' },
  { id: 'TR-00B', storage: 'SS-BULK', kind: 'RECEIPT', at: H(11, 45), batch: 'B-2026-1119', volume: 4000, conc: 39.5, note: '批次入库至库房储罐 4000 L；仅入批次账，不是投加。', by: '库房' },
  { id: 'TR-01', storage: 'SS-01', kind: 'DILUTION', at: H(6, 40), batch: '', volume: 600, conc: 0, note: '储罐未用尽时补加清水稀释，需按混合比例折算浓度。', by: '夜班' },
  { id: 'TR-02', storage: 'SS-BULK', kind: 'TRANSFER_OUT', at: H(7, 10), batch: 'B-2026-1117', volume: 1200, conc: 40, note: '转罐至 SS-01。', by: '夜班' },
  { id: 'TR-03', storage: 'SS-01', kind: 'TRANSFER_IN', at: H(7, 10), batch: 'B-2026-1117', volume: 1200, conc: 40, note: '自库房转罐混入。', by: '夜班' },
  { id: 'TR-04', storage: 'SS-BULK', kind: 'TRANSFER_OUT', at: H(12, 10), batch: 'B-2026-1119', volume: 3000, conc: 39.5, note: '转罐至 SS-02。', by: '白班' },
  { id: 'TR-05', storage: 'SS-02', kind: 'TRANSFER_IN', at: H(12, 10), batch: 'B-2026-1119', volume: 3000, conc: 39.5, note: '抽空后补料。', by: '白班' },
];

function freshStorage(): Record<string, StorageState> {
  return {
    'SS-BULK': { storageId: 'SS-BULK', volumeL: 8000, conc: 40 },
    'SS-01': { storageId: 'SS-01', volumeL: 6000, conc: 42 },
    'SS-02': { storageId: 'SS-02', volumeL: ss02OpeningL, conc: 38 },
  };
}

function applyTransfer(st: StorageState, tr: (typeof transfers)[number]): void {
  if (tr.kind === 'RECEIPT') {
    const mass = st.volumeL * st.conc + tr.volume * tr.conc;
    st.volumeL += tr.volume;
    st.conc = st.volumeL > 0 ? mass / st.volumeL : tr.conc;
  } else if (tr.kind === 'DILUTION') {
    const mass = st.volumeL * st.conc;
    st.volumeL += tr.volume;
    st.conc = st.volumeL > 0 ? mass / st.volumeL : 0;
  } else if (tr.kind === 'TRANSFER_OUT') {
    st.volumeL = Math.max(0, st.volumeL - tr.volume);
  } else if (tr.kind === 'TRANSFER_IN') {
    const mass = st.volumeL * st.conc + tr.volume * tr.conc;
    st.volumeL += tr.volume;
    st.conc = st.volumeL > 0 ? mass / st.volumeL : tr.conc;
  }
}

const txSorted = [...transfers].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

const pumpCalibrations = [
  { id: 'PC-01', tank: 'CT-01', pump: 'P-01', at: H(-24), invalid: null as number | null, volumeMl: 12.0, unc: 0.02, operator: '周岚', cert: 'PC-2026-1117-01', note: '11-17 例行校准。' },
  { id: 'PC-02', tank: 'CT-02', pump: 'P-02', at: H(-24), invalid: H(9, 40), volumeMl: 10.0, unc: 0.025, operator: '周岚', cert: 'PC-2026-1117-02', note: '09:40 脉冲计数器故障，校准失效。' },
  { id: 'PC-03', tank: 'CT-02', pump: 'P-02', at: H(10, 20), invalid: null, volumeMl: 10.8, unc: 0.02, operator: '王笛', cert: 'PC-2026-1118-03', note: '10:20 更换计数器并重新校准。' },
];

/** 投加设定值（L/h） */
function setpoint(tankId: string, minute: number): number {
  if (tankId === 'CT-01') {
    if (minute >= 350 && minute < 510) return 250;
    if (minute >= 810 && minute < 870) return 200;
    if (minute >= 1230) return 200;
    return 150;
  }
  if (minute >= 663 && minute < 730) return 30; // 抽空期间泵空转，脉冲几乎为 0
  if (minute >= 350 && minute < 510) return 120;
  return 90;
}

/** 供药储罐 */
function tankStorage(tankId: string): string {
  return tankId === 'CT-01' ? 'SS-01' : 'SS-02';
}


/** 投加区间切割点：整点 + 事件时刻 */
const cutMinutes = new Set<number>();
for (let m = 0; m <= 1440; m += 60) cutMinutes.add(m);
for (const m of [350, 390, 400, 430, 510, 663, 730, 810, 850, 870, 910, 990, 1030, 1230, 400, 580, 1180]) cutMinutes.add(m);
for (const tr of transfers) cutMinutes.add((tr.at - D0) / MIN);
for (const pc of pumpCalibrations) {
  cutMinutes.add((pc.at - D0) / MIN);
  if (pc.invalid !== null) cutMinutes.add((pc.invalid - D0) / MIN);
}
const cuts = [...cutMinutes].filter((m) => m >= 0 && m <= 1440).sort((a, b) => a - b);

interface PulseRow {
  pulseId: string;
  tank: string;
  pump: string;
  from: number;
  to: number;
  setpoint: number;
  pulseVolume: number;
  pulseCount: number;
  avgFlow: number;
  note: string;
}

const pulses: PulseRow[] = [];
const dosingLog: { tank: string; from: number; to: number; volumeL: number; conc: number }[] = [];

/** 供药储罐的液位游标（投加 + 转罐/稀释按时间推进） */
const storageCursor = freshStorage();

for (const tankId of ['CT-01', 'CT-02']) {
  const pump = tankId === 'CT-01' ? 'P-01' : 'P-02';
  const storage = tankStorage(tankId);
  const tankTransfers = txSorted.filter((tr) => tr.storage === storage);
  let txCursor = 0;
  let index = 0;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const m0 = cuts[i];
    const m1 = cuts[i + 1];
    const from = D0 + m0 * MIN;
    const to = D0 + m1 * MIN;
    const st = storageCursor[storage];
    while (txCursor < tankTransfers.length && tankTransfers[txCursor].at <= from) {
      applyTransfer(st, tankTransfers[txCursor]);
      txCursor += 1;
    }
    const sp = setpoint(tankId, m0);
    const nominalVolume = (sp * (m1 - m0)) / 60;
    let volume = nominalVolume;
    let note = '';
    const starving = tankId === 'CT-02' && m0 >= 660 && m0 < 730;
    if (starving) {
      note = '投加罐抽空，泵空转；脉冲计数按实际流量计输出记录。';
      const trickle = Math.min(st.volumeL, nominalVolume * 0.04);
      volume = Math.max(0, trickle);
    }
    if (volume > st.volumeL) {
      note = note || '储罐液位不足，脉冲数按实际计量记录。';
      volume = Math.max(0, st.volumeL);
    }
    // 脉冲体积取该时刻有效的泵校准（CT-02 09:40 失效期间仍记录旧值，仅标记 invalid）
    let pulseVolume = tankId === 'CT-01' ? 12.0 : 10.0;
    for (const pc of pumpCalibrations) {
      if (pc.tank !== tankId) continue;
      if (pc.at <= from && (pc.invalid === null || pc.invalid > from)) pulseVolume = pc.volumeMl;
    }
    const pulseCount = Math.round((volume * 1000) / pulseVolume);
    const actualVolume = (pulseCount * pulseVolume) / 1000;
    st.volumeL = Math.max(0, st.volumeL - actualVolume);
    pulses.push({
      pulseId: `${tankId}-PLS-${String(index).padStart(3, '0')}`,
      tank: tankId,
      pump,
      from,
      to,
      setpoint: sp,
      pulseVolume,
      pulseCount,
      avgFlow: Math.round(profileFor(tankId).flow(m0) * 10) / 10,
      note,
    });
    if (actualVolume > 0) dosingLog.push({ tank: tankId, from, to, volumeL: actualVolume, conc: 0 });
    index += 1;
  }
}

/** 时间轴重放：转移/稀释 + 投加抽液（同一顺序），得到每次转移后的浓度与每段投加的取液浓度 */
const transferResult: Record<string, { conc: number; volume: number }> = {};
const dosingConcentration: number[] = [];
{
  const cursor = freshStorage();
  const events: { at: number; order: number; run: () => void }[] = [];
  for (const tr of txSorted) {
    events.push({
      at: tr.at,
      order: 0,
      run: () => {
        applyTransfer(cursor[tr.storage], tr);
        transferResult[tr.id] = {
          conc: Number(cursor[tr.storage].conc.toFixed(3)),
          volume: Math.round(cursor[tr.storage].volumeL),
        };
      },
    });
  }
  dosingLog.forEach((dose, i) => {
    const st = cursor[tankStorage(dose.tank)];
    events.push({
      at: dose.from,
      order: 1,
      run: () => {
        dosingConcentration[i] = Number(st.conc.toFixed(3));
        st.volumeL = Math.max(0, st.volumeL - dose.volumeL);
      },
    });
  });
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const e of events) e.run();
  dosingLog.forEach((dose, i) => {
    dose.conc = dosingConcentration[i] ?? cursor[tankStorage(dose.tank)].conc;
  });
}

function profileFor(tankId: string): TankProfile {
  return tankId === 'CT-01' ? ct01 : ct02;
}

// ------------------------------ 化验 ------------------------------

const labs: (string | number)[][] = [
  ['L-1101', 'CT-01', 'IN-01', 'INFLUENT', isoLocal(H(2, 0)), isoLocal(H(6, 10)), '126.4', '30.2', '', '', '0.04', '厂内化验室', '夜班进水样。'],
  ['L-1102', 'CT-01', 'OUT-01', 'EFFLUENT', isoLocal(H(2, 50)), isoLocal(H(6, 20)), '47.8', '19.6', '9.1', '', '0.05', '厂内化验室', '夜班出水样。'],
  ['L-1103', 'CT-01', 'OUT-01', 'EFFLUENT', isoLocal(H(6, 30)), isoLocal(H(9, 5)), '121.7', '22.4', '42.6', '', '0.05', '厂内化验室', '暴雨段出水样，确认去除率下降。'],
  ['L-1104', 'CT-01', 'SS-01', 'CHEMICAL', isoLocal(H(6, 55)), isoLocal(H(8, 30)), '', '', '', '38.6', '0.02', '厂内化验室', '稀释后药剂浓度，用于核对混合比例。'],
  ['L-1105', 'CT-01', 'OUT-01', 'EFFLUENT', isoLocal(H(21, 0)), isoLocal(H(23, 40)), '58.9', '23.3', '10.4', '', '0.05', '厂内化验室', '低温段出水样。'],
  ['L-1106', 'CT-02', 'OUT-02', 'EFFLUENT', isoLocal(H(8, 40)), isoLocal(H(11, 30)), '45.2', '18.1', '8.3', '', '0.05', '厂内化验室', '白班出水样。'],
  ['L-1107', 'CT-02', 'OUT-02', 'EFFLUENT', isoLocal(H(18, 40)), isoLocal(H(21, 0)), '47.1', '18.9', '8.6', '', '0.05', '厂内化验室', '晚班出水样。'],
];

const lateLabs: (string | number)[][] = [
  ['L-1201', 'CT-02', 'OUT-02', 'EFFLUENT', isoLocal(H(10, 15)), isoLocal(Date.UTC(2026, 10, 19, 7, 20) - SHANGHAI), '52.4', '19.5', '9.4', '', '0.05', '第三方实验室', '10:15 取样，11-19 15:20 才收到结果；需形成新的复盘候选。'],
  ['L-1202', 'CT-01', 'OUT-01', 'EFFLUENT', isoLocal(H(20, 30)), isoLocal(Date.UTC(2026, 10, 19, 7, 30) - SHANGHAI), '60.2', '24.0', '10.9', '', '0.05', '第三方实验室', '低温段留样复测，结果迟到。'],
  ['L-1203', 'CT-01', 'SS-01', 'CHEMICAL', isoLocal(H(7, 0)), isoLocal(Date.UTC(2026, 10, 19, 7, 30) - SHANGHAI), '', '', '', '38.4', '0.02', '第三方实验室', '转罐混配后药剂浓度复测，结果迟到。'],
];

// ------------------------------ 班次处置 ------------------------------

const shiftActions = [
  { id: 'SA-01', shift: 'S-NIGHT', plant: 'P1', at: H(3, 45), by: '夜班值班长', category: 'CONDITION_SHIFT', text: '搅拌器停机，已切换备用搅拌并通知检修；本班出水只作参考，不参与效率排名。', refs: 'MX-01' },
  { id: 'SA-02', shift: 'S-NIGHT', plant: 'P1', at: H(6, 10), by: '夜班值班长', category: 'CONDITION_SHIFT', text: '暴雨来袭，提高投加设定至 26 L/h，加密取样；记录进水浊度与流量。', refs: 'UP-01' },
  { id: 'SA-03', shift: 'S-NIGHT', plant: 'P1', at: H(6, 55), by: '夜班值班长', category: 'METERING_UNCERTAIN', text: '储罐稀释后浓度按混合比例折算，已留药剂样送检。', refs: 'TR-01' },
  { id: 'SA-04', shift: 'S-DAY', plant: 'P1', at: H(9, 45), by: '白班值班长', category: 'METERING_UNCERTAIN', text: 'CT-02 脉冲计数器故障，暂停按单位药耗排名，等待重新校准。', refs: 'PC-02' },
  { id: 'SA-05', shift: 'S-DAY', plant: 'P1', at: H(11, 10), by: '白班值班长', category: 'FEED_SHORTAGE', text: 'CT-02 投加罐抽空，已降负荷并安排转罐补料。', refs: 'ST-02-DRY' },
  { id: 'SA-06', shift: 'S-DAY', plant: 'P1', at: H(12, 20), by: '白班值班长', category: 'SAMPLING_PENDING', text: '10:15 出水样已送第三方，结果未回；本段效率结论待结果。', refs: 'L-1201' },
  { id: 'SA-07', shift: 'S-EVENING', plant: 'P1', at: H(16, 35), by: '晚班值班长', category: 'CONDITION_SHIFT', text: '出水旁路开启，混凝段退出运行，配对只给范围并停止排名。', refs: 'BP-01' },
];

// ------------------------------ 写文件 ------------------------------

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const files: { fileName: string; kind: string; text: string; note: string; receivedAt: number }[] = [];

function addFile(fileName: string, kind: string, headers: string[], rows: (string | number)[][], note: string, receivedAt: number): void {
  files.push({ fileName, kind, text: serialCsv(headers, rows), note, receivedAt });
}

const receivedBase = Date.UTC(2026, 10, 19, 7, 0) - SHANGHAI; // 2026-11-19 07:00

addFile('plants.csv', 'PLANTS', ['plant_id', 'name', 'short_name'], plants, '厂站台账', receivedBase);
addFile(
  'tanks.csv',
  'TANKS',
  ['tank_id', 'plant_id', 'name', 'effective_volume_m3', 'min_residence_s', 'max_residence_s', 'recycle_ratio', 'inlet_point_code', 'outlet_point_code', 'volume_uncertainty', 'storage_id', 'note'],
  tanks.map((t) => [t.tankId, t.plantId, t.name, t.volume, t.minRes, t.maxRes, t.recycle, t.inlet, t.outlet, t.volumeU, t.storage, t.note]),
  '混凝池有效池容、允许停留时间范围、回流比例与进出水点位映射',
  receivedBase,
);
addFile(
  'points.csv',
  'POINTS',
  ['point_code', 'tank_id', 'plant_id', 'role', 'name', 'metrics', 'clock_offset_ms', 'clock_offset_uncertainty_ms', 'nominal_interval_seconds', 'value_uncertainty', 'note'],
  points.map((p) => [p.code, p.tank, 'P1', p.role, p.name, p.metrics, p.off, p.offU, p.nominal, p.unc, `${p.name}；传感器时间偏移 ${p.off > 0 ? '+' : ''}${p.off / 1000} s。`]),
  '进出口点位与传感器时间偏移',
  receivedBase,
);
addFile('storage_tanks.csv', 'STORAGE', ['storage_id', 'plant_id', 'name', 'capacity_l', 'note'], storages.map((s) => [s.storageId, s.plantId, s.name, s.capacityL, s.note]), '储罐台账', receivedBase);
addFile(
  'batches.csv',
  'BATCHES',
  ['batch_id', 'plant_id', 'product_name', 'nominal_concentration', 'concentration_uncertainty', 'manufactured_at', 'received_at', 'received_volume_l', 'supplier', 'certificate', 'note'],
  batches.map((b) => [b.batchId, b.plantId, b.product, b.conc, b.concU, isoLocal(b.manuf), isoLocal(b.received), b.volume, b.supplier, b.cert, b.note]),
  '药剂批次账（浓度、入库时刻与入库量）',
  receivedBase,
);
addFile(
  'transfers.csv',
  'TRANSFERS',
  ['transfer_id', 'plant_id', 'storage_id', 'kind', 'at', 'batch_id', 'volume_l', 'resulting_concentration', 'note', 'recorded_by'],
  transfers.map((t) => [t.id, 'P1', t.storage, t.kind, isoLocal(t.at), t.batch, t.volume, transferResult[t.id].conc, t.note, t.by]),
  '转罐/稀释记录（resulting_concentration 为动作后按混合比例算出的浓度）',
  receivedBase,
);
addFile(
  'stocktakes.csv',
  'STOCKTAKES',
  ['stocktake_id', 'storage_id', 'at', 'volume_l', 'concentration_g_per_l', 'measured_by'],
  stocktakes.map((s) => [s.id, s.storage, isoLocal(s.at), s.volume, s.conc, s.by]),
  '储罐盘点',
  receivedBase,
);
addFile(
  'pulses.csv',
  'PULSES',
  ['pulse_id', 'tank_id', 'pump_id', 'from', 'to', 'setpoint_lh', 'pulse_volume_ml', 'pulse_count', 'average_flow_m3h', 'note'],
  pulses.map((p) => [p.pulseId, p.tank, p.pump, isoLocal(p.from), isoLocal(p.to), p.setpoint, p.pulseVolume, p.pulseCount, p.avgFlow, p.note]),
  '泵脉冲/设定值履历（实际投加证据）',
  receivedBase,
);
addFile(
  'pump_calibrations.csv',
  'PUMP_CALIBRATIONS',
  ['pump_calibration_id', 'tank_id', 'pump_id', 'effective_at', 'invalidated_at', 'pulse_volume_ml', 'uncertainty', 'operator', 'certificate', 'note'],
  pumpCalibrations.map((p) => [p.id, p.tank, p.pump, isoLocal(p.at), p.invalid === null ? '' : isoLocal(p.invalid), p.volumeMl, p.unc, p.operator, p.cert, p.note]),
  '泵校准（可在班中生效/失效）',
  receivedBase,
);
addFile(
  'bypass.csv',
  'BYPASS',
  ['bypass_id', 'tank_id', 'from', 'to', 'direction', 'fraction', 'reason', 'work_order', 'recorded_by'],
  bypasses.map((b) => [b.bypassId, b.tank, isoLocal(b.from), isoLocal(b.to), b.direction, b.fraction, b.reason, b.workOrder, b.by]),
  '旁路状态',
  receivedBase,
);
addFile(
  'mixing.csv',
  'MIXING',
  ['mixing_id', 'tank_id', 'from', 'to', 'state', 'reason', 'work_order'],
  mixing.map((m) => [m.mixingId, m.tank, isoLocal(m.from), isoLocal(m.to), m.state, m.reason, m.workOrder]),
  '搅拌状态',
  receivedBase,
);
addFile(
  'upsets.csv',
  'UPSETS',
  ['upset_id', 'tank_id', 'from', 'to', 'kind', 'severity', 'note'],
  upsets.map((u) => [u.upsetId, u.tank, isoLocal(u.from), isoLocal(u.to), u.kind, u.severity, u.note]),
  '工况突变事件（暴雨/低温/浊度突升等）',
  receivedBase,
);
addFile(
  'labs.csv',
  'LABS',
  ['lab_id', 'tank_id', 'point_code', 'kind', 'sampled_at', 'received_at', 'cod_mg_l', 'nh3n_mg_l', 'turbidity_ntu', 'chemical_concentration_g_per_l', 'uncertainty', 'lab_name', 'note'],
  labs,
  '化验结果（基础批次）',
  receivedBase,
);
addFile(
  'shifts.csv',
  'SHIFTS',
  ['shift_id', 'plant_id', 'code', 'name', 'start_minute', 'end_minute'],
  shifts.map((s) => [s.shiftId, s.plantId, s.code, s.name, s.start, s.end]),
  '班次定义（本地时刻，分钟）',
  receivedBase,
);
addFile(
  'shift_actions.csv',
  'SHIFT_ACTIONS',
  ['action_id', 'shift_id', 'plant_id', 'at', 'recorded_by', 'category', 'text', 'ref_ids'],
  shiftActions.map((a) => [a.id, a.shift, a.plant, isoLocal(a.at), a.by, a.category, a.text, a.refs]),
  '当班处置记录（不可改写）',
  receivedBase,
);
addFile(
  'readings_CT-01.csv',
  'READINGS',
  ['reading_id', 'point_code', 'metric', 'sampled_at', 'raw_value', 'received_at', 'quality_flag'],
  readingsFor('CT-01', ct01),
  'CT-01 进出口在线读数',
  receivedBase,
);
addFile(
  'readings_CT-02.csv',
  'READINGS',
  ['reading_id', 'point_code', 'metric', 'sampled_at', 'raw_value', 'received_at', 'quality_flag'],
  readingsFor('CT-02', ct02),
  'CT-02 进出口在线读数',
  receivedBase,
);

/** 期末物料：按与上面相同的单一时间轴重放（转移/稀释 + 投加抽液），返回期末体积与浓度 */
function endState(storageId: string): { volume: number; conc: number } {
  const cursor = freshStorage();
  const events: { at: number; order: number; run: () => void }[] = [];
  for (const tr of txSorted) {
    if (tr.storage !== storageId) continue;
    events.push({ at: tr.at, order: 0, run: () => applyTransfer(cursor[tr.storage], tr) });
  }
  for (const dose of dosingLog) {
    if (tankStorage(dose.tank) !== storageId) continue;
    events.push({
      at: dose.from,
      order: 1,
      run: () => {
        const st = cursor[storageId];
        st.volumeL = Math.max(0, st.volumeL - dose.volumeL);
      },
    });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const e of events) e.run();
  return { volume: cursor[storageId].volumeL, conc: cursor[storageId].conc };
}

const endStock: Record<string, { volume: number; conc: number }> = {};
for (const id of ['SS-BULK', 'SS-01', 'SS-02']) {
  const st = endState(id);
  // 期末盘点：浓度读数带固定的极小误差（确定性），用于核对库存平衡
  const measuredConc = Number((st.conc * CONC_NOISE[id]).toFixed(2));
  endStock[id] = { volume: Math.round((st.volume * st.conc) / measuredConc), conc: measuredConc };
}
stocktakes.push(
  { id: 'ST-01-CLOSE', storage: 'SS-01', at: H(23, 50), volume: endStock['SS-01'].volume, conc: endStock['SS-01'].conc, by: '晚班盘点' },
  { id: 'ST-02-CLOSE', storage: 'SS-02', at: H(23, 50), volume: endStock['SS-02'].volume, conc: endStock['SS-02'].conc, by: '晚班盘点' },
  { id: 'ST-BULK-CLOSE', storage: 'SS-BULK', at: H(23, 50), volume: endStock['SS-BULK'].volume, conc: endStock['SS-BULK'].conc, by: '库房盘点' },
);
// 重新写盘点文件（期末盘点在上一步之后才确定）
const stockFile = files.find((f) => f.fileName === 'stocktakes.csv')!;
stockFile.text = serialCsv(
  ['stocktake_id', 'storage_id', 'at', 'volume_l', 'concentration_g_per_l', 'measured_by'],
  stocktakes.map((s) => [s.id, s.storage, isoLocal(s.at), s.volume, s.conc, s.by]),
);

// 迟到化验文件
const lateText = serialCsv(
  ['lab_id', 'tank_id', 'point_code', 'kind', 'sampled_at', 'received_at', 'cod_mg_l', 'nh3n_mg_l', 'turbidity_ntu', 'chemical_concentration_g_per_l', 'uncertainty', 'lab_name', 'note'],
  lateLabs,
);

mkdirSync(outDir, { recursive: true });
for (const f of files) writeFileSync(resolve(outDir, f.fileName), f.text, 'utf8');
writeFileSync(resolve(outDir, 'late_labs_2026-11-19.csv'), lateText, 'utf8');

const baseFiles = files.map((f) => ({
  fileName: f.fileName,
  kind: f.kind,
  rowCount: f.text.trim().split('\n').length - 1,
  sha256: sha(f.text),
  receivedAt: f.receivedAt,
  note: f.note,
}));

const manifest = {
  name: '混凝剂投加效率复核样例（虚构）',
  description: '2026-11-18 一厂两个混凝池的进出口在线读数、旁路/搅拌/工况事件、药剂批次与库存转移、泵脉冲与校准、化验与班次处置。',
  generatedAt: '2026-11-20T02:00:00.000Z',
  timezone: 'Asia/Shanghai',
  day: DAY,
  baseFiles,
  lateFile: {
    fileName: 'late_labs_2026-11-19.csv',
    kind: 'LATE_BATCH',
    rowCount: lateText.trim().split('\n').length - 1,
    sha256: sha(lateText),
    receivedAt: Date.UTC(2026, 10, 19, 7, 30) - SHANGHAI,
    note: '迟到化验：11-19 15:20/15:30 到达，晚于复盘截止（11-19 08:00）。',
  },
  focus: {
    plantId: 'P1',
    tankId: 'CT-01',
    day: DAY,
    reviewCutoffReceivedAt: Date.UTC(2026, 10, 19, 5, 0) - SHANGHAI,
    scenario: [
      '暴雨：05:50–08:30 进水浊度与流量抬升，同投加量下去除率下降',
      '搅拌停止 03:30–05:00；浊度突升 13:30–14:30',
      '出水旁路 16:30–17:10：配对只给范围，停止与正常段排名',
      '储罐 06:40 稀释、07:10 转罐混配：浓度按混合比例追踪',
      'CT-02 泵校准 09:40 失效、10:20 重新校准：期间投加量只有范围',
      'CT-02 投加罐 11:03 抽空、12:10 转罐补料：缺料异常',
      '迟到化验（11-19 15:20 到达）只形成新的复盘候选，不改写当班处置',
    ],
  },
};

writeFileSync(resolve(outDir, 'coag-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const readingRows = files.filter((f) => f.kind === 'READINGS').reduce((a, f) => a + f.text.trim().split('\n').length - 1, 0);
console.log(`混凝样例已生成：${outDir}`);
console.log(`基础文件 ${files.length} 份；读数 ${readingRows} 行；迟到化验 ${lateLabs.length} 行；泵脉冲 ${pulses.length} 段`);
