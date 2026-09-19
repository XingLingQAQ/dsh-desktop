/**
 * 渠道 — the Models page's channel list, owned by this desktop.
 *
 * DSH's own `settings.section id='models'` renders this page from a component
 * that cannot be reused here. Two things stopped the earlier approach of
 * re-hosting it (see the note in `index.tsx`):
 *
 *  - it renders its own child slots (`settings.models.provider-card`,
 *    `settings.models.footer`), and the slot runtime authorizes those keys only
 *    on the entry whose `children` table declared them — a shadowing
 *    registration cannot declare them too, because a child-slot declaration is
 *    exclusive and the native entry already holds it;
 *  - so the mirrored component called a seat that no longer existed, threw
 *    `renderSlot is not a function`, and took the whole `settings.models.tab`
 *    dispatch entry down with it — which is why both 渠道 and the 插件 manager
 *    went blank.
 *
 * Owning the page removes the knot. The data comes from this desktop's own host
 * route rather than the client connection handle, because that handle no longer
 * carries an `api` member in the build that ships (see `providers.ts`), so the
 * page reads the same Host services the native page's wire calls were a
 * projection of.
 *
 * Scope is deliberately narrower than the native card's: a channel is listed
 * with its identity and its key state, the key is writable, and the per-route
 * profile the native card keeps in `settings.yaml` is reachable under 高级设置.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  readProviders, readNamespaces, saveKey,
  type ChannelRow, type NamespaceView,
} from './providers.ts'
import { AdvancedFields } from './AdvancedPanel.tsx'

type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
    status: 'ready'
    writable: boolean
    rows: readonly ChannelRow[]
    namespaces: Map<string, NamespaceView>
  }

/**
 * The 渠道 page.
 * @returns the rendered list, or the state that stands in for it.
 */
