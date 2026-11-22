import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { METHOD_LABEL, fmtDateTime, fmtNum, kgRange, pct, shortTime, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

export function RecalcPage({ state, actions }: Props) {
  const { declarations, candidates, dataset, pointCode } = state;
  const [selectedDeclaration, setSelectedDeclaration] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const mine = declarations.filter((d) => d.pointCode === pointCode);
  const activeDecl = mine.find((d) => d.declarationId === selectedDeclaration) ?? mine[0] ?? null;
  const activeCand = candidates.find((c) => c.candidateId === candidateId) ?? candidates[0] ?? null;

  const lateInDataset = useMemo(() => {
    if (!activeDecl) return [];
    return dataset.readings.filter(
      (r) =>
        r.pointCode === activeDecl.pointCode &&
        r.alignedAt >= activeDecl.windowFrom &&
        r.alignedAt < activeDecl.windowTo &&
        r.receivedAt > activeDecl.cutoffReceivedAt,
    );
  }, [dataset, activeDecl]);

  const candidatesForActive = candidates.filter(
    (c) => !activeDecl || c.declarationId === activeDecl.declarationId,
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>迟到读数与重算候选</h2>
          <span className="sub">申报版本 FILED 不可改写；重算只能锁定原来源窗口并另存候选</span>
          <div className="spacer" />
          <button className="btn small" onClick={() => void actions.importLate()} disabled={state.loading}>
            导入迟到补录文件
          </button>
        </div>
        <div className="card-pad">
          {mine.length === 0 ? (
            <div className="empty">
              当前点位尚无申报版本。请先在“覆盖与资格”页出具申报，再导入迟到补录或生成重算候选。
            </div>
          ) : (
            <div className="grid cols-2">
              <div className="stack">
                <div className="field">
                  <label>申报版本</label>
                  <select
                    value={activeDecl?.declarationId ?? ''}
                    onChange={(e) => setSelectedDeclaration(e.target.value)}
                  >
                    {mine.map((d) => (
                      <option key={d.declarationId} value={d.declarationId}>
                        {d.day} · {trimId(d.declarationId, 22, 8)} · {METHOD_LABEL[d.method]}
                      </option>
                    ))}
                  </select>
                </div>
                {activeDecl && (
                  <dl className="kv">
                    <dt>状态</dt>
                    <dd><span className="badge ok">FILED</span>（不可改写）</dd>
                    <dt>锁定窗口</dt>
                    <dd className="mono">{fmtDateTime(activeDecl.windowFrom)} → {fmtDateTime(activeDecl.windowTo)}</dd>
                    <dt>截止接收时刻</dt>
                    <dd className="mono">{fmtDateTime(activeDecl.cutoffReceivedAt)}</dd>
                    <dt>来源快照</dt>
                    <dd>{activeDecl.sourceReadingIds.length.toLocaleString('zh-CN')} 条读数 · {activeDecl.sourceFileHashes.length} 个文件指纹</dd>
                    <dt>出具人 / 时间</dt>
                    <dd>{activeDecl.createdBy} · {fmtDateTime(activeDecl.createdAt)}</dd>
                  </dl>
                )}
                <button
                  className="btn primary"
                  disabled={!activeDecl || busy}
                  onClick={async () => {
                    if (!activeDecl) return;
                    setBusy(true);
                    await actions.createCandidate(activeDecl.declarationId);
                    setBusy(false);
                  }}
                >
                  {busy ? '生成中…' : '生成重算候选（锁定来源窗口）'}
                </button>
              </div>
              <div className="stack">
                <div className="note warn">
                  当前数据集里，落在该版本锁定窗口内、且接收时刻晚于截止的读数：
                  <strong> {lateInDataset.length} 条</strong>
                  {lateInDataset.length > 0 && (
                    <div className="tiny" style={{ marginTop: 4 }}>
                      首次到达 {fmtDateTime(Math.min(...lateInDataset.map((r) => r.receivedAt)))}，
                      最晚 {fmtDateTime(Math.max(...lateInDataset.map((r) => r.receivedAt)))}。
                      若尚未导入迟到文件，请点右上“导入迟到补录文件”。
                    </div>
                  )}
                </div>
                <div className="note">
                  规则：重算只能引用 [窗口起点, 窗口终点) 内的读数；原申报版本的结果、来源快照与状态保持不变，
                  差异单独记录在重算候选中，待人工复核决定是否作为下一版申报依据。
                </div>
                {candidatesForActive.length > 0 && (
                  <div className="field">
                    <label>重算候选（{candidatesForActive.length}）</label>
                    <select value={activeCand?.candidateId ?? ''} onChange={(e) => setCandidateId(e.target.value)}>
                      {candidatesForActive.map((c) => (
                        <option key={c.candidateId} value={c.candidateId}>
                          {fmtDateTime(c.createdAt)} · {c.status} · 迟到 {c.lateReadingIds.length} 条
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {activeCand && <CandidateDetail candidate={activeCand} note={note} setNote={setNote} actions={actions} />}
    </div>
  );
}

function CandidateDetail({
  candidate,
  note,
  setNote,
  actions,
}: {
  candidate: AppState['candidates'][number];
  note: string;
  setNote: (v: string) => void;
  actions: AppActions;
}) {
  const cod = candidate.diff.byPollutant.find((d) => d.pollutant === 'COD')!;
  const nh3n = candidate.diff.byPollutant.find((d) => d.pollutant === 'NH3N')!;
  const lateSegments = candidate.recomputed.pollutants.flatMap((t) =>
    t.segments.filter((s) => s.sourceReadingIds.some((id) => candidate.lateReadingIds.includes(id))),
  );
  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="card stat">
          <div className="stat-label">迟到读数</div>
          <div className="stat-value">
            {candidate.lateReadingIds.length}
            <span className="stat-unit">条</span>
          </div>
          <div className="stat-foot">{candidate.lateFileIds.length} 个文件 · {candidate.autoDetected ? '自动检出' : '人工生成'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">COD 差异</div>
          <div className="stat-value small">
            {cod.deltaKg >= 0 ? '+' : ''}
            {fmtNum(cod.deltaKg, 3)} kg
          </div>
          <div className="stat-foot">{fmtNum(cod.deltaPercent, 3)}% · 区间重叠 {pct(overlap(cod.baseline, cod.recomputed), 1)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">氨氮 差异</div>
          <div className="stat-value small">
            {nh3n.deltaKg >= 0 ? '+' : ''}
            {fmtNum(nh3n.deltaKg, 4)} kg
          </div>
          <div className="stat-foot">{fmtNum(nh3n.deltaPercent, 3)}% · 区间重叠 {pct(overlap(nh3n.baseline, nh3n.recomputed), 1)}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">覆盖率变化</div>
          <div className="stat-value small">
            {candidate.diff.coverageDelta >= 0 ? '+' : ''}
            {fmtNum(candidate.diff.coverageDelta * 100, 3)} pp
          </div>
          <div className="stat-foot">缺口 {fmtNum(candidate.baseline.pollutants.reduce((a, t) => a + t.gapSeconds, 0), 0)}s → {fmtNum(candidate.recomputed.pollutants.reduce((a, t) => a + t.gapSeconds, 0), 0)}s</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>差异说明</h2>
          <span className="sub">锁定来源范围 {fmtDateTime(candidate.windowFrom).slice(5, 16)} → {fmtDateTime(candidate.windowTo).slice(5, 16)}</span>
          <div className="spacer" />
          <span className={`badge ${candidate.status === 'REVIEWED' ? 'ok' : 'warn'}`}>{candidate.status}</span>
        </div>
        <div className="card-pad stack">
          <div className="note">{candidate.diff.note}</div>
          <table>
            <thead>
              <tr>
                <th>污染物</th>
                <th className="num">原申报区间 (kg)</th>
                <th className="num">重算区间 (kg)</th>
                <th className="num">差异 best (kg)</th>
                <th className="num">差异 %</th>
                <th className="num">区间重叠 (kg)</th>
              </tr>
            </thead>
            <tbody>
              {candidate.diff.byPollutant.map((d) => (
                <tr key={d.pollutant}>
                  <td>{d.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                  <td className="num">{kgRange(d.baseline, 3)}</td>
                  <td className="num">{kgRange(d.recomputed, 3)}</td>
                  <td className="num">{d.deltaKg >= 0 ? '+' : ''}{fmtNum(d.deltaKg, 4)}</td>
                  <td className="num">{fmtNum(d.deltaPercent, 4)}</td>
                  <td className="num">{kgRange(d.overlapKg, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <span className="badge ok">申报版本未被改写</span>
            <span className="badge neutral">来源窗口锁定</span>
            <span className="badge neutral">候选另存</span>
            {candidate.fillsGapSeconds > 0 && (
              <span className="badge info">迟到读数进入 {candidate.fillsGapSeconds} 个片段</span>
            )}
          </div>
          {lateSegments.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 220 }}>
              <table>
                <thead>
                  <tr>
                    <th>受影响片段</th>
                    <th>污染物</th>
                    <th>类别</th>
                    <th className="num">时长 s</th>
                    <th>迟到读数</th>
                  </tr>
                </thead>
                <tbody>
                  {lateSegments.slice(0, 20).map((s) => (
                    <tr key={`${s.segmentId}`}>
                      <td className="mono tiny">{shortTime(s.from)} → {shortTime(s.to)}</td>
                      <td className="tiny">{s.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                      <td className="tiny">{s.category}</td>
                      <td className="num">{fmtNum(s.durationSeconds, 0)}</td>
                      <td className="num">{s.sourceReadingIds.filter((id) => candidate.lateReadingIds.includes(id)).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="field" style={{ flex: 1 }}>
            <label>复核附注</label>
            <input
              type="text"
              value={note}
              placeholder="例如：迟到读数覆盖 02:00–02:03 缺测，采纳为下一版申报依据"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginTop: 20 }}>
            <button
              className="btn primary"
              disabled={candidate.status === 'REVIEWED'}
              onClick={() => void actions.reviewCandidate(candidate.candidateId, note)}
            >
              {candidate.status === 'REVIEWED' ? '已复核' : '标记复核完成'}
            </button>
          </div>
        </div>
        {candidate.reviewNote && (
          <div className="note ok" style={{ marginTop: 10 }}>
            复核附注：{candidate.reviewNote}（{candidate.reviewedBy} · {fmtDateTime(candidate.reviewedAt ?? 0)}）
          </div>
        )}
        <div className="tiny muted" style={{ marginTop: 8 }}>
          候选创建 {fmtDateTime(candidate.createdAt)} · 创建人 {candidate.createdBy} · 标识 {trimId(candidate.candidateId, 26, 10)}
        </div>
      </div>
    </div>
  );
}

function overlap(a: { min: number; max: number }, b: { min: number; max: number }): number {
  const lo = Math.max(a.min, b.min);
  const hi = Math.min(a.max, b.max);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.max, b.max) - Math.min(a.min, b.min);
  return union <= 0 ? 1 : inter / union;
}
