#!/usr/bin/env node
// redundancy-decomposition.mjs
//
// Axis: info-theory-redundancy. Purpose: operationalise the central honest
// claim of the info-theory literature for FLUX — "Shannon redundancy of a
// prompt is NOT the same as FLUX-billable redundancy." It decomposes the
// redundancy of real request bodies into three buckets with different
// billing/quality properties, using only black-box request-byte operations
// (no model, no logits, no second LLM). Zero external deps (Node >=18 zlib).
//
// Buckets (map onto the waste taxonomy):
//   A2 (encoding, LOSSLESS): bytes removable by canonicalising structure —
//       JSON whitespace / pretty-printing. Model reads an identical token
//       stream after re-serialising. FLUX bills unconditionally.
//   A3 (literal-duplicate spans, NEAR-LOSSLESS): byte-identical repeated
//       substrings (e.g. a system line pasted N times). Deduping changes the
//       token stream, so it is a quality-gated lever, but the information is
//       verifiably identical.
//   RESIDUAL (Shannon redundancy, NOT losslessly FLUX-addressable): the
//       statistical predictability of natural language/code that gzip can see
//       but which the model's BPE tokenizer has *already* largely captured.
//       Recovering it needs lossy semantic rewrite (A3-verbose / A4), gated by
//       replay. gzip ratio OVERSTATES what FLUX can take; this script shows the
//       gap so we never quote the gzip number as a saving.
//
// Honesty: every printed ratio is MEASURED on the input file. The "token"
// column uses the repo's own approximateTokenCount = ceil(len/4) (see
// docs/rnd/knowledge 2026-10-25) and is labelled DERIVED, not a true tokenizer
// count — swap in a real tokenizer before quoting token deltas externally.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const approxTokens = (s) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);
const gz = (s) => gzipSync(Buffer.from(s, "utf8"), { level: 9 }).length;

// --- A2: lossless structural canonicalisation --------------------------------
// Re-serialise JSON with no insignificant whitespace. This is the ONLY move
// here that is strictly lossless for the model: same object -> same values ->
// (for a provider that re-tokenises the decoded JSON) same token stream.
function minifyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw; // not JSON; no lossless structural win claimable
  }
}

// --- A3: literal byte-duplicate span detection --------------------------------
// Greedy, non-semantic: find repeated maximal line-blocks that are byte
// identical. We only count a span as dedupable if it appears >=2x verbatim.
// This is deliberately conservative — it is the floor of near-lossless
// redundancy, the part we can prove without a model.
function literalDuplicateBytes(text) {
  const lines = text.split("\n");
  const seen = new Map();
  let dupBytes = 0;
  for (const line of lines) {
    const b = Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length < 12) continue; // ignore trivial lines
    if (seen.has(line)) dupBytes += b;
    else seen.set(line, true);
  }
  // Also catch intra-string verbatim repeats (the pasted-system-line pattern):
  // detect the longest substring that tiles the string >=2x.
  return dupBytes;
}

// crude intra-field verbatim-repeat detector for a single string field
function selfRepeatBytes(s) {
  if (s.length < 40) return 0;
  // try unit lengths; find smallest unit u such that s is ~k*u repeats
  for (let u = 10; u <= Math.floor(s.length / 2); u++) {
    const unit = s.slice(0, u);
    let k = 1;
    while (s.slice(k * u, (k + 1) * u) === unit) k++;
    if (k >= 2 && k * u >= s.length * 0.75) {
      return Buffer.byteLength(s.slice(u), "utf8"); // all but one copy is dup
    }
  }
  return 0;
}

function collectStrings(obj, out) {
  if (typeof obj === "string") out.push(obj);
  else if (Array.isArray(obj)) obj.forEach((x) => collectStrings(x, out));
  else if (obj && typeof obj === "object")
    Object.values(obj).forEach((x) => collectStrings(x, out));
}

function analyseBody(body) {
  const raw = JSON.stringify(body, null, 2); // as a verbose client might send
  const rawBytes = Buffer.byteLength(raw, "utf8");

  // A2 lossless: minified JSON
  const minified = minifyJson(JSON.stringify(body));
  const a2SavedBytes = rawBytes - Buffer.byteLength(minified, "utf8");

  // A3 near-lossless: literal duplicate lines + self-repeating string fields
  const strings = [];
  collectStrings(body, strings);
  let a3SavedBytes = literalDuplicateBytes(minified);
  for (const s of strings) a3SavedBytes += selfRepeatBytes(s);

  // Shannon proxy: gzip of the minified (post-A2) body
  const gzBytes = gz(minified);
  const minBytes = Buffer.byteLength(minified, "utf8");

  return {
    rawBytes,
    minBytes,
    gzBytes,
    a2SavedBytes,
    a3SavedBytes,
    rawTokens: approxTokens(raw),
    minTokens: approxTokens(minified),
  };
}

