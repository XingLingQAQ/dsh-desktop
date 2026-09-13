//! Installing plugins from the registry catalog.
//!
//! The catalog itself is fetched by the store UI straight from the public
//! registry repository — it needs no help from here. What the browser cannot do
//! is unpack a tarball onto disk, so that is all this module owns: download,
//! extract, remove.
//!
//! Everything crossing in from the catalog is untrusted. A plugin id becomes a
//! directory name, so it is validated against an npm-shaped pattern and the
//! resolved path is confirmed to stay under the plugins root; a tarball URL is
//! confirmed to point at GitHub's codeload host. Downloads shell out to `curl`
//! and `tar`, both of which ship with Windows 10+, the same approach
//! `provision.rs` already takes for the Node runtime.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::store::plugins_root;

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

/// Hosts allowed to serve plugin archives.
///
/// npm is the one that matters: a plugin's declared client entry is usually a
/// build output, listed in `files` and published but gitignored, so a GitHub
/// source archive lands a package whose entry file is missing. codeload stays
/// allowed for the rare plugin that commits its built entry.
const ARCHIVE_HOSTS: [&str; 2] = [
    "https://registry.npmjs.org/",
    "https://codeload.github.com/",
];

/// One path segment of a plugin id: npm-ish, and never a relative step.
pub fn segment_ok(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Validate a plugin id and resolve where it installs.
///
/// Accepts `name` and `@scope/name`. Each segment is checked against the pattern
/// above, which admits no separator and no relative step, so the join cannot
/// leave the plugins root — there is nothing left for a path comparison to catch.
pub(crate) fn install_dir(id: &str) -> Result<PathBuf, String> {
    let bad = || format!("非法插件 id: {id}");
    let mut parts = id.split('/');
    let first = parts.next().ok_or_else(bad)?;
    let dir = match parts.next() {
        None => {
            if first.starts_with('@') || !segment_ok(first) {
                return Err(bad());
            }
            PathBuf::from(first)
        }
        Some(name) => {
            if parts.next().is_some() {
                return Err(bad());
            }
            let scope = first.strip_prefix('@').ok_or_else(bad)?;
            if !segment_ok(scope) || !segment_ok(name) {
                return Err(bad());
            }
            PathBuf::from(first).join(name)
        }
    };
    Ok(plugins_root().join(dir))
}

/// Validate a full plugin id (`name` / `@scope/name`) without resolving it.
/// Callers outside this module (e.g. profile-bundle adoption) use this instead
/// of [`segment_ok`], which only admits one path segment.
pub fn validate_id(id: &str) -> Result<(), String> {
    install_dir(id).map(|_| ())
}

/// True when `dir`'s package declares a bundle patch with insert rows or
/// top-level id-targeted patches. Those plugins own their host-half rows
/// (collected by `collect_bundle_host_rows`) rather than the `desktop-*` scan.
pub fn dir_has_bundle_patch(dir: &Path) -> bool {
    let Some(patch_text) = read_bundle_patch(dir) else {
        return false;
    };
    !parse_bundle_inserts(&patch_text).is_empty() || !parse_bundle_top_level(&patch_text).is_empty()
}

fn read_bundle_patch(dir: &Path) -> Option<String> {
    let pkg_text = fs::read_to_string(dir.join("package.json")).ok()?;
    let pkg = serde_json::from_str::<serde_json::Value>(&pkg_text).ok()?;
    let declared = pkg
        .get("dsh")
        .and_then(|d| d.get("bundle"))
        .and_then(|b| b.get("patch"))
        .and_then(|p| p.as_str())?;
    fs::read_to_string(dir.join(declared)).ok()
}

/// Conventional / `package.json` `main` / `exports["."]` backend entry, used
/// when the plugin has no bundle-patch inserts (e.g. `desktop-hello`).
pub fn dir_has_backend_entry(dir: &Path) -> bool {
    for name in ["server.js", "index.mjs", "index.js"] {
        if dir.join(name).is_file() {
            return true;
        }
    }
    let Ok(pkg_text) = fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&pkg_text) else {
        return false;
    };
    let rel = pkg
        .get("main")
        .and_then(|m| m.as_str())
        .map(str::to_string)
        .or_else(|| {
            let exported = pkg.get("exports")?.get(".")?;
            exported
                .as_str()
                .or_else(|| exported.get("default").and_then(|d| d.as_str()))
                .map(str::to_string)
        });
    match rel {
        Some(rel) => dir.join(rel.trim_start_matches("./")).is_file(),
        None => false,
    }
}

