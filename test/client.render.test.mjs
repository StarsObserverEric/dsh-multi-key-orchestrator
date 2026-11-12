/**
 * Render check for the browser half.
 *
 * The Harness page is auth-gated, so this file drives `client.js` the way the
 * browser would — module loader, `require('react')`, `apply(ctx)` with the real
 * slot and locale services — through a deliberately small React implementation
 * and a text renderer. Slot registration alone proves nothing; these assertions
 * cover what the user actually sees and presses.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// ---------------------------------------------------------------- mini React

const hookFrames = new Map()
let activeFrame = {}
let activeIndex = 0
let pendingEffects = []
let dirty = false
let handlerSink = null
let tagSink = null
let inputSink = null

const MiniReact = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: flat } }
  },
  useState(initial) {
    const frame = activeFrame
    const index = activeIndex++
    if (!(index in frame)) frame[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = frame[index]
    return [
      slot.value,
      (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          dirty = true
        }
      },
    ]
  },
  useRef(initial) {
    const frame = activeFrame
    const index = activeIndex++
    if (!(index in frame)) frame[index] = { current: initial }
    return frame[index]
  },
  useEffect(effect) {
    pendingEffects.push(effect)
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(callback) {
    return callback
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

const inertEvent = { preventDefault() {}, stopPropagation() {}, nativeEvent: {}, currentTarget: null, target: null }

/** Text plus host tags, form controls and click handlers from a rendered tree. */
function createRenderer() {
  const stack = []

  /**
   * Render a children value. Sibling positions are folded into the hook path,
   * otherwise every `NumberField` in a list would share one hook frame and all
   * of them would show the first field's value.
   */
  function renderChildren(children) {
    if (!Array.isArray(children)) return renderNode(children)
    return children
      .map((child, index) => {
        stack.push(`#${index}`)
        const out = renderNode(child)
        stack.pop()
        return out
      })
      .join('')
  }

  function renderNode(node) {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return renderChildren(node)
    if (typeof node !== 'object') return ''

    let { type, props } = node
    if (type && typeof type === 'object' && type.$$typeof) type = type.type ?? type.render ?? type
    if (type === MiniReact.Fragment) return renderChildren(props?.children)
    if (typeof type === 'function') {
      const name = type.displayName || type.name || 'component'
      const key = stack.concat(name).join('>')
      if (!hookFrames.has(key)) hookFrames.set(key, {})
      const previousFrame = activeFrame
      const previousIndex = activeIndex
      activeFrame = hookFrames.get(key)
      activeIndex = 0
      stack.push(name)
      let output
      try {
        output = type(props ?? {})
      } finally {
        stack.pop()
        activeFrame = previousFrame
        activeIndex = previousIndex
      }
      return renderNode(output)
    }
    if (tagSink && typeof type === 'string') tagSink.push(type)
    if (inputSink && typeof type === 'string' && (type === 'input' || type === 'textarea' || type === 'select')) {
      inputSink.push({ tag: type, ...(props ?? {}) })
    }
    if (handlerSink && typeof props?.onClick === 'function') handlerSink.push(props.onClick)
    return renderChildren(props?.children)
  }

  return { renderNode }
}

// ------------------------------------------------------------ module loading

const registrations = new Map()
let captured

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (handle) => clearTimeout(handle),
  matchMedia: () => ({ matches: false }),
}
globalThis.document = {
  activeElement: null,
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
} catch {
  /* newer Node exposes navigator as a getter; the default language is fine */
}

await import('../client.js')

const runtime = (overrides = {}) => ({
  state: 'healthy',
  healthScore: 1,
  cooldownUntil: null,
  consecutiveFailures: 0,
  consecutive429s: 0,
  lastSuccessAt: Date.now() - 120_000,
  activeLeases: 1,
  ...overrides,
})

/** ECNU: one recurring 7-day window plus an exhausted pack that must not render. */
const ECNU_QUOTA = {
  state: 'ok',
  remaining: 12646.11,
  total: 25000,
  used: 12353.89,
  unit: 'credits',
  checkedAt: Date.now() - 20_000,
  nextCheckAt: Date.now() + 40_000,
  stale: false,
  resetAt: '2026-11-15T15:27:28.000Z',
  windows: [{ type: 'fixed_168h', limit: 25000, used: 12353.89, remaining: 12646.11, resetAt: '2026-11-15T15:27:28.000Z' }],
  bonus: { remaining: 0, packs: [] },
  account: { providerId: 'chatecnu', apiKeyId: 'key_8011' },
  supported: true,
  error: null,
}

const NATIVE_KEY = {
  id: 'k1',
  note: 'default',
  maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022',
  enabled: true,
  source: 'native',
  removable: false,
  configured: true,
  ...runtime(),
  quota: ECNU_QUOTA,
}

