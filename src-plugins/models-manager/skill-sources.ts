/**
 * Skill sources: real repositories of skills, browsed from the store.
 *
 * The bundled catalog is five hand-written drafts; a skill ecosystem is
 * directories full of scripts, and there is no registry to query. What there is
 * is GitHub — the official `anthropics/skills`, and the community collections
 * that keep to the same `SKILL.md` layout — so the store treats a repository as
 * a source and reads it through jsDelivr, which serves both a flat file index
 * and the files themselves with `Access-Control-Allow-Origin: *` and no API
 * key. That matters here because the page is on `127.0.0.1` and the desktop's
 * own bridge is for local files, not for the internet.
 *
 * A source is browsed by listing every `SKILL.md` in the repository: the
 * directory holding one *is* a skill, whatever else it contains. Descriptions
 * come from those manifests, fetched after the list renders so a 148-skill
 * collection shows up immediately instead of waiting on 148 round trips.
 */

/** One browsable repository. */
export interface SkillSource {
  /** Stable key used by the picker. */
  id: string
  /** What the chip says. */
  label: string
  /** `owner/name` on GitHub. */
  repo: string
  /** Branch to read; `main` unless the repository says otherwise. */
  branch: string
  /** One line about what is in it. */
  note: string
}

/**
 * The curated sources, each verified to carry `SKILL.md` directories.
 *
 * Ordered by how likely a reader is to want it: the official examples first,
 * then the two general collections, then the two large team-maintained ones.
 * `group` in the UI comes from the repository's own directory layout, so a
 * collection organised by team keeps that organisation.
 */
export const SOURCES: readonly SkillSource[] = [
  {
    id: 'anthropics',
    label: 'Anthropic 官方',
    repo: 'anthropics/skills',
    branch: 'main',
    note: '官方示例:文档处理、前端设计、MCP 构建等 17 个技能',
  },
  {
    id: 'agent-toolkit',
    label: 'Agent Toolkit',
    repo: 'softaworks/agent-toolkit',
    branch: 'main',
    note: '社区精选合集,80+ 个技能,偏开发与写作流程',
  },
  {
    id: 'mattpocock',
    label: 'Matt Pocock',
    repo: 'mattpocock/skills',
    branch: 'main',
    note: '18 个偏工程实践的小技能,结构简单,适合当模板',
  },
  {
    id: 'wshobson',
    label: 'wshobson/agents',
    repo: 'wshobson/agents',
    branch: 'main',
    note: '按领域分组的 140+ 个技能:后端、前端、云、LLM 应用等',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    repo: 'nvidia/skills',
    branch: 'main',
    note: '英伟达官方技能:RAG、CUDA、仿真等 130+ 个',
  },
]

/** One file inside a browsable skill. */
export interface RemoteFile {
  /** Path relative to the skill directory. */
  path: string
  bytes: number
}

/** One skill found in a source. */
export interface RemoteSkill {
  /** Directory path inside the repository, no leading slash. */
  dir: string
  /** Last path segment — the name the install falls back to. */
  name: string
  /** Directory the repository organised it under. */
  group: string
  files: readonly RemoteFile[]
  bytes: number
  /** Read from the manifest afterwards; absent while it loads or if it failed. */
  description?: string
  whenToUse?: string
}

/** jsDelivr's file index, as much of it as this reads. */
interface FlatEntry {
  name?: unknown
  size?: unknown
}

/** How many manifests to fetch at once — enough to be quick, few enough to be polite. */
const MANIFEST_CONCURRENCY = 6

/** A source's files, refused past this so one huge repository cannot fill memory. */
const MAX_SOURCE_FILES = 8000

/** The index URL for one source. */
function indexUrl(source: SkillSource): string {
  return `https://data.jsdelivr.com/v1/package/gh/${source.repo}@${source.branch}/flat`
}

/** The raw-file URL for one path inside a source. */
export function rawUrl(source: SkillSource, dir: string, path: string): string {
  return `https://cdn.jsdelivr.net/gh/${source.repo}@${source.branch}/${dir}/${path}`
}

