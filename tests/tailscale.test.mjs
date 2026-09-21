/**
 * Tailscale detection and `serve` orchestration.
 *
 * Every case injects a fake `run`, so the system `tailscale` binary is never
 * executed and the suite is deterministic on a machine without tailscale.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES,
  probe,
  probeReady,
  selfLogin,
  serveEnable,
  serveEnableArgs,
  serveReset,
  serveStatus,
  stripTrailingDot,
  startDaemonHint,
} from '../lib/tailscale.js'

const BIN = '/fake/tailscale'

const statusJson = (overrides = {}) => JSON.stringify({
  Version: '1.80.0',
  BackendState: 'Running',
  Self: {
    UserID: 42,
    HostName: 'chromebook',
    DNSName: 'chromebook.tailnet-abc.ts.net.',
    TailscaleIPs: ['100.101.102.103'],
    Online: true,
  },
  User: { '42': { LoginName: 'me@example.com' } },
  CurrentTailnet: { Name: 'example.com', MagicDNSSuffix: 'tailnet-abc.ts.net' },
  ...overrides,
})

const serveJson = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: { 'chromebook.tailnet-abc.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } },
  AllowFunnel: {},
})

/** Fake `run` keyed by the joined argv, with `*` as the fallback. */
function runner(handlers) {
  const calls = []
  const run = async (command, args) => {
    const key = args.join(' ')
    calls.push({ command, key })
    const handler = handlers[key] ?? handlers['*']
    if (handler === undefined) return { stdout: '', stderr: `unexpected call: ${key}`, code: 1 }
    return typeof handler === 'function' ? handler() : handler
  }
  return { run, calls }
}

const ok = (stdout) => ({ stdout, stderr: '', code: 0 })

test('probe: missing binary reports the install state, never throws', async () => {
  const { run } = runner({ '*': { stdout: '', stderr: '', code: null, error: { code: 'ENOENT' } } })
  const result = await probe({ bin: BIN, run })
  assert.equal(result.installed, false)
  assert.equal(result.running, false)
  assert.equal(result.error.code, CODES.NOT_INSTALLED)
  assert.equal(typeof result.error.hint, 'string')
  assert.match(result.error.command, /tailscale/i)
  assert.equal(probeReady(result), false)
})

test('probe: an unreachable daemon is not "installed but broken"', async () => {
  const { run } = runner({
    'status --json': { stdout: '', stderr: 'failed to connect to tailscaled: dial unix /var/run/tailscale/tailscaled.sock: connect: connection refused', code: 1 },
  })
  const result = await probe({ bin: BIN, run })
  assert.equal(result.installed, true)
  assert.equal(result.running, false)
  assert.equal(result.error.code, CODES.NOT_RUNNING)
  assert.match(result.error.hint, /tailscaled|服务|daemon/i)
})

test('probe: NeedsLogin carries a login hint and command', async () => {
  const { run } = runner({ 'status --json': ok(JSON.stringify({ Version: '1.80.0', BackendState: 'NeedsLogin' })) })
  const result = await probe({ bin: BIN, run })
  assert.equal(result.installed, true)
  assert.equal(result.running, true)
  assert.equal(result.backendState, 'NeedsLogin')
  assert.equal(result.error.code, CODES.NEEDS_LOGIN)
  assert.equal(typeof result.error.hint, 'string')
  assert.match(result.error.command, /tailscale/i)
  assert.equal(probeReady(result), false)
})

test('probe: a healthy node exposes machine name, tailnet, and self login', async () => {
  const { run, calls } = runner({
    'status --json': ok(statusJson()),
    'serve status --json': ok(serveJson),
  })
  const result = await probe({ bin: BIN, run })
  assert.equal(result.installed, true)
  assert.equal(result.running, true)
  assert.equal(result.backendState, 'Running')
  assert.equal(result.error, undefined)
  assert.equal(result.self.login, 'me@example.com', 'login comes from Self.UserID through the User map')
  assert.equal(result.self.hostName, 'chromebook')
  assert.equal(result.self.dnsName, 'chromebook.tailnet-abc.ts.net', 'the trailing dot is stripped')
  assert.deepEqual(result.self.ips, ['100.101.102.103'])
  assert.equal(result.tailnet.magicDnsSuffix, 'tailnet-abc.ts.net')
  assert.equal(result.tailnet.name, 'example.com')
  assert.equal(result.serve.entries.length, 1, 'existing serve rules are surfaced (F-LIFE-8)')
  assert.equal(probeReady(result), true)
  assert.equal(selfLogin(result), 'me@example.com')
  assert.ok(calls.some((call) => call.key === 'status --json'))
})

