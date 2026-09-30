//! In-app updates (DESIGN §24). The shell checks and installs with tauri-plugin-updater; the chooser (get_state) and
//! the pages (bridge::push_state) only show the state and ask for actions.
//! - Only the Update the shell fetched itself from the compiled-in https endpoint is installed: minisign-verified
//!   with the compiled-in public key, bound to its version (requireSignedVersion), newer than this build, and signed
//!   for this platform's file (the trusted comment's `file:`).
//! - Checks: 15 s after launch, then every 6 hours, unless turned off (never in smoke runs or debug builds). A manual
//!   check (chooser, menu, page) runs at most every 30 s. Automatic failures stay silent (lastError).
//! - An install runs on a worker thread, never while a recording could lose audio (bridge::busy_gate), stops the
//!   local server first, and the app cannot quit while its files are replaced. deb, rpm and Arch installs only
//!   check (through the AppImage's key) and link to the release page.
//! - Every error a page or dialog shows is one of the fixed texts of i18n.rs (`Update`, in the shell's language): raw
//!   errors (paths, user names) only go to shell.log.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use crate::bridge::{self, Gate};
use crate::config::{self, lock};
use crate::{i18n, AppState};

pub const RELEASES_URL: &str = "https://github.com/Wooangha/easy-study-releases/releases";
/// latest.json: the whole request.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// Every request, the download too (reqwest's read timeout is per read: a slow download goes on, a dead one ends).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// The download is dropped when no data came for this long (a laptop that slept, a Wi-Fi switch).
const STALL: Duration = Duration::from_secs(90);
const MANUAL_EVERY: Duration = Duration::from_secs(30);
const FIRST_CHECK: Duration = Duration::from_secs(15);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const NOTES_MAX: usize = 2000;

// ---------------------------------------------------------------------------------------------------------
// State (the same DTO goes to the chooser and, for this computer's server, to the page)
// ---------------------------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Latest,
    Available,
    Downloading,
    Downloaded,
    Installing,
    Error,
}

/// How this copy of the app gets a new version.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Install {
    InApp,
    /// From the release page (packages, a translocated app, a dev build).
    Download,
    #[default]
    None,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    App,
    Nsis,
    Appimage,
    Deb,
    Rpm,
    Arch,
    #[default]
    None,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: Phase,
    /// This build's version.
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// latest.json's notes (not signed: plain text, shown as text only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    pub release_url: String,
    pub received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub install: Install,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// Automatic checks are on.
    pub auto: bool,
    /// The page's banner was closed (until the next launch).
    pub dismissed: bool,
    /// The last failed check (automatic ones fail silently), for the settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<String>,
}

impl UpdateState {
    /// The chooser's "in progress" line while installing (every control waits; it outlives server::stop, which
    /// clears the shell's own busy line).
    pub fn busy_line(&self) -> Option<String> {
        (self.phase == Phase::Installing).then(|| (i18n::msg().update.installing)(self.version.as_deref().unwrap_or_default()))
    }

    /// What a page of another computer's server gets: no notes, dates or check history. The texts that remain are
    /// the fixed ones (i18n.rs), never an error's own text.
    pub fn for_remote(&self) -> UpdateState {
        UpdateState { notes: None, date: None, checked_at: None, last_error: None, last_error_at: None, ..self.clone() }
    }
}

/// The Update the last check found, and its verified bytes once downloaded (with their version: install checks they
/// belong to this Update).
struct Held {
    update: Update,
    bytes: Option<(String, Vec<u8>)>,
}

#[derive(Default)]
pub struct Updates {
    pub state: Mutex<UpdateState>,
    held: Mutex<Option<Held>>,
    /// An install flow runs (one at a time).
    flow: AtomicBool,
    /// install() is replacing the app: the app must not quit now (only restart).
    replacing: AtomicBool,
    /// SIGTERM waited long enough: quit anyway.
    force_quit: AtomicBool,
    checking: AtomicBool,
    cancel: AtomicBool,
    last_manual: Mutex<Option<Instant>>,
    /// The version this build was updated to at the last launch, for the page's toast (pushed for the whole launch:
    /// the first page load may be replaced by another; the page toasts once per version).
    pub just_updated: Mutex<Option<String>>,
    /// The update of the last launch did not take (setup): the notice outlives failed automatic checks.
    did_not_take: Mutex<Option<String>>,
    /// The menu item "업데이트 확인…" (its text names a found version).
    pub menu: Mutex<Option<MenuItem<Wry>>>,
}

/// Clears an AtomicBool when dropped: every return path of a flow gives the lock back.
struct Flag<'a>(&'a AtomicBool);

impl<'a> Flag<'a> {
    fn take(flag: &'a AtomicBool) -> Option<Flag<'a>> {
        (!flag.swap(true, SeqCst)).then_some(Flag(flag))
    }
}

impl Drop for Flag<'_> {
    fn drop(&mut self) {
        self.0.store(false, SeqCst);
    }
}

fn updates(app: &AppHandle) -> &Updates {
    &app.state::<AppState>().inner().update
}

fn now_rfc3339() -> Option<String> {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).ok()
}

pub fn release_url(version: Option<&str>) -> String {
    match version {
        Some(v) => format!("{RELEASES_URL}/tag/v{v}"),
        None => format!("{RELEASES_URL}/latest"),
    }
}

fn plain_notes(notes: &str) -> Option<String> {
    let notes = notes.trim();
    (!notes.is_empty()).then(|| notes.chars().take(NOTES_MAX).collect::<String>().trim_end().to_string())
}

// ---------------------------------------------------------------------------------------------------------
// How this copy can be updated
// ---------------------------------------------------------------------------------------------------------

/// (kind, install, reason) for this copy of the app. Pure: the caller passes the facts (the OS, the bundle type the
/// bundler wrote into the binary, $APPIMAGE, the executable's path, an Arch package marker).
pub fn install_kind(
    os: &str,
    bundle: Option<BundleType>,
    appimage: Option<&Path>,
    exe: &Path,
    arch_package: bool,
) -> (Kind, Install, Option<&'static str>) {
    let u = &i18n::msg().update;
    match os {
        "macos" => {
            // bundle_type() says App for every macOS build, `cargo run` too: only a real bundle counts (the plugin
            // would otherwise replace target/debug).
            if !in_app_bundle(exe) {
                return (Kind::None, Install::None, None);
            }
            let path = exe.to_string_lossy();
            if path.contains("/AppTranslocation/") || path.starts_with("/Volumes/") {
                (Kind::App, Install::Download, Some(u.reason_move_app))
            } else {
                (Kind::App, Install::InApp, None)
            }
        }
        "windows" => match bundle {
            Some(BundleType::Nsis) => (Kind::Nsis, Install::InApp, None),
            None => (Kind::None, Install::None, None),
            Some(_) => (Kind::None, Install::Download, Some(u.reason_installer)),
        },
        "linux" => match bundle {
            Some(BundleType::AppImage) if appimage.is_some_and(|p| !p.as_os_str().is_empty()) => (Kind::Appimage, Install::InApp, None),
            // An extracted AppImage (squashfs-root, as in CI): there is no file to replace.
            Some(BundleType::AppImage) => (Kind::Appimage, Install::Download, Some(u.reason_extracted)),
            // The Arch package repackages the .deb, so its binary says Deb.
            Some(BundleType::Deb) if arch_package => (Kind::Arch, Install::Download, Some(u.reason_arch)),
            Some(BundleType::Deb) => (Kind::Deb, Install::Download, Some(u.reason_deb)),
            Some(BundleType::Rpm) => (Kind::Rpm, Install::Download, Some(u.reason_rpm)),
            _ => (Kind::None, Install::None, None),
        },
        _ => (Kind::None, Install::None, None),
    }
}

