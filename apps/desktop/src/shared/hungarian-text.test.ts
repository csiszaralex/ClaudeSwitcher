import { describe, expect, it } from 'vitest'
import { capitalized, numberArticle } from './hungarian-text.js'

describe('numberArticle', () => {
  it('gives "az" when the leading number read in Hungarian starts with a vowel, else "a"', () => {
    const article = (major: number): string => numberArticle(`${String(major)}.2.3`)
    // "egy", "öt", "ötven…", "ötszáz…", "ezer…", "ötezer", "egymillió".
    for (const major of [1, 5, 50, 59, 500, 599, 1000, 1999, 5000, 1000000]) expect(article(major), String(major)).toBe('az')
    // "nulla", "kettő", "tíz", "tizenegy", "tizenöt", "hatvan", "száz", "hatszáz", "kétezer", "tízezer".
    for (const major of [0, 2, 10, 11, 15, 60, 100, 600, 2000, 10000]) expect(article(major), String(major)).toBe('a')
  })

  it('reads a bare line number the same way', () => {
    expect(['1', '5', '12', '51'].map(numberArticle)).toEqual(['az', 'az', 'a', 'az'])
  })

  it('gives "a" for a text without a leading number', () => {
    expect(numberArticle('next')).toBe('a')
  })
})

describe('capitalized', () => {
  it('starts a sentence with the phrase, accented letters included', () => {
    expect(capitalized('a terminálban')).toBe('A terminálban')
    expect(capitalized('új')).toBe('Új')
    expect(capitalized('')).toBe('')
  })
})
