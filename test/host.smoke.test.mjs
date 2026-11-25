/**
 * Host-level smoke test: activate the plugin against a fake Cordis context and
 * drive the real waterfalls, routes and state file. This is the check that must
 * pass before the bundle is installed, because it exercises the wiring that the
 * pure unit tests cannot see.
 *
 * Run with: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-key-state-'))
process.env.DSH_MULTI_KEY_STATE_DIR = STATE_DIR

/** Controllable biller so no test ever touches the network. */
const biller = { remaining: 900, fail: false }
globalThis.fetch = async () => {
  if (biller.fail) throw new Error('ECONNREFUSED')
  return {
    ok: true,
    status: 200,
    json: async () => ({ windows: [{ limit: 1000, used: 1000 - biller.remaining, remaining: biller.remaining }], unit: 'credits' }),
  }
}

const host = await import('../host.js')

/** A minimal Cordis context with the services this plugin touches. */
function createHarness() {
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  const credentialStore = new Map()
  /** sessionId -> SessionHeader, for the main/child lane decision. */
  const sessionHeaders = new Map()
  /** The host-session gate the routes ask before touching keys. */
  const connection = { available: true, rejection: undefined, allowsRemoteAuthorities: false }

  const credentials = {
    async set(ref, value) {
      credentialStore.set(ref, value)
    },
    async unset(ref) {
      credentialStore.delete(ref)
    },
    async resolve(ref) {
      const value = credentialStore.get(ref)
      return value ? { value } : undefined
    },
  }

  const ctx = {
    logger: () => ({ debug() {} }),
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const live = listeners.get(name) ?? []
        const index = live.indexOf(handler)
        if (index >= 0) live.splice(index, 1)
      }
    },
    effect(fn) {
      const result = fn()
      disposers.push(typeof result === 'function' ? result : () => {})
    },
    get(name) {
      if (name === 'credentials') return credentials
      // The routes ask Connection whether this caller carries an authenticated
      // host session before they touch a stored API key.
      if (name === 'connection') {
        if (!connection.available) return undefined
        return {
          requestRejection: () => connection.rejection,
          allowsRemoteAuthorities: connection.allowsRemoteAuthorities,
        }
      }
      // The lane decision reads the session header, which is the only place the
      // parentage of a delegated session is recorded.
      if (name === 'sessions') {
        return {
          get: (id) => (sessionHeaders.has(id) ? { header: sessionHeaders.get(id) } : undefined),
        }
      }
      // The profile declares its providers in the llm-pi-ai settings entry, which
      // is exactly what the panel catalog is supposed to read.
      if (name === 'settings') {
        return {
          describe: () => [
            {
              ns: 'llm-pi-ai',
              value: {
                providers: {
                  ecnu: {
                    displayName: 'ECNU',
                    baseURL: 'https://chat.ecnu.edu.cn/open/api/v1',
                    api: 'openai-completions',
                    models: [
                      { id: 'ecnu-max', name: 'ecnu-max' },
                      { id: 'ecnu-plus', name: 'ecnu-plus' },
                    ],
                  },
                },
              },
            },
          ],
        }
      }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'ecnu', name: 'ecnu' }],
          listModels: async (provider) =>
            provider === 'ecnu' ? [{ provider: 'ecnu', id: 'ecnu-max', name: 'ecnu-max' }] : [],
          listConfigurableProviders: () => [
            { provider: 'ecnu', defaultBaseURL: 'https://chat.ecnu.edu.cn/open/api/v1' },
          ],
        }
      }
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }

  const listener = (name) => {
    const list = listeners.get(name)
    assert.ok(list && list.length > 0, `no listener registered for ${name}`)
    return list[0]
  }

  const call = (suffix, method, body, overrides = {}) =>
    new Promise((resolve, reject) => {
      const route = routes.get(`/api/multi-key-orchestrator/${suffix}`)
      if (!route) {
        reject(new Error(`no route for ${suffix}`))
        return
      }
      const handlers = {}
      const request = {
        method,
        // A real browser call is loopback-addressed and same-origin; the route
        // guard checks exactly that, so the fixture must look the same — socket
        // peer included, since the peer address is what decides.
        headers: { host: '127.0.0.1:13769', origin: 'http://127.0.0.1:13769' },
        socket: { remoteAddress: '127.0.0.1', remotePort: 51999 },
        ...overrides,
        on(event, handler) {
          handlers[event] = handlers[event] ?? []
          handlers[event].push(handler)
          return request
        },
        destroy() {},
      }
      const response = {
        statusCode: 0,
        writeHead(code) {
          this.statusCode = code
        },
        end(chunk) {
          const text = chunk ?? ''
          resolve({ code: this.statusCode, body: text ? JSON.parse(text) : undefined })
        },
      }
      setImmediate(() => {
        const payload = request.__rawBody !== undefined
          ? Buffer.from(request.__rawBody)
          : body !== undefined
            ? Buffer.from(JSON.stringify(body))
            : undefined
        if (payload !== undefined) {
          for (const handler of handlers.data ?? []) handler(payload)
        }
        for (const handler of handlers.end ?? []) handler()
      })
      route.handler(request, response)
    })

  return {
    ctx,
    routes,
    credentialStore,
    sessions: sessionHeaders,
    connection,
    listener,
    call,
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          /* disposal order is not under test */
        }
      }
    },
  }
}

