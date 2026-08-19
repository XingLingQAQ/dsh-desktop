import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { DeepSeekLogo } from "./components/DeepSeekLogo";
import { applyTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

const STEPS = ["检测运行环境", "启动 DeepSeek Harness", "等待服务就绪"];

interface LaunchState {
  step: number;
  label: string;
  done: boolean;
  port: number | null;
  url: string | null;
  error: string | null;
  log: string[];
  attached: boolean;
}

function Splash() {
  const [state, setState] = useState<LaunchState | null>(null);

  // 主题联动：DSH 主题变化 → 壳实时跟随
  useEffect(() => {
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // 启动状态轮询（不依赖事件推送，丢失事件也不卡流程）。
  // 就绪后由 Rust 侧自动进入主窗口，这里只负责展示。
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      if (disposed) return;
      try {
        const s = await invoke<LaunchState>("get_launch_state");
        if (disposed) return;
        setState(s);
        if (s.done && !s.error) {
          return; // Rust 会自动切换窗口
        }
      } catch {
        /* 尚未就绪 */
      }
      timer = window.setTimeout(poll, 250);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = () => {
    void invoke("retry_launch");
  };

  const current = state?.step ?? -1;
  const done = state?.done ?? false;
  const error = state?.error ?? null;
  const progress = done
    ? 100
    : current < 0
      ? 0
      : Math.min(96, ((current + 0.7) / STEPS.length) * 100);

  return (
    <div className="splash">
      <div className="card">
        <div className="logo-wrap">
          <div className="ring" />
          <div className="ring delay" />
          <DeepSeekLogo size={104} className="logo" />
        </div>
        <div className="title">DeepSeek Harness</div>
        <div className="subtitle">
          {error ? "启动失败" : done ? "就绪" : "正在启动桌面环境…"}
        </div>
        <div className="steps">
          {STEPS.map((label, index) => {
            // 安装缺失组件等动态步骤：用 Rust 上报的真实标签
            const shownLabel = index === current && state?.label ? state.label : label;
            const stateClass = error
              ? index === current
                ? "error"
                : index < current
                  ? "done"
                  : "pending"
              : done || index < current
                ? "done"
                : index === current
                  ? "active"
                  : "pending";
            return (
              <div key={label} className={`step ${stateClass}`}>
                <div className="step-icon">
                  {stateClass === "done" ? "✓" : stateClass === "error" ? "!" : ""}
                </div>
                <span>{shownLabel}</span>
              </div>
            );
          })}
        </div>
        <div className="progress">
          <div className="bar" style={{ width: `${progress}%` }} />
        </div>
        <div className={`error-panel ${error ? "visible" : ""}`}>
          <div className="error-title">环境检测未通过</div>
          <div className="error-msg">{error}</div>
          {state && state.log.length > 0 && (
            <div className="error-log">{state.log.slice(-5).join("\n")}</div>
          )}
          <button className="retry" onClick={retry}>
            重新检测
          </button>
        </div>
        {state && state.log.length > 0 && !error && (
          <div className="log-tail">{state.log.slice(-3).join("\n")}</div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Splash />
  </React.StrictMode>,
);
