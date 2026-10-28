---
name: flux-stats
description: Show what FLUX has saved on this machine's Claude Code (and other) API traffic, from the local hash-chained ledger. Use when the user runs /flux-stats or asks how much FLUX saved.
argument-hint: "[--json] [--dir <ledger-dir>]"
allowed-tools: Bash(node *)
---

# /flux-stats: what FLUX saved

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/flux-cc.mjs" stats $ARGUMENTS
```

The script uses the real `flux stats` command when it is installed (it checks that the `flux` on PATH is FLUX's,
not another tool such as Flux CD). Otherwise it tallies the ledger spools itself, from `~/.flux/ledger` and
`./flux-ledger`.

Report the output briefly: total requests, spend, saved, the percentage, and the top levers. Keep the script's
own labels:

- A fallback tally says **"local tally, not an invoice"**. Say so. The billable number is the invoice recomputed from
  the spools with the `flux-report` command the script prints; offer to run it.
- Lossy-lever savings without an approved replay gate are listed separately and are never billed.
- A spool marked `chain BROKEN` was edited or truncated. Flag it plainly.
- "No FLUX ledger yet" means FLUX isn't routing traffic. Suggest `/flux`.

Do not round, extrapolate or project these numbers, and do not compare them with any figure that is not in
https://github.com/Harrym1707/Flux/blob/main/docs/NUMBERS.md.
