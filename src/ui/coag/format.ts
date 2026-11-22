import type { CoagTarget, LoadBounds } from '../../coag/types';
import { fmtDateTime, fmtNum } from '../../domain/time';

export { fmtDateTime, fmtNum };

export function hhmm(ms: number): string {
  return fmtDateTime(ms).slice(11, 16);
}

export function hhmmss(ms: number): string {
  return fmtDateTime(ms).slice(11, 19);
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** 数字或空值的固定小数展示（供表格复用） */
export function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function pctRange(b: LoadBounds | null | undefined, digits = 1): string {
  if (!b) return '—';
  return `${pct(b.min, digits)} – ${pct(b.max, digits)}`;
}

/** 只显示最可能值，供简报使用 */
export function pctBest(b: LoadBounds | null | undefined, digits = 1): string {
  return pct(b?.best, digits);
}

export function kgRange(b: LoadBounds | null | undefined, digits = 2): string {
  if (!b) return '—';
  return `${fmtNum(b.min, digits)} – ${fmtNum(b.max, digits)}`;
}

export function minutes(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

export const TARGET_LABEL: Record<CoagTarget, string> = { COD: 'COD', NH3N: '氨氮' };




