import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A temporary DSH_HOME so a test never touches the real profile config. */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-proxy-'))
}

test('the Host half installs and restores the fetch wrapper', async (t) => {
  const home = tempHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  const { apply } = await import('../index.js')
  const before = globalThis.fetch
  const disposers = []
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
    inject() {
      // No Web server in this fake Host: the transport must still install.
    },
  }
  apply(ctx, {})
  const installed = globalThis.fetch
  assert.notEqual(installed, before, 'fetch is wrapped once the plugin applies')

  // A delegated request still works: loopback is always direct.
  const server = (await import('node:http')).createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('direct')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const response = await installed(`http://127.0.0.1:${port}/ping`)
    assert.equal(await response.text(), 'direct')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  for (const dispose of disposers) dispose()
  assert.equal(globalThis.fetch, before, 'disposing the effect restores the original fetch')
})

test('a second apply replaces the wrapper instead of stacking', async (t) => {
  const home = tempHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  const { apply } = await import('../index.js')
  const before = globalThis.fetch
  const first = []
  const second = []
  apply({ effect: (fn) => first.push(fn()), inject() {} }, {})
  const afterFirst = globalThis.fetch
  apply({ effect: (fn) => second.push(fn()), inject() {} }, {})
  const afterSecond = globalThis.fetch
  assert.notEqual(afterFirst, afterSecond)
  for (const dispose of second) dispose()
  assert.equal(globalThis.fetch, before, 'the second instance owns the restore')

  // A stale dispose from the first instance must not clobber the current wrapper.
  for (const dispose of first) dispose()
  assert.equal(globalThis.fetch, before)
})

test('the Host half writes its config under DSH_HOME with 0600', async (t) => {
  const home = tempHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  const { ProxyStore, publicEntry, publicState } = await import('../lib/store.js')
  const store = new ProxyStore()
  store.load()
  store.upsert({ url: 'http://user:secret@proxy.example:8080', name: 'Office' })
  const entry = store.get().proxies[0]
  assert.equal(entry.hostname, 'proxy.example')
  assert.equal(entry.port, 8080)
  assert.equal(entry.username, 'user')
  assert.equal(entry.password, 'secret')

  await store.flush()
  const file = path.join(home, 'model-proxy', 'config.json')
  assert.equal(fs.existsSync(file), true)
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600, 'a file holding a proxy password must not be world-readable')

  // Editing without a password keeps the stored one.
  store.upsert({ id: entry.id, url: 'http://proxy.example:9090', name: 'Office 2' })
  const edited = store.get().proxies[0]
  assert.equal(edited.port, 9090)
  assert.equal(edited.password, 'secret', 'omitting the password field keeps the old secret')
  assert.equal(edited.username, 'user')

  // Editing with empty credential fields clears them.
  store.upsert({ id: entry.id, url: 'http://proxy.example:9090', password: '', username: '' })
  assert.equal(store.get().proxies[0].password, '')
  assert.equal(store.get().proxies[0].username, undefined)

  const safe = publicEntry(store.get().proxies[0])
  assert.equal('password' in safe, false, 'secrets never cross the Host boundary')
  assert.equal('username' in safe, false)
  assert.equal(safe.hasAuth, false)

  const state = publicState(store.get())
  assert.equal(state.activeId, store.get().proxies[0].id)
  assert.equal(state.path, file)

  // Persisted state round-trips through a fresh store.
  await store.flush()
  const reloaded = new ProxyStore()
  reloaded.load()
  assert.equal(reloaded.get().proxies.length, 1)
  assert.equal(reloaded.get().proxies[0].port, 9090)

  store.remove(entry.id)
  assert.deepEqual(store.get().proxies, [])
  assert.equal(store.get().activeId, null)
  await store.flush()
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(parsed.proxies, [])
})

test('the client bundle registers a composer pill and a settings page', async (t) => {
  const calls = []
  const styles = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        calls.push(definition)
      },
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    head: { appendChild: (node) => styles.push(node) },
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
  t.after(() => {
    delete globalThis.window
    delete globalThis.document
    delete globalThis.navigator
  })

  await import('../client.js')
  assert.equal(calls.length, 1)
  const bundle = calls[0]
  assert.equal(bundle.id, 'dsh-model-proxy')

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }
  const definition = bundle.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })
  assert.equal(styles.length, 1, 'the stylesheet is injected once')
  assert.deepEqual(definition.inject, ['slots'])

  const registered = []
  const injected = []
  const ctx = {
    effect: (fn) => {
      fn()
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, mount) => {
        injected.push(name)
        return mount()
      },
      register: (options, component) => {
        registered.push({ ...options, component })
        return () => {}
      },
    },
  }
  definition.apply(ctx)
  assert.deepEqual(injected, ['conversation.input.right', 'settings.section'])
  assert.deepEqual(registered.map((entry) => entry.name), ['conversation.input.right', 'settings.section'])
  assert.equal(registered[0].id, 'dsh-model-proxy-pill')
  assert.equal(registered[1].id, 'model-proxy')
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(typeof registered[1].component, 'function')
  assert.equal(typeof registered[1].label(), 'string')
})
