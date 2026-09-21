/**
 * dsh-tailscale-access — front door (lib/proxy.js).
 *
 * A small reverse proxy that makes a remote browser look like a loopback client
 * of the DSH harness:
 *
 *   - `Host` is rewritten to `127.0.0.1:<upstreamPort>` and `Origin` / `Referer`
 *     / `Sec-Fetch-Site` are dropped, so the harness's own loopback trust fence
 *     passes without `--trusted-host` (F-PROXY-1).
 *   - `Cookie` is replaced with a harness cookie minted server side by
 *     `resolveUpstreamCookie()`; a 401 from upstream forces exactly one re-mint
 *     and one retry (F-PROXY-2).
 *   - HTTP and WebSocket upgrades both work; upgrades go over a raw TCP pipe
 *     with the same header rewrite (F-PROXY-3).
 *   - Responses drop `Set-Cookie` and all hop-by-hop headers (F-PROXY-5).
 *   - Client addresses only trust `CF-Connecting-IP` / `X-Forwarded-For` when
 *     `trustProxyHeaders` is set *and* the peer is loopback (F-PROXY-6).
 *   - Session / failure / client tables are bounded, and `close()` destroys
 *     every socket including upgraded WebSockets (F-PROXY-7).
 *
 * Authentication modes (F-AUTH-1/2/3/4/6, F-SEC-4):
 *   - `tailscale`: `Tailscale-User-Login` is the only credential; the header is
 *     trusted only from loopback with `trustProxyHeaders` and the login must be
 *     in `allowedUsers` (an empty list denies everyone). Local session cookies
 *     are never accepted as identity here.
 *   - `none` / `quick`: password login page (`LOGIN_PATH`) plus an HMAC-signed
 *     local session cookie. With no password configured, `none` is treated as a
 *     loopback-only debug door (first request mints a session); `quick` refuses
 *     to `listen()` without a password.
 *
 * Nothing in this file logs a token, cookie or password.
 */

import http from 'node:http'
import net from 'node:net'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const LOGIN_PATH = '/__remote-access/login'
export const HEALTH_PATH = '/__remote-access/health'
export const SESSION_COOKIE = 'dsh-remote-session'

