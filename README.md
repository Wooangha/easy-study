# easy-study

강의 PDF를 슬라이드 단위로 공부하는 로컬 웹앱이에요. 왼쪽에는 슬라이드가 스크롤되고, 오른쪽 채팅은 **지금 보고 있는 슬라이드**를 알고 답해요.
LLM은 이미 로그인된 **Claude Code**(Claude 구독)나 **Codex**(ChatGPT 구독) CLI를 그대로 쓰고, API 키가 있으면 Claude API나 OpenAI API도 쓸 수 있어요.

```
┌───────────────────────────────┬────────────────────────────┐
│  slide 6                      │  채팅 | 정리본 | 노트       │
│ ┌───────────────────────────┐ │  p.7 / 49 · 📌 · 앞뒤 ±1   │
│ │ slide 7  (지금 보는 장)    │ │  Q (p.7) ...               │
│ └───────────────────────────┘ │  A ... 마크다운 + 수식 ... │
│  slide 8                      │  [p.7] 질문 입력 …       ⏎ │
└───────────────────────────────┴────────────────────────────┘
```

## 빠른 시작

필요한 것:

- Node.js 22.18 이상 (macOS의 Node 26, Linux Docker의 Node 22.18·26에서 확인했어요)
- poppler (`pdftoppm`, `pdftotext`, `pdfinfo`)
- 아래 중 하나 이상
  - `claude` CLI 로그인 (Claude Code)
  - `codex` CLI 로그인 (Codex)
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`

poppler 설치는 OS마다 달라요.

macOS:

```bash
brew install poppler
```

Ubuntu / Debian:

```bash
sudo apt install poppler-utils
```

Fedora는 `sudo dnf install poppler-utils`, Arch는 `sudo pacman -S poppler`예요. 글꼴을 내장하지 않은 PDF가 macOS와 똑같이 보이게 하려면 `fonts-urw-base35`도 설치하세요.

Windows는 `winget install oschwartz10612.Poppler`(또는 `scoop install poppler`)로 설치하고 PATH에 넣어요.

의존성 설치 (`node_modules`는 OS마다 다르니 다른 컴퓨터에서 복사하지 말고 그 OS에서 직접 설치하세요):

```bash
npm ci
```

공부할 때는 이렇게 실행해요 (빌드한 뒤 가벼운 프로덕션 서버로 실행, http://127.0.0.1:5180):

```bash
npm start
```

이미 빌드했다면 다시 빌드하지 않고 바로 켤 수 있어요:

```bash
npm run serve
```

코드를 고칠 때만 개발 모드를 쓰세요 (Vite가 같이 떠서 메모리를 약 100MB 더 써요):

```bash
npm run dev
```

브라우저에서 PDF를 끌어다 놓으면 슬라이드가 PNG로 변환되고, 바로 질문할 수 있어요.
처음 써 볼 때는 `samples/sample-lecture.pdf`(합성 강의 9장)로 시험해 보세요.

### 다른 OS

- **macOS**: 개발하고 실제로 쓰면서 확인한 환경이에요.
- **Linux**: Docker(Node 22.18, 26)에서 설치, 테스트, 빌드, 서버 실행, PDF 변환까지 확인했어요. Codex의 읽기 제한은 macOS에서만 실제로 확인했어요. Linux에서 Codex가 시작하지 못하면 아래 `EASY_STUDY_CODEX_CONFINE=0`을 참고하세요.
- **Windows**: 실제 Windows에서는 테스트하지 못했어요. 가장 확실한 방법은 **WSL2(Ubuntu)** 안에서 Linux 방법대로 설치하는 거예요. Windows에서 바로 실행한다면:
  - `claude`·`codex`는 공식 설치 프로그램(`.exe`)을 권장해요. npm으로 설치한 `.cmd`도 실제 실행 파일을 찾아 쓰도록 해 뒀지만 검증하지는 못했어요.
  - Windows에서는 Codex의 읽기 제한이 꺼져 있어서 Codex가 사용자 파일 전체를 읽을 수 있어요. 민감한 파일이 있는 계정이라면 Claude Code를 쓰세요.
  - 환경 변수는 PowerShell에서 `$env:PORT=5181; npm start`처럼 지정해요.

## 동작 방식

### 1. 슬라이드 → 이미지

PDF를 올리면 `pdftoppm`이 각 페이지를 1600px PNG로 렌더링하고, `pdftotext`로 텍스트도 같이 뽑아요.
텍스트 추출만으로는 그림·표·수식 기호(α ε ∪ ∈ …)가 깨지거나 빠지기 때문에, LLM에게는 **슬라이드 이미지**를 보여줘요.

### 2. 처음에 전체 슬라이드 전달 (프라이밍)

세션을 만들면 먼저 전체 덱을 LLM에게 넘겨요. 넘기는 내용은 둘 중 하나예요.

- 정리본이 있을 때: 정리본 텍스트만 넘겨요. 더 빠르고 저렴해요.
- 정리본이 없을 때: 목차 이미지(슬라이드 4장을 한 장에 모은 것)와 모든 슬라이드 텍스트를 넘겨요.

LLM은 전체 흐름을 요약해 주고, 이후 질문을 기다려요.

### 3. 질문할 때마다 지금 보는 슬라이드 + 앞뒤 N장

화면 **세로 중앙에 걸친 슬라이드**가 "지금 보는 슬라이드"예요. 📌 고정도 할 수 있어요.

- 질문하면 그 슬라이드와 앞뒤 ±N장(기본 ±1)을 고해상도 이미지로 같이 보내요. 슬라이드 내용은 페이지를 넘어 이어지는 경우가 많기 때문이에요.
- 최근에 이미 보낸 슬라이드는 다시 보내지 않아요. 순서대로 읽어 나가면 한 장 넘길 때마다 새 이미지가 1장 정도만 추가돼요.
- 한 대화에 쌓인 이미지가 한도(Claude Code 48장, Codex 90장)를 넘거나 대화가 너무 길어지면 새 대화로 넘어가요. 이때 덱과 최근 질의응답 요약을 다시 전달해요. 이전 대화를 잃었을 때도 자동으로 새 대화를 시작해요.

### 4. 정리본 (`DIGEST.md`)

LLM이 슬라이드 이미지를 4장씩 읽으면서 장별로 정리해요.

- 원문을 옮겨 적어요. 수식은 LaTeX, 표는 마크다운으로 옮겨요.
- 그림이 무엇을 보여주는지 설명해요.
- 장마다 `핵심:` 한 줄 요약을 붙여요.
- 마지막에 강의 전체 요약도 만들어요.

첫 세션을 만들 때 백그라운드에서 자동으로 시작돼요. 이후에는 다음 용도로 다시 쓰여요.

- 새 세션의 프라이밍
- 질문할 때 슬라이드 자료
- 같은 과목의 다음 강의 컨텍스트
- 화면의 **정리본** 탭 (지금 보는 슬라이드의 정리가 따라 나와요)

### 5. 과목(폴더) 단위 공부

"Compiler" 같은 과목을 만들고 Lec 1, 2, 3 … PDF를 넣으면, 제목 순서(숫자 인식)대로 정렬돼요.

- Lec k를 공부할 때 LLM은 **이전 강의들의 요약**을 받고 시작해요.
- Claude Code와 Codex는 필요하면 이전 강의의 `DIGEST.md`나 슬라이드 이미지를 직접 열어 봐요. 예를 들어 "저번 강의에서 한 FIRST 집합이랑 연결해줘"처럼 물으면 돼요.
- 과목 전체 요약은 `COURSE.md`로 만들어져요.

### 6. 기록 (나중에 다시 보기)

모든 질의응답은 자동으로 저장돼요.

- `library/<문서>/STUDY_NOTES.md`: 모든 세션의 Q&A를 **슬라이드별로** 묶은 노트
- `library/<문서>/notes/<세션>.md`: 세션별 대화 기록
- 화면의 **노트** 탭: 슬라이드별로 모아 볼 수 있어요. 슬라이드 옆 💬 배지를 누르면 그 장의 Q&A로 바로 가요.

마크다운 파일이라 Obsidian 같은 도구에서도 그대로 볼 수 있어요. 이미지 링크는 상대 경로예요.

## 저장 위치

전부 `library/` 아래에 있어요. git에는 올라가지 않아요.

```
library/
  <docId>/
    source.pdf, doc.json
    slides/001.png …           슬라이드 이미지
    sheets/sheet-01.png …      목차 이미지 (2×2)
    text/001.txt …             추출 텍스트
    digest/digest.json         정리본 데이터
    DIGEST.md                  정리본
    sessions/<id>.json         세션 (대화 + LLM 대화 핸들)
    notes/<id>.md              세션별 기록
    STUDY_NOTES.md             슬라이드별 Q&A 노트
  courses/<courseId>/
    course.json                과목 (강의 순서)
    COURSE.md                  과목 정리
