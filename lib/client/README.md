# `lib/client/` — browser half of `dsh-tailscale-access`

Hand-written client bundle. **No bundler, no build step, no dependency**: `client.js`
is a classic script that only registers a lazy CJS factory with the dsh browser
module system. Everything else (slot registration, dictionary registration,
polling) happens when the factory is materialized, never at script execution.

```
window.__ModuleLoader__.load({ id: 'dsh-tailscale-access', factory: (require) => { … } })
```

* `client.js` — the bundle (registered card: `plugins.item` / `remote-access` / order 50).
* `../tests/client-bundle.test.mjs` — loads the bundle in `node:vm` with a fake
  loader, a fake `require`, a minimal React, fake timers, and a fake `fetch`,
  then renders the registered component and drives its controls.
  `node --test tests/client-bundle.test.mjs` → 18 tests, all passing.

## 0. What the host must provide for this file to be served

Owned by `package.json` (lead):

| Field | Value | Why |
|---|---|---|
| `name` | `dsh-tailscale-access` | **the bundle id must equal the package name**: the host serves `/plugins/<package name>/client.js` and the loader registers factories under that id. Changing the name means changing `id:` on line 1 of the `load(...)` call. |
| `dsh.client.platform` | `"web"` | without it the host scan ignores the package entirely |
| `exports["./client"]` | `"./lib/client/client.js"` | the only path the host reads for the bundle |
| `dsh.client.inject` | `[]` | this bundle hard-requires no other *package* bundle; it waits for the `plugins.item` slot through `ctx.slots.inject` instead |
| `dsh.client.external` | not needed | every required id is a platform seed word (below) |

There is no `sourceMappingURL` and no `.map`; the host tolerates a missing map.

## 1. Module faces (`require(...)`) — the complete list

| id | kind | verified? | what is taken | when it is missing |
|---|---|---|---|---|
| `react` | platform **seed word** | ✅ present in the web shell's static module map (`{react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit"}`), so it can never miss the module table | `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback` | the factory throws and the host marks the entry failed; the settings page keeps working (the slot simply never fills) |
| `react/jsx-runtime` | platform **seed word** | ✅ same map | `jsx`, `jsxs` (through the local `h()` helper) | same as above |
| `@deepseek-ai/dsh-client-ui-primitives` | platform **seed word**, **probed, optional** | ✅ present in the same map, but only `writeClipboard(text) => Promise<boolean>` is used | clipboard write for the URL / repair commands | recorded in `exports.__remoteAccessDiagnostics.missingModules`, a *"缺少依赖 / Missing dependencies"* notice is rendered, and copying degrades to `navigator.clipboard.writeText`, then to a "copy failed" label |

Nothing else is required. In particular there is **no** import of
`dsh-client-ui-settings`, `dsh-client-ui-slots`, `dsh-client-store`,
`dsh-client-locale`, or any host package: cross-plugin collaboration goes
through cordis services on `ctx` (the client bundle purity gate), and the
card keeps its own state in React hooks.

There is no `console.*` anywhere in the bundle (INTERFACES §0); diagnostics are
published on the non-contract export `exports.__remoteAccessDiagnostics`
(`{ id, missingModules, scope, registration, notes[] }`).

## 2. Services read from `ctx`, and what happens without them

