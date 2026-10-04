import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BgTask } from '../types'

// Answers "how are we looking?" without a turn: a band of the background
// shells, monitors and agents Claude started, how long each has run against
// its cap, and the last line each wrote. A toast when one ends.

const tasks = atom({ plugin: 'bg-task-band', key: 'tasks' } as const, [])
const now = atom({ plugin: 'bg-task-band', key: 'now' } as const, 0)

const TICK_MS = 10_000
const KEEP_DONE_MS = 90_000

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? `${Math.floor(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}

function clean(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

async function findOutput($: EngineInterface, id: string): Promise<string> {
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  const r = await $.process.run(['find', `/tmp/claude-${uid}`, '-maxdepth', '5', '-name', `${id}.output`])
    .catch(() => undefined)
  return r?.stdout.split('\n')[0]?.trim() ?? ''
}

async function lastLine($: EngineInterface, t: BgTask): Promise<string> {
  if (!t.outputFile) return t.last
  const r = await $.process.run(['tail', '-n', '5', t.outputFile]).catch(() => undefined)
  if (!r || r.exitCode !== 0) return t.last
  const lines = r.stdout.split('\n').map(clean).filter(l => l !== '')
  return lines.at(-1) ?? t.last
}

async function track($: EngineInterface, t: Omit<BgTask, 'startedAt' | 'last' | 'status' | 'endedAt'>) {
  const startedAt = await $.clock.now()
  const outputFile = t.outputFile || (await findOutput($, t.id))
  await update($, tasks, list => [
    ...list.filter(x => x.id !== t.id),
    { ...t, outputFile, startedAt, last: '', status: 'running' as const, endedAt: 0 },
  ])
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  const list = await read($, tasks)
  const kept = list.filter(t => t.status === 'running' || at - t.endedAt < KEEP_DONE_MS)
  const refreshed = await Promise.all(
    kept.map(async t => (t.status === 'running' ? { ...t, last: await lastLine($, t) } : t)),
  )
  await update($, tasks, () => refreshed)
  await update($, now, () => at)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const id = ran.result.backgroundTaskId
    if (id) {
      await track($, {
        id,
        kind: 'shell',
        label: e.description || e.command.slice(0, 80),
        capMs: e.timeout ?? 0,
        outputFile: '',
      })
    }
    return ran
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    await track($, {
      id: ran.result.taskId,
      kind: 'monitor',
      label: e.description,
      capMs: ran.result.persistent ? 0 : ran.result.timeoutMs,
      outputFile: '',
    })
    return ran
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const r = ran.result
    if ('status' in r && r.status === 'async_launched') {
      await track($, { id: r.agentId, kind: 'agent', label: r.description, capMs: 0, outputFile: r.outputFile })
    }
    return ran
  })

  // Background tasks report back as task-notification prompts.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'task-notification') return next(e)
    const id = e.text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
    const status = e.text.match(/<status>([^<]+)<\/status>/)?.[1]
    const event = e.text.match(/<event>([\s\S]*?)<\/event>/)?.[1]
    const list = await read($, tasks)
    const t = list.find(x => x.id === id)
    if (!t) return next(e)

    const at = await $.clock.now()
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      await update($, tasks, l => l.map(x => (x.id === t.id ? { ...x, status, endedAt: at } : x)))
      const mark = status === 'completed' ? '✓' : '✗'
      $.ui.toast(`${mark} ${t.label} (${status}, ${minutes(at - t.startedAt)})`, { timeoutMs: 8000 })
    } else if (event) {
      const line = clean(event.split('\n').filter(l => l.trim() !== '').at(-1) ?? '')
      await update($, tasks, l => l.map(x => (x.id === t.id ? { ...x, last: line } : x)))
    }
    return next(e)
  })

  // A TaskStop ends the task without a notification.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id ?? ''
    const at = await $.clock.now()
    await update($, tasks, l => l.map(x => (x.id === id ? { ...x, status: 'killed' as const, endedAt: at } : x)))
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    const at = await read($, now)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const running = list.filter(t => t.status === 'running')
    const icon = { running: '⏳', completed: '✓', failed: '✗', killed: '■' } as const
    const color = { running: 'yellow', completed: 'green', failed: 'red', killed: 'gray' } as const

    return (
      <Box flexDirection="column">
        {list.slice(-4).map(t => {
          const elapsed = minutes(Math.max(0, (t.status === 'running' ? at : t.endedAt) - t.startedAt))
          return (
            <Box key={t.id}>
              <Text color={color[t.status]}>{icon[t.status]} </Text>
              <Text>{t.label.slice(0, 50)} </Text>
              <Text dimColor>
                {elapsed}
                {t.capMs > 0 ? `/${minutes(t.capMs)}` : ''}{' '}
              </Text>
              {t.last !== '' && (
                <Text dimColor wrap="truncate">
                  · {t.last}
                </Text>
              )}
            </Box>
          )
        })}
        {running.length > 4 && <Text dimColor>{running.length} running in all</Text>}
      </Box>
    )
  })
}
