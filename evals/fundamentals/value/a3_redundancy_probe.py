#!/usr/bin/env python3
"""A3 redundancy probe. Axis: near-lossless redundancy, CLEAR VALUE.

Measures, on real multi-turn data, redundancy that is INCREMENTAL to the shipped
levers (dedupeRepeatedBlocks within-message + dedupeRepeatedLeadingBlock), and
splits it by WHERE it lands: cacheable prefix (A1 already serves at ~0.1x) vs the
uncached tail (the only region where a dedup is a real net saving).

All token counts: tiktoken o200k_base. Honesty: every printed number is MEASURED
on the named input.
"""
import json, sys, re, difflib
from collections import defaultdict
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
def ntok(s):
    if not s: return 0
    return len(ENC.encode(s, disallowed_special=()))

MIN_BLOCK = 24  # match the shipped lever's minimumBlockTokens

# ---- port of shipped dedupeRepeatedBlocks: within-ONE-text exact dup -----------
def within_text_dup_tokens(text, seen=None, record=True):
    """Tokens dedupeRepeatedBlocks would remove from THIS text given `seen`
    (a set of blocks/lines already seen). Returns (removed_tokens, seen)."""
    if seen is None: seen = set()
    removed = 0
    parts = re.split(r"(\n{2,})", text)
    for i in range(0, len(parts), 2):
        block = parts[i]
        if block.strip() != "" and "```" not in block and ntok(block) >= MIN_BLOCK and block in seen:
            removed += ntok(block); continue
        if record: seen.add(block)
        # line granularity inside surviving block
        if "```" in block or "\n" not in block: continue
        for line in block.split("\n"):
            if line.strip()=="" : continue
            t = ntok(line)
            if t >= MIN_BLOCK and line in seen:
                removed += t
            elif record:
                seen.add(line)
    return removed, seen

def blocks_and_lines(text):
    """Yield (unit_text, tokens) for every dedup-eligible block and line."""
    parts = re.split(r"(\n{2,})", text)
    for i in range(0, len(parts), 2):
        block = parts[i]
        if "```" in block:
            continue
        if block.strip()!="" and ntok(block)>=MIN_BLOCK:
            yield block, ntok(block)
        if "\n" in block:
            for line in block.split("\n"):
                if line.strip()!="" and ntok(line)>=MIN_BLOCK:
                    yield line, ntok(line)

def analyze_conversation(messages):
    """messages: list of {role, content(str)}. Simulates the growing request
    sequence a stateless chat/agent app sends. Returns per-conversation metrics."""
    texts = [m["content"] if isinstance(m["content"], str) else
             "\n".join(b.get("text","") for b in m["content"] if isinstance(b,dict))
             for m in messages]
    toks = [ntok(t) for t in texts]
    total = sum(toks)

    # (A) what the SHIPPED within-message lever catches, summed over messages
    shipped_within = 0
    for t in texts:
        r,_ = within_text_dup_tokens(t)
        shipped_within += r

    # (B) CROSS-message exact-duplicate units (block/line) the shipped per-message
    #     lever MISSES. A unit counts as cross-dup the 2nd+ time it appears in a
    #     LATER message than its first appearance.
    seen_units = {}  # unit -> first message index
    cross_dup_tokens = 0
    cross_dup_prefix = 0   # duplicate lands in cached prefix of the final request
    cross_dup_tail = 0     # duplicate is in the newest (uncached) message
    last_idx = len(texts)-1
    for mi, t in enumerate(texts):
        local_seen = set()
        for unit, tk in blocks_and_lines(t):
            if unit in local_seen:  # within-message dup: shipped lever handles it
                continue
            local_seen.add(unit)
            if unit in seen_units:
                cross_dup_tokens += tk
                # in a growing conversation the LAST message is the only uncached
                # region of the final request; everything earlier is cached prefix
                if mi == last_idx:
                    cross_dup_tail += tk
                else:
                    cross_dup_prefix += tk
            else:
                seen_units[unit] = mi

    # (C) near-identical message pairs (lossy candidate): for each message, best
    #     difflib ratio vs any earlier message of the same role; report token mass
    #     of messages that are >=0.80 similar to an earlier one but NOT identical.
    near_tokens = 0
    near_pairs = 0
    for mi in range(len(texts)):
        best = 0.0
        for mj in range(mi):
            if messages[mj]["role"] != messages[mi]["role"]: continue
            if abs(toks[mi]-toks[mj]) > max(toks[mi],toks[mj])*0.5: continue
            r = difflib.SequenceMatcher(None, texts[mj], texts[mi]).ratio()
            if r > best: best = r
            if best > 0.995: break
        if 0.80 <= best < 0.995:
            near_tokens += toks[mi]; near_pairs += 1
    return {
        "n_messages": len(texts), "total_tokens": total,
        "shipped_within_dup": shipped_within,
        "cross_dup_tokens": cross_dup_tokens,
        "cross_dup_prefix": cross_dup_prefix,
        "cross_dup_tail": cross_dup_tail,
        "near_tokens": near_tokens, "near_pairs": near_pairs,
    }

