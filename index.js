/**
 * Model proxy — Host half.
 *
 * Responsibilities, in the order they matter:
 *
 * 1. Own the runtime-switchable proxy list (`lib/store.js`).
 * 2. Install a `globalThis.fetch` wrapper once, through `ctx.effect`, so every
 *    model call made by the LLM adapters (and any other Host traffic) is routed
 *    through the active proxy without the adapters knowing about it. Requests
 *    that no proxy should carry are delegated to the original fetch, so the
 *    environment proxy resolved at boot keeps working.
 * 3. Answer a tiny same-origin JSON API under `/dsh-model-proxy`, used by the
 *    Web UI to switch proxies in the middle of a conversation.
 *
 * The wrapper is installed whether or not a Web server exists: `ctx.inject`
 * keeps the HTTP surface optional, but the transport is the point of the
 * plugin and must not depend on the GUI being present.
 */
import { createProxyFetch, normalizeProxy, probeProxy, proxyAddress, routeFor } from './lib/proxy-fetch.js'
import { AcpBridge } from './lib/acp-bridge.js'
import { ProxyStore, publicEntry, publicState } from './lib/store.js'

const PREFIX = '/dsh-model-proxy'
const ACTION_HEADER = 'x-dsh-model-proxy'
const INSTALL_KEY = Symbol.for('dsh.model-proxy.fetch')
const MAX_BODY = 64 * 1024
const STATS_LIMIT = 40
const LOCAL_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)(?::\d{1,5})?$/

