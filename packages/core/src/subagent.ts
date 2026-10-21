/**
 * A subagentek fájljai a session transcriptje mellett (mérve, Claude Code 2.1.30x, 2026-10-21):
 *
 *   projects/<projekt>/<sessionId>/subagents/agent-<agentId>.jsonl      ← a subagent transcriptje
 *   projects/<projekt>/<sessionId>/subagents/agent-<agentId>.meta.json  ← típus, leírás, kész-e
 *
 * Nem dokumentált formátum. Ez a modul IO-mentes: a daemon olvas, itt csak értelmezünk és választunk.
 */

/**
 * Ennyi ideig számít aktívnak egy subagent az utolsó transcript-írása után, ha a meta-ja nem
 * mondja, hogy kész. Egy összeomlott (vagy régebbi verzióval futott) subagent sosem írja ki a
 * `finished`-et — enélkül örökké „futna". 5 perc: egy hosszú Bash- vagy build-futás alatt a
 * subagent nem ír, és addig se tűnjön el; ennél régebben néma subagent már nem érdekes.
 */
export const SUBAGENT_STALE_MS = 5 * 60_000

/**
 * Sessionönként legfeljebb ennyi, legutóbb írt subagentet nézünk meg. A poll ~3 mp-enként fut
 * 15–20 sessionön: a sessionönkénti olvasás így legfeljebb ennyi meta-fájl és ennyi transcript-vég.
 */
export const SUBAGENT_SCAN_LIMIT = 3

/** A subagent-transcript végéből ennyit olvasunk: az utolsó tool_use-hoz bőven elég. */
export const SUBAGENT_TAIL_BYTES = 64 * 1024

export interface SubagentMeta {
  agentType?: string | undefined
  description?: string | undefined
  /** A fő transcript `Agent` tool_use-ának azonosítója. */
  toolUseId?: string | undefined
  /** Csak a kifejezett `finished: true` jelenti, hogy kész; a futó subagentnek nincs ilyen kulcsa. */
  finished: boolean
}

export interface SubagentFile {
  agentId: string
  mtimeMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat === '' ? undefined : flat
}

/** A `meta.json` tartalma, értelmezve. Hiányzó vagy rossz típusú mező: nincs róla információ. Soha nem dob. */
export function parseSubagentMeta(raw: unknown): SubagentMeta {
  if (!isRecord(raw)) return { finished: false }
  const meta: SubagentMeta = { finished: raw['finished'] === true }
  const agentType = text(raw['agentType'])
  const description = text(raw['description'])
  const toolUseId = text(raw['toolUseId'])
  if (agentType !== undefined) meta.agentType = agentType
  if (description !== undefined) meta.description = description
  if (toolUseId !== undefined) meta.toolUseId = toolUseId
  return meta
}

/** `agent-<agentId>.jsonl` → `<agentId>`; minden más fájlnévre (a meta-ra is) `undefined`. */
export function subagentIdFromFile(fileName: string): string | undefined {
  const match = /^agent-(.+)\.jsonl$/.exec(fileName)
  return match?.[1]
}

/**
 * Az olvasásra érdemes subagent-fájlok: a `staleMs`-en belül írtak közül a legfrissebb `limit`
 * darab, a legújabb elöl. A jövőbeli `mtime` (óraeltérés) frissnek számít.
 */
export function pickRecentSubagentFiles<T extends SubagentFile>(
  files: readonly T[],
  now: number,
  limit: number = SUBAGENT_SCAN_LIMIT,
  staleMs: number = SUBAGENT_STALE_MS,
): T[] {
  return files
    .filter((file) => now - file.mtimeMs <= staleMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}
