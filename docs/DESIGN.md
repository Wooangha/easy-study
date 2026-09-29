# easy-study — design

Study lecture PDFs with an LLM tutor. Left: the slides (scrollable). Right: a chat that always
knows which slide you are looking at. Every Q&A is saved and can be reviewed later, grouped by slide.

```
+--------------------------------------+-----------------------------+
|  slide 6                             |  [Chat] [Notes]             |
|  ┌────────────────────────────────┐  |                             |
|  │  slide 7   (focused, outlined) │  |  Q (p.7) ...                |
|  └────────────────────────────────┘  |  A ...markdown + math...    |
|  slide 8                             |                             |
|                                      |  [📄 p.7 · 📌] [ ask...  ] ⏎ |
+--------------------------------------+-----------------------------+
```

## 1. Stack & conventions

- Node >= 22.18 (developed on Node 26). **Server is TypeScript executed natively by Node** (type
  stripping). Therefore server code must use only *erasable* TS syntax: no `enum`, no `namespace`,
  no constructor parameter properties, no `import x = require()`. Relative imports MUST include
  the `.ts` extension (`import { x } from './library.ts'`). Use `import type` for type-only imports.
- Web: Vite + React 19 + TypeScript in `web/`. Imports shared types from `../../shared/types.ts`.
- One process, one port (default `PORT=5180`, bound to `127.0.0.1`):
  - `npm run dev`: Express + Vite in middleware mode (HMR).
  - `npm start`: builds `web/dist` then Express serves it statically.
- Tests: `node --test` (`tests/*.test.ts`). Type check: `npm run typecheck`.
- External tools: none. PDFs are read by PDFium compiled to WebAssembly (`@embedpdf/pdfium`, pinned to an exact
  version, the same files on every platform; §17). Image compositing/resizing: `sharp`. Both run only in the
  short-lived worker process (§15), never in the server process. Licenses: `THIRD_PARTY_NOTICES.md`.
- Everything the user creates lives in the **library dir** (`EASY_STUDY_LIBRARY`, default
  `<repo>/library`, git-ignored).

## 2. Library layout

```
library/<docId>/
  doc.json                 DocMeta (shared/types.ts)
  source.pdf
  slides/001.png ...       full resolution, long edge 1600px (PDFium, /Rotate applied, annotations drawn)
  sheets/sheet-01.png ...  overview contact sheets, 2x2 slides per image, each cell labelled
                           with its slide number; long edge <= 1600px
  sheets/sheets.json       [{ "file": "sheet-01.png", "fromSlide": 1, "toSlide": 4 }, ...]
  text/001.txt ...         page text in content order, trimmed ('' if none; PDFium, §17)
  text/.engine             which extraction wrote text/*.txt (`pdfium-2`); missing = poppler's pdftotext (§17)
  sessions/<sessionId>.json   SessionRecord (server/internal-types.ts)
  notes/<sessionId>.md        per-session transcript (regenerated after every turn)
  STUDY_NOTES.md              all sessions' Q&A grouped by slide (regenerated after every turn)
```

- `docId` = slugified title (ascii `[a-z0-9-]`, max 40 chars, fallback `doc`) + `-` + 6 random hex.
- `sessionId` = `YYYYMMDD-HHMMSS-` + 4 random hex (sortable).
- Slide file names are 1-based and zero padded to 3 digits (`%03d`); more digits if > 999 pages.
- All writes of JSON files are atomic (write `*.tmp` then rename).

## 3. Ingest pipeline (`server/library.ts`)

`POST /api/docs` with the raw PDF bytes → write `source.pdf`, create `doc.json`
(`status: 'processing'`, `progress: 0`), respond immediately, then in the background:

0. Wait for one of `MAX_INGEST_WORKERS` worker slots (half the CPU threads, 2 to 4; §17 "Concurrency"). The ingest
   holds it through steps 1-4 and the derived images, so a multi-file upload converts a few PDFs at a time; the
   others wait in `processing` at progress 0 ("PDF 분석 중…").
1-3. One PDF worker run (`runPdfWorker`, PDFium-wasm in the worker process of §15; `server/pdf.ts`):
   - open `source.pdf` (read on demand through `FPDF_LoadCustomDocument`, never copied whole into the wasm heap) →
     page count and the size of page 1 (points, /Rotate applied) → aspectRatio; `doc.json` gets `pageCount` and
     `aspectRatio` at once, before any page is rendered;
   - per page: render at 1600px on the long edge (white background, annotations, form fields), PNG-encode with sharp while the
     next page is rasterized → `slides/%03d.png`; its text (content order, Symbol-font PUA mapped back, super- and
     subscripts kept on their line, then the text of form fields and typed notes, §17) →
     `text/%03d.txt` (trimmed); `progress` = slides written, stored in `doc.json` at most every 400 ms (and for the
     last page);
   - finally `text/.engine`.
4. Build contact sheets with sharp: groups of 4 consecutive slides, 2 columns x 2 rows, each cell
   800px wide (height by aspect, the cell shape kept between 1:4 and 4:1: more extreme slides are letterboxed), 8px
   white gutter, and a readable label "Slide N" (dark badge, top-left; an SVG overlay composited by sharp whose glyphs
   are stroke paths, not `<text>`: no font needed, the same pixels on every system — on one without any font,
   `<text>` came out as boxes and the model could not read the slide numbers). Write `sheets.json`.
5. `status: 'ready'` (or `'error'` with `error` message: `the PDF is password protected`, `could not read the PDF:
   the file is damaged or is not a PDF`, … — readable, no tool to install).

On server start, any doc left in `processing` (crash mid-ingest) is re-processed.

## 4. HTTP API (`server/index.ts`)

All JSON. Errors: HTTP 4xx/5xx with `{ "error": string }` (plus machine-readable fields where noted, e.g.
`missingAttachments`, §21). Ids validated with `DOC_ID_RE` /
`SESSION_ID_RE` (404 when invalid or missing — never touch the filesystem with an unvalidated id).

