// easy-study desktop app (DESIGN §19). One main window that shows either
//  - the bundled chooser page (ui/, the ONLY page with IPC: capabilities/chooser.json has no `remote` key),
//  - the local server's UI ("이 컴퓨터에서 실행": the bundled Node runs the packed server, see server.rs; shared
//    with other devices on request, see share.rs), or
//  - another computer's easy-study server ("다른 컴퓨터에 연결": URL + access code, see remote.rs; a plain-http
//    one through the loopback relay of proxy.rs, so that the recorder has a secure context).
// Pages served over http(s) get no IPC. Links to other sites open in the system browser. The shell and the pages
// talk through bridge.rs (a static marker, pushed state, reserved navigations); in-app updates: update.rs (DESIGN §24).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod config;
mod media;
mod pathenv;
mod proxy;
mod remote;
mod server;
mod share;
mod update;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry, RESTART_EXIT_CODE};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use config::lock;

const MAIN: &str = "main";
const SMOKE_ENV: &str = "EASY_STUDY_DESKTOP_SMOKE";
/// "0": the smoke run does not check the recording tools (GET /api/asr).
const SMOKE_ASR_ENV: &str = "EASY_STUDY_DESKTOP_SMOKE_ASR";
/// "1": the smoke run may WRITE to the connected server, whichever it is (a test server): the PDF check on a
/// remote or relayed page too, plus a streamed chat turn and a recording upload on every page.
const SMOKE_WRITE_ENV: &str = "EASY_STUDY_DESKTOP_SMOKE_WRITE";

pub struct AppState {
    /// The chooser page's URL (tauri://localhost/index.html, http://tauri.localhost/index.html on Windows).
    chooser_url: Mutex<Option<Url>>,
    /// The http(s) origin the main window may show: the local server's, the relay's or the chosen remote server's.
    allowed_origin: Mutex<Option<String>>,
    pub server: Mutex<Option<server::Running>>,
    pub server_url: Mutex<Option<String>>,
    /// Some(urls) iff the RUNNING local server was started shared (share.rs): the addresses of its ready line.
    pub share_urls: Mutex<Option<Vec<String>>>,
    /// A port the local server could not bind this launch (server.rs on_exit): skipped from then on.
    pub failed_port: Mutex<Option<u16>>,
    /// The next local start makes a new access code (share.rs, EASY_STUDY_DESKTOP_RESET_CODE).
    pub reset_code_pending: AtomicBool,
    /// A share change runs (share.rs: one at a time).
    pub share_flow: AtomicBool,
    /// The local server restarts for a change made in the chooser (share.rs): when it is ready, the chooser stays
    /// (the addresses and the code are there) instead of the page opening. Cleared with the start (start_ended).
    pub stay_on_chooser: AtomicBool,
    /// The relay for a plain-http remote server (proxy.rs), what the window shows for it (`http://127.0.0.1:<p>`)
    /// and the remote origin behind it.
    pub proxy: Mutex<Option<proxy::Running>>,
    pub proxy_url: Mutex<Option<String>>,
    pub proxy_target: Mutex<Option<String>>,
    /// Incremented for every relay spawn and stop: late events of an old relay are ignored.
    pub proxy_generation: AtomicU64,
    /// Held while a relay is spawned or stopped (a start waits for a stop that is under way).
    pub proxy_lifecycle: Mutex<()>,
    /// The local server is being started (until its ready line).
    pub starting: AtomicBool,
    /// What the chooser shows as "in progress" (local start, checking a saved remote server).
    pub busy: Mutex<Option<String>>,
    pub error: Mutex<Option<String>>,
    pub tail: Arc<Mutex<VecDeque<String>>>,
    /// Incremented for every spawn and stop: late events of an old server are ignored.
    pub generation: AtomicU64,
    /// Held while a server is spawned or stopped.
    pub lifecycle: Mutex<()>,
    pub quitting: AtomicBool,
    /// EASY_STUDY_DESKTOP_SMOKE (CI and local checks, see Smoke).
    smoke: Smoke,
    smoke_chooser_started: AtomicBool,
    smoke_page_started: AtomicBool,
    /// The smoke run's verdict was given.
    smoke_done: AtomicBool,
    /// The origin of the page the main window last loaded (None: the chooser): where state is pushed.
    page_origin: Mutex<Option<String>>,
    /// The origin shown before the chooser came back ("방금까지 연결", display only).
    previous: Mutex<Option<String>>,
    /// The chooser section to open (menu "설정…" when the page has no settings), taken by get_state once.
    chooser_focus: Mutex<Option<String>>,
    /// A note for the chooser (not an error).
    notice: Mutex<Option<String>>,
    /// A remembered connection opened at launch: config.auto_connect_pending is cleared once its page is up.
    auto_connect: AtomicBool,
    pub update: update::Updates,
    pub bridge: bridge::Bridge,
}

impl AppState {
    fn new(smoke: Smoke) -> AppState {
        AppState {
            chooser_url: Mutex::new(None),
            allowed_origin: Mutex::new(None),
            server: Mutex::new(None),
            server_url: Mutex::new(None),
            share_urls: Mutex::new(None),
            failed_port: Mutex::new(None),
            reset_code_pending: AtomicBool::new(false),
            share_flow: AtomicBool::new(false),
            stay_on_chooser: AtomicBool::new(false),
            proxy: Mutex::new(None),
            proxy_url: Mutex::new(None),
            proxy_target: Mutex::new(None),
            proxy_generation: AtomicU64::new(0),
            proxy_lifecycle: Mutex::new(()),
            starting: AtomicBool::new(false),
            busy: Mutex::new(None),
            error: Mutex::new(None),
            tail: Arc::new(Mutex::new(VecDeque::new())),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            quitting: AtomicBool::new(false),
            smoke,
            smoke_chooser_started: AtomicBool::new(false),
            smoke_page_started: AtomicBool::new(false),
            smoke_done: AtomicBool::new(false),
            page_origin: Mutex::new(None),
            previous: Mutex::new(None),
            chooser_focus: Mutex::new(None),
            notice: Mutex::new(None),
            auto_connect: AtomicBool::new(false),
            update: update::Updates::default(),
            bridge: bridge::Bridge::default(),
        }
    }

    /// The local server is no longer being started — it is ready, failed, was cancelled, timed out or was
    /// stopped. Its "in progress" line goes with it: the chooser keeps every control disabled while `busy`
    /// is set, so a path that forgot it would leave the chooser unusable until the app restarts.
    pub fn start_ended(&self) {
        self.starting.store(false, SeqCst);
        self.stay_on_chooser.store(false, SeqCst);
        *lock(&self.busy) = None;
    }
}

/// The process exit code (tauri's runtime drops the code given to app.exit()).
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

/// app.exit(code) that keeps the code.
fn quit(app: &AppHandle, code: i32) {
    EXIT_CODE.store(code, SeqCst);
    app.exit(code);
}

pub(crate) fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub(crate) fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// `url` without its query and fragment, for log lines: a login link carries the access code in its query.
fn without_query(url: &Url) -> String {
    let mut shown = url.clone();
    shown.set_query(None);
    shown.set_fragment(None);
    shown.to_string()
}

/// Lets the main window show `url`'s origin and goes there.
pub fn go_to(app: &AppHandle, url: &str) {
    let Ok(target) = Url::parse(url) else { return };
    let st = app.state::<AppState>();
    let origin = origin_of(&target);
    *lock(&st.allowed_origin) = Some(origin.clone());
    // Leaving a relayed page for another origin (this computer's server, an https server): the relay is not needed.
    if lock(&st.proxy_url).as_deref().is_some_and(|relay| relay != origin) {
        proxy::stop_async(app);
    }
    if let Some(w) = main_window(app) {
        let _ = w.navigate(target);
    }
}

