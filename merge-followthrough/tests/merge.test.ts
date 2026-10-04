import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A fake repo: on a feature branch, clean tree, PR #616 merged on GitHub.
function fakeHost(on: Parameters<Register>[0], ran: string[]) {
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    ran.push(cmd)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'git rev-parse --is-inside-work-tree') return ok('true\n')
    if (cmd.startsWith('git symbolic-ref')) return ok('origin/main\n')
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('fix/pdb\n')
    if (cmd.startsWith('git status')) return ok('')
    if (cmd.startsWith('git log')) return ok('abc1234 Merge pull request #616\n')
    if (cmd.startsWith('gh pr list')) return ok('[]')
    if (cmd.startsWith('gh pr view 616')) return ok('{"state":"MERGED","headRefName":"fix/pdb"}')
    return ok('')
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', () => null as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

test('"616 merged" pulls main, deletes the branch and tells Claude', async ($, on) => {
  const ran: string[] = []
  mock.clock(on)
  fakeHost(on, ran)
  let seen: readonly string[] = []
  on('prompt.submit', ($, e) => {
    seen = e.context ?? []
    return { text: e.text, context: e.context }
  })

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.prompt.submit({ text: '616 merged', origin: { kind: 'composer' }, wait: false })

  expect(ran).toContain('git checkout -q main')
  expect(ran).toContain('git pull --ff-only -q')
  expect(ran).toContain('git branch -D fix/pdb')
  expect(seen.join('\n')).toContain('#616 merged')
})

test('an ordinary prompt passes through untouched', async ($, on) => {
  const ran: string[] = []
  mock.clock(on)
  fakeHost(on, ran)
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text }
  })

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.prompt.submit({ text: 'what does this module do?', origin: { kind: 'composer' }, wait: false })

  expect(ran).not.toContain('git checkout -q main')
  expect(seen).toBeUndefined()
})
