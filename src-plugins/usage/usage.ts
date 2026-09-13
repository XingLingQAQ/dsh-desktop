/**
 * The page's half of the usage dashboard (`plugins/dsh-desktop-usage`).
 *
 * The history it charts is only on disk, and only the Host can read it: the
 * session logs sit under the harness home, compressed frame by frame. So the
 * page asks the desktop plugin, which folds them, over a route served by the
 * DSH web app's own server — same-origin, so nothing here deals with CORS, a
 * bridge token, or Tauri IPC.
 */

/** Route the host half registers on the web app's own server. */
const ENDPOINT = '/dsh-desktop-usage/api/summary'

/** A failure the panel renders instead of the dashboard. */
export class UsageError extends Error {}

/** Token counts over the whole history, in four buckets. */
export interface UsageTotals {
  sessions: number
  turns: number
  steps: number
  messages: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
  toolErrors: number
}

/** One calendar day's figures; only days with activity are present. */
export interface UsageDay {
  date: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
  toolCalls: number
  toolErrors: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  /** Present only on days a session began. */
  sessions?: number
}

/** One tool's call count and how many of them failed. */
export interface UsageTool {
  name: string
  calls: number
  errors: number
}

/** One model route's usage. */
export interface UsageModel {
  model: string
  messages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** One project directory's usage. */
export interface UsageProject {
  project: string
  sessions: number
  turns: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmMs: number
  toolMs: number
}

/** One session, as the table lists it. */
export interface UsageSessionRow {
  id: string
  createdAt: number
  endedAt: number
  project: string
  cwd: string
  agentPreset: string
  turns: number
  steps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  model: string
  reasons: Record<string, number>
}

/** The whole dashboard payload. */
export interface UsageSummary {
  generatedAt: number
  range: { from: number; to: number; days?: number }
  totals: UsageTotals
  daily: UsageDay[]
  tools: UsageTool[]
  models: UsageModel[]
  projects: UsageProject[]
  sessions: UsageSessionRow[]
}

/** Keep one value only when the shape the charts assume actually holds. */
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Reshape the reply, so a partial payload degrades instead of throwing. */
function normalize(payload: Record<string, unknown>): UsageSummary {
  const totals = (payload['totals'] ?? {}) as Record<string, unknown>
  const totalsOut = {} as UsageTotals
  for (const key of [
    'sessions', 'turns', 'steps', 'messages', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps',
    'decodeMs', 'decodeTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens',
    'cacheWriteTokens', 'toolCalls', 'toolErrors',
  ] as const) {
    totalsOut[key] = number(totals[key])
  }
  return {
    generatedAt: number(payload['generatedAt']),
    range: (payload['range'] ?? { from: 0, to: 0 }) as UsageSummary['range'],
    totals: totalsOut,
    daily: Array.isArray(payload['daily']) ? payload['daily'] as UsageDay[] : [],
    tools: Array.isArray(payload['tools']) ? payload['tools'] as UsageTool[] : [],
    models: Array.isArray(payload['models']) ? payload['models'] as UsageModel[] : [],
    projects: Array.isArray(payload['projects']) ? payload['projects'] as UsageProject[] : [],
    sessions: Array.isArray(payload['sessions']) ? payload['sessions'] as UsageSessionRow[] : [],
  }
}

/**
 * Read the whole-history figures.
 * @param signal - optional cancellation for the round trip.
 * @returns the aggregate the dashboard renders.
 * @throws {UsageError} when the desktop plugin is missing or answered badly.
 */
export async function readUsage(signal?: AbortSignal): Promise<UsageSummary> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      // Same-origin, so this is not about preflight tolerance: text/plain keeps
      // the request indistinguishable from the bridge's own posts.
      headers: { 'content-type': 'text/plain' },
      body: '{}',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new UsageError(
      '桌面端的用量服务没响应。插件 dsh-desktop-usage 可能被暂停了,去插件列表启用它再试。'
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (response.status === 404) {
    throw new UsageError('桌面端没有运行「用量」插件(dsh-desktop-usage),去插件列表启用它再试。')
  }
  let payload: { ok?: unknown; error?: { message?: unknown } } & Record<string, unknown>
  try {
    payload = await response.json() as typeof payload
  } catch {
    throw new UsageError(`用量服务返回了看不懂的内容(HTTP ${String(response.status)})。`)
  }
  if (payload.ok !== true) {
    const message = payload.error?.message
    throw new UsageError(typeof message === 'string' && message.length > 0
      ? message
      : `用量服务返回了 ${String(response.status)}。`)
  }
  return normalize(payload)
}
