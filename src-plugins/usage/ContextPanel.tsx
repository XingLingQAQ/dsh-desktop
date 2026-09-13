/**
 * The composer's usage control and the analysis popover it opens.
 *
 * Two sources feed it, and the split is deliberate. The conversation's own
 * projections answer everything the live log can answer — context pressure and
 * composition, step counts and wall times, billed tokens — and they update as
 * the turn streams, so the panel is never stale while it is open. The fold on
 * disk adds what no projection carries: the tool tally, the model split, and
 * why turns ended. That second half arrives from the plugin's host half and is
 * simply absent for a session whose log has not been written yet, so the
 * panel's figures prefer it and fall back to the projections field by field.
 *
 * The popover is anchored to its own trigger rather than the viewport, so it
 * inherits the composer's clipping and stacking instead of fighting them.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconCopyOutline16,
  IconDataOutline16,
  IconRefreshOutline16,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { readSession, type SessionDetail } from './session-usage.ts'

/** Newest request pressure paired with the newest known route capacity. */
interface ContextPressure {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

/** Heuristic composition of the next request's context. */
interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** Whole-log turn/step counts and wall times. */
interface SessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

/** Cumulative provider usage for the complete log, in four disjoint buckets. */
interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The projection keys this panel reads. */
interface Projections {
  contextPressure: ContextPressure | undefined
  contextBreakdown: ContextBreakdown | undefined
  sessionStats: SessionStats | undefined
  tokenUsage: TokenUsage | undefined
}

/** The seat a tool-row slot entry is handed by the composer. */
export interface ContextPanelProps {
  sessionId?: string
  useProjection: <K extends keyof Projections>(key: K) => Projections[K] | undefined
}

/** Ring geometry: 16px viewBox, 2px stroke, so the arc's length is 2πr. */
const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Occupancy bands, as percentages of the context window. */
const WARN = 70
const DANGER = 90

/** How long the copy button keeps its success mark, in ms. */
const COPIED_MS = 1200

/** How the composition segments are tinted, in bar order. */
const SEGMENTS = [
  { key: 'systemTokens', label: '系统提示', tint: 'var(--dsw-static-neutral-bluish-400)' },
  { key: 'toolsTokens', label: '工具定义', tint: 'rgb(167, 139, 250)' },
  { key: 'messageTokens', label: '对话消息', tint: 'var(--dsw-static-blue-450)' },
] as const

/** Turn-end kinds, as the engine reports them, in the user's words. The map is
 * merge-extensible upstream, so an unrecognised kind falls back to its raw
 * name rather than being hidden. `aborted` is a cancellation that landed
 * mid-turn; `interrupted` is a turn the backend closed after a crash. */
const REASONS: Record<string, string> = {
  completed: '正常结束',
  aborted: '被取消',
  blocked: '被阻塞',
  error: '出错',
  interrupted: '异常中断',
  'max-tokens': '超出长度',
}

/**
 * Compact token count: 517 / 12.2K / 1.2M.
 * @param n - token count.
 * @returns display string.
 */
function tokens(n: number): string {
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Compact duration: 840ms / 45.2s / 2m42s / 1h05m.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
function duration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))}ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${String(s)}s`
  const whole = Math.round(ms / 1_000)
  if (whole < 3_600) return `${String(Math.floor(whole / 60))}m${String(whole % 60).padStart(2, '0')}s`
  const minutes = Math.floor(whole / 60)
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * One decimal place, without a trailing `.0`.
 * @param value - the ratio as a percentage, or null when it has no denominator.
 * @returns display string.
 */
function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${String(Number(value.toFixed(1)))}%`
}

/** A count with thousands separators. */
function count(n: number): string {
  return n.toLocaleString('zh-CN')
}

/**
 * `09-12 19:31` — the same shape the history table uses, and four characters
 * shorter than a full date, which is the difference between fitting the header
 * and wrapping it.
 * @param ms - epoch milliseconds.
 * @returns display string.
 */
function stamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The tint that reads as the occupancy's severity. */
function toneFor(percent: number | null): string {
  if (percent !== null && percent >= DANGER) return 'var(--dsw-alias-state-error-primary)'
  if (percent !== null && percent >= WARN) return 'var(--dsw-alias-state-warn-primary)'
  return 'var(--dsw-alias-brand-primary)'
}

/** One labelled figure in a section grid. */
function Cell({ label, value, tone, note }: {
  label: string
  value: string
  tone?: 'bad'
  note?: string
}): ReactNode {
  return (
    <div className="dsx-ctx-cell">
      <span className="dsx-ctx-cellLabel">{label}</span>
      <span className="dsx-ctx-cellValue" data-tone={tone}>{value}</span>
      {note !== undefined && <span className="dsx-ctx-cellLabel">{note}</span>}
    </div>
  )
}

/** A bordered band with a small caps heading. */
function Section({ title, note, children }: {
  title: string
  note?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="dsx-ctx-section">
      <p className="dsx-ctx-sectionTitle">
        <span>{title}</span>
        {note !== undefined && <span>{note}</span>}
      </p>
      {children}
    </div>
  )
}

/**
 * The composer's usage gauge and its click-open panel.
 * @param props - the slot seat: the session being shown and the projection reader.
 */