function pct(n, d) {
  return d > 0 ? ((100 * n) / d).toFixed(1) + "%" : "n/a";
}

function main() {
  const file =
    process.argv[2] ||
    "evals/wire-captures/frameworks-2026-10-25.jsonl";
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

  let agg = {
    rawBytes: 0,
    minBytes: 0,
    gzBytes: 0,
    a2: 0,
    a3: 0,
    rawTokens: 0,
    minTokens: 0,
    n: 0,
  };

  console.log(`\nfile: ${file}  (n=${lines.length} captured requests)\n`);
  console.log(
    "idx  rawB   minB   gzB   | A2-lossless  A3-dup   gzip-redundancy(proxy)",
  );
  console.log("-".repeat(78));

  lines.forEach((ln, i) => {
    let rec;
    try {
      rec = JSON.parse(ln);
    } catch {
      return;
    }
    const body = rec.body ?? rec;
    const a = analyseBody(body);
    agg.rawBytes += a.rawBytes;
    agg.minBytes += a.minBytes;
    agg.gzBytes += a.gzBytes;
    agg.a2 += a2OrZero(a.a2SavedBytes);
    agg.a3 += a.a3SavedBytes;
    agg.rawTokens += a.rawTokens;
    agg.minTokens += a.minTokens;
    agg.n++;

    console.log(
      `${String(i).padStart(3)}  ${pad(a.rawBytes)} ${pad(a.minBytes)} ${pad(
        a.gzBytes,
      )} | ${pad(a.a2SavedBytes)}=${pct(a.a2SavedBytes, a.rawBytes).padStart(
        6,
      )}  ${pad(a.a3SavedBytes)}  ${pct(a.minBytes - a.gzBytes, a.minBytes)}`,
    );
  });

  console.log("-".repeat(78));
  console.log("\n=== AGGREGATE (MEASURED on this file) ===");
  console.log(
    `raw bytes (pretty client)     : ${agg.rawBytes}`,
  );
  console.log(
    `A2 lossless (minify JSON)     : -${
      agg.rawBytes - agg.minBytes
    } bytes = ${pct(agg.rawBytes - agg.minBytes, agg.rawBytes)}  [LOSSLESS, FLUX bills unconditionally]`,
  );
  console.log(
    `A3 literal-dup spans (floor)  : -${agg.a3} bytes = ${pct(
      agg.a3,
      agg.minBytes,
    )} of minified  [NEAR-LOSSLESS, replay-gated]`,
  );
  console.log(
    `gzip redundancy of minified   : ${pct(
      agg.minBytes - agg.gzBytes,
      agg.minBytes,
    )}  [SHANNON PROXY — NOT FLUX-billable: BPE already captures most of it]`,
  );
  console.log(
    `approx tokens raw -> minified : ${agg.rawTokens} -> ${agg.minTokens}  (DERIVED, ceil(len/4) — not a true tokenizer)`,
  );
  console.log(`
INTERPRETATION (the honest gap):
  * The gzip number is the Shannon-style redundancy of the BYTES. It is large
    because English/code/JSON are predictable. FLUX CANNOT bill it: the model
    never sees the bytes, it sees BPE tokens, and BPE has already folded most
    of that statistical redundancy into its merges. Quoting the gzip % as a
    saving would be fraud.
  * What FLUX CAN bill losslessly is the A2 slice (structural/whitespace), and
    only when the provider re-tokenises decoded JSON rather than the raw bytes
    — verify per provider before pricing it.
  * The A3 literal-duplicate slice is provable (byte-identical) but changes the
    token stream, so it is near-lossless and must clear the replay gate; it is
    also the slice most likely to live INSIDE a cacheable prefix, so dedup must
    respect the volatility guard or it busts the cache it was meant to help.
  * Everything between A3 and the gzip line is lossy (verbose paraphrase, A4
    irrelevance) and needs a model + quality gate to touch — out of scope for a
    pure byte-rewrite lever.
`);
}

function pad(n) {
  return String(n).padStart(6);
}
function a2OrZero(x) {
  return Number.isFinite(x) ? x : 0;
}

main();