/// Plugin directories under `root` whose bundle patch inserts host rows.
/// The overlay scan skips these (a bare `desktop-*` row cannot carry `config:`
/// / `disabled:` guards); [`prepare_host_half`] rewrites the author's own ids
/// into the overlay instead.
pub fn list_patched_host_plugins(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(read_dir) = fs::read_dir(root) else {
        return out;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_dir() || name == "node_modules" || name.starts_with('.') {
            continue;
        }
        if name.starts_with('@') {
            if let Ok(scoped) = fs::read_dir(&path) {
                for sub in scoped.flatten() {
                    let sub_path = sub.path();
                    if !sub_path.is_dir() {
                        continue;
                    }
                    let id = format!("{name}/{}", sub.file_name().to_string_lossy());
                    if dir_has_bundle_patch(&sub_path) {
                        out.push((id, sub_path));
                    }
                }
            }
        } else if dir_has_bundle_patch(&path) {
            out.push((name, path));
        }
    }
    out
}

/// Junction the plugin's `node_modules` at the harness hoisted store and ensure
/// the `@schemastery/*` alias resolves. Called after adopt / store-install /
/// store-update, and on every host-half sync for currently patched plugins.
///
/// The bundle's host-half rows (inserts + top-level overrides) are no longer
/// written here — [`collect_bundle_host_rows`] reads them and
/// [`PluginManager::sync_backend`] folds them into the HMR-watched profile
/// patch, so host-half mounts/unmounts apply live with no host restart.
pub fn prepare_host_half(target: &Path, _home: Option<&Path>, _id: &str) {
    link_hoisted_node_modules(target);
    ensure_schemastery_alias();
}

/// One non-official bundle plugin discovered in a DSH profile's
/// `node_modules`, listed by [`scan_profile_bundles`].
#[derive(Clone, Debug, serde::Serialize)]
pub struct ProfileBundleInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// The package declares a web `dsh.client` bundle (UI half exists).
    pub has_client: bool,
}