function log(message) {
  try {
    console.warn(`[model-proxy] ${message}`)
  } catch {
    /* nothing sensible to do if even logging throws */
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function hostOf(req) {
  const site = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : ''
  return site
}

/**
 * Mutating calls need a same-origin page plus our own header: a cross-site
 * form post cannot set one, so this blocks CSRF without a token store. GET
 * answers the same way minus the header, which keeps `curl` on loopback usable.
 */
function allowed(req, { mutating }) {
  try {
    const site = hostOf(req)
    if (site === '') return false
    if (!LOCAL_ADDRESS.test(site)) return false
    const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin.trim().toLowerCase() : ''
    if (origin === 'null') return false
    if (origin !== '') {
      let originSite = ''
      try {
        originSite = new URL(origin).host.toLowerCase()
      } catch {
        return false
      }
      if (originSite !== site) return false
    }
    if (mutating) {
      const header = req?.headers?.[ACTION_HEADER]
      if (typeof header !== 'string' || header === '') return false
      const type = typeof req?.headers?.['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
      if (!type.startsWith('application/json')) return false
    }
    return true
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

function describeError(error) {
  return error?.message !== undefined ? String(error.message) : String(error)
}

export function apply(ctx, config = {}) {
  // `enabled` and `activeId` from the bundle config act as the initial state of
  // a fresh install; once the file exists the file wins, because the UI is the
  // real switch and a config file edit must not silently undo a click.
  const storeConfig = typeof config === 'object' && config !== null ? config : {}
  const store = new ProxyStore({ log })
  store.load()
  if (store.state.proxies.length === 0 && Array.isArray(storeConfig.proxies)) {
    try {
      for (const entry of storeConfig.proxies) store.upsert(entry)
      if (typeof storeConfig.activeId === 'string') store.patch({ activeId: storeConfig.activeId })
    } catch (error) {
      log(`ignoring bundle proxy config: ${describeError(error)}`)
    }
  }

  // The ACP bridge needs an unwrapped fetch: going through the routing wrapper
  // would send its own loopback admin calls back through `routeFor`.
  const bridge = new AcpBridge({ log, fetchImpl: (input, init) => globalThis.fetch(input, init) })

  const stats = []
  const counters = { total: 0, ok: 0, failed: 0, lastAt: null, lastError: null }

  function recordRequest(event) {
    counters.total += 1
    counters.lastAt = new Date().toISOString()
    if (event.ok) counters.ok += 1
    else {
      counters.failed += 1
      counters.lastError = describeError(event.error)
    }
    stats.unshift({
      at: counters.lastAt,
      host: safeHost(event.url),
      proxy: proxyAddress(event.proxy),
      ok: event.ok,
      status: event.status ?? null,
      error: event.ok ? null : describeError(event.error),
    })
    if (stats.length > STATS_LIMIT) stats.length = STATS_LIMIT
  }

  function snapshot() {
    return publicState(store.get(), {
      counters: { ...counters },
      recent: stats.slice(0, 12),
      bridge: { ...bridge.info(), enabled: store.get().bridgeAcp !== false },
    })
  }

  // ---------------------------------------------------------------------
  // Transport install
  // ---------------------------------------------------------------------
  ctx.effect(() => {
    const previous = globalThis[INSTALL_KEY]
    if (previous !== undefined && typeof previous.dispose === 'function') {
      // A second load (HMR, or the same bundle mounted twice) replaces the old
      // wrapper instead of stacking two tunnels on one request.
      try {
        previous.dispose()
      } catch {
        /* the old wrapper's own teardown is not our problem */
      }
    }
    const original = globalThis.fetch
    bridge.fetchImpl = original
    const routed = createProxyFetch({
      resolve: (url) => routeFor(url, store.get()),
      originalFetch: original,
      log,
      onRequest: recordRequest,
    })
    // Learning an endpoint has to finish before the call is sent, otherwise the
    // first request to a host that only resolves at the proxy would still fail.
    const wrapped = async (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input?.url ?? input
        if (bridge.needsLearn(url)) await bridge.learn(url, store.get())
      } catch {
        /* a bridge hiccup must never block the model call itself */
      }
      return routed(input, init)
    }
    globalThis.fetch = wrapped
    const handle = {
      dispose: () => {
        if (globalThis.fetch === wrapped) globalThis.fetch = original
        if (globalThis[INSTALL_KEY] === handle) delete globalThis[INSTALL_KEY]
      },
    }
    globalThis[INSTALL_KEY] = handle
    const unsubscribe = store.subscribe((state) => {
      bridge.sync(state).catch(() => {})
    })
    return () => {
      try {
        unsubscribe()
      } catch {
        /* the store may already be gone */
      }
      bridge.restore().catch(() => {})
      handle.dispose()
    }
  }, 'model-proxy: fetch transport')

  // ---------------------------------------------------------------------
  // HTTP surface (optional: only when a Web server is mounted)
  // ---------------------------------------------------------------------
  const mount = (webServer) => {
    const routes = new Map()

    const route = (method, path, handler) => {
      routes.set(`${method} ${path}`, handler)
    }

    route('GET', '/state', async (req, res) => {
      sendJson(res, 200, { ok: true, state: snapshot() })
    })

    route('POST', '/state', async (req, res) => {
      const body = await readBody(req)
      store.patch({
        enabled: body.enabled,
        activeId: body.activeId,
        bypass: body.bypass,
        bypassLoopback: body.bypassLoopback,
        bridgeAcp: body.bridgeAcp,
      })
      sendJson(res, 200, { ok: true, state: snapshot() })
    })

    route('POST', '/proxies', async (req, res) => {
      const body = await readBody(req)
      store.upsert(body)
      const created = body.id === undefined || body.id === null || body.id === '' ? store.get().proxies.at(-1) : null
      sendJson(res, 200, {
        ok: true,
        state: snapshot(),
        ...(created === null ? {} : { proxy: publicEntry(created) }),
      })
    })

    route('POST', '/proxies/remove', async (req, res) => {
      const body = await readBody(req)
      store.remove(typeof body.id === 'string' ? body.id : '')
      sendJson(res, 200, { ok: true, state: snapshot() })
    })

    route('POST', '/proxies/test', async (req, res) => {
      const body = await readBody(req)
      const state = store.get()
      let candidate = null
      if (typeof body.id === 'string' && body.id !== '') {
        candidate = state.proxies.find((entry) => entry.id === body.id) ?? null
        if (candidate === null) {
          sendJson(res, 404, { ok: false, error: 'proxy not found' })
          return
        }
        if (typeof body.password === 'string' && body.password !== '') candidate = { ...candidate, password: body.password }
      } else {
        candidate = normalizeProxy(body)
      }
      const result = await probeProxy(candidate, {
        url: typeof body.testUrl === 'string' && body.testUrl !== '' ? body.testUrl : undefined,
        timeoutMs: Number.isFinite(Number(body.timeoutMs)) ? Number(body.timeoutMs) : undefined,
      })
      sendJson(res, 200, { ok: true, probe: { ...result, proxy: proxyAddress(candidate) } })
    })

    route('POST', '/bridge/resync', async (req, res) => {
      await bridge.sync(store.get())
      sendJson(res, 200, { ok: true, state: snapshot() })
    })

    route('GET', '/stats', async (req, res) => {
      sendJson(res, 200, { ok: true, counters: { ...counters }, recent: stats })
    })

    const handler = (req, res) => {
      const fail = (error) => {
        if (res?.headersSent !== true) sendJson(res, 500, { ok: false, error: describeError(error) })
        else if (typeof res.end === 'function' && res.writableEnded !== true) res.end()
      }
      let method = 'GET'
      let pathname = PREFIX
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        method = String(req.method ?? 'GET').toUpperCase()
        pathname = url.pathname
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad request' })
        return
      }
      const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname
      const target = rest === '' ? '/state' : rest.replace(/\/+$/, '')
      const mutating = method !== 'GET' && method !== 'HEAD'
      if (!allowed(req, { mutating })) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      const match = routes.get(`${method} ${target}`)
      if (match === undefined) {
        sendJson(res, 404, { ok: false, error: `no route for ${method} ${target}` })
        return
      }
      try {
        const answer = match(req, res)
        if (answer !== null && typeof answer === 'object' && typeof answer.then === 'function') answer.catch(fail)
      } catch (error) {
        fail(error)
      }
    }

    let dispose = null
    try {
      dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
    } catch (error) {
      log(`cannot register ${PREFIX}: ${describeError(error)}`)
      return () => {}
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* the server may already be gone */
      }
    }
  }

  try {
    // `inject` hands the callback a scoped context, not the bare service.
    ctx.inject(['webServer'], (scope) => mount(scope?.webServer ?? scope))
  } catch (error) {
    log(`no web server available: ${describeError(error)}`)
  }
}

function safeHost(url) {
  try {
    return new URL(String(url)).host
  } catch {
    return String(url)
  }
}