/** Consume an async iterable into an array. */
async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const SUCCESS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hel' },
  { type: 'text-delta', index: 0, text: 'lo' },
  { type: 'finish', reason: { kind: 'stop' } },
]
const RATE_LIMIT = [
  { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded', providerRetryAfterMs: 15_000 } } },
]
const MID_STREAM_429 = [
  { type: 'text-delta', index: 0, text: 'partial answer' },
  { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded', providerRetryAfterMs: 20_000 } } },
]

/** A 429 whose wording the classifier cannot place: the field case that used to
 *  be re-thrown instead of rotated, because the adapter sent no status field. */
const UNKNOWN_429 = [
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: 'RATE_LIMIT', message: '429 {"detail":"请求过于频繁，超过应用的每168小时 credits 限制"}' },
    },
  },
]

/** The image budget refusal that another plugin repairs by offloading images. */
const IMAGE_BUDGET = [
  {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'IMAGE_OFFLOAD_REQUIRED',
        message: 'pi-ai request images exceed the route image budget; 1 more oldest occurrence(s) must be offloaded.',
      },
    },
  },
]
const BAD_KEY = [
  { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', status: 401, message: 'invalid api key' } } },
]

const stream = (chunks) => () =>
  (async function* replay() {
    for (const chunk of chunks) yield chunk
  })()

const OPTIONS = { provider: 'ecnu', model: 'ecnu-max', sessionId: 'root-session', messages: [] }

/** Boot one harness, seed a pool, and hand back the pieces each test needs. */
async function boot({ mode = 'passive', stateDir } = {}) {
  // Every boot gets its own state directory unless a test explicitly reuses one,
  // so a harness never inherits keys whose secrets live in another harness.
  process.env.DSH_MULTI_KEY_STATE_DIR = stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'multi-key-state-'))
  const harness = createHarness()
  host.apply(harness.ctx)
  harness.stateDir = process.env.DSH_MULTI_KEY_STATE_DIR
  await harness.call('config', 'POST', { op: 'set-quota', mode })
  return harness
}

async function addKeys(harness, count = 2) {
  for (let index = 1; index <= count; index += 1) {
    const result = await harness.call('config', 'POST', {
      op: 'add-provider-key',
      provider: 'ecnu',
      note: `key ${index}`,
      value: `sk-secret-value-${index}00000000`,
    })
    assert.equal(result.body.ok, true, JSON.stringify(result.body))
  }
}

test('the plugin registers its listeners, routes and a state file', async () => {
  const harness = await boot()
  try {
    for (const name of ['llm/stream', 'llm-pi-ai/request-headers', 'agent/request-error']) {
      assert.ok(harness.listener(name), name)
    }
    for (const suffix of ['status', 'config', 'probe', 'selftest']) {
      assert.ok(harness.routes.has(`/api/multi-key-orchestrator/${suffix}`), suffix)
    }
    const status = await harness.call('status', 'GET')
    assert.equal(status.code, 200)
    assert.equal(status.body.status.enabled, false)
    assert.equal(status.body.status.pools.length, 0)
    assert.equal(status.body.status.credentials.available, true)
  } finally {
    harness.dispose()
  }
})

test('with the toggle off the stream is handed through untouched', async () => {
  const harness = await boot()
  try {
    await addKeys(harness)
    const streamListener = harness.listener('llm/stream')
    const chunks = await collect(streamListener(OPTIONS, stream(SUCCESS)))
    assert.deepEqual(chunks, SUCCESS)
    const status = await harness.call('status', 'GET')
    assert.equal(status.body.status.correlation.leases, 0, 'a disabled plugin must never lease a key')
  } finally {
    harness.dispose()
  }
})

test('two keys create a pool whose cap is derived from the key count', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    const status = await harness.call('status', 'GET')
    const pool = status.body.status.pools[0]
    assert.equal(pool.provider, 'ecnu')
    assert.equal(pool.model, 'ecnu-max')
    assert.equal(pool.maxConcurrent, 6, '3 concurrent requests per key times 2 keys')
    assert.equal(pool.reservedForMain, 1)
    assert.equal(pool.lane.childCapacity, 5)
    assert.equal(pool.keys.length, 2)
    for (const key of pool.keys) {
      assert.equal(key.maskedLabel, '••••••', 'the mask is constant: no key characters are ever rendered')
      assert.equal(key.ref, undefined, 'the credential ref is not part of the wire shape')
      assert.ok(typeof key.note === 'string' && key.note.length > 0, 'each key carries a note')
      assert.equal(key.maxConcurrent, 3, 'an unset per-key cap defaults to three, never to unlimited')
    }
    assert.ok(!JSON.stringify(status.body).includes('sk-secret-value-1'), 'no secret may appear in status')
    const stateFile = path.join(harness.stateDir, 'state.json')
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    // Keys belong to the provider now, so the file keeps one list per provider.
    assert.equal(saved.providers.ecnu.keys.length, 2)
    assert.equal(saved.pools.length, 2, 'two keys open a pool per model the provider owns')
    assert.ok(!JSON.stringify(saved).includes('sk-secret-value-1'), 'the state file stores refs, not secrets')
    assert.equal(harness.credentialStore.size, 2)
  } finally {
    harness.dispose()
  }
})

