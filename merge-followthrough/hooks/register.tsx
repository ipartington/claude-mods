import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PrRow } from '../types'

// Watches the PRs you authored in this repo. When one merges it does the
// routine Claude used to spend a turn on (checkout main, pull --ff-only,
// delete the merged local branch) and tells Claude on your next prompt.

const prs = atom({ plugin: 'merge-followthrough', key: 'prs' } as const, [])
const merged = atom({ plugin: 'merge-followthrough', key: 'merged' } as const, [])

const POLL_MS = 60_000
const MERGED_PROMPT = /^\s*(#?\d+[\s,]*(and\s+)?)*(merged|megerd|mered|,erged)\b/i

type GhPr = {
  number: number
  title: string
  headRefName: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  mergeable: string
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[]
}

function checksOf(rollup: GhPr['statusCheckRollup']): PrRow['checks'] {
  if (!rollup || rollup.length === 0) return 'none'
  const states = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (states.some(s => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'fail'
  if (states.some(s => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(s))) return 'pending'
  return 'pass'
}

async function git($: EngineInterface, args: string[]) {
  return $.process.run(['git', ...args], { timeoutMs: 60_000 })
}

async function defaultBranch($: EngineInterface): Promise<string> {
  const r = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return r.exitCode === 0 ? r.stdout.trim().replace(/^origin\//, '') : 'main'
}

async function isClean($: EngineInterface): Promise<boolean> {
  const r = await git($, ['status', '--porcelain', '--untracked-files=no'])
  return r.exitCode === 0 && r.stdout.trim() === ''
}

// The routine: fast-forward the default branch, drop the merged branch.
async function followThrough($: EngineInterface, pr: { number: number; branch: string }): Promise<string> {
  const main = await defaultBranch($)
  const parts: string[] = []
  const current = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()

  if (!(await isClean($))) {
    return `#${pr.number} merged. Working tree has uncommitted changes on ${current}, so I left git alone.`
  }
  if (current !== main) {
    const co = await git($, ['checkout', '-q', main])
    if (co.exitCode !== 0) return `#${pr.number} merged. Could not check out ${main}: ${co.stderr.trim().slice(0, 200)}`
    parts.push(`checked out ${main}`)
  }
  const pull = await git($, ['pull', '--ff-only', '-q'])
  if (pull.exitCode !== 0) {
    parts.push(`pull failed: ${pull.stderr.trim().slice(0, 200)}`)
  } else {
    const head = (await git($, ['log', '--oneline', '-1'])).stdout.trim()
    parts.push(`${main} is at ${head}`)
  }
  if (pr.branch && pr.branch !== main) {
    const exists = await git($, ['rev-parse', '--verify', '-q', `refs/heads/${pr.branch}`])
    if (exists.exitCode === 0) {
      // -D is safe here: GitHub says the PR merged, and squash merges defeat -d.
      const del = await git($, ['branch', '-D', pr.branch])
      parts.push(del.exitCode === 0 ? `deleted local branch ${pr.branch}` : `kept ${pr.branch} (${del.stderr.trim()})`)
    }
  }
  await git($, ['fetch', '-q', '--prune'])

  return `#${pr.number} merged: ${parts.join('; ')}.`
}

async function fetchPrs($: EngineInterface): Promise<GhPr[] | undefined> {
  const r = await $.process.run(
    ['gh', 'pr', 'list', '--author', '@me', '--state', 'all', '--limit', '20',
      '--json', 'number,title,headRefName,state,isDraft,mergeable,statusCheckRollup'],
    { timeoutMs: 30_000 },
  ).catch(() => undefined)
  if (!r || r.exitCode !== 0) return undefined
  try {
    return JSON.parse(r.stdout) as GhPr[]
  } catch {
    return undefined
  }
}

// Numbers seen open this session, so a merge is noticed once.
const seenOpen = new Set<number>()
const handled = new Set<number>()
let isRepo = false

async function poll($: EngineInterface) {
  const list = await fetchPrs($)
  if (!list) return
  const open = list.filter(p => p.state === 'OPEN')
  await update($, prs, () =>
    open.map(p => ({
      number: p.number,
      title: p.title,
      branch: p.headRefName,
      state: p.state,
      isDraft: p.isDraft,
      checks: checksOf(p.statusCheckRollup),
      mergeable: p.mergeable,
    })),
  )
  for (const p of list) {
    if (p.state === 'OPEN') seenOpen.add(p.number)
    if (p.state === 'MERGED' && seenOpen.has(p.number) && !handled.has(p.number)) {
      handled.add(p.number)
      const note = await followThrough($, { number: p.number, branch: p.headRefName })
      await update($, merged, list => [...list, { number: p.number, note }])
      $.ui.toast(note, { timeoutMs: 8000 })
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const inside = await git($, ['rev-parse', '--is-inside-work-tree']).catch(() => undefined)
    isRepo = inside?.exitCode === 0
    if (!isRepo) return next(e)

    await $.command.register({ name: 'prs', description: 'Refresh the PR band and pull main if PRs merged' })

    // The hand-typed `! git checkout main; git pull` at the start of a session.
    const main = await defaultBranch($)
    const current = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    if (current === main && (await isClean($))) {
      const before = (await git($, ['rev-parse', 'HEAD'])).stdout.trim()
      const pull = await git($, ['pull', '--ff-only', '-q'])
      const after = (await git($, ['rev-parse', 'HEAD'])).stdout.trim()
      if (pull.exitCode === 0 && before !== after) {
        const count = (await git($, ['rev-list', '--count', `${before}..${after}`])).stdout.trim()
        $.ui.toast(`${main} fast-forwarded ${count} commit(s)`)
      }
    }

    void poll($)
    $.clock.every(POLL_MS, () => void poll($))

    return next(e)
  })

  on('command.run', { command: 'prs' }, async $ => {
    await poll($)
    const open = await read($, prs)
    return { text: open.length === 0 ? 'No open PRs.' : `${open.length} open PR(s); see the band above the prompt.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isRepo) return next(e)
    const context = [...(e.context ?? [])]

    // You typed "616 merged": make sure the routine ran before Claude starts.
    if (e.origin.kind === 'composer' && MERGED_PROMPT.test(e.text)) {
      await poll($)
      const numbers = [...e.text.matchAll(/\d+/g)].map(m => Number(m[0]))
      for (const n of numbers) {
        if (handled.has(n)) continue
        const view = await $.process.run(['gh', 'pr', 'view', String(n), '--json', 'state,headRefName'])
          .catch(() => undefined)
        if (!view || view.exitCode !== 0) continue
        const pr = JSON.parse(view.stdout) as { state: string; headRefName: string }
        if (pr.state !== 'MERGED') continue
        handled.add(n)
        const note = await followThrough($, { number: n, branch: pr.headRefName })
        await update($, merged, list => [...list, { number: n, note }])
      }
      if (numbers.length === 0) {
        // Plain "merged": pull anyway.
        const note = await followThrough($, { number: 0, branch: '' })
        await update($, merged, list => [...list, { number: 0, note: note.replace('#0 merged', 'merged') }])
      }
    }

    const notes = await read($, merged)
    if (notes.length > 0) {
      context.push(
        `[merge-followthrough] Already done, no need to repeat:\n${notes.map(n => `- ${n.note}`).join('\n')}`,
      )
      await update($, merged, () => [])
    }

    return next(context.length > 0 ? { ...e, context } : e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = await read($, prs)
    if (!isRepo || open.length === 0 || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const mark = { pass: '✓', fail: '✗', pending: '…', none: '·' } as const
    const color = { pass: 'green', fail: 'red', pending: 'yellow', none: 'gray' } as const

    return (
      <Box flexDirection="column">
        {open.slice(0, 4).map(p => (
          <Box key={String(p.number)}>
            <Text color={color[p.checks]}>{mark[p.checks]} </Text>
            <Text bold>#{p.number} </Text>
            <Text dimColor wrap="truncate">
              {p.isDraft ? 'draft · ' : ''}
              {p.mergeable === 'CONFLICTING' ? 'conflicts · ' : ''}
              {p.title}
            </Text>
          </Box>
        ))}
        {open.length > 4 && <Text dimColor>+{open.length - 4} more open PRs</Text>}
      </Box>
    )
  })
}
