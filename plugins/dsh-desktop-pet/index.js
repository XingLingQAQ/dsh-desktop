/**
 * The pet's window into what the current session is doing.
 *
 * The pet lives on the desktop, so it cannot read session state from the DSH
 * page — that page is gone whenever the main window is closed, which is exactly
 * when the pet matters. So the state is derived here, in the host process, where
 * the sessions actually live, and published on a route the shell polls.
 *
 * Why not the client side: `ctx.on('session/event', …)` is a host event. The
 * desktop's client plugins can only see what the DSH page exposes, and the page
 * is not part of the pet's lifetime.
 *
 * ## What it reports, and the one thing it must not get wrong
 *
 * `turn/end` says a turn ended — **not** that it succeeded. The reason kinds are
 * `completed | aborted | blocked | error | max-tokens | interrupted`, and mapping
 * every non-blocked end to "done" (which is what the whale-girl plugin does)
 * would have the pet celebrating a failed turn. Measured on this machine, a turn
 * that could not reach the model ends with `reason.kind === 'error'` and
 * `reason.error.code === 'SERVER'`, so the distinction is not hypothetical.
 *
 * ## Which session it reports on
 *
 * Whichever one moved most recently. A listener registered from a plain plugin
 * context is untagged and therefore receives *every* session's events, so the
 * plugin has to pick one to be "the" session — and "the one you were just using"
 * is the only answer that matches what a person expects from a desktop pet.
 *
 * ## The other two routes
 *
 * `/sessions` and `/prompt` exist because the pet is also the way back into DSH
 * once the main window is closed: the desktop is then the only surface left, so
 * it has to be able to say which sessions exist and to put a message into one.
 * Both read the same event-derived state as `/state` — the picker shows the
 * activity the pet's face is showing rather than a second opinion about it.
 *
 * `/prompt` also carries files, and that path is not what it looks like: a
 * prompt cannot name a local path. The only file part the prompt contract takes
 * is an upload receipt, so a path is streamed through the host's file-upload
 * service first and the receipt is what the message cites. See {@link uploadPart}.
 */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

export const name = 'dsh-desktop-pet'

/** The web server hosts the route the shell polls. */
export const inject = ['webServer']

const PREFIX = '/dsh-desktop-pet'

/** How long a finished turn stays on screen before the pet settles to idle. */
const DONE_LINGER_MS = 6_000

/** How long an error stays before the pet settles. Errors are worth noticing. */
const ERROR_LINGER_MS = 15_000

/**
 * How long one corpus listing is reused.
 *
 * `sessionQuery.listSessions()` reaches persistence as well as memory, and this
 * plugin is polled on a timer, so the listing is cached rather than re-derived
 * per request. Short enough that a session created in the UI appears in the
 * picker while the user is still looking at it.
 */
const CORPUS_TTL_MS = 3_000

/**
 * How many sessions the picker is offered.
 *
 * This is a short menu, not a history browser: past this many the list stops
 * being scannable, and the shell would be carrying titles and activity for
 * sessions nobody is about to pick.
 */
const MAX_SESSIONS = 30

/**
 * Ceiling on a request body, matching the other desktop plugin routes.
 * A prompt is text; anything approaching this is a caller mistake.
 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * How many files one prompt may carry.
 *
 * A desktop bubble is a one-line composer, not a batch tool. Each file costs a
 * durable store write, a staged receipt on the session, and a handle line in
 * the message the model reads, so a large selection is both a different kind of
 * action than "attach this" and a way to spend a session's context on handles.
 * Ten is past the point where a selection still reads as deliberate.
 */
const MAX_PROMPT_FILES = 10

/**
 * Activity values the pet can be in.
 *
 * A closed set, because the pet's face is drawn from it and an unknown value
 * would have to be guessed at on the other side.
 */
const ACTIVITY = {
  idle: 'idle',
  thinking: 'thinking',
  tool: 'tool',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
}

/**
 * Map a `turn/end` reason onto an activity.
 *
 * The whole point of this function is that `turn/end` is not success. Anything
 * unrecognised is treated as `done` rather than `error`, so a reason added by a
 * future version shows as a normal finish instead of a spurious failure.
 * @param {unknown} reason - `event.data.reason` from the turn/end event.
 * @returns {{ activity: string, code: string | null }} the mapped activity.
 */
