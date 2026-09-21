/**
 * End-to-end tests for the front door (lib/proxy.js) against a fake "harness"
 * upstream that enforces exactly what the real one enforces: the loopback Host
 * authority and its own browser cookie.
 *
 * Everything runs on 127.0.0.1 with ephemeral ports; no network access, no
 * long-lived services, and nothing touches a running dsh.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import {
  createFrontDoor,
  clientAddress,
  passwordMatches,
  LOGIN_PATH,
  HEALTH_PATH,
  SESSION_COOKIE,
} from '../lib/proxy.js'

const HARNESS_COOKIE = 'dsh-auth-test=harness-cookie-value'
const PASSWORD = 'correct horse battery staple'
const UPGRADED = 'UPGRADED'

/** Fake harness: loopback authority + its own cookie, or 403/401. */
function startUpstream() {
  return new Promise((resolve) => {
    const seen = []
    const sockets = new Set()
    const server = http.createServer((req, res) => {
      const record = {
        url: req.url,
        method: req.method,
        host: req.headers.host,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        referer: req.headers.referer,
        secFetchSite: req.headers['sec-fetch-site'],
        identity: req.headers['tailscale-user-login'],
        identityName: req.headers['tailscale-user-name'],
        forwardedFor: req.headers['x-forwarded-for'],
        forwardedProto: req.headers['x-forwarded-proto'],
      }
      seen.push(record)
      if (record.host !== `127.0.0.1:${String(server.address().port)}`) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('upstream: bad host')
        return
      }
      if (record.cookie !== HARNESS_COOKIE) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('upstream: bad cookie')
        return
      }
      if (req.url.startsWith('/chunked')) {
        // Hop-by-hop headers the proxy must not forward, plus chunked framing
        // that has to survive dropping `transfer-encoding`.
        res.writeHead(200, {
          'content-type': 'text/plain',
          'transfer-encoding': 'chunked',
          connection: 'keep-alive, x-hop-test',
          'x-hop-test': 'leak',
          'set-cookie': 'dsh-auth-test=leaked; Path=/',
        })
        res.write('CHUNK-A')
        res.write('CHUNK-B')
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': 'dsh-auth-test=leaked; Path=/',
        connection: 'keep-alive, x-hop-test',
        'x-hop-test': 'leak',
      })
      res.end('UPSTREAM OK')
    })
    server.on('upgrade', (req, socket) => {
      const record = {
        url: req.url,
        upgrade: true,
        host: req.headers.host,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        identity: req.headers['tailscale-user-login'],
      }
      seen.push(record)
      const goodHost = record.host === `127.0.0.1:${String(server.address().port)}`
      if (!goodHost || record.cookie !== HARNESS_COOKIE) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.write(UPGRADED)
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    // Upgraded sockets keep the server's connection counter alive forever, so
    // tear them down explicitly and never await a callback that cannot fire.
    const close = () => new Promise((done) => {
      const settle = () => done()
      try {
        server.close(settle)
      } catch {
        settle()
      }
      for (const socket of [...sockets]) {
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
      }
      sockets.clear()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      const timer = setTimeout(settle, 200)
      if (typeof timer.unref === 'function') timer.unref()
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen, close }))
  })
}

async function startDoor(upstreamPort, overrides = {}) {
  const door = createFrontDoor({
    mode: 'none',
    port: 0,
    host: '127.0.0.1',
    upstreamHost: '127.0.0.1',
    upstreamPort,
    password: PASSWORD,
    resolveUpstreamCookie: async () => HARNESS_COOKIE,
    log: () => {},
    ...overrides,
  })
  const address = await door.listen()
  return { door, port: address.port, base: `http://127.0.0.1:${String(address.port)}` }
}

const baseOf = (port) => `http://127.0.0.1:${String(port)}`

