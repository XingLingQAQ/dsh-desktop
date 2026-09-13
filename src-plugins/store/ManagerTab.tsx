/** The manager tab body: list installed plugins and toggle/uninstall/configure them. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconChevronUpOutline14,
  IconPauseOutline16,
  IconPlayOutline16,
  IconSettingsOutline14,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  readCatalog, readInstalled, readProfileBundles, readConfig, saveConfig, togglePlugin, toggleNative,
  clearNativeOverride, uninstall, adoptPlugin, updatePlugin, compareVersions,
  type CatalogPlugin, type ConfigField, type Installed, type ProfileBundle,
} from './data.ts'
import { NativeCard, findNativeConfigSpec, type NativeCardServices, type RemoteService } from './NativeConfigCards.tsx'
import { openConfirm } from './ConfirmDialog.tsx'
import { openAlert, runTask } from './TaskDialog.tsx'

/**
 * `busy` sentinel for the 「全部更新」 batch.
 *
 * The same state carries a plugin id while one row is working, so the batch needs
 * a value no plugin id can collide with — a leading slash cannot appear in an
 * npm-shaped id.
 */
const UPDATE_ALL = '/update-all'

/**
 * Build the initial value map for a config form.
 *
 * Values come from the persisted store; a missing field falls back to the
 * schema's `default`, then to the type's empty form value so the input is
 * always controlled.
 */
function initialValues(
  schema: ConfigField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const field of schema) {
    const present = Object.prototype.hasOwnProperty.call(values, field.field)
    const raw = present ? values[field.field] : field.default
    if (field.type === 'boolean') {
      next[field.field] = typeof raw === 'boolean' ? raw : false
    } else if (field.type === 'number') {
      // Number fields are edited as text inputs; store the string form so the
      // input stays controlled, and coerce back to a number on submit.
      next[field.field] = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : ''
    } else {
      next[field.field] = typeof raw === 'string' ? raw : ''
    }
  }
  return next
}

