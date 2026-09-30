//! Korean: the reference texts (i18n.rs). Every other language has the same fields (i18n/en.rs).

use super::*;

pub static TEXTS: Texts = Texts {
    common: Common {
        ok: "확인",
        cancel: "취소",
        close: "닫기",
        installing_update: "업데이트를 설치하는 중이에요. 끝나면 앱이 다시 시작돼요.",
        unknown_theme: |theme| format!("알 수 없는 테마예요: {theme}"),
        no_resource_dir: |e| format!("앱의 리소스 폴더를 찾지 못했어요: {e}"),
        no_node: |path| format!("앱에 들어 있는 Node.js를 찾지 못했어요: {path}. 앱을 다시 설치해 보세요."),
        exit_code: |code| format!("종료 코드 {code}"),
        exit_signal: |sig| format!("신호 {sig}"),
        exit_unknown: "종료 상태를 알 수 없음",
    },
    menu: Menu {
        choose: "연결 대상 바꾸기…",
        reload: "새로 고침",
        open_browser: "브라우저에서 열기",
        open_library: "라이브러리 폴더 열기",
        settings: "설정…",
        check_update: "업데이트 확인…",
        install_update: |v| format!("업데이트 설치 ({v})…"),
        quit_app: |name| format!("{name} 종료"),
        quit: "종료",
        about: |name| format!("{name}에 관하여"),
        services: "서비스",
        hide: |name| format!("{name} 가리기"),
        hide_others: "기타 가리기",
        show_all: "모두 보기",
        edit: "편집",
        undo: "실행 취소",
        redo: "실행 복귀",
        cut: "오려두기",
        copy: "복사하기",
        paste: "붙여넣기",
        select_all: "전체 선택",
        connection: "연결",
        window: "윈도우",
        minimize: "최소화",
        zoom: "확대/축소",
        fullscreen: "전체 화면",
        close_window: "윈도우 닫기",
    },
    leave: Leave {
        choose_recording: "강의를 녹음하는 중이에요. 바꾸면 녹음이 멈춰요 (녹음한 부분은 저장돼 있어서 같은 서버에 다시 연결하면 마저 올라가요).",
        choose: "바꾸기",
        reload_recording: "강의를 녹음하는 중이에요. 새로 고치면 녹음이 멈춰요 (녹음한 부분은 저장돼 있어서 다시 열면 마저 올라가요).",
        reload: "다시 고침",
    },
    library: Library {
        pick_title: "라이브러리 폴더 선택",
        unreadable: |e| format!("이 폴더를 읽을 수 없어요 ({e}). 그래도 쓸까요?"),
        not_a_library: |name| {
            format!("'{name}' 폴더는 비어 있지 않고 easy-study 라이브러리처럼 보이지 않아요. 강의마다 폴더가 이 안에 만들어져요. 그래도 이 폴더를 쓸까요?")
        },
        from_env: |var| format!("{var} 환경 변수가 라이브러리 폴더를 정하고 있어요."),
        not_a_folder: |path| format!("폴더가 아니에요: {path}"),
        not_writable: |path, e| format!("이 폴더에 쓸 수 없어요: {path} ({e})"),
        changed_stopping: "라이브러리 폴더를 바꿨어요. 실행 중이던 서버를 끄고 있어요 — \"연결\"을 누르면 새 폴더로 시작해요.",
        changed: "라이브러리 폴더를 바꿨어요.",
    },
    launch: Launch {
        crashed: "지난번에 연결한 직후 앱이 닫혀서 이번에는 연결 선택 화면을 먼저 보여 드려요. 연결할 곳을 골라 주세요.",
        connecting: |saved| format!("{saved} 에 연결하는 중…"),
        saved_failed: |e| format!("저장된 연결 대상에 연결하지 못했어요. {e}"),
    },
    server: Server {
        starting: "이 컴퓨터에서 easy-study 서버를 시작하는 중…",
        no_entry: |path| format!("앱에 들어 있는 easy-study 서버를 찾지 못했어요: {path}. 앱을 다시 설치해 보세요."),
        no_library: |path, e| format!("라이브러리 폴더를 만들 수 없어요: {path} ({e})"),
        spawn_failed: |e, node| format!("서버를 시작하지 못했어요: {e} ({node})"),
        not_ready: |secs| format!("이 컴퓨터의 easy-study 서버가 {secs}초 안에 준비되지 않아 멈췄어요."),
        exited: |how| format!("이 컴퓨터의 easy-study 서버가 예기치 않게 종료됐어요 ({how}). \"연결\"을 누르면 다시 시작해요."),
        not_started: |how| format!("이 컴퓨터에서 easy-study 서버를 시작하지 못했어요 ({how})."),
    },
    relay: Relay {
        missing: "앱에 연결 통로 프로그램이 없어요 (proxy.js). 앱을 다시 설치해 주세요.",
        no_port: "연결 통로(프록시)가 쓸 포트를 찾지 못했어요.",
        spawn_failed: |e| format!("연결 통로(프록시)를 시작하지 못했어요: {e}"),
        not_started: |how, last| format!("연결 통로(프록시)가 시작되지 않았어요 ({how}). {last}"),
        not_ready: |secs| format!("연결 통로(프록시)가 {secs}초 안에 준비되지 않았어요."),
        exited: |how| format!("연결 통로(프록시)가 예기치 않게 종료됐어요 ({how}). 다시 연결해 주세요."),
    },
    remote: Remote {
        enter_address: |example| format!("연결할 컴퓨터의 주소를 입력하세요 (예: {example})."),
        bad_address: |example| format!("주소 형식이 올바르지 않아요 (예: {example})."),
        http_only: "http:// 또는 https:// 주소만 쓸 수 있어요.",
        no_host: |example| format!("주소에 컴퓨터 이름이나 IP가 없어요 (예: {example})."),
        no_credentials: "주소에 사용자 이름이나 비밀번호를 넣지 마세요. 접속 코드는 아래 칸에 입력하세요.",
        unresolved: |host| format!("{host} 주소를 찾을 수 없어요. 컴퓨터 이름이나 IP 주소를 확인하세요."),
        unresolved_short: |host| format!("{host} 주소를 찾을 수 없어요."),
        public_http: |shown| {
            format!(
                "{shown}은(는) 이 네트워크 밖의 주소예요. 암호화되지 않은 http:// 로는 같은 네트워크(집·학교 Wi-Fi, Tailscale)의 \
                 컴퓨터에만 연결할 수 있어요. 인터넷을 거쳐 연결하려면 https:// 주소(예: tailscale serve)를 쓰세요."
            )
        },
        no_tls: |e| format!("HTTPS를 준비하지 못했어요: {e}"),
        bad_header: |name| format!("요청 헤더 {name}의 값이 올바르지 않아요."),
        send_failed: |host, port, e| format!("{host}:{port}에 요청을 보내지 못했어요: {e}"),
        receive_failed: |host, port, e| format!("{host}:{port}에서 응답을 받지 못했어요: {e}"),
        not_http: |host, port| format!("{host}:{port}은(는) HTTP 서버가 아닌 것 같아요."),
        connect_failed: |host, port| {
            format!(
                "{host}:{port}에 연결할 수 없어요. 그 컴퓨터에서 easy-study가 원격 모드로 실행 중인지 \
                 (npm run start:remote), 같은 네트워크에 있는지, 방화벽이 막고 있지 않은지 확인하세요."
            )
        },
        local_network: " 이 Mac이 easy-study의 로컬 네트워크 접근을 막고 있을 수도 있어요: 시스템 설정 › 개인정보 보호 및 보안 › \
                        로컬 네트워크에서 easy-study를 켠 뒤 다시 연결하세요.",
        not_https: |host, port, err| {
            format!(
                "{host}:{port}은(는) HTTPS로 응답하지 않아요 ({err}). 인증서 없이 켠 easy-study 서버(npm run start:remote)는 \
                 http로 열려요: 같은 네트워크라면 주소를 http:// 로 바꿔 보세요."
            )
        },
        untrusted: |host, err| {
            format!(
                "{host}의 HTTPS 인증서를 이 컴퓨터가 신뢰하지 않아요 ({err}). 앱 창은 자체 서명 인증서를 받아들일 수 없어요: \
                 tailscale serve / tailscale cert처럼 신뢰받는 인증서를 쓰거나, mkcert의 루트 인증서를 이 컴퓨터에 설치하세요. \
                 같은 네트워크라면 http:// 주소도 쓸 수 있어요."
            )
        },
        tls_failed: |host, port, err| {
            format!(
                "{host}:{port}와(과) HTTPS 연결을 맺지 못했어요 ({err}). 주소와 포트가 맞는지, 그 서버가 https로 열려 있는지 \
                 확인하세요. 같은 네트워크라면 http:// 주소도 쓸 수 있어요."
            )
        },
        redirected: |origin, to| format!("{origin} 은(는) 다른 주소({to})로 넘어가요. 그 주소로 연결해 보세요."),
        not_easy_study: |origin, status| format!("{origin} 에서 easy-study 서버를 찾지 못했어요 (HTTP {status}). 주소와 포트 번호를 확인하세요."),
    },
    busy: Busy {
        block_recording: "강의를 녹음하는 중이에요. 녹음을 끝낸 뒤 다시 설치해 주세요.",
        block_unsent: "녹음한 소리를 아직 서버로 보내는 중이에요. 다 보낸 뒤 다시 설치해 주세요.",
        block_recording_share: "강의를 녹음하는 중이에요. 녹음을 끝낸 뒤 다시 바꿔 주세요.",
        block_unsent_share: "녹음한 소리를 아직 서버로 보내는 중이에요. 다 보낸 뒤 다시 바꿔 주세요.",
        warn_install: "다시 시작하면 이 작업이 멈춰요. 그래도 설치하고 다시 시작할까요?",
        warn_share: "다시 시작하면 이 작업이 멈춰요. 그래도 서버를 다시 시작할까요?",
        answering: "답변을 만드는 중이에요.",
        uploading: "파일을 올리는 중이에요.",
        page_unknown: "이 화면이 녹음이나 다른 작업을 하는 중인지 확인하지 못했어요.",
        recording_named: |doc, title| format!("‘{doc}’의 ‘{title}’ 녹음이 아직 끝나지 않았어요 (다시 시작한 뒤 이어서 할 수 있어요)."),
        recording: "끝나지 않은 녹음이 있어요 (다시 시작한 뒤 이어서 할 수 있어요).",
        transcribing: |n| format!("녹음 {n}개를 받아쓰는 중이에요."),
        digesting: "강의 정리를 만드는 중이에요.",
        answers_elsewhere: |others| format!("다른 창에서 답변 {others}개를 만드는 중이에요."),
        answers: |others| format!("답변 {others}개를 만드는 중이에요."),
        model_download: "음성 인식 모델을 내려받는 중이에요.",
        server_unknown: "이 컴퓨터의 서버가 작업 중인지 확인하지 못했어요.",
    },
    page: Page {
        confirm_reveal: "접속 코드를 이 화면에 보여 줄까요?\n\n코드를 아는 사람은 같은 네트워크에서 이 컴퓨터의 easy-study에 로그인할 수 있어요.",
        reveal: "보기",
        confirm_choose: "서버 선택 화면으로 돌아갈까요?\n\n지금 보고 있는 페이지가 요청했어요.",
        choose: "돌아가기",
        confirm_forget: "다음 실행부터 서버 선택 화면을 먼저 보여 줄까요?\n\n지금 보고 있는 페이지가 요청했어요.",
        forget: "그렇게 하기",
        confirm_cancel_download: "새 버전 내려받기를 취소할까요?\n\n지금 보고 있는 페이지가 요청했어요.",
        cancel_download: "내려받기 취소",
        keep_downloading: "계속 받기",
    },
    share: Share {
        starting: "이 컴퓨터의 서버를 시작하는 중이에요. 준비되면 다시 바꿔 주세요.",
        restarting: "설정을 적용하려고 이 컴퓨터의 서버를 다시 시작하는 중…",
        confirm_on: "다른 기기에서 접속을 허용할까요?\n\n같은 네트워크의 기기가 접속 코드로 이 컴퓨터의 easy-study를 쓸 수 있게 되고, \
                     이 컴퓨터의 서버를 다시 시작해요.",
        allow: "허용",
        restart: "다시 시작",
    },
    update: Update {
        network: "업데이트 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.",
        no_file: "이 컴퓨터용 업데이트 파일이 아직 없어요.",
        signature: "내려받은 파일의 서명이 맞지 않아 설치하지 않았어요.",
        wrong_file: "내려받은 파일이 이 컴퓨터용이 아니라서 설치하지 않았어요.",
        mac_permission: "앱 폴더를 바꿀 권한이 없어요. 새 버전을 내려받아 직접 설치해 주세요.",
        appimage_permission: "이 AppImage 파일을 바꿀 권한이 없어요. 새 AppImage를 내려받아 주세요.",
        installer: "설치 프로그램을 시작하지 못했어요. 다운로드 페이지에서 새 버전을 받아 설치해 주세요.",
        other: "업데이트하지 못했어요. 잠시 뒤 다시 시도하거나 다운로드 페이지에서 새 버전을 받아 주세요.",
        reason_move_app: "앱을 ‘응용 프로그램’ 폴더로 옮긴 뒤 다시 열면 업데이트할 수 있어요.",
        reason_extracted: "압축을 푼 AppImage는 앱 안에서 업데이트할 수 없어요. 새 AppImage를 내려받아 주세요.",
        reason_deb: "deb 패키지로 설치한 앱은 새 패키지를 받아 설치해 주세요.",
        reason_rpm: "rpm 패키지로 설치한 앱은 새 패키지를 받아 설치해 주세요.",
        reason_arch: "Arch 패키지로 설치한 앱은 릴리스의 PKGBUILD로 다시 설치해 주세요 (makepkg -si).",
        reason_installer: "이 설치 방식에서는 앱 안에서 업데이트할 수 없어요. 새 설치 파일을 받아 주세요.",
        reason_dev: "개발용 빌드는 앱 안에서 업데이트하지 않아요.",
        installing: |version| format!("easy-study {version} 버전을 설치하는 중… 끝나면 앱이 다시 시작돼요."),
        did_not_take: |current| format!("업데이트가 끝나지 않았어요 (지금 {current}). 다운로드 페이지에서 직접 설치해 주세요."),
        failed_prefixes: &["업데이트가 ", "업데이트하지 "],
        failed: |text| format!("업데이트하지 못했어요: {text}"),
        could_not_check: |text| format!("업데이트를 확인하지 못했어요: {text}"),
        latest: |current| format!("최신 버전을 쓰고 있어요 (easy-study {current})."),
        still_checking: "아직 확인하는 중이에요. 잠시 뒤 다시 확인해 주세요.",
        downloading: |version| format!("easy-study {version} 버전을 내려받는 중이에요."),
        preparing: "업데이트를 준비하는 중이에요.",
        available: |version, current| format!("easy-study {version} 버전이 나왔어요 (지금 {current})."),
        install_now: "지금 설치하고 앱을 다시 시작할까요?",
        confirm_install: |version| format!("easy-study {version} 버전을 설치하고 앱을 다시 시작할까요?"),
        install_restart: "설치하고 다시 시작",
        later: "나중에",
        open_download: "다운로드 페이지 열기",
        kept_download: |msg| format!("{msg}\n\n새 버전은 받아 두었어요. 녹음이 끝나면 다시 설치해 주세요."),
    },
};
