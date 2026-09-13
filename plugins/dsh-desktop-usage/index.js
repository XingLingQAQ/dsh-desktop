/**
 * Usage analytics: every stored session's log, folded into the figures the
 * 用量 tab charts.
 *
 * The logs are the only whole-history record this app has. The engine keeps a
 * projection cache beside them, but it holds one session at a time, refreshes
 * on its own schedule, and is keyed by a version the reader has no way to
 * negotiate — a dashboard built on it would be stale more often than not. The
 * raw artifacts are complete and self-describing, so this reads them directly
 * and folds the same events the engine's own projections fold, with the same
 * rules (see the fold below).
 *
 * A session artifact is a concatenation of independent Zstandard frames, so a
 * plain decompress gives only the first one. The frame scanner here is the same
 * structural walk the harness's JSONL backend does: find each complete frame's
 * byte range from the header and block table, then decompress that range alone.
 * An interrupted tail is skipped rather than repaired — a session being written
 * right now contributes what it has committed.
 *
 * A log line is either a session event or a packed run of stream chunks
 * (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`), which the writer
 * uses to keep token-sized deltas from bloating the file. Only the first
 * visible delta of a run matters here — it is the first-token boundary — so
 * runs are read in place rather than expanded.
 *
 * Transport is a route on the web app's own server, so the page reaches it
 * same-origin: no CORS, no preflight, no bridge token.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'dsh-desktop-usage'

/** Required services. `webServer` hosts the route. */
export const inject = ['webServer']

/** Route prefix on the web app's own server; the page calls it same-origin. */
const PREFIX = '/dsh-desktop-usage/api'

/** Request body ceiling. A body is a flag and a time range. */
const MAX_BODY_BYTES = 8 * 1024

/** A parsed frame larger than this is refused; real frames are kilobytes. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024

/** Zstandard frame magic, little-endian on disk. */
const ZSTD_MAGIC = 0xFD2FB528

/** Session artifact filename under `sessions/<project>/<session>/`. */
const LOG_NAME = 'session.jsonl.zstd'

/** Storage-row tags that stand for a packed run of stream chunks. */
const CHUNK_ROWS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** Millisecond span of one day, for bucketing by calendar date. */
const DAY_MS = 86_400_000

/**
 * Wire the route onto this plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const index = new SessionIndex()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => { void serve(index, req, res) },
  }), 'dsh-desktop-usage: summary route')
}

/**
 * The parsed per-session summaries, keyed by artifact path and reused until the
 * file changes.
 *
 * Re-reading every log per request would be wasteful and, on a long history,
 * slow: the page polls nothing, but a refresh after a turn should not walk
 * megabytes to learn that eighteen files are untouched. Each entry remembers
 * the file's size and mtime, which is what the writer changes when it appends.
 */
class SessionIndex {
  constructor() {
    this.root = path.join(homedir(), '.dsh', 'sessions')
    /** @type {Map<string, {key: string, summary: object}>} */
    this.cache = new Map()
  }

  /**
   * Fold every stored session into one payload.
   * @returns {Promise<object>} the aggregate the page charts.
   */
  async read() {
    const files = await findLogs(this.root)
    const seen = new Set(files)
    for (const file of this.cache.keys()) {
      if (!seen.has(file)) this.cache.delete(file)
    }
    const summaries = []
    for (const file of files) {
      const summary = await this.summaryOf(file)
      if (summary !== null) summaries.push(summary)
    }
    return aggregate(summaries)
  }

  /**
   * One session's summary, from cache unless the artifact changed.
   * @param {string} file - absolute artifact path.
   * @returns {Promise<object|null>} the summary, or null when unreadable.
   */
  async summaryOf(file) {
    let info
    try {
      info = await stat(file)
    } catch {
      return null
    }
    const key = `${String(info.size)}:${String(info.mtimeMs)}`
    const cached = this.cache.get(file)
    if (cached !== undefined && cached.key === key) return cached.summary
    let summary = null
    try {
      summary = foldSession(await readFile(file))
    } catch {
      // One unreadable artifact must not take the whole dashboard down; it is
      // simply absent from the totals until it becomes readable.
      summary = null
    }
    this.cache.set(file, { key, summary })
    return summary
  }

