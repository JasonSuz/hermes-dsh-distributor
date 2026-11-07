import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, ROUTE, name, VERSION } from '../index.mjs'
import http from 'node:http'

function context(routes) {
  const effects = []
  return {
    effect: fn => effects.push(fn()),
    dispose: async () => { for (const effect of effects.reverse()) await effect?.() },
    llm: {}, agents: {}, tools: {}, agentPresets: {},
    webServer: { register: route => {
      if (routes.has(route.path)) throw new Error('duplicate route')
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } },
  }
}
test('plugin routes and exclusive owner release across scoped unload and reload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-router-index-'))
  const routes = new Map()
  const first = context(routes)
  await apply(first, { home })
  assert.deepEqual([...routes.keys()], [ROUTE, ROUTE + '/health'])
  await access(join(home, 'state', '.owner.lock'))
  await first.dispose()
  assert.equal(routes.size, 0)
  await assert.rejects(access(join(home, 'state', '.owner.lock')), { code: 'ENOENT' })
  const second = context(routes)
  await apply(second, { home })
  assert.equal(routes.size, 2)
  await second.dispose()
  assert.equal(routes.size, 0)
})
test('public package, Cordis identity and health use the distributor name', async t => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(name, 'hermes-dsh-distributor')
  assert.equal(pkg.name, name)
  assert.equal(pkg.version, VERSION)
  assert.ok(patch.includes(`id: ${name}\n`))
  assert.ok(patch.includes(`name: '${name}'`))
  const home = await mkdtemp(join(tmpdir(), 'distributor-identity-'))
  const routes = new Map(), ctx = context(routes)
  t.after(() => ctx.dispose())
  await apply(ctx, { home })
  let status, body
  await routes.get(ROUTE + '/health').handler({ socket: { remoteAddress: '127.0.0.1' } }, {
    writeHead: value => { status = value }, end: value => { body = JSON.parse(value) },
  })
  assert.equal(status, 200)
  assert.equal(body.name, name)
  assert.equal(body.version, VERSION)
  assert.equal(body.ok, true)
  assert.equal(body.read_access_enabled, false)
})
test('nonabsolute isolated storage is rejected before any route is mounted', async () => {
  const routes = new Map(), ctx = context(routes)
  await assert.rejects(apply(ctx, { home: 'relative' }), /absolute path/)
  assert.equal(routes.size, 0)
})

test('workspace configuration registers the dedicated Hermes path through the native registry', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-workspace-config-'))
  await writeFile(join(home, 'config.json'), JSON.stringify({ workspacePath: home, allowedRoots: [home] }))
  const ctx = context(new Map()), calls = []
  ctx.workspaceRegistry = { create: async (path, title) => { calls.push({ path, title }); return { path, title, id: 'hermes-id' } } }
  t.after(() => ctx.dispose())
  await apply(ctx, { home })
  assert.deepEqual(calls, [{ path: home, title: 'Hermes' }])
})
test('optional readonly configuration mounts ten tools and reads synthetic memory without agents', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-read-config-'))
  await writeFile(join(home, 'config.json'), JSON.stringify({ readAccess: { workspaceIds: ['w'], globalMemory: true, memoryDir: home, projectIds: { w: '0123456789ab' } } }))
  await writeFile(join(home, 'MEMORY.md'), '[id:12345678] [summary:Synthetic] Test body')
  const routes = new Map(), ctx = context(routes)
  ctx.workspaceRegistry = { get: id => id === 'w' ? { id, title: 'Synthetic workspace', path: home, sessionIds: [] } : undefined }
  ctx.agents.create = () => { throw new Error('Must not create agents') }
  t.after(() => ctx.dispose())
  await apply(ctx, { home })
  const server = http.createServer(routes.get(ROUTE).handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const token = (await readFile(join(home, 'token'), 'utf8')).trim()
  async function rpc(method, params) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return response.json()
  }
  assert.equal((await rpc('tools/list', {})).result.tools.length, 10)
  const result = await rpc('tools/call', { name: 'dsh_memory_search', arguments: { scope: 'memory' } })
  assert.equal(JSON.parse(result.result.content[0].text).items[0].summary, 'Synthetic')
  const spaces = await rpc('tools/call', { name: 'dsh_workspaces', arguments: {} })
  assert.equal(JSON.parse(spaces.result.content[0].text).items[0].workspace_id, 'w')
})

test('invalid readonly policy fails before routes and cannot expand through roots', async () => {
  for (const readAccess of [{ workspaceIds: ['*'], memoryDir: '/tmp', projectIds: {} }, { workspaceIds: ['w'], memoryDir: '/tmp', projectIds: {} }, { workspaceIds: [], memoryDir: 'relative', projectIds: {} }, { workspaceIds: [], memoryDir: '/tmp', projectIds: {}, unknown: true }]) {
    const home = await mkdtemp(join(tmpdir(), 'hermes-read-invalid-'))
    await writeFile(join(home, 'config.json'), JSON.stringify({ readAccess }))
    const routes = new Map(), ctx = context(routes)
    await assert.rejects(apply(ctx, { home }))
    assert.equal(routes.size, 0)
  }
})

test('invalid workspace configuration and differently named existing workspace fail without mounting routes', async () => {
  for (const workspacePath of ['relative', 42, '/dedicated/hermes']) {
    const home = await mkdtemp(join(tmpdir(), 'hermes-workspace-invalid-'))
    await writeFile(join(home, 'config.json'), JSON.stringify({ workspacePath }))
    const routes = new Map(), ctx = context(routes)
    ctx.workspaceRegistry = { create: async path => ({ path, title: 'Unrelated Project', id: 'other' }) }
    await assert.rejects(apply(ctx, { home }), /absolute existing directory|differently named workspace/)
    assert.equal(routes.size, 0)
  }
})
