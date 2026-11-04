/**
 * Theo coverage oracle — runnable demo.
 *
 *   node --import tsx scripts/theo-coverage-demo.ts
 *
 * For each workload archetype, shows how much of the lever catalogue Theo
 * reaches: the headline coverage (M of N applicable levers), what he applies vs
 * holds for a replay proof, and — the point of the exercise — every applicable
 * lever he does NOT apply, with the reason. This is the instrument that turns
 * "did Theo find the savings?" into a number and a gap list you can read.
 *
 * Projected figures come from each lever's published evidence; they are
 * hypotheses, not realised savings, exactly as in `flux analyse`.
 */
import { lookupPrice } from "../packages/core/src/price-catalogue.js";
import { publishedModelPrices } from "../packages/core/src/model-prices.js";
import { WORKLOAD_ARCHETYPES } from "../packages/core/src/savings-model.js";
import { coverageForProfile } from "../packages/core/src/theo-coverage.js";

const at = new Date().toISOString().slice(0, 10);
const lookup = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at });
if (lookup.status !== "priced") throw new Error(`demo needs a priced model: ${lookup.reason}`);
const price = lookup.price;

const usd = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const pct = (n: number): string => `${n.toFixed(1)}%`;

console.log(`Theo coverage — priced at anthropic/Sonnet 5.5 (${at})\n`);

for (const profile of Object.values(WORKLOAD_ARCHETYPES)) {
  const report = coverageForProfile(profile, price);
  console.log(`▌ ${report.workload}`);
  console.log(
    `  baseline ${usd(report.baselineCostUsd)}  ·  Theo projects ${pct(report.realizedSavingPercent)} ` +
    `(${pct(report.realizedDeterministicPercent)} live now, ${pct(report.realizedNeedsVerificationPercent)} held for replay proof)`,
  );
  console.log(
    `  lever coverage: ${report.appliedLevers}/${report.applicableLevers} applicable levers applied ` +
    `(${pct(report.leverCoveragePercent)})`,
  );
  if (report.gaps.length === 0) {
    console.log("  gaps: none — Theo reaches every applicable lever.\n");
    continue;
  }
  console.log("  gaps (applicable, not applied):");
  for (const gap of report.gaps) {
    if (gap.projectedSavingPercent > 0) {
      console.log(`    · ${gap.leverId} — blocked headroom, up to ${pct(gap.projectedSavingPercent)} projected`);
      console.log(`      ${gap.reason}`);
    } else {
      console.log(
        `    · ${gap.leverId} — correctly left off: ${pct(gap.projectedSavingPercent)} ` +
        "projected here (would cost more than it saves on this workload).",
      );
    }
  }
  console.log("");
}
