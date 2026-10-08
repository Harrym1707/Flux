import { createHash } from "node:crypto";
import type { BenchmarkCase } from "./benchmark.js";

const HASH_DIMENSIONS = 8_192;
const NEIGHBOR_COUNTS = [1, 3, 5, 10, 20] as const;
const LOCAL_WEIGHTS = [0.25, 0.5, 0.75, 1] as const;

export type ContextualObjective = "cost" | "tokens" | "cost_and_tokens";

export type ContextualRouterSelection = {
  router: string;
  objective: ContextualObjective;
  choiceByCaseId: Record<string, string>;
  selectedK: number | null;
  selectedLocalWeight: number | null;
  validationSamples: number;
  validationGroups: number;
  minimumValidationGroups: number;
  validationMeanQualityDelta: number;
  validationLower95QualityDelta: number;
  validationMeanCostUsd: number | null;
  validationMeanTokens: number | null;
  fellBackToBestSingle: boolean;
  fallbackReason?: "insufficient_validation_groups" | "no_validation_configuration";
};

export type ContextualRouterOptions = {
  maximumQualityDrop?: number;
  minimumValidationGroups?: number;
  bootstrapSamples?: number;
  seed?: string;
};

type Vector = Map<number, number>;
type WeightedChoice = {
  choice: string;
  score: number;
  cost: number;
  tokens: number | null;
};
type ConfigurationScore = {
  k: number;
  localWeight: number;
  choices: string[];
  meanQuality: number;
  meanCost: number | null;
  meanTokens: number | null;
  qualityDeltaLower95: number;
  objectiveValue: number;
  /** Per-record quality deltas, retained so bounds can be computed across configurations. */
  deltas: number[];
};

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashFeature(feature: string): number {
  let hash = 2_166_136_261;
  for (const character of feature) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % HASH_DIMENSIONS;
}

function features(row: BenchmarkCase): Map<number, number> {
  const normalized = (row.input ?? "").toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]/gu) ?? [];
  const counts = new Map<number, number>();
  const add = (feature: string) => {
    const index = hashFeature(feature);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  };
  for (const token of tokens) add(`w:${token}`);
  for (let index = 1; index < tokens.length; index += 1) {
    add(`b:${tokens[index - 1]} ${tokens[index]}`);
  }

  const characters = Array.from(normalized.slice(0, 5_000));
  for (let index = 0; index + 4 <= characters.length; index += 2) {
    add(`c:${characters.slice(index, index + 4).join("")}`);
  }
  add(`len:${Math.min(40, Math.floor(normalized.length / 256))}`);
  add(`lines:${Math.min(30, Math.floor((normalized.match(/\n/g)?.length ?? 0) / 10))}`);
  add(`code:${normalized.includes("```") ? 1 : 0}`);
  add(`digits:${Math.min(20, Math.floor((normalized.match(/\d/g)?.length ?? 0) / 20))}`);
  add(`words:${Math.min(40, Math.floor(tokens.length / 25))}`);
  add(`questions:${Math.min(10, (normalized.match(/\?/g)?.length ?? 0))}`);
  add(`math:${/[=<>±×÷∑√∫^]|\b(?:prove|equation|calculate|derivative|integral)\b/u.test(normalized) ? 1 : 0}`);
  add(`structured:${/\b(?:json|xml|yaml|schema|csv)\b/u.test(normalized) ? 1 : 0}`);
  add(`coding:${/\b(?:code|function|class|compile|debug|implement|algorithm|repository|bug)\b/u.test(normalized) ? 1 : 0}`);
  add(`summarize:${/\b(?:summari[sz]e|overview|key points|tl;dr)\b/u.test(normalized) ? 1 : 0}`);
  for (const [field, value] of [["task-class", row.taskClass], ["workflow", row.workflow]] as const) {
    if (value?.trim()) add(`context:${field}:${value.trim().toLocaleLowerCase().slice(0, 100)}`);
  }
  return counts;
}

