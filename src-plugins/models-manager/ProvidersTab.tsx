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
  Button, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
        <Button onClick={reload}>重试</Button>
      </div>
    )
  }

  const { rows, writable, namespaces } = catalog

  return (
    <div className="dsx-providers">
      <div className="dsx-providers-head">
        <div>
          <h3 className="dsx-providers-title">渠道</h3>
          <p className="dsx-providers-note">
            {writable ? '这些是当前部署已注册的模型渠道。' : '当前设置是只读的，无法修改渠道。'}
          </p>
        </div>
        <Button variant="outline" onClick={reload}>
          <IconRefreshOutline16 aria-hidden="true" />
          刷新
        </Button>
      </div>

      {rows.length === 0
        ? <p className="dsx-providers-note">还没有可配置的渠道。</p>
        : (
          <ul className="dsx-providers-list">
            {rows.map((row) => (
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
    <li className="dsx-provider" data-open={open ? 'true' : undefined}>
      <button type="button" className="dsx-provider-head" onClick={onToggle}>
        <span className="dsx-provider-name">{row.displayName}</span>
        <span className="dsx-provider-route">{row.provider}</span>
        {row.declared === true && <span className="dsx-provider-tag">自定义</span>}
        {!row.active && <span className="dsx-provider-tag dsx-provider-tag-off">未注册</span>}
        <span
          className="dsx-provider-dot"
          data-state={row.keyRef === undefined ? 'none' : row.keyConfigured ? 'on' : 'off'}
          aria-hidden="true"
        />
        <span className="dsx-provider-state">
          {row.keyRef === undefined
            ? '无需密钥'
            : row.keyConfigured ? '已配置密钥' : '未配置密钥'}
        </span>
      </button>
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
        <Button onClick={() => void save()} disabled={disabled || draft.length === 0}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </div>
      {error !== null && <p className="dsx-providers-note dsx-providers-error">{error}</p>}
      {done && error === null && <p className="dsx-providers-note">密钥已保存。</p>}
    </div>
  )
}