test('a pooled request swaps the auth header to the leased key secret', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    const headerListener = harness.listener('llm-pi-ai/request-headers')

    // Drive the stream far enough to observe the header preparation the way the
    // pi-ai adapter would: inside the same call, before tokens arrive.
    let headerResult
    const next = () => {
      const headers = new Headers({ authorization: 'Bearer native-single-key', 'x-request-id': 'r1' })
      headerListener(
        { provider: 'ecnu', model: 'ecnu-max', sessionId: 'root-session', purpose: undefined, baseURL: 'https://chat.ecnu.edu.cn/open/api/v1' },
        headers,
        () => headers,
      )
      headerResult = headers.get('authorization')
      return (async function* replay() {
        for (const chunk of SUCCESS) yield chunk
      })()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(chunks.at(-1).type, 'finish')
    assert.ok(
      ['Bearer sk-secret-value-100000000', 'Bearer sk-secret-value-200000000'].includes(headerResult),
      `unexpected authorization header: ${headerResult}`,
    )
    const status = await harness.call('status', 'GET')
    assert.equal(status.body.status.correlation.swaps, 1)
    assert.equal(status.body.status.correlation.leases, 1)
  } finally {
    harness.dispose()
  }
})

test('a pre-content 429 never calls next twice and asks the loop for a retry', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let calls = 0
    const next = () => {
      calls += 1
      if (calls > 1) throw new Error('next() called multiple times')
      return stream(RATE_LIMIT)()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(calls, 1, 'exactly one next() per dispatch — calling it twice kills the turn')
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'MULTI_KEY_RETRY', 'the loop is asked to re-run on another key')

    const status = await harness.call('status', 'GET')
    const cooling = status.body.status.pools[0].keys.find((key) => key.state === 'cooldown')
    assert.ok(cooling, 'the offending key is cooling')

    // The retry request is honoured by the request-error listener, without it
    // ever calling its own next().
    const errorListener = harness.listener('agent/request-error')
    let downstreamCalled = false
    const action = await errorListener(
      { agent: { id: OPTIONS.sessionId }, provider: 'ecnu', failure: finish.reason.failure },
      async () => {
        downstreamCalled = true
        return undefined
      },
    )
    assert.deepEqual(action, { kind: 'retry' }, 'a retryable rotation is converted into a retry action')
    assert.equal(downstreamCalled, false, 'a handling listener vetoes the downstream default')
  } finally {
    harness.dispose()
  }
})

test('a 401 is surfaced without rotating the key', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let calls = 0
    const next = () => {
      calls += 1
      return stream(BAD_KEY)()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(calls, 1, 'a structural failure must not be retried')
    assert.equal(chunks.at(-1).reason.failure.status, 401)
    const status = await harness.call('status', 'GET')
    assert.ok(status.body.status.pools[0].keys.every((key) => key.state !== 'cooldown'), 'no key was parked')
  } finally {
    harness.dispose()
  }
})

test('a spent balance refuses the request instead of calling the provider', async () => {
  biller.remaining = 0
  const harness = await boot({ mode: 'active' })
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let called = false
    const next = () => {
      called = true
      return stream(SUCCESS)()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(called, false, 'an exhausted pool must not spend a request')
    assert.equal(chunks.at(-1).reason.failure.code, 'MULTI_KEY_POOL_EXHAUSTED')
  } finally {
    biller.remaining = 900
    harness.dispose()
  }
})

test('a mid-stream 429 is handed to the loop as a retry and the partial text is drained', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    const requestError = harness.listener('agent/request-error')

    const chunks = await collect(streamListener(OPTIONS, stream(MID_STREAM_429)))
    assert.equal(chunks[0].text, 'partial answer', 'already-emitted content reaches the consumer and is discarded by the loop')
    assert.equal(chunks.at(-1).reason.kind, 'error')

    const action = requestError(
      { agent: { id: 'root-session' }, turn: 1, step: 1, provider: 'ecnu', failure: {}, retryPolicy: undefined },
      () => undefined,
    )
    assert.deepEqual(action, { kind: 'retry' }, 'the plugin took ownership of the recovery')

    const status = await harness.call('status', 'GET')
    assert.ok(status.body.status.log.some((entry) => entry.action === 'midstream-retry'))
  } finally {
    harness.dispose()
  }
})

test('a mid-stream 429 is not retried once the retry budget is spent', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    await harness.call('config', 'POST', { op: 'set-retry', midStreamRetry: true, midStreamMaxRetries: 0 })
    const streamListener = harness.listener('llm/stream')
    const requestError = harness.listener('agent/request-error')
    await collect(streamListener(OPTIONS, stream(MID_STREAM_429)))
    let delegated = false
    const action = await requestError(
      { agent: { id: 'root-session' }, provider: 'ecnu', failure: {} },
      () => {
        delegated = true
        return undefined
      },
    )
    assert.equal(delegated, true, 'a spent budget leaves the decision downstream')
    assert.equal(action, undefined)
  } finally {
    harness.dispose()
  }
})

test('the self-test reports the reserved slot and a draining FIFO', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    const result = await harness.call('selftest', 'POST', { concurrency: 8 })
    assert.equal(result.body.ok, true, JSON.stringify(result.body))
    const summary = result.body.summary
    assert.equal(summary.maxConcurrent, 6)
    assert.equal(summary.childCapacity, 5)
    assert.equal(summary.peak.total, 6, 'the pool ran at its cap')
    assert.equal(summary.peak.child, 5, 'children filled exactly their lane')
    assert.equal(summary.peak.main, 1, 'the main process held the reserved slot')
    assert.equal(summary.waitingAtMidway, 3, 'the three overflow children queued')
    assert.equal(summary.granted, 9, 'every queued child was eventually granted once slots drained')
    assert.equal(summary.mainGranted, 1)
    assert.equal(summary.failures.length, 0)
  } finally {
    harness.dispose()
  }
})

test('a cooling key is excluded from the self-test allocation', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    const result = await harness.call('selftest', 'POST', { concurrency: 4, inject429: 'first' })
    assert.equal(result.body.ok, true)
    assert.ok(result.body.log.some((entry) => entry.action === 'cooldown'), 'the injected 429 parked a key')
    assert.ok(result.body.summary.childGranted >= 1)
  } finally {
    harness.dispose()
  }
})

