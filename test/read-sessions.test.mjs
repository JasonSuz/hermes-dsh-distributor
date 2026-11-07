import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionReader } from '../src/read-sessions.mjs'

const header = () => ({ id: 's1', createdAt: 123 })
const events = count => Array.from({ length: count }, (_, seq) => ({ seq, type: 'test', data: { synthetic: true } }))
const rejects = (operation, code) => assert.rejects(operation, error => error.code === code && !error.message.includes('PRIVATE'))
function liveFixture(count = 5) {
  const log = events(count), calls = []
  const session = { header: header(), surface: { replaceGeneration: 0 }, get seq() { return log.length }, snapshotEvents(from, end) { calls.push([from, end]); return log.slice(from, end) } }
  const ctx = { sessions: new Map([['s1', session]]) }
  return { reader: createSessionReader(ctx), ctx, session, log, calls }
}
function coldFixture(count = 5) {
  const log = events(count), calls = [], state = { revision: 'r1', sizeBytes: 1024, closed: 0 }
  const ctx = {
    sessions: new Map(),
    sessionPersistence: {
      async stat(id, options) { calls.push(['stat', id]); assert.ok(options.signal); return { header: header(), revision: state.revision, sizeBytes: state.sizeBytes } },
      async open(id, access, options) {
        calls.push(['open', id, access]); assert.equal(access, 'read'); assert.ok(options.signal)
        return { header: header(), async read(offset, length, options) { calls.push(['read', offset, length]); assert.ok(options.signal); if (state.readError) throw state.readError; if (state.changeOnRead) state.revision = 'r2'; return { events: log.slice(offset, offset + length) } }, async close() { state.closed++ } }
      },
    },
  }
  return { reader: createSessionReader(ctx), ctx, state, log, calls }
}

test('workspace is an independent membership snapshot, and missing stays undefined', async () => {
  const item = { id: 'w1', title: 'Synthetic', path: '/synthetic', sessionIds: ['s1'], extra: 'excluded' }
  const reader = createSessionReader({ workspaceRegistry: { get: id => id === 'w1' ? item : undefined } })
  const value = await reader.workspace('w1')
  assert.deepEqual(value, { id: 'w1', title: 'Synthetic', path: '/synthetic', sessionIds: ['s1'] })
  item.sessionIds.push('s2'); assert.deepEqual(value.sessionIds, ['s1'])
  assert.equal(await reader.workspace('missing'), undefined)
})

test('summaries filter before title projection and exclude both forms of subagents', async () => {
  const ignored = { sessionId: 'other', get projections() { throw Error('PRIVATE body projection touched') } }
  const child = { ...header(), id: 'child', origin: 'subagent' }
  const parented = { ...header(), id: 'parented', parentSession: 's1' }
  const reader = createSessionReader({
    sessionQuery: { async listSessions() { return [{ header: header(), live: true }, { header: child }, { header: parented }, { header: { ...header(), id: 'cached-child' } }] } },
    sessionController: { async list(args) { assert.deepEqual(args, {}); return { items: [ignored, { sessionId: 's1', title: 'unsafe fallback', updatedAt: 456, running: false, projections: { values: { title: 'Cached title' } } }, { sessionId: 'cached-child', origin: 'subagent', get projections() { throw Error('PRIVATE child') } }] } } },
  })
  assert.deepEqual(await reader.summaries(['s1', 'child', 'parented', 'cached-child']), new Map([['s1', { title: 'Cached title', created_at: 123, updated_at: 456, live: true, origin: undefined }]]))
})

test('metadata never falls back to top-level title or event reads', async () => {
  const reader = createSessionReader({ sessionQuery: { listSessions: () => [{ header: header(), live: false }] }, sessionController: { list: () => ({ items: [{ sessionId: 's1', title: 'not cached' }] }) } })
  assert.equal((await reader.summaries(['s1'])).get('s1').title, '')
  assert.deepEqual(await reader.summaries([]), new Map())
})

test('live next-offset semantics, bounded slices and fixed cut survive append', async () => {
  const { reader, log, calls } = liveFixture()
  const first = await reader.events('s1', { scanLimit: 2 })
  assert.deepEqual(first.events.map(e => e.seq), [0, 1]); assert.equal(first.throughSeq, 4)
  log.push(...events(7).slice(5))
  const second = await reader.events('s1', { afterSeq: 1, throughSeq: first.throughSeq, revision: first.revision, scanLimit: 2 })
  assert.deepEqual(second.events.map(e => e.seq), [2, 3]); assert.equal(second.revision, first.revision)
  const last = await reader.events('s1', { afterSeq: 3, throughSeq: first.throughSeq, revision: first.revision })
  assert.deepEqual(last.events.map(e => e.seq), [4]); assert.deepEqual(calls, [[0, 2], [2, 4], [4, 5]])
})

test('live replacement generation, object replacement and truncation invalidate cursor', async () => {
  for (const change of [f => f.session.surface.replaceGeneration++, f => f.ctx.sessions.set('s1', { ...f.session }), f => f.log.pop()]) {
    const f = liveFixture(), first = await f.reader.events('s1', { scanLimit: 1 })
    change(f)
    await rejects(() => f.reader.events('s1', { afterSeq: 0, throughSeq: first.throughSeq, revision: first.revision }), 'STALE_READ')
  }
})

test('empty live and cold logs have cut -1 and no events', async () => {
  for (const f of [liveFixture(0), coldFixture(0)]) {
    const result = await f.reader.events('s1')
    assert.equal(result.throughSeq, -1); assert.deepEqual(result.events, [])
  }
})

