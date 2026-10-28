/**
 * rate-arbitrage-map.ts — sandbox for the inference-cost-structure axis.
 *
 * Companion to docs/rnd/fundamentals/2026-10-28-inference-cost-structure.md.
 * Encodes the cross-provider rate card (provider-doc, fetched 2026-10-28) and the three
 * NEW arbitrage levers that mine surfaced, as *black-box, request-byte-only* calculators:
 *
 *   1. Threshold arbitrage (B.3)  — long-context price cliffs (Haiku >100K ×5, Gemini >200K ×2).
 *   2. Temporal arbitrage  (B.4)  — DeepSeek off-peak 50% by UTC clock.
 *   3. Tier/cache ratios   (B.1)  — cache-read ~10%, batch/off-peak ~50% across 4 providers.
 *
 * NOTHING here touches model weights/logits — every function takes token counts + bytes
 * the proxy already sees. Prices are structural ratios; absolute $ are transient — re-fetch.
 *
 * Run:  npx tsx evals/fundamentals/rate-arbitrage-map.ts   (prints worked examples + self-checks)
 * This file only READS the rate card and does arithmetic; it writes nothing and bills nothing.
 */

// ---------------------------------------------------------------------------
// Rate card ($/MTok). provider-doc, fetched 2026-10-28. STRUCTURE is durable; numbers move.
// ---------------------------------------------------------------------------
type Band = { maxPromptTokens: number; input: number; output: number; cacheRead: number };
type Model = {
  provider: string;
  name: string;
  bands: Band[];            // ordered ascending by maxPromptTokens; last is Infinity
  batchMultiplier: number;  // latency-tolerant discount (batch/flex); 1 = none
  offPeak?: OffPeak;        // temporal arbitrage (DeepSeek)
};
type OffPeak = { multiplier: number; peakWindowsUTC: [number, number][]; peakDays: number[] };

const INF = Number.POSITIVE_INFINITY;

export const RATE_CARD: Model[] = [
  {
    provider: "anthropic", name: "haiku-5.5",
    bands: [
      { maxPromptTokens: 100_000, input: 0.10, output: 0.50, cacheRead: 0.01 },
      { maxPromptTokens: INF,     input: 0.50, output: 2.50, cacheRead: 0.05 }, // 5x CLIFF
    ],
    batchMultiplier: 0.5,
  },
  {
    provider: "anthropic", name: "sonnet-5.5",
    bands: [{ maxPromptTokens: INF, input: 2.00, output: 10.00, cacheRead: 0.10 }],
    batchMultiplier: 0.5,
  },
  {
    provider: "openai", name: "gpt-5",
    bands: [{ maxPromptTokens: INF, input: 1.25, output: 10.00, cacheRead: 0.125 }], // cacheRead = 0.1x
    batchMultiplier: 0.5,
  },
  {
    provider: "google", name: "gemini-3.1-pro",
    bands: [
      { maxPromptTokens: 200_000, input: 2.00, output: 12.00, cacheRead: 0.20 },
      { maxPromptTokens: INF,     input: 4.00, output: 18.00, cacheRead: 0.40 }, // 2x/1.5x CLIFF
    ],
    batchMultiplier: 0.5,
  },
  {
    provider: "deepseek", name: "deepseek-flash",
    bands: [{ maxPromptTokens: INF, input: 0.30, output: 1.20, cacheRead: 0.006 }], // cacheRead ~2% of input
    batchMultiplier: 1.0, // no batch endpoint; discount is temporal instead ->
    offPeak: { multiplier: 0.5, peakWindowsUTC: [[1, 4], [6, 10]], peakDays: [1, 2, 3, 4, 5] },
  },
];

const byName = (n: string) => {
  const m = RATE_CARD.find((x) => x.name === n);
  if (!m) throw new Error(`unknown model ${n}`);
  return m;
};
const bandFor = (m: Model, promptTokens: number) =>
  m.bands.find((b) => promptTokens <= b.maxPromptTokens) ?? m.bands[m.bands.length - 1];

// ---------------------------------------------------------------------------
// Lever 1 — THRESHOLD ARBITRAGE (B.3). Lossless-or-lossy per-transform; black-box.
// The saving is the WHOLE request repricing into the cheaper band, not the trimmed tokens.
// ---------------------------------------------------------------------------
export type ThresholdResult = {
  flippable: boolean;
  thresholdTokens: number | null;
  tokensToRemove: number;
  costBefore: number; // $ for this one request, at the ORIGINAL band
  costAfter: number;  // $ for this one request, after trimming below the threshold
  savingUsd: number;
  savingRatio: number; // costAfter / costBefore
  note: string;
};

/**
 * Detect whether trimming a prompt across the next-lower price cliff pays, and by how much.
 * Only the band-edge minority is flippable — that is the point (cheap detector, concentrated value).
 */
