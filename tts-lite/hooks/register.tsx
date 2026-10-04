import type { EngineInterface, Register } from 'claude-code'

// Replaces ~/.claude/hooks/tts-speak.sh. That hook started a whole headless
// `claude -p` session per reply (full system prompt, a transcript file each:
// 200 of 269 files in ~/.claude/projects). This one speaks short replies as
// they are, and summarizes longer ones with a single bare Haiku completion.
//
// Same knobs as the old hook: CLAUDE_TTS=0 turns it off, CLAUDE_TTS_SPEED,
// CLAUDE_TTS_VOICE, CLAUDE_TTS_MODEL.

const VERBATIM_WORDS = 20
const PROMPT =
  'The text below is a message Claude just sent to the user. In one short spoken sentence ' +
  '(max 16 words, plain text, no markdown, start with a verb) say what was done or answered.\n\n'

// Piper -> paplay, espeak -> paplay as fallback; text arrives on stdin.
const SPEAK_SH = `
voice="$1"; speed="$2"; piper="$HOME/.local/share/piper/piper/piper"
command -v paplay >/dev/null 2>&1 || exit 0
wav="$(mktemp --suffix=.wav)"; text="$(cat)"
if [ -x "$piper" ] && [ -f "$voice" ]; then
  printf '%s' "$text" | "$piper" --model "$voice" --length_scale "$speed" --output_file "$wav" >/dev/null 2>&1
elif command -v espeak >/dev/null 2>&1; then
  espeak -s 170 -w "$wav" "$text" >/dev/null 2>&1
fi
[ -s "$wav" ] && paplay "$wav" >/dev/null 2>&1
rm -f "$wav"
`

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block. ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

let isOldHookActive = false

async function oldHookActive($: EngineInterface): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const settings = await $.fs.read(`${home}/.claude/settings.json`).catch(() => '')
  return typeof settings === 'string' && settings.includes('tts-speak.sh')
}

async function speak($: EngineInterface, answer: string) {
  const plain = stripMarkdown(answer)
  if (plain === '') return
  let spoken = plain

  if (plain.split(' ').length > VERBATIM_WORDS) {
    const model = (await $.env.get('CLAUDE_TTS_MODEL')) || 'haiku'
    const reply = await $.model.complete({ model, prompt: PROMPT + answer.slice(0, 6000), maxTokens: 60, timeoutMs: 15_000 })
    spoken = reply.isAnswered ? stripMarkdown(reply.text) : `${plain.slice(0, 300)}. That's the gist.`
  }

  const home = (await $.env.get('HOME')) ?? ''
  const voice = (await $.env.get('CLAUDE_TTS_VOICE')) || `${home}/.local/share/piper/voices/en_US-amy-medium.onnx`
  const speed = (await $.env.get('CLAUDE_TTS_SPEED')) || '0.5'
  await $.process.run(['bash', '-c', SPEAK_SH, 'tts-lite', voice, speed], { stdin: spoken, timeoutMs: 120_000 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isOldHookActive = await oldHookActive($)
    if (isOldHookActive) {
      $.ui.status('tts-lite idle: remove the tts-speak.sh Stop hook from ~/.claude/settings.json to switch over')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const isMain = e.agentId === undefined
    if (!isMain || e.isAborted || isOldHookActive || !('answer' in e)) return done
    if ((await $.env.get('CLAUDE_TTS')) === '0') return done

    const answer = e.answer
    // Off the turn's dispatch, so the prompt comes back at once.
    $.clock.after(0, () => void speak($, answer))
    return done
  })
}
