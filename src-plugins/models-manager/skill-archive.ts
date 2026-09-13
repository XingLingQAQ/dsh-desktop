/**
 * Reading a skill out of a `.zip` or a picked folder, in the page.
 *
 * A skill is a directory, not a document: `docx` ships 61 files including
 * Python, `impeccable` 148. So the way one arrives is an archive or a folder,
 * and this module turns either into the flat list of files the bridge installs.
 * Both halves run here rather than on the desktop side because the page is
 * where the picker and the stream APIs are — `DecompressionStream('deflate-raw')`
 * reads a zip entry with no library at all, which is why this route needs no
 * new dependency in either half.
 *
 * The ceilings below mirror the ones `skills.rs` enforces, on purpose: an
 * archive that cannot be installed should be refused before it is uploaded, and
 * a declared size is checked *before* inflating so a zip bomb is turned away
 * rather than unpacked into memory.
 */

/** One file recovered from an archive or a folder. */
export interface IncomingFile {
  /** Slash-separated path relative to the skill directory. */
  path: string
  bytes: Uint8Array
}

/** What a pick produced: the tree, plus whatever should name it. */
export interface PickedTree {
  files: readonly IncomingFile[]
  /** Folder name the tree came out of, offered to the host as a name fallback. */
  folder: string
}

