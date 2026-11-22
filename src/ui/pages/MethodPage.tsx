import type { AppState } from '../useAppState';
import { fmtNum, pct } from '../format';

export function MethodPage({ state }: { state: AppState }) {
  const check = state.snapshot?.resampleCheck;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>计算口径</h2>
          <span className="sub">所有页面共用，UI 不另作解释</span>
        </div>
        <div className="card-pad grid cols-2">
          <div className="stack">
            <h3 className="small">时间轴与自然日</h3>
            <ul className="list-reset stack" style={{ gap: 5 }}>
              <li className="checkline"><span className="tick">·</span><span>alignedAt = sampledAt + 仪表时钟校正量；自然日按 alignedAt 在上海时区（UTC+8）划分。</span></li>
              <li className="checkline"><span className="tick">·</span><span>receivedAt 保留平台接收证据；迟到判定以 receivedAt 与申报截止时刻比较。</span></li>
              <li className="checkline"><span className="tick">·</span><span>浓度与流量各自按实例时钟校正到同一轴后配对，不直接混用设备时钟。</span></li>
            </ul>
            <h3 className="small" style={{ marginTop: 8 }}>片段编织</h3>
            <ul className="list-reset stack" style={{ gap: 5 }}>
              <li className="checkline"><span className="tick">·</span><span>边界来源：自然日端点、仪表实例/绑定交接、校准生效、状态切换、采样空档端点。</span></li>
              <li className="checkline"><span className="tick">·</span><span>片段内仪表、校准、状态唯一；点位编号复用按实例衔接，交接处必切段。</span></li>
              <li className="checkline"><span className="tick">·</span><span>校准中途生效必须切开，两侧分别引用各自系数，绝不跨系数插值。</span></li>
            </ul>
          </div>
          <div className="stack">
            <h3 className="small">可积分与排除</h3>
            <ul className="list-reset stack" style={{ gap: 5 }}>
              <li className="checkline"><span className="tick">·</span><span>仅 OK 状态可积分；冲洗、校准中、旁路、故障一律排除，且记录来源状态 ID 与影响估计。</span></li>
              <li className="checkline"><span className="tick">·</span><span>采样空档：同一实例相邻有效读数间隔超过 nominal×2.5；空档自“上一读数 + 一个标称间隔”起算。</span></li>
              <li className="checkline"><span className="tick">·</span><span>段端最多保持一个标称间隔，不无限外推；无状态记录的整段视为不可证明并排除。</span></li>
            </ul>
            <h3 className="small" style={{ marginTop: 8 }}>负荷与不确定度</h3>
            <ul className="list-reset stack" style={{ gap: 5 }}>
              <li className="checkline"><span className="tick">·</span><span>负荷 = ∫ c(t)·q(t) dt，单位 kg；c 为 mg/L，q 为 m³/h，秒折算 ÷3.6×10⁶。</span></li>
              <li className="checkline"><span className="tick">·</span><span>区间 = 逐片段相对不确定度平方和开方 × 膨胀系数 k，重采样路线再叠加梯形误差界 |c′q′|h³/6。</span></li>
              <li className="checkline"><span className="tick">·</span><span>缺口与排除不进入负荷；其影响按邻近有效读数（或设计流量与限值）单独量化区间。</span></li>
            </ul>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>路线 A：逐有效片段积分</h2>
            <span className="sub">默认，局部证据最全</span>
          </div>
          <div className="card-pad stack">
            <p className="small">
              在每个原子片段的有效域内，以浓度/流量读数为结点做分段线性插值，解析积分乘积 c(t)·q(t)。
              优点：短时冲击（如 40 秒）边界精确到读数时刻；每个片段都能直接回溯到读数、校准与状态。
              代价：片段与读数结点多，跨层查询需要逐段汇总，索引较重。
            </p>
            <div className="note small">
              适用：读数稀疏、状态切换频繁、需要保留局部证据的场景。当前计算
              {state.snapshot ? `：${state.snapshot.routingStats.segmentCount} 段 / ${state.snapshot.routingStats.readingKnots} 个结点` : '：待计算'}。
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>路线 B：经误差界验证的重采样积分</h2>
            <span className="sub">必须证明不改变结论</span>
          </div>
          <div className="card-pad stack">
            <p className="small">
              片段与边界保持不变，片段内部按固定网格重采样后梯形积分。汇总轻、便于跨层聚合，
              但必须用误差界与多网格收敛证明：峰值负荷范围、阈值穿越、缺口说明都没有被改变。
            </p>
            <div className="note small">
              核验通过条件：负荷相对偏差 ≤0.5%，1 小时峰值窗口中心偏移 ≤max(30 秒, 1 网格)，
              阈值穿越并集对称差 ≤2 秒，且网格细分后无未决单元。
              {check ? ` 当前：${check.verified ? '通过' : '未通过'}（${fmtNum(check.loadBestDriftPercent, 4)}% / ${fmtNum(check.peakWindowShiftSeconds, 0)} s / ${fmtNum(check.exceedanceSymmetricDiffSeconds, 1)} s）` : ''}
            </div>
            <div className="note warn small">
              朴素反例：以 60 秒中点取值、缺口沿用上一读数、不切校准与状态边界，
              {check ? `COD 负荷偏差 ${fmtNum(check.naiveCheck.loadErrorPercent, 2)}%、阈值穿越时长差 ${fmtNum(check.naiveCheck.missedExceedanceSeconds, 0)} 秒。` : '会造成可量化的偏差与穿越漏检。'}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>覆盖与申报</h2>
          <span className="sub">覆盖率、排除原因与资格判定</span>
        </div>
        <div className="card-pad grid cols-2">
          <div className="stack small">
            <div>覆盖率 = 有效积分秒数 ÷ 86,400；取各污染物最小值作为全窗口覆盖率。</div>
            <div>申报线默认 {pct(state.scope.coverageThreshold, 0)}：低于 15 个百分点以上判不可申报；低于申报线但在 15 个百分点内判有条件申报。</div>
            <div>冲洗 / 校准中 / 旁路 / 故障、采样空档、无仪表或无状态时段均不计入有效覆盖，也不计入负荷。</div>
            <div>浓度覆盖不足时，峰值与阈值穿越结论只覆盖有浓度证据的时段，并在附注中披露。</div>
          </div>
          <div className="stack small">
            <div>申报版本 FILED 后锁定来源窗口与来源快照，不可改写。</div>
            <div>迟到读数（采样时刻在锁定窗口内、接收时刻晚于截止）只能生成重算候选，候选保存差异说明并由人工复核。</div>
            <div>月度值只对有数据的自然日求和，缺失日不按零负荷处理，资格随覆盖与缺日降级。</div>
            <div>所有选择都记入本地审计，包含操作人与关联 ID。</div>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            计算引擎版本 {state.snapshot?.engineVersion ?? '1.1.0'}；作用域：包含 SUSPECT={String(state.scope.includeSuspect)}，
            膨胀系数 k={state.scope.uncertaintyMultiplier}，网格 {state.scope.gridSeconds}s。
          </div>
          <span className="badge neutral">WebWorker 内计算 · IndexedDB 本地存储 · 断网可用</span>
        </div>
      </div>
    </div>
  );
}


