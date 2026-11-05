import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRpcHandler } from '../src/http.mjs'

const token = 'test-only-router-secret'
const valid = { request_id: 'request-1', prompt: 'Implement a small task', cwd: '/tmp/work', provider: 'subscription', model: 'example-model', reasoning_effort: 'medium', mode: 'standard' }
async function fixture(t, { remoteAddress, failure } = {}) {
  const calls = []
  const service = Object.fromEntries(['capabilities', 'start', 'get', 'cancel'].map(name => [name, async args => {
    calls.push([name, args])
    if (failure) throw failure
    return { method: name, args }
  }]))
  const handler = createRpcHandler(service, { token })
  const server = http.createServer((req, res) => {
    if (remoteAddress) Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true })
    handler(req, res).catch(error => { res.destroy(error) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port
  async function request(body, { headers = {}, method = 'POST', path = '/mcp/task-router' } = {}) {
    return new Promise((resolve, reject) => {
      const outgoingHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }
      for (const [key, value] of Object.entries(outgoingHeaders)) if (value === null) delete outgoingHeaders[key]
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: outgoingHeaders }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null }))
      })
      req.on('error', reject)
      req.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  }
  return { request, calls, port }
}
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const tool = (name, args = {}, id = 1) => rpc('tools/call', { name, arguments: args }, id)

test('stateless initialize, ping, id zero and discovery', async t => {
  const { request, calls } = await fixture(t)
  const init = await request(rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 0))
  assert.equal(init.status, 200)
  assert.equal(init.json.id, 0)
  assert.equal(init.json.result.protocolVersion, '2024-11-05')
  assert.equal(init.json.result.serverInfo.version, '0.1.3')
  assert.equal(init.json.result.serverInfo.name, 'hermes-dsh-distributor')
  assert.deepEqual((await request(rpc('ping'))).json.result, {})
  const discovery = (await request(rpc('tools/list'))).json.result.tools
  assert.deepEqual(discovery.map(x => x.name), ['router_capabilities', 'router_start', 'router_get', 'router_cancel'])
  for (const entry of discovery) assert.equal(entry.inputSchema.additionalProperties, false)
  const start = discovery.find(x => x.name === 'router_start').inputSchema
  assert.deepEqual(start.required, ['request_id', 'prompt', 'cwd', 'provider', 'model', 'reasoning_effort', 'mode'])
  assert.deepEqual(start.properties.mode.enum, ['standard', 'ptc'])
  assert.equal(start.properties.deadline_ms.minimum, 1000)
  assert.equal(start.properties.deadline_ms.maximum, 3600000)
  assert.deepEqual(calls, [])
})

test('valid tool calls forward exact inputs, defaults stay in core', async t => {
  const { request, calls } = await fixture(t)
  for (const [name, args] of [['router_capabilities', {}], ['router_start', valid], ['router_start', { ...valid, mode: 'ptc', agent_preset: 'code', deadline_ms: 1000 }], ['router_get', { task_id: 'task-1' }], ['router_cancel', { task_id: 'task-1' }]]) {
    const reply = await request(tool(name, args))
    assert.equal(reply.status, 200)
    assert.equal(reply.json.result.isError, false)
    assert.deepEqual(JSON.parse(reply.json.result.content[0].text).args, args)
  }
  assert.deepEqual(calls.map(x => x[0]), ['capabilities', 'start', 'start', 'get', 'cancel'])
  assert.equal(Object.hasOwn(calls[1][1], 'deadline_ms'), false)
  assert.deepEqual((await request(rpc('tools/call', { name: 'router_capabilities' }))).json.result.isError, false)
})

