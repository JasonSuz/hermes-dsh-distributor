import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.mjs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'

function fixture(overrides = {}) {
  const handlers = new Map(), log = { creates: [], mounts: [], modes: [], disposed: 0, canceled: [], prompts: [] }
  const spec = { provider: 'subscription-route', model: 'model-exact', reasoning_effort: 'high', mode: 'ptc', agent_preset: 'standard', prompt: 'safe smoke' }
  const config = { provider: spec.provider, model: spec.model, reasoningEffort: 'high' }
  let seq = 0
  const agent = {
    id: 'session-owned',
    followup: message => log.prompts.push(message),
    cancel: cause => { log.canceled.push(cause); overrides.onCancel?.() },
    async whenIdle() {
      if (overrides.beforeIdle) await overrides.beforeIdle()
      const candidate = await handlers.get('agent/request')?.({}, async () => overrides.proposed ?? config)
      assert(candidate)
      const emit = (type, data) => handlers.get('session/event')?.({ id: agent.id }, { type, data, seq: ++seq })
      if (!overrides.noHeader) emit('request/header', { header: { config: overrides.headerConfig ?? config, tools: overrides.tools ?? [{ name: spec.mode === 'ptc' ? 'run_code' : 'read' }] } })
      emit('assistant/message', { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: overrides.output ?? 'SAFE_OK' }] } })
      emit('turn/end', { reason: { kind: overrides.turnEnd ?? 'completed' } })
    },
  }
  const ctx = {
    llm: {
      listProviders: () => [{ id: spec.provider, name: 'Subscription' }],
      listModels: async () => [{ id: spec.model, name: 'Exact' }],
      resolveModelInfo: async () => overrides.info ?? ({ reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }] } }),
      resolveCallConfig: async value => overrides.resolved ?? value,
    },
    get: name => name === 'ptcRuntime' && !overrides.noPtc ? {} : undefined,
    agentPresets: {
      list: async () => [{ id: 'standard' }],
      resolve: async id => { if (id !== 'standard') throw new Error('Unknown preset'); return { id } },
      mount: async (scope, id) => log.mounts.push({ scope, id }),
    },
    agents: {
      async create(options) {
        log.creates.push(options)
        const agentCtx = { tools: overrides.legacy ? { presentAs: mode => log.modes.push(mode) } : { setExecutor: executor => log.modes.push(executor.mode) }, on: (name, fn) => handlers.set(name, fn) }
        await options.setup(agentCtx, agent)
        return { agent, dispose: async () => { log.disposed++ } }
      },
    },
  }
  const loadExecutor = async mode => { if (overrides.executorError) throw overrides.executorError; return class { constructor(scope) { assert(scope.tools); this.mode = mode } } }
  const runtime = createRuntime(ctx, { loadExecutor })
  const record = { requested: spec, resolved: { cwd: '/approved/workspace' } }
  return { runtime, ctx, spec, record, log, loadExecutor }
}

test('catalog uses actual provider registry, exact models and supported efforts', async () => {
  const f = fixture()
  const result = await f.runtime.capabilities()
  assert.equal(result.groups[0].provider, 'subscription-route')
  assert.deepEqual(result.groups[0].models[0].reasoning_efforts, ['medium', 'high'])
  assert.equal(result.ptc_available, true)
})
test('preflight rejects unavailable providers, models, efforts, presets and PTC', async () => {
  const f = fixture()
  await assert.rejects(f.runtime.validate({ ...f.spec, provider: 'deepseek-default' }), { code: 'UNKNOWN_PROVIDER' })
  await assert.rejects(f.runtime.validate({ ...f.spec, model: 'friendly-guessed-name' }), { code: 'UNKNOWN_MODEL' })
  await assert.rejects(f.runtime.validate({ ...f.spec, reasoning_effort: 'ultra' }), { code: 'UNSUPPORTED_EFFORT' })
  await assert.rejects(f.runtime.validate({ ...f.spec, agent_preset: 'unknown' }))
  const noPtc = fixture({ noPtc: true })
  await assert.rejects(noPtc.runtime.validate(noPtc.spec), { code: 'PTC_UNAVAILABLE' })
  assert.equal(f.log.creates.length, 0)
})
test('no-effort model requires explicit none and sends no reasoningEffort property', async () => {
  const f = fixture({ info: {} })
  f.spec.reasoning_effort = 'none'
  const validated = await f.runtime.validate(f.spec)
  assert.equal(validated.reasoning_effort, 'none')
  assert.equal((await f.runtime.capabilities()).groups[0].models[0].reasoning_efforts[0], 'none')
})
test('advertised literal none is transmitted explicitly instead of using model default high', async () => {
  const f = fixture({ info: { reasoning: { efforts: [{ id: 'none' }, { id: 'high' }], defaultEffort: 'high' } } })
  f.spec.reasoning_effort = 'none'
  let supplied
  f.ctx.llm.resolveCallConfig = async value => { supplied = value; return { ...value, reasoningEffort: value.reasoningEffort ?? 'high' } }
  assert.equal((await f.runtime.validate(f.spec)).reasoning_effort, 'none')
  assert.equal(supplied.reasoningEffort, 'none')
})