| Method & path | Body | Response |
|---|---|---|
| GET `/api/health` | – | `HealthResponse` (with the server's `version` from package.json, §24) |
| GET `/api/desktop/busy` | – | `DesktopBusyResponse`: desktop mode only (404 otherwise), for the shell before an update or a share restart (§24): the live recording (ids, status, its and its lecture's titles) and counts of transcriptions, 정리본 calls, answers and model downloads; no paths or content, `no-store`; behind the login like every /api route when the desktop server is shared (the shell sends the bearer code) |
| GET `/__easy-study-desktop/*` (not under /api) | – | 204 in every mode: a desktop page action the shell did not intercept leaves the page where it is (§8, §24) |
| GET `/api/docs` | – | `DocMeta[]` newest first |
| POST `/api/docs` | raw PDF bytes, `Content-Type: application/pdf`, header `X-Filename` (URI-encoded original name) | `DocMeta` (201). Max 300 MB. Rejects non-`%PDF` bodies (400). |
| GET `/api/docs/:docId` | – | `DocMeta` |
| GET `/api/docs/:docId/slides/:n.png` | – | PNG (`Cache-Control: public, max-age=31536000, immutable`) |
| GET `/api/docs/:docId/sessions` | – | `SessionSummary[]` newest first |
| POST `/api/docs/:docId/sessions` | `CreateSessionRequest` | `Session` (201). 400 if provider unknown/unavailable, or the effort is not one the model supports (§6). |
| GET `/api/docs/:docId/sessions/:sid` | – | `Session` |
| DELETE `/api/docs/:docId/sessions/:sid` | – | 204 (also removes its notes file and regenerates STUDY_NOTES.md) |
| POST `/api/docs/:docId/sessions/:sid/prime` | `PrimeRequest` | SSE stream (see below) |
| POST `/api/docs/:docId/sessions/:sid/messages` | `SendMessageRequest` | SSE stream |
| POST `/api/docs/:docId/sessions/:sid/abort` | – | 204 (aborts the running turn, if any) |
| GET `/api/docs/:docId/notes` | – | `NotesResponse` |
| GET `/api/docs/:docId/notes.md` | – | `text/markdown` STUDY_NOTES.md |

SSE: response headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`X-Accel-Buffering: no`; each frame `event: <type>\ndata: <json>\n\n` where json is a `StreamEvent`
(the `type` field is repeated inside data). A `: ping\n\n` comment every 15 s while running.
Validation failures that happen before the turn starts are sent as a normal HTTP 4xx JSON error,
not SSE (the client checks `res.ok` and the content type). Only one turn may run per session:
a second request while one is running gets 409.

If the client disconnects mid-stream, the turn is aborted (child process killed) and the assistant
message is saved with status `aborted` and whatever text was received.

## 5. Context strategy (`server/context.ts`) — the core

Goal from the user: *feed all slides to the LLM first; then with every question re-feed the focused
slide together with the question; don't re-send slides that were sent recently.*

A **session** (ours) owns one **provider conversation** at a time (Claude Code session id, Codex
thread id, OpenAI response chain, or an Anthropic message history). `buildTurn()` is a **pure
function** of (`doc`, `session`, `kind`, `question`, `slide`, `settings`, `maxImagesPerConversation`):

```
state = session.providerState
focusCost = (slide ∈ state.recentSlides && state.primed) ? 0 : 1
needsPrime = !state.primed
rollover   = state.primed && state.imagesSent + focusCost > maxImagesPerConversation
if needsPrime || rollover:
    start a NEW provider conversation (resume = null, history = [])
    parts  = PRIMING(doc)                             // see below
    if rollover: parts += RECAP(last settings.recapTurns complete Q&A pairs of session.messages)
    parts += FOCUS(slide, withImage = true)
    next.imagesSent = sheets.length (if primeWithImages) + 1
    next.recentSlides = [slide]; next.generation = state.generation + 1; next.primed = true
    next.history = []
else:
    resume = state.resume, history = state.history
    if slide ∈ state.recentSlides:
        parts = FOCUS(slide, withImage = false)       // "you already have slide N's image above"
        next.recentSlides = move slide to front
    else:
        parts = FOCUS(slide, withImage = true)
        next.recentSlides = [slide, ...rest].slice(0, recentWindow); next.imagesSent += 1
parts += QUESTION(kind, question)
```

- **PRIMING(doc)**: a text header (deck title, page count, how the following material is labelled),
  then for every contact sheet: a text line `Overview image: slides a–b` followed by the sheet image
  (`detail: 'low'`); then the extracted text of *every* slide as `### Slide N\n<text>` (per-slide cap
  `maxSlideTextChars`, whole dump cap `maxPrimeTextChars`, truncation marked with `…[truncated]`;
  empty text → `(no extractable text — see the image)`). Finally a note that full-resolution slide
  images live in `slides/NNN.png` relative to the working directory (agentic CLIs may open them
  with their file tools when they need a slide they have not been shown).
  If `primeWithImages` is false, sheets are skipped.
- **FOCUS(slide, withImage)**: `The student is currently looking at slide N of M.` + (with image)
  `Full-resolution image of slide N:` + image part (`detail: 'high'`) + the slide's extracted text; or
  (without image) `(Slide N's full-resolution image was already provided earlier in this conversation.)`.
- **QUESTION**: kind `question` → `Student's question (about slide N):\n<question>`.
  kind `prime` → an instruction to reply with a short overview of the deck (3–6 bullet points,
  one line each, in Korean unless the deck is clearly for another language) and to say it is ready for questions.
- **RECAP**: `Earlier in this study session (summary of previous Q&A):` + for each pair
  `- (slide N) Q: … / A: …` with each Q and A truncated to ~600 chars.
- The **system prompt** (`server/prompts.ts`) makes the model a patient tutor: answer in the
  language of the question (Korean by default), ground explanations in the slides and cite them as
  `(p.N)`, describe diagrams/figures/equations in the images, clearly mark information that is not
  from the slides, use Markdown and LaTeX math (`$...$`, `$$...$$`), and never modify files.
  For providers without a system prompt channel (Codex CLI) the system prompt is prepended to the
  first turn's text by the provider adapter.

`ContextInfo` returned to the client describes what was sent: `primed`, `rollover`,
`attachedSlides`, `reusedSlides`, `overviewImages`.

`appendHistory(state, parts, answerText)` (also in context.ts) returns state with the user turn and
the assistant answer appended to `history` — used only for stateless providers (`anthropic-api`).

Settings defaults (overridable with env): `recentWindow=4` (`EASY_STUDY_RECENT_WINDOW`),
`primeWithImages=true` (`EASY_STUDY_PRIME_IMAGES=0` to disable), `maxPrimeTextChars=60000`,
`maxSlideTextChars=2500`, `recapTurns=6`.

### Turn orchestration (`server/chat.ts`)

1. Validate (session exists, provider available, slide in range, text non-empty for questions,
   no running turn → else 409).
2. `buildTurn(...)`. Create the user message (with `context`) and an assistant placeholder
   (`status: 'streaming'`), append both to the session, persist, emit `start`.
3. `provider.run(...)` streaming `delta` / `status` events (and `usage`, §23).
4. On success: assistant `status: 'complete'`, `text` = result text, `durationMs`; providerState =
   `nextState` with `resume` from the result (and `appendHistory` for stateless providers).
   On failure: `status: 'error'` + `error`; on abort: `status: 'aborted'`. In both cases the
   providerState is **not** advanced (so the next turn re-primes if priming failed). In every case the
   turn's token usage goes to the assistant message and the session's totals (§23).
5. Persist session, regenerate `notes/<sid>.md` and `STUDY_NOTES.md`, emit `done`.

## 6. Providers (`server/providers/*`)

All CLI invocations use `child_process.spawn` with an argument array (never a shell), `cwd` = doc
dir, stdin piped, stdout parsed as JSONL (ignore non-JSON lines), stderr captured (last 4 KB used for
error messages). Abort → SIGTERM, then SIGKILL after 3 s. Remove `CLAUDECODE` from the child env.

### claude-code (Claude subscription via Claude Code CLI) — verified with claude 2.1.x

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --system-prompt <systemPrompt> --tools Read,Glob,Grep --strict-mcp-config
       [--model <model>] [--effort <level>]  ( --session-id <new uuid> | --resume <cliSessionId> )
stdin: one line {"type":"user","message":{"role":"user","content":[
         {"type":"text","text":"..."},
         {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}} ]}}
       then close stdin.
```
stdout events: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}`
→ onDelta (insert `\n\n` between separate text blocks); `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{…}}]}}`
→ onStatus; final `{"type":"result","subtype":"success","is_error":false,"result":"…","session_id":"…"}`.
`is_error: true` or non-zero exit → error. Models: `''` (CLI default), `sonnet`, `opus`, `haiku`, `fable`.
Reasoning effort (`--effort`, on every call incl. resumes): `low` · `medium` · `high` · `xhigh` · `max` (as
`claude --help` lists them); Haiku gets none (`efforts: []`). maxImagesPerConversation: 48 (round 4; was 90).

### codex (ChatGPT subscription via Codex CLI) — verified with codex-cli 0.154

```
new:    codex exec --json --skip-git-repo-check [--ephemeral] -C <cwd> <policy> <hardening> [-m <model>]
        [-c model_reasoning_effort="<level>"] [-i <img> ...]          (prompt on stdin, no positional prompt)
resume: codex exec resume <threadId> - --json --skip-git-repo-check <policy> <hardening>
        [-m <model>] [-c model_reasoning_effort="<level>"] [-i <img> ...]   (the positional "-" = read prompt from stdin)
policy: -c sandbox_mode="read-only"          (fallback for CLIs without permission profiles)
        -c default_permissions="easy_study_readonly"
        -c permissions.easy_study_readonly.filesystem={":minimal"="read","<cwd>"="read","<extraReadDir>"="read",…}
        -c approval_policy="never" -c approvals_reviewer="user" -c project_root_markers=[]
hardening: -c features.<plugins|apps|browser_use|computer_use|in_app_browser>=false,
        -c mcp_servers.<name>.enabled=false per MCP server of config.toml; allowTools=false (digest) also
        -c features.<shell_tool|unified_exec|view_image|code_mode_host|multi_agent|image_generation>=false
```
Read confinement: the legacy read-only sandbox can read every file of the user, so reads are confined by a
permissions profile to the document dir + the course's other lectures (`extraReadDirs`) + the platform's
minimal system paths; no writes (Codex still allows /tmp), no network, escalation requests rejected (a user
config with `approvals_reviewer = "auto_review"` would otherwise let `codex exec` ask to run commands outside
the sandbox). The CLI is spawned by its real path (it re-executes itself inside the sandbox, which fails
through a symlink outside the readable roots) and `project_root_markers=[]` stops the AGENTS.md walk up to a
repository root the sandbox cannot read. `EASY_STUDY_CODEX_CONFINE=0` (and Windows) → the old
`--sandbox read-only` without the profile. Verified with codex-cli 0.154 (`codex sandbox`, `codex debug prompt-input`).
Images cannot be interleaved with text, so the adapter replaces each image part with a marker
`[Attached image #k: <label>]` in the text and passes the files with `-i` in the same order.
On a new conversation the system prompt is prepended to the text (`<instructions>…</instructions>`).
stdout events: `{"type":"thread.started","thread_id":"…"}`; `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`
(→ onDelta, whole message at once; join multiple with `\n\n`); `item.started` of `command_execution` /
`reasoning` → onStatus; `{"type":"turn.completed","usage":{…}}`; `turn.failed` / `error` → error.
Models (`server/providers/codexCatalog.ts`): detect() reads the CLI's model catalog with `codex debug models` (refreshed
from the account's catalog; no inference), falling back to `codex debug models --bundled` (offline) when that fails or
takes over 4 s. Options: `''` = "Codex 설정 기본값" (named after config.toml's root `model` when set, e.g.
"Codex 설정 기본값 (GPT-6-Astra)"), then the models with `visibility: "list"` by `priority` (label `display_name`,
tooltip `description`); plus free text. Each model carries its `supported_reasoning_levels` as `efforts`; the provider's
levels (ProviderInfo.efforts) are those of all listed models (+ the config's model), weakest first
(`low · medium · high · xhigh · max · ultra` on codex-cli 0.154), with the catalog's descriptions. The default option
takes the config model's levels, else the levels every listed model supports. The catalog is cached per CLI path +
version for 30 min, then re-read in the background (the old one is served meanwhile), so only the first health check
of a CLI waits for it. A CLI without `debug models` (or an unreadable catalog) → the default option only, no effort
choice. maxImagesPerConversation: 90.

### anthropic-api (needs `ANTHROPIC_API_KEY`; honours `ANTHROPIC_BASE_URL`)
`@anthropic-ai/sdk` streaming Messages API; stateless (sends `history` + current parts every turn);
images as base64 blocks; `cache_control: {type:'ephemeral'}` on the last block of the first (priming)
user turn and on the last block of the current turn. Default model `claude-sonnet-5`.
Models: `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001`. maxImagesPerConversation: 90.

### openai-api (needs `OPENAI_API_KEY`)
`openai` SDK Responses API with streaming, `instructions` = system prompt every turn,
`previous_response_id` for continuation, images as `input_image` data URLs with `detail`.
Default model from `OPENAI_MODEL` or `gpt-5`. maxImagesPerConversation: 150.

`GET /api/health` reports availability: CLI providers run `<cli> --version` (cached 60 s; Codex also its model
catalog, above); API providers check the env key.

Every provider reports the tokens of a call (`onUsage`) and, the subscription CLIs, their usage limits (`onLimits`):
where each one finds them is in §23.

### Model and reasoning effort choice
ProviderInfo: `models` (ModelOption `{id, label, description?, efforts?}`; `efforts` omitted = every level of the
provider, `[]` = none) and `efforts` (EffortOption `{id, label, description?}`, Korean labels from
`EFFORT_LABELS`: 낮음 · 보통 · 높음 · 매우 높음 · 최대 · 울트라). Only the CLI providers list efforts; the API providers
have no effort choice. POST /sessions and POST /digest take `effort` ('' / omitted = the CLI's default: nothing is
passed); it must be one of the provider's levels and, for a listed model, one it supports (400 otherwise; a model typed
in by hand may take any level). The session record keeps `effort` (absent = default, as in sessions made before) and
every turn of the session passes it — new conversations, resumes, re-primes after a rollover or a lost conversation;
assistant messages carry it (`ChatMessage.effort`) and the notes name it ("Claude Code (opus, effort high)"). A digest
started by a session (DESIGN §11) or by POST /digest keeps its `effort` in digest.json for every batch and the lecture
summary. The recordings' AI alignment (§22) takes no effort: it runs with the CLI's default (Claude Code on Haiku).
Web: the top bar "새 세션" picker shows a compact "추론" select after the model select for providers with levels
("추론 기본값" first, the model's levels, catalog descriptions as tooltips; disabled for a model without levels). The
choice `{provider, model, effort}` is stored in localStorage; a choice stored before efforts existed reads as 기본값,
and a level the (new) model does not support falls back to 기본값.

## 7. Notes (review later) (`server/sessions.ts`)

`notes/<sid>.md`:
```
# <doc title> — <session title>
- Provider: Claude Code (sonnet) · Started: 2026-09-23 15:40

---
## p.7 · 15:42
![slide 7](../slides/007.png)          <- only the first time a slide appears in this file

**Q.** question text

answer markdown

```
`STUDY_NOTES.md`: `# <doc title> — study notes`, then for every slide with entries (ascending):
`## Slide N`, the slide image (`slides/NNN.png`), then each entry `### Q. <first line of question>`
followed by `> <session title> · <provider> · <time>`, the full question if multi-line, and the answer.
Prime turns are excluded from notes. Error/aborted answers are shown as `_(answer failed: …)_`.

## 8. Web UI (`web/`)

- **Top bar**: app name, document picker (dropdown of library docs + "＋ PDF 추가"), session picker
  for the doc (dropdown: title · provider · #messages, "＋ 새 세션"), provider/model selector used
  for new sessions, link to open `notes.md`.
- **Empty state / library**: big drop zone ("PDF를 끌어다 놓거나 클릭해서 업로드") + list of docs.
  While a doc is processing show a progress bar (`progress / pageCount`, poll `GET /api/docs/:id` every 800 ms).
- **Split view** with a draggable divider (default 58% / 42%, persisted in localStorage).
- **Slide viewer (left)**: vertical scroll of all slides (`<img loading="lazy">`, box reserved with
  `aspect-ratio`), slide number label, badge with the number of saved Q&As for that slide (click → Notes tab
  filtered to that slide). **Focused slide = the slide intersecting the vertical center of the scroll
  container** (fallback: the most visible one); computed on scroll with rAF throttling; outlined.
  Keyboard (when focus is not in a text field): `j`/`↓`/`PageDown` next slide, `k`/`↑`/`PageUp` previous
  (smooth-scroll the target slide to the center). Zoom: fit width (default) with −/＋ buttons.
  Remember the scroll position (slide number) per doc in localStorage.
- **Chat (right)**, tabs **채팅 | 노트**:
  - Chat header: current slide `p.7 / 42`, 📌 pin toggle (when pinned, the question target stays on the
    pinned slide even when scrolling), provider badge of the session.
  - Messages: user bubbles show a `p.N` chip (click → scroll viewer to slide N) and a tiny context
    line (`📚 전체 슬라이드 전달`, `🖼 p.7 이미지 첨부`, `↺ p.7 이미 전달됨`, `🔄 새 대화로 이어감`).
    Assistant messages render Markdown (GFM tables, code) with KaTeX math; while streaming show a
    blinking cursor and the latest `status` line; error/aborted states are visible. Prime messages
    render as a compact system card ("📚 전체 슬라이드 N장을 LLM에게 전달했어요") followed by the overview answer.
  - Composer: textarea (Enter = send, Shift+Enter = newline, IME-safe: ignore Enter while
    `isComposing`), send / stop button, quick prompts: "이 슬라이드 설명해줘", "핵심만 요약",
    "예시로 설명", "시험 문제 내줘".
  - When a new session is created the client immediately calls `/prime` (feeds the deck) and shows it.
    If the user sends before priming is done the input is disabled (server would 409 anyway).
  - **Notes tab**: `GET /api/docs/:id/notes` rendered grouped by slide (slide thumbnail + Q/A cards,
    collapsible), filter "현재 슬라이드만", button to open the raw STUDY_NOTES.md; path shown so the user
    knows where the file lives.
- Korean UI copy. Light/dark via `prefers-color-scheme`, or forced by the 화면 테마 setting (below). No external CDNs
  (everything bundled).

### Settings, theme and the desktop bridge (the web half of §24)
- **⚙ 설정** (web/src/components/SettingsDialog.tsx): the last button of the top bar, at the right end of whichever line
  it lands on (`margin-left: auto`: the bar wraps at the app's default 1280 px; on phones in the top right corner of
  the first line), with a dot while the desktop app has an update waiting. A modal `<dialog>` like ConfirmHost (Esc, the
  backdrop and ✕ close it, focus returns; keys pressed in it do not reach the app's shortcuts), so the open lecture stays
  mounted. Sections 화면 · 공부 · 녹음 · 데스크톱 앱 (only when `window.__EASY_STUDY_DESKTOP__` exists) · 정보, stacked;
  from 800 px a list on the left jumps to them and follows the scrolling. While it is open it shows the toasts (the
  page's own Toaster is under the modal's backdrop).
  - 화면: 테마 (시스템 설정 따르기 / 라이트 / 다크) as a radio group. 공부: ±N (useNeighbors is a small shared store, so
    the chat panel's ±N and this select show the same value; web/tests/settings-stores.test.ts covers it and the theme
    store). 녹음: `<AsrSettings>` with its own `useAsrStatus` (loaded
    while open) and "녹음 안내 다시 보기" (clears `easy-study:recordingConsent`). 정보: the server's version
    (`/api/health` `version`; a remote server older than the app — or without a version — gets a hint), the library
    folder (copy button), the keyboard shortcuts.
  - 데스크톱 앱: version and update status line, 업데이트 확인 / 업데이트하고 다시 시작 / 다운로드 페이지 열기 (install
    'download' kinds, with a found version or in phase error, e.g. after an update that did not take), the
    release notes as plain text (`<details>`), "연결: 이 컴퓨터 / 다른 컴퓨터 ({origin})", "시작할 때: …",
    연결 대상 바꾸기… (a confirmDialog first when the page records, still sends audio, answers or uploads) and 다음 실행
    때 선택 화면 보기 (only when the connection starts automatically). Then, only when `connection.kind === 'local'`
    and the push has `share` (§16 "Desktop share mode"): **다른 기기에서 접속** — the checkbox "다른 기기에서 접속 허용
    (같은 네트워크, 접속 코드 필요)" (disabled with `shareBlockReason(busy)` while audio could be cut off; `shareWarning`
    → confirmDialog "서버를 다시 시작할까요?" for answers/uploads; then `share/on` | `share/off`), a hint that the switch
    restarts this computer's server and what the code grants, and while `share.on` with addresses: the list "다른 기기에서
    열 주소" (`<code>` + 복사 via `copyText`, a name URL marked "(같은 네트워크에서 이름이 풀릴 때만)"), "접속 코드
    <code>" + 복사 when the shell pushed `share.code`, otherwise a 보기 button (`share/reveal`) and the note that the
    chooser's ⚙ 앱 설정 shows it, "접속 코드 새로 만들기 (모든 기기 로그아웃)" (`resetCodeConfirm` → `share/reset-code`,
    same gate), and the firewall / app-to-app recording / HTTPS-for-tablets / cookie note. `share.on` without addresses:
    "서버를 다시 시작하면 주소가 나와요."
- **Theme** (web/src/lib/theme.ts, web/public/theme-boot.js): styles.css keeps the light tokens on `:root` and the dark ones
  twice, identically — under `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` and under
  `:root[data-theme='dark']` — plus `color-scheme` for a forced theme; the same for `--rec`. highlight.js's GitHub theme
  colors are `--hl-*` tokens (the media-conditioned theme imports are gone; BSD-3-Clause, THIRD_PARTY_NOTICES.md).
  web/tests/theme.test.ts checks the two blocks, the tokens against highlight.js's files, and theme-boot.js in node:vm.
  - Browser: localStorage `easy-study:theme` (JSON like every storage.ts item; absent = system). theme-boot.js, a classic
    script first in `<head>` (not inline, so a `script-src 'self'` CSP stays possible), sets `data-theme` and the root's
    inline `color-scheme` before the first paint; other tabs follow through the `storage` event. applyTheme also sets both
    theme-color metas to the forced theme's top bar color (#ffffff / #161920), restoring them for 시스템 설정.
  - App: the setting is the shell's (desktop.json `theme`). A change here navigates to `theme/<v>` and is shown at once;
    every state push applies `theme` and copies it to this origin's localStorage. theme-boot.js ignores that copy on macOS
    and Windows (the shell has already set the window's theme, and a copy made while another server was shown would only
    flash) and uses it on Linux, where the WebView may not follow the shell.
- **Desktop bridge** (web/src/lib/desktop.ts; the shell's side is in §24):
  - `desktopMarker()` reads the static marker `{v:1, version, os}`; `useDesktopState()` is a useSyncExternalStore over
    `window.__easyStudyDesktopState` and the `easy-study-desktop` event. The push is untrusted input: every field is
    checked (known enums, version-like strings, finite counts, `releaseUrl` https only, `origin` http(s), notes cut to
    2000 characters, `share` = `{on: boolean, urls: ≤32 http(s) origins, code: null | a generated-code shape}`); a
    malformed push is ignored and the previous state stays. Pages of other computers get fewer update fields (no notes,
    dates, errors of their own) and never `share`, and must work with them.
  - `desktopAction(name)` navigates to `<page origin>/__easy-study-desktop/<name>` (choose, forget-choice, check-update,
    install-update, dismiss-update, cancel-update, theme/system|light|dark, share/on|off|reveal|reset-code; nothing
    else is built) after allowing the
    page to be left for 1 s: App.tsx's beforeunload guard (answers, uploads, recordings) asks `leaveAllowed()` first,
    because WebView2 runs beforeunload even for a navigation the shell cancels. The server answers the prefix with 204
    in every mode, so an action that is not intercepted leaves the page where it is.
  - Hooks App.tsx installs for the shell (in browsers too, unused there): `__easyStudyBusy()` → `{recording,
    unsentSeconds, finishing, recordingUploads, uploads, answering}` read live from the recorder, the recording uploads
    and the app's state (`recording` is any recorder phase but idle, paused included); `__easyStudyOpenSettings(section?)`
    → true (under the login screen the dialog opens after the login); `__easyStudyAllowLeave()` → true, allowing 3 s for
    the navigation the shell makes after asking the user in its own dialog (the chooser, reload, install).
  - **UpdateBanner** under the top bar (`.banner-info`) for phases available / downloading (progress, 취소) / downloaded /
    installing / error, unless dismissed ("나중에" hides it at once and sends dismiss-update). The install button is
    disabled with a hint while audio could be cut off (recording, unsent audio, finishing, recording uploads — the shell
    blocks those too) and asks first for answers and PDF uploads; install 'download' kinds get the reason (a translocated
    macOS app) or "이 설치 방식(deb|rpm|Arch)에서는 새 패키지를 받아…" and the release page link (target=_blank, so the
    system browser). macOS in-app installs show the microphone hint (the ad-hoc signature changes with every version).
    `justUpdated` gives the toast "easy-study {v} 버전으로 업데이트했어요." (on macOS with the microphone fix) once per
    version and tab (sessionStorage `easy-study:toastedUpdate`): the shell sends it with every push of that launch.
    An error text that is a sentence of its own ("업데이트가 끝나지 않았어요…") gets no "업데이트하지 못했어요:" in front.
  - LoginScreen and LocalOnlyScreen have "다른 서버에 연결…" (→ choose) inside the app; over a mounted app its warning
    is shown inline (the app's dialogs cannot be answered under the login screen). Both say where the code is (the
    app's ⚙ 설정 › 데스크톱 앱 › 다른 기기에서 접속, or the terminal of `npm run start:remote`); LocalOnlyScreen's first
    bullet is the switch. The login screen's plain-HTTP notice also shows when the app relays a plain-http remote
    (`connection.kind === 'remote'` with an `http:` origin): the page is at 127.0.0.1 then, the network hop is not.

## 9. Module ownership (parallel implementation)

| Owner | Files |
|---|---|
| server-core | `server/config.ts`, `server/library.ts`, `server/sessions.ts`, `server/chat.ts`, `server/index.ts`, `tests/library.test.ts`, `tests/sessions.test.ts` |
| llm | `server/context.ts`, `server/prompts.ts`, `server/providers/{proc,claudeCode,codex,anthropicApi,openaiApi,index}.ts`, `tests/context.test.ts`, `tests/providers.test.ts`, `tests/fixtures/*` |
| web | everything under `web/` |
| shared (fixed) | `shared/types.ts`, `server/providers/types.ts`, `server/internal-types.ts` |

Cross-module functions (exact signatures):

- `server/context.ts`: `export function buildTurn(input: BuildTurnInput): BuildTurnOutput`,
  `export function appendHistory(state: ProviderState, parts: Part[], answer: string): ProviderState`,
  `export function defaultContextSettings(env?: NodeJS.ProcessEnv): ContextSettings`,
  `export function initialProviderState(): ProviderState`.
- `server/providers/index.ts`: `export function getProvider(id: ProviderId): Provider | undefined`,
  `export function listProviders(): Provider[]`, `export async function providerInfos(): Promise<ProviderInfo[]>`
  (availability cached 60 s).
- `server/library.ts`: `loadDocAssets(docId: string): Promise<DocAssets>` (throws if not ready),
  `listDocs()`, `getDoc(docId)`, `importPdf(bytes: Buffer, fileName: string): Promise<DocMeta>`, `resumePendingIngests()`.
- `server/sessions.ts`: `createSession`, `getSession`, `saveSession`, `listSessions`, `deleteSession`,
  `toSummary`, `writeNotes(docId)`, `buildNotes(docId): Promise<NotesResponse>`.

---

# Round 2 additions (neighbors, digest, courses)

These sections extend/override the ones above. Contract changes are already in `shared/types.ts`,
`server/internal-types.ts` and `server/providers/types.ts`.

## 10. Neighbor slides (locality)

Lecture slides often continue across pages, so each turn feeds the focused slide **and** the
`neighbors` slides before and after it (`BuildTurnInput.neighbors`, clamped to 0..3 and to the deck;
request field `neighbors`, default `ContextSettings.neighborWindow` = 1).

`buildTurn` changes (replaces FOCUS in §5):
```
window = [max(1, slide-n) .. min(M, slide+n)]
newSlides    = window slides NOT in state.recentSlides (all of them when (re)priming)
reusedSlides = the rest
cost = |newSlides|; rollover when state.primed && state.imagesSent + cost > maxImagesPerConversation
FOCUS(window):
  "The student is currently looking at slide N of M." +
  (n > 0) "Slides a–b are included for context because lecture slides often continue across pages; answer about slide N unless asked otherwise."
  for s in window ascending:
     label "Slide s" (+ " — CURRENT" for s == N)
     new    → full-resolution image (detail 'high') + that slide's material (digest entry if present, else extracted text)
     reused → "(Slide s's image was already provided earlier in this conversation.)"
nextState.recentSlides = [N, ...other window slides (nearest first), ...previous recentSlides] deduped, sliced to recentWindow
nextState.imagesSent += |newSlides|
ContextInfo.attachedSlides = newSlides (ascending), reusedSlides = reused (ascending)
```
Sequential reading therefore costs about one new image per step. `recentWindow` default becomes 8.

## 11. Digest ("정리본")

Goal (user request): feed the whole deck once and turn it into reusable **text**: a careful per-slide
transcription + explanation produced by an LLM that looks at every slide image. It is saved and reused:
priming later sessions (text instead of overview images — cheaper/faster, and it reads formulas, tables and
symbols from the images, which plain text extraction garbles or drops), the focused-slide material, the course context (§12), and the student
reads it in the UI next to the focused slide.

Storage: `library/<docId>/digest/digest.json` (`DigestRecord`), `library/<docId>/DIGEST.md`.

Job (`server/digest.ts`, one job per document at a time, persisted after every batch so it survives crashes/restarts):
1. Slides to do = all (force) or those without a non-failed entry. Split into batches of `DIGEST_BATCH_SIZE` (4) consecutive slides.
2. Run batches with concurrency `EASY_STUDY_DIGEST_CONCURRENCY` (default 2). Each batch = one provider call with
   `resume: null`, `ephemeral: true`, `history: []`, the digest system prompt and `buildDigestBatchParts(...)`
   (the batch's full-resolution slide images + their extracted text + deck/course title).
   Parse with `parseDigestOutput(text, expectedSlides)`. Slides missing from the output are retried once in a
   smaller batch (1 slide each); if still missing they are stored with `failed: true` and a placeholder.
3. When every slide has an entry, one more call with `buildLectureSummaryParts(...)` (text only: the whole digest)
   → `summary` (Korean, ≤ ~1500 chars: topics, key definitions/notation, algorithms, connections).
   A summary failure does not fail the digest (status stays 'ready', `error` explains).
4. Status: running → ready | error (a batch threw and nothing could continue) | aborted (`POST .../digest/abort`).
   On server start, a record left in 'running' becomes 'aborted' (the user can resume; done slides are kept).
5. After every batch: rewrite `DIGEST.md` and, if the doc is in a course, the course's `COURSE.md`.

Model output format (enforced by the prompt, parsed leniently — tolerate extra text, Markdown fences, `**`, spacing):
```
<<<SLIDE 5>>>
TITLE: Predictive Parsing
<markdown body: transcription (LaTeX math $...$, Markdown tables, code fences), figure descriptions,
 then a final line starting with "핵심:" with a 1–2 sentence takeaway in Korean>
<<<SLIDE 6>>>
...
```
`server/digestPrompt.ts` (owned by the context/providers agent) exports:
`DIGEST_BATCH_SIZE`, `digestSystemPrompt()`, `buildDigestBatchParts({ deckTitle, pageCount, courseTitle, slides: [{ slide, imagePath, text }] }): Part[]`,
`parseDigestOutput(output: string, expectedSlides: number[]): DigestSlide[]` (one entry per expected slide, missing → `failed: true`),
`lectureSummarySystemPrompt()`, `buildLectureSummaryParts({ deckTitle, courseTitle, digest }): Part[]`.

`DIGEST.md`: `# <title> — 정리본`, the summary (if any) under `## 강의 요약`, then per slide
`## Slide N · <title>` + `![slide N](slides/NNN.png)` + markdown (headings inside bodies demoted like notes).

Auto start: `POST /sessions` starts a digest job with the session's provider/model when the document's
digest status is `'none'` (disable with `EASY_STUDY_AUTO_DIGEST=0`). The UI can (re)start it with any provider.

HTTP:
| GET `/api/docs/:docId/digest` | – | `DigestInfo` |
| POST `/api/docs/:docId/digest` | `StartDigestRequest` | 202 `DigestInfo` (409 if running; 400 provider unavailable) |
| POST `/api/docs/:docId/digest/abort` | – | 204 |
| GET `/api/docs/:docId/digest.md` | – | `text/markdown` |

Context use (context.ts): material for slide s = digest entry markdown (if present and not failed) else extracted text.
PRIMING with `digestComplete`: header says the per-slide material is a transcription made from the slide images;
sheets only if `primeWithImages === 'always'` (or 'auto' and !digestComplete). DocAssets.digest/digestComplete are
filled by `loadDocAssets`.

## 12. Courses ("과목" folders)

A course is an ordered list of lecture documents. Storage: `library/courses/<courseId>/course.json` (`CourseRecord`),
`library/courses/<courseId>/COURSE.md`. Course id = slug(title) + '-' + 6 hex (COURSE_ID_RE). Membership's single
source of truth is the course files; `DocMeta.courseId` is derived when docs are listed (a doc in several courses
= data error → first course by createdAt wins). `listDocs` must ignore `library/courses`.

HTTP:
| GET `/api/courses` | – | `Course[]` (createdAt ascending) |
| POST `/api/courses` | `CreateCourseRequest` | 201 `Course` |
| PATCH `/api/courses/:courseId` | `UpdateCourseRequest` | `Course` (400 unknown doc ids / duplicates) |
| DELETE `/api/courses/:courseId` | – | 204 (lectures are kept, become uncategorized) |
| GET `/api/courses/:courseId/summary.md` | – | `text/markdown` COURSE.md |
| POST `/api/docs` with header `X-Course-Id` | PDF | adds the new doc to that course (400 if unknown); inserted by natural sort of titles among the course's lectures (so "L8…" lands after "L7…"), else appended |

`COURSE.md`: `# <course title> — 과목 정리`, then for each lecture in order `## <k>. <title>` + summary or
`_(정리본 없음)_` + relative links `../../<docId>/DIGEST.md`, `../../<docId>/STUDY_NOTES.md`.

Context (`loadDocAssets` fills `DocAssets.course`; context.ts uses it when priming — CLI and API providers alike):
```
COURSE CONTEXT (before the deck material):
  "This lecture is part of the course <title>: lecture k of K." + ordered list of all lecture titles
  for each PREVIOUS lecture (index < current), oldest first: "### Lecture i: <title>\n<summary or '(no summary yet)'>"
     — total capped by maxCourseContextChars, dropping the OLDEST summaries first (keep their titles)
  later lectures: titles only
  CLI providers only: "Files of other lectures are readable: ../<docId>/DIGEST.md (per-slide transcription),
     ../<docId>/slides/NNN.png (slide images). Open them when the student refers to earlier material."
BuildTurnOutput.readDirs = dirs of all OTHER lectures (chat.ts passes them as extraReadDirs).
```
The system prompt mentions that earlier lectures of the course may be referenced ("저번 강의", "Lecture 6").
Recap/rollover behaviour is unchanged.

## 13. Web additions

- Library view grouped by course: course "folder" cards (title, #lectures, "COURSE.md" link, rename, delete with
  confirm) listing lectures in order with ▲▼ reorder, "과목에서 빼기", and a drop zone/upload button that uploads
  into that course (`X-Course-Id`); an "미분류" section; "＋ 새 과목" button; moving an uncategorized doc into a
  course via a select. Top-bar document picker uses `<optgroup>` per course.
- Chat header: course badge `📁 Compiler · 2/5강` when in a course; neighbor selector `앞뒤 ±0/±1/±2/±3`
  (default ±1, localStorage) sent as `neighbors` on every question/prime.
- Context line lists all attached/reused slides (`🖼 p.12·13·14 첨부`, `↺ p.13 이미 전달됨`).
- Right pane tabs **채팅 | 정리본 | 노트**. 정리본 tab: status + progress bar (`done/total`, poll `GET digest`
  every 2 s while running), "정리본 만들기 / 이어서 만들기 / 다시 만들기" with the provider/model chosen for new
  sessions, abort; content mode "현재 슬라이드" (default: the focused slide's entry, follows scrolling) or "전체"
  (lecture summary + all entries, auto-scrolls to the focused slide); link to DIGEST.md. Failed entries show a warning.
- DocMeta.digestStatus badge in pickers (✓ 정리본 / ⏳).

## 14. Round 3 (review fixes) — contract additions

- `ProviderError` / `ProviderErrorKind` / `providerErrorKind()` in `server/providers/types.ts`. Providers classify
  failures; `chat.ts` recovers from `resume_invalid` and `context_overflow` by rebuilding the turn with
  `BuildTurnInput.forceNewConversation = kind` (behaves like a rollover: re-prime + recap) and retrying **once** within
  the same request (the client sees a `status` event, then the new answer; the user message's `context` is replaced
  by the retry's ContextInfo with `recoveredFrom` set, sent in the final `done` event's session/messages).
- `ProviderRunInput.allowTools` (digest passes `false`).
- `recentWindow` default 16.
- `DigestRecord.summaryStale`.
- New document routes: `DELETE /api/docs/:docId` → 204 (refuses 409 while an ingest, digest job or turn runs; removes
  the doc from its course, rewrites COURSE.md, deletes library/<docId>), `POST /api/docs/:docId/retry` → 202 `DocMeta`
  (re-runs the ingest for a doc whose status is 'error'; 409 otherwise).
- Single-instance guard: `library/.server.lock` with `{pid, port, startedAt}`; startup refuses (clear message) when the
  lock's pid is alive, and replaces a stale lock; removed on shutdown.

## 15. Round 4 — memory (RAM) and portability

Measured first (see the memory profile): the biggest consumers were concurrent claude CLI children (~145 MB footprint
each; 3 at session start), decoded 1600 px PNG slides in the browser's GPU cache (~250 MB after scrolling a lecture),
KaTeX-heavy DOM (chat/notes/digest always mounted), and in the server: libvips/malloc fragmentation from sharp work
in the long-lived process, runtime TS stripping (+31 MB), per-request digest.json parsing, eager SDK imports.

Contracts:
- `server/assets.ts` (fixed): derived image files (view WebP renditions, thumbs, inline JPEGs) and their paths.
- **Image worker**: all sharp work (contact sheets, view renditions, thumbs, inline JPEGs) runs in a short-lived child
  process (`server/imageWorker.ts`, spawned with `process.execPath`), at ingest and as a background backfill for docs
  created before this round (one doc at a time). The server process does not import sharp in the normal path.
- **HTTP**: `GET /api/docs/:docId/view/:n.webp?w=1000|1600` and `GET /api/docs/:docId/thumbs/:n.webp` (immutable
  cache headers when the file exists; if it does not exist yet: enqueue a backfill for the doc and answer with the PNG
  bytes and `Cache-Control: no-store`). The PNG route stays for compatibility and for the LLM path.
- **CLI process budget**: at most `EASY_STUDY_MAX_CLI_PROCS` (default 2) LLM CLI children at a time across the whole
  server; chat turns have priority (a digest batch only starts when a slot is free and no chat turn is waiting;
  chat turns never wait for digest batches beyond the limit — if the limit is reached by digests, the chat turn still
  starts and digest waits). A chat turn that waits for another chat turn streams the status
  "다른 답변이 끝나기를 기다리는 중…" and, once it gets the slot, an empty status that clears it (the client hides an
  empty status). `EASY_STUDY_DIGEST_CONCURRENCY` default 1.
- claude children get `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`,
  `MIMALLOC_PURGE_DELAY=0`; claude-code `maxImagesPerConversation` 48. codex children get `-c notify=[]`.
- Production runs precompiled JS (`dist-server/`, built by `npm run build`), started with a small young generation
  (`--max-semi-space-size=2`). `npm run dev` keeps running TS + Vite (development only).
- Portability: no external PDF tool (§17); Windows CLI resolution (.exe on PATH, npm `.cmd` shims mapped to the
  real executable), tree-kill on abort, windowsHide, rename/rm retries on EPERM/EBUSY, SIGHUP/SIGBREAK handling.

## 16. Round 5 — access from other computers (remote mode) + installable app (PWA)

User direction: keep the server architecture (it can later move to a remote machine unchanged), make it reachable from
other computers, and get an "app" on macOS/Windows. The app is the same web client installed as a PWA (Chrome/Edge
"Install app", Safari "Add to Dock"/"Add to Home Screen") that talks to the server; no separate desktop shell.

### Modes
- **Local mode (default, unchanged)**: bind `127.0.0.1`, no login, loopback Host/Origin guards as today.
- **Remote mode**: `EASY_STUDY_HOST` is not a loopback address (e.g. `0.0.0.0`, a LAN IP) **or** `EASY_STUDY_AUTH=on`.
  Every `/api/*` request needs a valid session (except the auth routes below). `EASY_STUDY_AUTH=off` with a
  non-loopback host is refused at startup (clear error). `EASY_STUDY_AUTH=on` with loopback is for reverse proxies such as
  `tailscale serve` (requests then arrive from 127.0.0.1 — loopback is never trusted as authentication).
- The loopback-only Host check applies only when auth is off. With auth on, DNS rebinding is harmless because the session
  cookie is host-only and `SameSite=Strict`; the existing Origin check for non-GET requests (CSRF) stays in both modes.
  The Origin may match `X-Forwarded-Host` (a reverse proxy passing the public name on) only with auth on and only from a
  loopback peer; in local mode only the `Host` header counts.
- Every response (both modes, client pages, static files, `/login`, API answers and errors) carries
  `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (clickjacking: a framed app would send
  same-origin requests that pass the Host/Origin checks; frame-ancestors cannot be set by `<meta>`),
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- Child processes (claude/codex CLIs, the PDF/image worker) never inherit `EASY_STUDY_PASSWORD`,
  `EASY_STUDY_TLS_KEY` or `EASY_STUDY_TLS_CERT` (`config.ts` `childProcessEnv`): the CLIs read untrusted PDFs.

### Access code and sessions
- Access code: `EASY_STUDY_PASSWORD` if set (min 8 chars), otherwise a generated code (≥100 bits, typeable:
  4 groups of 5 lowercase base32 chars, e.g. `k7qm2-x9fda-...`) stored in `<library>/.auth.json` (file mode 0600) and
  reused across restarts. Deleting `.auth.json` (or `--reset-access-code`) regenerates it and revokes all sessions.
- Startup log in remote mode prints: every URL to reach the server (each non-internal IPv4 of os.networkInterfaces()
  plus the hostname), the access code, a one-click login URL `http(s)://<addr>:<port>/login?code=<code>`, and a warning when
  serving plain HTTP on a non-loopback address ("same Wi-Fi only; use Tailscale/HTTPS outside").
- Sessions: 256-bit random ids; the server stores only sha256(id) with `createdAt`/`lastSeenAt`/`expiresAt`
  (30 days, sliding) in `.auth.json`; cookie `es_session` = id, `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  plus `Secure` when the request is HTTPS (native TLS, or `X-Forwarded-Proto: https` from a loopback peer).
- Scripts/API clients may send `Authorization: Bearer <access code>` instead of a cookie.
- Comparisons are constant-time (crypto.timingSafeEqual on hashes). Failed logins are rate limited per client IP
  (10 failures / 10 min → 429 with Retry-After, checked before the code, so even the right code waits); successful
  login clears the counter. Backstop for many addresses: once 100 logins failed from all clients together within
  10 min, each failure locks its client at once for the rest of its window (one guess per address). The backstop never
  refuses a client that still has attempts: a flood of wrong logins cannot lock the owner out of logging in with the
  right code (login, bearer or `/login?code=`), and existing cookie sessions are unaffected.
- Startup banner with `EASY_STUDY_PASSWORD`: `--reset-access-code` only ends the logins (the password stays the code),
  and the banner says so ("모든 로그인을 끊으려면 … (접속 코드를 바꾸려면 EASY_STUDY_PASSWORD 를 바꾸세요)").

### Routes (always reachable, JSON)
| GET `/api/auth/status` | – | `{ authRequired: boolean, authenticated: boolean }` |
| POST `/api/auth/login` | `{ code: string }` | 204 + Set-Cookie; 401 `{error}`; 429 `{error}` |
| POST `/api/auth/logout` | – | 204, revokes the session, clears the cookie |
| GET `/login?code=…` | – | valid → Set-Cookie + 303 redirect to `/` (so the code leaves the address bar); invalid → 303 to `/?login=failed` |
Static SPA assets (index.html, JS/CSS, manifest, icons) are served without auth (they contain no user data); every other
`/api/*` answers 401 `{error:"login required"}` without a session. Images (`/slides`, `/view`, `/thumbs`) and SSE are
covered by the cookie automatically (same origin).

### TLS
- `EASY_STUDY_TLS_CERT` + `EASY_STUDY_TLS_KEY` (PEM paths) → `https.createServer`. Both or neither (startup error otherwise).

### Web client
- On start: `GET /api/auth/status`; if `authRequired && !authenticated` show a login screen (Korean): access-code field,
  error / rate-limit messages, hint where the code is shown (the server's terminal). Any 401 from the API later
  (expired/revoked session) returns to the login screen without losing the current doc/slide selection.
- A logout item in the top bar when `authRequired`.
- PWA: `web/public/manifest.webmanifest` (name "easy-study", short_name, start_url "/", display "standalone",
  theme/background colors matching the light theme, icons 192/512 + maskable 512), `apple-touch-icon`, `theme-color`
  meta for light/dark. No service worker (not needed for installability in Chromium today; avoids stale caches).
- Installing needs a secure context in Chrome/Edge: plain `http://<LAN IP>:5180` is not installable
  (`not-from-secure-origin`), `http://127.0.0.1:5180` on the server computer is. From other computers use HTTPS:
  `tailscale serve` (`EASY_STUDY_HOST=127.0.0.1 EASY_STUDY_AUTH=on`) or `EASY_STUDY_TLS_CERT/KEY` with a certificate the
  other computer trusts (`tailscale cert`, mkcert). Safari "Add to Dock" also works over HTTP. The remote-mode banner
  (plain HTTP), the login screen's HTTP notice and the README ("앱으로 설치하기") say this.
- Plain HTTP is not a secure context either, so `navigator.clipboard` is undefined there: the copy buttons use
  `web/src/lib/clipboard.ts` `copyText` (Clipboard API when allowed, otherwise a hidden `<textarea>` +
  `document.execCommand('copy')`; rejects when both fail, so a success or failure toast always shows). In remote mode
  the notes/digest "copy path" buttons say that the path is on the server computer.
- Layout must remain usable on tablets/phones (existing ≤800px stacked layout) — check that the login screen and the
  main view work at 390×844.

### Desktop share mode and the loopback proxy as a client of remote mode (0.5.1)
The desktop app (§19) uses remote mode twice, without changing its rules:
- **Share mode** ("다른 기기에서 접속 허용", desktop.json `share`): the shell starts the bundled server with
  `EASY_STUDY_DESKTOP_SHARE=1` and `server/desktop.ts` turns that into exactly `host: '0.0.0.0', auth: 'on',
  password: null` — the generated code of `<library>/.auth.json`, the login on. `networkSettings` still refuses auth
  off on a non-loopback host, so no path exposes a login-less server. The code is never printed on stdout (the shell
  copies stdout into server.log) or pushed to a remote page; the shell reads it from the file when the chooser or the
  local page shows it, and logs its own window in through `GET /login?code=` (303 + cookie: loopback is never
  authentication — a `tailscale serve`-style loopback peer never gets in for free). `GET /api/desktop/busy` stays
  behind the login; the shell probes it with `Authorization: Bearer <code>` over loopback. `EASY_STUDY_DESKTOP_RESET_CODE=1`
  is `--reset-access-code` for "접속 코드 새로 만들기". The ready line gains `share.urls` (§19). Plain HTTP on the LAN
  carries the code and cookie unencrypted: same-Wi‑Fi only, Tailscale/HTTPS elsewhere (README, chooser hint).
- **Loopback proxy** (`server/proxy.ts`, a separate `dist-server/server/proxy.js` entry the shell runs per app session
  with `--to http://<host>:<port>`): a plain-http remote is not a secure context, so the WebView hides the microphone
  from its page. The shell shows `http://127.0.0.1:<proxyPort>` instead; the proxy relays every request to that one
  origin — SSE and uploads as they flow (nothing buffered, `res.flushHeaders()` + `setNoDelay`), HTTP Range, HEAD,
  `Set-Cookie` untouched (host-only cookies land on 127.0.0.1), `Location` on the remote origin rewritten to the
  proxy's, `Host`/`Origin`/`Referer` of the proxy origin rewritten to the remote's so `apiGuard`/`isSameOrigin` pass.
  Any other `Origin` passes unchanged and the remote refuses it (CSRF holds: the 127.0.0.1 cookie is SameSite=Strict
  + HttpOnly). It binds 127.0.0.1 only, answers 421 to any other `Host` (DNS rebinding), 400 to an absolute-form
  target, closes every `Upgrade`, sends no `X-Forwarded-*`/`Forwarded` and drops incoming ones (the remote trusts
  those from loopback peers: a spoofed `https` would make it set a `Secure` cookie the WebView drops over http; a
  spoofed address would change rate-limit keys), adds no credentials (a local process reaching it gets no more than
  reaching the LAN remote directly), resolves the remote's name per request and connects only private addresses
  (loopback, RFC 1918, link-local, 100.64/10, IPv6 ULA/link-local — the shell's `remote.rs` rules; an IP literal is
  checked in the handler because `net.connect` skips the lookup for it) → 502 "연결한 컴퓨터(…)에 닿지 않아요" when the
  remote is down or public. An answer that arrives before the request body ended (401, 413) is relayed with
  `Connection: close`; the proxy then reads ≤ 16 MB / 5 s of the rest off before ending, so the client reads the
  answer instead of a reset (the remote itself does the same, `drainRest`; beyond its bound a direct client can be
  reset too). A client that leaves destroys the upstream request (the remote aborts the turn / unsubscribes). It never
  logs a URL or header (`/login?code=` carries the code). https remotes are shown directly (already secure), and so
  are loopback remotes (127.0.0.1 / localhost) unless the shell's test knob `EASY_STUDY_DESKTOP_FORCE_PROXY=1` says
  otherwise. The remote's security headers pass through untouched.
- **Cookies are host-scoped, not port-scoped**: the WebView keeps ONE cookie jar for 127.0.0.1, shared by the shell's
  own server (share mode: its `es_session`, set by the shell's `/login?code=`), the proxy and any later proxy for
  another remote (the port is remembered, so it is even the same origin). Left alone, every request through the proxy
  would carry the local server's `es_session` — valid for 30 days, never revoked by `open_remote` (which only stops the
  server) — to whichever remote is behind it, and one remote's cookie to the next. So the proxy scopes the session
  cookie itself (`scopedSessionCookieName`, `downstreamSetCookie`, `upstreamCookie`): `Set-Cookie: es_session=…` from
  the remote (a login, the sliding refresh, the `Max-Age=0` of a logout) is stored as `es_session_<12 hex of
  sha256(remote origin)>`, attributes untouched, and the `Cookie` header sent to the remote holds only that one back
  under the name `es_session`; a bare `es_session` and every other `es_session_*` are dropped. The local server's login
  therefore never reaches a remote, one remote's never reaches another, and the logins coexist: switching local ⇄
  remote or between remotes does not ask for a code again (a remote's cookie does still reach the local server on
  its port, where `sessionCookieValues` reads only `es_session`; a loopback dev server shown directly, not through the
  proxy, shares the plain `es_session` with the shell's shared server — a developer-only case). tests/proxy.test.ts
  asserts a valid token under a foreign name is not a login.
- **A page cannot open this computer to the network by itself**: `share/on` and `share/reveal` from the local page go
  through `bridge::confirm` (native, rate-limited by `PageDialogs`) before anything happens (§24), because the page's
  session is HttpOnly and page-bound while the code lets any device in; the chooser (IPC-only, the trusted bundle)
  needs no dialog. The plain-http relay is a trade-off the README states: the network can also alter the page, and an
  altered page at the relay origin has the microphone and the session — trusted network only, Tailscale/HTTPS elsewhere.

## 17. Round 6 — PDFium (no external PDF tools)

Goal: the app needs nothing but Node and `npm ci` on macOS, Windows and Linux (prerequisite for the desktop app).
poppler (`pdfinfo` / `pdftoppm` / `pdftotext`, found on PATH) is gone from the runtime entirely; PDFs are read by
**PDFium compiled to WebAssembly**, `@embedpdf/pdfium` pinned to an exact version (`2.15.1`): one 4.6 MB
`pdfium.wasm` for every platform, no native binary, BSD-3/Apache-2.0 (PDFium) + MIT (the package); the licenses of
PDFium and the libraries it bundles are in `THIRD_PARTY_NOTICES.md`. Chosen after a spike against pdf.js + a native
canvas (a native addon per platform, more memory), MuPDF (AGPL) and other PDFium packages; measured on a 49-slide
deck: 1.5 s instead of 5.7 s (pdftoppm) for the whole conversion, identical per-page characters to `pdftotext`.

Contracts:
- **Where it runs**: only in the worker process of §15 (`server/imageWorker.ts` imports `server/pdf.ts`
  dynamically). The server process never instantiates the wasm module (checked by a test with a resolve hook), and
  its memory goes back to the OS when the worker exits. Jobs: `PdfJob` (ingest, §3 steps 1-3) and `TextJob`
  (backfill, below); the worker sends `info` (page count, aspect ratio), `progress` (slides written) and at most one
  `warning` (Fonts, below) message.
- **Loading**: `FPDF_LoadCustomDocument` with an `FPDF_FILEACCESS` whose `getBlock` callback reads the requested
  range with `fs.readSync` straight into the wasm heap: a 150 MB PDF peaks at ~260–310 MB RSS (305 MB measured on
  Linux arm64, sharp's PNG encoding included) instead of ~540 MB
  when the whole file is copied into the heap. The file (≤ 4 GB: `m_FileLen` is 32-bit on wasm32) stays open until
  the document is closed. Every page, text page, bitmap and document is closed right after use (a test checks that
  the wasm heap and the open file descriptors do not grow).
- **Errors** (`FPDF_GetLastError`): 4 → `the PDF is password protected`; 3 → `could not read the PDF: the file is
  damaged or is not a PDF`; 5 → `…encrypted with an unsupported security handler`; others → `could not read the PDF
  (PDFium error N)`. A PDF without pages → `the PDF has no pages`. They end the ingest in status `error`.
- **Rendering**: long edge 1600 px (`round(w·s) × round(h·s)`, like `pdftoppm -scale-to`), `FPDF_ANNOT |
  FPDF_REVERSE_BYTE_ORDER` (RGBx for sharp), white background, RGB PNG without alpha. Form fields (widget
  annotations) are never drawn by `FPDF_RenderPageBitmap`: a document with a form (`FPDF_GetFormType` ≠ 0) gets a
  form-fill environment (`PDFiumExt_InitFormFillEnvironment`, released before the document; `FORM_OnAfterLoadPage` /
  `FORM_OnBeforeClosePage` per page) and its fields are drawn on top with `FPDF_FFLDraw` (same flags), with or
  without an appearance stream, as poppler drew them.
- **Concurrency**: at most `MAX_INGEST_WORKERS` ingests run their workers at a time (`library.ts`: half of
  `os.availableParallelism()`, 2 to 4; a FIFO counting semaphore, `createSlots`). A slot is taken after `doc.json`
  says `processing` and held from the PDF worker through the image worker's derived files, so at most that many worker
  processes convert at once, whatever the number of PDFs: a PDF worker holds PDFium's heap and sharp from its first
  page on (~150–300 MB RSS), an image worker ~200 MB. Measured with 16 lecture PDFs (31–49 slides) dropped at once on
  a 10-thread M4: no limit 20 s and 2.4 GB of workers at the peak (17 processes); 4 slots 26 s, 0.71 GB; 2 slots
  44 s, 0.38 GB (poppler's pipeline, unlimited: 38 s, 1.7 GB; limiting the PDF stage alone: 1.9 GB, as the image
  workers pile up behind it). Waiting ingests stay `processing` at progress 0 (not deletable, like any conversion);
  at shutdown (`stopImageWork`) they are turned away before they start and converted on the next start.
- **Fonts**: PDFium's built-in substitutes cover the base-14 fonts (Helvetica, Times, Courier, Symbol, …). Non-embedded
  **CJK** fonts would not be drawn at all (PDFium-wasm cannot see system fonts), so `FPDF_SetSystemFontInfo` gets JS
  callbacks that offer one host font for the CJK charsets only (SHIFTJIS 128, HANGEUL 129, GB2312 134, BIG5 136); any
  other font request keeps the built-in substitutes (same pixels with or without the fallback font). The file is the
  first that exists of `fallbackFontFiles()` — macOS: Arial Unicode.ttf, AppleSDGothicNeo.ttc; Windows:
  `%WINDIR%\Fonts\malgun.ttf`, gulim.ttc, msgothic.ttc, msyh.ttc; Linux: Noto Sans CJK (Debian/Ubuntu, Arch,
  Fedora paths), Nanum Gothic — or `EASY_STUDY_PDF_FALLBACK_FONT` instead of the list. It is read lazily (only when a
  PDF asks for a CJK font); when none exists such text stays undrawn (its extracted text is still right), and the PDF
  worker says so once per run (`fallbackFontWarning`: the files looked for and the remedy) → `[library] <docId>: the
  PDF uses a CJK font it does not embed, and no fallback font could be read (…)` in the server log. At startup an
  `EASY_STUDY_PDF_FALLBACK_FONT` that is not a readable file is reported as well (`fallbackFontProblem`, config.ts).
- **Text**: content order (not `pdftotext -layout`'s columns: table rows stay on one line, side-by-side boxes are not
  interleaved), `\r\n` → `\n`, then `cleanPageText` (trim, common margin, at most one blank line). Office writes
  Symbol-font glyphs (SymbolMT) with ToUnicode entries in the Private Use Area (U+F000 + code); code points
  U+F020–U+F0FF of a font whose name matches `/symbol/i` (`FPDFText_GetFontInfo`, subset prefix ignored) are mapped
  through the Adobe Symbol encoding (α ε ∪ ∈ ∩ ∅ → …). Other PUA fonts (Wingdings, Webdings) are left alone.
  PDFium generates a line break (`\r\n`, `FPDFText_IsGenerated`) wherever the baseline moves, so superscripts and
  subscripts came out on lines of their own ("1\nst", "FIRST+\n.", "A\ni\n → …"). `lineBreakJoint` drops such a
  break when the characters on either side (their loose boxes, `FPDFText_GetLooseCharBox`, both upright within
  ~34°) overlap vertically by at least half the smaller height and the next one starts between ¼ em before and 1 em
  after the end of the last one: replaced by nothing, or by one space when the gap is ≥ 0.15 em and the text has no
  space there. Real line ends (the next line starts left of the last one's end, or lower down) stay. On the three
  parsing lectures: lines of punctuation only 44 → 22, same characters.
  Then, one per line, the text annotations draw on the page (pdftotext extracted it too): FreeText `/Contents`
  (typed notes) and the values of text fields, combo and list boxes; hidden / no-view annotations are skipped.
- **Text backfill** (existing libraries): text files written by poppler contain those PUA code points. Every text
  extraction ends by writing `text/.engine` (`TEXT_ENGINE` in `server/pageNames.ts`: `pdfium-1` first, `pdfium-2`
  with the super/subscript joins and the annotations' text; bump it when the text output changes, and every
  document is re-extracted once). The backfill of §15 (startup: every `ready` document; one document at a time, low priority, never
  while the document is converted or deleted — a new ingest or a deletion stops it) first runs a `TextJob` for a
  document whose marker is missing or different and whose `source.pdf` exists: it rewrites `text/NNN.txt` (atomic
  writes; pages past the PDF's page count keep their file) and the marker, and nothing else — no rendering, and the
  digest is **not** regenerated (a digest made from poppler's text keeps what the model made of the blank PUA
  symbols until the user makes it again, which then uses the new text). A failure keeps the old text (logged; tried again on the next start). Then the
  missing derived images, as before.
- **No PATH lookups**: the worker is forked with `process.execPath`; conversion works with an empty PATH (tested). To
  run the whole suite as on a machine without poppler, put only a folder with a `node` symlink on PATH (`env
  PATH=<dir>:/usr/bin:/bin node --test tests/*.test.ts web/tests/*.test.ts`): Homebrew keeps node, npm and poppler
  in the same `/opt/homebrew/bin`. The
  Homebrew PATH additions existed only for the poppler tools and went with them; the claude/codex CLIs never used
  them (they are resolved from the server's own PATH, or `CLAUDE_BIN` / `CODEX_BIN`).
- **Packaging notes** (desktop app): ship `node_modules/@embedpdf/pdfium/dist/{index.js,pdfium.wasm}` (the wasm is
  found with `createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm')`; a single-file bundle must
  pass its bytes from a resource path instead) and `THIRD_PARTY_NOTICES.md`.

## 18. Library organization — collapsible courses, drag & drop, course groups

User request: course folders can be collapsed; lectures are reordered by dragging a `≡` handle instead of ▲▼ buttons ("알잘딱");
courses can themselves be grouped (e.g. a semester group containing several courses).

### Data (contracts in shared/types.ts: CourseGroup, LayoutItem, LibraryLayout, PutLayoutRequest, CreateGroupRequest, UpdateGroupRequest,
CreateCourseRequest.groupId)
- `library/layout.json` = `{ version: 1, groups: CourseGroup[], order: LayoutItem[] }`, atomic writes, serialized with course mutations.
- Lecture membership/order stays in the course files (§12). Groups/ordering of courses live only in layout.json.
- Normalisation on read: unknown/deleted course or group ids are dropped; a course listed twice keeps its first position; courses that
  exist but are not mentioned are appended to the top level in createdAt order; groups missing from `order` are appended. A missing
  layout.json = all courses top-level by createdAt (today's behaviour). Deleting a course removes it from the layout; deleting a group
  moves its courses to the top level at the group's position (courses and lectures are never deleted by deleting a group).
- Group ids: slug(title) + '-' + 6 hex (COURSE_ID_RE); titles 1–120 chars after trim (same rule as course titles).

### HTTP (remote-mode auth applies like every /api route)
| GET `/api/layout` | – | `LibraryLayout` |
| PUT `/api/layout` | `PutLayoutRequest` | `LibraryLayout` (400 when an id is unknown, duplicated, or an existing course/group is missing; 409 when `baseRevision` is not the current arrangement's) |
| POST `/api/groups` | `CreateGroupRequest` | 201 `CourseGroup` (appended to the top level; listed courses move into it) |
| PATCH `/api/groups/:groupId` | `UpdateGroupRequest` | `CourseGroup` |
| DELETE `/api/groups/:groupId` | – | 204 |
| POST `/api/courses` | `CreateCourseRequest` (+ optional `groupId`) | as before; placed at the end of that group when given (400 unknown group) |
`GET /api/courses` stays (createdAt order) for compatibility; the client orders courses with the layout.

Other tabs and devices (remote mode) change the same library, so a change made from stale data must not silently undo theirs
(lost update). Both requests a drag sends carry what they were computed from:
- `PutLayoutRequest.baseRevision` = `layoutRevision(layout)` (shared/layoutRevision.ts: a hash of the normalised top-level order
  and the courses of each group; titles are not part of it). Server and client compute it from the normalised layout, so no
  response carries it.
- `UpdateCourseRequest.baseDocIds` = the course's lecture list the new `docIds` were computed from (as GET /api/courses shows it).
When given and not current, the answer is 409 and nothing is written (both are optional for other clients). The client then loads
courses and layout again and makes the same (anchored) move once more on top of them; a second 409, or a target course/group
that no longer exists, rolls the move back with a toast. The client also reloads both when its tab becomes visible or focused.

### Web
- Library view renders the layout: groups (collapsible header: `≡` handle, title with inline rename, course count, delete with an in-page
  confirmation, "＋ 과목" to create a course inside the group) containing course cards; top-level course cards; then 미분류 lectures.
- Course cards are collapsible (header click / chevron / Enter): when collapsed show title, lecture count and digest summary badges only.
  Collapse state is per device (localStorage `easy-study:collapsed`), plus "모두 접기 / 모두 펼치기". It is the same in every tab
  of the device: each toggle is applied to what is stored at that moment and other tabs follow `storage` events; keys of deleted
  courses/groups are forgotten (on the first load all unknown keys, later only keys the tab saw disappear). Renaming is the ✎
  button only; a double-click on a header counts as one toggle.
- Drag & drop with an accessible library (@dnd-kit/core): pointer, touch (press-and-hold ~200 ms so scrolling still
  works) and keyboard sensors (Space/Enter pick up, arrows move, Space/Enter drop, Esc cancel) with screen-reader announcements in Korean.
  - Lectures (`≡` handle): reorder inside a course, move to another course (single PATCH of the target course — the server removes it
    from the old one), drop into 미분류 (PATCH of the source course without it).
  - Courses (`≡` handle on the card header): reorder at the top level, move into/out of groups and between groups (PUT /api/layout).
  - Groups (`≡` handle): reorder at the top level (PUT /api/layout).
  - Dragging over a collapsed course/group for ~600 ms expands it (for a lecture a collapsed group's header is only that: releasing
    there moves nothing); screen readers then hear that it opened and the item's new place. A clear insertion indicator shows
    where the item will land (the ghost follows just below-right of the pointer, inside the window); optimistic update with
    rollback + toast on server error; while a request is in flight further drops queue in order.
  - Keyboard focus never falls back to the page: after a "⋯"/select move it goes to the lecture in its new place (or its
    collapsed course/group), after deleting a course/group to the nearest card (or the "과목" heading).
  - Native file drops (uploading PDFs onto a course card) keep working alongside (they use HTML5 file drag events, not pointer drags).
- The ▲▼ buttons are removed; "과목에서 빼기" moves into a small per-lecture "⋯" menu (together with "과목으로 이동 ▸" for keyboard-free
  alternatives). Uncategorised lectures keep a "과목으로 이동" control.
- Top-bar document picker: optgroup label "📁 <group> › <course>" for grouped courses, in layout order.
- Replace window.confirm() in the library view with an in-page confirmation dialog (it does not work inside the upcoming desktop app).

## 19. Round 8 — desktop app (Tauri 2) for macOS, Windows and Linux

User decision: a real installable app (no browser) for macOS, Windows and Linux that keeps the server architecture: the app either
starts a bundled copy of this server ("이 컴퓨터") or connects to an easy-study server on another computer ("다른 컴퓨터": URL +
access code, §16). Based on three verified spikes (macOS shell, Linux shell in Docker, PDF engine) whose reports live in the session
scratchpad (`desktop/spikes-mac-pdf.json` key `shell`, `desktop/spike-linux.json`); the recipe and pitfalls there are normative.

Layout: `desktop/` — `package.json` (@tauri-apps/cli 2.x), `ui/` (the chooser page: the ONLY origin with IPC), `scripts/fetch-node.mjs`
(official nodejs.org binary per target, SHASUMS256 verified; never Homebrew's node), `scripts/pack-server.mjs` (dist-server + web/dist +
production node_modules for the target os/cpu via `npm ci --omit=dev --os --cpu`, dropping sharp-wasm32/@emnapi), `resources/` (generated,
git-ignored), `src-tauri/` (Cargo.toml, build.rs, tauri.conf.json, Info.plist with NSAllowsArbitraryLoadsInWebContent, node.entitlements,
capabilities/chooser.json with NO `remote` key and no permissions (the chooser calls only the app's own commands), icons from the
web/public icon, src/main.rs), `.github/workflows/desktop.yml`.

Server "desktop mode" (`EASY_STUDY_DESKTOP=1`, set only by the shell):
- after listening, print exactly one machine-readable line `EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>}` on stdout;
- exit gracefully on stdin EOF (the shell keeps a pipe; this covers app crash/kill on every OS), plus the existing SIGTERM path;
- library dir comes from `EASY_STUDY_LIBRARY` (the shell passes `<app data dir>/library` unless the user picked another folder);
- errors before listening (e.g. library locked by `npm start`) are printed on stderr in Korean and the process exits non-zero — the
  shell shows the stderr tail in the chooser;
- the library and the install may sit under dot folders (Linux ~/.local/share/…, the AppImage's /tmp/.mount_…): files are sent
  relative to their own folder (Express refuses any dot segment of an absolute path), and errors outside /api are plain text
  without stack traces or paths;
- (0.5.1) `EASY_STUDY_DESKTOP_SHARE=1|true|on|yes` = remote mode on 0.0.0.0 with auth on and the generated code (§16 "Desktop
  share mode"); the ready line is then `EASY_STUDY_READY {"url":"http://127.0.0.1:<port>","port":<port>,"share":{"urls":[…]}}`
  (`url` stays loopback: the shell reaches it there), byte-identical to before without sharing. `share.urls` =
  `shareUrls()`: every non-internal IPv4 except 169.254.*, physical adapters first (en*/eth*/wlan*/Wi-Fi/Ethernet), tunnels,
  bridges and virtual adapters last, the host name last of all (left out on Windows without a domain suffix). The code is
  read from `<library>/.auth.json` (`code`, `^[0-9a-hjkmnp-tv-z]{5}(-…){3}$`) by the shell, never printed.
  `EASY_STUDY_DESKTOP_RESET_CODE=1` = `resetAccessCode: true` (a new code, every login ended, "이전 로그인은 모두 끊었습니다" on stdout).
  Both variables are the shell's (STRIP_ENV): the user's environment cannot share the server;
- (0.5.1) a port held by another program exits with code 3 (`EXIT_PORT_IN_USE`; the message unchanged), so the shell can tell it
  from other failures and try another port — a 0.0.0.0 test-bind in the shell would be no test (SO_REUSEADDR lets a wildcard
  bind succeed beside a loopback listener) and would trigger firewall prompts for the shell binary;
- (0.5.1) the loopback proxy `dist-server/server/proxy.js --to <http origin>` (env `PORT`, 0 = any; no EASY_STUDY_* at all):
  binds 127.0.0.1, prints the same ready line shape (`{"url":"http://127.0.0.1:<p>","port":<p>}`) after
  `[proxy] http://127.0.0.1:<p> → <origin>`, exits 0 on stdin EOF / parent gone / SIGINT/SIGTERM/SIGHUP(/SIGBREAK) after
  `server.close()` + `closeAllConnections()` (2 s force timer), 1 when it cannot listen ("포트 <p>를 다른 프로그램이 쓰고 있습니다"
  for EADDRINUSE: the shell retries with PORT=0), 2 for a bad `--to` ("중계할 주소가 올바르지 않습니다: …"; http only, a host, no
  userinfo, path `/` or none, no query/fragment). Korean stderr goes to the shell's proxy.log. The shared pieces (`readyLine`,
  `watchShell`, `shellAlive`, `stopSignals`) live in `server/shellWatch.ts`, which imports no server module; desktop.ts
  re-exports them. `scripts/build-server.mjs` requires the entry; `desktop/scripts/prepare.mjs` (pack-server) must be re-run
  before an app build that needs it.

Shell (Rust, src/main.rs):
- single instance (focus the existing window); stable local port remembered in the app config (not 5180; fall back to a free port) so
  the origin — and with it localStorage/cookies — stays the same between launches;
- PATH for the server = cached PATH from the previous launch immediately, refreshed from `$SHELL -ilc` (marker lines, 3 s timeout) in the
  background, plus known install dirs (~/.local/bin, ~/.claude/local, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, npm prefix
  bin, Linuxbrew) — Finder/desktop launches otherwise miss claude/codex; Windows inherits PATH from Explorer;
- child lifecycle: POSIX process group + PR_SET_PDEATHSIG (Linux), Windows Job Object KILL_ON_JOB_CLOSE + CREATE_NO_WINDOW, SIGTERM/
  SIGINT/SIGHUP handler that calls app.exit(0); on exit close stdin and wait briefly; strip AppImage variables from the child env
  and from the login shell's;
- windows: main window created in code; chooser at the bundled `ui/` (IPC allowed only there); the server page (local or remote) gets no
  IPC; on_new_window: same-origin → in-app window, other → system browser (tauri-plugin-opener); drag-drop handler disabled so the
  page's own PDF drop upload works; downloads are refused (the web client has none); remote URL validated (http on
  LAN/.local/IP, https only with a certificate the OS trusts — probe before navigating and explain failures); "다음에도 바로 연결"
  remembers the choice; a menu item / shortcut to return to the chooser;
- smoke hooks for CI (`EASY_STUDY_DESKTOP_SMOKE=1|chooser|chooser-local|chooser-remote`, README): never handed over to a running
  instance; the local ones also upload a one-page PDF and load its slide images; a failure shown by the chooser must leave it
  usable;
- library location: default app data dir; the chooser offers "라이브러리 폴더 선택…" (tauri-plugin-dialog) to use an existing folder
  such as the repo's library/ (the single-instance lock prevents running together with `npm start` on the same folder);
- (0.5.1, share flow, `share.rs`): the switch "다른 기기에서 접속 허용" in the chooser's ⚙ 앱 설정 (IPC `set_share`) and in the
  local page's ⚙ 설정 (page actions `share/on|off`, honoured only from the local origin; a remote page's are logged and
  ignored) persists desktop.json `share` and, when the local server runs, restarts it through the busy gate (§24, `Restart::Share`
  wording; never while a recording runs or audio is unsent; refused with a note while the server is still starting or an
  update replaces the app). A page's `share/on` is confirmed in a native dialog first (`bridge::confirm`, one per
  `PageDialogs` gap); the chooser's switch is not. `on_ready` of a shared server navigates to `/login?code=<code>` (the 303
  sets the cookie and drops the code from the address bar; `server::page_url`, also used when "연결" finds the server already
  running) instead of the bare URL — except after a change made in the chooser while the server ran (`AppState::stay_on_chooser`,
  set by share.rs before `server::start`, cleared by `start_ended` and by `connect_local`): the chooser stays with the
  addresses and the code, and "연결" opens the page. `share_urls` (from the ready line, parsed defensively: ≤32 http URLs,
  non-loopback hosts) is the one "runs shared" fact; `access_code()` reads `.auth.json` on demand and the code appears in
  get_state/push_state only for the chooser and the local page (pushed only after `share/reveal`, briefly), never in a log or
  smoke line. "접속 코드 새로 만들기" (`share/reset-code`, chooser button) restarts once with `EASY_STUDY_DESKTOP_RESET_CODE=1`.
  `open_remote` keeps stopping the local server, shared or not ("다른 컴퓨터에 연결하면 이 컴퓨터의 서버(공유 포함)는 멈춰요");
