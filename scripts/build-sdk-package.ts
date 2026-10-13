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

const workspaceManifest = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

// Artifact manifest only: no `private`, no workspace:* anywhere, zero runtime deps.
const manifest = {
  name: workspaceManifest.name,
  version: workspaceManifest.version,
  description: "FLUX SDK: drop-in OpenAI-compatible wrapper that reduces LLM costs and meters verified savings into an append-only, customer-recomputable ledger.",
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
  bin: { "flux-quote": "./bin/flux-quote.mjs" },
  files: ["index.js", "index.cjs", "bin", "types", "README.md"],
  engines: { node: ">=18" },
};
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

writeFileSync(path.join(outDir, "README.md"), `# @flux-ai/sdk

Wrap an OpenAI-compatible client; FLUX reduces what each request costs and,
when the opt-in ledger is enabled, meters VERIFIED savings into an append-only,
hash-chained JSONL file you can recompute into the invoice yourself.

\`\`\`js
import { withFlux } from "@flux-ai/sdk"; // or require("@flux-ai/sdk")

const client = withFlux(openai, {
  applicationId: "my-app",
  ledger: { path: "./flux-ledger.jsonl" }, // opt-in savings meter
});
\`\`\`

The wrapper never changes your responses; the meter never throws into the
request path. Recompute the invoice from your own spool with
\`recomputeInvoice\` / \`verifyLedgerChain\`, both exported here.
`, "utf8");

console.log(`artifact ready at ${path.relative(root, outDir)}`);
