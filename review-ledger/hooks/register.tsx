import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReviewItem } from '../types'

// A per-repo ledger of review findings (H1, M3, L2...) that survives /clear.
// Claude writes to it through a tool; merged PRs tick items off; a pane and
// /review show it; prompts that name an item get the ledger as context.

const items = atom({ plugin: 'review-ledger', key: 'items' } as const, [])

const PANE = 'review-ledger'
const TOOL = 'items'
const TOOL_ID = `mcp__review-ledger__${TOOL}`
const POLL_MS = 5 * 60_000
const ITEM_REF = /\b[HMLhml]\d{1,2}\b/
const ORDER = { H: 0, M: 1, L: 2 } as Record<string, number>

let repoKey = ''

async function repoRoot($: EngineInterface): Promise<string> {
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : await $.session.cwd()
}

async function save($: EngineInterface, list: ReviewItem[]) {
  const sorted = [...list].sort(
    (a, b) => (ORDER[a.id[0]?.toUpperCase() ?? ''] ?? 9) - (ORDER[b.id[0]?.toUpperCase() ?? ''] ?? 9)
      || Number(a.id.slice(1)) - Number(b.id.slice(1)),
  )
  await update($, items, () => sorted)
  await $.store.set(repoKey, sorted)
}

function summary(list: ReviewItem[], only?: Set<string>): string {
  const rows = list
    .filter(i => !only || only.has(i.id) || i.status === 'open' || i.status === 'in-progress')
    .map(i => `- ${i.id} [${i.status}${i.pr ? ` #${i.pr}` : ''}] ${i.title}${i.note ? ` (${i.note})` : ''}`)
  const done = list.filter(i => i.status === 'done').length
  const wont = list.filter(i => i.status === 'wontdo').length
  return `[review-ledger] Review items for this repo (${done} done, ${wont} won't do, ${list.length - done - wont} left):\n${rows.join('\n')}\n` +
    `Update it with the ${TOOL_ID} tool as items change.`
}

async function checkMerged($: EngineInterface) {
  const list = await read($, items)
  const waiting = list.filter(i => i.status === 'in-progress' && i.pr > 0)
  if (waiting.length === 0) return
  let changed = false
  const next = [...list]
  for (const item of waiting) {
    const r = await $.process.run(['gh', 'pr', 'view', String(item.pr), '--json', 'state']).catch(() => undefined)
    if (!r || r.exitCode !== 0) continue
    const state = (JSON.parse(r.stdout) as { state: string }).state
    if (state === 'MERGED') {
      const at = next.findIndex(i => i.id === item.id)
      next[at] = { ...item, status: 'done' }
      changed = true
      $.ui.toast(`${item.id} done: #${item.pr} merged`)
    }
  }
  if (changed) await save($, next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    repoKey = `ledger:${await repoRoot($)}`
    const saved = ((await $.store.get(repoKey)) as ReviewItem[] | undefined) ?? []
    await update($, items, () => saved)

    await $.command.register({
      name: 'review',
      description: 'Open the review-items pane for this repo',
      argumentHint: '[list]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        'The persistent ledger of code/security review findings for this repo (ids like H1, M3, L2 by severity). ' +
        'Call it with action "upsert" to record findings when you finish a review, and whenever an item\'s state ' +
        'changes: "in-progress" with the PR number once a fix PR is open (it is marked done automatically when that PR merges), ' +
        '"wontdo" with a note when the user declines one, "done" when fixed without a PR. Action "list" returns the ledger.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'upsert', 'remove'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Severity letter and number, e.g. H4' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['open', 'in-progress', 'done', 'wontdo'] },
                pr: { type: 'number' },
                note: { type: 'string' },
              },
              required: ['id'],
            },
          },
        },
        required: ['action'],
      },
    })
    $.clock.every(POLL_MS, () => void checkMerged($))
    void checkMerged($)

    return next(e)
  })

  on('tool.call', { tool: /^mcp__review-ledger__items$/ }, async ($, e) => {
    const input = e as unknown as { action: string; items?: Partial<ReviewItem>[] }
    const list = await read($, items)

    if (input.action === 'upsert' || input.action === 'remove') {
      const byId = new Map(list.map(i => [i.id, i]))
      for (const raw of input.items ?? []) {
        const id = String(raw.id ?? '').toUpperCase()
        if (!id) continue
        if (input.action === 'remove') {
          byId.delete(id)
          continue
        }
        const old = byId.get(id)
        byId.set(id, {
          id,
          title: raw.title ?? old?.title ?? '',
          status: raw.status ?? old?.status ?? 'open',
          pr: raw.pr ?? old?.pr ?? 0,
          note: raw.note ?? old?.note ?? '',
        })
      }
      await save($, [...byId.values()])
    }

    return { result: summary(await read($, items)) }
  })

  on('command.run', { command: 'review' }, async ($, e) => {
    const list = await read($, items)
    if (e.args.trim() === 'list') return { text: list.length ? summary(list) : 'No review items for this repo yet.' }
    await $.ui.open({ id: PANE, title: 'Review items' })
    return { text: `${list.length} review item(s) for this repo.` }
  })

  on('prompt.submit', async ($, e, next) => {
    const list = await read($, items)
    if (list.length === 0 || e.origin.kind !== 'composer') return next(e)
    const named = new Set([...e.text.matchAll(new RegExp(ITEM_REF, 'g'))].map(m => m[0].toUpperCase()))
    if (named.size === 0 && !/\breview\b/i.test(e.text)) return next(e)
    return next({ ...e, context: [...(e.context ?? []), summary(list, named)] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, items)
    const mark = { open: '○', 'in-progress': '◐', done: '●', wontdo: '–' } as const
    const color = { open: 'yellow', 'in-progress': 'cyan', done: 'green', wontdo: 'gray' } as const
    const left = list.filter(i => i.status === 'open' || i.status === 'in-progress').length

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No review items yet. Ask Claude for a review.</Text>}
        {list.length > 0 && <Text bold>{left} left of {list.length}</Text>}
        {list.map(i => (
          <Box key={i.id}>
            <Text color={color[i.status]}>{mark[i.status]} </Text>
            <Text bold>{i.id.padEnd(4)}</Text>
            <Text dimColor={i.status === 'done' || i.status === 'wontdo'} wrap="truncate">
              {i.title}
              {i.pr ? ` #${i.pr}` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
