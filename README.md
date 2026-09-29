# easy-study

강의 PDF를 슬라이드 단위로 공부하는 로컬 웹앱이에요. 왼쪽에는 슬라이드가 스크롤되고, 오른쪽 채팅은 **지금 보고 있는 슬라이드**를 알고 답해요.
LLM은 이미 로그인된 **Claude Code**(Claude 구독)나 **Codex**(ChatGPT 구독) CLI를 그대로 쓰고, API 키가 있으면 Claude API나 OpenAI API도 쓸 수 있어요.
수업 중에 [강의를 녹음](#강의-녹음)하면 이 컴퓨터에서 받아써서 슬라이드마다 나누고, 튜터가 교수님이 한 말까지 알고 답해요.

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
- **Linux**: Docker(Node 22.18, 26, poppler 없음)에서 설치, 테스트, 빌드, 서버 실행, PDF 변환까지 확인했어요. 슬라이드 이미지와 텍스트는 macOS에서 만든 것과 바이트 단위로 같았어요. 글꼴이 하나도 없는 시스템(슬림 Docker 이미지 등)에서도 변환과 목차 이미지는 그대로 돼요. 다만 글꼴을 내장하지 않은 한글·일본어·중국어 PDF를 위해 `fonts-noto-cjk`(또는 `fonts-nanum`, Arch는 `noto-fonts-cjk`)을 설치해 두세요. Codex의 읽기 제한은 macOS에서만 실제로 확인했어요. Linux에서 Codex가 시작하지 못하면 아래 `EASY_STUDY_CODEX_CONFINE=0`을 참고하세요.
- **Windows**: 실제 Windows에서는 테스트하지 못했어요. 가장 확실한 방법은 **WSL2(Ubuntu)** 안에서 Linux 방법대로 설치하는 거예요. Windows에서 바로 실행한다면:
  - `claude`·`codex`는 공식 설치 프로그램(`.exe`)을 권장해요. npm으로 설치한 `.cmd`도 실제 실행 파일을 찾아 쓰도록 해 뒀지만 검증하지는 못했어요.
  - Windows에서는 Codex의 읽기 제한이 꺼져 있어서 Codex가 사용자 파일 전체를 읽을 수 있어요. 민감한 파일이 있는 계정이라면 Claude Code를 쓰세요.
  - 환경 변수는 PowerShell에서 `$env:PORT=5181; npm start`처럼 지정해요.
- **강의 녹음(웹 모드)**: 받아쓰기 엔진과 ffmpeg는 따로 준비해요 ([아래](#웹-모드npm-start에서-쓸-때)). 데스크톱 앱에는 둘 다 들어 있어요.

## 다른 컴퓨터에서 쓰기 (원격 모드)

서버는 이 컴퓨터에서 그대로 돌리고, 다른 컴퓨터나 태블릿에서는 브라우저로 접속해요. 서버가 이 컴퓨터에 로그인된 claude/codex와 파일을 쓰기 때문에, 원격 모드에서는 **접속 코드로 로그인해야만** 쓸 수 있어요.

```bash
npm run start:remote     # 빌드한 뒤 모든 네트워크 주소(0.0.0.0)에서 로그인이 필요한 모드로 실행
npm run serve:remote     # 이미 빌드했다면
```

터미널에 접속 주소(예: `http://192.168.0.10:5180`), 접속 코드(`xxxxx-xxxxx-xxxxx-xxxxx`), 바로 로그인 링크가 나와요. 다른 기기에서 그 주소를 열고 코드를 입력하세요. 코드는 `library/.auth.json`에 저장돼서 다시 시작해도 같아요.

[데스크톱 앱](#데스크톱-앱)에서는 터미널 없이 **⚙ 설정 › 데스크톱 앱 › 다른 기기에서 접속 허용** 스위치(연결 선택 화면의 ⚙ 앱 설정에도 있어요)로 같은 모드를 켜요. 앱이 서버를 다시 시작하고, 다른 기기에서 열 주소와 접속 코드가 거기 나와요 (복사 버튼, **접속 코드 새로 만들기**). 켤 때 macOS·Windows 방화벽이 ‘node’의 네트워크 연결을 허용할지 물으면 허용하세요 — 앱에 든 서버예요 (직접 빌드한 앱은 켤 때마다 물을 수 있어요. 거부했다면 macOS는 시스템 설정 › 네트워크 › 방화벽 › 옵션, Windows는 방화벽 › 앱 허용에서 node를 켜세요).

- 코드를 바꾸고 모든 기기를 로그아웃시키려면 `npm run serve:remote -- --reset-access-code`로 실행하세요 (앱에서는 **접속 코드 새로 만들기**).
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
- **다른 컴퓨터에 연결**: 다른 컴퓨터에서 켠 easy-study 서버([원격 모드](#다른-컴퓨터에서-쓰기-원격-모드): 그 컴퓨터의 앱에서 **다른 기기에서 접속 허용**을 켰거나, 터미널에서 `npm run start:remote`)의 주소와 접속 코드를 넣어요. 로그인은 30일 동안 유지돼서 코드는 처음 한 번만 넣으면 돼요.
  - `http://`는 같은 네트워크(집·학교 Wi‑Fi, Tailscale의 `100.x` 주소나 `.ts.net` 이름)의 컴퓨터에만 연결해요. 인터넷을 거친다면 `https://`를 쓰세요.
  - `http://` 주소로 연결해도 앱 안에서는 [녹음](#다른-기기에서-녹음하기)이 돼요: 앱이 자기 안에서 `http://127.0.0.1:<포트>`로 중계해서(창의 주소가 그렇게 보여요) 마이크를 쓸 수 있게 해요. 코드와 로그인은 네트워크를 암호화 없이 지나가고, 같은 네트워크의 누군가가 오가는 내용을 엿보거나 화면을 바꿀 수도 있어요 (바뀐 화면은 마이크와 로그인까지 쓸 수 있어요). 같은 Wi‑Fi처럼 믿을 수 있는 네트워크에서만 쓰고, 다른 곳에서는 Tailscale이나 `https://`를 쓰세요.
  - `https://`는 이 컴퓨터가 믿는 인증서만 돼요 (`tailscale serve`, `tailscale cert`, 루트 인증서를 설치한 mkcert). 자체 서명 인증서는 앱 창이 받아들이지 못해서, 연결하기 전에 앱이 확인하고 이유를 알려 줘요.
  - macOS 15 이상에서는 같은 네트워크의 컴퓨터에 처음 연결할 때 ‘로컬 네트워크’ 접근을 허용할지 물어봐요. 허용하지 않았다면 **시스템 설정 › 개인정보 보호 및 보안 › 로컬 네트워크**에서 easy-study를 켜세요.

‘다음에도 바로 연결’을 켜 두면 다음부터는 고른 화면이 바로 열려요. 연결 대상은 앱 화면 오른쪽 위 **⚙ 설정 › 데스크톱 앱 › 연결 대상 바꾸기…** 또는 메뉴 **연결 › 연결 대상 바꾸기…**(macOS `⌘⇧K`, Windows·Linux `Ctrl+Shift+K`)에서 언제든 바꿀 수 있어요. 같은 곳의 **다음 실행 때 선택 화면 보기**를 누르면 다음에 앱을 열 때 선택 화면이 먼저 나와요. 로그인 화면이나 ‘이 컴퓨터에서만 열 수 있어요’ 화면에서는 **다른 서버에 연결…** 을 누르면 돼요. 같은 메뉴에 ‘브라우저에서 열기’와 ‘라이브러리 폴더 열기’도 있어요. 다른 사이트로 가는 링크는 기본 브라우저에서 열리고, 노트·정리본 파일 링크는 앱 창으로 열려요.

**다른 기기에서 접속 허용**(⚙ 설정 › 데스크톱 앱, 또는 선택 화면의 ⚙ 앱 설정): 켜면 이 컴퓨터의 서버가 같은 네트워크에도 열리고(로그인 필요), 다른 컴퓨터의 easy-study 앱이나 태블릿의 브라우저에서 이 컴퓨터의 강의와 Claude/Codex를 쓸 수 있어요. 켜거나 끄면 서버를 다시 시작해요 (녹음 중에는 안 되고, 답변을 만들거나 파일을 올리는 중이면 먼저 물어봐요). 주소와 접속 코드는 같은 곳에 나와요 (선택 화면에서 켜면 서버가 다시 시작된 뒤에도 선택 화면에 남아서 주소와 코드를 복사할 수 있어요; 앱 화면으로 가려면 **연결**). 알아 둘 것: 다른 컴퓨터에 연결하면 이 컴퓨터의 서버(공유 포함)는 멈춰요. 이 컴퓨터의 공유 서버에 로그인한 상태와 다른 컴퓨터로의 연결(앱 안의 중계 주소)의 로그인은 서로 따로 보관돼서 연결을 오가도 그대로예요 (다른 컴퓨터에는 그 컴퓨터의 로그인만 보내요). Wi‑Fi가 바뀌어 주소가 바뀌면 껐다 켜세요. IPv4 주소만 나와요.

### 설치

[릴리스 페이지](https://github.com/Wooangha/easy-study-releases/releases/latest)(설치 파일만 올리는 공개 저장소예요. 소스 코드는 비공개)에서 OS에 맞는 파일을 받으세요. 0.4.2까지는 비공개 저장소의 릴리스에만 있어요. 아직 코드 서명과 공증을 하지 않은 앱이라, 처음 열 때 OS가 한 번 막아요.

- **macOS 13.5 이상** (Apple silicon `easy-study_<버전>_aarch64.dmg`, Intel `easy-study_<버전>_x64.dmg`): dmg를 열고 easy-study를 ‘응용 프로그램’으로 끌어다 놓아요. 처음 열 때 “확인되지 않은 개발자” 경고가 나오면 **시스템 설정 › 개인정보 보호 및 보안**에서 ‘그래도 열기’를 누르세요. 또는 터미널에서 `xattr -dr com.apple.quarantine /Applications/easy-study.app`.
  처음 [강의를 녹음](#강의-녹음)할 때 macOS가 마이크를 써도 되는지 한 번 물어요. 서명하지 않은 앱이라 새 버전으로 바꾸면 다시 물을 수 있어요. 켜져 있는데도 녹음이 안 되면 **시스템 설정 › 개인정보 보호 및 보안 › 마이크**에서 easy-study를 껐다가 다시 켜세요.
- **Windows 10/11** (`easy-study_<버전>_x64-setup.exe`): 관리자 권한 없이 내 사용자 계정에만 설치돼요. SmartScreen의 “Windows의 PC 보호” 창이 뜨면 ‘추가 정보’ → ‘실행’. WebView2 런타임이 없으면(Windows 10 일부) 설치하면서 받아요.
- **Linux** (x86_64, arm64):
  - Ubuntu 22.04 이상·Debian 12 이상: `sudo apt install ./easy-study_<버전>_amd64.deb` (WebKitGTK, `libatomic1` 등 필요한 패키지가 같이 설치되고, 한글 글꼴 `fonts-noto-cjk`와 올린 녹음(m4a)을 재생하는 `gstreamer1.0-libav`도 권장 패키지로 설치돼요).
  - Fedora: `sudo dnf install ./easy-study-<버전>-1.x86_64.rpm`.
  - Arch Linux: pacman 패키지로 설치해요 ([아래](#arch-linux)).
  - AppImage: `chmod +x easy-study_<버전>_amd64.AppImage` 후 실행 (FUSE가 필요해요: `fusermount3`나 `fusermount` 중 하나면 돼요. 없으면 `--appimage-extract-and-run`을 붙이세요). deb/rpm은 배포판의 WebKitGTK 보안 업데이트를 그대로 받으니 되도록 deb/rpm을 쓰세요.
  - 0.2.1까지의 AppImage는 Arch Linux(Mesa 26)에서 창이 빈 채로 떠요(`Could not create default EGL display: EGL_BAD_PARAMETER`). 안에 든 Ubuntu 22.04의 `libwayland-client`가 시스템 것을 가려서 새 Mesa를 읽지 못해요. Mesa가 새로운 다른 배포판도 그럴 수 있어요. 0.2.1 뒤의 릴리스부터는 이 라이브러리를 빼고 시스템 것을 써요. 0.2.1은 시스템 것을 먼저 읽게 해서 켜세요: `LD_PRELOAD=/usr/lib/libwayland-client.so.0 ./easy-study_0.2.1_amd64.AppImage` (Debian·Ubuntu 계열의 경로는 `/usr/lib/x86_64-linux-gnu/libwayland-client.so.0`).
  - 창이 하얗게만 보이면(일부 NVIDIA 드라이버) `WEBKIT_DISABLE_DMABUF_RENDERER=1 easy-study`로 켜 보세요.

### 업데이트

0.5.0부터 앱이 새 버전을 알아서 확인해요 (켤 때와 6시간마다, 공개 릴리스 페이지의 `latest.json`을 GitHub에서 받아 봐요. 연결 선택 화면의 **⚙ 앱 설정 › 시작할 때 새 버전 확인**에서 끌 수 있어요: 메뉴 **연결 › 연결 대상 바꾸기…** 로 그 화면에 가요). 새 버전이 있으면 위쪽에 안내가 나오고, **업데이트하고 다시 시작**을 누르면 받아서 설치한 뒤 앱이 다시 켜져요. 메뉴 **업데이트 확인…** 으로 바로 확인할 수도 있어요.

- 앱 안에서 설치되는 것: macOS(‘응용 프로그램’ 폴더에 둔 앱), Windows 설치 파일로 설치한 앱, Linux AppImage. 받은 파일은 앱에 들어 있는 공개 키로 서명을 확인하고, 맞지 않으면 설치하지 않아요.
- deb·rpm·Arch 패키지, dmg에서 바로 연 앱은 알려 주기만 해요: 다운로드 페이지에서 새 파일을 받아 설치하세요.
- 녹음 중이거나 녹음한 소리를 아직 보내는 중이면 설치하지 않아요. 답변을 만들거나 파일을 올리는 중이면 먼저 물어봐요.
- 0.4.2 이하는 업데이트 기능이 없어서 0.5.0을 한 번 직접 받아 설치해야 해요.

### Arch Linux

`easy-study-bin` 패키지는 릴리스의 .deb(CI가 빌드하고 시험한 바로 그 파일)를 풀어서 만들어요(`packaging/arch/PKGBUILD`). 파일 위치는 deb와 같고(`/usr/bin/easy-study`, `/usr/lib/easy-study/`), WebKitGTK 같은 라이브러리는 Arch 패키지를 써서 보안 업데이트도 그대로 받아요. 앱 안에서는 업데이트되지 않으니, 새 버전이 나오면 아래처럼 다시 설치하세요.

릴리스에는 CI가 만들고 시험한 x86_64 패키지와 그 PKGBUILD가 들어 있어요. 받아서 바로 설치하세요 (예: `<버전>` = `0.5.0`). 0.4.2까지는 비공개 저장소의 릴리스라 `gh release download v<버전> --repo Wooangha/easy-study`로 받아요.

```bash
curl -LO https://github.com/Wooangha/easy-study-releases/releases/download/v<버전>/easy-study-bin-<버전>-1-x86_64.pkg.tar.zst
sudo pacman -U ./easy-study-bin-<버전>-1-x86_64.pkg.tar.zst   # webkit2gtk-4.1, gtk3 등 필요한 패키지도 같이 설치돼요
sudo pacman -S --needed noto-fonts-cjk   # 한글 글꼴: 화면이 한국어라 필요해요 (다른 한글 글꼴이 있으면 생략)
```

직접 만들 때(aarch64이거나 패키지를 직접 만들고 싶을 때): 릴리스의 PKGBUILD를 받아 그 폴더에서 `makepkg -si`를 실행하면 makepkg가 공개 릴리스의 .deb를 받아 SHA-256을 확인해요 (.deb를 옆에 받아 두면 그 파일을 써요). 저장소의 PKGBUILD는 `pkgver`의 릴리스용이에요.

```bash
sudo pacman -S --needed base-devel
mkdir easy-study-pkg && cd easy-study-pkg
curl -LO https://github.com/Wooangha/easy-study-releases/releases/download/v<버전>/PKGBUILD
makepkg -si
```

지울 때는 `sudo pacman -R easy-study-bin` (라이브러리와 설정 폴더는 남아요). CI는 빌드할 때마다 최신 Arch Linux 컨테이너에서 x86_64 AppImage와 이 PKGBUILD로 만든 패키지를 켜 보고(`EASY_STUDY_DESKTOP_SMOKE`), 패키지 설치와 삭제까지 시험해요. aarch64(Arch Linux ARM)는 아직 시험하지 않았어요. 릴리스가 나오면 그 PKGBUILD를 `packaging/arch/`에 복사하고 `makepkg --printsrcinfo > .SRCINFO`를 실행하세요.

AppImage도 Arch에서 돼요 (0.2.1은 위의 `LD_PRELOAD`가 필요해요). 더블클릭으로 켜려면 `fuse3`(또는 `fuse2`)가 있어야 하고, 없으면 `--appimage-extract-and-run`을 붙이세요. 한글 글꼴(`noto-fonts-cjk` 등)은 똑같이 필요해요. 글꼴이 없으면 창에 글자가 하나도 안 보여요.

### 데이터 위치

‘이 컴퓨터에서 실행’의 라이브러리는 기본으로 앱 데이터 폴더에 있어요. 시작 화면의 **라이브러리 폴더 선택…**으로 이미 쓰던 폴더(예: 저장소의 `library/`)를 고를 수도 있어요. 다만 같은 폴더를 `npm start`로 켠 서버와 동시에 쓸 수는 없어요: 앱이 서버를 켜지 못하고 시작 화면에 이유(서버 로그의 마지막 줄)를 보여 줘요.

| | 라이브러리 (기본) | 앱 설정 (`desktop.json`) | 로그 (`shell.log`, `server.log`) |
|---|---|---|---|
| macOS | `~/Library/Application Support/dev.easystudy.desktop/library` | `~/Library/Application Support/dev.easystudy.desktop` | `~/Library/Logs/dev.easystudy.desktop` |
| Windows | `%LOCALAPPDATA%\dev.easystudy.desktop\library` | `%APPDATA%\dev.easystudy.desktop` | `%LOCALAPPDATA%\dev.easystudy.desktop\logs` |
| Linux | `~/.local/share/dev.easystudy.desktop/library` | `~/.config/dev.easystudy.desktop` | `~/.local/share/dev.easystudy.desktop/logs` |

받아쓰기 모델(수백 MB)은 라이브러리 옆 `models` 폴더(예: macOS `~/Library/Application Support/dev.easystudy.desktop/models`)에 받아요. 라이브러리를 다른 폴더로 골라도 모델은 여기 있어요.

앱의 서버는 `http://127.0.0.1:5350`(쓰고 있으면 5351–5359)에서 이 컴퓨터에만 열려요 — **다른 기기에서 접속 허용** 스위치를 켜면 같은 네트워크에도 열려요 (`desktop.json`의 `share`). 포트를 기억해 두기 때문에 화면 설정(마지막으로 본 강의 등)이 다음 실행에도 이어져요. 다른 컴퓨터에 `http://`로 연결할 때 쓰는 중계 포트(`proxyPort`, 기본 5360–5369)도 기억해요. 앱을 끄면(강제 종료나 충돌이어도) 서버와 그 서버가 띄운 CLI, 중계 프로세스도 같이 꺼져요.

### 직접 빌드하기

필요한 것: Node.js 26, Rust (stable, `rustup`), `cmake`, 그리고 OS별 도구 — macOS는 Xcode Command Line Tools(와 `pkg-config`), Windows는 Visual Studio C++ Build Tools(C++ CMake 도구 포함), Linux는 [Tauri의 패키지 목록](https://v2.tauri.app/start/prerequisites/)(`libwebkit2gtk-4.1-dev` 등)과 AppImage용 `xdg-utils`, `squashfs-tools`. Linux용 ffmpeg는 `docker`로 alpine 컨테이너에서 빌드해요.

```bash
npm ci
npm run desktop:build        # 이 컴퓨터용: macOS .app + .dmg, Windows NSIS 설치 파일, Linux .deb/.rpm/AppImage
npm run desktop:build -- --target x86_64-apple-darwin   # Apple silicon Mac에서 Intel Mac용 (rustup target add x86_64-apple-darwin)
npm run desktop:dev          # 개발용으로 바로 실행 (tauri dev)
npm run desktop:test         # 앱 설정 검사 (IPC는 시작 화면에만, 대상별 번들 설정); 셸 자체는 desktop/src-tauri에서 cargo test
```

`desktop:build`는 저장소를 빌드하고(`npm run build`), 앱에 넣을 공식 Node.js(nodejs.org, SHA-256 확인, 버전은 `desktop/package.json`의 `easyStudy.nodeVersion`)와 그 대상 OS용 `node_modules`를 담은 서버, 그리고 [강의 녹음](#강의-녹음)용 도구 둘을 `desktop/resources/`에 준비한 뒤 Tauri로 묶어요. 결과는 `desktop/src-tauri/target/<대상>/release/bundle/`에 나와요. Linux에서는 마지막에 AppImage에서 사용자 시스템의 것을 써야 하는 라이브러리(`libwayland-client`: Mesa가 자기 버전을 필요로 해요)를 빼요 (`desktop/scripts/appimage.mjs`, `squashfs-tools` 필요). Windows 설치 파일은 Windows에서, Linux 패키지는 Linux에서 빌드하세요. GitHub Actions(`.github/workflows/desktop.yml`)는 테스트를 먼저 돌린 뒤 macOS(arm64·x64)·Windows·Linux(x64·arm64)용을 모두 빌드하고(녹음 도구도 대상마다 빌드해서 캐시해요), 앱을 켜 본 다음 앱에 든 녹음 도구로 받아쓰기까지 시험하고, x86_64 Linux용은 최신 Arch Linux에서도 시험하고, `v*` 태그를 올리면 초안(draft) 릴리스를 만들어요 (macOS용은 업데이트에 쓰는 `.app.tar.gz`도 만들어요). 릴리스에는 LGPL에 따라 ffmpeg의 소스(`easy-study-ffmpeg-8.1-source.tar`)도 같이 올라가요. 공개 릴리스 페이지에 올리고 업데이트 파일에 서명하는 것은 CI가 아니라 `desktop/scripts/publish-release.mjs`가 해요 ([docs/HANDOFF.md](docs/HANDOFF.md)). `APPLE_*` 시크릿을 넣으면 macOS 앱을 서명·공증해요.

녹음 도구는 Node처럼 앱에 들어가요 (macOS·Windows는 앱의 `whisper/`, `ffmpeg/` 리소스, Linux는 `/usr/bin/es-whisper`, `/usr/bin/es-ffmpeg`). 앱이 서버에 `EASY_STUDY_WHISPER`, `EASY_STUDY_FFMPEG`, `EASY_STUDY_MODELS_DIR`(앱 데이터 폴더의 `models`)로 넘겨요.

- **whisper-cli** (whisper.cpp 1.9.4, `desktop/scripts/whisper.mjs`): 고정한 소스(SHA-256 확인)를 대상마다 빌드해 저장소의 `.cache/whisper/<대상>/`에 두고, 버전과 빌드 옵션이 같으면 다시 빌드하지 않고 써요 (Apple silicon 약 20초). Apple silicon은 Metal, 나머지는 CPU로 받아쓰고, Windows는 CPU에 맞는 코드를 실행할 때 골라요. Intel Mac·Linux x64용은 AVX2가 있는 CPU(2013년 이후 Intel, 2015년 이후 AMD)에서 돌아요.
- **ffmpeg** (FFmpeg 8.1 최소 LGPL 빌드 + libopus, `desktop/scripts/ffmpeg.mjs`, `build-ffmpeg.sh`, `ffmpeg-min.flags`): `.cache/ffmpeg/<대상>/`에 빌드해 두고 다시 써요. macOS는 이 Mac에서(약 30초), Linux용은 docker의 alpine 컨테이너에서, Windows용은 mingw-w64로 빌드해요.
- 이 컴퓨터에서 빌드할 수 없는 도구(예: `cmake`나 docker가 없을 때)는 경고를 보여 주고 빼고 묶어요. 그 앱은 PATH에서 찾아요: 개발하는 Mac이라면 Homebrew의 `ffmpeg`(`brew install ffmpeg`)를 그대로 써요. 배포할 앱은 `--require-tools`로 빌드하세요(CI가 그렇게 해요): 도구가 빠지면 실패해요.
- 웹 모드용 whisper-cli는 `node desktop/scripts/whisper.mjs --web`으로도 만들 수 있어요 (같은 빌드를 서버가 찾는 `.cache/whisper/bin/`에 넣어요).
- `node desktop/scripts/asr-smoke.mjs --whisper <whisper-cli> --ffmpeg <ffmpeg>`: 앱에 든 두 도구를 직접 시험해요 (OS의 음성 합성으로 만든 영어 문장, 없으면 만든 소리를 올린 녹음처럼 변환하고, 작은 모델(`ggml-base-q5_1`, `.cache/asr-smoke`에 받아 둬요)로 받아써요). 마이크는 쓰지 않아요.

시험용 환경 변수: `EASY_STUDY_DESKTOP_LIBRARY`(라이브러리 폴더 지정), `EASY_STUDY_DESKTOP_HOME`(설정·로그·기본 라이브러리를 다른 폴더에), `EASY_STUDY_DESKTOP_SMOKE`(확인한 뒤 앱이 스스로 종료해요. 결과는 `EASY_STUDY_DESKTOP_SMOKE`로 시작하는 줄과 종료 코드: 0 성공, 2 서버·연결 실패, 3 시간 초과(`EASY_STUDY_DESKTOP_SMOKE_TIMEOUT`, 기본 120초), 4 확인 실패, 5 실패 뒤에도 시작 화면이 ‘진행 중’에 멈춤).

- `=1`: 서버를 바로 켜고, 화면이 뜨는지, `/api/health`가 답하는지, 서버 화면에 IPC가 없는지, 작은 PDF를 올려 변환하고 슬라이드 이미지를 받아지는지, 화면에 녹음에 필요한 기능(안전한 주소, `getUserMedia`, AudioWorklet)이 있는지(마이크는 열지 않아요), 서버가 받아쓰기 엔진과 ffmpeg를 찾는지(`/api/asr`; `EASY_STUDY_DESKTOP_SMOKE_ASR=0`이면 건너뛰어요), 화면이 앱 안인 것을 알고(`__EASY_STUDY_DESKTOP__`) 앱의 상태를 받는지(스모크 실행은 업데이트를 확인하지 않아요) 확인해요 (올린 강의는 다시 지워요). `EASY_STUDY_DESKTOP_SMOKE_URL`/`_CODE`를 주면 그 서버에 연결해서 확인해요 (PDF는 올리지 않아요; `http://` 주소면 앱 안의 중계를 거쳐요). `EASY_STUDY_DESKTOP_SMOKE_WRITE=1`이면 연결한 서버에 써도 되는 시험 서버로 보고, 다른 컴퓨터의 서버에도 PDF를 올리고, 가짜 CLI로 답변 스트림(SSE)이 흐르는지와 짧은 WAV를 녹음 파일로 올릴 수 있는지까지 확인해요 (시험 서버에만 쓰세요). `desktop.json`에 `"share": true`를 두고 실행하면 공유 모드로 켠 서버(로그인 필요, 앱은 스스로 로그인)를 확인해요. `EASY_STUDY_DESKTOP_FORCE_PROXY=1`은 `127.0.0.1`·`localhost` 주소의 서버도 중계를 거치게 해요 (평소에는 이미 안전한 주소라 바로 연결해요; 이 컴퓨터에서 중계를 시험할 때).
- `=chooser`: 시작 화면만 확인해요 (IPC로 받은 라이브러리 경로, 스타일).
- `=chooser-local`, `=chooser-remote`: 시작 화면의 양식을 채우고 ‘연결’을 눌러요. 버튼을 누를 때와 같은 길(IPC `connect_local`/`connect_remote`)로 연결한 뒤 `=1`과 같은 확인을 해요. `=chooser-remote`는 `EASY_STUDY_DESKTOP_SMOKE_URL`/`_CODE`를 써요. 실패는 시작 화면에 보이는 오류로 판단해요.

앱을 시험할 때 알아 둘 것: 스모크 실행은 이미 켜진 easy-study에 넘기지 않고 따로 실행돼요. 하지만 보통 실행은 컴퓨터 전체에서 하나만 돼요(두 번째 실행은 켜진 창을 앞으로 가져오고 끝나요). WebView의 쿠키·저장소는 `EASY_STUDY_DESKTOP_HOME`과 상관없이 OS의 앱 폴더를 같이 써요. 그러니 앱 시험은 한 번에 하나씩 하세요. macOS에서 `CFFIXED_USER_HOME`으로 WebView 데이터를 옮기면 쿠키가 저장되지 않으니 로그인 유지 시험에는 쓰지 마세요. Linux에서 WebDriver(tauri-driver)로 시험하면 `target=_blank` 링크의 새 창이 열리지 않고, 시작 화면 스크린숏이 스크립트 실행 전 모습으로 찍혀요. 새 창과 화면 모습은 앱을 직접 실행해서 xdotool과 X 스크린숏으로 확인하세요. Docker 같은 곳에서 Linux 패키지를 빌드할 때는 `xdg-utils`(AppImage에 `xdg-open`이 들어가요)와 `squashfs-tools`도 설치하세요. 구조와 계약은 [docs/DESIGN.md](docs/DESIGN.md) §19(앱), §22(강의 녹음), §24(업데이트, 설정)에 있어요.

## 강의 녹음

수업 중에 앱에서 바로 녹음하면 이 컴퓨터에서 받아쓰고([whisper.cpp](https://github.com/ggml-org/whisper.cpp)), 받아쓴 말을 슬라이드마다 나눠요. 튜터는 지금 슬라이드에서 교수님이 한 말까지 알고 답하고, 나중에는 녹음을 슬라이드와 맞춰 다시 들을 수 있어요. 이미 녹음해 둔 파일도 올릴 수 있어요. 받아쓰기는 API 키 없이 이 컴퓨터에서만 해요.

> **녹음하기 전에**: 수업 녹음은 교수님과 학교의 규정을 따르세요. 허락받지 않은 수업은 녹음하지 말고, 녹음과 받아쓴 글은 내 공부에만 쓰고 다른 사람에게 나누지 마세요. 처음 녹음할 때 앱이 한 번 확인해요.

### 수업 중에 녹음하기

1. 강의를 열고 위쪽의 🎙 **녹음**(또는 **녹음** 탭의 **🎙 녹음 시작**)을 눌러요. 처음에는 마이크 권한을 물어요 (macOS: “easy-study”가 마이크에 접근 → 허용. Windows: 설정 › 개인 정보 및 보안 › 마이크에서 마이크 액세스와 ‘데스크톱 앱이 마이크에 액세스하도록 허용’이 켜져 있어야 해요).
2. 녹음하는 동안 평소처럼 슬라이드를 넘기세요. 넘긴 시각이 녹음과 같이 저장되어서, 받아쓴 말이 그때 보던 슬라이드에 붙어요 (말의 내용으로 조금 보정해요). 다른 강의를 보거나 앱 창을 내려도 녹음은 계속돼요.
3. 받아쓴 글은 몇 초에서 몇십 초 늦게 **녹음** 탭에 나타나요. 느린 컴퓨터라면 설정에서 **녹음하면서 받아쓰기**를 끄세요: 녹음을 끝낸 뒤에 한꺼번에 받아써요.
4. 녹음하는 동안 질문하면 최근 몇 분 동안 교수님이 한 말이 질문과 같이 튜터에게 가요 (입력칸 위에 “🎙 최근 N분 포함”).
5. 끝나면 **녹음 끝내기**. 남은 받아쓰기와 슬라이드 정렬이 이어서 진행돼요.

쉬는 시간에 **일시정지**하면 마이크도 꺼져요 (**계속**을 누르면 다시 켜져요). 한 번에 하나만 녹음할 수 있어요. 다른 기기나 브라우저에서 하던 녹음이 그 기기가 꺼져서 끝나지 않은 채 남아 있다면, **녹음** 탭에서 그 녹음의 메뉴 › **녹음 끝내기**로 서버에 올라온 부분까지로 끝낼 수 있어요.

소리는 몇 초마다 서버(이 컴퓨터)에 저장돼요. 페이지를 새로 고치거나 앱이 꺼져도 저장된 곳까지는 남고, 다시 열면 이어서 녹음할 수 있어요. 노트북은 충전기를 꽂고, 덮개를 닫지 마세요 (잠자기에 들어가면 녹음도 멈춰요). 강의실 뒤쪽이라면 외장 마이크가 훨씬 잘 받아써요.

### 녹음 파일 올리기

강의 목록의 메뉴나 **녹음** 탭의 **녹음 파일 올리기**로 휴대폰 녹음(m4a), mp3, wav, 녹화한 강의 동영상(mp4, mov, webm) 등을 올려요 (최대 4GB). 받아쓰기용 소리와 재생용 파일(m4a)로 바꾼 뒤 받아쓰고, 슬라이드의 글과 비교해 슬라이드마다 나눠요.

### 녹음 탭

- 녹음 목록과 진행 상황, 지금 보는 슬라이드에서 교수님이 한 말 (전체 보기도 돼요).
- 받아쓴 줄을 누르면 거기서부터 재생해요. **슬라이드 따라가기**를 켜면 재생하는 부분의 슬라이드로 넘어가요.
- 슬라이드가 잘못 붙었다면 그 줄에서 **여기부터 p.N**으로 고쳐요. 나머지는 1초 안에 다시 맞춰요. 교수님이 잠깐 앞 슬라이드로 돌아간 곳에 표시해도 그 앞부분은 그대로 둬요.
- **AI 정밀 정렬**: 고른 LLM(Claude Code, Codex, API)에게 받아쓴 글과 슬라이드 글(정리본이 있으면 정리본)을 보내 더 정확히 나눠요. 몇 분 걸리고 LLM 사용량이 들어요. 소리는 보내지 않고, 직접 고친 구간(📍)은 그대로 둬요.
- 설정: 음성 인식 모델(정확·빠름), 강의 언어(한국어·영어·자동 감지), 녹음하면서 받아쓰기.

영어 용어는 한글로 적히는 일이 많아요(production → 프로덕션, FIRST → 퍼스트). 튜터는 그대로 알아들어요.

### 모델, 저장 공간, 메모리

받아쓰기 모델은 앱이나 저장소에 들어 있지 않고, 처음 쓸 때 크기를 보여 주고 받아요 (Hugging Face에서, 이어받기가 되고 SHA-256을 확인해요). 음성 구간을 찾는 Silero VAD(0.9MB)도 같이 받아요.

| 모델 | 받는 크기 | 메모리(받아쓰는 동안) | 속도 (1시간 녹음) |
|---|---|---|---|
| **정확** (large-v3-turbo, 기본) | 574MB | 약 1–1.6GB | Apple silicon(Metal) 약 6분. CPU만 쓰면 녹음 길이의 절반에서 2배 |
| **빠름** (small) | 190MB | 약 0.7GB | CPU에서 정확 모델보다 약 4배 빨라요. 오류는 조금 더 많아요 |

- CPU만 쓰는 컴퓨터(Windows·Linux·Intel Mac)에서는 **빠름**을 권해요. 받아쓰기는 한 번에 하나씩만 돌아서 메모리가 그 이상 늘지 않아요.
- Apple silicon에서 처음 받아쓸 때는 준비에 20초쯤 걸려요 (그다음부터는 바로 시작해요).
- 모델 위치: 앱은 앱 데이터 폴더의 `models`([데이터 위치](#데이터-위치)), 웹 모드는 저장소의 `.cache/models` (`EASY_STUDY_MODELS_DIR`로 바꿀 수 있어요). 녹음 탭에서 지울 수 있어요.
- 녹음 한 시간에 쓰는 공간: 앱에서 녹음하면 약 115MB(16kHz 원음), 파일을 올리면 원본 + 받아쓰기용 소리 약 110MB + 재생용 m4a 약 28MB. 녹음을 지우면 전부 지워져요.

### 개인정보

- 녹음, 받아쓰기, 슬라이드 정렬은 모두 이 컴퓨터(또는 연결한 easy-study 서버)에서 해요. 소리는 인터넷으로 나가지 않아요. 인터넷은 모델을 처음 받을 때만 써요.
- 튜터에게 질문하면 그 슬라이드의 받아쓴 글(일부)이 질문과 같이 고른 LLM(Claude Code, Codex, API)으로 가요. **AI 정밀 정렬**도 받아쓴 글과 슬라이드 글을 보내요. 녹음 파일은 보내지 않아요.
- 녹음은 라이브러리의 강의 폴더 `recordings/`에 저장돼요 ([저장 위치](#저장-위치)). **녹음** 탭에서 지우면 소리, 받아쓴 글, 정렬이 모두 지워져요.

### 다른 기기에서 녹음하기

브라우저는 **안전한 주소에서만** 마이크를 쓰게 해요. 서버를 켠 컴퓨터의 데스크톱 앱이나 `http://127.0.0.1:5180`은 되지만, 다른 기기(태블릿, 다른 노트북)의 브라우저에서 `http://192.168.x.x:5180`처럼 일반 HTTP로 접속하면 녹음 버튼이 동작하지 않아요. 방법은 둘이에요.

- **easy-study 앱끼리**: 다른 노트북에서 easy-study 앱의 **다른 컴퓨터에 연결**로 접속하면 `http://` 주소여도 녹음돼요. 앱이 자기 안에서 `http://127.0.0.1:<포트>`로 중계해서 마이크를 쓸 수 있는 주소로 보여 주고, 요청은 그대로 서버 컴퓨터로 보내요 (녹음 소리도 그 컴퓨터에 저장돼요). 믿을 수 있는 네트워크에서만 쓰세요: 로그인과 소리가 암호화 없이 지나가고, 같은 네트워크의 누군가가 화면을 바꿔치기하면 그 화면이 마이크와 로그인을 쓸 수 있어요. 다른 곳에서는 Tailscale이나 HTTPS를 쓰세요.
- **태블릿·폰의 브라우저**(iPad, Android, 다른 컴퓨터의 Chrome/Safari): 여전히 HTTPS가 필요해요. [HTTPS로 쓰기](#https로-쓰기)(`tailscale serve`, 또는 `EASY_STUDY_TLS_CERT`/`_KEY`)로 접속하세요. 다른 네트워크(집 밖)에서는 어느 기기든 Tailscale을 권해요.

녹음 파일 올리기는 어디서든 HTTP로도 돼요. iPad·iPhone의 Safari는 화면이 켜져 있고 easy-study가 앞에 있을 때만 녹음해요 (화면이 잠기거나 다른 앱으로 가면 끊겨요).

### 웹 모드(npm start)에서 쓸 때

데스크톱 앱에는 받아쓰기 엔진(whisper-cli)과 ffmpeg가 들어 있어요. `npm start`로 쓸 때는 따로 준비하세요.

```bash
npm run setup:whisper    # whisper.cpp를 이 컴퓨터용으로 빌드해 .cache/whisper/bin에 둬요 (cmake와 C++ 컴파일러가 필요해요)
brew install ffmpeg      # 녹음 파일 올리기용 (Ubuntu: sudo apt install ffmpeg, Arch: sudo pacman -S ffmpeg, Windows: winget install ffmpeg)
```

직접 빌드한 프로그램은 `EASY_STUDY_WHISPER`, `EASY_STUDY_FFMPEG`로 지정할 수도 있어요. 앱에서 녹음만 하고 받아쓰기는 나중에 해도 돼요: 엔진이 없으면 녹음과 파일 올리기는 되고, 받아쓰기는 엔진이 준비되면 시작돼요.

### 녹음 문제 해결

- **“이 연결에서는 녹음할 수 없어요”**: 브라우저로 일반 HTTP 주소에 접속했어요. easy-study 앱으로 그 컴퓨터에 연결하거나(앱 안에서는 `http://`여도 돼요), 위의 HTTPS 방법을 쓰거나, 서버 컴퓨터에서 앱이나 `http://127.0.0.1`로 녹음하세요.
- **macOS에서 마이크를 거부했을 때 / 녹음은 되는데 소리가 없을 때**: 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 easy-study를 켜고 앱을 다시 켜세요. 서명하지 않은 앱이라 새 버전으로 바꾸면 권한을 다시 물을 수 있어요.
- **Windows에서 마이크를 쓸 수 없을 때**: 설정 › 개인 정보 및 보안 › 마이크(Windows 10은 설정 › 개인 정보 › 마이크)에서 “마이크 액세스”와 “데스크톱 앱이 마이크에 액세스하도록 허용”을 켜세요.
- **Linux에서 “마이크를 찾지 못했어요”**: 마이크가 연결되어 있어도 오디오 서버(PulseAudio 또는 PipeWire의 `pipewire-pulse`)와 WebKitGTK가 쓰는 GStreamer 플러그인이 있어야 해요 (Ubuntu·Debian `gstreamer1.0-plugins-good`, Fedora `gstreamer1-plugins-good`, Arch `gst-plugins-base gst-plugins-good`). deb/rpm은 같이 설치해요. AppImage는 시스템에 설치된 플러그인을 써요.
- **Linux에서 올린 녹음이 재생되지 않을 때**: AAC(m4a) 재생 플러그인을 설치하세요 (`gstreamer1.0-libav`, Fedora `gstreamer1-plugin-libav`, Arch `gst-libav`). 받아쓰기와 앱에서 한 녹음의 재생은 상관없어요.
- **받아쓰기가 너무 느릴 때**: 설정에서 **빠름** 모델로 바꾸고, **녹음하면서 받아쓰기**를 끄세요.
- **“받아쓰기 엔진(whisper-cli)을 찾을 수 없습니다”**: 앱은 다시 설치하세요. 웹 모드는 `npm run setup:whisper`.
- **Linux x64 앱에서 받아쓰기가 바로 실패할 때**: 앱의 whisper-cli는 AVX2가 있는 CPU(2013년 이후 Intel, 2015년 이후 AMD)용이에요. 그보다 오래된 CPU나 일부 저가 Celeron·Pentium이라면 이 컴퓨터에서 whisper.cpp를 빌드해(`node desktop/scripts/whisper.mjs --web`) 터미널에서 `EASY_STUDY_WHISPER=<그 whisper-cli> easy-study`로 켜세요. Windows 앱은 CPU에 맞는 코드를 스스로 골라요.

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
    recordings/<녹음 id>/      강의 녹음: meta.json, 소리(audio.pcm 또는 올린 원본 + asr.wav, playback.m4a),
                               transcript.json(받아쓴 글과 슬라이드), timeline.json(넘긴 슬라이드), markers.json
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

모델은 새 세션을 만들 때 상단 **새 세션**에서 고를 수 있어요. "CLI 기본값"·"Codex 설정 기본값"은 각 CLI 설정의 기본 모델을 따라요.

- **Claude Code**: Sonnet · Opus · Haiku · Fable 중에서 골라요.
- **Codex**: 설치된 Codex CLI가 알려 주는 모델 목록(`codex debug models`, Codex의 모델 선택과 같은 목록)에서 골라요. 목록은 서버가 30분마다 새로 읽어요. 이 목록을 모르는 옛 Codex CLI에서는 기본값만 나와요.
- 목록에 없는 모델은 **직접 입력…** 으로 이름을 넣으면 돼요.

Claude Code와 Codex는 **추론** 수준도 고를 수 있어요 (낮음 · 보통 · 높음 · 매우 높음 · 최대, Codex는 모델에 따라 울트라까지). 높을수록 더 깊이 생각하지만 답이 느려지고 사용량(한도)을 더 써요. **추론 기본값**이면 아무것도 넘기지 않아서 CLI 설정(예: Codex `config.toml`의 `model_reasoning_effort`)을 따라요. 고른 모델이 지원하지 않는 수준은 목록에 나오지 않고, 모델을 바꾸면 기본값으로 돌아가요. 모델과 추론 수준은 세션을 만들 때 정해져서 그 세션의 모든 질문과, 그 세션이 시작한 정리본에 그대로 쓰여요.

**토큰 사용량**은 답변마다 아래에 작게 나와요 (예: "입력 4.7만 (캐시 4.1만) · 출력 820", 답변이 나오는 동안 실시간으로 늘어나요). 입력창 아래에는 이 세션에서 쓴 토큰 합계와, 구독 CLI가 알려 주면 **사용 한도**("5시간 한도 12% · 주간 9%")가 나와요. 사용 한도는 계정 전체의 것이라 어느 세션에서 받았든 가장 최근 값을 보여 주고, 한 시간 넘게 지난 값이면 "14:30 기준"처럼 시각이 붙어요. 한도가 80%를 넘으면 색이 바뀌고 초기화 시각이 함께 나와요. 마우스를 올리면 정확한 숫자를 볼 수 있어요. Claude Code는 답변마다 한도를 알려 주고, Codex는 `~/.codex/sessions`의 대화 기록에서 읽어요 (정리본처럼 기록을 남기지 않는 호출은 토큰만 나와요). API 키 제공자는 토큰만 보여 줘요.

## 설정 (⚙)

화면 오른쪽 위 **⚙** 를 누르면 설정이 열려요 (앱에서는 메뉴 **설정…**, macOS `⌘,`, Windows·Linux `Ctrl+,`도 돼요). 보던 강의는 그대로 있고, `Esc`로 닫아요.

- **화면**: 테마(시스템 설정 따르기 · 라이트 · 다크). 브라우저에서는 그 브라우저에만 저장되고, 앱에서는 앱의 모든 창(연결 선택 화면 포함)에 적용돼요.
- **공부**: 질문과 함께 보낼 앞뒤 슬라이드 수. 대화 창의 ‘앞뒤 ±N’과 같은 설정이에요.
- **녹음**: 녹음 탭의 ⚙ 설정과 같은 것(음성 인식 모델, 강의 언어, 녹음하면서 받아쓰기)과 **녹음 안내 다시 보기**.
- **데스크톱 앱**(앱에서만): 앱 버전과 업데이트(**업데이트 확인**, **업데이트하고 다시 시작**), 지금 연결 대상과 시작할 때 할 일, **연결 대상 바꾸기…**, 그리고 ‘이 컴퓨터에서 실행’ 중이면 **다른 기기에서 접속 허용** 스위치와 그 주소·접속 코드(복사 버튼), **접속 코드 새로 만들기 (모든 기기 로그아웃)**. 새 버전이 나오면 ⚙에 점이 찍히고 위쪽에 안내가 나와요. 녹음 중에는 업데이트를 설치하거나 접속 허용을 바꿀 수 없고, 답변을 만들거나 파일을 올리는 중이면 먼저 물어봐요. deb·rpm·Arch 패키지로 설치했다면 다운로드 페이지에서 새 패키지를 받아요.
- **정보**: 서버 버전(다른 컴퓨터의 서버가 앱보다 오래됐으면 알려 줘요), 라이브러리 폴더, 단축키.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `5180` | 서버 포트 |
| `EASY_STUDY_HOST` | `127.0.0.1` | 바인딩 주소. 127.0.0.1이 아니면(예: `0.0.0.0`) 원격 모드가 되어 접속 코드가 필요해요. `npm run serve:remote`는 `0.0.0.0`을 써요. |
| `EASY_STUDY_AUTH` | `auto` | `on`이면 127.0.0.1에서도 로그인이 필요해요 (`tailscale serve` 같은 리버스 프록시용). `off`는 127.0.0.1에서만 쓸 수 있어요. |
| `EASY_STUDY_DESKTOP_SHARE` | 앱이 정해요 | 데스크톱 앱이 켠 서버 전용: `1`이면 ‘다른 기기에서 접속 허용’(0.0.0.0, 로그인 필요). 앱의 스위치가 넘기고, 사용자 환경의 값은 앱이 지워요. `EASY_STUDY_DESKTOP_RESET_CODE=1`은 ‘접속 코드 새로 만들기’. |
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
| `EASY_STUDY_WHISPER` | 앱에 든 것 → `.cache/whisper/bin` → PATH | 받아쓰기 엔진 `whisper-cli`의 경로 ([강의 녹음](#강의-녹음)) |
| `EASY_STUDY_FFMPEG` | 앱에 든 것 → PATH | 녹음 파일을 변환할 `ffmpeg`의 경로 |
| `EASY_STUDY_MODELS_DIR` | `.cache/models` (앱: 앱 데이터 폴더의 `models`) | 받아쓰기 모델을 받아 둘 폴더 |
| `EASY_STUDY_PDF_FALLBACK_FONT` | OS 글꼴 | 글꼴을 내장하지 않은 한글·일본어·중국어 PDF를 그릴 글꼴 파일(`.ttf`/`.otf`/`.ttc`). 지정하지 않으면 macOS는 Arial Unicode·Apple SD Gothic Neo, Windows는 맑은 고딕·굴림·MS Gothic·Microsoft YaHei, Linux는 Noto Sans CJK·나눔고딕 중 있는 것을 써요. |

## 문제 해결

- **`Claude Code 2.1.x does not support this model … Run 'claude update'`**: `~/.claude/settings.json`의 기본 모델이 설치된 CLI보다 새 버전을 요구하는 경우예요. `claude update`로 CLI를 업데이트하거나, 새 세션을 만들 때 모델을 `Sonnet`/`Opus`로 지정하세요.
- **Codex가 `Failed to initialize session` / `fs sandbox helper` 오류로 바로 멈출 때**: 설치된 Codex CLI가 읽기 제한(권한 프로필)을 지원하지 않는 경우예요. Codex CLI를 업데이트하고(0.154에서 확인), 그래도 안 되면 `EASY_STUDY_CODEX_CONFINE=0`으로 서버를 다시 시작하세요 (위 표의 경고 참고).
- **`the PDF is password protected`**: 암호가 걸린 PDF예요. 암호를 푼 PDF로 다시 저장해서(예: 미리보기에서 열고 암호 없이 내보내기) 올리세요.
- **`could not read the PDF: the file is damaged or is not a PDF`**: 파일이 깨졌거나 PDF가 아니에요. 원본에서 PDF로 다시 내보내 올리세요.
- **한글·일본어·중국어가 슬라이드 이미지에서 안 보일 때**: 글꼴을 내장하지 않은 PDF예요. 이때 서버 로그에 `[library] <문서>: the PDF uses a CJK font it does not embed, and no fallback font could be read (…)`가 한 번 찍혀요. 위 `EASY_STUDY_PDF_FALLBACK_FONT` 설명의 글꼴(Debian·Ubuntu는 `fonts-noto-cjk`, Arch는 `noto-fonts-cjk`)을 설치하거나 지정한 뒤, 문서를 지우고 다시 올리세요. 텍스트는 글꼴이 없어도 제대로 뽑혀요. `EASY_STUDY_PDF_FALLBACK_FONT`에 읽을 수 없는 경로를 지정하면 서버를 켤 때 경고가 나와요.
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
  recordings/      강의 녹음: 녹음 저장, 받아쓰기(whisper-cli), 파일 변환(ffmpeg), 슬라이드 정렬
shared/types.ts    서버와 웹이 같이 쓰는 API 타입
web/               React + Vite UI
tests/             node:test 테스트
```

## 라이선스

PDF 엔진으로 PDFium(BSD-3-Clause / Apache-2.0, `@embedpdf/pdfium` 패키지는 MIT)을 함께 배포해요. PDFium과 그 안에 들어 있는 라이브러리(FreeType, OpenJPEG, Little CMS, libjpeg-turbo, libpng, zlib, AGG)의 라이선스 전문은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있어요.
데스크톱 앱은 강의 녹음용으로 whisper.cpp(MIT)와 FFmpeg(LGPL 2.1 이상, libopus는 BSD-3-Clause)도 함께 배포해요. FFmpeg는 GPL 부분 없이 빌드하고, 빌드 설정과 소스를 받는 법, 처음 쓸 때 받는 모델(Whisper, Silero VAD: MIT)의 라이선스도 같은 파일에 있어요.
