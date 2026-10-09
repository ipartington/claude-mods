import type { Register } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type On = Parameters<Register>[0]

const RULES = JSON.stringify({
  guards: [
    {
      id: 'cnpg-instance-pod',
      command: 'kubectl',
      allOf: ['\\bdelete\\b', '\\b(pods?|po)\\b'],
      anyOf: ['\\b[\\w-]+-postgresql-\\d+\\b', 'cnpg\\.io/'],
      reason: 'can promote a stale standby',
    },
    {
      id: 'cnpg-namespace-all',
      command: 'kubectl',
      allOf: ['\\bdelete\\b', '\\b(pods?|po)\\b', '(^|\\s)--all(\\s|$)', '(-n|--namespace)[=\\s]+(authentik|immich|semaphore)\\b'],
      reason: 'deletes the CNPG pods in that namespace',
    },
  ],
})

// A session rooted at /repo whose rules file holds `rules`; every Bash call
// that gets past the guard is recorded as run.
function world(on: On, rules: string | null) {
  const ran: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }) as never)
  on('fs.read', ($, e) => {
    if (e.path === '/repo/.claude/command-guards.json' && rules !== null) return { value: rules } as never
    throw new Error('ENOENT')
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  return ran
}

const bash = (command: string) => ({ tool: 'Bash', command, description: 'x' }) as never

const BLOCKED = [
  'kubectl delete pod authentik-postgresql-1 -n authentik',
  'kubectl -n immich delete po/immich-postgresql-2 --force --grace-period=0',
  'kubectl delete pod -n immich -l cnpg.io/cluster=immich-postgresql',
  'kubectl -n semaphore delete pods --all',
  'ssh cp-18 "kubectl delete pods immich-postgresql-1"',
  'ssh -i k ipartington@192.168.100.118 sudo kubectl delete pod immich-postgresql-1',
  'timeout 30 kubectl delete pod immich-postgresql-1 -n immich',
  'cd /x && kubectl delete pod semaphore-postgresql-1',
]

const ALLOWED = [
  'kubectl get pods -n authentik; kubectl delete pod authentik-server-abc -n authentik',
  'kubectl delete pvc immich-postgresql-1 -n immich',
  'kubectl -n jellyfin delete pods --all',
  'kubectl logs authentik-postgresql-1 -n authentik',
  'git commit -m "never kubectl delete pod authentik-postgresql-1"',
]

test('refuses the commands the rules rule out, and runs the rest', async ($, on) => {
  const ran = world(on, RULES)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  for (const command of BLOCKED) {
    const result = await $.tool.call(bash(command))
    expect('deny' in result ? result.deny : '').toContain('Blocked by command-guard (cnpg-')
  }
  for (const command of ALLOWED) await $.tool.call(bash(command))
  expect(ran).toEqual(ALLOWED)
})

test('with no rules file every command runs', async ($, on) => {
  const ran = world(on, null)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await $.tool.call(bash(BLOCKED[0]!))
  expect(ran).toEqual([BLOCKED[0]])
})
