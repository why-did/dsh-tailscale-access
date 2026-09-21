/**
 * dsh-tailscale-access — client bundle tests.
 *
 * There is no real host in this repository, so the strongest available
 * verification is to load the hand-written bundle the way the browser module
 * system does and drive it with fakes:
 *
 *   - `node:vm` provides a fake `window.__ModuleLoader__.load` that records the
 *     registration and the factory (and proves the factory is lazy);
 *   - a fake `require` serves a minimal React (hooks dispatcher included) and
 *     `react/jsx-runtime`, and THROWS for every other module id — so a bundle
 *     that invented a dependency cannot pass silently;
 *   - a mini renderer invokes the registered component (and every child
 *     component it returns) with persistent hook state, so clicking a control
 *     in one pass and observing it in the next behaves like React;
 *   - fake timers and a fake `fetch` capture polling, cleanup, and actions.
 *
 * Run: `node --test tests/client-bundle.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.join(HERE, '..', 'lib', 'client', 'client.js')

/** Module ids the bundle is allowed to require (platform seed words + probed optional faces). */
const ALLOWED_MODULES = new Set([
	'react',
	'react/jsx-runtime',
	'@deepseek-ai/dsh-client-ui-primitives',
])

/* ────────────────────────────── fake React ─────────────────────────────── */

/**
 * Shallow dependency comparison (React's Object.is per entry).
 * @param {unknown[]|undefined} a - previous deps.
 * @param {unknown[]|undefined} b - next deps.
 * @returns {boolean} whether the deps are equal.
 */
function sameDeps(a, b) {
	if (a === undefined || b === undefined) return false
	if (a.length !== b.length) return false
	for (let index = 0; index < a.length; index += 1) if (!Object.is(a[index], b[index])) return false
	return true
}

/**
 * A minimal React: element factories, a hook dispatcher with per-component
 * persistent slots, and effect flushing.
 * @returns the runtime.
 */
function createRuntime() {
	/** @type {Map<Function, {slots: unknown[], effects: Array<{deps?: unknown[], cleanup?: Function}>}>} */
	const instances = new Map()
	let current = null
	let cursor = 0
	let pending = []

	/**
	 * Enter one component instance for a render pass.
	 * @param {Function} type - component function.
	 */
	function begin(type) {
		let instance = instances.get(type)
		if (instance === undefined) {
			instance = { slots: [], effects: [] }
			instances.set(type, instance)
		}
		current = instance
		cursor = 0
		pending = []
	}

	/**
	 * Run the effects this render pass scheduled, skipping unchanged deps.
	 * @param {{slots: unknown[], effects: Array<{deps?: unknown[], cleanup?: Function}>}} instance - component instance.
	 */
	function flushEffects(instance) {
		const scheduled = pending
		pending = []
		for (const item of scheduled) {
			const previous = instance.effects[item.index]
			if (previous !== undefined && sameDeps(previous.deps, item.deps)) continue
			if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
			const cleanup = item.fn()
			instance.effects[item.index] = {
				deps: item.deps,
				cleanup: typeof cleanup === 'function' ? cleanup : undefined,
			}
		}
	}

	const React = {
		createElement(type, props, ...children) {
			const next = { ...(props ?? {}) }
			if (children.length === 1) next.children = children[0]
			else if (children.length > 1) next.children = children
			return { type, props: next, key: props?.key ?? null }
		},
		useState(initial) {
			const instance = current
			const index = cursor
			cursor += 1
			if (!(index in instance.slots)) instance.slots[index] = typeof initial === 'function' ? initial() : initial
			return [instance.slots[index], (next) => {
				instance.slots[index] = typeof next === 'function' ? next(instance.slots[index]) : next
			}]
		},
		useRef(initial) {
			const instance = current
			const index = cursor
			cursor += 1
			if (!(index in instance.slots)) instance.slots[index] = { current: initial }
			return instance.slots[index]
		},
		useMemo(factory, deps) {
			const instance = current
			const index = cursor
			cursor += 1
			const previous = instance.slots[index]
			if (previous === undefined || !sameDeps(previous.deps, deps)) instance.slots[index] = { value: factory(), deps }
			return instance.slots[index].value
		},
		useCallback(callback, deps) {
			const instance = current
			const index = cursor
			cursor += 1
			const previous = instance.slots[index]
			if (previous === undefined || !sameDeps(previous.deps, deps)) instance.slots[index] = { value: callback, deps }
			return instance.slots[index].value
		},
		useEffect(effect, deps) {
			const index = cursor
			cursor += 1
			pending.push({ index, fn: effect, deps })
		},
	}

	/**
	 * Render one element tree, invoking every function component it contains.
	 * @param {unknown} node - element, array, or text.
	 * @returns {unknown} the rendered tree.
	 */
	function renderNode(node) {
		if (node === null || node === undefined || typeof node === 'boolean') return node
		if (typeof node === 'string' || typeof node === 'number') return node
		if (Array.isArray(node)) return node.map(renderNode)
		if (typeof node.type === 'function') {
			begin(node.type)
			const instance = current
			const output = node.type(node.props)
			flushEffects(instance)
			return renderNode(output)
		}
		return {
			type: node.type,
			key: node.key ?? null,
			props: { ...node.props, children: renderNode(node.props?.children) },
		}
	}

	return {
		React,
		/**
		 * Render an element tree.
		 * @param {unknown} element - the root element.
		 * @returns {unknown} the rendered tree.
		 */
		render(element) {
			return renderNode(element)
		},
		/** Run every stored effect cleanup (component unmount). */
		unmount() {
			for (const instance of instances.values()) {
				for (let index = instance.effects.length - 1; index >= 0; index -= 1) {
					const effect = instance.effects[index]
					if (effect !== undefined && typeof effect.cleanup === 'function') effect.cleanup()
					instance.effects[index] = { deps: undefined, cleanup: undefined }
				}
			}
		},
	}
}

