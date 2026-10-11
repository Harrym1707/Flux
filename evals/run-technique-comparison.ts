import {
  PUBLISHED_LEVERS,
  WORKLOAD_ARCHETYPES,
  lookupPrice,
  projectSavings,
  publishedModelPrices,
  type Lever,
  type WorkloadProfile,
} from "../packages/core/src/index.js";

/**
 * Compare the market's tool-overhead techniques per request and per task.
 *
 * The point of the table is the gap between the two columns. Progressive
 * disclosure and code mode cut a prompt by almost the same amount, so per
 * request they look interchangeable. Per task they are not: one adds a round
 * trip per novel tool call and the other removes three quarters of them.
 *
 * This is the comparison no vendor publishes, and the reason a 91% claim can
 * deliver 13%.
 */

const AT = "2026-10-08";

const CANDIDATES: Array<{ label: string; levers: Lever[] }> = [
  // Prefix caching is applied by projectSavings whenever a stable prefix
  // exists, so the no-lever row is not a true baseline: it is what caching
  // alone delivers. Anything scoring below this row is net harmful.
  { label: "prefix caching alone", levers: [] },
  {
    label: "schema compaction (lossless)",
    levers: [PUBLISHED_LEVERS.toolSchemaCompaction!],
  },
  {
    label: "description trimming",
    levers: [PUBLISHED_LEVERS.toolSchemaCompaction!, PUBLISHED_LEVERS.toolSchemaMinification!],
  },
  {
    label: "progressive disclosure",
    levers: [PUBLISHED_LEVERS.progressiveDisclosure!],
  },
  {
    label: "code mode",
    levers: [PUBLISHED_LEVERS.codeMode!],
  },
  {
    label: "code mode + compaction",
    levers: [PUBLISHED_LEVERS.toolSchemaCompaction!, PUBLISHED_LEVERS.codeMode!],
  },
];

function pct(value: number): string {
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(1)}%`;
}

/** Per-request view: what a single prompt costs, ignoring how many are needed. */
function perRequestSaving(profile: WorkloadProfile, levers: Lever[], price: Parameters<typeof projectSavings>[2]): number {
  // Strip the call-count effect so this column is deliberately blind to it,
  // reproducing how the market reports these techniques.
  const blind = levers.map((lever) => ({ ...lever, roundTripMultiplier: 1 }));
  const single = { ...profile, requests: 1 };
  const projection = projectSavings(single, blind, price);
  return projection.savingPercent;
}

const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (price.status !== "priced") throw new Error(price.reason);

for (const key of ["toolHeavyAgent", "supportAssistant"] as const) {
  const profile = WORKLOAD_ARCHETYPES[key]!;
  console.log(`\n=== ${profile.name}, gpt-5, ${profile.requests} calls ===`);
  console.log(
    `${"technique".padEnd(30)} ${"per request".padStart(12)} ${"per task".padStart(10)} ` +
    `${"calls".padStart(7)} ${"risk".padStart(20)}`,
  );
  console.log("-".repeat(84));
  for (const candidate of CANDIDATES) {
    const projection = projectSavings(profile, candidate.levers, price.price);
    const single = perRequestSaving(profile, candidate.levers, price.price);
    const risk = candidate.levers.length === 0
      ? "-"
      : candidate.levers.every((lever) => lever.risk === "deterministic")
        ? "deterministic"
        : "needs-verification";
    const calls = (projection.roundTripsAfter / projection.roundTripsBefore).toFixed(2);
    console.log(
      `${candidate.label.padEnd(30)} ${pct(single).padStart(12)} ${pct(projection.savingPercent).padStart(10)} ` +
      `${`x${calls}`.padStart(7)} ${risk.padStart(20)}`,
    );
  }
}

console.log(
  "\nper request is deliberately blind to call count, which is how these techniques are normally reported.\n" +
  "per task applies each technique's effect on how many calls a task takes. Where the two columns diverge,\n" +
  "the per-request figure is the misleading one.\n\n" +
  "The first row is prefix caching alone, not an untouched baseline, so it is the bar every other row has to\n" +
  "clear. Progressive disclosure does not clear it on either workload: it trims the prompt more than caching\n" +
  "does and still ends up more expensive per task, because the extra round trip it adds costs more than the\n" +
  "prompt tokens it saves.",
);
