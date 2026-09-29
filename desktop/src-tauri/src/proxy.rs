//! The loopback relay for plain-http remote servers (DESIGN §16, §19). A page on http://192.168.0.10:5180 is no
//! secure context: the WebView hides navigator.mediaDevices there, so the lecture recorder cannot record. For such
//! a server the shell runs the bundled server's relay (server/proxy.ts: `node proxy.js --to <origin>`) on
//! 127.0.0.1:<port> and shows THAT in the window — a secure context — while the relay forwards every request
//! (SSE streams, long uploads, ranges, cookies; Host and Origin rewritten to the remote's) to the one origin it was
//! started for. https servers and loopback ones are shown directly (already secure), unless
//! EASY_STUDY_DESKTOP_FORCE_PROXY=1 (tests). One relay per app session, loopback only, no credentials added; it dies
//! with the shell (stdin EOF, process group, Job Object) and is stopped when the window leaves its page.
//! Its port is remembered (desktop.json proxyPort), so the relay origin http://127.0.0.1:<port> is stable — and
//! ONE origin for every relayed remote: the web client's localStorage (last document, recorder settings) there is
//! shared among them, as the WebView's cookie jar for 127.0.0.1 is shared with the shell's own server. The relay
//! keeps the logins apart itself (server/proxy.ts: the remote's es_session is stored as es_session_<hash of the
//! remote origin>, and only that one goes back to that remote — never the local server's cookie, never another
//! remote's).

use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::Ordering::SeqCst;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::config::{self, lock};
use crate::{pathenv, remote, server, AppState};

/// The relay's preferred ports (the local server's are 5350–5359); the last one used is remembered.
const PREFERRED_PORTS: std::ops::RangeInclusive<u16> = 5360..=5369;
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// A graceful stop (stdin EOF: it exits at once; its own force-exit is at 2 s).
const STOP_GRACE: Duration = Duration::from_secs(3);
const LOG_MAX_BYTES: u64 = 1024 * 1024;
const TAIL_LINES: usize = 20;
/// Tests: relay a loopback remote too (the local E2E on one computer).
const ENV_FORCE: &str = "EASY_STUDY_DESKTOP_FORCE_PROXY";

pub struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
}

enum Failure {
    /// The relay could not bind its port (its stderr says so, exit 1): once more on any port.
    PortTaken,
    Other(String),
}

/// Whether `origin` (a checked remote server) is shown through the relay: plain http to another computer.
pub fn wanted(origin: &Url) -> bool {
    let forced = std::env::var(ENV_FORCE).is_ok_and(|v| matches!(v.trim(), "1" | "true" | "on" | "yes"));
    origin.scheme() == "http" && (forced || !remote::is_loopback_host(origin.host_str().unwrap_or_default()))
}

/// The relay's origin (`http://127.0.0.1:<port>`) while one runs.
pub fn url(app: &AppHandle) -> Option<String> {
    lock(&app.state::<AppState>().proxy_url).clone()
}

/// The remote origin behind `origin` when that is the running relay's.
pub fn target_of(app: &AppHandle, origin: &str) -> Option<String> {
    let st = app.state::<AppState>();
    let relayed = lock(&st.proxy_url).as_deref() == Some(origin);
    let target = relayed.then(|| lock(&st.proxy_target).clone()).flatten();
    target
}

/// Starts the relay for `origin` (stopping any other one first) and returns what the window shows,
/// `http://127.0.0.1:<port>`. Blocks up to READY_TIMEOUT: worker threads only.
pub fn start(app: &AppHandle, origin: &Url) -> Result<String, String> {
    let st = app.state::<AppState>();
    let (path_env, how) = pathenv::wait();
    // A stop that is under way (stop_async) finishes first: it may still hold the remembered port.
    let _life = lock(&st.proxy_lifecycle);
    stop_locked(app, &st);
    let res = app.path().resource_dir().map_err(|e| format!("앱의 리소스 폴더를 찾지 못했어요: {e}"))?;
    let node = server::node_path(&res);
    if !node.is_file() {
        return Err(format!("앱에 들어 있는 Node.js를 찾지 못했어요: {}. 앱을 다시 설치해 보세요.", node.display()));
    }
    let server_dir = res.join("server");
    let entry = server_dir.join("dist-server").join("server").join("proxy.js");
    if !entry.is_file() {
        return Err("앱에 연결 통로 프로그램이 없어요 (proxy.js). 앱을 다시 설치해 주세요.".into());
    }
    let target = crate::origin_of(origin);
    let log_file = config::log_dir(app).join("proxy.log");
    config::rotate(&log_file, LOG_MAX_BYTES);
    let relay = Relay { node: &node, dir: &server_dir, entry: &entry, target: &target, path_env: &path_env, log: &log_file };
    let port = pick_proxy_port(config::load(app).proxy_port);
    config::log(app, &format!("starting the relay for {target} on port {port} (PATH {how})"));
    let shown = match spawn_relay(app, &st, &relay, port) {
        Err(Failure::PortTaken) if port != 0 => {
            config::log(app, &format!("relay port {port} is taken: any port"));
            spawn_relay(app, &st, &relay, 0)
        }
        other => other,
    }
    .map_err(|f| match f {
        Failure::PortTaken => "연결 통로(프록시)가 쓸 포트를 찾지 못했어요.".to_string(),
        Failure::Other(e) => e,
    })?;
    let actual = Url::parse(&shown).ok().and_then(|u| u.port()).unwrap_or(port);
    config::update(app, |c| c.proxy_port = Some(actual));
    *lock(&st.proxy_url) = Some(shown.clone());
    *lock(&st.proxy_target) = Some(target.clone());
    config::log(app, &format!("proxy ready {shown} -> {target}"));
    Ok(shown)
}