/// List the DSH-profile bundle plugins that are not part of the official
/// `@deepseek-ai/*` stack — i.e. what a user installed via
/// `dsh plugin --profile <p> add <pkg>` and that the desktop has not taken
/// over yet. Reads `<home>/profiles/<profile>/package.json`'s
/// `dsh.profile.bundles` and resolves each name in the profile's
/// `node_modules`.
pub fn scan_profile_bundles(home: Option<&Path>, profile: &str) -> Result<Vec<ProfileBundleInfo>, String> {
    let Some(home) = home else {
        return Err("DSH home 未设置".to_string());
    };
    let dir = home.join("profiles").join(profile);
    let pkg_text = fs::read_to_string(dir.join("package.json"))
        .map_err(|e| format!("读取 profile package.json 失败: {e}"))?;
    let pkg: serde_json::Value =
        serde_json::from_str(&pkg_text).map_err(|e| format!("解析 profile package.json 失败: {e}"))?;
    let bundles = pkg
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for entry in bundles {
        let Some(name) = entry.as_str() else { continue };
        // Official shell layers (`@deepseek-ai/*`) are dsh's own skeleton,
        // never adoption candidates.
        if name.starts_with("@deepseek-ai/") {
            continue;
        }
        let pkg_dir = dir.join("node_modules").join(name);
        let meta = fs::read_to_string(pkg_dir.join("package.json")).ok();
        let (display_name, version, description, has_client) = match meta
            .as_deref()
            .map(|text| serde_json::from_str::<serde_json::Value>(text))
        {
            Some(Ok(value)) => (
                value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(name)
                    .to_string(),
                value
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0.0.0")
                    .to_string(),
                value
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                value.get("dsh").and_then(|d| d.get("client")).is_some(),
            ),
            _ => (name.to_string(), "0.0.0".into(), String::new(), false),
        };
        out.push(ProfileBundleInfo {
            id: name.to_string(),
            name: display_name,
            version,
            description,
            has_client,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Where an install or update assembles the new tree.
///
/// Deliberately inside the plugins root rather than `%TEMP%`: `fs::rename` cannot
/// cross volumes on Windows, and the plugins directory routinely sits on another
/// drive from the temp directory. Staging in temp therefore forced every swap
/// down the copy fallback — which walked the `node_modules` junction the host
/// half needs and died inside the pnpm store with «拒绝访问 (os error 5)».
///
/// The dot-prefixed name keeps it out of the way of the scanners: they look for a
/// plugin manifest directly inside each child of the root, and this directory has
/// none (the staged trees sit one level deeper).
fn staging_dir(stamp: u128) -> PathBuf {
    plugins_root().join(".staging").join(stamp.to_string())
}

/// Drop a finished staging tree, and the `.staging` parent once it empties.
fn clear_staging(staging: &Path) {
    let _ = fs::remove_dir_all(staging);
    if let Some(parent) = staging.parent() {
        if fs::read_dir(parent).map(|d| d.count() == 0).unwrap_or(false) {
            let _ = fs::remove_dir(parent);
        }
    }
}

/// How far along one plugin's install or update is.
///
/// `total` is 0 when the archive host sent no `content-length`, which the store
/// UI reads as "keep the bar indeterminate" rather than inventing a denominator.
#[derive(Clone)]
pub struct Progress {
    pub phase: &'static str,
    pub received: u64,
    pub total: u64,
}

fn progress_table() -> &'static Mutex<HashMap<String, Progress>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Progress>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_progress(id: &str, phase: &'static str, received: u64, total: u64) {
    if let Ok(mut table) = progress_table().lock() {
        table.insert(id.to_string(), Progress { phase, received, total });
    }
}

fn clear_progress(id: &str) {
    if let Ok(mut table) = progress_table().lock() {
        table.remove(id);
    }
}

/// Current progress of the job for `id`, or `None` when nothing is in flight.
pub fn progress(id: &str) -> Option<Progress> {
    progress_table().lock().ok().and_then(|table| table.get(id).cloned())
}

/// Total size of `url` in bytes, or 0 when the host will not say.
///
/// A one-byte ranged GET rather than a HEAD or curl's own header dump: npm
/// answers HEAD without a `content-length`, and the `-D` dump of the real
/// download is not flushed until the transfer ends — exactly too late to draw a
/// bar with. `Content-Range: bytes 0-0/<total>` answers up front for one byte of
/// traffic; `content-length` is the fallback for a host that ignores the range.
fn remote_size(url: &str) -> u64 {
    let Ok(out) = Command::new("curl.exe")
        .args(["-sSL", "--max-time", "20", "-r", "0-0", "-D", "-", "-o", "NUL", url])
        .output()
    else {
        return 0;
    };
    if !out.status.success() {
        return 0;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let ranged = text
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            if !name.trim().eq_ignore_ascii_case("content-range") {
                return None;
            }
            value.rsplit_once('/')?.1.trim().parse::<u64>().ok()
        })
        .next_back();
    if let Some(total) = ranged {
        return total;
    }
    text.lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            if !name.trim().eq_ignore_ascii_case("content-length") {
                return None;
            }
            value.trim().parse::<u64>().ok()
        })
        .next_back()
        .unwrap_or(0)
}

/// Download `url` to `archive`, publishing byte progress while it runs.
///
/// Received bytes come from the output file's size, which avoids parsing curl's
/// human-readable meter and behaves the same for every host. A host that will not
/// report a total leaves `total` at 0, which the store UI reads as "stay
/// indeterminate" rather than inventing a denominator.
fn download_with_progress(id: &str, url: &str, archive: &Path) -> Result<(), String> {
    let total = remote_size(url);
    set_progress(id, "download", 0, total);
    let mut child = Command::new("curl.exe")
        .args([
            "-fsSL",
            "--retry",
            "2",
            "--max-time",
            "120",
            "-o",
            &archive.to_string_lossy(),
            url,
        ])
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl.exe 无法执行: {e}"))?;
    loop {
        let received = fs::metadata(archive).map(|m| m.len()).unwrap_or(0);
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    set_progress(id, "download", received, total.max(received));
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut err);
                }
                return Err(format!("下载失败: {}", err.trim()));
            }
            Ok(None) => {
                set_progress(id, "download", received, total);
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(format!("curl.exe 状态未知: {e}")),
        }
    }
}

/// Run a command, returning its stderr when it fails.
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} 无法执行: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(format!("{program} 失败: {}", err.trim()))
}

