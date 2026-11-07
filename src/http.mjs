import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { readTools, readMethods } from './read-tools.mjs'

const MAX_BODY_BYTES = 256 * 1024
const READ_TIMEOUT_MS = 5000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const only = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key))
const emptySchema = { type: 'object', properties: {}, additionalProperties: false }
const taskSchema = { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }
const tools = [
  { name: 'router_capabilities', description: 'Inspect available exact model routes and execution capabilities.', inputSchema: emptySchema },
  { name: 'router_start', description: 'Start an idempotent task with an explicit model route and reasoning effort.', inputSchema: {
    type: 'object', properties: {
      request_id: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, reasoning_effort: { type: 'string' },
      mode: { type: 'string', enum: ['standard', 'ptc'] }, agent_preset: { type: 'string' }, deadline_ms: { type: 'integer', minimum: 1000, maximum: 3600000 },
    }, required: ['request_id', 'prompt', 'cwd', 'provider', 'model', 'reasoning_effort', 'mode'], additionalProperties: false,
  } },
  { name: 'router_get', description: 'Read task state and results.', inputSchema: taskSchema },
  { name: 'router_cancel', description: 'Request cancellation of a task.', inputSchema: taskSchema },
]
const methods = { router_capabilities: 'capabilities', router_start: 'start', router_get: 'get', router_cancel: 'cancel' }

function validArguments(schema, args) {
  if (!only(args, Object.keys(schema.properties))) return false
  if ((schema.required || []).some(key => !Object.hasOwn(args, key))) return false
  return Object.entries(args).every(([key, value]) => {
    const property = schema.properties[key]
    if (property.type === 'integer') return Number.isInteger(value) && value >= property.minimum && value <= property.maximum
    return typeof value === property.type && (!property.enum || property.enum.includes(value))
  })
}

function loopback(address) {
  if (typeof address !== 'string') return false
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address
  return isIP(ipv4) === 4 && ipv4.startsWith('127.')
}

function acceptsJsonResponse(header) {
  if (header === undefined) return true
  return String(header).split(',').some(part => {
    const [type, ...parameters] = part.trim().toLowerCase().split(';')
    const quality = parameters.find(p => p.trim().startsWith('q='))
    if (quality && !(Number(quality.trim().slice(2)) > 0)) return false
    return ['application/json', 'text/event-stream', '*/*', 'application/*', 'text/*'].includes(type.trim())
  })
}

function send(res, status, body, close = false) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(close ? { connection: 'close' } : {}) })
  res.end(status === 204 ? undefined : JSON.stringify(body))
}
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      // IncomingMessage may emit 'error' after 'aborted'; keep the guarded
      // error listener until close so a disconnected client cannot crash Node.
      req.off('aborted', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onError = () => finish(Object.assign(new Error('Request body interrupted'), { status: 400 }))
    const onAbort = onError
    const onData = chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) finish(Object.assign(new Error('Request body too large'), { status: 413 }))
      else chunks.push(chunk)
    }
    const onEnd = () => finish(null, Buffer.concat(chunks))
    const timer = setTimeout(() => finish(Object.assign(new Error('Request body read timeout'), { status: 408 })), READ_TIMEOUT_MS)
    req.on('data', onData)
    req.once('end', onEnd)
    req.on('error', onError)
    req.once('close', () => req.off('error', onError))
    req.once('aborted', onAbort)
  })
}

