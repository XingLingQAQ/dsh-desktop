import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { DeepSeekLogo } from "./components/DeepSeekLogo";
import { UpdatePanel } from "./components/UpdatePanel";
import { applyTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

const win = getCurrentWindow();

type HostStatus = "detecting" | "booting" | "running" | "error";

type AppSettings = {
  close_to_tray: boolean;
  auto_start: boolean;
  workspace_folder: string | null;
  update_endpoint: string | null;
  harness_channel: string | null;
  update_pubkey: string | null;
};

const STATUS_TEXT: Record<HostStatus, string> = {
  detecting: "检测环境",
  booting: "启动中",
  running: "运行中",
  error: "异常",
};

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const value = await win.isMaximized();
        if (!disposed) setMaximized(value);
      } catch {
        /* window not ready yet */
      }
    };
    void refresh();
    const unlisten = win.onResized(() => void refresh());
    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="window-controls">
      <button className="win-btn" aria-label="最小化" onClick={() => void win.minimize()}>
        <svg viewBox="0 0 12 12">
          <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" />
        </svg>
      </button>
      <button
        className="win-btn"
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12">
            <rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" />
            <path d="M4 3.5 V2.5 H10.5 V9 H9.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12">
            <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button className="win-btn close" aria-label="关闭" onClick={() => void win.close()}>
        <svg viewBox="0 0 12 12">
          <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="win-btn settings-btn" aria-label="设置" onClick={onClick}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
      </svg>
    </button>
  );
}

