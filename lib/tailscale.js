/**
 * Tailscale detection and `tailscale serve` orchestration.
 *
 * Covers detection and the five states, serve wiring (HTTPS only),
 * F-LIFE-4 (`serve reset`), F-LIFE-8 (leftover-rule detection) and F-AUTH-1a
 * (resolve the `Self` login from `Self.UserID` + the `User` map).
 *
 * Two rules shape the whole file:
 *
 * 1. Every shell call goes through an injectable `run(command, args, options)`
 *    that resolves — never rejects — to `{ stdout, stderr, code, error }`.
 *    Tests inject a fake so the system `tailscale` binary is never executed.
 * 2. Nothing is thrown for "tailscale is not usable". `probe()` reports the
 *    state and the machine-readable `error.code`; only *actions*
 *    (`serveEnable`, `serveReset`) throw, with `code` / `hint` / `command`
 *    attached so the panel can show one plain sentence plus a copyable fix.
 *
 * No import-time side effects, no `console.*`, no external dependencies.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Per-command budget: a wedged tailscaled must not hang the panel forever. */
export const COMMAND_TIMEOUT_MS = 15_000

/** Error codes used by this module (superset of the codes frozen in INTERFACES §3). */
export const CODES = Object.freeze({
  NOT_INSTALLED: 'TAILSCALE_NOT_INSTALLED',
  NOT_RUNNING: 'TAILSCALE_NOT_RUNNING',
  NEEDS_LOGIN: 'TAILSCALE_NEEDS_LOGIN',
  HTTPS_CERTS_DISABLED: 'TAILSCALE_HTTPS_CERTS_DISABLED',
  SERVE_CONFLICT: 'TAILSCALE_SERVE_CONFLICT',
  NOT_OPERATOR: 'TAILSCALE_NOT_OPERATOR',
  SERVE_FAILED: 'TAILSCALE_SERVE_FAILED',
  SERVE_STATUS_FAILED: 'TAILSCALE_SERVE_STATUS_FAILED',
  SERVE_URL_UNKNOWN: 'TAILSCALE_SERVE_URL_UNKNOWN',
  STATUS_UNPARSEABLE: 'TAILSCALE_STATUS_UNPARSEABLE',
})

const ADMIN_DNS_URL = 'https://login.tailscale.com/admin/dns'
const INSTALL_DOCS_URL = 'https://tailscale.com/download'
const SERVE_TLS_PORT = 443

/** macOS installs the CLI inside the app bundle; PATH does not always have it. */
const FALLBACK_BINARIES = {
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
}

const noop = () => {}

// ---------------------------------------------------------------------------
// small defensive helpers
// ---------------------------------------------------------------------------

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Trimmed non-empty string, else undefined. Every parsed field goes through it. */
const str = (value) => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

const firstLine = (text) => {
  const line = String(text ?? '').split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0)
  return line === undefined ? undefined : line.slice(0, 400)
}

