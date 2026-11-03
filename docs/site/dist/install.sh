#!/bin/sh
# FLUX installer — downloads the small `flux` launcher and puts it on your PATH.
# It installs ONE tiny file (~3KB) that fetches and checksum-verifies the runtime
# on first use. It never touches your API key. Read it before you run it:
#   curl -fsSL https://www.fluxtoken.dev/install.sh | less
set -eu

BASE="${FLUX_BASE_URL:-https://www.fluxtoken.dev}"
BIN_DIR="$HOME/.flux/bin"

printf 'FLUX installer\n\n'

# Need Node 22 LTS (the launcher and runtime are Node). Claude Code already uses it.
if ! command -v node >/dev/null 2>&1; then
  printf 'This needs Node.js 22 LTS (which Claude Code uses). Install it from https://nodejs.org and re-run.\n' >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf 'Node %s is too old (and Node 20 is end-of-life). Install Node 22 LTS from https://nodejs.org and re-run.\n' "$NODE_MAJOR" >&2
  exit 1
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'Note: Node 22 LTS is recommended (you have Node %s). Continuing.\n' "$NODE_MAJOR" >&2
fi

mkdir -p "$BIN_DIR"
printf 'Downloading flux… '
if ! curl -fsSL "$BASE/flux" -o "$BIN_DIR/flux"; then
  printf 'failed.\nCould not download %s/flux — check your connection.\n' "$BASE" >&2
  exit 1
fi
chmod +x "$BIN_DIR/flux"
printf 'done.\n'

# Put ~/.flux/bin on PATH for next time, in the user's shell profile.
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
if [ "$ON_PATH" -eq 0 ]; then
  PROFILE="$HOME/.profile"
  case "${SHELL:-}" in
    *zsh) PROFILE="$HOME/.zshrc" ;;
    *bash) PROFILE="$HOME/.bashrc" ;;
  esac
  if ! grep -qs '.flux/bin' "$PROFILE" 2>/dev/null; then
    printf '\n# FLUX\nexport PATH="$HOME/.flux/bin:$PATH"\n' >> "$PROFILE"
    printf 'Added ~/.flux/bin to your PATH in %s.\n' "$PROFILE"
  fi
fi

printf '\n\342\234\223 flux is installed. Start it with:\n\n'
if [ "$ON_PATH" -eq 0 ]; then
  printf '    ~/.flux/bin/flux start      (or open a new terminal, then: flux start)\n\n'
else
  printf '    flux start\n\n'
fi
printf 'That points Claude Code at FLUX and runs Theo alongside you. Stop with Ctrl+C.\n'
