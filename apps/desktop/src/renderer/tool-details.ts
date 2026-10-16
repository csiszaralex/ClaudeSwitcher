import type { DecisionKind } from '@claudeswitcher/core'

/**
 * Ennyi karakter jelenik meg legfeljebb a lenyitható részletekben. Egy több száz kilobájtos
 * Workflow-szkript a `<pre>`-ben másodpercekre megfagyasztaná az overlayt — az a döntéshez
 * úgysem kell egészében, a teljes szöveg a VSCode-ban megvan.
 */
export const DETAILS_LIMIT = 20_000

/** Efölött egy egysoros szöveg is külön blokkba kerül, ne egy végtelen JSON-sorba. */
const LONG_STRING = 120

/**
 * Parancsot futtató eszközök: náluk a parancs (az összefoglaló) maga a tartalom, a leírás
 * alatta áll, a többi mező (timeout, háttérfutás) a döntéshez nem ad hozzá — a részletek
 * csak ismételnék a fenti szöveget.
 */
const NO_DETAILS_TOOLS = new Set(['Bash', 'PowerShell'])

export interface DetailBlock {
  /** A mező neve, ha a blokk egyetlen szöveges mező; a JSON-blokknak nincs. */
  label?: string | undefined
  text: string
}

export interface ToolDetails {
  blocks: DetailBlock[]
  /** Igaz, ha a `DETAILS_LIMIT` miatt valami lemaradt — a panel ezt ki is írja. */
  truncated: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Kap-e a kérés lenyitható részleteket. Csak `tool` fajtánál: a fájlírásnak, a kérdésnek és a
 * tervnek saját nézete van. A `toolInput`-ot a sanitizeState nem ellenőrzi, ezért `unknown`.
 */
export function showsDetails(decision: { kind: DecisionKind; toolName: string; toolInput: unknown }): boolean {
  return (
    decision.kind === 'tool' &&
    !NO_DETAILS_TOOLS.has(decision.toolName) &&
    isPlainObject(decision.toolInput) &&
    Object.keys(decision.toolInput).length > 0
  )
}

/**
 * A `toolInput` olvasható szövegként, méretkorláttal. Soha nem dob.
 *
 * A többsoros vagy hosszú szöveges mezők (a Workflow `script`-je, egy MCP-hívás promptja)
 * külön blokkba kerülnek a saját sortöréseikkel — JSON-ban egyetlen, `\n`-ekkel teli sor
 * lennének, amit senki nem tud elolvasni. A többi mező szép JSON-ként, elöl.
 */
export function formatToolInput(input: unknown, limit: number = DETAILS_LIMIT): ToolDetails {
  if (!isPlainObject(input)) return { blocks: [], truncated: false }

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