/// How to run the relay (start).
struct Relay<'a> {
    node: &'a Path,
    dir: &'a Path,
    entry: &'a Path,
    /// The remote origin.
    target: &'a str,
    path_env: &'a str,
    log: &'a Path,
}

/// Spawns the relay on `port` (0 = any) and waits for its ready line. On failure the child is reaped here.
fn spawn_relay(app: &AppHandle, st: &AppState, relay: &Relay, port: u16) -> Result<String, Failure> {
    let mut cmd = Command::new(relay.node);
    cmd.arg("--max-semi-space-size=2")
        .arg(relay.entry)
        .arg("--to")
        .arg(relay.target)
        .current_dir(relay.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Nothing of the server's: no EASY_STUDY_DESKTOP, no library, no tool paths (it relays, it cannot touch a library).
    server::base_env(&mut cmd, relay.path_env);
    cmd.env("PORT", port.to_string());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let t = Instant::now();
    let mut child = server::spawn(cmd).map_err(|e| Failure::Other(format!("연결 통로(프록시)를 시작하지 못했어요: {e}")))?;
    #[cfg(windows)]
    server::winjob::kill_with_parent(&child);
    let generation = st.proxy_generation.fetch_add(1, SeqCst) + 1;
    config::log(app, &format!("spawned relay pid {} port {port} -> {} in {} ms", child.id(), relay.target, t.elapsed().as_millis()));
    config::append_log(relay.log, &format!("---- easy-study desktop: relay pid {} port {port} -> {}", child.id(), relay.target));
    let stdout = child.stdout.take().ok_or_else(|| Failure::Other("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| Failure::Other("no stderr".into()))?;
    let stdin = child.stdin.take();
    *lock(&st.proxy) = Some(Running { child, stdin });

    // stderr: proxy.log, and the last lines for a start that fails (the port message, a bad --to).
    let (stderr_done, stderr_finished) = mpsc::channel::<()>();
    let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (err_log, err_tail) = (relay.log.to_path_buf(), tail.clone());
    std::thread::spawn(move || {
        server::for_each_line(stderr, |line| {
            config::append_log(&err_log, &format!("[stderr] {line}"));
            let mut tail = lock(&err_tail);
            if tail.len() == TAIL_LINES {
                tail.remove(0);
            }
            tail.push(line.chars().take(300).collect());
        });
        let _ = stderr_done.send(());
    });
    // stdout: the ready line, then EOF = the relay is gone.
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let (h, out_log) = (app.clone(), relay.log.to_path_buf());
    std::thread::spawn(move || {
        let mut ready = false;
        server::for_each_line(stdout, |line| {
            config::append_log(&out_log, &line);
            if !ready {
                if let Some(url) = server::ready_url(&line) {
                    ready = true;
                    let _ = tx.send(Some(url));
                }
            }
        });
        if ready {
            on_exit(&h, generation);
        } else {
            let _ = tx.send(None);
        }
    });
    match rx.recv_timeout(READY_TIMEOUT) {
        Ok(Some(url)) => Ok(url),
        Ok(None) => {
            let status = reap(st);
            let _ = stderr_finished.recv_timeout(Duration::from_secs(1));
            let lines = lock(&tail).clone();
            let how = server::describe(status);
            config::log(app, &format!("relay exited before its ready line ({how}): {}", lines.join(" / ")));
            if lines.iter().any(|l| l.contains("다른 프로그램이") && l.contains("쓰고 있")) {
                Err(Failure::PortTaken)
            } else {
                Err(Failure::Other(format!("연결 통로(프록시)가 시작되지 않았어요 ({how}). {}", lines.last().cloned().unwrap_or_default())))
            }
        }
        Err(_) => {
            let status = reap(st);
            config::log(app, &format!("relay not ready in {} s ({})", READY_TIMEOUT.as_secs(), server::describe(status)));
            Err(Failure::Other(format!("연결 통로(프록시)가 {}초 안에 준비되지 않았어요.", READY_TIMEOUT.as_secs())))
        }
    }
}

/// Takes the child out of the state and ends it (the caller holds proxy_lifecycle). Its generation is bumped so
/// that a late exit of it is ignored.
fn reap(st: &AppState) -> Option<std::process::ExitStatus> {
    st.proxy_generation.fetch_add(1, SeqCst);
    let mut running = lock(&st.proxy).take()?;
    drop(running.stdin.take());
    let status = server::wait_for(&mut running.child, STOP_GRACE).or_else(|| server::force_kill(&mut running.child));
    #[cfg(unix)]
    server::kill_group(&running.child);
    status
}

fn on_exit(app: &AppHandle, generation: u64) {
    let st = app.state::<AppState>();
    if st.quitting.load(SeqCst) {
        return;
    }
    let life = lock(&st.proxy_lifecycle);
    if st.proxy_generation.load(SeqCst) != generation {
        return; // stopped on purpose, or replaced by a newer relay
    }
    let target = lock(&st.proxy_target).take();
    *lock(&st.proxy_url) = None;
    let how = server::describe(reap(&st));
    config::log(app, &format!("relay exited on its own ({how}), target {}", target.unwrap_or_default()));
    *lock(&st.error) = Some(format!("연결 통로(프록시)가 예기치 않게 종료됐어요 ({how}). 다시 연결해 주세요."));
    drop(life);
    crate::show_chooser(app);
    crate::smoke_fail(app, 2, "proxy exited");
}

/// Every stop: the link windows on the relay origin close first (they would show the next relay's remote, or a
/// dead back end), unless the app is quitting (the windows go with it).
fn stop_locked(app: &AppHandle, st: &AppState) {
    if !st.quitting.load(SeqCst) {
        close_page_windows(app);
    }
    *lock(&st.proxy_url) = None;
    *lock(&st.proxy_target) = None;
    let pid = lock(&st.proxy).as_ref().map(|r| r.child.id());
    let t = Instant::now();
    let status = reap(st);
    if let Some(pid) = pid {
        config::log(app, &format!("relay pid {pid} stopped in {} ms ({})", t.elapsed().as_millis(), server::describe(status)));
    }
}

/// Stops the relay if one runs: closes its stdin (it exits on EOF), waits, then kills what is left. Blocks for up
/// to STOP_GRACE (the app's exit).
pub fn stop(app: &AppHandle) {
    let st = app.state::<AppState>();
    let _life = lock(&st.proxy_lifecycle);
    stop_locked(app, &st);
}

/// stop() on a thread, for the window leaving the relay's page. Only the relay that runs now is stopped: a newer
/// one started meanwhile (a "연결" right after) is left alone, and its start waits for this stop (the port).
pub fn stop_async(app: &AppHandle) {
    let st = app.state::<AppState>();
    if lock(&st.proxy).is_none() {
        return;
    }
    let generation = st.proxy_generation.load(SeqCst);
    let h = app.clone();
    std::thread::spawn(move || {
        let st = h.state::<AppState>();
        let _life = lock(&st.proxy_lifecycle);
        if st.proxy_generation.load(SeqCst) != generation {
            return;
        }
        stop_locked(&h, &st);
    });
}

/// Windows for links (page-N) that show the relay's pages: closed with it (stop_locked).
fn close_page_windows(app: &AppHandle) {
    let Some(relay) = url(app) else { return };
    for (label, w) in app.webview_windows() {
        if label.starts_with("page-") && w.url().ok().is_some_and(|u| crate::origin_of(&u) == relay) {
            let _ = w.close();
        }
    }
}

/// The saved port when free on loopback, else the first free preferred one, else 0 (any: the ready line tells).
fn pick_proxy_port(saved: Option<u16>) -> u16 {
    if let Some(p) = saved.filter(|p| *p != 0 && server::port_free(*p)) {
        return p;
    }
    PREFERRED_PORTS.into_iter().find(|p| server::port_free(*p)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_http_to_other_computers_is_relayed() {
        let url = |s: &str| Url::parse(s).unwrap();
        // The test knob may be set in this process: judge the rule without it.
        std::env::remove_var(ENV_FORCE);
        assert!(wanted(&url("http://192.168.0.10:5180/")));
        assert!(wanted(&url("http://my-mac.local:5180/")));
        assert!(wanted(&url("http://[fd7a:115c:a1e0::1]:5180/")));
        assert!(!wanted(&url("https://study-pc.tail1234.ts.net/")), "https is a secure context already");
        for loopback in ["http://127.0.0.1:5180/", "http://localhost:5180/", "http://[::1]:5180/"] {
            assert!(!wanted(&url(loopback)), "{loopback} is a secure context already");
        }
        std::env::set_var(ENV_FORCE, "1");
        assert!(wanted(&url("http://127.0.0.1:5180/")));
        assert!(!wanted(&url("https://127.0.0.1:5180/")));
        std::env::remove_var(ENV_FORCE);
    }

    #[test]
    fn the_relay_port_is_remembered_or_preferred() {
        let free = std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap();
        assert_eq!(pick_proxy_port(Some(free)), free);
        for saved in [None, Some(0)] {
            let picked = pick_proxy_port(saved);
            assert!(picked == 0 || PREFERRED_PORTS.contains(&picked), "{saved:?} -> {picked}");
        }
        // A port that is held right now is not picked.
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = held.local_addr().unwrap().port();
        assert_ne!(pick_proxy_port(Some(taken)), taken);
        drop(held);
    }
}
