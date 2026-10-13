import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Checklist, Removed } from '../types'
import { normalizeSelection, pickChecklist } from './parse'

const STORE_PREFIX = 'list:'
const STORE_LIMIT = 50

const list = atom({ plugin: 'checklist', key: 'list' } as const, null)
const isExpanded = atom({ plugin: 'checklist', key: 'isExpanded' } as const, false)
const expanded = atom({ plugin: 'checklist', key: 'expanded' } as const, [])
const offer = atom({ plugin: 'checklist', key: 'offer' } as const, null)
const dismissed = atom({ plugin: 'checklist', key: 'dismissed' } as const, [])
const removed = atom({ plugin: 'checklist', key: 'removed' } as const, null)

// Transcript rows that say which of their rows are on screen. The one cut off
// at the viewport's top edge draws the checklist over that edge, so it stays
// pinned to the top of the screen whatever is scrolled beneath it.
const TOP_SITES = [
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'CommandOutput',
  'TurnDuration',
  'InfoNotice',
] as const

// Greys, so a 256-colour terminal (tmux by default) draws exactly these shades:
// each lands on a step of its grey ramp (#303030 is 236).
const THEME = {
  background: '#303030',
  text: '#ffffff',
  muted: '#a8a8a8',
  done: '#8a8a8a',
} as const

type $ = EngineInterface
type Table = Pick<Elements['terminal'], 'Box' | 'Button' | 'Markdown' | 'Text'>

// Which transcript row draws the pinned checklist now, if any. Module state on
// purpose: it is a fact about this drawing, rebuilt by the next one after a reload.
let topSite: string | null = null

function claimTop($: $, site: string, isTop: boolean) {
  const before = topSite
  if (isTop) {
    topSite = site
  } else if (topSite === site) {
    topSite = null
  }
  // The band shows the checklist only while nothing is pinned at the top.
  if (before !== topSite) $.ui.invalidate('ui.render')
}

const doneCount = (checklist: Checklist) => checklist.items.filter(item => item.isDone).length

const progress = (checklist: Checklist) => `${doneCount(checklist)}/${checklist.items.length}`

function progressBar(checklist: Checklist): [string, string] {
  const total = checklist.items.length
  if (total === 0) return ['', '']
  const cells = Math.min(total, 10)
  const filled = Math.round((doneCount(checklist) / total) * cells)

  return ['━'.repeat(filled), '━'.repeat(cells - filled)]
}

// Every change goes through here so a resumed session finds its checklist again.
async function changeList($: $, change: (current: Checklist | null) => Checklist | null) {
  const next = await update($, list, change)
  const key = STORE_PREFIX + (await $.session.id())
  if (next === null) {
    await $.store.delete(key)
  } else {
    await $.store.set(key, next)
  }

  return next
}

async function save($: $, checklist: Checklist) {
  await changeList($, () => checklist)
  await update($, isExpanded, () => true)
  await update($, expanded, () => [])
  await update($, removed, () => null)
  await update($, offer, () => null)
}

/** The newest assistant message holding a list, scanning back through the session. */
async function latestFromSession($: $): Promise<Checklist | null> {
  const messages = await $.session.messages()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const found = pickChecklist(message.text, 1)
    if (found) return found
  }

  return null
}

async function toggleDone($: $, id: string) {
  await changeList($, checklist =>
    checklist && {
      ...checklist,
      items: checklist.items.map(item => (item.id === id ? { ...item, isDone: !item.isDone } : item)),
    },
  )
}

async function remove($: $, id: string) {
  let taken: Removed | null = null
  await changeList($, checklist => {
    const index = checklist?.items.findIndex(item => item.id === id) ?? -1
    const item = checklist?.items[index]
    if (!checklist || !item) return checklist
    taken = { item, index }

    return { ...checklist, items: checklist.items.filter(one => one.id !== id) }
  })
  const wasTaken = taken as Removed | null
  if (wasTaken) await update($, removed, () => wasTaken)
}

async function undoRemove($: $) {
  const last = await read($, removed)
  if (!last) return
  await changeList($, checklist => {
    if (!checklist) return checklist
    const items = [...checklist.items]
    items.splice(Math.min(last.index, items.length), 0, last.item)

    return { ...checklist, items }
  })
  await update($, removed, () => null)
}

