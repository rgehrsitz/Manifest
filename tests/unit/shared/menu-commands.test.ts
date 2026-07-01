import { describe, expect, it } from 'vitest'
import {
  MENU_COMMAND_IDS,
  createDisabledMenuCommandState,
  isMenuCommandId,
  normalizeMenuCommandState,
} from '../../../src/shared/menu-commands'

describe('menu command state', () => {
  it('starts renderer-driven commands disabled', () => {
    const state = createDisabledMenuCommandState()

    expect(Object.keys(state).sort()).toEqual([...MENU_COMMAND_IDS].sort())
    expect(Object.values(state).every(enabled => enabled === false)).toBe(true)
  })

  it('normalizes unknown or missing renderer state to disabled commands', () => {
    expect(normalizeMenuCommandState(null)).toEqual(createDisabledMenuCommandState())
    expect(normalizeMenuCommandState({ 'project:open': true, unknown: true })).toEqual({
      ...createDisabledMenuCommandState(),
      'project:open': true,
    })
  })

  it('recognizes only declared native menu command ids', () => {
    expect(isMenuCommandId('project:open')).toBe(true)
    expect(isMenuCommandId('project:missing')).toBe(false)
    expect(isMenuCommandId(null)).toBe(false)
  })
})
