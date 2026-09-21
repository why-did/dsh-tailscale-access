# dsh-tailscale-access

> [!IMPORTANT]
> **Early-stage software — worth two minutes before you flip the switch.**
>
> This plugin is at `0.1.x` and still under active testing. It is exercised by an
> automated suite and used daily on the author's own machines, but its interfaces,
> defaults and behaviour can still change between releases, and it has not been
> hardened against hostile networks or shared multi-user hosts.
>
> It also does exactly what its name says: it opens a way in to a GUI that can run
> commands on this machine. Treat the entry it creates like an SSH port — keep it
> inside your tailnet, read the security model below, and make sure the trade-off is
> one you are comfortable with. If you would rather not take that on today, leaving
> the switch off costs you nothing.
>
> Questions, bug reports and "this surprised me" notes are all welcome.

A DeepSeek Harness (DSH) plugin that puts the Web GUI running on this machine on
your phone or another computer through a browser — without a public IP, without
port forwarding, and without changing where DSH listens. DSH keeps listening on
`127.0.0.1` the whole time.

```
phone / another computer
   │  tailscale serve (inside the tailnet, end-to-end encrypted)
   │  or cloudflared quick tunnel (public HTTPS)
   ▼
local rewriting front door  127.0.0.1:8787
   │  Host → 127.0.0.1:3080; drops Origin/Referer/Sec-Fetch-Site;
   │  injects the harness's own browser cookie
   ▼
dsh web  127.0.0.1:3080 (unaware that anyone is outside)
```

The npm package is `dsh-tailscale-access`. The plugin's settings section, HTTP
routes and state files keep the `remote-access` name.

## Requirements

- **DSH 0.1.5-rc.2 (`next`) or 0.1.6-alpha.2+ (`alpha`).** The card is registered
  into both card slots in use today: `plugins.item`, which 0.1.6 renders on the
  sidebar **Plugins** page, and the namespace-keyed `settings.plugin.item` that
  0.1.5-rc.2 renders on **Settings → Plugins**. Neither page renders the other's
  slot, so exactly one card appears. Builds older than those two lines (for
  example `0.0.1-rc.1`, which npm still tags `latest`) have no card slot this
  plugin can reach: enabling the entry then fails loudly with
  `DSH_VERSION_UNSUPPORTED` instead of running a panel nobody can see. The
  package declares the requirement as `engines.dsh`.
- **Node 20 or newer** (`engines.node`). The plugin itself uses only Node
  built-ins.
- **`tailscale` mode:** the tailscale CLI installed and logged in, HTTPS
  Certificates enabled for the tailnet, and permission to configure
  `tailscale serve` (on Linux that means being the tailscale operator).
- **`quick` mode (experimental, not offered in the panel):** `cloudflared`. It is downloaded automatically into
  `$DSH_HOME/cache/cloudflared` on first use when `allowDownload` is true, or
  point `cloudflaredPath` at an existing binary.
- **`none` mode:** nothing extra.

## Install

### From the Plugins page (recommended)

In DSH 0.1.6-alpha.2+, open **Plugins** in the sidebar, choose **Add plugin**,
enter the package name, and install:

```
dsh-tailscale-access
```

**Enable now** switches the new bundle on. The page writes both the profile
dependency and the `dsh.profile.bundles` entry for you.

### Manually

Install the package into the web profile (the profile lives at
`~/.dsh/profiles/web`):

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-tailscale-access
```

Then add the package name to the profile manifest's bundle list:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-tailscale-access": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-tailscale-access"
      ]
    }
  }
}
```

A profile with `"patchReload": "live"` recomposes when the manifest changes;
otherwise restart `dsh web`. The `dsh plugin --profile web add dsh-tailscale-access`
command does the same pnpm step from outside the profile directory.

### Open the card

Sidebar → **Plugins** → **Remote Access** (Official group). It is a
configuration page, not an entry under Settings → Plugins, which is the
read-only plugin inventory.

## Modes

