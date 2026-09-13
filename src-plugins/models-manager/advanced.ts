/**
 * Advanced provider settings — the schema read behind the 渠道 page's extra
 * fields.
 *
 * The native provider card edits what every adapter shares (key, endpoint,
 * identity, model list) and leaves everything else to `settings.yaml`. Those
 * leftovers are real configuration, not internals: a route's timeout, stream
 * idle window, transport, cache retention, retry policy, headers and protocol
 * compatibility switches all live in the very same profile object the card
 * already writes to.
 *
 * Rather than hard-coding one adapter's field list — which would go stale the
 * first time an adapter ships a knob — this module reads the profile's own
 * schema node (`settings.describe` ships it as a serialized schemastery
 * envelope) and describes it as a flat field list. Keys this module does not
 * understand are reported as unsupported and left alone; nothing is guessed
 * from the key's name.
 *
 * The envelope is walked as plain data. `@deepseek-ai/dsh-client-schema-form`
 * would do the rehydrating, but it is not a platform seed word in this shell —
 * a desktop plugin may only require the words in the frozen module table — so
 * the few structural helpers needed here are re-derived locally. They are pure
 * object manipulation: reading a serialized schema needs none of schemastery's
 * validation, only its shape.
 *
 * Only the shapes a plain form can render are described: scalars, enums,
 * string lists, fixed objects (recursed), tag-discriminated object unions
 * (`retryPolicy`), and string→string maps (`headers`). A dict of heterogeneous
 * unions (`compat.chatTemplateKwargs`) has no fixed key set and is skipped.
 */

/** One `settings.mutate` op. Mirrors the wire type; the platform does not export it here. */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** One registered settings namespace, as `settings.describe` reports it. */
export interface SettingsNamespaceView {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  /** Raw user layer; a key's presence here marks it user-overridden. */
  user?: unknown
  applies: 'live' | 'restart'
  secrets: { path: string[]; set: boolean }[]
  revision: number
}

/** One configurable provider route, as `llm.providers` reports it. */
export interface ConfigurableProviderView {
  provider: string
  displayName: string
  /** Empty for a route registered outside the configurable directory. */
  settingsNs: string
  settingsPath: string[]
  active: boolean
  declared?: boolean
}

/** The wire face this panel needs. Structural, because the API packages are not platform words. */
export interface AdvancedApi {
  llm: {
    providers(request: Record<string, never>): Promise<RpcEnvelope<{ providers: ConfigurableProviderView[] }>>
  }
  settings: {
    describe(request: Record<string, never>): Promise<RpcEnvelope<{
      writable: boolean
      hasDocument: boolean
      namespaces: SettingsNamespaceView[]
    }>>
    mutate(request: {
      ns: string
      ops: SettingsPathOp[]
      expectedRevision?: number
    }): Promise<RpcEnvelope<SettingsNamespaceView>>
  }
}

