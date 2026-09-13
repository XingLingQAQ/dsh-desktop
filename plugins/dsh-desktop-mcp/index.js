/**
 * MCP servers: the configuration document, the live connections, and the
 * control surface the MCP tab drives.
 *
 * One plugin owns the whole subject. `~/.dsh/mcp-servers.json` is the document
 * — the same file and the same shape DSH already reads — and one child of the
 * engine's own MCP client is mounted per enabled record, which is what actually
 * connects, publishes tools into the registry the model reads, and keeps the
 * connection alive. Nothing about the protocol is re-implemented here; this
 * plugin owns the *record*, the *supervision* and the *questions the page asks*.
 *
 * It has to be the Host half. `ctx.tools.schemas()` is the live registry, the
 * MCP client is a Host plugin, and both are unreachable from the page. Mounting
 * the client from here — rather than in `cordis.yml` — is what makes the record
 * editable: pause, resume and reconnect are all "replace the child", which a
 * static configuration row cannot express.
 *
 * A connection failure is not an error state anywhere in this stack: the client
 * logs it and retries with backoff, and the plugin stays active with zero tools.
 * That shape is indistinguishable from a server that genuinely offers nothing,
 * so the tool list is reported exactly as the registry has it rather than being
 * dressed up, and `diagnose` exists to go and ask the server directly why.
 *
 * Transport is a route on the web app's own server, so the page reaches it
 * same-origin: no CORS, no preflight, no bridge token.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-desktop-mcp'

/**
 * Required services. `tools` is the live registry the model reads — its
 * `schemas()` is the only truthful answer to "what does this server offer".
 * `webServer` hosts the route.
 */
export const inject = ['tools', 'webServer']

/** Route prefix on the web app's own server; the page calls it same-origin. */
const PREFIX = '/dsh-desktop-mcp/api'

/** Request body ceiling. A body is one server record. */
const MAX_BODY_BYTES = 64 * 1024

/** Document format this plugin writes; the engine reads the same one. */
const DOCUMENT_VERSION = 1

/** Format of the sidecar that remembers which fields are secret. */
const KINDS_VERSION = 1

/** Per-tool-call timeout a new record starts with. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Server names are a namespace in every public tool name; the engine's own rule. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** The two field kinds a user may pick per entry. */
const FIELD_KINDS = new Set(['text', 'secret'])

/** Value marker that makes a field a bearer credential. */
const BEARER_PREFIX = 'Bearer '

/** The engine's MCP client, mounted once per configured server. */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Tool names the engine gives one server are all under this prefix. */
function toolPrefix(serverName) {
  return `mcp__${serverName}__`
}

/** The configuration document, under the harness home. */
const DOCUMENT_FILENAME = 'mcp-servers.json'

/**
 * Sidecar naming the field kinds.
 *
 * The document's own shape must stay exactly what the engine reads, so nothing
 * describing the *editor* may live in it. A name-based guess covers a first
 * run; after that the user's own choice is remembered here.
 */
const KINDS_FILENAME = 'mcp-field-kinds.json'

/** Field names that are almost certainly credentials on a first run. */
const SECRET_NAME_HINT = /(authorization|token|secret|password|passwd|credential|api[-_]?key|^key$)/i

/**
 * Which candidate directories a bare package specifier is resolved from.
 *
 * This plugin ships as a file the desktop points the host at, with no
 * `node_modules` of its own, so the engine's packages have to be found by name
 * from the tree that does have them. The profile root is where the harness
 * links its workspace, and it is stable regardless of which profile is running;
 * the process directory and the home directory are cheap extra chances.
 */
function resolveRoots() {
  const home = homedir()
  return [
    path.join(home, '.dsh', 'profiles'),
    path.join(home, '.dsh', 'profiles', 'node_modules'),
    process.cwd(),
    home,
  ]
}

/** The engine's MCP client module, imported once per Host process. */
let mcpClientModule

/**
 * Load the engine's MCP client.
 * @returns {Promise<{name: string, inject: string[], Config: unknown, apply: Function}>}
 * @throws {Error} when it cannot be found or imported.
 */
