import { approximateTokenCount, type TokenCounter } from "../../core/src/index.js";

/**
 * flux compress: one-off, deterministic compression of a STABLE memory or
 * instruction file (CLAUDE.md, AGENTS.md, .cursorrules, a system-prompt file).
 *
 * These files ride at the front of every request an agent sends, so every
 * token removed here is removed from every turn, forever. The rewrite is
 * deliberately conservative and fully deterministic (same input, same bytes
 * out; running it twice changes nothing the second time):
 *
 * - Fenced code blocks, inline code, URLs, file paths, shell-prompt lines,
 *   tables and every number survive byte-for-byte.
 * - Filler words and wordy stock phrases are removed or shortened from prose.
 * - Runs of spaces inside a line collapse (leading indentation is kept, so
 *   nested lists keep their structure), trailing whitespace goes, and runs
 *   of blank lines collapse to one.
 * - A rule repeated verbatim (same words, ignoring case, list marker and
 *   trailing punctuation) is kept at its first occurrence only.
 *
 * It is still LOSSY: dropping "please" or a repeated rule can change how a
 * model weighs an instruction. The CLI always shows the diff and keeps a
 * backup so the user decides.
 */

export type CompressionStats = {
  fillerEdits: number;
  duplicateRulesRemoved: number;
  whitespaceEdits: number;
};

export type CompressionResult = {
  text: string;
  tokensBefore: number;
  tokensAfter: number;
  stats: CompressionStats;
};

/** Wordy phrase -> shorter equivalent. Matched case-insensitively on word boundaries. */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bit is (?:very |really )?important (?:to note |to remember )?that\s+(?:you\s+(?=[a-z]))?/gi, ""],
  [/\bit's (?:very |really )?important (?:to note |to remember )?that\s+(?:you\s+(?=[a-z]))?/gi, ""],
  [/\b(?:please )?(?:note|keep in mind|remember|be aware) that\s+/gi, ""],
  // Only the forms whose remainder is already an imperative: "make sure the
  // build is green" -> "the build is green" would turn a rule into a claim.
  [/\b(?:please )?make sure to\s+/gi, ""],
  [/\b(?:please )?make sure (?:that )?you\s+/gi, ""],
  [/\bbe sure to\s+/gi, ""],
  [/\bi (?:would like|want) you to\s+/gi, ""],
  [/\byou should always\b/gi, "always"],
  [/\byou must always\b/gi, "always"],
  [/\byou should never\b/gi, "never"],
  [/\byou must never\b/gi, "never"],
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bin the event that\b/gi, "if"],
  [/\bat this point in time\b/gi, "now"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bwith regard to\b/gi, "about"],
  [/\bin regards? to\b/gi, "about"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\b(?:is|are) able to\b/gi, "can"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bprior to\b/gi, "before"],
  [/\bin addition to\b/gi, "besides"],
  [/\bplease\s+/gi, ""],
  [/\b(?:basically|essentially|literally),?\s+/gi, ""],
  // Never after "not": "not very stable" -> "not stable" flips the meaning.
  [/(?<!\bnot )\b(?:very|really)\s+(?=[A-Za-z])/gi, ""],
];

/** Spans that are never rewritten: inline code, URLs, paths, numbers (with units). */
const PROTECTED =
  /`[^`\n]*`|<https?:[^>\s]*>|\bhttps?:\/\/[^\s)>\]]+|(?:^|(?<=[\s("'[=]))(?:~|\.{1,2})?\/[\w.\-/~@:+]+|\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|jsonl|md|mdc|yml|yaml|toml|txt|csv|html|css|go|rs|java|rb|sh|sql|lock|env)\b|(?<![\w-])-{1,2}[A-Za-z][\w-]*|\b\d[\d.,:_%x]*\w*/g;

const FENCE = /^\s*(```|~~~)/;
const SENTINEL = "\u0000";
/** Marks where a sentence-initial phrase was removed, so the next word is recapitalised there only. */
const CAPITALISE = "\u0001";

/** Lines whose bytes matter beyond their words: kept verbatim. */
function isVerbatimLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") || // tables
    trimmed.startsWith("$ ") || trimmed.startsWith("> $") || trimmed.startsWith("# $") || // shell prompts
    /^\s{4,}\S/.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || // indented code (not a nested list item)
    trimmed.startsWith("<!--");
}

