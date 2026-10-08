import type { BenchmarkCase } from "./benchmark.js";
import {
  bestSingleChoice,
  choicesFor,
  eligibleChoices,
  mean,
  neighborOrders,
  simultaneousGroupBootstrapLowerBounds,
} from "./contextual-router.js";

/**
 * Published reference routers and oracle bounds, so FLUX's own router is measured
 * against the state of the art rather than only against single models.
 *
 * CARROT is reimplemented from its paper (arXiv:2502.03261), not vendored. Its
 * claim is that a router predicting per-query cost and performance and selecting
 * on a convex combination of the two is minimax rate-optimal; the estimator is an
 * implementation choice. This implementation uses k-nearest-neighbour regression
 * over the same hashed TF-IDF prompt features FLUX's own router uses, so a
 * head-to-head difference reflects the selection rule and not the features.
 *
 * Divergences from the paper, stated so results are not mistaken for the
 * authors' own: the paper evaluates several estimators (including fine-tuned
 * transformer regressors) and introduces the SPROUT dataset; this implementation
 * uses only the kNN estimator, runs on LLMRouterBench records, and selects the
 * cost/performance trade-off on a held-out validation split under FLUX's quality
 * guardrail rather than reporting a trade-off curve.
 *
 * GraphRouter (arXiv:2410.03834) is deliberately NOT implemented here. It
 * requires BERT node embeddings and a two-layer graph attention network over a
 * task/query/LLM graph. A hand-rolled approximation would not be GraphRouter, and
 * labelling one as such is the exact failure mode this harness exists to catch.
 */

const CARROT_NEIGHBOUR_COUNTS = [1, 3, 5, 10, 20, 40] as const;
/**
 * Cost weight in CARROT's convex objective. Cost is normalised by the most
 * expensive model's mean train cost, so these are comparable across workloads:
 * 0 selects on predicted quality alone, large values select on predicted cost.
 */
const CARROT_LAMBDAS = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16] as const;

/**
 * One point on CARROT's cost/quality trade-off curve, measured on validation.
 * The curve is reported whether or not any point clears the guardrail: a router
 * that is rejected should be shown as rejected-at-what-cost, not merely absent.
 */
export type CarrotTradeOffPoint = {
  k: number;
  lambda: number;
  meanQualityDelta: number;
  lower95QualityDelta: number;
  validationCostUsd: number;
  validationCostSavingsPercent: number;
  distinctModelsSelected: number;
  passedGuardrail: boolean;
};

export type CarrotSelection = {
  router: string;
  choiceByCaseId: Record<string, string>;
  selectedK: number | null;
  selectedLambda: number | null;
  validationSamples: number;
  validationGroups: number;
  minimumValidationGroups: number;
  validationMeanQualityDelta: number;
  validationLower95QualityDelta: number;
  validationMeanCostUsd: number | null;
  fellBackToBestSingle: boolean;
  fallbackReason?: "insufficient_validation_groups" | "no_validation_configuration";
  /** Every configuration evaluated on validation, cheapest first. */
  tradeOffCurve: CarrotTradeOffPoint[];
  /**
   * Best quality bound any configuration achieved, so a rejection can be read as
   * "its cheapest safe point still lost N points" rather than "it did nothing".
   */
  bestAchievableLower95QualityDelta: number | null;
};

export type CarrotOptions = {
  maximumQualityDrop?: number;
  minimumValidationGroups?: number;
  bootstrapSamples?: number;
  seed?: string;
};

type Prediction = { score: number; cost: number };

/** kNN regression of each model's score and cost for one query. */
function predict(
  trainRows: BenchmarkCase[],
  orders: Array<Array<{ index: number; similarity: number }>>,
  choices: string[],
  k: number,
): Prediction[][] {
  return orders.map((order) => {
    const neighbours = order.slice(0, Math.min(k, order.length)).map(({ index }) => trainRows[index]!);
    return choices.map((choice) => ({
      score: mean(neighbours.map((row) => row.predictions[choice]!.score)),
      cost: mean(neighbours.map((row) => row.predictions[choice]!.costUsd!)),
    }));
  });
}

/** CARROT's selection rule: minimise lambda * predicted cost - predicted score. */
function select(predictions: Prediction[], choices: string[], lambda: number, costScale: number): string {
  let bestIndex = 0;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const [index, prediction] of predictions.entries()) {
    const value = lambda * (prediction.cost / costScale) - prediction.score;
    // Ties resolve to the cheaper predicted model, then to the earlier choice name.
    if (value < bestValue - 1e-12 ||
        (Math.abs(value - bestValue) <= 1e-12 && prediction.cost < predictions[bestIndex]!.cost)) {
      bestValue = value;
      bestIndex = index;
    }
  }
  return choices[bestIndex]!;
}