/* ─────────────────────────────── fake DOM ──────────────────────────────── */

/**
 * Fake timers, fake document listeners, and a fake fetch.
 * @param {(url: string, options: object) => unknown} handler - fetch implementation.
 * @returns the fake environment.
 */
function createEnvironment(handler) {
	const clock = { next: 1, intervals: new Map(), timeouts: new Map(), cleared: [] }
	const listeners = new Map()
	const fetchCalls = []
	const document = {
		visibilityState: 'visible',
		addEventListener(type, listener) {
			const set = listeners.get(type) ?? new Set()
			set.add(listener)
			listeners.set(type, set)
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener)
		},
		createElement() {
			return { style: {}, setAttribute() {}, select() {}, remove() {}, appendChild() {} }
		},
		execCommand() { return false },
	}
	const environment = {
		clock,
		document,
		listeners,
		fetchCalls,
		setInterval(fn, ms) {
			const id = clock.next
			clock.next += 1
			clock.intervals.set(id, { fn, ms })
			return id
		},
		clearInterval(id) {
			clock.cleared.push(['interval', id])
			clock.intervals.delete(id)
		},
		setTimeout(fn, ms) {
			const id = clock.next
			clock.next += 1
			clock.timeouts.set(id, { fn, ms })
			return id
		},
		clearTimeout(id) {
			clock.cleared.push(['timeout', id])
			clock.timeouts.delete(id)
		},
		fetch(url, options) {
			fetchCalls.push({ url, options })
			return Promise.resolve(handler(url, options))
		},
	}
	/** Interval periods currently registered. */
	environment.intervalPeriods = () => [...clock.intervals.values()].map(entry => entry.ms)
	return environment
}

/* ─────────────────────────────── bundle loader ─────────────────────────── */

/**
 * Load `lib/client/client.js` in a fresh VM context.
 * @param {{ breakOptional?: boolean, env?: ReturnType<typeof createEnvironment>, primitives?: object, navigator?: object }} [options] - knobs.
 * @returns {Promise<object>} the recorded registration, factory, require log, and runtime.
 */
async function loadBundle(options = {}) {
	const source = await readFile(CLIENT_PATH, 'utf8')
	const records = []
	const requireCalls = []
	const runtime = createRuntime()
	const primitives = options.primitives ?? {
		writeClipboard: async () => true,
	}
	const env = options.env ?? createEnvironment(() => ({
		ok: true,
		status: 200,
		json: async () => ({ phase: 'stopped', mode: 'tailscale', clients: [], updatedAt: Date.now() }),
	}))

	const jsx = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null })
	const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol.for('react.fragment') }

	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(record) {
					records.push(record)
				},
			},
		},
		document: env.document,
		navigator: options.navigator ?? { language: 'zh-CN' },
		location: options.location,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		setTimeout: env.setTimeout,
		clearTimeout: env.clearTimeout,
		fetch: env.fetch,
	}
	vm.createContext(sandbox)
	vm.runInContext(source, sandbox, { filename: 'lib/client/client.js' })

	/**
	 * Fake module table: only real faces resolve, everything else throws the way
	 * the browser loader does.
	 * @param {string} id - requested module id.
	 * @returns {unknown} the module face.
	 */
	const fakeRequire = (id) => {
		requireCalls.push(id)
		if (!ALLOWED_MODULES.has(id)) {
			throw new Error(`client-modules: require("${id}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`)
		}
		if (id === 'react') return runtime.React
		if (id === 'react/jsx-runtime') return jsxRuntime
		if (options.breakOptional === true) {
			throw new Error(`client-modules: require("${id}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`)
		}
		return primitives
	}

	return { records, requireCalls, fakeRequire, runtime, env, source }
}

/* ──────────────────────────────── fake ctx ─────────────────────────────── */

/**
 * A settings scope stub that records writes and notifies subscribers.
 * @param {object} [initial] - initial section value.
 * @returns the scope stub.
 */
function createScope(initial = {}) {
	const state = {
		status: 'ready',
		value: { enabled: false, mode: 'tailscale', port: 8787, ...initial },
		user: {},
		writable: true,
		mode: 'host',
		revision: 1,
	}
	const listeners = new Set()
	const calls = []
	return {
		calls,
		state,
		getSnapshot() { return state },
		subscribe(listener) {
			listeners.add(listener)
			return () => { listeners.delete(listener) }
		},
		set(field, value) {
			calls.push(['set', field, value])
			state.value = { ...state.value, [field]: value }
			state.user = { ...state.user, [field]: value }
			state.revision += 1
			for (const listener of listeners) listener()
			return Promise.resolve()
		},
		unset(field) {
			calls.push(['unset', field])
			const next = { ...state.value }
			delete next[field]
			state.value = next
			const user = { ...state.user }
			delete user[field]
			state.user = user
			state.revision += 1
			for (const listener of listeners) listener()
			return Promise.resolve()
		},
	}
}

/**
 * A locale face stub mirroring the real service: `bind` returns the key on a miss.
 * @returns the locale stub.
 */
