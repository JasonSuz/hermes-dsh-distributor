import test from 'node:test'
import assert from 'node:assert/strict'
import { ReadAccess, validateReadPolicy, redact } from '../src/read-access.mjs'

test('read authorization is an explicit workspace snapshot, not a wildcard', () => {
  const policy = validateReadPolicy({ workspaceIds: ['workspace-one'], globalMemory: true })
  assert.deepEqual(policy.workspaceIds, ['workspace-one'])
  assert.equal(policy.globalMemory, true)
  assert.ok(Object.isFrozen(policy.workspaceIds))
  for (const input of [{ workspaceIds: ['*'] }, { workspaceIds: ['x', 'x'] }, { workspaceIds: ['x'], extra: true }]) {
    assert.throws(() => validateReadPolicy(input), { code: 'INVALID_ARGUMENT' })
  }
})

test('obvious copied credentials are redacted before summaries or search', () => {
  const text = 'token=example-secret-value Bearer secret-auth-value sk-' + 'x'.repeat(30)
  const result = redact(text)
  for (const secret of ['example-secret-value', 'secret-auth-value', 'sk-' + 'x'.repeat(30)]) assert.ok(!result.includes(secret))
  assert.ok(result.includes('[REDACTED]'))
})

function fixture({ globalMemory = true } = {}) {
  const state = {
    workspace: { id: 'w', title: 'Workspace', path: '/synthetic', sessionIds: ['s', 'child'] },
    entries: ['[id:12345678] [summary:First summary] First body', 'Second body token=private-value'],
    events: [
      { seq: 0, type: 'request/header', data: { token: 'header-secret' } },
      { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Hello' }, { type: 'file', path: '/secret' }] } },
      { seq: 2, type: 'tool/result', data: 'tool-secret' },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private-reasoning' }, { type: 'tool-call', name: 'private-tool', arguments: 'tool-secret' }, { type: 'text', text: 'Answer token=private-value' }] } } },
    ],
  }
  const backend = {
    workspace: async id => id === 'w' ? state.workspace && { ...state.workspace, sessionIds: [...state.workspace.sessionIds] } : undefined,
    summaries: async ids => new Map(ids.map(id => [id, { title: 'Safe title', created_at: 1, updated_at: 2, live: true, origin: id === 'child' ? 'subagent' : undefined }])),
    events: async (id, { afterSeq, throughSeq, scanLimit }) => ({ events: state.events.filter(e => e.seq > afterSeq && e.seq <= (throughSeq ?? 3)).slice(0, scanLimit), throughSeq: throughSeq ?? 3, revision: 'stable' }),
    memories: async () => [...state.entries],
  }
  return { state, backend, read: new ReadAccess({ backend, policy: { workspaceIds: ['w'], globalMemory } }) }
}

test('workspace/session metadata only, unauthorized and subagent sessions denied', async () => {
  const { read } = fixture()
  assert.deepEqual((await read.invoke('workspaces', {})).items, [{ workspace_id: 'w', title: 'Workspace' }])
  const result = await read.invoke('sessions', { workspace_id: 'w' })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].session_id, 's')
  assert.equal(result.content_is_untrusted, true)
  assert.ok(!JSON.stringify(result).includes('/synthetic'))
  await assert.rejects(read.invoke('session', { workspace_id: 'other', session_id: 's' }), { code: 'SCOPE_DENIED' })
  await assert.rejects(read.invoke('session', { workspace_id: 'w', session_id: 'outside' }), { code: 'NOT_FOUND' })
  await assert.rejects(read.invoke('session', { workspace_id: 'w', session_id: 'child' }), { code: 'NOT_FOUND' })
})

test('messages expose only redacted user/assistant text, with raw-sequence continuation', async () => {
  const { read } = fixture()
  const first = await read.invoke('messages', { workspace_id: 'w', session_id: 's', limit: 1 })
  assert.deepEqual(first.messages.map(m => [m.seq, m.role, m.text]), [[1, 'user', 'Hello']])
  assert.equal(first.has_more, true)
  const second = await read.invoke('messages', { workspace_id: 'w', session_id: 's', cursor: first.next_cursor })
  assert.deepEqual(second.messages.map(m => m.seq), [3])
  assert.equal(second.has_more, false)
  const json = JSON.stringify([first, second])
  for (const secret of ['private-value', 'header-secret', 'tool-secret', 'private-reasoning', 'private-tool', '/secret']) assert.ok(!json.includes(secret))
})

