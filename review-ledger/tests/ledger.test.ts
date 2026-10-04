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
