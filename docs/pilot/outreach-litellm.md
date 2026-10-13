# Draft outreach 1 — LiteLLM proxy operator

**STATUS: DRAFT. Not sent. Sending is the founder's act.**
Audience: a team running the LiteLLM proxy in production, with `/spend/logs`
accumulating. Diagnostic-first; pricing appears only as a postscript.
Personalise the [bracketed] fields before sending.

---

**Subject:** Does your LiteLLM spend log match your provider invoice?

Hi [name],

If you reconcile LiteLLM's spend numbers against your OpenAI or Anthropic
invoice, you have probably seen them drift — cache-read and cache-write tokens
are the usual culprits (e.g. LiteLLM issues #19681, #33772, #34801, where
operators measured proxy-reported spend off by 8.5% to 10x on cache-heavy
traffic before fixes landed).

I built a small tool that takes one `/spend/logs` export and, locally on your
machine (no network calls, nothing uploaded), produces:

- a reconciliation of the log's reported costs against a dated, sourced price
  catalogue — models it can't price are reported as unpriced, never zeroed;
- a per-stream triage of where LLM spend reduction is actually available on
  *your* traffic — and where it isn't: savings your gateway cache or the
  provider's prompt cache already give you are credited to you and explicitly
  excluded;
- when the honest answer is "there's nothing here worth paying anyone for," the
  report says exactly that.

For calibration, our harness numbers (synthetic agent traffic, quality held,
independently re-run): interactive multi-turn agents 26.0–29.4% **(measured)**,
one-shot workloads 45.5% **(measured)**, latency-tolerant traffic routed to
flex/batch tiers 64.3% **(measured, OpenAI-priced)**. Those are segment bands
from a simulated harness, not a promise about your traffic — the entire point
of the tool is that your number comes from your logs, caveats included.

Would you be open to running it on one export? It's a single Node binary, takes
about five minutes, and the output is a JSON report you keep. I'm looking for
2–3 design partners whose real traffic can confirm (or kill) these bands, and
I'll share the full methodology either way.

[sign-off]

P.S. The business model, for transparency: if a pilot goes ahead, FLUX bills
25% of *verified* savings — measured per completed task from provider-reported
usage, recorded in a hash-chained ledger you can recompute yourself, with a
built-in "do_not_charge" verdict when the net is zero or negative. The quote
run is free and local either way.

---

## Claim audit (internal, do not send)

| Claim in letter | Label | Source |
|---|---|---|
| Issues #19681 / #33772 / #34801, 8.5%–10x drift | sourced | github.com/BerriAI/litellm issues, verified 2026-10-13 (all three now closed — phrased as "before fixes landed") |
| 26.0–29.4% interactive | measured | run-agent-ab.ts arm J band at 4e9e774, 38/40 fully good |
| 45.5% one-shot | measured | arm H at 4e9e774 |
| 64.3% async | measured | arm K at 4e9e774; OpenAI-priced only (Anthropic batch rate uncatalogued) — hence "OpenAI-priced" label in letter |
| "no network calls, nothing uploaded" | code-enforced | quote-report.ts pure function; packaged bin makes no fetch |
| 25% of verified savings, do_not_charge | implemented | savings-ledger.ts recomputeInvoice |
| 34.1% sparse-1h band | **omitted deliberately** | simulator-measured only; per-model cacheable minimums not landed — do not use in outreach |
