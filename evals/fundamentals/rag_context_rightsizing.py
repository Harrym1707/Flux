#!/usr/bin/env python3
"""
FLUX fundamentals sandbox — axis: rag-context-rightsizing.

Measures the two BLACK-BOX, NO-MODEL levers that survive FLUX's constraints
(see docs/rnd/fundamentals/rag-context-rightsizing.md):

  T1  retrieved-chunk overlap / duplicate de-duplication   (A3, near-lossless)
  T2  top-k tail truncation past retrieval saturation       (A4, lossy, needs gate)

Both operate purely by rewriting the request body (the list of retrieved chunks),
with no model, no logits, no second LLM — exactly what FLUX can do at request time.

This script is self-contained and runs with no network (synthetic fixture that
reproduces real indexer behaviour: fixed chunk size with stride overlap, plus
near-duplicate documents). A hook is provided to point it at a Hugging Face RAG
dataset instead of the fixture; see load_hf_chunks().

Honesty: numbers printed here are MEASURED on whatever chunk set is fed in. On the
synthetic fixture they are derived-from-fixture (the overlap is constructed, so the
dedup number is a demonstration, not a workload claim). Run with --hf to get a
derived-from-data number on real retrieved context.

Token counting: uses tiktoken if available (o200k_base ~ GPT-4o/Claude-ish), else a
whitespace approximation (labelled APPROX in output). No weights, just a tokenizer.
"""
from __future__ import annotations

import argparse
import hashlib
import re
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# token counting (tokenizer only — not a model)
# ---------------------------------------------------------------------------
def _make_counter():
    try:
        import tiktoken  # type: ignore

        enc = tiktoken.get_encoding("o200k_base")
        return (lambda s: len(enc.encode(s))), "o200k_base (MEASURED)"
    except Exception:
        # ~1 token / 0.75 words fallback
        return (lambda s: max(1, round(len(s.split()) / 0.75))), "whitespace (APPROX)"


COUNT, COUNTER_LABEL = _make_counter()


# ---------------------------------------------------------------------------
# a retrieved block = ordered list of chunks (what arrives in the request body)
# ---------------------------------------------------------------------------
@dataclass
class Chunk:
    doc_id: str
    rank: int          # client retriever rank, 0 = most relevant
    text: str
    score: float = 0.0


@dataclass
class Report:
    label: str
    n_chunks: int
    tokens: int
    detail: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# T1 — overlap / duplicate de-duplication  (A3, near-lossless, black-box)
# ---------------------------------------------------------------------------
def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip()).lower()


def _sentences(text: str) -> list[str]:
    # cheap sentence/line split — the unit of overlap in real chunkers
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p for p in (p.strip() for p in parts) if p]


def dedup_block(chunks: list[Chunk]) -> tuple[list[Chunk], dict]:
    """Remove sentence-level spans already seen earlier in the block.

    This models the FLUX byte-rewrite: emit each unique span once, preserving
    first-seen order. Exact-duplicate spans => lossless; this is the near-lossless
    cousin that also catches stride-overlap repeats.
    """
    seen: set[str] = set()
    out: list[Chunk] = []
    dup_spans = 0
    kept_spans = 0
    for c in chunks:
        kept = []
        for sent in _sentences(c.text):
            key = hashlib.md5(_normalize(sent).encode()).hexdigest()
            if key in seen:
                dup_spans += 1
                continue
            seen.add(key)
            kept.append(sent)
            kept_spans += 1
        if kept:
            out.append(Chunk(c.doc_id, c.rank, " ".join(kept), c.score))
    return out, {"dup_spans_removed": dup_spans, "spans_kept": kept_spans}


# ---------------------------------------------------------------------------
# T2 — top-k tail truncation  (A4, lossy, black-box, gate-required)
# ---------------------------------------------------------------------------
def truncate_topk(chunks: list[Chunk], keep: int) -> list[Chunk]:
    """Keep the top `keep` chunks by the client's own rank. No scoring by FLUX."""
    ordered = sorted(chunks, key=lambda c: c.rank)
    return ordered[: max(0, keep)]


def saturation_curve(chunks: list[Chunk], gold_span: str) -> list[dict]:
    """Proxy recall curve: at each top-k, does the gold answer span still appear?

    This is the shape Databricks (arXiv:2411.03538) measured as recall saturation.
    For a single query the 'answer present?' flag flips to True at the rank of the
    gold chunk; the saturation k is that rank+1. Run over many queries to get the
    workload saturation point that sets the T2 truncation threshold.
    """
    ordered = sorted(chunks, key=lambda c: c.rank)
    gnorm = _normalize(gold_span)
    rows = []
    acc_tokens = 0
    present = False
    for k, c in enumerate(ordered, start=1):
        acc_tokens += COUNT(c.text)
        if gnorm and gnorm in _normalize(c.text):
            present = True
        rows.append({"top_k": k, "tokens": acc_tokens, "answer_present": present})
    return rows


def block_tokens(chunks: list[Chunk]) -> int:
    return sum(COUNT(c.text) for c in chunks)


