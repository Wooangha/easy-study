//! PATH for the local server, and through it for the claude / codex CLIs (DESIGN §19).
//!
//! An app started from Finder, the Dock or a desktop launcher gets a minimal PATH
//! (/usr/bin:/bin:/usr/sbin:/sbin on macOS) without ~/.local/bin, Homebrew or npm's global folder. The PATH is
//! what the user's interactive login shell sets (`$SHELL -ilc`, between marker lines, 3 s timeout), then the
//! inherited PATH, then known install folders that exist. The login shell starts first thing in main() so it
//! overlaps Tauri's startup; the value of the previous launch (path-cache.txt) is used at once when there is
//! one, and the cache is refreshed in the background. Windows: GUI apps inherit the user's PATH from Explorer.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
#[cfg(unix)]
use std::time::{Duration, Instant};

use crate::config::lock;

#[cfg(unix)]
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// (PATH, how it was obtained) once known.
static RESOLVED: Mutex<Option<(String, String)>> = Mutex::new(None);
static READY: Condvar = Condvar::new();
/// This launch's freshly resolved PATH, and the cache file to write it to (set in setup).
static FRESH: OnceLock<String> = OnceLock::new();
static CACHE_FILE: OnceLock<PathBuf> = OnceLock::new();

fn publish(path: String, how: String) {
    let mut resolved = lock(&RESOLVED);
    if resolved.is_none() {
        *resolved = Some((path, how));
        READY.notify_all();
    }
}

fn write_cache(file: &Path, path: &str) {
    let tmp = file.with_extension("txt.tmp");
    if fs::write(&tmp, path).is_ok() {
        let _ = fs::rename(tmp, file);
    }
}

/// Starts resolving on a background thread (call first thing in main()).
pub fn start_resolving() {
    std::thread::spawn(|| {
        let (path, how) = resolve();
        let _ = FRESH.set(path.clone());
        if let Some(file) = CACHE_FILE.get() {
            write_cache(file, &path);
        }
        publish(path, how);
    });
}

/// Called from setup once the config dir is known: the previous launch's PATH is used right away unless
/// this launch's value is already there.
pub fn use_cache(file: PathBuf) {
    let _ = CACHE_FILE.set(file.clone());
    if let Some(fresh) = FRESH.get() {
        write_cache(&file, fresh);
    } else if let Ok(cached) = fs::read_to_string(&file) {
        let cached = cached.trim();
        if !cached.is_empty() {
            publish(cached.to_string(), "cached from the previous launch (refreshing in the background)".into());
        }
    }
}

/// Linux AppImage: the mounted (or extracted) image the app runs from ($APPDIR). None elsewhere.
#[cfg(unix)]
pub fn appimage_dir() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    std::env::var("APPDIR").ok().filter(|d| d.len() > 1 && d.starts_with('/'))
}

/// The AppImage runtime and its GTK hook point many variables into the image (LD_LIBRARY_PATH, PYTHONHOME,
/// GTK/GIO/GDK/XDG paths…). Programs of the user's own system — the login shell that tells the PATH (and the
/// rc files it runs), the server, the claude/codex CLIs and the browsers those open — get the environment
/// without them: list values keep their entries outside the image, other values that point into it are dropped.
#[cfg(unix)]
pub fn appimage_clean_env(appdir: &str) -> Vec<(String, String)> {
    clean_env(std::env::vars(), appdir)
}

#[cfg(unix)]
fn clean_env(vars: impl Iterator<Item = (String, String)>, appdir: &str) -> Vec<(String, String)> {
    const DROP: &[&str] = &["GDK_BACKEND", "GTK_THEME", "APPDIR", "APPIMAGE", "APPIMAGE_EXTRACT_AND_RUN", "ARGV0", "OWD"];
    vars.filter(|(k, _)| !DROP.contains(&k.as_str()))
        .filter_map(|(k, v)| {
            if !v.contains(appdir) {
                return Some((k, v));
            }
            let kept = without_dir(&v, appdir);
            (v.contains(':') && !kept.is_empty()).then_some((k, kept))
        })
        .collect()
}

