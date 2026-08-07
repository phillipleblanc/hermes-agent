/**
 * Tests for electron/gateway-ws-probe-renderer.ts.
 *
 * The renderer probe executes a generated script string in the app's
 * webContents. Here we run that script in a Node vm context with a fake
 * WebSocket, so the generated classification logic is exercised directly
 * (open, frame, error, early close, pre-open close, timeout), plus the
 * executor's degraded paths (no webContents / destroyed / no executeJavaScript).
 */

import assert from 'node:assert/strict'
import vm from 'node:vm'

import { test } from 'vitest'

import { probeGatewayWebSocketInRenderer, rendererWsProbeScript } from './gateway-ws-probe-renderer'

// Note: results crossing the vm boundary come from a different realm, so
// deepStrictEqual's prototype checks fail on them — assert on primitives.
function makeFakeWs() {
  const instances = []

  class FakeWs {
    url
    closed = false
    listeners = {}
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.closed = false
      instances.push(this)
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] ||= []).push(fn)
    }
    close() {
      this.closed = true
    }
    emit(type, event) {
      for (const fn of this.listeners[type] || []) {
        fn(event)
      }
    }
  }

  return { FakeWs, instances }
}

function runScript(url, { connectTimeoutMs = 1_000, readyGraceMs = 10 } = {}) {
  const { FakeWs, instances } = makeFakeWs()
  const context = {
    WebSocket: FakeWs,
    setTimeout,
    clearTimeout,
    console
  }
  vm.createContext(context)
  const promise = vm.runInContext(rendererWsProbeScript(url, connectTimeoutMs, readyGraceMs), context, {
    timeout: connectTimeoutMs + 5_000
  })

  return { promise, instances }
}

test('renderer probe script embeds the ws url verbatim', () => {
  const url = 'wss://agent.leblanc.tech/api/ws?ticket=t"x'
  const script = rendererWsProbeScript(url, 1_000, 10)
  // The URL is JSON-stringified into the script: the embedded literal must round-trip.
  assert.ok(script.includes(JSON.stringify(url)))
  assert.ok(!/\bconst url = 'wss/.test(script))
})

test('resolves ok when the socket opens and stays open (grace window)', async () => {
  const { promise, instances } = runScript('wss://host/api/ws?token=t')
  instances[0].emit('open')
  // Settles after the 10ms grace window — not before.
  const early = await Promise.race([
    promise.then(r => r),
    new Promise(r => setTimeout(() => r('pending'), 2))
  ])
  assert.equal(early, 'pending')
  const result = await promise
  assert.equal(instances[0].closed, true)
  assert.equal(result.ok, true)
  assert.equal(result.reason, undefined)
})

test('resolves ok immediately when a frame arrives', async () => {
  const { promise, instances } = runScript('wss://host/api/ws?token=t', {
    connectTimeoutMs: 1_000,
    readyGraceMs: 10_000 // long grace: success must come from the frame
  })
  instances[0].emit('open')
  instances[0].emit('message', { data: '{"jsonrpc":"2.0"}' })
  const result = await promise
  assert.equal(result.ok, true)
  assert.equal(result.reason, undefined)
})

test('fails when the socket errors (TLS-level rejection surfaces as error)', async () => {
  const { promise, instances } = runScript('wss://host/api/ws?token=t')
  instances[0].emit('error', {})
  const result = await promise
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'WebSocket connection failed.')
})

test('fails with credential-rejected reason when closed right after open', async () => {
  const { promise, instances } = runScript('wss://host/api/ws?token=t')
  instances[0].emit('open')
  instances[0].emit('close', { code: 1008 })
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(result.reason, /accepted the connection then closed it \(credential rejected\?\)/)
  assert.match(result.reason, /code 1008/)
})

test('fails with pre-open reason when closed before open', async () => {
  const { promise, instances } = runScript('wss://host/api/ws?token=t')
  instances[0].emit('close', { code: 1006 })
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(result.reason, /closed the WebSocket before it opened/)
})

test('times out when the socket never opens', async () => {
  const { promise } = runScript('wss://host/api/ws?token=t', { connectTimeoutMs: 30, readyGraceMs: 10 })
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(result.reason, /Timed out after 30ms/)
})

test('first settlement wins — late events are ignored', async () => {
  const { promise, instances } = runScript('wss://host/api/ws?token=t')
  instances[0].emit('open')
  const result = await promise
  assert.equal(result.ok, true)
  // Post-settle events must not throw or re-settle.
  instances[0].emit('close', { code: 1006 })
})

test('probeGatewayWebSocketInRenderer returns the script result from webContents', async () => {
  const executed = []
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async script => {
      executed.push(script)
      return { ok: true }
    }
  }
  const result = await probeGatewayWebSocketInRenderer(webContents, 'wss://host/api/ws?token=t')
  assert.deepEqual(result, { ok: true })
  assert.equal(executed.length, 1)
  assert.ok(executed[0].includes('wss://host/api/ws?token=t'))
})

test('probeGatewayWebSocketInRenderer returns null for missing/destroyed webContents', async () => {
  assert.equal(await probeGatewayWebSocketInRenderer(null, 'wss://host/api/ws'), null)
  assert.equal(await probeGatewayWebSocketInRenderer({ isDestroyed: () => true }, 'wss://host/api/ws'), null)
})

test('probeGatewayWebSocketInRenderer returns null when executeJavaScript throws', async () => {
  const webContents = {
    isDestroyed: () => false,
    executeJavaScript: async () => {
      throw new Error('Cannot execute JS while document is loading')
    }
  }
  assert.equal(await probeGatewayWebSocketInRenderer(webContents, 'wss://host/api/ws'), null)
})
