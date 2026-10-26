#!/usr/bin/env python3
"""Output-token distribution & output-waste analysis over sampled public agent trajectories.

Systems:
  mini_sonnet45  = mini-SWE-agent v1.13.3 + claude-sonnet-4-5 (SWE-bench Verified bash-only)
  openhands_gpt5 = OpenHands + GPT-5 (SWE-bench Verified)

Token counts: tiktoken o200k_base (approximation for Claude; exact-ish for GPT-5 family).
mini trajectories also carry API-reported usage (extra.response.usage) used as cross-check.
"""
import json, os, re, glob, statistics, difflib
from collections import Counter
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
HERE = os.path.dirname(os.path.abspath(__file__))

def ntok(s):
    if not s:
        return 0
    return len(ENC.encode(s, disallowed_special=()))

def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

def dist(xs):
    if not xs:
        return {}
    return {
        "n": len(xs),
        "mean": round(statistics.mean(xs), 1),
        "p10": round(pct(xs, 10), 1), "p50": round(pct(xs, 50), 1),
        "p90": round(pct(xs, 90), 1), "p99": round(pct(xs, 99), 1),
        "max": max(xs), "sum": sum(xs),
    }

LINENUM_RE = re.compile(r"^\s*\d+[\t|:]\s?")

def norm_line(l):
    return l.strip()

def context_variants(l):
    """Normalized variants of a context line to credit near-verbatim re-emission
    (e.g. agent re-emits code that it previously saw via `cat -n` with line numbers)."""
    out = set()
    s = l.strip()
    if s:
        out.add(s)
        s2 = LINENUM_RE.sub("", l).strip()
        if s2:
            out.add(s2)
    return out

FENCE_RE = re.compile(r"```[a-zA-Z]*\n(.*?)```", re.S)

# ---------------- per-system message extraction ----------------

def mini_turns(path):
    d = json.load(open(path))
    msgs = d["messages"]
    turns = []  # list of dicts: role, text, segments [(kind, text)], usage
    for m in msgs:
        c = m.get("content", "")
        if isinstance(c, list):
            c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
        role = m["role"]
        t = {"role": role, "text": c, "segments": []}
        if role == "assistant":
            code_spans = FENCE_RE.findall(c)
            prose = FENCE_RE.sub("", c)
            t["segments"] = [("prose", prose)] + [("code", cs) for cs in code_spans]
            u = (m.get("extra") or {}).get("response", {}).get("usage")
            if u:
                t["api_completion_tokens"] = u.get("completion_tokens")
                t["api_prompt_tokens"] = u.get("prompt_tokens", 0)
                t["api_cache_read"] = u.get("cache_read_input_tokens") or 0
                t["api_cache_write"] = u.get("cache_creation_input_tokens") or 0
        turns.append(t)
    return turns

def oh_turns(path):
    d = json.load(open(path))
    turns = []
    for m in d:
        role = m["role"]
        c = m.get("content") or []
        if isinstance(c, str):
            text = c
        else:
            text = "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
        t = {"role": "user" if role in ("tool",) else role, "orig_role": role,
             "text": text, "segments": [("prose", text)] if text else []}
        if role == "assistant":
            tc_texts = []
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function", {})
                args = fn.get("arguments", "")
                tc_texts.append(args)
                t.setdefault("tool_calls", []).append(
                    {"name": fn.get("name"), "arguments": args})
                # decode the JSON arguments so embedded \n become real newlines;
                # use decoded string values as the code segment for line matching
                try:
                    decoded = json.loads(args)
                    vals = [v for v in decoded.values() if isinstance(v, str)]
                    t["segments"].append(("code", "\n".join(vals)))
                except Exception:
                    t["segments"].append(("code", args))
            t["text"] = (text + "\n" + "\n".join(tc_texts)).strip()
        turns.append(t)
    return turns

# ---------------- core analysis ----------------

