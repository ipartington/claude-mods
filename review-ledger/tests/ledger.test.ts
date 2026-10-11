import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('items recorded by Claude reach later prompts and tick off when the PR merges', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  let prState = 'OPEN'
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/mnt/c/_code/home-cluster\n')
    if (cmd.startsWith('gh pr view 566')) return ok(`{"state":"${prState}"}`)
    return ok('')
  })
  let seen: readonly string[] = []
  on('prompt.submit', ($, e) => {
    seen = e.context ?? []
    return { text: e.text }
  })

  await $.session.start({ cwd: '/mnt/c/_code/home-cluster', surface: null, isInteractive: true })
  await $.tool.call({
    tool: 'mcp__review-ledger__items',
    action: 'upsert',
    items: [
      { id: 'H1', title: 'Tailscale on work laptop', status: 'wontdo', note: 'user declined' },
      { id: 'h2', title: 'Restrict ArgoCD admin', status: 'in-progress', pr: 566 },
      { id: 'M3', title: 'Rotate client secrets' },
    ],
  } as never)

  await $.prompt.submit({ text: "what's left to do from the review?", origin: { kind: 'composer' }, wait: false })
  const ctx = seen.join('\n')
  expect(ctx).toContain('H2 [in-progress #566] Restrict ArgoCD admin')
  expect(ctx).toContain('M3 [open] Rotate client secrets')
  expect(ctx).toContain("1 won't do")

  prState = 'MERGED'
  await clock.advance(5 * 60_000 + 1)
  await clock.settle()
  await $.prompt.submit({ text: 'can you propose a fix for m3', origin: { kind: 'composer' }, wait: false })
  expect(seen.join('\n')).toContain('1 done')
})

// A repo whose ledger already holds `saved`; records every pane opening.
function sidebarWorld(on: Parameters<Register>[0], saved: unknown[]) {
  const clock = mock.clock(on, { now: 0 })
  const opened: { id: string; columns?: number }[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: saved }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, columns: e.columns })
    return { value: { isPlaced: true } } as never
  })
  on('ui.render', () => null as never)
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    if (cmd.startsWith('gh pr view')) return ok('{"state":"OPEN"}')
    return ok('')
  })
  return { clock, opened }
}

const SAVED = [
  { id: 'H1', title: 'Restrict ArgoCD admin', status: 'open', pr: 0, note: 'needs SSO first' },
  { id: 'M2', title: 'Rotate client secrets', status: 'in-progress', pr: 566, note: '' },
  { id: 'L3', title: 'Tidy README', status: 'done', pr: 0, note: '' },
]

test('a session with items left opens the review sidebar by itself', async ($, on) => {
  const { clock, opened } = sidebarWorld(on, SAVED)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.settle()
  expect(opened).toEqual([{ id: 'review-ledger', columns: 44 }])
})

test('with the sidebar option off only /review opens the pane', { options: { sidebar: false } }, async ($, on) => {
  const { clock, opened } = sidebarWorld(on, SAVED)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.settle()
  expect(opened).toEqual([])
})

test('docked, the pane groups open items by severity and folds finished ones', async ($, on) => {
  const { clock } = sidebarWorld(on, SAVED)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'review-ledger', surface: 'terminal', component: 'Pane', requestId: 'review-ledger',
    props: { title: 'Review items', placement: 'dock', bodyColumns: 44, isFocused: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /High \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Medium \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /needs SSO first/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 done or won't do/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Tidy README/ })).toBeUndefined()
})
