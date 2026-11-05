import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Router } from '../src/router.mjs'

function deferred() { return Promise.withResolvers() }
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-router-test-')))
  const workspace = join(root, 'workspace'), stateDir = join(root, 'state')
  await mkdir(workspace)
  let calls = 0
  const runtime = {
    capabilities: async () => ({ groups: [] }),
    validate: async spec => ({ provider: spec.provider, model: spec.model, reasoning_effort: spec.reasoning_effort, mode: spec.mode }),
    run: async () => { calls++; return { output: 'DONE' } },
    ...overrides,
  }
  const router = new Router({ runtime, stateDir, allowedRoots: [workspace] })
  await router.init()
  t.after(() => router.close())
  const spec = { request_id: 'test-1', prompt: 'test', cwd: workspace, provider: 'codex', model: 'exact-model', reasoning_effort: 'medium', mode: 'standard' }
  return { root, workspace, stateDir, runtime, router, spec, calls: () => calls }
}
async function settled(router, id) {
  await router.workers.get(id)?.promise
  return router.get({ task_id: id })
}

test('persists exact routing, progress and terminal output; returns detached snapshots', async t => {
  const f = await fixture(t)
  const accepted = await f.router.start(f.spec)
  accepted.requested.model = 'malicious-mutation'
  const result = await settled(f.router, accepted.task_id)
  assert.equal(result.status, 'completed')
  assert.equal(result.output, 'DONE')
  assert.equal(result.requested.model, 'exact-model')
  assert.equal(result.resolved.cwd, f.workspace)
  assert.deepEqual(JSON.parse(await readFile(join(f.stateDir, accepted.task_id + '.json'), 'utf8')), result)
})
test('concurrent duplicate requests execute once and conflict is rejected', async t => {
  const f = await fixture(t)
  const accepted = await Promise.all(Array.from({ length: 12 }, () => f.router.start(f.spec)))
  assert.equal(new Set(accepted.map(r => r.task_id)).size, 1)
  await settled(f.router, accepted[0].task_id)
  assert.equal(f.calls(), 1)
  await assert.rejects(f.router.start({ ...f.spec, prompt: 'different' }), { code: 'REQUEST_CONFLICT' })
})
test('completed receipts remain idempotent after router restart', async t => {
  const f = await fixture(t)
  const before = await f.router.start(f.spec)
  await settled(f.router, before.task_id)
  await f.router.close()
  const second = new Router({ runtime: f.runtime, stateDir: f.stateDir, allowedRoots: [f.workspace] })
  await second.init()
  t.after(() => second.close())
  assert.equal((await second.start(f.spec)).task_id, before.task_id)
  assert.equal(f.calls(), 1)
})
test('uncertain persisted active jobs become interrupted, never automatically replayed', async t => {
  const f = await fixture(t)
  const record = await f.router.start(f.spec)
  await settled(f.router, record.task_id)
  await f.router.close()
  // Simulate a disk receipt left active by a crash, after releasing the test owner's lock.
  await writeFile(join(f.stateDir, record.task_id + '.json'), JSON.stringify({ ...record, status: 'running' }))
  const second = new Router({ runtime: f.runtime, stateDir: f.stateDir, allowedRoots: [f.workspace] })
  await second.init()
  t.after(() => second.close())
  const replay = await second.start(f.spec)
  assert.equal(replay.task_id, record.task_id)
  assert.equal(replay.status, 'interrupted')
  assert.equal(second.workers.size, 0)
})
test('a second store owner fails closed; normal close releases ownership', async t => {
  const f = await fixture(t)
  const other = new Router({ runtime: f.runtime, stateDir: f.stateDir, allowedRoots: [f.workspace] })
  await assert.rejects(other.init(), { code: 'STATE_IN_USE' })
  await f.router.close()
  await other.init()
  await other.close()
})
test('ambiguous admission persistence reserves request id without executing or duplicating receipts', async t => {
  const f = await fixture(t)
  const realPersist = f.router.persist.bind(f.router)
  f.router.persist = async record => { await realPersist(record); throw Object.assign(new Error('Directory fsync failed'), { code: 'EIO' }) }
  await assert.rejects(f.router.start(f.spec), { code: 'EIO' })
  const retry = await f.router.start(f.spec)
  assert.equal(retry.status, 'interrupted')
  assert.equal(retry.error.code, 'ADMISSION_UNCERTAIN')
  assert.equal(f.calls(), 0)
  assert.equal((await readdir(f.stateDir)).filter(n => n.endsWith('.json')).length, 1)
  f.router.persist = realPersist
  await f.router.close()
  const other = new Router({ runtime: f.runtime, stateDir: f.stateDir, allowedRoots: [f.workspace] })
  await other.init()
  assert.equal((await other.start(f.spec)).task_id, retry.task_id)
  assert.equal(other.workers.size, 0)
  await other.close()
})
test('cancel aborts active work even when receipt persistence fails', async t => {
  const entered = deferred()
  let activeSignal
  const f = await fixture(t, { run: async (_record, signal) => new Promise((_resolve, reject) => { activeSignal = signal; entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) })
  const record = await f.router.start(f.spec)
  await entered.promise
  const realPersist = f.router.persist.bind(f.router)
  f.router.persist = async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }) }
  await assert.rejects(f.router.cancel({ task_id: record.task_id }), { code: 'ENOSPC' })
  assert.equal(activeSignal.aborted, true)
  await settled(f.router, record.task_id)
  f.router.persist = realPersist
})
test('rejects unknown keys, missing required fields and unsupported modes before execution', async t => {
  const f = await fixture(t)
  for (const changes of [{ provider: '' }, { model: undefined }, { reasoning_effort: undefined }, { mode: 'hybrid' }, { model_tier: 'pro' }, { deadline_ms: 999 }, { request_id: '../escape' }, { cwd: 'relative' }, { prompt: 'x'.repeat(131073) }]) {
    await assert.rejects(f.router.start({ ...f.spec, ...changes }))
  }
  assert.equal(f.calls(), 0)
  assert.equal(f.router.records.size, 0)
})
test('denies sibling directories and symlink escapes; accepts nested workspaces', async t => {
  const f = await fixture(t)
  const sibling = join(f.root, 'workspace-other')
  await mkdir(sibling)
  const link = join(f.workspace, 'outside')
  await symlink(sibling, link)
  await assert.rejects(f.router.start({ ...f.spec, cwd: sibling }), { code: 'WORKSPACE_DENIED' })
  await assert.rejects(f.router.start({ ...f.spec, cwd: link }), { code: 'WORKSPACE_DENIED' })
  const sub = join(f.workspace, 'sub')
  await mkdir(sub)
  const accepted = await f.router.start({ ...f.spec, cwd: sub })
  assert.equal((await settled(f.router, accepted.task_id)).status, 'completed')
})
test('runtime validation fails closed without accepted job or execution', async t => {
  const f = await fixture(t, { validate: async () => { throw Object.assign(new Error('Unavailable'), { code: 'UNKNOWN_MODEL' }) } })
  await assert.rejects(f.router.start(f.spec), { code: 'UNKNOWN_MODEL' })
  assert.equal(f.calls(), 0)
  assert.equal(f.router.records.size, 0)
})
test('runtime failures are terminal and do not rerun on retry', async t => {
  const f = await fixture(t, { run: async () => { throw Object.assign(new Error('Route changed'), { code: 'ROUTE_MISMATCH' }) } })
  const accepted = await f.router.start(f.spec)
  const result = await settled(f.router, accepted.task_id)
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'ROUTE_MISMATCH')
  assert.equal((await f.router.start(f.spec)).task_id, accepted.task_id)
})
test('cancel and unload abort owned work without claiming successful completion', async t => {
  const entered = deferred()
  const f = await fixture(t, { run: async (_record, signal) => new Promise((_resolve, reject) => { entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) })
  const accepted = await f.router.start(f.spec)
  await entered.promise
  assert.ok(['canceling', 'canceled'].includes((await f.router.cancel({ task_id: accepted.task_id })).status))
  assert.equal((await settled(f.router, accepted.task_id)).status, 'canceled')
  const next = await f.router.start({ ...f.spec, request_id: 'test-2' })
  await f.router.close()
  assert.equal(f.router.get({ task_id: next.task_id }).status, 'interrupted')
  await assert.rejects(f.router.start({ ...f.spec, request_id: 'test-3' }), { code: 'SHUTTING_DOWN' })
})
test('concurrency and retention limits reject excess work before admission', async t => {
  const entered = deferred()
  const f = await fixture(t, { run: async (_record, signal) => new Promise((_resolve, reject) => { entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }) }) })
  f.router.maxConcurrent = 1
  await f.router.start(f.spec)
  await entered.promise
  await assert.rejects(f.router.start({ ...f.spec, request_id: 'two' }), { code: 'BUSY' })
  f.router.maxRecords = 1
  await assert.rejects(f.router.start({ ...f.spec, request_id: 'three' }), { code: 'RETENTION_LIMIT' })
})
test('get and cancel require exactly an existing task_id', async t => {
  const f = await fixture(t)
  assert.throws(() => f.router.get({ task_id: 'absent' }), { code: 'NOT_FOUND' })
  assert.throws(() => f.router.get({ task_id: '../x', extra: true }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(f.router.cancel({}), { code: 'INVALID_ARGUMENT' })
  assert.deepEqual((await f.router.capabilities({})).modes, ['standard', 'ptc'])
})
test('corrupt receipts and symlink state directory fail closed', async t => {
  const f = await fixture(t)
  const record = await f.router.start(f.spec)
  await settled(f.router, record.task_id)
  await f.router.close()
  await writeFile(join(f.stateDir, record.task_id + '.json'), '{}')
  const other = new Router({ runtime: f.runtime, stateDir: f.stateDir, allowedRoots: [f.workspace] })
  await assert.rejects(other.init())
  const link = join(f.root, 'state-link')
  await symlink(f.stateDir, link)
  const linked = new Router({ runtime: f.runtime, stateDir: link, allowedRoots: [f.workspace] })
  await assert.rejects(linked.init(), { code: 'UNSAFE_STATE' })
  assert.equal((await readdir(f.stateDir)).filter(n => n.endsWith('.tmp')).length, 0)
})