# ---------------------------------------------------------------------------
# fixture: reproduces real indexer behaviour (stride overlap + near-dup docs)
# ---------------------------------------------------------------------------
def build_fixture(chunk_words=120, stride_words=60, n_chunks=12) -> tuple[list[Chunk], str]:
    """One source doc chunked with 50% stride overlap (Databricks 512/256 setting),
    plus a near-duplicate doc contributing repeated chunks and some pure distractors.
    Gold answer lives in the chunk at rank 7 (past NQ's ~13-chunk saturation if the
    client ships 12+)."""
    base_words = [f"w{i:03d}" for i in range(600)]
    gold = "the capital of flux is proxytown established in 2026"
    base_text = " ".join(base_words)
    # insert gold span near the middle of the source
    base_words[300:300] = gold.split()
    base_text = " ".join(base_words)
    toks = base_text.split()

    chunks: list[Chunk] = []
    rank = 0
    start = 0
    while start < len(toks) and len(chunks) < n_chunks - 3:
        window = toks[start : start + chunk_words]
        chunks.append(Chunk("docA", rank, " ".join(window), score=1.0 - rank * 0.05))
        rank += 1
        start += stride_words
    # near-duplicate doc: repeats two of docA's windows verbatim (whole-chunk dup)
    chunks.append(Chunk("docB", rank, chunks[1].text, score=0.4)); rank += 1
    chunks.append(Chunk("docB", rank, chunks[3].text, score=0.35)); rank += 1
    # one genuine distractor
    chunks.append(Chunk("docC", rank, " ".join(f"x{i}" for i in range(chunk_words)), score=0.2))
    return chunks, gold


def load_hf_chunks(dataset: str):
    """Hook for real data. Example:
        pip install datasets
        from datasets import load_dataset
        ds = load_dataset(dataset, split="train")
        # map each row's retrieved passages -> list[Chunk] in retriever order
    Returns (chunks, gold_span). Left as a stub so the sandbox runs offline.
    """
    try:
        from datasets import load_dataset  # type: ignore
    except Exception as e:  # pragma: no cover
        raise SystemExit(f"--hf needs `pip install datasets` ({e})")
    ds = load_dataset(dataset, split="train")
    row = ds[0]
    # Field names vary by dataset; adapt here. Common: row["passages"]["passage_text"].
    passages = row.get("passages") or row.get("ctxs") or row.get("contexts")
    if isinstance(passages, dict):
        texts = passages.get("passage_text") or passages.get("text") or []
    else:
        texts = [p.get("text", str(p)) if isinstance(p, dict) else str(p) for p in passages]
    gold = str(row.get("answer") or (row.get("answers") or [""])[0])
    chunks = [Chunk("hf", i, t) for i, t in enumerate(texts)]
    return chunks, gold


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
def pct(a: int, b: int) -> str:
    return f"{(1 - a / b) * 100:5.1f}%" if b else "  n/a"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hf", metavar="DATASET", help="HF dataset id to load real retrieved chunks")
    ap.add_argument("--keep", type=int, default=6, help="T2: top-k to keep")
    args = ap.parse_args()

    if args.hf:
        chunks, gold = load_hf_chunks(args.hf)
        src = f"HF:{args.hf} (derived-from-DATA)"
    else:
        chunks, gold = build_fixture()
        src = "synthetic fixture (derived-from-FIXTURE — demo, not a workload claim)"

    base_tok = block_tokens(chunks)
    print("=" * 72)
    print("FLUX sandbox — rag-context-rightsizing")
    print(f"token counter : {COUNTER_LABEL}")
    print(f"input block   : {src}")
    print(f"chunks={len(chunks)}  tokens={base_tok}")
    print("=" * 72)

    # T1 — dedup
    deduped, d1 = dedup_block(chunks)
    t1_tok = block_tokens(deduped)
    print("\n[T1] overlap/duplicate de-dup  (A3, near-lossless, black-box, no model)")
    print(f"     spans removed : {d1['dup_spans_removed']}  kept: {d1['spans_kept']}")
    print(f"     tokens        : {base_tok} -> {t1_tok}   saved {pct(t1_tok, base_tok)}  (MEASURED on this block)")
    print("     billing       : exact-dup removal lossless; merged-overlap -> gate")

    # T2 — top-k truncation
    trunc = truncate_topk(chunks, args.keep)
    t2_tok = block_tokens(trunc)
    print(f"\n[T2] top-k tail truncation keep={args.keep}  (A4, lossy, black-box, GATE REQUIRED)")
    print(f"     chunks        : {len(chunks)} -> {len(trunc)}")
    print(f"     tokens        : {base_tok} -> {t2_tok}   saved {pct(t2_tok, base_tok)}  (MEASURED on this block)")

    # T1 + T2 stacked
    both = truncate_topk(dedup_block(chunks)[0], args.keep)
    both_tok = block_tokens(both)
    print(f"\n[T1+T2] stacked              : {base_tok} -> {both_tok}   saved {pct(both_tok, base_tok)}  (MEASURED)")

    # saturation curve — sets the safe T2 threshold + feeds the gate
    print("\n[saturation] proxy recall curve (answer_present flips True at gold rank)")
    print("     top_k  cum_tokens  answer_present")
    sat_k = None
    for row in saturation_curve(chunks, gold):
        flag = "YES" if row["answer_present"] else "no"
        if row["answer_present"] and sat_k is None:
            sat_k = row["top_k"]
        print(f"     {row['top_k']:>5}  {row['tokens']:>10}  {flag}")
    print(f"     -> gold first present at top_k={sat_k}: truncating below this k is UNSAFE (would")
    print(f"        drop the answer). This is exactly what the FLUX replay gate must catch.")
    print("\nTakeaway: T1 saves unconditionally on overlapped/dup blocks; T2 saving is real")
    print("but the gate is load-bearing — the saturation k is workload-specific (Databricks:")
    print("NQ ~13 chunks / 8k tok). Measure it per client before enabling T2.")


if __name__ == "__main__":
    main()
