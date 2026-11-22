import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { DayChart } from '../charts/DayChart';
import { CATEGORY_LABEL, GAP_LABEL, METHOD_LABEL, eligibilityBadge, fmtDateTime, fmtNum, kgRange, pct, shortTime } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  onNavigate: (page: string) => void;
}

export function OverviewPage({ state, actions, onNavigate }: Props) {
  const { snapshot, pointCode, day, dataset } = state;
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const point = dataset.points.find((p) => p.pointCode === pointCode);
  const plant = dataset.plants.find((p) => p.plantId === point?.plantId);

  const summary = useMemo(() => {
    if (!snapshot) return null;
    const cod = snapshot.pollutants.find((p) => p.pollutant === 'COD')!;
    const nh3n = snapshot.pollutants.find((p) => p.pollutant === 'NH3N')!;
    const gapSeconds = snapshot.pollutants.reduce((a, t) => a + t.gapSeconds, 0);
    const excludedSeconds = snapshot.pollutants.reduce((a, t) => a + t.excludedSeconds, 0);
    return { cod, nh3n, gapSeconds, excludedSeconds };
  }, [snapshot]);

  const badge = snapshot ? eligibilityBadge(snapshot.eligibility.status) : null;

  return (
    <div className="stack">
      {!snapshot && (
        <div className="card card-pad">
          <div className="empty">
            <p style={{ marginBottom: 12 }}>
              本地库中{dataset.readings.length > 0 ? '已有点位资料，正在等待计算结果' : '尚无资料。'}
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => void actions.loadSample()} disabled={state.loading}>
                装载样例资料（三厂四排口 · 35,346 行）
              </button>
              <button className="btn" onClick={() => void actions.recompute()} disabled={dataset.readings.length === 0}>
                重新计算
              </button>
            </div>
          </div>
        </div>
      )}

      {snapshot && summary && badge && (
        <>
          <div className="grid cols-4">
            <div className="card stat">
              <div className="stat-label">
                COD 日负荷 <span className="badge neutral">{snapshot.method === 'SEGMENT' ? '逐片段' : '重采样'}</span>
              </div>
              <div className="stat-value">
                {fmtNum(summary.cod.load.best, 2)}
                <span className="stat-unit">kg</span>
              </div>
              <div className="stat-foot">区间 {kgRange(summary.cod.load, 2)} kg</div>
              <div className="stat-foot">流量加权浓度 {fmtNum(summary.cod.flowWeightedMean, 2)} mg/L</div>
            </div>
            <div className="card stat">
              <div className="stat-label">氨氮 日负荷</div>
              <div className="stat-value">
                {fmtNum(summary.nh3n.load.best, 2)}
                <span className="stat-unit">kg</span>
              </div>
              <div className="stat-foot">区间 {kgRange(summary.nh3n.load, 2)} kg</div>
              <div className="stat-foot">流量加权浓度 {fmtNum(summary.nh3n.flowWeightedMean, 3)} mg/L</div>
            </div>
            <div className="card stat">
              <div className="stat-label">有效覆盖率</div>
              <div className="stat-value">
                {pct(snapshot.coverage)}
                <span className="stat-unit">/ 线 {pct(snapshot.eligibility.threshold, 0)}</span>
              </div>
              <div className="stat-bar">
                <i style={{ width: `${Math.min(100, snapshot.coverage * 100)}%` }} />
              </div>
              <div className="stat-foot">
                缺口 {fmtNum(summary.gapSeconds, 0)} 秒 · 排除 {fmtNum(summary.excludedSeconds, 0)} 秒
              </div>
            </div>
            <div className="card stat">
              <div className="stat-label">申报资格</div>
              <div className="stat-value" style={{ paddingTop: 4 }}>
                <span className={`badge ${badge.cls}`} style={{ fontSize: 13, padding: '4px 10px' }}>
                  <i className="dot" />
                  {badge.label}
                </span>
              </div>
              <div className="stat-foot">
                {snapshot.eligibility.reasons[0] ?? '覆盖率达到申报线，无阻断原因'}
              </div>
              <div className="stat-foot">来源读数 {snapshot.sourceReadingIds.length.toLocaleString('zh-CN')} 条</div>
            </div>
          </div>

          <div className="grid cols-3">
            <div className="card stat">
              <div className="stat-label">阈值穿越（COD / 氨氮）</div>
              <div className="stat-value small">
                {fmtNum(summary.cod.exceedanceSeconds, 0)} s / {fmtNum(summary.nh3n.exceedanceSeconds, 0)} s
              </div>
              <div className="stat-foot">
                峰值 {fmtNum(summary.cod.peakConcentration, 2)} / {fmtNum(summary.nh3n.peakConcentration, 2)} mg/L
              </div>
              <div className="stat-foot">
                {summary.cod.exceedances.length > 0 ? `COD 超限 ${summary.cod.exceedances.length} 段，最长 ${fmtNum(Math.max(...summary.cod.exceedances.map((e) => e.seconds)), 1)} s` : '无超限'}
              </div>
            </div>
            <div className="card stat">
              <div className="stat-label">1 小时峰值负荷</div>
              <div className="stat-value small">
                {summary.cod.peakWindow ? `${fmtNum(summary.cod.peakWindow.loadKg, 3)} kg` : '—'}
              </div>
              <div className="stat-foot">
                {summary.cod.peakWindow
                  ? `${fmtDateTime(summary.cod.peakWindow.from).slice(11)} – ${fmtDateTime(summary.cod.peakWindow.to).slice(11)}`
                  : '无有效负荷'}
              </div>
              <div className="stat-foot">
                重采样核验 {snapshot.resampleCheck?.verified ? '通过' : '未通过'} · 网格 {snapshot.resampleCheck?.gridSeconds}s
              </div>
            </div>
            <div className="card stat">
              <div className="stat-label">索引负担 / 耗时</div>
              <div className="stat-value small">
                {snapshot.routingStats.segmentCount} 段 · {snapshot.routingStats.readingKnots} 结点
              </div>
              <div className="stat-foot">
                网格单元 {snapshot.routingStats.gridCells.toLocaleString('zh-CN')} · 计算 {fmtNum(snapshot.computeMs, 1)} ms
              </div>
              <div className="stat-foot">
                {snapshot.method === 'SEGMENT' ? '逐片段路线：局部证据最全，跨层查询索引较重' : '重采样路线：汇总轻，已通过误差界核验'}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>当日浓度与负荷率</h2>
              <span className="sub">
                {plant?.shortName} · {point?.name}（{pointCode}）· {day} · {METHOD_LABEL[snapshot.method]}
              </span>
              <div className="spacer" />
              <button className="btn small" onClick={() => onNavigate('trace')}>
                查看片段追溯 →
              </button>
            </div>
            <DayChart snapshot={snapshot} selectedSegmentId={selectedSegmentId} onSelectSegment={setSelectedSegmentId} />
            <div className="detail-drawer" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="small muted">
                  条形背景：<span style={{ color: 'var(--excluded)' }}>■</span> 排除状态 ·{' '}
                  <span style={{ color: 'var(--gap)' }}>■</span> 采样空档 ·{' '}
                  <span style={{ color: 'var(--danger)' }}>■</span> 超过排放限值。点击曲线可选择相邻片段。
                </div>
                <div className="tiny muted">
                  时钟校正：{snapshot.clockNotes.length} 台仪表参与对齐
                </div>
              </div>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <div className="card-head">
                <h2>不确定范围来源</h2>
                <span className="sub">逐片段合成 × k={state.scope.uncertaintyMultiplier}</span>
              </div>
              <div className="card-pad stack">
                <ul className="list-reset stack" style={{ gap: 7 }}>
                  {snapshot.uncertaintyNotes.map((note, i) => (
                    <li key={i} className="small" style={{ display: 'flex', gap: 8 }}>
                      <span style={{ color: 'var(--accent)' }}>·</span>
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>最快结论</h2>
                <span className="sub">有效片段 / 缺口 / 排除</span>
              </div>
              <div className="card-pad">
                <table>
                  <thead>
                    <tr>
                      <th>污染物</th>
                      <th className="num">负荷 (kg)</th>
                      <th className="num">有效 s</th>
                      <th className="num">缺口 s</th>
                      <th className="num">覆盖率</th>
                      <th>资格</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.pollutants.map((t) => {
                      const b = eligibilityBadge(t.eligibility.status);
                      return (
                        <tr key={t.pollutant}>
                          <td>{t.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                          <td className="num">{kgRange(t.load, 3)}</td>
                          <td className="num">{fmtNum(t.effectiveSeconds, 0)}</td>
                          <td className="num">{fmtNum(t.gapSeconds, 0)}</td>
                          <td className="num">{pct(t.coverage)}</td>
                          <td>
                            <span className={`badge ${b.cls}`}>{b.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="note" style={{ marginTop: 12 }}>
                  负荷 = 浓度(mg/L) × 流量(m³/h) × 秒 ÷ 3.6×10⁶。缺口与排除时段不计入负荷，仅量化影响。
                </div>
              </div>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <div className="card-head">
                <h2>缺口与排除摘要</h2>
                <span className="sub">每段都保留来源与影响区间</span>
              </div>
              <div className="table-wrap" style={{ maxHeight: 320 }}>
                <table>
                  <thead>
                    <tr>
                      <th>时段</th>
                      <th>类别</th>
                      <th className="num">时长 s</th>
                      <th>影响 (kg)</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...snapshot.pollutants.flatMap((t) => t.gaps.map((g) => ({ ...g, pollutant: t.pollutant })))]
                      .sort((a, b) => a.from - b.from)
                      .slice(0, 12)
                      .map((g, i) => (
                        <tr key={`${g.pollutant}-${i}`}>
                          <td className="mono">{shortTime(g.from)} → {shortTime(g.to)}</td>
                          <td>
                            <span className={`badge ${g.kind === 'EXCLUDED_STATE' ? 'warn' : 'info'}`}>
                              {GAP_LABEL[g.kind] ?? g.kind}
                            </span>
                          </td>
                          <td className="num">{fmtNum(g.seconds, 0)}</td>
                          <td className="num">{kgRange(g.impacts[0].impactKg, 3)}</td>
                          <td className="small muted">{g.reason}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>片段类别分布</h2>
                <span className="sub">按类别汇总的片段数与时长</span>
              </div>
              <div className="card-pad">
                {(() => {
                  const segs = snapshot.pollutants.flatMap((t) => t.segments);
                  const byCat = new Map<string, { count: number; seconds: number }>();
                  for (const s of segs) {
                    const e = byCat.get(s.category) ?? { count: 0, seconds: 0 };
                    e.count += 1;
                    e.seconds += s.durationSeconds;
                    byCat.set(s.category, e);
                  }
                  const max = Math.max(...[...byCat.values()].map((v) => v.seconds), 1);
                  return (
                    <div className="stack" style={{ gap: 8 }}>
                      {[...byCat.entries()].map(([cat, v]) => (
                        <div key={cat}>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span className="small">
                              {CATEGORY_LABEL[cat] ?? cat} <span className="muted tiny">（{v.count} 段）</span>
                            </span>
                            <span className="mono small">{fmtNum(v.seconds, 0)} s</span>
                          </div>
                          <div className="stat-bar">
                            <i
                              style={{
                                width: `${(v.seconds / max) * 100}%`,
                                background: cat === 'VALID' ? 'var(--accent-2)' : cat === 'EXCLUDED_STATE' ? 'var(--excluded)' : 'var(--gap)',
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
