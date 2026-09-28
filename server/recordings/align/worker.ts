// Runs alignSegments in a short-lived worker thread (DESIGN §15: heavy work off the server's event loop). A
// 60-minute lecture (≈ 540 segments × 49 slides) takes about 0.8 s of CPU and ~25 MB; a worker keeps live uploads
// and other requests answered meanwhile, and its memory is gone when it exits. This file is also the worker's
// entry point (dev: .ts run by Node's type stripping; production: the compiled .js).
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { alignSegments } from './align.ts';
import type { AlignInput, Label } from './align.ts';

interface WorkerMessage {
  ok: boolean;
  labels?: Label[];
  error?: string;
}

/** alignSegments(input) in a worker thread; falls back to the calling thread when no worker can be started. */
export function alignInWorker(input: AlignInput): Promise<Label[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(fileURLToPath(import.meta.url), { workerData: { easyStudyAlign: input } });
    } catch {
      try {
        resolve(alignSegments(input));
      } catch (err) {
        reject(err);
      }
      return;
    }
    let settled = false;
    worker.once('message', (message: WorkerMessage) => {
      settled = true;
      if (message.ok && message.labels) resolve(message.labels);
      else reject(new Error(message.error ?? '정렬에 실패했습니다'));
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`정렬 작업이 끝나지 못했습니다 (exit ${code})`));
    });
  });
}

const data = workerData as { easyStudyAlign?: AlignInput } | null;
if (!isMainThread && parentPort && data?.easyStudyAlign) {
  let message: WorkerMessage;
  try {
    message = { ok: true, labels: alignSegments(data.easyStudyAlign) };
  } catch (err) {
    message = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort.postMessage(message);
}
