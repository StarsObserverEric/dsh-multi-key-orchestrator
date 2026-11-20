/**
 * Pure multi-key pool orchestration: lane capacity, leased key selection,
 * FIFO waiting, cooldown bookkeeping and failure classification.
 *
 * This module performs no I/O and owns no timers of its own beyond the two
 * primitives injected through `deps`, so every rule below is unit-testable
 * without a Host. `host.js` wires it to the `llm/stream` and
 * `llm-pi-ai/request-headers` waterfalls.
 *
 * @module dsh-multi-key-orchestrator/engine
 */

/** Lanes a lease can belong to. `child` is any subagent; `main` is the host process. */
const LANE = { main: 'main', child: 'child' }

/** Default silent backoff windows used while every key is parked. */
const DEFAULT_BACKOFF_MS = Object.freeze([30_000, 60_000, 120_000, 180_000])

/** A provider-supplied `Retry-After` is clamped into this range. */
const MIN_COOLDOWN_MS = 1_000
export const MAX_COOLDOWN_MS = 30 * 60_000
const DEFAULT_COOLDOWN_MS = 60_000

/** Key states projected to the panel. */
export const KEY_STATE = Object.freeze({
  healthy: 'healthy',
  cooldown: 'cooldown',
  quotaExhausted: 'quota_exhausted',
  disabled: 'disabled',
})

/**
 * Failure classes this plugin is allowed to act on.
 * `structural` must never rotate a key: a 401/403 or a malformed request is
 * the caller's problem, not the credential's.
 */
const FAILURE_KIND = Object.freeze({
  transient: 'transient',
  quota: 'quota',
  structural: 'structural',
  other: 'other',
})

/**
 * Phrases that mean "this key is out of budget", as opposed to "this key is
 * briefly throttled". Providers reuse 429 for both, so the status code alone
 * cannot decide; these are only consulted for 429/402 responses.
 */
const DEFAULT_QUOTA_PATTERNS = Object.freeze([
  'insufficient_quota',
  'insufficient quota',
  'quota',
  'billing',
  'budget',
  'credit balance',
  'out of credits',
  'credits exhausted',
  'credits',
  'credit limit',
  'payment required',
  '额度',
  '配额',
  '余额不足',
  '限制',
  '频繁',
  '超过',
])

/** Phrases that keep a 429 in the retryable class. */
const DEFAULT_TRANSIENT_PATTERNS = Object.freeze([
  'rate limit',
  'ratelimit',
  'too many requests',
  'overloaded',
  'try again',
  'temporarily',
  'concurrency',
])

/**
 * Raised when a pool can never satisfy a request within its own hard limits.
 * Surfaces as the `MULTI_KEY_POOL_EXHAUSTED` failure code instead of hanging.
 */
export class PoolExhaustedError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'PoolExhaustedError'
    this.code = 'MULTI_KEY_POOL_EXHAUSTED'
    this.detail = detail
  }
}

/** Raised when the caller aborted while a lease was still queued. */
export class LeaseAbortedError extends Error {
  constructor(message = 'lease cancelled') {
    super(message)
    this.name = 'LeaseAbortedError'
    this.code = 'MULTI_KEY_LEASE_ABORTED'
  }
}

/** @param {number} value @param {number} low @param {number} high */
export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/**
 * Bound an arbitrary label to something a credential ref may carry.
 * @param {string} value
 * @returns {string} upper-snake text, or `X` for empty input.
 */
function refSegment(value) {
  const cleaned = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 40) : 'X'
}

/**
 * Build the credential ref that owns one key's secret.
 * Every key gets its own ref: probes are per-key by construction, so a shared
 * ref would silently make two keys report the same balance.
 * @param {string} provider
 * @param {string} model
 * @param {string} keyId
 */
export function credentialRefFor(provider, model, keyId) {
  return `MULTIKEY_${refSegment(provider)}_${refSegment(model)}_${refSegment(keyId)}`
}

/**
 * Mask a secret for display.
 * The result is deliberately constant: the configured note is the identity of a
 * key, and a partial reveal would put real key characters on screen. The only
 * non-secret identifier surfaced elsewhere is the provider-side `api_key_id`
 * reported by the quota probe.
 * @param {string} secret
 */
