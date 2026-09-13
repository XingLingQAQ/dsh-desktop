/**
 * Models manager — a tabbed Models settings page.
 *
 * DSH's native `ui-settings-models` registers `settings.section id='models'` and
 * declares no child slots, so there is no seam to hang tabs on. Rather than
 * disabling that package (which would mean re-implementing ~2200 lines of
 * provider/model editors), this plugin uses the slot machinery's own shadowing
 * rule: a cell clash only throws at the *same* priority, and the lowest priority
 * renders (ui-slots/src/index.ts:487). Registering `models` at priority -1 wins
 * the Settings nav row while the native entry stays live at priority 0 —
 * un-disabled, still holding its store and controller.
 *
 * This section declares `settings.models.tab` as its child slot and renders
 * whatever registers there. Three tabs ship here: 渠道 (providers), Skills, MCP.
 * Only 渠道 is a mirror — the native provider editor is the one screen this
 * plugin cannot re-implement cheaply, and it owns the store the edits go
 * through (see {@link mirrorEntry}). Skills and MCP are this plugin's own,
 * top to bottom.
 *
 * The class names are flat `dsx-models-*` rather than CSS modules, and the
 * colors come from `--dsw-alias-*` tokens: same convention the store plugin
 * follows, since a plugin ships one <style> tag inside its bundle.
 */

import type { Context } from '@deepseek-ai/cordis'
import { useState, useRef, type ReactNode, type RefObject } from 'react'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionTabEntry } from './ModelsSection.tsx'
import { SkillsTab } from './SkillsTab.tsx'
import { ChannelAdvanced } from './AdvancedPanel.tsx'
import { McpPanel } from './McpPanel.tsx'
import type { AdvancedApi } from './advanced.ts'
import { discoverModels } from './model-listing.ts'
import { NativeSelects } from './NativeSelects.tsx'
import controlsStyles from './controls.css?inline'
import sectionStyles from './section.css?inline'
import skillsStyles from './skills.css?inline'
import advancedStyles from './advanced.css?inline'
import mcpStyles from './mcp.css?inline'

/** Cordis plugin name. */
export const name = 'dsh-desktop-models-manager'

/**
 * Required services. `slots` is the section this plugin owns; `connection` is
 * the wire face the advanced provider panel reads and writes settings
 * through — the same `api` object the native Models page injects.
 */
export const inject = ['slots', 'connection']

const STYLE_ID = 'dsh-desktop-models-manager-styles'

// Injected at materialization, not inside apply(): DSH claims untagged <style>
// tags for whichever plugin is materializing, so a tag created later gets
// attributed to an unrelated plugin and disappears when that one reloads.
if (document.getElementById(STYLE_ID) === null) {
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.setAttribute('data-plugin', '@dsh-desktop/models-manager')
  el.textContent = [controlsStyles, sectionStyles, skillsStyles, advancedStyles, mcpStyles].join('\n')
  document.head.append(el)
}

/**
 * Structural subset of a slot-ledger entry, enough to mirror one elsewhere.
 * The full type lives in dsh-client-ui-slots, which this plugin already
 * injects; only the fields a mirror needs are named here.
 */
interface MirrorableEntry {
  component: unknown
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  locale?: string | undefined
  options: { id?: string | undefined; priority?: number | undefined }
}

/**
 * Content a mirror renders beneath the component it lifted. The props are the
 * ones the lifted entry's own `inject` face produced, passed through untouched;
 * `refresh` remounts that component, for a change made from down here that its
 * own screen would otherwise keep showing stale; `scope` is the element holding
 * the lifted component, which is what an addition has to watch to reach into
 * markup the lifted component renders (the provider editor's card, say) rather
 * than only the page it renders it on.
 */
type MirrorDecorator = (
  props: Record<string, unknown>,
  refresh: () => void,
  scope: RefObject<HTMLElement | null>,
) => ReactNode

