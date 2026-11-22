import { useMemo, useState } from 'react';
import type { CoagActions, CoagState } from './useCoagState';
import { PairingTimeline, pairingHeadline, windowLabel } from './PairingTimeline';
import { fmtNum, hhmm, kgRange, minutes, num, pct, pctRange } from './format';

interface Props {
  state: CoagState;
  actions: CoagActions;
}

export function CoagPairingPage({ state, actions }: Props) {
  const { efficiency: eff, dataset } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'RANKABLE' | 'BLOCKED'>('ALL');

  const tank = dataset.tanks.find((t) => t.tankId === state.tankId);
  const pairings = useMemo(() => {
    if (!eff) return [];
    if (filter === 'RANKABLE') return eff.pairings.filter((p) => p.rankable);
    if (filter === 'BLOCKED') return eff.pairings.filter((p) => !p.rankable);
    return eff.pairings;
  }, [eff, filter]);
  const selected = eff?.pairings.find((p) => p.pairingId === selectedId) ?? null;

  if (!eff) {
    return (
      <div className="stack">
        <div className="card card-pad">
          <div className="empty">
            <p>本地库中还没有混凝样例资料。</p>
            <button className="btn primary" onClick={() => void actions.loadSample()} disabled={state.loading}>
              装载混凝样例（两个池 · 14,960 行在线读数）
            </button>
          </div>
        </div>
      </div>
    );
  }

  const cod = eff.byShift.COD;
  const cond = eff.byCondition.COD;

  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="card stat">
          <div className="stat-label">当日投加（泵脉冲）</div>
          <div className="stat-value">
            {fmtNum(eff.shifts.reduce((a, s) => a + s.dosedKg.best, 0), 1)}
            <span className="stat-unit">kg 有效成分</span>
          </div>
          <div className="stat-foot">{eff.pairings.length} 段配对 · 可排名 {eff.pairings.filter((p) => p.rankable).length} 段</div>
        </div>
        <div className="card stat">
          <div className="stat-label">COD 去除（窗内配对）</div>
          <div className="stat-value small">{pctRange(eff.byShift.COD.removal)}</div>
          <div className="stat-foot">按班次 {eff.byShift.COD.included} / {eff.pairings.length} 段</div>
        </div>
        <div className="card stat">
          <div className="stat-label">按稳定工况</div>
          <div className="stat-value small">{pctRange(eff.byCondition.COD.removal)}</div>
          <div className="stat-foot">未覆盖 {minutes(eff.byCondition.COD.uncoveredSeconds)} · 仅 {eff.byCondition.COD.included} 段</div>
        </div>
        <div className="card stat">
          <div className="stat-label">出水覆盖</div>
          <div className="stat-value" style={{ color: eff.coverage.meanOutletCoverage < 0.8 ? 'var(--warn)' : undefined }}>
            {pct(eff.coverage.meanOutletCoverage)}
          </div>
          <div className="stat-foot">受限 {eff.coverage.blockedPairings} 段 · 计算 {fmtNum(eff.computeMs, 0)} ms</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>可达出水窗口配对</h2>
          <span className="sub">
            {tank?.tankId} {tank?.name} · 池容 {tank?.effectiveVolumeM3} m³ · 允许停留 {tank?.minResidenceSeconds}–{tank?.maxResidenceSeconds} s · 回流 {(Number(tank?.recycleRatio ?? 0) * 100).toFixed(0)}%
          </span>
          <div className="spacer" />
          <div className="row" style={{ gap: 6 }}>
            {(['ALL', 'RANKABLE', 'BLOCKED'] as const).map((f) => (
              <button key={f} className={`btn small ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>
                {f === 'ALL' ? '全部' : f === 'RANKABLE' ? '可排名' : '受限'}
              </button>
            ))}
          </div>
        </div>
        <PairingTimeline eff={eff} selectedPairingId={selectedId} onSelect={setSelectedId} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>配对明细</h2>
            <span className="sub">窗口由当时流量 × 池容 × 回流比推导；投加量只来自泵脉冲</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table>
              <thead>
                <tr>
                  <th>投加时刻</th>
                  <th>可达窗口</th>
                  <th className="num">投加 kg</th>
                  <th className="num">浓度 g/L</th>
                  <th className="num">COD 去除</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {pairings.map((p) => {
                  const s = p.series.find((x) => x.target === 'COD');
                  return (
                    <tr key={p.pairingId} className={p.pairingId === selectedId ? 'selected' : ''} onClick={() => setSelectedId(p.pairingId)}>
                      <td className="mono tiny">{hhmm(p.dosingFrom)}</td>
                      <td className="mono tiny">{windowLabel(p.window)}</td>
                      <td className="num">{fmtNum(p.dosage.massKg.best, 2)}</td>
                      <td className="num">{fmtNum(p.dosage.concentrationGPerL.best, 2)}</td>
                      <td className="num">{pct(s?.removal?.best)}</td>
                      <td>
                        {p.rankable ? (
                          <span className="badge ok">可排名</span>
                        ) : (
                          <span className="badge warn" title={p.rankBlockReasons.join('；')}>
                            受限
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>选中配对的证据链</h2>
            <span className="sub">窗口推导、投加量范围、进出水有效片段</span>
          </div>
          <div className="card-pad">
            {!selected ? (
              <div className="muted small">在上方时间轴或表格中选择一段配对。</div>
            ) : (
              <div className="stack">
                <div className="row">
                  <span className="badge neutral mono">{selected.dosage.pulseId}</span>
                  <span className="badge neutral">{selected.dosage.pumpId}</span>
                  {selected.rankable ? <span className="badge ok">可排名</span> : <span className="badge warn">受限</span>}
                  <span className="badge neutral">{hhmm(selected.dosingFrom)} → {hhmm(selected.window.toMax)}</span>
                </div>
                <dl className="kv">
                  <dt>设定投加率</dt>
                  <dd className="mono">
                    {fmtNum(selected.dosage.setpointLh, 0)} L/h → {fmtNum(selected.dosage.massRateKgH, 2)} kg 有效成分/h
                  </dd>
                  <dt>脉冲体积</dt>
                  <dd className="mono">{kgRange(selected.dosage.volumeL, 2)} L</dd>
                  <dt>有效浓度</dt>
                  <dd className="mono">{kgRange(selected.dosage.concentrationGPerL, 2)} g/L（按混合比例）</dd>
                  <dt>投加量</dt>
                  <dd className="mono">{kgRange(selected.dosage.massKg, 3)} kg</dd>
                  <dt>窗口推导</dt>
                  <dd>
                    流量 {fmtNum(selected.window.flowFromM3h, 1)} m³/h · 池容 {selected.window.volumeM3} m³ · 回流 {(selected.window.recycleRatio * 100).toFixed(0)}%
                    <br />
                    推导停留 {fmtNum(selected.window.derivedMinSeconds, 0)}–{fmtNum(selected.window.derivedMaxSeconds, 0)} s → 取 {fmtNum(selected.window.residenceMinSeconds, 0)}–{fmtNum(selected.window.residenceMaxSeconds, 0)} s
                  </dd>
                  <dt>有效片段</dt>
                  <dd>
                    进水 {selected.series[0].inletEffectiveSeconds.toFixed(0)} s / 出水 {selected.series[0].outletEffectiveSeconds.toFixed(0)} s · 出水覆盖率 {pct(selected.outletCoverage)}
                  </dd>
                </dl>
                {selected.rankBlockReasons.length > 0 && (
                  <div className="note warn small">{selected.rankBlockReasons.join('；')}</div>
                )}
                {selected.series.map((s) => (
                  <div key={s.target} className="note small">
                    <strong>{s.target === 'COD' ? 'COD' : '氨氮'}</strong>：进水 {num(s.inletMgL, 2)} → 出水 {num(s.outletMgL, 2)} mg/L，
                    去除 {pctRange(s.removal)}，单位药耗 {s.yieldKgPerKg ? `${fmtNum(s.yieldKgPerKg.best, 2)} kg/kg` : '—'}
                  </div>
                ))}
                {selected.dosage.notes.length > 0 && <div className="note small">{selected.dosage.notes.join(' ')}</div>}
                <div className="tiny muted mono">{pairingHeadline(selected)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            当日 COD 去除：按班次 {pctRange(cod.removal)} · 按稳定工况 {pctRange(cond.removal)}；未覆盖 {minutes(cond.uncoveredSeconds)}。
          </div>
          <button className="btn small" onClick={() => void actions.recompute()} disabled={state.computing}>
            {state.computing ? '重算中…' : '重算'}
          </button>
        </div>
      </div>
    </div>
  );
}