export function ProvidersTab(): ReactNode {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let live = true
    setCatalog({ status: 'loading' })
    Promise.all([readProviders(), readNamespaces()]).then(
      ([listed, described]) => {
        if (!live) return
        setCatalog({
          status: 'ready',
          writable: listed.writable && described.writable,
          rows: listed.providers,
          namespaces: described.namespaces,
        })
      },
      (error: unknown) => {
        if (live) {
          setCatalog({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => { live = false }
  }, [attempt])

  const reload = useCallback(() => { setAttempt(value => value + 1) }, [])

  if (catalog.status === 'loading') {
    return <p className="dsx-providers-note">正在读取渠道…</p>
  }
  if (catalog.status === 'error') {
    return (
      <div className="dsx-providers-empty">
        <p className="dsx-providers-note dsx-providers-error">{catalog.message}</p>
        <button type="button" className="dsx-provider-save" onClick={reload}>重试</button>
      </div>
    )
  }

  const { rows, writable, namespaces } = catalog

  // Only the channels that are actually set up belong on the page. The rest of
  // the directory is a *catalog* — forty-odd shipped routes the adapter can
  // serve — and dumping it here is what made this page read as a wall of noise
  // instead of the native one. The native page draws the same line:
  //
  //   configured = rows.filter(row => row.configured)
  //   addable    = configurable.filter(row => !row.configured)
  //
  // with everything unconfigured reachable only through the add affordance.
  // A route counts as configured when its namespace resolved and either it has
  // no settings address of its own or a profile exists at that address.
  const configured = rows.filter(row => row.configured)
  const addable = rows.filter(row => !row.configured && namespaces.has(row.settingsNs))

  return (
    <div className="dsx-providers">
      <h3 className="dsx-providers-title">渠道</h3>
      <p className="dsx-providers-note">
        {writable
          ? '配置和查看本部署的模型渠道。'
          : '当前设置是只读的，改动无法保存。'}
      </p>

      {configured.length === 0
        ? <p className="dsx-providers-note">还没有配置任何渠道。</p>
        : (
          <ul className="dsx-providers-list">
            {configured.map((row) => (
              <ChannelCard
                key={row.provider}
                row={row}
                namespaces={namespaces}
                writable={writable}
                open={openId === row.provider}
                onToggle={() => {
                  setOpenId(openId === row.provider ? null : row.provider)
                }}
                onChanged={reload}
              />
            ))}
          </ul>
        )}

      {addable.length > 0 && (
        <div className="dsx-providers-add">
          <button
            type="button"
            className="dsx-providers-addButton"
            disabled={!writable}
            onClick={() => { setAdding(true) }}
          >
            ＋ 添加渠道
          </button>
        </div>
      )}

      {adding && (
        <ul className="dsx-providers-list">
          {addable.map((row) => (
            <li key={row.provider} className="dsx-provider">
              <div className="dsx-provider-head">
                <span className="dsx-provider-identity">
                  <span className="dsx-provider-name">{row.displayName}</span>
                  <span className="dsx-provider-route">{row.provider}</span>
                </span>
                <span className="dsx-provider-actions">
                  <button
                    type="button"
                    className="dsx-provider-action"
                    onClick={() => { setOpenId(row.provider); setAdding(false) }}
                  >
                    配置
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One channel: its identity always, its editor when opened. */
function ChannelCard({ row, namespaces, writable, open, onToggle, onChanged }: {
  row: ChannelRow
  namespaces: Map<string, NamespaceView>
  writable: boolean
  open: boolean
  onToggle: () => void
  onChanged: () => void
}): ReactNode {
  const namespace = useMemo(
    () => namespaces.get(row.settingsNs),
    [namespaces, row.settingsNs],
  )
  return (
    <li className="dsx-provider">
      {/* Identity left, actions right — the native row's own shape. The dot is
          that page's whole key-state readout, and its accessible name carries
          the same fact, so sighted and screen-reader readers agree. */}
      <div className="dsx-provider-head">
        <span className="dsx-provider-identity">
          <span className="dsx-provider-name">{row.displayName}</span>
          {row.declared === true && <span className="dsx-provider-tag">自定义</span>}
          {row.keyRef !== undefined && (
            <span
              className="dsx-provider-dot"
              data-state={row.keyConfigured ? 'on' : 'off'}
              role="img"
              aria-label={row.keyConfigured ? '已配置密钥' : '未配置密钥'}
              title={row.keyConfigured ? '已配置密钥' : '未配置密钥'}
            />
          )}
        </span>
        <span className="dsx-provider-actions">
          <button
            type="button"
            className="dsx-provider-action"
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? '收起' : '编辑'}
          </button>
        </span>
      </div>
      {open && (
        <div className="dsx-provider-body">
          <CredentialRow row={row} writable={writable} onChanged={onChanged} />
          {namespace !== undefined && (
            <AdvancedFields
              namespace={namespace}
              settingsPath={row.settingsPath}
              writable={writable}
              onReload={onChanged}
            />
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The route's key field.
 *
 * A typed key is stored under the reference the profile already names; the
 * profile is pointed at a reference only when it named none, which is the same
 * discipline the native card follows — a route with its own auth path (a
 * gateway that needs nothing, Bedrock's chain) must not be given one it never
 * wanted.
 */
function CredentialRow({ row, writable, onChanged }: {
  row: ChannelRow
  writable: boolean
  onChanged: () => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const disabled = !writable || busy

  const save = async () => {
    if (draft.length === 0) return
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await saveKey(row, draft, row.keyRef === undefined)
      setDraft('')
      setDone(true)
      onChanged()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dsx-provider-field">
      <label className="dsx-provider-label">
        <span>API 密钥</span>
        <span className="dsx-provider-hint">
          {row.keyRef ?? `${row.provider.toUpperCase()}_API_KEY`}
        </span>
      </label>
      <div className="dsx-provider-row">
        <input
          type="password"
          className="dsx-input"
          value={draft}
          placeholder={row.keyConfigured ? '已保存，输入新值可覆盖' : '粘贴密钥'}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button
          type="button"
          className="dsx-provider-save"
          disabled={disabled || draft.length === 0}
          onClick={() => void save()}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      {error !== null && <p className="dsx-providers-note dsx-providers-error" role="alert">{error}</p>}
      {done && error === null && <p className="dsx-providers-note dsx-providers-saved" role="status">密钥已保存。</p>}
    </div>
  )
}
