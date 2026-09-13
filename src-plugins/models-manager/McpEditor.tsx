/**
 * The MCP server editor.
 *
 * One modal for both create and edit, because the two differ only in where the
 * initial values come from — and in one respect that matters: a saved
 * credential is never handed to this page, so editing a server means the form
 * knows a value exists without knowing it, and every save has to say what to do
 * with it. That is why each field carries a kind, and why a secret row offers
 * "replace" rather than pre-filling a value it was never given.
 *
 * Laid out as one two-column grid (label column, control column) so every label
 * and every control starts on the same line, with the field list spanning both
 * columns as its own section. The bearer prefix is part of the kind picker
 * rather than a trailing checkbox: as a separate control it widened exactly the
 * rows that had it, which is what made the list read as ragged.
 *
 * Nothing is validated twice for its own sake: the Host re-checks every rule
 * here, and the checks that exist on this side exist so the user reads the
 * problem next to the field that has it instead of as a failed request.
 */

import { useState, type ReactNode } from 'react'
import {
  Button, IconCloseOutline16, IconEditOutline16, IconPlusOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  saveMcpServer,
  type FieldKind, type McpServer, type McpTransport, type ServerDraft,
} from './mcp.ts'
import { Chooser, IconAction, type Choice } from './controls.tsx'

/** Transport picker options. */
const TRANSPORTS: readonly Choice<McpTransport>[] = [
  { value: 'streamable-http', label: 'HTTP 地址' },
  { value: 'stdio', label: '本地命令' },
]

/**
 * How one field's value is stored and sent. `secret` and `bearer` both keep the
 * value out of the page; `bearer` additionally adds the `Bearer ` scheme on the
 * way in, which is what most token-protected endpoints expect.
 */
type FieldShape = 'text' | 'secret' | 'bearer'

const SHAPES: readonly Choice<FieldShape>[] = [
  { value: 'text', label: '文本' },
  { value: 'secret', label: '密钥' },
  { value: 'bearer', label: 'Bearer' },
]

/** One editable field row. */
interface FieldRow {
  /** Stable key: the name may be edited, and a row must not be re-created by it. */
  key: string
  name: string
  shape: FieldShape
  /** Text rows: the stored value. Secret rows: only what the user has just typed. */
  value: string
  /** The Host already holds a value for this name. */
  set: boolean
  /** Secret rows: keep the stored value instead of replacing it. */
  keep: boolean
}

/** The whole form. */
interface Draft {
  serverName: string
  enabled: boolean
  transport: McpTransport
  command: string
  argsText: string
  cwd: string
  url: string
  timeoutText: string
  fields: FieldRow[]
}

let rowSeq = 0

/** A blank field row. */
function emptyRow(): FieldRow {
  rowSeq += 1
  return { key: `row-${String(rowSeq)}`, name: '', shape: 'text', value: '', set: false, keep: true }
}

/** The shape a stored field describes. */
function shapeOf(field: { kind: FieldKind; bearer: boolean }): FieldShape {
  if (field.kind === 'text') return 'text'
  return field.bearer ? 'bearer' : 'secret'
}

/** The form as one stored server describes it. */
function draftOf(server: McpServer | null): Draft {
  if (server === null) {
    return {
      serverName: '',
      enabled: true,
      transport: 'streamable-http',
      command: '',
      argsText: '',
      cwd: '',
      url: '',
      timeoutText: '',
      fields: [],
    }
  }
  return {
    serverName: server.serverName,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join('\n'),
    cwd: server.cwd,
    url: server.url,
    timeoutText: String(server.toolCallTimeoutMs),
    fields: server.fields.map((field) => {
      rowSeq += 1
      return {
        key: `row-${String(rowSeq)}`,
        name: field.name,
        shape: shapeOf(field),
        // The Host sends a plain field's value back and withholds a secret's,
        // so this is the stored string for one and empty for the other — which
        // is exactly what the row should start out showing either way.
        value: field.value,
        set: field.set,
        keep: true,
      }
    }),
  }
}