/// Back to the chooser (it reads everything it shows from get_state).
pub fn show_chooser(app: &AppHandle) {
    let st = app.state::<AppState>();
    let chooser = lock(&st.chooser_url).clone();
    // (Not the chooser itself: on Windows it is served over http from tauri.localhost.)
    let shown = main_window(app).and_then(|w| w.url().ok()).filter(|u| matches!(u.scheme(), "http" | "https") && !is_chooser(app, u));
    if let Some(shown) = shown {
        // A relayed page was the remote server's, as far as the user is concerned.
        let origin = origin_of(&shown);
        *lock(&st.previous) = Some(proxy::target_of(app, &origin).unwrap_or(origin));
    }
    proxy::stop_async(app);
    if let (Some(url), Some(w)) = (chooser, main_window(app)) {
        let _ = w.navigate(url);
        let _ = w.set_focus();
    }
}

fn is_chooser(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    if cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost")) {
        return true; // `tauri dev` serves ui/ from a local dev server
    }
    lock(&app.state::<AppState>().chooser_url).as_ref().is_some_and(|c| origin_of(c) == origin_of(url))
}

pub(crate) fn is_allowed_page(app: &AppHandle, url: &Url) -> bool {
    url.scheme() == "about" || lock(&app.state::<AppState>().allowed_origin).as_deref() == Some(origin_of(url).as_str())
}

fn open_externally(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        bridge::log_limited(app, "external", &format!("opening in the system browser: {url}"));
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            // e.g. a minimal Linux without xdg-open (the .deb only recommends xdg-utils)
            config::log(app, &format!("could not open {url} in the system browser: {e}"));
        }
    } else {
        bridge::log_limited(app, "blocked", &format!("blocked navigation to {url}"));
    }
}

/// The main window stays on the chooser or the chosen server; anything else goes to the system browser. A page's
/// action (bridge.rs: `<origin>/__easy-study-desktop/<action>`) is done on a thread and the navigation cancelled.
/// Also asked first (macOS) for a link with target=_blank (WebKit's new-window policy; wry gives only the URL, so such
/// a click cannot be told from a navigation of the window itself): another site goes to the browser here and no
/// window is made; the server's own pages go on to new_window; a link to the reserved path is refused by
/// bridge::on_action, which first asks the page whether its own code asked for the action (the web client's Markdown
/// drops such hrefs as well, web/src/lib/markdownOptions.ts).
/// Runs on the UI thread: nothing here may block.
fn allow_main_navigation(app: &AppHandle, url: &Url) -> bool {
    let allowed = lock(&app.state::<AppState>().allowed_origin).clone();
    match bridge::classify(url, allowed.as_deref()) {
        bridge::Nav::Action(action) => {
            let (h, origin) = (app.clone(), origin_of(url));
            bridge::log_limited(app, "action", &format!("page action {action:?} from {origin}"));
            std::thread::spawn(move || bridge::on_action(&h, action, origin));
            return false;
        }
        bridge::Nav::Reserved => {
            bridge::log_limited(app, "reserved", &format!("ignored reserved navigation {url}"));
            return false;
        }
        bridge::Nav::Other => {}
    }
    if is_chooser(app, url) || is_allowed_page(app, url) {
        return true;
    }
    open_externally(app, url);
    false
}

/// target=_blank links (after allow_main_navigation let them through) and window.open (notes.md, digest.md, links
/// in answers): the server's own pages open in an app window (same cookies, no IPC: its label matches no
/// capability); other sites in the browser.
fn new_window(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
    // The reserved path never acts from a new window (links in answers open with target=_blank).
    if bridge::is_reserved(&url) {
        bridge::log_limited(app, "reserved", &format!("ignored reserved new window {url}"));
        return NewWindowResponse::Deny;
    }
    if !is_allowed_page(app, &url) || url.scheme() == "about" {
        open_externally(app, &url);
        return NewWindowResponse::Deny;
    }
    static N: AtomicU32 = AtomicU32::new(0);
    let label = format!("page-{}", N.fetch_add(1, SeqCst));
    let (h_nav, h_new) = (app.clone(), app.clone());
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
        .window_features(features)
        .title("easy-study")
        .disable_drag_drop_handler()
        .on_navigation(move |u| {
            !bridge::is_reserved(u)
                && (is_allowed_page(&h_nav, u) || {
                    open_externally(&h_nav, u);
                    false
                })
        })
        .on_new_window(move |u, f| new_window(&h_new, u, f))
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
        })
        .build();
    match built {
        Ok(window) => {
            // (A link that seems to do nothing on Windows/Linux, where this path had no real-click check, shows here.)
            bridge::log_limited(app, "new-window", &format!("new window {label}: {url}"));
            NewWindowResponse::Create { window }
        }
        Err(e) => {
            config::log(app, &format!("new window failed: {e}"));
            NewWindowResponse::Deny
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Commands (the chooser page only)
// ---------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateDto {
    mode: String,
    remote_url: Option<String>,
    /// desktop.json exists (false on the first launch).
    configured: bool,
    library: config::Library,
    busy: Option<String>,
    /// The local server runs (its UI is one "연결" away).
    running: bool,
    server_url: Option<String>,
    error: Option<String>,
    stderr_tail: Vec<String>,
    log_file: String,
    shortcut: String,
    /// This build's version.
    version: String,
    /// "system" | "light" | "dark".
    theme: &'static str,
    /// Automatic update checks are on.
    update_check: bool,
    update: update::UpdateState,
    /// A section to open once ("settings").
    focus: Option<String>,
    /// The origin shown before the chooser came back.
    previous: Option<String>,
    notice: Option<String>,
    /// "다른 기기에서 접속 허용" (the setting; share.rs).
    share: bool,
    /// The local server runs shared right now: its addresses for other devices and its access code.
    share_running: bool,
    share_urls: Vec<String>,
    share_code: Option<String>,
}

#[tauri::command]
fn get_state(app: AppHandle, state: State<'_, AppState>) -> StateDto {
    let cfg = config::load(&app);
    let server_url = lock(&state.server_url).clone();
    let share_urls = lock(&state.share_urls).clone();
    StateDto {
        mode: cfg.mode.clone(),
        remote_url: cfg.remote_url.clone(),
        configured: config::exists(&app),
        library: config::library(&app, &cfg),
        busy: lock(&state.busy).clone().or_else(|| lock(&state.update.state).busy_line()),
        running: server_url.is_some(),
        server_url,
        share: cfg.share,
        share_running: share_urls.is_some(),
        // The chooser is the app's own trusted page: it may show the code (read from the library on demand).
        share_code: share_urls.is_some().then(|| server::access_code(&app)).flatten(),
        share_urls: share_urls.unwrap_or_default(),
        error: lock(&state.error).clone(),
        stderr_tail: server::tail(&app),
        log_file: config::log_dir(&app).join("server.log").to_string_lossy().into_owned(),
        shortcut: if cfg!(target_os = "macos") { "⌘⇧K".into() } else { "Ctrl+Shift+K".into() },
        version: app.package_info().version.to_string(),
        theme: match cfg.theme.as_str() {
            "light" => "light",
            "dark" => "dark",
            _ => "system",
        },
        update_check: cfg.update_check != Some(false),
        update: lock(&state.update.state).clone(),
        focus: lock(&state.chooser_focus).take(),
        previous: lock(&state.previous).clone(),
        notice: lock(&state.notice).clone(),
    }
}

/// The checks and the install run on their own threads (they block: dialogs, downloads); the chooser polls get_state.
#[tauri::command]
fn check_update(app: AppHandle) {
    std::thread::spawn(move || {
        update::check(&app, update::How::Manual);
    });
}

#[tauri::command]
fn install_update(app: AppHandle) {
    std::thread::spawn(move || update::request_install(&app, update::Trigger::Chooser));
}

#[tauri::command]
fn cancel_update(app: AppHandle) {
    update::cancel(&app);
}

#[tauri::command]
fn set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !matches!(theme.as_str(), "system" | "light" | "dark") {
        return Err(format!("알 수 없는 테마예요: {theme}"));
    }
    bridge::set_theme(&app, &theme);
    Ok(())
}

#[tauri::command]
fn set_update_check(app: AppHandle, on: bool) {
    config::update(&app, |c| c.update_check = if on { None } else { Some(false) });
    lock(&app.state::<AppState>().update.state).auto = on;
    config::log(&app, &format!("automatic update checks {}", if on { "on" } else { "off" }));
    bridge::push_state(&app);
}

