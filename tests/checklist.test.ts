import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const REPLY = `Next steps:

1. **Fix the auth bug** - the token refresh races with logout.
   - Add a mutex around refresh
2. Update the README
3. Run the linter`

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true }

// A reply whose top rows are scrolled away: it holds the screen's top edge.
const atTopEdge = (first: number) =>
  ({
    component: 'AssistantMessage',
    requestId: 'reply-1',
    viewport: VIEWPORT,
    props: { text: 'some reply', isFirstOfReply: true, onScreen: { first, last: first + 30, of: 60 } },
  }) as const

const COMMAND = {
  command: 'checklist',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const ROW = /^[▸▾] \d/

function engineBeneath(on: On, selection?: string, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', () => ({ value: { isRegistered: true } }) as never)
  on('ui.selection', () => ({ value: selection === undefined ? undefined : { text: selection } }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'what is left?', toolUses: [] },
      { role: 'assistant', text: REPLY, toolUses: [] },
    ],
  }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // The engine's own drawing of every site, under whatever the plugin adds.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return Box({ key: 'engine' })
  })
}

async function finishTurn($: Engine, answer: string) {
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a saved list pins to the top; one line, then items, then an item's text`, async ($, on) => {
    engineBeneath(on)
    await start($)

    const band = await $.ui.mount({ plugin: 'checklist', surface, ...BAND })
    await finishTurn($, REPLY)
    expect(await band.find({ type: 'Text', text: /3-item list/ })).toBeDefined()
    await band.press({ key: 'save-offer' })
    expect(await band.find({ key: 'save-offer' })).toBeUndefined()
    // Nothing on screen holds the top edge yet: the band carries the checklist.
    expect((await band.find({ key: 'toggle' }))?.text).toMatch(/^▾ Next steps 0\/3 done/)

    const top = await $.ui.mount({ plugin: 'checklist', surface, ...atTopEdge(7) })
    expect(await top.find({ key: 'engine' })).toBeDefined()
    expect((await top.find({ key: 'toggle' }))?.text).toMatch(/^▾ Next steps 0\/3 done/)
    // Pinned at the top, so the band lets it go.
    expect(await band.find({ key: 'toggle' })).toBeUndefined()

    const rows = await top.findAll({ type: 'Button', text: ROW })
    expect(rows.map(row => row.text)).toEqual([
      '▸ 1. Fix the auth bug',
      '▸ 2. Update the README',
      '▸ 3. Run the linter',
    ])

    // Collapsed, it is the one line.
    await top.press({ key: 'toggle' })
    expect((await top.find({ key: 'toggle' }))?.text).toMatch(/^▸ Next steps 0\/3 done/)
    expect(await top.findAll({ type: 'Button', text: ROW })).toEqual([])
    await top.press({ key: 'toggle' })

    const first = rows[0]?.key ?? ''
    const id = first.slice('row:'.length)
    await top.press({ key: first })
    expect((await top.find({ type: 'Markdown' }))?.props.text).toBe(
      '**Fix the auth bug** - the token refresh races with logout.\n- Add a mutex around refresh',
    )
    await top.press({ key: first })
    expect(await top.find({ type: 'Markdown' })).toBeUndefined()

    await top.press({ key: `done:${id}` })
    expect((await top.find({ key: `done:${id}` }))?.text).toBe('☒')
    expect((await top.find({ key: 'toggle' }))?.text).toMatch(/1\/3 done/)

    await top.press({ key: `x:${id}` })
    expect((await top.findAll({ type: 'Button', text: ROW })).length).toBe(2)
    await top.press({ key: 'undo' })
    expect((await top.findAll({ type: 'Button', text: ROW }))[0]?.text).toBe('▸ 1. Fix the auth bug')
    expect(await top.find({ key: 'undo' })).toBeUndefined()

    // Scrolled so no row is cut at the top: back to the band.
    await top.unmount()
    const flush = await $.ui.mount({ plugin: 'checklist', surface, ...atTopEdge(0) })
    expect(await flush.find({ key: 'toggle' })).toBeUndefined()
    expect((await band.find({ key: 'toggle' }))?.text).toMatch(/1\/3 done/)

    await flush.unmount()
    await band.unmount()
  })
}

