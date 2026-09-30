//! The pages' way to the shell and back (DESIGN §24), without IPC: pages served over http(s) never get Tauri's IPC
//! (capabilities/chooser.json), so
//! - the shell marks the main window's pages with a static object (INIT_SCRIPT: the app's version and OS) and pushes
//!   its state into them (push_state: serde_json through eval, never text put together from what a page said);
//! - a page asks for an action by navigating to `<its origin>/__easy-study-desktop/<action>`: the main window's
//!   navigation handler catches it (classify) and cancels the navigation. Actions carry no parameters and only work
//!   on the origin the window may show; what they can start is rate-limited (PageDialogs), and so are the log lines
//!   a page can cause.
//! - Before the shell restarts the app or navigates away from a page, busy_gate asks the page
//!   (window.__easyStudyBusy) and this computer's server (GET /api/desktop/busy): nothing that could lose recorded
//!   audio is interrupted, and the user decides about the rest.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::config::{self, lock};
use crate::i18n;
use crate::update::{self, UpdateState};
use crate::{server, share, AppState};

/// The reserved path. The server answers it with 204, so a navigation that is not caught leaves the page alone.
pub const PREFIX: &str = "/__easy-study-desktop/";

/// The static marker (main window, main frame only): the page knows it is inside the app, which version and OS, and
/// the shell's language (i18n.rs: the chooser speaks it from its first paint; a page may follow it or not).
/// __VERSION__, __OS__ and __LANG__ are replaced with JSON strings (init_script).
pub const INIT_SCRIPT: &str = "window.__EASY_STUDY_DESKTOP__ = Object.freeze({ v: 1, version: __VERSION__, os: __OS__, lang: __LANG__ });";

/// What the page is doing (null: a page without the hook, e.g. an older remote server's UI).
pub const BUSY_JS: &str = "JSON.stringify(typeof window.__easyStudyBusy === 'function' ? window.__easyStudyBusy() : null)";

/// Opens the page's own settings dialog (true), if it has one.
pub const OPEN_SETTINGS_JS: &str =
    "JSON.stringify(typeof window.__easyStudyOpenSettings === 'function' ? window.__easyStudyOpenSettings() === true : null)";

/// Lets the page go without its own "leave this page?" prompt (the user already agreed in the shell's dialog).
pub const ALLOW_LEAVE_JS: &str =
    "JSON.stringify(typeof window.__easyStudyAllowLeave === 'function' ? window.__easyStudyAllowLeave() : null)";

/// Whether the page's own code asked for this action just now (true; web/src/lib/desktop.ts desktopAction), or nobody
/// did (false: a link to the reserved path was followed); null: a page without the hook (a web client before 0.5.3).
/// __ACTION__ is replaced with the JSON string of one of Action's own names (asked_action_js), never a page's text.
pub const ASKED_ACTION_JS: &str =
    "JSON.stringify(typeof window.__easyStudyAskedAction === 'function' ? window.__easyStudyAskedAction(__ACTION__) === true : null)";

pub fn asked_action_js(action: Action) -> String {
    ASKED_ACTION_JS.replace("__ACTION__", &serde_json::Value::String(action.name().to_string()).to_string())
}

/// A page's own dialogs: at most one every REMOTE_GAP from another computer's page (one every LOCAL_GAP from this
/// computer's), and none from another computer's page after the user said no to one of its dialogs.
const REMOTE_GAP: Duration = Duration::from_secs(60);
const LOCAL_GAP: Duration = Duration::from_secs(3);
/// The release page a page opens in the browser (download kinds): at most once a minute.
const OPEN_GAP: Duration = Duration::from_secs(60);
/// Progress pushes.
const PUSH_GAP: Duration = Duration::from_millis(250);
/// Theme changes a page asks for.
const THEME_GAP: Duration = Duration::from_secs(1);
/// Log lines a page can cause, per kind and minute.
const LOG_LINES: u32 = 20;
/// How long the access code stays in the local page's pushed state after its share/reveal (the page holds an
/// HttpOnly session; the code, which lets any device in, is only there while the user looks at it).
const REVEAL_FOR: Duration = Duration::from_secs(60);
pub fn init_script(version: &str, os: &str, lang: &str) -> String {
    let json = |s: &str| serde_json::Value::String(s.to_string()).to_string();
    INIT_SCRIPT.replace("__VERSION__", &json(version)).replace("__OS__", &json(os)).replace("__LANG__", &json(lang))
}

// ---------------------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Choose,
    ForgetChoice,
    CheckUpdate,
    InstallUpdate,
    DismissUpdate,
    CancelUpdate,
    /// "system", "light" or "dark".
    Theme(&'static str),
    /// "다른 기기에서 접속 허용" on or off (share.rs; only this computer's own page).
    Share(bool),
    /// Show the access code in the pushed state for a while (only this computer's own page).
    ShareReveal,
    /// A new access code, every device logged out (only this computer's own page).
    ShareResetCode,
}

impl Action {
    fn parse(name: &str) -> Option<Action> {
        Some(match name {
            "choose" => Action::Choose,
            "forget-choice" => Action::ForgetChoice,
            "check-update" => Action::CheckUpdate,
            "install-update" => Action::InstallUpdate,
            "dismiss-update" => Action::DismissUpdate,
            "cancel-update" => Action::CancelUpdate,
            "theme/system" => Action::Theme("system"),
            "theme/light" => Action::Theme("light"),
            "theme/dark" => Action::Theme("dark"),
            "share/on" => Action::Share(true),
            "share/off" => Action::Share(false),
            "share/reveal" => Action::ShareReveal,
            "share/reset-code" => Action::ShareResetCode,
            _ => return None,
        })
    }

    /// The name in the URL (parse's inverse).
    fn name(self) -> &'static str {
        match self {
            Action::Choose => "choose",
            Action::ForgetChoice => "forget-choice",
            Action::CheckUpdate => "check-update",
            Action::InstallUpdate => "install-update",
            Action::DismissUpdate => "dismiss-update",
            Action::CancelUpdate => "cancel-update",
            Action::Theme("light") => "theme/light",
            Action::Theme("dark") => "theme/dark",
            Action::Theme(_) => "theme/system",
            Action::Share(true) => "share/on",
            Action::Share(false) => "share/off",
            Action::ShareReveal => "share/reveal",
            Action::ShareResetCode => "share/reset-code",
        }
    }
}

