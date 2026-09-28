// Measure the time offset of a derived fixture (m4a/mp4/webm/wav) against the reference master.
// usage: node xcorr.mjs <ref.wav> <test-file> [refOffsetSec=0] [tempo=1] [windows=60,300,600] [lagSec=0.5]
// Decodes both to 8 kHz mono float via ffmpeg, then for each window W=[t, t+15s] of the reference finds the
// lag (±lagSec) maximising normalised cross-correlation against test[t*… ]. Positive lag = test is late.
import { spawnSync } from "node:child_process";

const [ref, test, refOff = "0", tempoS = "1", winS = "60,300,600", lagS = "0.5"] = process.argv.slice(2);
const SR = 8000, WIN = Number(process.env.WIN || 15);
const decode = (f) => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
};
const a = decode(ref), b = decode(test);
const tempo = Number(tempoS), off = Number(refOff), maxLag = Math.round(Number(lagS) * SR);
const out = [];
for (const t of winS.split(",").map(Number)) {
  const s0 = Math.round(t * SR), n = WIN * SR;
  const x = a.subarray(s0, s0 + n);
  const center = Math.round((off + t / tempo) * SR);
  let best = -2, bestLag = 0;
  let ex = 0; for (let i = 0; i < n; i++) ex += x[i] * x[i];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const st = center + lag;
    if (st < 0 || st + n > b.length) continue;
    let dot = 0, ey = 0;
    for (let i = 0; i < n; i++) { const y = b[st + i]; dot += x[i] * y; ey += y * y; }
    const c = dot / Math.sqrt(ex * ey + 1e-12);
    if (c > best) { best = c; bestLag = lag; }
  }
  out.push({ t, lagMs: +(bestLag / SR * 1000).toFixed(1), corr: +best.toFixed(3) });
}
console.log(JSON.stringify({ test: test.split("/").slice(-2).join("/"), windows: out }));
