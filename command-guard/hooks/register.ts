import type { EngineInterface, Register } from 'claude-code'

// command-guard: refuses shell commands a project rules out, from
// `<project root>/.claude/command-guards.json`. Replaces a lesson kept only in
// memory ("never delete a CNPG primary pod"), which subagents never read, with
// a check on every Bash and Monitor call, the main loop's and each subagent's.
// Commands a person types with `!` are not tool calls, so a human can still
// run one deliberately.
//
// Rules file:
//   { "guards": [ { "id": "...", "command": "kubectl",
//                   "allOf": ["regex", ...], "anyOf": ["regex", ...],
//                   "reason": "shown to Claude when it is refused" } ] }
// The command is split into segments on `;`, `|`, `&&`, `||` and newlines. A
// guard fires on a segment where `command` runs in command position (segment
// start, after a quote or `(`, or after sudo/exec/watch/xargs/timeout N/ssh
// host) and the rest of that segment matches every `allOf` pattern and, if
// given, at least one `anyOf` pattern. Prose that only mentions the command
// (a commit message) does not fire.

type Guard = {
  id: string
  command: string
  allOf?: string[]
  anyOf?: string[]
  reason: string
}

const RULES_FILE = '.claude/command-guards.json'
const SEGMENT = /\|\||&&|[;|\n]/
const PREFIX =
  '(?:^\\s*|["\'(`]\\s*|\\b(?:sudo|exec|watch|xargs|timeout\\s+\\S+)\\s+|\\bssh\\s+(?:-\\S+\\s+)*\\S+\\s+)'

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firing(guards: readonly Guard[], command: string): Guard | undefined {
  for (const segment of command.split(SEGMENT)) {
    for (const guard of guards) {
      const at = new RegExp(`${PREFIX}${escape(guard.command)}\\b`).exec(segment)
      if (!at) continue
      const rest = segment.slice(at.index + at[0].length)
      const all = (guard.allOf ?? []).every(p => new RegExp(p).test(rest))
      const any = !guard.anyOf?.length || guard.anyOf.some(p => new RegExp(p).test(rest))
      if (all && any) return guard
    }
  }
  return undefined
}

async function loadGuards($: EngineInterface): Promise<Guard[]> {
  const root = await $.session.root()
  const text = await $.fs.read(`${root}/${RULES_FILE}`).catch(() => '')
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as { guards?: Guard[] }
    return Array.isArray(parsed.guards) ? parsed.guards : []
  } catch {
    $.ui.toast(`command-guard: ${RULES_FILE} is not valid JSON; no guards applied`)
    return []
  }
}

// A guard that fails to load (unreadable root, a bad regex) lets the call run
// and says so, rather than wedging every shell command in the session.
async function check($: EngineInterface, command: string) {
  try {
    const guard = firing(await loadGuards($), command)
    return guard ? { deny: `Blocked by command-guard (${guard.id}): ${guard.reason}` } : undefined
  } catch (err) {
    $.ui.toast(`command-guard: rules not applied (${String(err).slice(0, 80)})`)
    return undefined
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) =>
    (await check($, e.command).catch(() => undefined)) ?? next(e),
  )
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) =>
    (e.command ? await check($, e.command).catch(() => undefined) : undefined) ?? next(e),
  )
}