| service / API | declared in `exports.inject`? | used for | degradation when absent |
|---|---|---|---|
| `ctx.slots` | **yes** (`inject = ['slots']`) | `slots.inject('plugins.item', cb)`, `slots.register(...)` | `apply` returns and records `registration: 'skipped: slots service unavailable'`; no card, no throw |
| `ctx.slots.inject` | — | waits until the Plugins page *declares* the `plugins.item` slot, then registers; the returned disposer is handed back to `inject` as its effect disposer | if the Plugins page never loads, the card never appears (nothing else breaks) |
| `ctx.slots.register` | — | one list entry (`id`, `order`, `label` thunk) + the component | a throw (e.g. duplicate `id` + `priority`) is caught and recorded as `registration: 'register-failed: …'` |
| `ctx.settingsScope` | **no** (accessed through `tryGetService`) | `bind({ namespace: 'remote-access' })` → `getSnapshot()` / `subscribe()` / `set()` / `unset()` | `null` scope → the panel renders *"配置服务（settingsScope）不可用，面板以只读状态运行"*, every control is disabled, and a write attempt reports `settings scope unavailable`; the runtime/status half of the panel keeps working |
| `ctx.locale` | **no** | `register('remote-access', 'zh'\|'en', dict)` inside `ctx.effect`, `bind(ns)`, `getSnapshot().active`, `subscribe(fn)` | the bundled dictionaries answer (the language is then taken from `navigator.language`), the label thunk still resolves, and no locale re-render channel is installed |
| `ctx.effect` | — | owns the dictionary registration so plugin unload removes it | if absent, dictionaries are simply not registered (bundled dicts are still used) |
| `ctx.logger` | not used | — | — |

Notes on the defensive reads:

* `tryGetService(ctx, name)` wraps `ctx[name]` in `try/catch`: a cordis context
  **throws** (`cannot get property "x" without inject`) for a service nobody
  provides, so a plain property read is not safe.
* `ctx.locale.bind(ns)` answers with the **key itself** on a miss; the bundle
  detects that and falls back to its own dictionary, so a half-registered
  namespace still renders real text.
* Every `fetch` failure (rejection, non-2xx, non-JSON body, no `fetch` at all)
  is swallowed and rendered as *未连接 / Not connected* with the reason.
* `apply` itself is wrapped in `try/catch`: a bug in this bundle degrades the
  card, it can never take the settings page down.

## 3. Slot registration convention

```js
exports.inject = ['slots']

ctx.slots.inject('plugins.item', () => ctx.slots.register({
  name: 'plugins.item',
  id: 'remote-access',
  order: 50,                          // after web-search (40)
  label: () => translate('title'),    // thunk: re-read by resolveSlotLabel per locale switch
}, Card))
```

* **`id` / `order` / `label`** are the frozen identity from INTERFACES §6
  (`remote-access`, 50, bilingual). The label is a **thunk**, not a string, so
  the Plugins page's ledger (which subscribes to `ctx.locale`) picks up a
  language switch without re-registration.
* **No `locale:` declaration.** This is deliberate: declaring it makes the
  renderer synthesize the `t` seat and *require* an installed locale face
  ("fails loud otherwise"). This bundle resolves the same face itself and
  degrades to its dictionaries instead. Consequence: the component does not
  receive `props.t`; it closes over its own translate function and calls
  `ctx.locale.subscribe` to re-render on a language switch.
* **No `children`, no `store`, no `inject` face.** The card is self-contained:
  it holds its state in hooks and closes over `ctx` and the bound settings
  scope captured in `apply`. The registration is disposed with the plugin
  fiber, so a stale context can never be rendered.
* **Two views.** `props.view === 'summary'` returns a one-liner and *nothing
  else* — the summary is rendered for every card in the Plugins list, so it
  must not poll or allocate timers. Any other value (including a missing
  `view`) renders the panel; that is the safe default.
* `data-*` hooks the panel exposes for tests/debugging:
  `data-dsh-tailscale-access="page|summary"`, `data-ra-section`,
  `data-ra-phase`, `data-ra-input`, `data-ra-field`, `data-ra-client`,
  `data-ra-action="save|discard|kick|restart"`, `data-ra-copy`,
  `data-ra-check`, `data-ra-missing-deps`, `data-ra-unreachable`,
  `data-ra-lasterror`, `data-ra-tailscale`, `data-ra-scope`.

## 4. HTTP contract this bundle speaks

