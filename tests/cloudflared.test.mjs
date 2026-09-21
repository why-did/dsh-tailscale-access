/**
 * Unit tests for the cloudflared helper. Everything runs against a fake spawn
 * (an EventEmitter shaped like a ChildProcess) and a fake fetch, so the default
 * run never touches the network and never starts a real tunnel. The two live
 * tests are opt-in through `DSH_TEST_NETWORK=1`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { downloadCloudflared, ensureCloudflared, findCloudflared, startTunnel } from '../lib/cloudflared.js'

/** Only explicit opt-in enables the live (network / real process) tests. */
const NETWORK = process.env.DSH_TEST_NETWORK === '1' || process.env.DSH_TEST_NETWORK === 'true'

const URL = 'https://citrus-brotherhood-briefs-cassette.trycloudflare.com'

/** Verbatim shape of the box cloudflared prints on stderr for a quick tunnel. */
const QUICK_TUNNEL_BOX = [
  '2024-07-01T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.',
  '2024-07-01T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2024-07-01T12:00:00Z INF +--------------------------------------------------------------------------------------------+',
  '2024-07-01T12:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2024-07-01T12:00:00Z INF |  ${URL}                              |`,
  '2024-07-01T12:00:00Z INF +--------------------------------------------------------------------------------------------+',
  '2024-07-01T12:00:00Z INF Version 2024.6.1 (Checksum e3b0c44298fc1c149afbf4c8996fb924)',
  '2024-07-01T12:00:00Z INF Settings: map[no-autoupdate:true protocol:quic url:http://127.0.0.1:8787]',
  '2024-07-01T12:00:00Z INF Initial protocol quic',
  '2024-07-01T12:00:00Z INF Starting metrics server on 127.0.0.1:20241/metrics',
  '2024-07-01T12:00:00Z INF Registered tunnel connection connIndex=0 connection=5f0e location=lhr protocol=quic',
  '',
].join('\n')

/** ChildProcess stand-in: EventEmitter streams, a record of kills, prompt exit. */
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.pid = 4242
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.kills = []
  }

  kill(signal) {
    this.kills.push(signal ?? 'SIGTERM')
    // A killed cloudflared exits promptly — even synchronously, which is the
    // hostile case for the "no onExit after stop()" rule.
    this.emit('exit', 0, null)
    return true
  }
}

/** Injectable spawn that records every call. */
function fakeSpawn() {
  const calls = []
  const spawnImpl = (command, args, options) => {
    const child = new FakeChild()
    calls.push({ command, args, options, child })
    return child
  }
  return { spawnImpl, calls, last: () => calls.at(-1) }
}

/** A Response-alike backed by a real web stream, so the downloader's pipeline runs. */
function fakeResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: body === null ? null : new Response(body).body,
  }
}

async function temporaryDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cloudflared-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function makeExecutable(path) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(path, 0o755)
  return path
}

test('startTunnel: announces the first trycloudflare URL exactly once', () => {
  const spawn = fakeSpawn()
  const urls = []
  const logs = []
  const tunnel = startTunnel({
    bin: '/opt/cloudflared',
    port: 8787,
    log: (level, message) => logs.push([level, message]),
    onUrl: (url) => urls.push(url),
    spawnImpl: spawn.spawnImpl,
  })
  const child = spawn.last().child

  // The box arrives in two chunks, split in the middle of the hostname.
  const cut = QUICK_TUNNEL_BOX.indexOf(URL) + 12
  child.stderr.emit('data', Buffer.from(QUICK_TUNNEL_BOX.slice(0, cut)))
  assert.deepEqual(urls, [], 'a partial URL must not be announced')
  child.stderr.emit('data', Buffer.from(QUICK_TUNNEL_BOX.slice(cut)))

  assert.deepEqual(urls, [URL])
  assert.equal(tunnel.url, URL)

  // Duplicate output and a later (different) URL must not re-announce.
  child.stderr.emit('data', Buffer.from(QUICK_TUNNEL_BOX))
  child.stdout.emit('data', Buffer.from('2024-07-01T12:00:01Z INF |  https://other-words-9999.trycloudflare.com  |\n'))
  assert.deepEqual(urls, [URL], 'onUrl must fire once per tunnel start')
  assert.equal(tunnel.url, URL, 'the first URL wins')

  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes(URL)))

  tunnel.stop()
  assert.equal(tunnel.stopped, true)
})

