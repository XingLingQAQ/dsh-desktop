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
 * manifest that is not there — which is what every user sees before the first
 * release is published — so that one is worth saying in the interface's own
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
 * The 更新 tab: what this app runs, and what it could run instead.
 *
 * The two halves are separate on purpose. The DSH kernel is an npm package this
 * app installs into its own runtime, so its check is a registry read and its
 * install is an npm call, after which the shell has to come back up on the new
 * version. The shell itself is a Tauri app, so its update goes through Tauri's
 * signed release manifest — this panel only supplies the address and the public
 * key, and hands the rest to the updater.
 */
export function UpdatePanel({
  settings,
  onSettings,
}: {
  settings: UpdateSettings;
  onSettings: (settings: UpdateSettings) => void;
}) {
  const [endpoint, setEndpoint] = useState(settings.update_endpoint ?? "");
  const [pubkey, setPubkey] = useState(settings.update_pubkey ?? "");
  const [channel, setChannel] = useState(settings.harness_channel ?? "latest");

  const [report, setReport] = useState<UpdateReport | null>(null);
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<"client" | "harness" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ chunk: number; total: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void invoke<string>("get_app_version").then(setVersion);
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

  // The form is saved before a check rather than behind a Save button: the
  // check reads the settings on the other side, so anything typed here has to
  // be persisted first or it would be checking the previous configuration.
  const persist = useCallback(async () => {
    const saved = await invoke<UpdateSettings>("set_update_settings", {
      endpoint,
      channel,
      pubkey,
    });
    // The command returns the whole settings document; keep only what this tab
    // owns so the shell's other fields are not clobbered in the parent state.
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
      setReport(await invoke<UpdateReport>("check_updates"));
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

  const client = report?.client;
  const harness = report?.harness;
  const harnessLatest = harness?.latest ?? null;

  const clientStatus = (() => {
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
    <div className="upd">
      <section className="upd-section">
        <div className="upd-head">
          <strong>桌面客户端</strong>
          <span className="upd-version">v{client?.current ?? version}</span>
        </div>
        <p className="upd-note">{clientStatus}</p>
        {client?.available && client.notes && (
          <pre className="upd-notes">{client.notes}</pre>
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
              {percent === null
                ? `已下载 ${formatBytes(progress.chunk)}`
                : `${percent}%`}
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
      </section>

      <section className="upd-section">
        <div className="upd-head">
          <strong>DSH 内核</strong>
          <span className="upd-version">{harness?.current ?? "未检测到"}</span>
        </div>
        <p className="upd-note">{harnessStatus}</p>
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
        <div className="upd-actions">
          <button
            className="upd-button"
            disabled={checking || busy !== null}
            onClick={() => void check()}
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
          {harness?.available && harnessLatest !== null && (
            <button
              className="upd-button primary"
              disabled={busy !== null}
              onClick={() => void installHarness(harnessLatest)}
            >
              {busy === "harness" ? "安装中…" : `安装 ${harnessLatest} 并重启`}
            </button>
          )}
        </div>
        {log.length > 0 && <pre className="upd-log">{log.join("\n")}</pre>}
      </section>

      <section className="upd-section">
        <div className="upd-head">
          <strong>更新源</strong>
        </div>
        <p className="upd-note">
          桌面客户端的更新清单地址，Tauri 的发布格式，需要 HTTPS。留空就用内置的
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
      </section>

      {notice !== null && <p className="upd-notice">{notice}</p>}
    </div>
  );
}