/** Turn the form into the request, or throw with the first thing wrong with it. */
function toRequest(draft: Draft, editing: McpServer | null): ServerDraft {
  const serverName = draft.serverName.trim()
  if (serverName.length === 0) throw new Error('给这台服务器起个名字。')
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error('名字只能用字母、数字、下划线和短横线,最长 32 个字符。它也是工具名的前缀。')
  }
  const seen = new Set<string>()
  const fields = draft.fields
    .filter(row => row.name.trim().length > 0 || row.value.length > 0)
    .map((row) => {
      const name = row.name.trim()
      if (name.length === 0) throw new Error('有一行字段没写名字。')
      if (seen.has(name)) throw new Error(`字段「${name}」写了两遍。`)
      seen.add(name)
      const kind: FieldKind = row.shape === 'text' ? 'text' : 'secret'
      // A text field is sent as-is, so an empty one is not a value the user
      // means to store — and for a field the Host already holds it would mean
      // blanking it, which is the one thing this form must not do by accident.
      if (kind === 'text' && row.value.length === 0) {
        throw new Error(`「${name}」是文本类型,得填个值;要删掉它就用这一行右边的垃圾桶。`)
      }
      if (kind === 'secret' && !row.keep && row.value.length === 0) {
        throw new Error(`「${name}」是密钥类型,要么填一个新值,要么点「已设置」旁边的按钮改回原值。`)
      }
      if (kind === 'secret' && row.keep && !row.set) {
        throw new Error(`「${name}」标成了密钥但本机没存过它的值,请直接填一个内容。`)
      }
      return {
        group: (draft.transport === 'stdio' ? 'env' : 'headers') as ServerDraft['fields'][number]['group'],
        name,
        kind,
        ...(kind === 'secret' && row.keep
          ? { keep: true }
          : { value: row.value, keep: false }),
        ...(kind === 'secret' ? { bearer: row.shape === 'bearer' } : {}),
      }
    })
  const timeout = Number.parseInt(draft.timeoutText.trim(), 10)
  const common = {
    serverName,
    enabled: draft.enabled,
    fields,
    ...(Number.isFinite(timeout) && timeout > 0 ? { toolCallTimeoutMs: timeout } : {}),
  }
  const renamed = editing !== null && editing.serverName !== serverName
    ? { fromServerName: editing.serverName }
    : {}
  if (draft.transport === 'stdio') {
    return {
      ...common,
      ...renamed,
      transport: 'stdio',
      command: draft.command,
      args: draft.argsText.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0),
      cwd: draft.cwd,
    }
  }
  return { ...common, ...renamed, transport: 'streamable-http', url: draft.url }
}

/** One labelled control of the surrounding grid. */
function Field({ label, htmlFor, children }: {
  label: string
  htmlFor?: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <>
      <label className="dsx-mcp-formLabel" htmlFor={htmlFor}>{label}</label>
      <div className="dsx-mcp-formBody">{children}</div>
    </>
  )
}

