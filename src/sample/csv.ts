/** CSV 读写与本地时间工具（样例资料与导入共用） */

export interface CsvRow {
  [key: string]: string;
}

/** 兼容引号与逗号的极简 CSV 解析（样例文件字段不含逗号/引号内逗号） */
export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitLine(lines[0]);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i]);
    const row: CsvRow = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function serializeCsv(headers: string[], rows: Record<string, string | number | null>[]): string {
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(','));
  return `${lines.join('\n')}\n`;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 上海本地时间 ISO 字符串，例如 2026-11-18T10:32:00+08:00 */
export function isoLocal(ms: number, withMillis = false): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const base = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${base}${withMillis ? `.${pad(shifted.getUTCMilliseconds(), 3)}` : ''}+08:00`;
}

export function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间：${value}`);
  return ms;
}

/** 可空 ISO 时间：空串返回 null */
export function parseIsoOrNull(value: string): number | null {
  if (!value || value.trim() === '') return null;
  return parseIso(value);
}

/** SHA-256（浏览器与 Node 均可用） */
export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持 WebCrypto，无法计算文件指纹');
  const digest = await subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
