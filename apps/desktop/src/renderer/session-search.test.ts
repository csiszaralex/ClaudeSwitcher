import { describe, expect, it } from 'vitest'
import { filterRows, foldForSearch, isSearchChord, matchesQuery, searchKeys, type SearchableRow } from './session-search.js'

// Invented sessions in the shape the list's rows have.
const hub: SearchableRow = {
  name: 'Kiadás előkészítése',
  session: { name: 'hub-5c', cwd: String.raw`P:\proj\hub\packages\core`, workspaceFolder: String.raw`P:\proj\hub` },
}
const crm: SearchableRow = { name: 'CRM master', session: { name: 'CRM master', cwd: String.raw`P:\proj\crm` } }
const offers: SearchableRow = { name: 'Ajánlatok átnézése', session: { name: 'offers-1a', cwd: String.raw`P:\proj\offers` } }
const country: SearchableRow = { name: 'Ország lista', session: { name: 'geo-2b', cwd: String.raw`P:\proj\geo` } }
const mason: SearchableRow = { name: 'Kőműves űrlap', session: { name: 'forms-3c', cwd: String.raw`P:\proj\forms` } }
const ROWS = [hub, crm, offers, country, mason]

describe('foldForSearch', () => {
  it('drops case and accents, Hungarian letters included', () => {
    expect(foldForSearch('ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP')).toBe('arvizturo tukorfurogep')
    expect(foldForSearch('árvíztűrő tükörfúrógép')).toBe('arvizturo tukorfurogep')
    expect(foldForSearch('Ő ő Ű ű')).toBe('o o u u')
  })

  it('folds a precomposed and a decomposed letter alike', () => {
    expect(foldForSearch('\u00e1')).toBe(foldForSearch('a\u0301'))
  })
})

describe('searchKeys', () => {
  it('holds the shown name, the daemon name and the project folder', () => {
    expect(searchKeys(hub)).toEqual(['Kiadás előkészítése', 'hub-5c', 'hub'])
  })

  it('takes the folder from cwd without a workspace folder', () => {
    expect(searchKeys(offers)).toEqual(['Ajánlatok átnézése', 'offers-1a', 'offers'])
  })

  it('skips fields that are missing, empty or of the wrong type', () => {
    expect(searchKeys({ name: 'alpha' })).toEqual(['alpha'])
    expect(searchKeys({ name: '', session: { name: 3, cwd: {}, workspaceFolder: '' } })).toEqual([])
  })
})

describe('matchesQuery', () => {
  it('finds the hub session by its folder, its daemon name and its tab title', () => {
    for (const query of ['hub', 'hub-5c', 'Kiadás', 'kiadas', 'ELOKESZ']) expect(matchesQuery(hub, query)).toBe(true)
  })

  it('matches a substring, case and accent insensitive', () => {
    expect(matchesQuery(crm, 'crm')).toBe(true)
    expect(matchesQuery(crm, 'master')).toBe(true)
    expect(matchesQuery(offers, 'ajanlat')).toBe(true)
    expect(matchesQuery(country, 'orszag')).toBe(true)
    expect(matchesQuery(mason, 'komuves')).toBe(true)
    expect(matchesQuery(mason, 'urlap')).toBe(true)
    expect(matchesQuery(mason, 'KŐMŰ')).toBe(true)
  })

  it('also finds an accented name by an accented query typed decomposed', () => {
    expect(matchesQuery(offers, 'Aja\u0301nlat')).toBe(true)
  })

  it('does no fuzzy matching', () => {
    expect(matchesQuery(crm, 'cmr')).toBe(false)
    expect(matchesQuery(crm, 'crm  master')).toBe(false)
    expect(matchesQuery(offers, 'ajnlat')).toBe(false)
  })

  it('matches every row with an empty or blank query, and trims the query', () => {
    expect(matchesQuery(crm, '')).toBe(true)
    expect(matchesQuery(crm, '   ')).toBe(true)
    expect(matchesQuery(crm, ' crm ')).toBe(true)
  })
})

describe('filterRows', () => {
  it('keeps the matching rows in their order', () => {
    expect(filterRows(ROWS, 'o').map((row) => row.name)).toEqual(['Kiadás előkészítése', 'Ajánlatok átnézése', 'Ország lista', 'Kőműves űrlap'])
    expect(filterRows(ROWS, 'zzz')).toEqual([])
    expect(filterRows(ROWS, '')).toEqual(ROWS)
  })
})

describe('isSearchChord', () => {
  const key = (k: string, extra: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => ({
    key: k,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...extra,
  })

  it('is Ctrl+K, with or without Shift', () => {
    expect(isSearchChord(key('k', { ctrlKey: true }))).toBe(true)
    expect(isSearchChord(key('K', { ctrlKey: true }))).toBe(true)
  })

  it('is not a plain K, nor Ctrl+Alt+K (AltGr), nor another Ctrl key', () => {
    expect(isSearchChord(key('k'))).toBe(false)
    expect(isSearchChord(key('k', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isSearchChord(key('k', { ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isSearchChord(key('j', { ctrlKey: true }))).toBe(false)
  })
})
