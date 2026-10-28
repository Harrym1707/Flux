import { pathToFileURL } from "node:url";
import {
  lookupPrice,
  publishedModelPrices,
  resolveModelId,
} from "../packages/core/src/index.js";
import {
  reduceRequest,
  replayGate,
  responseText,
  type ReplayCandidate,
  type ReplayGateResult,
  type ReplayGrader,
} from "../packages/sdk-js/src/index.js";
import { AT } from "./agent-fixture.js";

/**
 * The replay gate run against the OUTPUT EFFORT lever (reduce-request.ts
 * `outputEffort` -> Anthropic `output_config.effort`), on the REAL Anthropic API.
 *
 * Why this one cannot use a simulated provider. Every other gate eval in this
 * repo drives a fixture's `answer()` so the run is deterministic. That is
 * exactly wrong here: the effort lever's entire value is a REAL model behaviour
 * — does a lower effort setting actually spend fewer OUTPUT tokens while still
 * completing the task? A stub that encodes "effort=low -> 40% fewer tokens,
 * same answer" would be asserting the conclusion, the fixture-juicing the
 * honesty rules forbid (flux-honesty-rules: simulated behaviour may not be made
 * forgiving to flatter a lever). So with no API key this script PROVES NOTHING
 * and says so; the number only exists against the live model.
 *
 * What it measures. A set of demonstration tasks that (a) produce real prose /
 * reasoning output — so effort has something to trim — and (b) carry a
 * programmatically checkable success condition, so the grader judges TASK
 * COMPLETION, not text identity (exactTextGrader is meaningless for a lever
 * whose whole job is to change the words). Baseline = the request untouched
 * (default effort "high"); candidates = effort "low" and "medium". The gate
 * reads OUTPUT tokens from provider-reported usage on both runs, bounds the
 * task-completion delta with a seeded grouped bootstrap, and approves a
 * candidate only if quality held within the default 2% budget AND cost fell.
 *
 * Honesty properties.
 *   - The task set is a labelled DEMONSTRATION set, not customer traffic. It
 *     proves the MECHANISM (effort cuts output tokens without regressing task
 *     success on real model behaviour). A billable % still only comes from a
 *     customer's own traffic through this same gate — the standing rule.
 *   - The grader scores only lever-CAUSED regressions: a task the baseline
 *     itself failed is not charged against the candidate.
 *   - Quality budget is the production default (2%). Raising it to force a pass
 *     would be gate-softening; a rejection here is the gate having teeth.
 */

const AT_DATE = AT;

function cleanCredential(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new Error(
      `${name} contains characters that cannot be part of a real key (masked • bullets or similar). ` +
      "Copy the actual key from the provider console, not from a terminal or chat that masks it.",
    );
  }
  return trimmed;
}

const ANTHROPIC_KEY = cleanCredential("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
const ANTHROPIC_WORKSPACE_ID = cleanCredential("ANTHROPIC_WORKSPACE_ID", process.env.ANTHROPIC_WORKSPACE_ID);
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");

function anthropicHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": ANTHROPIC_KEY!,
    "anthropic-version": "2023-06-01",
    ...(ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : {}),
  };
}

/** Effort levels a model id is known to accept — mirrors the reducer's own
 *  conservative allow-list so this eval never picks a model the lever would
 *  then silently suppress on (which would read as "no saving"). */
function supportsLowAndMedium(model: string): boolean {
  const m = model.toLowerCase();
  if (!m.includes("claude")) return false;
  return m.includes("opus-5") || m.includes("opus-4-8") || m.includes("opus-4-7") ||
    m.includes("opus-4-6") || m.includes("opus-4-5") ||
    m.includes("sonnet-5") || m.includes("sonnet-4-6") ||
    m.includes("fable-5") || m.includes("mythos-5");
}

/** Pick a served, effort-capable, catalogued model. Guessing an id costs a
 *  whole failed run, so list what the workspace actually serves. */
