/**
 * 用量 — a fourth Models tab that charts the whole session history, plus the
 * composer's own usage control.
 *
 * The tab is the history view; the composer control is the same subject at the
 * scale of the conversation in front of you. They share a plugin because they
 * share the fold: both read the figures this plugin's host half
 * (`plugins/dsh-desktop-usage`) computes from the compressed session logs,
 * reached over a same-origin route of the DSH web app's own server.
 *
 * The control also retires the shipped context ring rather than sitting beside
 * it — see `ring.ts` — so the composer keeps one way to ask about usage. See
 * `ContextPanel` for that surface, `UsagePanel` for the history tab, and
 * `usage.ts` / `session-usage.ts` for the two calls.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ContextPanel } from './ContextPanel.tsx'
import { watchRing } from './ring.ts'
import { UsagePanel } from './UsagePanel.tsx'
import contextStyles from './context.css?inline'
import usageStyles from './usage.css?inline'

/** Cordis plugin name. */
export const name = 'dsh-desktop-usage'

/** Both seats this plugin takes belong to the slot registry. */
export const inject = ['slots']

// Injected at materialization, not inside apply(): DSH claims untagged <style>
// tags for whichever plugin is materializing, so a tag created later gets
// attributed to an unrelated plugin and disappears when that one reloads.
for (const [id, css] of [
  ['dsh-desktop-usage-styles', usageStyles],
  ['dsh-desktop-usage-context-styles', contextStyles],
] as const) {
  if (document.getElementById(id) !== null) continue
  const el = document.createElement('style')
  el.id = id
  el.setAttribute('data-plugin', '@dsh-desktop/usage')
  el.textContent = css
  document.head.append(el)
}

/**
 * Register the history tab and the composer's usage control.
 * @param ctx - the browser plugin context, with `slots` available (per `inject`).
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.models.tab', () => ctx.slots.register({
    name: 'settings.models.tab',
    id: 'usage',
    order: 30,
    label: () => '用量',
  }, UsagePanel))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'usage',
    order: 100,
  }, ContextPanel))
  ctx.effect(() => watchRing(), 'dsh-desktop-usage: composer ring takeover')
}