/// Download and unpack one plugin into the plugins directory.
///
/// Both archive shapes wrap everything in a single directory — npm uses
/// `package/`, GitHub uses `owner-repo-<sha>/` — so one leading component is
/// stripped and the package lands flat, the layout `plugins.rs` scans for.
pub fn install(id: &str, tarball: &str) -> Result<(), String> {
    if !ARCHIVE_HOSTS.iter().any(|host| tarball.starts_with(host)) {
        return Err(format!("拒绝不受信任的下载地址: {tarball}"));
    }
    let target = install_dir(id)?;
    if target.exists() {
        return Err(format!("插件已安装: {id}"));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = staging_dir(stamp);
    let archive = staging.join("plugin.tar.gz");
    let unpacked = staging.join("unpacked");
    fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        download_with_progress(id, tarball, &archive)?;
        set_progress(id, "extract", 0, 0);
        run(
            "tar.exe",
            &[
                "-xzf",
                &archive.to_string_lossy(),
                "--strip-components=1",
                "-C",
                &unpacked.to_string_lossy(),
            ],
        )?;
        set_progress(id, "install", 0, 0);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Rename lands the whole tree at once, so a scan never sees a half-built
        // plugin directory. Falls back to a copy across volumes.
        match fs::rename(&unpacked, &target) {
            Ok(()) => Ok(()),
            Err(_) => copy_tree(&unpacked, &target).map_err(|e| e.to_string()),
        }
    })();

    clear_staging(&staging);
    clear_progress(id);
    if result.is_ok() {
        // Host-half plugins import bare packages from the file's directory.
        // Junction the hoisted store now so the next overlay scan (and the
        // subsequent host restart) can actually load the entry.
        prepare_host_half(&target, None, id);
    }
    result
}

/// Replace an installed plugin with a freshly downloaded copy.
///
/// Same download path as [`install`], but the target already exists, so the
/// swap is staged: the old directory moves aside, the new one takes its place,
/// and any failure rolls the old directory back. A mid-update scan therefore
/// sees either the old or the new plugin — never an absent one — and the HMR
/// pipeline picks the new rev up on its next poll without a restart.
pub fn update(id: &str, tarball: &str) -> Result<(), String> {
    if !ARCHIVE_HOSTS.iter().any(|host| tarball.starts_with(host)) {
        return Err(format!("拒绝不受信任的下载地址: {tarball}"));
    }
    let target = install_dir(id)?;
    if !target.is_dir() {
        return Err(format!("插件未安装，无法更新: {id}"));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = staging_dir(stamp);
    let archive = staging.join("plugin.tar.gz");
    let unpacked = staging.join("unpacked");
    // The old tree parks here while the new one renames into place; it lives
    // inside the staging dir so cleanup on every exit path is one remove_dir_all.
    let backup = staging.join("old");
    fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        download_with_progress(id, tarball, &archive)?;
        set_progress(id, "extract", 0, 0);
        run(
            "tar.exe",
            &[
                "-xzf",
                &archive.to_string_lossy(),
                "--strip-components=1",
                "-C",
                &unpacked.to_string_lossy(),
            ],
        )?;
        set_progress(id, "install", 0, 0);

        // Stage the swap: old aside → new in → old gone. If anything between
        // the two renames fails, put the old tree back before surfacing.
        match fs::rename(&target, &backup) {
            Ok(()) => {}
            Err(_) => {
                // Cross-volume fallback: copy the old tree into backup instead.
                copy_tree(&target, &backup).map_err(|e| format!("备份旧版本失败: {e}"))?;
                fs::remove_dir_all(&target).map_err(|e| format!("移除旧版本失败: {e}"))?;
            }
        }
        match fs::rename(&unpacked, &target).or_else(|_| {
            copy_tree(&unpacked, &target).map_err(|e| std::io::Error::new(e.kind(), e))
        }) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Roll the previous version back so a failed update never
                // leaves the plugin missing.
                let _ = fs::remove_dir_all(&target);
                if fs::rename(&backup, &target).is_err() {
                    let _ = copy_tree(&backup, &target);
                }
                Err(format!("更新失败（已回滚到旧版本）: {e}"))
            }
        }
    })();

    clear_staging(&staging);
    clear_progress(id);
    if result.is_ok() {
        // The swap dropped the previous `node_modules` junction; rebuild it
        // (and rewrite overlay rows) so the host half still resolves.
        prepare_host_half(&target, None, id);
    }
    result
}

