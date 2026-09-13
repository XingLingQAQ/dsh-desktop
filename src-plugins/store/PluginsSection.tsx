/** Plugins settings section, hijacked by the desktop store plugin.
 *
 * DSH's native `ui-settings-plugins` is disabled via the desktop overlay, so
 * this plugin owns the `settings.section id='plugins'` entry and the
 * `settings.plugins.tab` child slot it declares. The section chrome is a
 * locale-free re-derivation of the original `PluginsSettingsSection` — copy is
 * hardcoded Simplified Chinese because this plugin does not inject `locale`
 * (keeping the inject list minimal). Feature plugins (dsh-plus mcp/vision,
 * our desktop-manager/desktop-store) register tabs into the child slot; the
 * section only projects and renders them.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type {
  HostObservable, InjectFace, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'

/** One tab projected from a `settings.plugins.tab` contribution. */
export interface PluginsSectionTabEntry {
  id: string
  order: number
  label: string
}

/** Registration-side business face for the section. */
export interface PluginsSectionInjected {
  hooks: {
    /** Ordered projection of the Plugins tab ledger (locale-free). */
    tabs: HostObservable<readonly PluginsSectionTabEntry[]>
  }
}

/** Props the renderer binds for the section. */
export type PluginsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsRenderSlots<'settings.plugins.tab'>
  & InjectFace<PluginsSectionInjected>

/** Hardcoded Simplified Chinese copy (this plugin does not inject `locale`). */
const TITLE = '插件'
const INTRO = '配置和查看本部署已安装的插件。'
const TABS_LABEL = '插件视图'
const EMPTY = '本部署没有开放任何插件设置。'

/** Render one Plugins page whose contents arrive from feature-owned tabs. */
export function PluginsSection({ renderSlot, useTabs }: PluginsSectionProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = useTabs(value => value)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id

  // A tab mounts only when first selected, then stays mounted while hidden so
  // local drafts, disclosure state, search, and the inventory snapshot survive
  // switching between the views.
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  return (
    <div className="dsx-sec">
      <h2 className="dsx-sec-heading">{TITLE}</h2>
      <p className="dsx-sec-intro">{INTRO}</p>
      {rows.length === 0 ? <p className="dsx-sec-empty">{EMPTY}</p> : (
        <>
          <div className="dsx-sec-tabs" role="tablist" aria-label={TABS_LABEL}>
            {rows.map((row, index) => {
              const selected = row.id === active
              return (
                <button
                  key={row.id}
                  ref={(element) => { tabRefs.current[index] = element }}
                  id={`${tabsId}-tab-${row.id}`}
                  type="button"
                  role="tab"
                  className="dsx-sec-tab"
                  aria-selected={selected}
                  aria-controls={`${tabsId}-panel-${row.id}`}
                  data-active={selected ? 'true' : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => { setActiveId(row.id) }}
                  onKeyDown={(event) => {
                    let nextIndex: number
                    switch (event.key) {
                      case 'ArrowRight': nextIndex = (index + 1) % rows.length; break
                      case 'ArrowLeft': nextIndex = (index - 1 + rows.length) % rows.length; break
                      case 'Home': nextIndex = 0; break
                      case 'End': nextIndex = rows.length - 1; break
                      default: return
                    }
                    event.preventDefault()
                    const nextRow = rows[nextIndex] as PluginsSectionTabEntry
                    const nextTab = tabRefs.current[nextIndex] as HTMLButtonElement
                    setActiveId(nextRow.id)
                    nextTab.focus()
                  }}
                >
                  {row.label}
                </button>
              )
            })}
          </div>
          {rows
            .filter(row => row.id === active || visitedIds.has(row.id))
            .map((row) => {
              const selected = row.id === active
              return (
                <div
                  key={row.id}
                  id={`${tabsId}-panel-${row.id}`}
                  className="dsx-sec-panel"
                  role="tabpanel"
                  aria-labelledby={`${tabsId}-tab-${row.id}`}
                  hidden={!selected}
                >
                  {renderSlot('settings.plugins.tab', {}, { only: row.id })}
                </div>
              )
            })}
        </>
      )}
    </div>
  )
}