function activityForTurnEnd(reason) {
  const kind = typeof reason === 'object' && reason !== null ? reason.kind : null
  if (kind === 'error') {
    const error = typeof reason === 'object' && reason !== null ? reason.error : null
    const code = typeof error === 'object' && error !== null && typeof error.code === 'string'
      ? error.code
      : null
    return { activity: ACTIVITY.error, code }
  }
  // `blocked` (a hook vetoed the step, and the turn has already ended) and
  // `aborted` / `interrupted` / `max-tokens` all end the turn without a model
  // error, so they read as done. The real "waiting for you" is `approval/asked`.
  return { activity: ACTIVITY.done, code: null }
}

/**
 * Wire the state route onto this plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  /** The session the pet is currently reporting on. */
  let current = null
  /**
   * A session the user picked in the bubble, if any.
   *
   * Following whichever session moved last is right by default and wrong the
   * moment someone deliberately points the pet at one, so an explicit pick
   * outranks it. The pin is dropped when a *different* session starts a turn:
   * working somewhere else is the clearest possible signal that the pet should
   * follow, and without this the pet would sit on a stale choice while the user
   * has visibly moved on.
   */
  let pinned = null
  /** sessionId → { title, activity, tool, turn, lastEnd, movedAt } */
  const sessions = new Map()
  /**
   * How many `session/event`s have arrived since load.
   *
   * Reported in the snapshot because "the pet is not reacting" and "the pet is
   * not being told anything" look identical from the outside, and this is the
   * cheapest way to tell them apart. A count that stays at zero while a turn is
   * running means the subscription is the problem, not the mapping.
   */
  let eventCount = 0
  /**
   * The title service, or null when this host has none.
   *
   * `ctx.get` returns `undefined` for a service the context cannot reach in some
   * compositions, so it is normalised here rather than guessed at every use.
   */
  let titleService = null
  try {
    titleService = ctx.get('sessionTitle') ?? null
  } catch {
    titleService = null
  }
  /**
   * The cached session corpus, and the read in flight for the next one.
   *
   * Kept per plugin instance rather than at module scope so that two mounts
   * cannot serve each other's sessions.
   */
  const corpus = { at: 0, records: null, inFlight: null }

  /**
   * The view for one session, created on first mention.
   * @param {string} id - the session id.
   * @returns {object} the mutable view.
   */
  const viewFor = (id) => {
    let view = sessions.get(id)
    if (view === undefined) {
      view = { id, title: null, activity: ACTIVITY.idle, tool: null, turn: null, lastEnd: null, movedAt: 0 }
      sessions.set(id, view)
    }
    return view
  }

  /**
   * The best title available for a session.
   *
   * The event log is preferred because it is what the session itself recorded;
   * the title service is the fallback for a session whose title event predates
   * this plugin's subscription.
   * @param {object} session - the session from the event callback.
   * @returns {string | null} the title, or null.
   */
  const titleOf = (session) => {
    if (!titleService) return null
    try {
      const snapshot = titleService.get?.(session)
      return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : null
    } catch {
      return null
    }
  }

  ctx.on('session/event', (session, event) => {
    eventCount += 1
    const id = typeof session?.id === 'string' ? session.id : null
    if (id === null) return
    const isSubagent = session?.header?.origin === 'subagent'
    const view = viewFor(id)
    const type = typeof event?.type === 'string' ? event.type : null
    view.movedAt = Date.now()

    if (type === 'turn/start') {
      view.activity = ACTIVITY.thinking
      view.tool = null
      view.turn = typeof event?.data?.turn === 'number' ? event.data.turn : view.turn
      view.lastEnd = null
      // A turn starting somewhere else means the user moved on, so the pet
      // follows. Without this an explicit pick would stick even after they had
      // visibly gone to work in another conversation. A subagent is not the
      // user moving: it is work the pinned session started.
      if (!isSubagent && pinned !== null && pinned !== id) pinned = null
    } else if (type === 'tool/call') {
      const name = typeof event?.data?.name === 'string' ? event.data.name : null
      view.activity = ACTIVITY.tool
      view.tool = name
    } else if (type === 'tool/result') {
      // The tool returned; the agent is processing again. Without this the pet
      // stays "running <tool>" through the entire answer that follows.
      view.activity = ACTIVITY.thinking
      view.tool = null
    } else if (type === 'turn/end') {
      const mapped = activityForTurnEnd(event?.data?.reason)
      view.activity = mapped.activity
      view.tool = null
      view.lastEnd = {
        kind: typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : null,
        code: mapped.code,
        at: Date.now(),
      }
    } else if (type === 'approval/asked') {
      // The real "waiting for you", mid-turn — unlike `blocked`, which is a turn
      // that has already ended. A tool needs the user's decision before it runs.
      view.activity = ACTIVITY.waiting
      view.tool = typeof event?.data?.toolName === 'string' ? event.data.toolName : view.tool
    } else if (type === 'approval/decided') {
      // Decision made; the turn resumes. The next tool/call or turn/end sets the
      // precise activity — thinking is the honest interim.
      view.activity = ACTIVITY.thinking
    } else if (type === 'session/title') {
      const title = typeof event?.data?.title === 'string' ? event.data.title : null
      if (title !== null && title !== '') view.title = title
    }

    // Newest movement wins the "current session" slot. Subagent sessions are
    // excluded: the pet reports on the conversation the user is in, and a
    // subagent's session refuses a direct prompt, so making one current would
    // both misdescribe the bubble and break the picker's way back in.
    if (!isSubagent && (current === null || view.movedAt >= (sessions.get(current)?.movedAt ?? 0))) {
      current = id
      if (view.title === null) view.title = titleOf(session)
    }
  })

  // A live agent going idle is a second, independent signal that work stopped.
  // It is deliberately not allowed to override a turn/end verdict: the turn's own
  // reason is more specific, and `idle` would otherwise erase an error.
  ctx.on('agent/status', (payload) => {
    const id = typeof payload?.agent?.id === 'string' ? payload.agent.id : null
    if (id === null) return
    const view = sessions.get(id)
    if (view === undefined) return
    if (payload.status === 'running' && view.activity === ACTIVITY.idle) {
      view.activity = ACTIVITY.thinking
      view.movedAt = Date.now()
    }
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      serve(req, res, ctx, {
        sessions,
        current: () => pinned ?? current,
        setPinned: (id) => { pinned = id },
        diagnostics: () => ({ eventCount }),
        corpus,
        // `titleOf` closes over the title service resolved at load, so the
        // picker borrows this instance's helper rather than looking it up again.
        titleOf,
      }).catch((error) => {
        // A route that throws must still answer. The shell polls `/state` on a
        // timer, so a socket left open would stack one hung poll per interval
        // instead of surfacing as a single visible failure.
        if (res.headersSent) {
          res.destroy()
          return
        }
        json(res, 500, { error: 'internal error', message: messageOf(error) })
      })
    },
  }), 'dsh-desktop-pet: session state route')
}

