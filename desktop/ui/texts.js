// The chooser's texts (DESIGN §27), in the shell's language (src-tauri/src/i18n.rs: the OS's, Korean or English; the
// page learns it from the marker window.__EASY_STUDY_DESKTOP__.lang and get_state). `ko` is the reference; `en` has
// exactly the same keys (desktop/scripts/i18n.test.mjs). The page's fixed texts are named in index.html
// (data-t="key", data-t-placeholder="key"); chooser.js reads the rest as T.<section>.<key>.
// A text is a string, a function (a text with values), or rich text: an array of strings, { b: '…' }, { code: '…' }
// and { slot: '<id>' } (an element of index.html with that id, kept as it is: its own text, listeners and id).
// Texts the shell itself makes (status lines, errors, the update's error and reason) come from i18n.rs.
'use strict';

const CHOOSER_TEXTS = {
  ko: {
    brand: {
      sub: '어디에서 공부할까요?',
    },
    common: {
      cancel: '취소',
      copy: '복사',
      copied: '복사됨',
      connect: '연결',
    },
    log: {
      summary: '서버 로그 (마지막 줄)',
      file: ['전체 로그: ', { slot: 'log-file' }],
    },
    mode: {
      legend: '연결 방식',
    },
    local: {
      title: '이 컴퓨터에서 실행',
      hint: '앱이 이 컴퓨터에서 easy-study 서버를 실행해요. 강의 자료와 기록은 아래 라이브러리 폴더에 저장돼요.',
      library: '라이브러리',
      pick: '라이브러리 폴더 선택…',
      useDefault: '기본 위치로',
      open: '폴더 열기',
      confirmYes: '이 폴더 쓰기',
      fromEnv: 'EASY_STUDY_DESKTOP_LIBRARY 환경 변수로 지정된 폴더예요.',
      isDefault: '기본 위치예요. 저장소의 library/ 같은 기존 폴더를 쓰려면 "라이브러리 폴더 선택…"을 누르세요.',
      isCustom: '직접 고른 폴더예요. 같은 폴더를 npm start로 실행 중인 서버와 함께 쓸 수는 없어요.',
    },
    remote: {
      title: '다른 컴퓨터에 연결',
      hint: '다른 컴퓨터에서 원격 모드로 실행 중인 easy-study 서버에 접속해요.',
      address: '주소',
      code: '접속 코드',
      codePlaceholder: '처음 연결할 때만 (예: k7qm2-x9fda-…)',
      help: [
        '주소와 접속 코드는 그 컴퓨터의 easy-study 앱(⚙ 설정 › 데스크톱 앱, 또는 이 화면의 ⚙ 앱 설정) 또는 ',
        { code: 'npm run start:remote' },
        '를 실행한 터미널에 표시돼요. 로그인은 30일 동안 유지돼요. ' +
          'http는 같은 네트워크(집·학교 Wi-Fi, Tailscale)에서만 쓸 수 있고(앱 안에서는 http 주소여도 녹음돼요), https는 이 컴퓨터가 신뢰하는 인증서(예: ',
        { code: 'tailscale serve' },
        ')여야 해요. ' +
          'http로는 같은 네트워크의 누군가가 오가는 내용을 엿보거나 바꿀 수 있어요 (바뀐 화면은 마이크와 로그인까지 쓸 수 있어요): 믿을 수 있는 네트워크에서만 쓰고, 다른 곳에서는 Tailscale·HTTPS를 쓰세요.',
      ],
    },
    form: {
      remember: '다음에도 바로 연결',
      rememberHint: '켜 두면 다음부터 이 화면 없이 바로 연결해요. ⚙ 설정에서 언제든 바꿀 수 있어요.',
      previous: (origin) => `방금까지 연결: ${origin}`,
    },
    status: {
      running: '이 컴퓨터의 서버가 실행 중이에요. "연결"을 누르면 돌아가요.',
      startingLocal: '이 컴퓨터에서 easy-study 서버를 시작하는 중…',
      enterAddress: (example) => `연결할 컴퓨터의 주소를 입력하세요 (예: ${example}).`,
      checking: '연결할 수 있는지 확인하는 중…',
      connecting: '연결하는 중…',
    },
    settings: {
      summary: '⚙ 앱 설정',
      theme: '화면 테마',
      themeSystem: '시스템 설정 따르기',
      themeLight: '라이트',
      themeDark: '다크',
    },
    update: {
      label: '업데이트',
      version: (version) => `버전 ${version}`,
      check: '지금 확인',
      install: '설치하고 다시 시작',
      download: '다운로드 페이지 열기 ↗',
      retry: '다시 시도',
      auto: '시작할 때 새 버전 확인 (GitHub에서 확인해요)',
      checking: '확인하는 중…',
      latest: '최신 버전이에요',
      available: (version) => `easy-study ${version} 버전이 나왔어요`,
      downloading: (progress) => `내려받는 중… ${progress}`,
      downloaded: (version) => `easy-study ${version} 버전을 받아 두었어요`,
      installing: '설치하는 중…',
      failed: '업데이트하지 못했어요',
      failedWith: (error) => `업데이트하지 못했어요: ${error}`,
      lastFailed: (error) => `마지막 확인 실패: ${error}`,
      notChecked: '아직 확인하지 않았어요',
      noteDownloading: (version, progress) => `easy-study ${version} 버전을 내려받는 중… ${progress}`,
      noteAvailable: (version, current) => `easy-study ${version} 버전이 나왔어요 (지금 ${current}).`,
    },
    share: {
      label: '다른 기기에서 접속',
      toggle: '다른 기기에서 접속 허용 (같은 네트워크, 접속 코드 필요)',
      off: '같은 Wi‑Fi의 다른 컴퓨터·태블릿에서 이 컴퓨터의 easy-study를 쓸 수 있어요. 켜거나 끄면 서버를 다시 시작해요.',
      idle: '‘이 컴퓨터에서 실행’으로 연결하면 주소와 접속 코드가 여기 나와요.',
      urls: '다른 기기에서 열 주소',
      noUrls: '네트워크 주소를 찾지 못했어요. Wi‑Fi나 이더넷에 연결한 뒤 스위치를 껐다 켜세요.',
      code: ['접속 코드 ', { slot: 'share-code' }, ' ', { slot: 'share-copy' }],
      codeUnreadable: '(코드를 읽지 못했어요)',
      reset: '접속 코드 새로 만들기 (모든 기기 로그아웃)',
      help:
        '코드를 아는 사람은 이 컴퓨터의 Claude/Codex로 질문하고 강의 파일을 보고 지울 수 있어요: 같은 Wi‑Fi처럼 믿을 수 있는 네트워크에서만 켜세요. ' +
        'macOS·Windows가 ‘node’의 네트워크 연결을 허용할지 물으면 허용하세요 (앱에 든 서버예요; 직접 빌드한 앱은 실행할 때마다 물을 수 있어요). ' +
        '다른 컴퓨터에서는 easy-study 앱의 ‘다른 컴퓨터에 연결’(녹음도 돼요) 또는 브라우저로 여세요. 태블릿·폰의 브라우저에서 녹음하려면 HTTPS가 필요해요. ' +
        'http로는 같은 네트워크의 누군가가 오가는 내용을 엿보거나 바꿀 수 있어요 (바뀐 화면은 마이크와 로그인까지 쓸 수 있어요): 믿을 수 있는 네트워크에서만 켜고, 다른 곳에서는 Tailscale·HTTPS를 쓰세요. ' +
        '주소가 바뀌면(다른 Wi‑Fi) 스위치를 껐다 켜세요.',
    },
    startup: {
      label: '시작할 때',
      local: '시작하면 ‘이 컴퓨터에서 실행’에 바로 연결해요.',
      remote: (url) => `시작하면 ‘${url}’에 바로 연결해요.`,
      ask: '시작하면 이 화면이 먼저 나와요. 바로 연결하려면 ‘다음에도 바로 연결’을 켜고 연결하세요.',
      forget: '다음부터 이 화면 먼저 보기',
    },
    logs: {
      open: '로그 폴더 열기',
    },
    footer: [
      '연결 대상은 나중에 앱 화면 오른쪽 위 ',
      { b: '⚙ 설정 › 연결 대상 바꾸기…' },
      ', 또는 메뉴 ',
      { b: '연결 › 연결 대상 바꾸기…' },
      ' (',
      { slot: 'shortcut' },
      ')에서 바꿀 수 있어요.',
    ],
  },

  en: {
    brand: {
      sub: 'Where do you want to study?',
    },
    common: {
      cancel: 'Cancel',
      copy: 'Copy',
      copied: 'Copied',
      connect: 'Connect',
    },
    log: {
      summary: 'Server log (last lines)',
      file: ['Full log: ', { slot: 'log-file' }],
    },
    mode: {
      legend: 'How to connect',
    },
    local: {
      title: 'Run on this computer',
      hint: 'The app runs the easy-study server on this computer. Lecture files and history are saved in the library folder below.',
      library: 'Library',
      pick: 'Choose library folder…',
      useDefault: 'Use default location',
      open: 'Open folder',
      confirmYes: 'Use this folder',
      fromEnv: 'This folder is set by the EASY_STUDY_DESKTOP_LIBRARY environment variable.',
      isDefault: 'This is the default location. To use an existing folder such as the repository\'s library/, press ‘Choose library folder…’.',
      isCustom: "You chose this folder. A server running from npm start can't use the same folder at the same time.",
    },
    remote: {
      title: 'Connect to another computer',
      hint: 'Connects to an easy-study server running in remote mode on another computer.',
      address: 'Address',
      code: 'Access code',
      codePlaceholder: 'Only the first time (e.g. k7qm2-x9fda-…)',
      help: [
        "The address and access code are shown in that computer's easy-study app (⚙ Settings › Desktop app, or ⚙ App settings on this screen) or in the terminal that ran ",
        { code: 'npm run start:remote' },
        '. A login lasts 30 days. ' +
          'http only works on the same network (home or school Wi-Fi, Tailscale; in the app, recording works even with an http address), and https needs a certificate this computer trusts (e.g. ',
        { code: 'tailscale serve' },
        '). ' +
          'Over http, someone on the same network can see or change what goes back and forth (a changed page could even use the microphone and your login): use it only on networks you trust, and use Tailscale or HTTPS elsewhere.',
      ],
    },
    form: {
      remember: 'Connect right away next time',
      rememberHint: 'When on, the app connects right away next time without this screen. You can change this anytime in ⚙ Settings.',
      previous: (origin) => `Previously connected: ${origin}`,
    },
    status: {
      running: 'The server on this computer is running. Press ‘Connect’ to go back to it.',
      startingLocal: 'Starting the easy-study server on this computer…',
      enterAddress: (example) => `Enter the address of the computer to connect to (e.g. ${example}).`,
      checking: 'Checking the connection…',
      connecting: 'Connecting…',
    },
    settings: {
      summary: '⚙ App settings',
      theme: 'Theme',
      themeSystem: 'Use system setting',
      themeLight: 'Light',
      themeDark: 'Dark',
    },
    update: {
      label: 'Updates',
      version: (version) => `Version ${version}`,
      check: 'Check now',
      install: 'Install and restart',
      download: 'Open download page ↗',
      retry: 'Try again',
      auto: 'Check for a new version at startup (checks GitHub)',
      checking: 'Checking…',
      latest: "You're up to date",
      available: (version) => `easy-study ${version} is available`,
      downloading: (progress) => `Downloading… ${progress}`,
      downloaded: (version) => `easy-study ${version} is downloaded`,
      installing: 'Installing…',
      failed: "Couldn't update",
      failedWith: (error) => `Couldn't update: ${error}`,
      lastFailed: (error) => `Last check failed: ${error}`,
      notChecked: 'Not checked yet',
      noteDownloading: (version, progress) => `Downloading easy-study ${version}… ${progress}`,
      noteAvailable: (version, current) => `easy-study ${version} is available (you have ${current}).`,
    },
    share: {
      label: 'Access from other devices',
      toggle: 'Allow access from other devices (same network, access code required)',
      off: 'Other computers and tablets on the same Wi‑Fi can use easy-study on this computer. Turning this on or off restarts the server.',
      idle: 'Connect with ‘Run on this computer’ and the addresses and access code show up here.',
      urls: 'Addresses to open on other devices',
      noUrls: "Couldn't find a network address. Connect to Wi‑Fi or Ethernet, then turn the switch off and on.",
      code: ['Access code ', { slot: 'share-code' }, ' ', { slot: 'share-copy' }],
      codeUnreadable: "(couldn't read the code)",
      reset: 'New access code (logs out every device)',
      help:
        'Anyone with the code can ask questions with Claude/Codex on this computer and view and delete lecture files: turn this on only on networks you trust, like your own Wi‑Fi. ' +
        "If macOS or Windows asks whether to let ‘node’ use the network, allow it (it's the server inside the app; an app you built yourself may ask on every launch). " +
        'On another computer, open it with ‘Connect to another computer’ in the easy-study app (recording works too) or in a browser. Recording in a tablet or phone browser needs HTTPS. ' +
        'Over http, someone on the same network can see or change what goes back and forth (a changed page could even use the microphone and your login): turn this on only on networks you trust, and use Tailscale or HTTPS elsewhere. ' +
        'If the address changes (another Wi‑Fi), turn the switch off and on.',
    },
    startup: {
      label: 'At startup',
      local: 'At startup, the app connects right away with ‘Run on this computer’.',
      remote: (url) => `At startup, the app connects right away to ‘${url}’.`,
      ask: 'At startup, this screen comes first. To connect right away, turn on ‘Connect right away next time’ and connect.',
      forget: 'Show this screen first next time',
    },
    logs: {
      open: 'Open log folder',
    },
    footer: [
      'You can change the connection later with ',
      { b: '⚙ Settings › Change connection…' },
      ' at the top right of the app, or in the menu with ',
      { b: 'Connection › Change connection…' },
      ' (',
      { slot: 'shortcut' },
      ').',
    ],
  },
};
