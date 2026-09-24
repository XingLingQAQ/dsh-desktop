//! The pet's file queue: what has been dropped on it and not yet sent.
//!
//! Dropping a file on the pet is a gesture that has to survive the pet being
//! dragged, the bubble being closed, and the main window being shut — so the
//! queue lives in the shell rather than in either window's page. It is also
//! persisted, because a file someone dropped and then went to lunch over is
//! still a file they meant to send.
//!
//! Paths are kept as strings, not `PathBuf`s, because they travel to the host as
//! JSON and come back the same way; converting on every hop would be three
//! chances to lose a non-UTF-8 path for no gain.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How many files can wait at once.
///
/// **Deliberately equal to the host plugin's `MAX_PROMPT_FILES`.** They were 20
/// and 10 for a while, which meant a queue of 11 or more could never be sent —
/// every attempt came back "files must hold at most 10 paths" and the only way out
/// was deleting files one at a time, with nothing saying so. A queue that can hold
/// more than can be sent is a trap; matching the two limits makes a full queue
/// always sendable.
///
/// Files beyond the cap are **not** queued. The badge shows what was accepted, so
/// dropping thirty and seeing ten is at least visible — but it is not a message,
/// and a refusal notice is the honest version of this if it ever matters.
pub const MAX_QUEUE: usize = 10;

/// One file waiting to be sent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueuedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub added_at: u64,
}

/// What the bubble is told about the queue.
#[derive(Serialize)]
pub struct QueueView {
    pub count: usize,
    pub files: Vec<QueuedFile>,
}

static QUEUE: Mutex<Vec<QueuedFile>> = Mutex::new(Vec::new());

fn state_path() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dsh-desktop")
        .join("pet-files.json")
}

/// Read the persisted queue.
///
/// A missing file is an empty queue, not an error: this is a convenience. A file
/// that exists but will not parse is logged rather than passed over — it means a
/// write was interrupted, and the user's queued files are gone.
pub fn load() {
    let files = match fs::read_to_string(state_path()) {
        Ok(text) => match serde_json::from_str::<Vec<QueuedFile>>(&text) {
            Ok(files) => files,
            Err(error) => {
                eprintln!("dsh-desktop: pet-files.json 无法解析（{error}），队列按空处理");
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    };
    // Drop entries whose file has since been moved or deleted. Keeping them would
    // mean a queue that fails to send with a message about a file the user can no
    // longer see anywhere.
    let alive: Vec<QueuedFile> =
        files.into_iter().filter(|f| fs::metadata(&f.path).is_ok()).collect();
    let dropped = alive.len();
    {
        let mut queue = QUEUE.lock().unwrap();
        *queue = alive;
        // Save the filtered list, so dead rows do not sit on disk until the next
        // unrelated mutation happens to rewrite the file.
        if dropped > 0 {
            save(&queue);
        }
    }
}

fn save(files: &[QueuedFile]) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(text) = serde_json::to_string_pretty(files) else { return };
    // Temp + rename, for the same reason as the pet's own state: an interrupted
    // write must leave the previous file rather than half of a new one.
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The queue as the bubble sees it.
pub fn view() -> QueueView {
    let files = QUEUE.lock().unwrap().clone();
    QueueView { count: files.len(), files }
}

/// Add files, ignoring ones already queued and ones that are not files.
///
/// Returns the resulting queue. Deduplication is by path because dropping the
/// same file twice is a mis-drag far more often than it is a request to send it
/// twice.
pub fn add(paths: &[String]) -> QueueView {
    let mut queue = QUEUE.lock().unwrap();
    for path in paths {
        if queue.len() >= MAX_QUEUE {
            break;
        }
        if queue.iter().any(|f| &f.path == path) {
            continue;
        }
        // `metadata` rather than `exists`: a directory is not something to send,
        // and `exists` would happily queue one.
        let Ok(meta) = fs::metadata(path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = PathBuf::from(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        queue.push(QueuedFile {
            path: path.clone(),
            name,
            size: meta.len(),
            added_at: now_ms(),
        });
    }
    save(&queue);
    QueueView { count: queue.len(), files: queue.clone() }
}

/// Remove one path. Returns the resulting queue.
pub fn remove(path: &str) -> QueueView {
    let mut queue = QUEUE.lock().unwrap();
    queue.retain(|f| f.path != path);
    save(&queue);
    QueueView { count: queue.len(), files: queue.clone() }
}

/// Empty the queue. Returns the (empty) result.
pub fn clear() -> QueueView {
    let mut queue = QUEUE.lock().unwrap();
    queue.clear();
    save(&queue);
    QueueView { count: 0, files: Vec::new() }
}

/// Remove exactly these paths, leaving anything else alone.
///
/// What a successful send uses, rather than [`clear`]: a file dropped on the pet
/// *while* the previous prompt was uploading is not part of that send, and
/// emptying the queue would discard it silently. The user would have watched the
/// badge show it and then vanish, and would reasonably conclude it had been
/// attached.
pub fn remove_paths(paths: &[String]) -> QueueView {
    let mut queue = QUEUE.lock().unwrap();
    queue.retain(|f| !paths.iter().any(|p| p == &f.path));
    save(&queue);
    QueueView { count: queue.len(), files: queue.clone() }
}