/**
 * Answer one request on this plugin's prefix.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context, for the services only some routes need.
 * @param {{sessions: Map<string, object>, current: () => string | null, diagnostics: () => object, corpus: object, titleOf: (session: object) => string | null}} store - the live state.
 * @returns {Promise<void>} resolved once the answer is written.
 */
async function serve(req, res, ctx, store) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.slice(PREFIX.length)
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'forbidden' })
    return
  }
  if (route === '/state') {
    json(res, 200, { ...snapshot(store), ...store.diagnostics() })
    return
  }
  if (route === '/sessions') {
    json(res, 200, await sessionList(store, ctx))
    return
  }
  if (route === '/prompt') {
    await servePrompt(req, res, ctx)
    return
  }
  if (route === '/select') {
    await serveSelect(req, res, store)
    return
  }
  json(res, 404, {
    error: 'no such route',
    routes: ['/state', '/sessions', '/prompt', '/select'],
  })
}

/**
 * Point the pet at one session.
 *
 * Deliberately does not check that the id exists: a session can be live in the
 * UI a moment before this host has seen an event for it, and refusing the pick
 * then would be a race the user cannot see. An unknown id simply reports as an
 * idle session with no title until something happens in it.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {{setPinned: (id: string) => void}} store - the live state.
 * @returns {Promise<void>} resolved once the answer is written.
 */
