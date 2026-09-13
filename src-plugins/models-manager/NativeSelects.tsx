/**
 * Give the platform's own `<select>` elements this desktop's dropdown.
 *
 * The 渠道 tab renders the native provider editor, whose provider and protocol
 * pickers are plain `<select>`s: the platform styles their closed state but a
 * native element draws its own list, which no stylesheet reaches. The element
 * is not ours to edit — that component is mirrored, not imported — so each one
 * is adopted from the outside: left in the DOM (React keeps owning its value and
 * its `change`), hidden, and covered by a face of our own that opens the
 * platform's `Menu` instead.
 *
 * The face is a sibling of the select inside the select's own parent, which is
 * what makes it behave: the panel clips it, scrolling carries it, and hiding the
 * tab hides it — all without this module watching any of that, because it is
 * where the select is. Only its offsets have to be kept in step with the
 * select's box as the form around it changes size.
 */

import { useEffect, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Chooser } from './controls.tsx'

/** One adopted select and the face covering it. */
interface Face {
  select: HTMLSelectElement
  host: HTMLDivElement
  root: Root
  /** Where the face was last put, to skip writes that would change nothing. */
  placed: string
  /** Re-render the face from the select's current options and value. */
  refresh: () => void
  /** Put the face back over the select's box. */
  place: () => void
  /** Drop the listeners that keep the face in step with the select. */
  detach: () => void
}

/**
 * Marks a select this module owns. The map below is per pass, so this attribute
 * is what keeps a second pass — another `NativeSelects` watching an overlapping
 * subtree — from adopting the same element and stacking a second face on it.
 */
const ADOPTED = 'dsxFace'

/**
 * Move a select's value the way React's own change event expects.
 *
 * The native setter is what makes this work: going through `select.value` would
 * update React's tracked value too, and the change event that follows would look
 * like no change at all and be swallowed.
 */
function pickValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (setter === undefined) return
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Move a node out of the way once React has finished the commit it is in. */
function afterCommit(work: () => void): void {
  // Unmounting a second root from inside a commit of another is what React
  // refuses; a microtask puts it after.
  queueMicrotask(work)
}

/** Mount a face for one select. */
function adopt(select: HTMLSelectElement, faces: Map<HTMLSelectElement, Face>, resize: ResizeObserver): Face {
  const parent = select.parentElement
  if (parent === null) throw new Error('an adopted select must be in the document')
  select.dataset[ADOPTED] = '1'
  // Occupying the box without being seen: the face is measured against it.
  select.style.visibility = 'hidden'
  const host = document.createElement('div')
  host.className = 'dsx-selectFaceHost'
  parent.insertBefore(host, select.nextSibling)
  const root = createRoot(host)

  const render = (): void => {
    root.render(
      <Chooser
        label={select.getAttribute('aria-label') ?? '选择'}
        value={select.value}
        options={[...select.options].map(option => ({
          value: option.value,
          label: option.textContent ?? '',
        }))}
        disabled={select.disabled}
        className="dsx-choiceFill"
        onChange={(next) => { pickValue(select, next) }}
      />,
    )
  }

  // A pick changes the select's value without touching its DOM, so nothing
  // would tell the face to re-read it and the label would keep naming the old
  // option. The event is the select's own, so it also covers a change React
  // made on its own. Deferred a microtask so a value React refuses (a stale
  // draft it writes back) is what the face ends up showing.
  const onChange = (): void => { queueMicrotask(render) }
  select.addEventListener('change', onChange)

  const face: Face = {
    select,
    host,
    root,
    placed: '',
    refresh: render,
    place: () => {
      const rect = select.getBoundingClientRect()
      if (!select.isConnected || rect.width === 0 || rect.height === 0) return
      // Offsets are against the parent's padding box, which is the origin an
      // absolutely positioned child is placed from.
      const box = parent.getBoundingClientRect()
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
      const left = rect.left - box.left - parent.clientLeft + parent.scrollLeft
      const top = rect.top - box.top - parent.clientTop + parent.scrollTop
      const next = `${left}|${top}|${rect.width}|${rect.height}`
      // Writing an unchanged value is not free: it is a style mutation, and on
      // this pass a style mutation anywhere under the scope is a reason to run
      // again.
      if (next === face.placed) return
      face.placed = next
      host.style.left = `${left}px`
      host.style.top = `${top}px`
      host.style.width = `${rect.width}px`
      host.style.height = `${rect.height}px`
    },
    detach: () => {
      select.removeEventListener('change', onChange)
      resize.unobserve(select)
    },
  }
  resize.observe(select)
  faces.set(select, face)
  return face
}

/** Take a face back down and give the select its own box again. */
function release(face: Face, faces: Map<HTMLSelectElement, Face>): void {
  faces.delete(face.select)
  face.detach()
  if (face.select.isConnected) {
    face.select.style.visibility = ''
    delete face.select.dataset[ADOPTED]
  }
  afterCommit(() => {
    face.root.unmount()
    face.host.remove()
  })
}

/**
 * Adopt every `<select>` under `scope`, and keep adopting as the mirrored
 * component re-renders.
 * @param scope - the subtree to watch; the mirrored provider editor and nothing
 *   outside it.
 * @returns a teardown that restores the selects untouched.
 */
export function upgradeNativeSelects(scope: HTMLElement): () => void {
  const faces = new Map<HTMLSelectElement, Face>()
  let disposed = false

  const placeAll = (): void => {
    for (const face of faces.values()) face.place()
  }

  const sync = (): void => {
    if (disposed) return
    for (const select of scope.querySelectorAll('select')) {
      const face = faces.get(select)
      if (face === undefined) adopt(select, faces, resize).refresh()
      // A later tick can bring a new value or a new option list, and a
      // re-render picks both up.
      else face.refresh()
    }
    for (const face of [...faces.values()]) {
      if (!face.select.isConnected || !scope.contains(face.select)) release(face, faces)
    }
    placeAll()
  }

  // The form reflows around the select without the select itself changing size
  // (a field above it gains a hint line), and the window can be resized; both
  // move the box the face has to cover.
  const resize = new ResizeObserver(placeAll)
  const observer = new MutationObserver(sync)
  // Only the two attributes the face mirrors. Watching every attribute would
  // also watch this pass writing its own style attributes, which is a reason to
  // run again.
  observer.observe(scope, { childList: true, subtree: true, attributeFilter: ['disabled', 'aria-label'] })
  window.addEventListener('resize', placeAll)
  sync()

  return () => {
    disposed = true
    observer.disconnect()
    resize.disconnect()
    window.removeEventListener('resize', placeAll)
    for (const face of [...faces.values()]) release(face, faces)
  }
}

/**
 * Nothing to look at: adopts the selects of the component next to it.
 * @param props.scope - the element holding the mirrored component, whose
 *   selects are the ones to adopt.
 */
export function NativeSelects({ scope }: { scope: RefObject<HTMLElement | null> }): ReactNode {
  useEffect(() => {
    const element = scope.current
    if (element === null) return
    return upgradeNativeSelects(element)
  }, [scope])
  return null
}
