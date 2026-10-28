"""A4-irrelevance: measure stale/irrelevant tool-result bloat on real SWE-agent
trajectories (nebius/SWE-agent-trajectories, 6670 full trajectories).

Measuring stick: tiktoken o200k_base.
Trajectory shape (verified): role=system (framework prompt), role=user mask=False
(msg1 = task issue; later user msgs = TOOL OBSERVATIONS / bash output),
role=ai mask=True (assistant thought + ```command```).

We measure, per trajectory:
  - token shares: system / task / assistant / observation
  - no-cache billed input = sum over assistant turns of cumulative-prefix tokens
    (this is what re-emission actually bills; old observations dominate it)
  - droppable signals on observations (upper bounds, mechanical):
      * exact-duplicate observation content
      * superseded file views (same file path opened again later)
      * re-emission-weighted mass of observations older than the current turn
"""
import sys, json, re, statistics, random
import pyarrow.parquet as pq
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
def ntok(s): return len(ENC.encode(s or "", disallowed_special=()))

PARQUET = sys.argv[1] if len(sys.argv) > 1 else "/tmp/nebius_SWE-agent-trajectories.parquet"
SAMPLE = int(sys.argv[2]) if len(sys.argv) > 2 else 300

t = pq.read_table(PARQUET, columns=["trajectory", "exit_status", "target"])
rows = t.to_pylist()
random.seed(7)
random.shuffle(rows)
rows = rows[:SAMPLE]

# file-view header used by SWE-agent interface
FILE_HDR = re.compile(r"\[File:\s*([^\s\]]+)")
# the assistant action is the fenced block; grab the command's first token/line
def action_key(ai_text):
    m = re.search(r"```(?:bash)?\s*(.+?)```", ai_text or "", re.S)
    if not m: return None
    cmd = m.group(1).strip()
    return cmd

per = []
for r in rows:
    traj = r["trajectory"]
    if not traj: continue
    msgs = []
    for i, m in enumerate(traj):
        role = m.get("role")
        txt = m.get("text") or ""
        sp = m.get("system_prompt") or ""
        if role == "system":
            msgs.append(("system", sp or txt))
        elif role == "ai":
            msgs.append(("assistant", txt))
        elif role == "user":
            # first user msg is the task; rest are observations
            kind = "task" if not any(k == "task" for k, _ in msgs) else "obs"
            msgs.append((kind, txt))
    toks = [(k, ntok(x)) for k, x in msgs]
    share = {"system": 0, "task": 0, "assistant": 0, "obs": 0}
    for k, n in toks: share[k] += n
    total_emit = sum(share.values())

    # no-cache billed input: before each assistant turn, cumulative prefix tokens
    billed = 0
    cum = 0
    obs_billed = 0          # re-emission-weighted observation tokens
    obs_billed_old = 0      # observations that are >=2 turns behind current assistant turn
    turn_idx_of = []
    running = []
    for idx, (k, n) in enumerate(toks):
        running.append((k, n))
        if k == "assistant":
            billed += cum  # prefix seen as input for this turn (excludes this ai msg)
            # attribute prefix to observations
            for (kk, nn) in running[:-1]:
                if kk == "obs":
                    obs_billed += nn
        cum += n
    # re-emission weight: each obs token at position p is re-sent on every later assistant turn
    # compute per-obs multiplicity = number of assistant turns strictly after it
    ai_positions = [i for i, (k, _) in enumerate(toks) if k == "assistant"]
    obs_reemit_tokens = 0
    obs_tokens_first_half = 0
    n_ai = len(ai_positions)
    for i, (k, n) in enumerate(toks):
        if k == "obs":
            later_turns = sum(1 for p in ai_positions if p > i)
            obs_reemit_tokens += n * later_turns

    # droppable signal 1: exact-duplicate observation content
    seen = {}
    dup_tokens = 0
    # droppable signal 2: superseded file views (same path viewed again later)
    file_last = {}
    file_view_tokens = {}  # path -> list of (token count)
    obs_texts = [(x, nt) for (k, x), (kk, nt) in zip(msgs, toks) if k == "obs" for _ in [0]]
    # rebuild obs list aligned
    obs_list = [(msgs[i][1], toks[i][1]) for i in range(len(msgs)) if msgs[i][0] == "obs"]
    content_counts = {}
    for txt, n in obs_list:
        key = txt.strip()
        if key in content_counts:
            dup_tokens += n  # this is a repeat
        content_counts[key] = content_counts.get(key, 0) + 1
    # superseded file views
    path_views = {}
    for txt, n in obs_list:
        m = FILE_HDR.search(txt)
        if m:
            p = m.group(1)
            path_views.setdefault(p, []).append(n)
    superseded_file_tokens = sum(sum(v[:-1]) for v in path_views.values() if len(v) > 1)

    per.append({
        "n_turns": n_ai,
        "total_emit": total_emit,
        "share": share,
        "billed_no_cache": billed,
        "obs_billed_no_cache": obs_billed,
        "obs_reemit_tokens": obs_reemit_tokens,
        "dup_obs_tokens": dup_tokens,
        "superseded_file_tokens": superseded_file_tokens,
        "final_context": sum(n for _, n in toks),
        "target": r.get("target"),
    })

def agg(key, f=lambda x: x):
    vals = [f(p[key]) for p in per]
    return vals

def stats(vals):
    vals = sorted(vals)
    n = len(vals)
    return dict(n=n, mean=round(statistics.mean(vals), 1),
                p50=vals[n // 2], p90=vals[int(.9 * n)], max=vals[-1], sum=sum(vals))

print(f"trajectories analyzed: {len(per)}")
print("n_turns:", stats(agg("n_turns")))
print("final_context tokens:", stats(agg("final_context")))
print()
# token shares (pooled)
tot_sys = sum(p["share"]["system"] for p in per)
tot_task = sum(p["share"]["task"] for p in per)
tot_ai = sum(p["share"]["assistant"] for p in per)
tot_obs = sum(p["share"]["obs"] for p in per)
tot_all = tot_sys + tot_task + tot_ai + tot_obs
print("POOLED EMITTED token shares:")
for k, v in [("system", tot_sys), ("task", tot_task), ("assistant", tot_ai), ("observation", tot_obs)]:
    print(f"  {k:12s} {v:>10d}  {100*v/tot_all:5.1f}%")
print()
# billed input (no cache) and observation share of it
tot_billed = sum(p["billed_no_cache"] for p in per)
tot_obs_billed = sum(p["obs_billed_no_cache"] for p in per)
print("NO-CACHE BILLED INPUT (sum of re-emitted prefixes):")
print(f"  total billed input tokens : {tot_billed:>12d}")
print(f"  of which observations     : {tot_obs_billed:>12d}  ({100*tot_obs_billed/tot_billed:.1f}%)")
print()
# droppable signals as share of billed input
tot_dup = sum(p["dup_obs_tokens"] for p in per)
tot_sup = sum(p["superseded_file_tokens"] for p in per)
tot_obs_emit = tot_obs
print("DROPPABLE SIGNALS (emitted-token basis, observations only):")
print(f"  exact-duplicate obs content : {tot_dup:>10d}  ({100*tot_dup/tot_obs_emit:.1f}% of obs tokens)")
print(f"  superseded file views       : {tot_sup:>10d}  ({100*tot_sup/tot_obs_emit:.1f}% of obs tokens)")
print(f"  (observations = {tot_obs_emit} emitted tokens)")