function totalCost(rows: BenchmarkCase[], selected: string[]): number {
  return rows.reduce((sum, row, index) => sum + row.predictions[selected[index]!]!.costUsd!, 0);
}

/**
 * Fit CARROT on train records, choose (k, lambda) on validation under the quality
 * guardrail, and emit held-out test decisions. Falls back to the best single model
 * when validation is too thin to support a per-request policy, matching the
 * discipline applied to FLUX's own router.
 */
export function learnCarrotRouter(
  trainRows: BenchmarkCase[],
  validationRows: BenchmarkCase[],
  testRows: BenchmarkCase[],
  options: CarrotOptions = {},
): CarrotSelection {
  if (trainRows.length === 0 || validationRows.length === 0 || testRows.length === 0) {
    throw new Error("CARROT requires non-empty train, validation, and test partitions.");
  }
  const qualityDrop = options.maximumQualityDrop ?? 0.02;
  const minimumValidationGroups = options.minimumValidationGroups ?? 100;
  const bootstrapSamples = options.bootstrapSamples ?? 2_000;
  const seed = options.seed ?? "flux-carrot-v1";

  const allChoices = choicesFor(trainRows);
  const choices = allChoices.filter((choice) =>
    [...trainRows, ...validationRows, ...testRows].every((row) =>
      eligibleChoices(row, allChoices, false).includes(choice)));
  if (choices.length < 2) {
    throw new Error("CARROT requires at least two choices with complete scores and costs.");
  }
  const baselineChoice = bestSingleChoice(trainRows, choices);
  const costScale = Math.max(
    ...choices.map((choice) => mean(trainRows.map((row) => row.predictions[choice]!.costUsd!))),
  ) || 1;

  const validationGroups = new Set(validationRows.map((row) => row.groupId ?? row.id)).size;
  const groups = validationRows.map((row) => row.groupId ?? row.id);
  const baselineScores = validationRows.map((row) => row.predictions[baselineChoice]!.score);
  const baselineCost = totalCost(validationRows, validationRows.map(() => baselineChoice));

  const fallback = (
    reason: CarrotSelection["fallbackReason"],
    curve: CarrotTradeOffPoint[],
  ): CarrotSelection => ({
    router: "carrot",
    choiceByCaseId: Object.fromEntries(testRows.map((row) => [row.id, baselineChoice])),
    selectedK: null,
    selectedLambda: null,
    validationSamples: validationRows.length,
    validationGroups,
    minimumValidationGroups,
    validationMeanQualityDelta: 0,
    validationLower95QualityDelta: 0,
    validationMeanCostUsd: baselineCost / validationRows.length,
    fellBackToBestSingle: true,
    fallbackReason: reason,
    tradeOffCurve: curve,
    bestAchievableLower95QualityDelta: curve.length === 0
      ? null
      : Math.max(...curve.map((point) => point.lower95QualityDelta)),
  });

  if (validationGroups < minimumValidationGroups) return fallback("insufficient_validation_groups", []);

  const validationOrders = neighborOrders(trainRows, validationRows);
  const curve: CarrotTradeOffPoint[] = [];
  let best: {
    k: number;
    lambda: number;
    meanDelta: number;
    lower95: number;
    cost: number;
  } | undefined;

  const evaluated: Array<{ k: number; lambda: number; deltas: number[]; cost: number }> = [];
  for (const k of CARROT_NEIGHBOUR_COUNTS) {
    const predictions = predict(trainRows, validationOrders, choices, k);
    for (const lambda of CARROT_LAMBDAS) {
      const selected = predictions.map((row) => select(row, choices, lambda, costScale));
      evaluated.push({
        k,
        lambda,
        deltas: validationRows.map((row, index) =>
          row.predictions[selected[index]!]!.score - baselineScores[index]!),
        cost: totalCost(validationRows, selected),
      });
      curve.push({
        k,
        lambda,
        meanQualityDelta: 0,
        lower95QualityDelta: 0,
        validationCostUsd: evaluated[evaluated.length - 1]!.cost,
        validationCostSavingsPercent: baselineCost === 0
          ? 0
          : (1 - evaluated[evaluated.length - 1]!.cost / baselineCost) * 100,
        distinctModelsSelected: new Set(selected).size,
        passedGuardrail: false,
      });
    }
  }
  // One simultaneous band across the whole (k, lambda) search, matching the
  // correction applied to FLUX's own router so the comparison stays like for like.
  const bounds = simultaneousGroupBootstrapLowerBounds(
    evaluated.map((point) => point.deltas),
    groups,
    bootstrapSamples,
    `${seed}:carrot`,
  );
  evaluated.forEach((point, index) => {
    const lower95 = bounds[index]!;
    const passedGuardrail = lower95 >= -qualityDrop;
    curve[index]!.meanQualityDelta = mean(point.deltas);
    curve[index]!.lower95QualityDelta = lower95;
    curve[index]!.passedGuardrail = passedGuardrail;
    if (!passedGuardrail) return;
    // Prefer the cheapest configuration that holds quality; break ties on the
    // stronger quality bound so a cost tie does not pick a weaker router.
    if (!best || point.cost < best.cost - 1e-12 ||
        (Math.abs(point.cost - best.cost) <= 1e-12 && lower95 > best.lower95)) {
      best = { k: point.k, lambda: point.lambda, meanDelta: mean(point.deltas), lower95, cost: point.cost };
    }
  });
  curve.sort((left, right) => left.validationCostUsd - right.validationCostUsd);

  if (!best) return fallback("no_validation_configuration", curve);

  const testOrders = neighborOrders(trainRows, testRows);
  const testPredictions = predict(trainRows, testOrders, choices, best.k);
  const testChoices = testPredictions.map((row) => select(row, choices, best!.lambda, costScale));
  return {
    router: "carrot",
    choiceByCaseId: Object.fromEntries(testRows.map((row, index) => [row.id, testChoices[index]!])),
    selectedK: best.k,
    selectedLambda: best.lambda,
    validationSamples: validationRows.length,
    validationGroups,
    minimumValidationGroups,
    validationMeanQualityDelta: best.meanDelta,
    validationLower95QualityDelta: best.lower95,
    validationMeanCostUsd: best.cost / validationRows.length,
    fellBackToBestSingle: false,
    tradeOffCurve: curve,
    bestAchievableLower95QualityDelta: Math.max(...curve.map((point) => point.lower95QualityDelta)),
  };
}

