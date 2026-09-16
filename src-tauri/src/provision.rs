//! Real provisioning: install missing pieces (nodejs / npm / pnpm / dsh) into
//! `%APPDATA%\DeepSeek Harness\runtime`, mirroring the official launcher recipe
//! (npmmirror node mirror + npmmirror npm registry, pnpm global install).

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::discover::{runtime_root, EnvironmentSnapshot};

/// Node LTS pinned by the official launcher (runtime\manifest.json used 22.19.0).
const NODE_VERSION: &str = "22.19.0";
const NODE_MIRROR: &str = "https://npmmirror.com/mirrors/node";
const NPM_REGISTRY: &str = "https://registry.npmmirror.com";
const PNPM_VERSION: &str = "11.7.0";

/// Run a command, streaming its output into the log, in a clean npm environment.
///
/// `npm_config_*` variables are stripped, and that is not tidiness — it is the
/// difference between the harness update working and failing with a bare "退出
/// 码 1". npm exports its whole configuration to the environment of any script
/// it runs, so an app started with `npm run tauri dev` inherits things like
/// `npm_config_allow_scripts=ws` from the developer's own `.npmrc`. A later
/// `npm install` in that process reads those as command-line-equivalent config
/// and refuses outright — `--allow-scripts is not allowed in project-scoped
/// installs` — no matter what `--userconfig` says, because the environment wins.
/// A shipped build started from a shortcut inherits none of this, which is why
/// it only ever broke for us.
fn run_logged(
    log: &dyn Fn(String),
    program: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    log(format!("$ {program} {}", args.join(" ")));
    let mut command = Command::new(program);
    command.args(args);
    for (key, _) in std::env::vars() {
        if key.to_ascii_lowercase().starts_with("npm_config_") {
            command.env_remove(&key);
        }
    }
    let output = command
        .output()
        .map_err(|e| format!("执行失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    for line in stdout.lines().chain(stderr.lines()) {
        let line = line.trim();
        if !line.is_empty() {
            log(line.to_string());
        }
    }
    if !output.status.success() {
        return Err(format!("命令退出码 {}", output.status.code().unwrap_or(-1)));
    }
    Ok(output)
}

fn download(log: &dyn Fn(String), url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    log(format!("下载 {url}"));
    run_logged(
        log,
        "curl.exe",
        &[
            "-L",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "900",
            "-o",
            dest.to_str().unwrap_or("out"),
            url,
        ],
    )
    .map(|_| ())
}

fn extract_zip(log: &dyn Fn(String), zip: &Path, dest: &Path) -> Result<(), String> {
    let _ = std::fs::create_dir_all(dest);
    log(format!("解压 {} → {}", zip.display(), dest.display()));
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        zip.display(),
        dest.display()
    );
    run_logged(log, "powershell.exe", &["-NoProfile", "-Command", &script]).map(|_| ())
}

/// Install node into `runtime\node` if missing. Returns the node.exe path.
fn ensure_node(snapshot: &EnvironmentSnapshot, log: &dyn Fn(String)) -> Result<String, String> {
    if let Some(node) = &snapshot.node {
        return Ok(node.clone());
    }
    let root = runtime_root();
    let node_dir = root.join("node").join(format!("node-v{NODE_VERSION}-win-x64"));
    let node_exe = node_dir.join("node.exe");
    if node_exe.is_file() {
        log(format!("Node.js 已存在: {}", node_exe.display()));
        return Ok(node_exe.to_string_lossy().into_owned());
    }

    log("安装 Node.js…".to_string());
    let zip_path = root.join(format!("node-v{NODE_VERSION}-win-x64.zip"));
    download(
        log,
        &format!("{NODE_MIRROR}/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip"),
        &zip_path,
    )?;
    extract_zip(log, &zip_path, &root.join("node"))?;
    let _ = std::fs::remove_file(&zip_path);
    if !node_exe.is_file() {
        return Err("Node.js 解压后未找到 node.exe".into());
    }
    log(format!("Node.js 安装完成: {}", node_exe.display()));
    Ok(node_exe.to_string_lossy().into_owned())
}

/// Install pnpm into `runtime\pnpm-global` via npm. Returns pnpm.cjs path.
fn ensure_pnpm(snapshot: &EnvironmentSnapshot, log: &dyn Fn(String)) -> Result<String, String> {
    if let Some(pnpm) = &snapshot.pnpm_cjs {
        return Ok(pnpm.clone());
    }
    let npm_cli = snapshot
        .npm_cli
        .clone()
        .ok_or_else(|| "npm 不可用，无法安装 pnpm".to_string())?;
    let node = snapshot
        .node
        .clone()
        .ok_or_else(|| "node 不可用".to_string())?;
    let prefix = runtime_root().join("pnpm-global");

    log("安装 pnpm…".to_string());
    run_logged(
        log,
        &node,
        &[
            &npm_cli,
            "install",
            "-g",
            &format!("pnpm@{PNPM_VERSION}"),
            "--registry",
            NPM_REGISTRY,
            "--prefix",
            prefix.to_str().unwrap_or(""),
        ],
    )?;

    let pnpm_cjs = prefix
        .join("node_modules")
        .join("pnpm")
        .join("bin")
        .join("pnpm.cjs");
    if !pnpm_cjs.is_file() {
        return Err("pnpm 安装后未找到 pnpm.cjs".into());
    }
    log(format!("pnpm 安装完成: {}", pnpm_cjs.display()));
    Ok(pnpm_cjs.to_string_lossy().into_owned())
}

