/**
 * Bridge to a local ACP proxy (billion-context / "bili").
 *
 * A wrapped model endpoint looks like `http://127.0.0.1:18787/bili/<inner-url>`:
 * the Host connects to loopback, and the ACP proxy performs the real egress —
 * including DNS. When the inner host only resolves at the proxy site, routing
 * the Host's own request is useless: the request never leaves the machine. What
 * has to change is the ACP proxy's egress.
 *
 * bili resolves that per route (`providers["<url prefix>"].proxy`) and applies
 * it on `POST /__bili/config/reload`, so this module writes exactly one key per
 * observed endpoint into bili's config file and puts the previous value back
 * when routing is turned off or the plugin is disposed. Loopback routes are
 * never touched, so bili's own hop to the model gateway keeps working.
 */
import fsp from 'node:fs/promises'

const WRAPPED = /^(https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::(\d+))?\/bili\/(.+)$/i
const TIMEOUT_MS = 4000

/** `http://127.0.0.1:18787/bili/https://host/path` -> {port, origin, inner}. */
export function parseWrapped(target) {
  const text = typeof target === 'string' ? target : String(target ?? '')
  const match = WRAPPED.exec(text)
  if (match === null) return null
  const inner = match[3].split('#')[0]
  let origin = ''
  try {
    origin = new URL(inner).origin
  } catch {
    return null
  }
  if (origin === '' || origin === 'null') return null
  return { port: match[2] === undefined ? 80 : Number(match[2]), origin, inner, loopback: isLoopback(origin) }
}

/**
 * bili's own hop to a local gateway is loopback traffic: sending it out through
 * a remote proxy would point the proxy at *its* 127.0.0.1, not this machine's.
 */
export function isLoopback(origin) {
  try {
    const host = new URL(origin).hostname
    return host === 'localhost'
      || host === '::1'
      || host === '[::1]'
      || host === '0.0.0.0'
      || /^127\./.test(host)
  } catch {
    return false
  }
}

function describe(error) {
  return error?.message !== undefined ? String(error.message) : String(error)
}

export class AcpBridge {
  /**
   * @param {object} options
   * @param {(message: string) => void} [options.log]
   * @param {typeof fetch} [options.fetchImpl] the unwrapped fetch, so bridge
   *   calls never re-enter the routing wrapper
   */
  constructor({ log = () => {}, fetchImpl = globalThis.fetch } = {}) {
    this.log = log
    this.fetchImpl = fetchImpl
    /** origin -> {port, previous, created} — what we owe back on restore */
    this.origins = new Map()
    this.applied = null
    this.lastError = null
    this.busy = null
    this.pending = false
    this.desired = null
  }

  /** Cheap check used on the hot path: is this URL an ACP-wrapped endpoint? */
  inspect(url) {
    return parseWrapped(url)
  }

  /** True when the next call to this URL should wait for the bridge first. */
  needsLearn(url) {
    const target = parseWrapped(url)
    if (target === null || target.loopback) return false
    return !this.origins.has(target.origin)
  }

  /** Record a wrapped endpoint and make sure it carries the active proxy. */
  async learn(url, state) {
    const target = parseWrapped(url)
    if (target === null || target.loopback) return
    if (!this.origins.has(target.origin)) {
      this.origins.set(target.origin, { port: target.port, previous: undefined, created: false })
    }
    await this.sync(state)
  }

  info() {
    const origins = [...this.origins.keys()]
    return {
      detected: origins.length > 0,
      origins,
      applied: this.applied,
      lastError: this.lastError,
    }
  }

  /** Proxy the ACP egress should use right now, or null for direct. */
  desiredProxy(state) {
    if (state === null || state === undefined) return null
    if (state.bridgeAcp === false) return null
    if (state.enabled !== true) return null
    const active = state.proxies?.find((entry) => entry.id === state.activeId) ?? null
    if (active === null || active.enabled === false) return null
    const auth = typeof active.username === 'string' && active.username !== ''
      ? `${encodeURIComponent(active.username)}${typeof active.password === 'string' ? `:${encodeURIComponent(active.password)}` : ''}@`
      : ''
    return `${active.protocol}://${auth}${active.hostname}:${active.port}`
  }

  /**
   * Bring bili's config in line with the wanted proxy. Calls coalesce: a burst
   * of switches results in one trailing write with the newest value.
   */
  sync(state) {
    this.desired = this.desiredProxy(state)
    if (this.busy !== null) {
      this.pending = true
      return this.busy
    }
    this.busy = (async () => {
      try {
        do {
          this.pending = false
          await this.write(this.desired)
        } while (this.pending)
      } finally {
        this.busy = null
      }
    })()
    return this.busy
  }

  async write(proxy) {
    if (this.origins.size === 0) {
      this.applied = null
      return
    }
    if (proxy === this.applied) return
    const ports = new Set([...this.origins.values()].map((entry) => entry.port))
    for (const port of ports) {
      try {
        await this.writeFor(port, proxy)
        this.applied = proxy
        this.lastError = null
      } catch (error) {
        this.lastError = describe(error)
        this.log(`could not ${proxy === null ? 'clear' : 'set'} the ACP egress proxy: ${this.lastError}`)
      }
    }
  }

  async writeFor(port, proxy) {
    const base = `http://127.0.0.1:${port}`
    const state = await this.adminGet(`${base}/__bili/config`)
    if (state === null) throw new Error(`no ACP config endpoint on ${base}`)
    const file = typeof state.path === 'string' && state.path !== '' ? state.path : null
    if (file === null) throw new Error('ACP config endpoint did not report a config file path')

    let document = {}
    let mode = 0o600
    try {
      const text = await fsp.readFile(file, 'utf8')
      document = JSON.parse(text)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      mode = (await fsp.stat(file)).mode & 0o777
    } catch {
      /* a missing file gets the default mode */
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) document = {}
    if (typeof document.providers !== 'object' || document.providers === null || Array.isArray(document.providers)) {
      document.providers = {}
    }

    const mine = [...this.origins.entries()].filter(([, entry]) => entry.port === port)
    for (const [origin, entry] of mine) {
      const existing = document.providers[origin]
      if (proxy === null) {
        if (!entry.touched) continue
        if (entry.created === true) {
          if (typeof existing === 'object' && existing !== null) {
            delete existing.proxy
            if (Object.keys(existing).length === 0) delete document.providers[origin]
          }
        } else if (typeof existing === 'object' && existing !== null) {
          if (entry.previous === undefined) delete existing.proxy
          else existing.proxy = entry.previous
        }
        continue
      }
      if (!entry.touched) {
        entry.previous = typeof existing?.proxy === 'string' ? existing.proxy : undefined
        entry.created = existing === undefined || existing === null
        entry.touched = true
      }
      const next = typeof existing === 'object' && existing !== null ? { ...existing } : {}
      next.proxy = proxy
      document.providers[origin] = next
    }

    const text = `${JSON.stringify(document, null, 2)}\n`
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(tmp, text, { mode })
    await fsp.rename(tmp, file)
    // `/config/reload` is the documented apply path for a config file edit.
    await this.adminGet(`${base}/__bili/config/reload`, { method: 'POST' }).catch(() => {})
  }

  async adminGet(url, init = {}) {
    let response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      })
    } catch {
      return null
    }
    if (!response.ok) return null
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  /** Put every endpoint back the way it was found. */
  async restore() {
    this.desired = null
    if (this.applied === null) return
    try {
      await this.write(null)
    } catch (error) {
      this.log(`could not restore the ACP egress proxy: ${describe(error)}`)
    }
    this.applied = null
  }
}
