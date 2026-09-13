/**
 * The page's half of model listing (`plugins/dsh-desktop-llm`).
 *
 * DSH's own discovery (`llm-pi-ai`'s) interrogates only the two OpenAI-shaped
 * protocols and answers every other one with a refusal, so a hand-declared
 * gateway speaking `anthropic-messages` can never list its models. This calls
 * the desktop plugin instead, which reads the listing with Node's fetch and
 * resolves a saved route's credential on the Host side — where the key actually
 * lives, since a settings page only ever holds a reference to it.
 *
 * The route is served by the DSH web app's own server, so this is a same-origin
 * call: nothing to do with CORS, no bridge token, no Tauri IPC.
 */

/** Route the host half registers on the web app's own server. */
const ENDPOINT = '/dsh-desktop-llm/api/discover'

/** One candidate the card offers for adoption. */
interface ListedModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/**
 * What the card consumes. Structurally the envelope `api.llm.discoverModels`
 * answers, so the native model-list editor reads this exactly as it read the
 * host's — `result.ok`, then `result.value.models` or `result.error.message`.
 */
export type DiscoveryReply =
  | { result: { ok: true; value: { models: ListedModel[] } } }
  | { result: { ok: false; error: { message: string } } }

/** The request the card builds; every field is optional in a draft. */
interface DiscoveryRequest {
  settingsNs?: string
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

/** A refusal the card renders under the form. */
function failed(message: string): DiscoveryReply {
  return { result: { ok: false, error: { message } } }
}

/** Keep one candidate only if the card can render and store it. */
function usable(value: unknown): value is ListedModel {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry['id'] !== 'string' || entry['id'].length === 0) return false
  // Capacities are optional but must be numbers: the editor writes them
  // straight into the model row, and a string would be stored as one.
  for (const key of ['contextWindow', 'maxTokens']) {
    const count = entry[key]
    if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count <= 0)) {
      delete entry[key]
    }
  }
  if (entry['name'] !== undefined && typeof entry['name'] !== 'string') delete entry['name']
  return true
}

/**
 * Ask the desktop for one endpoint's models.
 * @param request - the draft: settings namespace, route, endpoint, protocol, key.
 * @param signal - optional cancellation for the round trip.
 * @returns the envelope the native editor expects.
 */
export async function discoverModels(
  request: DiscoveryRequest,
  signal?: AbortSignal,
): Promise<DiscoveryReply> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      // Same-origin, so this is not about preflight tolerance: text/plain keeps
      // the request indistinguishable from the bridge's own posts.
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw error
    return failed(
      '桌面端的模型列表服务没响应。插件 dsh-desktop-llm 可能被暂停了,去插件列表启用它再试。'
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (response.status === 404) {
    return failed('桌面端没有运行「模型列表」插件(dsh-desktop-llm),去插件列表启用它再试。')
  }
  let payload: { ok?: unknown; models?: unknown; error?: { message?: unknown } }
  try {
    payload = await response.json() as typeof payload
  } catch {
    return failed(`模型列表服务返回了看不懂的内容(HTTP ${String(response.status)})。`)
  }
  if (payload.ok !== true) {
    const message = payload.error?.message
    return failed(typeof message === 'string' && message.length > 0
      ? message
      : `模型列表服务返回了 ${String(response.status)}。`)
  }
  const models = Array.isArray(payload.models) ? payload.models.filter(usable) : []
  return { result: { ok: true, value: { models } } }
}