function vectorize(training: BenchmarkCase[], queries: BenchmarkCase[]): { train: Vector[]; queries: Vector[] } {
  const trainCounts = training.map(features);
  const queryCounts = queries.map(features);
  const documentFrequency = new Map<number, number>();
  for (const rowFeatures of trainCounts) {
    for (const feature of rowFeatures.keys()) {
      documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1);
    }
  }
  const idf = new Map<number, number>();
  for (const [feature, frequency] of documentFrequency) {
    idf.set(feature, Math.log((1 + training.length) / (1 + frequency)) + 1);
  }

  const applyIdfAndNormalize = (rows: Map<number, number>[]): Vector[] => rows.map((rowFeatures) => {
    const vector = new Map<number, number>();
    let squaredNorm = 0;
    for (const [feature, count] of rowFeatures) {
      const weight = (1 + Math.log(count)) * (idf.get(feature) ?? 1);
      vector.set(feature, weight);
      squaredNorm += weight * weight;
    }
    const norm = Math.sqrt(squaredNorm) || 1;
    for (const [feature, weight] of vector) vector.set(feature, weight / norm);
    return vector;
  });

  return { train: applyIdfAndNormalize(trainCounts), queries: applyIdfAndNormalize(queryCounts) };
}

function cosine(left: Vector, right: Vector): number {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let sum = 0;
  for (const [feature, value] of smaller) sum += value * (larger.get(feature) ?? 0);
  return sum;
}

export function choicesFor(rows: BenchmarkCase[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row.predictions)))].sort();
}

export function eligibleChoices(row: BenchmarkCase, choices: string[], requireTokens: boolean): string[] {
  return choices.filter((choice) => Number.isFinite(row.predictions[choice]?.score) &&
    Number.isFinite(row.predictions[choice]?.costUsd) && (!requireTokens ||
      (Number.isFinite(row.predictions[choice]?.inputTokens) && Number.isFinite(row.predictions[choice]?.outputTokens))));
}

function meanTokensForChoice(rows: BenchmarkCase[], choice: string): number | null {
  const values = rows.map((row) => {
    const prediction = row.predictions[choice];
    return Number.isFinite(prediction?.inputTokens) && Number.isFinite(prediction?.outputTokens)
      ? prediction!.inputTokens! + prediction!.outputTokens!
      : undefined;
  });
  return values.every((value) => value !== undefined) ? mean(values as number[]) : null;
}

export function bestSingleChoice(rows: BenchmarkCase[], choices: string[]): string {
  const averages = choices.map((choice) => ({
    choice,
    score: mean(rows.map((row) => row.predictions[choice]!.score)),
    cost: mean(rows.map((row) => row.predictions[choice]!.costUsd!)),
    isFullContext: rows.every((row) => row.predictions[choice]!.contextProfileId === undefined &&
      row.predictions[choice]!.maxOutputTokens === undefined),
  })).filter((item) => item.isFullContext);
  averages.sort((left, right) => right.score - left.score || left.cost - right.cost || left.choice.localeCompare(right.choice));
  if (averages.length === 0) throw new Error("Contextual router needs at least one full-context baseline choice.");
  return averages[0]!.choice;
}

function nextRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** Cluster bootstrap lower bound; duplicate prompt groups are resampled together. */
export function groupBootstrapLowerBound(
  deltas: number[],
  groups: string[],
  samples: number,
  seed: string,
): number {
  const grouped = new Map<string, number[]>();
  deltas.forEach((delta, index) => {
    const group = groups[index]!;
    const values = grouped.get(group) ?? [];
    values.push(delta);
    grouped.set(group, values);
  });
  const groupValues = [...grouped.values()];
  const random = nextRandom(seed);
  const distribution = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (let draw = 0; draw < groupValues.length; draw += 1) {
      const selected = groupValues[Math.floor(random() * groupValues.length)]!;
      for (const value of selected) {
        total += value;
        count += 1;
      }
    }
    distribution[sample] = total / count;
  }
  distribution.sort((left, right) => left - right);
  return distribution[Math.floor((samples - 1) * 0.05)]!;
}