test('startTunnel: a URL split inside the scheme is still found', () => {
  const spawn = fakeSpawn()
  const urls = []
  startTunnel({ bin: 'cloudflared', port: 8787, log: () => {}, onUrl: (url) => urls.push(url), spawnImpl: spawn.spawnImpl })
  const child = spawn.last().child

  child.stderr.emit('data', '2024-07-01T12:00:00Z INF |  htt')
  assert.deepEqual(urls, [])
  child.stderr.emit('data', 'ps://split-across-chunks.trycloudflare.com  |\n')
  assert.deepEqual(urls, ['https://split-across-chunks.trycloudflare.com'])
})

test('startTunnel: spawns cloudflared with the documented arguments', () => {
  const spawn = fakeSpawn()
  const tunnel = startTunnel({ bin: '/usr/local/bin/cloudflared', port: 8787, log: () => {}, spawnImpl: spawn.spawnImpl })

  assert.equal(spawn.calls.length, 1)
  const call = spawn.calls[0]
  assert.equal(call.command, '/usr/local/bin/cloudflared')
  assert.deepEqual(call.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787'])
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(tunnel.url, undefined)

  tunnel.stop()
})

test('startTunnel: stop() is idempotent and suppresses onExit', () => {
  const spawn = fakeSpawn()
  const exits = []
  const tunnel = startTunnel({
    bin: 'cloudflared',
    port: 9000,
    log: () => {},
    onExit: (code, signal) => exits.push({ code, signal }),
    spawnImpl: spawn.spawnImpl,
  })
  const child = spawn.last().child

  tunnel.stop()
  tunnel.stop()
  assert.deepEqual(child.kills, ['SIGTERM'], 'the child is killed once')
  assert.deepEqual(exits, [], 'an active stop() must never look like a crash')

  // A late duplicate exit event still must not report.
  child.emit('exit', 0, null)
  assert.deepEqual(exits, [])
})

test('startTunnel: an unexpected exit reports code and signal', () => {
  const spawn = fakeSpawn()
  const exits = []
  const tunnel = startTunnel({
    bin: 'cloudflared',
    port: 9000,
    log: () => {},
    onExit: (code, signal) => exits.push({ code, signal }),
    spawnImpl: spawn.spawnImpl,
  })
  const child = spawn.last().child

  child.emit('exit', 1, null)
  child.emit('exit', null, 'SIGSEGV')
  child.emit('exit', 0, null)
  assert.deepEqual(exits, [{ code: 1, signal: null }], 'onExit fires once per child')
  assert.equal(tunnel.stopped, false)
})

test('startTunnel: a signalled exit reports the signal', () => {
  const spawn = fakeSpawn()
  const exits = []
  startTunnel({
    bin: 'cloudflared',
    port: 9000,
    log: () => {},
    onExit: (code, signal) => exits.push({ code, signal }),
    spawnImpl: spawn.spawnImpl,
  })
  spawn.last().child.emit('exit', null, 'SIGSEGV')
  assert.deepEqual(exits, [{ code: null, signal: 'SIGSEGV' }])
})

test('startTunnel: a spawn error is reported as a failed start', () => {
  const spawn = fakeSpawn()
  const exits = []
  const logs = []
  startTunnel({
    bin: 'cloudflared',
    port: 9000,
    log: (level, message) => logs.push([level, message]),
    onExit: (code, signal) => exits.push({ code, signal }),
    spawnImpl: spawn.spawnImpl,
  })
  spawn.last().child.emit('error', new Error('spawn cloudflared ENOENT'))

  assert.deepEqual(exits, [{ code: null, signal: null }])
  assert.ok(logs.some(([level, message]) => level === 'error' && message.includes('ENOENT')))
})

test('startTunnel: refuses to start without a binary', () => {
  assert.throws(() => startTunnel({ port: 8787 }), (error) => {
    assert.equal(error.code, 'CLOUDFLARED_MISSING')
    return true
  })
})

test('findCloudflared: explicit path, PATH, and cache dir', async (t) => {
  const directory = await temporaryDir(t)
  const emptyDir = join(directory, 'empty')
  await mkdir(emptyDir, { recursive: true })
  const missing = join(directory, 'nope', 'cloudflared')

  const explicitBin = await makeExecutable(join(directory, 'explicit', 'my-cloudflared'))
  const pathBin = await makeExecutable(join(directory, 'path-b', 'cloudflared'))
  const cacheBin = await makeExecutable(join(directory, 'cache', 'cloudflared-amd64'))
  const plainCacheBin = await makeExecutable(join(directory, 'cache-plain', 'cloudflared'))
  const notExecutable = join(directory, 'noexec', 'cloudflared')
  await mkdir(dirname(notExecutable), { recursive: true })
  await writeFile(notExecutable, 'not for you', 'utf8')
  await chmod(notExecutable, 0o644)
  const directoryNamedBin = join(directory, 'dir-bin', 'cloudflared')
  await mkdir(directoryNamedBin, { recursive: true })

  await t.test('an explicit path wins over everything else', () => {
    assert.equal(findCloudflared({ explicitPath: explicitBin, cacheDir: join(directory, 'cache'), env: { PATH: '' }, arch: 'x64' }), explicitBin)
  })

  await t.test('PATH entries are searched in order, across the delimiter', () => {
    const env = { PATH: [join(directory, 'path-a'), join(directory, 'path-b')].join(delimiter) }
    assert.equal(findCloudflared({ explicitPath: missing, cacheDir: emptyDir, env, arch: 'x64' }), pathBin)
  })

  await t.test('the cache dir is searched by arch name, then plain name', () => {
    assert.equal(findCloudflared({ cacheDir: join(directory, 'cache'), env: { PATH: '' }, arch: 'x64' }), cacheBin)
    assert.equal(findCloudflared({ cacheDir: join(directory, 'cache-plain'), env: { PATH: '' }, arch: 'arm64' }), plainCacheBin)
  })

  await t.test('missing, non-executable, and directory candidates yield undefined', () => {
    assert.equal(findCloudflared({ explicitPath: missing, cacheDir: emptyDir, env: { PATH: '' } }), undefined)
    assert.equal(findCloudflared({ explicitPath: notExecutable, cacheDir: emptyDir, env: { PATH: '' } }), undefined)
    assert.equal(findCloudflared({ explicitPath: directoryNamedBin, cacheDir: emptyDir, env: { PATH: '' } }), undefined)
    assert.equal(findCloudflared({ env: { PATH: '' } }), undefined)
  })
})

test('ensureCloudflared: a found binary is returned without downloading', async (t) => {
  const directory = await temporaryDir(t)
  const bin = await makeExecutable(join(directory, 'cache', 'cloudflared-amd64'))
  const found = await ensureCloudflared({
    cacheDir: join(directory, 'cache'),
    env: { PATH: '' },
    arch: 'x64',
    allowDownload: false,
    fetchImpl: () => { throw new Error('must not download') },
  })
  assert.equal(found, bin)
})

test('ensureCloudflared: allowDownload=false and nothing found throws CLOUDFLARED_MISSING', async (t) => {
  const directory = await temporaryDir(t)
  await assert.rejects(
    ensureCloudflared({
      explicitPath: join(directory, 'missing-cloudflared'),
      cacheDir: join(directory, 'cache'),
      allowDownload: false,
      env: { PATH: '' },
      fetchImpl: () => { throw new Error('must not download') },
    }),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARED_MISSING')
      assert.match(error.message, /cloudflared/)
      assert.equal(typeof error.command, 'string')
      return true
    },
  )
  // Refusing to download must not create the cache directory at all.
  await assert.rejects(readdir(join(directory, 'cache')), { code: 'ENOENT' })
})

