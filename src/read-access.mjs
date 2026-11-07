import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fields, fail } from './router.mjs'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const ERRORS = Object.freeze({ INVALID_ARGUMENT: 'Invalid read arguments', SCOPE_DENIED: 'Read scope is not authorized', NOT_FOUND: 'Requested item is unavailable in this scope', READ_TOO_LARGE: 'Read exceeds configured limits', READ_UNAVAILABLE: 'Read service is unavailable', READ_BUSY: 'Too many concurrent reads', STALE_READ: 'Source changed; restart the query' })
const hash = value => createHash('sha256').update(value).digest('hex')
const bounded = (value, fallback, max) => {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 1 || n > max) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
  return n
}
function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
  return value
}
export function validateReadPolicy(policy) {
  fields(policy, ['workspaceIds', 'globalMemory'])
  if (!Array.isArray(policy.workspaceIds) || policy.workspaceIds.length > 256 || new Set(policy.workspaceIds).size !== policy.workspaceIds.length || policy.workspaceIds.some(id => typeof id !== 'string' || !ID.test(id)) || (policy.globalMemory !== undefined && typeof policy.globalMemory !== 'boolean')) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
  return Object.freeze({ workspaceIds: Object.freeze([...policy.workspaceIds]), globalMemory: policy.globalMemory === true })
}

// Defense in depth for copied credentials; this cannot detect arbitrary secrets in prose.
export function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]{16,}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[REDACTED]')
    .replace(/\b[a-fA-F0-9]{64}\b/g, '[REDACTED]')
}
function entryText(value) {
  return value.replace(/^\[id:[0-9a-f]{8}\]\s*/, '').replace(/\[summary:[^\]\n]*\]\s*/g, '')
}
function entrySummary(value) {
  const summary = /\[summary:([^\]\n]*)\]/.exec(value)?.[1]
  return (summary ?? entryText(value).replace(/^(?:\[[^\]\n]*\]\s*)*/, '').split('\n')[0]).slice(0, 180)
}

