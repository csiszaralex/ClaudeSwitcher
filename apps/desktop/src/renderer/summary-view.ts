import { DETAILS_LIMIT } from './tool-details.js'

/** Az összefoglaló egy darabja: látható szöveg, vagy egy láthatatlan karakter escape-je. */
export interface TextSegment {
  text: string
  /** Igaz, ha a darab egy láthatatlan karakter `⟨U+XXXX⟩` alakja; a panel kiemelve mutatja. */
  hidden: boolean
}

/**
 * A láthatatlan vagy a szöveget átrendező karakterek, a `\n` és a `\t` kivételével (azok a
 * parancs részei, a `<pre>` meg is mutatja őket):
 * - C0 és C1 vezérlők, DEL;
 * - feltételes elválasztó (U+00AD), mongol magánhangzó-elválasztó (U+180E);
 * - nulla szélességű jelek (U+200B–U+200D, U+2060–U+2064, U+FEFF);
 * - irányjelek és felülírások (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069);
 * - sor- és bekezdéselválasztó (U+2028, U+2029);
 * - a címke-blokk (U+E0000–U+E007F) és a kiegészítő változatválasztók (U+E0100–U+E01EF), amelyekbe
 *   láthatatlanul szöveg rejthető.
 * Az emoji változatválasztója (U+FE0F) nem tartozik ide: egy emojit tördelne szét.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
]

function isInvisible(code: number): boolean {
  return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to)
}

function escape(code: number): string {
  return `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`
}

/**
 * A szöveg darabokra bontva: a láthatatlan karakterek mindegyike egy látható `⟨U+202E⟩` lesz.
 * Egy irányfelülírás vagy egy nulla szélességű szóköz mögé így nem bújhat el egy parancsrész.
 */
export function revealInvisible(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let visible = ''
  // Kódpontonként, hogy a címke-blokk két UTF-16 egységből álló karakterei is egyben maradjanak.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (!isInvisible(code)) {
      visible += char
      continue
    }
    if (visible !== '') segments.push({ text: visible, hidden: false })
    visible = ''
    segments.push({ text: escape(code), hidden: true })
  }
  if (visible !== '') segments.push({ text: visible, hidden: false })
  return segments
}

/** Hány sorból áll a szöveg. A panel efölött egy „N sor" jelzést mutat. */
export function lineCount(text: string): number {
  return text.split('\n').length
}

export interface SummaryView {
  segments: TextSegment[]
  /** A TELJES összefoglaló sorainak száma, a levágott részé is. */
  lines: number
  /** Igaz, ha a megjelenítés a `limit`-nél levágódott. Az adat maga teljes marad. */
  truncated: boolean
}

/**
 * Az összefoglaló megjelenítése. Egy heredoc-os, több száz kilobájtos parancs egészében a
 * `<pre>`-ben megfagyasztaná az overlayt, ezért a látható rész `DETAILS_LIMIT`-nél vágódik.
 */
export function summaryView(summary: string, limit: number = DETAILS_LIMIT): SummaryView {
  const truncated = summary.length > limit
  return {
    segments: revealInvisible(truncated ? summary.slice(0, limit) : summary),
    lines: lineCount(summary),
    truncated,
  }
}
