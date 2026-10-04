import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<Register>[0]
const ok = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

function world(on: On, settings: string) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/home/me' })
  const spoken: string[] = []
  const models: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.read', () => ({ value: settings }) as never)
  on('process.run', ($, e) => {
    spoken.push(e.init?.stdin ?? '')
    return ok
  })
  on('model.complete', ($, e) => {
    models.push(e.model)
    return { value: { isAnswered: true, text: 'Merged both PRs and pulled main.', usage: {} } } as never
  })
  on('turn.complete', ($, e) => ({ text: 'answer' in e ? e.answer : '' }) as never)
  return { clock, spoken, models }
}

const turn = (answer: string) =>
  ({ answer, durationMs: 1, isAborted: false, turnId: 't1' }) as never

test('a short reply is spoken as is, with no model call', async ($, on) => {
  const w = world(on, '{}')
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.turn.complete(turn('Done: **#616** is merged.'))
  await w.clock.advance(1)
  await w.clock.settle()
  expect(w.models).toHaveLength(0)
  expect(w.spoken).toEqual(['Done: 616 is merged.'])
})

test('a long reply is summarized by one Haiku completion', async ($, on) => {
  const w = world(on, '{}')
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.turn.complete(turn('word '.repeat(60)))
  await w.clock.advance(1)
  await w.clock.settle()
  expect(w.models).toEqual(['haiku'])
  expect(w.spoken).toEqual(['Merged both PRs and pulled main.'])
})

test('stays quiet while the old tts-speak.sh Stop hook is configured', async ($, on) => {
  const w = world(on, '{"hooks":{"Stop":[{"hooks":[{"command":"bash ~/.claude/hooks/tts-speak.sh"}]}]}}')
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.turn.complete(turn('Done.'))
  await w.clock.advance(1)
  await w.clock.settle()
  expect(w.spoken).toHaveLength(0)
})
