/**
 * Catalog and bridge access for the plugin store.
 *
 * The catalog is a static file in a public registry repository, refreshed there
 * by CI: the `dsh-plugin` topic is squatted heavily enough that raw search
 * results are unusable, and confirming every candidate against its manifest is
 * work no client should repeat on startup. This module fetches that one file and
 * trusts the confirmation already done.
 *
 * Installing needs a filesystem, which the page does not have, so writes go to
 * the desktop bridge. Its URL — token included — is substituted into the bundle
 * when the bridge serves it.
 */

const CATALOG_URL =
  'https://raw.githubusercontent.com/XingLingQAQ/dsh-plugin-registry/main/catalog.json'

/** Substituted by the bridge when it serves this bundle. */
const API_BASE = '__BRIDGE_API__'

const CACHE_KEY = 'dsh-desktop:store:catalog'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export interface CatalogPlugin {
  id: string
  repo: string
  ref: string
  version: string
  description: string
  stars: number
  updatedAt: string | null
  license: string | null
  homepage: string | null
  topics: string[]
  category: string
  client: { platform: string; immediately: boolean; inject: string[]; entry: string } | null
  host: { entry: string | null; patch: string | null } | null
  tarball: string
  /** The published package. Null when the plugin was never released to npm. */
  npm: { version: string; tarball: string } | null
  /** True when `npm` is set, i.e. installable without running a build. */
  installable: boolean
}

/** Content-category filter chips, in display order. The crawler derives
 *  `category` deterministically; this list must stay in lockstep with
 *  CATEGORY_IDS in the registry's scripts/classify.mjs. `all` is a front-end
 *  sentinel (show every plugin) and is never produced by the crawler. */
export const CATEGORIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'all', label: '全部分类' },
  { id: 'safety', label: '安全防护' },
  { id: 'manager', label: '插件与配置管理' },
  { id: 'integration', label: 'IM与通知' },
  { id: 'provider', label: '账号与供给' },
  { id: 'ui-theme', label: '主题皮肤' },
  { id: 'ui-enhancement', label: '界面增强' },
  { id: 'tool', label: '工具能力' },
  { id: 'automation', label: '自动化流程' },
  { id: 'session', label: '会话管理' },
  { id: 'agent-skill', label: '智能体技能' },
  { id: 'other', label: '其他' },
]

/** Chinese label for a category id, or `undefined` when unknown/missing. */
export function categoryLabel(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  return CATEGORIES.find(entry => entry.id === id)?.label
}

export interface Catalog {
  schemaVersion: number
  generatedAt: string
  source: { topic: string; scanned: number; accepted: number; installable: number }
  plugins: CatalogPlugin[]
}

export interface ConfigField {
  field: string
  label: string
  type: 'text' | 'number' | 'secret' | 'boolean' | 'select'
  hint?: string
  default?: string | number | boolean
  options?: string[]
}

export interface Installed {
  id: string
  name: string
  version: string
  description: string
  has_client: boolean
  has_server: boolean
  disabled: boolean
  /** True when this plugin was migrated out of the DSH profile. */
  fromProfile?: boolean
  configSchema: ConfigField[]
}

/** A DSH-profile bundle (`dsh plugin add`) the desktop has not taken over yet. */
export interface ProfileBundle {
  id: string
  name: string
  version: string
  description: string
  has_client: boolean
}

export { CATALOG_URL }

/**
 * Read the catalog, preferring a recent session-cached copy.
 * @param force - skip the cache and revalidate against the network.
 */
export async function readCatalog(force: boolean): Promise<Catalog> {
  if (!force) {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (raw !== null) {
      try {
        const cached = JSON.parse(raw) as { at: number; catalog: Catalog }
        if (Date.now() - cached.at < CACHE_TTL_MS) return cached.catalog
      } catch {
        // A corrupt cache entry is not worth reporting; fall through and refetch.
      }
    }
  }
  const res = await fetch(CATALOG_URL, { cache: force ? 'reload' : 'default' })
  if (!res.ok) throw new Error(`目录获取失败：HTTP ${String(res.status)}`)
  const catalog = (await res.json()) as Catalog
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), catalog }))
  } catch {
    // Storage quota is not a reason to fail the render.
  }
  return catalog
}