/// One host-side row declared by a bundle's `cordis.patch.yml`: the entry id,
/// its module name (`dsh-plus`, `dsh-plus/vision`), and optional raw body lines
/// (config overrides) preserved verbatim.
pub struct BundlePatchRow {
    pub id: String,
    pub name: Option<String>,
    /// Body lines other than `id:`/`name:` (e.g. `config:` blocks with `!!js`
    /// expressions), kept in their original indented form.
    pub extra: Vec<String>,
}

/// The host-half contribution of one installed bundle-patch plugin: the
/// `- insert:` rows (entries to mount, with `file:///` names) and the
/// top-level `- id:` overrides (config patches on existing entries).
/// [`PluginManager::sync_backend`] folds these into the HMR-watched profile
/// patch so host-half mounts/unmounts apply live with no host restart.
pub struct BundleHostRows {
    pub inserts: Vec<BundlePatchRow>,
    pub top_level: Vec<(String, Vec<String>)>,
}

/// Collect the host-half rows of every currently installed bundle-patch
/// plugin. Each entry is keyed by the plugin's directory id; the rows carry
/// insert children with `file:///` entry names resolved against the plugin
/// directory, plus top-level config overrides claimed by the bundle.
pub fn collect_bundle_host_rows(
    patched: &[(String, PathBuf)],
) -> Vec<(String, BundleHostRows)> {
    let mut out = Vec::new();
    for (id, dir) in patched {
        let Some(patch_text) = read_bundle_patch(dir) else { continue };
        let inserts = parse_bundle_inserts(&patch_text);
        let top_level = parse_bundle_top_level(&patch_text);
        if inserts.is_empty() && top_level.is_empty() {
            continue;
        }
        // Resolve each insert's module name (e.g. `dsh-plus`, `dsh-plus/vision`)
        // to a `file:///` URL pointing at the real entry file under this plugin
        // directory.
        let pkg_text = fs::read_to_string(dir.join("package.json")).ok();
        let pkg = pkg_text
            .as_ref()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok());
        let mut resolved: Vec<BundlePatchRow> = Vec::new();
        for mut row in inserts {
            let Some(name) = row.name.clone() else { continue };
            let url = pkg
                .as_ref()
                .and_then(|p| resolve_package_rel(p, id, &name))
                .and_then(|rel| {
                    let f = dir.join(rel);
                    f.is_file().then(|| file_url(&f))
                });
            if let Some(url) = url {
                row.name = Some(url);
                resolved.push(row);
            }
        }
        out.push((
            id.clone(),
            BundleHostRows {
                inserts: resolved,
                top_level,
            },
        ));
    }
    out
}

/// Parse the `- insert:` children of a bundle's `cordis.patch.yml`.
///
/// Only insert rows are collected: those are what mount host entries. Id- or
/// disable-targeting patches reference other layers' rows and cannot be
/// rewritten to an adopted copy, so they stay with the profile layer.
///
/// The parse is deliberately shallow line-based — the same style
/// `plugins.rs` uses for overlay files. Bundles whose patches use YAML
/// features beyond flat `- id:`/`name:`/`config:` mappings are skipped
/// (empty result), which simply means adoption keeps working as before.
pub fn parse_bundle_inserts(patch_text: &str) -> Vec<BundlePatchRow> {
    let mut rows: Vec<BundlePatchRow> = Vec::new();
    let mut in_insert = false;
    let mut current: Option<BundlePatchRow> = None;
    for line in patch_text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('-') && trimmed[1..].trim_start().starts_with("insert:") {
            if let Some(prev) = current.take() {
                rows.push(prev);
            }
            in_insert = true;
            continue;
        }
        // A new top-level `- id:` ends the insert block (and any current row).
        if line.starts_with("- id:") {
            if let Some(prev) = current.take() {
                rows.push(prev);
            }
            in_insert = false;
            continue;
        }
        // Comment / blank / non-list content outside inserts is ignored.
        if !in_insert || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- id:") {
            if let Some(prev) = current.take() {
                rows.push(prev);
            }
            current = Some(BundlePatchRow {
                id: rest.trim().to_string(),
                name: None,
                extra: Vec::new(),
            });
        } else if let Some(row) = current.as_mut() {
            if let Some(rest) = trimmed.strip_prefix("name:") {
                let value = rest.trim().trim_matches('\'').trim_matches('"').to_string();
                row.name = Some(value);
            } else {
                // Keep original indentation so nested config maps survive.
                row.extra.push(line.to_string());
            }
        }
    }
    if let Some(prev) = current.take() {
        rows.push(prev);
    }
    rows.retain(|row| !row.id.is_empty());
    rows
}