**Status (polled).** `GET /remote-access/status.json` — relative path, never
absolute; `accept: application/json`, `cache: 'no-store'`,
`credentials: 'same-origin'`; first request immediately, then every
**1500 ms** (SPEC asks for 1–2 s); polling is suspended while
`document.visibilityState === 'hidden'` and resumes (with an immediate
refresh) when the page returns; unmount clears the interval, removes the
`visibilitychange` listener, bumps a request epoch and aborts the in-flight
request, so a late answer can never set state on an unmounted card.

Fields read (all optional, all type-checked): `enabled`, `mode`, `phase`,
`url`, `localUrl`, `port`, `allowedUsers`, `clients[]`
(`id, kind, identity, name, ip, since, lastSeen, requests, websockets, active,
userAgent`), `denied`, `lastError {code, message, hint, command, at}`,
`tailscale {installed, running, backendState, self {login, hostName, dnsName,
ips}, tailnet {name, magicDnsSuffix}, error {code, message, hint, command}}`,
`updatedAt`. A field the host does not send yet renders as `—` / *unknown*.

**Actions.** `POST /remote-access/action` with `content-type: application/json`
**and** `x-remote-access-action: 1`, body `{action:'kick', id}` or
`{action:'restart'}`, expecting `{ok: true, result: {kicked: N} | {restarted: true}}`.
Kick is two-step in the UI (arm → confirm) so a stray click cannot drop a
session; both actions refresh the status immediately and append an event.

**Checked against the host implementation** (read, not yet exercised end to end):
`lib/routes.js` exposes exactly `GET /remote-access/status.json` and
`POST /remote-access/action`, requires the `x-remote-access-action: 1` header
plus an `application/json` content type on the action (a non-simple header, so
a random page cannot drive it — CSRF), answers failures as
`{ok: false, error: '<string>'}` (which this bundle surfaces verbatim), and
serves the fallback page at `/remote-access/status`. Both routes are
**loopback-only** (403 otherwise); the panel always reaches them from loopback
— directly, or through the front door, which proxies from loopback. The status
producer (`lib/index.js` → `status()`) and the probe (`lib/tailscale.js`) use
the field names this bundle reads, including `tailscale.version`
(from `tailscale status --json` `Version`), `self.{dnsName,hostName,ips}` and
`tailnet.{name,magicDnsSuffix}`.

**Configuration.** Every write goes through the bound settings scope — the
bundle never invents a second source of truth and never keeps a copy of the
document:
* switches and the mode select write immediately (`set(field, value)`);
* text/number/list fields stage a draft and are written by the **Save**
  control (one `set`/`unset` per changed field, in order); an empty draft
  means `unset`, so clearing a field re-inherits the default;
* the panel marks whether the user layer overrides anything, and shows
  `status: 'loading' | 'unavailable'` and `writable: false` explicitly.

## 5. Not verified against a real host (confirm before trusting)

The bundle has **never** been loaded by the real browser module system. All of
the following are read from type declarations, built bundles, or the frozen
interfaces — not observed in a running dsh:

1. **Bundle serving and materialization.** `/plugins/dsh-tailscale-access/client.js`,
   the `?rev=` handling, combo-URL assembly, and the `factory(require)` call
   itself are exercised only by the fake loader in the test.
2. **Cordis entry lifecycle.** `exports.apply` + `exports.inject = ['slots']`
   is the same face the built-in client bundles export, but this exact module
   has not been mounted by `EntryTree.import`; whether the loader passes extra
   arguments to `apply`, or requires `name`/`Config`/`reusable`, is unverified.
3. **`plugins.item` is the right slot for a bundle.** The slot's own contract
   comment says `plugins.item` is *occupied* by the built-in host-plane
   configuration pages and that "a bundle's configuration belongs in
   `plugins.bundle.config` or `plugins.row.config` instead". SPEC F-UI-1 /
   F-CONF-2 / INTERFACES §6 explicitly ask for `plugins.item`, so that is what
   is implemented. Unverified: whether our card actually appears in the
   Official group (the built-in pages only register while the host serves
   their namespace; this bundle registers unconditionally), and whether it
   would be better placed in `plugins.bundle.config` (keyed by package name),
   which is where a user looking at the plugin's own page would find it.
