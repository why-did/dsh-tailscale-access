/**
 * Remote access: one switch that puts the DSH Web GUI behind an identity or
 * password gate on its own loopback port, optionally publishing it through
 * `tailscale serve` or a cloudflared quick tunnel.
 *
 * The harness keeps listening on 127.0.0.1 only. A rewriting front door
 * terminates the external session itself, then proxies to loopback with the
 * Host rewritten and the harness cookie injected, so the harness's own
 * authentication and trust fence keep working untouched.
 *
 * Configuration lives in the profile settings section `remote-access`; the
 * client card in `lib/client/client.js` renders it, and the JSON surface in
 * `lib/routes.js` feeds that card.
 */

import z from '@deepseek-ai/schemastery'
import { appendFile, stat, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFrontDoor } from './proxy.js'
import { ensureCloudflared, startTunnel } from './cloudflared.js'
import { probe as probeTailscale, serveEnable, serveReset, startDaemonHint } from './tailscale.js'
import { createRetry, createStatusWriter } from './supervisor.js'
import { registerStatusRoutes } from './routes.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'remote-access'

/** We front the Web server and mint harness cookies through the connection service. */
export const inject = ['webServer', 'connection']

const SETTINGS_NAMESPACE = 'remote-access'
const LOOPBACK = '127.0.0.1'
const MIN_PASSWORD_LENGTH = 8
const AUDIT_MAX_BYTES = 5 * 1024 * 1024

/** Plugin config; every field is editable from the Remote Access card. */
export const Config = z.object({
  /** Entry mode: tailnet identity, a public quick tunnel, or loopback only. */
  mode: z.union(['tailscale', 'quick', 'none']).default('tailscale'),
  /** Start this entry again every time the harness starts. */
  enabled: z.boolean().default(false),
  /** Front-door port on loopback. */
  port: z.natural().min(1024).max(65535).default(8787),
  /** Tailnet logins allowed through; empty means "only my own login". */
  allowedUsers: z.array(String).default([]),
  /** Client allowlist for the modes that have no identity (quick). */
  allowedCidrs: z.array(String).default([]),
  /** Browser session lifetime in hours for the password modes. */
  sessionHours: z.natural().min(1).max(720).default(72),
  /** Required by every mode that has no identity gate (none/quick). */
  password: z.string().role('secret'),
  /** Explicit cloudflared path; empty searches PATH then the cache directory. */
  cloudflaredPath: z.string().default(''),
  /** Download cloudflared into `$DSH_HOME/cache/cloudflared` on first use. */
  allowDownload: z.boolean().default(true),
  /** Quick mode exposes a command-capable GUI publicly: it must be acknowledged. */
  acknowledgeRisk: z.boolean().default(false),
  /** Append an audit line per accepted/denied client event. */
  audit: z.boolean().default(true),
  /** Serve the read-only phone status page. */
  statusPage: z.boolean().default(true),
  /** Optional bind override; empty follows the mode (always loopback today). */
  bind: z.string().default(''),
})

const DEFAULTS = {
  mode: 'tailscale',
  enabled: false,
  port: 8787,
  allowedUsers: [],
  allowedCidrs: [],
  sessionHours: 72,
  cloudflaredPath: '',
  allowDownload: true,
  acknowledgeRisk: false,
  audit: true,
  statusPage: true,
  bind: '',
}

/** Build a plugin error carrying a stable code plus user-facing repair text. */
export function pluginError(code, message, { hint, command } = {}) {
  return Object.assign(new Error(message), { code, hint, command })
}

/** Effective configuration: schema defaults under whatever the settings layer resolved. */
export function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  merged.mode = merged.mode === 'quick' || merged.mode === 'none' ? merged.mode : 'tailscale'
  merged.port = Number.isInteger(merged.port) && merged.port >= 1024 && merged.port <= 65535 ? merged.port : DEFAULTS.port
  merged.sessionHours = Number.isInteger(merged.sessionHours) && merged.sessionHours >= 1 ? merged.sessionHours : DEFAULTS.sessionHours
  merged.allowedUsers = Array.isArray(merged.allowedUsers) ? merged.allowedUsers.map(String) : []
  merged.allowedCidrs = Array.isArray(merged.allowedCidrs) ? merged.allowedCidrs.map(String) : []
  return merged
}