async function login(port, password = PASSWORD, headers = {}) {
  const response = await fetch(`${baseOf(port)}${LOGIN_PATH}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: `password=${encodeURIComponent(password)}`,
  })
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return { response, setCookie, cookie: setCookie.length > 0 ? setCookie[0].split(';')[0] : undefined }
}

const statusOf = (text) => {
  const line = text.slice(0, text.indexOf('\r\n') === -1 ? text.length : text.indexOf('\r\n'))
  const code = Number.parseInt(line.split(' ')[1] ?? '', 10)
  return Number.isInteger(code) ? code : 0
}

/**
 * Hand-rolled WebSocket-style upgrade so the test can keep the socket open
 * (for kick/close assertions). Resolves once the status line and, for a 101,
 * the upstream payload have arrived.
 */
function upgradeRequest(port, { cookie, path = '/api/remote.mux', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let text = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('upgrade timed out'))
    }, 4000)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    socket.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ]
      if (cookie !== undefined) lines.push(`Cookie: ${cookie}`)
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
      lines.push('', '')
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8')
      const status = statusOf(text)
      if (status === 0) return
      if (status !== 101) {
        finish({ socket, text, status })
        return
      }
      if (text.includes(UPGRADED)) finish({ socket, text, status })
    })
    socket.on('close', () => {
      if (!settled) finish({ socket, text, status: statusOf(text) })
    })
    socket.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------

test('front door: password gate, header rewriting and websockets', async (t) => {
  const upstream = await startUpstream()
  const { door, port, base } = await startDoor(upstream.port)
  let session
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  await t.test('unauthenticated GET serves the login page and never reaches the harness', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' })
    assert.equal(response.status, 401)
    const body = await response.text()
    assert.match(body, /Remote access is password protected/)
    assert.match(body, new RegExp(`action="${LOGIN_PATH}"`))
    assert.equal(upstream.seen.length, 0, 'no unauthenticated request may reach the harness')
    assert.ok(door.status().denied >= 1, 'the rejection is counted')
  })

  await t.test('health endpoint answers without a session and without counting as denied', async () => {
    const before = door.status().denied
    const response = await fetch(`${base}${HEALTH_PATH}`)
    assert.equal(response.status, 200)
    assert.equal((await response.text()).trim(), 'ok')
    assert.equal(door.status().denied, before)
    assert.equal(upstream.seen.length, 0)
  })

  await t.test('wrong password is rejected, correct password issues a session cookie', async () => {
    const wrong = await login(port, 'not-the-password')
    assert.equal(wrong.response.status, 401)
    assert.equal(wrong.setCookie.length, 0)
    assert.match(await wrong.response.text(), /Wrong password/)

    const good = await login(port)
    assert.equal(good.response.status, 303)
    assert.equal(good.response.headers.get('location'), '/')
    assert.equal(good.setCookie.length, 1)
    assert.match(good.setCookie[0], new RegExp(`^${SESSION_COOKIE}=`))
    assert.match(good.setCookie[0], /HttpOnly/)
    assert.match(good.setCookie[0], /SameSite=Lax/)
    assert.match(good.setCookie[0], /Max-Age=\d+/)
    assert.doesNotMatch(good.setCookie[0], /Secure/, 'plain HTTP must not mark the cookie Secure')
    assert.equal(upstream.seen.length, 0)
    session = good.cookie
  })

  await t.test('a tunnel TLS hop marks the session cookie Secure', async () => {
    const secure = await login(port, PASSWORD, { 'x-forwarded-proto': 'https' })
    assert.equal(secure.response.status, 303)
    assert.match(secure.setCookie[0], /; Secure/)
  })

  await t.test('authorized request is proxied with a loopback Host, the harness cookie, and no origin', async () => {
    const response = await fetch(`${base}/`, {
      redirect: 'manual',
      headers: {
        cookie: session,
        origin: 'https://random-words-1234.trycloudflare.com',
        referer: 'https://random-words-1234.trycloudflare.com/',
        'sec-fetch-site': 'cross-site',
        // forged claims: the harness must never see them (and the address must
        // not be believed while trustProxyHeaders is off)
        'x-forwarded-for': '10.9.9.9',
        'tailscale-user-login': 'attacker@example.com',
      },
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'UPSTREAM OK')
    const last = upstream.seen.at(-1)
    assert.equal(last.host, `127.0.0.1:${String(upstream.port)}`)
    assert.equal(last.cookie, HARNESS_COOKIE)
    assert.equal(last.origin, undefined)
    assert.equal(last.referer, undefined)
    assert.equal(last.secFetchSite, undefined)
    assert.equal(last.identity, undefined, 'an unvouched identity header never reaches the harness')
    assert.equal(last.forwardedFor, '127.0.0.1', 'the client address is the socket address, not the forged header')
    assert.equal(last.forwardedProto, 'http')
  })

  await t.test('response filters Set-Cookie and hop-by-hop headers without breaking the body', async () => {
    const response = await fetch(`${base}/chunked`, { headers: { cookie: session } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.getSetCookie().length, 0, 'harness Set-Cookie must not leak to the browser')
    assert.equal(response.headers.get('x-hop-test'), null, 'headers named by Connection are hop-by-hop')
    assert.notEqual(response.headers.get('connection'), 'keep-alive, x-hop-test')
    assert.equal(await response.text(), 'CHUNK-ACHUNK-B', 'the body must still read to completion')
    const last = upstream.seen.at(-1)
    assert.equal(last.url, '/chunked')
  })

  await t.test('WebSocket upgrade with the session cookie reaches the harness', async () => {
    const result = await upgradeRequest(port, { cookie: session })
    assert.equal(result.status, 101)
    assert.match(result.text, /UPGRADED/)
    assert.equal(result.socket.destroyed, false)
    result.socket.destroy()
    const last = upstream.seen.at(-1)
    assert.equal(last.upgrade, true)
    assert.equal(last.host, `127.0.0.1:${String(upstream.port)}`)
    assert.equal(last.cookie, HARNESS_COOKIE)
    assert.equal(last.origin, undefined)
  })

  await t.test('WebSocket upgrade without a session is refused and disconnected', async () => {
    const before = upstream.seen.length
    const result = await upgradeRequest(port, {})
    assert.equal(result.status, 401)
    assert.equal(upstream.seen.length, before, 'the harness must not see an unauthenticated upgrade')
    result.socket.destroy()
  })
})

test('front door: a stale harness cookie is re-minted exactly once', async (t) => {
  const upstream = await startUpstream()
  let calls = 0
  const { door, port, base } = await startDoor(upstream.port, {
    resolveUpstreamCookie: async (force) => {
      calls += 1
      t.diagnostic(`resolveUpstreamCookie(force=${String(force)}) -> call #${String(calls)}`)
      return calls === 1 ? 'dsh-auth-test=stale' : HARNESS_COOKIE
    },
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  const { cookie } = await login(port)
  const response = await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'UPSTREAM OK')
  assert.equal(calls, 2, 'the front door must re-mint the harness cookie after a 401')
  assert.equal(upstream.seen.length, 2, 'the failed attempt and the successful retry')
})