| Mode | Entry | Authentication | Notes |
|---|---|---|---|
| `tailscale` (default) | `tailscale serve --https=443` in front of the loopback front door | **tailnet identity** (`Tailscale-User-Login` + allowlist) | Stable `https://<machine>.<tailnet>.ts.net` URL, end-to-end encrypted, no password |
| `quick` (experimental) | cloudflared quick tunnel | **password** (+ optional source CIDR allowlist) | **Still under test and not offered in the panel** — set `mode: quick` in the settings section to try it. Public HTTPS URL that changes on every start; requires an explicit risk acknowledgement |
| `none` | loopback front door only, no tunnel | **password** | Diagnostic: exercises the front door and login path; publishes nothing by itself |

Only one mode runs at a time. Switching modes tears the old entry down before
building the new one. The tailscale entry URL is the node's MagicDNS name
(`https://<machine>.<tailnet>.ts.net`); the front door listens on port `8787`
by default and DSH on `3080`.

Tailscale Funnel and tagged nodes do not carry an identity header and are always
rejected.

## Security model

This plugin deliberately provides the external entry that DSH itself refuses:
the harness rejects binding a network interface and stays on loopback. The entry
is off by default, and the GUI behind it can execute commands.

- **Identity first.** In `tailscale` mode the only credential is the
  `Tailscale-User-Login` header, and it is trusted only when the request arrives
  from loopback (tailscaled's proxy) with proxy headers enabled. A
  client-supplied `Tailscale-User-*` header is ignored. Requests without an
  identity header are rejected with `403` and counted in `denied`.
- **Fail-closed allowlist.** An empty `allowedUsers` means "only this node's own
  login", resolved from `tailscale status --json` (`Self.UserID` through the
  `User` map) at enable time. If the login cannot be resolved, enabling is
  refused. "Empty means everyone" is never a valid reading.
- **Password modes.** `quick` and `none` require a password of at least 8
  characters; `quick` additionally requires `acknowledgeRisk: true`. Sessions
  are HMAC-signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS) with a
  lifetime of `sessionHours` (default 72). Failed logins are throttled per IP:
  8 failures within 5 minutes block that IP for 15 minutes. `quick` can also
  restrict source addresses through `allowedCidrs`, matched against the
  tunnel's `CF-Connecting-IP`.
- **Loopback bind.** The front door binds `127.0.0.1` only, and DSH keeps
  listening on `127.0.0.1:3080`. No `--trusted-host` flag and no harness token
  in the browser are needed.
- **What the front door does.** It rewrites `Host` to `127.0.0.1:<dsh port>`,
  drops `Origin`, `Referer` and `Sec-Fetch-Site`, replaces the `Cookie` header
  with a harness browser cookie minted server-side (re-minted once after a
  `401`), strips `Set-Cookie` and hop-by-hop headers from responses, forwards
  HTTP and WebSocket upgrades, and derives the client address itself. An
  identity header that passed the allowlist is forwarded upstream in `tailscale`
  mode; in `none` and `quick` mode every identity header is stripped.
- **What it does not trust.** Client-supplied `CF-Connecting-IP`,
  `X-Forwarded-*`, `Forwarded` and `True-Client-IP` are discarded and replaced
  (they are honoured only from loopback in tunnel modes); forged
  `Tailscale-User-*` headers are ignored; a local session cookie is never
  accepted as an identity in `tailscale` mode.
- **Closing the switch removes everything:** `tailscale serve reset`, front door
  closed, sessions cleared, no listener left behind.
- **Whoever can reach the GUI can approve tool calls**, which means they can
  authorize command execution. The allowlist or password is exactly the
  boundary of who may approve.

## Configure

