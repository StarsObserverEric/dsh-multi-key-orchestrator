/**
 * dsh-multi-key-orchestrator — Client half.
 *
 * Two seats, both registered from `apply`:
 *   - `sidebar.panellist` (order 21): the icon that puts the page in the
 *     sidebar, directly under Context Insights. The sidebar owns the button and
 *     resolves the label; this file supplies the glyph.
 *   - `main` (keyed `multi-key-orchestrator`): the page itself, an ordinary
 *     scroll container and the plugin's only surface. There is no footer pill
 *     and no dialog.
 *
 * The page is driven by the Host catalog: one collapsible section per provider,
 * collapsed by default. API keys belong to the provider (one key set shared by
 * every model under it); concurrency is configurable per provider, per model and
 * per provider key inside each model.
 *
 * The Host half owns every mutation. This file never stores a secret: the key
 * field is a write-only password input that is cleared once the Host confirms
 * the add, and the status payload only ever carries dots for a key plus the
 * non-secret account id the provider reports.
 *
 * `GET /status` is pure cache — the only call that refreshes balances is the
 * `probe` op, which the per-key Refresh button issues on purpose. The page polls
 * `/status` every 5s while it is mounted.
 *
 * No imports beyond `react`, no build step, no stylesheet and no class names:
 * every surface is inline style built from the host theme tokens
 * (`--dsw-alias-*`) with system colours as a last resort, so light and dark
 * follow the Harness without a second source of truth. Literal colours appear
 * only where a status has to be encoded (green / amber / red / grey).
 */
