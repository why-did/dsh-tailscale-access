/**
 * Host-side HTTP surface for the Remote Access card and the fallback status
 * page.
 *
 * The harness webserver does not fence plugin routes, so every handler here
 * demands a loopback peer first. Both legitimate callers satisfy that: the
 * local browser reaches the harness directly, and a remote browser arrives
 * through the front door, which proxies from loopback. A harness bound to a
 * wider interface therefore still cannot leak status to the network.
 *
 * Mutating actions additionally require a non-simple header, which forces a
 * CORS preflight and so keeps a random web page from driving them (CSRF).
 */

export const ROUTE_PREFIX = '/remote-access'
export const STATUS_PATH = `${ROUTE_PREFIX}/status.json`
export const ACTION_PATH = `${ROUTE_PREFIX}/action`
export const PAGE_PATH = `${ROUTE_PREFIX}/status`
export const HOST_SETTINGS_PATH = `${ROUTE_PREFIX}/host-settings.json`

const ACTION_HEADER = 'x-remote-access-action'
const MAX_BODY_BYTES = 4096

/** True for an IPv4/IPv6 loopback peer. */
function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

function sendJson(res, status, body) {
  if (res.headersSent) return
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch { reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' })) }
    })
    req.on('error', reject)
  })
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Remote access</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; padding:20px; font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#0b0d10; color:#e8eaed }
  h1 { font-size:16px; margin:0 0 14px }
  section { max-width:760px; padding:16px; margin-bottom:14px; border:1px solid #262b33; border-radius:12px; background:#15181d }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:0 }
  dt { color:#9aa0a6 } dd { margin:0; word-break:break-all }
  table { width:100%; border-collapse:collapse; font-size:13px }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #262b33 }
  .err { color:#ff8a80 }
  code { background:#0e1116; padding:1px 5px; border-radius:5px }
</style></head>
<body>
<h1>DeepSeek Harness — remote access</h1>
<section><dl id="state"></dl></section>
<section><table><thead><tr><th>Client</th><th>Since</th><th>Last seen</th><th>WS</th><th>Requests</th></tr></thead><tbody id="clients"></tbody></table></section>
<script>
const fmt = (t) => t ? new Date(t).toLocaleTimeString() : '—'
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
async function tick() {
  try {
    const r = await fetch('${STATUS_PATH}', { cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const s = await r.json()
    document.getElementById('state').innerHTML = [
      ['State', esc(s.phase)], ['Mode', esc(s.mode)], ['URL', esc(s.url ?? '—')],
      ['Port', esc(s.port ?? '—')], ['Clients', esc((s.clients ?? []).length)],
      ['Denied', esc(s.denied ?? 0)], ['Updated', esc(fmt(s.updatedAt))],
      ['Last error', s.lastError ? '<span class="err">' + esc(s.lastError.message) + '</span>' : '—'],
    ].map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('')
    document.getElementById('clients').innerHTML = (s.clients ?? []).map((c) =>
      '<tr><td>' + esc(c.identity ?? c.ip) + '</td><td>' + esc(fmt(c.since)) + '</td><td>' +
      esc(fmt(c.lastSeen)) + '</td><td>' + esc(c.websockets) + '</td><td>' + esc(c.requests) + '</td></tr>').join('')
  } catch (error) {
    document.getElementById('state').innerHTML = '<dt>State</dt><dd class="err">' + esc(String(error)) + '</dd>'
  }
}
tick(); setInterval(tick, 2000)
</script>
</body></html>
`

/**
 * Register the plugin's host routes.
 * @param ctx - plugin context carrying `webServer`.
 * @param api - `status()`, `kick(id)`, `restart()`.
 * @param options.statusPage - serve the read-only phone page.
 * @returns disposer for the route registration.
 */
export function registerStatusRoutes(ctx, api, { log = () => {}, statusPage = true } = {}) {
  const handler = async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      log('warn', `remote-access: refused ${String(req.socket?.remoteAddress)} on a loopback-only route`)
      sendJson(res, 403, { ok: false, error: 'loopback clients only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    if (url.pathname === STATUS_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
      sendJson(res, 200, await api.status())
      return
    }
    if (url.pathname === HOST_SETTINGS_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
      try {
        sendJson(res, 200, await api.hostSettings())
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }
    if (url.pathname === ACTION_PATH) {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
      if (req.headers[ACTION_HEADER] !== '1') { sendJson(res, 403, { ok: false, error: `missing ${ACTION_HEADER} header` }); return }
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }
      let body
      try { body = await readJson(req) } catch (error) {
        sendJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      try {
        if (body.action === 'kick') {
          if (typeof body.id !== 'string' || body.id.length === 0) { sendJson(res, 400, { ok: false, error: 'kick needs an id' }); return }
          sendJson(res, 200, { ok: true, result: { kicked: await api.kick(body.id) } })
          return
        }
        if (body.action === 'restart') {
          await api.restart()
          sendJson(res, 200, { ok: true, result: { restarted: true } })
          return
        }
        if (body.action === 'set') {
          if (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
            sendJson(res, 400, { ok: false, error: 'set needs a plain-object patch' })
            return
          }
          sendJson(res, 200, { ok: true, result: { config: await api.set(body.patch) } })
          return
        }
        if (body.action === 'unset') {
          if (!Array.isArray(body.fields) || body.fields.length === 0) {
            sendJson(res, 400, { ok: false, error: 'unset needs a non-empty fields array' })
            return
          }
          sendJson(res, 200, { ok: true, result: { config: await api.unset(body.fields) } })
          return
        }
        if (body.action === 'reset') {
          sendJson(res, 200, { ok: true, result: { config: await api.reset() } })
          return
        }
        sendJson(res, 400, { ok: false, error: `unknown action ${JSON.stringify(body.action)}` })
      } catch (error) {
        const code = String(error?.code ?? '')
        const clientFault = code.startsWith('BAD_') || code === 'UNKNOWN_FIELD' || code === 'SETTINGS_UNAVAILABLE'
        log(clientFault ? 'warn' : 'error', `remote-access: action failed: ${String(error)}`)
        sendJson(res, clientFault ? 400 : 500, { ok: false, error: String(error?.message ?? error), ...(code.length === 0 ? {} : { code }) })
      }
      return
    }
    if (statusPage && url.pathname === PAGE_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      })
      res.end(req.method === 'HEAD' ? undefined : PAGE)
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
