/**
 * Lead-owned tests: the host-side HTTP surface (loopback guard, CSRF header, actions).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerStatusRoutes, STATUS_PATH, ACTION_PATH, PAGE_PATH, ROUTE_PREFIX } from '../lib/routes.js'
const fakeRes = () => ({
  headersSent: false,
  statusCode: undefined,
  headers: undefined,
  body: undefined,
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true },
  end(body) { this.body = body },
  destroy() { this.destroyed = true },
})

const fakeReq = ({ method = 'GET', url = '/', headers = {}, address = '127.0.0.1', body } = {}) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress: address }
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  return req
}

function harness(overrides = {}) {
  const calls = { kick: [], restart: 0, set: [], reset: 0, unset: [] }
  let handler
  let registered
  const ctx = {
    webServer: {
      register(route) {
        registered = route
        handler = route.handler
        return () => { handler = undefined }
      },
    },
  }
  const api = {
    status: async () => ({ enabled: true, mode: 'tailscale', phase: 'running', clients: [], denied: 0, updatedAt: 1 }),
    kick: async (id) => { calls.kick.push(id); return 2 },
    restart: async () => { calls.restart += 1 },
    set: async (patch) => { calls.set.push(patch); return { ...patch, configOverridden: true } },
    reset: async () => { calls.reset += 1; return { mode: 'tailscale' } },
    unset: async (fields) => { calls.unset.push(fields); return { mode: 'tailscale', port: 8787 } },
    hostSettings: async () => ({ locale: 'zh', theme: { preference: 'dark', fontSize: 14 }, sections: { locale: { preference: 'zh' } }, readAt: 1 }),
    ...overrides,
  }
  const dispose = registerStatusRoutes(ctx, api, { log: () => {}, statusPage: true })
  return { handler, registered, dispose, calls, api }
}

const json = (res) => JSON.parse(String(res.body))

test('routes: registered under the documented prefix', () => {
  const { registered } = harness()
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, ROUTE_PREFIX)
})

test('routes: non-loopback peers are refused on every path', async () => {
  const { handler } = harness()
  for (const url of [STATUS_PATH, ACTION_PATH, PAGE_PATH]) {
    const res = fakeRes()
    await handler(fakeReq({ url, address: '10.0.0.9' }), res)
    assert.equal(res.statusCode, 403, `${url} must be loopback-only`)
  }
})

test('routes: status.json serves the plugin status', async () => {
  const { handler } = harness()
  const res = fakeRes()
  await handler(fakeReq({ url: STATUS_PATH }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = json(res)
  assert.equal(body.phase, 'running')
  assert.equal(body.denied, 0)
})

test('routes: status.json rejects non-GET', async () => {
  const { handler } = harness()
  const res = fakeRes()
  await handler(fakeReq({ url: STATUS_PATH, method: 'POST' }), res)
  assert.equal(res.statusCode, 405)
})

test('routes: actions need the CSRF header and JSON content type', async () => {
  const { handler, calls } = harness()
  const missingHeader = fakeRes()
  await handler(fakeReq({ url: ACTION_PATH, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"restart"}' }), missingHeader)
  assert.equal(missingHeader.statusCode, 403)
  assert.equal(calls.restart, 0)

  const wrongType = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-remote-access-action': '1' },
    body: '{"action":"restart"}',
  }), wrongType)
  assert.equal(wrongType.statusCode, 415)
  assert.equal(calls.restart, 0)
})

test('routes: kick and restart reach the plugin api', async () => {
  const { handler, calls } = harness()
  const kick = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"kick","id":"me@example.com"}',
  }), kick)
  assert.equal(kick.statusCode, 200)
  assert.deepEqual(calls.kick, ['me@example.com'])
  assert.deepEqual(json(kick).result, { kicked: 2 })

  const restart = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"restart"}',
  }), restart)
  assert.equal(restart.statusCode, 200)
  assert.equal(calls.restart, 1)
})

test('routes: malformed and unknown actions are refused', async () => {
  const { handler } = harness()
  const headers = { 'content-type': 'application/json', 'x-remote-access-action': '1' }
  const badJson = fakeRes()
  await handler(fakeReq({ url: ACTION_PATH, method: 'POST', headers, body: '{' }), badJson)
  assert.equal(badJson.statusCode, 400)

  const unknown = fakeRes()
  await handler(fakeReq({ url: ACTION_PATH, method: 'POST', headers, body: '{"action":"nuke"}' }), unknown)
  assert.equal(unknown.statusCode, 400)

  const noId = fakeRes()
  await handler(fakeReq({ url: ACTION_PATH, method: 'POST', headers, body: '{"action":"kick"}' }), noId)
  assert.equal(noId.statusCode, 400)
})

test('routes: status page renders and points at status.json', async () => {
  const { handler } = harness()
  const res = fakeRes()
  await handler(fakeReq({ url: PAGE_PATH }), res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.body), new RegExp(STATUS_PATH.replace(/[/.]/g, '\\$&')))
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/)
})

test('routes: action failures surface as 500 without leaking internals', async () => {
  const { handler } = harness({ kick: async () => { throw new Error('kaboom') } })
  const res = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"kick","id":"x"}',
  }), res)
  assert.equal(res.statusCode, 500)
  assert.equal(json(res).ok, false)
})

test('routes: unknown paths 404 and the disposer is returned', async () => {
  const { handler, dispose } = harness()
  assert.equal(typeof dispose, 'function')
  const res = fakeRes()
  await handler(fakeReq({ url: `${ROUTE_PREFIX}/nope` }), res)
  assert.equal(res.statusCode, 404)
})

test('routes: set writes a validated patch and answers with the new config', async () => {
  const { handler, calls } = harness()
  const res = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"set","patch":{"enabled":true,"port":9001}}',
  }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls.set, [{ enabled: true, port: 9001 }])
  assert.deepEqual(json(res).result.config, { enabled: true, port: 9001, configOverridden: true })
})

test('routes: set without a patch object is a client error', async () => {
  const { handler, calls } = harness()
  for (const body of ['{"action":"set"}', '{"action":"set","patch":[]}', '{"action":"set","patch":"nope"}']) {
    const res = fakeRes()
    await handler(fakeReq({
      url: ACTION_PATH, method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
      body,
    }), res)
    assert.equal(res.statusCode, 400, body)
  }
  assert.deepEqual(calls.set, [])
})

test('routes: a rejected value is a 400 with its code, never a 500', async () => {
  const { handler } = harness({
    set: async () => { throw Object.assign(new Error('port must be between 1024 and 65535'), { code: 'BAD_VALUE' }) },
  })
  const res = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"set","patch":{"port":80}}',
  }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(json(res).code, 'BAD_VALUE')
})

test('routes: reset re-inherits the defaults', async () => {
  const { handler, calls } = harness()
  const res = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"reset"}',
  }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(calls.reset, 1)
  assert.deepEqual(json(res).result.config, { mode: 'tailscale' })
})

test('routes: unset removes fields from the user layer', async () => {
  const { handler, calls } = harness()
  const res = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"unset","fields":["port"]}',
  }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls.unset, [['port']])
  assert.equal(json(res).result.config.port, 8787)

  const bad = fakeRes()
  await handler(fakeReq({
    url: ACTION_PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-remote-access-action': '1' },
    body: '{"action":"unset","fields":[]}',
  }), bad)
  assert.equal(bad.statusCode, 400)
})

test('routes: host-settings.json serves the redacted document to the remote page', async () => {
  const { handler } = harness()
  const res = fakeRes()
  await handler(fakeReq({ url: '/remote-access/host-settings.json' }), res)
  assert.equal(res.statusCode, 200)
  const body = json(res)
  assert.equal(body.locale, 'zh')
  assert.equal(body.theme.preference, 'dark')
  assert.equal(JSON.stringify(body).includes('password'), false, 'secrets never appear')

  const wrongMethod = fakeRes()
  await handler(fakeReq({ url: '/remote-access/host-settings.json', method: 'POST' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
})
