/** 主线程 Worker 客户端：请求-响应配对、超时与错误传播 */

import type { WorkerRequest, WorkerResponse, WorkerResponseOk } from './compute.worker';

type WorkerScope = typeof globalThis & { Worker?: typeof Worker };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkerRequestInput = DistributiveOmit<WorkerRequest, 'id'>;

export interface WorkerClient {
  request: <T = WorkerResponseOk['payload']>(req: WorkerRequestInput, timeoutMs?: number) => Promise<T>;
  terminate: () => void;
}

type Pending = {
  resolve: (value: WorkerResponseOk) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createWorkerClient(): WorkerClient {
  const WorkerCtor = (globalThis as WorkerScope).Worker;
  if (!WorkerCtor) throw new Error('当前环境不支持 Web Worker，无法执行重计算');
  const worker = new WorkerCtor(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<string, Pending>();
  let counter = 0;

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.message));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || '计算 Worker 异常');
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  return {
    request<T>(req: WorkerRequestInput, timeoutMs = 120_000): Promise<T> {
      const id = `r${(counter += 1)}`;
      const full = { ...req, id } as WorkerRequest;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`计算超时（${timeoutMs} ms）：${req.type}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value.payload as T),
          reject,
          timer,
        });
        worker.postMessage(full);
      });
    },
    terminate() {
      worker.terminate();
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
  };
}
