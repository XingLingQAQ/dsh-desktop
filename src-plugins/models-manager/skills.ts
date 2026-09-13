/**
 * Desktop bridge client for the skill catalog.
 *
 * Skills are plain files under the DSH home, and this page runs in the DSH
 * content webview — a different origin (`http://127.0.0.1:<host port>`) with no
 * Tauri IPC and no filesystem. Every read and write therefore goes through the
 * desktop's loopback bridge, the same channel the plugin store uses. The base
 * is baked in at serve time: the shell substitutes the `__BRIDGE_API__`
 * placeholder below with `http://127.0.0.1:<bridge port>/api/<per-boot token>`
 * before handing the bundle to the webview.
 */

/** Replaced by the shell when the bundle is served; never a real URL here. */
const BRIDGE_BASE = '__BRIDGE_API__'

/**
 * One file of an install payload. Declared here rather than in
 * `skill-archive.ts` so the wire shape reads on the type that sends it.
 */
export type WireFile =
  | { path: string; text: string; base64?: undefined }
  | { path: string; base64: string; text?: undefined }

/** One file inside a skill directory, as the host lists it. */
export interface SkillFileEntry {
  /** Slash-separated path relative to the skill directory. */
  path: string
  bytes: number
}

/** One skill as the host projects it. */
export interface SkillEntry {
  name: string
  description: string
  whenToUse: string | null
  /** False when the frontmatter carries `disable-model-invocation`. */
  modelInvocable: boolean
  userInvocable: boolean
  /** Catalog root id: `user` (DSH home) or `agents` (shared agent dir). */
  source: string
  /** Absolute path of the skill file, shown so edits are never a surprise. */
  path: string
  /**
   * Whether the skill is currently out of the catalog. Pausing renames the
   * manifest, so the skill and everything it ships stay on disk untouched.
   */
  paused: boolean
  /** Markdown after the frontmatter. */
  body: string
  /**
   * What the skill actually ships. A real skill is a directory — scripts,
   * templates, references — so the card lists these rather than pretending the
   * markdown is the whole thing.
   */
  files: SkillFileEntry[]
  /** True total; `files` is capped, this is not. */
  fileCount: number
}

/** One writable catalog root. */
export interface SkillRoot {
  id: string
  path: string
  /** Only the DSH-owned root accepts brand-new skills. */
  acceptsNew: boolean
}

export interface SkillCatalog {
  roots: SkillRoot[]
  skills: SkillEntry[]
}

/** Fields the store's install writes; the host's `save` route takes these. */
export interface SkillDraft {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  body: string
}

/** Human label for a catalog root. */
export const SOURCE_LABELS: Record<string, string> = {
  user: 'DSH',
  agents: '共享',
}

/** Install one whole skill tree, as an archive or a folder produced it. */
export interface SkillInstall {
  /**
   * `SKILL.md` plus everything beside it, encoded by `skill-archive.ts`: text
   * entries carry `text`, everything else `base64`.
   */
  files: readonly WireFile[]
  /** Destination root; the DSH-owned one by default. */
  source?: string
  /** Explicit name, overriding both the frontmatter and the folder. */
  name?: string
  /** Folder the tree came out of, used when the frontmatter names nothing. */
  folder?: string
  /** Required to replace a skill that is already installed. */
  overwrite?: boolean
}

/** What the host reports after an install. */
export interface SkillInstallResult {
  name: string
  fileCount: number
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // text/plain keeps the POST a CORS-simple request: the bridge answers no
  // preflight, and a JSON content-type would trigger one.
  const response = await fetch(`${BRIDGE_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'text/plain', ...(init?.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`桥接请求失败 (${String(response.status)})`)
  const payload = (await response.json()) as T & { ok?: boolean; error?: string }
  if (payload.ok === false) throw new Error(payload.error ?? '未知错误')
  return payload
}

/** Read the whole catalog. */
export function readCatalog(signal?: AbortSignal): Promise<SkillCatalog> {
  return call<SkillCatalog>('/skills', { signal })
}

/** Create or replace one skill. */
export function saveSkill(draft: SkillDraft): Promise<unknown> {
  return call('/skills/save', { method: 'POST', body: JSON.stringify(draft) })
}

/** Install a whole skill directory, copied file for file. */
export function installSkill(request: SkillInstall): Promise<SkillInstallResult> {
  return call<SkillInstallResult>('/skills/install', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

/** Delete one skill and its directory. */
export function removeSkill(name: string, source: string): Promise<unknown> {
  return call('/skills/remove', { method: 'POST', body: JSON.stringify({ name, source }) })
}

/**
 * Take one skill out of the catalog, or put it back. Nothing is deleted and
 * nothing is rewritten — the host renames the manifest file, which is what DSH
 * discovers a skill by, so the switch is reversible and instant.
 */
export function setSkillPaused(name: string, source: string, paused: boolean): Promise<unknown> {
  return call('/skills/pause', { method: 'POST', body: JSON.stringify({ name, source, paused }) })
}

