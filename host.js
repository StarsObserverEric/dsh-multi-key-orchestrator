/**
 * Multi-key orchestration for the DeepSeek Harness.
 *
 * One model may be backed by several API keys. When the sidebar toggle is on
 * and a model owns at least two enabled keys, every model request for that
 * route passes through this plugin, which
 *
 *  1. leases a key from the pool (`llm/stream`),
 *  2. writes that key's secret into the request's auth header
 *     (`llm-pi-ai/request-headers`),
 *  3. rotates to another key and retries on a transient 429, and
 *  4. hands a *mid-stream* 429 back to the agent loop as a fresh round
 *     (`agent/request-error`), which discards the partial attempt instead of
 *     failing the turn.
 *
 * With the toggle off, or for a model with a single key, both listeners hand
 * the call straight to the next layer: the native single-key path is never
 * modified, only bypassed.
 *
 * @module dsh-multi-key-orchestrator
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

import {
  PoolOrchestrator,
  PoolExhaustedError,
  clamp,
  classifyFailure,
  cooldownFor,
  createLogRing,
  credentialRefFor,
  healthScore,
  maskSecret,
} from './engine.js'
import { createQuotaService } from './quota.js'
import { createStateStore } from './state.js'

/** Route prefix owned by this plugin. */
const ROUTE_BASE = '/api/multi-key-orchestrator'
/** Directory of this package: the plugin's own state lives beside its code. */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where the plugin keeps its state.
 * `DSH_MULTI_KEY_STATE_DIR` relocates it, which lets an operator keep plugin
 * data off a read-only package directory and lets the smoke test isolate runs.
 * Resolved per activation so a test can point each boot at a fresh directory.
 */
function resolveStateDir() {
  const override = process.env.DSH_MULTI_KEY_STATE_DIR
  return override && override.length > 0 ? path.resolve(override) : path.join(PACKAGE_DIR, '.state')
}
/** A provider key that allows three concurrent requests is the common case. */
const DEFAULT_PER_KEY_CONCURRENCY = 3
/** Cap on a request body accepted by the panel routes. */
const MAX_BODY_BYTES = 1_000_000
/** How long a mid-stream failure stays retryable through `agent/request-error`. */
const PENDING_RETRY_TTL_MS = 120_000

/**
 * The plugin needs the HTTP carrier for its panel routes. Every other service
 * is optional and degrades instead of failing activation.
 */
export const inject = ['webServer']

/** @returns {any} the state a fresh install starts from */
function defaultState() {
  return {
    // v2 moved the keys from each pool up to the provider that owns them.
    version: 2,
    enabled: false,
    midStreamRetry: true,
    midStreamMaxRetries: 2,
    /** Lane used when subagent detection is impossible: conservative by default. */
    laneFallback: 'child',
    pools: [],
    /** Provider-wide caps: `{ [provider]: { maxConcurrent } }`, 0 = unlimited. */
    providers: {},
    seq: 0,
    limits: {
      maxAttempts: 20,
      maxWaitMs: 30 * 60_000,
      backoffWindowsMs: [30_000, 60_000, 120_000, 180_000],
      defaultCooldownMs: 60_000,
    },
    quota: {
      mode: 'active',
      ttlMs: 60_000,
      recheckExhaustedMs: [1_800_000, 3_600_000],
      timeoutMs: 5_000,
    },
    classify: { quotaPatterns: undefined, transientPatterns: undefined },
    debug: { inject429: 'off' },
    /** Only populated when the Host has no credential service. */
    secretsFallback: {},
  }
}

/** @param {any} loaded @returns {any} */
function mergeState(loaded) {
  const base = defaultState()
  if (!loaded || typeof loaded !== 'object') return base
  return {
    ...base,
    ...loaded,
    // Always stamp the shape this build writes: a migrated file is v2 even if
    // the bytes on disk still say v1.
    version: 2,
    limits: { ...base.limits, ...(loaded.limits ?? {}) },
    quota: { ...base.quota, ...(loaded.quota ?? {}) },
    classify: { ...base.classify, ...(loaded.classify ?? {}) },
    debug: { ...base.debug, ...(loaded.debug ?? {}) },
    secretsFallback: { ...(loaded.secretsFallback ?? {}) },
    providers: migrateProviders(loaded),
    pools: migratePools(loaded),
  }
}

/**
 * Normalise the provider map and fold a v1 layout forward.
 *
 * v1 kept the keys inside each pool (`pools[].keys[]`), which made the same API
 * key appear once per model. v2 owns keys at provider level: one API key set
 * shared by every model of that provider, with per-model caps kept beside the
 * pool (`pools[].keyCaps`).
 */
function migrateProviders(loaded) {
  const out = {}
  const raw = loaded?.providers && typeof loaded.providers === 'object' ? loaded.providers : {}
  for (const [name, value] of Object.entries(raw)) {
    out[name] = {
      maxConcurrent: Math.max(0, Number(value?.maxConcurrent ?? 0)),
      keys: Array.isArray(value?.keys)
        ? value.keys.map((key) => ({
            id: String(key?.id ?? ''),
            ref: String(key?.ref ?? ''),
            note: String(key?.note ?? key?.label ?? 'default') || 'default',
            maskedLabel: String(key?.maskedLabel ?? '••••••'),
            enabled: key?.enabled !== false,
            source: key?.source === 'native' ? 'native' : 'added',
          }))
        : [],
    }
  }
  // v1 pools carried their own key lists; hoist them, de-duplicated by ref.
  for (const pool of Array.isArray(loaded?.pools) ? loaded.pools : []) {
    const provider = String(pool?.provider ?? '')
    if (!provider) continue
    out[provider] = out[provider] ?? { maxConcurrent: 0, keys: [] }
    for (const key of Array.isArray(pool?.keys) ? pool.keys : []) {
      const ref = String(key?.ref ?? '')
      if (!ref) continue
      if (out[provider].keys.some((existing) => existing.ref === ref)) continue
      out[provider].keys.push({
        id: String(key?.id ?? ''),
        ref,
        note: String(key?.note ?? key?.label ?? 'default') || 'default',
        maskedLabel: String(key?.maskedLabel ?? '••••••'),
        enabled: key?.enabled !== false,
        source: 'added',
      })
    }
  }
  for (const value of Object.values(out)) {
    value.keys = value.keys.filter((key) => key.id.length > 0 && key.ref.length > 0)
  }
  return out
}

/** @param {any} loaded */
function migratePools(loaded) {
  if (!Array.isArray(loaded?.pools)) return []
  return loaded.pools.map((pool) => {
    const keyCaps = {}
    for (const [keyId, cap] of Object.entries(pool?.keyCaps ?? {})) {
      const value = Math.max(0, Number(cap ?? 0))
      if (Number.isFinite(value) && value > 0) keyCaps[keyId] = value
    }
    for (const key of Array.isArray(pool?.keys) ? pool.keys : []) {
      const value = Math.max(0, Number(key?.maxConcurrent ?? 0))
      if (Number.isFinite(value) && value > 0 && key?.id) keyCaps[String(key.id)] = value
    }
    return {
      provider: String(pool?.provider ?? ''),
      model: String(pool?.model ?? ''),
      maxConcurrent: Math.max(1, Number(pool?.maxConcurrent ?? 4)),
      maxConcurrentAuto: pool?.maxConcurrentAuto !== false,
      linked: pool?.linked !== false,
      reservedForMain: Math.max(0, Number(pool?.reservedForMain ?? 1)),
      releaseReservationWhenIdle: pool?.releaseReservationWhenIdle === true,
      idleGraceMs: Math.max(0, Number(pool?.idleGraceMs ?? 30_000)),
      baseURL: typeof pool?.baseURL === 'string' ? pool.baseURL : undefined,
      keyCaps,
    }
  })
}