/** Authorization and output projection only; no model or write-capable backend methods. */
export class ReadAccess {
  constructor({ backend, policy }) {
    this.backend = backend
    this.policy = validateReadPolicy(policy)
    this.secret = randomBytes(32)
    this.active = 0
  }
  async invoke(method, args) {
    if (!['workspaces', 'sessions', 'session', 'messages', 'memorySearch', 'memoryGet'].includes(method)) return fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    if (this.active >= 4) return fail('READ_BUSY', ERRORS.READ_BUSY)
    this.active++
    try {
      const value = await this[method](args)
      const result = { content_is_untrusted: true, ...value }
      if (Buffer.byteLength(JSON.stringify(result)) > 65536) fail('READ_TOO_LARGE', ERRORS.READ_TOO_LARGE)
      return result
    } catch (error) {
      const code = Object.hasOwn(ERRORS, error?.code) ? error.code : 'READ_UNAVAILABLE'
      fail(code, ERRORS[code])
    } finally { this.active-- }
  }
  sign(value) { return createHmac('sha256', this.secret).update(value).digest('hex') }
  cursor(value) {
    const data = Buffer.from(JSON.stringify(value)).toString('base64url')
    return data + '.' + this.sign(data)
  }
  decode(cursor, context) {
    if (typeof cursor !== 'string' || cursor.length > 2048) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const [data, signature, extra] = cursor.split('.')
    if (extra !== undefined || !data || !/^[0-9a-f]{64}$/.test(signature ?? '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(this.sign(data)))) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    let value
    try { value = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) } catch { fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT) }
    if (!value || value.context !== context) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    return value
  }
  async workspace(id) {
    identifier(id)
    if (!this.policy.workspaceIds.includes(id)) fail('SCOPE_DENIED', ERRORS.SCOPE_DENIED)
    const item = await this.backend.workspace(id)
    if (!item || item.id !== id || !Array.isArray(item.sessionIds)) fail('NOT_FOUND', ERRORS.NOT_FOUND)
    if (item.sessionIds.length > 10000) fail('READ_TOO_LARGE', ERRORS.READ_TOO_LARGE)
    return item
  }
  async unchangedWorkspace(previous, sessionId) {
    const current = await this.workspace(previous.id)
    if (current.path !== previous.path || (sessionId && !current.sessionIds.includes(sessionId))) fail('STALE_READ', ERRORS.STALE_READ)
    return current
  }
  async member(workspaceId, sessionId) {
    identifier(sessionId)
    const workspace = await this.workspace(workspaceId)
    if (!workspace.sessionIds.includes(sessionId)) fail('NOT_FOUND', ERRORS.NOT_FOUND)
    const summary = (await this.backend.summaries([sessionId])).get(sessionId)
    if (!summary || summary.origin === 'subagent') fail('NOT_FOUND', ERRORS.NOT_FOUND)
    await this.unchangedWorkspace(workspace, sessionId)
    return { workspace, summary }
  }
  metadata(id, value) {
    return { session_id: id, title: redact(value.title).slice(0, 180), created_at: Number.isFinite(value.created_at) ? value.created_at : null, updated_at: Number.isFinite(value.updated_at) ? value.updated_at : null, live: value.live === true }
  }
  async workspaces(args) {
    fields(args, ['limit', 'cursor'])
    const limit = bounded(args.limit, 20, 50)
    const items = []
    for (const id of this.policy.workspaceIds) {
      const item = await this.backend.workspace(id)
      if (item?.id === id) items.push({ workspace_id: id, title: redact(item.title).slice(0, 180) })
    }
    return { ...this.page(items, args.cursor, limit, 'workspaces'), global_memory: this.policy.globalMemory, memory_scopes: this.policy.globalMemory ? ['memory', 'user', 'project', 'key', 'daily'] : ['project', 'key'], branches: 'all', archives: false }
  }
  page(items, cursor, limit, context) {
    const revision = hash(JSON.stringify(items))
    const cut = cursor === undefined ? { offset: 0, revision } : this.decode(cursor, context)
    if (cut.revision !== revision) fail('STALE_READ', ERRORS.STALE_READ)
    if (!Number.isSafeInteger(cut.offset) || cut.offset < 0 || cut.offset > items.length) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const next = cut.offset + limit
    return { items: items.slice(cut.offset, next), revision, has_more: next < items.length, next_cursor: next < items.length ? this.cursor({ context, revision, offset: next }) : null }
  }
  async sessions(args) {
    fields(args, ['workspace_id', 'limit', 'cursor'])
    const limit = bounded(args.limit, 20, 50)
    const workspace = await this.workspace(args.workspace_id)
    const summaries = await this.backend.summaries(workspace.sessionIds)
    const items = workspace.sessionIds.filter(id => summaries.has(id) && summaries.get(id).origin !== 'subagent').sort().map(id => this.metadata(id, summaries.get(id)))
    const current = await this.unchangedWorkspace(workspace)
    if (hash(JSON.stringify([...current.sessionIds].sort())) !== hash(JSON.stringify([...workspace.sessionIds].sort()))) fail('STALE_READ', ERRORS.STALE_READ)
    return this.page(items, args.cursor, limit, 'sessions:' + workspace.id)
  }
  async session(args) {
    fields(args, ['workspace_id', 'session_id'])
    const { summary } = await this.member(args.workspace_id, args.session_id)
    return this.metadata(args.session_id, summary)
  }
  async messages(args) {
    fields(args, ['workspace_id', 'session_id', 'limit', 'cursor'])
    const limit = bounded(args.limit, 10, 50)
    const { workspace } = await this.member(args.workspace_id, args.session_id)
    const context = 'messages:' + workspace.id + ':' + args.session_id
    const cursor = args.cursor === undefined ? { afterSeq: -1 } : this.decode(args.cursor, context)
    if (!Number.isSafeInteger(cursor.afterSeq) || cursor.afterSeq < -1) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const page = await this.backend.events(args.session_id, { afterSeq: cursor.afterSeq, throughSeq: cursor.throughSeq, revision: cursor.revision, scanLimit: 200 })
    if (!Array.isArray(page.events) || page.events.length > 200 || !Number.isSafeInteger(page.throughSeq) || page.throughSeq < -1 || typeof page.revision !== 'string') fail('READ_UNAVAILABLE', ERRORS.READ_UNAVAILABLE)
    if (cursor.throughSeq !== undefined && (cursor.throughSeq !== page.throughSeq || cursor.revision !== page.revision)) fail('STALE_READ', ERRORS.STALE_READ)
    const messages = []
    let scanned = cursor.afterSeq, chars = 0
    for (const event of page.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= scanned || event.seq > page.throughSeq) fail('READ_UNAVAILABLE', ERRORS.READ_UNAVAILABLE)
      let text = '', role
      if (event.type === 'user/message') { role = 'user'; text = this.text(event.data) }
      if (event.type === 'assistant/message') { role = 'assistant'; text = this.text(event.data?.message) }
      if (text && (messages.length === limit || chars + text.length > 24000)) break
      scanned = event.seq
      if (text) { messages.push({ seq: event.seq, time: typeof event.time === 'number' || typeof event.time === 'string' ? event.time : null, role, text }); chars += text.length }
    }
    await this.unchangedWorkspace(workspace, args.session_id)
    const more = scanned < page.throughSeq
    if (more && scanned === cursor.afterSeq) fail('READ_UNAVAILABLE', ERRORS.READ_UNAVAILABLE)
    return { messages, through_seq: page.throughSeq, has_more: more, next_cursor: more ? this.cursor({ context, afterSeq: scanned, throughSeq: page.throughSeq, revision: page.revision }) : null }
  }
  text(message) {
    if (!Array.isArray(message?.content)) return ''
    let text = ''
    for (const block of message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      // Reject oversized source text rather than emit an unsafe partial secret.
      if (text.length + block.text.length > 131072) fail('READ_TOO_LARGE', ERRORS.READ_TOO_LARGE)
      text += (text ? '\n' : '') + block.text
    }
    const safe = redact(text)
    return safe.length > 8000 ? safe.slice(0, 7980) + '\n[TRUNCATED]' : safe
  }
  async memoryArgs(args) {
    if (!['memory', 'user', 'project', 'key', 'daily'].includes(args.scope)) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    let workspace
    if (['project', 'key'].includes(args.scope)) workspace = await this.workspace(args.workspace_id)
    else if (!this.policy.globalMemory || args.workspace_id !== undefined) fail('SCOPE_DENIED', ERRORS.SCOPE_DENIED)
    if (args.scope === 'daily') {
      if (typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
      const date = new Date(args.date + 'T00:00:00Z')
      if (args.date.startsWith('0000') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== args.date) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    } else if (args.date !== undefined) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    return { workspace, context: JSON.stringify([args.scope, args.workspace_id ?? null, args.date ?? null]) }
  }
  async memoryRows(args) {
    const { workspace, context } = await this.memoryArgs(args)
    const entries = await this.backend.memories({ scope: args.scope, workspaceId: args.workspace_id, date: args.date })
    if (!Array.isArray(entries) || entries.length > 5000 || entries.some(entry => typeof entry !== 'string') || Buffer.byteLength(entries.join('\n§\n')) > 2 * 1024 * 1024) fail('READ_TOO_LARGE', ERRORS.READ_TOO_LARGE)
    if (workspace) await this.unchangedWorkspace(workspace)
    const revision = hash(entries.join('\n§\n'))
    return { context, revision, items: entries.map((entry, index) => {
      const text = redact(entry)
      return { id: this.sign(JSON.stringify([context, revision, index, entry])).slice(0, 32), summary: entrySummary(text), dsh_only: /\[dsh-only\]/.test(text), branches: [...text.matchAll(/\[branch:([^\]]*)\]/g)].map(match => match[1]), text: entryText(text) }
    }) }
  }
  async memorySearch(args) {
    fields(args, ['scope', 'workspace_id', 'date', 'query', 'limit', 'cursor'])
    const query = args.query ?? ''
    if (typeof query !== 'string' || query.length > 256) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const limit = bounded(args.limit, 20, 50)
    const rows = await this.memoryRows(args)
    const items = rows.items.filter(row => row.text.toLowerCase().includes(query.toLowerCase())).map(({ text, ...summary }) => summary)
    // Entry IDs bind the entire source revision, including unmatched entries.
    return { ...this.page(items, args.cursor, limit, 'memory:' + rows.context + ':' + query), source_revision: rows.revision }
  }
  async memoryGet(args) {
    fields(args, ['scope', 'workspace_id', 'date', 'id', 'offset', 'max_chars'])
    if (typeof args.id !== 'string' || !/^[0-9a-f]{32}$/.test(args.id)) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const offset = args.offset ?? 0, limit = bounded(args.max_chars, 8000, 16000)
    if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const rows = await this.memoryRows(args)
    const row = rows.items.find(item => item.id === args.id)
    if (!row) fail('NOT_FOUND', ERRORS.NOT_FOUND)
    if (offset > row.text.length) fail('INVALID_ARGUMENT', ERRORS.INVALID_ARGUMENT)
    const next = offset + limit
    return { id: row.id, revision: rows.revision, text: row.text.slice(offset, next), has_more: next < row.text.length, next_offset: next < row.text.length ? next : null }
  }
}
