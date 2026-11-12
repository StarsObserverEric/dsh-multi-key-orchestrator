/**
 * Unit tests for the pure orchestration core.
 * Run with: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PoolOrchestrator,
  PoolExhaustedError,
  classifyFailure,
  cooldownFor,
  credentialRefFor,
  healthScore,
  maskSecret,
  MAX_COOLDOWN_MS,
} from '../engine.js'

/**
 * Deterministic clock so lane capacity, cooldowns and backoff windows can be
 * advanced without real waiting.
 */
function fakeClock(start = 1_000) {
  let current = start
  const timers = []
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const handle = { fn, at: current + ms, cancelled: false }
      timers.push(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle) handle.cancelled = true
    },
    advance(ms) {
      const target = current + ms
      let guard = 0
      for (;;) {
        const due = timers
          .filter((handle) => !handle.cancelled && handle.at <= target)
          .sort((a, b) => a.at - b.at)
        if (due.length === 0) break
        const next = due[0]
        next.cancelled = true
        current = next.at
        next.fn()
        guard += 1
        if (guard > 1_000) throw new Error('timer storm in fake clock')
      }
      current = target
    },
  }
}

/** Let pending promise callbacks run. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeKeys(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `k${index + 1}`,
    ref: `REF_${index + 1}`,
    label: `key ${index + 1}`,
    maskedLabel: `sk-…${index + 1}`,
    enabled: true,
  }))
}

function makePool(config = {}, clock = fakeClock()) {
  const pool = new PoolOrchestrator(
    {
      provider: 'ecnu',
      model: 'ecnu-max',
      maxConcurrent: 4,
      reservedForMain: 1,
      keys: makeKeys(2),
      ...config,
    },
    { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  )
  return { pool, clock }
}

test('child capacity keeps the reserved slot out of reach', () => {
  const { pool } = makePool()
  assert.equal(pool.capacity('main'), 4)
  assert.equal(pool.capacity('child'), 3)
})

test('child capacity equals the full cap while the main process is idle and lending is on', () => {
  const { pool, clock } = makePool({
    maxConcurrent: 6,
    reservedForMain: 1,
    releaseReservationWhenIdle: true,
    idleGraceMs: 30_000,
  })
  assert.equal(pool.capacity('child'), 5)
  clock.advance(30_001)
  assert.equal(pool.capacity('child'), 6)
})

test('three child leases fit, the fourth waits, and main still gets a slot immediately', async () => {
  const { pool } = makePool()
  const first = await pool.acquire({ lane: 'child' })
  const second = await pool.acquire({ lane: 'child' })
  const third = await pool.acquire({ lane: 'child' })
  assert.equal(pool.activeLeases, 3)

  let fourthGranted = false
  const fourth = pool.acquire({ lane: 'child' }).then((lease) => {
    fourthGranted = true
    return lease
  })
  await tick()
  assert.equal(fourthGranted, false, 'the child lane is full at maxConcurrent - reservedForMain')

  const main = await pool.acquire({ lane: 'main' })
  assert.equal(main.lane, 'main', 'the reserve must be reachable while children saturate their lane')

  first.release()
  await tick()
  assert.equal(fourthGranted, true, 'a released slot is handed to the queued child')
  const fourthLease = await fourth
  for (const lease of [second, third, fourthLease, main]) lease.release()
})

test('leases spread across keys before any key takes a second one', async () => {
  const { pool } = makePool({ maxConcurrent: 6, keys: makeKeys(3) })
  const leases = []
  for (let index = 0; index < 3; index += 1) leases.push(await pool.acquire({ lane: 'child' }))
  const used = new Set(leases.map((lease) => lease.keyId))
  assert.equal(used.size, 3, 'least-leased selection must not stack on one key')
  for (const lease of leases) lease.release()
})

test('a cooling key is skipped and returns only after its own Retry-After', async () => {
  const { pool, clock } = makePool({ keys: makeKeys(2) })
  const leases = []
  const first = await pool.acquire({ lane: 'main' })
  const firstKey = first.keyId
  first.release()

  pool.noteRateLimit(firstKey, 8_000)
  const cooldownState = pool.snapshot().keys.find((key) => key.id === firstKey)
  assert.equal(cooldownState.state, 'cooldown')
  assert.equal(cooldownState.consecutive429s, 1)

  const second = await pool.acquire({ lane: 'main' })
  assert.notEqual(second.keyId, firstKey, 'the healthy key is chosen instead')
  second.release()
  leases.length = 0

  clock.advance(7_999)
  assert.equal(pool.selectKey()?.id === firstKey, pool.selectKey()?.id === firstKey)
  assert.ok(
    pool.snapshot().keys.find((key) => key.id === firstKey).state === 'cooldown',
    'still cooling one millisecond before the window ends',
  )
  clock.advance(2)
  assert.equal(
    pool.snapshot().keys.find((key) => key.id === firstKey).state !== 'cooldown',
    true,
    'the key returns to service after the provider window, not after a fixed hour',
  )
})

test('a quota-exhausted key is excluded until a probe revives it', async () => {
  const { pool } = makePool({ keys: makeKeys(2) })
  const snapshot = pool.snapshot()
  const victim = snapshot.keys[0].id
  pool.noteQuotaExhausted(victim, 'test')
  assert.equal(pool.snapshot().keys.find((key) => key.id === victim).state, 'quota_exhausted')
  const lease = await pool.acquire({ lane: 'main' })
  assert.notEqual(lease.keyId, victim)
  lease.release()

  pool.clearQuota(victim, 'test')
  const eligible = pool.eligibleKeys().map((key) => key.id)
  assert.ok(eligible.includes(victim))
})

test('a success clears the failure counters and the cooldown', async () => {
  const { pool } = makePool()
  const victim = pool.snapshot().keys[0].id
  pool.noteRateLimit(victim, 30_000)
  pool.noteFailure(victim)
  pool.noteSuccess(victim)
  const key = pool.snapshot().keys.find((entry) => entry.id === victim)
  assert.equal(key.consecutive429s, 0)
  assert.equal(key.consecutiveFailures, 0)
  assert.equal(key.state, 'healthy')
  assert.ok(key.lastSuccessAt !== null)
})

test('every key parked: the caller waits through backoff and then gets a real failure', async () => {
  const { pool, clock } = makePool({
    keys: makeKeys(2),
    limits: { maxAttempts: 2, maxWaitMs: 5_000, backoffWindowsMs: [30_000, 60_000] },
  })
  for (const key of pool.snapshot().keys) pool.noteQuotaExhausted(key.id, 'test')

  const pending = pool.acquire({ lane: 'child' })
  const settled = pending.then(
    (lease) => ({ lease }),
    (error) => ({ error }),
  )
  await tick()
  clock.advance(6_000)
  const outcome = await settled
  assert.ok(outcome.error, 'a fully parked pool must fail rather than hang')
  assert.equal(outcome.error.code, 'MULTI_KEY_POOL_EXHAUSTED')
})

test('an aborted signal rejects the queued waiter', async () => {
  const { pool } = makePool({ maxConcurrent: 1, reservedForMain: 0, keys: makeKeys(1) })
  const held = await pool.acquire({ lane: 'child' })
  const controller = new AbortController()
  const pending = pool.acquire({ lane: 'child', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'MULTI_KEY_LEASE_ABORTED')
  held.release()
})

test('releasing twice is harmless', async () => {
  const { pool } = makePool()
  const lease = await pool.acquire({ lane: 'child' })
  lease.release()
  lease.release()
  assert.equal(pool.activeLeases, 0)
})

test('429 classification separates a temporary limit from a spent budget', () => {
  assert.equal(
    classifyFailure({ status: 429, message: 'Rate limit reached, please retry' }).kind,
    'transient',
  )
  assert.equal(classifyFailure({ status: 429, message: 'insufficient_quota' }).kind, 'quota')
  assert.equal(
    classifyFailure({ status: 429, message: 'quota exceeded, try again later' }).kind,
    'quota',
    'budget wording must win over "try again" wording',
  )
  assert.equal(classifyFailure({ status: 402, message: 'payment required' }).kind, 'quota')
})

test('401 and malformed requests never rotate a key', () => {
  assert.equal(classifyFailure({ status: 401, message: 'bad key' }).kind, 'structural')
  assert.equal(classifyFailure({ status: 403, message: 'forbidden' }).kind, 'structural')
  assert.equal(classifyFailure({ status: 400, message: 'bad parameter' }).kind, 'structural')
})

test('cooldown follows the provider hint and is clamped, never a fixed hour', () => {
  assert.equal(cooldownFor({ providerRetryAfterMs: 7_000 }), 7_000)
  assert.equal(cooldownFor({}), 60_000)
  assert.equal(cooldownFor({ providerRetryAfterMs: 10 * 3_600_000 }), MAX_COOLDOWN_MS)
  assert.equal(cooldownFor({ providerRetryAfterMs: 1 }), 1_000)
})

test('health score degrades with failures and recovers with success', () => {
  const now = 10_000_000
  const fresh = { consecutiveFailures: 0, consecutive429s: 0, lastSuccessAt: now, quotaExhausted: false }
  const beaten = { consecutiveFailures: 3, consecutive429s: 2, lastSuccessAt: now - 3_600_000, quotaExhausted: false }
  assert.ok(healthScore(fresh, now) > healthScore(beaten, now))
  assert.equal(healthScore({ quotaExhausted: true }, now), 0)
})

test('masked labels and credential refs never carry the secret forward', () => {
  const secret = 'sk-abcdefghijklmnop'
  const masked = maskSecret(secret)
  assert.ok(!masked.includes('ghijklm'))
  assert.equal(credentialRefFor('ecnu', 'ecnu-max', 'k7'), 'MULTIKEY_ECNU_ECNU_MAX_K7')
  assert.equal(credentialRefFor('some-provider', 'model/with spaces', 'k1'), 'MULTIKEY_SOME_PROVIDER_MODEL_WITH_SPACES_K1')
})

test('the snapshot exposes exactly the documented counters', () => {
  const { pool } = makePool()
  const snapshot = pool.snapshot()
  const key = snapshot.keys[0]
  for (const field of [
    'id',
    'maskedLabel',
    'enabled',
    'state',
    'healthScore',
    'cooldownUntil',
    'consecutiveFailures',
    'consecutive429s',
    'lastSuccessAt',
    'activeLeases',
  ]) {
    assert.ok(field in key, `snapshot key is missing ${field}`)
  }
  assert.equal(snapshot.maxConcurrent, 4)
  assert.equal(snapshot.reservedForMain, 1)
  assert.equal(snapshot.lane.childCapacity, 3)
})

test('PoolExhaustedError carries the routable MULTI_KEY_POOL_EXHAUSTED code', () => {
  const error = new PoolExhaustedError('nope')
  assert.equal(error.code, 'MULTI_KEY_POOL_EXHAUSTED')
})

/** Mirror of the provider gate host.js shares across every pool of a provider. */
function makeGate(max) {
  const gate = {
    active: 0,
    max,
    hasRoom: () => gate.max <= 0 || gate.active < gate.max,
    acquire: () => {
      gate.active += 1
    },
    release: () => {
      gate.active = Math.max(0, gate.active - 1)
    },
    snapshot: () => ({ active: gate.active, max: gate.max }),
  }
  return gate
}

