#!/bin/sh
# MESH installer — downloads the small `mesh` launcher and puts it on your PATH.
# It installs ONE tiny file (~3KB) that fetches and checksum-verifies the runtime
# on first use. It never touches your API key. Read it before you run it:
#   curl -fsSL https://www.mesh-technology.com/install.sh | less
set -eu

BASE="${MESH_BASE_URL:-https://www.mesh-technology.com}"
BIN_DIR="$HOME/.mesh/bin"

printf 'MESH installer\n\n'

# Need Node 22 LTS (the launcher and runtime are Node). Claude Code already uses it.
if ! command -v node >/dev/null 2>&1; then
  printf 'This needs Node.js 22 LTS (which Claude Code uses). Install it from https://nodejs.org and re-run.\n' >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'MESH needs Node.js 22 LTS or newer (the runtime is built for Node 22); you have Node %s. Install Node 22 LTS from https://nodejs.org and re-run.\n' "$NODE_MAJOR" >&2
  exit 1
fi

# Download with whatever is present — curl on macOS/most Linux, wget elsewhere.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  printf 'This needs curl or wget to download the launcher. Install one and re-run.\n' >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
printf 'Downloading mesh… '
if ! fetch "$BASE/mesh" "$BIN_DIR/mesh"; then
  printf 'failed.\nCould not download %s/mesh — check your connection.\n' "$BASE" >&2
  exit 1
fi
chmod +x "$BIN_DIR/mesh"
printf 'done.\n'

# Put ~/.mesh/bin on PATH for next time, in the user's shell profile.
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
if [ "$ON_PATH" -eq 0 ]; then
  case "${SHELL:-}" in
    *fish)
      PROFILE="$HOME/.config/fish/config.fish"
      mkdir -p "$HOME/.config/fish"
      if ! grep -qs '.mesh/bin' "$PROFILE" 2>/dev/null; then
        printf '\n# MESH\nif not contains "$HOME/.mesh/bin" $PATH; set -gx PATH "$HOME/.mesh/bin" $PATH; end\n' >> "$PROFILE"
        printf 'Added ~/.mesh/bin to your PATH in %s.\n' "$PROFILE"
      fi
      ;;
    *)
      PROFILE="$HOME/.profile"
      case "${SHELL:-}" in
        *zsh) PROFILE="$HOME/.zshrc" ;;
        *bash) PROFILE="$HOME/.bashrc" ;;
      esac
      if ! grep -qs '.mesh/bin' "$PROFILE" 2>/dev/null; then
        printf '\n# MESH\nexport PATH="$HOME/.mesh/bin:$PATH"\n' >> "$PROFILE"
        printf 'Added ~/.mesh/bin to your PATH in %s.\n' "$PROFILE"
      fi
      ;;
  esac
fi

printf '\n\342\234\223 mesh is installed. Start it with:\n\n'
if [ "$ON_PATH" -eq 0 ]; then
  printf '    ~/.mesh/bin/mesh start      (or open a new terminal, then: mesh start)\n\n'
else
  printf '    mesh start\n\n'
fi
printf 'That points Claude Code at MESH and runs Theo alongside you. Stop with Ctrl+C.\n'
