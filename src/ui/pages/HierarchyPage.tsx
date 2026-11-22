import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { pickDays } from '../useAppState';
import { METHOD_LABEL, eligibilityBadge, fmtNum, pct } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  onNavigate: (page: string) => void;
}

type Level = 'plant' | 'point' | 'day';

export function HierarchyPage({ state, actions, onNavigate }: Props) {
  const [level, setLevel] = useState<Level>('plant');
  const [openPlant, setOpenPlant] = useState<string | null>(state.dataset.plants[0]?.plantId ?? null);
  const { dataset, snapshot, comparison } = state;

  const byPlant = useMemo(() => {
    const map = new Map<string, { days: number; readings: number; instruments: number }>();
    for (const p of dataset.points) {
      const readings = dataset.readings.filter((r) => r.pointCode === p.pointCode);
      const days = new Set(readings.map((r) => r.dayKey));
      const instruments = dataset.instruments.filter((i) => i.pointCode === p.pointCode);
      const prev = map.get(p.plantId) ?? { days: 0, readings: 0, instruments: 0 };
      map.set(p.plantId, {
        days: prev.days + days.size,
        readings: prev.readings + readings.length,
        instruments: prev.instruments + instruments.length,
      });
    }
    return map;
  }, [dataset]);

  const snapshotFor = (pointCode: string) =>
    snapshot && snapshot.pointCode === pointCode ? snapshot : null;

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <div className="field">
              <label>查询层级</label>
              <select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
                <option value="plant">厂站 → 点位 → 自然日</option>
                <option value="point">点位 → 自然日 → 片段</option>
                <option value="day">自然日 → 片段 → 读数</option>
              </select>
            </div>
            <div className="field">
              <label>当前点位</label>
              <select value={state.pointCode} onChange={(e) => actions.setPointCode(e.target.value)}>
                {dataset.points.map((p) => (
                  <option key={p.pointCode} value={p.pointCode}>
                    {p.pointCode} · {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>自然日</label>
              <select value={state.day} onChange={(e) => actions.setDay(e.target.value)}>
                {pickDays(dataset, state.pointCode).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => void actions.recompute()} disabled={state.computing || dataset.readings.length === 0}>
              {state.computing ? '计算中…' : '重算当前点位'}
            </button>
            <button className="btn" onClick={() => onNavigate('segments')}>
              进入片段追溯
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>层级索引</h2>
          <span className="sub">
            同一编号可复用；设备实例与日汇总按锚点衔接。展开层级查看粒度与跳转入口。
          </span>
        </div>
        <div className="card-pad stack">
          {dataset.plants.map((plant) => {
            const points = dataset.points.filter((p) => p.plantId === plant.plantId);
            const agg = byPlant.get(plant.plantId);
            const open = openPlant === plant.plantId || level !== 'plant';
            return (
              <div key={plant.plantId} className="card" style={{ boxShadow: 'none' }}>
                <button
                  className="card-head"
                  style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => setOpenPlant(open && level === 'plant' ? null : plant.plantId)}
                  aria-expanded={open}
                >
                  <strong>{plant.shortName}</strong>
                  <span className="sub">{plant.name}</span>
                  <div className="spacer" />
                  <span className="badge neutral">{points.length} 个点位</span>
                  <span className="badge neutral">{agg?.readings.toLocaleString('zh-CN') ?? 0} 条读数</span>
                  <span className="badge neutral">限值 COD {plant.dischargeStandard.COD} / 氨氮 {plant.dischargeStandard.NH3N}</span>
                  <span className="muted small">{open ? '收起' : '展开'}</span>
                </button>
                {open && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>点位</th>
                          <th>复用</th>
                          <th className="num">仪表实例</th>
                          <th className="num">有数据天数</th>
                          <th className="num">读数</th>
                          <th>当前计算</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {points.map((p) => {
                          const readings = dataset.readings.filter((r) => r.pointCode === p.pointCode);
                          const days = pickDays(dataset, p.pointCode);
                          const instruments = dataset.instruments.filter((i) => i.pointCode === p.pointCode);
                          const snap = snapshotFor(p.pointCode);
                          return (
                            <tr key={p.pointCode} className={state.pointCode === p.pointCode ? 'selected' : ''}>
                              <td>
                                <button className="linklike" onClick={() => actions.setPointCode(p.pointCode)}>
                                  {p.pointCode}
                                </button>
                                <div className="tiny muted">{p.name}</div>
                              </td>
                              <td>{p.reused ? <span className="badge warn">编号复用</span> : <span className="badge neutral">唯一</span>}</td>
                              <td className="num">{instruments.length}</td>
                              <td className="num">{days.length}</td>
                              <td className="num">{readings.length.toLocaleString('zh-CN')}</td>
                              <td>
                                {snap ? (
                                  <span className={`badge ${eligibilityBadge(snap.eligibility.status).cls}`}>
                                    {eligibilityBadge(snap.eligibility.status).label} · {pct(snap.coverage)}
                                  </span>
                                ) : (
                                  <span className="muted small">未计算</span>
                                )}
                              </td>
                              <td>
                                <button
                                  className="btn small"
                                  onClick={() => {
                                    actions.setPointCode(p.pointCode);
                                    actions.setDay(days[0] ?? state.day);
                                  }}
                                >
                                  定位
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {snapshot && (
        <div className="card">
          <div className="card-head">
            <h2>当前点位当日索引</h2>
            <span className="sub">
              {snapshot.pointCode} · {snapshot.day} · {METHOD_LABEL[snapshot.method]}
            </span>
            <div className="spacer" />
            <button className="btn small" onClick={() => onNavigate('trace')}>
              追溯来源链
            </button>
          </div>
          <div className="card-pad">
            <table>
              <thead>
                <tr>
                  <th>污染物</th>
                  <th>片段</th>
                  <th>读数结点</th>
                  <th>网格单元</th>
                  <th>来源读数</th>
                  <th>仪器链</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.pollutants.map((t) => (
                  <tr key={t.pollutant}>
                    <td>{t.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                    <td className="num">{t.segments.length}</td>
                    <td className="num">{t.knotCount}</td>
                    <td className="num">{t.gridCellCount}</td>
                    <td className="num">{t.sourceReadingIds.length}</td>
                    <td className="mono tiny">
                      {snapshot.instrumentChain
                        .filter((c) => c.metric === t.pollutant)
                        .map((c) => c.instrumentId)
                        .filter((v, i, arr) => arr.indexOf(v) === i)
                        .join(' → ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {comparison && (
              <div className="note ok" style={{ marginTop: 12 }}>
                双路线对比结果：{comparison.verified ? '两条路线在负荷范围、峰值、阈值穿越与缺口说明上一致' : '存在差异，请查看“样例核验”页'}
                。逐片段 {comparison.segment.routingStats.segmentCount} 段 / 重采样 {comparison.resample.routingStats.gridCells} 个网格单元。
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            层级查询口径：厂站汇总不跨厂站合并点位；点位内按自然日切分；自然日内按片段；片段内可回溯到读数、校准与状态。
          </div>
          <div className="row">
            <span className="badge neutral">读数总数 {dataset.readings.length.toLocaleString('zh-CN')}</span>
            <span className="badge neutral">文件 {dataset.files.length}</span>
            <span className="badge neutral">仪表 {dataset.instruments.length}</span>
            <span className="badge neutral">校准 {dataset.calibrations.length}</span>
          </div>
        </div>
        {snapshot && (
          <div className="small muted" style={{ marginTop: 6 }}>
            当前快照计算耗时 {fmtNum(snapshot.computeMs, 1)} ms；若改用另一路线，请在上方“方法”切换后重算。
          </div>
        )}
      </div>
    </div>
  );
}
