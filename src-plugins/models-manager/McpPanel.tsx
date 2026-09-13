/**
 * MCP tab: every configured server, what its connection is actually doing, what
 * it actually offers, and the switches that change either.
 *
 * A record being present says nothing about a connection working. A handshake
 * failure is logged and retried rather than surfaced, so a server can sit
 * reading "active" while contributing nothing, and a wrong credential looks
 * exactly like a wrong address. The tool list is what tells them apart: it is
 * read from the same registry the model reads, so an enabled server with zero
 * tools is a real signal rather than a rendering gap — and when it happens,
 * `诊断` goes and asks the server itself why.
 *
 * Everything comes from this desktop's own host route (`plugins/dsh-desktop-mcp`);
 * see `mcp.ts` for why it is not the bridge.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChevronDownOutline14, IconChevronRightOutline14, IconEditOutline16,
  IconPauseOutline16, IconPlayOutline16, IconPlusOutline16, IconRefreshOutline16,
  IconSearchOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  deleteMcpServer, diagnoseMcp, readMcpState, reconnectMcp, setMcpEnabled,
  type FiberPhase, type McpServer, type McpState,
} from './mcp.ts'
import { IconAction } from './controls.tsx'
import { McpEditor } from './McpEditor.tsx'

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; state: McpState }

/** Every status a row can be in, once the raw fields are interpreted. */
type Health = 'paused' | 'connecting' | 'connected' | 'empty' | 'failed' | 'detached'

/** Phases that mean the connection is mid-transition and worth watching. */
const SETTLING = new Set<FiberPhase>(['pending', 'loading', 'unloading'])

/** Poll spacing while a connection is still settling. */
const FAST_MS = 400

/** Poll spacing at rest: status should stay honest without being chatty. */
const IDLE_MS = 2500

/** How long an action keeps the fast cadence, covering the reconnection. */
const BURST_MS = 5000

const HEALTH_LABELS: Record<Health, string> = {
  paused: '已暂停',
  connecting: '连接中',
  connected: '已连接',
  empty: '无工具',
  failed: '失败',
  detached: '未挂载',
}

/** Interpret one row's raw fields as a single status. */
function healthOf(server: McpServer): Health {
  if (!server.enabled) return 'paused'
  if (server.error !== null) return 'failed'
  switch (server.phase) {
    case 'active':
      return server.toolCount > 0 ? 'connected' : 'empty'
    case 'failed':
      return 'failed'
    case null:
      return 'detached'
    default:
      return 'connecting'
  }
}

/** True while any enabled server is worth polling quickly for. */
function settling(servers: readonly McpServer[]): boolean {
  return servers.some(server => server.enabled && SETTLING.has(server.phase))
}

/** How a server is reached, split so the transport can be tagged separately. */
function endpointParts(server: McpServer): { tag: string; body: string } {
  if (server.transport === 'stdio') {
    return {
      tag: 'stdio',
      body: [server.command, ...server.args].filter(part => part.length > 0).join(' '),
    }
  }
  return { tag: 'http', body: server.url }
}

/** From this many tools up, an unfolded list gets a filter box. */
const FILTER_FROM = 8