function Shell() {
  const [status, setStatus] = useState<HostStatus>("detecting");
  const [port, setPort] = useState<number | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    close_to_tray: false,
    auto_start: false,
    workspace_folder: null,
    update_endpoint: null,
    harness_channel: null,
    update_pubkey: null,
  });
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<"general" | "update" | "diagnostics">("general");
  const [appVersion, setAppVersion] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [currentDir, setCurrentDir] = useState("C:\\\\");
  const [dirEntries, setDirEntries] = useState<Array<{ name: string; path: string; is_dir: boolean }>>([]);

  // 主题联动：DSH 主题变化 → 壳实时跟随
  useEffect(() => {
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 状态：事件推送 + 轮询兜底
  useEffect(() => {
    let disposed = false;
    const un = listen<{ status: HostStatus; port?: number }>("host-status", (event) => {
      if (disposed) return;
      setStatus(event.payload.status);
      setPort(event.payload.port);
    });
    let timer: number | undefined;
    const poll = async () => {
      if (disposed) return;
      try {
        const s = await invoke<{
          done: boolean;
          error: string | null;
          port: number | null;
        }>("get_launch_state");
        if (disposed) return;
        setStatus(s.error ? "error" : s.done ? "running" : "booting");
        if (s.port != null) setPort(s.port);
      } catch {
        /* 尚未就绪 */
      }
      timer = window.setTimeout(poll, 500);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      un.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 设置：加载 + 托盘“设置”菜单打开面板
  useEffect(() => {
    let disposed = false;
    void invoke<AppSettings>("get_settings").then((s) => {
      if (!disposed) setSettings(s);
    });
    void invoke<string>("get_app_version").then((v) => {
      if (!disposed) setAppVersion(v);
    });
    const un = listen("open-settings", () => {
      if (!disposed) setSettingsOpen(true);
    });
    return () => {
      disposed = true;
      un.then((fn) => fn());
    };
  }, []);

  const toggleCloseToTray = async () => {
    const next = await invoke<AppSettings>("set_close_to_tray", {
      value: !settings.close_to_tray,
    });
    setSettings(next);
  };

  const toggleAutoStart = async () => {
    const next = await invoke<AppSettings>("set_auto_start", {
      value: !settings.auto_start,
    });
    setSettings(next);
  };

  const exportDiagnostics = async () => {
    try {
      const path = await invoke<string>("export_diagnostics");
      setExportPath(path);
    } catch (e) {
      setExportPath(String(e));
    }
  };

  const openFolderPicker = async () => {
    const start = settings.workspace_folder ?? "C:\\\\";
    setCurrentDir(start);
    setFolderPickerOpen(true);
    await browseDir(start);
  };

  const browseDir = async (path: string) => {
    try {
      const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>("list_directory", { path });
      setDirEntries(entries);
      setCurrentDir(path);
    } catch (e) {
      console.error(e);
    }
  };

  const selectFolder = async (path: string) => {
    const next = await invoke<AppSettings>("set_workspace_folder", { path });
    setSettings(next);
    setFolderPickerOpen(false);
  };

  return (
    <div className="shell">
      <div
        className="titlebar"
        data-tauri-drag-region
        onDoubleClick={() => void win.toggleMaximize()}
      >
        <div className="brand" data-tauri-drag-region>
          <div className="brand-logo" data-tauri-drag-region>
            <DeepSeekLogo size={17} />
          </div>
          <span className="brand-title" data-tauri-drag-region>
            DeepSeek Harness
          </span>
          {appVersion !== "" && (
            <span className="brand-version" data-tauri-drag-region>
              v{appVersion}
            </span>
          )}
        </div>
        <div className="spacer" data-tauri-drag-region />
        <div className={`status ${status}`}>
          <span className="dot" />
          {STATUS_TEXT[status]}
          {port !== undefined && status === "running" && (
            <span className="port-chip">127.0.0.1:{port}</span>
          )}
        </div>
        <div className="spacer" data-tauri-drag-region />
        <SettingsButton onClick={() => setSettingsOpen(true)} />
        <WindowControls />
      </div>
      {/* 内容区：Rust 侧放置的子 WebView（DSH Web UI）覆盖此区域；
          挂载前显示载入指示，避免空白 */}
      <div className="content">
        <div className="loading-hint">
          <div className="spinner" />
          <span>正在载入工作区…</span>
        </div>
      </div>
        {settingsOpen && (
          <div className="settings-panel wide" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <span>设置</span>
              <button className="settings-close" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="settings-tabs">
              <button className={settingsTab === "general" ? "active" : ""} onClick={() => setSettingsTab("general")}>通用</button>
              <button className={settingsTab === "update" ? "active" : ""} onClick={() => setSettingsTab("update")}>更新</button>
              <button className={settingsTab === "diagnostics" ? "active" : ""} onClick={() => setSettingsTab("diagnostics")}>诊断</button>
            </div>
            {settingsTab === "general" && (
              <>
                <label className="settings-row">
                  <span>
                    <strong>关闭到托盘</strong>
                    <small>点击关闭按钮时隐藏到托盘而不是退出</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.close_to_tray}
                    onChange={() => void toggleCloseToTray()}
                  />
                </label>
                <label className="settings-row">
                  <span>
                    <strong>开机自启</strong>
                    <small>登录 Windows 后自动启动 DSH Desktop</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.auto_start}
                    onChange={() => void toggleAutoStart()}
                  />
                </label>
                <div className="settings-row settings-row-folder">
                  <span>
                    <strong>工作区文件夹</strong>
                    <small>{settings.workspace_folder ?? "未选择"}</small>
                  </span>
                  <button className="folder-browse" onClick={() => void openFolderPicker()}>浏览</button>
                </div>
              </>
            )}
            {settingsTab === "update" && (
              <UpdatePanel
                settings={settings}
                onSettings={(patch) => setSettings((current) => ({ ...current, ...patch }))}
              />
            )}
            {settingsTab === "diagnostics" && (
              <>
                <button className="settings-export" onClick={() => void exportDiagnostics()}>导出诊断信息</button>
                {exportPath && <div className="settings-export-path">{exportPath}</div>}
              </>
            )}
          </div>
        )}
        {folderPickerOpen && (
          <div className="folder-picker-overlay" onClick={() => setFolderPickerOpen(false)}>
            <div className="folder-picker" onClick={(e) => e.stopPropagation()}>
              <div className="settings-header">
                <span>选择工作区文件夹</span>
                <button className="settings-close" onClick={() => setFolderPickerOpen(false)}>✕</button>
              </div>
              <div className="folder-current">{currentDir}</div>
              <div className="folder-list">
                {dirEntries.filter((e) => e.is_dir).map((e) => (
                  <button key={e.path} onClick={() => void browseDir(e.path)}>{e.name}</button>
                ))}
              </div>
              <div className="folder-actions">
                <button onClick={() => void selectFolder(currentDir)}>选择此文件夹</button>
                <button onClick={() => {
                  const parent = currentDir.replace(/\\[^\\]+$/, "");
                  if (parent && parent !== currentDir) void browseDir(parent);
                }}>上级</button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>,
);
