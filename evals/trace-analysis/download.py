#!/usr/bin/env python3
"""Sample trajectories from the public swe-bench-submissions S3 bucket.

Systems sampled:
  A) mini-SWE-agent v1.13.3 + claude-sonnet-4-5-20250929 (SWE-bench Verified, bash-only split)
     s3://swe-bench-submissions/bash-only/20250929_mini-v1.13.3_sonnet-4-5-20250929/trajs/
  B) OpenHands + GPT-5 (SWE-bench Verified)
     s3://swe-bench-submissions/verified/20250807_openhands_gpt5/trajs/
"""
import os, re, sys, requests, random

BUCKET = "https://swe-bench-submissions.s3.amazonaws.com"
HERE = os.path.dirname(os.path.abspath(__file__))

def list_keys(prefix):
    keys, token = [], None
    while True:
        url = f"{BUCKET}/?list-type=2&prefix={prefix}&max-keys=1000"
        if token:
            url += f"&continuation-token={requests.utils.quote(token)}"
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        keys += re.findall(r"<Key>(.*?)</Key>", r.text)
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", r.text)
        if not m:
            break
        token = m.group(1)
    return keys

def sample_spread(keys, n):
    """Deterministic spread across the sorted key list (covers repos alphabetically)."""
    keys = sorted(keys)
    if len(keys) <= n:
        return keys
    step = len(keys) / n
    return [keys[int(i * step)] for i in range(n)]

def fetch(keys, outdir):
    os.makedirs(outdir, exist_ok=True)
    got = []
    for k in keys:
        name = k.split("/")[-1]
        path = os.path.join(outdir, name)
        if not os.path.exists(path):
            r = requests.get(f"{BUCKET}/{k}", timeout=120)
            r.raise_for_status()
            with open(path, "wb") as f:
                f.write(r.content)
        got.append((k, path))
        print("ok", k, os.path.getsize(path))
    return got

if __name__ == "__main__":
    n = 20
    mini_prefix = "bash-only/20250929_mini-v1.13.3_sonnet-4-5-20250929/trajs/"
    oh_prefix = "verified/20250807_openhands_gpt5/trajs/"

    mini_keys = [k for k in list_keys(mini_prefix) if k.endswith(".traj.json")]
    oh_keys = [k for k in list_keys(oh_prefix) if k.endswith(".json")]
    print(f"mini total trajs: {len(mini_keys)}; openhands total trajs: {len(oh_keys)}")

    fetch(sample_spread(mini_keys, n), os.path.join(HERE, "raw", "mini_sonnet45"))
    fetch(sample_spread(oh_keys, n), os.path.join(HERE, "raw", "openhands_gpt5"))
