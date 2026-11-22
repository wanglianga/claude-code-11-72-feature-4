import { useState } from 'react';
import type { CoagActions, CoagState } from './useCoagState';
import { fmtDateTime, fmtNum, hhmm, kgRange, num, pct } from './format';

interface Props {
  state: CoagState;
  actions: CoagActions;
}

export function CoagLedgerPage({ state, actions }: Props) {
  const eff = state.efficiency;
  const tank = state.dataset.tanks.find((t) => t.tankId === state.tankId);
  const [tab, setTab] = useState<'batches' | 'transfers' | 'pulses' | 'actions' | 'audits'>('batches');

  const storageId = tank?.storageId;
  const transfers = storageId ? state.dataset.transfers.filter((t) => t.storageId === storageId) : [];
  const pulses = state.dataset.pulses.filter((p) => p.tankId === state.tankId);

  return (
    <div className="stack">
      {eff && (
        <div className="grid cols-3">
          {eff.inventory.map((inv) => (
            <div key={inv.storageId} className="card stat" style={{ gridColumn: 'span 2' }}>
              <div className="stat-label">库存平衡 · {inv.storageId}</div>
              <div className="stat-value small">{kgRange(inv.closingKg, 2)} kg 推算期末</div>
              <div className="stat-foot">
                期初 {fmtNum(inv.openingKg, 1)} + 入库 {fmtNum(inv.receivedKg, 1)} + 转罐净额 {fmtNum(inv.transferNetKg, 1)} − 投加 {fmtNum(inv.dosedKg.best, 1)} kg
              </div>
              <div className="stat-foot">
                盘点 {num(inv.measuredClosingKg, 2)} kg · 差异 {num(inv.discrepancyKg, 2)} kg（
                {inv.measuredClosingKg ? pct(Math.abs((inv.discrepancyKg ?? 0) / Math.max(1, inv.measuredClosingKg)), 2) : '—'}）
              </div>
              <div className="stat-foot">{inv.notes[0]}</div>
            </div>
          ))}
          <div className="card stat">
            <div className="stat-label">迟到化验候选</div>
            <div className="stat-value">{eff.lateLabCandidates.length}</div>
            <div className="stat-foot">只新增候选，不改写当班处置</div>
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => void actions.importLate()} disabled={state.loading}>
              导入迟到化验
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="tabs">
          {([
            ['batches', '药剂批次账'],
            ['transfers', '储罐转移/稀释'],
            ['pulses', '泵脉冲履历'],
            ['actions', '当班处置（只读）'],
            ['audits', '审计'],
          ] as const).map(([k, label]) => (
            <button key={k} className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'batches' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>批次</th><th>产品</th><th className="num">标称浓度 g/L</th><th className="num">入库量 L</th><th>入库时刻</th><th>供应商</th><th>说明</th></tr>
              </thead>
              <tbody>
                {state.dataset.batches.map((b) => (
                  <tr key={b.batchId}>
                    <td className="mono tiny">{b.batchId}</td>
                    <td className="small">{b.productName}</td>
                    <td className="num">{fmtNum(b.nominalConcentration, 2)}</td>
                    <td className="num">{fmtNum(b.receivedVolumeL, 0)}</td>
                    <td className="mono tiny">{fmtDateTime(b.receivedAt)}</td>
                    <td className="small">{b.supplier}</td>
                    <td className="tiny">{b.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-pad small muted">入库量只进批次账与库存平衡，不是当日实际投加；实际投加以泵脉冲为准。</div>
          </div>
        )}

        {tab === 'transfers' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>动作</th><th>类型</th><th>时刻</th><th>批次</th><th className="num">体积 L</th><th className="num">动作后浓度 g/L</th><th>说明</th></tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.transferId}>
                    <td className="mono tiny">{t.transferId}</td>
                    <td className="small">{t.kind === 'DILUTION' ? '稀释' : t.kind === 'RECEIPT' ? '入库' : t.kind === 'TRANSFER_IN' ? '转罐入' : t.kind === 'TRANSFER_OUT' ? '转罐出' : t.kind}</td>
                    <td className="mono tiny">{hhmm(t.at)}</td>
                    <td className="mono tiny">{t.batchId ?? '—'}</td>
                    <td className="num">{fmtNum(t.volumeL, 0)}</td>
                    <td className="num">{fmtNum(t.resultingConcentration, 2)}</td>
                    <td className="tiny">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'pulses' && (
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table>
              <thead>
                <tr><th>脉冲段</th><th>区间</th><th className="num">设定 L/h</th><th className="num">脉冲数</th><th className="num">mL/脉冲</th><th className="num">平均流量</th><th>说明</th></tr>
              </thead>
              <tbody>
                {pulses.map((p) => (
                  <tr key={p.pulseId}>
                    <td className="mono tiny">{p.pulseId}</td>
                    <td className="mono tiny">{hhmm(p.from)}–{p.to ? hhmm(p.to) : '—'}</td>
                    <td className="num">{fmtNum(p.setpointLh, 0)}</td>
                    <td className="num">{fmtNum(p.pulseCount, 0)}</td>
                    <td className="num">{fmtNum(p.pulseVolumeMl, 1)}</td>
                    <td className="num">{fmtNum(p.averageFlowM3h, 0)}</td>
                    <td className="tiny">{p.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'actions' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>处置</th><th>班次</th><th>时刻</th><th>记录人</th><th>类别</th><th>内容</th><th>引用</th></tr>
              </thead>
              <tbody>
                {state.dataset.shiftActions.map((a) => (
                  <tr key={a.actionId}>
                    <td className="mono tiny">{a.actionId}</td>
                    <td className="small">{state.dataset.shifts.find((s) => s.shiftId === a.shiftId)?.code ?? a.shiftId}</td>
                    <td className="mono tiny">{hhmm(a.at)}</td>
                    <td className="small">{a.recordedBy}</td>
                    <td className="small">{a.category}</td>
                    <td className="small">{a.text}</td>
                    <td className="mono tiny">{a.refIds.join('，')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-pad small muted">当班处置记录只读；迟到化验只生成新的复盘候选，不会改写这里的内容。</div>
          </div>
        )}

        {tab === 'audits' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>时刻</th><th>操作人</th><th>动作</th><th>详情</th></tr></thead>
              <tbody>
                {state.audits.length === 0 && <tr><td colSpan={4} className="muted small">暂无审计记录。</td></tr>}
                {state.audits.map((a) => (
                  <tr key={a.auditId}>
                    <td className="mono tiny">{fmtDateTime(a.at)}</td>
                    <td className="small">{a.actor}</td>
                    <td className="small">{a.action}</td>
                    <td className="small">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
