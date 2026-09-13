/**
 * MCP servers, from the page.
 *
 * The servers themselves live in the Host process: the configuration document,
 * one connection per enabled record, and the registry the model reads its tools
 * from. None of that is reachable from here, so every read and every edit goes
 * to this desktop's own host route (`plugins/dsh-desktop-mcp`), which is
 * mounted on the same server that serves this page — hence no CORS, no
 * preflight, and no bridge token, unlike `skills.ts`, whose subject is the
 * filesystem and which therefore goes through the desktop bridge.
 */

/** Route prefix registered by the host half. */
const ENDPOINT = '/dsh-desktop-mcp/api'

/** Which transport a server speaks. */
export type McpTransport = 'stdio' | 'streamable-http'

/** Lifecycle of the connection serving one server, as the Host reports it. */
export type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** Which map a field belongs to; the transport decides which one is in play. */
export type FieldGroup = 'env' | 'headers'

/**
 * How one field's value is handled.
 *
 * `text` is stored and shown like any other setting. `secret` is stored but
 * never sent back to this page — the editor sees that a value exists and can
 * replace it, which is the whole point of the distinction.
 */
export type FieldKind = 'text' | 'secret'

/** One environment variable or request header, as the editor sees it. */
export interface McpField {
  group: FieldGroup
  name: string
  kind: FieldKind
  /** The stored value; always empty for a secret, which is never sent here. */
  value: string
  /** Whether the Host holds a value for this field at all. */
  set: boolean
  /** A secret whose stored value already carries the `Bearer ` scheme. */
  bearer: boolean
}

/** One tool a server currently contributes. */
export interface McpTool {
  /** The server's own tool name, without the `mcp__<server>__` namespace. */
  name: string
  description: string
}

/** One server as it stands right now. */
export interface McpServer {
  serverName: string
  enabled: boolean
  transport: McpTransport
  /** stdio only: the executable. */
  command: string
  /** stdio only. */
  args: readonly string[]
  /** stdio only. */
  cwd: string
  /** streamable-http only. */
  url: string
  toolCallTimeoutMs: number
  fields: readonly McpField[]
  phase: FiberPhase
  /** Why the mount itself failed, when it did. Not the connection's reason. */
  error: string | null
  toolCount: number
  tools: readonly McpTool[]
}

/** The whole catalog's live state. */
export interface McpState {
  servers: readonly McpServer[]
  /** Set when the Host could not read its own configuration document. */
  loadError: string | null
}

/** One field row being submitted. */
export interface FieldDraft {
  group: FieldGroup
  name: string
  kind: FieldKind
  /**
   * The new value. For a secret this is only read when `keep` is false; leaving
   * it out is what lets an edit pass through a credential the page never had.
   */
  value?: string
  /** Secret rows only: false replaces the stored value, true (the default) keeps it. */
  keep?: boolean
  /** Secret rows only: store the value with the `Bearer ` scheme. */
  bearer?: boolean
}

/** One server being created or saved. */
export interface ServerDraft {
  serverName: string
  /** The name being replaced, when this is a rename. */
  fromServerName?: string
  enabled: boolean
  transport: McpTransport
  command?: string
  args?: readonly string[]
  cwd?: string
  url?: string
  toolCallTimeoutMs?: number
  fields: readonly FieldDraft[]
}

/** What a direct probe of one server found. */
export interface McpDiagnosis {
  ok: boolean
  detail: string
}

interface Reply {
  ok?: boolean
  servers?: McpServer[]
  loadError?: string | null
  detail?: string
  error?: { message?: string }
}

async function call(method: string, body?: unknown): Promise<Reply> {
  // text/plain keeps the POST a CORS-simple request: the host route answers no
  // preflight, and a JSON content-type would trigger one.
  const response = await fetch(`${ENDPOINT}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) throw new Error(`MCP 接口调用失败 (${String(response.status)})`)
  const payload = (await response.json()) as Reply
  if (payload.ok === false) throw new Error(payload.error?.message ?? '未知错误')
  return payload
}

/** Read every server's live state and tool list. */
export async function readMcpState(): Promise<McpState> {
  const reply = await call('state')
  return { servers: reply.servers ?? [], loadError: reply.loadError ?? null }
}

/** Create, replace or rename one server. Returns the state it produced. */
export async function saveMcpServer(draft: ServerDraft): Promise<McpState> {
  const reply = await call('upsert', draft)
  return { servers: reply.servers ?? [], loadError: null }
}

/** Remove one server from the document. */
export async function deleteMcpServer(serverName: string): Promise<McpState> {
  const reply = await call('delete', { serverName })
  return { servers: reply.servers ?? [], loadError: null }
}

/** Take one server out of service, or put it back. */
export async function setMcpEnabled(serverName: string, enabled: boolean): Promise<McpState> {
  const reply = await call(enabled ? 'resume' : 'pause', { serverName })
  return { servers: reply.servers ?? [], loadError: null }
}

/** Drop one server's connection and mount a fresh one from the same record. */
export async function reconnectMcp(serverName: string): Promise<McpState> {
  const reply = await call('reconnect', { serverName })
  return { servers: reply.servers ?? [], loadError: null }
}

/** Ask one silent server directly why it is producing no tools. */
export async function diagnoseMcp(serverName: string): Promise<McpDiagnosis> {
  const reply = await call('diagnose', { serverName })
  return { ok: reply.ok === true, detail: reply.detail ?? '(没有结果)' }
}
