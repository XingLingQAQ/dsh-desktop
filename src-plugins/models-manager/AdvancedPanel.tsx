/**
 * The 渠道 tab's advanced panel: the per-route settings the native provider
 * card leaves to `settings.yaml`.
 *
 * It renders *inside* the native provider editor — the card that opens under a
 * channel when the user presses 编辑 — as one more disclosure next to the
 * adapter's own 自定义 block. There is no separate card and no provider picker:
 * the editor already says which channel it is, so the panel under it edits that
 * one.
 *
 * The editor is not ours to edit. ui-settings-models renders it and declares no
 * slot for it, so it is adopted from the outside the same way `NativeSelects`
 * adopts the `<select>`s in that same card: the footer is found in the DOM, a
 * container is put just above it, and the block is portalled into that container.
 * Closing the editor removes the whole subtree, container included, and the
 * portal is released — nothing here has to know that a close happened.
 *
 * Which channel a block belongs to is read the same way: the editor header names
 * the route, or its display name when the two differ. That is only an identity
 * to look the profile up by; *what* may be edited still comes from
 * `settings.describe` and `llm.providers`, exactly as when this was a panel of
 * its own.
 *
 * Writes go through `settings.mutate` with the same one-op-per-top-level-key
 * discipline the native card uses, against the same stored section, so the two
 * editors cannot delete each other's fields: each names only what it changed,
 * and a key neither touched produces no op at all.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode, RefObject } from 'react'
import {
  Button, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  deletePath, draftOf, getPath, hasPath, hintFor, labelFor, optionLabel, pathOps,
  profileFields, schemaRoot, setPath, unwrap,
  type AdvancedApi, type ConfigurableProviderView, type FieldSpec,
  type SettingsNamespaceView,
} from './advanced.ts'
import { Chooser, IconAction } from './controls.tsx'

type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
    status: 'ready'
    writable: boolean
    providers: readonly ConfigurableProviderView[]
    namespaces: Map<string, SettingsNamespaceView>
  }

/** One open provider editor, and the identity read off its header. */
interface Slot {
  /** Stable across passes: the editor element never changes while it is open. */
  key: string
  /** The container inserted above the editor's footer, portalled into. */
  host: HTMLDivElement
  /** The route id, when the header names it. */
  route: string | undefined
  /** The display name, which is all the header carries for a shipped route. */
  title: string
}

/** Read the text of the first descendant matching a class token, or nothing. */
function textOf(root: Element, token: string): string | undefined {
  const found = root.querySelector(`[class*="${token}"]`)
  const text = found?.textContent?.trim()
  return text === undefined || text.length === 0 ? undefined : text
}

/** Object a value addresses, or an empty one. */
function objectAt(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Keep only the named keys, as a shallow copy of the value's own entries. */
function pick(source: Record<string, unknown>, kept: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (kept.has(key)) out[key] = source[key]
  }
  return out
}

/** True when two passes found the same editors for the same channels. */
function sameSlots(before: readonly Slot[], after: readonly Slot[]): boolean {
  return before.length === after.length
    && before.every((slot, index) => {
      const other = after[index]
      return other !== undefined
        && slot.key === other.key
        && slot.host === other.host
        && slot.route === other.route
        && slot.title === other.title
    })
}

/**
 * Watch a mirrored subtree for open provider editors and report one slot per
 * editor.
 *
 * The footer is the anchor rather than the card around it: the card's class is
 * this component's own business, while a footer is what every editor has to
 * render for its own save button to exist. The card is whatever holds that
 * footer.
 * @param scope - the subtree holding the mirrored provider page.
 * @returns one slot per open editor, each with the container to portal into.
 */
