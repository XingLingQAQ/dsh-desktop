/**
 * Desktop plugin store — one tab inside DSH's own plugin settings section.
 *
 * DSH already ships a plugins section that declares a `settings.plugins.tab`
 * list slot, so the store belongs there rather than in a second settings surface
 * of the shell's own. Registration is the whole integration: the section renders
 * whatever tabs were contributed.
 *
 * Card chrome is drawn here instead of reused from `ui-settings-plugins` — a
 * plugin may not value-import another plugin (the bundle purity gate). The
 * building blocks come from `ui-primitives`, which is a platform word and so is
 * fair game, and the styling rides on `--dsw-*` tokens: the tab tracks the host
 * theme without knowing anything about it.
 *
 * The manager tab additionally reads DSH's native plugin inventory and writes
 * native settings (bash / agent-loop / web-search). Those flow through the
 * runtime's `remote`, `settingsScope`, and `connection` services, so the inject
 * list extends beyond `slots` to claim them. dsh-desktop is loopback, so the
 * settings scope runs in host mode (writable); non-loopback clients would see
 * memory mode (writes swallowed) — the cards handle both.
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { ManagerTab, type ManagerTabServices } from './ManagerTab.tsx'
import { PluginsSection } from './PluginsSection.tsx'
import type { PluginsSectionInjected, PluginsSectionTabEntry } from './PluginsSection.tsx'
import { StoreTab } from './StoreTab.tsx'
import type { NativeCardServices } from './NativeConfigCards.tsx'
import managerStyles from './manager.css?inline'
import sectionStyles from './section.css?inline'
import styles from './store.css?inline'

/** Cordis plugin name. */
export const name = 'dsh-desktop-store'

/**
 * Required services.
 *
 * - `slots` — the settings.plugins.tab list this tab contributes to.
 * - `remote` — used for `pluginInventory.list()` (the native Loader entries
 *   behind the 原生插件 group) and `$on('credentials/updated', …)` (so the
 *   web-search API Key badge refreshes when the Models page writes one).
 * - `remote.pluginInventory` — the Typert remote face for the inventory list.
 * - `settingsScope` — `bind({namespace})` produces the snapshot store each
 *   config card reads through; writes go via `set`/`unset`.
 * - `connection` — the credentials API (`ctx.connection.api.credentials`) is the
 *   only path to write the web-search API Key; the bridge's `/plugins/config`
 *   does not carry it.
 */
export const inject = [
  'slots',
  'remote',
  'remote.pluginInventory',
  'settingsScope',
  'connection',
]

const STYLE_ID = 'dsh-desktop-store-styles'
const MANAGER_STYLE_ID = 'dsh-desktop-manager-styles'
const SECTION_STYLE_ID = 'dsh-desktop-section-styles'

// Injected at materialization, not inside apply(): DSH claims untagged <style>
// tags for whichever plugin is materializing, so a tag created later gets
// attributed to an unrelated plugin and disappears when that one reloads.
// Stamping data-plugin here makes ownership explicit either way, which is what
// puts the tag on this plugin's owned list and gets it swapped on reload.
if (document.getElementById(STYLE_ID) === null) {
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.setAttribute('data-plugin', '@dsh-desktop/store')
  el.textContent = styles
  document.head.append(el)
}

// The manager tab ships its own style element alongside the store's: the two
// stylesheets are independent surfaces and grow separately, so keep them split
// rather than concatenating into one growing blob.
if (document.getElementById(MANAGER_STYLE_ID) === null) {
  const el = document.createElement('style')
  el.id = MANAGER_STYLE_ID
  el.setAttribute('data-plugin', '@dsh-desktop/store')
  el.textContent = managerStyles
  document.head.append(el)
}

// The hijacked settings section ships its own style element too: the section
// chrome is a separate surface from the store/manager tabs and grows
// independently, so it keeps its own stylesheet rather than folding into one.
if (document.getElementById(SECTION_STYLE_ID) === null) {
  const el = document.createElement('style')
  el.id = SECTION_STYLE_ID
  el.setAttribute('data-plugin', '@dsh-desktop/store')
  el.textContent = sectionStyles
  document.head.append(el)
}

/**
 * Register the store and manager tabs.
 * @param ctx - the browser plugin context, with `slots`, `remote`,
 *   `settingsScope`, and `connection` available (per `inject`).
 */
export function apply(ctx: Context): void {
  // Hijack the `settings.section id='plugins'` entry. DSH's native
  // `ui-settings-plugins` owned it (and declared the `settings.plugins.tab`
  // child slot); the desktop overlay disables that native package, so the
  // child-slot declaration would vanish with it. To keep feature tabs
  // (dsh-plus mcp/vision, our manager/store) injectable, THIS plugin
  // re-declares `settings.plugins.tab` as its own child — which is exactly the
  // `children` map below. The native package being disabled first (overlay
  // applies at boot, before client plugins load) means its own identical
  // childKey declaration never runs, so there is no "already declared"
  // conflict at SlotCore.register (ui-slots/src/index.ts:825-832).
  //
  // The section chrome is a locale-free re-derivation of
  // `PluginsSettingsSection` (this plugin does not inject `locale`): the
  // `sectionInjected` face feeds a `tabs` HostObservable that projects the
  // `settings.plugins.tab` ledger ordered by `order`, without the locale
  // revision coupling the original carried.
  let tabsVersion = -1
  let tabs: readonly PluginsSectionTabEntry[] = []
  const sectionInjected = (): PluginsSectionInjected => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.plugins.tab')
          if (version !== tabsVersion) {
            tabsVersion = version
            tabs = ctx.slots.entries('settings.plugins.tab')
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
        subscribe: (listener) => ctx.slots.subscribe('settings.plugins.tab', listener),
      },
    },
  })

  // Order 15 sits where the native plugins section sat (between models=10 and
  // agent-presets=20), so the Settings rail keeps its place.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => '插件',
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSection))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'desktop-store',
    // After DSH's own `configurable` (0) and inventory tabs.
    order: 30,
    label: () => '插件商店',
  }, StoreTab))

  // Assemble the manager services from the injected runtime handles. The
  // casts are inline because dsh-client-connection / dsh-client-runtime /
  // dsh-api-remotes are not platform externals — their types cannot be
  // imported here. The shapes are stable: `ctx.connection.api.credentials`
  // and `ctx.settingsScope.bind` are the same surfaces ui-settings-plugins
  // uses for the original cards.
  const services: ManagerTabServices = {
    settingsScope: ctx.settingsScope as NativeCardServices['settingsScope'],
    connection: ctx.connection as NativeCardServices['connection'],
    remote: ctx.remote as ManagerTabServices['remote'],
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'desktop-manager',
    // Between inventory (10) and store (30) so installed-plugin controls sit
    // ahead of browsing the catalog but after the stock inventory view.
    order: 20,
    label: () => '插件管理',
  }, () => <ManagerTab services={services} />))
}