/// What the page says about an action that arrived (page_asked_for).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asked {
    /// Its own code asked (desktopAction).
    Yes,
    /// It has the hook and did not ask: a link to the reserved path was followed.
    No,
    /// No hook: an older web client (a remote server before 0.5.3).
    NoHook,
}

/// Asks the page (eval_json: never on the main thread) whether its own code asked for `action`. On macOS a
/// `target=_blank` link to the reserved path reaches the navigation handler like the page's own navigation (§19), and
/// a link in an answer must never act.
fn page_asked_for(app: &AppHandle, action: Action) -> Asked {
    match crate::eval_json(app, &asked_action_js(action)) {
        serde_json::Value::Bool(true) => Asked::Yes,
        serde_json::Value::Null => Asked::NoHook,
        _ => Asked::No,
    }
}

/// From a page without the hook, the actions that change something by themselves get a dialog (text, yes, no); the
/// others are reversible or rate-limited (theme/*, dismiss-update, check-update) or ask anyway (install-update, share/*).
fn unasked_confirm(action: Action) -> Option<(&'static str, &'static str, &'static str)> {
    let m = i18n::msg();
    Some(match action {
        Action::Choose => (m.page.confirm_choose, m.page.choose, m.common.cancel),
        Action::ForgetChoice => (m.page.confirm_forget, m.page.forget, m.common.cancel),
        Action::CancelUpdate => (m.page.confirm_cancel_download, m.page.cancel_download, m.page.keep_downloading),
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nav {
    /// A page of the allowed origin asks for this.
    Action(Action),
    /// The reserved path otherwise (another origin, not http(s), an unknown action): cancelled, never opened.
    Reserved,
    /// Anything else: the window's usual rules.
    Other,
}

/// The reserved path, on any origin.
pub fn is_reserved(url: &Url) -> bool {
    url.path().starts_with(PREFIX) || url.path() == PREFIX.trim_end_matches('/')
}

/// Sorts a navigation of the main window (`allowed_origin`: the origin it may show). The query is ignored.
pub fn classify(url: &Url, allowed_origin: Option<&str>) -> Nav {
    if !is_reserved(url) {
        return Nav::Other;
    }
    let origin = url.origin().ascii_serialization();
    if !matches!(url.scheme(), "http" | "https") || allowed_origin != Some(origin.as_str()) {
        return Nav::Reserved;
    }
    match url.path().strip_prefix(PREFIX).and_then(Action::parse) {
        Some(action) => Nav::Action(action),
        None => Nav::Reserved,
    }
}

/// This computer's server's origin (None in remote mode).
fn local_origin(app: &AppHandle) -> Option<String> {
    let url = lock(&app.state::<AppState>().server_url).clone()?;
    Url::parse(&url).ok().map(|u| crate::origin_of(&u))
}

pub fn is_local(app: &AppHandle, origin: &str) -> bool {
    local_origin(app).as_deref() == Some(origin)
}

/// A page action (on its own thread: dialogs and checks block). First the page says whether it asked for it.
pub fn on_action(app: &AppHandle, action: Action, origin: String) {
    let local = is_local(app, &origin);
    match page_asked_for(app, action) {
        Asked::Yes => {}
        Asked::No => {
            return log_limited(app, "page-unasked", &format!("{action:?} from {origin} ignored: the page did not ask for it (a link to the reserved path?)"));
        }
        Asked::NoHook => {
            if let Some((text, yes, no)) = unasked_confirm(action) {
                if !page_may_ask(app, &origin, local) {
                    return log_limited(app, "page-unasked", &format!("{action:?} from {origin} (no __easyStudyAskedAction) ignored: asked too recently, or refused"));
                }
                let ok = confirm(app, text, yes, no);
                page_asked(app, &origin, local, ok);
                if !ok {
                    return log_limited(app, "page-unasked", &format!("{action:?} from {origin} (no __easyStudyAskedAction): the user said no"));
                }
            }
        }
    }
    match action {
        // Like the menu. The page asked about its own work before (it is the only one that can lose anything).
        Action::Choose => crate::show_chooser(app),
        Action::ForgetChoice => forget_choice(app),
        Action::CheckUpdate => {
            update::check(app, update::How::Manual);
        }
        Action::InstallUpdate => {
            if page_may_ask(app, &origin, local) {
                update::request_install(app, update::Trigger::Page { origin, local });
            } else {
                log_limited(app, "page-install", &format!("install-update from {origin} ignored (asked too recently, or refused)"));
                push_state(app);
            }
        }
        Action::DismissUpdate => {
            lock(&app.state::<AppState>().update.state).dismissed = true;
            push_state(app);
        }
        Action::CancelUpdate => update::cancel(app),
        Action::Theme(theme) => page_theme(app, theme),
        // Sharing is this computer's server's business: another computer's page (or a relayed one) cannot touch it.
        // share/on and share/reveal go through a native dialog (share.rs, reveal_code): the page's own session
        // must not be enough to open this computer to the network or to read the code that lets any device in.
        Action::Share(on) if local => share::request(app, share::Change::Share(on), share::From::Page { origin }),
        Action::ShareResetCode if local => share::request(app, share::Change::ResetCode, share::From::Page { origin }),
        Action::ShareReveal if local => reveal_code(app, &origin),
        Action::Share(_) | Action::ShareResetCode | Action::ShareReveal => {
            log_limited(app, "page-share", &format!("{action:?} from {origin} ignored (not this computer's server)"));
            push_state(app);
        }
    }
}

/// share/reveal: once the user agreed in a native dialog (at most as often as the page may ask), the code goes into
/// the next pushes for REVEAL_FOR, then a push without it follows.
fn reveal_code(app: &AppHandle, origin: &str) {
    if !page_may_ask(app, origin, true) {
        log_limited(app, "page-share", &format!("share/reveal from {origin} ignored (asked too recently)"));
        return push_state(app);
    }
    // The user confirms in a dialog no page can draw before the code goes into the page's state.
    let m = i18n::msg();
    let ok = confirm(app, m.page.confirm_reveal, m.page.reveal, m.common.cancel);
    page_asked(app, origin, true, ok);
    if !ok {
        return push_state(app);
    }
    *lock(&app.state::<AppState>().bridge.reveal) = Some(Instant::now());
    push_state(app);
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FOR + Duration::from_millis(100));
        if lock(&h.state::<AppState>().bridge.reveal).is_some_and(|t| t.elapsed() >= REVEAL_FOR) {
            *lock(&h.state::<AppState>().bridge.reveal) = None;
            push_state(&h);
        }
    });
}