function createLocale() {
	const dictionaries = new Map()
	const listeners = new Set()
	const calls = []
	const switches = []
	let active = 'zh'
	let revision = 0
	return {
		calls,
		switches,
		get active() { return active },
		setActive(next) {
			active = next
			revision += 1
			for (const listener of listeners) listener()
		},
		setLocale(next) {
			switches.push(next)
			active = next
			revision += 1
			for (const listener of listeners) listener()
		},
		getSnapshot: () => ({ active, locales: ['zh', 'en'], revision }),
		subscribe(listener) {
			listeners.add(listener)
			return () => { listeners.delete(listener) }
		},
		register(ns, locale, dict) {
			calls.push([ns, locale, dict])
			dictionaries.set(`${ns}:${locale}`, dict)
			revision += 1
			for (const listener of listeners) listener()
			return () => { dictionaries.delete(`${ns}:${locale}`) }
		},
		bind(ns) {
			return (key, params) => {
				const dict = dictionaries.get(`${ns}:${active}`) ?? dictionaries.get(`${ns}:en`)
				const template = dict?.[key]
				if (template === undefined) return key
				if (params === undefined) return template
				return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
			}
		},
	}
}

/** A theme service stub recording preference writes. */
function createTheme() {
	const calls = []
	let preference = 'system'
	let fontSize = 14
	return {
		calls,
		get preference() { return preference },
		get fontSize() { return fontSize },
		setTheme(id) { calls.push(['setTheme', id]); preference = id },
		setFontSize(px) { calls.push(['setFontSize', px]); fontSize = px },
	}
}

/**
 * A plugin context stub recording slot calls, effects, and scope binds.
 * @param {{ scope?: object, locale?: object, brokenSettingsScope?: boolean, withoutSettingsScope?: boolean, withoutLocale?: boolean }} [options] - knobs.
 * @returns the context stub.
 */
function createCtx(options = {}) {
	const registrations = []
	const injections = []
	const effects = []
	const bindSpecs = []
	const scope = options.scope ?? createScope()
	const locale = options.locale ?? createLocale()
	const ctx = {
		registrations,
		injections,
		effects,
		bindSpecs,
		scope,
		locale,
		slots: {
			inject(name, callback) {
				injections.push({ name, callback })
				return () => {}
			},
			register(slotOptions, component) {
				registrations.push({ options: slotOptions, component })
				return () => {}
			},
		},
		effect(callback, label) {
			effects.push({ label })
			const disposer = callback()
			return () => { if (typeof disposer === 'function') disposer() }
		},
	}
	if (options.withoutSettingsScope !== true) {
		Object.defineProperty(ctx, 'settingsScope', {
			enumerable: true,
			get() {
				// Exactly what a cordis context does for a service nobody provides.
				if (options.brokenSettingsScope === true) throw new Error('cannot get property "settingsScope" without inject')
				return { bind(spec) { bindSpecs.push(spec); return scope } }
			},
		})
	}
	if (options.withoutLocale !== true) ctx.locale = locale
	ctx.theme = options.theme ?? createTheme()
	return ctx
}

/* ──────────────────────────────── tree utils ───────────────────────────── */

/**
 * Walk every node of a rendered tree (text nodes included).
 * @param {unknown} node - tree or subtree.
 * @param {(node: unknown) => void} visit - visitor.
 */
function walk(node, visit) {
	if (node === null || node === undefined) return
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit)
		return
	}
	visit(node)
	if (typeof node === 'object' && node.props !== undefined) walk(node.props.children, visit)
}

/**
 * Concatenate every text node under a tree.
 * @param {unknown} node - tree or subtree.
 * @returns {string} the text.
 */
function textOf(node) {
	let text = ''
	walk(node, (item) => {
		if (typeof item === 'string') text += item + ' '
	})
	return text
}

/**
 * Every node matching a predicate.
 * @param {unknown} node - tree or subtree.
 * @param {(node: object) => boolean} predicate - matcher.
 * @returns {object[]} the matches.
 */
function findAll(node, predicate) {
	const matches = []
	walk(node, (item) => {
		if (typeof item === 'object' && predicate(item)) matches.push(item)
	})
	return matches
}

/**
 * The first node carrying `props[prop] === value`.
 * @param {unknown} node - tree or subtree.
 * @param {string} prop - prop name.
 * @param {unknown} value - expected value.
 * @returns {object|undefined} the match.
 */
function findByProp(node, prop, value) {
	return findAll(node, item => item.props?.[prop] === value)[0]
}