4. **`settingsScope` against the real binder.** The snapshot shape
   (`status/value/base/user/revision/writable/mode`) and the write methods are
   taken from `settings-contract.d.ts`. Untested: what a namespace the host has
   not registered yet returns (`unavailable` vs `loading` — both are handled),
   whether a top-level `set` accepts arrays (`allowedUsers`, `allowedCidrs`)
   and numbers, whether `unset` re-inherits the schema default, and whether
   writes need an `expectedRevision` fence. The `mutate(ops)` path is unused.
5. **The locale face.** The untyped `register(ns, locale, dict)` form is
   documented for "namespaces outside the merge table"; that the real service
   accepts an unmerged namespace such as `remote-access`, and that `zh`/`en`
   are the correct ids, is read from `LOCALE_IDS` only. Also unverified:
   whether the Plugins page re-reads `resolveSlotLabel` on a language switch
   (it subscribes to `ctx.locale` in the built bundle, but that is inference).
6. **The status payload end to end.** The producer (`lib/index.js#status()`),
   the probe (`lib/tailscale.js`) and the routes (`lib/routes.js`) now exist and
   their field names were checked against this bundle by reading them — but no
   real browser has ever fetched this payload, so nothing about the live
   rendering is observed.
7. **The action endpoint end to end.** `lib/routes.js` implements exactly the
   contract above; no live `POST` has been made through a browser (the header,
   the CORS/preflight behaviour, and the 403 for a non-loopback peer are
   unverified in practice).
8. **Clipboard.** `writeClipboard` is the primitives seed face;
   `navigator.clipboard` needs a secure context (localhost/HTTPS), and the
   `document.execCommand` fallback inside primitives is not exercised by this
   bundle's own code.
9. **Styling.** Inline styles only, using `--dsw-alias-*` / `--dsw-font-*`
   variables with plain fallbacks; the variable names were read out of the
   built theme CSS. No visual check in the real GUI has been made.
10. **`props.view`** being exactly `'summary' | 'page'`, and `props` being
    plain — taken from the slot contract types.
11. **No SSE path** exists: SPEC F-UI-2 allows polling *or* SSE; this bundle
    polls. The 1500 ms period and the hidden-page pause are its own choice.
12. **No token/password rendering (F-UI-8)** is asserted in the test against a
    synthetic payload, not against a real one.

## 6. Deviations from SPEC / INTERFACES, and open questions for the lead

1. **F-UI-3 tailscale version — documentation gap, not a client gap.**
   `lib/tailscale.js` does report `version` (from `Version` in
   `tailscale status --json`) and the panel renders it, but INTERFACES §3's
   `TailscaleProbe` table does not list the field. → add `version?: string` to
   that table (B/lead) so the contract matches the code.
2. **F-AC-5 "面板能看到拒绝记录"**: the status shape only carries
   `denied: number`, with no per-identity denial records. The panel shows the
   count; per-identity records would need a new status field.
3. **F-UI-6 "最近事件"**: the host exposes no event list, so the panel keeps
   its own bounded (20) log of what it observed — phase transitions, write
   results, kick/restart results, and status-endpoint failures (each entry
   truncated to 300 chars). If the host should own that log, `status` needs an
   `events[]` field.
4. **F-CONF-3 (loader row config vs settings layer)**: the browser cannot see
   the loader row's `config`, so the panel can only report whether the *user*
   layer overrides anything. A host-side signal is required to warn about a
   value the settings layer shadows.
5. **Hybrid save model** (see §4): switches/select write immediately, text
   fields stage until Save. The built-in cards stage *everything*. This is a
   deliberate UX choice for a master switch — needs sign-off.
