> Copied into the repo from the recording spike so the synthetic lecture fixtures can be regenerated (the audio itself is not committed).
> Requires macOS (`say` voices Yuna and Samantha), ffmpeg on PATH, Python 3, and a 24-slide lecture deck in the library
> (`EASY_STUDY_DECK`, read-only; the fixtures were written for a compilers lecture on top-down parsing). Run `python3 scripts/recording-fixtures/tools/build.py --help`
> and write the output outside the repo (e.g. a temp dir); paths below describe that output folder.

# Synthetic lecture-recording fixtures (a 24-slide parsing lecture)

These are test inputs for the lecture-recording spike: upload, local transcription, aligning transcript segments to slides, and replaying audio in sync with slides. Every file is synthetic. The lecturer's script was written for this fixture, and macOS `say` spoke it. Because the timeline was assembled sample by sample, the ground truth is exact: for any moment you can say which slide is being discussed, which slide is on screen, and what was said.

Deck: `EASY_STUDY_DECK` (a compilers lecture on top-down parsing, 24 slides). The build only reads it (`slides/NNN.png` for the videos).

## Layout

```
fixtures/
  README.md                 this file
  manifest.json             every media file with bytes, sha256, duration and ffprobe streams
  narration/
    ko-mixed.json           lecturer script: Korean with English terms (voice Yuna, rate 175)
    en.json                 same lecture in English (voice Samantha, rate 150)
  ko-mixed/
    ground_truth.json       exact GT (see the schema below)
    ko-mixed.gt.vtt         GT as WebVTT captions ("[slide N] text")
    ko-mixed.master.22k.wav lossless reference: the timebase that all GT times refer to
    ko-mixed.clean.16k.wav  clean, 16 kHz mono PCM (the ASR input format)
    ko-mixed.phone.m4a      phone voice-memo style: AAC-LC 64 kbps, 44.1 kHz mono, light room + noise
    ko-mixed.phone-far.m4a  harder phone recording: back of the room, reverberant, SNR about 18 dB
    ko-mixed.lecture.mp4    "lecture video": H.264 1280x720 10 fps slideshow, synced to GT + AAC 128k 48 kHz
    ko-mixed.lecture.webm   same video as VP9 + Opus 64k
    ko-mixed.mediarecorder.webm  audio-only Opus 48k in WebM, like a browser MediaRecorder capture
    ko-mixed.smoke.m4a / .smoke.16k.wav + ground_truth.smoke.json   first 55 s (slide 1 and 3/4 of slide 2) for CI
  en/
    ground_truth.json, en.gt.vtt, en.master.22k.wav, en.clean.16k.wav, en.phone.m4a, en.lecture.mp4, en.lecture.webm
  long/
    ko-mixed.long60.m4a     exactly 60:00 phone-style AAC 64k, ko-mixed looped with varied noise/tempo
    ko-mixed.long60.16k.wav the same 60 min as 16 kHz PCM, for timing ASR without decode cost
    ground_truth.long60.json  approximate GT (exact for tempo-1.0 loops)
  tools/
    build.py                builds everything (stdlib Python + say + ffmpeg)
    check_gt.py             checks GT boundaries against audio energy and measures SNR
    xcorr.mjs               measures a variant's time offset against the master by cross-correlation
    check_video.py          checks frame by frame that the video's slide changes match shownTimeline
    manifest.py             writes manifest.json
  _build/<lang>/segs/       per-utterance say output (NNN.say.wav), trimmed clip (NNN.trim.wav), cache key (NNN.txt)
```

## Files, durations, how made (all values measured with ffprobe)

