//! "이 컴퓨터에서 실행": the bundled easy-study server (DESIGN §19).
//!
//! The shell runs the bundled official Node with the packed server in desktop mode (EASY_STUDY_DESKTOP=1):
//! the server prints `EASY_STUDY_READY {"url":…,"port":…}` once it listens, and stops by itself when its stdin
//! reaches EOF — the shell keeps the write end of that pipe, so the server also stops when the app crashes or
//! is killed, on every OS. Backstops: POSIX process group (killed after the server exits), Linux
//! PR_SET_PDEATHSIG, Windows Job Object with KILL_ON_JOB_CLOSE. Errors before listening (e.g. the library is
//! locked by `npm start`) come on stderr in Korean; the chooser shows the last lines.
//!
//! Lecture recordings (DESIGN §22): the server transcribes with the bundled whisper-cli and decodes uploads with
//! the bundled ffmpeg; the shell passes their paths (EASY_STUDY_WHISPER, EASY_STUDY_FFMPEG) and the folder for the
//! downloaded speech models (EASY_STUDY_MODELS_DIR = <app data dir>/models, next to the default library).
//!
//! "다른 기기에서 접속 허용" (share.rs, DESIGN §16/§19): with EASY_STUDY_DESKTOP_SHARE=1 the server binds every
//! interface in remote mode — the login on, a generated access code in the library's .auth.json — and its ready
//! line adds `"share":{"urls":[…]}`, the addresses other devices can use. The shell reads the code from that file
//! on demand (access_code) and logs its own window in through `GET /login?code=` (loopback is never
//! authentication): the code never goes on stdout (server.log copies it), into shell.log or into desktop.json.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::config::{self, lock};
use crate::{i18n, pathenv, remote, AppState};

/// The local server's preferred ports (not 5180, which `npm start` uses); the last one used is remembered.
const PREFERRED_PORTS: std::ops::RangeInclusive<u16> = 5350..=5359;
const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a graceful stop may take (the server's own force-exit is at 8 s).
const STOP_GRACE: Duration = Duration::from_secs(9);
const TAIL_LINES: usize = 40;
const LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// At most this many addresses from the ready line's `share.urls`.
const SHARE_URLS_MAX: usize = 32;
/// A port another program holds (server/desktop.ts EXIT_PORT_IN_USE, and its stderr message from
/// startupFailureMessage for older packed servers): the shell then tries once more on another port. A loopback
/// test-bind cannot tell (SO_REUSEADDR lets a wildcard and a loopback listener share a port on macOS), so the
/// server's own answer is what counts.
const EXIT_PORT_IN_USE: i32 = 3;
const PORT_TAKEN_MARK: &str = "다른 프로그램이 이미 쓰고 있어서";

/// Variables of the user's environment the server (and the relay, proxy.rs) must not inherit: the shell decides
/// port, host, library, login and sharing, and NODE_OPTIONS could change how the bundled Node runs.
pub(crate) const STRIP_ENV: &[&str] = &[
    "PORT",
    "EASY_STUDY_HOST",
    "EASY_STUDY_AUTH",
    "EASY_STUDY_PASSWORD",
    "EASY_STUDY_TLS_CERT",
    "EASY_STUDY_TLS_KEY",
    "EASY_STUDY_LIBRARY",
    "EASY_STUDY_DESKTOP_HOME",
    "EASY_STUDY_DESKTOP_LIBRARY",
    "EASY_STUDY_DESKTOP_SHARE",
    "EASY_STUDY_DESKTOP_RESET_CODE",
    "EASY_STUDY_DESKTOP_FORCE_PROXY",
    "EASY_STUDY_DESKTOP_SMOKE",
    "EASY_STUDY_DESKTOP_SMOKE_TIMEOUT",
    "EASY_STUDY_DESKTOP_SMOKE_URL",
    "EASY_STUDY_DESKTOP_SMOKE_CODE",
    "EASY_STUDY_DESKTOP_SMOKE_ASR",
    "EASY_STUDY_DESKTOP_SMOKE_WRITE",
    "NODE_OPTIONS",
    "WATCH_REPORT_DEPENDENCIES",
];

/// The variable that turns the bundled server's share mode on (server/desktop.ts desktopServerOptions).
const ENV_SHARE: &str = "EASY_STUDY_DESKTOP_SHARE";
/// One start with a new access code, every device logged out (server/desktop.ts → resetAccessCode).
const ENV_RESET_CODE: &str = "EASY_STUDY_DESKTOP_RESET_CODE";

pub struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    /// The server printed EASY_STUDY_READY: it stops by itself when its stdin closes.
    aware: Arc<AtomicBool>,
    pub library: PathBuf,
    /// The port it was started on (a port another program holds is tried once more elsewhere).
    port: u16,
}

