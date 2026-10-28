#!/usr/bin/env python3
"""
A3/A4 prompt-compression probe — sandbox for the prompt-compression axis.

Purpose: quantify, on FLUX's own terms, the three facts that decide whether
any prompt-compression method is viable as a FLUX lever:

  1. COMPRESSION RATIO   — tokens removed (the advertised win).
  2. COMPRESSOR LATENCY  — wall-clock to run the compressor (FLUX budget is
                           ~tens of ms; a second model blows that).
  3. CACHING BUST        — how much of a STABLE prefix the rewrite mutates
                           (any mutation busts the provider prompt cache,
                           FLUX's already-shipped A1 win).

Design notes / honesty:
  * FLUX cannot run a second LLM today. This probe therefore treats LLMLingua-2
    as an OPTIONAL dependency: if `llmlingua` is installed it measures the real
    thing; if not, it still reports token counts and prints exactly why the
    method is REJECT-today for a byte-only proxy. Nothing here is on the
    request hot path — it is a research harness.
  * Every number printed is MEASURED locally (tokens via tiktoken/HF tokenizer,
    latency via time.perf_counter). No author-reported ratios are reproduced.
  * LOSSY: token pruning changes what the model reads. Any ratio here must be
    paired with a replay quality gate before it could ever be billed. This
    harness does NOT prove quality — it only measures cost/latency/cache cost.

Usage:
  python evals/fundamentals/prompt_compression_probe.py            # built-in sample
  python evals/fundamentals/prompt_compression_probe.py --file x.txt
  python evals/fundamentals/prompt_compression_probe.py --hf-dataset <name> --hf-split train --hf-field text --n 20

Install (optional, for real compression numbers):
  pip install llmlingua tiktoken datasets
"""
from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass


SAMPLE_PROMPT = (
    "You are a helpful, harmless, and honest assistant. Please read the "
    "following meeting transcript very carefully and then answer the user's "
    "question about it. The transcript is as follows. Alice: I think we should "
    "ship the caching feature first because it is the single biggest lever we "
    "have identified so far. Bob: I agree, the caching feature is clearly the "
    "biggest lever and we should ship it first. Carol: Yes, caching first, "
    "everyone agrees, let us move on. The deadline is Friday the 13th and the "
    "budget is forty thousand dollars. Please answer concisely.\n"
) * 6  # repeated to create obvious A3 redundancy + a long-ish prompt


def count_tokens(text: str) -> int:
    """Best-effort token count. Prefers tiktoken o200k_base; falls back to a
    whitespace+punct heuristic so the probe runs with zero deps."""
    try:
        import tiktoken

        enc = tiktoken.get_encoding("o200k_base")
        return len(enc.encode(text))
    except Exception:
        # ~1.3 tokens/word rough fallback; clearly labelled below.
        return int(len(text.split()) * 1.3)


@dataclass
class ProbeResult:
    label: str
    orig_tokens: int
    comp_tokens: int
    compressor_ms: float
    prefix_mutated_frac: float  # fraction of a stable prefix's bytes changed
    token_counter: str

    def ratio(self) -> float:
        return self.orig_tokens / max(self.comp_tokens, 1)


def try_llmlingua(text: str, rate: float = 0.33):
    """Run LLMLingua-2-small if available. Returns (compressed_text, ms) or None.

    LLMLingua-2 is the only family member whose pure-inference profile is even
    arguably in FLUX's latency class, so it is the one we probe. It is STILL a
    bundled neural encoder — not a byte-only rewrite — hence REJECT-today.
    """
    try:
        from llmlingua import PromptCompressor
    except Exception:
        return None
    t0 = time.perf_counter()
    pc = PromptCompressor(
        model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
        use_llmlingua2=True,
    )
    out = pc.compress_prompt(text, rate=rate, force_tokens=["\n", ".", "!", "?", ","])
    ms = (time.perf_counter() - t0) * 1000.0
    return out.get("compressed_prompt", ""), ms


