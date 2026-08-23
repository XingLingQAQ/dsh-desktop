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
 */

import type { Context } from '@deepseek-ai/cordis'
import { StoreTab } from './StoreTab.tsx'
import styles from './store.css?inline'

/** Cordis plugin name. */
export const name = 'dsh-desktop-store'

/** Required services: the slot registry this tab contributes to. */
export const inject = ['slots']

const STYLE_ID = 'dsh-desktop-store-styles'

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

/**
 * Register the store tab.
 * @param ctx - the browser plugin context, with `slots` available.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'desktop-store',
    // After DSH's own `configurable` (0) and inventory tabs.
    order: 30,
    label: () => '插件商店',
  }, StoreTab))
}
