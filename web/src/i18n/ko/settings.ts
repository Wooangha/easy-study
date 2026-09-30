// Korean (the reference language) — namespace `settings`: the settings dialog (화면 · 공부 · 녹음 · 데스크톱 앱 · 정보),
// confirm dialogs, theme and language, the desktop bridge's texts (lib/desktop.ts), and any web text no other namespace owns.
import type { ReactNode } from 'react';
import { rich } from '../rich.ts';

export const settings = {
  /** The dialog's frame (SettingsDialog.tsx); its title is common.settings. */
  dialog: {
    closeTitle: '닫기 (Esc)',
    nav: '설정 항목',
    sections: {
      display: '화면',
      study: '공부',
      recording: '녹음',
      desktop: '데스크톱 앱',
      about: '정보',
    },
  },

  display: {
    theme: '테마',
    themeOptions: {
      system: '시스템 설정 따르기',
      light: '라이트',
      dark: '다크',
    },
    themeHintApp: '앱의 모든 화면(연결 선택 화면 포함)에 적용돼요.',
    language: '언어',
    /**
     * The language picker's first option, with the language it resolves to ("시스템 설정 따르기 (English)"); the
     * languages themselves are shown in their own language (LANGS).
     */
    languageSystem: (current: string) => `시스템 설정 따르기 (${current})`,
    languageHintApp: '메뉴와 연결 선택 화면은 컴퓨터의 언어를 따라요.',
    browserOnlyHint: '이 브라우저에만 저장돼요.',
  },

  study: {
    neighbors: '질문과 함께 보낼 앞뒤 슬라이드',
    neighborsNone: '지금 슬라이드만',
    /** An option of the picker: "앞뒤 2장". */
    neighborsCount: (n: number) => `앞뒤 ${n}장`,
    neighborsHint: '대화 창의 ‘앞뒤 ±N’과 같은 설정이에요.',
    annotations: '필기',
    memosToTutor: '학생의 메모를 튜터에게 보이기',
    memosToTutorHint:
      '질문할 때 지금 슬라이드와 앞뒤 슬라이드에 붙인 메모를 함께 전달해요. 메모마다 눈 모양 버튼(튜터에게 보이기)으로 따로 끌 수도 있어요.',
    questionMarkers: '슬라이드에 질문 표시 보기',
    questionMarkersHint:
      '슬라이드의 한 부분을 첨부해서 질문하면 그 부분이 옅게 칠해지고 왼쪽에 파란 줄과 Q 표시가 남아요. 필기나 메모를 첨부했으면 그 모서리에 파란 점이 붙어요. 표시를 클릭하면 그 질문과 답으로 가요.',
  },

  recording: {
    asrStatusFailed: (error: string) => `음성 인식 상태를 확인하지 못했어요: ${error}`,
    showNoticeAgain: '녹음 안내 다시 보기',
    noticeReset: '다음에 녹음할 때 안내를 다시 보여 드려요.',
  },

  /** 데스크톱 앱 (inside the app only): 업데이트 and 연결. */
  desktop: {
    updates: '업데이트',
    /** "버전 <b>0.6.6</b>". */
    version: (version: ReactNode) => rich('버전 ', version),
    releaseNotes: '새 버전의 변경 사항',
    checkUpdate: '업데이트 확인',
    installAndRestart: '업데이트하고 다시 시작',
    openDownloadPage: '다운로드 페이지 열기',
    /** `icon`: the chooser's ⚙ (its 앱 설정 button). */
    autoCheckOff: (icon: ReactNode) =>
      rich('시작할 때 새 버전 확인은 꺼져 있어요 (연결 선택 화면의 ', icon, ' 앱 설정에서 켤 수 있어요).'),
    connection: '연결',
    connectedLocal: '연결: 이 컴퓨터',
    connectedRemote: (origin: string) => `연결: 다른 컴퓨터 (${origin})`,
    /** Before the shell's first push: the page's own origin. */
    connectedTo: (origin: string) => `연결: ${origin}`,
    startupAuto: '시작할 때: 마지막 연결 대상에 바로 연결',
    startupAsk: '시작할 때: 선택 화면 보여주기',
    changeConnection: '연결 대상 바꾸기…',
    askNextTime: '다음 실행 때 선택 화면 보기',
    askNextTimeDone: '다음에 앱을 열면 연결 선택 화면이 먼저 나와요.',
    /** `keys`: the shortcut, as <kbd>. */
    menuHint: (keys: ReactNode) => rich('메뉴 연결 › 연결 대상 바꾸기… (', keys, ')로도 바꿀 수 있어요.'),
  },

  /** 다른 기기에서 접속 (this computer's server only, DESIGN §16/§19). */
  share: {
    title: '다른 기기에서 접속',
    allow: '다른 기기에서 접속 허용 (같은 네트워크, 접속 코드 필요)',
    about:
      '같은 Wi‑Fi의 다른 컴퓨터·태블릿에서 이 컴퓨터의 easy-study를 쓸 수 있어요. 켜거나 끄면 이 컴퓨터의 서버를 다시 시작해요 (잠시 연결 선택 화면이 나와요). 코드를 아는 사람은 이 컴퓨터의 Claude/Codex로 질문하고 강의 파일을 보고 지울 수 있어요.',
    restartForAddresses: '서버를 다시 시작하면 주소가 나와요.',
    addresses: '다른 기기에서 열 주소',
    noAddresses: '네트워크 주소를 찾지 못했어요. Wi‑Fi나 이더넷에 연결한 뒤 스위치를 껐다 켜세요.',
    /** After an address that is a host name, not an IP. */
    nameOnly: '(같은 네트워크에서 이름이 풀릴 때만)',
    copiedAddress: '주소를 복사했어요.',
    code: '접속 코드',
    copiedCode: '접속 코드를 복사했어요.',
    showCode: '보기',
    /** `icon`: the chooser's ⚙ (its 앱 설정 button). */
    codeInChooser: (icon: ReactNode) => rich('(연결 선택 화면의 ', icon, ' 앱 설정에도 있어요)'),
    resetCode: '접속 코드 새로 만들기 (모든 기기 로그아웃)',
    networkHint:
      'macOS·Windows가 ‘node’의 네트워크 연결을 허용할지 물으면 허용하세요 (앱에 든 서버예요; 직접 빌드한 앱은 켤 때마다 물을 수 있어요). 다른 컴퓨터에서는 easy-study 앱의 ‘다른 컴퓨터에 연결’(녹음도 돼요) 또는 브라우저로 여세요. 태블릿·폰의 브라우저에서 녹음하려면 HTTPS가 필요해요. http로는 같은 네트워크의 누군가가 오가는 내용을 엿보거나 바꿀 수 있어요 (바뀐 화면은 마이크와 로그인까지 쓸 수 있어요): 믿을 수 있는 네트워크에서만 켜고, 다른 곳에서는 Tailscale·HTTPS를 쓰세요. Wi‑Fi가 바뀌어 주소가 바뀌면 껐다 켜세요.',
    /** Before the switch restarts the server while an answer or an upload would stop (the message: bridge.shareWarning). */
    restartConfirm: {
      title: '서버를 다시 시작할까요?',
      confirmLabel: '다시 시작',
    },
  },

  about: {
    serverVersion: '서버 버전',
    /** A server from before the version was reported. */
    unknown: '알 수 없음',
    appVersion: '앱 버전',
    libraryFolder: '라이브러리 폴더',
    copiedLibraryFolder: '라이브러리 폴더 경로를 복사했어요.',
    olderServer: '이 서버는 앱보다 오래된 버전이에요. 서버 컴퓨터에서 업데이트해 주세요.',
    shortcuts: '단축키',
    shortcutsHint: '슬라이드 단축키는 글을 입력하는 중이 아닐 때 동작해요.',
    /** What each shortcut does (the keys themselves are not translated). */
    keys: {
      nextSlide: '다음 슬라이드',
      previousSlide: '이전 슬라이드',
      firstLastSlide: '첫 슬라이드 · 마지막 슬라이드',
      focusComposer: '질문 입력창으로',
      send: '질문 보내기',
      newLine: '줄 바꾸기',
      escape: '창 닫기 · 필기 도구 끄기 · 선택 해제',
      undo: '필기 되돌리기',
      redo: '필기 다시 실행',
      deleteSelected: '선택한 필기 삭제',
      settings: '설정 (앱)',
      changeConnection: '연결 대상 바꾸기 (앱)',
    },
  },

  copyFailed: '복사하지 못했어요.',

  /** web/src/lib/desktop.ts: what the page says before leaving or restarting, and the update wording. */
  bridge: {
    /** Before "연결 대상 바꾸기" (the chooser replaces the page). */
    leave: {
      title: '연결 대상을 바꿀까요?',
      confirmLabel: '바꾸기',
      recording: '강의를 녹음하는 중이에요. 바꾸면 녹음이 멈춰요 (녹음한 부분은 저장돼 있어서 같은 서버에 다시 연결하면 마저 올라가요).',
      unsent: '녹음한 소리를 아직 서버로 보내는 중이에요. 바꾸면 멈춰요 (이 기기에 저장돼 있어서 같은 서버에 다시 연결하면 마저 올라가요).',
      busy: '답변을 만들거나 파일을 올리는 중이에요. 지금 바꾸면 이 화면에서는 결과를 볼 수 없어요.',
    },
    /** Why the update cannot be installed now. */
    installBlocked: {
      recording: '녹음 중에는 설치할 수 없어요 — 녹음을 끝낸 뒤 눌러 주세요.',
      unsent: '녹음한 소리를 서버로 보내는 중이에요 — 다 보낸 뒤 설치할 수 있어요.',
      uploads: '녹음 파일을 올리는 중이에요 — 다 올린 뒤 설치할 수 있어요.',
    },
    installWarning: '답변을 만들거나 파일을 올리는 중이에요. 다시 시작하면 멈춰요. 그래도 설치할까요?',
    /** Why 다른 기기에서 접속 허용 (or a new access code) cannot be changed now. */
    shareBlocked: {
      recording: '녹음 중에는 바꿀 수 없어요 — 녹음을 끝낸 뒤 눌러 주세요.',
      unsent: '녹음한 소리를 서버로 보내는 중이에요 — 다 보낸 뒤 바꿀 수 있어요.',
      uploads: '녹음 파일을 올리는 중이에요 — 다 올린 뒤 바꿀 수 있어요.',
    },
    shareWarning: '답변을 만들거나 파일을 올리는 중이에요. 서버를 다시 시작하면 멈춰요. 그래도 바꿀까요?',
    /** Before "접속 코드 새로 만들기"; `busy` follows the message when an answer or an upload would stop. */
    resetCode: {
      title: '접속 코드를 새로 만들까요?',
      message: '지금 코드로 로그인한 다른 기기는 모두 로그아웃돼요. 새 코드를 만들려고 이 컴퓨터의 서버를 한 번 다시 시작해요.',
      busy: '답변을 만들거나 파일을 올리는 중이에요. 서버를 다시 시작하면 멈춰요.',
      confirmLabel: '새로 만들기',
    },
    /** The status line of Settings › 데스크톱 앱 (`version`: the new version). */
    status: {
      checking: '확인하는 중…',
      available: (version: string) => `easy-study ${version} 버전이 나왔어요`,
      downloading: '내려받는 중…',
      downloadingPercent: (percent: number) => `내려받는 중… ${percent}%`,
      downloaded: (version: string) => `easy-study ${version} 버전을 받아 두었어요`,
      installing: (version: string) => `easy-study ${version} 버전을 설치하는 중…`,
      latest: '최신 버전이에요',
      lastCheckFailed: (error: string) => `마지막 확인 실패: ${error}`,
      notChecked: '아직 확인하지 않았어요',
    },
    /** A package install (deb, rpm, Arch) takes the new package; Arch builds it with the release's PKGBUILD. */
    downloadPackage: (pkg: string, arch: boolean) =>
      `이 설치 방식(${pkg})에서는 새 패키지를 받아 설치해 주세요.${arch ? ' (릴리스의 PKGBUILD로 makepkg -si)' : ''}`,
    downloadPage: '다운로드 페이지에서 새 버전을 받아 설치해 주세요.',
    macMicFix: '녹음이 안 되면 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 easy-study를 껐다 켜 주세요.',
    /** Followed by macMicFix. */
    macMicHint: 'macOS에서는 업데이트 뒤 처음 녹음할 때 마이크 권한을 다시 물을 수 있어요.',
    /** The toast after an update (on macOS followed by macMicFix). */
    updated: (version: string) => `easy-study ${version} 버전으로 업데이트했어요.`,
    updateFailed: (error: string) => `업데이트하지 못했어요: ${error}`,
  },
};
