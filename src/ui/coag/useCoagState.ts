/**
 * 混凝模块应用状态：样例资料、选中池、效率结果、迟到候选复核状态与审计。
 * 计算在 Worker 内完成；IndexedDB 保存整包资料与复核标记，刷新后可恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CoagDataset,
  CoagManifest,
  LateLabCandidate,
  TankEfficiency,
} from '../../coag/types';
import { addAudit, getCoagBundle, getMeta, listAudits, setMeta, putCoagBundle } from '../../db/db';
import type { AuditEntry } from '../../db/db';
import { createWorkerClient, type WorkerClient } from '../../worker/client';
import {
  COAG_SAMPLE_KEY,
  fetchCoagManifest,
  importCoagLateLabs,
  loadCoagSample,
  type CoagLoadProgress,
} from '../../coag/load';

const COAG_POINT_KEY = 'coag:tankId';
const COAG_REVIEW_KEY = 'coag:reviews';

export interface CoagReview {
  candidateId: string;
  status: 'PENDING' | 'REVIEWED';
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: number;
}

export interface CoagToasts {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface CoagState {
  ready: boolean;
  loading: boolean;
  progress: CoagLoadProgress | null;
  dataset: CoagDataset;
  manifest: CoagManifest | null;
  tankId: string;
  efficiency: TankEfficiency | null;
  computing: boolean;
  computeError: string | null;
  toasts: CoagToasts[];
  reviews: Record<string, CoagReview>;
  audits: AuditEntry[];
  fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[];
  issues: { file: string; row: number; message: string }[];
  lastComputeMs: number | null;
}

export interface CoagActions {
  loadSample: () => Promise<void>;
  importLate: () => Promise<void>;
  setTank: (tankId: string) => void;
  recompute: () => Promise<void>;
  reviewCandidate: (candidateId: string, note: string) => Promise<void>;
  toast: (kind: CoagToasts['kind'], text: string) => void;
  dismissToast: (id: string) => void;
  reload: () => Promise<void>;
  reset: () => Promise<void>;
}

function emptyDataset(): CoagDataset {
  return {
    plants: [],
    tanks: [],
    points: [],
    readings: [],
    bypasses: [],
    mixing: [],
    upsets: [],
    batches: [],
    storageTanks: [],
    transfers: [],
    stocktakes: [],
    pulses: [],
    pumpCalibrations: [],
    labs: [],
    shifts: [],
    shiftActions: [],
    lateLabs: [],
  };
}

export function useCoagState(): { state: CoagState; actions: CoagActions } {
  const workerRef = useRef<WorkerClient | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<CoagLoadProgress | null>(null);
  const [dataset, setDataset] = useState<CoagDataset>(emptyDataset);
  const [manifest, setManifest] = useState<CoagManifest | null>(null);
  const [tankId, setTankId] = useState('CT-01');
  const [efficiency, setEfficiency] = useState<TankEfficiency | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<CoagToasts[]>([]);
  const [reviews, setReviews] = useState<Record<string, CoagReview>>({});
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [fingerprints, setFingerprints] = useState<CoagState['fingerprints']>([]);
  const [issues, setIssues] = useState<CoagState['issues']>([]);
  const [lastComputeMs, setLastComputeMs] = useState<number | null>(null);

  const toast = useCallback((kind: CoagToasts['kind'], text: string) => {
    const id = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5200);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const reloadAudits = useCallback(async () => {
    setAudits(await listAudits());
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const stored = await getCoagBundle<{ dataset: CoagDataset; manifest: CoagManifest }>(COAG_SAMPLE_KEY);
      const storedTank = await getMeta<string>(COAG_POINT_KEY);
      const storedReviews = (await getMeta<Record<string, CoagReview>>(COAG_REVIEW_KEY)) ?? {};
      setReviews(storedReviews);
      let mf: CoagManifest | null = null;
      try {
        mf = await fetchCoagManifest();
      } catch {
        mf = stored?.manifest ?? null;
      }
      if (mf) setManifest(mf);
      if (stored?.dataset && stored.dataset.tanks.length > 0) {
        setDataset(stored.dataset);
        const tank = storedTank && stored.dataset.tanks.some((t) => t.tankId === storedTank) ? storedTank : stored.dataset.tanks[0].tankId;
        setTankId(tank);
        toast('info', `已从本地库恢复混凝样例（${stored.dataset.readings.length.toLocaleString('zh-CN')} 条读数）`);
      }
      setReady(true);
      await reloadAudits();
    } catch (error) {
      toast('error', `恢复混凝样例失败：${(error as Error).message}`);
      setReady(true);
      await reloadAudits();
    } finally {
      setLoading(false);
    }
  }, [reloadAudits, toast]);

  const loadSample = useCallback(async () => {
    setLoading(true);
    setProgress({ step: '准备装载', done: 0, total: 1 });
    try {
      const loaded = await loadCoagSample((p) => setProgress(p));
      setDataset(loaded.dataset);
      setManifest(loaded.manifest);
      setFingerprints(loaded.fingerprintMatches);
      setIssues(loaded.issues);
      setReviews({});
      await setMeta(COAG_REVIEW_KEY, {});
      await setTank(loaded.manifest.focus.tankId);
      if (loaded.warnings.length > 0) toast('warn', loaded.warnings.join('；'));
      else toast('success', `混凝样例装载完成：${loaded.fingerprintMatches.length} 份文件指纹全部匹配`);
      await addAudit({
        at: Date.now(),
        actor: '投加复核员',
        action: 'LOAD_COAG_SAMPLE',
        detail: `装载混凝样例：${loaded.dataset.tanks.length} 个池、${loaded.dataset.readings.length} 条读数、${loaded.dataset.pulses.length} 段泵脉冲`,
        refIds: loaded.dataset.tanks.map((t) => t.tankId),
      });
      await reloadAudits();
    } catch (error) {
      toast('error', `装载混凝样例失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
      setProgress(null);
    }

  }, [reloadAudits, toast]);

  const setTank = useCallback((next: string) => {
    setTankId(next);
    void setMeta(COAG_POINT_KEY, next);
  }, []);

  const importLate = useCallback(async () => {
    if (!manifest) {
      toast('warn', '尚未读取样例清单');
      return;
    }
    setLoading(true);
    try {
      const result = await importCoagLateLabs(dataset, manifest);
      setDataset(result.dataset);
      if (result.added === 0) toast('info', '清单中没有迟到化验批次');
      else if (!result.fingerprint.ok) toast('warn', '迟到化验文件指纹与清单不一致');
      else toast('success', `迟到化验已导入：${result.added} 条，仅生成新的复盘候选`);
      await addAudit({
        at: Date.now(),
        actor: '投加复核员',
        action: 'IMPORT_COAG_LATE_LABS',
        detail: `导入迟到化验 ${result.added} 条；当班处置保持不变`,
        refIds: result.dataset.lateLabs.map((l) => l.labId),
      });
      await reloadAudits();
    } catch (error) {
      toast('error', `导入迟到化验失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [dataset, manifest, reloadAudits, toast]);

  const recompute = useCallback(async () => {
    if (dataset.tanks.length === 0) {
      toast('warn', '本地库为空，请先装载混凝样例');
      return;
    }
    setComputing(true);
    setComputeError(null);
    try {
      if (!workerRef.current) workerRef.current = createWorkerClient();
      const eff = await workerRef.current.request<TankEfficiency>({
        type: 'computeCoag',
        dataset,
        tankId,
        day: dataset.readings[0]?.dayKey ?? manifest?.day ?? '2026-11-18',
        reviewCutoffReceivedAt: manifest?.focus.reviewCutoffReceivedAt,
      });
      setEfficiency(eff);
      setLastComputeMs(eff.computeMs);
    } catch (error) {
      const message = (error as Error).message;
      setComputeError(message);
      toast('error', `混凝效率计算失败：${message}`);
    } finally {
      setComputing(false);
    }
  }, [dataset, manifest, tankId, toast]);

  const reviewCandidate = useCallback(
    async (candidateId: string, note: string) => {
      const next: CoagReview = {
        candidateId,
        status: 'REVIEWED',
        reviewNote: note,
        reviewedBy: '投加复核员',
        reviewedAt: Date.now(),
      };
      const merged = { ...reviews, [candidateId]: next };
      setReviews(merged);
      await setMeta(COAG_REVIEW_KEY, merged);
      await addAudit({
        at: Date.now(),
        actor: '投加复核员',
        action: 'REVIEW_COAG_LATE_LAB',
        detail: `复核迟到化验候选 ${candidateId}：${note || '无附注'}；当班处置未被改写`,
        refIds: [candidateId],
      });
      await reloadAudits();
      toast('success', '候选已标记复核完成，当班处置记录保持不变');
    },
    [reloadAudits, reviews, toast],
  );

  const reset = useCallback(async () => {
    await putCoagBundle(COAG_SAMPLE_KEY, null);
    setDataset(emptyDataset());
    setEfficiency(null);
    setReviews({});
    await setMeta(COAG_REVIEW_KEY, {});
    toast('info', '混凝样例已从本地库清除');
  }, [toast]);

  useEffect(() => {
    void reload();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || dataset.tanks.length === 0) return;
    const timer = setTimeout(() => void recompute(), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dataset.readings.length, tankId]);

  const state: CoagState = {
    ready,
    loading,
    progress,
    dataset,
    manifest,
    tankId,
    efficiency,
    computing,
    computeError,
    toasts,
    reviews,
    audits,
    fingerprints,
    issues,
    lastComputeMs,
  };
  const actions: CoagActions = {
    loadSample,
    importLate,
    setTank,
    recompute,
    reviewCandidate,
    toast,
    dismissToast,
    reload,
    reset,
  };
  return { state, actions };
}

export function useCoagCandidates(state: CoagState): (LateLabCandidate & { review?: CoagReview })[] {
  return useMemo(() => {
    if (!state.efficiency) return [];
    return state.efficiency.lateLabCandidates.map((c) => ({ ...c, review: state.reviews[c.candidateId] }));
  }, [state.efficiency, state.reviews]);
}
