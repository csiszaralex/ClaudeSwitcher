import os from 'node:os'
import path from 'node:path'

/** Claude Code's configuration directory. `CLAUDE_CONFIG_DIR` overrides it. */
export function resolveClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CLAUDE_CONFIG_DIR']?.trim()
  if (override !== undefined && override !== '') return override
  return path.join(os.homedir(), '.claude')
}

export function sessionsDir(claudeDir: string): string {
  return path.join(claudeDir, 'sessions')
}

export function ideDir(claudeDir: string): string {
  return path.join(claudeDir, 'ide')
}

export function userSettingsPath(claudeDir: string): string {
  return path.join(claudeDir, 'settings.json')
}

/** The session transcripts live under it, one directory per project (see `findTranscriptPath`). */
export function projectsDir(claudeDir: string): string {
  return path.join(claudeDir, 'projects')
}

/**
 * A session's subagent files sit beside its transcript: `<sessionId>.jsonl` has them in
 * `<sessionId>/subagents/` (the layout is described in `subagent.ts`).
 */
export function subagentsDirOf(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents')
}
