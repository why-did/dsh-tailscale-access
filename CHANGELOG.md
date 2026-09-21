# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-20

First public release: the DeepSeek Harness Web GUI on a phone or another
computer, behind a loopback-rewriting front door, with the harness still bound
to `127.0.0.1`. Published as `dsh-tailscale-access`; the plugin's settings section,
HTTP routes and state files keep the `remote-access` name.

### Added

- **Three entry modes**, one at a time, selected from the Remote Access card:
  `tailscale` (`tailscale serve --https=443` in front of the loopback front
  door, identity-gated), `quick` (cloudflared quick tunnel, password-gated) and
  `none` (loopback front door only, password-gated, for diagnostics).
- **Identity-first front door.** In `tailscale` mode the only credential is the
  tailnet's `Tailscale-User-Login` header, accepted only from loopback and only
  when the login is on the allowlist. An empty `allowedUsers` resolves to this
  node's own login at enable time; if that login cannot be resolved the entry
  refuses to start (fail-closed). Funnel and tagged nodes, which carry no
  identity header, are rejected.
- **Password mode** for `quick` and `none`: minimum 8 characters, HMAC-signed
  session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS) with a
  configurable lifetime, per-IP login throttling (8 failures in 5 minutes block
  for 15 minutes), and an optional source-address allowlist for `quick`.
  `quick` also requires an explicit `acknowledgeRisk` acknowledgement.
- **Audit log and read-only status page.** `$DSH_HOME/remote-access-audit.log`
  records accepted, denied and kicked client events; `/remote-access/status` is
  a self-contained page that also opens from the phone through the tunnel; a
  status snapshot is written atomically to `$DSH_HOME/remote-access.json`.
- **Client panel** registered into both card slots in use: `plugins.item` (0.1.6+
  Plugins page) and the namespace-keyed `settings.plugin.item` (0.1.5-rc.2
  Settings → Plugins), so one bundle serves both the `alpha` and `next`
  channels;
  live phase and entry URL (copyable), tailscale machine/tailnet/version and
  backend state, the connected client list with per-row **Kick**, **Restart
  tunnel**, prerequisite errors with copyable repair commands, and a bounded
  recent-events log. Status is polled every 1.5 seconds, paused while the page
  is hidden.
- **Configuration read and write over the plugin's own host routes**, so the
  card works identically on loopback and on a remote page: reads come from
  `GET /remote-access/status.json` (`config`, secret-free, with `passwordSet`
  and `configOverridden`), writes go to `POST /remote-access/action`
  (`set`/`unset`/`reset`) and land in the settings section `remote-access`,
  which remains the single source of truth. Validation failures answer `400`
  with a code.
- **Remote-page "load host settings" button.** On a non-loopback page the card
  offers to read `GET /remote-access/host-settings.json` (the host settings
  document with secrets redacted) and apply the host's language, appearance and
  font size to the current page.
- **Lifecycle handling**: the entry is restored on every harness start when
  enabled, torn down completely (`tailscale serve reset`, front door closed,
  sessions cleared) when disabled, rebuilt in place on configuration changes,
  and restarted with exponential backoff when a tunnel process exits.
- **167 automated tests** (`node --test tests/`, no network by default) covering
  configuration, host routes, header rewriting and cookie injection, WebSocket
  proxying, throttling and identity rules, the tailscale state machine and
  `serve` orchestration, the cloudflared/supervisor process handling, the
  lifecycle, and the client bundle.

### Security

- **`tailscale` mode is HTTPS-only.** The plaintext `tailscale serve --tcp`
  fallback is removed and there is no switch for it: a plain HTTP page is not a
  secure browser context, and DSH client plugins that call
  `crypto.randomUUID()` break there. A tailnet without HTTPS certificates now
  fails loudly with an actionable hint (enable HTTPS Certificates in the
  Tailscale admin console, or use `quick` mode, whose cloudflared tunnel
  provides HTTPS).
- Identity headers are trusted only from loopback; client-supplied
  `Tailscale-User-*` headers are ignored, and no local session cookie is ever
  accepted as an identity in `tailscale` mode.
- The front door binds `127.0.0.1` only. It rewrites `Host` to
  `127.0.0.1:<harness port>`, drops `Origin`, `Referer` and `Sec-Fetch-Site`,
  replaces the `Cookie` header with a harness browser cookie minted server-side
  (re-minted once after a `401`), strips `Set-Cookie` and hop-by-hop headers
  from responses, and derives the client address itself instead of trusting
  `CF-Connecting-IP` / `X-Forwarded-*` / `Forwarded` from clients.
- Every host route requires a loopback peer; mutating actions additionally
  require `content-type: application/json` and the non-simple
  `x-remote-access-action: 1` header, so a random page cannot drive them.
- Logs, the status file and the JSON status payload never contain a token,
  cookie or password.

### Fixed

- **The "daemon is not running" hint is now platform-aware.** It used to hand
  every machine `sudo systemctl enable --now tailscaled` — wrong on macOS
  (Homebrew: `brew services start tailscale`; app bundle: `open -a Tailscale`)
  and wrong on Windows. The probe takes the platform (and the resolved CLI path,
  which is what tells the macOS app bundle from a Homebrew install) and reports
  the command that actually applies. Reported by a macOS user.
- The client panel's static fallback no longer pretends to know how to start a
  daemon; the host always supplies the platform-correct command with the error.
- **"Restart tunnel" is disabled while the master switch is off.** Restart tears
  the entry down and rebuilds it, and with `enabled: false` the host returns
  before it starts anything, so the click looked like a no-op. The button now
  says why instead of pretending. With the switch on it stays available in every
  phase — that is what makes it the retry path after a failure.

### Known limitations

- **`quick` mode is still under test and is not offered in the panel.** The
  mode selector lists `tailscale` and `none` only; `cloudflaredPath` and the
  risk acknowledgement appear solely for a configuration that already selects
  `quick`. To try it, set `mode: quick` (plus `acknowledgeRisk: true` and a
  password) in the settings section: the host implements it, and the card then
  renders it with the public-exposure warning and a "still being tested" note.
- The plugin deliberately provides the external entry that DSH itself refuses
  (`--host 0.0.0.0` is rejected upstream). It is off by default and the GUI
  behind it can execute commands.
- `quick` mode URLs are public, change on every start, and are discoverable by
  scanners; the password is the only gate. Named tunnels with a stable hostname
  and Cloudflare Access are not implemented.
- Passwords are stored in the settings document in plaintext; only a
  `passwordSet` boolean is reported. Salted-hash storage is not implemented.
- On a remote (non-loopback) page, DSH itself withholds the settings document,
  so DSH's own settings pages show defaults; only language, appearance and font
  size can be applied, through the button above.
- The card's write path, kick, language switching and narrow/mobile layout have
  not been exercised in a live GUI; the `tailscale serve` link has not been run
  end to end on a machine with tailscale installed; remote approval over a
  tunnel is documented behavior, not yet verified end to end.