  /**
   * One session's summary, addressed by the id its log header carries.
   *
   * The directory name is the artifact's only address — the harness names it
   * after the session and nothing else links id to file — so the walk is over
   * directory names, not over the cache, whose keys are paths it would have to
   * re-read anyway. Both spellings of the id arrive here: the log header's
   * bare uuid, and the web app's session id, which is the directory name
   * including its `session-` prefix.
   * @param {string} id - a session id, with or without the directory prefix.
   * @returns {Promise<object|null>} the summary, or null when no artifact carries it.
   */
  async byId(id) {
    const entries = await findLogs(this.root)
    const target = entries.find((file) => {
      const dir = path.basename(path.dirname(file))
      return dir === id || dir === `session-${id}`
    })
    return target === undefined ? null : await this.summaryOf(target)
  }
}

/**
 * Answer one call.
 *
 * A cross-site page must not be able to read this machine's usage history, so a
 * request announcing an origin other than the server's own host is refused;
 * requests with no `Origin` (curl, a script) are loopback-only anyway and pass.
 * @param {SessionIndex} index - the live index.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 */
async function serve(index, req, res) {
  try {
    if (!sameOrigin(req)) {
      send(res, 403, fail('这个接口只给 DSH 页面用。'))
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, fail('只接受 POST。'))
      return
    }
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(`${PREFIX}/`.length)
    const body = await readBody(req)
    switch (method) {
      case 'summary': {
        const payload = await index.read()
        send(res, 200, { ok: true, ...payload })
        return
      }
      case 'session': {
        const id = fieldOf(body, 'id')
        const session = id === null ? null : await index.byId(id)
        send(res, 200, { ok: true, session: session === null ? null : presentSession(session) })
        return
      }
      default:
        send(res, 404, fail(`没有这个接口:${method}`))
    }
  } catch (error) {
    send(res, 200, fail(error instanceof Error ? error.message : String(error)))
  }
}

/** One JSON failure envelope. */
function fail(message) {
  return { ok: false, error: { message } }
}

/**
 * Read one string field out of a JSON request body.
 * @param {string} body - the raw request body.
 * @param {string} key - the field to read.
 * @returns {string|null} the value, or null when the body is not JSON or the field is absent.
 */
