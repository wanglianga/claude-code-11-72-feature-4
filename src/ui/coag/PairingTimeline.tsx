/**
 * 配对时间轴：投加条 → 可达出水窗口 → 窗口内去除率。
 * 只用主色 + 单色相深浅，不用多色分类；异常用色带在上下标出。
 */

import { useMemo, useState } from 'react';
import type { Anomaly, ConditionSegment, PairingRecord, ResidenceWindow, TankEfficiency } from '../../coag/types';
import { fmtDateTime, hhmm, pct } from './format';

interface Props {
  eff: TankEfficiency;
  selectedPairingId: string | null;
  onSelect: (id: string | null) => void;
}

const W = 1120;
const H = 250;
const PAD = { left: 54, right: 14, top: 18, bottom: 34 };
const ANOMALY_COLORS: Record<Anomaly['category'], string> = {
  FEED_SHORTAGE: '#b7791f',
  METERING_UNCERTAIN: '#7b5aa6',
  CONDITION_SHIFT: '#2f6f9f',
  SAMPLING_PENDING: '#a3312c',
};

export function PairingTimeline({ eff, selectedPairingId, onSelect }: Props) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const t0 = useMemo(() => eff.pairings.reduce((a, p) => Math.min(a, p.dosingFrom), Number.POSITIVE_INFINITY), [eff]);
  const t1 = useMemo(() => eff.pairings.reduce((a, p) => Math.max(a, p.window.toMax), 0), [eff]);
  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);

  const lanes = [
    { key: 'dose', y: PAD.top + 12, label: '投加' },
    { key: 'win', y: PAD.top + 46, label: '出水窗口' },
    { key: 'removal', y: PAD.top + 92, label: '去除率' },
  ];
  const plotTop = PAD.top + 92;
  const plotH = H - PAD.bottom - plotTop;

  const conditions = eff.conditions;
  const hours = Array.from({ length: 25 }, (_, i) => t0 + i * 3600_000).filter((t) => t <= t1);

  return (
    <div className="chart-wrap">
      <div className="chart-shell">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="配对时间轴">
          <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} fill="#fbfcfa" stroke="#e3e7e0" />
          {/* 工况带（稳定 → 浅绿；受限 → 浅橙） */}
          {conditions.map((c) => (
            <rect
              key={c.segmentId}
              x={x(c.from)}
              y={PAD.top}
              width={Math.max(0.5, x(c.to) - x(c.from))}
              height={H - PAD.top - PAD.bottom}
              fill={c.stable ? '#eef6f2' : '#fbf1e5'}
            />
          ))}
          {/* 小时刻度 */}
          {hours.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={PAD.top} y2={H - PAD.bottom} stroke="#eceee9" />
              <text x={x(t)} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={9.5} fill="#7d8a82">
                {hhmm(t)}
              </text>
            </g>
          ))}

          {/* 异常色带（底部） */}
          {eff.anomalies.map((a) => (
            <rect
              key={a.anomalyId}
              x={x(a.from)}
              y={H - PAD.bottom + 20}
              width={Math.max(1.5, x(a.to) - x(a.from))}
              height={5}
              fill={ANOMALY_COLORS[a.category]}
              opacity={a.severity === 'MAJOR' ? 0.9 : 0.5}
            />
          ))}

          {/* 投加条 + 出水窗口 + 去除率 */}
          {eff.pairings.map((p) => {
            const selected = p.pairingId === selectedPairingId;
            const cod = p.series.find((s) => s.target === 'COD');
            return (
              <g key={p.pairingId} onClick={() => onSelect(p.pairingId === selectedPairingId ? null : p.pairingId)} style={{ cursor: 'pointer' }}>
                <rect
                  x={x(p.dosingFrom)}
                  y={lanes[0].y - 5}
                  width={Math.max(1.5, x(p.dosingTo) - x(p.dosingFrom))}
                  height={10}
                  fill={p.rankable ? '#1f6f5c' : '#b9c2b8'}
                  opacity={selected ? 1 : 0.8}
                />
                <line x1={x(p.dosingFrom)} x2={x(p.window.toMin)} y1={lanes[0].y + 8} y2={lanes[1].y} stroke="#c9d3cd" strokeWidth={0.8} />
                <rect
                  x={x(p.window.toMin)}
                  y={lanes[1].y - 5}
                  width={Math.max(1.5, x(p.window.toMax) - x(p.window.toMin))}
                  height={10}
                  fill={p.window.usable ? '#8ec0b0' : '#e6cdae'}
                  stroke={p.window.usable ? '#5f9c8a' : '#c9a170'}
                  strokeWidth={0.7}
                />
                {cod?.removal && (
                  <g>
                    <circle cx={x((p.window.toMin + p.window.toMax) / 2)} cy={plotTop + plotH - cod.removal.best * plotH} r={selected ? 5 : 3.4} fill="#1f6f5c" />
                    <line
                      x1={x((p.window.toMin + p.window.toMax) / 2)}
                      x2={x((p.window.toMin + p.window.toMax) / 2)}
                      y1={plotTop + plotH - cod.removal.max * plotH}
                      y2={plotTop + plotH - cod.removal.min * plotH}
                      stroke="#1f6f5c"
                      strokeWidth={1}
                      opacity={0.5}
                    />
                  </g>
                )}
                <rect
                  x={x(p.dosingFrom)}
                  y={PAD.top}
                  width={Math.max(2, x(p.window.toMax) - x(p.dosingFrom))}
                  height={H - PAD.top - PAD.bottom}
                  fill="transparent"
                  onMouseEnter={(e) =>
                    setHover({
                      x: e.nativeEvent.offsetX,
                      y: e.nativeEvent.offsetY,
                      text: `${hhmm(p.dosingFrom)} 投加 ${p.dosage.volumeL.best.toFixed(1)} L · 窗口 ${hhmm(p.window.toMin)}–${hhmm(p.window.toMax)} · COD 去除 ${pct(cod?.removal?.best)}${p.rankable ? '' : ' · 不可排名'}`,
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}

          {/* 40% 参考线 */}
          <line x1={PAD.left} x2={W - PAD.right} y1={plotTop + plotH * 0.6} y2={plotTop + plotH * 0.6} stroke="#d8ddd5" strokeDasharray="3 4" />
          <text x={PAD.left - 6} y={plotTop + plotH * 0.6 + 3} textAnchor="end" fontSize={9} fill="#97a29b">60%</text>
          <text x={PAD.left - 6} y={plotTop + plotH - 2} textAnchor="end" fontSize={9} fill="#97a29b">0%</text>
          <text x={PAD.left - 6} y={plotTop + 9} textAnchor="end" fontSize={9} fill="#97a29b">100%</text>
          {lanes.map((l) => (
            <text key={l.key} x={PAD.left - 6} y={l.y + 3} textAnchor="end" fontSize={9.5} fill="#6f7d75">
              {l.label}
            </text>
          ))}

          <text x={PAD.left} y={12} fontSize={10} fill="#6f7d75">
            投加深色条 · 浅色为可达出水窗口（由流量/池容/回流比推导）· 底部色带为异常：缺料/计量不确定/工况突变/待取样
          </text>
        </svg>
      </div>
      {hover && (
        <div className="chart-tooltip" style={{ left: hover.x, top: hover.y }}>
          {hover.text}
        </div>
      )}
      <div className="legend" style={{ padding: '0 12px 10px' }}>
        <span><i className="swatch block" style={{ background: '#1f6f5c' }} />可排名投加</span>
        <span><i className="swatch block" style={{ background: '#b9c2b8' }} />受限投加</span>
        <span><i className="swatch block" style={{ background: '#8ec0b0' }} />可用窗口</span>
        <span><i className="swatch block" style={{ background: '#e6cdae' }} />不可用窗口</span>
        {(Object.keys(ANOMALY_COLORS) as Anomaly['category'][]).map((c) => (
          <span key={c}><i className="swatch block" style={{ background: ANOMALY_COLORS[c] }} />{ANOMALY_LABEL[c]}</span>
        ))}
      </div>
    </div>
  );
}

const ANOMALY_LABEL: Record<Anomaly['category'], string> = {
  FEED_SHORTAGE: '缺料',
  METERING_UNCERTAIN: '计量不确定',
  CONDITION_SHIFT: '工况突变',
  SAMPLING_PENDING: '待取样',
};

export function windowLabel(w: ResidenceWindow): string {
  return `${hhmm(w.toMin)}–${hhmm(w.toMax)}（停留 ${Math.round(w.residenceMinSeconds)}–${Math.round(w.residenceMaxSeconds)} s）`;
}

export function conditionLabel(c: ConditionSegment): string {
  return `${fmtDateTime(c.from).slice(11, 16)}–${fmtDateTime(c.to).slice(11, 16)} · ${c.stable ? '稳定' : '受限'}`;
}

export function pairingHeadline(p: PairingRecord): string {
  const cod = p.series.find((s) => s.target === 'COD');
  return `${hhmm(p.dosingFrom)} 投加 → ${windowLabel(p.window)} · COD 去除 ${pct(cod?.removal?.best)}`;
}
