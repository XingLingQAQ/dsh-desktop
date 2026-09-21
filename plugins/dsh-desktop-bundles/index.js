/**
 * Same-origin bundle transport for desktop plugins.
 *
 * A desktop plugin's client half is served by the shell's own loopback bridge,
 * which listens on a port of its own. A boot-graph row that names that absolute
 * URL is therefore *cross-origin* with respect to the DSH page, and the client
 * module system loads bundles with a plain `<script src>` — so Chromium refuses
 * it and the row fails with `bundle script undefined failed to load`. A plugin
 * whose row the host composes itself takes exactly that path, which is why one
 * mounted by the DSH Loader as well as by this desktop (a plugin with both a
 * profile entry and a plugins-directory directory) never came up on the client
 * while its pure-desktop neighbours loaded fine.
 *
 * The fix is the platform's own mechanism: register the bytes on the web app's
 * server, so the page fetches them from its own origin. `dsh-desktop-llm` and
 * `dsh-desktop-mcp` already work this way for their own routes; this plugin is
 * the transport half of that, kept separate because every desktop plugin needs
 * it and none of them should have to know about it.
 *
 * The route is a deliberate pass-through to the shell's bridge rather than a
 * re-implementation of plugin discovery: the bridge owns the plugins directory,
 * the built-in bundles, the rev hashes and the `__BRIDGE_API__` substitution,
 * and a second reader of that state would be a second thing to keep in step.
 * Only the *origin* is being fixed here.
 */

export const name = 'dsh-desktop-bundles'

/** Route prefix on the web app's own server; the page calls it same-origin. */
const PREFIX = '/dsh-desktop-bundles'

/** Required services: the web server whose request pipeline hosts the route. */
export const inject = ['webServer']

/**
 * How the shell's bridge is found.
 *
 * The port is not known at import time — the shell binds it while starting and
 * writes it here, beside the profile it is serving. A missing or unreadable
 * file is not an error: it only means there is no bridge to forward to yet, and
 * the route answers accordingly until there is.
 */
const STATE_FILENAME = 'desktop-bridge.json'

/** A proxy hop should be quick; the bridge is on loopback. */
const TIMEOUT_MS = 20_000

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The bridge's loopback base, or `undefined` when it has not published one.
 * @returns {Promise<string | undefined>} e.g. `http://127.0.0.1:50443`.
 */
async function bridgeBase() {
  try {
    const text = await readFile(join(homedir(), '.dsh', STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    const base = parsed?.base
    return typeof base === 'string' && base !== '' ? base : undefined
  } catch {
    return undefined
  }
}

/**
 * Wire the bundle route onto this plugin's fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => { void serve(req, res) },
  }), 'dsh-desktop-bundles: bundle transport route')
}

/**
 * Forward one bundle request to the shell's bridge and stream the answer back.
 *
 * The path after the prefix is passed through verbatim, query included, so the
 * route is transparent: the bridge keeps deciding what exists, what its rev is
 * and what the bytes are.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 */
async function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', '只支持 GET。')
    return
  }
  const base = await bridgeBase()
  if (base === undefined) {
    send(res, 503, 'text/plain; charset=utf-8', '桌面包服务还没起来。')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const rest = url.pathname.slice(PREFIX.length)
  // `/plugins/<id>/client.js` and nothing else: this route exists to carry
  // bundles, and a general forwarding rule would make it a loopback proxy for
  // whatever the caller names. The id may be scoped (`@dsh-desktop/hmr`), so
  // the segment before the filename is a path, not a single segment.
  if (!/^\/plugins\/.+\/client\.js(\.map)?$/.test(rest)) {
    send(res, 404, 'text/plain; charset=utf-8', '没有这个文件。')
    return
  }
  const target = `${base}${rest}${url.search}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const upstream = await fetch(target, {
      method: req.method,
      redirect: 'error',
      signal: controller.signal,
    })
    const type = upstream.headers.get('content-type') ?? 'text/javascript; charset=utf-8'
    const body = Buffer.from(await upstream.arrayBuffer())
    res.statusCode = upstream.status
    res.setHeader('content-type', type)
    res.setHeader('content-length', String(body.byteLength))
    // Bundles are rev-addressed, so a given URL's bytes never change; the
    // bridge already sends the same answer with no caching at all, and this
    // keeps the two layer agreeing.
    res.setHeader('cache-control', 'no-store')
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    send(res, 502, 'text/plain; charset=utf-8',
      `取不到 ${rest}：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Answer with a short text body.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {string} type - the content type.
 * @param {string} body - the body.
 */
function send(res, status, type, body) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}
