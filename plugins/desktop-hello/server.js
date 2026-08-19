// Desktop sample backend (host-side) plugin.
//
// This file is picked up by the desktop plugin scanner and written into
// `$DSH_HOME/desktop-overlay/cordis.yml` as a `--patch` row. The desktop shell
// then touches `profiles/web/cordis.patch.yml`, which makes DSH's live patch
// watcher recompose the tree — so backend plugin changes also hot-apply while
// the Host is running.

export const name = 'desktop-hello-server'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  console.log('[desktop-hello] backend mounted')
  // A real backend plugin would register services / tools / event handlers here.
}
