#!/usr/bin/env python3
"""Build synthetic lecture-recording fixtures with exact ground truth.

Pipeline (stdlib Python + macOS `say` + ffmpeg):
  1. narration/<lang>.json  -> one `say` call per utterance -> 22.05 kHz s16 mono WAV
  2. trim each utterance's leading/trailing digital silence (10 ms frames, -50 dBFS, 20 ms pad)
  3. lay out utterances + silences on a sample-exact timeline (seeded RNG for gaps)
  4. concatenate with ffmpeg concat demuxer (PCM copy -> sample exact) -> master.22k.wav
  5. ground_truth.json (segments, slideSpans, shownTimeline, pauses, events)
  6. variants: clean 16 kHz WAV, phone-like m4a, slideshow mp4/webm, audio-only webm, VTT
  7. (--long) 60-min ko-mixed version with varied noise/tempo per loop

Usage: python3 tools/build.py [ko-mixed|en|long|smoke|all]
Env: FIXTURES_OUT (output folder, default <tmp>/easy-study-fixtures),
     EASY_STUDY_DECK (the L7 lecture folder, default <repo>/library/example-parsing-deck)
"""
import array, hashlib, json, math, os, random, shutil, subprocess, sys, tempfile, wave

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # holds narration/
REPO = os.path.dirname(os.path.dirname(SRC))
ROOT = os.environ.get("FIXTURES_OUT") or os.path.join(tempfile.gettempdir(), "easy-study-fixtures")
DECK = os.environ.get("EASY_STUDY_DECK") or os.path.join(REPO, "library", "example-parsing-deck")
SR = 22050
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"
LEAD_IN, TAIL = 1.2, 1.5
WITHIN_GAP = (0.35, 0.70)     # between utterances on the same slide
BETWEEN_GAP = (0.90, 1.50)    # at a slide change (no explicit pause)
SWITCH_BEFORE = 0.4           # slide change on screen this long before the first word
VIDEO_FPS = 10


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-4000:])
        raise SystemExit(f"command failed: {cmd[:6]}...")
    return r


def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        sr = w.getframerate()
        a = array.array("h")
        a.frombytes(w.readframes(w.getnframes()))
    if sys.byteorder != "little":
        a.byteswap()
    return sr, a


def write_wav(path, samples, sr=SR):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(samples.tobytes())


def trim(a, sr, thr_db=-50.0, frame_ms=10, pad_ms=20):
    thr = 32768 * 10 ** (thr_db / 20)
    f = int(sr * frame_ms / 1000)
    loud = []
    for i in range(0, len(a), f):
        fr = a[i:i + f]
        rms = math.sqrt(sum(x * x for x in fr) / max(1, len(fr)))
        loud.append(rms > thr)
    first = loud.index(True)
    last = len(loud) - 1 - loud[::-1].index(True)
    pad = int(sr * pad_ms / 1000)
    s = max(0, first * f - pad)
    e = min(len(a), (last + 1) * f + pad)
    return a[s:e]


def dur(path):
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    return float(r.stdout.strip())


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def r3(x):
    return round(x, 3)


