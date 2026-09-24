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
 * The card does not scroll as a whole, so the controls on top of the readout — a
 * session picker, the file queue and a one-line composer — are sized to the
 * window's budget rather than to what a chat client would give them. The
 * arithmetic is written down in the `.pet-bubble` section of styles.css; the
 * short version is that the picker's list and the file queue are the only things
 * that scroll, and they scroll inside the card.
 *
 * Files dropped on the pet are queued by the shell and published on `pet-queue`
 * (plus one read of `pet_queue` on mount). This side only ever *shows* that
 * queue and hands the paths back on send: the queue belongs to the shell, so a
 * removal is a command and the next event is the answer.
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

/** One file the shell has queued for the next prompt. Mirrors an entry of `pet_queue`. */
interface QueuedFile {
  path: string;
  name: string;
  size: number;
  addedAt: number;
}

/** What `pet_queue` answers with, and what the `pet-queue` event carries. */
interface FileQueue {
  count: number;
  files: QueuedFile[];
}

/**
 * An empty queue, as one shared value.
 *
 * A fresh `[]` on every render would be a new identity on every render, which is
 * enough to make the send callback a new function each time it is read.
 */
const NO_FILES: QueuedFile[] = [];

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

/** The last segment of a path, whichever separator it uses. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1) || path;
}

/**
 * Parse the file queue, or return null if it is not one.
 *
 * A row without a path is dropped rather than rendered: the path is the one
 * field every command here needs — `pet_remove_file` takes one, and the send
 * takes a list of them — so a row that cannot be removed or sent is a row that
 * lies. A missing name falls back to the path's last segment, which is a
 * projection of the path rather than an invented title, and a nameless row is
 * unreadable.
 *
 * The `count` the shell sends is not carried through: `files` is what this side
 * renders and acts on, and a count that disagreed with the rows would be worse
 * than no count at all.
 */
function parseQueue(raw: string | null | undefined): FileQueue | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as { files?: unknown };
    if (value === null || typeof value !== "object" || !Array.isArray(value.files)) return null;
    const files: QueuedFile[] = [];
    for (const entry of value.files as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const { path, name, size, addedAt } = entry as Partial<QueuedFile>;
      if (typeof path !== "string" || path === "") continue;
      files.push({
        path,
        name: typeof name === "string" && name !== "" ? name : baseName(path),
        size: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0,
        addedAt: typeof addedAt === "number" ? addedAt : 0,
      });
    }
    return { count: files.length, files };
  } catch {
    // Fall through: no queue is a card without a file row, which still works.
  }
  return null;
}

/**
 * A size in the fewest characters that still say something.
 *
 * The row has roughly forty pixels for this, so it is "1.4 MB" and not
 * "1.40 MB": the second decimal is noise at a glance, and above ten units the
 * decimal goes entirely — "523 KB" reads faster than "523.4 KB", and precision
 * is not what this number is for.
 *
 * A size the shell could not read arrives as 0 and prints as nothing. That also
 * hides a genuinely empty file, which is the smaller of the two lies: "0 B" on a
 * file the shell could not stat is a number that means something it does not.
 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/**
 * How many "display units" of a filename the row can hold.
 *
 * The name gets what is left of the row after the size and the remove button:
 * about 150px of a fixed 268px card, which at 12px is around 26 average Latin
 * characters. 24 is deliberately a little under, because the font is
 * proportional — twenty-four W's are half again as wide as twenty-four i's — and
 * the row keeps `text-overflow: ellipsis` as the backstop for what still
 * overruns.
 */
const NAME_UNITS = 24;

/**
 * Whether a character is drawn about twice as wide as a Latin one.
 *
 * Counting characters instead of width would cut CJK filenames twice as hard as
 * Latin ones at the same length, and half the filenames on this machine are CJK.
 * The ranges are the wide ones that turn up in file names: CJK radicals and
 * punctuation, kana, CJK ideographs, Hangul, and full-width forms.
 */
