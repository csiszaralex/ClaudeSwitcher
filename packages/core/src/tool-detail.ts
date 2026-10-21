/**
 * Ennyi karakter lehet legfeljebb egy futó tool részlete. A sor összefoglalója úgyis 80
 * karakterben áll meg, és a részlet előtt még a tool (és a subagent) neve is ott van.
 */
export const TOOL_DETAIL_MAX = 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat === '' ? undefined : flat
}

/** Egy útvonal utolsó tagja: a sorban a fájlnév mond valamit, a teljes út csak hosszú. */
function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? filePath
}

/**
 * Röviden, min dolgozik egy tool: a parancs, a keresett minta, a fájl neve, az URL, a keresés, a
 * subagent leírása vagy a skill neve — az első, ami van. Egysoros és `TOOL_DETAIL_MAX`-ra vágott.
 *
 * A tool_input nem dokumentált és toolonként más, ezért a mezők szerint megy, nem a tool neve
 * szerint: egy új tool, amelynek ugyanilyen mezője van, magától is kap részletet. Ha semmi nem
 * illik, nincs részlet — soha nem dob.
 */
export function toolDetail(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const path = text(input['file_path']) ?? text(input['notebook_path'])
  const raw =
    text(input['command']) ??
    text(input['pattern']) ??
    (path === undefined ? undefined : baseName(path)) ??
    text(input['url']) ??
    text(input['query']) ??
    text(input['description']) ??
    text(input['skill'])
  if (raw === undefined) return undefined
  return raw.length > TOOL_DETAIL_MAX ? `${raw.slice(0, TOOL_DETAIL_MAX - 1)}…` : raw
}