async function mcpClient() {
  if (mcpClientModule === undefined) {
    const require = createRequire(import.meta.url)
    let resolved
    try {
      resolved = require.resolve(MCP_CLIENT_PACKAGE, { paths: resolveRoots() })
    } catch (cause) {
      throw new Error(`找不到本机的 MCP 客户端(${MCP_CLIENT_PACKAGE}),这台机器上的 Host 可能不是完整安装。`, { cause })
    }
    mcpClientModule = await import(pathToFileURL(resolved).href)
  }
  return mcpClientModule
}

/**
 * Wire the manager and the route onto this plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const manager = new McpManager(ctx)
  ctx.effect(() => {
    // Chained rather than fired and forgotten: the document is read
    // asynchronously, and a request arriving before that read finishes would
    // otherwise be applied to the empty in-memory copy and then overwritten by
    // the read's result. `boot` puts the read at the head of the same queue
    // every request joins, so nothing can race it.
    void manager.boot()
    return () => manager.dispose()
  }, 'dsh-desktop-mcp: server manager')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => { void serve(manager, req, res) },
  }), 'dsh-desktop-mcp: control route')
}

/**
 * The document, the field-kind sidecar, and one child per enabled server.
 *
 * Every mutation is serialized through one chain: a record written while a
 * mount is in flight would otherwise be read back by the mount and produce a
 * connection that disagrees with the file.
 */
class McpManager {
  /** @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context. */
  constructor(ctx) {
    this.ctx = ctx
    this.home = homedir()
    this.documentPath = path.join(this.home, '.dsh', DOCUMENT_FILENAME)
    this.kindsPath = path.join(this.home, '.dsh', KINDS_FILENAME)
    /** @type {{version: number, servers: unknown[]}} */
    this.document = { version: DOCUMENT_VERSION, servers: [] }
    /** @type {{version: number, servers: Record<string, Record<string, Record<string, string>>>}} */
    this.kinds = { version: KINDS_VERSION, servers: {} }
    /** @type {Map<string, {record: object, fiber: unknown, error: string|null}>} */
    this.children = new Map()
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve()
    this.loadError = null
  }

  /**
   * Read both files and mount everything they enable, at the head of the queue.
   * @returns {Promise<void>} when the document is live.
   */
  boot() {
    return this.enqueue(() => this.start())
  }

  /** Read both files and mount everything the document enables. */
  async start() {
    try {
      this.document = await readDocument(this.documentPath)
      this.kinds = await readKinds(this.kindsPath)
    } catch (error) {
      this.loadError = describe(error)
      this.ctx.logger.error(`dsh-desktop-mcp: ${this.loadError}`)
      return
    }
    for (const record of this.document.servers) {
      if (record.enabled !== false) await this.mount(record)
    }
  }

  /** Release every live connection. */
  async dispose() {
    // Queued behind anything in flight, so a boot still reading its document
    // cannot mount a child into a manager that has already been torn down.
    await this.chain
    const names = [...this.children.keys()]
    for (const serverName of names) await this.unmount(serverName)
  }

