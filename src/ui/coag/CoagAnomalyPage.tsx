import { useState } from 'react';
import type { CoagActions, CoagState } from './useCoagState';
import { fmtNum, hhmm } from './format';
import { ANOMALY_LABELS } from '../../coag/types';
import type { AnomalyCategory } from '../../coag/types';

interface Props {
  state: CoagState;
  actions: CoagActions;
}

const CATEGORIES: AnomalyCategory[] = ['FEED_SHORTAGE', 'METERING_UNCERTAIN', 'CONDITION_SHIFT', 'SAMPLING_PENDING'];

export function CoagAnomalyPage({ state, actions }: Props) {
  const eff = state.efficiency;
  const [filter, setFilter] = useState<AnomalyCategory | 'ALL'>('ALL');
  const [selected, setSelected] = useState<string | null>(null);

  if (!eff) {
    return <div className="card card-pad"><div className="empty">尚未装载混凝样例或计算尚未完成。</div></div>;
  }

  const anomalies = eff.anomalies.filter((a) => filter === 'ALL' || a.category === filter);
  const active = anomalies.find((a) => a.anomalyId === selected) ?? anomalies[0];
  const affected = active ? eff.pairings.filter((p) => p.anomalyIds.includes(active.anomalyId)) : [];

  return (
    <div className="stack">
      <div className="grid cols-4">
        {CATEGORIES.map((c) => {
          const list = eff.anomalies.filter((a) => a.category === c);
          return (
            <div key={c} className="card stat" style={{ cursor: 'pointer', borderColor: filter === c ? 'var(--accent-2)' : undefined }} onClick={() => setFilter(filter === c ? 'ALL' : c)}>
              <div className="stat-label">{ANOMALY_LABELS[c]}</div>
              <div className="stat-value">{list.length}</div>
              <div className="stat-foot">影响 {list.reduce((a, b) => a + b.affectedPairings, 0)} 段配对</div>
            </div>
          );
        })}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>异常归因</h2>
            <span className="sub">缺料、计量不确定、工况突变、待取样四类；可点选查看受影响配对</span>
            <div className="spacer" />
            <button className={`btn small ${filter === 'ALL' ? 'primary' : ''}`} onClick={() => setFilter('ALL')}>全部</button>
          </div>
          <div className="table-wrap" style={{ maxHeight: 480 }}>
            <table>
              <thead>
                <tr>
                  <th>类别</th>
                  <th>时段</th>
                  <th className="num">影响配对</th>
                  <th>严重度</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a) => (
                  <tr key={a.anomalyId} className={a.anomalyId === active?.anomalyId ? 'selected' : ''} onClick={() => setSelected(a.anomalyId)}>
                    <td><span className={`badge ${a.category === 'FEED_SHORTAGE' ? 'warn' : a.category === 'METERING_UNCERTAIN' ? 'info' : a.category === 'CONDITION_SHIFT' ? 'neutral' : 'bad'}`}>{ANOMALY_LABELS[a.category]}</span></td>
                    <td className="mono tiny">{hhmm(a.from)}–{hhmm(a.to)}</td>
                    <td className="num">{a.affectedPairings}</td>
                    <td>{a.severity === 'MAJOR' ? '重大' : a.severity === 'MINOR' ? '一般' : '提示'}</td>
                    <td className="tiny">{a.fromLateLab ? '迟到化验' : '台账/在线'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>异常证据</h2>
            <span className="sub">说明如何影响配对与排名</span>
          </div>
          <div className="card-pad stack">
            {!active ? (
              <div className="muted small">没有该类异常。</div>
            ) : (
              <>
                <div className="row">
                  <span className="badge info">{ANOMALY_LABELS[active.category]}</span>
                  <span className="mono small">{hhmm(active.from)}–{hhmm(active.to)}</span>
                  <span className="badge neutral">影响 {active.affectedPairings} 段</span>
                </div>
                <div className="note small">{active.detail}</div>
                <div className="small muted">引用：{active.refIds.join('，')}</div>
                <div className="table-wrap" style={{ maxHeight: 280 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>配对</th>
                        <th className="num">投加 kg</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {affected.map((p) => (
                        <tr key={p.pairingId}>
                          <td className="mono tiny">{hhmm(p.dosingFrom)}</td>
                          <td className="num">{fmtNum(p.dosage.massKg.best, 2)}</td>
                          <td>{p.rankable ? <span className="badge ok">可排名</span> : <span className="badge warn">受限</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <button className="btn small" onClick={() => void actions.recompute()} disabled={state.computing}>重算</button>
          </div>
        </div>
      </div>
    </div>
  );
}
