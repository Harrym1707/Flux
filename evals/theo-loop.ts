import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import {
  projectSavings,
  PUBLISHED_LEVERS,
  type WorkloadProfile,
  type WorkloadSegment,
  type Lever,
  type TokenPrice,
} from "../packages/core/src/index.js";
import { extractBlindFeatures, reduceRequest, type BlindFeatures } from "../packages/sdk-js/src/index.js";

// Catalogued Claude Sonnet 5.5 rate (USD per million tokens): $2 in / $10 out,
// cache reads 0.1x, cache writes 1.25x — the published first-party rate.
const SONNET_55_PRICE: TokenPrice = {
  inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 2.5,
};

/**
 * Theo — the per-user token-engineer loop, as a runnable prototype.
 *
 * This wires tonight's design (docs/rnd/theo-token-engineer-agent.md) end to end
 * on a sample coding-agent workload, using only pieces that already exist:
 *
 *   OBSERVE     extractBlindFeatures over the user's traffic  -> a workload profile,
 *               learned from IRREVERSIBLE features only (never the user's code).
 *   HYPOTHESISE projectSavings(profile)                        -> ranked candidate levers,
 *               split into deterministic (lossless, auto) and needs-verification (lossy).
 *   PROVE       lossless levers are provably equivalent -> proven now; lossy levers
 *               become a GATE REQUEST to be run LIVE on the user's own traffic (as the
 *               A5 live gate already does). No simulated quality numbers are invented here.
 *   POLICY      assemble the per-user lever policy the proxy would enforce.
 *   REPORT      a Theo-style summary + the monthly-ROI framing.
 *
 * No real API spend: OBSERVE + HYPOTHESISE are free (offline on features); PROVE for
 * lossy levers is deferred to the live gate, not faked.
 *
 *   node --import tsx evals/theo-loop.ts [--out policy.json]
 */

const HMAC_KEY = "theo-demo-enclave-key"; // in production: sealed inside the gateway/enclave.

type Sample = { request: Record<string, unknown>; outputTokens: number };

/** A representative per-user coding-agent session: stable system+tools, growing
 *  history that re-sends the same file contents (a reuse/caching signal), code output. */
function sampleCodingWorkload(turns = 8): Sample[] {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the repository and return its full contents for inspection.",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "urn:read_file",
          type: "object",
          properties: { path: { type: "string", title: "path", description: "Repo-relative file path." } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Apply an edit to a file: replace a span of text with new text, preserving the rest.",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "urn:edit_file",
          type: "object",
          properties: {
            path: { type: "string", title: "path", description: "Repo-relative file path." },
            find: { type: "string", title: "find", description: "Exact text to replace." },
            replace: { type: "string", title: "replace", description: "Replacement text." },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_bash",
        description: "Run a shell command in the repository root and return stdout and stderr.",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { cmd: { type: "string", title: "cmd", description: "The command to run." } },
          required: ["cmd"],
        },
      },
    },
  ];
  const system =
    "You are a precise senior engineer working in this repository. Read before you edit, keep diffs minimal, " +
    "run the tests after every change, and never invent files or APIs that do not exist.";
  // A file the agent reads early and whose contents it keeps re-sending every turn.
  const fileBlob = "export function priceOf(model){\n" +
    Array.from({ length: 40 }, (_, i) => `  // rate table row ${i}: ${i * 7 % 13}`).join("\n") +
    "\n  return TABLE[model];\n}";

  const samples: Sample[] = [];
  const history: Array<Record<string, unknown>> = [];
  for (let turn = 0; turn < turns; turn += 1) {
    history.push({ role: "user", content: `Step ${turn + 1}: continue the refactor of priceOf().` });
    if (turn > 0) {
      // The agent re-sends the file it read on turn 0 (verbatim) — a reuse signal.
      history.push({ role: "assistant", content: `I read the file:\n${fileBlob}` });
      history.push({ role: "tool", content: `tests: 12 passed (turn ${turn})` });
    }
    samples.push({
      request: { model: "claude-sonnet-5-5", max_tokens: 1024, system, tools, messages: [...history] },
      outputTokens: 420, // modeled code+explanation output per turn
    });
  }
  return samples;
}

/** OBSERVE: aggregate blind features over the session into a WorkloadProfile. */
function observe(samples: Sample[]): { profile: WorkloadProfile; learned: string[] } {
  const feats: BlindFeatures[] = samples.map((s) => extractBlindFeatures(s.request, { hmacKey: HMAC_KEY }));
  const n = feats.length;
  const mean = (nums: number[]) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

  const system = mean(feats.map((f) => f.roleTokensApprox.system ?? 0));
  const toolSchemas = mean(feats.map((f) => f.toolSchemaTokensApprox));
  const userTurn = mean(feats.map((f) => f.roleTokensApprox.user ?? 0));
  const history = mean(feats.map((f) => (f.roleTokensApprox.assistant ?? 0) + (f.roleTokensApprox.tool ?? 0)));
  const output = mean(samples.map((s) => s.outputTokens));

  const segments: Record<WorkloadSegment, number> = {
    toolSchemas, systemPrompt: system, retrievedContext: 0, history, userTurn, output,
  };

  // Stability: does the same tools+system prefix recur across turns? (cacheable prefix)
  const prefixReuse = new Set(feats.map((f) => f.stablePrefixHash)).size === 1 && n > 1;
  // Reuse: fraction of blocks that repeat verbatim across the session (dedup/cache signal).
  const allBlocks = feats.flatMap((f) => f.blockHashes);
  const reuseFraction = allBlocks.length ? (allBlocks.length - new Set(allBlocks).size) / allBlocks.length : 0;
  const stableSegments: WorkloadSegment[] = prefixReuse ? ["toolSchemas", "systemPrompt"] : [];

  const learned = [
    `workload looks like a CODING AGENT: ${n} turns, ${Math.round(toolSchemas)} tool-schema tok/turn, ` +
      `${Math.round(history)} history tok/turn, output ${Math.round(output)} tok/turn`,
    prefixReuse ? "the tools+system prefix is STABLE across turns -> cacheable" : "no stable prefix found",
    `${Math.round(reuseFraction * 100)}% of content blocks repeat verbatim across turns -> reuse/cache signal`,
    "all of the above was learned from IRREVERSIBLE features — no prompt or code was read",
  ];
  return { profile: { name: "coding-agent (observed)", requests: n, segments, stableSegments }, learned };
}

