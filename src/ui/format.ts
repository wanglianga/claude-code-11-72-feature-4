import { fmtDateTime, fmtDuration, fmtNum, fmtRange } from '../domain/time';
import type { EligibilityStatus, LoadBounds } from '../domain/types';

export { fmtDateTime, fmtDuration, fmtNum, fmtRange };

export function pct(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function kg(bounds: LoadBounds, digits = 3): string {
  return fmtNum(bounds.best, digits);
}

export function kgRange(bounds: LoadBounds, digits = 3): string {
  return `${fmtNum(bounds.min, digits)} – ${fmtNum(bounds.max, digits)}`;
}

export function eligibilityBadge(status: EligibilityStatus): { cls: string; label: string } {
  if (status === 'ELIGIBLE') return { cls: 'ok', label: '可申报' };
  if (status === 'CONDITIONAL') return { cls: 'warn', label: '有条件申报' };
  return { cls: 'bad', label: '不可申报' };
}

export const METHOD_LABEL: Record<string, string> = {
  SEGMENT: '逐有效片段积分',
  RESAMPLE: '误差界重采样积分',
};

export const GAP_LABEL: Record<string, string> = {
  SAMPLING_GAP: '采样空档',
  INSTRUMENT_GAP: '无仪表归属',
  NO_EFFECTIVE_STATE: '无有效状态',
  CALIBRATION_EDGE: '校准边沿',
  EXCLUDED_STATE: '排除状态',
};

export const CATEGORY_LABEL: Record<string, string> = {
  VALID: '有效',
  EXCLUDED_STATE: '排除状态',
  SAMPLING_GAP: '采样空档',
  NO_INSTRUMENT: '无仪表',
  NO_STATE: '无状态',
};

export const BOUNDARY_LABEL: Record<string, string> = {
  DAY_START: '自然日起点',
  DAY_END: '自然日终点',
  CALIBRATION: '校准生效',
  STATE: '状态切换',
  INSTRUMENT_SWAP: '设备交接',
  GAP: '采样空档端点',
};

export function shortTime(ms: number): string {
  return fmtDateTime(ms).slice(11);
}

export function shortDate(ms: number): string {
  return fmtDateTime(ms).slice(5, 10);
}

export function hashShort(sha: string): string {
  return `${sha.slice(0, 12)}…${sha.slice(-6)}`;
}

export function trimId(id: string, head = 18, tail = 10): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
