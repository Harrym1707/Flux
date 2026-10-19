import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFlux, type FluxTokenReductionConfig } from "../packages/sdk-js/src/index.js";
import {
  publishedModelPrices,
  recomputeInvoice,
  resolveModelId,
  verifyLedgerChain,
  type LedgerRecord,
} from "../packages/core/src/index.js";

/**
 * Five simple agents, each wrapped in FLUX with the savings ledger on, run to
 * produce a REAL export: a hash-chained ledger spool and the invoice FLUX would
 * bill for each one.
 *
 * FLUX is provider-agnostic and so is this harness. The agents are written
 * once, provider-neutrally, and shaped per provider at send time:
 *
 *   ANTHROPIC_API_KEY set  -> LIVE against the Anthropic Messages API (the
 *                             default when both keys are present).
 *   OPENAI_API_KEY set     -> LIVE against the OpenAI Responses API, or any
 *                             OpenAI-compatible endpoint via OPENAI_BASE_URL
 *                             (Groq, Together, Mistral, a local Ollama, ...).
 *   neither                -> deterministic LOCAL-STUB run of BOTH provider
 *                             shapes: a pipeline check, never a savings claim.
 *
 * FLUX_LIVE_PROVIDER=anthropic|openai forces the choice; FLUX_LIVE_MODEL
 * overrides the model for the selected live provider.
 *
 * The honesty line this harness holds: real savings need real API calls. With
 * no key the numbers are labelled LOCAL-STUB and are a pipeline check, not a
 * savings claim.
 */

type Provider = "anthropic" | "openai";

/**
 * Credentials arrive by copy-paste, so catch the two classic paste failures
 * up front with a plain message instead of 30 cryptic request errors:
 * masked characters (a terminal or chat shows secrets as •••; copying that
 * copies literal bullets) and stray whitespace/newlines.
 */
function cleanCredential(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new Error(
      `${name} contains characters that cannot be part of a real key (masked • bullets or similar). ` +
      "You most likely copied a HIDDEN rendering of the secret. Copy the actual key from the provider " +
      "console (e.g. console.anthropic.com -> API keys), not from a terminal or chat that masks it.",
    );
  }
  return trimmed;
}

const ANTHROPIC_KEY = cleanCredential("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
const OPENAI_KEY = cleanCredential("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
const ANTHROPIC_WORKSPACE_ID = cleanCredential("ANTHROPIC_WORKSPACE_ID", process.env.ANTHROPIC_WORKSPACE_ID);
const FORCED = process.env.FLUX_LIVE_PROVIDER as Provider | undefined;
if (FORCED !== undefined && FORCED !== "anthropic" && FORCED !== "openai") {
  throw new Error(`FLUX_LIVE_PROVIDER must be "anthropic" or "openai", got ${JSON.stringify(FORCED)}.`);
}

const liveProvider: Provider | undefined = FORCED !== undefined
  ? FORCED
  : ANTHROPIC_KEY ? "anthropic" : OPENAI_KEY ? "openai" : undefined;
const LIVE = liveProvider !== undefined &&
  (liveProvider === "anthropic" ? !!ANTHROPIC_KEY : !!OPENAI_KEY);
if (FORCED !== undefined && !LIVE) {
  throw new Error(`FLUX_LIVE_PROVIDER=${FORCED} but the matching API key is not set.`);
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-5-5-20260514",
  openai: "gpt-5",
};
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

/** A LOCAL-STUB run exercises both provider shapes; a LIVE run uses the keyed one. */
const providers: Provider[] = LIVE ? [liveProvider!] : ["anthropic", "openai"];

function modelFor(provider: Provider): string {
  if (LIVE && provider === liveProvider && process.env.FLUX_LIVE_MODEL) return process.env.FLUX_LIVE_MODEL;
  return DEFAULT_MODEL[provider];
}

function anthropicHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": ANTHROPIC_KEY!,
    "anthropic-version": "2023-06-01",
    // A user-scoped key (sk-ant-usr-...) must name the workspace to bill;
    // a workspace-scoped key needs no header and ignores this.
    ...(ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : {}),
  };
}

/**
 * LIVE Anthropic preflight: ask the API which models this workspace actually
 * serves, and pick one the catalogue can price — guessing an id costs a whole
 * failed run, and running an uncatalogued model could only produce unpriced
 * events, which would be a pipeline demo dressed up as a measurement.
 */
