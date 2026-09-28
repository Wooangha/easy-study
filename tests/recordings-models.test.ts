// Whisper model downloads (DESIGN §22, server/recordings/models.ts) against a local HTTP fixture server: the VAD
// model comes along, progress, sha256 verification (a mismatch leaves nothing behind), resuming an interrupted
// download with a Range request, errors of the first request as HTTP errors, cancel + delete. No network.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AsrStatus } from '../shared/types.ts';
import { HttpError } from '../server/config.ts';
import { startServer } from '../server/index.ts';
import { DEFAULT_CATALOG, ModelStore, modelsDir } from '../server/recordings/models.ts';
import type { ModelCatalog } from '../server/recordings/models.ts';

const MODEL = randomBytes(300_000);
const VAD = randomBytes(20_000);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Served {
  url: string;
  requests: Array<{ path: string; range?: string }>;
  /** Next response for a path: 'cut' = send half and drop the connection, 'slow' = trickle, number = status. */
  plan: Map<string, Array<'cut' | 'slow' | number>>;
  close(): Promise<void>;
}

async function fixtureServer(files: Record<string, Buffer>): Promise<Served> {
  const requests: Served['requests'] = [];
  const plan = new Map<string, Array<'cut' | 'slow' | number>>();
  const server = http.createServer((req, res) => {
    const file = files[req.url ?? ''];
    requests.push({ path: req.url ?? '', range: req.headers.range });
    const step = plan.get(req.url ?? '')?.shift();
    if (typeof step === 'number') {
      res.writeHead(step).end();
      return;
    }
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m) start = Number(m[1]);
    if (start >= file.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }).end();
      return;
    }
    const body = file.subarray(start);
    res.writeHead(m ? 206 : 200, {
      'Content-Length': String(body.length),
      ...(m ? { 'Content-Range': `bytes ${start}-${file.length - 1}/${file.length}` } : {}),
    });
    if (step === 'cut') {
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.socket?.destroy());
      return;
    }
    if (step === 'slow') {
      let at = 0;
      const timer = setInterval(() => {
        if (at >= body.length || res.destroyed) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(body.subarray(at, at + 4096));
        at += 4096;
      }, 5);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    plan,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

let tmp = '';
let served: Served;
let dirCount = 0;

function catalog(overrides: { modelSha?: string } = {}): ModelCatalog {
  return {
    models: [
      { id: 'small-q5_1', label: 'small', file: 'small.bin', url: `${served.url}/small.bin`, sizeBytes: MODEL.length, sha256: overrides.modelSha ?? sha(MODEL) },
      { id: 'missing', label: 'missing', file: 'missing.bin', url: `${served.url}/missing.bin`, sizeBytes: 10, sha256: '0' },
    ],
    vad: { file: 'vad.bin', url: `${served.url}/vad.bin`, sizeBytes: VAD.length, sha256: sha(VAD) },
  };
}

async function freshDir(): Promise<string> {
  const dir = path.join(tmp, `models-${++dirCount}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-models-'));
  // No engine: a finished download would otherwise warm up whatever whisper-cli this machine has.
  process.env.EASY_STUDY_WHISPER = path.join(tmp, 'no-whisper-cli');
  served = await fixtureServer({ '/small.bin': MODEL, '/vad.bin': VAD });
});

after(async () => {
  await served.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('model downloads', () => {
  test('the pinned catalog: turbo-q5_0 + small-q5_1 + Silero VAD v6.2.0 with their sizes and hashes', () => {
    const turbo = DEFAULT_CATALOG.models.find((m) => m.id === 'large-v3-turbo-q5_0');
    assert.equal(turbo?.sizeBytes, 574_041_195);
    assert.equal(turbo?.sha256, '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2');
    assert.match(turbo?.url ?? '', /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/5359861c739e955e79d9a303bcbc70fb988958b1\//);
    assert.equal(DEFAULT_CATALOG.models.find((m) => m.id === 'small-q5_1')?.sizeBytes, 190_085_487);
    assert.equal(DEFAULT_CATALOG.vad.sha256, '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987');
    assert.equal(modelsDir({ EASY_STUDY_MODELS_DIR: '/x/models' }), path.resolve('/x/models'));
    assert.match(modelsDir({}), /[/\\]\.cache[/\\]models$/);
  });

  test('downloads the model and the VAD model, verifies them, reports progress and installed', async () => {
    const dir = await freshDir();
    served.requests.length = 0;
    served.plan.set('/small.bin', ['slow']);
    const installed: string[] = [];
    const store = new ModelStore({ dir: () => dir, catalog: catalog(), onInstalled: (id) => installed.push(id) });
    assert.equal(store.list('small-q5_1')[0].installed, false);
    await store.startDownload('small-q5_1');
    let sawProgress = false;
    while (store.isDownloading('small-q5_1')) {
      const d = store.list('small-q5_1')[0].downloading;
      if (d && d.receivedBytes > VAD.length && d.receivedBytes < d.totalBytes) sawProgress = true;
      assert.equal(d?.totalBytes ?? MODEL.length + VAD.length, MODEL.length + VAD.length);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(sawProgress, 'progress between the files');
    const info = store.list('small-q5_1')[0];
    assert.equal(info.installed, true);
    assert.equal(info.recommended, true);
    assert.equal(info.downloading, undefined);
    assert.deepEqual(installed, ['small-q5_1']);
    assert.ok((await fs.readFile(path.join(dir, 'small.bin'))).equals(MODEL));
    assert.ok((await fs.readFile(path.join(dir, 'vad.bin'))).equals(VAD));
    assert.deepEqual(
      served.requests.map((r) => r.path),
      ['/vad.bin', '/small.bin'],
    );
    // Installed: nothing is fetched again.
    await store.startDownload('small-q5_1');
    assert.equal(served.requests.length, 2);
    // Delete removes the model, keeps the VAD model.
    await store.delete('small-q5_1');
    assert.equal(existsSync(path.join(dir, 'small.bin')), false);
    assert.equal(existsSync(path.join(dir, 'vad.bin')), true);
  });

  test('sha256 mismatch: an error, and nothing that looks installed stays behind', async () => {
    const dir = await freshDir();
    const store = new ModelStore({ dir: () => dir, catalog: catalog({ modelSha: 'f'.repeat(64) }) });
    await store.startDownload('small-q5_1');
    await store.waitForDownload('small-q5_1');
    assert.equal(store.isInstalled('small-q5_1'), false);
    assert.match(store.lastError('small-q5_1') ?? '', /sha256 불일치/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['vad.bin']);
  });

  test('an interrupted download resumes with a Range request from the bytes it has', async () => {
    const dir = await freshDir();
    await fs.writeFile(path.join(dir, 'vad.bin'), VAD);
    served.requests.length = 0;
    served.plan.set('/small.bin', ['cut']);
    const store = new ModelStore({ dir: () => dir, catalog: catalog() });
    await store.startDownload('small-q5_1');
    await store.waitForDownload('small-q5_1');
    assert.equal(store.isInstalled('small-q5_1'), false);
    const part = await fs.readFile(path.join(dir, 'small.bin.part'));
    assert.ok(part.length > 0 && part.length < MODEL.length, `part has ${part.length} bytes`);
    assert.ok(MODEL.subarray(0, part.length).equals(part));
    await store.startDownload('small-q5_1');
    await store.waitForDownload('small-q5_1');
    assert.equal(store.isInstalled('small-q5_1'), true, store.lastError('small-q5_1') ?? '');
    assert.ok((await fs.readFile(path.join(dir, 'small.bin'))).equals(MODEL));
    assert.equal(served.requests.at(-1)?.range, `bytes=${part.length}-`);
    assert.equal(existsSync(path.join(dir, 'small.bin.part')), false);
  });

  test('a server that ignores Range (200) restarts the file; 416 on a complete part finishes it', async () => {
    const dir = await freshDir();
    await fs.writeFile(path.join(dir, 'vad.bin'), VAD);
    await fs.writeFile(path.join(dir, 'small.bin.part'), MODEL);
    const store = new ModelStore({ dir: () => dir, catalog: catalog() });
    // A complete .part: the server answers 416 for the range beyond it.
    await store.startDownload('small-q5_1');
    await store.waitForDownload('small-q5_1');
    assert.equal(store.isInstalled('small-q5_1'), true, store.lastError('small-q5_1') ?? '');
    await store.delete('small-q5_1');
    // A garbage .part and a server without Range support: the file is fetched again from the start.
    await fs.writeFile(path.join(dir, 'small.bin.part'), randomBytes(1000));
    const noRange: typeof fetch = (input, init) => fetch(input, { ...init, headers: {} });
    const plain = new ModelStore({ dir: () => dir, catalog: catalog(), fetch: noRange });
    await plain.startDownload('small-q5_1');
    await plain.waitForDownload('small-q5_1');
    assert.equal(plain.isInstalled('small-q5_1'), true, plain.lastError('small-q5_1') ?? '');
  });

  test('the first request failing is an HTTP error of the start (502); unknown models 404', async () => {
    const dir = await freshDir();
    await fs.writeFile(path.join(dir, 'vad.bin'), VAD);
    const store = new ModelStore({ dir: () => dir, catalog: catalog() });
    await assert.rejects(store.startDownload('missing'), (err) => err instanceof HttpError && err.status === 502 && /HTTP 404/.test(err.message));
    await assert.rejects(store.startDownload('nope'), (err) => err instanceof HttpError && err.status === 404);
    const unreachable = new ModelStore({
      dir: () => dir,
      catalog: { ...catalog(), models: [{ ...catalog().models[0], url: 'http://127.0.0.1:9/x' }] },
    });
    await assert.rejects(unreachable.startDownload('small-q5_1'), (err) => err instanceof HttpError && err.status === 502);
    assert.equal(unreachable.isDownloading('small-q5_1'), false);
  });

  test('cancel: deleting a model while it downloads stops the download', async () => {
    const dir = await freshDir();
    await fs.writeFile(path.join(dir, 'vad.bin'), VAD);
    served.plan.set('/small.bin', ['slow']);
    const store = new ModelStore({ dir: () => dir, catalog: catalog() });
    await store.startDownload('small-q5_1');
    assert.equal(store.isDownloading('small-q5_1'), true);
    await store.delete('small-q5_1');
    assert.equal(store.isDownloading('small-q5_1'), false);
    assert.equal(store.isInstalled('small-q5_1'), false);
    assert.equal(existsSync(path.join(dir, 'small.bin.part')), false);
  });

  test('over HTTP: POST …/download → 202, progress and installed in GET /api/asr, DELETE → 204', async () => {
    const dir = await freshDir();
    const library = await fs.mkdtemp(path.join(tmp, 'library-'));
    process.env.EASY_STUDY_LIBRARY = library;
    const server = await startServer({
      port: 0,
      log: false,
      resumeIngests: false,
      providerInfos: async () => [],
      recordings: { models: new ModelStore({ dir: () => dir, catalog: catalog() }) },
    });
    try {
      const start = await fetch(`${server.url}/api/asr/models/small-q5_1/download`, { method: 'POST' });
      assert.equal(start.status, 202);
      let status: AsrStatus;
      do {
        status = (await (await fetch(`${server.url}/api/asr`)).json()) as AsrStatus;
      } while (!status.models.find((m) => m.id === 'small-q5_1')?.installed);
      const missing = await fetch(`${server.url}/api/asr/models/missing/download`, { method: 'POST' });
      assert.equal(missing.status, 502);
      assert.match(((await missing.json()) as { error: string }).error, /모델을 내려받을 수 없습니다/);
      const removed = await fetch(`${server.url}/api/asr/models/small-q5_1`, { method: 'DELETE' });
      assert.equal(removed.status, 204);
      status = (await (await fetch(`${server.url}/api/asr`)).json()) as AsrStatus;
      assert.equal(status.models.find((m) => m.id === 'small-q5_1')?.installed, false);
    } finally {
      await server.close();
    }
  });
});