test('turning the toggle off restores the pass-through path', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    await harness.call('config', 'POST', { op: 'toggle', enabled: false })
    const streamListener = harness.listener('llm/stream')
    const before = (await harness.call('status', 'GET')).body.status.correlation.leases
    const chunks = await collect(streamListener(OPTIONS, stream(SUCCESS)))
    assert.deepEqual(chunks, SUCCESS)
    const after = (await harness.call('status', 'GET')).body.status.correlation.leases
    assert.equal(after, before, 'no key is leased while disabled')
  } finally {
    harness.dispose()
  }
})

test('state survives a restart of the plugin', async () => {
  const first = await boot()
  const sharedDir = first.stateDir
  await addKeys(first, 2)
  await first.call('config', 'POST', { op: 'toggle', enabled: true })
  const firstStatus = await first.call('status', 'GET')
  first.dispose()

  const second = await boot({ stateDir: sharedDir })
  try {
    const status = await second.call('status', 'GET')
    assert.equal(status.body.status.enabled, true, 'the toggle survived a reload')
    assert.equal(status.body.status.pools.length, firstStatus.body.status.pools.length)
    assert.equal(status.body.status.pools[0].keys.length, 2)
    assert.equal(status.body.status.pools[0].maxConcurrent, 6)
  } finally {
    second.dispose()
  }
})

test('an unknown op is reported instead of silently ignored', async () => {
  const harness = await boot()
  try {
    const result = await harness.call('config', 'POST', { op: 'not-a-real-op' })
    assert.equal(result.body.ok, false)
    assert.match(result.body.error, /unknown op/)
  } finally {
    harness.dispose()
  }
})

test('the catalog lists the providers and models the profile declares', async () => {
  const harness = await boot()
  try {
    const status = await harness.call('status', 'GET')
    const catalog = status.body.status.catalog
    assert.ok(Array.isArray(catalog), 'status must expose a catalog')
    assert.ok(catalog.length > 0, 'the settings entry provided no provider to show')
    const ecnu = catalog.find((entry) => entry.provider === 'ecnu')
    assert.ok(ecnu, 'the declared provider is missing from the catalog')
    assert.equal(ecnu.displayName, 'ECNU')
    assert.equal(ecnu.baseURL, 'https://chat.ecnu.edu.cn/open/api/v1')
    assert.deepEqual(
      ecnu.models.map((model) => model.id),
      ['ecnu-max', 'ecnu-plus'],
      'every model declared in settings must be listed without the user typing it',
    )
    for (const entry of catalog) {
      assert.ok(typeof entry.provider === 'string' && entry.provider.length > 0)
      assert.ok(typeof entry.displayName === 'string')
      assert.ok(Array.isArray(entry.models))
    }
    const providers = status.body.status.providers
    assert.ok(Array.isArray(providers))
  } finally {
    harness.dispose()
  }
})

test('a provider-wide cap is stored and reported', async () => {
  const harness = await boot()
  try {
    const saved = await harness.call('config', 'POST', { op: 'set-provider', provider: 'ecnu', maxConcurrent: 2 })
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    const status = await harness.call('status', 'GET')
    const entry = status.body.status.providers.find((row) => row.provider === 'ecnu')
    assert.ok(entry, 'the provider cap must be reported even without a pool')
    assert.equal(entry.maxConcurrent, 2)
    assert.equal(entry.activeLeases, 0)
  } finally {
    harness.dispose()
  }
})

test('a model cap can be set before any key exists', async () => {
  const harness = await boot()
  try {
    // A manual total needs the link switch off: while linked, the total is the
    // sum of the per-API caps and a typed number would be overwritten.
    const saved = await harness.call('config', 'POST', {
      op: 'set-pool',
      provider: 'ecnu',
      model: 'ecnu-max',
      maxConcurrent: 9,
      linked: false,
    })
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    const pool = (await harness.call('status', 'GET')).body.status.pools[0]
    assert.equal(pool.maxConcurrent, 9)
    assert.equal(pool.keys.length, 0)
    assert.equal(pool.linked, false)
    assert.equal(pool.maxConcurrentAuto, false)
  } finally {
    harness.dispose()
  }
})

test('a provider key keeps a note and a per-model concurrency cap', async () => {
  const harness = await boot()
  try {
    await harness.call('config', 'POST', {
      op: 'add-provider-key',
      provider: 'ecnu',
      note: 'work account',
      value: 'sk-secret-value-100000000',
    })
    const saved = await harness.call('config', 'POST', {
      op: 'update-provider-key',
      provider: 'ecnu',
      keyId: 'k1',
      note: 'personal account',
    })
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    const providerKey = (await harness.call('status', 'GET')).body.status.providers.find(
      (row) => row.provider === 'ecnu',
    ).keys[0]
    assert.equal(providerKey.note, 'personal account', 'the note is renamed at provider level')
    assert.equal(providerKey.maskedLabel, '••••••')
    assert.equal(providerKey.source, 'added')

    // One provider key, one different cap per model.
    const capped = await harness.call('config', 'POST', {
      op: 'set-key-cap',
      provider: 'ecnu',
      model: 'ecnu-max',
      keyId: 'k1',
      maxConcurrent: 2,
    })
    assert.equal(capped.body.ok, true, JSON.stringify(capped.body))
    const status = await harness.call('status', 'GET')
    const pool = status.body.status.pools.find((row) => row.model === 'ecnu-max')
    assert.equal(pool.keys[0].maxConcurrent, 2, 'the cap belongs to this model')
    const plus = status.body.status.pools.find((row) => row.model === 'ecnu-plus')
    assert.equal(plus?.keys[0]?.maxConcurrent ?? 0, 3, 'a different model keeps its own default cap')
  } finally {
    harness.dispose()
  }
})

