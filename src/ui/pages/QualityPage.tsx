import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { Declaration } from '../../domain/types';
import { GAP_LABEL, METHOD_LABEL, eligibilityBadge, fmtDateTime, fmtNum, kgRange, pct, shortTime, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  onNavigate: (page: string) => void;
}

export function QualityPage({ state, actions, onNavigate }: Props) {
  const { snapshot, dataset, declarations, candidates } = state;
  const [busy, setBusy] = useState(false);
  const point = dataset.points.find((p) => p.pointCode === state.pointCode);

  const gaps = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.pollutants.flatMap((t) => t.gaps.map((g) => ({ ...g, pollutant: t.pollutant })));
  }, [snapshot]);

  const exclusions = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.pollutants.flatMap((t) => t.exclusions.map((e) => ({ ...e, pollutant: t.pollutant })));
  }, [snapshot]);

  const currentDeclaration = declarations.find((d) => d.pointCode === state.pointCode && d.day === state.day) ?? null;
  const related = candidates.filter((c) => c.pointCode === state.pointCode && c.day === state.day);

  if (!snapshot) {
    return <div className="card card-pad empty">尚无可判定的计算结果，请先在概览页装载资料并计算。</div>;
  }

  const badge = eligibilityBadge(snapshot.eligibility.status);
  const canFile = snapshot.eligibility.status !== 'INELIGIBLE';

  return (
    <div className="stack">
      <div className="grid cols-3">
        <div className="card stat">
          <div className="stat-label">全窗口有效覆盖率</div>
          <div className="stat-value">
            {pct(snapshot.coverage)}
            <span className="stat-unit">/ 线 {pct(snapshot.eligibility.threshold, 0)}</span>
          </div>
          <div className="stat-bar">
            <i
              style={{
                width: `${Math.min(100, snapshot.coverage * 100)}%`,
                background: snapshot.coverage >= snapshot.eligibility.threshold ? 'var(--accent-2)' : 'var(--warn)',
              }}
            />
          </div>
          <div className="stat-foot">
            各污染物取最小值；缺口与排除均不计入分子
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">申报资格</div>
          <div className="stat-value" style={{ paddingTop: 5 }}>
            <span className={`badge ${badge.cls}`} style={{ fontSize: 13, padding: '4px 10px' }}>
              <i className="dot" />
              {badge.label}
            </span>
          </div>
          <div className="stat-foot">{snapshot.eligibility.reasons[0] ?? '无阻断原因'}</div>
          <div className="stat-foot">来源文件 {snapshot.sourceFileIds.length} 份 · 读数 {snapshot.sourceReadingIds.length.toLocaleString('zh-CN')}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">申报版本</div>
          <div className="stat-value small">
            {currentDeclaration ? (
              <span className="badge ok">已出具 · FILED</span>
            ) : (
              <span className="badge neutral">未出具</span>
            )}
          </div>
          <div className="stat-foot">
            {currentDeclaration
              ? `${currentDeclaration.declarationId.slice(-12)} · ${METHOD_LABEL[currentDeclaration.method]}`
              : '出具后来源窗口锁定，迟到数据只能形成重算候选'}
          </div>
          <div className="stat-foot">
            {related.length > 0 ? `${related.length} 个重算候选` : '暂无重算候选'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>申报判定依据</h2>
          <span className="sub">理由与附注分开列出：理由阻断申报，附注只要求披露</span>
        </div>
        <div className="card-pad grid cols-2">
          <div className="stack">
            <h3 className="small" style={{ color: 'var(--danger)' }}>阻断理由</h3>
            {snapshot.eligibility.reasons.length === 0 && <div className="small muted">无</div>}
            <ul className="list-reset stack" style={{ gap: 6 }}>
              {snapshot.eligibility.reasons.map((r, i) => (
                <li key={i} className="checkline">
                  <span className="cross">✕</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="stack">
            <h3 className="small" style={{ color: 'var(--warn)' }}>必须披露的附注</h3>
            {snapshot.eligibility.caveats.length === 0 && <div className="small muted">无</div>}
            <ul className="list-reset stack" style={{ gap: 6 }}>
              {snapshot.eligibility.caveats.map((c, i) => (
                <li key={i} className="checkline">
                  <span className="tick">!</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="card-pad" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="small muted">
              出具申报将锁定 {point?.name}（{state.pointCode}）{state.day} 的来源窗口与来源快照；重复出具不会覆盖既有版本。
            </div>
            <div className="row">
              <button className="btn" onClick={() => onNavigate('recalc')}>
                前往复算候选
              </button>
              <button
                className="btn primary"
                disabled={!canFile || busy || Boolean(currentDeclaration)}
                onClick={async () => {
                  setBusy(true);
                  await actions.fileCurrent();
                  setBusy(false);
                }}
              >
                {currentDeclaration ? '已出具（锁定）' : busy ? '出具中…' : '出具申报版本'}
              </button>
            </div>
          </div>
          {!canFile && (
            <div className="note bad" style={{ marginTop: 10 }}>
              当前覆盖率低于申报线 15 个百分点以上，只能作为内部复核结论，不能出具申报版本。
            </div>
          )}
          {currentDeclaration && (
            <div className="note ok" style={{ marginTop: 10 }}>
              已存在申报版本 {currentDeclaration.declarationId}，截止接收时刻 {fmtDateTime(currentDeclaration.cutoffReceivedAt)}；
              锁定窗口 {fmtDateTime(currentDeclaration.windowFrom)} → {fmtDateTime(currentDeclaration.windowTo)}。
              申报后到达的读数必须走重算候选流程。
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>按污染物的覆盖与资格</h2>
          <span className="sub">浓度覆盖不足时，阈值穿越结论只覆盖有浓度证据的时段</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>污染物</th>
                <th className="num">有效 s</th>
                <th className="num">缺口 s</th>
                <th className="num">排除 s</th>
                <th className="num">覆盖率</th>
                <th className="num">负荷 (kg)</th>
                <th>资格</th>
                <th>关键附注</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.pollutants.map((t) => {
                const b = eligibilityBadge(t.eligibility.status);
                return (
                  <tr key={t.pollutant}>
                    <td>{t.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                    <td className="num">{fmtNum(t.effectiveSeconds, 0)}</td>
                    <td className="num">{fmtNum(t.gapSeconds, 0)}</td>
                    <td className="num">{fmtNum(t.excludedSeconds, 0)}</td>
                    <td className="num">{pct(t.coverage)}</td>
                    <td className="num">{kgRange(t.load, 3)}</td>
                    <td>
                      <span className={`badge ${b.cls}`}>{b.label}</span>
                    </td>
                    <td className="tiny muted">{t.eligibility.caveats[0] ?? '—'}</td>
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
            <h2>缺口清单</h2>
            <span className="sub">共 {gaps.length} 段，全部显式扣除</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table>
              <thead>
                <tr>
                  <th>时段</th>
                  <th>污染物</th>
                  <th>类型</th>
                  <th className="num">秒</th>
                  <th>影响 (kg)</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g, i) => (
                  <tr key={i}>
                    <td className="mono tiny">{shortTime(g.from)} → {shortTime(g.to)}</td>
                    <td className="tiny">{g.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                    <td>
                      <span className="badge info">{GAP_LABEL[g.kind] ?? g.kind}</span>
                    </td>
                    <td className="num">{fmtNum(g.seconds, 0)}</td>
                    <td className="num">{kgRange(g.impacts[0].impactKg, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>排除原因</h2>
            <span className="sub">冲洗 / 校准中 / 旁路 / 故障</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table>
              <thead>
                <tr>
                  <th>状态</th>
                  <th>时段</th>
                  <th className="num">秒</th>
                  <th>原因</th>
                  <th className="num">影响 (kg)</th>
                </tr>
              </thead>
              <tbody>
                {exclusions.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <span className="badge warn">{e.state}</span>
                    </td>
                    <td className="mono tiny">{shortTime(e.from)} → {shortTime(e.to)}</td>
                    <td className="num">{fmtNum(e.seconds, 0)}</td>
                    <td className="tiny">{e.reason}</td>
                    <td className="num">{kgRange(e.impactKg, 3)}</td>
                  </tr>
                ))}
                {exclusions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted small">无排除时段</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            覆盖率 = 有效积分秒数 ÷ 自然日秒数；排除与缺口都进入分母之外——即不计入负荷，也不计为有效覆盖。
          </div>
          <div className="row">
            <span className="badge neutral">窗口 {fmtDateTime(snapshot.windowFrom).slice(0, 16)} → {fmtDateTime(snapshot.windowTo).slice(0, 16)}</span>
            <span className="badge neutral">{METHOD_LABEL[snapshot.method]}</span>
          </div>
        </div>
      </div>
      <DeclarationList declarations={declarations.filter((d) => d.pointCode === state.pointCode)} />
      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">
            当前点位已有 {declarations.filter((d) => d.pointCode === state.pointCode).length} 个申报版本、{related.length} 个重算候选。
          </span>
          <button className="btn small" onClick={() => void actions.refreshLedgers()}>
            刷新台账
          </button>
        </div>
      </div>
    </div>
  );
}

function DeclarationList({ declarations }: { declarations: Declaration[] }) {
  if (declarations.length === 0) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>申报版本（锁定）</h2>
        <span className="sub">FILED 后不可改写</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>自然日</th>
              <th>方法</th>
              <th>来源窗口</th>
              <th>截止接收</th>
              <th className="num">来源读数</th>
              <th className="num">COD (kg)</th>
              <th className="num">氨氮 (kg)</th>
            </tr>
          </thead>
          <tbody>
            {declarations.map((d) => {
              const cod = d.result.pollutants.find((p) => p.pollutant === 'COD')!;
              const nh3n = d.result.pollutants.find((p) => p.pollutant === 'NH3N')!;
              return (
                <tr key={d.declarationId}>
                  <td className="mono tiny">{trimId(d.declarationId, 20, 8)}</td>
                  <td className="mono tiny">{d.day}</td>
                  <td className="tiny">{METHOD_LABEL[d.method]}</td>
                  <td className="mono tiny">
                    {fmtDateTime(d.windowFrom).slice(5, 16)} → {fmtDateTime(d.windowTo).slice(5, 16)}
                  </td>
                  <td className="mono tiny">{fmtDateTime(d.cutoffReceivedAt)}</td>
                  <td className="num">{d.sourceReadingIds.length}</td>
                  <td className="num">{kgRange(cod.load, 3)}</td>
                  <td className="num">{kgRange(nh3n.load, 3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