export function ContextPanel({ sessionId, useProjection }: ContextPanelProps): ReactNode {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const stats = useProjection('sessionStats')
  const usage = useProjection('tokenUsage')

  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const root = useRef<HTMLSpanElement | null>(null)
  const copyTimer = useRef(0)

  // Outside pointer and Escape close, matching the surface this control
  // replaces; the listener exists only while the panel does.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // A pending timer would otherwise fire into an unmounted panel.
  useEffect(() => () => { window.clearTimeout(copyTimer.current) }, [])

  // The panel is per session; a switch must not leave the previous one's
  // figures on screen while the new fetch is in flight.
  useEffect(() => {
    setDetail(null)
    setFailure(null)
    setCopied(false)
  }, [sessionId])

  useEffect(() => {
    if (!open || sessionId === undefined) return
    const controller = new AbortController()
    setPending(true)
    readSession(sessionId, controller.signal)
      .then((session) => {
        setDetail(session)
        setFailure(null)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false)
      })
    return () => { controller.abort() }
  }, [open, sessionId, epoch])

  const occupancy = useMemo(() => {
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens
    const capacity = pressure?.contextWindow
    if (used === undefined || capacity === undefined || capacity <= 0) return null
    return {
      used,
      capacity,
      percent: Math.min(100, Math.round(used / capacity * 100)),
      headroom: Math.max(0, capacity - used),
    }
  }, [pressure])

  const figures = useMemo(() => {
    const turns = detail?.turns ?? stats?.turns ?? 0
    const steps = detail?.steps ?? stats?.steps ?? 0
    const llmMs = detail?.llmMs ?? stats?.llmMs ?? 0
    const toolMs = detail?.toolMs ?? stats?.toolMs ?? 0
    const ttftMs = detail?.ttftMs ?? stats?.ttftMs ?? 0
    const ttftSteps = detail?.ttftSteps ?? stats?.ttftSteps ?? 0
    const decodeMs = detail?.decodeMs ?? stats?.decodeMs ?? 0
    const decodeTokens = detail?.decodeTokens ?? stats?.decodeTokens ?? 0
    const uncached = detail?.inputTokens ?? usage?.uncachedInputTokens ?? 0
    const cacheRead = detail?.cacheReadTokens ?? usage?.cacheReadTokens ?? 0
    const cacheWrite = detail?.cacheWriteTokens ?? usage?.cacheWriteTokens ?? 0
    const output = detail?.outputTokens ?? usage?.outputTokens ?? 0
    const billed = uncached + cacheRead + cacheWrite
    const prompt = uncached + cacheRead
    const toolCalls = detail?.toolCalls ?? 0
    return {
      turns, steps, llmMs, toolMs, billed, uncached, cacheRead, cacheWrite, output,
      cacheHit: billed > 0 ? cacheRead / billed * 100 : null,
      speed: decodeMs > 0 ? decodeTokens / (decodeMs / 1_000) : null,
      ttft: ttftSteps > 0 ? ttftMs / ttftSteps : null,
      perTurn: turns > 0 ? billed / turns : null,
      perStep: steps > 0 ? output / steps : null,
      ioRatio: prompt > 0 ? output / prompt * 100 : null,
      toolShare: llmMs + toolMs > 0 ? toolMs / (llmMs + toolMs) * 100 : null,
      failRate: toolCalls > 0 ? (detail?.toolErrors ?? 0) / toolCalls * 100 : null,
      // How many more turns this conversation can hold at its own average
      // prompt, which is what "will it fit" actually means to the reader.
      turnsLeft: occupancy !== null && turns > 0 && billed > 0
        ? Math.floor(occupancy.headroom / (billed / turns))
        : null,
    }
  }, [detail, stats, usage, occupancy])

  const tone = toneFor(occupancy?.percent ?? null)
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? []
    : SEGMENTS.map(segment => ({
      ...segment,
      width: (occupancy?.percent ?? 0) * breakdown[segment.key] / breakdownTotal,
      value: breakdown[segment.key],
    }))
  const topTools = detail === null ? [] : detail.tools.slice(0, 6)
  const toolMax = topTools[0]?.calls ?? 1
  const models = detail === null ? [] : detail.models
  const modelTotal = models.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0)
  const styles = { '--dsx-ctx-tone': tone } as CSSProperties

  // Nothing to report yet — a brand-new session whose first turn has not been
  // billed. Falling through to the sections would render a wall of dashes.
  const blank = occupancy === null && detail === null && stats === undefined
    && usage === undefined && breakdown === undefined
  const analyzing = pending && detail === null && failure === null

  /** A plain-text rendering of the same figures, for the copy control. */
  const summary = (): string => {
    const lines: string[] = ['会话用量']
    if (detail !== null) lines.push(`开始 ${stamp(detail.createdAt)} · 时长 ${duration(detail.durationMs)}`)
    if (occupancy !== null) {
      lines.push(`上下文已用 ${String(occupancy.percent)}%（~${tokens(occupancy.used)} / ${tokens(occupancy.capacity)}）`)
    }
    lines.push(`轮次/步数 ${count(figures.turns)} / ${count(figures.steps)}`)
    if (detail !== null) {
      lines.push(`工具调用 ${count(detail.toolCalls)}${detail.toolErrors > 0 ? `（失败 ${count(detail.toolErrors)}）` : ''}`)
      if (detail.model !== '') lines.push(`模型 ${detail.model}`)
    }
    lines.push(`Token 未缓存输入 ~${tokens(figures.uncached)} · 缓存读取 ~${tokens(figures.cacheRead)}`
      + ` · 缓存写入 ~${tokens(figures.cacheWrite)} · 输出 ~${tokens(figures.output)}`)
    if (figures.cacheHit !== null) lines.push(`缓存命中 ${percent(figures.cacheHit)}`)
    if (detail !== null && detail.cwd !== '') lines.push(`目录 ${detail.cwd}`)
    return lines.join('\n')
  }

  const onCopy = (): void => {
    if (copied) return
    void writeClipboard(summary()).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => { setCopied(false) }, COPIED_MS)
    })
  }

  if (sessionId === undefined) return null

  const gauge = occupancy === null
    ? <IconDataOutline16 size={16} />
    : (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden style={styles}>
        <circle className="dsx-ctx-track" cx="8" cy="8" r={RADIUS} />
        <circle
          className="dsx-ctx-arc"
          cx="8"
          cy="8"
          r={RADIUS}
          strokeDasharray={`${String(CIRCUMFERENCE * occupancy.percent / 100)} ${String(CIRCUMFERENCE)}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    )

  return (
    <span className="dsx-ctx" ref={root} style={styles}>
      <Tooltip
        label={occupancy === null ? '会话用量' : `上下文已用 ${String(occupancy.percent)}%`}
        side="top"
        delayMs={200}
        disabled={open}
      >
        <button
          type="button"
          className="dsx-ctx-trigger"
          aria-label="会话用量"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          {gauge}
        </button>
      </Tooltip>
      {open && (
        <div className="dsx-ctx-panel" role="dialog" aria-label="会话用量">
          <div className="dsx-ctx-top">
            <span className="dsx-ctx-title">会话用量</span>
            {detail !== null && <span className="dsx-ctx-stamp">{`开始 ${stamp(detail.createdAt)}`}</span>}
            <span className="dsx-ctx-actions">
              <Tooltip label={copied ? '已复制' : '复制摘要'} side="top" delayMs={300}>
                <button
                  type="button"
                  className="dsx-ctx-icon"
                  data-copied={copied ? 'true' : undefined}
                  aria-label={copied ? '已复制' : '复制摘要'}
                  disabled={blank}
                  onClick={onCopy}
                >
                  {copied ? <IconCheckOutline16 size={14} /> : <IconCopyOutline16 size={14} />}
                </button>
              </Tooltip>
              <Tooltip label="重新读取" side="top" delayMs={300}>
                <button
                  type="button"
                  className="dsx-ctx-icon"
                  aria-label="重新读取"
                  disabled={pending}
                  onClick={() => { setEpoch(value => value + 1) }}
                >
                  {pending
                    ? <span className="dsx-ctx-spin"><IconRefreshOutline16 size={14} /></span>
                    : <IconRefreshOutline16 size={14} />}
                </button>
              </Tooltip>
            </span>
          </div>

          {blank ? (
            <p className="dsx-ctx-empty">这次会话还没有可统计的数据——等第一轮回复结束后再打开看看。</p>
          ) : (
            <>
              {occupancy === null ? (
                <p className="dsx-ctx-empty">这个模型或渠道没有上报上下文用量，下面的数字来自会话记录。</p>
              ) : (
                <>
                  <div className="dsx-ctx-head">
                    <span className="dsx-ctx-percent">{`${String(occupancy.percent)}%`}</span>
                    <span className="dsx-ctx-headLabel">上下文已用</span>
                    <span className="dsx-ctx-figures">{`~${tokens(occupancy.used)} / ${tokens(occupancy.capacity)}`}</span>
                  </div>
                  <div className="dsx-ctx-bar">
                    {parts.length === 0
                      ? <div className="dsx-ctx-seg" style={{ width: `${String(occupancy.percent)}%`, background: tone }} />
                      : parts.filter(part => part.width > 0).map(part => (
                        <div key={part.key} className="dsx-ctx-seg" style={{ width: `${String(part.width)}%`, background: part.tint }} />
                      ))}
                  </div>
                  {parts.length > 0 && (
                    <div className="dsx-ctx-legend">
                      {parts.map(part => (
                        <div key={part.key} className="dsx-ctx-legendRow">
                          <span className="dsx-ctx-swatch" style={{ background: part.tint }} aria-hidden />
                          <span className="dsx-ctx-legendLabel">{part.label}</span>
                          <span className="dsx-ctx-legendValue">{`~${tokens(part.value)}`}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {failure !== null && (
                <p className="dsx-ctx-error">{`${failure}（点右上角可重试）`}</p>
              )}
              {analyzing && <p className="dsx-ctx-note">正在读取这次会话的明细…</p>}

              <Section title="分析" note="按本次会话估算">
                <div className="dsx-ctx-grid">
                  <Cell label="剩余空间" value={occupancy === null ? '—' : `~${tokens(occupancy.headroom)}`} />
                  <Cell label="预计还能约" value={figures.turnsLeft === null ? '—' : `${count(figures.turnsLeft)} 轮`} />
                  <Cell label="缓存命中" value={percent(figures.cacheHit)} />
                  <Cell label="输出 / 输入" value={percent(figures.ioRatio)} />
                  <Cell label="工具耗时占比" value={percent(figures.toolShare)} />
                  <Cell label="平均每步输出" value={figures.perStep === null ? '—' : tokens(figures.perStep)} />
                </div>
              </Section>

              <Section title="会话">
                <div className="dsx-ctx-grid">
                  <Cell label="轮次 / 步数" value={`${count(figures.turns)} / ${count(figures.steps)}`} />
                  <Cell
                    label="工具调用"
                    value={detail === null ? '—' : `${count(detail.toolCalls)}${detail.toolErrors > 0 ? ` (失败 ${count(detail.toolErrors)})` : ''}`}
                    tone={detail !== null && detail.toolErrors > 0 ? 'bad' : undefined}
                  />
                  <Cell label="模型" value={detail === null || detail.model === '' ? '—' : detail.model} />
                  <Cell label="时长" value={detail === null ? '—' : duration(detail.durationMs)} />
                </div>
                {detail !== null && detail.cwd !== '' && <p className="dsx-ctx-note">{detail.cwd}</p>}
                {detail === null && !pending && failure === null && (
                  <p className="dsx-ctx-note">这次会话还没有落盘，工具明细和模型分布要等它结束后才有。</p>
                )}
              </Section>

              {models.length > 1 && (
                <Section title="模型分布" note={`共 ${count(models.length)} 个`}>
                  {models.map(model => (
                    <div key={model.name} className="dsx-ctx-tool">
                      <span className="dsx-ctx-toolName" title={model.name}>{model.name}</span>
                      <span className="dsx-ctx-toolTrack">
                        <span
                          className="dsx-ctx-toolFill"
                          style={{ width: `${String(Math.max(4, modelTotal > 0 ? (model.inputTokens + model.outputTokens) / modelTotal * 100 : 0))}%` }}
                        />
                      </span>
                      <span className="dsx-ctx-toolCount">{count(model.messages)} 条</span>
                    </div>
                  ))}
                </Section>
              )}

              <Section title="性能" note="整个会话累计">
                <div className="dsx-ctx-grid">
                  <Cell label="模型耗时" value={duration(figures.llmMs)} />
                  <Cell label="工具耗时" value={duration(figures.toolMs)} />
                  <Cell label="平均首字延迟" value={figures.ttft === null ? '—' : duration(figures.ttft)} />
                  <Cell label="平均输出速度" value={figures.speed === null ? '—' : `${String(Math.round(figures.speed * 10) / 10)} tok/s`} />
                  <Cell label="平均每轮输入" value={figures.perTurn === null ? '—' : `~${tokens(figures.perTurn)}`} />
                  <Cell label="工具失败率" value={percent(figures.failRate)} tone={figures.failRate !== null && figures.failRate > 0 ? 'bad' : undefined} />
                </div>
              </Section>

              <Section title="Token 账目" note="按计费口径">
                <div className="dsx-ctx-grid">
                  <Cell label="未缓存输入" value={tokens(figures.uncached)} />
                  <Cell label="缓存读取" value={tokens(figures.cacheRead)} />
                  <Cell label="缓存写入" value={tokens(figures.cacheWrite)} />
                  <Cell label="输出" value={tokens(figures.output)} />
                </div>
                <p className="dsx-ctx-note">{`计费输入合计 ~${tokens(figures.billed)} tokens`}</p>
              </Section>

              {topTools.length > 0 && (
                <Section title="工具明细" note={`共 ${count(detail?.tools.length ?? 0)} 种`}>
                  {topTools.map(tool => (
                    <div key={tool.name} className="dsx-ctx-tool">
                      <span className="dsx-ctx-toolName" title={tool.name}>{tool.name}</span>
                      <span className="dsx-ctx-toolTrack">
                        <span
                          className="dsx-ctx-toolFill"
                          style={{ width: `${String(Math.max(4, tool.calls / toolMax * 100))}%` }}
                        />
                      </span>
                      <span className="dsx-ctx-toolCount">
                        {`${count(tool.calls)}${tool.errors > 0 ? ` · 失败 ${count(tool.errors)}` : ''}`}
                      </span>
                    </div>
                  ))}
                </Section>
              )}

              {detail !== null && detail.reasons.length > 0 && (
                <Section title="结束原因">
                  <div className="dsx-ctx-chips">
                    {detail.reasons.map(reason => (
                      <span key={reason.kind} className="dsx-ctx-chip">
                        <span>{REASONS[reason.kind] ?? reason.kind}</span>
                        <span className="dsx-ctx-chipValue">{count(reason.count)}</span>
                      </span>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </span>
  )
}
