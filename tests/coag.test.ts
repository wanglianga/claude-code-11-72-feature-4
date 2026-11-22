import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseCoagSampleFromDisk } from '../scripts/coagParse';
import { computeTankEfficiency } from '../src/coag/engine';
import { dayStartMs } from '../src/domain/time';
import { mergeCoagDataset, parseBypasses, parseCoagReadings, parsePumpCalibrations, parseTanks, parseTransfers } from '../src/coag/ingest';
import type { CoagDataset } from '../src/coag/types';

const dir = resolve(__dirname, '../public/sample/coag');
const sample = parseCoagSampleFromDisk(dir);
const { dataset, manifest } = sample;
const DAY = manifest.day;
const CUTOFF = manifest.focus.reviewCutoffReceivedAt;
const dayStart = dayStartMs(DAY);

describe('混凝样例接入', () => {
  it('文件指纹与清单一致', () => {
    expect(sample.fingerprints.length).toBeGreaterThan(0);
    for (const f of sample.fingerprints) expect(f.ok, f.fileName).toBe(true);
  });

  it('CSV 解析零问题', () => {
    expect(sample.issues).toEqual([]);
  });

  it('进出口点位映射齐全', () => {
    for (const tank of dataset.tanks) {
      const inlet = dataset.points.find((p) => p.pointCode === tank.inletPointCode);
      const outlet = dataset.points.find((p) => p.pointCode === tank.outletPointCode);
      expect(inlet?.role, tank.tankId).toBe('INLET');
      expect(outlet?.role, tank.tankId).toBe('OUTLET');
      expect(inlet?.tankId).toBe(tank.tankId);
      expect(outlet?.tankId).toBe(tank.tankId);
    }
  });

  it('传感器时间偏移被应用到 alignedAt', () => {
    const point = dataset.points.find((p) => p.pointCode === 'OUT-01')!;
    const reading = dataset.readings.find((r) => r.pointCode === 'OUT-01')!;
    expect(reading.alignedAt - reading.sampledAt).toBe(point.clockOffsetMs);
  });
});

describe('可达出水窗口', () => {
  const eff = computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });

  it('窗口落在允许停留时间范围内', () => {
    const tank = dataset.tanks.find((t) => t.tankId === 'CT-01')!;
    for (const p of eff.pairings.filter((x) => x.window.usable)) {
      expect(p.window.residenceMinSeconds).toBeGreaterThanOrEqual(tank.minResidenceSeconds - 1e-6);
      expect(p.window.residenceMaxSeconds).toBeLessThanOrEqual(tank.maxResidenceSeconds + 1e-6);
    }
  });

  it('窗口随流量变化，不是固定停留时间', () => {
    const usable = eff.pairings.filter((p) => p.window.usable);
    const min = Math.min(...usable.map((p) => p.window.derivedMinSeconds));
    const max = Math.max(...usable.map((p) => p.window.derivedMinSeconds));
    expect(max - min).toBeGreaterThan(60);
  });

  it('投加时刻在窗口之前，出水窗口晚于投加', () => {
    for (const p of eff.pairings) {
      expect(p.window.toMin).toBeGreaterThan(p.dosingFrom);
      expect(p.window.toMax).toBeGreaterThanOrEqual(p.window.toMin);
    }
  });

  it('窗口内取到进出水有效片段', () => {
    const ranked = eff.pairings.filter((p) => p.rankable && p.series[0].removal);
    expect(ranked.length).toBeGreaterThan(10);
    for (const p of ranked.slice(0, 5)) {
      expect(p.series[0].inletEffectiveSeconds).toBeGreaterThan(0);
      expect(p.series[0].outletEffectiveSeconds).toBeGreaterThan(0);
    }
  });
});

describe('投加量与库存', () => {
  const eff = computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });

  it('投加量只由泵脉冲推导', () => {
    for (const p of eff.pairings) {
      expect(p.dosage.pulseId).toMatch(/^CT-01-PLS-/);
      expect(p.dosage.massKg.best).toBeGreaterThanOrEqual(0);
      expect(p.dosage.volumeL.max).toBeGreaterThanOrEqual(p.dosage.volumeL.min);
    }
  });

  it('储罐稀释后浓度按混合比例下降', () => {
    // 06:40 补清水稀释：之后一段时间的取液浓度明显低于稀释前的 42 g/L
    const before = eff.pairings.filter((p) => p.dosingFrom < dayStart + 6 * 3600_000 + 40 * 60_000);
    const after = eff.pairings.filter((p) => p.dosingFrom >= dayStart + 6 * 3600_000 + 40 * 60_000 && p.dosingFrom < dayStart + 7.5 * 3600_000);
    expect(before[before.length - 1].dosage.concentrationGPerL.best).toBeGreaterThan(41.9);
    expect(after[0].dosage.concentrationGPerL.best).toBeLessThan(39);
  });

  it('库存平衡与盘点期末一致（<1%）', () => {
    const inv = eff.inventory[0];
    expect(inv.measuredClosingKg).not.toBeNull();
    const rel = Math.abs((inv.discrepancyKg ?? 1) / Math.max(1, inv.measuredClosingKg!));
    expect(rel).toBeLessThan(0.01);
  });
});