const truncate = (text, max) => {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535

/** `443`, `"443"` and `"host.tailnet.ts.net:443"` all yield 443. */
function portFromKey(key) {
  if (typeof key !== 'string') return undefined
  const text = key.trim()
  const match = /:(\d{1,5})$/.exec(text)
  const raw = match !== null ? match[1] : (/^\d{1,5}$/.test(text) ? text : undefined)
  if (raw === undefined) return undefined
  const port = Number(raw)
  return validPort(port) ? port : undefined
}

/** `Self.DNSName` keeps a trailing dot; the URL must not. Also used for suffixes. */
export function stripTrailingDot(value) {
  const text = str(value)
  return text === undefined ? undefined : text.replace(/\.+$/, '')
}

const normalizePort = (value) => {
  if (typeof value === 'number' && validPort(value)) return value
  if (typeof value === 'string' && /^\d{1,5}$/.test(value.trim())) {
    const port = Number(value.trim())
    if (validPort(port)) return port
  }
  return undefined
}

/** Drop undefined keys so the probe serializes cleanly into the status route. */
function compact(target) {
  for (const key of Object.keys(target)) {
    if (target[key] === undefined) delete target[key]
  }
  return target
}

/** Like `compact`, but `{}` becomes `undefined` (unset optional sub-objects). */
function compactOrUndefined(target) {
  return Object.keys(compact(target)).length > 0 ? target : undefined
}

function errorInfo(code, message, hint, command, extra) {
  return compact({ code, message, hint, command, ...(extra ?? {}) })
}

/** Turn an `errorInfo` record into a throwable Error carrying the same fields. */
function failure(info) {
  const error = new Error(info.message)
  error.name = 'TailscaleError'
  Object.assign(error, info)
  return error
}

function abortError(reason) {
  const error = new Error('tailscale command aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  if (reason !== undefined) error.cause = reason
  return error
}

function installCommand() {
  switch (process.platform) {
    case 'darwin': return 'brew install tailscale'
    case 'win32': return 'winget install --exact --id Tailscale.Tailscale'
    default: return 'curl -fsSL https://tailscale.com/install.sh | sh'
  }
}

// ---------------------------------------------------------------------------
// injectable process execution
// ---------------------------------------------------------------------------

/**
 * Default `run`: `execFile` wrapped with promisify. Never throws — a missing
 * binary, a non-zero exit and a timeout all come back as data.
 *
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null, error?: Error }>}
 */
export async function defaultRun(command, args, options = {}) {
  const { timeout = COMMAND_TIMEOUT_MS, signal, env, cwd } = options
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout,
      signal,
      env,
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), code: 0 }
  } catch (error) {
    return {
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      code: typeof error?.code === 'number' ? error.code : null,
      error,
    }
  }
}

/** Tolerate hand-written fakes: a bare string is a successful stdout. */
function normalizeResult(result) {
  if (typeof result === 'string') return { stdout: result, stderr: '', code: 0 }
  const value = isObject(result) ? result : {}
  return {
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
    code: typeof value.code === 'number' ? value.code : null,
    error: value.error instanceof Error ? value.error : (isObject(value.error) ? value.error : undefined),
  }
}

function runOptions(signal, timeout) {
  const options = {}
  if (signal !== undefined) options.signal = signal
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) options.timeout = timeout
  return options
}

async function callRun(run, command, args, options) {
  if (options.signal?.aborted === true) throw abortError(options.signal.reason)
  const result = normalizeResult(await run(command, args, options))
  if (result.error?.name === 'AbortError' || options.signal?.aborted === true) throw abortError(options.signal?.reason ?? result.error)
  return result
}

function failed(result) {
  if (result.error !== undefined) return true
  return typeof result.code === 'number' && result.code !== 0
}

/** `tailscale` on PATH (or, on macOS, inside the app bundle). */
export function findTailscale({ explicitPath } = {}) {
  const candidates = []
  const explicit = str(explicitPath)
  if (explicit !== undefined) candidates.push(explicit)
  const binary = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir.length > 0) candidates.push(join(dir, binary))
  }
  for (const fallback of FALLBACK_BINARIES[process.platform] ?? []) candidates.push(fallback)
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

function resolveBin(bin) {
  const explicit = str(bin)
  return explicit !== undefined ? explicit : findTailscale()
}

/** `sudo <bin>` / `<bin>` prefix for copyable commands. */
function binPrefix(bin) {
  return str(bin) !== undefined ? str(bin) : 'tailscale'
}

// ---------------------------------------------------------------------------
// status --json parsing (F-DETECT-1, F-AUTH-1a)
// ---------------------------------------------------------------------------

/**
 * Parse `tailscale status --json` defensively.
 *
 * Required: a JSON object with a non-empty string `BackendState`. Everything
 * else is optional — notably `Self` is absent in the `NeedsLogin` state, and
 * `MagicDNSSuffix` moves between the top level and `CurrentTailnet`.
 *
 * @returns {{ ok: true, value: object } | { ok: false }}
 */
export function parseStatusJson(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) return { ok: false }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (!isObject(data)) return { ok: false }
  if (str(data.BackendState) === undefined) return { ok: false }
  return { ok: true, value: data }
}

const userIdString = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value)
}

/** `User` is `{ [id]: { LoginName } }`; some builds map the id to a bare string. */
function loginFromUser(user) {
  if (typeof user === 'string') return str(user)
  if (!isObject(user)) return undefined
  return str(user.LoginName) ?? str(user.Login)
}

