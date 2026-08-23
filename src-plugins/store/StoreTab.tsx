/** The store tab body: search, filter, and install from the registry catalog. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  formatDate, formatStars, install, readCatalog, readInstalled, uninstall,
  type Catalog, type CatalogPlugin,
} from './data.ts'

type Filter = 'all' | 'ui' | 'installed'

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: '可安装' },
  { id: 'ui', label: '带界面' },
  { id: 'installed', label: '已安装' },
]

/**
 * The catalog runs to a few hundred entries. Rendering them all buries the
 * search box under a scrollbar nobody wants to drag, so the list is capped and
 * the remainder is reachable by narrowing instead.
 */
const RENDER_CAP = 60

export function StoreTab(): React.ReactElement {
  const [catalog, setCatalog] = useState<Catalog | undefined>(undefined)
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const refreshInstalled = useCallback(async () => {
    const list = await readInstalled()
    setInstalled(new Set(list.map(item => item.id)))
  }, [])

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError(undefined)
    try {
      // The installed set is local and cheap; the catalog may come from cache.
      const [next] = await Promise.all([readCatalog(force), refreshInstalled()])
      setCatalog(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [refreshInstalled])

  useEffect(() => { void load(false) }, [load])

  const act = useCallback(async (plugin: CatalogPlugin, remove: boolean) => {
    setBusy(plugin.id)
    setError(undefined)
    try {
      await (remove ? uninstall(plugin.id) : install(plugin))
      await refreshInstalled()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }, [refreshInstalled])

  const visible = useMemo(() => {
    const all = catalog?.plugins ?? []
    const needle = query.trim().toLowerCase()
    return all.filter((plugin) => {
      // Entries without a published package cannot be installed from here, so
      // they are hidden unless already on disk.
      if (!plugin.installable && !installed.has(plugin.id)) return false
      if (filter === 'ui' && plugin.client === null) return false
      if (filter === 'installed' && !installed.has(plugin.id)) return false
      if (needle === '') return true
      return `${plugin.id} ${plugin.repo} ${plugin.description}`.toLowerCase().includes(needle)
    })
  }, [catalog, query, filter, installed])

  return (
    <div className="dsx-store">
      <div className="dsx-store-bar">
        <div className="dsx-store-search">
          <Input
            value={query}
            placeholder="搜索插件名、仓库或描述"
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>
        <div className="dsx-store-filters">
          {FILTERS.map(entry => (
            <button
              key={entry.id}
              type="button"
              className="dsx-store-filter"
              data-active={filter === entry.id}
              onClick={() => { setFilter(entry.id) }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <Button variant="secondary" disabled={loading} onClick={() => { void load(true) }}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      <div className="dsx-store-meta">
        <span>共 {String(visible.length)} 个</span>
        {catalog !== undefined && (
          <>
            <span>·</span>
            <span>目录更新于 {formatDate(catalog.generatedAt)}</span>
            <span>·</span>
            <span>
              {String(catalog.source.scanned)} 个候选中验真 {String(catalog.source.accepted)} 个，
              其中 {String(catalog.source.installable)} 个已发布可装
            </span>
          </>
        )}
      </div>

      {error !== undefined && <div className="dsx-store-error">{error}</div>}

      {loading && catalog === undefined
        ? <div className="dsx-store-empty">正在获取插件目录…</div>
        : visible.length === 0
          ? <div className="dsx-store-empty">没有匹配的插件</div>
          : (
            <>
              <div className="dsx-store-list">
                {visible.slice(0, RENDER_CAP).map(plugin => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    installed={installed.has(plugin.id)}
                    busy={busy === plugin.id}
                    onAct={act}
                  />
                ))}
              </div>
              {visible.length > RENDER_CAP && (
                <div className="dsx-store-empty">
                  还有 {String(visible.length - RENDER_CAP)} 个未显示，用搜索缩小范围
                </div>
              )}
            </>
          )}
    </div>
  )
}

interface PluginRowProps {
  plugin: CatalogPlugin
  installed: boolean
  busy: boolean
  onAct: (plugin: CatalogPlugin, remove: boolean) => Promise<void>
}

function PluginRow({ plugin, installed, busy, onAct }: PluginRowProps): React.ReactElement {
  return (
    <div className="dsx-store-card">
      <div className="dsx-store-card-body">
        <div className="dsx-store-title">
          <span className="dsx-store-name">{plugin.id}</span>
          <Pill>v{plugin.npm?.version ?? plugin.version}</Pill>
          {plugin.client !== null && <Pill>界面</Pill>}
          {plugin.host !== null && <Pill>后端</Pill>}
        </div>
        {plugin.description !== '' && <div className="dsx-store-desc">{plugin.description}</div>}
        <div className="dsx-store-facts">
          <a
            className="dsx-store-repo"
            href={`https://github.com/${plugin.repo}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {plugin.repo}
          </a>
          <span>★ {formatStars(plugin.stars)}</span>
          {plugin.license !== null && <span>{plugin.license}</span>}
          {plugin.updatedAt !== null && <span>更新于 {formatDate(plugin.updatedAt)}</span>}
        </div>
      </div>
      <div className="dsx-store-actions">
        <Button
          variant={installed ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => { void onAct(plugin, installed) }}
        >
          {busy ? '处理中…' : installed ? '卸载' : '安装'}
        </Button>
      </div>
    </div>
  )
}
