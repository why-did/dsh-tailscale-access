/**
 * Lead-owned tests: configuration normalization and plugin errors.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, pluginError, resolveConfig, resolveBind, passwordRequired } from '../lib/index.js'
test('resolveConfig: schema defaults and normalization', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.mode, 'tailscale')
  assert.equal(defaults.enabled, false)
  assert.equal(defaults.port, 8787)
  assert.deepEqual(defaults.allowedUsers, [])
  assert.equal('serveHttps' in defaults, false, 'the plaintext-era switch no longer exists')
  assert.equal(defaults.sessionHours, 72)

  const odd = resolveConfig({
    mode: 'nonsense', port: 80, sessionHours: 0,
    allowedUsers: ['a', 1], allowedCidrs: 'nope',
  })
  assert.equal(odd.mode, 'tailscale', 'unknown mode falls back to tailscale')
  assert.equal(odd.port, 8787, 'out-of-range port falls back to the default')
  assert.equal(odd.sessionHours, 72)
  assert.deepEqual(odd.allowedUsers, ['a', '1'])
  assert.deepEqual(odd.allowedCidrs, [])
})

test('schema and defaults agree on the mode list', () => {
  const resolved = Config({})
  for (const mode of ['tailscale', 'quick', 'none']) {
    assert.equal(resolveConfig({ mode }).mode, mode)
    assert.equal(resolveConfig({ ...resolved, mode }).mode, mode)
  }
})

test('resolveBind: follows the mode unless explicitly widened', () => {
  assert.equal(resolveBind({ bind: '' }), '127.0.0.1')
  assert.equal(resolveBind({ bind: '0.0.0.0' }), '0.0.0.0')
})

test('passwordRequired: everything without an identity gate needs a password', () => {
  assert.equal(passwordRequired('tailscale'), false)
  assert.equal(passwordRequired('quick'), true)
  assert.equal(passwordRequired('none'), true)
})

test('pluginError carries a stable code plus repair text', () => {
  const error = pluginError('X', 'boom', { hint: 'h', command: 'c' })
  assert.equal(error.code, 'X')
  assert.equal(error.message, 'boom')
  assert.equal(error.hint, 'h')
  assert.equal(error.command, 'c')
  assert.ok(error instanceof Error)
})