| file | duration | size | format |
|---|---|---|---|
| ko-mixed/ko-mixed.master.22k.wav | 776.349 s (12:56) | 34.2 MB | PCM s16 22050 Hz mono |
| ko-mixed/ko-mixed.clean.16k.wav | 776.349 s | 24.8 MB | PCM s16 16 kHz mono |
| ko-mixed/ko-mixed.phone.m4a | 776.360 s | 6.3 MB | AAC-LC (aac_at) 64 kbps 44.1 kHz mono |
| ko-mixed/ko-mixed.phone-far.m4a | 776.360 s | 6.3 MB | AAC-LC (aac_at) 64 kbps 44.1 kHz mono |
| ko-mixed/ko-mixed.lecture.mp4 | 776.349 s | 16.4 MB | H.264 1280x720 10 fps + AAC 128k 48 kHz mono |
| ko-mixed/ko-mixed.lecture.webm | 776.357 s | 12.8 MB | VP9 1280x720 10 fps + Opus 64k |
| ko-mixed/ko-mixed.mediarecorder.webm | 776.357 s | 4.9 MB | Opus 48k 48 kHz mono (audio only) |
| ko-mixed/ko-mixed.smoke.m4a | 55.194 s | 0.5 MB | AAC 64k 44.1 kHz |
| ko-mixed/ko-mixed.smoke.16k.wav | 55.181 s | 1.8 MB | PCM 16 kHz |
| en/en.master.22k.wav | 720.715 s (12:01) | 31.8 MB | PCM s16 22050 Hz mono |
| en/en.clean.16k.wav | 720.715 s | 23.1 MB | PCM 16 kHz mono |
| en/en.phone.m4a | 720.725 s | 5.9 MB | AAC 64k 44.1 kHz mono |
| en/en.lecture.mp4 | 720.715 s | 15.4 MB | H.264 720p 10 fps + AAC 128k |
| en/en.lecture.webm | 720.723 s | 11.9 MB | VP9 720p 10 fps + Opus 64k |
| long/ko-mixed.long60.m4a | 3600.022 s | 29.4 MB | AAC 64k 44.1 kHz mono |
| long/ko-mixed.long60.16k.wav | 3600.000 s | 115.2 MB | PCM 16 kHz mono |

AAC files are 11 ms longer than the master because the last AAC frame is padded. The start is not shifted (see Verification).

### Pipeline (`python3 tools/build.py all`, about 3 minutes on an M4)
1. **Synthesis:** each utterance in `narration/<lang>.json` gets its own call to `say -v <voice> -r <rate> --file-format=WAVE --data-format=LEI16@22050`.
   - Korean voice: **Yuna**. Measured on single words: Yuna reads Latin words as words ("first" takes 0.57 s, the same as "FIRST"). **Eddy (한국어)** spells them letter by letter ("first" 2.30 s, "nonterminal" 3.55 s), so it was rejected.
   - English voice: **Samantha**. It was chosen over the Eloquence voices Eddy, Flo and Reed (영어(미국)) because it sounds more natural.
2. **Trimming:** each clip's leading and trailing silence is cut: 10 ms frames, a -50 dBFS threshold, and 20 ms of padding kept.
3. **Layout on one timeline, in samples:**
   - 1.2 s of silence at the start and 1.5 s at the end.
   - Gaps from a seeded RNG: 0.35-0.70 s between utterances on the same slide, 0.90-1.50 s at a slide change.
   - Explicit pauses: 3.2 s, 4.0 s, 2.5 s, 3.0 s and 5.0 s.
4. **Concatenation:** the ffmpeg concat demuxer with `-c copy`. Because this is a PCM copy, the result is sample-exact: the script asserts that the output's sample count equals the planned count.
   - The master is deterministic. Rebuilding gave the same sha256, `4be9eb57...`.
5. **Variants.** The filter chains are in `build.py`:
   - **phone:** highpass 110 Hz, lowpass 7.2 kHz, `aecho=0.85:0.55:23|47|83:0.22|0.14|0.08` (early reflections), volume 0.75. Then pink `anoisesrc` (a=0.0045) plus a 60 Hz hum, encoded with `aac_at` (the AudioToolbox encoder that iOS Voice Memos uses) at 64k.
   - **phone-far:** lowpass 6 kHz, 4-tap `aecho` up to 180 ms, volume 0.45, pink noise a=0.03.
   - **video audio:** highpass 60 Hz plus a mild echo and brown noise, at 48 kHz.
   - **video picture:** the slideshow is built from `shownTimeline` using the `slides/NNN.png` images, with an ffconcat file and `fps=10`. Slide changes are quantised to 0.1 s.
6. **long:** the ko-mixed master is looped with a 2 s gap per loop and cut at exactly 3600 s:

| loop | start | tempo | condition | measured SNR |
|---|---|---|---|---|
| 0 | 0.000 | 1.00 | phone chain, light pink noise + hum | 36.0 dB |
| 1 | 778.349 | 0.96 | brown (HVAC) noise, stronger reverb | 22.7 dB |
| 2 | 1589.046 | 1.04 | white hiss + hum, narrow band | 42.1 dB |
| 3 | 2337.535 | 1.00 | speaker farther away (-4.4 dB), louder pink noise | 23.1 dB |
| 4 | 3115.884 | 0.98 | reversed-English "babble" at -21 dB; cut mid-lecture at 3600 s | 16.9 dB |