The Remote Access card is the only UI for this plugin; there is no separate
settings form and no CLI. The card polls `GET /remote-access/status.json` every
1.5 seconds, so state, the entry URL and the client list stay current without a
page refresh.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. When true the entry is restored every time the harness starts — not an operating-system boot service. |
| `mode` | `tailscale` \| `none` (\| `quick`, experimental) | `tailscale` | Which entry to build. `quick` still works when set here but is hidden in the panel while it is under test. |
| `port` | number | `8787` | Front-door port on loopback. |
| `sessionHours` | number | `72` | Browser session lifetime for the password modes. |
| `allowedUsers` | string list | `[]` | Tailnet logins allowed in `tailscale` mode. Empty means "only this node's own login". |
| `allowedCidrs` | string list | `[]` | Source-address allowlist for `quick` and `none`. |
| `cloudflaredPath` | string | `""` | Explicit cloudflared binary; empty searches `PATH` and then the cache directory. |
| `allowDownload` | boolean | `true` | Let `quick` mode download cloudflared on first use. Settings-section only. |
| `acknowledgeRisk` | boolean | `false` | `quick` mode refuses to start unless this is true. |
| `audit` | boolean | `true` | Append an audit line per accepted, denied or kicked client event. |
| `statusPage` | boolean | `true` | Serve the read-only status page. |
| `password` | string (secret) | — | Required by `quick` and `none`, at least 8 characters. Settings-section only. |
| `bind` | string | `""` | Advanced listen-address override for the front door. Leave empty (loopback); any other value widens the listen address and drops the loopback guarantee. Settings-section only. |

`password`, `allowDownload` and `bind` have no control in the card; edit them in
the settings section.

The master switch and the mode select write immediately; text, number and list
fields stage a draft and are written by **Save**. Clearing a field unsets it, so
it falls back to the default. The card marks whether the user layer overrides
any default and shows the phase (stopped, starting, running, failed) with a
copyable repair command when a prerequisite fails.

To set the password, write it into the plugin's settings section. The card has
no password field and never reads one back; the status route reports only
whether a password is set (`passwordSet`):

```yaml
# ~/.dsh/settings.yaml
remote-access:
  mode: quick
  password: "<at least 8 characters; 20+ random is recommended>"
  acknowledgeRisk: true
```

The card also shows the machine name, tailnet name, tailscale version and
backend state, the connected client list (identity or IP, first seen, last
seen, open WebSockets, request count) with a per-row **Kick**, and a bounded
list of recent events. **Restart tunnel** rebuilds the entry without restarting
the harness. Closing the switch is immediate and leaves no listener.

## Remote pages: the DSH settings limitation

DSH decides whether a page "owns the Host" from the page authority
(`isLoopback` = `localhost`, `[::1]`, `127.0.0.0/8`). On any other origin the
settings mirror runs in `memory` mode: it does not read the settings document,
and writes are dropped while still reporting success. So when a phone opens the
GUI over tailscale or cloudflared, DSH's own language, theme and settings pages
show defaults, and changes there do not persist. This is DSH's design, not a
forwarding problem — the proxy path has been verified request by request (the
home page is byte-identical, SSE, WebSocket and POST all work).

The plugin works around this for its own configuration by exposing host routes
that are reachable from the front door because it proxies from loopback:

- **Read:** `GET /remote-access/status.json` returns `config`, the host's
  effective section, never containing the password (`passwordSet` boolean, plus
  `configOverridden`).
- **Write:** `POST /remote-access/action` with `{action: "set", patch}`,
  `{action: "unset", fields}` or `{action: "reset"}`. Validation failures answer
  `400` with a code, never `500`.

The settings section remains the single source of truth; the route is just
another writer. The result is that the Remote Access card behaves the same on a
phone as on the machine. Other DSH settings pages are still affected by the
limitation above.

### "Load host settings" on a remote page

On a non-loopback page the card shows a **Remote page: load host settings**
section (hidden on loopback pages, which already have the document). **Load host
settings and apply** reads `GET /remote-access/host-settings.json` — the host
settings document with secrets redacted — and applies the host's language,
appearance and font size to the current page. Everything else in the document is
reported as read but not applied, because those preferences belong to their
owning plugins. A failed read shows the reason.

## Remote approvals

Operations that need approval (for example writing a file outside the workspace)
can be approved from the phone: approvals travel over the same proxied channel
(host-side `approval/request` waterfall to the browser-side `ui-approval`
remote event), pending approvals are session state, and any client following
that session can render the panel. Three rules matter:

