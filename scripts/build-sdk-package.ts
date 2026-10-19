/**
 * Build the npm-pack-able @flux-ai/sdk artifact.
 *
 *   node --import tsx scripts/build-sdk-package.ts
 *
 * Produces packages/sdk-js/pkg/ containing:
 *   - index.js  (ESM bundle, @flux/core inlined)
 *   - index.cjs (CJS bundle, same sources)
 *   - types/    (the package's .d.ts plus the core .d.ts it re-exports,
 *                with the workspace-relative core import rewritten)
 *   - package.json (artifact manifest: no private flag, no workspace refs)
 *
 * The workspace package.json files are untouched; only the ARTIFACT manifest
 * is publishable-shaped. Nothing here ever contacts a registry: validation is
 * `npm pack` plus installing the tarball into a scratch directory.
 *
 * esbuild is invoked through its JS API with an explicit resolve into the
 * pnpm store, because this repo has no .bin/esbuild shim and no pnpm.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
// Explicit resolve: there is deliberately no CLI call and no npm/pnpm script here.
const esbuild = require_(
  path.join(root, "node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild"),
) as typeof import("esbuild");

const sdkDir = path.join(root, "packages/sdk-js");
const coreDist = path.join(root, "packages/core/dist/src");
const sdkDist = path.join(sdkDir, "dist/src");
const outDir = path.join(sdkDir, "pkg");
const entry = path.join(sdkDir, "src/index.ts");
const CORE_SPECIFIER = "../../core/dist/src/index.js";

for (const dist of [coreDist, sdkDist]) {
  if (!existsSync(dist)) {
    console.error(`Missing ${dist}; run ./node_modules/.bin/tsc -b first.`);
    process.exit(1);
  }
}

// Freshness gate: the JS bundles build straight from src, but the published
// .d.ts files are copied from dist. A stale dist would silently ship types
// that disagree with the code, so any src file newer than its dist twin fails
// the build with the fix spelled out.
function newestMtime(dir: string, suffix: string, excludeSuffix?: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    if (excludeSuffix !== undefined && name.endsWith(excludeSuffix)) continue;
    const mtime = statSync(path.join(dir, name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}
// Incremental tsc leaves unchanged outputs untouched, so the witness of a
// completed build is the .tsbuildinfo stamp, not the .d.ts mtimes.
function buildStamp(packageDir: string): number {
  let newest = 0;
  for (const name of readdirSync(packageDir)) {
    if (!name.endsWith(".tsbuildinfo")) continue;
    const mtime = statSync(path.join(packageDir, name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}
for (const [srcDir, distDir, label] of [
  [path.join(root, "packages/core/src"), coreDist, "core"],
  [path.join(sdkDir, "src"), sdkDist, "sdk-js"],
] as const) {
  const srcNewest = newestMtime(srcDir, ".ts", ".test.ts");
  const packageDir = path.resolve(distDir, "../..");
  const distNewest = Math.max(newestMtime(distDir, ".d.ts"), buildStamp(packageDir), buildStamp(path.join(packageDir, "dist")));
  if (srcNewest > distNewest) {
    console.error(
      `STALE DIST: ${label} src is newer than its dist declarations. ` +
      "Run ./node_modules/.bin/tsc -b before packaging, or the published types would not match the code.",
    );
    process.exit(1);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, "types/core"), { recursive: true });

for (const format of ["esm", "cjs"] as const) {
  const outfile = path.join(outDir, format === "esm" ? "index.js" : "index.cjs");
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node18",
    format,
    outfile,
    sourcemap: false,
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    console.error(`esbuild ${format} bundle failed:`, result.errors);
    process.exit(1);
  }
  console.log(`bundled ${path.relative(root, outfile)}`);
}

function copyDeclarations(fromDir: string, toDir: string, rewriteCore: boolean): number {
  let copied = 0;
  for (const name of readdirSync(fromDir)) {
    if (!name.endsWith(".d.ts") || name.endsWith(".test.d.ts")) continue;
    const target = path.join(toDir, name);
    if (rewriteCore) {
      const text = readFileSync(path.join(fromDir, name), "utf8");
      writeFileSync(target, text.split(CORE_SPECIFIER).join("./core/index.js"), "utf8");
    } else {
      copyFileSync(path.join(fromDir, name), target);
    }
    copied += 1;
  }
  return copied;
}

const sdkTypes = copyDeclarations(sdkDist, path.join(outDir, "types"), true);
const coreTypes = copyDeclarations(coreDist, path.join(outDir, "types/core"), false);
console.log(`copied ${sdkTypes} sdk + ${coreTypes} core declaration file(s)`);

// The packaged flux-quote CLI: the five-minute design-partner experience.
// Plain JS against the bundled entry, so the artifact stays dependency-free.
mkdirSync(path.join(outDir, "bin"), { recursive: true });
writeFileSync(path.join(outDir, "bin/flux-quote.mjs"), `#!/usr/bin/env node
// Pre-contract savings quote from YOUR gateway export (LiteLLM, Helicone or
// Langfuse), including the honest "do not pay us" verdict.
//
//   flux-quote <export-file> [--format litellm|helicone|langfuse]
//              [--at YYYY-MM-DD] [--out quote.json]
import { readFileSync, writeFileSync } from "node:fs";
import { buildQuoteReport, canonicalJson, publishedModelPrices, renderQuoteReport } from "../index.js";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--")) {
  fail("Usage: flux-quote <export-file> [--format litellm|helicone|langfuse] [--at YYYY-MM-DD] [--out quote.json]");
}
const file = args[0];
let format = "litellm";
let at = new Date().toISOString().slice(0, 10);
let out;
for (let index = 1; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (value === undefined) fail(\`Missing value for \${flag}.\`);
  if (flag === "--format") {
    if (!["litellm", "helicone", "langfuse"].includes(value)) fail(\`Unknown format \${value}.\`);
    format = value;
  } else if (flag === "--at") at = value;
  else if (flag === "--out") out = value;
  else fail(\`Unknown flag \${flag}.\`);
}

const text = readFileSync(file, "utf8").trim();
const rows = text.startsWith("[")
  ? JSON.parse(text)
  : text.split(/\\r?\\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

const report = buildQuoteReport(rows, { format, at, catalogue: publishedModelPrices });
console.log(renderQuoteReport(report));
if (out !== undefined) {
  writeFileSync(out, \`\${canonicalJson(report)}\\n\`, "utf8");
  console.error(\`\\nShareable report written to \${out}\`);
}
`, "utf8");

writeFileSync(path.join(outDir, "bin/flux-proxy.mjs"), `#!/usr/bin/env node
// FLUX proxy mode: point your client's base_url here, keep your own API key.
// Requests are reduced before they reach the provider, responses (including
// SSE streams) return byte-identical, and every request appends one
// hash-chained ledger event. Lossless levers only by default.
//
//   FLUX_PROXY_PORT        default 8787
//   FLUX_PROXY_LEDGER_DIR  default ./flux-ledger
//   FLUX_PROXY_CACHE_TTL   "5m" | "1h" to enable the Anthropic cache stamp
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFluxProxy } from "../index.js";

const port = Number(process.env.FLUX_PROXY_PORT ?? 8787);
const ledgerDirectory = process.env.FLUX_PROXY_LEDGER_DIR ?? join(process.cwd(), "flux-ledger");
mkdirSync(ledgerDirectory, { recursive: true });
const cacheTtl = process.env.FLUX_PROXY_CACHE_TTL;
if (cacheTtl !== undefined && cacheTtl !== "5m" && cacheTtl !== "1h") {
  console.error(\`FLUX_PROXY_CACHE_TTL must be "5m" or "1h", got \${JSON.stringify(cacheTtl)}.\`);
  process.exit(1);
}
const proxy = await startFluxProxy({
  port,
  ledgerDirectory,
  tokenReduction: {
    toolSchemas: true,
    duplicateContext: true,
    repairCachePrefix: true,
    ...(cacheTtl === undefined ? {} : { cacheTtl }),
  },
});
console.log(\`FLUX proxy listening on \${proxy.url}\`);
console.log(\`Ledger spools: \${ledgerDirectory}\`);
console.log(\`Anthropic SDK: new Anthropic({ baseURL: "\${proxy.url}" })\`);
console.log(\`OpenAI SDK:    new OpenAI({ baseURL: "\${proxy.url}/v1" })\`);
`, "utf8");

const workspaceManifest = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

// Artifact manifest only: no `private`, no workspace:* anywhere, zero runtime deps.
const manifest = {
  name: workspaceManifest.name,
  version: workspaceManifest.version,
  description: "Cut LLM API costs on Claude and OpenAI: one-URL proxy or one-line SDK wrapper that reduces each request losslessly and meters VERIFIED savings into an append-only, customer-recomputable ledger. Pay only a share of verified savings.",
  license: "UNLICENSED",
  type: "module",
  main: "./index.cjs",
  module: "./index.js",
  types: "./types/index.d.ts",
  exports: {
    ".": {
      types: "./types/index.d.ts",
      import: "./index.js",
      require: "./index.cjs",
    },
  },
  bin: { "flux-quote": "./bin/flux-quote.mjs", "flux-proxy": "./bin/flux-proxy.mjs" },
  files: ["index.js", "index.cjs", "bin", "types", "README.md"],
  engines: { node: ">=18" },
};
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

writeFileSync(path.join(outDir, "README.md"), `# @flux-ai/sdk

Cut LLM API costs on Claude (Anthropic), OpenAI, and OpenAI-compatible APIs.
FLUX reduces each request losslessly before it is sent and meters VERIFIED
savings into an append-only, hash-chained JSONL ledger you can recompute into
the invoice yourself. The fee is a share of verified savings; a period that
saved nothing says do_not_charge.

## Proxy mode: no code changes

\`\`\`bash
npx flux-proxy   # then point your client's base_url at it
\`\`\`

\`\`\`js
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
\`\`\`

Your API key passes through verbatim (FLUX never holds credentials), responses
— SSE streams included — return byte-identical, and every request appends one
ledger event. Prompts never leave your machine: the ledger records usage
numbers, lever names and hashes, not content.

## SDK mode: one line

\`\`\`js
import { withFlux } from "@flux-ai/sdk"; // or require("@flux-ai/sdk")

const client = withFlux(anthropic, {
  applicationId: "my-app",
  tokenReduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
  ledger: { path: "./flux-ledger.jsonl", provider: "anthropic" },
});
\`\`\`

Wraps Anthropic messages.create, OpenAI responses.create and
chat.completions.create on one shared hash chain. The wrapper never changes
your responses; the meter never throws into the request path.

## Quote from your gateway export

\`\`\`bash
npx flux-quote your-export.jsonl --format litellm   # or helicone | langfuse
\`\`\`

Includes the honest "do not pay us" verdict for already-optimised stacks.
Recompute any invoice from your own spool with \`recomputeInvoice\` /
\`verifyLedgerChain\`, both exported here.
`, "utf8");

console.log(`artifact ready at ${path.relative(root, outDir)}`);
