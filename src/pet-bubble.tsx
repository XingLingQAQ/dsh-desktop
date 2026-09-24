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
 *
 * The card is 268×156 and does not scroll as a whole, so the two controls on top
 * of the readout — a session picker and a one-line composer — are sized to that
 * budget rather than to what a chat client would give them. The arithmetic is
 * written down in the `.pet-bubble` section of styles.css; the short version is
 * that the picker's list is the only thing that scrolls, and it scrolls inside
 * the card.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
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

/** One row of the picker's list. Mirrors an entry of `pet_sessions`. */
interface SessionEntry {
  id: string;
  title: string | null;
  activity: Activity;
  live: boolean;
  updatedAt: number;
}

/** What `pet_sessions` answers with. */
interface SessionList {
  current: string | null;
  sessions: SessionEntry[];
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
 * Parse the picker's list, or return null if it is not one.
 *
 * A row without a usable id is dropped rather than rendered: it would be a
 * button with nothing to say and `undefined` to send. Everything else is taken
 * as it comes — this side does not get to decide which sessions the host is
 * willing to talk about, and it must not invent a title for one.
 */
function parseList(raw: string | null | undefined): SessionList | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as SessionList;
    if (value === null || typeof value !== "object" || !Array.isArray(value.sessions)) return null;
    const sessions = value.sessions.filter(
      (entry): entry is SessionEntry =>
        entry !== null && typeof entry === "object" && typeof entry.id === "string",
    );
    return { current: typeof value.current === "string" ? value.current : null, sessions };
  } catch {
    // Fall through: no list is a card without a picker, which still works.
  }
  return null;
}

/**
 * The answer to a send: delivered, or refused with a reason.
 *
 * `pet_send_prompt` reports failure *in band* — a JSON string, not a rejected
 * promise — so a refusal has to be dug out here. The rule is that anything not
 * recognisably `{ok:true}` is a failure carrying its own text: a refusal the
 * user can read is the whole point ("session … is already owned by an active
 * write handle" says what to do; "发送失败" says nothing), and an answer this
 * side cannot parse is shown raw rather than turned into a silent no-op.
 */
type SendOutcome = { ok: true } | { ok: false; message: string };