/// `…/<name>.app/Contents/MacOS/<binary>`.
fn in_app_bundle(exe: &Path) -> bool {
    let mut up = exe.ancestors().skip(1).map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    up.next().as_deref() == Some("MacOS") && up.next().as_deref() == Some("Contents") && up.next().is_some_and(|n| n.ends_with(".app"))
}

/// The Arch package (easy-study-bin) is installed here.
fn arch_package() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let pacman = std::fs::read_dir("/var/lib/pacman/local")
        .map(|dir| dir.flatten().any(|e| e.file_name().to_string_lossy().starts_with("easy-study-bin-")))
        .unwrap_or(false);
    pacman || Path::new("/etc/arch-release").exists()
}

/// The end of the updater file's name for this build (the release's asset names).
pub fn expected_file_suffix(os: &str, arch: &str, kind: Kind) -> Option<&'static str> {
    match (os, arch, kind) {
        ("macos", "aarch64", Kind::App) => Some("_aarch64.app.tar.gz"),
        ("macos", "x86_64", Kind::App) => Some("_x64.app.tar.gz"),
        ("windows", "x86_64", Kind::Nsis) => Some("_x64-setup.exe"),
        ("linux", "x86_64", Kind::Appimage) => Some("_amd64.AppImage"),
        ("linux", "aarch64", Kind::Appimage) => Some("_aarch64.AppImage"),
        _ => None,
    }
}

/// `file:` and `version:` of a signature's trusted comment (`signature`: the .sig text, base64). The plugin checks
/// the version but not the file; Update::download() has verified the signature, which covers the trusted comment.
/// Decoded by the verifier's own code (minisign-verify, the plugin's version): the trusted comment is the third line
/// only, while the first (untrusted) one may say anything, "trusted comment: …" too.
pub fn signed_file(signature: &str) -> Option<(String, String)> {
    let text = base64::engine::general_purpose::STANDARD.decode(signature.trim()).ok()?;
    let text = String::from_utf8(text).ok()?;
    let decoded = minisign_verify::Signature::decode(&text).ok()?;
    let comment = decoded.trusted_comment();
    let field = |key: &str| comment.split('\t').find_map(|f| f.strip_prefix(key)).map(str::to_string);
    Some((field("file:")?, field("version:")?))
}

/// The signature was made for this platform's file of `version` (an x64 app on an arm Mac, an amd64 AppImage on
/// arm Linux would carry a valid signature too).
pub fn signed_for(signature: &str, suffix: &str, version: &str) -> bool {
    let same = |a: &str, b: &str| match (semver::Version::parse(a.trim_start_matches('v')), semver::Version::parse(b.trim_start_matches('v'))) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    };
    signed_file(signature).is_some_and(|(file, signed)| file.ends_with(suffix) && same(&signed, version))
}

/// The fixed text for an updater error (`os`: std::env::consts::OS).
pub fn describe(err: &Error, os: &str) -> &'static str {
    let u = &i18n::msg().update;
    let permission = match os {
        "macos" => u.mac_permission,
        "linux" => u.appimage_permission,
        _ => u.installer,
    };
    match err {
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => u.no_file,
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => u.signature,
        Error::InvalidUpdaterFormat | Error::BinaryNotFoundInArchive => u.wrong_file,
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => u.network,
        Error::AuthenticationFailed => permission,
        Error::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => permission,
        // Windows: ShellExecuteW could not start the installer (quarantined, blocked by policy).
        Error::Io(_) if os == "windows" => u.installer,
        _ => u.other,
    }
}

// ---------------------------------------------------------------------------------------------------------
// Setup and schedule
// ---------------------------------------------------------------------------------------------------------

/// Linux: which of SSL_CERT_FILE / SSL_CERT_DIR the user had set when the app started.
#[cfg(target_os = "linux")]
static SSL_ENV_AT_LAUNCH: std::sync::OnceLock<[bool; 2]> = std::sync::OnceLock::new();
#[cfg(target_os = "linux")]
const SSL_ENV: [&str; 2] = ["SSL_CERT_FILE", "SSL_CERT_DIR"];

/// Linux, at the very top of main() before any thread starts: the updater's check() sets SSL_CERT_FILE and
/// SSL_CERT_DIR to Debian's paths when they are unset (from a worker thread, for good; on Fedora those paths do not
/// exist). They are set here to what OpenSSL finds on this system instead, so the updater leaves them alone, and
/// child processes get them removed again (ssl_env_not_from_user).
pub fn keep_ssl_env() {
    #[cfg(target_os = "linux")]
    {
        let had = SSL_ENV.map(|name| std::env::var_os(name).is_some());
        let _ = SSL_ENV_AT_LAUNCH.set(had);
        let probe = openssl_probe::probe();
        if !had[0] {
            if let Some(file) = probe.cert_file.filter(|p| p.is_file()) {
                std::env::set_var(SSL_ENV[0], file);
            }
        }
        if !had[1] {
            if let Some(dir) = probe.cert_dir.into_iter().find(|p| p.is_dir()) {
                std::env::set_var(SSL_ENV[1], dir);
            }
        }
    }
}

