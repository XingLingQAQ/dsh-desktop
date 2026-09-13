//! User-level skill catalog for the desktop skill manager.
//!
//! A skill is a loose file, not a record: DSH's filesystem provider reads
//! `<root>/<name>/SKILL.md` (or a flat `<root>/<name>.md`) from a ranked list
//! of roots, so "managing skills" is a directory scan plus a write. Project
//! roots resolve against a session's cwd and are deliberately out of scope
//! here — the settings page has no session, and DSH already exposes the
//! session-scoped catalog to the composer.
//!
//! Two machine-global roots are covered:
//!   * `<dsh home>/skills` — owned by DSH, where new skills are created;
//!   * `<home>/.agents/skills` — the shared Agent Skills directory, which DSH
//!     reads and which other agent tools may also point at.
//!
//! Frontmatter is parsed with a deliberately small reader rather than a YAML
//! engine: only the five keys the catalog needs are recognised, and anything
//! else is left in the file untouched. A skill whose frontmatter this reader
//! cannot make sense of still lists — it just shows up as unreadable, which is
//! better than hiding a file DSH itself may well be loading.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// One readable frontmatter field set, plus the markdown body.
#[derive(Default)]
struct Frontmatter {
    name: String,
    description: String,
    when_to_use: Option<String>,
    /// Raw `disable-model-invocation`, absent when the key is missing.
    disable_model_invocation: Option<bool>,
    /// Raw `user-invocable`, absent when the key is missing.
    user_invocable_flag: Option<bool>,
}

/// A frontmatter entry this reader does not model, kept verbatim (including a
/// block scalar's indented body) so rewriting a skill cannot delete it.
struct Kept {
    /// Raw lines, the key line first.
    lines: Vec<String>,
}

/// Upload ceilings. A real skill is a directory of prose and small scripts —
/// `impeccable` is 148 files, the largest here — so these are loose enough not
/// to reject a legitimate import and tight enough that a wrong pick or a
/// hostile archive cannot fill the disk through this route.
const MAX_FILES: usize = 600;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
/// Path components, counted after `..` and `.` are resolved away.
const MAX_DEPTH: usize = 16;
/// Files listed per skill card; the response carries the true count too.
const INVENTORY_LIMIT: usize = 300;

impl Frontmatter {
    /// The host's rule (`skill-filesystem`'s `parseInvocationPolicy`): absence
    /// means invocable, and only an explicit `false` retires a capability.
    /// Getting this backwards would badge every ordinary skill as restricted.
    fn model_invocable(&self) -> bool {
        self.disable_model_invocation != Some(true)
    }

    fn user_invocable(&self) -> bool {
        self.user_invocable_flag != Some(false)
    }
}

/// Kebab-case identifier, the same rule the host registry enforces
/// (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). Enforced here too because the name becomes
/// a path segment.
fn name_ok(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    // `prev_dash` starts true so a leading '-' is rejected.
    let mut prev_dash = true;
    for byte in name.bytes() {
        match byte {
            b'a'..=b'z' | b'0'..=b'9' => prev_dash = false,
            b'-' if !prev_dash => prev_dash = true,
            _ => return false,
        }
    }
    !prev_dash
}

/// YAML booleans as skill frontmatter spells them, matching the host's
/// `frontmatterBoolean`. Anything else (including a quoted word the host would
/// reject) reads as absent rather than as `false`.
fn truthy(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" => Some(false),
        _ => None,
    }
}

/// Split `---` frontmatter off the body and read the keys the catalog needs,
/// handing back the rest verbatim.
///
/// The unread keys are not decoration: a real skill's frontmatter carries
/// fields this page has no widget for (`license`, a compatibility note, a
/// future key), and a save that rebuilt the block from only what it understood
/// would delete them. Unknown keys are therefore captured as raw lines.
fn parse(text: &str) -> (Frontmatter, Vec<Kept>, String) {
    let mut front = Frontmatter::default();
    let mut kept: Vec<Kept> = Vec::new();
    // Indexed rather than iterator-driven: a block scalar has to look at the
    // line that terminates it before deciding whether it belongs to the block.
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|line| line.trim_end()) != Some("---") {
        return (front, kept, text.to_string());
    }
    let mut index = 1usize;
    let mut closed = false;
    while index < lines.len() {
        let raw_line = lines[index];
        let trimmed = raw_line.trim_end();
        index += 1;
        if trimmed == "---" {
            closed = true;
            break;
        }
        let Some((key, raw)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let mut value = raw.trim().to_string();
        let mut block_lines: Vec<String> = Vec::new();
        // Block scalars (`description: |` + indented lines) are common for the
        // long routing descriptions skills use, so fold them back to one line
        // for our own keys — and keep them whole for the ones we hand back.
        if matches!(value.as_str(), "|" | ">" | "|-" | ">-" | "|+" | ">+") {
            while index < lines.len() {
                let next = lines[index];
                if !next.starts_with(' ') && !next.starts_with('\t') {
                    // Indented run over — this line is the next key or the
                    // closing delimiter, and stays for the outer loop.
                    break;
                }
                index += 1;
                block_lines.push(next.trim_end().to_string());
            }
            value = block_lines
                .iter()
                .map(|line| line.trim())
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string();
        } else {
            value = value
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string();
        }
        match key {
            "name" => front.name = value,
            "description" => front.description = value,
            "whenToUse" | "when-to-use" => {
                if !value.is_empty() {
                    front.when_to_use = Some(value);
                }
            }
            "disable-model-invocation" => front.disable_model_invocation = truthy(&value),
            "user-invocable" => front.user_invocable_flag = truthy(&value),
            _ => {
                let mut captured = vec![raw_line.trim_end().to_string()];
                captured.append(&mut block_lines);
                kept.push(Kept { lines: captured });
            }
        }
    }
    if !closed {
        return (Frontmatter::default(), Vec::new(), text.to_string());
    }
    let body = lines[index..].join("\n");
    (front, kept, body)
}


