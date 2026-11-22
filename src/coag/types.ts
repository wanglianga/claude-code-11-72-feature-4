/**
 * 混凝剂投加效率复核：领域模型（与排口负荷模块共用时间轴口径）
 *
 * 统一语义（界面、引擎、核验脚本共用，不得各自解释）：
 * - 时间轴：所有时刻均为毫秒纪元值，按 Asia/Shanghai（固定 UTC+8）展示；
 *   班次同样按本地时刻划分。读数/脉冲/化验的「记录时刻」与「生效时刻」分开保存。
 * - 配对窗口：一次投加发生在混凝池进口（泵脉冲/剂量设定生效时刻），其可达的出水窗口
 *   不由父任务给定，而是按当天实际流量、有效池容、回流比例与旁路状态推导：
 *     停留时间 t = 有效池容 V(m³) / [进水流量 Q(m³/h) × (1 + 回流比) / 3600]（秒）
 *   窗口下沿取「最短允许停留时间」，上沿取「最长允许停留时间」；进水/出水点位由
 *   本条的映射登记给出（不使用父任务推断的对应关系）。
 * - 库存转移：储罐补货、转罐、稀释/混合都不是「实际投加」。当日实际投加量只由
 *   泵脉冲（经校准与生效区间修正）× 有效浓度（按混合比例）推导，并用储罐物料平衡
 *   交叉核对；采购/入库量只进批次账，不得当作投加量。
 * - 旁路/泵校准失效：旁路开启期间出水不经过混凝（可达窗口断开），泵校准失效或
 *   中途中止时投加量只有范围；两种情况下配对计算器只给区间，并标记不可与正常段排名。
 * - 迟到化验：接收时刻晚于复盘截止的化验结果只生成新的复盘候选；已被当班处置
 *   引用的记录保持不变。
 */

export const COAG_TARGETS = ['COD', 'NH3N'] as const;
export type CoagTarget = (typeof COAG_TARGETS)[number];

export const COAG_TARGET_LABELS: Record<CoagTarget, string> = {
  COD: 'COD 去除',
  NH3N: '氨氮去除',
};

export interface CoagPlant {
  plantId: string;
  name: string;
  shortName: string;
}

/** 混凝池：有效池容、允许停留时间范围、回流比例、对应进出水点位 */
export interface CoagTank {
  tankId: string;
  plantId: string;
  name: string;
  /** 有效池容（m³） */
  effectiveVolumeM3: number;
  /** 最短允许停留时间（秒）：窗口下沿 */
  minResidenceSeconds: number;
  /** 最长允许停留时间（秒）：窗口上沿 */
  maxResidenceSeconds: number;
  /** 回流比（回流流量 / 进水流量），0 表示无回流 */
  recycleRatio: number;
  /** 进口点位（含该池投加/进水在线读数） */
  inletPointCode: string;
  /** 出口点位（混凝后、沉淀/过滤后取样的出水在线读数） */
  outletPointCode: string;
  /** 池容/停留时间不确定度（0..1，用于窗口宽度解释） */
  volumeUncertainty: number;
  /** 本池由哪个储罐供药（用于扣除库存转移、按混合比例取浓度） */
  storageId: string;
  note: string;
}

export type DosingMetric = 'TURBIDITY' | 'PH' | 'TEMP' | 'FLOW' | 'COD' | 'NH3N';

export const DOSING_METRIC_LABELS: Record<DosingMetric, string> = {
  TURBIDITY: '浊度',
  PH: 'pH',
  TEMP: '水温',
  FLOW: '流量',
  COD: 'COD',
  NH3N: '氨氮',
};

export interface CoagPoint {
  pointCode: string;
  tankId: string;
  plantId: string;
  role: 'INLET' | 'OUTLET';
  name: string;
  metrics: DosingMetric[];
  /** 传感器时间偏移：alignedAt = sampledAt + clockOffsetMs */
  clockOffsetMs: number;
  clockOffsetUncertaintyMs: number;
  nominalIntervalSeconds: number;
  valueUncertainty: number;
  note: string;
}