/// The access code for the pushed state: only while revealed (share/reveal) and only on a shared server.
fn revealed_code(app: &AppHandle) -> Option<String> {
    let revealed = lock(&app.state::<AppState>().bridge.reveal).is_some_and(|t| t.elapsed() < REVEAL_FOR);
    revealed.then(|| server::access_code(app)).flatten()
}

/// "system" | "light" | "dark": saved, applied to every window (the menus and title bars too), and pushed. Nothing
/// happens when it is the current theme.
pub fn set_theme(app: &AppHandle, theme: &str) {
    let stored = match theme {
        "light" | "dark" => theme,
        _ => "",
    };
    if config::load(app).theme == stored {
        return;
    }
    let cfg = config::update(app, |c| c.theme = stored.to_string());
    app.set_theme(config::theme(&cfg));
    log_limited(app, "theme", &format!("theme {}", if stored.is_empty() { "system" } else { stored }));
    push_state(app);
}

/// A page's theme/*: at most one change every THEME_GAP, the last one asked for wins (a page switching in a loop
/// would otherwise rewrite desktop.json and flip every window each time).
fn page_theme(app: &AppHandle, theme: &'static str) {
    let st = app.state::<AppState>();
    let Some(wait) = lock(&st.bridge.theme).ask(theme, Instant::now()) else { return };
    std::thread::sleep(wait);
    let newest = lock(&st.bridge.theme).take(Instant::now());
    if let Some(theme) = newest {
        set_theme(app, theme);
    }
}

/// The chooser comes first at the next launch. Nothing happens when it already does.
pub fn forget_choice(app: &AppHandle) {
    if config::load(app).mode.is_empty() {
        return;
    }
    config::update(app, |c| c.mode = String::new());
    config::log(app, "startup: the chooser comes first from now on");
    push_state(app);
}

// ---------------------------------------------------------------------------------------------------------
// Pushed state
// ---------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    /// "local" | "remote".
    kind: &'static str,
    origin: String,
    /// "auto": the remembered connection opens at launch; "ask": the chooser comes first.
    startup: &'static str,
}

/// "다른 기기에서 접속" of this computer's server (only pushed into its own page).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareState {
    /// The setting.
    on: bool,
    /// The local server runs shared right now (the setting applies at a start; an address list can be empty
    /// while it does, e.g. offline).
    running: bool,
    /// The addresses other devices can use while the server runs shared (empty otherwise).
    urls: Vec<String>,
    /// The access code, only for REVEAL_FOR after the page's share/reveal.
    code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageState {
    v: u8,
    theme: &'static str,
    connection: Connection,
    update: UpdateState,
    /// The version this launch was updated to (for a toast).
    just_updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share: Option<ShareState>,
}

#[derive(Default)]
pub struct Bridge {
    dialogs: Mutex<PageDialogs>,
    last_push: Mutex<Option<Instant>>,
    logs: Mutex<HashMap<&'static str, LogLimit>>,
    theme: Mutex<PageTheme>,
    /// When the local page last asked to see the access code (share/reveal).
    reveal: Mutex<Option<Instant>>,
}

/// Pushes the shell's state into the main window's page when it shows the allowed origin (never the chooser, which
/// asks get_state). Never blocks: it may run on any thread.
pub fn push_state(app: &AppHandle) {
    let st = app.state::<AppState>();
    let Some(origin) = lock(&st.page_origin).clone() else { return };
    if lock(&st.allowed_origin).as_deref() != Some(origin.as_str()) {
        return;
    }
    let Some(w) = crate::main_window(app) else { return };
    *lock(&st.bridge.last_push) = Some(Instant::now());
    let local = is_local(app, &origin);
    let cfg = config::load(app);
    let update = {
        let s = lock(&st.update.state);
        if local {
            s.clone()
        } else {
            s.for_remote()
        }
    };
    // Sharing only into this computer's own page: a remote or relayed page never learns the addresses or the code.
    let share = local.then(|| {
        let urls = lock(&st.share_urls).clone();
        ShareState { on: cfg.share, running: urls.is_some(), code: urls.is_some().then(|| revealed_code(app)).flatten(), urls: urls.unwrap_or_default() }
    });
    let state = PageState {
        v: 1,
        theme: match cfg.theme.as_str() {
            "light" => "light",
            "dark" => "dark",
            _ => "system",
        },
        connection: Connection {
            kind: if local { "local" } else { "remote" },
            // A relayed page (proxy.rs) is the remote server's: named as such, not by the relay's loopback origin.
            origin: crate::proxy::target_of(app, &origin).unwrap_or_else(|| origin.clone()),
            startup: if cfg.mode.is_empty() { "ask" } else { "auto" },
        },
        update,
        // Every push of this launch: the first page load can be replaced by a second one (macOS reports two when the
        // server was ready before the chooser), and a login screen may come first. The page toasts once per version.
        just_updated: lock(&st.update.just_updated).clone(),
        share,
    };
    let (Ok(origin), Ok(state)) = (serde_json::to_string(&origin), serde_json::to_string(&state)) else { return };
    // The origin check in the page: a navigation may have replaced it since.
    let _ = w.eval(format!(
        "(() => {{ if (location.origin !== {origin}) return; window.__easyStudyDesktopState = {state}; \
         window.dispatchEvent(new Event('easy-study-desktop')); }})()"
    ));
}