/** Headers that describe a single TCP hop and must never be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Request headers that describe the *public* origin, the harness cookie, or a
 * client-controlled claim about the network path. All of them are either
 * dropped or replaced with a value this proxy derived itself.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-site',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'true-client-ip',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
])

const IDENTITY_HEADER_PREFIX = 'tailscale-user-'
const MAX_LOGIN_BODY = 4 * 1024
const MAX_REPLAY_BYTES = 1 * 1024 * 1024
const MAX_HEAD_BYTES = 64 * 1024
const MAX_CLIENTS = 200
const MAX_SESSIONS = 500
const MAX_FAILURES = 1024
const MAX_AUTH_EVENTS = 512
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000
const STATUS_REASONS = new Map([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [413, 'Payload Too Large'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
])

/** Stand-in for the front door's own splash while the harness owns the real UI. */
const loginPage = ({ failed = false, blocked = false } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>DeepSeek Harness — remote access</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; height:100vh; display:grid; place-items:center; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#0b0d10; color:#e8eaed }
  form { width:min(92vw,360px); padding:28px; border-radius:14px; background:#15181d; border:1px solid #262b33 }
  h1 { margin:0 0 4px; font-size:17px }
  p.sub { margin:0 0 18px; color:#9aa0a6; font-size:13px }
  input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:9px; border:1px solid #333941;
          background:#0e1116; color:inherit; font-size:15px }
  button { margin-top:12px; width:100%; padding:11px; border-radius:9px; border:0; background:#4c8dff;
           color:#fff; font-size:15px; font-weight:600; cursor:pointer }
  .err { margin:0 0 14px; color:#ff8a80; font-size:13px }
</style></head>
<body><form method="post" action="${LOGIN_PATH}">
  <h1>DeepSeek Harness</h1>
  <p class="sub">Remote access is password protected.</p>
  ${blocked ? '<p class="err">Too many attempts. Try again later.</p>' : failed ? '<p class="err">Wrong password.</p>' : ''}
  <input type="password" name="password" autofocus autocomplete="current-password" placeholder="Password" required>
  <button type="submit">Unlock</button>
</form></body></html>
`

/** Constant-time password comparison (v2 hook; v1 never configures a password). */
export function passwordMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  const a = createHash('sha256').update(supplied, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** `::ffff:1.2.3.4` / `[::1]:1234` / `1.2.3.4` -> bare address. */
function normalizeAddress(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text.length === 0) return ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end > 0) text = text.slice(1, end)
  }
  const zone = text.indexOf('%')
  if (zone > 0) text = text.slice(0, zone)
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(text)) text = text.slice(7)
  return text
}

/** Loopback in either family, including the IPv4-mapped form. */
function isLoopback(value) {
  const ip = normalizeAddress(value)
  if (ip === '::1') return true
  if (!ip.startsWith('127.')) return false
  const parts = ip.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Case-insensitive header read; Node lowercases, test doubles may not. */
function headerValue(headers, name) {
  if (headers === null || headers === undefined) return undefined
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const value = headers[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  }
  return undefined
}

/** Keep client-supplied identity strings bounded and control-character free. */
function sanitizeIdentity(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (text.length === 0) return undefined
  return text.length > 254 ? text.slice(0, 254) : text
}

function ipv6ToBigInt(value) {
  const text = normalizeAddress(value)
  if (net.isIP(text) !== 6) return undefined
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part) => {
    if (part.length === 0) return []
    const groups = []
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const octets = group.split('.').map(Number)
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
      groups.push(Number.parseInt(group, 16))
    }
    return groups
  }
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if (head === undefined || tail === undefined) return undefined
  const groups = halves.length === 2
    ? [...head, ...new Array(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
    : head
  if (groups.length !== 8) return undefined
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n)
}

/** Compile `10.0.0.1`, `10.0.0.0/8`, `fd7a::/16` or a bare literal into a matcher. */
function cidrMatcher(entry) {
  const text = String(entry ?? '').trim()
  if (text.length === 0) return undefined
  const slash = text.indexOf('/')
  const address = (slash === -1 ? text : text.slice(0, slash)).trim()
  const bitsText = slash === -1 ? undefined : text.slice(slash + 1).trim()
  const family = net.isIP(address)
  if (family === 4) {
    const octets = address.split('.')
    const value = octets.reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
    const bits = bitsText === undefined ? 32 : Number(bitsText)
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (ip) => {
      const candidate = normalizeAddress(ip)
      if (net.isIP(candidate) !== 4) return false
      const parts = candidate.split('.')
      const numeric = parts.reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
      return (numeric & mask) === (value & mask)
    }
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address)
    if (value === undefined) return undefined
    const bits = bitsText === undefined ? 128 : Number(bitsText)
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return undefined
    const mask = bits === 0 ? 0n : (((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n))
    return (ip) => {
      const candidate = ipv6ToBigInt(ip)
      return candidate !== undefined && (candidate & mask) === (value & mask)
    }
  }
  return undefined
}

/**
 * Effective client address.
 *
 * `CF-Connecting-IP` / `X-Forwarded-For` are only honoured when the caller says
 * the tunnel owns this hop (`trustProxy: true`) *and* the peer really is
 * loopback, so a LAN client cannot forge its way around `allowedCidrs`
 * (F-PROXY-6 / F-SEC-4).
 */
export function clientAddress(headers, socket, options = {}) {
  const source = normalizeAddress(socket?.remoteAddress)
  if (options?.trustProxy === true && isLoopback(source)) {
    const cf = sanitizeIdentity(headerValue(headers, 'cf-connecting-ip'))
    if (cf !== undefined && net.isIP(cf) !== 0) return cf
    const forwarded = headerValue(headers, 'x-forwarded-for')
    if (typeof forwarded === 'string') {
      for (const part of forwarded.split(',')) {
        const candidate = normalizeAddress(part)
        // A loopback claim on a forwarded hop is meaningless (we are the loopback peer).
        if (candidate.length === 0 || isLoopback(candidate) || net.isIP(candidate) === 0) continue
        return candidate
      }
    }
  }
  return source
}

/** Start the front door; every option is documented on the options type below. */
export function createFrontDoor(options = {}) {
  const settings = options ?? {}
  const mode = settings.mode ?? 'tailscale'
  if (mode !== 'none' && mode !== 'tailscale' && mode !== 'quick') {
    throw Object.assign(new Error(`unknown remote access mode: ${String(mode)}`), { code: 'FRONTDOOR_BAD_MODE' })
  }

  // The bind address is the caller's decision (F-PROXY-4); never invent 0.0.0.0.
  const host = typeof settings.host === 'string' && settings.host.length > 0 ? settings.host : '127.0.0.1'
  const port = Number.isInteger(settings.port) && settings.port >= 0 && settings.port <= 65535 ? settings.port : 0
  const upstreamHost = typeof settings.upstreamHost === 'string' && settings.upstreamHost.length > 0
    ? settings.upstreamHost
    : '127.0.0.1'
  const upstreamPort = Number(settings.upstreamPort)
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    throw Object.assign(new Error('upstreamPort must be a loopback TCP port'), { code: 'FRONTDOOR_BAD_UPSTREAM' })
  }
  const resolveUpstreamCookie = settings.resolveUpstreamCookie
  if (typeof resolveUpstreamCookie !== 'function') {
    throw Object.assign(new Error('resolveUpstreamCookie must be a function'), { code: 'FRONTDOOR_BAD_OPTIONS' })
  }

  const password = typeof settings.password === 'string' && settings.password.length > 0 ? settings.password : undefined
  const hasPassword = password !== undefined
  const allowedUsers = Array.isArray(settings.allowedUsers) ? settings.allowedUsers.map((entry) => String(entry)) : []
  const allowedCidrs = Array.isArray(settings.allowedCidrs) ? settings.allowedCidrs : []
  const trustProxyHeaders = settings.trustProxyHeaders === true
  const sessionHours = Number.isFinite(Number(settings.sessionHours)) && Number(settings.sessionHours) > 0
    ? Number(settings.sessionHours)
    : 72
  const sessionTtlMs = sessionHours * 60 * 60 * 1000
  const log = typeof settings.log === 'function' ? settings.log : () => {}
  const onEvent = typeof settings.onEvent === 'function' ? settings.onEvent : undefined
  // Testability knobs; defaults reproduce wall-clock behaviour.
  const now = typeof settings.now === 'function' ? settings.now : Date.now
  const cookieTtlMs = Number.isFinite(Number(settings.cookieTtlMs)) && Number(settings.cookieTtlMs) >= 0
    ? Number(settings.cookieTtlMs)
    : 5 * 60 * 1000
  const maxReplayBytes = Number.isFinite(Number(settings.maxReplayBytes)) && Number(settings.maxReplayBytes) > 0
    ? Number(settings.maxReplayBytes)
    : MAX_REPLAY_BYTES
  const maxClients = Number.isInteger(settings.maxClients) && settings.maxClients > 0 ? settings.maxClients : MAX_CLIENTS
  const clientTtlMs = Number.isFinite(Number(settings.clientTtlMs)) && Number(settings.clientTtlMs) > 0
    ? Number(settings.clientTtlMs)
    : CLIENT_TTL_MS
  const failureLimit = Number.isInteger(settings.failureLimit) && settings.failureLimit > 0 ? settings.failureLimit : 8
  const failureWindowMs = Number.isFinite(Number(settings.failureWindowMs)) && Number(settings.failureWindowMs) > 0
    ? Number(settings.failureWindowMs)
    : 5 * 60 * 1000
  const blockMs = Number.isFinite(Number(settings.blockMs)) && Number(settings.blockMs) > 0
    ? Number(settings.blockMs)
    : 15 * 60 * 1000

  const cidrAllow = allowedCidrs.map(cidrMatcher).filter((matcher) => matcher !== undefined)
  const secret = randomBytes(32)

  /** id -> client record (internal fields included; `status()` projects the public shape). */
  const clients = new Map()
  /** sid -> { iat, lastSeen, ip, identity } */
  const sessions = new Map()
  /** ip -> { count, firstAt, blockedUntil } */
  const failures = new Map()
  /** Every socket this server owns, including upgraded WebSockets and upstream sockets. */
  const allSockets = new Set()
  /** client id -> Set<socket> for `kick()`. */
  const clientSockets = new Map()
  const socketTracked = new WeakMap()
  /** client ids that already produced an `auth-ok` audit event. */
  const authOkIds = new Set()

  let denied = 0
  let closed = false
  let closing = false
  let cachedCookie
  let cachedCookieAt = 0
  let inflightCookie

  const safeLog = (level, message) => {
    try {
      log(level, message)
    } catch {
      /* logging must never break a request */
    }
  }

  const emit = (event) => {
    if (onEvent === undefined) return
    // Keep the documented shape: optional fields appear only when they exist.
    const payload = { type: event.type, at: now() }
    if (event.identity !== undefined) payload.identity = event.identity
    if (event.ip !== undefined) payload.ip = event.ip
    try {
      onEvent(payload)
    } catch {
      /* audit must never break a request */
    }
  }

  const describe = (error) => {
    if (error === null || error === undefined) return 'unknown error'
    const text = typeof error === 'string' ? error : `${typeof error.code === 'string' ? `${error.code}: ` : ''}${error.message ?? String(error)}`
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }

  // ---------------------------------------------------------------- utilities

  const currentPort = () => {
    const address = server.address()
    return address !== null && typeof address === 'object' ? address.port : port
  }

  const pathOf = (url) => {
    const text = typeof url === 'string' && url.length > 0 ? url : '/'
    const query = text.indexOf('?')
    const path = query === -1 ? text : text.slice(0, query)
    return path.length === 0 ? '/' : path
  }

  const secureRequest = (req) => headerValue(req.headers, 'x-forwarded-proto') === 'https'

  const cookiesOf = (headers) => {
    const jar = new Map()
    const raw = headerValue(headers, 'cookie')
    if (typeof raw !== 'string') return jar
    for (const segment of raw.split(';')) {
      const eq = segment.indexOf('=')
      if (eq <= 0) continue
      const name = segment.slice(0, eq).trim()
      if (name.length === 0) continue
      jar.set(name, segment.slice(eq + 1).trim())
    }
    return jar
  }

  // ------------------------------------------------------------ session table

  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url')

  const enforceSessionCap = () => {
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }

  const issueSession = (ip) => {
    const iat = now()
    const sid = randomBytes(18).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sid, iat }), 'utf8').toString('base64url')
    sessions.set(sid, { iat, lastSeen: iat, ip })
    enforceSessionCap()
    return `${payload}.${sign(payload)}`
  }

  const sessionValid = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return undefined
    const at = value.lastIndexOf('.')
    if (at <= 0) return undefined
    const payload = value.slice(0, at)
    const given = value.slice(at + 1)
    const expected = sign(payload)
    if (given.length !== expected.length) return undefined
    if (timingSafeEqual(Buffer.from(given), Buffer.from(expected)) !== true) return undefined
    let decoded
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    if (typeof decoded?.sid !== 'string' || typeof decoded?.iat !== 'number') return undefined
    const record = sessions.get(decoded.sid)
    if (record === undefined) return undefined
    if (now() - record.iat > sessionTtlMs) {
      sessions.delete(decoded.sid)
      return undefined
    }
    record.lastSeen = now()
    // Refresh insertion order so the cap behaves as an LRU.
    sessions.delete(decoded.sid)
    sessions.set(decoded.sid, record)
    return record
  }

  const sessionCookie = (value, secure) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(sessionTtlMs / 1000))}${secure === true ? '; Secure' : ''}`

  const readSession = (headers) => sessionValid(cookiesOf(headers).get(SESSION_COOKIE))

  // ------------------------------------------------------------- client table

  const trackSocket = (socket, id) => {
    if (!allSockets.has(socket)) {
      allSockets.add(socket)
      socket.once('close', () => allSockets.delete(socket))
    }
    if (id === undefined || id === null) return
    let ids = socketTracked.get(socket)
    if (ids === undefined) {
      ids = new Set()
      socketTracked.set(socket, ids)
      socket.once('close', () => {
        const tracked = socketTracked.get(socket)
        socketTracked.delete(socket)
        if (tracked === undefined) return
        for (const key of tracked) {
          const set = clientSockets.get(key)
          if (set === undefined) continue
          set.delete(socket)
          if (set.size === 0) clientSockets.delete(key)
        }
      })
    }
    if (ids.has(id)) return
    ids.add(id)
    let set = clientSockets.get(id)
    if (set === undefined) {
      set = new Set()
      clientSockets.set(id, set)
    }
    set.add(socket)
  }

  const evictClients = () => {
    if (clients.size <= maxClients) return
    const ordered = [...clients.values()].sort((a, b) => (Number(a.active) - Number(b.active)) || (a.lastSeen - b.lastSeen))
    for (const entry of ordered) {
      if (clients.size <= maxClients) break
      if (entry.inflight > 0 || entry.websockets > 0) continue
      clients.delete(entry.id)
    }
  }

  const clientEntry = (info) => {
    const at = now()
    const existing = clients.get(info.id)
    if (existing !== undefined) {
      existing.lastSeen = at
      if (info.ip) existing.ip = info.ip
      if (info.name !== undefined) existing.name = info.name
      if (info.userAgent !== undefined) existing.userAgent = info.userAgent
      return existing
    }
    const entry = {
      id: info.id,
      kind: info.kind,
      identity: info.identity,
      name: info.name,
      ip: info.ip,
      since: at,
      lastSeen: at,
      requests: 0,
      websockets: 0,
      active: false,
      inflight: 0,
      userAgent: info.userAgent,
    }
    clients.set(entry.id, entry)
    evictClients()
    return entry
  }

  const noteAuthOk = (info) => {
    if (authOkIds.has(info.id)) return
    authOkIds.add(info.id)
    while (authOkIds.size > MAX_AUTH_EVENTS) {
      const oldest = authOkIds.values().next().value
      if (oldest === undefined) break
      authOkIds.delete(oldest)
    }
    emit({ type: 'auth-ok', identity: info.identity, ip: info.ip })
  }

  // ------------------------------------------------------------ failure table

  const isBlocked = (ip) => {
    const entry = failures.get(ip)
    return entry !== undefined && entry.blockedUntil > now()
  }

  const noteFailure = (ip) => {
    const at = now()
    let entry = failures.get(ip)
    if (entry === undefined) {
      while (failures.size >= MAX_FAILURES) {
        const oldest = failures.keys().next().value
        if (oldest === undefined) break
        failures.delete(oldest)
      }
      entry = { count: 0, firstAt: at, blockedUntil: 0 }
      failures.set(ip, entry)
    } else if (at - entry.firstAt > failureWindowMs) {
      entry.count = 0
      entry.firstAt = at
      entry.blockedUntil = 0
    }
    entry.count += 1
    if (entry.count >= failureLimit) entry.blockedUntil = at + blockMs
    return entry
  }

  const cleanup = () => {
    const at = now()
    for (const [id, entry] of [...clients]) {
      if (entry.inflight > 0 || entry.websockets > 0) continue
      if (at - entry.lastSeen > clientTtlMs) clients.delete(id)
    }
    evictClients()
    for (const [sid, record] of [...sessions]) {
      if (at - record.iat > sessionTtlMs) sessions.delete(sid)
    }
    for (const [ip, entry] of [...failures]) {
      if (entry.blockedUntil > at) continue
      if (at - entry.firstAt > failureWindowMs) failures.delete(ip)
    }
  }

  // ------------------------------------------------------------ identity gate

  /** Identity headers are only believable from a loopback peer on a tunnelled hop (F-SEC-4). */
  const peerIdentity = (req) => {
    if (trustProxyHeaders !== true) return { trusted: undefined, untrusted: rawIdentity(req.headers) }
    if (!isLoopback(req.socket?.remoteAddress)) return { trusted: undefined, untrusted: rawIdentity(req.headers) }
    return { trusted: rawIdentity(req.headers), untrusted: undefined }
  }

  function rawIdentity(headers) {
    const login = sanitizeIdentity(headerValue(headers, 'tailscale-user-login'))
    if (login === undefined) return undefined
    return { login, name: sanitizeIdentity(headerValue(headers, 'tailscale-user-name')) }
  }

  const userAllowed = (login) => {
    const lower = login.toLowerCase()
    const at = lower.indexOf('@')
    const local = at === -1 ? lower : lower.slice(0, at)
    for (const entry of allowedUsers) {
      const candidate = entry.trim().toLowerCase()
      if (candidate.length === 0) continue
      if (candidate === lower || candidate === local) return true
    }
    return false
  }

  const cidrAllowed = (ip) => cidrAllow.length === 0 || cidrAllow.some((matcher) => matcher(ip))

  // -------------------------------------------------------------- upstream hop

  const validateCookie = (value) => {
    const bad = () => Object.assign(new Error('resolveUpstreamCookie returned an unusable value'), { code: 'FRONTDOOR_COOKIE_INVALID' })
    if (typeof value !== 'string') throw bad()
    const text = value.trim()
    if (text.length === 0 || text.length > 8192) throw bad()
    if (/[\r\n\u0000]/.test(text)) throw bad()
    const eq = text.indexOf('=')
    if (eq <= 0) throw bad()
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(text.slice(0, eq).trim())) throw bad()
    return text
  }

  const upstreamCookie = async (force) => {
    const at = now()
    if (force !== true && typeof cachedCookie === 'string' && at - cachedCookieAt < cookieTtlMs) return cachedCookie
    if (force !== true && inflightCookie !== undefined) return inflightCookie
    const pending = (async () => {
      const value = validateCookie(await resolveUpstreamCookie(force === true))
      cachedCookie = value
      cachedCookieAt = now()
      return value
    })()
    inflightCookie = pending
    try {
      return await pending
    } finally {
      if (inflightCookie === pending) inflightCookie = undefined
    }
  }

  /**
   * Rewrite browser headers into loopback headers. `identity` carries only an
   * identity this proxy already vouched for; an unvouched `Tailscale-User-*`
   * header is always dropped.
   */
  const upstreamHeaders = (headers, cookie, clientIp, secure, identity) => {
    const out = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower.startsWith('proxy-')) continue
      if (lower.startsWith(IDENTITY_HEADER_PREFIX)) continue
      if (DROPPED_REQUEST_HEADERS.has(lower)) continue
      out[lower] = value
    }
    out.host = `${upstreamHost}:${upstreamPort}`
    out.cookie = cookie
    if (clientIp.length > 0) out['x-forwarded-for'] = clientIp
    // Only claim https when this deployment actually owns the TLS hop.
    out['x-forwarded-proto'] = secure === true && trustProxyHeaders === true ? 'https' : 'http'
    if (identity !== undefined) {
      out['tailscale-user-login'] = identity.login
      if (identity.name !== undefined) out['tailscale-user-name'] = identity.name
    }
    return out
  }

  const filterResponseHeaders = (headers) => {
    const tokens = new Set(
      String(headers.connection ?? '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length > 0),
    )
    const out = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'set-cookie') continue
      if (HOP_BY_HOP.has(lower)) continue
      if (lower.startsWith('proxy-')) continue
      if (tokens.has(lower)) continue
      out[lower] = value
    }
    return out
  }

  const readRequestBody = (req, limit) => new Promise((resolve, reject) => {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      resolve({ chunks: [], stream: false })
      return
    }
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('close', onClose)
    }
    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onData(chunk) {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // Too large to replay: hand the rest of the stream to the upstream as-is.
        req.pause()
        settle({ chunks, stream: true })
        return
      }
      chunks.push(chunk)
    }
    function onEnd() {
      settle({ chunks, stream: false })
    }
    function onError(error) {
      fail(error)
    }
    function onClose() {
      if (req.complete === true) return
      fail(Object.assign(new Error('client aborted the request'), { code: 'CLIENT_ABORTED' }))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('close', onClose)
  })

  const readText = (req, limit) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.pause()
        reject(Object.assign(new Error('login body too large'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => {
      req.off('data', onData)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })

  const writeBody = (upstreamReq, body) => {
    if (body.stream === true) {
      for (const chunk of body.chunks) upstreamReq.write(chunk)
      body.source.pipe(upstreamReq)
      return
    }
    if (body.chunks.length === 0) {
      upstreamReq.end()
      return
    }
    upstreamReq.end(Buffer.concat(body.chunks))
  }

  const requestUpstream = (req, headers, body) => new Promise((resolve, reject) => {
    const upstreamReq = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => resolve({ upstreamReq, upstreamRes }))
    upstreamReq.on('error', reject)
    writeBody(upstreamReq, body)
  })

  const relayResponse = (upstreamRes, res, method) => {
    if (res.writableEnded === true || res.destroyed === true) {
      upstreamRes.resume()
      return
    }
    const status = upstreamRes.statusCode ?? 502
    res.writeHead(status, undefined, filterResponseHeaders(upstreamRes.headers))
    if (method === 'HEAD' || status === 204 || status === 304) {
      upstreamRes.resume()
      res.end()
      return
    }
    upstreamRes.on('error', () => {
      try {
        res.destroy()
      } catch {
        /* socket already gone */
      }
    })
    upstreamRes.pipe(res)
  }

  // --------------------------------------------------------------- responders

  const sendText = (res, status, text) => {
    if (res.headersSent === true || res.writableEnded === true) {
      res.destroy()
      return
    }
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    })
    res.end(text)
  }

  const sendLogin = (res, { failed = false, blocked = false, status = 200, secure = false } = {}) => {
    if (res.headersSent === true || res.writableEnded === true) {
      res.destroy()
      return
    }
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    }
    res.writeHead(status, headers)
    res.end(loginPage({ failed, blocked }))
  }

  const sendHealth = (res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('ok\n')
  }

  const refuseUpgrade = (socket, status, extra = '') => {
    const reason = STATUS_REASONS.get(status) ?? 'Error'
    try {
      socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: ${String(Buffer.byteLength(extra))}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n\r\n${extra}`)
    } catch {
      /* socket already gone */
    }
    socket.destroy()
  }

  // ------------------------------------------------------------- HTTP handler

  const proxyHttp = async (req, res, info, issued) => {
    const entry = clientEntry(info)
    entry.requests += 1
    entry.inflight += 1
    entry.active = true
    trackSocket(req.socket, entry.id)
    res.once('close', () => {
      entry.inflight = Math.max(0, entry.inflight - 1)
      entry.active = entry.inflight > 0 || entry.websockets > 0
      entry.lastSeen = now()
    })
    let body
    try {
      body = await readRequestBody(req, maxReplayBytes)
      const cookie = await upstreamCookie(false)
      let attempt = await requestUpstream(req, upstreamHeaders(req.headers, cookie, info.ip, secureRequest(req), info.trustedIdentity), body)
      if (attempt.upstreamRes.statusCode === 401 && body.stream !== true) {
        attempt.upstreamRes.on('error', () => {
          /* drained and discarded; a broken upstream socket is handled by the retry */
        })
        attempt.upstreamRes.resume()
        safeLog('debug', 'remote-access: upstream rejected the harness cookie; re-minting once')
        const fresh = await upstreamCookie(true)
        attempt = await requestUpstream(req, upstreamHeaders(req.headers, fresh, info.ip, secureRequest(req), info.trustedIdentity), body)
      }
      if (issued !== undefined && res.headersSent !== true && res.destroyed !== true) {
        res.setHeader('set-cookie', sessionCookie(issued, secureRequest(req)))
      }
      relayResponse(attempt.upstreamRes, res, req.method)
    } catch (error) {
      if (error?.code === 'CLIENT_ABORTED') {
        res.destroy()
        return
      }
      safeLog('error', `remote-access: proxy failed: ${describe(error)}`)
      if (res.headersSent !== true) sendText(res, 502, 'remote access: upstream unavailable\n')
      else res.destroy()
    }
  }

  const handleLogin = async (req, res, ip) => {
    const secure = secureRequest(req)
    if (hasPassword !== true) {
      res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end()
      return
    }
    if (req.method !== 'POST') {
      sendLogin(res, { status: 200, secure })
      return
    }
    if (isBlocked(ip) === true) {
      denied += 1
      emit({ type: 'denied', ip })
      safeLog('warn', `remote-access: throttled login from ${ip}`)
      sendLogin(res, { status: 429, blocked: true, secure })
      return
    }
    let form
    try {
      form = new URLSearchParams(await readText(req, MAX_LOGIN_BODY))
    } catch (error) {
      denied += 1
      emit({ type: 'denied', ip })
      res.setHeader('connection', 'close')
      sendText(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, 'remote access: bad login request\n')
      return
    }
    if (passwordMatches(form.get('password') ?? '', password) !== true) {
      noteFailure(ip)
      denied += 1
      emit({ type: 'auth-fail', ip })
      safeLog('warn', `remote-access: failed login from ${ip}`)
      sendLogin(res, { status: 401, failed: true, secure })
      return
    }
    failures.delete(ip)
    const value = issueSession(ip)
    noteAuthOk({ id: ip, ip, identity: undefined })
    safeLog('info', `remote-access: session issued for ${ip}`)
    res.writeHead(303, {
      location: '/',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(value, secure),
    })
    res.end()
  }

  const handleHttp = async (req, res) => {
    if (closing === true) {
      sendText(res, 503, 'remote access: shutting down\n')
      return
    }
    const path = pathOf(req.url)
    // Liveness never needs a credential, so the tunnel supervisor can always probe.
    if (path === HEALTH_PATH) {
      sendHealth(res)
      return
    }

    const ip = clientAddress(req.headers, req.socket, { trustProxy: trustProxyHeaders })
    const userAgent = sanitizeIdentity(headerValue(req.headers, 'user-agent'))
    const { trusted, untrusted } = peerIdentity(req)
    if (untrusted !== undefined) {
      // A forged / untrusted identity claim is worth an audit line even when the
      // request is rejected for another reason.
      emit({ type: 'denied', ip, identity: untrusted.login })
      safeLog('warn', `remote-access: ignoring untrusted identity header from ${ip}`)
    }

    if (mode === 'tailscale') {
      if (trusted === undefined) {
        denied += 1
        emit({ type: 'auth-fail', ip })
        safeLog('warn', `remote-access: no tailscale identity from ${ip}`)
        sendText(res, 403, 'remote access: tailscale identity required (funnel and tagged nodes send no identity header)\n')
        return
      }
      if (userAllowed(trusted.login) !== true) {
        denied += 1
        emit({ type: 'auth-fail', ip, identity: trusted.login })
        safeLog('warn', `remote-access: identity not allowed from ${ip}`)
        sendText(res, 403, 'remote access: this tailscale identity is not allowed\n')
        return
      }
      const info = { id: trusted.login, kind: 'identity', identity: trusted.login, name: trusted.name, ip, userAgent, trustedIdentity: trusted }
      noteAuthOk(info)
      await proxyHttp(req, res, info, undefined)
      return
    }

    if (cidrAllowed(ip) !== true) {
      denied += 1
      emit({ type: 'denied', ip })
      safeLog('warn', `remote-access: rejected ${ip} (not in allowedCidrs)`)
      sendText(res, 403, 'remote access: this client address is not allowed\n')
      return
    }

    if (path === LOGIN_PATH) {
      await handleLogin(req, res, ip)
      return
    }

    if (isBlocked(ip) === true) {
      denied += 1
      emit({ type: 'denied', ip })
      sendLogin(res, { status: 429, blocked: true, secure: secureRequest(req) })
      return
    }

    let session = readSession(req.headers)
    let issued
    if (hasPassword === true) {
      if (session === undefined) {
        noteFailure(ip)
        denied += 1
        emit({ type: 'denied', ip })
        safeLog('warn', `remote-access: unauthenticated request from ${ip}`)
        sendLogin(res, { status: 401, secure: secureRequest(req) })
        return
      }
    } else if (session === undefined) {
      // `none` with no password is the loopback debug door: mint a session now
      // so the very first request already works (F-AUTH-3, v1 semantics).
      issued = issueSession(ip)
    }
    const info = { id: ip, kind: 'ip', identity: undefined, name: undefined, ip, userAgent, trustedIdentity: undefined }
    noteAuthOk(info)
    await proxyHttp(req, res, info, issued)
  }

  // ---------------------------------------------------------- upgrade handler

  const connectUpstream = () => new Promise((resolve, reject) => {
    const upstream = net.connect(upstreamPort, upstreamHost)
    upstream.once('connect', () => {
      upstream.off('error', reject)
      resolve(upstream)
    })
    upstream.once('error', reject)
  })

  const readUpgradeHead = (upstream) => new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      upstream.off('data', onData)
      upstream.off('error', onError)
      upstream.off('close', onClose)
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > MAX_HEAD_BYTES) {
          cleanup()
          reject(new Error('upstream upgrade response header too large'))
        }
        return
      }
      cleanup()
      resolve({ head: buffer.subarray(0, end + 4), rest: buffer.subarray(end + 4) })
    }
    function onError(error) {
      cleanup()
      reject(error)
    }
    function onClose() {
      cleanup()
      reject(new Error('upstream closed before answering the upgrade'))
    }
    upstream.on('data', onData)
    upstream.on('error', onError)
    upstream.on('close', onClose)
  })

  /** Rebuild a raw response head: drop `Set-Cookie`, hop-by-hop headers and Connection tokens. */
  const rewriteRawHead = (head, { keepUpgrade, inject }) => {
    const lines = head.toString('latin1').split('\r\n')
    const statusLine = lines.shift() ?? 'HTTP/1.1 502 Bad Gateway'
    const tokens = new Set()
    for (const line of lines) {
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      if (line.slice(0, colon).trim().toLowerCase() !== 'connection') continue
      for (const token of line.slice(colon + 1).split(',')) {
        const name = token.trim().toLowerCase()
        if (name.length > 0) tokens.add(name)
      }
    }
    const out = [statusLine]
    for (const line of lines) {
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      const name = line.slice(0, colon).trim().toLowerCase()
      if (name === 'set-cookie') continue
      if (keepUpgrade === true && (name === 'upgrade' || name === 'connection')) {
        out.push(line)
        continue
      }
      if (HOP_BY_HOP.has(name)) continue
      if (name.startsWith('proxy-')) continue
      if (tokens.has(name)) continue
      out.push(line)
    }
    if (inject !== undefined) out.push(inject)
    out.push('', '')
    return out.join('\r\n')
  }

  const buildUpgradeRequest = (req, cookie, clientIp, secure, identity) => {
    const headers = upstreamHeaders(req.headers, cookie, clientIp, secure, identity)
    const lines = [`GET ${req.url ?? '/'} HTTP/1.1`]
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
      else lines.push(`${key}: ${String(value)}`)
    }
    // The hop-by-hop filter removed these; a WebSocket handshake needs them back.
    lines.push('connection: Upgrade')
    lines.push(`upgrade: ${headerValue(req.headers, 'upgrade') ?? 'websocket'}`)
    lines.push('', '')
    return lines.join('\r\n')
  }

  const handleUpgrade = async (req, socket, head) => {
    if (closing === true) {
      refuseUpgrade(socket, 503, 'remote access: shutting down\n')
      return
    }
    const path = pathOf(req.url)
    if (path === HEALTH_PATH || path === LOGIN_PATH) {
      refuseUpgrade(socket, 404, 'remote access: not an upgrade target\n')
      return
    }

    const ip = clientAddress(req.headers, req.socket, { trustProxy: trustProxyHeaders })
    const userAgent = sanitizeIdentity(headerValue(req.headers, 'user-agent'))
    const { trusted, untrusted } = peerIdentity(req)
    if (untrusted !== undefined) {
      emit({ type: 'denied', ip, identity: untrusted.login })
    }

    let info
    let issued
    if (mode === 'tailscale') {
      if (trusted === undefined) {
        denied += 1
        emit({ type: 'auth-fail', ip })
        safeLog('warn', `remote-access: refused upgrade without identity from ${ip}`)
        refuseUpgrade(socket, 403, 'remote access: tailscale identity required\n')
        return
      }
      if (userAllowed(trusted.login) !== true) {
        denied += 1
        emit({ type: 'auth-fail', ip, identity: trusted.login })
        safeLog('warn', `remote-access: refused upgrade for identity from ${ip}`)
        refuseUpgrade(socket, 403, 'remote access: this tailscale identity is not allowed\n')
        return
      }
      info = { id: trusted.login, kind: 'identity', identity: trusted.login, name: trusted.name, ip, userAgent, trustedIdentity: trusted }
    } else {
      if (cidrAllowed(ip) !== true) {
        denied += 1
        emit({ type: 'denied', ip })
        refuseUpgrade(socket, 403, 'remote access: this client address is not allowed\n')
        return
      }
      if (isBlocked(ip) === true) {
        denied += 1
        emit({ type: 'denied', ip })
        refuseUpgrade(socket, 429, 'remote access: too many attempts\n')
        return
      }
      const session = readSession(req.headers)
      if (session === undefined) {
        if (hasPassword === true) {
          noteFailure(ip)
          denied += 1
          emit({ type: 'denied', ip })
          safeLog('warn', `remote-access: refused unauthenticated upgrade from ${ip}`)
          refuseUpgrade(socket, 401, 'remote access: session required\n')
          return
        }
        issued = issueSession(ip)
      }
      info = { id: ip, kind: 'ip', identity: undefined, name: undefined, ip, userAgent, trustedIdentity: undefined }
    }

    noteAuthOk(info)
    const entry = clientEntry(info)
    entry.websockets += 1
    entry.active = true
    entry.lastSeen = now()
    trackSocket(socket, entry.id)
    socket.once('close', () => {
      entry.websockets = Math.max(0, entry.websockets - 1)
      entry.active = entry.inflight > 0 || entry.websockets > 0
      entry.lastSeen = now()
    })

    let cookie
    try {
      cookie = await upstreamCookie(false)
    } catch (error) {
      safeLog('error', `remote-access: upgrade cookie failed: ${describe(error)}`)
      refuseUpgrade(socket, 502, 'remote access: upstream unavailable\n')
      return
    }

    const secure = secureRequest(req)
    const target = `${upstreamHost}:${String(upstreamPort)}`
    let result
    for (let attempt = 0; ; attempt += 1) {
      let upstream
      try {
        upstream = await connectUpstream()
      } catch (error) {
        safeLog('error', `remote-access: upgrade upstream connect failed: ${describe(error)}`)
        refuseUpgrade(socket, 502, 'remote access: upstream unavailable\n')
        return
      }
      trackSocket(upstream)
      try {
        upstream.write(buildUpgradeRequest(req, cookie, ip, secure, info.trustedIdentity))
        if (head !== undefined && head.length > 0) upstream.write(head)
        const parsed = await readUpgradeHead(upstream)
        const status = Number.parseInt(parsed.head.toString('latin1').split(' ')[1] ?? '', 10)
        if (status === 401 && attempt === 0) {
          upstream.destroy()
          safeLog('debug', 'remote-access: upstream rejected the harness cookie on upgrade; re-minting once')
          cookie = await upstreamCookie(true)
          continue
        }
        result = { upstream, ...parsed, status }
        break
      } catch (error) {
        upstream.destroy()
        safeLog('error', `remote-access: upgrade upstream failed (${target}): ${describe(error)}`)
        refuseUpgrade(socket, 502, 'remote access: upstream unavailable\n')
        return
      }
    }

    const { upstream, head: rawHead, rest, status } = result
    if (socket.destroyed === true) {
      upstream.destroy()
      return
    }
    const rewritten = rewriteRawHead(rawHead, {
      keepUpgrade: status === 101,
      inject: issued !== undefined ? `set-cookie: ${sessionCookie(issued, secure)}` : undefined,
    })
    socket.write(rewritten)
    if (rest.length > 0) socket.write(rest)
    if (status !== 101) {
      upstream.pipe(socket)
      upstream.once('end', () => socket.end())
      upstream.once('close', () => socket.destroy())
      return
    }
    const teardown = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', teardown)
    socket.on('error', teardown)
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.pipe(socket)
    socket.pipe(upstream)
  }

  // ------------------------------------------------------------------- server

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      safeLog('error', `remote-access: request failed: ${describe(error)}`)
      if (res.headersSent !== true) sendText(res, 502, 'remote access: upstream unavailable\n')
      else res.destroy()
    })
  })

  server.on('connection', (socket) => {
    trackSocket(socket, undefined)
  })

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error) => {
      safeLog('error', `remote-access: upgrade failed: ${describe(error)}`)
      refuseUpgrade(socket, 502, 'remote access: upstream unavailable\n')
    })
  })

  server.on('clientError', (error, socket) => {
    safeLog('debug', `remote-access: client error: ${describe(error)}`)
    try {
      socket.destroy()
    } catch {
      /* socket already gone */
    }
  })

  server.on('error', (error) => {
    safeLog('error', `remote-access: front door error: ${describe(error)}`)
  })

  const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS)
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()

  const listen = () => new Promise((resolve, reject) => {
    if (server.listening === true) {
      resolve({ port: currentPort(), host })
      return
    }
    if (mode === 'quick' && hasPassword !== true) {
      // Fail closed: quick tunnels are reachable from the whole internet.
      reject(Object.assign(new Error('quick mode requires a password before it may listen'), { code: 'FRONTDOOR_PASSWORD_REQUIRED' }))
      return
    }
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      safeLog('info', `remote-access: listening on ${host}:${String(currentPort())} -> ${upstreamHost}:${String(upstreamPort)} (${mode})`)
      resolve({ port: currentPort(), host })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  const close = () => new Promise((resolve) => {
    if (closed === true) {
      resolve()
      return
    }
    closing = true
    clearInterval(cleanupTimer)
    const finish = () => {
      if (closed === true) return
      closed = true
      resolve()
    }
    // Closing the listener first stops new connections from slipping in.
    try {
      server.close(() => {
        finish()
      })
    } catch {
      /* already closed */
    }
    for (const socket of [...allSockets]) {
      try {
        socket.destroy()
      } catch {
        /* socket already gone */
      }
    }
    allSockets.clear()
    clientSockets.clear()
    if (typeof server.closeAllConnections === 'function') {
      try {
        server.closeAllConnections()
      } catch {
        /* nothing to force-close */
      }
    }
    // Node never fires the `close` callback once a socket has been upgraded
    // (its connection counter stops tracking them), so settle on our own: by
    // now the listener is closed and every socket we own has been destroyed.
    process.nextTick(finish)
  })

  const kick = (id) => {
    const key = typeof id === 'string' ? id : String(id ?? '')
    if (key.length === 0) return 0
    let count = 0
    const sockets = clientSockets.get(key)
    if (sockets !== undefined) {
      for (const socket of [...sockets]) {
        count += 1
        try {
          socket.destroy()
        } catch {
          /* socket already gone */
        }
      }
      clientSockets.delete(key)
    }
    const entry = clients.get(key)
    if (entry !== undefined) {
      entry.inflight = 0
      entry.websockets = 0
      entry.active = false
      entry.lastSeen = now()
    }
    // Sessions are server-side state: drop the ones this client holds (F-AUTH-6).
    for (const [sid, record] of [...sessions]) {
      if (record.ip === key || record.identity === key) sessions.delete(sid)
    }
    if (count > 0 || entry !== undefined) {
      emit({ type: 'kick', identity: entry?.identity, ip: entry?.ip ?? key })
      safeLog('info', `remote-access: kicked ${String(count)} connection(s) for a client`)
    }
    return count
  }

  const status = () => {
    cleanup()
    const list = [...clients.values()].map((entry) => {
      const item = {
        id: entry.id,
        kind: entry.kind,
        ip: entry.ip,
        since: entry.since,
        lastSeen: entry.lastSeen,
        requests: entry.requests,
        websockets: entry.websockets,
        active: entry.inflight > 0 || entry.websockets > 0,
      }
      if (entry.identity !== undefined) item.identity = entry.identity
      if (entry.name !== undefined) item.name = entry.name
      if (entry.userAgent !== undefined) item.userAgent = entry.userAgent
      return item
    })
    list.sort((a, b) => (Number(b.active) - Number(a.active)) || (b.lastSeen - a.lastSeen))
    return { mode, listening: server.listening === true, port: currentPort(), host, clients: list, denied }
  }

  return { listen, close, status, kick }
}

export default { createFrontDoor, clientAddress, passwordMatches, LOGIN_PATH, HEALTH_PATH, SESSION_COOKIE }