/// What the ready line says.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Ready {
    /// `http://127.0.0.1:<port>`.
    pub url: String,
    /// Share mode: the addresses other devices can use (None: local mode).
    pub share: Option<Vec<String>>,
}

/// Starts the local server in the background (or shows it when it already runs). Never blocks.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    if let Some(url) = lock(&st.server_url).clone() {
        let shared = lock(&st.share_urls).is_some();
        crate::go_to(app, &page_url(app, &url, shared));
        return Ok(());
    }
    if st.starting.swap(true, SeqCst) {
        return Ok(()); // already starting
    }
    *lock(&st.error) = None;
    lock(&st.tail).clear();
    *lock(&st.busy) = Some(i18n::msg().server.starting.into());
    let h = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = spawn_server(&h) {
            config::log(&h, &format!("server start failed: {e}"));
            let st = h.state::<AppState>();
            st.start_ended();
            *lock(&st.error) = Some(e);
            crate::show_chooser(&h);
            crate::smoke_fail(&h, 2, "server did not start");
        }
    });
    Ok(())
}

fn spawn_server(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    let (path_env, how) = pathenv::wait();
    // A server that is being stopped finishes first: it holds the library lock and maybe the port.
    let _life = lock(&st.lifecycle);
    if !st.starting.load(SeqCst) {
        st.start_ended(); // cancelled meanwhile (another computer was chosen, the library changed)
        return Ok(());
    }
    let m = i18n::msg();
    let res = app.path().resource_dir().map_err(|e| (m.common.no_resource_dir)(&e.to_string()))?;
    let node = node_path(&res);
    if !node.is_file() {
        return Err((m.common.no_node)(&node.display().to_string()));
    }
    let server_dir = res.join("server");
    let entry = server_dir.join("dist-server").join("server").join("index.js");
    if !entry.is_file() {
        return Err((m.server.no_entry)(&entry.display().to_string()));
    }
    let cfg = config::load(app);
    let library = config::library(app, &cfg);
    fs::create_dir_all(&library.path)
        .map_err(|e| (m.server.no_library)(&library.path.display().to_string(), &e.to_string()))?;
    let tools = Tools::find(&res, config::data_dir(app).join("models"));
    let _ = fs::create_dir_all(&tools.models);
    let port = pick_port(cfg.port, *lock(&st.failed_port));
    config::update(app, |c| c.port = Some(port));
    let sharing = Sharing { on: cfg.share, reset_code: st.reset_code_pending.swap(false, SeqCst) };

    let log_file = config::log_dir(app).join("server.log");
    config::rotate(&log_file, LOG_MAX_BYTES);

    let mut cmd = Command::new(&node);
    cmd.arg("--max-semi-space-size=2")
        .arg(&entry)
        .current_dir(&server_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    child_env(&mut cmd, &path_env, port, &library.path, &tools, sharing);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // node leads its own group: its children can be cleaned up with it
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window for node.exe
    }
    let t = Instant::now();
    let mut child = spawn(cmd).map_err(|e| (m.server.spawn_failed)(&e.to_string(), &node.display().to_string()))?;
    #[cfg(windows)]
    winjob::kill_with_parent(&child);
    let generation = st.generation.fetch_add(1, SeqCst) + 1;
    config::log(
        app,
        &format!(
            "spawned server pid {} port {port} in {} ms; library {}; {}; shared {}{}; PATH ({how}): {path_env}",
            child.id(),
            t.elapsed().as_millis(),
            library.path.display(),
            tools.describe(),
            sharing.on,
            if sharing.reset_code { " (new access code)" } else { "" }
        ),
    );
    config::append_log(&log_file, &format!("---- easy-study desktop: server pid {} port {port} library {}", child.id(), library.path.display()));

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let aware = Arc::new(AtomicBool::new(false));
    *lock(&st.server) = Some(Running { child, stdin, aware: aware.clone(), library: library.path.clone(), port });
    drop(_life);

    let (stderr_done, stderr_finished) = mpsc::channel::<()>();
    let tail = st.tail.clone();
    let err_log = log_file.clone();
    std::thread::spawn(move || {
        for_each_line(stderr, |line| {
            config::append_log(&err_log, &format!("[stderr] {line}"));
            let mut tail = lock(&tail);
            tail.push_back(line.chars().take(500).collect());
            while tail.len() > TAIL_LINES {
                tail.pop_front();
            }
        });
        let _ = stderr_done.send(());
    });

    let h = app.clone();
    std::thread::spawn(move || {
        let mut ready = false;
        for_each_line(stdout, |line| {
            config::append_log(&log_file, &line);
            if !ready {
                if let Some(parsed) = parse_ready(&line) {
                    ready = true;
                    aware.store(true, SeqCst);
                    on_ready(&h, generation, parsed);
                }
            }
        });
        // stdout closed: the server exited (or is exiting). Let stderr's last lines arrive first.
        let _ = stderr_finished.recv_timeout(Duration::from_secs(1));
        on_exit(&h, generation, ready);
    });

    let h = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
            let st = h.state::<AppState>();
            if st.generation.load(SeqCst) != generation || !st.starting.load(SeqCst) {
                return;
            }
        }
        let st = h.state::<AppState>();
        if st.generation.load(SeqCst) == generation && st.starting.load(SeqCst) {
            *lock(&st.error) = Some((i18n::msg().server.not_ready)(READY_TIMEOUT.as_secs()));
            stop(&h);
            crate::show_chooser(&h);
            crate::smoke_fail(&h, 2, "server not ready in time");
        }
    });
    Ok(())
}

