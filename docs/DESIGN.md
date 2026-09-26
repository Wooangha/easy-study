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
| GET `/api/health` | – | `HealthResponse` |
| GET `/api/docs` | – | `DocMeta[]` newest first |
| POST `/api/docs` | raw PDF bytes, `Content-Type: application/pdf`, header `X-Filename` (URI-encoded original name) | `DocMeta` (201). Max 300 MB. Rejects non-`%PDF` bodies (400). |
| GET `/api/docs/:docId` | – | `DocMeta` |
| GET `/api/docs/:docId/slides/:n.png` | – | PNG (`Cache-Control: public, max-age=31536000, immutable`) |
| GET `/api/docs/:docId/sessions` | – | `SessionSummary[]` newest first |
| POST `/api/docs/:docId/sessions` | `CreateSessionRequest` | `Session` (201). 400 if provider unknown/unavailable. |
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
3. `provider.run(...)` streaming `delta` / `status` events.
4. On success: assistant `status: 'complete'`, `text` = result text, `durationMs`; providerState =
   `nextState` with `resume` from the result (and `appendHistory` for stateless providers).
   On failure: `status: 'error'` + `error`; on abort: `status: 'aborted'`. In both cases the
   providerState is **not** advanced (so the next turn re-primes if priming failed).
5. Persist session, regenerate `notes/<sid>.md` and `STUDY_NOTES.md`, emit `done`.

## 6. Providers (`server/providers/*`)

All CLI invocations use `child_process.spawn` with an argument array (never a shell), `cwd` = doc
dir, stdin piped, stdout parsed as JSONL (ignore non-JSON lines), stderr captured (last 4 KB used for
error messages). Abort → SIGTERM, then SIGKILL after 3 s. Remove `CLAUDECODE` from the child env.

### claude-code (Claude subscription via Claude Code CLI) — verified with claude 2.1.x

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --system-prompt <systemPrompt> --tools Read,Glob,Grep --strict-mcp-config
       [--model <model>]  ( --session-id <new uuid> | --resume <cliSessionId> )
stdin: one line {"type":"user","message":{"role":"user","content":[
         {"type":"text","text":"..."},
         {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}} ]}}
       then close stdin.
```
stdout events: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}`
→ onDelta (insert `\n\n` between separate text blocks); `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{…}}]}}`
→ onStatus; final `{"type":"result","subtype":"success","is_error":false,"result":"…","session_id":"…"}`.
`is_error: true` or non-zero exit → error. Models: `''` (CLI default), `sonnet`, `opus`, `haiku`, `fable`.
maxImagesPerConversation: 48 (round 4; was 90).

### codex (ChatGPT subscription via Codex CLI) — verified with codex-cli 0.154

