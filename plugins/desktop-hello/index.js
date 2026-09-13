// Desktop sample backend (host-side) plugin.
//
// This file is picked up by the desktop plugin scanner and written into the
// HMR-watched profile patch (`profiles/<name>/cordis.patch.yml`) as an insert
// row, so backend plugin mount / unmount / pause hot-applies while the Host
// keeps running.

export const name = 'desktop-hello-server'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  console.log('[desktop-hello] backend mounted')
}
