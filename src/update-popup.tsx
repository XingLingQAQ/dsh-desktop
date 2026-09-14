import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

/** Mirrors `update::HarnessUpdate` — the DSH CLI the shell runs. */
type HarnessUpdate = {
  current: string | null;
  source: string;
  channel: string;
  latest: string | null;
  available: boolean;
  error: string | null;
};

/** Mirrors `update::ClientUpdate` — this desktop app itself. */
type ClientUpdate = {
  current: string;
  latest: string | null;
  notes: string | null;
  available: boolean;
  error: string | null;
};

type UpdateReport = { harness: HarnessUpdate; client: ClientUpdate };

/** The shell's settings document, of which this window only reads one field. */
type ShellSettings = {
  harness_channel: string | null;
} & Record<string, unknown>;

const CHANNELS: Array<{ value: string; label: string }> = [
  { value: "latest", label: "默认通道" },
  { value: "next", label: "抢先通道" },
];

/**
 * The updater crate reports in English. Its most common complaint by far is a
 * manifest that is not there, which is what a build pointed at a release host
 * with nothing on it sees — so that one is worth saying in the interface's own
 * language. Anything unrecognised is shown as it came.
 */
const CLIENT_ERROR_TEXT: Record<string, string> = {
  "Could not fetch a valid release JSON from the remote":
    "更新源上还没有可用的发布清单（还没发布过版本）",
};

function describeClientError(raw: string): string {
  return CLIENT_ERROR_TEXT[raw] ?? raw;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Release notes arrive as markdown. This popup is too small to render it
 * properly — a heading is one line in a 340px box — so the markers are stripped
 * and the text is shown as lines. Anything the release body uses beyond
 * headings, bullets and emphasis comes through as written.
 */
function notesToLines(notes: string): string[] {
  return notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "· ")
        .replace(/\*\*(.+?)\*\*/g, "$1"),
    );
}

/**
 * The updater, in its own window.
 *
 * It cannot be a popup inside the shell page: the DSH UI is a second, native
 * webview layered over the shell's from the title bar down, so anything the
 * shell renders below the title bar is behind it. That is why this is a window
 * of its own — an always-on-top one, like the tray menu, which is above both.
 *
 * Two consequences of that window being kept alive between opens (it is built
 * once, at startup, so the first click is not the one that pays for the page):
 * nothing here remounts, so a check cannot simply run on mount — the shell tells
 * this window when it has been shown, and that is what triggers one; and this
 * window is created before the DSH page has reported a theme, so it asks for the
 * last one rather than waiting for a change that may never come.
 */
