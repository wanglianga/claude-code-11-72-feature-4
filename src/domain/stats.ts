/** 半开区间 [a,b) 集合运算与分段线性乘积积分（单位：毫秒、mg/L、m³/h → kg） */

export type Iv = [number, number];

export const EPS = 1e-6;

export function mergeIntervals(list: Iv[]): Iv[] {
  const sorted = list
    .filter(([a, b]) => b - a > EPS)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Iv[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function intersectIntervals(a: Iv[], b: Iv[]): Iv[] {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out: Iv[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const lo = Math.max(A[i][0], B[j][0]);
    const hi = Math.min(A[i][1], B[j][1]);
    if (hi - lo > EPS) out.push([lo, hi]);
    if (A[i][1] < B[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

export function subtractIntervals(base: Iv[], remove: Iv[]): Iv[] {
  const R = mergeIntervals(remove);
  const out: Iv[] = [];
  for (const [a, b] of mergeIntervals(base)) {
    let cursor = a;
    for (const [ra, rb] of R) {
      if (rb <= cursor) continue;
      if (ra >= b) break;
      if (ra > cursor) out.push([cursor, Math.min(ra, b)]);
      cursor = Math.max(cursor, rb);
      if (cursor >= b) break;
    }
    if (cursor < b) out.push([cursor, b]);
  }
  return out.filter(([a, b]) => b - a > EPS);
}

export function clipIntervals(list: Iv[], from: number, to: number): Iv[] {
  return mergeIntervals(
    list
      .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as Iv)
      .filter(([a, b]) => b - a > EPS),
  );
}

export function totalMs(list: Iv[]): number {
  return list.reduce((acc, [a, b]) => acc + Math.max(0, b - a), 0);
}

export function contains(list: Iv[], at: number): boolean {
  for (const [a, b] of list) if (at >= a - EPS && at < b - EPS) return true;
  return false;
}

/** ∫ c(t)q(t) dt，c、q 在 [0,seconds] 上线性，结果 kg */
export function integrateProduct(
  c0: number,
  c1: number,
  q0: number,
  q1: number,
  seconds: number,
): number {
  if (!(seconds > 0)) return 0;
  const cs = (c1 - c0) / seconds;
  const qs = (q1 - q0) / seconds;
  const raw =
    c0 * q0 * seconds +
    ((c0 * qs + cs * q0) * seconds * seconds) / 2 +
    (cs * qs * seconds * seconds * seconds) / 3;
  return raw / 3_600_000;
}

/** 梯形负荷 kg：(c0q0 + c1q1)/2 × 秒 / 3.6e6 */
export function trapezoidLoad(
  c0: number,
  c1: number,
  q0: number,
  q1: number,
  seconds: number,
): number {
  if (!(seconds > 0)) return 0;
  return (((c0 * q0 + c1 * q1) / 2) * seconds) / 3_600_000;
}

/** 梯形法在分段线性乘积上的解析误差界：|c′q′|h³/6（kg），h 为秒 */
export function trapezoidErrorBound(
  c0: number,
  c1: number,
  q0: number,
  q1: number,
  seconds: number,
): number {
  if (!(seconds > 0)) return 0;
  const cs = (c1 - c0) / seconds;
  const qs = (q1 - q0) / seconds;
  return (Math.abs(cs * qs) * seconds * seconds * seconds) / 6 / 3_600_000;
}

export function overlapRatio(a: { min: number; max: number }, b: { min: number; max: number }): number {
  const lo = Math.max(a.min, b.min);
  const hi = Math.min(a.max, b.max);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.max, b.max) - Math.min(a.min, b.min);
  return union <= 0 ? 1 : inter / union;
}

export function boundsAround(
  best: number,
  uncertainty: number,
): { min: number; best: number; max: number } {
  const u = Math.max(0, uncertainty);
  return { min: Math.max(0, best - u), best, max: best + u };
}

export function combineRelative(...values: number[]): number {
  return Math.sqrt(values.reduce((acc, v) => acc + v * v, 0));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