function rewriteProse(line: string, stats: CompressionStats): string {
  const leading = /^\s*/.exec(line)![0];
  let body = line.slice(leading.length);
  // List marker / heading marker stay in front, untouched.
  const markerMatch = /^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+)?/.exec(body)!;
  const marker = markerMatch[0];
  body = body.slice(marker.length);

  const saved: string[] = [];
  body = body.replace(PROTECTED, (match) => {
    saved.push(match);
    return `${SENTINEL}${saved.length - 1}${SENTINEL}`;
  });

  for (const [pattern, replacement] of REPLACEMENTS) {
    const current = body;
    body = current.replace(pattern, (match: string, ...rest: unknown[]) => {
      stats.fillerEdits += 1;
      const offset = rest[rest.length - 2] as number;
      const sentenceStart = /^(?:\u0001)*$/.test(current.slice(0, offset)) ||
        /[.!?:]\s+(?:\u0001)*$/.test(current.slice(0, offset));
      if (!sentenceStart || !/^[A-Z]/.test(match)) return replacement;
      // Keep the sentence capitalised: an emptied opener capitalises the next word.
      return replacement === "" ? CAPITALISE : replacement[0]!.toUpperCase() + replacement.slice(1);
    });
  }
  body = body.replace(/\u0001+(\s*)([a-z]?)/g, (_match, space: string, letter: string) => space + letter.toUpperCase());

  const collapsed = body.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\s+$/, "");
  if (collapsed !== body.replace(/\s+$/, "")) stats.whitespaceEdits += 1;
  body = collapsed;

  body = body.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"), (_match, index: string) => saved[Number(index)]!);
  return `${leading}${marker}${body}`;
}

/** Normalised identity of a rule line, for duplicate detection. Undefined: never deduped. */
function ruleKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined; // headings repeat legitimately
  const words = trimmed
    .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+)/, "")
    .replace(/[.;:!]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  // Short fragments ("Yes.", "---") are structure, not rules.
  return words.length >= 12 ? words : undefined;
}

export function compressInstructions(text: string, countTokens: TokenCounter = approximateTokenCount): CompressionResult {
  const stats: CompressionStats = { fillerEdits: 0, duplicateRulesRemoved: 0, whitespaceEdits: 0 };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const seenRules = new Set<string>();
  let inFence: string | undefined;

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (inFence !== undefined) {
      out.push(line);
      if (fence && fence[1] === inFence) inFence = undefined;
      continue;
    }
    if (fence) {
      inFence = fence[1];
      out.push(line);
      continue;
    }
    if (isVerbatimLine(line)) {
      out.push(line);
      continue;
    }
    const rewritten = rewriteProse(line, stats);
    // A line emptied by filler removal (e.g. a lone "Please note that:")
    // is dropped only if it had words; blank lines are handled below.
    if (rewritten.trim() === "" && line.trim() !== "") {
      stats.fillerEdits += 1;
      continue;
    }
    const key = ruleKey(rewritten);
    if (key !== undefined) {
      if (seenRules.has(key)) {
        stats.duplicateRulesRemoved += 1;
        continue;
      }
      seenRules.add(key);
    }
    out.push(rewritten);
  }

  // Collapse runs of blank lines (outside fences: fence bodies were pushed
  // verbatim, so only blank runs between prose lines are merged here).
  const collapsed: string[] = [];
  let fenceOpen: string | undefined;
  for (const line of out) {
    const fence = FENCE.exec(line);
    if (fenceOpen === undefined && line.trim() === "" && collapsed.length > 0 &&
        collapsed[collapsed.length - 1]!.trim() === "") {
      stats.whitespaceEdits += 1;
      continue;
    }
    if (fence) fenceOpen = fenceOpen === undefined ? fence[1] : fence[1] === fenceOpen ? undefined : fenceOpen;
    collapsed.push(line);
  }
  // Leading blank lines carry nothing; keep exactly one trailing newline if there was one.
  while (collapsed.length > 1 && collapsed[0]!.trim() === "") collapsed.shift();
  const hadTrailingNewline = /\r?\n$/.test(text);
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === "") collapsed.pop();
  const result = collapsed.join(newline) + (hadTrailingNewline ? newline : "");

  return {
    text: result,
    tokensBefore: countTokens(text),
    tokensAfter: countTokens(result),
    stats,
  };
}

// ---------------------------------------------------------------------------
// Unified diff (LCS over lines; memory files are small)
// ---------------------------------------------------------------------------

export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string, context = 3): string {
  if (before === after) return "";
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > 16_000_000) {
    return `--- ${fromLabel}\n+++ ${toLabel}\n(diff too large to render: ${n} -> ${m} lines; compare against the backup)\n`;
  }
  // lcs[i][j] = LCS length of a[i..], b[j..]
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  type Op = { kind: " " | "-" | "+"; line: string; aIndex: number; bIndex: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]!, aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      // Deletions before insertions, as diff(1) prints them.
      ops.push({ kind: "-", line: a[i]!, aIndex: i, bIndex: j });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j]!, aIndex: i, bIndex: j });
      j += 1;
    }
  }

  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === " ") {
      index += 1;
      continue;
    }
    // Grow a hunk around this change, merging changes closer than 2*context.
    const start = Math.max(0, index - context);
    let end = index;
    let lastChange = index;
    while (end < ops.length) {
      if (ops[end]!.kind !== " ") lastChange = end;
      else if (end - lastChange > context * 2) break;
      end += 1;
    }
    const stop = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, stop);
    const aStart = hunk[0]!.aIndex;
    const bStart = hunk[0]!.bIndex;
    const aCount = hunk.filter((op) => op.kind !== "+").length;
    const bCount = hunk.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${aCount === 0 ? aStart : aStart + 1},${aCount} +${bCount === 0 ? bStart : bStart + 1},${bCount} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.line}`);
    index = stop;
  }
  return `${lines.join("\n")}\n`;
}