async function serveSelect(req, res, store) {
  if (req.method !== 'POST') {
    promptError(res, 'invalid-request', 'select requires POST')
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    promptError(res, 'invalid-request', messageOf(error))
    return
  }
  const id = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (id === '') {
    promptError(res, 'invalid-request', 'sessionId is required')
    return
  }
  store.setPinned(id)
  json(res, 200, { ok: true, current: id })
}

/**
 * The picker's view of every session this host knows about.
 *
 * Two sources are joined because neither alone is enough. The corpus listing
 * knows about sessions that are not loaded right now; `ctx.sessions` is the
 * only one that is current to the millisecond, and a session created since the
 * cached listing was taken is live before it is listed.
 * @param {{sessions: Map<string, object>, current: () => string | null, corpus: object, titleOf: (session: object) => string | null}} store - the live state.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<{current: string | null, sessions: object[]}>} the payload.
 */
async function sessionList(store, ctx) {
  const now = Date.now()
  /** id → live `Session`, for the title fold and for a `live` flag that is not stale. */
  const liveSessions = new Map()
  const registry = service(ctx, 'sessions')
  // Whether the live enumeration actually answered. Without it, a failed
  // `list()` would report every session as not live; with it, the cached
  // listing's own flag is the fallback instead.
  let liveKnown = false
  if (registry !== null) {
    try {
      for (const session of registry.list()) {
        if (typeof session?.id === 'string') liveSessions.set(session.id, session)
      }
      liveKnown = true
    } catch {
      // Leave `liveKnown` false and let the corpus speak.
    }
  }

  /**
   * One picker row.
   * @param {string} id - the session id.
   * @param {object | null} header - the session header, when one is known.
   * @param {boolean} corpusLive - the corpus listing's `live` flag.
   * @returns {object} the row.
   */
  const rowFor = (id, header, corpusLive) => {
    const view = store.sessions.get(id)
    const session = liveSessions.get(id)
    return {
      id,
      // A title learned from this run's `session/title` event wins over the
      // title service: it is what the session itself last recorded.
      title: view?.title ?? (session === undefined ? null : store.titleOf(session)),
      // Projected through the same linger windows as the pet's own face, so the
      // picker cannot still say "done" about a session the pet has settled.
      activity: view === undefined ? ACTIVITY.idle : activityAt(view, now),
      live: liveKnown ? liveSessions.has(id) : corpusLive,
      // A session that has moved under this plugin reports when it last did;
      // one it has never seen an event for can only report when it was created.
      updatedAt: view !== undefined && view.movedAt > 0 ? view.movedAt : createdAtOf(header),
    }
  }

  const rows = new Map()
  for (const record of (await corpusRecords(ctx, store)) ?? []) {
    const header = record?.header
    const id = typeof header?.id === 'string' ? header.id : null
    if (id === null) continue
    rows.set(id, rowFor(id, header, record.live === true))
  }
  // A session created after the listing was cached is live but not in it yet.
  for (const [id, session] of liveSessions) {
    if (!rows.has(id)) rows.set(id, rowFor(id, session.header, true))
  }
  const current = store.current()
  if (current !== null && !rows.has(current)) {
    // The pet is describing a session the corpus no longer lists — a disposed
    // child that was never persisted, say. The picker still has to be able to
    // show it selected, or it would contradict `/state`.
    rows.set(current, rowFor(current, null, liveSessions.has(current)))
  }
  // The corpus listing carries headers but no titles, so a dormant session —
  // one this run has seen no `session/title` event for — would render as
  // "未命名会话". Its title is still in the log, and the query service folds it
  // back out for a batch of ids at a time.
  const query = service(ctx, 'sessionQuery')
  const untitled = [...rows.values()].filter((row) => row.title === null).map((row) => row.id)
  if (untitled.length > 0 && query !== null && typeof query.readTitleSnapshots === 'function') {
    try {
      for (const result of await query.readTitleSnapshots(untitled)) {
        const folded = result?.status === 'fulfilled' ? result.value?.title?.title : null
        if (typeof folded === 'string' && folded !== '') {
          const row = rows.get(result.sessionId)
          if (row !== undefined) row.title = folded
        }
      }
    } catch {
      // A title-fold failure leaves the untitled rows as they were — a missing
      // title is a worse picker, not a broken one.
    }
  }
  const sessions = [...rows.values()]
    // Newest first, by the same timestamp each row reports. Ids break ties so
    // that two sessions touched in the same millisecond keep a stable order.
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, MAX_SESSIONS)
  return { current, sessions }
}