/// A colon-separated list without its empty entries and those inside `dir`.
#[cfg(unix)]
pub fn without_dir(list: &str, dir: &str) -> String {
    list.split(':').filter(|e| !e.is_empty() && !e.starts_with(dir)).collect::<Vec<_>>().join(":")
}

/// Blocks until a PATH is known (at most the login shell's timeout on the first launch).
pub fn wait() -> (String, String) {
    let mut resolved = lock(&RESOLVED);
    loop {
        if let Some(value) = resolved.as_ref() {
            return value.clone();
        }
        resolved = READY.wait(resolved).unwrap_or_else(|e| e.into_inner());
    }
}

#[cfg(windows)]
fn resolve() -> (String, String) {
    let mut dirs: Vec<String> = std::env::var("PATH").unwrap_or_default().split(';').map(String::from).collect();
    for (var, sub) in [("USERPROFILE", ".local\\bin"), ("APPDATA", "npm")] {
        if let Some(base) = std::env::var_os(var) {
            dirs.push(PathBuf::from(base).join(sub).to_string_lossy().into_owned());
        }
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.trim().is_empty() && seen.insert(d.to_lowercase()) && Path::new(d).is_dir());
    (dirs.join(";"), "inherited (Windows)".into())
}

#[cfg(unix)]
fn resolve() -> (String, String) {
    let started = Instant::now();
    let from_shell = login_shell_path(SHELL_TIMEOUT);
    let how = match &from_shell {
        Some(_) => format!("login shell ({}) in {} ms", user_shell(), started.elapsed().as_millis()),
        None => format!("login shell ({}) failed or timed out after {} ms: inherited PATH + known folders", user_shell(), started.elapsed().as_millis()),
    };
    let home = std::env::var("HOME").unwrap_or_default();
    // In an AppImage the inherited PATH starts with the image's usr/bin: not a folder of the user's system.
    let appdir = appimage_dir();
    let mut dirs: Vec<String> = Vec::new();
    if let Some(p) = from_shell {
        dirs.extend(p.split(':').map(String::from));
    }
    dirs.extend(std::env::var("PATH").unwrap_or_default().split(':').map(String::from));
    if let Some(prefix) = npm_prefix(&home) {
        dirs.push(format!("{prefix}/bin"));
    }
    for d in [
        format!("{home}/.local/bin"),    // claude's native installer
        format!("{home}/.claude/local"), // older claude installs
        format!("{home}/.npm-global/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/bin"),
        "/opt/homebrew/bin".into(), // Homebrew, Apple silicon (codex)
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(), // Homebrew (Intel), npm's default global prefix
        "/opt/local/bin".into(), // MacPorts
        "/home/linuxbrew/.linuxbrew/bin".into(),
        format!("{home}/.linuxbrew/bin"),
        "/snap/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
    ] {
        dirs.push(d);
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| {
        d.starts_with('/') && !appdir.as_deref().is_some_and(|a| d.starts_with(a)) && seen.insert(d.clone()) && Path::new(d).is_dir()
    });
    (dirs.join(":"), how)
}

/// npm's global prefix from NPM_CONFIG_PREFIX or ~/.npmrc (`prefix=…`), without running npm.
#[cfg(unix)]
fn npm_prefix(home: &str) -> Option<String> {
    let raw = std::env::var("NPM_CONFIG_PREFIX").ok().filter(|s| !s.trim().is_empty()).or_else(|| {
        fs::read_to_string(format!("{home}/.npmrc")).ok()?.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "prefix").then(|| value.trim().trim_matches('"').to_string())
        })
    })?;
    let expanded = raw.replace("${HOME}", home).replace("$HOME", home);
    Some(match expanded.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => expanded,
    })
}

