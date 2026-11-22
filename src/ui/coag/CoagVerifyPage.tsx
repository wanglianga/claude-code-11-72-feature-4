import type { CoagState } from './useCoagState';
import { fmtNum, pct } from './format';

interface Props {
  state: CoagState;
}

export function CoagVerifyPage({ state }: Props) {
  const eff = state.efficiency;
  const mf = state.manifest;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>样例清单与指纹</h2>
          <span className="sub">装载时在浏览器内计算 SHA-256，与 coag-manifest.json 比对</span>
        </div>
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table>
            <thead><tr><th>文件</th><th>类型</th><th className="num">行数</th><th>指纹</th><th>结果</th></tr></thead>
            <tbody>
              {state.fingerprints.length === 0 && (
                <tr><td colSpan={5} className="muted small">指纹在“装载混凝样例”时计算；从本地库恢复时请在清单里核对已有指纹。</td></tr>
              )}
              {state.fingerprints.map((f) => {
                const meta = mf?.baseFiles.find((b) => b.fileName === f.fileName) ?? (mf?.lateFile?.fileName === f.fileName ? mf.lateFile : null);
                return (
                  <tr key={f.fileName}>
                    <td className="mono tiny">{f.fileName}</td>
                    <td className="tiny">{meta?.kind ?? '—'}</td>
                    <td className="num">{meta?.rowCount ?? '—'}</td>
                    <td className="mono tiny">{f.actual.slice(0, 16)}…</td>
                    <td><span className={`badge ${f.ok ? 'ok' : 'bad'}`}>{f.ok ? '匹配' : '不一致'}</span></td>
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
            <h2>样例场景</h2>
            <span className="sub">{mf?.name ?? ''}</span>
          </div>
          <div className="card-pad">
            {mf ? (
              <ul className="list-reset stack" style={{ gap: 7 }}>
                {mf.focus.scenario.map((s, i) => (
                  <li key={i} className="small" style={{ display: 'flex', gap: 8 }}>
                    <span className="badge neutral" style={{ flexShrink: 0 }}>{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted small">未读取清单。</div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>计算口径与解析结果</h2>
          </div>
          <div className="card-pad stack">
            <dl className="kv">
              <dt>池数 / 点位</dt>
              <dd className="mono">{state.dataset.tanks.length} / {state.dataset.points.length}</dd>
              <dt>读数 / 泵脉冲</dt>
              <dd className="mono">{state.dataset.readings.length.toLocaleString('zh-CN')} / {state.dataset.pulses.length}</dd>
              <dt>迟到化验</dt>
              <dd className="mono">{state.dataset.lateLabs.length}</dd>
              <dt>解析问题</dt>
              <dd className="mono">{state.issues.length}</dd>
              {eff && (
                <>
                  <dt>配对 / 可排名</dt>
                  <dd className="mono">{eff.pairings.length} / {eff.pairings.filter((p) => p.rankable).length}</dd>
                  <dt>计算耗时</dt>
                  <dd className="mono">{fmtNum(eff.computeMs, 0)} ms（引擎 {eff.engineVersion}）</dd>
                  <dt>COD 按班次 / 按工况</dt>
                  <dd className="mono">{pct(eff.byShift.COD.removal?.best)} / {pct(eff.byCondition.COD.removal?.best)}</dd>
                </>
              )}
            </dl>
            {state.issues.length > 0 && (
              <div className="note bad small">
                {state.issues.slice(0, 5).map((i) => `${i.file}:${i.row} ${i.message}`).join('\n')}
              </div>
            )}
            <div className="note small">
              命令行核验：<span className="mono">npm run verify:coag</span> 读取同一组 CSV，断言窗口推导、混合比例、库存平衡、异常归因、工况对照与迟到复盘。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
