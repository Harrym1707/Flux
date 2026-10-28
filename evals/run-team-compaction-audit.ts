import { approximateTokenCount, type SimulatedRequest } from "../packages/core/src/index.js";
import { auditCompactionSession, type CompactionAuditPair, type CompactionFindingKind } from "../packages/sdk-js/src/index.js";

/**
 * FIXTURE: Anthropic server-side compaction, used correctly and misused.
 *
 *   node --import tsx evals/run-team-compaction-audit.ts      (auditor precision)
 *   node --import tsx evals/run-team-compaction-hygiene-audit.ts (pricing)
 *
 * Shape grounding (fetched 2026-10-28, quoted in
 * docs/rnd/team-2026-10-28/compaction-hygiene-audit.md):
 *   - platform.claude.com/docs/en/build-with-claude/compaction-on-demand:
 *     the summarize request/response JSON, the "Compact in a loop" program
 *     (compare last input+output with a limit, swap history for the block),
 *     "Count compaction usage" (top-level zero, cost in usage.iterations),
 *     and the warning "Two mistakes in the swap raise no error. If summarized
 *     messages remain after the block, the API sends them to Claude again.
 *     If a later request leaves the block out, Claude gets no summary."
 *   - .../compaction-keep-recent-turns: "No parameter sets which turns are
 *     kept ... send only the older turns, then put the block in front of the
 *     turns you kept." Case B is the realistic merge of that program with the
 *     plain loop: the WHOLE history is summarized, then the tail is kept too.
 *   - .../compaction-threshold: `compact_20260112` edit, trigger minimum
 *     50,000 input tokens, response "begins with a compaction block", "The
 *     API automatically drops all content blocks prior to the compaction
 *     block", and "add a cache_control breakpoint at the end of your system
 *     prompt" so "the system prompt cache remains valid".
 *   - Anthropic TypeScript SDK (github anthropics/anthropic-sdk-typescript,
 *     main @ package version 1.3.0): BetaCompactionIterationUsage carries
 *     input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *     cache_creation, output_tokens; "A `compaction` entry's tokens are not
 *     included in the top-level `usage` fields."
 *
 * Workload numbers (system size, per-turn growth, output, summary length,
 * limit) are FIXTURE INVENTIONS for an always-on agent, not measured: no
 * FLUX capture uses the compaction beta, so prevalence and real sizes are
 * unmeasured. Token counts use approximateTokenCount (measured bias +28% on
 * prose, -13% on JSON; treat every token figure as +/-28%).
 */

type AnyObject = Record<string, any>;

export const MODEL = "claude-opus-5-5";
export const TURNS = 30;
export const SYSTEM_WORDS = 4_500; // ~6K approx tokens: tools + agent instructions
export const USER_WORDS = 1_800; // ~2.5K approx tokens: task message + tool results per turn
export const ASSISTANT_WORDS = 500; // ~700 approx tokens of output per turn
export const SUMMARY_WORDS = 2_200; // ~3K approx tokens per summary
export const LIMIT_TOKENS = 60_000; // compaction limit / threshold trigger (docs minimum is 50K)
export const TURN_GAP_SECONDS = 20;

// Deterministic word stream so every message is distinct and reproducible.
function words(seed: number, count: number): string {
  let state = seed * 2654435761 % 4294967296;
  const vocabulary = ["file", "test", "patch", "error", "build", "module", "trace", "value", "input", "result",
    "config", "branch", "commit", "output", "parser", "schema", "token", "cache", "router", "handler"];
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out.push(`${vocabulary[state % vocabulary.length]}${state % 97}`);
  }
  return out.join(" ");
}

export const SYSTEM = `You are an autonomous coding agent. ${words(1, SYSTEM_WORDS)}`;
const userMessage = (turn: number): AnyObject => ({ role: "user", content: `Turn ${turn}. ${words(1_000 + turn, USER_WORDS)}` });
const assistantMessage = (turn: number): AnyObject => ({ role: "assistant", content: `Done ${turn}. ${words(5_000 + turn, ASSISTANT_WORDS)}` });
const summaryText = (n: number): string => `Summary ${n} of the conversation: ${words(9_000 + n, SUMMARY_WORDS)}`;
const compactionBlock = (n: number): AnyObject => ({ type: "compaction", content: summaryText(n), signature: `EuYB-sig-${n}` });