/** What is currently on disk under the desktop plugins directory. */
export async function readInstalled(): Promise<Installed[]> {
  const res = await fetch(`${API_BASE}/plugins/installed`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`已安装列表获取失败：HTTP ${String(res.status)}`)
  return (await res.json()) as Installed[]
}

/**
 * DSH-profile bundles (`dsh plugin add`) still managed by the dsh CLI — the
 * 「未迁移插件」 group's rows. Fails loud: the caller decides whether a
 * missing profile directory is worth surfacing.
 */
export async function readProfileBundles(): Promise<ProfileBundle[]> {
  const res = await fetch(`${API_BASE}/plugins/external`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`profile 插件列表获取失败：HTTP ${String(res.status)}`)
  const body = (await res.json()) as ProfileBundle[] | { ok: false; error: string }
  if (!Array.isArray(body)) throw new Error((body as { error: string }).error)
  return body
}

/** Take over one DSH-profile bundle: copy it into the desktop, remove the profile dependency. */
export async function adoptPlugin(id: string): Promise<void> {
  await post('/plugins/adopt', { id })
}

/**
 * Fetch a plugin's repository README from GitHub raw.
 *
 * raw.githubusercontent.com is case-sensitive on the path, so `README.md` is
 * tried first and `readme.md` is the only fallback — READMEs rarely live under
 * more exotic spellings, and a 404 on both means the repo simply has none.
 * Cached per repo+ref for the session; a README does not move under a fixed ref.
 */
export async function readReadme(repo: string, ref: string): Promise<string | null> {
  const cacheKey = `dsh-desktop:store:readme:${repo}:${ref}`
  try {
    const cached = sessionStorage.getItem(cacheKey)
    if (cached !== null) return cached
  } catch {
    // Storage access may throw in private mode; fall through to the network.
  }

  for (const path of ['README.md', 'readme.md']) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`, {
      cache: 'no-store',
    })
    if (res.ok) {
      const text = await res.text()
      try {
        sessionStorage.setItem(cacheKey, text)
      } catch {
        // Cache is best-effort; the fetched text is still usable.
      }
      return text
    }
    if (res.status !== 404) {
      throw new Error(`README 获取失败：HTTP ${String(res.status)}`)
    }
    // 404 → try the next casing, or fall through to null when both miss.
  }
  return null
}

/** Progress of an in-flight install or update, as the bridge sees it. */
export interface TaskProgress {
  running: boolean
  /** `download` | `extract` | `install`. */
  phase?: string
  received?: number
  /** 0 when the archive host sent no content-length — keep the bar indeterminate. */
  total?: number
}

/**
 * Read how far the install/update of `id` has got.
 *
 * The install POST only answers at the end, so the dialog polls this alongside
 * it. A failed read is reported as "not running" rather than thrown: losing a
 * progress tick must never turn into a failed install.
 */
export async function readProgress(id: string): Promise<TaskProgress> {
  try {
    const res = await fetch(`${API_BASE}/plugins/progress?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
    })
    if (!res.ok) return { running: false }
    return (await res.json()) as TaskProgress
  } catch {
    return { running: false }
  }
}

/** Ask the bridge to overwrite an installed plugin with a newer tarball. */
export async function updatePlugin(id: string, tarball: string): Promise<void> {
  await post('/plugins/update', { id, tarball })
}

/**
 * Ask the bridge to install one catalog entry.
 *
 * Always the npm tarball: a plugin's declared client entry is usually a build
 * output that is published but not committed, so the GitHub source archive would
 * land a package whose entry file is missing.
 */
export async function install(plugin: CatalogPlugin): Promise<void> {
  if (plugin.npm === null) throw new Error('该插件未发布到 npm，无法直接安装')
  await post('/plugins/install', { id: plugin.id, tarball: plugin.npm.tarball })
}

