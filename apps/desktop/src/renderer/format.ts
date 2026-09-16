import type { SessionActivity, SessionStatus } from '@claudeswitcher/core'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, '0')}`
  return `${seconds}mp`
}

export function formatResetsIn(resetsAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000))
  if (minutes >= 60) return `${Math.round(minutes / 60)}h múlva`
  return `${minutes}p múlva`
}

export function summarize(view: {
  status: SessionStatus
  activity: SessionActivity
  notificationText?: string
}): string {
  // Az `activity` a típus szerint kötelező, de a daemon üzenete futásidőben bármi lehet.
  // Egy hiányzó mező itt renderelési hibát dobna, ami az EGÉSZ overlayt leszedné — ezért
  // itt is védekezünk, nem csak az ErrorBoundaryben.
  const raw =
    view.status === 'waiting' && view.notificationText !== undefined ? view.notificationText
    : view.status === 'working' && view.activity?.runningTool !== undefined
      ? `${view.activity.runningTool} fut`
    : view.activity?.lastAssistantText ?? '—'

  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}