test('probe: includeServe=false skips the serve lookup', async () => {
  const { run, calls } = runner({ 'status --json': ok(statusJson()) })
  const result = await probe({ bin: BIN, run, includeServe: false })
  assert.equal(result.serve, undefined)
  assert.equal(calls.length, 1)
})

test('probe: unparseable status output is reported, not thrown', async () => {
  const { run } = runner({ 'status --json': ok('this is not json at all') })
  const result = await probe({ bin: BIN, run })
  assert.equal(result.installed, true)
  assert.equal(result.running, false)
  assert.equal(result.error.code, CODES.STATUS_UNPARSEABLE)
  assert.equal(probeReady(result), false)
})

test('stripTrailingDot: idempotent and defensive', () => {
  assert.equal(stripTrailingDot('host.tailnet.ts.net.'), 'host.tailnet.ts.net')
  assert.equal(stripTrailingDot('host.tailnet.ts.net'), 'host.tailnet.ts.net')
  assert.equal(stripTrailingDot(undefined), undefined)
})

test('serveEnableArgs: always publishes HTTPS on 443', () => {
  assert.deepEqual(serveEnableArgs(8787), ['serve', '--bg', '--https=443', 'http://127.0.0.1:8787'])
  assert.deepEqual(serveEnableArgs('9000'), ['serve', '--bg', '--https=443', 'http://127.0.0.1:9000'])
  assert.equal(serveEnableArgs(0), undefined)
  assert.equal(serveEnableArgs('nope'), undefined)
})

test('serveEnable: publishes over https and reports the tailnet URL', async () => {
  const { run, calls } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': ok('Success.'),
    'status --json': ok(statusJson()),
  })
  const result = await serveEnable({ bin: BIN, port: 8787, run, log: () => {} })
  assert.equal(result.url, 'https://chromebook.tailnet-abc.ts.net')
  assert.equal(calls[0].key, 'serve --bg --https=443 http://127.0.0.1:8787')
})

test('serveEnable: prefers the URL tailscale printed over Self.DNSName', async () => {
  const { run } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': ok('Available on the internet:\nhttps://printed-name.tailnet-abc.ts.net\n|-- / proxy http://127.0.0.1:8787'),
    'status --json': ok(statusJson()),
  })
  const result = await serveEnable({ bin: BIN, port: 8787, run, log: () => {} })
  assert.equal(result.url, 'https://printed-name.tailnet-abc.ts.net')
})

test('serveEnable: a loopback-only printout is ignored in favour of the tailnet name', async () => {
  const { run } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': ok('http://127.0.0.1:8787 is now served'),
    'status --json': ok(statusJson()),
  })
  const result = await serveEnable({ bin: BIN, port: 8787, run, log: () => {} })
  assert.equal(result.url, 'https://chromebook.tailnet-abc.ts.net')
})

test('serveEnable: disabled tailnet certificates are classified for the panel', async () => {
  const { run } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': {
      stdout: '',
      stderr: 'HTTPS certificates are not enabled for your tailnet. To enable, visit https://login.tailscale.com/admin/dns',
      code: 1,
    },
  })
  await assert.rejects(
    () => serveEnable({ bin: BIN, port: 8787, run, log: () => {} }),
    (error) => {
      assert.equal(error.code, CODES.HTTPS_CERTS_DISABLED)
      assert.match(error.hint, /admin|DNS|certificate|证书/i)
      assert.match(error.hint, /quick/i, 'the hint names quick mode as the HTTPS alternative')
      assert.doesNotMatch(error.hint, /--tcp/i)
      assert.doesNotMatch(String(error.command), /--tcp/i, 'the copyable command must never publish plaintext')
      assert.match(String(error.command), /--https=443/)
      return true
    },
  )
})