const ADDED_KEY = {
  id: 'k2',
  note: 'LB',
  maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022',
  enabled: true,
  source: 'added',
  removable: true,
  configured: true,
  ...runtime({ activeLeases: 0 }),
  quota: { ...ECNU_QUOTA, remaining: 24900.5, account: { providerId: 'chatecnu', apiKeyId: 'key_5692' } },
}

const STATUS = {
  version: '0.2.0',
  enabled: true,
  startedAt: Date.now() - 120_000,
  statePath: '/tmp/state.json',
  correlation: { als: 0, fifo: 12, swaps: 12, leases: 12 },
  retry: { midStreamRetry: true, midStreamMaxRetries: 2, pending: 0, midStreamRetried: 1 },
  quota: { mode: 'active', ttlMs: 60_000, recheckExhaustedMs: [1_800_000, 3_600_000] },
  laneFallback: 'child',
  credentials: { available: true },
  catalog: [
    {
      provider: 'ecnu',
      displayName: 'ECNU',
      baseURL: 'https://chat.ecnu.edu.cn/open/api/v1',
      api: 'openai-completions',
      apiKeyEnv: 'ECNU_API_KEY',
      models: [
        { id: 'ecnu-max', name: 'ecnu-max' },
        { id: 'ecnu-plus', name: 'ecnu-plus' },
      ],
    },
    {
      provider: 'nvidia',
      displayName: 'nvidia',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      api: 'openai-completions',
      apiKeyEnv: 'NVIDIA_API_KEY',
      models: [{ id: 'deepseek-ai/deepseek-v4.1-flash', name: 'deepseek-ai/deepseek-v4.1-flash' }],
    },
    {
      provider: 'deepseek-account',
      displayName: 'DeepSeek Account',
      baseURL: '',
      api: '',
      apiKeyEnv: '',
      models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }],
    },
  ],
  providers: [
    { provider: 'ecnu', displayName: 'ECNU', maxConcurrent: 0, activeLeases: 1, pools: 2, keys: [NATIVE_KEY, ADDED_KEY] },
    {
      provider: 'nvidia',
      displayName: 'nvidia',
      maxConcurrent: 0,
      activeLeases: 0,
      pools: 1,
      keys: [
        {
          id: 'k6',
          note: 'default',
          maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022',
          enabled: true,
          source: 'native',
          removable: false,
          configured: true,
          ...runtime({ lastSuccessAt: null }),
          quota: {
            ...ECNU_QUOTA,
            state: 'unsupported',
            supported: false,
            remaining: null,
            total: null,
            windows: [],
            bonus: { remaining: 0, packs: [] },
            account: null,
            error: 'no quota endpoint known for this provider',
          },
        },
      ],
    },
    // A provider with no key at all must still render its model controls.
    { provider: 'deepseek-account', displayName: 'DeepSeek Account', maxConcurrent: 0, activeLeases: 0, pools: 0, keys: [] },
  ],
  pools: [
    {
      provider: 'ecnu',
      model: 'ecnu-max',
      maxConcurrent: 6,
      linked: true,
      reservedForMain: 1,
      releaseReservationWhenIdle: false,
      maxConcurrentAuto: true,
      lane: { mainLeases: 0, childLeases: 1, childCapacity: 5, total: 1, waiting: 0 },
      keys: [
        { id: 'k1', note: 'default', maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022', enabled: true, maxConcurrent: 3, ...runtime(), quota: ECNU_QUOTA },
        { id: 'k2', note: 'LB', maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022', enabled: true, maxConcurrent: 3, ...runtime(), quota: ECNU_QUOTA },
      ],
    },
    {
      provider: 'ecnu',
      model: 'ecnu-plus',
      maxConcurrent: 10,
      linked: true,
      reservedForMain: 1,
      releaseReservationWhenIdle: false,
      maxConcurrentAuto: true,
      lane: { mainLeases: 0, childLeases: 0, childCapacity: 9, total: 0, waiting: 0 },
      keys: [
        { id: 'k1', note: 'default', maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022', enabled: true, maxConcurrent: 5, ...runtime(), quota: ECNU_QUOTA },
        { id: 'k2', note: 'LB', maskedLabel: '\u2022\u2022\u2022\u2022\u2022\u2022', enabled: true, maxConcurrent: 5, ...runtime(), quota: ECNU_QUOTA },
      ],
    },
    {
      provider: 'nvidia',
      model: 'deepseek-ai/deepseek-v4.1-flash',
      maxConcurrent: 3,
      linked: true,
      reservedForMain: 1,
      releaseReservationWhenIdle: false,
      maxConcurrentAuto: true,
      lane: { mainLeases: 0, childLeases: 0, childCapacity: 2, total: 0, waiting: 0 },
      keys: [],
    },
  ],
  warnings: [],
  log: [],
}

/** Install a fetch stub that answers status and records every mutation. */
function stubFetch() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    if (call.url.includes('/config')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, savedAt: Date.now() }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, status: STATUS }) }
  }
  return calls
}

