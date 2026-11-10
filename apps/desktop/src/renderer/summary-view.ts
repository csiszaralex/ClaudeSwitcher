import { DETAILS_LIMIT } from './tool-details.js'

/** A piece of the summary: visible text, or the escape of an invisible character. */
export interface TextSegment {
  text: string
  /** True if the piece is the `⟨U+XXXX⟩` form of an invisible character; the panel highlights it. */
  hidden: boolean
}

/**
 * The invisible or text-reordering characters, except `\n` and `\t` (those are part of the
 * command, and the `<pre>` shows them):
 * - C0 and C1 controls, DEL;
 * - soft hyphen (U+00AD), Mongolian vowel separator (U+180E);
 * - zero-width marks (U+200B–U+200D, U+2060–U+2064, U+FEFF);
 * - direction marks and overrides (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069);
 * - line and paragraph separator (U+2028, U+2029);
 * - the tag block (U+E0000–U+E007F) and the variation selectors supplement (U+E0100–U+E01EF), in
 *   which text can be hidden invisibly.
 * The emoji variation selector (U+FE0F) is not included: it would break an emoji apart.
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
 * The text split into pieces: every invisible character becomes a visible `⟨U+202E⟩`. So no part
 * of a command can hide behind a direction override or a zero-width space.
 */
export function revealInvisible(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let visible = ''
  // By code point, so that the tag block's characters of two UTF-16 units stay whole.
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

/** How many lines the text has. Above one the panel header shows an "N lines" mark. */
export function lineCount(text: string): number {
  return text.split('\n').length
}

export interface SummaryView {
  segments: TextSegment[]
  /** The line count of the WHOLE summary, the cut part included. */
  lines: number
  /** True if the display was cut at `limit`. The data itself stays complete. */
  truncated: boolean
}

/**
 * The summary's display. A heredoc command of several hundred kilobytes shown whole in the `<pre>`
 * would freeze the overlay, so the visible part is cut at `DETAILS_LIMIT`.
 */
export function summaryView(summary: string, limit: number = DETAILS_LIMIT): SummaryView {
  const truncated = summary.length > limit
  return {
    segments: revealInvisible(truncated ? summary.slice(0, limit) : summary),
    lines: lineCount(summary),
    truncated,
  }
}
