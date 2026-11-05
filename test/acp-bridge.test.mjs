import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AcpBridge, parseWrapped } from '../lib/acp-bridge.js'

const ROOT = path.join(process.cwd(), '.tmp-test')

async function scaffold() {
  await fsp.mkdir(ROOT, { recursive: true })
  const dir = await fsp.mkdtemp(path.join(ROOT, 'bridge-'))
  const file = path.join(dir, 'billion-context.json')
  await fsp.writeFile(file, `${JSON.stringify({ providers: {}, compress: 'on' }, null, 2)}\n`)
  return { dir, file }
}

/** A stand-in for bili's loopback admin surface. */
async function admin(file, counter) {
  const server = http.createServer((req, res) => {
    const send = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload))
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length })
      res.end(body)
    }
    if (req.url === '/__bili/config' && req.method === 'GET') {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      send(200, { path: file, providers: raw.providers ?? {}, upstreamProxy: null, upstreamProxyMode: 'direct' })
      return
    }
    if (req.url === '/__bili/config/reload' && req.method === 'POST') {
      counter.reloads += 1
      send(200, { ok: true, count: 0, routes: [] })
      return
    }
    send(404, { error: { type: 'not_found' } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

function state(port, { enabled = true, bridgeAcp = true, proxy = 'http://192.168.1.100:8118' } = {}) {
  const url = new URL(proxy)
  return {
    enabled,
    bridgeAcp,
    activeId: 'p1',
    bypassLoopback: true,
    bypass: [],
    proxies: [{ id: 'p1', enabled: true, protocol: url.protocol.slice(0, -1), hostname: url.hostname, port: Number(url.port) }],
  }
}

test('parseWrapped finds the inner origin of a wrapped endpoint', () => {
  assert.deepEqual(parseWrapped('http://127.0.0.1:18787/bili/https://lab.iwhalecloud.com/gpt-proxy/v1/chat'), {
    port: 18787,
    origin: 'https://lab.iwhalecloud.com',
    inner: 'https://lab.iwhalecloud.com/gpt-proxy/v1/chat',
    loopback: false,
  })
  assert.equal(parseWrapped('https://api.deepseek.com/'), null)
  assert.equal(parseWrapped('http://127.0.0.1:18787/health'), null)
})

test('a loopback inner origin is never bridged', async () => {
  const bridge = new AcpBridge({})
  const wrapped = 'http://127.0.0.1:18787/bili/http://127.0.0.1:15721/v1/messages?beta=true'
  assert.equal(parseWrapped(wrapped).loopback, true)
  assert.equal(bridge.needsLearn(wrapped), false)
  await bridge.learn(wrapped, state(18787))
  assert.deepEqual(bridge.info().origins, [], 'the local gateway must stay direct')
})

test('learning a wrapped endpoint writes a per-route proxy and reloads', async () => {
  const { file } = await scaffold()
  const counter = { reloads: 0 }
  const { port, close } = await admin(file, counter)
  try {
    const bridge = new AcpBridge({})
    assert.equal(bridge.needsLearn(`http://127.0.0.1:${port}/bili/https://lab.iwhalecloud.com/x`), true)
    await bridge.learn(`http://127.0.0.1:${port}/bili/https://lab.iwhalecloud.com/x`, state(port))
    const document = JSON.parse(await fsp.readFile(file, 'utf8'))
    assert.equal(document.providers['https://lab.iwhalecloud.com'].proxy, 'http://192.168.1.100:8118')
    assert.equal(document.compress, 'on', 'unrelated keys must survive')
    assert.equal(counter.reloads, 1)
    assert.deepEqual(bridge.info().origins, ['https://lab.iwhalecloud.com'])
    assert.equal(bridge.info().applied, 'http://192.168.1.100:8118')
    await close()
  } finally {
    await close().catch(() => {})
  }
})

test('the previous per-route value is restored, and a created route is removed', async () => {
  const { file } = await scaffold()
  const counter = { reloads: 0 }
  const { port, close } = await admin(file, counter)
  const wrapped = `http://127.0.0.1:${port}/bili/https://lab.iwhalecloud.com/x`
  try {
    const bridge = new AcpBridge({})
    await bridge.learn(wrapped, state(port))
    await bridge.restore()
    let document = JSON.parse(await fsp.readFile(file, 'utf8'))
    assert.equal(document.providers['https://lab.iwhalecloud.com'], undefined, 'created route is removed again')

    await fsp.writeFile(file, `${JSON.stringify({ providers: { 'https://lab.iwhalecloud.com': { proxy: 'http://10.0.0.1:7890', keep: 1 } } })}\n`)
    const second = new AcpBridge({})
    await second.learn(wrapped, state(port))
    document = JSON.parse(await fsp.readFile(file, 'utf8'))
    assert.equal(document.providers['https://lab.iwhalecloud.com'].proxy, 'http://192.168.1.100:8118')
    await second.restore()
    document = JSON.parse(await fsp.readFile(file, 'utf8'))
    assert.equal(document.providers['https://lab.iwhalecloud.com'].proxy, 'http://10.0.0.1:7890', 'original value comes back')
    assert.equal(document.providers['https://lab.iwhalecloud.com'].keep, 1)
  } finally {
    await close().catch(() => {})
  }
})

test('nothing is written while routing or the bridge is off', async () => {
  const { file } = await scaffold()
  const counter = { reloads: 0 }
  const { port, close } = await admin(file, counter)
  try {
    const bridge = new AcpBridge({})
    const wrapped = `http://127.0.0.1:${port}/bili/https://lab.iwhalecloud.com/x`
    await bridge.learn(wrapped, state(port, { enabled: false }))
    await bridge.learn(wrapped, state(port, { bridgeAcp: false }))
    const document = JSON.parse(await fsp.readFile(file, 'utf8'))
    assert.deepEqual(document.providers, {})
    assert.equal(bridge.info().applied, null)
  } finally {
    await close().catch(() => {})
  }
})

test('a missing admin endpoint is reported, never thrown at the caller', async () => {
  const bridge = new AcpBridge({})
  await bridge.learn('http://127.0.0.1:1/bili/https://lab.iwhalecloud.com/x', state(1))
  assert.match(bridge.info().lastError ?? '', /ACP/)
})

test('the bridge file keeps the mode it found', async () => {
  const { file } = await scaffold()
  await fsp.chmod(file, 0o640)
  const counter = { reloads: 0 }
  const { port, close } = await admin(file, counter)
  try {
    const bridge = new AcpBridge({})
    await bridge.learn(`http://127.0.0.1:${port}/bili/https://lab.iwhalecloud.com/x`, state(port))
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o640)
  } finally {
    await close().catch(() => {})
  }
})

test.after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {})
})
