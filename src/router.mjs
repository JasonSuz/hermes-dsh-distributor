import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, open, rename, lstat, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const ACTIVE = new Set(['accepted', 'running', 'canceling'])
const MODES = ['standard', 'ptc']
const START_KEYS = ['request_id', 'prompt', 'cwd', 'provider', 'model', 'reasoning_effort', 'mode', 'agent_preset', 'deadline_ms']
export function fail(code, message) { throw Object.assign(new Error(message), { code }) }
export function fields(args, keys) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !keys.includes(k))) fail('INVALID_ARGUMENT', 'Unexpected argument fields')
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('INVALID_ARGUMENT', `${name} must be a nonempty string (maximum ${max} characters)`)
  return value
}
function specOf(args) {
  fields(args, START_KEYS)
  const spec = {}
  for (const name of ['request_id', 'prompt', 'cwd', 'provider', 'model', 'reasoning_effort', 'mode']) spec[name] = text(args[name], name, name === 'prompt' ? 131072 : name === 'cwd' ? 4096 : 256)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(spec.request_id)) fail('INVALID_ARGUMENT', 'Invalid request_id')
  if (!MODES.includes(spec.mode)) fail('UNSUPPORTED_MODE', 'mode must be standard or ptc')
  spec.agent_preset = text(args.agent_preset ?? 'standard', 'agent_preset')
  spec.deadline_ms = args.deadline_ms ?? 600000
  if (!Number.isInteger(spec.deadline_ms) || spec.deadline_ms < 1000 || spec.deadline_ms > 3600000) fail('INVALID_ARGUMENT', 'deadline_ms must be 1000..3600000')
  if (!isAbsolute(spec.cwd)) fail('INVALID_ARGUMENT', 'cwd must be absolute')
  return spec
}
function hash(spec) { return createHash('sha256').update(JSON.stringify(spec)).digest('hex') }
function snapshot(value) { return structuredClone(value) }
function inside(root, path) { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }

/** Owns admitted jobs. A persisted id is never automatically executed again. */
export class Router {
  constructor({ runtime, stateDir, allowedRoots = [], maxConcurrent = 2, maxRecords = 1000 }) {
    this.runtime = runtime
    this.stateDir = stateDir
    this.allowedRoots = allowedRoots
    this.maxConcurrent = maxConcurrent
    this.maxRecords = maxRecords
    this.records = new Map()
    this.requests = new Map()
    this.workers = new Map()
    this.lock = Promise.resolve()
    this.disk = new Map()
    this.closed = false
  }
  async init() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.stateDir)).isDirectory() || (await lstat(this.stateDir)).isSymbolicLink()) fail('UNSAFE_STATE', 'State directory must be a real directory')
    // Exclusive ownership is fail-closed, including after an unclean process exit.
    this.lockPath = join(await realpath(this.stateDir), '.owner.lock')
    this.owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + '\n'
    let ownerFile
    try { ownerFile = await open(this.lockPath, 'wx', 0o600) }
    catch (error) { if (error.code === 'EEXIST') fail('STATE_IN_USE', 'State has another owner or a stale crash lock; verify all previous DSH owners stopped before manually clearing .owner.lock'); throw error }
    try {
      try { await ownerFile.writeFile(this.owner); await ownerFile.sync() } finally { await ownerFile.close() }
      this.roots = await Promise.all(this.allowedRoots.map(p => realpath(p)))
      await this.loadRecords()
    } catch (error) { await this.releaseOwner(); throw error }
  }
  async releaseOwner() {
    if (!this.lockPath || !this.owner) return
    // The target is the canonical state directory's fixed lock basename; never unlink another owner's lock.
    if (await readFile(this.lockPath, 'utf8').catch(() => '') === this.owner) await unlink(this.lockPath)
    this.owner = null
  }
  async loadRecords() {
    for (const name of await readdir(this.stateDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      const path = join(this.stateDir, name)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('UNSAFE_STATE', 'Unsafe task record')
      const record = JSON.parse(await readFile(path, 'utf8'))
      if (record.task_id + '.json' !== name || !record.requested || hash(record.requested) !== record.input_hash || this.requests.has(record.requested.request_id)) fail('INVALID_STATE', 'Corrupt or duplicate task record')
      if (ACTIVE.has(record.status)) {
        record.status = 'interrupted'
        record.error = { code: 'HOST_RESTARTED', message: 'Execution outcome uncertain after reload; inspect session before creating a new request_id' }
        record.finished_at = new Date().toISOString()
        await this.persist(record)
      }
      this.records.set(record.task_id, record)
      this.requests.set(record.requested.request_id, record.task_id)
    }
  }
  async persist(record) {
    const payload = JSON.stringify(record, null, 2) + '\n'
    const operation = (this.disk.get(record.task_id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const path = join(this.stateDir, record.task_id + '.json')
      const tmp = join(this.stateDir, `.${record.task_id}-${randomUUID()}.tmp`)
      const file = await open(tmp, 'wx', 0o600)
      try { await file.writeFile(payload); await file.sync() } finally { await file.close() }
      await rename(tmp, path)
      const dir = await open(this.stateDir, 'r')
      try { await dir.sync() } finally { await dir.close() }
    })
    this.disk.set(record.task_id, operation)
    return operation
  }
  async capabilities(args = {}) {
    fields(args, [])
    return { ...(await this.runtime.capabilities()), modes: MODES, allowed_roots: [...this.roots], max_concurrent: this.maxConcurrent, result_delivery: 'poll router_get; no public callback or history sync' }
  }
  async start(args) {
    const spec = specOf(args)
    const operation = this.lock.then(async () => {
      if (this.closed) fail('SHUTTING_DOWN', 'Router is stopping')
      const priorId = this.requests.get(spec.request_id)
      if (priorId) {
        const prior = this.records.get(priorId)
        if (prior.input_hash !== hash(spec)) fail('REQUEST_CONFLICT', 'request_id already belongs to different input')
        return snapshot(prior)
      }
      if (this.records.size >= this.maxRecords) fail('RETENTION_LIMIT', 'Task record limit reached; archive state offline before accepting more jobs')
      if (this.workers.size >= this.maxConcurrent) fail('BUSY', 'Concurrent task limit reached; retry later with the same request_id')
      const cwd = await realpath(spec.cwd)
      if (!(await lstat(cwd)).isDirectory() || !this.roots.some(root => inside(root, cwd))) fail('WORKSPACE_DENIED', 'cwd is not an allowed existing workspace')
      const resolved = await this.runtime.validate(spec)
      if (this.closed) fail('SHUTTING_DOWN', 'Router is stopping')
      const record = { task_id: randomUUID(), input_hash: hash(spec), requested: spec, resolved: { ...resolved, cwd }, status: 'accepted', accepted_at: new Date().toISOString(), observed: [], output: '' }
      // Reserve before fallible durability work: a renamed receipt plus fsync error must not permit a second UUID.
      this.records.set(record.task_id, record)
      this.requests.set(spec.request_id, record.task_id)
      try { await this.persist(record) }
      catch (error) {
        record.status = 'interrupted'
        record.error = { code: 'ADMISSION_UNCERTAIN', message: 'Receipt durability failed; no work started. Inspect storage before explicitly submitting a new request_id.' }
        throw error
      }
      const worker = { controller: new AbortController(), promise: null }
      this.workers.set(record.task_id, worker)
      // The worker owns its rejection; a response timeout must not enqueue another job.
      worker.promise = this.execute(record, worker).catch(error => { this.lastPersistenceError = String(error.message) }).finally(() => this.workers.delete(record.task_id))
      return snapshot(record)
    })
    this.lock = operation.catch(() => {})
    return operation
  }
  record(args) {
    fields(args, ['task_id'])
    text(args.task_id, 'task_id')
    const record = this.records.get(args.task_id)
    if (!record) fail('NOT_FOUND', 'Unknown task_id')
    return record
  }
  get(args) { return snapshot(this.record(args)) }
  async cancel(args) {
    const record = this.record(args)
    const worker = this.workers.get(record.task_id)
    if (worker && ACTIVE.has(record.status)) {
      record.status = 'canceling'
      worker.controller.abort(Object.assign(new Error('Canceled by caller'), { code: 'CANCELED' }))
      await this.persist(record)
    }
    return snapshot(record)
  }
  async execute(record, worker) {
    const timer = setTimeout(() => worker.controller.abort(Object.assign(new Error('Task deadline exceeded'), { code: 'TIMED_OUT' })), record.requested.deadline_ms)
    timer.unref?.()
    try {
      record.status = 'running'
      record.started_at = new Date().toISOString()
      await this.persist(record)
      worker.controller.signal.throwIfAborted()
      const result = await this.runtime.run(record, worker.controller.signal, async patch => {
        Object.assign(record, patch)
        await this.persist(record)
      })
      worker.controller.signal.throwIfAborted()
      Object.assign(record, result, { status: 'completed' })
    } catch (error) {
      const reason = worker.controller.signal.aborted ? worker.controller.signal.reason : error
      const code = reason?.code ?? 'EXECUTION_FAILED'
      record.status = code === 'CANCELED' ? 'canceled' : code === 'TIMED_OUT' ? 'timed_out' : code === 'PLUGIN_UNLOADED' ? 'interrupted' : 'failed'
      record.error = { code, message: String(reason?.message ?? reason).slice(0, 4096) }
    } finally {
      clearTimeout(timer)
      record.finished_at = new Date().toISOString()
      await this.persist(record)
    }
  }
  async close() {
    this.closed = true
    await this.lock
    for (const worker of this.workers.values()) worker.controller.abort(Object.assign(new Error('Plugin unloaded'), { code: 'PLUGIN_UNLOADED' }))
    await Promise.all([...this.workers.values()].map(worker => worker.promise))
    await this.releaseOwner()
  }
}
