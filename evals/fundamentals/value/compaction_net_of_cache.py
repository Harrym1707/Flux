"""A4-irrelevance: NET-OF-CACHE value of tool-result compaction.

The crux. FLUX's A1 prefix cache is DONE/shipped. Prefix caching already makes
re-sent old tokens cheap. Compaction removes stale observations from the MIDDLE
of the prefix -> invalidates the cache from that point -> the whole downstream
suffix must be re-written (cache WRITE) on the compaction turn. We simulate the
real Anthropic prefix-cache model faithfully (cache hit = longest common PREFIX)
to find what compaction recovers ON TOP OF caching.

Pricing multipliers (Anthropic, x base input price):
  cache WRITE (5-min) = 1.25 ;  cache READ = 0.10 ;  uncached base = 1.00
Message-granular prefix cache (matches provider behaviour: divergence at msg i
forces re-write of msgs i..end that turn).

Policies compared per trajectory:
  A) no_cache          : every turn bills full prefix at 1.0  (naive agent)
  B) cache_baseline    : shipped A1, append-only, perfect prefix cache
  C) compact_eager     : B + drop each observation the turn after it goes stale
  D) compact_batch2k   : B + drop stale observations only once >=2000 stale toks accrue
Stale = a later identical observation exists, OR a later view of same file path.
"""
import sys, re, random, statistics
import pyarrow.parquet as pq
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
def ntok(s): return len(ENC.encode(s or "", disallowed_special=()))
W, R, B = 1.25, 0.10, 1.00
FILE_HDR = re.compile(r"\[File:\s*([^\s\]]+)")

PARQUET = sys.argv[1] if len(sys.argv) > 1 else "/tmp/nebius_SWE-agent-trajectories.parquet"
SAMPLE = int(sys.argv[2]) if len(sys.argv) > 2 else 300
BATCH = int(sys.argv[3]) if len(sys.argv) > 3 else 2000

t = pq.read_table(PARQUET, columns=["trajectory"])
rows = t.to_pylist()
random.seed(7); random.shuffle(rows); rows = rows[:SAMPLE]

def build(traj):
    """Return list of messages: (kind, tokens, stale_at_or_None) and turn boundaries.
    msg indexes; assistant turns call model with prefix = msgs[:i]."""
    msgs = []
    seen_task = False
    for m in traj:
        role = m.get("role"); txt = m.get("text") or ""; sp = m.get("system_prompt") or ""
        if role == "system": msgs.append(["system", sp or txt])
        elif role == "ai":   msgs.append(["assistant", txt])
        elif role == "user":
            if not seen_task: msgs.append(["task", txt]); seen_task = True
            else: msgs.append(["obs", txt])
    # tokenize
    for mm in msgs: mm.append(ntok(mm[1]))
    # mark stale observations: identical-content repeat OR same-file re-view later
    obs_idx = [i for i, mm in enumerate(msgs) if mm[0] == "obs"]
    # content dedup: an obs is stale if an identical obs occurs LATER
    content_last = {}
    for i in obs_idx: content_last[msgs[i][1].strip()] = i
    file_last = {}
    for i in obs_idx:
        fm = FILE_HDR.search(msgs[i][1])
        if fm: file_last[fm.group(1)] = i
    stale_after = {}  # obs msg index -> the LATER msg index that supersedes it (becomes stale once we pass it)
    for i in obs_idx:
        key = msgs[i][1].strip()
        if content_last.get(key, i) > i:
            stale_after[i] = content_last[key]
        fm = FILE_HDR.search(msgs[i][1])
        if fm and file_last.get(fm.group(1), i) > i:
            j = file_last[fm.group(1)]
            stale_after[i] = min(stale_after.get(i, j), j)
    return msgs, stale_after

def prefix_cache_cost(turn_prefixes):
    """Given the sequence of per-turn prefix token-id lists (message granular:
    list of (msg_uid, tokens)), compute billed cost with provider prefix cache.
    cache = previous turn's prefix; longest common prefix (by msg_uid) -> READ,
    remainder -> WRITE."""
    cost = 0.0
    prev = []
    for pref in turn_prefixes:
        # longest common prefix by uid
        lcp = 0
        for a, b in zip(prev, pref):
            if a[0] == b[0]: lcp += 1
            else: break
        read_toks = sum(x[1] for x in pref[:lcp])
        write_toks = sum(x[1] for x in pref[lcp:])
        cost += R * read_toks + W * write_toks
        prev = pref
    return cost

