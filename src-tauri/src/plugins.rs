//! Desktop plugin registry: scans a local plugins directory and serves the
//! current client-plugin manifest to the DSH content webview.
//!
//! Layout convention (one directory per plugin):
//!
//! ```text
//! plugins/
//!   my-plugin/
//!     package.json     # optional; name / dsh.client / exports["./client"]
//!     client.js        # built client bundle (or the path from exports)
//! ```
//!
//! A directory without `package.json` is still a plugin: the directory name is
//! used as the id and `client.js` as the bundle path.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Built-in desktop plugins, injected into every boot graph in this order.
const BUILTIN_IDS: [&str; 2] = ["@dsh-desktop/session-observer", "@dsh-desktop/hmr"];

/// One graph row handed to the DSH client module system through the injected
/// proxy (same wire shape as `WebBootEntry`).
#[derive(Clone, Serialize)]
pub struct PluginEntry {
    pub id: String,
    pub url: String,
    pub rev: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inject: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub immediately: Option<bool>,
    /// Optional session allow-list. When present and non-empty, the plugin is
    /// only active for the listed session ids.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<String>>,
}

/// The full plugin manifest served at `GET /plugins/state`.
#[derive(Clone, Serialize, Default)]
pub struct PluginState {
    pub rev: String,
    pub entries: Vec<PluginEntry>,
}

/// One backend (host-side) plugin discovered in the plugins directory.
struct BackendPlugin {
    id: String,
    file: PathBuf,
}

/// The mutable backend-overlay state used to hot-sync `$DSH_HOME/desktop-overlay`.
struct BackendOverlayState {
    home: Option<PathBuf>,
    profile: String,
    last_rev: String,
}

/// Simple FNV-1a 64-bit hash rendered as hex. Good enough for cache-busting
/// revisions; no external hash crate is needed.
fn short_hash(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Read one plugin directory and build its client entry. Returns `None` when
/// the directory is not a client plugin (no built `client.js`).
fn read_plugin(root: &Path, dir_name: &str, bridge_base: &str) -> Option<PluginEntry> {
    let dir = root.join(dir_name);
    if !dir.is_dir() {
        return None;
    }

    let mut id = dir_name.to_string();
    let mut client_rel = "client.js".to_string();
    let mut inject: Option<Vec<String>> = None;
    let mut immediately = false;
    let mut sessions: Option<Vec<String>> = None;

    let pkg_path = dir.join("package.json");
    if pkg_path.is_file() {
        if let Ok(text) = fs::read_to_string(&pkg_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(name) = value.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        id = name.to_string();
                    }
                }
                if let Some(dsh) = value.get("dsh") {
                    if let Some(client) = dsh.get("client") {
                        if let Some(platform) = client.get("platform").and_then(|v| v.as_str()) {
                            if platform != "web" {
                                return None;
                            }
                        }
                        if let Some(flag) = client.get("immediately").and_then(|v| v.as_bool()) {
                            immediately = flag;
                        }
                        if let Some(list) = client.get("inject").and_then(|v| v.as_array()) {
                            inject = Some(
                                list.iter()
                                    .filter_map(|v| v.as_str().map(str::to_string))
                                    .collect(),
                            );
                        }
                        if let Some(list) = client.get("sessions").and_then(|v| v.as_array()) {
                            sessions = Some(
                                list.iter()
                                    .filter_map(|v| v.as_str().map(str::to_string))
                                    .collect(),
                            );
                        }
                    }
                }
                if let Some(exports) = value.get("exports") {
                    if let Some(client) = exports.get("./client") {
                        if let Some(path) = client.as_str() {
                            client_rel = path.to_string();
                        }
                    }
                }
            }
        }
    }

    let client_path = dir.join(&client_rel);
    if !client_path.is_file() {
        return None;
    }
    let bytes = fs::read(&client_path).ok()?;
    let rev = short_hash(&bytes);
    let url = format!("{bridge_base}/plugins/{id}/client.js?rev={rev}");

    Some(PluginEntry {
        id,
        url,
        rev,
        inject,
        immediately: if immediately { Some(true) } else { None },
        sessions,
    })
}

/// One built-in desktop plugin, served from the bridge instead of the plugins
/// directory. The rev is the id's last segment: these bundles are compiled into
/// the shell and served no-store, so there is nothing to cache-bust against.
fn builtin_entry(id: &str, bridge_base: &str) -> PluginEntry {
    let rev = id.rsplit('/').next().unwrap_or(id).to_string();
    PluginEntry {
        id: id.to_string(),
        url: format!("{bridge_base}/plugins/{id}/client.js?rev={rev}"),
        rev,
        inject: None,
        immediately: Some(true),
        sessions: None,
    }
}