test('adapter canonicalization or downgrade is rejected rather than silently used', async () => {
  const f = fixture({ resolved: { provider: 'subscription-route', model: 'model-exact', reasoningEffort: 'medium' } })
  await assert.rejects(f.runtime.validate(f.spec), { code: 'ROUTE_MISMATCH' })
  assert.equal(f.log.creates.length, 0)
})
test('fresh standalone session pins exact model/effort and scoped PTC with observed headers', async () => {
  const f = fixture()
  const updates = []
  const result = await f.runtime.run(f.record, new AbortController().signal, async patch => updates.push(patch))
  assert.deepEqual(f.log.creates[0].agentOptions, { provider: 'subscription-route', model: 'model-exact', reasoningEffort: 'high' })
  assert.equal(f.log.creates[0].meta.cwd, '/approved/workspace')
  assert.equal(f.log.creates[0].parentAgent, undefined)
  assert.equal(f.log.creates[0].seed, undefined)
  assert.deepEqual(f.log.modes, ['ptc'])
  assert.equal(f.log.mounts[0].id, 'standard')
  assert.equal(f.log.prompts[0].content[0].text, 'safe smoke')
  assert.equal(result.output, 'SAFE_OK')
  assert.equal(result.observed[0].tool_presentation, 'run_code-only')
  assert.equal(result.observed[0].reasoning_effort, 'high')
  assert.equal(f.log.disposed, 1)
  assert(updates.some(p => p.session_id === 'session-owned'))
  assert(!JSON.stringify(result).includes('private'))
})
test('standard mode uses native presentation, not a PTC prompt imitation', async () => {
  const f = fixture()
  f.spec.mode = 'standard'
  const result = await f.runtime.run(f.record, new AbortController().signal, async () => {})
  assert.deepEqual(f.log.modes, ['native'])
  assert.equal(result.observed[0].tool_presentation, 'native')
})
test('legacy hosts keep scoped presentAs without loading new executor packages', async () => {
  const f = fixture({ legacy: true, executorError: new Error('must not import') })
  await f.runtime.run(f.record, new AbortController().signal, async () => {})
  assert.deepEqual(f.log.modes, ['ptc'])
})
test('executor loading failure cannot silently downgrade or launch a task', async () => {
  const f = fixture({ executorError: new Error('executor module unavailable') })
  await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async () => {}), /executor module unavailable/)
  assert.equal(f.log.prompts.length, 0)
  assert.deepEqual(f.log.modes, [])
})
test('runtime hook route drift is rejected before model request evidence', async () => {
  const f = fixture({ proposed: { provider: 'wrong', model: 'fallback', reasoningEffort: 'high' } })
  await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async () => {}), { code: 'ROUTE_MISMATCH' })
  assert.equal(f.log.disposed, 1)
})
test('actual header mismatch cancels owned agent and fails job', async () => {
  const f = fixture({ headerConfig: { provider: 'subscription-route', model: 'model-exact', reasoningEffort: 'medium' } })
  await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async () => {}), { code: 'ROUTE_MISMATCH' })
  assert.equal(f.log.canceled[0].kind, 'hook')
  assert.equal(f.log.disposed, 1)
})
test('PTC with native tool schemas and missing execution evidence fail closed', async () => {
  const wrongTools = fixture({ tools: [{ name: 'read' }] })
  await assert.rejects(wrongTools.runtime.run(wrongTools.record, new AbortController().signal, async () => {}), { code: 'ROUTE_MISMATCH' })
  const missing = fixture({ noHeader: true })
  await assert.rejects(missing.runtime.run(missing.record, new AbortController().signal, async () => {}), { code: 'NO_EXECUTION_EVIDENCE' })
})
test('error, blocked and max-token endings are not reported completed', async () => {
  for (const turnEnd of ['error', 'blocked', 'max-tokens', 'interrupted']) {
    const f = fixture({ turnEnd })
    await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async () => {}), { code: 'TURN_NOT_COMPLETED' })
    assert.equal(f.log.disposed, 1)
  }
})
test('abort during running work actively cancels the owned agent and drains it', async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const f = fixture({ beforeIdle: async () => { entered.resolve(); await gate.promise }, onCancel: () => gate.resolve() })
  const controller = new AbortController()
  const running = f.runtime.run(f.record, controller.signal, async () => {})
  await entered.promise
  controller.abort(new Error('Canceled live work'))
  await assert.rejects(running, /Canceled live work/)
  assert.equal(f.log.canceled[0].kind, 'hook')
  assert.equal(f.log.disposed, 1)
})

