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
- 아래 중 하나 이상
  - `claude` CLI 로그인 (Claude Code)
  - `codex` CLI 로그인 (Codex)
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`

PDF를 읽는 도구는 따로 설치하지 않아도 돼요. PDF 엔진(PDFium을 WebAssembly로 빌드한 것)이 npm 패키지에 들어 있어서 모든 OS에서 똑같이 동작해요.

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

브라우저에서 PDF를 끌어다 놓으면 슬라이드가 PNG로 변환되고, 바로 질문할 수 있어요. 여러 개를 한꺼번에 놓으면 몇 개씩(CPU에 따라 2~4개) 차례로 변환하고, 나머지는 "PDF 분석 중…"으로 기다려요.
처음 써 볼 때는 `samples/sample-lecture.pdf`(합성 강의 9장)로 시험해 보세요.

### 다른 OS

- **macOS**: 개발하고 실제로 쓰면서 확인한 환경이에요.
- **Linux**: Docker(Node 22.18, 26, poppler 없음)에서 설치, 테스트, 빌드, 서버 실행, PDF 변환까지 확인했어요. 슬라이드 이미지와 텍스트는 macOS에서 만든 것과 바이트 단위로 같았어요. 글꼴이 하나도 없는 시스템(슬림 Docker 이미지 등)에서도 변환과 목차 이미지는 그대로 돼요. 다만 글꼴을 내장하지 않은 한글·일본어·중국어 PDF를 위해 `fonts-noto-cjk`(또는 `fonts-nanum`)을 설치해 두세요. Codex의 읽기 제한은 macOS에서만 실제로 확인했어요. Linux에서 Codex가 시작하지 못하면 아래 `EASY_STUDY_CODEX_CONFINE=0`을 참고하세요.
- **Windows**: 실제 Windows에서는 테스트하지 못했어요. 가장 확실한 방법은 **WSL2(Ubuntu)** 안에서 Linux 방법대로 설치하는 거예요. Windows에서 바로 실행한다면:
  - `claude`·`codex`는 공식 설치 프로그램(`.exe`)을 권장해요. npm으로 설치한 `.cmd`도 실제 실행 파일을 찾아 쓰도록 해 뒀지만 검증하지는 못했어요.
  - Windows에서는 Codex의 읽기 제한이 꺼져 있어서 Codex가 사용자 파일 전체를 읽을 수 있어요. 민감한 파일이 있는 계정이라면 Claude Code를 쓰세요.
  - 환경 변수는 PowerShell에서 `$env:PORT=5181; npm start`처럼 지정해요.

## 다른 컴퓨터에서 쓰기 (원격 모드)

서버는 이 컴퓨터에서 그대로 돌리고, 다른 컴퓨터나 태블릿에서는 브라우저로 접속해요. 서버가 이 컴퓨터에 로그인된 claude/codex와 파일을 쓰기 때문에, 원격 모드에서는 **접속 코드로 로그인해야만** 쓸 수 있어요.

```bash
npm run start:remote     # 빌드한 뒤 모든 네트워크 주소(0.0.0.0)에서 로그인이 필요한 모드로 실행
npm run serve:remote     # 이미 빌드했다면
```

터미널에 접속 주소(예: `http://192.168.0.10:5180`), 접속 코드(`xxxxx-xxxxx-xxxxx-xxxxx`), 바로 로그인 링크가 나와요. 다른 기기에서 그 주소를 열고 코드를 입력하세요. 코드는 `library/.auth.json`에 저장돼서 다시 시작해도 같아요.

