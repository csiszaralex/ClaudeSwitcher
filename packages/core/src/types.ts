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
}

export type SessionStatus = 'waiting' | 'working' | 'idle' | 'unknown'

export interface SessionActivity {
  lastAssistantText?: string | undefined
  runningTool?: string | undefined
  lastEventAt?: number | undefined
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
   * látszik, hogy „épp végzett" — a `status` maga ilyenkor is `idle`.
   */
  stoppedAt?: number | undefined
}

export interface RateLimitWindow {
  used_percentage: number
  resets_at: number
}

export interface RateLimits {
  five_hour?: RateLimitWindow | undefined
  seven_day?: RateLimitWindow | undefined
  spend_limit?: RateLimitWindow | undefined
}