test('abort before creation does not start work; large text output is bounded', async () => {
  const f = fixture(), controller = new AbortController()
  controller.abort(new Error('stop'))
  await assert.rejects(f.runtime.run(f.record, controller.signal, async () => {}), /stop/)
  assert.equal(f.log.creates.length, 0)
  const large = fixture({ output: 'x'.repeat(300000) })
  const result = await large.runtime.run(large.record, new AbortController().signal, async () => {})
  assert.equal(result.output.length, 262144)
  assert.equal(result.output_truncated, true)
})

async function workspaceFixture(attach) {
  const f = fixture(), path = await realpath(tmpdir())
  const workspace = { id: 'workspace-hermes', title: 'Hermes', path, attachSession: attach ?? (async id => { f.log.attached = id; assert.equal(f.log.prompts.length, 0) }) }
  f.spec.cwd = path
  f.record.resolved.cwd = path
  f.runtime = createRuntime(f.ctx, { workspace, loadExecutor: f.loadExecutor })
  return { ...f, workspace }
}
test('configured Hermes workspace is advertised and attached before execution without changing cwd', async () => {
  const f = await workspaceFixture(), updates = []
  assert.deepEqual((await f.runtime.capabilities()).task_workspace, { id: f.workspace.id, title: 'Hermes', path: f.workspace.path })
  assert.equal((await f.runtime.validate(f.spec)).workspace_id, f.workspace.id)
  await f.runtime.run(f.record, new AbortController().signal, async patch => updates.push(patch))
  assert.equal(f.log.attached, 'session-owned')
  assert.equal(f.log.creates[0].meta.cwd, f.workspace.path)
  assert(updates.some(p => p.workspace_id === f.workspace.id))
})
test('a different cwd fails closed before creating a Hermes agent', async () => {
  const f = await workspaceFixture()
  f.spec.cwd = '/'
  await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async () => {}), { code: 'WORKSPACE_MISMATCH' })
  assert.equal(f.log.creates.length, 0)
})
test('workspace attachment failure disposes the session without launching a turn', async () => {
  const f = await workspaceFixture(async () => { throw new Error('workspace persistence failed') })
  await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async () => {}), /workspace persistence failed/)
  assert.equal(f.log.prompts.length, 0)
  assert.equal(f.log.disposed, 1)
})
test('cancellation during workspace attachment cannot launch a paid turn', async () => {
  const controller = new AbortController()
  const f = await workspaceFixture(async () => controller.abort())
  await assert.rejects(f.runtime.run(f.record, controller.signal, async () => {}), { name: 'AbortError' })
  assert.equal(f.log.prompts.length, 0)
  assert.equal(f.log.disposed, 1)
})

test('workspace evidence write failure prevents execution after successful attachment', async () => {
  const f = await workspaceFixture(), updates = []
  await assert.rejects(f.runtime.run(f.record, new AbortController().signal, async patch => {
    updates.push(patch)
    if (patch.workspace_id) throw new Error('receipt write failed')
  }), /receipt write failed/)
  assert(updates.some(p => p.session_id === 'session-owned'))
  assert.equal(f.log.attached, 'session-owned')
  assert.equal(f.log.prompts.length, 0)
  assert.equal(f.log.disposed, 1)
})