/**
 * A lifted entry plus this section's addition under it.
 *
 * The addition is given a way to remount the lifted component rather than just
 * re-render it: a lifted tab owns its own data and re-reads it only on mount or
 * on its own actions, so an edit made from below would leave it displaying the
 * values before. Remounting re-runs its load, which is what keeps the two
 * halves of a tab — configuration above, live state below — agreeing.
 *
 * The wrapper around both is also what lets `NativeSelects` reach into the
 * lifted component: it is not ours to edit, so its `<select>`s are adopted from
 * the outside, and this element is the subtree to look in.
 */
function MirrorShell({ component: Lifted, props, below }: {
  component: (props: Record<string, unknown>) => ReactNode
  props: Record<string, unknown>
  below?: MirrorDecorator | undefined
}): ReactNode {
  const [epoch, setEpoch] = useState(0)
  const host = useRef<HTMLDivElement | null>(null)
  return (
    <div className="dsx-mirror" ref={host}>
      <Lifted key={epoch} {...props} />
      {below?.(props, () => { setEpoch(value => value + 1) }, host)}
      <NativeSelects scope={host} />
    </div>
  )
}

/** Replace one member of an object without rebuilding the rest. */
function overrideMember<T extends object>(target: T, key: string, value: unknown): T {
  return new Proxy(target, {
    get(inner, name) {
      // Read through the target as the receiver, never the proxy: a member
      // that reaches for a private field would otherwise be handed a Proxy for
      // an object whose class never declared that field, and throw.
      /* v8 ignore next -- the member being replaced is the only one this asks for */
      return name === key ? value : Reflect.get(inner, name)
    },
  })
}

/**
 * Re-point the native provider card's "fetch available models" call at this
 * desktop's own listing (`plugins/dsh-desktop-llm`).
 *
 * The host's discovery interrogates only the OpenAI-shaped protocols and
 * refuses the rest by design, which is a dead end for a hand-declared gateway
 * speaking `anthropic-messages`. The replacement is asked in the same shape and
 * answers in the same envelope, so the native card keeps its own UI.
 *
 * Rebuilding `api` is not safe (the native code keeps using it for everything
 * else) and neither is mutating the connection, which is shared. So the member
 * is replaced on the way past: two proxies, one member each, everything else
 * falling through to the original object.
 * @param props - the props the lifted entry's inject face produced.
 * @returns the same props, with this desktop's `api.llm.discoverModels` when the
 *   face has one.
 */
function ownModelListing(props: Record<string, unknown>): Record<string, unknown> {
  const api = props['api'] as Record<string, unknown> | undefined
  const llm = api?.['llm'] as Record<string, unknown> | undefined
  if (api === undefined || llm === undefined || typeof llm['discoverModels'] !== 'function') return props
  const patchedLlm = overrideMember(llm, 'discoverModels', discoverModels)
  return { ...props, api: overrideMember(api, 'llm', patchedLlm) }
}

/**
 * Mirror another plugin's slot entry into one of this section's tabs.
 *
 * The native provider editor is already implemented, by a plugin whose UI
 * cannot be imported here (the platform module table does not expose it) and
 * whose fiber must keep running (it owns the store and the controller the edits
 * go through). Re-implementing it would mean taking over ~2200 lines of
 * provider and model editing to gain nothing the user can see, so the entry is
 * lifted instead: a list slot's cells are keyed by `id`, so the winner of one
 * slot can be re-registered into another slot verbatim — component, inject face
 * and locale namespace all travel with the entry, and the renderer rebuilds its
 * props on this side.
 *
 * The source ledger is watched rather than read once: a plugin may mount after
 * this one, and its entry has to appear (and disappear) with it.
 * @param ctx - plugin context carrying `slots`.
 * @param source - slot key to lift from.
 * @param target - slot key to register into (this section's tab slot).
 * @param tab - id, order, and label to publish in the tab ledger.
 * @param match - picks the source entry; must reject entries without `inject`.
 * @param below - extra content to render under the lifted component, which
 *   keeps the original whole and adds to it instead of replacing it. It is
 *   handed a `refresh` that remounts the lifted component (see {@link MirrorShell}).
 */