async function pickAnthropicModel(): Promise<string> {
  const explicit = process.env.FLUX_LIVE_MODEL;
  let ids: string[] = [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: anthropicHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      ids = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string");
    }
  } catch {
    // Listing is best-effort; fall through to the explicit/default id.
  }
  if (explicit !== undefined) {
    if (ids.length > 0 && !ids.includes(explicit)) {
      console.log(`warning: FLUX_LIVE_MODEL=${explicit} is not in this workspace's model list; trying it anyway.`);
    }
    return explicit;
  }
  if (ids.length === 0) return DEFAULT_MODEL.anthropic;
  const priced = ids.filter((id) =>
    resolveModelId(publishedModelPrices, "anthropic", id).status === "resolved");
  const newestOf = (family: string) => priced.filter((id) => id.includes(family)).sort().reverse()[0];
  const chosen = newestOf("sonnet") ?? newestOf("haiku") ?? newestOf("opus") ?? priced.sort().reverse()[0];
  if (chosen !== undefined) {
    console.log(`Workspace models: ${ids.join(", ")}`);
    console.log(`Selected ${chosen} — newest id with a catalogued rate.\n`);
    return chosen;
  }
  throw new Error(
    "None of this workspace's models has a catalogued rate, so every event would be unpriced. " +
    `Available ids: ${ids.join(", ")}. Catalogue a dated, sourced rate for one of them ` +
    "(packages/core/src/model-prices.ts), or pass FLUX_LIVE_MODEL=<id> to force one.",
  );
}

type AnyObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Provider-neutral agent definitions
// ---------------------------------------------------------------------------

type NeutralTool = { name: string; description: string; parameters: AnyObject };
type NeutralRequest = {
  system?: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: NeutralTool[];
  maxOutput?: number;
};

const PREAMBLE = [
  "You are a careful assistant. Follow instructions precisely and never invent facts.",
  ...Array.from({ length: 30 }, (_, i) => `Operating rule ${i}: cite sources, escalate anything risky, keep answers tight.`),
].join("\n\n");

const TOOLS: NeutralTool[] = Array.from({ length: 12 }, (_, i) => ({
  name: `lookup_${i}`,
  description: `Look up records in subsystem ${i}. Use this for questions about topic ${i}. Returns a paginated list.`,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
}));

const BIG_TOOL_RESULT = Array.from({ length: 20 }, (_, i) =>
  `Record ${i}: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.`).join(" ");

type Agent = {
  name: string;
  segment: string;
  reduction: FluxTokenReductionConfig;
  requests: () => NeutralRequest[];
};

const agents: Agent[] = [
  {
    name: "coding-agent",
    segment: "interactive (busy)",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, historyCompaction: true,
      freshToolResultCap: { maximumTokens: 600 } } as FluxTokenReductionConfig,
    requests: () => Array.from({ length: 5 }, (_, turn) => ({
      system: `Current time: 2026-10-13T09:0${turn}:00Z\n${PREAMBLE}`,
      tools: TOOLS,
      turns: [
        ...Array.from({ length: turn }, (_, p) => ([
          { role: "user" as const, content: `Step ${p}: inspect account 100${p}.` },
          { role: "assistant" as const, content: BIG_TOOL_RESULT },
        ])).flat(),
        { role: "user" as const, content: "Investigate account 1009 and summarise." },
      ],
      maxOutput: 2000,
    })),
  },
  {
    name: "rag-docqa",
    segment: "one-shot templated",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true },
    // The retriever pastes the same top excerpt under two headings — the
    // classic RAG duplication the duplicate-context lever exists to remove.
    requests: () => Array.from({ length: 6 }, (_, i) => ({
      system: `Request time: 2026-10-13T10:1${i}:00Z\n${PREAMBLE}`,
      turns: [{ role: "user" as const, content:
        `Excerpts for case ${i}.\n\n${BIG_TOOL_RESULT}\n\n${BIG_TOOL_RESULT}\n\n` +
        `Question: what does clause ${i} require?` }],
    })),
  },
  {
    name: "batch-classifier",
    segment: "async-eligible",
    // The discount lever is per-provider: OpenAI's flex tier, or the 1h cache
    // TTL on Anthropic (its Batch API rate is not catalogued yet, so FLUX
    // would leave real Anthropic batch events unpriced rather than guess).
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, executionTier: "flex" },
    requests: () => Array.from({ length: 8 }, (_, i) => ({
      system: PREAMBLE,
      turns: [{ role: "user" as const, content: `Classify ticket ${i}: "my payment failed and I was charged twice".` }],
    })),
  },
  {
    name: "support-chat",
    segment: "consumer",
    reduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, maxOutputTokens: 400 },
    // A consumer helpdesk ships its whole verbose tool belt on every turn.
    requests: () => Array.from({ length: 6 }, (_, i) => ({
      system: PREAMBLE,
      tools: TOOLS,
      turns: [{ role: "user" as const, content: `User ${i}: how do I reset my password?` }],
    })),
  },
  {
    name: "already-lean",
    segment: "already-optimised (expect ~0, do-not-pay-us)",
    // Minimal prompt, no tools, nothing to reduce: the honest zero case.
    reduction: { toolSchemas: true, duplicateContext: true },
    requests: () => Array.from({ length: 5 }, (_, i) => ({
      turns: [{ role: "user" as const, content: `Translate "hello ${i}" to French.` }],
    })),
  },
];