test('the status route never probes the biller', async () => {
  const harness = await boot({ mode: 'active' })
  try {
    await addKeys(harness, 2)
    // Let the add-key probes settle, then freeze the cache and prove that
    // repeated status reads do not move it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const first = await harness.call('status', 'GET')
    const checkedAt = first.body.status.pools[0].keys.map((key) => key.quota?.checkedAt)
    for (let index = 0; index < 5; index += 1) await harness.call('status', 'GET')
    const after = await harness.call('status', 'GET')
    assert.deepEqual(
      after.body.status.pools[0].keys.map((key) => key.quota?.checkedAt),
      checkedAt,
      'GET /status must be a pure cache read',
    )
  } finally {
    harness.dispose()
  }
})

test('a request that dies mid-flight gives its lease back', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')

    const before = (await harness.call('status', 'GET')).body.status.pools.find((row) => row.model === 'ecnu-max')
    assert.equal(before.lane.total, 0)

    // The upstream explodes instead of finishing: the lease must not stay held,
    // otherwise a crashed agent would quietly shrink the pool forever.
    const broken = () =>
      (async function* explode() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        throw new Error('socket hung up')
      })()
    await collect(streamListener({ ...OPTIONS }, broken)).catch(() => [])

    const after = (await harness.call('status', 'GET')).body.status.pools.find((row) => row.model === 'ecnu-max')
    assert.equal(after.lane.total, 0, 'the dead request leaked its lease')
    for (const key of after.keys) assert.equal(key.activeLeases, 0, `${key.id} still holds a lease`)

    // And the pool still serves the next request on a key.
    const chunks = await collect(streamListener({ ...OPTIONS }, stream(SUCCESS)))
    assert.equal(chunks.at(-1).type, 'finish')
  } finally {
    harness.dispose()
  }
})

test('one conversation rotates through every key, request after request', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 3)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    const headerListener = harness.listener('llm-pi-ai/request-headers')

    /** @type {string[]} */
    const used = []
    const keyOf = (authorization) => {
      for (const [keyId, secret] of harness.credentialStore) {
        if (authorization === `Bearer ${secret}`) return keyId
      }
      return undefined
    }

    // Strictly sequential: one main-lane request at a time, like a chat turn.
    for (let index = 0; index < 6; index += 1) {
      const next = () => {
        const headers = new Headers({ authorization: 'Bearer native-single-key' })
        headerListener(
          { provider: 'ecnu', model: 'ecnu-max', sessionId: 'root-session', purpose: undefined, baseURL: 'https://chat.ecnu.edu.cn/open/api/v1' },
          headers,
          () => headers,
        )
        const keyId = keyOf(headers.get('authorization'))
        assert.ok(keyId, 'the request was not routed through the pool')
        used.push(keyId)
        return (async function* replay() {
          for (const chunk of SUCCESS) yield chunk
        })()
      }
      await collect(streamListener({ ...OPTIONS }, next))
    }

    assert.equal(used.length, 6)
    // Six sequential requests over three keys must be 2/2/2, not 6/0/0.
    const counts = new Map()
    for (const keyId of used) counts.set(keyId, (counts.get(keyId) ?? 0) + 1)
    assert.equal(counts.size, 3, `only ${counts.size} key(s) were used: ${JSON.stringify([...counts])}`)
    for (const [keyId, count] of counts) assert.equal(count, 2, `${keyId} served ${count} of 6 sequential requests`)
  } finally {
    harness.dispose()
  }
})

test('concurrent traffic spreads evenly and never exceeds either cap', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 3)
    // Two leases per key, so the model total (linked) is 6.
    for (const keyId of ['k1', 'k2', 'k3']) {
      const saved = await harness.call('config', 'POST', {
        op: 'set-key-cap',
        provider: 'ecnu',
        model: 'ecnu-max',
        keyId,
        maxConcurrent: 2,
      })
      assert.equal(saved.body.ok, true, JSON.stringify(saved.body))
    }
    const pool = (await harness.call('status', 'GET')).body.status.pools.find((row) => row.model === 'ecnu-max')
    assert.equal(pool.maxConcurrent, 6, 'three keys at two leases each')
    assert.equal(pool.linked, true)

    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    const headerListener = harness.listener('llm-pi-ai/request-headers')

    /** @type {Map<string, number>} */
    const inFlight = new Map()
    /** @type {Map<string, number>} */
    const served = new Map()
    let peakTotal = 0
    let peakPerKey = 0

    const secretOwner = (authorization) => {
      for (const [keyId, secret] of harness.credentialStore) {
        if (authorization === `Bearer ${secret}`) return keyId
      }
      return undefined
    }

    const oneRequest = async () => {
      const next = () => {
        const headers = new Headers({ authorization: 'Bearer native-single-key' })
        headerListener(
          { provider: 'ecnu', model: 'ecnu-max', sessionId: 's1', purpose: undefined, baseURL: 'https://chat.ecnu.edu.cn/open/api/v1' },
          headers,
          () => headers,
        )
        const keyId = secretOwner(headers.get('authorization'))
        assert.ok(keyId, `the header was not replaced with a pooled secret: ${headers.get('authorization')}`)
        assert.ok(harness.credentialStore.has(keyId), 'the leased key must exist in the credential store')
        const running = (inFlight.get(keyId) ?? 0) + 1
        inFlight.set(keyId, running)
        peakPerKey = Math.max(peakPerKey, running)
        const total = [...inFlight.values()].reduce((sum, value) => sum + value, 0)
        peakTotal = Math.max(peakTotal, total)
        served.set(keyId, (served.get(keyId) ?? 0) + 1)
        return (async function* replay() {
          try {
            for (const chunk of SUCCESS) {
              await new Promise((resolve) => setTimeout(resolve, 15))
              yield chunk
            }
          } finally {
            inFlight.set(keyId, (inFlight.get(keyId) ?? 1) - 1)
          }
        })()
      }
      return collect(streamListener({ ...OPTIONS }, next))
    }

    const results = await Promise.all(Array.from({ length: 12 }, () => oneRequest()))
    for (const chunks of results) assert.equal(chunks.at(-1).type, 'finish')

    const totalServed = [...served.values()].reduce((sum, value) => sum + value, 0)
    assert.equal(totalServed, 12, 'every request reached a key')
    assert.equal(served.size, 3, 'all three keys took part')
    assert.ok(peakTotal <= 6, `the pool total was exceeded: ${peakTotal}`)
    assert.ok(peakPerKey <= 2, `a per-key cap was exceeded: ${peakPerKey}`)

    // "Roughly even": 12 requests over 3 keys is 4 each; allow one in flight.
    for (const [keyId, count] of served) {
      assert.ok(count >= 3 && count <= 5, `${keyId} served ${count} of 12 requests`)
    }
  } finally {
    harness.dispose()
  }
})

