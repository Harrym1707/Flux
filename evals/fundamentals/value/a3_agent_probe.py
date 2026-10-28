#!/usr/bin/env python3
"""A3 redundancy on REAL SWE-bench agent trajectories (mini-SWE-agent+Sonnet-4.5,
OpenHands+GPT-5). Focus: tool_result redundancy across turns and the CLEAN,
cache-safe A3 ceiling.

Model of the agent loop (what FLUX actually sees):
  Request k = [system][task][asst1][tool_res1]...[asstK-1][tool_resK-1].
  The prefix up to tool_res(K-2) is byte-identical to request K-1 -> served from
  the provider prefix cache (A1, already shipped). The only UNCACHED new input in
  request k is the newest tool_result (+ the newest assistant msg replayed).

Therefore the ONLY redundancy A3 can remove as a real NET saving without busting
the cache is: a NEWEST tool_result that duplicates (exactly or near) an EARLIER
tool_result already sitting in the cached prefix. FLUX replaces the fresh copy
with a reference marker; the cached prefix is untouched. We measure that mass.

We also report the NAIVE cross-turn dup (ignoring cache) to show the gap, and
what the shipped within-message dedupeRepeatedBlocks already takes.

tiktoken o200k_base. Every number MEASURED on the sampled trajectories.
"""
import json, glob, re, difflib, os
from collections import defaultdict
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
def ntok(s):
    if not s: return 0
    return len(ENC.encode(s, disallowed_special=()))
MIN_BLOCK=24

def flatten(c):
    if isinstance(c,str): return c
    if isinstance(c,list):
        return "\n".join(b.get("text","") for b in c if isinstance(b,dict))
    return str(c)

def mini_msgs(path):
    d=json.load(open(path)); out=[]
    for m in d["messages"]:
        out.append({"role":m["role"],"text":flatten(m.get("content",""))})
    return out

def oh_msgs(path):
    d=json.load(open(path)); out=[]
    for m in d:
        role=m["role"]
        text=flatten(m.get("content") or "")
        if role=="assistant":
            for tc in (m.get("tool_calls") or []):
                text=(text+"\n"+(tc.get("function",{}).get("arguments","") or "")).strip()
        out.append({"role":"tool" if role=="tool" else role,"text":text})
    return out

def tool_results(msgs, system):
    """Return the ordered list of tool_result texts (the observations fed back)."""
    res=[]; first_user=False
    for m in msgs:
        if system=="mini":
            if m["role"]=="user":
                if not first_user:
                    first_user=True  # first user = task, not a tool result
                    continue
                res.append(m["text"])
        else:
            if m["role"]=="tool":
                res.append(m["text"])
    return res

def within_text_dup(text):
    seen=set(); removed=0
    parts=re.split(r"(\n{2,})",text)
    for i in range(0,len(parts),2):
        block=parts[i]
        if block.strip()!="" and "```" not in block and ntok(block)>=MIN_BLOCK and block in seen:
            removed+=ntok(block); continue
        seen.add(block)
        if "```" in block or "\n" not in block: continue
        for line in block.split("\n"):
            if line.strip()=="" : continue
            t=ntok(line)
            if t>=MIN_BLOCK and line in seen: removed+=t
            else: seen.add(line)
    return removed