#[tauri::command]
fn forget_choice(app: AppHandle) {
    bridge::forget_choice(&app);
}

/// "다른 기기에서 접속 허용": on its own thread (dialogs, the busy check, a restart of the server); the chooser polls
/// get_state meanwhile.
#[tauri::command]
fn set_share(app: AppHandle, on: bool) {
    std::thread::spawn(move || share::request(&app, share::Change::Share(on), share::From::Chooser));
}

/// "접속 코드 새로 만들기": the same way.
#[tauri::command]
fn reset_share_code(app: AppHandle) {
    std::thread::spawn(move || share::request(&app, share::Change::ResetCode, share::From::Chooser));
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<(), String> {
    app.opener().open_path(config::log_dir(&app).to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Nothing connects while an update replaces the app (the chooser shows it as busy; this is the backstop).
fn not_installing(app: &AppHandle) -> Result<(), String> {
    if update::replacing(app) {
        return Err("업데이트를 설치하는 중이에요. 끝나면 앱이 다시 시작돼요.".into());
    }
    Ok(())
}

#[tauri::command]
fn connect_local(app: AppHandle, remember: bool) -> Result<(), String> {
    not_installing(&app)?;
    config::update(&app, |c| c.mode = if remember { "local".into() } else { String::new() });
    // "연결" means the page, also when a share change is restarting the server right now.
    app.state::<AppState>().stay_on_chooser.store(false, SeqCst);
    server::start(&app)
}

#[tauri::command]
async fn connect_remote(app: AppHandle, url: String, code: Option<String>, remember: bool) -> Result<(), String> {
    not_installing(&app)?;
    tauri::async_runtime::spawn_blocking(move || open_remote(&app, &url, code, remember))
        .await
        .map_err(|e| e.to_string())?
}

/// Checks the remote server, remembers it, and shows it (show_remote). Blocks.
fn open_remote(app: &AppHandle, url: &str, code: Option<String>, remember: bool) -> Result<(), String> {
    let origin = remote::parse(url)?;
    let status = remote::probe(&origin)?;
    let st = app.state::<AppState>();
    config::update(app, |c| {
        c.remote_url = Some(origin.to_string());
        c.mode = if remember { "remote".into() } else { String::new() };
    });
    *lock(&st.error) = None;
    show_remote(app, &origin, code, &status)?;
    // Another computer's server is shown: the local one is not needed (frees its memory; a shared one stops with it).
    let h = app.clone();
    std::thread::spawn(move || server::stop(&h));
    Ok(())
}

/// Shows the checked remote server `origin`: a plain-http one through the loopback relay (proxy.rs: a secure
/// context, so the recorder works there too), an https one directly; through `GET /login?code=` when a code was
/// given and the server wants one (it sets the session cookie and redirects to "/", so the code leaves the address
/// bar). Blocks (the relay's start).
fn show_remote(app: &AppHandle, origin: &Url, code: Option<String>, status: &remote::Status) -> Result<(), String> {
    let shown = if proxy::wanted(origin) {
        proxy::start(app, origin)? // its errors name the relay ("연결 통로(프록시)…") themselves
    } else {
        origin_of(origin)
    };
    let target = match code.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        Some(code) if status.auth_required => remote::login_url(&shown, &code)?,
        _ => shown.clone(),
    };
    config::log(app, &format!("connecting to {origin} as {shown} (login required: {})", status.auth_required));
    go_to(app, &target);
    Ok(())
}

#[derive(Serialize)]
struct Picked {
    path: String,
    /// Set when the folder is not empty and does not look like an easy-study library.
    warning: Option<String>,
}

#[tauri::command]
async fn pick_library(app: AppHandle) -> Result<Option<Picked>, String> {
    let current = config::library(&app, &config::load(&app)).path;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut dialog = app.dialog().file().set_title("라이브러리 폴더 선택");
    if current.is_dir() {
        dialog = dialog.set_directory(&current);
    }
    if let Some(w) = main_window(&app) {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(Some(Picked { warning: library_warning(&path), path: path.to_string_lossy().into_owned() }))
}

/// A non-empty folder without any sign of an easy-study library (a docs folder picked by mistake).
fn library_warning(dir: &Path) -> Option<String> {
    let entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().take(500).collect(),
        Err(e) => return Some(format!("이 폴더를 읽을 수 없어요 ({e}). 그래도 쓸까요?")),
    };
    let names: Vec<String> = entries.iter().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let visible = names.iter().filter(|n| !matches!(n.as_str(), ".DS_Store" | "desktop.ini" | "Thumbs.db")).count();
    let markers = ["layout.json", "courses", ".server.lock", ".auth.json"];
    let is_library = names.iter().any(|n| markers.contains(&n.as_str())) || entries.iter().any(|e| e.path().join("doc.json").is_file());
    (visible > 0 && !is_library).then(|| {
        format!(
            "'{}' 폴더는 비어 있지 않고 easy-study 라이브러리처럼 보이지 않아요. 강의마다 폴더가 이 안에 만들어져요. 그래도 이 폴더를 쓸까요?",
            dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.display().to_string())
        )
    })
}

#[derive(Serialize)]
struct LibraryChange {
    library: config::Library,
    message: Option<String>,
}

/// Uses `path` as the library (None = the default one). A running local server with another library is
/// stopped; "연결" starts it again on the new folder.
#[tauri::command]
fn set_library(app: AppHandle, path: Option<String>) -> Result<LibraryChange, String> {
    if std::env::var_os(config::ENV_LIBRARY).is_some_and(|v| !v.is_empty()) {
        return Err(format!("{} 환경 변수가 라이브러리 폴더를 정하고 있어요.", config::ENV_LIBRARY));
    }
    let chosen = match path.filter(|p| !p.trim().is_empty()) {
        None => None,
        Some(p) => {
            let dir = PathBuf::from(p.trim());
            if !dir.is_absolute() || !dir.is_dir() {
                return Err(format!("폴더가 아니에요: {}", dir.display()));
            }
            let probe = dir.join(format!(".easy-study-write-test-{}", std::process::id()));
            std::fs::write(&probe, b"").map_err(|e| format!("이 폴더에 쓸 수 없어요: {} ({e})", dir.display()))?;
            let _ = std::fs::remove_file(&probe);
            (dir != config::default_library(&app)).then(|| dir.to_string_lossy().into_owned())
        }
    };
    let cfg = config::update(&app, |c| c.library = chosen);
    let library = config::library(&app, &cfg);
    let st = app.state::<AppState>();
    let running_on = lock(&st.server).as_ref().map(|r| r.library.clone());
    let message = match running_on {
        Some(old) if old != library.path => {
            let h = app.clone();
            std::thread::spawn(move || server::stop(&h));
            "라이브러리 폴더를 바꿨어요. 실행 중이던 서버를 끄고 있어요 — \"연결\"을 누르면 새 폴더로 시작해요."
        }
        _ => "라이브러리 폴더를 바꿨어요.",
    };
    config::log(&app, &format!("library set to {}", library.path.display()));
    Ok(LibraryChange { library, message: Some(message.into()) })
}

#[tauri::command]
fn open_library(app: AppHandle) -> Result<(), String> {
    open_library_folder(&app)
}

fn open_library_folder(app: &AppHandle) -> Result<(), String> {
    let path = config::library(app, &config::load(app)).path;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------------------------------------

fn build_menu(h: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let choose = MenuItem::with_id(h, "choose", "연결 대상 바꾸기…", true, Some("CmdOrCtrl+Shift+K"))?;
    let reload = MenuItem::with_id(h, "reload", "새로 고침", true, Some("CmdOrCtrl+R"))?;
    let browser = MenuItem::with_id(h, "open-browser", "브라우저에서 열기", true, None::<&str>)?;
    let library = MenuItem::with_id(h, "open-library", "라이브러리 폴더 열기", true, None::<&str>)?;
    let settings = MenuItem::with_id(h, "settings", "설정…", true, Some("CmdOrCtrl+,"))?;
    // Its text names a found version ("업데이트 설치 (0.5.1)…"): the way in when the page ignores the pushed state.
    let check_update = MenuItem::with_id(h, "check-update", "업데이트 확인…", true, None::<&str>)?;
    if let Some(st) = h.try_state::<AppState>() {
        *lock(&st.update.menu) = Some(check_update.clone());
    }
    #[cfg(target_os = "macos")]
    {
        let name = h.package_info().name.clone();
        // The app's own quit item (not the predefined one, whose terminate: cannot be held off): it goes through
        // ExitRequested, which waits while an update replaces the app.
        let quit = MenuItem::with_id(h, "quit", format!("{name} 종료"), true, Some("CmdOrCtrl+Q"))?;
        let app_menu = Submenu::with_items(
            h,
            &name,
            true,
            &[
                &PredefinedMenuItem::about(h, Some(&format!("{name}에 관하여")), None)?,
                &PredefinedMenuItem::separator(h)?,
                &settings,
                &check_update,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::services(h, Some("서비스"))?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::hide(h, Some(&format!("{name} 가리기")))?,
                &PredefinedMenuItem::hide_others(h, Some("기타 가리기"))?,
                &PredefinedMenuItem::show_all(h, Some("모두 보기"))?,
                &PredefinedMenuItem::separator(h)?,
                &quit,
            ],
        )?;
        // The Edit menu is what makes ⌘C / ⌘V / ⌘A work in a WKWebView.
        let edit = Submenu::with_items(
            h,
            "편집",
            true,
            &[
                &PredefinedMenuItem::undo(h, Some("실행 취소"))?,
                &PredefinedMenuItem::redo(h, Some("실행 복귀"))?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::cut(h, Some("오려두기"))?,
                &PredefinedMenuItem::copy(h, Some("복사하기"))?,
                &PredefinedMenuItem::paste(h, Some("붙여넣기"))?,
                &PredefinedMenuItem::select_all(h, Some("전체 선택"))?,
            ],
        )?;
        let connect = Submenu::with_items(
            h,
            "연결",
            true,
            &[&choose, &reload, &PredefinedMenuItem::separator(h)?, &browser, &library],
        )?;
        let window = Submenu::with_items(
            h,
            "윈도우",
            true,
            &[
                &PredefinedMenuItem::minimize(h, Some("최소화"))?,
                &PredefinedMenuItem::maximize(h, Some("확대/축소"))?,
                &PredefinedMenuItem::fullscreen(h, Some("전체 화면"))?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::close_window(h, Some("윈도우 닫기"))?,
            ],
        )?;
        Menu::with_items(h, &[&app_menu, &edit, &connect, &window])
    }
    #[cfg(not(target_os = "macos"))]
    {
        let quit = MenuItem::with_id(h, "quit", "종료", true, Some("CmdOrCtrl+Q"))?;
        let connect = Submenu::with_items(
            h,
            "연결",
            true,
            &[
                &choose,
                &reload,
                &PredefinedMenuItem::separator(h)?,
                &browser,
                &library,
                &PredefinedMenuItem::separator(h)?,
                &settings,
                &check_update,
                &PredefinedMenuItem::separator(h)?,
                &quit,
            ],
        )?;
        Menu::with_items(h, &[&connect])
    }
}

#[derive(Clone, Copy)]
enum Leave {
    Choose,
    Reload,
}

/// A menu item's flow runs (its dialog is open, its check runs): a second click of the same item does nothing. One
/// flag per item: a slow update check must not hold up "연결 대상 바꾸기…" (the way back to the chooser).
static CHOOSE_FLOW: AtomicBool = AtomicBool::new(false);
static RELOAD_FLOW: AtomicBool = AtomicBool::new(false);
static SETTINGS_FLOW: AtomicBool = AtomicBool::new(false);
static CHECK_FLOW: AtomicBool = AtomicBool::new(false);

/// Runs `f` on its own thread (menu handlers run on the UI thread: dialogs, eval_json and checks would block it),
/// one at a time per item.
fn menu_thread(app: &AppHandle, flow: &'static AtomicBool, f: impl FnOnce(&AppHandle) + Send + 'static) {
    if flow.swap(true, SeqCst) {
        return;
    }
    let h = app.clone();
    std::thread::spawn(move || {
        f(&h);
        flow.store(false, SeqCst);
    });
}

/// Menu "연결 대상 바꾸기…" / "새로 고침": asks first when the page records or holds audio it has not sent (a page
/// that does not answer, e.g. an older remote UI, is left as before).
fn leave_page(app: &AppHandle, how: Leave) {
    if let bridge::PageAnswer::Busy(busy) = bridge::page_answer(app) {
        if busy.holds_audio() {
            let (text, ok) = match how {
                Leave::Choose => (
                    "강의를 녹음하는 중이에요. 바꾸면 녹음이 멈춰요 (녹음한 부분은 저장돼 있어서 같은 서버에 다시 연결하면 마저 올라가요).",
                    "바꾸기",
                ),
                Leave::Reload => ("강의를 녹음하는 중이에요. 새로 고치면 녹음이 멈춰요 (녹음한 부분은 저장돼 있어서 다시 열면 마저 올라가요).", "다시 고침"),
            };
            if !bridge::confirm(app, text, ok, "취소") {
                return;
            }
            bridge::allow_leave(app);
        }
    }
    match how {
        Leave::Choose => show_chooser(app),
        Leave::Reload => {
            if let Some(w) = main_window(app) {
                let _ = w.eval("location.reload()");
            }
        }
    }
}

/// Menu "설정…": the page's settings dialog, or the chooser's "앱 설정" (the chooser, an older remote UI). The chooser
/// opens it from get_state (it asks every second).
fn open_settings(app: &AppHandle) {
    if bridge::open_page_settings(app) {
        return;
    }
    *lock(&app.state::<AppState>().chooser_focus) = Some("settings".into());
    if !on_chooser(app) {
        show_chooser(app);
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "choose" => menu_thread(app, &CHOOSE_FLOW, |h| leave_page(h, Leave::Choose)),
        "reload" => menu_thread(app, &RELOAD_FLOW, |h| leave_page(h, Leave::Reload)),
        "settings" => menu_thread(app, &SETTINGS_FLOW, open_settings),
        "check-update" => menu_thread(app, &CHECK_FLOW, update::menu_check),
        "open-browser" => {
            let url = main_window(app)
                .and_then(|w| w.url().ok())
                .filter(|u| matches!(u.scheme(), "http" | "https"))
                // A relayed page: the remote server itself (the relay dies with the app; the browser has its own
                // cookies anyway).
                .map(|u| proxy::target_of(app, &origin_of(&u)).and_then(|t| Url::parse(&t).ok()).unwrap_or(u));
            if let Some(url) = url.or_else(|| lock(&app.state::<AppState>().server_url).as_deref().and_then(|u| Url::parse(u).ok())) {
                open_externally(app, &url);
            }
        }
        "open-library" => {
            if let Err(e) = open_library_folder(app) {
                config::log(app, &format!("open library: {e}"));
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

// ---------------------------------------------------------------------------------------------------------
// Smoke tests (EASY_STUDY_DESKTOP_SMOKE, for CI and local checks). Every line of the result starts with
// "EASY_STUDY_DESKTOP_SMOKE"; exit 0 = fine, 2 the server or the connection failed, 3 timeout
// (EASY_STUDY_DESKTOP_SMOKE_TIMEOUT, default 120 s), 4 the checks failed, 5 the chooser stayed busy after a failure.
//   =1               start the local server directly (as a remembered "이 컴퓨터에서 실행" does) or, with
//                    EASY_STUDY_DESKTOP_SMOKE_URL (+ _CODE), connect to that server (open_remote, as the chooser);
//   =chooser         only check the chooser page (IPC, script, styles);
//   =chooser-local   submit the chooser's own form for "이 컴퓨터에서 실행" (its submit handler → IPC connect_local);
//   =chooser-remote  fill in EASY_STUDY_DESKTOP_SMOKE_URL / _CODE and submit "다른 컴퓨터에 연결" (→ connect_remote).
// A failure that the chooser shows (=chooser-*) is judged by what the chooser shows. On the server's page: the web
// client rendered, /api/health answers (with the login cookie for a remote server), the page has no IPC but the
// shell's marker and pushed state (update phase idle: smoke runs never check for updates), and — local server
// only — a one-page PDF uploads, converts and its slide images load (the document is deleted again), the page has
// what the lecture recorder needs (a secure context with navigator.mediaDevices.getUserMedia and AudioWorklet:
// Info.plist's microphone key on macOS, media.rs on Linux; the microphone is never opened; also checked on a page
// shown through the relay, proxy.rs), and GET /api/asr finds the speech recognition engine and ffmpeg the shell
// passed (DESIGN §22; the last one skipped with EASY_STUDY_DESKTOP_SMOKE_ASR=0). EASY_STUDY_DESKTOP_SMOKE_WRITE=1
// (a test server): the PDF check on a remote or relayed page too, and on every page a chat turn streamed as SSE
// (events arrive, the stream ends) and a recording upload (a short WAV, 201). A smoke run registers no
// single-instance handover: another running copy of the app must not turn it into a silent success.
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Smoke {
    Off,
    Direct,
    Chooser,
    ChooserLocal,
    ChooserRemote,
}

impl Smoke {
    fn parse(value: &str) -> Smoke {
        match value.trim() {
            "" | "0" => Smoke::Off,
            "chooser" => Smoke::Chooser,
            "chooser-local" => Smoke::ChooserLocal,
            "chooser-remote" => Smoke::ChooserRemote,
            _ => Smoke::Direct,
        }
    }

    fn on(self) -> bool {
        self != Smoke::Off
    }

    /// Starts on the chooser page (=1 starts the server or the connection itself).
    fn via_chooser(self) -> bool {
        matches!(self, Smoke::Chooser | Smoke::ChooserLocal | Smoke::ChooserRemote)
    }

    /// Checks the server's page (all but =chooser).
    fn checks_page(self) -> bool {
        matches!(self, Smoke::Direct | Smoke::ChooserLocal | Smoke::ChooserRemote)
    }
}

/// A one-page PDF (960x540, a bar and a line of Helvetica text; tests/pdfFixtures.ts pagesPdf) for the upload check.
const SMOKE_PDF_BASE64: &str = "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs0IDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgOTYwIDU0MF0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDUgMCBSID4+CmVuZG9iago1IDAgb2JqCjw8ICAvTGVuZ3RoIDg2ID4+CnN0cmVhbQowLjIgMC40IDAuOCByZyA2MCA2MCA4NDAgMTIwIHJlIGYgQlQgL0YxIDY0IFRmIDYwIDM2MCBUZCAoZWFzeS1zdHVkeSBzbW9rZSB0ZXN0KSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDIxOCAwMDAwMCBuIAowMDAwMDAwMzQ0IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDgxCiUlRU9GCg==";

/// Runs once per page (the result object survives a second "finished" event of the same page). __INGEST__, __ASR__,
/// __RECORDER__, __WRITE__ and __PDF__ are filled in by smoke_page_loaded.
const SMOKE_PROBE_JS: &str = r#"(() => {
  if (window.__esSmoke) return;
  const s = (window.__esSmoke = { ipc: 'no-ipc' });
  try {
    if (window.__TAURI_INTERNALS__) {
      s.ipc = 'pending';
      window.__TAURI_INTERNALS__.invoke('get_state').then(() => { s.ipc = 'ALLOWED'; }, (e) => { s.ipc = 'denied: ' + e; });
    }
  } catch (e) { s.ipc = 'threw: ' + e; }
  fetch('/api/auth/status').then((r) => r.json()).then((j) => { s.auth = j; }, (e) => { s.auth = String(e); });
  fetch('/api/health').then(async (r) => {
    s.health = r.status;
    if (r.ok) s.providers = (await r.json()).providers.map((p) => p.id + ':' + (p.available ? (p.version || 'yes') : 'no'));
  }, (e) => { s.health = String(e); });
  if (__ASR__) {
    s.asr = 'pending';
    fetch('/api/asr').then(async (r) => {
      if (!r.ok) { s.asr = 'HTTP ' + r.status; return; }
      const a = await r.json();
      s.asrStatus = { engine: a.engineAvailable, version: a.engineVersion ?? null, acceleration: a.acceleration, ffmpeg: a.ffmpegAvailable,
        reason: a.reason ?? null, models: (a.models || []).map((m) => m.id + (m.installed ? ' (installed)' : '')) };
      s.asr = a.engineAvailable === true && a.ffmpegAvailable === true ? 'ok' : 'FAIL';
    }, (e) => { s.asr = 'error: ' + e; }).finally(() => { s.asrDone = true; });
  }
  if (__RECORDER__) {
    // What the lecture recorder checks before it asks for the microphone (never asked here: no getUserMedia call).
    s.recorder = { secure: window.isSecureContext === true, mediaDevices: typeof navigator.mediaDevices?.getUserMedia === 'function',
      worklet: typeof AudioWorkletNode === 'function' };
  }
  if (!__INGEST__) return;
  s.ingest = 'pending';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    const pdf = Uint8Array.from(atob('__PDF__'), (c) => c.charCodeAt(0));
    const up = await fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent('easy-study smoke test.pdf') }, body: pdf });
    if (!up.ok) throw new Error('upload: HTTP ' + up.status + ' ' + (await up.text()));
    s.docId = (await up.json()).id;
    let doc = null;
    for (let i = 0; i < 300 && (!doc || doc.status === 'processing'); i++) {
      if (doc) await sleep(200);
      doc = await (await fetch('/api/docs/' + s.docId)).json();
    }
    if (doc.status !== 'ready') throw new Error('conversion: ' + doc.status + (doc.error ? ' (' + doc.error + ')' : ''));
    s.images = [];
    for (const p of ['slides/1.png', 'view/1.webp', 'thumbs/1.webp']) {
      const r = await fetch('/api/docs/' + s.docId + '/' + p);
      s.images.push(p + ' ' + r.status + ' ' + (r.headers.get('content-type') || '-') + ' ' + (await r.arrayBuffer()).byteLength);
    }
    s.ingest = s.images.every((line) => / 200 image\/\S+ [1-9]/.test(line)) ? 'ok' : 'FAIL';
    if (!__WRITE__) return;
    // A chat turn streamed as SSE (the test server's fake CLIs answer): events arrive and the stream ends in 60 s.
    s.stream = 'pending';
    const session = await fetch('/api/docs/' + s.docId + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude-code' }) });
    if (session.status !== 201) throw new Error('session: HTTP ' + session.status + ' ' + (await session.text()));
    const sid = (await session.json()).id;
    const turn = await fetch('/api/docs/' + s.docId + '/sessions/' + sid + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ text: 'smoke', slide: 1 }) });
    if (!turn.ok) throw new Error('turn: HTTP ' + turn.status + ' ' + (await turn.text()));
    const reader = turn.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 60000;
    let text = '';
    let ended = false;
    while (Date.now() < deadline) {
      const next = await Promise.race([reader.read(), sleep(Math.max(1, deadline - Date.now())).then(() => ({ done: false, late: true }))]);
      if (next.late) break;
      if (next.done) { ended = true; break; }
      text += decoder.decode(next.value, { stream: true });
    }
    if (!ended) reader.cancel().catch(() => {});
    s.streamEvents = (text.match(/^event: /gm) || []).length;
    s.stream = ended && s.streamEvents >= 1 ? 'ok' : 'FAIL';
    // A recording upload: half a second of silence as a 16 kHz mono WAV (the server answers 201 once it is stored).
    s.recording = 'pending';
    const samples = 8000;
    const wav = new Uint8Array(44 + samples * 2);
    const dv = new DataView(wav.buffer);
    const tag = (at, t) => { for (let i = 0; i < 4; i++) wav[at + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, samples * 2, true);
    const rec = await fetch('/api/docs/' + s.docId + '/recordings/upload', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Filename': 'smoke.wav' }, body: wav });
    s.recording = rec.status === 201 ? 'ok' : 'HTTP ' + rec.status + ' ' + (await rec.text()).slice(0, 200);
  })().catch((e) => { if (s.ingest === 'pending') s.ingest = 'error: ' + e; else if (s.stream === 'pending') s.stream = 'error: ' + e; else s.recording = 'error: ' + e; }).finally(async () => {
    if (s.docId) s.deleted = await fetch('/api/docs/' + s.docId, { method: 'DELETE' }).then((r) => r.status, (e) => String(e));
    s.ingestDone = true;
  });
})()"#;