function useEditorPortals(scope: RefObject<HTMLElement | null>): readonly Slot[] {
  const [slots, setSlots] = useState<readonly Slot[]>([])
  const seq = useRef(0)

  useEffect(() => {
    const root = scope.current
    if (root === null) return
    const hosts = new Map<Element, { host: HTMLDivElement; key: string }>()

    const sync = (): void => {
      const next: Slot[] = []
      for (const footer of root.querySelectorAll('[class*="editorActions"]')) {
        const editor = footer.parentElement
        if (editor === null) continue
        const title = textOf(editor, 'editorTitle')
        // The add card renders the same footer but no header: there is no
        // channel to look up yet, and writing a profile for one the user has
        // not created would create it as a side effect of setting a timeout.
        if (title === undefined) continue
        let entry = hosts.get(editor)
        if (entry === undefined) {
          seq.current += 1
          const host = document.createElement('div')
          host.className = 'dsx-advancedHost'
          editor.insertBefore(host, footer)
          entry = { host, key: `advanced-${String(seq.current)}` }
          hosts.set(editor, entry)
        }
        next.push({ key: entry.key, host: entry.host, route: textOf(editor, 'editorRoute'), title })
      }
      // React has to let go of a portal before its container leaves the
      // document, or the unmount reaches a detached node; a microtask is after
      // the commit this pass is in.
      for (const [editor, entry] of [...hosts]) {
        if (editor.isConnected && root.contains(editor)) continue
        hosts.delete(editor)
        queueMicrotask(() => { entry.host.remove() })
      }
      setSlots(current => (sameSlots(current, next) ? current : next))
    }

    // Child lists only: this pass writes an attribute on its own containers, and
    // watching attributes would make every one of those writes a reason to run.
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true })
    sync()
    return () => {
      observer.disconnect()
      for (const entry of hosts.values()) {
        queueMicrotask(() => { entry.host.remove() })
      }
    }
  }, [scope])

  return slots
}

/**
 * Read the catalog and put a block into every open provider editor.
 * @param props.api - the connection face the settings and provider reads go
 *   through (see `AdvancedApi`).
 * @param props.scope - the element holding the mirrored provider page.
 */
