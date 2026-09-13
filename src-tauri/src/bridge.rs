//! Local bridge server: a minimal loopback HTTP endpoint that the injected
//! theme-observer script inside the DSH content webview reports to.
//!
//! The DSH page is a remote origin (http://127.0.0.1:<port>) with no Tauri IPC,
//! so theme changes cannot travel through the Tauri event system directly. The
//! injected script POSTs a JSON snapshot (text/plain → no CORS preflight) to
//! `http://127.0.0.1:<bridge-port>/report/<token>`; the bridge answers with
//! `Access-Control-Allow-Origin: *` and forwards the snapshot into the Tauri
//! event system as `theme-changed`.

use std::collections::{HashMap, HashSet};
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
pub fn start<F>(
    on_report: F,
    plugins: Arc<PluginManager>,
) -> std::io::Result<Bridge>
where
    F: Fn(ThemeSnapshot) + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let expected_path = format!("/report/{token}");
    // State-changing routes sit behind the token: install and uninstall write to
    // disk, so a bare loopback path would let any local process — or any page the
    // content webview wanders onto — drive them.
    let api_path = format!("/api/{token}");
    let api_base = format!("http://127.0.0.1:{port}{api_path}");
    let callback: Arc<dyn Fn(ThemeSnapshot) + Send + Sync> = Arc::new(on_report);
    let thread_plugins = plugins.clone();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let expected = expected_path.clone();
                    let api = api_path.clone();
                    let base = api_base.clone();
                    let cb = callback.clone();
                    let plugins = thread_plugins.clone();
                    std::thread::spawn(move || {
                        handle_connection(
                            stream,
                            &expected,
                            &api,
                            &base,
                            cb.as_ref(),
                            &plugins,
                        )
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
    api_path: &str,
    api_base: &str,
    callback: &(dyn Fn(ThemeSnapshot) + Send + Sync),
    plugins: &PluginManager,
) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));

    let mut buf = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 8192];
    let mut header_end: Option<usize> = None;
    let mut content_len: usize = 0;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none() {
                    if let Some(pos) = find_header_end(&buf) {
                        header_end = Some(pos);
                        content_len = content_length(&buf[..pos]).unwrap_or(0);
                    } else if buf.len() > 64 * 1024 {
                        break;
                    }
                }
                if let Some(pos) = header_end {
                    let body_start = pos + 4;
                    if buf.len() >= body_start + content_len {
                        break;
                    }
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
    let raw_path = parts.next().unwrap_or("");
    let (path, query) = match raw_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (raw_path, ""),
    };

    // Body: exactly `Content-Length` bytes after the blank line. The read loop
    // above keeps pulling until the declared body is complete, so a POST whose
    // body lands in a separate TCP segment from its headers is no longer lost.
    let body = match header_end {
        Some(pos) => {
            let body_start = pos + 4;
            let body_end = (body_start + content_len).min(buf.len());
            if body_start < body_end {
                String::from_utf8_lossy(&buf[body_start..body_end]).into_owned()
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
    } else if method == "POST" && path == format!("{api_path}/plugins/install") {
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let tarball = value.get("tarball").and_then(|v| v.as_str()).unwrap_or_default();
        match crate::registry::install(id, tarball) {
            // Scan immediately so the watched profile patch is rewritten before
            // the frontend polls state (the 1s watcher would be too late).
            Ok(()) => {
                plugins.scan();
                write_json(&mut stream, &serde_json::json!({ "ok": true }));
            }
            Err(message) => write_json(&mut stream, &serde_json::json!({ "ok": false, "error": message })),
        }
    } else if method == "POST" && path == format!("{api_path}/plugins/uninstall") {
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        match crate::registry::uninstall(id) {
            Ok(()) => {
                plugins.forget(id);
                plugins.scan();
                write_json(&mut stream, &serde_json::json!({ "ok": true }));
            }
            Err(message) => write_json(&mut stream, &serde_json::json!({ "ok": false, "error": message })),
        }
    } else if method == "POST" && path == format!("{api_path}/plugins/adopt") {
        // Take over a DSH-profile bundle: copy its files into the desktop
        // plugins directory, remove the profile dependency (pnpm), and record
        // the takeover. The desktop scan picks the new directory up on its
        // next pass; the profile's HMR watcher recomposes without the bundle.
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        match plugins.adopt_profile_bundle(id) {
            Ok(()) => write_json(&mut stream, &serde_json::json!({ "ok": true })),
            Err(message) => write_json(&mut stream, &serde_json::json!({ "ok": false, "error": message })),
        }
    } else if method == "POST" && path == format!("{api_path}/plugins/update") {
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let tarball = value.get("tarball").and_then(|v| v.as_str()).unwrap_or_default();
        match crate::registry::update(id, tarball) {
            Ok(()) => {
                plugins.scan();
                write_json(&mut stream, &serde_json::json!({ "ok": true }));
            }
            Err(message) => write_json(&mut stream, &serde_json::json!({ "ok": false, "error": message })),
        }
    } else if method == "POST" && path == format!("{api_path}/plugins/toggle") {
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let disabled = value.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        plugins.set_disabled(&id, disabled);
        // Read back the real state — `set_disabled` no-ops for built-ins, so the
        // echoed bool reflects the effective state rather than the requested one.
        let actual = plugins.is_disabled(&id);
        write_json(
            &mut stream,
            &serde_json::json!({ "ok": true, "disabled": actual }),
        );
    } else if method == "POST" && path == format!("{api_path}/native/toggle") {
        // Toggle a NATIVE (DSH Loader) entry by writing a `disabled` override
        // into the HMR-watched profile patch. The Loader recomposes within
        // seconds; the frontend polls pluginInventory.list() to confirm.
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let entry_id = value
            .get("entryId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let disabled = value.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        // `clear` drops the desktop's override instead of setting one, returning
        // the entry to whatever the layers below say. Used to roll back an enable
        // that did not take: leaving the override behind would make every later
        // boot retry a plugin that already failed to start.
        let clear = value.get("clear").and_then(|v| v.as_bool()).unwrap_or(false);
        let outcome = if clear {
            plugins.clear_native_override(&entry_id)
        } else {
            plugins.set_native_disabled(&entry_id, disabled)
        };
        match outcome {
            Ok(actual) => write_json(
                &mut stream,
                &serde_json::json!({ "ok": true, "disabled": actual }),
            ),
            Err(message) => write_json(
                &mut stream,
                &serde_json::json!({ "ok": false, "error": message }),
            ),
        }
    } else if method == "POST" && path == format!("{api_path}/plugins/config") {
        let value = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let values = value.get("values").cloned().unwrap_or(serde_json::json!({}));
        plugins.set_config(&id, values);
        write_json(&mut stream, &serde_json::json!({ "ok": true }));
    } else if method == "GET" && path == format!("{api_path}/plugins/progress") {
        // Polled by the store's progress dialog while an install or update POST
        // is still in flight. `running: false` means the job already finished (or
        // never started), which the dialog treats as "keep the last reading".
        let id = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("id="))
            .unwrap_or("");
        let id = percent_decode(id);
        let snapshot = crate::registry::progress(&id);
        write_json(
            &mut stream,
            &match snapshot {
                Some(progress) => serde_json::json!({
                    "running": true,
                    "phase": progress.phase,
                    "received": progress.received,
                    "total": progress.total,
                }),
                None => serde_json::json!({ "running": false }),
            },
        );
    } else if method == "GET" && path == format!("{api_path}/plugins/config") {
        // Query string is `id=<plugin id>`, percent-encoded by the frontend
        // (`@scope/name` → `%40scope%2Fname`). Find the `id=` parameter and
        // decode it so downstream lookups see the real id.
        let id = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("id="))
            .unwrap_or("");
        let id = percent_decode(id);
        let schema = crate::store::config_schema_for(&id);
        let values = plugins.get_config(&id);
        write_json(
            &mut stream,
            &serde_json::json!({ "schema": schema, "values": values }),
        );
    } else if method == "GET" && path == format!("{api_path}/plugins/installed") {
        let disabled = plugins.disabled_snapshot();
        let migrated: HashSet<String> =
            plugins.managed_externals().into_iter().collect();
        write_json(&mut stream, &crate::store::list_installed(&disabled, &migrated));
    } else if path == format!("{api_path}/skills") || path == format!("{api_path}/skills/save") || path == format!("{api_path}/skills/remove") || path == format!("{api_path}/skills/install") || path == format!("{api_path}/skills/pause") {
        // The skill catalog and its three mutations. Skills are files under the
        // DSH home, and the content webview has no filesystem, so the desktop
        // owns this the same way it owns plugin installs. DSH's own filesystem
        // provider watches these directories, so a write here reaches the live
        // catalog without a host restart.
        let Some(home) = plugins.backend_home() else {
            write_json(
                &mut stream,
                &serde_json::json!({ "ok": false, "error": "DSH home 未设置" }),
            );
            return;
        };
        let action = if method == "GET" && path.ends_with("/skills") {
            Some(crate::skills::list(&home))
        } else if method == "POST" && path.ends_with("/skills/save") {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(value) => Some(match crate::skills::save(&home, &value) {
                    Ok(result) => result,
                    Err(message) => serde_json::json!({ "ok": false, "error": message }),
                }),
                Err(error) => Some(serde_json::json!({ "ok": false, "error": format!("请求无效: {error}") })),
            }
        } else if method == "POST" && path.ends_with("/skills/install") {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(value) => Some(match crate::skills::install(&home, &value) {
                    Ok(result) => result,
                    Err(message) => serde_json::json!({ "ok": false, "error": message }),
                }),
                Err(error) => Some(serde_json::json!({ "ok": false, "error": format!("请求无效: {error}") })),
            }
        } else if method == "POST" && path.ends_with("/skills/pause") {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(value) => Some(match crate::skills::set_paused(&home, &value) {
                    Ok(result) => result,
                    Err(message) => serde_json::json!({ "ok": false, "error": message }),
                }),
                Err(error) => Some(serde_json::json!({ "ok": false, "error": format!("请求无效: {error}") })),
            }
        } else if method == "POST" && path.ends_with("/skills/remove") {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(value) => Some(match crate::skills::remove(&home, &value) {
                    Ok(result) => result,
                    Err(message) => serde_json::json!({ "ok": false, "error": message }),
                }),
                Err(error) => Some(serde_json::json!({ "ok": false, "error": format!("请求无效: {error}") })),
            }
        } else {
            None
        };
        match action {
            Some(result) => write_json(&mut stream, &result),
            None => {
                stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").ok();
            }
        }
    } else if method == "GET" && path == format!("{api_path}/plugins/external") {
        // DSH-profile bundles (`dsh plugin --profile web add …`) not yet taken
        // over by the desktop. Read straight from the profile directory; the
        // response drives the 「未迁移插件」 group in the manager UI.
        let home = plugins.backend_home();
        match crate::registry::scan_profile_bundles(home.as_deref(), "web") {
            Ok(list) => write_json(&mut stream, &list),
            Err(message) => {
                write_json(&mut stream, &serde_json::json!({ "ok": false, "error": message }))
            }
        }
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
                    write_bundle(
                        &mut stream,
                        body.replace("__BRIDGE_API__", api_base).as_bytes(),
                        "text/javascript; charset=utf-8",
                    );
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

/// Parse a `Content-Length: N` header (case-insensitive) from the header block.
/// Returns 0 when absent, which makes the body collector stop at the header end
/// — the same behavior the old read loop fell back to.
fn content_length(headers: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(headers).ok()?;
    let lower = text.to_ascii_lowercase();
    for line in lower.split("\r\n") {
        if let Some(rest) = line.strip_prefix("content-length:") {
            return rest.trim().parse::<usize>().ok();
        }
    }
    None
}

/// Percent-decode a query-string value: turn `%XX` sequences back into bytes,
/// leave everything else (including `+`) as-is. Matches `decodeURIComponent`
/// semantics, which is what the frontend sends. Malformed `%` (trailing or
/// non-hex) is left literally rather than failing.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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
