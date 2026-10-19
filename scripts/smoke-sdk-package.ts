/**
 * Cold-install smoke for the packaged @flux-ai/sdk artifact.
 *
 *   node --import tsx scripts/build-sdk-package.ts && node --import tsx scripts/smoke-sdk-package.ts
 *
 * Everything is LOCAL: `npm pack` writes a tarball, the tarball is installed
 * into a scratch directory with --offline semantics (the package has zero
 * runtime dependencies), and both module systems plus both bins are exercised
 * the way a cold npm user would hit them. Nothing here ever contacts a
 * registry, and nothing here publishes anything.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "packages/sdk-js/pkg");

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
}

function fail(message: string): never {
  console.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

// 1. Pack the artifact (local tarball, no registry).
run("npm", ["pack", "--ignore-scripts"], pkgDir);
const tarball = readdirSync(pkgDir).find((name) => name.endsWith(".tgz"));
if (tarball === undefined) fail("npm pack produced no tarball.");
console.log(`packed ${tarball}`);

// 2. Cold install into a scratch project.
const scratch = mkdtempSync(path.join(tmpdir(), "flux-smoke-"));
writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: "smoke", private: true }), "utf8");
run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", path.join(pkgDir, tarball)], scratch);
console.log("cold install ok");

// 3. CJS require: the entry loads and the core surface is present.
const cjsCheck = `
const sdk = require("@flux-ai/sdk");
const needed = ["withFlux", "startFluxProxy", "reduceRequest", "recomputeInvoice", "verifyLedgerChain", "createSavingsLedger"];
for (const name of needed) {
  if (typeof sdk[name] !== "function") { console.error("missing export " + name); process.exit(1); }
}
console.log("cjs ok");
`;
writeFileSync(path.join(scratch, "check.cjs"), cjsCheck, "utf8");
console.log(run("node", ["check.cjs"], scratch).trim());

// 4. ESM import, a reduction actually reducing, and the proxy booting on a
// free port then refusing an unknown route — the full cold-user surface.
const esmCheck = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceRequest, startFluxProxy, recomputeInvoice } from "@flux-ai/sdk";

const block = "Clause 4471 applies to every refund older than thirty days and must be cited in full. ".repeat(3);
const { summary } = reduceRequest({
  model: "claude-sonnet-5-5-20260514",
  system: "You are terse.",
  messages: [{ role: "user", content: block + "\\n\\n" + block + "\\n\\nSummarise." }],
  max_tokens: 100,
}, { duplicateContext: true });
if (summary.skipped || summary.estimatedTokensSaved <= 0) { console.error("reduction did not reduce"); process.exit(1); }

const proxy = await startFluxProxy({ ledgerDirectory: mkdtempSync(join(tmpdir(), "flux-smoke-ledger-")) });
const res = await fetch(proxy.url + "/v1/other", { method: "POST", body: "{}" });
if (res.status !== 404) { console.error("proxy route guard failed: " + res.status); process.exit(1); }
await proxy.close();

const invoice = recomputeInvoice([]);
if (invoice.verdict !== "do_not_charge") { console.error("empty invoice must be do_not_charge"); process.exit(1); }
console.log("esm + proxy + invoice ok");
`;
writeFileSync(path.join(scratch, "check.mjs"), esmCheck, "utf8");
console.log(run("node", ["check.mjs"], scratch).trim());

// 5. Both bins are wired and respond to a cold invocation.
const quoteUsage = (() => {
  try {
    run("node", ["node_modules/.bin/flux-quote"], scratch);
    return "";
  } catch (cause) {
    return String((cause as { stderr?: string }).stderr ?? "");
  }
})();
if (!quoteUsage.includes("Usage: flux-quote")) fail("flux-quote bin did not print usage.");
console.log("flux-quote bin ok");

// A plain invocation would listen forever, so the cold check for the proxy
// bin is its own config guard: a bogus TTL must exit immediately with the
// documented message, proving the bin resolves its import and runs.
const proxyTtlGuard = (() => {
  try {
    execFileSync("node", ["node_modules/.bin/flux-proxy"], {
      cwd: scratch, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, FLUX_PROXY_CACHE_TTL: "bogus" },
    });
    return "";
  } catch (cause) {
    return String((cause as { stderr?: string }).stderr ?? "");
  }
})();
if (!proxyTtlGuard.includes('FLUX_PROXY_CACHE_TTL must be "5m" or "1h"')) {
  fail("flux-proxy bin did not validate FLUX_PROXY_CACHE_TTL.");
}
console.log("flux-proxy bin ok");

rmSync(scratch, { recursive: true, force: true });
rmSync(path.join(pkgDir, tarball), { force: true });
console.log("SMOKE PASSED: the tarball installs cold and every advertised surface works.");