/// Escape a value for a double-quoted YAML scalar on one line.
fn yaml_quote(value: &str) -> String {
    let folded = value.replace(['\r', '\n'], " ");
    let escaped = folded.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// One writable catalog root.
struct Root {
    /// Wire name the client sends back when saving or deleting.
    id: &'static str,
    /// Directory on disk.
    path: PathBuf,
}

/// The two machine-global skill roots, in the order the UI shows them.
fn roots(home: &Path) -> Vec<Root> {
    let mut list = vec![Root {
        id: "user",
        path: home.join("skills"),
    }];
    if let Some(user_home) = home.parent() {
        list.push(Root {
            id: "agents",
            path: user_home.join(".agents").join("skills"),
        });
    }
    list
}

/// Suffix appended to a skill's manifest file to take it out of the catalog.
///
/// DSH's filesystem provider discovers a skill by the file name alone
/// (`<dir>/SKILL.md`, or `<name>.md` at the root), and its watcher ignores
/// anything else, so renaming the manifest *is* the off switch — the directory
/// and everything in it stay exactly where they are, and renaming back is the
/// on switch. A `disabled:` flag would need the host to honour it; this needs
/// nothing from the host at all.
const PAUSED_SUFFIX: &str = ".paused";

/// Read one skill directory or flat file. Returns `None` when neither shape
/// exists, and whether what was found is paused.
fn read_skill(dir: &Path, name: &str) -> Option<(PathBuf, Frontmatter, String, bool)> {
    let packed = dir.join(name).join("SKILL.md");
    let paused_packed = dir.join(name).join(format!("SKILL.md{PAUSED_SUFFIX}"));
    let flat = dir.join(format!("{name}.md"));
    let paused_flat = dir.join(format!("{name}.md{PAUSED_SUFFIX}"));
    let (path, paused) = if packed.is_file() {
        (packed, false)
    } else if paused_packed.is_file() {
        (paused_packed, true)
    } else if flat.is_file() {
        (flat, false)
    } else if paused_flat.is_file() {
        (paused_flat, true)
    } else {
        return None;
    };
    let text = fs::read_to_string(&path).ok()?;
    let (front, _kept, body) = parse(&text);
    Some((path, front, body, paused))
}

/// Walk a skill directory and report what is in it: the page shows the files a
/// skill ships, because a skill is a directory — `docx` carries 61 of them,
/// including Python — and a card that only ever showed one markdown body would
/// hide everything the import brought in.
///
/// An explicit stack rather than recursion: the depth is bounded by the walk
/// itself (`MAX_DEPTH`), and a hand-made directory tree should not be able to
/// reach the process stack through this route.
/// @returns the files (capped at `INVENTORY_LIMIT`) and the true total.
fn inventory(root: &Path, paused: bool) -> (Vec<Value>, usize) {
    let mut files: Vec<Value> = Vec::new();
    let mut total = 0usize;
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(root.to_path_buf(), PathBuf::new())];
    while let Some((dir, relative)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let here = relative.join(&name);
            let path = entry.path();
            if path.is_dir() {
                if here.components().count() < MAX_DEPTH {
                    stack.push((path, here));
                }
                continue;
            }
            total += 1;
            if files.len() >= INVENTORY_LIMIT {
                continue;
            }
            // The paused manifest is the skill's manifest; listing it under the
            // name it will have again on resume is the honest reading, since
            // this list describes the skill rather than the directory.
            let shown = if paused && name == format!("SKILL.md{PAUSED_SUFFIX}") {
                "SKILL.md".to_string()
            } else {
                name
            };
            let shown_path = relative.join(shown);
            files.push(json!({
                // Slash-separated on the wire: the page renders these, and a
                // Windows separator would read as an escape there.
                "path": shown_path.components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/"),
                "bytes": entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            }));
        }
    }
    files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    (files, total)
}

/// Enumerate the catalog. A root that does not exist contributes nothing.
fn scan(home: &Path) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    for root in roots(home) {
        let Ok(entries) = fs::read_dir(&root.path) else {
            continue;
        };
        let mut names: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            // A dot-prefixed entry is scratch — an install's staging directory,
            // macOS's `__MACOSX`, a stray `.DS_Store` — never a skill.
            if file_name.starts_with('.') {
                continue;
            }
            if entry.path().is_dir() {
                names.push(file_name);
            } else if let Some(stem) = file_name
                .strip_suffix(&format!(".md{PAUSED_SUFFIX}"))
                .or_else(|| file_name.strip_suffix(".md"))
            {
                names.push(stem.to_string());
            }
        }
        names.sort();
        names.dedup();
        for name in names {
            let Some((path, front, body, paused)) = read_skill(&root.path, &name) else {
                continue;
            };
            let packed = root.path.join(&name);
            let (files, file_count) = if packed.is_dir() {
                inventory(&packed, paused)
            } else {
                let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                (vec![json!({ "path": path.file_name().map(|part| part.to_string_lossy().into_owned()).unwrap_or_default(), "bytes": size })], 1)
            };
            rows.push(json!({
                // The frontmatter name wins: DSH resolves a skill by it, and
                // the directory name is only the fallback lookup key.
                "name": if front.name.is_empty() { name.clone() } else { front.name.clone() },
                "description": front.description,
                "whenToUse": front.when_to_use,
                "modelInvocable": front.model_invocable(),
                "userInvocable": front.user_invocable(),
                "source": root.id,
                "path": path.to_string_lossy(),
                // Taken out of the catalog by a manifest rename; the card shows
                // it greyed out with a resume action rather than hiding it.
                "paused": paused,
                "body": body,
                "files": files,
                "fileCount": file_count,
            }));
        }
    }
    rows
}


