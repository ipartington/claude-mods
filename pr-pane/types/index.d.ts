export type Checks = 'pass' | 'fail' | 'pending' | 'none'

export type PrRow = {
  number: number
  title: string
  author: string
  branch: string
  isDraft: boolean
  checks: Checks
  updatedAt: string
}

export type PrFile = { path: string; additions: number; deletions: number }

export type PrDetail = {
  number: number
  title: string
  author: string
  branch: string
  base: string
  url: string
  body: string
  isDraft: boolean
  checks: Checks
  review: string
  mergeable: string
  additions: number
  deletions: number
  files: PrFile[]
  updatedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-pane': {
      prs: PrRow[]
      selected: number
      detail: PrDetail | null
      problem: string
    }
  }
}
