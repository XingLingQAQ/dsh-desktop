/**
 * The channel list the 渠道 tab renders.
 *
 * Everything comes from this desktop's own host route (`plugins/dsh-desktop-llm`),
 * the same way the MCP and Skills tabs reach their own host halves. That is not
 * a preference — it is the only path that works: DSH's client-side `connection`
 * handle no longer carries an `api` member (the build that ships here exposes
 * `isLoopback/generation/state/rpc/reconnect/…` instead), so the
 * `connection.api.settings.describe(...)` calls the native Models page makes are
 * not reachable from a plugin. The Host's `settings`, `credentials` and `llm`
 * services are what those calls were a projection of, and they are stable.
 *
 * Same-origin, no CORS, no preflight, no bridge token, no private client API to
 * track — and a change to the connection handle cannot break this page again.
 */

/** The route prefix `plugins/dsh-desktop-llm` serves. */
const ENDPOINT = '/dsh-desktop-llm/api'

/** One channel, as the host route reports it. */
export interface ChannelRow {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  /** The route was hand-declared rather than shipped. */
  declared?: boolean
  /** The route is registered with an adapter and can serve requests. */
  active: boolean
  /** A profile exists at the route's settings path. */
  configured: boolean
  /** The credential reference the profile names, when it names one. */
  keyRef?: string | undefined
  /** That reference holds a stored secret. */
  keyConfigured: boolean
  /** The namespace revision the read was taken at, for a conflict-checked write. */
  revision?: number | undefined
}

/** The host route's reply for the provider list. */
interface ProviderReply {
  ok?: boolean
  writable?: boolean
  providers?: ChannelRow[]
  error?: { message?: string }
}

/**
 * One call on the host route.
 *
 * `text/plain` keeps the POST CORS-simple: the route answers no preflight, and
 * a JSON content-type would trigger one. Same convention `mcp.ts` follows.
 * @param method - the route method name.
 * @param body - the request body, when the method takes one.
 * @returns the parsed reply.
 */
async function call<T extends { ok?: boolean; error?: { message?: string } }>(
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${ENDPOINT}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`渠道接口调用失败（${String(response.status)}）`)
  const payload = (await response.json()) as T
  if (payload.ok === false) throw new Error(payload.error?.message ?? '未知错误')
  return payload
}

/** Read every channel, its stored profile, and its key state. */
export async function readProviders(): Promise<{ writable: boolean; providers: ChannelRow[] }> {
  const reply = await call<ProviderReply>('providers')
  return { writable: reply.writable !== false, providers: reply.providers ?? [] }
}

/**
 * Store one channel's key.
 *
 * `attachRef` says whether the profile should be pointed at the derived
 * reference. It is true only when the profile named none — a route with its own
 * auth path must not be handed one, and the host honours that flag rather than
 * deciding for itself, because only the page knows whether a reference is
 * already recorded.
 * @param row - the channel being edited.
 * @param value - the key.
 * @param attachRef - whether to record the reference on the profile.
 */
export async function saveKey(
  row: ChannelRow,
  value: string,
  attachRef: boolean,
): Promise<void> {
  await call('credential', {
    provider: row.provider,
    settingsNs: row.settingsNs,
    settingsPath: row.settingsPath,
    ref: row.keyRef,
    value,
    attachRef,
  })
}

/**
 * Write one channel profile's advanced fields.
 * @param ns - the settings namespace.
 * @param ops - the path ops, one per field actually changed.
 * @param expectedRevision - the revision the read was taken at.
 * @returns the revision the write left behind, when the host reports one.
 */
export async function writeAdvanced(
  ns: string,
  ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[],
  expectedRevision?: number,
): Promise<{ revision?: number }> {
  return await call<{ ok?: boolean; revision?: number }>('advanced', {
    ns,
    ops,
    expectedRevision,
  })
}

/** One settings namespace, as `describe` reports it (secrets already redacted). */
export interface NamespaceView {
  ns: string
  schema: unknown
  value: unknown
  user: unknown
  base: unknown
  revision: number
  applies?: string | undefined
}

/** Read every namespace the settings document holds, for the advanced form. */
export async function readNamespaces(): Promise<{
  writable: boolean
  namespaces: Map<string, NamespaceView>
}> {
  const reply = await call<{
    ok?: boolean
    writable?: boolean
    namespaces?: Array<{
      ns: string
      schema: unknown
      value: unknown
      user?: unknown
      base?: unknown
      revision: number
      applies?: string
    }>
  }>('describe')
  return {
    writable: reply.writable !== false,
    namespaces: new Map((reply.namespaces ?? []).map(entry => [entry.ns, {
      ns: entry.ns,
      schema: entry.schema,
      value: entry.value,
      user: entry.user,
      base: entry.base,
      revision: entry.revision,
      applies: entry.applies,
    } satisfies NamespaceView])),
  }
}