export function maskSecret(secret) {
  const text = String(secret ?? '')
  if (text.length === 0) return '—'
  return '••••••'
}

/**
 * Classify one provider failure.
 *
 * The split that matters: a 429 caused by an exhausted balance must park the
 * key for a long time, while a 429 caused by transient rate limiting must be
 * retried on another key almost immediately. 401/403 and request-shape errors
 * are structural — rotating the key would only hide a real bug.
 *
 * @param {{ code?: string, status?: number, message?: string, providerRetryAfterMs?: number }} failure
 * @param {{ quotaPatterns?: readonly string[], transientPatterns?: readonly string[] }} [patterns]
 * @returns {{ kind: string, retryAfterMs?: number, reason: string }}
 */
export function classifyFailure(failure, patterns = {}) {
  // Adapters sometimes hand over only a message ("429 {...}") with no status
  // field. Treating that as status-less left a plain 429 classified as "other",
  // which re-threw the failure instead of rotating away from a dead key.
  const recovered = Number(/\b(4\d\d|5\d\d)\b/.exec(String(failure?.message ?? ''))?.[1] ?? 0)
  const status = Number(failure?.status ?? 0) || recovered
  const haystack = `${failure?.code ?? ''} ${failure?.message ?? ''}`.toLowerCase()

  if (status === 401 || status === 403) {
    return { kind: FAILURE_KIND.structural, reason: `http-${status}` }
  }
  if (status === 402) {
    return { kind: FAILURE_KIND.quota, reason: 'http-402' }
  }
  if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
    return { kind: FAILURE_KIND.structural, reason: `http-${status}` }
  }

  const quotaPatterns = patterns.quotaPatterns ?? DEFAULT_QUOTA_PATTERNS
  const transientPatterns = patterns.transientPatterns ?? DEFAULT_TRANSIENT_PATTERNS
  const matches = (list) => list.some((needle) => haystack.includes(String(needle).toLowerCase()))

  if (status === 429) {
    // A per-key concurrency ceiling is not a rate limit in the usual sense: the
    // provider is saying "this key already has N requests in flight". Waiting a
    // moment and using another key fixes it immediately, so it must never be
    // mistaken for an exhausted budget nor parked for the usual cooldown.
    if (/concurren|同时|并发/.test(haystack)) {
      return {
        kind: FAILURE_KIND.transient,
        retryAfterMs: Number(failure?.providerRetryAfterMs ?? 0) || 2_000,
        reason: 'concurrency-limited',
      }
    }
    // Transient wording wins only when nothing suggests a budget problem,
    // because "quota exceeded, retry later" is a budget problem that a retry
    // will never fix.
    const quotaHit = matches(quotaPatterns)
    const transientHit = matches(transientPatterns)
    if (quotaHit && !transientHit) return { kind: FAILURE_KIND.quota, reason: 'http-429-quota' }
    if (quotaHit && transientHit) {
      // Both present: trust the more specific budget wording unless the
      // provider also gave us an explicit short retry window.
      const retryAfter = Number(failure?.providerRetryAfterMs ?? 0)
      if (retryAfter > 0 && retryAfter <= 5 * 60_000) {
        return { kind: FAILURE_KIND.transient, retryAfterMs: retryAfter, reason: 'http-429-both-short' }
      }
      return { kind: FAILURE_KIND.quota, reason: 'http-429-both' }
    }
    return {
      kind: FAILURE_KIND.transient,
      retryAfterMs: Number(failure?.providerRetryAfterMs ?? 0) || undefined,
      reason: 'http-429',
    }
  }

  if (matches(quotaPatterns)) return { kind: FAILURE_KIND.quota, reason: 'message-quota' }
  return { kind: FAILURE_KIND.other, reason: `http-${status || 'none'}` }
}

/**
 * Turn a transient failure into the cooldown that key must serve.
 * Uses the provider's own hint when it sent one; never a fixed hour.
 * @param {{ providerRetryAfterMs?: number }} failure
 * @param {{ defaultMs?: number, maxMs?: number }} [options]
 */
