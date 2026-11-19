/**
 * Small guards for untrusted input (hook body, registry file, IPC, WebSocket message), used
 * everywhere. IO-free, also exported by the `/browser` entry point.
 */

/** True for an object that is neither `null` nor an array, so it can be read by key. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A JSON line (a transcript line) as a record, or `undefined` for an empty, broken or non-object line. Never throws. */
export function parseRecordLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The string if it is not empty, otherwise `undefined`. A whitespace-only string passes. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** One-line text: whitespace and line breaks collapsed to one space, both ends trimmed. `undefined` when empty. */
export function flatText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat === '' ? undefined : flat
}

/** The text cut to at most `max` characters: a longer one keeps `max - 1` and ends in `…`. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The last non-empty segment of a path, split on both `/` and `\`. `undefined` when there is none. */
export function lastPathSegment(path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1]
}
