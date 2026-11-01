/**
 * Build the shippable FLUX CLI: one self-contained file users download and run.
 *
 *   node --import tsx scripts/build-cli-package.ts
 *
 * Produces packages/cli/pkg/ containing:
 *   - flux          the single ESM bundle (core + sdk inlined), `#!/usr/bin/env
 *                   node` shebang, chmod +x. THIS is the downloadable artifact.
 *   - package.json  a publishable manifest (@flux-ai/flux, bin: flux), so
 *                   `npx @flux-ai/flux start` works too. No private flag, no
 *                   workspace refs — everything is already inlined.
 *   - README.md     install + usage.
 *
 * The bundle is stamped with the current git commit so `flux verify` can report
 * exactly which build a user is running. Nothing here contacts a registry; it
 * smoke-tests the artifact by running `flux verify` from a scratch dir.
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
// Explicit resolve into the pnpm store: this repo has no .bin/esbuild shim.
const esbuild = require_(
  path.join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"),
) as typeof import("esbuild");

const cliDir = path.join(root, "packages/cli");
const outDir = path.join(cliDir, "pkg");
const entry = path.join(cliDir, "src/main.ts");
const outFile = path.join(outDir, "flux");

const commit = (() => {
  try { return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); }
  catch { return "unknown"; }
})();
const version = (() => {
  const pkg = require_(path.join(cliDir, "package.json")) as { version?: string };
  return pkg.version ?? "0.0.0";
})();

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// A node ESM bundle, run as `./flux`. The createRequire shim lets any inlined
// CommonJS dependency call require() under ESM; node builtins stay external.
const BANNER = `#!/usr/bin/env node
import { createRequire as __cr } from "node:module";
const require = __cr(import.meta.url);`;

const result = esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
  banner: { js: BANNER },
  define: { __FLUX_BUILD_COMMIT__: JSON.stringify(commit) },
  logLevel: "warning",
});
if (result.errors.length > 0) { console.error("esbuild failed"); process.exit(1); }
chmodSync(outFile, 0o755);

// Publishable manifest. The workspace package stays private and untouched; this
// artifact manifest is what ships. Everything is inlined, so no dependencies.
const manifest = {
  name: "@flux-ai/flux",
  version,
  description: "Cut your LLM bill, verified on your own usage. One command points Claude Code at FLUX and runs Theo alongside you.",
  type: "module",
  bin: { flux: "./flux" },
  files: ["flux", "README.md"],
  engines: { node: ">=20" },
  keywords: ["llm", "anthropic", "claude", "claude-code", "proxy", "cost", "tokens", "flux"],
  license: "BUSL-1.1",
  homepage: "https://www.fluxtoken.dev",
  repository: { type: "git", url: "git+https://github.com/Harrym1707/Flux.git" },
};
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const README = `# flux

Cut your LLM bill — verified on your own usage, never an estimate.

FLUX sits in front of your Anthropic traffic (Claude Code, the SDK, any tool
that honours a custom base URL), strips wasted tokens **losslessly**, and keeps
a hash-chained ledger you can recompute yourself. **Theo**, your token engineer,
runs alongside you and reports only savings he can prove.

## Install

Download the single file and make it runnable (needs Node 20+):

\`\`\`sh
curl -fsSL https://www.fluxtoken.dev/flux -o flux && chmod +x flux
\`\`\`

…or with npm:

\`\`\`sh
npx @flux-ai/flux start
\`\`\`

## Use it with Claude Code

\`\`\`sh
./flux start      # starts the proxy, points Claude Code at it, runs Theo
                  # …use Claude Code exactly as normal…
                  # Ctrl+C to stop — Claude Code reverts cleanly
./flux verify     # re-prove the build, the ledger chain, and the invoice
\`\`\`

\`flux start\` never reads or stores your API key: your own credential stays in
Claude Code and is passed straight through. It writes \`ANTHROPIC_BASE_URL\` into
\`~/.claude/settings.json\` while running and removes it on exit.

Build: ${commit}.
`;
writeFileSync(path.join(outDir, "README.md"), README);

// Smoke test: the artifact must run and pass its own self-checks.
const smoke = execSync(`node ${JSON.stringify(outFile)} verify`, { cwd: root }).toString();
if (!smoke.includes("All checks passed")) {
  console.error("Smoke test FAILED — artifact did not pass `flux verify`:\n" + smoke);
  process.exit(1);
}

console.log(`built ${path.relative(root, outFile)}  (build ${commit}, v${version})`);
console.log(`  npm name: @flux-ai/flux   bin: flux`);
console.log(`  smoke test: flux verify — All checks passed`);
console.log(`  publish with:  (cd ${path.relative(root, outDir)} && npm publish --access public)`);
