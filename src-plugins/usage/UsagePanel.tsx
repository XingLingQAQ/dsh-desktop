/**
 * 用量 tab: the whole session history as a dashboard.
 *
 * Everything here is read from the desktop's own host route
 * (`plugins/dsh-desktop-usage`); nothing about the fold happens in the page. The
 * charts carry the three questions worth asking of that history — how many
 * tokens went where, how fast the model answered, and what the tools were
 * actually doing — and the table underneath is the same history session by
 * session, so a surprising total can be traced back to the session that caused
 * it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EChartsCoreOption } from 'echarts/core'
import { Chart, readPalette, useThemeRevision, type Palette } from './Chart.tsx'
import { readUsage, type UsageDay, type UsageModel, type UsageProject, type UsageSummary, type UsageTool } from './usage.ts'

/** The panel's read state. The last good `summary` survives an in-flight or
 * failed recount, so refreshing never blanks the dashboard it is refreshing. */
interface ViewState {
  status: 'loading' | 'error' | 'ready'
  summary: UsageSummary | null
  message: string | null
}

/** The columns the table can be ordered by. */
type SortKey = 'createdAt' | 'project' | 'model' | 'turns' | 'toolCalls' | 'tokens'

/** One orderable column. */
interface Column {
  key: SortKey
  label: string
  /** Numbers sort high-first by default; names read better low-first. */
  numeric?: boolean
  title?: string
}

const COLUMNS: readonly Column[] = [
  { key: 'createdAt', label: '开始' },
  { key: 'project', label: '项目' },
  { key: 'model', label: '模型' },
  { key: 'turns', label: '轮次', numeric: true },
  { key: 'toolCalls', label: '工具', numeric: true },
  { key: 'tokens', label: 'Token', numeric: true, title: '输入 + 输出 + 缓存读取 + 缓存写入' },
]

/** Hundreds and thousands read as counts; larger figures read as 万/亿. */
function compact(value: number): string {
  const rounded = Math.round(value)
  if (Math.abs(rounded) >= 100_000_000) return `${(rounded / 100_000_000).toFixed(2)} 亿`
  if (Math.abs(rounded) >= 10_000) return `${(rounded / 10_000).toFixed(1)} 万`
  return rounded.toLocaleString('zh-CN')
}

/** A token count with every digit, for tooltips and tables. */
function exact(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

/** A duration, at the scale it reads best on. */
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

/** A timestamp as `MM-DD HH:mm`. */
function stamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A day bucket's timestamp, on the local calendar. */
function at(day: UsageDay): number {
  return Date.parse(`${day.date}T00:00:00`)
}

/** The four buckets summed — one session's or one day's token figure. */
function totalOf(entry: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
}

/** The shared tooltip chrome, so every chart matches the app's surfaces. */
function tooltip(palette: Palette, trigger: 'axis' | 'item'): Record<string, unknown> {
  return {
    trigger,
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: palette.text, fontSize: 12 },
    ...trigger === 'axis' ? { axisPointer: { type: 'shadow' } } : {},
    valueFormatter: (value: unknown): string => typeof value === 'number' ? exact(value) : String(value),
  }
}

/** The shared axis-label and split-line chrome. */
function axisChrome(palette: Palette): Record<string, unknown> {
  return {
    axisLabel: { color: palette.muted, fontSize: 11 },
    axisLine: { lineStyle: { color: palette.line } },
    splitLine: { lineStyle: { color: palette.split } },
  }
}

/** The shared legend chrome. */
function legendChrome(palette: Palette): Record<string, unknown> {
  return {
    top: 0,
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 14,
    textStyle: { color: palette.muted, fontSize: 11 },
    inactiveColor: palette.split,
  }
}

/** A category name shortened to fit an axis without reflowing the plot. */
function shorten(name: string, limit: number): string {
  return name.length > limit ? `${name.slice(0, limit - 1)}…` : name
}

