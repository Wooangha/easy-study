//! "이 컴퓨터에서 실행": the bundled easy-study server (DESIGN §19).
//!
//! The shell runs the bundled official Node with the packed server in desktop mode (EASY_STUDY_DESKTOP=1):
//! the server prints `EASY_STUDY_READY {"url":…,"port":…}` once it listens, and stops by itself when its stdin
//! reaches EOF — the shell keeps the write end of that pipe, so the server also stops when the app crashes or
//! is killed, on every OS. Backstops: POSIX process group (killed after the server exits), Linux
//! PR_SET_PDEATHSIG, Windows Job Object with KILL_ON_JOB_CLOSE. Errors before listening (e.g. the library is
//! locked by `npm start`) come on stderr in Korean; the chooser shows the last lines.

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
use crate::{pathenv, AppState};

/// The local server's preferred ports (not 5180, which `npm start` uses); the last one used is remembered.
const PREFERRED_PORTS: std::ops::RangeInclusive<u16> = 5350..=5359;
const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a graceful stop may take (the server's own force-exit is at 8 s).
const STOP_GRACE: Duration = Duration::from_secs(9);
const TAIL_LINES: usize = 40;
const LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Variables of the user's environment the server must not inherit: the shell decides port, host, library
/// and login (local mode), and NODE_OPTIONS could change how the bundled Node runs.
const STRIP_ENV: &[&str] = &[
    "PORT",
    "EASY_STUDY_HOST",
    "EASY_STUDY_AUTH",
    "EASY_STUDY_PASSWORD",
    "EASY_STUDY_TLS_CERT",
    "EASY_STUDY_TLS_KEY",
    "EASY_STUDY_LIBRARY",
    "EASY_STUDY_DESKTOP_HOME",
    "EASY_STUDY_DESKTOP_LIBRARY",
    "EASY_STUDY_DESKTOP_SMOKE",
    "EASY_STUDY_DESKTOP_SMOKE_TIMEOUT",
    "EASY_STUDY_DESKTOP_SMOKE_URL",
    "EASY_STUDY_DESKTOP_SMOKE_CODE",
    "NODE_OPTIONS",
    "WATCH_REPORT_DEPENDENCIES",
];

pub struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    /// The server printed EASY_STUDY_READY: it stops by itself when its stdin closes.
    aware: Arc<AtomicBool>,
    pub library: PathBuf,
}

/// Starts the local server in the background (or shows it when it already runs). Never blocks.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    if let Some(url) = lock(&st.server_url).clone() {
        crate::go_to(app, &url);
        return Ok(());
    }
    if st.starting.swap(true, SeqCst) {
        return Ok(()); // already starting
    }
    *lock(&st.error) = None;
    lock(&st.tail).clear();
    *lock(&st.busy) = Some("이 컴퓨터에서 easy-study 서버를 시작하는 중…".into());
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
    let res = app.path().resource_dir().map_err(|e| format!("앱의 리소스 폴더를 찾지 못했어요: {e}"))?;
    let node = node_path(&res);
    if !node.is_file() {
        return Err(format!("앱에 들어 있는 Node.js를 찾지 못했어요: {}. 앱을 다시 설치해 보세요.", node.display()));
    }
    let server_dir = res.join("server");
    let entry = server_dir.join("dist-server").join("server").join("index.js");
    if !entry.is_file() {
        return Err(format!("앱에 들어 있는 easy-study 서버를 찾지 못했어요: {}. 앱을 다시 설치해 보세요.", entry.display()));
    }
    let cfg = config::load(app);
    let library = config::library(app, &cfg);
    fs::create_dir_all(&library.path)
        .map_err(|e| format!("라이브러리 폴더를 만들 수 없어요: {} ({e})", library.path.display()))?;
    let port = pick_port(cfg.port);
    config::update(app, |c| c.port = Some(port));

    let log_file = config::log_dir(app).join("server.log");
    config::rotate(&log_file, LOG_MAX_BYTES);

    let mut cmd = Command::new(&node);
    cmd.arg("--max-semi-space-size=2")
        .arg(&entry)
        .current_dir(&server_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    child_env(&mut cmd, &path_env, port, &library.path);
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
    let mut child = spawn(cmd).map_err(|e| format!("서버를 시작하지 못했어요: {e} ({})", node.display()))?;
    #[cfg(windows)]
    winjob::kill_with_parent(&child);
    let generation = st.generation.fetch_add(1, SeqCst) + 1;
    config::log(
        app,
        &format!(
            "spawned server pid {} port {port} in {} ms; library {}; PATH ({how}): {path_env}",
            child.id(),
            t.elapsed().as_millis(),
            library.path.display()
        ),
    );
    config::append_log(&log_file, &format!("---- easy-study desktop: server pid {} port {port} library {}", child.id(), library.path.display()));

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let aware = Arc::new(AtomicBool::new(false));
    *lock(&st.server) = Some(Running { child, stdin, aware: aware.clone(), library: library.path.clone() });
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
                if let Some(url) = ready_url(&line) {
                    ready = true;
                    aware.store(true, SeqCst);
                    on_ready(&h, generation, url);
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
            *lock(&st.error) = Some(format!(
                "이 컴퓨터의 easy-study 서버가 {}초 안에 준비되지 않아 멈췄어요.",
                READY_TIMEOUT.as_secs()
            ));
            stop(&h);
            crate::show_chooser(&h);
            crate::smoke_fail(&h, 2, "server not ready in time");
        }
    });
    Ok(())
}