/// Reads `reader` line by line (lossy UTF-8, so odd bytes never stop the draining) until EOF.
pub(crate) fn for_each_line(reader: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string()),
        }
    }
}

/// The ready line `EASY_STUDY_READY {"url":…,"port":…[,"share":{"urls":[…]}]}` (the banner before it is not
/// enough: only the ready line says the server stops by itself on stdin EOF). The relay (proxy.rs) prints the
/// same shape without `share`.
pub(crate) fn parse_ready(line: &str) -> Option<Ready> {
    let rest = line.strip_prefix("EASY_STUDY_READY ")?;
    let v: serde_json::Value = serde_json::from_str(rest.trim()).ok()?;
    let url = Url::parse(v.get("url")?.as_str()?).ok()?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return None;
    }
    Some(Ready { url: url.as_str().trim_end_matches('/').to_string(), share: v.get("share").map(share_urls) })
}

/// The URL of a ready line (proxy.rs).
pub(crate) fn ready_url(line: &str) -> Option<String> {
    parse_ready(line).map(|r| r.url)
}

/// `share.urls` of the ready line, as shown to the user: at most SHARE_URLS_MAX, each an http URL with a
/// non-loopback host (anything else is dropped), IP addresses before names. A bare computer name (no dot) is
/// left out on Windows, where other devices rarely resolve it.
fn share_urls(share: &serde_json::Value) -> Vec<String> {
    let Some(list) = share.get("urls").and_then(|u| u.as_array()) else { return Vec::new() };
    let mut ips = Vec::new();
    let mut names = Vec::new();
    for url in list.iter().take(SHARE_URLS_MAX).filter_map(|u| u.as_str()).filter_map(|s| Url::parse(s).ok()) {
        if url.scheme() != "http" || url.path() != "/" || url.query().is_some() {
            continue;
        }
        let shown = url.as_str().trim_end_matches('/').to_string();
        let Some(host) = url.host_str() else { continue };
        match host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
            Ok(ip) if !ip.is_loopback() && !ip.is_unspecified() => ips.push(shown),
            Ok(_) => {}
            Err(_) if !host.eq_ignore_ascii_case("localhost") && (!cfg!(windows) || host.contains('.')) => names.push(shown),
            Err(_) => {}
        }
    }
    ips.extend(names);
    ips
}

/// The running local server's access code (share mode): `code` of `<library>/.auth.json`, the file the server
/// owns. Read on demand and never kept anywhere else: not in a log line, not in desktop.json.
pub fn access_code(app: &AppHandle) -> Option<String> {
    let library = lock(&app.state::<AppState>().server).as_ref()?.library.clone();
    let text = fs::read_to_string(library.join(".auth.json")).ok()?;
    code_in(&text)
}

/// `code` of an .auth.json's text, when it looks like one the server generates (4 groups of 5 Crockford base32
/// characters, e.g. `k7qm2-x9fda-3hz8w-p0rtc`): a code that somebody edited into the file is not shown.
fn code_in(auth_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(auth_json).ok()?;
    let code = v.get("code")?.as_str()?;
    valid_code(code).then(|| code.to_string())
}

/// `^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$` (server/auth.ts generateAccessCode).
fn valid_code(code: &str) -> bool {
    let group_ok = |g: &str| g.len() == 5 && g.chars().all(|c| c.is_ascii_digit() || (c.is_ascii_lowercase() && !matches!(c, 'i' | 'l' | 'o' | 'u')));
    let groups: Vec<&str> = code.split('-').collect();
    groups.len() == 4 && groups.iter().all(|g| group_ok(g))
}

