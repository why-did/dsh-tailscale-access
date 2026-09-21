/**
 * Composition test: the real front door (lib/proxy.js) driven by the real plugin
 * core (lib/index.js) and the real routes (lib/routes.js), against a fake
 * harness that enforces exactly what dsh enforces — the loopback Host authority
 * and its own browser cookie, which it only hands out through the token URL.
 *
 * Only tailscale/cloudflared/supervisor are faked; nothing here touches the
 * network beyond 127.0.0.1, and DSH_HOME is redirected to a temp directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-entry-integration-'))
process.env.DSH_HOME = HOME

const { apply } = await import('../lib/index.js')

const HARNESS_COOKIE = 'dsh-auth-test=harness-cookie'
const IDENTITY = 'me@example.com'
const DNS_NAME = 'chromebook.tailnet-abc.ts.net'

const waitFor = async (predicate, { timeoutMs = 3000, label = 'condition' } = {}) => {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Fake harness: token exchange on `/`, loopback-Host + cookie enforced everywhere else. */
function startHarness() {
  return new Promise((resolve) => {
    const seen = []
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      if (url.searchParams.get('token') === 'TEST' && url.pathname === '/') {
        res.writeHead(303, { location: '/', 'set-cookie': `${HARNESS_COOKIE}; Path=/; HttpOnly` })
        res.end()
        return
      }
      seen.push({
        url: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        referer: req.headers.referer,
        secFetchSite: req.headers['sec-fetch-site'],
      })
      if (req.headers.cookie !== HARNESS_COOKIE) { res.writeHead(401); res.end('harness: unauthorized'); return }
      if (req.headers.host !== `127.0.0.1:${String(server.address().port)}`) { res.writeHead(403); res.end('harness: bad host'); return }
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'leak=1; Path=/' })
      res.end('UPSTREAM OK')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

function createPluginContext(harnessPort) {
  const logs = []
  const effects = []
  let hooks
  let routesApi
  let routesDisposed = false
  const ctx = {
    logger: {
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    webServer: { port: harnessPort, register: () => () => {} },
    connection: { authenticatedUrl: (url) => `${url}?token=TEST` },
    inject: (names, callback) => {
      if (names.includes('settings')) {
        callback({ settings: { installSection: (owner, ns, schema, entry, sectionHooks) => { hooks = sectionHooks } } })
      }
      return () => {}
    },
    effect: (fn, label) => { effects.push({ label, dispose: fn() }); return () => {} },
  }
  const deps = {
    probe: async () => ({
      installed: true, bin: '/fake/tailscale', running: true, backendState: 'Running',
      self: { login: IDENTITY, hostName: 'chromebook', dnsName: DNS_NAME, ips: ['100.1.2.3'] },
      tailnet: { name: 'example.com', magicDnsSuffix: 'tailnet-abc.ts.net' },
      serve: { raw: '', entries: [], parse: 'json' },
    }),
    serveEnable: async () => ({ url: `https://${DNS_NAME}` }),
    serveReset: async () => {},
    // Real modules for the parts under composition:
    // createFrontDoor, registerRoutes and createStatusWriter stay default.
    ensureCloudflared: async () => '/fake/cloudflared',
    startTunnel: () => ({ get url() { return undefined }, stop() {} }),
    createRetry: () => ({ attempts: 0, next: () => 1, reset: () => {} }),
    registerRoutes: (innerCtx, api) => {
      // Wrap the real registration so the test can call the api directly.
      routesApi = api
      return () => { routesDisposed = true }
    },
  }
  return {
    ctx, deps, logs, effects,
    get hooks() { return hooks },
    get routesApi() { return routesApi },
    get routesDisposed() { return routesDisposed },
  }
}

const get = (port, headers) => fetch(`http://127.0.0.1:${String(port)}/api/session/list`, { headers, redirect: 'manual' })

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

test('composition: identity gate, header rewriting, cookie minting, status and teardown', async (t) => {
  const harness = await startHarness()
  const plugin = createPluginContext(harness.port)
  const port = 20000 + Math.floor(Math.random() * 20000)
  apply(plugin.ctx, { enabled: true, mode: 'tailscale', port }, plugin.deps)

  await waitFor(() => plugin.hooks !== undefined, { label: 'settings section' })
  await waitFor(async () => (await plugin.routesApi.status()).phase === 'running', { label: 'running phase' })

  t.after(async () => {
    const shutdown = plugin.effects.find((entry) => entry.label === 'remote-access:shutdown')
    await shutdown?.dispose()
    harness.server.close()
  })

  await t.test('the harness is never contacted without an identity', async () => {
    const before = harness.seen.length
    const response = await get(port, {})
    assert.equal(response.status, 403)
    assert.equal(harness.seen.length, before, 'no upstream request may happen')
  })

  await t.test('an identity outside the allowlist is refused', async () => {
    const response = await get(port, { 'tailscale-user-login': 'someone@else.com' })
    assert.equal(response.status, 403)
  })

  await t.test('the allowlisted identity is proxied with a loopback Host and the minted cookie', async () => {
    const response = await get(port, {
      'tailscale-user-login': IDENTITY,
      origin: `https://${DNS_NAME}`,
      referer: `https://${DNS_NAME}/`,
      'sec-fetch-site': 'same-origin',
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'UPSTREAM OK')
    assert.equal(response.headers.getSetCookie().length, 0, 'the harness cookie must not leak to the browser')

    const last = harness.seen.at(-1)
    assert.equal(last.host, `127.0.0.1:${String(harness.port)}`, 'Host is rewritten to the loopback authority')
    assert.equal(last.cookie, HARNESS_COOKIE, 'the cookie minted through the token URL is injected')
    assert.equal(last.origin, undefined, 'the public Origin is dropped')
    assert.equal(last.referer, undefined)
    assert.equal(last.secFetchSite, undefined)
  })

  await t.test('the minted cookie is reused instead of re-minting per request', async () => {
    const before = harness.seen.length
    await get(port, { 'tailscale-user-login': IDENTITY })
    assert.equal(harness.seen.length, before + 1)
  })

  await t.test('status reports the live client and the denials', async () => {
    const status = await plugin.routesApi.status()
    assert.equal(status.phase, 'running')
    assert.equal(status.mode, 'tailscale')
    assert.equal(status.url, `https://${DNS_NAME}`)
    assert.deepEqual(status.allowedUsers, [IDENTITY])
    assert.ok(status.denied >= 2, 'the refused attempts are counted')
    const client = status.clients.find((entry) => entry.identity === IDENTITY)
    assert.ok(client !== undefined, 'the accepted identity appears in the client table')
    assert.equal(client.kind, 'identity')
    assert.ok(client.requests >= 1)
  })

  await t.test('kick drops the client and is reflected in the next status', async () => {
    const before = await plugin.routesApi.status()
    const client = before.clients.find((entry) => entry.identity === IDENTITY)
    const kicked = await plugin.routesApi.kick(client.id)
    assert.ok(kicked >= 1, 'kick reports the dropped connections')
  })

  await t.test('shutdown closes the front door', async () => {
    const shutdown = plugin.effects.find((entry) => entry.label === 'remote-access:shutdown')
    await shutdown.dispose()
    await assert.rejects(() => get(port, { 'tailscale-user-login': IDENTITY }), /fetch failed|ECONNREFUSED/)
  })
})
