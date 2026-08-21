//! Local bridge server: a minimal loopback HTTP endpoint that the injected
//! theme-observer script inside the DSH content webview reports to.
//!
//! The DSH page is a remote origin (http://127.0.0.1:<port>) with no Tauri IPC,
//! so theme changes cannot travel through the Tauri event system directly. The
//! injected script POSTs a JSON snapshot (text/plain → no CORS preflight) to
//! `http://127.0.0.1:<bridge-port>/report/<token>`; the bridge answers with
//! `Access-Control-Allow-Origin: *` and forwards the snapshot into the Tauri
//! event system as `theme-changed`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::plugins::PluginManager;

/// One theme snapshot reported by the DSH page.
#[derive(Clone, Serialize)]
pub struct ThemeSnapshot {
    pub dark: bool,
    /// Raw `--dsw-alias-*` CSS variable values from the page's root element.
    pub vars: HashMap<String, String>,
}

pub struct Bridge {
    /// Base URL of the bridge, e.g. `http://127.0.0.1:54321`.
    pub base_url: String,
    /// Per-session token required in the report path.
    pub token: String,
    /// Desktop plugin registry (state + bundle serving).
    pub plugins: Arc<PluginManager>,
}

impl Bridge {
    /// The initialization script for the DSH content webview: watches the DSH
    /// theme and reports snapshots to this bridge.
    pub fn theme_observer_script(&self) -> String {
        include_str!("theme-observer.js").replace(
            "__BRIDGE__",
            &format!("{}/report/{}", self.base_url, self.token),
        )
    }

    /// The desktop plugin proxy: intercepts `__DSH_BOOT__` / `__ModuleLoader__`
    /// / `__DSH_MODULES__` and polls this bridge for plugin graph changes.
    pub fn plugin_proxy_script(&self) -> String {
        let state_handle = self.plugins.state();
        let state = state_handle.lock().unwrap();
        let entries = serde_json::to_string(&state.entries).unwrap_or_else(|_| "[]".into());
        let session = self.plugins.current_session();
        let session_json = serde_json::to_string(&session).unwrap_or_else(|_| "null".into());
        include_str!("plugin-proxy.js")
            .replace("__BRIDGE__", &self.base_url)
            .replace("__INITIAL_ENTRIES__", &entries)
            .replace("__INITIAL_SESSION__", &session_json)
    }
}

fn random_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{}", std::process::id())
}

/// Start the bridge on an ephemeral loopback port. Reports are forwarded to
/// `on_report` (called from the bridge's accept thread); plugin state and
/// plugin bundles are served from the plugin manager.
pub fn start<F>(on_report: F, plugins: Arc<PluginManager>) -> std::io::Result<Bridge>
where
    F: Fn(ThemeSnapshot) + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let expected_path = format!("/report/{token}");
    let callback: Arc<dyn Fn(ThemeSnapshot) + Send + Sync> = Arc::new(on_report);
    let thread_plugins = plugins.clone();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let expected = expected_path.clone();
                    let cb = callback.clone();
                    let plugins = thread_plugins.clone();
                    std::thread::spawn(move || {
                        handle_connection(stream, &expected, cb.as_ref(), &plugins)
                    });
                }
                Err(_) => continue,
            }
        }
    });

    Ok(Bridge {
        base_url: format!("http://127.0.0.1:{port}"),
        token,
        plugins,
    })
}

fn handle_connection(
    mut stream: TcpStream,
    expected_path: &str,
    callback: &(dyn Fn(ThemeSnapshot) + Send + Sync),
    plugins: &PluginManager,
) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));

    let mut buf = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 8192];
    let mut header_end: Option<usize> = None;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_header_end(&buf) {
                    header_end = Some(pos);
                    break;
                }
                if buf.len() > 64 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("");

    // Body: everything after the blank line.
    let body = match header_end {
        Some(pos) => {
            let body_start = pos + 4;
            if body_start < buf.len() {
                String::from_utf8_lossy(&buf[body_start..]).into_owned()
            } else {
                String::new()
            }
        }
        None => String::new(),
    };

    if method == "POST" && path == expected_path {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
            let dark = value
                .get("dark")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut vars = HashMap::new();
            if let Some(map) = value.get("vars").and_then(|v| v.as_object()) {
                for (key, val) in map {
                    if let Some(s) = val.as_str() {
                        if !s.is_empty() {
                            vars.insert(key.clone(), s.to_string());
                        }
                    }
                }
            }
            if !vars.is_empty() || dark {
                callback(ThemeSnapshot { dark, vars });
            }
        }
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        );
    } else if method == "POST" && path == "/report/session" {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
            let session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            plugins.set_current_session(session_id);
        }
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        );
    } else if method == "GET" || method == "HEAD" {
        if path == "/plugins/state" {
            let state_handle = plugins.state();
            let state = state_handle.lock().unwrap();
            let current = plugins.current_session();
            let payload = serde_json::json!({
                "rev": state.rev,
                "entries": state.entries,
                "currentSession": current,
            });
            write_json(&mut stream, &payload);
        } else if let Some(rest) = path.strip_prefix("/plugins/") {
            if let Some(id) = rest.strip_suffix("/client.js") {
                if let Some(body) = plugins.builtin_script(id) {
                    write_bundle(&mut stream, body.as_bytes(), "text/javascript; charset=utf-8");
                } else if let Some(client_path) = plugins.client_path(id) {
                    serve_file(&mut stream, &client_path, "text/javascript; charset=utf-8");
                } else {
                    write_not_found(&mut stream);
                }
            } else if let Some(id) = rest.strip_suffix("/client.js.map") {
                if let Some(client_path) = plugins.client_path(id) {
                    let map_path = client_path.with_extension("js.map");
                    if map_path.is_file() {
                        serve_file(&mut stream, &map_path, "application/json; charset=utf-8");
                    } else {
                        write_not_found(&mut stream);
                    }
                } else {
                    write_not_found(&mut stream);
                }
            } else {
                write_not_found(&mut stream);
            }
        } else {
            write_not_found(&mut stream);
        }
    } else {
        write_not_found(&mut stream);
    }
}

