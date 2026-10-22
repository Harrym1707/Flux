# Security

FLUX asks you to point API traffic carrying your real provider key at a local
proxy. You should not take that on trust. This page is what to check and how
to reach us.

## Verify before you run

- **Zero runtime dependencies, no install scripts.** `npm view @flux-ai/sdk
  dependencies scripts` returns nothing: installing the package executes no
  code and pulls in no third-party packages. Every `require` in the published
  bundles is a `node:` builtin (crypto, fs, http, path). Browse the full
  package contents on npmjs.com, or `npm pack @flux-ai/sdk && tar -tzf *.tgz`
  — a handful of readable files, no opaque blobs.
- **Provenance.** Releases published from `release.yml` carry an npm
  provenance attestation linking the tarball to a tagged commit of
  [Harrym1707/Flux](https://github.com/Harrym1707/Flux) built on GitHub
  Actions: `npm audit signatures` verifies it. (Versions up to 0.1.1 were
  founder-published before the pipeline existed; the next release onward is
  attested.)
- **Where traffic goes.** The proxy binds to 127.0.0.1 and forwards only to
  the upstream you configure — `https://api.anthropic.com` /
  `https://api.openai.com` by default. Your API key passes through verbatim
  to that upstream and is never stored, logged, or written to the ledger.
  The ledger records usage numbers, lever names and hashes — never prompt
  content, never credentials.
- **Telemetry is off.** The optional telemetry client does nothing unless you
  explicitly configure an endpoint of your own; it sends usage metadata only,
  never prompts, and strips provider error text before sending.

If anything doesn't match — an unexpected dependency, an install script, a
failed signature, outbound traffic you didn't configure — don't run it, and
tell us.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), or open an issue for anything that is
not sensitive. Findings that affect key handling or the privacy promise are
treated as release blockers.