test('cursor cannot be forged or replayed against a different operation', async () => {
  const { read } = fixture()
  const page = await read.invoke('messages', { workspace_id: 'w', session_id: 's', limit: 1 })
  await assert.rejects(read.invoke('messages', { workspace_id: 'w', session_id: 's', cursor: page.next_cursor + 'x' }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(read.invoke('sessions', { workspace_id: 'w', cursor: page.next_cursor }), { code: 'INVALID_ARGUMENT' })
})

test('memory search is summary-first and full text needs explicit entry handle', async () => {
  const { read } = fixture()
  const page = await read.invoke('memorySearch', { scope: 'memory', limit: 1 })
  assert.equal(page.items[0].summary, 'First summary')
  assert.equal(page.items[0].text, undefined)
  assert.equal(page.has_more, true)
  const next = await read.invoke('memorySearch', { scope: 'memory', cursor: page.next_cursor })
  assert.equal(next.items.length, 1)
  const full = await read.invoke('memoryGet', { scope: 'memory', id: page.items[0].id, max_chars: 5 })
  assert.equal(full.has_more, true)
  const remainder = await read.invoke('memoryGet', { scope: 'memory', id: page.items[0].id, offset: full.next_offset })
  assert.ok((full.text + remainder.text).includes('First body'))
  assert.ok(!(full.text + remainder.text).includes('summary:'))
  assert.equal((await read.invoke('memorySearch', { scope: 'memory', query: 'private-value' })).items.length, 0)
  await assert.rejects(read.invoke('memoryGet', { scope: 'user', id: page.items[0].id }), { code: 'NOT_FOUND' })
})

test('memory changes invalidate cursors and entry handles', async () => {
  const { read, state } = fixture()
  const page = await read.invoke('memorySearch', { scope: 'memory', limit: 1 })
  state.entries.push('New entry')
  await assert.rejects(read.invoke('memorySearch', { scope: 'memory', cursor: page.next_cursor }), { code: 'STALE_READ' })
  await assert.rejects(read.invoke('memoryGet', { scope: 'memory', id: page.items[0].id }), { code: 'NOT_FOUND' })
})

test('global grants, project membership and strict dates are enforced before reading', async () => {
  const { read, backend } = fixture({ globalMemory: false })
  let calls = 0
  backend.memories = async () => { calls++; return [] }
  await assert.rejects(read.invoke('memorySearch', { scope: 'memory' }), { code: 'SCOPE_DENIED' })
  await assert.rejects(read.invoke('memorySearch', { scope: 'key', workspace_id: 'other' }), { code: 'SCOPE_DENIED' })
  await assert.rejects(read.invoke('memorySearch', { scope: 'key', workspace_id: 'w', date: '2026-01-01' }), { code: 'INVALID_ARGUMENT' })
  assert.equal(calls, 0)
  const enabled = fixture()
  for (const date of ['2026-02-29', '2026-13-01', '../config', '99999-01-01']) await assert.rejects(enabled.read.invoke('memorySearch', { scope: 'daily', date }), { code: 'INVALID_ARGUMENT' })
  assert.ok((await enabled.read.invoke('memorySearch', { scope: 'daily', date: '2024-02-29' })).items.length)
})

test('workspace removal during async history/memory read fails closed', async () => {
  for (const method of ['messages', 'memorySearch']) {
    const { read, backend, state } = fixture()
    if (method === 'messages') backend.events = async () => { state.workspace = null; return { events: [], throughSeq: -1, revision: 'r' } }
    else backend.memories = async () => { state.workspace = null; return ['private body'] }
    const args = method === 'messages' ? { workspace_id: 'w', session_id: 's' } : { scope: 'key', workspace_id: 'w' }
    await assert.rejects(read.invoke(method, args), { code: 'NOT_FOUND' })
  }
})

test('backend errors never expose raw messages or paths; limits reject invalid arguments', async () => {
  const { read, backend } = fixture()
  backend.memories = async () => { throw Object.assign(new Error('/private/secret token=never-leak'), { code: 'ENOENT' }) }
  await assert.rejects(read.invoke('memorySearch', { scope: 'memory' }), error => error.code === 'READ_UNAVAILABLE' && !error.message.includes('/private'))
  await assert.rejects(read.invoke('messages', { workspace_id: 'w', session_id: 's', limit: 51 }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(read.invoke('workspaces', { path: '/etc' }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(read.invoke('__proto__', {}), { code: 'INVALID_ARGUMENT' })
})

test('raw hidden events advance without fabricating visible messages', async () => {
  const { read, state } = fixture()
  state.events = Array.from({ length: 4 }, (_, seq) => ({ seq, type: 'tool/result', data: 'private' }))
  const page = await read.invoke('messages', { workspace_id: 'w', session_id: 's' })
  assert.deepEqual(page.messages, [])
  assert.equal(page.has_more, false)
  state.events = [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(131073) }] } }]
  await assert.rejects(read.invoke('messages', { workspace_id: 'w', session_id: 's' }), { code: 'READ_TOO_LARGE' })
})

test('read concurrency is bounded and released on failure', async () => {
  const { read, backend } = fixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  backend.memories = async () => { await gate; return [] }
  const running = Array.from({ length: 4 }, () => read.invoke('memorySearch', { scope: 'memory' }))
  await assert.rejects(read.invoke('memorySearch', { scope: 'memory' }), { code: 'READ_BUSY' })
  release()
  await Promise.all(running)
  assert.equal(read.active, 0)
  assert.deepEqual((await read.invoke('memorySearch', { scope: 'memory' })).items, [])
})