/** Let every pending promise chain settle. */
async function settle() {
	for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/* ──────────────────────────────── the tests ────────────────────────────── */

test('bundle registers exactly one lazy factory under the package id', async () => {
	const { records, requireCalls } = await loadBundle()

	assert.equal(records.length, 1, 'one __ModuleLoader__.load call')
	assert.equal(records[0].id, 'dsh-tailscale-access', 'bundle id matches the package name the host serves')
	assert.equal(typeof records[0].factory, 'function', 'factory is a function')
	assert.deepEqual(requireCalls, [], 'executing the script must not materialize the factory (lazy CJS contract)')
})

test('factory exposes a cordis plugin face and requires only real module faces', async () => {
	const { records, requireCalls, fakeRequire } = await loadBundle()
	const exports = records[0].factory(fakeRequire)

	assert.equal(typeof exports.apply, 'function', 'apply is exported')
	assert.ok(Array.isArray(exports.inject), 'inject is exported as an array')
	assert.ok(exports.inject.includes('slots'), 'the card requires the slots service')

	for (const id of requireCalls) {
		assert.ok(ALLOWED_MODULES.has(id), `require("${id}") is not a verified module face`)
	}
	assert.ok(requireCalls.includes('react'), 'react is required')
	assert.ok(requireCalls.includes('react/jsx-runtime'), 'the automatic JSX runtime is required')
})

test('apply registers the card into plugins.item with the frozen identity', async () => {
	const { records, fakeRequire } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()

	exports.apply(ctx)

	assert.equal(ctx.bindSpecs.length, 0, 'no settings scope is bound: remote pages cannot use one (see README)')
	assert.equal(ctx.injections.length, 2, 'two slot injections: one per supported channel')
	assert.deepEqual(ctx.injections.map((entry) => entry.name), ['plugins.item', 'settings.plugin.item'], '0.1.6 card slot plus the namespace-keyed rc.2 slot')

	const disposer = ctx.injections[0].callback()
	assert.equal(typeof disposer, 'function', 'the registration returns a disposer')
	const legacyDisposer = ctx.injections[1].callback()
	assert.equal(typeof legacyDisposer, 'function', 'the rc.2 registration returns a disposer too')
	assert.equal(ctx.registrations.length, 2, 'the card is registered into both slots')
	assert.equal(ctx.registrations[1].options.name, 'settings.plugin.item')
	assert.equal(ctx.registrations[1].options.key, 'remote-access', 'the rc.2 slot is keyed by the settings namespace')
	assert.equal(ctx.registrations[1].options.locale, 'remote-access', 'and declares the dictionary namespace')
	assert.equal(ctx.registrations[0].component, ctx.registrations[1].component, 'the same component serves both channels')
	const registration = ctx.registrations[0]
	assert.equal(registration.options.name, 'plugins.item')
	assert.equal(registration.options.id, 'remote-access')
	assert.equal(registration.options.order, 50)
	assert.equal(typeof registration.options.label, 'function', 'the label is a thunk so it follows the active locale')
	assert.equal(registration.options.label(), '远程访问', 'Chinese label')
	assert.equal(registration.options.locale, undefined, 'the locale seat is not declared (see README)')
	assert.equal(typeof registration.component, 'function', 'the component is registered')

	ctx.locale.setActive('en')
	assert.equal(registration.options.label(), 'Remote Access', 'English label follows the locale switch')

	const dictionaries = ctx.locale.calls.map(call => `${call[0]}:${call[1]}`)
	assert.deepEqual(dictionaries.sort(), ['remote-access:en', 'remote-access:zh'], 'both dictionaries are registered')
})

test('the label falls back to the bundled dictionary when no locale face exists', async () => {
	const { records, fakeRequire } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx({ withoutLocale: true })

	exports.apply(ctx)
	assert.equal(ctx.injections.length, 2, 'the card still registers into both slots without a locale service')
	assert.equal(ctx.injections[0].callback() !== undefined, true)
	assert.equal(ctx.registrations[0].options.label(), '远程访问', 'bundled Chinese dictionary answers')
})

test('the summary view renders text and does not poll', async () => {
	const { records, fakeRequire, runtime, env } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	const tree = runtime.render(Card({ view: 'summary' }))
	assert.ok(tree !== null && tree !== undefined, 'summary renders something')
	assert.ok(textOf(tree).includes('手机'), 'summary explains the feature')

	assert.equal(env.fetchCalls.length, 0, 'the card list must not hit the status endpoint')
	assert.equal(env.intervalPeriods().length, 0, 'the card list must not start a timer')
})

test('the page view renders, polls the relative status path, and cleans up on unmount', async () => {
	const { records, fakeRequire, runtime, env } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	const tree = runtime.render(Card({ view: 'page' }))
	assert.ok(tree !== null && tree !== undefined, 'the page renders')
	assert.equal(findAll(tree, item => item.props?.['data-ra-view'] === 'page').length, 1, 'the panel root is present')
	assert.ok(env.fetchCalls.length >= 1, 'the first poll fires immediately')

	const statusCall = env.fetchCalls[0]
	assert.equal(statusCall.url, '/remote-access/status.json', 'status is fetched over the relative path')
	assert.equal(statusCall.url.startsWith('http'), false, 'never an absolute URL')
	assert.equal(statusCall.options.method, 'GET')
	assert.equal(statusCall.options.cache, 'no-store')

	const periods = env.intervalPeriods()
	assert.equal(periods.length, 1, 'exactly one polling timer')
	assert.ok(periods[0] >= 1000 && periods[0] <= 2000, `poll period ${periods[0]}ms is inside the required 1–2s window`)
	assert.ok(env.listeners.get('visibilitychange')?.size >= 1, 'polling pauses while the page is hidden')

	runtime.unmount()
	assert.equal(env.intervalPeriods().length, 0, 'unmount clears the polling timer')
	assert.ok(env.clock.cleared.some(entry => entry[0] === 'interval'), 'clearInterval was called')
	assert.equal(env.listeners.get('visibilitychange')?.size ?? 0, 0, 'the visibility listener is removed')
})

test('a failing status endpoint degrades to "not connected" and never throws', async () => {
	const env = createEnvironment(() => { throw new Error('ECONNREFUSED') })
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	const tree = runtime.render(Card({ view: 'page' }))
	await settle()
	assert.ok(tree !== null, 'the panel still renders')
	assert.ok(textOf(tree).includes('未连接'), 'the panel says it is not connected')

	const httpEnv = createEnvironment(() => ({ ok: false, status: 503, json: async () => ({}) }))
	const second = await loadBundle({ env: httpEnv })
	const secondExports = second.records[0].factory(second.fakeRequire)
	const secondCtx = createCtx()
	secondExports.apply(secondCtx)
	secondCtx.injections[0].callback()
	const secondTree = second.runtime.render(secondCtx.registrations[0].component({ view: 'page' }))
	await settle()
	assert.ok(textOf(secondTree).includes('未连接'), 'an HTTP error is contained too')
})

test('missing optional modules degrade with a notice instead of failing the plugin', async () => {
	const { records, fakeRequire, runtime } = await loadBundle({ breakOptional: true })
	const exports = records[0].factory(fakeRequire)
	// The diagnostics array is created inside the VM realm; copy it before comparing.
	assert.deepEqual(
		Array.from(exports.__remoteAccessDiagnostics.missingModules),
		['@deepseek-ai/dsh-client-ui-primitives'],
		'the missing face is recorded',
	)

	const ctx = createCtx()
	exports.apply(ctx)
	assert.equal(ctx.injections.length, 2, 'the card still waits for both slots')
	ctx.injections[0].callback()
	assert.equal(ctx.registrations.length, 1, 'the card still registers')
	const tree = runtime.render(ctx.registrations[0].component({ view: 'page' }))
	assert.ok(textOf(tree).includes('缺少依赖'), 'the panel shows the missing-dependency notice')
})

test('a broken or absent settings service degrades the card, not the settings page', async () => {
	for (const options of [{ brokenSettingsScope: true }, { withoutSettingsScope: true }]) {
		const { records, fakeRequire, runtime } = await loadBundle()
		const exports = records[0].factory(fakeRequire)
		const ctx = createCtx(options)

		exports.apply(ctx)
		assert.equal(ctx.injections.length, 2, 'the card waits for both slots without a settings service')
		ctx.injections[0].callback()
		assert.equal(ctx.registrations.length, 1, 'the card registers without a settings service')
		const tree = runtime.render(ctx.registrations[0].component({ view: 'page' }))
		assert.ok(tree !== null && tree !== undefined, 'the panel renders')
		assert.ok(textOf(tree).includes('settingsScope'), 'the panel explains the missing service')
	}
})

test('the master switch and the mode select write through the host action API', async () => {
	const CONFIG = {
	enabled: false, mode: 'tailscale', port: 8787, sessionHours: 72,
	allowedUsers: [], allowedCidrs: [], cloudflaredPath: '', allowDownload: true,
	acknowledgeRisk: false, audit: true, statusPage: true, bind: '',
	passwordSet: false, configOverridden: false,
}
	const env = createEnvironment((url) => {
		if (url === '/remote-access/action') return { ok: true, status: 200, json: async () => ({ ok: true, result: { config: CONFIG } }) }
		return { ok: true, status: 200, json: async () => ({ enabled: false, mode: 'tailscale', phase: 'stopped', clients: [], updatedAt: Date.now(), config: CONFIG }) }
	})
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()

	const toggle = findByProp(tree, 'data-ra-input', 'enabled')
	assert.ok(toggle !== undefined, 'the master switch exists')
	assert.equal(toggle.props.checked, false, 'it reflects the config the host reported')
	toggle.props.onChange({ target: { checked: true } })
	await settle()
	const first = env.fetchCalls.filter((call) => call.url === '/remote-access/action')
	assert.equal(first.length, 1, 'the switch writes immediately')
	assert.equal(first[0].options.method, 'POST')
	assert.equal(first[0].options.headers['x-remote-access-action'], '1', 'the host requires this header')
	assert.deepEqual(JSON.parse(first[0].options.body), { action: 'set', patch: { enabled: true } })

	tree = runtime.render(Card({ view: 'page' }))
	const select = findByProp(tree, 'data-ra-input', 'mode')
	assert.ok(select !== undefined, 'the mode select exists')
	assert.equal(select.props.value, 'tailscale', 'it reflects the host config')
	select.props.onChange({ target: { value: 'quick' } })
	await settle()
	const second = env.fetchCalls.filter((call) => call.url === '/remote-access/action')[1]
	assert.deepEqual(JSON.parse(second.options.body), { action: 'set', patch: { mode: 'quick' } }, 'the select writes through the same API')
})
test('text fields stage edits and only the save writes them', async () => {
	const CONFIG = {
	enabled: false, mode: 'tailscale', port: 8787, sessionHours: 72,
	allowedUsers: [], allowedCidrs: [], cloudflaredPath: '', allowDownload: true,
	acknowledgeRisk: false, audit: true, statusPage: true, bind: '',
	passwordSet: false, configOverridden: false,
}
	const env = createEnvironment((url) => {
		if (url === '/remote-access/action') return { ok: true, status: 200, json: async () => ({ ok: true, result: { config: CONFIG } }) }
		return { ok: true, status: 200, json: async () => ({ enabled: false, mode: 'tailscale', phase: 'stopped', clients: [], updatedAt: Date.now(), config: CONFIG }) }
	})
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()

	const saveBefore = findByProp(tree, 'data-ra-action', 'save')
	assert.equal(saveBefore.props.disabled, true, 'save is blocked while nothing is staged')

	findByProp(tree, 'data-ra-input', 'port').props.onChange({ target: { value: '9090' } })
	tree = runtime.render(Card({ view: 'page' }))
	const saveAfter = findByProp(tree, 'data-ra-action', 'save')
	assert.equal(saveAfter.props.disabled, false, 'save unlocks once a field is staged')
	assert.equal(env.fetchCalls.filter((call) => call.url === '/remote-access/action').length, 0, 'staging alone writes nothing')

	saveAfter.props.onClick()
	await settle()
	const action = env.fetchCalls.find((call) => call.url === '/remote-access/action')
	assert.ok(action !== undefined, 'save posts the staged field')
	assert.deepEqual(JSON.parse(action.options.body), { action: 'set', patch: { port: 9090 } }, 'the save writes the staged number')
})
test('kicking a client posts the action body with the required headers', async () => {
	const status = {
		enabled: true,
		mode: 'tailscale',
		phase: 'running',
		url: 'https://box.tailnet.ts.net',
		clients: [
			{
				id: 'phone@example.com',
				kind: 'identity',
				identity: 'phone@example.com',
				name: 'Phone',
				ip: '100.64.0.5',
				since: Date.now() - 60000,
				lastSeen: Date.now(),
				requests: 12,
				websockets: 1,
				active: true,
			},
		],
		denied: 2,
		updatedAt: Date.now(),
	}
	const env = createEnvironment((url) => {
		if (url === '/remote-access/action') return { ok: true, status: 200, json: async () => ({ ok: true, result: { kicked: 1 } }) }
		return { ok: true, status: 200, json: async () => status }
	})
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	await settle()

	assert.ok(textOf(tree).includes('phone@example.com'), 'the client row shows the tailnet identity')
	assert.ok(textOf(tree).includes('Tailscale IP') === false, 'the table does not leak unrelated fields')

	const kick = findByProp(tree, 'data-ra-action', 'kick')
	assert.ok(kick !== undefined, 'each client row carries a kick button')
	assert.equal(kick.props['data-ra-kick'], 'phone@example.com')

	kick.props.onClick()
	tree = runtime.render(Card({ view: 'page' }))
	const armed = findByProp(tree, 'data-ra-action', 'kick')
	assert.equal(armed.props.children, '确认踢掉？', 'the first click only arms the button')
	assert.equal(env.fetchCalls.filter(call => call.url === '/remote-access/action').length, 0, 'arming posts nothing')

	armed.props.onClick()
	await settle()

	const action = env.fetchCalls.find(call => call.url === '/remote-access/action')
	assert.ok(action !== undefined, 'the second click posts the action')
	assert.equal(action.options.method, 'POST')
	assert.equal(action.options.headers['content-type'], 'application/json')
	assert.equal(action.options.headers['x-remote-access-action'], '1', 'the action header the host requires')
	assert.deepEqual(JSON.parse(action.options.body), { action: 'kick', id: 'phone@example.com' })
})

test('the restart action posts through the same endpoint', async () => {
	const env = createEnvironment((url) => {
		if (url === '/remote-access/action') return { ok: true, status: 200, json: async () => ({ ok: true, result: { restarted: true } }) }
		return { ok: true, status: 200, json: async () => ({ enabled: true, mode: 'tailscale', phase: 'error', clients: [], updatedAt: Date.now() }) }
	})
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	await settle()

	const restart = findByProp(tree, 'data-ra-action', 'restart')
	assert.ok(restart !== undefined, 'the restart control exists')
	restart.props.onClick()
	await settle()

	const action = env.fetchCalls.find(call => call.url === '/remote-access/action')
	assert.ok(action !== undefined, 'restart posts to the action endpoint')
	assert.deepEqual(JSON.parse(action.options.body), { action: 'restart' })
})

test('preflight failures render copyable repair commands', async () => {
	const env = createEnvironment(() => ({
		ok: true,
		status: 200,
		json: async () => ({
			enabled: false,
			mode: 'tailscale',
			phase: 'error',
			clients: [],
			tailscale: {
				installed: false,
				running: false,
				error: {
					code: 'TAILSCALE_NOT_INSTALLED',
					message: 'tailscale was not found',
					hint: 'install tailscale first',
					command: 'curl -fsSL https://tailscale.com/install.sh | sh',
				},
			},
			lastError: {
				code: 'TAILSCALE_NOT_INSTALLED',
				message: 'tailscale was not found',
				hint: 'install tailscale first',
				command: 'curl -fsSL https://tailscale.com/install.sh | sh',
				at: Date.now(),
			},
			updatedAt: Date.now(),
		}),
	}))
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	await settle()

	const text = textOf(tree)
	assert.ok(text.includes('tailscale 未安装'), 'the failed preflight check is listed')
	assert.ok(text.includes('curl -fsSL https://tailscale.com/install.sh | sh'), 'the repair command is rendered')
	assert.ok(text.includes('最近错误'), 'the last error block is rendered')

	const copies = findAll(tree, item => item.props?.['data-ra-copy'] === 'command')
	assert.ok(copies.length >= 1, 'repair commands carry a copy control')
})

test('the copy control uses the primitives face and falls back to the plain clipboard API', async () => {
	const copied = []
	const env = createEnvironment(() => ({
		ok: true,
		status: 200,
		json: async () => ({ phase: 'running', mode: 'tailscale', url: 'https://box.tailnet.ts.net', clients: [], updatedAt: Date.now() }),
	}))

	// 1. The optional primitives face is present: it must be the one used.
	const withPrimitives = await loadBundle({
		env,
		primitives: { writeClipboard: async (text) => { copied.push(text); return true } },
	})
	const exports = withPrimitives.records[0].factory(withPrimitives.fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	let tree = withPrimitives.runtime.render(ctx.registrations[0].component({ view: 'page' }))
	await settle()
	tree = withPrimitives.runtime.render(ctx.registrations[0].component({ view: 'page' }))
	const copy = findByProp(tree, 'data-ra-copy', 'url')
	assert.ok(copy !== undefined, 'the entry URL carries a copy control')
	copy.props.onClick()
	await settle()
	assert.deepEqual(copied, ['https://box.tailnet.ts.net'], 'the primitives clipboard face received the URL')

	// 2. Without the optional face the panel still copies, through navigator.clipboard.
	const fallbackCopied = []
	const second = await loadBundle({
		breakOptional: true,
		navigator: { language: 'zh-CN', clipboard: { writeText: async (text) => { fallbackCopied.push(text) } } },
		env: createEnvironment(() => ({
			ok: true,
			status: 200,
			json: async () => ({ phase: 'running', mode: 'tailscale', url: 'https://box.tailnet.ts.net', clients: [], updatedAt: Date.now() }),
		})),
	})
	const secondExports = second.records[0].factory(second.fakeRequire)
	const secondCtx = createCtx()
	secondExports.apply(secondCtx)
	secondCtx.injections[0].callback()
	let secondTree = second.runtime.render(secondCtx.registrations[0].component({ view: 'page' }))
	await settle()
	secondTree = second.runtime.render(secondCtx.registrations[0].component({ view: 'page' }))
	findByProp(secondTree, 'data-ra-copy', 'url').props.onClick()
	await settle()
	assert.deepEqual(fallbackCopied, ['https://box.tailnet.ts.net'], 'the fallback clipboard path works')
})

test('a configuration change made elsewhere shows up through the status poll', async () => {
	let config = {
		enabled: true, mode: 'tailscale', port: 8787, sessionHours: 72,
		allowedUsers: [], allowedCidrs: [], cloudflaredPath: '', allowDownload: true,
		acknowledgeRisk: false, audit: true, statusPage: true, bind: '',
		passwordSet: false, configOverridden: true,
	}
	const env = createEnvironment(() => ({ ok: true, status: 200, json: async () => ({ enabled: true, mode: config.mode, phase: 'running', clients: [], updatedAt: Date.now(), config }) }))
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	assert.equal(findByProp(tree, 'data-ra-input', 'mode').props.value, 'tailscale', 'initial mode from the host config')

	// Somebody else writes the section (CLI, another tab): the next status poll
	// carries the new config, and the card re-renders from it — no cached fork.
	config = { ...config, mode: 'quick' }
	const [listener] = [...env.listeners.get('visibilitychange')]
	listener()
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	assert.equal(findByProp(tree, 'data-ra-input', 'mode').props.value, 'quick', 'the card follows an external write')
	assert.ok(textOf(tree).includes('此入口可执行命令'), 'the quick-mode risk notice appears')
})
test('polling pauses while the page is hidden and resumes when it returns', async () => {
	const { records, fakeRequire, runtime, env } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	runtime.render(ctx.registrations[0].component({ view: 'page' }))
	await settle()

	const [listener] = [...env.listeners.get('visibilitychange')]
	assert.equal(typeof listener, 'function', 'the panel listens for visibility changes')
	const before = env.fetchCalls.length

	env.document.visibilityState = 'hidden'
	listener()
	assert.equal(env.intervalPeriods().length, 0, 'a hidden page stops polling')
	assert.equal(env.fetchCalls.length, before, 'and stops fetching')

	env.document.visibilityState = 'visible'
	listener()
	assert.equal(env.intervalPeriods().length, 1, 'a visible page resumes polling')
	assert.ok(env.fetchCalls.length > before, 'and refreshes immediately')
})

test('the panel never renders a token, a password, or a session secret (F-UI-8)', async () => {
	const env = createEnvironment(() => ({
		ok: true,
		status: 200,
		json: async () => ({
			enabled: true,
			mode: 'quick',
			phase: 'running',
			url: 'https://words.trycloudflare.com',
			localUrl: 'http://127.0.0.1:8787',
			port: 8787,
			clients: [{ id: '100.64.0.5', kind: 'ip', ip: '100.64.0.5', since: Date.now(), lastSeen: Date.now(), requests: 1, websockets: 0, active: true }],
			denied: 0,
			updatedAt: Date.now(),
		}),
	}))
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	let tree = runtime.render(ctx.registrations[0].component({ view: 'page' }))
	await settle()
	tree = runtime.render(ctx.registrations[0].component({ view: 'page' }))

	const text = textOf(tree).toLowerCase()
	for (const forbidden of ['token', 'password', 'secret', '口令', '密码', 'cookie']) {
		assert.equal(text.includes(forbidden), false, `the panel must not render "${forbidden}"`)
	}
})

test('the host-settings loader is hidden on a loopback page', async () => {
	const { records, fakeRequire, runtime } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const tree = runtime.render(ctx.registrations[0].component({ view: 'page' }))
	await settle()
	assert.equal(findByProp(tree, 'data-ra-action', 'load-host-settings'), undefined, 'loopback pages already read the document themselves')
})

test('a remote page loads the host settings and applies language and appearance', async () => {
	const env = createEnvironment((url) => {
		if (url === '/remote-access/host-settings.json') {
			return { ok: true, status: 200, json: async () => ({ locale: 'zh', theme: { preference: 'dark', fontSize: 16 }, sections: { locale: { preference: 'zh' } }, readAt: Date.now() }) }
		}
		return { ok: true, status: 200, json: async () => ({ enabled: true, mode: 'tailscale', phase: 'running', clients: [], updatedAt: Date.now(), config: { enabled: true, mode: 'tailscale', port: 8787, passwordSet: false, configOverridden: true } }) }
	})
	const { records, fakeRequire, runtime } = await loadBundle({ env, location: { hostname: 'phone.tailnet-abc.ts.net' } })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	const button = findByProp(tree, 'data-ra-action', 'load-host-settings')
	assert.ok(button !== undefined, 'a remote page gets the loader button')
	assert.ok(textOf(tree).includes('读取宿主设置'), 'and an explanation of why it is needed')

	button.props.onClick()
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	assert.deepEqual(ctx.locale.switches, ['zh'], 'the host language is applied to this page')
	assert.deepEqual(ctx.theme.calls, [['setTheme', 'dark'], ['setFontSize', 16]], 'and so is the host appearance')
	assert.ok(textOf(tree).includes('已应用到本页'), 'the card reports what it applied')
	assert.ok(textOf(tree).includes('宿主设置：语言=zh'), 'and what the host document said')

	const request = env.fetchCalls.find((call) => call.url === '/remote-access/host-settings.json')
	assert.ok(request !== undefined, 'the read went through the plugin route')
	assert.equal(request.options.credentials, 'same-origin')
})

test('a failing host-settings read degrades to a message', async () => {
	const env = createEnvironment((url) => {
		if (url === '/remote-access/host-settings.json') return { ok: false, status: 500, json: async () => ({}) }
		return { ok: true, status: 200, json: async () => ({ enabled: false, mode: 'tailscale', phase: 'stopped', clients: [], updatedAt: Date.now() }) }
	})
	const { records, fakeRequire, runtime } = await loadBundle({ env, location: { hostname: 'phone.example.com' } })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	findByProp(tree, 'data-ra-action', 'load-host-settings').props.onClick()
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	assert.ok(textOf(tree).includes('读取失败'), 'the failure is reported, not thrown')
	assert.deepEqual(ctx.locale.switches, [], 'nothing is applied on failure')
})

test('the card renders in the rc.2 slot, which passes no view prop', async () => {
	const { records, fakeRequire, runtime } = await loadBundle()
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	// Second injection = the namespace-keyed `settings.plugin.item` of 0.1.5-rc.2.
	// Only that slot is filled here, so the registration lands at index 0.
	ctx.injections[1].callback()
	assert.equal(ctx.registrations.length, 1, 'only the rc.2 slot was filled')
	assert.equal(ctx.registrations[0].options.name, 'settings.plugin.item')
	const LegacyCard = ctx.registrations[0].component

	// The rc.2 page renders the registered card without the Plugins-page `view`
	// prop; the component must fall through to the panel instead of the summary.
	const tree = runtime.render(LegacyCard({}))
	await settle()
	assert.equal(findAll(tree, (item) => item.props?.['data-ra-view'] === 'page').length, 1, 'the full panel renders')
	assert.equal(findAll(tree, (item) => item.props?.['data-ra-view'] === 'summary').length, 0, 'not the one-line summary')
})

test('quick mode is not offered in the panel while it is under test', async () => {
	const status = (mode) => ({
		enabled: false, mode, phase: 'stopped', clients: [], updatedAt: Date.now(),
		config: { enabled: false, mode, port: 8787, sessionHours: 72, allowedUsers: [], allowedCidrs: [], cloudflaredPath: '', allowDownload: true, acknowledgeRisk: false, audit: true, statusPage: true, bind: '', passwordSet: false, configOverridden: false },
	})
	let mode = 'tailscale'
	const env = createEnvironment(() => ({ ok: true, status: 200, json: async () => status(mode) }))
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	const optionsOf = (tree) => findAll(tree, (item) => item.type === 'option').map((item) => item.props.value)
	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	assert.deepEqual(optionsOf(tree), ['tailscale', 'none'], 'a default configuration is only offered the supported modes')
	assert.equal(findAll(tree, (item) => item.props?.['data-ra-input'] === 'cloudflaredPath').length, 0, 'quick-only fields stay hidden too')

	// A configuration that already selects quick (settings section, older build) must
	// still render truthfully — with the warning and the testing note.
	mode = 'quick'
	const [listener] = [...env.listeners.get('visibilitychange')]
	listener()
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	assert.deepEqual(optionsOf(tree), ['tailscale', 'quick', 'none'], 'the active quick mode is still selectable')
	assert.equal(findByProp(tree, 'data-ra-input', 'mode').props.value, 'quick', 'the select reports what the host actually runs')
	assert.ok(textOf(tree).includes('此入口可执行命令'), 'the public-exposure warning still appears')
	assert.ok(textOf(tree).includes('仍在测试中'), 'and the testing note explains why it is not offered')
	assert.equal(findAll(tree, (item) => item.props?.['data-ra-input'] === 'cloudflaredPath').length, 1, 'its cloudflared path field returns with it')
})

test('restart is offered only while the entry is enabled', async () => {
	const base = { mode: 'tailscale', phase: 'stopped', clients: [], updatedAt: Date.now() }
	let enabled = false
	const env = createEnvironment(() => ({
		ok: true, status: 200,
		json: async () => ({ ...base, enabled, config: { enabled, mode: 'tailscale', port: 8787, passwordSet: false, configOverridden: true } }),
	}))
	const { records, fakeRequire, runtime } = await loadBundle({ env })
	const exports = records[0].factory(fakeRequire)
	const ctx = createCtx()
	exports.apply(ctx)
	ctx.injections[0].callback()
	const Card = ctx.registrations[0].component

	let tree = runtime.render(Card({ view: 'page' }))
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	let restart = findByProp(tree, 'data-ra-action', 'restart')
	assert.equal(restart.props.disabled, true, 'a stopped entry has nothing to restart')
	assert.ok(textOf(tree).includes('总开关未打开'), 'and the card says why instead of doing nothing')

	// The retry case: enabled but failed. This is exactly when restart matters.
	enabled = true
	const [listener] = [...env.listeners.get('visibilitychange')]
	listener()
	await settle()
	tree = runtime.render(Card({ view: 'page' }))
	restart = findByProp(tree, 'data-ra-action', 'restart')
	assert.equal(restart.props.disabled, false, 'an enabled entry can always be rebuilt')
	assert.equal(textOf(tree).includes('总开关未打开'), false)
})