test('pinned over a short row, it keeps to the rows that row shows instead of bleeding into the next', async ($, on) => {
  engineBeneath(on)
  await start($)
  await $.command.run({ ...COMMAND, args: '' })

  // Only 3 of the row's rows are on screen: room for the title, one item and the rest's count.
  const short = {
    ...atTopEdge(7),
    props: { ...atTopEdge(7).props, onScreen: { first: 7, last: 9, of: 10 } },
  } as const
  const top = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', ...short })
  expect((await top.find({ key: 'toggle' }))?.text).toMatch(/^▾ Next steps 0\/3 done/)
  expect((await top.findAll({ type: 'Button', text: ROW })).map(row => row.text)).toEqual([
    '▸ 1. Fix the auth bug',
  ])
  expect(await top.find({ type: 'Text', text: '… 2 more' })).toBeDefined()
  expect((await top.find({ key: 'pinned' }))?.props).toMatchObject({ height: 3, overflow: 'hidden' })
  await top.unmount()

  // One row on screen: the title line alone.
  const sliver = {
    ...atTopEdge(9),
    props: { ...atTopEdge(9).props, onScreen: { first: 9, last: 9, of: 10 } },
  } as const
  const thin = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', ...sliver })
  expect(await thin.find({ key: 'toggle' })).toBeDefined()
  expect(await thin.findAll({ type: 'Button', text: ROW })).toEqual([])
  expect(await thin.find({ type: 'Text', text: /more$/ })).toBeUndefined()
  await thin.unmount()
})

test('with no checklist, transcript rows draw exactly as the engine does', async ($, on) => {
  engineBeneath(on)
  await start($)
  const top = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', ...atTopEdge(7) })
  expect(await top.find({ key: 'engine' })).toBeDefined()
  expect(await top.find({ key: 'toggle' })).toBeUndefined()
  await top.unmount()
})

test('a dismissed offer stays dismissed; a reply with no list withdraws it', async ($, on) => {
  engineBeneath(on)
  await start($)
  const band = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', ...BAND })

  await finishTurn($, REPLY)
  await band.press({ key: 'dismiss-offer' })
  expect(await band.find({ key: 'save-offer' })).toBeUndefined()
  await finishTurn($, REPLY)
  expect(await band.find({ key: 'save-offer' })).toBeUndefined()

  await finishTurn($, '- a\n- b')
  expect(await band.find({ key: 'save-offer' })).toBeDefined()
  await finishTurn($, 'Just prose.')
  expect(await band.find({ key: 'save-offer' })).toBeUndefined()
  await band.unmount()
})

test('/checklist saves the latest list, expands it, and clears it', async ($, on) => {
  engineBeneath(on)
  await start($)
  const band = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', ...BAND })

  const saved = await $.command.run({ ...COMMAND, args: '' })
  expect(saved.text).toBe(`Saved 3 items from Claude's latest list as "Next steps".`)
  await band.press({ key: 'toggle' })
  expect(await band.findAll({ type: 'Button', text: ROW })).toEqual([])

  const reopened = await $.command.run({ ...COMMAND, args: '' })
  expect(reopened.text).toBe('Checklist: Next steps (0/3 done).')
  expect((await band.findAll({ type: 'Button', text: ROW })).length).toBe(3)

  const cleared = await $.command.run({ ...COMMAND, args: 'clear' })
  expect(cleared.text).toBe('Checklist cleared.')
  expect(await band.find({ key: 'toggle' })).toBeUndefined()
  await band.unmount()
})

test('/checklist save takes a mouse selection, even one starting on its first marker', async ($, on) => {
  engineBeneath(on, '1. alpha\n     2. beta\n     3. gamma')
  await start($)
  const saved = await $.command.run({ ...COMMAND, args: 'save' })
  expect(saved.text).toBe('Saved 3 items from the selection as "Checklist".')
})

test('a resumed session finds its checklist in the store', async ($, on) => {
  const list = {
    title: 'Kept',
    sourceKey: 'k',
    items: [{ id: 'k-0', marker: '1.', title: 'Kept item', body: 'Kept item', isDone: true }],
  }
  engineBeneath(on, undefined, { 'list:session-1': list })
  await start($)

  const band = await $.ui.mount({ plugin: 'checklist', surface: 'terminal', ...BAND })
  expect((await band.find({ key: 'toggle' }))?.text).toMatch(/^▸ Kept 1\/1 done/)
  await band.unmount()
})
