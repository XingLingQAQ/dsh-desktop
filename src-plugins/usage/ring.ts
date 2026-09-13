/**
 * Take the shipped context ring out of the composer's tool row.
 *
 * The ring is the platform's own trigger, hardcoded in the input bar rather
 * than sitting in a slot, so it cannot be replaced — only hidden, with this
 * plugin's richer control taking the seat beside it. Nothing in the markup
 * identifies it by name: the mark is written here, from the one shape that is
 * unambiguous (a dialog-opening button whose icon is a dashed arc, which is
 * what a gauge circle is), and every hiding rule is scoped to that mark.
 *
 * The observer exists because the bar mounts, unmounts, and re-creates the
 * ring as sessions come and go; it re-marks only when the mark has actually
 * gone missing, so a streaming conversation's mutations cost one query.
 */

const MARK = 'data-dsx-context-ring'

/** Mark the ring, if it is mounted and unmarked. */
function mark(): void {
  for (const button of document.querySelectorAll('button[aria-haspopup="dialog"]')) {
    // This plugin's own gauge has the same shape as the ring's trigger, and it
    // is rendered earlier in the tool row — matching it would hide the
    // replacement instead of the thing it replaces.
    if (button.closest('.dsx-ctx') !== null) continue
    if (button.querySelector('svg circle[stroke-dasharray]') === null) continue
    const root = button.parentElement
    if (root === null) continue
    root.setAttribute(MARK, '')
    return
  }
}

/**
 * Keep the ring marked for as long as this plugin is loaded.
 * @returns a disposer that stops watching and clears the mark.
 */
export function watchRing(): () => void {
  if (document.querySelector(`[${MARK}]`) === null) mark()
  let queued = false
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (document.querySelector(`[${MARK}]`) === null) mark()
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    for (const element of document.querySelectorAll(`[${MARK}]`)) element.removeAttribute(MARK)
  }
}
