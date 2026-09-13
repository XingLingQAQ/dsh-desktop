/** Models settings section: localized tabs around feature-owned pages. */

import { useEffect, useId, useRef, useState } from 'react'
import type {
  HostObservable, InjectFace, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'

/** One tab projected from a `settings.models.tab` contribution. */
export interface ModelsSectionTabEntry {
  id: string
  order: number
  label: string
}

/** Registration-side business face for the section. */
export interface ModelsSectionInjected {
  hooks: {
    /** Ordered projection of the Models tab ledger. */
    tabs: HostObservable<readonly ModelsSectionTabEntry[]>
  }
}

/** Props the renderer binds for the section. */
export type ModelsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsRenderSlots<'settings.models.tab'>
  & InjectFace<ModelsSectionInjected>

/** Render one Models page whose contents arrive from feature-owned tabs. */
export function ModelsSection({ renderSlot, useTabs }: ModelsSectionProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = useTabs(value => value)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id

  // A tab mounts only when first selected, then stays mounted while hidden so
  // local drafts and state survive switching between tabs.
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  return (
    <div className="dsx-models-section">
      <div className="dsx-models-tabs" role="tablist" aria-label="模型选项卡">
        {rows.map((row, index) => {
          const selected = row.id === active
          return (
            <button
              key={row.id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`${tabsId}-tab-${row.id}`}
              type="button"
              role="tab"
              className="dsx-models-tab"
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
                const nextRow = rows[nextIndex] as ModelsSectionTabEntry
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
              role="tabpanel"
              aria-labelledby={`${tabsId}-tab-${row.id}`}
              hidden={!selected}
              tabIndex={0}
            >
              {renderSlot('settings.models.tab', {}, { only: row.id })}
            </div>
          )
        })}
    </div>
  )
}
