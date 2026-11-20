import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checks, PrDetail, PrRow } from '../types'

// A sidebar of this repo's open PRs, so you stop running `gh pr list` and
// `gh pr view` to see what's waiting. The list sits at the top; the PR picked
// from it shows underneath: branch, checks, review, a few lines of its
// description and the files it changes.

const prs = atom({ plugin: 'pr-pane', key: 'prs' } as const, [])
const selected = atom({ plugin: 'pr-pane', key: 'selected' } as const, 0)
const detail = atom({ plugin: 'pr-pane', key: 'detail' } as const, null)
const problem = atom({ plugin: 'pr-pane', key: 'problem' } as const, '')

const PANE = 'pr-pane'
const POLL_MS = 2 * 60_000
const SIDEBAR_COLUMNS = 56
const LIST_ROWS = 8
const FILE_ROWS = 15
const BODY_LINES = 6

type GhCheck = { status?: string; conclusion?: string; state?: string }
type GhPr = {
  number: number
  title: string
  author?: { login?: string }
  headRefName: string
  isDraft: boolean
  statusCheckRollup?: GhCheck[]
  updatedAt: string
}
type GhPrView = GhPr & {
  baseRefName: string
  url: string
  body: string
  reviewDecision: string
  mergeable: string
  additions: number
  deletions: number
  files?: { path: string; additions: number; deletions: number }[]
}

let isRepo = false
let branch = ''

