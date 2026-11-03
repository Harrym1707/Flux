import { readFileSync } from "node:fs";
import { approximateTokenCount, minifyToolSchemas } from "../../../packages/core/src/index.js";

/**
 * A2 honesty check (free): does the tool-schema minifier's claimed LOSSLESS
 * saving match what the provider actually bills — or is it inflated by phantom
 * whitespace the provider never tokenizes?
 *
 * Method: take a REAL tool catalogue, ask Anthropic's free count_tokens for the
 * provider's true token count of (a) the original tools and (b) the minified
 * tools. The real billable lossless saving is (a)-(b). Compare to FLUX's own
 * reported losslessTokensSaved. If FLUX's number is larger, the gap is the
 * formatting/whitespace component — which the provider re-serialises away and
 * never bills — and must not be claimed as a saving.
 *
 *   set -a && source ~/.config/flux/anthropic.env && set +a
 *   node --import tsx evals/fundamentals/value/a2-count-tokens-check.ts
 */

const KEY = process.env.ANTHROPIC_API_KEY?.trim();
const WORKSPACE = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
const MODEL = process.env.FLUX_LIVE_MODEL ?? "claude-sonnet-5-5";

function firstToolCatalogue(): unknown[] {
  const lines = readFileSync("evals/wire-captures/frameworks-2026-10-25.jsonl", "utf8")
    .split("\n").filter(Boolean);
  for (const line of lines) {
    const body = (JSON.parse(line) as { body?: { tools?: unknown } }).body;
    const tools = body?.tools;
    if (Array.isArray(tools) && tools.length > 0) return tools;
  }
  throw new Error("No request with a non-empty tools array in the capture.");
}

async function countTokens(tools: unknown[]): Promise<number> {
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY!,
      "anthropic-version": "2023-06-01",
      ...(WORKSPACE ? { "anthropic-workspace-id": WORKSPACE } : {}),
    },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "x" }], tools }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`count_tokens ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

async function main(): Promise<void> {
  const tools = firstToolCatalogue();
  const minified = minifyToolSchemas(tools, { descriptions: "keep" });
  const fluxClaimedLossless = minified.losslessTokensSaved;
  const fluxFormattingComponent = minified.changes
    .filter((c) => c.kind === "formatting")
    .reduce((s, c) => s + c.tokensSaved, 0);

  console.log(`real tool catalogue: ${tools.length} tool(s)`);
  console.log(`FLUX local (approx) counts: pretty→compact lossless saving = ${fluxClaimedLossless} tokens`);
  console.log(`  of which the FORMATTING/whitespace component = ${fluxFormattingComponent} tokens\n`);

  if (!KEY) {
    console.log("NO ANTHROPIC_API_KEY — cannot measure the provider's real billing. Source the key and re-run.");
    return;
  }

  const before = await countTokens(tools);
  const after = await countTokens(minified.tools);
  const realLosslessSaving = before - after;

  console.log(`provider count_tokens (REAL billed tokens):`);
  console.log(`  original tools : ${before}`);
  console.log(`  minified tools : ${after}`);
  console.log(`  REAL lossless saving = ${realLosslessSaving} tokens\n`);

  console.log(`VERDICT:`);
  console.log(`  FLUX claims  ${fluxClaimedLossless} lossless tokens saved`);
  console.log(`  Provider bills a real saving of ${realLosslessSaving} tokens`);
  const overclaim = fluxClaimedLossless - realLosslessSaving;
  if (overclaim > 1) {
    console.log(`  => FLUX OVER-CLAIMS by ~${overclaim} tokens. The formatting/whitespace component ` +
      `(${fluxFormattingComponent}) is not billed by the provider (it re-serialises the parsed structure). ` +
      `De-claim the formatting saving; keep only plumbing/title removal as billable lossless.`);
  } else {
    console.log(`  => FLUX's claim is within ~1 token of the real billed saving; no over-claim on this catalogue.`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
