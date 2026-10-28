#!/usr/bin/env python3
"""
A5-output VALUE sandbox (2026-10-28): measure real OUTPUT headroom on a verbose
chat corpus (WildChat-1M) and contrast it with the agent ground-truth already
measured in evals/trace-analysis/swebench-output-distributions.json.

MEASURES (tiktoken o200k_base, CONFIRMED installed):
  - output (assistant) share of a chat's token bill, un-cached chat economics
  - per-assistant-turn output distribution (where the fat turns are)
  - re-emission: fraction of assistant output lines that are verbatim repeats
    of lines already present earlier in the SAME conversation (the only
    context a chat turn has), split code vs prose — the ceiling a
    reference-instead-of-reprint nudge could reach
  - structural-preamble share: assistant turns that open with a boilerplate
    lead-in ("Sure!", "Certainly!", "Of course", "I'd be happy to help", ...)
    — the terse-style / effort dial's most plausible free lunch

This is a MEASUREMENT of this corpus, not a universal truth, and NOT a
counterfactual: it bounds what verbose chat output LOOKS like, it does not prove
how much a lower effort setting would trim (that needs the live gate).

Usage:
  set -a && source ~/.config/flux/hf.env && set +a
  python3 evals/fundamentals/value/wildchat_output_headroom.py --n 2500
"""
import argparse, json, os, sys, time, urllib.request, urllib.parse, statistics, re, ssl
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CTX = ssl.create_default_context()

import tiktoken
ENC = tiktoken.get_encoding("o200k_base")

def ntok(s: str) -> int:
    if not s:
        return 0
    return len(ENC.encode(s, disallowed_special=()))

DS = "allenai/WildChat-1M"
BASE = "https://datasets-server.huggingface.co/rows"

def fetch_rows(offset: int, length: int, token: str):
    q = urllib.parse.urlencode({
        "dataset": DS, "config": "default", "split": "train",
        "offset": offset, "length": length,
    })
    req = urllib.request.Request(BASE + "?" + q,
                                 headers={"Authorization": f"Bearer {token}"})
    last = None
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
                return json.load(r)["rows"]
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 or e.code >= 500:
                wait = min(30, 3 * (2 ** attempt))
                time.sleep(wait)
                continue
            raise
    raise last

PREAMBLE_PATTERNS = [
    r"^\s*sure[!,.]", r"^\s*certainly[!,.]", r"^\s*of course[!,.]",
    r"^\s*absolutely[!,.]", r"^\s*i'd be happy to", r"^\s*i would be happy to",
    r"^\s*i'd be glad to", r"^\s*great question", r"^\s*happy to help",
    r"^\s*no problem[!,.]", r"^\s*here('s| is) ", r"^\s*let me ",
    r"^\s*as an ai", r"^\s*i'm happy to", r"^\s*i am happy to",
]
PREAMBLE_RE = re.compile("|".join(PREAMBLE_PATTERNS), re.IGNORECASE)

CODE_HINT = re.compile(r"[{}();]|^\s{2,}\S|=|<\w|def |class |import |#include|console\.|print\(|return ")

def looks_code(line: str) -> bool:
    return bool(CODE_HINT.search(line))

def analyse_conversation(conv):
    """Return per-turn output metrics for one conversation."""
    seen_lines = set()  # normalized lines from ALL prior turns (user+assistant)
    out_turns = []
    for turn in conv:
        role = turn.get("role")
        content = turn.get("content") or ""
        if role == "assistant":
            toks = ntok(content)
            # re-emission: lines already seen verbatim earlier in the convo
            reemit_code_tok = 0
            reemit_prose_tok = 0
            for raw in content.split("\n"):
                norm = raw.strip()
                if len(norm) < 8:  # ignore trivial/blank lines
                    continue
                if norm in seen_lines:
                    lt = ntok(raw)
                    if looks_code(norm):
                        reemit_code_tok += lt
                    else:
                        reemit_prose_tok += lt
            preamble = bool(PREAMBLE_RE.match(content))
            # estimate preamble token cost: first sentence/line if it matches
            preamble_tok = 0
            if preamble:
                first = content.strip().split("\n")[0]
                first = re.split(r"(?<=[.!?])\s", first, maxsplit=1)[0]
                preamble_tok = ntok(first)
            out_turns.append({
                "out_tok": toks,
                "reemit_code_tok": reemit_code_tok,
                "reemit_prose_tok": reemit_prose_tok,
                "preamble": preamble,
                "preamble_tok": preamble_tok,
            })
        # add this turn's lines to seen AFTER processing (so a turn can't match itself)
        for raw in content.split("\n"):
            norm = raw.strip()
            if len(norm) >= 8:
                seen_lines.add(norm)
    return out_turns