/** Stateless JSON-response MCP adapter. Mount on an exact route; never creates a listener. */
export function createRpcHandler(service, { token, readAccess } = {}) {
  const catalog = readAccess ? [...tools, ...readTools] : tools
  if (typeof token !== 'string' || !token || /\s/.test(token)) throw new TypeError('A nonempty whitespace-free bearer token is required')
  const expected = createHash('sha256').update(token).digest()
  return async function rpcHandler(req, res) {
    // Every denial returns immediately, before parsing or invoking the service.
    if (!loopback(req.socket?.remoteAddress)) return send(res, 403, { error: 'Loopback access required' }, true)
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'Browser origins are not permitted' }, true)
    const authorization = req.headers.authorization
    const match = typeof authorization === 'string' && /^Bearer ([^\s]+)$/i.exec(authorization)
    const received = createHash('sha256').update(match ? match[1] : '').digest()
    if (!timingSafeEqual(expected, received) || !match) return send(res, 401, { error: 'Unauthorized' }, true)
    if ((req.url || '').includes('?')) return send(res, 400, { error: 'Query parameters are not supported' }, true)
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' }, true)
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'application/json required' }, true)
    if (!acceptsJsonResponse(req.headers.accept)) return send(res, 406, { error: 'A JSON-compatible response must be accepted' }, true)
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return send(res, 413, { error: 'Request body too large' }, true)
    let bytes
    try { bytes = await readBody(req) }
    catch (error) { return send(res, error.status || 400, { error: error.message }, true) }
    let input
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { return send(res, 200, rpcError(null, -32700, 'Parse error')) }
    const validId = value => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    const hasId = object(input) && Object.hasOwn(input, 'id')
    const id = hasId && validId(input.id) ? input.id : null
    if (!only(input, ['jsonrpc', 'id', 'method', 'params']) || input.jsonrpc !== '2.0' || typeof input.method !== 'string' || (hasId && !validId(input.id)) || (Object.hasOwn(input, 'params') && !object(input.params))) {
      return send(res, 200, rpcError(id, -32600, 'Invalid Request'))
    }
    // Notifications are never a job-launch mechanism. In particular a tools/call
    // without an id cannot cause unobservable paid work or cancellation.
    if (!hasId) return send(res, 204)
    const params = { ...input.params }
    const fail = (code, message) => send(res, 200, rpcError(id, code, message))
    const success = result => send(res, 200, { jsonrpc: '2.0', id, result })
    // MCP SDKs attach transport metadata such as progressToken. Validate its
    // container, then strip it: metadata must not become business arguments.
    if (Object.hasOwn(params, '_meta')) {
      if (!object(params._meta)) return fail(-32602, 'Invalid params')
      delete params._meta
    }
    if (input.method === 'initialize') {
      if (!only(params, ['protocolVersion', 'capabilities', 'clientInfo']) || (Object.hasOwn(params, 'protocolVersion') && typeof params.protocolVersion !== 'string') || (Object.hasOwn(params, 'capabilities') && !object(params.capabilities)) || (Object.hasOwn(params, 'clientInfo') && !object(params.clientInfo))) return fail(-32602, 'Invalid params')
      return success({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hermes-dsh-distributor', version: '0.1.5' } })
    }
    if (input.method === 'ping') {
      if (Object.keys(params).length) return fail(-32602, 'Invalid params')
      return success({})
    }
    if (input.method === 'tools/list') {
      if (!only(params, ['cursor']) || (Object.hasOwn(params, 'cursor') && params.cursor !== null && params.cursor !== '')) return fail(-32602, 'Invalid params')
      return success({ tools: catalog })
    }
    if (input.method !== 'tools/call') return fail(-32601, 'Method not found')
    if (!only(params, ['name', 'arguments']) || typeof params.name !== 'string') return fail(-32602, 'Invalid params')
    const entry = catalog.find(item => item.name === params.name)
    if (!entry) return fail(-32602, 'Unknown tool')
    const args = Object.hasOwn(params, 'arguments') ? params.arguments : {}
    if (!validArguments(entry.inputSchema, args)) return fail(-32602, 'Invalid tool arguments')
    try {
      const result = Object.hasOwn(readMethods, params.name)
        ? await readAccess.invoke(readMethods[params.name], args)
        : await service[methods[params.name]](args)
      return success({ content: [{ type: 'text', text: JSON.stringify(result ?? null) }], isError: false })
    } catch (error) {
      const known = typeof error?.code === 'string' && error.code.length > 0
      const detail = { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known && typeof error.message === 'string' ? error.message : 'Task router service failed' } }
      return success({ content: [{ type: 'text', text: JSON.stringify(detail) }], isError: true })
    }
  }
}
