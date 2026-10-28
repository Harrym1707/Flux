import {
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type Invoice,
  type LedgerLeverKind,
  type LedgerRecord,
} from "../../core/src/index.js";

/**
 * flux stats: a terminal summary of what FLUX saved, read from the local
 * hash-chained ledger spools (the same records the invoice is recomputed
 * from; see packages/core/src/savings-ledger.ts).
 *
 * Every dollar figure is the output of `recomputeInvoice` over the spool,
 * never a projection. Two kinds of saving exist on a ledger and stay apart:
 * MEASURED (provider-verbatim deltas: cache, tier, exact-cache, measured
 * counterfactuals) and ESTIMATED-BASELINE (token removal valued from FLUX's
 * own pre-send counter). The full summary shows both, labelled; the --share
 * brag line is built from MEASURED savings only, and refuses to print at
 * all when any spool's hash chain is broken.
 */

export type LoadedSpool = { name: string; records: LedgerRecord[] };

export type StatsWindow = {
  /** Inclusive lower bound on event timestamps (ISO). Omitted: everything recorded. */
  since?: string;
  /** Human phrase for the window, used in the share line ("this week"). */
  phrase: string;
};

export type LeverStat = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  savedUsd: number;
  basis: "measured" | "estimated-baseline";
  gateApproved: boolean;
};

export type LedgerStats = {
  window: StatsWindow;
  spools: Array<{ name: string; chainOk: boolean; detail: string; events: number }>;
  allChainsOk: boolean;
  /** Distinct requests (deduplicated by requestId) inside the window. */
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  failedOrExcluded: number;
  /** Catalogue-priced cost actually paid, inside the window. */
  spendUsd: number;
  /** Net verified savings exactly as the invoice computes them (measured + estimated-baseline). */
  netSavedUsd: number;
  /** The provider-verbatim share of netSavedUsd: line items with no estimated-baseline basis. */
  measuredSavedUsd: number;
  estimatedSavedUsd: number;
  /** Savings as a share of what the same requests would have cost without FLUX: saved / (spend + saved). */
  netSavedPercent: number;
  measuredSavedPercent: number;
  /** Provider-reported input tokens read from a cache FLUX itself placed. */
  cacheReadTokensOnFluxPlacedCache: number;
  /** FLUX's own pre-send count of input tokens removed (an estimate, by definition). */
  estimatedInputTokensRemoved: number;
  /** Requests FLUX answered from its exact cache, never sent. */
  exactCacheHits: number;
  levers: LeverStat[];
  unbilled: Array<{ leverId: string; events: number; reason: string }>;
  excludedAlreadyOwnedUsd: number;
};

/** Parse one JSONL spool. Throws with the line number on malformed input. */
export function parseSpool(name: string, text: string): LoadedSpool {
  const records: LedgerRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      throw new Error(`${name}:${index + 1} is not valid JSON.`);
    }
  }
  return { name, records };
}

/** A window of the last `days` days ending at `now`. */
export function lastDays(days: number, now: Date): StatsWindow {
  if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer.");
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return { since, phrase: days === 7 ? "this week" : days === 1 ? "today" : `in the last ${days} days` };
}

function inWindow(event: BillableEvent, window: StatsWindow): boolean {
  return window.since === undefined || event.timestamp >= window.since;
}