- **At least one client must be online.** With no answerer the request fails
  closed (denied immediately) instead of queueing until you return. A local
  browser counts as an answerer.
- **The first answer wins.** The local machine and the phone see the same
  request; a later answer is discarded. An answer that arrives after the turn
  was cancelled is also void.
- **A suspended or disconnected phone does not wait.** Keep the page in the
  foreground. `tailscale` mode is HTTPS, so the page is a secure context with
  full browser capabilities; there is no plaintext fallback.

The consequence: whoever can enter this GUI can approve, and therefore can
authorize command execution. The `allowedUsers` allowlist or the password is the
boundary of who may approve.

## Troubleshooting

### The card says "not operator"

On Linux only root may change `tailscale serve` configuration. Make the current
user the tailscale operator once; no `sudo` is needed afterwards. The card shows
the exact command:

```bash
sudo tailscale set --operator=$USER
```

### The tailnet has no HTTPS certificates

`tailscale` mode always publishes HTTPS on port 443. There is no plaintext
`tailscale serve --tcp` fallback: a plain HTTP page is not a secure browser
context, and DSH client plugins that call `crypto.randomUUID()` break there.
Enable certificates in the Tailscale admin console under **DNS → HTTPS
Certificates**, wait for the certificate to be issued, then switch the entry on
again. If you cannot enable them, use `quick` mode, whose cloudflared tunnel
provides HTTPS. The card shows the failure with a hint naming the admin-console
setting and a copyable `tailscale serve --bg --https=443 http://127.0.0.1:<port>`
command.

### tailscale is missing, not running, or not logged in

```bash
curl -fsSL https://tailscale.com/install.sh | sh   # Linux
brew install tailscale                             # macOS
winget install --exact --id Tailscale.Tailscale    # Windows

sudo systemctl enable --now tailscaled             # daemon not running (Linux)
brew services start tailscale                      # daemon not running (macOS, Homebrew)
open -a Tailscale                                  # daemon not running (macOS, app bundle)
Start-Service Tailscale                            # daemon not running (Windows)
sudo tailscale up                                  # not logged in
tailscale status                                   # confirm the node
tailscale ip -4                                    # the node's tailnet address
```

The card reports the command that applies to the machine it runs on — systemd on
Linux (unit `tailscaled`), `brew services` or the app bundle on macOS, a Windows
service on Windows — so copy it straight from the hint.

When tailscale provides a login URL, the hint shown by the card contains it. The
card distinguishes installed, running, logged in and operator permission, and
refuses to enable the entry until the preconditions hold. Every failure carries a
one-line conclusion plus a copyable command.

### cloudflared cannot be found or downloaded

`quick` mode downloads cloudflared into `$DSH_HOME/cache/cloudflared` when
`allowDownload` is true. If the download fails (no network, no build for this
platform, proxy), install cloudflared yourself and set `cloudflaredPath` to the
binary.

### The front-door port is already in use

The error is `EADDRINUSE` for the configured `port`. Change `port` in the card,
or stop whatever holds it:

```bash
ss -ltn | grep 8787
```

### Stale rules or nothing is published

A previous run can leave a serve rule behind. Clear it and enable again:

```bash
tailscale serve status
tailscale serve reset
```

### Collecting diagnostics

```bash
curl -s http://127.0.0.1:8787/remote-access/status.json | head -c 2000
tailscale serve status
cat ~/.dsh/remote-access.json
tail -40 ~/.dsh/remote-access-audit.log
ss -ltn | grep -E '3080|8787'
```

Console lines starting with `remote-access:` carry the full error. The read-only
status page at `/remote-access/status` also works from the phone through the
tunnel.

## Files and endpoints

| Path | Contents |
|---|---|
| `$DSH_HOME/remote-access.json` | Runtime status snapshot (`enabled`, `mode`, `url`, `port`, client count, `denied`, `lastError`, `updatedAt`). |
| `$DSH_HOME/remote-access-audit.log` | Audit log (JSON lines, mode `0600`, rotated to `.1` at 5 MB) when `audit` is true. |
| `$DSH_HOME/cache/cloudflared/` | cloudflared binary downloaded by `quick` mode. |
| settings section `remote-access` in `$DSH_HOME/settings.yaml` | Configuration; the single source of truth. |

