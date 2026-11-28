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
  /**
   * The named pipe other sessions send their cross-session messages to, as raw text, for example
   * `\\.\pipe\LOCAL\cc-msg-<32 hex>`. A message that arrives names its sender by this pipe
   * (`cross-session.ts`), so it links a recipient to the session that prompted it.
   */
  messagingSocketPath?: string | undefined
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

/** A usage limit the account hit, as the transcript reports it (`usage-limit.ts` `usageLimitOf`). */
export interface UsageLimit {
  /** The raw `rateLimitType` (`USAGE_LIMIT_KIND` names the known ones); absent when the record has none. */
  kind?: string | undefined
  /** When the limit resets (epoch ms); absent when the record has no valid time. */
  resetsAt?: number | undefined
}

export interface SessionActivity {
  lastAssistantText?: string | undefined
  runningTool?: string | undefined
  /** In short, what the running tool works on (command, pattern, file name…); see `toolDetail`. */
  toolDetail?: string | undefined
  lastEventAt?: number | undefined
  /**
   * The usage limit that ended the session's last turn: set by Claude Code's synthetic limit record,
   * cleared by any later user record or non-error assistant record (`readActivityFromLines`).
   */
  usageLimit?: UsageLimit | undefined
  /**
   * The title the session's tab shows in the VS Code extension: the latest custom title, else the
   * latest AI title (`tab-title.ts`), from the transcript tail. Absent while the tail has no title
   * record.
   */
  tabTitle?: string | undefined
  /**
   * The sessions this session works for now: one entry per sender of a cross-session message that
   * is still pending, from its arrival until the end of the turn that handles it
   * (`cross-session.ts`). Absent when there is none.
   */
  promptedBy?: PromptSender[] | undefined
  /**
   * When the user last sent the session a prompt of his own (epoch ms, the record's `timestamp`;
   * `conversation.ts` `isOwnPrompt`: not a cross-session message, a tool result or a slash command),
   * from the transcript tail. Absent while the tail holds none: a turn can outgrow the tail.
   */
  lastOwnPromptAt?: number | undefined
}

/** The sender of a cross-session message, as the recipient's transcript names it (`cross-session.ts`). */
export interface PromptSender {
  /**
   * The sender's pipe without the `uds:` prefix of the message, so it equals the sender's registry
   * `messagingSocketPath` (`SessionRecord`).
   */
  pipe: string
  /** The name the message gave for its sender; absent when it gave none. */
  name?: string | undefined
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
  /**
   * The session's own process id, the registry record's `pid` (the `claude` process). The jump to a
   * terminal session walks up from it to the window that shows the terminal. The daemon always fills
   * it; it is optional, like `windowPid`, so a view built elsewhere need not invent one.
   */
  pid?: number | undefined
  windowPid?: number | undefined
  workspaceFolder?: string | undefined
  bridgeSessionId?: string | null | undefined
  /**
   * Where the session was started according to the registry (`claude-vscode`, `cli`, …), as raw
   * text. Tab focus uses it to tell whether the session runs in the VS Code extension: for a CLI
   * session the extension's URI would open a NEW tab.
   */
  entrypoint?: string | undefined
  /**
   * The registry's `messagingSocketPath` (`SessionRecord`), raw. Another session's
   * `activity.promptedBy` names this session by it while it works on this session's message.
   */
  messagingSocketPath?: string | undefined
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