- 코드를 바꾸고 모든 기기를 로그아웃시키려면 `npm run serve:remote -- --reset-access-code`로 실행하세요.
- 자동으로 만든 코드 대신 직접 정한 비밀번호(8자 이상)를 쓰려면 `EASY_STUDY_PASSWORD`를 지정하세요. 이때 `--reset-access-code`는 로그인만 끊어요. 비밀번호를 바꾸려면 `EASY_STUDY_PASSWORD`를 바꾸세요.
- 스크립트에서는 `Authorization: Bearer <접속 코드>` 헤더로 API를 쓸 수 있어요.
- 한 주소에서 로그인에 10번 틀리면 10분 동안 기다려야 해요.
- 일반 HTTP는 암호화되지 않아요. **같은 Wi‑Fi처럼 믿을 수 있는 네트워크에서만** 쓰고, 밖에서는 아래 HTTPS 방법을 쓰세요.

### HTTPS로 쓰기

- **Tailscale (권장)**: 서버는 이 컴퓨터에서만 열고(`EASY_STUDY_HOST=127.0.0.1 npm run serve:remote`), `tailscale serve --bg 5180`으로 내 tailnet에 HTTPS로 공개해요. 다른 기기에서는 `https://<컴퓨터 이름>.<tailnet 이름>.ts.net`으로 접속해요. 로그인은 그대로 필요해요.
- **인증서 직접 지정**: `EASY_STUDY_TLS_CERT=cert.pem EASY_STUDY_TLS_KEY=key.pem npm run serve:remote`. 접속하는 컴퓨터가 믿는 인증서여야 해요 (예: `tailscale cert`로 받은 인증서, 또는 mkcert로 만들고 그 루트 인증서를 접속하는 컴퓨터에 설치).

### 앱으로 설치하기

같은 화면을 브라우저 탭이 아닌 별도 앱 창으로 쓸 수 있어요 (PWA, macOS·Windows).

- **Chrome / Edge**: 주소창 오른쪽의 설치 아이콘, 또는 메뉴 → ‘앱 설치’(Edge: ‘앱’ → ‘이 사이트를 앱으로 설치’).
- **Safari (macOS)**: 파일 → ‘Dock에 추가’. iPad/iPhone은 공유 → ‘홈 화면에 추가’.

Chrome/Edge는 **안전한 주소에서만** 설치를 허용해요.

- 서버를 실행한 컴퓨터: `http://127.0.0.1:5180`에서 바로 설치돼요.
- 다른 컴퓨터: `http://192.168.x.x:5180` 같은 일반 HTTP 주소에서는 설치 메뉴가 나오지 않아요. 위의 Tailscale(`https://….ts.net`)이나 인증서를 지정한 HTTPS 주소로 접속해서 설치하세요. Safari의 ‘Dock에 추가’는 HTTP 주소에서도 돼요.

## 데스크톱 앱

