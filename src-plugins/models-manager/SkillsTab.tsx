/**
 * Skills tab — the user-level skill catalog, plus a store for installing
 * curated ones.
 *
 * Reads and writes go through the desktop bridge (`skills.ts`); the page has
 * no filesystem of its own. DSH's filesystem skill provider watches the same
 * directories, so an install here lands in the live catalog without a restart.
 *
 * A skill is a *directory*, not a document — the ones already on this machine
 * run from 1 file to 148, with Python and reference trees among them. So the
 * one way one arrives is an archive or a folder, unpacked in the page
 * (`skill-archive.ts`) and copied in whole by the bridge. Writing a skill by
 * hand is what an editor is for, so this page does not try to be one.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconArchiveOutline20, IconDownloadOutline16,
  IconFolderOpenOutline16, IconPauseOutline16, IconPlayOutline16,
  IconRefreshOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  installSkill, readCatalog, removeSkill, saveSkill, setSkillPaused, SOURCE_LABELS,
  type SkillCatalog, type SkillDraft, type SkillEntry,
} from './skills.ts'
import {
  encodeFiles, formatBytes, previewName, readFolder, readZip, treeBytes,
  type PickedTree,
} from './skill-archive.ts'
import { BUNDLED_CATALOG, type CatalogEntry } from './skill-catalog.ts'
import {
  downloadSkill, listSource, loadManifests, SOURCES, type RemoteSkill,
} from './skill-sources.ts'
import { IconAction } from './controls.tsx'

/** The card's mark: the skill's own first character, upper-cased. */
function glyphOf(name: string): string {
  const first = Array.from(name)[0] ?? '?'
  return first.toUpperCase()
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: SkillCatalog }

/** Which half of the tab is showing. */
type View = 'installed' | 'store'

/** A picked archive or folder, waiting for the user to confirm the install. */
interface Incoming {
  tree: PickedTree
  /** Where it came from, shown in the dialog. */
  origin: string
  /** Derived the same way the host derives it; `undefined` means it will refuse. */
  name: string | undefined
  bytes: number
  /** Whether a skill of that name is already installed here. */
  replacing: boolean
}

/** Where a user-supplied catalog URL is remembered. */
const CATALOG_URL_KEY = 'dsh-desktop.skill-store.catalog-url'

/** Which source the store view is browsing. */
type SourceId = 'bundled' | 'custom' | string

/** One browsable source's load state. */
type SourceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; skills: readonly RemoteSkill[] }