test('front door: the websocket upgrade re-mints a stale harness cookie too', async (t) => {
  const upstream = await startUpstream()
  let calls = 0
  const { door, port } = await startDoor(upstream.port, {
    resolveUpstreamCookie: async () => {
      calls += 1
      return calls === 1 ? 'dsh-auth-test=stale' : HARNESS_COOKIE
    },
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  const { cookie } = await login(port)
  const ws = await upgradeRequest(port, { cookie })
  assert.equal(ws.status, 101, ws.text.slice(0, 120))
  assert.match(ws.text, /UPGRADED/)
  assert.equal(calls, 2, 'the refused handshake must be retried with a fresh cookie')
  ws.socket.destroy()
})

test('front door: an unusable harness cookie fails closed', async (t) => {
  const upstream = await startUpstream()
  const { door, port, base } = await startDoor(upstream.port, {
    resolveUpstreamCookie: async () => 'evil=1\r\nX-Injected: yes',
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })
  const { cookie } = await login(port)
  const response = await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(response.status, 502)
  assert.equal(upstream.seen.length, 0, 'a header-injecting cookie value must never be forwarded')
})

test('front door: sessionHours bounds the session lifetime', async (t) => {
  const upstream = await startUpstream()
  let clock = 1_700_000_000_000
  const { door, port, base } = await startDoor(upstream.port, { sessionHours: 1, now: () => clock })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  const { setCookie, cookie } = await login(port)
  assert.match(setCookie[0], /Max-Age=3600/)
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200)

  clock += 59 * 60 * 1000
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200, 'still inside the window')

  clock += 2 * 60 * 1000
  const expired = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(expired.status, 401, 'an expired session falls back to the login page')
})