/// Reads `reader` line by line (lossy UTF-8, so odd bytes never stop the draining) until EOF.
fn for_each_line(reader: impl Read, mut f: impl FnMut(String)) {
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

/// The server's URL from its ready line `EASY_STUDY_READY {"url":…,"port":…}` (the banner before it is not
/// enough: only the ready line says the server stops by itself on stdin EOF).
fn ready_url(line: &str) -> Option<String> {
    let rest = line.strip_prefix("EASY_STUDY_READY ")?;
    let v: serde_json::Value = serde_json::from_str(rest.trim()).ok()?;
    let url = Url::parse(v.get("url")?.as_str()?).ok()?;
    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1")).then(|| url.as_str().trim_end_matches('/').to_string())
}

fn on_ready(app: &AppHandle, generation: u64, url: String) {
    let st = app.state::<AppState>();
    if st.generation.load(SeqCst) != generation {
        return;
    }
    *lock(&st.server_url) = Some(url.clone());
    st.start_ended();
    config::log(app, &format!("server ready {url}"));
    crate::go_to(app, &url);
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
    let how = describe(status);
    config::log(app, &format!("server exited on its own ({how}), ready: {was_ready}"));
    *lock(&st.error) = Some(if was_ready {
        format!("이 컴퓨터의 easy-study 서버가 예기치 않게 종료됐어요 ({how}). \"연결\"을 누르면 다시 시작해요.")
    } else {
        format!("이 컴퓨터에서 easy-study 서버를 시작하지 못했어요 ({how}).")
    });
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

fn wait_for(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => return None,
        }
    }
}

fn force_kill(child: &mut Child) -> Option<ExitStatus> {
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
fn kill_group(child: &Child) {
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
}

fn describe(status: Option<ExitStatus>) -> String {
    match status {
        Some(s) => match s.code() {
            Some(code) => format!("종료 코드 {code}"),
            None => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = s.signal() {
                        return format!("신호 {sig}");
                    }
                }
                s.to_string()
            }
        },
        None => "종료 상태를 알 수 없음".into(),
    }
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn pick_port(saved: Option<u16>) -> u16 {
    if let Some(p) = saved.filter(|p| *p != 0 && port_free(*p)) {
        return p;
    }
    if let Some(p) = PREFERRED_PORTS.into_iter().find(|p| port_free(*p)) {
        return p;
    }
    TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(0)
}

/// The bundled Node: a resource on macOS and Windows; on Linux the externalBin `es-node` next to the app
/// binary (/usr/bin/es-node in deb/rpm, $APPDIR/usr/bin/es-node in the AppImage).
fn node_path(res: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        res.join("node").join("node.exe")
    }
    #[cfg(target_os = "linux")]
    {
        let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("es-node")));
        match beside.filter(|p| p.is_file()) {
            Some(p) => p,
            None => res.join("node").join("bin").join("node"),
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        res.join("node").join("bin").join("node")
    }
}

fn child_env(cmd: &mut Command, path_env: &str, port: u16, library: &Path) {
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
    cmd.env("PATH", path_value)
        .env("PORT", port.to_string())
        .env("EASY_STUDY_HOST", "127.0.0.1")
        .env("EASY_STUDY_LIBRARY", library)
        .env("EASY_STUDY_DESKTOP", "1");
}

/// Linux: PR_SET_PDEATHSIG is tied to the THREAD that forked the child, so every server is spawned by one
/// thread that lives as long as the app.
#[cfg(target_os = "linux")]
fn spawn(mut cmd: Command) -> std::io::Result<Child> {
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
fn spawn(mut cmd: Command) -> std::io::Result<Child> {
    cmd.spawn()
}

#[cfg(windows)]
mod winjob {
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
        assert_eq!(ready_url("  easy-study   →  http://127.0.0.1:5351"), None);
        assert_eq!(ready_url(r#"EASY_STUDY_READY {"url":"http://192.168.0.2:5353"}"#), None);
        assert_eq!(ready_url("EASY_STUDY_READY not json"), None);
    }
}
