/**
 * Three native DSH settings cards replicated in the desktop manager tab.
 *
 * DSH's own ui-settings-plugins package renders these through a slot-based card
 * framework (CardForm + SnapshotStore + PluginCard). That framework lives behind
 * the bundle purity gate — a plugin may not value-import another plugin's code —
 * so the manager tab ships its own equivalent: a staged form model that writes
 * on save, reads through the settings scope, and addresses the web-search API
 * key through the credentials domain (write-only, never surfaced).
 *
 * Field types are limited to numberField and textField (section fields) plus
 * secret (write-only credentials). The DSH originals also carry boolean/select,
 * but the three cards reproduced here use none of those. apiKeyEnv is a text
 * section field rendered hidden (type=password) because it names the env var
 * that holds the real key.
 *
 * API signatures are verified against the harness source at:
 *   packages/client/ui-settings-plugins/src/client/card-form.ts
 *   packages/client/ui-settings/src/client/settings-scope.ts
 *   packages/host/apiproxy/src/api/credentials.ts
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
// --- Inline service types ------------------------------------------------
// The real contracts live in dsh-client-runtime, dsh-client-connection, and
// dsh-host-apiproxy — none of which are platform externals (see
// vite.plugins.config.ts PLATFORM list), so their types cannot be imported at
// build time. The shapes here mirror only the surfaces the cards touch.

export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

export interface SettingsScopeBinder {
  bind<T>(spec: { namespace: string }): SettingsScope<T>
}

interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

/** RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }. */
type RpcResponse<T> = { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }

export interface CredentialsApi {
  describe(request: { refs: string[] }): Promise<RpcResponse<{ credentials: Record<string, CredentialView> }>>
  set(request: { ref: string; value: string }): Promise<RpcResponse<Record<string, never>>>
  unset(request: { ref: string }): Promise<RpcResponse<Record<string, never>>>
}

export interface ConnectionHandle {
  api: { credentials: CredentialsApi }
  isLoopback: boolean
}

/** Remote service face — only $on is used here (for credentials/updated). */
export interface RemoteService {
  $on(event: string, listener: (...args: unknown[]) => void): () => void
}

// --- Field specs ---------------------------------------------------------

type FieldType = 'number' | 'text' | 'password' | 'secret'

interface NativeField {
  field: string
  label: string
  type: FieldType
  hint?: string
}

/**
 * Format a stored value as draft text; the empty string when the section
 * carries none. Mirrors numberField/textField in card-form.ts. The 'password'
 * type shares text's format/parse logic — it only differs in input rendering.
 */
function formatValue(type: FieldType, value: unknown): string {
  if (type === 'number') return typeof value === 'number' ? String(value) : ''
  return typeof value === 'string' ? value : ''
}

/**
 * Parse draft text into a write or undefined (invalid). Mirrors
 * numberField/textField parse in card-form.ts.
 */
function parseValue(
  type: FieldType,
  text: string,
): { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'clear' }
  if (type === 'number') {
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
  }
  return { kind: 'set', value: trimmed }
}

// --- Staged edit model ---------------------------------------------------

interface StagedEdit {
  text: string
  /** True when the user clicked "恢复默认" — the write is always unset. */
  clear: boolean
}

interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

// --- Card props ----------------------------------------------------------

export interface NativeCardServices {
  settingsScope: SettingsScopeBinder
  connection: ConnectionHandle
  remote: RemoteService
}

interface NativeCardProps {
  namespace: string
  title: string
  description: string
  fields: NativeField[]
  services: NativeCardServices
  /**
   * When this card has a secret field, this function returns the credential
   * reference the section currently names (apiKeyEnv value, or a default).
   * Undefined when the card has no secret field.
   */
  secretRef?: (snapshot: SettingsScopeSnapshot<Record<string, unknown>>) => string
}

// --- The card component --------------------------------------------------