# --------------------------------------------------------------------------- synth + layout
def build_lang(lang):
    spec = json.load(open(os.path.join(SRC, "narration", f"{lang}.json")))
    out = os.path.join(ROOT, lang)
    bld = os.path.join(ROOT, "_build", lang)
    segdir = os.path.join(bld, "segs")
    os.makedirs(out, exist_ok=True); os.makedirs(segdir, exist_ok=True)
    rng = random.Random(423 if lang == "ko-mixed" else 7)

    # 1-2: synthesize + trim each utterance
    utts = []  # (item_index, slide, kind, text)
    for ii, it in enumerate(spec["items"]):
        if "utts" in it:
            for t in it["utts"]:
                utts.append((ii, it["slide"], it.get("kind", "narration"), t))
    clips = []
    for k, (ii, slide, kind, text) in enumerate(utts):
        raw = os.path.join(segdir, f"{k:03d}.say.wav")
        tag = os.path.join(segdir, f"{k:03d}.txt")
        key = f'{spec["voice"]}|{spec["rate"]}|{text}'
        if not (os.path.exists(raw) and os.path.exists(tag) and open(tag).read() == key):
            run(["say", "-v", spec["voice"], "-r", str(spec["rate"]), "--file-format=WAVE",
                 f"--data-format=LEI16@{SR}", "-o", raw, text])
            open(tag, "w").write(key)
        sr, a = read_wav(raw)
        assert sr == SR, (raw, sr)
        t = trim(a, sr)
        tp = os.path.join(segdir, f"{k:03d}.trim.wav")
        write_wav(tp, t)
        clips.append((tp, len(t)))

    # 3: timeline (all in samples)
    parts = []          # (path_or_None, nsamples)
    segs = []
    shown = []          # [slide, start_s] change points
    pauses, flips = [], []
    pos = 0

    def silence(n):
        nonlocal pos
        parts.append((None, n)); pos += n

    silence(int(round(LEAD_IN * SR)))
    shown.append([1, 0.0])
    cur_shown = 1
    prev_item = None
    pending_gap = None   # ("pause", s) | ("flip", slide, s)
    ci = 0
    for ii, it in enumerate(spec["items"]):
        if "pause" in it:
            pending_gap = ("pause", it["pause"]); continue
        if "flip" in it:
            pending_gap = ("flip", it["flip"], it["dur"]); continue
        first_in_item = True
        for text in it["utts"]:
            slide, kind = it["slide"], it.get("kind", "narration")
            disp = slide if slide is not None else cur_shown
            if len(segs) == 0:
                gap = 0.0
            elif pending_gap and pending_gap[0] == "pause":
                gap = pending_gap[1]
            elif pending_gap and pending_gap[0] == "flip":
                gap = 0.5 + pending_gap[2] + 0.5
            elif first_in_item:
                gap = rng.uniform(*BETWEEN_GAP)
            else:
                gap = rng.uniform(*WITHIN_GAP)
            gap_n = int(round(gap * SR))
            gap_start = pos
            silence(gap_n)
            if pending_gap and pending_gap[0] == "pause":
                pauses.append({"start": r3(gap_start / SR), "end": r3(pos / SR), "duration": r3(gap_n / SR)})
            if pending_gap and pending_gap[0] == "flip":
                fs = math.ceil((gap_start / SR + 0.5) * VIDEO_FPS) / VIDEO_FPS
                shown.append([pending_gap[1], r3(fs)])
                flips.append({"slide": pending_gap[1], "start": r3(fs), "end": None})
                cur_shown = pending_gap[1]
            pending_gap = None
            start = pos
            if disp != cur_shown:
                sw = math.floor((start / SR - SWITCH_BEFORE) * VIDEO_FPS) / VIDEO_FPS
                assert sw >= gap_start / SR - 1e-9 or first_in_item, (sw, gap_start / SR)
                shown.append([disp, r3(sw)])
                cur_shown = disp
            path, n = clips[ci]; ci += 1
            parts.append((path, n)); pos += n
            segs.append({
                "id": len(segs), "start": r3(start / SR), "end": r3(pos / SR),
                "startSample": start, "endSample": pos,
                "slide": slide, "shownSlide": disp, "kind": kind,
                "lang": spec["lang"], "text": text,
            })
            first_in_item = False
    silence(int(round(TAIL * SR)))
    total = pos

    # 4: concat with ffmpeg (PCM copy => sample exact)
    lst = os.path.join(bld, "concat.txt")
    sil_cache = {}
    with open(lst, "w") as f:
        for path, n in parts:
            if path is None:
                if n not in sil_cache:
                    sp = os.path.join(bld, f"sil_{n}.wav")
                    write_wav(sp, array.array("h", bytes(2 * n)))
                    sil_cache[n] = sp
                path = sil_cache[n]
            f.write(f"file '{path}'\n")
    master = os.path.join(out, f"{lang}.master.22k.wav")
    run([FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", master])
    msr, m = read_wav(master)
    assert msr == SR and len(m) == total, (len(m), total)

    # 5: ground truth
    spans = []
    for s in segs:
        if spans and spans[-1]["slide"] == s["slide"] and spans[-1]["_kind"] == s["kind"]:
            spans[-1]["end"] = s["end"]; spans[-1]["segmentIds"].append(s["id"])
        else:
            spans.append({"slide": s["slide"], "start": s["start"], "end": s["end"],
                          "segmentIds": [s["id"]], "_kind": s["kind"]})
    for sp in spans:
        sp["kind"] = sp.pop("_kind")
    tl = []
    for i, (sl, st) in enumerate(shown):
        en = shown[i + 1][1] if i + 1 < len(shown) else r3(total / SR)
        tl.append({"slide": sl, "start": st, "end": en})
    # a flipped (skipped) slide stays on screen until the next change point
    for fl in flips:
        e = next(e for e in tl if e["slide"] == fl["slide"] and e["start"] == fl["start"])
        fl["end"] = e["end"]
    per_slide = {}
    for s in segs:
        k = "null" if s["slide"] is None else str(s["slide"])
        per_slide[k] = r3(per_slide.get(k, 0) + s["end"] - s["start"])
    gt = {
        "version": 1,
        "variant": lang,
        "lang": spec["lang"],
        "whisperLanguage": "ko" if lang == "ko-mixed" else "en",
        "voice": spec["voice"], "sayRate": spec["rate"],
        "deck": DECK, "deckSlides": "1-24 of 49",
        "timebase": {"sampleRate": SR, "file": os.path.basename(master),
                     "note": "start/end in seconds (ms precision); startSample/endSample exact at 22050 Hz. "
                             "All derived variants share this timeline (offset verified ~0 ms)."},
        "duration": r3(total / SR),
        "segments": segs,
        "slideSpans": spans,
        "shownTimeline": tl,
        "pauses": pauses,
        "events": {
            "skippedSlides": [f["slide"] for f in flips],
            "flips": flips,
            "backrefs": [{"fromSlide": 17, "toSlide": sp["slide"], "start": sp["start"], "end": sp["end"]}
                         for sp in spans if sp["kind"] == "backref"],
            "tangents": [{"start": sp["start"], "end": sp["end"], "shownSlide": segs[sp["segmentIds"][0]]["shownSlide"]}
                         for sp in spans if sp["kind"] == "tangent"],
        },
        "speechSecondsPerSlide": per_slide,
        "masterSha256": sha256(master),
    }
    json.dump(gt, open(os.path.join(out, "ground_truth.json"), "w"), ensure_ascii=False, indent=1)
    write_vtt(os.path.join(out, f"{lang}.gt.vtt"), segs)
    print(f"[{lang}] {len(segs)} segments, duration {total / SR:.3f}s")
    make_variants(lang, master, gt)
    return gt


def vtt_ts(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def write_vtt(path, segs):
    with open(path, "w") as f:
        f.write("WEBVTT\n\n")
        for s in segs:
            f.write(f"{s['id']}\n{vtt_ts(s['start'])} --> {vtt_ts(s['end'])}\n"
                    f"[slide {s['slide'] if s['slide'] is not None else '-'}] {s['text']}\n\n")


# --------------------------------------------------------------------------- variants
PHONE_CHAIN = ("highpass=f=110,lowpass=f=7200,"
               "aecho=0.85:0.55:23|47|83:0.22|0.14|0.08,volume=0.75")
ROOM_CHAIN = "highpass=f=60,aecho=0.9:0.8:31|67:0.10|0.05"
PHONE_FAR_CHAIN = ("highpass=f=120,lowpass=f=6000,"
                   "aecho=0.8:0.7:35|70|120|180:0.35|0.25|0.18|0.10,volume=0.45")


def mix_cmd(src, out_args, sr_out, n_out, chain, noise, hum=0.0, seed=1, extra_inputs=(), extra_mix=None):
    """src -> resample -> chain, + noise (+hum) -> exactly n_out samples."""
    d = n_out / sr_out + 1
    fc = [f"[0:a]aresample={sr_out},{chain},apad[sp]",
          f"anoisesrc=d={d:.3f}:c={noise[0]}:r={sr_out}:a={noise[1]}:s={seed}[nz]"]
    ins = ["[sp]", "[nz]"]
    if hum:
        fc.append(f"sine=f=60:r={sr_out}:d={d:.3f},volume={hum}[hum]"); ins.append("[hum]")
    if extra_mix:
        fc.append(extra_mix); ins.append("[bab]")
    fc.append(f"{''.join(ins)}amix=inputs={len(ins)}:duration=shortest:normalize=0,"
              f"atrim=end_sample={n_out}[out]")
    cmd = [FFMPEG, "-y", "-v", "error", "-i", src]
    for e in extra_inputs:
        cmd += ["-i", e]
    return cmd + ["-filter_complex", ";".join(fc), "-map", "[out]", "-ac", "1"] + out_args


def make_variants(lang, master, gt):
    out = os.path.join(ROOT, lang)
    bld = os.path.join(ROOT, "_build", lang)
    D = gt["duration"]
    # clean 16 kHz mono
    clean = os.path.join(out, f"{lang}.clean.16k.wav")
    run([FFMPEG, "-y", "-v", "error", "-i", master, "-af", "aresample=16000",
         "-ac", "1", "-c:a", "pcm_s16le", clean])
    # phone-like m4a: band-limited, early reflections, pink noise + mains hum, AAC 64k 44.1k (AudioToolbox, as iOS Voice Memos)
    phone_wav = os.path.join(bld, "phone44k.wav")
    run(mix_cmd(master, ["-c:a", "pcm_s16le", phone_wav], 44100, int(round(D * 44100)),
                PHONE_CHAIN, ("pink", 0.0045), hum=0.0015, seed=11))
    phone = os.path.join(out, f"{lang}.phone.m4a")
    run([FFMPEG, "-y", "-v", "error", "-i", phone_wav, "-c:a", "aac_at", "-b:a", "64k", "-ar", "44100",
         "-ac", "1", phone])
    # room mix at 48 kHz for the "lecture video" (lapel/room mic, milder)
    room_wav = os.path.join(bld, "room48k.wav")
    run(mix_cmd(master, ["-c:a", "pcm_s16le", room_wav], 48000, int(round(D * 48000)),
                ROOM_CHAIN, ("brown", 0.004), seed=5))
    # slideshow synced to shownTimeline
    ffc = os.path.join(bld, "slides.ffconcat")
    with open(ffc, "w") as f:
        f.write("ffconcat version 1.0\n")
        for e in gt["shownTimeline"]:
            f.write(f"file '{DECK}/slides/{e['slide']:03d}.png'\nduration {e['end'] - e['start']:.3f}\n")
        f.write(f"file '{DECK}/slides/{gt['shownTimeline'][-1]['slide']:03d}.png'\n")
    vf = f"scale=1280:720:flags=lanczos,fps={VIDEO_FPS},format=yuv420p"
    mp4 = os.path.join(out, f"{lang}.lecture.mp4")
    run([FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", ffc, "-i", room_wav,
         "-map", "0:v", "-map", "1:a", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
         "-crf", "30", "-g", "100", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1",
         "-t", f"{D:.3f}", "-movflags", "+faststart", mp4])
    webm = os.path.join(out, f"{lang}.lecture.webm")
    run([FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", ffc, "-i", room_wav,
         "-map", "0:v", "-map", "1:a", "-vf", vf, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "42",
         "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-g", "100",
         "-c:a", "libopus", "-b:a", "64k", "-ac", "1", "-t", f"{D:.3f}", webm])
    # audio-only webm/opus as a browser MediaRecorder would produce (from the phone mix)
    if lang == "ko-mixed":
        # harder phone recording: back of the room (far, reverberant, noisier)
        far_wav = os.path.join(bld, "phonefar44k.wav")
        run(mix_cmd(master, ["-c:a", "pcm_s16le", far_wav], 44100, int(round(D * 44100)),
                    PHONE_FAR_CHAIN, ("pink", 0.03), hum=0.002, seed=23))
        run([FFMPEG, "-y", "-v", "error", "-i", far_wav, "-c:a", "aac_at", "-b:a", "64k", "-ar", "44100",
             "-ac", "1", os.path.join(out, f"{lang}.phone-far.m4a")])
        os.remove(far_wav)
        mr = os.path.join(out, f"{lang}.mediarecorder.webm")
        run([FFMPEG, "-y", "-v", "error", "-i", phone_wav, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000",
             "-ac", "1", mr])


# --------------------------------------------------------------------------- 60-min long version
LOOPS = [  # tempo, noise(color, amp), hum, chain, gain, babble
    dict(tempo=1.00, noise=("pink", 0.0045), hum=0.0015, chain=PHONE_CHAIN, desc="phone chain, light pink noise + 60 Hz hum"),
    dict(tempo=0.96, noise=("brown", 0.02), hum=0.0, chain="highpass=f=90,lowpass=f=6500,aecho=0.8:0.6:40|90|140:0.3|0.2|0.12,volume=0.7",
         desc="4% slower, brown (HVAC) noise, stronger reverb"),
    dict(tempo=1.04, noise=("white", 0.0025), hum=0.003, chain="highpass=f=150,lowpass=f=5500,volume=0.8",
         desc="4% faster, white hiss + stronger hum, narrow band"),
    dict(tempo=1.00, noise=("pink", 0.012), hum=0.0, chain=PHONE_CHAIN + ",volume=0.6",
         desc="speaker farther away (-4.4 dB) and louder pink noise (lowest SNR)"),
    dict(tempo=0.98, noise=("pink", 0.004), hum=0.0, chain=PHONE_CHAIN, babble=0.09,
         desc="2% slower, reversed-English 'babble' at -21 dB + light pink noise"),
    dict(tempo=1.02, noise=("brown", 0.012), hum=0.001, chain="highpass=f=100,lowpass=f=7000,aecho=0.85:0.5:29|61:0.18|0.1",
         desc="2% faster, brown noise, light reverb"),
]
LOOP_GAP = 2.0
LONG_TARGET = 3600.0


def build_long():
    gt = json.load(open(os.path.join(ROOT, "ko-mixed", "ground_truth.json")))
    master = os.path.join(ROOT, "ko-mixed", "ko-mixed.master.22k.wav")
    en_master = os.path.join(ROOT, "en", "en.master.22k.wav")
    out = os.path.join(ROOT, "long"); bld = os.path.join(ROOT, "_build", "long")
    os.makedirs(out, exist_ok=True); os.makedirs(bld, exist_ok=True)
    R = 44100
    D = gt["duration"]
    loops, segs, off = [], [], 0
    k = 0
    while off < LONG_TARGET * R:
        cfg = LOOPS[k % len(LOOPS)]
        t = cfg["tempo"]
        n = int(round((D / t + LOOP_GAP) * R))
        p = os.path.join(bld, f"loop{k}.wav")
        chain = (f"atempo={t}," if t != 1.0 else "") + cfg["chain"]
        extra_inputs, extra_mix = (), None
        if cfg.get("babble"):
            extra_inputs = (en_master,)
            extra_mix = (f"[1:a]areverse,aresample={R},lowpass=f=4000,"
                         f"aecho=0.8:0.7:60:0.4,volume={cfg['babble']},apad[bab]")
        run(mix_cmd(master, ["-c:a", "pcm_s16le", p], R, n, chain, cfg["noise"], hum=cfg["hum"],
                    seed=100 + k, extra_inputs=extra_inputs, extra_mix=extra_mix))
        sr, a = read_wav(p)
        assert sr == R and len(a) == n, (p, len(a), n)
        for s in gt["segments"]:
            st = off / R + s["start"] / t
            en = off / R + s["end"] / t
            if en > LONG_TARGET:
                continue
            segs.append({"loop": k, "srcId": s["id"], "start": r3(st), "end": r3(en), "slide": s["slide"],
                         "kind": s["kind"], "lang": s["lang"], "text": s["text"]})
        loops.append({"loop": k, "start": r3(off / R), "end": r3(min(off + n, LONG_TARGET * R) / R),
                      "tempo": t, "desc": cfg["desc"], "file": p})
        off += n; k += 1
    lst = os.path.join(bld, "concat.txt")
    with open(lst, "w") as f:
        for L in loops:
            f.write(f"file '{L['file']}'\n")
    full = os.path.join(bld, "long44k.wav")
    run([FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
         "-af", f"atrim=end_sample={int(LONG_TARGET * R)}", "-c:a", "pcm_s16le", full])
    m4a = os.path.join(out, "ko-mixed.long60.m4a")
    run([FFMPEG, "-y", "-v", "error", "-i", full, "-c:a", "aac_at", "-b:a", "64k", "-ar", "44100", "-ac", "1", m4a])
    w16 = os.path.join(out, "ko-mixed.long60.16k.wav")
    run([FFMPEG, "-y", "-v", "error", "-i", full, "-af", "aresample=16000", "-ac", "1",
         "-c:a", "pcm_s16le", w16])
    for L in loops:
        L.pop("file")
    spans = []
    for s in segs:
        if spans and spans[-1]["slide"] == s["slide"] and spans[-1]["loop"] == s["loop"] and spans[-1]["kind"] == s["kind"]:
            spans[-1]["end"] = s["end"]
        else:
            spans.append({"loop": s["loop"], "slide": s["slide"], "kind": s["kind"], "start": s["start"], "end": s["end"]})
    json.dump({"version": 1, "variant": "ko-mixed.long60", "lang": "ko-mixed", "whisperLanguage": "ko",
               "duration": LONG_TARGET, "approximate": True,
               "note": "Loops of ko-mixed.master.22k.wav; tempo!=1 loops use ffmpeg atempo (WSOLA) so times are "
                       "scaled analytically (start/tempo) -> approximate (tens of ms). Tempo 1.0 loops are exact. "
                       "Segments past 3600 s are dropped; the last loop is cut mid-lecture.",
               "loops": loops, "segments": segs, "slideSpans": spans},
              open(os.path.join(out, "ground_truth.long60.json"), "w"), ensure_ascii=False, indent=1)
    os.remove(full)
    for L in range(len(loops)):
        os.remove(os.path.join(bld, f"loop{L}.wav"))
    print(f"[long] {len(loops)} loops, {len(segs)} segments")


def build_smoke():
    """First ~60 s of ko-mixed (slide 1 + most of slide 2) for fast CI tests."""
    gt = json.load(open(os.path.join(ROOT, "ko-mixed", "ground_truth.json")))
    allsegs = gt["segments"]
    segs = [s for s in allsegs if s["end"] <= 60.0]
    nxt = allsegs[len(segs)]["start"]
    cut = r3(min(60.0, segs[-1]["end"] + 0.8, nxt - 0.05))   # never include the next utterance's onset
    out = os.path.join(ROOT, "ko-mixed")
    phone_wav = os.path.join(ROOT, "_build", "ko-mixed", "phone44k.wav")
    run([FFMPEG, "-y", "-v", "error", "-i", phone_wav, "-af", f"atrim=end={cut}", "-c:a", "aac_at", "-b:a", "64k",
         "-ar", "44100", "-ac", "1", os.path.join(out, "ko-mixed.smoke.m4a")])
    run([FFMPEG, "-y", "-v", "error", "-i", os.path.join(out, "ko-mixed.clean.16k.wav"), "-af", f"atrim=end={cut}",
         "-c:a", "pcm_s16le", os.path.join(out, "ko-mixed.smoke.16k.wav")])
    spans = []
    for s in segs:
        if spans and spans[-1]["slide"] == s["slide"] and spans[-1]["kind"] == s["kind"]:
            spans[-1]["end"] = s["end"]; spans[-1]["segmentIds"].append(s["id"])
        else:
            spans.append({"slide": s["slide"], "start": s["start"], "end": s["end"], "segmentIds": [s["id"]], "kind": s["kind"]})
    sm = dict(gt, variant="ko-mixed.smoke", duration=cut, segments=segs, slideSpans=spans,
              shownTimeline=[dict(e, end=min(e["end"], cut)) for e in gt["shownTimeline"] if e["start"] < cut],
              pauses=[p for p in gt["pauses"] if p["end"] <= cut],
              events={"skippedSlides": [], "flips": [], "backrefs": [], "tangents": []})
    sm.pop("speechSecondsPerSlide", None); sm.pop("masterSha256", None)
    json.dump(sm, open(os.path.join(out, "ground_truth.smoke.json"), "w"), ensure_ascii=False, indent=1)
    print(f"[smoke] {len(segs)} segments, {cut}s")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what not in ("ko-mixed", "en", "smoke", "long", "all"):
        sys.exit(__doc__)
    os.makedirs(ROOT, exist_ok=True)
    print(f"output: {ROOT}\ndeck:   {DECK}", flush=True)
    if what in ("ko-mixed", "all"):
        build_lang("ko-mixed")
    if what in ("en", "all"):
        build_lang("en")
    if what in ("smoke", "all"):
        build_smoke()
    if what in ("long", "all"):
        build_long()