export type CaseId = "A-correct-swap" | "B-leftover-summarized" | "C-block-dropped" | "D-compact-every-turn" |
  "E-threshold-no-system-breakpoint" | "E2-threshold-system-breakpoint";

/** Ground truth: which finding kinds a perfect auditor raises on each case. */
export const EXPECTED: Record<CaseId, CompactionFindingKind[]> = {
  "A-correct-swap": [],
  "B-leftover-summarized": ["rebilled-summarized-history"],
  "C-block-dropped": ["compaction-block-dropped"],
  "D-compact-every-turn": ["repeated-compaction"],
  "E-threshold-no-system-breakpoint": ["threshold-compaction-cache"],
  "E2-threshold-system-breakpoint": [],
};

/** One provider call as the cost model sees it. */
export type FixtureCall = {
  kind: "message" | "compaction";
  atSeconds: number;
  /** The model-visible prompt the provider processes on this call (after any drop/swap). */
  prompt: string;
  outputTokens: number;
  /** Cache epoch: a new epoch means no earlier cache entry is reachable (no surviving breakpoint). */
  epoch: number;
};

export type FixtureSession = {
  id: CaseId;
  pairs: CompactionAuditPair[];
  calls: FixtureCall[];
  compactions: number;
};

function render(message: AnyObject): string {
  if (typeof message.content === "string") return `\n[${message.role}] ${message.content}`;
  return message.content.map((block: AnyObject) =>
    block.type === "compaction" ? `\n[summary] ${block.content}` : `\n[${message.role}] ${block.text ?? ""}`).join("");
}

function promptOf(messages: AnyObject[], afterBlockOnly: boolean): string {
  let start = 0;
  if (afterBlockOnly) {
    // The API drops everything before the NEWEST compaction block.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (Array.isArray(message.content) && message.content.some((block: AnyObject) => block.type === "compaction")) {
        start = index;
        break;
      }
    }
  }
  return SYSTEM + messages.slice(start).map(render).join("");
}

const tokens = (text: string): number => approximateTokenCount(text);

function usage(input: number, output: number, compaction?: { input: number; output: number }): AnyObject {
  return {
    input_tokens: compaction && output === 0 ? 0 : input,
    output_tokens: output,
    iterations: [
      ...(compaction ? [{ type: "compaction", input_tokens: compaction.input, output_tokens: compaction.output }] : []),
      ...(output === 0 && compaction ? [] : [{ type: "message", input_tokens: input, output_tokens: output }]),
    ],
  };
}

/** On-demand compaction loop (docs "Compact in a loop") with one injected mistake. */
function onDemandSession(id: CaseId): FixtureSession {
  const pairs: CompactionAuditPair[] = [];
  const calls: FixtureCall[] = [];
  let history: AnyObject[] = [];
  let at = 0;
  let compactions = 0;
  let runningTotal = 0; // case D's bug: a session-wide running total that never resets
  for (let turn = 1; turn <= TURNS; turn += 1) {
    history.push(userMessage(turn));
    const prompt = promptOf(history, false);
    const reply = assistantMessage(turn);
    const outputTokens = tokens(reply.content);
    const request = { model: MODEL, max_tokens: 8_192, system: SYSTEM, messages: structuredClone(history) };
    const response = { content: [{ type: "text", text: reply.content }], stop_reason: "end_turn", usage: usage(tokens(prompt), outputTokens) };
    pairs.push({ request, response });
    calls.push({ kind: "message", atSeconds: at, prompt, outputTokens, epoch: 0 });
    history.push(reply);
    at += TURN_GAP_SECONDS;

    const conversationTokens = tokens(prompt) + outputTokens;
    runningTotal += tokens(reply.content) + tokens(userMessage(turn).content);
    const over = id === "D-compact-every-turn" ? runningTotal > LIMIT_TOKENS - tokens(SYSTEM) : conversationTokens > LIMIT_TOKENS;
    if (over && turn < TURNS) {
      compactions += 1;
      const compactPrompt = `${promptOf(history, false)}\n[compaction request]`;
      const block = compactionBlock(compactions);
      const summaryTokens = tokens(block.content);
      pairs.push({
        request: { model: MODEL, max_tokens: 4_096, system: SYSTEM, messages: structuredClone(history), compaction: { type: "summarize" } },
        response: { content: [block], stop_reason: "compaction", usage: usage(0, 0, { input: tokens(compactPrompt), output: summaryTokens }) },
      });
      calls.push({ kind: "compaction", atSeconds: at, prompt: compactPrompt, outputTokens: summaryTokens, epoch: 0 });
      at += 10;
      const blockMessage = { role: "assistant", content: [block] };
      if (id === "B-leftover-summarized") {
        // Keep-tail swap applied to a FULL-history compaction: the last two
        // turns were summarized AND are kept after the block.
        history = [blockMessage, ...history.slice(-4)];
      } else if (id === "C-block-dropped") {
        // Middleware strips the unknown `compaction` content block on the way
        // out: history is swapped, but no request ever carries the summary.
        history = [];
      } else {
        history = [blockMessage];
      }
    }
  }
  return { id, pairs, calls, compactions };
}

