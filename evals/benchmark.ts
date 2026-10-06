import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chooseRoute } from "../packages/sdk-js/src/routing.js";
import type { FluxRoutingPolicy } from "../packages/sdk-js/src/types.js";

export type BenchmarkPrediction = {
  score: number;
  /** Provider model identifier; differs from the choice key for context/cap variants. */
  targetModel?: string;
  contextProfileId?: string;
  maxOutputTokens?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  output?: unknown;
};

export type BenchmarkCase = {
  dataset: string;
  split: string;
  id: string;
  groupId?: string;
  taskClass?: string;
  workflow?: string;
  input?: string;
  expected?: unknown;
  predictions: Record<string, BenchmarkPrediction>;
  routerChoices?: Record<string, BenchmarkRouteChoice>;
};

export type BenchmarkRouteChoice = {
  choice: string;
  /** Include per-request router inference cost; use 0 for a no-inference router. */
  routingCostUsd?: number;
  routingInputTokens?: number;
  routingOutputTokens?: number;
};

export type BenchmarkStrategyResult = {
  name: string;
  sampleSize: number;
  meanQuality: number;
  meanCostUsd: number | null;
  totalCostUsd: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  totalTokens: number | null;
  routingCostUsd: number | null;
  routingInputTokens: number | null;
  routingOutputTokens: number | null;
  qualityDeltaFromBestSingle: number;
  qualityDeltaLower95: number;
  costSavingsVsBestSinglePercent: number | null;
  selectedModels: Record<string, number>;
  routesByWorkflow: Record<string, string>;
  routeReasons: Record<string, number>;
  perWorkflow: Record<string, { sampleSize: number; meanQuality: number; meanCostUsd: number | null }>;
};

export type BenchmarkComparison = {
  schemaVersion: 1;
  method: "offline_precomputed_outputs";
  dataset: string;
  trainSplit: string;
  testSplit: string;
  trainSamples: number;
  testSamples: number;
  models: string[];
  excludedModels: Record<string, string>;
  externalRouters: string[];
  settings: {
    maximumQualityDrop: number;
    minimumWorkflowSamples: number;
    bootstrapSamples: number;
    seed: string;
  };
  learned: {
    bestSingleChoice: string;
    bestSingleModel: string;
    cheapestStaticChoice: string;
    cheapestStaticModel: string;
    fluxChoiceByWorkflow: Record<string, string>;
    fluxModelByWorkflow: Record<string, string>;
    targetByChoice: Record<string, { model: string; contextProfileId?: string; maxOutputTokens?: number }>;
    trainingQualityDeltaLower95ByWorkflow: Record<string, number>;
    policies: FluxRoutingPolicy[];
  };
  results: BenchmarkStrategyResult[];
  notice: string;
};

export type BenchmarkOptions = {
  maximumQualityDrop?: number;
  minimumWorkflowSamples?: number;
  bootstrapSamples?: number;
  seed?: string;
};

type LLMRouterBenchRecord = {
  index?: string | number;
  origin_query?: string;
  prompt?: string;
  prediction?: unknown;
  ground_truth?: unknown;
  score?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
};

type LLMRouterBenchFile = {
  records?: LLMRouterBenchRecord[];
};

type CaptureAttempt = {
  model?: string;
  contextProfileId?: string;
  maxOutputTokens?: number;
  response?: unknown;
  error?: string;
  score?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

type CaptureRecord = {
  schemaVersion?: number;
  caseId?: string;
  groupId?: string;
  request?: unknown;
  expected?: unknown;
  workflow?: string;
  taskClass?: string;
  cacheHit?: boolean;
  attempts?: CaptureAttempt[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function jsonFilesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => jsonFilesUnder(join(path, entry.name))));
  return [
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(path, entry.name)),
    ...nested.flat(),
  ].sort();
}

/**
 * Read one already-extracted LLMRouterBench dataset/split. This intentionally
 * never downloads or unpickles the upstream archive.
 */