6. ~~**`locale:` is deliberately not declared** …~~ **Superseded by the lead
   verification below**: `locale` and `settingsScope` must be declared in
   `exports.inject`, because the client runtime *rejects* reads of undeclared
   services rather than handing back `undefined`.
7. **Extra export** `exports.__remoteAccessDiagnostics` is not part of the
   cordis plugin contract (extra keys are ignored by the loader). It exists so
   the test — and a human asking "why is my card missing?" — has an answer.
8. **The action route is still undocumented in INTERFACES** (§5 freezes
   `PluginStatus` but not `/remote-access/action` or its header; F-OBS-5 only
   says "host 侧注册 `/remote-access/*` JSON 接口"). It is implemented in
   `lib/routes.js` — freeze it there so the client contract has one home.

## Lead verification addendum (2026-09-19, live 0.1.6-alpha.2)

Verified against the running alpha (bundle rev `78bd9938b0fe`) with a headless
Chromium and a minted browser cookie:

- ✅ The card registers into `plugins.item` and appears in the sidebar's
  **插件** page (副标题"添加和管理插件") under the **官方** group, labelled
  **远程访问**, with the package description as its summary. It is *not* under
  Settings → 内置插件 — that page is the read-only plugin inventory.
- ✅ Opening it renders the whole page: 运行状态（已停止 · Tailscale（默认）·
  每 2 秒自动刷新）, 入口 URL, 本机地址 + 复制, 重启隧道, 配置（总开关 / 模式 /
  本地代理端口 / 会话有效期 / tailscale 使用 HTTPS / tailnet 身份白名单 /
  来源 IP 白名单 / cloudflared 路径 / 写审计日志 / 启用受保护状态页 /
  保存 · 放弃修改）, 已连接客户端, 最近事件.
- ✅ `GET /remote-access/status.json` is polled on a ~2s cadence; zero console
  errors or page errors.
- 🐞 **Bug found and fixed**: `exports.inject` was `['slots']` while the card
  also reads `settingsScope` and `locale`. The runtime guard rejected those
  reads, so the card opened **without the 配置 section** — no master switch and
  no settings at all. Fixed to `['slots', 'settingsScope', 'locale']` (comment
  at the export).
- Still unverified: the write path (toggle/select + Save round-trip), kick,
  language switching, mobile/narrow layout, and the card's rendering of a host
  error state.

## Contract change: the card no longer uses `settingsScope` (lead, 2026-09-20)

DSH decides settings persistence from the page authority
(`isLoopback` = `localhost` / `[::1]` / `127.0.0.0/8`) and runs the describe
mirror in `memory` mode on any other origin — where `ensure()`/`load()` return
early and `enqueue()` drops writes while resolving successfully. A phone opening
the GUI over a tunnel is exactly that case, so the card would have rendered
defaults and lost every change (silently).

The card therefore reads and writes through the plugin's own host route:

- **read**: `GET /remote-access/status.json` → `config` (the Host's effective
  section, secret-free: `passwordSet` instead of the password, plus
  `configOverridden`). `useStatus(scope)` folds each payload into the config
  source *before* the render that consumes it.
- **write**: `POST /remote-access/action` → `{action:'set',patch}`,
  `{action:'unset',fields}`, `{action:'reset'}`. Validation failures answer
  **400 + code**, never 500.
- `bindScope()` now returns that source (`diagnostics.scope = 'host-api'`); it
  keeps the snapshot shape the field renderers already consumed
  (`{status, writable, value, user, mode, revision}`), so nothing else changed.
- No settings scope is bound any more: `exports.inject` stays
  `['slots','settingsScope','locale']` because the service is still declared for
  compositions that provide it, but the card never touches it.

Consequence: the card behaves identically on loopback and remote pages, which is
the whole point — the Host section remains the single source of truth.