function mirrorEntry(
  ctx: Context,
  source: 'settings.section',
  target: 'settings.models.tab',
  tab: { id: string; order: number; label: string },
  match: (entry: MirrorableEntry) => boolean,
  below?: MirrorDecorator,
): void {
  ctx.slots.inject(target, () => {
    let disposeTab: (() => void) | undefined
    const sync = () => {
      const lifted = (ctx.slots.entries(source) as readonly MirrorableEntry[]).find(match)
      if (lifted !== undefined && disposeTab === undefined) {
        // The lifted component belongs to another plugin and arrives untyped,
        // so the wrapper forwards its props as an opaque record.
        const Original = lifted.component as (props: Record<string, unknown>) => ReactNode
        const registered = (props: Record<string, unknown>) => (
          <MirrorShell component={Original} props={ownModelListing(props)} below={below} />
        )
        disposeTab = ctx.slots.register({
          name: target,
          id: tab.id,
          order: tab.order,
          label: () => tab.label,
          inject: lifted.inject,
          ...(lifted.locale !== undefined ? { locale: lifted.locale } : {}),
        }, registered)
      } else if (lifted === undefined && disposeTab !== undefined) {
        disposeTab()
        disposeTab = undefined
      }
    }
    sync()
    const off = ctx.slots.subscribe(source, sync)
    return () => {
      off()
      disposeTab?.()
    }
  })
}

/**
 * Register the shadowing models section and its three tabs.
 * @param ctx - the browser plugin context, with `slots` available (per `inject`).
 */
export function apply(ctx: Context): void {
  // The tab ledger, projected from the child slot ordered by `order`. Same
  // shape the store plugin's section uses, minus the locale revision coupling.
  let tabsVersion = -1
  let tabs: readonly ModelsSectionTabEntry[] = []
  const sectionInjected = (): ModelsSectionInjected => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.models.tab')
          if (version !== tabsVersion) {
            tabsVersion = version
            tabs = ctx.slots.entries('settings.models.tab')
              .map(entry => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener) => ctx.slots.subscribe('settings.models.tab', listener),
      },
    },
  })

  // priority -1 shadows the native entry at priority 0 (lowest renders). order
  // 10 keeps the Settings rail position the native section had. The label is
  // empty because the nav is a raw-ledger projection (see section.css): the
  // native row stays visible and carries the same id, so selecting it still
  // filters to this shadow winner.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    priority: -1,
    order: 10,
    label: () => '',
    inject: sectionInjected,
    children: { 'settings.models.tab': { kind: 'list', scope: 'root' } },
  }, ModelsSection))

  // The wire face the advanced panel writes through. Taken off the runtime's
  // own `connection` service rather than the native page's inject face, so the
  // panel survives a change to what ui-settings-models hands its own component.
  const connectionApi = (ctx as unknown as { connection?: { api?: unknown } }).connection?.api

  // 渠道 — the native models page re-hosted as a tab, with this plugin's
  // advanced fields added inside each provider editor it renders. Its component
  // and inject face are lifted off the native entry (priority 0) rather than
  // re-imported: the platform module table does not expose ui-settings-models,
  // and the native fiber's store/controller stay alive and keep owning the
  // edits.
  mirrorEntry(
    ctx,
    'settings.section',
    'settings.models.tab',
    { id: 'providers', order: 0, label: '渠道' },
    entry => entry.options.id === 'models'
      && (entry.options.priority ?? 0) === 0
      && entry.inject !== undefined,
    connectionApi === undefined
      ? undefined
      : (_props, _refresh, scope) => (
        <ChannelAdvanced api={connectionApi as AdvancedApi} scope={scope} />
      ),
  )

  // MCP — this plugin owns the whole subject: the configuration document, the
  // connections, and the editor. See McpPanel.
  ctx.slots.inject('settings.models.tab', () => ctx.slots.register({
    name: 'settings.models.tab',
    id: 'mcp',
    order: 20,
    label: () => 'MCP',
  }, McpPanel))

  ctx.slots.inject('settings.models.tab', () => ctx.slots.register({
    name: 'settings.models.tab',
    id: 'skills',
    order: 10,
    label: () => 'Skills',
  }, SkillsTab))
}
