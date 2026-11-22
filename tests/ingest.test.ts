import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SampleManifest } from '../src/domain/types';
import { parseSampleFromDisk } from '../scripts/sampleIo';
import { parseCsv, serializeCsv, isoLocal, parseIso, sha256Hex } from '../src/sample/csv';
import { parseReadings, uniqueReadings, mergeDataset } from '../src/sample/ingest';

const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { baseDataset, lateReadings } = parseSampleFromDisk(sampleDir, manifest);

describe('CSV 解析', () => {
  it('往返序列化保持一致', () => {
    const rows = [{ a: '1', b: 'x,y' }, { a: '2', b: '中' }];
    const text = serializeCsv(['a', 'b'], rows);
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual(rows);
  });

  it('上海本地时间可往返', () => {
    const ms = Date.UTC(2026, 10, 18, 4, 30, 0);
    expect(parseIso(isoLocal(ms))).toBe(ms);
    expect(isoLocal(ms)).toBe('2026-11-18T12:30:00+08:00');
  });

  it('SHA-256 稳定', async () => {
    const a = await sha256Hex('澄川水务');
    const b = await sha256Hex('澄川水务');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('读数入库', () => {
  it('未登记仪表会被拒绝并计数', () => {
    const csv = serializeCsv(
      ['reading_id', 'instrument_id', 'metric', 'sampled_at', 'raw_value'],
      [
        { reading_id: 'x1', instrument_id: 'C-CO2', metric: 'COD', sampled_at: isoLocal(Date.UTC(2026, 10, 18, 4, 0, 0)), raw_value: '30' },
        { reading_id: 'x2', instrument_id: 'UNKNOWN', metric: 'COD', sampled_at: isoLocal(Date.UTC(2026, 10, 18, 4, 0, 0)), raw_value: '30' },
      ],
    );
    const parsed = parseReadings(
      csv,
      { fileId: 'f1', kind: 'READINGS', receivedAt: Date.UTC(2026, 10, 18, 5, 0, 0) },
      baseDataset.instruments,
      baseDataset.bindings,
    );
    expect(parsed.readings).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
    expect(parsed.errors[0]).toContain('UNKNOWN');
  });

  it('时钟偏移换算到对齐时间轴并决定自然日', () => {
    const csv = serializeCsv(
      ['reading_id', 'instrument_id', 'metric', 'sampled_at', 'raw_value'],
      [
        {
          reading_id: 'x3',
          instrument_id: 'C-CO2',
          metric: 'COD',
          // 设备时钟慢 2.5 秒（offset +2500），采样 23:59:58 对齐后落在次日
          sampled_at: isoLocal(Date.UTC(2026, 10, 18, 15, 59, 58)),
          raw_value: '30',
        },
      ],
    );
    const parsed = parseReadings(
      csv,
      { fileId: 'f2', kind: 'READINGS', receivedAt: Date.UTC(2026, 10, 18, 16, 5, 0) },
      baseDataset.instruments,
      baseDataset.bindings,
    );
    expect(parsed.readings[0].alignedAt).toBe(Date.UTC(2026, 10, 18, 16, 0, 0) + 500);
  });

  it('重复读数按 receivedAt 取较新的一份', () => {
    const r = baseDataset.readings[0];
    const older = { ...r, receivedAt: r.receivedAt - 1000, rawValue: 1 };
    const newer = { ...r, rawValue: 2 };
    const merged = uniqueReadings([older, newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0].rawValue).toBe(2);
  });

  it('迟到批次并入不改变既有文件快照', () => {
    const before = baseDataset.files.length;
    const merged = mergeDataset(baseDataset, { readings: lateReadings });
    expect(merged.files.length).toBe(before);
    expect(merged.readings.length).toBe(baseDataset.readings.length + lateReadings.length);
  });
});

describe('样例结构', () => {
  it('清单列出的文件均存在', () => {
    for (const f of [...manifest.baseFiles, manifest.lateFile]) {
      expect(() => readFileSync(resolve(sampleDir, f.fileName))).not.toThrow();
    }
  });

  it('迟到文件接收时刻晚于基础批次', () => {
    const baseReceived = Math.max(...baseDataset.files.map((f) => f.receivedAt));
    const lateReceived = Date.parse(manifest.lateFile.receivedAt);
    expect(lateReceived).toBeGreaterThan(baseReceived);
    expect(lateReadings.every((r) => r.receivedAt === lateReceived)).toBe(true);
  });

  it('迟到读数全部落在缺测窗口 02:00–02:03 内', () => {
    const from = Date.UTC(2026, 10, 17, 18, 0, 0);
    const to = Date.UTC(2026, 10, 17, 18, 3, 0);
    for (const r of lateReadings) {
      expect(r.alignedAt).toBeGreaterThanOrEqual(from);
      expect(r.alignedAt).toBeLessThan(to);
    }
  });
});
