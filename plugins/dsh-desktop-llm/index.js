/**
 * Model listing *and* channel inventory for the Models settings page, on the
 * Host side.
 *
 * The channel half of this plugin exists because the page cannot read that
 * document from the browser: DSH's client-side `connection` handle changed
 * shape — the version that ships now carries
 * `isLoopback/generation/state/rpc/reconnect/…` and no `api` member at all — so
 * the `connection.api.settings.describe(...)` calls the old page made are not
 * reachable from a plugin any more. The Host's own `settings`, `credentials`
 * and `llm` services are stable and are exactly what those calls were a wire
 * projection of, so the page asks this route instead. Same-origin, no CORS, no
 * bridge token, and no private client API to track.
 *
 * The settings card's 「获取可用模型」 button is answered by the harness's own
 * pi-ai discovery, which by design reads `GET /models` from the two
 * OpenAI-compatible protocols only — a hand-declared gateway speaking
 * `anthropic-messages` is refused outright, and the user's own new-api relay is
 * exactly that shape. This plugin answers the question itself: it interpolates
 * the listing endpoint from the protocol, resolves the route's credential where
 * the credential actually lives, and reads the reply with Node's own `fetch`.
 *
 * It has to be the Host half. A stored key is a reference
 * (`apiKeyEnv: SOME_KEY`) that only the Host process can resolve — the settings
 * page edits a redacted descriptor and never holds a secret — so a probe sent
 * from the page would go out unauthenticated and come back 401.
 *
 * Transport is a route on the web app's own server, so the page reaches it
 * same-origin: no CORS, no preflight, no bridge token, no Tauri IPC. The body
 * is the same draft the card already builds, and nothing is written anywhere —
 * the reply is candidates for the user to adopt.
 */

export const name = 'dsh-desktop-llm'

/** Route prefix on the web app's own server; the page calls it same-origin. */
const PREFIX = '/dsh-desktop-llm/api'

/** Required services: the web server whose request pipeline hosts the route. */
export const inject = ['webServer']

/** Request body ceiling. The draft is a handful of short strings. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Reply ceiling, held on the bytes actually read rather than on a declared
 * length: the endpoint is whatever the user typed, so a declared size proves
 * nothing. A truncated model listing is not parseable, so overflow refuses
 * instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** One probe is a configuration-time action; it must not hang the request. */
const TIMEOUT_MS = 15_000

/** Anthropic lists 20 models at a time by default; 1000 is its maximum. */
const ANTHROPIC_LIMIT = 1000

/** A refusal with a message already fit to show the user. */
class DiscoverError extends Error {
  /**
   * @param {string} message - what to show.
   * @param {'missing' | 'other'} [kind] - `missing` marks "this URL has no
   *   listing endpoint", which only deserves to be reported when nothing better
   *   turned up.
   */
  constructor(message, kind = 'other') {
    super(message)
    this.kind = kind
  }
}

/**
 * Wire both route shapes onto the web server. `register` returns a disposer,
 * which `ctx.effect` ties to this fiber so a pause takes the route down with
 * the plugin instead of leaving a listener behind.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => { void serve(ctx, req, res) },
  }), 'dsh-desktop-llm: model listing route')
}

/**
 * Answer one call. A cross-site page must not be able to use this route as an
 * SSRF proxy, so a request that announces an origin other than the server's own
 * host is refused; requests with no `Origin` (curl, a script) are loopback-only
 * anyway and pass.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 */