/** Render the create/edit form for one server. */
export function McpEditor({ server, onClose, onSaved }: {
  /** The server being edited, or null to create one. */
  server: McpServer | null
  onClose: () => void
  /** Called after a save the Host accepted. */
  onSaved: () => void
}): ReactNode {
  const [draft, setDraft] = useState<Draft>(() => draftOf(server))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const patch = (change: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...change }))
  }

  const patchRow = (key: string, change: Partial<FieldRow>): void => {
    setDraft(current => ({
      ...current,
      fields: current.fields.map(row => (row.key === key ? { ...row, ...change } : row)),
    }))
  }

  const submit = async (): Promise<void> => {
    setError(null)
    setSaving(true)
    try {
      await saveMcpServer(toRequest(draft, server))
      onSaved()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  const isStdio = draft.transport === 'stdio'
  const groupLabel = isStdio ? '环境变量' : '请求头'

  return (
    <Modal
      open
      onClose={() => { if (!saving) onClose() }}
      title={server === null ? '添加 MCP 服务器' : `编辑 ${server.serverName}`}
      closeLabel="关闭"
      className="dsx-mcp-dialog dsx-mcp-dialog"
      footer={(
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => { void submit() }}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      <div className="dsx-mcp-form">
        <Field label="名字" htmlFor="dsx-mcp-name">
          <input
            id="dsx-mcp-name"
            className="dsx-mcp-input"
            value={draft.serverName}
            placeholder="例如 searchix"
            onChange={(event) => { patch({ serverName: event.currentTarget.value }) }}
          />
          <p className="dsx-mcp-formHint">字母、数字、下划线、短横线。</p>
        </Field>

        <span className="dsx-mcp-formLabel">传输</span>
        <div className="dsx-mcp-formBody dsx-mcp-formInline">
          <Chooser
            label="传输方式"
            className="dsx-mcp-chooserWide"
            value={draft.transport}
            options={TRANSPORTS}
            variant="dense"
            onChange={(transport) => { patch({ transport }) }}
          />
          <label className="dsx-mcp-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => { patch({ enabled: event.currentTarget.checked }) }}
            />
            启用
          </label>
        </div>

        {isStdio ? (
          <>
            <Field label="命令" htmlFor="dsx-mcp-command">
              <input
                id="dsx-mcp-command"
                className="dsx-mcp-input"
                value={draft.command}
                placeholder="例如 npx 或 C:/path/to/node.exe"
                onChange={(event) => { patch({ command: event.currentTarget.value }) }}
              />
            </Field>
            <Field label="参数" htmlFor="dsx-mcp-args">
              <textarea
                id="dsx-mcp-args"
                className="dsx-mcp-textarea"
                rows={3}
                value={draft.argsText}
                placeholder="一行一个,例如&#10;-y&#10;@modelcontextprotocol/server-filesystem"
                onChange={(event) => { patch({ argsText: event.currentTarget.value }) }}
              />
            </Field>
            <Field label="工作目录" htmlFor="dsx-mcp-cwd">
              <input
                id="dsx-mcp-cwd"
                className="dsx-mcp-input"
                value={draft.cwd}
                placeholder="可留空"
                onChange={(event) => { patch({ cwd: event.currentTarget.value }) }}
              />
            </Field>
          </>
        ) : (
          <Field label="地址" htmlFor="dsx-mcp-url">
            <input
              id="dsx-mcp-url"
              className="dsx-mcp-input"
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(event) => { patch({ url: event.currentTarget.value }) }}
            />
          </Field>
        )}

        <hr className="dsx-mcp-rule" />

        <div className="dsx-mcp-fieldsHead">
          <span className="dsx-mcp-formLabel">{groupLabel}</span>
          <span className="dsx-mcp-filler" />
          <IconAction
            label={`加一行${groupLabel}`}
            icon={<IconPlusOutline16 />}
            onClick={() => { setDraft(current => ({ ...current, fields: [...current.fields, emptyRow()] })) }}
          />
        </div>

        {draft.fields.length === 0 ? (
          <p className="dsx-mcp-formEmpty">{groupLabel}可以留空。</p>
        ) : (
          <div className="dsx-mcp-fieldList">
            {draft.fields.map(row => (
              <div key={row.key} className="dsx-mcp-fieldRow">
                <input
                  className="dsx-mcp-input"
                  value={row.name}
                  placeholder="名称"
                  onChange={(event) => { patchRow(row.key, { name: event.currentTarget.value }) }}
                />
                <Chooser
                  label={`「${row.name.trim() === '' ? '这一行' : row.name}」的值怎么存`}
                  className="dsx-mcp-chooserKind"
                  value={row.shape}
                  options={SHAPES}
                  variant="dense"
                  onChange={(shape) => {
                    // Coming from plain text, a secret row starts out as "no
                    // stored value" so the form asks for one instead of
                    // silently saving an empty replacement. Between the two
                    // secret shapes nothing is reset: switching the bearer
                    // prefix must not discard a replacement just typed.
                    patchRow(row.key, {
                      shape,
                      keep: shape === 'text' ? true : (row.shape === 'text' ? row.set : row.keep),
                    })
                  }}
                />
                <span className="dsx-mcp-fieldValue">
                  {row.shape === 'text' ? (
                    <input
                      className="dsx-mcp-input"
                      value={row.value}
                      placeholder="值"
                      onChange={(event) => { patchRow(row.key, { value: event.currentTarget.value }) }}
                    />
                  ) : row.keep && row.set ? (
                    <>
                      <span className="dsx-mcp-stored">已设置</span>
                      <IconAction
                        label="换一个新值"
                        icon={<IconEditOutline16 />}
                        onClick={() => { patchRow(row.key, { keep: false, value: '' }) }}
                      />
                    </>
                  ) : (
                    <>
                      <input
                        className="dsx-mcp-input"
                        type="password"
                        value={row.value}
                        placeholder="粘贴新值"
                        autoComplete="off"
                        onChange={(event) => { patchRow(row.key, { value: event.currentTarget.value }) }}
                      />
                      {row.set ? (
                        <IconAction
                          label="改回原值"
                          icon={<IconCloseOutline16 />}
                          onClick={() => { patchRow(row.key, { keep: true, value: '' }) }}
                        />
                      ) : null}
                    </>
                  )}
                </span>
                <IconAction
                  label="删除这一行"
                  tone="danger"
                  icon={<IconTrashOutline16 />}
                  onClick={() => {
                    setDraft(current => ({
                      ...current,
                      fields: current.fields.filter(candidate => candidate.key !== row.key),
                    }))
                  }}
                />
              </div>
            ))}
          </div>
        )}

        <hr className="dsx-mcp-rule" />

        <Field label="超时" htmlFor="dsx-mcp-timeout">
          <input
            id="dsx-mcp-timeout"
            className="dsx-mcp-input dsx-mcp-inputNarrow"
            value={draft.timeoutText}
            placeholder="毫秒,默认 60000"
            onChange={(event) => { patch({ timeoutText: event.currentTarget.value }) }}
          />
        </Field>

        {error !== null ? <p className="dsx-mcp-error dsx-mcp-formWide" role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
