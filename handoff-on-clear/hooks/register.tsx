import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff } from '../types'

// Before /clear (or exit) wipes the context, save what the next session needs:
// the last answer, recent asks, open PRs, artifact links, and optionally a
// short summary from one cached fork. Offer it back on the next prompt.

const pending = atom({ plugin: 'handoff-on-clear', key: 'pending' } as const, null)
const willAttach = atom({ plugin: 'handoff-on-clear', key: 'willAttach' } as const, false)

const MAX_AGE_MS = 3 * 24 * 3600_000
const ASKS_FOR_IT = /prompt to (restart|continue|complete|resume)|lost (you|your)|redisplay|pull up|where were we|carry on/i
const SUMMARY_PROMPT =
  'The user is about to clear this conversation. Write a handoff for a fresh session, under 200 words, plain markdown: ' +
  'the goal, what is done (PR numbers, merged or open), the exact next step, and any gotchas or decisions made. No preamble.'

function storeKey(cwd: string) {
  return `handoff:${cwd}`
}

async function consume($: EngineInterface) {
  await update($, pending, () => null)
  await update($, willAttach, () => false)
  await $.store.delete(storeKey(await $.session.cwd()))
}

async function snapshot($: EngineInterface, reason: string): Promise<Handoff | undefined> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length < 2) return undefined

  const recent = messages.slice(-60)
  const all = recent.map(m => m.text ?? '').join('\n')
  const lastAnswer = [...recent].reverse().find(m => m.role === 'assistant' && (m.text ?? '').trim() !== '')?.text ?? ''
  const prompts = recent
    .filter(m => m.role === 'user' && (m.text ?? '').trim() !== '' && !(m.text ?? '').startsWith('<'))
    .map(m => (m.text ?? '').trim().slice(0, 200))
    .slice(-6)
  const links = [...new Set(all.match(/https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+/g) ?? [])].slice(-5)
  const prs = [...new Set(all.match(/(?:PR\s*)?#\d{2,5}\b|\/pull\/\d+/g) ?? [])]
    .map(p => `#${p.replace(/\D/g, '')}`)
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''))
    .catch(() => '')

  return {
    cwd: await $.session.cwd(),
    savedAt: await $.clock.now(),
    reason,
    branch,
    summary: '',
    lastAnswer: lastAnswer.slice(0, 4000),
    prompts,
    links,
    prs: [...new Set(prs)].slice(-10),
  }
}

function render(ho: Handoff): string {
  const parts = ['[handoff-on-clear] Context saved from the previous session in this directory.']
  if (ho.summary) parts.push(`## Summary\n${ho.summary}`)
  if (ho.branch) parts.push(`Branch at the time: ${ho.branch}`)
  if (ho.prs.length) parts.push(`PRs mentioned: ${ho.prs.join(', ')}`)
  if (ho.links.length) parts.push(`Artifacts: ${ho.links.join(' ')}`)
  if (ho.prompts.length) parts.push(`## Last asks\n${ho.prompts.map(p => `- ${p}`).join('\n')}`)
  if (ho.lastAnswer) parts.push(`## Last answer\n${ho.lastAnswer}`)
  return parts.join('\n\n')
}

function headline(ho: Handoff): string {
  const first = (ho.summary || ho.prompts.at(-1) || ho.lastAnswer).split('\n').find(l => l.trim() !== '') ?? ''
  return first.replace(/^[#*\-\s]+/, '').slice(0, 90)
}

export const register: Register = (on, options) => {
  const summarize = options.summarize !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Show the saved handoff for this directory and give it to Claude',
    })
    const saved = (await $.store.get(storeKey(e.cwd))) as Handoff | undefined
    if (saved && (await $.clock.now()) - saved.savedAt < MAX_AGE_MS) {
      await update($, pending, () => saved)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'prompt_input_exit') return next(e)
    const ho = await snapshot($, e.reason)
    if (!ho) return next(e)

    if (summarize) {
      const reply = await $.model.fork({ prompt: SUMMARY_PROMPT })
      if (reply.isAnswered) ho.summary = reply.text.trim()
    }
    await $.store.set(storeKey(ho.cwd), ho)
    // After /clear the process goes on: offer it straight away.
    await update($, pending, () => ho)
    await update($, willAttach, () => false)
    $.ui.toast('Handoff saved: it will be offered on your next prompt')

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => {
    const ho = await read($, pending)
    if (!ho) return { text: 'No handoff saved for this directory.' }
    await consume($)
    return { text: render(ho) }
  })

  on('prompt.submit', async ($, e, next) => {
    const ho = await read($, pending)
    if (!ho || e.origin.kind !== 'composer') return next(e)
    const isWanted = (await read($, willAttach)) || ASKS_FOR_IT.test(e.text)
    if (!isWanted) return next(e)

    await consume($)
    return next({ ...e, context: [...(e.context ?? []), render(ho)] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ho = await read($, pending)
    if (!ho || e.props.hasSurvey) return next(e)
    const isQueued = await read($, willAttach)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="cyan">↺ </Text>
        <Text dimColor wrap="truncate">
          {isQueued ? 'Handoff goes with your next prompt: ' : 'Handoff from last session: '}
          {headline(ho)}{' '}
        </Text>
        {!isQueued && (
          <Button key="load" label="Load" hotkey="l" variant="primary" onPress={() => update($, willAttach, () => true)} />
        )}
        <Button
          key="dismiss"
          label="Dismiss"
          hotkey="d"
          role="dismiss"
          onPress={() => consume($)}
        />
      </Box>
    )
  })
}
