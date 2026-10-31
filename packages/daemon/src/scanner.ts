import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type LiveSession,
  type ProcessProbe,
  type SessionActivity,
  type SessionRecord,
  type SubagentMeta,
  type SubagentView,
  type IdeLock,
  SUBAGENT_META_LIMIT,
  SUBAGENT_SCAN_LIMIT,
  SUBAGENT_TAIL_BYTES,
  findTranscriptPath,
  ideDir,
  parseIdeLock,
  parseSessionRecord,
  parseSubagentMeta,
  pickRecentSubagentFiles,
  readActivityFromLines,
  resolveLiveSessions,
  sessionsDir,
  subagentIdFromFile,
  tailLines,
} from '@claudeswitcher/core'

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readRecords(claudeDir: string): Promise<SessionRecord[]> {
  const dir = sessionsDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.json'))
  const records = await Promise.all(
    names.map(async (name) => parseSessionRecord(await readJson(path.join(dir, name)))),
  )
  return records.filter((r): r is SessionRecord => r !== null)
}

/** A fájl utolsó írása (ms), vagy `undefined`, ha nem kérdezhető le. Soha nem dob. */
async function mtimeOf(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Az IDE lock fájlok, mindegyik az utolsó írása idejével (`mtimeMs`). Az idő a pid-újrahasznosítás
 * felismeréséhez kell (lásd core `lockPredatesProcess`). Csak olvasunk: a `~/.claude` nem a miénk,
 * egy elavult lockot sem törlünk, csak nem párosítunk vele.
 */
async function readLocks(claudeDir: string): Promise<IdeLock[]> {
  const dir = ideDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.lock'))
  const locks = await Promise.all(
    names.map(async (name): Promise<IdeLock | null> => {
      const port = Number.parseInt(path.basename(name, '.lock'), 10)
      if (Number.isNaN(port)) return null
      const file = path.join(dir, name)
      const [raw, mtimeMs] = await Promise.all([readJson(file), mtimeOf(file)])
      const lock = parseIdeLock(raw, port)
      return lock === null ? null : { ...lock, mtimeMs }
    }),
  )
  return locks.filter((l): l is IdeLock => l !== null)
}

/**
 * Az útvonalak, amelyek hibájáról már szóltunk. A poll 3 másodpercenként fut: egy tartósan
 * olvashatatlan fájl különben percenként húszszor írná tele a logot ugyanazzal.
 */
const reported = new Set<string>()

function reportOnce(filePath: string, what: string, error: unknown): void {
  if (reported.has(filePath)) return
  reported.add(filePath)
  console.error(`[scan] ${what} failed for ${filePath}`, error)
}

/** Nincs ilyen fájl vagy könyvtár: subagenteknél ez a normális eset, nem hiba. */
function isMissing(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function readSubagentMeta(metaPath: string): Promise<SubagentMeta> {
  let raw: string
  try {
    raw = await readFile(metaPath, 'utf8')
  } catch (error) {
    // Hiányzó meta: nincs címke, de a subagent attól még futhat, az elavulási ablak határolja.
    if (!isMissing(error)) reportOnce(metaPath, 'subagent meta read', error)
    return { finished: false }
  }
  try {
    return parseSubagentMeta(JSON.parse(raw))
  } catch (error) {
    reportOnce(metaPath, 'subagent meta parse', error)
    return { finished: false }
  }
}

/**
 * A session aktív subagentjei, a legutóbb írt elöl. Költség pollonként: egy readdir, egy stat
 * minden `agent-*.jsonl`-re (a legfrissebbek kiválasztásához kell), legfeljebb
 * `SUBAGENT_META_LIMIT` meta-olvasás az elavulási ablakon belül, és a transcript vége csak a
 * legfrissebb `SUBAGENT_SCAN_LIMIT` NEM KÉSZ subagentnél. Soha nem dob: egy hibás fájl csak a
 * saját subagentjét viszi el.
 *
 * @param heldAgents a függő döntéssel bíró subagentek. Ezek koruktól és a korláttól függetlenül
 * bekerülnek: egy engedélyre váró subagent nem ír, így az elavulási ablak után a címkéje eltűnne a
 * döntési panelről. A plusz költség legfeljebb függő döntésenként egy meta és egy transcript-vég.
 */
async function readSubagents(
  transcript: string,
  now: number,
  heldAgents: ReadonlySet<string>,
): Promise<SubagentView[]> {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (!isMissing(error)) reportOnce(dir, 'subagent listing', error)
    return []
  }

  const files = await Promise.all(
    names.map(async (name) => {
      const agentId = subagentIdFromFile(name)
      if (agentId === undefined) return undefined
      const file = path.join(dir, name)
      try {
        const info = await stat(file)
        return info.isFile() ? { agentId, mtimeMs: info.mtimeMs, file } : undefined
      } catch (error) {
        // A readdir és a stat között törölt fájl normális; minden más egyszer a logba.
        if (!isMissing(error)) reportOnce(file, 'subagent stat', error)
        return undefined
      }
    }),
  )
  const listed = files.filter((file) => file !== undefined)
  // Előbb a kész subagentek kiszűrése, CSAK utána a darabszám-korlát: különben néhány frissen
  // befejezett subagent eltakarná a még futót (lásd SUBAGENT_META_LIMIT).
  const recent = pickRecentSubagentFiles(listed, now, SUBAGENT_META_LIMIT)
  const held = listed.filter((file) => heldAgents.has(file.agentId) && !recent.includes(file))
  const withMeta = await Promise.all(
    [...recent, ...held].map(async (candidate) => ({
      ...candidate,
      meta: await readSubagentMeta(path.join(dir, `agent-${candidate.agentId}.meta.json`)),
    })),
  )
  const unfinished = withMeta.filter(({ meta }) => !meta.finished)
  const limited = unfinished.filter(({ agentId }) => !heldAgents.has(agentId)).slice(0, SUBAGENT_SCAN_LIMIT)
  // A függő döntésű subagent a korláton felül is marad; a sorrend a legutóbb írt elöl.
  const active = unfinished
    .filter((candidate) => heldAgents.has(candidate.agentId) || limited.includes(candidate))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return Promise.all(
    active.map(async ({ agentId, mtimeMs, file, meta }): Promise<SubagentView> => {
      const activity = readActivityFromLines(await tailLines(file, SUBAGENT_TAIL_BYTES))
      return {
        agentId,
        agentType: meta.agentType,
        description: meta.description,
        runningTool: activity.runningTool,
        toolDetail: activity.toolDetail,
        updatedAt: mtimeMs,
      }
    }),
  )
}

/** Egy session olvasott állapota: a fő transcript aktivitása és az aktív subagentjei. */
interface SessionReading {
  activity: SessionActivity
  subagents: SubagentView[]
}

/**
 * Egy teljes állapot-pillanatkép: élő sessionök, párosított ablakok, aktivitás, aktív subagentek.
 *
 * @param heldAgents azon subagentek `agentId`-ja, amelyeknek most függő döntésük van (a daemon a
 * brokertől veszi). Ezek akkor is bekerülnek, ha régen írtak; lásd `readSubagents`.
 */
export async function scanSessions(
  claudeDir: string,
  probe: ProcessProbe,
  now: number = Date.now(),
  heldAgents: ReadonlySet<string> = new Set(),
): Promise<{
  sessions: LiveSession[]
  activities: Map<string, SessionActivity>
  /** Csak a legalább egy aktív subagenttel bíró sessionök szerepelnek benne. */
  subagents: Map<string, SubagentView[]>
}> {
  // A probe szinkron válaszai a legutóbbi pillanatképből jönnek, ezért előbb frissítünk,
  // a fájlolvasással párhuzamosan. A frissítés nem blokkol, és soha nem utasít el.
  const [records, locks] = await Promise.all([readRecords(claudeDir), readLocks(claudeDir), probe.refresh()])
  const sessions = resolveLiveSessions(records, locks, probe)

  const entries = await Promise.all(
    sessions.map(async ({ record }): Promise<[string, SessionReading]> => {
      try {
        const transcript = await findTranscriptPath(claudeDir, record.sessionId)
        if (transcript === undefined) return [record.sessionId, { activity: {}, subagents: [] }]
        const [lines, subagents] = await Promise.all([tailLines(transcript), readSubagents(transcript, now, heldAgents)])
        return [record.sessionId, { activity: readActivityFromLines(lines), subagents }]
      } catch (error) {
        // Védelem mélységben. A `Promise.all` egyetlen elutasításra eldobná az
        // egész szkennelést, vagyis MINDEN session eltűnne a listáról egy
        // olvashatatlan transcript miatt. A hívottak már best-effortok; ez arra
        // véd, ha egy későbbi módosítás behoz ide valami dobni képeset.
        console.error(`[scan] activity read failed for ${record.sessionId}`, error)
        return [record.sessionId, { activity: {}, subagents: [] }]
      }
    }),
  )

  return {
    sessions,
    activities: new Map(entries.map(([id, reading]) => [id, reading.activity])),
    subagents: new Map(
      entries.filter(([, reading]) => reading.subagents.length > 0).map(([id, reading]) => [id, reading.subagents]),
    ),
  }
}