```

## LLM 선택

| 선택지 | 필요 조건 | 비고 |
|---|---|---|
| Claude Code (구독) | `claude` 로그인 | `claude -p` 헤드리스로 실행돼요. 세션을 이어 쓰고, 파일은 읽기 전용이에요. |
| Codex (ChatGPT 구독) | `codex` 로그인 | `codex exec`로 실행돼요. 파일은 읽기만 할 수 있고, 읽을 수 있는 곳도 지금 강의 폴더와 같은 과목의 다른 강의 폴더(와 명령 실행에 필요한 시스템 파일)뿐이에요. 네트워크와 권한 상승 요청은 막혀 있어요. |
| Claude API | `ANTHROPIC_API_KEY` | 프롬프트 캐싱을 써요. |
| OpenAI API | `OPENAI_API_KEY` | Responses API를 쓰고, 모델은 `OPENAI_MODEL`로 정해요. |

모델은 새 세션을 만들 때 고를 수 있어요. "CLI 기본값"은 각 CLI 설정의 기본 모델을 따라요.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `5180` | 서버 포트. 항상 127.0.0.1에만 바인딩돼요. |
| `EASY_STUDY_LIBRARY` | `./library` | 라이브러리 위치 |
| `EASY_STUDY_NEIGHBORS` | `1` | 질문할 때 같이 보내는 앞뒤 슬라이드 수. 화면에서도 바꿀 수 있어요. |
| `EASY_STUDY_RECENT_WINDOW` | `16` | 최근 보낸 슬라이드 중 몇 장까지 다시 보내지 않을지 |
| `EASY_STUDY_PRIME_IMAGES` | `auto` | 프라이밍에 목차 이미지를 쓸지 (`auto`: 정리본이 없을 때만, `always`, `never`) |
| `EASY_STUDY_AUTO_DIGEST` | `1` | 첫 세션을 만들 때 정리본 자동 생성 (`0`이면 끔) |
| `EASY_STUDY_DIGEST_CONCURRENCY` | `1` | 정리본 생성 동시 호출 수. 올리면 빨라지지만 CLI 프로세스(개당 약 150MB)가 늘어요. |
| `EASY_STUDY_MAX_CLI_PROCS` | `2` | 동시에 띄우는 claude/codex 프로세스 최대 수(채팅 우선, 정리본은 기다려요) |
| `EASY_STUDY_CODEX_CONFINE` | `1` | `0`이면 Codex의 읽기 제한(강의 폴더만 읽기)을 끄고 예전처럼 읽기 전용 샌드박스만 써요. 이때 Codex는 **컴퓨터의 모든 파일**(예: `~/.ssh`)을 읽을 수 있어요. 읽기 제한 때문에 Codex가 시작하지 못할 때만 쓰세요. |
| `CLAUDE_BIN` / `CODEX_BIN` | PATH | CLI 경로 지정 |

## 문제 해결

- **`Claude Code 2.1.x does not support this model … Run 'claude update'`**: `~/.claude/settings.json`의 기본 모델이 설치된 CLI보다 새 버전을 요구하는 경우예요. `claude update`로 CLI를 업데이트하거나, 새 세션을 만들 때 모델을 `Sonnet`/`Opus`로 지정하세요.
- **Codex가 `Failed to initialize session` / `fs sandbox helper` 오류로 바로 멈출 때**: 설치된 Codex CLI가 읽기 제한(권한 프로필)을 지원하지 않는 경우예요. Codex CLI를 업데이트하고(0.154에서 확인), 그래도 안 되면 `EASY_STUDY_CODEX_CONFINE=0`으로 서버를 다시 시작하세요 (위 표의 경고 참고).
- **`poppler is not installed`**: 위 [빠른 시작](#빠른-시작)의 OS별 poppler 설치 명령을 실행하세요.
- 답변이 이상하거나 멈췄을 때: ■ 중지를 누른 뒤 다시 질문하세요. 실패한 턴은 LLM 대화 상태를 바꾸지 않아요.

## 메모리 사용

측정해 보고 줄였어요 (macOS, 49장 강의 기준).

| 항목 | 이전 | 지금 |
|---|---|---|
| 서버 (대기 중) | 66–69MB | 31–34MB (`npm start`로 실행한 빌드 버전) |
| 서버 (49장 PDF 변환 중 최대) | 약 170MB | 약 36MB (이미지 처리는 변환하는 몇 초 동안만 뜨는 별도 프로세스가 약 110MB를 쓰고 돌려줘요) |
| 동시에 뜨는 claude/codex 프로세스 | 최대 3개 | 최대 2개 (채팅 우선) |
| 브라우저 탭 (긴 채팅 열기) | 약 300MB | 약 135MB |
| 브라우저 GPU 이미지 캐시 (슬라이드 49장 스크롤 후) | 약 250MB | 약 140MB (WebP 표시용 이미지) |

가장 큰 비용은 claude CLI 프로세스(개당 약 150MB)예요. 메모리가 더 빠듯하다면:

- `EASY_STUDY_MAX_CLI_PROCS=1`로 켜면 정리본 생성과 채팅이 번갈아 실행돼요.
- Codex CLI는 프로세스당 약 35MB로 claude보다 훨씬 가벼워요.
- `npm start` 대신 `node --max-semi-space-size=2 dist-server/server/index.js`로 직접 실행하면 npm 프로세스(약 26MB)도 아낄 수 있어요 (`npm run build`를 먼저 한 번 실행해 두세요).

## 개발

타입 체크 (서버 + 웹):

```bash
npm run typecheck
```

테스트 (node:test, 가짜 CLI 사용 — 실제 LLM은 호출하지 않아요):

```bash
npm test
```

샘플 PDF 다시 만들기 (uv 필요):

```bash
npm run sample
```

구조와 API 계약은 [docs/DESIGN.md](docs/DESIGN.md)에 있어요.

```
server/            Express 서버 (Node가 TypeScript를 바로 실행)
  index.ts         라우트, SSE, Vite 미들웨어
  library.ts       PDF 변환 (poppler + sharp)
  sessions.ts      세션 저장, 노트 마크다운
  chat.ts          질문 한 턴 실행
  context.ts       무엇을 LLM에게 보낼지 결정 (프라이밍, 포커스, 앞뒤 슬라이드, 과목 컨텍스트)
  digest.ts        정리본 생성 작업
  courses.ts       과목 폴더
  providers/       claude / codex CLI, Anthropic / OpenAI API 어댑터
shared/types.ts    서버와 웹이 같이 쓰는 API 타입
web/               React + Vite UI
tests/             node:test 테스트
```
