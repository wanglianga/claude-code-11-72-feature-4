import { useState } from 'react';
import type { CoagActions, CoagState } from './useCoagState';
import { fmtNum, hhmm, kgRange, minutes, pct, pctRange } from './format';
import type { CoagTarget } from '../../coag/types';

interface Props {
  state: CoagState;
  actions: CoagActions;
}

const TARGETS: CoagTarget[] = ['COD', 'NH3N'];

export function CoagShiftPage({ state, actions }: Props) {
  const eff = state.efficiency;
  const [target, setTarget] = useState<CoagTarget>('COD');
  const [selectedShift, setSelectedShift] = useState<string | null>(null);

  if (!eff) {
    return <div className="card card-pad"><div className="empty">尚未装载混凝样例或计算尚未完成。</div></div>;
  }

  const activeShift = eff.shifts.find((s) => s.shiftId === selectedShift) ?? eff.shifts[0];
  if (!activeShift) {
    return <div className="card card-pad"><div className="empty">资料中没有班次定义（shifts.csv），无法按班次复盘。</div></div>;
  }
  const inside = eff.pairings.filter((p) => p.dosingFrom >= activeShift.from && p.dosingFrom < activeShift.to);
  const transferList = state.dataset.transfers.filter((t) => t.storageId === state.dataset.tanks.find((t) => t.tankId === state.tankId)?.storageId && t.at >= activeShift.from && t.at < activeShift.to);

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>班次复盘</h2>
          <span className="sub">按固定班次汇总投入与经配对的去除；入库量与投加量分列，班内暴雨/切换会混合反应条件</span>
          <div className="spacer" />
          {TARGETS.map((t) => (
            <button key={t} className={`btn small ${target === t ? 'primary' : ''}`} onClick={() => setTarget(t)}>
              {t === 'COD' ? 'COD' : '氨氮'}
            </button>
          ))}
          <button className="btn small" onClick={() => void actions.importLate()} disabled={state.loading}>
            导入迟到化验
          </button>
        </div>
        <div className="grid cols-3" style={{ padding: 12 }}>
          {eff.shifts.map((s) => {
            const e = s.efficiency[target];
            const naive = s.naiveYieldByPurchase[target];
            return (
              <div
                key={s.shiftId}
                className="card card-pad"
                style={{ cursor: 'pointer', borderColor: s.shiftId === activeShift.shiftId ? 'var(--accent-2)' : undefined }}
                onClick={() => setSelectedShift(s.shiftId)}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{s.code}</strong>
                  <span className="small muted mono">{hhmm(s.from)}–{hhmm(s.to)}</span>
                </div>
                <div className="stat-value small" style={{ marginTop: 8 }}>{pctRange(e.removal)}</div>
                <div className="stat-foot">配对 {e.included}/{s.pairings} 段 · {e.rankable ? '可比较' : '仅参考'}</div>
                <div className="stat-foot">实际投加 {fmtNum(s.dosedKg.best, 1)} kg · 入库 {fmtNum(s.purchasedKg.best, 0)} kg（不是投加）</div>
                <div className="stat-foot">
                  若按入库量折算：{naive ? `${fmtNum(naive.best, 2)} kg/kg（反例）` : '—'}
                </div>
                {s.hasMixedConditions && <span className="badge warn" style={{ marginTop: 6 }}>班内混合工况</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>{activeShift.code} · 投入与库存转移</h2>
            <span className="sub">采购入库/转罐只进批次账；实际投加以泵脉冲为准</span>
          </div>
          <div className="card-pad stack">
            <dl className="kv">
              <dt>实际投加</dt>
              <dd className="mono">{kgRange(activeShift.dosedKg, 2)} kg 有效成分</dd>
              <dt>采购入库（参照）</dt>
              <dd className="mono">{kgRange(activeShift.purchasedKg, 1)} kg</dd>
              <dt>库存转移净额</dt>
              <dd className="mono">{kgRange(activeShift.transferredKg, 2)} kg</dd>
              <dt>本班异常</dt>
              <dd>{activeShift.anomalies} 项</dd>
            </dl>
            {activeShift.notes.length > 0 && (
              <ul className="list-reset stack" style={{ gap: 5 }}>
                {activeShift.notes.map((n, i) => (
                  <li key={i} className="small">· {n}</li>
                ))}
              </ul>
            )}
            <div className="small muted">本班储罐动作：</div>
            <ul className="list-reset stack" style={{ gap: 4 }}>
              {transferList.length === 0 && <li className="small muted">无</li>}
              {transferList.map((t) => (
                <li key={t.transferId} className="small">
                  <span className="mono">{hhmm(t.at)}</span> {t.kind === 'DILUTION' ? '稀释' : t.kind === 'TRANSFER_IN' ? '转罐入' : t.kind === 'TRANSFER_OUT' ? '转罐出' : t.kind === 'RECEIPT' ? '入库' : t.kind}
                  {' '}{t.volumeL} L → {fmtNum(t.resultingConcentration, 2)} g/L
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{activeShift.code} · 配对与不可排名段</h2>
            <span className="sub">旁路、缺料、校准失效或工况改变只给范围</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table>
              <thead>
                <tr>
                  <th>投加</th>
                  <th>窗口</th>
                  <th className="num">投加 kg</th>
                  <th className="num">{target} 去除</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {inside.map((p) => {
                  const s = p.series.find((x) => x.target === target);
                  return (
                    <tr key={p.pairingId}>
                      <td className="mono tiny">{hhmm(p.dosingFrom)}</td>
                      <td className="mono tiny">{hhmm(p.window.toMin)}–{hhmm(p.window.toMax)}</td>
                      <td className="num">{fmtNum(p.dosage.massKg.best, 2)}</td>
                      <td className="num">{pct(s?.removal?.best)}</td>
                      <td>
                        {p.rankable ? <span className="badge ok">可排名</span> : <span className="badge warn" title={p.rankBlockReasons.join('；')}>受限</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>班次结论与工况路径对照</h2>
          <span className="sub">班次内暴雨或切换会混合反应条件；按稳定工况更接近实际，但会产生短片段和未覆盖时段</span>
        </div>
        <div className="card-pad grid cols-2">
          <div className="stack">
            <h3 className="small">按班次（操作人员便于对照交接记录）</h3>
            <div className="stat-value small">{pctRange(eff.byShift[target].removal)}</div>
            <div className="stat-foot">纳入 {eff.byShift[target].included} 段，覆盖全部投加段 {eff.pairings.length} 段</div>
            <ul className="list-reset stack" style={{ gap: 4 }}>
              {eff.byShift[target].notes.map((n, i) => <li key={i} className="small">· {n}</li>)}
            </ul>
          </div>
          <div className="stack">
            <h3 className="small">按稳定工况（更接近实际反应）</h3>
            <div className="stat-value small">{pctRange(eff.byCondition[target].removal)}</div>
            <div className="stat-foot">纳入 {eff.byCondition[target].included} 段，未覆盖 {minutes(eff.byCondition[target].uncoveredSeconds)}</div>
            <ul className="list-reset stack" style={{ gap: 4 }}>
              {eff.byCondition[target].notes.map((n, i) => <li key={i} className="small">· {n}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
