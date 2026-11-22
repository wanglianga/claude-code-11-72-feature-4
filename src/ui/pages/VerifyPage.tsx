import { useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { METHOD_LABEL, fmtDateTime, fmtNum, kgRange, pct } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

export function VerifyPage({ state, actions }: Props) {
  const { comparison, snapshot, manifest, fingerprints } = state;
  const [busy, setBusy] = useState(false);
  const check = snapshot?.resampleCheck;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>样例核验：同一组资料 · 两条路线</h2>
          <span className="sub">
            40 秒冲击 / 片段中途校准 / 三分钟缺测 / 旁路与冲洗 / 设备交接
          </span>
          <div className="spacer" />
          <button
            className="btn primary"
            disabled={busy || state.dataset.readings.length === 0}
            onClick={async () => {
              setBusy(true);
              await actions.recompute({ compare: true });
              setBusy(false);
            }}
          >
            {busy ? '核验中…' : '运行双路线核验'}
          </button>
        </div>
        <div className="card-pad">
          {!comparison ? (
            <div className="empty">
              点击右上按钮，在同一份资料上分别运行“逐有效片段积分”和“误差界重采样积分”，
              比较负荷范围、峰值窗口、阈值穿越与缺口说明。
            </div>
          ) : (
            <div className="stack">
              <div className="row">
                <span className={`badge ${comparison.verified ? 'ok' : 'bad'}`}>
                  {comparison.verified ? '核验通过' : '存在差异，需人工复核'}
                </span>
                <span className="badge neutral">点位 {comparison.segment.pointCode}</span>
                <span className="badge neutral">自然日 {comparison.segment.day}</span>
                <span className="badge neutral">缺口说明 {comparison.gapConsistency.consistent ? '一致' : '不一致'}</span>
                <span className="badge neutral">来源链 {comparison.provenanceComplete ? '完整' : '缺失'}</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>污染物</th>
                    <th>逐片段区间 (kg)</th>
                    <th>重采样区间 (kg)</th>
                    <th className="num">范围重叠比</th>
                    <th className="num">峰值窗口偏移 s</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.agreement.map((a) => (
                    <tr key={a.pollutant}>
                      <td>{a.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                      <td className="mono tiny">{kgRange(a.segment, 4)}</td>
                      <td className="mono tiny">{kgRange(a.resample, 4)}</td>
                      <td className="num">{a.overlapRatio.toFixed(5)}</td>
                      <td className="num">{fmtNum(a.peakShiftSeconds, 1)}</td>
                      <td>
                        <span className={`badge ${a.withinTolerance ? 'ok' : 'warn'}`}>
                          {a.withinTolerance ? '一致' : '超容差'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="list-reset stack" style={{ gap: 5 }}>
                {comparison.notes.map((n, i) => (
                  <li key={i} className="small" style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--accent)' }}>·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {check && (
        <div className="card">
          <div className="card-head">
            <h2>重采样收敛与误差界</h2>
            <span className="sub">同一编织结果；网格越细越接近精确积分</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>网格</th>
                  <th className="num">负荷偏差</th>
                  <th className="num">峰值窗口偏移 s</th>
                  <th className="num">穿越对称差 s</th>
                  <th className="num">梯形误差界 kg</th>
                  <th className="num">COD 区间 (kg)</th>
                  <th>结论</th>
                </tr>
              </thead>
              <tbody>
                {check.gridResults.map((g) => (
                  <tr key={g.gridSeconds} className={g.gridSeconds === check.chosenGridSeconds ? 'selected' : ''}>
                    <td className="mono">{g.gridSeconds}s</td>
                    <td className="num">{fmtNum(g.loadBestDriftPercent, 4)}%</td>
                    <td className="num">{fmtNum(g.peakShiftSeconds, 0)}</td>
                    <td className="num">{fmtNum(g.exceedanceSymmetricDiffSeconds, 1)}</td>
                    <td className="num">±{fmtNum(g.errorBoundKg, 4)}</td>
                    <td className="num">{kgRange(g.totalLoad.COD, 3)}</td>
                    <td>
                      <span className={`badge ${g.accepted ? 'ok' : 'warn'}`}>{g.accepted ? '接受' : '未通过'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-pad stack">
            {check.notes.map((n, i) => (
              <div key={i} className="note small">{n}</div>
            ))}
            <div className="note warn small">
              <strong>朴素重采样反例：</strong>
              {check.naiveCheck.note}
              <div className="tiny" style={{ marginTop: 3 }}>
                负荷偏差 {fmtNum(check.naiveCheck.loadErrorPercent, 2)}% · 阈值穿越时长差 {fmtNum(check.naiveCheck.missedExceedanceSeconds, 0)} 秒
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>两条路线的取舍证据</h2>
          <span className="sub">稀疏读数 + 频繁状态切换 → 逐片段；频繁跨层汇总 → 重采样</span>
        </div>
        <div className="card-pad grid cols-2">
          <div className="stack">
            <h3 className="small">逐有效片段积分</h3>
            <ul className="list-reset stack" style={{ gap: 5 }}>
              <li className="checkline"><span className="tick">+</span><span>保留更多局部证据：每个片段都引用自己的读数、校准、状态与文件</span></li>
              <li className="checkline"><span className="tick">+</span><span>40 秒冲击等窄事件不会被网格稀释，边界精确到读数时刻</span></li>
              <li className="checkline"><span className="cross">−</span><span>查询索引较重：片段数与读数结点数随频率增长</span></li>
            </ul>
            {comparison && (
              <div className="note small">
                当前：{comparison.segment.routingStats.segmentCount} 段 · {comparison.segment.routingStats.readingKnots} 个读数结点 · 计算 {fmtNum(comparison.segment.computeMs, 1)} ms
              </div>
            )}
          </div>
          <div className="stack">
            <h3 className="small">经误差界验证的重采样积分</h3>
            <ul className="list-reset stack" style={{ gap: 5 }}>
              <li className="checkline"><span className="tick">+</span><span>汇总较易：固定网格，便于跨自然日/跨点位聚合</span></li>
              <li className="checkline"><span className="tick">+</span><span>必须证明细网格下的负荷范围、峰值窗口与阈值穿越不改变</span></li>
              <li className="checkline"><span className="cross">−</span><span>校验成本高；粗网格漏检窄脉冲（见上方朴素反例）</span></li>
            </ul>
            {comparison && (
              <div className="note small">
                当前：{comparison.resample.routingStats.gridCells.toLocaleString('zh-CN')} 个网格单元 · 计算 {fmtNum(comparison.resample.computeMs, 1)} ms · 核验 {check?.verified ? '通过' : '未通过'}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>关键时间线</h2>
            <span className="sub">来自样例清单与片段边界</span>
          </div>
          <div className="card-pad">
            {manifest ? (
              <ul className="list-reset stack" style={{ gap: 7 }}>
                {manifest.focus.scenario.map((s, i) => (
                  <li key={i} className="small" style={{ display: 'flex', gap: 8 }}>
                    <span className="badge neutral" style={{ flexShrink: 0 }}>{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted small">未读取样例清单</div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>文件指纹校验</h2>
            <span className="sub">浏览器内计算的 SHA-256 与清单比对</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table>
              <thead>
                <tr>
                  <th>文件</th>
                  <th>指纹</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {fingerprints.length > 0 ? (
                  fingerprints.map((f) => (
                    <tr key={f.fileName}>
                      <td className="mono tiny">{f.fileName}</td>
                      <td className="mono tiny">{f.actual.slice(0, 16)}…</td>
                      <td>
                        <span className={`badge ${f.ok ? 'ok' : 'bad'}`}>{f.ok ? '匹配' : '不一致'}</span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="muted small">
                      指纹在“装载样例”时计算并显示；从本地库恢复时请至“接入账”页查看已存指纹。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {snapshot && (
        <div className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="small muted">
              当前快照：{METHOD_LABEL[snapshot.method]} · 计算耗时 {fmtNum(snapshot.computeMs, 1)} ms · 覆盖率 {pct(snapshot.coverage)}
            </div>
            <div className="row">
              <span className="badge neutral">核验方法版本 {snapshot.engineVersion}</span>
              <span className="badge neutral">窗口 {fmtDateTime(snapshot.windowFrom).slice(0, 16)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