/// What the window opens for the running local server. Share mode: the login is on for everyone, this window
/// included, so the shell logs itself in with the code it can read from the library (`/login?code=`: the 303 sets
/// the session cookie and drops the code from the address bar); a loopback bypass in the server would let any
/// loopback peer in (DESIGN §16). Otherwise the bare URL.
fn page_url(app: &AppHandle, url: &str, shared: bool) -> String {
    match shared.then(|| access_code(app)).flatten() {
        Some(code) => remote::login_url(url, &code).unwrap_or_else(|_| url.to_string()),
        None => {
            if shared {
                config::log(app, "no access code in the library's .auth.json: the page shows the login screen");
            }
            url.to_string()
        }
    }
}

fn on_ready(app: &AppHandle, generation: u64, ready: Ready) {
    let st = app.state::<AppState>();
    if st.generation.load(SeqCst) != generation {
        return;
    }
    // A restart for a change made in the chooser (share.rs): the chooser stays, with the addresses and the code.
    let stay = st.stay_on_chooser.load(SeqCst);
    let Ready { url, share } = ready;
    let shared = share.is_some();
    let wanted = config::load(app).share;
    if shared != wanted {
        // A toggle while the server was starting: the setting applies at the next start (share.rs refuses it then).
        config::log(app, &format!("server ready shared {shared}, but the setting says {wanted}: it applies at the next start"));
    }
    *lock(&st.share_urls) = share;
    *lock(&st.server_url) = Some(url.clone());
    st.start_ended();
    config::log(app, &format!("server ready {url}{}{}", if shared { " (shared)" } else { "" }, if stay { ", the chooser stays" } else { "" }));
    if stay {
        return;
    }
    let target = page_url(app, &url, shared);
    crate::go_to(app, &target);
}

fn on_exit(app: &AppHandle, generation: u64, was_ready: bool) {
    let st = app.state::<AppState>();
    if st.quitting.load(SeqCst) {
        return;
    }
    let life = lock(&st.lifecycle);
    if st.generation.load(SeqCst) != generation {
        return; // stopped on purpose, or replaced by a newer server
    }
    let Some(mut running) = lock(&st.server).take() else { return };
    let status = wait_for(&mut running.child, Duration::from_secs(3)).or_else(|| force_kill(&mut running.child));
    #[cfg(unix)]
    kill_group(&running.child);
    st.generation.fetch_add(1, SeqCst);
    st.start_ended();
    *lock(&st.server_url) = None;
    *lock(&st.share_urls) = None;
    let how = describe(status);
    config::log(app, &format!("server exited on its own ({how}), ready: {was_ready}"));
    // Another program holds the port (a LAN-side listener the loopback test-bind could not see, say): once more
    // on another port, this launch.
    let port_taken = !was_ready
        && (status.and_then(|s| s.code()) == Some(EXIT_PORT_IN_USE) || lock(&st.tail).iter().any(|l| l.contains(PORT_TAKEN_MARK)));
    if port_taken && lock(&st.failed_port).is_none() {
        *lock(&st.failed_port) = Some(running.port);
        config::update(app, |c| c.port = None);
        config::log(app, &format!("port {} is taken: trying another port", running.port));
        drop(life);
        return start(app).unwrap_or_else(|e| {
            *lock(&st.error) = Some(e);
            crate::show_chooser(app);
            crate::smoke_fail(app, 2, "server did not start");
        });
    }
    let texts = &i18n::msg().server;
    *lock(&st.error) = Some(if was_ready { (texts.exited)(&how) } else { (texts.not_started)(&how) });
    drop(life);
    crate::show_chooser(app);
    crate::smoke_fail(app, 2, "server exited");
}

/// Stops the local server if one runs: closes its stdin (desktop mode: graceful shutdown), waits, then kills
/// what is left. Blocks for up to STOP_GRACE.
pub fn stop(app: &AppHandle) {
    let st = app.state::<AppState>();
    let _life = lock(&st.lifecycle);
    st.generation.fetch_add(1, SeqCst);
    // Also after the ready timeout: the chooser that comes back must not stay "busy" (and disabled) for good.
    st.start_ended();
    *lock(&st.server_url) = None;
    *lock(&st.share_urls) = None;
    let Some(mut running) = lock(&st.server).take() else { return };
    let t = Instant::now();
    let pid = running.child.id();
    drop(running.stdin.take());
    let aware = running.aware.load(SeqCst);
    #[cfg(unix)]
    if !aware {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM); // no desktop mode: its SIGTERM handler
        }
    }
    let grace = if aware || cfg!(unix) { STOP_GRACE } else { Duration::from_millis(500) };
    let status = wait_for(&mut running.child, grace).or_else(|| force_kill(&mut running.child));
    #[cfg(unix)]
    kill_group(&running.child);
    config::log(app, &format!("server pid {pid} stopped in {} ms ({})", t.elapsed().as_millis(), describe(status)));
}

