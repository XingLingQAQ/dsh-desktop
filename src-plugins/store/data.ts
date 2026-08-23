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
  client: { platform: string; immediately: boolean; inject: string[]; entry: string } | null
  host: { entry: string | null; patch: string | null } | null
  tarball: string
  /** The published package. Null when the plugin was never released to npm. */
  npm: { version: string; tarball: string } | null
  /** True when `npm` is set, i.e. installable without running a build. */
  installable: boolean
}

export interface Catalog {
  schemaVersion: number
  generatedAt: string
  source: { topic: string; scanned: number; accepted: number; installable: number }
  plugins: CatalogPlugin[]
}

export interface Installed {
  id: string
  name: string
  version: string
  description: string
  has_client: boolean
  has_server: boolean
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