window.__ModuleLoader__.load({
  id: '@stars_observer_eric/dsh-multi-key-orchestrator',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    /** The locale namespace of this plugin, shared by both slot registrations. */
    const NS = 'multi-key-orchestrator'
    /** Same-origin base of the Host HTTP API this Client consumes. */
    const API = '/api/multi-key-orchestrator'
    /** How often the open panel re-reads `/status`. */
    const POLL_MS = 5000
    /** How many recent log lines the diagnostics block shows. */
    const LOG_LIMIT = 30

    const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

    /**
     * The theme surface. Tokens first (they follow light / dark automatically),
     * system colours second (a renamed token degrades the look, never the
     * render), and literal hues only for the status encodings further down.
     */
    const C = Object.freeze({
      surface: 'var(--dsw-alias-bg-layer-2, Canvas)',
      surfaceInset: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
      surfaceSunken: 'rgba(127,127,127,.10)',
      text: 'inherit',
      dim: 'var(--dsw-alias-label-secondary, GrayText)',
      faint: 'var(--dsw-alias-label-tertiary, GrayText)',
      line: '1px solid rgba(127,127,127,.35)',
      lineSoft: '1px solid rgba(127,127,127,.22)',
      hover: 'rgba(127,127,127,.12)',
      hoverStrong: 'rgba(127,127,127,.20)',
      focusRing: '0 0 0 2px rgba(74,140,255,.45)',
      green: 'var(--dsw-alias-state-success-primary, #30a46c)',
      amber: 'var(--dsw-alias-state-warn-primary, #d9a03a)',
      red: 'var(--dsw-alias-state-error-primary, #e5484d)',
      grey: 'var(--dsw-alias-label-tertiary, #8b909a)',
      blue: 'var(--dsw-alias-state-business-primary, #4a8cff)',
      primaryFill: 'var(--dsw-alias-button-primary-fill, #3f6fdc)',
      primaryText: 'var(--dsw-alias-label-primary-inverted, #fff)',
      track: 'rgba(127,127,127,.24)',
      thumb: 'var(--dsw-alias-switch-thumb, #fff)',
      shadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.34))',
    })

    //#region dictionaries

    const EN = {

      'panel.title': 'Multi-Key Orchestrator',
      'panel.refresh': 'Refresh status',
      'panel.subtitle': 'Version {version} · running since {time}',
      'panel.master': 'Orchestration',
      'panel.bypass': 'When the switch is off, the plugin is bypassed completely and every model uses DSH’s native single-key behaviour.',
      'panel.loading': 'Reading status…',
      'panel.statusFailed': 'Could not read the plugin status: {message}',
      'panel.actionFailed': 'The action failed: {message}',
      'panel.retry.title': 'Recover a 429 that arrives mid-answer',
      'panel.retry.body': 'Default behaviour. A 429 that arrives after text has already been streamed is recovered by discarding the partial output and re-running the request; the abandoned attempt stays in the conversation as an attempt record.',
      'panel.retry.max': 'Up to {n} retries',
      'panel.warnings': 'Warnings',

      'warning.quota-check-failed': 'A balance check could not reach the provider; the numbers below may be stale.',
      'warning.no-header-seam': 'This provider offers no seam where a key can be swapped mid-request, so a 429 that arrives after the first byte can only be recorded.',
      'warning.correlation-fifo': 'Request ownership fell back to FIFO correlation: concurrent requests are matched in arrival order, which is less precise than async-context tracking.',
      'warning.lane-fallback': 'A main-process request borrowed a subagent slot because the reserved slot was busy.',


      'pool.reservedForMain': 'Reserved for main',
      'pool.release': 'Lend the reserved slot to subagents while the main process is idle',
      'pool.lane': 'Main {main} · subagents {child}/{capacity} · waiting {waiting}',

      'key.enabled': 'Enabled',
      'key.oneLease': '{n} active lease',
      'key.leases': '{n} active leases',
      'key.cooldown': 'cooling down, {time}',
      'key.remove': 'Remove key',
      'key.removeConfirm': 'Confirm removal?',
      'key.state.healthy': 'healthy',
      'key.state.cooldown': 'cooling',
      'key.state.quota_exhausted': 'exhausted',
      'key.state.unknown': 'unknown',
      'key.state.disabled': 'disabled',
      'key.adding': 'Adding…',
      'key.valuePlaceholder': 'API key (write-only)',
      'key.neverProbed': 'never probed',
      'key.probe': 'Refresh balance',
      'key.probing': 'Checking…',

      'quota.title': 'Balance',
      'quota.value': '{remaining} / {total} {unit}',
      'quota.remainingOnly': '{remaining} {unit}',
      'quota.state.ok': 'enough',
      'quota.state.low': 'low',
      'quota.state.exhausted': 'exhausted',
      'quota.state.unknown': 'unknown',
      'quota.state.probe-failed': 'check failed',
      'quota.state.unsupported': 'not supported',
      'quota.checked': 'checked {time}',
      'quota.stale': 'stale',
      'quota.nextCheck': 'next check {time}',
      'quota.reset': 'resets {time}',
      'quota.error': 'Balance check failed: {message}',

      'diag.title': 'Diagnostics',
      'diag.correlation': 'Correlation',
      'diag.als': 'async context',
      'diag.fifo': 'FIFO fallback',
      'diag.on': 'on',
      'diag.off': 'off',
      'diag.log': 'Recent activity',
      'diag.logEmpty': 'No activity recorded yet.',
      'diag.wait': '{ms}ms wait',
      'diag.selftest': 'Run allocation self-test',
      'diag.running': 'Running self-test…',
      'diag.inject429': 'Inject a 429 on the first attempt',
      'diag.selftestDone': 'Self-test finished; {n} log entries appended.',
      'diag.selftestFailed': 'Self-test failed: {message}',

      'lane.main': 'main',
      'lane.child': 'subagent',

      'log.action.acquire': 'acquire',
      'log.action.release': 'release',
      'log.action.wait': 'wait',
      'log.action.rotate': 'rotate',
      'log.action.cooldown': 'cooldown',
      'log.action.quota': 'quota',
      'log.action.probe': 'probe',
      'log.action.no-seam': 'no-seam',
      'log.action.midstream-retry': 'mid-stream retry',
      'log.action.fail': 'failed',
      'log.action.fallback-lane': 'fallback lane',

      'rollback.title': 'Rolling back',
      'rollback.body': 'Turn the switch off, disable this plugin’s row in the Plugins page, or remove the bundle. The native request path was never modified, so nothing else needs undoing.',

      'time.justNow': 'just now',
      'time.secondsAgo': '{n}s ago',
      'time.minutesAgo': '{n}min ago',
      'time.hoursAgo': '{n}h ago',
      'time.daysAgo': '{n}d ago',
      'time.inSeconds': 'in {n}s',
      'time.inMinutes': 'in {n}min',
      'time.inHours': 'in {n}h',
      'time.inDays': 'in {n}d',
      'time.dueNow': 'due now',

      'common.dash': '—',
      'nav.label': 'Multi-Key Orchestrator',
      'catalog.empty.title': 'No models found',
      'catalog.empty.body': 'The Host reported no models. Add providers and models in Settings → Models and they will be listed here.',
      'provider.maxConcurrent': 'Provider concurrency',
      'provider.unlimitedHint': '0 or empty means unlimited.',
      'key.note': 'Note',
      'key.notePlaceholder': 'default',
      'key.accountId': 'Provider key ID',
      'common.dots': '••••••',
      'common.networkUnavailable': 'The browser cannot reach the Host.',
      'pages.expandAll': 'Expand all',
      'pages.collapseAll': 'Collapse all',
      'provider.expand': 'Expand',
      'provider.collapse': 'Collapse',
      'provider.oneKey': '{n} key',
      'provider.keys': '{n} keys',
      'provider.inUse': '{n} in use',
      'provider.apiKeys': 'API keys',
      'provider.addKey': 'Add key',
      'provider.noKeys': 'No key configured yet.',
      'model.heading': 'Models',
      'model.manualTotal': 'manual total',
      'model.addKeyForCaps': 'Add an API key to set per-key caps',
      'model.none': 'No model listed for this provider.',
      'model.totalCap': 'total',
      'model.perApiCaps': 'Per-API caps',
      'key.source.native': 'from Settings',
      'key.source.added': 'added here',
      'key.missingCredential': 'Credential missing - this key cannot be used.',
      'key.capHint': '0 = no per-key limit for this model',
      'key.probeAll': 'Refresh all balances',
      'pages.apply': 'Apply',
      'pages.discard': 'Discard',
      'pages.pending': '{n} pending changes',
      'pages.pendingOne': '{n} pending change',
      'pages.saved': 'Saved · {time}',
      'pages.saveFailed': 'Could not apply {op}: {message}',
      'model.linkTotal': 'Link total to per-API caps',
      'model.linkHint': 'total = {sum} = {total}',
      'key.noFailures': 'no failures',
      'key.failures': '{n} failures · {m}×429',
      'key.lastOk': 'last ok {time}',
      'key.neverSucceeded': 'never succeeded',
      'quota.bonus': '+ {remaining} one-time',
      'quota.bonusPack': '({packs})',
      'quota.cny': '¥{amount} balance',
      'quota.deepseekUnsupported': 'This provider does not expose a balance that can be read from here.',
      'common.unknownError': 'Unknown error',
      'common.httpStatus': 'HTTP {code}',
    }

    const ZH = {

      'panel.title': '多密钥分流指挥家',
      'panel.refresh': '刷新状态',
      'panel.subtitle': '版本 {version} · 自 {time} 起运行',
      'panel.master': '编排总开关',
      'panel.bypass': '关闭后本插件被完全绕过，所有模型都回到 DSH 原生的单 Key 行为。',
      'panel.loading': '正在读取状态…',
      'panel.statusFailed': '读取插件状态失败：{message}',
      'panel.actionFailed': '操作失败：{message}',
      'panel.retry.title': '回答中途遇到 429 时就地恢复',
      'panel.retry.body': '默认行为。文本已经开始流出后才遇到 429 时，会丢弃这段不完整的输出并重新发起请求；被放弃的那次尝试会作为“尝试记录”留在会话里。',
      'panel.retry.max': '最多重试 {n} 次',
      'panel.warnings': '警告',

      'warning.quota-check-failed': '余额检查未能连上服务方，下面的数字可能已经过期。',
      'warning.no-header-seam': '这个服务方没有可在请求中途换 Key 的接缝，首字节之后出现的 429 只能被记录下来。',
      'warning.correlation-fifo': '请求归属退回 FIFO 关联：并发请求按到达顺序配对，精度不如异步上下文追踪。',
      'warning.lane-fallback': '为主进程保留的槽位被占用，主进程请求临时借用了子智能体槽位。',


      'pool.reservedForMain': '主进程保留',
      'pool.release': '主进程空闲时把保留槽位借给子智能体',
      'pool.lane': '主进程 {main} · 子智能体 {child}/{capacity} · 排队 {waiting}',

      'key.enabled': '启用',
      'key.oneLease': '{n} 个活跃租约',
      'key.leases': '{n} 个活跃租约',
      'key.cooldown': '冷却中，{time}',
      'key.remove': '删除 Key',
      'key.removeConfirm': '确认删除？',
      'key.state.healthy': '健康',
      'key.state.cooldown': '冷却中',
      'key.state.quota_exhausted': '额度用尽',
      'key.state.unknown': '未知',
      'key.state.disabled': '已停用',
      'key.adding': '正在添加…',
      'key.valuePlaceholder': 'API Key（只写，不回显）',
      'key.neverProbed': '从未探测',
      'key.probe': '刷新余额',
      'key.probing': '检查中…',

      'quota.title': '余额',
      'quota.value': '{remaining} / {total} {unit}',
      'quota.remainingOnly': '{remaining} {unit}',
      'quota.state.ok': '充足',
      'quota.state.low': '偏低',
      'quota.state.exhausted': '已用尽',
      'quota.state.unknown': '未知',
      'quota.state.probe-failed': '检查失败',
      'quota.state.unsupported': '不支持',
      'quota.checked': '检查于 {time}',
      'quota.stale': '已过期',
      'quota.nextCheck': '下次检查 {time}',
      'quota.reset': '重置于 {time}',
      'quota.error': '余额检查失败：{message}',

      'diag.title': '诊断',
      'diag.correlation': '请求关联',
      'diag.als': '异步上下文',
      'diag.fifo': 'FIFO 兜底',
      'diag.on': '开',
      'diag.off': '关',
      'diag.log': '最近活动',
      'diag.logEmpty': '还没有任何活动记录。',
      'diag.wait': '等待 {ms}ms',
      'diag.selftest': '运行分配自检',
      'diag.running': '正在自检…',
      'diag.inject429': '第一次尝试注入一个 429',
      'diag.selftestDone': '自检完成，追加了 {n} 条日志。',
      'diag.selftestFailed': '自检失败：{message}',

      'lane.main': '主进程',
      'lane.child': '子智能体',

      'log.action.acquire': '取得',
      'log.action.release': '释放',
      'log.action.wait': '等待',
      'log.action.rotate': '轮换',
      'log.action.cooldown': '冷却',
      'log.action.quota': '额度',
      'log.action.probe': '探测',
      'log.action.no-seam': '无接缝',
      'log.action.midstream-retry': '中途重试',
      'log.action.fail': '失败',
      'log.action.fallback-lane': '备用泳道',

      'rollback.title': '回退方式',
      'rollback.body': '关闭总开关、在“插件”页面停用这一行，或直接移除插件包。原生请求链路从未被改动，所以不需要恢复别的东西。',

      'time.justNow': '刚刚',
      'time.secondsAgo': '{n} 秒前',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'time.inSeconds': '{n} 秒后',
      'time.inMinutes': '{n} 分钟后',
      'time.inHours': '{n} 小时后',
      'time.inDays': '{n} 天后',
      'time.dueNow': '已到期',

      'common.dash': '—',
      'nav.label': '多密钥分流指挥家',
      'catalog.empty.title': '没有找到模型',
      'catalog.empty.body': '宿主没有报告任何模型。请先在“设置 → 模型”里添加服务方和模型，它们会显示在这里。',
      'provider.maxConcurrent': '服务方并发',
      'provider.unlimitedHint': '0 或留空表示不限制。',
      'key.note': '备注名',
      'key.notePlaceholder': '默认',
      'key.accountId': '服务方 Key 标识',
      'common.dots': '••••••',
      'common.networkUnavailable': '当前浏览器无法连接到宿主。',
      'pages.expandAll': '全部展开',
      'pages.collapseAll': '全部收起',
      'provider.expand': '展开',
      'provider.collapse': '收起',
      'provider.oneKey': '{n} 个 Key',
      'provider.keys': '{n} 个 Key',
      'provider.inUse': '{n} 个占用',
      'provider.apiKeys': 'API Key',
      'provider.addKey': '添加 Key',
      'provider.noKeys': '还没有配置 Key。',
      'model.heading': '模型',
      'model.manualTotal': '手动设置',
      'model.addKeyForCaps': '添加一个 API Key 后即可设置每个 Key 的上限',
      'model.none': '这个服务方下没有模型。',
      'model.totalCap': '总并发',
      'model.perApiCaps': '每个 API 的上限',
      'key.source.native': '来自设置',
      'key.source.added': '在此添加',
      'key.missingCredential': '凭据缺失，这个 Key 无法使用。',
      'key.capHint': '0 = 这个模型下不限该 Key 的并发',
      'key.probeAll': '刷新全部余额',
      'pages.apply': '应用',
      'pages.discard': '放弃',
      'pages.pending': '{n} 项待保存',
      'pages.pendingOne': '{n} 项待保存',
      'pages.saved': '已保存 · {time}',
      'pages.saveFailed': '无法应用 {op}：{message}',
      'model.linkTotal': '总并发联动每个 Key 的上限',
      'model.linkHint': '总并发 = {sum} = {total}',
      'key.noFailures': '无失败',
      'key.failures': '{n} 次失败 · {m}×429',
      'key.lastOk': '上次成功 {time}',
      'key.neverSucceeded': '从未成功',
      'quota.bonus': '+ {remaining} 一次性额度',
      'quota.bonusPack': '（{packs}）',
      'quota.cny': '¥{amount} 余额',
      'quota.deepseekUnsupported': '这个服务方不提供可从这里读取的余额。',
      'common.unknownError': '未知错误',
      'common.httpStatus': 'HTTP {code}',
    }

    const DICT = { en: EN, zh: ZH }

    //#endregion

    //#region locale plumbing

    /** The locale service, once `apply` has found it. Kept for the hook below. */
    let localeService = null
    /** `ctx.locale.bind(NS)`, when this build exposes it. */
    let boundTranslate = null

    /** Fill one `{name}` placeholder set in a dictionary string. */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** The live locale snapshot, read defensively across the known shapes. */
    function localeSnapshot() {
      const service = localeService
      if (service === null) return null
      try {
        if (typeof service.getLocale === 'function') return service.getLocale()
        if (typeof service.getSnapshot === 'function') return service.getSnapshot()
      } catch (error) {
        return null
      }
      return null
    }

    /** The active locale id, defaulting to English when nothing says otherwise. */
    function activeLocale() {
      const snap = localeSnapshot()
      const id = snap === null || snap === undefined ? null : (snap.active || snap.id || snap.locale)
      return typeof id === 'string' && id !== '' ? id : 'en'
    }

    /**
     * Resolve one key for the active locale, English last. A bound translate
     * function from the locale service wins when it knows the key; otherwise the
     * local table answers, so the UI still reads correctly if registration was
     * refused or the service never arrived.
     */
    function t(key, params) {
      if (boundTranslate !== null) {
        try {
          const value = boundTranslate(key, params)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch (error) {
          // A broken translate must not blank the UI: fall through.
        }
      }
      const dict = DICT[activeLocale()] || EN
      const text = dict[key] !== undefined ? dict[key] : EN[key]
      return typeof text === 'string' ? interpolate(text, params) : key
    }

    /**
     * Re-render on every locale snapshot change (a switch or a late dictionary
     * registration) and return the active id, so text follows the language the
     * user picked without a reload.
     */
    function useLocaleId() {
      const [id, setId] = useState(() => activeLocale())
      useEffect(() => {
        const service = localeService
        if (service === null) return undefined
        let alive = true
        const sync = () => {
          if (alive) setId(activeLocale())
        }
        sync()
        let off = null
        try {
          if (typeof service.subscribe === 'function') off = service.subscribe(sync)
        } catch (error) {
          off = null
        }
        return () => {
          alive = false
          try {
            if (typeof off === 'function') off()
            else if (off !== null && off !== undefined && typeof off.dispose === 'function') off.dispose()
          } catch (error) {
            // A disposer that throws has nothing left to release here.
          }
        }
      }, [])
      return id
    }

    /**
     * Register one locale dictionary. The per-locale form is the documented one;
     * the combined object form is tried when a build only knows that shape.
     * @returns {Function} the disposer for `ctx.effect`.
     */
    function registerDictionary(service, localeId, dict) {
      const disposers = []
      try {
        if (typeof service.register === 'function') {
          try {
            const off = service.register(NS, localeId, dict)
            if (typeof off === 'function') disposers.push(off)
          } catch (error) {
            const off = service.register(NS, { [localeId]: dict })
            if (typeof off === 'function') disposers.push(off)
          }
        }
      } catch (error) {
        // The namespace already owns this locale (a second apply, or a build
        // that registered the shipped locale files): the local table still
        // answers, so this is not fatal.
      }
      return () => {
        for (const off of disposers) {
          try {
            off()
          } catch (error) {
            // Already disposed.
          }
        }
      }
    }

    //#endregion

    //#region stores

    /**
     * The last `/status` answer. The page polls it while it is mounted, and a
     * mutation repaints from the same snapshot without a second read.
     */
    let statusSnapshot = { status: null, error: null, loading: false, revision: 0 }
    const statusListeners = new Set()
    let statusFetch = null

    function subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => {
        statusListeners.delete(listener)
      }
    }

    function getStatusSnapshot() {
      return statusSnapshot
    }

    function publishStatus(patch) {
      statusSnapshot = { ...statusSnapshot, ...patch, revision: statusSnapshot.revision + 1 }
      for (const listener of [...statusListeners]) {
        try {
          listener()
        } catch (error) {
          console.error('multi-key-orchestrator: status subscriber crashed', error)
        }
      }
    }

    /** Re-read `/status`. Concurrent callers share one request. */
    function refreshStatus() {
      if (statusFetch !== null) return statusFetch
      if (statusSnapshot.status === null) publishStatus({ loading: true })
      statusFetch = (async () => {
        try {
          const payload = await requestJson('GET', '/status')
          const status = normalizeStatus(payload)
          publishStatus({ status: status === null ? payload : status, error: null, loading: false })
          return status
        } catch (reason) {
          publishStatus({ error: messageOf(reason), loading: false })
          return null
        } finally {
          statusFetch = null
        }
      })()
      return statusFetch
    }

    /**
     * The status object out of a `/status` answer.
     *
     * The documented contract is the status itself; a host that answers with an
     * extra `{ ok, status }` envelope is unwrapped here, so one envelope cannot
     * blank the panel.
     * @param payload - the parsed `/status` body.
     */
    function normalizeStatus(payload) {
      if (payload === null || payload === undefined || typeof payload !== 'object') return null
      if (Array.isArray(payload.pools)) return payload
      const nested = payload.status
      if (nested !== null && nested !== undefined && typeof nested === 'object' && !Array.isArray(nested)) return nested
      return null
    }

    //#endregion

    //#region host api

    /**
     * One same-origin JSON exchange with the Host half.
     * @param method - `GET` or `POST`.
     * @param path - the route below {@link API}.
     * @param body - the JSON body for a POST; omitted for a GET.
     */
    async function requestJson(method, path, body) {
      const options = { method, cache: 'no-store', headers: {} }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      if (typeof fetch !== 'function') throw new Error(t('common.networkUnavailable'))
      const response = await fetch(API + path, options)
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      const failure = payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : null
      if (!response.ok) throw new Error(failure !== null && failure !== '' ? failure : t('common.httpStatus', { code: response.status }))
      if (payload !== null && payload !== undefined && payload.ok === false) {
        throw new Error(failure !== null && failure !== '' ? failure : t('common.httpStatus', { code: response.status }))
      }
      if (payload === null || payload === undefined) throw new Error(t('common.httpStatus', { code: response.status }))
      return payload
    }

    /** `{ op, ... }` against `/config`: every mutation, probe and self-test. */
    function postConfig(body) {
      return requestJson('POST', '/config', body)
    }

    /** One readable message out of whatever a rejection carried. */
    function messageOf(reason) {
      if (reason instanceof Error && typeof reason.message === 'string' && reason.message !== '') return reason.message
      if (typeof reason === 'string' && reason !== '') return reason
      return t('common.unknownError')
    }

    //#endregion

    //#region formatting

    /** An epoch-ms value from either a number or an ISO string. */
    function toMs(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value)
        return Number.isNaN(parsed) ? null : parsed
      }
      return null
    }

    /** A count, grouped for the active browser locale, or a dash. */
    function fmtNum(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('common.dash')
      return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }

    /** Absolute time, for a tooltip. */
    function absTime(ms) {
      if (ms === null) return t('common.dash')
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? t('common.dash') : date.toLocaleString()
    }

    /** Wall-clock time for a log line. */
    function clockTime(ms) {
      if (ms === null) return t('common.dash')
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? t('common.dash') : date.toLocaleTimeString()
    }

    /** An absolute local timestamp to the second: 2026-11-15 23:27:28. */
    function stampOf(ms) {
      if (ms === null || ms === undefined) return t('common.dash')
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return t('common.dash')
      const pad = (value) => (value < 10 ? '0' + value : String(value))
      return date.getFullYear()
        + '-' + pad(date.getMonth() + 1)
        + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours())
        + ':' + pad(date.getMinutes())
        + ':' + pad(date.getSeconds())
    }

    /** A positive duration split into the coarsest unit that still reads. */
    function durationOf(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000))
      if (seconds < 60) return { unit: 'second', n: seconds }
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return { unit: 'minute', n: minutes }
      const hours = Math.round(minutes / 60)
      if (hours < 24) return { unit: 'hour', n: hours }
      return { unit: 'day', n: Math.round(hours / 24) }
    }

    /** A past instant relative to now: "12s ago", "3h ago". */
    function relPast(ms, now) {
      if (ms === null) return t('common.dash')
      const diff = now - ms
      if (diff < 5000) return t('time.justNow')
      const span = durationOf(diff)
      return t('time.' + span.unit + 'sAgo', { n: fmtNum(span.n) })
    }

    /** A future instant relative to now: "in 43min", "due now". */
    function relFuture(ms, now) {
      if (ms === null) return t('common.dash')
      const diff = ms - now
      if (diff <= 1000) return t('time.dueNow')
      const span = durationOf(diff)
      return t('time.in' + span.unit.charAt(0).toUpperCase() + span.unit.slice(1) + 's', { n: fmtNum(span.n) })
    }


    /** The colour a key state encodes. */
    function keyColor(state) {
      if (state === 'healthy') return C.green
      if (state === 'cooldown') return C.amber
      if (state === 'quota_exhausted') return C.red
      return C.grey
    }

    /** The colour a balance state encodes. */
    function quotaColor(state) {
      if (state === 'ok') return C.green
      if (state === 'low') return C.amber
      if (state === 'exhausted') return C.red
      if (state === 'probe-failed') return C.red
      return C.grey
    }

    /** Translate an action through the dictionary, keeping the raw token when unknown. */
    function actionLabel(action) {
      if (typeof action !== 'string' || action === '') return t('common.dash')
      const key = 'log.action.' + action
      const value = t(key)
      return value === key ? action : value
    }

    /** Translate a lane name, keeping the raw token when unknown. */
    function laneLabel(lane) {
      if (typeof lane !== 'string' || lane === '') return t('common.dash')
      const key = 'lane.' + lane
      const value = t(key)
      return value === key ? lane : value
    }

    //#endregion

    //#region glyphs

    /**
     * The small outline glyphs, in the shipped icon set's own convention: 16px
     * box, fill none, stroke currentColor, round caps and joins.
     */
    const GLYPHS = {
      // The plugin mark: four sixteenth notes climbing in one beamed group —
      // several voices, one conductor.
      notes: [
        ['ellipse', { cx: 3.0, cy: 12.6, rx: 1.55, ry: 1.15, transform: 'rotate(-22 3 12.6)', fill: 'currentColor', stroke: 'none' }],
        ['ellipse', { cx: 6.2, cy: 11.4, rx: 1.55, ry: 1.15, transform: 'rotate(-22 6.2 11.4)', fill: 'currentColor', stroke: 'none' }],
        ['ellipse', { cx: 9.4, cy: 10.2, rx: 1.55, ry: 1.15, transform: 'rotate(-22 9.4 10.2)', fill: 'currentColor', stroke: 'none' }],
        ['ellipse', { cx: 12.6, cy: 9.0, rx: 1.55, ry: 1.15, transform: 'rotate(-22 12.6 9)', fill: 'currentColor', stroke: 'none' }],
        ['path', { d: 'M4.3 12.2V4.7' }],
        ['path', { d: 'M7.5 11V3.9' }],
        ['path', { d: 'M10.7 9.8V3.2' }],
        ['path', { d: 'M13.9 8.6V2.6' }],
        ['path', { d: 'M4.3 4.7C7.6 3.3 11.4 2.5 13.9 2.6' }],
        ['path', { d: 'M4.3 6.8C7.6 5.4 11.4 4.6 13.9 4.7' }],
      ],
      chevron: [['path', { d: 'M6 3.5L10.5 8L6 12.5' }]],
      refresh: [
        ['path', { d: 'M13 8a5 5 0 1 1-1.47-3.54' }],
        ['path', { d: 'M11.9 1.7L11.83 4.52L9.01 4.45' }],
      ],
      trash: [
        ['path', { d: 'M3 4.6H13' }],
        ['path', { d: 'M6.2 4.6V3.4a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.2' }],
        ['path', { d: 'M4.4 4.6l.6 8.2a.9.9 0 0 0 .9.8h4.2a.9.9 0 0 0 .9-.8l.6-8.2' }],
        ['path', { d: 'M6.8 7.2V11' }],
        ['path', { d: 'M9.2 7.2V11' }],
      ],
    }

    /** One outline glyph at the given box size, in CSS pixels. */
    function glyph(name, size) {
      const shapes = GLYPHS[name] || []
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        shapes.map((shape, index) => h(shape[0], { key: index, ...shape[1] })),
      )
    }

    //#endregion

    //#region controls

    /** A subtle focus-visible ring, made of inline style so no CSS is needed. */
    function focusStyle(focused) {
      return focused ? { boxShadow: C.focusRing, outline: 'none' } : { outline: 'none' }
    }

    /** One outlined button; hover and focus are small pieces of local state. */
    function Btn(props) {
      const [hover, setHover] = useState(false)
      const [focused, setFocused] = useState(false)
      const small = props.size === 'sm'
      const tone = props.tone === undefined ? 'plain' : props.tone
      const disabled = props.disabled === true
      const base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        flex: 'none',
        height: small ? 24 : 28,
        padding: small ? '0 8px' : '0 10px',
        margin: 0,
        borderRadius: 6,
        border: C.line,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: small ? 11.5 : 12.5,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        ...focusStyle(focused),
      }
      if (tone === 'danger') {
        base.border = '1px solid rgba(229,72,77,.45)'
        base.color = C.red
      } else if (tone === 'primary') {
        base.border = '1px solid transparent'
        base.background = C.primaryFill
        base.color = C.primaryText
      } else if (tone === 'ghost') {
        base.border = '1px solid transparent'
      }
      if (!disabled && hover) {
        base.background = tone === 'primary' ? C.primaryFill : C.hover
        if (tone === 'primary') base.filter = 'brightness(1.06)'
      }
      return h(
        'button',
        {
          type: 'button',
          title: props.title === undefined ? undefined : props.title,
          'aria-label': props.ariaLabel === undefined ? undefined : props.ariaLabel,
          'aria-pressed': props.pressed === undefined ? undefined : props.pressed,
          disabled,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: base,
        },
        props.children,
      )
    }

    /** A square glyph-only button (refresh, close, remove). */
    function IconBtn(props) {
      const [hover, setHover] = useState(false)
      const [focused, setFocused] = useState(false)
      const disabled = props.disabled === true
      const size = props.size === undefined ? 26 : props.size
      return h(
        'button',
        {
          type: 'button',
          title: props.title,
          'aria-label': props.ariaLabel,
          disabled,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            width: size,
            height: size,
            margin: 0,
            padding: 0,
            border: 'none',
            borderRadius: 6,
            background: !disabled && hover ? C.hover : 'transparent',
            color: props.tone === 'danger' ? C.red : 'inherit',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            ...focusStyle(focused),
          },
        },
        glyph(props.glyph, props.glyphSize === undefined ? 14 : props.glyphSize),
      )
    }

    /** A switch in the host's own shape: `role="switch"` and `aria-checked`. */
    function Switch(props) {
      const [hover, setHover] = useState(false)
      const [focused, setFocused] = useState(false)
      const checked = props.checked === true
      const disabled = props.disabled === true
      const label = props.label
      const accessible = props.ariaLabel !== undefined ? props.ariaLabel : (typeof label === 'string' && label !== '' ? label : undefined)
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': accessible,
          title: accessible,
          disabled,
          onClick: () => {
            if (!disabled && typeof props.onChange === 'function') props.onChange(!checked)
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            maxWidth: '100%',
            padding: '2px 4px',
            margin: 0,
            border: 'none',
            borderRadius: 6,
            background: !disabled && hover ? C.hover : 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12.5,
            lineHeight: '18px',
            textAlign: 'left',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            ...focusStyle(focused),
          },
        },
        h(
          'span',
          {
            'aria-hidden': 'true',
            style: {
              position: 'relative',
              display: 'inline-block',
              flex: 'none',
              width: 32,
              height: 18,
              borderRadius: 9,
              background: checked ? C.blue : C.track,
              transition: 'background .15s ease',
            },
          },
          h('span', {
            style: {
              position: 'absolute',
              top: 2,
              left: checked ? 16 : 2,
              width: 14,
              height: 14,
              borderRadius: 7,
              background: C.thumb,
              boxShadow: '0 1px 2px rgba(0,0,0,.28)',
              transition: 'left .15s ease',
            },
          }),
        ),
        typeof label === 'string' && label !== '' ? h('span', { style: { minWidth: 0 } }, label) : null,
      )
    }

    /** A plain checkbox with its own label, bound by wrapping. */
    function CheckBox(props) {
      const disabled = props.disabled === true
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
            fontSize: 12,
            lineHeight: '18px',
            color: C.dim,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.55 : 1,
          },
        },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled,
          onChange: (event) => {
            if (typeof props.onChange === 'function') props.onChange(event.target.checked)
          },
          style: { flex: 'none', width: 14, height: 14, margin: 0, accentColor: C.blue, cursor: disabled ? 'not-allowed' : 'pointer' },
        }),
        h('span', { style: { minWidth: 0 } }, props.label),
      )
    }

    /** A pill-shaped status chip; the border and text carry the semantic hue. */
    function Chip(props) {
      return h(
        'span',
        {
          title: props.title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: 'none',
            padding: '1px 6px',
            borderRadius: 999,
            border: '1px solid ' + props.color,
            color: props.color,
            fontSize: 11,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    /** An 8px semantic dot. */
    function Dot(props) {
      return h('span', {
        'aria-hidden': 'true',
        title: props.title,
        style: {
          display: 'inline-block',
          flex: 'none',
          width: props.size === undefined ? 8 : props.size,
          height: props.size === undefined ? 8 : props.size,
          borderRadius: 999,
          background: props.color,
        },
      })
    }

    /** A label wrapping a small text input, so the two are bound without ids. */
    function TextField(props) {
      const disabled = props.disabled === true
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 3,
            flex: props.grow === true ? '1 1 150px' : '0 0 auto',
            minWidth: props.grow === true ? 120 : 0,
            fontSize: 11.5,
            lineHeight: '16px',
            color: C.dim,
          },
        },
        h('span', null, props.label),
        h('input', {
          type: props.type === undefined ? 'text' : props.type,
          value: props.value,
          placeholder: props.placeholder,
          disabled,
          autoComplete: props.type === 'password' ? 'off' : undefined,
          spellCheck: props.type === 'password' ? false : undefined,
          onChange: (event) => props.onChange(event.target.value),
          onKeyDown: props.onKeyDown,
          style: {
            boxSizing: 'border-box',
            width: '100%',
            minWidth: 0,
            height: 26,
            padding: '0 8px',
            borderRadius: 6,
            border: C.line,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12.5,
            opacity: disabled ? 0.55 : 1,
          },
        }),
      )
    }

    /** A number field that commits on Enter or blur, as the Host expects. */
    function NumberField(props) {
      const [draft, setDraft] = useState(() => (typeof props.value === 'number' ? String(props.value) : ''))
      const [focused, setFocused] = useState(false)
      useEffect(() => {
        setDraft(typeof props.value === 'number' ? String(props.value) : '')
      }, [props.value])
      const disabled = props.disabled === true
      // `muted` marks a computed, read-only value: greyed background and text,
      // not-allowed cursor, so a linked total never looks editable.
      const muted = props.muted === true
      const hint = typeof props.hint === 'string' && props.hint !== '' ? props.hint : ''
      const commit = () => {
        if (disabled) return
        const trimmed = draft.trim()
        // A cleared cap means "no limit" (provider and per-key caps), not an
        // abandoned edit: commit the zero the Host reads as unlimited.
        if (trimmed === '' && props.emptyAsZero === true) {
          if (props.value !== 0 && typeof props.onCommit === 'function') props.onCommit(0)
          return
        }
        const parsed = Number.parseInt(trimmed, 10)
        if (!Number.isFinite(parsed) || parsed < props.min) {
          setDraft(typeof props.value === 'number' ? String(props.value) : '')
          return
        }
        if (parsed !== props.value && typeof props.onCommit === 'function') props.onCommit(parsed)
      }
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 3,
            fontSize: 11.5,
            lineHeight: '16px',
            color: C.dim,
          },
        },
        h('span', null, props.label),
        h('input', {
          type: 'number',
          min: props.min,
          title: props.title,
          value: draft,
          disabled,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => {
            setFocused(false)
            commit()
          },
          onFocus: () => setFocused(true),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
              if (event.currentTarget !== null) event.currentTarget.blur()
            }
          },
          style: {
            boxSizing: 'border-box',
            width: 84,
            height: 26,
            padding: '0 8px',
            borderRadius: 6,
            border: C.line,
            background: muted ? C.surfaceSunken : 'transparent',
            color: muted ? C.faint : 'inherit',
            font: 'inherit',
            fontSize: 12.5,
            fontWeight: muted ? 600 : 400,
            cursor: muted ? 'not-allowed' : 'text',
            opacity: muted ? 1 : (disabled ? 0.55 : 1),
            ...focusStyle(focused),
          },
        }),
        hint === '' ? null : h('span', {
          style: {
            fontSize: 10.5,
            lineHeight: '15px',
            color: C.faint,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'normal',
          },
        }, hint),
      )
    }

    /** A section card used for the retry, warning, diagnostics and rollback blocks. */
    function Card(props) {
      return h(
        'section',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 14px',
            borderRadius: 10,
            border: C.lineSoft,
            background: props.plain === true ? 'transparent' : C.surfaceInset,
          },
        },
        props.children,
      )
    }

    /** A card heading. */
    function CardTitle(props) {
      return h('h3', { style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'inherit' } }, props.children)
    }

    /** Muted body copy. */
    function Hint(props) {
      return h('p', { style: { margin: 0, fontSize: 12, lineHeight: '18px', color: C.dim } }, props.children)
    }

    //#endregion

    //#region api keys

    /** Money at two decimals for a currency balance; magnitudes use fmtNum. */
    function fmtMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('common.dash')
      return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    /** Why a balance card has no numbers: never probed, refused, or failed. */
    function quotaReason(quota) {
      if (quota === null || quota === undefined) return t('key.neverProbed')
      const error = typeof quota.error === 'string' && quota.error !== '' ? quota.error : ''
      if (error !== '') return error
      if (quota.supported === false || quota.state === 'unsupported') return t('quota.deepseekUnsupported')
      return ''
    }

    /**
     * The per-key balance card. It shows the real account model: one headline
     * figure, a bar only when a limit exists, the reset countdown, and one-time
     * packs only while they still have something left.
     */
    function BalanceCard(props) {
      const { entry, now, busy, onProbe } = props
      const quota = entry.quota !== null && entry.quota !== undefined && typeof entry.quota === 'object' ? entry.quota : null
      const probing = busy === 'probe:' + String(entry.id)
      const unsupported = quota !== null && (quota.supported === false || quota.state === 'unsupported')
      const reason = unsupported ? quotaReason(quota) : ''
      const state = quota !== null && typeof quota.state === 'string' ? quota.state : null
      const color = state === null ? C.grey : quotaColor(state)
      const unit = quota !== null && typeof quota.unit === 'string' ? quota.unit : ''
      const remaining = quota === null || unsupported ? null : quota.remaining
      const total = quota === null || unsupported ? null : quota.total
      const cny = quota !== null && !unsupported && unit.toUpperCase() === 'CNY' && typeof remaining === 'number'
      const hasRatio = typeof remaining === 'number' && typeof total === 'number' && total > 0

      let headline
      if (cny) headline = t('quota.cny', { amount: fmtMoney(remaining) })
      else if (hasRatio) headline = t('quota.value', { remaining: fmtNum(remaining), total: fmtNum(total), unit }).trim()
      else if (typeof remaining === 'number') headline = t('quota.remainingOnly', { remaining: fmtNum(remaining), unit }).trim()
      else headline = t('common.dash')

      const windows = quota !== null && Array.isArray(quota.windows)
        ? quota.windows.filter((window) => window !== null && window !== undefined && typeof window === 'object')
        : []
      const bonus = quota !== null && quota.bonus !== null && quota.bonus !== undefined && typeof quota.bonus === 'object' ? quota.bonus : null
      const bonusRemaining = bonus !== null && typeof bonus.remaining === 'number' ? bonus.remaining : 0
      const bonusPacks = bonus !== null && Array.isArray(bonus.packs) ? bonus.packs : []
      const bonusNames = bonusPacks
        .map((pack) => (pack !== null && pack !== undefined && typeof pack.name === 'string' ? pack.name : ''))
        .filter((name) => name !== '')
        .join(', ')

      const resetAt = quota === null ? null : toMs(quota.resetAt !== undefined ? quota.resetAt : (windows.length > 0 ? windows[0].resetAt : null))
      const checkedAt = quota === null ? null : toMs(quota.checkedAt)
      const nextCheckAt = quota === null ? null : toMs(quota.nextCheckAt)

      const rows = []
      if (unsupported || quota === null) {
        rows.push(h(Hint, { key: 'reason' }, reason === '' ? t('common.dash') : reason))
      } else {
        rows.push(h('div', {
          key: 'headline',
          style: {
            fontSize: 13,
            lineHeight: '19px',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            wordBreak: 'break-word',
            color: 'inherit',
          },
        }, headline))
        if (hasRatio) {
          rows.push(h('div', {
            key: 'bar',
            style: { height: 6, borderRadius: 3, background: C.track, overflow: 'hidden' },
          }, h('div', {
            style: {
              width: Math.max(0, Math.min(100, (remaining / total) * 100)) + '%',
              minWidth: remaining > 0 ? 2 : 0,
              height: '100%',
              borderRadius: 3,
              background: color,
            },
          })))
        }
        if (resetAt !== null) {
          const resetSuffix = resetAt > now ? ' · ' + relFuture(resetAt, now) : ''
          rows.push(h('p', {
            key: 'reset',
            title: absTime(resetAt),
            style: { margin: 0, fontSize: 11, lineHeight: '16px', color: C.faint },
          }, t('quota.reset', { time: stampOf(resetAt) }) + resetSuffix))
        }
        if (bonus !== null && bonusRemaining > 0) {
          rows.push(h('p', {
            key: 'bonus',
            style: { margin: 0, fontSize: 11, lineHeight: '16px', color: C.blue, wordBreak: 'break-word' },
          }, t('quota.bonus', { remaining: fmtNum(bonusRemaining) }) + (bonusNames === '' ? '' : ' ' + t('quota.bonusPack', { packs: bonusNames }))))
        }
        windows.slice(1).forEach((window, index) => {
          const type = typeof window.type === 'string' && window.type !== '' ? window.type : t('quota.title') + ' ' + String(index + 2)
          const left = typeof window.remaining === 'number' ? fmtNum(window.remaining) : t('common.dash')
          const limit = typeof window.limit === 'number' ? fmtNum(window.limit) : t('common.dash')
          rows.push(h('p', {
            key: 'window' + index,
            style: { margin: 0, fontSize: 11, lineHeight: '16px', color: C.dim, fontVariantNumeric: 'tabular-nums' },
          }, type + ': ' + left + ' / ' + limit + (unit === '' ? '' : ' ' + unit)))
        })
        const meta = []
        if (checkedAt !== null) {
          meta.push(h('span', { key: 'checked', title: absTime(checkedAt) }, t('quota.checked', { time: stampOf(checkedAt) }) + ' · ' + relPast(checkedAt, now)))
        }
        if (quota.stale === true) meta.push(h(Chip, { key: 'stale', color: C.amber }, t('quota.stale')))
        if (nextCheckAt !== null) {
          meta.push(h('span', { key: 'next', title: absTime(nextCheckAt) }, t('quota.nextCheck', { time: stampOf(nextCheckAt) }) + ' · ' + relFuture(nextCheckAt, now)))
        }
        if (meta.length > 0) {
          rows.push(h('div', {
            key: 'meta',
            style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 11, lineHeight: '16px', color: C.faint },
          }, meta))
        }
        if (typeof quota.error === 'string' && quota.error !== '') {
          rows.push(h('p', {
            key: 'error',
            style: { margin: 0, fontSize: 11, lineHeight: '16px', color: C.red, wordBreak: 'break-word' },
          }, t('quota.error', { message: quota.error })))
        }
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            flex: '0 1 300px',
            minWidth: 230,
            padding: '8px 10px',
            borderRadius: 8,
            border: C.lineSoft,
            background: C.surfaceSunken,
          },
        },
        [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
            h('span', { key: 'title', style: { fontSize: 11.5, lineHeight: '16px', color: C.dim, flex: '1 1 auto', minWidth: 0 } }, t('quota.title')),
            state === null ? null : h(Chip, { key: 'state', color }, t('quota.state.' + state)),
          ]),
          ...rows,
          h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'flex-end', marginTop: 2 } }, [
            h(Btn, {
              key: 'probe',
              size: 'sm',
              disabled: busy !== null,
              title: t('key.probe'),
              onClick: () => onProbe(entry.id),
              children: probing ? t('key.probing') : h(React.Fragment, null, glyph('refresh', 12), t('key.probe')),
            }),
          ]),
        ],
      )
    }

    /** The provider-side key id, when the balance probe reported one. */
    function accountIdOf(entry) {
      const quota = entry !== null && entry !== undefined ? entry.quota : null
      const account = quota !== null && quota !== undefined && typeof quota === 'object' ? quota.account : null
      if (account === null || account === undefined || typeof account !== 'object') return ''
      const raw = account.apiKeyId !== undefined ? account.apiKeyId : (account.id !== undefined ? account.id : account.keyId)
      if (typeof raw === 'string') return raw
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
      return ''
    }

    /** A key's masked label, reduced to dots so no key character can render. */
    function maskOf(entry) {
      const raw = entry !== null && entry !== undefined ? (entry.maskedLabel !== undefined ? entry.maskedLabel : entry.label) : null
      if (typeof raw !== 'string') return t('common.dots')
      const scrubbed = raw.replace(/[^\u2022*\u00b7.\u2026\s]/g, '').trim()
      return scrubbed === '' ? t('common.dots') : scrubbed
    }

    /** The note that tells two keys of one provider apart. */
    function noteOf(entry) {
      if (entry === null || entry === undefined) return ''
      if (typeof entry.note === 'string') return entry.note
      if (typeof entry.label === 'string') return entry.label
      return ''
    }


    //#endregion

    /**
     * One provider-level API key. A key adopted from Settings is permanent: it
     * carries its note, its balance and its enable checkbox, never a removal.
     * A key added here can be removed.
     */
    function ProviderKeyRow(props) {
      const { provider, entry, now, busy, drafts, writeDraft, confirming, onAskRemove, onRemove, onProbe } = props
      const disabled = busy !== null
      const keyId = entry.id === undefined || entry.id === null ? '' : String(entry.id)
      const noteId = 'note:' + provider + ':' + keyId
      const enabledId = 'enabled:' + provider + ':' + keyId
      const originalNote = noteOf(entry)
      const originalEnabled = entry.enabled !== false
      const noteValue = drafts[noteId] !== undefined ? String(drafts[noteId].value) : originalNote
      const enabledValue = drafts[enabledId] !== undefined ? drafts[enabledId].value === true : originalEnabled

      const state = typeof entry.state === 'string' ? entry.state : 'unknown'
      const color = keyColor(state)
      const dots = maskOf(entry)
      const accountId = accountIdOf(entry)
      const cooldownUntil = toMs(entry.cooldownUntil)
      const cooling = cooldownUntil !== null && cooldownUntil > now
      const leases = typeof entry.activeLeases === 'number' ? entry.activeLeases : 0
      const native = entry.source === 'native'
      const removable = entry.removable === true || (entry.removable === undefined && entry.source !== 'native')
      const failures = typeof entry.consecutiveFailures === 'number' ? entry.consecutiveFailures : 0
      const hits = typeof entry.consecutive429s === 'number' ? entry.consecutive429s : 0
      const lastOk = toMs(entry.lastSuccessAt)
      const missing = entry.configured === false

      const failureText = failures === 0
        ? t('key.noFailures')
        : t('key.failures', { n: fmtNum(failures), m: fmtNum(hits) })
      const lastOkText = lastOk === null ? t('key.neverSucceeded') : t('key.lastOk', { time: relPast(lastOk, now) })

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            padding: '10px',
            borderRadius: 8,
            border: C.lineSoft,
            background: 'transparent',
            opacity: enabledValue === false ? 0.72 : 1,
          },
        },
        [
          h('div', { key: 'info', style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 340px', minWidth: 250 } }, [
            h('div', { key: 'line1', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 } }, [
              h('span', { key: 'dots', style: { fontFamily: MONO, fontSize: 12.5, letterSpacing: 1, color: C.dim } }, dots),
              accountId === ''
                ? null
                : h('span', { key: 'account', title: t('key.accountId'), style: { fontFamily: MONO, fontSize: 11, color: C.faint, whiteSpace: 'nowrap' } }, accountId),
              h(Chip, { key: 'source', color: native ? C.grey : C.blue }, t(native ? 'key.source.native' : 'key.source.added')),
              h('span', { key: 'state', style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, lineHeight: '17px', color } }, [
                h(Dot, { key: 'dot', color, size: 6 }),
                h('span', { key: 'label' }, t('key.state.' + state)),
              ]),
              cooling
                ? h(Chip, { key: 'cooling', color: C.amber, title: absTime(cooldownUntil) }, t('key.cooldown', { time: relFuture(cooldownUntil, now) }))
                : null,
              h('span', { key: 'failures', style: { fontSize: 11, lineHeight: '17px', color: failures === 0 ? C.faint : C.amber } }, failureText),
              h('span', { key: 'lastOk', style: { fontSize: 11, lineHeight: '17px', color: C.faint } }, lastOkText),
              leases > 0
                ? h('span', { key: 'leases', style: { fontSize: 11, lineHeight: '17px', color: C.faint } }, t(leases === 1 ? 'key.oneLease' : 'key.leases', { n: fmtNum(leases) }))
                : null,
            ]),
            h('div', { key: 'line2', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 } }, [
              h(TextField, {
                key: 'note',
                label: t('key.note'),
                placeholder: t('key.notePlaceholder'),
                value: noteValue,
                disabled,
                grow: true,
                onChange: (next) => writeDraft(
                  noteId,
                  { op: 'update-provider-key', provider, keyId: entry.id, note: next.trim() },
                  next,
                  next.trim() === originalNote.trim(),
                ),
              }),
              h('label', {
                key: 'enabled',
                style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', color: C.dim, cursor: disabled ? 'not-allowed' : 'pointer' },
              }, [
                h('input', {
                  key: 'box',
                  type: 'checkbox',
                  checked: enabledValue,
                  disabled,
                  onChange: (event) => {
                    const next = event.target.checked
                    writeDraft(enabledId, { op: 'update-provider-key', provider, keyId: entry.id, enabled: next }, next, next === originalEnabled)
                  },
                  style: { width: 14, height: 14, margin: 0, accentColor: C.green, cursor: disabled ? 'not-allowed' : 'pointer' },
                }),
                h('span', { key: 'text' }, t('key.enabled')),
              ]),
              removable
                ? h(Btn, {
                  key: 'remove',
                  size: 'sm',
                  tone: confirming ? 'danger' : 'plain',
                  disabled,
                  title: t('key.remove'),
                  onClick: () => (confirming ? onRemove(entry.id) : onAskRemove(entry.id)),
                  children: confirming ? t('key.removeConfirm') : h(React.Fragment, null, glyph('trash', 12), t('key.remove')),
                })
                : null,
            ]),
            missing
              ? h(Hint, { key: 'missing' }, t('key.missingCredential'))
              : null,
          ]),
          h(BalanceCard, { key: 'balance', entry, now, busy, onProbe }),
        ],
      )
    }

    /** The provider-level add-key form: a note and a write-only secret. */
    function AddProviderKeyForm(props) {
      const { busy, adding, onAdd } = props
      const disabled = busy !== null
      const [noteDraft, setNoteDraft] = useState('')
      const [valueDraft, setValueDraft] = useState('')
      const ready = valueDraft.trim() !== '' && !disabled

      const submit = () => {
        if (!ready) return
        const secret = valueDraft
        onAdd({ note: noteDraft.trim(), value: secret }).then((ok) => {
          // The secret is handed over once and cleared the moment the Host
          // confirms it; it is never put back into the field.
          if (ok) {
            setValueDraft('')
            setNoteDraft('')
          }
        })
      }

      const onEnter = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, marginTop: 4 } },
        [
          h(TextField, {
            key: 'note',
            label: t('key.note'),
            placeholder: t('key.notePlaceholder'),
            value: noteDraft,
            disabled,
            grow: true,
            onChange: (next) => setNoteDraft(next),
            onKeyDown: onEnter,
          }),
          h(TextField, {
            key: 'value',
            label: t('key.valuePlaceholder'),
            type: 'password',
            value: valueDraft,
            disabled,
            grow: true,
            placeholder: t('key.valuePlaceholder'),
            onChange: (next) => setValueDraft(next),
            onKeyDown: onEnter,
          }),
          h('button', {
            key: 'submit',
            type: 'button',
            disabled: !ready,
            onClick: submit,
            style: {
              flex: 'none',
              height: 28,
              padding: '0 12px',
              borderRadius: 6,
              border: '1px solid transparent',
              background: C.primaryFill,
              color: C.primaryText,
              font: 'inherit',
              fontSize: 12.5,
              lineHeight: '18px',
              cursor: ready ? 'pointer' : 'not-allowed',
              opacity: ready ? 1 : 0.45,
            },
          }, adding === true ? t('key.adding') : t('provider.addKey')),
        ],
      )
    }

    //#endregion

    //#region models and providers

    /**
     * One model under a provider. It renders for every catalog model, whether or
     * not a pool exists yet: the total, the link switch, the reservation
     * controls and one per-API cap column per provider key.
     *
     * The total is either the live sum of those caps (linked, read-only, with
     * the formula under the box) or a manual number the user types.
     */