/// Install the dsh CLI package into `runtime\dsh` via npm. Returns bin.js path.
fn ensure_dsh(snapshot: &EnvironmentSnapshot, log: &dyn Fn(String)) -> Result<String, String> {
    if let Some(cli) = &snapshot.cli {
        return Ok(cli.clone());
    }
    let npm_cli = snapshot
        .npm_cli
        .clone()
        .ok_or_else(|| "npm 不可用，无法安装 dsh".to_string())?;
    let node = snapshot
        .node
        .clone()
        .ok_or_else(|| "node 不可用".to_string())?;
    let prefix = runtime_root().join("dsh");

    log("安装 DeepSeek Harness (dsh)…".to_string());
    run_logged(
        log,
        &node,
        &[
            &npm_cli,
            "install",
            "--prefix",
            prefix.to_str().unwrap_or(""),
            "@deepseek-ai/dsh",
            "--registry",
            NPM_REGISTRY,
        ],
    )?;

    let cli = prefix
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !cli.is_file() {
        return Err("dsh 安装后未找到 bin.js".into());
    }
    log(format!("dsh 安装完成: {}", cli.display()));
    Ok(cli.to_string_lossy().into_owned())
}

/// Install (or replace) the harness at a pinned version under this desktop's own
/// runtime, and return the new CLI entry.
///
/// Updates go here rather than into the official launcher's `harness-versions`
/// tree: that tree belongs to `dsh.exe`, and replacing one of its revisions
/// would leave the launcher's manifest describing a bundle that is no longer
/// there. `discover()` prefers this copy once it exists, so picking a version
/// here is what makes it the one that runs.
pub fn install_dsh_version(
    snapshot: &EnvironmentSnapshot,
    version: &str,
    log: &dyn Fn(String),
) -> Result<String, String> {
    let npm_cli = snapshot
        .npm_cli
        .clone()
        .ok_or_else(|| "npm 不可用，无法安装更新".to_string())?;
    let node = snapshot
        .node
        .clone()
        .ok_or_else(|| "node 不可用，无法安装更新".to_string())?;
    let prefix = runtime_root().join("dsh");
    let package = format!("@deepseek-ai/dsh@{version}");

    // 用自己的 npmrc，别继承用户那份。机器上的 ~/.npmrc 里有一行
    // `allow-scripts=ws`，npm 在项目级安装里遇到这个键会直接报
    // EALLOWSCRIPTS 并以退出码 1 收场——安装其实什么都没做，却看起来像网络
    // 或包本身的问题。把配置指向我们自己的一个空文件，这套安装就只受我们写的
    // 参数影响，用户环境里有什么都不会改变结果。
    let npmrc = runtime_root().join("npmrc");
    if let Some(parent) = npmrc.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !npmrc.exists() {
        let _ = std::fs::write(&npmrc, "");
    }

    log(format!("安装 DeepSeek Harness {version}…"));
    run_logged(
        log,
        &node,
        &[
            &npm_cli,
            "install",
            "--prefix",
            prefix.to_str().unwrap_or(""),
            &package,
            "--registry",
            NPM_REGISTRY,
            "--userconfig",
            npmrc.to_str().unwrap_or(""),
            // 这个包带 postinstall 脚本（编译 spawn helper、prebuild 原生模块）。
            // 不跑它们装出来的是一份坏掉的运行时。
            "--foreground-scripts",
        ],
    )?;

    let cli = prefix
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !cli.is_file() {
        return Err(format!("安装 {version} 后未找到 bin.js"));
    }
    log(format!("安装完成: {}", cli.display()));
    Ok(cli.to_string_lossy().into_owned())
}

/// Provision every missing piece. Each step logs to the splash. On success the
/// returned snapshot has all fields filled (caller should refresh()).
pub fn provision(
    snapshot: &mut EnvironmentSnapshot,
    log: &dyn Fn(String),
) -> Result<(), String> {
    let missing = snapshot.missing.clone();
    if missing.is_empty() {
        return Ok(());
    }
    log(format!("检测到缺失组件: {}", missing.join(", ")));

    // 1. node（npm 随 node 一起）
    let node = ensure_node(snapshot, log)?;
    snapshot.node = Some(node.clone());
    // npm-cli comes from the node distribution
    {
        let dir = Path::new(&node).parent().map(Path::to_path_buf);
        if let Some(dir) = dir {
            let npm_cli = dir
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js");
            if npm_cli.is_file() {
                snapshot.npm_cli = Some(npm_cli.to_string_lossy().into_owned());
            }
        }
    }

    // 2. pnpm
    let pnpm = ensure_pnpm(snapshot, log)?;
    snapshot.pnpm_cjs = Some(pnpm);

    // 3. dsh CLI
    let cli = ensure_dsh(snapshot, log)?;
    snapshot.cli = Some(cli);

    // 4. DSH_HOME init (the boot creates profiles; we create the base dir)
    if snapshot.dsh_home.is_none() {
        let default = runtime_root().parent().unwrap_or(Path::new(".")).join("dsh-home");
        snapshot.dsh_home = Some(default.to_string_lossy().into_owned());
    }
    if let Some(home) = &snapshot.dsh_home {
        let _ = std::fs::create_dir_all(PathBuf::from(home));
    }

    crate::discover::refresh(snapshot);
    log("缺失组件安装完成".to_string());
    Ok(())
}