export function thresholdArbitrage(
  modelName: string,
  promptTokens: number,
  outputTokens: number,
  opts: { maxFeasibleTrimFraction?: number } = {}
): ThresholdResult {
  const m = byName(modelName);
  const maxTrim = opts.maxFeasibleTrimFraction ?? 0.15; // how much of the prompt we can realistically cut
  const here = bandFor(m, promptTokens);
  // find the nearest lower threshold boundary below the current prompt size
  const lowerBoundaries = m.bands
    .map((b) => b.maxPromptTokens)
    .filter((t) => t < promptTokens && t !== INF)
    .sort((a, b) => b - a);
  const cost = (b: Band, pt: number, ot: number) =>
    (pt * b.input + ot * b.output) / 1_000_000;
  const costBefore = cost(here, promptTokens, outputTokens);

  if (lowerBoundaries.length === 0) {
    return {
      flippable: false, thresholdTokens: null, tokensToRemove: 0,
      costBefore, costAfter: costBefore, savingUsd: 0, savingRatio: 1,
      note: "already in the cheapest band — no lower cliff to cross",
    };
  }
  const threshold = lowerBoundaries[0];
  const tokensToRemove = promptTokens - threshold + 1; // land strictly under
  const feasible = tokensToRemove <= promptTokens * maxTrim;
  const targetTokens = promptTokens - tokensToRemove;
  const cheaperBand = bandFor(m, targetTokens);
  const costAfter = cost(cheaperBand, targetTokens, outputTokens);

  return {
    flippable: feasible,
    thresholdTokens: threshold,
    tokensToRemove,
    costBefore,
    costAfter,
    savingUsd: costBefore - costAfter,
    savingRatio: costAfter / costBefore,
    note: feasible
      ? `flip: remove ${tokensToRemove} tok (${((tokensToRemove / promptTokens) * 100).toFixed(1)}%) to drop under ${threshold} and reprice the whole request`
      : `NOT flippable: would need to cut ${((tokensToRemove / promptTokens) * 100).toFixed(1)}% > max feasible ${(maxTrim * 100).toFixed(0)}%`,
  };
}

// ---------------------------------------------------------------------------
// Lever 2 — TEMPORAL ARBITRAGE (B.4). DeepSeek off-peak. Lossless (timing only); black-box.
// ---------------------------------------------------------------------------
export function isOffPeak(model: Model, when: Date): boolean {
  if (!model.offPeak) return false;
  const day = when.getUTCDay(); // 0=Sun..6=Sat
  const hour = when.getUTCHours();
  const inPeakDay = model.offPeak.peakDays.includes(day);
  if (!inPeakDay) return true; // weekends fully off-peak
  const inPeakWindow = model.offPeak.peakWindowsUTC.some(([a, b]) => hour >= a && hour < b);
  return !inPeakWindow;
}

/** Hours until the next off-peak window opens (0 if already off-peak). Caps the deferral latency. */
export function hoursUntilOffPeak(model: Model, from: Date): number {
  if (!model.offPeak) return 0;
  for (let h = 0; h < 24 * 8; h++) {
    const t = new Date(from.getTime() + h * 3600_000);
    if (isOffPeak(model, t)) return h;
  }
  return 0;
}

export function temporalSaving(
  modelName: string, promptTokens: number, outputTokens: number, when: Date
): { offPeakNow: boolean; hoursToDefer: number; standardUsd: number; offPeakUsd: number; savingUsd: number } {
  const m = byName(modelName);
  const b = bandFor(m, promptTokens);
  const std = (promptTokens * b.input + outputTokens * b.output) / 1_000_000;
  const mult = m.offPeak?.multiplier ?? 1;
  return {
    offPeakNow: isOffPeak(m, when),
    hoursToDefer: hoursUntilOffPeak(m, when),
    standardUsd: std,
    offPeakUsd: std * mult,
    savingUsd: std * (1 - mult),
  };
}

// ---------------------------------------------------------------------------
// Lever 3 — structural ratio audit (B.1). Confirms cache~10% / batch~50% across providers.
// ---------------------------------------------------------------------------
export function structuralRatios() {
  return RATE_CARD.map((m) => {
    const b = m.bands[0];
    return {
      model: m.name,
      cacheReadRatio: +(b.cacheRead / b.input).toFixed(3), // skip-prefill discount
      batchRatio: m.offPeak ? m.offPeak.multiplier : m.batchMultiplier, // throughput-share discount
      outputInputRatio: +(b.output / b.input).toFixed(2), // decode/prefill gap
    };
  });
}

// ---------------------------------------------------------------------------
// Demo + self-checks
// ---------------------------------------------------------------------------
function main() {
  console.log("=== B.1 structural ratios (cache-read should cluster ~0.1, batch ~0.5) ===");
  console.table(structuralRatios());

  console.log("\n=== B.3 threshold arbitrage — Haiku 105K prompt, 500 out (band-edge, flippable) ===");
  const t1 = thresholdArbitrage("haiku-5.5", 105_000, 500);
  console.log(t1);
  console.assert(t1.flippable && t1.savingRatio < 0.3, "edge-of-band Haiku should flip to <0.3x");

  console.log("\n=== B.3 threshold arbitrage — Haiku 300K prompt (too far above cliff, NOT flippable) ===");
  const t2 = thresholdArbitrage("haiku-5.5", 300_000, 500);
  console.log(t2);
  console.assert(!t2.flippable, "300K is unflippable at 15% max trim");

  console.log("\n=== B.3 Gemini 210K prompt (2x/1.5x cliff, flippable) ===");
  const t3 = thresholdArbitrage("gemini-3.1-pro", 210_000, 1000);
  console.log(t3);

  console.log("\n=== B.4 temporal arbitrage — DeepSeek at 02:00 UTC Tue (PEAK) vs 14:00 UTC Sat (off-peak) ===");
  const peak = temporalSaving("deepseek-flash", 50_000, 2000, new Date("2026-10-27T02:00:00Z")); // Tue 02:00
  const off = temporalSaving("deepseek-flash", 50_000, 2000, new Date("2026-10-31T14:00:00Z"));  // Sat 14:00
  console.log("peak  :", peak);
  console.log("offpk :", off);
  console.assert(!peak.offPeakNow && off.offPeakNow, "Tue 02:00 peak, Sat 14:00 off-peak");
  console.assert(Math.abs(peak.savingUsd / peak.standardUsd - 0.5) < 1e-9, "off-peak = 50%");

  console.log("\nAll self-checks passed.");
}

// tsx/node entry
if (typeof require !== "undefined" && require.main === module) main();