  /**
   * Serialize one unit of work against every other.
   * @param {() => Promise<T>} work - the mutation.
   * @returns {Promise<T>} the mutation's result.
   * @template T
   */
  enqueue(work) {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * One row per configured server, as it stands right now.
   * @returns {{servers: object[]}}
   */
  snapshot() {
    const schemas = this.ctx.tools.schemas()
    return {
      servers: this.document.servers.map((record) => {
        const child = this.children.get(record.serverName)
        const prefix = toolPrefix(record.serverName)
        const tools = schemas
          .filter(schema => typeof schema.name === 'string' && schema.name.startsWith(prefix))
          .map(schema => ({
            name: schema.name.slice(prefix.length),
            description: typeof schema.description === 'string' ? schema.description : '',
          }))
        return {
          serverName: record.serverName,
          enabled: record.enabled !== false,
          transport: record.transport,
          command: record.transport === 'stdio' ? record.command : '',
          args: record.transport === 'stdio' ? record.args : [],
          cwd: record.transport === 'stdio' ? record.cwd : '',
          url: record.transport === 'streamable-http' ? record.url : '',
          toolCallTimeoutMs: record.toolCallTimeoutMs,
          fields: describeFields(record, this.kinds),
          phase: phaseOf(child),
          error: child?.error ?? null,
          toolCount: tools.length,
          tools,
        }
      }),
    }
  }

  /**
   * The stored record for one server, or a refusal naming it.
   * @param {unknown} serverName - requested name.
   * @returns {object} the record.
   * @throws {Error} when there is no such server.
   */
  recordFor(serverName) {
    const record = this.document.servers.find(entry => entry.serverName === serverName)
    if (record === undefined) throw new Error(`没有叫 ${serverName} 的 MCP 服务器。`)
    return record
  }

  /**
   * Create or replace one server and remount its connection.
   * @param {unknown} request - the page's editor payload.
   */
  async upsert(request) {
    // A rename is one edit, not a delete plus a create: the record it replaces
    // is what supplies the values the page was never shown, so the old name has
    // to be found before the new one exists.
    const fromName = typeof request?.fromServerName === 'string' ? request.fromServerName : request?.serverName
    const existing = this.document.servers.find(entry => entry.serverName === fromName)
    const record = { ...(existing?.extra ?? {}), ...buildRecord(request, existing) }
    const kinds = buildKinds(request, this.kinds.servers?.[fromName] ?? {}, record)
    const replacing = this.document.servers.findIndex(entry => entry.serverName === record.serverName)
    if (replacing >= 0) this.document.servers[replacing] = record
    else this.document.servers.push(record)

    const name = assertServerName(record.serverName)
    const kindsByName = { ...this.kinds.servers, [name]: kinds }
    if (fromName !== undefined && fromName !== name) delete kindsByName[fromName]
    this.kinds.servers = kindsByName
    await this.persist()
    // Both names are released, then the new one mounted: leaving the old
    // connection up would hold the engine's namespace reservation for a server
    // that no longer exists in the document.
    if (fromName !== undefined && fromName !== name) await this.unmount(fromName)
    await this.unmount(name)
    if (record.enabled !== false) await this.mount(record)
    if (fromName !== undefined && fromName !== name) {
      this.document.servers = this.document.servers.filter(entry => entry.serverName !== fromName)
      await this.persist()
    }
    this.ctx.logger.info(`dsh-desktop-mcp: 已保存 ${name}`)
  }

  /**
   * Drop one server from the document and dispose its connection.
   * @param {unknown} serverName - the name to remove.
   */
  async remove(serverName) {
    const name = assertServerName(serverName)
    this.recordFor(name)
    this.document.servers = this.document.servers.filter(entry => entry.serverName !== name)
    const kinds = { ...this.kinds.servers }
    delete kinds[name]
    this.kinds.servers = kinds
    await this.persist()
    await this.unmount(name)
  }

  /**
   * Take one server in or out of service.
   *
   * Pausing is `enabled: false` in the document, which is what makes it
   * reversible: the record keeps its endpoint and its credentials, its
   * connection is disposed and its tools leave the registry, and resuming
   * mounts a fresh connection from the same stored record.
   * @param {unknown} serverName - the server.
   * @param {boolean} enabled - the state to move to.
   */
  async setEnabled(serverName, enabled) {
    const name = assertServerName(serverName)
    const record = this.recordFor(name)
    if ((record.enabled !== false) === enabled) return
    record.enabled = enabled
    await this.persist()
    await this.unmount(name)
    if (enabled) await this.mount(record)
  }

  /**
   * Drop one server's connection and mount a fresh one from the same record.
   *
   * The engine's own reconnect loop can be sitting in a backoff — or have given
   * up entirely after its attempt budget — while the user has just fixed the
   * cause. Replacing the child is the only way to make it try again now.
   * @param {unknown} serverName - the server.
   */
  async reconnect(serverName) {
    const name = assertServerName(serverName)
    const record = this.recordFor(name)
    if (record.enabled === false) throw new Error(`${name} 现在是暂停的,先恢复再重连。`)
    await this.unmount(name)
    await this.mount(record)
  }

  /**
   * Ask one server directly why it is not producing tools.
   *
   * The engine reports a failed handshake only in the log, so the page cannot
   * tell "wrong address" from "wrong credential" from "server has no tools".
   * This is a plain MCP handshake of our own, made only when the user asks, and
   * reported as the raw status rather than interpreted.
   * @param {unknown} serverName - the server.
   * @returns {Promise<{ok: boolean, detail: string}>} what the probe saw.
   */
  async diagnose(serverName) {
    const name = assertServerName(serverName)
    const record = this.recordFor(name)
    if (record.transport !== 'streamable-http') {
      return {
        ok: false,
        detail: 'stdio 服务器没法这样探测:它是个子进程,起不来通常就是命令、参数或者工作目录不对。',
      }
    }
    return probeHttp(record)
  }

  /**
   * Mount one server's connection.
   * @param {object} record - the stored record.
   */
  async mount(record) {
    const name = record.serverName
    if (this.children.has(name)) return
    const child = { record, fiber: undefined, error: null }
    this.children.set(name, child)
    try {
      const client = await mcpClient()
      // Mounted as an object rather than by name: this plugin is handed to the
      // Host as a file, and the loader's name resolution is not reachable from
      // an already-running fiber. The four fields are the whole plugin surface.
      const fiber = this.ctx.plugin({
        name: client.name,
        inject: client.inject,
        Config: client.Config,
        apply: client.apply,
      }, toClientConfig(record))
      child.fiber = fiber
      // A failed mount is not thrown — the client retries on its own — so the
      // rejection is caught here purely to keep it from surfacing as an
      // unhandled rejection. Its reason is not the connection's reason.
      Promise.resolve(fiber).catch((error) => { child.error = describe(error) })
    } catch (error) {
      child.error = describe(error)
      this.ctx.logger.error(`dsh-desktop-mcp(${name}): ${child.error}`)
    }
  }

  /**
   * Dispose one server's connection and wait for it to be gone.
   * @param {string} serverName - the server to unmount.
   */
  async unmount(serverName) {
    const child = this.children.get(serverName)
    if (child === undefined) return
    this.children.delete(serverName)
    try {
      await child.fiber?.dispose?.()
    } catch (error) {
      this.ctx.logger.warn(`dsh-desktop-mcp(${serverName}): 断开时出错: ${describe(error)}`)
    }
  }

  /** Write both files, the document first so a crash cannot orphan the kinds. */
  async persist() {
    await writeJson(this.documentPath, serializeDocument(this.document))
    await writeJson(this.kindsPath, { version: KINDS_VERSION, servers: this.kinds.servers })
  }
}

/**
 * Answer one call.
 *
 * A cross-site page must not be able to drive this app's MCP servers, so a
 * request that announces an origin other than the server's own host is refused;
 * requests with no `Origin` (curl, a script) are loopback-only anyway and pass.
 * @param {McpManager} manager - the live manager.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 */
async function serve(manager, req, res) {
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
      case 'state':
        send(res, 200, { ok: true, ...manager.snapshot(), loadError: manager.loadError })
        return
      case 'upsert':
        send(res, 200, await mutating(manager, () => manager.upsert(body)))
        return
      case 'delete':
        send(res, 200, await mutating(manager, () => manager.remove(body?.serverName)))
        return
      case 'pause':
        send(res, 200, await mutating(manager, () => manager.setEnabled(body?.serverName, false)))
        return
      case 'resume':
        send(res, 200, await mutating(manager, () => manager.setEnabled(body?.serverName, true)))
        return
      case 'reconnect':
        send(res, 200, await mutating(manager, () => manager.reconnect(body?.serverName)))
        return
      case 'diagnose': {
        // Read-only, and the only call allowed to be slow: it goes out to the
        // server. Failures are the answer, so it never reports `ok: false` at
        // the envelope level.
        const result = await manager.enqueue(() => manager.diagnose(body?.serverName))
        send(res, 200, { ok: true, ...result, ...manager.snapshot() })
        return
      }
      default:
        send(res, 404, fail(`没有这个接口:${method}`))
    }
  } catch (error) {
    send(res, 200, fail(describe(error)))
  }
}

