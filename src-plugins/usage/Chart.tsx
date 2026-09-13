/**
 * The chart surface: an ECharts instance whose lifetime is its box's.
 *
 * ECharts draws into a canvas it owns, so React can only hand it a box and an
 * option. The instance is created once per mount, resized with its box, and
 * disposed on unmount; option changes are pushed through `setOption` with
 * `notMerge`, because the dashboard rebuilds an option wholesale from a new
 * payload and a merge would leave a removed series' axis behind.
 *
 * The instance also follows whether its box is actually on screen. The models
 * section mounts a tab on first visit and then keeps it mounted while hidden,
 * so without this a visited 用量 tab would leave five canvases alive for the
 * rest of the session. An invisible box is a disposed instance; coming back
 * rebuilds it from the option already in hand.
 *
 * Colors are read from the app's design tokens rather than hard-coded, and a
 * revision counter re-reads them when the theme changes, so a skin switch
 * repaints the charts instead of leaving stale colors behind.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

/** The colors every chart in this panel draws with, resolved from tokens. */
export interface Palette {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  error: string
  text: string
  muted: string
  line: string
  split: string
  surface: string
  series: string[]
}

/** Token name → the fallback used when the token is not published. */
const TOKENS = {
  input: ['--dsw-static-blue-500', '#3b82f6'],
  output: ['--dsw-static-deepseek-500', '#6d5efc'],
  cacheRead: ['--dsw-static-green-500', '#22c55e'],
  cacheWrite: ['--dsw-static-amber-500', '#f59e0b'],
  error: ['--dsw-alias-state-error-primary', '#ef4444'],
  text: ['--dsw-alias-label-primary', '#111827'],
  muted: ['--dsw-alias-label-tertiary', '#6b7280'],
  line: ['--dsw-alias-border-l3', 'rgba(0,0,0,0.16)'],
  split: ['--dsw-alias-border-l1', 'rgba(0,0,0,0.06)'],
  surface: ['--dsw-alias-bg-layer-1', '#ffffff'],
} as const

/**
 * Resolve the palette from the tokens in scope at `element`.
 *
 * Custom properties inherit, so reading them off the panel gives whatever theme
 * is active above it, with no light/dark branch here.
 * @param element - the panel's root, inside the themed tree.
 * @returns the resolved palette.
 */
export function readPalette(element: HTMLElement): Palette {
  const styles = getComputedStyle(element)
  const value = (entry: readonly [string, string]): string =>
    styles.getPropertyValue(entry[0]).trim() || entry[1]
  const palette = {
    input: value(TOKENS.input),
    output: value(TOKENS.output),
    cacheRead: value(TOKENS.cacheRead),
    cacheWrite: value(TOKENS.cacheWrite),
    error: value(TOKENS.error),
    text: value(TOKENS.text),
    muted: value(TOKENS.muted),
    line: value(TOKENS.line),
    split: value(TOKENS.split),
    surface: value(TOKENS.surface),
  }
  return {
    ...palette,
    series: [palette.input, palette.output, palette.cacheRead, palette.cacheWrite, palette.muted, palette.error],
  }
}

/**
 * A counter that moves when the document's theme attributes change.
 *
 * A skin switch rewrites a class or attribute on the root element and nothing
 * else; the payload is untouched, so without this the charts would keep the
 * palette they were built with. Inline `style` is deliberately not watched —
 * anything animating a style attribute on <body> would otherwise re-render
 * every chart continuously for a change that usually carries no color at all.
 * @returns a number that changes with the theme.
 */
export function useThemeRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const bump = (): void => { setRevision(value => value + 1) }
    const observer = new MutationObserver(bump)
    const options = { attributes: true, attributeFilter: ['class', 'data-theme'] }
    observer.observe(document.documentElement, options)
    if (document.body !== null) observer.observe(document.body, options)
    return () => { observer.disconnect() }
  }, [])
  return revision
}

/**
 * Whether this chart's tab is the one being shown.
 *
 * The models section mounts a tab the first time it is selected and then keeps
 * it mounted while hidden, so the visibility signal is the tab panel's own
 * `hidden` attribute — not the chart's position. Position would be the wrong
 * question twice over: the panel lives in a scroll container, so a chart below
 * the fold is clipped out of the viewport and would be torn down and rebuilt
 * every time the user scrolls past it, and a root margin cannot reach past that
 * clipping to fix it.
 *
 * A chart outside any tab panel has no such signal and stays mounted.
 * @param target - the chart's box.
 * @returns whether it should hold a live instance.
 */
function useTabDisplayed(target: RefObject<HTMLElement | null>): boolean {
  const [displayed, setDisplayed] = useState(true)
  useEffect(() => {
    const element = target.current
    if (element === null) return
    const panel = element.closest('[role="tabpanel"]')
    if (panel === null) return
    const update = (): void => { setDisplayed(!panel.hasAttribute('hidden')) }
    update()
    const observer = new MutationObserver(update)
    observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] })
    return () => { observer.disconnect() }
  }, [target])
  return displayed
}

/**
 * One chart box.
 * @param props.option - the ECharts option; replaced, not merged.
 * @param props.height - the box height in pixels.
 * @param props.label - an accessible name for the chart.
 */
export function Chart({ option, height, label }: {
  option: EChartsCoreOption
  height: number
  label: string
}): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const instance = useRef<echarts.ECharts | null>(null)
  const displayed = useTabDisplayed(host)

  useEffect(() => {
    const element = host.current
    if (element === null || !displayed) return
    const chart = echarts.init(element)
    instance.current = chart
    // The box can be re-measured for any reason — the panel being revealed, a
    // scrollbar appearing, the window resizing — and the observer covers all of
    // them, so no caller has to know the box moved.
    const observer = new ResizeObserver(() => { chart.resize() })
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.current = null
      chart.dispose()
    }
  }, [displayed])

  useEffect(() => {
    instance.current?.setOption(option, { notMerge: true })
  }, [option, displayed])

  return <div className="dsx-usage-chart" ref={host} style={{ height: `${String(height)}px` }} role="img" aria-label={label} />
}
