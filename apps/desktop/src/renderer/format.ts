import type { SessionActivity, SessionStatus, SubagentView } from '@claudeswitcher/core'

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

/** Parancsot futtató eszközök: a részletük maga a parancs, kettősponttal jobban olvasható. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])

/**
 * Egy futó tool a sorban: `Bash: pnpm test`, `Grep „createPanel"`, vagy részlet nélkül `Read fut`.
 * Ugyanez a fő sessionnél és a subagentnél, hogy a kettő egyformán olvasson.
 */
export function toolLabel(tool: string, detail?: string): string {
  if (detail === undefined || detail === '') return `${tool} fut`
  return COMMAND_TOOLS.has(tool) ? `${tool}: ${detail}` : `${tool} „${detail}"`
}

/** Egy subagent munkája: `<leírás vagy típus> · <futó tool>`, tool nélkül csak a név. */
function subagentWork(subagent: SubagentView): string {
  const name = subagent.description ?? subagent.agentType ?? 'subagent'
  return subagent.runningTool === undefined ? name : `${name} · ${toolLabel(subagent.runningTool, subagent.toolDetail)}`
}

/**
 * A sor tooltipje: az összes aktív subagent, soronként egy. `undefined`, ha nincs — akkor a
 * sornak nincs is tooltipje.
 */
export function subagentTooltip(subagents: readonly SubagentView[] | undefined): string | undefined {
  if (subagents === undefined || subagents.length === 0) return undefined
  return subagents.map((subagent) => `↳ ${subagentWork(subagent)}`).join('\n')
}

function clip(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/**
 * A sor összefoglalója. Sorrend: egy várakozó session értesítése; az aktív subagent munkája
 * (a legutóbbi, és `+N`, ha több is fut) — a fő session ilyenkor csak az `Agent` toolt futtatja,
 * vagy a Stop után már semmit; a fő session futó toolja; végül az utolsó assistant-szöveg.
 * A függő döntés ennél is erősebb, azt az App mutatja e helyett.
 */
export function summarize(view: {
  status: SessionStatus
  // Futásidőben hiányozhat (lásd lent), ezért a típus is ezt mondja.
  activity?: SessionActivity | undefined
  notificationText?: string | undefined
  subagents?: readonly SubagentView[] | undefined
}): string {
  // Az `activity` a típus szerint kötelező, de a daemon üzenete futásidőben bármi lehet.
  // Egy hiányzó mező itt renderelési hibát dobna, ami az EGÉSZ overlayt leszedné — ezért
  // itt is védekezünk, nem csak az ErrorBoundaryben.
  const waitingText = view.status === 'waiting' ? view.notificationText : undefined
  const [latest, ...others] = view.subagents ?? []
  if (waitingText === undefined && latest !== undefined) {
    // A `+N` elöl áll: a CSS a sor végét levághatja, a számot pedig látni kell.
    const more = others.length > 0 ? `+${String(others.length)} · ` : ''
    return clip(`↳ ${more}${subagentWork(latest)}`)
  }

  const raw =
    waitingText !== undefined ? waitingText
    : view.status === 'working' && view.activity?.runningTool !== undefined
      ? toolLabel(view.activity.runningTool, view.activity.toolDetail)
    : view.activity?.lastAssistantText ?? '—'

  return clip(raw)
}