export function computeStats(spools: readonly LoadedSpool[], window: StatsWindow): LedgerStats {
  const spoolRows: LedgerStats["spools"] = [];
  const lever = new Map<string, LeverStat>();
  const unbilled = new Map<string, { leverId: string; events: number; reason: string }>();
  let requests = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;
  let failedOrExcluded = 0;
  let spendUsd = 0;
  let netSavedUsd = 0;
  let measuredSavedUsd = 0;
  let cacheRead = 0;
  let removed = 0;
  let exactCacheHits = 0;
  let excludedAlreadyOwnedUsd = 0;

  for (const spool of spools) {
    const chain = verifyLedgerChain(spool.records);
    spoolRows.push({
      name: spool.name,
      chainOk: chain.ok,
      detail: chain.ok ? `${chain.length} record(s), every hash links` : `broken at seq ${chain.seq}: ${chain.reason}`,
      events: spool.records.length,
    });
    const events = spool.records.map((record) => record.event).filter((event) => inWindow(event, window));
    // The invoice dedupes by requestId; the counts below must match it, so
    // they are taken over the same deduplicated set.
    const seen = new Set<string>();
    const unique = [...events]
      .sort((left, right) => (left.timestamp < right.timestamp ? -1 : left.timestamp > right.timestamp ? 1 : 0))
      .filter((event) => (seen.has(event.requestId) ? false : (seen.add(event.requestId), true)));
    const invoice: Invoice = recomputeInvoice(unique);

    requests += invoice.eventsConsidered;
    unpricedRequests += invoice.unpricedEvents;
    failedOrExcluded += invoice.eventsExcludedForFailedTasks;
    netSavedUsd += invoice.netVerifiedSavingsUsd;
    excludedAlreadyOwnedUsd += invoice.excludedAlreadyOwned.providerCacheOnAppendedHistoryUsd +
      invoice.excludedAlreadyOwned.gatewayCacheUsd;
    for (const line of invoice.lineItems) {
      const estimated = line.basis === "estimated-baseline";
      if (!estimated) measuredSavedUsd += line.savedUsd;
      const key = `${line.leverId}\n${estimated ? "e" : "m"}`;
      const entry = lever.get(key) ?? {
        leverId: line.leverId,
        kind: line.kind,
        events: 0,
        savedUsd: 0,
        basis: estimated ? "estimated-baseline" as const : "measured" as const,
        gateApproved: false,
      };
      entry.events += line.events;
      entry.savedUsd += line.savedUsd;
      if (line.kind === "lossy" && line.gateVerdictRefs.length > 0) entry.gateApproved = true;
      lever.set(key, entry);
    }
    for (const item of invoice.recordedUnbilled) {
      const key = `${item.leverId}\n${item.reason}`;
      const entry = unbilled.get(key) ?? { leverId: item.leverId, events: 0, reason: item.reason };
      entry.events += item.events;
      unbilled.set(key, entry);
    }
    for (const event of unique) {
      if (typeof event.actualUsd === "number") {
        spendUsd += event.actualUsd;
        pricedRequests += 1;
      }
      if (event.levers.some((entry) => entry.kind === "provider_cache")) {
        cacheRead += event.usage?.cachedInputTokens ?? 0;
      }
      removed += event.estimatedReduction?.estimatedInputTokensRemoved ?? 0;
      if (event.levers.some((entry) => entry.kind === "exact_cache")) exactCacheHits += 1;
    }
  }

  const share = (saved: number): number => (spendUsd + saved > 0 ? saved / (spendUsd + saved) : 0);
  return {
    window,
    spools: spoolRows,
    allChainsOk: spoolRows.every((row) => row.chainOk),
    requests,
    pricedRequests,
    unpricedRequests,
    failedOrExcluded,
    spendUsd,
    netSavedUsd,
    measuredSavedUsd,
    estimatedSavedUsd: netSavedUsd - measuredSavedUsd,
    netSavedPercent: share(netSavedUsd),
    measuredSavedPercent: share(measuredSavedUsd),
    cacheReadTokensOnFluxPlacedCache: cacheRead,
    estimatedInputTokensRemoved: removed,
    exactCacheHits,
    levers: [...lever.values()].sort((left, right) =>
      right.savedUsd - left.savedUsd || (left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0)),
    unbilled: [...unbilled.values()].sort((left, right) => right.events - left.events ||
      (left.leverId < right.leverId ? -1 : 1)),
    excludedAlreadyOwnedUsd,
  };
}

/**
 * Dollars rounded DOWN (a saving is never overstated): cents from $1 up,
 * four decimals below it. Negative values (a net loss) are shown as such,
 * rounded toward zero, never hidden.
 */
