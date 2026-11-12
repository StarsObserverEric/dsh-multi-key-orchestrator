/**
 * Tests for the per-key quota probes and the stale-while-revalidate cache.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createQuotaService, normalizeEcnu, readJsonPath, tolerantExtract } from '../quota.js'

/** The real response body recorded in docs/quota-contract.md. */
const ECNU_BODY = {
  provider_id: 'chatecnu',
  api_key_id: 'key_5638',
  unit: 'credits',
  windows: [
    {
      type: 'fixed_168h',
      limit: 25000,
      used: 11665.54902,
      remaining: 13334.45098,
      window_started_at: '2026-11-08T23:27:28+08:00',
      reset_at: '2026-11-15T23:27:28+08:00',
      source: 'manual',
    },
  ],
  resource_packs: [
    {
      id: 437,
      name: '学习支持',
      total_credits: 5000,
      used_credits: 5014.3329,
      remaining_credits: 0,
      expires_at: '2027-01-09T16:22:17.575073+00:00',
      status: 'exhausted',
    },
  ],
  ops_console_url: 'https://aiconsole.ecnu.edu.cn',
}

test('an ECNU body separates the recurring window from one-shot packs', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00')
  const quota = normalizeEcnu(ECNU_BODY, now)
  // The headline is the 7-day window alone: adding a 5,000 pack into `total`
  // invented a 30,000 allowance the account never has.
  assert.equal(quota.total, 25000, 'total is the recurring window only')
  assert.equal(quota.remaining, 13334.451, 'spendable credits = window remainder + live packs')
  assert.equal(quota.used, 11665.549, 'used counts the window, not the pack')
  assert.equal(quota.unit, 'credits')
  assert.equal(quota.state, 'ok')
  assert.equal(quota.windows.length, 1)
  assert.equal(quota.windows[0].limit, 25000)
  assert.equal(quota.account.providerId, 'chatecnu')
  assert.equal(quota.account.apiKeyId, 'key_5638', 'the per-key identity is surfaced for verification')
  assert.equal(quota.resetAt, '2026-11-15T15:27:28.000Z')
})

test('a fully spent pack disappears from the bonus line', () => {
  const now = Date.parse('2026-11-11T12:00:00+08:00')
  const quota = normalizeEcnu(ECNU_BODY, now)
  // The fixture's pack reports remaining_credits: 0, so it must not be rendered.
  assert.equal(quota.bonus.remaining, 0)
  assert.deepEqual(quota.bonus.packs, [], 'an exhausted pack is hidden, not listed as 0')
})

test('a live pack is surfaced next to the window', () => {
  const body = {
    windows: [{ type: 'fixed_168h', limit: 25000, used: 20000, remaining: 5000, reset_at: '2026-11-15T23:27:28+08:00' }],
    resource_packs: [{ name: '学习支持', total_credits: 5000, used_credits: 1000, remaining_credits: 4000 }],
    unit: 'credits',
  }
  const quota = normalizeEcnu(body, Date.parse('2026-11-11T12:00:00+08:00'))
  assert.equal(quota.total, 25000)
  assert.equal(quota.remaining, 9000, 'spendable = 5,000 window + 4,000 pack')
  assert.equal(quota.bonus.remaining, 4000)
  assert.deepEqual(quota.bonus.packs.map((pack) => pack.name), ['学习支持'])
})

test('the DeepSeek platform balance is read in CNY', async () => {
  const { normalizeDeepseek } = await import('../quota.js')
  const quota = normalizeDeepseek({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '88.50', granted_balance: '0.00', topped_up_balance: '88.50' }],
  })
  assert.equal(quota.unit, 'CNY')
  assert.equal(quota.remaining, 88.5)
  assert.equal(quota.total, null, 'prepaid money has no allowance to divide by')
  assert.equal(quota.state, 'ok')
})

test('a fully spent pool reports exhausted', () => {
  const body = {
    windows: [{ limit: 100, used: 100, remaining: 0 }],
    resource_packs: [{ total_credits: 10, used_credits: 10, remaining_credits: 0 }],
    unit: 'credits',
  }
  assert.equal(normalizeEcnu(body, Date.now()).state, 'exhausted')
})

test('a low remainder is flagged low but stays usable', () => {
  const body = { windows: [{ limit: 1000, used: 900, remaining: 100 }], unit: 'credits' }
  const quota = normalizeEcnu(body, Date.now())
  assert.equal(quota.state, 'low')
  assert.equal(quota.remaining, 100)
})

test('a nested path can be read for a custom provider', () => {
  const body = { data: { credits: { remaining: 42, total: 100 } } }
  assert.equal(readJsonPath(body, 'data.credits.remaining'), 42)
  assert.equal(readJsonPath(body, 'data.items[0].x'), undefined)
})

test('tolerant extraction survives a renamed field', () => {
  const found = tolerantExtract({ nested: { credit_available: 55, credit_limit: 100 } })
  assert.equal(found.remaining, 55)
  assert.equal(found.total, 100)
})

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/** A service wired to one fake provider endpoint. */
function makeService(fetchImpl, policy = { mode: 'active', ttlMs: 60_000, recheckExhaustedMs: [1_800_000, 3_600_000], timeoutMs: 2_000 }) {
  let current = 1_000_000
  const secrets = { REF_A: 'secret-a', REF_B: 'secret-b' }
  const service = createQuotaService({
    now: () => current,
    fetchImpl,
    getSecret: async (ref) => secrets[ref],
    getPolicy: () => ({ ...policy, ...(service.policyOverride ?? {}) }),
  })
  return {
    service,
    advance(ms) {
      current += ms
    },
    setPolicy(next) {
      service.policyOverride = next
    },
    secrets,
  }
}

