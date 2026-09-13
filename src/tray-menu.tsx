import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

function TrayMenu() {
  useEffect(() => {
    // This window is created on demand, long after the page reported its theme,
    // so it has to ask for the last snapshot rather than wait for a change.
    void fetchTheme();
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const close = () => {
    // The window is transient; hiding is enough.
    void getCurrentWindow().hide();
  };

  return (
    <div className="tray-menu">
      <button
        onClick={() => {
          void invoke("show_main_window");
          close();
        }}
      >
        显示主窗口
      </button>
      <button
        onClick={() => {
          void invoke("open_settings");
          close();
        }}
      >
        设置
      </button>
      <button
        className="danger"
        onClick={() => {
          void invoke("quit_app");
        }}
      >
        退出
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>,
);
