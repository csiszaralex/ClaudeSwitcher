import { flatText, isRecord, lastPathSegment, truncate } from './guards.js'

/**
 * The longest a running tool's detail may be. The row summary stops at `ROW_TEXT_MAX` (renderer
 * `format.ts`) anyway, and the tool's (and the subagent's) name comes before the detail.
 */
export const TOOL_DETAIL_MAX = 60

/**
 * In short, what a tool is working on: the command, the search pattern, the file name, the URL, the
 * query, the subagent's description or the skill name, whichever comes first. One line, cut to
 * `TOOL_DETAIL_MAX`.
 *
 * `tool_input` is undocumented and differs per tool, so this goes by the fields, not by the tool
 * name: a new tool with the same field gets a detail on its own. When nothing fits there is no
 * detail; it never throws.
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