test('a 429 thrown by the adapter is cooled and asks the loop to rotate', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let calls = 0
    const next = () => {
      calls += 1
      if (calls > 1) throw new Error('next() called multiple times')
      // A transport-level failure: the adapter raises instead of yielding a
      // finish chunk.
      return (async function* boom() {
        throw Object.assign(new Error('429 model_concurrency_exceeded: max_concurrency 5, active 5'), { status: 429 })
      })()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(calls, 1, 'one next() per dispatch')
    assert.equal(chunks.at(-1).reason.failure.code, 'MULTI_KEY_RETRY')
    const status = await harness.call('status', 'GET')
    assert.equal(status.body.status.log.filter((entry) => entry.action === 'cooldown').length, 1)
    assert.equal(status.body.status.pools[0].keys.filter((key) => key.state === 'cooldown').length, 1)
  } finally {
    harness.dispose()
  }
})

test('a thrown 429 is recognised from the message when no status is attached', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let calls = 0
    const next = () => {
      calls += 1
      if (calls > 1) throw new Error('next() called multiple times')
      return (async function* boom() {
        throw new Error('HTTP 429: model_concurrency_exceeded')
      })()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(calls, 1)
    assert.equal(chunks.at(-1).reason.failure.code, 'MULTI_KEY_RETRY', 'the status was recovered from the message')
  } finally {
    harness.dispose()
  }
})

test('a delegated session is charged to the child lane, a root session to main', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    harness.sessions.set('root-session', { id: 'root-session', isSeeded: false })
    harness.sessions.set('child-session', {
      id: 'child-session',
      isSeeded: true,
      parentSession: 'root-session',
      origin: 'subagent',
      delegationDepth: 1,
    })
    const streamListener = harness.listener('llm/stream')
    await collect(streamListener(OPTIONS, stream(SUCCESS)))
    await collect(streamListener({ ...OPTIONS, sessionId: 'child-session' }, stream(SUCCESS)))
    const status = await harness.call('status', 'GET')
    const lanes = status.body.status.log
      .filter((entry) => entry.action === 'acquire')
      .map((entry) => entry.lane)
      .sort()
    assert.deepEqual(lanes, ['child', 'main'], `lanes were ${JSON.stringify(lanes)}`)
  } finally {
    harness.dispose()
  }
})

test('a structural failure is recorded as a fail entry instead of vanishing', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    const chunks = await collect(streamListener(OPTIONS, stream(BAD_KEY)))
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error', 'the provider error reaches the consumer unchanged')
    const status = await harness.call('status', 'GET')
    const failed = status.body.status.log.filter((entry) => entry.action === 'fail')
    assert.equal(failed.length, 1, 'exactly one fail entry')
    assert.match(failed[0].detail, /AUTH/)
    assert.match(failed[0].detail, /401/)
  } finally {
    harness.dispose()
  }
})

test('a route refuses a remote peer even when the headers claim loopback', async () => {
  const harness = await boot()
  try {
    const remote = await harness.call('status', 'GET', undefined, {
      socket: { remoteAddress: '203.0.113.9', remotePort: 41234 },
    })
    assert.equal(remote.code, 403, 'a spoofable Host header must not admit a remote peer')
    assert.equal(remote.body.ok, false)
  } finally {
    harness.dispose()
  }
})

test('a route refuses a request whose connection cannot be inspected', async () => {
  const harness = await boot()
  try {
    // Fail closed: no socket at all means "cannot prove this is local".
    const noSocket = await harness.call('status', 'GET', undefined, { socket: undefined })
    assert.equal(noSocket.code, 403)
    const emptyPeer = await harness.call('config', 'POST', { op: 'toggle', enabled: true }, {
      socket: { remoteAddress: '', remotePort: 1 },
    })
    assert.equal(emptyPeer.code, 403)
  } finally {
    harness.dispose()
  }
})

test('a route still accepts a loopback peer', async () => {
  const harness = await boot()
  try {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const ok = await harness.call('status', 'GET', undefined, {
        socket: { remoteAddress: peer, remotePort: 51999 },
      })
      assert.equal(ok.code, 200, `${peer} should be admitted`)
    }
  } finally {
    harness.dispose()
  }
})