def analyze_traj(turns, system):
    res = {
        "assistant_turn_tokens": [], "api_completion_tokens": [],
        "tool_result_tokens": [], "context_before_turn": [],
        "reemit": [],  # per assistant turn: dict
        "edits": [],
        "duplicate_actions": 0, "n_actions": 0,
        "sys_task_tokens": 0,
    }
    ctx_lines = set()        # normalized lines seen so far in conversation
    ctx_tokens = 0
    first_user_seen = False
    commands_seen = Counter()

    for ti, t in enumerate(turns):
        txt = t["text"]
        tk = ntok(txt)
        if t["role"] in ("system",) or (t["role"] == "user" and not first_user_seen and t.get("orig_role") != "tool"):
            res["sys_task_tokens"] += tk
            if t["role"] == "user":
                first_user_seen = True
        elif t["role"] == "user":
            res["tool_result_tokens"].append(tk)

        if t["role"] == "assistant":
            res["context_before_turn"].append(ctx_tokens)
            res["assistant_turn_tokens"].append(tk)
            if t.get("api_completion_tokens") is not None:
                res["api_completion_tokens"].append(t["api_completion_tokens"])

            # re-emission measurement
            seg_stats = {"total": tk}
            for kind in ("code", "prose"):
                seg_total = seg_re = 0
                for k2, s in t["segments"]:
                    if k2 != kind:
                        continue
                    for line in s.split("\n"):
                        n = norm_line(line)
                        if len(n) < 8:
                            continue
                        lt = ntok(line)
                        seg_total += lt
                        if n in ctx_lines or LINENUM_RE.sub("", line).strip() in ctx_lines:
                            seg_re += lt
                seg_stats[kind + "_line_tokens"] = seg_total
                seg_stats[kind + "_reemit_tokens"] = seg_re
            seg_stats["reemit_frac_of_turn"] = (
                (seg_stats["code_reemit_tokens"] + seg_stats["prose_reemit_tokens"]) / tk
                if tk else 0.0)
            res["reemit"].append(seg_stats)

            # duplicate action detection
            if system == "mini":
                for cs in FENCE_RE.findall(txt):
                    key = cs.strip()
                    res["n_actions"] += 1
                    if commands_seen[key]:
                        res["duplicate_actions"] += 1
                    commands_seen[key] += 1
            else:
                for tc in t.get("tool_calls", []):
                    key = tc["name"] + "|" + tc["arguments"]
                    res["n_actions"] += 1
                    if commands_seen[key]:
                        res["duplicate_actions"] += 1
                    commands_seen[key] += 1

            # edit analysis
            res["edits"] += extract_edits(t, system, ctx_lines)

        # add this message's lines to context AFTER processing the turn
        for line in txt.split("\n"):
            ctx_lines |= context_variants(line)
        for _, s in t["segments"]:
            for line in s.split("\n"):
                ctx_lines |= context_variants(line)
        ctx_tokens += tk

    res["total_conv_tokens"] = ctx_tokens
    return res

HEREDOC_RE = re.compile(r"cat\s*>\s*(\S+)\s*<<\s*'?\"?(\w+)'?\"?\n(.*?)\n\2(\n|$)", re.S)

def extract_edits(t, system, ctx_lines):
    """Returns list of edit records with whole-emission vs changed-lines token estimates."""
    edits = []
    if system == "mini":
        for k2, s in t["segments"]:
            if k2 != "code":
                continue
            for m in HEREDOC_RE.finditer(s):
                target, _, body = m.group(1), m.group(2), m.group(3)
                lines = body.split("\n")
                old = sum(1 for l in lines if norm_line(l) in ctx_lines and len(norm_line(l)) >= 8)
                qual = sum(1 for l in lines if len(norm_line(l)) >= 8)
                body_tok = ntok(body)
                new_tok = sum(ntok(l) for l in lines
                              if len(norm_line(l)) >= 8 and norm_line(l) not in ctx_lines)
                edits.append({
                    "style": "heredoc_whole_file", "target": target,
                    "emitted_tokens": body_tok, "lines": len(lines),
                    "reemitted_line_frac": old / qual if qual else 0.0,
                    "changed_lines_tokens_est": new_tok,
                })
            # sed-style in-place edits count as diff-style
            for sm in re.finditer(r"^sed\s+-i", s, re.M):
                edits.append({"style": "sed_inplace", "emitted_tokens": ntok(s)})
    else:
        for tc in t.get("tool_calls", []):
            if tc["name"] not in ("file_editor", "str_replace_editor"):
                continue
            try:
                a = json.loads(tc["arguments"])
            except Exception:
                continue
            cmd = a.get("command")
            if cmd == "str_replace":
                old_t, new_t = ntok(a.get("old_str", "")), ntok(a.get("new_str", ""))
                edits.append({"style": "str_replace", "emitted_tokens": old_t + new_t,
                              "old_str_tokens": old_t, "new_str_tokens": new_t})
            elif cmd == "create":
                body = a.get("file_text", "")
                lines = body.split("\n")
                qual = [l for l in lines if len(norm_line(l)) >= 8]
                old = sum(1 for l in qual if norm_line(l) in ctx_lines)
                new_tok = sum(ntok(l) for l in qual if norm_line(l) not in ctx_lines)
                edits.append({"style": "create_whole_file", "target": a.get("path"),
                              "emitted_tokens": ntok(body), "lines": len(lines),
                              "reemitted_line_frac": old / len(qual) if qual else 0.0,
                              "changed_lines_tokens_est": new_tok})
            elif cmd == "insert":
                edits.append({"style": "insert", "emitted_tokens": ntok(a.get("new_str", ""))})
    return edits