/// Scans the plugin root and returns the current state.
fn scan_state(root: &Path, bridge_base: &str) -> PluginState {
    let mut map = BTreeMap::new();
    // The two built-in halves of the desktop plugin system:
    //   session-observer — reports the current DSH session id to the bridge so
    //                      session-scoped plugins can be applied dynamically.
    //   hmr              — owns the cordis fiber lifecycle (add / rebuild /
    //                      remove desktop plugins without a page reload).
    for id in BUILTIN_IDS {
        map.insert(id.to_string(), builtin_entry(id, bridge_base));
    }
    if let Ok(read_dir) = fs::read_dir(root) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if path.is_dir() && name.starts_with('@') {
                // Scoped packages: `plugins/@scope/name/`.
                if let Ok(scoped) = fs::read_dir(&path) {
                    for sub in scoped.flatten() {
                        let sub_name = sub.file_name().to_string_lossy().into_owned();
                        let full_id = format!("{name}/{sub_name}");
                        if let Some(plugin) = read_plugin(root, &full_id, bridge_base) {
                            map.insert(plugin.id.clone(), plugin);
                        }
                    }
                }
            } else if let Some(plugin) = read_plugin(root, &name, bridge_base) {
                map.insert(plugin.id.clone(), plugin);
            }
        }
    }
    let entries: Vec<PluginEntry> = map.into_values().collect();
    let rev = short_hash(
        entries
            .iter()
            .map(|e| format!("{}@{}@{}", e.id, e.rev, e.url))
            .collect::<Vec<_>>()
            .join(",")
            .as_bytes(),
    );
    PluginState { rev, entries }
}

/// Sanitize a plugin id into a stable YAML row id.
fn sanitize_id(id: &str) -> String {
    let mut out = String::new();
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() {
        out.push_str("plugin");
    }
    out
}