/** Render the skill catalog and the store. */
export function SkillsTab(): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [view, setView] = useState<View>('installed')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SkillEntry | null>(null)
  const [catalogUrl, setCatalogUrl] = useState(() => localStorage.getItem(CATALOG_URL_KEY) ?? '')
  const [remote, setRemote] = useState<readonly CatalogEntry[] | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState<SourceId>('bundled')
  const [sourceRevision, setSourceRevision] = useState(0)
  const [sourceState, setSourceState] = useState<SourceState>({ status: 'idle' })
  const [incoming, setIncoming] = useState<Incoming | null>(null)
  // A one-line receipt for something that left no visible mark on the list —
  // an import reports how much it brought in.
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const zipInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    readCatalog(controller.signal).then(
      (catalog) => { setState({ status: 'ready', catalog }) },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { controller.abort() }
  }, [request])

  // The custom catalog is a JSON document the reader points at; fetched only
  // while that chip is selected, so a saved URL costs nothing on other sources.
  useEffect(() => {
    const url = catalogUrl.trim()
    if (sourceId !== 'custom' || url.length === 0) {
      setRemote(null)
      setRemoteError(null)
      return
    }
    const controller = new AbortController()
    fetch(url, { signal: controller.signal }).then(
      (response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        return response.json() as Promise<readonly CatalogEntry[]>
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setRemoteError(error instanceof Error ? error.message : String(error))
        setRemote(null)
        return undefined
      },
    ).then((entries) => {
      if (entries === undefined || controller.signal.aborted) return
      setRemote(entries)
      setRemoteError(null)
    })
    return () => { controller.abort() }
  }, [catalogUrl, sourceId])

  // A repository source is listed on demand; its descriptions arrive after the
  // list is up, so a 148-skill collection renders immediately instead of
  // waiting on 148 manifests.
  const source = SOURCES.find(candidate => candidate.id === sourceId)
  useEffect(() => {
    if (source === undefined) {
      setSourceState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setSourceState({ status: 'loading' })
    listSource(source, controller.signal).then(
      (skills) => {
        if (controller.signal.aborted) return
        setSourceState({ status: 'ready', skills })
        void loadManifests(source, skills, (skill, info) => {
          if (controller.signal.aborted) return
          setSourceState(current => current.status !== 'ready'
            ? current
            : {
              status: 'ready',
              skills: current.skills.map(candidate => candidate.name === skill.name
                ? { ...candidate, ...info }
                : candidate),
            })
        }, controller.signal)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setSourceState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return () => { controller.abort() }
  }, [sourceId, source, sourceRevision])

  const reload = (): void => {
    setFormError(null)
    setPendingDelete(null)
    setSavedNote(null)
    setRequest(value => value + 1)
  }

  const destroy = async (entry: SkillEntry): Promise<void> => {
    setFormError(null)
    setSaving(true)
    try {
      await removeSkill(entry.name, entry.source)
      reload()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Take one skill out of the catalog, or put it back. Nothing is written:
   * the host renames the manifest, which is what DSH discovers a skill by.
   */
  const togglePause = async (entry: SkillEntry): Promise<void> => {
    setFormError(null)
    setSaving(true)
    try {
      await setSkillPaused(entry.name, entry.source, !entry.paused)
      // Reloaded rather than patched locally: the host's scan is what decides
      // the state, and a rename that silently did nothing must not read as if
      // it worked.
      setRequest(value => value + 1)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const install = async (entry: CatalogEntry): Promise<void> => {
    setFormError(null)
    setSaving(true)
    try {
      await saveSkill({
        name: entry.name,
        description: entry.description,
        modelInvocable: entry.modelInvocable,
        userInvocable: entry.userInvocable,
        body: entry.body,
        ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
      })
      setView('installed')
      reload()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Read a picked archive or folder and offer it for confirmation. Unpacking
   * happens here, before anything is uploaded: an archive this page cannot read
   * is refused with its own reason rather than as a failed request.
   */
  const pick = async (source: Promise<PickedTree>, origin: string): Promise<void> => {
    setFormError(null)
    setSaving(true)
    try {
      const tree = await source
      // Checked here rather than letting the host refuse it: `SKILL.md` at the
      // root is what makes the directory a skill, and a confirmation dialog
      // that cannot succeed should never open.
      if (!tree.files.some(file => file.path === 'SKILL.md')) {
        throw new Error(
          '这个技能里没有 SKILL.md,DSH 不会把它当成技能。'
          + '请确认选的是技能目录本身(或压缩包里那一层),而不是它的上一层。',
        )
      }
      const name = previewName(tree.files, tree.folder)
      setIncoming({
        tree,
        origin,
        name,
        bytes: treeBytes(tree.files),
        replacing: name !== undefined && installedNames.has(name),
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /** Copy the confirmed tree in, whole, replacing the same name if asked. */
  const confirmInstall = async (): Promise<void> => {
    if (incoming?.name === undefined) return
    setFormError(null)
    setSaving(true)
    try {
      const result = await installSkill({
        files: encodeFiles(incoming.tree.files),
        folder: incoming.tree.folder,
        overwrite: incoming.replacing,
      })
      setIncoming(null)
      setView('installed')
      reload()
      // After `reload()`, which clears the note for the actions that need no
      // receipt: an import leaves no trace on the list beyond one more card.
      setSavedNote(`已安装 ${result.name}(${String(result.fileCount)} 个文件)`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Fetch one skill out of a repository source and hand it to the same
   * confirmation step an imported archive goes through — the bytes land in the
   * page, and the bridge installs them exactly as it installs a zip.
   */
  const openRemote = (skill: RemoteSkill): void => {
    if (source === undefined) return
    void pick(
      downloadSkill(source, skill).then(files => ({ files, folder: skill.name })),
      `${source.label} · ${skill.dir}`,
    )
  }

  const entries = remote ?? BUNDLED_CATALOG
  const installed = state.status === 'ready' ? state.catalog.skills : []
  const installedNames = new Set(installed.map(skill => skill.name))
  const activeCount = installed.filter(skill => !skill.paused).length

  return (
    <div className="dsx-skills-container" aria-busy={saving || state.status === 'loading'}>
      <div className="dsx-skills-viewswitch">
        <div className="dsx-skills-viewtabs" role="tablist" aria-label="技能视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'installed'}
            data-active={view === 'installed' ? 'true' : undefined}
            className="dsx-skills-viewtab"
            onClick={() => { setView('installed') }}
          >
            已安装 {installed.length > 0
              ? installed.length === activeCount
                ? `(${String(installed.length)})`
                : `(${String(activeCount)}/${String(installed.length)})`
              : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'store'}
            data-active={view === 'store' ? 'true' : undefined}
            className="dsx-skills-viewtab"
            onClick={() => { setView('store') }}
          >
            技能商店
          </button>
        </div>
        <span className="dsx-skills-viewFiller" />
        <IconAction
          label="刷新"
          icon={<IconRefreshOutline16 />}
          disabled={state.status === 'loading'}
          onClick={reload}
        />
        <IconAction
          label="导入文件夹"
          icon={<IconFolderOpenOutline16 />}
          disabled={saving}
          onClick={() => { folderInput.current?.click() }}
        />
        <IconAction
          label="导入压缩包"
          icon={<IconArchiveOutline20 size={16} />}
          disabled={saving}
          onClick={() => { zipInput.current?.click() }}
        />
        {/*
         * Both pickers live here and are never shown: a real `<input>` is the
         * only way to open the OS dialog, and `webkitdirectory` on one is what
         * makes a folder pickable at all.
         *
         * Each handler SNAPSHOTS what it was given before clearing the input.
         * `input.files` is a live collection — assigning `value = ''` empty it —
         * so reading it after the reset, or handing the collection on and
         * reading it later, gets nothing. Clearing is still needed, or picking
         * the same path twice fires no `change`.
         */}
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (chosen !== undefined) void pick(readZip(chosen), chosen.name)
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          // Not in React's JSX types; it is what makes the picker a folder picker.
          {...{ webkitdirectory: '' }}
          onChange={(event) => {
            const chosen = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (chosen.length > 0) {
              void pick(readFolder(chosen), chosen[0]?.webkitRelativePath.split('/')[0] ?? '文件夹')
            }
          }}
        />
      </div>

      <p className="dsx-skills-description">
        技能是一个目录 —— 里面可以有脚本、模板、参考文档,DSH 启动时读取它,把每个技能变成一条斜杠命令。改完即生效,无需重启。
      </p>

      {savedNote !== null ? <p className="dsx-skills-saved" role="status">{savedNote}</p> : null}
      {formError !== null && incoming === null ? (
        <p className="dsx-skills-errorInline" role="alert">{formError}</p>
      ) : null}

      {view === 'installed' ? (
        <>
          {state.status === 'loading' ? <p className="dsx-skills-loading">加载中…</p> : null}
          {state.status === 'error' ? (
            <div className="dsx-skills-error" role="alert">
              <p>{state.message}</p>
              <Button size="sm" variant="outline" onClick={reload}>重试</Button>
            </div>
          ) : null}

          {state.status === 'ready' && installed.length === 0 ? (
            <div className="dsx-skills-empty">
              <span className="dsx-skills-emptyMark" aria-hidden="true">/</span>
              <p className="dsx-skills-emptyTitle">还没有技能</p>
              <p className="dsx-skills-emptyHint">
                用右上角的图标导入一个压缩包或文件夹,或切到「技能商店」挑一个
              </p>
            </div>
          ) : null}

          {state.status === 'ready' && installed.length > 0 ? (
            <div className="dsx-skills-list">
              {installed.map((skill) => (
                <div
                  key={`${skill.source}:${skill.name}`}
                  className="dsx-skills-card"
                  data-paused={skill.paused ? 'true' : undefined}
                >
                  <span className="dsx-skills-glyph" data-source={skill.source} aria-hidden="true">
                    {glyphOf(skill.name)}
                  </span>
                  <div className="dsx-skills-cardMain">
                    <div className="dsx-skills-cardHeader">
                      <div className="dsx-skills-cardTitle">
                        <span className="dsx-skills-skillName">/{skill.name}</span>
                        <span className="dsx-skills-source">
                          <span className="dsx-skills-sourceDot" data-source={skill.source} />
                          {SOURCE_LABELS[skill.source] ?? skill.source}
                        </span>
                        {skill.paused ? (
                          <span className="dsx-skills-badge" data-flag="paused">已暂停</span>
                        ) : null}
                      </div>
                      <div className="dsx-skills-cardActions">
                        <IconAction
                          label={skill.paused
                            ? '恢复:重新放回目录,DSH 下次读取时就能用'
                            : '暂停:不删文件,DSH 不再加载它'}
                          disabled={saving}
                          icon={skill.paused ? <IconPlayOutline16 /> : <IconPauseOutline16 />}
                          onClick={() => { void togglePause(skill) }}
                        />
                        <IconAction
                          label="删除"
                          tone="danger"
                          disabled={saving}
                          icon={<IconTrashOutline16 />}
                          onClick={() => { setPendingDelete(skill) }}
                        />
                      </div>
                    </div>
                    <p className="dsx-skills-cardDescription">{skill.description || '(没有描述)'}</p>
                    {skill.paused ? (
                      <p className="dsx-skills-pausedHint">
                        已暂停:文件一个没动,只是 DSH 不再加载它。点「恢复」立刻回来。
                      </p>
                    ) : null}
                    {skill.files.length > 0 ? (
                      // Folded away by default: the file list is what makes an
                      // imported skill legible, but it is 148 rows for the
                      // biggest one and nobody needs that in the way.
                      <details className="dsx-skills-files">
                        <summary>
                          文件 ({String(skill.fileCount)}
                          {skill.fileCount > skill.files.length ? `,列出前 ${String(skill.files.length)}` : ''}
                          )
                        </summary>
                        <ul className="dsx-skills-fileList">
                          {skill.files.map(file => (
                            <li key={file.path}>
                              <span className="dsx-skills-filePath">{file.path}</span>
                              <span className="dsx-skills-fileSize">{formatBytes(file.bytes)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <p className="dsx-skills-cardMeta">
                      <span className="dsx-skills-cardPath" title={skill.path}>{skill.path}</span>
                      {skill.fileCount > 1 ? (
                        <span className="dsx-skills-metaItem">{String(skill.fileCount)} 个文件</span>
                      ) : null}
                      {!skill.userInvocable ? (
                        <span className="dsx-skills-metaItem">不可手动调用</span>
                      ) : null}
                      {!skill.modelInvocable ? (
                        <span className="dsx-skills-metaItem">模型不可见</span>
                      ) : null}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {/*
           * Source picker. The bundled five are offline and hand-written; every
           * other chip is a real repository read over jsDelivr, because the page
           * has no filesystem and the desktop bridge is for local files. The
           * last chip is the escape hatch: a JSON document of drafts.
           */}
          <div className="dsx-skills-sourceRow" role="tablist" aria-label="技能来源">
            <button
              type="button"
              role="tab"
              aria-selected={sourceId === 'bundled'}
              data-active={sourceId === 'bundled' ? 'true' : undefined}
              className="dsx-skills-sourceChip"
              onClick={() => { setSourceId('bundled') }}
            >
              内置推荐
            </button>
            {SOURCES.map(candidate => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={sourceId === candidate.id}
                data-active={sourceId === candidate.id ? 'true' : undefined}
                className="dsx-skills-sourceChip"
                title={candidate.note}
                onClick={() => { setSourceId(candidate.id) }}
              >
                {candidate.label}
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={sourceId === 'custom'}
              data-active={sourceId === 'custom' ? 'true' : undefined}
              className="dsx-skills-sourceChip"
              onClick={() => { setSourceId('custom') }}
            >
              自定义源
            </button>
          </div>

          {source !== undefined ? (
            <p className="dsx-skills-sourceNote">
              {source.note} ·
              {' '}
              <a
                className="dsx-skills-sourceLink"
                href={`https://github.com/${source.repo}`}
                target="_blank"
                rel="noreferrer"
              >
                {source.repo}
              </a>
            </p>
          ) : null}

          {sourceId === 'custom' ? (
            <div className="dsx-skills-catalogBar">
              <input
                className="dsx-skills-input"
                value={catalogUrl}
                placeholder="技能清单的 JSON 地址,格式是一组 name/description/body"
                onChange={(event) => {
                  const next = event.currentTarget.value
                  setCatalogUrl(next)
                  localStorage.setItem(CATALOG_URL_KEY, next)
                }}
              />
            </div>
          ) : null}
          {remoteError !== null ? (
            <p className="dsx-skills-errorInline" role="alert">商店源读取失败:{remoteError}</p>
          ) : null}

          {source !== undefined ? (
            <>
              {sourceState.status === 'loading' ? (
                <p className="dsx-skills-loading">正在读取 {source.repo} 的技能清单…</p>
              ) : null}
              {sourceState.status === 'error' ? (
                <div className="dsx-skills-error" role="alert">
                  <p>{sourceState.message}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setSourceRevision(value => value + 1) }}
                  >
                    重试
                  </Button>
                </div>
              ) : null}
              {sourceState.status === 'ready' ? (
                <div className="dsx-skills-list">
                  {sourceState.skills.map(skill => {
                    // The name the host will take: the manifest's, which is also
                    // what DSH resolves the skill by.
                    const named = skill.name
                    const already = installedNames.has(named)
                    return (
                      <div key={skill.dir} className="dsx-skills-card">
                        <span className="dsx-skills-glyph" data-source="catalog" aria-hidden="true">
                          {glyphOf(named)}
                        </span>
                        <div className="dsx-skills-cardMain">
                          <div className="dsx-skills-cardHeader">
                            <div className="dsx-skills-cardTitle">
                              <span className="dsx-skills-skillName">/{named}</span>
                              <span className="dsx-skills-source">
                                <span className="dsx-skills-sourceDot" data-source="catalog" />
                                {skill.group}
                              </span>
                              {already ? (
                                <span className="dsx-skills-badge" data-flag="installed">已安装</span>
                              ) : null}
                            </div>
                            <Button
                              size="sm"
                              variant={already ? 'outline' : 'primary'}
                              icon={<IconDownloadOutline16 />}
                              disabled={saving}
                              onClick={() => { openRemote(skill) }}
                            >
                              {saving ? '下载中…' : already ? '覆盖安装' : '安装'}
                            </Button>
                          </div>
                          <p className="dsx-skills-cardDescription">
                            {skill.description ?? '读取描述中…'}
                          </p>
                          <p className="dsx-skills-cardMeta">
                            <span className="dsx-skills-cardPath" title={skill.dir}>{skill.dir}</span>
                            {skill.files.length > 1 ? (
                              <span className="dsx-skills-metaItem">
                                {String(skill.files.length)} 个文件
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </>
          ) : null}

          {sourceId !== 'custom' && (source === undefined || sourceState.status === 'ready') && entries.length === 0 ? (
            <div className="dsx-skills-empty">
              <span className="dsx-skills-emptyMark" aria-hidden="true">/</span>
              <p className="dsx-skills-emptyTitle">这个商店源里没有技能</p>
              <p className="dsx-skills-emptyHint">
                换一个来源,或在「自定义源」里填一个技能清单的地址
              </p>
            </div>
          ) : null}

          {/* The bundled five and a custom JSON document are the same shape: a
              list of drafts, installed by writing one markdown file each. */}
          {sourceId === 'bundled' || sourceId === 'custom' ? (
            entries.length === 0 ? (
              sourceId === 'custom' ? (
                <div className="dsx-skills-empty">
                  <span className="dsx-skills-emptyMark" aria-hidden="true">/</span>
                  <p className="dsx-skills-emptyTitle">这个商店源里没有技能</p>
                  <p className="dsx-skills-emptyHint">
                    换一个来源,或在「自定义源」里填一个技能清单的地址
                  </p>
                </div>
              ) : null
            ) : (
              <div className="dsx-skills-list">
                {entries.map((entry) => {
                  const already = installedNames.has(entry.name)
                  return (
                    <div key={entry.name} className="dsx-skills-card">
                      <span className="dsx-skills-glyph" data-source="catalog" aria-hidden="true">
                        {glyphOf(entry.name)}
                      </span>
                      <div className="dsx-skills-cardMain">
                        <div className="dsx-skills-cardHeader">
                          <div className="dsx-skills-cardTitle">
                            <span className="dsx-skills-skillName">/{entry.name}</span>
                            <span className="dsx-skills-source">
                              <span className="dsx-skills-sourceDot" data-source="catalog" />
                              {entry.group}
                            </span>
                            {already ? (
                              <span className="dsx-skills-badge" data-flag="installed">已安装</span>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant={already ? 'outline' : 'primary'}
                            icon={<IconDownloadOutline16 />}
                            disabled={saving}
                            onClick={() => { void install(entry) }}
                          >
                            {already ? '覆盖安装' : '安装'}
                          </Button>
                        </div>
                        <p className="dsx-skills-cardDescription">{entry.description}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : null}
        </>
      )}

      <Modal
        open={pendingDelete !== null}
        onClose={() => { if (!saving) { setPendingDelete(null); setFormError(null) } }}
        title={`删除 /${pendingDelete?.name ?? ''}?`}
        closeLabel="关闭"
        description="这个目录会被整个删掉,不能撤销。"
        className="dsx-skills-dialog dsx-skills-dialog"
        footer={(
          <>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => { setPendingDelete(null); setFormError(null) }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className="dsx-skills-dangerFill dsx-skills-dangerFill"
              disabled={saving}
              onClick={() => { if (pendingDelete !== null) void destroy(pendingDelete) }}
            >
              {saving ? '删除中…' : '确认删除'}
            </Button>
          </>
        )}
      >
        <div className="dsx-skills-form">
          <p className="dsx-skills-confirmPath" title={pendingDelete?.path}>{pendingDelete?.path}</p>
          {formError !== null ? <p className="dsx-skills-errorInline" role="alert">{formError}</p> : null}
        </div>
      </Modal>

      {/*
       * The confirmation step for an import. It is here because the name is the
       * host's to decide, not the page's — the frontmatter may name the skill
       * something other than the folder — so the user gets to see which one
       * will be taken, and be told when it will replace what is already there.
       */}
      <Modal
        open={incoming !== null}
        onClose={() => { if (!saving) { setIncoming(null); setFormError(null) } }}
        title={incoming?.name === undefined ? '这个技能装不了' : `安装 /${incoming.name}?`}
        closeLabel="关闭"
        description={incoming === null
          ? undefined
          : `${incoming.origin} · ${String(incoming.tree.files.length)} 个文件 · ${formatBytes(incoming.bytes)}`}
        className="dsx-skills-dialog dsx-skills-dialog"
        footer={(
          <>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => { setIncoming(null); setFormError(null) }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              className={incoming?.replacing === true ? 'dsx-skills-dangerFill dsx-skills-dangerFill' : undefined}
              disabled={saving || incoming?.name === undefined}
              onClick={() => { void confirmInstall() }}
            >
              {saving ? '安装中…' : incoming?.replacing === true ? '覆盖安装' : '安装'}
            </Button>
          </>
        )}
      >
        <div className="dsx-skills-form">
          {incoming?.name === undefined ? (
            <p className="dsx-skills-errorInline" role="alert">
              从压缩包/文件夹里读不出技能名。请在 SKILL.md 的 frontmatter 里写一行 <code>name: kebab-case</code>,
              或让文件夹用 kebab-case 命名,再重新导入。
            </p>
          ) : (
            <>
              {incoming.replacing ? (
                <p className="dsx-skills-errorInline" role="alert">
                  已经有一个叫 /{incoming.name} 的技能,安装会把它整个替换掉。原来目录里的文件(包括改动过的)
                  都会没了。
                </p>
              ) : null}
              <p className="dsx-skills-description">会把下面这些文件原样复制过去,不修改任何内容:</p>
              <ul className="dsx-skills-fileList dsx-skills-fileListScroll">
                {incoming.tree.files.slice(0, 200).map(file => (
                  <li key={file.path}>
                    <span className="dsx-skills-filePath">{file.path}</span>
                    <span className="dsx-skills-fileSize">{formatBytes(file.bytes.byteLength)}</span>
                  </li>
                ))}
              </ul>
              {incoming.tree.files.length > 200 ? (
                <p className="dsx-skills-description">
                  还有 {String(incoming.tree.files.length - 200)} 个文件没有列出。
                </p>
              ) : null}
            </>
          )}
          {formError !== null ? <p className="dsx-skills-errorInline" role="alert">{formError}</p> : null}
        </div>
      </Modal>
    </div>
  )
}