export async function loadLLMRouterBenchPartition(
  root: string,
  dataset: string,
  split: string,
  requestedModels?: string[],
): Promise<BenchmarkCase[]> {
  if (!dataset || dataset.includes("/") || dataset.includes("\\") || dataset === "." || dataset === "..") {
    throw new Error("dataset must be a single LLMRouterBench directory name.");
  }
  if (!split || split.includes("/") || split.includes("\\") || split === "." || split === "..") {
    throw new Error("split must be a single LLMRouterBench directory name.");
  }
  const partitionPath = resolve(root, dataset, split);
  const modelEntries = (await readdir(partitionPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const selectedNames = requestedModels?.length ? requestedModels : modelEntries.map(({ name }) => name);
  const rowsById = new Map<string, BenchmarkCase>();
  const modelNames = new Set(modelEntries.map(({ name }) => name));
  if (selectedNames.length < 2) throw new Error("Choose at least two model directories for a routing benchmark.");
  for (const model of selectedNames) {
    if (!modelNames.has(model)) throw new Error(`Model directory ${model} is missing under ${partitionPath}.`);
    const files = await jsonFilesUnder(join(partitionPath, model));
    if (files.length === 0) throw new Error(`No JSON result files found for model ${model}.`);
    const latest = files.at(-1)!;
    const parsed = JSON.parse(await readFile(latest, "utf8")) as LLMRouterBenchFile;
    if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
      throw new Error(`${latest} does not contain a non-empty records array.`);
    }
    const seen = new Set<string>();
    for (const [index, record] of parsed.records.entries()) {
      const prompt = typeof record.prompt === "string" ? record.prompt : record.origin_query;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error(`${latest} record ${index} is missing prompt/origin_query.`);
      }
      const recordKey = record.index === undefined
        ? createHash("sha256").update(prompt).digest("hex")
        : String(record.index);
      const id = `${dataset}:${recordKey}`;
      if (seen.has(id)) throw new Error(`${latest} contains duplicate record key ${recordKey}.`);
      seen.add(id);
      if (!Number.isFinite(record.score) || record.score! < 0 || record.score! > 1) {
        throw new Error(`${latest} record ${recordKey} score must be normalized to [0, 1].`);
      }
      for (const [field, value] of Object.entries({
        cost: record.cost,
        prompt_tokens: record.prompt_tokens,
        completion_tokens: record.completion_tokens,
      })) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new Error(`${latest} record ${recordKey} has invalid ${field}.`);
        }
      }
      const existing = rowsById.get(id);
      if (existing && (existing.input !== prompt || canonical(existing.expected) !== canonical(record.ground_truth))) {
        throw new Error(`${latest} does not align with other models at record ${recordKey}; prompt or ground_truth differs.`);
      }
      const row = existing ?? {
        dataset,
        split,
        id,
        groupId: createHash("sha256").update(prompt.trim().replace(/\s+/g, " ").toLocaleLowerCase()).digest("hex"),
        taskClass: dataset,
        workflow: dataset,
        input: prompt,
        expected: record.ground_truth,
        predictions: {},
      } satisfies BenchmarkCase;
      row.predictions[model] = {
        score: record.score!,
        targetModel: model,
        costUsd: record.cost,
        inputTokens: record.prompt_tokens,
        outputTokens: record.completion_tokens,
        output: record.prediction,
      };
      rowsById.set(id, row);
    }
  }
  const rows = [...rowsById.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const row of rows) {
    if (Object.keys(row.predictions).length !== selectedNames.length) {
      throw new Error(`Record ${row.id} is missing one or more selected model outputs; aligned evaluation requires paired coverage.`);
    }
  }
  return rows;
}