async function pickModel(): Promise<string> {
  const explicit = process.env.FLUX_LIVE_MODEL;
  if (explicit !== undefined) return explicit;
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/models?limit=100`, {
      headers: anthropicHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      const usable = ids.filter((id) =>
        supportsLowAndMedium(id) &&
        resolveModelId(publishedModelPrices, "anthropic", id).status === "resolved");
      const newest = (family: string) => usable.filter((id) => id.includes(family)).sort().reverse()[0];
      // Cheapest effort-capable tier first (Sonnet), so the demo run is cheap.
      const chosen = newest("sonnet") ?? newest("opus") ?? usable.sort().reverse()[0];
      if (chosen !== undefined) {
        console.log(`Workspace models: ${ids.join(", ")}`);
        console.log(`Selected ${chosen} — newest effort-capable id with a catalogued rate.\n`);
        return chosen;
      }
    }
  } catch {
    // best-effort; fall through
  }
  return "claude-sonnet-5";
}

// ---- demonstration task set: real output, checkable success ----

type Task = { id: string; prompt: string; expected: string };

/** Tasks that elicit reasoning/prose (so effort has fat to trim) and whose
 *  answer is checkable without an LLM judge. Distinctive answers to keep the
 *  substring check honest. */
const TASKS: Task[] = [
  { id: "t01", prompt: "A train leaves at 09:15 and arrives at 13:45. How many minutes was the journey? Explain.", expected: "270" },
  { id: "t02", prompt: "A shop sells pens at £1.20 each. A customer buys 15 and pays with a £20 note. How much change, in pounds? Explain.", expected: "2" },
  { id: "t03", prompt: "If 3 machines make 3 widgets in 3 minutes, how many minutes for 100 machines to make 100 widgets? Explain.", expected: "3" },
  { id: "t04", prompt: "What is the capital city of Australia? Explain why it is not the largest city.", expected: "Canberra" },
  { id: "t05", prompt: "A rectangle is 7 by 4. What is its perimeter? Show the calculation.", expected: "22" },
  { id: "t06", prompt: "Sort these into the odd one out and name it: salmon, trout, dolphin, cod. Explain.", expected: "dolphin" },
  { id: "t07", prompt: "What is 15% of 240? Show your working.", expected: "36" },
  { id: "t08", prompt: "A book has 350 pages. You read 25 pages a day. On which day number do you finish? Explain (round up).", expected: "14" },
  { id: "t09", prompt: "Which planet is known as the Red Planet, and why does it look red? Explain.", expected: "Mars" },
  { id: "t10", prompt: "If today is Wednesday, what day is it in 10 days? Explain the counting.", expected: "Saturday" },
  { id: "t11", prompt: "A recipe for 4 people needs 600g flour. How many grams for 6 people? Show the scaling.", expected: "900" },
  { id: "t12", prompt: "What gas do plants primarily absorb for photosynthesis? Explain the process briefly.", expected: "carbon dioxide" },
  { id: "t13", prompt: "You have a 3L jug and a 5L jug. What is the largest exact volume you can measure that is under 5L using both once filled? Explain. Answer in litres.", expected: "4" },
  { id: "t14", prompt: "Convert 2.5 kilometres to metres. Explain.", expected: "2500" },
  { id: "t15", prompt: "In the word 'MISSISSIPPI', how many times does the letter S appear? Explain.", expected: "4" },
  { id: "t16", prompt: "A car travels 180 miles in 3 hours. What is its average speed in mph? Show the calculation.", expected: "60" },
];

const SYSTEM = "Solve the problem. Show your reasoning, then end your reply with a line in the exact form " +
  "'FINAL: <answer>'. Keep the FINAL line to just the answer.";

/** Build the baseline Anthropic Messages request for a task (default effort). */
function buildRequest(model: string, task: Task): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: task.prompt }],
  };
}

function userPromptOf(request: unknown): string {
  const row = request as Record<string, unknown>;
  const messages = row.messages as Array<Record<string, unknown>> | undefined;
  const first = messages?.find((m) => m.role === "user");
  return typeof first?.content === "string" ? first.content : "";
}

const norm = (text: string): string => text.toLowerCase().replace(/[\s,£$]/g, "");

/** Did the response complete the task? Read the FINAL: line if present (the
 *  system asks for one), else fall back to the whole reply. */
function taskSucceeded(task: Task, text: string): boolean {
  const finalLine = [...text.matchAll(/final:\s*(.+)/gi)].at(-1)?.[1] ?? text;
  return norm(finalLine).includes(norm(task.expected));
}

/** Task-completion grader scoring only lever-CAUSED regressions. */
export function effortTaskGrader(tasksByPrompt: Map<string, Task>): ReplayGrader {
  return ({ request, baselineResponse, candidateResponse }) => {
    const task = tasksByPrompt.get(userPromptOf(request));
    if (task === undefined) return 1;
    const baselineOk = taskSucceeded(task, responseText(baselineResponse));
    const candidateOk = taskSucceeded(task, responseText(candidateResponse));
    // A task the baseline already failed is not the lever's fault.
    return candidateOk || !baselineOk ? 1 : 0;
  };
}

export const EFFORT_LOW: ReplayCandidate = { label: "effort=low", config: { outputEffort: "low" } };
export const EFFORT_MEDIUM: ReplayCandidate = { label: "effort=medium", config: { outputEffort: "medium" } };

/** The real Anthropic caller the gate drives. */
function anthropicCall(): (request: unknown) => Promise<unknown> {
  return async (request: unknown): Promise<unknown> => {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  };
}

export async function runEffortGate(model: string): Promise<ReplayGateResult> {
  const requests = TASKS.map((task) => buildRequest(model, task));
  const tasksByPrompt = new Map(TASKS.map((task) => [task.prompt, task]));
  const priced = lookupPrice(publishedModelPrices, { provider: "anthropic", model, at: AT_DATE });
  return replayGate({
    requests,
    call: anthropicCall(),
    candidates: [EFFORT_LOW, EFFORT_MEDIUM],
    grade: effortTaskGrader(tasksByPrompt),
    groupOf: (request) => userPromptOf(request),
    seed: "flux-effort-gate-v1",
    ...(priced.status === "priced" ? { price: priced.price } : {}),
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)} pp`;
}

