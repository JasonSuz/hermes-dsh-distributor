import { createHash } from 'node:crypto'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 50000
const MESSAGES = Object.freeze({ INVALID_ARGUMENT: 'Invalid read arguments', READ_UNAVAILABLE: 'Read service is unavailable', READ_TOO_LARGE: 'Read exceeds configured limits', STALE_READ: 'Source changed; restart the query' })
class ReadError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code }
}
const fail = code => { throw new ReadError(code) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function identifier(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) fail('INVALID_ARGUMENT')
}
function headerIdentity(header, id) {
  if (!header || header.id !== id || !Number.isFinite(header.createdAt) || header.origin === 'subagent' || header.parentSession !== undefined) fail('READ_UNAVAILABLE')
  return [header.id, header.createdAt]
}
function validateEvents(events, from, end) {
  if (!Array.isArray(events) || events.length !== end - from) fail('READ_UNAVAILABLE')
  for (let index = 0; index < events.length; index++) {
    if (!Number.isSafeInteger(events[index]?.seq) || events[index].seq !== from + index) fail('READ_UNAVAILABLE')
  }
  return events
}
function statIdentity(stat, id) {
  if (!stat) fail('READ_UNAVAILABLE')
  if (!Number.isFinite(stat.sizeBytes) || stat.sizeBytes < 0 || stat.sizeBytes > MAX_BYTES) fail('READ_TOO_LARGE')
  if (typeof stat.revision !== 'string' || !stat.revision) fail('READ_UNAVAILABLE')
  return [headerIdentity(stat.header, id), stat.revision, stat.sizeBytes]
}

/** Read-only host adapters. Authorization and message projection belong to ReadAccess. */
export function createSessionReader(ctx) {
  const instances = new WeakMap()
  let nextInstance = 0
  const safe = operation => async (...args) => {
    try { return await operation(...args) }
    catch (error) { if (error instanceof ReadError) throw error; fail('READ_UNAVAILABLE') }
  }
  function liveIdentity(session, id) {
    if (!instances.has(session)) instances.set(session, ++nextInstance)
    const generation = session.surface?.replaceGeneration
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) fail('READ_UNAVAILABLE')
    return [headerIdentity(session.header, id), instances.get(session), generation ?? null]
  }
  return {
    workspace: safe(async id => {
      identifier(id)
      const value = await ctx.workspaceRegistry.get(id)
      if (value === undefined) return undefined
      if (value.id !== id || !Array.isArray(value.sessionIds)) fail('READ_UNAVAILABLE')
      return { id: value.id, title: value.title, path: value.path, sessionIds: [...value.sessionIds] }
    }),
    summaries: safe(async ids => {
      if (!Array.isArray(ids) || ids.length > 10000) fail('INVALID_ARGUMENT')
      ids.forEach(identifier)
      const wanted = new Set(ids), result = new Map()
      if (!wanted.size) return result
      const records = await ctx.sessionQuery.listSessions()
      const listed = await ctx.sessionController.list({})
      if (!Array.isArray(records) || !Array.isArray(listed?.items)) fail('READ_UNAVAILABLE')
      // Filter IDs before touching any projection; never derive titles from bodies.
      const metadata = new Map(listed.items.filter(item => wanted.has(item.sessionId)).map(item => [item.sessionId, item]))
      for (const record of records) {
        const header = record.header
        if (!wanted.has(header?.id)) continue
        const item = metadata.get(header.id)
        if (header.origin === 'subagent' || header.parentSession !== undefined || item?.origin === 'subagent' || item?.parentSessionId !== undefined) continue
        const title = item?.projections?.values?.title
        result.set(header.id, { title: typeof title === 'string' ? title : '', created_at: header.createdAt, updated_at: item?.updatedAt ?? header.createdAt, live: record.live === true, origin: header.origin })
      }
      return result
    }),
    events: safe(async (id, options = {}) => {
      identifier(id)
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_ARGUMENT')
      const { afterSeq = -1, throughSeq, revision, scanLimit = 200 } = options
      if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 200 || (throughSeq === undefined) !== (revision === undefined) || (throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < -1 || afterSeq > throughSeq || typeof revision !== 'string' || !revision))) fail('INVALID_ARGUMENT')
      const live = ctx.sessions.get(id)
      if (live !== undefined) {
        const identity = liveIdentity(live, id), seq = live.seq
        if (!Number.isSafeInteger(seq) || seq < 0) fail('READ_UNAVAILABLE')
        const cut = throughSeq ?? seq - 1
        if (cut >= seq) fail('STALE_READ')
        if (afterSeq > cut) fail('INVALID_ARGUMENT')
        const currentRevision = digest(['live', identity, cut])
        if (revision !== undefined && revision !== currentRevision) fail('STALE_READ')
        const from = afterSeq + 1, end = Math.min(cut + 1, from + scanLimit)
        const events = validateEvents(live.snapshotEvents(from, end), from, end)
        if (ctx.sessions.get(id) !== live || digest(liveIdentity(live, id)) !== digest(identity) || live.seq <= cut) fail('STALE_READ')
        return { events, throughSeq: cut, revision: currentRevision }
      }
      const signal = AbortSignal.timeout(10000)
      const before = statIdentity(await ctx.sessionPersistence.stat(id, { signal }), id)
      const handle = await ctx.sessionPersistence.open(id, 'read', { signal })
      try {
        if (!handle || typeof handle.close !== 'function') fail('READ_UNAVAILABLE')
        if (digest(headerIdentity(handle.header, id)) !== digest(before[0])) fail('STALE_READ')
        // The official API may decode the whole compressed artifact before slicing.
        // Physical size and returned event bounds cannot bound predecode expansion.
        const loaded = await handle.read(0, MAX_EVENTS + 1, { signal })
        if (!Array.isArray(loaded?.events)) fail('READ_UNAVAILABLE')
        if (loaded.events.length > MAX_EVENTS) fail('READ_TOO_LARGE')
        validateEvents(loaded.events, 0, loaded.events.length)
        const observed = await ctx.sessionPersistence.stat(id, { signal })
        if (!observed || observed.revision !== before[1]) fail('STALE_READ')
        const after = statIdentity(observed, id)
        if (digest(before) !== digest(after) || ctx.sessions.get(id) !== undefined) fail('STALE_READ')
        const cut = throughSeq ?? loaded.events.length - 1
        if (cut >= loaded.events.length) fail('STALE_READ')
        if (afterSeq > cut) fail('INVALID_ARGUMENT')
        const currentRevision = digest(['cold', before, cut])
        if (revision !== undefined && revision !== currentRevision) fail('STALE_READ')
        const from = afterSeq + 1, end = Math.min(cut + 1, from + scanLimit)
        return { events: loaded.events.slice(from, end), throughSeq: cut, revision: currentRevision }
      } finally { await handle?.close() }
    }),
  }
}