function main(): void {
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg !== -1 ? process.argv[outArg + 1] : undefined;

  const samples = sampleCodingWorkload();
  const { profile, learned } = observe(samples);

  console.log("=== THEO — per-user token-engineer loop (prototype) ===\n");
  console.log("OBSERVE (from blind features only):");
  for (const line of learned) console.log(`  - ${line}`);

  // MEASURE the real LOSSLESS lever on the user's own sample. This is the honest
  // "active now" number — the actual reducer (post the A2 whitespace de-claim), not a
  // projection factor. Labelled an estimate: FLUX's own counter is ~15%, so provider
  // count_tokens confirms it before a penny is billed.
  const losslessConfig = { toolSchemas: true as const, duplicateContext: true as const, repairCachePrefix: true as const };
  let tokensBefore = 0;
  let losslessSaved = 0;
  const activeLevers = new Set<string>();
  for (const s of samples) {
    const r = reduceRequest(s.request, losslessConfig);
    tokensBefore += r.summary.estimatedTokensBefore;
    losslessSaved += r.summary.estimatedLosslessTokensSaved;
    for (const ch of r.summary.changes) if (ch.lossless && ch.estimatedTokensSaved > 0) activeLevers.add(ch.lever);
  }
  const losslessPct = tokensBefore > 0 ? (losslessSaved / tokensBefore) * 100 : 0;

  // HYPOTHESISE — rank the LOSSY candidates to test. These are PRIORS for ordering what
  // to prove next; they are NOT savings claims and are never shown to the user as a number.
  const projection = projectSavings(profile, Object.values(PUBLISHED_LEVERS) as Lever[], SONNET_55_PRICE);
  const candidates = projection.contributions
    .filter((c) => c.risk === "needs-verification" && c.tokensRemoved > 0)
    .sort((a, b) => b.sharePercent - a.sharePercent);

  console.log(`\nMEASURE (real lossless lever on your own sample):`);
  console.log(`  ~${losslessPct.toFixed(1)}% tokens removed, lossless — ACTIVE NOW (FLUX estimate; provider ` +
    `count_tokens confirms before billing). Levers: ${[...activeLevers].join(", ") || "(none applied)"}`);

  console.log(`\nHYPOTHESISE (free, offline) — lossy CANDIDATES ranked to decide TEST ORDER.`);
  console.log(`  These are unproven priors, NOT claims, and are never quoted to the user as a %:`);
  for (const c of candidates) console.log(`  - ${c.lever}  (test priority; model prior only)`);

  console.log(`\nPROVE:`);
  console.log(`  - lossless: measured on your traffic, active now. No quality risk.`);
  console.log(`  - ${candidates.length} lossy candidates: each goes to the LIVE replay gate on your OWN traffic`);
  console.log(`    (the gate that approved A5 at 0.00pp). Theo quotes a saving ONLY after it passes — never before.`);

  const policy = {
    schemaVersion: 1 as const,
    user: "sample-coding-user",
    observedProfile: profile,
    active: [...activeLevers].map((lever) => ({ lever, basis: "lossless-measured-estimate" })),
    activeLosslessPercentEstimate: Number(losslessPct.toFixed(1)),
    candidates: candidates.map((c) => ({ lever: c.lever, status: "await-live-gate",
      note: "a model PRIOR for test ordering only — not a saving; Theo proves it on the user's traffic before quoting anything." })),
  };

  console.log(`\nPOLICY (what the proxy enforces for this user now):`);
  console.log(`  active (lossless, auto): ${policy.active.map((a) => a.lever).join(", ") || "(none)"}`);
  console.log(`  candidates (await gate): ${policy.candidates.map((p) => p.lever).join(", ") || "(none)"}`);

  console.log(`\nREPORT (what Theo tells the user — honest, no unproven number):`);
  console.log(`  "I watched your coding traffic, never your code. I turned on lossless savings worth about`);
  console.log(`   ${losslessPct.toFixed(1)}% right now — zero quality risk. I have ${candidates.length} more ideas I think could help,`);
  console.log(`   but I won't quote you a number on any of them until I've proven it on your own traffic and`);
  console.log(`   shown you the quality cost. Monthly: 'Flux saved you £X, Theo found £Y for £Z.'"`);

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    console.log(`\npolicy written to ${outPath}`);
  }
}

const isDirectRun = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();

export { observe, sampleCodingWorkload };