/** F-DETECT-1 + F-AUTH-1a: login, userId, hostName, dnsName (no trailing dot), ips. */
function readSelf(data) {
  const self = isObject(data.Self) ? data.Self : {}
  const users = isObject(data.User) ? data.User : {}
  const userId = userIdString(self.UserID)
  let login
  if (userId !== undefined) login = loginFromUser(users[userId])
  // Fallbacks stay fail-closed: both are still unambiguously about Self.
  if (login === undefined) login = str(self.LoginName)
  if (login === undefined) login = loginFromUser(self.User)
  const ips = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip) => typeof ip === 'string' && ip.trim().length > 0)
    : undefined
  return compact({
    login,
    userId,
    hostName: str(self.HostName),
    dnsName: stripTrailingDot(self.DNSName),
    ips: ips !== undefined && ips.length > 0 ? ips : undefined,
  })
}

/** Tailnet name + MagicDNS suffix from the top level or `CurrentTailnet`. */
function readTailnet(data) {
  const current = isObject(data.CurrentTailnet) ? data.CurrentTailnet : {}
  const suffix = stripTrailingDot(data.MagicDNSSuffix) ?? stripTrailingDot(current.MagicDNSSuffix)
  return compact({
    name: str(current.Name) ?? suffix,
    magicDnsSuffix: suffix,
    magicDns: typeof current.MagicDNSEnabled === 'boolean' ? current.MagicDNSEnabled : undefined,
  })
}

// ---------------------------------------------------------------------------
// serve status parsing (F-LIFE-8)
// ---------------------------------------------------------------------------

function handlerProxy(config) {
  if (!isObject(config)) return ''
  if (isObject(config.Handlers)) {
    for (const handler of Object.values(config.Handlers)) {
      if (!isObject(handler)) continue
      const proxy = str(handler.Proxy)
      if (proxy !== undefined) return proxy
    }
  }
  return str(config.Proxy) ?? ''
}

function funnelFlag(funnelMap, hostPort, port) {
  if (hostPort !== undefined && funnelMap[hostPort] === true) return true
  for (const [key, value] of Object.entries(funnelMap)) {
    if (value !== true) continue
    if (port !== undefined && portFromKey(key) === port) return true
  }
  return false
}

/**
 * Normalize `tailscale serve status --json` (an `ipn.ServeConfig`) into
 * `ServeEntry[]`. Throws only on invalid JSON; `serveStatus` catches that and
 * falls back to the text output.
 */
export function parseServeStatusJson(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  if (!isObject(data)) return []
  const entries = []
  const seen = new Set()
  const push = (entry) => {
    const key = `${entry.protocol}:${String(entry.port)}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }
  const tcp = isObject(data.TCP) ? data.TCP : {}
  const web = isObject(data.Web) ? data.Web : {}
  const forwards = isObject(data.TCPForward) ? data.TCPForward : (isObject(data.Forward) ? data.Forward : {})
  const funnelMap = isObject(data.AllowFunnel) ? data.AllowFunnel : {}
  const webPorts = new Set()
  for (const [hostPort, config] of Object.entries(web)) {
    const port = portFromKey(hostPort) ?? SERVE_TLS_PORT
    webPorts.add(port)
    const listener = isObject(tcp[String(port)]) ? tcp[String(port)] : {}
    push({
      port,
      protocol: listener.HTTPS === false ? 'http' : 'https',
      target: handlerProxy(config),
      funnel: funnelFlag(funnelMap, hostPort, port),
    })
  }
  for (const [key, config] of Object.entries(tcp)) {
    const port = portFromKey(key)
    if (port === undefined || webPorts.has(port)) continue
    const target = str(forwards[key])
      ?? str(forwards[String(port)])
      ?? (isObject(config) ? (str(config.TCPForward) ?? str(config.Proxy)) : undefined)
      ?? ''
    push({ port, protocol: 'tcp', target, funnel: funnelFlag(funnelMap, undefined, port) })
  }
  return entries.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))
}

/**
 * Normalize the human-readable `tailscale serve status` output. One entry per
 * listener line; the first `proxy`/`forward` target under it becomes `target`.
 */
export function parseServeStatusText(raw) {
  const entries = []
  const seen = new Set()
  let current
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const isDetail = trimmed.startsWith('|') || trimmed.startsWith('`') || /\b(proxy|forward)\b/i.test(line)
    if (!isDetail) {
      const head = /^(https?|tcp):\/\/([^\s/]+)/i.exec(trimmed)
      if (head !== null) {
        const protocol = head[1].toLowerCase()
        const port = portFromKey(head[2]) ?? (protocol === 'https' ? SERVE_TLS_PORT : protocol === 'http' ? 80 : 0)
        const key = `${protocol}:${String(port)}`
        if (!seen.has(key)) {
          seen.add(key)
          current = { port, protocol, target: '', funnel: /funnel/i.test(trimmed) }
          entries.push(current)
        }
      }
      continue
    }
    if (current === undefined) continue
    const match = /\b(?:proxy|forward)\s+(?:tcp:\/\/)?(\S+)/i.exec(trimmed)
      ?? /((?:https?|tcp):\/\/\S+)/i.exec(trimmed)
    if (match !== null && current.target === '') current.target = match[1].replace(/\/+$/, '')
    if (/funnel/i.test(trimmed)) current.funnel = true
  }
  return entries
}