/** The loopback host the front door binds; `bind` only ever widens a debug setup. */
export function resolveBind(config) {
  if (typeof config.bind === 'string' && config.bind.length > 0) return config.bind
  return LOOPBACK
}

/** Whether this mode needs a password because nothing else gates it. */
export function passwordRequired(mode) {
  return mode !== 'tailscale'
}

/**
 * Whether the precondition a failure reported is now observably satisfied.
 *
 * Option B of the stale-error policy: a stopped entry must not keep presenting a
 * failure as current state once the thing that failed has been fixed. Only
 * codes whose precondition the host can actually re-check qualify — a generic
 * write/tunnel failure stays until the next attempt proves otherwise, because
 * clearing it would hide a real problem.
 *
 * @param code - the stored error code.
 * @param cfg - the effective configuration.
 * @param probe - the latest tailscale probe (may be undefined).
 * @returns true when the stored error no longer describes the world.
 */
export function preconditionSatisfied(code, cfg, probe) {
  switch (code) {
    case 'TAILSCALE_NOT_INSTALLED': return probe?.installed === true
    case 'TAILSCALE_NOT_RUNNING': return probe?.running === true
    case 'TAILSCALE_NEEDS_LOGIN': return probe?.backendState === 'Running'
    case 'TAILSCALE_NOT_OPERATOR': return probe?.operator?.ok === true
    case 'MAGICDNS_UNAVAILABLE': return (probe?.self?.dnsName ?? '').length > 0
    case 'IDENTITY_UNRESOLVED': return (probe?.self?.login ?? '').length > 0 || (cfg.allowedUsers?.length ?? 0) > 0
    case 'PASSWORD_REQUIRED': return typeof cfg.password === 'string' && cfg.password.length >= MIN_PASSWORD_LENGTH
    case 'RISK_NOT_ACKNOWLEDGED': return cfg.acknowledgeRisk === true
    default: return false
  }
}

