window.__ModuleLoader__.load({
  id: 'dsh-model-proxy', // ui-copy-ignore
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dsh-model-proxy' // ui-copy-ignore
    const BASE = '/dsh-model-proxy' // ui-copy-ignore
    const POLL_MS = 5000 // ui-copy-ignore

    const EN = {
      nav: 'Model Proxy',
      pill: 'Model proxy',
      direct: 'Direct',
      loading: 'Loading…',
      on: 'On',
      off: 'Off',
      title: 'Model proxy',
      intro: 'Model calls are sent through the selected proxy. Everything else, including loopback addresses, keeps going out directly.',
      switchLabel: 'Route model calls through a proxy',
      noProxy: 'Direct connection',
      noProxyHint: 'No proxy — the environment proxy from the shell, if any, still applies.',
      addProxy: 'Add a proxy',
      editProxy: 'Edit proxy',
      save: 'Save',
      cancel: 'Cancel',
      remove: 'Remove',
      test: 'Test',
      testing: 'Testing…',
      activate: 'Use',
      active: 'In use',
      name: 'Label',
      namePlaceholder: 'Office gateway',
      address: 'Proxy address',
      addressPlaceholder: 'http://user:pass@proxy.example:8080',
      addressHint: 'http, https, or host:port. Credentials may be inline or in the fields below.',
      username: 'Username',
      password: 'Password',
      passwordKeep: '•••• unchanged',
      insecure: 'Accept self-signed proxy certificate',
      bypass: 'Bypass list',
      bypassHint: 'Hosts that never use a proxy, one per line. *.example.com matches subdomains.',
      bypassLoopback: 'Always connect to this machine directly',
      saved: 'Saved',
      empty: 'No proxy configured yet. Add one to get started.',
      recent: 'Recent model requests',
      recentEmpty: 'Nothing has been routed yet.',
      counters: (total, failed) => `${total} routed · ${failed} failed`,
      configFile: 'Config file',
      needAddress: 'Enter a proxy address first.',
      testOk: (status, ms) => `Reachable — HTTP ${status} in ${ms} ms`,
      testFail: (error) => `Unreachable — ${error}`,
      noAuth: 'no auth',
      withAuth: 'auth',
      disabled: 'disabled',
      enabled: 'enabled',
      toggleProxy: 'Include this proxy in the list',
      loadingState: 'Contacting the Host…',
    }

    const ZH = {
      nav: '模型代理',
      pill: '模型代理',
      direct: '直连',
      loading: '加载中…',
      on: '开',
      off: '关',
      title: '模型代理',
      intro: '模型请求将通过所选代理发出；其他请求以及本机回环地址仍然直连。',
      switchLabel: '通过代理发送模型请求',
      noProxy: '直连',
      noProxyHint: '不使用代理——终端环境变量的代理仍然生效。',
      addProxy: '添加代理',
      editProxy: '编辑代理',
      save: '保存',
      cancel: '取消',
      remove: '删除',
      test: '测试',
      testing: '测试中…',
      activate: '使用',
      active: '使用中',
      name: '名称',
      namePlaceholder: '公司网关',
      address: '代理地址',
      addressPlaceholder: 'http://user:pass@proxy.example:8080',
      addressHint: 'http、https 或 host:port；账号密码可写在地址里或下方字段。',
      username: '用户名',
      password: '密码',
      passwordKeep: '•••• 保持不变',
      insecure: '接受代理的自签名证书',
      bypass: '直连列表',
      bypassHint: '这些主机不走代理，每行一个；*.example.com 匹配子域名。',
      bypassLoopback: '本机地址始终直连',
      saved: '已保存',
      empty: '还没有配置代理，先添加一个。',
      recent: '最近的模型请求',
      recentEmpty: '还没有请求经过代理。',
      counters: (total, failed) => `已转发 ${total} 次 · 失败 ${failed} 次`,
      configFile: '配置文件',
      needAddress: '请先填写代理地址。',
      testOk: (status, ms) => `可用 — HTTP ${status}，${ms} ms`,
      testFail: (error) => `不可用 — ${error}`,
      noAuth: '无认证',
      withAuth: '带认证',
      disabled: '已停用',
      enabled: '已启用',
      toggleProxy: '是否加入代理列表',
      loadingState: '正在连接宿主…',
    }

    const COPY = /^zh/i.test(navigator.language || '') ? ZH : EN // ui-copy-ignore
    const t = (key, ...args) => (typeof COPY[key] === 'function' ? COPY[key](...args) : COPY[key] ?? key)

    // -----------------------------------------------------------------
    // Style: one sheet for the page, tokens only, no primitives import.
    // -----------------------------------------------------------------
    const STYLE_ID = 'dsh-model-proxy-style' // ui-copy-ignore
    const CSS = `
.dmp-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;max-width:190px}
.dmp-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dmp-pill[data-on="true"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dmp-pill-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dmp-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}
.dmp-pop{position:fixed;z-index:9999;width:330px;max-height:70vh;overflow:auto;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.28);font-size:13px}
.dmp-pop h3{margin:0;font-size:13px;font-weight:600}
.dmp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dmp-list{display:flex;flex-direction:column;gap:2px;margin:0 -4px}
.dmp-opt{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;border:none;background:transparent;color:inherit;text-align:left;width:100%;font:inherit}
.dmp-opt:hover{background:var(--dsw-alias-bg-layer-2)}
.dmp-opt[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}
.dmp-opt-main{min-width:0;flex:1}
.dmp-opt-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-opt-addr{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-radio{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);flex:none;position:relative}
.dmp-radio[data-checked="true"]{border-color:var(--dsw-alias-brand-primary)}
.dmp-radio[data-checked="true"]::after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.dmp-sep{height:1px;background:var(--dsw-alias-border-l1);margin:10px 0}
.dmp-row{display:flex;align-items:center;gap:8px}
.dmp-grow{flex:1;min-width:0}
.dmp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dmp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dmp-btn:disabled{opacity:.5;cursor:default}
.dmp-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dmp-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l1)}
.dmp-btn[data-size="sm"]{height:24px;padding:0 8px;font-size:11px;border-radius:6px}
.dmp-switch{position:relative;width:34px;height:20px;border-radius:999px;border:none;background:var(--dsw-alias-border-l2);cursor:pointer;flex:none;padding:0}
.dmp-switch[data-on="true"]{background:var(--dsw-alias-brand-primary)}
.dmp-switch span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease}
.dmp-switch[data-on="true"] span{transform:translateX(14px)}
.dmp-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.dmp-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dmp-input,textarea.dmp-input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dmp-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dmp-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.dmp-page{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;max-width:760px;color:var(--dsw-alias-label-primary)}
.dmp-page h2{margin:0;font-size:16px;font-weight:600}
.dmp-page p{margin:0}
.dmp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.dmp-card-title{font-size:12px;font-weight:600;letter-spacing:.02em}
.dmp-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1)}
.dmp-item[data-active="true"]{border-color:var(--dsw-alias-brand-primary)}
.dmp-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dmp-item-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}
.dmp-badge{display:inline-block;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10px;color:var(--dsw-alias-label-secondary)}
.dmp-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dmp-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dmp-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.dmp-msg{font-size:11px;line-height:1.5}
.dmp-msg[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}
.dmp-msg[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dmp-log{display:flex;flex-direction:column;gap:4px;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}
.dmp-log-row{display:flex;gap:8px;align-items:baseline}
.dmp-log-host{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
`
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      } catch {
        /* a page without a head is not worth failing over */
      }
    }
    if (typeof document !== 'undefined') ensureStyle()

    // -----------------------------------------------------------------
    // Host API
    // -----------------------------------------------------------------
    async function api(path, body) {
      const init = {
        cache: 'no-store', // ui-copy-ignore
        credentials: 'same-origin', // ui-copy-ignore
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined,
      }
      if (body !== undefined) {
        init.method = 'POST' // ui-copy-ignore
        init.headers = { 'content-type': 'application/json', 'x-dsh-model-proxy': '1' } // ui-copy-ignore
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`${BASE}${path}`, init)
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (data === null) throw new Error(`HTTP ${response.status}`)
      if (response.status === 403) throw new Error(data.error ?? 'forbidden')
      return data
    }

    function useProxyState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const settled = useRef(true)

      const load = useCallback(async () => {
        try {
          const data = await api('/state')
          if (data?.ok === true) {
            setState(data.state)
            setError('')
          } else if (data?.error) setError(String(data.error))
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      const mutate = useCallback(async (path, body) => {
        setBusy(true)
        try {
          const data = await api(path, body)
          if (data?.ok === true) {
            if (data.state !== undefined) setState(data.state)
            else void load()
            setError('')
          } else {
            setError(String(data?.error ?? 'request failed'))
          }
          return data
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          return null
        } finally {
          setBusy(false)
        }
      }, [load])

      useEffect(() => {
        let alive = true
        settled.current = true
        void load()
        const wake = () => {
          if (document.visibilityState === 'hidden') return
          void load()
        }
        window.addEventListener('focus', wake)
        document.addEventListener('visibilitychange', wake)
        const timer = setInterval(wake, POLL_MS)
        return () => {
          alive = false
          settled.current = false
          window.removeEventListener('focus', wake)
          document.removeEventListener('visibilitychange', wake)
          clearInterval(timer)
        }
      }, [load])

      return { state, error, busy, load, mutate }
    }

    // -----------------------------------------------------------------
    // Small building blocks
    // -----------------------------------------------------------------
    function Switch({ on, onChange, label, disabled }) {
      return h('button', {
        type: 'button', // ui-copy-ignore
        className: 'dmp-switch', // ui-copy-ignore
        'data-on': on === true ? 'true' : 'false',
        'aria-pressed': on === true,
        'aria-label': label,
        title: label,
        disabled: disabled === true,
        onClick: () => onChange(on !== true),
      }, h('span'))
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'dmp-badge', 'data-tone': tone ?? 'plain' }, children)
    }

    function Message({ tone, children }) {
      if (children === null || children === undefined || children === '') return null
      return h('p', { className: 'dmp-msg', 'data-tone': tone ?? 'plain' }, children)
    }

    /** Panel anchored on top of the pill, opening upwards from it. */
    function useAnchored(open, ref, width) {
      const [pos, setPos] = useState(null)
      useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const node = ref.current
          if (node === null) return
          const rect = node.getBoundingClientRect()
          const margin = 12
          const gap = 6
          const w = Math.max(240, Math.min(width, window.innerWidth - margin * 2))
          const left = Math.max(margin, Math.min(rect.right - w, window.innerWidth - w - margin))
          // The panel grows upwards out of the pill: its bottom edge sits on the
          // pill's top edge and its height comes from the room above, so a long
          // proxy list scrolls instead of pushing the panel off screen.
          const room = rect.top - gap - margin
          const maxHeight = Math.min(520, Math.max(120, room))
          setPos({ left, bottom: window.innerHeight - rect.top + gap, width: w, maxHeight })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, ref, width])
      return pos
    }

    function ProxyOption({ active, name, address, onClick, disabled }) {
      return h('button', {
        type: 'button', // ui-copy-ignore
        className: 'dmp-opt', // ui-copy-ignore
        'data-active': active === true ? 'true' : 'false',
        onClick,
        disabled: disabled === true,
      },
      h('span', { className: 'dmp-radio', 'data-checked': active === true ? 'true' : 'false' }),
      h('span', { className: 'dmp-opt-main' },
        h('span', { className: 'dmp-opt-name' }, name),
        h('span', { className: 'dmp-opt-addr' }, address)))
    }

    // -----------------------------------------------------------------
    // Composer pill
    // -----------------------------------------------------------------
    function Pill() {
      const { state, error, busy, mutate } = useProxyState()
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [notice, setNotice] = useState('')
      const anchor = useRef(null)
      const panel = useRef(null)
      const pos = useAnchored(open, anchor, 330)

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = event.target
          if (panel.current !== null && panel.current.contains(node)) return
          if (anchor.current !== null && anchor.current.contains(node)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const proxies = state?.proxies ?? []
      const activeName = state?.enabled === true ? state.active?.name ?? t('direct') : t('direct')
      const label = state === null ? t('loading') : activeName

      const addAndUse = async () => {
        const text = draft.trim()
        if (text === '') {
          setNotice(t('needAddress'))
          return
        }
        const data = await mutate('/proxies', { url: text, enabled: true })
        if (data?.ok === true) {
          setDraft('')
          setNotice(t('saved'))
          const id = data.proxy?.id
          if (typeof id === 'string') await mutate('/state', { enabled: true, activeId: id })
        }
      }

      return h('span', { style: { display: 'inline-flex' } },
        h('button', {
          ref: anchor,
          type: 'button', // ui-copy-ignore
          className: 'dmp-pill', // ui-copy-ignore
          'data-on': state?.enabled === true ? 'true' : 'false',
          'aria-haspopup': 'dialog', // ui-copy-ignore
          'aria-expanded': open,
          title: state === null ? t('loading') : `${t('pill')} · ${activeName}`,
          onClick: () => setOpen((value) => value !== true),
        },
        h('span', { className: 'dmp-dot', 'data-on': state?.enabled === true ? 'true' : 'false' }),
        h('span', { className: 'dmp-pill-label' }, label)),

        open && pos !== null ? h('div', {
          ref: panel,
          className: 'dmp-pop', // ui-copy-ignore
          role: 'dialog', // ui-copy-ignore
          'aria-label': t('pill'),
          style: { left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight },
        },
        h('div', { className: 'dmp-head' },
          h('h3', {}, t('pill')),
          h(Switch, {
            on: state?.enabled === true,
            label: t('switchLabel'),
            disabled: busy || state === null,
            onChange: (next) => { void mutate('/state', { enabled: next }) },
          })),
        h('div', { className: 'dmp-list' },
          h(ProxyOption, {
            active: state?.enabled !== true,
            name: t('noProxy'),
            address: t('noProxyHint'),
            disabled: busy,
            onClick: () => { void mutate('/state', { enabled: false }) },
          }),
          proxies.map((entry) => h(ProxyOption, {
            key: entry.id,
            active: state?.enabled === true && state.activeId === entry.id,
            name: entry.name,
            address: `${entry.url}${entry.enabled === false ? ` · ${t('disabled')}` : ''}${entry.hasAuth ? ` · ${t('withAuth')}` : ''}`,
            disabled: busy,
            onClick: () => { void mutate('/state', { enabled: true, activeId: entry.id }) },
          }))),

        h('div', { className: 'dmp-sep' }),
        h('div', { className: 'dmp-row', style: { gap: 6 } },
          h('input', {
            className: 'dmp-input', // ui-copy-ignore
            value: draft,
            placeholder: t('addressPlaceholder'),
            spellCheck: false,
            onChange: (event) => { setDraft(event.target.value); setNotice('') },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void addAndUse()
              }
            },
          }),
          h('button', {
            type: 'button', // ui-copy-ignore
            className: 'dmp-btn', // ui-copy-ignore
            'data-variant': 'primary',
            disabled: busy,
            onClick: () => { void addAndUse() },
          }, t('save'))),
        h(Message, { tone: error !== '' ? 'err' : notice !== '' ? 'ok' : 'plain' }, error !== '' ? error : notice))
        : null)
    }

    // -----------------------------------------------------------------
    // Settings page
    // -----------------------------------------------------------------
    const EMPTY_FORM = { id: null, name: '', url: '', username: '', password: '', insecure: false, enabled: true }

    function formFrom(entry) {
      return {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        username: '',
        password: '',
        insecure: entry.insecure === true,
        enabled: entry.enabled !== false,
        hasAuth: entry.hasAuth === true,
      }
    }

    function SettingsPage() {
      const { state, error, busy, mutate, load } = useProxyState()
      const [form, setForm] = useState(EMPTY_FORM)
      const [formError, setFormError] = useState('')
      const [formNotice, setFormNotice] = useState('')
      const [probe, setProbe] = useState({ id: null, text: '', tone: 'plain' })
      const [bypassText, setBypassText] = useState(null)
      const [testing, setTesting] = useState(false)

      useEffect(() => {
        if (state !== null && bypassText === null) setBypassText((state.bypass ?? []).join('\n'))
      }, [state, bypassText])

      const editing = form.id !== null
      const field = (key) => ({
        value: form[key] ?? '',
        onChange: (event) => {
          const next = event.target.value
          setForm((current) => ({ ...current, [key]: next }))
          setFormError('')
          setFormNotice('')
        },
      })

      const save = async () => {
        const address = String(form.url ?? '').trim()
        if (address === '') {
          setFormError(t('needAddress'))
          return
        }
        const body = { url: address, name: form.name, insecure: form.insecure, enabled: form.enabled }
        if (editing) body.id = form.id
        if (String(form.username ?? '') !== '') body.username = form.username
        if (String(form.password ?? '') !== '') body.password = form.password
        const data = await mutate('/proxies', body)
        if (data?.ok === true) {
          setForm(EMPTY_FORM)
          setFormNotice(t('saved'))
          setProbe({ id: null, text: '', tone: 'plain' })
        } else {
          setFormError(String(data?.error ?? t('needAddress')))
        }
      }

      const test = async (entry) => {
        setTesting(true)
        setProbe({ id: entry.id, text: t('testing'), tone: 'plain' })
        const data = await mutate('/proxies/test', { id: entry.id })
        setTesting(false)
        const result = data?.probe
        if (result?.ok === true) setProbe({ id: entry.id, text: t('testOk', result.status, result.latencyMs), tone: 'ok' })
        else setProbe({ id: entry.id, text: t('testFail', result?.error ?? data?.error ?? '?'), tone: 'err' })
      }

      const saveBypass = async () => {
        const lines = String(bypassText ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
        await mutate('/state', { bypass: lines })
      }

      const proxies = state?.proxies ?? []
      const recentRows = (state?.recent ?? []).map((entry, index) => h('div', {
        key: `${entry.at}-${index}`,
        className: 'dmp-log-row', // ui-copy-ignore
      },
      h('span', {}, new Date(entry.at).toLocaleTimeString()),
      h('span', { className: 'dmp-log-host' }, entry.host),
      h('span', {}, entry.proxy),
      h('span', {
        style: { color: entry.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' },
      }, entry.ok === true ? String(entry.status ?? 'ok') : String(entry.error ?? 'failed'))))

      const recentCard = h('div', { className: 'dmp-card' },
        h('div', { className: 'dmp-row' },
          h('div', { className: 'dmp-card-title dmp-grow' }, t('recent')),
          h('button', {
            type: 'button', // ui-copy-ignore
            className: 'dmp-btn', // ui-copy-ignore
            'data-size': 'sm',
            onClick: () => { void load() },
          }, '\u21bb')),
        h('span', { className: 'dmp-hint' }, t('counters', state?.counters?.total ?? 0, state?.counters?.failed ?? 0)),
        recentRows.length === 0
          ? h('p', { className: 'dmp-hint' }, t('recentEmpty'))
          : h('div', { className: 'dmp-log' }, recentRows))

      return h('div', { className: 'dmp-page' },
        h('div', {},
          h('h2', {}, t('title')),
          h('p', { className: 'dmp-hint', style: { marginTop: 6 } }, t('intro'))),

        state === null
          ? h('p', { className: 'dmp-hint' }, t('loadingState'))
          : h('div', { className: 'dmp-card' },
            h('div', { className: 'dmp-row' },
              h('div', { className: 'dmp-grow' },
                h('div', { className: 'dmp-card-title' }, t('switchLabel')),
                h('div', { className: 'dmp-hint' },
                  state.enabled
                    ? `${t('on')} · ${state.active?.name ?? t('direct')}`
                    : `${t('off')} · ${t('direct')}`)),
              h(Switch, {
                on: state.enabled === true,
                label: t('switchLabel'),
                disabled: busy,
                onChange: (next) => { void mutate('/state', { enabled: next }) },
              })),

            h('div', { className: 'dmp-row' },
              h('div', { className: 'dmp-grow' },
                h('div', { className: 'dmp-card-title' }, t('bypassLoopback'))),
              h(Switch, {
                on: state.bypassLoopback !== false,
                label: t('bypassLoopback'),
                disabled: busy,
                onChange: (next) => { void mutate('/state', { bypassLoopback: next }) },
              })),

            h('div', { className: 'dmp-field', style: { marginBottom: 0 } },
              h('label', {}, t('bypass')),
              h('textarea', {
                className: 'dmp-input', // ui-copy-ignore
                rows: 3,
                value: bypassText ?? '',
                spellCheck: false,
                placeholder: '*.corp.example\n10.0.0.0/8',
                onChange: (event) => setBypassText(event.target.value),
                onBlur: () => { void saveBypass() },
              }),
              h('span', { className: 'dmp-hint' }, t('bypassHint')))),

        h('div', { className: 'dmp-card' },
          h('div', { className: 'dmp-card-title' }, editing ? t('editProxy') : t('addProxy')),
          h('div', { className: 'dmp-field' },
            h('label', {}, t('address')),
            h('input', {
              className: 'dmp-input', // ui-copy-ignore
              placeholder: t('addressPlaceholder'),
              spellCheck: false,
              ...field('url'),
            }),
            h('span', { className: 'dmp-hint' }, t('addressHint'))),
          h('div', { className: 'dmp-row', style: { gap: 8, alignItems: 'flex-start' } },
            h('div', { className: 'dmp-field dmp-grow', style: { marginBottom: 0 } },
              h('label', {}, t('name')),
              h('input', { className: 'dmp-input', placeholder: t('namePlaceholder'), ...field('name') })),
            h('div', { className: 'dmp-field dmp-grow', style: { marginBottom: 0 } },
              h('label', {}, t('username')),
              h('input', { className: 'dmp-input', spellCheck: false, autoComplete: 'off', ...field('username') })),
            h('div', { className: 'dmp-field dmp-grow', style: { marginBottom: 0 } },
              h('label', {}, t('password')),
              h('input', {
                className: 'dmp-input', // ui-copy-ignore
                type: 'password', // ui-copy-ignore
                spellCheck: false,
                autoComplete: 'new-password', // ui-copy-ignore
                placeholder: editing && form.hasAuth === true ? t('passwordKeep') : '',
                ...field('password'),
              }))),
          h('label', { className: 'dmp-row', style: { gap: 8, fontSize: 12, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', // ui-copy-ignore
              checked: form.insecure === true,
              onChange: (event) => setForm((current) => ({ ...current, insecure: event.target.checked })),
            }),
            h('span', { className: 'dmp-hint' }, t('insecure'))),
          h('div', { className: 'dmp-row' },
            h('button', {
              type: 'button', // ui-copy-ignore
              className: 'dmp-btn', // ui-copy-ignore
              'data-variant': 'primary',
              disabled: busy,
              onClick: () => { void save() },
            }, t('save')),
            editing
              ? h('button', {
                type: 'button', // ui-copy-ignore
                className: 'dmp-btn', // ui-copy-ignore
                onClick: () => { setForm(EMPTY_FORM); setFormError(''); setFormNotice('') },
              }, t('cancel'))
              : null,
            h('span', { className: 'dmp-grow' }),
            h(Message, { tone: formError !== '' ? 'err' : formNotice !== '' ? 'ok' : 'plain' }, formError !== '' ? formError : formNotice)),

          proxies.length === 0
            ? h('p', { className: 'dmp-hint' }, t('empty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              proxies.map((entry) => h('div', {
                key: entry.id,
                className: 'dmp-item', // ui-copy-ignore
                'data-active': state?.enabled === true && state.activeId === entry.id ? 'true' : 'false',
              },
              h('span', { className: 'dmp-radio', 'data-checked': state?.activeId === entry.id ? 'true' : 'false' }),
              h('div', { className: 'dmp-item-main' },
                h('span', { className: 'dmp-item-name' }, entry.name),
                h('div', { className: 'dmp-item-meta' },
                  h('span', {}, entry.url),
                  entry.hasAuth ? h(Badge, {}, t('withAuth')) : h(Badge, {}, t('noAuth')),
                  entry.insecure ? h(Badge, { tone: 'warn' }, 'insecure') : null,
                  entry.enabled === false ? h(Badge, { tone: 'warn' }, t('disabled')) : null,
                  state?.enabled === true && state.activeId === entry.id ? h(Badge, { tone: 'ok' }, t('active')) : null)),
              h('div', { className: 'dmp-row', style: { gap: 6 } },
                h('button', {
                  type: 'button', // ui-copy-ignore
                  className: 'dmp-btn', // ui-copy-ignore
                  'data-size': 'sm',
                  disabled: busy,
                  onClick: () => { void mutate('/state', { enabled: true, activeId: entry.id }) },
                }, t('activate')),
                h('button', {
                  type: 'button', // ui-copy-ignore
                  className: 'dmp-btn', // ui-copy-ignore
                  'data-size': 'sm',
                  disabled: testing,
                  onClick: () => { void test(entry) },
                }, t('test')),
                h('button', {
                  type: 'button', // ui-copy-ignore
                  className: 'dmp-btn', // ui-copy-ignore
                  'data-size': 'sm',
                  disabled: busy,
                  onClick: () => {
                    setForm(formFrom(entry))
                    setFormNotice('')
                    setFormError('')
                  },
                }, t('editProxy')),
                h('button', {
                  type: 'button', // ui-copy-ignore
                  className: 'dmp-btn', // ui-copy-ignore
                  'data-size': 'sm',
                  'data-variant': 'danger',
                  disabled: busy,
                  onClick: () => { void mutate('/proxies/remove', { id: entry.id }) },
                }, t('remove')))))),
          probe.id !== null
            ? h(Message, { tone: probe.tone }, probe.text)
            : null),

        recentCard,
        h('p', { className: 'dmp-hint' }, `${t('configFile')}: ${state?.path ?? '…'}`),
        h(Message, { tone: 'err' }, error))
    }

    const definition = {
      inject: ['slots'], // ui-copy-ignore
      apply(ctx) {
        try {
          if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'model-proxy: dictionaries') // ui-copy-ignore
          }
        } catch {
          /* the page still works with the bundled copy */
        }
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right', // ui-copy-ignore
          id: 'dsh-model-proxy-pill', // ui-copy-ignore
          order: 24, // ui-copy-ignore
          label: () => t('pill'), // ui-copy-ignore
        }, Pill))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', // ui-copy-ignore
          id: 'model-proxy', // ui-copy-ignore
          order: 45, // ui-copy-ignore
          label: () => t('nav'), // ui-copy-ignore
          locale: NS, // ui-copy-ignore
        }, SettingsPage))
      },
    }
    return definition
  },
})