export function usdFloor(value: number): string {
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  const scale = 10 ** digits;
  const magnitude = Math.floor(Math.abs(value) * scale + 1e-9) / scale;
  return `${value < 0 && magnitude > 0 ? "-" : ""}$${magnitude.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Percent rounded DOWN to one decimal. */
export function pctFloor(fraction: number): string {
  return `${(Math.floor(fraction * 1000 + 1e-9) / 10).toFixed(1)}%`;
}

const SHARE_SITE = "fluxtoken.dev";

/**
 * The one-line brag string. MEASURED savings only (estimated-baseline lines
 * are left out entirely), rounded down, and only from verified chains.
 * Returns an explanation instead of a line when there is nothing honest to post.
 */
export function shareLine(stats: LedgerStats): { ok: true; line: string } | { ok: false; reason: string } {
  if (!stats.allChainsOk) {
    return { ok: false, reason: "A ledger hash chain is BROKEN; nothing from it can be shared. Run flux stats for details." };
  }
  if (stats.requests === 0) return { ok: false, reason: `No requests on the ledger ${stats.window.phrase}.` };
  if (stats.measuredSavedUsd <= 0 || usdFloor(stats.measuredSavedUsd) === "$0.0000") {
    return {
      ok: false,
      reason: `No measured savings ${stats.window.phrase} (estimated-baseline savings are never shared).`,
    };
  }
  const requests = stats.requests.toLocaleString("en-US");
  return {
    ok: true,
    line: `FLUX saved me ${usdFloor(stats.measuredSavedUsd)} (${pctFloor(stats.measuredSavedPercent)}) on ` +
      `${requests} request${stats.requests === 1 ? "" : "s"} ${stats.window.phrase}. ` +
      `Verified by a ledger I can recompute: ${SHARE_SITE}`,
  };
}

const compact = (value: number): string => {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1_000_000) return `${(rounded / 1_000_000).toFixed(2)}M`;
  if (Math.abs(rounded) >= 10_000) return `${(rounded / 1_000).toFixed(1)}k`;
  return rounded.toLocaleString("en-US");
};

export function renderStats(stats: LedgerStats): string {
  const lines: string[] = [];
  const bar = (fraction: number, width = 24): string => {
    const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
    return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  };
  lines.push(`FLUX stats — ${stats.window.since === undefined ? "every recorded request" : `${stats.window.phrase} (since ${stats.window.since.slice(0, 10)})`}`);
  lines.push("");
  if (!stats.allChainsOk) {
    lines.push("!! LEDGER CHAIN BROKEN — these numbers cannot be trusted or billed:");
    for (const spool of stats.spools.filter((row) => !row.chainOk)) lines.push(`   ${spool.name}: ${spool.detail}`);
    lines.push("");
  }
  lines.push(`  Saved        ${usdFloor(stats.netSavedUsd)}  (${pctFloor(stats.netSavedPercent)} of what you would have paid)`);
  lines.push(`               ${bar(stats.netSavedPercent)}`);
  lines.push(`    measured   ${usdFloor(stats.measuredSavedUsd)}  (${pctFloor(stats.measuredSavedPercent)}) — provider-verbatim`);
  if (stats.estimatedSavedUsd !== 0) {
    lines.push(`    estimated  ${usdFloor(stats.estimatedSavedUsd)}  — estimated-baseline (FLUX's pre-send counter), labelled on the invoice`);
  }
  lines.push(`  Spent        ${usdFloor(stats.spendUsd)}  on ${stats.pricedRequests.toLocaleString("en-US")} priced request(s)`);
  lines.push(`  Requests     ${stats.requests.toLocaleString("en-US")}` +
    (stats.unpricedRequests > 0 ? `  (${stats.unpricedRequests} unpriced, never guessed)` : "") +
    (stats.failedOrExcluded > 0 ? `  (${stats.failedOrExcluded} excluded: failed or on a failed task)` : ""));
  lines.push("");
  lines.push("  Tokens");
  lines.push(`    ${compact(stats.cacheReadTokensOnFluxPlacedCache).padStart(8)}  input tokens read from a cache FLUX placed (provider-reported, billed at ~0.1x)`);
  lines.push(`    ${compact(stats.estimatedInputTokensRemoved).padStart(8)}  input tokens removed before send (estimate: FLUX's own counter)`);
  if (stats.exactCacheHits > 0) {
    lines.push(`    ${compact(stats.exactCacheHits).padStart(8)}  request(s) answered from FLUX's exact cache, never sent`);
  }
  lines.push("");
  const top = stats.levers.filter((entry) => entry.savedUsd !== 0).slice(0, 5);
  if (top.length > 0) {
    lines.push("  Top levers");
    const width = Math.max(...top.map((entry) => entry.leverId.length));
    for (const entry of top) {
      const tags = [entry.basis === "estimated-baseline" ? "estimate" : "measured", ...(entry.gateApproved ? ["gate-approved"] : [])];
      lines.push(`    ${entry.leverId.padEnd(width)}  ${usdFloor(entry.savedUsd).padStart(9)}  ${String(entry.events).padStart(5)} req  [${tags.join(", ")}]`);
    }
    lines.push("");
  } else {
    lines.push("  No billable savings yet.");
    lines.push("");
  }
  if (stats.unbilled.length > 0) {
    lines.push(`  Recorded, not billed: ${stats.unbilled.slice(0, 4).map((item) => `${item.leverId} x${item.events} (${item.reason})`).join("; ")}`);
  }
  if (stats.excludedAlreadyOwnedUsd !== 0) {
    lines.push(`  Your own cache savings, excluded (never claimed): ${usdFloor(stats.excludedAlreadyOwnedUsd)}`);
  }
  lines.push(`  Ledger: ${stats.spools.length} spool(s), chain ${stats.allChainsOk ? "VERIFIED" : "BROKEN"}. ` +
    "Recompute it yourself: npx -y -p @flux-ai/verify flux-verify <spool.jsonl>");
  return lines.join("\n");
}
