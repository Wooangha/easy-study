// Transcription on the GPU (Vulkan, Windows x64 / Linux x64; DESIGN §22) with the fake whisper-cli, no GPU needed:
// which file or environment makes a GPU run (the Windows ggml module, the Linux `-vulkan` sibling, other platforms,
// EASY_STUDY_WHISPER_GPU=0), reading ggml-vulkan's device list, the device choice and `-dev`, the probe (cached,
// failing, hanging, listing devices and then hanging or crashing), runs on the GPU, a failed or stalled GPU run done
// again on the CPU with the GPU off afterwards, a run that fails on the CPU too (the GPU stays), and a run the app
// stops that leaves the GPU on.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { repoRoot } from '../server/config.ts';
import {
  configureWhisperGpu,
  detectLanguage,
  failureReason,
  gpuCommandFor,
  gpuDisabled,
  gpuState,
  parseVulkanDevices,
  pickDevice,
  probeGpu,
  runWhisper,
  usesMetal,
} from '../server/recordings/asr.ts';
import { wavHeader } from '../server/recordings/wav.ts';
import { tonesPcm } from './recordingFixtures.ts';

const FAKE_WHISPER = path.join(repoRoot(), 'tests', 'fixtures', 'fake-whisper.mjs');
const FAKE_ENV = ['FAKE_WHISPER_VULKAN_DEVICES', 'FAKE_WHISPER_GPU_PROBE', 'FAKE_WHISPER_GPU_FAIL', 'FAKE_WHISPER_GPU_RUN', 'FAKE_WHISPER_FAIL', 'FAKE_WHISPER_DELAY_MS', 'EASY_STUDY_WHISPER_GPU'];

let tmp = '';
let linuxEngine = '';
let windowsEngine = '';
let plainEngine = '';
let log = '';
let model = '';
let vad = '';
let wav = '';

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'easy-study-gpu-')));
  // Linux: the CPU engine and its Vulkan build side by side.
  await fs.mkdir(path.join(tmp, 'linux'));
  linuxEngine = path.join(tmp, 'linux', 'whisper-cli.mjs');
  await fs.copyFile(FAKE_WHISPER, linuxEngine);
  await fs.copyFile(FAKE_WHISPER, path.join(tmp, 'linux', 'whisper-cli-vulkan.mjs'));
  // Windows: one engine and the ggml Vulkan module beside it (loaded through GGML_BACKEND_PATH).
  await fs.mkdir(path.join(tmp, 'windows'));
  windowsEngine = path.join(tmp, 'windows', 'whisper-cli.mjs');
  await fs.copyFile(FAKE_WHISPER, windowsEngine);
  await fs.writeFile(path.join(tmp, 'windows', 'es-ggml-vulkan.dll'), 'fake module');
  // A build without any GPU part.
  await fs.mkdir(path.join(tmp, 'plain'));
  plainEngine = path.join(tmp, 'plain', 'whisper-cli.mjs');
  await fs.copyFile(FAKE_WHISPER, plainEngine);
  model = path.join(tmp, 'model.bin');
  vad = path.join(tmp, 'vad.bin');
  await fs.writeFile(model, Buffer.alloc(8));
  await fs.writeFile(vad, Buffer.alloc(4));
  const pcm = tonesPcm(6, [
    { start: 0.5, end: 2, hz: 400 },
    { start: 3, end: 4.5, hz: 600 },
  ]);
  wav = path.join(tmp, 'a.wav');
  await fs.writeFile(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
  log = path.join(tmp, 'whisper.log');
  process.env.FAKE_WHISPER_LOG = log;
});

afterEach(async () => {
  for (const name of FAKE_ENV) delete process.env[name];
  await fs.rm(log, { force: true });
  configureWhisperGpu();
});

after(async () => {
  delete process.env.FAKE_WHISPER_LOG;
  await fs.rm(tmp, { recursive: true, force: true });
});

interface Run {
  args: string[];
  gpu?: boolean;
}

async function runs(): Promise<Run[]> {
  const text = await fs.readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Run);
}

function transcribe(bin: string, signal?: AbortSignal) {
  return runWhisper({ bin, model, vadModel: vad, wav, outBase: path.join(tmp, 'out'), language: 'ko', threads: 2, signal });
}