pub(crate) fn wait_for(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => return None,
        }
    }
}

pub(crate) fn force_kill(child: &mut Child) -> Option<ExitStatus> {
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    let _ = child.kill();
    child.wait().ok()
}

/// Whatever is left of the server's process group (a CLI it could not stop). Safe after the server was
/// reaped: a process group id is not reused while the group has members.
#[cfg(unix)]
pub(crate) fn kill_group(child: &Child) {
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
}

/// How a process ended, in the shell's language (it goes into the chooser's errors; shell.log has it too).
pub(crate) fn describe(status: Option<ExitStatus>) -> String {
    let common = &i18n::msg().common;
    match status {
        Some(s) => match s.code() {
            Some(code) => (common.exit_code)(code),
            None => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = s.signal() {
                        return (common.exit_signal)(sig);
                    }
                }
                s.to_string()
            }
        },
        None => common.exit_unknown.into(),
    }
}

/// Free on loopback, as far as a test-bind can tell (see PORT_TAKEN_MARK for what it cannot).
pub(crate) fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The saved port when free, else the first free preferred one, else any. `avoid`: a port the server could not
/// bind this launch (on_exit), skipped whatever the test-bind says.
fn pick_port(saved: Option<u16>, avoid: Option<u16>) -> u16 {
    let usable = |p: u16| p != 0 && Some(p) != avoid && port_free(p);
    if let Some(p) = saved.filter(|p| usable(*p)) {
        return p;
    }
    if let Some(p) = PREFERRED_PORTS.into_iter().find(|p| usable(*p)) {
        return p;
    }
    TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(0)
}

/// The bundled Node: a resource on macOS and Windows; on Linux the externalBin `es-node` next to the app
/// binary (/usr/bin/es-node in deb/rpm, $APPDIR/usr/bin/es-node in the AppImage).
pub(crate) fn node_path(res: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        res.join("node").join("node.exe")
    }
    #[cfg(target_os = "linux")]
    {
        match beside_app("es-node") {
            Some(p) => p,
            None => res.join("node").join("bin").join("node"),
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        res.join("node").join("bin").join("node")
    }
}

/// A file next to the app binary (Linux externalBins).
#[cfg(target_os = "linux")]
fn beside_app(name: &str) -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(name))).filter(|p| p.is_file())
}

/// A bundled helper program like Node (desktop/scripts/prepare.mjs): a resource `<dir>/<name>[.exe]` on macOS and
/// Windows, the externalBin `es-<dir>` next to the app binary on Linux (/usr/bin/es-whisper, /usr/bin/es-ffmpeg).
/// None when this build has none (a local build without it: the server then looks on PATH).
fn bundled_tool(res: &Path, dir: &str, name: &str) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let _ = (res, name);
        beside_app(&format!("es-{dir}"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        Some(res.join(dir).join(file)).filter(|p| p.is_file())
    }
}

/// What the server needs for lecture recordings (DESIGN §22).
struct Tools {
    /// whisper.cpp's whisper-cli (speech recognition).
    whisper: Option<PathBuf>,
    /// The minimal LGPL ffmpeg (decodes uploaded recordings).
    ffmpeg: Option<PathBuf>,
    /// Where the speech models are downloaded (the app data dir, never the bundle).
    models: PathBuf,
}

impl Tools {
    fn find(res: &Path, models: PathBuf) -> Tools {
        Tools { whisper: bundled_tool(res, "whisper", "whisper-cli"), ffmpeg: bundled_tool(res, "ffmpeg", "ffmpeg"), models }
    }

    /// The server's variables. A path the user set before starting the app wins over the bundled program (an own
    /// build, e.g. for a CPU the bundled one does not support); without either the server looks on PATH.
    fn env(&self, user: impl Fn(&str) -> Option<String>) -> Vec<(&'static str, String)> {
        let mut out = vec![(ENV_MODELS, self.models.to_string_lossy().into_owned())];
        for (key, bundled) in [(ENV_WHISPER, &self.whisper), (ENV_FFMPEG, &self.ffmpeg)] {
            let own = user(key).filter(|v| !v.trim().is_empty());
            if let Some(path) = own.or_else(|| bundled.as_ref().map(|p| p.to_string_lossy().into_owned())) {
                out.push((key, path));
            }
        }
        out
    }

    fn describe(&self) -> String {
        let show = |p: &Option<PathBuf>| p.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "PATH".into());
        format!("whisper {}; ffmpeg {}; models {}", show(&self.whisper), show(&self.ffmpeg), self.models.display())
    }
}