/// Find the backend entry file inside one plugin directory.
fn backend_file_for_dir(dir: &Path) -> Option<PathBuf> {
    for name in ["server.js", "index.mjs", "index.js"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Scan the plugin root for backend halves (`server.js` / `index.mjs` / `index.js`).
fn backend_plugins(root: &Path) -> Vec<BackendPlugin> {
    let mut out = Vec::new();
    if let Ok(read_dir) = fs::read_dir(root) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() && name.starts_with('@') {
                if let Ok(scoped) = fs::read_dir(&path) {
                    for sub in scoped.flatten() {
                        let sub_path = sub.path();
                        let sub_name = sub.file_name().to_string_lossy().into_owned();
                        if sub_path.is_dir() {
                            if let Some(file) = backend_file_for_dir(&sub_path) {
                                let id = format!("desktop-{}", sanitize_id(&format!("{name}/{sub_name}")));
                                out.push(BackendPlugin { id, file });
                            }
                        }
                    }
                }
            } else if path.is_dir() {
                if let Some(file) = backend_file_for_dir(&path) {
                    let id = format!("desktop-{}", sanitize_id(&name));
                    out.push(BackendPlugin { id, file });
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Build a `file:///` URL for a Windows/Unix absolute path.
fn file_url(path: &Path) -> String {
    let abs = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut raw = abs.to_string_lossy().into_owned();
    // Windows `canonicalize` returns `\\?\C:\...` verbatim paths; strip the
    // prefix so the file URL is the normal `file:///C:/...` form.
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        raw = stripped.to_string();
    }
    let raw = raw.replace('\\', "/");
    let encoded = raw
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    format!("file:///{encoded}")
}

/// One parsed row from an existing overlay file.
struct ParsedRow {
    id: String,
    body: Vec<String>,
}

/// Parse all `- id:` rows from an existing overlay text. This is intentionally
/// line-based: the overlay files we manage are simple YAML patch lists.
fn parse_existing_rows(text: &str) -> Vec<ParsedRow> {
    let mut rows = Vec::new();
    let mut current: Option<ParsedRow> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("- id:") {
            if let Some(prev) = current.take() {
                rows.push(prev);
            }
            current = Some(ParsedRow {
                id: rest.trim().to_string(),
                body: Vec::new(),
            });
        } else if let Some(row) = current.as_mut() {
            if !line.trim().is_empty() {
                row.body.push(line.to_string());
            }
        }
    }
    if let Some(prev) = current.take() {
        rows.push(prev);
    }
    rows
}

/// Rewrite `$DSH_HOME/desktop-overlay/cordis.yml` from the current backend set.
/// Desktop-managed rows (`id: desktop-...`) are replaced; other rows (such as
/// the hand-written notify plugin) are preserved and deduplicated.
fn write_overlay(home: &Path, profile: &str, plugins: &[BackendPlugin]) {
    let dir = home.join("desktop-overlay");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("cordis.yml");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let mut kept: Vec<ParsedRow> = Vec::new();
    for row in parse_existing_rows(&existing) {
        if row.id.starts_with("desktop-") {
            continue;
        }
        if let Some(pos) = kept.iter().position(|r| r.id == row.id) {
            kept.remove(pos);
        }
        kept.push(row);
    }

    let mut yaml = String::new();
    if !kept.is_empty() || !plugins.is_empty() {
        yaml.push_str("- insert:\n");
        for row in &kept {
            yaml.push_str(&format!("    - id: {}\n", row.id));
            for body_line in &row.body {
                yaml.push_str(body_line);
                yaml.push('\n');
            }
        }
        for plugin in plugins {
            if kept.iter().any(|row| row.id == plugin.id) {
                continue;
            }
            yaml.push_str(&format!(
                "    - id: {}\n      name: '{}'\n",
                plugin.id,
                file_url(&plugin.file)
            ));
        }
    } else {
        yaml.push_str("[]\n");
    }
    let _ = fs::write(&path, yaml);
    let _ = profile; // reserved for future per-profile overlays
}

/// Touch the profile patch file so DSH's `watchUserPatches` recomposes the
/// live tree (which re-reads `--patch` overlays too).
fn touch_profile_patch(home: &Path, profile: &str) {
    let patch = home.join("profiles").join(profile).join("cordis.patch.yml");
    if !patch.is_file() {
        return;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut content = fs::read_to_string(&patch).unwrap_or_default();
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("# desktop-overlay sync {stamp}\n"));
    let _ = fs::write(&patch, content);
}

/// Owns the plugin root, the current manifest, and the background watcher.
pub struct PluginManager {
    root: PathBuf,
    state: Arc<Mutex<PluginState>>,
    bridge_base: Mutex<String>,
    backend: Mutex<BackendOverlayState>,
    current_session: Mutex<Option<String>>,
}

impl PluginManager {
    /// Create the manager, ensure the plugin root exists, and scan it once.
    pub fn new(root: PathBuf, bridge_base: String) -> Self {
        let _ = fs::create_dir_all(&root);
        let state = Arc::new(Mutex::new(scan_state(&root, &bridge_base)));
        Self {
            root,
            state,
            bridge_base: Mutex::new(bridge_base),
            backend: Mutex::new(BackendOverlayState {
                home: None,
                profile: "web".into(),
                last_rev: String::new(),
            }),
            current_session: Mutex::new(None),
        }
    }

    pub fn state(&self) -> Arc<Mutex<PluginState>> {
        self.state.clone()
    }

    /// The built-in session observer bundle, with the bridge URL substituted.
    fn session_observer_script(&self) -> String {
        let base = self.bridge_base.lock().unwrap().clone();
        include_str!("session-observer.js").replace("__BRIDGE__", &base)
    }

    /// Bundle source for a built-in plugin id, or `None` when the id belongs to
    /// the plugins directory. Built-ins ship inside the shell binary.
    pub fn builtin_script(&self, id: &str) -> Option<String> {
        match id {
            "@dsh-desktop/session-observer" => Some(self.session_observer_script()),
            // The HMR driver reads window.__DSH_DESKTOP__, not the bridge, so it
            // needs no substitution.
            "@dsh-desktop/hmr" => Some(include_str!("hmr-plugin.js").to_string()),
            _ => None,
        }
    }

    /// Update the bridge base after the loopback server has bound. Plugin
    /// entries carry absolute URLs, so the manifest is re-scanned.
    pub fn set_bridge_base(&self, base: String) {
        *self.bridge_base.lock().unwrap() = base;
        self.scan();
    }

    /// Point the backend overlay at the active DSH home/profile. The next scan
    /// (and every later change) rewrites `desktop-overlay/cordis.yml` and
    /// touches the profile patch so DSH's live patch watcher recomposes.
    pub fn set_backend_home(&self, home: PathBuf, profile: String) {
        {
            let mut state = self.backend.lock().unwrap();
            state.home = Some(home);
            state.profile = profile;
            state.last_rev.clear();
        }
        self.scan();
    }

    /// Update the current DSH session id (reported by the built-in observer).
    pub fn set_current_session(&self, session: Option<String>) {
        *self.current_session.lock().unwrap() = session;
    }

    /// Current DSH session id, if known.
    pub fn current_session(&self) -> Option<String> {
        self.current_session.lock().unwrap().clone()
    }

    /// Re-scan the root and update the shared state when anything changed.
    pub fn scan(&self) {
        let base = self.bridge_base.lock().unwrap().clone();
        let next = scan_state(&self.root, &base);
        {
            let mut guard = self.state.lock().unwrap();
            if guard.rev != next.rev {
                *guard = next;
            }
        }
        self.sync_backend();
    }

    fn sync_backend(&self) {
        let home_opt = self.backend.lock().unwrap().home.clone();
        let mut plugins = backend_plugins(&self.root);
        // Preserve the legacy hand-written overlay plugin (notifications) that
        // lives directly in `$DSH_HOME/desktop-overlay/index.mjs`.
        if let Some(home) = &home_opt {
            let legacy = home.join("desktop-overlay").join("index.mjs");
            if legacy.is_file() {
                plugins.push(BackendPlugin {
                    id: "dsh-desktop-notify".into(),
                    file: legacy,
                });
            }
        }
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        let rev = short_hash(
            plugins
                .iter()
                .map(|p| format!("{}@{}", p.id, p.file.display()))
                .collect::<Vec<_>>()
                .join(",")
                .as_bytes(),
        );
        let mut state = self.backend.lock().unwrap();
        if state.home.is_none() || state.last_rev == rev {
            return;
        }
        state.last_rev = rev;
        let home = state.home.clone().unwrap();
        let profile = state.profile.clone();
        write_overlay(&home, &profile, &plugins);
        touch_profile_patch(&home, &profile);
    }

    /// Resolve a plugin id to its `client.js` path (also used by the bridge
    /// HTTP handler to serve bundles).
    pub fn client_path(&self, id: &str) -> Option<PathBuf> {
        // The id may be a scoped package name (`@scope/name`). It is used
        // directly as a relative directory path under the plugin root.
        let dir = self.root.join(id);
        if !dir.is_dir() {
            return None;
        }
        // Fast path: the conventional file name.
        let conventional = dir.join("client.js");
        if conventional.is_file() {
            return Some(conventional);
        }
        // If package.json redirects ./client, honor it.
        let pkg_path = dir.join("package.json");
        if pkg_path.is_file() {
            if let Ok(text) = fs::read_to_string(&pkg_path) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(exports) = value.get("exports") {
                        if let Some(client) = exports.get("./client") {
                            if let Some(rel) = client.as_str() {
                                let candidate = dir.join(rel);
                                if candidate.is_file() {
                                    return Some(candidate);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Start a polling watcher. Plugins are re-scanned every second; the DSH
    /// page proxy polls `/plugins/state`, so changes reach the UI without a
    /// restart.
    pub fn start_watcher(self: Arc<Self>) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            self.scan();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn overlay_dedupes_and_preserves_legacy() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-overlay-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let overlay_dir = home.join("desktop-overlay");
        fs::create_dir_all(&overlay_dir).unwrap();
        fs::create_dir_all(root.join("hello")).unwrap();
        fs::write(root.join("hello/server.js"), "export const name='hello';").unwrap();
        fs::write(
            overlay_dir.join("index.mjs"),
            "export const name='dsh-desktop-notify';",
        )
        .unwrap();
        fs::write(
            overlay_dir.join("cordis.yml"),
            "- insert:\n    - id: dsh-desktop-notify\n      name: 'file:///old'\n    - id: desktop-stale\n      name: 'file:///stale'\n",
        )
        .unwrap();

        let plugins = vec![
            BackendPlugin {
                id: "desktop-desktop-hello".into(),
                file: root.join("hello/server.js"),
            },
            BackendPlugin {
                id: "dsh-desktop-notify".into(),
                file: overlay_dir.join("index.mjs"),
            },
        ];
        write_overlay(&home, "web", &plugins);

        let out = fs::read_to_string(overlay_dir.join("cordis.yml")).unwrap();
        assert_eq!(out.matches("dsh-desktop-notify").count(), 1);
        assert_eq!(out.matches("desktop-desktop-hello").count(), 1);
        assert!(!out.contains("desktop-stale"), "output: {out}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_bridge_base_updates_urls() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-base-test-{}-{:?}",
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

        let manager = PluginManager::new(root.clone(), String::new());
        let initial = manager.state().lock().unwrap().clone();
        assert!(initial.entries[0].url.starts_with("/plugins/"));

        manager.set_bridge_base("http://127.0.0.1:1234".into());
        let updated = manager.state().lock().unwrap().clone();
        assert!(
            updated.entries[0]
                .url
                .starts_with("http://127.0.0.1:1234/plugins/"),
            "url: {}",
            updated.entries[0].url
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_plugin_directory() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-plugin-test-{}-{:?}",
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

        let manager = PluginManager::new(root.clone(), "http://127.0.0.1:1".into());
        let state = manager.state().lock().unwrap().clone();
        assert!(state.entries.iter().any(|e| e.id == "hello"));
        let hello = state
            .entries
            .iter()
            .find(|e| e.id == "hello")
            .expect("hello entry");
        assert!(hello
            .url
            .starts_with("http://127.0.0.1:1/plugins/hello/client.js"));

        let _ = fs::remove_dir_all(&root);
    }
}
