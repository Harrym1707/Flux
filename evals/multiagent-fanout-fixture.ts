/**
 * Fixture for the MULTI-AGENT FAN-OUT workload shape: an orchestrator that
 * dispatches a team of sub-agents in PARALLEL, each sharing an identical
 * prefix (project rules + a round-specific briefing + tool schemas) and
 * differing only in a short per-agent role instruction.
 *
 * Grounded in the Claude Agent SDK's own documented subagent behaviour: a
 * subagent gets a fresh context that is NOT empty — it inherits project
 * CLAUDE.md-equivalent instructions and tool definitions from the parent,
 * just not the parent's conversation history. Every sibling spawned in one
 * fan-out round inherits the SAME CLAUDE.md-equivalent text and the SAME
 * tool catalogue; LangGraph's Send API and CrewAI's parallel tasks follow
 * the same shape (a shared team briefing handed to every worker). That
 * shared block is the redundant spend this fixture exists to measure.
 *
 * Deliberately isolates the mechanism under study (concurrent-dispatch cache
 * RACING) from ordinary cross-turn caching, which evals/run-agent-ab.ts
 * already covers: every round's briefing embeds a round-specific ticket id
 * BEFORE the point where sibling agents would diverge, so one round's prefix
 * never accidentally matches another round's (cross-round sharing is not
 * the claim here — the within-round race between simultaneously-dispatched
 * siblings is).
 */

export const ROUNDS = 40;
export const FANOUT = 5;

/**
 * Small and constant across every round: well below the 1,024-token minimum
 * either provider caches, measured at ~110 tokens, so it can never by itself
 * (nor combined with the few characters of a differing ticket number right
 * after it) produce a cross-round cache hit and contaminate the within-round
 * measurement this fixture exists to isolate.
 */
export const PROJECT_RULES = [
  "You are part of a review team working on this repository.",
  "House rule: cite the file and line for every finding, never invent an API, and flag anything you " +
  "are not confident about as a question rather than a statement.",
].join("\n");

const ROLES = ["security", "performance", "correctness", "test-coverage", "style"] as const;

export function roleOf(agentIndex: number): (typeof ROLES)[number] {
  return ROLES[agentIndex % ROLES.length]!;
}

/**
 * The round's shared briefing: a ticket/PR description handed VERBATIM to
 * every sub-agent in the round. Round-specific (so rounds never collide),
 * but identical for every sibling within the round — the real shape of a
 * "review this diff" or "triage this incident" team dispatch.
 */
function briefing(round: number): string {
  const header = `Ticket MESH-${1000 + round}: review the attached diff before it ships.`;
  const body = Array.from({ length: 220 }, (_, index) => `diff-line-${round}-${index}`).join(" ");
  return `${header}\n${body}`;
}

/** Four tool schemas, identical across every round and every agent. */
export function tools(): unknown[] {
  const names = ["read_file", "grep_code", "run_tests", "write_comment"] as const;
  return names.map((name) => ({
    type: "function",
    function: {
      name,
      description:
        `${name} lets a reviewer inspect or annotate the codebase under review. ` +
        "Call it as many times as needed; results are returned verbatim, paginated at 200 lines, " +
        "and this tool definition is identical for every member of the review team so the team shares " +
        "one consistent view of what each other can do.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { path: { type: "string", title: "path", description: "Repo-relative path." } },
        required: ["path"],
      },
    },
  }));
}

export type AnyObject = Record<string, unknown>;

/** One sub-agent's request for one round. system+tools are byte-identical across agentIndex. */
export function buildSubagentRequest(round: number, agentIndex: number): AnyObject {
  const role = roleOf(agentIndex);
  return {
    model: "claude-sonnet-4-5",
    system: `${PROJECT_RULES}\n\n${briefing(round)}`,
    tools: tools(),
    messages: [
      { role: "user", content: `You are the ${role} reviewer. Report findings for your area only.` },
    ],
    metadata: { round, agentIndex, role },
  };
}

/**
 * A trivial pre-warm request: the SAME shared prefix (system+tools) as every
 * sub-agent this round, with a minimal instruction and a tiny output cap, so
 * its only purpose is to get the shared prefix's cache write committed
 * before the real fan-out dispatches. Byte-identical prefix to
 * buildSubagentRequest so the provider's exact-prefix match applies.
 */
export function buildPrewarmRequest(round: number): AnyObject {
  return {
    model: "claude-sonnet-4-5",
    system: `${PROJECT_RULES}\n\n${briefing(round)}`,
    tools: tools(),
    messages: [{ role: "user", content: "Acknowledge receipt of context." }],
    metadata: { round, agentIndex: -1, role: "prewarm" },
    max_output_tokens: 4,
  };
}

/** Per-agent output: a short, fixed-shape finding. Unaffected by any arm here. */
export const SUBAGENT_OUTPUT_TOKENS = 380;
export const PREWARM_OUTPUT_TOKENS = 4;

/**
 * The grading check: the only thing a reduction to THIS fixture could ever
 * break is which role answered and whether its own round's ticket id made it
 * into the prompt. Both are invariant across every arm in
 * run-multiagent-fanout.ts by construction (the lever changes dispatch
 * TIMING, never a single byte of content) — this function exists so that
 * claim is checked, not assumed.
 */
export function isWellFormed(request: AnyObject, round: number, agentIndex: number): boolean {
  const meta = request.metadata as AnyObject;
  if (meta.round !== round || meta.agentIndex !== agentIndex) return false;
  const system = String(request.system ?? "");
  return system.includes(`MESH-${1000 + round}`) && system.includes("House rule:");
}
