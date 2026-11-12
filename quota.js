/**
 * Per-key credit probes.
 *
 * Every probe runs with **that key's own secret**. There is deliberately no
 * pool-level or provider-level fallback credential anywhere in this module: a
 * shared secret would make two keys report the same balance and would silently
 * reintroduce the single-key behaviour this plugin exists to remove.
 *
 * Freshness is stale-while-revalidate: a stale entry still decides routing,
 * and the refresh happens off the request path. Only a key that has never been
 * probed blocks, and even then only up to `timeoutMs`.
 *
 * @module dsh-multi-key-orchestrator/quota
 */

/** Normalised probe states shown on the balance card. */
const QUOTA_STATE = Object.freeze({
  ok: 'ok',
  low: 'low',
  exhausted: 'exhausted',
  unknown: 'unknown',
  failed: 'probe-failed',
  unsupported: 'unsupported',
})

/** Below this fraction of the total, a key is flagged `low` (routing is unaffected). */
const LOW_FRACTION = 0.15

/** @param {number} value */
function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * Sum every credit source in an ECNU quota body.
 *
 * The real shape (see `docs/quota-contract.md`) carries a 168 h window **and**
 * optional resource packs; either can be exhausted while the other is not, so
 * the usable number is the sum of positive remainders, and `used` may exceed
 * `total` for a pack, hence the clamp.
 *
 * @param {any} body
 * @param {number} now
 * @returns {{ state: string, remaining: number, total: number, used: number, unit: string, resetAt: string|null, account: object|null }}
 */
/**
 * The identity chip beside a key must never carry secret material.
 *
 * Some providers echo a masked key where an identifier belongs (OpenRouter
 * returns `sk-or-v1-95d...328` as a key label when the user never set one), so
 * anything shaped like a credential is dropped rather than displayed.
 * @param {unknown} value
 */
function safeAccountId(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  // `key_5638` is a legitimate ECNU identifier; `sk-...`/`pk-...` are not.
  if (/^(sk|pk|tok)[-_][A-Za-z0-9]/i.test(text)) return null
  if (/^[A-Za-z0-9_-]{6,}\.{2,3}[A-Za-z0-9_-]{2,}$/.test(text)) return null
  return text
}

export function normalizeEcnu(body, now = Date.now()) {
  const rawWindows = Array.isArray(body?.windows) ? body.windows : []
  const rawPacks = Array.isArray(body?.resource_packs) ? body.resource_packs : []

  const future = (value) => {
    if (typeof value !== 'string') return 0
    const time = Date.parse(value)
    return Number.isFinite(time) && time > now ? time : 0
  }

  // One credit budget, two very different things:
  //   windows  — the recurring allowance (ECNU: one 7-day window) that refills,
  //   packs     — one-shot purchases that never come back once spent.
  // Summing them into a single "total" invents a number the account never has,
  // so the headline stays the recurring window and packs are shown apart.
  const windows = rawWindows.map((window) => ({
    type: typeof window?.type === 'string' ? window.type : 'window',
    limit: positive(window?.limit),
    used: positive(window?.used),
    remaining: positive(window?.remaining),
    resetAt: future(window?.reset_at) > 0 ? new Date(Date.parse(window.reset_at)).toISOString() : null,
  }))

  const packs = rawPacks
    .map((pack) => ({
      name: typeof pack?.name === 'string' ? pack.name : 'pack',
      total: positive(pack?.total_credits),
      used: positive(pack?.used_credits),
      // A pack can be overdrawn; the spendable part is what matters.
      remaining: Math.max(0, Number(pack?.remaining_credits) || 0),
      expiresAt: future(pack?.expires_at) > 0 ? new Date(Date.parse(pack.expires_at)).toISOString() : null,
    }))
    // An exhausted pack is noise: the user asked for it to disappear.
    .filter((pack) => pack.remaining > 0)

  const total = windows.reduce((sum, window) => sum + window.limit, 0)
  const used = windows.reduce((sum, window) => sum + window.used, 0)
  const remaining = windows.reduce((sum, window) => sum + window.remaining, 0)
  const bonusRemaining = packs.reduce((sum, pack) => sum + pack.remaining, 0)
  const spendable = remaining + bonusRemaining

  const resetCandidates = [
    ...windows.map((window) => (window.resetAt ? Date.parse(window.resetAt) : 0)),
    ...packs.map((pack) => (pack.expiresAt ? Date.parse(pack.expiresAt) : 0)),
  ].filter((time) => time > 0)

  let state = QUOTA_STATE.ok
  if (spendable <= 0) state = QUOTA_STATE.exhausted
  else if (total > 0 && spendable <= total * LOW_FRACTION) state = QUOTA_STATE.low

  return {
    state,
    // `remaining` is what the key can still spend in total; `total` is the
    // recurring allowance alone, which is what the progress bar should divide by.
    remaining: Number(spendable.toFixed(4)),
    total: Number(total.toFixed(4)),
    used: Number(used.toFixed(4)),
    unit: typeof body?.unit === 'string' && body.unit.length > 0 ? body.unit : 'credits',
    resetAt: resetCandidates.length > 0 ? new Date(Math.min(...resetCandidates)).toISOString() : null,
    windows,
    bonus: { remaining: Number(bonusRemaining.toFixed(4)), packs },
    account: {
      providerId: typeof body?.provider_id === 'string' ? body.provider_id : null,
      apiKeyId: safeAccountId(body?.api_key_id),
    },
  }
}