export type OracleKind = "best_quality" | "cheapest_correct" | "cheapest_within_budget";

export type OracleSelection = {
  router: string;
  kind: OracleKind;
  choiceByCaseId: Record<string, string>;
};

export type OracleOptions = {
  /** Score at or above which an answer counts as correct. Default 1 (binary scorers). */
  correctnessThreshold?: number;
  /** Mean quality, against the baseline, a `cheapest_within_budget` oracle may spend. Default 0.02. */
  maximumQualityDrop?: number;
  /** Train-selected baseline the quality budget is measured against. Required for `cheapest_within_budget`. */
  baselineChoice?: string;
};

/**
 * Cheapest achievable allocation whose MEAN quality stays within `drop` of the
 * baseline. This is a budgeted problem, not a per-query filter: on a binary
 * scorer no single answer can be "2% worse", so the budget is spent across
 * queries, taking free savings first (where a cheaper model is no worse, or
 * where the baseline was wrong anyway) and then buying the cheapest remaining
 * savings per quality point given up.
 *
 * Solved by Lagrangian relaxation: for a multiplier mu, each query independently
 * takes argmin(cost - mu * qualityDelta); bisecting mu to the point where the
 * mean-quality constraint is just satisfied yields the cheapest allocation that
 * holds the budget.
 */
function cheapestWithinBudget(
  rows: BenchmarkCase[],
  choices: string[],
  baselineChoice: string,
  drop: number,
): string[] {
  const budget = rows.length * drop;
  const pick = (mu: number): string[] => rows.map((row) => {
    const base = row.predictions[baselineChoice]!.score;
    let best = choices[0]!;
    let bestValue = Number.POSITIVE_INFINITY;
    for (const choice of choices) {
      const prediction = row.predictions[choice]!;
      const value = prediction.costUsd! - mu * (prediction.score - base);
      if (value < bestValue - 1e-15) {
        bestValue = value;
        best = choice;
      }
    }
    return best;
  });
  const qualityDelta = (selected: string[]): number => selected.reduce((sum, choice, index) => {
    const row = rows[index]!;
    return sum + row.predictions[choice]!.score - row.predictions[baselineChoice]!.score;
  }, 0);

  if (qualityDelta(pick(0)) >= -budget) return pick(0);
  let low = 0;
  let high = 1;
  while (qualityDelta(pick(high)) < -budget) {
    high *= 10;
    // Beyond this the multiplier dominates every cost difference; the constraint
    // cannot be met by any allocation, so fall back to the quality-maximising one.
    if (high > 1e12) return pick(high);
  }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    if (qualityDelta(pick(mid)) < -budget) low = mid;
    else high = mid;
  }
  return pick(high);
}