// ---------------------------------------------------------------------------
// failure classification
// ---------------------------------------------------------------------------

const NEEDS_LOGIN_PATTERNS = [
  /needs? (?:to )?login/i,
  /logged out/i,
  /not logged in/i,
  /must be logged in/i,
  /login\.tailscale\.com\/a\//i,
]

const NOT_RUNNING_PATTERNS = [
  /failed to connect/i,
  /dial unix/i,
  /dial tcp/i,
  /connection refused/i,
  /cannot connect to the tailscale daemon/i,
  /tailscaled.*(?:not running|stopped|isn't running)/i,
  /is not running/i,
  /tailscale is stopped/i,
  /no such file or directory/i,
  /socket.*(?:missing|not found|refused)/i,
  /timed out/i,
  /timeout/i,
]

const PERMISSION_PATTERNS = [
  /permission denied/i,
  /operation not permitted/i,
  /access denied/i,
  /not permitted/i,
  /\bas root\b/i,
  /\bsudo\b/i,
]

const CONFLICT_PATTERNS = [
  /address already in use/i,
  /EADDRINUSE/i,
  /already in use/i,
  /already exists/i,
  /another serve/i,
  /already (?:has|configured|serving)/i,
  /failed to create listener/i,
  /(?:cannot|failed to) listen/i,
  /\bbind:/i,
  /conflict/i,
]

const CERT_PATTERNS = [
  /https certificates?/i,
  /certificates? (?:are|is) not enabled/i,
  /enable https/i,
  /https is not enabled/i,
  /acme/i,
  /\bcerts?\b/i,
  /magicdns/i,
]

const isDaemonUnreachable = (text) => NOT_RUNNING_PATTERNS.some((pattern) => pattern.test(String(text ?? '')))

function notInstalledInfo(message) {
  return errorInfo(
    CODES.NOT_INSTALLED,
    message ?? '`tailscale` was not found.',
    '未检测到 tailscale 命令（未安装，或不在 PATH 里）：装好并登录后再打开开关。',
    installCommand(),
    { docs: INSTALL_DOCS_URL },
  )
}

/**
 * How to start the tailscaled daemon on this machine.
 *
 * The daemon is not started the same way twice: Linux runs it under systemd
 * (unit `tailscaled`, not `tailscale`), macOS either ships it inside the
 * Tailscale.app bundle or as a Homebrew service, and Windows runs it as a
 * service. A single `systemctl` line is wrong on two of the three, which is
 * exactly what a Mac user reported seeing.
 *
 * @param options - platform and the resolved CLI path (used to tell the macOS
 *   app bundle from a Homebrew install); both default to this process.
 * @returns `{ hint, command }` for the "daemon is not running" case.
 */
export function startDaemonHint({ platform = process.platform, bin } = {}) {
  const resolved = typeof bin === 'string' ? bin : ''
  if (platform === 'darwin') {
    if (resolved.includes('Tailscale.app')) {
      return {
        hint: 'macOS：daemon 随 Tailscale 应用一起运行 —— 打开 Tailscale.app（菜单栏图标）并确认已登录，然后重试。',
        command: 'open -a Tailscale',
      }
    }
    return {
      hint: 'macOS（Homebrew 安装）：用 brew services 启动 tailscaled；若提示权限不足，在命令前加 sudo。',
      command: 'brew services start tailscale',
    }
  }
  if (platform === 'win32') {
    return {
      hint: 'Windows：启动 Tailscale 服务（或以管理员身份打开 Tailscale 应用），然后重试。',
      command: 'Start-Service Tailscale',
    }
  }
  return {
    hint: 'Linux：用 systemd 启动 daemon（服务名是 tailscaled），然后重试。',
    command: 'sudo systemctl enable --now tailscaled',
  }
}

function notRunningInfo(detail, bin, platform) {
  const start = startDaemonHint({ bin, platform })
  return errorInfo(
    CODES.NOT_RUNNING,
    detail !== undefined ? `tailscaled is unreachable: ${detail}` : 'tailscaled is unreachable.',
    start.hint,
    start.command,
  )
}

function needsLoginInfo(data, state) {
  const authUrl = str(data?.AuthURL)
  const hint = authUrl !== undefined
    ? `需要登录 tailscale：在浏览器打开 ${authUrl} 完成授权；也可以用 tailscale up 重新生成登录链接。`
    : '需要登录 tailscale：执行 tailscale up，再按提示在浏览器完成授权。'
  return errorInfo(
    CODES.NEEDS_LOGIN,
    `BackendState=${state ?? 'NeedsLogin'}`,
    hint,
    'sudo tailscale up',
    authUrl !== undefined ? { loginUrl: authUrl } : undefined,
  )
}

function stoppedInfo(state) {
  return errorInfo(
    CODES.NOT_RUNNING,
    `BackendState=${state}`,
    'tailscaled 可达，但 tailscale 后端处于停止状态：执行 tailscale up 接入 tailnet。',
    'sudo tailscale up',
  )
}

/** Map `tailscale status --json` failure output onto one of the five states. */
function classifyStatusFailure(result, executable, platform) {
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const text = `${stderr}\n${stdout}`.trim()
  if (result.error?.code === 'ENOENT') return notInstalledInfo()
  if (result.error?.killed === true && text.length === 0) return notRunningInfo('`tailscale status` was killed (timeout)', executable, platform)
  if (isDaemonUnreachable(text)) return notRunningInfo(firstLine(text), executable, platform)
  if (NEEDS_LOGIN_PATTERNS.some((pattern) => pattern.test(text))) return needsLoginInfo(undefined, 'NeedsLogin')
  if (text.length === 0) {
    return errorInfo(
      CODES.STATUS_UNPARSEABLE,
      `tailscale status --json produced no output (exit code ${String(result.code)}).`,
      '读不懂 tailscale 的状态输出：运行 tailscale status --json 看看原始输出，必要时升级 tailscale。',
      'tailscale status --json',
    )
  }
  return errorInfo(
    CODES.STATUS_UNPARSEABLE,
    `tailscale status --json could not be parsed: ${firstLine(text)}`,
    '读不懂 tailscale 的状态输出：运行 tailscale status --json 看看原始输出，必要时升级 tailscale。',
    'tailscale status --json',
    { raw: truncate(text, 600) },
  )
}

/**
 * Map `tailscale serve ...` failure stderr onto a code the panel understands.
 * Order matters: permission → conflict → certificate → generic.
 */
function classifyServeFailure(text, phase, context = {}) {
  const raw = String(text ?? '').trim()
  const detail = firstLine(raw)
  const label = phase === 'status' ? 'serve status' : 'serve'
  const message = `tailscale ${label} failed: ${detail ?? `exit code ${String(context.code ?? '?')}`}`
  const bin = binPrefix(context.bin)
  const port = validPort(context.port) ? context.port : undefined
  const extra = { raw: truncate(raw, 600) }
  if (PERMISSION_PATTERNS.some((pattern) => pattern.test(raw))) {
    return errorInfo(
      CODES.NOT_OPERATOR,
      message,
      '没有权限配置 serve：Linux 上默认只有 root 能改 serve 配置，当前用户不是 tailscale operator。设为 operator 即可（一次即可，之后无需 sudo）。',
      `sudo ${bin} set --operator=$USER`,
      extra,
    )
  }
  if (CONFLICT_PATTERNS.some((pattern) => pattern.test(raw))) {
    return errorInfo(
      CODES.SERVE_CONFLICT,
      message,
      port !== undefined
        ? `serve 端口已被其它规则占用或存在冲突（可能是上次残留），本地端口 ${String(port)}。`
        : 'serve 端口已被其它规则占用或存在冲突（可能是上次残留）。',
      `${bin} serve reset`,
      extra,
    )
  }
  if (CERT_PATTERNS.some((pattern) => pattern.test(raw))) {
    // There is deliberately no plaintext fallback: an HTTP page is not a secure
    // browser context, so client plugins that call `crypto.randomUUID()` would
    // break. Fail loudly and point at the one real fix, or at `quick` mode.
    return errorInfo(
      CODES.HTTPS_CERTS_DISABLED,
      message,
      '这个 tailnet 没开 HTTPS 证书：到 admin console → DNS → HTTPS Certificates 打开（等证书签发后再重新打开开关），或改用 quick 模式（cloudflared 自带 HTTPS）。',
      port !== undefined ? `${bin} serve --bg --https=443 http://127.0.0.1:${String(port)}` : `${bin} serve status`,
      { ...extra, docs: ADMIN_DNS_URL },
    )
  }
  return errorInfo(
    CODES.SERVE_FAILED,
    message,
    'tailscale serve 执行失败：完整错误见日志，先确认 serve 的当前状态。',
    `${bin} serve status`,
    extra,
  )
}

// ---------------------------------------------------------------------------
// public API (INTERFACES §3)
// ---------------------------------------------------------------------------

/**
 * Inspect the local tailscale state without ever throwing.
 *
 * @param {{ bin?: string, signal?: AbortSignal, run?: Function, includeServe?: boolean, timeout?: number }} [options]
 */
export async function probe(options = {}) {
  const { bin, signal, run = defaultRun, includeServe = true, timeout, platform = process.platform } = options
  const executable = resolveBin(bin)
  if (executable === undefined) {
    return { installed: false, running: false, error: notInstalledInfo('`tailscale` was not found on PATH.') }
  }
  const status = await callRun(run, executable, ['status', '--json'], runOptions(signal, timeout))
  if (status.error?.code === 'ENOENT') {
    return { installed: false, bin: executable, running: false, error: notInstalledInfo(`\`${executable}\` was not found.`) }
  }
  const parsed = parseStatusJson(status.stdout)
  if (!parsed.ok) {
    return { installed: true, bin: executable, running: false, error: classifyStatusFailure(status, executable, platform) }
  }
  const data = parsed.value
  const state = str(data.BackendState)
  const result = compact({
    installed: true,
    bin: executable,
    running: true,
    version: str(data.Version),
    backendState: state,
    self: readSelf(data),
    tailnet: readTailnet(data),
  })
  if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') result.error = needsLoginInfo(data, state)
  else if (state === 'Stopped' || state === 'NoState') result.error = stoppedInfo(state)
  if (includeServe && result.error === undefined) {
    const serve = await serveStatus({ bin: executable, run, signal, timeout })
    result.serve = compact({ raw: serve.raw, entries: serve.entries, parse: serve.parse, error: serve.error })
    const operator = await operatorStatus({ bin: executable, run, signal, timeout })
    if (operator !== undefined) result.operator = operator
  }
  return result
}

/**
 * Whether this process may write the serve config, read before any write is
 * attempted.
 *
 * Reads of `serve status` are allowed to everyone, so the only local signal is
 * `debug prefs`: `OperatorUser` is omitted while empty and appears once set.
 * Root never needs the operator, and the concept is Linux/BSD-specific, so the
 * check stays silent (undefined) everywhere else — an unknown state must not
 * turn into a false warning.
 *
 * @returns `{ user, current, ok, command, hint }` or undefined when unknown.
 */
async function operatorStatus({ bin, run, signal, timeout }) {
  if (process.platform !== 'linux') return undefined
  let current
  try { current = userInfo().username } catch { return undefined }
  if (typeof current !== 'string' || current.length === 0) return undefined
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { user: 'root', current, ok: true }
  }
  const result = await callRun(run, bin, ['debug', 'prefs'], runOptions(signal, timeout))
  if (failed(result)) return undefined
  let prefs
  try { prefs = JSON.parse(String(result.stdout ?? '')) } catch { return undefined }
  if (!isObject(prefs)) return undefined
  const operator = str(prefs.OperatorUser)
  const ok = operator !== undefined && operator === current
  return compact({
    user: operator,
    current,
    ok,
    ...(ok ? {} : {
      command: `sudo ${binPrefix(bin)} set --operator=${current}`,
      hint: '当前用户不是 tailscale operator，只有 root 能改 serve 配置：把当前用户设为 operator 即可（一次即可，之后无需 sudo）。',
    }),
  })
}