/**
 * DeepSeek platform balance, in CNY.
 *
 * `GET /user/balance` answers `{ is_available, balance_infos: [{ currency,
 * total_balance, granted_balance, topped_up_balance }] }`. It needs a platform
 * API key; an account that signed in through OAuth has no such key, which is why
 * the caller decides whether this adapter is even reachable.
 * @param {any} body
 */
export function normalizeDeepseek(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const cny = infos.find((info) => String(info?.currency ?? '').toUpperCase() === 'CNY') ?? infos[0]
  if (!cny) {
    return {
      state: QUOTA_STATE.unsupported,
      remaining: 0,
      total: null,
      used: null,
      unit: 'CNY',
      resetAt: null,
      windows: [],
      bonus: { remaining: 0, packs: [] },
      account: { providerId: 'deepseek', apiKeyId: null },
    }
  }
  const remaining = positive(cny?.total_balance)
  // DeepSeek has no weekly window: it is prepaid money that runs out and is topped up.
  return {
    state: remaining > 0 ? QUOTA_STATE.ok : QUOTA_STATE.exhausted,
    remaining: Number(remaining.toFixed(4)),
    total: null,
    used: null,
    unit: 'CNY',
    resetAt: null,
    windows: [],
    bonus: { remaining: 0, packs: [] },
    account: { providerId: 'deepseek', apiKeyId: null },
    granted: positive(cny?.granted_balance),
    toppedUp: positive(cny?.topped_up_balance),
    available: body?.is_available !== false,
  }
}

/**
 * OpenRouter reports prepaid credits on `/credits` and a per-key limit on `/key`.
 * @param {any} credits @param {any} keyInfo
 */
function normalizeOpenRouter(credits, keyInfo) {
  const total = positive(credits?.data?.total_credits ?? credits?.total_credits)
  const usage = positive(credits?.data?.total_usage ?? credits?.total_usage)
  const remaining = Math.max(0, total - usage)
  const limitRemaining = keyInfo?.data?.limit_remaining ?? keyInfo?.limit_remaining
  const usable = Number.isFinite(Number(limitRemaining)) ? Math.min(remaining, positive(limitRemaining)) : remaining
  let state = QUOTA_STATE.ok
  if (usable <= 0 && total > 0) state = QUOTA_STATE.exhausted
  else if (total > 0 && usable <= total * LOW_FRACTION) state = QUOTA_STATE.low
  return {
    state,
    remaining: Number(usable.toFixed(4)),
    total: Number(total.toFixed(4)),
    used: Number(usage.toFixed(4)),
    unit: 'credits',
    resetAt: null,
    account: { providerId: 'openrouter', apiKeyId: safeAccountId(keyInfo?.data?.label) },
  }
}