/** Mirrors `skills.rs`'s `MAX_FILES`. */
const MAX_FILES = 600
/** Mirrors `skills.rs`'s `MAX_FILE_BYTES`. */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Mirrors `skills.rs`'s `MAX_TOTAL_BYTES`. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** EOCD is 22 bytes, plus a trailing comment of at most this many. */
const MAX_COMMENT = 0xffff

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`
}

/**
 * Archive furniture that is never part of a skill: macOS resource forks and
 * metadata, Windows thumbnail caches, the `__MACOSX` sidecar tree.
 */
function junk(path: string): boolean {
  return path.split('/').some(part =>
    part.startsWith('._')
    || part === '__MACOSX'
    || part === '.DS_Store'
    || part === 'Thumbs.db'
    || part === 'desktop.ini')
}

/**
 * A running size check. Declared sizes go through this before anything is
 * inflated, so an archive claiming a 10 GB entry is refused without allocating
 * for it.
 */
function budgetFor(): (path: string, size: number) => void {
  let files = 0
  let total = 0
  return (path, size) => {
    files += 1
    if (files > MAX_FILES) throw new Error(`文件太多:超过 ${String(MAX_FILES)} 个`)
    if (size > MAX_FILE_BYTES) {
      throw new Error(`${path} 太大:超过 ${megabytes(MAX_FILE_BYTES)}`)
    }
    total += size
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`内容太大:累计超过 ${megabytes(MAX_TOTAL_BYTES)}`)
    }
  }
}

/** Inflate one raw-deflate stream. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Byte offset of the end-of-central-directory record, scanning back over any comment. */
function findEocd(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - MAX_COMMENT - 22)
  for (let at = view.byteLength - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at
  }
  throw new Error('这不是一个 zip 压缩包(找不到中央目录)')
}

/**
 * Drop a wrapper folder when the archive has one.
 *
 * Zipping a folder is the usual way one of these is made, and it puts the
 * folder itself at the root of every path. That segment is the skill's name,
 * not a directory inside it — but only when nothing else sits at the root,
 * which is exactly what "every path shares it" tests.
 */
function stripWrapper(files: readonly IncomingFile[]): readonly IncomingFile[] {
  if (files.some(file => file.path === 'SKILL.md')) return files
  const wrapper = files[0]?.path.split('/')[0]
  if (wrapper === undefined || wrapper.length === 0) return files
  if (!files.every(file => file.path.startsWith(`${wrapper}/`))) return files
  return files.map(file => ({ path: file.path.slice(wrapper.length + 1), bytes: file.bytes }))
}

/** Read every entry of a zip. */
export async function readZip(file: File): Promise<PickedTree> {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const eocd = findEocd(view)
  const count = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directory = view.getUint32(eocd + 16, true)
  // The 32-bit fields are all-ones markers for a ZIP64 archive, whose real
  // sizes live in an extra field this reader does not follow.
  if (count === 0xffff || directorySize === 0xffffffff || directory === 0xffffffff) {
    throw new Error('这个压缩包是 ZIP64 格式,解压后改用「导入文件夹」')
  }
  if (directory + directorySize > view.byteLength) {
    throw new Error('压缩包的中央目录不完整')
  }

  const decoder = new TextDecoder('utf-8')
  const budget = budgetFor()
  const found: IncomingFile[] = []
  let at = directory
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error('压缩包的中央目录已损坏')
    }
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const uncompressed = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const end = at + 46 + nameLength + extraLength + commentLength
    if (end > view.byteLength) throw new Error('压缩包的中央目录已损坏')
    const name = decoder.decode(new Uint8Array(buffer, at + 46, nameLength))
    at = end

    // A directory entry is a name with no content of its own.
    if (name.endsWith('/')) continue
    const path = name.replace(/\\/g, '/')
    if (junk(path)) continue
    // Refuse on the *declared* size, so a bomb is never inflated.
    budget(path, uncompressed === 0 ? compressed : uncompressed)

    if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
      throw new Error(`${path} 的本地头损坏`)
    }
    // The local header's own name/extra lengths, never the central directory's:
    // an entry written with a data descriptor legitimately differs, and
    // trusting the wrong pair is how a zip reader silently shifts its data.
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (start + compressed > view.byteLength) throw new Error(`${path} 的数据超出压缩包末尾`)
    const raw = new Uint8Array(buffer, start, compressed)

    let bytes: Uint8Array
    if (method === 0) bytes = raw.slice()
    else if (method === 8) bytes = await inflateRaw(raw)
    else throw new Error(`${path} 用了不支持的压缩方式(${String(method)})`)

    if (uncompressed !== 0 && bytes.byteLength !== uncompressed) {
      throw new Error(`${path} 解压后大小与记录不符`)
    }
    found.push({ path, bytes })
  }
  if (found.length === 0) throw new Error('这个压缩包里没有可安装的文件')

  return { files: stripWrapper(found), folder: file.name.replace(/\.zip$/i, '') }
}

/**
 * Read every file under a folder picked with `webkitdirectory`.
 *
 * Takes an array, not the input's `FileList`: a `FileList` is live, and the
 * picker's owner clears the input as soon as it has handed the list over —
 * which empties the very collection being read. Callers snapshot first.
 */
export async function readFolder(picked: readonly File[]): Promise<PickedTree> {
  if (picked.length === 0) throw new Error('没有选中任何文件')
  // `webkitRelativePath` is `<folder>/<path…>`; the first segment is the folder
  // that was picked — the skill's name — not a directory inside it.
  const folder = picked[0]?.webkitRelativePath.split('/')[0] ?? ''
  const budget = budgetFor()
  const files: IncomingFile[] = []
  for (const file of picked) {
    const relative = file.webkitRelativePath.split('/').slice(1).join('/')
    if (relative.length === 0 || junk(relative)) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    budget(relative, bytes.byteLength)
    files.push({ path: relative, bytes })
  }
  if (files.length === 0) throw new Error('这个文件夹里没有可安装的文件')
  return { files, folder }
}

/** One `POST /skills/install` entry: exactly one of `text` / `base64` is set. */
export type WireFile = import('./skills.ts').WireFile

/** Standard base64, chunked so a large file does not blow the argument limit. */
function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step))
  }
  return btoa(binary)
}

/**
 * Encode a tree for the wire.
 *
 * The bridge reads its request body as a string, so text travels as text —
 * which keeps the common case inspectable and uncompressed — and anything that
 * is not valid UTF-8 travels base64. A skill's binaries (a template, an image,
 * a compiled helper) are the reason the second half exists.
 */
export function encodeFiles(files: readonly IncomingFile[]): WireFile[] {
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  return files.map((file) => {
    try {
      return { path: file.path, text: utf8.decode(file.bytes) }
    } catch {
      return { path: file.path, base64: base64Of(file.bytes) }
    }
  })
}

/**
 * The name this tree will install as, for the confirmation dialog only — the
 * host derives it again and its answer is the one that counts. Precedence is
 * the host's: `SKILL.md`'s frontmatter `name`, then the folder.
 * @returns the name, or `undefined` when neither names anything usable.
 */
export function previewName(files: readonly IncomingFile[], folder: string): string | undefined {
  const manifest = files.find(file => file.path === 'SKILL.md')
  if (manifest !== undefined) {
    // A name is one line by definition, so this reads the key instead of
    // parsing the block: no block scalar or quoting case can apply to it.
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(new TextDecoder().decode(manifest.bytes))?.[1]
    const declared = block === undefined
      ? undefined
      : /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(block)?.[1]
    if (declared !== undefined && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(declared)) return declared
  }
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(folder) ? folder : undefined
}

/** Total size of a tree, for the confirmation dialog. */
export function treeBytes(files: readonly IncomingFile[]): number {
  return files.reduce((total, file) => total + file.bytes.byteLength, 0)
}

/** Human size for the confirmation dialog. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
