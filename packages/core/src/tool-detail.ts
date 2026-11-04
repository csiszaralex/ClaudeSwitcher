import { flatText, isRecord, lastPathSegment, truncate } from './guards.js'

/**
 * The longest a running tool's detail may be. The row summary stops at `ROW_TEXT_MAX` (renderer
 * `format.ts`) anyway, and the tool's (and the subagent's) name comes before the detail.
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
  return raw === undefined ? undefined : truncate(raw, TOOL_DETAIL_MAX)
}