/**
 * Simultaneous lower confidence bounds across every candidate configuration.
 *
 * Scoring many configurations on one validation split and keeping the best one
 * biases that winner upward: its per-configuration bound holds for a
 * pre-specified configuration, not for the maximum over a search. Measured on
 * MMLU-Pro, the uncorrected bound let configurations through that then lost up
 * to 3.26 pp on held-out test while reporting a safe validation bound.
 *
 * This resamples prompt groups ONCE per draw and evaluates every configuration
 * on the same resample, then takes the quantile of the worst-case deviation
 * across configurations. The resulting band is wide enough to cover the whole
 * search, so a configuration clearing it clears it as a selection, not as a
 * lucky draw. Less conservative than a Bonferroni split of alpha, because it
 * accounts for configurations being highly correlated with one another.
 */
export function simultaneousGroupBootstrapLowerBounds(
  deltasByConfiguration: number[][],
  groups: string[],
  samples: number,
  seed: string,
  alpha = 0.05,
): number[] {
  const configurations = deltasByConfiguration.length;
  if (configurations === 0) return [];
  if (deltasByConfiguration.some((deltas) => deltas.length !== groups.length)) {
    throw new Error("Every configuration needs one delta per validation record.");
  }
  const indicesByGroup = new Map<string, number[]>();
  groups.forEach((group, index) => {
    const list = indicesByGroup.get(group) ?? [];
    list.push(index);
    indicesByGroup.set(group, list);
  });
  const groupIndices = [...indicesByGroup.values()];
  const pointEstimates = deltasByConfiguration.map((deltas) => mean(deltas));
  const random = nextRandom(seed);

  // Pass one: resample prompt groups once per draw and score every configuration
  // on that same resample, so configurations stay correlated as they are in truth.
  const resampleMeans: number[][] = new Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    const totals = new Array<number>(configurations).fill(0);
    let count = 0;
    for (let draw = 0; draw < groupIndices.length; draw += 1) {
      const selected = groupIndices[Math.floor(random() * groupIndices.length)]!;
      for (const index of selected) {
        for (let configuration = 0; configuration < configurations; configuration += 1) {
          totals[configuration] += deltasByConfiguration[configuration]![index]!;
        }
        count += 1;
      }
    }
    for (let configuration = 0; configuration < configurations; configuration += 1) {
      totals[configuration] /= count;
    }
    resampleMeans[sample] = totals;
  }

  // Each configuration's own bootstrap standard error. Without this the band
  // would be set by whichever configuration is noisiest, which has nothing to do
  // with the uncertainty of the one actually selected.
  const standardErrors = new Array<number>(configurations);
  for (let configuration = 0; configuration < configurations; configuration += 1) {
    let sumSquares = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const deviation = resampleMeans[sample]![configuration]! - pointEstimates[configuration]!;
      sumSquares += deviation * deviation;
    }
    standardErrors[configuration] = Math.sqrt(sumSquares / Math.max(1, samples - 1)) || Number.EPSILON;
  }

  // Pass two: the studentised max-t statistic over configurations.
  const errors = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let worst = Number.NEGATIVE_INFINITY;
    for (let configuration = 0; configuration < configurations; configuration += 1) {
      const studentised =
        (pointEstimates[configuration]! - resampleMeans[sample]![configuration]!) / standardErrors[configuration]!;
      if (studentised > worst) worst = studentised;
    }
    errors[sample] = worst;
  }
  errors.sort((left, right) => left - right);
  const critical = errors[Math.min(samples - 1, Math.ceil((samples - 1) * (1 - alpha)))]!;
  return pointEstimates.map((estimate, configuration) => estimate - critical * standardErrors[configuration]!);
}

export function neighborOrders(training: BenchmarkCase[], queries: BenchmarkCase[]): Array<Array<{ index: number; similarity: number }>> {
  const vectors = vectorize(training, queries);
  return vectors.queries.map((query) => vectors.train
    .map((candidate, index) => ({ index, similarity: cosine(query, candidate) }))
    .sort((left, right) => right.similarity - left.similarity || left.index - right.index));
}