/** The same agent, with its discount lever swapped to the provider's own. */
function reductionFor(provider: Provider, base: FluxTokenReductionConfig): FluxTokenReductionConfig {
  if (provider === "anthropic") {
    const { executionTier: _tier, ...rest } = base as FluxTokenReductionConfig & { executionTier?: "flex" };
    return _tier === "flex" ? { ...rest, cacheTtl: "1h" } : rest;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Request shaping: one neutral definition, each provider's wire format
// ---------------------------------------------------------------------------

function shapeRequest(provider: Provider, model: string, req: NeutralRequest): AnyObject {
  if (provider === "anthropic") {
    return {
      model,
      ...(req.system === undefined ? {} : { system: req.system }),
      ...(req.tools === undefined ? {} : {
        tools: req.tools.map((tool) => ({
          name: tool.name, description: tool.description, input_schema: tool.parameters,
        })),
      }),
      messages: req.turns,
      max_tokens: req.maxOutput ?? 2000,
    };
  }
  return {
    model,
    ...(req.system === undefined ? {} : { instructions: req.system }),
    ...(req.tools === undefined ? {} : {
      tools: req.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    }),
    input: req.turns,
    ...(req.maxOutput === undefined ? {} : { max_output_tokens: req.maxOutput }),
  };
}

// ---------------------------------------------------------------------------
// Clients: real HTTP when keyed, deterministic local stub otherwise
// ---------------------------------------------------------------------------

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h;
}

/** Deterministic local model: usage proportional to the request actually sent. */
function stubbedCompletion(provider: Provider, req: AnyObject): AnyObject {
  const text = `${JSON.stringify(req.system ?? req.instructions ?? "")}` +
    `${JSON.stringify(req.messages ?? req.input ?? "")}${JSON.stringify(req.tools ?? "")}`;
  const inputTokens = Math.ceil(text.length / 4);
  const cap = typeof req.max_output_tokens === "number" ? req.max_output_tokens
    : typeof req.max_tokens === "number" ? req.max_tokens : 600;
  const outputTokens = Math.min(cap, 400);
  if (provider === "anthropic") {
    return {
      id: `local-${Math.abs(hash(text))}`,
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }
  return {
    id: `local-${Math.abs(hash(text))}`,
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      input_tokens_details: { cached_tokens: 0 },
    },
    ...(typeof req.service_tier === "string" ? { service_tier: req.service_tier } : {}),
  };
}

async function liveCompletion(provider: Provider, req: AnyObject): Promise<AnyObject> {
  const [url, headers]: [string, Record<string, string>] = provider === "anthropic"
    ? ["https://api.anthropic.com/v1/messages", anthropicHeaders()]
    : [`${OPENAI_BASE_URL}/responses`, {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_KEY}`,
      }];
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as AnyObject;
}

/**
 * A client in the shape withFlux wraps for this provider: messages.create for
 * Anthropic-SDK-shaped clients, responses.create for OpenAI-shaped ones.
 */
function makeClient(provider: Provider): AnyObject {
  const create = async (req: AnyObject) =>
    LIVE ? liveCompletion(provider, req) : stubbedCompletion(provider, req);
  return provider === "anthropic" ? { messages: { create } } : { responses: { create } };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), "flux-live-"));

function readLedger(path: string): LedgerRecord[] {
  try {
    return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerRecord);
  } catch {
    return [];
  }
}

console.log(`=== FLUX live-agent run — mode: ${LIVE
  ? liveProvider === "anthropic"
    ? `LIVE (anthropic, model ${process.env.FLUX_LIVE_MODEL ?? "picked at preflight from the workspace's own list"})`
    : `LIVE (openai ${modelFor("openai")}${OPENAI_BASE_URL !== "https://api.openai.com/v1" ? ` via ${OPENAI_BASE_URL}` : ""})`
  : "LOCAL-STUB (no API key; both provider shapes)"} ===`);
if (!LIVE) {
  console.log("No key set, so these numbers are a PIPELINE CHECK, not a savings claim.");
  console.log("Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY to turn this into a real-traffic export.\n");
}

const summary: Array<{ provider: Provider; agent: string; segment: string; requests: number; chainOk: boolean; billedUsd: number; verdict: string }> = [];

for (const provider of providers) {
  const model = LIVE && provider === "anthropic" ? await pickAnthropicModel() : modelFor(provider);
  for (const agent of agents) {
    const ledgerPath = join(ROOT, `${provider}-${agent.name}.jsonl`);
    const client = withFlux(makeClient(provider) as never, {
      applicationId: agent.name,
      tokenReduction: reductionFor(provider, agent.reduction),
      ledger: { path: ledgerPath, provider },
    }) as unknown as {
      responses?: { create: (r: unknown) => Promise<unknown> };
      messages?: { create: (r: unknown) => Promise<unknown> };
    };
    const send = provider === "anthropic" ? client.messages!.create : client.responses!.create;

    const planned = agent.requests();
    process.stdout.write(`${provider}/${agent.name} (${planned.length} requests): `);
    let ok = 0;
    let failed = 0;
    for (const req of planned) {
      try {
        await send(shapeRequest(provider, model, req));
        ok += 1;
        process.stdout.write(".");
      } catch (cause) {
        failed += 1;
        process.stdout.write("x");
        if (failed === 1) process.stdout.write(`\n  ${agent.name}: request error — ${(cause as Error).message}\n  `);
      }
    }
    process.stdout.write(" done\n");

    const records = readLedger(ledgerPath);
    const chain = verifyLedgerChain(records);
    const invoice = recomputeInvoice(records.map((r) => r.event), { feePercent: 15 });
    summary.push({
      provider,
      agent: agent.name,
      segment: agent.segment,
      requests: ok,
      chainOk: chain.ok,
      billedUsd: invoice.netVerifiedSavingsUsd,
      verdict: invoice.verdict,
    });
  }
}

console.log(`\n${"provider".padEnd(10)} ${"agent".padEnd(18)} ${"segment".padEnd(42)} ${"reqs".padStart(5)} ${"chain".padStart(6)} ${"net saved $".padStart(12)} verdict`);
console.log("-".repeat(110));
for (const row of summary) {
  console.log(
    `${row.provider.padEnd(10)} ${row.agent.padEnd(18)} ${row.segment.padEnd(42)} ${String(row.requests).padStart(5)} ` +
    `${(row.chainOk ? "ok" : "BAD").padStart(6)} ${row.billedUsd.toFixed(6).padStart(12)} ${row.verdict}`,
  );
}
console.log(`\nLedger spools written under ${ROOT} (one JSONL per provider+agent).`);
const anySucceeded = summary.some((row) => row.requests > 0);
console.log(!LIVE
  ? "LOCAL-STUB run: both provider request paths, ledger hash-chains and invoices are exercised; add a key for real numbers."
  : anySucceeded
    ? `LIVE run: the net-saved figures above are measured on real ${liveProvider} traffic — this is a real export.`
    : "LIVE run FAILED: no request succeeded, so nothing above is a measurement. Check the API key and retry.");

if (process.env.FLUX_LIVE_KEEP !== "1") rmSync(ROOT, { recursive: true, force: true });