```
new:    codex exec --json --skip-git-repo-check [--ephemeral] -C <cwd> <policy> <hardening> [-m <model>] [-i <img> ...]
        (prompt on stdin, no positional prompt)
resume: codex exec resume <threadId> - --json --skip-git-repo-check <policy> <hardening>
        [-m <model>] [-i <img> ...]          (the positional "-" = read prompt from stdin)
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
Models: `''` (Codex config default) plus free text. maxImagesPerConversation: 90.

### anthropic-api (needs `ANTHROPIC_API_KEY`; honours `ANTHROPIC_BASE_URL`)
`@anthropic-ai/sdk` streaming Messages API; stateless (sends `history` + current parts every turn);
images as base64 blocks; `cache_control: {type:'ephemeral'}` on the last block of the first (priming)
user turn and on the last block of the current turn. Default model `claude-sonnet-5`.
Models: `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001`. maxImagesPerConversation: 90.

### openai-api (needs `OPENAI_API_KEY`)
`openai` SDK Responses API with streaming, `instructions` = system prompt every turn,
`previous_response_id` for continuation, images as `input_image` data URLs with `detail`.
Default model from `OPENAI_MODEL` or `gpt-5`. maxImagesPerConversation: 150.

`GET /api/health` reports availability: CLI providers run `<cli> --version` (cached 60 s);
API providers check the env key.

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
- Korean UI copy. Light/dark via `prefers-color-scheme`. No external CDNs (everything bundled).

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
  without stack traces or paths.

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
  such as the repo's library/ (the single-instance lock prevents running together with `npm start` on the same folder).

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
CreateLiveRecordingRequest, AsrModelInfo, AsrStatus, RecordingEvent, RECORDING_ID_RE, LIVE_SAMPLE_RATE, MAX_RECORDING_UPLOAD_BYTES),
server/internal-types.ts BuildTurnInput.lectureSpeech.

### Engines (all local, no API key)
- ASR: whisper.cpp **v1.9.4** `whisper-cli` as a short-lived sidecar (like the image/PDF workers). Default model
  `large-v3-turbo-q5_0` (574 MB, sha256 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2) + Silero VAD v6.2.0; fast model
  `small-q5_1` (190 MB) recommended on CPU-only machines. Flags: beam default (5), `-l ko|en` forced when known (auto otherwise), VAD on,
  no prompt by default, output `-ojf`. Models are downloaded on first use into `<data>/models/` (desktop: app data dir; web: `<repo>/.cache/models`,
  env EASY_STUDY_MODELS_DIR), resumable, sha256-verified, never bundled. Binary lookup: env EASY_STUDY_WHISPER, then a bundled sidecar (desktop),
  then `<repo>/.cache/whisper/bin/whisper-cli` built by `npm run setup:whisper`, then PATH.
- Audio decode (uploads only): minimal LGPL ffmpeg; env EASY_STUDY_FFMPEG, bundled sidecar (desktop), else `ffmpeg` on PATH. One pass →
  `asr.wav` (16 kHz mono s16) + `playback.m4a` (AAC 64k mono, +faststart). Live recordings need no ffmpeg (PCM in, WAV playback).
- Memory: at most one whisper process at a time (queue); live transcription processes ~20–30 s windows cut at silences as audio arrives.

### Storage `library/<docId>/recordings/<rid>/`
`meta.json` (RecordingInfo minus derived fields), `audio.pcm` (live, append-only, fsync before ack) or `source.<ext>` + `asr.wav` (upload),
`playback.m4a` (upload) — live playback is served as WAV (44-byte header + audio.pcm, Range supported); `transcript.json` (segments with
slide), `timeline.json` (SlideViewEvent[]), `markers.json` (AlignmentMarker[]). Recording ids: `rec-` + date + 4 hex.

### HTTP (remote-mode auth on all; JSON errors)
| GET `/api/asr` | – | `AsrStatus` |
| POST `/api/asr/models/:modelId/download` | – | 202 (progress via GET /api/asr) |
| DELETE `/api/asr/models/:modelId` | – | 204 |
| GET `/api/docs/:docId/recordings` | – | `RecordingInfo[]` newest first |
| POST `/api/docs/:docId/recordings` | `CreateLiveRecordingRequest` | 201 `RecordingInfo` (status 'recording'; one live recording per server at a time → 409) |
| POST `/api/docs/:docId/recordings/upload` | raw audio/video body, `X-Filename` | 201 `RecordingInfo` (status 'converting' → transcription → alignment) |
| POST `…/recordings/:rid/audio?offset=N` | PCM s16le 16 kHz mono bytes | 200 `{offset}` after fsync; overlap skipped, gap → 409 `{offset}` (tus-like, see the protocol spike) |
| POST `…/recordings/:rid/slides` | `SlideViewEvent[]` | 204 |
| POST `…/recordings/:rid/pause`, `…/resume`, `…/stop` | – | `RecordingInfo` |
| GET `…/recordings/:rid/events` | – | SSE `RecordingEvent` (`event: ping` every 10 s; `?since=<segment id>` / Last-Event-ID replay) |
| GET `…/recordings/:rid` / `…/transcript` | – | `RecordingInfo` / `RecordingTranscript` |
| GET `…/recordings/:rid/audio` | – | playback (Range) |
| PUT `…/recordings/:rid/markers` | `AlignmentMarker[]` | `RecordingTranscript` (re-aligned with markers as hard constraints) |
| POST `…/recordings/:rid/align-ai` | `{ provider, model? }` | 202 (LLM alignment via the user's CLI, hybrid with the local DP; progress via events) |
| PATCH `…/recordings/:rid` | `{ title }` | `RecordingInfo` |
| DELETE `…/recordings/:rid` | – | 204 (stops a running recording/job first) |
Crash safety: after a restart, live recordings left in 'recording'/'paused' stay resumable (the client resends from the acknowledged offset);
queued/running transcriptions resume.

### Alignment
- Live: the slide-view timeline is the prior (segment → slide the student viewed at its midpoint), then the local DP may override only with
  strong lexical evidence (e.g. a short look-ahead by the student), markers always win.
- Upload: local lexical DP (TF-IDF char n-grams + Hangul-transliteration skeleton + monotonic Viterbi with skip/back/off-slide states; spike
  code) on digest + slide text. Optional "AI 정밀 정렬": hybrid DP+LLM (haiku, rich deck, ≤150-segment chunks, independent not "refine").
- Markers: "여기부터 p.N" from the UI are hard constraints; re-solving takes < 1 s for 60 minutes.

### Tutor context (context.ts)
For each slide of the focus window that has speech: "What the professor said on slide N (lecture recording, may contain transcription errors;
English terms may be written in Hangul):" + text (cap 1500 chars/slide, total 4000). While a live recording of the document runs: "The last
N minutes of the lecture:" + text (cap 3000 chars) before the question. Priming: one line saying recordings exist. System prompt: one bullet
about using lecture speech.

### Web
- Record button (🎙) in the chat header / top bar: first use shows a one-time notice to check the professor's/school's recording rules; mic
  permission; level meter, timer, pause/stop; live transcript strip; recording continues while switching slides/tabs; if the page reloads the
  recorder offers to continue the same recording (resend from the acknowledged offset; IndexedDB keeps unacknowledged audio).
  Capture: getUserMedia → AudioContext({sampleRate: 16000}) → AudioWorklet → s16le chunks (~1–5 s) → offset POSTs, one in flight.
  Slide changes of the viewer post SlideViewEvents on the recording clock (captured frames / 16 000).
  Not available on insecure origins (plain-HTTP LAN): explain HTTPS is needed.
- Upload: "녹음 파일 올리기" per lecture (library row menu and the recording tab).
- Right-pane tab **녹음**: recordings list (status/progress, model download prompt with size), transcript for the focused slide (or all, with
  slide headers), click a segment → play from there; player (play/pause/seek/speed) with "슬라이드 따라가기" (the viewer follows the slide being
  discussed); "여기부터 p.N" marker editing; "AI 정밀 정렬" button; settings: model (turbo / small), language, live transcription on/off.
- Tutor: questions during a live recording automatically include the recent speech; a chip in the composer shows "🎙 최근 3분 포함".

### Desktop shell + CI
- macOS: Info.plist NSMicrophoneUsageDescription (Korean + English), entitlement com.apple.security.device.audio-input (hardened runtime);
  Linux: enable media stream + permission-request handler allowing audio capture for the local server origin (and a remote origin the user
  connected to over HTTPS); Windows: PermissionRequested → allow microphone for those origins.
- CI builds whisper-cli v1.9.4 per target (Metal on macOS; CPU elsewhere) and the minimal LGPL ffmpeg, caches them, ships them like es-node
  (resources on macOS/Windows, externalBin on Linux), and passes EASY_STUDY_WHISPER / EASY_STUDY_FFMPEG to the server. Licenses in
  THIRD_PARTY_NOTICES.md (whisper.cpp MIT, ffmpeg LGPL build config + source offer, Silero VAD MIT, models MIT/OpenAI).
