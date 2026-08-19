//! Environment discovery: locate node, npm, pnpm, the dsh CLI bundle, DSH_HOME,
//! and verify the bundle/profile dependencies are actually installed.
//!
//! Detection layers (first valid wins):
//! 1. `%APPDATA%\DeepSeek Harness\bin\dsh-launch.json` — official launcher contract.
//! 2. `%APPDATA%\DeepSeek Harness\harness-versions\<rev>\` — newest bundle.
//! 3. `DSH_HOME` / `DSH_*` environment variables.
//! 4. `node` / `pnpm` on PATH (real probes).
//!
//! Every candidate is probed; `missing` lists what provision() must install.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct EnvironmentSnapshot {
    /// Absolute path of the node executable.
    pub node: Option<String>,
    /// Absolute path of the dsh CLI entry (`lib/bin.js`).
    pub cli: Option<String>,
    /// DSH_HOME directory.
    pub dsh_home: Option<String>,
    /// PATH entries to prepend when spawning the host.
    pub path_prepend: Vec<String>,
    /// Absolute path of npm's `npm-cli.js` (npm ships inside node).
    pub npm_cli: Option<String>,
    /// Absolute path of pnpm's `pnpm.cjs` (runtime install or PATH).
    pub pnpm_cjs: Option<String>,
    /// Whether the bundle's dependencies (node_modules) are installed.
    pub deps_ok: bool,
    /// Where the snapshot came from (for diagnostics).
    pub source: String,
    /// Missing pieces that provision() must install.
    pub missing: Vec<String>,
    /// Fatal detection error; when set, nothing else is usable.
    pub error: Option<String>,
}

fn appdata_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:/"))
}

/// Runtime provisioning root (mirrors the official launcher layout).
pub fn runtime_root() -> PathBuf {
    appdata_dir().join("DeepSeek Harness").join("runtime")
}

fn harness_root() -> PathBuf {
    appdata_dir().join("DeepSeek Harness")
}

fn exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).is_file()
}

/// Run `<node> --version` to prove the candidate really executes.
fn probe_node(path: &str) -> bool {
    Command::new(path)
        .arg("--version")
        .output()
        .map(|out| out.status.success() && !out.stdout.is_empty())
        .unwrap_or(false)
}

fn probe_pnpm_on_path() -> Option<String> {
    let output = Command::new("pnpm.cjs").arg("--version").output().ok()?;
    if output.status.success() {
        Some("pnpm.cjs".to_string())
    } else {
        None
    }
}

