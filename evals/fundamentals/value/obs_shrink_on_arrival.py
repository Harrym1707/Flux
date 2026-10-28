"""A4 cache-stable lever: DIGEST-ON-ARRIVAL. Shrink each observation the turn it
is produced, BEFORE it enters the cached prefix. Append-only => never busts the
cache => net-of-cache savings are strictly positive and equal the per-observation
reduction amortized over its remaining re-emissions.

We measure deterministic (reproducible, no LLM) reductions on REAL observations:
  L1 near-lossless (A2/A3): strip ANSI/control, collapse runs of blank lines,
     strip trailing whitespace. Model reads essentially the same info.
  L2 lossy (A4): head+tail truncation of oversized observations to a token CAP
     with an elision marker. Changes what the model sees -> replay gate.
Reported net-of-cache weight uses re-emission multiplicity (remaining turns).
"""
import sys, re, random, statistics
import pyarrow.parquet as pq
import tiktoken
ENC = tiktoken.get_encoding("o200k_base")
def ntok(s): return len(ENC.encode(s or "", disallowed_special=()))
R = 0.10  # cache-read multiplier (each re-emission after first)
W = 1.25

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
MULTIBLANK = re.compile(r"\n[ \t]*\n(?:[ \t]*\n)+")
TRAILWS = re.compile(r"[ \t]+\n")

def l1(s):
    s = ANSI.sub("", s); s = CTRL.sub("", s)
    s = TRAILWS.sub("\n", s)
    s = MULTIBLANK.sub("\n\n", s)
    return s

def l2(s, cap):
    """head+tail truncation to ~cap tokens (only if bigger)."""
    toks = ENC.encode(s, disallowed_special=())
    if len(toks) <= cap: return s
    head = ENC.decode(toks[: cap * 2 // 3])
    tail = ENC.decode(toks[-cap // 3:])
    return head + f"\n...[{len(toks)-cap} tokens elided by FLUX]...\n" + tail

PARQUET = sys.argv[1] if len(sys.argv) > 1 else "/tmp/nebius_SWE-agent-trajectories.parquet"
SAMPLE = int(sys.argv[2]) if len(sys.argv) > 2 else 300
CAP = int(sys.argv[3]) if len(sys.argv) > 3 else 1500

t = pq.read_table(PARQUET, columns=["trajectory"])
rows = t.to_pylist(); random.seed(7); random.shuffle(rows); rows = rows[:SAMPLE]

# weighted by re-emission: each observation re-emitted on each later assistant turn.
raw_w = 0.0; l1_w = 0.0; l2_w = 0.0  # net-of-cache weighted (write once + read*remaining)
raw_emit = 0; l1_emit = 0; l2_emit = 0
obs_sizes = []
n_capped = 0; n_obs = 0
for r in rows:
    traj = r["trajectory"]
    if not traj: continue
    kinds = []
    for m in traj:
        role = m.get("role")
        kinds.append(("assistant" if role == "ai" else ("system" if role == "system" else "user"), m.get("text") or "", m.get("system_prompt") or ""))
    ai_pos = [i for i, k in enumerate(kinds) if k[0] == "assistant"]
    seen_task = False
    for i, (role, txt, sp) in enumerate(kinds):
        if role != "user": continue
        if not seen_task: seen_task = True; continue  # task msg, skip
        n_obs += 1
        raw = txt
        o1 = l1(raw); o2 = l2(o1, CAP)
        nraw, n1, n2 = ntok(raw), ntok(o1), ntok(o2)
        obs_sizes.append(nraw)
        if n2 < n1: n_capped += 1
        raw_emit += nraw; l1_emit += n1; l2_emit += n2
        remaining = sum(1 for p in ai_pos if p > i)
        # net-of-cache cost weight: write once (W) + read on each remaining turn (R)
        wgt = W + R * remaining
        raw_w += nraw * wgt; l1_w += n1 * wgt; l2_w += n2 * wgt

obs_sizes.sort(); n = len(obs_sizes)
print(f"observations: {n_obs}  (cap={CAP} tokens)")
print("obs size tokens: median %d p90 %d p99 %d max %d" % (obs_sizes[n//2], obs_sizes[int(.9*n)], obs_sizes[int(.99*n)], obs_sizes[-1]))
print(f"observations exceeding cap (truncated by L2): {n_capped} ({100*n_capped/n_obs:.1f}%)")
print()
print("EMITTED observation tokens (unweighted):")
print(f"  raw            {raw_emit:>10d}")
print(f"  L1 near-lossless {l1_emit:>8d}   -{100*(raw_emit-l1_emit)/raw_emit:.1f}%")
print(f"  L2 lossy(cap)  {l2_emit:>10d}   -{100*(raw_emit-l2_emit)/raw_emit:.1f}% total ( -{100*(l1_emit-l2_emit)/raw_emit:.1f}% from truncation)")
print()
print("NET-OF-CACHE weighted observation COST (write once + read*remaining turns):")
print(f"  raw            {raw_w:>12.0f}")
print(f"  L1 near-lossless {l1_w:>10.0f}   net -{100*(raw_w-l1_w)/raw_w:.1f}%")
print(f"  L2 lossy(cap)  {l2_w:>12.0f}   net -{100*(raw_w-l2_w)/raw_w:.1f}%")
print()
print("Note: these reductions are CACHE-STABLE (append-only digest-on-arrival),")
print("so savings are strictly positive, unlike mid-prefix drop-stale compaction.")
