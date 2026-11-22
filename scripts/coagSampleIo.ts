/** Node 侧的混凝样例读写小工具：与 src/sample/csv.ts 相同的序列化规则。 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function serialCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((_, i) => esc(row[i])).join(','));
  return `${lines.join('\n')}\n`;
}

export function isoLocal(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(
    shifted.getUTCHours(),
  )}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}