/** One answer from the host: a business result, or the error it refused with. */
export interface RpcEnvelope<T> {
  result: { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
}

/** Unwrap an envelope, throwing the host's own message on refusal. */
export function unwrap<T>(envelope: RpcEnvelope<T>): T {
  if (!envelope.result.ok) throw new Error(envelope.result.error.message)
  return envelope.result.value
}

/** The UI-facing metadata a schema node carries. */
interface SchemaMeta {
  default?: unknown
  hidden?: boolean
  /** Set by `.role()`; a renderer hint, or a marker that another surface owns the field. */
  role?: string
  min?: number
  max?: number
  step?: number
}

/** One node of a rehydrated section schema, with its children already linked. */
export interface SchemaNode {
  type?: string
  meta: SchemaMeta
  value?: unknown
  dict?: Record<string, SchemaNode>
  inner?: SchemaNode
  list?: SchemaNode[]
}

/** A node as it arrives on the wire: children are uids into the envelope's map. */
type RawNode = Record<string, unknown>

/** Resolve one child slot: a uid into the map, or an already-inlined node. */
function childOf(slot: unknown, refs: Record<string, RawNode>): RawNode | undefined {
  if (typeof slot === 'number') return refs[String(slot)]
  if (typeof slot === 'object' && slot !== null) return slot as RawNode
  return undefined
}

/**
 * Link one wire node to its children. `seen` breaks the cycles a recursive
 * schema (`Schema.lazy`) would otherwise walk forever.
 */
function link(raw: RawNode, refs: Record<string, RawNode>, seen: Map<RawNode, SchemaNode>): SchemaNode {
  const cached = seen.get(raw)
  if (cached !== undefined) return cached
  const node: SchemaNode = { meta: (raw['meta'] as SchemaMeta | undefined) ?? {} }
  seen.set(raw, node)
  if (typeof raw['type'] === 'string') node.type = raw['type']
  if (raw['value'] !== undefined) node.value = raw['value']

  const dict = raw['dict']
  if (typeof dict === 'object' && dict !== null) {
    const linked: Record<string, SchemaNode> = {}
    for (const [key, slot] of Object.entries(dict as Record<string, unknown>)) {
      const child = childOf(slot, refs)
      if (child !== undefined) linked[key] = link(child, refs, seen)
    }
    node.dict = linked
  }
  const inner = childOf(raw['inner'], refs)
  if (inner !== undefined) node.inner = link(inner, refs, seen)
  const list = raw['list']
  if (Array.isArray(list)) {
    const members: SchemaNode[] = []
    for (const slot of list) {
      const member = childOf(slot, refs)
      if (member !== undefined) members.push(link(member, refs, seen))
    }
    node.list = members
  }
  return node
}

/**
 * Rehydrate the envelope `schema.toJSON()` produces: `{ uid, refs }`, where
 * every node lives in `refs` and its children are uids into the same map.
 */
export function schemaRoot(serialized: unknown): SchemaNode | undefined {
  if (typeof serialized !== 'object' || serialized === null) return undefined
  const envelope = serialized as { uid?: unknown; refs?: Record<string, RawNode> }
  const refs = envelope.refs
  if (refs === undefined || typeof refs !== 'object' || refs === null) {
    // An already-linked node: accept it rather than losing the whole form.
    return link(serialized as RawNode, {}, new Map())
  }
  const root = typeof envelope.uid === 'number' ? refs[String(envelope.uid)] : undefined
  return root === undefined ? undefined : link(root, refs, new Map())
}

/** Resolve a node at a settings path (object properties, then dict entries). */
function nodeAtPath(root: SchemaNode | undefined, path: readonly string[]): SchemaNode | undefined {
  let node = root
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object') node = node.dict?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner
    else return undefined
  }
  return node
}

/** Read a nested value by path. */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Whether the path's final key is present on its parent. */
function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  const parent = getPath(value, path.slice(0, -1))
  const key = path[path.length - 1] as string
  if (Array.isArray(parent)) return Number(key) < parent.length
  if (typeof parent !== 'object' || parent === null) return false
  return key in parent
}

/** Immutably set a nested value, materializing missing intermediates. */
function setPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path
  const key = String(head)
  const current = root[key]
  const next = rest.length === 0
    ? value
    : setPath(
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {},
      rest,
      value,
    )
  return { ...root, [key]: next }
}

/** Immutably remove a nested key, leaving branches it does not reach alone. */
export function deletePath(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = path
  const key = String(head)
  if (!Object.prototype.hasOwnProperty.call(root, key)) return root
  if (rest.length === 0) {
    const next = { ...root }
    delete next[key]
    return next
  }
  const current = root[key]
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return root
  return { ...root, [key]: deletePath(current as Record<string, unknown>, rest) }
}

/**
 * Fields the native card already owns. Excluding them keeps one editor per
 * value: the key reference and protocol are derived by the card's own create
 * flow (`apiKeyEnv`, `api`), and `models`/`modelOverrides` have a dedicated
 * row editor whose validation this form cannot reproduce.
 */
