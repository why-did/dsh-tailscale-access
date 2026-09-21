/**
 * cloudflared quick-tunnel lifecycle: find (or download) the binary, spawn
 * `cloudflared tunnel --url http://127.0.0.1:<port>`, and announce the public
 * `https://<words>.trycloudflare.com` URL (F-MODE quick, F-DETECT, F-LIFE-7).
 *
 * A quick tunnel needs no Cloudflare account, and its hostname is regenerated
 * on every start, so the URL is announced once per `startTunnel()` call and
 * never cached: after a restart the caller always receives the *new* URL.
 *
 * Failures are `Error`s carrying a `code` — `CLOUDFLARED_MISSING` or
 * `CLOUDFLARED_DOWNLOAD_FAILED` — plus `hint`/`command` strings the panel can
 * show verbatim (F-ERR). Nothing here logs through `console`; everything goes
 * through the injected `log(level, message)`.
 */

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, createWriteStream, statSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download'
/** Quick-tunnel hostname as cloudflared prints it inside its ASCII box. */
const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/
/** Scheme prefix kept around so a URL split across chunks is still matched. */
const URL_SCHEME = 'https://'
/** Upper bound on the carried-over tail. */
const SCAN_WINDOW = 512

const noop = () => {}

/** Describe an unknown thrown value without ever touching `console`. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Build an `Error` with the `code`/`hint`/`command` shape the panel expects. */
function codedError(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra !== undefined) Object.assign(error, extra)
  return error
}

/** Release-asset architecture suffix (matches Cloudflare's download names). */
function archSuffix(arch = process.arch) {
  switch (arch) {
    case 'arm64': return 'arm64'
    case 'arm': return 'arm'
    default: return 'amd64'
  }
}

/** The file name our downloader writes into the cache directory. */
function installName({ platform = process.platform, arch = process.arch } = {}) {
  return `cloudflared-${archSuffix(arch)}${platform === 'win32' ? '.exe' : ''}`
}

/** Candidate locations inside the cache directory, in lookup order. */
function cacheCandidates(cacheDir, { platform = process.platform, arch = process.arch } = {}) {
  return [
    join(cacheDir, installName({ platform, arch })),
    join(cacheDir, `cloudflared${platform === 'win32' ? '.exe' : ''}`),
  ]
}

/** The release asset for this platform, or `undefined` when unsupported. */
function releaseTarget({ platform = process.platform, arch = process.arch } = {}) {
  const suffix = archSuffix(arch)
  if (platform === 'linux') return { asset: `cloudflared-linux-${suffix}`, archive: false }
  if (platform === 'darwin') return { asset: `cloudflared-darwin-${suffix}.tgz`, archive: true }
  if (platform === 'win32') return { asset: `cloudflared-windows-${suffix}.exe`, archive: false }
  return undefined
}

/** A copy-pasteable fallback install command (F-DETECT / F-ERR). */
function installCommand(options = {}) {
  const { platform = process.platform } = options
  if (platform === 'darwin') return 'brew install cloudflared'
  if (platform === 'win32') return 'winget install --id Cloudflare.cloudflared'
  const target = releaseTarget(options)
  if (target === undefined) return 'https://github.com/cloudflare/cloudflared/releases/latest'
  return `curl -L -o ./cloudflared ${RELEASE_BASE}/${target.asset} && chmod +x ./cloudflared`
}

/** An executable regular file (a directory with the x bit does not count). */
function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Keep only the piece of `text` that a later chunk could still complete into a
 * URL: everything from the last `https://` marker, or a trailing fragment of
 * the scheme itself (`htt` + `ps://…` across a chunk boundary). Anything else is
 * dropped so the buffer cannot grow without bound.
 */
function incompleteTail(text) {
  const marker = text.lastIndexOf(URL_SCHEME)
  if (marker >= 0) return text.slice(marker, marker + SCAN_WINDOW)
  for (let length = Math.min(URL_SCHEME.length, text.length); length > 0; length -= 1) {
    if (text.endsWith(URL_SCHEME.slice(0, length))) return text.slice(-length)
  }
  return text.slice(-URL_SCHEME.length)
}

/** Default `tar` runner used to unpack the macOS archive. */
function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => { if (error == null) resolve(undefined); else reject(error) })
  })
}

