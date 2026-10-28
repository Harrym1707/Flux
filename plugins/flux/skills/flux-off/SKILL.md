---
name: flux-off
description: Switch FLUX off for Claude Code. Removes the FLUX ANTHROPIC_BASE_URL (or restores the one it replaced) and can stop the local proxy. Use when the user runs /flux-off.
argument-hint: "[--user] [--stop]"
allowed-tools: Bash(node *)
disable-model-invocation: true
---

# /flux-off: go direct to the API again

Run, passing the user's arguments through:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/flux-cc.mjs" off $ARGUMENTS
```

- Without `--user` it edits this project's `.claude/settings.local.json`; with `--user`, `~/.claude/settings.json`.
  If FLUX was switched on in both places, both need switching off. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/flux-cc.mjs" status` to check.
- If FLUX replaced an earlier base URL, it is restored. Otherwise the key is removed.
- `--stop` also stops the background proxy. The ledger in `~/.flux/ledger` is kept, so `/flux-stats` still works.

Tell the user to **exit and run `claude` again**, because the base URL is read at startup.