function predictChoices(
  rows: BenchmarkCase[],
  orders: Array<Array<{ index: number; similarity: number }>>,
  choices: string[],
  k: number,
  localWeight: number,
): WeightedChoice[][] {
  const global = choices.map((choice) => ({
    score: mean(rows.map((row) => row.predictions[choice]!.score)),
    cost: mean(rows.map((row) => row.predictions[choice]!.costUsd!)),
    tokens: meanTokensForChoice(rows, choice),
  }));
  return orders.map((order) => {
    const neighbors = order.slice(0, Math.min(k, order.length));
    const rawWeights = neighbors.map(({ similarity }) => Math.max(0, similarity) ** 2);
    const weights = rawWeights.every((weight) => weight === 0) ? rawWeights.map(() => 1) : rawWeights;
    const denominator = weights.reduce((sum, weight) => sum + weight, 0);
    return choices.map((choice, choiceIndex) => {
      let localScore = 0;
      let localCost = 0;
      let localTokens = 0;
      let localTokensComplete = true;
      neighbors.forEach(({ index }, neighborIndex) => {
        const prediction = rows[index]!.predictions[choice]!;
        const weight = weights[neighborIndex]! / denominator;
        localScore += prediction.score * weight;
        localCost += prediction.costUsd! * weight;
        if (Number.isFinite(prediction.inputTokens) && Number.isFinite(prediction.outputTokens)) {
          localTokens += (prediction.inputTokens! + prediction.outputTokens!) * weight;
        } else {
          localTokensComplete = false;
        }
      });
      return {
        choice,
        score: localWeight * localScore + (1 - localWeight) * global[choiceIndex]!.score,
        cost: localWeight * localCost + (1 - localWeight) * global[choiceIndex]!.cost,
        tokens: localTokensComplete && global[choiceIndex]!.tokens !== null
          ? localWeight * localTokens + (1 - localWeight) * global[choiceIndex]!.tokens!
          : null,
      };
    });
  });
}

function route(
  predictions: WeightedChoice[],
  objective: ContextualObjective,
  qualityDrop: number,
  baselineChoice: string,
): string {
  const eligible = objective !== "cost" ? predictions.filter(({ tokens }) => tokens !== null) : predictions;
  if (eligible.length === 0) throw new Error("No contextual route has complete usage for the selected objective.");
  const bestPredictedScore = Math.max(...eligible.map(({ score }) => score));
  const qualityEligible = eligible.filter(({ score }) => score >= bestPredictedScore - qualityDrop);
  if (objective === "cost_and_tokens") {
    const baseline = predictions.find(({ choice }) => choice === baselineChoice);
    if (!baseline || baseline.tokens === null) throw new Error("The best-single fallback needs complete token usage for cost-and-token routing.");
    const dominatesBaseline = qualityEligible.filter(({ cost, tokens }) => cost <= baseline.cost && tokens !== null && tokens <= baseline.tokens!);
    if (dominatesBaseline.length === 0) return baselineChoice;
    return [...dominatesBaseline]
      .sort((left, right) => (left.cost / Math.max(baseline.cost, Number.EPSILON) + left.tokens! / Math.max(baseline.tokens!, 1)) -
        (right.cost / Math.max(baseline.cost, Number.EPSILON) + right.tokens! / Math.max(baseline.tokens!, 1)) ||
        right.score - left.score || left.choice.localeCompare(right.choice))[0]!.choice;
  }
  return [...qualityEligible]
    .sort((left, right) => (objective === "cost" ? left.cost - right.cost : left.tokens! - right.tokens!) ||
      right.score - left.score || left.choice.localeCompare(right.choice))[0]!.choice;
}

