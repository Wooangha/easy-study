// Korean (the reference language) — server namespace `desktop`: the desktop mode's texts (server/desktop.ts) and the self-update.
//
// - `startup`: why desktop mode could not start, for the shell's error screen (it shows the tail of stderr). There is
//   no request at startup: server/desktop.ts picks the language from EASY_STUDY_LANG (Korean when unset).
// - `proxy`: the plain-text pages of the desktop app's loopback relay (server/proxy.ts), in the language of the
//   request (the WebView's Accept-Language).
// The terminal output of the self-update (server/selfUpdate.ts, server/cli.ts) stays Korean for now (DESIGN §27).

export const desktop = {
  startup: {
    configError: (message: string) => `설정 오류: ${message}`,
    portInvalid: (raw: string) => `PORT 값이 올바르지 않습니다: "${raw}" (0~65535)`,
    libraryRequired: '데스크톱 모드에는 라이브러리 폴더가 필요합니다 (EASY_STUDY_LIBRARY).',
    /** Several lines: another easy-study holds the library's lock file. */
    libraryLocked: (pid: number, port: number, library: string, lockFile: string) =>
      [
        `이 라이브러리 폴더는 다른 easy-study가 이미 쓰고 있습니다 (pid ${pid}, 포트 ${port}).`,
        `  라이브러리: ${library}`,
        '  같은 폴더를 두 서버가 함께 쓰면 서로의 작업을 망가뜨리므로 시작하지 않았습니다.',
        '  그 easy-study(예: 터미널에서 실행한 npm start)를 끄거나, 다른 라이브러리 폴더를 고르세요.',
        `  실행 중인 easy-study가 없는데도 이 메시지가 나오면 잠금 파일을 지우세요: ${lockFile}`,
      ].join('\n'),
    portInUse: (port: number) => `포트 ${port}을(를) 다른 프로그램이 이미 쓰고 있어서 서버를 시작하지 못했습니다. 앱을 다시 실행해 보세요.`,
    /** File system errors on the library folder itself, by errno code. */
    libraryProblem: {
      EACCES: '라이브러리 폴더에 쓸 권한이 없습니다',
      EPERM: '라이브러리 폴더에 쓸 권한이 없습니다',
      EROFS: '라이브러리 폴더가 읽기 전용입니다',
      EEXIST: '라이브러리 폴더 자리에 폴더가 아닌 파일이 있습니다',
      ENOTDIR: '라이브러리 폴더 경로에 폴더가 아닌 파일이 있습니다',
      EISDIR: '라이브러리 폴더를 쓸 수 없습니다',
      ENOENT: '라이브러리 폴더를 찾을 수 없습니다',
      ENOSPC: '디스크 공간이 부족해서 라이브러리 폴더에 쓸 수 없습니다',
    },
    /** Two lines: `problem` (libraryProblem) with its errno `code`, then what to do. */
    libraryFailed: (problem: string, code: string, library: string) =>
      `${problem} (${code}): ${library}\n  다른 라이브러리 폴더를 고르거나, 이 폴더를 확인해 주세요.`,
    failed: (error: string) => `서버를 시작하지 못했습니다: ${error}`,
  },
  proxy: {
    unreachable: (origin: string) => `연결한 컴퓨터(${origin})에 닿지 않아요. 그 컴퓨터의 easy-study가 켜져 있는지, 같은 네트워크인지 확인하세요.`,
    wrongHost: '이 주소로는 열 수 없습니다',
    badPath: '요청 주소가 올바르지 않습니다',
    /**
     * The relay's startup errors on stderr, in the shell's language (EASY_STUDY_LANG): the connection screen shows the
     * last line when the relay does not start. A taken port also exits with EXIT_PORT_TAKEN (the shell's signal).
     */
    toMissing: '중계할 주소가 올바르지 않습니다: --to http://호스트:포트 가 필요합니다',
    portTaken: (port: number) => `포트 ${port}를 다른 프로그램이 쓰고 있습니다`,
    startFailed: (error: string) => `연결 통로를 시작하지 못했습니다: ${error}`,
  },
};