/// The SSL_CERT_* variables the user did not set (Linux): a server or CLI the app starts must not inherit them
/// (server::child_env and the login shell of pathenv remove them).
pub fn ssl_env_not_from_user() -> Vec<&'static str> {
    #[cfg(target_os = "linux")]
    {
        let had = SSL_ENV_AT_LAUNCH.get().copied().unwrap_or([true, true]);
        SSL_ENV.iter().zip(had).filter(|(_, had)| !had).map(|(name, _)| *name).collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

/// At launch: what kind of install this is, the result of an update installed just before, stale temp folders, and
/// the automatic checks.
pub fn setup(app: &AppHandle, smoke: bool) {
    let st = app.state::<AppState>();
    let up = &st.update;
    let current = app.package_info().version.to_string();
    let exe = tauri::utils::platform::current_exe().or_else(|_| std::env::current_exe()).unwrap_or_default();
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let (kind, mut install, mut reason) =
        install_kind(std::env::consts::OS, tauri::utils::platform::bundle_type(), appimage.as_deref(), &exe, arch_package());
    if cfg!(debug_assertions) && install == Install::InApp {
        (install, reason) = (Install::Download, Some(i18n::msg().update.reason_dev));
    }
    let cfg = config::load(app);
    {
        let mut s = lock(&up.state);
        s.current = current.clone();
        s.kind = kind;
        s.install = install;
        s.reason = reason.map(str::to_string);
        s.release_url = release_url(None);
        s.auto = cfg.update_check != Some(false);
    }
    config::log(app, &format!("updates: {kind:?} install {install:?} ({})", exe.display()));

    if let Some(from) = cfg.updated_from.clone() {
        config::update(app, |c| c.updated_from = None);
        if from == current {
            // The new version did not come up (the installer failed or was stopped, the old copy was started again):
            // offering the same one-click install again would loop.
            config::log(app, &format!("updates: the update from {from} did not take; this is still {current}"));
            let text = (i18n::msg().update.did_not_take)(&current);
            *lock(&up.did_not_take) = Some(text.clone());
            let mut s = lock(&up.state);
            s.phase = Phase::Error;
            s.error = Some(text.clone());
            if s.install == Install::InApp {
                (s.install, s.reason) = (Install::Download, Some(text));
            }
        } else {
            config::log(app, &format!("updates: updated from {from} to {current}"));
            *lock(&up.just_updated) = Some(current.clone());
        }
    }

    let h = app.clone();
    std::thread::spawn(move || clean_stale_temp(&h));
    if !smoke && !cfg!(debug_assertions) {
        let h = app.clone();
        std::thread::spawn(move || scheduled_checks(&h));
    }
}

/// 15 s after launch, then every 6 hours (wall-clock, so a laptop that slept checks when it wakes).
fn scheduled_checks(app: &AppHandle) {
    std::thread::sleep(FIRST_CHECK);
    let mut last: Option<SystemTime> = None;
    loop {
        let due = last.is_none_or(|t| t.elapsed().map_or(true, |e| e >= CHECK_EVERY));
        if due && config::load(app).update_check != Some(false) && !app.state::<AppState>().quitting.load(SeqCst) {
            check(app, How::Auto);
            last = Some(SystemTime::now());
        }
        std::thread::sleep(Duration::from_secs(600));
    }
}

/// Leftovers of installs that were cut short: the plugin's backup and extraction folders (macOS, AppImage), and on
/// Windows the installer it wrote to %TEMP% (the process exits before the plugin can delete it).
fn clean_stale_temp(app: &AppHandle) {
    let current = semver::Version::parse(&app.package_info().version.to_string()).ok();
    #[allow(unused_mut)]
    let mut dirs = vec![std::env::temp_dir()];
    #[cfg(target_os = "linux")]
    {
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));
        dirs.extend(cache);
        dirs.extend(std::env::var_os("APPIMAGE").and_then(|p| Path::new(&p).parent().map(Path::to_path_buf)));
    }
    let day = Duration::from_secs(24 * 3600);
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
            let stale = (is_plugin_leftover(&name) && old)
                || (cfg!(windows) && windows_leftover(&name, &app.package_info().name).zip(current.as_ref()).is_some_and(|(v, cur)| v <= *cur));
            if stale && entry.file_type().is_ok_and(|t| t.is_dir()) {
                let removed = std::fs::remove_dir_all(entry.path());
                config::log(app, &format!("updates: removed stale {} ({removed:?})", entry.path().display()));
            }
        }
    }
}

/// The plugin's temp folders on macOS and Linux (tempfile adds a random suffix).
fn is_plugin_leftover(name: &str) -> bool {
    name.starts_with("tauri_current_app") || name.starts_with("tauri_updated_app")
}

/// `%TEMP%\<app>-<version>-updater-<random>`: the version of a Windows installer folder.
fn windows_leftover(name: &str, app: &str) -> Option<semver::Version> {
    let rest = name.strip_prefix(app)?.strip_prefix('-')?;
    let (version, _) = rest.split_once("-updater-")?;
    semver::Version::parse(version).ok()
}

// ---------------------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum How {
    /// The schedule: failures only go to lastError.
    Auto,
    /// Asked for (chooser, menu, page): at most every 30 s.
    Manual,
    /// The first step of an install.
    ForInstall,
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, Error> {
    let install = lock(&updates(app).state).install;
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|c: reqwest::ClientBuilder| c.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT))
        // Windows: the default hides every window before the installer starts: if it then fails to start, the app
        // would go on running invisibly. The local server is already stopped (request_install).
        .on_before_exit(|| {});
    // deb, rpm, Arch (and dev builds): check-only through the AppImage's key, never installed. latest.json has no
    // bare linux-<arch> key, which these would otherwise fall back to (and fail on every check without it).
    if cfg!(target_os = "linux") && install != Install::InApp {
        builder = builder.target(format!("linux-{}-appimage", std::env::consts::ARCH));
    }
    builder.build()
}

/// The first endpoint's HTTP status, fetched like the updater does (following redirects): the plugin reports every
/// non-2xx answer as ReleaseNotFound, so a 404 (no release yet) is told apart from an outage here.
fn endpoint_status(app: &AppHandle) -> Option<u16> {
    let url = app.config().plugins.0.get("updater")?.get("endpoints")?.get(0)?.as_str()?.to_string();
    let client = reqwest::Client::builder()
        .user_agent("easy-study-desktop")
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(CHECK_TIMEOUT)
        .build()
        .ok()?;
    tauri::async_runtime::block_on(async move { client.get(url).header("Accept", "application/json").send().await.ok().map(|r| r.status().as_u16()) })
}

