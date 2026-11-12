/**
 * Durable plugin state.
 *
 * The state file belongs to this plugin and lives beside its code, so the
 * user's profile patch is never read, filtered or rewritten by plugin code and
 * editing a pool never restarts the plugin. Writes are synchronous and atomic
 * (temporary file + rename) because the payload is small and a torn write would
 * lose every configured pool.
 *
 * Secrets are **not** stored here unless the Host has no credential service;
 * see `host.js` for the fallback and the warning it raises.
 *
 * @module dsh-multi-key-orchestrator/state
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {{ dir: string, file?: string, log?: (message: string) => void }} options
 */
export function createStateStore(options) {
  const dir = options.dir
  const file = path.join(dir, options.file ?? 'state.json')
  const log = options.log ?? (() => {})

  const ensureDir = () => {
    fs.mkdirSync(dir, { recursive: true })
  }

  return {
    /** @returns {string} absolute path of the state file */
    get path() {
      return file
    },

    /**
     * Read the stored object. A missing, unreadable or corrupt file yields
     * `undefined` so the caller can fall back to defaults instead of failing
     * to activate.
     * @returns {any | undefined}
     */
    load() {
      try {
        const text = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object') return undefined
        return parsed
      } catch (error) {
        if (error && error.code === 'ENOENT') return undefined
        log(`state load failed: ${String(error && error.message ? error.message : error)}`)
        return undefined
      }
    },

    /**
     * Persist the object atomically.
     * @param {any} value
     * @returns {{ ok: boolean, error?: string, path: string, savedAt: number }}
     */
    save(value) {
      const savedAt = Date.now()
      try {
        ensureDir()
        const payload = JSON.stringify({ ...value, savedAt }, null, 2)
        const temporary = `${file}.${process.pid}.tmp`
        fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
        fs.renameSync(temporary, file)
        return { ok: true, path: file, savedAt }
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        log(`state save failed: ${message}`)
        try {
          fs.unlinkSync(`${file}.${process.pid}.tmp`)
        } catch {
          /* the temporary file may not exist; nothing to clean */
        }
        return { ok: false, error: message, path: file, savedAt }
      }
    },
  }
}