def simulate(msgs, stale_after, policy, batch=2000):
    """Produce per-turn prefixes under a policy, then cost them."""
    uid = list(range(len(msgs)))  # stable msg uids
    ai_positions = [i for i, mm in enumerate(msgs) if mm[0] == "assistant"]
    turn_prefixes = []
    dropped = set()  # msg indices removed from context
    pending_stale = []  # (idx) that have gone stale but not yet dropped (for batch)
    for turn_no, ai_i in enumerate(ai_positions):
        # determine which earlier obs are now stale (supersessor index < ai_i)
        if policy in ("eager", "batch"):
            newly = [i for i, j in stale_after.items() if j <= ai_i and i < ai_i and i not in dropped]
            if policy == "eager":
                for i in newly: dropped.add(i)
            else:  # batch: accumulate, drop only when threshold exceeded
                pending = [i for i in newly if i not in pending_stale]
                pending_stale.extend(pending)
                mass = sum(msgs[i][2] for i in pending_stale)
                if mass >= batch:
                    for i in pending_stale: dropped.add(i)
                    pending_stale = []
        pref = [(uid[i], msgs[i][2]) for i in range(ai_i) if i not in dropped]
        turn_prefixes.append(pref)
    return turn_prefixes

tot = {k: 0.0 for k in ["no_cache", "cache", "eager", "batch"]}
raw_input = 0
per_traj_net_eager = []
per_traj_net_batch = []
long_traj_net_batch = []  # trajectories with >=20 turns
for r in rows:
    traj = r["trajectory"]
    if not traj: continue
    msgs, stale_after = build(traj)
    ai_positions = [i for i, mm in enumerate(msgs) if mm[0] == "assistant"]
    if not ai_positions: continue
    # no_cache: full prefix at 1.0 each turn
    nc = sum(sum(msgs[i][2] for i in range(ai_i)) for ai_i in ai_positions) * B
    base_pref = simulate(msgs, stale_after, "none")
    c_cache = prefix_cache_cost(base_pref)
    c_eager = prefix_cache_cost(simulate(msgs, stale_after, "eager"))
    c_batch = prefix_cache_cost(simulate(msgs, stale_after, "batch", BATCH))
    tot["no_cache"] += nc; tot["cache"] += c_cache
    tot["eager"] += c_eager; tot["batch"] += c_batch
    raw_input += sum(mm[2] for mm in msgs)
    if c_cache > 0:
        per_traj_net_eager.append(100 * (c_cache - c_eager) / c_cache)
        per_traj_net_batch.append(100 * (c_cache - c_batch) / c_cache)
        if len(ai_positions) >= 20:
            long_traj_net_batch.append(100 * (c_cache - c_batch) / c_cache)

print(f"trajectories: {len(per_traj_net_eager)}  (pricing W={W} R={R} B={B}, batch={BATCH})")
print()
print("POOLED billed-input COST (in base-input-token-equivalents):")
print(f"  no_cache (naive)        : {tot['no_cache']:>14.0f}")
print(f"  cache_baseline (A1 ship): {tot['cache']:>14.0f}   = {100*tot['cache']/tot['no_cache']:.1f}% of no_cache")
print(f"  + compact eager         : {tot['eager']:>14.0f}   net vs cache: {100*(tot['cache']-tot['eager'])/tot['cache']:+.2f}%")
print(f"  + compact batch{BATCH}     : {tot['batch']:>14.0f}   net vs cache: {100*(tot['cache']-tot['batch'])/tot['cache']:+.2f}%")
print()
print("A1 cache alone already recovers: {:.1f}% of the no-cache bill".format(100*(tot['no_cache']-tot['cache'])/tot['no_cache']))
print()
def ps(v):
    v = sorted(v); n = len(v)
    return f"median {v[n//2]:+.2f}%  mean {statistics.mean(v):+.2f}%  p90 {v[int(.9*n)]:+.2f}%  best {v[-1]:+.2f}%  worst {v[0]:+.2f}%"
print("per-trajectory NET savings of compaction OVER cache baseline:")
print("  eager :", ps(per_traj_net_eager))
print("  batch :", ps(per_traj_net_batch))
if long_traj_net_batch:
    print(f"  batch, LONG trajectories (>=20 turns, n={len(long_traj_net_batch)}):", ps(long_traj_net_batch))