/// Move one DSH-profile bundle into the desktop plugins directory and remove
/// its profile dependency.
///
/// `source` is the package directory under the profile's `node_modules`;
/// `target` is where it lands in the desktop plugins root; `profile_dir` is
/// the profile directory whose pnpm workspace owns the dependency; `home` is
/// the DSH home, whose desktop overlay receives rewritten host rows when the
/// bundle declares a `dsh.bundle.patch`. The copy happens before the
/// dependency removal, so a failed removal leaves both copies in place (the
/// desktop copy wins from then on; re-adoption overwrites it) — no path loses
/// the plugin.
pub fn adopt_bundle(
    source: &Path,
    target: &Path,
    profile_dir: &Path,
    home: &Path,
    profile: &str,
    id: &str,
) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("profile 中未找到插件目录: {id}"));
    }
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| format!("清理旧目标失败: {e}"))?;
    }
    copy_tree(source, target).map_err(|e| format!("复制插件到桌面目录失败: {e}"))?;

    // Host half: junction the hoisted store (bare `@deepseek-ai/*` imports
    // used to resolve from the profile node_modules this empties) and
    // rewrite the bundle's insert rows into the desktop overlay with
    // file:/// names pointing at the adopted copy.
    prepare_host_half(target, Some(home), id);

    // Remove the dependency through dsh's own plugin channel so
    // `package.json`'s `dsh.profile.bundles` is reconciled along with the
    // installed tree. Fall back to bare pnpm when the launcher is absent.
    let via_dsh = run_in(
        "dsh",
        &["plugin", "--profile", profile, "remove", id],
        profile_dir,
    );
    if via_dsh.is_err() {
        run_in("pnpm", &["remove", id], profile_dir)
            .map_err(|e| format!("已复制到桌面，但从 profile 移除依赖失败（可手动执行 pnpm remove {id}）: {e}"))?;
    }
    Ok(())
}

/// Junction the adopted bundle's `node_modules` to the harness installation's
/// hoisted dependency store (`<install>/node_modules/.pnpm/node_modules`).
///
/// The store holds every package the installation ships (all `@deepseek-ai/*`
/// peers plus common deps), so a single junction covers any import an
/// out-of-tree plugin's host half makes. `copy_tree` never copies link
/// targets, so after a re-adoption the directory is simply absent and gets
/// linked again here.
fn link_hoisted_node_modules(target: &Path) {
    let nm = target.join("node_modules");
    if nm.exists() {
        return;
    }
    // Same layout discover.rs scans: %APPDATA%\DeepSeek Harness\harness-versions\<rev>.
    let versions = std::env::var_os("APPDATA")
        .map(|app| PathBuf::from(app).join("DeepSeek Harness").join("harness-versions"));
    let Some(versions) = versions else { return };
    let Ok(entries) = fs::read_dir(&versions) else { return };
    // Newest hash wins (directory mtime tracks the unpack time).
    let hoisted = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH))
        .map(|e| e.path().join("node_modules").join(".pnpm").join("node_modules"))
        .filter(|p| p.is_dir());
    let Some(hoisted) = hoisted else { return };
    // Directory junction: no admin rights, same resolver semantics as a
    // symlink for Node's package lookup.
    let _ = run_junction(&nm, &hoisted);
    ensure_schemastery_alias_from(&hoisted);
}

/// Alias `plugins/node_modules/schemastery` → `@deepseek-ai/schemastery`.
///
/// Several host halves (`dsh-plus`, `dsh-better-sidebar`) `import 'schemastery'`
/// by the unscoped name; the published package is `@deepseek-ai/schemastery`.
/// A single junction at the plugins root covers every plugin that walks up.
fn ensure_schemastery_alias() {
    let versions = std::env::var_os("APPDATA")
        .map(|app| PathBuf::from(app).join("DeepSeek Harness").join("harness-versions"));
    let Some(versions) = versions else { return };
    let Ok(entries) = fs::read_dir(&versions) else { return };
    let hoisted = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH))
        .map(|e| e.path().join("node_modules").join(".pnpm").join("node_modules"))
        .filter(|p| p.is_dir());
    let Some(hoisted) = hoisted else { return };
    ensure_schemastery_alias_from(&hoisted);
}

