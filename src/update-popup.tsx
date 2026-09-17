import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import { DshSelect } from "./DshSelect";
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

/** Mirrors `update::HARNESS_CHANNELS` in the shell — the same list, in the same
 *  order. A tag the registry publishes but this list omits is a channel nobody
 *  can pick, which is what made a newer release look like "已是最新". */
const CHANNELS: Array<{ value: string; label: string }> = [
  { value: "latest", label: "默认通道" },
  { value: "next", label: "抢先通道" },
  { value: "alpha", label: "内测通道" },
];

/**
 * The updater crate reports in English. Its most common complaint by far is a
 * manifest that is not there, which is what a build pointed at a release host
 * with nothing on it sees — so that one is worth saying in the interface's own
 * language. Anything unrecognised is shown as it came.
 */
/**
 * The updater crate reports in English, and its network messages are the ones a
 * person actually sees: "error sending request for url (…)" says nothing about
 * what to do. The common failures get a line in the interface's own language;
 * anything unrecognised is shown as it came, because a wrong guess is worse than
 * the original text.
 */
const CLIENT_ERROR_TEXT: Array<[RegExp, string]> = [
  [
    /Could not fetch a valid release JSON from the remote/,
    "更新源上还没有可用的发布清单（还没发布过版本）",
  ],
  [/error sending request for url/i, "连不上更新服务器，请检查网络后重试"],
  [/request timed out|operation timed out/i, "连接更新服务器超时，请重试"],
  [/dns error|failed to lookup address/i, "无法解析更新服务器地址，请检查网络"],
  [/certificate/i, "更新服务器的证书校验失败"],
  [/当前已是最新版本/, "已是最新版本"],
];

