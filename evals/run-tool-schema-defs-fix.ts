import {
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { minifyToolSchemas } from "../packages/core/src/tool-schema.js";

/**
 * Night's new-lever research: multi-agent teams (founder mandate shape list,
 * item 1 — "sub-agent fan-out re-sending shared context... repeated tool
 * schemas"). Tool-schema compaction (`minifyToolSchemas`, wired into
 * `reduceRequest` as the `tool-schema-compaction` / `tool-schema-description-
 * trim` levers) is already shipped and was just promoted to top backlog
 * priority by last night's dataset run
 * (docs/rnd/lever-backlog.md, "Tool-schema compaction: PROMOTE — 67-80% of
 * cold first request off-SWE"). Studying that shape's real request
 * construction (CrewAI/AutoGen/LangChain tool definitions are commonly
 * generated from pydantic `BaseModel` args schemas — see
 * https://docs.pydantic.dev/latest/concepts/json_schema/) surfaced a
 * correctness bug in the existing lever rather than a new saving: nested
 * pydantic models compile to a `$defs` container addressed by `$ref`
 * elsewhere in the same schema, and the shipped minifier dropped the whole
 * `$defs` container unconditionally as "plumbing the model never reads" —
 * which leaves `$ref` pointers dangling. That is schema corruption wearing
 * a lossless label, not a lossless saving. Fixed in
 * packages/core/src/tool-schema.ts (see its module docstring) and covered by
 * new tests in tool-schema.test.ts.
 *
 *   node --import tsx evals/run-tool-schema-defs-fix.ts
 *
 * This is a HARDENING finding, not a new billable lever: it does not add
 * savings, it removes a hidden defect in an existing shipped lever. None of
 * the published eval fixtures (run-agent-ab.ts, run-cache-decomposition.ts,
 * run-workload-matrix.ts) use `$ref`/`$defs`-shaped tool schemas, so nothing
 * published moves — confirmed below by re-stating what the OLD (buggy)
 * behaviour would have silently done to a realistic multi-agent fan-out
 * catalogue, next to what the FIXED minifier actually does.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-28";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

/**
 * A realistic multi-agent tool catalogue: three specialist tools whose
 * parameters are nested pydantic `BaseModel`s, the way CrewAI/AutoGen/
 * LangChain tools built on pydantic actually serialise (`.model_json_schema()`
 * puts nested models in `$defs` and references them via `$ref`). `Window` is
 * referenced only transitively (through `ScheduleDeployArgs`'s own `$ref`),
 * and `DeprecatedTarget` is a realistic leftover: a definition pydantic still
 * emits for a type no longer referenced after a schema simplification,
 * included here to prove the fix still trims genuinely dead definitions.
 */
const PYDANTIC_TOOLS = [
  {
    name: "create_ticket",
    description: "File a ticket against the tracker with a structured assignee and labels.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        assignee: { $ref: "#/$defs/Assignee" },
        labels: { type: "array", items: { $ref: "#/$defs/Label" } },
      },
      required: ["title", "assignee"],
      $defs: {
        Assignee: {
          type: "object",
          properties: { username: { type: "string" }, team: { $ref: "#/$defs/Team" } },
          required: ["username"],
        },
        Team: { type: "object", properties: { name: { type: "string" }, oncall: { type: "boolean" } } },
        Label: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } },
        DeprecatedTarget: {
          type: "object",
          properties: { legacyId: { type: "string" }, migratedTo: { type: "string" } },
        },
      },
    },
  },
  {
    name: "schedule_deploy",
    description: "Schedule a deploy window for a service.",
    input_schema: {
      type: "object",
      properties: { service: { type: "string" }, window: { $ref: "#/$defs/ScheduleDeployArgs" } },
      required: ["service", "window"],
      $defs: {
        ScheduleDeployArgs: {
          type: "object",
          properties: { slot: { $ref: "#/$defs/Window" } },
        },
        Window: {
          type: "object",
          properties: { startUtc: { type: "string" }, endUtc: { type: "string" } },
          required: ["startUtc", "endUtc"],
        },
      },
    },
  },
  {
    name: "file_patch",
    description: "Apply a structured patch (a list of hunks) to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, hunks: { type: "array", items: { $ref: "#/$defs/Hunk" } } },
      required: ["path", "hunks"],
      $defs: {
        Hunk: {
          type: "object",
          properties: { startLine: { type: "integer" }, oldText: { type: "string" }, newText: { type: "string" } },
          required: ["startLine", "oldText", "newText"],
        },
      },
    },
  },
];

