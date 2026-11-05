/**
 * Dependency-free HTTP(S) forward-proxy transport for the Host process.
 *
 * The Host half of this bundle replaces `globalThis.fetch` with a wrapper that
 * resolves one runtime-switchable proxy per request. When no proxy is active —
 * or the target is loopback, or the host is on the bypass list — the wrapper
 * delegates to the original fetch, so the environment proxy installed at boot
 * keeps working unchanged.
 *
 * HTTPS targets are reached through an HTTP CONNECT tunnel that we terminate
 * ourselves with `node:tls`; plain HTTP targets are sent to the proxy in
 * absolute-form. Responses are re-exposed as WHATWG `Response` objects with a
 * real `ReadableStream` body, so streaming SSE consumers keep working.
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { isIP } from 'node:net'

/** Headers that only describe one hop and must never be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1)$/i

/** Hosts that are always dialled directly, whatever the active proxy says. */
export const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '*.local']

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** Turn a user-typed proxy (URL or field set) into the canonical stored shape. */
export function normalizeProxy(input = {}) {
  const raw = typeof input === 'object' && input !== null ? input : {}
  let parsed
  if (typeof raw.url === 'string' && raw.url.trim() !== '') {
    const text = raw.url.trim()
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  }
  const protocol = String(raw.protocol ?? parsed?.protocol?.replace(/:$/, '') ?? 'http').toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`unsupported proxy protocol "${protocol}": use http or https (SOCKS is not supported)`)
  }
  const hostname = String(raw.host ?? raw.hostname ?? parsed?.hostname ?? '').trim()
  if (hostname === '') throw new Error('proxy host is required')
  const port = Number(raw.port ?? (parsed?.port !== undefined && parsed.port !== '' ? parsed.port : protocol === 'https' ? 443 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid proxy port "${String(raw.port ?? '')}"`)
  let username = raw.username ?? (parsed?.username !== undefined ? decodeURIComponent(parsed.username) : undefined)
  let password = raw.password ?? (parsed?.password !== undefined ? decodeURIComponent(parsed.password) : undefined)
  username = typeof username === 'string' && username !== '' ? username : undefined
  password = typeof password === 'string' ? password : undefined
  return {
    protocol,
    hostname,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  }
}

/** `host:port` label used in logs and the UI. */
export function proxyAddress(proxy) {
  const host = proxy?.hostname ?? proxy?.host ?? ''
  const port = proxy?.port ?? ''
  return host === '' ? '' : `${host}:${port}`
}

/** Match a hostname against the bypass list (`host`, `*.suffix`, or `*`). */
export function isBypassed(hostname, bypass = []) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  for (const entry of bypass) {
    const pattern = String(entry ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (pattern === '') continue
    if (pattern === '*') return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      if (host.endsWith(suffix)) return true
      continue
    }
    if (host === pattern || host.endsWith(`.${pattern}`)) return true
  }
  return false
}

/**
 * Which proxy (if any) must carry this URL. `null` means "delegate to the
 * original fetch", which keeps the boot-time environment proxy in charge.
 */
export function routeFor(url, state) {
  if (state === null || typeof state !== 'object') return null
  if (state.enabled !== true) return null
  if (typeof state.activeId !== 'string' || state.activeId === '') return null
  let target
  try {
    target = new URL(String(url))
  } catch {
    return null
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
  const proxy = Array.isArray(state.proxies) ? state.proxies.find((entry) => entry?.id === state.activeId) : undefined
  if (proxy === undefined || proxy === null || proxy.enabled === false) return null
  if (LOOPBACK.test(target.hostname) && state.bypassLoopback !== false) return null
  const bypass = [...(state.bypassLoopback === false ? [] : DEFAULT_BYPASS), ...(Array.isArray(state.bypass) ? state.bypass : [])]
  if (isBypassed(target.hostname, bypass)) return null
  return proxy
}

function abortError() {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

function linkSignal(signal) {
  const controller = new AbortController()
  let detach = () => {}
  if (signal !== undefined && signal !== null) {
    if (signal.aborted === true) controller.abort(signal.reason)
    else {
      const onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      detach = () => signal.removeEventListener('abort', onAbort)
    }
  }
  return { signal: controller.signal, abort: (reason) => controller.abort(reason), detach }
}

function authorizationFor(proxy) {
  const username = proxy?.username
  const password = proxy?.password
  if (typeof username !== 'string' || username === '') return undefined
  const token = Buffer.from(`${username}:${typeof password === 'string' ? password : ''}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

/**
 * Normalize a fetch body into either a buffer we can replay for redirects or a
 * stream we can pipe. Anything exotic (FormData, Blob) is normalized through a
 * throwaway `Request`, which is what real fetch does internally.
 */
async function readRequestBody(init) {
  const body = init?.body
  if (body === undefined || body === null) return { buffer: null, stream: null }
  if (typeof body === 'string') return { buffer: Buffer.from(body, 'utf8'), stream: null }
  if (Buffer.isBuffer(body)) return { buffer: body, stream: null }
  if (body instanceof Uint8Array) return { buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength), stream: null }
  if (body instanceof ArrayBuffer) return { buffer: Buffer.from(new Uint8Array(body)), stream: null }
  if (body instanceof URLSearchParams) {
    return { buffer: Buffer.from(body.toString(), 'utf8'), stream: null, contentType: 'application/x-www-form-urlencoded;charset=UTF-8' }
  }
  if (typeof body.getReader === 'function') return { buffer: null, stream: body }
  const probe = new Request('http://request-body.invalid/', { method: 'POST', body, duplex: 'half' })
  const buffer = Buffer.from(await probe.arrayBuffer())
  return { buffer, stream: null, contentType: probe.headers.get('content-type') ?? undefined }
}

function sanitizeHeaders(initHeaders, { forTunnel }) {
  const headers = new Headers(initHeaders ?? undefined)
  for (const name of [...headers.keys()]) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === 'host') headers.delete(name)
  }
  if (forTunnel !== true && !headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br')
  return headers
}