export function ChannelAdvanced({ api, scope }: {
  api: AdvancedApi
  scope: RefObject<HTMLElement | null>
}): ReactNode {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setCatalog({ status: 'loading' })
    Promise.all([api.settings.describe({}), api.llm.providers({})]).then(
      ([described, listed]) => {
        if (!live) return
        const describedValue = unwrap(described)
        const namespaces = new Map(describedValue.namespaces.map(view => [view.ns, view]))
        const providers = unwrap(listed).providers.filter((entry) => {
          // No settings address means the route was registered outside the
          // configurable directory: there is no profile for this page to edit.
          if (entry.settingsNs.length === 0) return false
          const view = namespaces.get(entry.settingsNs)
          if (view === undefined) return false
          // Only channels the user actually has. A catalog route that is
          // neither live nor stored is one they have not added, and editing it
          // here would materialize a profile as a side effect of setting a
          // timeout — a change nobody asked a "refine this channel" panel for.
          return entry.active || hasPath(view.user, entry.settingsPath)
        })
        setCatalog({
          status: 'ready',
          writable: describedValue.writable,
          providers,
          namespaces,
        })
      },
      (error: unknown) => {
        if (live) {
          setCatalog({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      },
    )
    return () => { live = false }
  }, [api, attempt])

  const slots = useEditorPortals(scope)
  const blockFor = (slot: Slot): ReactNode => {
    if (catalog.status === 'loading') return <p className="dsx-advanced-note">读取配置中…</p>
    if (catalog.status === 'error') {
      return <p className="dsx-advanced-error" role="alert">{catalog.message}</p>
    }
    // The header names the route for a hand-declared channel and the display
    // name otherwise; the route is the exact answer, so it is tried first.
    const target = catalog.providers.find(entry => entry.provider === slot.route)
      ?? catalog.providers.find(entry => entry.displayName === slot.title)
    const namespace = target === undefined ? undefined : catalog.namespaces.get(target.settingsNs)
    if (target === undefined || namespace === undefined) return null
    return (
      <ProfileAdvanced
        key={`${namespace.ns} ${target.settingsPath.join(' ')}`}
        api={api}
        namespace={namespace}
        settingsPath={target.settingsPath}
        writable={catalog.writable}
        onReload={() => { setAttempt(value => value + 1) }}
      />
    )
  }

  return (
    <>
      {slots.map(slot => createPortal(blockFor(slot), slot.host, slot.key))}
    </>
  )
}

/** One provider profile's advanced fields. */
function ProfileAdvanced({ api, namespace, settingsPath, writable, onReload }: {
  api: AdvancedApi
  namespace: SettingsNamespaceView
  settingsPath: readonly string[]
  writable: boolean
  onReload: () => void
}): ReactNode {
  const [view, setView] = useState(namespace)
  const root = useMemo(() => schemaRoot(view.schema), [view.schema])
  const fields = useMemo(() => profileFields(root, settingsPath), [root, settingsPath])
  // Only the keys this panel renders take part in the draft. The profile also
  // carries what the native card owns — the key reference, the endpoint, the
  // model list — and a draft that included them would offer to "reset" fields
  // it cannot show, deleting the user's model catalog along with a timeout.
  const owned = useMemo(() => new Set(fields.map(spec => spec.key)), [fields])
  const [committed, setCommitted] = useState(() => pick(draftOf(namespace, settingsPath), owned))
  const [draft, setDraft] = useState(() => pick(draftOf(namespace, settingsPath), owned))
  const [revision, setRevision] = useState(namespace.revision)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  // The layer under the user's own: schema defaults over the composition base.
  // It is what an unset field actually resolves to, so it is what a control
  // shows until the user overrides it.
  const fallback = objectAt(getPath(view.value, settingsPath))
  const disabled = !writable || busy
  const dirty = JSON.stringify(draft) !== JSON.stringify(committed)
  const overridden = Object.keys(draft).length

  const field = (path: readonly string[]): Access => ({
    value: hasPath(draft, path) ? getPath(draft, path) : getPath(fallback, path),
    overridden: hasPath(draft, path),
    set: (next) => { setDraft(current => setPath(current, path, next)) },
    reset: () => { setDraft(current => deletePath(current, path)) },
  })

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const ops = pathOps(settingsPath, committed, draft)
      if (ops.length === 0) return
      const response = await api.settings.mutate({
        ns: view.ns,
        ops,
        expectedRevision: revision,
      })
      if (!response.result.ok) {
        setFailure(response.result.error.code === 'settings-conflict'
          ? '配置在别处被改过了,点「重新读取」再看一遍。'
          : response.result.error.message)
        return
      }
      const next = response.result.value
      // The write's own answer is the new baseline: refetching could race a
      // further edit, and the response already carries the stored user layer.
      setView(next)
      const stored = pick(draftOf(next, settingsPath), owned)
      setCommitted(stored)
      setDraft(stored)
      setRevision(next.revision)
      setSaved(true)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="dsx-advanced">
      <summary className="dsx-advanced-summary">
        高级设置
        <span className="dsx-advanced-summaryTail">超时 · 重试 · 传输 · 兼容性</span>
        <span className="dsx-advanced-count">
          {overridden > 0 ? `已自定义 ${String(overridden)} 项` : '全部使用默认值'}
        </span>
      </summary>
      <div className="dsx-advanced-body">
        {!writable ? (
          <p className="dsx-advanced-note">当前配置源是只读的,改动无法保存。</p>
        ) : null}
        <div className="dsx-advanced-meta">
          <span className="dsx-advanced-path">
            {view.ns}{settingsPath.length > 0 ? ` · ${settingsPath.join(' / ')}` : ''}
          </span>
          <span className="dsx-advanced-filler" />
          <IconAction label="重新读取" icon={<IconRefreshOutline16 />} onClick={onReload} />
        </div>

        {view.applies === 'restart' ? (
          // Worth saying before the user wonders why nothing took effect: this
          // adapter only reads its profile when the host starts.
          <p className="dsx-advanced-note">这个渠道的配置要重启宿主后才会生效。</p>
        ) : null}

        {fields.length === 0 ? <p className="dsx-advanced-note">这个渠道没有可调整的高级项。</p> : null}

        <div className="dsx-advanced-grid">
          {fields.map(spec => (
            <FieldControl
              key={spec.key}
              spec={spec}
              path={[spec.key]}
              access={field}
              fallback={fallback}
              disabled={disabled}
              depth={0}
            />
          ))}
        </div>

        {failure !== undefined ? <p className="dsx-advanced-error" role="alert">{failure}</p> : null}
        {saved ? <p className="dsx-advanced-saved" role="status">已保存</p> : null}

        {/* Two save buttons now live in one card — this one and the channel
            editor's own — so each names what it saves rather than resting on
            its position to say it. */}
        <div className="dsx-advanced-actions">
          <Button
            variant="primary"
            disabled={disabled || !dirty}
            onClick={() => { void apply() }}
          >
            {busy ? '保存中…' : '保存高级设置'}
          </Button>
          <Button
            variant="outline"
            disabled={disabled || !dirty}
            onClick={() => { setDraft(committed); setFailure(undefined); setSaved(false) }}
          >
            放弃改动
          </Button>
          <span className="dsx-advanced-filler" />
          {dirty ? <span className="dsx-advanced-dirty">有未保存的改动</span> : null}
          <Button
            variant="ghost"
            className="dsx-advanced-danger dsx-advanced-danger"
            disabled={disabled || overridden === 0}
            onClick={() => { setDraft({}); setFailure(undefined); setSaved(false) }}
          >
            全部恢复默认
          </Button>
        </div>
      </div>
    </details>
  )
}

