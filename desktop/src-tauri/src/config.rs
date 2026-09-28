//! The shell's own settings (desktop.json in the app config dir), its folders and its log (DESIGN §19).
//!
//! Test overrides (never set by the app itself):
//! - `EASY_STUDY_DESKTOP_HOME=<dir>`: config, logs and the default library live under <dir> instead of the
//!   OS app folders (the WebView's own storage — cookies, localStorage — still uses the OS location);
//! - `EASY_STUDY_DESKTOP_LIBRARY=<dir>`: the library folder, whatever the settings say.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const ENV_HOME: &str = "EASY_STUDY_DESKTOP_HOME";
pub const ENV_LIBRARY: &str = "EASY_STUDY_DESKTOP_LIBRARY";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// What opens at launch ("다음에도 바로 연결"): "local", "remote" or "" (the chooser).
    #[serde(default)]
    pub mode: String,
    /// The last remote server, origin only (the access code is never stored).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// The local server's port: the same port keeps the page origin, and with it localStorage and cookies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// A library folder the user picked; None = <app data dir>/library.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    /// The app's theme: "" = the system's, "light" or "dark" (every window, the chooser and the pages).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub theme: String,
    /// Automatic update checks at launch and every 6 hours (None = on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_check: Option<bool>,
    /// The version an in-app update was installed from (set just before the install, read once at the next launch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_from: Option<String>,
    /// Set before a remembered connection opens at launch, cleared once its page has been up for a while (or the
    /// app quit normally): still set at the next launch means the app died right after connecting, and the
    /// chooser comes first.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_connect_pending: bool,
    /// Fields this build does not know (written by a newer version): kept when an older build rewrites the file.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The theme setting as Tauri's (None = the system's).
pub fn theme(cfg: &Config) -> Option<tauri::Theme> {
    match cfg.theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

/// Where the local server keeps its library, and why.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub path: PathBuf,
    pub is_default: bool,
    pub from_env: bool,
}

/// Serializes read-modify-write of desktop.json (commands run on several threads).
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn ensure(dir: PathBuf) -> PathBuf {
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn config_dir(app: &AppHandle) -> PathBuf {
    ensure(match env_dir(ENV_HOME) {
        Some(h) => h.join("config"),
        None => app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("easy-study")),
    })
}

pub fn log_dir(app: &AppHandle) -> PathBuf {
    ensure(match env_dir(ENV_HOME) {
        Some(h) => h.join("logs"),
        None => app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir().join("easy-study")),
    })
}

/// App data (the default library). The local data dir: the same folder as the app data dir on macOS and
/// Linux, and %LOCALAPPDATA% instead of the roaming %APPDATA% on Windows (a library can be large).
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = ensure(match env_dir(ENV_HOME) {
        Some(h) => h.join("data"),
        None => app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("easy-study")),
    });
    // Lecture PDFs, notes and (Linux) the WebView's cookie file live here: owner only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        });
    }
    dir
}

pub fn default_library(app: &AppHandle) -> PathBuf {
    data_dir(app).join("library")
}

fn config_file(app: &AppHandle) -> PathBuf {
    config_dir(app).join("desktop.json")
}

/// Whether the settings file exists (false on the very first launch).
pub fn exists(app: &AppHandle) -> bool {
    config_file(app).is_file()
}

pub fn load(app: &AppHandle) -> Config {
    fs::read(config_file(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Loads, changes and saves the settings (atomically: temp file + rename).
pub fn update(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Config {
    let _guard = lock(&CONFIG_LOCK);
    let mut cfg = load(app);
    change(&mut cfg);
    let path = config_file(app);
    let tmp = path.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec_pretty(&cfg) {
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
    cfg
}

pub fn library(app: &AppHandle, cfg: &Config) -> Library {
    if let Some(dir) = env_dir(ENV_LIBRARY) {
        let path = std::path::absolute(&dir).unwrap_or(dir);
        return Library { path, is_default: false, from_env: true };
    }
    match cfg.library.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => Library { path: PathBuf::from(p), is_default: false, from_env: false },
        None => Library { path: default_library(app), is_default: true, from_env: false },
    }
}

fn stamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

/// Appends a line to `file` (in the log dir).
pub fn append_log(file: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{line}");
    }
}

/// The shell's own log: <log dir>/shell.log.
pub fn log(app: &AppHandle, msg: &str) {
    append_log(&log_dir(app).join("shell.log"), &format!("[{}] {msg}", stamp()));
}

/// Keeps a log file below `max` bytes across launches (one previous generation: <name>.1).
pub fn rotate(file: &Path, max: u64) {
    if fs::metadata(file).map(|m| m.len() > max).unwrap_or(false) {
        let _ = fs::rename(file, file.with_extension("log.1"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_written_by_a_newer_build_survive_a_rewrite() {
        let newer = r#"{"mode":"local","port":5351,"theme":"dark","updateCheck":false,"futureSetting":{"a":[1,2]},"other":"x"}"#;
        let mut cfg: Config = serde_json::from_str(newer).unwrap();
        assert_eq!((cfg.mode.as_str(), cfg.port, cfg.theme.as_str(), cfg.update_check), ("local", Some(5351), "dark", Some(false)));
        assert_eq!(theme(&cfg), Some(tauri::Theme::Dark));
        cfg.mode = String::new();
        let written: serde_json::Value = serde_json::to_value(&cfg).unwrap();
        assert_eq!(written["futureSetting"], serde_json::json!({ "a": [1, 2] }));
        assert_eq!(written["other"], "x");
        assert_eq!(written["mode"], "");
        // Defaults stay out of the file.
        let plain: serde_json::Value = serde_json::to_value(Config::default()).unwrap();
        assert_eq!(plain, serde_json::json!({ "mode": "" }));
        assert_eq!(theme(&Config::default()), None);
        let pending: Config = serde_json::from_str(r#"{"mode":"remote","autoConnectPending":true,"updatedFrom":"0.5.0"}"#).unwrap();
        assert!(pending.auto_connect_pending && pending.extra.is_empty());
        assert_eq!(pending.updated_from.as_deref(), Some("0.5.0"));
    }
}
