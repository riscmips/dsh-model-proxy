import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  DEFAULT_BYPASS,
  createProxyFetch,
  fetchViaProxy,
  isBypassed,
  normalizeProxy,
  probeProxy,
  proxyAddress,
  routeFor,
} from '../lib/proxy-fetch.js'

/**
 * The TLS fixture is generated on demand instead of being committed: a private
 * key does not belong in the repository, and a throwaway localhost certificate
 * is all that is needed to prove the CONNECT tunnel performs a real handshake.
 */
function selfSignedCert() {
  const dir = new URL('./.tmp-test/certs/', import.meta.url)
  const cert = new URL('cert.pem', dir)
  const key = new URL('key.pem', dir)
  try {
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      fs.mkdirSync(dir, { recursive: true })
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key.pathname, '-out', cert.pathname,
        '-days', '3650', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ], { stdio: 'ignore' })
    }
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) }
  } catch {
    return null
  }
}

const CERTS = selfSignedCert()
const CERT = CERTS?.cert
const KEY = CERTS?.key

/** Skips a TLS test when no certificate could be generated on this machine. */
function needsCerts(t) {
  if (CERTS !== null) return false
  t.skip('openssl is unavailable, so no TLS fixture could be generated')
  return true
}

/** An upstream origin server that echoes what it received. */
function origin({ tls: useTls = false } = {}) {
  const seen = []
  const handler = (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ url: req.url, method: req.method, headers: req.headers, body })
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        setTimeout(() => {
          res.write('data: two\n\n')
          res.end()
        }, 30)
        return
      }
      const payload = Buffer.from(JSON.stringify({ url: req.url, method: req.method, body }), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) })
      res.end(payload)
    })
  }
  const server = useTls ? https.createServer({ cert: CERT, key: KEY }, handler) : http.createServer(handler)
  return { server, seen }
}

/**
 * A forwarding proxy that speaks both dialects we support: absolute-form for
 * plain HTTP and CONNECT for TLS. It records the Proxy-Authorization header so
 * the auth path is covered rather than assumed.
 */