/// `desktop` and `updatePhase`: the shell's marker (bridge::INIT_SCRIPT) and its pushed state (no update check runs in
/// a smoke run: the phase stays idle). `justUpdated` and `toasts` are only reported (desktop.json `updatedFrom` set to
/// another version gives the "updated" toast).
const SMOKE_RESULT_JS: &str = "JSON.stringify({ url: location.href, title: document.title, rendered: document.getElementById('root')?.childElementCount ?? -1, \
     desktop: window.__EASY_STUDY_DESKTOP__?.v ?? null, updatePhase: window.__easyStudyDesktopState?.update?.phase ?? null, \
     justUpdated: window.__easyStudyDesktopState?.justUpdated ?? null, \
     toasts: Array.from(document.querySelectorAll('.toast-message'), (t) => t.textContent), ...window.__esSmoke })";

/// What the chooser shows: status kind ('' when hidden, else info / busy / error), its text, and whether the
/// "연결" button is disabled (the chooser disables every control while it is busy).
const CHOOSER_STATUS_JS: &str = "JSON.stringify((() => { const box = document.getElementById('status'); \
     return { kind: box && !box.hidden ? box.className.replace('status', '').trim() : '', \
     text: document.getElementById('status-text')?.textContent ?? '', disabled: !!document.getElementById('connect')?.disabled }; })())";

