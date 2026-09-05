/** Nyers rekord a ~/.claude/sessions/<pid>.json fájlból. Nem dokumentált formátum. */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart?: string
  version?: string
  kind?: string
  entrypoint?: string
  name?: string
  bridgeSessionId?: string | null
}

/** Nyers rekord a ~/.claude/ide/<port>.lock fájlból. Nem dokumentált formátum. */
export interface IdeLock {
  port: number
  pid: number
  workspaceFolders: string[]
  ideName?: string
  transport?: string
}

export type SessionStatus = 'waiting' | 'working' | 'idle' | 'unknown'

export interface SessionActivity {
  lastAssistantText?: string
  runningTool?: string
  lastEventAt?: number
}

export interface LiveSession {
  record: SessionRecord
  window?: IdeLock
}

/** Amit a daemon a UI-nak küld. */
export interface SessionView {
  sessionId: string
  pid: number
  name: string
  cwd: string
  status: SessionStatus
  activity: SessionActivity
  windowPid?: number
  workspaceFolder?: string
  bridgeSessionId?: string | null
  waitingSince?: number
  notificationText?: string
}

export interface RateLimitWindow {
  used_percentage: number
  resets_at: number
}

export interface RateLimits {
  five_hour?: RateLimitWindow
  seven_day?: RateLimitWindow
  spend_limit?: RateLimitWindow
}
