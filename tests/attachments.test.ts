// Attachments of questions (DESIGN §21): selected slide regions and images of the student, over HTTP (create, get,
// delete, send with a question), what the provider is given, the notes, and the cleanup rules (session and document
// deletion, the 24 h sweep, pins of running turns). Fake providers only; the image worker is the real one.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../shared/types.ts';
import type { Attachment, DocMeta, ProviderInfo, Session, StreamEvent } from '../shared/types.ts';
import {
  attachmentsDir,
  cleanAttachmentName,
  createRegionAttachment,
  deleteAttachment,
  hasAttachmentJobs,
  holdAttachments,
  parseRegionRequest,
  sniffImageType,
  startAttachmentSweeper,
  sweepAttachments,
} from '../server/attachments.ts';
import { defaultChatDeps } from '../server/chat.ts';
import type { ChatDeps } from '../server/chat.ts';
import { HttpError, repoRoot } from '../server/config.ts';
import { startServer } from '../server/index.ts';
import type { RunningServer } from '../server/index.ts';
import { docPaths } from '../server/library.ts';
import type { StoredDocMeta } from '../server/library.ts';
import type { Part, Provider, ProviderRunInput } from '../server/providers/types.ts';
import { referencedAttachmentIds } from '../server/sessions.ts';
import { pngHeaderOnly, svgBehindAvifHeader } from './imageFixtures.ts';
import { smsg } from '../server/i18n.ts';

/** 413 for an image whose resolution the worker refuses (Korean: the tests send no language). */
const IMAGE_TOO_LARGE_PIXELS = smsg('ko').library.attachments.imageTooManyPixels;

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-attach-'));
  process.env.EASY_STUDY_LIBRARY = tmpRoot;
  process.env.EASY_STUDY_AUTO_DIGEST = '0';
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATTACHMENT_FILE_ID = /^att-[0-9a-f]{16}$/;
const HOUR = 60 * 60 * 1000;

/** A document folder with doc.json only (enough for uploads, sessions and the sweep). */
async function makeDoc(docId: string, status: DocMeta['status'] = 'ready'): Promise<void> {
  const paths = docPaths(docId);
  await fs.mkdir(paths.textDir, { recursive: true });
  const meta: StoredDocMeta = {
    id: docId,
    title: 'Other Deck',
    fileName: 'Other Deck.pdf',
    pageCount: status === 'ready' ? 3 : 0,
    aspectRatio: 16 / 9,
    status,
    progress: 0,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(paths.docJson, JSON.stringify(meta));
}

function textOf(parts: Part[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : `<image ${part.label}>`)).join('\n');
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface SseFrame {
  event: string;
  data: StreamEvent;
}

function parseSse(raw: string): SseFrame[] {
  return raw
    .split('\n\n')
    .filter((frame) => frame.trim() && !frame.startsWith(':'))
    .map((frame) => ({
      event: /^event: (.+)$/m.exec(frame)?.[1] ?? '',
      data: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? 'null') as StreamEvent,
    }));
}

/** A fake CLI provider that records its calls; a question containing HOLD waits until `releaseHold()`. */
function fakeProvider() {
  const calls: ProviderRunInput[] = [];
  let releaseHold: () => void = () => {};
  const provider: Provider = {
    id: 'claude-code',
    label: 'Fake Claude Code',
    kind: 'cli',
    models: [{ id: '', label: 'default' }],
    defaultModel: '',
    maxImagesPerConversation: 48,
    detect: async () => ({ available: true }),
    run: async (input) => {
      calls.push(input);
      if (textOf(input.parts).includes('HOLD')) await new Promise<void>((resolve) => (releaseHold = resolve));
      const text = `answer ${calls.length}`;
      input.onDelta(text);
      return { text, resume: { cliSessionId: `cli-${calls.length}` } };
    },
  };
  return { provider, calls, release: () => releaseHold() };
}

// ---------------------------------------------------------------------------

