#!/usr/bin/env python3
"""
A2-encoding VALUE harness.

Measures, with tiktoken o200k_base (MEASURED, not chars/4), on REAL tool
schemas and REAL structured tool_result payloads:

  (a) the LOSSLESS slice beyond what the shipped minifier already takes, and
  (b) the FORMAT-SWAP slice (JSON -> compact tabular / TOON-like), which is
      LOSSY for FLUX billing (model reads a different token sequence).

It also audits the shipped minifier's own baseline: the minifier measures its
"lossless savings" against a PRETTY-PRINTED (indent=2) baseline, but real HTTP
clients send compact JSON. We quantify how much of the minifier's headline
lossless number is an artefact of that baseline choice.

Data (pulled to scratchpad, see the .md writeup for provenance):
  - hermes_tools.json / hermes_catalogues.json : 270 real OpenAI-format tool
    schemas in 100 catalogues (NousResearch/hermes-function-calling-v1)
  - xlam.jsonl : 500 real xLAM rows (already-compact custom tool format)
  - payloads.json : 243 real tool_response payloads, 72 with uniform arrays
  - frameworks-2026-10-25.jsonl : local wire captures (4 framework serializers)
"""
import json, re, sys, statistics as st

import tiktoken
ENC = tiktoken.get_encoding("o200k_base")
def tk(s):
    if not isinstance(s, str): s = json.dumps(s, ensure_ascii=False)
    return len(ENC.encode(s))

SCRATCH = "/private/tmp/claude-501/-Users-harrymanley-Documents-Codex-flux/81b3fa90-1f60-4c80-90fb-3710d8e372bd/scratchpad"
FLUX = "/Users/harrymanley/Documents/Codex/flux"

# ---- serializers ----
def j_pretty(x): return json.dumps(x, indent=2, ensure_ascii=False)          # what the minifier uses as BEFORE
def j_std(x):    return json.dumps(x, ensure_ascii=False)                     # python default: ", " and ": " separators
def j_compact(x):return json.dumps(x, separators=(",", ":"), ensure_ascii=False)  # fully compact (JS JSON.stringify default)

PLUMBING = {"$schema","$id","$comment","$defs"}

def norm_key(s): return re.sub(r"[^a-z0-9]","",s.lower())

def minify_lossless(node, path=""):
    """Port of the shipped minifier's LOSSLESS pass: drop plumbing keys and
    redundant titles. Returns pruned structure. (Whitespace handled separately
    via serializer choice.)"""
    if isinstance(node, list):
        return [minify_lossless(v, f"{path}[{i}]") for i,v in enumerate(node)]
    if not isinstance(node, dict):
        return node
    out={}
    for k,v in node.items():
        if k in PLUMBING:
            continue
        if k=="title" and isinstance(v,str):
            leaf = path.split(".")[-1]
            if norm_key(v)==norm_key(leaf):
                continue
        out[k]=minify_lossless(v, f"{path}.{k}")
    return out

# ---- load data ----
def load_hermes_tools():
    try: return json.load(open(f"{SCRATCH}/hermes_tools.json"))
    except: return []
def load_hermes_catalogues():
    try: return json.load(open(f"{SCRATCH}/hermes_catalogues.json"))
    except: return []
def load_xlam():
    rows=[]
    try:
        for line in open(f"{SCRATCH}/xlam.jsonl"):
            line=line.strip()
            if line: rows.append(json.loads(line))
    except: pass
    return rows
def load_payloads():
    try: return json.load(open(f"{SCRATCH}/payloads.json"))
    except: return []
def load_framework_catalogues():
    cats=[]
    try:
        for line in open(f"{FLUX}/evals/wire-captures/frameworks-2026-10-25.jsonl"):
            d=json.loads(line); t=d["body"].get("tools")
            if t: cats.append((d["headers"].get("user-agent","?"), t))
    except: pass
    return cats

def pct(a,b): return 0.0 if b==0 else 100.0*a/b

print("="*70)
print("PART 1 — tool schemas: lossless slice & minifier baseline artefact")
print("="*70)

