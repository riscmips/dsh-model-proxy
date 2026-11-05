# Model Proxy

Send every model call of this DSH Host through an HTTP or HTTPS forward proxy, and switch which proxy is in use **while a conversation is running**.

## What it actually intercepts

The Host installs one `globalThis.fetch` wrapper for the lifetime of the process. Both LLM adapters resolve `fetch` from the global scope at call time, so provider traffic — chat completions, model discovery, token refresh — goes through the selected proxy without any adapter knowing about this plugin.

Requests that should **not** be proxied are handed to the original `fetch`, unchanged:

- nothing selected, or the switch is off;
- loopback targets (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) while *Always connect to this machine directly* is on;
- any host on the bypass list.

That last point matters: the environment proxy (`HTTPS_PROXY` and friends) that the launcher resolved at boot still applies to delegated requests, so this plugin adds a switch on top instead of replacing the existing behaviour.

## Switching during a conversation

Two surfaces, both live:

- **Composer pill** — the dot to the left of the send row. Click it to turn routing on or off, pick a saved proxy, or paste a proxy URL and start using it immediately.
- **Settings → Model Proxy** — add, edit, test, disable and remove proxies, edit the bypass list, and watch the last requests that were routed and whether they succeeded.

A switch takes effect on the next model call. An in-flight request keeps the proxy it started with, so a switch cannot corrupt a streaming answer.

## Transports

| Target | Dialect |
| --- | --- |
| `https://…` | `CONNECT` tunnel, then TLS terminated in-process (`node:tls`, ALPN `http/1.1`) |
| `http://…` | absolute-form request sent to the proxy |

Both dialects support `Proxy-Authorization: Basic …`, taken from credentials in the proxy URL (`http://user:pass@proxy:8080`) or from the username/password fields. Responses are re-exposed as standard `Response` objects with a streaming body, so SSE answers and gzip/br/deflate bodies behave exactly as with `fetch`.

Not supported: SOCKS proxies and PAC files. Only `http` and `https` proxy URLs are accepted; anything else is rejected with an explicit error.

## Configuration

State lives in `${DSH_HOME}/model-proxy/config.json` (mode `0600`, because it may hold a proxy password). The file is written atomically and reloaded at boot, so a proxy selected in the UI survives a restart.

```json
{
  "version": 1,
  "enabled": true,
  "activeId": "…",
  "bypassLoopback": true,
  "bypass": ["*.corp.example"],
  "proxies": [
    {
      "id": "…",
      "name": "Office gateway",
      "url": "http://proxy.example:8080",
      "protocol": "http",
      "hostname": "proxy.example",
      "port": 8080,
      "username": "user",
      "password": "secret",
      "insecure": false,
      "enabled": true
    }
  ]
}
```

`insecure: true` accepts a self-signed certificate **from the proxy itself** (the proxy's own TLS hop). The target's certificate is always verified unless that flag is set, which is why the flag is labelled as a security downgrade in the UI.

## HTTP surface

The client half talks to the Host over a small same-origin JSON API. Mutating calls require `Content-Type: application/json` and the `x-dsh-model-proxy: 1` header, which a cross-site form cannot produce.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-model-proxy/state` | full public state, counters, recent requests |
| `POST` | `/dsh-model-proxy/state` | `{enabled, activeId, bypass, bypassLoopback}` |
| `POST` | `/dsh-model-proxy/proxies` | create or update (`id` selects the record) |
| `POST` | `/dsh-model-proxy/proxies/remove` | `{id}` |
| `POST` | `/dsh-model-proxy/proxies/test` | connectivity probe for `{id}` or an inline URL |
| `GET` | `/dsh-model-proxy/stats` | counters and the full recent-request ring |

Secrets never leave the Host: responses carry `hasAuth`, never `username` or `password`. Editing a proxy without touching the password field keeps the stored one.

## Limits worth knowing

- The wrapper covers traffic that goes through the Host's `fetch`. A provider SDK that opens its own TLS socket directly would bypass it (none of the bundled adapters do), and the `web_fetch` tool does not go through it — tool traffic keeps its own transport.
- Every model call re-reads the current state before it starts, so a switch between two calls is immediate; it never rewrites a request already in flight.
- A proxy that fails makes the model call fail. There is no silent fallback to a direct connection, because that would hide a misconfigured proxy behind working traffic.
- The recent-request log is a 40-entry ring in memory; it is not persisted.

## Development

```bash
node --test 'test/*.test.mjs'
```

The suite covers both dialects against a local forwarding proxy (with Basic auth), a TLS origin with a self-signed certificate, streaming bodies, redirects, aborts, gzip decoding, store persistence, and the client bundle's slot registration.