/** The value a control starts from: the user's own, or the layer under it. */
interface Access {
  value: unknown
  overridden: boolean
  set: (next: unknown) => void
  reset: () => void
}

/** One control, chosen by the node's shape. */
function FieldControl({ spec, path, access, fallback, disabled, depth }: {
  spec: FieldSpec
  path: readonly string[]
  access: (path: readonly string[]) => Access
  fallback: Record<string, unknown>
  disabled: boolean
  depth: number
}): ReactNode {
  const here = access(path)
  const key = path[path.length - 1] as string
  const nested = depth > 0
  const hint = hintFor(path)

  const wrapper = (control: ReactNode): ReactNode => (
    <div
      className={`dsx-advanced-field${nested ? ' dsx-advanced-nested' : ''}`}
      data-overridden={here.overridden ? 'true' : undefined}
    >
      <span className="dsx-advanced-labelRow">
        <span className="dsx-advanced-label">{labelFor(path)}</span>
        {here.overridden ? (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={here.reset}>
            恢复默认
          </Button>
        ) : null}
      </span>
      {control}
      {hint === undefined ? null : <small className="dsx-advanced-hint">{hint}</small>}
    </div>
  )

  switch (spec.kind) {
    case 'boolean':
      return wrapper(
        <label className="dsx-advanced-toggle">
          <input
            type="checkbox"
            checked={here.value === true}
            disabled={disabled}
            onChange={(event) => { here.set(event.currentTarget.checked) }}
          />
          <span>{here.value === true ? '开启' : '关闭'}</span>
        </label>,
      )

    case 'number': {
      const meta = spec.node.meta ?? {}
      return wrapper(
        <input
          className="dsx-advanced-input"
          type="number"
          value={typeof here.value === 'number' ? String(here.value) : ''}
          placeholder={`默认 ${String(getPath(fallback, [key]) ?? '未设置')}`}
          disabled={disabled}
          {...meta.min === undefined ? {} : { min: meta.min }}
          {...meta.max === undefined ? {} : { max: meta.max }}
          {...meta.step === undefined ? {} : { step: meta.step }}
          onChange={(event) => {
            const raw = event.currentTarget.value
            // Cleared rather than stored as 0: an empty box means "no
            // opinion", and writing 0 would be a real, different setting.
            if (raw.trim().length === 0) { here.reset(); return }
            const next = Number(raw)
            if (Number.isFinite(next)) here.set(next)
          }}
        />,
      )
    }

    case 'string':
      return wrapper(
        <input
          className="dsx-advanced-input"
          type="text"
          value={typeof here.value === 'string' ? here.value : ''}
          disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.value
            if (next.trim().length === 0) { here.reset(); return }
            here.set(next)
          }}
        />,
      )

    case 'enum':
      return wrapper(
        <Chooser
          label={labelFor(path)}
          disabled={disabled}
          value={typeof here.value === 'string' ? here.value : ''}
          options={[
            // The empty row is not a value: it is the absence of one, and
            // picking it drops the override instead of writing "".
            { value: '', label: '(未设置)' },
            ...spec.options.map(option => ({ value: option, label: optionLabel(key, option) })),
          ]}
          onChange={(next) => {
            if (next.length === 0) { here.reset(); return }
            here.set(next)
          }}
        />,
      )

    case 'multienum': {
      const chosen = Array.isArray(here.value) ? here.value as string[] : []
      return wrapper(
        <span className="dsx-advanced-checks">
          {spec.options.map(option => (
            <label key={option} className="dsx-advanced-check">
              <input
                type="checkbox"
                checked={chosen.includes(option)}
                disabled={disabled}
                onChange={(event) => {
                  here.set(event.currentTarget.checked
                    ? [...chosen, option]
                    : chosen.filter(entry => entry !== option))
                }}
              />
              <span>{optionLabel(key, option)}</span>
            </label>
          ))}
        </span>,
      )
    }

    case 'stringlist':
      return wrapper(
        <StringListField
          value={Array.isArray(here.value) ? here.value as string[] : []}
          disabled={disabled}
          onChange={here.set}
          onReset={here.reset}
        />,
      )

    case 'textmap':
      return wrapper(
        <TextMapField
          value={objectAt(here.value)}
          disabled={disabled}
          onChange={here.set}
          onReset={here.reset}
        />,
      )

    case 'group':
      return wrapper(
        <span className="dsx-advanced-group">
          {spec.fields.map(child => (
            <FieldControl
              key={child.key}
              spec={child}
              path={[...path, child.key]}
              access={access}
              fallback={objectAt(getPath(fallback, [key]))}
              disabled={disabled}
              depth={depth + 1}
            />
          ))}
        </span>,
      )

    case 'variant': {
      // One key holds the whole variant object, so its mode always travels
      // with any sub-field edit: the schema requires the tag, and writing a
      // sub-field alone would strip it.
      const current = objectAt(here.value)
      const mode = typeof current['mode'] === 'string' && spec.modes.includes(current['mode'])
        ? current['mode']
        : spec.modes[0] as string
      const rows = spec.fields[mode] ?? []
      return wrapper(
        <span className="dsx-advanced-group">
          <FieldControl
            spec={{ kind: 'enum', key: 'mode', node: spec.node, options: spec.modes }}
            path={[...path, 'mode']}
            access={() => ({
              value: mode,
              overridden: here.overridden,
              set: (next) => {
                // Switching variants drops the keys the new one does not
                // declare: they are inert for it, and leaving them behind would
                // keep a "max retries" the user can no longer see or clear.
                // Keys both variants share (the backoff) survive the switch.
                const target = String(next)
                const allowed = new Set((spec.fields[target] ?? []).map(child => child.key))
                const kept: Record<string, unknown> = {}
                for (const [name, value] of Object.entries(current)) {
                  if (allowed.has(name)) kept[name] = value
                }
                here.set({ ...kept, mode: target })
              },
              reset: here.reset,
            })}
            fallback={objectAt(getPath(fallback, [key]))}
            disabled={disabled}
            depth={depth + 1}
          />
          {rows.map(child => (
            <FieldControl
              key={child.key}
              spec={child}
              path={[...path, child.key]}
              access={() => ({
                value: current[child.key],
                overridden: here.overridden && child.key in current,
                set: (next) => { here.set({ ...current, mode, [child.key]: next }) },
                reset: () => {
                  // Annotated because the spread of an index signature plus a
                  // known key collapses to just that key, and the `delete`
                  // below needs the open shape back.
                  const rest: Record<string, unknown> = { ...current, mode }
                  delete rest[child.key]
                  here.set(rest)
                },
              })}
              fallback={objectAt(getPath(fallback, [key]))}
              disabled={disabled}
              depth={depth + 1}
            />
          ))}
        </span>,
      )
    }
  }
}

