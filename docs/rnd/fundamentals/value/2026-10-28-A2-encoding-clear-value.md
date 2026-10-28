# A2-encoding — the CLEAR, DEFENSIBLE value (and where it is a dead end)

Axis: **A2-encoding** (lossless re-encoding of the outgoing request body).
Date: 2026-10-28. Analyst mandate: resolve, on REAL tool schemas + structured
tool_result payloads, the token delta of (a) the lossless slice *beyond* what
the shipped `minifyToolSchemas` already takes, and (b) the lossy format-swap
slice — then judge whether the format-swap is worth building behind the replay
gate or whether A2 is a dead end beyond the minifier.

Measuring stick: `python3` + `tiktoken` o200k_base (MEASURED, not chars/4).
Harness: `evals/fundamentals/value/a2_encoding_value.py` (re-runnable).
Every number below carries a basis label.

Real data used:
- 100 real OpenAI-format tool catalogues / 270 tool schemas
  (NousResearch/hermes-function-calling-v1) — `scratchpad/hermes_catalogues.json`.
- 243 real structured tool_result payloads (ToolBench/Gorilla-style
  `{name, content}`) — `scratchpad/payloads.json`.
- Local wire captures: `evals/wire-captures/frameworks-2026-10-25.jsonl`
  (langchain-anthropic, openai-python serializers) and
  `litellm-volatility-2026-10-25.jsonl` (72 real multi-turn chat messages).

---

## TL;DR verdict

**A2 is a dead end beyond the minifier's whitespace canonicalisation, and even
that canonicalisation is worth ~0 billable tokens on realistic traffic.** The
only strictly-lossless, bill-now A2 win is compacting JSON that arrives as a
**verbatim string inside message content** — and that slice is entirely
workload-dependent (absent from every real agent/chat capture we hold). The
format-swap (JSON→TOON/CSV) is LOSSY, **net-negative on average**, and only
helps the ~30% of tool results that contain a uniform object-array. Recommend:
**do not invest further in A2 as a lossless billable lever; keep the minifier
as cache-neutral canonicalisation only; treat tabular format-swap as a narrow,
gated, opt-in lever, not a headline number.**

---

## 1. The lossless slice BEYOND the minifier — MEASURED ~0 on real schemas

The shipped `minifyToolSchemas` lossless tier does three things: strip plumbing
keys (`$schema`/`$id`/`$comment`/`$defs`), drop `title`s that restate the
property name, and serialise compact.

On 100 real OpenAI-format catalogues:

| serialisation of `tools` array | tokens (sum/100 cats) | vs pretty |
|---|---|---|
| pretty-printed (indent=2) — the minifier's BEFORE baseline | 51,505 | — |
| python `json.dumps` default (`", "`/`": "`) | 39,388 | −23.5% |
| fully compact (JS `JSON.stringify`) | 31,168 | −39.5% |

- **Minifier headline "lossless 39.5%" is 100% whitespace.** MEASURED. The
  structural key-drop pass (plumbing + redundant titles) saved **0 tokens on
  0/100 catalogues** (min/p50/p90/max all 0.00%). Real-world OpenAI tool
  schemas simply do not carry `$schema`/`$id`/redundant `title` fields, so the
  minifier's non-whitespace lossless pass recovers nothing here. MEASURED.
- **The whitespace win is a baseline artefact.** Real clients already serialise
  compact: langchain-anthropic and openai-python both emit `JSON.stringify`-style
  compact bodies (framework captures, Part 2). A proxy that rewrites the body
  *must* parse and re-serialise it, and any standard serialiser emits compact by
  default — so the whitespace is canonicalised **for free as a side-effect of
  proxying**, not as a billable lever. DERIVED-FROM-DATA.