- (0.5.1, proxy lifecycle, `proxy.rs`): for a plain-http, non-loopback remote (or any http remote with
  `EASY_STUDY_DESKTOP_FORCE_PROXY=1`, a STRIP_ENV test knob), after the direct probe (`remote::get`: the public-address refusal
  stays), the shell spawns `proxy.js --to <origin>` on `proxyPort` (remembered in desktop.json — a stable origin keeps the
  WebView's storage across app sessions; note it is ONE origin for every relayed remote, so the web client's localStorage
  (last document, recorder settings) is shared among them, while the logins are kept apart by the proxy's scoped cookie,
  §16; the saved port when free, else 5360..=5369, else any; the port actually used is saved from the ready line) with
  stdin/stdout/stderr piped, the process group / Job Object / PDEATHSIG of the server, stderr → proxy.log, and shows
  `http://127.0.0.1:<p>` (+ `/login?code=…` when a code was given and the remote requires one).
  Ready within 15 s or "연결 통로(프록시)가 15초 안에 준비되지 않았어요"; a failed start is a chooser error line of proxy.rs
  (all named "연결 통로(프록시)…", shown as they are; smoke: exit 2); a proxy that dies later shows the chooser with
  "연결 통로(프록시)가 예기치 않게 종료됐어요 …". It is stopped (stdin EOF, ≤3 s, then kill) at RunEvent::Exit, by show_chooser,
  by a `go_to` of another origin and by a start for another remote, under one lifecycle lock so a pending stop never races a
  newer start (every stop first closes the page-N windows on the proxy origin, except at exit). The proxy origin is the
  `allowed_origin` while shown: page actions, page-N windows and the
  smoke checks work unchanged; `Connection.origin` pushed to the page and "open in browser" use the remote origin
  (`proxy_target`), `is_local` stays false (remote dialog limits, `for_remote()` update state);