describe('attachments over HTTP', () => {
  let server: RunningServer;
  let base = '';
  let docId = '';
  const OTHER = 'other-deck-bbb222';
  const PROCESSING = 'busy-deck-ccc333';
  const fake = fakeProvider();
  const infos: ProviderInfo[] = [{ id: 'claude-code', label: 'Claude Code', kind: 'cli', available: true, models: [], defaultModel: '' }];
  const deps: ChatDeps = {
    ...defaultChatDeps(),
    getProvider: (id) => (id === 'claude-code' ? fake.provider : undefined),
    checkProvider: async () => ({ available: true }),
    cliSlot: undefined,
  };

  const api = (p: string, init?: RequestInit) => fetch(`${base}/api${p}`, init);
  const postJson = (p: string, body: unknown) =>
    api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const postImage = (doc: string, body: Buffer | string, type = 'image/png', fileName?: string) =>
    api(`/docs/${doc}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': type, ...(fileName !== undefined ? { 'X-Filename': encodeURIComponent(fileName) } : {}) },
      body,
    });

  async function expectError(res: Response, status: number, pattern?: RegExp): Promise<string> {
    const body = (await res.json()) as { error: string };
    assert.equal(res.status, status, body.error);
    assert.equal(typeof body.error, 'string');
    if (pattern) assert.match(body.error, pattern);
    return body.error;
  }

  async function region(slide: number, rect: { x: number; y: number; w: number; h: number }, doc = docId): Promise<Attachment> {
    const res = await postJson(`/docs/${doc}/regions`, { slide, rect });
    const body = (await res.json()) as Attachment & { error?: string };
    assert.equal(res.status, 201, body.error ?? '');
    return body;
  }

  let pngCounter = 0;
  /** A small PNG of its own colour (every upload differs). */
  async function png(width = 60, height = 40): Promise<Buffer> {
    pngCounter++;
    return sharp({ create: { width, height, channels: 3, background: { r: (pngCounter * 37) % 256, g: 90, b: 160 } } }).png().toBuffer();
  }

  async function upload(doc = docId, fileName?: string): Promise<Attachment> {
    const res = await postImage(doc, await png(), 'image/png', fileName);
    const body = (await res.json()) as Attachment & { error?: string };
    assert.equal(res.status, 201, body.error ?? '');
    return body;
  }

  async function newSession(): Promise<string> {
    const res = await postJson(`/docs/${docId}/sessions`, { provider: 'claude-code' });
    assert.equal(res.status, 201);
    return ((await res.json()) as Session).id;
  }

  async function ask(sessionId: string, text: string, attachments?: unknown, slide = 5): Promise<SseFrame[]> {
    const res = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text, slide, attachments });
    const raw = await res.text();
    assert.equal(res.status, 200, raw);
    return parseSse(raw);
  }

  async function session(sessionId: string): Promise<Session> {
    return (await (await api(`/docs/${docId}/sessions/${sessionId}`)).json()) as Session;
  }

  before(async () => {
    server = await startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => infos, chatDeps: deps });
    base = server.url;
    const pdf = await fs.readFile(path.join(repoRoot(), 'samples', 'sample-lecture.pdf'));
    const res = await api('/docs', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    docId = ((await res.json()) as DocMeta).id;
    await waitFor(async () => ((await (await api(`/docs/${docId}`)).json()) as DocMeta).status === 'ready', 60_000);
    await makeDoc(OTHER);
    await makeDoc(PROCESSING, 'processing');
  });

  after(async () => {
    fake.release();
    await server?.close();
  });

  // --- regions -----------------------------------------------------------------------------------

  test('POST regions: 201 with the Attachment; the image and its metadata are stored', async () => {
    const created = await region(5, { x: 0, y: 0.2, w: 1, h: 0.2 });
    assert.match(created.id, ATTACHMENT_FILE_ID);
    assert.equal(created.kind, 'region');
    assert.equal(created.slide, 5);
    assert.deepEqual(created.rect, { x: 0, y: 0.2, w: 1, h: 0.2 });
    assert.equal(created.width, 1568);
    assert.ok(created.height >= 211 && created.height <= 213, String(created.height));
    assert.match(created.text ?? '', /^• Bursts: P1 = 24, P2 = 3, P3 = 3\n• Average waiting time/);
    assert.ok(Math.abs(Date.parse(created.createdAt) - Date.now()) < 60_000);
    assert.equal(created.name, undefined);

    const files = (await fs.readdir(attachmentsDir(docId))).filter((name) => name.startsWith(created.id)).sort();
    assert.equal(files.length, 2);
    assert.equal(files[1], `${created.id}.json`);
    assert.match(files[0], /\.(jpg|png)$/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(attachmentsDir(docId), `${created.id}.json`), 'utf8')), created);

    const image = await api(`/docs/${docId}/attachments/${created.id}`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type') ?? '', /^image\/(jpeg|png)$/);
    assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height], [created.width, created.height]);
  });

  test('POST regions: a rect overshooting 1 by float dust is clamped; 400 for bad slides and rects', async () => {
    const clamped = await region(9, { x: 0.5, y: 0.5, w: 0.5000001, h: 0.5 });
    assert.deepEqual(clamped.rect, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    // Stored as sent: clamping adds no floating-point dust (0.1 + 0.62 - 0.1 is 0.6200000000000001).
    assert.deepEqual((await region(5, { x: 0.1, y: 0.1, w: 0.001, h: 0.001 })).rect, { x: 0.1, y: 0.1, w: 0.001, h: 0.001 });
    for (const rect of [
      { x: 0.2, y: 0.2, w: 0.62, h: 0.6 },
      { x: 0.1, y: 0.7, w: 0.62, h: 0.3 },
      { x: 0.3, y: 0, w: 0.7, h: 1 },
      { x: 0.1234, y: 0.5678, w: 0.4321, h: 0.2 },
    ]) {
      const parsed = parseRegionRequest({ slide: 1, rect }, 9).rect;
      assert.deepEqual(parsed, rect);
      assert.ok(parsed.x + parsed.w <= 1 + 1e-12 && parsed.y + parsed.h <= 1 + 1e-12, JSON.stringify(parsed));
    }
    // Narrower than the stored precision (1e-6) is no area at all.
    assert.throws(() => parseRegionRequest({ slide: 1, rect: { x: 0.5, y: 0.5, w: 1e-7, h: 0.1 } }, 9), HttpError);

    const bad: unknown[] = [
      {},
      { rect: { x: 0, y: 0, w: 1, h: 1 } },
      { slide: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { slide: 10, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { slide: 1.5, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { slide: '1', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { slide: 1 },
      { slide: 1, rect: null },
      { slide: 1, rect: { x: 0, y: 0, w: 1 } },
      { slide: 1, rect: { x: 0, y: 0, w: '1', h: 1 } },
      { slide: 1, rect: { x: 0, y: 0, w: 0, h: 0.5 } },
      { slide: 1, rect: { x: 0, y: 0, w: 0.5, h: -0.1 } },
      { slide: 1, rect: { x: -0.1, y: 0, w: 0.5, h: 0.5 } },
      { slide: 1, rect: { x: 0.8, y: 0, w: 0.5, h: 0.5 } },
      { slide: 1, rect: { x: 0, y: 1.2, w: 0.1, h: 0.1 } },
    ];
    for (const body of bad) await expectError(await postJson(`/docs/${docId}/regions`, body), 400);
    await expectError(await api(`/docs/${docId}/regions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' }), 400);
    // NaN and Infinity cannot be sent as JSON: checked on the parser.
    assert.throws(() => parseRegionRequest({ slide: 1, rect: { x: Number.NaN, y: 0, w: 1, h: 1 } }, 9), HttpError);
    assert.throws(() => parseRegionRequest({ slide: 1, rect: { x: 0, y: 0, w: Infinity, h: 1 } }, 9), HttpError);
  });

  test('POST regions: 404 for unknown or invalid documents, 409 while the document is converted', async () => {
    await expectError(await postJson('/docs/missing-000000/regions', { slide: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }), 404);
    await expectError(await postJson('/docs/NOT_VALID/regions', { slide: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }), 404);
    await expectError(await postJson(`/docs/${PROCESSING}/regions`, { slide: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }), 409, /처리하는 중/);
    assert.equal(existsSync(attachmentsDir(PROCESSING)), false, 'nothing was written');
  });

  test('POST regions: a slide image that cannot be read is a readable 500 (no server paths), nothing is left', async () => {
    // OTHER is 'ready' with 3 pages but has no rendered slides.
    const error = await expectError(await postJson(`/docs/${OTHER}/regions`, { slide: 2, rect: { x: 0, y: 0, w: 1, h: 1 } }), 500);
    assert.equal(error, '슬라이드 2의 선택 영역을 잘라내지 못했습니다');
    assert.deepEqual(await fs.readdir(attachmentsDir(OTHER)), []);
  });

  // --- uploads -----------------------------------------------------------------------------------

  test('POST attachments: 201 with the Attachment (its file name, if any), stored re-encoded', async () => {
    const named = await upload(docId, 'C:\\fakepath\\칠판 사진.png');
    assert.match(named.id, ATTACHMENT_FILE_ID);
    assert.equal(named.kind, 'image');
    assert.equal(named.name, '칠판 사진.png', 'only the last path segment');
    assert.deepEqual([named.width, named.height], [60, 40]);
    assert.equal(named.slide, undefined);
    assert.equal(named.text, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(attachmentsDir(docId), `${named.id}.json`), 'utf8')), named);

    const anonymous = await upload(docId);
    assert.equal('name' in anonymous, false);

    // Its bytes are the worker's encoding, not the upload (no metadata survives).
    const tagged = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#123456' } }).jpeg().withMetadata({ orientation: 8 }).toBuffer();
    const res = await postImage(docId, tagged, 'image/jpeg', 'rotated.jpg');
    assert.equal(res.status, 201);
    const rotated = (await res.json()) as Attachment;
    assert.deepEqual([rotated.width, rotated.height], [20, 30]);
    const stored = Buffer.from(await (await api(`/docs/${docId}/attachments/${rotated.id}`)).arrayBuffer());
    const meta = await sharp(stored).metadata();
    assert.equal(meta.exif, undefined);
    assert.equal(meta.orientation, undefined);
    assert.equal((await fs.readdir(attachmentsDir(docId))).some((name) => name.endsWith('.upload') || name.endsWith('.tmp')), false);
  });

  test('POST attachments: 413 over 10 MB, 415 for other types, 400 empty or unreadable, 404 unknown document', async () => {
    const before = (await fs.readdir(attachmentsDir(docId))).length;
    const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0);
    (await png()).copy(tooBig);
    await expectError(await postImage(docId, tooBig), 413, /10 MB/);
    await expectError(await postImage(docId, await png(), 'text/plain'), 415);
    await expectError(await postImage(docId, await png(), 'application/octet-stream'), 415);
    await expectError(await postImage(docId, 'just some text', 'image/png'), 415, /PNG, JPEG, WebP, GIF/);
    await expectError(await postImage(docId, Buffer.from('%PDF-1.4 not an image'), 'image/png'), 415);
    await expectError(await postImage(docId, Buffer.alloc(0), 'image/png'), 400);
    const brokenPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage garbage')]);
    await expectError(await postImage(docId, brokenPng, 'image/png'), 400, /읽을 수 없습니다/);
    // HEIC (an iPhone photo) that this sharp cannot decode: 415 with a clear message.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64, 1)]);
    await expectError(await postImage(docId, heic, 'image/heic', 'IMG_0001.HEIC'), 415, /HEIC/);
    await expectError(await postImage('missing-000000', await png()), 404);
    await expectError(await postImage('NOT_VALID', await png()), 404);
    assert.equal((await fs.readdir(attachmentsDir(docId))).length, before, 'nothing was left behind');
  });

  test('POST attachments: an SVG behind an image header is 415 (never rendered); images too large to decode are 413, not "damaged"', async () => {
    const before = (await fs.readdir(attachmentsDir(docId))).sort();
    const sibling = before.find((name) => /\.(jpg|png)$/.test(name)) ?? 'x.png';
    await expectError(await postImage(docId, svgBehindAvifHeader(sibling), 'image/avif'), 415);
    // Over 100 M pixels (a 372 KB file was answered "damaged" before).
    await expectError(await postImage(docId, pngHeaderOnly(12_000, 10_000, { colorType: 0 })), 413, /해상도가 너무 커서/);
    // Interlaced 16-bit: decoded whole, 392 MB.
    const error = await expectError(await postImage(docId, pngHeaderOnly(7000, 7000, { bitDepth: 16, interlaced: true })), 413);
    assert.equal(error, IMAGE_TOO_LARGE_PIXELS);
    assert.deepEqual((await fs.readdir(attachmentsDir(docId))).sort(), before, 'nothing was left behind');
  });

  test('magic bytes and file names', () => {
    assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(sniffImageType(Buffer.from('GIF89a....', 'latin1')), 'gif');
    assert.equal(sniffImageType(Buffer.from('GIF87a....', 'latin1')), 'gif');
    assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
    assert.equal(sniffImageType(Buffer.from('\0\0\0\x18ftypheic', 'latin1')), 'heif');
    assert.equal(sniffImageType(Buffer.from('\0\0\0\x18ftypavif', 'latin1')), 'heif');
    assert.equal(sniffImageType(Buffer.from('\0\0\0\x18ftypisom', 'latin1')), null, 'an MP4 is not an image');
    assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')), null);
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);

    assert.equal(cleanAttachmentName('/Users/me/Desktop/a.png'), 'a.png');
    assert.equal(cleanAttachmentName('line\nbreak\t.png'), 'line break .png');
    assert.equal(cleanAttachmentName('   '), undefined);
    assert.equal(cleanAttachmentName(undefined), undefined);
    assert.equal(cleanAttachmentName(`${'가'.repeat(200)}.png`)?.length, 121);
  });

  // --- get / delete ------------------------------------------------------------------------------

  test('GET: 404 for invalid, unknown and other documents’ ids', async () => {
    const other = await upload(OTHER);
    assert.equal((await api(`/docs/${OTHER}/attachments/${other.id}`)).status, 200);
    await expectError(await api(`/docs/${docId}/attachments/${other.id}`), 404);
    await expectError(await api(`/docs/${docId}/attachments/att-0000000000000000`), 404);
    await expectError(await api(`/docs/${docId}/attachments/BAD_ID`), 404);
    await expectError(await api(`/docs/${docId}/attachments/..%2Fdoc.json`), 404);
    await expectError(await api(`/docs/missing-000000/attachments/${other.id}`), 404);
  });

  test('DELETE: 204 while unused (files gone), 404 when unknown', async () => {
    const chip = await upload();
    const res = await api(`/docs/${docId}/attachments/${chip.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal((await fs.readdir(attachmentsDir(docId))).some((name) => name.startsWith(chip.id)), false);
    await expectError(await api(`/docs/${docId}/attachments/${chip.id}`), 404);
    await expectError(await api(`/docs/${docId}/attachments/${chip.id}`, { method: 'DELETE' }), 404);
    await expectError(await api(`/docs/${docId}/attachments/BAD_ID`, { method: 'DELETE' }), 404);
  });

  // --- questions with attachments ----------------------------------------------------------------

  let askedSession = '';
  let askedRegion: Attachment;
  let askedImage: Attachment;

  test('a question with attachments: the provider gets them after the focus window, the user message stores them', async () => {
    askedSession = await newSession();
    askedRegion = await region(5, { x: 0, y: 0.2, w: 1, h: 0.2 });
    askedImage = await upload(docId, 'board.png');
    const callsBefore = fake.calls.length;
    const frames = await ask(askedSession, '이 부분 설명해줘', [askedRegion.id, askedImage.id, askedRegion.id]);
    assert.deepEqual(frames.map((f) => f.event).at(-1), 'done');
    const start = frames.find((f) => f.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>;
    assert.deepEqual(start.userMessage.attachments, [askedRegion, askedImage], 'duplicates dropped, request order kept');
    assert.equal(start.userMessage.context?.attachments, 2);

    const call = fake.calls[callsBefore];
    const attachmentImages = call.parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image' && p.label.startsWith('Attachment'));
    assert.deepEqual(
      attachmentImages.map((p) => [path.basename(p.path).split('.')[0], p.detail, p.label]),
      [
        [askedRegion.id, 'high', 'Attachment 1: the region of slide 5 the student selected'],
        [askedImage.id, 'high', 'Attachment 2: an image from the student (board.png)'],
      ],
    );
    for (const part of attachmentImages) assert.ok(existsSync(part.path), part.path);
    const text = textOf(call.parts);
    assert.ok(text.indexOf('The student attached 2 images') > text.indexOf('The student is currently looking at slide 5'));
    assert.ok(text.indexOf('Text inside the selection:\n• Bursts') > text.indexOf('[Attachment 1:'));
    assert.ok(text.indexOf("Student's question (about slide 5):\n이 부분 설명해줘") > text.indexOf('[Attachment 2:'));

    const stored = await session(askedSession);
    const user = stored.messages.find((m) => m.role === 'user' && m.text === '이 부분 설명해줘');
    assert.deepEqual(user?.attachments, [askedRegion, askedImage]);
    assert.deepEqual([...(await referencedAttachmentIds(docId))].sort(), [askedRegion.id, askedImage.id].sort());
  });

  test('a question without attachments is unchanged; priming turns ignore them', async () => {
    const sessionId = await newSession();
    const prime = await postJson(`/docs/${docId}/sessions/${sessionId}/prime`, { slide: 1, attachments: [askedImage.id] });
    const primeFrames = parseSse(await prime.text());
    const primeStart = primeFrames.find((f) => f.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>;
    assert.equal(primeStart.userMessage.attachments, undefined);
    assert.equal(primeStart.userMessage.context?.attachments, undefined);
    assert.doesNotMatch(textOf(fake.calls.at(-1)!.parts), /Attachment 1/);

    const frames = await ask(sessionId, '그냥 질문', undefined, 2);
    const start = frames.find((f) => f.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>;
    assert.equal('attachments' in start.userMessage, false);
    assert.equal(start.userMessage.context?.attachments, undefined);
    const empty = await ask(sessionId, '빈 배열', [], 2);
    assert.equal((empty.find((f) => f.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>).userMessage.attachments, undefined);
  });

  test('400 for unknown, malformed, foreign or too many attachment ids — and nothing is persisted', async () => {
    const sessionId = await newSession();
    const other = await upload(OTHER);
    const many = await Promise.all(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => upload()));
    const cases: [unknown, RegExp][] = [
      [['att-0000000000000000'], /첨부를 찾을 수 없습니다/],
      [[other.id], /첨부를 찾을 수 없습니다/],
      [['BAD_ID'], /attachments/],
      [[42], /attachments/],
      ['att-0000000000000000', /attachments/],
      [{ id: askedImage.id }, /attachments/],
      [many.map((a) => a.id), /최대 6개/],
    ];
    for (const [attachments, pattern] of cases) {
      const res = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'x', slide: 1, attachments });
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      await expectError(res, 400, pattern);
    }
    // Ids that exist nowhere here (swept, deleted, another document's) are listed, so the client can drop exactly
    // those chips; the ones that exist are not.
    const kept = await upload();
    const res = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, {
      text: 'x',
      slide: 1,
      attachments: ['att-0000000000000000', kept.id, other.id],
    });
    const body = (await res.json()) as { error: string; missingAttachments?: unknown };
    assert.equal(res.status, 400);
    assert.deepEqual(body.missingAttachments, ['att-0000000000000000', other.id]);
    assert.equal(body.error, `첨부를 찾을 수 없습니다: att-0000000000000000, ${other.id} (지워졌거나 다른 문서의 첨부입니다 — 질문에 쓰지 않은 첨부는 24시간 뒤에 지워집니다)`);
    const malformed = (await (await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'x', slide: 1, attachments: ['BAD_ID'] })).json()) as object;
    assert.equal('missingAttachments' in malformed, false, 'a malformed request lists nothing');
    // Exactly MAX_ATTACHMENTS is fine.
    const six = await ask(sessionId, '여섯 개', many.slice(0, MAX_ATTACHMENTS).map((a) => a.id), 1);
    const start = six.find((f) => f.event === 'start')?.data as Extract<StreamEvent, { type: 'start' }>;
    assert.equal(start.userMessage.attachments?.length, MAX_ATTACHMENTS);
    assert.equal((await session(sessionId)).messages.length, 2, 'only the successful question');
  });

  test('DELETE: 409 once a message refers to the attachment', async () => {
    await expectError(await api(`/docs/${docId}/attachments/${askedRegion.id}`, { method: 'DELETE' }), 409, /이미 질문에 쓰인/);
    assert.equal((await api(`/docs/${docId}/attachments/${askedRegion.id}`)).status, 200);
  });

  test('pins: attachments of a running turn can be neither deleted nor swept; released when it ends', async () => {
    const chip = await upload();
    const held = await holdAttachments(docId, [chip.id]);
    await assert.rejects(deleteAttachment(docId, chip.id, referencedAttachmentIds), (err: HttpError) => err.status === 409);
    assert.equal(await sweepAttachments(referencedAttachmentIds, { now: Date.now() + 48 * HOUR }) >= 0, true);
    assert.equal((await api(`/docs/${docId}/attachments/${chip.id}`)).status, 200, 'the sweep left it');
    held.release();
    held.release(); // idempotent
    await deleteAttachment(docId, chip.id, referencedAttachmentIds);
    assert.equal((await api(`/docs/${docId}/attachments/${chip.id}`)).status, 404);

    // A turn over HTTP pins its attachments from before the user message is saved until the answer is done.
    const sessionId = await newSession();
    const pinned = await upload();
    const running = await postJson(`/docs/${docId}/sessions/${sessionId}/messages`, { text: 'HOLD on', slide: 3, attachments: [pinned.id] });
    const reader = running.body!.getReader();
    let raw = '';
    while (!raw.includes('event: start')) raw += new TextDecoder().decode((await reader.read()).value);
    await expectError(await api(`/docs/${docId}/attachments/${pinned.id}`, { method: 'DELETE' }), 409);
    fake.release();
    while (!(await reader.read()).done);
    await expectError(await api(`/docs/${docId}/attachments/${pinned.id}`, { method: 'DELETE' }), 409, /이미 질문에 쓰인/);
  });

  // --- notes -------------------------------------------------------------------------------------

  test('notes/<sid>.md and STUDY_NOTES.md show the attachments under the question, linked relatively', async () => {
    const paths = docPaths(docId);
    const files = await fs.readdir(attachmentsDir(docId));
    const fileOf = (id: string) => files.find((name) => name.startsWith(`${id}.`) && !name.endsWith('.json'))!;
    const regionFile = fileOf(askedRegion.id);
    const imageFile = fileOf(askedImage.id);

    const sessionMd = await fs.readFile(path.join(paths.notesDir, `${askedSession}.md`), 'utf8');
    const sessionLine = `![p.5 영역](../attachments/${regionFile}) ![이미지](../attachments/${imageFile})`;
    assert.ok(sessionMd.includes(`**Q.** 이 부분 설명해줘\n\n${sessionLine}\n\nanswer`), sessionMd);
    for (const link of sessionMd.matchAll(/\]\((\.\.\/attachments\/[^)]+)\)/g)) {
      assert.ok(existsSync(path.resolve(paths.notesDir, link[1])), link[1]);
    }

    const study = await fs.readFile(paths.studyNotes, 'utf8');
    const studyLine = `![p.5 영역](attachments/${regionFile}) ![이미지](attachments/${imageFile})`;
    assert.ok(study.includes(`### Q. 이 부분 설명해줘\n`), study);
    const entry = study.slice(study.indexOf('### Q. 이 부분 설명해줘'));
    assert.ok(entry.indexOf(studyLine) > 0 && entry.indexOf(studyLine) < entry.indexOf('answer'), entry.slice(0, 400));
    for (const link of study.matchAll(/\]\((attachments\/[^)]+)\)/g)) assert.ok(existsSync(path.resolve(paths.dir, link[1])), link[1]);

    // The notes API hands the attachments to the client with the question.
    const notes = (await (await api(`/docs/${docId}/notes`)).json()) as { slides: { slide: number; entries: { question: { attachments?: Attachment[] } }[] }[] };
    const five = notes.slides.find((s) => s.slide === 5);
    assert.ok(five?.entries.some((e) => e.question.attachments?.[0]?.id === askedRegion.id));
  });

  // --- cleanup -----------------------------------------------------------------------------------

  test('deleting a session deletes the attachments only its messages referred to', async () => {
    const first = await newSession();
    const second = await newSession();
    const onlyFirst = await upload();
    const shared = await region(2, { x: 0.1, y: 0.2, w: 0.3, h: 0.3 });
    const unused = await upload();
    await ask(first, '첫 번째', [onlyFirst.id, shared.id], 2);
    await ask(second, '두 번째', [shared.id], 2);

    const res = await api(`/docs/${docId}/sessions/${first}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal((await api(`/docs/${docId}/attachments/${onlyFirst.id}`)).status, 404);
    assert.equal((await fs.readdir(attachmentsDir(docId))).some((name) => name.startsWith(onlyFirst.id)), false);
    assert.equal((await api(`/docs/${docId}/attachments/${shared.id}`)).status, 200, 'still used by the other session');
    assert.equal((await api(`/docs/${docId}/attachments/${unused.id}`)).status, 200, 'a chip not sent yet is not the session’s');

    assert.equal((await api(`/docs/${docId}/sessions/${second}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/docs/${docId}/attachments/${shared.id}`)).status, 404);
  });

  test('the sweep deletes unreferenced attachments older than 24 h and leftover files; referenced and young ones stay', async () => {
    const dir = attachmentsDir(docId);
    const young = await upload();
    const old = await upload();
    // Old by its metadata.
    const oldMetaFile = path.join(dir, `${old.id}.json`);
    await fs.writeFile(oldMetaFile, JSON.stringify({ ...old, createdAt: new Date(Date.now() - 25 * HOUR).toISOString() }));
    // Leftovers without metadata: an interrupted upload and an image whose metadata was never written.
    const stamp = new Date(Date.now() - 30 * HOUR);
    const leftovers = ['att-00000000000000aa.upload', 'att-00000000000000bb.png', 'att-00000000000000bb.png.123.abcd.tmp'];
    for (const name of leftovers) {
      await fs.writeFile(path.join(dir, name), 'x');
      await fs.utimes(path.join(dir, name), stamp, stamp);
    }
    // A fresh leftover (an upload in progress) stays.
    await fs.writeFile(path.join(dir, 'att-00000000000000cc.upload'), 'x');
    // Something else in the folder is not ours to remove.
    await fs.writeFile(path.join(dir, 'README.txt'), 'x');
    await fs.utimes(path.join(dir, 'README.txt'), stamp, stamp);

    const removed = await sweepAttachments(referencedAttachmentIds);
    assert.equal(removed, 3, 'the old attachment and the two leftover ids');
    const names = await fs.readdir(dir);
    assert.equal(names.some((name) => name.startsWith(old.id)), false);
    for (const name of leftovers) assert.equal(names.includes(name), false, name);
    assert.ok(names.includes('att-00000000000000cc.upload'));
    assert.ok(names.includes('README.txt'));
    assert.equal((await api(`/docs/${docId}/attachments/${young.id}`)).status, 200);
    // Referenced attachments stay however old they are.
    assert.equal(await sweepAttachments(referencedAttachmentIds, { now: Date.now() + 1000 * HOUR }) > 0, true);
    assert.equal((await api(`/docs/${docId}/attachments/${askedRegion.id}`)).status, 200);
    assert.equal((await api(`/docs/${docId}/attachments/${askedImage.id}`)).status, 200);
    assert.equal((await api(`/docs/${docId}/attachments/${young.id}`)).status, 404, 'unreferenced, and now old');
  });

  test('the sweeper runs at once and then on its interval, until stopped', async () => {
    const chip = await upload(OTHER);
    const metaFile = path.join(attachmentsDir(OTHER), `${chip.id}.json`);
    const sweeper = startAttachmentSweeper(referencedAttachmentIds, 20, false);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(existsSync(metaFile), 'young: kept');
      await fs.writeFile(metaFile, JSON.stringify({ ...chip, createdAt: new Date(Date.now() - 25 * HOUR).toISOString() }));
      await waitFor(() => !existsSync(metaFile), 5_000);
    } finally {
      await sweeper.stop();
    }
    const later = await upload(OTHER);
    const laterMeta = path.join(attachmentsDir(OTHER), `${later.id}.json`);
    await fs.writeFile(laterMeta, JSON.stringify({ ...later, createdAt: new Date(Date.now() - 25 * HOUR).toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(existsSync(laterMeta), 'stopped: nothing is swept any more');
  });

  test('deleting a document stops its attachment workers and removes its attachments with it', async () => {
    // A region still being made when the document is deleted: its request fails, and nothing is written again.
    const pending = createRegionAttachment(docId, { slide: 3, rect: { x: 0, y: 0, w: 1, h: 1 } });
    pending.catch(() => {});
    await waitFor(() => hasAttachmentJobs(docId), 10_000);
    const res = await api(`/docs/${docId}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    await assert.rejects(pending, (err: HttpError) => err.status === 404);
    assert.equal(existsSync(docPaths(docId).dir), false);
    assert.equal(hasAttachmentJobs(docId), false);
    await expectError(await api(`/docs/${docId}/attachments/${askedRegion.id}`), 404);
    await expectError(await postImage(docId, await png()), 404);
  });

  test('startup sweeps (a server started on a library with old unused attachments removes them)', async () => {
    const chip = await upload(OTHER);
    const metaFile = path.join(attachmentsDir(OTHER), `${chip.id}.json`);
    await fs.writeFile(metaFile, JSON.stringify({ ...chip, createdAt: new Date(Date.now() - 25 * HOUR).toISOString() }));
    await server.close();
    server = await startServer({ port: 0, log: false, resumeIngests: false, providerInfos: async () => infos, chatDeps: deps });
    base = server.url;
    await waitFor(() => !existsSync(metaFile), 10_000);
    assert.equal((await api(`/docs/${OTHER}/attachments/${chip.id}`)).status, 404);
  });
});
