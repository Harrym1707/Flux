import { createHash } from "node:crypto";
import {
  approximateTokenCount,
  canonicalJson,
  providerCompactionUsage,
  type TokenCounter,
} from "../../core/dist/src/index.js";

/**
 * Provider-compaction hygiene audit (LOSSLESS, ADVISE-ONLY).
 *
 * Anthropic's server-side compaction (beta headers `compact-2026-09-04` for
 * on-demand, `compact-2026-01-12` for the threshold edit `compact_20260112`)
 * replaces old turns with a signed summary block. The swap is the caller's
 * job, and the docs name two mistakes that raise no error:
 *
 *   "Two mistakes in the swap raise no error. If summarized messages remain
 *    after the block, the API sends them to Claude again. If a later request
 *    leaves the block out, Claude gets no summary."
 *   (platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
 *
 * This auditor watches request/response pairs and reports those mistakes,
 * plus two cost patterns, as advice. It changes no request or response byte,
 * bills nothing, and never leaves the process: it keeps only SHA-256 hashes
 * of messages (cache_control stripped, so FLUX's own stamps do not change a
 * message's identity) and FLUX's approximate token count for each hash.
 *
 * Findings:
 *   rebilled-summarized-history  a compaction block followed by messages the
 *                                block already summarized (re-sent and billed)
 *   compaction-block-dropped     a request after a compaction carries no block
 *                                (the summary was paid for and is not used)
 *   repeated-compaction          compaction on consecutive turns, or a new
 *                                summarize call over an identical growing
 *                                prefix of a previous one
 *   threshold-compaction-cache   threshold compaction fired on a request whose
 *                                cache breakpoints sit in the history the API
 *                                then drops ("all content blocks before it are
 *                                ignored"), with no breakpoint on system/tools
 *                                to survive it
 *
 * Off by default: an auditor constructed without `enabled: true` observes
 * nothing and returns no findings.
 */

type AnyObject = Record<string, unknown>;

export type CompactionAuditConfig = {
  /** Default false: the auditor is inert until explicitly enabled. */
  enabled?: boolean;
  /** Token estimator for re-billed volume; default approximateTokenCount (measured +28% prose / -13% JSON bias). */
  countTokens?: TokenCounter;
  /** Compactions this many turns apart or closer count as "every turn". Default 1. */
  repeatedWithinTurns?: number;
  /** How many back-to-back close compactions make a repeated-compaction finding. Default 3. */
  repeatedRunLength?: number;
};

export type CompactionAuditPair = {
  /** The Messages API request body as sent. */
  request: unknown;
  /** The provider response, when one came back. */
  response?: unknown;
};

export type CompactionFindingKind =
  | "rebilled-summarized-history"
  | "compaction-block-dropped"
  | "repeated-compaction"
  | "threshold-compaction-cache";

export type CompactionFinding = {
  kind: CompactionFindingKind;
  /** Index of the pair (0-based) the finding was raised on. */
  turnIndex: number;
  /** Message indexes in that request the finding concerns, when any. */
  messageIndexes?: number[];
  /** FLUX-approximate tokens re-sent that the summary already covered (estimate, see config). */
  rebilledApproxTokens?: number;
  detail: string;
  advice: string;
};

export type CompactionAuditReport = {
  enabled: boolean;
  pairsObserved: number;
  compactionEvents: number;
  findings: CompactionFinding[];
  rebilledApproxTokens: number;
};

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!isPlainObject(value)) return value;
  const out: AnyObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "cache_control") continue;
    out[key] = withoutCacheControl(member);
  }
  // A string body and its single-text-block form are the same message to the
  // API; FLUX's stamp lifts one into the other, so normalise it back.
  if (Array.isArray(out.content) && out.content.length === 1 && isPlainObject(out.content[0]) &&
      out.content[0].type === "text" && typeof out.content[0].text === "string" &&
      Object.keys(out.content[0]).length === 2) {
    out.content = out.content[0].text;
  }
  return out;
}

function messageHash(message: unknown): string {
  return createHash("sha256").update(canonicalJson(withoutCacheControl(message))).digest("hex");
}

function messageText(message: unknown): string {
  if (!isPlainObject(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.content === "string") parts.push(block.content);
    else if (Array.isArray(block.content)) parts.push(JSON.stringify(block.content));
    else if (block.input !== undefined) parts.push(JSON.stringify(block.input));
  }
  return parts.join("\n");
}

function hasCompactionBlock(message: unknown): boolean {
  return isPlainObject(message) && Array.isArray(message.content) &&
    message.content.some((block) => isPlainObject(block) && block.type === "compaction");
}

function carriesCacheControl(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? "").includes('"cache_control"');
}

function isOnDemandCompaction(request: AnyObject): boolean {
  return isPlainObject(request.compaction) && request.compaction.type === "summarize";
}

