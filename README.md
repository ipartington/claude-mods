# claude-mods

Six [Claude Code](https://claude.com/claude-code) mods that remove the routine
I kept doing by hand. Each one comes from an audit of my last 30 Claude Code
sessions. A mod is a plugin of function hooks: it runs inside Claude Code and
can draw a band above the prompt, a pane, a toast or a status line, and can step
into prompts, tool calls and the session's start and end.

| Mod | The habit it removes | What you see | Usage cost |
| --- | --- | --- | --- |
| [`merge-followthrough`](merge-followthrough) | Typing "616 merged" (61 times in 30 sessions), then Claude spending a turn on `git checkout main && git pull` and deleting the branch; `! git pull` by hand at session start | Band of your open PRs with CI ✓ ✗ …; toast when a merge has been pulled; `/prs` | None |
| [`handoff-on-clear`](handoff-on-clear) | "give me a prompt to restart", "I've lost your feedback, can you redisplay" after `/clear` | Toast on save; band `↺ Handoff from last session [Load] [Dismiss]`; `/handoff` | One cached fork per `/clear` (option `summarize`, on by default) |
| [`bg-task-band`](bg-task-band) | "how are we looking", "any updates", "when's the estimated end time?" | Band: `⏳ Wait for cp-22 recap 12m/25m · TASK [drain]`; toast on finish | None |
| [`review-ledger`](review-ledger) | "what's left to do from the review?", updating the H/M/L list by hand | Pane of items by severity (`/review`); toast when an item's PR merges | None |
| [`tts-lite`](tts-lite) | A Stop hook starting a full `claude -p` per reply to speak a summary, which left 200 stray transcripts | Audio only | Short replies none; longer ones one bare Haiku completion |
| [`command-guard`](command-guard) | A "never run X" lesson kept only in memory, which subagents never read; an agent deleting a CNPG primary pod and losing five weeks of data | A refused tool call with the reason; nothing otherwise | None |

## How each one works

**merge-followthrough**: polls `gh pr list --author @me` every 60 s. When a PR
it saw open is merged, it checks out the default branch, `pull --ff-only`s,
deletes the local branch and prunes, as long as the working tree is clean. On
your next prompt it tells Claude what it already did, so Claude doesn't redo it.
Typing `616 merged` runs the same steps at once. At session start it
fast-forwards the default branch if you're on it with no changes.

**handoff-on-clear**: on `session.end` (a `/clear` or an exit) it saves the last
answer, your recent asks, PR numbers and artifact links mentioned, the branch,
and (with `summarize`) a 200-word handoff from one `$.model.fork`, which the API
serves mostly from the prompt cache. It's kept per directory for three days. It
goes to Claude when you press Load, run `/handoff`, or ask something like
"redisplay" or "prompt to restart".

**bg-task-band**: records background `Bash`, `Monitor` and `Agent` calls as they
start, reads each one's output file every 10 s for the last line, and marks it
done from the task notification that arrives when it ends. A `TaskStop` marks it
stopped. Finished tasks stay on the band for 90 s.

**review-ledger**: registers the tool `mcp__review-ledger__items`, which Claude
calls to record findings (`H1`, `M3`, `L2`) and their state: open, in-progress
with a PR number, done, or won't do. It's stored per repository root, so it
survives `/clear` and new sessions. Every 5 minutes it checks in-progress PRs
and marks an item done when its PR merges. A prompt that says "review" or names
an item gets the ledger as context.

**tts-lite**: on `turn.complete` it reads replies of 20 words or fewer out as
they are, and asks Haiku for one sentence about anything longer. It plays them
through Piper and `paplay`, or espeak. It reads the same `CLAUDE_TTS`,
`CLAUDE_TTS_SPEED`, `CLAUDE_TTS_VOICE` and `CLAUDE_TTS_MODEL` variables as the
shell hook it replaces, and stays silent while that hook (`tts-speak.sh`) is
still in `~/.claude/settings.json`, so you never hear double.

**command-guard**: on every `Bash` and `Monitor` call, the main loop's and each
subagent's, it reads `<project root>/.claude/command-guards.json` and refuses
the command when a guard matches, giving Claude the guard's reason. A guard
names a `command` and regexes the rest of that shell segment must match
(`allOf`, and at least one of `anyOf`). The command has to be in command
position (segment start, after a quote, `sudo`, `timeout N` or `ssh host`), so
a commit message that only mentions it passes. No rules file, no effect; the
rules live in each project, not here. Commands you type with `!` are not tool
calls and are never refused.

## Install

Requirements: Claude Code 2.1.288 or later (function-hook mods are early access
and the API moves between releases), plus `git` and an authenticated `gh` for
`merge-followthrough` and `review-ledger`. `tts-lite` needs `paplay` and Piper
or espeak.

Load them for every session by listing the folders in `CLAUDE_CODE_PLUGIN_DIRS`
(colon-separated) in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/code/claude-mods/merge-followthrough:~/code/claude-mods/handoff-on-clear:~/code/claude-mods/bg-task-band:~/code/claude-mods/review-ledger:~/code/claude-mods/tts-lite:~/code/claude-mods/command-guard"
  }
}
```

For one session only:

```sh
claude --plugin-dir ./merge-followthrough --plugin-dir ./bg-task-band
```

Or copy them into a session's hot-reload folder:

```sh
scripts/sync.sh ~/.claude/dev-mods/<session-id>
```

## Layout

```
<mod>/
  .claude-plugin/plugin.json   manifest (name, version, options, state contract)
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           the hooks module
  types/index.d.ts             $.state contract (mods that keep state)
  tests/*.test.ts              claude plugin test
scripts/
  check-mods.sh                validate / test the mods given files touch
  typecheck.sh                 tsc against Claude Code's generated API types
  sync.sh                      copy mods into a load folder
```

## Development

```sh
pip install pre-commit && pre-commit install
claude plugin validate <mod>
claude plugin test <mod>
scripts/typecheck.sh            # all mods
```

The pre-commit hooks run standard hygiene, gitleaks, shellcheck, and for the
mods a commit touches: `claude plugin validate`, a TypeScript check and
`claude plugin test`. The type-check needs the API declarations Claude Code
writes into `.claude-plugin/types/` when it loads a mod. Those are generated per
build, git-ignored, and found automatically in any `~/.claude/dev-mods` copy.
Without them the type-check is skipped with a note.

See [AGENTS.md](AGENTS.md) for the conventions an agent (or a person) should
follow when changing a mod.

## License

[MIT](LICENSE)
