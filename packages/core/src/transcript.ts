import { open, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { SessionActivity } from './types.js'

interface ContentBlock {
  type?: unknown
  text?: unknown
  name?: unknown
}

function blocks(rec: Record<string, unknown>): ContentBlock[] {
  const message = rec['message']
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return []
  // A nem-objektum elemeket itt dobjuk el, nem a hívóban. Egy `null` blokk
  // valid JSON, és a `.type` olvasása rajta TypeError-t dobna — pontosan az a
  // fajta összeomlás, amit ennek a modulnak meg kell előznie.
  return content.filter(
    (block): block is ContentBlock => typeof block === 'object' && block !== null,
  )
}

/**
 * A transcript utolsó soraiból kiolvassa, mit csinál épp a session.
 * Ismeretlen rekordtípus némán kimarad — a formátum bővül, és egy új típus
 * nem törheti el a monitort.
 */
export function readActivityFromLines(lines: string[]): SessionActivity {
  const activity: SessionActivity = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    let rec: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) continue
      rec = parsed as Record<string, unknown>
    } catch {
      continue
    }

    const at = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN
    if (!Number.isNaN(at)) activity.lastEventAt = at

    if (rec['type'] === 'assistant') {
      for (const block of blocks(rec)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          activity.lastAssistantText = block.text.trim()
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          activity.runningTool = block.name
        }
      }
    } else if (rec['type'] === 'user') {
      // Egy tool_result lezárja a futó toolt.
      if (blocks(rec).some((b) => b.type === 'tool_result')) {
        activity.runningTool = undefined
      }
    }
  }

  return activity
}

/**
 * Megkeresi a session transcriptjét. Szándékosan glob-bal, nem a cwd-ből
 * képzett könyvtárnévvel: a kódolás nem dokumentált és változhat.
 */
export async function findTranscriptPath(
  claudeDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const projects = path.join(claudeDir, 'projects')
  let entries: string[]
  try {
    entries = await readdir(projects)
  } catch {
    return undefined
  }

  for (const entry of entries) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`)
    try {
      const handle = await open(candidate, 'r')
      try {
        // A puszta megnyithatóság nem elég: egy `<sessionId>.jsonl` nevű
        // *könyvtár* is megnyílik, és utána a tailLines vagy üres eredményt ad,
        // vagy EISDIR-rel száll el. A típusát is meg kell nézni.
        if ((await handle.stat()).isFile()) return candidate
      } finally {
        await handle.close()
      }
    } catch {
      // Nem létezik, vagy nem olvasható. A kettőt nem különböztetjük meg: a
      // visszatérési szerződés `string | undefined`, és egy jogosultsági hiba
      // ugyanúgy azt jelenti, hogy ezt a transcriptet nem tudjuk olvasni.
      continue
    }
  }
  return undefined
}

/** A fájl utolsó `maxBytes` bájtját olvassa, és eldobja az első, csonka sort. */
export async function tailLines(filePath: string, maxBytes = 256 * 1024): Promise<string[]> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length === 0) return []

    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines
  } catch (error) {
    // Egy I/O hiba vagy allocation failure-t nem szabad feldobni: a hívó
    // (pl. scanSessions) helyzete az, hogy best-effort-ként működjön. Az
    // allocationt csak szintetikus tesztből tudjuk kiváltani.
    console.error(`[transcript] tailLines failed for ${filePath}`, error)
    return []
  } finally {
    await handle.close()
  }
}