/** The URL of a skill's manifest, for the description pass. */
function manifestUrl(source: SkillSource, dir: string): string {
  return rawUrl(source, dir, 'SKILL.md')
}

/**
 * Which directory a skill belongs under, for grouping the list.
 *
 * Collections disagree about layout — `skills/<name>`, `<name>`,
 * `plugins/<group>/skills/<name>` — so the label is read off the path rather
 * than assumed: a `plugins/<group>/skills/<name>` path groups by `<group>`,
 * a `skills/<name>` path groups by the source itself, and anything else groups
 * by its first segment.
 * @param dir - the skill directory inside the repository.
 * @param fallback - the source's own label.
 * @returns the group label.
 */
function groupOf(dir: string, fallback: string): string {
  const parts = dir.split('/')
  if (parts[0] === 'plugins' && parts.length >= 4) return parts[1] ?? fallback
  if (parts.length === 1) return fallback
  const first = parts[0] ?? fallback
  return first === 'skills' ? fallback : first
}

/**
 * Turn a flat index into skills.
 *
 * Every `SKILL.md` marks one, so a directory is a skill exactly when it holds
 * one. A repository that keeps both a source tree and a built copy — jsDelivr's
 * index lists both — mentions the same name twice; the shallowest path wins,
 * because that is the one a reader means and the one whose files are canonical.
 * @param entries - the raw index entries.
 * @param fallbackGroup - the source label, for skills with no directory group.
 * @returns the skills, sorted by group then name.
 */
function skillsFrom(entries: readonly FlatEntry[], fallbackGroup: string): RemoteSkill[] {
  /** Every file in the repository, keyed by the directory holding it. */
  const filesByDir = new Map<string, RemoteFile[]>()
  for (const entry of entries) {
    if (typeof entry.name !== 'string') continue
    const full = entry.name.replace(/^\/+/, '')
    const slash = full.lastIndexOf('/')
    if (slash <= 0) continue
    const dir = full.slice(0, slash)
    const bucket = filesByDir.get(dir)
    const file = { path: full.slice(slash + 1), bytes: typeof entry.size === 'number' ? entry.size : 0 }
    if (bucket === undefined) filesByDir.set(dir, [file])
    else bucket.push(file)
  }

  /** Chosen skill directories, keyed by the name they install under. */
  const chosen = new Map<string, RemoteSkill>()
  for (const [dir, files] of filesByDir) {
    if (!files.some(file => file.path === 'SKILL.md')) continue
    const parts = dir.split('/')
    const name = parts[parts.length - 1] ?? ''
    if (name.length === 0) continue
    const existing = chosen.get(name)
    if (existing !== undefined && existing.dir.split('/').length <= parts.length) continue
    chosen.set(name, {
      dir,
      name,
      group: groupOf(dir, fallbackGroup),
      files,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    })
  }

  return [...chosen.values()].sort((left, right) =>
    left.group === right.group
      ? left.name.localeCompare(right.name)
      : left.group.localeCompare(right.group))
}

/** Fetch and parse one source's file index. */
async function readIndex(source: SkillSource, signal?: AbortSignal): Promise<readonly FlatEntry[]> {
  const response = await fetch(indexUrl(source), { signal })
  if (!response.ok) {
    throw new Error(`${source.label}:读取仓库清单失败(HTTP ${String(response.status)})`)
  }
  const body = await response.json() as { files?: unknown }
  if (!Array.isArray(body.files)) throw new Error(`${source.label}:仓库清单格式不对`)
  if (body.files.length > MAX_SOURCE_FILES) {
    throw new Error(`${source.label}:仓库太大(${String(body.files.length)} 个文件),没法整个列出来`)
  }
  return body.files as readonly FlatEntry[]
}

/**
 * List the skills in one source.
 * @param source - the repository to read.
 * @param signal - cancellation for the index request.
 * @returns the skills, descriptions not yet loaded.
 */