/** Pair opt-in FLUX SDK capture rows by stable case ID and model attempt. */
export function normalizeFluxCaptures(
  records: unknown[],
  dataset: string,
  split: string,
): BenchmarkCase[] {
  if (!dataset || !split) throw new Error("Capture normalization requires dataset and split names.");
  if (records.length === 0) throw new Error("Capture JSONL is empty.");
  const cases = new Map<string, BenchmarkCase>();
  for (const [index, rawRecord] of records.entries()) {
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
      throw new Error(`Capture record ${index} must be a JSON object.`);
    }
    const record = rawRecord as CaptureRecord;
    if (record.schemaVersion !== 1 || !record.caseId?.trim() || !Array.isArray(record.attempts)) {
      throw new Error(`Capture record ${index} has an unsupported schema or no stable caseId/attempts.`);
    }
    if (record.cacheHit) throw new Error(`Capture case ${record.caseId} was served from exact cache; disable exactCache for paired routing evaluation.`);
    const id = record.caseId;
    const input = record.request && typeof record.request === "object" && "input" in record.request
      ? (record.request as { input?: unknown }).input
      : undefined;
    const inputText = typeof input === "string" ? input : input === undefined ? undefined : canonical(input);
    const existing = cases.get(id);
    if (existing && canonical(existing.expected) !== canonical(record.expected)) {
      throw new Error(`Capture case ${id} has conflicting expected values.`);
    }
    if (existing && record.groupId !== undefined && existing.groupId !== record.groupId) {
      throw new Error(`Capture case ${id} has conflicting groupId values.`);
    }
    const row = existing ?? {
      dataset,
      split,
      id,
      groupId: record.groupId ?? (inputText === undefined
        ? createHash("sha256").update(id).digest("hex")
        : createHash("sha256").update(inputText.trim().replace(/\s+/g, " ").toLocaleLowerCase()).digest("hex")),
      taskClass: record.taskClass,
      workflow: record.workflow,
      input: inputText,
      expected: record.expected,
      predictions: {},
    } satisfies BenchmarkCase;
    if (existing && (existing.workflow !== record.workflow || existing.taskClass !== record.taskClass)) {
      throw new Error(`Capture case ${id} has conflicting workflow/taskClass context.`);
    }
    for (const [attemptIndex, attempt] of record.attempts.entries()) {
      if (!attempt.model || attempt.error || !Number.isFinite(attempt.score) || attempt.score! < 0 || attempt.score! > 1) {
        throw new Error(`Capture case ${id}, attempt ${attemptIndex} needs a successful model output and normalized [0, 1] score.`);
      }
      if (!Number.isFinite(attempt.costUsd) || !Number.isFinite(attempt.inputTokens) || !Number.isFinite(attempt.outputTokens)) {
        throw new Error(`Capture case ${id}, model ${attempt.model} is missing complete cost/token usage; configure pricing and provider usage.`);
      }
      const variant = [
        attempt.contextProfileId ? `context:${attempt.contextProfileId}` : undefined,
        attempt.maxOutputTokens !== undefined ? `max-output:${attempt.maxOutputTokens}` : undefined,
      ].filter(Boolean).join("+");
      const choice = variant ? `${attempt.model}::${variant}` : attempt.model;
      if (row.predictions[choice]) {
        throw new Error(`Capture case ${id} contains more than one result for choice ${choice}; use distinct case IDs for separate draws.`);
      }
      row.predictions[choice] = {
        score: attempt.score!,
        targetModel: attempt.model,
        contextProfileId: attempt.contextProfileId,
        maxOutputTokens: attempt.maxOutputTokens,
        costUsd: attempt.costUsd,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        output: attempt.response,
      };
    }
    cases.set(id, row);
  }
  const normalized = [...cases.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (normalized.some((row) => Object.keys(row.predictions).length < 2)) {
    throw new Error("Every captured case needs paired successful outputs from at least two models. Run the same case IDs against each model first.");
  }
  return normalized;
}