function fieldOf(body, key) {
  try {
    const parsed = JSON.parse(body)
    const value = parsed === null || typeof parsed !== 'object' ? undefined : parsed[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Flatten one folded session into the shape a reply carries.
 *
 * The fold keeps its tallies in prototype-less maps so a log-derived name can
 * never collide with `Object.prototype`; JSON has no such hazard and the page
 * wants lists, so the maps become sorted arrays here — and nowhere else, since
 * the aggregate path has its own roll-up over the same summaries.
 * @param {object} session - a folded session.
 * @returns {object} the session as the page reads it.
 */
function presentSession(session) {
  const reply = {
    ...session,
    tools: Object.entries(session.tools)
      .map(([name, entry]) => ({ name, calls: entry.calls, errors: entry.errors }))
      .sort((a, b) => b.calls - a.calls),
    models: Object.entries(session.models)
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
    reasons: Object.entries(session.reasons)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
    durationMs: Math.max(0, session.endedAt - session.createdAt),
  }
  delete reply.daily
  return reply
}

/**
 * Every session artifact under the sessions root.
 *
 * The layout is fixed by the harness's JSONL backend — one directory per
 * project, one per session, the artifact inside — so the walk is bounded to
 * that depth rather than following whatever a corrupted tree contains.
 * @param {string} root - the sessions root.
 * @returns {Promise<string[]>} absolute artifact paths, in directory order.
 */
async function findLogs(root) {
  const out = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    let sessions
    try {
      sessions = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = path.join(projectDir, session.name, LOG_NAME)
      try {
        if ((await stat(file)).isFile()) out.push(file)
      } catch {
        // No artifact in this session's directory yet.
      }
    }
  }
  return out
}

/** Whether a request came from the page this server serves. */
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
 * Drain a request body under a ceiling and hand back its text.
 *
 * The route table reads no fields out of the aggregate call, but the
 * single-session one names its subject in the body, so the drain has to keep
 * what it reads rather than discard it.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @returns {Promise<string>} the body as UTF-8 text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/**
 * Write one JSON reply.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - a JSON-serializable body.
 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/* ------------------------------------------------------------------ storage */

/**
 * Byte ranges of the complete Zstandard frames in a concatenated stream.
 *
 * Ported from the harness's own scanner (`session-persistence-jsonl`): walk
 * each frame's header and block table to its end without decoding, so a file
 * being appended to can be read up to its last complete frame. An incomplete
 * final frame yields nothing — its range would be a lie.
 * @param {Buffer} buffer - the bytes currently on disk.
 * @returns {{start: number, end: number}[]} complete frames, in file order.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let complete = true
    for (;;) {
      if (buffer.length - offset < 3) { complete = false; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) { complete = false; break }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { complete = false; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (!complete) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * The stored records of one session artifact.
 *
 * Each frame is one apportioned batch; an unreadable frame or an unparseable
 * line is dropped rather than failing the file, because a damaged tail must not
 * hide the committed history in front of it.
 * @param {Buffer} buffer - the artifact bytes.
 * @returns {object[]} parsed records, in log order.
 */
function readRecords(buffer) {
  const out = []
  const decompress = zlib.zstdDecompressSync
  if (typeof decompress !== 'function') return out
  for (const frame of scanFrames(buffer)) {
    if (frame.end - frame.start > MAX_FRAME_BYTES) continue
    let text
    try {
      text = decompress(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof value === 'object' && value !== null) out.push(value)
    }
  }
  return out
}

/**
 * The record's contribution to the first-token boundary, if any.
 *
 * A plain `assistant/chunk` event is tested the way the engine tests it: an
 * empty delta is a heartbeat, not output. A packed run carries its members'
 * times as gaps from `time0`, so the first non-empty member's time is
 * reconstructed without expanding the run.
 * @param {object} record - one parsed record.
 * @returns {{turn: number, step: number, time: number}|null} the boundary, or
 *   null when the record does not carry a first token.
 */
function firstDelta(record) {
  if (record.type === 'assistant/chunk') {
    const data = record.data
    if (typeof data !== 'object' || data === null) return null
    const chunk = data.chunk
    if (typeof chunk !== 'object' || chunk === null) return null
    if (!isVisibleDelta(chunk)) return null
    return { turn: data.turn, step: data.step, time: number(record.time) }
  }
  if (typeof record.type !== 'string' || !CHUNK_ROWS.has(record.type)) return null
  const data = record.data
  if (typeof data !== 'object' || data === null) return null
  const members = record.type === 'tool-call-chunks' ? data.args : data.texts
  const gaps = data.dt
  if (!Array.isArray(members) || !Array.isArray(gaps)) return null
  const named = record.type === 'tool-call-chunks' && typeof data.name === 'string'
  let time = number(record.time0)
  for (let index = 0; index < members.length; index++) {
    if (index > 0) time += gaps[index - 1] ?? 0
    const nonEmpty = record.type === 'tool-call-chunks'
      ? named || members[index] !== ''
      : members[index] !== ''
    if (nonEmpty) return { turn: data.turn, step: data.step, time }
  }
  return null
}

/**
 * Whether a stream chunk carries visible model output (the harness's own
 * first-token rule: empty deltas, heartbeats and empty tool frames do not).
 * @param {object} chunk - the chunk.
 * @returns {boolean} true for a non-empty text, reasoning or tool-call delta.
 */
function isVisibleDelta(chunk) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/* ------------------------------------------------------------------- folding */

/** A finite non-negative number, or zero. */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** The provider-reported output tokens of a usage record, or null. */
function outputOf(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** The calendar date (local) a timestamp falls on, as `YYYY-MM-DD`. */
function dateOf(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * One day's bucket, created empty on first use.
 *
 * The maps in this file are prototype-less: their keys come from the log — tool
 * names, model ids, call ids — and a key like `constructor` must read as absent,
 * not as an inherited member that would be mutated as if it were a tally.
 */
function dayOf(daily, time) {
  const key = dateOf(time)
  const existing = daily[key]
  if (existing !== undefined) return existing
  const bucket = {
    date: key,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
  }
  daily[key] = bucket
  return bucket
}

/** One tool's running tally, created on first use. */
function toolOf(tools, toolName) {
  const existing = tools[toolName]
  if (existing !== undefined) return existing
  const entry = { calls: 0, errors: 0 }
  tools[toolName] = entry
  return entry
}

/** One model route's running tally, created on first use. */
function modelOf(models, key) {
  const existing = models[key]
  if (existing !== undefined) return existing
  const entry = { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  models[key] = entry
  return entry
}

/**
 * Fold one session's log.
 *
 * The rules are the engine's own, so a session's figures here match what the
 * conversation footer reports: a step's model time runs `step/start` to its
 * assembled `assistant/message`; first-token latency is the first visible delta
 * after `step/start`; decode throughput spans first token to assembled message
 * and counts only steps that also reported output tokens; tool time pairs
 * `tool/call` to `tool/result` by callId; a step counts at `step/end` (so
 * cancelled and failed steps count, and a max-tokens step counts once). Token
 * buckets follow the meter's last-sample-wins rule, so a usage chunk followed
 * by the same step's assembled message is counted once, not twice.
 * @param {Buffer} buffer - the artifact bytes.
 * @returns {object} the session's figures.
 */
function foldSession(buffer) {
  const records = readRecords(buffer)
  const header = records.find(record => record.type === 'session')
  /* v8 ignore next -- a headerless artifact has no identity to report */
  if (header === undefined) throw new Error('session log has no header')
  const createdAt = number(header.createdAt)
  const summary = {
    id: String(header.id ?? ''),
    createdAt,
    endedAt: createdAt,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    turns: 0,
    steps: 0,
    messages: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    model: '',
    provider: '',
    reasons: Object.create(null),
    tools: Object.create(null),
    models: Object.create(null),
    daily: Object.create(null),
  }
  /** @type {{turn: number, step: number, start: number, firstToken: number|null}|null} */
  let open = null
  /** @type {number|null} */
  let lastTurn = null
  /** @type {Record<string, {time: number, name: string}>} */
  let pending = Object.create(null)
  /** @type {{turn: number, step: number, key: string}|null} the last sample's slot */
  let lastUsage = null

  for (const record of records) {
    const type = record.type
    if (type === 'session') continue
    const data = typeof record.data === 'object' && record.data !== null ? record.data : {}
    const time = number(record.time)
    if (time > summary.endedAt) summary.endedAt = time
    switch (type) {
      case 'turn/start': {
        const day = dayOf(summary.daily, time)
        day.turns += 1
        break
      }
      case 'step/start': {
        open = { turn: data.turn, step: data.step, start: time, firstToken: null }
        break
      }
      case 'assistant/chunk': {
        const boundary = firstDelta(record)
        if (boundary !== null && open !== null
          && open.turn === boundary.turn && open.step === boundary.step && open.firstToken === null) {
          open.firstToken = boundary.time
        }
        if (data.chunk?.type === 'usage') {
          lastUsage = sampleUsage(summary, data, data.chunk.usage, lastUsage, time)
        }
        break
      }
      case 'text-chunks':
      case 'reasoning-chunks':
      case 'tool-call-chunks': {
        const boundary = firstDelta(record)
        if (boundary !== null && open !== null
          && open.turn === boundary.turn && open.step === boundary.step && open.firstToken === null) {
          open.firstToken = boundary.time
        }
        break
      }
      case 'assistant/message': {
        summary.messages += 1
        const day = dayOf(summary.daily, time)
        if (open !== null && open.turn === data.turn && open.step === data.step) {
          const stepMs = Math.max(0, time - open.start)
          summary.llmMs += stepMs
          day.llmMs += stepMs
          if (open.firstToken !== null) {
            const ttft = Math.max(0, open.firstToken - open.start)
            summary.ttftMs += ttft
            summary.ttftSteps += 1
            day.ttftMs += ttft
            day.ttftSteps += 1
            const output = outputOf(data.usage)
            if (output !== null) {
              const decode = Math.max(0, time - open.firstToken)
              summary.decodeMs += decode
              summary.decodeTokens += output
              day.decodeMs += decode
              day.decodeTokens += output
            }
          }
          open = null
        }
        lastUsage = sampleUsage(summary, data, data.usage, lastUsage, time)
        break
      }
      case 'tool/call': {
        const toolName = typeof data.name === 'string' ? data.name : ''
        pending[String(data.callId ?? '')] = { time, name: toolName }
        const tool = toolOf(summary.tools, toolName)
        tool.calls += 1
        summary.toolCalls += 1
        dayOf(summary.daily, time).toolCalls += 1
        break
      }
      case 'tool/result': {
        const callId = String(data.message?.source?.callId ?? '')
        const entry = Object.hasOwn(pending, callId) ? pending[callId] : undefined
        if (entry !== undefined) {
          const toolMs = Math.max(0, time - entry.time)
          summary.toolMs += toolMs
          dayOf(summary.daily, time).toolMs += toolMs
          delete pending[callId]
        }
        if (isToolError(data)) {
          const toolName = entry?.name ?? ''
          toolOf(summary.tools, toolName).errors += 1
          summary.toolErrors += 1
          dayOf(summary.daily, time).toolErrors += 1
        }
        break
      }
      case 'step/end': {
        if (lastTurn !== data.turn) summary.turns += 1
        lastTurn = data.turn
        summary.steps += 1
        open = null
        break
      }
      case 'turn/end': {
        const kind = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown'
        summary.reasons[kind] = (summary.reasons[kind] ?? 0) + 1
        // A call whose result never landed belongs to a cancelled or failed
        // turn; results land within their turn, so leftovers are dropped.
        pending = Object.create(null)
        break
      }
      case 'request/context': {
        if (typeof data.provider === 'string') summary.provider = data.provider
        if (typeof data.model === 'string') summary.model = data.model
        break
      }
      default:
        break
    }
  }
  return summary
}

/**
 * Add one usage sample to the session totals, replacing that step's previous
 * sample rather than adding to it.
 *
 * A step reports usage twice when it streams a usage chunk and then assembles
 * its message; only the later sample is the step's figure. The engine's meter
 * keeps one `last` slot for exactly this reason, and the session-log invariant
 * that usage reports for a turn/step are adjacent is what makes one slot
 * enough.
 * @param {object} summary - the session being folded.
 * @param {object} data - the event's data (turn, step).
 * @param {unknown} usage - the reported usage, if any.
 * @param {{turn: number, step: number, key: string}|null} lastUsage - the slot
 *   the previous sample occupied.
 * @param {number} time - the event's time, for daily bucketing.
 * @returns {{turn: number, step: number, key: string}|null} the new slot.
 */
function sampleUsage(summary, data, usage, lastUsage, time) {
  if (usage === undefined || typeof usage !== 'object' || usage === null) return lastUsage
  const key = [number(usage.inputTokens), number(usage.outputTokens), number(usage.cacheReadTokens), number(usage.cacheWriteTokens)].join(':')
  const sameSlot = lastUsage !== null && lastUsage.turn === data.turn && lastUsage.step === data.step
  if (sameSlot && lastUsage.key === key) return lastUsage
  const previous = sameSlot ? lastUsage.key.split(':').map(Number) : null
  const next = [number(usage.inputTokens), number(usage.outputTokens), number(usage.cacheReadTokens), number(usage.cacheWriteTokens)]
  const buckets = {
    inputTokens: summary.inputTokens - (previous?.[0] ?? 0) + next[0],
    outputTokens: summary.outputTokens - (previous?.[1] ?? 0) + next[1],
    cacheReadTokens: summary.cacheReadTokens - (previous?.[2] ?? 0) + next[2],
    cacheWriteTokens: summary.cacheWriteTokens - (previous?.[3] ?? 0) + next[3],
  }
  summary.inputTokens = buckets.inputTokens
  summary.outputTokens = buckets.outputTokens
  summary.cacheReadTokens = buckets.cacheReadTokens
  summary.cacheWriteTokens = buckets.cacheWriteTokens
  const model = modelOf(summary.models, modelKey(summary))
  model.messages += 1
  model.inputTokens += next[0] - (previous?.[0] ?? 0)
  model.outputTokens += next[1] - (previous?.[1] ?? 0)
  model.cacheReadTokens += next[2] - (previous?.[2] ?? 0)
  model.cacheWriteTokens += next[3] - (previous?.[3] ?? 0)
  const day = dayOf(summary.daily, time)
  day.inputTokens += next[0] - (previous?.[0] ?? 0)
  day.outputTokens += next[1] - (previous?.[1] ?? 0)
  day.cacheReadTokens += next[2] - (previous?.[2] ?? 0)
  day.cacheWriteTokens += next[3] - (previous?.[3] ?? 0)
  return { turn: data.turn, step: data.step, key }
}

/** The model route a session is currently talking to. */
function modelKey(summary) {
  if (summary.provider.length === 0 && summary.model.length === 0) return '未知'
  if (summary.provider.length === 0) return summary.model
  if (summary.model.length === 0) return summary.provider
  return `${summary.provider}/${summary.model}`
}

/** Whether a tool result reports a failure, by either channel the log carries. */
function isToolError(data) {
  if (data.error !== undefined && data.error !== null) return true
  const content = data.message?.content
  if (!Array.isArray(content)) return false
  return content.some(part => part?.isError === true)
}

/* ---------------------------------------------------------------- aggregate */

/**
 * Roll the per-session summaries into the payload the page charts.
 * @param {object[]} sessions - the folded sessions.
 * @returns {object} totals, per-day series, per-tool and per-model breakdowns.
 */
function aggregate(sessions) {
  const totals = {
    sessions: sessions.length,
    turns: 0,
    steps: 0,
    messages: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
  }
  const tools = Object.create(null)
  const models = Object.create(null)
  const daily = Object.create(null)
  const projects = Object.create(null)
  const rows = []

  for (const session of sessions) {
    for (const key of Object.keys(totals)) {
      if (key !== 'sessions') totals[key] += session[key]
    }
    for (const [toolName, entry] of Object.entries(session.tools)) {
      const tool = toolOf(tools, toolName)
      tool.calls += entry.calls
      tool.errors += entry.errors
    }
    for (const [key, entry] of Object.entries(session.models)) {
      const model = modelOf(models, key)
      model.messages += entry.messages
      model.inputTokens += entry.inputTokens
      model.outputTokens += entry.outputTokens
      model.cacheReadTokens += entry.cacheReadTokens
      model.cacheWriteTokens += entry.cacheWriteTokens
    }
    for (const bucket of Object.values(session.daily)) {
      const day = dayOf(daily, Date.parse(`${bucket.date}T12:00:00`))
      // Iterate the SOURCE's keys: `sessions` is only ever set on a day a
      // session began, so walking the target's keys would add `undefined` to a
      // day that has the field while the bucket being merged does not.
      for (const key of Object.keys(bucket)) {
        if (key === 'date') continue
        day[key] = (day[key] ?? 0) + bucket[key]
      }
    }
    const project = projectOf(session)
    const entry = projects[project] ?? (projects[project] = {
      project,
      sessions: 0,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      llmMs: 0,
      toolMs: 0,
    })
    entry.sessions += 1
    entry.turns += session.turns
    entry.toolCalls += session.toolCalls
    entry.toolErrors += session.toolErrors
    entry.inputTokens += session.inputTokens
    entry.outputTokens += session.outputTokens
    entry.cacheReadTokens += session.cacheReadTokens
    entry.cacheWriteTokens += session.cacheWriteTokens
    entry.llmMs += session.llmMs
    entry.toolMs += session.toolMs
    // The day a session began counts it, so a session spanning midnight is not
    // counted twice.
    const started = dayOf(daily, session.createdAt)
    started.sessions = (started.sessions ?? 0) + 1

    rows.push({
      id: session.id,
      createdAt: session.createdAt,
      endedAt: session.endedAt,
      project,
      cwd: session.cwd,
      agentPreset: session.agentPreset,
      turns: session.turns,
      steps: session.steps,
      toolCalls: session.toolCalls,
      toolErrors: session.toolErrors,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      llmMs: session.llmMs,
      toolMs: session.toolMs,
      ttftMs: session.ttftMs,
      ttftSteps: session.ttftSteps,
      decodeMs: session.decodeMs,
      decodeTokens: session.decodeTokens,
      model: modelKey(session),
      reasons: session.reasons,
    })
  }

  return {
    generatedAt: Date.now(),
    range: rangeOf(rows),
    totals,
    daily: Object.values(daily).sort((a, b) => a.date < b.date ? -1 : 1),
    tools: Object.entries(tools)
      .map(([toolName, entry]) => ({ name: toolName, calls: entry.calls, errors: entry.errors }))
      .sort((a, b) => b.calls - a.calls),
    models: Object.entries(models)
      .map(([key, entry]) => ({ model: key, ...entry }))
      .sort((a, b) => totalTokens(b) - totalTokens(a)),
    projects: Object.values(projects).sort((a, b) => totalTokens(b) - totalTokens(a)),
    sessions: rows.sort((a, b) => b.createdAt - a.createdAt),
  }
}

/** A row's token total across all four buckets. */
function totalTokens(entry) {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
}

/** The project a session belongs to: the working directory's last segment. */
function projectOf(session) {
  if (session.cwd.length === 0) return '未记录'
  const parts = session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || session.cwd
}

/** The span the folded sessions cover. */
function rangeOf(rows) {
  if (rows.length === 0) return { from: 0, to: 0 }
  let from = rows[0].createdAt
  let to = rows[0].endedAt
  for (const row of rows) {
    if (row.createdAt < from) from = row.createdAt
    if (row.endedAt > to) to = row.endedAt
  }
  return { from, to, days: Math.max(1, Math.floor((to - from) / DAY_MS) + 1) }
}