function scoreConfiguration(
  validationRows: BenchmarkCase[],
  predictions: WeightedChoice[][],
  baselineChoice: string,
  objective: ContextualObjective,
  qualityDrop: number,
  bootstrapSamples: number,
  seed: string,
  k: number,
  localWeight: number,
): ConfigurationScore {
  const selected = predictions.map((row) => route(row, objective, qualityDrop, baselineChoice));
  const scores = selected.map((choice, index) => validationRows[index]!.predictions[choice]!.score);
  const baselineScores = validationRows.map((row) => row.predictions[baselineChoice]!.score);
  const costs = selected.map((choice, index) => validationRows[index]!.predictions[choice]!.costUsd!);
  const tokens = selected.map((choice, index) => {
    const prediction = validationRows[index]!.predictions[choice]!;
    return Number.isFinite(prediction.inputTokens) && Number.isFinite(prediction.outputTokens)
      ? prediction.inputTokens! + prediction.outputTokens!
      : undefined;
  });
  const deltas = scores.map((score, index) => score - baselineScores[index]!);
  if (objective === "tokens" && tokens.some((value) => value === undefined)) {
    throw new Error("Token objective selected a route with incomplete token usage.");
  }
  const meanCost = mean(costs);
  const meanTokens = tokens.every((value) => value !== undefined) ? mean(tokens as number[]) : null;
  const baselineMeanCost = mean(validationRows.map((row) => row.predictions[baselineChoice]!.costUsd!));
  const baselineMeanTokens = meanTokensForChoice(validationRows, baselineChoice);
  const objectiveValue = objective === "cost"
    ? meanCost
    : objective === "tokens"
      ? meanTokens!
      : meanCost / Math.max(baselineMeanCost, Number.EPSILON) + meanTokens! / Math.max(baselineMeanTokens!, 1);
  return {
    k,
    localWeight,
    choices: selected,
    meanQuality: mean(scores),
    meanCost,
    meanTokens,
    // Filled in jointly across configurations; see simultaneousGroupBootstrapLowerBounds.
    qualityDeltaLower95: Number.NaN,
    objectiveValue,
    deltas,
  };
}

/**
 * Selects a prompt-neighbor router on an explicit validation partition and
 * produces frozen choices for a separate test partition. Prompt text is the
 * only per-request feature; model scores and prices are training labels.
 */
