import { useEffect, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { MonthLoad } from '../../domain/types';
import { createWorkerClient } from '../../worker/client';
import { METHOD_LABEL, eligibilityBadge, fmtNum, kgRange, pct } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

export function MonthPage({ state, actions }: Props) {
  const [monthLoad, setMonthLoad] = useState<MonthLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const month = state.day.slice(0, 7);

  useEffect(() => {
    if (state.dataset.readings.length === 0) {
      setMonthLoad(null);
      return;
    }
    let alive = true;
    const client = createWorkerClient();
    setBusy(true);
    setError(null);
    client
      .request<MonthLoad>({
        type: 'computeMonth',
        dataset: state.dataset,
        pointCode: state.pointCode,
        month,
        method: state.method,
        scope: state.scope,
      })
      .then((res) => {
        if (alive) setMonthLoad(res);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
        client.terminate();
      });
    return () => {
      alive = false;
      client.terminate();
    };
  }, [month, state.dataset, state.method, state.pointCode, state.scope]);

  const badge = monthLoad ? eligibilityBadge(monthLoad.eligibility) : null;

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <div className="field">
              <label>月份</label>
              <input
                type="month"
                value={month}
                onChange={(e) => {
                  if (e.target.value) actions.setDay(`${e.target.value}-${String(Math.min(Number(state.day.slice(8, 10)) || 1, 28)).padStart(2, '0')}`);
                }}
              />
            </div>
            <div className="field">
              <label>点位</label>
              <select value={state.pointCode} onChange={(e) => actions.setPointCode(e.target.value)}>
                {state.dataset.points.map((p) => (
                  <option key={p.pointCode} value={p.pointCode}>
                    {p.pointCode} · {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>方法</label>
              <select value={state.method} onChange={(e) => actions.setMethod(e.target.value as AppState['method'])}>
                <option value="SEGMENT">{METHOD_LABEL.SEGMENT}</option>
                <option value="RESAMPLE">{METHOD_LABEL.RESAMPLE}</option>
              </select>
            </div>
          </div>
          {badge && (
            <span className={`badge ${badge.cls}`} style={{ fontSize: 12 }}>
              {badge.label}
            </span>
          )}
        </div>
      </div>

      {busy && <div className="card card-pad"><span className="spinner" /> 正在逐日计算月负荷…</div>}
      {error && <div className="note bad">{error}</div>}

      {monthLoad && !busy && (
        <>
          <div className="grid cols-4">
            <div className="card stat">
              <div className="stat-label">有数据天数</div>
              <div className="stat-value">
                {monthLoad.daysWithData}
                <span className="stat-unit">/ {monthLoad.daysInMonth}</span>
              </div>
              <div className="stat-foot">缺失 {monthLoad.missingDays.length} 天不按零负荷</div>
            </div>
            <div className="card stat">
              <div className="stat-label">月覆盖均值</div>
              <div className="stat-value">{pct(monthLoad.coverage)}</div>
              <div className="stat-foot">逐日覆盖率的算术平均</div>
            </div>
            {monthLoad.pollutants.map((p) => (
              <div className="card stat" key={p.pollutant}>
                <div className="stat-label">{p.pollutant === 'COD' ? 'COD 月负荷' : '氨氮 月负荷'}</div>
                <div className="stat-value">
                  {fmtNum(p.load.best, 2)}
                  <span className="stat-unit">kg</span>
                </div>
                <div className="stat-foot">区间 {kgRange(p.load, 2)} kg</div>
                <div className="stat-foot">日均覆盖 {pct(p.coverageMean)}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{month} 月负荷</h2>
              <span className="sub">{METHOD_LABEL[monthLoad.method]} · 逐日求和</span>
            </div>
            <div className="card-pad">
              <table>
                <thead>
                  <tr>
                    <th>污染物</th>
                    <th className="num">月负荷 (kg)</th>
                    <th className="num">区间下限</th>
                    <th className="num">区间上限</th>
                    <th className="num">有效秒数</th>
                    <th className="num">日均覆盖</th>
                  </tr>
                </thead>
                <tbody>
                  {monthLoad.pollutants.map((p) => (
                    <tr key={p.pollutant}>
                      <td>{p.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                      <td className="num">{fmtNum(p.load.best, 3)}</td>
                      <td className="num">{fmtNum(p.load.min, 3)}</td>
                      <td className="num">{fmtNum(p.load.max, 3)}</td>
                      <td className="num">{fmtNum(p.effectiveSeconds, 0)}</td>
                      <td className="num">{pct(p.coverageMean)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="list-reset stack" style={{ gap: 5, marginTop: 12 }}>
                {monthLoad.notes.map((n, i) => (
                  <li key={i} className="small muted">· {n}</li>
                ))}
              </ul>
              {monthLoad.missingDays.length > 0 && (
                <div className="note warn" style={{ marginTop: 10 }}>
                  缺失日：{monthLoad.missingDays.join('，')}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!monthLoad && !busy && state.dataset.readings.length === 0 && (
        <div className="card card-pad empty">本地库为空，请先在概览页装载样例资料。</div>
      )}
    </div>
  );
}
