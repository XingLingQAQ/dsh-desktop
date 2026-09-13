/** The store tab body: search, filter, and install from the registry catalog. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CATEGORIES, categoryLabel, compareVersions, formatDate, formatStars, install,
  readCatalog, readInstalled, readReadme, uninstall, updatePlugin,
  type Catalog, type CatalogPlugin,
} from './data.ts'
import { renderReadmeHtml } from './markdown.ts'
import { openConfirm } from './ConfirmDialog.tsx'
import { openAlert, runTask } from './TaskDialog.tsx'

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

/** Shared enter/leave transition for list cards: quick fade + upward drift. */
const cardVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
}

/** Stagger per-card entry so a fresh list reads as a cascade, not a flash. */
function cardTransition(index: number) {
  return { duration: 0.22, ease: [0.25, 0.1, 0.25, 1] as const, delay: Math.min(index * 0.03, 0.3) }
}

export function StoreTab(): React.ReactElement {
  const [catalog, setCatalog] = useState<Catalog | undefined>(undefined)
  // id → installed version, kept instead of a bare id set so the list can flag
  // entries whose catalog version is newer than what is on disk.
  const [installedVersions, setInstalledVersions] = useState<ReadonlyMap<string, string>>(new Map())
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [category, setCategory] = useState<string>('all')
  const [selected, setSelected] = useState<CatalogPlugin | undefined>(undefined)

  const refreshInstalled = useCallback(async () => {
    const list = await readInstalled()
    setInstalledVersions(new Map(list.map(item => [item.id, item.version])))
  }, [])

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError(undefined)
    try {
      // The installed set is local and cheap; the catalog may come from cache.
      const [next] = await Promise.all([readCatalog(force), refreshInstalled()])
      setCatalog(next)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      // Only a refresh the user asked for gets a dialog: the first load happens
      // on mount, and an offline machine should not greet the tab with a popup.
      if (force) {
        await openAlert({ title: '刷新失败', description: '无法获取插件目录', detail: message })
      }
    } finally {
      setLoading(false)
    }
  }, [refreshInstalled])

  useEffect(() => { void load(false) }, [load])

  const act = useCallback(async (plugin: CatalogPlugin, remove: boolean) => {
    if (remove) {
      const ok = await openConfirm({
        title: '卸载插件',
        description: `将「${plugin.id}」从桌面插件目录中移除。此操作不可撤销。`,
        confirmLabel: '卸载',
      })
      if (!ok) return
    }
    setBusy(plugin.id)
    setError(undefined)
    // The dialog owns the waiting and the failure message; the row keeps its own
    // busy state so the card stays disabled behind it.
    const ok = await runTask({
      title: remove ? '卸载插件' : '安装插件',
      description: plugin.id,
      step: remove ? '正在移除插件文件…' : '正在准备下载…',
      // Only the download reports bytes; a removal has no measurable middle.
      progressId: remove ? undefined : plugin.id,
      run: async (report) => {
        if (remove) {
          await uninstall(plugin.id)
        } else {
          await install(plugin)
        }
        report('正在刷新已安装列表…')
        await refreshInstalled()
      },
    })
    if (!ok) setError(remove ? '卸载失败' : '安装失败')
    setBusy(undefined)
  }, [refreshInstalled])

  /** Install-over-the-top for an outdated entry; same spinner slot as install. */
  const upgrade = useCallback(async (plugin: CatalogPlugin) => {
    if (plugin.npm === null) {
      await openAlert({ title: '无法更新', description: '该插件未发布到 npm' })
      return
    }
    const tarball = plugin.npm.tarball
    setBusy(plugin.id)
    setError(undefined)
    const ok = await runTask({
      title: '更新插件',
      description: plugin.id,
      step: '正在准备下载…',
      progressId: plugin.id,
      run: async (report) => {
        await updatePlugin(plugin.id, tarball)
        report('正在刷新已安装列表…')
        await refreshInstalled()
      },
    })
    if (!ok) setError('更新失败')
    setBusy(undefined)
  }, [refreshInstalled])

  const visible = useMemo(() => {
    const all = catalog?.plugins ?? []
    const needle = query.trim().toLowerCase()
    return all.filter((plugin) => {
      // Entries without a published package cannot be installed from here, so
      // they are hidden unless already on disk.
      if (!plugin.installable && !installedVersions.has(plugin.id)) return false
      if (filter === 'ui' && plugin.client === null) return false
      if (filter === 'installed' && !installedVersions.has(plugin.id)) return false
      // `category` is undefined on legacy catalog entries; a concrete selection
      // drops them, `all` keeps them.
      if (category !== 'all' && plugin.category !== category) return false
      if (needle === '') return true
      return `${plugin.id} ${plugin.repo} ${plugin.description}`.toLowerCase().includes(needle)
    })
  }, [catalog, query, filter, category, installedVersions])

  if (selected !== undefined) {
    const installedVersion = installedVersions.get(selected.id)
    return (
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key="detail"
          className="dsx-store-detail"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <PluginDetail
            plugin={selected}
            installedVersion={installedVersion}
            busy={busy === selected.id}
            onAct={act}
            onUpgrade={upgrade}
            onBack={() => { setSelected(undefined) }}
          />
        </motion.div>
      </AnimatePresence>
    )
  }

  return (
    <motion.div
      className="dsx-store"
      initial={{ opacity: 0, x: -24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
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

      <div className="dsx-store-filters dsx-store-categories">
        {CATEGORIES.map(entry => (
          <button
            key={entry.id}
            type="button"
            className="dsx-store-filter"
            data-active={category === entry.id}
            onClick={() => { setCategory(entry.id) }}
          >
            {entry.label}
          </button>
        ))}
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

      <AnimatePresence>
        {error !== undefined && (
          <motion.div
            className="dsx-store-error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {loading && catalog === undefined
        ? <div className="dsx-store-empty">正在获取插件目录…</div>
        : visible.length === 0
          ? <div className="dsx-store-empty">没有匹配的插件</div>
          : (
            <>
              <div className="dsx-store-list">
                {visible.slice(0, RENDER_CAP).map((plugin, index) => (
                  <motion.div
                    key={plugin.id}
                    layout
                    variants={cardVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    transition={cardTransition(index)}
                  >
                    <PluginRow
                      plugin={plugin}
                      installedVersion={installedVersions.get(plugin.id)}
                      busy={busy === plugin.id}
                      onAct={act}
                      onUpgrade={upgrade}
                      onSelect={setSelected}
                    />
                  </motion.div>
                ))}
              </div>
              <AnimatePresence>
                {visible.length > RENDER_CAP && (
                  <motion.div
                    className="dsx-store-empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    还有 {String(visible.length - RENDER_CAP)} 个未显示，用搜索缩小范围
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
    </motion.div>
  )
}

interface PluginRowProps {
  plugin: CatalogPlugin
  /** Version on disk, or undefined when the plugin is not installed. */
  installedVersion: string | undefined
  busy: boolean
  onAct: (plugin: CatalogPlugin, remove: boolean) => Promise<void>
  onUpgrade: (plugin: CatalogPlugin) => Promise<void>
  onSelect: (plugin: CatalogPlugin) => void
}

function PluginRow({ plugin, installedVersion, busy, onAct, onUpgrade, onSelect }: PluginRowProps): React.ReactElement {
  const installed = installedVersion !== undefined
  const outdated = installed && plugin.npm !== null && compareVersions(plugin.npm.version, installedVersion) > 0

  return (
    <div className="dsx-store-card" data-outdated={outdated}>
      <div
        className="dsx-store-card-body"
        role="button"
        tabIndex={0}
        onClick={() => { onSelect(plugin) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(plugin)
          }
        }}
      >
        <div className="dsx-store-title">
          <span className="dsx-store-name">{plugin.id}</span>
          <Pill>v{plugin.npm?.version ?? plugin.version}</Pill>
          {plugin.client !== null && <Pill>界面</Pill>}
          {plugin.host !== null && <Pill>后端</Pill>}
          {(() => {
            const label = categoryLabel(plugin.category)
            return label === undefined ? null : <Pill>{label}</Pill>
          })()}
          {outdated && <span className="dsx-store-update-badge" title={`已安装 v${installedVersion}，可更新到 v${plugin.npm?.version}`}>可更新</span>}
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
        {outdated ? (
          <>
            <motion.div whileHover={busy ? undefined : { scale: 1.03 }} whileTap={busy ? undefined : { scale: 0.97 }}>
              <Button variant="primary" disabled={busy} onClick={() => { void onUpgrade(plugin) }}>
                {busy ? <Spinner /> : `更新 ${installedVersion} → ${plugin.npm?.version}`}
              </Button>
            </motion.div>
            <motion.div whileHover={busy ? undefined : { scale: 1.03 }} whileTap={busy ? undefined : { scale: 0.97 }}>
              <Button variant="secondary" disabled={busy} onClick={() => { void onAct(plugin, true) }}>
                {busy ? null : '卸载'}
              </Button>
            </motion.div>
          </>
        ) : (
          <motion.div whileHover={busy ? undefined : { scale: 1.03 }} whileTap={busy ? undefined : { scale: 0.97 }}>
            <Button
              variant={installed ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => { void onAct(plugin, installed) }}
            >
              {busy ? <Spinner /> : installed ? '卸载' : '安装'}
            </Button>
          </motion.div>
        )}
      </div>
    </div>
  )
}

/** Inline busy spinner shown inside an action button while its request runs. */
function Spinner(): React.ReactElement {
  return (
    <motion.span
      aria-label="处理中"
      className="dsx-store-spinner"
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
    />
  )
}

interface PluginDetailProps {
  plugin: CatalogPlugin
  /** Version on disk, or undefined when the plugin is not installed. */
  installedVersion: string | undefined
  busy: boolean
  onAct: (plugin: CatalogPlugin, remove: boolean) => Promise<void>
  onUpgrade: (plugin: CatalogPlugin) => Promise<void>
  onBack: () => void
}

function PluginDetail({ plugin, installedVersion, busy, onAct, onUpgrade, onBack }: PluginDetailProps): React.ReactElement {
  const installed = installedVersion !== undefined
  const outdated = installed && plugin.npm !== null && compareVersions(plugin.npm.version, installedVersion) > 0
  // undefined = loading, null = no README in repo, string = content.
  const [readme, setReadme] = useState<string | null | undefined>(undefined)
  const [readmeError, setReadmeError] = useState<string | undefined>(undefined)

  useEffect(() => {
    setReadme(undefined)
    setReadmeError(undefined)
    let cancelled = false
    readReadme(plugin.repo, plugin.ref)
      .then((content) => { if (!cancelled) setReadme(content) })
      .catch((reason: unknown) => {
        if (!cancelled) setReadmeError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { cancelled = true }
  }, [plugin.repo, plugin.ref])

  return (
    <div className="dsx-store-detail">
      <div className="dsx-store-detail-header">
        <motion.button
          type="button"
          className="dsx-store-back"
          onClick={onBack}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
        >← 返回</motion.button>
        {outdated ? (
          <div className="dsx-store-actions">
            <motion.div whileHover={busy ? undefined : { scale: 1.03 }} whileTap={busy ? undefined : { scale: 0.97 }}>
              <Button variant="primary" disabled={busy} onClick={() => { void onUpgrade(plugin) }}>
                {busy ? <Spinner /> : `更新到 v${plugin.npm?.version}`}
              </Button>
            </motion.div>
            <motion.div whileHover={busy ? undefined : { scale: 1.03 }} whileTap={busy ? undefined : { scale: 0.97 }}>
              <Button variant="secondary" disabled={busy} onClick={() => { void onAct(plugin, true) }}>
                卸载
              </Button>
            </motion.div>
          </div>
        ) : (
          <motion.div whileHover={busy ? undefined : { scale: 1.03 }} whileTap={busy ? undefined : { scale: 0.97 }}>
            <Button
              variant={installed ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => { void onAct(plugin, installed) }}
            >
              {busy ? <Spinner /> : installed ? '卸载' : '安装'}
            </Button>
          </motion.div>
        )}
      </div>

      <div className="dsx-store-title">
        <span className="dsx-store-name">{plugin.id}</span>
        <Pill>v{plugin.npm?.version ?? plugin.version}</Pill>
        {installed && installedVersion !== plugin.npm?.version && (
          <Pill>已装 v{installedVersion}</Pill>
        )}
        {outdated && <span className="dsx-store-update-badge">可更新</span>}
        {plugin.client !== null && <Pill>界面</Pill>}
        {plugin.host !== null && <Pill>后端</Pill>}
        {(() => {
          const label = categoryLabel(plugin.category)
          return label === undefined ? null : <Pill>{label}</Pill>
        })()}
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

      <div className="dsx-store-detail-readme">
        {/* README panes crossfade between loading / error / content states
            instead of snapping. mode="wait" keeps the outgoing pane from
            overlapping the incoming one's layout measurement. */}
        <AnimatePresence mode="wait" initial={false}>
          {readmeError !== undefined && (
            <motion.div
              key="error"
              className="dsx-store-error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {readmeError}
            </motion.div>
          )}
          {readmeError === undefined && readme === undefined && (
            <motion.div
              key="loading"
              className="dsx-store-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              正在加载 README…
            </motion.div>
          )}
          {readmeError === undefined && readme === null && (
            <motion.div
              key="empty"
              className="dsx-store-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              该仓库没有 README
            </motion.div>
          )}
          {readmeError === undefined && readme !== null && readme !== undefined && (
            <motion.div
              key="content"
              // marked + DOMPurify output. Sanitized once at render; the
              // README is third-party content, so it never touches this DOM
              // before the XSS gate clears it.
              className="dsx-store-readme-content"
              dangerouslySetInnerHTML={{ __html: renderReadmeHtml(readme) }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