describe('GPU discovery (which build has a Vulkan part)', () => {
  test('Windows: es-ggml-vulkan.dll beside the engine → the same engine with GGML_BACKEND_PATH', () => {
    const engine = path.join('/app', 'whisper', 'whisper-cli.exe');
    const dll = path.join('/app', 'whisper', 'es-ggml-vulkan.dll');
    assert.deepEqual(gpuCommandFor(engine, 'win32', (f) => f === dll, {}), { file: engine, env: { GGML_BACKEND_PATH: dll } });
    assert.equal(gpuCommandFor(engine, 'win32', () => false, {}), null);
    // Only this exact name counts (ggml itself loads ggml-vulkan.dll, which the build never ships).
    assert.equal(gpuCommandFor(engine, 'win32', (f) => path.basename(f) === 'ggml-vulkan.dll', {}), null);
  });

  test('Linux: a `-vulkan` sibling of the engine (es-whisper, whisper-cli; a script keeps its extension)', () => {
    const cases: Array<[string, string]> = [
      ['/usr/bin/es-whisper', '/usr/bin/es-whisper-vulkan'],
      ['/tmp/.mount_x/usr/bin/es-whisper', '/tmp/.mount_x/usr/bin/es-whisper-vulkan'],
      ['/r/.cache/whisper/bin/whisper-cli', '/r/.cache/whisper/bin/whisper-cli-vulkan'],
      ['/t/wrapper.mjs', '/t/wrapper-vulkan.mjs'],
    ];
    for (const [engine, sibling] of cases) {
      const e = path.join(engine);
      const s = path.join(sibling);
      assert.deepEqual(gpuCommandFor(e, 'linux', (f) => f === s, {}), { file: s, env: {} }, engine);
      assert.equal(gpuCommandFor(e, 'linux', (f) => f !== s, {}), null, `${engine} without its sibling`);
    }
    // The Windows module means nothing on Linux, and the other way round.
    assert.equal(gpuCommandFor('/usr/bin/es-whisper', 'linux', (f) => f.endsWith('es-ggml-vulkan.dll'), {}), null);
    assert.equal(gpuCommandFor('/app/whisper-cli.exe', 'win32', (f) => f.endsWith('-vulkan'), {}), null);
  });

  test('other platforms never use Vulkan; EASY_STUDY_WHISPER_GPU=0 turns it off everywhere', () => {
    for (const platform of ['darwin', 'freebsd', 'openbsd'] as NodeJS.Platform[]) {
      assert.equal(gpuCommandFor('/usr/bin/es-whisper', platform, () => true, {}), null, platform);
    }
    for (const value of ['0', 'off', 'false', 'FALSE', ' no ']) {
      assert.equal(gpuDisabled({ EASY_STUDY_WHISPER_GPU: value }), true, value);
      assert.equal(gpuCommandFor('/usr/bin/es-whisper', 'linux', () => true, { EASY_STUDY_WHISPER_GPU: value }), null, value);
      assert.equal(gpuCommandFor('/app/whisper-cli.exe', 'win32', () => true, { EASY_STUDY_WHISPER_GPU: value }), null, value);
    }
    for (const value of [undefined, '', '1', 'on']) {
      assert.equal(gpuDisabled({ EASY_STUDY_WHISPER_GPU: value }), false, String(value));
      assert.ok(gpuCommandFor('/usr/bin/es-whisper', 'linux', () => true, { EASY_STUDY_WHISPER_GPU: value }), String(value));
    }
    // Metal stays the Apple Silicon build's own acceleration.
    assert.equal(usesMetal('darwin', 'arm64'), true);
    assert.equal(usesMetal('linux', 'x64'), false);
    assert.equal(usesMetal('win32', 'x64'), false);
  });
});

