#!/usr/bin/env bash
# Validates and tests mods with the Claude Code CLI.
#   scripts/check-mods.sh validate [files...]   claude plugin validate
#   scripts/check-mods.sh test [files...]       claude plugin test
# With files (as pre-commit passes them), only the mods those files are in.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
action="${1:?usage: check-mods.sh validate|test [files...]}"
shift

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found; skipping plugin $action" >&2
  exit 0
fi

mapfile -t mods < <("$root/scripts/mods-for-files.sh" "$@")
status=0
for mod in "${mods[@]}"; do
  case "$action" in
    validate)
      out="$(claude plugin validate "$root/$mod" 2>&1)" || { echo "$out"; status=1; continue; }
      grep -q '✘' <<<"$out" && { echo "$out"; status=1; } || echo "valid: $mod"
      ;;
    test)
      if compgen -G "$root/$mod/tests/*.test.ts*" >/dev/null; then
        if ! out="$(claude plugin test "$root/$mod" 2>&1)"; then
          if grep -q 'hooks modules are turned off' <<<"$out"; then
            # The CLI can't run mods right now (rollout switch); don't block commits on it.
            echo "warning: skipped tests for $mod: $(grep -m1 'turned off' <<<"$out")" >&2
            continue
          fi
          echo "$out"
          status=1
        else
          grep -E '^ *[0-9]+ (pass|fail)' <<<"$out" | tr '\n' ' '
          echo "$mod"
        fi
      else
        echo "no tests: $mod" >&2
        status=1
      fi
      ;;
    *) echo "unknown action: $action" >&2; exit 2 ;;
  esac
done
exit "$status"
