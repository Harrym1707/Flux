/**
 * Local-tier router — runnable prototype demo.
 *
 *   node --import tsx scripts/local-tier-demo.ts
 *
 * Runs a sample of mixed traffic through the local-tier router and shows which
 * requests would run on a local open-weight model (e.g. PrismML Bonsai on a
 * local OpenAI-compatible endpoint) instead of the expensive cloud model, and
 * what that saves — the cloud cost avoided, valued against MESH's own price
 * catalogue. Nothing is sent anywhere; this is the decision + economics only.
 */
import { publishedModelPrices } from "../packages/core/src/model-prices.js";
import {
  cloudCostAvoidedUsd,
  decideRoute,
  defaultLocalTierPolicy,
  type LocalTierRequest,
} from "../packages/core/src/local-tier.js";

const AT = new Date().toISOString().slice(0, 10);

// Operator policy: stand in for the two expensive cloud models on small,
// tool-free requests only. Off in production until the replay-gate proves the
// local model's answers hold; enabled here to demonstrate the routing.
const policy = defaultLocalTierPolicy({
  enabled: true,
  endpoint: "http://127.0.0.1:8080/v1",
  localModel: "bonsai",
  baselineModels: ["claude-sonnet-5-5", "gpt-5"],
  maxInputTokens: 4000,
});

type Sample = { label: string; req: LocalTierRequest; out: number };
const samples: Sample[] = [
  { label: "classify a short message", req: { provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 350, hasTools: false }, out: 40 },
  { label: "extract fields from a form", req: { provider: "openai", model: "gpt-5", inputTokens: 900, hasTools: false }, out: 120 },
  { label: "summarise a 1-page note", req: { provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1800, hasTools: false }, out: 300 },
  { label: "agent turn with tools", req: { provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1200, hasTools: true }, out: 200 },
  { label: "reason over a long document", req: { provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 48_000, hasTools: false }, out: 1200 },
  { label: "a request already on a cheap model", req: { provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 600, hasTools: false }, out: 80 },
];

let cloudSpend = 0;
let avoided = 0;
let routedLocal = 0;

const usd = (n: number) => `$${n.toFixed(5)}`;
console.log(`Local-tier router — demo  (prices as of ${AT})\n`);
console.log("REQUEST".padEnd(34) + "BASELINE".padEnd(22) + "ROUTE".padEnd(8) + "SAVES");
for (const s of samples) {
  const usage = { inputTokens: s.req.inputTokens, outputTokens: s.out };
  const cloudCost = cloudCostAvoidedUsd({ provider: s.req.provider, model: s.req.model }, usage, publishedModelPrices, AT);
  if (cloudCost !== null) cloudSpend += cloudCost;
  const d = decideRoute(s.req, policy);
  let saves = "—";
  if (d.route === "local") {
    routedLocal += 1;
    const saved = cloudCostAvoidedUsd(d.baseline, usage, publishedModelPrices, AT);
    if (saved !== null) { avoided += saved; saves = usd(saved) + " cloud cost avoided"; }
    else saves = "(baseline unpriced — recorded, unbilled)";
  } else {
    saves = `stays cloud · ${d.reason}`;
  }
  console.log(s.label.padEnd(34) + s.req.model.padEnd(22) + d.route.padEnd(8) + saves);
}

console.log("");
console.log(`Routed to local: ${routedLocal}/${samples.length} requests`);
console.log(`Cloud spend on this sample:     ${usd(cloudSpend)}`);
console.log(`Cloud cost avoided by local tier: ${usd(avoided)}  (${cloudSpend > 0 ? Math.round((avoided / cloudSpend) * 100) : 0}% of it)`);
console.log(`\nGross figures — the customer's own compute for the local model is netted off before any fee.`);
