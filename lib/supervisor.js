/**
 * Tunnel supervision primitives: exponential backoff (F-LIFE-7), the atomic
 * status file (F-OBS-2 / F-FILE), a throttled writer for it, and the exit
 * classifier that decides whether a dead child deserves a restart.
 *
 * Nothing here spawns processes or reads config — `lib/index.js` wires these
 * together. Logging goes through the injected `log(level, message)` only; this
 * module never touches `console`.
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const DEFAULT_MIN_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 60000
const DEFAULT_FACTOR = 2
const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_STATUS_INTERVAL_MS = 500

/** Signals that mean "we asked it to stop", not "it crashed". */
const INTENTIONAL_SIGNALS = new Set(['SIGTERM', 'SIGINT'])

let temporaryCounter = 0

/** Describe an unknown thrown value without ever touching `console`. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** A finite number > 0, otherwise the fallback. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Exponential backoff state machine.
 *
 * `next()` returns how long to wait (ms) before the next attempt and counts
 * that attempt; once `maxAttempts` attempts are used up it returns `undefined`.
 * `reset()` clears the count and the delay back to `minDelayMs` (call it after
 * a successful start). `attempts` is the number of attempts handed out so far.
 *
 * Optional injections for tests: `log`.
 *
 * @returns {{ next: () => number|undefined, reset: () => void, readonly attempts: number }}
 */
export function createRetry({
  minDelayMs = DEFAULT_MIN_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  factor = DEFAULT_FACTOR,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  log = () => {},
} = {}) {
  const base = positive(minDelayMs, DEFAULT_MIN_DELAY_MS)
  const cap = Math.max(base, positive(maxDelayMs, DEFAULT_MAX_DELAY_MS))
  const growth = Math.max(1, positive(factor, DEFAULT_FACTOR))
  const limit = maxAttempts === Infinity
    ? Infinity
    : Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 0
  let attempts = 0
  let announced = false

  return {
    get attempts() { return attempts },
    next() {
      if (attempts >= limit) {
        if (!announced) {
          announced = true
          log('warn', `remote-access: retry budget exhausted after ${String(attempts)} attempts`)
        }
        return undefined
      }
      const delay = Math.min(cap, base * growth ** attempts)
      attempts += 1
      return delay
    },
    reset() {
      attempts = 0
      announced = false
      log('debug', 'remote-access: retry budget reset')
    },
  }
}

/**
 * Atomically replace `path` with `value` as pretty JSON: same-directory temp
 * file, `rename` onto the target, mode 0600, trailing newline. Readers never
 * observe a partial file and a failure leaves no temp file behind
 * (F-OBS-2 / F-FILE / F-SEC-5).
 *
 * @returns {Promise<void>}
 */
export async function writeStatusFile(path, value) {
  const serialized = JSON.stringify(value, undefined, 2)
  const body = `${serialized === undefined ? 'null' : serialized}\n`
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  temporaryCounter += 1
  const temporary = join(directory, `.${basename(path)}.${String(process.pid)}.${String(temporaryCounter)}.tmp`)
  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Wrap `writeStatusFile` into a fire-and-forget writer that coalesces bursts:
 * at most one write per `intervalMs`, plus a trailing write carrying the latest
 * value, so the final state always lands on disk. Write failures are logged and
 * never thrown or left as unhandled rejections.
 *
 * The returned function also exposes `flush(): Promise<void>` for shutdown
 * (F-LIFE-6) — awaiting it resolves once every queued write has settled.
 *
 * Optional injections for tests: `intervalMs`, `writeImpl`, `log`.
 *
 * @returns {((value: unknown) => void) & { flush: () => Promise<void> }}
 */
export function createStatusWriter({ path, log = () => {}, intervalMs = DEFAULT_STATUS_INTERVAL_MS, writeImpl = writeStatusFile } = {}) {
  const window = positive(intervalMs, 0)
  let lastWriteAt = 0
  let timer
  let pending
  let hasPending = false
  let chain = Promise.resolve()

  const perform = (value) => {
    lastWriteAt = Date.now()
    chain = chain.then(() => writeImpl(path, value)).catch((error) => {
      log('error', `remote-access: failed to write status file ${path}: ${describe(error)}`)
    })
  }

  const release = () => {
    timer = undefined
    if (!hasPending) return
    const value = pending
    hasPending = false
    perform(value)
  }

  const write = (value) => {
    if (timer !== undefined) {
      // Inside the throttle window: remember only the newest value.
      pending = value
      hasPending = true
      return
    }
    const elapsed = Date.now() - lastWriteAt
    if (elapsed >= window) {
      perform(value)
      return
    }
    pending = value
    hasPending = true
    timer = setTimeout(release, window - elapsed)
    // Never keep the harness alive just to flush a status file.
    if (typeof timer.unref === 'function') timer.unref()
  }

  write.flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    release()
    return chain
  }

  return write
}

/**
 * Decide whether a dead tunnel child should be restarted (F-LIFE-7).
 *
 * An intentional stop (clean exit, SIGTERM/SIGINT) is final; a crash, a
 * non-zero code, or a spawn that never produced a status is retryable.
 *
 * @returns {{ retryable: boolean, reason: string }}
 */
export function classifyExit({ code = null, signal = null } = {}) {
  if (signal !== null && signal !== undefined) {
    const name = String(signal).toUpperCase()
    if (INTENTIONAL_SIGNALS.has(name)) return { retryable: false, reason: `stopped (${name})` }
    return { retryable: true, reason: `killed by signal ${name}` }
  }
  if (code === 0) return { retryable: false, reason: 'exited cleanly' }
  if (typeof code === 'number' && Number.isFinite(code)) {
    return { retryable: true, reason: `crashed with exit code ${String(code)}` }
  }
  return { retryable: true, reason: 'exited without a status' }
}