test('SDK metadata is accepted but never forwarded to service', async t => {
  const { request, calls } = await fixture(t)
  const _meta = { progressToken: 'hermes-progress-1', 'sdk.example/request': { value: true } }
  assert.ok((await request(rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hermes', version: '1' }, _meta }))).json.result)
  assert.deepEqual((await request(rpc('ping', { _meta }))).json.result, {})
  for (const cursor of [undefined, null, '']) {
    const params = { _meta, ...(cursor === undefined ? {} : { cursor }) }
    assert.equal((await request(rpc('tools/list', params))).json.result.tools.length, 4)
  }
  for (const [name, args] of [['router_capabilities', {}], ['router_start', valid], ['router_get', { task_id: 'task-1' }], ['router_cancel', { task_id: 'task-1' }]]) {
    const reply = await request(rpc('tools/call', { name, arguments: args, _meta }))
    assert.equal(reply.json.result.isError, false)
    assert.deepEqual(JSON.parse(reply.json.result.content[0].text).args, args)
  }
  assert.deepEqual(calls, [['capabilities', {}], ['start', valid], ['get', { task_id: 'task-1' }], ['cancel', { task_id: 'task-1' }]])
})

test('invalid SDK metadata and cursors fail without business service calls', async t => {
  const { request, calls } = await fixture(t)
  for (const _meta of [null, [], 'metadata', 1, false]) {
    for (const input of [rpc('initialize', { _meta }), rpc('ping', { _meta }), rpc('tools/list', { _meta }), rpc('tools/call', { name: 'router_start', arguments: valid, _meta })]) {
      assert.equal((await request(input)).json.error.code, -32602)
    }
  }
  for (const cursor of ['next-page', 0, false, {}, []]) assert.equal((await request(rpc('tools/list', { cursor, _meta: {} }))).json.error.code, -32602)
  assert.equal((await request(rpc('ping', { cursor: '', _meta: {} }))).json.error.code, -32602)
  assert.equal((await request(rpc('tools/list', { cursor: '', _meta: {}, extra: true }))).json.error.code, -32602)
  assert.equal((await request(tool('router_start', { ...valid, _meta: {} }))).json.error.code, -32602)
  assert.deepEqual(calls, [])
})

test('wrong, missing and query authentication never reach service', async t => {
  const { request, calls } = await fixture(t)
  for (const authorization of [null, '', 'Bearer wrong', 'Basic anything', `Bearer ${token}x`]) {
    const reply = await request(tool('router_start', valid), { headers: { authorization } })
    assert.equal(reply.status, 401)
    assert.ok(!reply.text.includes(token))
  }
  assert.equal((await request(tool('router_start', valid), { path: `/mcp/task-router?token=${token}`, headers: { authorization: '' } })).status, 401)
  assert.equal((await request(tool('router_start', valid), { path: '/mcp/task-router?anything=1' })).status, 400)
  assert.deepEqual(calls, [])
})

test('loopback and browser-origin guard deny before service', async t => {
  for (const address of ['203.0.113.7', '::ffff:192.0.2.1', '127.0.0.1.evil']) {
    const { request, calls } = await fixture(t, { remoteAddress: address })
    assert.equal((await request(tool('router_start', valid))).status, 403)
    assert.deepEqual(calls, [])
  }
  const { request, calls } = await fixture(t)
  for (const origin of ['http://127.0.0.1:49254', 'null', '']) assert.equal((await request(tool('router_start', valid), { headers: { origin } })).status, 403)
  assert.deepEqual(calls, [])
})

test('IPv6 and IPv4-mapped loopback accepted', async t => {
  for (const address of ['::1', '::ffff:127.0.0.1']) {
    const { request } = await fixture(t, { remoteAddress: address })
    assert.equal((await request(rpc('ping'))).status, 200)
  }
})

test('unknown methods/tools, malformed envelopes and extra args never call service', async t => {
  const { request, calls } = await fixture(t)
  const bad = [rpc('missing'), tool('missing', valid), { ...rpc('ping'), extra: true }, { id: 1, method: 'ping' }, rpc('ping', { extra: true }), tool('router_start', { ...valid, maxTokens: 5 }), tool('router_start', { ...valid, deadline_ms: 999 }), tool('router_start', { ...valid, deadline_ms: 3600001 }), tool('router_start', { ...valid, deadline_ms: 1000.5 }), tool('router_start', { ...valid, mode: 'unknown' }), tool('router_start', { ...valid, provider: 12 }), tool('router_get', { task_id: 'a', extra: 1 }), tool('router_cancel', {}), tool('router_capabilities', { extra: 1 }), rpc('tools/call', { name: 'router_get', arguments: { task_id: 'a' }, extra: 1 }), rpc('tools/list', { cursor: 'unsupported' }), rpc('tools/call', { name: 'router_start' })]
  const withoutPrompt = { ...valid }; delete withoutPrompt.prompt; bad.push(tool('router_start', withoutPrompt))
  for (const input of bad) {
    const reply = await request(input)
    assert.equal(reply.status, 200)
    assert.ok(reply.json.error, JSON.stringify(input))
  }
  assert.deepEqual(calls, [])
})

test('notifications return 204 and do not launch tools', async t => {
  const { request, calls } = await fixture(t)
  for (const input of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'ping' }, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'router_start', arguments: valid } }]) {
    const reply = await request(input)
    assert.equal(reply.status, 204)
    assert.equal(reply.text, '')
  }
  assert.deepEqual(calls, [])
})

