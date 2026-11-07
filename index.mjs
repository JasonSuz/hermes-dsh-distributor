import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { Router, fields } from './src/router.mjs'
import { createRuntime } from './src/runtime.mjs'
import { createRpcHandler } from './src/http.mjs'
import { ReadAccess, validateReadPolicy } from './src/read-access.mjs'
import { createMemoryReader } from './src/read-memory.mjs'
import { createSessionReader } from './src/read-sessions.mjs'

export const name = 'hermes-dsh-distributor'
export const inject = ['webServer', 'agents', 'llm', 'agentPresets', 'tools', 'workspaceRegistry', 'sessionQuery', 'sessionController', 'sessions', 'sessionPersistence']
export const VERSION = '0.1.5'
export const ROUTE = '/mcp/task-router/v1'
export async function apply(ctx, options = {}) {
  const home = options.home ?? join(homedir(), '.dsh', 'integrations', 'hermes-task-router')
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Task-router home must be an absolute path')
  await mkdir(home, { recursive: true, mode: 0o700 })
  let config = {}
  try { config = JSON.parse(await readFile(options.configFile ?? join(home, 'config.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  fields(config, ['allowedRoots', 'maxConcurrent', 'workspacePath', 'readAccess'])
  let readAccess
  if (config.readAccess !== undefined) {
    fields(config.readAccess, ['workspaceIds', 'globalMemory', 'memoryDir', 'projectIds'])
    const { workspaceIds, globalMemory, memoryDir, projectIds } = config.readAccess
    const policy = validateReadPolicy({ workspaceIds, globalMemory })
    if (typeof memoryDir !== 'string' || !isAbsolute(memoryDir)) throw new Error('readAccess.memoryDir must be an explicitly verified absolute memory root')
    if (!projectIds || typeof projectIds !== 'object' || Array.isArray(projectIds) || Object.keys(projectIds).some(id => !policy.workspaceIds.includes(id)) || policy.workspaceIds.some(id => !Object.hasOwn(projectIds, id))) throw new Error('readAccess.projectIds must pin one memory project ID for each authorized workspace')
    const memories = await createMemoryReader({ memoryDir, projectIds })
    readAccess = new ReadAccess({ backend: { ...createSessionReader(ctx), memories }, policy })
  }
  let workspace
  if (config.workspacePath !== undefined) {
    if (typeof config.workspacePath !== 'string' || !isAbsolute(config.workspacePath)) throw new Error('workspacePath must be an absolute existing directory')
    workspace = await ctx.workspaceRegistry.create(config.workspacePath, 'Hermes')
    if (workspace.title !== 'Hermes') throw new Error('workspacePath already belongs to a differently named workspace; choose a dedicated Hermes directory')
  }
  if (!Array.isArray(config.allowedRoots ?? []) || !(config.allowedRoots ?? []).every(p => typeof p === 'string')) throw new Error('allowedRoots must be a list of existing workspace paths')
  if (config.maxConcurrent !== undefined && (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 8)) throw new Error('maxConcurrent must be 1..8')
  const tokenPath = join(home, 'token')
  try { await writeFile(tokenPath, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = await lstat(tokenPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Task-router token must be a private regular file (0600)')
  const token = (await readFile(tokenPath, 'utf8')).trim()
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Task-router token must contain 32 random bytes encoded as hex')
  const router = new Router({ runtime: createRuntime(ctx, { workspace }), stateDir: join(home, 'state'), allowedRoots: config.allowedRoots ?? [], maxConcurrent: config.maxConcurrent ?? 2 })
  await router.init()
  ctx.effect(() => () => router.close(), 'task-router.lifecycle')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createRpcHandler(router, { token, readAccess }) }), 'task-router.rpc')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE + '/health', handler: async (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: !router.closed && !router.lastPersistenceError, name, version: VERSION, configured_workspaces: router.roots.length, read_access_enabled: Boolean(readAccess) }))
  } }), 'task-router.health')
}