/// `GET /skills` payload.
pub fn list(home: &Path) -> Value {
    json!({
        "roots": roots(home)
            .iter()
            .map(|root| json!({
                "id": root.id,
                "path": root.path.to_string_lossy(),
                // Only the DSH-owned root accepts brand-new skills; the shared
                // agent directory is editable in place but not a drop target.
                "acceptsNew": root.id == "user",
            }))
            .collect::<Vec<_>>(),
        "skills": scan(home),
    })
}

/// Resolve a skill's directory (or flat file) inside one root, refusing any
/// path that escapes it.
fn locate(home: &Path, source: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    if !name_ok(name) {
        return Err("技能名必须是 kebab-case(小写字母、数字、连字符)".into());
    }
    let root = roots(home)
        .into_iter()
        .find(|root| root.id == source)
        .ok_or_else(|| "未知的技能目录".to_string())?;
    let dir = root.path.join(name);
    let flat = root.path.join(format!("{name}.md"));
    // `name_ok` already rules out separators and `..`, but keep the check
    // explicit: this is the one place a client-supplied string becomes a path.
    if dir.parent() != Some(root.path.as_path()) {
        return Err("技能路径越界".into());
    }
    Ok((dir, flat))
}

/// The frontmatter entries a rewrite must carry through untouched, read from
/// the skill's current file — paused or not, since pausing is a property of the
/// skill and not of its content.
fn kept_keys(dir: &Path) -> Vec<Kept> {
    let active = dir.join("SKILL.md");
    let paused = dir.join(format!("SKILL.md{PAUSED_SUFFIX}"));
    let path = if active.is_file() {
        active
    } else if paused.is_file() {
        paused
    } else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let (_, kept, _) = parse(&text);
    kept
}

/// `POST /skills/save` — write the markdown half of one skill.
///
/// This edits `SKILL.md` and nothing else: an imported skill's scripts,
/// templates and references are not the page's to rewrite, and the editor never
/// showed them. Frontmatter keys this reader does not model come along
/// verbatim, so editing a description cannot quietly delete `license`.
pub fn save(home: &Path, request: &Value) -> Result<Value, String> {
    let name = request
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let description = request
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let source = request
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("user");
    // Renames rewrite the old file away rather than leaving it behind.
    let previous = request
        .get("previousName")
        .and_then(Value::as_str)
        .map(str::to_string);
    if !name_ok(&name) {
        return Err("技能名必须是 kebab-case(小写字母、数字、连字符)".into());
    }
    if description.is_empty() {
        return Err("描述不能为空".into());
    }
    // A flat `<name>.md` is a valid existing shape but never the one this
    // writes: saving normalises a skill to its directory form.
    let (dir, _flat) = locate(home, source, &name)?;

    let model_invocable = request
        .get("modelInvocable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let user_invocable = request
        .get("userInvocable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let when_to_use = request
        .get("whenToUse")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let body = request
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_start_matches(['\r', '\n'])
        .to_string();

    // Where the skill lives now, or the name it is being renamed from: a rename
    // moves the directory, so reading only the new one would drop the keys.
    let kept = if dir.join("SKILL.md").is_file() || dir.join(format!("SKILL.md{PAUSED_SUFFIX}")).is_file() {
        kept_keys(&dir)
    } else {
        previous
            .as_deref()
            .and_then(|old| locate(home, source, old).ok())
            .map(|(old_dir, _)| kept_keys(&old_dir))
            .unwrap_or_default()
    };

    let mut text = String::from("---\n");
    text.push_str(&format!("name: {name}\n"));
    text.push_str(&format!("description: {}\n", yaml_quote(&description)));
    if let Some(when_to_use) = when_to_use {
        text.push_str(&format!("whenToUse: {}\n", yaml_quote(when_to_use)));
    }
    // Both keys are written only when they retire a capability: the host reads
    // a missing key as "allowed" (`parseInvocationPolicy`), so spelling out
    // the default would just be noise in every file this page touches.
    if !model_invocable {
        text.push_str("disable-model-invocation: true\n");
    }
    if !user_invocable {
        text.push_str("user-invocable: false\n");
    }
    for entry in &kept {
        for line in &entry.lines {
            text.push_str(line);
            text.push('\n');
        }
    }
    text.push_str("---\n\n");
    text.push_str(&body);
    if !body.ends_with('\n') {
        text.push('\n');
    }

    fs::create_dir_all(&dir).map_err(|error| format!("创建技能目录失败: {error}"))?;
    // Written under whichever manifest name the skill carries right now: a
    // store install over a paused skill updates its content without quietly
    // putting it back in the catalog.
    let manifest = if dir.join("SKILL.md").is_file() || !dir.join(format!("SKILL.md{PAUSED_SUFFIX}")).is_file() {
        "SKILL.md".to_string()
    } else {
        format!("SKILL.md{PAUSED_SUFFIX}")
    };
    fs::write(dir.join(manifest), text).map_err(|error| format!("写入技能失败: {error}"))?;

    if let Some(previous) = previous {
        if previous != name {
            if let Ok((old_dir, old_flat)) = locate(home, source, &previous) {
                remove_path(&old_dir);
                let _ = fs::remove_file(old_flat);
            }
        }
    }
    Ok(json!({ "ok": true }))
}


/// Delete a path, tolerating a missing target.
fn remove_path(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

/// Windows device names. A component that looks like an ordinary file name can
/// still resolve to a device — `fs::write("CON")` talks to the console — so an
/// archive is not allowed to name one.
fn reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit()
        && stem.as_bytes()[3] != b'0'
}

/// Resolve one client-supplied relative path inside a skill directory, or
/// refuse it.
///
/// This is the only place an install's strings become paths, so everything the
/// filesystem cares about is enforced here: no absolute paths, no `..`, no
/// drive letters, no reserved characters or device names, nothing deeper than
/// `MAX_DEPTH`. Backslashes are folded to separators first, because an archive
/// written on Windows may spell its paths either way.
fn safe_relative(raw: &str) -> Result<PathBuf, String> {
    let unified = raw.replace('\\', "/");
    let mut out = PathBuf::new();
    let mut depth = 0usize;
    for part in unified.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!("路径越界: {raw}"));
        }
        if part.contains(':')
            || part.contains('*')
            || part.contains('?')
            || part.contains('"')
            || part.contains('<')
            || part.contains('>')
            || part.contains('|')
            || part.bytes().any(|byte| byte < 0x20)
        {
            return Err(format!("路径含非法字符: {raw}"));
        }
        if reserved(part) {
            return Err(format!("路径是系统保留名: {raw}"));
        }
        depth += 1;
        if depth > MAX_DEPTH {
            return Err(format!("目录层级太深: {raw}"));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err(format!("文件路径为空: {raw}"));
    }
    Ok(out)
}