/** 在线读数（一条记录一个指标） */
export interface CoagReading {
  readingId: string;
  pointCode: string;
  plantId: string;
  tankId: string;
  role: 'INLET' | 'OUTLET';
  metric: DosingMetric;
  sampledAt: number;
  alignedAt: number;
  receivedAt: number;
  dayKey: string;
  rawValue: number;
  qualityFlag: 'VALID' | 'SUSPECT' | 'INVALID';
  sourceFileId: string | null;
  sourceRow: number | null;
}

export type BypassDirection = 'OUTLET' | 'INLET' | 'BOTH';

/** 旁路状态区间（出口或进口被旁路时，混凝停留不再成立） */
export interface BypassPeriod {
  bypassId: string;
  tankId: string;
  from: number;
  to: number | null;
  direction: BypassDirection;
  /** 旁路比例 0..1（部分旁路时出口仍有部分水量经过混凝） */
  fraction: number;
  reason: string;
  workOrder: string;
  recordedBy: string;
}

/** 搅拌状态区间；搅拌停止会改变混合条件（工况分段与异常判定都用它） */
export interface MixingPeriod {
  mixingId: string;
  tankId: string;
  from: number;
  to: number | null;
  state: 'ON' | 'OFF' | 'REDUCED';
  reason: string;
  workOrder: string;
}

/** 工况突变事件（暴雨、低温、浊度突升、进水冲击等） */
export interface UpsetEvent {
  upsetId: string;
  tankId: string;
  from: number;
  to: number;
  kind: 'STORM' | 'LOW_TEMP' | 'TURBIDITY_SURGE' | 'INFLOW_SHOCK' | 'OTHER';
  severity: 'INFO' | 'MINOR' | 'MAJOR';
  note: string;
}

/** 药剂批次账（浓度、入库、稀释/混合） */
export interface ChemicalBatch {
  batchId: string;
  plantId: string;
  productName: string;
  /** 标称产品浓度（g/L 或 %，此处统一为 g/L 有效成分） */
  nominalConcentration: number;
  /** 浓度相对不确定度 */
  concentrationUncertainty: number;
  /** 生产/到货时刻 */
  manufacturedAt: number;
  /** 入库时刻（入库量只记入库，不是投加） */
  receivedAt: number;
  /** 入库量（L） */
  receivedVolumeL: number;
  supplier: string;
  certificate: string;
  note: string;
}

/** 储罐与转罐/混合记录：储罐未用尽时改变浓度，必须按混合比例追踪 */
export interface StorageTank {
  storageId: string;
  plantId: string;
  name: string;
  capacityL: number;
  note: string;
}

export type StorageTransferKind = 'RECEIPT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'DILUTION' | 'MIX';

export interface StorageTransfer {
  transferId: string;
  plantId: string;
  storageId: string;
  kind: StorageTransferKind;
  at: number;
  batchId: string | null;
  /** 本动作涉及体积（L）；MIX 时为混合后总体积 */
  volumeL: number;
  /** 混合后有效浓度（g/L），RECEIPT/TRANSFER 取批次浓度 */
  resultingConcentration: number;
  note: string;
  recordedBy: string;
}

/** 泵脉冲/设定值履历：泵脉冲是实际投加的证据，校准决定脉冲→体积换算 */
export interface DosingPulse {
  pulseId: string;
  tankId: string;
  pumpId: string;
  /** 生效区间 [from, to)；to=null 表示到窗口末尾 */
  from: number;
  to: number | null;
  /** 设定投加率（L/h） */
  setpointLh: number;
  /** 每个脉冲的理论体积（mL/pulse） */
  pulseVolumeMl: number;
  /** 本区间累计脉冲数（来自流量计/泵驱动器） */
  pulseCount: number;
  /** 区间内平均进水流量（m³/h），用于显示 */
  averageFlowM3h: number;
  note: string;
}

/** 泵校准：决定脉冲体积；可在班中生效或失效（失效时投加量只能给范围） */
export interface PumpCalibration {
  pumpCalibrationId: string;
  tankId: string;
  pumpId: string;
  effectiveAt: number;
  /** 失效时刻；null 表示仍有效 */
  invalidatedAt: number | null;
  /** 新脉冲体积（mL/pulse） */
  pulseVolumeMl: number;
  /** 校准不确定度（相对） */
  uncertainty: number;
  operator: string;
  certificate: string;
  note: string;
}