/// push_state at most every 250 ms (download progress; phase changes use push_state).
pub fn push_state_throttled(app: &AppHandle) {
    let recent = lock(&app.state::<AppState>().bridge.last_push).is_some_and(|t| t.elapsed() < PUSH_GAP);
    if !recent {
        push_state(app);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Limits on what a page can start
// ---------------------------------------------------------------------------------------------------------

#[derive(Default, Debug)]
pub struct PageDialogs {
    /// When the last dialog a page caused was closed.
    last: Option<Instant>,
    /// Origins whose dialog the user answered with no (or that were blocked): no more dialogs this session.
    refused: Vec<String>,
    last_open: Option<Instant>,
}

impl PageDialogs {
    /// Whether a page of `origin` may start something that shows a dialog now.
    pub fn may_ask(&self, origin: &str, local: bool, now: Instant) -> bool {
        if !local && self.refused.iter().any(|o| o == origin) {
            return false;
        }
        let gap = if local { LOCAL_GAP } else { REMOTE_GAP };
        self.last.is_none_or(|t| now.saturating_duration_since(t) >= gap)
    }

    /// A dialog a page caused was closed (`accepted`: the user went on).
    pub fn asked(&mut self, origin: &str, local: bool, accepted: bool, now: Instant) {
        self.last = Some(now);
        if !accepted && !local && !self.refused.iter().any(|o| o == origin) {
            self.refused.push(origin.to_string());
        }
    }

    /// Whether a page may open the release page in the browser now (and counts it).
    pub fn may_open(&mut self, now: Instant) -> bool {
        let ok = self.last_open.is_none_or(|t| now.saturating_duration_since(t) >= OPEN_GAP);
        if ok {
            self.last_open = Some(now);
        }
        ok
    }
}

pub fn page_may_ask(app: &AppHandle, origin: &str, local: bool) -> bool {
    lock(&app.state::<AppState>().bridge.dialogs).may_ask(origin, local, Instant::now())
}

pub fn page_asked(app: &AppHandle, origin: &str, local: bool, accepted: bool) {
    lock(&app.state::<AppState>().bridge.dialogs).asked(origin, local, accepted, Instant::now());
}

pub fn page_may_open(app: &AppHandle) -> bool {
    lock(&app.state::<AppState>().bridge.dialogs).may_open(Instant::now())
}

/// The theme changes pages ask for: one waits (the newest wins), then it is applied at least THEME_GAP after the last.
#[derive(Default, Debug)]
pub struct PageTheme {
    pending: Option<&'static str>,
    /// A thread waits to apply `pending`.
    waiting: bool,
    last: Option<Instant>,
}

impl PageTheme {
    /// Asks for `theme`: how long this caller waits before take(), or None when another caller already waits (it
    /// applies this one).
    pub fn ask(&mut self, theme: &'static str, now: Instant) -> Option<Duration> {
        self.pending = Some(theme);
        if self.waiting {
            return None;
        }
        self.waiting = true;
        Some(self.last.map_or(Duration::ZERO, |t| THEME_GAP.saturating_sub(now.saturating_duration_since(t))))
    }

    /// The theme to apply now (the newest asked for).
    pub fn take(&mut self, now: Instant) -> Option<&'static str> {
        self.waiting = false;
        self.last = Some(now);
        self.pending.take()
    }
}

/// Counts log lines of one kind per minute.
#[derive(Debug)]
pub struct LogLimit {
    since: Instant,
    lines: u32,
    dropped: u32,
}

impl LogLimit {
    /// (write this line, lines dropped in the minute before to mention first).
    pub fn allow(&mut self, now: Instant) -> (bool, u32) {
        let mut dropped = 0;
        if now.saturating_duration_since(self.since) >= Duration::from_secs(60) {
            dropped = std::mem::take(&mut self.dropped);
            (self.since, self.lines) = (now, 0);
        }
        self.lines += 1;
        if self.lines > LOG_LINES {
            self.dropped += 1;
            return (false, dropped);
        }
        (true, dropped)
    }
}

/// A shell.log line a page can cause again and again (reserved paths, blocked navigations, loaded pages): at most
/// LOG_LINES per kind and minute (the log is only rotated at launch).
pub fn log_limited(app: &AppHandle, kind: &'static str, msg: &str) {
    let st = app.state::<AppState>();
    let (write, dropped) = {
        let mut logs = lock(&st.bridge.logs);
        let now = Instant::now();
        logs.entry(kind).or_insert(LogLimit { since: now, lines: 0, dropped: 0 }).allow(now)
    };
    if dropped > 0 {
        config::log(app, &format!("({dropped} more \"{kind}\" lines left out)"));
    }
    if write {
        config::log(app, msg);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Busy check
// ---------------------------------------------------------------------------------------------------------

/// window.__easyStudyBusy() (untrusted: only the page itself can be hurt by a wrong answer).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageBusy {
    pub recording: bool,
    pub unsent_seconds: f64,
    pub finishing: u64,
    pub recording_uploads: u64,
    pub uploads: u64,
    pub answering: bool,
}

impl PageBusy {
    pub fn parse(v: &serde_json::Value) -> Option<PageBusy> {
        let o = v.as_object()?;
        let num = |k: &str| o.get(k).and_then(|v| v.as_f64()).filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.0);
        let flag = |k: &str| o.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        Some(PageBusy {
            recording: flag("recording"),
            unsent_seconds: num("unsentSeconds"),
            finishing: num("finishing") as u64,
            recording_uploads: num("recordingUploads") as u64,
            uploads: num("uploads") as u64,
            answering: flag("answering"),
        })
    }

    /// Audio that only the page has: recording, not sent yet, being finished or uploaded.
    pub fn holds_audio(&self) -> bool {
        self.recording || self.unsent_seconds > 0.0 || self.finishing > 0 || self.recording_uploads > 0
    }
}

/// GET /api/desktop/busy of this computer's server.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ServerBusy {
    /// A live recording that is not finished (the page that records may be gone or paused).
    pub recording: Option<LiveRecording>,
    pub transcriptions: u64,
    pub digests: u64,
    pub chat_turns: u64,
    pub model_downloads: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LiveRecording {
    pub doc: Option<String>,
    pub title: Option<String>,
}

impl ServerBusy {
    pub fn parse(v: &serde_json::Value) -> Option<ServerBusy> {
        let o = v.as_object()?;
        let count = |k: &str| o.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let text = |r: &serde_json::Value, k: &str| r.get(k).and_then(|v| v.as_str()).map(|s| s.chars().take(80).collect::<String>());
        let recording = o.get("recording").filter(|r| r.is_object()).map(|r| LiveRecording {
            doc: text(r, "docTitle"),
            title: text(r, "title"),
        });
        Some(ServerBusy {
            recording,
            transcriptions: count("transcriptions"),
            digests: count("digests"),
            chat_turns: count("chatTurns"),
            model_downloads: count("modelDownloads"),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PageAnswer {
    /// The window shows the chooser (or nothing): no page to ask.
    NotShown,
    /// A page that did not answer (no hook: an older remote UI; or it hung).
    NoAnswer,
    Busy(PageBusy),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerAnswer {
    NotRunning,
    NoAnswer,
    Busy(ServerBusy),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gate {
    Go,
    /// The user decides (the text lists what stops).
    Warn(String),
    /// Not now: audio could be lost.
    Block(String),
}

/// What the restart behind a busy check is for: the texts name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Restart {
    /// An update is installed and the app restarts (update.rs).
    Install,
    /// The local server restarts with another share setting or a new access code (share.rs).
    Share,
}

impl Restart {
    fn block_recording(self) -> &'static str {
        let busy = &i18n::msg().busy;
        match self {
            Restart::Install => busy.block_recording,
            Restart::Share => busy.block_recording_share,
        }
    }

    fn block_unsent(self) -> &'static str {
        let busy = &i18n::msg().busy;
        match self {
            Restart::Install => busy.block_unsent,
            Restart::Share => busy.block_unsent_share,
        }
    }

    fn warn_tail(self) -> &'static str {
        let busy = &i18n::msg().busy;
        match self {
            Restart::Install => busy.warn_install,
            Restart::Share => busy.warn_share,
        }
    }
}

/// Whether a restart may go on now. `page_asked`: the page started it and has asked the user about its own work
/// (answers, uploads) already; what could lose audio blocks whatever the page says.
pub fn decide_for(page: &PageAnswer, server: &ServerAnswer, page_asked: bool, restart: Restart) -> Gate {
    let busy = &i18n::msg().busy;
    let mut warn: Vec<String> = Vec::new();
    // The server counts the answer this page is making too (a page makes one at a time): named once, as the page's.
    let own_answer = matches!(page, PageAnswer::Busy(p) if p.answering);
    match page {
        PageAnswer::Busy(p) if p.recording => return Gate::Block(restart.block_recording().into()),
        PageAnswer::Busy(p) if p.holds_audio() => return Gate::Block(restart.block_unsent().into()),
        PageAnswer::Busy(p) if !page_asked => {
            if p.answering {
                warn.push(busy.answering.into());
            }
            if p.uploads > 0 {
                warn.push(busy.uploading.into());
            }
        }
        PageAnswer::Busy(_) | PageAnswer::NotShown => {}
        PageAnswer::NoAnswer => warn.push(busy.page_unknown.into()),
    }
    match server {
        ServerAnswer::Busy(s) => {
            // The server keeps a live recording across a restart (it can go on afterwards), and the recorder keeps
            // unsent audio in the page: a warning, not a block (a forgotten, paused recording would block forever).
            if let Some(r) = &s.recording {
                warn.push(match (&r.doc, &r.title) {
                    (Some(doc), Some(title)) => (busy.recording_named)(doc, title),
                    _ => busy.recording.into(),
                });
            }
            if s.transcriptions > 0 {
                warn.push((busy.transcribing)(s.transcriptions));
            }
            if s.digests > 0 {
                warn.push(busy.digesting.into());
            }
            let others = s.chat_turns.saturating_sub(own_answer as u64);
            if others > 0 {
                warn.push(if own_answer { (busy.answers_elsewhere)(others) } else { (busy.answers)(others) });
            }
            if s.model_downloads > 0 {
                warn.push(busy.model_download.into());
            }
        }
        ServerAnswer::NoAnswer => warn.push(busy.server_unknown.into()),
        ServerAnswer::NotRunning => {}
    }
    if warn.is_empty() {
        return Gate::Go;
    }
    let list: Vec<String> = warn.iter().map(|w| format!("• {w}")).collect();
    Gate::Warn(format!("{}\n\n{}", list.join("\n"), restart.warn_tail()))
}

/// The main window shows a page of the allowed origin (not the chooser).
fn shows_page(app: &AppHandle) -> bool {
    crate::main_window(app)
        .and_then(|w| w.url().ok())
        .is_some_and(|u| matches!(u.scheme(), "http" | "https") && crate::is_allowed_page(app, &u))
}

/// Asks the page (eval_json: never on the main thread).
pub fn page_answer(app: &AppHandle) -> PageAnswer {
    if !shows_page(app) {
        return PageAnswer::NotShown;
    }
    match PageBusy::parse(&crate::eval_json(app, BUSY_JS)) {
        Some(busy) => PageAnswer::Busy(busy),
        None => PageAnswer::NoAnswer,
    }
}

/// Asks this computer's server over loopback (no Origin header: its API guard lets it through). A shared server
/// wants a login like everyone else: the code from the library as a bearer (never a loopback bypass); without
/// one the 401 counts as no answer (a warning, never a block).
fn server_answer(app: &AppHandle) -> ServerAnswer {
    let st = app.state::<AppState>();
    let Some(base) = lock(&st.server_url).clone() else { return ServerAnswer::NotRunning };
    let Ok(url) = Url::parse(&format!("{base}/api/desktop/busy")) else { return ServerAnswer::NoAnswer };
    let bearer = lock(&st.share_urls).is_some().then(|| server::access_code(app)).flatten().map(|code| format!("Bearer {code}"));
    let headers: Vec<(&str, &str)> = bearer.iter().map(|b| ("Authorization", b.as_str())).collect();
    let res = match crate::remote::get_with(&url, &headers) {
        Ok(res) if res.status == 200 => res,
        Ok(res) => {
            config::log(app, &format!("busy check: the server answered HTTP {}", res.status));
            return ServerAnswer::NoAnswer;
        }
        Err(e) => {
            config::log(app, &format!("busy check: {e}"));
            return ServerAnswer::NoAnswer;
        }
    };
    let json = match (res.body.find('{'), res.body.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str::<serde_json::Value>(&res.body[a..=b]).ok(),
        _ => None,
    };
    json.as_ref().and_then(ServerBusy::parse).map_or(ServerAnswer::NoAnswer, ServerAnswer::Busy)
}

/// busy_gate_for an install (update.rs).
pub fn busy_gate(app: &AppHandle, page_asked: bool) -> Gate {
    busy_gate_for(app, page_asked, Restart::Install)
}

/// decide_for() with the page's and the server's answers. Blocks up to ~20 s: never on the main thread.
pub fn busy_gate_for(app: &AppHandle, page_asked: bool, restart: Restart) -> Gate {
    let page = page_answer(app);
    let server = server_answer(app);
    let gate = decide_for(&page, &server, page_asked, restart);
    config::log(app, &format!("busy check ({restart:?}): {gate:?} (page {page:?}; server {server:?})"));
    gate
}

/// Menu "설정…": the page's settings dialog opened. Worker threads.
pub fn open_page_settings(app: &AppHandle) -> bool {
    shows_page(app) && crate::eval_json(app, OPEN_SETTINGS_JS) == serde_json::Value::Bool(true)
}

/// The page may be left without its own prompt (after the user agreed in a dialog of the shell). Worker threads.
pub fn allow_leave(app: &AppHandle) {
    if shows_page(app) {
        crate::eval_json(app, ALLOW_LEAVE_JS);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Native dialogs (a page cannot draw or click these). Blocking: worker threads only.
// ---------------------------------------------------------------------------------------------------------

fn message(app: &AppHandle, text: &str) -> tauri_plugin_dialog::MessageDialogBuilder<tauri::Wry> {
    let mut dialog = app.dialog().message(text).title("easy-study");
    if let Some(w) = crate::main_window(app) {
        dialog = dialog.parent(&w);
    }
    dialog
}

/// Yes (`ok`) or no (`cancel`).
pub fn confirm(app: &AppHandle, text: &str, ok: &str, cancel: &str) -> bool {
    message(app, text)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.to_string(), cancel.to_string()))
        .blocking_show()
}

/// A message with an OK button.
pub fn tell(app: &AppHandle, text: &str) {
    let ok = i18n::msg().common.ok;
    let _ = message(app, text).kind(MessageDialogKind::Info).buttons(MessageDialogButtons::OkCustom(ok.into())).blocking_show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn navigations_are_sorted() {
        let here = Some("http://127.0.0.1:5351");
        let at = |s: &str| classify(&url(s), here);
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/choose"), Nav::Action(Action::Choose));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/install-update?x=1#y"), Nav::Action(Action::InstallUpdate));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/forget-choice"), Nav::Action(Action::ForgetChoice));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/check-update"), Nav::Action(Action::CheckUpdate));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/dismiss-update"), Nav::Action(Action::DismissUpdate));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/cancel-update"), Nav::Action(Action::CancelUpdate));
        for theme in ["system", "light", "dark"] {
            assert_eq!(at(&format!("http://127.0.0.1:5351/__easy-study-desktop/theme/{theme}")), Nav::Action(Action::Theme(theme)));
        }
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/share/on"), Nav::Action(Action::Share(true)));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/share/off"), Nav::Action(Action::Share(false)));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/share/reveal"), Nav::Action(Action::ShareReveal));
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop/share/reset-code"), Nav::Action(Action::ShareResetCode));
        // Unknown actions and theme values, and near misses of the path: never acted on.
        for bad in ["theme/blue", "theme/", "theme", "choose/", "Choose", "install-update/now", "", "share/", "share", "share/ON", "share/true", "share/reset"] {
            assert_eq!(at(&format!("http://127.0.0.1:5351/__easy-study-desktop/{bad}")), Nav::Reserved, "{bad}");
        }
        assert_eq!(at("http://127.0.0.1:5351/__easy-study-desktop"), Nav::Reserved);
        // The prefix on another origin (a link, a subframe, another port): cancelled, never opened in the browser.
        assert_eq!(at("http://127.0.0.1:5352/__easy-study-desktop/choose"), Nav::Reserved);
        assert_eq!(at("https://example.com/__easy-study-desktop/install-update"), Nav::Reserved);
        assert_eq!(classify(&url("http://127.0.0.1:5351/__easy-study-desktop/choose"), None), Nav::Reserved);
        assert_eq!(at("tauri://localhost/__easy-study-desktop/choose"), Nav::Reserved);
        // Everything else keeps the window's rules: the chooser, the server's pages, other sites.
        assert_eq!(at("tauri://localhost/index.html"), Nav::Other);
        assert_eq!(at("http://tauri.localhost/index.html"), Nav::Other);
        assert_eq!(at("http://127.0.0.1:5351/api/docs"), Nav::Other);
        assert_eq!(at("http://127.0.0.1:5351/x/__easy-study-desktop/choose"), Nav::Other);
        assert_eq!(at("https://github.com/Wooangha/easy-study-releases/releases/latest"), Nav::Other);
        assert!(is_reserved(&url("https://example.com/__easy-study-desktop/whatever")));
        assert!(!is_reserved(&url("https://example.com/__easy-study-desktopx")));
    }

    #[test]
    fn action_names_round_trip_and_the_page_is_asked_with_them() {
        let all = [
            Action::Choose,
            Action::ForgetChoice,
            Action::CheckUpdate,
            Action::InstallUpdate,
            Action::DismissUpdate,
            Action::CancelUpdate,
            Action::Theme("system"),
            Action::Theme("light"),
            Action::Theme("dark"),
            Action::Share(true),
            Action::Share(false),
            Action::ShareReveal,
            Action::ShareResetCode,
        ];
        for a in all {
            assert_eq!(Action::parse(a.name()), Some(a), "{a:?}");
            assert_eq!(classify(&url(&format!("http://127.0.0.1:5351{PREFIX}{}", a.name())), Some("http://127.0.0.1:5351")), Nav::Action(a));
        }
        assert_eq!(
            asked_action_js(Action::Theme("dark")),
            "JSON.stringify(typeof window.__easyStudyAskedAction === 'function' ? window.__easyStudyAskedAction(\"theme/dark\") === true : null)"
        );
        // A page without the hook: only the actions that change something by themselves get a dialog.
        for a in [Action::Choose, Action::ForgetChoice, Action::CancelUpdate] {
            assert!(unasked_confirm(a).is_some(), "{a:?}");
        }
        for a in [Action::CheckUpdate, Action::InstallUpdate, Action::DismissUpdate, Action::Theme("dark"), Action::Share(true), Action::ShareReveal, Action::ShareResetCode] {
            assert!(unasked_confirm(a).is_none(), "{a:?}");
        }
    }

    #[test]
    fn the_marker_is_static_and_quoted() {
        let script = init_script("0.5.0", "macos", "ko");
        assert_eq!(script, r#"window.__EASY_STUDY_DESKTOP__ = Object.freeze({ v: 1, version: "0.5.0", os: "macos", lang: "ko" });"#);
        assert!(init_script("1\"; alert(1); \"", "linux", "en").contains(r#"version: "1\"; alert(1); \"""#));
        assert!(init_script("0.5.0", "linux", "en").ends_with(r#"lang: "en" });"#));
    }

    fn page(v: serde_json::Value) -> PageAnswer {
        PageAnswer::Busy(PageBusy::parse(&v).unwrap())
    }

    fn server(v: serde_json::Value) -> ServerAnswer {
        ServerAnswer::Busy(ServerBusy::parse(&v).unwrap())
    }

    /// The install's decision (update.rs busy_gate).
    fn decide(page: &PageAnswer, server: &ServerAnswer, page_asked: bool) -> Gate {
        decide_for(page, server, page_asked, Restart::Install)
    }

    #[test]
    fn busy_decisions() {
        let idle_page = page(json!({ "recording": false, "unsentSeconds": 0, "finishing": 0, "recordingUploads": 0, "uploads": 0, "answering": false }));
        let idle_server = server(json!({ "recording": null, "transcriptions": 0, "digests": 0, "chatTurns": 0, "modelDownloads": 0 }));
        assert_eq!(decide(&idle_page, &idle_server, false), Gate::Go);
        assert_eq!(decide(&PageAnswer::NotShown, &ServerAnswer::NotRunning, false), Gate::Go);
        assert_eq!(decide(&idle_page, &ServerAnswer::NotRunning, true), Gate::Go);

        // Audio only the page has: blocked, whoever asked and whatever the server says.
        for p in [json!({ "recording": true }), json!({ "unsentSeconds": 3.5 }), json!({ "finishing": 1 }), json!({ "recordingUploads": 2 })] {
            for asked in [false, true] {
                assert!(matches!(decide(&page(p.clone()), &idle_server, asked), Gate::Block(_)), "{p} {asked}");
            }
        }
        let busy = &i18n::msg().busy;
        assert_eq!(decide(&page(json!({ "recording": true })), &ServerAnswer::NotRunning, false), Gate::Block(busy.block_recording.into()));

        // The page's own work: a warning, unless the page asked the user itself.
        let answering = page(json!({ "answering": true, "uploads": 1 }));
        let Gate::Warn(text) = decide(&answering, &idle_server, false) else { panic!() };
        assert!(text.contains("답변을 만드는 중") && text.contains("파일을 올리는 중"), "{text}");
        assert_eq!(decide(&answering, &idle_server, true), Gate::Go);

        // A page that does not answer (an older remote UI), or a server that does not: the user decides.
        assert!(matches!(decide(&PageAnswer::NoAnswer, &ServerAnswer::NotRunning, true), Gate::Warn(_)));
        assert!(matches!(decide(&PageAnswer::NotShown, &ServerAnswer::NoAnswer, false), Gate::Warn(_)));
        assert_eq!(PageBusy::parse(&serde_json::Value::Null), None);
        assert_eq!(PageBusy::parse(&json!("busy")), None);

        // A live recording only the server knows (a closed tab, a paused one): named, a warning, not a block.
        let live = server(json!({ "recording": { "id": "r1", "docId": "d1", "status": "paused", "docTitle": "운영체제 3주차", "title": "월요일 강의" } }));
        let Gate::Warn(text) = decide(&PageAnswer::NotShown, &live, false) else { panic!() };
        assert!(text.contains("‘운영체제 3주차’의 ‘월요일 강의’ 녹음이 아직 끝나지 않았어요"), "{text}");
        let unnamed = server(json!({ "recording": { "id": "r1", "docId": "d1", "status": "recording" } }));
        assert!(matches!(decide(&idle_page, &unnamed, true), Gate::Warn(t) if t.contains("끝나지 않은 녹음")));
        let work = server(json!({ "transcriptions": 2, "digests": 1, "chatTurns": 1, "modelDownloads": 1 }));
        let Gate::Warn(text) = decide(&PageAnswer::NotShown, &work, false) else { panic!() };
        for part in ["녹음 2개를 받아쓰는", "강의 정리", "답변 1개", "음성 인식 모델"] {
            assert!(text.contains(part), "{part}: {text}");
        }
        // The page's own answer is one of the server's chat turns: not warned about twice.
        let one_turn = server(json!({ "chatTurns": 1 }));
        let answering_only = page(json!({ "answering": true }));
        assert_eq!(decide(&answering_only, &one_turn, true), Gate::Go);
        let Gate::Warn(text) = decide(&answering_only, &one_turn, false) else { panic!() };
        assert!(text.contains("답변을 만드는 중") && !text.contains("답변 1개"), "{text}");
        let Gate::Warn(text) = decide(&answering_only, &server(json!({ "chatTurns": 3 })), true) else { panic!() };
        assert!(text.contains("다른 창에서 답변 2개를 만드는 중이에요."), "{text}");
        let Gate::Warn(text) = decide(&idle_page, &one_turn, true) else { panic!() };
        assert!(text.contains("• 답변 1개를 만드는 중이에요."), "{text}");
        // Garbage in the answers counts as nothing (only the page itself can be hurt by lying).
        assert_eq!(PageBusy::parse(&json!({ "recording": "yes", "unsentSeconds": -4, "uploads": "x" })), Some(PageBusy::default()));
    }

    #[test]
    fn the_share_restart_has_its_own_texts() {
        let idle_server = server(json!({}));
        let recording = page(json!({ "recording": true }));
        let busy = &i18n::msg().busy;
        assert_eq!(decide_for(&recording, &idle_server, true, Restart::Share), Gate::Block(busy.block_recording_share.into()));
        assert_eq!(decide_for(&page(json!({ "unsentSeconds": 2 })), &idle_server, false, Restart::Share), Gate::Block(busy.block_unsent_share.into()));
        assert!(busy.block_recording_share.contains("다시 바꿔") && !busy.block_recording_share.contains("설치"));
        let Gate::Warn(text) = decide_for(&PageAnswer::NotShown, &server(json!({ "chatTurns": 1 })), false, Restart::Share) else { panic!() };
        assert!(text.ends_with("그래도 서버를 다시 시작할까요?") && !text.contains("설치"), "{text}");
        let Gate::Warn(text) = decide_for(&PageAnswer::NotShown, &server(json!({ "chatTurns": 1 })), false, Restart::Install) else { panic!() };
        assert!(text.ends_with("그래도 설치하고 다시 시작할까요?"), "{text}");
        // The install's wrappers keep the install texts.
        assert_eq!(decide(&recording, &idle_server, false), Gate::Block(busy.block_recording.into()));
        assert_eq!(decide_for(&PageAnswer::NotShown, &ServerAnswer::NotRunning, false, Restart::Share), Gate::Go);
    }

    #[test]
    fn busy_texts_and_dialogs_speak_the_shells_language() {
        i18n::with_lang(i18n::Lang::En, || {
            let work = server(json!({ "recording": { "docTitle": "OS week 3", "title": "Monday" }, "transcriptions": 1, "chatTurns": 3 }));
            let Gate::Warn(text) = decide(&page(json!({ "answering": true })), &work, false) else { panic!() };
            assert_eq!(
                text,
                "• Writing an answer.\n• The recording ‘Monday’ in ‘OS week 3’ isn't finished yet (you can continue it after the restart).\n\
                 • Transcribing 1 recording.\n• Writing 2 answers in other windows.\n\nRestarting stops this work. Install and restart anyway?"
            );
            let recording = page(json!({ "recording": true }));
            assert_eq!(
                decide_for(&recording, &server(json!({})), true, Restart::Share),
                Gate::Block("A lecture is being recorded. Try again after the recording ends.".into())
            );
            assert_eq!(
                unasked_confirm(Action::CancelUpdate),
                Some(("Cancel downloading the new version?\n\nThe page you're viewing asked for this.", "Cancel download", "Keep downloading"))
            );
            assert_eq!(unasked_confirm(Action::Choose).map(|(_, yes, no)| (yes, no)), Some(("Go back", "Cancel")));
        });
        // Korean again outside (the language is per thread in tests).
        assert_eq!(unasked_confirm(Action::Choose).map(|(_, yes, _)| yes), Some("돌아가기"));
    }

    #[test]
    fn page_dialogs_cool_down() {
        let t0 = Instant::now();
        let mut d = PageDialogs::default();
        let (remote, other) = ("http://192.168.0.10:5180", "http://192.168.0.11:5180");
        assert!(d.may_ask(remote, false, t0));
        d.asked(remote, false, true, t0);
        // Another dialog from any page only after the gap.
        assert!(!d.may_ask(remote, false, t0 + Duration::from_secs(59)));
        assert!(!d.may_ask(other, false, t0 + Duration::from_secs(30)));
        assert!(d.may_ask(remote, false, t0 + Duration::from_secs(60)));
        // This computer's page: a short gap only.
        assert!(!d.may_ask("http://127.0.0.1:5351", true, t0 + Duration::from_secs(1)));
        assert!(d.may_ask("http://127.0.0.1:5351", true, t0 + Duration::from_secs(3)));
        // Said no once: that remote page gets no more dialogs this session; others and the local page still do.
        d.asked(remote, false, false, t0 + Duration::from_secs(100));
        assert!(!d.may_ask(remote, false, t0 + Duration::from_secs(10_000)));
        assert!(d.may_ask(other, false, t0 + Duration::from_secs(10_000)));
        d.asked("http://127.0.0.1:5351", true, false, t0 + Duration::from_secs(10_000));
        assert!(d.may_ask("http://127.0.0.1:5351", true, t0 + Duration::from_secs(10_010)));
        // The release page: once a minute.
        assert!(d.may_open(t0));
        assert!(!d.may_open(t0 + Duration::from_secs(10)));
        assert!(d.may_open(t0 + Duration::from_secs(61)));
    }

    #[test]
    fn page_theme_changes_are_spaced_and_the_last_wins() {
        let t0 = Instant::now();
        let mut t = PageTheme::default();
        // The first one goes at once.
        assert_eq!(t.ask("dark", t0), Some(Duration::ZERO));
        assert_eq!(t.take(t0), Some("dark"));
        // Right after it: waits for the rest of the gap; asks meanwhile only replace what it will apply.
        assert_eq!(t.ask("light", t0 + Duration::from_millis(200)), Some(Duration::from_millis(800)));
        assert_eq!(t.ask("dark", t0 + Duration::from_millis(300)), None);
        assert_eq!(t.ask("system", t0 + Duration::from_millis(400)), None);
        assert_eq!(t.take(t0 + Duration::from_secs(1)), Some("system"));
        // Later on: at once again.
        assert_eq!(t.ask("light", t0 + Duration::from_secs(5)), Some(Duration::ZERO));
        assert_eq!(t.take(t0 + Duration::from_secs(5)), Some("light"));
    }

    #[test]
    fn page_caused_log_lines_are_limited() {
        let t0 = Instant::now();
        let mut limit = LogLimit { since: t0, lines: 0, dropped: 0 };
        let written = (0..100).filter(|_| limit.allow(t0 + Duration::from_secs(1)).0).count();
        assert_eq!(written, LOG_LINES as usize);
        // The next minute starts with a note on how many were left out.
        assert_eq!(limit.allow(t0 + Duration::from_secs(61)), (true, 80));
        assert_eq!(limit.allow(t0 + Duration::from_secs(62)), (true, 0));
    }
}