/**
 * Run one mutation and answer with the state it produced.
 *
 * Mutations are serialized: two clicks in the same second would otherwise
 * interleave a mount with the unmount that replaces it, leaving the registry
 * holding tools from a connection nobody owns.
 * @param {McpManager} manager - the live manager.
 * @param {() => Promise<void>} work - the mutation.
 * @returns {Promise<object>} the reply body.
 */
async function mutating(manager, work) {
  try {
    await manager.enqueue(work)
    return { ok: true, ...manager.snapshot() }
  } catch (error) {
    return fail(describe(error))
  }
}

/** One JSON failure envelope. */
function fail(message) {
  return { ok: false, error: { message } }
}

/** A human-readable message for an unknown throwable. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The stored record as the engine's client config. */
function toClientConfig(record) {
  const base = {
    transport: record.transport,
    serverName: record.serverName,
    toolCallTimeoutMs: record.toolCallTimeoutMs,
    // A failed handshake must not fail the mount: the client supervises its own
    // retries, and a fiber that threw would take that supervisor down with it.
    failOnStartupError: false,
  }
  return record.transport === 'stdio'
    ? { ...base, command: record.command, args: record.args, env: record.env, cwd: record.cwd }
    : { ...base, url: record.url, headers: record.headers }
}

/** The fiber's lifecycle phase, as the page names it. */
const PHASES = ['pending', 'loading', 'active', 'failed', null, 'unloading']

