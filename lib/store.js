/**
 * Durable state for the model proxy: the proxy list, which one is active, the
 * bypass list, and the last few routed requests.
 *
 * The state is kept in memory (the fetch wrapper reads it on the hot path) and
 * mirrored to `${DSH_HOME}/model-proxy/config.json` with mode 0600, because a
 * proxy URL may carry a password. Writes are serialized and atomic: a rename
 * replaces the file only once the new bytes are complete, so a crash mid-write
 * cannot leave a half-parsed config behind.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeProxy } from './proxy-fetch.js'

const FILE_VERSION = 1

function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

export function configPath() {
  return path.join(homeDir(), 'model-proxy', 'config.json')
}

function emptyState() {
  return {
    version: FILE_VERSION,
    enabled: false,
    activeId: null,
    bypassLoopback: true,
    bridgeAcp: true,
    bypass: [],
    proxies: [],
  }
}

function asStringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

function normalizeEntry(input, previous) {
  const source = typeof input === 'object' && input !== null ? input : {}
  const record = {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : crypto.randomUUID(),
    name: '',
    url: '',
    protocol: 'http',
    hostname: '',
    port: 0,
    enabled: source.enabled !== false,
    insecure: source.insecure === true,
    createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  // Address fields win over `url` when both are present, so a UI edit of the
  // host/port pair is not silently overridden by a stale stored URL.
  const hasFields = typeof source.host === 'string' || typeof source.hostname === 'string'
  const address = normalizeProxy(hasFields ? { protocol: source.protocol, host: source.host ?? source.hostname, port: source.port } : { url: source.url })
  record.protocol = address.protocol
  record.hostname = address.hostname
  record.port = address.port
  if (address.username !== undefined) record.username = address.username
  if (address.password !== undefined) record.password = address.password
  record.url = `${address.protocol}://${address.hostname}:${address.port}`
  const rawName = typeof source.name === 'string' ? source.name.trim() : ''
  record.name = rawName !== '' ? rawName : `${address.hostname}:${address.port}`
  return record
}

function normalizeState(raw) {
  const base = emptyState()
  if (typeof raw !== 'object' || raw === null) return base
  const proxies = []
  const seen = new Set()
  if (Array.isArray(raw.proxies)) {
    for (const entry of raw.proxies) {
      if (typeof entry !== 'object' || entry === null) continue
      try {
        const record = normalizeEntry(entry, entry)
        if (seen.has(record.id)) record.id = crypto.randomUUID()
        seen.add(record.id)
        proxies.push(record)
      } catch {
        // A stored entry that no longer parses is dropped rather than wedging
        // the whole plugin on every start.
      }
    }
  }
  base.proxies = proxies
  base.enabled = raw.enabled === true
  base.bypassLoopback = raw.bypassLoopback !== false
  base.bridgeAcp = raw.bridgeAcp !== false
  base.bypass = asStringList(raw.bypass)
  const activeId = typeof raw.activeId === 'string' ? raw.activeId : null
  base.activeId = activeId !== null && proxies.some((entry) => entry.id === activeId) ? activeId : proxies[0]?.id ?? null
  return base
}

/** Strip secrets before anything crosses the Host boundary. */
export function publicEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    protocol: entry.protocol,
    hostname: entry.hostname,
    port: entry.port,
    enabled: entry.enabled,
    insecure: entry.insecure,
    hasAuth: typeof entry.username === 'string' && entry.username !== '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export function publicState(state, extra = {}) {
  const active = state.proxies.find((entry) => entry.id === state.activeId) ?? null
  return {
    version: state.version,
    enabled: state.enabled,
    activeId: state.activeId,
    bypassLoopback: state.bypassLoopback,
    bridgeAcp: state.bridgeAcp !== false,
    bypass: [...state.bypass],
    proxies: state.proxies.map(publicEntry),
    active: active === null ? null : publicEntry(active),
    path: configPath(),
    ...extra,
  }
}

export class ProxyStore {
  constructor({ log = () => {} } = {}) {
    this.log = log
    this.file = configPath()
    this.state = emptyState()
    this.chain = null
    this.dirty = false
    this.listeners = new Set()
  }

  /** Read the config file once at startup; a broken file is reported, not fatal. */
  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      this.state = normalizeState(JSON.parse(text))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`model proxy config at ${this.file} is unreadable: ${error?.message ?? error}`)
      this.state = emptyState()
    }
    return this.state
  }

  get() {
    return this.state
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    for (const listener of this.listeners) {
      try {
        listener(this.state)
      } catch {
        /* a broken listener must not block a switch */
      }
    }
  }

  /** Replace the in-memory state, persist it, and notify subscribers. */
  set(next) {
    this.state = next
    this.emit()
    this.flush()
    return this.state
  }

  patch(patch) {
    const next = { ...this.state }
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true
    if (patch.bypassLoopback !== undefined) next.bypassLoopback = patch.bypassLoopback !== false
    if (patch.bridgeAcp !== undefined) next.bridgeAcp = patch.bridgeAcp !== false
    if (patch.bypass !== undefined) next.bypass = asStringList(patch.bypass)
    if (patch.activeId !== undefined) {
      const id = typeof patch.activeId === 'string' && patch.activeId !== '' ? patch.activeId : null
      next.activeId = id === null || next.proxies.some((entry) => entry.id === id) ? id : next.activeId
    }
    return this.set(next)
  }

  /** Insert or update one proxy; `id` selects the record to replace. */
  upsert(input) {
    const id = typeof input?.id === 'string' && input.id !== '' ? input.id : null
    const previous = id === null ? null : this.state.proxies.find((entry) => entry.id === id) ?? null
    if (id !== null && previous === null) throw new Error('proxy not found')
    const record = normalizeEntry({ ...input, id: previous?.id ?? undefined }, previous)
    // Keeping the old secret when the form sends no password field is what
    // makes "edit the port, keep the credentials" work.
    if (input?.password === undefined && previous?.password !== undefined) record.password = previous.password
    if (input?.username === undefined && previous?.username !== undefined) record.username = previous.username
    const proxies = previous === null
      ? [...this.state.proxies, record]
      : this.state.proxies.map((entry) => (entry.id === record.id ? record : entry))
    const activeId = this.state.activeId ?? record.id
    return this.set({ ...this.state, proxies, activeId })
  }

  remove(id) {
    const proxies = this.state.proxies.filter((entry) => entry.id !== id)
    if (proxies.length === this.state.proxies.length) throw new Error('proxy not found')
    const activeId = this.state.activeId === id ? proxies[0]?.id ?? null : this.state.activeId
    return this.set({ ...this.state, proxies, activeId })
  }

  /**
   * Persist the current state. A write that is already in flight does not
   * capture the new value, so the loop keeps writing while anything changed;
   * the returned promise settles only once the last change is on disk.
   */
  flush() {
    this.dirty = true
    if (this.chain === null) {
      this.chain = (async () => {
        try {
          while (this.dirty) {
            this.dirty = false
            await this.write()
          }
        } finally {
          this.chain = null
        }
      })()
    }
    return this.chain
  }

  async write() {
    const text = `${JSON.stringify(this.state, null, 2)}\n`
    const dir = path.dirname(this.file)
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      await fsp.writeFile(tmp, text, { mode: 0o600 })
      await fsp.rename(tmp, this.file)
      await fsp.chmod(this.file, 0o600).catch(() => {})
    } catch (error) {
      this.log(`could not save model proxy config to ${this.file}: ${error?.message ?? error}`)
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  }
}