- (0.5.1, media): `media::allowed()` trusts the loopback origin the shell itself runs — its server or its proxy
  (`local_server = server_url.or(proxy_url)`; §22) — so the microphone works on the proxy origin on Linux/Windows too
  (macOS grants through the entitlement). Smoke runs report `recorder {secure, mediaDevices, worklet}` on local and proxied pages
  and, with `EASY_STUDY_DESKTOP_SMOKE_WRITE=1` (STRIP_ENV, README), also upload a PDF to a remote/proxied server and check a fake-CLI
  SSE stream and a 0.5 s WAV recording upload; the result line's `url` is the proxy origin when proxied. Still no `getUserMedia(`.

Packaging: macOS .app/.dmg (arm64 and x64, ad-hoc signed `signingIdentity "-"`; notarization later), Windows NSIS (currentUser,
WebView2 bootstrapper), Linux .deb (Depends += libatomic1; Recommends fonts-noto-cjk) + .rpm (compression none or skip if slow) +
AppImage (secondary). Node ships as a resource (macOS/Windows) or externalBin `es-node` (Linux) per the spike findings.
CI (`.github/workflows/desktop.yml`): build on macos-latest (arm64 + x64), windows-latest, ubuntu-22.04 and ubuntu-22.04-arm; run the
repo tests first; upload artifacts; on a `v*` tag create a draft GitHub release. (There is no GitHub remote yet: the workflow file is
added now and runs once a repository exists.)