/**
 * The phase of one child's fiber.
 * @param {{fiber: {state?: number}|undefined}|undefined} child - the child record.
 * @returns {string|null} the phase, or null when nothing is mounted.
 */
function phaseOf(child) {
  const fiber = child?.fiber
  if (fiber === undefined || typeof fiber.state !== 'number') return null
  return PHASES[fiber.state] ?? null
}

/**
 * The document's records, minus anything this plugin did not write.
 *
 * Keys the engine defines but this editor has no field for — and any key a
 * future version adds — are carried through untouched rather than dropped, so
 * opening a server in the editor cannot silently narrow its record.
 * @param {string} text - the file's contents.
 * @returns {{version: number, servers: object[]}}
 * @throws {Error} when the file is not a document this plugin can drive.
 */
function parseDocument(text) {
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('mcp-servers.json 的最外层不是一个对象。')
  }
  if (parsed.version !== DOCUMENT_VERSION) {
    throw new Error(`mcp-servers.json 的版本是 ${String(parsed.version)},这个界面只认 ${String(DOCUMENT_VERSION)}。`)
  }
  if (!Array.isArray(parsed.servers)) throw new Error('mcp-servers.json 里的 servers 不是一个数组。')
  const servers = []
  const seen = new Set()
  for (const entry of parsed.servers) {
    if (typeof entry !== 'object' || entry === null) continue
    const serverName = assertServerName(entry.serverName)
    if (seen.has(serverName)) throw new Error(`mcp-servers.json 里有两台都叫 ${serverName} 的服务器。`)
    seen.add(serverName)
    servers.push(normalize(entry))
  }
  return { version: DOCUMENT_VERSION, servers }
}

/**
 * One stored record with every field this plugin reads made explicit.
 *
 * Keys this editor has no field for are kept aside rather than dropped: the
 * engine's client accepts more per record than this form shows, and opening a
 * server in the editor must not narrow its record as a side effect.
 * @param {object} entry - a record from the file.
 * @returns {object} the normalized record.
 */
function normalize(entry) {
  const common = {
    transport: entry.transport,
    serverName: entry.serverName,
    enabled: entry.enabled !== false,
    toolCallTimeoutMs: Number.isFinite(entry.toolCallTimeoutMs) ? entry.toolCallTimeoutMs : DEFAULT_TIMEOUT_MS,
    failOnStartupError: false,
  }
  const known = entry.transport === 'stdio'
    ? {
      ...entry,
      ...common,
      command: typeof entry.command === 'string' ? entry.command : '',
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: plainMap(entry.env),
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    }
    : {
      ...entry,
      ...common,
      url: typeof entry.url === 'string' ? entry.url : '',
      headers: plainMap(entry.headers),
    }
  return { ...known, extra: leftoverKeys(entry, entry.transport) }
}

/** The keys of one stored record that this editor has no field for. */
function leftoverKeys(entry, transport) {
  const owned = transport === 'stdio'
    ? ['transport', 'serverName', 'enabled', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs', 'failOnStartupError']
    : ['transport', 'serverName', 'enabled', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError']
  const extra = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!owned.includes(key)) extra[key] = value
  }
  return extra
}

