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
- External tools: poppler (`pdftoppm`, `pdftotext`, `pdfinfo`) — `brew install poppler`.
  Image compositing/resizing: `sharp`.
- Everything the user creates lives in the **library dir** (`EASY_STUDY_LIBRARY`, default
  `<repo>/library`, git-ignored).

## 2. Library layout

```
library/<docId>/
  doc.json                 DocMeta (shared/types.ts)
  source.pdf
  slides/001.png ...       full resolution, long edge 1600px (pdftoppm -scale-to 1600)
  sheets/sheet-01.png ...  overview contact sheets, 2x2 slides per image, each cell labelled
                           with its slide number; long edge <= 1600px
  sheets/sheets.json       [{ "file": "sheet-01.png", "fromSlide": 1, "toSlide": 4 }, ...]
  text/001.txt ...         pdftotext -layout output per page ('' if none)
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

1. `pdfinfo source.pdf` → page count (`Pages:`) and page size (`Page size: W x H pts`) → aspectRatio.
2. `pdftoppm -png -scale-to 1600 source.pdf slides/p` → rename outputs (`p-01.png`, `p-1.png`, … padding
   varies with page count) to `slides/%03d.png`. Update `progress` periodically (count files while it runs).
3. `pdftotext -layout source.pdf -` → split on form feed `\f` → `text/%03d.txt` (trimmed).
4. Build contact sheets with sharp: groups of 4 consecutive slides, 2 columns x 2 rows, each cell
   800px wide (height by aspect), 8px white gutter, and a readable label "Slide N" (dark badge,
   top-left; render the label as an SVG overlay composited by sharp). Write `sheets.json`.
5. `status: 'ready'` (or `'error'` with `error` message; a missing poppler binary must produce the
   message `poppler is not installed (brew install poppler)`).

On server start, any doc left in `processing` (crash mid-ingest) is re-processed.

## 4. HTTP API (`server/index.ts`)

All JSON. Errors: HTTP 4xx/5xx with `{ "error": string }`. Ids validated with `DOC_ID_RE` /
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
maxImagesPerConversation: 90.

### codex (ChatGPT subscription via Codex CLI) — verified with codex-cli 0.154

```
new:    codex exec --json --skip-git-repo-check --sandbox read-only -C <cwd> [-m <model>] [-i <img> ...]
        (prompt on stdin, no positional prompt)
resume: codex exec resume <threadId> - --json --skip-git-repo-check -c sandbox_mode="read-only"
        [-m <model>] [-i <img> ...]          (the positional "-" = read prompt from stdin)
```
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
priming later sessions (text instead of overview images — cheaper/faster, and it fixes symbols that
pdftotext garbles, e.g. α ε ∪ ∈), the focused-slide material, the course context (§12), and the student
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