test('front door: the client table is bounded and expires', async (t) => {
  const upstream = await startUpstream()
  let clock = 1_700_000_000_000
  const { door, port, base } = await startDoor(upstream.port, {
    trustProxyHeaders: true,
    maxClients: 2,
    clientTtlMs: 60 * 1000,
    now: () => clock,
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  const { cookie } = await login(port, PASSWORD, { 'x-forwarded-for': '10.0.0.1' })
  for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    const response = await fetch(`${base}/`, { headers: { cookie, 'x-forwarded-for': ip } })
    assert.equal(response.status, 200)
    clock += 1000
  }
  assert.ok(door.status().clients.length <= 2, 'the table never exceeds maxClients')

  clock += 5 * 60 * 1000
  assert.equal(door.status().clients.length, 0, 'idle clients expire')
})

test('front door: the bind address comes from the caller and options are validated', () => {
  const door = createFrontDoor({
    mode: 'none',
    port: 0,
    upstreamPort: 1,
    resolveUpstreamCookie: async () => 'a=b',
    log: () => {},
  })
  // Never invents 0.0.0.0: the caller owns the bind address (F-PROXY-4).
  assert.equal(door.status().host, '127.0.0.1')
  assert.equal(door.status().listening, false)
  assert.equal(door.status().mode, 'none')
  assert.deepEqual(door.status().clients, [])
  assert.equal(door.kick('nobody'), 0)

  assert.throws(
    () => createFrontDoor({ mode: 'nowhere', upstreamPort: 1 }),
    (error) => error.code === 'FRONTDOOR_BAD_MODE',
  )
  assert.throws(
    () => createFrontDoor({ mode: 'none', upstreamPort: 0 }),
    (error) => error.code === 'FRONTDOOR_BAD_UPSTREAM',
  )
  assert.throws(
    () => createFrontDoor({ mode: 'none', upstreamPort: 1 }),
    (error) => error.code === 'FRONTDOOR_BAD_OPTIONS',
  )
})

test('front door: repeated login/access failures are throttled', async (t) => {
  const upstream = await startUpstream()
  const { door, port } = await startDoor(upstream.port)
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  let last = 0
  for (let index = 0; index < 8; index += 1) {
    const { response } = await login(port, 'wrong')
    last = response.status
  }
  assert.equal(last, 401, 'the eighth failure is still a plain rejection')
  const blocked = await login(port, 'wrong')
  assert.equal(blocked.response.status, 429, 'the ninth attempt is throttled')
  assert.match(await blocked.response.text(), /Too many attempts/)
  // and the correct password cannot shortcut the block either
  const stillBlocked = await login(port)
  assert.equal(stillBlocked.response.status, 429)
  assert.equal(upstream.seen.length, 0)
})

test('front door: allowedCidrs and proxy-header trust', async (t) => {
  const upstream = await startUpstream()
  const strict = await startDoor(upstream.port, { allowedCidrs: ['10.0.0.0/8'] })
  const trusted = await startDoor(upstream.port, { allowedCidrs: ['10.0.0.0/8'], trustProxyHeaders: true })
  t.after(async () => {
    await strict.door.close()
    await trusted.door.close()
    await upstream.close()
  })

  await t.test('a socket address outside allowedCidrs is denied', async () => {
    const response = await fetch(`${strict.base}/`, { redirect: 'manual' })
    assert.equal(response.status, 403)
    assert.equal(upstream.seen.length, 0)
    assert.ok(strict.door.status().denied >= 1)
  })

  await t.test('a forged X-Forwarded-For cannot escape the allowlist while headers are untrusted', async () => {
    const response = await fetch(`${strict.base}/`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '10.1.2.3', 'cf-connecting-ip': '10.1.2.3' },
    })
    assert.equal(response.status, 403)
    assert.equal(upstream.seen.length, 0)
  })

  await t.test('the same header is honoured once the hop is trusted', async () => {
    const response = await fetch(`${trusted.base}/`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '10.1.2.3' },
    })
    assert.equal(response.status, 401, 'the allowlist passes, the session is still required')
    assert.equal(upstream.seen.length, 0)
    const { response: loginResponse, cookie } = await login(trusted.port, PASSWORD, { 'x-forwarded-for': '10.1.2.3' })
    assert.equal(loginResponse.status, 303)
    const proxied = await fetch(`${trusted.base}/`, { headers: { cookie, 'x-forwarded-for': '10.1.2.3' } })
    assert.equal(proxied.status, 200)
    const last = upstream.seen.at(-1)
    assert.equal(last.forwardedFor, '10.1.2.3')
    const client = trusted.door.status().clients.find((entry) => entry.id === '10.1.2.3')
    assert.ok(client, 'the trusted header decides the client id')
    assert.equal(client.kind, 'ip')
  })
})