/** Daily token usage, split into the four buckets the meter reports. */
function tokenOption(daily: readonly UsageDay[], palette: Palette): EChartsCoreOption {
  const series = [
    { name: '输入', color: palette.input, pick: (day: UsageDay): number => day.inputTokens },
    { name: '输出', color: palette.output, pick: (day: UsageDay): number => day.outputTokens },
    { name: '缓存读取', color: palette.cacheRead, pick: (day: UsageDay): number => day.cacheReadTokens },
    { name: '缓存写入', color: palette.cacheWrite, pick: (day: UsageDay): number => day.cacheWriteTokens },
  ]
  return {
    color: series.map(entry => entry.color),
    grid: { left: 4, right: 12, top: 30, bottom: 0, containLabel: true },
    legend: legendChrome(palette),
    tooltip: tooltip(palette, 'axis'),
    xAxis: { type: 'time', ...axisChrome(palette), splitLine: { show: false } },
    yAxis: {
      type: 'value',
      ...axisChrome(palette),
      axisLabel: { color: palette.muted, fontSize: 11, formatter: (value: number) => compact(value) },
    },
    series: series.map(entry => ({
      name: entry.name,
      type: 'bar',
      stack: 'tokens',
      barMaxWidth: 26,
      emphasis: { focus: 'series' },
      data: daily.map(day => [at(day), entry.pick(day)]),
    })),
  }
}

/** Latency and throughput per day, on two axes so their scales can differ. */
function performanceOption(daily: readonly UsageDay[], palette: Palette): EChartsCoreOption {
  const ttft = daily.filter(day => day.ttftSteps > 0).map(day => [at(day), day.ttftMs / day.ttftSteps])
  const speed = daily.filter(day => day.decodeMs > 0).map(day => [at(day), day.decodeTokens / (day.decodeMs / 1000)])
  // A lone reading would otherwise be an invisible line segment between nothing.
  const markers = Math.max(ttft.length, speed.length) <= 14
  return {
    color: [palette.input, palette.output],
    grid: { left: 4, right: 4, top: 30, bottom: 0, containLabel: true },
    legend: legendChrome(palette),
    tooltip: {
      ...tooltip(palette, 'axis'),
      axisPointer: { type: 'line' },
      valueFormatter: (value: unknown): string => typeof value === 'number' ? value.toFixed(1) : String(value),
    },
    xAxis: { type: 'time', ...axisChrome(palette), splitLine: { show: false } },
    yAxis: [
      { type: 'value', name: '首字 ms', nameTextStyle: { color: palette.muted, fontSize: 11 }, ...axisChrome(palette) },
      {
        type: 'value',
        name: 'tok/s',
        nameTextStyle: { color: palette.muted, fontSize: 11 },
        ...axisChrome(palette),
        splitLine: { show: false },
      },
    ],
    series: [
      { name: '首字延迟', type: 'line', smooth: true, symbolSize: 6, showSymbol: markers, data: ttft },
      { name: '输出速度', type: 'line', smooth: true, symbolSize: 6, showSymbol: markers, yAxisIndex: 1, data: speed },
    ],
  }
}

/** The busiest tools, with the failed calls stacked on top of the good ones. */
function toolOption(tools: readonly UsageTool[], palette: Palette): EChartsCoreOption {
  const top = tools.slice(0, 14).slice().reverse()
  return {
    color: [palette.cacheRead, palette.error],
    grid: { left: 4, right: 24, top: 30, bottom: 0, containLabel: true },
    legend: legendChrome(palette),
    tooltip: tooltip(palette, 'axis'),
    xAxis: {
      type: 'value',
      ...axisChrome(palette),
      minInterval: 1,
      axisLabel: { color: palette.muted, fontSize: 11, formatter: (value: number) => compact(value) },
    },
    yAxis: {
      type: 'category',
      data: top.map(tool => shorten(tool.name, 22)),
      ...axisChrome(palette),
      splitLine: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11, fontFamily: 'monospace' },
    },
    series: [
      {
        name: '成功',
        type: 'bar',
        stack: 'calls',
        barMaxWidth: 14,
        emphasis: { focus: 'series' },
        data: top.map(tool => tool.calls - tool.errors),
      },
      {
        name: '失败',
        type: 'bar',
        stack: 'calls',
        barMaxWidth: 14,
        emphasis: { focus: 'series' },
        itemStyle: { borderRadius: [0, 3, 3, 0] },
        data: top.map(tool => tool.errors),
      },
    ],
  }
}

