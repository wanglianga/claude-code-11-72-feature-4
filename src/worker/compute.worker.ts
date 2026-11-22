/**
 * WebWorker：所有重计算（日/月负荷、双路线对比、导出申报、迟到重算）在 Worker 内完成，
 * 主线程只负责 IndexedDB 读写与渲染。Worker 不直接访问 IndexedDB —
 * 数据集由主线程一次性投递，避免结构化克隆与事务并发问题。
 */

import {
  DEFAULT_SCOPE,
  Dataset,
  DayLoadSnapshot,
  Declaration,
  IntegrationMethod,
  MonthLoad,
  RecalcCandidate,
  ScopeOptions,
} from '../domain/types';
import { compareRoutes, computeDayLoad, computeMonthLoad } from '../domain/engine';
import { buildDeclaration, buildRecalcCandidate, detectLateReadings } from '../domain/service';
import { computeTankEfficiency } from '../coag/engine';
import type { CoagDataset, TankEfficiency } from '../coag/types';

export type WorkerRequest =
  | { id: string; type: 'computeDay'; dataset: Dataset; pointCode: string; day: string; method: IntegrationMethod; scope?: Partial<ScopeOptions>; withChart?: boolean }
  | { id: string; type: 'compareRoutes'; dataset: Dataset; pointCode: string; day: string; scope?: Partial<ScopeOptions> }
  | { id: string; type: 'computeMonth'; dataset: Dataset; pointCode: string; month: string; method: IntegrationMethod; scope?: Partial<ScopeOptions> }
  | { id: string; type: 'buildDeclaration'; dataset: Dataset; pointCode: string; day: string; method: IntegrationMethod; createdBy: string; scope?: Partial<ScopeOptions>; cutoffReceivedAt?: number }
  | { id: string; type: 'buildRecalc'; dataset: Dataset; declaration: Declaration; createdBy: string; scope?: Partial<ScopeOptions>; autoDetected?: boolean }
  | { id: string; type: 'computeCoag'; dataset: CoagDataset; tankId: string; day: string; reviewCutoffReceivedAt?: number };

export interface WorkerResponseOk {
  id: string;
  ok: true;
  type: WorkerRequest['type'];
  payload:
    | DayLoadSnapshot
    | ReturnType<typeof compareRoutes>
    | MonthLoad
    | Declaration
    | RecalcCandidate
    | TankEfficiency;
  tookMs: number;
}

export interface WorkerResponseError {
  id: string;
  ok: false;
  message: string;
}

export type WorkerResponse = WorkerResponseOk | WorkerResponseError;

function nowMs(): number {
  return Date.now();
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const started = nowMs();
  try {
    switch (req.type) {
      case 'computeDay': {
        const payload = computeDayLoad(req.dataset, req.pointCode, req.day, req.method, {
          scope: req.scope,
          withChart: req.withChart ?? true,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'compareRoutes': {
        const payload = compareRoutes(req.dataset, req.pointCode, req.day, {
          scope: req.scope,
          withChart: true,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'computeMonth': {
        const payload = computeMonthLoad(req.dataset, req.pointCode, req.month, req.method, {
          scope: req.scope,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'buildDeclaration': {
        const payload = buildDeclaration(
          req.dataset,
          {
            pointCode: req.pointCode,
            day: req.day,
            method: req.method,
            createdBy: req.createdBy,
            scope: req.scope ?? DEFAULT_SCOPE,
            cutoffReceivedAt: req.cutoffReceivedAt,
          },
          nowMs(),
        );
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'computeCoag': {
        const payload = computeTankEfficiency(req.dataset, req.tankId, req.day, {
          reviewCutoffReceivedAt: req.reviewCutoffReceivedAt,
          now: nowMs(),
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'buildRecalc': {
        const payload = buildRecalcCandidate(req.dataset, {
          declaration: req.declaration,
          createdBy: req.createdBy,
          now: nowMs(),
          scope: req.scope,
          autoDetected: req.autoDetected,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      default: {
        const exhaustive: never = req;
        throw new Error(`未知请求：${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    post({ id: req.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};

function post(response: WorkerResponse): void {
  (self as unknown as { postMessage: (v: WorkerResponse) => void }).postMessage(response);
}

export { detectLateReadings };
