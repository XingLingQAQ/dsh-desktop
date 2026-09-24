import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

function TrayMenu() {
  // Read rather than assume: the pet's state lives in the shell and can have been
  // changed from the pet's own menu, so this window asks instead of remembering.
  const [petOn, setPetOn] = useState(false);

  useEffect(() => {
    void fetchTheme();
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    let disposed = false;
    void invoke<boolean>("pet_visible").then((on) => {
      if (!disposed) setPetOn(on);
    });
    return () => {
      disposed = true;
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
          // The tray menu is the one place that is always reachable, so it is
          // where the pet has to be recoverable from — a pet whose only switch
          // is the pet itself is a pet that cannot be turned back on after being
          // turned off.
          void invoke<boolean>("set_pet_visible", { visible: !petOn }).then((on) => {
            setPetOn(on);
          });
        }}
      >
        {petOn ? "隐藏桌面宠物" : "显示桌面宠物"}
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
