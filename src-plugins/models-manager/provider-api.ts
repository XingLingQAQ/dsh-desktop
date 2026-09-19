/**
 * The wire face the vendored models page talks to, backed by this desktop's own
 * host route.
 *
 * The page is DSH's own `ui-settings-models`, vendored into `native/` and
 * rendered here. It wants an `IApiClient` — `settings.describe/mutate`,
 * `credentials.describe/set`, `llm.providers/discoverModels` — which it normally
 * receives from the client `connection` service. This desktop cannot use that
 * service: the build that ships has a `connection` handle with no `api` member
 * at all (`isLoopback/generation/state/rpc/reconnect/…`), so the interface is
 * reimplemented over `plugins/dsh-desktop-llm`, which calls the same Host
 * services the wire calls were a projection of.
 *
 * The envelope shape is kept exactly (`{result:{ok:true,value}}` /
 * `{result:{ok:false,error}}`) because the vendored page reads
 * `response.result.ok` in a dozen places; translating here means none of that
 * code changes.
 */

/** One answer in the shape the page expects. */
type Envelope<T> =
  | { result: { ok: true; value: T } }
  | { result: { ok: false; error: { code?: string; message: string } } }

/** The route prefix `plugins/dsh-desktop-llm` serves. */
const ENDPOINT = '/dsh-desktop-llm/api'

/**
 * One call on the host route, always answering an envelope.
 *
 * Failures are folded into the refusal arm rather than thrown: the page treats
 * `ok:false` as a business answer it renders, and an exception thrown out of an
 * `async` member would instead reject the promise at a call site that does not
 * catch.
 * @param method - the route method name.
 * @param body - the request body.
 * @returns the envelope.
 */
async function call<T>(method: string, body?: unknown): Promise<Envelope<T>> {
  try {
    const response = await fetch(`${ENDPOINT}/${method}`, {
      method: 'POST',
      // text/plain keeps the POST CORS-simple: the route answers no preflight,
      // and a JSON content-type would trigger one.
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(body ?? {}),
    })
    if (!response.ok) {
      return { result: { ok: false, error: { message: `接口调用失败（${String(response.status)}）` } } }
    }
    const payload = (await response.json()) as { ok?: boolean; error?: { message?: string }; [key: string]: unknown }
    if (payload.ok === false) {
      return { result: { ok: false, error: { message: payload.error?.message ?? '未知错误' } } }
    }
    return { result: { ok: true, value: payload as unknown as T } }
  } catch (error) {
    return {
      result: {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      },
    }
  }
}

/**
 * Build the api face the models page reads and writes through.
 * @returns an `IApiClient`-shaped object over the host route.
 */
export function createProviderApi() {
  return {
    settings: {
      describe: async () => {
        const answer = await call<{
          writable: boolean
          namespaces: unknown[]
        }>('describe')
        if (!answer.result.ok) return answer
        return {
          result: {
            ok: true as const,
            value: {
              writable: answer.result.value.writable,
              hasDocument: true,
              namespaces: answer.result.value.namespaces,
            },
          },
        }
      },
      mutate: async (request: {
        ns: string
        ops: readonly unknown[]
        expectedRevision?: number
      }) => {
        const answer = await call<{ revision?: number }>('advanced', {
          ns: request.ns,
          ops: request.ops,
          expectedRevision: request.expectedRevision,
        })
        if (!answer.result.ok) return answer
        // The write answers with the new revision but not the namespace view,
        // and the page wants the view. Re-reading one namespace is cheaper and
        // more honest than reconstructing what the document now holds — the
        // host redacts secrets on the way out, so a locally-merged copy would
        // be subtly different from the next read.
        const described = await call<{ namespaces: Record<string, unknown>[] }>('describe')
        if (!described.result.ok) return described
        const found = (described.result.value.namespaces as { ns?: string }[])
          .find(entry => entry.ns === request.ns)
        if (found === undefined) {
          return { result: { ok: false as const, error: { message: `设置命名空间 ${request.ns} 不存在` } } }
        }
        return { result: { ok: true as const, value: found } }
      },
    },
    credentials: {
      describe: async (request: { refs: string[] }) =>
        call<{ credentials: Record<string, { configured: boolean; writable: boolean }> }>(
          'describe-credentials',
          request,
        ),
      set: async (request: { ref: string; value: string }) =>
        call<unknown>('credential', { ref: request.ref, value: request.value }),
    },
    llm: {
      providers: async () =>
        call<{ providers: unknown[] }>('providers'),
      discoverModels: async (request: Record<string, unknown>) =>
        call<{ models: unknown[] }>('discover', request),
    },
  }
}

/** What the describe mirror holds: the namespace views plus writability. */
export interface SettingsView {
  writable: boolean
  namespaces: { ns: string; revision: number }[]
}

/**
 * The describe face the models store takes.
 *
 * The real one is a shared mirror (`SettingsDescribeMirror`) that every
 * settings surface reads through, kept fresh by pushed invalidations. There is
 * one surface here, so the mirror is reduced to its contract: hold the last
 * answer, be able to re-read on demand, and subscribe. The store only ever
 * calls `ensure()` then `getSnapshot()`, and re-reads after a write, so a
 * one-shot read is enough.
 */
export function createDescribeFace() {
  const listeners = new Set<() => void>()
  let view: { writable: boolean; namespaces: unknown[] } | undefined
  let error: string | undefined
  let inFlight: Promise<void> | undefined

  const read = async (): Promise<void> => {
    const answer = await call<{ writable: boolean; namespaces: unknown[] }>('describe')
    if (answer.result.ok) {
      view = answer.result.value
      error = undefined
    } else {
      error = answer.result.error.message
    }
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => ({ view, error, status: view === undefined ? 'idle' as const : 'ready' as const }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ensure: async () => {
      inFlight ??= read().finally(() => { inFlight = undefined })
      return await inFlight
    },
  }
}