fn smoke_say(app: &AppHandle, msg: &str) {
    println!("{SMOKE_ENV} {msg}");
    config::log(app, &format!("smoke: {msg}"));
}

/// The one result of a smoke run: said once, then the app exits with `code`.
fn smoke_verdict(app: &AppHandle, code: i32, msg: &str) {
    if app.state::<AppState>().smoke_done.swap(true, SeqCst) {
        return;
    }
    smoke_say(app, msg);
    quit(app, code);
}

/// Evaluates `js` — an expression whose value is a JSON string — in the main window (Null without an answer).
/// Blocks up to 10 s for the answer, which the main thread delivers: NEVER call it on the main thread (menu
/// handlers, synchronous commands, navigation callbacks), where it would hang and answer Null.
pub(crate) fn eval_json(app: &AppHandle, js: &str) -> serde_json::Value {
    let Some(w) = main_window(app) else { return serde_json::Value::Null };
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = w.eval_with_callback(js, move |result| {
        let _ = tx.send(result);
    });
    let raw = rx.recv_timeout(Duration::from_secs(10)).unwrap_or_default();
    // The callback gets the JSON of the evaluated value: here a string that holds JSON.
    serde_json::from_str::<String>(&raw)
        .ok()
        .and_then(|inner| serde_json::from_str(&inner).ok())
        .or_else(|| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn on_chooser(app: &AppHandle) -> bool {
    main_window(app).and_then(|w| w.url().ok()).is_some_and(|u| is_chooser(app, &u))
}

/// The chooser shows an error and its controls work again.
fn chooser_shows_error(status: &serde_json::Value) -> bool {
    status["kind"] == "error" && status["disabled"] == false
}

/// A failure the shell noticed (the server did not start or exited, the connection failed). =1: the result at
/// once; =chooser-*: the result is what the chooser shows (it must show the error, not stay busy).
pub fn smoke_fail(app: &AppHandle, code: i32, why: &str) {
    let st = app.state::<AppState>();
    match st.smoke {
        Smoke::Off => {}
        Smoke::ChooserLocal | Smoke::ChooserRemote => {
            let (h, why) = (app.clone(), why.to_string());
            std::thread::spawn(move || {
                let mut status = serde_json::Value::Null;
                for _ in 0..40 {
                    std::thread::sleep(Duration::from_millis(250));
                    if on_chooser(&h) {
                        status = eval_json(&h, CHOOSER_STATUS_JS);
                        if chooser_shows_error(&status) {
                            let text = status["text"].as_str().unwrap_or_default();
                            return smoke_verdict(&h, code, &format!("FAIL {why}: the chooser shows: {text}"));
                        }
                    }
                }
                smoke_verdict(&h, 5, &format!("FAIL {why}; the chooser does not show it with usable controls: {status}"));
            });
        }
        _ => {
            let msg = format!("FAIL {why}: {} | {}", lock(&st.error).clone().unwrap_or_default(), server::tail(app).join(" / "));
            smoke_verdict(app, code, &msg);
        }
    }
}

/// The chooser page loaded: it must show the library path it got through IPC, styled. =chooser-*: then submit
/// its form.
fn smoke_chooser_loaded(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.smoke.via_chooser() || st.smoke_chooser_started.swap(true, SeqCst) {
        return;
    }
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let page = eval_json(
            &h,
            "JSON.stringify({ library: document.getElementById('library-path')?.textContent, \
             styled: getComputedStyle(document.querySelector('.option')).borderRadius, status: document.getElementById('status-text')?.textContent })",
        );
        smoke_say(&h, &format!("chooser {page}"));
        let want = config::library(&h, &config::load(&h)).path.to_string_lossy().into_owned();
        if page["library"].as_str() != Some(want.as_str()) || page["styled"].as_str() != Some("12px") {
            return smoke_verdict(&h, 4, "FAIL chooser");
        }
        match h.state::<AppState>().smoke {
            Smoke::ChooserLocal | Smoke::ChooserRemote => smoke_submit_chooser(&h),
            _ => smoke_verdict(&h, 0, "ok"),
        }
    });
}