/** Attach per-case choices emitted by another router so its route can be scored on the same outputs. */
export function attachRouterChoices(rows: BenchmarkCase[], rawChoices: unknown[]): BenchmarkCase[] {
  if (rows.length === 0) throw new Error("Cannot attach router choices to an empty test set.");
  const rowsById = new Map(rows.map((row) => [row.id, { ...row, routerChoices: { ...row.routerChoices } }]));
  const coverage = new Map<string, number>();
  for (const [index, raw] of rawChoices.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Router decision ${index} must be a JSON object.`);
    }
    const decision = raw as Record<string, unknown>;
    const id = typeof decision.id === "string" ? decision.id : "";
    const name = typeof decision.router === "string" ? decision.router : "";
    const choice = typeof decision.choice === "string" ? decision.choice :
      typeof decision.model === "string" ? decision.model : "";
    if (!id || !name || !choice) throw new Error(`Router decision ${index} needs id, router, and choice/model.`);
    const row = rowsById.get(id);
    if (!row) throw new Error(`Router ${name} selected unknown test record ${id}.`);
    if (!row.predictions[choice]) throw new Error(`Router ${name} selected ${choice}, which has no paired output for ${id}.`);
    for (const field of ["routingCostUsd", "routingInputTokens", "routingOutputTokens"] as const) {
      const value = decision[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new Error(`Router decision ${index} has invalid ${field}.`);
      }
    }
    if (row.routerChoices?.[name]) throw new Error(`Router ${name} has duplicate decisions for ${id}.`);
    row.routerChoices = {
      ...row.routerChoices,
      [name]: {
        choice,
        routingCostUsd: decision.routingCostUsd as number | undefined,
        routingInputTokens: decision.routingInputTokens as number | undefined,
        routingOutputTokens: decision.routingOutputTokens as number | undefined,
      },
    };
    coverage.set(name, (coverage.get(name) ?? 0) + 1);
  }
  for (const [name, count] of coverage) {
    if (count !== rows.length) throw new Error(`Router ${name} has decisions for ${count}/${rows.length} test cases; complete paired coverage is required.`);
  }
  return [...rowsById.values()];
}

type ResolvedOptions = Required<BenchmarkOptions>;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function validateRows(rows: BenchmarkCase[], label: string): void {
  if (rows.length === 0) throw new Error(`${label} partition is empty.`);
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!row.dataset || !row.split || !row.id || !row.predictions || typeof row.predictions !== "object") {
      throw new Error(`${label} record ${index} needs dataset, split, id, and predictions.`);
    }
    const identity = `${row.dataset}:${row.split}:${row.id}`;
    if (ids.has(identity)) throw new Error(`${label} contains duplicate record ${identity}.`);
    ids.add(identity);
    if (Object.keys(row.predictions).length === 0) throw new Error(`${label} record ${identity} has no model predictions.`);
    for (const [model, prediction] of Object.entries(row.predictions)) {
      if (!model || !prediction || !Number.isFinite(prediction.score) || prediction.score < 0 || prediction.score > 1) {
        throw new Error(`${label} record ${identity} has an invalid score for ${model}; scores must be in [0, 1].`);
      }
      for (const [name, value] of Object.entries({
        costUsd: prediction.costUsd,
        inputTokens: prediction.inputTokens,
        outputTokens: prediction.outputTokens,
      })) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new Error(`${label} record ${identity} has invalid ${name} for ${model}.`);
        }
      }
    }
  }
}

function workflowFor(row: BenchmarkCase): string {
  return row.workflow || row.taskClass || "default";
}

function completeForModel(rows: BenchmarkCase[], model: string, needsCost: boolean): boolean {
  return rows.every((row) => {
    const prediction = row.predictions[model];
    return prediction !== undefined && Number.isFinite(prediction.score) &&
      (!needsCost || Number.isFinite(prediction.costUsd));
  });
}

function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapLowerBound(values: number[], samples: number, seed: string): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  if (values.length === 1) return values[0]!;
  const random = seededRandom(seed);
  const distribution = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)]!;
    }
    distribution[sample] = total / values.length;
  }
  distribution.sort(compareNumber);
  return distribution[Math.floor((samples - 1) * 0.05)]!;
}

function completeSum(rows: BenchmarkCase[], models: string[], field: "costUsd" | "inputTokens" | "outputTokens"): number | null {
  const values: number[] = [];
  for (const [index, row] of rows.entries()) {
    const prediction = row.predictions[models[index]!];
    const value = prediction?.[field];
    if (!Number.isFinite(value)) return null;
    values.push(value!);
  }
  return values.reduce((total, value) => total + value, 0);
}

function summarize(
  name: BenchmarkStrategyResult["name"],
  rows: BenchmarkCase[],
  selectedModels: string[],
  baselineScores: number[],
  baselineCost: number | null,
  routesByWorkflow: Record<string, string>,
  routeReasons: Record<string, number>,
  bootstrapSamples: number,
  seed: string,
  routingChoices?: Array<BenchmarkRouteChoice | undefined>,
): BenchmarkStrategyResult {
  const scores: number[] = [];
  const modelCounts: Record<string, number> = {};
  const workflowRows = new Map<string, { scores: number[]; costs: number[] }>();
  rows.forEach((row, index) => {
    const model = selectedModels[index]!;
    const prediction = row.predictions[model]!;
    scores.push(prediction.score);
    modelCounts[model] = (modelCounts[model] ?? 0) + 1;
    const workflow = workflowFor(row);
    const group = workflowRows.get(workflow) ?? { scores: [], costs: [] };
    group.scores.push(prediction.score);
    if (prediction.costUsd !== undefined) group.costs.push(prediction.costUsd);
    workflowRows.set(workflow, group);
  });
  const costs = selectedModels.map((model, index) => rows[index]!.predictions[model]!.costUsd);
  const modelCostUsd = costs.every((value) => Number.isFinite(value))
    ? costs.reduce<number>((total, value) => total + value!, 0)
    : null;
  const routingCosts = routingChoices?.map((decision) => decision?.routingCostUsd);
  const routingCostUsd = routingCosts === undefined
    ? 0
    : routingCosts.every((value) => Number.isFinite(value))
      ? routingCosts.reduce<number>((total, value) => total + value!, 0)
      : null;
  const totalCostUsd = modelCostUsd === null || routingCostUsd === null ? null : modelCostUsd + routingCostUsd;
  const inputs = selectedModels.map((model, index) => rows[index]!.predictions[model]!.inputTokens);
  const outputs = selectedModels.map((model, index) => rows[index]!.predictions[model]!.outputTokens);
  const totalInput = inputs.every((value) => Number.isFinite(value)) ? inputs.reduce<number>((sum, value) => sum + value!, 0) : null;
  const totalOutput = outputs.every((value) => Number.isFinite(value)) ? outputs.reduce<number>((sum, value) => sum + value!, 0) : null;
  const routingInput = routingChoices === undefined
    ? 0
    : routingChoices.every((decision) => Number.isFinite(decision?.routingInputTokens))
      ? routingChoices.reduce<number>((sum, decision) => sum + decision!.routingInputTokens!, 0)
      : null;
  const routingOutput = routingChoices === undefined
    ? 0
    : routingChoices.every((decision) => Number.isFinite(decision?.routingOutputTokens))
      ? routingChoices.reduce<number>((sum, decision) => sum + decision!.routingOutputTokens!, 0)
      : null;
  const perWorkflow = Object.fromEntries([...workflowRows].map(([workflow, group]) => [workflow, {
    sampleSize: group.scores.length,
    meanQuality: mean(group.scores),
    meanCostUsd: group.costs.length === group.scores.length ? mean(group.costs) : null,
  }]));
  const deltas = scores.map((score, index) => score - baselineScores[index]!);
  const difference = mean(deltas);
  return {
    name,
    sampleSize: rows.length,
    meanQuality: mean(scores),
    meanCostUsd: totalCostUsd === null ? null : totalCostUsd / rows.length,
    totalCostUsd,
    meanInputTokens: totalInput === null ? null : totalInput / rows.length,
    meanOutputTokens: totalOutput === null ? null : totalOutput / rows.length,
    totalTokens: totalInput === null || totalOutput === null || routingInput === null || routingOutput === null
      ? null
      : totalInput + totalOutput + routingInput + routingOutput,
    routingCostUsd,
    routingInputTokens: routingInput,
    routingOutputTokens: routingOutput,
    qualityDeltaFromBestSingle: difference,
    qualityDeltaLower95: bootstrapLowerBound(deltas, bootstrapSamples, `${seed}:test-${name}`),
    costSavingsVsBestSinglePercent: totalCostUsd === null || baselineCost === null || baselineCost <= 0
      ? null
      : ((baselineCost - totalCostUsd) / baselineCost) * 100,
    selectedModels: modelCounts,
    routesByWorkflow,
    routeReasons,
    perWorkflow,
  };
}

/**
 * Learns a quality-constrained lowest-cost route on train rows, then evaluates
 * all strategies only on separate test rows. Scores must be task-normalized to
 * [0, 1]; their interpretation is determined by the source benchmark.
 */
export function compareBenchmark(
  trainRows: BenchmarkCase[],
  testRows: BenchmarkCase[],
  options: BenchmarkOptions = {},
): BenchmarkComparison {
  const resolved: ResolvedOptions = {
    maximumQualityDrop: options.maximumQualityDrop ?? 0.02,
    minimumWorkflowSamples: options.minimumWorkflowSamples ?? 20,
    bootstrapSamples: options.bootstrapSamples ?? 2_000,
    seed: options.seed ?? "flux-benchmark-v1",
  };
  if (!Number.isFinite(resolved.maximumQualityDrop) || resolved.maximumQualityDrop < 0 || resolved.maximumQualityDrop > 1) {
    throw new Error("maximumQualityDrop must be between 0 and 1.");
  }
  if (!Number.isInteger(resolved.minimumWorkflowSamples) || resolved.minimumWorkflowSamples < 2) {
    throw new Error("minimumWorkflowSamples must be an integer of at least 2.");
  }
  if (!Number.isInteger(resolved.bootstrapSamples) || resolved.bootstrapSamples < 100) {
    throw new Error("bootstrapSamples must be an integer of at least 100.");
  }
  validateRows(trainRows, "Train");
  validateRows(testRows, "Test");
  const datasets = new Set([...trainRows, ...testRows].map((row) => row.dataset));
  if (datasets.size !== 1) throw new Error("Train and test rows must come from exactly one dataset.");
  const overlap = new Set(trainRows.map((row) => `${row.dataset}:${row.id}`));
  const groupOverlap = new Set(trainRows.map((row) => row.groupId ? `${row.dataset}:group:${row.groupId}` : undefined).filter(Boolean));
  if (testRows.some((row) => overlap.has(`${row.dataset}:${row.id}`) ||
      (row.groupId !== undefined && groupOverlap.has(`${row.dataset}:group:${row.groupId}`)))) {
    throw new Error("Train/test leakage detected: record IDs and group IDs must be disjoint.");
  }

  const allModels = [...new Set(trainRows.flatMap((row) => Object.keys(row.predictions)))].sort();
  const models = allModels.filter((model) => completeForModel(trainRows, model, true) && completeForModel(testRows, model, true));
  const excludedModels = Object.fromEntries(allModels.filter((model) => !models.includes(model)).map((model) => [
    model,
    "Missing a quality score or cost on at least one train/test record.",
  ]));
  if (models.length < 2) throw new Error("At least two model/context choices need complete quality and cost data across train and test.");

  const targetByChoice = Object.fromEntries(models.map((choice) => {
    const prediction = trainRows[0]!.predictions[choice];
    const target = {
      model: prediction?.targetModel ?? choice,
      contextProfileId: prediction?.contextProfileId,
      maxOutputTokens: prediction?.maxOutputTokens,
    };
    for (const row of [...trainRows, ...testRows]) {
      const candidate = row.predictions[choice];
      if (candidate && canonical({
        model: candidate.targetModel ?? choice,
        contextProfileId: candidate.contextProfileId,
        maxOutputTokens: candidate.maxOutputTokens,
      }) !== canonical(target)) {
        throw new Error(`Choice ${choice} maps to inconsistent model/context settings across records.`);
      }
    }
    return [choice, target];
  }));
  const baselineChoices = models.filter((choice) =>
    targetByChoice[choice]!.contextProfileId === undefined && targetByChoice[choice]!.maxOutputTokens === undefined,
  );
  if (baselineChoices.length === 0) throw new Error("No full-context, uncapped model choice is available as a safe baseline.");
  const trainQuality = new Map(models.map((choice) => [choice, mean(trainRows.map((row) => row.predictions[choice]!.score))]));
  const trainCost = new Map(models.map((choice) => [choice, mean(trainRows.map((row) => row.predictions[choice]!.costUsd!))]));
  const sortedByQuality = [...baselineChoices].sort((left, right) =>
    trainQuality.get(right)! - trainQuality.get(left)! || trainCost.get(left)! - trainCost.get(right)!,
  );
  const sortedByCost = [...models].sort((left, right) =>
    trainCost.get(left)! - trainCost.get(right)! || trainQuality.get(right)! - trainQuality.get(left)!,
  );
  const bestSingleChoice = sortedByQuality[0]!;
  const cheapestStaticChoice = sortedByCost[0]!;
  const bestSingleModel = targetByChoice[bestSingleChoice]!.model;
  const cheapestStaticModel = targetByChoice[cheapestStaticChoice]!.model;
  const baselineCost = completeSum(testRows, testRows.map(() => bestSingleChoice), "costUsd");
  const baselineScores = testRows.map((row) => row.predictions[bestSingleChoice]!.score);
  const workflows = [...new Set([...trainRows, ...testRows].map(workflowFor))].sort();
  const policies: FluxRoutingPolicy[] = [];
  const fluxChoiceByWorkflow: Record<string, string> = {};
  const trainingQualityDeltaLower95ByWorkflow: Record<string, number> = {};

  for (const workflow of workflows) {
    const cases = trainRows.filter((row) => workflowFor(row) === workflow);
    let selected = bestSingleChoice;
    let selectedLower = 0;
    let selectedDeltaLower = 0;
    if (cases.length >= resolved.minimumWorkflowSamples) {
      for (const candidate of [...models].sort((left, right) => trainCost.get(left)! - trainCost.get(right)!)) {
        if (candidate === bestSingleChoice) continue;
        const deltas = cases.map((row) => row.predictions[candidate]!.score - row.predictions[bestSingleChoice]!.score);
        const lower = bootstrapLowerBound(deltas, resolved.bootstrapSamples, `${resolved.seed}:${workflow}:${candidate}`);
        const candidateCost = mean(cases.map((row) => row.predictions[candidate]!.costUsd!));
        const baselineWorkflowCost = mean(cases.map((row) => row.predictions[bestSingleChoice]!.costUsd!));
        if (lower >= -resolved.maximumQualityDrop && candidateCost < baselineWorkflowCost) {
          selected = candidate;
          selectedDeltaLower = lower;
          selectedLower = bootstrapLowerBound(cases.map((row) => row.predictions[candidate]!.score), resolved.bootstrapSamples, `${resolved.seed}:${workflow}:${candidate}:quality`);
          break;
        }
      }
    }
    fluxChoiceByWorkflow[workflow] = selected;
    trainingQualityDeltaLower95ByWorkflow[workflow] = selected === bestSingleChoice
      ? 0
      : selectedDeltaLower;
    if (selected === bestSingleChoice) continue;
    const baselineTarget = targetByChoice[bestSingleChoice]!.model;
    const candidateTarget = targetByChoice[selected]!;
    const candidateMeanDelta = mean(cases.map((row) => row.predictions[bestSingleChoice]!.score - row.predictions[selected]!.score));
    policies.push({
      id: `flux-benchmark-${createHash("sha1").update(`${workflow}:${bestSingleChoice}:${selected}`).digest("hex").slice(0, 12)}`,
      taskClass: workflow,
      workflow,
      baselineModel: baselineTarget,
      minimumSamples: resolved.minimumWorkflowSamples,
      minimumCandidateAccuracyLower95: 0,
      maximumAccuracyDrop: resolved.maximumQualityDrop,
      candidates: [{
        model: candidateTarget.model,
        trafficShare: 1,
        approved: true,
        contextProfileId: candidateTarget.contextProfileId,
        maxOutputTokens: candidateTarget.maxOutputTokens,
        evidence: {
          baselineModel: baselineTarget,
          candidateModel: candidateTarget.model,
          eligibleForReview: true,
          sampleSize: cases.length,
          candidateAccuracyLower95: selectedLower,
          accuracyDrop: Math.max(0, candidateMeanDelta),
          baselineCostUsd: cases.reduce((sum, row) => sum + row.predictions[bestSingleChoice]!.costUsd!, 0),
          candidateCostUsd: cases.reduce((sum, row) => sum + row.predictions[selected]!.costUsd!, 0),
        },
      }],
    });
  }

  const bestSingle = summarize(
    "best_single_model", testRows, testRows.map(() => bestSingleChoice), baselineScores, baselineCost,
    Object.fromEntries(workflows.map((workflow) => [workflow, bestSingleChoice])), {}, resolved.bootstrapSamples, resolved.seed,
  );
  const cheapest = summarize(
    "cheapest_static", testRows, testRows.map(() => cheapestStaticChoice), baselineScores, baselineCost,
    Object.fromEntries(workflows.map((workflow) => [workflow, cheapestStaticChoice])), {}, resolved.bootstrapSamples, resolved.seed,
  );
  const fluxChoices: string[] = [];
  const fluxReasons: Record<string, number> = {};
  const fluxRoutes = Object.fromEntries(workflows.map((workflow) => [workflow, fluxChoiceByWorkflow[workflow]!]));
  for (const row of testRows) {
    const workflow = workflowFor(row);
    const routePolicy = policies.find((policy) => policy.workflow === workflow);
    const route = chooseRoute(routePolicy ? {
      policies: [routePolicy],
      getRequestKey: () => row.id,
    } : undefined, { model: bestSingleModel }, workflow, { taskClass: workflow, workflow });
    const selectedChoice = route.reason === "candidate_quality_and_cost_gates_passed"
      ? fluxChoiceByWorkflow[workflow]!
      : bestSingleChoice;
    fluxChoices.push(selectedChoice);
    fluxReasons[route.reason] = (fluxReasons[route.reason] ?? 0) + 1;
  }
  const flux = summarize("flux_quality_gated", testRows, fluxChoices, baselineScores, baselineCost, fluxRoutes, fluxReasons, resolved.bootstrapSamples, resolved.seed);
  const externalRouters = [...new Set(testRows.flatMap((row) => Object.keys(row.routerChoices ?? {})))].sort();
  const externalResults = externalRouters.map((routerName) => {
    const decisions = testRows.map((row) => row.routerChoices?.[routerName]);
    if (decisions.some((decision) => decision === undefined)) {
      throw new Error(`External router ${routerName} is missing test decisions.`);
    }
    const choices = decisions.map((decision) => decision!.choice);
    const workflowRoutes = Object.fromEntries(workflows.map((workflow) => {
      const workflowChoices = [...new Set(testRows
        .filter((row) => workflowFor(row) === workflow)
        .map((row) => row.routerChoices?.[routerName]?.choice))];
      return [workflow, workflowChoices.length === 1 ? workflowChoices[0]! : "per_request_decision"];
    }));
    return summarize(
      `external_router:${routerName}`,
      testRows,
      choices,
      baselineScores,
      baselineCost,
      workflowRoutes,
      { imported_router_decision: testRows.length },
      resolved.bootstrapSamples,
      resolved.seed,
      decisions,
    );
  });
  const first = trainRows[0]!;
  const last = testRows[0]!;
  const reviewPolicies = policies.map((policy) => ({
    ...policy,
    candidates: policy.candidates.map((candidate) => ({ ...candidate, approved: false })),
  }));
  return {
    schemaVersion: 1,
    method: "offline_precomputed_outputs",
    dataset: first.dataset,
    trainSplit: first.split,
    testSplit: last.split,
    trainSamples: trainRows.length,
    testSamples: testRows.length,
    models,
    excludedModels,
    externalRouters,
    settings: resolved,
    learned: {
      bestSingleChoice,
      bestSingleModel,
      cheapestStaticChoice,
      cheapestStaticModel,
      fluxChoiceByWorkflow,
      fluxModelByWorkflow: Object.fromEntries(workflows.map((workflow) => [workflow, targetByChoice[fluxChoiceByWorkflow[workflow]!]!.model])),
      targetByChoice,
      trainingQualityDeltaLower95ByWorkflow,
      policies: reviewPolicies,
    },
    results: [bestSingle, cheapest, flux, ...externalResults],
    notice: "Offline comparison of already-computed model outputs. FLUX choices are learned on train records and measured only on test records. Imported external-router decisions are evaluated as provided; their training provenance is not verified by FLUX. Results are workload- and scorer-specific and do not establish production savings or future quality.",
  };
}

/** Deterministically split records by normalized prompt group to prevent duplicate-prompt leakage. */
export function partitionBenchmarkRows(
  rows: BenchmarkCase[],
  trainFraction = 0.7,
  seed = "flux-benchmark-v1",
): { train: BenchmarkCase[]; test: BenchmarkCase[] } {
  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    throw new Error("trainFraction must be between 0 and 1.");
  }
  const train: BenchmarkCase[] = [];
  const test: BenchmarkCase[] = [];
  for (const row of rows) {
    const groupId = row.groupId ?? row.id;
    const digest = createHash("sha256").update(`${seed}:${row.dataset}:${groupId}`).digest().readUInt32BE(0);
    const target = digest / 0x1_0000_0000 < trainFraction ? train : test;
    target.push({ ...row, split: `${row.split}:${target === train ? "train" : "test"}`, groupId });
  }
  if (train.length === 0 || test.length === 0) {
    throw new Error("Deterministic partition produced an empty side; add more records or change the seed/fraction.");
  }
  return { train, test };
}