function headerObject(headers) {
  const out = {}
  for (const [name, value] of headers.entries()) out[name] = value
  return out
}

/** Open an HTTP CONNECT tunnel to `hostname:port` through `proxy`. */
function openTunnel(proxy, hostname, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const mod = proxy.protocol === 'https' ? https : http
    const headers = { host: `${hostname}:${port}` }
    const authorization = authorizationFor(proxy)
    if (authorization !== undefined) headers['proxy-authorization'] = authorization
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = mod.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${hostname}:${port}`,
      headers,
      agent: false,
      timeout: timeoutMs,
      rejectUnauthorized: proxy.insecure !== true,
    })
    const onAbort = () => {
      request.destroy()
      fail(abortError())
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.once('connect', (response, socket, head) => {
      signal?.removeEventListener('abort', onAbort)
      if (response.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`proxy CONNECT refused with HTTP ${response.statusCode}`))
        return
      }
      settled = true
      socket.setTimeout(0)
      if (head !== undefined && head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    request.once('timeout', () => {
      request.destroy()
      fail(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`))
    })
    request.once('error', (error) => fail(error))
    request.end()
  })
}

/** Terminate TLS on top of an established tunnel socket. */
function secureSocket(socket, hostname, proxy, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: isIP(hostname) === 0 ? hostname : undefined,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: proxy.insecure !== true,
    })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      secure.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error(`TLS handshake timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    const onAbort = () => fail(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    secure.once('secureConnect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      secure.setTimeout(0)
      resolve(secure)
    })
    secure.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
  })
}

/** An agent whose only connection is a socket we already own. */
function agentOver(socket) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = () => socket
  return agent
}

function requestOverSocket(socket, target, method, path, headers) {
  const request = http.request({
    host: target.hostname,
    port: Number(target.port || 443),
    method,
    path,
    headers: headerObject(headers),
    agent: agentOver(socket),
  })
  return request
}

function requestToProxy(proxy, method, absoluteUrl, headers, timeoutMs) {
  const mod = proxy.protocol === 'https' ? https : http
  const authorization = authorizationFor(proxy)
  if (authorization !== undefined) headers.set('proxy-authorization', authorization)
  return mod.request({
    host: proxy.hostname,
    port: proxy.port,
    method,
    path: absoluteUrl,
    headers: headerObject(headers),
    agent: false,
    timeout: timeoutMs,
    rejectUnauthorized: proxy.insecure !== true,
  })
}

function decompressorFor(encoding) {
  const value = String(encoding ?? '').toLowerCase().trim()
  if (value === '' || value === 'identity') return null
  if (value === 'gzip' || value === 'x-gzip') return zlib.createGunzip()
  if (value === 'deflate') return zlib.createInflate()
  if (value === 'br') return zlib.createBrotliDecompress()
  return null
}

function buildResponse(res, requestUrl) {
  const status = Number(res.statusCode ?? 0) || 502
  const headers = new Headers()
  for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) {
    const name = res.rawHeaders[index]
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    try {
      headers.append(name, res.rawHeaders[index + 1])
    } catch {
      /* a header value the platform refuses is not worth failing the call */
    }
  }
  const noBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200)
  let body = null
  if (!noBody) {
    const decoder = decompressorFor(headers.get('content-encoding'))
    if (decoder === null) {
      body = Readable.toWeb(res)
    } else {
      // Match real fetch: the caller sees decoded bytes and no encoding header.
      headers.delete('content-encoding')
      headers.delete('content-length')
      body = Readable.toWeb(res.pipe(decoder))
    }
  } else {
    res.resume()
  }
  const response = new Response(body, { status, statusText: res.statusMessage ?? '', headers })
  Object.defineProperty(response, 'url', { value: requestUrl, configurable: true, enumerable: true })
  Object.defineProperty(response, 'redirected', { value: false, configurable: true, enumerable: true })
  return response
}

/** Send one request through the proxy and resolve with a `Response`. */
function onceThroughProxy({ target, method, headers, body, proxy, connectTimeoutMs, headersTimeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const onAbort = () => fail(abortError())
    if (signal?.aborted === true) {
      fail(abortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const path = `${target.pathname === '' ? '/' : target.pathname}${target.search}`
    const hostname = target.hostname.replace(/^\[|\]$/g, '')
    const port = Number(target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : target.port)

    const send = (request, cleanup) => {
      request.once('response', (res) => {
        signal?.removeEventListener('abort', onAbort)
        request.setTimeout(0)
        res.setTimeout(0)
        if (settled) {
          res.destroy()
          cleanup?.()
          return
        }
        settled = true
        // The tunnel socket belongs to the body until the body is done: tearing
        // it down here would cut a streamed answer off at the first chunk.
        res.once('close', () => cleanup?.())
        let response
        try {
          response = buildResponse(res, target.href)
        } catch (error) {
          res.destroy()
          cleanup?.()
          reject(error)
          return
        }
        resolve(response)
      })
      request.once('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        cleanup?.()
        fail(error)
      })
      request.setTimeout(headersTimeoutMs, () => {
        request.destroy(new Error(`proxy upstream timed out after ${headersTimeoutMs}ms`))
      })
      if (body.stream !== null) {
        const reader = body.stream.getReader()
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (!request.write(value)) await once(request, 'drain')
            }
            request.end()
          } catch (error) {
            request.destroy(error)
          }
        })()
      } else if (body.buffer !== null) {
        request.end(body.buffer)
      } else {
        request.end()
      }
    }

    if (target.protocol === 'https:') {
      openTunnel(proxy, hostname, port, connectTimeoutMs, signal)
        .then((tunnel) => secureSocket(tunnel, hostname, proxy, connectTimeoutMs, signal))
        .then((secure) => {
          if (settled) {
            secure.destroy()
            return
          }
          send(requestOverSocket(secure, target, method, path, headers), () => secure.destroy())
        })
        .catch((error) => {
          signal?.removeEventListener('abort', onAbort)
          fail(error)
        })
    } else {
      send(requestToProxy(proxy, method, target.href, headers, connectTimeoutMs), undefined)
    }
  })
}

/**
 * Proxy one request, following redirects the way fetch does (the model clients
 * themselves pass `redirect: 'error'`, so this mostly serves other Host traffic).
 */
export async function fetchViaProxy(targetUrl, init, proxy, options = {}) {
  const connectTimeoutMs = Number(options.connectTimeoutMs ?? 30000)
  const headersTimeoutMs = Number(options.headersTimeoutMs ?? 120000)
  const maxRedirects = Number(options.maxRedirects ?? 5)
  const signal = init?.signal ?? undefined
  const redirectMode = init?.redirect ?? 'follow'
  let target = new URL(String(targetUrl))
  let method = String(init?.method ?? (init?.body !== undefined && init?.body !== null ? 'POST' : 'GET')).toUpperCase()
  let body = await readRequestBody(init ?? {})
  const baseHeaders = sanitizeHeaders(init?.headers, { forTunnel: false })
  if (body.contentType !== undefined && !baseHeaders.has('content-type')) baseHeaders.set('content-type', body.contentType)

  for (let redirects = 0; ; redirects += 1) {
    const headers = new Headers(baseHeaders)
    if (body.buffer !== null && !headers.has('content-length')) headers.set('content-length', String(body.buffer.length))
    if (body.stream !== null) headers.delete('content-length')
    const response = await onceThroughProxy({
      target,
      method,
      headers,
      body,
      proxy,
      connectTimeoutMs,
      headersTimeoutMs,
      signal,
    })
    const location = response.headers.get('location')
    if (!REDIRECT_STATUS.has(response.status) || location === null) return response
    await response.body?.cancel().catch(() => {})
    if (redirectMode === 'error') throw new TypeError('fetch failed: redirect mode is "error"')
    if (redirectMode === 'manual') return response
    if (redirects >= maxRedirects) throw new TypeError('fetch failed: too many redirects')
    if (body.stream !== null) throw new TypeError('fetch failed: cannot replay a streaming body across a redirect')
    target = new URL(location, target)
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET'
      body = { buffer: null, stream: null }
      baseHeaders.delete('content-type')
      baseHeaders.delete('content-length')
      continue
    }
  }
}

/**
 * Wrap the platform fetch. `resolve(url)` returns the proxy to use or `null`;
 * everything else is delegated untouched to the original implementation.
 */
export function createProxyFetch({ resolve, originalFetch, log = () => {}, onRequest = () => {} }) {
  const base = typeof originalFetch === 'function' ? originalFetch : globalThis.fetch
  const proxyFetch = async function proxyFetch(input, init) {
    let url
    let effectiveInit = init
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.href
    } else if (input !== null && typeof input === 'object' && typeof input.url === 'string') {
      // A Request: fold it into a plain init so the manual transport sees one shape.
      const request = new Request(input, init)
      url = request.url
      effectiveInit = {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        redirect: request.redirect,
        ...(request.body === null ? {} : { duplex: 'half' }),
      }
    } else {
      return base(input, init)
    }
    let proxy = null
    try {
      proxy = resolve(url)
    } catch {
      proxy = null
    }
    if (proxy === null) return base(input, init)
    try {
      const response = await fetchViaProxy(url, effectiveInit ?? {}, proxy, {})
      onRequest({ url, proxy, ok: true, status: response.status })
      return response
    } catch (error) {
      onRequest({ url, proxy, ok: false, error })
      log(`proxy request failed via ${proxyAddress(proxy)}: ${error?.message ?? error}`)
      if (error?.name === 'AbortError') throw error
      throw new TypeError(`fetch failed: ${error?.message ?? error}`, { cause: error })
    }
  }
  return proxyFetch
}

/** One connectivity probe used by the UI's Test button. */
export async function probeProxy(proxy, { url = 'https://api.deepseek.com/', timeoutMs = 12000 } = {}) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timed out')), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchViaProxy(url, { method: 'GET', redirect: 'manual', signal: controller.signal }, proxy, {
      connectTimeoutMs: timeoutMs,
      headersTimeoutMs: timeoutMs,
      maxRedirects: 0,
    })
    await response.body?.cancel().catch(() => {})
    return { ok: true, status: response.status, latencyMs: Date.now() - started, url }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, url, error: error?.message ?? String(error) }
  } finally {
    clearTimeout(timer)
  }
}
