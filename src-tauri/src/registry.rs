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

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::store::plugins_root;

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
fn segment_ok(segment: &str) -> bool {
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
fn install_dir(id: &str) -> Result<PathBuf, String> {
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
    let staging = std::env::temp_dir().join(format!("dsh-desktop-install-{stamp}"));
    let archive = staging.join("plugin.tar.gz");
    let unpacked = staging.join("unpacked");
    fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        run(
            "curl.exe",
            &[
                "-fsSL",
                "--retry",
                "2",
                "--max-time",
                "120",
                "-o",
                &archive.to_string_lossy(),
                tarball,
            ],
        )?;
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

    let _ = fs::remove_dir_all(&staging);
    result
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
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
}