/**
 * The session corpus, reused for a few seconds at a time.
 *
 * `listSessions()` is the only way to see sessions that are not loaded, and it
 * touches persistence to do it — too expensive to repeat for a route the shell
 * may poll as often as `/state`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{corpus: object}} store - the live state.
 * @returns {Promise<object[] | null>} the records, or null when none were ever read.
 */
async function corpusRecords(ctx, store) {
  const cache = store.corpus
  if (cache.records !== null && Date.now() - cache.at < CORPUS_TTL_MS) return cache.records
  // One slow read, however many requests are waiting on it.
  if (cache.inFlight !== null) return cache.inFlight
  const pending = readCorpus(ctx, store).finally(() => {
    // Timed from the attempt, not from the success: a backend that fails slowly
    // must not be asked again on every request.
    cache.at = Date.now()
    if (cache.inFlight === pending) cache.inFlight = null
  })
  cache.inFlight = pending
  return pending
}

/**
 * Read the corpus once, keeping the previous listing when the read fails.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{corpus: object}} store - the live state.
 * @returns {Promise<object[] | null>} the records, or null when none were ever read.
 */
async function readCorpus(ctx, store) {
  const cache = store.corpus
  try {
    const query = service(ctx, 'sessionQuery')
    if (query === null) return cache.records
    const records = await query.listSessions()
    // A listing that is not an array is a backend bug; the previous one, or the
    // live sessions alone, still answer the picker.
    if (Array.isArray(records)) cache.records = records
  } catch {
    // A backend that is briefly unavailable should not empty the picker, so the
    // last good listing stands until a later attempt replaces it.
  }
  return cache.records
}

/**
 * Answer a prompt request.
 *
 * Success and failure are both HTTP 200 with an `ok` discriminant: the shell
 * tells them apart by the body, and a non-200 would read as a transport fault
 * rather than as the host refusing the message.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Promise<void>} resolved once the answer is written.
 */
async function servePrompt(req, res, ctx) {
  if (req.method !== 'POST') {
    // Not a prompt failure but a caller mistake, so 405 is the honest status;
    // the body keeps the same shape so the shell parses either answer alike.
    json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'prompt accepts POST' } })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    // An unreadable body is the caller's mistake, and saying which one is what
    // lets the shell show something better than "send failed".
    promptError(res, 'invalid-request', messageOf(error))
    return
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const text = typeof body?.text === 'string' ? body.text : ''
  if (sessionId === '') {
    promptError(res, 'invalid-request', 'sessionId is required')
    return
  }
  let files
  try {
    files = await localFiles(body?.files)
  } catch (error) {
    promptError(res, 'invalid-request', messageOf(error))
    return
  }
  // Only the emptiness check trims: the message itself is sent as typed. The
  // rule now binds on both fields at once, because attaching a file with no
  // words is a complete thought — but a caller that never sends `files` still
  // gets the message it always got.
  if (text.trim() === '' && files.length === 0) {
    promptError(res, 'invalid-request', body?.files === undefined ? 'text is required' : 'text or files is required')
    return
  }
  // The controller rather than `agents.get(id).followup(…)`: it resumes the
  // session when it is not loaded and enforces the subagent-ownership fence,
  // and going around it would skip both.
  const controller = service(ctx, 'sessionController')
  if (controller === null) {
    promptError(res, 'unavailable', 'the session controller is not loaded in this host')
    return
  }
  // Text first, so the model reads the request before the handles it names. A
  // whitespace-only message alongside files is dropped rather than sent: the
  // host accepts it, but it would only add an empty block to the log.
  const content = text.trim() === '' ? [] : [{ type: 'text', text }]
  if (files.length > 0) {
    const uploads = service(ctx, 'fileUploads')
    if (uploads === null) {
      // Refused rather than degraded to a mention in the text: the caller asked
      // for the file itself, and silently sending the path instead would look
      // like it worked.
      promptError(res, 'unavailable', 'the file upload service is not loaded in this host, so files cannot be attached')
      return
    }
    try {
      for (const path of files) content.push(await uploadPart(uploads, sessionId, path))
    } catch (error) {
      // The upload service's own words, for the same reason as the prompt
      // failure below: it names the limit or scope that refused the file, and
      // this route has no way to know which.
      promptError(res, 'prompt-failed', messageOf(error))
      return
    }
  }
  try {
    await controller.prompt({
      // The inbox keys on `requestId` and rejects a repeat, so it has to be
      // minted per attempt rather than reused across retries.
      requestId: randomUUID(),
      sessionId,
      // The pet has no way to ask for a steer, and queueing is the
      // non-destructive default: a steer would cut into a running turn.
      mode: 'queue',
      content,
      // Deliberately never aborted. The prompt is the user's intent rather than
      // the poll, and `prompt` only consults the signal before it starts — so
      // tying it to this socket would advertise a cancellation that would not
      // happen anyway.
    }, new AbortController().signal)
    json(res, 200, { ok: true })
  } catch (error) {
    // The host's own words are the whole message. "resume failed for session
    // "…": … is already owned by an active write handle" tells the user to stop
    // whatever else is driving that session; "send failed" would not.
    promptError(res, 'prompt-failed', messageOf(error))
  }
}