async function serve(ctx, req, res) {
  try {
    if (!sameOrigin(req)) {
      send(res, 403, { ok: false, error: { message: '这个接口只给 DSH 页面用。' } })
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: { message: '只接受 POST。' } })
      return
    }
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(`${PREFIX}/`.length)
    if (method === 'discover') {
      const request = JSON.parse(await readBody(req))
      const models = await discover(ctx, request)
      send(res, 200, { ok: true, models })
      return
    }
    if (method === 'providers') {
      send(res, 200, { ok: true, ...await listProviders(ctx) })
      return
    }
    if (method === 'credential') {
      const request = JSON.parse(await readBody(req))
      send(res, 200, await storeCredential(ctx, request))
      return
    }
    if (method === 'describe-credentials') {
      const request = JSON.parse(await readBody(req))
      const credentials = ctx.get('credentials')
      const refs = Array.isArray(request.refs) ? request.refs.map(String) : []
      const out = {}
      for (const ref of refs) {
        try {
          const info = await credentials?.describe(ref)
          // `writable` gates the page's key field; the seam reports it, so it
          // travels rather than being assumed.
          out[ref] = { configured: info?.configured === true, writable: info?.writable !== false }
        } catch {
          out[ref] = { configured: false, writable: true }
        }
      }
      send(res, 200, { ok: true, credentials: out })
      return
    }
    if (method === 'describe') {
      const settings = ctx.get('settings')
      send(res, 200, {
        ok: true,
        writable: settings?.writable !== false,
        namespaces: settings === undefined
          ? []
          : settings.describe({ redactSecrets: true }),
      })
      return
    }
    if (method === 'advanced') {
      const request = JSON.parse(await readBody(req))
      send(res, 200, { ok: true, ...await writeAdvanced(ctx, request) })
      return
    }
    send(res, 404, { ok: false, error: { message: `没有这个接口:${method}` } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    send(res, 200, { ok: false, error: { message } })
  }
}

/**
 * Whether a request came from the page this server serves.
 * @param {import('node:http').IncomingMessage} req - the request to judge.
 * @returns true when no origin was announced, or it matches the request's host.
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
 * Read a request body under a ceiling, as text.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @returns the body text.
 * @throws {DiscoverError} when the body exceeds {@link MAX_BODY_BYTES}.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new DiscoverError('请求体过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/**
 * Write one JSON reply.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
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

/**
 * Every channel the page lists: the configurable-provider directory joined with
 * the settings document and the credential store.
 *
 * This is the same join the native Models page performs in the browser — the
 * directory for identity, `settings.describe` for the stored profile, and
 * `credentials.describe` for whether the referenced key is actually held. All
 * three are Host services, which is the point: nothing here depends on the
 * client-side connection handle the page can no longer reach.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns `{ writable, providers }`, each provider carrying its own state.
 */
async function listProviders(ctx) {
  const settings = ctx.get('settings')
  const llm = ctx.get('llm')
  if (settings === undefined || llm === undefined) {
    return { writable: false, providers: [] }
  }
  // Redacted on purpose: this response crosses to the page, and a stored secret
  // must never be part of it. `configured` is the fact the page wants anyway.
  const described = settings.describe({ redactSecrets: true })
  const byNs = new Map(described.map(entry => [entry.ns, entry]))
  const directory = typeof llm.listConfigurableProviders === 'function'
    ? llm.listConfigurableProviders()
    : []
  // `listProviders` answers with metadata records, not bare ids, so the id is
  // read off each one — a Set of the records themselves would match nothing and
  // every channel would render as unregistered.
  const active = new Set(
    (typeof llm.listProviders === 'function' ? llm.listProviders() : [])
      .map(entry => text(entry?.provider ?? entry?.id))
      .filter(id => id !== undefined),
  )

  const profiles = directory.map((entry) => {
    const view = byNs.get(entry.settingsNs)
    const path = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
    const profile = valueAt(view?.value, path)
    return {
      provider: entry.provider,
      displayName: text(entry.displayName) ?? entry.provider,
      settingsNs: entry.settingsNs,
      settingsPath: path,
      declared: entry.declared === true,
      active: active.has(entry.provider),
      namespace: view,
      profile,
      keyRef: text(profile?.apiKeyEnv),
    }
  })

  const refs = [...new Set(profiles.flatMap(row => row.keyRef === undefined ? [] : [row.keyRef]))]
  const held = new Set()
  if (refs.length > 0) {
    const credentials = ctx.get('credentials')
    for (const ref of refs) {
      try {
        const info = await credentials?.describe(ref)
        // `configured` is the seam's own answer and already treats an empty
        // stored value as absent, so it is used verbatim rather than inferred
        // from a resolve() that would hand back the secret itself.
        if (info?.configured === true) held.add(ref)
      } catch {
        // A composition without the credential seam leaves the dot unknown,
        // which renders as "not configured" rather than failing the list.
      }
    }
  }

  return {
    writable: settings.writable !== false,
    providers: profiles.map(({ namespace, profile, ...row }) => ({
      ...row,
      configured: namespace !== undefined && (row.settingsPath.length === 0 || profile !== undefined),
      keyConfigured: row.keyRef !== undefined && held.has(row.keyRef),
      revision: namespace?.revision,
    })),
  }
}

