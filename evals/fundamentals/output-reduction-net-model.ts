/**
 * Output-token-reduction net-savings sandbox (fundamentals axis, 2026-10-28)
 *
 * Purpose: make the output-reduction literature numbers concrete in FLUX's OWN
 * economics, so the backlog conversation is about NET-of-cache, gate-passed,
 * billable savings — not the 80%/84% benchmark headlines that are measured on
 * math data FLUX never sees.
 *
 * It is a transparent arithmetic model, NOT a measurement. Every input is
 * labelled with its honesty tag. Run:
 *   node --import tsx evals/fundamentals/output-reduction-net-model.ts
 *
 * Standalone by design: no repo imports, so it cannot perturb shipping code.
 *
 * MODEL (per well-cached agent dollar):
 *   bill = outputShare + cacheReadShare + cacheWriteShare + uncachedInputShare
 *   An output lever that removes a fraction f of output tokens on the turns it
 *   is allowed to touch saves:
 *     direct   = outputShare * reachableTurnShare * f
 *     echo     = direct * echoLeverage        (saved output isn't re-read later)
 *   minus a cache-bust penalty if the rewrite invalidates the cached prefix:
 *     bust     = cacheReadShare * bustFraction
 *   then scaled by the fraction of routes that clear the quality gate.
 *   FLUX bills 1% of the verified net.
 */

// ---- Measured anchors (docs/rnd/knowledge/2026-10-26-output-token-ground-truth.md)
const BILL = {
  outputShare: 0.293, // measured: output = 29.3% of a well-cached agent's bill
  cacheReadShare: 0.516, // measured
  cacheWriteShare: 0.19, // measured
  uncachedInputShare: 0.001, // measured (~0.1%)
} as const;

// Each output token is re-read ~27x downstream, worth ~0.5x its own price in
// later cache reads (measured, same ground-truth note). So removing an output
// token also removes that echo -> leverage > 1.
const ECHO_LEVERAGE = 0.5; // derived-from-data

// Top 10% of turns hold 47-64% of output and are the most quality-critical;
// the dial is only safely allowed on the non-fat remainder. (reasoned, from
// the measured turn-concentration skew.)
const REACHABLE_TURN_SHARE = 0.4; // estimate: conservative "safe to touch" share

type Scenario = {
  name: string;
  outputCut: number; // f: fraction of reachable output removed. honesty below.
  outputCutLabel: string;
  gatePass: number; // fraction of candidate routes that clear the quality gate
  gatePassLabel: string;
  bustFraction: number; // fraction of cache-read bill lost to prefix invalidation
  bustLabel: string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "Effort dial, per-message beta (cache-safe), low-difficulty routes",
    outputCut: 0.25,
    outputCutLabel: "estimate (no provider %; benchmark effort sweeps imply 20-40%)",
    gatePass: 0.5,
    gatePassLabel: "estimate (half of low-diff routes hold quality at lower effort)",
    bustFraction: 0.0,
    bustLabel: "provider-doc: per-message effort beta preserves the cache",
  },
  {
    name: "Effort dial, TOP-LEVEL change (naive) — busts cache every switch",
    outputCut: 0.25,
    outputCutLabel: "estimate (same dial)",
    gatePass: 0.5,
    gatePassLabel: "estimate",
    bustFraction: 0.15,
    bustLabel: "reasoned: top-level effort change invalidates prefix on switch turns",
  },
  {
    name: "Concise/CoD-style brevity instruction (stable prefix, zero-shot)",
    outputCut: 0.3,
    outputCutLabel: "literature-claim-scaled (CCoT -48.7% len, haircut for agent risk)",
    gatePass: 0.25,
    gatePassLabel: "estimate (CCoT math -27.69%; most agent routes fail the gate)",
    bustFraction: 0.0,
    bustLabel: "stable prefix instruction, set once -> cache-safe",
  },
  {
    name: "Overthinking nudge on trivial routes only",
    outputCut: 0.29,
    outputCutLabel: "literature-claim (OptimalThinkingBench 'don't overthink' up to -29%)",
    gatePass: 0.6,
    gatePassLabel: "estimate (narrow, easy-query routes hold quality best)",
    bustFraction: 0.0,
    bustLabel: "stable nudge -> cache-safe; needs trusted difficulty routing",
  },
];

function evaluate(s: Scenario) {
  const direct = BILL.outputShare * REACHABLE_TURN_SHARE * s.outputCut;
  const echo = direct * ECHO_LEVERAGE;
  const gross = direct + echo;
  const bust = BILL.cacheReadShare * s.bustFraction;
  const netPreGate = gross - bust;
  const netVerified = netPreGate * s.gatePass;
  const fluxBill = netVerified * 0.01; // FLUX bills 1% of verified savings
  return { direct, echo, gross, bust, netPreGate, netVerified, fluxBill };
}

function pct(x: number): string {
  return (x * 100).toFixed(2) + "%";
}

console.log("Output-token-reduction NET model — share of a well-cached agent's bill");
console.log("Anchors: output 29.3%, cache-read 51.6% (measured); echo +0.5x (derived);");
console.log("reachable turn share 40% (estimate); FLUX bills 1% of verified net.\n");

for (const s of SCENARIOS) {
  const r = evaluate(s);
  console.log("─".repeat(78));
  console.log(s.name);
  console.log(`  outputCut f      = ${pct(s.outputCut)}  [${s.outputCutLabel}]`);
  console.log(`  gate pass        = ${pct(s.gatePass)}  [${s.gatePassLabel}]`);
  console.log(`  cache bust       = ${pct(s.bustFraction)}  [${s.bustLabel}]`);
  console.log(`  direct save      = ${pct(r.direct)} of bill`);
  console.log(`  + echo save      = ${pct(r.echo)} of bill`);
  console.log(`  - cache bust     = ${pct(r.bust)} of bill`);
  console.log(`  = net pre-gate   = ${pct(r.netPreGate)} of bill`);
  console.log(`  = net VERIFIED   = ${pct(r.netVerified)} of bill   <- after quality gate`);
  console.log(`  -> FLUX bills    = ${pct(r.fluxBill)} of the customer's total spend`);
}

console.log("─".repeat(78));
console.log("\nReadings:");
console.log("1. Even the best cache-safe effort scenario nets a low-single-digit % of the");
console.log("   bill AFTER the quality gate — output reduction is a real but modest lever,");
console.log("   nowhere near the 80%/84% benchmark headlines (those are gross, on math data).");
console.log("2. The naive top-level effort switch can net LESS than the cache-safe path");
console.log("   purely from prefix busting — the per-message beta is not optional.");
console.log("3. The brevity-instruction row dies on the gate (0.25 pass), matching the");
console.log("   CCoT -27.69% math cliff: it is the gate, not the compression ratio, that");
console.log("   decides whether this lever is worth anything on agent traffic.");
console.log("\nAll outputs are model arithmetic over labelled inputs, not measurements.");
console.log("Replace outputCut/gatePass with trajectory-gate results before any billing.");