export function cooldownFor(failure, options = {}) {
  const fallback = options.defaultMs ?? DEFAULT_COOLDOWN_MS
  const ceiling = options.maxMs ?? MAX_COOLDOWN_MS
  const hint = Number(failure?.providerRetryAfterMs ?? 0)
  const base = Number.isFinite(hint) && hint > 0 ? hint : fallback
  return clamp(base, MIN_COOLDOWN_MS, ceiling)
}

/**
 * Derive a 0..1 health score from the counters the panel also displays.
 * Recency only nudges the score; consecutive failures dominate.
 * @param {{ consecutiveFailures?: number, consecutive429s?: number, lastSuccessAt?: number, quotaExhausted?: boolean }} key
 * @param {number} now
 */
export function healthScore(key, now) {
  if (key?.quotaExhausted) return 0
  const failures = Number(key?.consecutiveFailures ?? 0)
  const throttles = Number(key?.consecutive429s ?? 0)
  const penalty = 0.5 ** failures
  const ratePenalty = 0.7 ** throttles
  const lastSuccess = Number(key?.lastSuccessAt ?? 0)
  const age = lastSuccess > 0 ? now - lastSuccess : Number.POSITIVE_INFINITY
  const recency = lastSuccess > 0 ? clamp(1 - age / 3_600_000, 0.2, 1) : 0.6
  return clamp(penalty * ratePenalty * recency, 0, 1)
}

/**
 * Fixed-size ring buffer for lease/cooldown telemetry.
 * @param {number} limit
 */
export function createLogRing(limit = 200) {
  const entries = []
  return {
    push(entry) {
      entries.push(entry)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
    },
    list() {
      return entries.slice()
    },
    clear() {
      entries.length = 0
    },
  }
}

/**
 * One pool = one `provider/model` pair with its own keys, cap and waiters.
 */