async function main(): Promise<void> {
  if (!ANTHROPIC_KEY) {
    console.log("=== output-effort gate: NO API KEY — nothing proven ===");
    console.log(
      "This lever's value is a REAL model behaviour (does lower effort spend fewer output tokens while\n" +
      "still completing the task?). A simulated provider cannot answer that without assuming the answer,\n" +
      "which the honesty rules forbid. Run it for real:\n\n" +
      "  set -a && source ~/.config/flux/anthropic.env && set +a\n" +
      "  node --import tsx evals/run-effort-gate.ts\n",
    );
    return;
  }

  const model = await pickModel();
  if (!supportsLowAndMedium(model)) {
    console.log(`Model ${model} is not in the effort-capable allow-list; the lever would suppress and prove nothing.`);
    console.log("Set FLUX_LIVE_MODEL to an effort-capable Claude id (e.g. claude-sonnet-5).");
    return;
  }

  // Trace the lever name to the code that ran, from the reducer itself.
  const sample = reduceRequest(buildRequest(model, TASKS[0]!), EFFORT_LOW.config);
  const change = sample.summary.changes.find((c) => c.lever === "output-effort-low");
  if (!change) {
    throw new Error(`outputEffort produced no 'output-effort-low' change on ${model}; the lever did not engage.`);
  }
  console.log(`change record under gate: lever '${change.lever}' (lossless: ${change.lossless})`);
  console.log(`  ${change.detail}\n`);

  console.log(
    `replay gate over ${TASKS.length} demonstration tasks on ${model}, LIVE Anthropic API, ` +
    "default 2% quality budget, candidates effort=low and effort=medium.\n",
  );

  const result = await runEffortGate(model);
  console.log(`provider calls paid for: ${result.calls} (baseline + one run per candidate)\n`);

  for (const candidate of result.candidates) {
    console.log(`--- ${candidate.label} ---`);
    console.log(`  graded ${candidate.graded}, failed ${candidate.failed}`);
    console.log(`  task-completion delta: mean ${pct(candidate.meanQualityDelta)}, lower95 ${pct(candidate.lower95QualityDelta)}`);
    console.log(
      `  output tokens: baseline ${candidate.baselineUsage.outputTokens.toLocaleString("en-US")} -> candidate ` +
      `${candidate.candidateUsage.outputTokens.toLocaleString("en-US")}; saved ` +
      `${candidate.outputTokensSaved.toLocaleString("en-US")} output ` +
      `(${candidate.baselineUsage.outputTokens === 0 ? "n/a" : ((candidate.outputTokensSaved / candidate.baselineUsage.outputTokens) * 100).toFixed(1) + "% of output"})`,
    );
    if (candidate.costSavedUsd !== undefined) {
      console.log(`  cost: saved $${candidate.costSavedUsd.toFixed(4)} (${(candidate.costSavingPercent ?? 0).toFixed(1)}% of this run's spend)`);
    }
    console.log(`  verdict: ${candidate.approved ? "APPROVED" : "REJECTED"}${candidate.rejectionReason ? ` - ${candidate.rejectionReason}` : ""}\n`);
  }

  for (const note of result.notes) console.log(`note: ${note}`);
  console.log(
    `\ngate verdict: ${result.approved ? `approved '${result.approved.label}'` : "nothing approved"} ` +
    `at the default ${(result.maximumQualityDrop * 100).toFixed(0)}% budget.`,
  );
  console.log(
    "\nReading this: an APPROVED candidate means the effort downshift held task completion within 2% AND\n" +
    "cut measured output tokens — the lever is real on this model/workload. A REJECTION means the\n" +
    "downshift regressed task success past the budget, which is the gate doing its job, not a failure of\n" +
    "the eval. Either way this is a DEMONSTRATION set: the billable % for a customer still comes only\n" +
    "from their own traffic through this same gate.",
  );
}

const isDirectRun = typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
