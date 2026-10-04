#!/usr/bin/env bash
# Prints the mod folders that contain the given files (all mods when none given).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -eq 0 ]; then
  for d in "$root"/*/; do [ -f "$d.claude-plugin/plugin.json" ] && basename "$d"; done
  exit 0
fi
for f in "$@"; do
  top="${f%%/*}"
  [ "$top" != "$f" ] && [ -f "$root/$top/.claude-plugin/plugin.json" ] && echo "$top"
done | sort -u
