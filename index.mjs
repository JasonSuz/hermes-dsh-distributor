import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { Router, fields } from './src/router.mjs'
import { createRuntime } from './src/runtime.mjs'
import { createRpcHandler } from './src/http.mjs'

export const name = 'hermes-dsh-distributor'
export const inject = ['webServer', 'agents', 'llm', 'agentPresets', 'tools', 'workspaceRegistry']
export const VERSION = '0.1.4'
export const ROUTE = '/mcp/task-router/v1'
export async function apply(ctx, options = {}) {
  const home = options.home ?? join(homedir(), '.dsh', 'integrations', 'hermes-task-router')
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Task-router home must be an absolute path')
  await mkdir(home, { recursive: true, mode: 0o700 })
  let config = {}
  try { config = JSON.parse(await readFile(options.configFile ?? join(home, 'config.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  fields(config, ['allowedRoots', 'maxConcurrent', 'workspacePath'])
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
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createRpcHandler(router, { token }) }), 'task-router.rpc')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE + '/health', handler: async (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: !router.closed && !router.lastPersistenceError, name, version: VERSION, configured_workspaces: router.roots.length }))
  } }), 'task-router.health')
}