## 20. Arch Linux

- The web/server mode runs unchanged on Arch (`nodejs` 26 and `nodejs-lts-jod` 22 tested; `nodejs-lts-iron` = Node 20 is too old).
- AppImage fix (found on Arch, applies to any distro with a newer Mesa): the linuxdeploy that Tauri CLI 2.11 pins bundles the build
  host's `libwayland-client.so.0` (Ubuntu 22.04, 1.20). Mesa 26's `libEGL_mesa` needs newer symbols, EGL fails, WebKit aborts, the window
  stays blank. `desktop/scripts/appimage.mjs` (run by build.mjs on Linux) unpacks the AppImage's squashfs, removes that library and
  repacks it after the original runtime; CI checks the result with `--check`.
- `packaging/arch/PKGBUILD` (`easy-study-bin`) repackages the release .deb with Arch dependencies (webkit2gtk-4.1, gtk3, gcc-libs,
  openssl; optdepends noto-fonts-cjk, xdg-utils). CI job `arch-x64` (container archlinux:latest) smoke-tests the x86_64 AppImage, builds
  the package from the fresh .deb, installs it, runs namcap and the smoke tests, removes it, and attaches the `.pkg.tar.zst` + PKGBUILD
  to releases. Arch Linux ARM (aarch64) is listed but untested.