/** A `Record<string, string>` from an unknown value, dropping non-strings. */
function plainMap(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** The document's serialized form: exactly the shape the engine reads. */
function serializeDocument(document) {
  return {
    version: DOCUMENT_VERSION,
    servers: document.servers.map((record) => {
      const extra = record.extra ?? {}
      if (record.transport === 'stdio') {
        return {
          ...extra,
          transport: 'stdio',
          serverName: record.serverName,
          enabled: record.enabled !== false,
          command: record.command,
          args: record.args,
          env: record.env,
          cwd: record.cwd,
          toolCallTimeoutMs: record.toolCallTimeoutMs,
          failOnStartupError: false,
        }
      }
      return {
        ...extra,
        transport: 'streamable-http',
        serverName: record.serverName,
        enabled: record.enabled !== false,
        url: record.url,
        headers: record.headers,
        toolCallTimeoutMs: record.toolCallTimeoutMs,
        failOnStartupError: false,
      }
    }),
  }
}

/**
 * Read the document, treating an absent file as an empty one.
 * @param {string} file - absolute path.
 * @returns {Promise<{version: number, servers: object[]}>}
 */
async function readDocument(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: DOCUMENT_VERSION, servers: [] }
    throw error
  }
  if (text.trim().length === 0) return { version: DOCUMENT_VERSION, servers: [] }
  try {
    return parseDocument(text)
  } catch (error) {
    throw new Error(`读不懂 ${DOCUMENT_FILENAME}:${describe(error)}`, { cause: error })
  }
}

/**
 * Read the field-kind sidecar, treating an absent or unreadable file as empty.
 *
 * Losing this file costs the user their secret/text choices in the editor, not
 * their servers, so it never blocks startup.
 * @param {string} file - absolute path.
 * @returns {Promise<{version: number, servers: object}>}
 */
async function readKinds(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.version !== KINDS_VERSION || typeof parsed.servers !== 'object' || parsed.servers === null) {
      return { version: KINDS_VERSION, servers: {} }
    }
    return { version: KINDS_VERSION, servers: parsed.servers }
  } catch {
    return { version: KINDS_VERSION, servers: {} }
  }
}

/**
 * Write one JSON file so a reader never sees a half-written document.
 *
 * The rename is atomic within a directory, which is what keeps a crash from
 * leaving a document the engine would refuse to parse.
 * @param {string} file - absolute path.
 * @param {unknown} value - the value to serialize.
 */
