/** Nyers rekord a ~/.claude/sessions/<pid>.json fájlból. Nem dokumentált formátum. */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart?: string | undefined
  version?: string | undefined
  kind?: string | undefined
  entrypoint?: string | undefined
  name?: string | undefined
  bridgeSessionId?: string | null | undefined
  /**
   * A session állapota a Claude Code szerint (2.1.296+, mérve: `idle`, `busy`, `waiting`).
   * Nem dokumentált, ezért nyers szövegként tartjuk meg — egy ismeretlen új érték se dobjon el
   * semmit; a fogyasztó csak az általa ismert értékekre reagál.
   */
  status?: string | undefined
  /** Mire vár (`permission prompt`), ha `status === 'waiting'`; különben `null` vagy hiányzik. */
  waitingFor?: string | null | undefined
  /** Mikor váltott utoljára a `status` (epoch ms). */
  statusUpdatedAt?: number | undefined
}

/** Nyers rekord a ~/.claude/ide/<port>.lock fájlból. Nem dokumentált formátum. */
export interface IdeLock {
  port: number
  pid: number
  workspaceFolders: string[]
  ideName?: string | undefined
  transport?: string | undefined
  /**
   * A lock fájl utolsó írása (epoch ms, a fájl `mtimeMs`-e), ha a szkenner le tudta kérdezni.
   * Nem a fájl tartalmából jön: a lock nem tárol időt. Ebből látszik, ha a pid azóta egy később
   * indult processzé lett (lásd `lockPredatesProcess`).
   */
  mtimeMs?: number | undefined
}

export type SessionStatus = 'waiting' | 'working' | 'idle' | 'unknown'

export interface SessionActivity {
  lastAssistantText?: string | undefined
  runningTool?: string | undefined
  /** Röviden, min dolgozik a futó tool (parancs, minta, fájlnév…) — lásd `toolDetail`. */
  toolDetail?: string | undefined
  lastEventAt?: number | undefined
}

/** Egy aktív subagent, ahogy a UI kapja: mit csinál épp a session háttérmunkása. */
export interface SubagentView {
  agentId: string
  agentType?: string | undefined
  description?: string | undefined
  runningTool?: string | undefined
  toolDetail?: string | undefined
  /** A subagent transcriptjének utolsó írása (ms). */
  updatedAt: number
}

export interface LiveSession {
  record: SessionRecord
  window?: IdeLock | undefined
}

/** Amit a daemon a UI-nak küld. */
export interface SessionView {
  sessionId: string
  pid: number
  name: string
  cwd: string
  status: SessionStatus
  activity: SessionActivity
  windowPid?: number | undefined
  workspaceFolder?: string | undefined
  bridgeSessionId?: string | null | undefined
  /**
   * Honnan indult a session a registry szerint (`claude-vscode`, `cli`, …), nyers szövegként.
   * A tab-fókusz ebből tudja, hogy a session a VSCode bővítményben fut-e: egy CLI sessionre a
   * bővítmény URI-ja egy ÚJ tabot nyitna.
   */
  entrypoint?: string | undefined
  waitingSince?: number | undefined
  notificationText?: string | undefined
  /**
   * A session utolsó `Stop` eseményének ideje (ms), amíg azóta nem mutatott új tevékenységet
   * (PreToolUse, PermissionRequest, várakozó Notification, futó tool a pillanatképben). Ebből
   * látszik, hogy „épp végzett" — a `status` maga ilyenkor is `idle`. Aktív subagent mellett
   * nincs: a háttérmunka a fő kör Stop-ja után is tart, és egy subagent futó toolja törli is.
   */
  stoppedAt?: number | undefined
  /**
   * A session aktív subagentjei, a legutóbb írt elöl; csak ha van ilyen. Aktív: a meta-ja nem
   * mondja, hogy kész, és a transcriptje `SUBAGENT_STALE_MS`-en belül íródott. Csak megjelenítés.
   */
  subagents?: SubagentView[] | undefined
}