/**
 * Store one channel's key, and point its profile at the reference if the
 * profile names none.
 *
 * The reference is derived the way the native page derives it, so a key typed
 * here lands where the adapter already looks instead of under a second name.
 * The profile is only touched when it names no reference: a route with its own
 * auth path must not be handed one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} request - `{ provider, settingsNs, settingsPath, ref, value }`.
 * @returns an envelope for the page.
 */
async function storeCredential(ctx, request) {
  const credentials = ctx.get('credentials')
  const settings = ctx.get('settings')
  if (credentials === undefined || settings === undefined) {
    return { ok: false, error: { message: '这个宿主没有提供密钥存储。' } }
  }
  const value = text(request.value)
  const provider = text(request.provider)
  const ref = text(request.ref) ?? (provider === undefined ? undefined : derivedRef(provider))
  if (value === undefined || ref === undefined) {
    return { ok: false, error: { message: '缺少密钥或渠道名。' } }
  }
  try {
    await credentials.set(ref, value)
    const ns = text(request.settingsNs)
    const path = Array.isArray(request.settingsPath) ? request.settingsPath.map(String) : []
    if (ns !== undefined && request.attachRef === true) {
      await settings.mutate(ns, [{ op: 'set', path: [...path, 'apiKeyEnv'], value: ref }])
    }
    return { ok: true, ref }
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Write one channel profile's advanced fields.
 *
 * `settings.mutate` takes path ops, and that is what the caller sends: each op
 * names only a field the form actually changed, so a field neither side touched
 * produces no op and cannot be deleted by the other editor.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} request - `{ ns, ops, expectedRevision }`.
 * @returns an envelope for the page.
 */
async function writeAdvanced(ctx, request) {
  const settings = ctx.get('settings')
  if (settings === undefined) {
    return { ok: false, error: { message: '这个宿主没有提供设置服务。' } }
  }
  const ns = text(request.ns)
  const ops = Array.isArray(request.ops) ? request.ops : []
  if (ns === undefined || ops.length === 0) return { ok: true }
  try {
    const revision = typeof request.expectedRevision === 'number' ? request.expectedRevision : undefined
    await settings.mutate(ns, ops, revision)
    const described = settings.describe({ redactSecrets: true }).find(entry => entry.ns === ns)
    return { ok: true, revision: described?.revision }
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * The conventional credential reference for a route, matching what the native
 * page derives so both name the same record.
 * @param {string} provider - the route id.
 * @returns the reference name.
 */
function derivedRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Read a nested member out of an untyped document.
 * @param {unknown} value - the document.
 * @param {readonly string[]} path - the member path.
 * @returns the value at the path, or undefined.
 */
function valueAt(value, path) {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = current[key]
  }
  return current
}

/**
 * The endpoints worth trying for one draft, in order.
 *
 * The base URL is a prefix, not a URL to resolve against, so a deployment path
 * such as `https://gateway.example/openai/v1` keeps its segments. A base that
 * already names a version is used as-is; otherwise `/v1` is tried first, which
 * is where both an OpenAI-style deployment and an Anthropic-style one keep the
 * listing, and the bare path is the fallback a few servers use instead.
 * @param {string} baseURL - the endpoint as the form shows it.
 * @returns candidate listing URLs.
 */
function candidatesFor(baseURL) {
  const base = baseURL.trim().replace(/\/+$/, '')
  return /\/v\d+$/.test(base)
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`]
}

/**
 * The header sets to try, most likely first, for one protocol.
 *
 * Anthropic's API authenticates with `x-api-key` while the relays that speak
 * the same wire format overwhelmingly authenticate with the OpenAI-style bearer
 * token, and the two are indistinguishable from the settings form. Rather than
 * make the user guess, a 401/403 on the first form is retried as the second.
 * @param {string} api - the protocol the form names.
 * @param {string | undefined} key - the credential, when there is one.
 * @returns header records to try in order; the last one is the fallback.
 */
function authForms(api, key) {
  if (key === undefined) return [{}]
  if (api !== 'anthropic-messages') return [{ authorization: `Bearer ${key}` }]
  return [
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { authorization: `Bearer ${key}` },
  ]
}

/**
 * One entry's positive-integer field, or `undefined`.
 * @param {...unknown} candidates - fields to test in order.
 * @returns the first usable count.
 */
function capacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/**
 * One entry's non-empty string field, or `undefined`.
 * @param {...unknown} candidates - fields to test in order.
 * @returns the first usable string.
 */
function text(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Read one reply into candidate models.
 *
 * `data` is OpenAI's and Anthropic's shape; `models` is Google's, which a
 * Gemini-style relay keeps. Entries without a usable id are skipped rather than
 * failing the whole reply: one malformed row should not deny the user the rest
 * of a working endpoint's catalog. Google names a model `models/gemini-x`, and
 * the prefix is addressing, not part of the id.
 * @param {unknown} body - the parsed reply.
 * @returns the models, or `undefined` when the shape is not a listing at all.
 */
function readListing(body) {
  const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : undefined
  if (raw === undefined) return undefined
  const models = []
  for (const entry of raw) {
    const id = text(entry?.id) ?? text(entry?.name)?.replace(/^models\//, '')
    if (id === undefined) continue
    const label = text(entry?.name, entry?.display_name, entry?.displayName)
    const contextWindow = capacity(entry?.context_window, entry?.context_length, entry?.inputTokenLimit)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens, entry?.outputTokenLimit)
    models.push({
      id,
      ...label === undefined || label === id ? {} : { name: label },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Read a reply body as JSON, under the byte ceiling — the declared length is
 * checked first so an honest server is refused without transferring anything,
 * and the accumulated total is what actually enforces the bound, because a
 * server that under-declares or streams tells us nothing up front.
 * @param {Response} response - the live reply.
 * @param {string} url - the URL it came from, for the message.
 * @returns the parsed JSON.
 * @throws {DiscoverError} on overflow or a non-JSON body.
 */
async function readJson(response, url) {
  const oversized = () => new DiscoverError(`${url} 返回的内容太大(超过 4 MB),不是模型清单。`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw oversized()
  }
  const reader = response.body?.getReader()
  let text = ''
  if (reader !== undefined) {
    const decoder = new TextDecoder()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw oversized()
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new DiscoverError(`${url} 返回的不是 JSON。`)
  }
}

/**
 * Ask one endpoint for its listing, walking the URL candidates and the auth
 * forms.
 *
 * The first candidate that answers with a model list wins. When none does, the
 * refusal shown is the most informative one rather than the last: a 401 says
 * something about the key and a connection error says something about the
 * address, while a 404 only means this deployment spells the path differently,
 * so it is reported only when nothing else turned up.
 * @param {string[]} urls - candidate URLs, in order.
 * @param {Record<string, string>[]} forms - auth header sets, in order.
 * @param {(url: string) => string} decorate - appends protocol-specific query.
 * @returns the models from the first candidate that answers with one.
 * @throws {DiscoverError} naming what went wrong, in the user's language.
 */
async function ask(urls, forms, decorate) {
  /** @type {DiscoverError | undefined} */
  let best
  const remember = (error) => {
    if (best === undefined || (best.kind === 'missing' && error.kind !== 'missing')) best = error
  }
  for (const url of urls) {
    const target = decorate(url)
    for (let index = 0; index < forms.length; index += 1) {
      let response
      try {
        response = await fetch(target, {
          method: 'GET',
          headers: { accept: 'application/json', ...forms[index] },
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          remember(new DiscoverError(`${target} 15 秒没有响应,连不上或地址不对。`))
          break
        }
        remember(new DiscoverError(`连不上 ${target}(${error instanceof Error ? error.message : String(error)})`))
        break
      }
      // A refusal the *other* auth form might fix is retried on the same URL;
      // anything else is this URL's verdict.
      if ((response.status === 401 || response.status === 403) && index + 1 < forms.length) {
        await response.body?.cancel().catch(() => {})
        continue
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {})
        remember(new DiscoverError(`${target} 不存在(404),这个地址没有模型清单接口。`, 'missing'))
        break
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        remember(new DiscoverError(response.status === 401 || response.status === 403
          ? `${target} 返回 ${response.status},密钥不对,或者这个接口不认这种密钥。`
          : `${target} 返回 ${response.status}。`))
        break
      }
      /** @type {ReturnType<typeof readListing> | undefined} */
      let models
      try {
        models = readListing(await readJson(response, target))
      } catch (error) {
        remember(error instanceof DiscoverError ? error : new DiscoverError(String(error)))
        break
      }
      if (models !== undefined) return models
      remember(new DiscoverError(`${target} 的返回里没有模型列表(没有 data / models 数组)。`))
      break
    }
  }
  throw best ?? new DiscoverError('没找到可用的模型清单接口。')
}

/**
 * The credential for one draft: whatever the form typed, else whatever the
 * named route already stored.
 *
 * A profile either carries the key inline or names a reference; the reference
 * is resolved through the credential seam first, which is what makes a key
 * stored in DSH's own store work, and through the process environment second,
 * which is what the settings page itself means by `apiKeyEnv`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} request - the draft.
 * @returns the key, or `undefined` for an unauthenticated probe.
 */
async function resolveKey(ctx, request) {
  const typed = text(request.apiKey)
  if (typed !== undefined) return typed
  const provider = text(request.provider)
  if (provider === undefined) return undefined
  const profile = profileOf(ctx, text(request.settingsNs), provider)
  const inline = text(profile?.apiKey)
  if (inline !== undefined) return inline
  const ref = text(profile?.apiKeyEnv)
  if (ref === undefined) return undefined
  try {
    const resolved = await ctx.get('credentials')?.resolve(ref)
    const value = text(resolved?.value)
    if (value !== undefined) return value
  } catch {
    // A composition without the credential seam, or a profile whose sibling
    // service rejected the name: the process environment is still worth asking.
  }
  return text(process.env[ref])
}

/**
 * One named route's stored profile, when the settings service has it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} settingsNs - the namespace the draft belongs to.
 * @param {string} provider - the route being edited.
 * @returns the profile object, or `undefined`.
 */
function profileOf(ctx, settingsNs, provider) {
  if (settingsNs === undefined) return undefined
  try {
    const providers = ctx.get('settings')?.get(settingsNs)?.providers
    const profile = providers?.[provider]
    return typeof profile === 'object' && profile !== null ? profile : undefined
  } catch {
    return undefined
  }
}

/**
 * What a named route's own adapter advertises, for a draft that names a route
 * but no endpoint. The installed catalog is the only thing that can answer
 * there, and it carries the capacities a listing would not disclose.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} provider - the route to read.
 * @returns the advertised models, or `undefined` when nothing is knowable.
 */
async function installedModels(ctx, provider) {
  /** @type {{ id: string, name?: unknown, contextWindow?: unknown, maxTokens?: unknown }[] | undefined} */
  let models
  try {
    models = await ctx.get('llm')?.listModels(provider)
  } catch {
    return undefined
  }
  if (!Array.isArray(models) || models.length === 0) return undefined
  return models.map(model => ({
    id: model.id,
    ...text(model.name) === undefined ? {} : { name: model.name },
    ...capacity(model.contextWindow) === undefined ? {} : { contextWindow: model.contextWindow },
    ...capacity(model.maxTokens) === undefined ? {} : { maxTokens: model.maxTokens },
  }))
}

/**
 * Answer one discovery draft.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown>} request - the draft the card sent.
 * @returns the models the endpoint advertises, in its own order.
 * @throws {DiscoverError} with a message fit to render under the form.
 */
async function discover(ctx, request) {
  const api = text(request.api) ?? 'openai-completions'
  const baseURL = text(request.baseURL)
  const provider = text(request.provider)
  if (baseURL === undefined) {
    const models = provider === undefined ? undefined : await installedModels(ctx, provider)
    if (models !== undefined) return models
    throw new DiscoverError('这个供应商没填 baseURL,没法去问它的模型清单。填上地址,或者在下面手动添加模型。')
  }
  const key = await resolveKey(ctx, request)
  const anthropic = api === 'anthropic-messages'
  return await ask(
    candidatesFor(baseURL),
    authForms(api, key),
    url => anthropic ? `${url}?limit=${String(ANTHROPIC_LIMIT)}` : url,
  )
}
