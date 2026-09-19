/**
 * The snapshot store, in the shape the vendored models page expects.
 *
 * The native page builds its state from `createSnapshotStore` in
 * `@deepseek-ai/dsh-client-runtime/client`, which this desktop cannot import:
 * the package is not one of the platform words a plugin bundle may require, and
 * its engine (zustand + immer) is not a dependency here either. Only four
 * members of the contract are used — `getSnapshot`, `subscribe`, `update`, `set`
 * — so the engine is reimplemented rather than pulled in, with the same
 * observable semantics the slot renderer's `useSyncExternalStore` needs.
 *
 * Two behaviours are deliberately preserved because the page depends on them:
 *
 *  - `update` hands the mutator a draft it may mutate in place. The real one
 *    uses immer's `produce`; here the draft is a structural clone, which is
 *    enough for the plain state these two stores hold (no Map, Set, Date, or
 *    class instance crosses them) and keeps the call sites unchanged.
 *  - notifications are synchronous on the same tick, which is the engine's
 *    default ('sync') and what a controlled input needs for same-tick echo.
 *    The frame-batched 'raf' mode exists upstream but this page does not use it.
 */

/** Minimal observable snapshot source. */
export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** Writable snapshot store. */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /** Mutate the state through a draft. */
  update(mutator: (draft: T) => void): void
  /** Replace the state wholesale. */
  set(next: T): void
}

/**
 * Clone a state value for the draft handed to `update`.
 *
 * A structural clone via `structuredClone` where it exists, and a JSON round
 * trip otherwise. Both are correct for the plain JSON-shaped state these stores
 * hold, and both leave the store's own value untouched until the mutator
 * returns — which is what makes a mutator that throws leave no partial write.
 * @param value - the current state.
 * @returns a detached copy.
 */
function draftOf<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Create a snapshot store.
 * @param init - initial state.
 * @returns the store.
 */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update: (mutator) => {
      const draft = draftOf(state)
      mutator(draft)
      state = draft
      notify()
    },
    set: (next) => {
      state = next
      notify()
    },
  }
}

/** Shallow equality, for selector slices. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.is(left[key], right[key]))
}