const NATIVE_OWNED = new Set(['apiKeyEnv', 'api', 'displayName', 'baseURL', 'models', 'modelOverrides'])

/** A schema node the form can render, tagged by the widget it needs. */
export type FieldSpec =
  | { kind: 'boolean'; key: string; node: SchemaNode }
  | { kind: 'number'; key: string; node: SchemaNode }
  | { kind: 'string'; key: string; node: SchemaNode }
  | { kind: 'stringlist'; key: string; node: SchemaNode }
  | { kind: 'enum'; key: string; node: SchemaNode; options: readonly string[] }
  | { kind: 'multienum'; key: string; node: SchemaNode; options: readonly string[] }
  | { kind: 'textmap'; key: string; node: SchemaNode }
  | { kind: 'group'; key: string; node: SchemaNode; fields: readonly FieldSpec[] }
  | {
    kind: 'variant'
    key: string
    node: SchemaNode
    modes: readonly string[]
    fields: Readonly<Record<string, readonly FieldSpec[]>>
  }

/** A lazy wrapper hides the real node behind `inner` until it is first resolved. */
function deref(node: SchemaNode): SchemaNode | undefined {
  if (node.type !== 'lazy') return node
  const inner = node.inner
  return inner !== undefined && inner.type !== undefined ? deref(inner) : undefined
}

/**
 * The string values a node accepts, when it accepts a closed set of them.
 * `union(const…)` from a literal list and a bare `const` are the two spellings
 * schemastery produces; anything else is not an enum.
 */
function constOptions(node: SchemaNode): string[] | undefined {
  if (node.type === 'const') {
    return node.value === undefined || node.value === null ? undefined : [String(node.value)]
  }
  if (node.type !== 'union' || node.list === undefined || node.list.length === 0) return undefined
  const options: string[] = []
  for (const member of node.list) {
    if (member.type !== 'const' || member.value === undefined || member.value === null) return undefined
    options.push(String(member.value))
  }
  return options
}

/**
 * A union of object variants discriminated by a `mode` const — how
 * `retryPolicy` spells "normal or always". Each variant's own fields are
 * described separately, because switching modes swaps the whole sub-form.
 */
function variantOf(
  node: SchemaNode,
): { modes: string[]; fields: Record<string, FieldSpec[]> } | undefined {
  if (node.list === undefined) return undefined
  const modes: string[] = []
  const fields: Record<string, FieldSpec[]> = {}
  for (const member of node.list) {
    const modeNode = member.dict?.['mode']
    if (member.dict === undefined || modeNode === undefined || modeNode.type !== 'const') return undefined
    const mode = String(modeNode.value)
    modes.push(mode)
    fields[mode] = fieldsUnder(member, new Set(['mode']))
  }
  return modes.length === 0 ? undefined : { modes, fields }
}

/** Describe one child node, or `undefined` when no widget fits it. */
function specOf(key: string, raw: SchemaNode): FieldSpec | undefined {
  const node = deref(raw)
  if (node === undefined) return undefined
  // `hidden` is the schema's own "do not render this", and a `role` marks a
  // field another surface owns (`credential-ref` is the native card's key
  // reference); `slider` is only a widget hint and stays renderable.
  if (node.meta.hidden === true) return undefined
  const role = node.meta.role
  if (role !== undefined && role !== 'slider') return undefined
  switch (node.type) {
    case 'boolean':
      return { kind: 'boolean', key, node }
    case 'number':
    case 'natural':
    case 'percent':
      return { kind: 'number', key, node }
    case 'string':
      return { kind: 'string', key, node }
    case 'const': {
      const options = constOptions(node)
      return options === undefined ? undefined : { kind: 'enum', key, node, options }
    }
    case 'union': {
      const options = constOptions(node)
      if (options !== undefined) return { kind: 'enum', key, node, options }
      const variant = variantOf(node)
      return variant === undefined ? undefined : { kind: 'variant', key, node, ...variant }
    }
    case 'array': {
      const inner = node.inner === undefined ? undefined : deref(node.inner)
      if (inner === undefined) return undefined
      const options = constOptions(inner)
      if (options !== undefined) return { kind: 'multienum', key, node, options }
      return inner.type === 'string' ? { kind: 'stringlist', key, node } : undefined
    }
    case 'object':
      return { kind: 'group', key, node, fields: fieldsUnder(node, EMPTY_KEYS) }
    case 'dict': {
      const inner = node.inner === undefined ? undefined : deref(node.inner)
      return inner?.type === 'string' ? { kind: 'textmap', key, node } : undefined
    }
    default:
      return undefined
  }
}