## 21. Attachments — select a slide region, paste / drop / pick images

User request: drag on the PDF slide to select a region and attach it to the question; attach images instantly (paste, drop, pick).
Contracts in shared/types.ts: RegionRect, Attachment, CreateRegionRequest, MAX_ATTACHMENTS (6), MAX_ATTACHMENT_BYTES (10 MB),
ATTACHMENT_ID_RE, SendMessageRequest.attachments (ids), ChatMessage.attachments, ContextInfo.attachments; BuildTurnInput.attachments.

Storage: `library/<docId>/attachments/<id>.jpg|png` (+ `<id>.json` metadata = Attachment). Ids: `att-` + 16 hex.
- Regions are cropped by the image worker from the full-resolution `slides/NNN.png` (not the WebP view), padded by 2 % of the slide on
  each side (clamped), minimum 16×16 px, encoded like inline JPEGs (≤ INLINE_MAX_EDGE, ≤ INLINE_MAX_BYTES; PNG when smaller for flat
  graphics is fine). The text inside the rectangle comes from PDFium (FPDFText_GetBoundedText on the page, same Symbol remap) in the
  same worker run; '' when the PDF has no text layer there. The stored rect is the clamped request rounded to 6 decimals (no
  floating-point dust such as 0.6200000000000001); narrower than that is 400.
- Uploaded images: magic-byte check (PNG, JPEG, WebP, GIF first frame; HEIC only if sharp can decode it here — otherwise 415 with a clear
  message), ≤ MAX_ATTACHMENT_BYTES (413), re-encoded by the worker (EXIF orientation applied, metadata stripped, ≤ INLINE limits).
  The worker job carries the sniffed type (`UploadJob.type`), and in that one-off process every libvips loader is blocked except
  those of PNG/JPEG/WebP/GIF/HEIF (`sharp.block`/`unblock`): libvips would otherwise pick its own loader by content, so an SVG
  behind a HEIF header (`<!--ftypavif--><svg …>`) was rendered by librsvg, pulling in other attachments next to it. sharp's
  reported format must also equal the sniffed type (else 415). Before any pixel is decoded the header is checked
  (`uploadRefusal`): more than UPLOAD_MAX_PIXELS (100 M) in the first frame, or — for formats decoded whole before they can be
  scaled: interlaced PNG, progressive JPEG, GIF (RGBA), HEIF/AVIF — more than UPLOAD_MAX_DECODE_BYTES (150 MB) decoded
  (width × height × channels × bytes per sample) → 413 "이미지 해상도가 너무 커서 처리할 수 없습니다…" (never "damaged"). Measured
  peaks at 10000×10000: interlaced 16-bit PNG ~1 GB, GIF ~590 MB, progressive JPEG ~400 MB, plain PNG ~190 MB (read line by line).
  Worker results: `{ ok: false, reason: 'unsupported' (415) | 'too-large' (413) | 'undecodable' (400; 415 for HEIF) }`.
- Attachments not referenced by any message are deleted after 24 h (startup + hourly sweep); deleting a session deletes the attachments
  only its messages reference; deleting a document deletes the folder.