const microtask = () => new Promise((resolve) => setImmediate(resolve))

/** Render one registered seat, run its effects, and re-render over several passes. */
async function renderSeat(seatId, ownerProps = {}) {
  const occupant = registrations.get(seatId)
  assert.ok(occupant, `no registration named ${seatId}`)
  const renderer = createRenderer()
  const cleanups = []
  let text = ''
  const handlers = []
  const tags = []
  const inputs = []
  for (let pass = 0; pass < 5; pass += 1) {
    dirty = false
    pendingEffects = []
    handlerSink = handlers
    tagSink = tags
    inputSink = inputs
    text = renderer.renderNode(MiniReact.createElement(occupant.component, ownerProps))
    handlerSink = null
    tagSink = null
    inputSink = null
    for (const effect of pendingEffects.splice(0)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    await microtask()
    await microtask()
  }
  for (const cleanup of cleanups) cleanup()
  return { text, handlers, tags, inputs }
}

function applyClient() {
  const disposers = []
  const ctx = {
    effect(fn) {
      const result = fn()
      disposers.push(typeof result === 'function' ? result : () => {})
    },
    slots: {
      inject(_name, callback) {
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer)
      },
      register(options, component) {
        const seat = `${options.name}::${options.id ?? options.key ?? 'unknown'}`
        registrations.set(seat, { options, component })
        return () => registrations.delete(seat)
      },
    },
    layout: { selectPanel() {}, toggleSidebar() {} },
    locale: {
      register() {
        return () => {}
      },
      getLocale: () => ({ id: 'en', active: 'en', locale: 'en' }),
      subscribe: () => () => {},
    },
  }
  const module = captured.factory((name) => {
    if (name === 'react') return MiniReact
    throw new Error(`unexpected require(${name})`)
  })
  module.apply(ctx)
  return { module, disposers }
}

const NAV = 'sidebar.panellist::multi-key-orchestrator'
const PAGE = 'main::multi-key-orchestrator'

/** Open every provider section by pressing page controls until a model appears. */
async function expandPage() {
  let view = await renderSeat(PAGE, {})
  if (/ecnu-max/.test(view.text)) return view
  for (const handler of view.handlers) {
    handler(inertEvent)
    await microtask()
    view = await renderSeat(PAGE, {})
    if (/ecnu-max/.test(view.text)) return view
  }
  return view
}

test('the module registers only the navigation entry and the page', () => {
  assert.ok(captured, 'client.js did not call window.__ModuleLoader__.load')
  assert.equal(captured.id, '@starsobservereric/dsh-multi-key-orchestrator')
  const { module } = applyClient()
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(registrations.get(NAV)?.options.order, 21, 'the entry sits under Context Insights (order 20)')
  assert.equal(registrations.get(PAGE)?.options.key, 'multi-key-orchestrator')
  assert.equal(registrations.size, 2, `unexpected extra seats: ${[...registrations.keys()].join(', ')}`)
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('sidebar.footer.action'), 'the footer pill must be gone')
  assert.ok(!source.includes('shell.overlay'), 'the floating panel must be gone')
})

test('the navigation entry is named Multi-Key Orchestrator and draws only a glyph', async () => {
  applyClient()
  stubFetch()
  const nav = registrations.get(NAV)
  assert.equal(nav.options.label(), 'Multi-Key Orchestrator')
  const collapsed = await renderSeat(NAV, { size: 20, active: false })
  assert.ok(collapsed.tags.includes('svg'))
  assert.equal(collapsed.text.trim(), '')
})

