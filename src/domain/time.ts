/** 自然日与时间轴工具：统一使用 Asia/Shanghai（固定 UTC+8），避免宿主时区影响。 */

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export function dayKeyFromMs(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS;
}

export function dayEndMs(day: string): number {
  return dayStartMs(day) + DAY_MS;
}

export function addDays(day: string, delta: number): string {
  return dayKeyFromMs(dayStartMs(day) + delta * DAY_MS);
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

export function monthDays(day: string): string[] {
  const [y, m] = day.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/** 以本地（上海）时钟格式展示，精确到秒 */
export function fmtDateTime(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  const s = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

export function fmtTime(ms: number): string {
  return fmtDateTime(ms).slice(11);
}

export function fmtClock(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join('');
}

export function fmtDuration(seconds: number): string {
  return fmtClock(seconds * 1000);
}

export function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtKg(b: { min: number; best: number; max: number } | null | undefined, digits = 2): string {
  if (!b) return '—';
  return `${fmtNum(b.best, digits)}`;
}

export function fmtRange(b: { min: number; best: number; max: number } | null | undefined, digits = 2): string {
  if (!b) return '—';
  return `${fmtNum(b.min, digits)} – ${fmtNum(b.max, digits)}`;
}

export function overlapRatio(
  a: { min: number; max: number },
  b: { min: number; max: number },
): number {
  const lo = Math.max(a.min, b.min);
  const hi = Math.min(a.max, b.max);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.max, b.max) - Math.min(a.min, b.min);
  if (union <= 0) return 1;
  return inter / union;
}