test('serveEnable: a certificate-less tailnet is attempted exactly once (no plaintext retry)', async () => {
  const { run, calls } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': {
      stdout: '',
      stderr: 'HTTPS certificates are not enabled for your tailnet',
      code: 1,
    },
    'status --json': ok(statusJson()),
  })
  await assert.rejects(
    () => serveEnable({ bin: BIN, port: 8787, run, log: () => {} }),
    (error) => error.code === CODES.HTTPS_CERTS_DISABLED,
  )
  assert.equal(calls.length, 1, 'the failure surfaces instead of degrading to --tcp')
  assert.equal(calls[0].key, 'serve --bg --https=443 http://127.0.0.1:8787')
})

test('serveEnable: a missing machine name is reported instead of a bogus URL', async () => {
  const { run } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': ok('Success.'),
    'status --json': ok(JSON.stringify({ Version: '1.80.0', BackendState: 'Running' })),
  })
  await assert.rejects(
    () => serveEnable({ bin: BIN, port: 8787, run, log: () => {} }),
    (error) => error.code === CODES.SERVE_URL_UNKNOWN,
  )
})

test('serveStatus: JSON and text paths both produce entries', async () => {
  const jsonRun = runner({ 'serve status --json': ok(serveJson) })
  const fromJson = await serveStatus({ bin: BIN, run: jsonRun.run })
  assert.equal(fromJson.parse, 'json')
  assert.deepEqual(fromJson.entries, [{ port: 443, protocol: 'https', target: 'http://127.0.0.1:8787', funnel: false }])

  const text = 'https://chromebook.tailnet-abc.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8787\n'
  const textRun = runner({
    'serve status --json': ok(''),
    'serve status': ok(text),
  })
  const fromText = await serveStatus({ bin: BIN, run: textRun.run })
  assert.equal(fromText.parse, 'text')
  assert.equal(fromText.entries.length, 1)
  assert.equal(fromText.entries[0].port, 443)
  assert.equal(fromText.entries[0].target, 'http://127.0.0.1:8787')
})

test('serveStatus: an empty configuration is not an error', async () => {
  const { run } = runner({
    'serve status --json': ok(''),
    'serve status': ok('No serve config\n'),
  })
  const result = await serveStatus({ bin: BIN, run })
  assert.deepEqual(result.entries, [])
  assert.equal(result.error, undefined)
})

test('serveReset: clears rules, tolerates "nothing to reset", and surfaces real failures', async () => {
  const clean = runner({ 'serve reset': ok('Serve configuration cleared.') })
  await serveReset({ bin: BIN, run: clean.run, log: () => {} })
  assert.equal(clean.calls[0].key, 'serve reset')

  const empty = runner({ 'serve reset': { stdout: '', stderr: 'no serve config', code: 1 } })
  await serveReset({ bin: BIN, run: empty.run, log: () => {} })

  const broken = runner({ 'serve reset': { stdout: '', stderr: 'permission denied: must be root', code: 1 } })
  await assert.rejects(
    () => serveReset({ bin: BIN, run: broken.run, log: () => {} }),
    (error) => error.code === CODES.NOT_OPERATOR,
  )
})

test('serveEnable: a non-operator user gets the operator fix, not a generic conflict', async () => {
  // The exact text a non-operator user sees on Linux (verified against the live
  // tailscale 1.102 build): reads are allowed, the serve write is not.
  const { run } = runner({
    'serve --bg --https=443 http://127.0.0.1:8787': {
      stdout: '',
      stderr: 'sending serve config: Access denied: serve config denied',
      code: 1,
    },
  })
  await assert.rejects(
    () => serveEnable({ bin: BIN, port: 8787, run, log: () => {} }),
    (error) => {
      assert.equal(error.code, CODES.NOT_OPERATOR)
      assert.match(error.hint, /operator/)
      assert.equal(error.command, `sudo ${BIN} set --operator=$USER`)
      return true
    },
  )
})

