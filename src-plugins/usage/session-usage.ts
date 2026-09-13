/**
 * One session's durable figures, read from the desktop plugin's host half.
 *
 * The conversation's own projections answer everything about the live log —
 * context pressure, step timing, billed tokens — but they carry no tool tally
 * and no turn-end reasons, and both of those are what the fold on disk already
 * computes for the dashboard. So the panel asks for exactly the one session it
 * is showing rather than re-deriving a second, partial copy in the page.
 *
 * A session with no artifact yet is a normal answer, not a failure: it comes
 * back as null and the panel falls back to the live projections.
 */

import { UsageError } from './usage.ts'

/** Route the host half serves one session on. */
const ENDPOINT = '/dsh-desktop-usage/api/session'

/** One tool's call count in this session, and how many of them failed. */
export interface SessionToolUse {
  name: string
  calls: number
  errors: number
}

/** One model route's share of this session. */
export interface SessionModelUse {
  name: string
  messages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Why turns ended, as the engine reported it. */
export interface SessionReason {
  kind: string
  count: number
}

/** Everything the fold knows about one session. */
export interface SessionDetail {
  id: string
  createdAt: number
  endedAt: number
  durationMs: number
  cwd: string
  agentPreset: string
  turns: number
  steps: number
  messages: number
  toolCalls: number
  toolErrors: number
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
  model: string
  provider: string
  tools: SessionToolUse[]
  models: SessionModelUse[]
  reasons: SessionReason[]
}

/**
 * Read one session's durable figures.
 * @param id - the session id the conversation is showing.
 * @param signal - optional cancellation for the round trip.
 * @returns the session, or null when its log has not been written yet.
 * @throws {UsageError} when the desktop plugin is missing or answered badly.
 */
export async function readSession(id: string, signal?: AbortSignal): Promise<SessionDetail | null> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ id }),
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
  let payload: { ok?: unknown; session?: unknown; error?: { message?: unknown } }
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
  return payload.session === null || payload.session === undefined
    ? null
    : payload.session as SessionDetail
}