const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(14);

type Shaped = { atSeconds: number; request: AnyObject; outputTokens: number };

/** 1 orchestrator + 3 specialists share one system + pydantic-shaped tool catalogue, 6 rounds. */
function multiAgentTeamWithPydanticTools(): Shaped[] {
  const stream: Shaped[] = [];
  const agents = ["orchestrator", "ticketing", "deploy", "patcher"];
  const histories = new Map<string, AnyObject[]>(agents.map((name) => [name, []]));
  for (let round = 0; round < 6; round += 1) {
    for (const [slot, name] of agents.entries()) {
      const history = histories.get(name)!;
      history.push({ role: "user", content: `Round ${round} task for ${name}: advance ticket 7 (step ${round}).` });
      stream.push({
        atSeconds: round * 40 + slot * 4,
        request: {
          model: "claude-sonnet-5-5", max_tokens: 500,
          system: PREAMBLE, tools: PYDANTIC_TOOLS,
          messages: [...history],
        },
        outputTokens: 220,
      });
      history.push({ role: "assistant", content: `(${name}) round ${round} done.` });
    }
  }
  return stream;
}

/** Simulates the PRE-FIX behaviour exactly: `$defs` dropped unconditionally, `$ref` left dangling. */
function minifyWithOldBuggyBehavior(tools: unknown[]): unknown[] {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$defs") continue; // the bug: dropped unconditionally, $ref left dangling.
      out[key] = strip(value);
    }
    return out;
  };
  return tools.map(strip);
}

/** Every `$ref` target name in a tree, to check for dangling references. */
function refTargets(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) { for (const item of node) refTargets(item, into); return; }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const match = /\$defs\/([^/]+)/.exec(value);
      if (match?.[1] !== undefined) into.add(match[1]);
      continue;
    }
    refTargets(value, into);
  }
}
function defNames(node: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { for (const item of n) walk(item); return; }
    if (typeof n !== "object" || n === null) return;
    for (const [key, value] of Object.entries(n as Record<string, unknown>)) {
      if (key === "$defs" && typeof value === "object" && value !== null) {
        for (const name of Object.keys(value as Record<string, unknown>)) names.add(name);
      }
      walk(value);
    }
  };
  walk(node);
  return names;
}

function wire(request: AnyObject): string {
  const system = typeof request.system === "string" ? request.system : "";
  const tools = JSON.stringify(request.tools ?? []);
  const messages = (request.messages as unknown[]).map((m) => JSON.stringify(m)).join("\n");
  return `${system}\n${tools}\n${messages}`;
}

function priceStream(label: string, streamWithTools: (tools: unknown[]) => Shaped[], tools: unknown[]): number {
  const stream = streamWithTools(tools);
  const simRequests: SimulatedRequest[] = stream.map((entry) => ({
    atSeconds: entry.atSeconds,
    prompt: wire({ ...entry.request, tools }),
    outputTokens: entry.outputTokens,
  }));
  const priced = simulateCache(simRequests, ANTHROPIC_NO_CACHE, price.price, { countTokens: approximateTokenCount });
  const tokens = simRequests.reduce((sum, r) => sum + approximateTokenCount(r.prompt), 0);
  console.log(`${label.padEnd(34)} tokens ${tokens.toString().padStart(9)}  cost $${priced.totalCostUsd.toFixed(4)}`);
  return priced.totalCostUsd;
}