SNR here is the RMS inside GT segments divided by the RMS inside the known pauses. The GT has 379 segments and 119 spans.

## The lecture (same structure in both languages)

- The script has 82 (ko-mixed) and 87 (en) utterances. Each utterance is one GT segment of 1.6-14.7 s.
- ko-mixed is Korean in the style of a Korean CS professor, with English terms spoken as English words: FIRST set, FOLLOW, LL(1), predictive parsing, production, nonterminal, epsilon, fixed point, TRAILER, and so on.
- Fillers such as "음...", "자, 그러면", "어..." and "Um/Uh" start some utterances.

Speech time per slide (seconds):

| slide | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 12 | 13 | 14 | 15 | tangent | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ko-mixed | 21 | 39 | 32 | 34 | 34 | 36 | 28 | 32 | 22 | 46* | 24 | 24 | 23 | 26 | 29 | 25 | 31 | 32 | 22 | 35 | 34 | 22 | 24 | 23 |
| en | 20 | 40 | 26 | 28 | 28 | 30 | 27 | 28 | 25 | 43* | 26 | 19 | 18 | 23 | 29 | 26 | 30 | 28 | 23 | 29 | 30 | 19 | 24 | 24 |

\* Slide 10's total includes the back-reference.

Special events (ko-mixed times; en times are in `en/ground_truth.json`):
- **Skipped slide 11.** The lecturer says on slide 10 "다음 장은 그냥 넘어갈게요". Slide 11 is on screen for 341.8-343.4 s with no speech. No segment has `slide: 11`.
- **Tangent, `slide: null`, 451.5-482.7 s (31.2 s).** An announcement about the programming-assignment deadline, the submission server and the midterm range. Slide 15 is on screen during it (`shownSlide: 15`).
- **Back-reference.** While on slide 17, the lecturer flips back to slide 10 for 525.9-541.3 s (`kind: "backref"`) to point at the ε line of the algorithm, then returns to 17. The slide spans run 17, 10(back), 17.
- **Pauses between slides:**

| after | ko-mixed | en |
|---|---|---|
| slide 1 | 3.2 s at 23.52 | 3.2 s at 22.33 |
| slide 6 | 4.0 s at 215.37 | 4.0 s at 190.35 |
| slide 12 | 2.5 s at 368.77 | 2.5 s at 340.25 |
| the tangent | 3.0 s at 482.68 | 3.0 s at 439.77 |
| slide 21 | 5.0 s at 694.51 | 5.0 s at 639.87 |

## ground_truth.json schema

```jsonc
{
  "variant": "ko-mixed", "lang": "ko-mixed", "whisperLanguage": "ko", "voice": "Yuna", "sayRate": 175,
  "timebase": {"sampleRate": 22050, "file": "ko-mixed.master.22k.wav"}, "duration": 776.349,
  "segments": [ { "id": 41, "start": 380.772, "end": 390.899, "startSample": 8396030, "endSample": 8619331,
                  "slide": 13,            // slide being talked about; null = off-slide tangent
                  "shownSlide": 13,       // slide on screen (differs for the tangent)
                  "kind": "narration",    // narration | tangent | backref
                  "lang": "ko-mixed", "text": "production은 2번, 1번, 0번 순서로 ..." } ],
  "slideSpans": [ { "slide": 17, "start": 512.799, "end": 524.702, "segmentIds": [56], "kind": "narration" } ],
                  // maximal runs of consecutive segments with the same slide + kind (null run = tangent)
  "shownTimeline": [ { "slide": 1, "start": 0.0, "end": 26.3 } ],   // contiguous and covers the whole file; the video follows it
  "pauses": [ { "start": 23.524, "end": 26.724, "duration": 3.2 } ],
  "events": { "skippedSlides": [11], "flips": [...], "backrefs": [...], "tangents": [...] },
  "speechSecondsPerSlide": { "1": 21.1, "null": 29.4 }, "masterSha256": "4be9eb57..."
}
```

- `text` is exactly the string given to `say`. English terms stay in Latin script, for example `LL(1)`, `FIRST of 알파`, `B i`. Normalise case and punctuation when you score ASR.
- The slide changes on screen 0.4-0.5 s before the first word on the new slide, which is how a real lecturer clicks.
- `long/ground_truth.long60.json` has the same segment fields plus `loop` and `srcId`. It also has `loops[]` (start, end, tempo, desc) and its own `slideSpans` (with `loop`). It has no shownTimeline and no pauses.