function UpdatePopup() {
  const [channel, setChannel] = useState("latest");

  const [report, setReport] = useState<UpdateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<"client" | "harness" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ chunk: number; total: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const close = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  useEffect(() => {
    void fetchTheme();
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    const offLog = listen<string>("update-log", (event) => {
      setLog((lines) => [...lines.slice(-79), event.payload]);
    });
    const offProgress = listen<{ chunk: number; total: number | null }>(
      "update-progress",
      (event) => setProgress(event.payload),
    );
    return () => {
      un.then((fn) => fn());
      offLog.then((fn) => fn());
      offProgress.then((fn) => fn());
    };
  }, []);

  // The settings the check reads live in the shell's store, so they are loaded
  // into this window's form on mount.
  useEffect(() => {
    let disposed = false;
    void invoke<ShellSettings>("get_settings").then((saved) => {
      if (!disposed) setChannel(saved.harness_channel ?? "latest");
    });
    return () => {
      disposed = true;
    };
  }, []);

  // Escape closes, the way a popover should.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // The channel picker is saved as it is chosen: the check reads the settings on
  // the other side, so a check started right after a change would otherwise use
  // the previous channel.
  const setChannelAndSave = useCallback(async (next: string) => {
    setChannel(next);
    await invoke<ShellSettings>("set_harness_channel", { channel: next });
  }, []);

  // The cheap pass paints the last answer (almost always there — the shell
  // checks at startup for the version chip), and never shows a spinner: it is
  // reading a cache, not waiting on anything.
  const loadCached = useCallback(async () => {
    try {
      setReport(await invoke<UpdateReport>("check_updates", { refresh: false }));
    } catch (error) {
      setNotice(String(error));
    }
  }, []);

  // The real check. `indicator` is false for the one that runs behind a window
  // that already has an answer on screen — showing "检查中…" there, over content
  // that is already correct, is what makes a fast window look slow.
  const refresh = useCallback(async (indicator: boolean) => {
    if (indicator) setChecking(true);
    try {
      setReport(await invoke<UpdateReport>("check_updates", { refresh: true }));
      setNotice(null);
    } catch (error) {
      setNotice(String(error));
    } finally {
      if (indicator) setChecking(false);
    }
  }, []);

  // The shell says when this window has been put on screen. Between opens it
  // stays alive, so there is no mount to hang a check on and the report from
  // last time is as old as that look.
  useEffect(() => {
    const un = listen("update-popup-shown", () => {
      void loadCached().then(() => refresh(false));
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [loadCached, refresh]);

  const installClient = async () => {
    setBusy("client");
    setNotice(null);
    setProgress(null);
    try {
      // Never returns on success: the installer takes over and relaunches.
      await invoke("install_client_update");
    } catch (error) {
      setNotice(String(error));
      setBusy(null);
    }
  };

  const installHarness = async (version: string) => {
    setBusy("harness");
    setNotice(null);
    setLog([]);
    try {
      await invoke<string>("install_harness_update", { version });
      setNotice("安装完成，正在重启客户端…");
      await invoke("restart_app");
    } catch (error) {
      setNotice(String(error));
      setBusy(null);
    }
  };

  const client = report?.client;
  const harness = report?.harness;
  const harnessLatest = harness?.latest ?? null;

  const clientStatus = (() => {
    if (report === null && checking) return "检查中…";
    if (client === undefined) return "尚未检查。";
    if (client.error !== null) return describeClientError(client.error);
    if (client.available) return `发现新版本 v${client.latest ?? ""}`;
    return "已是最新版本。";
  })();

  const harnessStatus = (() => {
    if (harness === undefined) return "尚未检查。";
    if (harness.error !== null) return harness.error;
    if (harness.current === null) return `无法确定当前版本（来源：${harness.source}）`;
    if (harness.available) return `发现新版本 ${harness.latest ?? ""}`;
    return harness.latest === null ? "当前通道没有可用版本。" : `${harness.latest} 已是最新。`;
  })();

  const percent =
    progress === null || progress.total === null || progress.total === 0
      ? null
      : Math.min(100, Math.round((progress.chunk / progress.total) * 100));

  return (
    <div className="upd-pop">
      <div className="upd-head">
        <strong>DSH Desktop</strong>
        <span className="upd-version">v{client?.current ?? ""}</span>
        <button className="upd-close" aria-label="关闭" onClick={close}>
          ✕
        </button>
      </div>

      <p className="upd-status" data-tone={client?.available ? "new" : undefined}>
        {clientStatus}
      </p>

      {client?.available && client.notes && (
        <div className="upd-notes">
          {notesToLines(client.notes).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}

      {progress !== null && (
        <div className="upd-progress">
          <div className="upd-bar">
            <div
              className="upd-barFill"
              style={percent === null ? { width: "100%" } : { width: `${percent}%` }}
            />
          </div>
          <span className="upd-progressText">
            {percent === null ? `已下载 ${formatBytes(progress.chunk)}` : `${percent}%`}
          </span>
        </div>
      )}

      <div className="upd-actions">
        <button
          className="upd-button"
          disabled={checking || busy !== null}
          onClick={() => void refresh(true)}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
        {client?.available && (
          <button
            className="upd-button primary"
            disabled={busy !== null}
            onClick={() => void installClient()}
          >
            {busy === "client" ? "下载中…" : "下载并安装"}
          </button>
        )}
      </div>

      {notice !== null && <p className="upd-notice">{notice}</p>}

      {/* 内核默认折起来：这个弹窗先回答「客户端要不要更新」。 */}
      <details className="upd-more">
        <summary>DSH 内核</summary>
        <div className="upd-moreBody">
          <div className="upd-row">
            <span className="upd-current">{harness?.current ?? "未检测到"}</span>
            <span className="upd-status" data-tone={harness?.available ? "new" : undefined}>
              {harnessStatus}
            </span>
          </div>
          <label className="upd-field">
            <span>更新通道</span>
            <select
              value={channel}
              disabled={busy !== null}
              onChange={(event) => void setChannelAndSave(event.target.value)}
            >
              {CHANNELS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {harness?.available && harnessLatest !== null && (
            <button
              className="upd-button primary"
              disabled={busy !== null}
              onClick={() => void installHarness(harnessLatest)}
            >
              {busy === "harness" ? "安装中…" : `安装 ${harnessLatest} 并重启`}
            </button>
          )}
          {log.length > 0 && <pre className="upd-log">{log.join("\n")}</pre>}
        </div>
      </details>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UpdatePopup />
  </React.StrictMode>,
);