function parseSendResult(raw: string | null | undefined): SendOutcome {
  try {
    const value = JSON.parse(raw ?? "") as { ok?: unknown; error?: { message?: unknown } };
    if (value !== null && typeof value === "object" && value.ok === true) return { ok: true };
    const message = value?.error?.message;
    if (typeof message === "string" && message !== "") return { ok: false, message };
  } catch {
    // Fall through: not JSON at all, so the raw text is the message.
  }
  const text = raw === null || raw === undefined || raw === "" ? "发送失败" : String(raw);
  return { ok: false, message: text };
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
  const [sessions, setSessions] = useState<SessionList | null>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // One line for whatever just went wrong, whether a prompt was refused or a
  // switch was: the card has room for one, and the newest failure is the one
  // worth reading.
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  /**
   * Re-read the picker's list.
   *
   * Failure is swallowed on purpose. The picker is an addition to a card that
   * already works from `pet-state` alone: a shell without the command, or a host
   * that is not up yet, must leave the title and the composer as they were
   * rather than blanking the bubble.
   */
  const loadSessions = useCallback(async () => {
    try {
      const parsed = parseList(await invoke<string>("pet_sessions"));
      if (parsed !== null) setSessions(parsed);
    } catch {
      /* no list available — the card carries on without a picker */
    }
  }, []);

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

  // The host can move the current session on its own — someone switching
  // conversations in the main window — and the picker would keep pointing at the
  // old one until it was reopened. `pet-state` carries the host's idea of
  // "current", so a change there is the cue to re-read the list. This also does
  // the mount read, since the first run has no session yet.
  const stateSessionId = state?.sessionId ?? null;
  useEffect(() => {
    void loadSessions();
  }, [loadSessions, stateSessionId]);

  // A menu closes on the same gestures as a native one: Escape, or a click
  // anywhere outside — including the trigger itself, which toggles.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (picker.current !== null && !picker.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Open on the row that is already current. With more sessions than the list
  // can show, the default position is the top, and "which one am I on" is the
  // first thing this list is opened to answer. `nearest` is instant — there is
  // no scrolling animation here to reduce.
  useEffect(() => {
    if (!open) return;
    const row = list.current?.querySelector('[aria-selected="true"]');
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [open]);

  /**
   * Escape unwinds one layer at a time, and the order is the whole decision:
   * the open list first, then the typed text, and only then the window.
   *
   * Hiding the bubble is not destructive — the window is hidden, not unmounted,
   * so a draft survives it — but clearing text under someone mid-sentence is.
   * So the draft gets the first press: Escape in a text field means "never mind
   * what I was typing" everywhere else, and that reading costs nothing here
   * because the next press still closes the bubble.
   *
   * Nothing fires during an IME composition. This app is read in Chinese, and
   * the Escape that dismisses a candidate window would otherwise also hide the
   * window out from under the person still picking characters.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      if (open) {
        setOpen(false);
        return;
      }
      if (draft !== "" && !sending) {
        setDraft("");
        return;
      }
      void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, open, sending]);

  // The picker's answer is authoritative once it exists — it is what the user
  // just chose. `pet-state` is the fallback rather than the other way round, so
  // a picker that reports no current session cannot disable a composer that the
  // event says is perfectly usable.
  const currentId = sessions?.current ?? stateSessionId;
  const current = sessions?.sessions.find((entry) => entry.id === currentId) ?? null;
  const title = current?.title ?? state?.title ?? null;
  // A dropdown over one item is noise, and over none it is a dead control.
  const pickable = sessions !== null && sessions.sessions.length > 1;
  // The turn count belongs to whatever `pet-state` is describing, which is the
  // host's current session — not necessarily the one just picked. Rather than
  // print one session's turn under another session's title, say nothing.
  const turn = state !== null && state.sessionId === currentId ? state.turn : null;

  const pick = useCallback(
    async (id: string) => {
      setOpen(false);
      if (id === currentId) return;
      setPicking(true);
      setNotice(null);
      try {
        const next = await invoke<string | null>("pet_select_session", { sessionId: id });
        // Take the returned id straight away so the title answers the click,
        // then re-read the list: the host owns the order and the titles, and a
        // list that disagrees with the title above it is worse than a slow one.
        setSessions((prev) => (prev === null ? prev : { ...prev, current: next }));
        await loadSessions();
      } catch (error) {
        setNotice(String(error));
      } finally {
        setPicking(false);
      }
    },
    [currentId, loadSessions],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === "" || sending || currentId === null) return;
    setSending(true);
    setNotice(null);
    try {
      const outcome = parseSendResult(
        await invoke<string>("pet_send_prompt", { sessionId: currentId, text }),
      );
      if (outcome.ok) {
        // Only a delivered prompt clears the box. A refusal the user can read is
        // a refusal they can act on, and acting on it needs the text still there.
        setDraft("");
      } else {
        setNotice(outcome.message);
      }
    } catch (error) {
      // The command itself failed — no such command, or the IPC dropped. Same
      // slot, same rule: say what happened.
      setNotice(String(error));
    } finally {
      setSending(false);
    }
  }, [currentId, draft, sending]);

  const { text, tone } = headline(state);
  const titleNode =
    title === null || title === "" ? <span className="pet-bubble-muted">还没有会话</span> : title;
  const foot =
    notice ??
    (currentId === null
      ? "在应用里开一个会话，它就会跟上"
      : `第 ${turn ?? "?"} 回合 · 点宠物关闭`);

  return (
    <div className="pet-bubble" data-tone={tone}>
      <div className="pet-bubble-head">
        <span className="pet-bubble-dot" aria-hidden="true" />
        <span className="pet-bubble-state">{text}</span>
      </div>

      {/* The title is the picker's trigger when there is a choice to make and
          plain text when there is not, so the card looks the same either way. */}
      <div className="pet-bubble-picker" ref={picker}>
        {pickable ? (
          <button
            type="button"
            className="pet-bubble-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-busy={picking}
            disabled={picking}
            title="切换会话"
            onClick={() => setOpen((was) => !was)}
          >
            <span className="pet-bubble-session">{titleNode}</span>
            <svg className="pet-bubble-caret" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 5 L6 8 L9 5" fill="none" stroke="currentColor" />
            </svg>
          </button>
        ) : (
          <div className="pet-bubble-session">{titleNode}</div>
        )}

        {open && sessions !== null && (
          <div className="pet-bubble-list" role="listbox" aria-label="选择会话" ref={list}>
            {/* The current session stays in the list with a check on it: the
                trigger already names it, but a list that cannot show which row
                is selected is a list you have to guess your way out of. */}
            {sessions.sessions.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={entry.id === currentId}
                className="pet-bubble-item"
                data-dormant={entry.live === false ? "yes" : undefined}
                onClick={() => void pick(entry.id)}
              >
                <span
                  className="pet-bubble-itemDot"
                  data-activity={entry.activity}
                  aria-hidden="true"
                />
                <span className="pet-bubble-itemLabel">
                  {entry.title === null || entry.title === "" ? "未命名会话" : entry.title}
                </span>
                {entry.id === currentId && (
                  <svg className="pet-bubble-check" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M2.5 6.4 L5 8.8 L9.5 3.6" fill="none" stroke="currentColor" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* A form rather than a bare input, so Enter is the platform's own
          submit and not a key this code has to recognise. */}
      <form
        className="pet-bubble-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="pet-bubble-input"
          type="text"
          value={draft}
          // The placeholder carries the reason the composer is off: at this size
          // it is the only line of explanation that fits inside the field.
          placeholder={currentId === null ? "没有可以发送的会话" : "发一句话…"}
          disabled={currentId === null}
          // Read-only, not disabled, while a prompt is in flight: a disabled
          // field cannot hold focus, so the caret would be dropped by the very
          // act of sending and the next sentence would start with a click. The
          // send button is the control that goes dead and shows the spinner.
          readOnly={sending}
          aria-label="给当前会话发一句话"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter commits an IME candidate, not a message. Chromium normally
            // suppresses the implicit submit while composing, but sending half a
            // word is bad enough to be worth not relying on that.
            if (event.nativeEvent.isComposing) event.preventDefault();
          }}
        />
        <button
          type="submit"
          className="pet-bubble-send"
          disabled={currentId === null || sending || draft.trim() === ""}
          aria-label={sending ? "发送中" : "发送"}
          title="发送（回车）"
        >
          {sending ? (
            <span className="pet-bubble-spinner" aria-hidden="true" />
          ) : (
            <svg className="pet-bubble-sendIcon" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M6 9.6 V2.8 M3.2 5.4 L6 2.6 L8.8 5.4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </form>

      {/* `title` repeats the notice in full: the line is clamped to two rows
          because the card cannot grow, and a refusal the user cannot finish
          reading is a refusal they cannot act on. */}
      <div
        className="pet-bubble-foot"
        data-tone={notice === null ? undefined : "error"}
        title={notice ?? undefined}
      >
        {foot}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Bubble />
  </React.StrictMode>,
);