/**
 * Turn the request's `files` field into local paths this host can read.
 *
 * Every path is checked here, before a single byte is stored, because the
 * checks are not free later: the upload service stages each receipt against the
 * session and only a *delivered* prompt retires them, so a bad path discovered
 * halfway through a batch would leave the earlier files staged on a session
 * that never sent them. Refusing while refusing is free is the whole design.
 * @param {unknown} value - the request's `files` field.
 * @returns {Promise<string[]>} absolute paths to existing regular files, in request order.
 * @throws {Error} naming the first field or path that cannot be used.
 */
async function localFiles(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('files must be an array of absolute paths')
  if (value.length > MAX_PROMPT_FILES) {
    throw new Error(`files must hold at most ${MAX_PROMPT_FILES} paths`)
  }
  const paths = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('files must be an array of absolute paths')
    }
    // Relative paths are refused rather than resolved. The host's cwd is the
    // harness's, not the shell's, so "resolving" one here would silently attach
    // a different file than the caller meant — and a wrong file is worse than a
    // refusal, because nothing downstream can tell.
    if (!isAbsolute(entry)) throw new Error(`file path must be absolute: ${entry}`)
    let info
    try {
      info = await stat(entry)
    } catch {
      throw new Error(`file does not exist: ${entry}`)
    }
    // A directory carries no bytes, and a device or socket has no end to read
    // to; the store would happily take the first and hang on the second.
    if (!info.isFile()) throw new Error(`not a file: ${entry}`)
    paths.push(entry)
  }
  return paths
}

/**
 * Store one local file for a session and return the prompt part that cites it.
 *
 * This indirection is the point of the route. `PromptContentPart` has no local
 * path variant — its only file form is `{type:'file', receiptId}`, an opaque
 * receipt minted by a preceding upload on that same session — so the bytes go
 * into the upload service first and the receipt is what the prompt carries. The
 * model then receives a handle line naming the stored read-only copy, not the
 * path the user picked, which is also why the display name has to be sent: the
 * stored leaf name is sanitized from it.
 * @param {object} uploads - the host `fileUploads` service.
 * @param {string} sessionId - the session the receipt will belong to.
 * @param {string} path - an absolute path to an existing regular file.
 * @returns {Promise<{type: 'file', receiptId: string}>} the prompt content part.
 */
async function uploadPart(uploads, sessionId, path) {
  const stream = createReadStream(path)
  try {
    // A Node read stream is already an async byte iterable, so the store reads
    // bounded chunks under backpressure instead of holding the whole file in
    // this process. Files have no admission limits, so nothing else bounds it.
    const { receiptId } = await uploads.uploadStream({
      sessionId,
      data: stream,
      name: basename(path),
    })
    return { type: 'file', receiptId }
  } catch (error) {
    // The store abandons the stream the moment it throws, and an abandoned
    // descriptor stays open until GC; close it while the failure is in hand.
    stream.destroy()
    throw error
  }
}