/**
 * Resolve a dotted path (`data.items[0].value`) against a JSON value.
 * @param {any} source
 * @param {string} path
 */
export function readJsonPath(source, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let cursor = source
  for (const raw of path.split('.')) {
    const parts = raw.match(/[^[\]]+|\[\d+\]/g)
    if (!parts) return undefined
    for (const part of parts) {
      if (cursor === null || cursor === undefined) return undefined
      if (part.startsWith('[')) cursor = cursor[Number(part.slice(1, -1))]
      else cursor = cursor[part]
    }
  }
  return cursor
}

/**
 * Last-resort extraction for a provider whose body shape drifted: walk the
 * object and take the first numeric field whose name looks like a remainder.
 * @param {any} body
 */
export function tolerantExtract(body) {
  const remainderNames = /(remaining|remainder|available|balance|left|unused)/i
  const totalNames = /(total|limit|max|granted|allowed|cap)/i
  const buckets = { remaining: [], total: [] }
  const walk = (node, depth) => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    for (const [name, value] of Object.entries(node)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        // A name such as `credit_limit` mentions credit but is a ceiling, so
        // the ceiling test runs first and the remainder test only sees names
        // that genuinely describe what is left.
        if (remainderNames.test(name)) buckets.remaining.push(value)
        else if (totalNames.test(name)) buckets.total.push(value)
      } else if (value && typeof value === 'object') {
        walk(value, depth + 1)
      }
    }
  }
  walk(body, 0)
  if (buckets.remaining.length === 0) return null
  const remaining = Math.max(...buckets.remaining)
  const total = buckets.total.length > 0 ? Math.max(...buckets.total) : remaining
  return { remaining, total }
}

/** @param {number} now @param {number} ms */
function addMs(now, ms) {
  return now + Math.max(1_000, Math.round(ms))
}

/**
 * Create the probe cache shared by routing and the panel.
 *
 * @param {{
 *   now?: () => number,
 *   fetchImpl?: typeof fetch,
 *   getSecret: (ref: string) => Promise<string | undefined>,
 *   getPolicy: () => { mode: string, ttlMs: number, recheckExhaustedMs: [number, number], timeoutMs: number },
 *   log?: (event: object) => void,
 * }} deps
 */
