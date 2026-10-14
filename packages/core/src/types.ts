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
  waitingSince?: number | undefined
  notificationText?: string | undefined
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