export function ManagerTab({ services }: ManagerTabProps): React.ReactElement {
  const [installed, setInstalled] = useState<Installed[]>([])
  // DSH-profile bundles (`dsh plugin add`) not yet taken over. Empty when the
  // profile has none left or the backend cannot see a DSH home — both render
  // as "no unmigrated plugins" rather than an error wall.
  const [profileBundles, setProfileBundles] = useState<ProfileBundle[]>([])
  const [profileError, setProfileError] = useState<string | undefined>(undefined)
  // Catalog entries by id, so an installed row can be compared against the
  // published version and offered an in-place update. Fetched lazily: the
  // manager works without it (no update affordance), and a network failure
  // only costs the badge, not the list.
  const [catalogById, setCatalogById] = useState<ReadonlyMap<string, CatalogPlugin>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  // The id whose config form is expanded; cleared on every list refresh.
  const [configId, setConfigId] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const list = await readInstalled()
      setInstalled(list)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Best-effort profile-bundle fetch: drives the 未迁移插件 group. A failure
  // here (no DSH home yet, profile dir unreadable) collapses the group with
  // its reason shown inline — never blocks the main list.
  useEffect(() => {
    let cancelled = false
    readProfileBundles()
      .then(list => { if (!cancelled) { setProfileBundles(list); setProfileError(undefined) } })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setProfileBundles([])
          setProfileError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => { cancelled = true }
  }, [])

  // Best-effort catalog fetch for update badges. Session-cached by readCatalog,
  // so this is usually free after the store tab has been opened once.
  useEffect(() => {
    let cancelled = false
    readCatalog(false)
      .then(catalog => {
        if (!cancelled) setCatalogById(new Map(catalog.plugins.map(p => [p.id, p])))
      })
      .catch(() => { /* no catalog → no update column; not an error surface */ })
    return () => { cancelled = true }
  }, [])

  /**
   * Run one row action, refresh, and report the outcome.
   *
   * `task` opts the action into the progress dialog — right for install-shaped
   * work that takes seconds. Quick actions (a pause toggle, a config save) stay
   * inline so a modal does not flash for something that already looks instant;
   * either way a failure gets a dialog, because the inline error line under the
   * list is easy to scroll past.
   */
  const act = useCallback(async (
    id: string,
    fn: () => Promise<unknown>,
    task?: { title: string; step: string; description?: string; progressId?: string },
  ): Promise<boolean> => {
    setBusy(id)
    setError(undefined)
    try {
      if (task !== undefined) {
        const ok = await runTask({
          ...task,
          run: async (report) => {
            await fn()
            report('正在刷新插件列表…')
            await refresh()
          },
        })
        if (!ok) setError(`${task.title}失败`)
        return ok
      }
      await fn()
      await refresh()
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      await openAlert({ title: '操作失败', detail: message })
      return false
    } finally {
      setBusy(undefined)
    }
  }, [refresh])

  const visible = useMemo(() => {
    // Builtin plugins live in the binary, not on disk — the backend's installed
    // list excludes them, but guard against a future builtin leaking through.
    const filtered = installed.filter(item => !item.id.startsWith('@dsh-desktop/'))
    const needle = query.trim().toLowerCase()
    if (needle === '') return filtered
    return filtered.filter(item =>
      `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(needle))
  }, [installed, query])

  const visibleBundles = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return profileBundles
    return profileBundles.filter(item =>
      `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(needle))
  }, [profileBundles, query])

  // Every installed plugin the catalog publishes a strictly newer npm version
  // for. Computed over the whole installed set, not the filtered view: a search
  // box narrowing the list must not silently narrow what 「全部更新」 updates.
  const outdated = useMemo(() => {
    const rows: { id: string; version: string; tarball: string }[] = []
    for (const item of installed) {
      if (item.id.startsWith('@dsh-desktop/')) continue
      const npm = catalogById.get(item.id)?.npm
      if (npm === undefined || npm === null) continue
      if (compareVersions(npm.version, item.version) <= 0) continue
      rows.push({ id: item.id, version: npm.version, tarball: npm.tarball })
    }
    return rows
  }, [installed, catalogById])

  /**
   * Update every outdated plugin, one after another, behind a single dialog.
   *
   * Sequential on purpose: each update downloads, swaps a directory and makes the
   * host recompose its tree, and running those concurrently would interleave
   * three swaps against one patch file. The batch keeps going after a failure so
   * one bad plugin cannot block the rest, and reports whatever failed at the end.
   */
  const updateAll = useCallback(async () => {
    const targets = outdated
    if (targets.length === 0) return
    const ok = await openConfirm({
      title: '全部更新',
      description: `将依次更新 ${String(targets.length)} 个插件到目录中的最新版本。`,
      confirmLabel: '开始更新',
    })
    if (!ok) return
    setBusy(UPDATE_ALL)
    setError(undefined)
    const failures: string[] = []
    await runTask({
      title: '全部更新',
      description: `共 ${String(targets.length)} 个插件`,
      step: '正在准备…',
      run: async (report) => {
        for (const [index, item] of targets.entries()) {
          const counter = `(${String(index + 1)}/${String(targets.length)}) ${item.id} → ${item.version}`
          report('正在准备下载…', item.id, counter)
          try {
            await updatePlugin(item.id, item.tarball)
          } catch (reason) {
            failures.push(`${item.id}: ${reason instanceof Error ? reason.message : String(reason)}`)
          }
        }
        report('正在刷新插件列表…', undefined, `共 ${String(targets.length)} 个插件`)
        await refresh()
        // Surfaced through the dialog's own error state rather than a second
        // popup, so the user sees which plugins failed without a dialog chain.
        if (failures.length > 0) {
          throw new Error(`${String(failures.length)} 个插件未更新：\n${failures.join('\n')}`)
        }
      },
    })
    if (failures.length > 0) setError(`${String(failures.length)} 个插件更新失败`)
    setBusy(undefined)
  }, [outdated, refresh])

  // Adopt one profile bundle: confirm (the default removes the profile
  // dependency), run the backend takeover, then refresh both lists — the row
  // leaves the group and the plugin joins the main list as 来源 dsh. The
  // watched profile patch is rewritten synchronously inside adopt, so the
  // host half mounts live via watchUserPatches — no restart needed.
  const handleAdopt = useCallback(async (id: string) => {
    const ok = await openConfirm({
      title: '接管迁移',
      description:
        `将「${id}」的插件文件复制到桌面插件目录，并从 DSH profile 中移除该依赖。` +
        '之后此插件由桌面端统一管理，dsh 命令不再管理它。',
      confirmLabel: '接管',
    })
    if (!ok) return
    setBusy(id)
    setError(undefined)
    // Takeover copies a package tree and then runs `dsh plugin remove`, which is
    // easily a few seconds — the progress dialog keeps the wait explicit and
    // carries the failure message if either half goes wrong.
    const done = await runTask({
      title: '接管迁移',
      description: id,
      step: '正在复制插件文件…',
      run: async (report) => {
        await adoptPlugin(id)
        report('正在刷新插件列表…')
        await refresh()
        report('正在刷新未迁移列表…')
        const list = await readProfileBundles()
        setProfileBundles(list)
        setProfileError(undefined)
      },
    })
    if (!done) setError('接管失败')
    setBusy(undefined)
  }, [refresh])

  return (
    <div className="dsx-mgr">
      <div className="dsx-mgr-bar">
        <div className="dsx-mgr-search">
          <Input
            value={query}
            placeholder="搜索插件名、ID 或描述"
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>
        <Button
          variant="outline"
          disabled={loading || busy !== undefined}
          onClick={() => { void refresh() }}
        >
          {loading ? '刷新中…' : '刷新'}
        </Button>
        {outdated.length > 0 && (
          <Button
            variant="primary"
            disabled={busy !== undefined}
            onClick={() => { void updateAll() }}
          >
            {busy === UPDATE_ALL ? '更新中…' : `全部更新 (${String(outdated.length)})`}
          </Button>
        )}
      </div>

      <div className="dsx-mgr-meta">
        <span>共 {String(visible.length)} 个已安装</span>
      </div>

      {error !== undefined && <div className="dsx-mgr-error">{error}</div>}

      <NativePluginGroup services={services} />

      {(visibleBundles.length > 0 || profileError !== undefined) && (
        <ProfileBundleGroup
          bundles={visibleBundles}
          error={profileError}
          busy={busy}
          onAdopt={(id) => { void handleAdopt(id) }}
        />
      )}

      {loading && installed.length === 0
        ? <div className="dsx-mgr-empty">正在读取已安装插件…</div>
        : visible.length === 0
          ? <div className="dsx-mgr-empty">没有已安装的插件</div>
          : (
            <div className="dsx-mgr-list">
              {visible.map((item, index) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.22, delay: Math.min(index * 0.03, 0.3) }}
                >
                  <ManagerRow
                    plugin={item}
                    catalogEntry={catalogById.get(item.id)}
                    busy={busy === item.id}
                    expanded={configId === item.id}
                    onToggle={async () => {
                      await act(item.id, () => togglePlugin(item.id, !item.disabled))
                    }}
                    onUninstall={async () => {
                      const ok = await openConfirm({
                        title: '卸载插件',
                        description: `将「${item.name}」从桌面插件目录中移除。此操作不可撤销。`,
                        confirmLabel: '卸载',
                      })
                      if (!ok) return
                      await act(item.id, () => uninstall(item.id), {
                        title: '卸载插件',
                        description: item.name,
                        step: '正在移除插件文件…',
                      })
                    }}
                    onUpgrade={async (entry) => {
                      if (entry.npm === null) return
                      const tarball = entry.npm.tarball
                      await act(item.id, () => updatePlugin(item.id, tarball), {
                        title: '更新插件',
                        description: `${item.id} → ${entry.npm.version}`,
                        step: '正在准备下载…',
                        progressId: item.id,
                      })
                    }}
                    onConfigToggle={() => {
                      setConfigId(prev => prev === item.id ? undefined : item.id)
                    }}
                    onConfigSave={async (values) => {
                      await act(item.id, () => saveConfig(item.id, values))
                      setConfigId(undefined)
                    }}
                  />
                </motion.div>
              ))}
            </div>
          )}
    </div>
  )
}