test('service failure returns MCP tool error not protocol error', async t => {
  const { request } = await fixture(t, { failure: Object.assign(new Error('Unsupported effort'), { code: 'UNSUPPORTED_EFFORT' }) })
  const reply = await request(tool('router_start', valid))
  assert.equal(reply.status, 200)
  assert.equal(reply.json.result.isError, true)
  assert.deepEqual(JSON.parse(reply.json.result.content[0].text), { error: { code: 'UNSUPPORTED_EFFORT', message: 'Unsupported effort' } })
})

test('HTTP method/media/accept guards, malformed JSON, batch and oversized bodies', async t => {
  const { request, calls } = await fixture(t)
  assert.equal((await request(rpc('ping'), { method: 'GET' })).status, 405)
  assert.equal((await request(rpc('ping'), { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await request(rpc('ping'), { headers: { accept: 'text/html' } })).status, 406)
  assert.equal((await request(rpc('ping'), { headers: { accept: 'text/event-stream' } })).status, 200)
  assert.equal((await request(rpc('ping'), { headers: { accept: 'application/json;q=0, text/html' } })).status, 406)
  const pingBody = JSON.stringify(rpc('ping'))
  assert.equal((await request(pingBody.padEnd(256 * 1024, ' '))).status, 200)
  assert.equal((await request('{')).json.error.code, -32700)
  assert.equal((await request([])).json.error.code, -32600)
  assert.equal((await request('null')).json.error.code, -32600)
  assert.equal((await request('x'.repeat(256 * 1024 + 1))).status, 413)
  assert.deepEqual(calls, [])
})

test('streamed oversized body is rejected before service', async t => {
  const { port, calls } = await fixture(t)
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp/task-router', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject)
    req.write('x'.repeat(128 * 1024)); req.end('x'.repeat(128 * 1024 + 1))
  })
  assert.equal(result, 413)
  assert.deepEqual(calls, [])
})

test('unfinished body has a bounded read timeout', { timeout: 10000 }, async t => {
  const { port, calls } = await fixture(t)
  const start = Date.now()
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp/task-router', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '100' } }, res => { res.resume(); res.on('end', () => { req.destroy(); resolve(res.statusCode) }) })
    req.on('error', reject)
    req.write('{')
  })
  assert.equal(result, 408)
  assert.ok(Date.now() - start < 8000)
  assert.deepEqual(calls, [])
})

test('aborted body does not call service or crash the request handler', async t => {
  const { port, calls, request } = await fixture(t)
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp/task-router', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '100' } })
    req.on('error', () => {})
    req.on('close', resolve)
    req.write('{', () => req.destroy())
  })
  assert.equal((await request(rpc('ping'))).status, 200)
  assert.deepEqual(calls, [])
})

test('empty or missing configured token fails closed at construction', () => {
  for (const value of [undefined, '', '   ', 12]) assert.throws(() => createRpcHandler({}, { token: value }), /token/i)
})