﻿    function ModelRow(props) {
      const { provider, modelId, modelName, pool, providerKeys, drafts, writeDraft, busy } = props
      const disabled = busy !== null
      const hasPool = pool !== null && pool !== undefined && typeof pool === 'object'
      const lane = hasPool && pool.lane !== null && pool.lane !== undefined && typeof pool.lane === 'object' ? pool.lane : {}
      const linkId = 'link:' + provider + '/' + modelId
      const totalId = 'total:' + provider + '/' + modelId
      const reservedId = 'reserved:' + provider + '/' + modelId
      const releaseId = 'release:' + provider + '/' + modelId

      // Payload order is authoritative: the Host sorts the native key first, so
      // the first row and the first cap column follow providers[].keys as given.
      const poolKeys = hasPool && Array.isArray(pool.keys)
        ? pool.keys.filter((key) => key !== null && key !== undefined && typeof key === 'object')
        : []
      const capsById = new Map()
      for (const key of poolKeys) {
        if (key.id === undefined || key.id === null) continue
        capsById.set(String(key.id), typeof key.maxConcurrent === 'number' ? key.maxConcurrent : 0)
      }
      const rows = []
      const seen = new Set()
      for (const key of providerKeys) {
        if (key.id === undefined || key.id === null) continue
        const id = String(key.id)
        seen.add(id)
        rows.push({ id, key, cap: capsById.has(id) ? capsById.get(id) : 0 })
      }
      for (const key of poolKeys) {
        if (key.id === undefined || key.id === null) continue
        const id = String(key.id)
        if (seen.has(id)) continue
        seen.add(id)
        rows.push({ id, key, cap: typeof key.maxConcurrent === 'number' ? key.maxConcurrent : 0 })
      }
      const capRows = rows.map((row) => {
        const draftId = 'cap:' + provider + '/' + modelId + ':' + row.id
        const pending = drafts[draftId] !== undefined ? drafts[draftId].value : null
        return {
          keyId: row.id,
          key: row.key,
          original: row.cap,
          draftId,
          value: typeof pending === 'number' ? pending : row.cap,
        }
      })
      const sum = capRows.reduce((acc, row) => acc + row.value, 0)
      const hasCaps = capRows.length > 0

      // Without a pool there is no stored link flag: with keys, assume linked
      // (the caps drive the total); with no keys, leave the total editable.
      const originalLinked = hasPool
        ? (typeof pool.linked === 'boolean' ? pool.linked : pool.maxConcurrentAuto === true)
        : hasCaps
      const linked = drafts[linkId] !== undefined ? drafts[linkId].value === true : originalLinked

      const originalTotal = hasPool && typeof pool.maxConcurrent === 'number' ? pool.maxConcurrent : 0
      const totalValue = linked
        ? sum
        : (drafts[totalId] !== undefined ? drafts[totalId].value : originalTotal)
      const originalReserved = hasPool && typeof pool.reservedForMain === 'number' ? pool.reservedForMain : 1
      const reservedValue = drafts[reservedId] !== undefined ? drafts[reservedId].value : originalReserved
      const originalRelease = hasPool && pool.releaseReservationWhenIdle === true
      const releaseValue = drafts[releaseId] !== undefined ? drafts[releaseId].value === true : originalRelease

      const totalHint = linked
        ? (hasCaps ? t('model.linkHint', { sum: capRows.map((row) => fmtNum(row.value)).join(' + '), total: fmtNum(sum) }) : '')
        : t('model.manualTotal')

      const totalField = h(NumberField, {
        key: 'total',
        label: t('model.totalCap'),
        title: linked ? t('model.linkTotal') : t('model.manualTotal'),
        value: typeof totalValue === 'number' ? totalValue : 0,
        min: 0,
        emptyAsZero: true,
        disabled: disabled || linked,
        muted: linked,
        hint: totalHint,
        onCommit: (next) => {
          writeDraft(
            totalId,
            { op: 'set-pool', provider, model: modelId, linked: false, maxConcurrent: next },
            next,
            next === originalTotal,
          )
          // The total op already carries linked:false; a separate link op would
          // only repeat it.
          if (next !== originalTotal) {
            writeDraft(linkId, { op: 'set-pool', provider, model: modelId, linked: false }, false, true)
          }
        },
      })

      const reservedField = h(NumberField, {
        key: 'reserved',
        label: t('pool.reservedForMain'),
        value: typeof reservedValue === 'number' ? reservedValue : 0,
        min: 0,
        disabled,
        onCommit: (next) => writeDraft(
          reservedId,
          { op: 'set-pool', provider, model: modelId, reservedForMain: next },
          next,
          next === originalReserved,
        ),
      })

      const releaseCheck = h(CheckBox, {
        key: 'release',
        checked: releaseValue,
        disabled,
        label: t('pool.release'),
        onChange: (next) => writeDraft(
          releaseId,
          { op: 'set-pool', provider, model: modelId, releaseReservationWhenIdle: next },
          next,
          next === originalRelease,
        ),
      })

      const linkCheck = h(CheckBox, {
        key: 'link',
        checked: linked,
        disabled,
        label: t('model.linkTotal'),
        onChange: (next) => {
          writeDraft(linkId, { op: 'set-pool', provider, model: modelId, linked: next }, next, next === originalLinked)
          if (next === true) writeDraft(totalId, { op: 'set-pool' }, 0, true)
        },
      })

      const capFields = capRows.map((row) => h(NumberField, {
        key: row.keyId,
        label: noteOf(row.key) !== '' ? noteOf(row.key) : row.keyId,
        title: t('key.capHint'),
        value: row.value,
        min: 0,
        emptyAsZero: true,
        disabled,
        onCommit: (next) => {
          writeDraft(
            row.draftId,
            { op: 'set-key-cap', provider, model: modelId, keyId: row.keyId, maxConcurrent: next },
            next,
            next === row.original,
          )
          // A linked model with no pool yet needs the pool upserted first, so
          // the cap lands on a pool that exists.
          if (linked && !hasPool) {
            writeDraft(linkId, { op: 'set-pool', provider, model: modelId, linked: true }, true, false)
          }
        },
      }))

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '10px',
            borderRadius: 8,
            border: C.lineSoft,
            background: 'transparent',
          },
        },
        [
          h('div', { key: 'name', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 } }, [
            h('span', { key: 'label', style: { fontSize: 13.5, lineHeight: '20px', fontWeight: 600 } }, modelName === '' ? t('common.dash') : modelName),
            modelName !== modelId
              ? h('span', { key: 'id', style: { fontFamily: MONO, fontSize: 11.5, color: C.faint } }, modelId)
              : null,
          ]),
          // Two cells: the caps stacked on the left, the two switches centred on
          // the right. A grid keeps the left edges aligned and the rows honest.
          h('div', {
            key: 'grid',
            style: {
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              columnGap: 24,
              rowGap: 0,
              alignItems: 'stretch',
              justifyItems: 'start',
            },
          }, [
            h('div', { key: 'left', style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } }, [
              totalField,
              reservedField,
            ]),
            h('div', {
              key: 'right',
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 16,
                height: '100%',
                minWidth: 0,
              },
            }, [releaseCheck, linkCheck]),
          ]),
          h('p', {
            key: 'lane',
            style: { margin: 0, fontSize: 11.5, lineHeight: '17px', color: C.faint, fontVariantNumeric: 'tabular-nums' },
          }, t('pool.lane', {
            main: fmtNum(typeof lane.mainLeases === 'number' ? lane.mainLeases : 0),
            child: fmtNum(typeof lane.childLeases === 'number' ? lane.childLeases : 0),
            capacity: fmtNum(typeof lane.childCapacity === 'number' ? lane.childCapacity : 0),
            waiting: fmtNum(typeof lane.waiting === 'number' ? lane.waiting : 0),
          })),
          h('div', { key: 'perApi', style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 } }, [
            h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 } }, [
              h('span', { key: 'label', style: { fontSize: 11.5, lineHeight: '17px', fontWeight: 600, color: C.dim } }, t('model.perApiCaps')),
              hasCaps
                ? h('span', { key: 'hint', style: { fontSize: 11, lineHeight: '16px', color: C.faint } }, t('key.capHint'))
                : null,
            ]),
            h('div', { key: 'grid', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 } },
              hasCaps ? capFields : [h(Hint, { key: 'none' }, t('model.addKeyForCaps'))]),
          ]),
        ],
      )
    }
    /** One provider: a collapsed summary row that expands into its settings. */
    function ProviderSection(props) {
      const {
        provider, displayName, status, models, poolIndex, providerKeys, expanded, onToggle,
        now, busy, confirming, drafts, writeDraft,
        onAddProviderKey, onRemoveProviderKey, onAskRemove, onProbe, onProbeAll,
      } = props
      const disabled = busy !== null
      const cap = status !== null && status !== undefined && typeof status.maxConcurrent === 'number'
        ? status.maxConcurrent
        : 0
      const active = status !== null && status !== undefined && typeof status.activeLeases === 'number'
        ? status.activeLeases
        : 0
      const capId = 'provider:' + provider
      const capValue = drafts[capId] !== undefined ? drafts[capId].value : cap
      const chevronStyle = {
        display: 'inline-flex',
        flex: 'none',
        color: C.faint,
        transform: expanded === true ? 'rotate(90deg)' : 'none',
        transition: 'transform .15s ease',
      }

      return h(
        'section',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 10,
            border: C.lineSoft,
            background: C.surfaceInset,
            overflow: 'hidden',
          },
        },
        [
          h('button', {
            key: 'head',
            type: 'button',
            'aria-expanded': expanded === true,
            'aria-label': t(expanded === true ? 'provider.collapse' : 'provider.expand') + ': ' + displayName,
            onClick: onToggle,
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '10px 12px',
              margin: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            },
          }, [
            h('span', { key: 'chev', style: chevronStyle }, glyph('chevron', 12)),
            h('span', { key: 'name', style: { fontSize: 14.5, lineHeight: '22px', fontWeight: 600 } }, displayName === '' ? provider : displayName),
            h('span', { key: 'id', style: { fontFamily: MONO, fontSize: 11.5, color: C.dim } }, provider),
            h('span', { key: 'keys', style: { marginInlineStart: 'auto', fontSize: 11.5, color: C.faint } }, t(providerKeys.length === 1 ? 'provider.oneKey' : 'provider.keys', { n: fmtNum(providerKeys.length) })),
            h('span', { key: 'active', style: { fontSize: 11.5, color: C.faint } }, t('provider.inUse', { n: fmtNum(active) })),
          ]),
          expanded === true
            ? h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '0 12px 12px' } }, [
              h('div', { key: 'cap', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 } }, [
                h(NumberField, {
                  key: 'max',
                  label: t('provider.maxConcurrent'),
                  title: t('provider.unlimitedHint'),
                  value: typeof capValue === 'number' ? capValue : 0,
                  min: 0,
                  emptyAsZero: true,
                  disabled,
                  onCommit: (next) => writeDraft(capId, { op: 'set-provider', provider, maxConcurrent: next }, next, next === cap),
                }),
                h('span', { key: 'hint', style: { fontSize: 11, lineHeight: '16px', color: C.faint, paddingBottom: 6 } }, t('provider.unlimitedHint')),
              ]),
              h('div', { key: 'keys', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
                  h('span', { key: 'title', style: { fontSize: 12.5, lineHeight: '20px', fontWeight: 600 } }, t('provider.apiKeys')),
                  h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
                  h(Btn, {
                    key: 'probeAll',
                    size: 'sm',
                    disabled,
                    title: t('key.probeAll'),
                    onClick: () => onProbeAll(),
                    children: h(React.Fragment, null, glyph('refresh', 12), t('key.probeAll')),
                  }),
                ]),
                h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  providerKeys.length === 0
                    ? [h(Hint, { key: 'none' }, t('provider.noKeys'))]
                    : providerKeys.map((entry, index) => h(ProviderKeyRow, {
                      key: entry.id === undefined || entry.id === null ? index : String(entry.id),
                      provider,
                      entry,
                      now,
                      busy,
                      drafts,
                      writeDraft,
                      confirming: confirming === String(entry.id),
                      onAskRemove: (keyId) => onAskRemove(keyId),
                      onRemove: (keyId) => onRemoveProviderKey(provider, keyId),
                      onProbe,
                    }))),
                h(AddProviderKeyForm, {
                  key: 'add',
                  busy,
                  adding: busy === 'add-key:' + provider,
                  onAdd: (payload) => onAddProviderKey(provider, payload.note, payload.value),
                }),
              ]),
              h('div', { key: 'models', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                h('span', { key: 'title', style: { fontSize: 12.5, lineHeight: '20px', fontWeight: 600 } }, t('model.heading')),
                h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  models.length === 0
                    ? [h(Hint, { key: 'none' }, t('model.none'))]
                    : models.map((model) => h(ModelRow, {
                      key: model.id,
                      provider,
                      modelId: model.id,
                      modelName: model.name,
                      catalogModel: model.catalogModel,
                      pool: poolIndex.get(provider + '/' + model.id) || null,
                      providerKeys,
                      drafts,
                      writeDraft,
                      busy,
                    }))),
              ]),
            ])
            : null,
        ],
      )
    }

    //#endregion
    //#region diagnostics and rollback

    /** A stable signature, so a self-test entry the host also logs is shown once. */
    function logSignature(entry) {
      if (entry === null || entry === undefined || typeof entry !== 'object') return ''
      return [entry.t, entry.pool, entry.key, entry.lane, entry.action, entry.waitMs, entry.status].join('|')
    }

    /** The newest entries of the host log plus whatever the last self-test returned. */
    function mergeLog(hostLog, extraLog) {
      const known = new Set()
      for (const entry of hostLog) known.add(logSignature(entry))
      const extras = extraLog.filter((entry) => !known.has(logSignature(entry)))
      const merged = extras.slice().reverse().concat(hostLog.slice().reverse())
      return merged.slice(0, LOG_LIMIT)
    }

    /** One compact log line: time, lane, key, action, wait. */
    function LogRow(props) {
      const entry = props.entry !== null && props.entry !== undefined && typeof props.entry === 'object' ? props.entry : {}
      const time = toMs(entry.t)
      const key = typeof entry.key === 'string' && entry.key !== '' ? entry.key : t('common.dash')
      const wait = typeof entry.waitMs === 'number' && Number.isFinite(entry.waitMs) ? entry.waitMs : null
      const detail = typeof entry.detail === 'string' ? entry.detail : ''
      const status = typeof entry.status === 'number' ? String(entry.status) : ''
      const title = [time === null ? '' : absTime(time), typeof entry.pool === 'string' ? entry.pool : '', status, detail]
        .filter((part) => part !== '')
        .join(' - ')
      return h(
        'div',
        {
          title: title === '' ? undefined : title,
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '2px 0',
            fontSize: 11,
            lineHeight: '16px',
            color: C.dim,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        [
          h('span', { key: 'time', style: { flex: 'none', width: 62, color: C.faint, whiteSpace: 'nowrap' } }, clockTime(time)),
          h('span', { key: 'lane', style: { flex: 'none', width: 58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, laneLabel(entry.lane)),
          h('span', { key: 'key', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO } }, key),
          h('span', { key: 'action', style: { flex: 'none', color: 'inherit' } }, actionLabel(entry.action)),
          wait !== null && wait > 0
            ? h('span', { key: 'wait', style: { flex: 'none', color: C.faint } }, t('diag.wait', { ms: fmtNum(wait) }))
            : null,
        ],
      )
    }

    /** Correlation mode, the recent log and the allocation self-test. */
    function Diagnostics(props) {
      const { status, extraLog, busy, inject429, note, onInject429, onRun } = props
      const correlation = status !== null && status !== undefined && status.correlation !== null && status.correlation !== undefined && typeof status.correlation === 'object'
        ? status.correlation
        : {}
      const hostLog = status !== null && status !== undefined && Array.isArray(status.log) ? status.log : []
      const rows = mergeLog(hostLog, extraLog)
      const running = busy === 'selftest'

      return h(Card, null, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
          h(CardTitle, { key: 'title' }, t('diag.title')),
          h('span', { key: 'correlation', style: { display: 'inline-flex', alignItems: 'center', gap: 6, marginInlineStart: 'auto', fontSize: 11, color: C.faint } }, [
            h('span', { key: 'label' }, t('diag.correlation')),
            h(Chip, { key: 'als', color: correlation.als === true ? C.green : C.grey }, t('diag.als') + ' ' + t(correlation.als === true ? 'diag.on' : 'diag.off')),
            h(Chip, { key: 'fifo', color: correlation.fifo === true ? C.amber : C.grey }, t('diag.fifo') + ' ' + t(correlation.fifo === true ? 'diag.on' : 'diag.off')),
          ]),
        ]),
        h('div', { key: 'logTitle', style: { fontSize: 11.5, lineHeight: '17px', color: C.dim, marginTop: 2 } }, t('diag.log')),
        h('div', {
          key: 'log',
          style: {
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 168,
            overflowY: 'auto',
            padding: '4px 6px',
            borderRadius: 8,
            border: C.lineSoft,
            background: C.surface,
          },
        }, rows.length === 0
          ? h(Hint, { key: 'empty' }, t('diag.logEmpty'))
          : rows.map((entry, index) => h(LogRow, { key: index, entry }))),
        h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 2 } }, [
          h(Btn, {
            key: 'run',
            disabled: busy !== null,
            onClick: onRun,
            children: running ? t('diag.running') : t('diag.selftest'),
          }),
          h('div', { key: 'inject', style: { display: 'flex', alignItems: 'center' } }, [
            h(CheckBox, {
              key: 'box',
              checked: inject429 === true,
              disabled: busy !== null,
              label: t('diag.inject429'),
              onChange: onInject429,
            }),
          ]),
          note === null || note === undefined
            ? null
            : h('span', { key: 'note', style: { fontSize: 11.5, color: C.dim } }, note),
        ]),
      ])
    }

    //#endregion


    //#region page

    /** A readable label for one pending op, used in the save-failure banner. */
    function opLabel(op) {
      if (op === null || op === undefined || typeof op !== 'object') return 'op'
      const parts = [typeof op.op === 'string' ? op.op : 'op']
      if (typeof op.provider === 'string' && op.provider !== '') parts.push(op.provider)
      if (typeof op.model === 'string' && op.model !== '') parts.push(op.model)
      if (op.keyId !== undefined && op.keyId !== null) parts.push(String(op.keyId))
      return parts.join(' ')
    }

    /**
     * The plugin page body. Field edits go into a draft; nothing reaches the
     * Host until Apply, and nothing is lost when one op fails.
     */
    function OrchestratorPage() {
      useLocaleId()
      const store = useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusSnapshot)
      const [now, setNow] = useState(() => Date.now())
      const [busy, setBusy] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [confirmingKey, setConfirmingKey] = useState(null)
      const [expanded, setExpanded] = useState({})
      const [drafts, setDrafts] = useState({})
      const [savedAt, setSavedAt] = useState(null)
      const [saveError, setSaveError] = useState(null)
      const [selftestLog, setSelftestLog] = useState([])
      const [selftestNote, setSelftestNote] = useState(null)
      const [inject429, setInject429] = useState(false)

      const status = store.status
      const statusError = store.error
      const loading = store.loading
      const enabled = status !== null && status !== undefined && status.enabled === true
      const retry = status !== null && status !== undefined && status.retry !== null && status.retry !== undefined && typeof status.retry === 'object' ? status.retry : {}
      const midStreamRetry = retry.midStreamRetry === true
      const maxRetries = typeof retry.midStreamMaxRetries === 'number' ? retry.midStreamMaxRetries : 1
      const startedMs = status === null || status === undefined ? null : toMs(status.startedAt)
      const version = status !== null && status !== undefined && status.version !== undefined && status.version !== null ? String(status.version) : t('common.dash')
      const warnings = status !== null && status !== undefined && Array.isArray(status.warnings) ? status.warnings : []
      const pools = status !== null && status !== undefined && Array.isArray(status.pools) ? status.pools : []
      const catalog = status !== null && status !== undefined && Array.isArray(status.catalog) ? status.catalog : []
      const providers = status !== null && status !== undefined && Array.isArray(status.providers) ? status.providers : []

      useEffect(() => {
        refreshStatus()
        const poll = setInterval(() => {
          refreshStatus()
        }, POLL_MS)
        const clock = setInterval(() => {
          setNow(Date.now())
        }, 1000)
        return () => {
          clearInterval(poll)
          clearInterval(clock)
        }
      }, [])

      /** Run one immediate Host op (switch, probe, add, remove). */
      const run = async (id, work) => {
        setBusy(id)
        setActionError(null)
        setSelftestNote(null)
        setConfirmingKey(null)
        try {
          const result = await work()
          await refreshStatus()
          return result === undefined ? true : result
        } catch (reason) {
          setActionError(messageOf(reason))
          return null
        } finally {
          setBusy(null)
        }
      }

      const toggleEnabled = (next) => run('toggle', () => postConfig({ op: 'toggle', enabled: next }))

      const setRetry = (next) => run('retry', () => postConfig({
        op: 'set-retry',
        midStreamRetry: next,
        midStreamMaxRetries: maxRetries,
      }))

      const addProviderKey = (provider, note, value) => run('add-key:' + provider, () => postConfig({
        op: 'add-provider-key',
        provider,
        note,
        value,
      })).then((result) => result !== null)

      const removeProviderKey = (provider, keyId) => run('remove-key:' + String(keyId), () => postConfig({
        op: 'remove-provider-key',
        provider,
        keyId,
      }))

      const probeKey = (keyId) => run('probe:' + String(keyId), () => postConfig({ op: 'probe', keyId }))

      const probeAll = () => run('probe:all', () => postConfig({ op: 'probe' }))

      const runSelftest = async () => {
        setBusy('selftest')
        setActionError(null)
        setSelftestNote(null)
        try {
          const payload = await postConfig({
            op: 'selftest',
            concurrency: 8,
            inject429: inject429 === true ? 'first' : 'off',
          })
          const entries = Array.isArray(payload.log) ? payload.log : []
          setSelftestLog((previous) => previous.concat(entries))
          setSelftestNote(t('diag.selftestDone', { n: fmtNum(entries.length) }))
          await refreshStatus()
        } catch (reason) {
          setSelftestNote(t('diag.selftestFailed', { message: messageOf(reason) }))
        } finally {
          setBusy(null)
        }
      }

      /**
       * Record one pending edit. `noop` says the field is back to its stored
       * value, which removes the draft instead of posting a no-change op.
       */
      const writeDraft = (id, op, value, noop) => {
        setSavedAt(null)
        setSaveError(null)
        setDrafts((previous) => {
          if (noop === true) {
            if (previous[id] === undefined) return previous
            const cleared = { ...previous }
            delete cleared[id]
            return cleared
          }
          const next = { ...previous }
          next[id] = { op, value }
          return next
        })
      }

      /** Apply every pending op in order; stop at the first refusal and keep it. */
      const applyDrafts = async () => {
        const ids = Object.keys(drafts)
        if (ids.length === 0 || busy !== null) return
        const priority = { 'set-provider': 0, 'update-provider-key': 1, 'set-pool': 2, 'set-key-cap': 3 }
        ids.sort((left, right) => (priority[drafts[left].op.op] || 0) - (priority[drafts[right].op.op] || 0))
        setBusy('apply')
        setActionError(null)
        setSaveError(null)
        setSavedAt(null)
        try {
          for (const id of ids) {
            const entry = drafts[id]
            try {
              await postConfig(entry.op)
            } catch (reason) {
              setSaveError(t('pages.saveFailed', { op: opLabel(entry.op), message: messageOf(reason) }))
              return
            }
          }
          setDrafts({})
          setSavedAt(Date.now())
          await refreshStatus()
        } finally {
          setBusy(null)
        }
      }

      const discardDrafts = () => {
        setDrafts({})
        setSaveError(null)
        setSavedAt(null)
      }

      // ---- providers: catalog models joined with the pools actually run ----

      const catalogIndex = new Map()
      for (const entry of catalog) {
        if (entry === null || entry === undefined || typeof entry !== 'object') continue
        if (typeof entry.provider !== 'string' || entry.provider === '') continue
        catalogIndex.set(entry.provider, entry)
      }
      const statusIndex = new Map()
      for (const entry of providers) {
        if (entry === null || entry === undefined || typeof entry !== 'object') continue
        if (typeof entry.provider !== 'string' || entry.provider === '') continue
        statusIndex.set(entry.provider, entry)
      }

      const order = []
      const merged = new Map()
      const ensureProvider = (provider) => {
        const existing = merged.get(provider)
        if (existing !== undefined) return existing
        const cat = catalogIndex.get(provider) || null
        const stat = statusIndex.get(provider) || null
        const displayName = stat !== null && typeof stat.displayName === 'string' && stat.displayName !== ''
          ? stat.displayName
          : (cat !== null && typeof cat.displayName === 'string' && cat.displayName !== '' ? cat.displayName : provider)
        const models = []
        const modelIds = new Set()
        if (cat !== null && Array.isArray(cat.models)) {
          for (const model of cat.models) {
            if (model === null || model === undefined || typeof model !== 'object') continue
            const id = typeof model.id === 'string' ? model.id : String(model.id === undefined || model.id === null ? '' : model.id)
            if (id === '' || modelIds.has(id)) continue
            modelIds.add(id)
            models.push({ id, name: typeof model.name === 'string' && model.name !== '' ? model.name : id, catalogModel: model })
          }
        }
        const entry = { provider, displayName, status: stat, models, modelIds }
        merged.set(provider, entry)
        order.push(entry)
        return entry
      }

      for (const entry of catalog) {
        if (entry !== null && entry !== undefined && typeof entry === 'object' && typeof entry.provider === 'string' && entry.provider !== '') {
          ensureProvider(entry.provider)
        }
      }
      for (const entry of providers) {
        if (entry !== null && entry !== undefined && typeof entry === 'object' && typeof entry.provider === 'string' && entry.provider !== '') {
          ensureProvider(entry.provider)
        }
      }

      const poolIndex = new Map()
      for (const pool of pools) {
        if (pool === null || pool === undefined || typeof pool !== 'object') continue
        const provider = typeof pool.provider === 'string' ? pool.provider : ''
        const model = typeof pool.model === 'string' ? pool.model : ''
        if (provider === '' || model === '') continue
        poolIndex.set(provider + '/' + model, pool)
        const entry = ensureProvider(provider)
        if (!entry.modelIds.has(model)) {
          entry.modelIds.add(model)
          entry.models.push({ id: model, name: model, catalogModel: null })
        }
      }

      const allExpanded = order.length > 0 && order.every((entry) => expanded[entry.provider] === true)
      const toggleProvider = (provider) => setExpanded((previous) => ({ ...previous, [provider]: previous[provider] !== true }))
      const toggleAll = () => {
        const next = {}
        const target = !allExpanded
        for (const entry of order) next[entry.provider] = target
        setExpanded(next)
      }

      const pendingCount = Object.keys(drafts).length
      const savedRecent = savedAt !== null && now - savedAt < 6000

      const body = []

      if (pendingCount > 0 || saveError !== null || savedRecent) {
        body.push(h('div', {
          key: 'saveBar',
          style: {
            position: 'sticky',
            top: 0,
            zIndex: 5,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderRadius: 10,
            border: saveError === null ? C.lineSoft : '1px solid rgba(229,72,77,.45)',
            background: C.surface,
            boxShadow: '0 2px 10px rgba(0,0,0,.12)',
          },
        }, [
          pendingCount > 0
            ? h('span', { key: 'pending', style: { fontSize: 12.5, lineHeight: '19px', fontWeight: 600 } }, t(pendingCount === 1 ? 'pages.pendingOne' : 'pages.pending', { n: fmtNum(pendingCount) }))
            : null,
          saveError === null
            ? null
            : h('span', { key: 'error', style: { fontSize: 12, lineHeight: '18px', color: C.red, wordBreak: 'break-word', flex: '1 1 240px' } }, saveError),
          savedRecent && pendingCount === 0
            ? h('span', { key: 'saved', style: { fontSize: 12.5, lineHeight: '19px', color: C.green, fontWeight: 600 } }, t('pages.saved', { time: clockTime(savedAt) }))
            : null,
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          pendingCount > 0
            ? h(Btn, {
              key: 'apply',
              tone: 'primary',
              disabled: busy !== null,
              onClick: applyDrafts,
              children: t('pages.apply'),
            })
            : null,
          pendingCount > 0
            ? h(Btn, {
              key: 'discard',
              disabled: busy !== null,
              onClick: discardDrafts,
              children: t('pages.discard'),
            })
            : null,
        ]))
      }

      body.push(h('p', {
        key: 'bypass',
        style: { margin: 0, fontSize: 12.5, lineHeight: '19px', color: C.dim },
      }, t('panel.bypass')))

      body.push(h(Card, { key: 'retry' }, [
        h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 } }, [
          h(CardTitle, { key: 'title' }, t('panel.retry.title')),
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          midStreamRetry && maxRetries > 0
            ? h('span', { key: 'max', style: { fontSize: 11, color: C.faint } }, t('panel.retry.max', { n: fmtNum(maxRetries) }))
            : null,
          h('div', { key: 'switch' }, h(Switch, {
            checked: midStreamRetry,
            disabled: busy !== null,
            label: t('panel.retry.title'),
            ariaLabel: t('panel.retry.title'),
            onChange: setRetry,
          })),
        ]),
        h(Hint, { key: 'body' }, t('panel.retry.body')),
      ]))

      if (warnings.length > 0) {
        body.push(h(Card, { key: 'warnings' }, [
          h(CardTitle, { key: 'title' }, t('panel.warnings')),
          h('ul', { key: 'list', style: { margin: 0, paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
            warnings.map((warning, index) => {
              const code = warning !== null && warning !== undefined && typeof warning.code === 'string' ? warning.code : ''
              const message = warning !== null && warning !== undefined && typeof warning.message === 'string' ? warning.message : ''
              const translated = code === '' ? code : t('warning.' + code)
              const text = translated !== '' && translated !== 'warning.' + code ? translated : message
              return h('li', {
                key: index,
                title: code === '' ? undefined : code,
                style: { fontSize: 12, lineHeight: '18px', color: 'inherit', wordBreak: 'break-word' },
              }, text === '' ? t('common.unknownError') : text)
            })),
        ]))
      }

      if (order.length === 0) {
        body.push(h(Card, { key: 'catalogEmpty' }, [
          h(CardTitle, { key: 'title' }, t('catalog.empty.title')),
          h(Hint, { key: 'body' }, t('catalog.empty.body')),
        ]))
      } else {
        for (const entry of order) {
          const providerStatus = entry.status
          const providerKeys = providerStatus !== null && providerStatus !== undefined && Array.isArray(providerStatus.keys)
            ? providerStatus.keys.filter((key) => key !== null && key !== undefined && typeof key === 'object')
            : []
          body.push(h(ProviderSection, {
            key: 'provider:' + entry.provider,
            provider: entry.provider,
            displayName: entry.displayName,
            status: providerStatus,
            models: entry.models,
            poolIndex,
            providerKeys,
            expanded: expanded[entry.provider] === true,
            onToggle: () => toggleProvider(entry.provider),
            now,
            busy,
            confirming: confirmingKey,
            drafts,
            writeDraft,
            onAddProviderKey: addProviderKey,
            onRemoveProviderKey: removeProviderKey,
            onAskRemove: (keyId) => setConfirmingKey(String(keyId)),
            onProbe: probeKey,
            onProbeAll: probeAll,
          }))
        }
      }

      body.push(h(Diagnostics, {
        key: 'diagnostics',
        status,
        extraLog: selftestLog,
        busy,
        inject429,
        note: selftestNote,
        onInject429: setInject429,
        onRun: runSelftest,
      }))

      body.push(h(Card, { key: 'rollback', plain: true }, [
        h(CardTitle, { key: 'title' }, t('rollback.title')),
        h(Hint, { key: 'body' }, t('rollback.body')),
      ]))

      const subtitle = status === null
        ? t('common.dash')
        : t('panel.subtitle', {
          version,
          time: startedMs === null ? t('common.dash') : absTime(startedMs),
        })

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            width: '100%',
            minWidth: 0,
            color: C.text,
            fontFamily: FONT,
          },
        },
        [
          h('header', {
            key: 'header',
            style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: C.lineSoft },
          }, [
            h('div', {
              key: 'identity',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
                width: 34,
                height: 34,
                borderRadius: 9,
                background: 'rgba(74,140,255,.14)',
                color: C.blue,
              },
            }, glyph('notes', 22)),
            h('div', { key: 'titles', style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px', minWidth: 0 } }, [
              h('h2', {
                key: 'title',
                style: { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, t('panel.title')),
              h('span', {
                key: 'subtitle',
                style: { fontSize: 11.5, lineHeight: '17px', color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, subtitle),
            ]),
            h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginInlineStart: 'auto' } }, [
              order.length === 0
                ? null
                : h(Btn, {
                  key: 'toggleAll',
                  size: 'sm',
                  disabled: busy !== null,
                  onClick: toggleAll,
                  children: allExpanded ? t('pages.collapseAll') : t('pages.expandAll'),
                }),
              h(IconBtn, {
                key: 'refresh',
                glyph: 'refresh',
                glyphSize: 15,
                title: t('panel.refresh'),
                ariaLabel: t('panel.refresh'),
                disabled: busy !== null,
                onClick: () => refreshStatus(),
              }),
              h('div', { key: 'master', style: { display: 'flex', alignItems: 'center', flex: 'none' } }, [
                h(Switch, {
                  key: 'switch',
                  checked: enabled,
                  disabled: busy !== null,
                  label: t('panel.master'),
                  ariaLabel: t('panel.master'),
                  onChange: toggleEnabled,
                }),
              ]),
            ]),
          ]),
          statusError !== null && statusError !== undefined
            ? h('p', {
              key: 'statusError',
              style: { margin: 0, padding: '8px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: '19px', color: C.red, background: 'rgba(229,72,77,.10)', wordBreak: 'break-word' },
            }, t('panel.statusFailed', { message: String(statusError) }))
            : null,
          loading && status === null
            ? h('p', { key: 'loading', style: { margin: 0, fontSize: 12.5, color: C.dim } }, t('panel.loading'))
            : null,
          actionError === null
            ? null
            : h('p', {
              key: 'actionError',
              role: 'status',
              style: { margin: 0, padding: '8px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: '19px', color: C.red, background: 'rgba(229,72,77,.10)', wordBreak: 'break-word' },
            }, t('panel.actionFailed', { message: actionError })),
          h('div', {
            key: 'content',
            style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
          }, body),
        ],
      )
    }

    /**
     * The `main` seat. The root is its own scroll container: the harness gives
     * the panel a bounded height, so the page must scroll itself.
     */
    function PanelPage() {
      return h(
        'div',
        {
          style: {
            height: '100%',
            minHeight: 0,
            width: '100%',
            boxSizing: 'border-box',
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
            padding: '20px 24px 40px',
            color: C.text,
            fontFamily: FONT,
          },
        },
        h('div', {
          style: { width: '100%', maxWidth: 1120, marginInline: 'auto', boxSizing: 'border-box' },
        }, h(OrchestratorPage, null)),
      )
    }

    /** The `sidebar.panellist` seat: a glyph; the sidebar owns button and label. */
    function PanelIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' && props.size > 0
        ? props.size
        : 18
      return glyph('notes', size)
    }

    //#endregion

    /** Find the locale service on the context, whichever shape it has. */
    function resolveLocale(ctx) {
      try {
        if (ctx.locale !== undefined && ctx.locale !== null) return ctx.locale
      } catch (error) {
        // A partial context may not expose the property; try the lookup below.
      }
      try {
        if (typeof ctx.get === 'function') {
          const found = ctx.get('locale')
          if (found !== undefined && found !== null) return found
        }
      } catch (error) {
        // No locale service in this profile: the English table still answers.
      }
      return null
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx === null || ctx === undefined) return

        const service = resolveLocale(ctx)
        if (service !== null) {
          localeService = service
          if (typeof service.bind === 'function') {
            try {
              boundTranslate = service.bind(NS)
            } catch (error) {
              boundTranslate = null
            }
          }
          ctx.effect(() => registerDictionary(service, 'en', EN), 'dsh-multi-key-orchestrator: en locale')
          ctx.effect(() => registerDictionary(service, 'zh', ZH), 'dsh-multi-key-orchestrator: zh locale')
        }

        if (ctx.slots === null || ctx.slots === undefined) return

        // The sidebar navigation icon, directly under Context Insights. The
        // sidebar draws the button and resolves the label from this metadata.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'multi-key-orchestrator', order: 21, label: () => t('nav.label'), locale: NS },
          PanelIcon,
        ))

        // The page that icon addresses, in the keyed central-panel slot.
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'multi-key-orchestrator', locale: NS },
          PanelPage,
        ))
      },
    }
  },
})
