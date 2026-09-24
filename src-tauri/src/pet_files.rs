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
/// A cap rather than no limit: the queue is shown in a 268px-wide card, and a
/// hundred entries is not a queue anyone reads. Dropping more than this is
/// refused with a count rather than silently truncated, so the user knows why
/// some of what they dragged did not appear.
pub const MAX_QUEUE: usize = 20;

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

/// Read the persisted queue. A missing or unreadable file is an empty queue, not
/// an error: this is a convenience, never something to fail over.
pub fn load() {
    let files = fs::read_to_string(state_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<QueuedFile>>(&text).ok())
        .unwrap_or_default();
    // Drop entries whose file has since been moved or deleted. Keeping them would
    // mean a queue that fails to send with a message about a file the user can no
    // longer see anywhere.
    let alive: Vec<QueuedFile> = files.into_iter().filter(|f| fs::metadata(&f.path).is_ok()).collect();
    *QUEUE.lock().unwrap() = alive;
}

fn save(files: &[QueuedFile]) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(files) {
        let _ = fs::write(path, text);
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

/// The paths currently queued, for a send.
///
/// Does not clear: the send can still be refused by the host, and emptying the
/// queue before knowing that would lose the user's files to an error message.
pub fn paths() -> Vec<String> {
    QUEUE.lock().unwrap().iter().map(|f| f.path.clone()).collect()
}