const ENV_WHISPER: &str = "EASY_STUDY_WHISPER";
const ENV_FFMPEG: &str = "EASY_STUDY_FFMPEG";
const ENV_MODELS: &str = "EASY_STUDY_MODELS_DIR";

fn user_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Share mode for one start (server/desktop.ts).
#[derive(Clone, Copy, Debug)]
struct Sharing {
    /// EASY_STUDY_DESKTOP_SHARE=1: every interface, the login on.
    on: bool,
    /// EASY_STUDY_DESKTOP_RESET_CODE=1: a new access code, every device logged out.
    reset_code: bool,
}

/// The environment of a Node child of the shell (the server here, the relay in proxy.rs): the user's own PATH,
/// nothing of STRIP_ENV, and on Linux without the CA paths the shell set for the updater.
pub(crate) fn base_env(cmd: &mut Command, path_env: &str) {
    #[allow(unused_mut)]
    let mut path_value = path_env.to_string();
    #[cfg(target_os = "linux")]
    if let Some(appdir) = pathenv::appimage_dir() {
        cmd.env_clear();
        cmd.envs(pathenv::appimage_clean_env(&appdir));
        path_value = pathenv::without_dir(&path_value, &appdir);
    }
    for key in STRIP_ENV {
        cmd.env_remove(key);
    }
    // Linux: the CA paths the shell set for the updater (update::keep_ssl_env), unless they were the user's own.
    for key in crate::update::ssl_env_not_from_user() {
        cmd.env_remove(key);
    }
    cmd.env("PATH", path_value);
}

fn child_env(cmd: &mut Command, path_env: &str, port: u16, library: &Path, tools: &Tools, sharing: Sharing) {
    base_env(cmd, path_env);
    // EASY_STUDY_HOST stays 127.0.0.1 in every mode: only the dedicated variable turns sharing on (never the
    // user's environment, and the server's "ignored settings" warning stays quiet).
    // EASY_STUDY_LANG: the shell's language (the OS's, i18n.rs), for the startup errors the chooser shows
    // (server/desktop.ts desktopLang). A taken port is still told by EXIT_PORT_IN_USE in either language.
    cmd.env("PORT", port.to_string())
        .env("EASY_STUDY_HOST", "127.0.0.1")
        .env("EASY_STUDY_LIBRARY", library)
        .env("EASY_STUDY_DESKTOP", "1")
        .env("EASY_STUDY_LANG", crate::i18n::lang().id());
    if sharing.on {
        cmd.env(ENV_SHARE, "1");
    }
    if sharing.reset_code {
        cmd.env(ENV_RESET_CODE, "1");
    }
    cmd.envs(tools.env(user_env));
}

/// Linux: PR_SET_PDEATHSIG is tied to the THREAD that forked the child, so every server is spawned by one
/// thread that lives as long as the app.
#[cfg(target_os = "linux")]
pub(crate) fn spawn(mut cmd: Command) -> std::io::Result<Child> {
    use std::os::unix::process::CommandExt;
    use std::sync::OnceLock;
    type Job = (Command, mpsc::Sender<std::io::Result<Child>>);
    static SPAWNER: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
    let parent = std::process::id();
    unsafe {
        cmd.pre_exec(move || {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            if libc::getppid() as u32 != parent {
                return Err(std::io::Error::other("the app exited while starting the server"));
            }
            Ok(())
        });
    }
    let spawner = SPAWNER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("server-spawner".into())
            .spawn(move || {
                for (mut cmd, reply) in rx {
                    let _ = reply.send(cmd.spawn());
                }
            })
            .expect("spawner thread");
        tx
    });
    let (reply, answer) = mpsc::channel();
    spawner.send((cmd, reply)).map_err(|_| std::io::Error::other("spawner thread gone"))?;
    answer.recv().map_err(|_| std::io::Error::other("spawner thread gone"))?
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn spawn(mut cmd: Command) -> std::io::Result<Child> {
    cmd.spawn()
}

#[cfg(windows)]
pub(crate) mod winjob {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Puts the server (and everything it starts) in a job that Windows kills when the app's last handle to it
    /// closes — when the app exits for any reason, End Task and crashes included.
    pub fn kill_with_parent(child: &std::process::Child) {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            AssignProcessToJobObject(job, child.as_raw_handle() as _);
            // The job handle is never closed on purpose: it closes when this process ends.
        }
    }
}

