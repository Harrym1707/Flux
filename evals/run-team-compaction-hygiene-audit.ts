import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  catalogueVersion,
  eventProviderCostUsd,
  lookupPrice,
  normalizeProviderUsage,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type TokenPrice,
} from "../packages/core/src/index.js";
import {
  auditCompactionSession,
  billableEventFromRequest,
  compactionAdviceLines,
  compactionEventField,
  type FluxRequestEvent,
} from "../packages/sdk-js/src/index.js";
import { buildSessions, simRequests, type FixtureCall, type FixtureSession } from "./run-team-compaction-audit.js";

/**
 * Pricing eval for the compaction-hygiene audit (lossless, advise-only).
 *
 *   node --import tsx evals/run-team-compaction-hygiene-audit.ts
 *
 * Part 1 - ledger correctness: every compaction response in the fixture is
 * run through the REAL ledger path (normalizeProviderUsage -> FluxRequestEvent
 * -> billableEventFromRequest) and compared with the provider bill, priced as
 * "sum across all entries in the usage.iterations array" at catalogued Opus
 * 5.5 rates. "Before" is the pre-fix ledger figure (top-level usage only,
 * which the fix leaves byte-identical in `actualUsd`); "after" adds the new
 * customer-attributed `compaction.usd`.
 *
 * Part 2 - waste per misuse case: each 30-turn session is priced through
 * simulateCache at catalogued Opus 5.5 rates under the 5m prompt cache (the
 * counterfactual is a CACHED agent - net of what the agent already does) and,
 * as a sensitivity, with no cache. A new cache epoch (case E only) means no
 * earlier entry is reachable, which is what threshold compaction does to a
 * route whose only breakpoints sit in the dropped history.
 *
 * Basis: derived-from-fixture. The fixture's sizes are inventions; token
 * counts are approximateTokenCount (+/-28%); prevalence is UNMEASURED (no
 * FLUX capture uses the compaction beta).
 */

const AT = "2026-10-28";
const lookup = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Opus 5.5", at: AT });
if (lookup.status !== "priced") throw new Error(`Opus 5.5 is not priced on ${AT}: ${lookup.reason}`);
const price: TokenPrice = lookup.price;
const usd = (value: number): string => `$${value.toFixed(4)}`;
const pct = (value: number): string => `${value.toFixed(2)}%`;

// ---------------------------------------------------------------------------
// Part 1: ledger before/after on every compaction event in the fixture
// ---------------------------------------------------------------------------

type AnyObject = Record<string, any>;

function providerBillUsd(response: AnyObject): number {
  // The docs' rule: total billed = sum across usage.iterations. Fixture
  // iterations carry no cache fields, so every input token is at the base rate.
  const iterations: AnyObject[] = response.usage.iterations ?? [];
  return iterations.reduce((sum, entry) =>
    sum + (entry.input_tokens / 1e6) * price.inputPerMillion + (entry.output_tokens / 1e6) * price.outputPerMillion, 0);
}

function ledgerEvent(response: AnyObject, index: number) {
  const normalized = normalizeProviderUsage(response);
  if (normalized.status !== "ok") throw new Error("fixture usage must normalise");
  const compaction = compactionEventField([response]);
  const event: FluxRequestEvent = {
    requestId: `fixture-${index}`,
    applicationId: "compaction-fixture",
    provider: "anthropic-compatible",
    model: "claude-opus-5-5",
    latencyMs: 0,
    status: "succeeded",
    timestamp: `${AT}T12:00:00.000Z`,
    inputTokens: normalized.usage.inputTokens,
    outputTokens: normalized.usage.outputTokens,
    uncachedInputTokens: normalized.usage.uncachedInputTokens,
    cachedInputTokens: normalized.usage.cachedInputTokens,
    cacheWriteInputTokens: normalized.usage.cacheWriteInputTokens,
    ...(compaction === undefined ? {} : { compaction }),
  };
  return billableEventFromRequest(event, { path: "unused", provider: "anthropic" }, publishedModelPrices,
    catalogueVersion(publishedModelPrices));
}