export function learnContextualRouter(
  trainRows: BenchmarkCase[],
  validationRows: BenchmarkCase[],
  testRows: BenchmarkCase[],
  objective: ContextualObjective,
  options: ContextualRouterOptions = {},
): ContextualRouterSelection {
  if (trainRows.length === 0 || validationRows.length === 0 || testRows.length === 0) {
    throw new Error("Contextual router requires non-empty train, validation, and test partitions.");
  }
  const qualityDrop = options.maximumQualityDrop ?? 0.02;
  const minimumValidationGroups = options.minimumValidationGroups ?? 100;
  const bootstrapSamples = options.bootstrapSamples ?? 2_000;
  const seed = options.seed ?? "flux-context-knn-v1";
  if (!Number.isFinite(qualityDrop) || qualityDrop < 0 || qualityDrop > 1) {
    throw new Error("maximumQualityDrop must be between 0 and 1.");
  }
  if (!Number.isInteger(minimumValidationGroups) || minimumValidationGroups < 2) {
    throw new Error("minimumValidationGroups must be an integer of at least 2.");
  }
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples < 100) {
    throw new Error("bootstrapSamples must be an integer of at least 100.");
  }
  const allChoices = choicesFor(trainRows);
  const requireTokens = objective !== "cost";
  const choices = allChoices.filter((choice) => trainRows.every((row) => eligibleChoices(row, allChoices, requireTokens).includes(choice)) &&
    validationRows.every((row) => eligibleChoices(row, allChoices, requireTokens).includes(choice)) &&
    testRows.every((row) => eligibleChoices(row, allChoices, requireTokens).includes(choice)));
  if (choices.length < 2) throw new Error("Contextual routing requires at least two choices with complete scores, costs, and token counts.");
  const baselineChoice = bestSingleChoice(trainRows, choices);
  const validationGroups = new Set(validationRows.map((row) => row.groupId ?? row.id)).size;
  const passing: ConfigurationScore[] = [];
  const candidates: Array<{ scored: ConfigurationScore; objectiveImproved: boolean }> = [];
  if (validationGroups >= minimumValidationGroups) {
    const validationOrders = neighborOrders(trainRows, validationRows);
    for (const k of NEIGHBOR_COUNTS) {
      for (const localWeight of LOCAL_WEIGHTS) {
        const predictions = predictChoices(trainRows, validationOrders, choices, k, localWeight);
        const scored = scoreConfiguration(
          validationRows,
          predictions,
          baselineChoice,
          objective,
          qualityDrop,
          bootstrapSamples,
          seed,
          k,
          localWeight,
        );
        const baselineCost = mean(validationRows.map((row) => row.predictions[baselineChoice]!.costUsd!));
        const baselineMeanTokens = meanTokensForChoice(validationRows, baselineChoice);
        const baselineObjective = objective === "cost"
          ? baselineCost
          : objective === "tokens"
            ? mean(validationRows.map((row) => {
              const prediction = row.predictions[baselineChoice]!;
              return prediction.inputTokens! + prediction.outputTokens!;
            }))
            : baselineCost / Math.max(baselineCost, Number.EPSILON) + (baselineMeanTokens ?? 0) / Math.max(baselineMeanTokens ?? 1, 1);
        const objectiveImproved = objective === "cost"
          ? scored.objectiveValue < baselineObjective
          : objective === "tokens"
            ? scored.objectiveValue < baselineObjective
            : scored.meanCost !== null && scored.meanCost < baselineCost && scored.meanTokens !== null &&
              baselineMeanTokens !== null && scored.meanTokens < baselineMeanTokens;
        candidates.push({ scored, objectiveImproved });
      }
    }
    // One bound covering the whole search, so the selected configuration's
    // guarantee survives having been chosen as the best of many.
    const bounds = simultaneousGroupBootstrapLowerBounds(
      candidates.map(({ scored }) => scored.deltas),
      validationRows.map((row) => row.groupId ?? row.id),
      bootstrapSamples,
      `${seed}:${objective}`,
    );
    candidates.forEach(({ scored }, index) => { scored.qualityDeltaLower95 = bounds[index]!; });
    for (const { scored, objectiveImproved } of candidates) {
      if (scored.qualityDeltaLower95 >= -qualityDrop && objectiveImproved) passing.push(scored);
    }
  }

  const fallbackChoices = testRows.map(() => baselineChoice);
  const noSelection: Omit<ContextualRouterSelection, "choiceByCaseId"> = {
    router: `flux_context_knn_${objective}`,
    objective,
    selectedK: null,
    selectedLocalWeight: null,
    validationSamples: validationRows.length,
    validationGroups,
    minimumValidationGroups,
    validationMeanQualityDelta: 0,
    validationLower95QualityDelta: 0,
    validationMeanCostUsd: mean(validationRows.map((row) => row.predictions[baselineChoice]!.costUsd!)),
    validationMeanTokens: meanTokensForChoice(validationRows, baselineChoice),
    fellBackToBestSingle: true,
    fallbackReason: validationGroups < minimumValidationGroups
      ? "insufficient_validation_groups"
      : "no_validation_configuration",
  };
  if (passing.length === 0) {
    return { ...noSelection, choiceByCaseId: Object.fromEntries(testRows.map((row, index) => [row.id, fallbackChoices[index]!])) };
  }

  passing.sort((left, right) => left.objectiveValue - right.objectiveValue ||
    right.meanQuality - left.meanQuality || left.k - right.k || left.localWeight - right.localWeight);
  const selected = passing[0]!;
  const testOrders = neighborOrders(trainRows, testRows);
  const testPredictions = predictChoices(trainRows, testOrders, choices, selected.k, selected.localWeight);
  const testChoices = testPredictions.map((row) => route(row, objective, qualityDrop, baselineChoice));
  const selectedScores = selected.choices.map((choice, index) => validationRows[index]!.predictions[choice]!.score);
  const baselineScores = validationRows.map((row) => row.predictions[baselineChoice]!.score);
  return {
    router: `flux_context_knn_${objective}`,
    objective,
    choiceByCaseId: Object.fromEntries(testRows.map((row, index) => [row.id, testChoices[index]!])),
    selectedK: selected.k,
    selectedLocalWeight: selected.localWeight,
    validationSamples: validationRows.length,
    validationGroups,
    minimumValidationGroups,
    validationMeanQualityDelta: mean(selectedScores.map((score, index) => score - baselineScores[index]!)),
    validationLower95QualityDelta: selected.qualityDeltaLower95,
    validationMeanCostUsd: selected.meanCost,
    validationMeanTokens: selected.meanTokens,
    fellBackToBestSingle: false,
  };
}