hermes_cats = load_hermes_catalogues()
# Treat each catalogue as a request-body `tools` array (what FLUX rewrites).
rows=[]
for cat in hermes_cats:
    pretty = tk(j_pretty(cat))
    std    = tk(j_std(cat))
    compact= tk(j_compact(cat))
    lossless_struct = minify_lossless(cat)
    # lossless savings available to a FLUX rewrite, over the realistic compact baseline:
    lossless_compact = tk(j_compact(lossless_struct))
    rows.append(dict(pretty=pretty, std=std, compact=compact,
                     lossless_compact=lossless_compact))

def agg(key): return sum(r[key] for r in rows)
P,S,C = agg("pretty"),agg("std"),agg("compact")
LC = agg("lossless_compact")
print(f"catalogues={len(rows)}  tools total tokens (sum over catalogues)")
print(f"  pretty-printed (indent=2)         : {P:>8}  <- minifier's BEFORE baseline")
print(f"  python json.dumps default (', '/': '): {S:>8}  ({pct(P-S,P):.1f}% below pretty)")
print(f"  fully compact (JS JSON.stringify)  : {C:>8}  ({pct(P-C,P):.1f}% below pretty)")
print()
print(f"  MINIFIER headline lossless vs pretty baseline: {P-C:>6} tok  = {pct(P-C,P):.1f}% of pretty")
print(f"    ...of which pure WHITESPACE (pretty->compact, no key drops): {P-C-(C-LC):>5} tok")
print(f"  LOSSLESS slice that SURVIVES a realistic compact baseline:")
print(f"    compact baseline                 : {C:>8}")
print(f"    + drop plumbing/redundant titles : {LC:>8}")
print(f"    key-drop lossless saving          : {C-LC:>6} tok = {pct(C-LC,C):.2f}% of compact baseline")

# how many catalogues even HAVE plumbing/redundant-title savings
nonzero = sum(1 for r in rows if r["compact"]-r["lossless_compact"]>0)
print(f"    catalogues with ANY key-drop saving: {nonzero}/{len(rows)}")

print()
print("Per-catalogue key-drop lossless % of compact (distribution):")
kd=[pct(r["compact"]-r["lossless_compact"], r["compact"]) for r in rows]
kd.sort()
print(f"  min={kd[0]:.2f}  p50={kd[len(kd)//2]:.2f}  p90={kd[int(.9*len(kd))]:.2f}  max={kd[-1]:.2f}  mean={st.mean(kd):.2f}")

print()
print("="*70)
print("PART 2 — framework wire captures: does the client send pretty or compact?")
print("="*70)
for ua, tools in load_framework_catalogues()[:6]:
    print(f"  {ua:32s} pretty={tk(j_pretty(tools)):4d} std={tk(j_std(tools)):4d} compact={tk(j_compact(tools)):4d}")

print()
print("="*70)
print("PART 3 — FORMAT-SWAP slice on tool_result payloads (LOSSY, gated)")
print("="*70)
payloads = load_payloads()

def to_toon(o, indent=0):
    """Minimal TOON-like encoder. Uniform object-arrays -> tabular header+rows.
    This is a *lower bound* proxy for TOON token efficiency and is LOSSY for
    FLUX billing (format change)."""
    pad="  "*indent
    def is_uniform(a):
        return isinstance(a,list) and len(a)>=1 and all(isinstance(x,dict) for x in a) \
            and len({tuple(x.keys()) for x in a})==1
    def scalar(v):
        if v is None: return "null"
        if isinstance(v,bool): return "true" if v else "false"
        return str(v)
    if isinstance(o,dict):
        lines=[]
        for k,v in o.items():
            if is_uniform(v):
                keys=list(v[0].keys())
                lines.append(f"{pad}{k}[{len(v)}]{{{','.join(keys)}}}:")
                for row in v:
                    lines.append(f"{pad}  "+",".join(scalar(row[kk]) for kk in keys))
            elif isinstance(v,(dict,list)):
                lines.append(f"{pad}{k}:")
                lines.append(to_toon(v, indent+1))
            else:
                lines.append(f"{pad}{k}: {scalar(v)}")
        return "\n".join(lines)
    if is_uniform(o):
        keys=list(o[0].keys())
        lines=[f"{pad}[{len(o)}]{{{','.join(keys)}}}:"]
        for row in o: lines.append(f"{pad}  "+",".join(scalar(row[kk]) for kk in keys))
        return "\n".join(lines)
    if isinstance(o,list):
        return "\n".join(f"{pad}- {scalar(v) if not isinstance(v,(dict,list)) else ''}\n"+ (to_toon(v,indent+1) if isinstance(v,(dict,list)) else "") for v in o)
    return pad+str(o)