test('downloadCloudflared: installs the linux asset atomically', async (t) => {
  const directory = await temporaryDir(t)
  const cacheDir = join(directory, 'cache')
  const logs = []
  const url = await downloadCloudflared({
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    log: (level, message) => logs.push([level, message]),
    fetchImpl: async (requested) => {
      assert.equal(requested, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64')
      return fakeResponse('#!/bin/sh\necho cloudflared\n')
    },
  })

  assert.equal(url, join(cacheDir, 'cloudflared-amd64'))
  assert.deepEqual(await readdir(cacheDir), ['cloudflared-amd64'], 'no temp file may survive a successful download')
  assert.equal(await findCloudflared({ cacheDir, env: { PATH: '' }, arch: 'x64' }), url)
  assert.ok(logs.some(([level]) => level === 'info'))
})

test('downloadCloudflared: a failed download leaves no binary behind', async (t) => {
  const directory = await temporaryDir(t)
  const cacheDir = join(directory, 'cache')

  await assert.rejects(
    downloadCloudflared({ cacheDir, platform: 'linux', arch: 'x64', log: () => {}, fetchImpl: async () => fakeResponse('nope', { status: 503 }) }),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARED_DOWNLOAD_FAILED')
      assert.match(error.message, /503/)
      return true
    },
  )
  await assert.rejects(
    downloadCloudflared({ cacheDir, platform: 'linux', arch: 'x64', log: () => {}, fetchImpl: async () => fakeResponse('') }),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARED_DOWNLOAD_FAILED')
      assert.match(error.message, /empty/)
      return true
    },
  )
  await assert.rejects(
    downloadCloudflared({ cacheDir, platform: 'linux', arch: 'x64', log: () => {}, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') } }),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARED_DOWNLOAD_FAILED')
      assert.match(error.message, /ENOTFOUND/)
      return true
    },
  )

  assert.deepEqual((await readdir(cacheDir)).filter((name) => name.startsWith('cloudflared')), [], 'a failed download must not install a binary')
  assert.equal(await findCloudflared({ cacheDir, env: { PATH: '' }, arch: 'x64' }), undefined)
})