export class PoolOrchestrator {
  /**
   * @param {object} config pool configuration
   * @param {{
   *   now?: () => number,
   *   setTimeout?: Function,
   *   clearTimeout?: Function,
   *   onEvent?: (event: object) => void,
   *   providerGate?: { hasRoom: () => boolean, acquire: () => void, release: () => void, snapshot: () => object },
   * }} [deps]
   *   `providerGate` is the provider-wide cap shared by every pool of one
   *   provider, so "all keys of this provider together" is enforced across
   *   models rather than per model.
   */
  constructor(config, deps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.setTimeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle))
    this.onEvent = deps.onEvent ?? (() => {})
    this.providerGate = deps.providerGate ?? null

    /** @type {Map<string, any>} keyId -> live counters */
    this.keys = new Map()
    this.mainLeases = 0
    this.childLeases = 0
    /** Slots held by connectivity tests: never a lane, always counted. */
    this.testLeases = 0
    this.waiters = []
    this.cursor = 0
    this.seq = 0
    this.lastMainActivityAt = 0
    this.timer = null
    this.disposed = false
    this.applyConfig(config)
  }

  /** @returns {string} `provider/model` used in logs and as the pool identity. */
  get id() {
    return `${this.config?.provider ?? '?'}/${this.config?.model ?? '?'}`
  }

  /**
   * Replace configuration while keeping live counters for surviving keys.
   * A request already holding a lease is never preempted.
   * @param {object} config
   */
  applyConfig(config) {
    this.config = {
      provider: config?.provider ?? '',
      model: config?.model ?? '',
      maxConcurrent: Math.max(1, Number(config?.maxConcurrent ?? 4)),
      // An observation only: what the provider *said* its own ceiling was. It
      // never narrows admission unless the operator opts in, because the sum of
      // the per-key caps is the operator's decision, not the provider's guess.
      hardCeiling: Math.max(0, Number(config?.hardCeiling ?? 0)),
      reservedForMain: Math.max(0, Number(config?.reservedForMain ?? 1)),
      releaseReservationWhenIdle: config?.releaseReservationWhenIdle === true,
      idleGraceMs: Math.max(0, Number(config?.idleGraceMs ?? 30_000)),
      limits: {
        maxAttempts: Math.max(1, Number(config?.limits?.maxAttempts ?? 20)),
        maxWaitMs: Math.max(1_000, Number(config?.limits?.maxWaitMs ?? 30 * 60_000)),
        backoffWindowsMs:
          Array.isArray(config?.limits?.backoffWindowsMs) && config.limits.backoffWindowsMs.length > 0
            ? config.limits.backoffWindowsMs.slice()
            : DEFAULT_BACKOFF_MS.slice(),
      },
      classify: {
        quotaPatterns: config?.classify?.quotaPatterns ?? DEFAULT_QUOTA_PATTERNS,
        transientPatterns: config?.classify?.transientPatterns ?? DEFAULT_TRANSIENT_PATTERNS,
      },
    }
    const declared = Array.isArray(config?.keys) ? config.keys : []
    const seen = new Set()
    for (const key of declared) {
      if (!key?.id) continue
      seen.add(key.id)
      const existing = this.keys.get(key.id)
      const note = String(key.note ?? key.label ?? '')
      const maxConcurrent = Math.max(0, Number(key.maxConcurrent ?? 0))
      if (existing) {
        existing.disabled = key.enabled === false
        existing.ref = key.ref
        existing.note = note
        existing.maskedLabel = key.maskedLabel ?? existing.maskedLabel
        existing.maxConcurrent = maxConcurrent
      } else {
        this.keys.set(key.id, {
          id: key.id,
          ref: key.ref,
          note,
          maskedLabel: key.maskedLabel ?? '••••••',
          maxConcurrent,
          disabled: key.enabled === false,
          cooldownUntil: 0,
          consecutiveFailures: 0,
          consecutive429s: 0,
          lastSuccessAt: 0,
          activeLeases: 0,
          quotaExhausted: false,
        })
      }
    }
    for (const id of [...this.keys.keys()]) {
      if (!seen.has(id) && this.keys.get(id).activeLeases === 0) this.keys.delete(id)
    }
    this.pump()
  }

  /**
   * How many leases one lane may hold right now.
   * Children are capped at `maxConcurrent - reservedForMain` so the reserve is
   * physically un-stealable; the optional idle release lends it back.
   * @param {string} lane
   */
  capacity(lane) {
    const total = this.softTotal
    if (lane !== LANE.child) return total
    const reserved = this.config.reservedForMain
    const idleFor = this.now() - this.lastMainActivityAt
    const lending = this.config.releaseReservationWhenIdle && idleFor >= this.config.idleGraceMs
    return Math.max(0, total - (lending ? 0 : reserved))
  }

  /** @returns {number} leases currently held across both lanes */
  get activeLeases() {
    return this.mainLeases + this.childLeases
  }

  /**
   * The total this pool may actually hold right now: the operator's sum, capped
   * by an explicitly enforced provider ceiling. Everything that admits or counts
   * capacity uses this, never `config.maxConcurrent` directly.
   * @returns {number}
   */
  get softTotal() {
    const ceiling = Math.max(0, Number(this.config?.hardCeiling ?? 0))
    const total = Math.max(0, Number(this.config?.maxConcurrent ?? 0))
    return ceiling > 0 ? Math.min(total, ceiling) : total
  }

  /**
   * Resize the pool total in place. Raising it wakes queued requests at once;
   * lowering it never preempts a lease that is already running.
   * @param {number} value
   */
  setMaxConcurrent(value) {
    const next = Math.max(1, Number(value) || 1)
    const previous = Number(this.config.maxConcurrent ?? 0)
    if (next === previous) return next
    this.config.maxConcurrent = next
    this.onEvent({
      action: 'capacity',
      pool: this.id,
      detail: 'total ' + previous + ' -> ' + next + ' (admit ' + this.softTotal + ')',
    })
    if (this.softTotal > previous) this.pump()
    return next
  }

  /**
   * Record a provider-reported ceiling. Storage only — `enforceCeiling` decides
   * whether it narrows admission.
   * @param {number} value
   */
  setHardCeiling(value) {
    const next = Math.max(0, Number(value) || 0)
    if (next === Number(this.config.hardCeiling ?? 0)) return next
    this.config.hardCeiling = next
    this.onEvent({
      action: 'capacity',
      pool: this.id,
      detail: 'provider ceiling ' + next + ' (admit ' + this.softTotal + ')',
    })
    if (this.softTotal > this.activeLeases) this.pump()
    return next
  }

  /**
   * @param {string} lane
   * @param {(key: any) => boolean} [isEligible] caller-supplied gate (quota, etc.)
   */
  canAdmit(lane, isEligible) {
    if (this.disposed) return false
    // The provider-wide cap spans every model of this provider, so it is
    // checked before any of this pool's own limits.
    if (this.providerGate && !this.providerGate.hasRoom()) return false
    if (this.activeLeases >= this.softTotal) return false
    if (lane === LANE.child && this.childLeases >= this.capacity(LANE.child)) return false
    return Boolean(this.selectKey(isEligible))
  }

  /**
   * Whether a key may serve a request right now.
   * A per-key cap (`maxConcurrent > 0`) is honoured here, which makes it a real
   * limiter: an over-cap key is invisible to selection even when the pool has
   * spare capacity.
   * @param {any} key
   * @param {(key: any) => boolean} [isEligible]
   */
  isAvailable(key, isEligible) {
    if (!key || key.disabled || key.quotaExhausted) return false
    if (key.maxConcurrent > 0 && key.activeLeases >= key.maxConcurrent) return false
    if (key.cooldownUntil > this.now()) return false
    if (isEligible && !isEligible(key)) return false
    return true
  }

  /**
   * Pick the key for one admit step.
   * Order: fewest active leases, then the rotation cursor, then health, then the
   * most recently proven key.
   *
   * Rotation deliberately comes *before* health and recency. Sequential traffic
   * (one conversation, one request after another) has zero leases on every key,
   * so a recency-first order would keep picking whichever key succeeded last —
   * the same key forever, and the other keys' allowance never moved. Rotating
   * first makes a single conversation consume the keys evenly.
   * @param {(key: any) => boolean} [isEligible]
   */
  selectKey(isEligible) {
    const now = this.now()
    const entries = [...this.keys.values()]
    const candidates = []
    for (let index = 0; index < entries.length; index += 1) {
      const key = entries[index]
      if (!this.isAvailable(key, isEligible)) continue
      candidates.push({ key, index })
    }
    if (candidates.length === 0) return undefined
    const rotationRank = (index) => (index - this.cursor + entries.length) % entries.length
    candidates.sort((a, b) => {
      if (a.key.activeLeases !== b.key.activeLeases) return a.key.activeLeases - b.key.activeLeases
      const rotationDelta = rotationRank(a.index) - rotationRank(b.index)
      if (rotationDelta !== 0) return rotationDelta
      const healthDelta = healthScore(b.key, now) - healthScore(a.key, now)
      if (Math.abs(healthDelta) > 1e-9) return healthDelta
      return b.key.lastSuccessAt - a.key.lastSuccessAt
    })
    return candidates[0].key
  }

  /** @returns {Array<any>} keys that could serve a request right now */
  eligibleKeys(isEligible) {
    return [...this.keys.values()].filter((key) => this.isAvailable(key, isEligible))
  }

  /**
   * Acquire one lease, waiting in a bounded FIFO when the pool is full.
   * Resolves with a lease whose `release()` must be called from `finally`.
   *
   * @param {{ lane: string, signal?: AbortSignal, isEligible?: (key: any) => boolean }} request
   * @returns {Promise<{ keyId: string, lane: string, ref: string, maskedLabel: string, release: () => void, at: number }>}
   */
  acquire(request) {
    const lane = request.lane === LANE.main ? LANE.main : LANE.child
    const signal = request.signal
    const isEligible = request.isEligible
    if (this.disposed) {
      return Promise.reject(new PoolExhaustedError('pool disposed', { pool: this.id }))
    }
    if (signal?.aborted) return Promise.reject(new LeaseAbortedError())

    const direct = this.tryGrant(lane, isEligible)
    if (direct) return Promise.resolve(direct)

    return new Promise((resolve, reject) => {
      const waiter = {
        id: `w${++this.seq}`,
        lane,
        isEligible,
        resolve,
        reject,
        signal,
        startedAt: this.now(),
        retries: 0,
        timer: null,
        settled: false,
        onAbort: null,
      }
      if (signal) {
        waiter.onAbort = () => this.settleWaiter(waiter, new LeaseAbortedError(), null)
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.onEvent({
        action: 'wait',
        pool: this.id,
        lane,
        detail: `queued (${this.waiters.length} waiting, ${this.activeLeases}/${this.config.maxConcurrent} leased)`,
      })
      this.pump()
    })
  }

  /**
   * Attempt an immediate grant without queueing.
   * @returns {object | undefined}
   */
  tryGrant(lane, isEligible) {
    if (this.disposed) return undefined
    if (this.providerGate && !this.providerGate.hasRoom()) return undefined
    if (this.activeLeases >= this.softTotal) return undefined
    if (lane === LANE.child && this.childLeases >= this.capacity(LANE.child)) return undefined
    const key = this.selectKey(isEligible)
    if (!key) return undefined
    return this.createLease(key, lane)
  }

  /**
   * Reserve one real provider slot for a connectivity test.
   *
   * A test is a genuine request: it gets the same per-key ceiling and the same
   * provider gate as a conversation, so it can never push a key past the number
   * of requests the provider tolerates. It deliberately takes neither the main
   * lane (reserved for what the operator types) nor a child slot (reserved for
   * delegated work) — it is not a conversation, so it must not starve one.
   * When no slot frees up in time the caller is told, instead of the test
   * waiting forever or forcing a 429.
   *
   * @param {string} keyId
   * @param {{ waitMs?: number }} [options]
   */
  async testLease(keyId, options = {}) {
    const key = this.keys.get(String(keyId))
    if (!key) return { ok: false, reason: 'unknown-key' }
    const waitMs = Math.max(0, Number(options.waitMs ?? 8_000))
    const deadline = this.now() + waitMs
    const hasRoom = () => {
      if (key.maxConcurrent > 0 && key.activeLeases >= key.maxConcurrent) return false
      if (this.activeLeases + this.testLeases >= this.softTotal) return false
      if (this.providerGate && !this.providerGate.hasRoom()) return false
      return true
    }
    while (!hasRoom()) {
      if (this.now() >= deadline) return { ok: false, reason: 'busy' }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    key.activeLeases += 1
    this.testLeases += 1
    this.providerGate?.acquire()
    const at = this.now()
    let released = false
    return {
      ok: true,
      keyId: key.id,
      release: () => {
        if (released) return
        released = true
        const live = this.keys.get(key.id)
        if (live) live.activeLeases = Math.max(0, live.activeLeases - 1)
        this.testLeases = Math.max(0, this.testLeases - 1)
        this.providerGate?.release()
        this.onEvent({
          action: 'release',
          pool: this.id,
          key: key.id,
          lane: 'test',
          detail: 'test held ' + (this.now() - at) + 'ms',
        })
        this.pump()
      },
    }
  }

  /** @param {any} key @param {string} lane */
  createLease(key, lane) {
    if (lane === LANE.main) {
      this.mainLeases += 1
      this.lastMainActivityAt = this.now()
    } else {
      this.childLeases += 1
    }
    key.activeLeases += 1
    this.providerGate?.acquire()
    const entries = [...this.keys.keys()]
    const position = entries.indexOf(key.id)
    if (position >= 0) this.cursor = (position + 1) % Math.max(1, entries.length)

    const lease = {
      keyId: key.id,
      lane,
      ref: key.ref,
      maskedLabel: key.maskedLabel,
      at: this.now(),
      released: false,
      release: () => {
        if (lease.released) return
        lease.released = true
        if (lane === LANE.main) {
          this.mainLeases = Math.max(0, this.mainLeases - 1)
          this.lastMainActivityAt = this.now()
        } else {
          this.childLeases = Math.max(0, this.childLeases - 1)
        }
        const live = this.keys.get(lease.keyId)
        if (live) live.activeLeases = Math.max(0, live.activeLeases - 1)
        this.providerGate?.release()
        this.onEvent({
          action: 'release',
          pool: this.id,
          key: lease.keyId,
          lane,
          detail: `held ${this.now() - lease.at}ms`,
        })
        this.pump()
      },
    }
    this.onEvent({
      action: 'acquire',
      pool: this.id,
      key: lease.keyId,
      lane,
      detail: `leases=${key.activeLeases} pool=${this.activeLeases}/${this.config.maxConcurrent}`,
    })
    return lease
  }

  /**
   * Resolve queued waiters in FIFO order, honouring lane capacity.
   * A main waiter behind a child waiter is still admitted when the reserve
   * allows it — that is the whole point of the reservation.
   */
  pump() {
    if (this.disposed) return
    if (this.waiters.length === 0) {
      this.clearTimer()
      return
    }
    const now = this.now()
    let nextWakeAt = 0
    for (const waiter of [...this.waiters]) {
      if (waiter.settled) continue
      if (now - waiter.startedAt >= this.config.limits.maxWaitMs) {
        this.settleWaiter(
          waiter,
          new PoolExhaustedError(
            `no capacity for lane "${waiter.lane}" after ${Math.round((now - waiter.startedAt) / 1000)}s`,
            { pool: this.id, reason: 'wait-timeout' },
          ),
          null,
        )
        continue
      }
      const lease = this.tryGrant(waiter.lane, waiter.isEligible)
      if (lease) {
        this.settleWaiter(waiter, null, lease)
        continue
      }
      // Blocked. Distinguish "no slot" (wake on release) from "no usable key"
      // (silent backoff windows), because only the latter should burn attempts.
      const anySlot = this.activeLeases < this.config.maxConcurrent
      const laneFull = waiter.lane === LANE.child && this.childLeases >= this.capacity(LANE.child)
      const hasKey = Boolean(this.selectKey(waiter.isEligible))
      // Always keep the hard wait deadline on the timer, otherwise a waiter
      // parked on a long backoff window would overshoot maxWaitMs.
      const deadline = waiter.startedAt + this.config.limits.maxWaitMs
      nextWakeAt = nextWakeAt === 0 ? deadline : Math.min(nextWakeAt, deadline)
      if (hasKey) continue
      waiter.retries += 1
      if (waiter.retries > this.config.limits.maxAttempts) {
        this.settleWaiter(
          waiter,
          new PoolExhaustedError(
            `every key in ${this.id} is parked (last reason: ${this.quotaSummary()})`,
            { pool: this.id, reason: 'attempts' },
          ),
          null,
        )
        continue
      }
      const windows = this.config.limits.backoffWindowsMs
      const delay = windows[Math.min(waiter.retries - 1, windows.length - 1)]
      const wakeAt = now + delay
      nextWakeAt = nextWakeAt === 0 ? wakeAt : Math.min(nextWakeAt, wakeAt)
      this.onEvent({
        action: 'wait',
        pool: this.id,
        lane: waiter.lane,
        waitMs: delay,
        detail: anySlot && !laneFull ? `no eligible key, ${this.quotaSummary()}` : `cooldown, retry in ${delay}ms`,
      })
    }
    this.scheduleWake(nextWakeAt)
  }

  /**
   * Human-readable reason no key is usable, used in the exhausted error.
   */
  quotaSummary() {
    const keys = [...this.keys.values()]
    if (keys.length === 0) return 'no keys configured'
    const parked = keys.filter((k) => k.quotaExhausted).length
    const disabled = keys.filter((k) => k.disabled).length
    const cooling = keys.filter((k) => k.cooldownUntil > this.now()).length
    return `${parked} quota-exhausted, ${cooling} cooling, ${disabled} disabled of ${keys.length}`
  }

  /** @param {number} at */
  scheduleWake(at) {
    this.clearTimer()
    if (!at) return
    const delay = Math.max(50, at - this.now())
    this.timer = this.setTimeout(() => {
      this.timer = null
      this.pump()
    }, delay)
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
  }

  clearTimer() {
    if (this.timer === null) return
    this.clearTimeout(this.timer)
    this.timer = null
  }

  /** @param {object} waiter @param {Error|null} error @param {object|null} lease */
  settleWaiter(waiter, error, lease) {
    if (waiter.settled) {
      if (lease) lease.release()
      return
    }
    waiter.settled = true
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    if (waiter.timer !== null) this.clearTimeout(waiter.timer)
    if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
    if (error) waiter.reject(error)
    else waiter.resolve(lease)
  }

  /** A key answered successfully: clear everything negative about it. */
  noteSuccess(keyId) {
    const key = this.keys.get(keyId)
    if (!key) return
    if (key.consecutiveFailures > 0 || key.consecutive429s > 0 || key.cooldownUntil > 0 || key.quotaExhausted) {
      this.onEvent({ action: 'rotate', pool: this.id, key: keyId, detail: 'recovered' })
    }
    key.consecutiveFailures = 0
    key.consecutive429s = 0
    key.cooldownUntil = 0
    key.quotaExhausted = false
    key.lastSuccessAt = this.now()
  }

  /** A key returned a transient 429: park it for the provider's own window. */
  noteRateLimit(keyId, cooldownMs) {
    const key = this.keys.get(keyId)
    if (!key) return 0
    key.cooldownUntil = this.now() + Math.max(MIN_COOLDOWN_MS, Number(cooldownMs) || DEFAULT_COOLDOWN_MS)
    key.consecutive429s += 1
    key.consecutiveFailures += 1
    this.onEvent({
      action: 'cooldown',
      pool: this.id,
      key: keyId,
      waitMs: key.cooldownUntil - this.now(),
      detail: `429 #${key.consecutive429s}`,
    })
    this.pump()
    return key.cooldownUntil
  }

  /** A key is out of budget: exclude it from selection until a probe revives it. */
  noteQuotaExhausted(keyId, detail = 'quota') {
    const key = this.keys.get(keyId)
    if (!key) return
    key.quotaExhausted = true
    key.consecutiveFailures += 1
    this.onEvent({ action: 'quota', pool: this.id, key: keyId, detail })
    this.pump()
  }

  /** A probe reported credit again (or a request succeeded through it). */
  clearQuota(keyId, detail = 'probe-recovered') {
    const key = this.keys.get(keyId)
    if (!key || !key.quotaExhausted) return
    key.quotaExhausted = false
    this.onEvent({ action: 'quota', pool: this.id, key: keyId, detail })
    this.pump()
  }

  /** A non-429 failure landed on this key (counted, never rotated). */
  noteFailure(keyId) {
    const key = this.keys.get(keyId)
    if (!key) return
    key.consecutiveFailures += 1
  }

  /** Project one key for the panel. */
  projectKey(key, now = this.now()) {
    let state = KEY_STATE.healthy
    if (key.disabled) state = KEY_STATE.disabled
    else if (key.quotaExhausted) state = KEY_STATE.quotaExhausted
    else if (key.cooldownUntil > now) state = KEY_STATE.cooldown
    return {
      id: key.id,
      ref: key.ref,
      note: key.note,
      label: key.note,
      maskedLabel: key.maskedLabel,
      enabled: !key.disabled,
      maxConcurrent: key.maxConcurrent,
      state,
      healthScore: Number(healthScore(key, now).toFixed(3)),
      cooldownUntil: key.cooldownUntil > 0 ? key.cooldownUntil : null,
      consecutiveFailures: key.consecutiveFailures,
      consecutive429s: key.consecutive429s,
      lastSuccessAt: key.lastSuccessAt > 0 ? key.lastSuccessAt : null,
      activeLeases: key.activeLeases,
    }
  }

  /** Project the whole pool for the panel. */
  snapshot() {
    const now = this.now()
    return {
      provider: this.config.provider,
      model: this.config.model,
      maxConcurrent: this.config.maxConcurrent,
      hardCeiling: Math.max(0, Number(this.config.hardCeiling ?? 0)),
      admitTotal: this.softTotal,
      reservedForMain: this.config.reservedForMain,
      releaseReservationWhenIdle: this.config.releaseReservationWhenIdle,
      providerGate: this.providerGate ? this.providerGate.snapshot() : null,
      lane: {
        mainLeases: this.mainLeases,
        childLeases: this.childLeases,
        childCapacity: this.capacity(LANE.child),
        total: this.activeLeases,
        testLeases: this.testLeases,
        waiting: this.waiters.length,
      },
      keys: [...this.keys.values()].map((key) => this.projectKey(key, now)),
    }
  }

  /** Refuse every queued waiter and stop timers. */
  dispose() {
    this.disposed = true
    this.clearTimer()
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, new PoolExhaustedError('pool disposed', { pool: this.id }), null)
    }
    this.waiters.length = 0
  }
}
