export type Handoff = {
  cwd: string
  savedAt: number
  reason: string
  branch: string
  summary: string
  lastAnswer: string
  prompts: string[]
  links: string[]
  prs: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'handoff-on-clear': {
      pending: Handoff | null
      willAttach: boolean
    }
  }
}