def run_system(name, pattern, kind):
    files = sorted(glob.glob(pattern))
    per_traj = []
    pooled = {
        "turn_tokens": [], "api_completion": [], "tool_result_tokens": [],
        "reemit_fracs": [], "code_line_tokens": 0, "code_reemit_tokens": 0,
        "prose_line_tokens": 0, "prose_reemit_tokens": 0,
        "assistant_total": 0, "tool_total": 0, "systask_total": 0,
        "context_growth": [], "final_context": [], "billed_input_sum": 0,
        "edits": [], "dup_actions": 0, "n_actions": 0,
        "turn_total_tokens_sum": 0, "reemit_tokens_sum": 0,
    }
    for f in files:
        turns = mini_turns(f) if kind == "mini" else oh_turns(f)
        r = analyze_traj(turns, kind)
        att = r["assistant_turn_tokens"]
        per_traj.append({
            "file": os.path.basename(f),
            "n_assistant_turns": len(att),
            "assistant_tokens": dist(att),
            "tool_result_tokens": dist(r["tool_result_tokens"]),
            "total_conv_tokens": r["total_conv_tokens"],
            "reemit_frac_mean": round(statistics.mean(
                [x["reemit_frac_of_turn"] for x in r["reemit"]]), 3) if r["reemit"] else None,
            "duplicate_actions": r["duplicate_actions"], "n_actions": r["n_actions"],
        })
        pooled["turn_tokens"] += att
        pooled["api_completion"] += r["api_completion_tokens"]
        pooled["tool_result_tokens"] += r["tool_result_tokens"]
        pooled["assistant_total"] += sum(att)
        pooled["tool_total"] += sum(r["tool_result_tokens"])
        pooled["systask_total"] += r["sys_task_tokens"]
        pooled["billed_input_sum"] += sum(r["context_before_turn"])
        if r["context_before_turn"]:
            pooled["final_context"].append(r["total_conv_tokens"])
            steps = r["context_before_turn"]
            pooled["context_growth"] += [steps[i+1] - steps[i] for i in range(len(steps)-1)]
        for x in r["reemit"]:
            pooled["reemit_fracs"].append(x["reemit_frac_of_turn"])
            pooled["code_line_tokens"] += x["code_line_tokens"]
            pooled["code_reemit_tokens"] += x["code_reemit_tokens"]
            pooled["prose_line_tokens"] += x["prose_line_tokens"]
            pooled["prose_reemit_tokens"] += x["prose_reemit_tokens"]
            pooled["turn_total_tokens_sum"] += x["total"]
            pooled["reemit_tokens_sum"] += x["code_reemit_tokens"] + x["prose_reemit_tokens"]
        pooled["edits"] += r["edits"]
        pooled["dup_actions"] += r["duplicate_actions"]
        pooled["n_actions"] += r["n_actions"]

    edits = pooled["edits"]
    styles = Counter(e["style"] for e in edits)
    whole = [e for e in edits if e["style"] in ("heredoc_whole_file", "create_whole_file")
             and e.get("reemitted_line_frac", 0) >= 0.3]
    rewrite_saving = {
        "n_whole_file_emissions_with_30pct_old_lines": len(whole),
        "emitted_tokens_sum": sum(e["emitted_tokens"] for e in whole),
        "changed_lines_tokens_sum": sum(e["changed_lines_tokens_est"] for e in whole),
    }
    sr = [e for e in edits if e["style"] == "str_replace"]
    out = {
        "system": name,
        "n_trajectories": len(files),
        "n_assistant_turns": len(pooled["turn_tokens"]),
        "per_turn_output_tokens_tiktoken": dist(pooled["turn_tokens"]),
        "per_turn_output_tokens_api_reported": dist(pooled["api_completion"]),
        "tool_result_tokens": dist(pooled["tool_result_tokens"]),
        "token_shares": {
            "assistant_output": pooled["assistant_total"],
            "tool_results": pooled["tool_total"],
            "system_plus_task": pooled["systask_total"],
        },
        "reemission": {
            "per_turn_frac": dist(pooled["reemit_fracs"]),
            "pooled_frac_of_all_output_tokens": round(
                pooled["reemit_tokens_sum"] / pooled["turn_total_tokens_sum"], 4)
                if pooled["turn_total_tokens_sum"] else None,
            "code_reemit_frac": round(
                pooled["code_reemit_tokens"] / pooled["code_line_tokens"], 4)
                if pooled["code_line_tokens"] else None,
            "prose_reemit_frac": round(
                pooled["prose_reemit_tokens"] / pooled["prose_line_tokens"], 4)
                if pooled["prose_line_tokens"] else None,
            "code_line_tokens": pooled["code_line_tokens"],
            "prose_line_tokens": pooled["prose_line_tokens"],
        },
        "edits": {
            "style_counts": dict(styles),
            "whole_file_rewrite_vs_diff": rewrite_saving,
            "str_replace_overhead": {
                "n": len(sr),
                "old_str_tokens_sum": sum(e["old_str_tokens"] for e in sr),
                "new_str_tokens_sum": sum(e["new_str_tokens"] for e in sr),
            } if sr else None,
        },
        "input_side": {
            "context_growth_per_step": dist(pooled["context_growth"]),
            "final_context_tokens": dist(pooled["final_context"]),
            "billed_input_sum_no_cache": pooled["billed_input_sum"],
            "duplicate_action_rate": round(pooled["dup_actions"] / pooled["n_actions"], 4)
                if pooled["n_actions"] else None,
            "duplicate_actions": pooled["dup_actions"],
            "n_actions": pooled["n_actions"],
        },
        "per_trajectory": per_traj,
    }
    return out