/** Threshold compaction (`compact_20260112`) inside ordinary requests. */
function thresholdSession(id: CaseId): FixtureSession {
  const systemBreakpoint = id === "E2-threshold-system-breakpoint";
  const pairs: CompactionAuditPair[] = [];
  const calls: FixtureCall[] = [];
  const history: AnyObject[] = [];
  let at = 0;
  let compactions = 0;
  let epoch = 0;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    history.push(userMessage(turn));
    const visible = promptOf(history, true);
    const reply = assistantMessage(turn);
    const outputTokens = tokens(reply.content);
    // The caller's own caching: a breakpoint on the newest message, plus (E2)
    // one at the end of the system prompt.
    const stampedMessages = structuredClone(history);
    const last = stampedMessages[stampedMessages.length - 1];
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    const request = {
      model: MODEL,
      max_tokens: 8_192,
      system: systemBreakpoint ? [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] : SYSTEM,
      context_management: { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: LIMIT_TOKENS } }] },
      messages: stampedMessages,
    };
    if (tokens(visible) > LIMIT_TOKENS) {
      compactions += 1;
      const block = compactionBlock(compactions);
      const summaryTokens = tokens(block.content);
      // Compaction iteration over everything visible, then the message
      // iteration over [system, summary] ("the effective context size after
      // compaction"). Without a breakpoint on system, no cache entry survives.
      calls.push({ kind: "compaction", atSeconds: at, prompt: visible, outputTokens: summaryTokens, epoch });
      if (!systemBreakpoint) epoch += 1;
      const after = SYSTEM + render({ role: "assistant", content: [block] });
      calls.push({ kind: "message", atSeconds: at + 5, prompt: after, outputTokens, epoch });
      pairs.push({
        request,
        response: {
          content: [block, { type: "text", text: reply.content }],
          stop_reason: "end_turn",
          usage: usage(tokens(after), outputTokens, { input: tokens(visible), output: summaryTokens }),
        },
      });
      history.push({ role: "assistant", content: [block, { type: "text", text: reply.content }] });
    } else {
      calls.push({ kind: "message", atSeconds: at, prompt: visible, outputTokens, epoch });
      pairs.push({
        request,
        response: { content: [{ type: "text", text: reply.content }], stop_reason: "end_turn", usage: usage(tokens(visible), outputTokens) },
      });
      history.push(reply);
    }
    at += TURN_GAP_SECONDS;
  }
  return { id, pairs, calls, compactions };
}

export function buildSessions(): FixtureSession[] {
  return [
    onDemandSession("A-correct-swap"),
    onDemandSession("B-leftover-summarized"),
    onDemandSession("C-block-dropped"),
    onDemandSession("D-compact-every-turn"),
    thresholdSession("E-threshold-no-system-breakpoint"),
    thresholdSession("E2-threshold-system-breakpoint"),
  ];
}