def analyze(msgs, system):
    trs=tool_results(msgs,system)
    tr_tokens=[ntok(t) for t in trs]
    total_tr=sum(tr_tokens)
    # whole conversation tokens (for context)
    conv_tokens=sum(ntok(m["text"]) for m in msgs)

    # shipped within-message dedup over ALL messages
    shipped=sum(within_text_dup(m["text"]) for m in msgs)

    # exact-duplicate tool_results: a tool_result byte-identical to an earlier one.
    # The EARLIER copy is in the cached prefix; the LATER (fresh) copy is the
    # uncached new input at its turn -> removing the fresh copy is the clean save.
    seen_exact={}
    exact_fresh_tokens=0   # clean A3 save (remove fresh dup, keep cached original)
    exact_pairs=0
    for t,tk in zip(trs,tr_tokens):
        h=t
        if h in seen_exact:
            exact_fresh_tokens+=tk; exact_pairs+=1
        else:
            seen_exact[h]=tk

    # near-identical tool_results (LOSSY): fresh tool_result >=0.85 similar to an
    # earlier one but not identical. Report mass + the DELTA tokens (what a true
    # diff-encode would still have to send) to size the real recoverable part.
    near_fresh_tokens=0; near_pairs=0; near_delta_tokens=0
    prev=[]
    for t,tk in zip(trs,tr_tokens):
        best=0.0; bestj=-1
        for j,p in enumerate(prev):
            if abs(len(p)-len(t))>max(len(p),len(t))*0.4: continue
            r=difflib.SequenceMatcher(None,p,t).quick_ratio()
            if r>best: best=r; bestj=j
        exact = t in seen_exact and prev.count(t)>0
        if bestj>=0 and 0.85<=best<1.0:
            # real ratio
            rr=difflib.SequenceMatcher(None,prev[bestj],t).ratio()
            if 0.85<=rr<0.999:
                near_fresh_tokens+=tk; near_pairs+=1
                # delta = tokens of lines in t not in the matched earlier result
                pset=set(prev[bestj].split("\n"))
                delta="\n".join(l for l in t.split("\n") if l not in pset)
                near_delta_tokens+=ntok(delta)
        prev.append(t)

    return {
        "conv_tokens":conv_tokens, "total_tr":total_tr, "n_tr":len(trs),
        "shipped_within":shipped,
        "exact_fresh":exact_fresh_tokens, "exact_pairs":exact_pairs,
        "near_fresh":near_fresh_tokens, "near_pairs":near_pairs,
        "near_delta":near_delta_tokens,
    }

def run(name, files, system):
    A=defaultdict(int); n=0
    for f in files:
        try:
            msgs = mini_msgs(f) if system=="mini" else oh_msgs(f)
        except Exception as e:
            print("skip",f,e); continue
        m=analyze(msgs,system); n+=1
        for k,v in m.items(): A[k]+=v
    TR=A["total_tr"]; CT=A["conv_tokens"]
    def pt(x): return f"{100*x/TR:.2f}% of tool_result tok" if TR else "n/a"
    def pc(x): return f"{100*x/CT:.2f}% of conv tok" if CT else "n/a"
    print(f"\n==== {name}  (n_traj={n}) ====")
    print(f"  total conversation tokens (all turns, uncached view) : {CT}")
    print(f"  total tool_result tokens                             : {TR}  ({100*TR/CT:.1f}% of conv)")
    print(f"  shipped within-msg exact-dup already taken           : {A['shipped_within']}  {pc(A['shipped_within'])}")
    print(f"  EXACT-dup tool_results, fresh-copy mass [clean A3]    : {A['exact_fresh']}  {pt(A['exact_fresh'])}  {pc(A['exact_fresh'])}  pairs={A['exact_pairs']}")
    print(f"  NEAR-dup tool_results fresh mass (0.85-0.999)[LOSSY]  : {A['near_fresh']}  {pt(A['near_fresh'])}  pairs={A['near_pairs']}")
    print(f"     of which TRUE DELTA still needed (diff-encode)     : {A['near_delta']}  (recoverable = near_fresh - delta = {A['near_fresh']-A['near_delta']})")
    return A

if __name__=="__main__":
    run("mini-SWE-agent v1.13.3 + Sonnet-4.5 (SWE-bench)",
        sorted(glob.glob("evals/fundamentals/value/traj/mini/*.json")), "mini")
    run("OpenHands + GPT-5 (SWE-bench)",
        sorted(glob.glob("evals/fundamentals/value/traj/openhands/*.json")), "oh")