/// =chooser-local / =chooser-remote: fills in and submits the chooser's form ("다음에도 바로 연결" off), the path a
/// click takes: its submit handler calls connect_local / connect_remote over IPC. Then watches the chooser until
/// the window leaves it (smoke_page_loaded checks the server's page) or it shows an error.
fn smoke_submit_chooser(app: &AppHandle) {
    let remote = app.state::<AppState>().smoke == Smoke::ChooserRemote;
    let fill = if remote {
        let url = std::env::var("EASY_STUDY_DESKTOP_SMOKE_URL").unwrap_or_default();
        let code = std::env::var("EASY_STUDY_DESKTOP_SMOKE_CODE").unwrap_or_default();
        format!(
            "f.querySelector('input[name=mode][value=remote]').click(); document.getElementById('url').value = {}; \
             document.getElementById('code').value = {};",
            serde_json::Value::String(url),
            serde_json::Value::String(code)
        )
    } else {
        "f.querySelector('input[name=mode][value=local]').click();".to_string()
    };
    let submitted = eval_json(
        app,
        &format!(
            "JSON.stringify((() => {{ const f = document.getElementById('form'); {fill} \
             document.getElementById('remember').checked = false; f.requestSubmit(); return 'submitted'; }})())"
        ),
    );
    smoke_say(app, &format!("chooser: {} {submitted}", if remote { "다른 컴퓨터에 연결" } else { "이 컴퓨터에서 실행" }));
    let st = app.state::<AppState>();
    while !st.smoke_done.load(SeqCst) {
        std::thread::sleep(Duration::from_millis(300));
        if !on_chooser(app) {
            return; // the server's page is loading
        }
        let status = eval_json(app, CHOOSER_STATUS_JS);
        if chooser_shows_error(&status) {
            let text = status["text"].as_str().unwrap_or_default();
            return smoke_verdict(app, 2, &format!("FAIL connect: the chooser shows: {text}"));
        }
    }
}

