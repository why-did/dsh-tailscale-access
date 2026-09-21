/**
 * dsh-tailscale-access — browser half (client bundle).
 *
 * Hand-written, no bundler and no build step: this file is a classic script
 * that only registers a lazy CJS factory with the dsh client module system
 * (`window.__ModuleLoader__.load({ id, factory })`). Every side effect —
 * including the slot registration — happens when the factory is materialized,
 * never at script execution.
 *
 * The card it contributes:
 *   - target slot `plugins.item`, id `remote-access`, order 50, bilingual label;
 *   - configuration writes ride `ctx.settingsScope.bind({ namespace: 'remote-access' })`
 *     (snapshot + subscribe, no local fork of the document);
 *   - runtime state is polled from `GET /remote-access/status.json` (relative
 *     path, 1.5s) and actions are posted to `POST /remote-access/action`;
 *   - every fetch failure is swallowed and rendered as "not connected";
 *   - every dependency beyond `react` / `react/jsx-runtime` is probed, never
 *     assumed: a missing module degrades the card instead of failing the
 *     settings page.
 *
 * Contract notes (see ./README.md for the full list of module faces and the
 * parts that are unverified against a real host):
 *   - the bundle id MUST equal the package name declared in package.json,
 *     because the host serves this file as `/plugins/<package name>/client.js`
 *     and the loader registers factories under that id;
 *   - `react` and `react/jsx-runtime` are platform seed words of the web shell
 *     (verified in the dsh web frontend boot manifest), so requiring them can
 *     never miss the module table.
 */