def pctl(xs, p):
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2500)
    ap.add_argument("--lang", default="English")
    ap.add_argument("--stride", type=int, default=377, help="offset stride to spread the sample")
    ap.add_argument("--out", default="evals/fundamentals/value/wildchat_output_headroom.json")
    args = ap.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("HF_TOKEN not set; source ~/.config/flux/hf.env", file=sys.stderr)
        sys.exit(2)

    convos = 0
    turn_out = []          # per-assistant-turn output tokens
    conv_input_tok = 0     # total user tokens (chat "input")
    conv_output_tok = 0    # total assistant tokens (chat "output")
    reemit_code = 0
    reemit_prose = 0
    preamble_turns = 0
    preamble_tok_total = 0
    convo_first_turn_out = []  # single-turn chats: first assistant turn size
    single_turn_convos = 0
    multi_turn_convos = 0

    offset = 0
    batch = 100
    t0 = time.time()
    while convos < args.n:
        try:
            rows = fetch_rows(offset, batch, token)
        except Exception as e:
            print(f"fetch error at offset {offset}: {e}; stopping early", file=sys.stderr)
            break
        if not rows:
            break
        for r in rows:
            row = r["row"]
            if args.lang and row.get("language") != args.lang:
                continue
            conv = row.get("conversation") or []
            if not conv:
                continue
            outs = analyse_conversation(conv)
            if not outs:
                continue
            convos += 1
            n_asst = len(outs)
            if n_asst <= 1:
                single_turn_convos += 1
            else:
                multi_turn_convos += 1
            for i, o in enumerate(outs):
                turn_out.append(o["out_tok"])
                conv_output_tok += o["out_tok"]
                reemit_code += o["reemit_code_tok"]
                reemit_prose += o["reemit_prose_tok"]
                if o["preamble"]:
                    preamble_turns += 1
                    preamble_tok_total += o["preamble_tok"]
                if i == 0:
                    convo_first_turn_out.append(o["out_tok"])
            for turn in conv:
                if turn.get("role") == "user":
                    conv_input_tok += ntok(turn.get("content") or "")
            if convos >= args.n:
                break
        offset += args.stride * batch  # spread across the dataset
        time.sleep(0.6)  # polite pacing to avoid 429
        if time.time() - t0 > 600:
            print("time budget hit; stopping", file=sys.stderr)
            break

    total_turns = len(turn_out)
    total_out = sum(turn_out)
    # turn concentration: share of output in the top 10% of turns
    st = sorted(turn_out, reverse=True)
    top10_n = max(1, total_turns // 10)
    top10_share = sum(st[:top10_n]) / total_out if total_out else 0.0

    result = {
        "note": "Distribution of WildChat-1M (verbose chat) on this sample; tiktoken o200k_base. Not a counterfactual.",
        "dataset": DS,
        "lang_filter": args.lang,
        "convos": convos,
        "single_turn_convos": single_turn_convos,
        "multi_turn_convos": multi_turn_convos,
        "assistant_turns": total_turns,
        "tokens": {
            "user_input_tok": conv_input_tok,
            "assistant_output_tok": conv_output_tok,
            "output_share_of_io": conv_output_tok / (conv_input_tok + conv_output_tok) if (conv_input_tok+conv_output_tok) else 0.0,
        },
        "per_turn_output": {
            "n": total_turns,
            "mean": statistics.mean(turn_out) if turn_out else 0,
            "p10": pctl(turn_out, 10),
            "p50": pctl(turn_out, 50),
            "p90": pctl(turn_out, 90),
            "p99": pctl(turn_out, 99),
            "max": max(turn_out) if turn_out else 0,
            "sum": total_out,
            "top10pct_turns_output_share": top10_share,
        },
        "reemission": {
            "code_reemit_tok": reemit_code,
            "prose_reemit_tok": reemit_prose,
            "code_reemit_frac_of_output": reemit_code / total_out if total_out else 0.0,
            "prose_reemit_frac_of_output": reemit_prose / total_out if total_out else 0.0,
            "total_reemit_frac_of_output": (reemit_code + reemit_prose) / total_out if total_out else 0.0,
        },
        "preamble": {
            "turns_with_preamble": preamble_turns,
            "preamble_turn_frac": preamble_turns / total_turns if total_turns else 0.0,
            "preamble_tok_total": preamble_tok_total,
            "preamble_frac_of_output": preamble_tok_total / total_out if total_out else 0.0,
        },
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result, indent=1))
    print(f"\nsampled {convos} convos, {total_turns} assistant turns, {time.time()-t0:.0f}s", file=sys.stderr)

if __name__ == "__main__":
    main()
