export type ReviewItem = {
  id: string
  title: string
  status: 'open' | 'in-progress' | 'done' | 'wontdo'
  pr: number
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'review-ledger': {
      items: ReviewItem[]
    }
  }
}
