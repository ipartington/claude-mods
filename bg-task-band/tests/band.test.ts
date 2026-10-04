import { expect, mock, test } from 'claude-code/testing'

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('a background Bash shows in the band and toasts when it completes', async ($, on) => {
  mock.clock(on, { now: 0 })
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('ui.render', () => null as never)
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    if (cmd === 'id -u') return ok('1000\n')
    if (cmd.startsWith('find')) return ok('/tmp/claude-1000/x/s/tasks/b1.output\n')
    if (cmd.startsWith('tail')) return ok('PLAY RECAP\nTASK [drain node cp-22]\n')
    return ok('')
  })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
  }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.tool.call({
    tool: 'Bash',
    command: 'until ...; do sleep 30; done',
    description: 'Wait for the cp-22 play recap',
    run_in_background: true,
    timeout: 1_500_000,
  } as never)

  const ui = await $.ui.mount({ plugin: 'bg-task-band', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  expect(await ui.find({ type: 'Text', text: /Wait for the cp-22 play recap/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/25m/ })).toBeDefined()

  await $.prompt.submit({
    text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>',
    origin: { kind: 'task-notification' },
    wait: false,
  })
  expect(toasts.join('\n')).toContain('Wait for the cp-22 play recap (completed')
})