def agg_and_print(name, convos):
    A = defaultdict(int); n=0; tot=0
    per_conv_cross=[]
    for c in convos:
        m = analyze_conversation(c)
        if m["total_tokens"]==0: continue
        n+=1
        for k in ("total_tokens","shipped_within_dup","cross_dup_tokens",
                  "cross_dup_prefix","cross_dup_tail","near_tokens"):
            A[k]+=m[k]
        A["n_messages"]+=m["n_messages"]; A["near_pairs"]+=m["near_pairs"]
        per_conv_cross.append(m["cross_dup_tokens"]/m["total_tokens"] if m["total_tokens"] else 0)
    T=A["total_tokens"]
    def p(x): return f"{100*x/T:.2f}%" if T else "n/a"
    print(f"\n==== {name}  (n_convos={n}, n_messages={A['n_messages']}, total_tokens={T}) ====")
    print(f"  shipped within-msg exact-dup (already taken)   : {A['shipped_within_dup']:>9}  {p(A['shipped_within_dup'])}")
    print(f"  CROSS-msg exact-dup residual (shipped MISSES)   : {A['cross_dup_tokens']:>9}  {p(A['cross_dup_tokens'])}")
    print(f"     - of which in CACHED prefix (A1 @0.1x)       : {A['cross_dup_prefix']:>9}  {p(A['cross_dup_prefix'])}")
    print(f"     - of which in UNCACHED tail (clean A3 save)  : {A['cross_dup_tail']:>9}  {p(A['cross_dup_tail'])}")
    print(f"  near-identical (0.80-0.995) msg mass [LOSSY]    : {A['near_tokens']:>9}  {p(A['near_tokens'])}  pairs={A['near_pairs']}")
    return A

# ------------------------------- loaders ---------------------------------------
def load_wildchat(path):
    for line in open(path):
        if not line.strip(): continue
        r=json.loads(line)
        yield r["conv"]

def load_litellm(path):
    # each row is a full request body with a growing messages array; take the
    # LONGEST request of each conversation as the representative full transcript
    rows=[json.loads(l) for l in open(path) if l.strip()]
    best={}
    for r in rows:
        b=r.get("body",r); msgs=b.get("messages",[])
        # conversation id ~ first user text prefix
        key = (msgs[0]["content"][0]["text"][:20] if msgs and isinstance(msgs[0]["content"],list) else str(len(msgs)))
        # flatten content
        conv=[]
        for m in msgs:
            c=m["content"]
            if isinstance(c,list):
                c="\n".join(b.get("text","") for b in c if isinstance(b,dict))
            conv.append({"role":m["role"],"content":c})
        if len(conv) > len(best.get(key,[])):
            best[key]=conv
    return list(best.values())

if __name__=="__main__":
    which = sys.argv[1] if len(sys.argv)>1 else "wildchat"
    if which=="wildchat":
        convos=list(load_wildchat("evals/fundamentals/value/wildchat_multiturn.jsonl"))
        agg_and_print("WildChat-1M multi-turn (turn>=3, English)", convos)
    elif which=="litellm":
        convos=load_litellm("evals/wire-captures/litellm-volatility-2026-10-25.jsonl")
        agg_and_print("litellm-volatility (real multi-turn capture)", convos)
