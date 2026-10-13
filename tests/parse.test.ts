import { describe, expect, test } from 'claude-code/testing'

import { findLists, normalizeSelection, pickChecklist, shortTitle } from '../hooks/parse'

const REPLY = `Done with the refactor. Remaining work:

## Next steps

1. **Fix the auth bug** - the token refresh races with logout.
   - Add a mutex around refresh
   - Cover it with a test
2. Update the README: document the new \`--dry-run\` flag
3. Run \`npm run lint\` and fix the warnings

Let me know which to start with.`

describe('pickChecklist', () => {
  test('takes a numbered list with its heading, short titles and full bodies', () => {
    const list = pickChecklist(REPLY, 2)
    expect(list?.title).toBe('Next steps')
    expect(list?.items.map(item => item.title)).toEqual([
      'Fix the auth bug',
      'Update the README',
      'Run npm run lint and fix the warnings',
    ])
    expect(list?.items.map(item => item.marker)).toEqual(['1.', '2.', '3.'])
    expect(list?.items[0]?.body).toBe(
      '**Fix the auth bug** - the token refresh races with logout.\n- Add a mutex around refresh\n- Cover it with a test',
    )
    expect(list?.items.every(item => !item.isDone)).toBe(true)
  })

  test('prefers the last numbered list over a later bulleted one', () => {
    const text = `Changes:\n- a\n- b\n\nTodo:\n1. first\n2. second\n\nNotes:\n- x\n- y`
    expect(pickChecklist(text, 2)?.items.map(item => item.title)).toEqual(['first', 'second'])
    expect(pickChecklist(text, 2)?.title).toBe('Todo')
  })

  test('keeps paragraphs separated by blank lines inside an item', () => {
    const text = `1. One\n\n   More about one.\n\n2. Two\n\nAfter the list.`
    const list = pickChecklist(text, 2)
    expect(list?.items.map(item => item.body)).toEqual(['One\n\nMore about one.', 'Two'])
  })

  test('ignores markers inside code fences', () => {
    const text = '```\n1. not a task\n2. nor this\n```\n\nNothing else.'
    expect(pickChecklist(text, 1)).toBe(null)
  })

  test('reads task boxes as done or not', () => {
    const list = pickChecklist('- [x] shipped it\n- [ ] write docs', 2)
    expect(list?.items.map(item => [item.title, item.isDone])).toEqual([
      ['shipped it', true],
      ['write docs', false],
    ])
  })

  test('reads a mouse selection of a drawn reply', () => {
    const selected = '⏺ Plan:\n\n  1. Rename the table\n     and migrate data\n  2. Drop the old view'
    const list = pickChecklist(selected, 2)
    expect(list?.title).toBe('Plan')
    expect(list?.items[0]?.body).toBe('Rename the table\nand migrate data')
  })

  test('is stable: the same list hashes to the same key', () => {
    expect(pickChecklist(REPLY, 2)?.sourceKey).toBe(pickChecklist(REPLY, 2)?.sourceKey)
    expect(pickChecklist(REPLY, 2)?.sourceKey).not.toBe(pickChecklist('1. a\n2. b', 2)?.sourceKey)
  })

  test('answers null with too few items', () => {
    expect(pickChecklist('- only one', 2)).toBe(null)
    expect(findLists('just prose')).toEqual([])
  })
})

describe('shortTitle', () => {
  test('cuts at the first clause, keeps short lines whole', () => {
    expect(shortTitle('Bump the SDK. It fixes the retry bug.')).toBe('Bump the SDK')
    expect(shortTitle('Ship it')).toBe('Ship it')
    expect(shortTitle('**Migrate:** move the cron jobs')).toBe('Migrate')
  })
})

describe('normalizeSelection', () => {
  test('gives a selection that starts on its first marker that line\'s indent back', () => {
    const selected = '1. Extract the ledger\n        - Define it\n     2. Add keys\n     3. Backfill'
    expect(pickChecklist(selected, 1)?.items.length).toBe(1)
    expect(pickChecklist(normalizeSelection(selected), 2)?.items.map(item => item.title)).toEqual([
      'Extract the ledger',
      'Add keys',
      'Backfill',
    ])
  })

  test('drops the glyph a command output row is drawn with', () => {
    const selected = '  ⎿  Plan:\n\n     1. one\n     2. two'
    expect(pickChecklist(normalizeSelection(selected), 2)?.title).toBe('Plan')
  })

  test('leaves an already aligned selection alone', () => {
    expect(normalizeSelection('  1. a\n  2. b')).toBe('  1. a\n  2. b')
  })
})