const sessions = buildSessions();
console.log("== Part 1: ledger vs provider bill on compaction events (Opus 5.5 catalogued rates) ==");
console.log("case                               events  provider bill  ledger BEFORE  error/event(avg)  ledger AFTER  error  FLUX savings delta");
let totalEvents = 0;
let totalBill = 0;
let totalBefore = 0;
let totalAfter = 0;
for (const session of sessions) {
  let events = 0;
  let bill = 0;
  let before = 0;
  let after = 0;
  let savingsDelta = 0;
  session.pairs.forEach((pair, index) => {
    const response = pair.response as AnyObject;
    const hasCompaction = (response.usage.iterations ?? []).some((entry: AnyObject) => entry.type === "compaction");
    if (!hasCompaction) return;
    events += 1;
    const billed = ledgerEvent(response, index);
    bill += providerBillUsd(response);
    before += billed.actualUsd ?? 0;
    after += eventProviderCostUsd(billed) ?? Number.NaN;
    const stripped = structuredClone(response);
    delete stripped.usage.iterations;
    const plain = ledgerEvent(stripped, index);
    const leverSum = (levers: Array<{ savedUsd?: number }>) => levers.reduce((sum, lever) => sum + (lever.savedUsd ?? 0), 0);
    savingsDelta += leverSum(billed.levers) - leverSum(plain.levers);
  });
  totalEvents += events;
  totalBill += bill;
  totalBefore += before;
  totalAfter += after;
  console.log(`${session.id.padEnd(36)} ${String(events).padStart(5)}  ${usd(bill).padStart(13)}  ${usd(before).padStart(13)}  ` +
    `${usd(events === 0 ? 0 : (before - bill) / events).padStart(16)}  ${usd(after).padStart(12)}  ${usd(after - bill).padStart(7)}  ${usd(savingsDelta)}`);
}
console.log(`ALL: ${totalEvents} compaction events; provider bill ${usd(totalBill)}; ledger before ${usd(totalBefore)} ` +
  `(under-stated by ${usd(totalBill - totalBefore)} = ${pct(((totalBill - totalBefore) / totalBill) * 100)}, ` +
  `${usd((totalBill - totalBefore) / totalEvents)}/event); ledger after ${usd(totalAfter)} (error ${usd(totalAfter - totalBill)}).`);

// ---------------------------------------------------------------------------
// Part 2: session bills through simulateCache and the waste per misuse case
// ---------------------------------------------------------------------------

type Priced = { total: number; compactionUsd: number; messageUsd: number; calls: number };

function priceSession(calls: FixtureCall[], policy: CachePolicy): Priced {
  const epochs = [...new Set(calls.map((call) => call.epoch))];
  let total = 0;
  let compactionUsd = 0;
  for (const epoch of epochs) {
    const inEpoch = calls.filter((call) => call.epoch === epoch).sort((left, right) => left.atSeconds - right.atSeconds);
    const result = simulateCache(simRequests(inEpoch), policy, price, { countTokens: approximateTokenCount });
    total += result.totalCostUsd;
    result.calls.forEach((call, index) => {
      if (inEpoch[index]!.kind === "compaction") compactionUsd += call.costUsd;
    });
  }
  return { total, compactionUsd, messageUsd: total - compactionUsd, calls: calls.length };
}

const byId = new Map<string, FixtureSession>(sessions.map((session) => [session.id, session]));
for (const [policyLabel, policy] of [["5m prompt cache (agent already caches)", ANTHROPIC_CACHE_5M], ["no cache (sensitivity)", ANTHROPIC_NO_CACHE]] as const) {
  console.log(`\n== Part 2: 30-turn session bills, Opus 5.5, ${policyLabel} ==`);
  const priced = new Map<string, Priced>();
  for (const session of sessions) {
    const result = priceSession(session.calls, policy);
    priced.set(session.id, result);
    console.log(`${session.id.padEnd(36)} compactions=${String(session.compactions).padStart(2)} calls=${String(result.calls).padStart(2)} ` +
      `bill=${usd(result.total)} (compaction ${usd(result.compactionUsd)}, messages ${usd(result.messageUsd)})`);
  }
  const A = priced.get("A-correct-swap")!;
  const wasteLine = (id: string, wasteUsd: number, note: string) => {
    const bill = priced.get(id)!.total;
    console.log(`  waste ${id.padEnd(34)} ${usd(wasteUsd)} = ${pct((wasteUsd / bill) * 100)} of that session's bill  (${note})`);
  };
  const B = priced.get("B-leftover-summarized")!;
  wasteLine("B-leftover-summarized", B.total - A.total, "bill minus the correct-swap session A");
  const C = priced.get("C-block-dropped")!;
  wasteLine("C-block-dropped", C.compactionUsd, "summarization spend that bought no summary; bill vs A: " + usd(C.total - A.total));
  const D = priced.get("D-compact-every-turn")!;
  wasteLine("D-compact-every-turn", D.total - A.total, "bill minus A");
  const E = priced.get("E-threshold-no-system-breakpoint")!;
  const E2 = priced.get("E2-threshold-system-breakpoint")!;
  wasteLine("E-threshold-no-system-breakpoint", E.total - E2.total, "bill minus E2, same session with a system breakpoint");
}

// ---------------------------------------------------------------------------
// Part 3: what the auditor reports (re-billed tokens, advice lines)
// ---------------------------------------------------------------------------

console.log("\n== Part 3: auditor output per session (approx tokens, +/-28%) ==");
for (const session of sessions) {
  const report = auditCompactionSession(session.pairs, { enabled: true });
  console.log(`${session.id}: findings=${report.findings.length} rebilledApproxTokens=${report.rebilledApproxTokens} ` +
    `(range ${Math.round(report.rebilledApproxTokens / 1.28)}-${Math.round(report.rebilledApproxTokens / 0.87)} if the counter's measured bias applies)`);
}
const sample = auditCompactionSession(byId.get("B-leftover-summarized")!.pairs, { enabled: true });
console.log("\nSample advice (case B, first 4 lines):");
for (const line of compactionAdviceLines(sample).slice(0, 4)) console.log(line);
