// Generic helpers of the Hungarian GUI texts, for any sentence.

/**
 * The Hungarian definite article before a text that starts with a number read aloud (a version, a
 * line number): "az" when the spoken number starts with a vowel, else "a". Only the leading digits
 * count, so "1.2.3" goes by its major version. Hungarian reads a number in groups of three digits,
 * so its first word comes from the leading group: a leading group of exactly 1 is "egy" (1,
 * "egymillió") or "ezer" (1000..1999), and one that starts with 5 is "öt", "ötven…" or "ötszáz…";
 * every other first word ("nulla", "kettő", "tíz", "tizen…", "száz", …) starts with a consonant. A
 * text without a leading number gets "a".
 */
export function numberArticle(text: string): 'a' | 'az' {
  const number = /^\d+/.exec(text)?.[0].replace(/^0+(?=\d)/, '')
  if (number === undefined) return 'a'
  const leadingGroup = number.slice(0, ((number.length - 1) % 3) + 1)
  return leadingGroup === '1' || leadingGroup.startsWith('5') ? 'az' : 'a'
}

/** The phrase with its first letter in upper case, to start a sentence ("A terminálban …", "Az 1. sor …"). */
export function capitalized(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * The Hungarian weekday names, in the order `Date.getDay` counts them (Sunday first): the usage
 * limit's texts (`renderer/usage-limit.ts`), and the time phrases and the tags of a timed exclusion
 * (`renderer/until-time.ts`).
 */
export const WEEKDAY_NAMES: readonly string[] = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat']