describe('Vulkan device list', () => {
  test('device lines: discrete and integrated, names with parentheses, CRLF, other lines ignored', () => {
    const output = [
      'load_backend: loaded CPU backend from C:\\app\\whisper\\ggml-cpu-haswell.dll',
      'ggml_vulkan: Found 3 Vulkan devices:',
      'ggml_vulkan: 0 = Intel(R) UHD Graphics 770 (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none',
      'ggml_vulkan: 1 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2',
      'ggml_vulkan: 2 = AMD Radeon Graphics (RADV RENOIR) (radv) | uma: 1 | fp16: 1 | bf16: 0 | fp4: 0 | warp size: 64 | shared memory: 65536 | int dot: 1 | matrix cores: none',
      'load_backend: loaded Vulkan backend from C:\\app\\whisper\\es-ggml-vulkan.dll',
      'whisper.cpp version: 1.9.4',
    ].join('\r\n');
    const devices = parseVulkanDevices(output);
    assert.deepEqual(devices, [
      { index: 0, name: 'Intel(R) UHD Graphics 770', driver: 'Intel Corporation', integrated: true },
      { index: 1, name: 'NVIDIA GeForce RTX 4060 Laptop GPU', driver: 'NVIDIA', integrated: false },
      { index: 2, name: 'AMD Radeon Graphics (RADV RENOIR)', driver: 'radv', integrated: true },
    ]);
    // The first discrete GPU wins over built-in graphics listed before it; without one, the first device.
    assert.equal(pickDevice(devices)?.index, 1);
    assert.equal(pickDevice([devices[2], devices[0]])?.index, 2);
    assert.equal(pickDevice([]), null);
  });

  test('"No devices found." and output without Vulkan lines: no device', () => {
    assert.deepEqual(parseVulkanDevices('ggml_vulkan: No devices found.\nload_backend: loaded Vulkan backend from x\n'), []);
    assert.deepEqual(parseVulkanDevices('whisper.cpp version: 1.9.4\n'), []);
    assert.deepEqual(parseVulkanDevices(''), []);
  });

  test('why a run failed: the exit and the first error line of stderr', () => {
    const err = Object.assign(new Error('whisper-cli-vulkan exit code 134: x / y / z'), {
      exitCode: 134,
      signal: null,
      stderr: 'whisper_init_from_file_with_params_no_state: loading model\nwhisper_print_progress_callback: progress =  5%\nggml_vulkan: Device memory allocation of size 1073741824 failed.\nGGML_ASSERT(buf != NULL) failed\n',
    });
    assert.equal(failureReason(err), 'exit code 134: ggml_vulkan: Device memory allocation of size 1073741824 failed.');
    const crash = Object.assign(new Error('es-whisper-vulkan signal SIGSEGV: '), { exitCode: null, signal: 'SIGSEGV', stderr: 'whisper_backend_init_gpu: using Vulkan0 backend\n' });
    assert.equal(failureReason(crash), 'es-whisper-vulkan signal SIGSEGV:');
    assert.equal(failureReason(new Error('spawn EACCES')), 'spawn EACCES');
  });
});