/** Render the live MCP status list and its controls. */
export function McpPanel(): ReactNode {
  const root = useRef<HTMLDivElement | null>(null)
  const burstUntil = useRef(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [reload, setReload] = useState(0)
  const [editor, setEditor] = useState<{ server: McpServer | null; epoch: number } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<McpServer | null>(null)
  const [diagnosis, setDiagnosis] = useState<Record<string, string>>({})
  const [diagnosing, setDiagnosing] = useState<string | null>(null)
  // One query per server, kept here so folding a card away does not lose it.
  const [filters, setFilters] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<void> => {
      // The section keeps an unselected tab mounted, so a hidden panel must go
      // quiet instead of polling behind the user's back.
      const element = root.current
      if (element === null || element.closest('[hidden]') !== null) {
        timer = setTimeout(() => { void run() }, IDLE_MS)
        return
      }
      try {
        const next = await readMcpState()
        if (cancelled) return
        setState({ status: 'ready', state: next })
        const fast = settling(next.servers) || Date.now() < burstUntil.current
        timer = setTimeout(() => { void run() }, fast ? FAST_MS : IDLE_MS)
      } catch (error) {
        if (cancelled) return
        // A poll that fails once is not worth throwing away a good list for;
        // only a first load with nothing behind it shows the failure.
        const message = error instanceof Error ? error.message : String(error)
        setState(current => current.status === 'ready' ? current : { status: 'error', message })
        timer = setTimeout(() => { void run() }, IDLE_MS)
      }
    }
    void run()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [reload])

  const apply = (next: McpState): void => {
    setState({ status: 'ready', state: next })
    burstUntil.current = Date.now() + BURST_MS
  }

  const act = async (key: string, work: () => Promise<McpState>): Promise<void> => {
    setBusy(key)
    setActionError(null)
    burstUntil.current = Date.now() + BURST_MS
    try {
      apply(await work())
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const runDiagnosis = async (serverName: string): Promise<void> => {
    setDiagnosing(serverName)
    setActionError(null)
    try {
      const result = await diagnoseMcp(serverName)
      setDiagnosis(current => ({ ...current, [serverName]: result.detail }))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDiagnosing(null)
    }
  }

  const toggleExpanded = (serverName: string): void => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(serverName)) next.delete(serverName)
      else next.add(serverName)
      return next
    })
  }

  const servers = state.status === 'ready' ? state.state.servers : []
  const loadError = state.status === 'ready' ? state.state.loadError : null
  const toolTotal = servers.reduce((sum, server) => sum + server.toolCount, 0)
  const troubled = servers.filter((server) => {
    const health = healthOf(server)
    return health === 'failed' || health === 'empty'
  }).length

  return (
    <div className="dsx-mcp" ref={root}>
      <div className="dsx-mcp-toolbar">
        <span className="dsx-mcp-title">MCP 服务器</span>
        {servers.length > 0 ? (
          <span className="dsx-mcp-stats">
            {`${String(servers.length)} 台`}
            <span className="dsx-mcp-sep">·</span>
            {`${String(toolTotal)} 个工具`}
            {troubled > 0 ? (
              <>
                <span className="dsx-mcp-sep">·</span>
                <span className="dsx-mcp-summaryWarn">{`${String(troubled)} 台有异常`}</span>
              </>
            ) : null}
          </span>
        ) : null}
        <span className="dsx-mcp-filler" />
        <IconAction
          label="刷新"
          icon={<IconRefreshOutline16 />}
          onClick={() => { setReload(value => value + 1) }}
        />
        <IconAction
          label="添加服务器"
          tone="accent"
          icon={<IconPlusOutline16 />}
          onClick={() => { setEditor({ server: null, epoch: Date.now() }) }}
        />
      </div>

      {state.status === 'loading' ? <p className="dsx-mcp-status">正在读取…</p> : null}
      {state.status === 'error' ? (
        <p className="dsx-mcp-error" role="alert">{state.message}</p>
      ) : null}
      {loadError !== null ? (
        <p className="dsx-mcp-error" role="alert">配置读不了:{loadError}</p>
      ) : null}
      {actionError !== null ? <p className="dsx-mcp-error" role="alert">{actionError}</p> : null}

      {state.status === 'ready' && servers.length === 0 && loadError === null ? (
        <div className="dsx-mcp-empty">
          <span className="dsx-mcp-emptyMark" aria-hidden="true">MCP</span>
          <p className="dsx-mcp-emptyTitle">还没有服务器</p>
          <p className="dsx-mcp-emptyHint">
            点右上角的加号添加一台,连上之后它提供的工具就能被模型调用
          </p>
        </div>
      ) : null}

      {servers.length > 0 ? (
        <ul className="dsx-mcp-list">
          {servers.map((server) => {
            const health = healthOf(server)
            const expanded = open.has(server.serverName)
            const working = busy === server.serverName
            const note = diagnosis[server.serverName]
            const parts = endpointParts(server)
            const query = (filters[server.serverName] ?? '').trim().toLowerCase()
            const shown = query.length === 0
              ? server.tools
              : server.tools.filter(tool =>
                tool.name.toLowerCase().includes(query)
                || tool.description.toLowerCase().includes(query))
            return (
              <li
                key={server.serverName}
                className="dsx-mcp-card"
                data-server={server.serverName}
                data-health={health}
              >
                <div className="dsx-mcp-row">
                  <span className="dsx-mcp-dot" data-health={health} title={HEALTH_LABELS[health]} />
                  <button
                    type="button"
                    className="dsx-mcp-name"
                    aria-expanded={server.toolCount > 0 ? expanded : undefined}
                    disabled={server.toolCount === 0}
                    onClick={() => { toggleExpanded(server.serverName) }}
                  >
                    <span className="dsx-mcp-caret" aria-hidden="true">
                      {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                    </span>
                    {server.serverName}
                  </button>
                  <span className="dsx-mcp-badge" data-health={health}>{HEALTH_LABELS[health]}</span>
                  <span className="dsx-mcp-badge" data-kind="count">{server.toolCount} 个工具</span>
                  <span className="dsx-mcp-filler" />
                  <span className="dsx-mcp-actions">
                    <IconAction
                      label="重连"
                      disabled={working || !server.enabled}
                      icon={<IconRefreshOutline16 />}
                      onClick={() => { void act(server.serverName, () => reconnectMcp(server.serverName)) }}
                    />
                    <IconAction
                      label={server.enabled ? '暂停' : '恢复'}
                      disabled={working}
                      icon={server.enabled ? <IconPauseOutline16 /> : <IconPlayOutline16 />}
                      onClick={() => {
                        void act(server.serverName, () => setMcpEnabled(server.serverName, !server.enabled))
                      }}
                    />
                    <IconAction
                      label="编辑"
                      icon={<IconEditOutline16 />}
                      onClick={() => { setEditor({ server, epoch: Date.now() }) }}
                    />
                    <IconAction
                      label="删除"
                      tone="danger"
                      icon={<IconTrashOutline16 />}
                      onClick={() => { setPendingDelete(server) }}
                    />
                  </span>
                </div>
                <p className="dsx-mcp-endpoint" title={`${parts.tag} · ${parts.body}`}>
                  <span className="dsx-mcp-transport">{parts.tag}</span>
                  <span className="dsx-mcp-endpointBody">{parts.body}</span>
                </p>
                {server.error !== null ? (
                  <p className="dsx-mcp-note" data-tone="error">启动失败:{server.error}</p>
                ) : null}
                {health === 'empty' ? (
                  <div className="dsx-mcp-noteRow" data-tone="warn">
                    <span>连上了,但没有工具。</span>
                    <IconAction
                      label="诊断"
                      disabled={diagnosing === server.serverName}
                      icon={<IconSearchOutline16 size={12} />}
                      onClick={() => { void runDiagnosis(server.serverName) }}
                    />
                  </div>
                ) : null}
                {note !== undefined ? (
                  <p className="dsx-mcp-note" data-tone="probe">{note}</p>
                ) : null}
                {expanded ? (
                  <div className="dsx-mcp-toolsWrap">
                    {server.tools.length > FILTER_FROM ? (
                      <label className="dsx-mcp-toolsFilter">
                        <IconSearchOutline16 size={13} />
                        <input
                          className="dsx-mcp-toolsSearch"
                          value={filters[server.serverName] ?? ''}
                          placeholder={`在 ${String(server.tools.length)} 个工具里筛选`}
                          onChange={(event) => {
                            const next = event.currentTarget.value
                            setFilters(current => ({ ...current, [server.serverName]: next }))
                          }}
                        />
                      </label>
                    ) : null}
                    {shown.length === 0 ? (
                      <p className="dsx-mcp-toolsNone">没有名字或说明里带「{query}」的工具。</p>
                    ) : (
                      <ul className="dsx-mcp-tools">
                        {shown.map(tool => (
                          <li key={tool.name} className="dsx-mcp-tool">
                            <span className="dsx-mcp-toolName">{tool.name}</span>
                            {tool.description.length > 0 ? (
                              <span className="dsx-mcp-toolDesc">{tool.description}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {/* Remounted per open so the form always starts from what is stored now. */}
      {editor !== null ? (
        <McpEditor
          key={String(editor.epoch)}
          server={editor.server}
          onClose={() => { setEditor(null) }}
          onSaved={() => {
            setEditor(null)
            setDiagnosis({})
            burstUntil.current = Date.now() + BURST_MS
            setReload(value => value + 1)
          }}
        />
      ) : null}

      <Modal
        open={pendingDelete !== null}
        onClose={() => { setPendingDelete(null) }}
        title={`删除 ${pendingDelete?.serverName ?? ''}?`}
        closeLabel="关闭"
        className="dsx-mcp-dialog dsx-mcp-dialog"
        footer={(
          <>
            <Button variant="outline" disabled={busy !== null} onClick={() => { setPendingDelete(null) }}>
              取消
            </Button>
            <Button
              variant="primary"
              className="dsx-mcp-dangerFill dsx-mcp-dangerFill"
              disabled={busy !== null}
              onClick={() => {
                const target = pendingDelete
                if (target === null) return
                void act(target.serverName, () => deleteMcpServer(target.serverName))
                  .then(() => { setPendingDelete(null) })
              }}
            >
              删除
            </Button>
          </>
        )}
      >
        <p className="dsx-mcp-hint">
          {pendingDelete?.transport === 'stdio'
            ? '子进程会一起停。'
            : '地址和请求头一起删掉,没法恢复。'}
        </p>
      </Modal>
    </div>
  )
}
