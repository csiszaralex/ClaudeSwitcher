import type { DecisionKind } from '@claudeswitcher/core'
import { COMMAND_TOOLS, isRecord } from '@claudeswitcher/core/browser'

/**
 * Ennyi karakter jelenik meg legfeljebb a lenyitható részletekben. Egy több száz kilobájtos
 * Workflow-szkript a `<pre>`-ben másodpercekre megfagyasztaná az overlayt — az a döntéshez
 * úgysem kell egészében, a teljes szöveg a VSCode-ban megvan.
 */
export const DETAILS_LIMIT = 20_000

/** Efölött egy egysoros szöveg is külön blokkba kerül, ne egy végtelen JSON-sorba. */
const LONG_STRING = 120

/**
 * Parancsot futtató eszközök: náluk a parancs (az összefoglaló) és a leírás már a panel tetején
 * áll, a részletek ezeket nem ismétlik. Minden más mezőjük (timeout, háttérfutás, a sandbox
 * kikapcsolása) a részletekbe kerül: egy rejtett mező mellett a sandbox nélküli futás ugyanúgy
 * nézne ki, mint a sandboxos.
 */
const SHOWN_ABOVE: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  COMMAND_TOOLS.map((tool) => [tool, new Set(['command', 'description'])]),
)

interface DetailBlock {
  /** A mező neve, ha a blokk egyetlen szöveges mező; a JSON-blokknak nincs. */
  label?: string | undefined
  text: string
}

export interface ToolDetails {
  blocks: DetailBlock[]
  /** Igaz, ha a `DETAILS_LIMIT` miatt valami lemaradt — a panel ezt ki is írja. */
  truncated: boolean
}

interface DetailSource {
  kind: DecisionKind
  toolName: string
  /** A `toolInput`-ot a sanitizeState nem ellenőrzi, ezért `unknown`. */
  toolInput: unknown
}

/** A részletekbe kerülő mezők: a bemenet, a panel tetején már látható mezők nélkül. */
function detailFields(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const above = SHOWN_ABOVE[toolName]
  if (above === undefined) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !above.has(key)))
}

/**
 * Kap-e a kérés lenyitható részleteket. Csak `tool` fajtánál: a fájlírásnak, a kérdésnek és a
 * tervnek saját nézete van. Parancsnál csak akkor, ha a parancson és a leíráson kívül is van mező.
 */
export function showsDetails(decision: DetailSource): boolean {
  return (
    decision.kind === 'tool' &&
    isRecord(decision.toolInput) &&
    Object.keys(detailFields(decision.toolName, decision.toolInput)).length > 0
  )
}

/** A `tool` fajtájú kérés részletei a `showsDetails` szerint; `undefined`, ha nincs mit mutatni. */
export function toolDetails(decision: DetailSource): ToolDetails | undefined {
  if (!showsDetails(decision) || !isRecord(decision.toolInput)) return undefined
  return formatToolInput(detailFields(decision.toolName, decision.toolInput))
}

/**
 * A Bash `dangerouslyDisableSandbox: true` mezője: a parancs a sandboxon kívül futna. A panel
 * ezt piros sorban, a részletek lenyitása nélkül is mutatja. Csak a kifejezett `true` számít.
 */
export function sandboxDisabled(toolInput: unknown): boolean {
  return isRecord(toolInput) && toolInput['dangerouslyDisableSandbox'] === true
}

/**
 * A `toolInput` olvasható szövegként, méretkorláttal. Soha nem dob.
 *
 * A többsoros vagy hosszú szöveges mezők (a Workflow `script`-je, egy MCP-hívás promptja)
 * külön blokkba kerülnek a saját sortöréseikkel — JSON-ban egyetlen, `\n`-ekkel teli sor
 * lennének, amit senki nem tud elolvasni. A többi mező szép JSON-ként, elöl.
 */
export function formatToolInput(input: unknown, limit: number = DETAILS_LIMIT): ToolDetails {
  if (!isRecord(input)) return { blocks: [], truncated: false }

  const rest: Record<string, unknown> = {}
  const texts: DetailBlock[] = []
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && (value.includes('\n') || value.length > LONG_STRING)) {
      texts.push({ label: key, text: value })
    } else {
      rest[key] = value
    }
  }

  const all: DetailBlock[] = []
  if (Object.keys(rest).length > 0) {
    try {
      all.push({ text: JSON.stringify(rest, null, 2) })
    } catch {
      // IPC-n jött JSON-ból ez nem fordulhat elő; ha mégis, a szöveges blokkok attól még jók.
    }
  }
  all.push(...texts)

  // A korlát az ÖSSZES blokkra együtt vonatkozik: sok közepes mező is összeadódik.
  const blocks: DetailBlock[] = []
  let budget = limit
  for (const block of all) {
    if (budget <= 0) return { blocks, truncated: true }
    if (block.text.length > budget) {
      blocks.push({ ...block, text: block.text.slice(0, budget) })
      return { blocks, truncated: true }
    }
    blocks.push(block)
    budget -= block.text.length
  }
  return { blocks, truncated: false }
}