브라우저 없이 쓰는 설치형 앱이에요 (macOS·Windows·Linux, [Tauri 2](https://v2.tauri.app)). 서버 구조는 그대로이고, 앱을 켜면 둘 중 하나를 골라요.

- **이 컴퓨터에서 실행**: 앱에 들어 있는 Node.js와 easy-study 서버를 앱이 직접 켜요. Node·npm을 따로 설치할 필요가 없어요. `claude`·`codex` CLI는 평소처럼 이 컴퓨터에 설치하고 로그인해 두세요. Finder·Dock·시작 메뉴에서 켜도 로그인 셸(`$SHELL -ilc`)의 PATH와 흔한 설치 위치(`~/.local/bin`, Homebrew, npm 전역 폴더 등)에서 찾아요.
- **다른 컴퓨터에 연결**: 다른 컴퓨터에서 `npm run start:remote`로 켠 easy-study 서버([원격 모드](#다른-컴퓨터에서-쓰기-원격-모드))의 주소와 접속 코드를 넣어요. 로그인은 30일 동안 유지돼서 코드는 처음 한 번만 넣으면 돼요. (데스크톱 앱이 켠 서버는 그 컴퓨터에서만 열려서, 다른 컴퓨터에서는 연결할 수 없어요.)
  - `http://`는 같은 네트워크(집·학교 Wi‑Fi, Tailscale의 `100.x` 주소나 `.ts.net` 이름)의 컴퓨터에만 연결해요. 인터넷을 거친다면 `https://`를 쓰세요.
  - `https://`는 이 컴퓨터가 믿는 인증서만 돼요 (`tailscale serve`, `tailscale cert`, 루트 인증서를 설치한 mkcert). 자체 서명 인증서는 앱 창이 받아들이지 못해서, 연결하기 전에 앱이 확인하고 이유를 알려 줘요.
  - macOS 15 이상에서는 같은 네트워크의 컴퓨터에 처음 연결할 때 ‘로컬 네트워크’ 접근을 허용할지 물어봐요. 허용하지 않았다면 **시스템 설정 › 개인정보 보호 및 보안 › 로컬 네트워크**에서 easy-study를 켜세요.

‘다음에도 바로 연결’을 켜 두면 다음부터는 고른 화면이 바로 열려요. 연결 대상은 메뉴 **연결 › 연결 대상 바꾸기…**(macOS `⌘⇧K`, Windows·Linux `Ctrl+Shift+K`)에서 언제든 바꿀 수 있어요. 같은 메뉴에 ‘브라우저에서 열기’와 ‘라이브러리 폴더 열기’도 있어요. 다른 사이트로 가는 링크는 기본 브라우저에서 열리고, 노트·정리본 파일 링크는 앱 창으로 열려요.

### 설치

GitHub Releases(또는 Actions의 빌드 결과)에서 OS에 맞는 파일을 받으세요. 아직 코드 서명과 공증을 하지 않은 앱이라, 처음 열 때 OS가 한 번 막아요.

- **macOS 13.5 이상** (Apple silicon `easy-study_<버전>_aarch64.dmg`, Intel `easy-study_<버전>_x64.dmg`): dmg를 열고 easy-study를 ‘응용 프로그램’으로 끌어다 놓아요. 처음 열 때 “확인되지 않은 개발자” 경고가 나오면 **시스템 설정 › 개인정보 보호 및 보안**에서 ‘그래도 열기’를 누르세요. 또는 터미널에서 `xattr -dr com.apple.quarantine /Applications/easy-study.app`.
- **Windows 10/11** (`easy-study_<버전>_x64-setup.exe`): 관리자 권한 없이 내 사용자 계정에만 설치돼요. SmartScreen의 “Windows의 PC 보호” 창이 뜨면 ‘추가 정보’ → ‘실행’. WebView2 런타임이 없으면(Windows 10 일부) 설치하면서 받아요.
- **Linux** (x86_64, arm64):
  - Ubuntu 22.04 이상·Debian 12 이상: `sudo apt install ./easy-study_<버전>_amd64.deb` (WebKitGTK, `libatomic1` 등 필요한 패키지가 같이 설치되고, 한글 글꼴 `fonts-noto-cjk`도 권장 패키지로 설치돼요).
  - Fedora: `sudo dnf install ./easy-study-<버전>-1.x86_64.rpm`.
  - AppImage: `chmod +x easy-study_<버전>_amd64.AppImage` 후 실행 (FUSE가 필요해요. 없으면 `--appimage-extract-and-run`을 붙이세요). deb/rpm은 배포판의 WebKitGTK 보안 업데이트를 그대로 받으니 되도록 deb/rpm을 쓰세요.
  - 창이 하얗게만 보이면(일부 NVIDIA 드라이버) `WEBKIT_DISABLE_DMABUF_RENDERER=1 easy-study`로 켜 보세요.

### 데이터 위치

‘이 컴퓨터에서 실행’의 라이브러리는 기본으로 앱 데이터 폴더에 있어요. 시작 화면의 **라이브러리 폴더 선택…**으로 이미 쓰던 폴더(예: 저장소의 `library/`)를 고를 수도 있어요. 다만 같은 폴더를 `npm start`로 켠 서버와 동시에 쓸 수는 없어요: 앱이 서버를 켜지 못하고 시작 화면에 이유(서버 로그의 마지막 줄)를 보여 줘요.

| | 라이브러리 (기본) | 앱 설정 (`desktop.json`) | 로그 (`shell.log`, `server.log`) |
|---|---|---|---|
| macOS | `~/Library/Application Support/dev.easystudy.desktop/library` | `~/Library/Application Support/dev.easystudy.desktop` | `~/Library/Logs/dev.easystudy.desktop` |
| Windows | `%LOCALAPPDATA%\dev.easystudy.desktop\library` | `%APPDATA%\dev.easystudy.desktop` | `%LOCALAPPDATA%\dev.easystudy.desktop\logs` |
| Linux | `~/.local/share/dev.easystudy.desktop/library` | `~/.config/dev.easystudy.desktop` | `~/.local/share/dev.easystudy.desktop/logs` |

앱의 서버는 `http://127.0.0.1:5350`(쓰고 있으면 5351–5359)에서 이 컴퓨터에만 열려요. 포트를 기억해 두기 때문에 화면 설정(마지막으로 본 강의 등)이 다음 실행에도 이어져요. 앱을 끄면(강제 종료나 충돌이어도) 서버와 그 서버가 띄운 CLI도 같이 꺼져요.

### 직접 빌드하기

필요한 것: Node.js 26, Rust (stable, `rustup`), 그리고 OS별 도구 — macOS는 Xcode Command Line Tools, Windows는 Visual Studio C++ Build Tools, Linux는 [Tauri의 패키지 목록](https://v2.tauri.app/start/prerequisites/)(`libwebkit2gtk-4.1-dev` 등)과 AppImage용 `xdg-utils`.

```bash
npm ci
npm run desktop:build        # 이 컴퓨터용: macOS .app + .dmg, Windows NSIS 설치 파일, Linux .deb/.rpm/AppImage
npm run desktop:build -- --target x86_64-apple-darwin   # Apple silicon Mac에서 Intel Mac용 (rustup target add x86_64-apple-darwin)
npm run desktop:dev          # 개발용으로 바로 실행 (tauri dev)
npm run desktop:test         # 앱 설정 검사 (IPC는 시작 화면에만, 대상별 번들 설정); 셸 자체는 desktop/src-tauri에서 cargo test
```

`desktop:build`는 저장소를 빌드하고(`npm run build`), 앱에 넣을 공식 Node.js(nodejs.org, SHA-256 확인, 버전은 `desktop/package.json`의 `easyStudy.nodeVersion`)와 그 대상 OS용 `node_modules`를 담은 서버를 `desktop/resources/`에 준비한 뒤 Tauri로 묶어요. 결과는 `desktop/src-tauri/target/<대상>/release/bundle/`에 나와요. Windows 설치 파일은 Windows에서, Linux 패키지는 Linux에서 빌드하세요. GitHub Actions(`.github/workflows/desktop.yml`)는 테스트를 먼저 돌린 뒤 macOS(arm64·x64)·Windows·Linux(x64·arm64)용을 모두 빌드하고, `v*` 태그를 올리면 초안(draft) 릴리스를 만들어요. `APPLE_*` 시크릿을 넣으면 macOS 앱을 서명·공증해요.

시험용 환경 변수: `EASY_STUDY_DESKTOP_LIBRARY`(라이브러리 폴더 지정), `EASY_STUDY_DESKTOP_HOME`(설정·로그·기본 라이브러리를 다른 폴더에), `EASY_STUDY_DESKTOP_SMOKE`(확인한 뒤 앱이 스스로 종료해요. 결과는 `EASY_STUDY_DESKTOP_SMOKE`로 시작하는 줄과 종료 코드: 0 성공, 2 서버·연결 실패, 3 시간 초과(`EASY_STUDY_DESKTOP_SMOKE_TIMEOUT`, 기본 120초), 4 확인 실패, 5 실패 뒤에도 시작 화면이 ‘진행 중’에 멈춤).

- `=1`: 서버를 바로 켜고, 화면이 뜨는지, `/api/health`가 답하는지, 서버 화면에 IPC가 없는지, 작은 PDF를 올려 변환하고 슬라이드 이미지를 받아지는지 확인해요 (올린 강의는 다시 지워요). `EASY_STUDY_DESKTOP_SMOKE_URL`/`_CODE`를 주면 그 서버에 연결해서 확인해요 (PDF는 올리지 않아요).
- `=chooser`: 시작 화면만 확인해요 (IPC로 받은 라이브러리 경로, 스타일).
- `=chooser-local`, `=chooser-remote`: 시작 화면의 양식을 채우고 ‘연결’을 눌러요. 버튼을 누를 때와 같은 길(IPC `connect_local`/`connect_remote`)로 연결한 뒤 `=1`과 같은 확인을 해요. `=chooser-remote`는 `EASY_STUDY_DESKTOP_SMOKE_URL`/`_CODE`를 써요. 실패는 시작 화면에 보이는 오류로 판단해요.

앱을 시험할 때 알아 둘 것: 스모크 실행은 이미 켜진 easy-study에 넘기지 않고 따로 실행돼요. 하지만 보통 실행은 컴퓨터 전체에서 하나만 돼요(두 번째 실행은 켜진 창을 앞으로 가져오고 끝나요). WebView의 쿠키·저장소는 `EASY_STUDY_DESKTOP_HOME`과 상관없이 OS의 앱 폴더를 같이 써요. 그러니 앱 시험은 한 번에 하나씩 하세요. macOS에서 `CFFIXED_USER_HOME`으로 WebView 데이터를 옮기면 쿠키가 저장되지 않으니 로그인 유지 시험에는 쓰지 마세요. Linux에서 WebDriver(tauri-driver)로 시험하면 `target=_blank` 링크의 새 창이 열리지 않고, 시작 화면 스크린숏이 스크립트 실행 전 모습으로 찍혀요. 새 창과 화면 모습은 앱을 직접 실행해서 xdotool과 X 스크린숏으로 확인하세요. Docker 같은 곳에서 Linux 패키지를 빌드할 때는 `xdg-utils`도 설치하세요 (AppImage에 `xdg-open`이 들어가요). 구조와 계약은 [docs/DESIGN.md](docs/DESIGN.md) §19에 있어요.

## 동작 방식

### 1. 슬라이드 → 이미지

PDF를 올리면 PDF 엔진(PDFium)이 각 페이지를 1600px PNG로 렌더링하고, 텍스트도 같이 뽑아요. PowerPoint가 Symbol 글꼴로 넣은 기호(α ε ∪ ∈ …)도 제대로 된 문자로 바꾸고, 위첨자·아래첨자(1st, Aᵢ)는 줄을 나누지 않아요. 채워 넣은 양식 필드와 PDF에 직접 입력한 메모도 이미지와 텍스트에 들어가요.
텍스트만으로는 그림·표·수식이 빠지거나 흐트러지기 때문에, LLM에게는 **슬라이드 이미지**를 보여줘요.

예전 버전(poppler, 또는 이전 PDFium 추출)으로 변환한 문서는 서버를 켤 때 백그라운드에서 텍스트만 한 번 다시 뽑아요. 슬라이드 이미지와 정리본은 그대로예요. 정리본은 예전 텍스트로 만든 그대로라서, 기호가 빠져 있던 정리본은 다시 만들면 새 텍스트가 반영돼요.

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
    text/001.txt …             추출 텍스트 (text/.engine: 텍스트를 뽑은 엔진)
    digest/digest.json         정리본 데이터
    DIGEST.md                  정리본
    sessions/<id>.json         세션 (대화 + LLM 대화 핸들)
    notes/<id>.md              세션별 기록
    STUDY_NOTES.md             슬라이드별 Q&A 노트
  courses/<courseId>/
    course.json                과목 (강의 순서)
    COURSE.md                  과목 정리
  .auth.json                   원격 모드의 접속 코드와 로그인 세션 (이 컴퓨터의 사용자만 읽을 수 있어요)
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
| `PORT` | `5180` | 서버 포트 |
| `EASY_STUDY_HOST` | `127.0.0.1` | 바인딩 주소. 127.0.0.1이 아니면(예: `0.0.0.0`) 원격 모드가 되어 접속 코드가 필요해요. `npm run serve:remote`는 `0.0.0.0`을 써요. |
| `EASY_STUDY_AUTH` | `auto` | `on`이면 127.0.0.1에서도 로그인이 필요해요 (`tailscale serve` 같은 리버스 프록시용). `off`는 127.0.0.1에서만 쓸 수 있어요. |
| `EASY_STUDY_PASSWORD` | 자동 생성 코드 | 접속 코드 대신 쓸 비밀번호 (8자 이상) |
| `EASY_STUDY_TLS_CERT` / `EASY_STUDY_TLS_KEY` | 없음 | HTTPS 인증서와 키 (PEM 파일). 둘 다 지정해야 해요. |
| `EASY_STUDY_LIBRARY` | `./library` | 라이브러리 위치 |
| `EASY_STUDY_NEIGHBORS` | `1` | 질문할 때 같이 보내는 앞뒤 슬라이드 수. 화면에서도 바꿀 수 있어요. |
| `EASY_STUDY_RECENT_WINDOW` | `16` | 최근 보낸 슬라이드 중 몇 장까지 다시 보내지 않을지 |
| `EASY_STUDY_PRIME_IMAGES` | `auto` | 프라이밍에 목차 이미지를 쓸지 (`auto`: 정리본이 없을 때만, `always`, `never`) |
| `EASY_STUDY_AUTO_DIGEST` | `1` | 첫 세션을 만들 때 정리본 자동 생성 (`0`이면 끔) |
| `EASY_STUDY_DIGEST_CONCURRENCY` | `1` | 정리본 생성 동시 호출 수. 올리면 빨라지지만 CLI 프로세스(개당 약 150MB)가 늘어요. |
| `EASY_STUDY_MAX_CLI_PROCS` | `2` | 동시에 띄우는 claude/codex 프로세스 최대 수(채팅 우선, 정리본은 기다려요) |
| `EASY_STUDY_CODEX_CONFINE` | `1` | `0`이면 Codex의 읽기 제한(강의 폴더만 읽기)을 끄고 예전처럼 읽기 전용 샌드박스만 써요. 이때 Codex는 **컴퓨터의 모든 파일**(예: `~/.ssh`)을 읽을 수 있어요. 읽기 제한 때문에 Codex가 시작하지 못할 때만 쓰세요. |
| `CLAUDE_BIN` / `CODEX_BIN` | PATH | CLI 경로 지정 |
| `EASY_STUDY_PDF_FALLBACK_FONT` | OS 글꼴 | 글꼴을 내장하지 않은 한글·일본어·중국어 PDF를 그릴 글꼴 파일(`.ttf`/`.otf`/`.ttc`). 지정하지 않으면 macOS는 Arial Unicode·Apple SD Gothic Neo, Windows는 맑은 고딕·굴림·MS Gothic·Microsoft YaHei, Linux는 Noto Sans CJK·나눔고딕 중 있는 것을 써요. |

## 문제 해결

- **`Claude Code 2.1.x does not support this model … Run 'claude update'`**: `~/.claude/settings.json`의 기본 모델이 설치된 CLI보다 새 버전을 요구하는 경우예요. `claude update`로 CLI를 업데이트하거나, 새 세션을 만들 때 모델을 `Sonnet`/`Opus`로 지정하세요.
- **Codex가 `Failed to initialize session` / `fs sandbox helper` 오류로 바로 멈출 때**: 설치된 Codex CLI가 읽기 제한(권한 프로필)을 지원하지 않는 경우예요. Codex CLI를 업데이트하고(0.154에서 확인), 그래도 안 되면 `EASY_STUDY_CODEX_CONFINE=0`으로 서버를 다시 시작하세요 (위 표의 경고 참고).
- **`the PDF is password protected`**: 암호가 걸린 PDF예요. 암호를 푼 PDF로 다시 저장해서(예: 미리보기에서 열고 암호 없이 내보내기) 올리세요.
- **`could not read the PDF: the file is damaged or is not a PDF`**: 파일이 깨졌거나 PDF가 아니에요. 원본에서 PDF로 다시 내보내 올리세요.
- **한글·일본어·중국어가 슬라이드 이미지에서 안 보일 때**: 글꼴을 내장하지 않은 PDF예요. 이때 서버 로그에 `[library] <문서>: the PDF uses a CJK font it does not embed, and no fallback font could be read (…)`가 한 번 찍혀요. 위 `EASY_STUDY_PDF_FALLBACK_FONT` 설명의 글꼴(Linux는 `fonts-noto-cjk`)을 설치하거나 지정한 뒤, 문서를 지우고 다시 올리세요. 텍스트는 글꼴이 없어도 제대로 뽑혀요. `EASY_STUDY_PDF_FALLBACK_FONT`에 읽을 수 없는 경로를 지정하면 서버를 켤 때 경고가 나와요.
- 답변이 이상하거나 멈췄을 때: ■ 중지를 누른 뒤 다시 질문하세요. 실패한 턴은 LLM 대화 상태를 바꾸지 않아요.

## 메모리 사용

측정해 보고 줄였어요 (macOS, 49장 강의 기준).

| 항목 | 이전 | 지금 |
|---|---|---|
| 서버 (대기 중) | 66–69MB | 31–34MB (`npm start`로 실행한 빌드 버전) |
| 서버 (49장 PDF 변환 중 최대) | 약 170MB | 약 36MB (PDF 렌더링(약 120MB)과 이미지 처리(약 110MB)는 변환하는 몇 초 동안만 차례로 뜨는 별도 프로세스가 맡고, 끝나면 메모리를 돌려줘요) |
| PDF 여러 개를 한꺼번에 올릴 때 | 개수만큼 동시에 변환 | CPU에 따라 2~4개씩 차례로 변환해서, 변환 프로세스(개당 약 150–300MB)가 그 이상 늘지 않아요 |
| 동시에 뜨는 claude/codex 프로세스 | 최대 3개 | 최대 2개 (채팅 우선) |
| 브라우저 탭 (긴 채팅 열기) | 약 300MB | 약 135MB |
| 브라우저 GPU 이미지 캐시 (슬라이드 49장 스크롤 후) | 약 250MB | 약 140MB (WebP 표시용 이미지) |

가장 큰 비용은 claude CLI 프로세스(개당 약 150MB)예요. 메모리가 더 빠듯하다면:

- `EASY_STUDY_MAX_CLI_PROCS=1`로 켜면 정리본 생성과 채팅이 번갈아 실행돼요.
- Codex CLI는 프로세스당 약 35MB로 claude보다 훨씬 가벼워요.
- `npm start` 대신 `node --max-semi-space-size=2 dist-server/server/index.js`로 직접 실행하면 npm 프로세스(약 26MB)도 아낄 수 있어요 (`npm run build`를 먼저 한 번 실행해 두세요).

## 개발

타입 체크 (서버 + 웹 + 웹 테스트):

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
  library.ts       라이브러리, PDF 변환 파이프라인, 백그라운드 백필
  imageWorker.ts   PDF 렌더링·텍스트(PDFium)와 이미지(sharp) 작업을 하는 짧게 사는 자식 프로세스
  pdf.ts           PDF 엔진 (PDFium WebAssembly: 렌더링, 텍스트, 한중일 대체 글꼴)
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

## 라이선스

PDF 엔진으로 PDFium(BSD-3-Clause / Apache-2.0, `@embedpdf/pdfium` 패키지는 MIT)을 함께 배포해요. PDFium과 그 안에 들어 있는 라이브러리(FreeType, OpenJPEG, Little CMS, libjpeg-turbo, libpng, zlib, AGG)의 라이선스 전문은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있어요.
