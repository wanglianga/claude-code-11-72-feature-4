import { useState } from 'react';
import type { CoagActions, CoagState } from './useCoagState';
import { fmtNum, hhmm, minutes, num, pctRange } from './format';
import type { CoagTarget } from '../../coag/types';

interface Props {
  state: CoagState;
  actions: CoagActions;
}

const TARGETS: CoagTarget[] = ['COD', 'NH3N'];

export function CoagConditionPage({ state, actions }: Props) {
  const eff = state.efficiency;
  const [target, setTarget] = useState<CoagTarget>('COD');
  const [selected, setSelected] = useState<string | null>(null);

  if (!eff) {
    return <div className="card card-pad"><div className="empty">尚未装载混凝样例或计算尚未完成。</div></div>;
  }

  const active = eff.conditionSummaries.find((c) => c.segmentId === selected) ?? eff.conditionSummaries[0];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>工况分段与效率对照</h2>
          <span className="sub">结合流量、pH、温度、搅拌状态与切换形成可变长度区间；短片段与未覆盖时段都会披露</span>
          <div className="spacer" />
          {TARGETS.map((t) => (
            <button key={t} className={`btn small ${target === t ? 'primary' : ''}`} onClick={() => setTarget(t)}>
              {t === 'COD' ? 'COD' : '氨氮'}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>工况段</th>
                <th className="num">时长</th>
                <th className="num">流量 m³/h</th>
                <th className="num">pH</th>
                <th className="num">温度 ℃</th>
                <th className="num">浊度 NTU</th>
                <th>搅拌/旁路</th>
                <th className="num">{target} 去除</th>
                <th className="num">单位药耗</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>
              {eff.conditionSummaries.map((c) => {
                const seg = eff.conditions.find((x) => x.segmentId === c.segmentId);
                const e = c.efficiency[target];
                return (
                  <tr key={c.segmentId} className={c.segmentId === active?.segmentId ? 'selected' : ''} onClick={() => setSelected(c.segmentId)}>
                    <td className="mono tiny">{hhmm(c.from)}–{hhmm(c.to)}</td>
                    <td className="num">{minutes(seg?.seconds ?? 0)}</td>
                    <td className="num">{num(seg?.meanFlowM3h, 0)}</td>
                    <td className="num">{num(seg?.meanPh, 2)}</td>
                    <td className="num">{num(seg?.meanTempC, 1)}</td>
                    <td className="num">{num(seg?.meanTurbidityNtu, 1)}</td>
                    <td>
                      {seg?.mixing !== 'ON' && <span className="badge warn" style={{ marginRight: 4 }}>{seg?.mixing === 'OFF' ? '搅拌停止' : '搅拌降速'}</span>}
                      {(seg?.bypassFraction ?? 0) > 0 && <span className="badge bad">旁路</span>}
                      {seg?.mixing === 'ON' && (seg?.bypassFraction ?? 0) === 0 && <span className="badge ok">正常</span>}
                    </td>
                    <td className="num">{pctRange(e.removal)}</td>
                    <td className="num">{e.yieldKgPerKg ? fmtNum(e.yieldKgPerKg.best, 2) : '—'}</td>
                    <td>
                      {c.shortSegment ? <span className="badge warn">短片段</span> : c.stable ? <span className="badge ok">稳定</span> : <span className="badge neutral">受限</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>选中工况段</h2>
            <span className="sub">{active ? `${hhmm(active.from)}–${hhmm(active.to)}` : '—'}</span>
          </div>
          <div className="card-pad stack">
            {!active ? (
              <div className="muted small">选择一段工况。</div>
            ) : (
              <>
                <div className="row">
                  {active.stable ? <span className="badge ok">稳定工况</span> : <span className="badge warn">受限</span>}
                  {active.shortSegment && <span className="badge warn">短片段（仅参考）</span>}
                  {active.shiftIds.map((s) => <span key={s} className="badge neutral">{eff.shifts.find((x) => x.shiftId === s)?.code ?? s}</span>)}
                </div>
                <div className="stat-value small">{pctRange(active.efficiency[target].removal)}</div>
                <dl className="kv">
                  <dt>纳入/排除</dt>
                  <dd className="mono">{active.efficiency[target].included} 段 / {active.efficiency[target].excluded} 段</dd>
                  <dt>单位药耗</dt>
                  <dd className="mono">{active.efficiency[target].yieldKgPerKg ? `${fmtNum(active.efficiency[target].yieldKgPerKg.best, 2)} kg/kg` : '—'}</dd>
                  <dt>对应班次</dt>
                  <dd>{active.shiftIds.map((s) => eff.shifts.find((x) => x.shiftId === s)?.code ?? s).join('、') || '跨班次或未归属'}</dd>
                </dl>
                <ul className="list-reset stack" style={{ gap: 4 }}>
                  {[...active.notes, ...active.efficiency[target].notes].map((n, i) => (
                    <li key={i} className="small">· {n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>为什么有时不能给单一结论</h2>
          </div>
          <div className="card-pad stack">
            <div className="note small">
              短片段（&lt;90 分钟）样本少；未覆盖时段没有任何可用配对；两类情况都不会被强行平均成当日唯一效率。
            </div>
            <div className="row">
              <span className="badge neutral">全窗口配对 {eff.pairings.length} 段</span>
              <span className="badge neutral">稳定工况纳入 {eff.byCondition[target].included} 段</span>
              <span className="badge warn">未覆盖 {minutes(eff.byCondition[target].uncoveredSeconds)}</span>
            </div>
            <div className="small muted">
              按班次路径纳入 {eff.byShift[target].included} 段、去除 {pctRange(eff.byShift[target].removal)}；
              若把班次路径直接当作反应条件结论，暴雨与切换会被平均进来。按稳定工况路径更接近实际反应，但会留下未覆盖时段。
            </div>
            <button className="btn small" onClick={() => void actions.recompute()} disabled={state.computing}>重算</button>
          </div>
        </div>
      </div>
    </div>
  );
}