/// Decode standard base64, tolerating whitespace and an unpadded tail.
///
/// Written out rather than pulled in: the only base64 this route ever sees is
/// what the page produced with `btoa`, and the whole of what it must guarantee
/// is that a malformed string is refused instead of yielding wrong bytes.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    /// The six bits one base64 character carries.
    fn sextet(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(input.len() / 4 * 3 + 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = 0usize;
    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        if byte == b'=' {
            padding += 1;
            if padding > 2 {
                return Err("填充过多".into());
            }
            continue;
        }
        if padding > 0 {
            return Err("填充位置有误".into());
        }
        let digit = sextet(byte).ok_or_else(|| "内容不是合法的 base64".to_string())?;
        buffer = (buffer << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    // Whatever is left over is sub-byte padding, and must be zero bits.
    if buffer != 0 {
        return Err("内容不是合法的 base64".into());
    }
    Ok(out)
}

/// `POST /skills/install` — install a whole skill directory from an archive or
/// a picked folder.
///
/// The page does the unpacking (it has the zip reader and the folder picker)
/// and sends the tree as a list of files: text ones as `text`, anything that is
/// not valid UTF-8 as `base64`. That keeps the transport JSON — the bridge
/// reads its body as a string — without making the common case unreadable.
///
/// The write is staged: every file lands in a hidden sibling directory first,
/// which is then swapped into place. An existing skill is only ever replaced
/// whole, so a failure part-way through cannot leave a half-written skill where
/// DSH will read it. Nothing here rewrites `SKILL.md`: an import is a copy, and
/// the file's frontmatter is the author's, including the keys this page has no
/// widget for.
pub fn install(home: &Path, request: &Value) -> Result<Value, String> {
    let source = request
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let root = roots(home)
        .into_iter()
        .find(|root| root.id == source)
        .ok_or_else(|| "未知的技能目录".to_string())?;

    let entries = request
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| "没有要安装的文件".to_string())?;
    if entries.is_empty() {
        return Err("没有要安装的文件".into());
    }
    if entries.len() > MAX_FILES {
        return Err(format!("文件太多: {} 个,上限 {MAX_FILES}", entries.len()));
    }

    let mut incoming: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    for entry in entries {
        let raw = entry.get("path").and_then(Value::as_str).unwrap_or_default();
        let relative = safe_relative(raw)?;
        let bytes = if let Some(text) = entry.get("text").and_then(Value::as_str) {
            text.as_bytes().to_vec()
        } else {
            let encoded = entry
                .get("base64")
                .and_then(Value::as_str)
                .unwrap_or_default();
            base64_decode(encoded).map_err(|error| format!("{raw} 的内容无法解码: {error}"))?
        };
        if bytes.len() > MAX_FILE_BYTES {
            return Err(format!(
                "{raw} 太大: {} 字节,单文件上限 {MAX_FILE_BYTES}",
                bytes.len()
            ));
        }
        total += bytes.len();
        if total > MAX_TOTAL_BYTES {
            return Err(format!("内容太大: 累计超过 {MAX_TOTAL_BYTES} 字节"));
        }
        incoming.push((relative, bytes));
    }

    // `SKILL.md` is what makes a directory a skill, and its frontmatter is where
    // the name comes from when the caller did not supply one.
    let manifest = incoming
        .iter()
        .find(|(path, _)| path == Path::new("SKILL.md"))
        .ok_or_else(|| "这个技能里没有 SKILL.md,DSH 不会把它当成技能".to_string())?;
    let manifest_text = String::from_utf8_lossy(&manifest.1);
    let (front, _kept, _body) = parse(&manifest_text);

    let requested = request
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| name_ok(name));
    let from_folder = request
        .get("folder")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| name_ok(name));
    let front_name = front.name.trim();
    let name = requested
        .or_else(|| name_ok(front_name).then_some(front_name))
        .or(from_folder)
        .ok_or_else(|| {
            "确定不了技能名:请在 SKILL.md 的 frontmatter 里写 name,或让文件夹用 kebab-case 命名".to_string()
        })?;

    let (dir, flat) = locate(home, source, name)?;
    // The flat `<name>.md` shape counts as taking the name too: installing over
    // it would otherwise leave two skills with one name in the same root.
    if (dir.exists() || flat.exists())
        && request.get("overwrite").and_then(Value::as_bool) != Some(true)
    {
        return Err(format!("已存在同名技能 {name}"));
    }
    // An install replaces the content of a skill, not its on/off state: a
    // paused skill stays paused, or a routine update would silently put it back
    // in the catalog behind the user's back.
    let was_paused = dir.join(format!("SKILL.md{PAUSED_SUFFIX}")).is_file();

    let staging = root.path.join(format!(".install-{name}-{}", std::process::id()));
    remove_path(&staging);
    for (relative, bytes) in &incoming {
        let target = staging.join(relative);
        let Some(parent) = target.parent() else {
            return Err(format!("路径无法解析: {}", relative.display()));
        };
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
        fs::write(&target, bytes)
            .map_err(|error| format!("写入 {} 失败: {error}", relative.display()))?;
    }

    remove_path(&dir);
    let _ = fs::remove_file(&flat);
    fs::create_dir_all(&root.path).map_err(|error| format!("创建技能根目录失败: {error}"))?;
    fs::rename(&staging, &dir).map_err(|error| {
        // Leave nothing behind that a later scan could mistake for a skill.
        remove_path(&staging);
        format!("安装 {name} 失败: {error}")
    })?;

    let (_, file_count) = inventory(&dir, was_paused);
    if was_paused {
        let manifest = dir.join("SKILL.md");
        if manifest.is_file() {
            fs::rename(&manifest, dir.join(format!("SKILL.md{PAUSED_SUFFIX}")))
                .map_err(|error| format!("安装后恢复暂停状态失败: {error}"))?;
        }
    }
    Ok(json!({ "ok": true, "name": name, "fileCount": file_count }))
}