fn ensure_schemastery_alias_from(hoisted: &Path) {
    let real = hoisted.join("@deepseek-ai").join("schemastery");
    if !real.is_dir() {
        return;
    }
    let alias_dir = plugins_root().join("node_modules");
    let alias = alias_dir.join("schemastery");
    if alias.exists() {
        return;
    }
    let _ = fs::create_dir_all(&alias_dir);
    let _ = run_junction(&alias, &real);
}

/// Create a directory junction via `cmd /c mklink /J` (std has no junction API).
fn run_junction(link: &Path, target: &Path) -> std::io::Result<()> {
    let out = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

/// Resolve a bundle-patch `name:` to a path relative to the package root.
///
/// `pkg/subpath` → `exports["./subpath"]`; bare `pkg` → `main`, then
/// `exports["."]`, then `index.js`. Packages like `@liustack/modsearch`
/// ship no `main` and would otherwise be dropped from the overlay.
fn resolve_package_rel(pkg: &serde_json::Value, id: &str, name: &str) -> Option<String> {
    let subpath = name.strip_prefix(id)?;
    if subpath.is_empty() {
        if let Some(main) = pkg.get("main").and_then(|m| m.as_str()) {
            return Some(main.trim_start_matches("./").to_string());
        }
        return export_rel(pkg, ".").or_else(|| Some("index.js".to_string()));
    }
    let key = format!("./{}", subpath.trim_start_matches('/'));
    export_rel(pkg, &key)
}

fn export_rel(pkg: &serde_json::Value, key: &str) -> Option<String> {
    let exported = pkg.get("exports")?.get(key)?;
    exported
        .as_str()
        .or_else(|| exported.get("default").and_then(|d| d.as_str()))
        .map(|s| s.trim_start_matches("./").to_string())
}

/// Top-level `- id:` rows of a bundle patch (config overrides / disables),
/// excluding the `- insert:` block. These patch existing loader entries
/// rather than mounting new ones.
pub fn parse_bundle_top_level(patch_text: &str) -> Vec<(String, Vec<String>)> {
    let mut rows: Vec<(String, Vec<String>)> = Vec::new();
    let mut in_insert = false;
    let mut current: Option<(String, Vec<String>)> = None;
    for line in patch_text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('-') && trimmed[1..].trim_start().starts_with("insert:") {
            if let Some(prev) = current.take() {
                rows.push(prev);
            }
            in_insert = true;
            continue;
        }
        if line.starts_with("- id:") {
            in_insert = false;
            if let Some(prev) = current.take() {
                rows.push(prev);
            }
            let rest = trimmed[1..].trim_start().strip_prefix("id:").unwrap_or("").trim();
            current = Some((rest.to_string(), Vec::new()));
            continue;
        }
        if in_insert || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((_, body)) = current.as_mut() {
            body.push(line.to_string());
        }
    }
    if let Some(prev) = current.take() {
        rows.push(prev);
    }
    rows.retain(|(id, _)| !id.is_empty());
    rows
}