function forwardProxy({ requireAuth = null } = {}) {
  const seen = []
  const authorized = (req) => {
    if (requireAuth === null) return true
    const header = req.headers['proxy-authorization'] ?? ''
    const expected = `Basic ${Buffer.from(`${requireAuth.username}:${requireAuth.password}`).toString('base64')}`
    return header === expected
  }
  const server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' })
      res.end()
      return
    }
    seen.push({ kind: 'absolute-form', url: req.url, auth: req.headers['proxy-authorization'] ?? null })
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('not absolute-form')
      return
    }
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end('upstream failed')
    })
    req.pipe(upstream)
  })
  server.on('connect', (req, socket, head) => {
    if (!authorized(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    seen.push({ kind: 'connect', url: req.url, auth: req.headers['proxy-authorization'] ?? null })
    const [host, port] = String(req.url).split(':')
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  return { server, seen }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('normalizeProxy accepts a URL and a field set', () => {
  assert.deepEqual(normalizeProxy({ url: 'http://user:p%40ss@proxy.example:8080' }), {
    protocol: 'http',
    hostname: 'proxy.example',
    port: 8080,
    username: 'user',
    password: 'p@ss',
  })
  assert.deepEqual(normalizeProxy({ protocol: 'https', host: 'proxy.example', port: '3128' }), {
    protocol: 'https',
    hostname: 'proxy.example',
    port: 3128,
  })
  assert.equal(normalizeProxy({ url: 'proxy.example' }).port, 80)
  assert.equal(normalizeProxy({ protocol: 'https', host: 'p.example' }).port, 443)
  assert.throws(() => normalizeProxy({ url: 'socks5://p.example:1080' }), /SOCKS/)
  assert.throws(() => normalizeProxy({ host: 'p.example', port: 99999 }), /invalid proxy port/)
  assert.throws(() => normalizeProxy({}), /required/)
  assert.equal(proxyAddress({ hostname: 'p.example', port: 8080 }), 'p.example:8080')
})

test('isBypassed matches exact, suffix and wildcard entries', () => {
  assert.equal(isBypassed('localhost', DEFAULT_BYPASS), true)
  assert.equal(isBypassed('api.corp.local', DEFAULT_BYPASS), true)
  assert.equal(isBypassed('api.deepseek.com', DEFAULT_BYPASS), false)
  assert.equal(isBypassed('a.b.example.com', ['example.com']), true)
  assert.equal(isBypassed('example.com.evil.test', ['example.com']), false)
  assert.equal(isBypassed('anything', ['*']), true)
  assert.equal(isBypassed('[::1]', ['::1']), true)
})

test('routeFor honours the switch, the active id and loopback', () => {
  const proxy = { id: 'p1', hostname: 'proxy.example', port: 8080, protocol: 'http' }
  const base = { enabled: true, activeId: 'p1', proxies: [proxy], bypass: [], bypassLoopback: true }
  assert.equal(routeFor('https://api.deepseek.com/v1/messages', base), proxy)
  assert.equal(routeFor('https://api.deepseek.com/v1/messages', { ...base, enabled: false }), null)
  assert.equal(routeFor('https://api.deepseek.com/v1/messages', { ...base, activeId: null }), null)
  assert.equal(routeFor('http://127.0.0.1:15721/v1', base), null)
  assert.equal(routeFor('http://127.0.0.1:15721/v1', { ...base, bypassLoopback: false }), proxy)
  assert.equal(routeFor('https://api.deepseek.com/v1', { ...base, bypass: ['deepseek.com'] }), null)
  assert.equal(routeFor('ftp://api.deepseek.com/', base), null)
  assert.equal(routeFor('https://api.deepseek.com/', { ...base, proxies: [{ ...proxy, enabled: false }] }), null)
})

test('plain HTTP goes through the proxy in absolute-form, with auth', async (t) => {
  const up = origin()
  const target = await listen(up.server)
  const proxy = forwardProxy({ requireAuth: { username: 'u', password: 'p' } })
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  const config = normalizeProxy({ url: `http://u:p@127.0.0.1:${proxyPort}` })
  const response = await fetchViaProxy(`http://127.0.0.1:${target}/hello?x=1`, { method: 'POST', body: 'payload' }, config)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.url, '/hello?x=1')
  assert.equal(payload.method, 'POST')
  assert.equal(payload.body, 'payload')
  assert.equal(proxy.seen.length, 1)
  assert.equal(proxy.seen[0].kind, 'absolute-form')
  assert.equal(proxy.seen[0].url, `http://127.0.0.1:${target}/hello?x=1`)
  assert.match(proxy.seen[0].auth, /^Basic /)
})

test('HTTPS goes through a CONNECT tunnel with a real TLS handshake', async (t) => {
  if (needsCerts(t)) return
  const up = origin({ tls: true })
  const target = await listen(up.server)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  const config = { ...normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` }), insecure: true }
  const response = await fetchViaProxy(`https://localhost:${target}/secure`, { method: 'GET' }, config)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { url: '/secure', method: 'GET', body: '' })
  assert.equal(proxy.seen.length, 1)
  assert.equal(proxy.seen[0].kind, 'connect')
  assert.equal(proxy.seen[0].url, `localhost:${target}`)
})

test('a streamed response arrives incrementally through the tunnel', async (t) => {
  if (needsCerts(t)) return
  const up = origin({ tls: true })
  const target = await listen(up.server)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  const config = { ...normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` }), insecure: true }
  const response = await fetchViaProxy(`https://localhost:${target}/stream`, {}, config)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const first = await reader.read()
  assert.match(decoder.decode(first.value), /data: one/)
  let rest = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    rest += decoder.decode(value)
  }
  assert.match(rest, /data: two/)
})

test('proxy authentication is enforced on both dialects', async (t) => {
  if (needsCerts(t)) return
  const up = origin({ tls: true })
  const target = await listen(up.server)
  const proxy = forwardProxy({ requireAuth: { username: 'u', password: 'p' } })
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  // Absolute-form: the proxy's 407 is a response the caller can inspect, which
  // is what fetch does, so it must not be turned into a thrown error.
  const plain = normalizeProxy({ url: `http://wrong:creds@127.0.0.1:${proxyPort}` })
  const answer = await fetchViaProxy(`http://127.0.0.1:${target}/nope`, {}, plain)
  assert.equal(answer.status, 407)
  await answer.body?.cancel().catch(() => {})

  // CONNECT: there is no response channel, so a refused tunnel must reject.
  const secure = { ...normalizeProxy({ url: `http://wrong:creds@127.0.0.1:${proxyPort}` }), insecure: true }
  await assert.rejects(
    () => fetchViaProxy(`https://localhost:${target}/nope`, {}, secure),
    /HTTP 407/,
  )
})

test('createProxyFetch delegates untouched when no proxy is selected', async (t) => {
  const up = origin()
  const target = await listen(up.server)
  const calls = []
  t.after(() => close(up.server))

  const realFetch = globalThis.fetch
  const wrapped = createProxyFetch({
    resolve: () => null,
    originalFetch: realFetch,
    onRequest: (event) => calls.push(event),
  })
  const response = await wrapped(`http://127.0.0.1:${target}/direct`, { method: 'GET' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { url: '/direct', method: 'GET', body: '' })
  assert.equal(calls.length, 0, 'delegated requests are not reported as proxied')
})

test('createProxyFetch routes through the proxy when one resolves', async (t) => {
  const up = origin()
  const target = await listen(up.server)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  const config = normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` })
  const events = []
  const wrapped = createProxyFetch({
    resolve: () => config,
    originalFetch: globalThis.fetch,
    onRequest: (event) => events.push(event),
  })
  const response = await wrapped(`http://127.0.0.1:${target}/via-proxy`)
  assert.equal(response.status, 200)
  assert.equal(events.length, 1)
  assert.equal(events[0].ok, true)
  assert.equal(proxy.seen.length, 1)
})

test('createProxyFetch accepts a Request object', async (t) => {
  const up = origin()
  const target = await listen(up.server)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  const config = normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` })
  const wrapped = createProxyFetch({ resolve: () => config, originalFetch: globalThis.fetch })
  const request = new Request(`http://127.0.0.1:${target}/from-request`, { method: 'POST', body: 'abc' })
  const response = await wrapped(request)
  assert.deepEqual(await response.json(), { url: '/from-request', method: 'POST', body: 'abc' })
})

test('redirects follow the fetch contract', async (t) => {
  const hop = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/end' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('landed')
  })
  const target = await listen(hop)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(hop), close(proxy.server)]))
  const config = normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` })

  const followed = await fetchViaProxy(`http://127.0.0.1:${target}/start`, {}, config)
  assert.equal(followed.status, 200)
  assert.equal(await followed.text(), 'landed')

  const manual = await fetchViaProxy(`http://127.0.0.1:${target}/start`, { redirect: 'manual' }, config)
  assert.equal(manual.status, 302)

  await assert.rejects(
    () => fetchViaProxy(`http://127.0.0.1:${target}/start`, { redirect: 'error' }, config),
    /redirect mode is "error"/,
  )
})