test('a route refuses a caller the host session does not admit', async () => {
  const harness = await boot()
  try {
    harness.connection.rejection = 403
    const denied = await harness.call('status', 'GET')
    assert.equal(denied.code, 403, 'a rejected host session must not read the panel state')

    harness.connection.rejection = 401
    const unauthenticated = await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    assert.equal(unauthenticated.code, 401)
    assert.equal(unauthenticated.body.error, 'host-session-required')

    harness.connection.rejection = undefined
    const admitted = await harness.call('status', 'GET')
    assert.equal(admitted.code, 200)
  } finally {
    harness.dispose()
  }
})

test('a route refuses every caller when the host session gate is missing', async () => {
  const harness = await boot()
  try {
    harness.connection.available = false
    // Fail closed: without Connection there is no way to authenticate the caller.
    for (const suffix of ['status', 'config', 'probe', 'selftest']) {
      const denied = await harness.call(suffix, suffix === 'status' ? 'GET' : 'POST', {})
      assert.equal(denied.code, 401, suffix)
    }
  } finally {
    harness.dispose()
  }
})

test('a trusted remote authority does not need a loopback socket', async () => {
  const harness = await boot()
  try {
    harness.connection.allowsRemoteAuthorities = true
    const admitted = await harness.call('status', 'GET', undefined, {
      socket: { remoteAddress: '203.0.113.9', remotePort: 41234 },
    })
    assert.equal(admitted.code, 200, 'the deployment already trusts that authority')
  } finally {
    harness.dispose()
  }
})

test('an adapter that throws synchronously is cooled and asks the loop to rotate', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let calls = 0
    const next = () => {
      calls += 1
      if (calls > 1) throw new Error('next() called multiple times')
      throw Object.assign(new Error('429 concurrency_exceeded'), { status: 429 })
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(calls, 1, 'the synchronous failure did not produce a second next()')
    assert.equal(chunks.at(-1).reason.failure.code, 'MULTI_KEY_RETRY')
    const status = await harness.call('status', 'GET')
    assert.equal(status.body.status.log.filter((entry) => entry.action === 'cooldown').length, 1)
  } finally {
    harness.dispose()
  }
})

test('a consumer that stops early gives its lease back', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    const iterator = streamListener(OPTIONS, stream(SUCCESS))[Symbol.asyncIterator]()
    await iterator.next()
    const mid = await harness.call('status', 'GET')
    const leasedMid = mid.body.status.pools[0].lane.total
    assert.equal(leasedMid, 1, 'the lease is held while the stream is live')
    await iterator.return(undefined)
    const after = await harness.call('status', 'GET')
    assert.equal(after.body.status.pools[0].lane.total, 0, 'closing the stream returned the lease')
  } finally {
    harness.dispose()
  }
})

test('a next() that returns no iterable fails cleanly and keeps no lease', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    await assert.rejects(async () => collect(streamListener(OPTIONS, () => undefined)))
    const status = await harness.call('status', 'GET')
    assert.equal(status.body.status.pools[0].lane.total, 0, 'no lease leaked')
  } finally {
    harness.dispose()
  }
})

test('set-key-cap refuses a request without an explicit maxConcurrent', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    const keys = (await harness.call('status', 'GET')).body.status.pools[0].keys
    const target = keys[0].id
    const set = await harness.call('config', 'POST', {
      op: 'set-key-cap', provider: 'ecnu', model: 'ecnu-max', keyId: target, maxConcurrent: 2,
    })
    assert.equal(set.body.ok, true)
    const cleared = await harness.call('config', 'POST', {
      op: 'set-key-cap', provider: 'ecnu', model: 'ecnu-max', keyId: target,
    })
    assert.equal(cleared.body.ok, false, 'a typo must not delete the cap')
    const after = (await harness.call('status', 'GET')).body.status.pools[0].keys.find((key) => key.id === target)
    assert.equal(after.maxConcurrent, 2, 'the cap survived the malformed request')
  } finally {
    harness.dispose()
  }
})

test('an oversized body is refused', async () => {
  const harness = await boot()
  try {
    const huge = { op: 'toggle', pad: 'x'.repeat(1_100_000) }
    const response = await harness.call('config', 'POST', huge)
    assert.equal(response.body.ok, false)
    assert.equal(response.code, 400)
  } finally {
    harness.dispose()
  }
})

test('malformed JSON is refused with 400', async () => {
  const harness = await boot()
  try {
    const response = await harness.call('config', 'POST', undefined, { __rawBody: '{not json' })
    assert.equal(response.code, 400)
    assert.equal(response.body.ok, false)
  } finally {
    harness.dispose()
  }
})

test('a corrupt state file does not stop the plugin from booting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-key-corrupt-'))
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json', 'utf8')
  const harness = await boot({ stateDir: dir })
  try {
    const status = await harness.call('status', 'GET')
    assert.equal(status.code, 200)
    assert.equal(status.body.ok, true)
  } finally {
    harness.dispose()
  }
})

test('a state file with the wrong shapes does not stop the plugin from booting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-key-wrongshape-'))
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ version: 2, pools: 'not-an-array', providers: 7, limits: 'nope', quota: [] }),
    'utf8',
  )
  const harness = await boot({ stateDir: dir })
  try {
    const status = await harness.call('status', 'GET')
    assert.equal(status.code, 200)
    assert.equal(status.body.ok, true)
    const added = await harness.call('config', 'POST', {
      op: 'add-provider-key', provider: 'ecnu', note: 'after corruption', value: 'sk-fresh-000000000000',
    })
    assert.equal(added.body.ok, true, 'the panel can still write after recovering')
  } finally {
    harness.dispose()
  }
})

