/**
 * Plugin orchestration: mode switch, gate failures, teardown, status, actions.
 *
 * `apply()` takes an injection seam, so every external module (tailscale,
 * cloudflared, the front door, the routes and the status writer) is faked here.
 * No tailscale, no cloudflared, no network, and `DSH_HOME` is redirected to a
 * temp directory so nothing touches the real harness home.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-remote-entry-test-'))
process.env.DSH_HOME = HOME

const { apply, preconditionSatisfied } = await import('../lib/index.js')

const RUNNING_PROBE = {
  installed: true,
  bin: '/fake/tailscale',
  running: true,
  backendState: 'Running',
  self: { login: 'me@example.com', hostName: 'chromebook', dnsName: 'chromebook.tailnet-abc.ts.net', ips: ['100.1.2.3'] },
  tailnet: { name: 'example.com', magicDnsSuffix: 'tailnet-abc.ts.net' },
  serve: { raw: '', entries: [], parse: 'json' },
}

const waitFor = async (predicate, { timeoutMs = 2000, label = 'condition' } = {}) => {
  const started = Date.now()
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createHarness(overrides = {}) {
  const logs = []
  const frontDoors = []
  const serveCalls = []
  const resetCalls = []
  const tunnelCalls = []
  const effects = []
  let hooks
  let namespace
  let routesApi
  let routesDisposed = false

  const probe = overrides.probe ?? (async () => RUNNING_PROBE)
  const serveEnable = overrides.serveEnable ?? (async (options) => {
    serveCalls.push(options)
    return { url: `https://${RUNNING_PROBE.self.dnsName}` }
  })
  const serveReset = overrides.serveReset ?? (async (options) => { resetCalls.push(options) })
  const ensureCloudflared = overrides.ensureCloudflared ?? (async () => '/fake/cloudflared')
  const startTunnel = overrides.startTunnel ?? ((options) => {
    tunnelCalls.push(options)
    return { get url() { return undefined }, stop() { tunnelCalls.at(-1).stopped = true } }
  })
  const createFrontDoor = overrides.createFrontDoor ?? ((options) => {
    const door = {
      options,
      closed: false,
      listen: async () => ({ port: options.port, host: options.host }),
      close: async () => { door.closed = true },
      status: () => ({ mode: options.mode, listening: true, port: options.port, host: options.host, clients: [], denied: 0 }),
      kick: () => 1,
    }
    frontDoors.push(door)
    return door
  })
  const registerRoutes = overrides.registerRoutes ?? ((ctx, api) => {
    routesApi = api
    return () => { routesDisposed = true }
  })

  const config = { ...(overrides.config ?? {}) }
  const settingsWrites = { updates: [], replaces: [], mutates: [], describes: [] }
  const ctx = {
    logger: {
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    webServer: { port: 3080, register: () => () => {} },
    connection: { authenticatedUrl: (url) => `${url}?token=TEST` },
    inject: (names, callback) => {
      if (names.includes('clientModules')) {
        callback({
          clientModules: {
            graph: () => {
              if (overrides.clientGraphThrows === true) throw new Error('graph unavailable')
              if (overrides.clientGraph === undefined) {
                return { entries: [{ id: '@deepseek-ai/dsh-client-ui-plugin-manager' }, { id: '@deepseek-ai/dsh-client-ui-sidebar' }] }
              }
              return overrides.clientGraph
            },
          },
        })
      }
      if (names.includes('settings')) {
        callback({
          settings: {
            installSection: (owner, ns, schema, entry, sectionHooks) => { hooks = sectionHooks; namespace = ns },
            // Mirrors the real provider: merge into the user layer, then let the
            // installed section's watcher fire.
            update: async (ns, patch) => {
              settingsWrites.updates.push({ ns, patch })
              Object.assign(config, patch)
              hooks?.setSource(() => config)
              hooks?.onChange()
            },
            describe: (options) => {
              settingsWrites.describes.push(options)
              return [
                { ns: 'locale', value: { preference: 'zh' }, revision: 1, applies: 'live' },
                { ns: 'ui-theme', value: { preference: 'dark', fontSize: 16 }, revision: 1, applies: 'live' },
                { ns: 'llm-pi-ai', value: { providers: {} }, revision: 1, applies: 'live' },
              ]
            },
            mutate: async (ns, ops) => {
              settingsWrites.mutates.push({ ns, ops })
              for (const op of ops) {
                if (op.op !== 'unset') continue
                for (const key of op.path) delete config[key]
              }
              hooks?.setSource(() => config)
              hooks?.onChange()
            },
            replace: async (ns, section) => {
              settingsWrites.replaces.push({ ns, section })
              for (const key of Object.keys(config)) delete config[key]
              Object.assign(config, section)
              hooks?.setSource(() => config)
              hooks?.onChange()
            },
          },
        })
      }
      return () => {}
    },
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {}
    },
  }

  const deps = {
    probe,
    serveEnable,
    serveReset,
    createFrontDoor,
    ensureCloudflared,
    startTunnel,
    createRetry: () => ({ attempts: 0, next: () => 1, reset: () => {} }),
    ...(overrides.probeTtlMs === undefined ? {} : { probeTtlMs: overrides.probeTtlMs }),
    createStatusWriter: () => Object.assign(() => {}, { flush: async () => {} }),
    registerRoutes,
  }

  apply(ctx, config, deps)

  const setConfig = async (next) => {
    Object.assign(config, next)
    hooks.setSource(() => config)
    hooks.onChange()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  return {
    logs, frontDoors, serveCalls, resetCalls, tunnelCalls, effects, settingsWrites,
    get namespace() { return namespace },
    get routesApi() { return routesApi },
    get routesDisposed() { return routesDisposed },
    get hooks() { return hooks },
    setConfig,
    status: () => routesApi.status(),
    logText: () => logs.map(([level, message]) => `${level}: ${message}`).join('\n'),
  }
}

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

test('disabled by default: no entry, but the status surface exists', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined, { label: 'settings section' })
  const status = await h.status()
  assert.equal(status.phase, 'stopped')
  assert.equal(status.enabled, false)
  assert.equal(h.frontDoors.length, 0)
  assert.equal(typeof h.routesApi.kick, 'function')
})

test('tailscale mode: identity gate, serve wiring, and a running status', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined, { label: 'settings section' })
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => h.frontDoors.length === 1, { label: 'front door' })

  const options = h.frontDoors[0].options
  assert.equal(options.mode, 'tailscale')
  assert.equal(options.host, '127.0.0.1', 'the front door never widens the bind by default')
  assert.equal(options.port, 8787)
  assert.equal(options.upstreamPort, 3080)
  assert.deepEqual(options.allowedUsers, ['me@example.com'], 'empty allowlist defaults to Self')
  assert.equal(options.trustProxyHeaders, true)
  assert.equal(typeof options.onEvent, 'function')
  assert.equal(h.serveCalls.length, 1)
  assert.equal('https' in h.serveCalls[0], false, 'plaintext selection is gone: serve always publishes HTTPS')
  assert.equal(h.serveCalls[0].port, 8787)

  const status = await h.status()
  assert.equal(status.phase, 'running')
  assert.equal(status.url, 'https://chromebook.tailnet-abc.ts.net')
  assert.deepEqual(status.allowedUsers, ['me@example.com'])
  assert.equal(status.tailscale.backendState, 'Running')
})

test('tailscale mode: explicit allowlist wins over Self', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale', allowedUsers: ['phone@example.com'] })
  await waitFor(() => h.frontDoors.length === 1)
  assert.deepEqual(h.frontDoors[0].options.allowedUsers, ['phone@example.com'])
})

test('tailscale mode: an unresolvable Self login fails closed', async () => {
  const h = createHarness({ probe: async () => ({ ...RUNNING_PROBE, self: { hostName: 'chromebook' } }) })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  const status = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'error phase' })
  assert.equal(status.lastError.code, 'IDENTITY_UNRESOLVED')
  assert.equal(h.frontDoors.length, 0)
})

test('tailscale mode: missing certificates surface with the hint and exactly one serve attempt', async () => {
  const hint = '这个 tailnet 没开 HTTPS 证书：到 admin console → DNS → HTTPS Certificates 打开，或改用 quick 模式。'
  const h = createHarness({
    serveEnable: async (options) => {
      h.serveCalls.push(options)
      throw Object.assign(new Error('HTTPS certificates are not enabled'), {
        code: 'TAILSCALE_HTTPS_CERTS_DISABLED',
        hint,
        command: 'tailscale serve --bg --https=443 http://127.0.0.1:8787',
      })
    },
  })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  const status = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'certificate error' })
  assert.equal(status.lastError.code, 'TAILSCALE_HTTPS_CERTS_DISABLED')
  assert.match(status.lastError.hint, /quick/i, 'the hint offers quick mode as the HTTPS alternative')
  assert.doesNotMatch(String(status.lastError.command), /--tcp/i)
  assert.equal(h.serveCalls.length, 1, 'the certificate failure is never retried over plaintext')
  assert.equal(h.serveCalls[0].https, undefined)
  assert.equal(h.frontDoors[0].closed, true, 'the half-built front door is torn down')
  assert.doesNotMatch(h.logText(), /--tcp/)
})

test('tailscale mode: a probe failure becomes an actionable status error', async () => {
  const h = createHarness({
    probe: async () => ({
      installed: true,
      running: false,
      error: { code: 'TAILSCALE_NOT_RUNNING', message: 'tailscaled is not running', hint: 'start it', command: 'sudo systemctl enable --now tailscaled' },
    }),
  })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  const status = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'error phase' })
  assert.equal(status.lastError.code, 'TAILSCALE_NOT_RUNNING')
  assert.equal(status.lastError.command, 'sudo systemctl enable --now tailscaled')
  assert.equal(h.frontDoors.length, 0)
})

test('quick mode: refuses to publish without a password or without acknowledging the risk', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'quick' })
  const noPassword = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'password error' })
  assert.equal(noPassword.lastError.code, 'PASSWORD_REQUIRED')
  assert.equal(h.tunnelCalls.length, 0)

  await h.setConfig({ password: 'long-enough-password' })
  const noAck = await waitFor(async () => {
    const value = await h.status()
    return value.lastError?.code === 'RISK_NOT_ACKNOWLEDGED' ? value : undefined
  }, { label: 'risk error' })
  assert.equal(noAck.phase, 'error')
  assert.equal(h.tunnelCalls.length, 0)
})

test('quick mode: a password plus acknowledgement starts the tunnel and reports the URL', async () => {
  const h = createHarness({
    startTunnel: (options) => {
      h.tunnelCalls.push(options)
      setTimeout(() => options.onUrl('https://random-words-1234.trycloudflare.com'), 0)
      return { get url() { return 'https://random-words-1234.trycloudflare.com' }, stop() { options.stopped = true } }
    },
  })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'quick', password: 'long-enough-password', acknowledgeRisk: true })
  await waitFor(() => h.tunnelCalls.length === 1, { label: 'tunnel start' })
  assert.equal(h.tunnelCalls[0].port, 8787)
  assert.equal(h.frontDoors[0].options.mode, 'quick')
  assert.equal(h.frontDoors[0].options.password, 'long-enough-password')
  assert.equal(h.frontDoors[0].options.trustProxyHeaders, true)
  const status = await waitFor(async () => {
    const value = await h.status()
    return value.url !== undefined ? value : undefined
  }, { label: 'public url' })
  assert.equal(status.url, 'https://random-words-1234.trycloudflare.com')
})

test('none mode: needs a password and never starts a tunnel', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'none', password: 'long-enough-password' })
  await waitFor(() => h.frontDoors.length === 1, { label: 'front door' })
  assert.equal(h.frontDoors[0].options.mode, 'none')
  assert.equal(h.frontDoors[0].options.trustProxyHeaders, false, 'loopback mode must not trust proxy headers')
  assert.equal(h.tunnelCalls.length, 0)
  assert.equal(h.serveCalls.length, 0)
})

test('disabling tears the entry down: serve reset, front door closed, phase stopped', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => h.frontDoors.length === 1)
  await h.setConfig({ enabled: false })
  await waitFor(() => h.resetCalls.length === 1, { label: 'serve reset' })
  assert.equal(h.frontDoors[0].closed, true)
  const status = await h.status()
  assert.equal(status.phase, 'stopped')
  assert.equal(status.url, undefined)
})

test('actions: kick reaches the front door, restart rebuilds the entry', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => h.frontDoors.length === 1)

  const kicked = await h.routesApi.kick('me@example.com')
  assert.equal(kicked, 1)

  await h.routesApi.restart()
  await waitFor(() => h.frontDoors.length === 2, { label: 'restarted front door' })
  assert.equal(h.frontDoors[0].closed, true)
  assert.equal(h.resetCalls.length >= 1, true, 'restart resets the serve rule before re-applying')
})

test('shutdown disposes the routes and stops the entry', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => h.frontDoors.length === 1)
  const shutdown = h.effects.find((entry) => entry.label === 'remote-access:shutdown')
  assert.ok(shutdown !== undefined, 'the plugin registers a shutdown effect')
  await shutdown.dispose()
  assert.equal(h.frontDoors[0].closed, true)
  assert.equal(h.resetCalls.length, 1)
})

test('status is honest about the loopback local URL', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale', port: 9000 })
  await waitFor(() => h.frontDoors.length === 1)
  const status = await h.status()
  assert.equal(status.localUrl, 'http://127.0.0.1:9000/')
  assert.equal(status.port, 9000)
  assert.equal(h.frontDoors[0].options.port, 9000)
})

test('stale-error policy (option B): a fixed precondition clears the failure', async () => {
  let operatorOk = false
  const h = createHarness({
    probeTtlMs: 0,
    probe: async () => ({
      ...RUNNING_PROBE,
      backendState: 'Running',
      operator: operatorOk
        ? { user: 'me', current: 'me', ok: true }
        : { user: undefined, current: 'me', ok: false, command: 'sudo tailscale set --operator=me', hint: 'not the operator' },
    }),
  })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })

  const failed = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'operator error' })
  assert.equal(failed.lastError.code, 'TAILSCALE_NOT_OPERATOR')
  assert.match(String(failed.lastError.command), /set --operator/)

  // The user runs the command; the next status poll notices and stops presenting
  // the old failure as current state.
  operatorOk = true
  const healed = await waitFor(async () => {
    const value = await h.status()
    return value.lastError === undefined ? value : undefined
  }, { label: 'stale error cleared' })
  assert.equal(healed.phase, 'stopped')
  assert.equal(healed.lastError, undefined)
})

test('stale-error policy (option B): a generic failure is never auto-cleared', async () => {
  const h = createHarness({
    serveEnable: async () => {
      throw Object.assign(new Error('listener already exists for port 443'), { code: 'TAILSCALE_SERVE_CONFLICT', hint: 'reset first' })
    },
  })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  const failed = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'conflict error' })
  assert.equal(failed.lastError.code, 'TAILSCALE_SERVE_CONFLICT')

  // Repeated polls must keep it: clearing it would hide a real conflict.
  for (let index = 0; index < 3; index += 1) {
    const again = await h.status()
    assert.equal(again.lastError?.code, 'TAILSCALE_SERVE_CONFLICT')
  }
})

test('preconditionSatisfied: only re-checkable codes qualify', () => {
  assert.equal(preconditionSatisfied('TAILSCALE_NOT_INSTALLED', {}, { installed: true }), true)
  assert.equal(preconditionSatisfied('TAILSCALE_NOT_INSTALLED', {}, { installed: false }), false)
  assert.equal(preconditionSatisfied('TAILSCALE_NOT_OPERATOR', {}, { operator: { ok: true } }), true)
  assert.equal(preconditionSatisfied('TAILSCALE_NOT_OPERATOR', {}, { operator: { ok: false } }), false)
  assert.equal(preconditionSatisfied('TAILSCALE_NEEDS_LOGIN', {}, { backendState: 'Running' }), true)
  assert.equal(preconditionSatisfied('MAGICDNS_UNAVAILABLE', {}, { self: { dnsName: 'host.ts.net' } }), true)
  assert.equal(preconditionSatisfied('PASSWORD_REQUIRED', { password: 'long-enough' }, {}), true)
  assert.equal(preconditionSatisfied('PASSWORD_REQUIRED', { password: 'short' }, {}), false)
  assert.equal(preconditionSatisfied('RISK_NOT_ACKNOWLEDGED', { acknowledgeRisk: true }, {}), true)
  // Generic failures must never be auto-cleared: clearing them would hide a real problem.
  assert.equal(preconditionSatisfied('TAILSCALE_SERVE_CONFLICT', {}, { installed: true, running: true }), false)
  assert.equal(preconditionSatisfied('TUNNEL_RESTART_EXHAUSTED', {}, { installed: true }), false)
})

test('config API: the card can read and write config without any settings document', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => h.frontDoors.length === 1)

  // Reads: the status payload carries the effective config (the only channel a
  // remote page has, since DSH runs settingsScope in memory mode there).
  const before = await h.status()
  assert.equal(before.config.mode, 'tailscale')
  assert.equal(before.config.port, 8787)
  assert.equal(before.config.passwordSet, false)
  assert.equal('password' in before.config, false, 'the secret never leaves the host')
  assert.equal(before.config.configOverridden, true, 'enabled=true is not the default')

  // Writes: a patch lands in the settings section and the entry rebuilds.
  const applied = await h.routesApi.set({ port: 9101, allowedUsers: [' me@example.com ', ''] })
  assert.deepEqual(h.settingsWrites.updates, [{ ns: 'remote-access', patch: { port: 9101, allowedUsers: ['me@example.com'] } }])
  assert.equal(applied.port, 9101)
  assert.deepEqual(applied.allowedUsers, ['me@example.com'])
  await waitFor(() => h.frontDoors.length === 2, { label: 'rebuild on port change' })
  assert.equal(h.frontDoors[1].options.port, 9101)
})

test('config API: bad patches are rejected before anything is written', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await assert.rejects(() => h.routesApi.set({ nope: 1 }), (error) => error.code === 'UNKNOWN_FIELD')
  await assert.rejects(() => h.routesApi.set({ port: 80 }), (error) => error.code === 'BAD_VALUE')
  await assert.rejects(() => h.routesApi.set({ port: 1.5 }), (error) => error.code === 'BAD_VALUE')
  await assert.rejects(() => h.routesApi.set({ mode: 'nonsense' }), (error) => error.code === 'BAD_VALUE')
  await assert.rejects(() => h.routesApi.set({ enabled: 'yes' }), (error) => error.code === 'BAD_VALUE')
  await assert.rejects(() => h.routesApi.set({ allowedUsers: [1] }), (error) => error.code === 'BAD_VALUE')
  await assert.rejects(() => h.routesApi.set({ password: 'short' }), (error) => error.code === 'BAD_VALUE')
  await assert.rejects(() => h.routesApi.set(null), (error) => error.code === 'BAD_PATCH')
  assert.deepEqual(h.settingsWrites.updates, [], 'nothing may reach the settings provider')
})

test('config API: reset re-inherits the defaults', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'none', password: 'long-enough-password', port: 9500 })
  await waitFor(() => h.frontDoors.length === 1)
  const after = await h.routesApi.reset()
  assert.deepEqual(h.settingsWrites.replaces, [{ ns: 'remote-access', section: {} }])
  assert.equal(after.port, 8787)
  assert.equal(after.mode, 'tailscale')
  assert.equal(after.enabled, false)
  await waitFor(async () => (await h.status()).phase === 'stopped', { label: 'entry torn down by reset' })
})

test('config API: unset drops a field so the default re-inherits', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale', port: 9200 })
  await waitFor(() => h.frontDoors.length === 1)
  const after = await h.routesApi.unset(['port'])
  assert.deepEqual(h.settingsWrites.mutates, [{ ns: 'remote-access', ops: [{ op: 'unset', path: ['port'] }] }])
  assert.equal(after.port, 8787, 'the schema default re-inherits')
  await assert.rejects(() => h.routesApi.unset([]), (error) => error.code === 'BAD_PATCH')
  await assert.rejects(() => h.routesApi.unset(['nope']), (error) => error.code === 'UNKNOWN_FIELD')
})

test('config API: hostSettings serves the redacted document to a remote page', async () => {
  const h = createHarness()
  await waitFor(() => h.hooks !== undefined)
  const doc = await h.routesApi.hostSettings()
  assert.deepEqual(h.settingsWrites.describes, [{ redactSecrets: true }], 'the provider redacts secrets, not us')
  assert.equal(doc.locale, 'zh')
  assert.deepEqual(doc.theme, { preference: 'dark', fontSize: 16 })
  assert.deepEqual(Object.keys(doc.sections).sort(), ['llm-pi-ai', 'locale', 'ui-theme'])
  assert.equal(typeof doc.readAt, 'number')
})

test('compatibility gate: a build with no card slot at all refuses to start, loudly', async () => {
  const h = createHarness({ clientGraph: { entries: [{ id: '@deepseek-ai/dsh-client-ui-sidebar' }] } })
  await waitFor(() => h.hooks !== undefined)
  await h.setConfig({ enabled: true, mode: 'tailscale' })
  const failed = await waitFor(async () => {
    const value = await h.status()
    return value.phase === 'error' ? value : undefined
  }, { label: 'unsupported version error' })
  assert.equal(failed.lastError.code, 'DSH_VERSION_UNSUPPORTED')
  assert.match(String(failed.lastError.hint), /0\.1\.5-rc\.2/, 'the hint names the minimum version line')
  assert.equal(h.frontDoors.length, 0, 'nothing is bound: the panel could never show this entry')
})

test('compatibility gate: both channels start, and an unreadable graph is not a refusal', async () => {
  // alpha renders plugins.item (ui-plugin-manager); next (rc.2) renders the
  // namespace-keyed settings.plugin.item (ui-settings-plugins). Either is fine.
  const alpha = createHarness({ clientGraph: { entries: [{ id: '@deepseek-ai/dsh-client-ui-plugin-manager' }] } })
  await waitFor(() => alpha.hooks !== undefined)
  await alpha.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => alpha.frontDoors.length === 1, { label: 'alpha build starts' })

  const next = createHarness({ clientGraph: { entries: [{ id: '@deepseek-ai/dsh-client-ui-settings-plugins' }] } })
  await waitFor(() => next.hooks !== undefined)
  await next.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => next.frontDoors.length === 1, { label: 'next (rc.2) build starts' })

  // Unknown must stay unknown: an old composition without the probe service, or a
  // graph that throws, must not turn into a false "unsupported".
  const unknown = createHarness({ clientGraphThrows: true })
  await waitFor(() => unknown.hooks !== undefined)
  await unknown.setConfig({ enabled: true, mode: 'tailscale' })
  await waitFor(() => unknown.frontDoors.length === 1, { label: 'unknown graph still starts' })
  assert.match(unknown.logText(), /client module graph unavailable/)
})
