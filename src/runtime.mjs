import { randomUUID } from 'node:crypto'
import { fail } from './router.mjs'

const presentation = mode => mode === 'ptc' ? 'ptc' : 'native'
const effortOf = config => config.reasoningEffort ?? 'none'
function sameRoute(spec, config, explicitEffort = spec.reasoning_effort !== 'none') {
  return config.provider === spec.provider && config.model === spec.model && effortOf(config) === spec.reasoning_effort && (!explicitEffort || config.reasoningEffort !== undefined)
}
function requestedConfig(spec, explicitEffort) {
  return { provider: spec.provider, model: spec.model, ...(explicitEffort ? { reasoningEffort: spec.reasoning_effort } : {}) }
}

/** No provider credentials or inherited conversation are copied into these sessions. */
export function createRuntime(ctx) {
  return {
    async capabilities() {
      const groups = [], failures = []
      for (const provider of ctx.llm.listProviders()) {
        try {
          const models = []
          for (const model of await ctx.llm.listModels(provider.id)) {
            const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
            models.push({ id: model.id, name: model.name, reasoning_efforts: info.reasoning?.efforts.map(e => e.id) ?? ['none'] })
          }
          groups.push({ provider: provider.id, name: provider.name, models })
        } catch { failures.push({ provider: provider.id, error: 'Catalog unavailable; inspect local DSH diagnostics' }) }
      }
      return { groups, failures, agent_presets: await ctx.agentPresets.list(), ptc_available: Boolean(ctx.get('ptcRuntime')) }
    },
    async validate(spec) {
      if (!ctx.llm.listProviders().some(p => p.id === spec.provider)) fail('UNKNOWN_PROVIDER', 'provider is not registered in this DSH instance')
      if (!(await ctx.llm.listModels(spec.provider)).some(m => m.id === spec.model)) fail('UNKNOWN_MODEL', 'Exact model ID is not advertised by this provider; call router_capabilities')
      const info = await ctx.llm.resolveModelInfo(spec.provider, spec.model)
      const efforts = info.reasoning?.efforts.map(e => e.id) ?? ['none']
      if (!efforts.includes(spec.reasoning_effort)) fail('UNSUPPORTED_EFFORT', `reasoning_effort must be one of: ${efforts.join(', ')}`)
      if (spec.mode === 'ptc' && !ctx.get('ptcRuntime')) fail('PTC_UNAVAILABLE', 'DSH has no PTC runtime')
      const preset = await ctx.agentPresets.resolve(spec.agent_preset)
      if (preset.id !== spec.agent_preset) fail('UNSUPPORTED_PRESET', 'Preset resolution changed the requested ID')
      const explicitEffort = info.reasoning !== undefined
      const resolved = await ctx.llm.resolveCallConfig(requestedConfig(spec, explicitEffort))
      if (!sameRoute(spec, resolved, explicitEffort)) fail('ROUTE_MISMATCH', 'Resolved provider, model or reasoning effort differs from the request')
      return { provider: resolved.provider, model: resolved.model, reasoning_effort: effortOf(resolved), reasoning_control: explicitEffort ? 'explicit' : 'unsupported', mode: spec.mode, tool_presentation: presentation(spec.mode), agent_preset: preset.id }
    },
    async run(record, signal, progress) {
      const spec = record.requested
      // Revalidate after admission in case the registry changed while the job was saved.
      const validated = await this.validate(spec)
      const explicitEffort = validated.reasoning_control === 'explicit'
      signal.throwIfAborted()
      let handle, turnEnd, observed = [], output = '', truncated = false, violation
      const writes = []
      const onAbort = () => handle?.agent.cancel({ kind: 'hook', reason: 'Task router canceled, deadline exceeded, or plugin unloaded' })
      const publish = patch => {
        const pending = progress(patch)
        // A failed evidence write cancels work rather than silently losing provenance.
        pending.catch(error => { violation ??= error; handle?.agent.cancel({ kind: 'hook', reason: 'Task router execution evidence or route validation failed' }) })
        writes.push(pending)
      }
      try {
        handle = await ctx.agents.create({
          sessionId: `session-${randomUUID()}`,
          agentOptions: requestedConfig(spec, explicitEffort),
          meta: { cwd: record.resolved.cwd, agentPreset: spec.agent_preset },
          signal,
          setup: async (agentCtx, agent) => {
            await ctx.agentPresets.mount(agentCtx, spec.agent_preset)
            // This is scoped to this new agent, never a global GUI mode switch.
            await agentCtx.tools.presentAs(presentation(spec.mode))
            agentCtx.on('agent/request', async (_payload, next) => {
              const proposed = await next()
              if (!sameRoute(spec, proposed, explicitEffort)) fail('ROUTE_MISMATCH', 'A runtime hook attempted to change the requested model route')
              return proposed
            })
            agentCtx.on('session/event', (session, event) => {
              if (session.id !== agent.id) return
              if (event.type === 'request/header') {
                const header = event.data.header
                const toolNames = (header.tools ?? []).map(tool => tool.name)
                const modeMatches = spec.mode === 'ptc' ? toolNames.length === 1 && toolNames[0] === 'run_code' : !toolNames.includes('run_code')
                if (!sameRoute(spec, header.config, explicitEffort) || !modeMatches) {
                  violation = Object.assign(new Error('Actual request/header differs from requested model/effort/mode'), { code: 'ROUTE_MISMATCH' })
                  agent.cancel({ kind: 'hook', reason: 'Task router execution evidence or route validation failed' })
                }
                if (observed.length < 32) observed.push({ evidence: 'DSH request/header', seq: event.seq, provider: header.config.provider, model: header.config.model, reasoning_effort: effortOf(header.config), mode: modeMatches ? spec.mode : 'mismatch', tool_presentation: spec.mode === 'ptc' ? 'run_code-only' : 'native' })
                publish({ observed: structuredClone(observed) })
              }
              if (event.type === 'assistant/message') {
                const text = (event.data.message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
                if (text) { const combined = output + (output ? '\n' : '') + text; truncated ||= combined.length > 262144; output = combined.slice(0, 262144); publish({ output, output_truncated: truncated }) }
              }
              if (event.type === 'turn/end') turnEnd = event.data.reason
            })
          },
        })
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        await progress({ session_id: handle.agent.id })
        signal.throwIfAborted()
        // UserMessage's public value shape; no runtime package dependency is needed.
        handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: spec.prompt })]), source: Object.freeze({ kind: 'user' }) }))
        await handle.agent.whenIdle()
        await Promise.all(writes)
        signal.throwIfAborted()
        if (violation) throw violation
        if (!turnEnd || turnEnd.kind !== 'completed') fail('TURN_NOT_COMPLETED', `DSH turn ended as ${turnEnd?.kind ?? 'unknown'}; inspect the session log`)
        if (!observed.length) fail('NO_EXECUTION_EVIDENCE', 'No DSH request/header was recorded')
        return { output, output_truncated: truncated, observed, turn_end: turnEnd.kind }
      } finally {
        signal.removeEventListener('abort', onAbort)
        await handle?.dispose()
        await Promise.allSettled(writes)
      }
    },
  }
}
