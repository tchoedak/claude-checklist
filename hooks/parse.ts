import type { Checklist, ChecklistItem } from '../types'

type ParsedItem = { marker: string; lines: string[] }
type ParsedList = { heading: string; isOrdered: boolean; items: ParsedItem[] }

// A list marker as written in markdown, or as the terminal draws one when the
// text came from a mouse selection (`•`).
const MARKER = /^(\s*)(\d{1,3}[.)]|[-*+•◦▪])(\s+)(.*)$/
const FENCE = /^\s*(```|~~~)/
const TASK_BOX = /^\[([ xX])\]\s+/
// The glyphs the terminal draws before a reply or a command's output, present in a selection.
const REPLY_GLYPH = /^\s*[⏺●⎿]\s*/

const indentOf = (line: string) => line.length - line.trimStart().length
const isBlank = (line: string) => line.trim() === ''
const isOrderedMarker = (marker: string) => /\d/.test(marker)

function stripInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The short form of an item: its bold lead, else its first clause. */
export function shortTitle(firstLine: string): string {
  const line = firstLine.replace(TASK_BOX, '').trim()
  const bold = /^(\*\*|__)(.+?)\1/.exec(line)
  if (bold?.[2]) {
    return stripInline(bold[2]).replace(/[:.\s-]+$/, '')
  }
  const plain = stripInline(line)
  const cut = /^(.{8,80}?)(?:\s+[-–—]\s+|:\s+|\.\s+)/.exec(plain)

  return cut?.[1] ?? plain
}

function headingAbove(lines: string[], start: number): string {
  let i = start - 1
  while (i >= 0 && isBlank(lines[i] ?? '')) i -= 1
  const line = (lines[i] ?? '').trim()
  const heading = /^#{1,6}\s+(.*)$/.exec(line)
  if (heading?.[1]) return stripInline(heading[1])
  if (line.endsWith(':')) return stripInline(line).replace(/:$/, '').slice(0, 80)

  return ''
}

/** Every top-level list in a reply, in order, nested items kept inside their parent. */
export function findLists(text: string): ParsedList[] {
  const lines = text.split('\n').map(line => line.replace(REPLY_GLYPH, ''))
  const lists: ParsedList[] = []
  let isInFence = false
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) isInFence = !isInFence
    const start = isInFence ? null : MARKER.exec(line)
    if (!start) {
      i += 1
      continue
    }

    const baseIndent = start[1]?.length ?? 0
    const isOrdered = isOrderedMarker(start[2] ?? '')
    const list: ParsedList = { heading: headingAbove(lines, i), isOrdered, items: [] }
    let item: ParsedItem | null = null
    let contentIndent = 0
    let isAfterBlank = false

    for (; i < lines.length; i += 1) {
      const current = lines[i] ?? ''
      const marker = MARKER.exec(current)
      const isSibling =
        marker !== null &&
        (marker[1]?.length ?? 0) === baseIndent &&
        isOrderedMarker(marker[2] ?? '') === isOrdered

      if (isSibling && marker) {
        item = { marker: marker[2] ?? '', lines: [marker[4] ?? ''] }
        list.items.push(item)
        contentIndent = baseIndent + (marker[2]?.length ?? 0) + (marker[3]?.length ?? 1)
        isAfterBlank = false
        continue
      }
      if (isBlank(current)) {
        item?.lines.push('')
        isAfterBlank = true
        continue
      }
      const isNested = indentOf(current) > baseIndent
      const isLazy = !isAfterBlank && marker === null && !/^\s*(#|```|~~~|\|)/.test(current)
      if (item && (isNested || isLazy)) {
        const strip = Math.min(indentOf(current), contentIndent)
        item.lines.push(current.slice(strip))
        isAfterBlank = false
        continue
      }
      break
    }

    for (const done of list.items) {
      while (done.lines.length > 0 && isBlank(done.lines[done.lines.length - 1] ?? '')) {
        done.lines.pop()
      }
    }
    lists.push(list)
  }

  return lists
}

/**
 * A mouse selection that starts on a list marker loses that line's indent while
 * the lines after it keep theirs; give it back so the items stay siblings.
 */
export function normalizeSelection(text: string): string {
  const lines = text.split('\n').map(line => line.replace(REPLY_GLYPH, ''))
  const rest = lines.slice(1).filter(line => !isBlank(line))
  const first = lines[0] ?? ''
  if (rest.length === 0) return lines.join('\n')
  const restIndent = Math.min(...rest.map(indentOf))
  if (indentOf(first) >= restIndent) return lines.join('\n')

  return [' '.repeat(restIndent) + first.trimStart(), ...lines.slice(1)].join('\n')
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0

  return (h >>> 0).toString(36)
}

/**
 * The list in a reply worth tracking: the last numbered one (task lists are
 * usually numbered and usually last), else the last bulleted one.
 */
export function pickChecklist(text: string, minItems: number): Checklist | null {
  const lists = findLists(text).filter(list => list.items.length >= minItems)
  const chosen = [...lists].reverse().find(list => list.isOrdered) ?? lists[lists.length - 1]
  if (!chosen) return null

  const sourceKey = hash(chosen.items.map(item => item.lines.join('\n')).join('\n\u0000'))
  const items: ChecklistItem[] = chosen.items.map((parsed, index) => {
    const first = parsed.lines[0] ?? ''
    const box = TASK_BOX.exec(first)

    return {
      id: `${sourceKey}-${index}`,
      marker: parsed.marker,
      title: shortTitle(first) || `Item ${index + 1}`,
      body: [first.replace(TASK_BOX, ''), ...parsed.lines.slice(1)].join('\n'),
      isDone: box !== null && box[1] !== ' ',
    }
  })

  return { title: chosen.heading || 'Checklist', items, sourceKey }
}
