export type PrRow = {
  number: number
  title: string
  branch: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  checks: 'pass' | 'fail' | 'pending' | 'none'
  mergeable: string
}

declare module 'claude-code' {
  interface PluginState {
    'merge-followthrough': {
      prs: PrRow[]
      merged: { number: number; note: string }[]
    }
  }
}