/**
 * F-AUTH-1a: the login of the `Self` node, from `Self.UserID` + the `User`
 * map. `undefined` means "unknown" and must be treated as fail-closed.
 */
export function selfLogin(probeResult) {
  return str(probeResult?.self?.login)
}

/** True only when tailscale is usable as a serve entry (F-DETECT five states). */
export function probeReady(probeResult) {
  return probeResult?.installed === true
    && probeResult?.running === true
    && probeResult?.backendState === 'Running'
    && probeResult?.error === undefined
}

/**
 * `tailscale serve status`, preferring `--json` (newer builds) and falling back
 * to the text output (older builds). Never throws; a failed status comes back
 * as `error` with the usual `code` / `hint` / `command`.
 *
 * @returns {Promise<{ raw: string, entries: object[], parse: 'json'|'text', error?: object }>}
 */
export async function serveStatus(options = {}) {
  const { bin, signal, run = defaultRun, timeout } = options
  const executable = resolveBin(bin)
  if (executable === undefined) {
    return { raw: '', entries: [], parse: 'text', error: notInstalledInfo('`tailscale` was not found on PATH.') }
  }
  const callOptions = runOptions(signal, timeout)
  const jsonResult = await callRun(run, executable, ['serve', 'status', '--json'], callOptions)
  const jsonText = (jsonResult.stdout ?? '').trim()
  if (jsonText.length > 0) {
    try {
      return { raw: jsonText, entries: parseServeStatusJson(jsonText), parse: 'json' }
    } catch {}
  }
  const textResult = await callRun(run, executable, ['serve', 'status'], callOptions)
  const stdout = (textResult.stdout ?? '').trim()
  const stderr = (textResult.stderr ?? '').trim()
  if (!failed(textResult) || stdout.length > 0) {
    return { raw: stdout.length > 0 ? stdout : stderr, entries: parseServeStatusText(stdout), parse: 'text' }
  }
  const info = classifyServeFailure(stderr.length > 0 ? stderr : (jsonResult.stderr ?? ''), 'status', {
    bin: executable,
    code: textResult.code ?? jsonResult.code,
  })
  return { raw: stderr, entries: [], parse: 'text', error: info }
}