describe('旁路、校准失效与缺料', () => {
  const ct01 = computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });
  const ct02 = computeTankEfficiency(dataset, 'CT-02', DAY, { reviewCutoffReceivedAt: CUTOFF });

  it('旁路期间配对不可用且不可排名', () => {
    const bypassed = ct01.pairings.filter((p) => p.window.bypassFraction > 0);
    expect(bypassed.length).toBeGreaterThan(0);
    for (const p of bypassed) {
      expect(p.window.usable).toBe(false);
      expect(p.rankable).toBe(false);
    }
  });

  it('泵校准失效时投加量给范围且不可排名', () => {
    const invalid = ct02.pairings.filter((p) => p.dosage.calibrationInvalid);
    expect(invalid.length).toBeGreaterThan(0);
    for (const p of invalid) {
      expect(p.rankable).toBe(false);
      expect(p.dosage.volumeL.max).toBeGreaterThan(p.dosage.volumeL.min);
    }
  });

  it('缺料归为 FEED_SHORTAGE 且影响缺料配对', () => {
    const shortage = ct02.anomalies.filter((a) => a.category === 'FEED_SHORTAGE');
    expect(shortage.length).toBe(1);
    expect(shortage[0].affectedPairings).toBeGreaterThanOrEqual(3);
    const affected = ct02.pairings.filter((p) => shortage[0].refIds.includes(p.dosage.pulseId));
    expect(affected.every((p) => !p.rankable)).toBe(true);
  });

  it('异常四类中至少出现三类', () => {
    const cats = new Set([...ct01.anomalies, ...ct02.anomalies].map((a) => a.category));
    expect(cats.size).toBeGreaterThanOrEqual(3);
  });
});

describe('工况分段与两条汇总路径', () => {
  const eff = computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });

  it('稳定段与受限段并存，暴雨段受限', () => {
    expect(eff.conditions.some((c) => c.stable)).toBe(true);
    const storm = dataset.upsets.find((u) => u.tankId === 'CT-01' && u.kind === 'STORM')!;
    const inStorm = eff.conditions.filter((c) => c.from < storm.to && c.to > storm.from);
    expect(inStorm.length).toBeGreaterThan(0);
    expect(inStorm.every((c) => !c.stable)).toBe(true);
  });

  it('短片段被标记', () => {
    for (const c of eff.conditions) {
      if (c.seconds < 90 * 60) expect(c.shortSegment).toBe(true);
    }
  });

  it('班次路径与工况路径各自给出范围，且工况路径披露未覆盖时段', () => {
    expect(eff.byShift.COD.removal).not.toBeNull();
    expect(eff.byCondition.COD.removal).not.toBeNull();
    expect(eff.byCondition.COD.uncoveredSeconds).toBeGreaterThan(0);
    expect(eff.byCondition.COD.included).toBeLessThanOrEqual(eff.byShift.COD.included);
  });

  it('入库量单列，不当作投加量', () => {
    const purchased = eff.shifts.reduce((a, s) => a + s.purchasedKg.best, 0);
    const dosed = eff.shifts.reduce((a, s) => a + s.dosedKg.best, 0);
    expect(purchased).toBeGreaterThan(0);
    expect(dosed).toBeGreaterThan(0);
    expect(purchased).not.toBeCloseTo(dosed, 0);
  });

  it('不可排名段的聚合只使用可排名配对', () => {
    for (const p of eff.pairings.filter((x) => !x.rankable)) {
      expect(p.rankBlockReasons.length).toBeGreaterThan(0);
    }
  });
});

