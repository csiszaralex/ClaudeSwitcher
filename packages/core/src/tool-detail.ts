import { flatText, isRecord, lastPathSegment } from './guards.js'

/**
 * Ennyi karakter lehet legfeljebb egy futó tool részlete. A sor összefoglalója úgyis 80
 * karakterben áll meg, és a részlet előtt még a tool (és a subagent) neve is ott van.
 */
export const TOOL_DETAIL_MAX = 60

/**
 * Röviden, min dolgozik egy tool: a parancs, a keresett minta, a fájl neve, az URL, a keresés, a
 * subagent leírása vagy a skill neve: az első, ami van. Egysoros és `TOOL_DETAIL_MAX`-ra vágott.
 *
 * A tool_input nem dokumentált és toolonként más, ezért a mezők szerint megy, nem a tool neve
 * szerint: egy új tool, amelynek ugyanilyen mezője van, magától is kap részletet. Ha semmi nem
 * illik, nincs részlet, és soha nem dob.
 */
export function toolDetail(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const path = flatText(input['file_path']) ?? flatText(input['notebook_path'])
  const raw =
    flatText(input['command']) ??
    flatText(input['pattern']) ??
    (path === undefined ? undefined : (lastPathSegment(path) ?? path)) ??
    flatText(input['url']) ??
    flatText(input['query']) ??
    flatText(input['description']) ??
    flatText(input['skill'])
  if (raw === undefined) return undefined
  return raw.length > TOOL_DETAIL_MAX ? `${raw.slice(0, TOOL_DETAIL_MAX - 1)}…` : raw
}
