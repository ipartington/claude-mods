export type BgTask = {
  id: string
  kind: 'shell' | 'monitor' | 'agent'
  label: string
  startedAt: number
  capMs: number
  outputFile: string
  last: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  endedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'bg-task-band': {
      tasks: BgTask[]
      now: number
    }
  }
}
