#!/usr/bin/env bash
# Copies the mods in this repo into the folder Claude Code loads them from.
#
#   scripts/sync.sh <dest>          e.g. ~/.claude/dev-mods/<session-id>
#
# The repo is the source of truth: edit here, then sync. Engine-generated
# files (.claude-plugin/types, tsconfig.json) in the destination are kept.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:?usage: scripts/sync.sh <destination folder>}"
mkdir -p "$dest"
for mod in "$here"/*/; do
  mod="${mod%/}"
  [ -f "$mod/.claude-plugin/plugin.json" ] || continue
  name="$(basename "$mod")"
  rsync -a --delete \
    --exclude '.claude-plugin/types/' --exclude 'tsconfig.json' --exclude 'node_modules/' \
    "$mod/" "$dest/$name/"
  echo "synced $name -> $dest/$name"
done