export function apply(ctx, config, deps = {}) {
  // Injection seam: production uses the real modules; tests pass fakes so the
  // orchestration (mode switch, failure paths, teardown) is unit-testable
  // without tailscale, cloudflared, or a live harness.
  const {
    probe: probeImpl = probeTailscale,
    serveEnable: serveEnableImpl = serveEnable,
    serveReset: serveResetImpl = serveReset,
    createFrontDoor: createFrontDoorImpl = createFrontDoor,
    ensureCloudflared: ensureCloudflaredImpl = ensureCloudflared,
    startTunnel: startTunnelImpl = startTunnel,
    createRetry: createRetryImpl = createRetry,
    createStatusWriter: createStatusWriterImpl = createStatusWriter,
    registerRoutes = registerStatusRoutes,
  } = deps
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const statusFile = join(home, 'remote-access.json')
  const auditFile = join(home, 'remote-access-audit.log')
  const cacheDir = join(home, 'cache', 'cloudflared')

  let current = resolveConfig(config)
  let source = () => current
  let active
  let activeKey
  let phase = 'stopped'
  let lastError
  let lastProbe
  let lastProbeAt = 0
  let probeInFlight
  /** The card polls every ~2s; a probe spawns two processes, so keep it cheap. */
  /**
   * The client plugins that own a card slot this panel registers into, one per
   * supported channel: 0.1.6+ renders `plugins.item` (ui-plugin-manager), the
   * `next` channel (0.1.5-rc.2) renders the namespace-keyed
   * `settings.plugin.item` (ui-settings-plugins). Either one means the panel
   * will appear; neither means the card could never be shown.
   */
  const CARD_SLOT_OWNERS = ['@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-client-ui-settings-plugins']
  /** Oldest DSH release line the panel renders on (F-COMPAT). */
  const MIN_DSH_VERSION = '0.1.5-rc.2 (next) / 0.1.6-alpha.2 (alpha)'
  const PROBE_TTL_MS = 10_000
  const probeTtlMs = typeof deps.probeTtlMs === 'number' ? deps.probeTtlMs : PROBE_TTL_MS
  let effectiveUsers = []
  let queue = Promise.resolve()
  let settingsProvider
  let clientGraph
  let restartTimer
  let retry = createRetryImpl({ log: (level, message) => log(level, message) })
  let stopped = false

  const writeStatus = createStatusWriterImpl({ path: statusFile, log: (level, message) => log(level, message) })

  function log(level, message) {
    const logger = ctx.logger
    const write = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : undefined
    if (write !== undefined) write(message)
  }

  /** Append one audit line, rotating a single oversized file out of the way. */
  function audit(event) {
    if (current.audit !== true) return
    appendFile(auditFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`, { mode: 0o600 }).catch(() => {})
  }

  function noteError(error) {
    lastError = {
      code: error?.code ?? 'REMOTE_ACCESS_ERROR',
      message: error?.message ?? String(error),
      ...(error?.hint === undefined ? {} : { hint: error.hint }),
      ...(error?.command === undefined ? {} : { command: error.command }),
      at: Date.now(),
    }
    log('error', `remote-access: ${lastError.code}: ${lastError.message}${lastError.hint === undefined ? '' : ` (${lastError.hint})`}`)
  }

  /**
   * Latest tailscale probe, refreshed on demand with a short TTL. The card must
   * be able to answer "is tailscale ready?" while the entry is still switched
   * off, and it must never show a stale result from before tailscale was
   * installed or started.
   * @param options.force - bypass the TTL (used when actually starting the entry).
   * @returns the probe result, or undefined when probing is impossible.
   */
  async function currentProbe({ force = false } = {}) {
    const now = Date.now()
    if (!force && lastProbe !== undefined && now - lastProbeAt < probeTtlMs) return lastProbe
    if (probeInFlight !== undefined) return probeInFlight
    probeInFlight = (async () => {
      try {
        const result = await probeImpl({})
        lastProbe = result
        lastProbeAt = Date.now()
        return result
      } finally {
        probeInFlight = undefined
      }
    })()
    return probeInFlight
  }

  /**
   * The effective configuration as the card may see it: every field except the
   * secret, which is reported only as a boolean. Remote pages have no settings
   * document, so this is the only place a card can learn current values.
   * @returns a plain, secret-free snapshot.
   */
  function effectiveConfig() {
    const { password, ...rest } = current
    return {
      ...rest,
      passwordSet: typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH,
      configOverridden: Object.keys(DEFAULTS).some((key) => JSON.stringify(current[key]) !== JSON.stringify(DEFAULTS[key])),
    }
  }

  const BOOLEAN_FIELDS = new Set(['enabled', 'allowDownload', 'acknowledgeRisk', 'audit', 'statusPage'])
  const NUMBER_FIELDS = new Set(['port', 'sessionHours'])
  const STRING_FIELDS = new Set(['mode', 'bind', 'cloudflaredPath'])
  const LIST_FIELDS = new Set(['allowedUsers', 'allowedCidrs'])

  /** Validate one patch value against its field's shape; throws a coded error. */
  function normalizeField(key, value) {
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== 'boolean') throw pluginError('BAD_VALUE', `${key} must be a boolean`)
      return value
    }
    if (NUMBER_FIELDS.has(key)) {
      if (!Number.isInteger(value) || value < 1) throw pluginError('BAD_VALUE', `${key} must be a positive integer`)
      if (key === 'port' && (value < 1024 || value > 65535)) throw pluginError('BAD_VALUE', 'port must be between 1024 and 65535')
      if (key === 'sessionHours' && value > 720) throw pluginError('BAD_VALUE', 'sessionHours must be at most 720')
      return value
    }
    if (STRING_FIELDS.has(key)) {
      if (typeof value !== 'string') throw pluginError('BAD_VALUE', `${key} must be a string`)
      if (key === 'mode' && !['tailscale', 'quick', 'none'].includes(value)) throw pluginError('BAD_VALUE', `mode must be tailscale, quick or none`)
      return value
    }
    if (LIST_FIELDS.has(key)) {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw pluginError('BAD_VALUE', `${key} must be an array of strings`)
      return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    }
    if (key === 'password') {
      if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) throw pluginError('BAD_VALUE', `password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`)
      return value
    }
    throw pluginError('UNKNOWN_FIELD', `unknown config field ${JSON.stringify(key)}`)
  }

  /**
   * Write a config patch into the settings section (SPEC F-API). This is the
   * write path every page uses, loopback or not; the settings section stays the
   * single source of truth and `sync()` reacts to it as usual.
   * @param patch - plain-object patch over the section.
   * @returns the new effective configuration.
   */
  async function setConfig(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw pluginError('BAD_PATCH', 'set needs a plain object patch')
    }
    if (settingsProvider === undefined) {
      throw pluginError('SETTINGS_UNAVAILABLE', 'the settings provider is not available in this composition')
    }
    const clean = {}
    for (const [key, value] of Object.entries(patch)) clean[key] = normalizeField(key, value)
    if (Object.keys(clean).length > 0) await settingsProvider.update(SETTINGS_NAMESPACE, clean)
    return effectiveConfig()
  }

  /** Drop every user-layer override, re-inheriting schema defaults. */
  async function resetConfig() {
    if (settingsProvider === undefined) {
      throw pluginError('SETTINGS_UNAVAILABLE', 'the settings provider is not available in this composition')
    }
    await settingsProvider.replace(SETTINGS_NAMESPACE, {})
    return effectiveConfig()
  }

  /**
   * Drop selected fields from the user layer so the schema default re-inherits
   * (the card's "empty value" path).
   * @param fields - field names to unset.
   * @returns the new effective configuration.
   */
  async function unsetConfig(fields) {
    if (!Array.isArray(fields) || fields.length === 0) throw pluginError('BAD_PATCH', 'unset needs a non-empty fields array')
    if (settingsProvider === undefined) {
      throw pluginError('SETTINGS_UNAVAILABLE', 'the settings provider is not available in this composition')
    }
    const ops = fields.map((field) => {
      if (typeof field !== 'string' || !(field in DEFAULTS)) throw pluginError('UNKNOWN_FIELD', `unknown config field ${JSON.stringify(field)}`)
      return { op: 'unset', path: [field] }
    })
    await settingsProvider.mutate(SETTINGS_NAMESPACE, ops)
    return effectiveConfig()
  }

  /**
   * The Host's settings document, redacted, for a remote page.
   *
   * DSH withholds the document from any non-loopback page (ui-settings runs its
   * mirror in `memory` mode there), so the card offers an explicit "load host
   * settings" button for exactly that case: the same data the local page reads
   * for free, delivered over this plugin's own route. Secrets are redacted by
   * the provider itself.
   * @returns locale, theme, and every namespace's resolved value.
   */
  function hostSettings() {
    if (settingsProvider === undefined) {
      throw pluginError('SETTINGS_UNAVAILABLE', 'the settings provider is not available in this composition')
    }
    const sections = {}
    for (const descriptor of settingsProvider.describe({ redactSecrets: true })) {
      sections[descriptor.ns] = descriptor.value
    }
    const locale = sections.locale !== null && typeof sections.locale === 'object' ? sections.locale.preference : undefined
    const theme = sections['ui-theme'] !== null && typeof sections['ui-theme'] === 'object' ? sections['ui-theme'] : undefined
    return {
      ...(typeof locale === 'string' ? { locale } : {}),
      ...(theme === undefined ? {} : { theme: { preference: theme.preference, fontSize: theme.fontSize } }),
      sections,
      readAt: Date.now(),
    }
  }

  async function status() {
    // Always refresh through the TTL cache: a stopped entry must still answer
    // "is tailscale ready?", and a running one must notice tailscale going away.
    const probe = current.mode === 'tailscale'
      ? await currentProbe().catch(() => lastProbe)
      : lastProbe
    // Option B: drop a failure whose precondition no longer holds, and put the
    // phase back to "stopped" so the badge never says "failed" without a cause.
    if (lastError !== undefined && preconditionSatisfied(lastError.code, current, probe)) {
      log('info', `remote-access: clearing stale error ${lastError.code} (its precondition is satisfied now)`)
      lastError = undefined
      if (phase === 'error') phase = 'stopped'
      persist()
    }
    const door = active?.frontDoor?.status()
    return {
      enabled: current.enabled === true,
      mode: current.mode,
      phase,
      ...(active?.url === undefined ? {} : { url: active.url }),
      localUrl: `http://${LOOPBACK}:${String(current.port)}/`,
      port: current.port,
      ...(probe === undefined ? {} : { tailscale: probe }),
      config: effectiveConfig(),
      allowedUsers: effectiveUsers,
      clients: door?.clients ?? [],
      denied: door?.denied ?? 0,
      ...(lastError === undefined ? {} : { lastError }),
      updatedAt: Date.now(),
    }
  }

  function persist() {
    writeStatus({
      enabled: current.enabled === true,
      mode: current.mode,
      phase,
      url: active?.url,
      port: current.port,
      clients: active?.frontDoor?.status().clients.length ?? 0,
      denied: active?.frontDoor?.status().denied ?? 0,
      lastError,
      updatedAt: Date.now(),
    })
  }

  /** Mint a harness browser cookie by exchanging the process token over loopback. */
  async function mintHarnessCookie() {
    const port = ctx.webServer.port
    const url = ctx.connection.authenticatedUrl(`http://${LOOPBACK}:${String(port)}`)
    const response = await fetch(url, { redirect: 'manual' })
    const header = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()[0]
      : response.headers.get('set-cookie')
    if (typeof header !== 'string' || header.length === 0) {
      throw pluginError('HARNESS_COOKIE_UNAVAILABLE', `the harness returned no browser cookie (HTTP ${String(response.status)})`)
    }
    return header.split(';')[0]
  }

  /** Resolve the tailnet identity allowlist, defaulting to this node's own login. */
  function resolveUsers(cfg, probeResult) {
    if (cfg.allowedUsers.length > 0) return cfg.allowedUsers
    const login = probeResult?.self?.login
    if (typeof login !== 'string' || login.length === 0) {
      throw pluginError('IDENTITY_UNRESOLVED', 'cannot resolve this node\'s own tailnet login, so the allowlist cannot default to you', {
        hint: 'set allowedUsers explicitly, or fix tailscale status first',
        command: 'tailscale status --json',
      })
    }
    return [login]
  }

  function assertStartable(cfg) {
    if (passwordRequired(cfg.mode)) {
      const password = typeof cfg.password === 'string' ? cfg.password : ''
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw pluginError('PASSWORD_REQUIRED', `${cfg.mode} mode has no identity gate, so it needs a password of at least ${String(MIN_PASSWORD_LENGTH)} characters`, {
          hint: 'set a password in the settings section (v1: edit settings.yaml directly), or use mode: tailscale',
          command: 'dsh web',
        })
      }
    }
    const entries = clientGraph === undefined ? undefined : clientGraph()
    if (entries !== undefined && !entries.some((row) => CARD_SLOT_OWNERS.includes(row?.id))) {
      throw pluginError('DSH_VERSION_UNSUPPORTED', 'this DSH build does not render the plugin card slot this panel needs', {
        hint: `本插件需要 DSH ≥ ${MIN_DSH_VERSION}：更早的版本没有可用的插件卡片 slot，本面板不会出现。升级 DSH 后再打开开关。`,
      })
    }
    if (cfg.mode === 'quick' && cfg.acknowledgeRisk !== true) {
      throw pluginError('RISK_NOT_ACKNOWLEDGED', 'quick mode publishes a command-capable GUI to the public internet', {
        hint: 'enable acknowledgeRisk only if you accept that the tunnel URL is world-reachable',
      })
    }
  }

  async function startTailscale(cfg) {
    const probeResult = await currentProbe({ force: true })
    if (probeResult?.error !== undefined) {
      throw pluginError(probeResult.error.code ?? 'TAILSCALE_ERROR', probeResult.error.message ?? 'tailscale probe failed', {
        hint: probeResult.error.hint,
        command: probeResult.error.command,
      })
    }
    if (probeResult?.installed !== true) {
      throw pluginError('TAILSCALE_NOT_INSTALLED', 'tailscale is not installed on this machine', {
        hint: 'install tailscale, then run `sudo tailscale up`',
        command: 'curl -fsSL https://tailscale.com/install.sh | sh',
      })
    }
    if (probeResult.running !== true) {
      const start = startDaemonHint({ bin: probeResult.bin })
      throw pluginError('TAILSCALE_NOT_RUNNING', 'tailscaled is not running', {
        hint: start.hint,
        command: start.command,
      })
    }
    if (probeResult.operator !== undefined && probeResult.operator.ok === false) {
      throw pluginError('TAILSCALE_NOT_OPERATOR', 'this user cannot configure tailscale serve', {
        hint: probeResult.operator.hint,
        command: probeResult.operator.command,
      })
    }
    const users = resolveUsers(cfg, probeResult)
    effectiveUsers = users
    const frontDoor = createFrontDoorImpl({
      mode: 'tailscale',
      host: resolveBind(cfg),
      port: cfg.port,
      upstreamPort: ctx.webServer.port,
      resolveUpstreamCookie: mintHarnessCookie,
      allowedUsers: users,
      allowedCidrs: [],
      trustProxyHeaders: true,
      sessionHours: cfg.sessionHours,
      onEvent: audit,
      log: (level, message) => log(level, message),
    })
    await frontDoor.listen()
    try {
      await serveEnableImpl({ bin: probeResult.bin, port: cfg.port, log: (level, message) => log(level, message) })
    } catch (error) {
      // No plaintext retry: `serve --tcp` would hand the browser an insecure
      // origin where `crypto.randomUUID()` is missing and the GUI breaks. A
      // certificate failure is a real, fixable state, so it surfaces as-is
      // with the hint that names the admin-console fix (or quick mode).
      await frontDoor.close().catch(() => {})
      throw error
    }
    const dnsName = probeResult.self?.dnsName
    if (typeof dnsName !== 'string' || dnsName.length === 0) {
      await frontDoor.close().catch(() => {})
      throw pluginError('MAGICDNS_UNAVAILABLE', 'the tailnet has no MagicDNS name for this node', {
        hint: 'enable MagicDNS in the admin console, or check `tailscale status --json`',
        command: 'tailscale status --json',
      })
    }
    const url = `https://${dnsName}`
    active = { frontDoor, tunnel: undefined, url, serve: { bin: probeResult.bin, applied: true } }
    log('warn', `remote-access: tailnet entry ready at ${url} (identity-gated, allowed: ${users.join(', ')})`)
  }

  async function startQuick(cfg) {
    const bin = await ensureCloudflaredImpl({
      explicitPath: cfg.cloudflaredPath,
      cacheDir,
      allowDownload: cfg.allowDownload !== false,
      log: (level, message) => log(level, message),
    })
    const frontDoor = createFrontDoorImpl({
      mode: 'quick',
      host: resolveBind(cfg),
      port: cfg.port,
      upstreamPort: ctx.webServer.port,
      resolveUpstreamCookie: mintHarnessCookie,
      allowedUsers: [],
      allowedCidrs: cfg.allowedCidrs,
      trustProxyHeaders: true,
      password: cfg.password,
      sessionHours: cfg.sessionHours,
      onEvent: audit,
      log: (level, message) => log(level, message),
    })
    await frontDoor.listen()
    const tunnel = startTunnelImpl({
      bin,
      port: cfg.port,
      log: (level, message) => log(level, message),
      onUrl: (url) => {
        if (active !== undefined) active.url = url
        log('warn', `remote-access: public URL ${url} (password required)`)
        persist()
      },
      onExit: (code, signal) => {
        if (stopped) return
        log('warn', `remote-access: cloudflared exited (code ${String(code)}, signal ${String(signal)}); restarting`)
        scheduleRestart('tunnel exited')
      },
    })
    active = { frontDoor, tunnel, url: tunnel.url, serve: undefined }
    log('warn', `remote-access: public quick tunnel starting on 127.0.0.1:${String(cfg.port)} (password required)`)
  }

  async function startNone(cfg) {
    const frontDoor = createFrontDoorImpl({
      mode: 'none',
      host: resolveBind(cfg),
      port: cfg.port,
      upstreamPort: ctx.webServer.port,
      resolveUpstreamCookie: mintHarnessCookie,
      allowedUsers: [],
      allowedCidrs: cfg.allowedCidrs,
      trustProxyHeaders: false,
      password: cfg.password,
      sessionHours: cfg.sessionHours,
      onEvent: audit,
      log: (level, message) => log(level, message),
    })
    await frontDoor.listen()
    active = { frontDoor, tunnel: undefined, url: undefined, serve: undefined }
    log('info', `remote-access: loopback-only front door on 127.0.0.1:${String(cfg.port)}`)
  }

  async function stopActive() {
    const previous = active
    active = undefined
    if (previous === undefined) return
    previous.tunnel?.stop()
    if (previous.serve?.applied === true) {
      await serveResetImpl({ bin: previous.serve.bin, log: (level, message) => log(level, message) }).catch((error) => {
        log('warn', `remote-access: tailscale serve reset failed: ${String(error)}`)
      })
    }
    await previous.frontDoor.close().catch(() => {})
  }

  function scheduleRestart(reason) {
    if (stopped) return
    const delay = retry.next()
    if (delay === undefined) {
      phase = 'error'
      noteError(pluginError('TUNNEL_RESTART_EXHAUSTED', `tunnel kept failing (${reason})`))
      persist()
      return
    }
    phase = 'starting'
    persist()
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      queue = queue.then(() => sync({ force: true }), () => sync({ force: true }))
    }, delay)
  }

  async function start(cfg) {
    phase = 'starting'
    persist()
    try {
      assertStartable(cfg)
      if (cfg.mode === 'tailscale') await startTailscale(cfg)
      else if (cfg.mode === 'quick') await startQuick(cfg)
      else await startNone(cfg)
      phase = 'running'
      lastError = undefined
      retry.reset()
    } catch (error) {
      noteError(error)
      phase = 'error'
      await stopActive()
    }
    persist()
  }

  function configKey(cfg) {
    return JSON.stringify({
      mode: cfg.mode,
      enabled: cfg.enabled === true,
      port: cfg.port,
      allowedUsers: cfg.allowedUsers,
      allowedCidrs: cfg.allowedCidrs,
      sessionHours: cfg.sessionHours,
      password: typeof cfg.password === 'string' ? cfg.password : '',
      cloudflaredPath: cfg.cloudflaredPath,
      allowDownload: cfg.allowDownload !== false,
      acknowledgeRisk: cfg.acknowledgeRisk === true,
      statusPage: cfg.statusPage !== false,
      bind: cfg.bind,
      webPort: ctx.webServer.port,
    })
  }

  async function sync({ force = false } = {}) {
    current = resolveConfig(source())
    const key = configKey(current)
    if (!force && key === activeKey) return
    activeKey = key
    clearTimeout(restartTimer)
    await stopActive()
    if (current.enabled !== true) {
      phase = 'stopped'
      lastError = undefined
      persist()
      return
    }
    await start(current)
  }

  const schedule = () => {
    queue = queue.then(() => sync(), () => sync())
    return queue
  }

  function restart() {
    activeKey = undefined
    queue = queue.then(() => sync({ force: true }), () => sync({ force: true }))
    return queue
  }

  async function rotateAuditIfHuge() {
    try {
      const info = await stat(auditFile)
      if (info.size > AUDIT_MAX_BYTES) await rename(auditFile, `${auditFile}.1`)
    } catch {}
  }

  ctx.inject(['clientModules'], (modulesCtx) => {
    // F-COMPAT: the panel registers into the `plugins.item` card slot, which only
    // exists from 0.1.6-alpha.2 on — older builds render plugin cards into
    // `settings.plugin.item` instead, where this plugin registers nothing and the
    // panel would silently never appear. Probing the *capability* (is the card
    // slot's owner composed?) beats comparing version strings, and an unavailable
    // probe stays "unknown" rather than "unsupported".
    clientGraph = () => {
      try {
        const graph = modulesCtx.clientModules.graph()
        return Array.isArray(graph?.entries) ? graph.entries : undefined
      } catch (error) {
        log('warn', `remote-access: client module graph unavailable: ${String(error?.message ?? error)}`)
        return undefined
      }
    }
  })

  ctx.inject(['settings'], (settingsCtx) => {
    // The provider is also the write path: a remote (non-loopback) page cannot
    // use `settingsScope` at all — DSH runs that mirror in memory mode there and
    // silently drops reads *and* writes — so the card writes through our own
    // host route, which lands here. See SPEC F-API.
    settingsProvider = settingsCtx.settings
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (next) => { source = next },
      onChange: () => { void schedule() },
    })
  })

  ctx.effect(() => {
    const dispose = registerRoutes(ctx, {
      status: async () => status(),
      kick: async (id) => {
        const kicked = active?.frontDoor?.kick(id) ?? 0
        audit({ type: 'kick', id, kicked })
        persist()
        return kicked
      },
      restart,
      set: setConfig,
      unset: unsetConfig,
      hostSettings,
      reset: resetConfig,
    }, {
      log: (level, message) => log(level, message),
      statusPage: current.statusPage !== false,
    })
    return dispose
  }, 'remote-access:status-routes')

  void rotateAuditIfHuge()
  void schedule()

  ctx.effect(() => () => {
    stopped = true
    clearTimeout(restartTimer)
    queue = queue.then(() => stopActive(), () => stopActive())
    return queue.then(() => writeStatus.flush?.())
  }, 'remote-access:shutdown')
}

export default { name, inject, Config, apply }