test('an unknown config op is refused rather than silently accepted', async () => {
  const harness = await boot()
  try {
    const response = await harness.call('config', 'POST', { op: 'make-me-a-sandwich' })
    assert.equal(response.body.ok, false)
    assert.match(String(response.body.error), /unknown|unsupported|op/i)
  } finally {
    harness.dispose()
  }
})

test('an unrecognised failure still parks a key whose balance is gone', async () => {
  const harness = await boot({ mode: 'active' })
  try {
    await addKeys(harness, 2)
    const keys = (await harness.call('status', 'GET')).body.status.pools[0].keys
    for (const key of keys) {
      await harness.call('config', 'POST', {
        op: 'set-key-cap', provider: 'ecnu', model: 'ecnu-max', keyId: key.id, maxConcurrent: 3,
      })
    }
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })

    const listeners = harness.listener('llm/stream')
    // Warm the balance cache while both keys are healthy.
    await collect(listeners(OPTIONS, stream(SUCCESS)))

    // The key now fails with wording the classifier cannot place, and its own
    // balance endpoint answers "nothing left": the key must leave the rotation.
    biller.remaining = 0
    let calls = 0
    const next = () => {
      calls += 1
      if (calls > 1) throw new Error('next() called multiple times')
      return stream(UNKNOWN_429)()
    }
    const chunks = await collect(listeners(OPTIONS, next))
    assert.equal(calls, 1)
    assert.equal(chunks.at(-1).reason.failure.code, 'MULTI_KEY_RETRY')

    await new Promise((resolve) => setTimeout(resolve, 150))
    const after = (await harness.call('status', 'GET')).body.status.pools[0]
    const parked = after.keys.filter((key) => key.state === 'quota_exhausted')
    assert.equal(parked.length, 1, 'the empty key is out of rotation')
    assert.ok(after.maxConcurrent < 6, 'and its slots left the pool total')
  } finally {
    biller.remaining = 900
    harness.dispose()
  }
})

test('the overlay switch is on by default and survives a reload', async () => {
  const harness = await boot()
  try {
    const first = await harness.call('status', 'GET')
    assert.equal(first.body.status.ui.showLive, true, 'shown unless the operator says otherwise')

    const off = await harness.call('config', 'POST', { op: 'set-live-visibility', show: false })
    assert.equal(off.body.ok, true, JSON.stringify(off.body))
    assert.equal(off.body.status.ui.showLive, false)

    // The preference is state, not a tab-local flag: read it back from disk.
    const saved = JSON.parse(fs.readFileSync(path.join(harness.stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.ui.showLive, false)

    const on = await harness.call('config', 'POST', { op: 'set-live-visibility', show: true })
    assert.equal(on.body.status.ui.showLive, true)
  } finally {
    harness.dispose()
  }
})

test('the connection test asks for exactly one token and reports the round trip', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 1)
    const keyId = (await harness.call('status', 'GET')).body.status.providers[0].keys[0].id

    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '1' } }], usage: { completion_tokens: 1 } }),
      }
    }
    try {
      const result = await harness.call('config', 'POST', { op: 'test-key', provider: 'ecnu', keyId })
      assert.equal(result.body.ok, true, JSON.stringify(result.body))
      assert.equal(result.body.result.connected, true)
      assert.equal(calls.length, 1, 'exactly one request')
      const sent = calls[0].body
      assert.equal(sent.max_tokens, 1, 'one token of output')
      assert.equal(sent.messages.length, 1)
      assert.equal(sent.messages[0].content, '1', 'one character of input')
      assert.equal(sent.stream, false, 'no stream to parse')
    } finally {
      globalThis.fetch = original
    }
  } finally {
    harness.dispose()
  }
})

test('the connection test reports a dead key instead of throwing', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 1)
    const keyId = (await harness.call('status', 'GET')).body.status.providers[0].keys[0].id
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })
    try {
      const result = await harness.call('config', 'POST', { op: 'test-key', provider: 'ecnu', keyId })
      assert.equal(result.body.ok, true, 'the op itself succeeded')
      assert.equal(result.body.result.connected, false)
      assert.equal(result.body.result.status, 401)
      assert.match(String(result.body.result.detail), /invalid api key/)
    } finally {
      globalThis.fetch = original
    }
  } finally {
    harness.dispose()
  }
})

test('an image-budget refusal is surfaced once, without rotating or cooling', async () => {
  const harness = await boot()
  try {
    await addKeys(harness, 2)
    await harness.call('config', 'POST', { op: 'toggle', enabled: true })
    const streamListener = harness.listener('llm/stream')
    let calls = 0
    const next = () => {
      calls += 1
      if (calls > 1) throw new Error('next() called multiple times')
      return stream(IMAGE_BUDGET)()
    }
    const chunks = await collect(streamListener(OPTIONS, next))
    assert.equal(calls, 1, 'the request is not resent to another key')
    const finish = chunks.at(-1)
    assert.equal(finish.reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED', 'the original failure reaches the loop untouched')

    const status = await harness.call('status', 'GET')
    assert.ok(
      status.body.status.pools[0].keys.every((key) => key.state !== 'cooldown'),
      'no key was blamed for an oversized request',
    )
    assert.ok(
      !status.body.status.log.some((entry) => entry.action === 'retry'),
      'and no rotation was requested',
    )
  } finally {
    harness.dispose()
  }
})