test('probeProxy reports reachability without throwing', async (t) => {
  const up = origin()
  const target = await listen(up.server)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(up.server), close(proxy.server)]))

  const good = await probeProxy(normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` }), {
    url: `http://127.0.0.1:${target}/probe`,
  })
  assert.equal(good.ok, true)
  assert.equal(good.status, 200)

  const bad = await probeProxy(normalizeProxy({ url: 'http://127.0.0.1:1' }), { url: 'http://127.0.0.1:9/', timeoutMs: 1500 })
  assert.equal(bad.ok, false)
  assert.ok(bad.error.length > 0)
})

test('an aborted request rejects with an AbortError', async (t) => {
  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200)
      res.end('late')
    }, 2000)
  })
  const target = await listen(slow)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([new Promise((resolve) => slow.close(resolve)), close(proxy.server)]))
  const config = normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` })

  const controller = new AbortController()
  const pending = fetchViaProxy(`http://127.0.0.1:${target}/slow`, { signal: controller.signal }, config)
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
})

test('buffered gzip responses are decoded like real fetch', async (t) => {
  const { gzipSync } = await import('node:zlib')
  const body = gzipSync(Buffer.from(JSON.stringify({ ok: true })))
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) })
    res.end(body)
  })
  const target = await listen(server)
  const proxy = forwardProxy()
  const proxyPort = await listen(proxy.server)
  t.after(() => Promise.all([close(server), close(proxy.server)]))
  const config = normalizeProxy({ url: `http://127.0.0.1:${proxyPort}` })
  const response = await fetchViaProxy(`http://127.0.0.1:${target}/gzip`, {}, config)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.deepEqual(await response.json(), { ok: true })
})