/**
 * `tailscale serve --bg --https=443 http://127.0.0.1:<port>`.
 *
 * HTTPS on 443 is the only path this plugin publishes: a plaintext entry would
 * be a non-secure browser context, where client plugins calling
 * `crypto.randomUUID()` break. A tailnet without HTTPS certificates must fail
 * loudly (see `classifyServeFailure`) instead of degrading to a plaintext listener.
 *
 * @param port - the loopback front-door port (number or numeric string).
 * @returns the argv array, or undefined when the port is not a valid port.
 */
export function serveEnableArgs(port) {
  const localPort = normalizePort(port)
  if (localPort === undefined) return undefined
  return ['serve', '--bg', `--https=${String(SERVE_TLS_PORT)}`, `http://127.0.0.1:${String(localPort)}`]
}

/**
 * Publish the local front door through `tailscale serve --bg --https=443`.
 *
 * HTTPS is the only mode: there is no plaintext fallback, so a tailnet without
 * certificates throws `TAILSCALE_HTTPS_CERTS_DISABLED` with a repair hint.
 *
 * Throws an Error with `code` / `hint` / `command` on failure (F-MODE-2, F-ERR).
 *
 * @returns {Promise<{ url: string }>}
 */
export async function serveEnable(options = {}) {
  const { bin, port, log = noop, run = defaultRun, signal, timeout } = options
  const localPort = normalizePort(port)
  const executable = resolveBin(bin)
  if (localPort === undefined) {
    throw failure(errorInfo(
      CODES.SERVE_FAILED,
      `serveEnable: invalid local port ${JSON.stringify(port)}`,
      '本地代理端口无效（需要 1-65535 的整数）。',
      `${binPrefix(executable)} serve status`,
    ))
  }
  if (executable === undefined) throw failure(notInstalledInfo())
  const args = serveEnableArgs(localPort)
  const callOptions = runOptions(signal, timeout)
  log('info', `remote-access: tailscale ${args.join(' ')}`)
  const result = await callRun(run, executable, args, callOptions)
  if (failed(result)) {
    throw failure(classifyServeFailure(`${result.stderr}\n${result.stdout}`, 'enable', {
      bin: executable,
      port: localPort,
      code: result.code,
    }))
  }
  const url = await resolveServeUrl({
    run,
    bin: executable,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    callOptions,
    log,
  })
  log('info', `remote-access: tailscale serve ready at ${url}`)
  return { url }
}

