#!/usr/bin/env bash
set -euo pipefail
npm_path="$(command -v npm)"
if [[ "$npm_path" == /mnt/c/* ]]; then
  echo "ERROR: This shell is using Windows npm: $npm_path" >&2
  echo "Electron cannot install when npm runs Windows cmd.exe against a WSL (UNC) path." >&2
  echo "" >&2
  echo "Fix (pick one):" >&2
  echo "  1) Install Node inside WSL and put it before Windows on PATH, e.g.:" >&2
  echo "       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash" >&2
  echo "       source \"\$HOME/.nvm/nvm.sh\" && nvm install 20 && nvm use 20" >&2
  echo "  2) Or: sudo apt update && sudo apt install -y nodejs npm" >&2
  echo "  3) Then remove Windows node from PATH in WSL, e.g. in ~/.bashrc:" >&2
  echo "       export PATH=\$(echo \"\$PATH\" | tr ':' '\\n' | grep -v '/mnt/c/Program Files/nodejs' | paste -sd:)" >&2
  echo "" >&2
  echo "Reopen the terminal, run: hash -r && which npm  (should NOT be under /mnt/c/)" >&2
  exit 1
fi
exec npm install "$@"