- **Likely not billed at all.** The `tools` field is a *structured* API field:
  Anthropic/OpenAI re-render tool definitions into their own system-prompt
  representation before the model sees them, so the JSON whitespace the client
  submits is almost certainly not what the provider tokenises. The info-theory
  review already flagged this ("verified per-provider that decoded-JSON
  re-tokenisation makes it token-neutral-or-better"). If true, the minifier's
  whitespace-lossless line bills for tokens the provider never charged — an
  honesty risk. DERIVED (needs the free count_tokens check in §5).

**Net lossless A2 value on the `tools` array ≈ 0 billable tokens.** MEASURED/DERIVED.

---

## 2. The ONE genuinely clean lossless slice — JSON-as-verbatim-string

The exception to §1: JSON that appears as a **string inside message `content`**
(a tool_result serialised to text, or an API response/log pasted into a prompt)
*is* read by the model verbatim, so its whitespace **is** billed, and compacting
it is strictly lossless.

243 tool_result payloads, treated as embedded JSON strings:

| app serialised the string as… | lossless saving by compacting |
|---|---|
| pretty-printed (indent=2) | **30.9%** MEASURED |
| `json.dumps` default separators | **16.5%** MEASURED |
| already compact | 0.0% |

**But prevalence is the catch.** Scanning every string in the real wire captures
(litellm 72-message multi-turn + frameworks), **0 embedded-JSON strings** were
found — real agent/chat content was prose and structured blocks, not pasted JSON
blobs. MEASURED. So this slice is real and unconditionally billable *when it
occurs*, but its occurrence is a property of the specific app, not of traffic in
general. CLEAR VALUE = 15–30% of the bytes of any pretty-printed-JSON string
content, conditional on the app producing such content.

---

## 3. The format-swap slice (JSON→TOON/CSV) — LOSSY and net-negative on average

On the 243 real tool_result payloads, compact JSON → TOON-like tabular:

| subset | n | compact JSON | TOON-like | saving |
|---|---|---|---|---|
| ALL payloads | 243 | 28,596 | 28,913 | **−1.1%** (TOON *bigger*) MEASURED |
| WITH a uniform object-array | 72 (30%) | 11,195 | 9,997 | **+10.7%** MEASURED |
| WITHOUT (single/nested dict) | 171 (70%) | 17,401 | 18,916 | **−8.7%** MEASURED |

Per-payload distribution: p10 −14.1%, p50 −5.0%, p90 +14.8% (negative = TOON
larger). MEASURED.

Best case, a 50-row synthetic uniform array: compact JSON 1,602 →
TOON 1,014 (−36.7%) / CSV 910 (−43.2%). MEASURED — this is the sweet spot and
it is the only place the 30–60% literature number shows up.

Reading: **format-swap only wins on uniform object-arrays** (lists of records
with identical keys), which are exactly **30% of real tool results** (72/243,
MEASURED). On the other 70% it makes the payload *larger* because per-record key
repetition — the thing tabular formats eliminate — is not present to eliminate.
And the whole slice is LOSSY: model accuracy moves with input format
(TOON/"Notation Matters"-style benchmarks), so it must pass the replay gate.

---

## 4. Clear value, split by workload shape

| workload shape | recoverable | lossless or gated | basis |
|---|---|---|---|
| Tool-schema `tools` array (any agent) | **~0% billable** beyond free compaction | lossless-but-unbillable | MEASURED (0/100 key-drop) + DERIVED (provider re-renders) |
| Message content containing pretty-printed JSON strings | **15–31%** of those strings' tokens | **LOSSLESS, bill now** | MEASURED (n=243); prevalence unknown (0 in captures) |
| Tool results with a uniform object-array (~30% of tool results) | **~11% (TOON) / up to ~40% (CSV)** of that payload | **GATED** (accuracy moves w/ format) | MEASURED |
| Tool results without a uniform array (~70%) | **negative** — do not touch | n/a | MEASURED |
| Verbose chat (WildChat-shape) | ~0% (no JSON, no schemas) | n/a | DERIVED-FROM-DATA |

Blended over a tool-heavy agent workload, the gated tabular slice is roughly
`0.30 × ~11% (TOON)` ≈ **3–4% of tool-result tokens**, or with CSV
`0.30 × ~40%` ≈ **~12% of tool-result tokens** — and tool-result tokens are only
a fraction of total input, so the end-to-end impact is low-single-digit percent,
behind a quality gate. ESTIMATE from the measured subset shares.

---

## 5. Biggest opportunity + the ONE cheapest experiment

**Biggest opportunity:** NOT the tool-schema minifier (measured ~0 billable).
It is a tie between (a) **lossless compaction of pretty-printed JSON string
content** (bill-now, but only on apps that emit it) and (b) the **uniform-array
tool_result → CSV swap behind the gate** (~40% on the 30% of payloads that
qualify). Both are workload-gated; neither is a defensible headline number.

**Cheapest experiment (confirms or kills the whole axis):** one **free**
Anthropic `count_tokens` call (no generation spend) submitting the *same* real
tool catalogue once pretty-printed and once compact.
- If the two counts are **identical** → the provider re-renders the `tools`
  field and JSON whitespace is not billed → the minifier's whitespace-lossless
  claim is worth ~0 and should be **de-claimed from the published number** (an
  honesty fix, per the moat). This is the single most important check.
- If they differ by the whitespace delta → the minifier genuinely saves on the
  wire and the §1 numbers are billable after all.

Second-cheapest: a 20-task replay of the uniform-array tool_result → CSV swap
through the gate in `evals/run-effort-gate.ts` to see whether the ~40% CSV win
survives the task-completion check on the 30% of payloads that qualify.

---

## 6. Honesty flags for the published NUMBERS

1. The minifier's "lossless ~23–39%" line is measured against a **pretty-printed
   baseline real clients never send**; on compact real traffic it is ~0, and on
   the re-rendered `tools` field it may be literally unbillable. **De-claim or
   caveat per §5 before publishing.**
2. Any TOON/CSV "30–60%" number is a **uniform-array best case**; the honest
   blended figure on real mixed tool results is **net-negative to ~11%**, and it
   is **LOSSY** (gated), never lossless.