function isThresholdCompaction(request: AnyObject): boolean {
  const edits = isPlainObject(request.context_management) ? request.context_management.edits : undefined;
  return Array.isArray(edits) &&
    edits.some((edit) => isPlainObject(edit) && typeof edit.type === "string" && edit.type.startsWith("compact_"));
}

function responseCompacted(response: unknown): boolean {
  if (!isPlainObject(response)) return false;
  const content = Array.isArray(response.content) ? response.content : [];
  const block = content.some((entry) => isPlainObject(entry) && entry.type === "compaction" &&
    typeof entry.content === "string");
  return block || providerCompactionUsage(response).status !== "none";
}

function responseBlockProduced(response: unknown): boolean {
  if (!isPlainObject(response)) return false;
  const content = Array.isArray(response.content) ? response.content : [];
  return content.some((entry) => isPlainObject(entry) && entry.type === "compaction" && typeof entry.content === "string");
}

/** Incremental, in-memory, hash-only compaction auditor for one conversation. */
export class CompactionAuditor {
  readonly enabled: boolean;
  private readonly countTokens: TokenCounter;
  private readonly repeatedWithinTurns: number;
  private readonly repeatedRunLength: number;
  /** hash -> approximate tokens, for every message some compaction summarized. */
  private readonly summarized = new Map<string, number>();
  private blockLive = false;
  private compactionTurns: number[] = [];
  private lastSummarizePrefix: string[] = [];
  private repeatedRunReported = -1;
  private pairs = 0;
  private readonly found: CompactionFinding[] = [];

  constructor(config: CompactionAuditConfig = {}) {
    this.enabled = config.enabled === true;
    this.countTokens = config.countTokens ?? approximateTokenCount;
    this.repeatedWithinTurns = Math.max(1, config.repeatedWithinTurns ?? 1);
    this.repeatedRunLength = Math.max(2, config.repeatedRunLength ?? 3);
  }

  /** Observe one pair; returns the findings it raised. Never throws. */
  observe(pair: CompactionAuditPair): CompactionFinding[] {
    if (!this.enabled) return [];
    try {
      return this.observeUnsafe(pair);
    } catch {
      return [];
    }
  }

  private observeUnsafe(pair: CompactionAuditPair): CompactionFinding[] {
    const turnIndex = this.pairs;
    this.pairs += 1;
    const raised: CompactionFinding[] = [];
    if (!isPlainObject(pair.request)) return raised;
    const request = pair.request;
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const hashes = messages.map(messageHash);
    // The NEWEST block is the one in force: threshold compaction drops
    // everything before it, and on-demand allows exactly one.
    let blockIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (hasCompactionBlock(messages[index])) {
        blockIndex = index;
        break;
      }
    }
    const onDemand = isOnDemandCompaction(request);
    const threshold = isThresholdCompaction(request);
    const tokensOf = (index: number): number => {
      const known = this.summarized.get(hashes[index]!);
      return known ?? this.countTokens(messageText(messages[index]));
    };

    // (a) Re-billed history: summarized messages AFTER the block are sent to
    // Claude again (threshold mode drops what sits BEFORE the block, so only
    // the after-block side is ever billed twice).
    if (blockIndex >= 0) {
      const leftovers: number[] = [];
      for (let index = blockIndex + 1; index < messages.length; index += 1) {
        if (this.summarized.has(hashes[index]!)) leftovers.push(index);
      }
      if (leftovers.length > 0) {
        const tokens = leftovers.reduce((sum, index) => sum + tokensOf(index), 0);
        raised.push({
          kind: "rebilled-summarized-history",
          turnIndex,
          messageIndexes: leftovers,
          rebilledApproxTokens: tokens,
          detail: `${leftovers.length} message(s) after the compaction block were already summarized by it ` +
            `(~${tokens} tokens, FLUX estimate) and are re-sent and billed on this request.`,
          advice: "Remove the summarized messages: the block replaces them. To keep recent turns word for word, " +
            "leave them OUT of the compaction request (keep-tail compaction), then send them after the block.",
        });
      }
    } else if (this.blockLive && !onDemand && messages.length > 0) {
      // A request after a compaction that carries no block: no summary.
      const resent: number[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        if (this.summarized.has(hashes[index]!)) resent.push(index);
      }
      const tokens = resent.reduce((sum, index) => sum + tokensOf(index), 0);
      raised.push({
        kind: "compaction-block-dropped",
        turnIndex,
        ...(resent.length > 0 ? { messageIndexes: resent, rebilledApproxTokens: tokens } : {}),
        detail: "This request follows a compaction but carries no compaction block, so Claude gets no summary" +
          (resent.length > 0 ? `, and ${resent.length} already-summarized message(s) (~${tokens} tokens) are re-sent.` : "; the summary already paid for is unused."),
        advice: "Send the newest compaction block first in messages on every later request, exactly as returned " +
          "(check middleware that strips unknown content block types).",
      });
      this.blockLive = false;
    }