## Verification (measured)

**GT boundaries.** Command: `python3 tools/check_gt.py <lang>/ground_truth.json <lang>/<lang>.clean.16k.wav`.
- Checked for all 82 + 87 segments, plus the smoke file's 6:
  - Energy above -50 dBFS within 100 ms after `start` and within 100 ms before `end`.
  - Silence in the 250 ms before `start` and after `end`.
- Result: `boundaryFailures: []` and `loudFramesOutsideSegments: 0` (outside frames: 7523 for ko-mixed, 7637 for en, 717 for smoke).
- Caveat: with a 60 ms window, 5 en utterances that start with /f/ ("FIRST ...", "FOLLOW ...", "Fortunately") failed at 16 kHz. In the 22 kHz master the first loud frame is at +20 ms; at 16 kHz it is at +60-70 ms, because the /f/ friction noise is above 8 kHz. So at 16 kHz, energy-based onsets can trail the GT by up to about 70 ms.

**Offsets against the master.** Command: `node tools/xcorr.mjs <master> <variant> 0 1 30,300,600,700 0.3`. It uses 15 s windows at 8 kHz.
- Every variant's lag is within ±0.3 ms at all four windows, so there is no shift and no drift: clean 16k, phone m4a, phone-far m4a, lecture mp4, lecture webm, mediarecorder webm and smoke m4a.
- The AAC priming delay and the Opus pre-skip are compensated correctly by ffmpeg's edit list and pre-skip.
- Correlation: 1.0 for clean. 0.85-0.87 for phone and MediaRecorder, 0.76-0.77 for phone-far, 0.95 for the ko video and 0.91 for the en video. The en phone correlation is 0.72-0.75.

**Video sync.** Command: `python3 tools/check_video.py <lang>/ground_truth.json <video>`.
- For each of the 25 slide changes, frame `round(tc*10)-1` best matches the previous slide PNG and frame `round(tc*10)` best matches the new one.
- Result: **50/50 frames matched in all 4 videos**, with a minimum PSNR margin of 16.0 dB.
- The mid-interval PSNR against the expected slide is at least 35.6 dB.

**SNR** (speech RMS in segments over RMS inside the ≥2 s pauses; `check_gt.py --snr`):

| file | speech level | SNR |
|---|---|---|
| ko phone | -25.7 dBFS | 36.0 dB |
| en phone | -25.0 dBFS | 36.8 dB |
| ko phone-far | -27.5 dBFS | 17.9 dB |
| ko mediarecorder | -25.7 dBFS | 37.6 dB |
| ko video | -19.6 dBFS | 42.4 dB |
| en video | -18.8 dBFS | 43.2 dB |

**Long GT.** Checked with `WIN=2 node tools/xcorr.mjs ... <loopStart> <tempo>`:
- Loops 0 and 3 (tempo 1.0): lag within ±0.3 ms, correlation about 0.87, so they are exact.
- Tempo loops (atempo WSOLA): after removing the expected mid-window stretch, the residual is within about ±31 ms. The correlation is low, 0.24-0.60, so treat these times as **approximate, around ±40 ms**.

## Not verified / caveats
- **No ASR has been run yet.** No whisper build existed in the scratch area. It has not been checked by ear or by ASR that Yuna says every English term inside a Korean sentence as the intended word. `LL(1)`, for example, could be read "엘엘 원" or "엘엘 일". The single-word duration tests above are the only evidence.
- Yuna's English words have a Korean accent. That is realistic, but it is still one TTS voice: flat prosody, no disfluency beyond the scripted fillers, no overlapping speech, no student questions. **Real recordings will be harder.** Treat word error rate (WER) on these files as an optimistic lower bound.
- The audio depends on the installed voice assets and macOS version (built on macOS 26.5 25F71 with ffmpeg 8.1). Rebuilding on another Mac can give different audio. **The committed masters and their sha256 are the reference.**
- `aac_at` is only on macOS. On Linux, use `-c:a aac` instead.
- The Homebrew ffmpeg here has no soxr, so resampling uses ffmpeg's default swr.
- The video's slide changes are quantised to 0.1 s (10 fps). A real lecture video would be 25-30 fps with a webcam or pointer.
- Smoke rebuild order: `build.py smoke` needs `_build/ko-mixed/phone44k.wav`, which was deleted to save space, so run `build.py ko-mixed` first. `build.py all` does everything in order.