describe('the probe (a whisper-cli run with an empty model file, with the Vulkan part)', () => {
  test('Linux: the sibling lists the devices; the discrete GPU is chosen (-dev 1); cached per engine', async () => {
    configureWhisperGpu({ platform: 'linux' });
    process.env.FAKE_WHISPER_VULKAN_DEVICES = 'Intel UHD Graphics|1;NVIDIA GeForce RTX 4060|0';
    assert.equal(gpuState(linuxEngine).pending, true, 'not probed yet');
    const first = probeGpu(linuxEngine);
    const gpu = await first;
    assert.deepEqual(gpu, {
      command: { file: path.join(tmp, 'linux', 'whisper-cli-vulkan.mjs'), env: {}, extraArgs: ['-dev', '1'] },
      device: { index: 1, name: 'NVIDIA GeForce RTX 4060', driver: 'Fake Driver', integrated: false },
    });
    assert.deepEqual(gpuState(linuxEngine), { pending: false, device: gpu?.device });
    // Cached for the server's lifetime: what the machine says later does not matter.
    process.env.FAKE_WHISPER_VULKAN_DEVICES = '';
    assert.equal(probeGpu(linuxEngine), first);
    assert.equal((await probeGpu(linuxEngine))?.device.index, 1);
    // A fresh start probes again.
    configureWhisperGpu({ platform: 'linux' });
    assert.equal(await probeGpu(linuxEngine), null);
  });

  test('Windows: the same engine with GGML_BACKEND_PATH; device 0 needs no -dev', async () => {
    configureWhisperGpu({ platform: 'win32' });
    const gpu = await probeGpu(windowsEngine);
    assert.deepEqual(gpu?.command, { file: windowsEngine, env: { GGML_BACKEND_PATH: path.join(tmp, 'windows', 'es-ggml-vulkan.dll') }, extraArgs: [] });
    assert.deepEqual(gpu?.device, { index: 0, name: 'Fake Vulkan GPU', driver: 'Fake Driver', integrated: false });
    // Built-in graphics only: chosen, marked integrated.
    configureWhisperGpu({ platform: 'win32' });
    process.env.FAKE_WHISPER_VULKAN_DEVICES = 'Intel(R) Iris(R) Xe Graphics|1';
    assert.deepEqual((await probeGpu(windowsEngine))?.device, { index: 0, name: 'Intel(R) Iris(R) Xe Graphics', driver: 'Fake Driver', integrated: true });
  });

  test('no GPU: no Vulkan part, no device, a failing or hanging probe, another platform, turned off', async () => {
    configureWhisperGpu({ platform: 'linux' });
    assert.equal(await probeGpu(plainEngine), null, 'no sibling');
    assert.deepEqual(gpuState(plainEngine), { pending: false });

    process.env.FAKE_WHISPER_VULKAN_DEVICES = '';
    assert.equal(await probeGpu(linuxEngine), null, 'No devices found.');

    configureWhisperGpu({ platform: 'linux' });
    delete process.env.FAKE_WHISPER_VULKAN_DEVICES;
    process.env.FAKE_WHISPER_GPU_PROBE = 'fail';
    assert.equal(await probeGpu(linuxEngine), null, 'exit 1');

    configureWhisperGpu({ platform: 'linux', probeTimeoutMs: 500 });
    process.env.FAKE_WHISPER_GPU_PROBE = 'hang';
    const started = Date.now();
    assert.equal(await probeGpu(linuxEngine), null, 'no answer');
    assert.ok(Date.now() - started < 5_000, `gave up after ${Date.now() - started} ms`);
    delete process.env.FAKE_WHISPER_GPU_PROBE;

    // Devices listed, then a hang or a crash before the expected stop at the model: no GPU either (every run would hang).
    configureWhisperGpu({ platform: 'linux', probeTimeoutMs: 800 });
    process.env.FAKE_WHISPER_GPU_PROBE = 'hang-after-list';
    assert.equal(await probeGpu(linuxEngine), null, 'listed, then no answer');
    configureWhisperGpu({ platform: 'linux' });
    process.env.FAKE_WHISPER_GPU_PROBE = 'crash-after-list';
    assert.equal(await probeGpu(linuxEngine), null, 'listed, then SIGABRT');
    delete process.env.FAKE_WHISPER_GPU_PROBE;

    configureWhisperGpu({ platform: 'darwin' });
    assert.equal(await probeGpu(linuxEngine), null, 'macOS');

    configureWhisperGpu({ platform: 'linux' });
    process.env.EASY_STUDY_WHISPER_GPU = 'off';
    assert.equal(await probeGpu(linuxEngine), null, 'EASY_STUDY_WHISPER_GPU=off');
    assert.equal(await probeGpu(windowsEngine), null);
  });
});

