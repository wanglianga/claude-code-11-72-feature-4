/**
 * Node 侧混凝样例装载：直接读 CSV 并复用浏览器同一套解析器（src/coag/ingest.ts）。
 * verify-coag 与 coag 单元测试共用，保证“脚本核验”和“界面导入”走同一条解析路径。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mergeCoagDataset, parseCoagBundle, parseLateLabs } from '../src/coag/ingest';
import type { CoagDataset, CoagManifest } from '../src/coag/types';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface CoagSampleBundle {
  baseDataset: CoagDataset;
  lateLabs: CoagDataset['lateLabs'];
  dataset: CoagDataset;
  manifest: CoagManifest;
  fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[];
  issues: { file: string; row: number; message: string }[];
}

export function parseCoagSampleFromDisk(dir: string): CoagSampleBundle {
  const manifest = JSON.parse(readFileSync(resolve(dir, 'coag-manifest.json'), 'utf8')) as CoagManifest;
  const read = (fileName: string) => readFileSync(resolve(dir, fileName), 'utf8');
  const sha = (fileName: string) => sha256File(resolve(dir, fileName));

  const fingerprints = manifest.baseFiles.map((f) => {
    const actual = sha(f.fileName);
    return { fileName: f.fileName, expected: f.sha256, actual, ok: actual === f.sha256 };
  });
  const late = parseLateLabs(manifest, read, sha);
  if (manifest.lateFile) {
    fingerprints.push({
      fileName: manifest.lateFile.fileName,
      expected: manifest.lateFile.sha256,
      actual: late.sha,
      ok: late.sha === manifest.lateFile.sha256,
    });
  }

  const { dataset: baseDataset, issues } = parseCoagBundle(manifest, read, sha);
  const dataset = mergeCoagDataset(baseDataset, { lateLabs: late.labs });
  return { baseDataset, lateLabs: late.labs, dataset, manifest, fingerprints, issues: [...issues, ...late.issues] };
}
