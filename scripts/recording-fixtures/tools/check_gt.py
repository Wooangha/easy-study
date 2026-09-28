#!/usr/bin/env python3
"""Check ground-truth segment boundaries against audio energy, and estimate SNR of noisy variants.

usage: check_gt.py <ground_truth.json> <audio-file> [--snr]
Decodes the audio with ffmpeg to 16 kHz mono s16. For every segment:
  onset ok  = speech energy (>-50 dBFS 10 ms frame) within the first 100 ms after `start`
  offset ok = speech energy within the last 100 ms before `end`
  gap ok    = the 250 ms before start / after end (clipped to the neighbouring gap) has no frame above threshold
(gap checks only make sense on the clean file). --snr prints speech-RMS / pause-RMS in dB (pauses >= 2 s).
"""
import array, json, math, subprocess, sys

gt = json.load(open(sys.argv[1]))
path = sys.argv[2]
snr_only = "--snr" in sys.argv
SR = 16000
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SR),
                      "-f", "s16le", "-"], capture_output=True, check=True).stdout
x = array.array("h"); x.frombytes(raw)
F = SR // 100
frames = [math.sqrt(sum(v * v for v in x[i:i + F]) / F) for i in range(0, len(x) - F, F)]
THR = 32768 * 10 ** (-50 / 20)
# 100 ms: at 16 kHz an /f/- or /s/-initial utterance can stay below -50 dBFS for ~70 ms (frication is >8 kHz)
ONSET_WIN = 0.10


def loud(t0, t1):
    a, b = max(0, int(t0 * 100)), min(len(frames), int(math.ceil(t1 * 100)))
    return any(frames[i] > THR for i in range(a, b))


def rms(t0, t1):
    a, b = int(t0 * SR), int(t1 * SR)
    seg = x[a:b]
    return math.sqrt(sum(v * v for v in seg) / max(1, len(seg)))


segs = gt["segments"]
if snr_only:
    sp = [rms(s["start"], s["end"]) for s in segs]
    pz = [rms(p["start"] + 0.3, p["end"] - 0.3) for p in gt.get("pauses", [])]
    sp_r = math.sqrt(sum(v * v for v in sp) / len(sp))
    pz_r = math.sqrt(sum(v * v for v in pz) / len(pz))
    print(json.dumps({"file": path.split("/")[-1], "speechRmsDbfs": round(20 * math.log10(sp_r / 32768), 1),
                      "pauseRmsDbfs": round(20 * math.log10(pz_r / 32768 + 1e-12), 1),
                      "snrDb": round(20 * math.log10(sp_r / (pz_r + 1e-9)), 1)}))
    sys.exit(0)

bad = []
for i, s in enumerate(segs):
    prev_end = segs[i - 1]["end"] if i else 0.0
    next_start = segs[i + 1]["start"] if i + 1 < len(segs) else gt["duration"]
    on = loud(s["start"], s["start"] + ONSET_WIN)
    off = loud(s["end"] - ONSET_WIN, s["end"])
    pre = not loud(max(prev_end, s["start"] - 0.25), s["start"] - 0.01)
    post = not loud(s["end"] + 0.01, min(next_start, s["end"] + 0.25))
    if not (on and off and pre and post):
        bad.append({"id": s["id"], "on": on, "off": off, "preSilent": pre, "postSilent": post})
# samples outside all segments that are above threshold
outside = 0; total_out = 0
k = 0
for fi, e in enumerate(frames):
    t = fi / 100
    while k < len(segs) and segs[k]["end"] < t:
        k += 1
    inside = k < len(segs) and segs[k]["start"] - 0.01 <= t <= segs[k]["end"]
    if not inside:
        total_out += 1
        outside += e > THR
print(json.dumps({"file": path.split("/")[-1], "segments": len(segs), "boundaryFailures": bad,
                  "loudFramesOutsideSegments": outside, "framesOutsideSegments": total_out}))