/// `POST /skills/remove` — delete one skill and its directory.
pub fn remove(home: &Path, request: &Value) -> Result<Value, String> {
    let name = request
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let source = request
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let (dir, flat) = locate(home, source, &name)?;
    if !dir.exists() && !flat.exists() {
        return Err("技能不存在".into());
    }
    remove_path(&dir);
    let _ = fs::remove_file(&flat);
    Ok(json!({ "ok": true }))
}

/// `POST /skills/pause` — take one skill out of the catalog, or put it back.
///
/// The switch is a rename of the manifest file and nothing else: DSH discovers
/// a skill by that file name, so this needs no cooperation from the host and no
/// restart — its watcher sees the file leave and re-register the skill when it
/// comes back. The directory, its scripts and its references are never touched,
/// which is what makes pausing reversible and safe.
///
/// Idempotent: asking for the state a skill is already in succeeds, so a
/// double-click or a retried request cannot leave it in the wrong one.
pub fn set_paused(home: &Path, request: &Value) -> Result<Value, String> {
    let name = request
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let source = request
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let paused = request
        .get("paused")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let (dir, flat) = locate(home, source, &name)?;

    // Either shape, whichever is actually on disk. A flat skill is paused by
    // renaming `<name>.md`; a directory skill by renaming the `SKILL.md` inside
    // it. Both are the file DSH keys discovery on.
    let candidates = [
        dir.join("SKILL.md"),
        dir.join(format!("SKILL.md{PAUSED_SUFFIX}")),
        flat.clone(),
        flat.with_file_name(format!("{name}.md{PAUSED_SUFFIX}")),
    ];
    let Some(current) = candidates.into_iter().find(|path| path.is_file()) else {
        return Err("技能不存在".into());
    };
    let current_name = current
        .file_name()
        .map(|part| part.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Strip before appending, or asking to pause an already-paused skill would
    // build `SKILL.md.paused.paused` and silently move the manifest again.
    let base = current_name.strip_suffix(PAUSED_SUFFIX).unwrap_or(&current_name).to_string();
    let target_name = if paused {
        format!("{base}{PAUSED_SUFFIX}")
    } else {
        base
    };
    if target_name == current_name {
        return Ok(json!({ "ok": true, "paused": paused }));
    }
    let target = current.with_file_name(&target_name);
    if target.exists() {
        return Err(format!("{target_name} 已经存在,没法重命名"));
    }
    fs::rename(&current, &target).map_err(|error| format!("重命名技能文件失败: {error}"))?;
    Ok(json!({ "ok": true, "paused": paused }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_rules_match_the_host_registry() {
        assert!(name_ok("docx"));
        assert!(name_ok("crafting-effective-readmes"));
        assert!(!name_ok("Docx"));
        assert!(!name_ok("-docx"));
        assert!(!name_ok("docx-"));
        assert!(!name_ok("docx--x"));
        assert!(!name_ok("docx/x"));
        assert!(!name_ok(".."));
        assert!(!name_ok(""));
    }

    #[test]
    fn parses_frontmatter_and_body() {
        let text = "---\nname: demo\ndescription: \"A demo skill\"\nuser-invocable: true\n---\n\n# Body\ntext\n";
        let (front, kept, body) = parse(text);
        assert_eq!(front.name, "demo");
        assert_eq!(front.description, "A demo skill");
        assert!(front.model_invocable());
        assert!(front.user_invocable());
        assert!(body.contains("# Body"));
        assert!(kept.is_empty());
    }

    #[test]
    fn absent_invocation_keys_mean_allowed() {
        // The host's rule, and the one every ordinary skill relies on.
        let (front, _, _) = parse("---\nname: demo\ndescription: d\n---\n");
        assert!(front.model_invocable());
        assert!(front.user_invocable());
    }

    #[test]
    fn folds_block_scalar_descriptions() {
        let text = "---\nname: demo\ndescription: |\n  first line\n  second line\n---\nbody\n";
        let (front, _, _) = parse(text);
        assert_eq!(front.description, "first line second line");
    }

    #[test]
    fn reads_disable_model_invocation() {
        let text = "---\nname: demo\ndescription: d\ndisable-model-invocation: true\n---\n";
        let (front, _, _) = parse(text);
        assert!(!front.model_invocable());
        assert!(front.user_invocable());
    }

    #[test]
    fn only_an_explicit_false_retires_user_invocation() {
        let (front, _, _) = parse("---\nname: d\ndescription: d\nuser-invocable: false\n---\n");
        assert!(!front.user_invocable());
        assert!(front.model_invocable());
    }

    #[test]
    fn missing_frontmatter_still_yields_a_body() {
        let (front, kept, body) = parse("# no frontmatter\n");
        assert!(front.name.is_empty());
        assert!(front.model_invocable());
        assert_eq!(body, "# no frontmatter\n");
        assert!(kept.is_empty());
    }

    #[test]
    fn unknown_frontmatter_keys_are_kept_not_dropped() {
        let text = "---\nname: demo\ndescription: d\nlicense: MIT\nallowed-tools: |\n  Read\n  Bash\n---\nbody\n";
        let (front, kept, _) = parse(text);
        assert_eq!(front.description, "d");
        assert_eq!(kept.len(), 2);
        // A block scalar belonging to an unread key stays in the file whole,
        // rather than being flattened or lost.
        assert_eq!(kept[1].lines, vec!["allowed-tools: |", "  Read", "  Bash"]);
    }

    #[test]
    fn a_save_carries_unknown_frontmatter_through() {
        let home = scratch("keep-front");
        let dir = home.join("skills").join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: demo\ndescription: before\nlicense: MIT\n---\nold body\n",
        )
        .unwrap();

        save(&home, &json!({ "name": "demo", "description": "after", "body": "# New\n" })).unwrap();

        let text = fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(text.contains("description: \"after\""));
        assert!(text.contains("license: MIT"));
        assert!(text.contains("# New"));
        assert!(!text.contains("old body"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_rename_carries_unknown_frontmatter_to_the_new_name() {
        let home = scratch("keep-rename");
        let dir = home.join("skills").join("old-name");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: old-name\ndescription: d\nlicense: MIT\n---\n",
        )
        .unwrap();

        save(
            &home,
            &json!({ "name": "new-name", "previousName": "old-name", "description": "d", "body": "" }),
        )
        .unwrap();

        let text = fs::read_to_string(home.join("skills").join("new-name").join("SKILL.md")).unwrap();
        assert!(text.contains("license: MIT"));
        let _ = fs::remove_dir_all(&home);
    }

    /// A payload shaped the way the page sends one: `SKILL.md` plus a nested
    /// script, the shape every real skill has.
    fn tree(extra: Value) -> Value {
        let mut request = json!({
            "source": "user",
            "files": [
                { "path": "SKILL.md", "text": "---\nname: demo\ndescription: does a thing\nlicense: MIT\n---\nbody\n" },
                { "path": "scripts/run.py", "text": "print('hi')\n" },
                { "path": "references/deep/notes.md", "text": "# notes\n" },
                { "path": "assets/logo.png", "base64": "iVBORw0KGgo=" },
            ],
        });
        if let (Some(target), Some(source)) = (request.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        request
    }

    #[test]
    fn install_writes_the_whole_tree_verbatim() {
        let home = scratch("install-tree");
        let result = install(&home, &tree(json!({}))).unwrap();
        assert_eq!(result["name"], "demo");
        assert_eq!(result["fileCount"], 4);

        let dir = home.join("skills").join("demo");
        // The nested script and the binary asset both land, byte for byte.
        assert_eq!(fs::read_to_string(dir.join("scripts").join("run.py")).unwrap(), "print('hi')\n");
        assert_eq!(fs::read_to_string(dir.join("references").join("deep").join("notes.md")).unwrap(), "# notes\n");
        assert_eq!(fs::read(dir.join("assets").join("logo.png")).unwrap(), b"\x89PNG\r\n\x1a\n");
        // And SKILL.md is a copy, so its unread keys survive the import.
        let manifest = fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(manifest.contains("license: MIT"));
        assert!(manifest.contains("body"));

        // The catalog reports what came in, not just the markdown.
        let listed = list(&home);
        assert_eq!(listed["skills"][0]["fileCount"], 4);
        assert_eq!(listed["skills"][0]["files"].as_array().unwrap().len(), 4);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn install_refuses_a_path_that_escapes_or_is_unnameable() {
        let home = scratch("install-escape");
        for bad in ["../escape.md", "a/../../b.md", "/abs.md", "C:\\abs.md", ".install-x/SKILL.md", "nul.md", "con"] {
            let request = json!({
                "source": "user",
                "files": [{ "path": bad, "text": "x" }],
            });
            assert!(install(&home, &request).is_err(), "{bad} should be refused");
        }
        // Nothing was written anywhere.
        assert!(!home.join("skills").join("escape.md").exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn install_needs_a_manifest_and_a_usable_name() {
        let home = scratch("install-manifest");
        // No SKILL.md at all.
        assert!(install(&home, &json!({
            "source": "user",
            "files": [{ "path": "README.md", "text": "x" }],
        })).is_err());
        // A manifest whose frontmatter names nothing usable, and no folder or
        // explicit name to fall back on.
        assert!(install(&home, &json!({
            "source": "user",
            "files": [{ "path": "SKILL.md", "text": "no frontmatter\n" }],
        })).is_err());
        // The folder name is used when the frontmatter is silent.
        let result = install(&home, &json!({
            "source": "user",
            "folder": "from-folder",
            "files": [{ "path": "SKILL.md", "text": "no frontmatter\n" }],
        })).unwrap();
        assert_eq!(result["name"], "from-folder");
        // An explicit name wins over both.
        let result = install(&home, &json!({
            "source": "user",
            "name": "explicit",
            "folder": "from-folder",
            "files": [{ "path": "SKILL.md", "text": "---\nname: demo\ndescription: d\n---\n" }],
        })).unwrap();
        assert_eq!(result["name"], "explicit");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn install_asks_before_replacing_and_then_replaces_whole() {
        let home = scratch("install-overwrite");
        install(&home, &tree(json!({}))).unwrap();
        let dir = home.join("skills").join("demo");
        fs::write(dir.join("leftover.md"), "from the previous install\n").unwrap();

        // Without the flag the existing skill is left exactly as it was.
        assert!(install(&home, &tree(json!({}))).is_err());
        assert!(dir.join("leftover.md").is_file());

        install(&home, &tree(json!({ "overwrite": true }))).unwrap();
        // Replaced whole: the previous install's extra file is gone.
        assert!(!dir.join("leftover.md").exists());
        assert!(dir.join("scripts").join("run.py").is_file());
        // No staging directory is left where a scan could find it.
        let leftovers: Vec<String> = fs::read_dir(home.join("skills"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".install-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn base64_decodes_exactly_and_refuses_nonsense() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("QQ==").unwrap(), b"A");
        assert_eq!(base64_decode("QUI=").unwrap(), b"AB");
        assert_eq!(base64_decode("QUJD").unwrap(), b"ABC");
        assert_eq!(base64_decode("iVBORw0KGgo=").unwrap(), b"\x89PNG\r\n\x1a\n");
        // Whitespace from a wrapped payload is fine.
        assert_eq!(base64_decode("QU\nJD").unwrap(), b"ABC");
        assert!(base64_decode("QUJD*").is_err());
        assert!(base64_decode("Q===").is_err());
        assert!(base64_decode("QQ==QQ==").is_err());
    }

    #[test]
    fn device_names_are_refused_whatever_their_extension() {
        assert!(reserved("CON"));
        assert!(reserved("nul.md"));
        assert!(reserved("com1"));
        assert!(reserved("LPT9.txt"));
        assert!(!reserved("com0"));
        assert!(!reserved("console"));
        assert!(!reserved("null.md"));
    }

    #[test]
    fn quotes_keep_yaml_single_line() {
        assert_eq!(yaml_quote("a \"b\"\nc"), "\"a \\\"b\\\" c\"");
    }

    #[test]
    fn pausing_renames_the_manifest_and_nothing_else() {
        let home = scratch("pause");
        install(&home, &tree(json!({}))).unwrap();
        let dir = home.join("skills").join("demo");

        let result = set_paused(&home, &json!({ "source": "user", "name": "demo", "paused": true })).unwrap();
        assert_eq!(result["paused"], true);
        // The manifest moved; the rest of the tree did not.
        assert!(!dir.join("SKILL.md").exists());
        assert!(dir.join("SKILL.md.paused").is_file());
        assert_eq!(fs::read_to_string(dir.join("scripts").join("run.py")).unwrap(), "print('hi')\n");

        // The skill stays in the catalog, flagged, so the card can offer a
        // resume instead of it vanishing with no way back.
        let listed = list(&home);
        assert_eq!(listed["skills"][0]["name"], "demo");
        assert_eq!(listed["skills"][0]["paused"], true);
        assert_eq!(listed["skills"][0]["fileCount"], 4);
        // Inventoried under the name it will have again, not the on-disk one.
        let paths: Vec<&str> = listed["skills"][0]["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|file| file["path"].as_str())
            .collect();
        assert!(paths.contains(&"SKILL.md"), "{paths:?}");

        set_paused(&home, &json!({ "source": "user", "name": "demo", "paused": false })).unwrap();
        assert!(dir.join("SKILL.md").is_file());
        assert_eq!(list(&home)["skills"][0]["paused"], false);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn pausing_is_idempotent_and_a_flat_skill_works_the_same_way() {
        let home = scratch("pause-flat");
        fs::write(
            home.join("skills").join("flat.md"),
            "---\nname: flat\ndescription: a flat one\n---\nbody\n",
        )
        .unwrap();

        set_paused(&home, &json!({ "source": "user", "name": "flat", "paused": true })).unwrap();
        // Asking twice must not append the suffix a second time.
        set_paused(&home, &json!({ "source": "user", "name": "flat", "paused": true })).unwrap();
        assert!(home.join("skills").join("flat.md.paused").is_file());
        let listed = list(&home);
        assert_eq!(listed["skills"][0]["paused"], true);

        set_paused(&home, &json!({ "source": "user", "name": "flat", "paused": false })).unwrap();
        set_paused(&home, &json!({ "source": "user", "name": "flat", "paused": false })).unwrap();
        assert!(home.join("skills").join("flat.md").is_file());
        assert_eq!(list(&home)["skills"][0]["paused"], false);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn reinstalling_does_not_resume_a_paused_skill() {
        let home = scratch("pause-install");
        install(&home, &tree(json!({}))).unwrap();
        set_paused(&home, &json!({ "source": "user", "name": "demo", "paused": true })).unwrap();

        install(&home, &tree(json!({ "overwrite": true }))).unwrap();
        assert!(home.join("skills").join("demo").join("SKILL.md.paused").is_file());
        assert_eq!(list(&home)["skills"][0]["paused"], true);
        let _ = fs::remove_dir_all(&home);
    }

    /// A scratch DSH home with a `skills/` directory, plus the sibling
    /// `.agents/skills` the second root resolves to.
    fn scratch(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("dsh-skills-test-{tag}"));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::create_dir_all(home.parent().unwrap().join(".agents").join("skills")).unwrap();
        home
    }

    #[test]
    fn save_then_list_round_trips() {
        let home = scratch("roundtrip");
        save(
            &home,
            &json!({
                "name": "demo-skill",
                "description": "does a thing\nspanning two lines",
                "whenToUse": "when a thing is needed",
                "modelInvocable": false,
                "userInvocable": true,
                "body": "# Demo\n\nBody text.\n",
            }),
        )
        .unwrap();

        let listed = list(&home);
        let skill = &listed["skills"][0];
        assert_eq!(skill["name"], "demo-skill");
        // The newline folds to a space, so the value stays one YAML scalar.
        assert_eq!(skill["description"], "does a thing spanning two lines");
        assert_eq!(skill["whenToUse"], "when a thing is needed");
        assert_eq!(skill["modelInvocable"], false);
        assert_eq!(skill["userInvocable"], true);
        assert_eq!(skill["source"], "user");
        assert!(skill["body"].as_str().unwrap().contains("# Demo"));

        // The two invocation keys are omitted at their permissive defaults.
        let text = fs::read_to_string(home.join("skills").join("demo-skill").join("SKILL.md")).unwrap();
        assert!(text.contains("disable-model-invocation: true"));
        assert!(!text.contains("user-invocable"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn save_rejects_bad_names_and_empty_descriptions() {
        let home = scratch("reject");
        let good = json!({ "name": "demo", "description": "d", "body": "" });
        assert!(save(&home, &good).is_ok());
        assert!(save(&home, &json!({ "name": "../escape", "description": "d" })).is_err());
        assert!(save(&home, &json!({ "name": "demo", "description": "  " })).is_err());
        assert!(save(&home, &json!({ "name": "demo", "source": "nope", "description": "d" })).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn remove_deletes_the_directory_and_ignores_a_missing_one() {
        let home = scratch("remove");
        save(&home, &json!({ "name": "gone", "description": "d", "body": "" })).unwrap();
        assert!(home.join("skills").join("gone").is_dir());
        remove(&home, &json!({ "name": "gone", "source": "user" })).unwrap();
        assert!(!home.join("skills").join("gone").exists());
        assert!(remove(&home, &json!({ "name": "gone", "source": "user" })).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn rename_moves_the_old_file_away() {
        let home = scratch("rename");
        save(&home, &json!({ "name": "old-name", "description": "d", "body": "" })).unwrap();
        save(
            &home,
            &json!({ "name": "new-name", "previousName": "old-name", "description": "d", "body": "" }),
        )
        .unwrap();
        assert!(!home.join("skills").join("old-name").exists());
        assert!(home.join("skills").join("new-name").join("SKILL.md").is_file());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_flat_markdown_file_is_a_skill_too() {
        let home = scratch("flat");
        fs::write(
            home.join("skills").join("flat-one.md"),
            "---\nname: flat-one\ndescription: flat\n---\nbody\n",
        )
        .unwrap();
        let listed = list(&home);
        assert_eq!(listed["skills"][0]["name"], "flat-one");
        assert_eq!(listed["skills"][0]["description"], "flat");
        let _ = fs::remove_dir_all(&home);
    }
}