const EMPTY_KEYS: ReadonlySet<string> = new Set()

/** Describe every renderable property of an object node, in schema order. */
function fieldsUnder(node: SchemaNode, skip: ReadonlySet<string>): FieldSpec[] {
  const dict = node.dict
  if (node.type !== 'object' || dict === undefined) return []
  const specs: FieldSpec[] = []
  for (const key of Object.keys(dict)) {
    if (skip.has(key)) continue
    const spec = specOf(key, dict[key] as SchemaNode)
    if (spec !== undefined) specs.push(spec)
  }
  return specs
}

/** The advanced fields of one provider profile, in the schema's own order. */
export function profileFields(root: SchemaNode | undefined, settingsPath: readonly string[]): FieldSpec[] {
  const node = nodeAtPath(root, settingsPath)
  return node === undefined ? [] : fieldsUnder(node, NATIVE_OWNED)
}

/** The profile object a descriptor carries in its raw user layer, as a draft. */
export function draftOf(namespace: SettingsNamespaceView, settingsPath: readonly string[]): Record<string, unknown> {
  const subtree = getPath(namespace.user, settingsPath)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
  return structuredClone(subtree) as Record<string, unknown>
}

export { getPath, hasPath, setPath }

/**
 * The minimal path ops carrying `after` over `before`. Mirrors the native
 * editor's rule: only top-level keys of the addressed subtree are compared, so
 * an array is always written whole and a path never names an index — the host
 * resolves an op path through plain objects only, and an index there would
 * replace the array with an object.
 */