/** Which models the tokens were spent on. */
function modelOption(models: readonly UsageModel[], palette: Palette): EChartsCoreOption {
  return {
    color: palette.series,
    tooltip: tooltip(palette, 'item'),
    legend: {
      type: 'scroll',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 10,
      textStyle: { color: palette.muted, fontSize: 11 },
      pageTextStyle: { color: palette.muted },
      pageIconColor: palette.muted,
      pageIconInactiveColor: palette.split,
    },
    series: [{
      type: 'pie',
      radius: ['48%', '72%'],
      center: ['50%', '42%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: palette.surface, borderWidth: 2 },
      label: { show: false },
      labelLine: { show: false },
      emphasis: { label: { show: true, color: palette.text, fontSize: 12, formatter: '{b}\n{d}%' } },
      data: models.slice(0, 8).map(model => ({ name: shorten(model.model, 28), value: totalOf(model) })),
    }],
  }
}

/** Where the tokens were spent, by project directory. */
function projectOption(projects: readonly UsageProject[], palette: Palette): EChartsCoreOption {
  const top = projects.slice(0, 10).slice().reverse()
  return {
    color: [palette.output],
    grid: { left: 4, right: 24, top: 8, bottom: 0, containLabel: true },
    tooltip: tooltip(palette, 'axis'),
    xAxis: {
      type: 'value',
      ...axisChrome(palette),
      axisLabel: { color: palette.muted, fontSize: 11, formatter: (value: number) => compact(value) },
    },
    yAxis: {
      type: 'category',
      data: top.map(project => shorten(project.project, 22)),
      ...axisChrome(palette),
      splitLine: { show: false },
    },
    series: [{
      type: 'bar',
      barMaxWidth: 14,
      itemStyle: { borderRadius: [0, 3, 3, 0] },
      data: top.map(project => totalOf(project)),
    }],
  }
}

/** One headline figure. */
function Stat({ label, value, note }: { label: string; value: string; note?: string }): ReactNode {
  return (
    <div className="dsx-usage-stat">
      <span className="dsx-usage-statLabel">{label}</span>
      <span className="dsx-usage-statValue" title={value}>{value}</span>
      {note === undefined ? null : <span className="dsx-usage-statNote" title={note}>{note}</span>}
    </div>
  )
}

/** One chart card, with an optional figure in its header. */
function Card({ title, note, span = 1, children }: {
  title: string
  note?: string | undefined
  span?: 1 | 2
  children: ReactNode
}): ReactNode {
  return (
    <section className="dsx-usage-card" data-span={span === 2 ? '2' : undefined}>
      <h3 className="dsx-usage-title">
        <span>{title}</span>
        {note === undefined ? null : <span className="dsx-usage-titleNote">{note}</span>}
      </h3>
      {children}
    </section>
  )
}

/** How one session ended, as a compact phrase. Kept in step with the composer
 * panel's own wording, and short enough for a table cell. */
function outcomeOf(row: { reasons: Record<string, number> }): string {
  const labels: Record<string, string> = {
    completed: '完成',
    aborted: '取消',
    blocked: '阻塞',
    error: '出错',
    interrupted: '中断',
    'max-tokens': '超长',
  }
  const parts = Object.entries(row.reasons)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${labels[kind] ?? kind} ${String(count)}`)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/** Render the 用量 dashboard. */
export function UsagePanel(): ReactNode {
  const root = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading', summary: null, message: null })
  const [epoch, setEpoch] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'createdAt', desc: true })
  const theme = useThemeRevision()

  useEffect(() => {
    const controller = new AbortController()
    setState(current => ({ status: 'loading', summary: current.summary, message: null }))
    void (async () => {
      try {
        const summary = await readUsage(controller.signal)
        if (!controller.signal.aborted) setState({ status: 'ready', summary, message: null })
      } catch (error) {
        if (controller.signal.aborted) return
        setState(current => ({
          status: 'error',
          summary: current.summary,
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    })()
    return () => { controller.abort() }
  }, [epoch])

  const palette = useMemo(() => {
    const element = root.current
    return element === null ? null : readPalette(element)
    // Re-read once the panel exists, and again whenever the theme moves.
  }, [theme, state.status])

  const summary = state.summary

  const options = useMemo(() => {
    if (summary === null || palette === null) return null
    return {
      tokens: tokenOption(summary.daily, palette),
      performance: performanceOption(summary.daily, palette),
      tools: toolOption(summary.tools, palette),
      models: modelOption(summary.models, palette),
      projects: projectOption(summary.projects, palette),
    }
  }, [summary, palette])

  /** Rows in the order the clicked header asks for. */
  const rows = useMemo(() => {
    if (summary === null) return []
    const value = (row: UsageSummary['sessions'][number]): number | string => {
      switch (sort.key) {
        case 'createdAt': return row.createdAt
        case 'turns': return row.turns
        case 'toolCalls': return row.toolCalls
        case 'tokens': return totalOf(row)
        case 'project': return row.project
        case 'model': return row.model
      }
    }
    return [...summary.sessions].sort((left, right) => {
      const a = value(left)
      const b = value(right)
      const order = typeof a === 'string' && typeof b === 'string'
        ? a.localeCompare(b, 'zh-CN')
        : Number(a) - Number(b)
      // Ties fall back to recency, so the order is at least stable and useful.
      return (order === 0 ? right.createdAt - left.createdAt : order) * (sort.desc ? -1 : 1)
    })
  }, [summary, sort])

  const reload = useCallback(() => {
    setEpoch(value => value + 1)
  }, [])

  const reorder = useCallback((column: Column) => {
    setSort(current => current.key === column.key
      ? { key: column.key, desc: !current.desc }
      : { key: column.key, desc: column.numeric === true })
  }, [])

  const totals = summary?.totals
  const averageTtft = totals !== undefined && totals.ttftSteps > 0 ? totals.ttftMs / totals.ttftSteps : 0
  const averageSpeed = totals !== undefined && totals.decodeMs > 0 ? totals.decodeTokens / (totals.decodeMs / 1000) : 0
  const errorRate = totals !== undefined && totals.toolCalls > 0 ? totals.toolErrors / totals.toolCalls : 0
  const promptTokens = totals === undefined ? 0 : totals.inputTokens + totals.cacheReadTokens
  const hitRate = totals !== undefined && promptTokens > 0 ? totals.cacheReadTokens / promptTokens : 0
  const cacheTokens = (entry: { cacheReadTokens: number; cacheWriteTokens: number }): number =>
    entry.cacheReadTokens + entry.cacheWriteTokens
  const toolHeight = summary === null ? 240 : Math.max(180, Math.min(summary.tools.length, 14) * 22 + 56)

  return (
    <div className="dsx-usage" ref={root}>
      <div className="dsx-usage-toolbar">
        {summary === null ? (
          <span className="dsx-usage-filler" />
        ) : (
          <p className="dsx-usage-meta">
            <span>{totals === undefined ? '' : `${compact(totals.sessions)} 个会话`}</span>
            {summary.range.days === undefined ? null : <span>覆盖 {String(summary.range.days)} 天</span>}
            <span>更新于 {stamp(summary.generatedAt)}</span>
          </p>
        )}
        <Tooltip label="重新统计" side="bottom">
          <button
            type="button"
            className="dsx-usage-icon"
            aria-label="重新统计"
            disabled={state.status === 'loading'}
            onClick={reload}
          >
            {state.status === 'loading'
              ? <span className="dsx-usage-spin"><IconRefreshOutline16 /></span>
              : <IconRefreshOutline16 />}
          </button>
        </Tooltip>
      </div>

      {state.status === 'loading' && summary === null ? <p className="dsx-usage-status">正在统计历史会话…</p> : null}
      {state.status === 'error' && state.message !== null
        ? <p className="dsx-usage-error" role="alert">{state.message}</p>
        : null}

      {summary !== null && totals !== undefined ? (
        totals.sessions === 0 ? (
          <p className="dsx-usage-status">这台机器上还没有可统计的会话。</p>
        ) : (
          <>
            <div className="dsx-usage-stats">
              <Stat
                label="总 Token"
                value={compact(totalOf(totals))}
                note={`输入 ${compact(totals.inputTokens)} · 输出 ${compact(totals.outputTokens)}`}
              />
              <Stat
                label="会话 / 轮次"
                value={`${compact(totals.sessions)} / ${compact(totals.turns)}`}
                note={`${compact(totals.steps)} 步 · ${compact(totals.messages)} 条回复`}
              />
              <Stat
                label="工具调用"
                value={compact(totals.toolCalls)}
                note={totals.toolErrors === 0 ? '没有失败' : `失败 ${compact(totals.toolErrors)} · ${(errorRate * 100).toFixed(1)}%`}
              />
              <Stat
                label="平均首字延迟"
                value={totals.ttftSteps > 0 ? `${averageTtft.toFixed(0)} ms` : '—'}
                note={`${compact(totals.ttftSteps)} 个样本`}
              />
              <Stat
                label="平均输出速度"
                value={totals.decodeMs > 0 ? `${averageSpeed.toFixed(1)} tok/s` : '—'}
                note={`解码 ${duration(totals.decodeMs)}`}
              />
              <Stat
                label="模型 / 工具耗时"
                value={`${duration(totals.llmMs)} / ${duration(totals.toolMs)}`}
                note={`缓存命中 ${promptTokens > 0 ? `${(hitRate * 100).toFixed(1)}%` : '—'}`}
              />
            </div>

            {options !== null ? (
              <div className="dsx-usage-grid">
                <Card title="每日 Token 用量" span={2} note={`缓存读取 ${compact(totals.cacheReadTokens)}`}>
                  <Chart option={options.tokens} height={250} label="每日 Token 用量" />
                </Card>
                <Card title="性能趋势" span={2} note="按天平均">
                  <Chart option={options.performance} height={230} label="每日首字延迟与输出速度" />
                </Card>
                <Card title="模型 Token 占比">
                  <Chart option={options.models} height={250} label="各模型 Token 占比" />
                </Card>
                <Card title="按项目" note={`${String(summary.projects.length)} 个目录`}>
                  <Chart option={options.projects} height={250} label="各项目 Token 用量" />
                </Card>
                <Card title="工具调用" span={2} note={totals.toolErrors > 0 ? `失败 ${compact(totals.toolErrors)}` : '没有失败'}>
                  <Chart option={options.tools} height={toolHeight} label="各工具调用次数与失败次数" />
                </Card>
              </div>
            ) : null}

            <Card title="会话明细" span={2} note={`${String(summary.sessions.length)} 行`}>
              <div className="dsx-usage-tableWrap">
                <table className="dsx-usage-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => {
                        const active = sort.key === column.key
                        return (
                          <th
                            key={column.key}
                            className={column.numeric === true ? 'dsx-usage-num' : undefined}
                            aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                            title={column.title}
                          >
                            <button
                              type="button"
                              className="dsx-usage-sort"
                              data-active={active ? 'true' : undefined}
                              onClick={() => { reorder(column) }}
                            >
                              {column.label}
                              <span className="dsx-usage-arrow" data-desc={active && sort.desc ? 'true' : undefined}>
                                {active ? (sort.desc ? '↓' : '↑') : '↕'}
                              </span>
                            </button>
                          </th>
                        )
                      })}
                      <th>结束</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(session => (
                      <tr key={session.id}>
                        <td className="dsx-usage-mono">{stamp(session.createdAt)}</td>
                        <td className="dsx-usage-clip" title={session.cwd}>{session.project}</td>
                        <td className="dsx-usage-mono dsx-usage-clip" title={session.model}>{session.model}</td>
                        <td className="dsx-usage-num">{compact(session.turns)}</td>
                        <td className="dsx-usage-num">
                          {compact(session.toolCalls)}
                          {session.toolErrors > 0
                            ? <span className="dsx-usage-bad"> ({compact(session.toolErrors)})</span>
                            : null}
                        </td>
                        <td
                          className="dsx-usage-num"
                          title={`输入 ${exact(session.inputTokens)} · 输出 ${exact(session.outputTokens)} · 缓存 ${exact(cacheTokens(session))}`}
                        >
                          {compact(totalOf(session))}
                        </td>
                        <td className="dsx-usage-outcome">{outcomeOf(session)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )
      ) : null}
    </div>
  )
}