const KEY_A = { id: 'k1', ref: 'REF_A', provider: 'ecnu', model: 'ecnu-max', baseURL: 'https://chat.ecnu.edu.cn/open/api/v1' }
const KEY_B = { id: 'k2', ref: 'REF_B', provider: 'ecnu', model: 'ecnu-max', baseURL: 'https://chat.ecnu.edu.cn/open/api/v1' }

test('each key is probed with its own secret', async () => {
  const seen = []
  const fetchImpl = fakeFetch(async (url, init) => {
    seen.push(init.headers.Authorization)
    return jsonResponse({ ...ECNU_BODY, api_key_id: url.endsWith('/quota') ? 'key_x' : 'key_y' })
  })
  const { service } = makeService(fetchImpl)
  await service.revalidate(KEY_A)
  await service.revalidate(KEY_B)
  assert.deepEqual(seen, ['Bearer secret-a', 'Bearer secret-b'], 'no pool-level credential may ever be reused')
})

test('a probed key that reports exhausted is excluded from routing', async () => {
  const fetchImpl = fakeFetch(async () =>
    jsonResponse({ windows: [{ limit: 10, used: 10, remaining: 0 }], unit: 'credits' }),
  )
  const { service } = makeService(fetchImpl)
  const entry = await service.decide(KEY_A)
  assert.equal(entry.state, 'exhausted')
  assert.equal(service.isExhausted('k1'), true)
  assert.equal(service.isExhausted('k2'), false)
})

test('stale-while-revalidate returns the stale number and refreshes in the background', async () => {
  let remaining = 500
  const fetchImpl = fakeFetch(async () => jsonResponse({ windows: [{ limit: 1000, remaining }], unit: 'credits' }))
  const harness = makeService(fetchImpl)
  const first = await harness.service.decide(KEY_A)
  assert.equal(first.remaining, 500)
  const callsAfterFirst = fetchImpl.calls.length

  harness.advance(120_000)
  remaining = 250
  const stale = await harness.service.decide(KEY_A)
  assert.equal(stale.remaining, 500, 'the stale value decides this request instead of blocking')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fetchImpl.calls.length > callsAfterFirst, 'a refresh was started in the background')
  assert.equal(harness.service.view('k1').remaining, 250, 'the refreshed number replaced the cache')
})

test('a fresh entry does not trigger another probe', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ windows: [{ limit: 1000, remaining: 900 }], unit: 'credits' }))
  const { service } = makeService(fetchImpl)
  await service.decide(KEY_A)
  await service.decide(KEY_A)
  await service.decide(KEY_A)
  assert.equal(fetchImpl.calls.length, 1)
})

test('concurrent probes for one key collapse into a single request', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ windows: [{ limit: 100, remaining: 50 }], unit: 'credits' }))
  const { service } = makeService(fetchImpl)
  await Promise.all([service.decide(KEY_A), service.decide(KEY_A), service.decide(KEY_A)])
  assert.equal(fetchImpl.calls.length, 1, 'in-flight probes are deduplicated per key id')
})

test('a failing endpoint degrades to probe-failed without blocking routing', async () => {
  const fetchImpl = fakeFetch(async () => {
    throw new Error('ECONNREFUSED')
  })
  const { service } = makeService(fetchImpl)
  const entry = await service.decide(KEY_A)
  assert.equal(entry.state, 'probe-failed')
  assert.match(entry.error, /ECONNREFUSED/)
  assert.equal(service.isExhausted('k1'), false, 'an unreachable biller must not park a working key')
})

test('an auth failure on the quota route is reported but does not park the key', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({}, 401))
  const { service } = makeService(fetchImpl)
  const entry = await service.decide(KEY_A)
  assert.equal(entry.state, 'probe-failed')
  assert.equal(entry.error, 'quota-auth')
  assert.equal(service.isExhausted('k1'), false)
})

test('a provider without a quota route reports unsupported', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({}, 404))
  const { service } = makeService(fetchImpl)
  const entry = await service.decide(KEY_A)
  assert.equal(entry.state, 'unsupported')
  assert.equal(entry.supported, false)
})

test('passive mode never probes on the routing path', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ windows: [{ limit: 10, remaining: 5 }] }))
  const harness = makeService(fetchImpl, {
    mode: 'passive',
    ttlMs: 60_000,
    recheckExhaustedMs: [1_800_000, 3_600_000],
    timeoutMs: 2_000,
  })
  await harness.service.decide(KEY_A)
  assert.equal(fetchImpl.calls.length, 0, 'passive mode must not call the biller from the request path')
})

test('off mode returns no decision at all', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({}))
  const harness = makeService(fetchImpl, {
    mode: 'off',
    ttlMs: 60_000,
    recheckExhaustedMs: [1_800_000, 3_600_000],
    timeoutMs: 2_000,
  })
  assert.equal(await harness.service.decide(KEY_A), undefined)
  assert.equal(fetchImpl.calls.length, 0)
})