export type LabSampleKind = 'INFLUENT' | 'EFFLUENT' | 'CHEMICAL';

export interface LabSample {
  labId: string;
  tankId: string;
  pointCode: string;
  kind: LabSampleKind;
  /** 取样时刻 */
  sampledAt: number;
  /** 实验室结果接收时刻：晚于复盘截止的属于迟到结果 */
  receivedAt: number;
  codMgL: number | null;
  nh3nMgL: number | null;
  turbidityNtu: number | null;
  /** 仅 CHEMICAL 样品：实测有效浓度（g/L），用于核对储罐混合比例 */
  chemicalConcentrationGPerL: number | null;
  /** 实验室值相对不确定度 */
  uncertainty: number;
  labName: string;
  note: string;
}

/** 储罐盘点：与“期初 + 入库 + 转罐 − 投加”的推算期末核对 */
export interface StorageStocktake {
  stocktakeId: string;
  storageId: string;
  at: number;
  volumeL: number;
  concentrationGPerL: number;
  measuredBy: string;
}

/** 班次定义：按本地时刻切割 [startMinute, endMinute) */
export interface ShiftDefinition {
  shiftId: string;
  plantId: string;
  code: string;
  name: string;
  /** 本地时刻（分钟，0..1440），如 00:00 → 0，08:00 → 480 */
  startMinute: number;
  endMinute: number;
}

/** 复盘处置记录：当班采取的处置，必须保持不可改写 */
export interface ShiftAction {
  actionId: string;
  shiftId: string;
  plantId: string;
  /** 处置记录时刻 */
  at: number;
  recordedBy: string;
  category: 'FEED_SHORTAGE' | 'METERING_UNCERTAIN' | 'CONDITION_SHIFT' | 'SAMPLING_PENDING' | 'OTHER';
  text: string;
  /** 引用的异常/候选 ID */
  refIds: string[];
}

export interface CoagDataset {
  plants: CoagPlant[];
  tanks: CoagTank[];
  points: CoagPoint[];
  readings: CoagReading[];
  bypasses: BypassPeriod[];
  mixing: MixingPeriod[];
  upsets: UpsetEvent[];
  batches: ChemicalBatch[];
  storageTanks: StorageTank[];
  transfers: StorageTransfer[];
  stocktakes: StorageStocktake[];
  pulses: DosingPulse[];
  pumpCalibrations: PumpCalibration[];
  labs: LabSample[];
  shifts: ShiftDefinition[];
  shiftActions: ShiftAction[];
  /** 迟到化验批次（单独导入，不并入基础资料） */
  lateLabs: LabSample[];
}

export interface CoagFileMeta {
  fileName: string;
  kind: string;
  rowCount: number;
  sha256: string;
  receivedAt: number;
  note: string;
}

export interface CoagManifest {
  name: string;
  description: string;
  generatedAt: string;
  timezone: string;
  day: string;
  baseFiles: CoagFileMeta[];
  lateFile: CoagFileMeta | null;
  focus: {
    plantId: string;
    tankId: string;
    day: string;
    /** 复盘截止接收时刻：此后到达的化验属迟到 */
    reviewCutoffReceivedAt: number;
    scenario: string[];
  };
}

// ---------------------------------- 计算结果 ---------------------------------

export type EffectiveState = 'NORMAL' | 'PARTIAL_BYPASS' | 'BYPASSED' | 'MIXING_OFF';

export interface ResidenceWindow {
  /** 投加/进口时刻 */
  from: number;
  /** 窗口下沿（最短允许停留时间） */
  toMin: number;
  /** 窗口上沿（最长允许停留时间） */
  toMax: number;
  /** 窗口内流量是否随流量变化重算（逐读数重算） */
  flowFromM3h: number;
  flowToM3h: number;
  /** 有效池容（m³） */
  volumeM3: number;
  recycleRatio: number;
  /** 停留时间下沿/上沿（秒） */
  residenceMinSeconds: number;
  residenceMaxSeconds: number;
  /** 由流量、池容推导的最短/最长可能停留时间（秒），超出允许范围时给出提示 */
  derivedMinSeconds: number;
  derivedMaxSeconds: number;
  /** 旁路占比 0..1（BYPASSED → 1） */
  bypassFraction: number;
  state: EffectiveState;
  /** 允许停留时间：窗口可与出水取交集 */
  usable: boolean;
  note: string;
}