/// The last lines the server wrote on stderr.
pub fn tail(app: &AppHandle) -> Vec<String> {
    let tail: VecDeque<String> = lock(&app.state::<AppState>().tail).clone();
    tail.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line() {
        assert_eq!(
            ready_url(r#"EASY_STUDY_READY {"url":"http://127.0.0.1:5353","port":5353}"#).as_deref(),
            Some("http://127.0.0.1:5353")
        );
        assert_eq!(
            parse_ready(r#"EASY_STUDY_READY {"url":"http://127.0.0.1:5353","port":5353}"#),
            Some(Ready { url: "http://127.0.0.1:5353".into(), share: None })
        );
        assert_eq!(ready_url("  easy-study   →  http://127.0.0.1:5351"), None);
        assert_eq!(ready_url(r#"EASY_STUDY_READY {"url":"http://192.168.0.2:5353"}"#), None);
        assert_eq!(ready_url("EASY_STUDY_READY not json"), None);
        // Share mode: the same URL for this window, plus the addresses for other devices.
        let shared = parse_ready(
            r#"EASY_STUDY_READY {"url":"http://127.0.0.1:5378","port":5378,"share":{"urls":["http://192.168.0.10:5378","http://my-mac.local:5378"]}}"#,
        )
        .unwrap();
        assert_eq!(shared.url, "http://127.0.0.1:5378");
        assert_eq!(shared.share, Some(vec!["http://192.168.0.10:5378".to_string(), "http://my-mac.local:5378".to_string()]));
        // The key without usable addresses still means "shared" (the login is on).
        assert_eq!(parse_ready(r#"EASY_STUDY_READY {"url":"http://127.0.0.1:5378","share":{}}"#).unwrap().share, Some(vec![]));
        assert_eq!(parse_ready(r#"EASY_STUDY_READY {"url":"http://127.0.0.1:5378","share":null}"#).unwrap().share, Some(vec![]));
    }

    #[test]
    fn share_urls_keep_only_addresses_other_devices_can_use() {
        let list = |urls: serde_json::Value| share_urls(&serde_json::json!({ "urls": urls }));
        // Loopback, unspecified, https, other paths, non-strings and garbage are dropped; IPs come before names.
        let shown = list(serde_json::json!([
            "http://127.0.0.1:5378",
            "http://localhost:5378",
            "http://0.0.0.0:5378",
            "http://[::1]:5378",
            "https://192.168.0.10:5378",
            "http://192.168.0.10:5378/x",
            "http://my-mac.local:5378",
            "http://192.168.0.10:5378",
            "http://[fd7a:115c:a1e0::1]:5378",
            "http://10.0.0.5:5378/",
            "http://my-mac:5378",
            "not a url",
            42,
            null
        ]));
        let mut want = vec!["http://192.168.0.10:5378", "http://[fd7a:115c:a1e0::1]:5378", "http://10.0.0.5:5378", "http://my-mac.local:5378"];
        // A bare computer name (no dot) is left out on Windows only.
        if !cfg!(windows) {
            want.push("http://my-mac:5378");
        }
        assert_eq!(shown, want);
        assert_eq!(list(serde_json::json!("nope")), Vec::<String>::new());
        assert_eq!(share_urls(&serde_json::json!({})), Vec::<String>::new());
        let many: Vec<String> = (0..50).map(|i| format!("http://10.0.{i}.1:5378")).collect();
        assert_eq!(list(serde_json::json!(many)).len(), SHARE_URLS_MAX);
    }

    #[test]
    fn the_access_code_comes_from_the_auth_file_only_when_it_looks_generated() {
        let file = r#"{"version":1,"code":"k7qm2-x9fda-3hz8w-p0rtc","codeCreatedAt":"2026-09-29T00:00:00.000Z","secret":{"salt":"a","hash":"b"},"sessions":[]}"#;
        assert_eq!(code_in(file).as_deref(), Some("k7qm2-x9fda-3hz8w-p0rtc"));
        // No code (EASY_STUDY_PASSWORD was used), not JSON, wrong shape.
        assert_eq!(code_in(r#"{"version":1,"sessions":[]}"#), None);
        assert_eq!(code_in("{"), None);
        assert_eq!(code_in(r#"{"code":42}"#), None);
        for bad in [
            "k7qm2-x9fda-3hz8w",         // three groups
            "k7qm2-x9fda-3hz8w-p0rtc-a", // five
            "K7QM2-X9FDA-3HZ8W-P0RTC",   // upper case
            "k7qm2-x9fdi-3hz8w-p0rtc",   // i is not in the alphabet
            "k7qm2-x9fda-3hz8w-p0rt",    // a short group
            "k7qm2 x9fda 3hz8w p0rtc",
            "k7qm2-x9fda-3hz8w-p0rtc\n",
            "",
        ] {
            assert!(!valid_code(bad), "{bad:?}");
            assert_eq!(code_in(&format!(r#"{{"code":{}}}"#, serde_json::Value::String(bad.into()))), None, "{bad:?}");
        }
        assert!(valid_code("00000-zzzzz-abcde-fghjk"));
    }

    #[test]
    fn a_port_the_server_could_not_bind_is_avoided() {
        // An ephemeral port that is free right now: picked when saved, skipped when it is the one that failed.
        let free = TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap();
        assert_eq!(pick_port(Some(free), None), free);
        assert_ne!(pick_port(Some(free), Some(free)), free);
        assert_ne!(pick_port(None, Some(free)), free);
        assert_ne!(pick_port(Some(0), None), 0);
        assert!(PORT_TAKEN_MARK.chars().all(|c| !c.is_ascii_digit()), "no port number in the marker (it varies)");
    }

    fn tools(whisper: Option<&str>, ffmpeg: Option<&str>) -> Tools {
        Tools { whisper: whisper.map(PathBuf::from), ffmpeg: ffmpeg.map(PathBuf::from), models: PathBuf::from("/data/models") }
    }

    #[test]
    fn recording_tools_reach_the_server() {
        let none = |_: &str| None;
        let bundled = tools(Some("/app/whisper/whisper-cli"), Some("/app/ffmpeg/ffmpeg"));
        assert_eq!(
            bundled.env(none),
            vec![
                (ENV_MODELS, "/data/models".to_string()),
                (ENV_WHISPER, "/app/whisper/whisper-cli".to_string()),
                (ENV_FFMPEG, "/app/ffmpeg/ffmpeg".to_string()),
            ]
        );
        // Not bundled (a local build without ffmpeg): the server looks on PATH (Homebrew's ffmpeg, say).
        assert_eq!(tools(Some("/w"), None).env(none), vec![(ENV_MODELS, "/data/models".into()), (ENV_WHISPER, "/w".into())]);
        // The user's own programs win; an empty variable does not count. The models folder is always the app's.
        let user = |key: &str| match key {
            ENV_WHISPER => Some("/home/me/whisper-cli".to_string()),
            ENV_FFMPEG => Some("  ".to_string()),
            _ => Some("/elsewhere".to_string()),
        };
        assert_eq!(
            bundled.env(user),
            vec![
                (ENV_MODELS, "/data/models".to_string()),
                (ENV_WHISPER, "/home/me/whisper-cli".to_string()),
                (ENV_FFMPEG, "/app/ffmpeg/ffmpeg".to_string()),
            ]
        );
    }

    #[test]
    fn sharing_is_one_dedicated_variable_and_the_user_cannot_set_it() {
        let env_of = |sharing: Sharing| {
            let mut cmd = Command::new("node");
            child_env(&mut cmd, "/usr/bin", 5378, Path::new("/lib"), &tools(None, None), sharing);
            let vars: Vec<(String, Option<String>)> = cmd
                .get_envs()
                .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
                .collect();
            vars
        };
        let local = env_of(Sharing { on: false, reset_code: false });
        let get = |vars: &[(String, Option<String>)], k: &str| vars.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get(&local, "EASY_STUDY_HOST"), Some(Some("127.0.0.1".into())));
        assert_eq!(get(&local, "EASY_STUDY_DESKTOP"), Some(Some("1".into())));
        assert_eq!(get(&local, "EASY_STUDY_LANG"), Some(Some("ko".into())), "the shell's language (Korean in tests)");
        let english = crate::i18n::with_lang(crate::i18n::Lang::En, || env_of(Sharing { on: false, reset_code: false }));
        assert_eq!(get(&english, "EASY_STUDY_LANG"), Some(Some("en".into())));
        assert_eq!(get(&local, ENV_SHARE), Some(None), "removed (STRIP_ENV), never set in local mode");
        assert_eq!(get(&local, ENV_RESET_CODE), Some(None));
        let shared = env_of(Sharing { on: true, reset_code: true });
        assert_eq!(get(&shared, "EASY_STUDY_HOST"), Some(Some("127.0.0.1".into())), "the host variable is not how sharing is turned on");
        assert_eq!(get(&shared, ENV_SHARE), Some(Some("1".into())));
        assert_eq!(get(&shared, ENV_RESET_CODE), Some(Some("1".into())));
        for key in [ENV_SHARE, ENV_RESET_CODE, "EASY_STUDY_DESKTOP_SMOKE_WRITE", "EASY_STUDY_DESKTOP_FORCE_PROXY", "EASY_STUDY_AUTH", "PORT"] {
            assert!(STRIP_ENV.contains(&key), "{key}");
        }
    }
}