/** The checklist as drawn at the top or in the band: one line, or the line and its items. */
async function drawChecklist($: $, ui: Table, current: Checklist, width: number) {
  const { Box, Button, Markdown, Text } = ui
  const isOpen = await read($, isExpanded)
  const openItems = await read($, expanded)
  const lastRemoved = await read($, removed)
  const [filled, empty] = progressBar(current)
  const titleColumns = Math.max(8, width - 8)

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" backgroundColor={THEME.background} paddingX={1} width={width}>
        <Button key="toggle" plain onPress={() => update($, isExpanded, value => !value)}>
          <Text color={THEME.muted}>{isOpen ? '▾' : '▸'} </Text>
          <Text color={THEME.text} bold>
            {current.title}
          </Text>
          <Text color={THEME.muted}> {progress(current)} done </Text>
          <Text color={THEME.text}>{filled}</Text>
          <Text color={THEME.done}>{empty}</Text>
        </Button>
      </Box>
      {isOpen && current.items.length === 0 && (
        <Box backgroundColor={THEME.background} paddingX={1} width={width}>
          <Text color={THEME.done}>All items removed.</Text>
        </Box>
      )}
      {isOpen &&
        current.items.map(item => {
          const isItemOpen = openItems.includes(item.id)

          return (
            <Box flexDirection="column" width={width}>
              <Box flexDirection="row" backgroundColor={THEME.background} paddingX={1} width={width}>
                <Button key={`done:${item.id}`} plain onPress={() => toggleDone($, item.id)}>
                  <Text color={THEME.text}>{item.isDone ? '☒' : '☐'}</Text>
                </Button>
                <Box width={titleColumns} marginLeft={1}>
                  <Button
                    key={`row:${item.id}`}
                    plain
                    onPress={() =>
                      update($, expanded, ids =>
                        ids.includes(item.id) ? ids.filter(one => one !== item.id) : [...ids, item.id],
                      )
                    }
                  >
                    <Text color={THEME.muted}>{isItemOpen ? '▾' : '▸'} </Text>
                    <Text color={THEME.muted}>{item.marker} </Text>
                    <Text
                      color={item.isDone ? THEME.done : THEME.text}
                      strikethrough={item.isDone}
                      wrap="truncate-end"
                    >
                      {item.title}
                    </Text>
                  </Button>
                </Box>
                <Box marginLeft={1}>
                  <Button key={`x:${item.id}`} plain onPress={() => remove($, item.id)}>
                    <Text color={THEME.muted}>✕</Text>
                  </Button>
                </Box>
              </Box>
              {isItemOpen && (
                <Box backgroundColor={THEME.background} paddingLeft={6} paddingRight={1} width={width}>
                  <Markdown text={item.body} dimColor={item.isDone} />
                </Box>
              )}
            </Box>
          )
        })}
      {isOpen && lastRemoved && (
        <Box backgroundColor={THEME.background} paddingX={1} width={width}>
          <Button key="undo" plain onPress={() => undoRemove($)}>
            <Text color={THEME.muted}>↶ undo remove "{lastRemoved.item.title}"</Text>
          </Button>
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checklist',
      description: 'Pin the latest list from Claude as a checklist at the top of the screen',
      argumentHint: '[save | clear]',
    })

    if ((await read($, list)) === null) {
      const stored = await $.store.get(STORE_PREFIX + (await $.session.id()))
      if (stored) await update($, list, () => stored as Checklist)
    }

    const keys = (await $.store.keys()).filter(key => key.startsWith(STORE_PREFIX))
    for (const key of keys.slice(0, Math.max(0, keys.length - STORE_LIMIT))) {
      await $.store.delete(key)
    }

    return next(e)
  })

  on('command.run', { command: 'checklist' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()

    if (verb === 'clear') {
      await changeList($, () => null)
      await update($, removed, () => null)

      return { text: 'Checklist cleared.' }
    }

    const current = await read($, list)
    if (verb === '' && current) {
      await update($, isExpanded, () => true)

      return { text: `Checklist: ${current.title} (${progress(current)} done).` }
    }

    if (verb !== '' && verb !== 'save') {
      return { text: 'Usage: /checklist [save | clear]' }
    }

    const selection = await $.ui.selection()
    const fromSelection = selection ? pickChecklist(normalizeSelection(selection.text), 1) : null
    const found = fromSelection ?? (await latestFromSession($))
    if (!found) {
      return { text: 'No list found in the selection or in any reply from Claude.' }
    }
    await save($, found)
    const source = fromSelection ? 'the selection' : "Claude's latest list"

    return { text: `Saved ${found.items.length} items from ${source} as "${found.title}".` }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) {
      const found = pickChecklist(e.answer, 2)
      await update($, offer, () => found)
    }

    return next(e)
  })

  on('ui.render', { component: TOP_SITES }, async ($, e, next) => {
    const drawn = await next(e)
    const shown = e.props.onScreen
    const site = `${e.component}:${e.requestId}`
    // Only the row whose top is scrolled away holds the viewport's top edge;
    // reading the checklist here alone keeps every other row unsubscribed.
    const isEdge = shown !== null && shown !== undefined && shown.first > 0
    const current = isEdge ? await read($, list) : null
    claimTop($, site, current !== null)
    if (current === null || !shown) return drawn

    const ui = $.ui.resolve(e)
    // The transcript is a column narrower than the terminal; rows as wide as
    // the terminal lose their background there.
    const width = (e.viewport?.columns ?? 80) - 1

    return (
      <ui.Box flexDirection="column">
        {drawn}
        <ui.Box position="absolute" top={shown.first} left={0} width={width}>
          {await drawChecklist($, ui, current, width)}
        </ui.Box>
      </ui.Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const current = await read($, list)
    const pending = await read($, offer)
    const isOffered =
      pending !== null &&
      pending.sourceKey !== current?.sourceKey &&
      !(await read($, dismissed)).includes(pending.sourceKey)
    const isFallback = current !== null && topSite === null
    if (!isOffered && !isFallback) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui

    return (
      <Box flexDirection="column">
        {isFallback && current && (await drawChecklist($, ui, current, e.props.bodyColumns))}
        {isOffered && pending && (
          <Box flexDirection="row" gap={1}>
            <Text color={THEME.muted} wrap="truncate-end">
              {pending.items.length}-item list in the last reply
            </Text>
            <Button key="save-offer" variant="primary" onPress={() => save($, pending)}>
              Save as checklist
            </Button>
            <Button
              key="dismiss-offer"
              plain
              dimColor
              label="✕"
              onPress={() => update($, dismissed, keys => [...keys, pending.sourceKey].slice(-50))}
            />
          </Box>
        )}
      </Box>
    )
  })
}
