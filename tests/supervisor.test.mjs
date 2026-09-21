/**
 * Unit tests for the supervision primitives: backoff (F-LIFE-7), the atomic
 * status file (F-OBS-2 / F-FILE), the throttled writer, and the exit
 * classifier. Everything runs offline in temporary directories.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyExit, createRetry, createStatusWriter, writeStatusFile } from '../lib/supervisor.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function temporaryDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const noTemporaryFiles = async (directory) => (await readdir(directory)).filter((name) => name.endsWith('.tmp'))

test('createRetry: exponential backoff, cap, exhaustion, and reset', () => {
  const retry = createRetry({ log: () => {} })
  assert.equal(retry.attempts, 0)

  const delays = []
  for (let index = 0; index < 11; index += 1) delays.push(retry.next())

  assert.deepEqual(delays.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 32000])
  assert.deepEqual(delays.slice(6), [60000, 60000, 60000, 60000, undefined], 'the delay is capped and then the budget runs out')
  assert.equal(retry.attempts, 10)
  assert.equal(retry.next(), undefined, 'exhaustion is sticky')

  retry.reset()
  assert.equal(retry.attempts, 0)
  assert.equal(retry.next(), 1000, 'reset returns to the shortest delay')
})

test('createRetry: custom budget and factor', () => {
  const growing = createRetry({ minDelayMs: 100, maxDelayMs: 1000, factor: 3, maxAttempts: 3, log: () => {} })
  assert.deepEqual([growing.next(), growing.next(), growing.next()], [100, 300, 900])

  const capped = createRetry({ minDelayMs: 100, maxDelayMs: 250, factor: 3, maxAttempts: 3, log: () => {} })
  assert.deepEqual([capped.next(), capped.next(), capped.next()], [100, 250, 250])
  assert.equal(capped.next(), undefined)
  assert.equal(capped.attempts, 3)
})

test('createRetry: degenerate budgets never retry', () => {
  assert.equal(createRetry({ maxAttempts: 0 }).next(), undefined)
  assert.equal(createRetry({ maxAttempts: -5 }).next(), undefined)
  assert.equal(createRetry({ maxAttempts: 1 }).next(), 1000)
})

test('createRetry: logs exhaustion once and works without a log', () => {
  const logs = []
  const retry = createRetry({ maxAttempts: 1, log: (level, message) => logs.push([level, message]) })
  assert.equal(retry.next(), 1000)
  assert.equal(retry.next(), undefined)
  assert.equal(retry.next(), undefined)
  assert.equal(logs.filter(([level]) => level === 'warn').length, 1)

  const silent = createRetry({ maxAttempts: 1 })
  assert.equal(silent.next(), 1000)
  assert.equal(silent.next(), undefined)
})

test('writeStatusFile: writes pretty JSON with a trailing newline', async (t) => {
  const directory = await temporaryDir(t)
  const path = join(directory, 'remote-access.json')
  const value = {
    enabled: true,
    mode: 'quick',
    url: 'https://citrus-brotherhood-briefs-cassette.trycloudflare.com',
    port: 8787,
    clients: [],
    lastError: undefined,
    updatedAt: 1719830400000,
  }

  await writeStatusFile(path, value)
  const content = await readFile(path, 'utf8')
  assert.equal(content, `${JSON.stringify(value, null, 2)}\n`)
  assert.ok(content.endsWith('\n'))
  assert.deepEqual(JSON.parse(content), JSON.parse(JSON.stringify(value)))
  assert.deepEqual(await readdir(directory), ['remote-access.json'], 'the temp file is renamed away')
})

test('writeStatusFile: replaces the file atomically with mode 0600', async (t) => {
  const directory = await temporaryDir(t)
  const path = join(directory, 'remote-access.json')

  // A stale, world-readable status file must be replaced, not appended to.
  await writeFile(path, 'stale and much longer than the new content', { encoding: 'utf8', mode: 0o644 })

  await writeStatusFile(path, { enabled: false })
  assert.equal(await readFile(path, 'utf8'), '{\n  "enabled": false\n}\n')
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'F-FILE requires 0600')
  }
  assert.deepEqual(await noTemporaryFiles(directory), [])
})

test('writeStatusFile: creates missing directories and tolerates odd values', async (t) => {
  const directory = await temporaryDir(t)
  const path = join(directory, 'nested', 'deeper', 'remote-access.json')
  await writeStatusFile(path, { ok: true })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ok: true })

  await writeStatusFile(path, undefined)
  assert.equal(await readFile(path, 'utf8'), 'null\n')
  assert.deepEqual(await noTemporaryFiles(join(directory, 'nested', 'deeper')), [])
})

test('writeStatusFile: a failed rename rejects and cleans up its temp file', async (t) => {
  const directory = await temporaryDir(t)
  const path = join(directory, 'taken')
  await mkdir(path, { recursive: true })

  await assert.rejects(writeStatusFile(path, { a: 1 }))
  assert.deepEqual(await noTemporaryFiles(directory), [], 'no .tmp file may be left behind')
})

test('createStatusWriter: bursts collapse into one trailing write', async () => {
  const writes = []
  const writer = createStatusWriter({
    path: '/never/touched.json',
    intervalMs: 100,
    log: () => {},
    writeImpl: async (_path, value) => { writes.push(value) },
  })

  writer({ seq: 0 })                                   // leading write, immediately
  await delay(20)
  writer({ seq: 1 }); writer({ seq: 2 }); writer({ seq: 3 })
  await delay(30)
  assert.equal(writes.length, 1, 'still inside the throttle window')

  await delay(150)
  assert.equal(writes.length, 2, 'exactly one trailing write carries the burst')
  assert.deepEqual(writes[1], { seq: 3 }, 'the newest value wins')

  // After the window has passed, the next call writes immediately again.
  writer({ seq: 4 })
  await delay(20)
  assert.equal(writes.length, 3)
  assert.deepEqual(writes[2], { seq: 4 })
})

test('createStatusWriter: the last value always lands on disk', async (t) => {
  const directory = await temporaryDir(t)
  const path = join(directory, 'remote-access.json')
  const writer = createStatusWriter({ path, intervalMs: 60, log: () => {} })

  for (let index = 0; index < 6; index += 1) writer({ enabled: true, seq: index })
  await delay(250)

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { enabled: true, seq: 5 })
  assert.deepEqual(await noTemporaryFiles(directory), [])
})

test('createStatusWriter: write failures are logged, never thrown', async () => {
  const logs = []
  const writer = createStatusWriter({
    path: '/never/touched.json',
    intervalMs: 10,
    log: (level, message) => logs.push([level, message]),
    writeImpl: async () => { throw new Error('disk on fire') },
  })

  assert.doesNotThrow(() => writer({ a: 1 }))
  writer({ a: 2 })
  await delay(60)
  assert.ok(logs.some(([level, message]) => level === 'error' && message.includes('disk on fire')))
})

test('createStatusWriter: flush() settles pending writes (shutdown path)', async (t) => {
  const directory = await temporaryDir(t)
  const path = join(directory, 'remote-access.json')
  const writer = createStatusWriter({ path, intervalMs: 5000, log: () => {} })

  writer({ enabled: false, seq: 1 })
  writer({ enabled: false, seq: 2 })
  await writer.flush()

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { enabled: false, seq: 2 })
  assert.deepEqual(await noTemporaryFiles(directory), [])
})

test('createStatusWriter: intervalMs 0 writes every value', async () => {
  const writes = []
  const writer = createStatusWriter({
    path: '/never/touched.json',
    intervalMs: 0,
    log: () => {},
    writeImpl: async (_path, value) => { writes.push(value) },
  })
  writer({ seq: 1 }); writer({ seq: 2 }); writer({ seq: 3 })
  await delay(20)
  assert.deepEqual(writes, [{ seq: 1 }, { seq: 2 }, { seq: 3 }])
})

test('classifyExit: intentional stops are final', () => {
  assert.deepEqual(classifyExit({ code: 0, signal: null }), { retryable: false, reason: 'exited cleanly' })
  assert.deepEqual(classifyExit({ code: null, signal: 'SIGTERM' }), { retryable: false, reason: 'stopped (SIGTERM)' })
  assert.deepEqual(classifyExit({ code: null, signal: 'SIGINT' }), { retryable: false, reason: 'stopped (SIGINT)' })
})

test('classifyExit: crashes are retryable', () => {
  assert.deepEqual(classifyExit({ code: 1, signal: null }), { retryable: true, reason: 'crashed with exit code 1' })
  assert.deepEqual(classifyExit({ code: 137, signal: null }), { retryable: true, reason: 'crashed with exit code 137' })
  assert.deepEqual(classifyExit({ code: null, signal: 'SIGSEGV' }), { retryable: true, reason: 'killed by signal SIGSEGV' })
  assert.deepEqual(classifyExit({ code: null, signal: 'sigkill' }), { retryable: true, reason: 'killed by signal SIGKILL' })
})

test('classifyExit: a spawn that never reported a status is retryable', () => {
  assert.deepEqual(classifyExit({ code: null, signal: null }), { retryable: true, reason: 'exited without a status' })
  assert.deepEqual(classifyExit({ code: undefined, signal: undefined }), { retryable: true, reason: 'exited without a status' })
  assert.deepEqual(classifyExit(), { retryable: true, reason: 'exited without a status' })
})

test('classifyExit: paired with createRetry it drives a bounded restart budget', () => {
  const retry = createRetry({ minDelayMs: 10, maxDelayMs: 40, maxAttempts: 3, log: () => {} })
  const seen = []
  for (const exit of [{ code: 1, signal: null }, { code: null, signal: 'SIGSEGV' }, { code: 0, signal: null }]) {
    const verdict = classifyExit(exit)
    if (verdict.retryable) seen.push([verdict.reason, retry.next()])
  }
  assert.deepEqual(seen, [
    ['crashed with exit code 1', 10],
    ['killed by signal SIGSEGV', 20],
  ])
})