console.log("FLUX hardening finding: $defs/$ref dangling-reference bug in tool-schema minification");
console.log("multi-agent team, 4 agents x 6 rounds = 24 requests, shared pydantic-shaped tool catalogue\n");

const beforeNames = defNames(PYDANTIC_TOOLS);
const referenced = new Set<string>();
refTargets(PYDANTIC_TOOLS, referenced);
console.log(`$defs entries in the catalogue: ${[...beforeNames].join(", ")}`);
console.log(`$ref-referenced (directly or transitively): ${[...referenced].sort().join(", ")}`);
console.log(`genuinely unreferenced (should be the ONLY ones trimmed): ${[...beforeNames].filter((n) => !referenced.has(n)).join(", ") || "(none)"}\n`);

// --- A. raw catalogue, no minification at all --------------------------------
const rawCost = priceStream("A. raw catalogue (no minify)", multiAgentTeamWithPydanticTools, PYDANTIC_TOOLS);

// --- B. OLD buggy minifier: $defs dropped unconditionally --------------------
const buggyTools = minifyWithOldBuggyBehavior(PYDANTIC_TOOLS);
const buggyRemainingRefs = new Set<string>();
refTargets(buggyTools, buggyRemainingRefs);
const buggyRemainingDefs = defNames(buggyTools);
const dangling = [...buggyRemainingRefs].filter((name) => !buggyRemainingDefs.has(name));
const buggyCost = priceStream("B. OLD buggy minify ($defs gone)", multiAgentTeamWithPydanticTools, buggyTools);

// --- C. FIXED minifier: $defs kept where referenced, trimmed where dead ------
const fixed = minifyToolSchemas(PYDANTIC_TOOLS, { countTokens: approximateTokenCount });
const fixedRemainingRefs = new Set<string>();
refTargets(fixed.tools, fixedRemainingRefs);
const fixedRemainingDefs = defNames(fixed.tools);
const fixedDangling = [...fixedRemainingRefs].filter((name) => !fixedRemainingDefs.has(name));
const fixedCost = priceStream("C. FIXED minify (ref-aware)", multiAgentTeamWithPydanticTools, fixed.tools as unknown[]);

console.log("\n=== result ===");
console.log(
  `B (old, buggy) has ${dangling.length} dangling $ref target(s): ${dangling.join(", ") || "(none)"} — ` +
    `every sub-agent's "assignee"/"window"/"hunks" argument lost its nested-object definition entirely. This is ` +
    `schema corruption, not a saving; the ${(((rawCost - buggyCost) / rawCost) * 100).toFixed(1)}% it would have ` +
    `shown as "lossless savings" was never a truthful lossless claim.`,
);
console.log(
  `C (fixed) has ${fixedDangling.length} dangling $ref target(s): ${fixedDangling.join(", ") || "(none)"}. ` +
    `Trimmed only the genuinely dead definition(s): ${fixed.changes.filter((c) => c.at.includes("$defs")).map((c) => c.at.split(".").pop()).join(", ") || "(none)"}.`,
);
console.log(
  `C vs A, the fix's TRUE lossless saving on this shape: ${(((rawCost - fixedCost) / rawCost) * 100).toFixed(1)}% ` +
    `(small — a handful of dead-definition bytes trimmed per request, plus the usual plumbing/formatting wins ` +
    `already covered by existing tests). Nothing published moves: no current eval fixture's tools use $ref/$defs.`,
);

if (dangling.length === 0) {
  console.log("\nWARNING: the synthetic 'old buggy' arm did not reproduce a dangling reference - fixture needs a nested $ref.");
  process.exitCode = 1;
}
if (fixedDangling.length > 0) {
  console.log("\nFAIL: the FIXED minifier still produced a dangling $ref - regression.");
  process.exitCode = 1;
}
