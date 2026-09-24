/**
 * The desktop pet — the always-present little companion that lives on the
 * desktop after the main window is closed.
 *
 * Phase one was just the pet itself: it renders, it blinks and breathes, it can
 * be dragged around, and it remembers where it was put. Phase two gives it a
 * face for what the current session is doing.
 *
 * Three decisions worth stating:
 *
 *  * **Dragging is done by the window manager**, not by tracking pointer
 *    position in the page. `startDragging()` hands the drag to the OS, which is
 *    what makes the window follow the cursor smoothly and what makes a drop on
 *    another monitor behave. Doing it in the page means fighting the compositor
 *    for every frame.
 *  * **The animation is CSS, not a sprite sheet or a renderer.** A pet that
 *    needs an asset pipeline before it can blink is a pet that never ships. The
 *    drawing is a few inline shapes; the motion is keyframes. Art can replace
 *    this later without changing anything around it.
 *  * **State arrives over a Tauri event, not a fetch.** The pet is a shell
 *    window and the DSH host is a different origin; the shell already knows where
 *    the host is, so it polls and re-emits. See `start_pet_state_watch`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

/**
 * What the host says the current session is doing.
 *
 * Mirrors the snapshot the `dsh-desktop-pet` host plugin publishes. It is parsed
 * from a JSON string rather than typed by the shell, so this is the only place
 * the shape is written down on this side.
 */
type Activity = "idle" | "thinking" | "tool" | "waiting" | "done" | "error";

interface SessionState {
  activity: Activity;
  sessionId: string | null;
  title: string | null;
  tool: string | null;
  turn: number | null;
  lastEnd: { kind: string | null; code: string | null; at: number } | null;
}

/**
 * The pet's face. `happy` is the poke reaction, not a session state — the two
 * are kept apart so a poke during a running turn does not erase the turn.
 */
type Mood = Activity | "happy";

/**
 * How long a poke reaction lasts before settling back to the session's mood.
 *
 * Short on purpose: the pet is meant to feel like it noticed you, not like it is
 * waiting for you to keep interacting.
 */
const POKE_MS = 1100;

/** Turn a state snapshot into the face the pet should be wearing. */
function moodOf(state: SessionState | null): Mood {
  if (state === null) return "idle";
  switch (state.activity) {
    case "thinking":
    case "tool":
    case "waiting":
    case "done":
    case "error":
      return state.activity;
    default:
      return "idle";
  }
}

