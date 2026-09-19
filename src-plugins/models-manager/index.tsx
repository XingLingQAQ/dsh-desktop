/**
 * Models manager — a tabbed Models settings page.
 *
 * DSH's native `ui-settings-models` registers `settings.section id='models'` and
 * declares no tab slot, so there is no seam to hang tabs on. Rather than
 * disabling that package (which would mean losing the settings document itself),
 * this plugin uses the slot machinery's own shadowing rule: a cell clash only
 * throws at the *same* priority, and the lowest priority renders
 * (ui-slots/src/index.ts:487). Registering `models` at priority -1 wins the
 * Settings nav row while the native entry stays live at priority 0.
 *
 * This section declares `settings.models.tab` as its child slot and renders
 * whatever registers there. Four tabs ship here: 渠道 (providers), Skills, MCP,
 * 用量. All four are this plugin's own, top to bottom.
 *
 * 渠道 used to be a *mirror* of the native page instead — its component lifted
 * out of the native entry and rendered here. That was abandoned: the native
 * section declares child slots of its own, a child-slot declaration belongs
 * exclusively to the entry that made it, and only the entry being rendered is
 * handed the matching seat. A shadowing entry is rendered but declares nothing,
 * so the borrowed component called a seat that never existed, threw
 * `renderSlot is not a function`, and took the whole tab slot's dispatch — and
 * therefore the 插件 manager sharing it — down with it. `ProvidersTab` renders
 * the page from the same wire instead, which no other plugin can revoke.
 *
 * The class names are flat `dsx-models-*` rather than CSS modules, and the
 * colors come from `--dsw-alias-*` tokens: same convention the store plugin
 * follows, since a plugin ships one <style> tag inside its bundle.
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionTabEntry } from './ModelsSection.tsx'
import { SkillsTab } from './SkillsTab.tsx'
import { ProvidersTab } from './ProvidersTab.tsx'
import { McpPanel } from './McpPanel.tsx'
import controlsStyles from './controls.css?inline'
import sectionStyles from './section.css?inline'
import skillsStyles from './skills.css?inline'
import advancedStyles from './advanced.css?inline'
import mcpStyles from './mcp.css?inline'

/** Cordis plugin name. */
export const name = 'dsh-desktop-models-manager'

/**
 * Required services. `slots` is the section this plugin owns. The channel page
 * needs no wire service of its own: it reads and writes through this desktop's
 * own host route (see `providers.ts`).
 */
export const inject = ['slots']

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

  // 渠道 — this plugin's own provider list. It used to re-host the native page
  // and hang the advanced block inside the editor that page rendered. That
  // could not last: the native section declares its own child slots
  // (`settings.models.provider-card`, `settings.models.footer`), a child-slot
  // declaration is exclusive to the entry that made it, and only the entry
  // being *rendered* is handed the matching seat. A shadowing registration is
  // rendered but declares nothing, so the mirrored component called a seat it
  // never got, threw, and took the whole tab dispatch — and the 插件 manager
  // with it — down. Owning the page removes the knot entirely: there is no
  // borrowed component and no seat to borrow, because nothing here renders
  // another plugin's children.
  ctx.slots.inject('settings.models.tab', () => ctx.slots.register({
    name: 'settings.models.tab',
    id: 'providers',
    order: 0,
    label: () => '渠道',
  }, ProvidersTab))

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
