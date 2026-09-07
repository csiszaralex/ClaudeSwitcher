import os from 'node:os'
import path from 'node:path'

/** A Claude Code konfigurációs könyvtára. CLAUDE_CONFIG_DIR felülírja. */
export function resolveClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR
  if (override !== undefined && override.trim() !== '') return override
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
