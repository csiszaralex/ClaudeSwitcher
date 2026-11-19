import { describe, expect, it } from 'vitest'
import { nameTooltip, otherName, sessionName } from './session-name.js'

describe('sessionName', () => {
  it('shows the tab title over the daemon name', () => {
    expect(sessionName({ name: 'alpha-3f', activity: { tabTitle: 'Számlázás átírása' } })).toBe('Számlázás átírása')
  })

  it('falls back to the daemon name without a tab title, or with an empty one', () => {
    expect(sessionName({ name: 'alpha-3f', activity: {} })).toBe('alpha-3f')
    expect(sessionName({ name: 'alpha-3f', activity: { tabTitle: '' } })).toBe('alpha-3f')
    expect(sessionName({ name: 'alpha-3f' })).toBe('alpha-3f')
  })

  it('is empty without either, as the row was before', () => {
    expect(sessionName({})).toBe('')
    expect(sessionName({ name: '', activity: { tabTitle: '' } })).toBe('')
  })

  it('ignores a field of the wrong type, which the daemon message may carry unchecked', () => {
    expect(sessionName({ name: 'alpha-3f', activity: { tabTitle: { text: 'x' } } })).toBe('alpha-3f')
    expect(sessionName({ name: 42, activity: { tabTitle: 7 } })).toBe('')
  })
})

describe('otherName and nameTooltip', () => {
  it('name the daemon name on a second line when the tab title is shown instead', () => {
    const session = { name: 'alpha-3f', activity: { tabTitle: 'Számlázás átírása' } }
    expect(otherName(session)).toBe('alpha-3f')
    expect(nameTooltip(session)).toBe('Számlázás átírása\nMás néven: alpha-3f')
  })

  it('add nothing when the shown name is the daemon name', () => {
    for (const session of [{ name: 'alpha-3f' }, { name: 'alpha-3f', activity: { tabTitle: 'alpha-3f' } }]) {
      expect(otherName(session)).toBeUndefined()
      expect(nameTooltip(session)).toBe('alpha-3f')
    }
  })

  it('add nothing without a daemon name', () => {
    expect(otherName({ activity: { tabTitle: 'Számlázás átírása' } })).toBeUndefined()
    expect(nameTooltip({ activity: { tabTitle: 'Számlázás átírása' } })).toBe('Számlázás átírása')
  })
})