/**
 * Oracle bounds. These read the held-out scores they select on, so they are NOT
 * deployable routers. They exist to answer "how much was available?", because a
 * headline saving means nothing without that denominator — RouterArena's central
 * finding is that every real router falls well short of these.
 *
 * - `best_quality`: highest-scoring model per query, cheapest on a tie. The
 *   quality ceiling.
 * - `cheapest_correct`: cheapest model scoring at or above the correctness
 *   threshold, falling back to the best available when no model is correct.
 *   This is RouterArena's routing-optimality reference. NOTE: on a binary
 *   scorer this is mathematically identical to `best_quality`, since the best
 *   available score is exactly the correctness threshold. Identical rows for
 *   these two are therefore expected on binary benchmarks, not a defect.
 * - `cheapest_within_budget`: cheapest allocation whose MEAN quality stays within
 *   `maximumQualityDrop` of the baseline. This is the cost floor a guardrailed
 *   router actually competes against, and the only one of the three that stays
 *   distinct on binary scorers, because it spends the quality budget across
 *   queries rather than filtering each one.
 */
export function oracleRouter(
  rows: BenchmarkCase[],
  kind: OracleKind,
  options: OracleOptions = {},
): OracleSelection {
  if (rows.length === 0) throw new Error("An oracle needs at least one record.");
  const threshold = options.correctnessThreshold ?? 1;
  const drop = options.maximumQualityDrop ?? 0.02;
  if (!Number.isFinite(drop) || drop < 0 || drop > 1) {
    throw new Error("maximumQualityDrop must be between 0 and 1.");
  }
  const allChoices = choicesFor(rows);
  const choices = allChoices.filter((choice) =>
    rows.every((row) => eligibleChoices(row, allChoices, false).includes(choice)));
  if (choices.length === 0) throw new Error("No choice has complete scores and costs across these records.");
  const choiceByCaseId: Record<string, string> = {};
  for (const row of rows) {
    const candidates = choices.map((choice) => ({
      choice,
      score: row.predictions[choice]!.score,
      cost: row.predictions[choice]!.costUsd!,
    }));
    const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
    let pool: typeof candidates;
    if (kind === "best_quality") {
      pool = candidates.filter((candidate) => candidate.score === bestScore);
    } else if (kind === "cheapest_correct") {
      const correct = candidates.filter((candidate) => candidate.score >= threshold);
      pool = correct.length > 0 ? correct : candidates.filter((candidate) => candidate.score === bestScore);
    } else {
      // Handled as a whole-set allocation below, not per query.
      pool = candidates;
    }
    pool.sort((left, right) => left.cost - right.cost || left.choice.localeCompare(right.choice));
    choiceByCaseId[row.id] = pool[0]!.choice;
  }
  if (kind === "cheapest_within_budget") {
    if (!options.baselineChoice) {
      throw new Error("A cheapest_within_budget oracle needs the train-selected baselineChoice to measure its budget against.");
    }
    if (!choices.includes(options.baselineChoice)) {
      throw new Error(`Baseline ${options.baselineChoice} has no complete scores and costs across these records.`);
    }
    const selected = cheapestWithinBudget(rows, choices, options.baselineChoice, drop);
    rows.forEach((row, index) => { choiceByCaseId[row.id] = selected[index]!; });
  }
  return { router: `oracle_${kind}`, kind, choiceByCaseId };
}

/**
 * Share of the oracle's achievable saving that a router actually captured, on the
 * same records. Returns null when the oracle saves nothing, because a ratio
 * against a zero denominator is not a measurement.
 */
export function oracleCaptureRatio(
  baselineCostUsd: number,
  routerCostUsd: number,
  oracleCostUsd: number,
): number | null {
  const achievable = baselineCostUsd - oracleCostUsd;
  if (achievable <= 0) return null;
  return ((baselineCostUsd - routerCostUsd) / achievable) * 100;
}
