/**
 * Ambient declarations for the packages the vendored models page imports for
 * *types only*.
 *
 * These are real packages in the DSH tree, but not ones a plugin bundle may
 * `require`: the platform hands out a fixed set of module words, and neither
 * the API-remotes package nor the settings/locale slot-map merges are among
 * them. Every import of them in the vendored code is `import type` (or a bare
 * `import type {}` that exists purely to pull a `declare module` merge into the
 * program), so nothing is emitted for any of them at build time — the risk is
 * only that the type checker cannot resolve the names.
 *
 * The shapes below are the subset the vendored files actually name. They are
 * structural and deliberately loose: this file's job is to let the code
 * compile and to document where the boundary is, not to re-derive a wire
 * contract that lives in another repository.
 */

declare module '@deepseek-ai/dsh-api-remotes/client' {
  /** One `{result:{ok,...}}` envelope, as the host answers. */
  export interface RpcEnvelope<T> {
    result: { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
  }

  /** One stored credential's descriptor, never its value. */
  export interface CredentialView {
    configured: boolean
    writable: boolean
  }

  /** One registered settings namespace, as the wire describes it. */
  export interface SettingsNamespaceView {
    ns: string
    schema: unknown
    value: unknown
    base?: unknown
    user?: unknown
    applies: 'live' | 'restart'
    secrets: { path: string[]; set: boolean }[]
    revision: number
  }

  /** One path-addressed settings edit. */
  export type SettingsPathOpView =
    | { op: 'set'; path: string[]; value: unknown }
    | { op: 'unset'; path: string[] }

  /** One model an endpoint advertised. */
  export interface DiscoveredModelView {
    id: string
    name?: string
    contextWindow?: number
    maxTokens?: number
  }

  /** The wire client the models page reads and writes through. */
  export interface IApiClient {
    settings: {
      describe(request: Record<string, never>): Promise<RpcEnvelope<{
        writable: boolean
        hasDocument: boolean
        namespaces: SettingsNamespaceView[]
      }>>
      mutate(request: {
        ns: string
        ops: SettingsPathOpView[]
        expectedRevision?: number
      }): Promise<RpcEnvelope<SettingsNamespaceView>>
    }
    credentials: {
      describe(request: { refs: string[] }): Promise<RpcEnvelope<{ credentials: Record<string, CredentialView> }>>
      set(request: { ref: string; value: string }): Promise<RpcEnvelope<unknown>>
    }
    llm: {
      providers(request: Record<string, never>): Promise<RpcEnvelope<{
        providers: { provider: string; displayName: string; settingsNs: string; settingsPath: string[]; active: boolean; declared?: boolean }[]
      }>>
      discoverModels(request: Record<string, unknown>): Promise<RpcEnvelope<{ models: DiscoveredModelView[] }>>
    }
  }

  /** The client connection service, as the models plugin consumes it. */
  export interface ConnectionHandle {
    api: IApiClient
    isLoopback: boolean
    hostDescription: {
      getSnapshot(): unknown
      subscribe(listener: () => void): () => void
    }
    rpc: unknown
    start(sinks: unknown, config?: unknown): { stop(): void }
  }
}

// Bare type-imports in the vendored files pull these merges in by reference;
// declaring the modules empty is what keeps those lines resolvable.
declare module '@deepseek-ai/dsh-client-ui-settings/client'
declare module '@deepseek-ai/dsh-client-locale/client'
declare module '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
declare module '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