const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i

/** Prefer the printed tailnet URL; fall back to `Self.DNSName` from status. */
async function resolveServeUrl({ run, bin, output, callOptions, log }) {
  const candidates = String(output ?? '').match(/https?:\/\/[^\s"'<>]+/gi) ?? []
  const remote = candidates.find((candidate) => !LOOPBACK_URL.test(candidate))
  if (remote !== undefined) return remote.replace(/\/+$/, '').replace(/[.,;:]+$/, '')
  const status = await callRun(run, bin, ['status', '--json'], callOptions)
  const parsed = parseStatusJson(status.stdout)
  const dnsName = parsed.ok ? stripTrailingDot(parsed.value.Self?.DNSName) : undefined
  if (dnsName !== undefined) return `https://${dnsName}`
  log('warn', 'remote-access: tailscale serve started but the entry URL could not be resolved')
  throw failure(errorInfo(
    CODES.SERVE_URL_UNKNOWN,
    'tailscale serve succeeded but no hostname (Self.DNSName) could be resolved.',
    'serve 已启用，但读不到机器名（Self.DNSName），无法生成入口地址：运行 tailscale serve status 查看。',
    `${binPrefix(bin)} serve status`,
  ))
}

/**
 * F-LIFE-4: remove every serve rule. Idempotent — a stopped daemon or "no
 * config" is a warning, not an error; a real failure still throws.
 */
export async function serveReset(options = {}) {
  const { bin, log = noop, run = defaultRun, signal, timeout } = options
  const executable = resolveBin(bin)
  if (executable === undefined) {
    log('warn', 'remote-access: tailscale not found; nothing to reset')
    return
  }
  const result = await callRun(run, executable, ['serve', 'reset'], runOptions(signal, timeout))
  if (!failed(result)) {
    log('info', 'remote-access: tailscale serve rules cleared')
    return
  }
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
  if (isDaemonUnreachable(text) || /no serve config|not configured|nothing to (?:reset|do)/i.test(text)) {
    log('warn', `remote-access: tailscale serve reset skipped (${firstLine(text) ?? 'daemon unreachable'})`)
    return
  }
  throw failure(classifyServeFailure(text, 'reset', { bin: executable, code: result.code }))
}

export default {
  CODES,
  findTailscale,
  probe,
  probeReady,
  selfLogin,
  serveStatus,
  serveEnable,
  serveEnableArgs,
  serveReset,
  parseStatusJson,
  parseServeStatusJson,
  parseServeStatusText,
  stripTrailingDot,
  defaultRun,
}