/** The 4 minimal hand-built pairs-per-case, in the docs' own JSON shapes. */
export function docPairs(): Array<{ id: CaseId; pairs: CompactionAuditPair[] }> {
  const u1 = { role: "user", content: "I am building a recipe app. Help me name the main entities in the data model." };
  const a1 = { role: "assistant", content: "Start with Recipe, Ingredient, and Step. Add a RecipeIngredient entry that holds the quantity and unit for each ingredient in a recipe." };
  const u2 = { role: "user", content: "Good. Now suggest field names for Recipe." };
  const block = { type: "compaction", content: "Summary of the conversation: the user is designing the data model for a recipe app.", signature: "EuYBCkQY..." };
  const summarize = (messages: AnyObject[]): CompactionAuditPair => ({
    request: { model: MODEL, max_tokens: 4_096, messages, compaction: { type: "summarize" } },
    response: { content: [block], stop_reason: "compaction", usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }] } },
  });
  const turn = (messages: AnyObject[]): CompactionAuditPair => ({
    request: { model: MODEL, max_tokens: 2_048, messages },
    response: { content: [{ type: "text", text: "For Recipe, use title, description, servings." }], usage: { input_tokens: 300, output_tokens: 40, iterations: [{ type: "message", input_tokens: 300, output_tokens: 40 }] } },
  });
  const blockMsg = { role: "assistant", content: [block] };
  const u3 = { role: "user", content: "Now do the same for Ingredient." };
  const a3 = { role: "assistant", content: "For Ingredient, use name, unit_default, and notes." };
  const u4 = { role: "user", content: "Now do Step." };
  const a4 = { role: "assistant", content: "For Step, use position and instruction." };
  const u5 = { role: "user", content: "Indexes?" };
  const next = (n: number): AnyObject => ({ role: "assistant", content: [{ ...block, content: `${block.content} (v${n})`, signature: `EuYB-v${n}` }] });
  const summarizeTo = (messages: AnyObject[], n: number): CompactionAuditPair => {
    const pair = summarize(messages);
    (pair.response as AnyObject).content = next(n).content;
    return pair;
  };
  return [
    { id: "A-correct-swap", pairs: [summarize([u1, a1, u2]), turn([blockMsg, u3])] },
    { id: "B-leftover-summarized", pairs: [summarize([u1, a1, u2]), turn([blockMsg, a1, u2, u3])] },
    { id: "C-block-dropped", pairs: [summarize([u1, a1, u2]), turn([u3])] },
    { id: "D-compact-every-turn", pairs: [
      summarize([u1, a1, u2]), turn([blockMsg, u3]),
      summarizeTo([blockMsg, u3, a3], 2), turn([next(2), u4]),
      summarizeTo([next(2), u4, a4], 3), turn([next(3), u5]),
    ] },
  ];
}

/** SimulatedRequest stream for one cache epoch. */
export function simRequests(calls: FixtureCall[]): SimulatedRequest[] {
  return calls.map((call) => ({ atSeconds: call.atSeconds, prompt: call.prompt, outputTokens: call.outputTokens }));
}

export type PrecisionRow = { id: CaseId; expected: CompactionFindingKind[]; raised: CompactionFindingKind[]; tp: number; fp: number; fn: number };

export function auditorPrecision(sets: Array<{ id: CaseId; pairs: CompactionAuditPair[] }>): { rows: PrecisionRow[]; findings: number; truePositive: number; falsePositive: number; casesMissed: number } {
  const rows: PrecisionRow[] = [];
  let findings = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let casesMissed = 0;
  for (const set of sets) {
    const report = auditCompactionSession(set.pairs, { enabled: true });
    const expected = EXPECTED[set.id];
    const raised = report.findings.map((finding) => finding.kind);
    const tp = raised.filter((kind) => expected.includes(kind)).length;
    const fp = raised.length - tp;
    const fn = expected.filter((kind) => !raised.includes(kind)).length;
    findings += raised.length;
    truePositive += tp;
    falsePositive += fp;
    casesMissed += fn;
    rows.push({ id: set.id, expected, raised, tp, fp, fn });
  }
  return { rows, findings, truePositive, falsePositive, casesMissed };
}

function main(): void {
  for (const [label, sets] of [["doc-JSON pairs", docPairs()], ["30-turn sessions", buildSessions()]] as const) {
    const result = auditorPrecision(sets as Array<{ id: CaseId; pairs: CompactionAuditPair[] }>);
    console.log(`\n== Auditor precision on ${label} ==`);
    for (const row of result.rows) {
      const counts = row.raised.reduce<Record<string, number>>((acc, kind) => ({ ...acc, [kind]: (acc[kind] ?? 0) + 1 }), {});
      console.log(`${row.id.padEnd(36)} expected=[${row.expected.join(",")}] raised=${JSON.stringify(counts)} tp=${row.tp} fp=${row.fp} missed=${row.fn}`);
    }
    const precision = result.findings === 0 ? 1 : result.truePositive / result.findings;
    console.log(`findings=${result.findings} truePositive=${result.truePositive} falsePositive=${result.falsePositive} ` +
      `precision=${(precision * 100).toFixed(1)}% expectedKindsMissed=${result.casesMissed}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