export async function listSource(source: SkillSource, signal?: AbortSignal): Promise<RemoteSkill[]> {
  return skillsFrom(await readIndex(source, signal), source.label)
}

/** The `name:`/`description:` values of one manifest, as far as the store needs them. */
export interface ManifestInfo {
  name?: string
  description?: string
  whenToUse?: string
}

/**
 * Read one manifest's frontmatter.
 *
 * A shallow reader on purpose: this runs on other people's files and only ever
 * produces a card's text, so it takes the simple `key: value` form and gives up
 * on anything it does not recognise rather than growing a YAML parser. A
 * `description:` block scalar (the `|` form) is folded to a single line, which
 * is how the newer skills write longer descriptions.
 * @param text - the manifest's contents.
 * @returns whatever of the three fields could be read.
 */
export function readManifest(text: string): ManifestInfo {
  const block = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)/.exec(text)?.[1]
  if (block === undefined) return {}
  const info: ManifestInfo = {}
  const lines = block.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[index] ?? '')
    if (match === null) continue
    const key = match[1] ?? ''
    if (key !== 'name' && key !== 'description' && key !== 'whenToUse' && key !== 'when-to-use') continue
    let value = (match[2] ?? '').trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const indent = /^[ \t]+/.exec(lines[index + 1] ?? '')?.[0].length ?? 0
      const parts: string[] = []
      let at = index + 1
      while (at < lines.length) {
        const line = lines[at] ?? ''
        if (line.trim().length === 0) {
          parts.push('')
          at += 1
          continue
        }
        const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0
        if (lead < indent) break
        parts.push(line.trim())
        at += 1
      }
      index = at - 1
      value = parts.join(' ').replace(/\s+/g, ' ').trim()
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    if (value.length === 0) continue
    if (key === 'name') info.name = value
    else if (key === 'description') info.description = value
    else info.whenToUse = value
  }
  return info
}

/**
 * Fill in descriptions for a list of skills, a few at a time.
 *
 * Called after the list is on screen, so a slow or failing manifest costs a
 * line of text rather than the whole source. Each result is handed to
 * `onEach` as it lands, which is what makes the cards fill in progressively.
 * @param source - the repository the skills came from.
 * @param skills - the skills to annotate.
 * @param onEach - called with each skill once its manifest has been read.
 * @param signal - cancellation; in-flight requests are abandoned.
 */
export async function loadManifests(
  source: SkillSource,
  skills: readonly RemoteSkill[],
  onEach: (skill: RemoteSkill, info: ManifestInfo) => void,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const skill = skills[index]
      if (skill === undefined) return
      if (signal?.aborted === true) return
      try {
        const response = await fetch(manifestUrl(source, skill.dir), { signal })
        if (!response.ok) continue
        onEach(skill, readManifest(await response.text()))
      } catch {
        // Cancelled or unreachable: the card keeps the directory name.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MANIFEST_CONCURRENCY, skills.length) }, worker))
}

/**
 * Download every file of one skill.
 *
 * Nothing here trusts the index: a file that comes back short is an error, so a
 * truncated download cannot be installed as a silently broken skill.
 * @param source - the repository to read from.
 * @param skill - the skill to fetch.
 * @param signal - cancellation for the requests.
 * @returns the files, ready for the bridge.
 */
export async function downloadSkill(
  source: SkillSource,
  skill: RemoteSkill,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: Uint8Array }[]> {
  const out: { path: string; bytes: Uint8Array }[] = []
  for (const file of skill.files) {
    const response = await fetch(rawUrl(source, skill.dir, file.path), { signal })
    if (!response.ok) {
      throw new Error(`${skill.name}/${file.path} 下载失败(HTTP ${String(response.status)})`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 && file.bytes > 0) {
      throw new Error(`${skill.name}/${file.path} 下载不完整`)
    }
    out.push({ path: file.path, bytes })
  }
  if (!out.some(file => file.path === 'SKILL.md')) {
    throw new Error(`${skill.name} 里没有 SKILL.md,装不了`)
  }
  return out
}
