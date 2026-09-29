# easy-study — handoff for the next agent

Read this first, then `README.md` (user-facing, Korean) and `docs/DESIGN.md` (the spec: §1–25, every round's contract).
Last updated: 2026-09-29 (slide annotations, DESIGN §25, built and E2E-checked in the working tree — not yet committed or
released; the last release is 0.5.3. Earlier: 0.5.0 = the in-app updater; 0.5.1 = LAN sharing from the desktop app + the
loopback proxy that lets the app record against a plain-http remote).

## Paste-ready prompt

> You are continuing work on **easy-study** (this repository; GitHub `Wooangha/easy-study`).
> Read `docs/HANDOFF.md` completely before doing anything, then `docs/DESIGN.md` §25 (slide annotations, the current work) and
> the sections it references. Current state and next steps: "Slide annotations" → "Status" in HANDOFF.md. Follow the hard rules in HANDOFF.md exactly — especially: never modify
> `library/` (the user's real study data), never send requests to the user's app on `127.0.0.1:5180`, never make
> real claude/codex model calls in tests, never trigger a real microphone permission prompt without asking the user,
> and never write this Mac's LAN IP into repo files. The user writes in Korean; answer in Korean, briefly.

## What the app is

A local study app for lecture PDFs with an LLM tutor. Left pane: the slides (rendered with PDFium-wasm to PNG/WebP).
Right pane: a chat that always knows the focused slide (+ neighbours) and feeds slide images/text to the tutor.
Tutors: the user's **Claude Code** and **Codex** CLIs (subscriptions, no API keys), plus optional Anthropic/OpenAI APIs.
Features so far: per-slide digest (정리본), courses (과목) with earlier-lecture context and groups, drag & drop library
organisation, Q&A notes as Markdown, slide-region and image attachments, remote access with an access code, a Tauri 2
desktop app (macOS arm64/x64, Windows x64, Linux x64/arm64 incl. Arch), memory-optimised server (short-lived workers).
Latest: lecture recordings (v0.4.0: record in the app or upload; local whisper.cpp; slide alignment).

The user writes short casual Korean. Keep replies in Korean, short, plain; lead with the result.

## Repository state (at the time of writing)

- `main`: released up to **v0.6.0** (slide annotations) (in-app updates from 0.5.0; LAN sharing + the loopback relay in 0.5.1). Pushed; no
  other branches. Tags v0.1.0 … v0.6.0. Releases up to v0.4.2 are drafts in the private repo (the user may publish
  them); v0.5.0 … v0.6.0 are published there AND in the public repo `Wooangha/easy-study-releases` (installers +
  latest.json, signed on this Mac with `publish-release.mjs`). `packaging/arch/PKGBUILD` + `.SRCINFO` are at 0.6.0.
- `gh` is installed and logged in. SSH push to origin works.

## Commands

```bash
npm ci                   # install (never copy node_modules between OSes)
npm run dev              # TS server + Vite middleware, http://127.0.0.1:5180 (dev only; uses ~100 MB more RAM)
npm start                # build web + dist-server, then run the compiled server (how the user studies)
npm run serve            # run the already-built dist-server
npm run start:remote     # remote mode: prints LAN URLs + access code (HTTPS needed for other devices' microphones)
npm run typecheck        # 3 tsc projects (server/tests, web, web/tests)
npm test                 # node:test, tests/*.test.ts + web/tests/*.test.ts (~800 tests, ~35 s)
npm run build            # web/dist + dist-server
npm run desktop:test     # desktop script tests
npm run desktop:build    # Tauri app for this machine (.app/.dmg on macOS), bundles Node + server (+ whisper/ffmpeg)
npm run setup:whisper    # build whisper.cpp v1.9.4 whisper-cli into .cache/whisper (for web mode)
npm run sample           # regenerate samples/sample-lecture.pdf (needs uv)
```
Rust: `cd desktop/src-tauri && cargo check`. Windows type-check from macOS uses a fake `llvm-rc` (see desktop scripts/tests).
macOS has no `timeout` command.

## Hard rules

1. `library/` (repo root, git-ignored) is the user's real data: lectures, courses, digests, sessions, notes,
   `.auth.json`. Read only. Tests and experiments use a temp `EASY_STUDY_LIBRARY`.
2. The user's app may be running on `127.0.0.1:5180` (Claude desktop preview config "app" = `npm start`). Don't send it
   requests; use other ports for your servers and stop them afterwards. `.claude/launch.json` has "app" and "dev".
3. No real claude/codex/API model calls in tests. Fakes: `tests/fixtures/fake-claude.mjs`, `fake-codex.mjs`,
   `fake-whisper.mjs`, `fake-ffmpeg.mjs` via `CLAUDE_BIN` / `CODEX_BIN` / `EASY_STUDY_WHISPER` / `EASY_STUDY_FFMPEG`.
   A few real calls for live verification are fine when clearly needed (use `haiku`, tiny prompts) — say so.
4. Never trigger the real macOS microphone permission prompt (TCC) on your own; use fake devices
   (Chrome `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>`,
   PulseAudio/PipeWire null sources in Linux Docker). Ask the user when a real mic test is due.
5. Never write this Mac's LAN IP into repo files (use `192.168.0.10`-style examples). Check before every commit:
   `git grep -n "$(ipconfig getifaddr en0)"` must be empty.
6. Server TypeScript runs natively on Node: erasable syntax only (no enums/namespaces/parameter properties), relative
   imports end in `.ts`, `import type` for types. UI copy is Korean.
7. Heavy work (sharp, PDFium, ffmpeg, whisper) runs in short-lived child processes, never in the long-lived server.
8. Don't add a `CLAUDE.md`/`AGENTS.md` at the repo root: in web mode the tutor CLIs run inside `library/<doc>` under
   the repo and would load it into the user's study sessions.
9. Disk hygiene: experiments go to a scratch/temp dir and are deleted when done; prune Docker images/build cache you
   created. (A previous session once used a lot of disk before cleanup — the user noticed.)
10. Long commands: in multi-agent runs keep single tool calls under ~2 min; run long jobs in the background with a log.

## Git / release workflow

- Branch per piece of work: `feat/*`, `fix/*`, `chore/*` from `main`; fast-forward merge into `main`; delete the branch;
  push. Contract-first for big features: commit types + a DESIGN section first, then implement.
- Commit messages end with `Co-Authored-By: <your model> <noreply@anthropic.com>` (previous agent used
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Release: bump `version` in `package.json`, `desktop/package.json`, `desktop/src-tauri/Cargo.toml` (+ lockfiles via
  `npm install --package-lock-only` and `cargo check`), commit `Release x.y.z: …`, merge, tag `vX.Y.Z`, push the tag.
  CI (`.github/workflows/desktop.yml`) runs tests → builds macOS arm64/x64, Windows x64, Linux x64/arm64 (+ smoke tests,
  Windows smoke is required; the macOS jobs also pack `easy-study_<v>_<arch>.app.tar.gz` for the updater) →
  `arch-x64` (AppImage + pacman package on Arch) → draft release in the PRIVATE repo with all installers,
  `easy-study-bin-*.pkg.tar.zst`, a PKGBUILD and the FFmpeg source. Manual run: `gh workflow run desktop.yml --ref main`.
  CI never signs anything for the updater and never sees the updater key.
  Keep the tag run fast (~12 min instead of ~25): CI caches are per git ref and a tag run can only restore main's, so
  verify a feature by running CI ON MAIN after the ff-merge (`gh workflow run desktop.yml --ref main`), not on the
  branch, then bump + tag; only main's runs save the Rust caches (`save-if`). Delete stale caches when the quota
  (10 GB, `gh cache list`) fills.
- Publishing (DESIGN §24; from 0.5.0 on, the first version with the in-app updater): users download from the PUBLIC
  repo `Wooangha/easy-study-releases` (installers only, no source), and the apps poll its
  `releases/latest/download/latest.json`. `desktop/scripts/publish-release.mjs` does it, on this Mac, only on the
  user's word:
  1. Dry run (the default; reads only, never touches the key): `node desktop/scripts/publish-release.mjs --tag vX.Y.Z`.
     It checks where the draft came from (tag commit = local tag, an ancestor of main; draft and every asset uploaded
     by `github-actions[bot]` during a successful desktop run of that tag; GitHub's sha256 digests; an allowlist of
     asset names with all required ones; the PKGBUILD's public URLs and .deb checksums; the updater config at the tag)
     and prints the asset table, the planned latest.json and the steps. Exit 1 = a real run would refuse.
  2. The user approves the public release notes (a Markdown file; its first paragraph becomes latest.json's `notes`,
     shown in the app as plain text). Never reuse CI's generated notes: they list private commit titles.
  3. Real run: `node desktop/scripts/publish-release.mjs --tag vX.Y.Z --publish --commit <sha the dry run printed>
     --notes <file.md>` (`--key` defaults to `~/.tauri/easy-study-updater.key`; `--skip-private` keeps the private
     draft a draft; `--not-latest` for an older line). It downloads the draft by asset id into `.cache/publish/<tag>`,
     checks the macOS archives (one top folder, no hard links, Info.plist version) and the Windows installer's
     ProductVersion (the AppImages are not looked into: name, CI run and digest only), signs the 5 updater artifacts with
     `tauri signer sign --app-version` (the script passes the key's path and never reads it), verifies every signature
     with the key compiled into the apps (key id, file:, version:), writes latest.json and SHA256SUMS.txt, uploads
     everything to a public DRAFT (latest.json last), publishes it, fetches latest.json and every asset URL without
     auth, then publishes the private draft. Re-running resumes (downloads and signatures are kept; uploads with the
     right digest are skipped). A published public release is never changed: if a re-run finds a difference it stops
     with "cut a new patch version" — then do exactly that.
  - Before the very first publish the public repo needs one commit (its README: downloads per OS, first-open notes
    for macOS/Windows, "소스 코드는 비공개", the FFmpeg LGPL source note). The dry run says so; it needs the user's consent.
  - Test the updater with `desktop/scripts/update-e2e.mjs` (a throwaway key made with `tauri signer generate`, a
    separate app identifier, a local endpoint on 127.0.0.1): never with the real key. On macOS also test it the way
    users get the app, together with the user (it brings up the microphone prompt; never touch
    /Applications/easy-study.app): give the old e2e copy the real quarantine value
    (`xattr -w com.apple.quarantine "$(xattr -p com.apple.quarantine /Applications/easy-study.app)" <old>/easy-study.app`),
    start it with `open` (LaunchServices, so Gatekeeper runs), allow the microphone and record a few seconds; update;
    start it again with `open`; check `xattr -lr` shows no quarantine and `codesign --verify --deep --strict` passes;
    record again and note whether macOS asks, records, or silently fails (NotAllowedError: the fix is turning
    easy-study off and on in 시스템 설정 › 개인정보 보호 및 보안 › 마이크, or `tccutil reset Microphone <identifier>`).
    Same for Local Network access to a remote LAN server.
- The updater key: `~/.tauri/easy-study-updater.key` (mode 0600), public key (id `8428B81A03E58D53`) in
  `desktop/src-tauri/tauri.conf.json` `plugins.updater.pubkey`. It exists only on this Mac and in the user's offline
  backup; never in the repo, CI, GitHub secrets or a test. Never read, print or copy it; only the publish script hands
  its path to the Tauri CLI.
  - If it is LOST: every installed app (0.5.0 and later) trusts only this key, and nothing can change that from the
    outside. No future release can then be installed in-app, ever: the apps would report a bad signature. The only
    way on is a new key in a new release that every user downloads and installs by hand from the public page. So keep
    the backup current and test that it restores.
  - If it LEAKS: whoever also gets write access to the public repo can ship code to every install. Make a new key,
    publish a release with it as fast as possible, tell users to install that one by hand, and stop using the old key.
- After a release: copy the release's `PKGBUILD` into `packaging/arch/` (its sources point at the public repo), verify
  the checksums against `gh api repos/Wooangha/easy-study/releases` digests, regenerate `.SRCINFO` in an
  `archlinux:latest` container (`makepkg --printsrcinfo`), commit on a `chore/pkgbuild-x.y.z` branch.

## Architecture map

- `server/index.ts` routes/guards/SSE; `config.ts` env/settings; `library.ts` ingest (PDF worker), docs, backfills;
  `pdf.ts` PDFium; `imageWorker.ts` sharp/PDFium child; `sessions.ts` + `chat.ts` turns; `context.ts` + `prompts.ts`
  what the tutor sees; `digest.ts`/`digestPrompt.ts` 정리본; `courses.ts` + `layout.ts` courses/groups; `attachments.ts`;
  `annotations.ts` + `annotationsRoutes.ts` slide annotations (per-slide store, summary index, SSE hub, "학생의 메모" for the
  tutor; DESIGN §25; `pdf.ts` `textLayout()` writes `text/NNN.layout.json` for the text-fitted highlights);
  `auth.ts` remote mode; `desktop.ts` + `children.ts` desktop-mode lifecycle (share mode: `EASY_STUDY_DESKTOP_SHARE`,
  `shareUrls`, exit 3 for a taken port); `shellWatch.ts` the ready line + shell watch shared by the server and the proxy;
  `proxy.ts` the desktop app's loopback proxy (`dist-server/server/proxy.js --to <http origin>`, tests/proxy.test.ts);
  `providers/*` claude/codex/APIs; `recordings/*` recording store, live protocol, ASR runner, models, ffmpeg, alignment,
  speech context.
- `web/src` React 19 app (`App.tsx`, `components/`, `hooks/`, `lib/`); `web/src/components/recording` + `lib/recording`;
  `components/annotations` + `lib/annotations` (layer, tools, memo card, question markers, the per-document store with undo)
  and `components/MemoListPanel.tsx` (the 메모 tab);
  `lib/desktop.ts` the shell bridge (pushed state incl. `share`, actions incl. `share/*`, busy wording).
- `desktop/` Tauri shell (`src-tauri/src/main.rs`, `server.rs`, `media.rs`, `share.rs` (the switch flow), `proxy.rs`
  (the proxy child's lifecycle), …), build scripts in `desktop/scripts` (`build.mjs`, `prepare.mjs`, `whisper.mjs`,
  `ffmpeg.mjs`, `asr-smoke.mjs`, `binaries.mjs`; releases and updates: `publish-release.mjs`, `release-assets.mjs`,
  `minisign.mjs`, `update-e2e.mjs`).
- `shared/types.ts` API contract; `server/internal-types.ts` server contracts; `server/assets.ts` derived-file paths.
- `packaging/arch/` PKGBUILD; `scripts/recording-fixtures/` synthetic lecture generator (see below).

## Lecture recordings (DESIGN §22, released in v0.4.0)

Decisions (all measured in spikes on an Apple silicon Mac):
- ASR: whisper.cpp v1.9.4 `whisper-cli` sidecar; default model `large-v3-turbo-q5_0` (574 MB) + Silero VAD; fast model
  `small-q5_1` (190 MB) for CPU-only machines; force `-l ko|en`; VAD on (prevents "감사합니다"-style hallucinations).
  Korean error ~1–2 % on synthetic lectures; English terms often come out in Hangul (퍼스트, 논터미널) — expected.
  M4 Metal: 13-min lecture ~65 s, 60 min ~5.6 min, RSS ~1–1.6 GB. Models download on first use, sha256-checked.
- Uploads: minimal LGPL ffmpeg (~4 MB/target, built in CI; web mode falls back to PATH ffmpeg) → `asr.wav` + `playback.m4a`.
- Live: webview `getUserMedia` → AudioWorklet → PCM s16le 16 kHz → offset-based POST chunks (tus-like, fsync before ack,
  IndexedDB buffer, resumable), SSE events with `event: ping` + client watchdog; slide-view timeline on the audio clock.
  Plain-HTTP LAN origins can't use the mic (HTTPS needed). Desktop shell: macOS Info.plist NSMicrophoneUsageDescription +
  audio-input entitlement; Linux WebKitGTK media-stream + permission handler; Windows WebView2 PermissionRequested.
- Alignment: live = slide-view timeline prior (+ strong lexical evidence), upload = local lexical DP (TF-IDF char n-grams
  + Hangul-transliteration skeleton + monotonic Viterbi), optional "AI 정밀 정렬" (hybrid DP + haiku, 84–92 % in the
  spike), manual "여기부터 p.N" markers as hard constraints. Measured end to end with the shipped ASR config
  (turbo-q5 + VAD, uploads of the synthetic L7 lecture): Korean 66–68 % of speech time on the exact slide (82 % within
  ±1), English 82 % (92–95 % within ±1); five correct "여기부터" markers raise Korean to 84 %. (The spike's 73 % Korean
  mean included runs without VAD and with the f16 model; its own turbo-q5+VAD transcripts also give 66–69 %.) A marker
  for a slide well behind where the lecture had got to (live: not beyond the timeline's furthest slide) is a jump back, not
  "slide N starts here" (align.ts). Live look backs: the student's view of an earlier slide becomes the lecture's when the
  speech meanwhile supports it (≥ 3 s) or has no rival ahead of it (≥ 6 s), or after 30 s; a shown segment whose slide this
  changes is relabelled at once (DESIGN §22 "Alignment"). The user had reported that going back to an earlier slide did
  not switch the recording's slide. The rule was chosen on a simulation of the L7 fixtures' live flow (perfect transcript)
  and checked on real whisper transcripts of the fixture audio (Korean clean/phone/far, English clean/phone; same student
  simulation): the fixture's 17→10 back-reference went from 0 % to 81–94 % (ko) / 97–100 % (en) of its segments, and the
  final exact-slide share of a followed lecture from 87–90 % to 93–96 % (ko) / 85–88 % to 92–95 % (en). Inserted
  back-references of 8–25 s went from 0 % to 53 % on average in the simulation (those with only filler speech mostly wait
  for the 30 s rule). The student's own isolated looks of 8–25 s were never taken for the lecture's; among the student's
  own excursions in a followed lecture, 1.7 % (ko) / 2.0 % (en) of the segments moved to the looked-at slide in the
  simulation (0.8 / 2.0 % before) and 3–9 % on real transcripts (1–4 % before), mostly excursions during the professor's
  own back-reference or an announcement. A first version that tolerated speech leaning slightly to the lecture slide took
  20–50 % of the student's own 15–25 s looks for the lecture's on real Korean transcripts (English terms in Hangul make
  the lexical evidence weak).
- Tutor context: speech per focus-window slide (1500 chars/slide, 4000 total) + last minutes while recording live.

Status (2026-09-28):
- Implemented, verified, merged and released (v0.4.0 draft): all of §22; typecheck clean; 806/806 tests; desktop tests
  27/27; desktop CI green on every target, including the ASR smoke (the bundle's own whisper-cli + ffmpeg on a TTS
  sentence) on macOS, Windows, Linux, the AppImage and the Arch package. Real-engine checks on the M4 with whisper-cli 1.9.4 (Metal):
  - Upload ko phone m4a (13 min): turbo 68.7 s, Hangul-only error 0.99 %; small 55 s, 4.89 %. English WER ~4.4 %.
    60-min upload 427 s. RSS peaks: whisper ~0.9 GB (turbo) / 0.6 GB (small), server ≤ 152 MB.
  - Slide alignment (upload, local DP): ko 66–68 % exact / 82 % within ±1 slide; en 82 % / 93–95 %. With "여기부터 p.N"
    markers 66–85 %. Live (timeline prior): 92.4 % exact.
  - Live E2E in headless Chrome with a fake mic: segments a few seconds behind; pause/resume, page reload and server
    restart mid-recording keep the audio byte-exact; a question during recording includes speech up to ~2 s before it.
  - 16 problems from the verification round were fixed (5-min upload timeout, marker jump-back, VAD download race,
    abandoned live recordings, stale player, first slide event, recent-speech lag, 416 Range, download errors, …).
- Still to do:
  1. The user's one real microphone test in the Mac app (they must click "Allow"; never trigger the prompt yourself).
  2. Known gaps: the recordings list doesn't pick up a live recording started on another device until the tab is
     reopened; the lexical aligner could be re-tuned on real (non-synthetic) lectures; align-ai was only tested with a
     fake provider. whisper.cpp's Silero VAD always runs 4 threads (hard-coded in `whisper_vad`): on a 2-CPU Linux
     runner the 7 s ASR smoke takes ~32 s (Windows with OpenMP: ~5 s). A one-line source patch
     (`vad_ctx_params.n_threads = params.n_threads;`) was measured to fix it but is not applied.

### Test fixtures (synthetic lectures)

`scripts/recording-fixtures/` regenerates them (macOS only: `say` voices Yuna/Samantha + ffmpeg):
```bash
FIXTURES_OUT=/tmp/easy-study-fixtures python3 scripts/recording-fixtures/tools/build.py all
```
Output: ko-mixed (13 min, Korean with English terms), en (12 min), smoke (55 s), long (60 min) with exact
`ground_truth.json` (segments → slide, a tangent, a back-reference, a skipped slide). The previous session also kept a
copy under its scratchpad (`…/scratchpad/rec/fixtures`), which may be gone. Never commit the generated audio.

## Slide annotations (DESIGN §25, in the working tree, unreleased)

What: 형광펜 (snaps to text lines), 텍스트 형광 (fitted to words from the new `text/NNN.layout.json`), 사각형, 동그라미, 텍스트 상자,
스티커 메모 (tags, links to slides/lectures/recording moments, 👁 for the tutor), 📎 첨부 of any item as a region attachment, 질문 표시
derived from the sessions (only hidden markers are stored), the 메모 tab, slide filters, ⌘Z/⌘⇧Z, live sync between devices over SSE,
"학생의 메모" in the tutor context, 그때 필기 재생 in playback. Storage: `library/<doc>/annotations/NNN.json` + `index.json`.
The user chose the wording **첨부** (not "이걸로 질문하기") and nothing is attached automatically.

Status (2026-09-29):
- Built by parallel packages (contract A, server B/C/D, web E/F) and integrated: typecheck clean (3 projects); `npm test` 1108/1108;
  `npm run desktop:test` 43/43. New suites: tests/annotations.test.ts, annotations-http.test.ts, annotations-context.test.ts,
  annotation-attachments.test.ts, textLayout.test.ts; web/tests/annotations-geometry, textSelect, annotation-history,
  annotation-markers, annotations-store, annotation-chips, memo-list, qa-jump, recording-playhead.
- Browser E2E run in the desktop app's browser pane against a temp library (one copied lecture, fake CLIs, port 5199): every flow
  of DESIGN §25 "Work plan › G" passed (draw/snap/fit, text box, memo + tag + link, collapse, delete + undo, move, 📎 첨부 → marker →
  tooltip → jump, a ✂ region question's marker, hide a marker, layer toggle, tag filter, SSE to a second tab and from a curl client,
  reload persistence, the tutor stdin with and without the memo, dark mode, 360 px). Not exercised in the browser: 그때 필기 재생 and
  🎙 links (no recording in the temp library — covered by unit tests), a link to another lecture (one document only), touch devices.
- `TEXT_ENGINE` is now 'pdfium-3': the startup backfill re-extracts every old document once (text + layouts; ~1 s per 40 pages).
- 0.6.1 (working tree, after the user's first use of 0.6.0; DESIGN §25 "As shipped (0.6.1)"): no ✂ 영역 button — a drag on empty
  area attaches a region only in the default ↖ 선택·첨부 state; existing items are selected / moved / resized / deleted with ANY tool
  active (lib/annotations/gesture.ts `hitTestItems` + `pressPlan`, web/tests/annotation-gesture.test.ts); the 👁/🙈 emoji became an inline
  SVG eye (components/annotations/icons.tsx, with the tool glyphs). README "필기와 메모" updated. Review fixes: with a tool an unselected
  rect / ellipse is hit on its outline ring only (`outlineOnly`, `slop.ring`) so a box's inside stays drawable; 텍스트 형광 on a text
  highlight re-drags it (`redraw` → `update` of its words); `--surface-raised` for the active 선택·첨부 segment (dark mode);
  constant accessible names + `aria-pressed` on the eye toggles, `role="img"` hidden markers. Not committed.
- 0.6.2 (working tree, round 3 of the user's feedback; DESIGN §25 "As shipped (0.6.2 — round 3)"): the item menu places itself from
  the items' boxes as drawn (lib/annotations/menu.ts `placeItemMenu`; a memo dragged to the slide's bottom edge gets its menu above,
  never covered); the 범위 선택 tool (`'marquee'`: a drag on empty area selects what it crosses, Shift+click / Shift+drag add and
  remove, one menu / one PATCH / one undo step per group action, a drag on any selected item moves the group); text boxes gain
  `size` (8–72 "pt on the slide", a fraction of the slide height — `SLIDE_PT_HEIGHT` 540 — scaled with the zoom through the layer's
  `--slide-h`), `font` (기본 / 명조 / 고정폭) and `bold`, memos `size` (lib/annotations/text.ts; optional, capped and validated on the
  server, `null` in a patch removes one, old files load unchanged); an unselected rect / ellipse is hit on its ring only in EVERY
  state. `npm test` 1153/1153 + the new web suites (annotation-menu, annotation-text), `desktop:test` 43/43; headless-Chrome E2E
  (a CDP script, temp library, fake CLIs, port 5209) per the DESIGN paragraph. README "필기와 메모" updated. Review fixes (DESIGN
  §25 "Review fixes (0.6.2 — round 3)"): the memo textarea refits on a size change / zoom, a group moves by one common delta
  (`groupDelta` / `moveItems`), the marquee meets a memo by its card as drawn (`memoBoxesOf`), the store sends ≤ 100 ops per PATCH
  (a big group action in several, one undo entry), group 📎 첨부 counts the free slots once (`annotationAttachPlan`, one toast), a
  memo's size field starts at its rendered size (`memoSizePt(item, shown)`), a text box's stored height includes its padding and
  border; `npm test` 1160/1160, `desktop:test` 43/43, a second headless-Chrome scenario (port 5211) 24/24 and the round-3 one
  re-run 33/34 (the memo field's start value changed on purpose). Not committed.
- Next: commit + release notes; a real-device pass on a phone-sized remote client; later ideas
  from the request: freehand pen, PDF export, exam mode.

## 0.5.1 E2E recipe (LAN sharing + the loopback proxy, on this Mac)

Unit gates first: `npm run typecheck`, `npm test` (tests/desktop.test.ts has the SHARE=1 / RESET_CODE=1 server test,
tests/proxy.test.ts the proxy against an in-process remote), `cd desktop/src-tauri && cargo test`, `npm run desktop:test`.
Then, with `<lan>` = a scratch folder (never the repo's `library/`, never `/Applications/easy-study.app` or the user's app data):
1. Build: `npm run build` → `node desktop/scripts/pack-server.mjs` (desktop/resources/server must contain
   `dist-server/server/proxy.js`; `prepare.mjs` does it too) → an overlay `<lan>/e2e.json` = `{"identifier":"dev.easystudy.desktop.e2e"}`
   → `node desktop/scripts/build.mjs --bundles app --skip-prepare --debug --tauri-config <lan>/e2e.json` (10–20 min from scratch;
   the app lands in `desktop/src-tauri/target/<triple>/debug/bundle/macos/easy-study.app`; the separate identifier gives it its
   own WebView storage, TCC and config).
2. A remote in remote mode on a temp library (a copy of ONE `library/<doc>` folder), free port, fake tools:
   `EASY_STUDY_LIBRARY=<lan>/remote-lib PORT=5377 EASY_STUDY_AUTO_DIGEST=0 CLAUDE_BIN=$PWD/tests/fixtures/fake-claude.mjs
   CODEX_BIN=$PWD/tests/fixtures/fake-codex.mjs EASY_STUDY_FFMPEG=$PWD/tests/fixtures/fake-ffmpeg.mjs
   EASY_STUDY_WHISPER=$PWD/tests/fixtures/fake-whisper.mjs node dist-server/server/index.js --remote`; the code is
   `<lan>/remote-lib/.auth.json` → `code`.
3. Proxy E2E: `<lan>/home/config/desktop.json` = `{"mode":"","port":5378,"proxyPort":5379}`, then
   `EASY_STUDY_DESKTOP_HOME=<lan>/home EASY_STUDY_DESKTOP_LIBRARY=<lan>/home/library EASY_STUDY_DESKTOP_SMOKE=1
   EASY_STUDY_DESKTOP_SMOKE_URL=http://127.0.0.1:5377 EASY_STUDY_DESKTOP_SMOKE_CODE=<code> EASY_STUDY_DESKTOP_FORCE_PROXY=1
   EASY_STUDY_DESKTOP_SMOKE_WRITE=1 EASY_STUDY_DESKTOP_SMOKE_TIMEOUT=180 <app>/Contents/MacOS/easy-study` → exit 0 and in
   `<lan>/home/logs/shell.log` a `EASY_STUDY_DESKTOP_SMOKE page {…}` line whose `url` starts with `http://127.0.0.1:5379/`,
   `auth.authenticated true`, `health 200`, `recorder {secure:true, mediaDevices:true, worklet:true}`, `ingest ok`, `stream ok`,
   `recording ok`; `proxy ready http://127.0.0.1:5379 -> http://127.0.0.1:5377` logged; afterwards `pgrep -f server/proxy.js` is
   empty and the remote's library got the smoke doc and lost it again. (With the LAN IP instead of 127.0.0.1 the macOS Local
   Network prompt may appear — only with the user present; the IP goes in the command line, never in a file.)
4. Share E2E: `desktop.json` = `{"mode":"","port":5378,"share":true}` and `EASY_STUDY_DESKTOP_SMOKE=1` (no URL) → the bundled
   server starts with SHARE, its ready line has `share.urls`, the page is `http://127.0.0.1:5378/` logged in
   (`auth.authenticated true`, `authRequired true`), every local check passes; meanwhile from a terminal
   `curl -s http://$(ipconfig getifaddr en0):5378/api/auth/status` → `{"authRequired":true,"authenticated":false}`,
   `curl -s -H "Authorization: Bearer <code>" http://<LAN IP>:5378/api/health` → 200, without the header → 401 (a macOS firewall
   prompt for `node` may appear; the loopback checks pass regardless).
5. Cleanup: kill the remote, remove `<lan>/remote-lib` and `<lan>/home`, `git grep -n "$(ipconfig getifaddr en0)"` must be empty.

## Gotchas learned the hard way

- `window.confirm()` does nothing in WKWebView → use the in-page `ConfirmDialog`. `navigator.clipboard` is missing on
  plain-HTTP origins → `web/src/lib/clipboard.ts`.
- Express `sendFile` refuses paths with dot-folders unless sent relative to their own dir (Linux app data is under
  `~/.local/share`) — use the existing helpers in `server/index.ts`.
- AppImage bundled an old `libwayland-client` → blank window on new Mesa (Arch); `desktop/scripts/appimage.mjs` strips it.
- Tauri: Finder-launched apps have a minimal PATH → the shell resolves PATH from the login shell (+ known dirs).
- The user's `claude` default model is set in `~/.claude/settings.json`; an outdated CLI fails with "Run claude update".
- Tests that spawn processes must treat zombies as dead in containers without init (see `tests/desktop.test.ts`).
- Windows whisper-cli must be built with OpenMP (`whisper.mjs`, `setup-whisper.mjs`): with MSVC, ggml's own thread pool
  busy-waits without a pause and never finishes when threads outnumber free CPUs (the VAD's 4 threads on a 2-CPU
  machine hung every transcription). `vcomp140.dll` from Visual Studio's Redist ships next to it.
- Build stamps hash text files with LF line endings (`textSha256`), and `.gitattributes` forces LF: a Windows checkout
  otherwise rejects the ffmpeg built on Linux. Multi-config CMake (Visual Studio) needs `--config Release` at build
  and install time.
- Codex reads are confined to lecture dirs via a permissions profile (`EASY_STUDY_CODEX_CONFINE=0` disables; off on Windows).
- Cookies are host-scoped, not port-scoped: the shell's own server, the loopback proxy and a second proxy for another remote
  all live on 127.0.0.1 in ONE cookie jar. The proxy therefore renames the remote's `es_session` to `es_session_<hash of
  the remote origin>` on the way in and sends only that one back (server/proxy.ts `upstreamCookie`/`downstreamSetCookie`,
  DESIGN §16) — otherwise the shell's own shared server's 30-day token would reach every remote. Keep that when touching the
  proxy, and never "fix" cookie trouble by trusting loopback in the server (loopback is never authentication).
- `share/on` and `share/reveal` from the local page are gated by a native dialog (share.rs, bridge.rs `reveal_code`); the
  chooser's switch is not. A share change made in the chooser while the server runs leaves the chooser showing after the
  restart (`AppState::stay_on_chooser`); "연결" then opens the page logged in (`server::page_url`).
- The server trusts `X-Forwarded-For/Proto/Host` from loopback peers (tailscale serve). Anything else on loopback that relays
  for a browser (the proxy) must strip them, or a spoofed `X-Forwarded-Proto: https` gets a `Secure` cookie the WebView drops.
- Never print the access code on stdout of the desktop-mode server: the shell copies stdout into server.log. The shell reads
  `<library>/.auth.json` instead; the ready line carries only `share.urls`.
- A 0.0.0.0 test-bind does not detect a 127.0.0.1 listener on the same port (SO_REUSEADDR, macOS measured) and prompts the
  firewall for the binary that binds: the server's own EADDRINUSE (exit 3) is the signal, not a probe in the shell.
- The recordings upload route drains ≤ 16 MB / ≤ 5 s before an early 413 and then closes; a client still sending beyond that
  can be reset (measured with a 24 MB body directly against the server). The proxy does the same on its side; a test of the
  413-mid-body path must stay inside the bound (tests/proxy.test.ts uses 8 MB, and a 401 on a 4 MB body for the early path).
- Node's `net.connect` never calls the `lookup` option for an IP literal: a private-address check on resolved names must check
  literals separately (server/proxy.ts does both).
- The proxy port is remembered (`proxyPort`): a new port would be a new origin and lose the WebView's localStorage there. That
  origin is shared by every relayed remote (localStorage too; the logins are kept apart by the scoped cookie above).
- tauri-plugin-opener (2.5.x) injects a click script into EVERY page by default: it catches clicks on `<a target="_blank">` to
  http(s)/mailto/tel, cancels them and calls `plugin:opener|open_url` over IPC — which no page of ours may use — so the
  update banner's "변경 사항 ↗", notes.md/digest.md and links in answers silently did nothing (no shell.log line at all).
  The plugin is built with `open_js_links_on_click(false)` (desktop.test.mjs asserts it); WebKit then asks
  `allow_main_navigation` first for such a link (target frame nil, URL only) and `new_window` for `window.open`. A
  `_blank` link to the reserved path would therefore act on macOS (Windows/Linux raise only the new-window event, which
  refuses it), so `bridge::on_action` first asks the page's `__easyStudyAskedAction(name)` whether its own `desktopAction`
  asked (a page without the hook — a remote server before 0.5.3 — gets a confirm for choose/forget-choice/cancel-update),
  and Markdown drops such hrefs as well (lib/markdownOptions.ts). Real-click checks exist for macOS only (a DYLD-inserted
  harness driving NSEvents into a test build); `new_window` logs every window it makes, so a silent link on
  Windows/Linux shows in shell.log.
- tests/desktop.test.ts's `EASY_STUDY_DESKTOP_SHARE=1` case is the only `npm test` bind on 0.0.0.0: a macOS application
  firewall asks about `node` on every run. `EASY_STUDY_TEST_NO_LAN=1` skips that case (the `desktopServerOptions` test keeps
  the contract).
- Error handlers log `req.originalUrl` without its query (`logPath`): `/login?code=` would otherwise put the access code in
  server.log when `.auth.json` cannot be written (tests/auth.test.ts checks).