/**
 * Locate an executable cloudflared: explicit config first, then `PATH`, then
 * the cache directory (arch-suffixed name before a plain one).
 *
 * Optional injections for tests: `env`, `platform`, `arch`.
 *
 * @returns {string|undefined}
 */
export function findCloudflared({ explicitPath, cacheDir, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const candidates = []
  if (typeof explicitPath === 'string' && explicitPath.length > 0) candidates.push(explicitPath)
  for (const directory of String(env?.PATH ?? '').split(delimiter)) {
    if (directory.length > 0) candidates.push(join(directory, 'cloudflared'))
  }
  if (typeof cacheDir === 'string' && cacheDir.length > 0) {
    candidates.push(...cacheCandidates(cacheDir, { platform, arch }))
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Download (and, on macOS, unpack) the latest cloudflared release into
 * `cacheDir`, installing it atomically: the binary only appears under its final
 * name once the transfer is complete, so `findCloudflared` never returns a
 * half-written file.
 *
 * Optional injections for tests: `platform`, `arch`, `fetchImpl`, `run`.
 *
 * @returns {Promise<string>} absolute path of the installed binary
 */
export async function downloadCloudflared({ cacheDir, log = noop, platform = process.platform, arch = process.arch, fetchImpl = fetch, run = defaultRun } = {}) {
  const target = releaseTarget({ platform, arch })
  if (target === undefined) {
    throw codedError('CLOUDFLARED_DOWNLOAD_FAILED', `remote-access: no cloudflared build for ${platform}/${arch}`, {
      hint: 'install cloudflared yourself and point cloudflaredPath at it',
      command: installCommand({ platform, arch }),
    })
  }
  if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
    throw codedError('CLOUDFLARED_DOWNLOAD_FAILED', 'remote-access: a cacheDir is required to download cloudflared', {
      hint: 'set a cache directory (default: $DSH_HOME/cache/cloudflared) or install cloudflared yourself',
      command: installCommand({ platform, arch }),
    })
  }

  const url = `${RELEASE_BASE}/${target.asset}`
  const destination = join(cacheDir, installName({ platform, arch }))
  const temporary = join(cacheDir, `.${installName({ platform, arch })}.${String(process.pid)}.download`)
  await mkdir(cacheDir, { recursive: true })

  try {
    log('info', `remote-access: downloading cloudflared from ${url}`)
    const response = await fetchImpl(url, { redirect: 'follow' })
    if (response?.ok !== true || response.body === null || response.body === undefined) {
      throw codedError('CLOUDFLARED_DOWNLOAD_FAILED', `remote-access: cloudflared download failed: HTTP ${String(response?.status)}`, { url })
    }
    const source = typeof response.body.pipe === 'function' ? response.body : Readable.fromWeb(response.body)
    await pipeline(source, createWriteStream(temporary, { mode: 0o600 }))
    if (statSync(temporary).size === 0) {
      throw codedError('CLOUDFLARED_DOWNLOAD_FAILED', `remote-access: cloudflared download from ${url} was empty`, { url })
    }

    if (!target.archive) {
      await chmod(temporary, 0o755)
      await rename(temporary, destination)
      log('info', `remote-access: cloudflared ready at ${destination}`)
      return destination
    }

    // macOS ships a .tgz: unpack it and use whatever `cloudflared` it contains.
    await run('tar', ['-xzf', temporary, '-C', cacheDir])
    await rm(temporary, { force: true })
    const extracted = cacheCandidates(cacheDir, { platform, arch }).find(isExecutableFile)
    if (extracted === undefined) {
      throw codedError('CLOUDFLARED_DOWNLOAD_FAILED', `remote-access: ${target.asset} did not contain a cloudflared binary`, { url })
    }
    await chmod(extracted, 0o755)
    log('info', `remote-access: cloudflared ready at ${extracted}`)
    return extracted
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    if (error?.code === 'CLOUDFLARED_DOWNLOAD_FAILED') throw error
    throw codedError('CLOUDFLARED_DOWNLOAD_FAILED', `remote-access: cloudflared download failed: ${describe(error)}`, {
      url,
      cause: error,
      hint: 'check the network or proxy, or install cloudflared yourself and set cloudflaredPath',
      command: installCommand({ platform, arch }),
    })
  }
}

/**
 * Return a usable cloudflared, downloading it on first use unless downloads are
 * disabled. Throws `CLOUDFLARED_MISSING` when nothing is available and
 * downloading is off, `CLOUDFLARED_DOWNLOAD_FAILED` when the download fails.
 *
 * Optional injections for tests: `env`, `platform`, `arch`, `fetchImpl`, `run`.
 *
 * @returns {Promise<string>}
 */
export async function ensureCloudflared({ explicitPath, cacheDir, allowDownload = true, log = noop, env = process.env, platform = process.platform, arch = process.arch, fetchImpl = fetch, run = defaultRun } = {}) {
  const found = findCloudflared({ explicitPath, cacheDir, env, platform, arch })
  if (found !== undefined) return found
  if (allowDownload !== true) {
    throw codedError('CLOUDFLARED_MISSING', 'remote-access: cloudflared not found; install it or set cloudflaredPath', {
      hint: 'the quick tunnel needs cloudflared; install it or set cloudflaredPath to an existing binary',
      command: installCommand({ platform, arch }),
    })
  }
  return downloadCloudflared({ cacheDir, log, platform, arch, fetchImpl, run })
}

/**
 * Start a quick tunnel to `http://127.0.0.1:<port>`.
 *
 * - `onUrl(url)` fires exactly once, with the first URL seen on either stream
 *   (stdout and stderr are both scanned, first arrival wins). Later output is
 *   ignored, so a restarted tunnel announces its own fresh URL.
 * - `onExit(code, signal)` fires at most once, and only when the child went
 *   away without us asking (so the caller can restart it, F-LIFE-7). A failed
 *   spawn reports `(null, null)`; an active `stop()` never reports.
 * - `stop()` is idempotent and never throws.
 *
 * Optional injections for tests: `spawnImpl`.
 *
 * @returns {{ readonly url: string|undefined, readonly stopped: boolean, stop: () => void }}
 */
export function startTunnel({ bin, port, log = noop, onUrl = noop, onExit = noop, spawnImpl = spawn } = {}) {
  if (typeof bin !== 'string' || bin.length === 0) {
    throw codedError('CLOUDFLARED_MISSING', 'remote-access: startTunnel needs a cloudflared binary path')
  }
  const target = `http://127.0.0.1:${String(port)}`
  const child = spawnImpl(bin, ['tunnel', '--no-autoupdate', '--url', target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const state = { url: undefined, stopped: false, settled: false, buffer: '' }

  /** Called at most once per child: the first URL wins. */
  const announce = (url) => {
    state.url = url
    log('info', `remote-access: public URL ${url}`)
    try {
      onUrl(url)
    } catch (error) {
      log('error', `remote-access: onUrl handler failed: ${describe(error)}`)
    }
  }

  const scan = (chunk) => {
    if (state.url !== undefined || state.stopped) return
    const text = state.buffer + String(chunk)
    const match = URL_PATTERN.exec(text)
    if (match !== null) {
      state.buffer = ''
      announce(match[0])
      return
    }
    state.buffer = incompleteTail(text)
  }

  /** Called at most once per child, and never after an active stop(). */
  const settle = (code, signal, detail) => {
    if (state.settled) return
    state.settled = true
    if (state.stopped) {
      log('debug', `remote-access: cloudflared stopped (${detail})`)
      return
    }
    log('warn', `remote-access: cloudflared ${detail}`)
    try {
      onExit(code ?? null, signal ?? null)
    } catch (error) {
      log('error', `remote-access: onExit handler failed: ${describe(error)}`)
    }
  }

  child.stdout?.on('data', scan)
  child.stderr?.on('data', scan)
  child.on('exit', (code, signal) => settle(code, signal, `exited (code ${String(code)}, signal ${String(signal)})`))
  child.on('error', (error) => {
    log('error', `remote-access: cloudflared failed to start: ${describe(error)}`)
    settle(null, null, 'failed to start')
  })

  return {
    get url() { return state.url },
    get stopped() { return state.stopped },
    stop() {
      if (state.stopped) return
      // Set before killing: a child that exits inside kill() must stay silent.
      state.stopped = true
      try {
        const signalled = child.kill('SIGTERM')
        log('debug', `remote-access: cloudflared stop requested${signalled === false ? ' (already gone)' : ''}`)
      } catch (error) {
        log('debug', `remote-access: cloudflared stop failed: ${describe(error)}`)
      }
    },
  }
}