describe('runs on the GPU, and the CPU when it fails', () => {
  test('transcription and language detection use the GPU build with -dev', async () => {
    configureWhisperGpu({ platform: 'linux' });
    process.env.FAKE_WHISPER_VULKAN_DEVICES = 'Intel UHD Graphics|1;NVIDIA GeForce RTX 4060|0';
    const result = await transcribe(linuxEngine);
    assert.deepEqual(result.segments.map((s) => s.text), ['tone-400', 'tone-600']);
    assert.equal(await detectLanguage({ bin: linuxEngine, model, vadModel: vad, wav, threads: 2 }), 'ko');
    const all = await runs();
    assert.equal(all.length, 2);
    for (const run of all) {
      assert.equal(run.gpu, true);
      assert.deepEqual(run.args.slice(-2), ['-dev', '1']);
    }
    assert.ok(all[1].args.includes('-dl'));
    // Without a GPU part the same calls run the CPU engine with the arguments as always.
    configureWhisperGpu({ platform: 'linux' });
    await fs.rm(log, { force: true });
    await transcribe(plainEngine);
    const plain = await runs();
    assert.equal(plain.length, 1);
    assert.equal(plain[0].gpu, undefined);
    assert.equal(plain[0].args.includes('-dev'), false);
  });

  test('a failed GPU run is done again on the CPU at once; later runs stay on the CPU (gpuError)', async () => {
    configureWhisperGpu({ platform: 'win32' });
    process.env.FAKE_WHISPER_GPU_FAIL = '1';
    const result = await transcribe(windowsEngine);
    assert.deepEqual(result.segments.map((s) => s.text), ['tone-400', 'tone-600'], 'the CPU run gave the text');
    let all = await runs();
    assert.equal(all.length, 2);
    assert.equal(all[0].gpu, true);
    assert.equal(all[1].gpu, undefined, 'without GGML_BACKEND_PATH: Vulkan is never touched');
    assert.deepEqual(all[1].args, all[0].args, 'the same arguments');
    const state = gpuState(windowsEngine);
    assert.equal(state.device, undefined);
    assert.equal(state.error, 'exit code 134: ggml_vulkan: Device memory allocation of size 1073741824 failed.');
    // Later runs, language detection included: CPU only.
    await transcribe(windowsEngine);
    assert.equal(await detectLanguage({ bin: windowsEngine, model, vadModel: vad, wav, threads: 2 }), 'ko');
    all = await runs();
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((r) => r.gpu ?? false), [true, false, false, false]);
  });

  test('language detection falls back the same way', async () => {
    configureWhisperGpu({ platform: 'linux' });
    process.env.FAKE_WHISPER_GPU_FAIL = '1';
    assert.equal(await detectLanguage({ bin: linuxEngine, model, vadModel: vad, wav, threads: 2 }), 'ko');
    assert.deepEqual((await runs()).map((r) => r.gpu ?? false), [true, false]);
    assert.match(gpuState(linuxEngine).error ?? '', /^exit code 134: /);
  });

  test('a run that fails on the CPU too was not the GPU: the GPU stays on and the error goes to the caller', async () => {
    configureWhisperGpu({ platform: 'linux' });
    process.env.FAKE_WHISPER_GPU_FAIL = '1';
    process.env.FAKE_WHISPER_FAIL = '1';
    await assert.rejects(transcribe(linuxEngine), /failed to process audio/);
    assert.deepEqual((await runs()).map((r) => r.gpu ?? false), [true, false]);
    assert.equal(gpuState(linuxEngine).error, undefined);
    assert.equal(gpuState(linuxEngine).device?.name, 'Fake Vulkan GPU');
    await fs.rm(path.join(tmp, 'fake-whisper-failures'), { force: true });
  });

  test('a GPU run that stops printing is stopped and done on the CPU; the GPU is then off', async () => {
    configureWhisperGpu({ platform: 'linux', stallMs: 600 });
    process.env.FAKE_WHISPER_GPU_RUN = 'stall';
    const started = Date.now();
    const result = await transcribe(linuxEngine);
    assert.deepEqual(result.segments.map((s) => s.text), ['tone-400', 'tone-600']);
    assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`);
    assert.deepEqual((await runs()).map((r) => r.gpu ?? false), [true, false]);
    assert.match(gpuState(linuxEngine).error ?? '', /^no output for 1 s/);
  });

  test('a GPU run the app stops does not turn the GPU off', async () => {
    configureWhisperGpu({ platform: 'linux' });
    process.env.FAKE_WHISPER_DELAY_MS = '5000';
    const controller = new AbortController();
    const running = transcribe(linuxEngine, controller.signal);
    const deadline = Date.now() + 10_000;
    while ((await runs()).length === 0) {
      assert.ok(Date.now() < deadline, 'the GPU run did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal((await runs()).length, 1, 'not done again on the CPU');
    assert.equal(gpuState(linuxEngine).error, undefined);
    assert.equal(gpuState(linuxEngine).device?.name, 'Fake Vulkan GPU');
    delete process.env.FAKE_WHISPER_DELAY_MS;
    await transcribe(linuxEngine);
    assert.deepEqual((await runs()).map((r) => r.gpu ?? false), [true, true]);
  });

  test('a run stopped while the probe still runs ends at once', async () => {
    configureWhisperGpu({ platform: 'linux', probeTimeoutMs: 2_000 });
    process.env.FAKE_WHISPER_GPU_PROBE = 'hang';
    const controller = new AbortController();
    const running = transcribe(linuxEngine, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await assert.rejects(running, { name: 'AbortError' });
    assert.ok(Date.now() - started < 3_000);
    assert.deepEqual(await runs(), []);
  });
});