test('probe: the operator pre-check reads debug prefs and flags a missing operator', async (t) => {
  if (process.platform !== 'linux') { t.skip('operator prefs are Linux-specific'); return }
  const { userInfo } = await import('node:os')
  const current = userInfo().username
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root never needs the operator'); return }

  const withOperator = runner({
    'status --json': ok(statusJson()),
    'serve status --json': ok(serveJson),
    'debug prefs': ok(JSON.stringify({ ControlURL: 'https://controlplane.tailscale.com', OperatorUser: current })),
  })
  const good = await probe({ bin: BIN, run: withOperator.run })
  assert.equal(good.operator.ok, true)
  assert.equal(good.operator.user, current)
  assert.equal(good.operator.command, undefined)

  const withoutOperator = runner({
    'status --json': ok(statusJson()),
    'serve status --json': ok(serveJson),
    // An empty OperatorUser is omitted from the prefs JSON — this is the shape a
    // real non-operator machine reports.
    'debug prefs': ok(JSON.stringify({ ControlURL: 'https://controlplane.tailscale.com' })),
  })
  const bad = await probe({ bin: BIN, run: withoutOperator.run })
  assert.equal(bad.operator.ok, false)
  assert.equal(bad.operator.command, `sudo ${BIN} set --operator=${current}`)
  assert.match(bad.operator.hint, /operator/)
})

test('probe: an unreadable prefs document stays silent instead of warning', async (t) => {
  if (process.platform !== 'linux') { t.skip('Linux-specific'); return }
  const { run } = runner({
    'status --json': ok(statusJson()),
    'serve status --json': ok(serveJson),
    'debug prefs': { stdout: '', stderr: 'Access denied: checkprefs access denied', code: 1 },
  })
  const result = await probe({ bin: BIN, run })
  assert.equal(result.operator, undefined, 'unknown must not become a false warning')
})

test('startDaemonHint: each platform gets the command that actually works there', () => {
  const linux = startDaemonHint({ platform: 'linux', bin: '/usr/bin/tailscale' })
  assert.equal(linux.command, 'sudo systemctl enable --now tailscaled', 'the systemd unit is tailscaled, not tailscale')

  // macOS ships the daemon either inside the app bundle or as a Homebrew service;
  // the resolved binary path is what tells them apart.
  const macApp = startDaemonHint({ platform: 'darwin', bin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' })
  assert.equal(macApp.command, 'open -a Tailscale')
  assert.match(macApp.hint, /Tailscale\.app/)

  const macBrew = startDaemonHint({ platform: 'darwin', bin: '/opt/homebrew/bin/tailscale' })
  assert.equal(macBrew.command, 'brew services start tailscale')
  assert.equal(/systemctl/.test(macBrew.command + macBrew.hint), false, 'no Linux advice on macOS')

  const windows = startDaemonHint({ platform: 'win32', bin: 'C:\\Program Files\\Tailscale\\tailscale.exe' })
  assert.equal(windows.command, 'Start-Service Tailscale')

  // Unknown platform / no binary still yields the Linux default rather than nothing.
  assert.equal(startDaemonHint({}).command, 'sudo systemctl enable --now tailscaled')
})

test('probe: a daemon that is not running reports the platform command', async () => {
  const unreachable = runner({
    'status --json': { stdout: '', stderr: 'failed to connect to local tailscaled; it is running on another port', code: 1 },
  })
  const mac = await probe({ bin: BIN, run: unreachable.run, platform: 'darwin' })
  assert.equal(mac.running, false)
  assert.equal(mac.error.code, CODES.NOT_RUNNING)
  assert.equal(mac.error.command, 'brew services start tailscale', 'a Mac user gets the Homebrew command, not systemctl')
  assert.equal(/systemctl/.test(mac.error.hint), false)

  const linux = await probe({ bin: BIN, run: unreachable.run })
  assert.equal(linux.error.command, 'sudo systemctl enable --now tailscaled', 'Linux keeps the systemd unit name')
})
