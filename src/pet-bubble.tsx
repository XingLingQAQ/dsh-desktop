/**
 * The pet's bubble — what the pet is looking at, in words.
 *
 * The pet's face can say "busy" but not "running pwsh", and it cannot say which
 * conversation it is talking about. This is that missing sentence.
 *
 * It is a separate window rather than a panel inside the pet because the pet
 * window is 132×168 and does not click through: growing it would mean a large
 * rectangle of desktop that swallows clicks. A second window can be the size the
 * text needs and nothing more.
 *
 * Content arrives the same way it does for the pet — the `pet-state` event from
 * the shell — plus one read of the shell's cached copy on mount, so the card is
 * already filled in on the frame it appears instead of flickering empty for up
 * to one poll interval.
 */

import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

/** Mirrors the snapshot the `dsh-desktop-pet` host plugin publishes. */
type Activity = "idle" | "thinking" | "tool" | "waiting" | "done" | "error";

interface SessionState {
  activity: Activity;
  sessionId: string | null;
  title: string | null;
  tool: string | null;
  turn: number | null;
  lastEnd: { kind: string | null; code: string | null; at: number } | null;
}

/** Parse a snapshot, or return null if it is not one. */
function parse(raw: string | null | undefined): SessionState | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as SessionState;
    if (value !== null && typeof value === "object" && typeof value.activity === "string") {
      return value;
    }
  } catch {
    // Fall through: a malformed payload is treated as "no state yet".
  }
  return null;
}

/**
 * The headline: what is happening right now.
 *
 * `turn/end` reasons are not all the same thing, and this is where that shows.
 * A turn that ended with `error` must not read as a finish — the host already
 * separates them, and collapsing them here would undo that.
 */
function headline(state: SessionState | null): { text: string; tone: string } {
  if (state === null) return { text: "还没收到会话状态", tone: "idle" };
  switch (state.activity) {
    case "thinking":
      return { text: "正在思考…", tone: "busy" };
    case "tool":
      return { text: state.tool === null ? "正在执行工具…" : `正在执行 ${state.tool}`, tone: "busy" };
    case "waiting":
      return { text: "等待你批准", tone: "waiting" };
    case "done":
      return { text: "这个回合完成了", tone: "done" };
    case "error": {
      const code = state.lastEnd?.code;
      return {
        text: code === null || code === undefined ? "这个回合出错了" : `这个回合出错了（${code}）`,
        tone: "error",
      };
    }
    default:
      return { text: "空闲中", tone: "idle" };
  }
}

function Bubble() {
  const [state, setState] = useState<SessionState | null>(null);

  useEffect(() => {
    void fetchTheme();
    const unTheme = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    const unState = listen<string>("pet-state", (event) => {
      const parsed = parse(event.payload);
      if (parsed !== null) setState(parsed);
    });
    // Fill in from the shell's cache before the first poll lands, so the card is
    // never briefly empty.
    void invoke<string | null>("pet_session_state").then((raw) => {
      const parsed = parse(raw);
      if (parsed !== null) setState((current) => current ?? parsed);
    });
    return () => {
      unTheme.then((fn) => fn());
      unState.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { text, tone } = headline(state);
  const title = state?.title ?? null;

  return (
    <div className="pet-bubble" data-tone={tone}>
      <div className="pet-bubble-head">
        <span className="pet-bubble-dot" aria-hidden="true" />
        <span className="pet-bubble-state">{text}</span>
      </div>
      <div className="pet-bubble-session">
        {title === null || title === "" ? (
          <span className="pet-bubble-muted">还没有会话</span>
        ) : (
          title
        )}
      </div>
      <div className="pet-bubble-foot">
        <span>
          {state?.sessionId === null || state?.sessionId === undefined
            ? "在应用里开一个会话，它就会跟上"
            : `第 ${state.turn ?? "?"} 回合 · 点宠物关闭`}
        </span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Bubble />
  </React.StrictMode>,
);