export function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOp[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOp[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

/** Field labels, keyed by dotted path with a last-segment fallback. */
const LABELS: Record<string, string> = {
  // Shared by both adapter families.
  reasoningEffort: '推理强度',
  reasoning: '推理强度',
  thinking: '思考模式',
  maxTokens: '最大输出 tokens',
  defaultMaxTokens: '默认最大输出 tokens',
  defaultContextWindow: '默认上下文窗口',
  defaultInput: '默认输入模态',
  timeoutMs: '请求超时',
  websocketConnectTimeoutMs: 'WebSocket 连接超时',
  streamIdleTimeoutMs: '流空闲超时',
  maxRequestImageBytes: '单张图片上限',
  cacheRetention: '提示缓存保留',
  transport: '传输方式',
  headers: '附加请求头',
  retryPolicy: '重试策略',
  compat: '协议兼容开关',
  thinkingBudgets: '思考预算',
  // Nested.
  mode: '模式',
  maxRetries: '最大重试次数',
  retryableCodes: '可重试错误码',
  backoff: '退避',
  initialDelayMs: '初始延迟',
  maxDelayMs: '最大延迟',
  jitterRatio: '抖动比例',
  // compat switches.
  supportsStore: '支持 store 参数',
  supportsDeveloperRole: '支持 developer 角色',
  supportsReasoningEffort: '支持推理强度参数',
  supportsUsageInStreaming: '流式返回用量',
  maxTokensField: 'max_tokens 字段名',
  requiresToolResultName: '工具结果需带 name',
  requiresAssistantAfterToolResult: '工具结果后需补 assistant',
  requiresThinkingAsText: '思考需转纯文本',
  requiresReasoningContentOnAssistantMessages: 'assistant 消息需带 reasoning',
  thinkingFormat: '思考格式',
  chatTemplateKwargs: 'chat template 参数',
  supportsStrictMode: '支持 strict 模式',
  cacheControlFormat: '缓存控制格式',
  supportsLongCacheRetention: '支持长缓存',
  supportsEagerToolInputStreaming: '工具入参提前流式',
  supportsCacheControlOnTools: '工具支持缓存控制',
  supportsTemperature: '支持 temperature',
  forceAdaptiveThinking: '强制自适应思考',
  allowEmptySignature: '允许空签名',
  supportsStrictTools: '支持 strict 工具',
}

/** One-line explanations, shown under the control. */
const HINTS: Record<string, string> = {
  defaultContextWindow: '只给没声明上下文的模型兜底,不会覆盖模型自己的值。',
  defaultMaxTokens: '同上,只兜底。',
  defaultInput: '模型没写输入模态时按这个算。',
  timeoutMs: '单次请求的总超时,毫秒。留空用默认。',
  websocketConnectTimeoutMs: '只在使用 WebSocket 传输时有意义,毫秒。',
  streamIdleTimeoutMs: '一次流式读取等待超过这个时间就断开,毫秒。',
  maxRequestImageBytes: '单张图的 base64 上限,超了会把最老的图换成占位文字。',
  cacheRetention: '提示缓存的保留档位,决定服务端缓存多久。',
  transport: '跟模型服务通信的方式,auto 由服务商能力决定。',
  headers: '会附加到每个请求上;保留名由 harness 自己管,别覆盖。',
  retryPolicy: '请求失败后的重试行为。normal 只重试列出的错误码,always 一直重试。',
  compat: '协议层开关,每个字段都只对特定协议生效;设了协议不认的开关会被拒绝写入。',
  thinkingBudgets: '各档思考强度的 token 预算。',
  maxRetries: '首次请求之外最多再试几次。',
  retryableCodes: '逗号分隔。留空表示用默认那一组。',
  initialDelayMs: '第一次重试前等多久,毫秒。',
  maxDelayMs: '两次重试之间最长等多久,毫秒。',
  jitterRatio: '在延迟上叠加的随机抖动幅度,0 到 1。',
}

/** Enum option labels, keyed by field name then value. */
const OPTIONS: Record<string, string> = {
  'reasoning.off': '关闭',
  'reasoning.low': '低',
  'reasoning.medium': '中',
  'reasoning.high': '高',
  'reasoning.xhigh': '极高',
  'reasoning.max': '最大',
  'reasoningEffort.off': '关闭',
  'reasoningEffort.low': '低',
  'reasoningEffort.high': '高',
  'reasoningEffort.max': '最大',
  'thinking.enabled': '开启',
  'thinking.disabled': '关闭',
  'cacheRetention.none': '不保留',
  'cacheRetention.short': '短期',
  'cacheRetention.long': '长期',
  'transport.sse': 'SSE',
  'transport.websocket': 'WebSocket',
  'transport.websocket-cached': 'WebSocket(带缓存)',
  'transport.auto': '自动',
  'defaultInput.text': '文本',
  'defaultInput.image': '图片',
  'mode.normal': '仅可重试错误',
  'mode.always': '一直重试',
  'maxTokensField.max_tokens': 'max_tokens',
  'maxTokensField.max_completion_tokens': 'max_completion_tokens',
  'cacheControlFormat.anthropic': 'anthropic',
}

/** The label for a field, falling back to its own key when nothing is known. */
export function labelFor(path: readonly string[]): string {
  const leaf = path[path.length - 1] as string
  return LABELS[path.join('.')] ?? LABELS[leaf] ?? leaf
}

/** The hint for a field, if one was written for it. */
export function hintFor(path: readonly string[]): string | undefined {
  return HINTS[path.join('.')] ?? HINTS[path[path.length - 1] as string]
}

/** The label for one enum value. */
export function optionLabel(key: string, value: string): string {
  return OPTIONS[`${key}.${value}`] ?? value
}