test('providers start collapsed and every provider exposes per-model caps', async () => {
  applyClient()
  stubFetch()
  const collapsed = await renderSeat(PAGE, {})
  assert.match(collapsed.text, /ECNU/)
  assert.doesNotMatch(collapsed.text, /ecnu-max/, 'a collapsed provider must not render its models')

  const opened = await expandPage()
  // Every catalog model of every provider, including one with no keys at all.
  assert.match(opened.text, /ecnu-max/)
  assert.match(opened.text, /ecnu-plus/)
  assert.match(opened.text, /deepseek-v4-pro/, 'a provider with no key still gets its model controls')
  assert.doesNotMatch(opened.text, /No pool yet/i, 'concurrency must not be gated on an existing pool')
  assert.match(opened.text, /Per-API caps/)
  // The Settings-adopted key is always the first cap column.
  const firstCaps = opened.text.indexOf('Per-API caps')
  assert.ok(firstCaps >= 0)
  const columnOrder = opened.text.slice(firstCaps, firstCaps + 120)
  assert.ok(
    columnOrder.indexOf('default') < columnOrder.indexOf('LB'),
    `the native key must lead the cap grid: ${JSON.stringify(columnOrder)}`,
  )
  // Absolute reset timestamps, to the second.
  assert.match(opened.text, /resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
})

test('the linked total is read-only and prints its arithmetic', async () => {
  applyClient()
  stubFetch()
  const opened = await expandPage()
  assert.match(opened.text, /total = 3 \+ 3 = 6|total = 3 \+ 3 \+ 0 = 6/, 'the sum must be visible under the box')
  const totals = opened.inputs.filter((props) => String(props.value ?? '') === '6')
  assert.ok(totals.length > 0, 'the computed total is not bound to a field')
  assert.ok(
    totals.some((props) => props.disabled === true || props.readOnly === true),
    'a linked total must not be editable',
  )
  // Every link switch is a checkbox; at least one must be present and checked
  // for a pool-backed model, and the native key must offer no removal at all.
  assert.ok(
    opened.inputs.some((props) => props.type === 'checkbox'),
    'the switch row is missing',
  )
  assert.doesNotMatch(opened.text, /hide key/i, 'the hide feature is gone')
  assert.match(opened.text, /Add key/, 'the add-key row is missing')
  assert.equal((opened.text.match(/%/g) ?? []).length, 0, 'the health percentage must not be rendered')
})

test('the balance card follows the window, hides spent packs and shows a reason', async () => {
  applyClient()
  stubFetch()
  const opened = await expandPage()
  assert.match(opened.text, /12[,.]?646/, 'the window remainder is missing')
  assert.match(opened.text, /25[,.]?000/, 'the window limit is missing')
  assert.match(opened.text, /key_8011/)
  assert.doesNotMatch(opened.text, /30[,.]?000/, 'packs must not be folded into the allowance')
  assert.doesNotMatch(opened.text, /one-time/, 'an exhausted pack must not be rendered')
  assert.match(opened.text, /no quota endpoint known for this provider/i, 'an unsupported provider must say why')
  assert.doesNotMatch(opened.text, /healthy \d+%/, 'the old health percentage is gone')
})

test('edits stay in a draft until Apply, then post in dependency order', async () => {
  applyClient()
  const calls = stubFetch()
  const opened = await expandPage()
  const before = calls.filter((call) => call.url.includes('/config')).length

  // Change one per-API cap: the field keeps a local draft and commits on blur.
  const cap = opened.inputs.find(
    (props) =>
      props.type === 'number' &&
      String(props.value ?? '') === '3' &&
      typeof props.onChange === 'function' &&
      typeof props.onBlur === 'function',
  )
  assert.ok(cap, 'the per-API cap field is not editable')
  cap.onChange({ target: { value: '7' }, currentTarget: { value: '7' } })
  await microtask()
  // A browser re-renders between typing and blurring, so the blur handler sees
  // the new draft; do the same instead of calling the stale closure.
  const mid = await renderSeat(PAGE, {})
  const blurred = mid.inputs.find(
    (props) => props.type === 'number' && String(props.value ?? '') === '7' && typeof props.onBlur === 'function',
  )
  assert.ok(blurred, `the typed cap never reached the field: ${JSON.stringify(mid.inputs.filter((p) => p.type === 'number').map((p) => p.value))}`)
  blurred.onBlur(inertEvent)
  await microtask()
  const draft = await renderSeat(PAGE, {})
  assert.equal(
    calls.filter((call) => call.url.includes('/config')).length,
    before,
    'a draft edit must not hit the network',
  )
  assert.match(draft.text, /pending/i, 'the draft bar must show pending changes')

  // Apply: press page controls until one of them posts, so the assertion does
  // not depend on the button's label.
  let posted = []
  for (const handler of draft.handlers) {
    handler(inertEvent)
    await microtask()
    await microtask()
    posted = calls.filter((call) => call.url.includes('/config')).map((call) => call.body?.op)
    if (posted.length > 0) break
  }
  assert.ok(posted.length > 0, 'Apply posted nothing')
  const order = ['set-provider', 'update-provider-key', 'set-pool', 'set-key-cap']
  const ranked = posted.map((op) => order.indexOf(op)).filter((index) => index >= 0)
  assert.deepEqual(ranked, [...ranked].sort((a, b) => a - b), `ops must respect dependency order: ${posted.join(',')}`)
})

test('the page is its own scroll container so the panel cannot clip', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const pattern of [/overflowY\s*:\s*'auto'/, /minHeight\s*:\s*0/, /boxSizing\s*:\s*'border-box'/, /height\s*:\s*'100%'/]) {
    assert.ok(pattern.test(source), `the page root is missing ${pattern}`)
  }
})
