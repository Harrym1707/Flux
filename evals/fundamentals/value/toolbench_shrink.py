"""A4 on an API-agent workload (ToolBench DFS). 'function' msgs are raw API
tool-results (JSON blobs). Measures observation share, fat-tail, and cache-stable
digest-on-arrival savings (L1 near-lossless JSON normalise; L2 lossy head+tail cap)."""
import sys, re, json, random, statistics
import pyarrow.parquet as pq
import tiktoken
ENC = tiktoken.get_encoding("o200k_base")
def ntok(s): return len(ENC.encode(s or "", disallowed_special=()))
R, W = 0.10, 1.25

def l1(s):
    # near-lossless: if the value is JSON-parseable, re-dump compact (drops
    # insignificant whitespace). Else collapse blank lines / trailing ws.
    try:
        o = json.loads(s)
        return json.dumps(o, separators=(",", ":"), ensure_ascii=False)
    except Exception:
        s = re.sub(r"[ \t]+\n", "\n", s)
        return re.sub(r"\n{3,}", "\n\n", s)

def l2(s, cap):
    toks = ENC.encode(s, disallowed_special=())
    if len(toks) <= cap: return s
    return ENC.decode(toks[:cap*2//3]) + f"\n...[{len(toks)-cap} toks elided]...\n" + ENC.decode(toks[-cap//3:])

PARQUET = sys.argv[1]; SAMPLE = int(sys.argv[2]) if len(sys.argv) > 2 else 762
CAP = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
t = pq.read_table(PARQUET)
rows = t.to_pylist(); random.seed(7); random.shuffle(rows); rows = rows[:SAMPLE]

share = {"system":0,"user":0,"assistant":0,"function":0}
obs_sizes=[]; raw_emit=0; l1_emit=0; l2_emit=0
raw_w=0.0; l1_w=0.0; l2_w=0.0; n_obs=0; n_capped=0; nturns=[]
for r in rows:
    conv = r["conversations"]
    if not conv: continue
    msgs=[(m.get("from"), m.get("value") or "") for m in conv]
    ai_pos=[i for i,(f,_) in enumerate(msgs) if f=="assistant"]
    nturns.append(len(ai_pos))
    for i,(frm,val) in enumerate(msgs):
        k = frm if frm in share else "function"
        share[k]+=ntok(val)
        if frm=="function":
            n_obs+=1
            o1=l1(val); o2=l2(o1,CAP)
            nraw,n1,n2=ntok(val),ntok(o1),ntok(o2)
            obs_sizes.append(nraw)
            if n2<n1: n_capped+=1
            raw_emit+=nraw; l1_emit+=n1; l2_emit+=n2
            rem=sum(1 for p in ai_pos if p>i)
            wgt=W+R*rem
            raw_w+=nraw*wgt; l1_w+=n1*wgt; l2_w+=n2*wgt

tot=sum(share.values())
obs_sizes.sort(); n=len(obs_sizes)
nturns.sort()
print(f"trajectories {len(rows)}  turns median {nturns[len(nturns)//2]} p90 {nturns[int(.9*len(nturns))]}")
print("POOLED emitted shares:", {k:f'{100*v/tot:.1f}%' for k,v in share.items()})
print("function(obs) size tokens: median %d p90 %d p99 %d max %d"%(obs_sizes[n//2],obs_sizes[int(.9*n)],obs_sizes[int(.99*n)],obs_sizes[-1]))
print(f"obs over cap {CAP}: {n_capped} ({100*n_capped/n_obs:.1f}%)")
print()
print("EMITTED obs tokens:  raw %d | L1 -%.1f%% | L2(cap%d) -%.1f%% total (trunc -%.1f%%)"%(
    raw_emit,100*(raw_emit-l1_emit)/raw_emit,CAP,100*(raw_emit-l2_emit)/raw_emit,100*(l1_emit-l2_emit)/raw_emit))
print("NET-OF-CACHE weighted obs cost: L1 net -%.1f%% | L2 net -%.1f%%"%(
    100*(raw_w-l1_w)/raw_w,100*(raw_w-l2_w)/raw_w))
