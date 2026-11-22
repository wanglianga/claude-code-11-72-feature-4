import { useMemo, useState } from 'react';
import type { DayLoadSnapshot, Pollutant } from '../../domain/types';
import { fmtDateTime, fmtNum, fmtTime } from '../../domain/time';

interface Props {
  snapshot: DayLoadSnapshot;
  selectedSegmentId: string | null;
  onSelectSegment: (segmentId: string | null) => void;
}

const W = 1180;
const H = 300;
const PAD = { top: 16, right: 52, bottom: 30, left: 46 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

interface Band {
  x: number;
  w: number;
  kind: 'excluded' | 'gap';
}

export function DayChart({ snapshot, selectedSegmentId, onSelectSegment }: Props) {
  const chart = snapshot.chart ?? [];
  const [hover, setHover] = useState<number | null>(null);
  const [pollutant, setPollutant] = useState<Pollutant>('COD');

  const view = useMemo(() => {
    const windowMs = snapshot.windowTo - snapshot.windowFrom;
    const x = (t: number) => PAD.left + ((t - snapshot.windowFrom) / windowMs) * INNER_W;
    const concKey = pollutant === 'COD' ? 'cod' : 'nh3n';
    const rateKey = pollutant === 'COD' ? 'codRateKgH' : 'nh3nRateKgH';
    const trace = snapshot.pollutants.find((p) => p.pollutant === pollutant);
    const standard = trace?.standard ?? 50;
    const concs = chart.map((c) => c[concKey]).filter((v): v is number => v !== null);
    const rates = chart.map((c) => c[rateKey]).filter((v): v is number => v !== null);
    const concMax = Math.max(standard * 1.25, ...concs) || 60;
    const rateMax = Math.max(0.2, ...rates) * 1.12;
    const yC = (v: number) => PAD.top + INNER_H - (v / concMax) * INNER_H;
    const yR = (v: number) => PAD.top + INNER_H - (v / rateMax) * INNER_H;

    const segments = trace?.segments ?? [];
    const bands: Band[] = [];
    for (const s of segments) {
      if (s.category === 'EXCLUDED_STATE' || s.category === 'NO_STATE' || s.category === 'NO_INSTRUMENT') {
        bands.push({ x: x(s.from), w: Math.max(1, x(s.to) - x(s.from)), kind: 'excluded' });
      }
    }
    for (const g of trace?.gaps ?? []) {
      bands.push({ x: x(g.from), w: Math.max(1, x(g.to) - x(g.from)), kind: 'gap' });
    }

    const concPath: string[] = [];
    const ratePath: string[] = [];
    // null 表示无覆盖：断开折线（下一有效点重新起笔）
    let concOpen = false;
    let rateOpen = false;
    for (const c of chart) {
      const cx = x(c.at);
      const cv = c[concKey];
      if (cv === null) {
        concOpen = false;
      } else {
        concPath.push(`${concOpen ? 'L' : 'M'}${cx.toFixed(1)},${yC(cv).toFixed(1)}`);
        concOpen = true;
      }
      const rv = c[rateKey];
      if (rv === null) {
        rateOpen = false;
      } else {
        ratePath.push(`${rateOpen ? 'L' : 'M'}${cx.toFixed(1)},${yR(rv).toFixed(1)}`);
        rateOpen = true;
      }
    }

    const xTicks: number[] = [];
    for (let h = 0; h <= 24; h += 3) {
      xTicks.push(snapshot.windowFrom + h * 3_600_000);
    }
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * concMax);

    const exceedances = trace?.exceedances ?? [];
    return {
      x,
      yC,
      yR,
      concMax,
      rateMax,
      standard,
      concPath: concPath.join(' '),
      ratePath: ratePath.join(' '),
      bands,
      xTicks,
      yTicks,
      trace,
      segments,
      exceedances,
    };
  }, [chart, pollutant, snapshot]);

  const hoverPoint = hover !== null ? chart[hover] : null;
  const hoverX = hoverPoint ? view.x(hoverPoint.at) : 0;
  const windowMs = snapshot.windowTo - snapshot.windowFrom;

  if (chart.length === 0) {
    return <div className="empty">暂无当日曲线（请先装载资料并计算）</div>;
  }

  return (
    <div className="chart-wrap">
      <div className="chart-shell">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <div className="legend">
            <span>
              <i className="swatch" style={{ background: 'var(--cod)' }} />
              {pollutant === 'COD' ? 'COD 浓度' : '氨氮浓度'}（mg/L，左轴）
            </span>
            <span>
              <i className="swatch" style={{ background: 'var(--flow)' }} />
              负荷率（kg/h，右轴）
            </span>
            <span>
              <i className="swatch block" style={{ background: 'var(--excluded)' }} />
              排除状态（冲洗/校准/旁路/故障）
            </span>
            <span>
              <i className="swatch block" style={{ background: 'var(--gap)' }} />
              采样空档
            </span>
          </div>
          <div className="row">
            <button className={`btn small ${pollutant === 'COD' ? 'primary' : ''}`} onClick={() => setPollutant('COD')}>
              COD
            </button>
            <button className={`btn small ${pollutant === 'NH3N' ? 'primary' : ''}`} onClick={() => setPollutant('NH3N')}>
              氨氮
            </button>
          </div>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="当日浓度与负荷率曲线"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * W;
            if (px < PAD.left || px > W - PAD.right) {
              setHover(null);
              return;
            }
            const t = snapshot.windowFrom + ((px - PAD.left) / INNER_W) * windowMs;
            let best = 0;
            let bestDist = Infinity;
            chart.forEach((c, i) => {
              const d = Math.abs(c.at + 30_000 - t);
              if (d < bestDist) {
                bestDist = d;
                best = i;
              }
            });
            setHover(best);
          }}
        >
          <defs>
            <linearGradient id="rateFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--flow)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--flow)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {view.bands.map((b, i) => (
            <rect
              key={`${b.kind}-${i}`}
              x={b.x}
              y={PAD.top}
              width={b.w}
              height={INNER_H}
              fill={b.kind === 'excluded' ? 'var(--excluded)' : 'var(--gap)'}
              opacity={b.kind === 'excluded' ? 0.28 : 0.34}
            />
          ))}
          {view.yTicks.map((v, i) => (
            <g key={`yc-${i}`}>
              <line x1={PAD.left} x2={W - PAD.right} y1={view.yC(v)} y2={view.yC(v)} stroke="var(--line)" strokeDasharray={i === 0 ? '' : '2 4'} />
              <text x={PAD.left - 8} y={view.yC(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--ink-3)">
                {fmtNum(v, 0)}
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
            <text
              key={`yr-${i}`}
              x={W - PAD.right + 8}
              y={view.yR(f * view.rateMax) + 3.5}
              fontSize="10"
              fill="var(--flow)"
            >
              {fmtNum(f * view.rateMax, 2)}
            </text>
          ))}
          {view.xTicks.map((t, i) => (
            <g key={`xt-${i}`}>
              <line x1={view.x(t)} x2={view.x(t)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--line)" strokeDasharray="2 5" />
              <text x={view.x(t)} y={H - PAD.bottom + 15} textAnchor="middle" fontSize="10" fill="var(--ink-3)">
                {fmtTime(t).slice(0, 5)}
              </text>
            </g>
          ))}
          {/* 阈值线 */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={view.yC(view.standard)}
            y2={view.yC(view.standard)}
            stroke="var(--danger)"
            strokeWidth="1"
            strokeDasharray="6 4"
            opacity="0.7"
          />
          <text x={W - PAD.right - 4} y={view.yC(view.standard) - 5} textAnchor="end" fontSize="10" fill="var(--danger)">
            限值 {view.standard} mg/L
          </text>
          {view.exceedances.map((e, i) => (
            <rect
              key={`ex-${i}`}
              x={view.x(e.from)}
              y={PAD.top}
              width={Math.max(1.5, view.x(e.to) - view.x(e.from))}
              height={INNER_H}
              fill="var(--danger)"
              opacity="0.16"
            />
          ))}
          <path d={view.ratePath} fill="none" stroke="var(--flow)" strokeWidth="1.4" opacity="0.85" />
          <path d={view.concPath} fill="none" stroke="var(--cod)" strokeWidth="1.6" />
          {selectedSegmentId && (
            <g>
              {view.segments
                .filter((s) => s.segmentId === selectedSegmentId)
                .map((s) => (
                  <rect
                    key={s.segmentId}
                    x={view.x(s.from)}
                    y={PAD.top}
                    width={Math.max(1.5, view.x(s.to) - view.x(s.from))}
                    height={INNER_H}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.6"
                    pointerEvents="none"
                  />
                ))}
            </g>
          )}
          <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="var(--line-strong)" />
          {hover !== null && hoverPoint && (
            <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--ink-3)" strokeWidth="1" />
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={INNER_W}
            height={INNER_H}
            fill="transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => {
              if (!hoverPoint) return;
              const segId = pollutant === 'COD' ? hoverPoint.codSegmentId : hoverPoint.nh3nSegmentId;
              onSelectSegment(segId && segId !== selectedSegmentId ? segId : null);
            }}
          />
        </svg>
      </div>
      {hoverPoint && (
        <div className="chart-tooltip" style={{ left: `${(hoverX / W) * 100}%`, top: 26 }}>
          <div>{fmtDateTime(hoverPoint.at)} – {fmtDateTime(hoverPoint.at + 60_000).slice(11)}</div>
          <div>
            COD {hoverPoint.cod === null ? '—' : `${fmtNum(hoverPoint.cod, 2)} mg/L`} · 氨氮{' '}
            {hoverPoint.nh3n === null ? '—' : `${fmtNum(hoverPoint.nh3n, 2)} mg/L`}
          </div>
          <div>
            流量 {hoverPoint.flow === null ? '—' : `${fmtNum(hoverPoint.flow, 1)} m³/h`} · 负荷率{' '}
            {hoverPoint.codRateKgH === null ? '—' : `${fmtNum(hoverPoint.codRateKgH, 3)} kg/h`}
          </div>
          <div className="muted">
            {hoverPoint.excluded ? '该分钟含排除状态' : hoverPoint.gap ? '该分钟含采样空档' : '点击可选定相邻片段'}
          </div>
        </div>
      )}
    </div>
  );
}