/// Bundles and plugin state must never be cached: the HMR driver reloads a
/// plugin by re-running its `<script>` URL, and a cached response would
/// re-register the factory the reload was meant to replace.
const NO_STORE: &str = "Cache-Control: no-store\r\n";

fn write_json(stream: &mut TcpStream, value: &impl Serialize) {
    let body = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n{NO_STORE}Access-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn write_bundle(stream: &mut TcpStream, body: &[u8], content_type: &str) {
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{NO_STORE}Access-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
}

fn serve_file(stream: &mut TcpStream, path: &Path, content_type: &str) {
    match std::fs::read(path) {
        Ok(body) => write_bundle(stream, &body, content_type),
        Err(_) => write_not_found(stream),
    }
}

fn write_not_found(stream: &mut TcpStream) {
    let body = b"not found";
    let headers = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(&body[..]);
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};

    fn http_get(addr: &str, path: &str) -> String {
        let mut stream = TcpStream::connect(addr).expect("connect bridge");
        let request = format!("GET {path} HTTP/1.0\r\nHost: {addr}\r\n\r\n");
        stream.write_all(request.as_bytes()).expect("write request");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).expect("read response");
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn http_post(addr: &str, path: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(addr).expect("connect bridge");
        let request = format!(
            "POST {path} HTTP/1.0\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(request.as_bytes()).expect("write request");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).expect("read response");
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[test]
    fn serves_plugin_state_and_bundle() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-bridge-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("hello")).unwrap();
        fs::write(
            root.join("hello/client.js"),
            "window.__ModuleLoader__.load({id:'hello',factory:function(){return {}}})",
        )
        .unwrap();

        let plugins = Arc::new(PluginManager::new(root.clone(), String::new()));
        let bridge = start(|_| {}, plugins.clone()).expect("start bridge");
        plugins.set_bridge_base(bridge.base_url.clone());
        let addr = bridge.base_url.trim_start_matches("http://").to_string();

        let state = http_get(&addr, "/plugins/state");
        assert!(state.contains("200 OK"), "state response: {state}");
        assert!(state.contains("\"id\":\"hello\""), "state body: {state}");

        let bundle = http_get(&addr, "/plugins/hello/client.js?rev=abc");
        assert!(bundle.contains("200 OK"), "bundle response: {bundle}");
        assert!(
            bundle.contains("__ModuleLoader__"),
            "bundle body: {bundle}"
        );

        let observer = http_get(
            &addr,
            "/plugins/@dsh-desktop/session-observer/client.js?rev=session-observer",
        );
        assert!(observer.contains("200 OK"), "observer response: {observer}");
        assert!(observer.contains("session-observer"), "observer body: {observer}");

        // The HMR driver is the second built-in: it must be in the manifest and
        // servable, and it must declare the loader/modules injections that let
        // it own the cordis fiber lifecycle.
        assert!(
            state.contains("\"id\":\"@dsh-desktop/hmr\""),
            "state body: {state}"
        );
        let hmr = http_get(&addr, "/plugins/@dsh-desktop/hmr/client.js?rev=hmr");
        assert!(hmr.contains("200 OK"), "hmr response: {hmr}");
        assert!(hmr.contains("__ModuleLoader__"), "hmr body: {hmr}");
        assert!(hmr.contains(r#"["loader", "modules"]"#), "hmr body: {hmr}");

        // Bundles are reloaded through the same URL path, so responses must
        // forbid caching.
        assert!(hmr.contains("Cache-Control: no-store"), "hmr headers: {hmr}");
        assert!(bundle.contains("Cache-Control: no-store"), "bundle headers: {bundle}");

        let _ = http_post(&addr, "/report/session", r#"{"sessionId":"sess-1"}"#);
        let state2 = http_get(&addr, "/plugins/state");
        assert!(
            state2.contains("\"currentSession\":\"sess-1\""),
            "state after session report: {state2}"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
