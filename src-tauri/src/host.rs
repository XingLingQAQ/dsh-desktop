//! Host process management: spawn `dsh --profile web`, watch its stdout for the
//! readiness line (`dsh web: http://127.0.0.1:<port>`), health-check the URL,
//! and tear the process tree down on exit.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::time::Duration;

use crate::discover::EnvironmentSnapshot;

/// One line emitted by the host process (stdout or stderr).
pub enum HostEvent {
    /// The readiness line: `dsh web: http://127.0.0.1:<port>`.
    Ready(String),
    /// Any other output line (for the live log tail).
    Log(String),
}

pub struct HostProcess {
    child: Option<Child>,
    pid: Option<u32>,
    events: Receiver<HostEvent>,
    /// True when this process was spawned by us (we own its lifecycle).
    pub owned: bool,
    /// Handle to the kill-on-close job the child was placed in, as a raw value.
    ///
    /// Held for the life of the process and deliberately **never closed**: the
    /// close is what triggers the kill, so the handle going away when this
    /// process dies is the entire mechanism. Stored as `isize` rather than a
    /// handle type because raw pointers are not `Send` and this struct is shared
    /// across threads.
    #[cfg(windows)]
    job: Option<isize>,
}

/// Put a spawned child in a job that kills it when this process dies.
///
/// The shell already terminates the host on `RunEvent::Exit`, but that handler
/// does not run when the process is force-killed — from Task Manager, or in a
/// crash. The host then survives as an orphan and keeps holding the session
/// write leases, so the next launch can list sessions but not send to them:
/// `SessionAlreadyOwnedError`. Twelve such orphans were found on this machine,
/// the oldest four days old, and the symptom ("sending does nothing") is a long
/// way from the cause.
///
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` moves that to the kernel: when the last
/// handle to the job closes — which the OS does when this process ends, however
/// it ends — everything in the job is terminated. No cleanup code has to run,
/// which is exactly the property that was missing.
///
/// Returns the job handle to keep open, or `None` if the job could not be set up
/// (nested jobs are refused in some configurations). A `None` here is not fatal:
/// the ordinary kill-on-exit path still applies, this only covers the rude exits.
#[cfg(windows)]
fn adopt_into_kill_on_close_job(child: &Child) -> Option<isize> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *mut core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            return None;
        }
        let process = child.as_raw_handle() as *mut core::ffi::c_void;
        if AssignProcessToJobObject(job, process) == 0 {
            return None;
        }
        Some(job as isize)
    }
}

impl HostProcess {
    /// Spawn the web profile with the discovered environment.
    pub fn spawn(snapshot: &EnvironmentSnapshot, port: Option<u16>) -> Result<Self, String> {
        let node = snapshot
            .node
            .clone()
            .ok_or_else(|| "未找到 node".to_string())?;
        let cli = snapshot
            .cli
            .clone()
            .ok_or_else(|| "未找到 dsh CLI".to_string())?;

        let mut cmd = Command::new(&node);
        cmd.arg(&cli).arg("--profile").arg("web");

        // 桌面端自带 WebView 显示 Web UI,禁止 DSH 宿主再额外用 `open` 包拉起系统默认浏览器(Edge)。
        // `--no-open` 会让 web-app 的 openBrowser=false,跳过 Node 侧的 spawnBrowserLauncher。
        cmd.arg("--no-open");

        match port {
            Some(p) => {
                cmd.arg("--port").arg(p.to_string());
            }
            None => {
                cmd.arg("--port").arg("0");
            }
        }
        if let Some(home) = &snapshot.dsh_home {
            cmd.env("DSH_HOME", home);
        }
        // PATH prepend: node dir + recorded entries (pnpm-global etc.).
        let mut path = snapshot.path_prepend.clone();
        if let Some(dir) = Path::new(&node).parent() {
            path.insert(0, dir.to_string_lossy().into_owned());
        }
        let old = std::env::var("PATH").unwrap_or_default();
        path.push(old);
        cmd.env("PATH", path.join(";"));
        cmd.env("DSH_LAUNCH_ENVIRONMENT", "desktop");

        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("spawn 失败: {e}"))?;

        let pid = child.id();
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("stderr 不可用")?;
        let (tx, rx) = channel::<HostEvent>();

        // stdout: readiness-line watcher + log.
        {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.contains("dsh web: http://") {
                        let _ = tx.send(HostEvent::Ready(line));
                    } else if !line.trim().is_empty() {
                        let _ = tx.send(HostEvent::Log(line));
                    }
                }
            });
        }
        // stderr: log only.
        {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if !line.trim().is_empty() {
                        let _ = tx.send(HostEvent::Log(line));
                    }
                }
            });
        }

        // Adopt before returning, so there is no window in which the child is
        // alive and unprotected.
        #[cfg(windows)]
        let job = adopt_into_kill_on_close_job(&child);
        #[cfg(windows)]
        if job.is_none() {
            eprintln!(
                "dsh-desktop: 未能把宿主放进 job 对象；强杀本进程会留下孤儿宿主"
            );
        }

        Ok(Self {
            child: Some(child),
            pid: Some(pid),
            events: rx,
            owned: true,
            #[cfg(windows)]
            job,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn try_event(&self) -> Result<HostEvent, TryRecvError> {
        self.events.try_recv()
    }

    pub fn wait_event(&self, timeout: Duration) -> Result<HostEvent, ()> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match self.events.try_recv() {
                Ok(event) => return Ok(event),
                Err(TryRecvError::Empty) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(());
                    }
                    std::thread::sleep(Duration::from_millis(60));
                }
                Err(TryRecvError::Disconnected) => return Err(()),
            }
        }
    }

    /// Whether the spawned process is still alive.
    pub fn is_alive(&mut self) -> bool {
        if let Some(child) = &mut self.child {
            match child.try_wait() {
                Ok(None) => true,
                _ => false,
            }
        } else {
            false
        }
    }

    /// Graceful-then-forced tree kill.
    pub fn kill(&mut self) {
        if let Some(pid) = self.pid {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T"])
                .status();
            // Wait briefly for graceful shutdown (DSH handles SIGTERM).
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(150));
                if let Some(child) = &mut self.child {
                    if let Ok(Some(_)) = child.try_wait() {
                        self.child = None;
                        return;
                    }
                }
            }
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if self.owned {
            self.kill();
        }
    }
}

/// Minimal HTTP GET health check against the loopback URL.
///
/// The readiness line carries the URL *with* its `?token=…`, and the token has
/// to be sent: the host authenticates every request, and a bare `GET /` comes
/// back 401 — which is a perfectly healthy host answering correctly, not a
/// failed one. Only a missing answer at all (connection refused, timeout, empty
/// read) means the host is not up.
pub fn http_get_ok(url: &str) -> bool {
    let Some(parsed) = url.strip_prefix("http://") else {
        return false;
    };
    let Some((host, rest)) = parsed.split_once(':') else {
        return false;
    };
    let (port_part, path) = match rest.split_once('/') {
        Some((port, rest_path)) => (port, format!("/{rest_path}")),
        None => (rest, "/".to_string()),
    };
    let port: u16 = match port_part.parse() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let addr: std::net::SocketAddr = match format!("{host}:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(3)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    // Ask for the path we were given, token and all, and don't follow anything:
    // any HTTP response at all proves the server is serving.
    let request = format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/")
        }
        _ => false,
    }
}

/// Probe whether a host is already serving on the given loopback port.
pub fn probe_existing(port: u16) -> bool {
    http_get_ok(&format!("http://127.0.0.1:{port}"))
}

/// GET a loopback URL and return its body.
///
/// Used for the pet's session-state route, which is polled while the pet is on
/// screen. The request is deliberately `HTTP/1.0` with `Connection: close`, so
/// the body is whatever follows the headers and the read ends at EOF — no
/// chunked-encoding parser is needed for what is a few hundred bytes of JSON
/// from a server on the same machine.
///
/// A plugin route is not behind the host's token (only the app shell is), so the
/// URL here is the bare origin plus the path.
pub fn http_get_body(url: &str) -> Option<String> {
    http_request("GET", url, None)
}

/// POST a JSON body to a loopback URL and return the response body.
///
/// Same minimal transport as the GET, plus a body and the headers it needs. Used
/// by the pet's bubble to send a prompt and to switch the session it reports on.
pub fn http_post_json(url: &str, body: &str) -> Option<String> {
    http_request("POST", url, Some(body))
}

/// One minimal HTTP/1.0 exchange against loopback.
///
/// `Connection: close` is what makes this simple: the response ends at EOF, so
/// there is no framing to parse. Only the status line and the body are used —
/// the headers are skipped, because every caller here wants JSON and nothing
/// else, and a caller that needs a header would be better served by a real client.
fn http_request(method: &str, url: &str, body: Option<&str>) -> Option<String> {
    let parsed = url.strip_prefix("http://")?;
    let (host, rest) = parsed.split_once(':')?;
    let (port_part, path) = match rest.split_once('/') {
        Some((port, rest_path)) => (port, format!("/{rest_path}")),
        None => (rest, "/".to_string()),
    };
    let port: u16 = port_part.parse().ok()?;
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));

    let mut request = format!("{method} {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n");
    if let Some(body) = body {
        // Byte length, not character count: a prompt in Chinese is longer in
        // bytes than in characters, and a short `Content-Length` truncates it
        // mid-character.
        request.push_str("Content-Type: application/json; charset=utf-8\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }
    stream.write_all(request.as_bytes()).ok()?;

    let mut raw = Vec::new();
    // A cap, so a route that answers with something enormous cannot make the
    // shell allocate without bound. These documents are well under this.
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > 256 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    // Only a 2xx carries a result; anything else is the host saying no, and the
    // caller should treat that as "no answer" rather than parse an error page.
    let status_ok = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (200..300).contains(&code));
    if !status_ok {
        return None;
    }
    Some(body.to_string())
}
