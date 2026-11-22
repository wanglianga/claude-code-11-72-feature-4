import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { calibrationRegimes } from '../../domain/weave';
import { buildIndex } from '../../domain/weave';
import { dayStartMs } from '../../domain/time';
import { fmtDateTime, shortTime, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

export function InstrumentPage({ state }: Props) {
  const { dataset, pointCode } = state;
  const [selectedInstrument, setSelectedInstrument] = useState<string | null>(null);
  const windowFrom = dayStartMs(state.day);
  const windowTo = windowFrom + 86_400_000;

  const index = useMemo(
    () =>
      buildIndex(
        dataset.readings,
        dataset.instruments,
        dataset.calibrations,
        dataset.states,
        dataset.bindings,
      ),
    [dataset],
  );

  const pointInstruments = dataset.instruments.filter((i) => i.pointCode === pointCode);
  const activeInstrument = pointInstruments.find((i) => i.instrumentId === selectedInstrument) ?? pointInstruments[0] ?? null;
  const activeStates = activeInstrument
    ? dataset.states.filter((s) => s.instrumentId === activeInstrument.instrumentId)
    : [];
  const activeCalibrations = activeInstrument
    ? dataset.calibrations.filter((c) => c.instrumentId === activeInstrument.instrumentId)
    : [];
  const activeBindings = dataset.bindings.filter((b) => b.pointCode === pointCode && (!activeInstrument || b.instrumentId === activeInstrument.instrumentId));

  const regimes = useMemo(() => {
    if (!activeInstrument) return [];
    const metric = activeInstrument.metric;
    const ctx = {
      metric,
      pointCode,
      plantId: activeInstrument.plantId,
      instruments: pointInstruments.filter((i) => i.metric === metric),
      bindings: dataset.bindings.filter((b) => b.pointCode === pointCode && b.metric === metric),
      calibrations: dataset.calibrations.filter((c) => pointInstruments.some((i) => i.instrumentId === c.instrumentId && i.metric === metric)),
      states: dataset.states.filter((s) => pointInstruments.some((i) => i.instrumentId === s.instrumentId && i.metric === metric)),
      readings: dataset.readings.filter((r) => r.pointCode === pointCode && r.metric === metric),
      effectiveReadings: dataset.readings.filter((r) => r.pointCode === pointCode && r.metric === metric && r.qualityFlag !== 'INVALID'),
    };
    return calibrationRegimes(ctx, index, windowFrom, windowTo).filter((r) => r.instrumentId === activeInstrument.instrumentId);
  }, [activeInstrument, dataset, index, pointCode, pointInstruments, windowFrom, windowTo]);

  const pointReadings = activeInstrument
    ? dataset.readings.filter((r) => r.instrumentId === activeInstrument.instrumentId && r.dayKey === state.day)
    : [];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>设备履历</h2>
          <span className="sub">
            点位编号可复用：同一编号按仪表实例衔接，实例有效期与时钟偏移决定读数归属
          </span>
          <div className="spacer" />
          <span className="badge neutral">点位 {pointCode}</span>
          <span className="badge neutral">{pointInstruments.length} 台实例</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>实例</th>
                <th>指标</th>
                <th>型号 / 序列号</th>
                <th>基础系数</th>
                <th>标称间隔</th>
                <th>时钟校正</th>
                <th>安装</th>
                <th>拆除</th>
                <th>当日读数</th>
              </tr>
            </thead>
            <tbody>
              {pointInstruments.map((i) => {
                const count = dataset.readings.filter((r) => r.instrumentId === i.instrumentId && r.dayKey === state.day).length;
                return (
                  <tr
                    key={i.instrumentId}
                    className={activeInstrument?.instrumentId === i.instrumentId ? 'selected' : ''}
                    onClick={() => setSelectedInstrument(i.instrumentId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="mono tiny">{i.instrumentId}</td>
                    <td className="tiny">{i.metric === 'FLOW' ? '流量' : i.metric === 'COD' ? 'COD' : '氨氮'}</td>
                    <td className="tiny">
                      {i.model} · {i.serial}
                    </td>
                    <td className="mono tiny">{i.scale} / {i.offset}</td>
                    <td className="num">{i.nominalIntervalSeconds}s</td>
                    <td className="mono tiny">
                      {i.clockOffsetMs >= 0 ? '+' : ''}{i.clockOffsetMs} ms
                      <div className="tiny muted">±{i.clockOffsetUncertaintyMs} ms</div>
                    </td>
                    <td className="mono tiny">{shortTime(i.installedAt)}</td>
                    <td className="mono tiny">{i.removedAt === null ? '在用' : shortTime(i.removedAt)}</td>
                    <td className="num">{count.toLocaleString('zh-CN')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card-pad">
          <div className="small muted">
            当前点位当日读数共 {pointReadings.length.toLocaleString('zh-CN')} 条；时钟校正用于把采样时刻换算到平台对齐时间轴。
          </div>
        </div>
      </div>

      {activeInstrument && (
        <div className="grid cols-2">
          <div className="card">
            <div className="card-head">
              <h2>实例详情</h2>
              <span className="sub mono">{activeInstrument.instrumentId}</span>
            </div>
            <div className="card-pad">
              <dl className="kv">
                <dt>kind / metric</dt>
                <dd>{activeInstrument.kind} / {activeInstrument.metric}</dd>
                <dt>型号 / 序列号</dt>
                <dd>{activeInstrument.model} · {activeInstrument.serial}</dd>
                <dt>基础系数</dt>
                <dd className="mono">raw × {activeInstrument.scale} + {activeInstrument.offset}</dd>
                <dt>值不确定度</dt>
                <dd className="mono">{activeInstrument.valueUncertainty}（无校准时的相对半宽）</dd>
                <dt>标称间隔</dt>
                <dd>{activeInstrument.nominalIntervalSeconds} 秒；空档阈值 {activeInstrument.nominalIntervalSeconds * 2.5} 秒</dd>
                <dt>时钟校正</dt>
                <dd className="mono">
                  alignedAt = sampledAt + {activeInstrument.clockOffsetMs} ms（±{activeInstrument.clockOffsetUncertaintyMs} ms）
                </dd>
                <dt>安装 / 拆除</dt>
                <dd className="mono">{fmtDateTime(activeInstrument.installedAt)} / {activeInstrument.removedAt === null ? '在用' : fmtDateTime(activeInstrument.removedAt)}</dd>
                <dt>备注</dt>
                <dd className="small">{activeInstrument.note}</dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>绑定与校准边界</h2>
              <span className="sub">绑定有效期与校准生效共同决定片段切口</span>
            </div>
            <div className="card-pad stack">
              <div>
                <h3 className="small" style={{ marginBottom: 6 }}>绑定</h3>
                {activeBindings.length === 0 && <div className="small muted">无</div>}
                <ul className="list-reset stack" style={{ gap: 4 }}>
                  {activeBindings.map((b) => (
                    <li key={b.bindingId} className="small mono">
                      {b.bindingId} · {b.metric} · {fmtDateTime(b.from)} → {b.to === null ? '开放' : fmtDateTime(b.to)}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="hr" />
              <div>
                <h3 className="small" style={{ marginBottom: 6 }}>校准记录</h3>
                {activeCalibrations.length === 0 && <div className="small muted">无校准记录（使用默认系数，已计入不确定度）</div>}
                <ul className="list-reset stack" style={{ gap: 6 }}>
                  {activeCalibrations.map((c) => (
                    <li key={c.calibrationId} className="small">
                      <span className="mono">{c.calibrationId}</span> · 生效 {fmtDateTime(c.effectiveAt)}
                      <div className="tiny muted">
                        系数 raw × {c.scale} + {c.offset} · 不确定度 {c.coefficientUncertainty} · {c.operator} · 证书 {c.certificate}
                      </div>
                      <div className="tiny muted">{c.note}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeInstrument && (
        <div className="card">
          <div className="card-head">
            <h2>状态有效期（当日窗口内）</h2>
            <span className="sub">OK 以外的状态整段排除；缺少状态视为不可证明</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table>
              <thead>
                <tr>
                  <th>状态</th>
                  <th>起</th>
                  <th>止</th>
                  <th>原因</th>
                  <th>工单</th>
                  <th>当日裁剪</th>
                </tr>
              </thead>
              <tbody>
                {activeStates.map((s) => {
                  const clippedFrom = Math.max(s.from, windowFrom);
                  const clippedTo = Math.min(s.to ?? windowTo, windowTo);
                  const clipped = Math.max(0, clippedTo - clippedFrom) / 1000;
                  return (
                    <tr key={s.stateId}>
                      <td>
                        <span className={`badge ${s.state === 'OK' ? 'ok' : 'warn'}`}>{s.state}</span>
                      </td>
                      <td className="mono tiny">{fmtDateTime(s.from)}</td>
                      <td className="mono tiny">{s.to === null ? '开放' : fmtDateTime(s.to)}</td>
                      <td className="small">{s.reason}</td>
                      <td className="mono tiny">{s.workOrder}</td>
                      <td className="num">{clipped > 0 ? `${clipped.toFixed(0)}s` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeInstrument && regimes.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>校准体制切片</h2>
            <span className="sub">校准生效把当日切成多个系数体制；片段不得跨越</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>起</th>
                  <th>止</th>
                  <th>校准</th>
                  <th className="num">读数</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {regimes.map((r) => (
                  <tr key={`${r.calibrationId}-${r.from}`}>
                    <td className="mono tiny">{shortTime(r.from)}</td>
                    <td className="mono tiny">{shortTime(r.to)}</td>
                    <td className="mono tiny">{r.calibrationId ?? '默认系数'}</td>
                    <td className="num">{r.readingIds.length}</td>
                    <td className="mono tiny muted">{r.readingIds.length > 0 ? `${trimId(r.readingIds[0], 14, 6)} … ${trimId(r.readingIds[r.readingIds.length - 1], 14, 6)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            设备交接必须在 04:00 等实例边界处切开片段；同一编号下两个实例的读数不会互相插值。
          </div>
          <span className="badge neutral">当前点位实例 {pointInstruments.length}</span>
        </div>
      </div>
    </div>
  );
}
