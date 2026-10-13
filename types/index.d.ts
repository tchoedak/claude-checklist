export type ChecklistItem = {
  id: string
  /** The list's own marker ("3." or "-"), kept so "do #3" still means something. */
  marker: string
  /** One-line short form shown collapsed. */
  title: string
  /** The item's full original markdown, shown expanded. */
  body: string
  isDone: boolean
}

export type Checklist = {
  title: string
  items: ChecklistItem[]
  /** Hash of the source list, so a list already saved is not offered again. */
  sourceKey: string
}

export type Removed = { item: ChecklistItem; index: number }

declare module 'claude-code' {
  interface PluginState {
    checklist: {
      list: Checklist | null
      /** Whether the pinned line shows its items. */
      isExpanded: boolean
      /** Ids of the items showing their full text. */
      expanded: string[]
      offer: Checklist | null
      dismissed: string[]
      removed: Removed | null
    }
  }
}