window.__ModuleLoader__.load({
	id: 'dsh-tailscale-access',
	factory: (require) => {
		'use strict'
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		/* ────────────────────────────── dependencies ────────────────────────────── */

		// Platform seed words: always resolvable, no graph arrival needed.
		var React = require('react')
		var jsxRuntime = require('react/jsx-runtime')
		var jsx = jsxRuntime.jsx
		var jsxs = jsxRuntime.jsxs

		/**
		 * Optional module faces. Each one is probed, never assumed: a missing
		 * module is recorded and the card renders a "missing dependency" notice
		 * instead of taking the settings page down with it.
		 */
		var OPTIONAL_MODULES = ['@deepseek-ai/dsh-client-ui-primitives']
		var missingModules = []
		var primitives = null
		for (var optionalIndex = 0; optionalIndex < OPTIONAL_MODULES.length; optionalIndex++) {
			try {
				primitives = require(OPTIONAL_MODULES[optionalIndex])
			} catch (error) {
				missingModules.push(OPTIONAL_MODULES[optionalIndex])
			}
		}
		var writeClipboard = primitives !== null && typeof primitives.writeClipboard === 'function'
			? primitives.writeClipboard
			: null

		/* ─────────────────────────────── constants ─────────────────────────────── */

		/** Bundle id; must equal the package name in package.json. */
		var PLUGIN_ID = 'dsh-tailscale-access'
		/** Card id inside the 0.1.6 `plugins.item` slot. */
		var CARD_ID = 'remote-access'
		/** Card position inside the 0.1.6 `plugins.item` slot. */
		var CARD_ORDER = 50
		/**
		 * The 0.1.5-rc.2 card slot, keyed by the settings namespace it edits.
		 * `next` renders this one; 0.1.6 replaced it with `plugins.item`. Both are
		 * registered so one build of this bundle serves both channels — neither page
		 * renders the other's slot, so there is no double card.
		 */
		var LEGACY_CARD_SLOT = 'settings.plugin.item'
		/** Settings namespace owned by the host half. */
		var NS = 'remote-access'
		/** Relative status endpoint (never absolute: the panel is served by dsh itself). */
		var STATUS_PATH = '/remote-access/status.json'
		/** Relative action endpoint. */
		var ACTION_PATH = '/remote-access/action'
		/** Header the action endpoint requires in addition to the JSON content type. */
		var ACTION_HEADER = 'x-remote-access-action'
		/**
		 * One-time operator setup. On Linux only root may write the serve config,
		 * so a non-operator user hits "Access denied: serve config denied" — the
		 * most common first-run failure, hence the visible prerequisite note.
		 */
		var OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER'
		/** Host route delivering the redacted settings document to a remote page. */
		var HOST_SETTINGS_PATH = '/remote-access/host-settings.json'
		/** Poll period; the spec asks for 1–2s. */
		var POLL_INTERVAL_MS = 1500
		/** Bounded local event log length. */
		var MAX_EVENTS = 20

		/* ───────────────────────────── tiny utilities ──────────────────────────── */

		/**
		 * Read one service off a cordis context without ever throwing.
		 * @param ctx - the plugin context (may be undefined in a broken host).
		 * @param name - service property name.
		 * @returns the service, or null when it is absent or inactive.
		 */
		function tryGetService(ctx, name) {
			if (ctx === undefined || ctx === null) return null
			try {
				var value = ctx[name]
				return value === undefined || value === null ? null : value
			} catch (error) {
				return null
			}
		}

		/**
		 * Human-readable message for anything thrown or rejected.
		 * @param error - the failure value.
		 * @returns a short message.
		 */
		function messageOf(error) {
			if (error === undefined || error === null) return 'unknown error'
			if (typeof error === 'string') return error
			if (typeof error.message === 'string' && error.message.length > 0) return error.message
			return String(error)
		}

		/** Whether the page is currently visible (polling pauses while hidden). */
		function isVisible() {
			var doc = typeof document !== 'undefined' ? document : null
			if (doc === null || doc === undefined) return true
			return doc.visibilityState !== 'hidden'
		}

		/** Absolute timestamp for a tooltip; empty when the value is not a number. */
		function absoluteTime(at) {
			if (typeof at !== 'number' || !isFinite(at) || at <= 0) return ''
			try {
				return new Date(at).toLocaleString()
			} catch (error) {
				return ''
			}
		}

		/**
		 * Relative "3 分钟前" style text.
		 * @param t - translate function.
		 * @param at - epoch milliseconds.
		 * @returns the relative text, or an em dash when unknown.
		 */
		function relativeText(t, at) {
			if (typeof at !== 'number' || !isFinite(at) || at <= 0) return '—'
			var delta = Date.now() - at
			if (delta < 0) delta = 0
			if (delta < 60 * 1000) return t('justNow')
			if (delta < 60 * 60 * 1000) return t('minutesAgo', { n: Math.floor(delta / 60000) })
			if (delta < 24 * 60 * 60 * 1000) return t('hoursAgo', { n: Math.floor(delta / 3600000) })
			return t('daysAgo', { n: Math.floor(delta / 86400000) })
		}

		/**
		 * Split a textarea into a trimmed string list (newline or comma separated).
		 * @param text - the draft text.
		 * @returns the list, empty when nothing but separators was typed.
		 */
		function splitList(text) {
			if (typeof text !== 'string') return []
			return text.split(/[\s,]+/).map(function (item) { return item.trim() }).filter(function (item) { return item.length > 0 })
		}

		/**
		 * Render a string list as textarea text.
		 * @param value - the stored value.
		 * @returns one entry per line.
		 */
		function joinList(value) {
			if (!Array.isArray(value)) return ''
			return value.filter(function (item) { return typeof item === 'string' }).join('\n')
		}

		/**
		 * Parse a positive integer draft.
		 * @param text - the draft text.
		 * @returns `{ empty }`, `{ value }`, or `{ invalid }`.
		 */
		function parseInteger(text) {
			var trimmed = typeof text === 'string' ? text.trim() : ''
			if (trimmed === '') return { empty: true }
			var parsed = Number(trimmed)
			if (!isFinite(parsed) || Math.floor(parsed) !== parsed || parsed <= 0) return { invalid: true }
			return { value: parsed }
		}

		/**
		 * Copy text, preferring the primitives face and degrading to the plain
		 * clipboard APIs (and finally to a boolean false — never a throw).
		 * @param text - the exact text to place on the clipboard.
		 * @returns whether the host accepted the write.
		 */
		function copyText(text) {
			if (writeClipboard !== null) {
				try {
					return Promise.resolve(writeClipboard(text)).then(function (ok) { return ok === true }, function () { return false })
				} catch (error) {
					// fall through to the built-in path
				}
			}
			var nav = typeof navigator !== 'undefined' ? navigator : null
			if (nav !== null && nav.clipboard !== undefined && typeof nav.clipboard.writeText === 'function') {
				try {
					return Promise.resolve(nav.clipboard.writeText(text)).then(function () { return true }, function () { return false })
				} catch (error) {
					return Promise.resolve(false)
				}
			}
			return Promise.resolve(false)
		}

		/* ──────────────────────────────── element ──────────────────────────────── */

		/**
		 * Small element helper over the automatic JSX runtime, so this file stays
		 * readable without a build step. A `key` prop is routed to the runtime's
		 * third argument (React's `jsx`/`jsxs` key channel).
		 * @param type - element type or component.
		 * @param props - props object (may be null).
		 * @param ...children - child nodes.
		 * @returns a React element.
		 */
		function h(type, props) {
			var next = {}
			var key
			if (props !== undefined && props !== null) {
				for (var name in props) {
					if (!Object.prototype.hasOwnProperty.call(props, name)) continue
					if (name === 'key') { key = props[name]; continue }
					next[name] = props[name]
				}
			}
			var children = []
			for (var index = 2; index < arguments.length; index++) children.push(arguments[index])
			if (children.length === 1) next.children = children[0]
			else if (children.length > 1) next.children = children
			return children.length > 1 ? jsxs(type, next, key) : jsx(type, next, key)
		}

		/** Shared inline styles. Values fall back to plain colors when the theme vars are absent. */
		var S = {
			root: {
				display: 'flex', flexDirection: 'column', gap: '14px',
				fontSize: '13px', lineHeight: 1.6,
				color: 'var(--dsw-alias-label-primary, #1f1f1f)',
			},
			section: {
				display: 'flex', flexDirection: 'column', gap: '10px',
				border: '0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
				borderRadius: '10px', padding: '12px 14px',
				background: 'var(--dsw-alias-bg-layer-3, transparent)',
			},
			sectionTitle: {
				fontSize: '12px', fontWeight: 600, letterSpacing: '.02em',
				color: 'var(--dsw-alias-label-secondary, #666)', margin: 0,
			},
			row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			spread: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between', flexWrap: 'wrap' },
			muted: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
			secondary: { color: 'var(--dsw-alias-label-secondary, #666)' },
			mono: {
				fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
				fontSize: '12px',
				background: 'var(--dsw-alias-markdown-inline-code, rgba(127,127,127,.14))',
				borderRadius: '6px', padding: '2px 6px', wordBreak: 'break-all',
			},
			command: {
				display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
				background: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,.12))',
				borderRadius: '8px', padding: '8px 10px',
			},
			label: { display: 'flex', flexDirection: 'column', gap: '4px' },
			labelText: { fontWeight: 500 },
			hint: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: '12px' },
			input: {
				height: '30px', minWidth: '120px', borderRadius: '8px', padding: '0 10px',
				font: 'inherit', color: 'inherit',
				border: '0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.2))',
				background: 'var(--dsw-alias-bg-layer-2, transparent)',
			},
			textarea: {
				minHeight: '58px', borderRadius: '8px', padding: '6px 10px',
				font: 'inherit', color: 'inherit', resize: 'vertical',
				border: '0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.2))',
				background: 'var(--dsw-alias-bg-layer-2, transparent)',
			},
			select: {
				height: '30px', borderRadius: '8px', padding: '0 8px',
				font: 'inherit', color: 'inherit',
				border: '0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.2))',
				background: 'var(--dsw-alias-bg-layer-2, transparent)',
			},
			button: {
				font: 'inherit', fontSize: '12px', cursor: 'pointer',
				borderRadius: '8px', padding: '4px 10px',
				border: '0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.2))',
				background: 'var(--dsw-alias-bg-layer-2, transparent)',
				color: 'inherit',
			},
			buttonDanger: {
				font: 'inherit', fontSize: '12px', cursor: 'pointer',
				borderRadius: '8px', padding: '4px 10px',
				border: '0.5px solid var(--dsw-alias-state-error-primary, #d33)',
				background: 'transparent',
				color: 'var(--dsw-alias-state-error-primary, #d33)',
			},
			buttonPrimary: {
				font: 'inherit', fontSize: '12px', cursor: 'pointer',
				borderRadius: '8px', padding: '4px 12px',
				border: '0.5px solid var(--dsw-alias-brand-primary, #4d6bfe)',
				background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
				color: 'var(--dsw-alias-label-primary-foreground, #fff)',
			},
			notice: {
				borderRadius: '8px', padding: '8px 10px', fontSize: '12px',
				border: '0.5px solid var(--dsw-alias-state-warn-primary, #d99)',
				color: 'var(--dsw-alias-state-warn-label, #8a5a00)',
			},
			errorBox: {
				borderRadius: '8px', padding: '8px 10px', fontSize: '12px',
				border: '0.5px solid var(--dsw-alias-state-error-primary, #d33)',
				color: 'var(--dsw-alias-state-error-primary, #d33)',
				display: 'flex', flexDirection: 'column', gap: '6px',
			},
			table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
			th: {
				textAlign: 'left', fontWeight: 600, padding: '4px 8px 4px 0',
				color: 'var(--dsw-alias-label-secondary, #666)',
				borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
				whiteSpace: 'nowrap',
			},
			td: {
				padding: '5px 8px 5px 0', verticalAlign: 'top',
				borderBottom: '0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
			},
			dot: {
				width: '8px', height: '8px', borderRadius: '50%', flex: 'none',
				display: 'inline-block',
			},
			check: { display: 'flex', alignItems: 'center', gap: '8px' },
			events: {
				margin: 0, padding: 0, listStyle: 'none',
				display: 'flex', flexDirection: 'column', gap: '4px',
				maxHeight: '150px', overflowY: 'auto', fontSize: '12px',
			},
		}

		/** Status-dot colors per phase. */
		var PHASE_COLOR = {
			running: 'var(--dsw-alias-state-success-primary, #2f9e44)',
			starting: 'var(--dsw-alias-state-warn-primary, #e8a33d)',
			stopped: 'var(--dsw-alias-label-dimmed, #9aa0a6)',
			error: 'var(--dsw-alias-state-error-primary, #d33)',
			unknown: 'var(--dsw-alias-label-dimmed, #9aa0a6)',
		}

		/** Dictionary keys of one phase. */
		var PHASE_KEY = {
			running: 'phaseRunning',
			starting: 'phaseStarting',
			stopped: 'phaseStopped',
			error: 'phaseError',
			unknown: 'phaseUnknown',
		}

		/** Dictionary keys of one mode. */
		var MODE_KEY = {
			none: 'modeNone',
			tailscale: 'modeTailscale',
			quick: 'modeQuick',
		}

		/* ───────────────────────────────── locale ──────────────────────────────── */

		/** Bilingual dictionary owned by this bundle. */
		var DICT = {
			zh: {
				title: '远程访问',
				configTitle: '配置',
				summary: '用手机或其它电脑通过浏览器访问这台机器上的 harness：无需公网 IP、无需端口映射，dsh 自身仍只监听 127.0.0.1。',
				enabled: '总开关',
				enabledHint: '打开后每次 harness 启动会自动恢复入口；关闭会立即拆除隧道并清理会话。',
				mode: '模式',
				modeNone: '仅本机（调试）',
				modeTailscale: 'Tailscale（默认）',
				modeQuick: 'Cloudflare Quick Tunnel',
				quickWarning: '此入口可执行命令：quick 模式会暴露到公网，任何拿到 URL 的人都能访问。',
				quickTesting: 'quick 模式仍在测试中，暂不在本面板提供；如需试用，请直接编辑设置段里的 mode。',
				acknowledgeRisk: '我已了解风险，允许启用 quick 模式',
				port: '本地代理端口',
				allowedUsers: 'tailnet 身份白名单',
				allowedUsersHint: '每行一个 login 或 login@domain；留空表示只允许本机所属用户（不会放行所有人）。',
				allowedCidrs: '来源 IP 白名单（quick / none）',
				allowedCidrsHint: '每行一个 CIDR，例如 203.0.113.7/32；留空表示不限制来源。',
				sessionHours: '会话有效期（小时）',
				cloudflaredPath: 'cloudflared 路径',
				cloudflaredPathHint: '留空则自动查找或下载。',
				audit: '写审计日志',
				statusPage: '启用受保护状态页',
				save: '保存',
				discard: '放弃修改',
				saving: '保存中…',
				saveFailed: '保存失败：{message}',
				unsaved: '有未保存的修改',
				invalidField: '取值不合法',
				overridden: '已覆盖默认值',
				defaultsOnly: '当前全部为默认值',
				scopeUnavailable: '配置服务（settingsScope）不可用，面板以只读状态运行。',
				scopeLoading: '正在读取配置…',
				readOnly: '当前配置文档只读，无法写入。',
				runtime: '运行状态',
				phaseStopped: '已停止',
				phaseStarting: '启动中',
				phaseRunning: '运行中',
				phaseError: '失败',
				phaseUnknown: '未连接',
				unreachable: '未连接：host 侧接口不可用（{message}）',
				updatedAt: '更新于 {time}',
				polling: '每 {seconds} 秒自动刷新',
				url: '入口 URL',
				localUrl: '本机地址',
				copy: '复制',
				copied: '已复制',
				copyFailed: '复制失败',
				open: '打开',
				noUrl: '暂无入口 URL（未启用或隧道尚未建立）',
				tailscale: 'Tailscale',
				tsInstalled: 'tailscale 已安装',
				tsNotInstalled: 'tailscale 未安装',
				tsRunning: 'tailscaled 运行中',
				tsNotRunning: 'tailscaled 未运行',
				tsLoggedIn: '已登录',
				tsNotLoggedIn: '未登录',
				tsVersion: '版本',
				tsBackendState: 'BackendState',
				tsMachine: '机器名',
				tsTailnet: 'Tailnet',
				tsMagicDns: 'MagicDNS 后缀',
				tsIps: 'Tailscale IP',
				tsAbsent: 'host 尚未上报 tailscale 信息。',
				tsNotOperatorBroken: '当前用户不是 tailscale operator（无法配置 serve）',
				hostSettingsTitle: '远端页面：读取宿主设置',
				hostSettingsBody: 'DSH 不会把设置文档发给非本机页面，所以这里的设置项显示的是默认值。点下面的按钮，用本插件自己的通道读取宿主设置，并把语言/外观应用到当前页面。',
				hostSettingsButton: '读取宿主设置并应用',
				hostSettingsLoading: '读取中…',
				hostSettingsRead: '宿主设置：语言={locale}，外观={theme}，字号={fontSize}',
				hostSettingsApplied: '已应用到本页：{list}',
				hostSettingsFailed: '部分未应用：{list}',
				hostSettingsError: '读取失败：{message}',
				tsOperatorOk: '当前用户是 tailscale operator（可以配置 serve）',
				prereqTitle: 'tailscale 模式的前置条件',
				prereqBody: '① tailscale 已安装并登录；② tailnet 已开启 HTTPS 证书（入口只走 HTTPS：没有证书时无法启用，会提示去 admin console → DNS 打开）；③ 当前用户已设为 tailscale operator —— 否则没有权限配置 serve，打开开关会报 “Access denied: serve config denied”。',
				prereqCommandLabel: '设置 operator（一次即可，之后无需 sudo）：',
				unknown: '未知',
				fixCommand: '修复命令',
				lastError: '最近错误',
				hint: '提示',
				code: '错误码',
				denied: '已拒绝请求',
				clients: '已连接客户端',
				clientsEmpty: '暂无客户端连接。',
				colWho: '身份 / IP',
				colSince: '登录时间',
				colLastSeen: '最后活跃',
				colWs: 'WebSocket',
				colRequests: '请求',
				colActions: '操作',
				kindIdentity: 'tailnet 身份',
				online: '在线',
				offline: '离线',
				kindIp: 'IP',
				wsOn: '挂着 {n} 条',
				wsOff: '无',
				kick: '踢掉',
				kickConfirm: '确认踢掉？',
				kicked: '已踢掉 {count} 个连接',
				kickFailed: '踢掉失败：{message}',
				restart: '重启隧道',
				restarting: '重启中…',
				restarted: '隧道已重启',
				restartFailed: '重启失败：{message}',
				events: '最近事件',
				eventsEmpty: '暂无事件。',
				eventPhase: '运行状态变为「{phase}」',
				eventUnreachable: '状态接口不可用：{message}',
				eventKick: '踢掉 {who}：{result}',
				eventRestart: '重启隧道：{result}',
				eventWrite: '配置写入 {field}',
				eventWriteFailed: '配置写入 {field} 失败：{message}',
				missingDeps: '缺少依赖：{ids}（面板以降级模式运行）',
				justNow: '刚刚',
				minutesAgo: '{n} 分钟前',
				hoursAgo: '{n} 小时前',
				daysAgo: '{n} 天前',
				never: '从未',
				noUserAgent: '未上报',
			},
			en: {
				title: 'Remote Access',
				configTitle: 'Configuration',
				summary: 'Reach this machine\'s harness from a phone or another computer in a browser: no public IP, no port forwarding, and dsh itself keeps listening on 127.0.0.1 only.',
				enabled: 'Enabled',
				enabledHint: 'When on, the entry point is restored on every harness start; turning it off tears the tunnel down and clears sessions immediately.',
				mode: 'Mode',
				modeNone: 'Local only (debug)',
				modeTailscale: 'Tailscale (default)',
				modeQuick: 'Cloudflare Quick Tunnel',
				quickWarning: 'This entry point can run commands: quick mode is exposed to the public internet and anyone holding the URL can reach it.',
				quickTesting: 'quick mode is still being tested and is not offered here yet; to try it, set mode directly in the settings section.',
				acknowledgeRisk: 'I understand the risk and allow quick mode',
				port: 'Local proxy port',
				allowedUsers: 'tailnet identity allowlist',
				allowedUsersHint: 'One login or login@domain per line; empty allows only the user this machine belongs to (never everyone).',
				allowedCidrs: 'Source IP allowlist (quick / none)',
				allowedCidrsHint: 'One CIDR per line, e.g. 203.0.113.7/32; empty means any source.',
				sessionHours: 'Session lifetime (hours)',
				cloudflaredPath: 'cloudflared path',
				cloudflaredPathHint: 'Empty discovers or downloads the binary automatically.',
				audit: 'Write an audit log',
				statusPage: 'Serve the protected status page',
				save: 'Save',
				discard: 'Discard',
				saving: 'Saving…',
				saveFailed: 'Save failed: {message}',
				unsaved: 'Unsaved changes',
				invalidField: 'Invalid value',
				overridden: 'Overrides the default',
				defaultsOnly: 'Everything is at its default',
				scopeUnavailable: 'The settings service (settingsScope) is unavailable; the panel runs read-only.',
				scopeLoading: 'Reading settings…',
				readOnly: 'The settings document is read-only for this client.',
				runtime: 'Runtime',
				phaseStopped: 'Stopped',
				phaseStarting: 'Starting',
				phaseRunning: 'Running',
				phaseError: 'Failed',
				phaseUnknown: 'Not connected',
				unreachable: 'Not connected: the host endpoints are unavailable ({message})',
				updatedAt: 'Updated {time}',
				polling: 'Refreshes every {seconds}s',
				url: 'Entry URL',
				localUrl: 'Local address',
				copy: 'Copy',
				copied: 'Copied',
				copyFailed: 'Copy failed',
				open: 'Open',
				noUrl: 'No entry URL yet (disabled, or the tunnel is not up)',
				tailscale: 'Tailscale',
				tsInstalled: 'tailscale installed',
				tsNotInstalled: 'tailscale not installed',
				tsRunning: 'tailscaled running',
				tsNotRunning: 'tailscaled not running',
				tsLoggedIn: 'Logged in',
				tsNotLoggedIn: 'Needs login',
				tsVersion: 'Version',
				tsBackendState: 'BackendState',
				tsMachine: 'Machine',
				tsTailnet: 'Tailnet',
				tsMagicDns: 'MagicDNS suffix',
				tsIps: 'Tailscale IPs',
				tsAbsent: 'The host has not reported tailscale information yet.',
				tsNotOperatorBroken: 'This user is not the tailscale operator (cannot configure serve)',
				hostSettingsTitle: 'Remote page: load host settings',
				hostSettingsBody: 'DSH does not hand the settings document to a non-loopback page, so the fields here show defaults. The button below reads them over this plugin\'s own route and applies language and appearance to this page.',
				hostSettingsButton: 'Load host settings and apply',
				hostSettingsLoading: 'Loading…',
				hostSettingsRead: 'Host settings: language={locale}, appearance={theme}, font size={fontSize}',
				hostSettingsApplied: 'Applied to this page: {list}',
				hostSettingsFailed: 'Not applied: {list}',
				hostSettingsError: 'Load failed: {message}',
				tsOperatorOk: 'This user is the tailscale operator (can configure serve)',
				prereqTitle: 'Prerequisites for tailscale mode',
				prereqBody: '① tailscale installed and logged in; ② HTTPS certificates enabled for the tailnet (the entry is HTTPS-only: without them it cannot start and the host points you at admin console → DNS); ③ this user set as the tailscale operator — otherwise serve cannot be configured and enabling the switch fails with “Access denied: serve config denied”.',
				prereqCommandLabel: 'Set the operator once (no sudo afterwards):',
				unknown: 'unknown',
				fixCommand: 'Fix command',
				lastError: 'Last error',
				hint: 'Hint',
				code: 'Code',
				denied: 'Denied requests',
				clients: 'Connected clients',
				clientsEmpty: 'No clients connected.',
				colWho: 'Identity / IP',
				colSince: 'Since',
				colLastSeen: 'Last seen',
				colWs: 'WebSocket',
				colRequests: 'Requests',
				colActions: '',
				kindIdentity: 'tailnet identity',
				online: 'online',
				offline: 'offline',
				kindIp: 'IP',
				wsOn: '{n} open',
				wsOff: 'none',
				kick: 'Kick',
				kickConfirm: 'Confirm kick?',
				kicked: 'Kicked {count} connection(s)',
				kickFailed: 'Kick failed: {message}',
				restart: 'Restart tunnel',
				restarting: 'Restarting…',
				restarted: 'Tunnel restarted',
				restartFailed: 'Restart failed: {message}',
				events: 'Recent events',
				eventsEmpty: 'No events yet.',
				eventPhase: 'Runtime state is now "{phase}"',
				eventUnreachable: 'Status endpoint unavailable: {message}',
				eventKick: 'Kick {who}: {result}',
				eventRestart: 'Restart tunnel: {result}',
				eventWrite: 'Settings written: {field}',
				eventWriteFailed: 'Settings write for {field} failed: {message}',
				missingDeps: 'Missing dependencies: {ids} (the panel runs in degraded mode)',
				justNow: 'just now',
				minutesAgo: '{n} min ago',
				hoursAgo: '{n} h ago',
				daysAgo: '{n} d ago',
				never: 'never',
				noUserAgent: 'not reported',
			},
		}

		/**
		 * Static repair commands shown when the host reports no command of its own.
		 * `notRunning` is deliberately platform-neutral: starting the daemon differs
		 * per OS (systemd / brew services / Windows service), and only the host knows
		 * which one applies — it always sends the right command with the error.
		 */
		var FALLBACK_COMMANDS = {
			notInstalled: 'curl -fsSL https://tailscale.com/install.sh | sh',
			notRunning: 'tailscale up',
			needsLogin: 'tailscale up',
			serveReset: 'tailscale serve reset',
			certs: 'https://login.tailscale.com/admin/dns',
		}

		/**
		 * Active locale id, read off the locale face when one is installed.
		 * @param face - the locale service, or null.
		 * @returns a BCP 47-ish id; 'en' when nothing can be determined.
		 */
		function activeLocale(face) {
			if (face !== null) {
				try {
					var snapshot = typeof face.getSnapshot === 'function' ? face.getSnapshot() : null
					if (snapshot !== null && typeof snapshot.active === 'string' && snapshot.active.length > 0) return snapshot.active
				} catch (error) {
					// fall through to the browser hint
				}
			}
			var nav = typeof navigator !== 'undefined' ? navigator : null
			var hint = nav !== null && typeof nav.language === 'string' ? nav.language : ''
			return hint.slice(0, 2).toLowerCase() === 'zh' ? 'zh' : 'en'
		}

		/**
		 * Replace `{name}` placeholders the way the locale service does.
		 * @param template - the dictionary entry.
		 * @param params - replacement values.
		 * @returns the rendered text.
		 */
		function fill(template, params) {
			if (params === undefined || params === null) return template
			return template.replace(/\{(\w+)\}/g, function (match, name) {
				return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
			})
		}

		/**
		 * Build a translate function for this bundle's namespace.
		 *
		 * The registration deliberately does NOT declare `locale:` — that seat
		 * makes the renderer require an installed locale face and fail loud
		 * without one. This bundle resolves the same face defensively and falls
		 * back to its own dictionary, so the card survives a host without the
		 * locale plugin.
		 *
		 * @param face - the locale service, or null.
		 * @returns a `(key, params) => string` translate function.
		 */
		function makeTranslate(face) {
			return function t(key, params) {
				var dict = DICT[activeLocale(face)] !== undefined ? DICT[activeLocale(face)] : DICT.en
				if (face !== null && typeof face.bind === 'function') {
					try {
						var bound = face.bind(NS)
						var text = bound(key, params)
						// The locale service answers with the key itself on a miss.
						if (typeof text === 'string' && text !== key) return text
					} catch (error) {
						// fall through to the bundled dictionary
					}
				}
				var template = dict[key] !== undefined ? dict[key] : (DICT.en[key] !== undefined ? DICT.en[key] : key)
				return fill(template, params)
			}
		}

		/* ──────────────────────────── settings scope ───────────────────────────── */

		/** The shape the card renders when no scope is bound. */
		var UNAVAILABLE_SCOPE = Object.freeze({
			available: false,
			writable: false,
			value: Object.freeze({}),
			user: null,
			status: 'unavailable',
			mode: 'memory',
			revision: undefined,
		})

		/**
		 * Project one settings-scope snapshot into what the card reads, never throwing.
		 * @param scope - the bound scope, or null.
		 * @returns the projection.
		 */
		function readScope(scope) {
			if (scope === null || typeof scope.getSnapshot !== 'function') return UNAVAILABLE_SCOPE
			var snapshot
			try {
				snapshot = scope.getSnapshot()
			} catch (error) {
				return UNAVAILABLE_SCOPE
			}
			if (snapshot === null || typeof snapshot !== 'object') return UNAVAILABLE_SCOPE
			return {
				available: snapshot.status === 'ready',
				writable: snapshot.writable === true,
				value: snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {},
				user: snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : null,
				status: typeof snapshot.status === 'string' ? snapshot.status : 'unavailable',
				mode: typeof snapshot.mode === 'string' ? snapshot.mode : 'memory',
				revision: snapshot.revision,
			}
		}

		/**
		 * Read one namespace field's effective value.
		 * @param snapshot - the scope projection.
		 * @param field - field name.
		 * @returns the value, or undefined.
		 */
		function fieldOf(snapshot, field) {
			return snapshot.value === undefined ? undefined : snapshot.value[field]
		}

		/**
		 * Whether this page is served from a loopback authority.
		 *
		 * DSH hands the settings document only to loopback pages (its
		 * `ui-settings` mirror runs in `memory` mode everywhere else), so the
		 * "load host settings" affordance exists exactly where that happens.
		 * A composition without a browser location has nothing to work around.
		 * @returns true for localhost, [::1] and 127.0.0.0/8, or with no location.
		 */
		function isLoopbackPage() {
			if (typeof location === 'undefined' || location === null || typeof location.hostname !== 'string') return true
			var host = location.hostname
			if (host === 'localhost' || host === '[::1]') return true
			var parts = host.split('.')
			return parts.length === 4 && parts[0] === '127'
				&& parts.every(function (part) { return /^\d{1,3}$/.test(part) && Number(part) <= 255 })
		}

		/** Read the Host settings document over the plugin's own route. */
		function fetchHostSettings() {
			if (typeof fetch !== 'function') return Promise.reject(new Error('fetch is unavailable'))
			var request
			try {
				request = fetch(HOST_SETTINGS_PATH, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' })
			} catch (error) {
				request = Promise.reject(error)
			}
			return Promise.resolve(request).then(function (response) {
				if (response === undefined || response === null) throw new Error('empty response')
				if (response.ok !== true) throw new Error('HTTP ' + String(response.status === undefined ? '?' : response.status))
				if (typeof response.json !== 'function') throw new Error('response is not JSON')
				return response.json()
			})
		}

		/**
		 * Apply the Host's page-level preferences through the client services.
		 *
		 * The document itself is what DSH withholds from a remote page, so the
		 * values are applied locally: language through `ctx.locale`, appearance
		 * through `ctx.theme`. Everything else in the document is reported but not
		 * applied — those preferences belong to their owning plugins.
		 * @param ctx - the plugin context.
		 * @param doc - the Host settings payload.
		 * @returns applied and failed summaries.
		 */
		function applyHostPreferences(ctx, doc) {
			var applied = []
			var failed = []
			var localeFace = tryGetService(ctx, 'locale')
			if (doc !== null && typeof doc === 'object' && typeof doc.locale === 'string'
				&& localeFace !== null && typeof localeFace.setLocale === 'function') {
				try { localeFace.setLocale(doc.locale); applied.push('locale=' + doc.locale) } catch (error) { failed.push('locale: ' + messageOf(error)) }
			}
			var themeFace = tryGetService(ctx, 'theme')
			var theme = doc !== null && typeof doc === 'object' && doc.theme !== null && typeof doc.theme === 'object' ? doc.theme : null
			if (theme !== null && themeFace !== null && typeof themeFace.setTheme === 'function' && typeof theme.preference === 'string') {
				try { themeFace.setTheme(theme.preference); applied.push('theme=' + theme.preference) } catch (error) { failed.push('theme: ' + messageOf(error)) }
			}
			if (theme !== null && themeFace !== null && typeof themeFace.setFontSize === 'function' && Number.isInteger(theme.fontSize)) {
				try { themeFace.setFontSize(theme.fontSize); applied.push('fontSize=' + String(theme.fontSize)) } catch (error) { failed.push('fontSize: ' + messageOf(error)) }
			}
			return { applied: applied, failed: failed }
		}

		/* ─────────────────────────────── react hooks ───────────────────────────── */

		/**
		 * Subscribe to a settings scope (snapshot + subscribe; no cached fork).
		 * @param scope - the bound scope, or null.
		 * @returns the current projection.
		 */
		function useScopeSnapshot(scope) {
			var pair = React.useState(function () { return readScope(scope) })
			var snapshot = pair[0]
			var setSnapshot = pair[1]
			React.useEffect(function () {
				setSnapshot(readScope(scope))
				if (scope === null || typeof scope.subscribe !== 'function') return undefined
				var sync = function () { setSnapshot(readScope(scope)) }
				var off
				try {
					off = scope.subscribe(sync)
				} catch (error) {
					return undefined
				}
				return function () {
					if (typeof off === 'function') {
						try { off() } catch (error) { /* the scope is already gone */ }
					}
				}
			}, [scope])
			return snapshot
		}

		/**
		 * Re-render when the active locale changes.
		 * @param ctx - the plugin context.
		 */
		function useLocaleTick(ctx) {
			var pair = React.useState(0)
			var force = pair[1]
			React.useEffect(function () {
				var face = tryGetService(ctx, 'locale')
				if (face === null || typeof face.subscribe !== 'function') return undefined
				var off
				try {
					off = face.subscribe(function () { force(function (value) { return value + 1 }) })
				} catch (error) {
					return undefined
				}
				return function () {
					if (typeof off === 'function') {
						try { off() } catch (error) { /* the locale face is already gone */ }
					}
				}
			}, [ctx])
		}

		/**
		 * Poll the host status endpoint. Every failure is contained: the card
		 * renders "not connected" instead of throwing.
		 * @returns `{ phase, data, error, fetchedAt, refresh }`.
		 */
		function useStatus(configSource) {
			var publishConfig = configSource !== null && configSource !== undefined && typeof configSource.publish === 'function'
				? configSource.publish
				: null
			var pair = React.useState(function () {
				return { phase: 'unknown', data: null, error: null, fetchedAt: 0 }
			})
			var status = pair[0]
			var setStatus = pair[1]
			var epoch = React.useRef(0)
			var controllerRef = React.useRef(null)
			var timerRef = React.useRef(null)

			var load = React.useCallback(function () {
				if (typeof fetch !== 'function') {
					setStatus(function (previous) {
						return { phase: 'error', data: previous.data, error: 'fetch is unavailable', fetchedAt: previous.fetchedAt }
					})
					return Promise.resolve()
				}
				var current = epoch.current + 1
				epoch.current = current
				var controller = typeof AbortController === 'function' ? new AbortController() : null
				controllerRef.current = controller
				var options = {
					method: 'GET',
					headers: { accept: 'application/json' },
					cache: 'no-store',
					credentials: 'same-origin',
				}
				if (controller !== null) options.signal = controller.signal
				var request
				try {
					request = fetch(STATUS_PATH, options)
				} catch (error) {
					request = Promise.reject(error)
				}
				return Promise.resolve(request).then(function (response) {
					if (response === undefined || response === null) throw new Error('empty response')
					if (response.ok !== true) throw new Error('HTTP ' + String(response.status === undefined ? '?' : response.status))
					if (typeof response.json !== 'function') throw new Error('response is not JSON')
					return response.json()
				}).then(function (data) {
					if (epoch.current !== current) return
					// Fold the Host's effective config into the card's config source before
					// the render that consumes it: no flash of defaults, and no dependence
					// on effect flushing.
					if (publishConfig !== null && data !== null && typeof data === 'object'
						&& data.config !== null && typeof data.config === 'object') {
						publishConfig(data.config)
					}
					setStatus({ phase: 'ok', data: data !== null && typeof data === 'object' ? data : {}, error: null, fetchedAt: Date.now() })
				}, function (error) {
					if (epoch.current !== current) return
					setStatus(function (previous) {
						return { phase: 'error', data: previous.data, error: messageOf(error), fetchedAt: previous.fetchedAt }
					})
				})
			}, [])

			React.useEffect(function () {
				var stopped = false
				var doc = typeof document !== 'undefined' ? document : null
				var tick = function () {
					if (stopped || !isVisible()) return
					void load()
				}
				var start = function () {
					if (stopped || timerRef.current !== null || typeof setInterval !== 'function') return
					timerRef.current = setInterval(tick, POLL_INTERVAL_MS)
				}
				var stop = function () {
					if (timerRef.current === null) return
					if (typeof clearInterval === 'function') clearInterval(timerRef.current)
					timerRef.current = null
				}
				var onVisibility = function () {
					if (isVisible()) {
						start()
						tick()
					} else {
						stop()
					}
				}
				tick()
				start()
				if (doc !== null && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility)
				return function () {
					stopped = true
					stop()
					if (doc !== null && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility)
					// Invalidate anything in flight so a late answer cannot set state on an unmounted card.
					epoch.current = epoch.current + 1
					var controller = controllerRef.current
					controllerRef.current = null
					if (controller !== null && typeof controller.abort === 'function') {
						try { controller.abort() } catch (error) { /* already settled */ }
					}
				}
			}, [load])

			return {
				phase: status.phase,
				data: status.data,
				error: status.error,
				fetchedAt: status.fetchedAt,
				refresh: load,
			}
		}

		/**
		 * Post one action to the host action endpoint. Failures are values, never throws.
		 * @param body - the action body (`{action, id?}`).
		 * @returns `{ ok, payload, error }`.
		 */
		function postAction(body) {
			if (typeof fetch !== 'function') return Promise.resolve({ ok: false, payload: null, error: 'fetch is unavailable' })
			var options = {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
				},
				cache: 'no-store',
				credentials: 'same-origin',
				body: JSON.stringify(body),
			}
			options.headers[ACTION_HEADER] = '1'
			var request
			try {
				request = fetch(ACTION_PATH, options)
			} catch (error) {
				request = Promise.reject(error)
			}
			return Promise.resolve(request).then(function (response) {
				if (response === undefined || response === null) return { ok: false, payload: null, error: 'empty response' }
				var parsed = typeof response.json === 'function'
					? Promise.resolve(response.json()).then(function (value) { return value }, function () { return null })
					: Promise.resolve(null)
				return parsed.then(function (payload) {
					var ok = response.ok === true && payload !== null && payload.ok !== false
					var reported = payload === null || payload === undefined ? null : payload.error
					var message = typeof reported === 'string'
						? reported
						: (reported !== null && typeof reported === 'object' && typeof reported.message === 'string' ? reported.message : null)
					if (message === null) message = 'HTTP ' + String(response.status === undefined ? '?' : response.status)
					return { ok: ok, payload: payload, error: ok ? null : message }
				})
			}, function (error) {
				return { ok: false, payload: null, error: messageOf(error) }
			})
		}

		/**
		 * Serialize settings writes through the bound scope, tracking pending/failed state.
		 * @param scope - the bound scope, or null.
		 * @param onWritten - called after a successful write (used to refresh status).
		 * @returns `[writeState, commit]`; `commit(field, value)` resolves to whether it landed.
		 */
		function useScopeWriter(scope, onWritten) {
			var pair = React.useState(function () { return { pending: null, failed: false, error: null, field: null } })
			var state = pair[0]
			var setState = pair[1]
			var commit = React.useCallback(function (field, value) {
				if (scope === null || typeof scope.set !== 'function') {
					setState({ pending: null, failed: true, error: 'settings scope unavailable', field: field })
					return Promise.resolve(false)
				}
				setState({ pending: field, failed: false, error: null, field: field })
				var operation
				try {
					operation = value === undefined && typeof scope.unset === 'function' ? scope.unset(field) : scope.set(field, value)
				} catch (error) {
					operation = Promise.reject(error)
				}
				return Promise.resolve(operation).then(function () {
					setState({ pending: null, failed: false, error: null, field: field })
					if (typeof onWritten === 'function') onWritten(field)
					return true
				}, function (error) {
					setState({ pending: null, failed: true, error: messageOf(error), field: field })
					return false
				})
			}, [scope, onWritten])
			return [state, commit]
		}

		/**
		 * Bounded local event log (F-UI-6). The frozen status shape carries no
		 * event list, so the panel keeps its own observations.
		 * @returns `[events, push]`.
		 */
		function useEventLog() {
			var pair = React.useState(function () { return [] })
			var events = pair[0]
			var setEvents = pair[1]
			var push = React.useCallback(function (kind, text) {
				var at = Date.now()
				setEvents(function (previous) {
					var next = [{ kind: kind, text: String(text).slice(0, 300), at: at }]
					for (var index = 0; index < previous.length && next.length < MAX_EVENTS; index++) next.push(previous[index])
					return next
				})
			}, [])
			return [events, push]
		}

		/* ────────────────────────────── small pieces ───────────────────────────── */

		/** A titled section box. */
		function Section(props) {
			return h('section', { style: S.section, 'data-ra-section': props.name },
				h('h4', { style: S.sectionTitle }, props.title),
				props.children)
		}

		/** A status dot plus label. */
		function PhaseBadge(props) {
			var t = props.t
			var phase = PHASE_KEY[props.phase] === undefined ? 'unknown' : props.phase
			return h('span', { style: S.row, 'data-ra-phase': phase },
				h('span', { style: Object.assign({}, S.dot, { background: PHASE_COLOR[phase] }) }),
				h('span', { style: { fontWeight: 600 } }, t(PHASE_KEY[phase])))
		}

		/** A copy-to-clipboard control with its own feedback. */
		function CopyButton(props) {
			var t = props.t
			var pair = React.useState('idle')
			var state = pair[0]
			var setState = pair[1]
			var timer = React.useRef(null)
			React.useEffect(function () {
				return function () {
					if (timer.current !== null && typeof clearTimeout === 'function') clearTimeout(timer.current)
					timer.current = null
				}
			}, [])
			var onClick = function () {
				void copyText(String(props.text)).then(function (ok) {
					setState(ok ? 'copied' : 'failed')
					if (timer.current !== null && typeof clearTimeout === 'function') clearTimeout(timer.current)
					if (typeof setTimeout === 'function') {
						timer.current = setTimeout(function () { setState('idle') }, 1500)
					}
				})
			}
			var label = state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : (props.label === undefined ? t('copy') : props.label)
			return h('button', {
				type: 'button',
				style: S.button,
				onClick: onClick,
				'data-ra-copy': props.what,
			}, label)
		}

		/** One labelled control with an optional hint. */
		function Field(props) {
			return h('label', { style: S.label, 'data-ra-field': props.field },
				h('span', { style: S.labelText }, props.label),
				props.children,
				props.hint === undefined ? null : h('span', { style: S.hint }, props.hint))
		}

		/**
		 * A preflight check row: state, explanation, and a copyable repair command.
		 */
		function CheckRow(props) {
			var t = props.t
			return h('div', { style: S.row, 'data-ra-check': props.name },
				h('span', { style: Object.assign({}, S.dot, { background: props.ok ? PHASE_COLOR.running : PHASE_COLOR.error }) }),
				h('span', null, props.label),
				props.ok || props.hint === undefined ? null : h('span', { style: S.hint }, props.hint),
				props.ok || props.command === undefined || props.command === '' ? null : h('span', { style: S.command },
					h('code', { style: S.mono }, props.command),
					h(CopyButton, { t: t, text: props.command, what: 'command' })))
		}

		/* ─────────────────────────────── sections ─────────────────────────────── */

		/** Preflight checks + runtime state + entry URL + last error (F-UI-3, F-UI-5, F-UI-6). */
		function RuntimeSection(props) {
			var t = props.t
			var status = props.status
			var data = status.data
			var tailscale = data !== null && data.tailscale !== null && typeof data.tailscale === 'object' ? data.tailscale : null
			var error = data !== null && data.lastError !== null && typeof data.lastError === 'object' ? data.lastError : null
			var probeError = tailscale !== null && tailscale.error !== null && typeof tailscale.error === 'object' ? tailscale.error : null
			var backend = tailscale !== null && typeof tailscale.backendState === 'string' ? tailscale.backendState : null
			var installed = tailscale !== null && tailscale.installed === true
			var running = tailscale !== null && tailscale.running === true
			var loggedIn = backend === 'Running'
			var url = data !== null && typeof data.url === 'string' && data.url.length > 0 ? data.url : null
			var localUrl = data !== null && typeof data.localUrl === 'string' && data.localUrl.length > 0 ? data.localUrl : null
			var self = tailscale !== null && tailscale.self !== null && typeof tailscale.self === 'object' ? tailscale.self : null
			var tailnet = tailscale !== null && tailscale.tailnet !== null && typeof tailscale.tailnet === 'object' ? tailscale.tailnet : null
			var mode = data !== null && typeof data.mode === 'string' ? data.mode : null
			// Live operator state comes from the host probe (cheap, refreshed on a TTL);
			// the last-error row below stays only as a fallback for platforms where the
			// host cannot determine it.
			var operator = tailscale !== null && tailscale.operator !== null && typeof tailscale.operator === 'object' ? tailscale.operator : null

			var urlLine = url === null
				? h('span', { style: S.muted }, t('noUrl'))
				: h('span', { style: S.row },
					h('a', { href: url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-link, #4d6bfe)' } }, url),
					h(CopyButton, { t: t, text: url, what: 'url' }))

			return h(Section, { name: 'runtime', title: t('runtime') },
				h('div', { style: S.spread },
					h('span', { style: S.row },
						h(PhaseBadge, { t: t, phase: status.phase === 'ok' && data !== null && typeof data.phase === 'string' ? data.phase : 'unknown' }),
						mode === null ? null : h('span', { style: S.secondary }, t(MODE_KEY[mode] === undefined ? 'unknown' : MODE_KEY[mode])),
						data !== null && data.denied > 0 ? h('span', { style: S.hint }, t('denied') + ': ' + String(data.denied)) : null),
					h('span', { style: S.hint },
						h('span', null, t('polling', { seconds: Math.round(POLL_INTERVAL_MS / 1000) })),
						status.fetchedAt > 0 ? h('span', null, ' · ' + t('updatedAt', { time: absoluteTime(status.fetchedAt) })) : null)),
				status.phase === 'error'
					? h('div', { style: S.notice, 'data-ra-unreachable': 'true' }, t('unreachable', { message: status.error === null ? t('unknown') : status.error }))
					: null,
				h('div', { style: S.label },
					h('span', { style: S.labelText }, t('url')),
					urlLine),
				localUrl === null ? null : h('div', { style: S.label },
					h('span', { style: S.labelText }, t('localUrl')),
					h('span', { style: S.row },
						h('code', { style: S.mono }, localUrl),
						h(CopyButton, { t: t, text: localUrl, what: 'localUrl' }))),
				tailscale === null
					? h('span', { style: S.hint }, t('tsAbsent'))
					: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' }, 'data-ra-tailscale': backend === null ? 'unknown' : backend },
						h(CheckRow, {
							t: t,
							name: 'installed',
							ok: installed,
							label: installed ? t('tsInstalled') : t('tsNotInstalled'),
							hint: probeError !== null && typeof probeError.hint === 'string' ? probeError.hint : undefined,
							command: installed ? undefined : (probeError !== null && typeof probeError.command === 'string' && probeError.command.length > 0 ? probeError.command : FALLBACK_COMMANDS.notInstalled),
						}),
						h(CheckRow, {
							t: t,
							name: 'running',
							ok: installed && running,
							label: running ? t('tsRunning') : t('tsNotRunning'),
							hint: probeError !== null && probeError.code === 'TAILSCALE_NOT_RUNNING' && typeof probeError.hint === 'string' ? probeError.hint : undefined,
							command: installed && !running ? (probeError !== null && typeof probeError.command === 'string' && probeError.command.length > 0 ? probeError.command : FALLBACK_COMMANDS.notRunning) : undefined,
						}),
						h(CheckRow, {
							t: t,
							name: 'login',
							ok: loggedIn,
							label: loggedIn ? t('tsLoggedIn') + ' (' + String(backend) + ')' : t('tsNotLoggedIn'),
							hint: probeError !== null && probeError.code === 'TAILSCALE_NEEDS_LOGIN' && typeof probeError.hint === 'string' ? probeError.hint : undefined,
							command: running && !loggedIn ? (probeError !== null && typeof probeError.command === 'string' && probeError.command.length > 0 ? probeError.command : FALLBACK_COMMANDS.needsLogin) : undefined,
						}),
						operator !== null
							? h(CheckRow, {
								t: t,
								name: 'operator',
								ok: operator.ok === true,
								label: operator.ok === true ? t('tsOperatorOk') : t('tsNotOperatorBroken'),
								hint: operator.ok === true || typeof operator.hint !== 'string' ? undefined : operator.hint,
								command: operator.ok === true
									? undefined
									: (typeof operator.command === 'string' && operator.command.length > 0 ? operator.command : OPERATOR_COMMAND),
							})
							: null,
						operator === null && error !== null && String(error.code) === 'TAILSCALE_NOT_OPERATOR'
							? h(CheckRow, {
								t: t,
								name: 'operator',
								ok: false,
								label: t('tsNotOperatorBroken'),
								hint: typeof error.hint === 'string' && error.hint.length > 0 ? error.hint : undefined,
								command: typeof error.command === 'string' && error.command.length > 0 ? error.command : OPERATOR_COMMAND,
							})
							: null,
						h('div', { style: S.row },
							h('span', { style: S.secondary }, t('tsMachine') + ':'),
							h('code', { style: S.mono }, self !== null && typeof self.dnsName === 'string' && self.dnsName.length > 0 ? self.dnsName : (self !== null && typeof self.hostName === 'string' ? self.hostName : t('unknown'))),
							h('span', { style: S.secondary }, t('tsTailnet') + ':'),
							h('code', { style: S.mono }, tailnet !== null && typeof tailnet.name === 'string' && tailnet.name.length > 0 ? tailnet.name : (tailnet !== null && typeof tailnet.magicDnsSuffix === 'string' && tailnet.magicDnsSuffix.length > 0 ? tailnet.magicDnsSuffix : t('unknown'))),
							h('span', { style: S.secondary }, t('tsIps') + ':'),
							h('code', { style: S.mono }, self !== null && Array.isArray(self.ips) && self.ips.length > 0 ? self.ips.join(', ') : t('unknown'))),
						h('div', { style: S.row },
							h('span', { style: S.secondary }, t('tsBackendState') + ':'),
							h('code', { style: S.mono }, backend === null ? t('unknown') : backend),
							h('span', { style: S.secondary }, t('tsVersion') + ':'),
							// SPEC F-UI-3 asks for the tailscale version; the frozen
							// status shape carries none, so it renders as unknown until
							// the host adds `tailscale.version`.
							h('code', { style: S.mono }, tailscale !== null && typeof tailscale.version === 'string' && tailscale.version.length > 0 ? tailscale.version : t('unknown')))),
				// The error box sits *after* the check list on purpose: the reader
				// first sees which prerequisite failed (with its fix command), then
				// the raw failure detail that produced it.
				error === null ? null : h('div', { style: S.errorBox, 'data-ra-lasterror': String(error.code === undefined ? '' : error.code) },
					h('strong', null, t('lastError') + (error.code === undefined ? '' : ' (' + String(error.code) + ')')),
					h('span', null, String(error.message === undefined ? '' : error.message)),
					typeof error.hint === 'string' && error.hint.length > 0 ? h('span', { style: S.hint }, t('hint') + ': ' + error.hint) : null,
					typeof error.command === 'string' && error.command.length > 0
						? h('span', { style: S.command },
							h('code', { style: S.mono }, error.command),
							h(CopyButton, { t: t, text: error.command, what: 'errorCommand' }))
						: null,
					h('span', { style: S.hint }, absoluteTime(error.at))),
				mode === null || mode === 'none' ? null : h('div', { style: S.row },
					h('button', {
						type: 'button',
						style: S.button,
						disabled: props.action.pending !== null,
						'data-ra-action': 'restart',
						onClick: props.onRestart,
					}, props.action.pending === 'restart' ? t('restarting') : t('restart'))))
		}

		/** The settings card: master switch, mode, and the remaining fields (F-CONF-2, F-UI-7). */
		function ConfigSection(props) {
			var t = props.t
			var scope = props.scope
			var write = props.write
			var commit = props.commit
			var pair = React.useState(function () { return {} })
			var drafts = pair[0]
			var setDrafts = pair[1]

			var busy = write.pending !== null
			var writable = scope.writable && scope.available
			var value = scope.value

			var enabled = value.enabled === true
			var mode = typeof value.mode === 'string' ? value.mode : 'tailscale'
			var overridden = scope.user !== null && Object.keys(scope.user).length > 0

			/** Draft text for a staged field: the local edit, else the stored value. */
			var draftOf = function (field, format) {
				return Object.prototype.hasOwnProperty.call(drafts, field) ? drafts[field] : format(fieldOf(scope, field))
			}
			var edit = function (field, text) {
				setDrafts(function (previous) {
					var next = {}
					for (var name in previous) if (Object.prototype.hasOwnProperty.call(previous, name)) next[name] = previous[name]
					next[field] = text
					return next
				})
			}

			/** Every staged edit a save would write; `invalid` blocks the save. */
			var plan = function () {
				var ops = []
				var invalid = false
				var port = draftOf('port', function (raw) { return typeof raw === 'number' ? String(raw) : '' })
				if (Object.prototype.hasOwnProperty.call(drafts, 'port')) {
					var parsedPort = parseInteger(port)
					if (parsedPort.invalid || (parsedPort.value !== undefined && parsedPort.value > 65535)) invalid = true
					else ops.push({ field: 'port', value: parsedPort.empty ? undefined : parsedPort.value })
				}
				var hours = draftOf('sessionHours', function (raw) { return typeof raw === 'number' ? String(raw) : '' })
				if (Object.prototype.hasOwnProperty.call(drafts, 'sessionHours')) {
					var parsedHours = parseInteger(hours)
					if (parsedHours.invalid) invalid = true
					else ops.push({ field: 'sessionHours', value: parsedHours.empty ? undefined : parsedHours.value })
				}
				var users = draftOf('allowedUsers', joinList)
				if (Object.prototype.hasOwnProperty.call(drafts, 'allowedUsers')) {
					var parsedUsers = splitList(users)
					ops.push({ field: 'allowedUsers', value: parsedUsers.length === 0 ? undefined : parsedUsers })
				}
				var cidrs = draftOf('allowedCidrs', joinList)
				if (Object.prototype.hasOwnProperty.call(drafts, 'allowedCidrs')) {
					var parsedCidrs = splitList(cidrs)
					ops.push({ field: 'allowedCidrs', value: parsedCidrs.length === 0 ? undefined : parsedCidrs })
				}
				var binary = draftOf('cloudflaredPath', function (raw) { return typeof raw === 'string' ? raw : '' })
				if (Object.prototype.hasOwnProperty.call(drafts, 'cloudflaredPath')) {
					ops.push({ field: 'cloudflaredPath', value: binary.trim() === '' ? undefined : binary.trim() })
				}
				return { ops: ops, invalid: invalid }
			}

			var current = plan()
			var dirty = current.ops.length > 0

			var save = function () {
				if (!dirty || current.invalid || busy) return
				var chain = Promise.resolve(true)
				current.ops.forEach(function (op) {
					chain = chain.then(function (ok) {
						return commit(op.field, op.value).then(function (landed) { return ok && landed })
					})
				})
				void chain.then(function (landed) {
					if (landed) setDrafts({})
					if (typeof props.onSaved === 'function') props.onSaved(landed)
				})
			}

			var toggle = function (field, next) {
				void commit(field, next)
			}

			var stagedText = function (field, format) {
				return h('input', {
					type: 'text',
					style: S.input,
					value: draftOf(field, format),
					disabled: !writable || busy,
					onChange: function (event) { edit(field, event.target.value) },
					'data-ra-input': field,
				})
			}
			var stagedNumber = function (field) {
				var text = draftOf(field, function (raw) { return typeof raw === 'number' ? String(raw) : '' })
				var parsed = parseInteger(text)
				return h('input', {
					type: 'text',
					inputMode: 'numeric',
					style: S.input,
					value: text,
					disabled: !writable || busy,
					'aria-invalid': parsed.invalid ? 'true' : 'false',
					onChange: function (event) { edit(field, event.target.value) },
					'data-ra-input': field,
				})
			}
			var stagedArea = function (field) {
				return h('textarea', {
					style: S.textarea,
					value: draftOf(field, joinList),
					disabled: !writable || busy,
					onChange: function (event) { edit(field, event.target.value) },
					'data-ra-input': field,
				})
			}
			// Every checkbox in this card writes immediately (a switch that needed a
			// separate save would show a state the document does not have).
			var checkbox = function (field, label, checked) {
				return h('label', { style: S.check, 'data-ra-checkbox': field },
					h('input', {
						type: 'checkbox',
						checked: checked,
						disabled: !writable || busy,
						onChange: function (event) { toggle(field, event.target.checked) },
						'data-ra-input': field,
					}),
					h('span', null, label))
			}

			return h(Section, { name: 'config', title: t('configTitle') },
				scope.available ? null : h('div', { style: S.notice, 'data-ra-scope': scope.status }, scope.status === 'loading' ? t('scopeLoading') : t('scopeUnavailable')),
				scope.available && !scope.writable ? h('div', { style: S.notice, 'data-ra-scope': 'readonly' }, t('readOnly')) : null,
				h('div', { style: S.check, 'data-ra-field': 'enabled' },
					h('input', {
						type: 'checkbox',
						checked: enabled,
						disabled: !writable || busy,
						onChange: function (event) { toggle('enabled', event.target.checked) },
						'data-ra-input': 'enabled',
					}),
					h('span', { style: S.labelText }, t('enabled')),
					busy && write.field === 'enabled' ? h('span', { style: S.hint }, t('saving')) : null),
				h('span', { style: S.hint }, t('enabledHint')),
				h(Field, { field: 'mode', label: t('mode') },
					h('select', {
						style: S.select,
						value: mode,
						disabled: !writable || busy,
						onChange: function (event) { toggle('mode', event.target.value) },
						'data-ra-input': 'mode',
					},
						h('option', { value: 'tailscale' }, t('modeTailscale')),
						// quick mode is still under test: it is deliberately not offered here. A
						// configuration that already selects it (settings section, another build)
						// must still render, otherwise the select would silently misreport it.
						mode === 'quick' ? h('option', { value: 'quick' }, t('modeQuick')) : null,
						h('option', { value: 'none' }, t('modeNone')))),
				mode === 'tailscale'
					? h('div', { style: S.notice, 'data-ra-prereq': 'tailscale' },
						h('strong', null, t('prereqTitle')),
						h('span', { style: S.hint }, t('prereqBody')),
						h('span', { style: S.row },
							h('span', { style: S.hint }, t('prereqCommandLabel')),
							h('code', { style: S.mono }, OPERATOR_COMMAND),
							h(CopyButton, { t: t, text: OPERATOR_COMMAND, what: 'operatorCommand' })))
					: null,
				mode === 'quick'
					? h('div', { style: S.notice, 'data-ra-quick-warning': 'true' },
						h('div', null, t('quickWarning')),
						h('span', { style: S.hint, 'data-ra-quick-testing': 'true' }, t('quickTesting')),
						checkbox('acknowledgeRisk', t('acknowledgeRisk'), value.acknowledgeRisk === true))
					: null,
				h('div', { style: S.spread },
					h('span', { style: S.hint }, overridden ? t('overridden') : t('defaultsOnly')),
					busy && write.field !== 'enabled' ? h('span', { style: S.hint }, t('saving')) : null),
				h('div', { style: S.row },
					h(Field, { field: 'port', label: t('port') }, stagedNumber('port')),
					h(Field, { field: 'sessionHours', label: t('sessionHours') }, stagedNumber('sessionHours'))),
				h(Field, { field: 'allowedUsers', label: t('allowedUsers'), hint: t('allowedUsersHint') }, stagedArea('allowedUsers')),
				h(Field, { field: 'allowedCidrs', label: t('allowedCidrs'), hint: t('allowedCidrsHint') }, stagedArea('allowedCidrs')),
				mode === 'quick'
					? h(Field, { field: 'cloudflaredPath', label: t('cloudflaredPath'), hint: t('cloudflaredPathHint') }, stagedText('cloudflaredPath', function (raw) { return typeof raw === 'string' ? raw : '' }))
					: null,
				h('div', { style: S.row },
					checkbox('audit', t('audit'), value.audit !== false),
					checkbox('statusPage', t('statusPage'), value.statusPage !== false)),
				h('div', { style: S.row },
					h('button', {
						type: 'button',
						style: S.buttonPrimary,
						disabled: !writable || busy || !dirty || current.invalid,
						onClick: save,
						'data-ra-action': 'save',
					}, busy && write.field !== 'enabled' ? t('saving') : t('save')),
					h('button', {
						type: 'button',
						style: S.button,
						disabled: busy || !dirty,
						onClick: function () { setDrafts({}) },
						'data-ra-action': 'discard',
					}, t('discard')),
					current.invalid ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: '12px' } }, t('invalidField')) : null,
					dirty && !current.invalid ? h('span', { style: S.hint }, t('unsaved')) : null),
				write.failed ? h('div', { style: S.errorBox, 'data-ra-write-error': 'true' }, t('saveFailed', { message: write.error === null ? t('unknown') : write.error })) : null)
		}

		/** The connected-client table with a per-row kick (F-UI-4, F-AUTH-6). */
		function ClientsSection(props) {
			var t = props.t
			var clients = props.clients
			var pair = React.useState(null)
			var armed = pair[0]
			var setArmed = pair[1]
			var action = props.action

			var onKick = function (client) {
				if (armed !== client.id) {
					setArmed(client.id)
					return
				}
				setArmed(null)
				void props.onKick(client)
			}

			var rows = clients.map(function (client) {
				var id = String(client.id === undefined ? client.ip : client.id)
				var who = typeof client.identity === 'string' && client.identity.length > 0 ? client.identity : String(client.ip === undefined ? id : client.ip)
				var name = typeof client.name === 'string' && client.name.length > 0 ? client.name : null
				var websockets = typeof client.websockets === 'number' ? client.websockets : 0
				return h('tr', { key: id, 'data-ra-client': id },
					h('td', { style: S.td },
						h('div', { style: S.row },
							h('span', {
								style: Object.assign({}, S.dot, { background: client.active === false ? PHASE_COLOR.stopped : PHASE_COLOR.running }),
								title: client.active === false ? t('offline') : t('online'),
							}),
							h('code', { style: S.mono }, who)),
						h('div', { style: S.hint },
							(client.kind === 'identity' ? t('kindIdentity') : t('kindIp')) +
							(name === null ? '' : ' · ' + name) +
							(typeof client.userAgent === 'string' && client.userAgent.length > 0 ? ' · ' + client.userAgent.slice(0, 60) : ' · ' + t('noUserAgent')))),
					h('td', { style: S.td, title: absoluteTime(client.since) }, relativeText(t, client.since)),
					h('td', { style: S.td, title: absoluteTime(client.lastSeen) }, relativeText(t, client.lastSeen)),
					h('td', { style: S.td }, websockets > 0 ? t('wsOn', { n: websockets }) : t('wsOff')),
					h('td', { style: S.td }, String(typeof client.requests === 'number' ? client.requests : 0)),
					h('td', { style: S.td },
						h('button', {
							type: 'button',
							style: S.buttonDanger,
							disabled: action.pending !== null,
							onClick: function () { onKick(client) },
							'data-ra-action': 'kick',
							'data-ra-kick': id,
						}, armed === id ? t('kickConfirm') : t('kick'))))
			})

			return h(Section, { name: 'clients', title: t('clients') + ' (' + String(clients.length) + ')' },
				clients.length === 0
					? h('span', { style: S.hint }, t('clientsEmpty'))
					: h('table', { style: S.table },
						h('thead', null,
							h('tr', null,
								h('th', { style: S.th }, t('colWho')),
								h('th', { style: S.th }, t('colSince')),
								h('th', { style: S.th }, t('colLastSeen')),
								h('th', { style: S.th }, t('colWs')),
								h('th', { style: S.th }, t('colRequests')),
								h('th', { style: S.th }, t('colActions')))),
						h('tbody', null, rows)),
				props.message === null ? null : h('div', {
					style: props.message.failed ? S.errorBox : S.notice,
					'data-ra-action-message': props.message.failed ? 'failed' : 'ok',
				}, props.message.text))
		}

		/** Recent events, truncated (F-UI-6). */
		function EventsSection(props) {
			var t = props.t
			var events = props.events
			return h(Section, { name: 'events', title: t('events') },
				events.length === 0
					? h('span', { style: S.hint }, t('eventsEmpty'))
					: h('ul', { style: S.events }, events.map(function (event, index) {
						return h('li', { key: String(index), style: S.row, 'data-ra-event': event.kind },
							h('span', { style: S.hint }, absoluteTime(event.at)),
							h('span', {
								style: event.kind === 'error'
									? { color: 'var(--dsw-alias-state-error-primary, #d33)' }
									: S.secondary,
							}, event.text))
					})))
		}

		/** The full card body (the `page` view). */
		/**
		 * Remote-page affordance: read the Host settings document and apply its
		 * page-level preferences here. Hidden on loopback pages, which already have
		 * the document on a non-loopback page.
		 */
		function HostSettingsSection(props) {
			var t = props.t
			var ctx = props.ctx
			var pair = React.useState(function () { return { phase: 'idle', doc: null, applied: [], failed: [], error: null } })
			var state = pair[0]
			var setState = pair[1]
			var load = function () {
				setState({ phase: 'loading', doc: null, applied: [], failed: [], error: null })
				void fetchHostSettings().then(function (doc) {
					var outcome = applyHostPreferences(ctx, doc)
					setState({ phase: 'ok', doc: doc, applied: outcome.applied, failed: outcome.failed, error: null })
				}, function (error) {
					setState({ phase: 'error', doc: null, applied: [], failed: [], error: messageOf(error) })
				})
			}
			var theme = state.doc !== null && typeof state.doc === 'object' && state.doc.theme !== null && typeof state.doc.theme === 'object' ? state.doc.theme : null
			return h(Section, { name: 'host-settings', title: t('hostSettingsTitle') },
				h('span', { style: S.hint }, t('hostSettingsBody')),
				h('div', { style: S.row },
					h('button', {
						type: 'button',
						style: S.button,
						disabled: state.phase === 'loading',
						'data-ra-action': 'load-host-settings',
						onClick: load,
					}, state.phase === 'loading' ? t('hostSettingsLoading') : t('hostSettingsButton'))),
				state.phase === 'error' ? h('div', { style: S.errorBox, 'data-ra-host-settings': 'error' }, t('hostSettingsError', { message: String(state.error) })) : null,
				state.phase === 'ok'
					? h('div', { style: S.notice, 'data-ra-host-settings': 'ok' },
						h('span', null, t('hostSettingsRead', {
							locale: typeof state.doc.locale === 'string' ? state.doc.locale : t('unknown'),
							theme: theme !== null && typeof theme.preference === 'string' ? theme.preference : t('unknown'),
							fontSize: theme !== null && Number.isInteger(theme.fontSize) ? String(theme.fontSize) : t('unknown'),
						})),
						state.applied.length === 0 ? null : h('span', { style: S.hint }, t('hostSettingsApplied', { list: state.applied.join(', ') })),
						state.failed.length === 0 ? null : h('span', { style: S.hint }, t('hostSettingsFailed', { list: state.failed.join('; ') })))
					: null)
		}

		function CardBody(props) {
			var ctx = props.ctx
			var scope = props.scope
			var t = props.t

			// Re-render on a locale switch: the translate function reads the active
			// locale at call time, so a re-render is all it needs.
			useLocaleTick(ctx)

			// The Host's status poll *is* the config read: useStatus folds each payload
			// into the config source before rendering, so these field renderers see
			// current values on any page authority.
			var status = useStatus(scope)
			var scopeSnapshot = useScopeSnapshot(scope)
			var eventsPair = useEventLog()
			var events = eventsPair[0]
			var push = eventsPair[1]
			var messagePair = React.useState(null)
			var message = messagePair[0]
			var setMessage = messagePair[1]
			var actionPair = React.useState(function () { return { pending: null } })
			var action = actionPair[0]
			var setAction = actionPair[1]

			var writer = useScopeWriter(scope, function (field) {
				push('info', t('eventWrite', { field: field }))
				void status.refresh()
			})
			var write = writer[0]
			var commit = writer[1]

			var previous = React.useRef({ phase: null, error: null })
			React.useEffect(function () {
				var last = previous.current
				if (status.phase === 'error') {
					if (last.error !== status.error) {
						last.error = status.error
						push('error', t('eventUnreachable', { message: status.error === null ? t('unknown') : status.error }))
					}
					return
				}
				if (status.phase !== 'ok') return
				last.error = null
				var phase = status.data !== null && typeof status.data.phase === 'string' ? status.data.phase : 'unknown'
				if (phase === last.phase) return
				last.phase = phase
				push('info', t('eventPhase', { phase: t(PHASE_KEY[phase] === undefined ? 'phaseUnknown' : PHASE_KEY[phase]) }))
			}, [status.phase, status.error, status.fetchedAt, push])

			// Write failures are worth a line in the event log as well.
			React.useEffect(function () {
				if (!write.failed) return
				push('error', t('eventWriteFailed', { field: String(write.field), message: write.error === null ? t('unknown') : write.error }))
			}, [write.failed, write.field, write.error, push])

			var runAction = function (label, body, onDone) {
				setAction({ pending: label })
				setMessage(null)
				void postAction(body).then(function (outcome) {
					setAction({ pending: null })
					onDone(outcome)
				})
			}

			var onKick = function (client) {
				var id = String(client.id === undefined ? client.ip : client.id)
				var who = typeof client.identity === 'string' && client.identity.length > 0 ? client.identity : String(client.ip === undefined ? id : client.ip)
				runAction('kick', { action: 'kick', id: id }, function (outcome) {
					var count = outcome.ok && outcome.payload !== null && outcome.payload.result !== null && typeof outcome.payload.result === 'object' && typeof outcome.payload.result.kicked === 'number'
						? outcome.payload.result.kicked
						: 0
					var text = outcome.ok ? t('kicked', { count: count }) : t('kickFailed', { message: outcome.error === null ? t('unknown') : outcome.error })
					setMessage({ text: text, failed: !outcome.ok })
					push(outcome.ok ? 'info' : 'error', t('eventKick', { who: who, result: text }))
					void status.refresh()
				})
			}

			var onRestart = function () {
				runAction('restart', { action: 'restart' }, function (outcome) {
					var text = outcome.ok ? t('restarted') : t('restartFailed', { message: outcome.error === null ? t('unknown') : outcome.error })
					setMessage({ text: text, failed: !outcome.ok })
					push(outcome.ok ? 'info' : 'error', t('eventRestart', { result: text }))
					void status.refresh()
				})
			}

			var clients = React.useMemo(function () {
				var list = status.data !== null && Array.isArray(status.data.clients) ? status.data.clients : []
				return list.filter(function (client) { return client !== null && typeof client === 'object' })
			}, [status.data])

			return h('div', { style: S.root, 'data-ra-view': 'page' },
				missingModules.length === 0
					? null
					: h('div', { style: S.notice, 'data-ra-missing-deps': missingModules.join(',') }, t('missingDeps', { ids: missingModules.join(', ') })),
				isLoopbackPage() ? null : h(HostSettingsSection, { t: t, ctx: ctx }),
				h(RuntimeSection, { t: t, status: status, action: action, onRestart: onRestart }),
				h(ConfigSection, { t: t, scope: scopeSnapshot, write: write, commit: commit, onSaved: function () { void status.refresh() } }),
				h(ClientsSection, { t: t, clients: clients, action: action, message: message, onKick: onKick }),
				h(EventsSection, { t: t, events: events }))
		}

		/**
		 * The registered card. The `summary` view is a plain one-liner (it is
		 * rendered for every card in the list, so it must not poll); the `page`
		 * view is the live panel, mounted only while the card is open.
		 * @param props - `{ view }` from the Plugins page.
		 * @returns the summary text or the panel.
		 */
		function RemoteAccessCard(props) {
			var ctx = props !== null && props !== undefined ? props.ctx : null
			var scope = props !== null && props !== undefined ? props.scope : null
			var t = props !== null && props !== undefined && typeof props.t === 'function' ? props.t : null
			var translate = t === null ? makeTranslate(tryGetService(ctx, 'locale')) : t
			if (props !== null && props !== undefined && props.view === 'summary') {
				return h('span', { 'data-ra-view': 'summary' }, translate('summary'))
			}
			return h(CardBody, { ctx: ctx, scope: scope, t: translate })
		}

		/* ──────────────────────────────── plugin ───────────────────────────────── */

		/** Diagnostics for tests and for the "why is my card missing" question. */
		var diagnostics = {
			id: PLUGIN_ID,
			missingModules: missingModules,
			scope: 'unbound',
			registration: 'pending',
			legacyRegistration: 'pending',
			notes: [],
		}

		/**
		 * Bind the settings namespace, defensively.
		 * @param ctx - the plugin context.
		 * @returns the bound scope, or null.
		 */
		function bindScope() {
			/**
			 * Configuration source for the card.
			 *
			 * It is deliberately NOT `ctx.settingsScope`: DSH decides that from the
			 * page authority (`isLoopback` = localhost/127/8/[::1]) and runs the
			 * settings mirror in `memory` mode on any other origin, where reads
			 * return early and writes resolve without ever reaching the Host —
			 * silently. A phone opening the GUI over a tunnel is exactly that case:
			 * it would render defaults and lose every change.
			 *
			 * The plugin's own host route is reachable from both kinds of page, so
			 * it is the single source here: reads come from `status.config` (the
			 * Host's effective section, secret-free) and writes go to the action
			 * endpoint, which lands in the same settings section.
			 */
			var listeners = new Set()
			var snapshot = { status: 'unavailable', writable: true, value: {}, user: null, mode: 'host', revision: undefined }
			var notify = function () {
				listeners.forEach(function (listener) {
					try { listener() } catch (error) { /* a subscriber must not break the others */ }
				})
			}
			diagnostics.scope = 'host-api'
			return {
				getSnapshot: function () { return snapshot },
				subscribe: function (listener) {
					listeners.add(listener)
					return function () { listeners.delete(listener) }
				},
				/** Fold one status poll's config into the snapshot. */
				publish: function (config) {
					if (config === null || typeof config !== 'object' || Array.isArray(config)) return
					var overridden = config.configOverridden === true
					snapshot = {
						status: 'ready',
						writable: true,
						value: config,
						// readScope only asks whether the user layer overrides anything.
						user: overridden ? { overridden: true } : null,
						mode: 'host',
						revision: undefined,
					}
					notify()
				},
				set: function (field, value) {
					var patch = {}
					patch[field] = value
					return postAction({ action: 'set', patch: patch }).then(function (outcome) {
						if (outcome.ok !== true) throw new Error(outcome.error === null ? 'write failed' : outcome.error)
						if (outcome.payload !== null && outcome.payload.result !== undefined) snapshot = snapshot
						return true
					})
				},
				unset: function (field) {
					return postAction({ action: 'unset', fields: [field] }).then(function (outcome) {
						if (outcome.ok !== true) throw new Error(outcome.error === null ? 'write failed' : outcome.error)
						return true
					})
				},
			}
		}

		/**
		 * Register this bundle's dictionaries when a locale face exists. The
		 * namespace is untyped on purpose (this bundle declares no type merge).
		 * @param ctx - the plugin context.
		 */
		function registerDictionaries(ctx) {
			var face = tryGetService(ctx, 'locale')
			if (face === null || typeof face.register !== 'function') {
				diagnostics.notes.push('locale face unavailable; bundled dictionaries used')
				return
			}
			if (typeof ctx.effect !== 'function') return
			try {
				ctx.effect(function () {
					var disposers = []
					var locales = ['zh', 'en']
					for (var index = 0; index < locales.length; index++) {
						try {
							var off = face.register(NS, locales[index], DICT[locales[index]])
							if (typeof off === 'function') disposers.push(off)
						} catch (error) {
							diagnostics.notes.push('dictionary ' + locales[index] + ' not registered: ' + messageOf(error))
						}
					}
					return function () {
						for (var i = 0; i < disposers.length; i++) {
							try { disposers[i]() } catch (error) { /* already gone */ }
						}
					}
				}, 'remote-access: dictionaries')
			} catch (error) {
				diagnostics.notes.push('dictionary effect failed: ' + messageOf(error))
			}
		}

		/**
		 * The plugin body. Never throws: a broken composition degrades the card,
		 * it must not take the settings page down.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			try {
				var slots = tryGetService(ctx, 'slots')
				if (slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
					diagnostics.registration = 'skipped: slots service unavailable'
					return
				}
				var scope = bindScope()
				registerDictionaries(ctx)
				var translate = makeTranslate(tryGetService(ctx, 'locale'))
				var Card = function Card(props) {
					return RemoteAccessCard(Object.assign({}, props, { ctx: ctx, scope: scope, t: translate }))
				}
				slots.inject('plugins.item', function () {
					try {
						var off = slots.register({
							name: 'plugins.item',
							id: CARD_ID,
							order: CARD_ORDER,
							label: function () { return translate('title') },
						}, Card)
						diagnostics.registration = 'registered'
						return off
					} catch (error) {
						diagnostics.registration = 'register-failed: ' + messageOf(error)
						return function () {}
					}
				})
				slots.inject(LEGACY_CARD_SLOT, function () {
					try {
						var off = slots.register({
							name: LEGACY_CARD_SLOT,
							key: NS,
							locale: NS,
						}, Card)
						diagnostics.legacyRegistration = 'registered'
						return off
					} catch (error) {
						diagnostics.legacyRegistration = 'register-failed: ' + messageOf(error)
						return function () {}
					}
				})
			} catch (error) {
				diagnostics.registration = 'apply-failed: ' + messageOf(error)
			}
		}

		exports.apply = apply
		// Declared services: the client runtime guards `ctx.<service>` access, so any
		// service the card reads must be declared here or the read is rejected — the
		// card then renders without its toggle and settings form. `effect` is a
		// Context method, not a service.
		exports.inject = ['slots', 'settingsScope', 'locale']
		// Not part of the plugin contract: a small window into why the card is
		// missing, for tests and for `dsh-tailscale-access` debugging.
		exports.__remoteAccessDiagnostics = diagnostics
		return module.exports
	}
})