fn smoke_page_loaded(app: &AppHandle, url: &Url) {
    let st = app.state::<AppState>();
    let target = lock(&st.allowed_origin).clone();
    if !st.smoke.checks_page() || target.as_deref() != Some(origin_of(url).as_str()) || url.path().starts_with("/login") {
        return;
    }
    if st.smoke_page_started.swap(true, SeqCst) {
        return;
    }
    let local = lock(&st.server_url).as_deref().and_then(|u| Url::parse(u).ok()).is_some_and(|u| origin_of(&u) == origin_of(url));
    // A remote server shown through the relay (proxy.rs): the page must be a secure context there as well.
    let proxied = lock(&st.proxy_url).as_deref() == Some(origin_of(url).as_str());
    // Writes to another computer's server only when asked (a test server): never add a document to someone's library.
    let write = std::env::var(SMOKE_WRITE_ENV).is_ok_and(|v| v.trim() == "1");
    let ingest = local || write;
    // The recording tools of this computer's server (the bundled whisper-cli and ffmpeg).
    let asr = local && std::env::var(SMOKE_ASR_ENV).map_or(true, |v| v.trim() != "0");
    let js_bool = |b: bool| if b { "true" } else { "false" };
    let probe = SMOKE_PROBE_JS
        .replace("__INGEST__", js_bool(ingest))
        .replace("__WRITE__", js_bool(write))
        .replace("__RECORDER__", js_bool(local || proxied))
        .replace("__ASR__", js_bool(asr))
        .replace("__PDF__", SMOKE_PDF_BASE64);
    let h = app.clone();
    std::thread::spawn(move || {
        let mut page = serde_json::Value::Null;
        // "Finished" can fire twice for the first page (WKWebView): probe again when the page was replaced.
        'probe: for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(500));
            if let Some(w) = main_window(&h) {
                let _ = w.eval(&probe);
            }
            for _ in 0..300 {
                std::thread::sleep(Duration::from_millis(250));
                page = eval_json(&h, SMOKE_RESULT_JS);
                if page.get("ipc").is_none() {
                    continue 'probe;
                }
                let ingest_done = !ingest || page["ingestDone"] == true;
                let asr_done = !asr || page["asrDone"] == true;
                if page.get("health").is_some() && page.get("auth").is_some() && ingest_done && asr_done {
                    break 'probe;
                }
            }
        }
        smoke_say(&h, &format!("page {page}"));
        let rendered = page.get("rendered").and_then(|v| v.as_i64()).unwrap_or(-1) > 0;
        let ipc = page.get("ipc").and_then(|v| v.as_str()).unwrap_or("?");
        let no_ipc = ipc == "no-ipc" || ipc.starts_with("denied");
        let health = page.get("health").and_then(|v| v.as_i64()) == Some(200);
        let auth = &page["auth"];
        let logged_in = auth["authenticated"].as_bool() == Some(true) || auth["authRequired"].as_bool() == Some(false);
        let slides = !ingest || page["ingest"] == "ok";
        let tools = !asr || page["asr"] == "ok";
        let recorder = !(local || proxied) || ["secure", "mediaDevices", "worklet"].iter().all(|k| page["recorder"][k] == true);
        let stream = !write || page["stream"] == "ok";
        let recording = !write || page["recording"] == "ok";
        let shell = page["desktop"] == 1 && page["updatePhase"] == "idle";
        if rendered && no_ipc && health && logged_in && slides && tools && recorder && stream && recording && shell {
            smoke_verdict(&h, 0, "ok");
        } else {
            smoke_verdict(
                &h,
                4,
                &format!(
                    "FAIL checks: rendered {rendered}, no IPC {no_ipc}, health {health}, logged in {logged_in}, PDF upload and slide images {slides}, \
                     speech recognition tools {tools}, recorder APIs {recorder}, chat stream {stream}, recording upload {recording}, \
                     desktop marker and state {shell}"
                ),
            );
        }
    });
}

// ---------------------------------------------------------------------------------------------------------

/// A page of the allowed origin finished loading in the main window: it gets the shell's state, and a remembered
/// connection that opened at launch counts as working once its page has been up for 30 s.
fn page_loaded(app: &AppHandle, url: &Url) {
    let st = app.state::<AppState>();
    if !matches!(url.scheme(), "http" | "https") || !is_allowed_page(app, url) {
        return;
    }
    *lock(&st.page_origin) = Some(origin_of(url));
    bridge::push_state(app);
    if st.auto_connect.swap(false, SeqCst) {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(30));
            if !h.state::<AppState>().quitting.load(SeqCst) {
                config::update(&h, |c| c.auto_connect_pending = false);
            }
        });
    }
}