function checksOf(rollup: GhCheck[] | undefined): Checks {
  if (!rollup || rollup.length === 0) return 'none'
  const states = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (states.some(s => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'fail'
  if (states.some(s => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(s))) return 'pending'
  return 'pass'
}

// A description as a few plain lines: no HTML comments (PR templates), no
// blank runs, no trailing attribution.
function brief(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/🤖 Generated with[^\n]*/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim()
}

async function gh($: EngineInterface, args: string[]): Promise<unknown> {
  const r = await $.process.run(['gh', ...args], { timeoutMs: 30_000 }).catch(() => undefined)
  if (!r) throw new Error('gh did not run')
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`)
  return JSON.parse(r.stdout)
}

async function loadDetail($: EngineInterface, number: number) {
  if (number === 0) return void (await update($, detail, () => null))
  try {
    const p = (await gh($, ['pr', 'view', String(number), '--json',
      'number,title,author,headRefName,baseRefName,url,body,isDraft,statusCheckRollup,' +
      'reviewDecision,mergeable,additions,deletions,files,updatedAt'])) as GhPrView
    // A slower answer for a PR no longer picked is dropped.
    if ((await read($, selected)) !== number) return
    await update($, detail, () => ({
      number: p.number,
      title: p.title,
      author: p.author?.login ?? '',
      branch: p.headRefName,
      base: p.baseRefName,
      url: p.url,
      body: brief(p.body ?? ''),
      isDraft: p.isDraft,
      checks: checksOf(p.statusCheckRollup),
      review: p.reviewDecision ?? '',
      mergeable: p.mergeable ?? '',
      additions: p.additions,
      deletions: p.deletions,
      files: (p.files ?? []).map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      updatedAt: p.updatedAt,
    }))
  } catch (err) {
    await update($, problem, () => `#${number}: ${(err as Error).message}`)
  }
}

async function select($: EngineInterface, number: number) {
  await update($, selected, () => number)
  await update($, detail, d => (d?.number === number ? d : null))
  await loadDetail($, number)
}

async function poll($: EngineInterface): Promise<PrRow[]> {
  let list: GhPr[]
  try {
    list = (await gh($, ['pr', 'list', '--state', 'open', '--limit', '30', '--json',
      'number,title,author,headRefName,isDraft,statusCheckRollup,updatedAt'])) as GhPr[]
  } catch (err) {
    await update($, problem, () => (err as Error).message)
    return read($, prs)
  }
  const rows = list.map(p => ({
    number: p.number,
    title: p.title,
    author: p.author?.login ?? '',
    branch: p.headRefName,
    isDraft: p.isDraft,
    checks: checksOf(p.statusCheckRollup),
    updatedAt: p.updatedAt,
  }))
  await update($, problem, () => '')
  await update($, prs, () => rows)

  // Keep the pick while its PR is open; otherwise the PR for the branch
  // you're on, else the newest.
  const current = await read($, selected)
  const kept = rows.find(r => r.number === current)
  const pick = kept ?? rows.find(r => r.branch === branch) ?? rows[0]
  const shown = await read($, detail)
  if (!pick) await select($, 0)
  else if (pick.number !== current || shown?.updatedAt !== pick.updatedAt) await select($, pick.number)
  return rows
}

async function openPane($: EngineInterface, focus = false) {
  await $.ui.open({ id: PANE, title: 'Pull requests', columns: SIDEBAR_COLUMNS, ...(focus ? { focus: true } : {}) })
}

export const register: Register = (on, options) => {
  const sidebar = options.sidebar !== false

  on('session.start', async ($, e, next) => {
    const inside = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined)
    isRepo = inside?.exitCode === 0
    if (!isRepo) return next(e)
    branch = inside?.stdout.trim() ?? ''

    await $.command.register({ name: 'pr-pane', description: 'Show the open PRs for this repo in a pane' })
    $.clock.every(POLL_MS, () => void poll($))
    $.clock.after(0, async () => {
      const rows = await poll($)
      if (sidebar && rows.length > 0) await openPane($)
    })

    return next(e)
  })

  on('command.run', { command: 'pr-pane' }, async $ => {
    if (!isRepo) return { text: 'Not in a git repository.' }
    const rows = await poll($)
    await openPane($, true)
    const err = await read($, problem)
    return { text: err ? `gh: ${err}` : `${rows.length} open PR(s).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, prs)
    const pick = await read($, selected)
    const d = await read($, detail)
    const err = await read($, problem)
    const isWide = e.props.placement !== 'inline'
    const mark = { pass: '✓', fail: '✗', pending: '…', none: '·' } as const
    const color = { pass: 'green', fail: 'red', pending: 'yellow', none: 'gray' } as const

    const header = (
      <Box>
        <Text bold>{list.length} open </Text>
        <Button key="refresh" plain hotkey="r" onPress={() => void poll($)}>refresh</Button>
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{err ? `gh: ${err}` : 'No open PRs.'}</Text>
        </Box>
      )
    }

    const rows = list.slice(0, isWide ? LIST_ROWS : 4)
    const files = d?.files ?? []
    const fileRows = files.slice(0, isWide ? FILE_ROWS : 5)
    const width = String(Math.max(0, ...fileRows.map(f => f.additions))).length + 1

    return (
      <Box flexDirection="column">
        {header}
        {rows.map(p => (
          <Button key={`pr-${p.number}`} plain onPress={() => void select($, p.number)}>
            <Text color={p.number === pick ? 'cyan' : undefined} bold={p.number === pick}>
              {p.number === pick ? '▸' : ' '}
            </Text>
            <Text color={color[p.checks]}>{mark[p.checks]}</Text>
            <Text bold={p.number === pick}> #{p.number} </Text>
            <Text dimColor={p.number !== pick}>{p.isDraft ? 'draft · ' : ''}{p.title}</Text>
          </Button>
        ))}
        {list.length > rows.length && <Text dimColor>  +{list.length - rows.length} more</Text>}

        {!d && pick > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{err || `Loading #${pick}…`}</Text>
          </Box>
        )}
        {d && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold wrap="truncate">#{d.number} {d.title}</Text>
            <Text dimColor wrap="truncate">
              {d.author} · {d.branch} → {d.base}
            </Text>
            <Box>
              <Text color={color[d.checks]}>{mark[d.checks]} checks </Text>
              <Text color="green">+{d.additions} </Text>
              <Text color="red">−{d.deletions} </Text>
              <Text dimColor>
                {d.review ? `· ${d.review.toLowerCase().replace(/_/g, ' ')} ` : ''}
                {d.isDraft ? '· draft ' : ''}
                {d.mergeable === 'CONFLICTING' ? '· conflicts' : ''}
              </Text>
            </Box>
            {d.body !== '' && (
              <Box marginTop={1}>
                <Text maxLines={isWide ? BODY_LINES : 2}>{d.body}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text bold>Files ({files.length})</Text>
            </Box>
            {fileRows.map(f => (
              <Box key={f.path}>
                <Text color="green">{`+${f.additions}`.padStart(width)} </Text>
                <Text color="red">{`−${f.deletions}`.padEnd(width)} </Text>
                <Text wrap="truncate-start">{f.path}</Text>
              </Box>
            ))}
            {files.length > fileRows.length && <Text dimColor>  +{files.length - fileRows.length} more files</Text>}
            {isWide && (
              <Box marginTop={1}>
                <Link href={d.url} label="Open on GitHub" />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