/// Whether a check asked for (chooser, menu, page) may make a request now: at most one every MANUAL_EVERY (and counts
/// it).
fn manual_due(up: &Updates) -> bool {
    let mut last = lock(&up.last_manual);
    if last.is_some_and(|t| t.elapsed() < MANUAL_EVERY) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

/// Waits (a while) for a check that runs to end.
fn wait_for_check(up: &Updates) {
    let t = Instant::now();
    while up.checking.load(SeqCst) && t.elapsed() < CHECK_TIMEOUT * 3 {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Checks for a newer version and keeps what it finds. Blocks (never call it on the main thread). Returns whether a
/// newer version is held afterwards.
pub fn check(app: &AppHandle, how: How) -> bool {
    let up = updates(app);
    let held = || lock(&up.held).is_some();
    if how != How::ForInstall && up.flow.load(SeqCst) {
        return held(); // an install is on its way: it has what it needs
    }
    if how == How::Manual && !manual_due(up) {
        bridge::push_state(app);
        return held();
    }
    let _checking = match Flag::take(&up.checking) {
        Some(flag) => flag,
        None => {
            // Another check runs: its answer is this one's.
            wait_for_check(up);
            return held();
        }
    };
    let before = {
        let mut s = lock(&up.state);
        let before = s.phase;
        if matches!(s.phase, Phase::Idle | Phase::Latest | Phase::Error) {
            s.phase = Phase::Checking;
            s.error = None;
        }
        before
    };
    bridge::push_state(app);

    let result = updater(app).and_then(|u| tauri::async_runtime::block_on(u.check()));
    let found = match result {
        Ok(Some(update)) => {
            found(app, update);
            true
        }
        Ok(None) => {
            latest(app);
            false
        }
        Err(Error::ReleaseNotFound) if endpoint_status(app) == Some(404) => {
            // No release (or no latest.json in it) yet: nothing newer.
            latest(app);
            false
        }
        Err(e) => {
            // A page can ask again and again (install-update with nothing found): limited like its other lines.
            bridge::log_limited(app, "check-failed", &format!("updates: check failed ({how:?}): {e}"));
            failed(app, how, before, describe(&e, std::env::consts::OS));
            held()
        }
    };
    set_menu_text(app);
    bridge::push_state(app);
    found
}

fn found(app: &AppHandle, update: Update) {
    let up = updates(app);
    let version = update.version.clone();
    let notes = update.body.as_deref().and_then(plain_notes);
    let date = update.date.and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok());
    let downloaded = {
        let mut held = lock(&up.held);
        if !held.as_ref().is_some_and(|h| h.update.version == version) {
            // Another version: bytes held for the old one go (they would install under the wrong name).
            *held = Some(Held { update, bytes: None });
        }
        held.as_ref().is_some_and(|h| h.bytes.is_some())
    };
    config::log(app, &format!("updates: {version} is available"));
    let mut s = lock(&up.state);
    if s.version.as_deref() != Some(version.as_str()) {
        (s.received, s.total) = (0, None);
    }
    s.version = Some(version.clone());
    s.notes = notes;
    s.date = date;
    s.release_url = release_url(Some(&version));
    if !matches!(s.phase, Phase::Downloading | Phase::Installing) {
        s.phase = if downloaded { Phase::Downloaded } else { Phase::Available };
    }
    s.error = None;
    (s.last_error, s.last_error_at) = (None, None);
    s.checked_at = now_rfc3339();
}

fn latest(app: &AppHandle) {
    let up = updates(app);
    *lock(&up.held) = None;
    let mut s = lock(&up.state);
    s.phase = Phase::Latest;
    (s.version, s.notes, s.date, s.total, s.error) = (None, None, None, None, None);
    s.received = 0;
    s.release_url = release_url(None);
    (s.last_error, s.last_error_at) = (None, None);
    s.checked_at = now_rfc3339();
}

fn failed(app: &AppHandle, how: How, before: Phase, text: &'static str) {
    let up = updates(app);
    let held = lock(&up.held).as_ref().map(|h| h.bytes.is_some());
    let stuck = lock(&up.did_not_take).clone();
    let mut s = lock(&up.state);
    s.last_error = Some(text.to_string());
    s.last_error_at = now_rfc3339();
    (s.phase, s.error) = after_failure(how, before, held, text, stuck.as_deref());
}

/// The phase and error after a failed check. `before`: the phase it started from; `held`: a found version is kept
/// (Some(true): with its bytes); `stuck`: the notice of an update that did not take (setup).
fn after_failure(how: How, before: Phase, held: Option<bool>, text: &str, stuck: Option<&str>) -> (Phase, Option<String>) {
    match (held, how) {
        (Some(true), _) => (Phase::Downloaded, None),
        (Some(false), _) => (Phase::Available, None),
        (None, How::Auto) => match (stuck, before) {
            // The notice stays until a check finds something (the banner and the chooser's download link go with it).
            (Some(notice), _) => (Phase::Error, Some(notice.to_string())),
            // Silent: back to idle (lastError keeps the text for the settings).
            (None, Phase::Checking | Phase::Error) => (Phase::Idle, None),
            (None, other) => (other, None),
        },
        (None, _) => (Phase::Error, Some(text.to_string())),
    }
}

/// The menu item names a found version (the way in when the page is an old remote UI that ignores the state).
pub fn set_menu_text(app: &AppHandle) {
    let up = updates(app);
    let version = lock(&up.held).as_ref().map(|h| h.update.version.clone());
    let menu = &i18n::msg().menu;
    let text = match version {
        Some(v) => (menu.install_update)(&v),
        None => menu.check_update.to_string(),
    };
    let item = lock(&up.menu).clone();
    if let Some(item) = item {
        let _ = item.set_text(text);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// A page's install-update action (`local`: this computer's server's page).
    Page { origin: String, local: bool },
    Chooser,
    /// The menu, which asked in its own dialog.
    Menu,
}

enum Fetch {
    Done(Vec<u8>),
    Cancelled,
    Failed(&'static str),
}

/// Whether install() is replacing the app right now (quitting must wait).
pub fn replacing(app: &AppHandle) -> bool {
    let up = updates(app);
    up.replacing.load(SeqCst) && !up.force_quit.load(SeqCst)
}

/// SIGTERM: waits up to `limit` for a running install() to finish; after that, quitting is let through.
#[cfg(unix)]
pub fn wait_until_replaced(app: &AppHandle, limit: Duration) {
    let t = Instant::now();
    while replacing(app) && t.elapsed() < limit {
        std::thread::sleep(Duration::from_millis(100));
    }
    updates(app).force_quit.store(true, SeqCst);
}

/// Stops a download (the "취소" of the chooser and the page).
pub fn cancel(app: &AppHandle) {
    let up = updates(app);
    if lock(&up.state).phase == Phase::Downloading {
        up.cancel.store(true, SeqCst);
    }
}

fn open_release(app: &AppHandle, url: &str, page: bool) {
    if page && !bridge::page_may_open(app) {
        return bridge::log_limited(app, "release-page", "updates: release page not opened again so soon");
    }
    config::log(app, &format!("updates: opening {url}"));
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        config::log(app, &format!("updates: could not open {url}: {e}"));
    }
}

fn set_phase(app: &AppHandle, phase: Phase, error: Option<&str>) {
    {
        let mut s = lock(&updates(app).state);
        s.phase = phase;
        s.error = error.map(str::to_string);
    }
    bridge::push_state(app);
}

/// Downloads, checks and installs the found version, then restarts the app (DESIGN §24). Blocks: run it on its own
/// thread. One at a time; every early return gives the lock back.
pub fn request_install(app: &AppHandle, trigger: Trigger) {
    let st = app.state::<AppState>();
    let up = &st.update;
    let m = i18n::msg();
    let Some(_flow) = Flag::take(&up.flow) else {
        // A page may ask again while the first flow's dialog is open.
        return bridge::log_limited(app, "install-busy", "updates: an install is already on its way");
    };
    let page = match &trigger {
        Trigger::Page { origin, local } => Some((origin.clone(), *local)),
        _ => None,
    };
    let asked = |accepted: bool| {
        if let Some((origin, local)) = &page {
            bridge::page_asked(app, origin, *local, accepted);
        }
    };

    // 1. What to install. A page makes a request only as often as a manual check may (one repeating this would
    // otherwise ask GitHub each time).
    let held = lock(&up.held).is_some();
    if !held && page.is_some() && !manual_due(up) {
        bridge::log_limited(app, "page-install", "updates: install-update with nothing found, checked recently: not again");
        return bridge::push_state(app);
    }
    if !held && !check(app, How::ForInstall) {
        if trigger == Trigger::Menu {
            let s = lock(&up.state).clone();
            bridge::tell(app, &nothing_found(&s));
        }
        return;
    }
    let (install, url, version, current) = {
        let s = lock(&up.state);
        (s.install, s.release_url.clone(), s.version.clone().unwrap_or_default(), s.current.clone())
    };
    if install != Install::InApp {
        return open_release(app, &url, page.is_some());
    }

    // 2. Another computer's page asked: the user confirms in a dialog no page can draw.
    if let Some((_, false)) = &page {
        let ok = bridge::confirm(app, &(m.update.confirm_install)(&version), m.update.install_restart, m.common.cancel);
        asked(ok);
        if !ok {
            return;
        }
    }

    // 3. Nothing that could lose audio, and the user knows what else stops.
    let page_asked_itself = page.is_some();
    let mut accepted = None;
    match bridge::busy_gate(app, page_asked_itself) {
        Gate::Block(msg) => {
            bridge::tell(app, &msg);
            asked(false);
            return;
        }
        Gate::Warn(msg) => {
            let ok = bridge::confirm(app, &msg, m.update.install_restart, m.common.cancel);
            asked(ok);
            if !ok {
                return;
            }
            accepted = Some(msg);
        }
        Gate::Go => {}
    }

    // 4. The download (the plugin verifies the signature and its version), unless the bytes are already here.
    let (update, have_bytes) = match lock(&up.held).as_ref() {
        Some(h) => (h.update.clone(), h.bytes.as_ref().is_some_and(|(v, _)| *v == h.update.version)),
        None => return,
    };
    if !have_bytes {
        let suffix = expected_file_suffix(std::env::consts::OS, std::env::consts::ARCH, lock(&up.state).kind);
        let bytes = match download(app, update.clone()) {
            Fetch::Done(bytes) => bytes,
            Fetch::Cancelled => {
                config::log(app, "updates: download cancelled");
                return set_phase(app, Phase::Available, None);
            }
            Fetch::Failed(text) => {
                set_phase(app, Phase::Error, Some(text));
                if trigger == Trigger::Menu {
                    bridge::tell(app, &(m.update.failed)(text));
                }
                return;
            }
        };
        if !suffix.is_some_and(|s| signed_for(&update.signature, s, &update.version)) {
            config::log(app, &format!("updates: the signature of {} names another file or version: {:?}", update.version, signed_file(&update.signature)));
            return set_phase(app, Phase::Error, Some(m.update.wrong_file));
        }
        let mut held = lock(&up.held);
        match held.as_mut() {
            Some(h) if h.update.version == update.version => h.bytes = Some((update.version.clone(), bytes)),
            _ => {
                drop(held);
                return set_phase(app, Phase::Available, None); // a check found another version meanwhile
            }
        }
    }
    set_phase(app, Phase::Downloaded, None);

    // 5. A recording may have started during the download.
    match bridge::busy_gate(app, page_asked_itself) {
        Gate::Block(msg) => {
            if page.is_none() {
                bridge::tell(app, &(m.update.kept_download)(&msg));
            }
            return; // stays "downloaded": the page says so
        }
        Gate::Warn(msg) if accepted.as_deref() != Some(msg.as_str()) => {
            let ok = bridge::confirm(app, &msg, m.update.install_restart, m.common.cancel);
            asked(ok);
            if !ok {
                return;
            }
        }
        _ => {}
    }

    // 6. From here on the app cannot quit until it restarts (or the install fails).
    up.replacing.store(true, SeqCst);
    {
        let mut s = lock(&up.state);
        s.phase = Phase::Installing;
        s.error = None;
    }
    bridge::push_state(app);
    bridge::allow_leave(app);
    crate::show_chooser(app);
    // The restart is deliberate: the next launch connects as remembered (on Windows install() exits without
    // RunEvent::Exit, which would otherwise clear the pending automatic connection).
    config::update(app, |c| {
        c.updated_from = Some(current.clone());
        c.auto_connect_pending = false;
    });

    // 7. The server goes first on every OS: macOS and the AppImage replace files under a running node, and on
    // Windows install() exits the process without RunEvent::Exit.
    crate::server::stop(app);

    // 8. Replace the app (macOS may ask for an administrator's password: the plugin runs that dialog on the main
    // thread and waits, which is why this runs on a worker thread).
    let taken = lock(&up.held).as_mut().and_then(|h| h.bytes.take().map(|b| (h.update.clone(), b)));
    let result = match &taken {
        Some((update, (version, bytes))) if *version == update.version => {
            config::log(app, &format!("updates: installing {version}"));
            update.install(bytes)
        }
        // The bytes belong to another version than the Update (never expected: both change together).
        _ => Err(Error::Io(std::io::Error::other("no downloaded bytes for this version"))),
    };
    match result {
        Ok(()) => {
            // 9. Through RunEvent::Exit (restart() on the main thread would skip it).
            config::log(app, &format!("updates: {version} installed, restarting"));
            app.request_restart();
        }
        Err(e) => {
            config::log(app, &format!("updates: install failed: {e}"));
            // Keep the verified bytes: a retry does not download again.
            if let Some((update, bytes)) = taken {
                if let Some(h) = lock(&up.held).as_mut().filter(|h| h.update.version == update.version) {
                    h.bytes = Some(bytes);
                }
            }
            config::update(app, |c| c.updated_from = None);
            up.replacing.store(false, SeqCst);
            let text = describe(&e, std::env::consts::OS);
            set_phase(app, Phase::Error, Some(text));
            if let Some(w) = crate::main_window(app) {
                let _ = w.show();
                let _ = w.set_focus();
            }
            if trigger == Trigger::Menu {
                bridge::tell(app, &(m.update.failed)(text));
            }
        }
    }
}

/// Downloads under a watchdog: the future is dropped when no data came for STALL, or on "취소".
fn download(app: &AppHandle, update: Update) -> Fetch {
    let up = updates(app);
    up.cancel.store(false, SeqCst);
    {
        let mut s = lock(&up.state);
        s.phase = Phase::Downloading;
        (s.received, s.total, s.error) = (0, None, None);
    }
    bridge::push_state(app);
    let started = Instant::now();
    // Milliseconds after `started` of the last chunk.
    let last_chunk = Arc::new(AtomicU64::new(0));
    let (tx, rx) = mpsc::channel();
    let (h, last) = (app.clone(), last_chunk.clone());
    let task = tauri::async_runtime::spawn(async move {
        let mut received = 0u64;
        let result = update
            .download(
                |n, total| {
                    received += n as u64;
                    last.store(started.elapsed().as_millis() as u64, SeqCst);
                    {
                        let mut s = lock(&updates(&h).state);
                        (s.received, s.total) = (received, total);
                    }
                    bridge::push_state_throttled(&h);
                },
                || {},
            )
            .await;
        let _ = tx.send(result);
    });
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Ok(bytes)) => return Fetch::Done(bytes),
            Ok(Err(e)) => {
                config::log(app, &format!("updates: download failed: {e}"));
                return Fetch::Failed(describe(&e, std::env::consts::OS));
            }
            Err(RecvTimeoutError::Timeout) => {
                if up.cancel.swap(false, SeqCst) {
                    task.abort();
                    return Fetch::Cancelled;
                }
                let idle = started.elapsed().saturating_sub(Duration::from_millis(last_chunk.load(SeqCst)));
                if idle > STALL {
                    task.abort();
                    config::log(app, &format!("updates: download stalled for {} s", idle.as_secs()));
                    return Fetch::Failed(i18n::msg().update.network);
                }
            }
            Err(RecvTimeoutError::Disconnected) => return Fetch::Failed(i18n::msg().update.other),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Menu "업데이트 확인…"
// ---------------------------------------------------------------------------------------------------------

/// Whether a fixed text is a whole sentence about the update itself ("업데이트가 끝나지 않았어요…", `other`), which
/// needs no "…하지 못했어요:" in front (`failed_prefixes`, any language's: the text may be older than a change of it).
pub fn says_update_failed(text: &str) -> bool {
    [i18n::Lang::Ko, i18n::Lang::En].iter().any(|&l| i18n::texts(l).update.failed_prefixes.iter().any(|p| text.starts_with(p)))
}

/// "업데이트를 확인하지 못했어요: {text}", or the text alone when it says so itself.
fn could_not_check(text: &str) -> String {
    if says_update_failed(text) {
        text.to_string()
    } else {
        (i18n::msg().update.could_not_check)(text)
    }
}

/// The menu's answer when no newer version is held after its check: "최신" only when a check said so.
fn nothing_found(s: &UpdateState) -> String {
    let u = &i18n::msg().update;
    match s.phase {
        Phase::Latest => (u.latest)(&s.current),
        Phase::Checking => u.still_checking.to_string(),
        _ => could_not_check(s.error.as_deref().or(s.last_error.as_deref()).unwrap_or(u.other)),
    }
}

/// Checks (unless a version is already found) and answers in a native dialog: the way in whatever the window shows.
pub fn menu_check(app: &AppHandle) {
    let up = updates(app);
    let m = i18n::msg();
    if up.flow.load(SeqCst) {
        let s = lock(&up.state).clone();
        let text = match s.phase {
            Phase::Downloading => (m.update.downloading)(&s.version.unwrap_or_default()),
            _ => m.update.preparing.to_string(),
        };
        return bridge::tell(app, &text);
    }
    if lock(&up.held).is_none() {
        // A check that runs (the automatic one, a click in the chooser) ends first; then this one runs, unless a
        // manual one ran within 30 s (its answer stands).
        wait_for_check(up);
        check(app, How::Manual);
    }
    let s = lock(&up.state).clone();
    if lock(&up.held).is_none() {
        return bridge::tell(app, &nothing_found(&s));
    }
    let version = s.version.clone().unwrap_or_default();
    let notes = s.notes.as_deref().map(|n| format!("\n\n{}", n.chars().take(400).collect::<String>())).unwrap_or_default();
    let head = format!("{}{notes}", (m.update.available)(&version, &s.current));
    if s.install == Install::InApp {
        if bridge::confirm(app, &format!("{head}\n\n{}", m.update.install_now), m.update.install_restart, m.update.later) {
            // On its own thread: the menu stays usable during the download.
            let h = app.clone();
            std::thread::spawn(move || request_install(&h, Trigger::Menu));
        }
    } else {
        let reason = s.reason.as_deref().map(|r| format!("\n\n{r}")).unwrap_or_default();
        if bridge::confirm(app, &format!("{head}{reason}"), m.update.open_download, m.common.close) {
            open_release(app, &s.release_url, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_kinds() {
        let u = &i18n::msg().update;
        let p = Path::new;
        let app = p("/Applications/easy-study.app/Contents/MacOS/easy-study");
        assert_eq!(install_kind("macos", Some(BundleType::App), None, app, false), (Kind::App, Install::InApp, None));
        let translocated = p("/private/var/folders/x/T/AppTranslocation/1234/d/easy-study.app/Contents/MacOS/easy-study");
        assert_eq!(install_kind("macos", Some(BundleType::App), None, translocated, false), (Kind::App, Install::Download, Some(u.reason_move_app)));
        let dmg = p("/Volumes/easy-study/easy-study.app/Contents/MacOS/easy-study");
        assert_eq!(install_kind("macos", Some(BundleType::App), None, dmg, false).1, Install::Download);
        // `cargo run` / `tauri dev`: bundle_type() says App there too, but there is no bundle to replace.
        let dev = p("/Users/me/easy-study/desktop/src-tauri/target/debug/easy-study");
        assert_eq!(install_kind("macos", Some(BundleType::App), None, dev, false), (Kind::None, Install::None, None));
        assert_eq!(install_kind("macos", Some(BundleType::App), None, p("/x/Contents/MacOS/easy-study"), false).1, Install::None);

        let exe = p("C:\\Users\\me\\AppData\\Local\\easy-study\\easy-study.exe");
        assert_eq!(install_kind("windows", Some(BundleType::Nsis), None, exe, false), (Kind::Nsis, Install::InApp, None));
        assert_eq!(install_kind("windows", Some(BundleType::Msi), None, exe, false).1, Install::Download);
        assert_eq!(install_kind("windows", None, None, exe, false), (Kind::None, Install::None, None));

        let bin = p("/tmp/.mount_easyXYZ/usr/bin/easy-study");
        let image = p("/home/me/Apps/easy-study_0.5.0_amd64.AppImage");
        assert_eq!(install_kind("linux", Some(BundleType::AppImage), Some(image), bin, false), (Kind::Appimage, Install::InApp, None));
        assert_eq!(install_kind("linux", Some(BundleType::AppImage), None, p("/ci/squashfs-root/usr/bin/easy-study"), false), (Kind::Appimage, Install::Download, Some(u.reason_extracted)));
        assert_eq!(install_kind("linux", Some(BundleType::AppImage), Some(p("")), bin, false).1, Install::Download);
        let usr = p("/usr/bin/easy-study");
        assert_eq!(install_kind("linux", Some(BundleType::Deb), None, usr, true), (Kind::Arch, Install::Download, Some(u.reason_arch)));
        assert_eq!(install_kind("linux", Some(BundleType::Deb), None, usr, false), (Kind::Deb, Install::Download, Some(u.reason_deb)));
        assert_eq!(install_kind("linux", Some(BundleType::Rpm), None, usr, false), (Kind::Rpm, Install::Download, Some(u.reason_rpm)));
        assert_eq!(install_kind("linux", None, None, p("/home/me/easy-study/target/debug/easy-study"), false), (Kind::None, Install::None, None));
    }

    #[test]
    fn state_json_uses_the_contract_names() {
        let u = &i18n::msg().update;
        let s = UpdateState {
            phase: Phase::Downloading,
            current: "0.5.0".into(),
            version: Some("0.5.1".into()),
            notes: Some("고친 점".into()),
            date: Some("2026-10-05T09:00:00Z".into()),
            release_url: release_url(Some("0.5.1")),
            received: 10,
            total: Some(100),
            error: Some(u.network.into()),
            install: Install::InApp,
            reason: Some(u.reason_deb.into()),
            kind: Kind::Appimage,
            checked_at: Some("2026-10-05T09:01:00Z".into()),
            auto: true,
            dismissed: false,
            last_error: Some(u.network.into()),
            last_error_at: Some("2026-10-05T09:02:00Z".into()),
        };
        let v = serde_json::to_value(&s).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "auto", "checkedAt", "current", "date", "dismissed", "error", "install", "kind", "lastError", "lastErrorAt", "notes",
                "phase", "reason", "received", "releaseUrl", "total", "version"
            ]
        );
        assert_eq!((v["phase"].as_str(), v["install"].as_str(), v["kind"].as_str()), (Some("downloading"), Some("inApp"), Some("appimage")));
        assert_eq!(v["releaseUrl"], "https://github.com/Wooangha/easy-study-releases/releases/tag/v0.5.1");
        // Optional fields are left out (never null); the defaults of a fresh state.
        let fresh = serde_json::to_value(UpdateState::default()).unwrap();
        assert_eq!(fresh, serde_json::json!({ "phase": "idle", "current": "", "releaseUrl": "", "received": 0, "install": "none", "kind": "none", "auto": false, "dismissed": false }));
        for (phase, name) in [(Phase::Checking, "checking"), (Phase::Latest, "latest"), (Phase::Available, "available"), (Phase::Downloaded, "downloaded"), (Phase::Installing, "installing"), (Phase::Error, "error")] {
            assert_eq!(serde_json::to_value(phase).unwrap(), name);
        }
        // Another computer's page: no notes, dates or check history.
        let remote = serde_json::to_value(s.for_remote()).unwrap();
        for key in ["notes", "date", "checkedAt", "lastError", "lastErrorAt"] {
            assert!(remote.get(key).is_none(), "{key}");
        }
        assert_eq!(remote["version"], "0.5.1");
        assert_eq!(release_url(None), "https://github.com/Wooangha/easy-study-releases/releases/latest");
    }

    #[test]
    fn errors_map_to_fixed_texts() {
        let u = &i18n::msg().update;
        let io = |kind| Error::Io(std::io::Error::new(kind, "/Users/someone/private/path"));
        assert_eq!(describe(&Error::TargetNotFound("linux-x86_64-appimage".into()), "linux"), u.no_file);
        assert_eq!(describe(&Error::TargetsNotFound(vec!["darwin-aarch64-app".into()]), "macos"), u.no_file);
        assert_eq!(describe(&Error::SignedVersionMismatch { signed: "0.5.1".into(), announced: "0.5.2".into() }, "macos"), u.signature);
        assert_eq!(describe(&Error::MissingSignedVersion, "macos"), u.signature);
        assert_eq!(describe(&Error::SignatureUtf8("x".into()), "macos"), u.signature);
        assert_eq!(describe(&Error::Base64(base64::DecodeError::InvalidLength(3)), "windows"), u.signature);
        assert_eq!(describe(&Error::Network("Download request failed with status: 404".into()), "linux"), u.network);
        assert_eq!(describe(&Error::ReleaseNotFound, "linux"), u.network);
        assert_eq!(describe(&Error::AuthenticationFailed, "macos"), u.mac_permission);
        assert_eq!(describe(&io(std::io::ErrorKind::PermissionDenied), "macos"), u.mac_permission);
        assert_eq!(describe(&io(std::io::ErrorKind::PermissionDenied), "linux"), u.appimage_permission);
        assert_eq!(describe(&io(std::io::ErrorKind::Other), "windows"), u.installer);
        assert_eq!(describe(&io(std::io::ErrorKind::Other), "macos"), u.other);
        assert_eq!(describe(&Error::EmptyEndpoints, "macos"), u.other);
        let json = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(describe(&Error::Serialization(json), "macos"), u.other);
        // None of them carries a path, in any language.
        for lang in i18n::ALL {
            let u = &i18n::texts(lang).update;
            for text in [u.network, u.no_file, u.signature, u.wrong_file, u.mac_permission, u.appimage_permission, u.installer, u.other] {
                assert!(!text.contains('/'), "{text}");
            }
        }
        // The shell's language: English texts in English.
        i18n::with_lang(i18n::Lang::En, || {
            assert_eq!(describe(&Error::ReleaseNotFound, "linux"), "Couldn't connect to the update server. Check your internet connection.");
            assert_eq!(install_kind("linux", Some(BundleType::Deb), None, Path::new("/usr/bin/easy-study"), false).2, Some(i18n::texts(i18n::Lang::En).update.reason_deb));
        });
    }

    /// A .sig in minisign's layout, base64 as in latest.json (the bytes are no real signature: signed_file only reads,
    /// download() verifies). `first`: the whole first line.
    fn signature_with(first: &str, comment: &str) -> String {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let sig = b64(&[b"ED".as_slice(), &[7; 8], &[1; 64]].concat());
        let text = format!("{first}\n{sig}\ntrusted comment: {comment}\n{}\n", b64(&[2; 64]));
        b64(text.as_bytes())
    }

    fn signature(comment: &str) -> String {
        signature_with("untrusted comment: signature from tauri secret key", comment)
    }

    #[test]
    fn the_signed_file_must_be_this_platforms() {
        let sig = signature("timestamp:1790628524\tfile:easy-study_0.5.1_aarch64.app.tar.gz\tversion:0.5.1");
        assert_eq!(signed_file(&sig), Some(("easy-study_0.5.1_aarch64.app.tar.gz".into(), "0.5.1".into())));
        let arm_mac = expected_file_suffix("macos", "aarch64", Kind::App).unwrap();
        assert!(signed_for(&sig, arm_mac, "0.5.1"));
        assert!(!signed_for(&sig, arm_mac, "0.5.2"));
        assert!(!signed_for(&sig, expected_file_suffix("macos", "x86_64", Kind::App).unwrap(), "0.5.1"));
        let amd64 = signature("timestamp:1\tfile:easy-study_0.5.1_amd64.AppImage\tversion:0.5.1");
        assert!(signed_for(&amd64, expected_file_suffix("linux", "x86_64", Kind::Appimage).unwrap(), "0.5.1"));
        assert!(!signed_for(&amd64, expected_file_suffix("linux", "aarch64", Kind::Appimage).unwrap(), "0.5.1"));
        let setup = signature("timestamp:1\tfile:easy-study_0.5.1_x64-setup.exe\tversion:0.5.1");
        assert!(signed_for(&setup, expected_file_suffix("windows", "x86_64", Kind::Nsis).unwrap(), "0.5.1"));
        // No file or version in the comment, or not a signature at all.
        assert!(!signed_for(&signature("timestamp:1\tfile:easy-study_0.5.1_x64-setup.exe"), "_x64-setup.exe", "0.5.1"));
        assert_eq!(signed_file("not base64!"), None);
        // The first line is not covered by the signature (the verifier does not even check its prefix): a tampered
        // latest.json could put a "trusted comment" for another platform's file there. Only the third line counts.
        let x64 = "timestamp:1\tfile:easy-study_0.5.1_x64.app.tar.gz\tversion:0.5.1";
        let forged = signature_with("trusted comment: timestamp:1\tfile:easy-study_0.5.1_aarch64.app.tar.gz\tversion:0.5.1", x64);
        assert_eq!(signed_file(&forged), Some(("easy-study_0.5.1_x64.app.tar.gz".into(), "0.5.1".into())));
        assert!(!signed_for(&forged, arm_mac, "0.5.1"));
        assert!(signed_for(&forged, expected_file_suffix("macos", "x86_64", Kind::App).unwrap(), "0.5.1"));
        // Not minisign's four lines: nothing is read.
        let loose = base64::engine::general_purpose::STANDARD.encode(format!("trusted comment: {x64}\n"));
        assert_eq!(signed_file(&loose), None);
        // Packages and dev builds are never installed in the app.
        assert_eq!(expected_file_suffix("linux", "x86_64", Kind::Deb), None);
        assert_eq!(expected_file_suffix("macos", "aarch64", Kind::None), None);
    }

    #[test]
    fn failed_checks() {
        let u = &i18n::msg().update;
        let stuck = "업데이트가 끝나지 않았어요 (지금 0.5.0). 다운로드 페이지에서 직접 설치해 주세요.";
        // Automatic: silent (back to idle, or where it was); a found version stays.
        assert_eq!(after_failure(How::Auto, Phase::Idle, None, u.network, None), (Phase::Idle, None));
        assert_eq!(after_failure(How::Auto, Phase::Error, None, u.network, None), (Phase::Idle, None));
        assert_eq!(after_failure(How::Auto, Phase::Latest, None, u.network, None), (Phase::Latest, None));
        assert_eq!(after_failure(How::Auto, Phase::Available, Some(false), u.network, None), (Phase::Available, None));
        assert_eq!(after_failure(How::Manual, Phase::Error, Some(true), u.network, None), (Phase::Downloaded, None));
        // Asked for: the error shows.
        assert_eq!(after_failure(How::Manual, Phase::Latest, None, u.network, None), (Phase::Error, Some(u.network.into())));
        assert_eq!(after_failure(How::ForInstall, Phase::Idle, None, u.no_file, None), (Phase::Error, Some(u.no_file.into())));
        // An update that did not take: an automatic failure does not wipe the notice (nor the download link with it).
        assert_eq!(after_failure(How::Auto, Phase::Error, None, u.network, Some(stuck)), (Phase::Error, Some(stuck.into())));
        assert_eq!(after_failure(How::Auto, Phase::Idle, None, u.network, Some(stuck)), (Phase::Error, Some(stuck.into())));
        assert_eq!(after_failure(How::Auto, Phase::Error, Some(false), u.network, Some(stuck)), (Phase::Available, None));
    }

    #[test]
    fn the_menu_says_latest_only_after_a_check_said_so() {
        let u = &i18n::msg().update;
        let s = |phase, error: Option<&str>, last_error: Option<&str>| UpdateState {
            phase,
            current: "0.5.0".into(),
            error: error.map(str::to_string),
            last_error: last_error.map(str::to_string),
            ..UpdateState::default()
        };
        assert_eq!(nothing_found(&s(Phase::Latest, None, None)), "최신 버전을 쓰고 있어요 (easy-study 0.5.0).");
        assert!(nothing_found(&s(Phase::Checking, None, None)).contains("확인하는 중"));
        assert_eq!(nothing_found(&s(Phase::Error, Some(u.network), None)), format!("업데이트를 확인하지 못했어요: {}", u.network));
        // The automatic check the menu waited for failed (silently: idle, lastError).
        assert_eq!(nothing_found(&s(Phase::Idle, None, Some(u.network))), format!("업데이트를 확인하지 못했어요: {}", u.network));
        assert_eq!(nothing_found(&s(Phase::Idle, None, None)), u.other);
        // A text that says it itself is not prefixed again.
        let stuck = "업데이트가 끝나지 않았어요 (지금 0.5.0). 다운로드 페이지에서 직접 설치해 주세요.";
        assert_eq!(nothing_found(&s(Phase::Error, Some(stuck), Some(u.network))), stuck);
        // In English: the same answers, the same rule for the texts that say it themselves.
        i18n::with_lang(i18n::Lang::En, || {
            let en = &i18n::texts(i18n::Lang::En).update;
            assert_eq!(nothing_found(&s(Phase::Latest, None, None)), "You're on the latest version (easy-study 0.5.0).");
            assert_eq!(nothing_found(&s(Phase::Error, Some(en.network), None)), format!("Couldn't check for updates: {}", en.network));
            assert_eq!(nothing_found(&s(Phase::Idle, None, None)), en.other);
            let stuck = (en.did_not_take)("0.5.0");
            assert_eq!(stuck, "The update didn't finish (this is still 0.5.0). Install it yourself from the download page.");
            assert_eq!(nothing_found(&s(Phase::Error, Some(&stuck), Some(en.network))), stuck);
        });
        assert!(says_update_failed("업데이트하지 못했어요. 잠시 뒤") && says_update_failed("Couldn't update. Try again later"));
        assert!(!says_update_failed(u.network) && !says_update_failed(i18n::texts(i18n::Lang::En).update.network));
    }

    #[test]
    fn stale_updater_folders() {
        assert!(is_plugin_leftover("tauri_current_appAbC123") && is_plugin_leftover("tauri_updated_app9x"));
        assert!(!is_plugin_leftover("easy-study") && !is_plugin_leftover("tauri_rpm_update1"));
        assert_eq!(windows_leftover("easy-study-0.5.1-updater-a1b2c3", "easy-study"), Some(semver::Version::new(0, 5, 1)));
        assert_eq!(windows_leftover("easy-study-0.5.0-e2e.2-updater-x", "easy-study").map(|v| v.to_string()).as_deref(), Some("0.5.0-e2e.2"));
        assert_eq!(windows_leftover("other-0.5.1-updater-x", "easy-study"), None);
        assert_eq!(windows_leftover("easy-study-notes", "easy-study"), None);
    }

    #[test]
    fn notes_are_trimmed_plain_text() {
        assert_eq!(plain_notes("  \n "), None);
        assert_eq!(plain_notes(" 고친 점\n- 하나 ").as_deref(), Some("고친 점\n- 하나"));
        assert_eq!(plain_notes(&"가".repeat(3000)).unwrap().chars().count(), NOTES_MAX);
    }
}