/**
 * A comma-separated string list. The text is local state and the parsed array
 * is what reaches the draft, so a half-typed separator never round-trips
 * through the profile and back into the box.
 *
 * The incoming value is re-read only while the box is unfocused: every
 * keystroke here also writes the draft, and syncing on that write would fight
 * the typist. An outside change (a reset, a reload) arrives unfocused and is
 * picked up.
 */
function StringListField({ value, disabled, onChange, onReset }: {
  value: readonly string[]
  disabled: boolean
  onChange: (next: unknown) => void
  onReset: () => void
}): ReactNode {
  const [text, setText] = useState(() => value.join(', '))
  const input = useRef<HTMLInputElement>(null)
  const signature = JSON.stringify(value)
  useEffect(() => {
    if (input.current !== null && document.activeElement === input.current) return
    setText(value.join(', '))
    // `signature` is the whole dependency: a same-content array is a new
    // identity on every render, and re-running on that would reset the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return (
    <input
      ref={input}
      className="dsx-advanced-input"
      type="text"
      value={text}
      placeholder="逗号分隔"
      disabled={disabled}
      onChange={(event) => {
        const next = event.currentTarget.value
        setText(next)
        const parsed = next.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
        if (parsed.length === 0) onReset()
        else onChange(parsed)
      }}
    />
  )
}

/**
 * A string→string map (the `headers` shape). Rows live here until they have a
 * name, so an empty row survives long enough to be typed into — a map with no
 * key cannot be stored, and committing through the profile would erase it.
 */
function TextMapField({ value, disabled, onChange, onReset }: {
  value: Record<string, unknown>
  disabled: boolean
  onChange: (next: unknown) => void
  onReset: () => void
}): ReactNode {
  const rowsFrom = (source: Record<string, unknown>): [string, string][] =>
    Object.entries(source).map(([name, entry]) => [name, String(entry)])
  const [rows, setRows] = useState<[string, string][]>(() => rowsFrom(value))
  const container = useRef<HTMLSpanElement>(null)
  const signature = JSON.stringify(value)
  useEffect(() => {
    // Same rule as the list field: a focused row means the user is mid-edit,
    // and rebuilding the rows from the committed map would drop the nameless
    // row they are typing into.
    if (container.current?.contains(document.activeElement) === true) return
    setRows(rowsFrom(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const commit = (next: [string, string][]): void => {
    setRows(next)
    const named: Record<string, string> = {}
    for (const [name, entry] of next) {
      if (name.trim().length > 0) named[name.trim()] = entry
    }
    if (Object.keys(named).length === 0) onReset()
    else onChange(named)
  }

  const edit = (index: number, at: 0 | 1, text: string): void => {
    commit(rows.map((row, position): [string, string] => {
      if (position !== index) return row
      return at === 0 ? [text, row[1]] : [row[0], text]
    }))
  }

  return (
    <span ref={container} className="dsx-advanced-map">
      {rows.map(([name, entry], index) => (
        <span key={String(index)} className="dsx-advanced-mapRow">
          <input
            className="dsx-advanced-input"
            type="text"
            value={name}
            aria-label="名称"
            disabled={disabled}
            onChange={(event) => { edit(index, 0, event.currentTarget.value) }}
          />
          <input
            className="dsx-advanced-input"
            type="text"
            value={entry}
            aria-label="值"
            disabled={disabled}
            onChange={(event) => { edit(index, 1, event.currentTarget.value) }}
          />
          <Button
            size="sm"
            variant="ghost"
            className="dsx-advanced-danger dsx-advanced-danger"
            disabled={disabled}
            onClick={() => { commit(rows.filter((_, position) => position !== index)) }}
          >
            删除
          </Button>
        </span>
      ))}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => { setRows(current => [...current, ['', '']]) }}
      >
        添加一项
      </Button>
    </span>
  )
}