export interface DosageRecord {
  /** 对应泵脉冲记录的标识 */
  pulseId: string;
  tankId: string;
  pumpId: string;
  from: number;
  to: number;
  /** 本段投加体积（L）：范围 */
  volumeL: LoadBounds;
  /** 有效浓度（g/L）：范围（按混合比例） */
  concentrationGPerL: LoadBounds;
  /** 有效成分投加量（kg） */
  massKg: LoadBounds;
  /** 设定投加率（L/h） */
  setpointLh: number;
  /** 按有效浓度折算的投加率（kg 有效成分/h） */
  massRateKgH: number;
  /** 脉冲计数是否经过校准；false 时 massKg 只用范围且不可排名 */
  pulseCalibrated: boolean;
  /** 校准是否中途失效 */
  calibrationInvalid: boolean;
  /** 泵/校准备注 */
  notes: string[];
  batchId: string | null;
  /** 本段引用的转移/混合记录 */
  transferIds: string[];
}

export interface PairedSeries {
  target: CoagTarget;
  /** 出水窗口内的进水有效均值（mg/L） */
  inletMgL: number | null;
  /** 出水窗口内的出水有效均值（mg/L） */
  outletMgL: number | null;
  inletEffectiveSeconds: number;
  outletEffectiveSeconds: number;
  /** 去除率范围（0..1），扣除了出水点位与进水点位的取样差异 */
  removal: LoadBounds | null;
  /** 单位药剂去除量（kg COD / kg 有效成分） */
  yieldKgPerKg: LoadBounds | null;
  notes: string[];
}

export interface PairingRecord {
  pairingId: string;
  tankId: string;
  day: string;
  pumpId: string;
  /** 投加/进口时刻 */
  dosingFrom: number;
  dosingTo: number;
  window: ResidenceWindow;
  dosage: DosageRecord;
  /** 出水窗口内实际可用的出水读数覆盖比例 */
  outletCoverage: number;
  inletCoverage: number;
  /** 本段是否可与正常段排名 */
  rankable: boolean;
  rankBlockReasons: string[];
  series: PairedSeries[];
  /** 关联异常 ID */
  anomalyIds: string[];
}

export type AnomalyCategory = 'FEED_SHORTAGE' | 'METERING_UNCERTAIN' | 'CONDITION_SHIFT' | 'SAMPLING_PENDING';
export const ANOMALY_LABELS: Record<AnomalyCategory, string> = {
  FEED_SHORTAGE: '缺料',
  METERING_UNCERTAIN: '计量不确定',
  CONDITION_SHIFT: '工况突变',
  SAMPLING_PENDING: '待取样',
};

export interface Anomaly {
  anomalyId: string;
  tankId: string;
  category: AnomalyCategory;
  from: number;
  to: number;
  /** 影响配对数 */
  affectedPairings: number;
  severity: 'INFO' | 'MINOR' | 'MAJOR';
  detail: string;
  /** 是否仅由迟到化验触发 */
  fromLateLab: boolean;
  refIds: string[];
}

export interface ConditionSegment {
  segmentId: string;
  tankId: string;
  from: number;
  to: number;
  seconds: number;
  /** 平均/范围流量、pH、温度、浊度 */
  meanFlowM3h: number | null;
  meanPh: number | null;
  meanTempC: number | null;
  meanTurbidityNtu: number | null;
  meanInletCod: number | null;
  meanRecycleRatio: number;
  mixing: 'ON' | 'OFF' | 'REDUCED' | 'MIXED';
  bypassFraction: number;
  /** 本段是否稳定（可用于效率结论） */
  stable: boolean;
  /** 短片段（<90 分钟）只作参考，不给单一结论 */
  shortSegment: boolean;
  pairingIds: string[];
  /** 本段对应班次（若整段落在同一班次） */
  shiftId: string | null;
  reason: string;
}