test('cold read uses stat/read-only open/bounded read/stat/finally-close; unchanged stat remains stable', async () => {
  const { reader, state, calls } = coldFixture()
  const first = await reader.events('s1', { scanLimit: 2 })
  const second = await reader.events('s1', { afterSeq: 1, throughSeq: first.throughSeq, revision: first.revision, scanLimit: 2 })
  assert.deepEqual(second.events.map(e => e.seq), [2, 3]); assert.equal(first.revision, second.revision)
  assert.equal(state.closed, 2)
  assert.deepEqual(calls.slice(0, 4), [['stat', 's1'], ['open', 's1', 'read'], ['read', 0, 50001], ['stat', 's1']])
})

test('cold rejects unknown/oversized physical sizes before open', async () => {
  for (const size of [undefined, NaN, Infinity, -1, 8 * 1024 * 1024 + 1]) {
    const f = coldFixture(); f.state.sizeBytes = size
    await rejects(() => f.reader.events('s1'), 'READ_TOO_LARGE')
    assert.deepEqual(f.calls, [['stat', 's1']]); assert.equal(f.state.closed, 0)
  }
})

test('cold event cap closes handle, and exact 50000 limit is accepted', async () => {
  const tooLarge = coldFixture(50001)
  await rejects(() => tooLarge.reader.events('s1'), 'READ_TOO_LARGE'); assert.equal(tooLarge.state.closed, 1)
  const exact = coldFixture(50000)
  assert.equal((await exact.reader.events('s1')).throughSeq, 49999); assert.equal(exact.state.closed, 1)
})

test('cold changed stat during read or between cursor pages is stale and closes', async () => {
  const f = coldFixture(); f.state.changeOnRead = true
  await rejects(() => f.reader.events('s1'), 'STALE_READ'); assert.equal(f.state.closed, 1)
  const g = coldFixture(), first = await g.reader.events('s1', { scanLimit: 1 })
  g.state.revision = 'r2'
  await rejects(() => g.reader.events('s1', { afterSeq: 0, throughSeq: first.throughSeq, revision: first.revision }), 'STALE_READ'); assert.equal(g.state.closed, 2)
})

test('read failures sanitize backend error including spoofed allowed error codes and still close', async () => {
  const f = coldFixture(); f.state.readError = Object.assign(Error('PRIVATE path /secret'), { code: 'STALE_READ' })
  await rejects(() => f.reader.events('s1'), 'READ_UNAVAILABLE'); assert.equal(f.state.closed, 1)
  const bad = createSessionReader({ workspaceRegistry: { get() { throw Error('PRIVATE') } }, sessionQuery: { listSessions() { throw Error('PRIVATE') } } })
  await rejects(() => bad.workspace('w1'), 'READ_UNAVAILABLE')
  await rejects(() => bad.summaries(['s1']), 'READ_UNAVAILABLE')
})

test('cold closes after post-read stat failures and sanitizes open/close errors', async () => {
  const f = coldFixture(), stat = f.ctx.sessionPersistence.stat
  let reads = 0
  f.ctx.sessionPersistence.stat = async (...args) => { if (++reads > 1) throw Error('PRIVATE stat'); return stat(...args) }
  await rejects(() => f.reader.events('s1'), 'READ_UNAVAILABLE'); assert.equal(f.state.closed, 1)
  const g = coldFixture(); g.ctx.sessionPersistence.open = async () => { throw Error('PRIVATE open') }
  await rejects(() => g.reader.events('s1'), 'READ_UNAVAILABLE'); assert.equal(g.state.closed, 0)
  const h = coldFixture(), open = h.ctx.sessionPersistence.open
  h.ctx.sessionPersistence.open = async (...args) => { const handle = await open(...args); handle.close = async () => { throw Error('PRIVATE close') }; return handle }
  await rejects(() => h.reader.events('s1'), 'READ_UNAVAILABLE')
})

test('changed revision takes precedence over enlarged post-read stat', async () => {
  const f = coldFixture(), stat = f.ctx.sessionPersistence.stat
  let reads = 0
  f.ctx.sessionPersistence.stat = async (...args) => { if (++reads > 1) { f.state.revision = 'r2'; f.state.sizeBytes = Infinity }; return stat(...args) }
  await rejects(() => f.reader.events('s1'), 'STALE_READ'); assert.equal(f.state.closed, 1)
})

test('gaps, duplicate/invalid seq and nonprogress are rejected on both sources', async () => {
  for (const malformed of [[], [{ seq: 1 }], [{ seq: 0 }, { seq: 0 }], [{ seq: NaN }]]) {
    const f = liveFixture(2); f.session.snapshotEvents = () => malformed
    await rejects(() => f.reader.events('s1'), 'READ_UNAVAILABLE')
  }
  for (const seq of [-1, 1, NaN, 0.5]) {
    const f = coldFixture(1); f.log[0].seq = seq
    await rejects(() => f.reader.events('s1'), 'READ_UNAVAILABLE'); assert.equal(f.state.closed, 1)
  }
})

test('invalid inputs reject before backends and cursor cut/revision must be paired', async () => {
  const reader = createSessionReader({})
  for (const options of [{ scanLimit: 0 }, { scanLimit: 201 }, { afterSeq: -2 }, { afterSeq: 0.5 }, { throughSeq: 2 }, { revision: 'r' }, { throughSeq: -2, revision: 'r' }, { afterSeq: 3, throughSeq: 2, revision: 'r' }, null]) await rejects(() => reader.events('s1', options), 'INVALID_ARGUMENT')
  await rejects(() => reader.events('../s1'), 'INVALID_ARGUMENT')
  await rejects(() => reader.summaries(['../s1']), 'INVALID_ARGUMENT')
})