All host routes require a loopback peer, so they are unreachable from the
network even if DSH is ever bound more widely; the front door reaches them
because it proxies from loopback.

| Route | Purpose |
|---|---|
| `GET /remote-access/status.json` | Status plus the secret-free effective `config`. |
| `POST /remote-access/action` | `kick`, `restart`, `set`, `unset`, `reset`. Requires `content-type: application/json` and the `x-remote-access-action: 1` header, so a random page cannot drive it. |
| `GET /remote-access/status` | Read-only status page (`statusPage: true`). |
| `GET /remote-access/host-settings.json` | Host settings document, secrets redacted, for the remote-page button. |

Action bodies:

```json
{"action": "kick", "id": "<clients[].id>"}
{"action": "restart"}
{"action": "set", "patch": {"port": 9000}}
{"action": "unset", "fields": ["port"]}
{"action": "reset"}
```

## Known limitations

- This plugin opens the external entry DSH itself refuses. It is off by default
  and should be enabled deliberately.
- `quick` mode URLs are public and world-reachable, change on every start, and
  will be found by scanners. The password (plus optional CIDRs) is the only
  gate, so leaving `quick` on permanently is not recommended. Named tunnels
  with a stable hostname and Cloudflare Access are not implemented.
- Passwords are stored in the settings document in plaintext; only a
  `passwordSet` boolean is reported anywhere. Salted-hash storage is not
  implemented.
- In `none` and `quick` mode the password crosses the loopback hop as plain
  HTTP; the external hop is HTTPS (tailscale or cloudflared).
- On a remote page, DSH's own settings pages still show defaults. Only language,
  appearance and font size can be applied, through the button described above.
- Tailscale Funnel and tagged nodes are rejected because they carry no identity
  header.
- There is no account system or permission tier: the allowlist or password is a
  single gate, and anyone past it can execute commands through the GUI.
- Remote approval needs at least one client online and answers first-come,
  first-served; a suspended phone will not answer later.
- DSH's own security caveats still apply: the harness is not security-audited,
  and sandboxing or approvals are not a guarantee of isolation.

## Development and tests

```bash
npm install            # only dependency: @deepseek-ai/schemastery
npm test               # node --test tests/
node --test tests/routes.test.mjs
```

167 automated tests run with `node:test`, using fake upstreams and fake
binaries; network cases are gated behind `DSH_TEST_NETWORK`.

| Test file | Coverage |
|---|---|
| `tests/config.test.mjs` | Configuration normalization, bind resolution, password rules, error shape |
| `tests/routes.test.mjs` | Host routes: loopback guard, CSRF header, actions, status page, host-settings route |
| `tests/proxy.test.mjs` | Front door: header rewriting, cookie injection, WebSocket, throttling, identity rules |
| `tests/tailscale.test.mjs` | Tailscale state machine and `serve` orchestration |
| `tests/cloudflared.test.mjs`, `tests/supervisor.test.mjs` | Tunnel process, backoff, atomic status writes |
| `tests/orchestration.test.mjs`, `tests/integration.test.mjs` | Lifecycle, mode switching, end-to-end wiring against a fake upstream |
| `tests/client-bundle.test.mjs` | Client card bundle shape and behavior |

The repository also carries `ACCEPTANCE.zh.md`
(the manual acceptance checklist).

### Verification status

- The card was verified against a live DSH 0.1.6-alpha.2 build with a headless
  browser: it registers into `plugins.item`, opens the full page, and polls the
  status route without console errors.
- Still not exercised in a live GUI: the write path (switch/select plus Save
  round-trip), kick, language switching, and narrow/mobile layout.
- The `tailscale serve` path has not been run end to end on a machine with
  tailscale installed; the state machine is covered by unit tests with fake
  binaries.
- Remote approval over a tunnel is documented behavior, not yet verified end to
  end here.

## License

MIT. See [LICENSE](LICENSE).
