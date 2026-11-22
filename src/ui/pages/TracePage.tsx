import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { linkReading } from '../../domain/engine';
import type { Pollutant, Reading, SegmentSummary } from '../../domain/types';
import { METRIC_LABELS } from '../../domain/types';
import { CATEGORY_LABEL, GAP_LABEL, fmtDateTime, fmtNum, kgRange, pct, shortTime, trimId } from '../format';
import { dayStartMs } from '../../domain/time';

interface Props {
  state: AppState;
  actions: AppActions;
}

export function TracePage({ state }: Props) {
  const { snapshot, dataset } = state;
  const [pollutant, setPollutant] = useState<Pollutant>('COD');
  const [selected, setSelected] = useState<string | null>(null);
  const [readingFilter, setReadingFilter] = useState('');
  const [showBoundaryOnly, setShowBoundaryOnly] = useState(true);

  const trace = snapshot?.pollutants.find((t) => t.pollutant === pollutant) ?? null;
  const segments = trace?.segments ?? [];
  const active = useMemo(() => {
    if (!segments.length) return null;
    return segments.find((s) => s.segmentId === selected) ?? segments[0];
  }, [segments, selected]);

  const readingLinks = useMemo(() => {
    if (!dataset.readings.length) return [];
    const ids = new Set(active?.sourceReadingIds ?? []);
    const rows = dataset.readings.filter((r) => ids.has(r.readingId));
    return rows.map((r) => linkReading(dataset, r));
  }, [dataset, active]);

  const filteredReadings = useMemo(() => {
    const q = readingFilter.trim().toLowerCase();
    const list = [...readingLinks].sort((a, b) => a.reading.alignedAt - b.reading.alignedAt);
    if (!q) return list.slice(0, 200);
    return list
      .filter(
        (l) =>
          l.reading.readingId.toLowerCase().includes(q) ||
          l.reading.instrumentId.toLowerCase().includes(q) ||
          String(l.reading.rawValue).includes(q),
      )
      .slice(0, 200);
  }, [readingLinks, readingFilter]);

  if (!snapshot || !trace) {
    return <div className="card card-pad empty">尚无可追溯的片段（请先在概览页装载资料并计算）。</div>;
  }

  const boundaryRows = segments.flatMap((s) =>
    s.boundaries.map((b) => ({ ...b, segment: s })),
  );
  const boundaryDedup = new Map<string, { at: number; kind: string; label: string; refId: string | null; segmentIds: string[] }>();
  for (const row of boundaryRows) {
    const key = `${row.at}|${row.kind}|${row.refId ?? ''}`;
    const exist = boundaryDedup.get(key);
    if (exist) exist.segmentIds.push(row.segment.segmentId);
    else boundaryDedup.set(key, { at: row.at, kind: row.kind, label: row.label, refId: row.refId, segmentIds: [row.segment.segmentId] });
  }
  const boundaries = [...boundaryDedup.values()].sort((a, b) => a.at - b.at);
  const displayedBoundaries = showBoundaryOnly ? boundaries : boundaries;

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <div className="field">
              <label>污染物</label>
              <select value={pollutant} onChange={(e) => setPollutant(e.target.value as Pollutant)}>
                <option value="COD">COD</option>
                <option value="NH3N">氨氮</option>
              </select>
            </div>
            <div className="field">
              <label>片段</label>
              <select value={active?.segmentId ?? ''} onChange={(e) => setSelected(e.target.value)}>
                {segments.map((s) => (
                  <option key={s.segmentId} value={s.segmentId}>
                    {shortTime(s.from)}–{shortTime(s.to)} · {CATEGORY_LABEL[s.category] ?? s.category} · {fmtNum(s.durationSeconds, 0)}s
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <span className="badge neutral">片段 {segments.length}</span>
            <span className="badge neutral">边界 {boundaries.length}</span>
            <label className="checkline" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={showBoundaryOnly} onChange={(e) => setShowBoundaryOnly(e.target.checked)} />
              仅显示边界
            </label>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">场景回放：跳到样例资料设计的关键时刻，片段会自动选中并展开来源链。</div>
          <div className="row">
            {scenarioMarkers(state.day).map((m) => (
              <button
                key={m.label}
                className="btn small"
                title={m.tip}
                onClick={() => {
                  const target = segments.find((seg) => {
                    const start = seg.effectiveFrom ?? seg.from;
                    const end = seg.effectiveTo ?? seg.to;
                    return start <= m.at && m.at < end + 1;
                  });
                  if (target) setSelected(target.segmentId);
                }}
              >
                {m.label} <span className="mono tiny muted">{shortTime(m.at).slice(0, 5)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>片段列表</h2>
          <span className="sub">段内仪表、校准、状态唯一；点击任一行查看来源链</span>
        </div>
        <div className="table-wrap" style={{ maxHeight: 380 }}>
          <table>
            <thead>
              <tr>
                <th>起止</th>
                <th>类别</th>
                <th>状态</th>
                <th className="num">时长 s</th>
                <th className="num">负荷 (kg)</th>
                <th className="num">覆盖</th>
                <th>校准</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr
                  key={s.segmentId}
                  className={active?.segmentId === s.segmentId ? 'selected' : ''}
                  onClick={() => setSelected(s.segmentId)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono tiny">
                    {shortTime(s.from)} → {shortTime(s.to)}
                    {s.calibrationCut && <span className="badge warn" style={{ marginLeft: 6 }}>校准切口</span>}
                  </td>
                  <td>
                    <span className={`badge ${s.category === 'VALID' ? 'ok' : s.category === 'EXCLUDED_STATE' ? 'warn' : 'info'}`}>
                      {CATEGORY_LABEL[s.category] ?? s.category}
                    </span>
                  </td>
                  <td className="tiny">
                    {s.state ?? '—'} / {s.flowState ?? '—'}
                  </td>
                  <td className="num">{fmtNum(s.durationSeconds, 0)}</td>
                  <td className="num">{s.loadKg ? kgRange(s.loadKg, 3) : '—'}</td>
                  <td className="num">{pct(s.coverage, 1)}</td>
                  <td className="mono tiny">{s.calibrationId ?? '默认系数'}</td>
                  <td className="tiny muted">
                    {(s.sourceReadingIds.length)} 读数 · {(s.sourceStateIds.length)} 状态
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {active && (
        <div className="grid cols-2">
          <div className="card">
            <div className="card-head">
              <h2>片段证据</h2>
              <span className="sub mono">{trimId(active.segmentId, 26, 14)}</span>
            </div>
            <div className="card-pad stack">
              <dl className="kv">
                <dt>接收时间窗</dt>
                <dd className="mono">{fmtDateTime(active.from)} → {fmtDateTime(active.to)}</dd>
                <dt>有效积分域</dt>
                <dd className="mono">
                  {active.effectiveFrom ? `${fmtDateTime(active.effectiveFrom)} → ${fmtDateTime(active.effectiveTo!)}` : '无（未覆盖）'}
                </dd>
                <dt>浓度仪表</dt>
                <dd className="mono">{active.instrumentId ?? '—'}</dd>
                <dt>流量仪表</dt>
                <dd className="mono">{active.flowInstrumentId ?? '—'}</dd>
                <dt>浓度校准</dt>
                <dd className="mono">
                  {active.calibrationId ?? '默认系数'}（scale {active.calibrationScale ?? '—'} / offset {active.calibrationOffset ?? '—'}）
                </dd>
                <dt>流量校准</dt>
                <dd className="mono">
                  {active.flowCalibrationId ?? '默认系数'}（scale {active.flowCalibrationScale ?? '—'} / offset {active.flowCalibrationOffset ?? '—'}）
                </dd>
                <dt>状态</dt>
                <dd>
                  {active.state ?? '无'} / 流量 {active.flowState ?? '无'}
                  {active.excludeReason && <div className="tiny" style={{ color: 'var(--warn)' }}>{active.excludeReason}</div>}
                </dd>
                <dt>读数</dt>
                <dd>
                  {active.readingCount} 行
                  {active.readingWindow && (
                    <div className="tiny muted">
                      对齐窗 {fmtDateTime(active.readingWindow.from)} → {fmtDateTime(active.readingWindow.to)}
                    </div>
                  )}
                </dd>
                <dt>负荷</dt>
                <dd className="mono">{active.loadKg ? kgRange(active.loadKg, 4) : '—'} kg</dd>
                <dt>来源文件</dt>
                <dd className="mono tiny">{active.sourceFileIds.join('，') || '—'}</dd>
              </dl>
              <div className="hr" />
              <div className="small muted">片段边界（来源链顶端）：</div>
              <ul className="list-reset stack" style={{ gap: 4 }}>
                {active.boundaries.map((b, i) => (
                  <li key={`${b.kind}-${i}`} className="small">
                    <span className="badge neutral">{b.kind}</span> {shortTime(b.at)} · {b.label}
                    {b.refId && <span className="mono tiny muted"> [{trimId(b.refId, 16, 8)}]</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>原始读数 → 系数 → 状态</h2>
              <span className="sub">校准值 = raw × scale + offset；仅列本片段</span>
              <div className="spacer" />
              <input
                type="text"
                placeholder="过滤读数 ID / 仪表 / 数值"
                value={readingFilter}
                onChange={(e) => setReadingFilter(e.target.value)}
                style={{ maxWidth: 220 }}
              />
            </div>
            <div className="table-wrap" style={{ maxHeight: 380 }}>
              <table>
                <thead>
                  <tr>
                    <th>对齐时刻</th>
                    <th>读数</th>
                    <th className="num">raw</th>
                    <th className="num">校准值</th>
                    <th>系数</th>
                    <th>状态</th>
                    <th>文件行</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReadings.map((l) => (
                    <tr key={l.reading.readingId}>
                      <td className="mono tiny">{fmtDateTime(l.reading.alignedAt).slice(11)}</td>
                      <td className="mono tiny">{trimId(l.reading.readingId, 16, 8)}</td>
                      <td className="num">{fmtNum(l.reading.rawValue, 2)}</td>
                      <td className="num">{fmtNum(l.calibrated, 2)}</td>
                      <td className="mono tiny">
                        {fmtNum(l.scale, 3)} / {fmtNum(l.offset, 2)}
                      </td>
                      <td className="tiny">{l.state ?? '无'}</td>
                      <td className="mono tiny">行 {l.reading.sourceRow}</td>
                    </tr>
                  ))}
                  {filteredReadings.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted small">
                        本片段无读数（可能是空档或排除段），或过滤未命中。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>校准边界索引</h2>
          <span className="sub">所有片段边界（含来源 ID），按时间排序；校准生效处必切段</span>
        </div>
        <div className="table-wrap" style={{ maxHeight: 300 }}>
          <table>
            <thead>
              <tr>
                <th>时刻</th>
                <th>边界类型</th>
                <th>说明</th>
                <th>来源 ID</th>
                <th>涉及片段</th>
              </tr>
            </thead>
            <tbody>
              {displayedBoundaries.map((b) => (
                <tr key={`${b.at}-${b.kind}-${b.refId ?? ''}`}>
                  <td className="mono tiny">{fmtDateTime(b.at)}</td>
                  <td>
                    <span className="badge info">{b.kind}</span>
                  </td>
                  <td className="small">{b.label}</td>
                  <td className="mono tiny">{b.refId ?? '—'}</td>
                  <td className="tiny muted">{b.segmentIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            片段内“浓度实例、流量实例、浓度校准、流量校准、两侧状态”唯一；缺任一项都不能并入排放负荷。
          </div>
          <div className="row">
            {(['COD', 'NH3N'] as Pollutant[]).map((p) => (
              <span key={p} className="badge neutral">
                {METRIC_LABELS[p]} {snapshot.pollutants.find((t) => t.pollutant === p)!.segments.length} 段
              </span>
            ))}
          </div>
        </div>
      </div>
      <SegmentFooter active={active} />
    </div>
  );
}

function SegmentFooter({ active }: { active: SegmentSummary | null }) {
  if (!active) return null;
  const gapList = active.category === 'VALID' ? [] : [];
  void gapList;
  return (
    <div className="card card-pad">
      <div className="small muted">
        当前片段类别 {CATEGORY_LABEL[active.category] ?? active.category}
        {active.category !== 'VALID' && '：本段不计入排放负荷，仅保留为缺口/排除证据。'}
        {active.category === 'VALID' && '：按片段内读数对与边界积分；片段内缺口已在缺口表单独列出并扣除。'}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {active.category === 'EXCLUDED_STATE' && <span className="badge warn">{GAP_LABEL.EXCLUDED_STATE}</span>}
        <span className="badge neutral">读数 {active.sourceReadingIds.length}</span>
        <span className="badge neutral">校准 {active.sourceCalibrationIds.length}</span>
        <span className="badge neutral">文件 {active.sourceFileIds.length}</span>
      </div>
    </div>
  );
}

interface Marker {
  label: string;
  at: number;
  tip: string;
}

function scenarioMarkers(day: string): Marker[] {
  const start = dayStartMs(day);
  const H = 3_600_000;
  return [
    { label: '冲洗排除', at: start + 1 * H + 60_000, tip: '01:00–01:08 冲洗，整段排除，不计入排放负荷' },
    { label: '三分钟缺测', at: start + 2 * H + 60_000, tip: '02:00–02:03 无读数，负荷扣除并量化缺口影响' },
    { label: '探头交接', at: start + 4 * H + 60_000, tip: '04:00 COD 探头整机更换，点位编号复用按实例衔接' },
    { label: '40 秒冲击', at: start + 9 * H + 15 * 60_000 + 20_000, tip: '09:15:00–09:15:40 高浓度冲击，峰值 145 mg/L' },
    { label: '校准生效', at: start + 13 * H + 60_000, tip: '13:00 校准中途生效，切口两侧系数不同' },
    { label: '旁路排除', at: start + 20 * H + 60_000, tip: '20:00–20:04 流量旁路，整段排除' },
  ];
}

export type { Reading };