def find_uniform(o):
    out=[]
    if isinstance(o,list) and len(o)>=2 and all(isinstance(x,dict) for x in o):
        if len({tuple(sorted(x.keys())) for x in o})==1: out.append(len(o))
    if isinstance(o,dict):
        for v in o.values(): out+=find_uniform(v)
    elif isinstance(o,list):
        for v in o: out+=find_uniform(v)
    return out

all_before=0; all_after=0
arr_before=0; arr_after=0
single_before=0; single_after=0
deltas=[]
for p in payloads:
    b=tk(j_compact(p))
    a=tk(to_toon(p))
    all_before+=b; all_after+=a
    deltas.append(pct(b-a,b))
    if find_uniform(p):
        arr_before+=b; arr_after+=a
    else:
        single_before+=b; single_after+=a
print(f"ALL payloads (n={len(payloads)}):  compact JSON={all_before} -> TOON-like={all_after}  = {pct(all_before-all_after,all_before):.1f}% saved")
print(f"  payloads WITH a uniform array (n={sum(1 for p in payloads if find_uniform(p))}): {arr_before} -> {arr_after} = {pct(arr_before-arr_after,arr_before):.1f}% saved")
print(f"  payloads WITHOUT (single/nested dict, n={sum(1 for p in payloads if not find_uniform(p))}): {single_before} -> {single_after} = {pct(single_before-single_after,single_before):.1f}% saved")
deltas.sort()
print(f"  per-payload saving %%: p10={deltas[int(.1*len(deltas))]:.1f} p50={deltas[len(deltas)//2]:.1f} p90={deltas[int(.9*len(deltas))]:.1f} (negative = TOON bigger)")

print()
print("="*70)
print("PART 4 — FORMAT-SWAP on a synthetic UNIFORM array (TOON/CSV sweet spot)")
print("="*70)
uniform=[{"id":1000+i,"sku":f"SKU-{(i*7)%1000}","name":f"Widget {i}",
          "price":round(9.99+i*0.5,2),"inStock":i%3!=0,"qty":(i*13)%97} for i in range(50)]
def to_csv(rows):
    keys=list(rows[0].keys())
    out=[",".join(keys)]
    for r in rows:
        out.append(",".join("" if r[k] is None else ("true" if r[k] is True else "false" if r[k] is False else str(r[k])) for k in keys))
    return "\n".join(out)
ub=tk(j_compact(uniform)); ut=tk(to_toon(uniform)); uc=tk(to_csv(uniform))
print(f"50-row uniform array: compact JSON={ub}  TOON-like={ut} ({pct(ub-ut,ub):.1f}%)  CSV={uc} ({pct(ub-uc,ub):.1f}%)")
print("(This is the BEST CASE and it is LOSSY: accuracy moves with format per TOON/Notation-Matters benchmarks.)")

print()
print("="*70)
print("PART 5 — the ONLY clean lossless A2 slice: whitespace on JSON embedded")
print("          as a STRING in message content (tool_result / pasted JSON).")
print("          Unlike the `tools` array, a string in content is read by the")
print("          model verbatim, so its whitespace IS billed -> minify = lossless.")
print("="*70)
pb=sum(tk(j_pretty(p)) for p in payloads)
ps=sum(tk(j_std(p)) for p in payloads)
pc=sum(tk(j_compact(p)) for p in payloads)
print(f"243 tool-result payloads, if embedded as a JSON string:")
print(f"  pretty(indent=2)={pb}  std(', '/': ')={ps}  compact={pc}")
print(f"  lossless if app pretty-printed : {pct(pb-pc,pb):.1f}% (pretty->compact)")
print(f"  lossless if app used json.dumps default : {pct(ps-pc,ps):.1f}% (std->compact; just separators)")
print(f"  lossless if app already compact : 0.0%")