// --- Native plugin group -------------------------------------------------

interface PluginInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}

interface PluginInventorySnapshotResult {
  ok: boolean
  value?: { entries: readonly PluginInventoryEntry[] }
  error?: { code: string; message: string }
}

interface PluginInventoryRemote {
  list(): Promise<PluginInventorySnapshotResult>
}

export interface ManagerTabServices extends NativeCardServices {
  remote: RemoteService & { pluginInventory: PluginInventoryRemote }
}

interface ManagerTabProps {
  services: ManagerTabServices
}

interface NativePluginGroupProps {
  services: ManagerTabServices
}

/**
 * Compact a module specifier without guessing whether its Loader id was
 * generated. Mirrors ui-settings-plugin-inventory's moduleShortName.
 */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Localized phase label for one root Fiber phase. */
function phaseLabel(phase: PluginInventoryEntry['fiberPhase']): string {
  switch (phase) {
    case 'pending': return '待启动'
    case 'loading': return '加载中'
    case 'active': return '运行中'
    case 'failed': return '失败'
    case 'unloading': return '卸载中'
    default: return '未观测'
  }
}

function NativePluginGroup({ services }: NativePluginGroupProps): React.ReactElement {
  // The group is self-contained: it owns its open state, the inventory
  // snapshot, and the per-row busy id while a toggle is in flight. The
  // parent only hands in the remote services.
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<PluginInventoryEntry[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  // Single-expand config drawer within the native list: only one row's config
  // card is open at a time, mirroring the desktop plugin rows' configId model.
  const [configEntryId, setConfigEntryId] = useState<string | undefined>(undefined)
  const contentId = 'dsx-mgr-native-content'

  // Lazily fetch the inventory when the group is first expanded; never
  // triggers while collapsed so a deployment without the remote pays nothing.
  useEffect(() => {
    if (!open || loaded) return
    let cancelled = false
    services.remote.pluginInventory.list()
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setEntries([...result.value.entries])
          setLoaded(true)
        } else {
          setError(`插件清单加载失败（${result.error.code}）`)
          setLoaded(true)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setLoaded(true)
        }
      })
    return () => { cancelled = true }
  }, [open, loaded, services.remote])

  const refresh = useCallback(async (): Promise<void> => {
    const result = await services.remote.pluginInventory.list()
    if (result.ok) setEntries([...result.value.entries])
  }, [services.remote])

  /**
   * The entries that are genuinely DSH's own.
   *
   * The inventory lists every row in the live Loader tree, which includes the
   * rows the desktop itself wrote into the profile patch — so `whale-girl` and
   * friends were showing up here as 「原生插件」 alongside their real row in the
   * list above, and toggling them here fought the desktop's own paused set.
   *
   * The tell is the module specifier: DSH's bundle layers always mount by bare
   * package name (`dsh-web-ui`, `@deepseek-ai/…`, `cordis:include`), while every
   * row the desktop emits is rewritten to an absolute `file:///` path into its
   * own plugins directory. A plugin installed through the `dsh` CLI and not yet
   * taken over still mounts by bare name, so it correctly stays in this group.
   */
  const nativeEntries = useMemo(
    () => entries.filter(entry => !entry.moduleName.startsWith('file://')),
    [entries],
  )

  /**
   * The root include entry — the one whose config tree our patch layer feeds.
   * Derived rather than hardcoded: it is the `cordis:include` entry that is not
   * itself nested under another one.
   */
  const rootIncludeId = useMemo(
    () => entries.find(e => e.moduleName === 'cordis:include' && !e.entryId.includes(':'))?.entryId,
    [entries],
  )

  /**
   * Translate a Loader runtime id into the id a patch row can target.
   *
   * The inventory reports `Entry.id`, which is a TREE PATH: each owning tree
   * prepends its own entry id and a `:` separator. A patch row, though, matches
   * on the AUTHORED id — the `id:` written in a config file — and only within
   * the one tree our patch layer is applied to, the root include's. So exactly
   * one prefix is stripped, and anything deeper is refused: an entry inside a
   * nested include lives in a different file, and a row aimed at it matches
   * nothing, is warned about by the Loader, and silently does nothing. That
   * silent no-op is what made the toggle button spin until it timed out.
   *
   * @returns the authored id, or undefined when our layer cannot reach it.
   */
  const authoredIdOf = useCallback((entryId: string): string | undefined => {
    if (rootIncludeId === undefined) return undefined
    const prefix = `${rootIncludeId}:`
    if (!entryId.startsWith(prefix)) return undefined
    const authored = entryId.slice(prefix.length)
    return authored.length > 0 && !authored.includes(':') ? authored : undefined
  }, [rootIncludeId])

  /**
   * Why an enable could not have worked, decided from the snapshot alone.
   *
   * A cordis service name is exclusive — `reflect.ts` throws
   * `service "<name>" has been registered at <fiber>` when a second instance
   * claims one that is taken. The Loader then writes `disabled: true` back over
   * the entry, so the only thing a caller sees is the flag flipping back. Two
   * rows carrying the SAME module specifier are therefore mutually exclusive
   * whenever that module registers a service, which is the common case and the
   * one behind `include:hmr`: the desktop injects its own hmr instance, so the
   * profile's own hmr row can never start.
   *
   * Reported as a reason rather than used to pre-disable the button: a module
   * that registers nothing can legitimately run twice, and refusing the click
   * up front would be wrong for those.
   */
  const conflictWith = useCallback((entry: PluginInventoryEntry): string | undefined => {
    // A rival holds the service from the moment it starts loading, so anything
    // enabled and not already failed counts. `enabled` is the Loader's effective
    // flag, so a rival under a disabled ancestor is correctly not one.
    const rival = entries.find(other =>
      other.entryId !== entry.entryId
      && other.moduleName === entry.moduleName
      && other.enabled
      && other.fiberPhase !== 'failed')
    return rival === undefined ? undefined : moduleShortName(rival.moduleName)
  }, [entries])

  // Toggle a native entry's enabled state by writing a `disabled` override into
  // the HMR-watched profile patch, then poll the inventory until the live Loader
  // reflects it.
  //
  // How a failed enable is recognised, measured against the live host rather
  // than assumed: a refusal shows up as the profile and the Loader DISAGREEING.
  // The override reaches the patch file, but the inventory keeps reporting
  // `enabled: false` with no fiber phase, because cordis threw while creating
  // the fiber and the Loader dropped the entry again. Nothing is ever written
  // back into the file, and the phase never becomes `failed` — there is no fiber
  // left to carry that state. So the only durable signal is `enabled` staying
  // false once the watcher has had time to act.
  //
  // GRACE is what separates "the watcher has not caught up" from "the Loader
  // said no", and it is sized from the success path: an enable that works is
  // already `active` at the first 300ms poll, so five polls is a wide margin.
  // `failed` and `pending` are still read — they are what a plugin that starts
  // and THEN dies, or parks on a missing service, reports. A pause reads
  // `enabled` alone, since its fiber is torn down and has no phase to report.
  const handleToggle = useCallback(async (entry: PluginInventoryEntry): Promise<void> => {
    const targetDisabled = entry.enabled
    const authored = authoredIdOf(entry.entryId)
    if (authored === undefined) {
      setError(`「${entry.entryId}」由配置文件管理，无法在此处开关`)
      return
    }
    setBusyId(entry.entryId)
    setError(undefined)
    try {
      await toggleNative(authored, targetDisabled)
      const STEP = 300
      const GRACE = 5
      const ROUNDS = 24
      let lastPhase: PluginInventoryEntry['fiberPhase'] = null
      let settled = false
      for (let i = 0; i < ROUNDS && !settled; i++) {
        await new Promise(resolve => setTimeout(resolve, STEP))
        const result = await services.remote.pluginInventory.list()
        if (!result.ok) continue
        const fresh = result.value.entries.find(e => e.entryId === entry.entryId)
        if (!fresh) continue
        if (targetDisabled) {
          // Paused: the fiber is torn down, so the configured flag is the signal.
          if (!fresh.enabled) {
            setEntries([...result.value.entries])
            return
          }
          continue
        }
        lastPhase = fresh.fiberPhase
        if (fresh.fiberPhase === 'active') {
          setEntries([...result.value.entries])
          return
        }
        // Refused: the override is in the file, but past the grace window the
        // Loader is still reporting the entry off. `failed` covers a fiber that
        // started and then threw. Both are terminal — stop rather than spend the
        // remaining rounds re-asking a question already answered.
        if (fresh.fiberPhase === 'failed' || (i >= GRACE && !fresh.enabled)) settled = true
      }
      // A failed enable is rolled back. The override we just wrote is what makes
      // the host try to mount the plugin, and it persists in the profile: left
      // behind, every boot from here on would retry a plugin that has already
      // shown it cannot start. A failed pause is NOT rolled back — that override
      // still expresses what the user asked for, and the host may simply be slow
      // to let go.
      if (!targetDisabled) await clearNativeOverride(authored).catch(() => undefined)
      await refresh()
      if (targetDisabled) {
        setError(`「${entry.entryId}」停用失败，插件仍在运行`)
        return
      }
      const rival = conflictWith(entry)
      if (rival !== undefined) {
        setError(`「${entry.entryId}」无法启用：${rival} 已由其他条目提供，不能重复启用`)
      } else if (lastPhase === 'pending') {
        setError(`「${entry.entryId}」无法启用：它依赖的服务未启用`)
      } else {
        setError(`「${entry.entryId}」启用失败，插件未能启动`)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refresh()
    } finally {
      setBusyId(undefined)
    }
  }, [services.remote, refresh, authoredIdOf, conflictWith])

  return (
    <div className="dsx-mgr-native" data-open={open}>
      <motion.button
        type="button"
        className="dsx-mgr-native-head"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => { setOpen(v => !v) }}
        whileTap={{ scale: 0.995 }}
      >
        <motion.span
          className="dsx-mgr-native-chevron"
          aria-hidden="true"
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >▸</motion.span>
        <span className="dsx-mgr-native-title">原生插件</span>
        <span className="dsx-mgr-native-count">
          {!loaded ? '…' : String(nativeEntries.length)}
        </span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={contentId}
            className="dsx-mgr-native-body"
            key="native-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            {error !== undefined && <div className="dsx-mgr-error">{error}</div>}
            {error === undefined && !loaded
              ? <div className="dsx-mgr-empty">正在读取原生插件清单…</div>
              : nativeEntries.length === 0
                ? <div className="dsx-mgr-empty">没有原生插件</div>
                : (
                  <ul className="dsx-mgr-native-list">
                    {nativeEntries.map(entry => {
                      const short = moduleShortName(entry.moduleName)
                      const phase = phaseLabel(entry.fiberPhase)
                      const spec = findNativeConfigSpec(entry.moduleName)
                      const expanded = configEntryId === entry.entryId
                      const busy = busyId === entry.entryId
                      // Only rows our patch layer can actually target are
                      // toggleable; the rest would write a row that matches
                      // nothing. Say so on the button instead of accepting a
                      // click that cannot work.
                      const toggleable = authoredIdOf(entry.entryId) !== undefined
                      return (
                        <li key={entry.entryId} className="dsx-mgr-native-row" data-enabled={entry.enabled} data-configurable={spec !== undefined}>
                          <span
                            className="dsx-mgr-native-dot"
                            data-phase={entry.enabled ? (entry.fiberPhase ?? 'unobserved') : 'disabled'}
                            role="img"
                            aria-label={phase}
                            title={phase}
                          />
                          <div className="dsx-mgr-native-name">
                            <span className="dsx-mgr-native-short" title={entry.moduleName}>{short}</span>
                            <span className="dsx-mgr-native-id">{entry.entryId}</span>
                          </div>
                          <div className="dsx-mgr-native-trailing">
                            {spec !== undefined && (
                              <button
                                type="button"
                                className="dsx-mgr-icon-btn"
                                aria-label={expanded ? '收起配置' : '展开配置'}
                                title={expanded ? '收起' : '配置'}
                                disabled={busy}
                                onClick={() => {
                                  setConfigEntryId(prev => prev === entry.entryId ? undefined : entry.entryId)
                                }}
                              >
                                {expanded ? <IconChevronUpOutline14 size={14} /> : <IconSettingsOutline14 size={14} />}
                              </button>
                            )}
                            <button
                              type="button"
                              className="dsx-mgr-icon-btn"
                              aria-label={entry.enabled ? '暂停' : '恢复'}
                              title={toggleable
                                ? (entry.enabled ? '暂停' : '恢复')
                                : '由配置文件管理，无法在此处开关'}
                              disabled={busy || !toggleable}
                              onClick={() => { void handleToggle(entry) }}
                            >
                              {entry.enabled ? <IconPauseOutline16 size={14} /> : <IconPlayOutline16 size={14} />}
                            </button>
                            <span
                              className="dsx-mgr-native-status"
                              data-enabled={entry.enabled}
                              role="img"
                              aria-label={entry.enabled ? '已启用' : '已停用'}
                              title={entry.enabled ? '已启用' : '已停用'}
                            />
                          </div>
                          <AnimatePresence initial={false}>
                            {spec !== undefined && expanded && (
                              <motion.div
                                className="dsx-mgr-native-config"
                                key="config"
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2, ease: 'easeOut' }}
                                style={{ overflow: 'hidden' }}
                              >
                                <NativeCard
                                  namespace={spec.namespace}
                                  title={spec.title}
                                  description={spec.description}
                                  fields={spec.fields}
                                  services={services}
                                  secretRef={spec.secretRef}
                                />
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </li>
                      )
                    })}
                  </ul>
                )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// --- Unmigrated profile-bundle group ---------------------------------------

interface ProfileBundleGroupProps {
  bundles: ProfileBundle[]
  error: string | undefined
  busy: string | undefined
  onAdopt: (id: string) => void
}

/**
 * The 「未迁移插件」 collapsible group: DSH-profile bundles still managed by
 * the `dsh` CLI. Each row is read-only except for the 接管 button, which
 * migrates the plugin into the desktop's own directory (and, by default,
 * removes the profile dependency). Mirrors the 原生插件 group's chrome.
 */
function ProfileBundleGroup({ bundles, error, busy, onAdopt }: ProfileBundleGroupProps): React.ReactElement {
  const [open, setOpen] = useState(true)
  const contentId = 'dsx-mgr-external-content'

  return (
    <div className="dsx-mgr-native" data-open={open}>
      <motion.button
        type="button"
        className="dsx-mgr-native-head"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => { setOpen(v => !v) }}
        whileTap={{ scale: 0.995 }}
      >
        <motion.span
          className="dsx-mgr-native-chevron"
          aria-hidden="true"
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >▸</motion.span>
        <span className="dsx-mgr-native-title">未迁移插件</span>
        <span className="dsx-mgr-native-count">{String(bundles.length)}</span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={contentId}
            className="dsx-mgr-native-body"
            key="external-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            {error !== undefined && <div className="dsx-mgr-error">{error}</div>}
            {error === undefined && bundles.length === 0
              ? <div className="dsx-mgr-empty">没有未迁移的插件</div>
              : (
                <ul className="dsx-mgr-native-list">
                  {bundles.map(entry => (
                    <li key={entry.id} className="dsx-mgr-native-row">
                      <span className="dsx-mgr-native-dot" data-phase={entry.has_client ? 'active' : 'unobserved'} />
                      <div className="dsx-mgr-native-name">
                        <span className="dsx-mgr-native-short" title={entry.id}>{entry.name}</span>
                        <span className="dsx-mgr-native-id">
                          {entry.id} · v{entry.version}{entry.description !== '' ? ` · ${entry.description}` : ''}
                        </span>
                      </div>
                      <div className="dsx-mgr-native-trailing">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy === entry.id}
                          onClick={() => { onAdopt(entry.id) }}
                        >
                          {busy === entry.id ? '接管中…' : '接管迁移'}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

interface ManagerRowProps {
  plugin: Installed
  /** Matching catalog entry, when the plugin is known to the registry. */
  catalogEntry: CatalogPlugin | undefined
  busy: boolean
  expanded: boolean
  onToggle: () => Promise<void>
  onUninstall: () => Promise<void>
  onUpgrade: (entry: CatalogPlugin) => Promise<void>
  onConfigToggle: () => void
  onConfigSave: (values: Record<string, unknown>) => Promise<void>
}

function ManagerRow({
  plugin, catalogEntry, busy, expanded, onToggle, onUninstall, onUpgrade, onConfigToggle, onConfigSave,
}: ManagerRowProps): React.ReactElement {
  const hasConfig = plugin.configSchema.length > 0
  // Update affordance only when the catalog publishes a strictly newer npm
  // version than what sits on disk. A missing catalog entry (unlisted plugin,
  // offline fetch) simply means no badge — the row keeps working.
  const npm = catalogEntry?.npm ?? null
  const outdated = npm !== null && compareVersions(npm.version, plugin.version) > 0

  return (
    <div className="dsx-mgr-row" data-disabled={plugin.disabled} data-outdated={outdated}>
      <div className="dsx-mgr-row-body">
        <div className="dsx-mgr-title">
          <span className="dsx-mgr-name">{plugin.name}</span>
          <Pill>v{plugin.version}</Pill>
          {plugin.fromProfile && <Pill>来源 dsh</Pill>}
          {plugin.has_client && <Pill>界面</Pill>}
          {plugin.has_server && <Pill>后端</Pill>}
          {plugin.disabled && <Pill>已暂停</Pill>}
          {outdated && (
            <span
              className="dsx-store-update-badge"
              title={`目录中有 v${npm?.version}`}
            >可更新到 v{npm?.version}</span>
          )}
        </div>
        {plugin.description !== '' && <div className="dsx-mgr-desc">{plugin.description}</div>}
        <div className="dsx-mgr-meta">{plugin.id}</div>
      </div>
      <div className="dsx-mgr-actions">
        {outdated && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void onUpgrade(catalogEntry!) }}>
            {busy ? '更新中…' : '更新'}
          </Button>
        )}
        <motion.button
          type="button"
          className="dsx-mgr-icon-btn"
          aria-label={plugin.disabled ? '恢复' : '暂停'}
          title={busy ? '处理中…' : plugin.disabled ? '恢复' : '暂停'}
          disabled={busy}
          onClick={() => { void onToggle() }}
          whileHover={busy ? undefined : { scale: 1.12 }}
          whileTap={busy ? undefined : { scale: 0.9 }}
        >
          {plugin.disabled ? <IconPlayOutline16 size={14} /> : <IconPauseOutline16 size={14} />}
        </motion.button>
        <motion.button
          type="button"
          className="dsx-mgr-icon-btn dsx-mgr-icon-btn--danger"
          aria-label="卸载"
          title="卸载"
          disabled={busy}
          onClick={() => { void onUninstall() }}
          whileHover={busy ? undefined : { scale: 1.12 }}
          whileTap={busy ? undefined : { scale: 0.9 }}
        >
          <IconTrashOutline16 size={14} />
        </motion.button>
        {hasConfig && (
          <motion.button
            type="button"
            className="dsx-mgr-icon-btn"
            aria-label={expanded ? '收起配置' : '展开配置'}
            title={expanded ? '收起' : '配置'}
            disabled={busy}
            onClick={onConfigToggle}
            whileHover={busy ? undefined : { scale: 1.12 }}
            whileTap={busy ? undefined : { scale: 0.9 }}
          >
            <motion.span
              style={{ display: 'inline-flex' }}
              animate={{ rotate: expanded ? -180 : 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <IconSettingsOutline14 size={14} />
            </motion.span>
          </motion.button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && hasConfig && (
          <motion.div
            key="config-form"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            style={{ overflow: 'hidden', flexBasis: '100%' }}
          >
            <ConfigForm
              pluginId={plugin.id}
              schema={plugin.configSchema}
              onCancel={onConfigToggle}
              onSave={onConfigSave}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

interface ConfigFormProps {
  pluginId: string
  schema: ConfigField[]
  onCancel: () => void
  onSave: (values: Record<string, unknown>) => Promise<void>
}

function ConfigForm({ pluginId, schema, onCancel, onSave }: ConfigFormProps): React.ReactElement {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Load persisted values on mount; the schema comes from the row so it's
  // already in hand, but the values need a round-trip to the bridge.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    readConfig(pluginId)
      .then((result) => {
        if (cancelled) return
        setValues(initialValues(result.schema, result.values))
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [pluginId])

  // Number fields keep the raw input string while editing; coerce on save.
  const update = (field: string, value: unknown): void => {
    setValues(prev => ({ ...prev, [field]: value }))
  }

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      // Coerce number fields from their string form; other types pass through.
      const out: Record<string, unknown> = { ...values }
      for (const field of schema) {
        if (field.type === 'number') {
          const raw = out[field.field]
          const num = typeof raw === 'number' ? raw : Number(raw)
          // Empty/non-finite input falls back to a numeric default, else empty
          // string — the backend decides whether the field is required.
          out[field.field] = Number.isFinite(num)
            ? num
            : typeof field.default === 'number' ? field.default : ''
        }
      }
      await onSave(out)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dsx-mgr-config">
      <div className="dsx-mgr-config-title">插件配置</div>
      {loading
        ? <div className="dsx-mgr-empty">正在加载配置…</div>
        : schema.map(field => (
          <div key={field.field} className="dsx-mgr-field">
            <label className="dsx-mgr-field-label">{field.label}</label>
            {field.hint !== undefined && field.hint !== '' && (
              <div className="dsx-mgr-field-hint">{field.hint}</div>
            )}
            {field.type === 'boolean'
              ? (
                <label className="dsx-mgr-bool">
                  <input
                    type="checkbox"
                    checked={values[field.field] === true}
                    onChange={(event) => { update(field.field, event.target.checked) }}
                  />
                  <span className="dsx-mgr-field-hint">启用</span>
                </label>
              )
              : field.type === 'select'
                ? (
                  <select
                    className="dsx-mgr-field-control dsx-mgr-select"
                    value={typeof values[field.field] === 'string' ? values[field.field] as string : ''}
                    onChange={(event) => { update(field.field, event.target.value) }}
                  >
                    {(field.options ?? []).map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                )
                : (
                  <Input
                    className="dsx-mgr-field-input"
                    type={field.type === 'secret' ? 'password' : 'text'}
                    inputMode={field.type === 'number' ? 'numeric' : undefined}
                    value={typeof values[field.field] === 'string' ? values[field.field] as string : ''}
                    onChange={(event) => { update(field.field, event.target.value) }}
                  />
                )}
          </div>
        ))}
      {error !== undefined && <div className="dsx-mgr-error">{error}</div>}
      <div className="dsx-mgr-config-actions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={() => { void submit() }} disabled={loading || saving}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
