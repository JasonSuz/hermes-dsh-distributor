import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, ROUTE, name, VERSION } from '../index.mjs'

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
})
test('nonabsolute isolated storage is rejected before any route is mounted', async () => {
  const routes = new Map(), ctx = context(routes)
  await assert.rejects(apply(ctx, { home: 'relative' }), /absolute path/)
  assert.equal(routes.size, 0)
})