function describeClientError(raw: string): string {
  for (const [pattern, text] of CLIENT_ERROR_TEXT) {
    if (pattern.test(raw)) return text;
  }
  return raw;
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
  const [busy, setBusy] = useState<"download" | "install" | "harness" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  // `chunk` here is the running total across the whole download, not the size of
  // the latest chunk — the event carries the latter, and the listener adds it up.
  const [progress, setProgress] = useState<{ chunk: number; total: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The version whose payload is already on disk and verified. Downloading and
  // applying are two clicks on purpose: fetching a few megabytes can happen
  // while the app is being used, but applying one replaces this process, so it
  // waits to be asked.
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [harnessOpen, setHarnessOpen] = useState(false);

  const close = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  const card = useRef<HTMLDivElement | null>(null);
  // 进度监听器要读"现在是不是在下载"，但它挂在 mount 时的 effect 里、闭包捕获不到
  // 后来的 busy。用 ref 让它总能读到当前值。
  const busyRef = useRef<typeof busy>(busy);
  busyRef.current = busy;

  // The window hugs its content: the popup is often mostly empty (collapsed
  // sections, no notes) and a panel taller than what it holds is both dead space
  // and, once the container can scroll, a scrollbar for nothing. The card is
  // what gets measured — the scroll container around it is pinned to the window
  // and cannot report the content's own height.
  useEffect(() => {
    const node = card.current;
    if (node === null) return;
    let last = 0;
    const apply = () => {
      const height = Math.ceil(node.offsetHeight);
      if (Math.abs(height - last) < 2) return;
      last = height;
      void invoke("resize_update_popup", { height });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void fetchTheme();
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    const offLog = listen<string>("update-log", (event) => {
      setLog((lines) => [...lines.slice(-79), event.payload]);
    });
    // 每一个事件带的是**这一块**的长度（updater 的 on_chunk 传的是
    // chunk.len()，不是累计值），所以要自己累加。直接把它当成已下载量的话，
    // 进度条会在每块之间来回跳，而不是一路往上走。
    //
    // 只在真的处于下载中才起进度条：命令的"查"和"下"是两段，只有后一段发事件，
    // 但上一次下载的残留事件若飘过来，不能让它凭空点亮一条进度。
    const offProgress = listen<{ chunk: number; total: number | null }>(
      "update-progress",
      (event) =>
        setProgress((current) => {
          if (current === null && !busyRef.current) return current;
          return {
            chunk: (current?.chunk ?? 0) + event.payload.chunk,
            // 总长可能来得晚（取决于是不是分块响应），有就用新的。
            total: event.payload.total ?? current?.total ?? null,
          };
        }),
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

  // Open the DSH section when its check turns up something to install — a
  // folded row is the right default, but a folded row hiding a pending update
  // is just a place for it to be missed. Only a transition opens it: once it is
  // open, or once someone has closed it themselves, later checks leave it be.
  const harnessOffered = report?.harness.available === true;
  const wasOffered = useRef(false);
  useEffect(() => {
    if (harnessOffered && !wasOffered.current) setHarnessOpen(true);
    wasOffered.current = harnessOffered;
  }, [harnessOffered]);

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

  // Fetch the shell update. The bytes are verified as they arrive (the manifest
  // signature is checked against the key in this build), so once this returns
  // the update is ready to apply and applying it needs no network at all.
  //
  // It is deliberately not built on the last report: "没有更新" is a statement
  // about the moment it was made, and the one thing a person pressing a button
  // called 检查并更新 expects is a fresh look. Only a real failure — an
  // unreachable host, a manifest that will not parse — lands in the notice, and
  // then the button is back so it can be pressed again.
  // 主按钮：查一次，有货就顺手下来。
  //
  // 进度的起始点由**第一条进度事件**决定，不在这里预设：这个命令先是查清单、
  // 然后才下载，只有下载阶段会发进度。提前摆出进度条的话，纯粹"查一下"也会闪出
  // 一条在动的条子（什么都不下的时候尤其刺眼）——那是检查，不是下载。
  const checkAndDownload = async () => {
    if (hasPayload) {
      await installClient();
      return;
    }
    setBusy("download");
    setNotice(null);
    setProgress(null);
    try {
      const next = await invoke<ClientUpdate>("download_client_update");
      setReport((current) => (current === null ? current : { ...current, client: next }));
      setDownloaded(next.available ? next.latest : null);
      setProgress(null);
      setBusy(null);
    } catch (error) {
      setNotice(String(error));
      setProgress(null);
      setBusy(null);
    }
  };

  // Apply it. On Windows this ends the process and the installer relaunches the
  // app, so the button's own state is the last thing anyone sees: the pause
  // before the call is there so "正在安装…" is actually painted rather than
  // being cut off by the exit it is describing.
  const installClient = async () => {
    setBusy("install");
    setNotice(null);
    setProgress(null);
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  // A payload is waiting only for the version that is still being offered: if
  // the check has since found something newer, or a newer one was fetched, the
  // stale download is not what the button should offer to install.
  const hasPayload = downloaded !== null && client?.latest === downloaded;

  const clientStatus = (() => {
    if (report === null && checking) return "检查中…";
    if (client === undefined) return "尚未检查。";
    if (client.error !== null) return describeClientError(client.error);
    if (client.available) return "有新版本可以安装";
    return "已是最新版本";
  })();

  const harnessStatus = (() => {
    if (harness === undefined) return "尚未检查。";
    if (harness.error !== null) return harness.error;
    if (harness.current === null) return `无法确定当前版本（来源：${harness.source}）`;
    if (harness.available) return `有新版本 ${harness.latest ?? ""}`;
    return harness.latest === null ? "当前通道没有可用版本。" : `${harness.latest} 已是最新。`;
  })();

  // One tone for the dot and the text, so the two never disagree about what the
  // line is saying.
  const clientTone =
    client?.error != null ? "error" : client?.available ? "new" : client == null ? "muted" : "ok";

  // The bar takes the exact fraction and the text takes the rounded percent:
  // rounding the width as well would move it in visible steps, which is the
  // thing being fixed here.
  const fraction =
    progress === null || progress.total === null || progress.total === 0
      ? null
      : Math.min(1, progress.chunk / progress.total);
  const percent = fraction === null ? null : Math.min(100, Math.round(fraction * 100));

  return (
    <div className="upd-pop">
      {/* 量这一层的高度来决定窗口多高：外面的 .upd-pop 是滚动容器，高度被
          窗口约束着，量不出内容本身的自然高度。 */}
      <div className="upd-card" ref={card}>
        <div className="upd-head">
          <strong>DSH Desktop</strong>
          <span className="upd-version">
            v{client?.current ?? ""}
            {client?.available && client.latest && (
              <>
                <span className="upd-arrow" aria-hidden="true">
                  →
                </span>
                <span className="upd-versionNew">v{client.latest}</span>
              </>
            )}
          </span>
          <button className="upd-close" aria-label="关闭" onClick={close}>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" />
            </svg>
          </button>
        </div>

        <p className="upd-status" data-tone={clientTone}>
          <span className="upd-dot" aria-hidden="true" />
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
                data-indeterminate={fraction === null}
                style={
                  fraction === null
                    ? undefined
                    : { width: `${(fraction * 100).toFixed(2)}%` }
                }
              />
            </div>
            <span className="upd-progressText">
              {percent === null ? `已下载 ${formatBytes(progress.chunk)}` : `${percent}%`}
            </span>
          </div>
        )}

        <div className="upd-actions">
          <button
            className="upd-button outline"
            disabled={checking || busy !== null}
            onClick={() => void refresh(true)}
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
          {/* 「检查更新」和「检查并更新」是同一个位置、同一件事：按下去都是
              先查一次，查到才有得下。所以查到之前按钮不换、不禁用——凭当前
              这份报告把按钮藏起来，碰到没查到（清单暂时取不到）就等于把人堵
              在门口，连再试一次都点不动。主按钮一直在，点了自己会说话。 */}
          {/* 主按钮不出现"检查并更新"这种把两件事并排写的说法：它永远只描述
              这一下会发生什么。没查到过、或者上次没查到 → 是「检查更新」；
              已经知道有新版本 → 是「下载更新」；包到了手上 → 是「安装并重启」。
              所以按钮一直在（见下面的注释），但字永远只有一个动词。 */}
          <button
            className="upd-button primary"
            disabled={checking || busy !== null}
            onClick={() => void checkAndDownload()}
          >
            {(checking || busy !== null) && <span className="upd-spinner" aria-hidden="true" />}
            {busy === "install"
              ? "正在安装…"
              : checking || busy === "download"
                ? percent === null
                  ? "检查中…"
                  : `下载中… ${percent}%`
                : hasPayload
                  ? "安装并重启"
                  : client?.available
                    ? "下载更新"
                    : "检查更新"}
          </button>
        </div>

        {notice !== null && <p className="upd-notice">{notice}</p>}

        {/* 内核默认折起来：这个弹窗先回答「客户端要不要更新」。但真查到了内核
            的新版本就自己展开——藏着一个等你去装的更新，等于没查。展开是单向
            的：查完之后用户自己合上，不该被下一次检查又弹开。 */}
        <details className="upd-more" open={harnessOpen} onToggle={(event) => setHarnessOpen(event.currentTarget.open)}>
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
              <DshSelect
                value={channel}
                choices={CHANNELS}
                disabled={busy !== null}
                onChange={(next) => void setChannelAndSave(next)}
              />
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
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UpdatePopup />
  </React.StrictMode>,
);