async function writeJson(file, value) {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  // Credentials live in this file, so it is owner-only on every platform that
  // has the concept; Windows ignores the mode rather than failing.
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * A server name, validated against the contract every public tool name obeys.
 * @param {unknown} value - the candidate.
 * @returns {string} the name.
 * @throws {Error} when it cannot be a namespace.
 */
function assertServerName(value) {
  if (typeof value !== 'string' || !SERVER_NAME_PATTERN.test(value)) {
    throw new Error('服务器名字只能是字母、数字、下划线和短横线,长度 1–32。它同时也是工具名前缀的一部分。')
  }
  return value
}

/**
 * The field kinds the editor should show for one record.
 *
 * Saved choices win; an unsaved field falls back to a name-shaped guess, which
 * is what makes an existing credential read as a credential the first time this
 * editor opens it.
 * @param {object} record - the stored record.
 * @param {{servers: object}} kinds - the sidecar.
 * @returns {{group: string, name: string, kind: string, value: string, set: boolean, bearer: boolean}[]}
 */
function describeFields(record, kinds) {
  const saved = kinds.servers?.[record.serverName] ?? {}
  const groups = record.transport === 'stdio'
    ? [['env', record.env]]
    : [['headers', record.headers]]
  const out = []
  for (const [group, map] of groups) {
    for (const [fieldName, stored] of Object.entries(map)) {
      const kind = FIELD_KINDS.has(saved[group]?.[fieldName])
        ? saved[group][fieldName]
        : secretHint(fieldName) ? 'secret' : 'text'
      const bearer = kind === 'secret' && hasBearer(stored)
      out.push({
        group,
        name: fieldName,
        kind,
        // A secret's value never leaves the Host; `set` is what the editor
        // renders as「已设置」and what tells it to keep what is stored.
        value: kind === 'secret' ? '' : stored,
        set: true,
        bearer,
      })
    }
  }
  return out
}

/** Whether a field name looks like a credential on a first run. */
function secretHint(fieldName) {
  return SECRET_NAME_HINT.test(fieldName)
}

/** Whether a stored value already carries the bearer scheme. */
function hasBearer(value) {
  return /^bearer\s/i.test(value)
}

/**
 * Build the record an upsert request describes.
 *
 * A secret field is carried over from the stored record unless the request says
 * otherwise, so the round trip through the page never has to see — or send back
 * — a credential. `env` and `headers` are replaced wholesale, which is the only
 * way a removed row can actually disappear.
 * @param {unknown} request - the page's payload.
 * @param {object|undefined} existing - the record being replaced, if any.
 * @returns {object} the record to store.
 * @throws {Error} when a required field is missing or malformed.
 */
function buildRecord(request, existing) {
  if (typeof request !== 'object' || request === null) throw new Error('请求体不是一个对象。')
  const serverName = assertServerName(request.serverName)
  const transport = request.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new Error('transport 只能是 stdio 或 streamable-http。')
  }
  const timeout = Number.isFinite(request.toolCallTimeoutMs) && request.toolCallTimeoutMs > 0
    ? Math.floor(request.toolCallTimeoutMs)
    : existing?.toolCallTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const entries = Array.isArray(request.fields) ? request.fields : []
  const stored = existing === undefined
    ? {}
    : (transport === 'stdio' ? plainMap(existing.env) : plainMap(existing.headers))
  const previous = isRecordOf(existing, transport)

  if (transport === 'stdio') {
    if (typeof request.command !== 'string' || request.command.trim().length === 0) {
      throw new Error('stdio 服务器需要一个可执行命令。')
    }
    return {
      transport: 'stdio',
      serverName,
      enabled: request.enabled !== false,
      command: request.command.trim(),
      args: readArgs(request.args),
      cwd: typeof request.cwd === 'string' ? request.cwd.trim() : '',
      env: resolveFields(entries, 'env', stored, previous),
      toolCallTimeoutMs: timeout,
      failOnStartupError: false,
    }
  }
  if (typeof request.url !== 'string' || request.url.trim().length === 0) {
    throw new Error('HTTP 服务器需要一个地址。')
  }
  try {
    // Rejected here rather than at connect time: an unparseable URL produces a
    // failed handshake, which reads on screen as "no tools" rather than as the
    // typo it is.
    void new URL(request.url.trim())
  } catch {
    throw new Error('这个地址不是合法的 URL,要写全,例如 https://example.com/mcp。')
  }
  return {
    transport: 'streamable-http',
    serverName,
    enabled: request.enabled !== false,
    url: request.url.trim(),
    headers: resolveFields(entries, 'headers', stored, previous),
    toolCallTimeoutMs: timeout,
    failOnStartupError: false,
  }
}

/** Whether an existing record can supply carried-over values for this transport. */
function isRecordOf(existing, transport) {
  return existing !== undefined && existing.transport === transport
}

/** Argument lines, taken verbatim; a blank one is not an argument. */
function readArgs(value) {
  if (!Array.isArray(value)) return []
  return value.map(entry => (typeof entry === 'string' ? entry : '')).filter(entry => entry.length > 0)
}

/**
 * Apply one group's field rows onto the stored map.
 *
 * A row marked `keep` reuses the stored value — that is how an edited record
 * keeps a credential the page was never shown. A secret row is prefixed when it
 * is flagged as a bearer token, because the header has to carry the scheme and
 * forgetting it is silent: the server answers 401 and the connection just never
 * produces tools.
 * @param {unknown[]} entries - the request's field rows for every group.
 * @param {string} group - `env` or `headers`.
 * @param {Record<string, string>} stored - the values currently on disk.
 * @param {boolean} canCarry - whether `stored` belongs to this transport.
 * @returns {Record<string, string>} the new map.
 * @throws {Error} when a row is malformed or a kept value is no longer there.
 */