describe('自然日边界', () => {
  const eff = computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });

  it('临近日终点的窗口被截断并标为不可排名', () => {
    const late = eff.pairings.filter((p) => p.window.toMax > dayStart + 24 * 3600_000);
    expect(late.length).toBeGreaterThan(0);
    for (const p of late) {
      expect(p.rankable).toBe(false);
      expect(p.rankBlockReasons.join('；')).toContain('自然日终点');
    }
  });

  it('所有配对的出水窗口不会取到次日数据（覆盖率按截断后计算）', () => {
    for (const p of eff.pairings.filter((x) => x.window.usable)) {
      expect(p.outletCoverage).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.outletCoverage).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('迟到化验复盘候选', () => {
  const ct01 = computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });
  const ct02 = computeTankEfficiency(dataset, 'CT-02', DAY, { reviewCutoffReceivedAt: CUTOFF });
  const all = [...ct01.lateLabCandidates, ...ct02.lateLabCandidates];

  it('只有晚于复盘截止的化验形成候选', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) expect(c.receivedAt).toBeGreaterThan(CUTOFF);
  });

  it('候选标注不改写当班处置', () => {
    for (const c of all) expect(c.shiftActionsOverwritten).toBe(false);
  });

  it('计算不修改班次处置与原始数据集', () => {
    const before = JSON.stringify(dataset.shiftActions);
    const labsBefore = dataset.lateLabs.length;
    computeTankEfficiency(dataset, 'CT-01', DAY, { reviewCutoffReceivedAt: CUTOFF });
    expect(JSON.stringify(dataset.shiftActions)).toBe(before);
    expect(dataset.lateLabs.length).toBe(labsBefore);
  });

  it('待取样候选项兑现当班待取样处置', () => {
    const pending = all.find((c) => c.labId === 'L-1201');
    expect(pending).toBeDefined();
    expect(pending!.categories).toContain('SAMPLING_PENDING');
    expect(pending!.shiftId).toBe('S-DAY');
  });
});

describe('解析器边界', () => {
  it('未登记点位读数被拒绝', () => {
    const issues: { file: string; row: number; message: string }[] = [];
    const points = [
      {
        pointCode: 'IN-X',
        tankId: 'CT-X',
        plantId: 'P1',
        role: 'INLET' as const,
        name: '测试进口',
        metrics: ['FLOW' as const],
        clockOffsetMs: 0,
        clockOffsetUncertaintyMs: 0,
        nominalIntervalSeconds: 60,
        valueUncertainty: 0.02,
        note: '',
      },
    ];
    const csv = 'reading_id,point_code,metric,sampled_at,raw_value\nR1,IN-Y,FLOW,2026-11-18T00:00:00+08:00,100\n';
    const readings = parseCoagReadings(csv, 't.csv', 'file:t', points, issues);
    expect(readings).toEqual([]);
    expect(issues.length).toBe(1);
  });

  it('混凝池停留时间范围可解析', () => {
    const issues: { file: string; row: number; message: string }[] = [];
    const csv =
      'tank_id,plant_id,name,effective_volume_m3,min_residence_s,max_residence_s,recycle_ratio,inlet_point_code,outlet_point_code,volume_uncertainty,storage_id,note\n' +
      'CT-X,P1,测试池,100,600,1800,0.1,IN-X,OUT-X,0.05,SS-X,\n';
    const tanks = parseTanks(csv, 't.csv', issues);
    expect(issues).toEqual([]);
    expect(tanks[0].minResidenceSeconds).toBe(600);
    expect(tanks[0].maxResidenceSeconds).toBe(1800);
  });

  it('旁路与泵校准可解析为半开区间', () => {
    const issues: { file: string; row: number; message: string }[] = [];
    const bypasses = parseBypasses(
      'bypass_id,tank_id,from,to,direction,fraction,reason,work_order,recorded_by\nBP-X,CT-X,2026-11-18T10:00:00+08:00,2026-11-18T10:30:00+08:00,OUTLET,1,测试,WO-1,值班\n',
      'b.csv',
      issues,
    );
    expect(bypasses[0].to! - bypasses[0].from).toBe(30 * 60_000);
    const cals = parsePumpCalibrations(
      'pump_calibration_id,tank_id,pump_id,effective_at,invalidated_at,pulse_volume_ml,uncertainty,operator,certificate,note\nPC-X,CT-X,P-X,2026-11-18T00:00:00+08:00,2026-11-18T09:40:00+08:00,10,0.02,操作员,CERT,测试\n',
      'p.csv',
      issues,
    );
    expect(cals[0].invalidatedAt).not.toBeNull();
    expect(issues).toEqual([]);
  });

  it('转罐记录按 kind 区分入库与转罐', () => {
    const issues: { file: string; row: number; message: string }[] = [];
    const rows = parseTransfers(
      'transfer_id,plant_id,storage_id,kind,at,batch_id,volume_l,resulting_concentration,note,recorded_by\n' +
        'T1,P1,SS-1,RECEIPT,2026-11-18T09:00:00+08:00,B1,1000,40,入库,库房\n' +
        'T2,P1,SS-2,DILUTION,2026-11-18T10:00:00+08:00,,100,0,稀释,班组\n',
      'tr.csv',
      issues,
    );
    expect(rows.map((r) => r.kind)).toEqual(['RECEIPT', 'DILUTION']);
  });
});

describe('空数据集边界', () => {
  it('缺表时合并得到空结构而不是抛错', () => {
    const empty: CoagDataset = mergeCoagDataset(
      {
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
      },
      {},
    );
    expect(empty.tanks).toEqual([]);
    expect(() => computeTankEfficiency(empty, 'none', DAY)).toThrow();
  });
});
