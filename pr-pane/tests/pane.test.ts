import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const PANE = {
  plugin: 'pr-pane',
  component: 'Pane',
  requestId: 'pr-pane',
  props: {
    title: 'Pull requests',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const LIST = [
  { number: 7, title: 'Bump actions/checkout', author: { login: 'renovate' }, headRefName: 'renovate/actions', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }], updatedAt: '1' },
  { number: 9, title: 'Add pr-pane', author: { login: 'ipartington' }, headRefName: 'feat/pr-pane', isDraft: true, statusCheckRollup: [{ status: 'IN_PROGRESS' }], updatedAt: '2' },
]

function view(n: number) {
  const p = LIST.find(x => x.number === n)!
  return {
    ...p,
    baseRefName: 'main',
    url: `https://github.com/ipartington/claude-mods/pull/${n}`,
    body: `<!-- template -->\nWhat #${n} does.\n\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    additions: 12,
    deletions: 3,
    files: [{ path: `pr-pane/file-${n}.ts`, additions: 12, deletions: 3 }],
  }
}

function world(on: Parameters<Register>[0], opts: { branch: string; list?: unknown[] }) {
  const clock = mock.clock(on, { now: 0 })
  const opened: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok(`${opts.branch}\n`)
    if (cmd.startsWith('gh pr list')) return ok(JSON.stringify(opts.list ?? LIST))
    const m = cmd.match(/^gh pr view (\d+)/)
    if (m) return ok(JSON.stringify(view(Number(m[1]))))
    return ok('')
  })
  return { clock, opened }
}

test('opens beside the transcript on the PR for the current branch, with its files and description', async ($, on) => {
  const { clock, opened } = world(on, { branch: 'feat/pr-pane' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(opened).toEqual(['pr-pane'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Pull requests$/ }))?.text).toBe('Pull requests')
  expect((await ui.find({ type: 'Text', text: /open$/ }))?.text).toBe('2 open')
  expect((await ui.find({ type: 'Text', text: /^Add pr-pane$/ }))?.text).toBe('Add pr-pane')
  expect((await ui.find({ type: 'Text', text: /^feat\/pr-pane/ }))?.text).toBe('feat/pr-pane → main')
  // Only what needs you is named: a draft with checks running.
  expect((await ui.find({ type: 'Text', text: /Checks running/ }))?.text).toContain('Checks running')
  expect(await ui.find({ type: 'Text', text: /refresh/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /What #9 does/ }))?.text).toBe('What #9 does.')
  expect(await ui.find({ type: 'Text', text: /Generated with/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^file-9/ }))?.text).toBe('file-9.ts')
  expect((await ui.find({ type: 'Text', text: /^\s*pr-pane$/ }))?.text?.trim()).toBe('pr-pane')
  await ui.unmount()
})

test('pressing another PR shows that one', async ($, on) => {
  const { clock } = world(on, { branch: 'main' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Not on a PR branch: the first PR gh lists is picked.
  expect((await ui.find({ type: 'Text', text: /^file-7/ }))?.text).toBe('file-7.ts')
  await ui.press({ key: 'pr-9' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^file-9/ }))?.text).toBe('file-9.ts')
  await ui.unmount()
})

test('stays shut with no open PRs', async ($, on) => {
  const { clock, opened } = world(on, { branch: 'main', list: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(opened).toEqual([])
})
