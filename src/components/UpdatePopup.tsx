import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

type UpdateSettings = {
  update_endpoint: string | null;
  harness_channel: string | null;
  update_pubkey: string | null;
};

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
    "更新源上还没有可用的发布清单（还没发布过版本，或地址填错了）",
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
 * properly — a heading is one line in a 320px box — so the markers are stripped
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
 * The updater, as a popup hung under the version number it updates.
 *
 * It owns every piece of update state and stays mounted whether or not it is
 * open, because the check that matters most is the one nobody asked for: the
 * one at startup, which has to run before there is any reason to open this and
 * has to report back a yes or no for the version chip to show a marker. So the
 * parent only says whether the popup is visible and is told whether an update
 * exists; everything else — the check, the install, the progress, the source
 * configuration — happens in here.
 *
 * The two halves are separate on purpose. The DSH kernel is an npm package this
 * app installs into its own runtime, so its check is a registry read and its
 * install is an npm call, after which the shell has to come back up on the new
 * version. The shell itself is a Tauri app, so its update goes through Tauri's
 * signed release manifest, and this only supplies the address and the key.
 */
export function UpdatePopup({
  open,
  onClose,
  version,
  settings,
  onSettings,
  onAvailable,
}: {
  open: boolean;
  onClose: () => void;
  /** Shown before the first check answers; the check then supplies its own. */
  version: string;
  settings: UpdateSettings;
  onSettings: (settings: UpdateSettings) => void;
  onAvailable: (available: boolean) => void;
}) {
  const [endpoint, setEndpoint] = useState(settings.update_endpoint ?? "");
  const [pubkey, setPubkey] = useState(settings.update_pubkey ?? "");
  const [channel, setChannel] = useState(settings.harness_channel ?? "latest");

  const [report, setReport] = useState<UpdateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<"client" | "harness" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ chunk: number; total: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const offLog = listen<string>("update-log", (event) => {
      setLog((lines) => [...lines.slice(-79), event.payload]);
    });
    const offProgress = listen<{ chunk: number; total: number | null }>(
      "update-progress",
      (event) => setProgress(event.payload),
    );
    return () => {
      offLog.then((fn) => fn());
      offProgress.then((fn) => fn());
    };
  }, []);

  // The startup check. Delayed rather than run at mount: this shares the main
  // thread with the splash handoff and the arrival of the DSH webview, and a
  // network round trip racing those is not worth the seconds it could cost. Its
  // failures stay silent — nobody asked for this check, so an unreachable
  // release host must not put an error in front of someone who never opened the
  // popup — but its verdict does reach the version chip.
  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void invoke<UpdateReport>("check_updates")
        .then((next) => {
          if (disposed) return;
          setReport(next);
          onAvailable(next.client.available);
        })
        .catch(() => {
          /* silent by design */
        });
    }, 4000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
    // Runs once: the startup check is not tied to any of these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The form is saved before a check rather than behind a Save button: the
  // check reads the settings on the other side, so anything typed here has to
  // be persisted first or it would be checking the previous configuration.
  const persist = useCallback(async () => {
    const saved = await invoke<UpdateSettings>("set_update_settings", {
      endpoint,
      channel,
      pubkey,
    });
    // The command returns the whole settings document; keep only what this
    // popup owns so the shell's other fields are not clobbered in the parent.
    onSettings({
      update_endpoint: saved.update_endpoint,
      harness_channel: saved.harness_channel,
      update_pubkey: saved.update_pubkey,
    });
  }, [endpoint, channel, pubkey, onSettings]);

  const check = async () => {
    setChecking(true);
    setNotice(null);
    try {
      await persist();
      const next = await invoke<UpdateReport>("check_updates");
      setReport(next);
      onAvailable(next.client.available);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setChecking(false);
    }
  };

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
      await persist();
      await invoke<string>("install_harness_update", { version });
      setNotice("安装完成，正在重启客户端…");
      await invoke("restart_app");
    } catch (error) {
      setNotice(String(error));
      setBusy(null);
    }
  };

  if (!open) return null;

  const client = report?.client;
  const harness = report?.harness;
  const harnessLatest = harness?.latest ?? null;

  const clientStatus = (() => {
    if (checking && report === null) return "检查中…";
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
    <>
      {/* 点击别处收起。透明遮罩而不是失焦：popup 里的输入框需要拿到焦点。 */}
      <div className="upd-scrim" onClick={onClose} />
      <div className="upd-pop" role="dialog" aria-label="更新">
        <div className="upd-head">
          <strong>DSH Desktop</strong>
          <span className="upd-version">v{client?.current ?? version}</span>
          <button className="upd-close" aria-label="关闭" onClick={onClose}>
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
            onClick={() => void check()}
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

        {/* 内核和更新源默认折起来：这个弹窗首先回答的是「客户端要不要更新」。 */}
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
                onChange={(event) => setChannel(event.target.value)}
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

        <details className="upd-more">
          <summary>更新源</summary>
          <div className="upd-moreBody">
            <p className="upd-note">
              客户端的更新清单地址，Tauri 的发布格式，需要 HTTPS。留空就用内置的
              GitHub Releases 地址。
            </p>
            <label className="upd-field">
              <span>清单地址</span>
              <input
                value={endpoint}
                placeholder="留空则使用内置地址"
                spellCheck={false}
                onChange={(event) => setEndpoint(event.target.value)}
                onBlur={() => void persist()}
              />
            </label>
            <label className="upd-field">
              <span>签名公钥</span>
              <input
                value={pubkey}
                placeholder="留空则使用内置公钥"
                spellCheck={false}
                onChange={(event) => setPubkey(event.target.value)}
                onBlur={() => void persist()}
              />
            </label>
          </div>
        </details>
      </div>
    </>
  );
}