test('downloadCloudflared: macOS archives are unpacked', async (t) => {
  const directory = await temporaryDir(t)
  const cacheDir = join(directory, 'cache')
  const runs = []
  const url = await downloadCloudflared({
    cacheDir,
    platform: 'darwin',
    arch: 'arm64',
    log: () => {},
    fetchImpl: async (requested) => {
      assert.equal(requested, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz')
      return fakeResponse('pretend this is a gzip stream')
    },
    run: async (file, args) => {
      runs.push([file, args])
      // Stand in for tar: drop the binary where the real archive puts it.
      await makeExecutable(join(cacheDir, 'cloudflared'))
    },
  })

  assert.deepEqual(runs, [['tar', ['-xzf', join(cacheDir, '.cloudflared-arm64.' + String(process.pid) + '.download'), '-C', cacheDir]]])
  assert.equal(url, join(cacheDir, 'cloudflared'))
  assert.equal(await findCloudflared({ cacheDir, env: { PATH: '' }, platform: 'darwin', arch: 'arm64' }), url)
})

test('downloadCloudflared: unsupported platforms fail with a code and a hint', async (t) => {
  const directory = await temporaryDir(t)
  await assert.rejects(
    downloadCloudflared({ cacheDir: join(directory, 'cache'), platform: 'aix', arch: 'ppc64', log: () => {}, fetchImpl: async () => fakeResponse('') }),
    (error) => {
      assert.equal(error.code, 'CLOUDFLARED_DOWNLOAD_FAILED')
      assert.equal(typeof error.command, 'string')
      return true
    },
  )
})

test('ensureCloudflared: downloads on first use when allowed', async (t) => {
  const directory = await temporaryDir(t)
  const cacheDir = join(directory, 'cache')
  const bin = await ensureCloudflared({
    cacheDir,
    env: { PATH: '' },
    platform: 'linux',
    arch: 'x64',
    log: () => {},
    fetchImpl: async () => fakeResponse('#!/bin/sh\nexit 0\n'),
  })
  assert.equal(bin, join(cacheDir, 'cloudflared-amd64'))
  assert.deepEqual(await readdir(cacheDir), ['cloudflared-amd64'])
})

test('live: ensureCloudflared downloads a real binary', { skip: !NETWORK }, async (t) => {
  const directory = await temporaryDir(t)
  const bin = await ensureCloudflared({ cacheDir: join(directory, 'cache'), log: () => {} })
  assert.match(bin, /cloudflared/)
})

test('live: startTunnel announces a real quick-tunnel URL', { skip: !NETWORK }, async (t) => {
  const directory = await temporaryDir(t)
  const bin = await ensureCloudflared({ cacheDir: join(directory, 'cache'), log: () => {} })
  let announce
  const announced = new Promise((resolve) => { announce = resolve })
  const tunnel = startTunnel({ bin, port: 9, log: () => {}, onUrl: announce })
  t.after(() => tunnel.stop())
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('no quick-tunnel URL within 60s')), 60000)
    t.after(() => clearTimeout(timer))
  })
  const url = await Promise.race([announced, timeout])
  assert.match(url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/)
})
