/** A raw record from the `~/.claude/sessions/<pid>.json` file. An undocumented format. */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart?: string | undefined
  entrypoint?: string | undefined
  name?: string | undefined
  bridgeSessionId?: string | null | undefined
  /**
   * The session's state according to Claude Code (2.1.296+, measured: `idle`, `busy`, `waiting`).
   * Undocumented, so it is kept as raw text: an unknown new value must not drop anything; a
   * consumer reacts only to the values it knows.
   */
  status?: string | undefined
  /** What it waits for (`permission prompt`) when `status === 'waiting'`; otherwise `null` or absent. */
  waitingFor?: string | null | undefined
  /** When `status` last changed (epoch ms). */
  statusUpdatedAt?: number | undefined
}

/** A raw record from the `~/.claude/ide/<port>.lock` file. An undocumented format. */
export interface IdeLock {
  port: number
  pid: number
  workspaceFolders: string[]
  ideName?: string | undefined
  /**
   * The lock file's last write (epoch ms, the file's `mtimeMs`), when the scanner could read it.
   * It does not come from the file's content: the lock stores no time. It shows when the pid has
   * since been reused by a process started later (see `lockPredatesProcess`).
   */
  mtimeMs?: number | undefined
}

export type SessionStatus = 'waiting' | 'working' | 'idle'

export interface SessionActivity {
  lastAssistantText?: string | undefined
  runningTool?: string | undefined
  /** In short, what the running tool works on (command, pattern, file name…); see `toolDetail`. */
  toolDetail?: string | undefined
  lastEventAt?: number | undefined
}

/** An active subagent as the UI gets it: what the session's background worker is doing now. */
export interface SubagentView {
  agentId: string
  agentType?: string | undefined
  description?: string | undefined
  runningTool?: string | undefined
  toolDetail?: string | undefined
  /** The last write of the subagent's transcript (ms). */
  updatedAt: number
}

export interface LiveSession {
  record: SessionRecord
  window?: IdeLock | undefined
}

/** What the daemon sends to the UI. */
export interface SessionView {
  sessionId: string
  name: string
  cwd: string
  status: SessionStatus
  activity: SessionActivity
  windowPid?: number | undefined
  workspaceFolder?: string | undefined
  bridgeSessionId?: string | null | undefined
  /**
   * Where the session was started according to the registry (`claude-vscode`, `cli`, …), as raw
   * text. Tab focus uses it to tell whether the session runs in the VS Code extension: for a CLI
   * session the extension's URI would open a NEW tab.
   */
  entrypoint?: string | undefined
  waitingSince?: number | undefined
  notificationText?: string | undefined
  /**
   * The time of the session's last `Stop` event (ms), as long as it has shown no new activity since
   * (PreToolUse, PermissionRequest, a waiting Notification, a running tool in the snapshot). It
   * shows that the session "just finished"; `status` itself is `idle` then too. Absent while a
   * subagent is active: background work goes on after the main turn's Stop, and a running tool of
   * a subagent clears it as well.
   */
  stoppedAt?: number | undefined
  /**
   * The session's active subagents, most recently written first; present only when there is one.
   * Active: its meta does not say finished, and its transcript was written within
   * `SUBAGENT_STALE_MS`. Display only.
   */
  subagents?: SubagentView[] | undefined
}