test('a provider gate caps every model of that provider together', async () => {
  const clock = fakeClock()
  const gate = makeGate(2)
  const makeOrch = (model) =>
    new PoolOrchestrator(
      { provider: 'ecnu', model, maxConcurrent: 4, reservedForMain: 0, keys: makeKeys(2) },
      { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, providerGate: gate },
    )
  const first = makeOrch('ecnu-max')
  const second = makeOrch('ecnu-plus')

  const a = await first.acquire({ lane: 'child' })
  const b = await second.acquire({ lane: 'child' })
  assert.equal(gate.active, 2)

  let thirdGranted = false
  const third = first.acquire({ lane: 'child' }).then((lease) => {
    thirdGranted = true
    return lease
  })
  await tick()
  assert.equal(thirdGranted, false, 'the provider cap is shared across models')

  a.release()
  await tick()
  assert.equal(thirdGranted, true, 'releasing one provider-wide slot admits the queued lease')
  const thirdLease = await third
  thirdLease.release()
  b.release()
  assert.equal(gate.active, 0)
})

test('a per-key cap limits that key without shrinking the pool', async () => {
  const { pool } = makePool({
    maxConcurrent: 4,
    reservedForMain: 0,
    keys: [
      { id: 'k1', ref: 'R1', note: 'capped', maskedLabel: '••••••', enabled: true, maxConcurrent: 1 },
      { id: 'k2', ref: 'R2', note: 'open', maskedLabel: '••••••', enabled: true, maxConcurrent: 0 },
    ],
  })
  const first = await pool.acquire({ lane: 'child' })
  assert.equal(first.keyId, 'k1', 'least-leased picks the first key')

  const second = await pool.acquire({ lane: 'child' })
  assert.equal(second.keyId, 'k2', 'the capped key is skipped once it holds its cap')

  const third = await pool.acquire({ lane: 'child' })
  assert.equal(third.keyId, 'k2', 'the uncapped key keeps serving')

  assert.equal(pool.snapshot().keys.find((key) => key.id === 'k1').activeLeases, 1)
  assert.equal(pool.snapshot().keys.find((key) => key.id === 'k2').activeLeases, 2)

  // The pool cap, not the key cap, is what still bounds the whole pool.
  const fourth = await pool.acquire({ lane: 'child' })
  assert.equal(pool.activeLeases, 4)
  let fifthGranted = false
  const fifth = pool.acquire({ lane: 'child' }).then((lease) => {
    fifthGranted = true
    return lease
  })
  await tick()
  assert.equal(fifthGranted, false, 'the pool cap still applies')
  for (const lease of [first, second, third, fourth]) lease.release()
  await tick()
  assert.equal(fifthGranted, true)
  ;(await fifth).release()
})