/// npm-cli.js that ships inside a node distribution.
fn npm_cli_for_node(node: &str) -> Option<String> {
    let dir = Path::new(node).parent()?;
    let candidate = dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    if candidate.is_file() {
        Some(candidate.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Parse the official launcher contract if present.
fn from_launch_json() -> Option<EnvironmentSnapshot> {
    let path = harness_root().join("bin").join("dsh-launch.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let node = value.get("node")?.as_str()?.to_string();
    let cli = value.get("cli")?.as_str()?.to_string();
    let dsh_home = value
        .get("dshHome")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let path_prepend = value
        .get("pathPrepend")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if !exists(&node) || !exists(&cli) {
        return None;
    }
    let dsh_home = dsh_home.filter(|d| Path::new(d).is_dir());
    Some(EnvironmentSnapshot {
        node: Some(node),
        cli: Some(cli),
        dsh_home,
        path_prepend,
        npm_cli: None,
        pnpm_cjs: None,
        deps_ok: false,
        source: "dsh-launch.json".into(),
        missing: Vec::new(),
        error: None,
    })
}

/// Scan `harness-versions/<rev>/` for the newest install with a CLI entry.
fn from_harness_versions() -> Option<EnvironmentSnapshot> {
    let root = harness_root().join("harness-versions");
    let mut revs = std::fs::read_dir(&root).ok()?;
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    while let Some(entry) = revs.next() {
        let entry = entry.ok()?;
        let dir = entry.path();
        let cli = dir.join("apps").join("cli").join("lib").join("bin.js");
        if !cli.is_file() {
            continue;
        }
        let time = entry.metadata().ok()?.modified().ok()?;
        candidates.push((time, dir));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let dir = candidates.first()?.1.clone();

    let manifest = harness_root().join("runtime").join("manifest.json");
    let (mut node, mut dsh_home, mut path_prepend) = (None, None, Vec::new());
    if let Ok(text) = std::fs::read_to_string(&manifest) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            node = value
                .get("nodePath")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|p| exists(p));
            dsh_home = value
                .get("harnessRoot")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
    }
    let cli = dir.join("apps").join("cli").join("lib").join("bin.js");
    let cli_str = cli.to_string_lossy().into_owned();
    Some(EnvironmentSnapshot {
        node,
        cli: Some(cli_str),
        dsh_home,
        path_prepend,
        npm_cli: None,
        pnpm_cjs: None,
        deps_ok: false,
        source: "harness-versions".into(),
        missing: Vec::new(),
        error: None,
    })
}

/// Fall back to `node` on PATH (probed) + DSH_HOME env.
fn from_path_and_env() -> EnvironmentSnapshot {
    let dsh_home = std::env::var("DSH_HOME").ok();
    let node = std::env::var("PATH")
        .ok()
        .and_then(|path| {
            for dir in path.split(';') {
                let candidate = Path::new(dir).join("node.exe");
                if candidate.is_file() && probe_node(&candidate.to_string_lossy()) {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
            None
        });
    EnvironmentSnapshot {
        node,
        cli: None,
        dsh_home,
        path_prepend: Vec::new(),
        npm_cli: None,
        pnpm_cjs: None,
        deps_ok: false,
        source: "path/env".into(),
        missing: Vec::new(),
        error: None,
    }
}

/// Whether the bundle's dependencies are installed.
fn deps_ok_for_cli(cli: &str) -> bool {
    // npm-installed package: <pkg>/node_modules must contain @deepseek-ai
    if let Some(idx) = cli.find("node_modules") {
        let pkg_root = &cli[..idx];
        let nm = Path::new(pkg_root).join("node_modules");
        return nm.join("@deepseek-ai").is_dir() || nm.join("cordis").is_dir();
    }
    // harness-versions bundle: some ancestor has node_modules/@deepseek-ai
    for anc in Path::new(cli).ancestors() {
        let nm = anc.join("node_modules");
        if nm.is_dir() {
            return nm.join("@deepseek-ai").is_dir();
        }
    }
    false
}

fn compute_missing(snapshot: &EnvironmentSnapshot) -> Vec<String> {
    let mut missing = Vec::new();
    if snapshot.node.is_none() {
        missing.push("nodejs".into());
    }
    if snapshot.npm_cli.is_none() {
        missing.push("npm".into());
    }
    if snapshot.pnpm_cjs.is_none() {
        missing.push("pnpm".into());
    }
    if snapshot.cli.is_none() {
        missing.push("dsh".into());
    }
    if snapshot.cli.is_some() && !snapshot.deps_ok {
        missing.push("依赖".into());
    }
    missing
}

/// Full detection pipeline. `error` is set only when nothing can run;
/// `missing` lists installable gaps (npm/pnpm/deps).
pub fn discover() -> EnvironmentSnapshot {
    let mut snapshot = from_launch_json()
        .or_else(from_harness_versions)
        .unwrap_or_else(from_path_and_env);

    // Validate node; fall back to PATH.
    if let Some(node) = &snapshot.node {
        if !probe_node(node) {
            snapshot.node = None;
        }
    }
    if snapshot.node.is_none() {
        let fallback = from_path_and_env();
        snapshot.node = fallback.node;
    }

    // npm ships with node.
    if let Some(node) = &snapshot.node {
        snapshot.npm_cli = npm_cli_for_node(node);
    }

    // pnpm: runtime-global install first, then PATH.
    let runtime_pnpm = runtime_root()
        .join("pnpm-global")
        .join("node_modules")
        .join("pnpm")
        .join("bin")
        .join("pnpm.cjs");
    if runtime_pnpm.is_file() {
        snapshot.pnpm_cjs = Some(runtime_pnpm.to_string_lossy().into_owned());
    } else {
        snapshot.pnpm_cjs = probe_pnpm_on_path();
    }

    // DSH_HOME default.
    if snapshot.dsh_home.is_none() {
        snapshot.dsh_home = std::env::var("DSH_HOME").ok();
    }
    if snapshot.dsh_home.is_none() {
        let default = harness_root().join("dsh-home");
        if default.is_dir() {
            snapshot.dsh_home = Some(default.to_string_lossy().into_owned());
        }
    }

    // Dependencies.
    if let Some(cli) = &snapshot.cli {
        snapshot.deps_ok = deps_ok_for_cli(cli);
    }

    snapshot.missing = compute_missing(&snapshot);
    snapshot.error = if snapshot.node.is_none() {
        Some("未找到可用的 Node.js（将自动下载安装）".into())
    } else if snapshot.cli.is_none() {
        Some("未找到 DeepSeek Harness（将自动安装）".into())
    } else if snapshot.dsh_home.is_none() {
        Some("未找到 DSH_HOME 目录".into())
    } else {
        None
    };

    snapshot
}

/// Re-fill derived fields after provisioning installed new pieces.
pub fn refresh(snapshot: &mut EnvironmentSnapshot) {
    if let Some(node) = &snapshot.node {
        snapshot.npm_cli = npm_cli_for_node(node);
    }
    let runtime_pnpm = runtime_root()
        .join("pnpm-global")
        .join("node_modules")
        .join("pnpm")
        .join("bin")
        .join("pnpm.cjs");
    if runtime_pnpm.is_file() {
        snapshot.pnpm_cjs = Some(runtime_pnpm.to_string_lossy().into_owned());
    }
    if let Some(cli) = &snapshot.cli {
        snapshot.deps_ok = deps_ok_for_cli(cli);
    }
    snapshot.missing = compute_missing(snapshot);
    snapshot.error = if snapshot.node.is_none() {
        Some("未找到可用的 Node.js".into())
    } else if snapshot.cli.is_none() {
        Some("未找到 DeepSeek Harness".into())
    } else if snapshot.dsh_home.is_none() {
        Some("未找到 DSH_HOME 目录".into())
    } else {
        None
    };
}
