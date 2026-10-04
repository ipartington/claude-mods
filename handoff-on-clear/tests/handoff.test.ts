import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<Register>[0]
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', () => null as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ok('main\n'))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'pr 642 looks at upgrading k3s to 1.37.1, can you plan an inplace upgrade', toolUses: [] },
      { role: 'assistant', text: 'Plan is in https://claude.ai/code/artifact/abc-123. Step 1 done, PR #643 open.', toolUses: [] },
    ],
  }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'k3s 1.37.1 in-place upgrade: step 1 done, next drain cp-18.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
}

test('/clear saves a handoff and a restart ask gets it as context', async ($, on) => {
  world(on)
  let seen: readonly string[] = []
  on('prompt.submit', ($, e) => {
    seen = e.context ?? []
    return { text: e.text, context: e.context }
  })

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  await $.prompt.submit({ text: 'ive lost your feedback, can you redisplay', origin: { kind: 'composer' }, wait: false })

  const text = seen.join('\n')
  expect(text).toContain('step 1 done, next drain cp-18')
  expect(text).toContain('#643')
  expect(text).toContain('https://claude.ai/code/artifact/abc-123')
})

test('an unrelated prompt does not get the handoff until Load is pressed', async ($, on) => {
  world(on)
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text }
  })

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  await $.prompt.submit({ text: 'what is the weather', origin: { kind: 'composer' }, wait: false })
  expect(seen).toBeUndefined()

  const ui = await $.ui.mount({ plugin: 'handoff-on-clear', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await ui.press({ key: 'load' })
  await $.prompt.submit({ text: 'carry on', origin: { kind: 'composer' }, wait: false })
  expect((seen ?? []).join('\n')).toContain('k3s 1.37.1')
})
