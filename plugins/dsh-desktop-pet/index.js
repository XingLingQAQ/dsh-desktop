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
 */

export const name = 'dsh-desktop-pet'

/** The web server hosts the route the shell polls. */
export const inject = ['webServer']

const PREFIX = '/dsh-desktop-pet'

/** How long a finished turn stays on screen before the pet settles to idle. */
const DONE_LINGER_MS = 6_000

/** How long an error stays before the pet settles. Errors are worth noticing. */
const ERROR_LINGER_MS = 15_000

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
  if (kind === 'blocked') return { activity: ACTIVITY.waiting, code: null }
  if (kind === 'error') {
    const error = typeof reason === 'object' && reason !== null ? reason.error : null
    const code = typeof error === 'object' && error !== null && typeof error.code === 'string'
      ? error.code
      : null
    return { activity: ACTIVITY.error, code }
  }
  // `aborted` / `interrupted` / `max-tokens` all end the turn without failing it
  // outright; the pet has no separate face for them yet, so they read as done.
  return { activity: ACTIVITY.done, code: null }
}

/**
 * Wire the state route onto this plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  /** The session the pet is currently reporting on. */
  let current = null
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
  /** Set when a title arrives from the title service rather than the log. */
  let titleService = null
  try {
    titleService = ctx.get('sessionTitle')
  } catch {
    titleService = null
  }

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
    if (titleService === null) return null
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
    const view = viewFor(id)
    const type = typeof event?.type === 'string' ? event.type : null
    view.movedAt = Date.now()

    if (type === 'turn/start') {
      view.activity = ACTIVITY.thinking
      view.tool = null
      view.turn = typeof event?.data?.turn === 'number' ? event.data.turn : view.turn
      view.lastEnd = null
    } else if (type === 'tool/call') {
      const name = typeof event?.data?.name === 'string' ? event.data.name : null
      view.activity = ACTIVITY.tool
      view.tool = name
    } else if (type === 'turn/end') {
      const mapped = activityForTurnEnd(event?.data?.reason)
      view.activity = mapped.activity
      view.tool = null
      view.lastEnd = {
        kind: typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : null,
        code: mapped.code,
        at: Date.now(),
      }
    } else if (type === 'session/title') {
      const title = typeof event?.data?.title === 'string' ? event.data.title : null
      if (title !== null && title !== '') view.title = title
    }

    // Newest movement wins the "current session" slot.
    if (current === null || view.movedAt >= (sessions.get(current)?.movedAt ?? 0)) {
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
      serve(req, res, {
        sessions,
        current: () => current,
        diagnostics: () => ({ eventCount }),
      })
    },
  }), 'dsh-desktop-pet: session state route')
}

/**
 * Answer a state request.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {{sessions: Map<string, object>, current: () => string | null, diagnostics: () => object}} store - the live state.
 */
function serve(req, res, store) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.slice(PREFIX.length)
  if (route !== '/state') {
    json(res, 404, { error: 'no such route', routes: ['/state'] })
    return
  }
  json(res, 200, { ...snapshot(store), ...store.diagnostics() })
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
  // A finished turn is shown for a while and then the pet settles, so the face
  // is not stuck reporting something that happened minutes ago.
  let activity = view.activity
  if (activity === ACTIVITY.done && view.lastEnd !== null && now - view.lastEnd.at > DONE_LINGER_MS) {
    activity = ACTIVITY.idle
  }
  if (activity === ACTIVITY.error && view.lastEnd !== null && now - view.lastEnd.at > ERROR_LINGER_MS) {
    activity = ACTIVITY.idle
  }
  return {
    activity,
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