/** Ask the bridge to remove one installed plugin. */
export async function uninstall(id: string): Promise<void> {
  await post('/plugins/uninstall', { id })
}

/** Ask the bridge to flip a plugin's disabled flag (it re-scans internally). */
export async function togglePlugin(
  id: string,
  disabled: boolean,
): Promise<{ ok: boolean; disabled: boolean }> {
  const res = await fetch(`${API_BASE}/plugins/toggle`, {
    method: 'POST',
    // text/plain keeps this a simple request — no preflight against the bridge.
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ id, disabled }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    disabled?: boolean
    error?: string
  }
  if (body.ok !== true) throw new Error(body.error ?? `操作失败：HTTP ${String(res.status)}`)
  return { ok: true, disabled: body.disabled ?? disabled }
}

/**
 * Toggle a NATIVE (DSH Loader) entry's enabled state by writing a `disabled`
 * override into the HMR-watched profile patch. The Loader recomposes within
 * seconds; the caller polls `pluginInventory.list()` to confirm the flip.
 *
 * `entryId` must be the AUTHORED id from the config file, not the runtime tree
 * path the inventory reports — a patch row matches on the former only.
 *
 * Both directions write an explicit value. Resuming cannot simply drop the
 * override: patch layers merge by assignment, so with no row of ours the layer
 * that disabled the entry in the first place just applies again. Pass `clear`
 * to drop the override deliberately (see [`clearNativeOverride`]).
 */
export async function toggleNative(
  entryId: string,
  disabled: boolean,
  clear = false,
): Promise<{ ok: boolean; disabled: boolean }> {
  const res = await fetch(`${API_BASE}/native/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ entryId, disabled, clear }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    disabled?: boolean
    error?: string
  }
  if (body.ok !== true) throw new Error(body.error ?? `操作失败：HTTP ${String(res.status)}`)
  return { ok: true, disabled: body.disabled ?? disabled }
}

/**
 * Remove the desktop's `disabled` override for a native entry, returning it to
 * whatever the layers below decide. Used to roll back an enable that did not
 * take: the override is what makes the host attempt the mount, so leaving it
 * behind would retry a plugin that already failed to start on every later boot.
 */
export async function clearNativeOverride(entryId: string): Promise<void> {
  await toggleNative(entryId, false, true)
}

/** Read a plugin's declared config schema and the currently persisted values. */
export async function readConfig(
  id: string,
): Promise<{ schema: ConfigField[]; values: Record<string, unknown> }> {
  // id carries `@`/`/` — encode so the bridge route sees one segment.
  const res = await fetch(`${API_BASE}/plugins/config?id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`配置读取失败：HTTP ${String(res.status)}`)
  return (await res.json()) as { schema: ConfigField[]; values: Record<string, unknown> }
}

/** Persist a plugin's config values (replaces the whole value set). */
export async function saveConfig(
  id: string,
  values: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  // Reuses post()'s text/plain shape, but the body here is the value map itself
  // under `values`, matching the POST /plugins/config contract.
  const res = await fetch(`${API_BASE}/plugins/config`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ id, values }),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (body.ok !== true) throw new Error(body.error ?? `保存失败：HTTP ${String(res.status)}`)
  return { ok: true }
}

async function post(path: string, payload: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    // text/plain keeps this a simple request — no preflight against the bridge.
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(payload),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (body.ok !== true) throw new Error(body.error ?? `操作失败：HTTP ${String(res.status)}`)
}

/** `1234` → `1.2k`. */
export function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

/** `2026-08-19T…` → `2026-08-19`, or an empty string when absent. */
export function formatDate(value: string | null): string {
  return typeof value === 'string' ? value.slice(0, 10) : ''
}

/**
 * Compare two dotted version strings numerically, segment by segment.
 * Pre-release suffixes (`2.1.0-beta.1`) compare by their numeric prefix —
 * close enough to decide "the catalog has something newer than disk".
 * @returns negative when a < b, positive when a > b, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(part => {
      const n = Number.parseInt(part, 10)
      return Number.isFinite(n) ? n : 0
    })
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
