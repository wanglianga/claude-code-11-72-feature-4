/**
 * 应用状态：数据集、选中点位/日期、作用域、计算结果、申报与重算候选。
 * 所有重计算经 Worker；IndexedDB 为主存储，刷新后自动恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Dataset,
  DayLoadSnapshot,
  Declaration,
  IntegrationMethod,
  RecalcCandidate,
  SampleManifest,
  ScopeOptions,
} from '../domain/types';
import { DEFAULT_SCOPE } from '../domain/types';
import type { ComparisonResult } from '../domain/engine';
import {
  clearAll,
  fileDeclaration,
  getAllKv,
  getMeta,
  intakeFiles,
  isSampleImported,
  listAudits,
  listDeclarations,
  listRecalcCandidates,
  readingsByFile,
  saveRecalcCandidate,
  setMeta,
  addAudit,
} from '../db/db';
import type { AuditEntry } from '../db/db';
import { createWorkerClient, type WorkerClient } from '../worker/client';
import { buildRecalcCandidate, detectLateReadings } from '../domain/service';
import { fetchSampleManifest, importLateBatch, loadSampleBase, type LoadProgress } from '../sample/loadSample';
import { dayKeyFromMs } from '../domain/time';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface AppState {
  ready: boolean;
  loading: boolean;
  progress: LoadProgress | null;
  dataset: Dataset;
  manifest: SampleManifest | null;
  pointCode: string;
  day: string;
  month: string;
  method: IntegrationMethod;
  scope: ScopeOptions;
  actor: string;
  snapshot: DayLoadSnapshot | null;
  comparison: ComparisonResult | null;
  computing: boolean;
  computeError: string | null;
  declarations: Declaration[];
  candidates: RecalcCandidate[];
  audits: AuditEntry[];
  files: Awaited<ReturnType<typeof intakeFiles>>;
  lateCount: number;
  fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[];
  toasts: Toast[];
  lastComputeMs: number | null;
}

export interface AppActions {
  reload: () => Promise<void>;
  loadSample: () => Promise<void>;
  importLate: () => Promise<void>;
  setPointCode: (code: string) => void;
  setDay: (day: string) => void;
  setMethod: (m: IntegrationMethod) => void;
  setScope: (patch: Partial<ScopeOptions>) => void;
  setActor: (name: string) => void;
  recompute: (opts?: { compare?: boolean }) => Promise<void>;
  fileCurrent: () => Promise<void>;
  reviewCandidate: (candidateId: string, note: string) => Promise<void>;
  createCandidate: (declarationId: string) => Promise<void>;
  reset: () => Promise<void>;
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: string) => void;
  lookupFileReadings: (fileId: string) => Promise<number>;
  refreshLedgers: () => Promise<void>;
}

function emptyDataset(): Dataset {
  return {
    plants: [],
    points: [],
    instruments: [],
    calibrations: [],
    states: [],
    bindings: [],
    readings: [],
    files: [],
  };
}

const DEFAULT_POINT_STORAGE = 'ui:pointCode';
const DEFAULT_DAY_STORAGE = 'ui:day';
const ACTOR_STORAGE = 'ui:actor';

export function useAppState(): { state: AppState; actions: AppActions } {
  const workerRef = useRef<WorkerClient | null>(null);
  const [dataset, setDataset] = useState<Dataset>(emptyDataset);
  const [manifest, setManifest] = useState<SampleManifest | null>(null);
  const [pointCode, setPointCode] = useState('CC-E01');
  const [day, setDay] = useState('2026-11-18');
  const [method, setMethod] = useState<IntegrationMethod>('SEGMENT');
  const [scope, setScopeState] = useState<ScopeOptions>({ ...DEFAULT_SCOPE });
  const [actor, setActorState] = useState('复核员');
  const [snapshot, setSnapshot] = useState<DayLoadSnapshot | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [declarations, setDeclarations] = useState<Declaration[]>([]);
  const [candidates, setCandidates] = useState<RecalcCandidate[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [files, setFiles] = useState<Awaited<ReturnType<typeof intakeFiles>>>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fingerprints, setFingerprints] = useState<AppState['fingerprints']>([]);
  const [lastComputeMs, setLastComputeMs] = useState<number | null>(null);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5200);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const refreshLedgers = useCallback(async () => {
    const [decls, recs, auditList, intake, mf] = await Promise.all([
      listDeclarations(),
      listRecalcCandidates(),
      listAudits(),
      intakeFiles(),
      fetchSampleManifest().catch(() => null),
    ]);
    setDeclarations(decls);
    setCandidates(recs);
    setAudits(auditList);
    setFiles(intake);
    if (mf) setManifest(mf);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAllKv();
      const ds: Dataset = {
        plants: data.plants,
        points: data.points,
        instruments: data.instruments,
        calibrations: data.calibrations,
        states: data.states,
        bindings: data.bindings,
        readings: data.readings,
        files: data.files,
      };
      setDataset(ds);
      const storedPoint = await getMeta<string>(DEFAULT_POINT_STORAGE);
      const storedDay = await getMeta<string>(DEFAULT_DAY_STORAGE);
      const storedActor = await getMeta<string>(ACTOR_STORAGE);
      if (storedActor) setActorState(storedActor);
      if (mfHasPoints(ds)) {
        const point = storedPoint && ds.points.some((p) => p.pointCode === storedPoint) ? storedPoint : ds.points[0].pointCode;
        setPointCode(point);
        const days = pickDays(ds, point);
        const chosenDay = storedDay && days.includes(storedDay) ? storedDay : days[0] ?? day;
        setDay(chosenDay);
      }
      await refreshLedgers();
      const imported = await isSampleImported();
      setReady(true);
      if (imported) toast('info', `已从本地库恢复 ${ds.readings.length.toLocaleString('zh-CN')} 条读数`);
    } catch (error) {
      toast('error', `恢复本地库失败：${(error as Error).message}`);
      setReady(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLedgers, toast]);

  const loadSample = useCallback(async () => {
    setLoading(true);
    setProgress({ step: '准备装载', done: 0, total: 1 });
    try {
      const loaded = await loadSampleBase((p) => setProgress(p), actor);
      setDataset(loaded.dataset);
      setManifest(loaded.manifest);
      setFingerprints(loaded.fingerprintMatches);
      const focusPoint = loaded.manifest.focus.pointCode;
      setPointCode(focusPoint);
      setDay(loaded.manifest.focus.day);
      await setMeta(DEFAULT_POINT_STORAGE, focusPoint);
      await setMeta(DEFAULT_DAY_STORAGE, loaded.manifest.focus.day);
      await refreshLedgers();
      await addAudit({
        at: Date.now(),
        actor,
        action: 'LOAD_SAMPLE',
        detail: `装载样例：${loaded.dataset.files.length} 份文件，${loaded.dataset.readings.length} 条读数；指纹校验 ${loaded.fingerprintMatches.filter((f) => f.ok).length}/${loaded.fingerprintMatches.length} 通过`,
        refIds: loaded.dataset.files.map((f) => f.fileId),
      });
      if (loaded.warnings.length > 0) toast('warn', loaded.warnings.join('；'));
      else toast('success', `样例装载完成：${loaded.fingerprintMatches.length} 份文件指纹全部匹配`);
      setReady(true);
    } catch (error) {
      toast('error', `装载样例失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [actor, refreshLedgers, toast]);

  const importLate = useCallback(async () => {
    if (!manifest) {
      toast('warn', '尚未装载样例清单');
      return;
    }
    setLoading(true);
    try {
      const result = await importLateBatch(dataset, manifest, actor);
      setDataset(result.dataset);
      if (!result.fingerprint.ok) toast('warn', '迟到补录文件指纹与清单不一致');
      else toast('success', `迟到补录已入库：${result.readingsAdded} 条读数（接收时刻晚于申报截止）`);
      await addAudit({
        at: Date.now(),
        actor,
        action: 'IMPORT_LATE_BATCH',
        detail: `导入迟到补录 ${result.filesAdded.join('，')}：${result.readingsAdded} 条读数`,
        refIds: result.filesAdded,
      });
      await refreshLedgers();
    } catch (error) {
      toast('error', `导入迟到补录失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [actor, dataset, manifest, refreshLedgers, toast]);

  const setPointCodePersist = useCallback((code: string) => {
    setPointCode(code);
    void setMeta(DEFAULT_POINT_STORAGE, code);
    setSnapshot(null);
    setComparison(null);
  }, []);
  const setDayPersist = useCallback((next: string) => {
    setDay(next);
    void setMeta(DEFAULT_DAY_STORAGE, next);
    setSnapshot(null);
    setComparison(null);
  }, []);
  const setActorPersist = useCallback((name: string) => {
    setActorState(name);
    void setMeta(ACTOR_STORAGE, name);
  }, []);
  const setScope = useCallback((patch: Partial<ScopeOptions>) => {
    setScopeState((prev) => ({ ...prev, ...patch }));
  }, []);

  const recompute = useCallback(
    async (opts: { compare?: boolean } = {}) => {
      if (!dataset.points.length) {
        toast('warn', '本地库为空，请先装载样例资料或导入文件');
        return;
      }
      setComputing(true);
      setComputeError(null);
      try {
        if (!workerRef.current) workerRef.current = createWorkerClient();
        const client = workerRef.current;
        if (opts.compare) {
          const comp = await client.request<ComparisonResult>({
            type: 'compareRoutes',
            dataset,
            pointCode,
            day,
            scope,
          });
          setComparison(comp);
          setSnapshot(comp.segment);
          setLastComputeMs(comp.segment.computeMs);
        } else {
          const snap = await client.request<DayLoadSnapshot>({
            type: 'computeDay',
            dataset,
            pointCode,
            day,
            method,
            scope,
            withChart: true,
          });
          setSnapshot(snap);
          setComparison(null);
          setLastComputeMs(snap.computeMs);
        }
      } catch (error) {
        const message = (error as Error).message;
        setComputeError(message);
        toast('error', `计算失败：${message}`);
      } finally {
        setComputing(false);
      }
    },
    [dataset, day, method, pointCode, scope, toast],
  );

  const fileCurrent = useCallback(async () => {
    if (!dataset.points.length) return;
    if (!workerRef.current) workerRef.current = createWorkerClient();
    try {
      const declaration = await workerRef.current.request<Declaration>({
        type: 'buildDeclaration',
        dataset,
        pointCode,
        day,
        method,
        createdBy: actor,
        scope,
      });
      const { existing } = await fileDeclaration(declaration);
      if (existing) {
        toast('warn', `该点位当日已有申报版本 ${existing.declarationId}，未覆盖；如需修订请生成重算候选`);
      } else {
        toast('success', `已出具申报版本 ${declaration.declarationId}，来源窗口已锁定`);
        await addAudit({
          at: Date.now(),
          actor,
          action: 'FILE_DECLARATION',
          detail: `出具 ${pointCode} ${day} 申报版本，方法 ${method}，来源 ${declaration.sourceReadingIds.length} 条`,
          refIds: [declaration.declarationId],
        });
      }
      await refreshLedgers();
    } catch (error) {
      toast('error', `出具申报失败：${(error as Error).message}`);
    }
  }, [actor, dataset, day, method, pointCode, refreshLedgers, scope, toast]);

  const createCandidate = useCallback(
    async (declarationId: string) => {
      const declaration = declarations.find((d) => d.declarationId === declarationId);
      if (!declaration) {
        toast('warn', '未找到该申报版本');
        return;
      }
      const late = detectLateReadings(dataset, declaration);
      if (late.lateReadings.length === 0) {
        toast('info', '未发现申报截止后到达的迟到读数；仍可生成对照候选（差异应为 0）');
      }
      try {
        const candidate = buildRecalcCandidate(dataset, {
          declaration,
          createdBy: actor,
          now: Date.now(),
          scope,
          autoDetected: late.lateReadings.length > 0,
        });
        await saveRecalcCandidate(candidate);
        toast(
          late.lateReadings.length > 0 ? 'success' : 'info',
          late.lateReadings.length > 0
            ? `已生成重算候选：纳入 ${late.lateReadings.length} 条迟到读数，申报版本保持不变`
            : '已生成重算候选（无迟到读数）',
        );
        await refreshLedgers();
      } catch (error) {
        toast('error', `生成重算候选失败：${(error as Error).message}`);
      }
    },
    [actor, dataset, declarations, refreshLedgers, scope, toast],
  );

  const reviewCandidate = useCallback(
    async (candidateId: string, note: string) => {
      const target = candidates.find((c) => c.candidateId === candidateId);
      if (!target) return;
      const updated: RecalcCandidate = {
        ...target,
        status: 'REVIEWED',
        reviewedBy: actor,
        reviewedAt: Date.now(),
        reviewNote: note,
      };
      await saveRecalcCandidate(updated);
      await addAudit({
        at: Date.now(),
        actor,
        action: 'REVIEW_RECALC',
        detail: `复核重算候选 ${candidateId}：${note || '无附注'}；申报版本 ${target.declarationId} 保持 FILED`,
        refIds: [candidateId, target.declarationId],
      });
      toast('success', '候选已标记复核完成，申报版本未被改写');
      await refreshLedgers();
    },
    [actor, candidates, refreshLedgers, toast],
  );

  const reset = useCallback(async () => {
    await clearAll();
    setDataset(emptyDataset());
    setDeclarations([]);
    setCandidates([]);
    setAudits([]);
    setFiles([]);
    setSnapshot(null);
    setComparison(null);
    toast('info', '本地库已清空（需重新装载样例）');
  }, [toast]);

  const lookupFileReadings = useCallback(async (fileId: string) => {
    const list = await readingsByFile(fileId);
    return list.length;
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动计算：点位/日期/方法/作用域变化后重算
  useEffect(() => {
    if (!ready || dataset.points.length === 0) return;
    const timer = setTimeout(() => {
      void recompute({ compare: false });
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dataset.readings.length, pointCode, day, method, scope, dataset.instruments.length]);

  const days = useMemo(() => pickDays(dataset, pointCode), [dataset, pointCode]);
  const month = day.slice(0, 7);

  const lateCount = useMemo(() => {
    let count = 0;
    for (const decl of declarations) {
      count += detectLateReadings(dataset, decl).lateReadings.length;
    }
    return count;
  }, [dataset, declarations]);

  const state: AppState = {
    ready,
    loading,
    progress,
    dataset,
    manifest,
    pointCode,
    day,
    month,
    method,
    scope,
    actor,
    snapshot,
    comparison,
    computing,
    computeError,
    declarations,
    candidates,
    audits,
    files,
    lateCount,
    fingerprints,
    toasts,
    lastComputeMs,
  };
  const actions: AppActions = {
    reload,
    loadSample,
    importLate,
    setPointCode: setPointCodePersist,
    setDay: setDayPersist,
    setMethod,
    setScope,
    setActor: setActorPersist,
    recompute,
    fileCurrent,
    reviewCandidate,
    createCandidate,
    reset,
    toast,
    dismissToast,
    lookupFileReadings,
    refreshLedgers,
  };
  void days;
  void month;
  return { state, actions };
}

function mfHasPoints(ds: Dataset): boolean {
  return ds.points.length > 0;
}

export function pickDays(dataset: Dataset, pointCode: string): string[] {
  const set = new Set<string>();
  for (const r of dataset.readings) {
    if (r.pointCode === pointCode) set.add(r.dayKey || dayKeyFromMs(r.alignedAt));
  }
  return [...set].sort();
}
