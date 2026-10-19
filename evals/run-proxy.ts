import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFluxProxy } from "../packages/sdk-js/src/proxy.js";

/**
 * Boot the FLUX proxy locally. An application then needs ONE config change:
 * point its base_url here. Its own API key passes through untouched; FLUX
 * holds no credentials, prompts never leave the machine, and every request
 * appends one hash-chained ledger event under the spool directory.
 *
 *   FLUX_PROXY_PORT        port to listen on (default 8787)
 *   FLUX_PROXY_LEDGER_DIR  spool directory (default ./flux-ledger)
 *   FLUX_PROXY_CACHE_TTL   "5m" | "1h" to enable the Anthropic cache stamp
 *
 * Reduction is lossless-only by default (schema compaction, duplicate
 * removal, prefix repair). Lossy levers stay off until a replay gate approves
 * them on recorded traffic, exactly as in the SDK.
 */

const port = Number(process.env.FLUX_PROXY_PORT ?? 8787);
const ledgerDirectory = process.env.FLUX_PROXY_LEDGER_DIR ?? join(process.cwd(), "flux-ledger");
mkdirSync(ledgerDirectory, { recursive: true });

const cacheTtl = process.env.FLUX_PROXY_CACHE_TTL;
if (cacheTtl !== undefined && cacheTtl !== "5m" && cacheTtl !== "1h") {
  throw new Error(`FLUX_PROXY_CACHE_TTL must be "5m" or "1h", got ${JSON.stringify(cacheTtl)}.`);
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

console.log(`FLUX proxy listening on ${proxy.url}`);
console.log(`Ledger spools: ${ledgerDirectory} (one hash-chained JSONL per app + provider)`);
console.log("");
console.log("Point a client here, keeping its own key:");
console.log(`  Anthropic SDK:  new Anthropic({ baseURL: "${proxy.url}" })`);
console.log(`  OpenAI SDK:     new OpenAI({ baseURL: "${proxy.url}/v1" })`);
console.log(`  curl:           ${proxy.url}/v1/messages | /v1/responses | /v1/chat/completions`);
console.log("");
console.log("Optional header X-Flux-Application names the app on the invoice.");
console.log("Ctrl-C to stop.");