HTTP (remote-mode auth like every /api route; JSON errors):
| POST `/api/docs/:docId/regions` | `CreateRegionRequest` | 201 `Attachment` (400 bad slide/rect, 409 doc not ready) |
| POST `/api/docs/:docId/attachments` | raw image body, `Content-Type` image/*, header `X-Filename` (URI-encoded, optional) | 201 `Attachment` |
| GET `/api/docs/:docId/attachments/:id` | – | the stored image (`Cache-Control: private, max-age=31536000, immutable`) |
| DELETE `/api/docs/:docId/attachments/:id` | – | 204 only while unreferenced (409 once a message uses it) |
`POST …/messages` accepts `attachments` (ids of this document; unknown → 400 with `missingAttachments: string[]` in the error body,
every id that does not exist here — swept, deleted, another document's; > MAX_ATTACHMENTS → 400). The user message stores the
resolved `Attachment[]`.

Context (context.ts): after FOCUS and before the QUESTION: "The student attached N image(s) to this question:" then per attachment a label
("[Attachment k: the region of slide 12 the student selected]" / "[Attachment k: an image from the student (name)]"), the image part
(detail 'high'), and for regions "Text inside the selection:" + the text. Each attachment counts 1 toward the image budget (rollover) and the
Anthropic preflight. Prime turns take no attachments. appendHistory keeps them for stateless providers. Notes (notes/<sid>.md and
STUDY_NOTES.md) show the attachments under the question: `![p.12 영역](attachments/<id>.jpg)` / `![이미지](attachments/<id>.jpg)`.

Web:
- Slide viewer: drag on a slide draws a selection (mouse: press + move ≥ 6 px; a plain click still focuses the slide; touch: long-press
  ~350 ms then drag, or the `✂ 영역` toolbar toggle; Esc cancels). On release a small floating menu: `📎 첨부` (POST regions → chip in
  the composer), `💬 이 부분 설명해줘` (attach + send with that text), `✕`. Works at every zoom level; the rect is stored normalised.
- Composer: chips row (thumbnail, "p.12 영역" / file name, ×, click → preview; region chip also scrolls the viewer to the slide and
  flashes the rect). `📎` button → file picker (images, multiple). Paste (Cmd/Ctrl+V) of images into the composer and dropping image files
  onto the chat panel upload them (progress, errors as toasts). Dropping a PDF anywhere keeps uploading it as a new document.
  Max 6 per message (extra ones refused with a toast). Chips persist while switching slides; cleared after a successful send; kept
  (not lost) if the send fails — except those the server answered as `missingAttachments` (a toast names them; back in the
  composer they would make every later question fail).
  The client takes only what the server takes: PNG, JPEG, WebP, GIF, HEIC/HEIF/AVIF (by MIME type, or by extension when the type is
  empty). BMP, TIFF, SVG, … are refused at once with the supported list, and a drag of them is not announced as attachable.
  In a short chat pane (≤ 800 px wide — the stacked layout — or ≤ 640 px tall) the chips are one row that scrolls sideways. An empty
  composer is as tall as its (wrapping) placeholder; with chips the placeholder is `첨부 N개 · 비워 두면 “…”`.
- Drops (one plan, `planDrop`, for the window, the library's drop zone and course cards): PDFs → lectures; images → the open
  lecture's question, or an info toast in the library ("이미지는 강의를 연 뒤 놓으면 질문에 첨부돼요", the overlay's words); other
  files → an error naming them. Opening a newly uploaded PDF never discards chips: when the open lecture has attachments waiting (e.g.
  images dropped together with the PDF), the lecture is only added and a toast says so (the top bar's document list opens it).
- The selection's floating menu goes below the selection when the visible part of the viewer has room (it may hang past the slide's
  edge, into the gap / next slide), else above it, and inside its bottom edge only when there is no room either way.
- Message history and the notes tab show the attachments as thumbnails (click → preview; region → jump to slide + flash).

## 22. Lecture recordings — record in the app (live) or upload, local transcription, slide alignment

User request: record the lecture inside the app during class and process it right away (and also upload existing recordings); the tutor
should know what the professor said; replay in sync with the slides. Spikes (session scratchpad `rec/spike-rec.json`,
`rec-live/spike-live.json`, fixtures in `rec/fixtures`) are normative — reuse their verified code and numbers.
Contracts: shared/types.ts (RecordingInfo, TranscriptSegment, RecordingTranscript, SlideViewEvent, AlignmentMarker,
CreateLiveRecordingRequest, AsrModelInfo, AsrStatus, RecordingEvent, RECORDING_ID_RE, LIVE_SAMPLE_RATE, LIVE_SPEECH_IDLE_MS,
MAX_RECORDING_UPLOAD_BYTES), server/internal-types.ts BuildTurnInput.lectureSpeech.

### Engines (all local, no API key)
- ASR: whisper.cpp **v1.9.4** `whisper-cli` as a short-lived sidecar (like the image/PDF workers). Default model
  `large-v3-turbo-q5_0` (574 MB, sha256 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2) + Silero VAD v6.2.0; fast model
  `small-q5_1` (190 MB) recommended on CPU-only machines. Flags: beam default (5), `-l ko|en` forced when known (auto otherwise), VAD on,
  no prompt by default, output `-ojf`. Models are downloaded on first use into `<data>/models/` (desktop: app data dir; web: `<repo>/.cache/models`,
  env EASY_STUDY_MODELS_DIR), resumable, sha256-verified, never bundled; one fetch per file at a time (every model shares the VAD file), a
  corrupt part left by an earlier run is fetched again once from the start, and the reason of a failed download is `AsrModelInfo.error`. Binary lookup: env EASY_STUDY_WHISPER, then a bundled sidecar (desktop),
  then `<repo>/.cache/whisper/bin/whisper-cli` built by `npm run setup:whisper`, then PATH.
- Audio decode (uploads only): minimal LGPL ffmpeg; env EASY_STUDY_FFMPEG, bundled sidecar (desktop), else `ffmpeg` on PATH. One pass →
  `asr.wav` (16 kHz mono s16) + `playback.m4a` (AAC 64k mono, +faststart). Live recordings need no ffmpeg (PCM in, WAV playback).
- Memory: at most one whisper process at a time (queue); live transcription processes ~20–30 s windows cut at silences as audio arrives.
- Upload chunks: a file of ≤ 15 min is one whisper run (whisper keeps the context: cutting a 13-min lecture in two made small-q5_1 go from
  7 % to 16 % Hangul error on the second part); longer files are cut at pauses into ≤ 15-min chunks, and for `small-q5_1` (catalog
  `carryContext`) each chunk gets the last ≤ 200 characters of the chunk before it as `--prompt` (not for turbo: its timestamps got worse; on
  Windows only an ASCII prompt, whisper-cli reads arguments in the system code page).

### Storage `library/<docId>/recordings/<rid>/`
`meta.json` (RecordingInfo minus derived fields), `audio.pcm` (live, append-only, fsync before ack) or `source.<ext>` + `asr.wav` (upload),
`playback.m4a` (upload) — live playback is served as WAV (44-byte header + audio.pcm, Range supported); `transcript.json` (segments with
slide), `timeline.json` (SlideViewEvent[]), `markers.json` (AlignmentMarker[]). Recording ids: `rec-` + date + 4 hex.

### HTTP (remote-mode auth on all; JSON errors)
| GET `/api/asr` | – | `AsrStatus` |
| POST `/api/asr/models/:modelId/download` | – | 202 (progress via GET /api/asr) |
| DELETE `/api/asr/models/:modelId` | – | 204 |
| GET `/api/docs/:docId/recordings` | – | `RecordingInfo[]` newest first |
| POST `/api/docs/:docId/recordings` | `CreateLiveRecordingRequest` | 201 `RecordingInfo` (status 'recording'; one live recording per server at a time → 409 `{error, recording}`) |
| POST `/api/docs/:docId/recordings/upload` | raw audio/video body, `X-Filename` | 201 `RecordingInfo` (status 'converting' → transcription → alignment); no whole-request time limit (Node's `requestTimeout` is off, other requests keep a 5-min body deadline), a sender that sends nothing for 60 s → 408 |
| POST `…/recordings/:rid/audio?offset=N` | PCM s16le 16 kHz mono bytes | 200 `{offset}` after fsync; overlap skipped, gap → 409 `{offset}` (tus-like, see the protocol spike) |
| POST `…/recordings/:rid/slides` | `SlideViewEvent[]` | 204 |
| POST `…/recordings/:rid/pause`, `…/resume`, `…/stop` | – (`stop`: optional `{bytes}`) | `RecordingInfo` (a stop without `bytes`, from any client, ends it with the audio stored) |
| GET `…/recordings/:rid/events` | – | SSE `RecordingEvent` (`event: ping` every 10 s; `?since=<segment id>` / Last-Event-ID replay) |
| GET `…/recordings/:rid` / `…/transcript` | – | `RecordingInfo` / `RecordingTranscript` |
| GET `…/recordings/:rid/audio` | – | playback (Range; unsatisfiable → 416 with `Content-Range: bytes */size`) |
| PUT `…/recordings/:rid/markers` | `AlignmentMarker[]` | `RecordingTranscript` (re-aligned with markers as hard constraints) |
| POST `…/recordings/:rid/align-ai` | `{ provider, model? }` | 202 (LLM alignment via the user's CLI, hybrid with the local DP; progress via events) |
| PATCH `…/recordings/:rid` | `{ title }` | `RecordingInfo` |
| DELETE `…/recordings/:rid` | – | 204 (stops a running recording/job first) |
Crash safety: after a restart, live recordings left in 'recording'/'paused' stay resumable (the client resends from the acknowledged offset);
queued/running transcriptions resume.

### Alignment
- Live: the slide-view timeline is the prior (segment → the lecture slide at its midpoint + 2 s: the student follows the professor's screen
  1–4 s late), then the local DP may override it only with strong lexical evidence (e.g. a short look-ahead by the student); markers always
  win. The lecture slide comes from the student's views, measured over runs of one slide (views of other slides adding up to < 2 s in
  between do not split a run): the next slide after 5 s, a jump ahead after 15 s (both counted from the furthest slide the lecture had
  reached, also straight out of a back-visit), back to a slide the lecture had already reached (the end of a back-visit) after 2 s. A look
  back (back-visit) is the lecture's (the professor went back and the student followed) when the speech said during it supports it: ≥ 3 s
  and a summed margin ≥ 2 of the weighted z-scores over every rival (the lecture slide, the next one, up to the slide the student returned
  to); or does not contradict it: ≥ 6 s, ≥ 2 segments, no rival ahead in the sum (margin ≥ 0), at most 15 % of the segments clearly about
  a rival; or after 30 s whatever was said. Otherwise it is the student's own excursion. "Does not contradict" has no tolerance below 0:
  whisper writes a Korean lecture's English terms in Hangul, so the professor's sentences about the lecture slide score only a little
  above the looked-at one (a tolerance growing to −1.5 per segment took 20–50 % of the student's own 15–25 s looks for the lecture's on
  real transcripts); the price is that a short back-visit with only filler speech is often left to the 30 s rule. The DP enters a
  back-visit its speech adopted for free (no cost of going back), so only the prior bonus decides against the text; one adopted only by
  the 30 s rule keeps that cost, so clear speech about the lecture slide still wins while the student re-reads an old slide.
  Each transcribed window is labelled with this prior over the last 80 segments; when it changes for segments already shown (a look
  back became the lecture's once enough was said), a realign runs at once instead of waiting for the 60 s throttle.
- Upload: local lexical DP (TF-IDF char n-grams + Hangul-transliteration skeleton + monotonic Viterbi with skip/back/off-slide states; spike
  code) on digest + slide text. Optional "AI 정밀 정렬": hybrid DP+LLM (haiku, rich deck, ≤150-segment chunks, independent not "refine").
- Markers: "여기부터 p.N" from the UI are hard constraints; re-solving takes < 1 s for 60 minutes. A marker is "slide N starts here" (the
  speech before it stays below N) only when N is beyond every earlier start marker and not 3 or more slides behind the furthest slide
  the alignment without slide markers reached before it (JUMP_BACK_MARGIN); otherwise it is a jump back to an earlier slide (only that sentence is pinned). In
  live recordings it must also be beyond the timeline's furthest slide before the marker (a marker on the professor's return to a slide
  1–2 back is a jump back, and so is one in the middle of the slide being shown), and a marker also replaces the timeline prior from its
  sentence on while the student kept viewing the same slide. So when the student read ahead (the timeline reached p.N early), "p.N"
  where N really starts only pins that sentence: the early lines are corrected with a marker for the earlier slide on the first of them.
- Measured with the shipped ASR config (uploads of the synthetic L7 lecture): Korean 66–68 % of speech time on the exact slide (82 % within
  ±1), English 82 %; five correct markers → 84 % Korean.

### Tutor context (context.ts)
For each slide of the focus window that has speech: "What the professor said on slide N (lecture recording, may contain transcription errors;
English terms may be written in Hangul):" + text of the newest recording with speech on that slide (two recordings of one lecture would
repeat it; cap 1500 chars/slide, total 4000). While a live recording of the document runs (audio, a pause or a resume
arrived within LIVE_SPEECH_IDLE_MS = 10 min; a recording whose device is gone stops counting): "The last N minutes of the lecture:" + text
(cap 3000 chars) before the question. A question first cuts the audio not in a window yet into one (at its last pause) and waits up to 6 s
for it, so the speech right before the question is included. Priming: one line saying recordings exist. System prompt: one bullet
about using lecture speech.

### Web
- Record button (🎙) in the chat header / top bar: first use shows a one-time notice to check the professor's/school's recording rules; mic
  permission; level meter, timer, pause/stop; live transcript strip; recording continues while switching slides/tabs; if the page reloads the
  recorder offers to continue the same recording (resend from the acknowledged offset; IndexedDB keeps unacknowledged audio).
  Capture: getUserMedia → AudioContext({sampleRate: 16000}) → AudioWorklet → s16le chunks (~1–5 s) → offset POSTs, one in flight.
  Slide changes of the viewer post SlideViewEvents on the recording clock (captured frames / 16 000); the first one is the slide shown
  when the recording actually starts (after the permission prompt), not the one of the click, and views within its first 2 s replace
  it as the start (align.ts START_SETTLE_SEC: a smooth scroll after a page jump passes the slides in between).
  Pause releases the microphone and the screen wake lock ("계속" opens the microphone again). Audio the local store cannot write (quota,
  WebKit losing IndexedDB) stays queued in memory in order and is written first once it can; past 60 s the recording pauses with the
  reason (the clock never runs ahead of the audio the server will get); a failing stop still releases the microphone.
  A live recording the server holds for another device or browser (gone: a dead laptop, cleared storage) can be ended from here:
  "녹음 끝내기" in its menu, also offered when a start is refused with 409 — after a confirmation (that device's audio not uploaded is lost)
  it POSTs …/stop without `bytes`.
  Not available on insecure origins (plain-HTTP LAN): explain HTTPS is needed.
- Upload: "녹음 파일 올리기" per lecture (library row menu and the recording tab).
- Right-pane tab **녹음**: recordings list (status/progress, model download prompt with size), transcript for the focused slide (or all, with
  slide headers), click a segment → play from there; player (play/pause/seek; a "1.25×" button opening a speech bubble with a 0.5×–3×
  slider whose thumb follows the pointer and is drawn onto the tick marks near it (the rate follows in 0.05 steps, applied while dragging),
  arrow keys in 0.05 steps, or typed; any rate in range is remembered) with "슬라이드 따라가기" (the viewer follows the slide being
  discussed; a live recording's WAV has the length it had when loaded, so the player reloads when the recording ends and before a seek past
  its loaded end); the language whisper detected for 'auto' ("자동 감지 (영어)"); "여기부터 p.N" marker editing; "AI 정밀 정렬" button; settings: model (turbo / small), language, live transcription on/off.
- Tutor: questions during a live recording automatically include the recent speech; a chip in the composer shows "🎙 최근 3분 포함".

### Desktop shell + CI
- macOS: Info.plist NSMicrophoneUsageDescription (Korean + English), entitlement com.apple.security.device.audio-input (hardened runtime);
  Linux: enable media stream + permission-request handler allowing audio capture for the local server origin (and a remote origin the user
  connected to over HTTPS); Windows: PermissionRequested → allow microphone for those origins. Since 0.5.1 "the local server origin"
  means the loopback origin the shell itself runs: its own server or its loopback proxy for a plain-http remote (§16, §19) — only
  the page the main window may show, and only while it is the shell's own child. A plain-http remote's page is never trusted
  directly (it is not a secure context anyway).
- CI builds whisper-cli v1.9.4 per target (Metal on macOS; CPU elsewhere; on Windows with OpenMP and MSVC's vcomp140.dll next to it,
  since ggml's own busy-waiting thread pool hangs there when threads outnumber free CPUs) and the minimal LGPL ffmpeg, caches them, ships them like es-node
  (resources on macOS/Windows, externalBin on Linux), and passes EASY_STUDY_WHISPER / EASY_STUDY_FFMPEG to the server. Licenses in
  THIRD_PARTY_NOTICES.md (whisper.cpp MIT, ffmpeg LGPL build config + source offer, Silero VAD MIT, models MIT/OpenAI).

## 23. Token usage and subscription limits

Students on a Claude or ChatGPT subscription watch their plan's usage limits. A question sends about 40–55k input
tokens (mostly read from the prompt cache after the first turn) and gets a few hundred to ~1k output tokens back; the
app shows what each answer and each session used, live, and the plan's limits when the CLI reports them.

### Contract (shared/types.ts, arithmetic in shared/usage.ts)
- `TokenUsage {input, cachedInput?, cacheWrite?, output, reasoning?}`: `input` / `output` are totals (the cache and
  reasoning included); the parts are omitted when zero or not reported.
- `UsageLimits {at, status: 'ok'|'warning'|'reached', windows: [{minutes, usedPercent, resetsAt?, label?, binding?}]}`:
  windows by length (300 = 5 hours, 10080 = a week), shortest first, `usedPercent` 0–100 (can exceed 100), `label` for a
  model family's own limit, `binding` on the window a warning / reached status is about when the provider names it.
- `ProviderRunInput.onUsage` (the call's running total; each report replaces the previous one, also before a failure)
  and `onLimits`; `ProviderRunResult.usage` / `limits` are the last values.
- SSE `{type:'usage', usage?, limits?}`: the turn's running total over all its attempts (a failed attempt retried in a
  new conversation counts) and the latest limits, sent whenever either changes. `ChatMessage.usage` (assistant; complete,
  error and aborted alike; zero totals dropped); `SessionSummary.usage {total, priming?}` (priming = the `prime` turns)
  and `limits` (the latest of that session), kept in the session file. Files without them load unchanged; malformed ones
  are dropped on read. Limits are the account's, not the session's: the web shows the newest report of the provider.
- Digest: every call (failed ones and the lecture summary too) adds to digest.json `usage` = `DigestInfo.usage` of the
  latest run; a new run starts over.

### Where the providers find them
- **claude-code** (verified with claude 2.1.280): `stream_event` message_start (`event.message.usage`) opens a model
  call, message_delta (`event.usage`, cumulative for that call; null = unchanged) updates it; calls are summed live (the
  `assistant` snapshots repeat a call's unfinished usage per content block and are not counted), and `result.usage`
  (every call of the run) replaces the sum. Input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (Claude counts the cache apart); `output_tokens` include thinking (`output_tokens_details.thinking_tokens`).
  `total_cost_usd` is a list-price estimate, not what a subscription costs: not shown. Limits: the run's (last)
  `rate_limit_event.rate_limit_info` (claude.ai subscriptions only, after the last call): `unifiedWindows.five_hour` /
  `seven_day` (utilization as a fraction, resetsAt in Unix seconds), plus the top-level `rateLimitType` / `utilization`
  (the binding window, marked `binding` unless the status is ok; `seven_day_opus` / `seven_day_sonnet` labelled) when not
  among them; status `allowed` / `allowed_warning` / `rejected` → ok / warning / reached. An API-key session (no windows)
  gives no limits.
- **codex** (verified with codex-cli 0.154): `turn.completed.usage` `{input_tokens, cached_input_tokens,
  cache_write_input_tokens, output_tokens, reasoning_output_tokens}` (cached and reasoning are parts). `codex exec --json`
  reports no limits, and a resumed thread's turn.completed may be the thread's running total. So once a non-ephemeral run
  has ended (a stopped one too: Codex records every finished model call), its thread's rollout is read
  (server/providers/codexRollout.ts, at most 1.5 s):
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local creation time>-<thread id>.jsonl`, the date taken from the UUIDv7 thread
  id (±1 day), resumed turns appended to it. Only what the run appended counts (from the file's size before a resumed
  run; not by timestamps: a question sent right after priming starts milliseconds after the priming's records), at most
  its last 256 KB: the last `token_usage_record.turn_token_usage` (cumulative within the turn) is the turn's usage, the
  last `event_msg` `token_count.rate_limits` the
  limits (`limit_id` "codex" or none preferred over a model bucket, which is labelled with its `limit_name`; windows by
  `window_minutes`, never by primary / secondary; `rate_limit_reached_type` → reached). A new thread's turn.completed usage
  is reported at once; a resumed thread's only from the rollout (left out without it). Ephemeral runs (digests): usage
  from turn.completed, no limits. Anything unexpected in the rollout gives nothing.
- **anthropic-api**: the same message_start / message_delta tracking; `finalMessage().usage` is the total.
  **openai-api**: `response.usage` of response.completed / incomplete / failed (`input_tokens_details.cached_tokens`,
  `output_tokens_details.reasoning_tokens`). Their rate-limit headers are per-minute organisation limits, not
  subscription windows: not read.

### Web
- Under each answer a muted line "입력 4.7만 (캐시 4.1만) · 출력 820", growing while it streams; tooltip: the exact numbers
  (cache read / written, reasoning, total).
- Under the composer: "이 세션 12.3만 토큰" (saved totals + the streaming turn; tooltip: exact numbers, the priming part,
  and how many answers were saved without usage, e.g. before §23) and the limits "5시간 한도 12% · 주간 9%" (tooltip:
  provider, report time, each window's reset time). The limits are the newest report of the session's provider from any
  session seen (useStudySession; cached per device in localStorage), not the session's own; a report an hour old or
  older adds "14:30 기준". From 80 % a window is shown in the warning color, from 100 % (or reached) in the danger color,
  and says when it resets ("5시간 한도 100% (14:30 초기화)"). A provider warning / reached marks the window it is about
  (`binding`, else the fullest) only while that window lasts; without windows it stands alone for a day. Windows whose
  reset time has passed are hidden (they started over), and the line re-renders by itself at the next reset. The items
  wrap as text (a separator ends the item before it); the tooltips are also the items' aria-labels.
- Korean counts (web/src/lib/usage.ts): below 1만 with separators ("9,876"), then 만 with one decimal below 100만
  ("4.7만", "123만"), then 억.
- The 정리본 status line shows "토큰 12.3만" for the latest run (tooltip: exact numbers).

## 24. Desktop updates, settings, changing the connection

From 0.5.0 the desktop app updates itself, has settings (⚙ in the web UI, "⚙ 앱 설정" in the chooser) and an obvious
way back to the chooser. The capability invariant of §19 is unchanged: `capabilities/chooser.json` still grants nothing,
only the chooser has IPC, and the updater plugin is driven from Rust only (its JS commands are denied to every page, the
chooser included). The web half (settings dialog, theme, banner, hooks) is in §8 "Settings, theme and the desktop bridge".

### Shell ↔ page (desktop/src-tauri/src/bridge.rs; pages served over http(s) never get IPC)
- **Marker**: `initialization_script` of the main window, main frame only (never page-N windows):
  `window.__EASY_STUDY_DESKTOP__ = Object.freeze({v:1, version, os})`. `version` is `package_info().version` at run time
  (never a literal), `os` macos|windows|linux; both JSON-quoted. desktop.test.mjs checks it never names `__TAURI`.
- **Pushed state**: `window.__easyStudyDesktopState = {v:1, theme, connection:{kind, origin, startup}, update, justUpdated,
  share?}` then `dispatchEvent(new Event('easy-study-desktop'))`, serde_json through `eval` (never text built from what a page
  said), guarded by `location.origin === <origin>` in the page. Sent on every page load (PageLoadEvent::Finished) of the
  allowed origin and on every change; download progress at most every 250 ms. `justUpdated` is in every push of the
  launch (macOS may report two loads when the server was ready before the chooser, and a login screen may come first). The chooser is never pushed to (it polls
  get_state). Another computer's page gets `update` without notes, date, checkedAt, lastError, lastErrorAt.
  `share` = `{on, running, urls, code}` (0.5.1) only for the page of this computer's own server (`is_local`): `on` = desktop.json
  `share`, `running` = the server runs shared right now (`share_urls.is_some()`; the page tells "restart pending" from
  "shared but no address, e.g. offline" by it), `urls` = the running shared server's addresses (empty when not shared or
  without a network), `code` = the access code only for a short while after the page asked with `share/reveal` and the user
  agreed in the native dialog that action shows (null otherwise: an XSS in the web client must not turn a page-bound session
  into the code that lets any device in — the dialog, not the 60 s window, is the gate; the chooser, a trusted bundle, always
  shows it). Never to a remote or proxied page.
  `connection.origin` of a page shown through the loopback proxy is the remote's origin (kind "remote"), not the proxy's.
- **UpdateState** (update.rs, camelCase, optional fields left out, never null): phase idle|checking|latest|available|
  downloading|downloaded|installing|error, current, version?, notes? (latest.json is not signed: plain text only, ≤2000
  chars), date?, releaseUrl, received, total?, error?, install inApp|download|none, reason?, kind app|nsis|appimage|deb|
  rpm|arch|none, checkedAt?, auto, dismissed, lastError?, lastErrorAt? (dates RFC 3339 UTC). `error`, `reason` and
  `lastError` are always one of the fixed Korean texts of update.rs (no paths, no user names); raw errors go to
  shell.log only. The web shows `reason` whenever install is download.
- **Actions**: a navigation to `<allowed origin>/__easy-study-desktop/<action>`: choose, forget-choice, check-update,
  install-update, dismiss-update, cancel-update, theme/system|light|dark, and (0.5.1, honoured only from this computer's
  own page; a remote or proxied page's are logged — rate-limited — and ignored) share/on (native confirm first),
  share/off, share/reveal (native confirm, then the code is pushed for ~60 s), share/reset-code. `bridge::classify` runs first in
  `allow_main_navigation`: a known action on the allowed http(s) origin is done on its own thread and the navigation
  cancelled; the prefix anywhere else (another origin or scheme, an unknown action) is cancelled and never opened in the
  browser; the query is ignored. `new_window` and the page-N windows refuse the prefix without acting (answers open links
  with target=_blank). The server answers the prefix with 204 in every mode, so a navigation that gets through changes
  nothing. `theme/*` and `forget-choice` do nothing when the value is unchanged; a page's `theme/*` is applied at most
  once a second (the newest one asked for wins), so a page toggling in a loop cannot rewrite desktop.json or flip every
  window each time.
- **Hooks the shell calls** (eval, worker threads only: `eval_json` needs the main thread to answer and must never run
  on it): `__easyStudyBusy()`, `__easyStudyOpenSettings()` (only `true` counts as handled; otherwise the chooser opens
  with its 앱 설정), `__easyStudyAllowLeave()` (before show_chooser, reload and the install navigation, only after the
  user agreed in a native dialog, so beforeunload never asks twice).
- **What a page can start** (PageDialogs, unit-tested): a remote page's dialogs at most one per 60 s, and after the user
  said no (or a Block) none from that origin for the rest of the session: state is still pushed and the banner, menu
  and chooser keep working. This computer's page (the trusted bundle) only a 3 s gap and never refused, so the user's
  own banner works after one 취소. The check happens once, when the action arrives: one flow can show its confirm and
  its busy dialog. A page opens the release page at most once a minute, and its `install-update` with nothing found
  counts as a manual check (at most one request to GitHub every 30 s). Log lines a page can cause (reserved paths,
  blocked navigations, page loads, actions, "already on its way", failed checks, theme changes) are limited to 20 per
  kind and minute (shell.log is rotated at launch only).

### Busy gate (bridge::decide, unit-tested)
Asked before an install (and again after the download), and since 0.5.1 before the restart of this computer's server for
"다른 기기에서 접속 허용" or a new access code (`Restart::Share`: the same table, the texts say "다시 바꿔 주세요" / "그래도
서버를 다시 시작할까요?" instead of installing): the page (`__easyStudyBusy`) and this computer's server (`GET
/api/desktop/busy` over loopback; desktop mode only, no side effects, never asrStatus(); with `Authorization: Bearer <code>`
when the server is shared — a missing code is "no answer" = Warn, never Block).

| Answer | Result |
|---|---|
| page recording (any recorder phase but idle, paused too) | Block "강의를 녹음하는 중이에요…" (native OK dialog) |
| page unsentSeconds > 0, finishing > 0 or recordingUploads > 0 | Block (audio only the page has) |
| page answering or PDF uploads | Warn, unless the page started the install (it asked the user itself) |
| page without an answer (older remote UI, hung) / server without an answer | Warn ("확인하지 못했어요") |
| server live recording (recording or paused) that the page does not hold | Warn naming it: "‘{doc}’의 ‘{title}’ 녹음이 아직 끝나지 않았어요" (it resumes after the restart; a forgotten one must not block forever) |
| server transcriptions, digests, chat turns, model downloads | Warn listing them (chat turns less the page's own answer: "다른 창에서 답변 N개…") |
| nothing | Go |

Warn is a native [설치하고 다시 시작] [취소]. A lying page can only hurt itself (a "busy" answer blocks its own install;
the chooser, where no page is asked, still installs). Menu "연결 대상 바꾸기…" and "새로 고침" ask first
([바꾸기]/[다시 고침] [취소]) when the page holds audio; a page-started choose is not asked again (the page asked).

### Updater (desktop/src-tauri/src/update.rs; tauri-plugin-updater ~2.12, native-tls)
- Config (tauri.conf.json `plugins.updater`, asserted exactly by desktop.test.mjs): the pubkey of
  `~/.tauri/easy-study-updater.key.pub` (key id 8428B81A03E58D53), the one endpoint
  `https://github.com/Wooangha/easy-study-releases/releases/latest/download/latest.json`, `requireSignedVersion` (the
  signature's trusted comment binds the version), `windows.installMode` passive. No dangerous* keys, no allowDowngrades,
  no createUpdaterArtifacts (so CI never needs the private key). No runtime or env override exists.
- Install kind (pure `install_kind`, unit-tested): macOS only a real `…/X.app/Contents/MacOS/<bin>` counts (`cargo run`
  would otherwise have target/debug replaced), a translocated or /Volumes copy gets download with "앱을 ‘응용 프로그램’
  폴더로 옮긴 뒤…"; Windows NSIS inApp; Linux AppImage with `$APPIMAGE` inApp, without it (extracted) download; Arch
  (pacman marker; its binary says Deb), deb and rpm download: they check through the `linux-<arch>-appimage` key and are
  never installed by the plugin (no root prompts). Debug builds are download.
- Checks: 15 s after launch, then every 6 h by wall clock; never in smoke runs or debug builds, or with `updateCheck`
  false. A manual check (chooser, menu, page) runs at most every 30 s. Timeouts: 20 s for latest.json, 15 s connect and
  60 s per read for every request (the download too), plus a watchdog that drops the download after 90 s without data,
  and 취소 (cancel-update). The plugin reports every non-2xx as ReleaseNotFound: one GET of the endpoint decides (404 =
  latest, before the first public release too; anything else = the network error). Automatic failures are silent
  (lastError); manual ones show the fixed text.
- The found Update and its verified bytes (with their version) sit under one mutex: a check that finds another version
  drops the bytes. After download() the signature's trusted comment (decoded with minisign-verify as the plugin does:
  the third line; the first, untrusted one is not signed and may say anything) must name this build's file suffix
  (`_aarch64.app.tar.gz`, `_x64.app.tar.gz`, `_x64-setup.exe`, `_amd64.AppImage`, `_aarch64.AppImage`) and the version.
- Install flow (`request_install`, a worker thread, single-flight with an RAII flag released on every return path):
  1. check if nothing is held; not inApp → open releaseUrl (a page: once a minute) and stop;
  2. another computer's page → native confirm "easy-study {v} 버전을 설치하고 앱을 다시 시작할까요?";
  3. busy gate; 4. download (phase downloading, progress pushed) unless the bytes are held; 5. busy gate again (Block:
  stay "downloaded"; Warn: ask only if it differs from what was accepted);
  6. phase installing (the chooser shows the busy line from it), `__easyStudyAllowLeave`, show_chooser, desktop.json
  `updatedFrom = current`; 7. server::stop on every OS (Windows' install() exits without RunEvent::Exit);
  8. `update.install(bytes)` (macOS may ask for an administrator password on the main thread; hence the worker);
  `on_before_exit` is a no-op, so a Windows installer that fails to start leaves the window visible;
  9. `request_restart()` (runs RunEvent::Exit). On failure: phase error with the fixed text, bytes kept (다시 시도 does
  not download again), updatedFrom cleared, the window shown and focused.
- While files are replaced the app cannot quit: CloseRequested of the main window and ExitRequested (unless the restart
  code) are prevented, SIGTERM waits up to 60 s. On macOS the app menu's quit item is the app's own for this reason;
  the Dock's Quit and logout (`terminate:`) cannot be held off.
- Next launch: `updatedFrom` ≠ current → justUpdated pushed during that launch (one toast per tab); `updatedFrom` =
  current → the update did not take: logged, phase error "업데이트가 끝나지 않았어요 (지금 {cur}). 다운로드 페이지에서
  직접 설치해 주세요." (an automatic check that fails keeps it; one that finds the version shows it as the reason), and
  one-click install is off for the session (no download-and-restart loop). Stale `tauri_current_app*` /
  `tauri_updated_app*` folders older than a day are removed (temp dir; on Linux also ~/.cache and the AppImage's folder),
  and on Windows `%TEMP%\easy-study-<v>-updater-*` with v ≤ the running version.
- Not done: restoring a missing or truncated `$APPIMAGE` from the plugin's backup (an AppImage that cannot start runs
  none of our code; the backup stays in `tauri_current_app*`).
- Linux: the plugin's check() sets SSL_CERT_FILE / SSL_CERT_DIR to Debian's paths when unset (from a worker thread, for
  good). `update::keep_ssl_env()`, the first line of main(), sets them to what openssl-probe finds on this system
  instead (only paths that exist), and server::child_env and pathenv's login shell remove them again unless the user had
  set them. (A process restarted after an update inherits them as if the user had: they name existing CA files.)
- Menu: "설정…" (⌘, / Ctrl+,) and "업데이트 확인…" (its text becomes "업데이트 설치 ({v})…" once a version is found:
  the way in when the window shows an older remote UI) in the app menu (macOS) or 연결 (Windows/Linux). Every menu
  flow that can block runs on its own thread, one at a time per item (a slow check never holds up 연결 대상 바꾸기…).
  "업데이트 확인…" waits for a check that runs, then checks, and answers in native dialogs; it says "최신" only when a
  check said so (otherwise the failure, or lastError of an automatic check it waited for).
- The chooser: connect_local / connect_remote refuse while an update replaces the app. New commands (own origin only):
  check_update, install_update, cancel_update (all return at once; the chooser polls get_state every second),
  set_theme, set_update_check, forget_choice, open_logs. get_state gains version, theme, updateCheck, update, focus
  (consumed once), previous ("방금까지 연결"), notice.

### Theme and connection
- desktop.json `theme` ("" = system, light, dark) is applied with `AppHandle::set_theme` in setup before the first
  window and on every change; no window builder gets `.theme()` (on Windows a window's own theme would win over later
  app-wide changes). Pages get it pushed; the chooser sets `data-theme` from get_state (dual-selector tokens as in §8).
- "다음에도 바로 연결" stays checked by default; the ways back: ⚙ 설정 › 연결 대상 바꾸기…, "다음 실행 때 선택 화면
  보기" (forget-choice), "다른 서버에 연결…" on the login screens, the chooser's 앱 설정 (시작할 때), the menu (⌘⇧K).
- Auto-connect loop breaker: `autoConnectPending` is written before a remembered connection opens at launch and cleared
  when its page has been up 30 s, on a normal exit and before an update restart. Still set at the next launch (the app
  died or was force-quit right after connecting) → the chooser comes first with a note.
- desktop.json keeps fields it does not know (`#[serde(flatten)] extra`): a downgrade does not drop a newer build's settings.
- (0.5.1) desktop.json `share: bool` (absent = off; the file of a fresh install stays `{"mode":""}`) and `proxyPort`
  (the loopback proxy's remembered port). The access code is never in desktop.json: it is the server's `<library>/.auth.json`,
  per library (a library change keeps `share`; a new library gets a new code). `connection.origin` rule: the remote's origin
  for a proxied page, the page origin otherwise; the page-side origin guard still uses the page's own origin.

### Releases (desktop/scripts; runbook in docs/HANDOFF.md)
- CI (desktop.yml) packs the macOS updater archive `easy-study_<v>_<arch>.app.tar.gz` right after the build: one top
  folder `easy-study.app/`, no `._` files, no xattrs, no hard links (tar-rs would resolve them against the working
  folder), Info.plist version = package.json. The Windows installer and the AppImages are the updater artifacts as they
  are. CI never signs for the updater and has no key; every action is pinned by commit SHA (tag in a comment).
- The public repository `Wooangha/easy-study-releases` holds installers only (the source stays private): the 5 updater
  artifacts, dmg/deb/rpm, the Arch package and its PKGBUILD (whose sources point there), the FFmpeg source (LGPL), and
  SHA256SUMS.txt and latest.json made by the script. latest.json has exactly the keys darwin-aarch64, darwin-x86_64,
  windows-x86_64, windows-x86_64-nsis, linux-x86_64-appimage, linux-aarch64-appimage (never a bare linux-<arch>, which
  deb/rpm installs would fall back to).
- `publish-release.mjs` (dry run by default; `--publish --commit <sha> --notes <file>` for real) refuses unless: the
  draft and every asset were uploaded by github-actions[bot] (state uploaded, a sha256 digest) during a successful
  desktop.yml run for the tag's commit; the tag commit on GitHub equals the local tag, is an ancestor of origin/main and
  GitHub's main, and equals `--commit` (what the user reviewed); package.json and the updater config at the tag match;
  every asset name is allowlisted and all required ones are there; downloads (by asset id) match the digests; the macOS
  archives hold the tag's version (Info.plist) and so does the Windows installer (its version resource's
  ProductVersion). The AppImages are squashfs images and are not looked into: only their name, the CI run and the
  digest vouch for them. It signs with `tauri signer sign --app-version` (the key stays a path), verifies each
  signature with the key compiled into the tag (minisign.mjs: key id, `file:` = the asset for that platform key,
  `version:` = the tag's), uploads to a public draft (latest.json last), publishes, fetches latest.json and every URL
  without auth, then publishes the private draft. A published public release is never changed or deleted: a difference
  on a re-run aborts with "cut a new patch version". So a GitHub compromise alone no longer gets code signed (the
  security review's "denial only" holds only with these checks); a compromise of the key does.
- One key, no password, no recovery key (lead's decision). Losing `~/.tauri/easy-study-updater.key` means no release can
  ever be installed in-app again: every 0.5.0+ install trusts only it, and a new key needs a manual reinstall by every
  user. A leak lets whoever can also write the public repo ship code to every install. Keep the offline backup current.
- `update-e2e.mjs` (config / pack / sign / serve) tests the flow with a throwaway key, a separate identifier
  (`dev.easystudy.desktop.e2e`) and an endpoint on 127.0.0.1, built with `build.mjs --tauri-config` (never used by CI);
  it refuses the release key. Still to do by hand on macOS: an update of a quarantined copy started through
  LaunchServices (Gatekeeper, `codesign --verify`, whether the microphone permission survives the new ad-hoc
  signature); on Windows and a Linux AppImage the first real update.
