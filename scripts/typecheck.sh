#!/usr/bin/env bash
# Type-checks mods with TypeScript against the API declarations Claude Code lays
# beside a loaded mod (.claude-plugin/types). Those files are generated per build
# and not committed, so this looks for them in the mod folder, then in any
# ~/.claude/dev-mods copy, or in $CLAUDE_CODE_TYPES_DIR. Skips a mod with none.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mapfile -t mods < <("$root/scripts/mods-for-files.sh" "$@")
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
status=0

for mod in "${mods[@]}"; do
  types=""
  for cand in "${CLAUDE_CODE_TYPES_DIR:-}" "$root/$mod/.claude-plugin/types" \
    $(ls -dt "$HOME"/.claude/dev-mods/*/"$mod"/.claude-plugin/types 2>/dev/null); do
    [ -n "$cand" ] && [ -f "$cand/claude-code/index.d.ts" ] && { types="$cand"; break; }
  done
  if [ -z "$types" ]; then
    echo "no Claude Code types for $mod (load it once); skipping typecheck" >&2
    continue
  fi
  cat >"$tmp/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment",
    "typeRoots": ["$types"]
  },
  "include": ["$types", "$root/$mod/hooks", "$root/$mod/types", "$root/$mod/tests"]
}
JSON
  if npx --yes -p typescript@5 tsc -p "$tmp/tsconfig.json"; then echo "typed: $mod"; else status=1; fi
done
exit "$status"
