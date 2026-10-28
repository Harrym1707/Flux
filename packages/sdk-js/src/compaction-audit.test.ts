import { describe, expect, it } from "vitest";
import {
  auditCompactionSession,
  CompactionAuditor,
  compactionAdviceLines,
  type CompactionAuditPair,
} from "./compaction-audit.js";

type AnyObject = Record<string, any>;

const SYSTEM = "You are a coding agent. ".repeat(200);
const user = (n: number): AnyObject => ({ role: "user", content: `question ${n}: ${"detail ".repeat(50)}` });
const assistant = (n: number): AnyObject => ({ role: "assistant", content: `answer ${n}: ${"reasoning ".repeat(80)}` });
const block = (n: number): AnyObject => ({ type: "compaction", content: `Summary ${n}`, signature: `sig-${n}` });
const reply: AnyObject = {
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1_000, output_tokens: 100, iterations: [{ type: "message", input_tokens: 1_000, output_tokens: 100 }] },
};
const summary = (n: number): AnyObject => ({
  content: [block(n)],
  stop_reason: "compaction",
  usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 50_000, output_tokens: 3_000 }] },
});

function turnPair(messages: AnyObject[]): CompactionAuditPair {
  return { request: { model: "claude-opus-5-5", system: SYSTEM, messages }, response: reply };
}
function summarizePair(messages: AnyObject[], n: number): CompactionAuditPair {
  return {
    request: { model: "claude-opus-5-5", system: SYSTEM, messages, compaction: { type: "summarize" } },
    response: summary(n),
  };
}

describe("compaction hygiene auditor", () => {
  it("is off by default: no findings, nothing observed", () => {
    const auditor = new CompactionAuditor();
    expect(auditor.observe(summarizePair([user(1), assistant(1)], 1))).toEqual([]);
    expect(auditor.report().pairsObserved).toBe(0);
    expect(compactionAdviceLines(auditor.report())).toEqual([]);
  });

  it("raises nothing on a correct swap, including a later compact-again", () => {
    const history = [user(1), assistant(1), user(2), assistant(2)];
    const pairs: CompactionAuditPair[] = [
      turnPair([user(1)]),
      summarizePair(history, 1),
      turnPair([{ role: "assistant", content: [block(1)] }, user(3)]),
      turnPair([{ role: "assistant", content: [block(1)] }, user(3), assistant(3), user(4)]),
      summarizePair([{ role: "assistant", content: [block(1)] }, user(3), assistant(3), user(4), assistant(4)], 2),
      turnPair([{ role: "assistant", content: [block(2)] }, user(5)]),
    ];
    const report = auditCompactionSession(pairs, { enabled: true });
    expect(report.findings).toEqual([]);
    expect(report.compactionEvents).toBe(2);
  });

  it("flags summarized messages left after the block as re-billed, even when FLUX stamped them", () => {
    const history = [user(1), assistant(1), user(2), assistant(2)];
    const stampedTail = { role: "assistant", content: [{ type: "text", text: assistant(2).content, cache_control: { type: "ephemeral" } }] };
    const report = auditCompactionSession([
      summarizePair(history, 1),
      turnPair([{ role: "assistant", content: [block(1)] }, user(2), stampedTail, user(3)]),
    ], { enabled: true, countTokens: (text) => text.length });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.kind).toBe("rebilled-summarized-history");
    expect(report.findings[0]!.messageIndexes).toEqual([1, 2]);
    expect(report.rebilledApproxTokens).toBe(user(2).content.length + assistant(2).content.length);
  });

  it("does not flag keep-tail compaction: kept turns were never sent to the summarizer", () => {
    const report = auditCompactionSession([
      summarizePair([user(1), assistant(1)], 1),
      turnPair([{ role: "assistant", content: [block(1)] }, user(2), assistant(2), user(3)]),
    ], { enabled: true });
    expect(report.findings).toEqual([]);
  });

  it("flags a later request that drops the block", () => {
    const report = auditCompactionSession([
      summarizePair([user(1), assistant(1)], 1),
      turnPair([user(2)]),
    ], { enabled: true });
    expect(report.findings.map((finding) => finding.kind)).toEqual(["compaction-block-dropped"]);
  });

  it("flags compaction on every turn and re-summarizing an identical growing prefix", () => {
    const every: CompactionAuditPair[] = [];
    let history: AnyObject[] = [];
    for (let n = 1; n <= 4; n += 1) {
      history = [...history, user(n)];
      every.push(turnPair(history));
      history = [...history, assistant(n)];
      every.push(summarizePair(history, n));
      history = [{ role: "assistant", content: [block(n)] }];
    }
    const kinds = auditCompactionSession(every, { enabled: true }).findings.map((finding) => finding.kind);
    expect(kinds).toEqual(["repeated-compaction"]);

    const unswapped = auditCompactionSession([
      summarizePair([user(1), assistant(1)], 1),
      summarizePair([user(1), assistant(1), user(2), assistant(2)], 2),
    ], { enabled: true });
    expect(unswapped.findings.some((finding) => finding.kind === "repeated-compaction")).toBe(true);
  });

  it("flags threshold compaction whose only breakpoints sit in the dropped history, not when system is stamped", () => {
    const thresholdRequest = (system: unknown) => ({
      model: "claude-opus-5-5",
      system,
      context_management: { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 50_000 } }] },
      messages: [user(1), assistant(1), { role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }],
    });
    const response = {
      content: [block(1), { type: "text", text: "ok" }],
      usage: {
        input_tokens: 5_000, output_tokens: 100,
        iterations: [{ type: "compaction", input_tokens: 60_000, output_tokens: 2_000 }, { type: "message", input_tokens: 5_000, output_tokens: 100 }],
      },
    };
    const flagged = auditCompactionSession([{ request: thresholdRequest(SYSTEM), response }], { enabled: true });
    expect(flagged.findings.map((finding) => finding.kind)).toEqual(["threshold-compaction-cache"]);
    const stampedSystem = [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }];
    const clean = auditCompactionSession([{ request: thresholdRequest(stampedSystem), response }], { enabled: true });
    expect(clean.findings).toEqual([]);
    expect(compactionAdviceLines(flagged).join("\n")).toContain("advice only");
  });

  it("never throws on malformed input", () => {
    const auditor = new CompactionAuditor({ enabled: true });
    expect(auditor.observe({ request: null })).toEqual([]);
    expect(auditor.observe({ request: { messages: "nope" }, response: 42 })).toEqual([]);
  });
});