/** @param {any} response @param {number} code @param {any} value */
function sendJson(response, code, value) {
  const body = JSON.stringify(value)
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<any>} */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : ''
      if (text.trim().length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid json: ${String(error?.message ?? error)}`))
      }
    })
    request.on('error', reject)
  })
}

/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Strip the optional `:port` from a Host header value, IPv6-bracket aware.
 * @param {string} host
 */
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * The request must be addressed to loopback, and a browser-attached Origin must
 * be loopback too. The Host check drops DNS-rebinding pages; a same-origin fetch
 * carries no Origin and passes on Host alone.
 * Borrowed from the community `dsh-ecnu-quota` plugin, which reaches the same
 * conclusion for its own read-only route.
 * @param {import('node:http').IncomingMessage} request
 */
function loopbackRequest(request) {
  const host = request.headers?.host
  if (typeof host !== 'string' || host.trim().length === 0) return false
  if (!LOOPBACK_HOSTS.has(hostnameOfHost(host))) return false
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin.trim().length === 0) return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Activate the plugin.
 * @param {any} ctx the Cordis context of this profile entry
 */
export function apply(ctx) {
  const logger = ctx.logger?.('multi-key-orchestrator') ?? ctx.logger?.('plugin') ?? undefined
  const logLine = (message) => {
    try {
      logger?.debug?.(message)
    } catch {
      /* logging must never break request handling */
    }
  }

  const store = createStateStore({ dir: resolveStateDir(), log: logLine })
  const state = mergeState(store.load())
  const startedAt = Date.now()
  const logRing = createLogRing(200)
  const warnings = new Map()
  const correlation = new Map()
  const pendingRetries = new Map()
  const observedBaseURL = new Map()
  const resolvedBaseURL = new Map()
  const als = new AsyncLocalStorage()

  const stats = {
    als: 0,
    fifo: 0,
    swaps: 0,
    noSeam: 0,
    leasesGranted: 0,
    fallbackLane: 0,
    poolExhausted: 0,
    midStreamRetries: 0,
  }

  /** @type {Map<string, { key: string, orchestrator: PoolOrchestrator }>} */
  const pools = new Map()
  let lastSavedAt = 0
  let disposed = false

  // ---------------------------------------------------------------- utilities

  const poolIdentity = (provider, model) => `${provider}\u0000${model}`

  const warn = (code, message) => {
    warnings.set(code, { code, message, at: Date.now() })
  }

  const record = (entry) => {
    logRing.push({ t: Date.now(), ...entry })
  }

  const credentialsService = () => {
    try {
      return ctx.get('credentials')
    } catch {
      return undefined
    }
  }

  /**
   * Read one key's secret. Deliberately takes the key's own ref: there is no
   * provider-level fallback that could silently reuse another key's secret.
   * @param {string} ref
   * @returns {Promise<string | undefined>}
   */
  async function getSecret(ref) {
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    const credentials = credentialsService()
    if (credentials) {
      try {
        const resolved = await credentials.resolve(ref)
        if (typeof resolved === 'string') return resolved
        if (resolved && typeof resolved === 'object') {
          if (typeof resolved.value === 'string') return resolved.value
          if (typeof resolved.secret === 'string') return resolved.secret
        }
        return undefined
      } catch (error) {
        logLine(`credential resolve failed for a key: ${String(error?.message ?? error)}`)
      }
    }
    const fallback = state.secretsFallback?.[ref]
    if (typeof fallback === 'string' && fallback.length > 0) return fallback
    // Last resort, mirroring the provider plugins: a key exported into the Host
    // environment should work even on a profile without the credentials service.
    const ambient = process.env[ref]
    return typeof ambient === 'string' && ambient.trim().length > 0 ? ambient.trim() : undefined
  }

  /** @param {string} ref @param {string} value */
  async function setSecret(ref, value) {
    const credentials = credentialsService()
    if (credentials) {
      await credentials.set(ref, value)
      return
    }
    state.secretsFallback = state.secretsFallback ?? {}
    state.secretsFallback[ref] = value
    warn(
      'credentials-fallback',
      'No credential service is mounted in this profile, so API keys are stored in the plugin state file instead of the credential store.',
    )
  }

  /** @param {string} ref */
  async function unsetSecret(ref) {
    const credentials = credentialsService()
    if (credentials) {
      try {
        await credentials.unset(ref)
        return
      } catch {
        /* an absent ref is already the desired end state */
      }
    }
    if (state.secretsFallback) delete state.secretsFallback[ref]
  }

  const persist = () => {
    const payload = JSON.parse(JSON.stringify(state))
    const result = store.save(payload)
    if (result.ok) {
      lastSavedAt = result.savedAt
      return result
    }
    warn('state-save-failed', `Could not write ${result.path}: ${result.error ?? 'unknown error'}`)
    return result
  }

  /** Resolve the provider endpoint used by the quota probe. */
  function baseURLFor(provider) {
    if (resolvedBaseURL.has(provider)) return resolvedBaseURL.get(provider)
    let url = observedBaseURL.get(provider)

    if (!url) {
      try {
        const editor = ctx.get('configEditor')
        const entries = typeof editor?.entries === 'function' ? editor.entries() : []
        for (const entry of entries) {
          const providers = entry?.config?.providers ?? entry?.options?.config?.providers
          const candidate = providers?.[provider]?.baseURL
          if (typeof candidate === 'string' && candidate.length > 0) {
            url = candidate
            break
          }
        }
      } catch {
        /* the config editor is optional */
      }
    }

    if (!url) {
      try {
        const llm = ctx.get('llm')
        const directory = typeof llm?.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []
        for (const entry of directory) {
          if (entry?.provider === provider && typeof entry.defaultBaseURL === 'string') {
            url = entry.defaultBaseURL
            break
          }
        }
      } catch {
        /* the llm directory is optional */
      }
    }

    if (typeof url === 'string' && url.length > 0) resolvedBaseURL.set(provider, url)
    return url
  }

  // ------------------------------------------------------------------- quota

  const quota = createQuotaService({
    getSecret,
    getPolicy: () => ({
      mode: state.quota.mode,
      ttlMs: state.quota.ttlMs,
      recheckExhaustedMs: state.quota.recheckExhaustedMs,
      timeoutMs: state.quota.timeoutMs,
    }),
    log: (event) => record(event),
  })

  // ------------------------------------------------------------------- pools

  const poolConfigOf = (poolState) => ({
    provider: poolState.provider,
    model: poolState.model,
    maxConcurrent: poolState.maxConcurrent,
    // Clamp at use time: a linked total that shrinks for a moment must not wipe
    // the reservation the user asked for.
    reservedForMain: Math.min(Math.max(0, Number(poolState.reservedForMain ?? 0)), Math.max(0, poolState.maxConcurrent - 1)),
    releaseReservationWhenIdle: poolState.releaseReservationWhenIdle,
    idleGraceMs: poolState.idleGraceMs,
    limits: {
      maxAttempts: state.limits.maxAttempts,
      maxWaitMs: state.limits.maxWaitMs,
      backoffWindowsMs: state.limits.backoffWindowsMs,
    },
    classify: state.classify,
    // A model's keys are the provider's keys, each carrying this model's own cap.
    keys: providerKeysOf(poolState.provider)
      .filter((key) => key.enabled !== false)
      .map((key) => ({
        id: key.id,
        ref: key.ref,
        note: key.note,
        maskedLabel: key.maskedLabel,
        enabled: true,
        maxConcurrent: Math.max(0, Number(poolState.keyCaps?.[key.id] ?? 0)),
      })),
  })

  /**
   * The provider's keys, always with the Settings-adopted key first.
   *
   * The adopted key is the account the user already trusts, so the panel shows it
   * at the top of every provider, the per-API cap grid keeps that order, and the
   * engine's rotation starts from the same place.
   * @param {string} provider
   */
  const providerKeysOf = (provider) => {
    const entry = state.providers?.[provider]
    const keys = Array.isArray(entry?.keys) ? [...entry.keys] : []
    return keys.sort((a, b) => {
      const nativeA = a.source === 'native' ? 0 : 1
      const nativeB = b.source === 'native' ? 0 : 1
      if (nativeA !== nativeB) return nativeA - nativeB
      return String(a.id).localeCompare(String(b.id))
    })
  }

  /** @param {string} provider */
  const enabledProviderKeys = (provider) => providerKeysOf(provider).filter((key) => key.enabled !== false)

  /** @param {string} provider */
  const ensureProviderState = (provider) => {
    state.providers = state.providers ?? {}
    const current = state.providers[provider]
    if (!current || typeof current !== 'object') {
      state.providers[provider] = { maxConcurrent: 0, keys: [] }
    } else if (!Array.isArray(current.keys)) {
      current.keys = []
    }
    return state.providers[provider]
  }

  /**
   * Provider-wide admission counter.
   * One gate per provider, shared by every pool of that provider, so the
   * "all keys of this provider together" cap spans models instead of being a
   * second per-model limit.
   * @param {number} max 0 = unlimited
   */
  const createProviderGate = (max) => {
    const gate = {
      active: 0,
      max: Math.max(0, Number(max ?? 0)),
      hasRoom() {
        return gate.max <= 0 || gate.active < gate.max
      },
      acquire() {
        gate.active += 1
      },
      release() {
        gate.active = Math.max(0, gate.active - 1)
      },
      snapshot() {
        return { active: gate.active, max: gate.max }
      },
    }
    return gate
  }

  /** @type {Map<string, ReturnType<typeof createProviderGate>>} */
  const providerGates = new Map()

  /** @param {string} provider */
  const providerGateFor = (provider) => {
    const configured = Math.max(0, Number(state.providers?.[provider]?.maxConcurrent ?? 0))
    let gate = providerGates.get(provider)
    if (!gate) {
      gate = createProviderGate(configured)
      providerGates.set(provider, gate)
    } else {
      gate.max = configured
    }
    return gate
  }

  const poolStates = () =>
    state.pools.filter((pool) => typeof pool.provider === 'string' && typeof pool.model === 'string' && pool.model.length > 0)

  const poolStateOf = (provider, model) =>
    state.pools.find((pool) => pool.provider === provider && pool.model === model)

  /**
   * When a pool is linked, its total is the sum of the per-key caps rather than
   * a number the user typed. Keeping the sum authoritative here means the panel,
   * the engine and the state file can never disagree.
   * @param {any} poolState
   */
  const recomputeLinkedTotal = (poolState) => {
    if (!poolState || poolState.linked === false) return
    const keys = enabledProviderKeys(poolState.provider)
    const sum = keys.reduce((total, key) => total + Math.max(0, Number(poolState.keyCaps?.[key.id] ?? 0)), 0)
    // No per-key cap anywhere means "unlimited per key", so fall back to the
    // historical 3-per-key budget instead of collapsing the pool to zero.
    poolState.maxConcurrent = sum > 0 ? clamp(sum, 1, 128) : DEFAULT_PER_KEY_CONCURRENCY * Math.max(1, keys.length)
  }

  const rebuildPools = () => {
    const wanted = new Map()
    for (const poolState of poolStates()) {
      recomputeLinkedTotal(poolState)
      wanted.set(poolIdentity(poolState.provider, poolState.model), poolState)
    }
    for (const [identity, entry] of [...pools]) {
      if (!wanted.has(identity)) {
        entry.orchestrator.dispose()
        pools.delete(identity)
      }
    }
    for (const [identity, poolState] of wanted) {
      const existing = pools.get(identity)
      const config = poolConfigOf(poolState)
      const providerGate = providerGateFor(poolState.provider)
      if (existing) {
        existing.orchestrator.providerGate = providerGate
        existing.orchestrator.applyConfig(config)
      } else {
        pools.set(identity, {
          key: identity,
          orchestrator: new PoolOrchestrator(config, {
            onEvent: (event) => record(event),
            providerGate,
          }),
        })
      }
    }
  }

  /**
   * Build the quota-probe descriptor for one provider key.
   * A probe belongs to the key, not to a model: the same key reports one balance
   * no matter which model is asking.
   */
  const keyDefFor = (provider, key) => ({
    id: key.id,
    ref: key.ref,
    provider,
    model: '',
    baseURL: baseURLFor(provider),
    probe: undefined,
  })

  /** Every enabled provider key, across providers. */
  const allKeyDefs = () => {
    const out = []
    for (const [provider, entry] of Object.entries(state.providers ?? {})) {
      for (const key of Array.isArray(entry?.keys) ? entry.keys : []) {
        if (key.enabled === false) continue
        out.push(keyDefFor(provider, key))
      }
    }
    return out
  }

  /** @param {any} poolState */
  const poolKeyDefs = (poolState) =>
    enabledProviderKeys(poolState.provider).map((key) => keyDefFor(poolState.provider, key))

  /**
   * Evaluate the quota gate for one pool.
   * `decide` is stale-while-revalidate, so a warm cache costs a microtask and
   * only a never-probed key can make this await a network call.
   * @param {any} poolState
   */
  async function evaluateGate(poolState) {
    const definitions = poolKeyDefs(poolState)
    if (state.quota.mode !== 'off') {
      await Promise.all(
        definitions.map((definition) =>
          quota.decide(definition).catch(() => {
            warn('quota-check-failed', 'The provider quota endpoint could not be reached; routing fell back to passive 429 handling.')
            return undefined
          }),
        ),
      )
    }
    const isEligible = (keyRuntime) => !quota.isExhausted(keyRuntime.id)
    const eligible = definitions.filter((definition) => !quota.isExhausted(definition.id))
    return {
      isEligible,
      eligibleCount: eligible.length,
      eligibleIds: eligible.map((definition) => definition.id),
    }
  }

  /** @param {any} poolState */
  function gateSync(poolState) {
    const definitions = poolKeyDefs(poolState)
    const eligible = definitions.filter((definition) => !quota.isExhausted(definition.id))
    return { eligibleCount: eligible.length, eligibleIds: eligible.map((definition) => definition.id) }
  }

  // -------------------------------------------------------------------- lanes

  /**
   * Which lane a request belongs to.
   *
   * The session header is the only reliable evidence: a delegated session
   * carries the parent it was forked from, the `subagent` origin, or a
   * delegation depth. `ctx.agents` cannot answer this — its `Agent` is nothing
   * but an id, and its registry exposes no parentage — so a lookup there would
   * classify every session, children included, as main.
   *
   * Any failure to read the header yields the configured fallback (`child` by
   * default), so an unidentifiable request can never steal the main slot.
   * @param {string | undefined} sessionId
   */
  function laneOf(sessionId) {
    const fallback = state.laneFallback === 'main' ? 'main' : 'child'
    if (!sessionId) {
      stats.fallbackLane += 1
      return fallback
    }
    const header = (() => {
      try {
        const sessions = ctx.get('sessions')
        return typeof sessions?.get === 'function' ? sessions.get(sessionId)?.header : undefined
      } catch {
        return undefined
      }
    })()
    if (header) {
      const delegated =
        header.parentSession != null ||
        header.origin === 'subagent' ||
        Number(header.delegationDepth ?? 0) > 0
      return delegated ? 'child' : 'main'
    }
    stats.fallbackLane += 1
    return fallback
  }

  // -------------------------------------------------------------- llm stream

  /** @param {string} code @param {string} message */
  const failureFinish = (code, message) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { code, message } },
  })

  /**
   * Normalise a thrown adapter error into the `LlmFailure` shape the classifier
   * reads. A thrown error usually carries no `status`, but the message almost
   * always names the HTTP code ("429 model_concurrency_exceeded ..."), so the
   * code is recovered from it — otherwise a thrown 429 would be classified as
   * "other" and escape the pool without cooling or rotating its key.
   * @param {any} error
   */
  function failureFromError(error) {
    const message = String(error?.message ?? error ?? 'model request failed')
    const declared = Number(
      error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? 0,
    )
    const status = Number.isFinite(declared) && declared > 0
      ? declared
      : (/(?:^|\D)4(\d\d)(?:\D|$)/.exec(message)?.[1] === '29' ? 429 : undefined)
    return {
      code: String(error?.code ?? (status ? `HTTP_${status}` : 'REQUEST_FAILED')),
      message,
      status,
      providerRetryAfterMs: Number(error?.providerRetryAfterMs ?? error?.retryAfterMs ?? 0) || undefined,
    }
  }

  /**
   * Run one attempt against one leased key.
   *
   * Content chunks are buffered until the first content delta, so a key that
   * fails before producing anything can be replaced without the consumer ever
   * seeing a half-start attempt. After the first content delta the stream is
   * pass-through, which is what makes retrying only possible before content.
   */
  async function* attemptOnce(lease, secret, next) {
    const buffered = []
    let contentStarted = false
    let emittedChars = 0
    let finish
    let thrown
    const scope = { keyId: lease.keyId, secret }
    const iterable = als.run(scope, () => next())
    try {
      for await (const chunk of iterable) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'finish') {
          finish = chunk
          break
        }
        const isContent =
          chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
        if (chunk.type === 'text-delta') emittedChars += String(chunk.text ?? '').length
        if (!contentStarted && isContent) {
          contentStarted = true
          for (const held of buffered) yield held
          buffered.length = 0
        }
        if (contentStarted) yield chunk
        else buffered.push(chunk)
      }
    } catch (error) {
      // The adapter threw instead of yielding a `finish` chunk. Classify it the
      // same way, so the caller can still cool the key and move to another one.
      const failure = failureFromError(error)
      const classified = classifyFailure(failure, {
        quotaPatterns: state.classify.quotaPatterns,
        transientPatterns: state.classify.transientPatterns,
      })
      return { kind: 'failure', failure, classified, aborted: false, contentStarted, emittedChars, thrown: error }
    }

    if (!finish) {
      for (const held of buffered) yield held
      return { kind: 'success', contentStarted, emittedChars }
    }

    const reason = finish.reason ?? {}
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      const failure = reason.failure ?? { code: 'UNKNOWN', message: 'model request failed' }
      const classified = classifyFailure(failure, {
        quotaPatterns: state.classify.quotaPatterns,
        transientPatterns: state.classify.transientPatterns,
      })
      const aborted = reason.kind === 'aborted'
      const retryable = !aborted && (classified.kind === 'transient' || classified.kind === 'quota')
      if (!contentStarted && retryable) {
        return { kind: 'failure', failure, classified, aborted, contentStarted, emittedChars, silent: true }
      }
      for (const held of buffered) yield held
      yield finish
      return { kind: 'failure', failure, classified, aborted, contentStarted, emittedChars }
    }

    for (const held of buffered) yield held
    yield finish
    return { kind: 'success', contentStarted, emittedChars }
  }

  /** Apply the penalty a classified failure earns its key. */
  function applyPenalty(poolState, keyId, failure, classified) {
    const orchestrator = pools.get(poolIdentity(poolState.provider, poolState.model))?.orchestrator
    if (!orchestrator) return
    if (classified.kind === 'quota') {
      orchestrator.noteQuotaExhausted(keyId, 'http-429-quota')
      warn(
        'quota-exhausted',
        `${poolState.provider}/${poolState.model} reported an exhausted balance on one key; that key is parked until its quota probe recovers.`,
      )
      return
    }
    if (classified.kind === 'transient') {
      orchestrator.noteRateLimit(
        keyId,
        cooldownFor(failure, { defaultMs: state.limits.defaultCooldownMs }),
      )
    }
  }

  /**
   * The `llm/stream` listener body. Returns an AsyncIterable synchronously so
   * the waterfall contract is satisfied; all waiting happens on first pull.
   */
  async function* runPooled(options, next) {
    const provider = options?.provider
    const model = options?.model
    const poolState = poolStateOf(provider, model)
    if (!state.enabled || !poolState) {
      yield* next()
      return
    }
    const enabledKeys = enabledProviderKeys(poolState.provider)
    if (enabledKeys.length < 2) {
      yield* next()
      return
    }
    const entry = pools.get(poolIdentity(provider, model))
    if (!entry) {
      yield* next()
      return
    }
    const orchestrator = entry.orchestrator
    const lane = laneOf(options?.sessionId)
    const sessionKey = `${options?.sessionId ?? '-'}|${provider}|${model}`
    const attemptLimit = Math.max(1, Number(state.limits.maxAttempts ?? 20))
    let attempt = 0

    while (attempt < attemptLimit) {
      attempt += 1

      const gate = await evaluateGate(poolState)
      if (gate.eligibleCount === 0) {
        stats.poolExhausted += 1
        record({ action: 'quota', pool: `${provider}/${model}`, detail: 'every key exhausted, request refused' })
        yield failureFinish(
          'MULTI_KEY_POOL_EXHAUSTED',
          `Every key configured for ${provider}/${model} is out of credit, so the request was not sent.`,
        )
        return
      }

      const inject = state.debug?.inject429
      if (inject === 'first' && attempt === 1) {
        const victim = gate.eligibleIds[0]
        applyPenalty(poolState, victim, { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 8_000 }, {
          kind: 'transient',
        })
        record({ action: 'cooldown', pool: `${provider}/${model}`, key: victim, detail: 'injected 429 (debug)' })
        continue
      }

      let lease
      try {
        lease = await orchestrator.acquire({ lane, signal: options?.signal, isEligible: gate.isEligible })
      } catch (error) {
        if (error?.code === 'MULTI_KEY_LEASE_ABORTED') throw error
        stats.poolExhausted += 1
        yield failureFinish(
          'MULTI_KEY_POOL_EXHAUSTED',
          error instanceof PoolExhaustedError
            ? error.message
            : `No capacity became available for ${provider}/${model}: ${String(error?.message ?? error)}`,
        )
        return
      }

      stats.leasesGranted += 1
      const secret = await getSecret(lease.ref)
      if (!secret) {
        lease.release()
        yield failureFinish(
          'MULTI_KEY_CREDENTIAL_MISSING',
          `The stored secret for key ${lease.maskedLabel} could not be read, so the request was not sent.`,
        )
        return
      }
      correlation.set(sessionKey, { keyId: lease.keyId, secret, at: Date.now() })

      let result
      try {
        result = yield* attemptOnce(lease, secret, next)
      } finally {
        lease.release()
        correlation.delete(sessionKey)
      }

      if (result.kind === 'success') {
        orchestrator.noteSuccess(lease.keyId)
        return
      }

      const { failure, classified, aborted, contentStarted, emittedChars, thrown } = result
      const actionable = !aborted && (classified.kind === 'transient' || classified.kind === 'quota')

      if (actionable) applyPenalty(poolState, lease.keyId, failure, classified)

      if (!actionable) {
        // Nothing another key could fix (bad request, auth, unknown transport
        // failure): hand it up exactly as the adapter raised it, so the error a
        // user sees is the provider's own.
        if (thrown !== undefined) throw thrown
        return
      }

      const after = gateSync(poolState)
      if (after.eligibleCount === 0) {
        stats.poolExhausted += 1
        yield failureFinish(
          'MULTI_KEY_POOL_EXHAUSTED',
          `Every key configured for ${provider}/${model} is now parked (${orchestrator.quotaSummary()}).`,
        )
        return
      }

      if (!contentStarted) {
        if (attempt >= attemptLimit) {
          stats.poolExhausted += 1
          yield failureFinish(
            'MULTI_KEY_POOL_EXHAUSTED',
            `Gave up after ${attempt} attempts on ${provider}/${model}: ${failure?.message ?? 'repeated rate limiting'}`,
          )
          return
        }
        await sleep(120 + Math.random() * 180)
        continue
      }

      // Content already reached the consumer. The agent loop owns the retry so
      // the partial attempt is recorded as an attempt and a fresh turn starts
      // on a different key.
      if (state.midStreamRetry) {
        const pendingKey = options?.sessionId ?? sessionKey
        const previous = pendingRetries.get(pendingKey)
        pendingRetries.set(pendingKey, {
          provider,
          model,
          keyId: lease.keyId,
          lane,
          chars: emittedChars,
          count: (previous?.count ?? 0) + 1,
          at: Date.now(),
        })
      }
      // A thrown attempt yielded no `finish` chunk, so close it here: the agent
      // loop needs a termination reason before it can start the retry round.
      if (thrown !== undefined) yield failureFinish(failure.code, failure.message)
      return
    }

    stats.poolExhausted += 1
    yield failureFinish('MULTI_KEY_POOL_EXHAUSTED', `Attempt budget for ${provider}/${model} is spent.`)
  }

  // ------------------------------------------------------------- header seam

  /**
   * Replace the auth header for exactly the call that leased this key.
   * The lookup prefers the AsyncLocalStorage frame and falls back to the
   * per-session correlation record, because the adapter may prepare headers
   * outside our frame.
   */
  function resolveSelection(request) {
    const direct = als.getStore()
    if (direct && typeof direct.secret === 'string' && direct.secret.length > 0) {
      stats.als += 1
      return { ...direct, via: 'als' }
    }
    const identity = `${request?.sessionId ?? '-'}|${request?.provider ?? ''}|${request?.model ?? ''}`
    const correlated = correlation.get(identity)
    if (correlated && Date.now() - correlated.at <= 60_000) {
      stats.fifo += 1
      return { ...correlated, via: 'fifo' }
    }
    return undefined
  }

  const headerListener = (request, headers, next) => {
    try {
      if (request?.provider && typeof request.baseURL === 'string' && request.baseURL.length > 0) {
        if (observedBaseURL.get(request.provider) !== request.baseURL) {
          observedBaseURL.set(request.provider, request.baseURL)
          resolvedBaseURL.delete(request.provider)
        }
      }
      if (!state.enabled) return next()
      const selection = resolveSelection(request)
      if (!selection) {
        if (stats.leasesGranted > 0 && stats.swaps === 0) stats.noSeam += 1
        return next()
      }
      const hasApiKey = headers.has('x-api-key')
      const hasAuthorization = headers.has('authorization')
      if (hasApiKey) headers.set('x-api-key', selection.secret)
      if (hasAuthorization) headers.set('authorization', `Bearer ${selection.secret}`)
      if (!hasApiKey && !hasAuthorization) headers.set('authorization', `Bearer ${selection.secret}`)
      stats.swaps += 1
      return next()
    } catch (error) {
      // A thrown header listener fails the call with REQUEST_HEADERS; keep the
      // message secret-free and degrade to the native header instead.
      logLine(`header swap failed: ${String(error?.message ?? error)}`)
      const hasAuthorization = headers.has('authorization')
      if (hasAuthorization) headers.set('authorization', `Bearer ${selection?.secret ?? ''}`)
      return next()
    }
  }

  // -------------------------------------------------- mid-stream loop retry

  /**
   * Take ownership of a 429 that happened after content was streamed.
   * Returning `{ kind: 'retry' }` without calling `next()` tells the agent loop
   * that recovery is ours: it starts a fresh round, which re-enters
   * `runPooled`, leases a different key, and re-runs the quota gate.
   */
  const requestErrorListener = (payload, next) => {
    try {
      if (!state.enabled || !state.midStreamRetry) return next()
      const sessionId = payload?.agent?.id
      if (!sessionId) return next()
      const record_ = pendingRetries.get(sessionId)
      if (!record_) return next()
      if (record_.provider !== payload?.provider) return next()
      if (Date.now() - record_.at > PENDING_RETRY_TTL_MS) {
        pendingRetries.delete(sessionId)
        return next()
      }
      if (record_.count > Math.max(0, Number(state.midStreamMaxRetries ?? 2))) {
        pendingRetries.delete(sessionId)
        return next()
      }
      const poolState = poolStateOf(record_.provider, record_.model)
      if (!poolState) {
        pendingRetries.delete(sessionId)
        return next()
      }
      const gate = gateSync(poolState)
      if (gate.eligibleCount === 0) {
        // Refinement: never burn the mid-stream retry budget when the whole
        // pool is out of credit — report pool exhaustion instead of looping.
        pendingRetries.delete(sessionId)
        stats.poolExhausted += 1
        record({
          action: 'quota',
          pool: `${record_.provider}/${record_.model}`,
          key: record_.keyId,
          detail: 'mid-stream retry refused: every key exhausted',
        })
        return next()
      }
      pendingRetries.delete(sessionId)
      stats.midStreamRetries += 1
      record({
        action: 'midstream-retry',
        pool: `${record_.provider}/${record_.model}`,
        key: record_.keyId,
        lane: record_.lane,
        detail: `discarded ${record_.chars} chars, round ${record_.count}`,
      })
      return { kind: 'retry' }
    } catch (error) {
      logLine(`request-error listener failed: ${String(error?.message ?? error)}`)
      return next()
    }
  }

  // ------------------------------------------------------------------ status

  const collectWarnings = () => {
    const out = [...warnings.values()].map((entry) => ({ code: entry.code, message: entry.message }))
    const push = (code, message) => out.push({ code, message })
    // Traffic-derived warnings only mean something while a pool is actually in
    // service; otherwise a disabled plugin would keep reporting stale counters.
    const serving =
      state.enabled === true && poolStates().some((pool) => enabledProviderKeys(pool.provider).length > 0)
    if (!credentialsService() && Object.keys(state.secretsFallback ?? {}).length > 0) {
      push(
        'credentials-fallback',
        'API keys are being kept in the plugin state file because this profile has no credential service.',
      )
    }
    if (state.quota.mode === 'passive') {
      push('quota-passive', 'Quota probing is in passive mode: balances are only refreshed on request, and 429 recovery relies on Retry-After.')
    }
    if (!serving) return out
    if (stats.leasesGranted > 0 && stats.swaps === 0) {
      push(
        'no-header-seam',
        'Requests were leased but no pi-ai request-header hook fired, so these routes still use their native key. Only providers registered through dsh-llm-pi-ai can be pooled.',
      )
    }
    if (stats.fifo > 0) {
      push(
        'correlation-fifo',
        'Key selection is matched to requests by session correlation rather than the async frame; concurrent requests on one session could in principle swap keys.',
      )
    }
    if (stats.fallbackLane > 0) {
      push(
        'lane-fallback',
        `${stats.fallbackLane} request(s) could not be attributed to a root or subagent session and were placed on the "${state.laneFallback}" lane.`,
      )
    }
    return out
  }

  /**
   * Read the provider declarations the user configured in Settings.
   * The settings service is the intended reader of live entry values; the
   * config editor is the fallback on a profile where settings is not mounted.
   * Plugin code never parses the profile YAML by hand.
   * @returns {Map<string, any>}
   */
  function readDeclaredProviders() {
    const collected = new Map()
    const absorb = (providers) => {
      if (!providers || typeof providers !== 'object') return
      for (const [name, config] of Object.entries(providers)) {
        if (config && typeof config === 'object' && !collected.has(name)) collected.set(name, config)
      }
    }
    try {
      const settings = ctx.get('settings')
      const descriptors = typeof settings?.describe === 'function' ? settings.describe({ redactSecrets: true }) : []
      for (const descriptor of descriptors ?? []) absorb(descriptor?.value?.providers)
    } catch {
      /* settings is optional */
    }
    if (collected.size === 0) {
      try {
        const editor = ctx.get('configEditor')
        const entries = typeof editor?.entries === 'function' ? editor.entries() : []
        for (const entry of entries ?? []) {
          absorb(entry?.config?.providers ?? entry?.options?.config?.providers)
        }
      } catch {
        /* the config editor is optional too */
      }
    }
    return collected
  }

  /** @type {{ at: number, value: any[] }} */
  let catalogCache = { at: 0, value: [] }

  /**
   * The provider → model catalog shown by the panel, so the user never types a
   * provider or model by hand. Sources, in priority order: the declared
   * providers in Settings, then the live adapter directory, then any pool that
   * already exists (a stale pool must stay editable).
   */
  async function buildCatalog() {
    const now = Date.now()
    if (now - catalogCache.at < 30_000 && catalogCache.value.length > 0) return catalogCache.value

    const llm = (() => {
      try {
        return ctx.get('llm')
      } catch {
        return undefined
      }
    })()
    const directory = new Map()
    try {
      for (const entry of llm?.listConfigurableProviders?.() ?? []) {
        if (entry?.provider) directory.set(entry.provider, entry)
      }
    } catch {
      /* the directory is advisory */
    }

    /** @type {Map<string, any>} */
    const providers = new Map()
    const toModels = (models) =>
      (Array.isArray(models) ? models : [])
        .map((model) => ({ id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') }))
        .filter((model) => model.id.length > 0)

    for (const [name, config] of readDeclaredProviders()) {
      providers.set(name, {
        provider: name,
        displayName: String(config?.displayName ?? name),
        baseURL: String(config?.baseURL ?? directory.get(name)?.defaultBaseURL ?? ''),
        api: String(config?.api ?? ''),
        apiKeyEnv: typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv : '',
        models: toModels(config?.models),
      })
    }

    let liveProviders = []
    try {
      liveProviders = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
    } catch {
      liveProviders = []
    }
    for (const info of liveProviders) {
      const name = String(info?.id ?? info?.provider ?? '')
      if (name.length === 0) continue
      const existing = providers.get(name)
      if (existing) {
        if (!existing.displayName || existing.displayName === name) {
          existing.displayName = String(info?.name ?? existing.displayName)
        }
        continue
      }
      const entry = {
        provider: name,
        displayName: String(info?.name ?? name),
        baseURL: String(directory.get(name)?.defaultBaseURL ?? ''),
        api: '',
        models: [],
      }
      try {
        const models = typeof llm?.listModels === 'function' ? await llm.listModels(name) : []
        entry.models = toModels(models)
      } catch {
        entry.models = []
      }
      providers.set(name, entry)
    }

    // A pool whose provider vanished from both sources must remain reachable,
    // otherwise its keys could never be inspected or removed again.
    for (const poolState of poolStates()) {
      if (providers.has(poolState.provider)) continue
      providers.set(poolState.provider, {
        provider: poolState.provider,
        displayName: poolState.provider,
        baseURL: poolState.baseURL ?? '',
        api: '',
        models: [{ id: poolState.model, name: poolState.model }],
      })
    }
    for (const poolState of poolStates()) {
      const entry = providers.get(poolState.provider)
      if (entry && !entry.models.some((model) => model.id === poolState.model)) {
        entry.models.push({ id: poolState.model, name: poolState.model })
      }
    }

    // A provider discovered from the adapter directory but advertising no model
    // is still worth listing when it owns a credential: the user configured a key
    // there and expects to see it. Only a provider with nothing at all is noise.
    const value = [...providers.values()]
      .filter(
        (entry) =>
          entry.models.length > 0 ||
          String(entry.apiKeyEnv ?? '').length > 0 ||
          providerKeysOf(entry.provider).length > 0 ||
          poolStates().some((pool) => pool.provider === entry.provider),
      )
      .sort((a, b) => String(a.provider).localeCompare(String(b.provider)))
    catalogCache = { at: now, value }
    return value
  }

  /**
   * Adopt the API keys the profile already configured.
   *
   * Settings stores one credential ref per provider (`apiKeyEnv`). Those keys
   * already work for every model of that provider, so they are the pool's
   * starting point: each becomes a provider-level key named `default`, marked
   * `source: 'native'` so removing it only hides the row and never deletes a
   * credential the plugin did not create.
   * @returns {boolean} whether anything changed
   */
  function syncNativeProviderKeys() {
    let changed = false
    for (const [provider, config] of readDeclaredProviders()) {
      const ref = typeof config?.apiKeyEnv === 'string' ? config.apiKeyEnv.trim() : ''
      if (ref.length === 0) continue
      const entry = ensureProviderState(provider)
      if (entry.keys.some((key) => key.ref === ref)) continue
      state.seq = Number(state.seq ?? 0) + 1
      entry.keys.push({
        id: `k${state.seq}`,
        ref,
        note: 'default',
        maskedLabel: maskSecret('configured'),
        enabled: true,
        source: 'native',
      })
      changed = true
    }
    return changed
  }

  /**
   * Give a provider a pool per known model as soon as it owns a key, so every
   * provider exposes the same per-model controls in the panel. Pooling itself
   * still needs two keys, so a single-key provider simply stays on the native
   * path while its caps remain editable.
   * @param {string} provider
   */
  function ensurePoolsForProvider(provider) {
    if (enabledProviderKeys(provider).length < 1) return false
    const entry = catalogCache.value.find((candidate) => candidate.provider === provider)
    const models = (entry?.models ?? []).map((model) => model.id)
    let changed = false
    for (const model of models) {
      if (poolStateOf(provider, model)) continue
      state.pools.push({
        provider,
        model,
        maxConcurrent: DEFAULT_PER_KEY_CONCURRENCY * enabledProviderKeys(provider).length,
        maxConcurrentAuto: true,
        linked: true,
        reservedForMain: 1,
        releaseReservationWhenIdle: false,
        idleGraceMs: 30_000,
        keyCaps: {},
      })
      changed = true
    }
    return changed
  }

  /** @type {Map<string, { at: number, value: boolean }>} */
  const configuredCache = new Map()

  /** Whether a provider key's credential actually resolves right now. */
  async function isConfigured(ref) {
    const cached = configuredCache.get(ref)
    if (cached && Date.now() - cached.at < 30_000) return cached.value
    const secret = await getSecret(ref)
    const value = typeof secret === 'string' && secret.length > 0
    configuredCache.set(ref, { at: Date.now(), value })
    return value
  }

  /**
   * Project one provider's keys for the panel: provider-level identity plus the
   * counters aggregated across every model that shares the key.
   * @param {string} provider
   */
  async function projectProviderKeys(provider) {
    const now = Date.now()
    const out = []
    for (const key of providerKeysOf(provider)) {
      let activeLeases = 0
      let cooldownUntil = 0
      let consecutiveFailures = 0
      let consecutive429s = 0
      let lastSuccessAt = 0
      let quotaExhausted = false
      for (const poolState of poolStates()) {
        if (poolState.provider !== provider) continue
        const runtime = pools.get(poolIdentity(provider, poolState.model))?.orchestrator.keys.get(key.id)
        if (!runtime) continue
        activeLeases += runtime.activeLeases
        cooldownUntil = Math.max(cooldownUntil, runtime.cooldownUntil)
        consecutiveFailures = Math.max(consecutiveFailures, runtime.consecutiveFailures)
        consecutive429s = Math.max(consecutive429s, runtime.consecutive429s)
        lastSuccessAt = Math.max(lastSuccessAt, runtime.lastSuccessAt)
        quotaExhausted = quotaExhausted || runtime.quotaExhausted
      }
      let state = 'healthy'
      if (key.enabled === false) state = 'disabled'
      else if (quotaExhausted) state = 'quota_exhausted'
      else if (cooldownUntil > now) state = 'cooldown'
      out.push({
        id: key.id,
        note: key.note,
        maskedLabel: key.maskedLabel,
        enabled: key.enabled !== false,
        source: key.source === 'native' ? 'native' : 'added',
        // Only keys the panel created may leave; an adopted key is permanent.
        removable: key.source !== 'native',
        configured: await isConfigured(key.ref),
        state,
        healthScore: Number(
          healthScore({ consecutiveFailures, consecutive429s, lastSuccessAt, quotaExhausted }, now).toFixed(3),
        ),
        cooldownUntil: cooldownUntil > 0 ? cooldownUntil : null,
        consecutiveFailures,
        consecutive429s,
        lastSuccessAt: lastSuccessAt > 0 ? lastSuccessAt : null,
        activeLeases,
        quota: quota.view(key.id),
      })
    }
    return out
  }

  /** One row per provider the panel should show. */
  async function providerRows(catalog) {
    const rows = []
    const seen = new Set()
    for (const entry of catalog) {
      seen.add(entry.provider)
      const gate = providerGateFor(entry.provider)
      rows.push({
        provider: entry.provider,
        displayName: entry.displayName,
        maxConcurrent: gate.max,
        activeLeases: gate.active,
        pools: poolStates().filter((pool) => pool.provider === entry.provider).length,
        keys: await projectProviderKeys(entry.provider),
      })
    }
    for (const provider of Object.keys(state.providers ?? {})) {
      if (seen.has(provider)) continue
      // Anything holding a key or a pool stays visible, even without a catalog
      // entry — a configured credential must never vanish from the panel.
      if (providerKeysOf(provider).length === 0 && !poolStates().some((pool) => pool.provider === provider)) continue
      const gate = providerGateFor(provider)
      rows.push({
        provider,
        displayName: provider,
        maxConcurrent: gate.max,
        activeLeases: gate.active,
        pools: poolStates().filter((pool) => pool.provider === provider).length,
        keys: await projectProviderKeys(provider),
      })
    }
    return rows
  }

  const buildStatus = async () => {
    const catalog = await buildCatalog()
    return {
    version: '0.4.1',
    enabled: state.enabled === true,
    startedAt,
    savedAt: lastSavedAt || undefined,
    statePath: store.path,
    correlation: { als: stats.als, fifo: stats.fifo, swaps: stats.swaps, leases: stats.leasesGranted },
    retry: {
      midStreamRetry: state.midStreamRetry === true,
      midStreamMaxRetries: Number(state.midStreamMaxRetries ?? 2),
      pending: pendingRetries.size,
      midStreamRetried: stats.midStreamRetries,
    },
    quota: {
      mode: state.quota.mode,
      ttlMs: Number(state.quota.ttlMs ?? 60_000),
      recheckExhaustedMs: state.quota.recheckExhaustedMs,
    },
    laneFallback: state.laneFallback,
    credentials: { available: Boolean(credentialsService()) },
    catalog,
    providers: await providerRows(catalog),
    pools: poolStates().map((poolState) => {
      const entry = pools.get(poolIdentity(poolState.provider, poolState.model))
      const snapshot = entry
        ? entry.orchestrator.snapshot()
        : { provider: poolState.provider, model: poolState.model, keys: [], lane: {} }
      return {
        ...snapshot,
        maxConcurrentAuto: poolState.maxConcurrentAuto !== false,
    linked: poolState.linked !== false,
        baseURL: poolState.baseURL ?? baseURLFor(poolState.provider) ?? null,
        keys: snapshot.keys.map((key) => {
          const view = {
            ...key,
            quota: quota.view(key.id),
          }
          delete view.ref
          return view
        }),
      }
    }),
    warnings: collectWarnings(),
    log: logRing.list().slice(-80),
    }
  }

  // ------------------------------------------------------------------ routes

  /** @param {any} body */
  const findPoolOrThrow = (body) => {
    const provider = String(body?.provider ?? '')
    const model = String(body?.model ?? '')
    const poolState = poolStateOf(provider, model)
    if (!poolState) throw new Error(`no pool for ${provider}/${model}`)
    return poolState
  }

  const statusRoute = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      sendJson(response, 200, { ok: true, status: await buildStatus() })
    } catch (error) {
      // A status build must never take the route down with a bare 400: report
      // what broke so the panel and the operator can see it.
      logLine(`status failed: ${String(error?.stack ?? error)}`)
      sendJson(response, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const configRoute = async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
      return
    }
    const op = String(body?.op ?? '')
    try {
      if (op === 'toggle') {
        state.enabled = body?.enabled === true
      } else if (op === 'set-retry') {
        if (typeof body?.midStreamRetry === 'boolean') state.midStreamRetry = body.midStreamRetry
        if (Number.isFinite(Number(body?.midStreamMaxRetries))) {
          state.midStreamMaxRetries = clamp(Number(body.midStreamMaxRetries), 0, 10)
        }
      } else if (op === 'set-quota') {
        if (['active', 'passive', 'off'].includes(body?.mode)) state.quota.mode = body.mode
        if (Number.isFinite(Number(body?.ttlMs))) {
          state.quota.ttlMs = clamp(Number(body.ttlMs), 5_000, 3_600_000)
        }
      } else if (op === 'set-limits') {
        if (Number.isFinite(Number(body?.maxAttempts))) {
          state.limits.maxAttempts = clamp(Number(body.maxAttempts), 1, 100)
        }
        if (Number.isFinite(Number(body?.maxWaitMs))) {
          state.limits.maxWaitMs = clamp(Number(body.maxWaitMs), 5_000, 24 * 3_600_000)
        }
      } else if (op === 'set-lane-fallback') {
        state.laneFallback = body?.laneFallback === 'main' ? 'main' : 'child'
      } else if (op === 'add-provider-key') {
        const provider = String(body?.provider ?? '').trim()
        const value = typeof body?.value === 'string' ? body.value.trim() : ''
        if (!provider) throw new Error('provider is required')
        if (value.length < 8) throw new Error('the api key looks too short to be usable')
        const entry = ensureProviderState(provider)
        state.seq = Number(state.seq ?? 0) + 1
        const keyId = `k${state.seq}`
        const ref = credentialRefFor(provider, 'default', keyId)
        await setSecret(ref, value)
        entry.keys.push({
          id: keyId,
          ref,
          note: (String(body?.note ?? '').trim() || 'default').slice(0, 80),
          maskedLabel: maskSecret(value),
          enabled: true,
          source: 'added',
        })
        configuredCache.delete(ref)
        // The catalog decides which models this provider owns; refresh it so the
        // pool bootstrap below has models to work with even on a cold start.
        await buildCatalog()
        ensurePoolsForProvider(provider)
        rebuildPools()
      } else if (op === 'update-provider-key') {
        const provider = String(body?.provider ?? '').trim()
        const entry = ensureProviderState(provider)
        const providerKey = entry.keys.find((candidate) => candidate.id === String(body?.keyId ?? ''))
        if (!providerKey) throw new Error(`unknown key ${body?.keyId}`)
        if (typeof body?.note === 'string') providerKey.note = (body.note.trim() || 'default').slice(0, 80)
        if (typeof body?.enabled === 'boolean') providerKey.enabled = body.enabled
        rebuildPools()
      } else if (op === 'remove-provider-key') {
        const provider = String(body?.provider ?? '').trim()
        const entry = ensureProviderState(provider)
        const index = entry.keys.findIndex((candidate) => candidate.id === String(body?.keyId ?? ''))
        if (index < 0) throw new Error(`unknown key ${body?.keyId}`)
        // A key adopted from Settings is the user's own credential and belongs to
        // the provider permanently: it is visible and disable-able, never hidden
        // or deleted. Hiding it used to leave a row that looked lost.
        if (entry.keys[index].source === 'native') {
          throw new Error('a key adopted from Settings is permanent; disable it instead of removing it')
        }
        const [removed] = entry.keys.splice(index, 1)
        await unsetSecret(removed.ref)
        configuredCache.delete(removed.ref)
        quota.invalidate(removed.id)
        for (const poolState of state.pools) {
          if (poolState.keyCaps) delete poolState.keyCaps[removed.id]
        }
        rebuildPools()
      } else if (op === 'set-key-cap') {
        const provider = String(body?.provider ?? '').trim()
        const model = String(body?.model ?? '').trim()
        if (!provider || !model) throw new Error('provider and model are required')
        let poolState = poolStateOf(provider, model)
        if (!poolState) {
          poolState = {
            provider,
            model,
            maxConcurrent: DEFAULT_PER_KEY_CONCURRENCY * Math.max(1, enabledProviderKeys(provider).length),
            maxConcurrentAuto: true,
            linked: true,
            reservedForMain: 1,
            releaseReservationWhenIdle: false,
            idleGraceMs: 30_000,
            keyCaps: {},
          }
          state.pools.push(poolState)
        }
        poolState.keyCaps = poolState.keyCaps ?? {}
        const keyId = String(body?.keyId ?? '')
        if (!providerKeysOf(provider).some((key) => key.id === keyId)) throw new Error(`unknown key ${keyId}`)
        const cap = clamp(Number(body?.maxConcurrent ?? 0), 0, 128)
        if (cap > 0) poolState.keyCaps[keyId] = cap
        else delete poolState.keyCaps[keyId]
        rebuildPools()
      } else if (op === 'set-provider') {
        const provider = String(body?.provider ?? '').trim()
        if (!provider) throw new Error('provider is required')
        state.providers = state.providers ?? {}
        state.providers[provider] = {
          ...(state.providers[provider] ?? {}),
          maxConcurrent: clamp(Number(body?.maxConcurrent ?? 0), 0, 512),
        }
        rebuildPools()
      } else if (op === 'set-pool') {
        // Upsert: the panel lets a cap be set on a catalog model that has no
        // keys yet, so the pool must be creatable without adding a key first.
        const provider = String(body?.provider ?? '').trim()
        const model = String(body?.model ?? '').trim()
        if (!provider || !model) throw new Error('provider and model are required')
        let poolState = poolStateOf(provider, model)
        if (!poolState) {
          poolState = {
            provider,
            model,
            maxConcurrent: DEFAULT_PER_KEY_CONCURRENCY,
            linked: true,
            maxConcurrentAuto: true,
            reservedForMain: 1,
            releaseReservationWhenIdle: false,
            idleGraceMs: 30_000,
            keyCaps: {},
          }
          state.pools.push(poolState)
        }
        if (!poolState.keyCaps) poolState.keyCaps = {}
        if (typeof body?.linked === 'boolean') {
          poolState.linked = body.linked
          poolState.maxConcurrentAuto = body.linked
        }
        if (Number.isFinite(Number(body?.maxConcurrent))) {
          if (poolState.linked === false) {
            poolState.maxConcurrent = clamp(Number(body.maxConcurrent), 1, 128)
            poolState.maxConcurrentAuto = false
          }
        }
        if (Number.isFinite(Number(body?.reservedForMain))) {
          poolState.reservedForMain = clamp(Number(body.reservedForMain), 0, poolState.maxConcurrent)
        }
        if (typeof body?.releaseReservationWhenIdle === 'boolean') {
          poolState.releaseReservationWhenIdle = body.releaseReservationWhenIdle
        }
        rebuildPools()
      } else if (op === 'delete-pool') {
        const poolState = findPoolOrThrow(body)
        // Keys belong to the provider: deleting a model's pool must not touch
        // the credentials they use.
        state.pools = state.pools.filter((pool) => pool !== poolState)
        rebuildPools()
      } else if (op === 'probe') {
        // The panel posts probe as a config op so one JSON shape covers it all.
        sendJson(response, 200, { ...(await probeKeys(body?.keyId)), status: await buildStatus() })
        return
      } else if (op === 'selftest') {
        sendJson(response, 200, await runSelftest(body))
        return
      } else {
        throw new Error(`unknown op "${op}"`)
      }
      // One save per accepted operation, after every mutation has landed, so a
      // toggle, a policy change and a key edit all survive a reload identically.
      const saved = persist()
      if (!saved.ok) throw new Error(saved.error ?? 'state could not be saved')
      sendJson(response, 200, { ok: true, savedAt: lastSavedAt })
    } catch (error) {
      sendJson(response, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /**
   * Probe the quota of one provider key, or of every provider key.
   * Shared by the dedicated route and the `probe` config op.
   * @param {string | undefined} only
   */
  const probeKeys = async (only) => {
    const probed = []
    // One balance per key, regardless of how many models share it.
    for (const [provider, providerEntry] of Object.entries(state.providers ?? {})) {
      for (const providerKey of Array.isArray(providerEntry?.keys) ? providerEntry.keys : []) {
        if (only && providerKey.id !== only) continue
        const definition = keyDefFor(provider, providerKey)
        const entry = await quota.manual(definition).catch(() => undefined)
        if (!entry) continue
        const view = quota.view(providerKey.id)
        for (const poolState of poolStates()) {
          if (poolState.provider !== provider) continue
          const orchestrator = pools.get(poolIdentity(provider, poolState.model))?.orchestrator
          if (!orchestrator) continue
          if (entry.state === 'exhausted') orchestrator.noteQuotaExhausted(providerKey.id, 'probe')
          else if (entry.state === 'ok' || entry.state === 'low') orchestrator.clearQuota(providerKey.id, 'probe')
        }
        probed.push({
          provider,
          keyId: providerKey.id,
          note: providerKey.note,
          quota: view,
        })
      }
    }
    return { ok: true, probed }
  }

  const probeRoute = async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body = {}
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
      return
    }
    const only = typeof body?.keyId === 'string' && body.keyId.length > 0 ? body.keyId : undefined
    sendJson(response, 200, { ...(await probeKeys(only)), status: await buildStatus() })
  }

  /**
   * Run the concurrency simulation against a throwaway orchestrator.
   * Shared by the dedicated route and the `selftest` config op.
   * @param {any} body
   */
  const runSelftest = async (body) => {
    const poolState =
      (typeof body?.provider === 'string' ? poolStateOf(body.provider, String(body?.model ?? '')) : undefined) ??
      poolStates()[0]
    if (!poolState) return { ok: false, error: 'configure a pool first' }
    const concurrency = clamp(Number(body?.concurrency ?? 8) || 8, 1, 32)
    const inject429 = body?.inject429 === 'first'
    const events = []
    const simulation = new PoolOrchestrator(
      { ...poolConfigOf(poolState), keys: poolConfigOf(poolState).keys.map((key) => ({ ...key })) },
      { onEvent: (event) => events.push({ t: Date.now(), ...event }) },
    )
    const granted = []
    const held = []
    const failures = []
    const startedAtMs = Date.now()
    const track = (promise, lane) =>
      promise
        .then((lease) => {
          held.push(lease)
          granted.push({ lane, keyId: lease.keyId, at: Date.now() - startedAtMs })
        })
        .catch((error) => {
          failures.push(String(error?.message ?? error))
        })
    try {
      if (inject429) {
        const firstKey = simulation.selectKey()
        if (firstKey) simulation.noteRateLimit(firstKey.id, 8_000)
      }
      for (let index = 0; index < concurrency; index += 1) track(simulation.acquire({ lane: 'child' }), 'child')
      track(simulation.acquire({ lane: 'main' }), 'main')

      await sleep(250)
      const midway = simulation.snapshot()
      const peak = {
        total: midway.lane.total,
        waiting: midway.lane.waiting,
        child: midway.lane.childLeases,
        main: midway.lane.mainLeases,
      }

      // Drain: release what was granted so the queued waiters prove that the
      // FIFO actually advances instead of deadlocking at the cap.
      const releaseHeld = () => {
        while (held.length > 0) held.pop().release()
      }
      for (let round = 0; round < 16 && simulation.waiters.length > 0; round += 1) {
        releaseHeld()
        await sleep(60)
      }
      releaseHeld()
      await sleep(60)

      const summary = {
        concurrency,
        inject429,
        elapsedMs: Date.now() - startedAtMs,
        granted: granted.length,
        mainGranted: granted.filter((row) => row.lane === 'main').length,
        childGranted: granted.filter((row) => row.lane === 'child').length,
        maxConcurrent: simulation.config.maxConcurrent,
        reservedForMain: simulation.config.reservedForMain,
        childCapacity: simulation.capacity('child'),
        peak,
        waitingAtMidway: peak.waiting,
        failures,
        ok: granted.some((row) => row.lane === 'main'),
      }
      return { ok: true, summary, log: events.slice(-120) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), log: events.slice(-120) }
    } finally {
      simulation.dispose()
    }
  }

  const selftestRoute = async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body = {}
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
      return
    }
    sendJson(response, 200, await runSelftest(body))
  }

  // ------------------------------------------------------------- maintenance

  const maintenance = () => {
    if (disposed) return
    const now = Date.now()
    for (const [identity, correlated] of [...correlation]) {
      if (now - correlated.at > 60_000) correlation.delete(identity)
    }
    for (const [sessionId, pending] of [...pendingRetries]) {
      if (now - pending.at > PENDING_RETRY_TTL_MS) pendingRetries.delete(sessionId)
    }
    if (state.quota.mode === 'active') {
      // Probe every provider key, not only the ones a pool happens to use, so a
      // balance is ready before the user opens the page.
      for (const definition of allKeyDefs()) {
        const entry = quota.peek(definition.id)
        if (entry && entry.expiresAt > now) continue
        quota
          .revalidate(definition)
          .then((next) => {
            if (!next) return
            for (const poolState of poolStates()) {
              if (poolState.provider !== definition.provider) continue
              const orchestrator = pools.get(poolIdentity(poolState.provider, poolState.model))?.orchestrator
              if (!orchestrator) continue
              if (next.state === 'exhausted') orchestrator.noteQuotaExhausted(definition.id, 'probe')
              else if (next.state === 'ok' || next.state === 'low') orchestrator.clearQuota(definition.id, 'probe')
            }
            if (next.state === 'probe-failed') {
              warn('quota-check-failed', 'A provider quota endpoint could not be reached; that key falls back to passive 429 handling.')
            }
          })
          .catch(() => {})
      }
    }
  }

  /**
   * One maintenance pass that also performs the one-time adoption and the
   * pool bootstrap, so the panel is useful on first open even before any
   * interaction.
   */
  const housekeeping = async () => {
    if (disposed) return
    try {
      await buildCatalog()
      let changed = syncNativeProviderKeys()
      for (const provider of Object.keys(state.providers ?? {})) {
        if (ensurePoolsForProvider(provider)) changed = true
      }
      if (changed) {
        rebuildPools()
        persist()
      }
    } catch (error) {
      logLine(`housekeeping failed: ${String(error?.message ?? error)}`)
    }
    maintenance()
  }

  // -------------------------------------------------------------------- wiring

  rebuildPools()

  const listen = (name, handler) => {
    const disposer = ctx.on(name, handler)
    return () => {
      if (typeof disposer === 'function') disposer()
      else if (typeof ctx.off === 'function') ctx.off(name, handler)
    }
  }

  ctx.effect(() => listen('llm/stream', (options, next) => runPooled(options, next)))
  ctx.effect(() => listen('llm-pi-ai/request-headers', headerListener))
  ctx.effect(() => listen('agent/request-error', requestErrorListener))

  /** Refuse anything that is not a same-origin loopback request. */
  const guarded = (handler) => async (request, response) => {
    if (!loopbackRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'request-not-trusted' })
      return
    }
    return handler(request, response)
  }

  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/status`, handler: guarded(statusRoute) }),
  )
  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/config`, handler: guarded(configRoute) }),
  )
  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/probe`, handler: guarded(probeRoute) }),
  )
  ctx.effect(() =>
    ctx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/selftest`, handler: guarded(selftestRoute) }),
  )

  ctx.effect(() => {
    const timer = setInterval(housekeeping, 30_000)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
    }
  })

  ctx.effect(() => () => {
    disposed = true
    for (const entry of pools.values()) entry.orchestrator.dispose()
    pools.clear()
    quota.dispose()
    correlation.clear()
    pendingRetries.clear()
  })

  // Adopt the profile's existing provider keys and warm their balances right
  // after mount, so the panel has real numbers on its very first open.
  const startup = setTimeout(() => {
    housekeeping().catch(() => {})
  }, 1_200)
  if (startup && typeof startup.unref === 'function') startup.unref()

  logLine(`multi-key orchestration ready (state: ${store.path}, enabled: ${state.enabled === true})`)
}