if __name__ == "__main__":
    results = {
        "note": "Distributions of these specific systems on SWE-bench Verified tasks, not universal truths.",
        "tokenizer": "tiktoken o200k_base",
        "mini_sonnet45": run_system(
            "mini-SWE-agent v1.13.3 + claude-sonnet-4-5 (SWE-bench Verified, bash-only)",
            os.path.join(HERE, "raw", "mini_sonnet45", "*.json"), "mini"),
        "openhands_gpt5": run_system(
            "OpenHands + GPT-5 (SWE-bench Verified)",
            os.path.join(HERE, "raw", "openhands_gpt5", "*.json"), "oh"),
    }
    with open(os.path.join(HERE, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    # console summary
    for k in ("mini_sonnet45", "openhands_gpt5"):
        r = results[k]
        print("=" * 30, r["system"])
        print("trajs", r["n_trajectories"], "assistant turns", r["n_assistant_turns"])
        print("per-turn output (tiktoken):", r["per_turn_output_tokens_tiktoken"])
        print("per-turn output (api):", r["per_turn_output_tokens_api_reported"])
        print("shares:", r["token_shares"])
        print("reemission:", {kk: vv for kk, vv in r["reemission"].items() if kk != "per_turn_frac"})
        print("reemit per-turn frac:", r["reemission"]["per_turn_frac"])
        print("edits:", r["edits"]["style_counts"], r["edits"]["whole_file_rewrite_vs_diff"],
              r["edits"]["str_replace_overhead"])
        print("input side:", r["input_side"]["context_growth_per_step"],
              "final ctx:", r["input_side"]["final_context_tokens"],
              "billed input sum:", r["input_side"]["billed_input_sum_no_cache"],
              "dup rate:", r["input_side"]["duplicate_action_rate"])