def measure(text: str, counter_name: str) -> ProbeResult:
    orig = count_tokens(text)
    ll = try_llmlingua(text)
    if ll is None:
        # No compressor available: report the honest REJECT-today state.
        return ProbeResult(
            label="llmlingua-2 (NOT INSTALLED — byte-only proxy cannot run it)",
            orig_tokens=orig,
            comp_tokens=orig,
            compressor_ms=float("nan"),
            prefix_mutated_frac=0.0,
            token_counter=counter_name,
        )
    compressed, ms = ll
    comp = count_tokens(compressed)
    # Cache-bust proxy: treat the first half of the prompt as a "stable prefix"
    # (system + tools in a real agent) and measure how much of it the rewrite
    # changed. Any >0 means a provider prompt-cache miss on that prefix.
    half = len(text) // 2
    stable_prefix = text[:half]
    mutated = 0.0 if stable_prefix in compressed else 1.0
    return ProbeResult(
        label="llmlingua-2-small (MEASURED)",
        orig_tokens=orig,
        comp_tokens=comp,
        compressor_ms=ms,
        prefix_mutated_frac=mutated,
        token_counter=counter_name,
    )


def load_texts(args) -> list[str]:
    if args.file:
        with open(args.file, "r", encoding="utf-8") as fh:
            return [fh.read()]
    if args.hf_dataset:
        try:
            from datasets import load_dataset
        except Exception:
            print("datasets not installed; `pip install datasets`", file=sys.stderr)
            sys.exit(2)
        ds = load_dataset(args.hf_dataset, split=args.hf_split)
        field = args.hf_field
        return [str(ds[i][field]) for i in range(min(args.n, len(ds)))]
    return [SAMPLE_PROMPT]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", help="read a single prompt from this text file")
    ap.add_argument("--hf-dataset", help="HuggingFace dataset name")
    ap.add_argument("--hf-split", default="train")
    ap.add_argument("--hf-field", default="text")
    ap.add_argument("--n", type=int, default=10, help="num HF rows to probe")
    args = ap.parse_args()

    counter_name = "tiktoken:o200k_base"
    try:
        import tiktoken  # noqa: F401
    except Exception:
        counter_name = "heuristic(words*1.3)"

    texts = load_texts(args)
    print(f"# A3/A4 prompt-compression probe — token counter: {counter_name}")
    print(f"# prompts: {len(texts)}  (all numbers below are MEASURED locally)\n")

    tot_o = tot_c = 0
    lat = []
    busts = 0
    for i, t in enumerate(texts):
        r = measure(t, counter_name)
        tot_o += r.orig_tokens
        tot_c += r.comp_tokens
        if r.compressor_ms == r.compressor_ms:  # not NaN
            lat.append(r.compressor_ms)
        busts += 1 if r.prefix_mutated_frac > 0 else 0
        print(
            f"[{i}] {r.label}\n"
            f"    orig={r.orig_tokens} tok  comp={r.comp_tokens} tok  "
            f"ratio={r.ratio():.2f}x  "
            f"compressor={'%.1f ms' % r.compressor_ms if r.compressor_ms==r.compressor_ms else 'n/a'}  "
            f"stable-prefix-busted={'YES' if r.prefix_mutated_frac>0 else 'no'}"
        )

    print("\n# SUMMARY")
    print(f"  total tokens: {tot_o} -> {tot_c}  (overall {tot_o/max(tot_c,1):.2f}x)")
    if lat:
        lat_sorted = sorted(lat)
        p50 = lat_sorted[len(lat_sorted) // 2]
        print(f"  compressor latency p50: {p50:.1f} ms  (FLUX budget ~tens of ms)")
        print(f"  prompts that busted the stable prefix (A1 cache): {busts}/{len(texts)}")
    else:
        print("  compressor NOT run (llmlingua not installed).")
        print("  => REJECT-today: a byte-only proxy cannot execute this method.")
    print(
        "\n# Reminder: token pruning is LOSSY. These numbers are cost/latency/"
        "cache-cost only. A quality replay gate is REQUIRED before billing.\n"
        "# Any compressor run is a SECOND MODEL, which FLUX does not bundle today."
    )


if __name__ == "__main__":
    main()