function resolveFields(entries, group, stored, canCarry) {
  const out = {}
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || entry.group !== group) continue
    const fieldName = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (fieldName.length === 0) throw new Error('有一行字段没写名字。')
    if (/[\s=]/.test(fieldName)) throw new Error(`字段名「${fieldName}」里不能有空格或等号。`)
    if (Object.hasOwn(out, fieldName)) throw new Error(`字段名「${fieldName}」写了两遍。`)
    const kind = FIELD_KINDS.has(entry.kind) ? entry.kind : 'text'
    if (kind === 'secret' && entry.keep !== false) {
      if (!canCarry || !Object.hasOwn(stored, fieldName)) {
        throw new Error(`字段「${fieldName}」标成了密钥,但本机没存过它的值。请直接填一个新的,或者把它改成文本类型。`)
      }
      // The bearer flag is applied here too, not only to a freshly typed value:
      // turning it on for a credential that is already stored is the whole
      // point of having the switch next to「已设置」, and the prefix is only
      // ever added, never stripped — the flag is derived from the stored value
      // on the way back, so unchecking it cannot silently rewrite anything.
      out[fieldName] = entry.bearer === true ? withBearer(stored[fieldName]) : stored[fieldName]
    } else {
      const entered = typeof entry.value === 'string' ? entry.value : ''
      out[fieldName] = entry.bearer === true ? withBearer(entered) : entered
    }
  }
  return out
}

/** Add the bearer scheme unless the value already states one. */
function withBearer(value) {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  return hasBearer(trimmed) ? trimmed : `${BEARER_PREFIX}${trimmed}`
}

/**
 * The field-kind sidecar entry for one record.
 *
 * The request describes the record's complete field set, so its rows are the
 * whole entry — a group the request says nothing about keeps what it had.
 * @param {unknown} request - the page's payload.
 * @param {object} priorKinds - the kinds recorded for the name this replaces.
 * @param {object} record - the record just built.
 * @returns {Record<string, Record<string, string>>} kinds keyed by group then name.
 */
function buildKinds(request, priorKinds, record) {
  const entries = Array.isArray(request?.fields) ? request.fields : []
  const out = { ...priorKinds }
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const group = entry.group === 'env' ? 'env' : 'headers'
    const fieldName = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (fieldName.length === 0) continue
    out[group] = { ...out[group], [fieldName]: FIELD_KINDS.has(entry.kind) ? entry.kind : 'text' }
  }
  // Drop the names the rewritten group no longer carries, so a deleted field
  // does not come back remembering that it used to be a secret.
  const active = record.transport === 'stdio' ? 'env' : 'headers'
  const present = record[active] ?? {}
  out[active] = Object.fromEntries(
    Object.entries(out[active] ?? {}).filter(([fieldName]) => Object.hasOwn(present, fieldName)),
  )
  return out
}

/**
 * A plain MCP handshake, made because the user asked why a server is silent.
 *
 * Reports the raw status rather than a verdict — a 401 and a wrong path are the
 * same failure to a client and completely different problems to a person.
 * @param {object} record - the stored record.
 * @returns {Promise<{ok: boolean, detail: string}>} what the probe saw.
 */
async function probeHttp(record) {
  let response
  try {
    response = await fetch(record.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...record.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dsh-desktop', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return { ok: false, detail: `连不上:${describe(error)}。地址、端口或者网络可能是问题。` }
  }
  const text = (await response.text().catch(() => '')).slice(0, 300)
  if (!response.ok) {
    return {
      ok: false,
      detail: `服务器回了 HTTP ${String(response.status)}:${text || '(没有内容)'}。`
        + (response.status === 401 || response.status === 403
          ? ' 这是身份没通过 —— 检查一下请求头里的凭据,以及要不要勾「Bearer 令牌」。'
          : ''),
    }
  }
  if (text.includes('"result"')) {
    return {
      ok: true,
      detail: '服务器本身是通的,握手正常。那问题就在 Host 这边的连接上,试试「重连」。',
    }
  }
  return { ok: false, detail: `服务器回了 200,但不像 MCP 的应答:${text || '(没有内容)'}` }
}

/**
 * Whether a request came from the page this server serves.
 * @param {import('node:http').IncomingMessage} req - the request to judge.
 * @returns {boolean} true when no origin was announced, or it matches the host.
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
 * Read and parse a request body under a ceiling.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @returns {Promise<unknown>} the parsed body, or an empty object when there was none.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是 JSON。'))
      }
    })
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