/// Run a command with a working directory, returning its stderr when it fails.
fn run_in(program: &str, args: &[&str], cwd: &Path) -> Result<(), String> {
    let out = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("{program} 无法执行: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(format!("{program} 失败: {}", err.trim()))
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        // Never follow a reparse point. `node_modules` inside an installed plugin
        // is a junction into the pnpm store, and descending it copies thousands of
        // files before hitting one this process cannot read — the «拒绝访问
        // (os error 5)» a plugin update used to fail with. `prepare_host_half`
        // recreates the junction after the swap, so skipping it loses nothing.
        if entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Remove an installed plugin. Scoped ids leave their now-empty scope directory
/// behind only if something else still lives in it.
pub fn uninstall(id: &str) -> Result<(), String> {
    let target = install_dir(id)?;
    if !target.is_dir() {
        return Err(format!("插件未安装: {id}"));
    }
    fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    if let Some(scope) = target.parent() {
        if scope != plugins_root() && fs::read_dir(scope).map(|d| d.count() == 0).unwrap_or(false) {
            let _ = fs::remove_dir(scope);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ids_that_escape_the_plugins_root() {
        for id in ["../evil", "a/../../evil", "/abs", "C:\\abs", "@scope", "@/x", "a/b/c", ""] {
            assert!(install_dir(id).is_err(), "should reject {id:?}");
        }
    }

    #[test]
    fn accepts_plain_and_scoped_ids() {
        let plain = install_dir("dsh-context").expect("plain id");
        assert!(plain.ends_with("dsh-context"));
        let scoped = install_dir("@liustack/modlens").expect("scoped id");
        assert!(scoped.ends_with(Path::new("@liustack").join("modlens")));
    }

    #[test]
    fn rejects_downloads_from_other_hosts() {
        let err = install("ok-id", "https://evil.example/x.tar.gz").expect_err("must reject");
        assert!(err.contains("不受信任"), "unexpected: {err}");
        // A lookalike prefix must not slip through.
        let err = install("ok-id", "https://registry.npmjs.org.evil.test/x.tgz").expect_err("must reject");
        assert!(err.contains("不受信任"), "unexpected: {err}");
    }

    #[test]
    fn host_half_detects_bundle_patch_and_scoped_ids() {
        let root = std::env::temp_dir().join(format!(
            "dsh-desktop-host-half-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        let scoped = root.join("@scope").join("name");
        fs::create_dir_all(&scoped).unwrap();
        fs::write(
            scoped.join("package.json"),
            r#"{"name":"@scope/name","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}"#,
        )
        .unwrap();
        fs::write(
            scoped.join("cordis.patch.yml"),
            "- insert:\n    - id: x\n      name: '@scope/name'\n",
        )
        .unwrap();
        // `dir_has_bundle_patch` is the host-half detector now that the
        // `plugin_has_host_half` wrapper (and its restart prompt) is gone.
        assert!(dir_has_bundle_patch(&scoped));
        let missing = root.join("missing");
        fs::create_dir_all(&missing).unwrap();
        assert!(!dir_has_bundle_patch(&missing));
        // A conventional backend file without a bundle patch still counts.
        let hello = root.join("hello");
        fs::create_dir_all(&hello).unwrap();
        fs::write(hello.join("index.js"), "export const name='hello';").unwrap();
        fs::write(hello.join("package.json"), r#"{"name":"hello"}"#).unwrap();
        assert!(dir_has_backend_entry(&hello));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_bundle_inserts_keeps_config_and_disabled() {
        let rows = parse_bundle_inserts(
            "- insert:\n    - id: mcp-settings\n      name: dsh-plus\n      config:\n        path: x\n    - id: better-sidebar\n      name: 'dsh-better-sidebar'\n      disabled: !!js 'true'\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "mcp-settings");
        assert_eq!(rows[0].name.as_deref(), Some("dsh-plus"));
        assert!(rows[0].extra.iter().any(|l| l.trim_start().starts_with("config:")));
        assert_eq!(rows[1].id, "better-sidebar");
        assert!(rows[1].extra.iter().any(|l| l.trim_start().starts_with("disabled:")));
    }

    #[test]
    fn resolve_package_rel_uses_exports_when_main_missing() {
        let pkg: serde_json::Value = serde_json::from_str(
            r#"{"exports":{".":"./dsh/index.js","./vision":{"default":"./lib/vision.js"}}}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_package_rel(&pkg, "@scope/name", "@scope/name").as_deref(),
            Some("dsh/index.js")
        );
        let with_main: serde_json::Value = serde_json::from_str(
            r#"{"main":"lib/index.js","exports":{".":"./other.js","./vision":"./lib/vision.js"}}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_package_rel(&with_main, "dsh-plus", "dsh-plus").as_deref(),
            Some("lib/index.js")
        );
        assert_eq!(
            resolve_package_rel(&with_main, "dsh-plus", "dsh-plus/vision").as_deref(),
            Some("lib/vision.js")
        );
    }

    #[test]
    fn parse_bundle_top_level_skips_inserts() {
        let rows = parse_bundle_top_level(
            "- id: web\n  config:\n    searchProvider: modsearch\n\n- insert:\n    - id: modsearch\n      name: '@liustack/modsearch'\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "web");
        assert!(rows[0].1.iter().any(|l| l.contains("searchProvider")));
    }
}
