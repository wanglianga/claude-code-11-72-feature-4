import { useState } from 'react';
import type { CoagActions, CoagState } from './useCoagState';
import { useCoagCandidates } from './useCoagState';
import { fmtDateTime, hhmm, pct } from './format';
import { ANOMALY_LABELS } from '../../coag/types';

interface Props {
  state: CoagState;
  actions: CoagActions;
}

export function CoagRecapPage({ state, actions }: Props) {
  const candidates = useCoagCandidates(state);
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>班次复盘与迟到化验</h2>
          <span className="sub">
            复盘截止 {state.manifest ? fmtDateTime(state.manifest.focus.reviewCutoffReceivedAt) : '—'}；此后到达的化验只生成新的复盘候选
          </span>
          <div className="spacer" />
          <button className="btn primary" onClick={() => void actions.importLate()} disabled={state.loading}>
            导入迟到化验批次
          </button>
        </div>
        <div className="card-pad stack">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>候选</th>
                  <th>化验</th>
                  <th>取样</th>
                  <th>接收</th>
                  <th>类别</th>
                  <th className="num">影响配对</th>
                  <th>当班/前序班次</th>
                  <th>复核</th>
                </tr>
              </thead>
              <tbody>
                {candidates.length === 0 && (
                  <tr><td colSpan={8} className="muted small">暂无迟到化验候选；若尚未导入，请点击右上角“导入迟到化验批次”。</td></tr>
                )}
                {candidates.map((c) => (
                  <tr key={c.candidateId}>
                    <td className="mono tiny">{c.candidateId}</td>
                    <td className="mono tiny">{c.labId}</td>
                    <td className="mono tiny">{hhmm(c.sampledAt)}</td>
                    <td className="mono tiny">{hhmm(c.receivedAt)}</td>
                    <td>
                      {c.categories.map((cat) => (
                        <span key={cat} className="badge info" style={{ marginRight: 4 }}>{ANOMALY_LABELS[cat]}</span>
                      ))}
                    </td>
                    <td className="num">{c.affectedPairingIds.length}</td>
                    <td className="small">
                      {c.shiftId ? state.dataset.shifts.find((s) => s.shiftId === c.shiftId)?.code ?? c.shiftId : '—'}
                      {c.priorShifts.length > 0 && <span className="muted"> / 前序 {c.priorShifts.length} 班</span>}
                    </td>
                    <td>
                      {c.review?.status === 'REVIEWED' ? (
                        <span className="badge ok">已复核</span>
                      ) : (
                        <div className="row" style={{ gap: 4 }}>
                          <input
                            className="small"
                            style={{ width: 120 }}
                            placeholder="复核附注"
                            value={notes[c.candidateId] ?? ''}
                            onChange={(e) => setNotes((prev) => ({ ...prev, [c.candidateId]: e.target.value }))}
                          />
                          <button className="btn small" onClick={() => void actions.reviewCandidate(c.candidateId, notes[c.candidateId] ?? '')}>
                            标记已复核
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>迟到结果的处理原则</h2>
          </div>
          <div className="card-pad stack">
            <div className="note small">
              迟到化验不能改写当班已经采取的处置记录（例如“已送第三方、待结果”），只能形成新的复盘候选；
              候选上的 <span className="mono">shiftActionsOverwritten=false</span> 表示当班处置未被覆盖。
            </div>
            <div className="note small">
              异常类别为“待取样”的候选，通常对应当班登记过的取样事项；结果到达后兑现为新的复盘依据，而不是补写旧结论。
            </div>
            <div className="row">
              <span className="badge neutral">候选 {candidates.length}</span>
              <span className="badge ok">已复核 {candidates.filter((c) => c.review?.status === 'REVIEWED').length}</span>
              <span className="badge warn">待复核 {candidates.filter((c) => !c.review || c.review.status === 'PENDING').length}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>候选证据</h2>
            <span className="sub">取样时刻与受影响配对</span>
          </div>
          <div className="card-pad stack">
            {candidates.map((c) => (
              <div key={c.candidateId} className="note small">
                <strong className="mono">{c.labId}</strong>（取样 {hhmm(c.sampledAt)} · 接收 {hhmm(c.receivedAt)}）<br />
                {c.note}
                {c.affectedPairingIds.length > 0 && (
                  <div className="tiny muted mono" style={{ marginTop: 4 }}>{c.affectedPairingIds.join('，')}</div>
                )}
                {c.review?.reviewNote && <div className="tiny" style={{ marginTop: 4 }}>复核附注：{c.review.reviewNote}</div>}
              </div>
            ))}
            {candidates.length === 0 && <div className="muted small">无候选。</div>}
          </div>
        </div>
      </div>

      {state.efficiency && (
        <div className="card card-pad">
          <div className="small muted">
            当日 COD 去除：按班次 {pct(state.efficiency.byShift.COD.removal?.best)} / 按稳定工况 {pct(state.efficiency.byCondition.COD.removal?.best)}；
            按稳定工况未覆盖 {Math.round(state.efficiency.byCondition.COD.uncoveredSeconds / 60)} 分钟。迟到结果复核后可重新计算。
          </div>
        </div>
      )}
    </div>
  );
}
