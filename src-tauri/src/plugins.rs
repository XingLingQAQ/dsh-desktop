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
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Built-in desktop plugins, injected into every boot graph in this order.
const BUILTIN_IDS: [&str; 5] = [
    "@dsh-desktop/session-observer",
    "@dsh-desktop/hmr",
    "@dsh-desktop/store",
    "@dsh-desktop/models-manager",
    "@dsh-desktop/usage",
];

/// Whether `id` is a built-in desktop plugin. Built-ins ship inside the shell
/// binary and cannot be disabled or uninstalled.
pub fn is_builtin(id: &str) -> bool {
    BUILTIN_IDS.contains(&id)
}

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
    /// Exact content of the watched patch file as this process last wrote it.
    ///
    /// The file is not ours alone: DSH's Loader writes its composed tree back
    /// when a plugin persists a row, which flattens the `!!js` expressions it
    /// cannot represent and strips the `# dsh-desktop` markers. A flattened
    /// `disabled:` expression becomes a non-empty string — truthy — so the row it
    /// guards silently stays disabled and its host routes never register.
    /// Comparing the file against this snapshot is how a foreign write is noticed
    /// and repaired on the next watcher tick.
    last_patch: String,
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
                        // `exports["./client"]` is either a string path or an
                        // object like `{"types": "...", "default": "./lib/client.js"}`;
                        // the runtime bundle is the `.default` string in the latter.
                        if let Some(path) = client
                            .as_str()
                            .or_else(|| client.get("default").and_then(|d| d.as_str()))
                        {
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
fn scan_state(root: &Path, bridge_base: &str, disabled: &HashSet<String>) -> PluginState {
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
            // The hoisted-store junction / schemastery alias live here; they
            // are not plugins. Dot-prefixed names are the shell's own scratch
            // space (`.staging` while an install assembles a tree).
            if name == "node_modules" || name.starts_with('.') {
                continue;
            }
            if path.is_dir() && name.starts_with('@') {
                // Scoped packages: `plugins/@scope/name/`.
                if let Ok(scoped) = fs::read_dir(&path) {
                    for sub in scoped.flatten() {
                        let sub_name = sub.file_name().to_string_lossy().into_owned();
                        let full_id = format!("{name}/{sub_name}");
                        if let Some(plugin) = read_plugin(root, &full_id, bridge_base) {
                            // Built-ins are never skipped; disk plugins that the
                            // user has paused are excluded from the boot graph.
                            if !is_builtin(&plugin.id) && disabled.contains(&plugin.id) {
                                continue;
                            }
                            map.insert(plugin.id.clone(), plugin);
                        }
                    }
                }
            } else if let Some(plugin) = read_plugin(root, &name, bridge_base) {
                if !is_builtin(&plugin.id) && disabled.contains(&plugin.id) {
                    continue;
                }
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
///
/// Bundle-patch plugins (inserts or top-level id-targeted rows) are skipped:
/// they own their overlay rows via `registry::prepare_host_half` (author ids,
/// `config:` / `disabled:` guards intact). A scanned `desktop-*` row would
/// either fail schema validation (dsh-plus) or double-mount the same host
/// half (skin-market / better-sidebar).
///
/// Otherwise conventional roots (`server.js` / `index.mjs` / `index.js`),
/// then `package.json` `main` / `exports["."]`, so a host entry at
/// `lib/index.js` is still discovered when there is no bundle patch.
fn backend_file_for_dir(dir: &Path) -> Option<PathBuf> {
    // Bundle-patch inserts own the overlay rows (author ids + config/guards).
    // Check that first: a conventional `index.js` at the package root would
    // otherwise claim the plugin as a scanned `desktop-*` row and double-mount.
    let pkg_path = dir.join("package.json");
    if let Ok(text) = fs::read_to_string(&pkg_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(declared) = value
                .get("dsh")
                .and_then(|d| d.get("bundle"))
                .and_then(|b| b.get("patch"))
                .and_then(|p| p.as_str())
            {
                let patch_text = fs::read_to_string(dir.join(declared)).unwrap_or_default();
                if !crate::registry::parse_bundle_inserts(&patch_text).is_empty()
                    || !crate::registry::parse_bundle_top_level(&patch_text).is_empty()
                {
                    return None;
                }
            }
        }
    }
    for name in ["server.js", "index.mjs", "index.js"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let text = fs::read_to_string(&pkg_path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let rel = value
        .get("main")
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .or_else(|| {
            let exported = value.get("exports")?.get(".")?;
            exported
                .as_str()
                .or_else(|| exported.get("default").and_then(|d| d.as_str()))
                .map(str::to_string)
        })?;
    let candidate = dir.join(rel.trim_start_matches("./"));
    if candidate.is_file() {
        return Some(candidate);
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
            if name == "node_modules" || name.starts_with('.') {
                continue;
            }
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

/// One parsed row from a patch file. Two kinds sit at column 0: an `Id` row
/// (`- id: <id>`) patches an existing loader entry with the overrides in
/// `body`; an `Insert` row (`- insert:`) mounts new entries, with its
/// children in `body` at column-4 indentation.
///
/// `managed` marks rows the desktop owns — `sync_host_half_patch` rewrites
/// those freely and preserves everything else (user rows, native-disable
/// rows) verbatim, so a host-half sync never clobbers a user's own patch.
#[derive(Clone)]
struct ParsedRow {
    kind: RowKind,
    /// `Id` rows: the target entry id. `Insert` rows: empty (the block has no id).
    id: String,
    /// Verbatim body lines at original indentation. `Id`: override lines
    /// (`  disabled: true`, `  config:`). `Insert`: column-4 children
    /// (`    - id: modsearch`, `      name: '...'`).
    body: Vec<String>,
    /// True when the row carries a trailing `# dsh-desktop` marker. The
    /// desktop rewrites managed rows on every sync; unmarked rows are user /
    /// native-disable rows preserved as-is.
    managed: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum RowKind {
    /// `- id: <id>` — patches an existing entry by id.
    Id,
    /// `- insert:` — mounts new entries; children live in `body`.
    Insert,
}

/// Drop the children whose id is in `remove` from one insert row's body lines.
///
/// A child opens with `    - id: <id>` at column 4 and owns every deeper line
/// until the next such opener, so the filter walks the body once and skips whole
/// child blocks rather than trying to reparse the YAML.
fn retain_insert_children(body: &[String], remove: &std::collections::HashSet<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(body.len());
    let mut dropping = false;
    for line in body {
        if let Some(id) = line.strip_prefix("    - id:") {
            dropping = remove.contains(id.trim());
            if dropping {
                continue;
            }
        } else if dropping {
            continue;
        }
        out.push(line.clone());
    }
    out
}

/// Rewrite the desktop-managed host-half rows in the HMR-watched profile patch
/// (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). Rows the desktop owns are
/// tagged `# dsh-desktop`; on every sync they are dropped and rebuilt from the
/// current backend set, while unmarked rows — the user's own patches and
/// native-disable overrides written by [`write_native_disable`] — are preserved
/// verbatim. `watchUserPatches` recomposes the live Loader tree from the new
/// file content within seconds, so host-half install / uninstall / adopt /
/// update takes effect with no host restart.
///
/// `plugins` are the scanned `desktop-*` backend entries plus the legacy
/// `dsh-desktop-notify`; `bundle_rows` are the host-half rows each installed
/// bundle-patch plugin contributes (inserts with `file:///` names + top-level
/// config overrides).
///
/// The emitted row order matters: the insert block always comes first, because
/// DSH applies patch rows in file order and an `- id:` row can only match a
/// target that an earlier row already created. See the ordering note inside.
fn sync_host_half_patch(
    home: &Path,
    profile: &str,
    plugins: &[BackendPlugin],
    bundle_rows: &[crate::registry::BundleHostRows],
) -> String {
    let patch = home.join("profiles").join(profile).join("cordis.patch.yml");
    if let Some(parent) = patch.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let text = fs::read_to_string(&patch).unwrap_or_default();
    let mut file = parse_patch_file(&text);

    // One-time migration: the legacy frozen overlay (`desktop-overlay/cordis.yml`,
    // loaded once at boot and never re-read by `watchUserPatches`) used to hold
    // these rows. Fold its user-content top-level disables (e.g. `ui-settings-*`)
    // into the watched patch as UNMANAGED rows so they survive the rebuild, then
    // truncate the overlay. Managed rows are rebuilt below from the live set.
    migrate_legacy_overlay(home, &mut file);

    // Insert-child ids the previous sync mounted. Any id-targeted row still
    // aimed at one of these after it drops out of the new insert block is dead
    // weight, pruned below. Only the desktop's OWN insert blocks count: a
    // foreign block (the Loader's config write-back, a skin market persisting a
    // row) keeps creating its ids every boot, so a top-level row aimed at one of
    // them is live configuration — including the `disabled: false` a native
    // resume pins there — and must not be swept away as a leftover.
    let previous_insert_ids: std::collections::HashSet<String> = file
        .rows
        .iter()
        .filter(|r| r.kind == RowKind::Insert && r.managed)
        .flat_map(|r| r.body.iter())
        .filter_map(|line| {
            line.trim_start()
                .strip_prefix("- id:")
                .map(|rest| rest.trim().to_string())
        })
        .collect();

    // Drop previously-managed rows (tagged `# dsh-desktop`) and leftover
    // host-hotload canaries. Unmanaged rows survive untouched — including
    // unmanaged INSERT blocks, which a plugin can legitimately leave behind: the
    // Loader's config write-back dumps the composed tree into this file, so a
    // plugin that persists a row of its own (a skin market recording the selected
    // skin) shows up as one. Their overlap with the desktop's own block is pruned
    // further down instead of thrown away.
    file.rows.retain(|r| {
        !r.managed && !r.id.starts_with("hot-canary-") && !r.id.starts_with("hot-test-")
    });

    // One Insert block with every host-half entry: bundle inserts (file:///
    // names) first, then scanned desktop-* plugins not already covered.
    let mut insert_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut insert_body: Vec<String> = Vec::new();
    for bundle in bundle_rows {
        for row in &bundle.inserts {
            let Some(name) = row.name.as_deref() else { continue };
            if !insert_ids.insert(row.id.clone()) {
                continue;
            }
            insert_body.push(format!("    - id: {}", row.id));
            insert_body.push(format!("      name: '{}'", name));
            for extra in &row.extra {
                insert_body.push(extra.clone());
            }
        }
    }
    for plugin in plugins {
        if !insert_ids.insert(plugin.id.clone()) {
            continue;
        }
        insert_body.push(format!("    - id: {}", plugin.id));
        insert_body.push(format!("      name: '{}'", file_url(&plugin.file)));
    }

    // Prune the desktop's own ids out of any surviving unmanaged insert block.
    // The Loader's write-back dumps the WHOLE composed tree, so such a block
    // usually repeats every row this sync is about to emit — two inserts with the
    // same id abort the host boot outright («duplicate loader entry id»). The
    // desktop's block is the authoritative copy (a dump also flattens the `!!js`
    // expressions it cannot represent), so its ids win and whatever else the
    // block carries — a skin the user picked, say — stays.
    for row in file.rows.iter_mut() {
        if row.kind != RowKind::Insert {
            continue;
        }
        row.body = retain_insert_children(&row.body, &insert_ids);
    }
    file.rows.retain(|r| r.kind != RowKind::Insert || !r.body.is_empty());

    // plugin's leftover `disabled: true` pause row, for instance. Left in
    // place it only yields a loader "entry not found" warning, and it would
    // silently re-pause the plugin's host half if it were ever reinstalled.
    file.rows.retain(|r| {
        r.kind != RowKind::Id
            || !previous_insert_ids.contains(&r.id)
            || insert_ids.contains(&r.id)
    });

    // Emission order is load-bearing. `applyEntryPatches` walks the patch list
    // in order and only indexes an insert's children once it reaches that
    // insert row, so an `- id:` row placed BEFORE the insert block that creates
    // its target matches nothing, warns, and is silently skipped. The insert
    // block therefore goes FIRST, ahead of every id-targeted row: the user's
    // own rows, the `disabled: true` pause rows [`write_native_disable`]
    // appends, and the desktop's top-level overrides all need their targets to
    // already exist.
    let mut rows: Vec<ParsedRow> = Vec::with_capacity(file.rows.len() + 1 + bundle_rows.len());
    if !insert_body.is_empty() {
        rows.push(ParsedRow {
            kind: RowKind::Insert,
            id: String::new(),
            body: insert_body,
            managed: true,
        });
    }
    rows.append(&mut file.rows);

    // Top-level Id overrides claimed by bundle patches (e.g. `web.searchProvider`
    // from @liustack/modsearch). Last, so they outrank a user row on the same id.
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for bundle in bundle_rows {
        for (tid, _) in &bundle.top_level {
            claimed.insert(tid.clone());
        }
    }
    // Drop any existing row on a claimed id before re-adding it. The `# dsh-desktop`
    // marker cannot be relied on here: the Loader's write-back rewrites this file
    // without comments, so a row the desktop wrote comes back looking like a user
    // row and the same override would stack up a copy on every sync.
    rows.retain(|r| r.kind != RowKind::Id || !claimed.contains(&r.id));
    let mut emitted: std::collections::HashSet<String> = std::collections::HashSet::new();
    for bundle in bundle_rows {
        for (tid, body) in &bundle.top_level {
            if !emitted.insert(tid.clone()) {
                continue;
            }
            rows.push(ParsedRow {
                kind: RowKind::Id,
                id: tid.clone(),
                body: body.clone(),
                managed: true,
            });
        }
    }
    file.rows = rows;

    let mut out = emit_patch(&file);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    // Replace the trailing sync marker with a fresh stamp so
    // `watchUserPatches` recomposes the live Loader tree from the new file.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let marker = "# desktop-overlay sync";
    let lines: Vec<&str> = out.lines().collect();
    let mut kept: Vec<String> = Vec::with_capacity(lines.len() + 1);
    for line in &lines {
        if line.starts_with(marker) {
            continue;
        }
        kept.push(line.to_string());
    }
    kept.push(format!("{marker} {stamp}"));
    let mut final_out = kept.join("\n");
    final_out.push('\n');
    let _ = write_patch_atomic(&patch, &final_out);
    final_out
}

/// Replace the watched patch file in one step: write a sibling temp file, then
/// rename it over the target. DSH's watcher reacts to the rename with the whole
/// new content — a plain truncate-then-write can be observed half-written, and
/// the resulting parse failure aborts the recompose (the live tree survives, but
/// that generation's change is lost).
fn write_patch_atomic(patch: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = patch.with_extension("yml.tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, patch)
}

/// Fold the legacy frozen overlay (`desktop-overlay/cordis.yml`) into the
/// watched profile patch, then truncate it. Only user-content top-level rows
/// (disables on built-in entries like `ui-settings-*`) are carried over as
/// UNMANAGED rows — everything else the overlay held is rebuilt by
/// [`sync_host_half_patch`] from the live backend set. Idempotent: once the
/// overlay is `[]`, this is a no-op.
fn migrate_legacy_overlay(home: &Path, file: &mut PatchFile) {
    let overlay_path = home.join("desktop-overlay").join("cordis.yml");
    if !overlay_path.is_file() {
        return;
    }
    let legacy = fs::read_to_string(&overlay_path).unwrap_or_default();
    if legacy.trim().is_empty() || legacy.trim() == "[]" {
        return;
    }
    let legacy_file = parse_patch_file(&legacy);
    let existing_ids: std::collections::HashSet<String> =
        file.rows.iter().map(|r| r.id.clone()).collect();
    for row in legacy_file.rows {
        if row.kind == RowKind::Id
            && row.id.starts_with("ui-settings-")
            && !existing_ids.contains(&row.id)
        {
            file.rows.push(ParsedRow {
                kind: RowKind::Id,
                id: row.id,
                body: row.body,
                managed: false,
            });
        }
    }
    let _ = fs::write(&overlay_path, "[]\n");
}

/// A parsed profile patch file split into the leading comment header, the
/// `PatchOptions` rows (each one a `- id:` entry and its indented body), and
/// the trailing `# desktop-overlay sync` comments each sync appends. Keeping the
/// trailing block separate lets us rewrite the rows without dropping or
/// duplicating the sync markers.
struct PatchFile {
    header: Vec<String>,
    rows: Vec<ParsedRow>,
    trailing: Vec<String>,
}

/// Parse `$DSH_HOME/profiles/<profile>/cordis.patch.yml` into header / rows /
/// trailing. The file is a top-level YAML array of `PatchOptions`; in practice
/// it opens with a few comment lines, then either `[]` (empty marker) or the
/// `- id:` rows, then the `# desktop-overlay sync <stamp>` tail.
fn parse_patch_file(text: &str) -> PatchFile {
    let mut header = Vec::new();
    let mut rows = Vec::new();
    let mut trailing = Vec::new();

    // The `# desktop-overlay sync` tail is appended after every desktop sync.
    // Anything from the first such marker onward is trailing commentary, not a
    // patch row, so peel it off before row parsing sees it.
    let split_at = text.find("# desktop-overlay sync");
    let (head, tail) = match split_at {
        Some(idx) => (&text[..idx], Some(&text[idx..])),
        None => (text, None),
    };
    if let Some(rest) = tail {
        for line in rest.lines() {
            trailing.push(line.to_string());
        }
    }

    // A `# dsh-desktop` line is a sibling comment that tags the NEXT row as
    // desktop-owned. `sync_host_half_patch` rewrites managed rows freely and
    // preserves everything else (user rows, `write_native_disable` rows)
    // verbatim, so a host-half sync never clobbers a user's own patch. The
    // marker lives outside any row's YAML — the loader treats it as a comment.
    let mut next_managed = false;
    for line in head.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            // Blank lines between header and rows are dropped — `emit_patch`
            // re-emits the structure from scratch.
            continue;
        }
        if trimmed == "[]" {
            // empty-array marker — drop; the emitter re-adds `[]` when there
            // are no rows.
            continue;
        }
        if trimmed == "# dsh-desktop" {
            next_managed = true;
            continue;
        }
        // A `- insert:` at column 0 opens a new Insert row (mounts entries);
        // its indented children are collected into `body`. An indented
        // `- id:` (an insert child) does NOT match here — it falls through to
        // the last-row body branch below.
        if line.starts_with("- insert:") {
            rows.push(ParsedRow {
                kind: RowKind::Insert,
                id: String::new(),
                body: Vec::new(),
                managed: next_managed,
            });
            next_managed = false;
        } else if line.starts_with("- id:") {
            let rest = trimmed[1..]
                .trim_start()
                .strip_prefix("id:")
                .unwrap_or("")
                .trim();
            rows.push(ParsedRow {
                kind: RowKind::Id,
                id: rest.to_string(),
                body: Vec::new(),
                managed: next_managed,
            });
            next_managed = false;
        } else if let Some(row) = rows.last_mut() {
            // An indented child line of the current row (config / disabled /
            // an insert's `- id:` child). Keep the original indented form.
            row.body.push(line.to_string());
        } else {
            // Anything before the first row is header text (the explanatory
            // banner at the top of the file).
            header.push(line.to_string());
        }
    }

    PatchFile { header, rows, trailing }
}

/// Re-emit a parsed patch file. Header comments first, then the rows, then the
/// trailing sync markers. An `Id` row is `- id:` + its indented body; an
/// `Insert` row is `- insert:` + its column-4 children (already indented in
/// `body`). A `# dsh-desktop` marker is re-emitted above any managed row so
/// the next parse re-tags it. When there are no rows, emit `[]` so the file
/// stays a valid empty YAML array.
fn emit_patch(file: &PatchFile) -> String {
    let mut out = String::new();
    for line in &file.header {
        out.push_str(line);
        out.push('\n');
    }
    if file.rows.is_empty() {
        out.push_str("[]\n");
    } else {
        for row in &file.rows {
            if row.managed {
                out.push_str("# dsh-desktop\n");
            }
            match row.kind {
                RowKind::Id => {
                    out.push_str(&format!("- id: {}\n", row.id));
                }
                RowKind::Insert => {
                    out.push_str("- insert:\n");
                }
            }
            for body_line in &row.body {
                out.push_str(body_line);
                out.push('\n');
            }
        }
    }
    for line in &file.trailing {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// How a resume should be expressed in the patch file. Pausing is unambiguous
/// (`disabled: true`); coming back is not, because the desktop's user layer is
/// one of several and `applyEntryPatches` merges by plain assignment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Resume {
    /// Delete the override and let the layers below decide again. Right for a
    /// desktop-managed plugin: its row lives in the desktop's own insert block
    /// and may carry a `!!js` mount guard (better-sidebar disables itself when
    /// the same package is already active elsewhere). Pinning `disabled: false`
    /// over that guard would defeat it and double-mount the plugin.
    DropOverride,
    /// Write `disabled: false` explicitly. Required for a native entry: the
    /// thing that disabled it sits in a layer *below* the user patch — a bundle
    /// patch row, or a `disabled: true` inside an insert block — and deleting
    /// the desktop's row just restores that layer's `true`. Only a later
    /// assignment of `false` outranks it.
    Override,
}

/// Write a `disabled` override for a native (DSH Loader) entry into the
/// HMR-watched profile patch. `disabled = true` pauses the entry by upserting
/// a `  disabled: true` line under its `- id:` row (creating the row if the
/// entry has no patch yet). Resuming follows `resume`: either the row is
/// stripped back out, or it is pinned to `disabled: false`.
///
/// The file is touched with a new `# desktop-overlay sync <stamp>` tail so
/// `watchUserPatches` recomposes the live tree within seconds.
fn write_native_disable(
    home: &Path,
    profile: &str,
    entry_id: &str,
    disabled: bool,
    resume: Resume,
) -> Result<(), String> {
    let patch = home.join("profiles").join(profile).join("cordis.patch.yml");
    let text = fs::read_to_string(&patch).unwrap_or_default();
    let mut file = parse_patch_file(&text);

    // Find (or create) the row for this entry id. Patch ids may carry a
    // Loader-generated path prefix (`<parent>:<child>`, `EntryTree.sep` is
    // `:`), so fall back to a prefix match — but only across that separator.
    // A bare `starts_with` would let `desktop-hello` latch onto a
    // `desktop-hello2` row and pause the wrong plugin. Only `Id` rows are
    // candidates: an `Insert` row carries an empty id, and matching it would
    // push the override *into* the insert block, disabling every child.
    let mut pos = file
        .rows
        .iter()
        .position(|r| r.kind == RowKind::Id && r.id == entry_id);
    if pos.is_none() {
        let nested_of = |long: &str, short: &str| {
            long.len() > short.len()
                && long.starts_with(short)
                && long.as_bytes()[short.len()] == b':'
        };
        pos = file.rows.iter().position(|r| {
            r.kind == RowKind::Id
                && !r.id.is_empty()
                && (nested_of(&r.id, entry_id) || nested_of(entry_id, &r.id))
        });
    }
    if pos.is_none() {
        file.rows.push(ParsedRow {
            kind: RowKind::Id,
            id: entry_id.to_string(),
            body: Vec::new(),
            managed: false,
        });
        pos = Some(file.rows.len() - 1);
    }
    let idx = pos.unwrap();

    // Strip any existing `disabled:` override so the new value is the single
    // source of truth. Scoped so the mutable borrow of `file.rows[idx]` ends
    // before the row-removal branch below borrows `file.rows` again.
    {
        let row = &mut file.rows[idx];
        row.body.retain(|line| {
            let t = line.trim_start();
            !(t.starts_with("disabled:") || t.starts_with("disabled :"))
        });
        if disabled || resume == Resume::Override {
            // Insert the override as the first body line so it reads cleanly
            // under the `- id:` row.
            let value = if disabled { "true" } else { "false" };
            let mut new_body = vec![format!("  disabled: {value}")];
            new_body.extend(row.body.drain(..));
            row.body = new_body;
        }
    }

    if !disabled && resume == Resume::DropOverride && file.rows[idx].body.is_empty() {
        // No overrides left and no other body — drop the row so the file
        // doesn't accumulate empty entries.
        file.rows.remove(idx);
    }

    let mut out = emit_patch(&file);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    out.push_str(&format!("# desktop-overlay sync {stamp}\n"));
    // Deduplicate trailing sync markers: a freshly appended marker plus the
    // pre-existing tail would otherwise stack up. Drop any prior trailing
    // sync lines before writing the new one.
    let marker = "# desktop-overlay sync";
    let lines: Vec<&str> = out.lines().collect();
    let mut kept: Vec<String> = Vec::with_capacity(lines.len() + 1);
    for line in &lines {
        if line.starts_with(marker) {
            continue;
        }
        kept.push(line.to_string());
    }
    kept.push(format!("{marker} {stamp}"));
    let mut final_out = kept.join("\n");
    final_out.push('\n');

    if let Some(parent) = patch.parent() {
        let _ = fs::create_dir_all(parent);
    }
    write_patch_atomic(&patch, &final_out).map_err(|e| format!("写入 patch 失败：{e}"))?;
    Ok(())
}

/// Owns the plugin root, the current manifest, and the background watcher.
pub struct PluginManager {
    /// The desktop plugins directory. Read-only after construction; exposed
    /// to bridge handlers that need it for per-plugin lookups.
    pub root: PathBuf,
    state: Arc<Mutex<PluginState>>,
    bridge_base: Mutex<String>,
    backend: Mutex<BackendOverlayState>,
    current_session: Mutex<Option<String>>,
    disabled: Mutex<HashSet<String>>,
}

impl PluginManager {
    /// Create the manager, ensure the plugin root exists, and scan it once.
    pub fn new(root: PathBuf, bridge_base: String) -> Self {
        let _ = fs::create_dir_all(&root);
        let disabled: HashSet<String> = crate::plugin_state::load()
            .disabled
            .into_iter()
            .collect();
        let state = Arc::new(Mutex::new(scan_state(
            &root,
            &bridge_base,
            &disabled,
        )));
        Self {
            root,
            state,
            bridge_base: Mutex::new(bridge_base),
            backend: Mutex::new(BackendOverlayState {
                home: None,
                profile: "web".into(),
                last_rev: String::new(),
                last_patch: String::new(),
            }),
            current_session: Mutex::new(None),
            disabled: Mutex::new(disabled),
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
            // Built by `npm run build:plugins`; the bridge substitutes
            // `__BRIDGE_API__` when serving it.
            "@dsh-desktop/store" => Some(include_str!("../../dist-plugins/store.js").to_string()),
            "@dsh-desktop/models-manager" => Some(include_str!("../../dist-plugins/models-manager.js").to_string()),
            "@dsh-desktop/usage" => Some(include_str!("../../dist-plugins/usage.js").to_string()),
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

    /// The active DSH home directory, when known (set once the DSH host has
    /// been launched or attached).
    pub fn backend_home(&self) -> Option<PathBuf> {
        self.backend.lock().unwrap().home.clone()
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
        // Snapshot the disabled set so we don't hold the lock across `scan_state`
        // and the subsequent backend sync (which hits disk).
        let disabled = self.disabled.lock().unwrap().clone();
        let next = scan_state(&self.root, &base, &disabled);
        {
            let mut guard = self.state.lock().unwrap();
            if guard.rev != next.rev {
                *guard = next;
            }
        }
        self.sync_backend();
    }

    /// Whether a plugin is currently paused. Built-in plugins always report
    /// `false`.
    pub fn is_disabled(&self, id: &str) -> bool {
        self.disabled.lock().unwrap().contains(id)
    }

    /// Snapshot of the disabled set (used by callers that need a stable view
    /// without holding the manager's lock).
    pub fn disabled_snapshot(&self) -> HashSet<String> {
        self.disabled.lock().unwrap().clone()
    }

    /// Host-side entry ids a desktop plugin owns in the watched patch's insert
    /// block. Bundle-patch plugins contribute their inserts' author ids (e.g.
    /// `dsh-plus` → `mcp-settings`, `vision-bridge`); a conventional backend
    /// plugin contributes a single `desktop-<sanitize(id)>` row. Pure-client
    /// plugins return empty — pausing them writes no override and leaves no
    /// residue.
    fn host_entry_ids(&self, id: &str) -> Vec<String> {
        let patched = crate::registry::list_patched_host_plugins(&self.root);
        if patched.iter().any(|(pid, _)| pid == id) {
            return crate::registry::collect_bundle_host_rows(&patched)
                .into_iter()
                .find(|(pid, _)| pid == id)
                .map(|(_, rows)| rows.inserts.into_iter().map(|r| r.id).collect())
                .unwrap_or_default();
        }
        let dir = match id.split_once('/') {
            Some((scope, name)) if scope.starts_with('@') => self.root.join(scope).join(name),
            _ => self.root.join(id),
        };
        if dir.is_dir() && crate::registry::dir_has_backend_entry(&dir) {
            vec![format!("desktop-{}", sanitize_id(id))]
        } else {
            Vec::new()
        }
    }

    /// Pause or resume a plugin. Persists the change, re-scans so the boot
    /// graph reflects it, and mirrors the pause onto the host half by writing
    /// a `disabled` override into the HMR-watched profile patch — letting
    /// `watchUserPatches` recompose the live tree so the backend fiber
    /// disposes without a host restart.
    pub fn set_disabled(&self, id: &str, disabled: bool) {
        // Built-in plugins cannot be disabled — they are part of the shell.
        if is_builtin(id) {
            return;
        }
        {
            let mut guard = self.disabled.lock().unwrap();
            if disabled {
                guard.insert(id.to_string());
            } else {
                guard.remove(id);
            }
        }
        // Persist: load the full state to preserve configs, replace only the
        // disabled list (deduped via the HashSet), then save.
        let mut data = crate::plugin_state::load();
        data.disabled = self.disabled.lock().unwrap().iter().cloned().collect();
        let _ = crate::plugin_state::save(&data);

        // Mirror the toggle onto the host half by writing a `disabled` override
        // into the HMR-watched profile patch, letting `watchUserPatches`
        // recompose the live tree so the backend fiber mounts or disposes with no
        // host restart. `scan()` does not rewrite the patch for a pure toggle
        // (the rev fingerprint omits disabled state), so this is the only write.
        // Nothing to mirror when the host isn't running: the boot graph already
        // honors the disabled set.
        let backend = {
            let state = self.backend.lock().unwrap();
            state.home.clone().map(|home| (home, state.profile.clone()))
        };
        let Some((home, profile)) = backend else {
            self.scan();
            return;
        };
        let host_entries = self.host_entry_ids(id);

        // The two halves must come up and go down in opposite orders, because a
        // client half commonly talks to routes its own backend registers. Resume
        // writes the host row first so the backend is live before `scan()`
        // publishes the client row (the frontend polls state on a ~1s tick,
        // which the patch watcher easily beats); pause drops the client row first
        // so it stops calling a backend that is about to go away. Getting this
        // backwards leaves a plugin like whale-girl mounted but blank — it fetches
        // its assets on mount and gives up after about a second of 404s.
        if disabled {
            self.scan();
        }
        for entry_id in &host_entries {
            let _ = write_native_disable(&home, &profile, entry_id, disabled, Resume::DropOverride);
        }
        if !disabled {
            // Give the backend its head start before the client row goes out.
            // The patch watcher is fs-event driven so the host half is usually
            // live within a couple hundred milliseconds, but a client half that
            // fetches on mount and gives up after ~1.5s of 404s renders blank if
            // it wins this race — and it then stays blank until the next toggle.
            // Waiting here costs the resume action about a second and removes the
            // race; a per-entry readiness probe would be better and belongs with
            // the wider mount-pipeline work.
            if !host_entries.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(900));
            }
            self.scan();
        }
        self.remember_patch();
    }

    /// Forget an uninstalled plugin's paused state. The host-half pause row is
    /// pruned by the next [`sync_host_half_patch`] (its insert child is gone),
    /// so only the desktop set needs clearing — otherwise a reinstall would come
    /// back paused on the client while the freshly written host row runs, and
    /// the two halves would disagree.
    pub fn forget(&self, id: &str) {
        if !self.disabled.lock().unwrap().remove(id) {
            return;
        }
        let mut data = crate::plugin_state::load();
        data.disabled = self.disabled.lock().unwrap().iter().cloned().collect();
        let _ = crate::plugin_state::save(&data);
    }

    /// Ids of DSH-profile bundles the desktop has taken over (see
    /// `plugin_state::PluginStateData::managed_externals`). Used by the
    /// management UI to badge migrated plugins and by `list_installed`-style
    /// consumers to distinguish provenance.
    pub fn managed_externals(&self) -> Vec<String> {
        crate::plugin_state::load().managed_externals
    }

    /// Read a plugin's persisted config values, or `{}` when none are stored.
    pub fn get_config(&self, id: &str) -> serde_json::Value {
        crate::plugin_state::load()
            .configs
            .get(id)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}))
    }

    /// Replace a plugin's config values and persist them.
    pub fn set_config(&self, id: &str, values: serde_json::Value) {
        let mut data = crate::plugin_state::load();
        data.configs.insert(id.to_string(), values);
        let _ = crate::plugin_state::save(&data);
    }

    /// Record that one DSH-profile bundle has been taken over by the desktop
    /// (its files now live under the plugins root and its profile dependency
    /// was removed). Idempotent; persists immediately.
    pub fn add_managed_external(&self, id: &str) {
        let mut data = crate::plugin_state::load();
        if !data.managed_externals.iter().any(|e| e == id) {
            data.managed_externals.push(id.to_string());
            let _ = crate::plugin_state::save(&data);
        }
    }

    /// Take over a DSH-profile bundle (`dsh plugin --profile web add …`).
    ///
    /// Three steps, each failing loud before anything irreversible happens:
    ///   1. copy the package directory out of the profile's `node_modules`
    ///      into the desktop plugins root (the desktop scan then serves it
    ///      like any other disk plugin);
    ///   2. run `pnpm remove <pkg>` in the profile so the bundle layer and
    ///      its `dsh.profile.bundles` entry disappear — DSH's own reconcile
    ///      pass keeps `package.json` and the installed state in sync;
    ///   3. record the takeover in `plugin-state.json`.
    ///
    /// Host rows: the bundle's `cordis.patch.yml` inserts mount host entries
    /// by bare package name, resolved against the profile node_modules the
    /// removal empties. `adopt_bundle` rewrites those rows into the desktop
    /// overlay with file:/// names pointing at the adopted copy, so the host
    /// half keeps loading (dsh-plus's MCP / Vision tabs stay alive).
    pub fn adopt_profile_bundle(&self, id: &str) -> Result<(), String> {
        // Full-id validation (`@scope/name` allowed); segment_ok alone would
        // reject every scoped package.
        crate::registry::validate_id(id)?;
        let (home, profile) = {
            let state = self.backend.lock().unwrap();
            match state.home.clone() {
                Some(home) => (home, state.profile.clone()),
                None => return Err("DSH home 未设置".to_string()),
            }
        };
        let source = home
            .join("profiles")
            .join(&profile)
            .join("node_modules")
            .join(id);
        let target = self.root.join(id);
        crate::registry::adopt_bundle(
            &source,
            &target,
            &home.join("profiles").join(&profile),
            &home,
            &profile,
            id,
        )?;
        self.add_managed_external(id);
        self.scan();
        Ok(())
    }

    /// Pause or resume a NATIVE (DSH Loader) entry by writing a `disabled`
    /// override into the HMR-watched profile patch. Returns the effective
    /// disabled state, or an error message when the home/profile is unset or
    /// the write fails. Unlike `set_disabled` (desktop plugins), this does
    /// not touch the desktop `disabled` set — it writes the DSH patch file
    /// and lets `watchUserPatches` recompose the live Loader tree.
    pub fn set_native_disabled(&self, entry_id: &str, disabled: bool) -> Result<bool, String> {
        let (home, profile) = {
            let state = self.backend.lock().unwrap();
            match state.home.clone() {
                Some(home) => (home, state.profile.clone()),
                None => return Err("DSH home 未设置".to_string()),
            }
        };
        // A native entry is disabled by a layer below the user patch (a bundle
        // patch row, or a `disabled: true` inside an insert block), so resuming
        // has to pin `disabled: false` — dropping the desktop's row would only
        // restore that lower layer's `true`, leaving the button spinning until
        // the frontend's poll gave up. Desktop-managed plugins take the other
        // path (see `Resume`); they are filtered out of the native group.
        write_native_disable(&home, &profile, entry_id, disabled, Resume::Override)?;
        self.remember_patch();
        Ok(disabled)
    }

    /// Drop the desktop's `disabled` override for a native entry, leaving the
    /// layers below to decide. This is the true rollback for an enable that did
    /// not take: pinning `disabled: true` instead would match the effective
    /// state but leave behind a row that was never there, which would also
    /// override the entry if a later DSH update enabled it by default.
    pub fn clear_native_override(&self, entry_id: &str) -> Result<bool, String> {
        let (home, profile) = {
            let state = self.backend.lock().unwrap();
            match state.home.clone() {
                Some(home) => (home, state.profile.clone()),
                None => return Err("DSH home 未设置".to_string()),
            }
        };
        write_native_disable(&home, &profile, entry_id, false, Resume::DropOverride)?;
        self.remember_patch();
        Ok(false)
    }

    fn sync_backend(&self) {
        let home_opt = self.backend.lock().unwrap().home.clone();
        // Bundle-patched plugins (dsh-plus, skin-market, …) are not scanned as
        // `desktop-*` rows — they own their overlay entries via prepare_host_half.
        // Include them in the rev so an install/uninstall of a patched plugin
        // still rewrites the overlay, even though backend_plugins() skips them.
        let patched = crate::registry::list_patched_host_plugins(&self.root);
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
        let mut fingerprint = plugins
            .iter()
            .map(|p| format!("{}@{}", p.id, p.file.display()))
            .collect::<Vec<_>>();
        for (id, dir) in &patched {
            fingerprint.push(format!("patch:{id}@{}", dir.display()));
        }
        fingerprint.sort();
        let rev = short_hash(fingerprint.join(",").as_bytes());
        let mut state = self.backend.lock().unwrap();
        if state.home.is_none() {
            return;
        }
        let home = state.home.clone().unwrap();
        let profile = state.profile.clone();
        // Two reasons to rewrite: the plugin set changed, or the file no longer
        // holds what this process last wrote. The second is not paranoia — DSH's
        // Loader writes its composed tree back over this file whenever a plugin
        // persists a row, which flattens every `!!js` expression into a plain
        // string. A flattened guard expression is a non-empty string, i.e. truthy,
        // so the row it guards stays disabled and its host routes never register
        // (a sidebar plugin's WebSocket then answers 405 with nothing listening).
        // Re-emitting from the plugins' own bundle patches restores the tags, and
        // foreign rows in the file are preserved, so the two writers converge
        // instead of fighting.
        let patch_path = home.join("profiles").join(profile.clone()).join("cordis.patch.yml");
        let on_disk = fs::read_to_string(&patch_path).unwrap_or_default();
        let stomped = !state.last_patch.is_empty() && on_disk != state.last_patch;
        if state.last_rev == rev && !stomped {
            return;
        }
        state.last_rev = rev;
        drop(state);
        // Junction + rewrite author ids into the bundle patches *before*
        // `sync_host_half_patch` re-emits, so config-bearing rows (dsh-plus)
        // survive the rewrite and store-installed plugins get the same host-half
        // treatment as adopted ones. Gating this on rev keeps the 1s watcher from
        // rewriting the overlay every tick.
        for (id, dir) in &patched {
            crate::registry::prepare_host_half(dir, Some(&home), id);
        }
        let bundle_rows = crate::registry::collect_bundle_host_rows(&patched);
        let bundle_refs: Vec<crate::registry::BundleHostRows> = bundle_rows
            .into_iter()
            .map(|(_, rows)| rows)
            .collect();
        let written = sync_host_half_patch(&home, &profile, &plugins, &bundle_refs);
        self.backend.lock().unwrap().last_patch = written;
    }

    /// Record the watched patch file as this process's own, after a write that
    /// did not go through [`Self::sync_backend`] (a pause toggle). Without this
    /// the next watcher tick would see the file differ from the last snapshot and
    /// rewrite it for no reason.
    fn remember_patch(&self) {
        let (home, profile) = {
            let state = self.backend.lock().unwrap();
            match state.home.clone() {
                Some(home) => (home, state.profile.clone()),
                None => return,
            }
        };
        let patch = home.join("profiles").join(profile).join("cordis.patch.yml");
        if let Ok(text) = fs::read_to_string(&patch) {
            self.backend.lock().unwrap().last_patch = text;
        }
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
                            // `exports["./client"]` is either a string path or an
                            // object like `{"types": "...", "default": "./lib/client.js"}`;
                            // the runtime bundle is the `.default` string in the latter.
                            if let Some(rel) = client
                                .as_str()
                                .or_else(|| client.get("default").and_then(|d| d.as_str()))
                            {
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
            "dsh-desktop-patch-test-{}-{:?}",
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
        // Legacy frozen overlay: a user `ui-settings-*` disable (migrated into the
        // watched patch) plus a stale managed insert (rebuilt from the live set).
        fs::write(
            overlay_dir.join("cordis.yml"),
            "- id: ui-settings-plugins\n  disabled: true\n- insert:\n    - id: desktop-stale\n      name: 'file:///stale'\n",
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
        sync_host_half_patch(&home, "web", &plugins, &[]);

        let out = fs::read_to_string(home.join("profiles").join("web").join("cordis.patch.yml")).unwrap();
        assert_eq!(out.matches("dsh-desktop-notify").count(), 1);
        assert_eq!(out.matches("desktop-desktop-hello").count(), 1);
        assert!(!out.contains("desktop-stale"), "output: {out}");
        // The legacy user disable migrated into the watched patch as unmanaged.
        assert!(out.contains("ui-settings-plugins"), "output: {out}");
        // The frozen overlay is truncated to [] after migration.
        assert_eq!(fs::read_to_string(overlay_dir.join("cordis.yml")).unwrap(), "[]\n");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overlay_drops_canaries() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-patch-canary-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let overlay_dir = home.join("desktop-overlay");
        fs::create_dir_all(&overlay_dir).unwrap();
        fs::create_dir_all(home.join("profiles").join("web")).unwrap();
        fs::write(
            overlay_dir.join("index.mjs"),
            "export const name='dsh-desktop-notify';",
        )
        .unwrap();
        // Seed the patch with a MANAGED insert block carrying stale hot-load
        // canaries. sync drops managed rows wholesale (canaries included) and
        // rebuilds a fresh insert from the live plugin set.
        fs::write(
            home.join("profiles").join("web").join("cordis.patch.yml"),
            "# dsh-desktop\n- insert:\n    - id: hot-canary-skin\n      name: 'file:///x'\n    - id: hot-test-marker\n      name: 'file:///y'\n    - id: dsh-desktop-notify\n      name: 'file:///old'\n",
        )
        .unwrap();

        let plugins = vec![BackendPlugin {
            id: "dsh-desktop-notify".into(),
            file: overlay_dir.join("index.mjs"),
        }];
        sync_host_half_patch(&home, "web", &plugins, &[]);

        let out = fs::read_to_string(home.join("profiles").join("web").join("cordis.patch.yml")).unwrap();
        assert!(!out.contains("hot-canary-"), "out: {out}");
        assert!(!out.contains("hot-test-"), "out: {out}");
        assert!(out.contains("dsh-desktop-notify"), "out: {out}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overlay_drops_unclaimed_top_level_overrides() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-patch-unclaimed-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(home.join("profiles").join("web")).unwrap();
        let overlay_dir = home.join("desktop-overlay");
        fs::create_dir_all(&overlay_dir).unwrap();
        fs::write(
            overlay_dir.join("index.mjs"),
            "export const name='dsh-desktop-notify';",
        )
        .unwrap();

        let plugins = vec![BackendPlugin {
            id: "dsh-desktop-notify".into(),
            file: overlay_dir.join("index.mjs"),
        }];

        // Seed the patch with a MANAGED `web` override + managed insert, as a
        // prior sync that had a bundle claiming `web` would have written it.
        fs::write(
            home.join("profiles").join("web").join("cordis.patch.yml"),
            "# dsh-desktop\n- id: web\n  config:\n    searchProvider: modsearch\n# dsh-desktop\n- insert:\n    - id: dsh-desktop-notify\n      name: 'file:///old'\n",
        )
        .unwrap();
        // No bundle claims `web` now — the managed override is dropped on sync.
        sync_host_half_patch(&home, "web", &plugins, &[]);
        let out = fs::read_to_string(home.join("profiles").join("web").join("cordis.patch.yml")).unwrap();
        assert!(!out.contains("searchProvider"), "out: {out}");

        // A bundle claims `web` (via top_level) — the override is re-added.
        let bundle_rows = vec![crate::registry::BundleHostRows {
            inserts: vec![],
            top_level: vec![("web".into(), vec!["  config:".into(), "    searchProvider: modsearch".into()])],
        }];
        sync_host_half_patch(&home, "web", &plugins, &bundle_rows);
        let out = fs::read_to_string(home.join("profiles").join("web").join("cordis.patch.yml")).unwrap();
        assert!(out.contains("searchProvider: modsearch"), "out: {out}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overlay_preserves_top_level_disables() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-patch-toplevel-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let overlay_dir = home.join("desktop-overlay");
        fs::create_dir_all(&overlay_dir).unwrap();
        fs::write(
            overlay_dir.join("index.mjs"),
            "export const name='dsh-desktop-notify';",
        )
        .unwrap();
        // Legacy overlay with user disables; migrate folds the `ui-settings-*`
        // rows into the watched patch as unmanaged and truncates the overlay.
        fs::write(
            overlay_dir.join("cordis.yml"),
            "- id: ui-settings-plugins\n  disabled: true\n\
             - id: ui-settings-plugin-inventory\n  disabled: true\n\
             - insert:\n    - id: dsh-desktop-notify\n      name: 'file:///old'\n",
        )
        .unwrap();

        let plugins = vec![BackendPlugin {
            id: "dsh-desktop-notify".into(),
            file: overlay_dir.join("index.mjs"),
        }];
        sync_host_half_patch(&home, "web", &plugins, &[]);

        let out = fs::read_to_string(home.join("profiles").join("web").join("cordis.patch.yml")).unwrap();
        // The migrated user disables survive as column-0 patch rows, unmanaged.
        assert!(
            out.contains("- id: ui-settings-plugins\n  disabled: true\n"),
            "out: {out}"
        );
        assert!(
            out.contains("- id: ui-settings-plugin-inventory\n  disabled: true\n"),
            "out: {out}"
        );
        // The insert block still carries the notify child.
        assert!(
            out.contains("- insert:\n    - id: dsh-desktop-notify"),
            "out: {out}"
        );
        // And the disable is NOT re-emitted as an insert child.
        assert!(!out.contains("    - id: ui-settings-plugins"), "out: {out}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prunes_duplicate_ids_out_of_a_write_back_insert_block() {
        // The Loader's config write-back dumps the composed tree into this file,
        // repeating every row the desktop owns. Two inserts with the same id abort
        // the host boot, so the desktop's ids are pruned out of the dumped block —
        // and the rows only that block carries must survive.
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-patch-dup-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let profile_dir = home.join("profiles").join("web");
        fs::create_dir_all(&profile_dir).unwrap();
        let patch = profile_dir.join("cordis.patch.yml");

        let plugins = vec![BackendPlugin {
            id: "desktop-hello".into(),
            file: root.join("plugins").join("hello").join("index.js"),
        }];

        // An unmanaged (dumped) block repeating `desktop-hello` and adding a row
        // of its own, exactly the shape a skin market leaves behind.
        fs::write(
            &patch,
            "- insert:\n    - id: desktop-hello\n      name: file:///old\n\
             \x20   - id: ui-aqua\n      name: \"@deepseek-ai/dsh-client-ui-aqua\"\n",
        )
        .unwrap();

        sync_host_half_patch(&home, "web", &plugins, &[]);
        let out = fs::read_to_string(&patch).unwrap();
        assert_eq!(out.matches("- id: desktop-hello").count(), 1, "out: {out}");
        assert!(out.contains("- id: ui-aqua"), "foreign row dropped: {out}");
        assert!(!out.contains("file:///old"), "stale dump kept: {out}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn insert_block_precedes_id_rows_so_pause_rows_resolve() {
        // DSH applies patch rows in file order and only indexes an insert's
        // children once it reaches that insert row, so a `disabled: true` row
        // aimed at an insert child is silently skipped unless the insert block
        // comes first. Regression: the pause row used to be re-emitted ahead of
        // the insert block on every sync, which quietly un-paused the host half.
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-patch-order-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let profile_dir = home.join("profiles").join("web");
        fs::create_dir_all(&profile_dir).unwrap();
        let patch = profile_dir.join("cordis.patch.yml");

        let plugins = vec![BackendPlugin {
            id: "desktop-hello".into(),
            file: root.join("plugins").join("hello").join("index.js"),
        }];

        // A prior sync's managed insert, plus the unmanaged pause row that
        // `write_native_disable` appends after it.
        fs::write(
            &patch,
            "# dsh-desktop\n- insert:\n    - id: desktop-hello\n      name: 'file:///old'\n\
             - id: desktop-hello\n  disabled: true\n",
        )
        .unwrap();

        sync_host_half_patch(&home, "web", &plugins, &[]);
        let out = fs::read_to_string(&patch).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        let insert_at = lines.iter().position(|l| *l == "- insert:").expect("insert row");
        let pause_at = lines
            .iter()
            .position(|l| *l == "- id: desktop-hello")
            .expect("pause row survives the rewrite");
        assert!(
            insert_at < pause_at,
            "insert block must precede the pause row, got insert@{insert_at} pause@{pause_at}: {out}"
        );
        assert!(out.contains("- id: desktop-hello\n  disabled: true\n"), "out: {out}");

        // The plugin is uninstalled: its row leaves the insert block, so the
        // now-dangling pause row is pruned instead of lingering (and silently
        // re-pausing the plugin if it is ever reinstalled).
        sync_host_half_patch(&home, "web", &[], &[]);
        let out = fs::read_to_string(&patch).unwrap();
        assert!(!out.contains("desktop-hello"), "stale pause row kept: {out}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn native_resume_pins_disabled_false_and_survives_sync() {
        // A native entry is disabled from a layer below the user patch — here a
        // `disabled: true` inside a foreign insert block. Patch merging is plain
        // assignment, so resuming has to write `disabled: false`; deleting the
        // desktop's row would restore the block's `true` and the entry would
        // never come back (the symptom: the enable button spins, then reports a
        // timeout). The pinned row must also survive the next overlay rewrite.
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-native-resume-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let profile_dir = home.join("profiles").join("web");
        fs::create_dir_all(&profile_dir).unwrap();
        let patch = profile_dir.join("cordis.patch.yml");

        fs::write(
            &patch,
            concat!(
                "- insert:\n",
                "    - id: ui-aqua\n",
                "      name: \"@deepseek-ai/dsh-client-ui-aqua\"\n",
                "      disabled: true\n",
            ),
        )
        .unwrap();

        write_native_disable(&home, "web", "ui-aqua", false, Resume::Override).unwrap();
        let out = fs::read_to_string(&patch).unwrap();
        assert!(
            out.contains("- id: ui-aqua\n  disabled: false\n"),
            "resume must pin an explicit false: {out}"
        );
        let lines: Vec<&str> = out.lines().collect();
        let insert_at = lines.iter().position(|l| *l == "- insert:").expect("insert row");
        let pin_at = lines
            .iter()
            .position(|l| *l == "- id: ui-aqua")
            .expect("pinned row");
        assert!(
            insert_at < pin_at,
            "the pin only outranks the block if it comes after it: {out}"
        );

        // An overlay rewrite must not sweep the pin: `ui-aqua` is created by a
        // foreign block that is still there, so the row is live configuration,
        // not a leftover aimed at a vanished id.
        let plugins = vec![BackendPlugin {
            id: "desktop-hello".into(),
            file: root.join("plugins").join("hello").join("index.js"),
        }];
        sync_host_half_patch(&home, "web", &plugins, &[]);
        let out = fs::read_to_string(&patch).unwrap();
        assert!(
            out.contains("- id: ui-aqua\n  disabled: false\n"),
            "sync dropped the pin: {out}"
        );

        // Pausing again replaces the pin rather than stacking a second override.
        write_native_disable(&home, "web", "ui-aqua", true, Resume::Override).unwrap();
        let out = fs::read_to_string(&patch).unwrap();
        assert!(out.contains("- id: ui-aqua\n  disabled: true\n"), "out: {out}");
        assert_eq!(out.matches("disabled: false").count(), 0, "stale pin left: {out}");

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