const WIDE_CHAR =
  /[\u1100-\u115f\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/** How many display units a string takes. */
function units(text: string): number {
  let total = 0;
  for (const ch of text) total += WIDE_CHAR.test(ch) ? 2 : 1;
  return total;
}

/** The longest head or tail of `text` that fits in `budget` display units. */
function fit(text: string, budget: number, fromEnd: boolean): string {
  // Code points, not UTF-16 units: cutting an emoji in half leaves a replacement
  // character on screen, and filenames do carry them.
  const chars = Array.from(text);
  const order = fromEnd ? chars.slice().reverse() : chars;
  const picked: string[] = [];
  let used = 0;
  for (const ch of order) {
    const width = WIDE_CHAR.test(ch) ? 2 : 1;
    if (used + width > budget) break;
    used += width;
    picked.push(ch);
  }
  return (fromEnd ? picked.reverse() : picked).join("");
}

/**
 * A filename cut in the middle, with its extension kept.
 *
 * CSS cannot do this. `text-overflow` cuts the end, and the end is the half of a
 * filename people actually read — `.pdf`, `.png`, `-v3` — and the usual
 * `direction: rtl` trick reorders leading punctuation (`.env` comes out as
 * `env.`), which is worse than the problem it solves. So the cut is made here,
 * before the browser ever sees the string, at a single split point: the tail is
 * whatever fits from the end, which is where the extension lives, and the head
 * is what is left over from the front.
 *
 * Two independent budgets would look more even and would sometimes spend the
 * whole line on a name's opening words and drop the extension to do it, which is
 * exactly backwards.
 */
function shortName(name: string): string {
  if (units(name) <= NAME_UNITS) return name;
  const dot = name.lastIndexOf(".");
  // A leading dot is part of the name (`.env`) and a trailing one is not an
  // extension, so neither may be reserved for as if it were `.pdf`.
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  const ellipsis = 1;
  const extBudget = Math.min(units(ext), NAME_UNITS - ellipsis - 4);
  const tail = fit(name, Math.max(extBudget, Math.floor((NAME_UNITS - ellipsis) * 0.55)), true);
  // The head keeps at least four units even when the extension is absurd, so
  // what is left still reads as a name rather than as an ellipsis and a suffix.
  const head = fit(name, NAME_UNITS - ellipsis - units(tail), false).trimEnd();
  return `${head}…${tail}`;
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
  // The shell's queue, as last heard. Null means "not heard from yet", which is
  // rendered exactly like an empty queue — the card looked like that before the
  // queue existed, and it is the right look for a shell that has nothing staged.
  const [queue, setQueue] = useState<FileQueue | null>(null);
  // One flag for both queue mutations: they are the same kind of action (ask the
  // shell to change the queue, then wait for its event), and a second one
  // landing while the first is in flight has nothing to add.
  const [queueBusy, setQueueBusy] = useState(false);
  // One line for whatever just went wrong, whether a prompt was refused or a
  // switch was: the card has room for one, and the newest failure is the one
  // worth reading.
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  /**
   * The latest session list, for the `pet-state` listener.
   *
   * That listener is registered once, so reading `sessions` inside it would
   * capture whatever the list was when the effect ran — null, forever. It needs
   * to know whether a list has arrived yet, and this is that answer without
   * re-subscribing to the event on every list change.
   */
  const sessionsRef = useRef<SessionList | null>(null);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

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

  /**
   * Read the file queue the shell is holding.
   *
   * Same rule as the session list: a shell without the command, or one that is
   * not up yet, must leave the card as it was rather than blanking it. The
   * `pet-queue` event is the usual path — this is the mount read, so a card that
   * opens while files are already staged shows them on its first frame.
   */
  const loadQueue = useCallback(async () => {
    try {
      const parsed = parseQueue(await invoke<string>("pet_queue"));
      if (parsed !== null) setQueue(parsed);
    } catch {
      /* no queue available — the card carries on without a file row */
    }
  }, []);

  /**
   * Take one file out of the queue, or all of them.
   *
   * The count these commands answer with is deliberately dropped. It is a
   * checksum and not a list, and re-reading `pet_queue` here would race the
   * `pet-queue` event: a read that lands after a newer drop would resurrect the
   * removed file and hide the new one. The event is the answer, and the shell is
   * specified to emit it on every change.
   */
  const removeFile = useCallback(
    async (path: string) => {
      if (queueBusy) return;
      setQueueBusy(true);
      setNotice(null);
      try {
        await invoke<number>("pet_remove_file", { path });
      } catch (error) {
        setNotice(String(error));
      } finally {
        setQueueBusy(false);
      }
    },
    [queueBusy],
  );

  const clearFiles = useCallback(async () => {
    if (queueBusy) return;
    setQueueBusy(true);
    setNotice(null);
    try {
      await invoke<number>("pet_clear_files");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setQueueBusy(false);
    }
  }, [queueBusy]);

  useEffect(() => {
    void fetchTheme();
    const unTheme = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    const unState = listen<string>("pet-state", (event) => {
      const parsed = parse(event.payload);
      if (parsed !== null) {
        setState(parsed);
        // The host just answered for the first time — if we still have no
        // session list (the mount read failed before the host was up), get it
        // now rather than waiting for a sessionId change that may never come.
        if (sessionsRef.current === null) void loadSessions();
      }
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
    // `loadSessions` is stable (it reads nothing but `invoke`), so this
    // re-subscribes in name only.
  }, [loadSessions]);

  // The queue has its own channel. The shell emits `pet-queue` on every change —
  // a drop, a removal, a clear, a send — so this side never has to guess what a
  // command did, and never has to poll for a queue that is usually empty.
  useEffect(() => {
    const unQueue = listen<string>("pet-queue", (event) => {
      const parsed = parseQueue(event.payload);
      if (parsed !== null) setQueue(parsed);
    });
    void loadQueue();
    return () => {
      unQueue.then((fn) => fn());
    };
  }, [loadQueue]);

  // The host can move the current session on its own — someone switching
  // conversations in the main window — and the picker would keep pointing at the
  // old one until it was reopened. `pet-state` carries the host's idea of
  // "current", so a change there is the cue to re-read the list. This also does
  // the mount read, since the first run has no session yet.
  const stateSessionId = state?.sessionId ?? null;
  useEffect(() => {
    void loadSessions();
  }, [loadSessions, stateSessionId]);

  // The bubble window is built at startup and only shown later, so the mount
  // read of the session list can land before the host is up — and `/state`
  // reports a null session until something happens, so the sessionId-change
  // retry never fires either. Re-read whenever the window is shown again; a
  // hidden Tauri window fires `visibilitychange` when it comes back.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void loadSessions();
        void loadQueue();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadSessions, loadQueue]);

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
  // A dropdown over one item is still the only way to pick that item — the pet
  // can be pointed at any session on disk, not just the one the host is already
  // on — so one row is a picker; none is a dead control.
  const pickable = sessions !== null && sessions.sessions.length >= 1;
  // The turn count belongs to whatever `pet-state` is describing, which is the
  // host's current session — not necessarily the one just picked. Rather than
  // print one session's turn under another session's title, say nothing.
  const turn = state !== null && state.sessionId === currentId ? state.turn : null;
  // A queue that has not arrived yet renders as no queue at all: the card is
  // then byte for byte the card it was before files existed.
  const files = queue?.files ?? NO_FILES;
  // Sizes the shell could not read are 0, and a total that counted them would be
  // a number with no meaning, so they are summed as nothing and the size is left
  // off the summary entirely when there is nothing to sum.
  const bytes = files.reduce((sum, file) => sum + file.size, 0);

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
    // Paths are read here rather than kept in a derived array: `queue` only
    // changes when the shell says so, so this callback keeps its identity
    // between events instead of being rebuilt on every render.
    const paths = (queue?.files ?? NO_FILES).map((file) => file.path);
    // A file with no message is a legitimate send, so an empty box is only a
    // reason to refuse when there is nothing queued either.
    if ((text === "" && paths.length === 0) || sending || currentId === null) return;
    setSending(true);
    setNotice(null);
    try {
      const outcome = parseSendResult(
        await invoke<string>("pet_send_prompt", {
          sessionId: currentId,
          text,
          // An empty queue sends exactly today's payload. The shell is specified
          // to treat `[]` the same way, but there is nothing to gain from
          // exercising that path and something to lose if it is not honoured.
          ...(paths.length === 0 ? {} : { files: paths }),
        }),
      );
      if (outcome.ok) {
        // Only a delivered prompt clears the box. A refusal the user can read is
        // a refusal they can act on, and acting on it needs the text still there.
        setDraft("");
        // The queue is not cleared here. The shell clears its own queue on a
        // delivered prompt and emits `pet-queue`; doing it here as well would
        // race that event and would paper over a shell that forgot to clear.
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
  }, [currentId, draft, queue, sending]);

  const { text, tone } = headline(state);
  const titleNode =
    title === null || title === "" ? <span className="pet-bubble-muted">还没有会话</span> : title;
  // The foot is one line with two jobs, and a staged queue takes it: what the
  // next send will carry is worth more than the turn counter, and it is the only
  // place the count and the total stay visible once the rows scroll. A refusal
  // still wins the line — it is the newest thing that happened and the only
  // thing on the card that asks for an action.
  const queueLine = `${files.length} 个文件${bytes > 0 ? ` · ${formatSize(bytes)}` : ""}`;
  const foot =
    notice ??
    (files.length > 0
      ? queueLine
      : currentId === null
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

      {/* The queue the shell is holding, in the shell's own order. Nothing is
          rendered when it is empty: a row saying "no files" is noise, and it
          would make the card taller for a queue that is empty most of the time.
          It sits above the composer because that is what it is — the rest of
          what the send button will send. */}
      {files.length > 0 && (
        <div
          className="pet-bubble-files"
          // No session is no reason to hide or lock the queue — removing a file
          // is a local action that needs nothing from the host — but it is a
          // reason for the payload to read as parked, which is the same
          // "dormant, not gone" signal the picker gives a session it cannot
          // write to.
          data-idle={currentId === null ? "yes" : undefined}
          role="list"
          aria-label={`待发送的文件，共 ${files.length} 个`}
        >
          {files.map((file, index) => (
            <div
              className="pet-bubble-file"
              role="listitem"
              // The shell owns the queue and may legitimately hold one path
              // twice (the same file dropped twice), so the position is part of
              // the key: it keeps the key unique without this side deciding
              // which of two identical rows is the real one.
              key={`${index}:${file.path}`}
              title={file.size > 0 ? `${file.path}\n${formatSize(file.size)}` : file.path}
            >
              <span className="pet-bubble-fileName">{shortName(file.name)}</span>
              <span className="pet-bubble-fileSize">{formatSize(file.size)}</span>
              <button
                type="button"
                className="pet-bubble-fileX"
                aria-label={`移除 ${file.name}`}
                title="从队列里移除"
                // The queue is read-only while it is being handed to the host:
                // a removal during a send would be undone by the shell clearing
                // the queue it just consumed, and a control that appears to work
                // and then un-works is worse than one that waits.
                disabled={queueBusy || sending}
                onClick={() => void removeFile(file.path)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3.6 3.6 L8.4 8.4 M8.4 3.6 L3.6 8.4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

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
          // An empty box is only a dead send when there is nothing queued to
          // carry either — a file with no message is a legitimate thing to send.
          disabled={currentId === null || sending || (draft.trim() === "" && files.length === 0)}
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
          because the card's height is a budget, and a refusal the user cannot
          finish reading is a refusal they cannot act on. */}
      <div className="pet-bubble-foot" data-tone={notice === null ? undefined : "error"}>
        {/* The clamp lives on an inner element rather than on the flex row itself:
            `-webkit-line-clamp` only works on `display: -webkit-box`, and that
            legacy box does not survive being a flex item in every engine. */}
        <div className="pet-bubble-footClip">
          <span className="pet-bubble-footText" title={notice ?? undefined}>
            {foot}
          </span>
        </div>
        {/* Emptying the queue is the one file action that needs no row named, so
            it lives on the status line rather than on a row. It stays live while
            a refusal is showing: a queue you cannot empty is worse than one you
            cannot see. */}
        {files.length > 0 && (
          <button
            type="button"
            className="pet-bubble-clear"
            title="清空文件队列"
            aria-label={`清空 ${files.length} 个文件`}
            disabled={queueBusy || sending}
            onClick={() => void clearFiles()}
          >
            清空
          </button>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Bubble />
  </React.StrictMode>,
);