function Pet() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [poking, setPoking] = useState(false);
  /** True while a drag is hovering the pet, so it can say it noticed. */
  const [dragOver, setDragOver] = useState(false);
  /** How many files are waiting to be sent, shown as a badge. */
  const [queued, setQueued] = useState(0);
  /**
   * A turn that ended while the main window was hidden.
   *
   * Held until the user opens the bubble. The point of it is to be noticed, and
   * something that faded on its own after a few seconds is precisely what someone
   * who stepped away would come back and miss.
   */
  const [missed, setMissed] = useState<{ kind: string; title: string } | null>(null);
  // The blink timer is cleared on unmount, and the reaction's timer is too — a
  // transparent always-on-top window that keeps waking up to flip a class is a
  // battery cost for no visible benefit.
  const reaction = useRef<number | null>(null);
  /** When the bubble was last toggled from here, for the double-click guard. */
  const lastBubble = useRef(0);
  /**
   * Whether a `pet-queue` event has already been seen.
   *
   * The mount-time read of the queue and the event stream race: if a drop lands
   * while the read is in flight, the read's older answer arrives second and
   * overwrites the newer one, so the badge shows a count that is already wrong.
   * Once an event has been seen, the event is the only source — it is strictly
   * newer than anything a read started earlier can return.
   */
  const queueFromEvent = useRef(false);

  const mood: Mood = poking ? "happy" : moodOf(session);

  useEffect(() => {
    // This window is built at startup with the rest of the shell, possibly
    // before the DSH page has reported a theme, so it asks for the last
    // snapshot rather than waiting for a change that may never come.
    void fetchTheme();
    const unTheme = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    // The shell sends the state as a JSON string so it does not have to keep a
    // second copy of the shape in Rust. A malformed payload is ignored rather
    // than thrown: a pet stuck on its last expression beats a blank window.
    const unState = listen<string>("pet-state", (event) => {
      try {
        const parsed = JSON.parse(event.payload) as SessionState;
        if (parsed !== null && typeof parsed === "object" && typeof parsed.activity === "string") {
          setSession(parsed);
        }
      } catch {
        // Ignore: the next tick will send a fresh snapshot.
      }
    });
    const unDrag = listen<boolean>("pet-drag", (event) => {
      setDragOver(event.payload === true);
    });
    const unQueue = listen<string>("pet-queue", (event) => {
      try {
        const parsed = JSON.parse(event.payload) as { count?: number };
        queueFromEvent.current = true;
        setQueued(typeof parsed?.count === "number" ? parsed.count : 0);
      } catch {
        // Ignore: the badge keeps its last value.
      }
    });
    const unNotify = listen<string>("pet-notify", (event) => {
      try {
        const parsed = JSON.parse(event.payload) as { kind?: string; title?: string };
        setMissed({
          kind: typeof parsed?.kind === "string" ? parsed.kind : "completed",
          title: typeof parsed?.title === "string" ? parsed.title : "",
        });
      } catch {
        // Ignore: a malformed notice is not worth a broken window.
      }
    });
    // Read the queue once, in case files were dropped before this page loaded.
    // Skipped if an event has already arrived, for the reason on `queueFromEvent`.
    void invoke<string>("pet_queue")
      .then((raw) => {
        if (queueFromEvent.current) return;
        const parsed = JSON.parse(raw) as { count?: number };
        setQueued(typeof parsed?.count === "number" ? parsed.count : 0);
      })
      .catch(() => {});
    return () => {
      unTheme.then((fn) => fn());
      unState.then((fn) => fn());
      unDrag.then((fn) => fn());
      unQueue.then((fn) => fn());
      unNotify.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    // Belt and braces. Tauri intercepts drops at the window level and reports
    // them in Rust, so the page should never see one — but the browser's default
    // for a dropped file is to *navigate to it*, which would replace the pet with
    // a text file and leave no way back. Preventing it costs nothing and removes
    // that failure mode entirely.
    const stop = (event: DragEvent) => {
      event.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (reaction.current !== null) window.clearTimeout(reaction.current);
    };
  }, []);

  const poke = useCallback(() => {
    setPoking(true);
    if (reaction.current !== null) window.clearTimeout(reaction.current);
    reaction.current = window.setTimeout(() => setPoking(false), POKE_MS);
  }, []);

  const menu = useCallback(() => {
    void invoke("show_pet_menu");
  }, []);

  const bubble = useCallback(() => {
    // A double-click is one gesture, not "open then close". `show_pet_bubble`
    // toggles, so without this the second click of a double-click hides the
    // bubble the first click opened — and clears the missed badge unseen. Ignore
    // a second trigger inside the OS double-click window.
    const now = Date.now();
    if (now - lastBubble.current < 400) return;
    lastBubble.current = now;
    // Opening the bubble is what the badge is asking for, so it clears here —
    // that is the only thing that should clear it.
    setMissed(null);
    void invoke("show_pet_bubble");
  }, []);

  /**
   * Drag the window with the OS, or treat it as a click.
   *
   * The drag is **not** started on mouse-down. `startDragging()` enters the
   * window manager's modal move loop, which captures the mouse to the top-level
   * window until the button comes up — and that release ends the loop without
   * ever being routed to this webview. So a drag started on mouse-down swallows
   * the `mouseup` that would have ended it, and anything waiting on that event
   * never runs.
   *
   * That is not theoretical: opening the bubble used to hang off exactly that
   * `mouseup`, so clicking the pet did nothing at all, and every test that
   * appeared to prove otherwise was invoking the command directly instead of
   * clicking.
   *
   * Waiting for the pointer to actually move fixes it at the source: a plain
   * click never enters the OS loop, so its `mouseup` arrives normally.
   */
  const startDrag = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;

    // The listeners are torn down by whichever path wins, so a press cannot
    // leave one behind — the previous version removed itself only from inside
    // itself, which leaked one per lost mouseup.
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    function onMove(move: PointerEvent) {
      if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
      // Past the threshold: this is a drag, and from here the OS owns the
      // pointer. Nothing below needs the mouseup.
      stop();
      // On Windows this resolves when the OS drag loop ends, which is the first
      // moment the final position is known. The shell also saves once the window
      // stops moving, so this is only about landing it sooner — if the promise
      // resolves early instead, that path still stores the right value.
      void getCurrentWindow()
        .startDragging()
        .then(() => invoke("pet_save_position"))
        .catch(() => {});
    }

    function onUp() {
      stop();
      poke();
      bubble();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [poke, bubble]);

  /**
   * A short, human description of what the pet is showing.
   *
   * Kept beside the mood rather than derived from it, because the two are not
   * the same question: the face says "busy", the label says "running a command".
   */
  const label = useMemo(() => describe(session), [session]);

  return (
    <div
      className="pet-root"
      data-mood={mood}
      data-drag={dragOver ? "over" : "off"}
      data-missed={missed === null ? "no" : missed.kind === "error" ? "error" : "yes"}
    >
      {/* The whole body is the drag handle and the poke target. */}
      <div
        className="pet-body"
        role="button"
        tabIndex={0}
        aria-label={`桌面宠物。${label}${queued > 0 ? `有 ${queued} 个文件待发送。` : ""}拖动可移动，点击查看详情，右键打开菜单，可以把文件拖到它身上`}
        title={label}
        onMouseDown={startDrag}
        onContextMenu={(event) => {
          event.preventDefault();
          menu();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            poke();
            bubble();
          }
        }}
      >
        <div className="pet-shadow" aria-hidden="true" />
        {/* A ring that only exists while a drag is overhead: a 132px target has
            to acknowledge the gesture or it feels like aiming at nothing. */}
        <div className="pet-drop-ring" aria-hidden="true" />
        <div className="pet-figure" aria-hidden="true">
          <div className="pet-ear pet-ear-left" />
          <div className="pet-ear pet-ear-right" />
          <div className="pet-head">
            <div className="pet-eye pet-eye-left" />
            <div className="pet-eye pet-eye-right" />
            <div className="pet-cheek pet-cheek-left" />
            <div className="pet-cheek pet-cheek-right" />
            <div className="pet-mouth" />
            {/* A small "working" mark, shown only while the pet is busy. It lives
                inside the head so it moves with the breathing. */}
            <div className="pet-busy" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="pet-belly" />
        </div>
        {/* A sparkle that only exists during the reaction, so nothing has to be
            animated while the pet is idle. */}
        <div className="pet-sparkle" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        {/* How many files are waiting. Only rendered when there are any, so the
            pet is unchanged for someone who never drops one. */}
        {queued > 0 && (
          <div className="pet-queue-badge" title={`${queued} 个文件待发送`}>
            {queued}
          </div>
        )}
        {/* A mark for a turn that ended while the main window was hidden. It sits
            at the opposite corner from the file badge so the two never collide. */}
        {missed !== null && (
          <div
            className="pet-missed-badge"
            title={missed.title === "" ? "刚才那个回合结束了" : missed.title}
          >
            {missed.kind === "error" ? "!" : "•"}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One line describing the current state, for the tooltip and screen readers.
 * @param state - the latest snapshot, or null before the first one arrives.
 * @returns a short description.
 */
function describe(state: SessionState | null): string {
  if (state === null) return "还不知道会话状态。";
  switch (state.activity) {
    case "thinking":
      return "正在思考。";
    case "tool":
      return state.tool === null ? "正在执行工具。" : `正在执行 ${state.tool}。`;
    case "waiting":
      return "等待你批准。";
    case "done":
      return "刚才那个回合完成了。";
    case "error":
      return state.lastEnd?.code === null || state.lastEnd?.code === undefined
        ? "刚才那个回合出错了。"
        : `刚才那个回合出错了（${state.lastEnd.code}）。`;
    default:
      return state.title === null ? "空闲中。" : `空闲中：${state.title}`;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Pet />
  </React.StrictMode>,
);
