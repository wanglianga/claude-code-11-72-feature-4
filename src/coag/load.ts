/**
 * 混凝样例装载：从 /sample/coag 拉取 CSV，浏览器内计算 SHA-256 并与清单比对，
 * 解析后整包写入 IndexedDB（键 coag:sample）。迟到化验批次单独导入。
 */

import { sha256Hex } from '../sample/csv';
import { mergeCoagDataset, parseCoagBundle, parseLateLabs, emptyCoagDataset } from '../coag/ingest';
import type { CoagDataset, CoagManifest } from '../coag/types';
import { putCoagBundle } from '../db/db';

export const COAG_SAMPLE_KEY = 'coag:sample';

export interface CoagLoadProgress {
  step: string;
  done: number;
  total: number;
}

export interface CoagLoadedSample {
  dataset: CoagDataset;
  manifest: CoagManifest;
  fingerprintMatches: { fileName: string; expected: string; actual: string; ok: boolean }[];
  issues: { file: string; row: number; message: string }[];
  warnings: string[];
}

async function fetchText(fileName: string): Promise<{ text: string; size: number; sha: string }> {
  const res = await fetch(`/sample/coag/${encodeURIComponent(fileName)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取 ${fileName}（HTTP ${res.status}）`);
  const text = await res.text();
  return { text, size: new TextEncoder().encode(text).byteLength, sha: await sha256Hex(text) };
}

export async function fetchCoagManifest(): Promise<CoagManifest> {
  const res = await fetch('/sample/coag/coag-manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取混凝样例清单（HTTP ${res.status}）`);
  return (await res.json()) as CoagManifest;
}

export async function loadCoagSample(
  onProgress: (p: CoagLoadProgress) => void,
): Promise<CoagLoadedSample> {
  const manifest = await fetchCoagManifest();
  const total = manifest.baseFiles.length + 2;
  let done = 0;
  const texts = new Map<string, { text: string; sha: string }>();
  const fingerprintMatches: CoagLoadedSample['fingerprintMatches'] = [];
  const warnings: string[] = [];
  for (const meta of manifest.baseFiles) {
    onProgress({ step: `读取 ${meta.fileName}`, done, total });
    const entry = await fetchText(meta.fileName);
    texts.set(meta.fileName, { text: entry.text, sha: entry.sha });
    const ok = entry.sha === meta.sha256;
    fingerprintMatches.push({ fileName: meta.fileName, expected: meta.sha256, actual: entry.sha, ok });
    if (!ok) warnings.push(`${meta.fileName} 指纹与清单不一致（清单 ${meta.sha256.slice(0, 12)}…）`);
    done += 1;
  }
  onProgress({ step: '解析台账与读数', done, total });
  const read = (fileName: string) => texts.get(fileName)?.text ?? '';
  const sha = (fileName: string) => texts.get(fileName)?.sha ?? '';
  const { dataset, issues } = parseCoagBundle(manifest, read, sha);
  done += 1;

  onProgress({ step: '写入本地库', done, total });
  await putCoagBundle(COAG_SAMPLE_KEY, { dataset, manifest });
  onProgress({ step: '完成', done: total, total });
  return { dataset, manifest, fingerprintMatches, issues, warnings };
}

export interface CoagLateImportResult {
  dataset: CoagDataset;
  added: number;
  fingerprint: { expected: string; actual: string; ok: boolean };
  issues: CoagLoadedSample['issues'];
}

/** 导入迟到化验（不并入基础批次） */
export async function importCoagLateLabs(base: CoagDataset, manifest: CoagManifest): Promise<CoagLateImportResult> {
  if (!manifest.lateFile) {
    return { dataset: base, added: 0, fingerprint: { expected: '', actual: '', ok: true }, issues: [] };
  }
  const entry = await fetchText(manifest.lateFile.fileName);
  const sha = (fileName: string) => (fileName === manifest.lateFile!.fileName ? entry.sha : '');
  const read = (fileName: string) => (fileName === manifest.lateFile!.fileName ? entry.text : '');
  const late = parseLateLabs(manifest, read, sha);
  const dataset = mergeCoagDataset(base, { lateLabs: late.labs });
  await putCoagBundle(COAG_SAMPLE_KEY, { dataset, manifest });
  return {
    dataset,
    added: late.labs.length,
    fingerprint: { expected: manifest.lateFile.sha256, actual: entry.sha, ok: entry.sha === manifest.lateFile.sha256 },
    issues: late.issues,
  };
}

export { emptyCoagDataset };