/// Linux: the single-instance plugin needs a D-Bus session bus (it panics without one, e.g. in a bare
/// container); every desktop session has one. The library lock still keeps a second server away.
fn single_instance_possible() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|v| !v.is_empty())
            || std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|d| Path::new(&d).join("bus").exists())
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn main() {
    update::keep_ssl_env(); // first: it changes the environment, which is only safe before any thread starts
    pathenv::start_resolving();
    let smoke = Smoke::parse(&std::env::var(SMOKE_ENV).unwrap_or_default());

    let mut builder = tauri::Builder::default();
    // Not for a smoke run: handed over to another running copy, it would exit 0 without testing anything (the
    // handover is machine-wide, whatever HOME or EASY_STUDY_DESKTOP_HOME). The library lock still keeps two
    // servers off one library.
    if single_instance_possible() && !smoke.on() {
        // First plugin: a second launch hands over to this instance (which comes to the front) and exits.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = main_window(app) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        // Without the plugin's click script: it would catch every click on an <a target="_blank"> to http(s), mailto
        // or tel (the update banner's release page, notes.md, links in answers), cancel it and call
        // `plugin:opener|open_url` over IPC, which no page may use (capabilities/chooser.json) — so nothing happened.
        // The clicks reach WebKit instead: allow_main_navigation sends other sites to the browser and new_window
        // opens the server's own pages in app windows.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_dialog::init())
        // Driven from Rust only (update.rs): its JS commands stay denied, no capability grants them.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new(smoke))
        .invoke_handler(tauri::generate_handler![
            get_state,
            connect_local,
            connect_remote,
            pick_library,
            set_library,
            open_library,
            check_update,
            install_update,
            cancel_update,
            set_theme,
            set_update_check,
            forget_choice,
            open_logs,
            set_share,
            reset_share_code
        ])
        .menu(build_menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup(move |app| {
            let h = app.handle().clone();
            config::rotate(&config::log_dir(&h).join("shell.log"), 1024 * 1024);
            config::log(&h, &format!("start {} {} ({})", h.package_info().name, h.package_info().version, std::env::consts::ARCH));
            pathenv::use_cache(config::config_dir(&h).join("path-cache.txt"));
            config::data_dir(&h); // created with owner-only permissions (Linux keeps the WebView's cookies there)
            let cfg = config::load(&h);
            // The theme before the first window: windows start with the app's (a theme given to a window builder
            // would win over later changes on Windows).
            h.set_theme(config::theme(&cfg));
            update::setup(&h, smoke.on());

            // SIGTERM (logout, kill, systemd) / SIGINT / SIGHUP: leave through app.exit so RunEvent::Exit stops
            // the server gracefully (Tauri does not handle these signals itself).
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP])?;
                let hs = h.clone();
                std::thread::spawn(move || {
                    if let Some(sig) = signals.forever().next() {
                        config::log(&hs, &format!("signal {sig}: quitting"));
                        // Not while an update replaces the app (a half-written AppImage would not start again).
                        update::wait_until_replaced(&hs, Duration::from_secs(60));
                        hs.exit(0);
                    }
                });
            }

            let (h_nav, h_new, h_load, h_dl) = (h.clone(), h.clone(), h.clone(), h.clone());
            let version = h.package_info().version.to_string();
            let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("easy-study")
                // The pages know they are inside the app (main frame only; no IPC: bridge.rs).
                .initialization_script(bridge::init_script(&version, std::env::consts::OS))
                .inner_size(1280.0, 840.0)
                .min_inner_size(480.0, 400.0)
                .center()
                // The page's own HTML5 drop (PDF upload onto the library) needs the files, not Tauri's handler.
                .disable_drag_drop_handler()
                // A lecture keeps recording (and uploading) while the window is minimized or covered: WKWebView
                // (macOS 14+) would otherwise suspend the hidden page (DESIGN §22, rec-live spike).
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .on_navigation(move |url| allow_main_navigation(&h_nav, url))
                .on_new_window(move |url, features| new_window(&h_new, url, features))
                // Nothing is written without the user: the web client never downloads files, so a download a
                // page starts (a script clicking an <a download> on another computer's server, say) is refused.
                .on_download(move |_webview, event| {
                    if let DownloadEvent::Requested { url, .. } = &event {
                        config::log(&h_dl, &format!("download refused: {url}"));
                    }
                    false
                })
                .on_page_load(move |_w, payload| {
                    if matches!(payload.event(), PageLoadEvent::Started) {
                        *lock(&h_load.state::<AppState>().page_origin) = None;
                    } else if matches!(payload.event(), PageLoadEvent::Finished) {
                        // Without the query: an engine may report the login link (the code in its query) here.
                        bridge::log_limited(&h_load, "page", &format!("page loaded {}", without_query(payload.url())));
                        if is_chooser(&h_load, payload.url()) {
                            smoke_chooser_loaded(&h_load);
                        } else {
                            page_loaded(&h_load, payload.url());
                            smoke_page_loaded(&h_load, payload.url());
                        }
                    }
                })
                .build()?;
            *lock(&h.state::<AppState>().chooser_url) = window.url().ok();
            media::install(&h, &window); // the lecture recorder's microphone (DESIGN §22)

            let smoke_url = std::env::var("EASY_STUDY_DESKTOP_SMOKE_URL").ok().filter(|u| smoke == Smoke::Direct && !u.is_empty());
            let st = h.state::<AppState>();
            // The last launch ended right after its automatic connection (a crash, a forced quit): the chooser comes
            // first, so a page that brings the app down (or keeps it busy) cannot lock the user out.
            let crashed = smoke == Smoke::Off && cfg.auto_connect_pending;
            if crashed {
                config::update(&h, |c| c.auto_connect_pending = false);
            }
            let saved = if crashed && !cfg.mode.is_empty() {
                config::log(&h, "the app closed right after its last automatic connection: the chooser comes first");
                *lock(&st.notice) =
                    Some("지난번에 연결한 직후 앱이 닫혀서 이번에는 연결 선택 화면을 먼저 보여 드려요. 연결할 곳을 골라 주세요.".into());
                ""
            } else {
                cfg.mode.as_str()
            };
            if smoke == Smoke::Off && matches!(saved, "local" | "remote") {
                config::update(&h, |c| c.auto_connect_pending = true);
                st.auto_connect.store(true, SeqCst);
            }
            let mode = match smoke {
                Smoke::Off => saved,
                Smoke::Direct if smoke_url.is_some() => "smoke-remote",
                Smoke::Direct => "local",
                _ => "", // the chooser
            };
            match mode {
                "local" => server::start(&h).map_err(|e| e.to_string())?,
                "remote" => {
                    if let Some(saved) = cfg.remote_url.clone() {
                        let st = h.state::<AppState>();
                        *lock(&st.busy) = Some(format!("{saved} 에 연결하는 중…"));
                        let hr = h.clone();
                        std::thread::spawn(move || {
                            let result = remote::parse(&saved)
                                .and_then(|origin| remote::probe(&origin).map(|status| (origin, status)))
                                .and_then(|(origin, status)| show_remote(&hr, &origin, None, &status));
                            let st = hr.state::<AppState>();
                            *lock(&st.busy) = None;
                            if let Err(e) = result {
                                *lock(&st.error) = Some(format!("저장된 연결 대상에 연결하지 못했어요. {e}"));
                                show_chooser(&hr);
                            }
                        });
                    }
                }
                "smoke-remote" => {
                    let (hr, url) = (h.clone(), smoke_url.unwrap_or_default());
                    let code = std::env::var("EASY_STUDY_DESKTOP_SMOKE_CODE").ok();
                    std::thread::spawn(move || {
                        if let Err(e) = open_remote(&hr, &url, code, false) {
                            *lock(&hr.state::<AppState>().error) = Some(e);
                            smoke_fail(&hr, 2, "remote connection");
                        }
                    });
                }
                _ => {} // the chooser is showing
            }
            if smoke.on() {
                let secs = std::env::var("EASY_STUDY_DESKTOP_SMOKE_TIMEOUT").ok().and_then(|s| s.parse().ok()).unwrap_or(120);
                let hs = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(secs));
                    smoke_verdict(&hs, 3, &format!("FAIL timeout after {secs} s"));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the easy-study app");

    // run_return, then exit with EXIT_CODE: the runtime ends the event loop with 0 whatever app.exit() said.
    app.run_return(|app, event| match event {
        // While an update replaces the app, nothing but its restart may end it (update.rs).
        RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } if label == MAIN && update::replacing(app) => {
            config::log(app, "close postponed: an update is being installed");
            api.prevent_close();
        }
        // Closing the main window ends the app (and the server) even when note windows are open.
        RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if label == MAIN => app.exit(0),
        RunEvent::ExitRequested { code, api, .. } => {
            if code != Some(RESTART_EXIT_CODE) && update::replacing(app) {
                config::log(app, "quit postponed: an update is being installed");
                api.prevent_exit();
            } else {
                app.state::<AppState>().quitting.store(true, SeqCst);
            }
        }
        RunEvent::Exit => {
            app.state::<AppState>().quitting.store(true, SeqCst);
            config::log(app, "exit: stopping the server");
            server::stop(app);
            proxy::stop(app);
            // A normal quit (or the restart after an update): the next launch connects as remembered.
            if config::load(app).auto_connect_pending {
                config::update(app, |c| c.auto_connect_pending = false);
            }
        }
        _ => {}
    });
    std::process::exit(EXIT_CODE.load(SeqCst));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ending_a_start_clears_the_chooser_busy_line() {
        let st = AppState::new(Smoke::Off);
        st.starting.store(true, SeqCst);
        *lock(&st.busy) = Some("이 컴퓨터에서 easy-study 서버를 시작하는 중…".into());
        st.start_ended();
        assert!(!st.starting.load(SeqCst));
        assert_eq!(*lock(&st.busy), None);
    }

    #[test]
    fn smoke_modes() {
        assert_eq!(Smoke::parse(""), Smoke::Off);
        assert_eq!(Smoke::parse("0"), Smoke::Off);
        assert_eq!(Smoke::parse("1"), Smoke::Direct);
        assert_eq!(Smoke::parse("chooser"), Smoke::Chooser);
        assert_eq!(Smoke::parse("chooser-local"), Smoke::ChooserLocal);
        assert_eq!(Smoke::parse("chooser-remote"), Smoke::ChooserRemote);
        assert!(!Smoke::Chooser.checks_page() && Smoke::Chooser.via_chooser());
        assert!(Smoke::Direct.checks_page() && !Smoke::Direct.via_chooser());
        assert!(Smoke::ChooserLocal.checks_page() && Smoke::ChooserRemote.via_chooser());
        assert!(!Smoke::Off.on() && Smoke::ChooserRemote.on());
    }

    #[test]
    fn chooser_error_needs_usable_controls() {
        assert!(chooser_shows_error(&serde_json::json!({ "kind": "error", "text": "x", "disabled": false })));
        // An error set while the chooser still shows "busy" with every control disabled is the stuck state.
        assert!(!chooser_shows_error(&serde_json::json!({ "kind": "busy", "text": "…", "disabled": true })));
        assert!(!chooser_shows_error(&serde_json::json!({ "kind": "error", "text": "x", "disabled": true })));
        assert!(!chooser_shows_error(&serde_json::Value::Null));
    }

    #[test]
    fn the_smoke_pdf_is_a_pdf() {
        assert!(SMOKE_PDF_BASE64.starts_with("JVBERi0")); // "%PDF-"
        assert_eq!(SMOKE_PDF_BASE64.len() % 4, 0);
        for hole in ["__INGEST__", "__PDF__", "__ASR__", "__RECORDER__", "__WRITE__"] {
            assert!(SMOKE_PROBE_JS.contains(hole), "{hole}");
        }
        // (That the probe never opens the microphone is checked by desktop.test.mjs over this file's text.)
    }

    #[test]
    fn log_lines_show_pages_without_their_query() {
        let login = Url::parse("http://127.0.0.1:5378/login?code=k7qm2-x9fda-3hz8w-p0rtc#x").unwrap();
        assert_eq!(without_query(&login), "http://127.0.0.1:5378/login");
        assert_eq!(without_query(&Url::parse("https://study-pc.tail1234.ts.net/?doc=abc").unwrap()), "https://study-pc.tail1234.ts.net/");
    }
}
