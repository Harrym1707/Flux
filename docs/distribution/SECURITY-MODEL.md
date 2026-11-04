# Security model — proxy + distribution

The threat model for the MESH client: a local proxy that carries a user's real
provider key, plus the distribution channels that put it there. Synthesised from
the pre-launch security review (the hardening tests live in
`packages/sdk-js/src/proxy.test.ts:200-329`).

This page states what is handled and what is a known gap. It does not claim more
than the code enforces.

## Trust boundary

The proxy serves **loopback clients only**. It binds to `127.0.0.1`
(`packages/sdk-js/src/proxy.ts:571`), so a remote attacker is out of scope by
the bind itself — nothing off the machine can reach it. The trust boundary is
the loopback interface: anything that can already make a connection to
`127.0.0.1` on this machine is inside it. The client (Claude Code, an SDK caller)
is trusted by design — the proxy applies no authentication to its own callers
because the caller holds the key regardless.

## What IS handled

- **Loopback bind.** `server.listen(port, "127.0.0.1")` — the socket never
  listens on a routable address (`proxy.ts:571`).
- **Host-header allowlist (DNS-rebinding defense).** Every request's `Host` is
  checked against `127.0.0.1` / `localhost` / `[::1]`; anything else gets 403
  before any upstream work (`proxy.ts:133-137,293-297`). This stops a browser
  page that has rebound a DNS name to `127.0.0.1` from driving the proxy through
  the victim's browser. Covered by a test that speaks raw HTTP to set a forged
  `Host` (`proxy.test.ts:273-288`).
- **Clean credential passthrough.** The caller's auth headers are forwarded
  verbatim to the one upstream and the key is never stored, logged, or written to
  the ledger (`proxy.ts:26-31,90-106`). Forwarding is **cross-provider scoped**:
  `x-api-key` never goes to OpenAI, and `Authorization` is dropped for Anthropic
  exactly when an `x-api-key` is present — so a client configured with both keys
  never leaks the off-provider credential, while Anthropic OAuth (bearer, no
  `x-api-key`) keeps working (`proxy.ts:80-101`; tests at
  `proxy.test.ts:220-260`). MESH's own `x-mesh-application` routing header is
  stripped and never leaves the machine (`proxy.ts:96`).
- **No SSRF.** Upstreams are fixed at startup to `api.anthropic.com` /
  `api.openai.com` (or explicit per-deployment overrides); the request path and
  provider are chosen from a closed set of surfaces (`proxy.ts:144-149,238-241`).
  No part of the request body or headers can redirect the forward to an
  attacker-chosen host.
- **64MB body cap.** Bodies beyond `BODY_CAP = 64MB` are rejected with 413 (or a
  dropped connection), never buffered into an OOM (`proxy.ts:108-131`; test at
  `proxy.test.ts:262-271`).
- **Bounded maps.** The per-app ledger map is LRU-capped at 200 and the recent-
  request-hash map at 500, so a client inventing application ids cannot grow
  memory or open files without limit; eviction is safe because a recreated
  ledger resumes its chain from the spool tail (`proxy.ts:242-276`).
- **Path-traversal-safe filenames.** Application ids are sanitized to
  `[A-Za-z0-9._-]`, truncated to 64 chars, and defaulted to `proxy`, so a
  crafted id cannot escape the ledger directory or collide across the hash chain
  (`proxy.ts:250-276,283-286`; test at `proxy.test.ts:290-302`).
- **The meter cannot throw into the request path.** Reduction never throws (a
  failure returns the original request); the entire ledger + blind-features write
  is inside a try/catch that swallows failures; a stream whose usage cannot be
  read produces an UNPRICED event, never a guessed one
  (`proxy.ts:28-37,358-359,474-555`).

## Known gaps — being fixed in Phase 0

These are real and acknowledged. None of them lets an attacker steal the key or
forge quota, because **the proxy injects no credentials of its own** — a request
it is tricked into relaying carries only whatever key the caller already had.

- **No CSRF / Origin check.** The Host allowlist stops DNS rebinding, but a
  browser page can still issue a same-origin-irrelevant `POST` to
  `http://127.0.0.1:8787/v1/messages` (a simple request, no preflight). The
  proxy will relay it upstream and write a spool event. Impact ceiling is **DoS /
  noise** — forced upstream relays and spool writes — **not key or quota theft**:
  the browser cannot read a response it isn't allowed to see, and MESH adds no
  credential, so a relay only spends the key the caller's own environment already
  supplies. Fix: an `Origin`/`Sec-Fetch-Site` check rejecting cross-site browser
  requests.
- **World-readable spool files.** `appendFileSync` is called with no mode
  (`packages/sdk-js/src/savings-ledger.ts:307`), so spools are created at the
  process umask — typically `0644`, world-readable. They hold metadata only (no
  prompts, no keys), but a co-tenant on a shared host can read another user's
  usage numbers and lever history. Fix: create spools `0600` and the ledger
  directory `0700`.
- **No concurrency bound.** Nothing caps simultaneous in-flight upstream
  requests, so a local client can fan out unboundedly. Fix: a bounded in-flight
  count.
- **`hostAllowed` permits an empty Host.** `host === ""` is allowed
  (`proxy.ts:136`) to tolerate HTTP/1.0-style clients, but it also lets a
  request with no `Host` through the rebinding defense. Fix: tighten to require
  an explicitly-loopback Host.
- **502 / debug may reflect upstream internals.** The 502 body echoes the
  upstream error message (`proxy.ts:313-315,405-407`) and `MESH_PROXY_DEBUG=1`
  logs status, model, beta header and a 500-char snippet of the error body
  (`proxy.ts:481-487`). Neither logs credentials, but both can surface upstream
  internals. Fix: a generic 502 body and a tighter debug log.

## Concise threat model

- **Boundary:** the loopback interface. Trusting a loopback client is deliberate
  — it holds the key regardless.
- **Remote attacker:** out of scope by the `127.0.0.1` bind.
- **DNS rebinding:** neutralised by the Host allowlist (tested).
- **CSRF-to-localhost:** possible today; **impact ceiling is DoS / noise**, not
  key or quota theft, because the proxy injects no credentials.
- **Co-tenant on a shared host:** can currently read spool files, which are
  **metadata-only** (usage numbers, lever names, hashes — never prompts, never
  keys). Fixed by `0600`/`0700`.
- **The client:** trusted by design.

## Distribution-side

The channel that delivers the runtime has its own trust story, kept separate so
it is not conflated with the proxy's runtime posture:

- npm: provenance via OIDC, no long-lived token (`SECURITY.md`,
  `.github/workflows/release.yml`).
- website curl: sha256 integrity only, served same-origin, hand-committed — this
  is **integrity, not authenticity**, and is the subject of `RELEASE-SIGNING.md`.