export interface AggregateEfficiency {
  target: CoagTarget;
  /** 加权去除率（按投加量加权），范围 */
  removal: LoadBounds | null;
  /** 单位药剂去除量 */
  yieldKgPerKg: LoadBounds | null;
  /** 扣除的药剂（kg 有效成分） */
  dosingKg: LoadBounds;
  /** 参与聚合的配对数 / 被拒绝数 */
  included: number;
  excluded: number;
  /** 本聚合范围内的未覆盖时段（秒） */
  uncoveredSeconds: number;
  /** 无法给出单一效率结论时的原因 */
  notes: string[];
  /** 是否可与其他聚合范围排名 */
  rankable: boolean;
}

export interface ShiftSummary {
  shiftId: string;
  code: string;
  name: string;
  from: number;
  to: number;
  /** 本班次购药入库（kg），仅作参照，不是投加量 */
  purchasedKg: LoadBounds;
  /** 本班次实际投加（kg 有效成分），由脉冲推导 */
  dosedKg: LoadBounds;
  /** 库存转移（kg），单独列出 */
  transferredKg: LoadBounds;
  /** 对照：把采购入库量当作实际投加得到的“单位药耗去除”（仅作反例，不是效率结论） */
  naiveYieldByPurchase: Record<CoagTarget, LoadBounds | null>;
  efficiency: Record<CoagTarget, AggregateEfficiency>;
  pairings: number;
  anomalies: number;
  /** 存在混合工况原因时不可给单一效率 */
  hasMixedConditions: boolean;
  notes: string[];
}

export interface ConditionSummary {
  segmentId: string;
  tankId: string;
  from: number;
  to: number;
  label: string;
  efficiency: Record<CoagTarget, AggregateEfficiency>;
  shiftIds: string[];
  stable: boolean;
  shortSegment: boolean;
  notes: string[];
}

export interface InventoryBalance {
  plantId: string;
  storageId: string;
  /** 期初物料 */
  openingKg: number;
  /** 入库（RECEIPT） */
  receivedKg: number;
  /** 转罐净额（TRANSFER_IN − TRANSFER_OUT，同一厂内应为 0） */
  transferNetKg: number;
  /** 混合/稀释造成的物料变化（体积×浓度差） */
  mixDeltaKg: number;
  /** 由脉冲推导的实际投加 */
  dosedKg: LoadBounds;
  /** 期末推算物料 */
  closingKg: LoadBounds;
  /** 实测期末（盘点） */
  measuredClosingKg: number | null;
  /** 库存差异（实测 − 推算） */
  discrepancyKg: number | null;
  notes: string[];
}

export interface LateLabCandidate {
  candidateId: string;
  tankId: string;
  day: string;
  createdAt: number;
  labId: string;
  sampledAt: number;
  receivedAt: number;
  /** 迟到结果覆盖的投加/窗口 */
  affectedPairingIds: string[];
  /** 复盘候选：只新增候选，不改写当班处置 */
  shiftId: string | null;
  priorShifts: string[];
  /** 被迟到化验影响的异常类别 */
  categories: AnomalyCategory[];
  note: string;
  status: 'PENDING' | 'REVIEWED';
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  /** 当班处置是否被改写（必须为 false） */
  shiftActionsOverwritten: false;
}

export interface TankEfficiency {
  tankId: string;
  day: string;
  pairings: PairingRecord[];
  anomalies: Anomaly[];
  conditions: ConditionSegment[];
  shifts: ShiftSummary[];
  conditionSummaries: ConditionSummary[];
  inventory: InventoryBalance[];
  lateLabCandidates: LateLabCandidate[];
  /** 全窗口（自然日）汇总，按班次和按工况两种路径 */
  byShift: Record<CoagTarget, AggregateEfficiency>;
  byCondition: Record<CoagTarget, AggregateEfficiency>;
  coverage: {
    /** 全部配对的出水覆盖率（平均） */
    meanOutletCoverage: number;
    /** 未覆盖秒数（出水窗口内没有任何可用出水读数） */
    uncoveredSeconds: number;
    /** 被限制在区间、无法排名的配对数 */
    blockedPairings: number;
  };
  computeMs: number;
  engineVersion: string;
}

export const COAG_ENGINE_VERSION = '1.0.0';

export interface LoadBounds {
  min: number;
  best: number;
  max: number;
}