test('clientAddress only trusts proxy headers from a trusted loopback peer', () => {
  const loopback = { remoteAddress: '127.0.0.1' }
  const lan = { remoteAddress: '192.168.1.50' }
  assert.equal(clientAddress({ 'x-forwarded-for': '10.1.2.3' }, loopback, { trustProxy: false }), '127.0.0.1')
  assert.equal(clientAddress({ 'x-forwarded-for': '10.1.2.3' }, loopback, { trustProxy: true }), '10.1.2.3')
  assert.equal(clientAddress({ 'x-forwarded-for': '10.1.2.3' }, lan, { trustProxy: true }), '192.168.1.50')
  assert.equal(clientAddress({ 'cf-connecting-ip': '198.51.100.7' }, loopback, { trustProxy: true }), '198.51.100.7')
  assert.equal(clientAddress({ 'cf-connecting-ip': 'not-an-ip' }, loopback, { trustProxy: true }), '127.0.0.1')
  assert.equal(clientAddress({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, loopback, { trustProxy: true }), '203.0.113.9')
  assert.equal(clientAddress({}, { remoteAddress: '::ffff:127.0.0.1' }, { trustProxy: false }), '127.0.0.1')
  assert.equal(clientAddress({ 'x-forwarded-for': '203.0.113.9' }, { remoteAddress: '::1' }, { trustProxy: true }), '203.0.113.9')
})

test('passwordMatches compares exactly', () => {
  assert.equal(passwordMatches('correct horse', 'correct horse'), true)
  assert.equal(passwordMatches('correct horsf', 'correct horse'), false)
  assert.equal(passwordMatches('', 'correct horse'), false)
  assert.equal(passwordMatches('correct horse', ''), false)
  assert.equal(passwordMatches(undefined, 'correct horse'), false)
  assert.equal(passwordMatches('correct horse', undefined), false)
})

test('front door: tailscale mode is gated on identity alone', async (t) => {
  const upstream = await startUpstream()
  const { door, port, base } = await startDoor(upstream.port, {
    mode: 'tailscale',
    password: undefined,
    allowedUsers: ['alice@example.com'],
    trustProxyHeaders: true,
  })
  const spoofed = await startDoor(upstream.port, {
    mode: 'tailscale',
    password: undefined,
    allowedUsers: ['alice@example.com'],
    trustProxyHeaders: false,
  })
  t.after(async () => {
    await door.close()
    await spoofed.door.close()
    await upstream.close()
  })

  await t.test('a missing identity header is denied and counted', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' })
    assert.equal(response.status, 403)
    assert.equal(upstream.seen.length, 0)
    assert.ok(door.status().denied >= 1)
  })

  await t.test('an identity outside allowedUsers is denied even with a session cookie', async () => {
    const response = await fetch(`${base}/`, {
      redirect: 'manual',
      headers: { 'tailscale-user-login': 'bob@example.com', cookie: `${SESSION_COOKIE}=whatever` },
    })
    assert.equal(response.status, 403)
    assert.equal(upstream.seen.length, 0)
  })

  await t.test('an allowlisted identity is proxied with rewritten headers', async () => {
    const response = await fetch(`${base}/`, {
      headers: { 'tailscale-user-login': 'alice@example.com', 'tailscale-user-name': 'Alice' },
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'UPSTREAM OK')
    const last = upstream.seen.at(-1)
    assert.equal(last.host, `127.0.0.1:${String(upstream.port)}`)
    assert.equal(last.cookie, HARNESS_COOKIE)
    assert.equal(last.origin, undefined)
    assert.equal(last.identity, 'alice@example.com')
    assert.equal(last.identityName, 'Alice')

    const client = door.status().clients.find((entry) => entry.id === 'alice@example.com')
    assert.ok(client)
    assert.equal(client.kind, 'identity')
    assert.equal(client.identity, 'alice@example.com')
    assert.equal(client.name, 'Alice')
    assert.equal(client.ip, '127.0.0.1')
    assert.ok(client.requests >= 1)
  })

  await t.test('websockets follow the same identity gate', async () => {
    const allowed = await upgradeRequest(port, { headers: { 'tailscale-user-login': 'alice@example.com' } })
    assert.equal(allowed.status, 101)
    assert.match(allowed.text, /UPGRADED/)
    assert.equal(door.status().clients.find((entry) => entry.id === 'alice@example.com').websockets, 1)
    allowed.socket.destroy()

    const before = upstream.seen.length
    const anonymous = await upgradeRequest(port, {})
    assert.equal(anonymous.status, 403)
    assert.equal(upstream.seen.length, before)
    anonymous.socket.destroy()
  })

  await t.test('a forged identity header is ignored while proxy headers are untrusted', async () => {
    const before = upstream.seen.length
    const response = await fetch(`${spoofed.base}/`, {
      redirect: 'manual',
      headers: { 'tailscale-user-login': 'alice@example.com' },
    })
    assert.equal(response.status, 403)
    assert.equal(upstream.seen.length, before)
    assert.ok(spoofed.door.status().denied >= 1)
  })

  await t.test('an empty allowedUsers list denies every identity', async (t2) => {
    const empty = await startDoor(upstream.port, {
      mode: 'tailscale',
      password: undefined,
      allowedUsers: [],
      trustProxyHeaders: true,
    })
    t2.after(async () => {
      await empty.door.close()
    })
    const response = await fetch(`${empty.base}/`, {
      redirect: 'manual',
      headers: { 'tailscale-user-login': 'alice@example.com' },
    })
    assert.equal(response.status, 403)
  })
})

test('front door: quick mode refuses to listen without a password', async (t) => {
  const upstream = await startUpstream()
  const door = createFrontDoor({
    mode: 'quick',
    port: 0,
    host: '127.0.0.1',
    upstreamPort: upstream.port,
    resolveUpstreamCookie: async () => HARNESS_COOKIE,
    log: () => {},
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })
  await assert.rejects(() => door.listen(), (error) => error.code === 'FRONTDOOR_PASSWORD_REQUIRED')
  assert.equal(door.status().listening, false)
})

test('front door: none mode without a password mints a session on first use', async (t) => {
  const upstream = await startUpstream()
  const { door, port, base } = await startDoor(upstream.port, { password: undefined })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  const first = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(first.status, 200)
  assert.equal(await first.text(), 'UPSTREAM OK')
  const setCookie = first.headers.getSetCookie()
  assert.equal(setCookie.length, 1, 'the debug door issues its session on the first request')
  assert.match(setCookie[0], new RegExp(`^${SESSION_COOKIE}=`))
  assert.match(setCookie[0], /HttpOnly/)
  assert.match(setCookie[0], /SameSite=Lax/)

  const cookie = setCookie[0].split(';')[0]
  const second = await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(second.status, 200)
  assert.equal(second.headers.getSetCookie().length, 0, 'an existing session is not re-issued')
})

test('front door: status() reflects clients and kick() drops their connections', async (t) => {
  const upstream = await startUpstream()
  const { door, port, base } = await startDoor(upstream.port)
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  const { cookie } = await login(port)
  const ping = await fetch(`${base}/api/ping`, { headers: { cookie, 'user-agent': 'test-agent/1.0' } })
  assert.equal(ping.status, 200)
  const ws = await upgradeRequest(port, { cookie })
  assert.equal(ws.status, 101)
  const idle = await upgradeRequest(port, { cookie })
  assert.equal(idle.status, 101)

  const status = door.status()
  assert.equal(status.mode, 'none')
  assert.equal(status.listening, true)
  assert.equal(status.port, port)
  assert.ok(status.denied >= 0)
  const client = status.clients.find((entry) => entry.id === '127.0.0.1')
  assert.ok(client, 'the client must be listed under its address')
  assert.equal(client.kind, 'ip')
  assert.equal(client.ip, '127.0.0.1')
  assert.equal(client.userAgent, 'test-agent/1.0')
  assert.ok(client.requests >= 1)
  assert.equal(client.websockets, 2)
  assert.equal(client.active, true)
  assert.ok(client.since <= client.lastSeen)

  const closedA = once(ws.socket, 'close')
  const closedB = once(idle.socket, 'close')
  const kicked = door.kick('127.0.0.1')
  assert.ok(kicked >= 2, `kick() must report the dropped connections (got ${String(kicked)})`)
  await withTimeout(Promise.all([closedA, closedB]), 1500, 'kick() must close the websockets')

  const after = door.status().clients.find((entry) => entry.id === '127.0.0.1')
  assert.equal(after.websockets, 0)
  assert.equal(after.active, false)
  assert.equal(door.kick('nobody'), 0)

  // F-AUTH-6: the kicked session is revoked server-side.
  const revoked = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(revoked.status, 401)
})

test('front door: close() tears down live websockets and resolves promptly', async (t) => {
  const upstream = await startUpstream()
  const { door, port } = await startDoor(upstream.port)
  t.after(async () => {
    await upstream.close()
  })

  const { cookie } = await login(port)
  const ws = await upgradeRequest(port, { cookie })
  assert.equal(ws.status, 101)

  const closed = once(ws.socket, 'close')
  await withTimeout(door.close(), 1500, 'close() must resolve while a websocket is open')
  await withTimeout(closed, 1500, 'close() must destroy upgraded websockets')
  assert.equal(door.status().listening, false)
  await assert.rejects(() => fetch(`${baseOf(port)}/`), 'the listener must be gone')
  await door.close()
})

test('front door: audit events fire for auth-ok, auth-fail, denied and kick', async (t) => {
  const upstream = await startUpstream()
  const events = []
  const { door, port, base } = await startDoor(upstream.port, {
    onEvent: (event) => events.push(event),
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })

  // denied: unauthenticated access
  await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(events.filter((event) => event.type === 'denied').length, 1)
  assert.equal(events[0].ip, '127.0.0.1')
  assert.equal(typeof events[0].at, 'number')

  // auth-fail: wrong password
  await login(port, 'wrong')
  assert.equal(events.filter((event) => event.type === 'auth-fail').length, 1)

  // auth-ok: password login (once per client, not once per request)
  const { cookie } = await login(port)
  const ok = events.filter((event) => event.type === 'auth-ok')
  assert.equal(ok.length, 1)
  assert.equal(ok[0].ip, '127.0.0.1')
  await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(events.filter((event) => event.type === 'auth-ok').length, 1)

  // kick: raised when connections are dropped
  const ws = await upgradeRequest(port, { cookie })
  assert.equal(ws.status, 101)
  door.kick('127.0.0.1')
  assert.equal(events.filter((event) => event.type === 'kick').length, 1)
  ws.socket.destroy()

  // no event may carry a secret
  const dump = JSON.stringify(events)
  assert.doesNotMatch(dump, new RegExp(PASSWORD))
  assert.doesNotMatch(dump, /harness-cookie-value/)
  assert.doesNotMatch(dump, new RegExp(SESSION_COOKIE))
  for (const event of events) {
    const expected = event.identity === undefined ? ['at', 'ip', 'type'] : ['at', 'identity', 'ip', 'type']
    assert.deepEqual(Object.keys(event).sort(), expected.sort())
  }
})

test('front door: a throwing onEvent sink never breaks a request', async (t) => {
  const upstream = await startUpstream()
  const { door, port, base } = await startDoor(upstream.port, {
    onEvent: () => {
      throw new Error('audit sink exploded')
    },
  })
  t.after(async () => {
    await door.close()
    await upstream.close()
  })
  const { cookie } = await login(port)
  const response = await fetch(`${base}/`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'UPSTREAM OK')
  assert.doesNotThrow(() => door.kick('127.0.0.1'), 'a throwing audit sink must not escape kick()')
})