/// The user's login shell: $SHELL, else the passwd entry, else /bin/sh.
#[cfg(unix)]
fn user_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if s.starts_with('/') {
            return s;
        }
    }
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_shell.is_null() {
            if let Ok(s) = std::ffi::CStr::from_ptr((*pw).pw_shell).to_str() {
                if s.starts_with('/') {
                    return s.to_string();
                }
            }
        }
    }
    "/bin/sh".into()
}

/// PATH as an interactive login shell sets it. Markers survive whatever the rc files print; `printenv` joins
/// fish's list PATH with colons too. stdin is /dev/null; the shell runs in its own process group, killed on
/// timeout together with anything its rc files started.
#[cfg(unix)]
fn login_shell_path(timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    const BEGIN: &str = "__EASY_STUDY_PATH_BEGIN__";
    const END: &str = "__EASY_STUDY_PATH_END__";
    let mut cmd = Command::new(user_shell());
    if let Some(appdir) = appimage_dir() {
        // The rc files run with the user's own environment, not the AppImage's libraries and paths.
        cmd.env_clear().envs(appimage_clean_env(&appdir));
    }
    // Linux: the CA paths the shell set for the updater (update::keep_ssl_env), unless they were the user's own.
    for key in crate::update::ssl_env_not_from_user() {
        cmd.env_remove(key);
    }
    let mut child = cmd
        .args(["-i", "-l", "-c", &format!("printf '%s' {BEGIN}; printenv PATH; printf '%s' {END}")])
        .env("EASY_STUDY_RESOLVING_SHELL_ENV", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let pgid = child.id() as libc::pid_t;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match out.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    // Stop at the end marker: a daemon started by an rc file may keep stdout open.
                    if String::from_utf8_lossy(&buf).contains(END) {
                        break;
                    }
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    let deadline = Instant::now() + timeout;
    let text = rx.recv_timeout(timeout).ok();
    // Give the shell until the deadline (at least 200 ms) to exit, then end its group. The shell is not reaped
    // before the kill, so its pid (= the group id) cannot have been reused.
    let grace = deadline.max(Instant::now() + Duration::from_millis(200));
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < grace => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
                let _ = child.wait();
                break;
            }
        }
    }
    let text = text?;
    let start = text.find(BEGIN)? + BEGIN.len();
    let end = start + text[start..].find(END)?;
    let path = text[start..end].trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn appimage_variables_are_cleaned() {
        let appdir = "/tmp/.mount_easy-AbC123";
        let vars = [
            ("PATH", "/tmp/.mount_easy-AbC123/usr/bin/:/home/me/.local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_easy-AbC123/usr/lib/:/tmp/.mount_easy-AbC123/usr/lib/aarch64-linux-gnu"),
            ("PYTHONHOME", "/tmp/.mount_easy-AbC123/usr/"),
            ("XDG_DATA_DIRS", "/tmp/.mount_easy-AbC123/usr/share/:/usr/local/share:/usr/share"),
            ("APPDIR", appdir),
            ("APPIMAGE", "/home/me/easy-study.AppImage"),
            ("HOME", "/home/me"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let cleaned = clean_env(vars.into_iter(), appdir);
        let get = |k: &str| cleaned.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), Some("/home/me/.local/bin:/usr/bin"));
        assert_eq!(get("XDG_DATA_DIRS"), Some("/usr/local/share:/usr/share"));
        assert_eq!(get("LD_LIBRARY_PATH"), None);
        assert_eq!(get("PYTHONHOME"), None);
        assert_eq!(get("APPDIR"), None);
        assert_eq!(get("APPIMAGE"), None);
        assert_eq!(get("HOME"), Some("/home/me"));
        assert_eq!(without_dir("::/a/bin:/tmp/.mount_x/usr/bin:/b", "/tmp/.mount_x"), "/a/bin:/b");
    }
}