export function NativeCard({
  namespace, title, description, fields, services, secretRef,
}: NativeCardProps): React.ReactElement | null {
  // Bind the scope once — the scope controller is owned by the plugin context
  // (ctx.effect inside SettingsScopeBinder.bind), so it outlives the component
  // and is disposed on plugin unload, not on unmount.
  const scope = useMemo(
    () => services.settingsScope.bind<Record<string, unknown>>({ namespace }),
    [services.settingsScope, namespace],
  )

  const [staged, setStaged] = useState<Map<string, StagedEdit>>(new Map())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [, bump] = useState(0)

  // Credential state for the secret field (web-search apiKey).
  const [credential, setCredential] = useState<{ ref: string; configured: boolean; writable: boolean }>({
    ref: '', configured: false, writable: true,
  })

  // Subscribe to scope changes — the scope publishes on settings-document
  // updates and connection resets, so the card re-renders with fresh values.
  useEffect(() => scope.subscribe(() => bump(v => v + 1)), [scope])

  const snapshot = scope.getSnapshot()

  const shell: CardShell = useMemo(() => {
    let dirty = false
    let invalid = false
    for (const [field, draft] of staged) {
      const spec = fields.find(f => f.field === field)
      if (spec === undefined) continue
      if (spec.type === 'secret') {
        if (draft.text.trim() !== '') dirty = true
      } else if (draft.clear) {
        if (stored(snapshot, field)) dirty = true
      } else {
        const sectionValue = (snapshot.value as Record<string, unknown> | undefined)?.[field]
        if (draft.text !== formatValue(spec.type, sectionValue)) {
          dirty = true
          if (parseValue(spec.type, draft.text) === undefined) invalid = true
        }
      }
    }
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty,
      invalid,
      saving,
      failed,
    }
  }, [fields, staged, snapshot, saving, failed])

  // --- Credential reading (web-search only) ------------------------------

  const readCredential = useCallback(async (ref: string): Promise<void> => {
    if (ref === '') return
    let response: RpcResponse<{ credentials: Record<string, CredentialView> }>
    try {
      response = await services.connection.api.credentials.describe({ refs: [ref] })
    } catch {
      // The card stays usable without this; the badge reports the last state.
      return
    }
    if (!response.result.ok) return
    const view = response.result.value.credentials[ref]
    setCredential({
      ref,
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
    })
  }, [services.connection.api])

  // Read the credential on mount and whenever the ref (apiKeyEnv) changes.
  const currentRef = secretRef !== undefined ? secretRef(snapshot) : ''
  useEffect(() => {
    if (secretRef === undefined) return
    if (currentRef !== credential.ref) {
      setCredential({ ref: currentRef, configured: false, writable: true })
    }
    void readCredential(currentRef)
  }, [currentRef, secretRef, readCredential]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to credentials/updated so a key written elsewhere (Models page)
  // refreshes the badge without a settings-document round-trip.
  useEffect(() => {
    if (secretRef === undefined) return
    return services.remote.$on('credentials/updated', (...args) => {
      const ref = args[0] as string
      if (ref === currentRef) void readCredential(ref)
    })
  }, [services.remote, secretRef, currentRef, readCredential])

  // --- Actions -----------------------------------------------------------

  const edit = useCallback((field: string, text: string): void => {
    setStaged(prev => {
      const next = new Map(prev)
      next.set(field, { text, clear: false })
      return next
    })
    setFailed(false)
  }, [])

  const resetField = useCallback((field: string): void => {
    const spec = fields.find(f => f.field === field)
    if (spec === undefined) return
    const baseValue = (snapshot.base as Record<string, unknown> | undefined)?.[field]
    setStaged(prev => {
      const next = new Map(prev)
      next.set(field, { text: formatValue(spec.type, baseValue), clear: true })
      return next
    })
    setFailed(false)
  }, [fields, snapshot])

  const discard = useCallback((): void => {
    if (staged.size === 0 && !failed) return
    setStaged(new Map())
    setFailed(false)
  }, [staged.size, failed])

  const save = useCallback(async (): Promise<void> => {
    if (staged.size === 0 || saving) return
    // Validate first — no writes if any section field is invalid.
    for (const [field, draft] of staged) {
      const spec = fields.find(f => f.field === field)
      if (spec === undefined) continue
      if (spec.type !== 'secret' && !draft.clear) {
        if (parseValue(spec.type, draft.text) === undefined) return
      }
    }
    setSaving(true)
    setFailed(false)
    let landed = true
    for (const [field, draft] of staged) {
      const spec = fields.find(f => f.field === field)
      if (spec === undefined) continue
      try {
        if (spec.type === 'secret') {
          const value = draft.text.trim()
          if (value !== '') {
            const ref = secretRef !== undefined ? secretRef(snapshot) : ''
            if (ref !== '') {
              const response = await services.connection.api.credentials.set({ ref, value })
              if (!response.result.ok) { landed = false; break }
            }
          }
        } else if (draft.clear) {
          await scope.unset(field)
        } else {
          const write = parseValue(spec.type, draft.text)
          if (write === undefined) { landed = false; break }
          if (write.kind === 'clear') {
            await scope.unset(field)
          } else {
            await scope.set(field, write.value)
          }
        }
      } catch {
        landed = false
        break
      }
    }
    if (landed) {
      setStaged(new Map())
      // Re-read the credential so the badge reflects the new state.
      if (secretRef !== undefined) {
        void readCredential(secretRef(snapshot))
      }
    }
    setSaving(false)
    setFailed(!landed)
  }, [staged, saving, fields, scope, snapshot, secretRef, services.connection.api, readCredential])

  const clearSecret = useCallback(async (): Promise<void> => {
    const ref = secretRef !== undefined ? secretRef(snapshot) : ''
    if (ref === '') return
    try {
      const response = await services.connection.api.credentials.unset({ ref })
      if (response.result.ok) {
        void readCredential(ref)
      }
    } catch {
      // Best-effort; the badge will reflect whatever state the server is in.
    }
  }, [secretRef, snapshot, readCredential])

  // --- Render ------------------------------------------------------------

  // A card renders nothing while its namespace is unavailable: a deployment
  // that does not compose the owning plugin shows no trace of it.
  if (!shell.available) return null

  const blocked = !shell.dirty || shell.invalid || shell.saving

  const fieldStates: Record<string, FieldState> = {}
  for (const spec of fields) {
    fieldStates[spec.field] = computeFieldState(spec, staged, snapshot)
  }

  return (
    <div className="dsx-mgr-card dsx-mgr-card-inline">
      <div className="dsx-mgr-card-title">{title}</div>
      <div className="dsx-mgr-card-desc">{description}</div>
      {!shell.writable && (
        <div className="dsx-mgr-card-readonly">本部署的设置为只读。</div>
      )}
      <div className="dsx-mgr-card-fields">
        {fields.map(spec => (
          <CardField
            key={spec.field}
            spec={spec}
            state={fieldStates[spec.field]}
            credential={spec.type === 'secret' ? credential : undefined}
            disabled={!shell.writable || shell.saving}
            onEdit={(text) => { edit(spec.field, text) }}
            onReset={() => { resetField(spec.field) }}
            onClearSecret={() => { void clearSecret() }}
          />
        ))}
      </div>
      {failed && (
        <div className="dsx-mgr-card-failed">本部署没有接受这些值，已保留供你修改。</div>
      )}
      <div className="dsx-mgr-card-footer">
        <Button variant="ghost" size="sm" disabled={!shell.dirty || shell.saving} onClick={discard}>
          放弃修改
        </Button>
        <Button variant="primary" size="sm" disabled={blocked} onClick={() => { void save() }}>
          {shell.saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

// --- Field rendering -----------------------------------------------------

interface CardFieldProps {
  spec: NativeField
  state: FieldState
  credential?: { configured: boolean; writable: boolean }
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  onClearSecret: () => void
}

function CardField({
  spec, state, credential, disabled, onEdit, onReset, onClearSecret,
}: CardFieldProps): React.ReactElement {
  if (spec.type === 'secret') {
    const configured = credential?.configured ?? false
    return (
      <div className="dsx-mgr-field">
        <div className="dsx-mgr-field-head">
          <label className="dsx-mgr-field-label">{spec.label}</label>
          <span className="dsx-mgr-card-badge" data-configured={configured}>
            {configured ? '已配置' : '未配置'}
          </span>
          {configured && (
            <button
              type="button"
              className="dsx-mgr-card-clear"
              disabled={disabled || (credential?.writable === false)}
              onClick={onClearSecret}
            >
              清除
            </button>
          )}
        </div>
        <Input
          className="dsx-mgr-field-input"
          type="password"
          autoComplete="off"
          value={state.text}
          disabled={disabled || (credential?.writable === false)}
          onChange={(event) => { onEdit(event.target.value) }}
        />
        {spec.hint !== undefined && spec.hint !== '' && (
          <div className="dsx-mgr-field-hint">{spec.hint}</div>
        )}
      </div>
    )
  }

  // 'password' is a text section field rendered hidden (apiKeyEnv).
  const isHidden = spec.type === 'password'

  return (
    <div className="dsx-mgr-field">
      <div className="dsx-mgr-field-head">
        <label className="dsx-mgr-field-label">{spec.label}</label>
        {state.overridden && (
          <span className="dsx-mgr-card-badge" data-configured>
            已覆盖
          </span>
        )}
        {state.overridden && (
          <button
            type="button"
            className="dsx-mgr-card-reset"
            disabled={disabled}
            onClick={onReset}
          >
            恢复默认
          </button>
        )}
      </div>
      <Input
        className="dsx-mgr-field-input"
        type={isHidden ? 'password' : 'text'}
        inputMode={spec.type === 'number' ? 'numeric' : undefined}
        autoComplete="off"
        value={state.text}
        disabled={disabled}
        onChange={(event) => { onEdit(event.target.value) }}
      />
      {state.invalid
        ? <div className="dsx-mgr-field-hint dsx-mgr-field-invalid">请填数字；留空表示使用默认值。</div>
        : spec.hint !== undefined && spec.hint !== ''
          ? <div className="dsx-mgr-field-hint">{spec.hint}</div>
          : null}
    </div>
  )
}

// --- Form computation ----------------------------------------------------

function computeFieldState(
  spec: NativeField,
  staged: Map<string, StagedEdit>,
  snapshot: SettingsScopeSnapshot<Record<string, unknown>>,
): FieldState {
  const draft = staged.get(spec.field)
  if (spec.type === 'secret') {
    return { text: draft?.text ?? '', overridden: false, invalid: false }
  }
  if (draft === undefined) {
    const sectionValue = (snapshot.value as Record<string, unknown> | undefined)?.[spec.field]
    return {
      text: formatValue(spec.type, sectionValue),
      overridden: stored(snapshot, spec.field),
      invalid: false,
    }
  }
  if (draft.clear) {
    return { text: draft.text, overridden: false, invalid: false }
  }
  const write = parseValue(spec.type, draft.text)
  return {
    text: draft.text,
    overridden: write?.kind === 'set',
    invalid: write === undefined,
  }
}

function stored(snapshot: SettingsScopeSnapshot<unknown>, field: string): boolean {
  const user = snapshot.user as Record<string, unknown> | undefined
  return user !== undefined && Object.prototype.hasOwnProperty.call(user, field)
}

// --- Exported wrapper: all three cards -----------------------------------

const BASH_FIELDS: NativeField[] = [
  { field: 'timeoutMs', label: '命令超时（毫秒）', type: 'number', hint: '单条命令允许运行多久，超时即终止。' },
  { field: 'maxOutputBytes', label: '单流输出上限（字节）', type: 'number', hint: '超出部分会转存到临时文件，而不是被丢弃。' },
]

const AGENT_LOOP_FIELDS: NativeField[] = [
  { field: 'maxParallelToolCalls', label: '并行工具调用数', type: 'number', hint: '同一步内最多同时运行多少个可并行的调用。' },
]

const WEB_SEARCH_FIELDS: NativeField[] = [
  { field: 'baseURL', label: '接口地址', type: 'text', hint: '留空则使用提供方默认地址。' },
  { field: 'maxUses', label: '单次请求最多搜索次数', type: 'number', hint: '一次请求在必须作答前最多可以搜索多少次。' },
  { field: 'apiKeyEnv', label: 'API Key 环境变量名', type: 'password', hint: '密钥读取的环境变量名，留空使用 DEEPSEEK_API_KEY。' },
  { field: 'apiKey', label: 'API Key', type: 'secret', hint: '不写入设置文件。留空表示保持当前密钥。' },
]

const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

function webSearchRefOf(snapshot: SettingsScopeSnapshot<Record<string, unknown>>): string {
  const declared = snapshot.value?.apiKeyEnv
  return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}

export interface NativeConfigCardsProps {
  services: NativeCardServices
}

export function NativeConfigCards({ services }: NativeConfigCardsProps): React.ReactElement {
  return (
    <ul className="dsx-mgr-cards">
      <NativeCard
        namespace="shell"
        title="终端"
        description="限制 agent 运行的每一条命令。"
        fields={BASH_FIELDS}
        services={services}
      />
      <NativeCard
        namespace="agent-loop"
        title="Agent 循环"
        description="Agent 如何派发工具调用。"
        fields={AGENT_LOOP_FIELDS}
        services={services}
      />
      <NativeCard
        namespace="web-search-deepseek"
        title="网页搜索"
        description="DeepSeek 搜索提供方。"
        fields={WEB_SEARCH_FIELDS}
        services={services}
        secretRef={webSearchRefOf}
      />
    </ul>
  )
}

// --- Native config registry ---------------------------------------------
// Maps a native plugin's module name (as reported by pluginInventory.list())
// to the staged-edit config card to render when that row is expanded inline
// inside the 原生插件 group. A row whose moduleName matches no spec renders
// no config affordance — it stays read-only. The match is a RegExp over the
// full moduleName so the registry stays resilient to version/scope prefixes.

export interface NativeConfigSpec {
  match: RegExp
  namespace: string
  title: string
  description: string
  fields: NativeField[]
  secretRef?: (snapshot: SettingsScopeSnapshot<Record<string, unknown>>) => string
}

export const NATIVE_CONFIG_SPECS: NativeConfigSpec[] = [
  { match: /dsh-shell-env/, namespace: 'shell', title: '终端', description: '限制 agent 运行的每一条命令。', fields: BASH_FIELDS },
  { match: /dsh-agent-loop/, namespace: 'agent-loop', title: 'Agent 循环', description: 'Agent 如何派发工具调用。', fields: AGENT_LOOP_FIELDS },
  { match: /dsh-web-search-deepseek/, namespace: 'web-search-deepseek', title: '网页搜索', description: 'DeepSeek 搜索提供方。', fields: WEB_SEARCH_FIELDS, secretRef: webSearchRefOf },
]

export function findNativeConfigSpec(moduleName: string): NativeConfigSpec | undefined {
  return NATIVE_CONFIG_SPECS.find(spec => spec.match.test(moduleName))
}