/**
 * Read and parse a JSON request body under a ceiling.
 *
 * The oversize case deliberately does not destroy the request the way the other
 * desktop routes do. Those stream large payloads and gain nothing by draining
 * one; this route exists to answer a small JSON failure the shell can read, and
 * a reset socket would be indistinguishable from the host being down.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @returns {Promise<unknown>} the parsed body, or an empty object when there was none.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let refused = false
    req.on('data', (chunk) => {
      // Once refused, keep consuming without buffering: the request still has
      // to be drained for the response to go out.
      if (refused) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        refused = true
        chunks.length = 0
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The pet's current view, with the linger windows already applied.
 * @param {{sessions: Map<string, object>, current: () => string | null}} store - the live state.
 * @returns {object} a JSON-safe snapshot.
 */
function snapshot(store) {
  const now = Date.now()
  const id = store.current()
  const view = id === null ? undefined : store.sessions.get(id)
  if (view === undefined) {
    return { activity: 'idle', sessionId: null, title: null, tool: null, turn: null, lastEnd: null, updatedAt: now }
  }
  return {
    activity: activityAt(view, now),
    sessionId: view.id,
    title: view.title,
    tool: view.tool,
    turn: view.turn,
    lastEnd: view.lastEnd,
    sessionCount: store.sessions.size,
    updatedAt: now,
  }
}

/**
 * The activity a session view reports right now.
 *
 * A finished turn is shown for a while and then the pet settles, so neither the
 * face nor the picker is stuck reporting something that happened minutes ago.
 * One definition, because the two must not disagree about the same session.
 * @param {object} view - the session view.
 * @param {number} now - the moment to project at.
 * @returns {string} one of {@link ACTIVITY}.
 */
function activityAt(view, now) {
  if (view.lastEnd === null) return view.activity
  if (view.activity === ACTIVITY.done && now - view.lastEnd.at > DONE_LINGER_MS) return ACTIVITY.idle
  if (view.activity === ACTIVITY.error && now - view.lastEnd.at > ERROR_LINGER_MS) return ACTIVITY.idle
  return view.activity
}

/**
 * A session header's creation time.
 * @param {object | null} header - a session header, when one is known.
 * @returns {number} epoch milliseconds, or 0 when the header carries none.
 */
function createdAtOf(header) {
  return typeof header?.createdAt === 'number' ? header.createdAt : 0
}

/**
 * Look up a service this plugin does not inject.
 *
 * Only `webServer` is required: the pet has to answer on a host composed
 * without a session controller or a query backend, just with less to say.
 * `ctx.get` throws for a service this context cannot reach, so the lookup
 * itself is what gets guarded.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} name - the service name.
 * @returns {object | null} the service, or null when it is not mounted.
 */
function service(ctx, name) {
  try {
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

/**
 * Whether a request came from the page this server serves.
 *
 * A cross-site page must not be able to drive these routes (SSRF / a message
 * or file smuggled into a session). A request with no Origin (the shell's own
 * polls, curl) is loopback-only anyway and passes; one that announces an Origin
 * whose host differs from the request's Host is refused. Matches the guard the
 * sibling desktop plugins use.
 * @param {import('node:http').IncomingMessage} req - the request to judge.
 * @returns {boolean} true when no Origin was announced, or it matches the Host.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Answer a refused prompt.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {string} code - a stable, machine-readable reason.
 * @param {string} message - what to show the user.
 */
function promptError(res, code, message) {
  json(res, 200, { ok: false, error: { code, message } })
}

/**
 * The message from an unknown throwable.
 *
 * The host's own words are passed through on purpose: a caller can act on
 * "already owned by an active write handle", not on "send failed".
 * @param {unknown} error - the thrown value.
 * @returns {string} a message for the UI.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Answer with JSON.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {unknown} body - the body.
 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(Buffer.byteLength(text)))
  // Polled state; a cached copy would make the pet lag a whole interval behind.
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}