    // (c) Threshold compaction with breakpoints only inside the dropped history.
    const compacted = responseCompacted(pair.response);
    if (threshold && compacted) {
      const systemOrToolsCached = carriesCacheControl(request.system) || carriesCacheControl(request.tools);
      const messageBreakpoint = carriesCacheControl(messages);
      if (messageBreakpoint && !systemOrToolsCached) {
        raised.push({
          kind: "threshold-compaction-cache",
          turnIndex,
          detail: "Threshold compaction fired on a request whose only cache breakpoints sit in the conversation " +
            "history, which the API drops after the block; no breakpoint on system/tools survives, so the next " +
            "request re-pays the whole system prompt at the full (or write) rate.",
          advice: "Add a cache_control breakpoint at the end of the system prompt (the docs: the system prompt " +
            "cache then \"remains valid\" across compactions) and put cache_control on the compaction block.",
        });
      }
    }

    // State: what this compaction summarized.
    if (compacted) {
      if (onDemand) {
        // The API "summarizes every message in the request once".
        messages.forEach((message, index) => {
          if (!hasCompactionBlock(message)) this.summarized.set(hashes[index]!, tokensOf(index));
        });
      } else {
        // Threshold: the block follows (and replaces) everything this request sent.
        messages.forEach((_, index) => {
          if (blockIndex < 0 || index > blockIndex) this.summarized.set(hashes[index]!, tokensOf(index));
        });
      }
      if (responseBlockProduced(pair.response)) this.blockLive = true;

      // (b) Re-summarizing an identical, growing prefix of the last summarize call.
      if (onDemand && this.lastSummarizePrefix.length > 0) {
        const previous = this.lastSummarizePrefix;
        let shared = 0;
        while (shared < previous.length && shared < hashes.length && previous[shared] === hashes[shared]) shared += 1;
        if (shared === previous.length && hashes.length > previous.length) {
          raised.push({
            kind: "repeated-compaction",
            turnIndex,
            detail: `This summarize call re-reads the same ${shared} message(s) the previous one already ` +
              "summarized, instead of starting from its block.",
            advice: "After a compaction, replace the history with the returned block; compact again over " +
              "[block, newer turns] only.",
          });
        }
      }
      if (onDemand) this.lastSummarizePrefix = hashes;

      // (b) Compaction on (nearly) every turn.
      this.compactionTurns.push(turnIndex);
      const turns = this.compactionTurns;
      let run = 1;
      for (let index = turns.length - 1; index > 0; index -= 1) {
        if (turns[index]! - turns[index - 1]! <= this.repeatedWithinTurns + (onDemand ? 1 : 0)) run += 1;
        else break;
      }
      if (run >= this.repeatedRunLength && this.repeatedRunReported !== turns.length - run) {
        this.repeatedRunReported = turns.length - run;
        raised.push({
          kind: "repeated-compaction",
          turnIndex,
          detail: `${run} compactions on consecutive turns: each pays a full summarization call while ` +
            "freeing almost nothing.",
          advice: "Compare the NEXT request's size (input + cache reads + cache writes + output of the last " +
            "turn) with your limit, and re-measure after each compaction instead of keeping a running total.",
        });
      }
    }

    this.found.push(...raised);
    return raised;
  }

  report(): CompactionAuditReport {
    return {
      enabled: this.enabled,
      pairsObserved: this.pairs,
      compactionEvents: this.compactionTurns.length,
      findings: [...this.found],
      rebilledApproxTokens: this.found.reduce((sum, finding) => sum + (finding.rebilledApproxTokens ?? 0), 0),
    };
  }
}

/** Audit a whole conversation's pairs in order. Pure: nothing is retained or sent. */
export function auditCompactionSession(
  pairs: readonly CompactionAuditPair[],
  config: CompactionAuditConfig = {},
): CompactionAuditReport {
  const auditor = new CompactionAuditor(config);
  for (const pair of pairs) auditor.observe(pair);
  return auditor.report();
}

/** Human-readable advice lines for a report (local display only). */
export function compactionAdviceLines(report: CompactionAuditReport): string[] {
  if (!report.enabled) return [];
  if (report.findings.length === 0) {
    return report.compactionEvents === 0
      ? []
      : [`Compaction hygiene: ${report.compactionEvents} compaction(s), no misuse found.`];
  }
  const lines = [
    `Compaction hygiene: ${report.findings.length} finding(s) over ${report.compactionEvents} compaction(s); ` +
      `~${report.rebilledApproxTokens} re-sent summarized tokens (FLUX estimate, counter bias +28% prose / -13% JSON).`,
  ];
  const seen = new Set<CompactionFindingKind>();
  for (const finding of report.findings) {
    lines.push(`  turn ${finding.turnIndex} [${finding.kind}] ${finding.detail}`);
    if (!seen.has(finding.kind)) {
      seen.add(finding.kind);
      lines.push(`    advice: ${finding.advice}`);
    }
  }
  lines.push("  (advice only: FLUX changed no request bytes and bills nothing for this audit.)");
  return lines;
}