export function createQuotaService(deps) {
  const now = deps.now ?? (() => Date.now())
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const getSecret = deps.getSecret
  const getPolicy = deps.getPolicy ?? (() => ({
    mode: 'active',
    ttlMs: 60_000,
    recheckExhaustedMs: [1_800_000, 3_600_000],
    timeoutMs: 5_000,
  }))
  const log = deps.log ?? (() => {})

  /** @type {Map<string, any>} keyId -> entry */
  const entries = new Map()
  /** @type {Map<string, Promise<any>>} keyId -> in-flight probe */
  const inflight = new Map()
  /** @type {Map<string, any>} keyId -> last successful numbers, kept across failures */
  const lastGood = new Map()
  let disposed = false

  const recheckDelay = () => {
    const policy = getPolicy()
    const range = Array.isArray(policy.recheckExhaustedMs) ? policy.recheckExhaustedMs : [1_800_000, 3_600_000]
    const low = Math.max(60_000, Number(range[0]) || 1_800_000)
    const high = Math.max(low, Number(range[1]) || 3_600_000)
    return low + Math.random() * (high - low)
  }

  const expireAt = (state) => {
    const policy = getPolicy()
    return addMs(now(), state === QUOTA_STATE.exhausted ? recheckDelay() : Number(policy.ttlMs ?? 60_000))
  }

  const makeEntry = (keyId, fields) => {
    const next = {
      keyId,
      state: QUOTA_STATE.unknown,
      remaining: null,
      total: null,
      used: null,
      unit: 'credits',
      resetAt: null,
      account: null,
      checkedAt: 0,
      expiresAt: 0,
      error: null,
      supported: true,
      ...fields,
    }
    next.expiresAt = fields.expiresAt ?? expireAt(next.state)
    return next
  }

  /** Which adapter serves this key. Explicit configuration wins. */
  const adapterFor = (key) => {
    const explicit = key?.probe?.type
    if (explicit) return explicit
    const hint = `${key?.provider ?? ''} ${key?.baseURL ?? ''}`.toLowerCase()
    if (hint.includes('ecnu')) return 'ecnu'
    if (hint.includes('openrouter')) return 'openrouter'
    if (hint.includes('deepseek')) return 'deepseek'
    return 'none'
  }

  const withTimeout = async (url, init, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 5_000))
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Run one probe for one key. Never throws: an unreachable endpoint becomes a
   * `probe-failed` entry so routing degrades to passive instead of stalling.
   */
  const runProbe = async (key) => {
    const startedAt = now()
    const policy = getPolicy()
    const adapter = adapterFor(key)
    if (adapter === 'none') {
      return makeEntry(key.id, {
        state: QUOTA_STATE.unsupported,
        supported: false,
        checkedAt: startedAt,
        error: 'no quota endpoint known for this provider',
        expiresAt: addMs(startedAt, Number(policy.ttlMs ?? 60_000) * 10),
      })
    }

    const secret = await getSecret(key.ref)
    if (!secret) {
      return makeEntry(key.id, {
        state: QUOTA_STATE.failed,
        checkedAt: startedAt,
        error: 'credential-missing',
      })
    }

    try {
      let outcome
      if (adapter === 'ecnu') {
        const base = String(key.baseURL ?? '').replace(/\/+$/, '')
        if (base.length === 0) throw new Error('no baseURL for provider')
        const response = await withTimeout(
          `${base}/quota`,
          { method: 'GET', headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' } },
          policy.timeoutMs,
        )
        if (response.status === 401 || response.status === 403) {
          return makeEntry(key.id, {
            state: QUOTA_STATE.failed,
            checkedAt: startedAt,
            error: 'quota-auth',
          })
        }
        if (response.status === 404 || response.status === 405) {
          return makeEntry(key.id, {
            state: QUOTA_STATE.unsupported,
            supported: false,
            checkedAt: startedAt,
            error: `http-${response.status}`,
            expiresAt: addMs(startedAt, Number(policy.ttlMs ?? 60_000) * 10),
          })
        }
        if (!response.ok) throw new Error(`http-${response.status}`)
        const body = await response.json()
        outcome = normalizeEcnu(body, now())
        if (outcome.remaining === 0 && outcome.total === 0) {
          const tolerant = tolerantExtract(body)
          if (tolerant) {
            outcome.remaining = tolerant.remaining
            outcome.total = tolerant.total
            outcome.state = tolerant.remaining <= 0 ? QUOTA_STATE.exhausted : QUOTA_STATE.ok
          }
        }
      } else if (adapter === 'deepseek') {
        // The platform balance endpoint takes a platform API key (`sk-...`).
        // An account signed in through OAuth has no such key, so report why the
        // number is missing instead of pretending it is zero.
        if (!/^sk-[A-Za-z0-9]/.test(secret)) {
          return makeEntry(key.id, {
            state: QUOTA_STATE.unsupported,
            supported: false,
            checkedAt: startedAt,
            error: 'deepseek-oauth-account',
            expiresAt: addMs(startedAt, Number(policy.ttlMs ?? 60_000) * 10),
          })
        }
        const response = await withTimeout(
          'https://api.deepseek.com/user/balance',
          { method: 'GET', headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' } },
          policy.timeoutMs,
        )
        if (response.status === 401 || response.status === 403) {
          return makeEntry(key.id, { state: QUOTA_STATE.failed, checkedAt: startedAt, error: 'quota-auth' })
        }
        if (!response.ok) throw new Error(`http-${response.status}`)
        outcome = normalizeDeepseek(await response.json())
      } else if (adapter === 'openrouter') {
        const base = String(key.baseURL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
        const headers = { Authorization: `Bearer ${secret}`, Accept: 'application/json' }
        const credits = await withTimeout(`${base}/credits`, { method: 'GET', headers }, policy.timeoutMs)
        if (credits.status === 401 || credits.status === 403) {
          return makeEntry(key.id, {
            state: QUOTA_STATE.failed,
            checkedAt: startedAt,
            error: 'quota-auth',
          })
        }
        if (!credits.ok) throw new Error(`http-${credits.status}`)
        let keyInfo = null
        try {
          const info = await withTimeout(`${base}/key`, { method: 'GET', headers }, policy.timeoutMs)
          if (info.ok) keyInfo = await info.json()
        } catch {
          keyInfo = null
        }
        outcome = normalizeOpenRouter(await credits.json(), keyInfo)
      } else if (adapter === 'openai-billing') {
        const base = String(key.baseURL ?? '').replace(/\/+$/, '')
        const response = await withTimeout(
          `${base}/dashboard/billing/credit_grants`,
          { method: 'GET', headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' } },
          policy.timeoutMs,
        )
        if (response.status === 404) {
          return makeEntry(key.id, {
            state: QUOTA_STATE.unsupported,
            supported: false,
            checkedAt: startedAt,
            error: 'http-404',
            expiresAt: addMs(startedAt, Number(policy.ttlMs ?? 60_000) * 10),
          })
        }
        if (!response.ok) throw new Error(`http-${response.status}`)
        const body = await response.json()
        const remaining = positive(body?.total_available ?? body?.total_remaining)
        outcome = {
          state: remaining <= 0 ? QUOTA_STATE.exhausted : QUOTA_STATE.ok,
          remaining,
          total: positive(body?.total_granted) || remaining,
          used: positive(body?.total_used),
          unit: 'credits',
          resetAt: null,
          account: null,
        }
      } else {
        // `custom`: the operator supplies the URL and the JSON paths.
        const url = key?.probe?.url
        if (typeof url !== 'string' || url.length === 0) throw new Error('custom probe needs a url')
        const response = await withTimeout(
          url,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', ...(key?.probe?.headers ?? {}) },
          },
          policy.timeoutMs,
        )
        if (!response.ok) throw new Error(`http-${response.status}`)
        const body = await response.json()
        const remaining = Number(readJsonPath(body, key?.probe?.jsonPath?.remaining))
        const total = Number(readJsonPath(body, key?.probe?.jsonPath?.total))
        if (!Number.isFinite(remaining)) throw new Error('custom probe found no remaining value')
        outcome = {
          state: remaining <= 0 ? QUOTA_STATE.exhausted : QUOTA_STATE.ok,
          remaining,
          total: Number.isFinite(total) ? total : remaining,
          used: 0,
          unit: key?.probe?.unit ?? 'credits',
          resetAt: null,
          account: null,
        }
      }

      lastGood.set(key.id, outcome)
      const entry = makeEntry(key.id, {
        ...outcome,
        checkedAt: now(),
        error: null,
        supported: true,
      })
      log({ action: 'probe', key: key.id, detail: `${adapter} ${entry.state} remaining=${entry.remaining}` })
      return entry
    } catch (error) {
      const previous = lastGood.get(key.id)
      const entry = makeEntry(key.id, {
        state: QUOTA_STATE.failed,
        remaining: previous?.remaining ?? null,
        total: previous?.total ?? null,
        used: previous?.used ?? null,
        unit: previous?.unit ?? 'credits',
        resetAt: previous?.resetAt ?? null,
        account: previous?.account ?? null,
        checkedAt: now(),
        error: String(error?.message ?? error).slice(0, 200),
        supported: true,
      })
      log({ action: 'probe', key: key.id, detail: `${adapter} failed: ${entry.error}` })
      return entry
    }
  }

  const store = (entry) => {
    entries.set(entry.keyId, entry)
    return entry
  }

  return {
    /** @param {string} keyId */
    peek(keyId) {
      return entries.get(keyId)
    },

    /**
     * Probe now, deduplicating concurrent probes for the same key.
     * @param {any} key
     */
    revalidate(key) {
      if (disposed) return Promise.resolve(entries.get(key.id))
      const running = inflight.get(key.id)
      if (running) return running
      const task = runProbe(key)
        .then((entry) => store(entry))
        .catch((error) => {
          const entry = makeEntry(key.id, {
            state: QUOTA_STATE.failed,
            checkedAt: now(),
            error: String(error?.message ?? error).slice(0, 200),
          })
          return store(entry)
        })
        .finally(() => {
          inflight.delete(key.id)
        })
      inflight.set(key.id, task)
      return task
    },

    /**
     * Routing-facing read with stale-while-revalidate.
     *
     * - `off`: never probes, never gates.
     * - no cache yet: one bounded synchronous probe.
     * - fresh: cached entry.
     * - stale: returns the stale entry immediately and refreshes in the
     *   background, so a request never waits on a billing endpoint.
     *
     * @param {any} key
     */
    async decide(key) {
      const policy = getPolicy()
      if (policy.mode === 'off') return undefined
      const cached = entries.get(key.id)
      // Passive mode means exactly this: the request path never calls the
      // biller. Balances still arrive through an explicit panel refresh.
      if (policy.mode === 'passive') return cached
      if (!cached) return this.revalidate(key)
      if (cached.expiresAt > now()) return cached
      this.revalidate(key).catch(() => {})
      return cached
    },

    /** Panel-driven refresh; always awaits. */
    manual(key) {
      return this.revalidate(key)
    },

    /**
     * Project one entry for the wire, flagging staleness at read time so the
     * client can say "this number is old" without the server refreshing it.
     * @param {string} keyId
     */
    view(keyId) {
      const entry = entries.get(keyId)
      if (!entry) return null
      const current = now()
      return {
        state: entry.state,
        remaining: entry.remaining,
        total: entry.total,
        used: entry.used,
        unit: entry.unit,
        checkedAt: entry.checkedAt,
        nextCheckAt: entry.expiresAt,
        stale: entry.checkedAt + Number(getPolicy().ttlMs ?? 60_000) < current,
        resetAt: entry.resetAt,
        // The recurring window is the headline; one-shot packs ride alongside and
        // are already filtered down to the ones that still hold something.
        windows: entry.windows ?? [],
        bonus: entry.bonus ?? { remaining: 0, packs: [] },
        account: entry.account,
        supported: entry.supported,
        error: entry.error,
      }
    },

    /** Keys whose cached entry has expired and may be refreshed in the background. */
    staleKeys() {
      const current = now()
      const out = []
      for (const [keyId, entry] of entries) {
        if (entry.expiresAt <= current) out.push(keyId)
      }
      return out
    },

    /**
     * Whether this entry says the key must not receive requests.
     * A failed probe is *not* a blocker: without a number we fall back to
     * passive 429 handling rather than refusing to route.
     * @param {string} keyId
     */
    isExhausted(keyId) {
      const entry = entries.get(keyId)
      return Boolean(entry && entry.state === QUOTA_STATE.exhausted)
    },

    /** @param {string} keyId */
    invalidate(keyId) {
      entries.delete(keyId)
      lastGood.delete(keyId)
    },

    dispose() {
      disposed = true
      inflight.clear()
      entries.clear()
      lastGood.clear()
    },
  }
}
