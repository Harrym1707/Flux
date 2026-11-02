/**
 * Build the shippable FLUX CLI as THREE artifacts:
 *
 *   pkg/flux               the tiny bootstrap users download. Contains no
 *                          product code — it fetches, checksum-verifies, caches
 *                          and runs the runtime, and self-updates.
 *   pkg/flux-runtime       the client runtime (proxy + reducer + ledger + Theo),
 *                          scoped: no `analyse`, so billing/router/observability
 *                          code never ships. Stamped with the git commit.
 *   pkg/flux-version.json  { version, sha256, runtime } — the update manifest
 *                          the bootstrap checks and verifies against.
 *
 * Hosting: /flux = bootstrap, /flux-runtime = runtime, /flux-version.json.
 * npm: @flux-ai/flux ships the self-contained runtime as its `flux` bin (npm
 * handles versioning there, so no bootstrap/CDN dependency on that path).
 *
 * Nothing here contacts a registry; it smoke-tests the runtime by running
 * `flux-runtime verify`.
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const esbuild = require_(
  path.join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"),
) as typeof import("esbuild");

const cliDir = path.join(root, "packages/cli");
const outDir = path.join(cliDir, "pkg");

const commit = (() => {
  try { return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); }
  catch { return "unknown"; }
})();
const version = (() => {
  const pkg = require_(path.join(cliDir, "package.json")) as { version?: string };
  return pkg.version ?? "0.0.0";
})();

const BANNER = `#!/usr/bin/env node
import { createRequire as __cr } from "node:module";
const require = __cr(import.meta.url);`;

function bundle(entry: string, outfile: string, define: Record<string, string> = {}): void {
  const result = esbuild.buildSync({
    entryPoints: [path.join(cliDir, "src", entry)],
    bundle: true, platform: "node", format: "esm", target: "node20",
    outfile, banner: { js: BANNER }, define, logLevel: "warning",
  });
  if (result.errors.length > 0) { console.error(`esbuild failed on ${entry}`); process.exit(1); }
  chmodSync(outfile, 0o755);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. The runtime (scoped client entry), stamped with the commit.
const runtimeFile = path.join(outDir, "flux-runtime");
bundle("flux-runtime.ts", runtimeFile, { __FLUX_BUILD_COMMIT__: JSON.stringify(commit) });
const runtimeBytes = readFileSync(runtimeFile);
const runtimeSha = createHash("sha256").update(runtimeBytes).digest("hex");

// 2. The bootstrap (the tiny download).
const bootstrapFile = path.join(outDir, "flux");
bundle("bootstrap.ts", bootstrapFile);

// 3. The update manifest the bootstrap verifies against.
writeFileSync(
  path.join(outDir, "flux-version.json"),
  `${JSON.stringify({ version: commit, sha256: runtimeSha, runtime: "flux-runtime" }, null, 2)}\n`,
);

// npm manifest: ship the SELF-CONTAINED runtime as the `flux` bin (npm versions
// it, so no CDN/bootstrap there). The website download is the bootstrap.
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify({
  name: "@flux-ai/flux",
  version,
  description: "Cut your LLM bill, verified on your own usage. One command points Claude Code at FLUX and runs Theo alongside you.",
  type: "module",
  bin: { flux: "./flux-runtime" },
  files: ["flux-runtime", "README.md"],
  engines: { node: ">=20" },
  keywords: ["llm", "anthropic", "claude", "claude-code", "proxy", "cost", "tokens", "flux"],
  license: "BUSL-1.1",
  homepage: "https://www.fluxtoken.dev",
  repository: { type: "git", url: "git+https://github.com/Harrym1707/Flux.git" },
}, null, 2)}\n`);

writeFileSync(path.join(outDir, "README.md"), `# flux

Cut your LLM bill — verified on your own usage, never an estimate.

## Install

Download one small file (needs Node 20+); it fetches and verifies the runtime,
then keeps it up to date:

\`\`\`sh
curl -fsSL https://www.fluxtoken.dev/flux -o flux && chmod +x flux && ./flux start
\`\`\`

…or with npm:

\`\`\`sh
npx @flux-ai/flux start
\`\`\`

## Commands

\`\`\`sh
./flux start      # proxy + point Claude Code at it + Theo; reverts on exit
./flux install    # always-on background service (macOS)
./flux status     # is it up, and what has Theo saved
./flux verify     # re-prove the build, ledger chain, and invoice
\`\`\`

Your API key never leaves Claude Code. Build: ${commit}.
`);

// Smoke test: the runtime must run and pass its own self-checks.
const smoke = execSync(`node ${JSON.stringify(runtimeFile)} verify`, { cwd: root }).toString();
if (!smoke.includes("All checks passed")) {
  console.error("Smoke test FAILED — runtime did not pass `verify`:\n" + smoke);
  process.exit(1);
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
console.log(`built CLI artifacts  (build ${commit}, v${version})`);
console.log(`  flux (bootstrap)   ${kb(readFileSync(bootstrapFile).length)}  → the download`);
console.log(`  flux-runtime       ${kb(runtimeBytes.length)}  sha256 ${runtimeSha.slice(0, 12)}…`);
console.log(`  flux-version.json  update manifest`);
console.log(`  smoke test: flux-runtime verify — All checks passed`);
console.log(`  publish npm with:  (cd ${path.relative(root, outDir)} && npm publish --access public)`);
