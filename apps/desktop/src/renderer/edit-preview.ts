import type { DecisionKind } from '@claudeswitcher/core'
import { isEditTool, isRecord } from '@claudeswitcher/core/browser'
import { DETAILS_LIMIT, formatToolInput, toolDetails, type ToolDetails } from './tool-details.js'

/**
 * Egy blokkban legfeljebb ennyi sor látszik. A karakterkorlát (`DETAILS_LIMIT`) egy sok rövid
 * sorból álló fájlnál későn fogna: több ezer `<div>` is megakasztaná az overlayt.
 */
export const PREVIEW_LINES = 200

/** `add`: a fájlba kerül (`+`), `remove`: kikerül belőle (`-`), `same`: változatlan környezet. */
export type LineSign = 'add' | 'remove' | 'same'

export interface PreviewLine {
  sign: LineSign
  text: string
}

interface PreviewBlock {
  title: string
  /** Rövid megjegyzések a blokk fejlécében (pl. „minden előfordulás", a cella módja). */
  notes: string[]
  lines: PreviewLine[]
  /** Ennyi sor nem látszik a blokkból — a sor- vagy a karakterkorlát miatt. */
  hiddenLines: number
}

export interface EditPreview {
  blocks: PreviewBlock[]
  /** Igaz, ha a karakterkorlát miatt valami lemaradt — a panel ezt ki is írja. */
  truncated: boolean
}

/** A sor előjele a nézetben, mint egy diffben. */
export const LINE_MARK = { add: '+', remove: '-', same: ' ' } as const satisfies Record<LineSign, string>

/** A NotebookEdit dokumentált módjai; ismeretlen mód úgy jelenik meg, ahogy jött. */
const NOTEBOOK_MODE: Record<string, string> = { replace: 'csere', insert: 'beszúrás', delete: 'törlés' }

const REPLACE_ALL = 'minden előfordulás'

/** Sorokra bont; az üres szövegnek nincs sora, a záró sortörés nem nyit újat. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Egyszerű soros összevetés, diff-könyvtár nélkül: a közös első és utolsó sorok környezetként
 * maradnak, a köztük lévő régi sorok `-`, az újak `+`. Az Edit `old_string`-je jellemzően pár
 * változatlan sort is tartalmaz a változás körül — ezek így nem pirosak-zöldek.
 */
function diffLines(oldText: string, newText: string): PreviewLine[] {
  const before = splitLines(oldText)
  const after = splitLines(newText)
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  return [
    ...before.slice(0, head).map((text): PreviewLine => ({ sign: 'same', text })),
    ...before.slice(head, before.length - tail).map((text): PreviewLine => ({ sign: 'remove', text })),
    ...after.slice(head, after.length - tail).map((text): PreviewLine => ({ sign: 'add', text })),
    ...before.slice(before.length - tail).map((text): PreviewLine => ({ sign: 'same', text })),
  ]
}

function contextLines(text: string): PreviewLine[] {
  return splitLines(text).map((text) => ({ sign: 'same', text }))
}

/** Egy Edit- vagy MultiEdit-módosítás blokkja; `undefined`, ha nem olvasható. */
function editBlock(edit: unknown, title: string): PreviewBlock | undefined {
  if (!isRecord(edit)) return undefined
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = edit
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  return {
    title,
    notes: replaceAll === true ? [REPLACE_ALL] : [],
    lines: diffLines(oldText, newText),
    hiddenLines: 0,
  }
}

function notebookBlock(input: Record<string, unknown>): PreviewBlock | undefined {
  const { edit_mode: editMode, cell_type: cellType, cell_id: cellId, new_source: source } = input
  const mode = typeof editMode === 'string' ? editMode : 'replace'
  const notes = [NOTEBOOK_MODE[mode] ?? mode]
  if (typeof cellType === 'string') notes.push(cellType)
  if (typeof cellId === 'string') notes.push(`cella: ${cellId}`)
  if (mode === 'delete') return { title: 'cella törlése', notes, lines: [], hiddenLines: 0 }
  if (typeof source !== 'string') return undefined
  return { title: 'új cellatartalom', notes, lines: contextLines(source), hiddenLines: 0 }
}

/** A cellatípusok magyar neve a blokk címében; ismeretlen típus `<típus>-cella` lesz. */
const CELL_TITLE: Record<string, string> = { code: 'kódcella', markdown: 'markdown-cella', raw: 'nyers cella' }

/** Egy nbformat cella `source`-a: szöveg, vagy szövegek tömbje, amit úgy, ahogy van, összefűzünk. */
function cellSource(source: unknown): string | undefined {
  if (typeof source === 'string') return source
  if (!Array.isArray(source)) return undefined
  let text = ''
  for (const part of source) {
    if (typeof part !== 'string') return undefined
    text += part
  }
  return text
}

/**
 * Egy `.ipynb`-be írt tartalom cellánként, ahogy a VSCode is mutatja — vagy `undefined`, ha a
 * tartalom nem nbformat (nem JSON, nincs `cells` tömbje, vagy egy cellája olvashatatlan). A
 * kimenetek és a metaadatok nem látszanak: a jóváhagyandó tartalom a cellák forrása.
 */
function notebookCells(path: unknown, content: string): PreviewBlock[] | undefined {
  if (typeof path !== 'string' || !path.toLowerCase().endsWith('.ipynb')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['cells'])) return undefined
  const cells: unknown[] = parsed['cells']
  if (cells.length === 0) return [{ title: 'új jegyzetfüzet', notes: ['nincs cellája'], lines: [], hiddenLines: 0 }]
  const blocks: PreviewBlock[] = []
  for (const [index, cell] of cells.entries()) {
    // Ahogy a MultiEditnél: egy cella kihagyása a jóváhagyandó tartalom egy részét rejtené el.
    if (!isRecord(cell)) return undefined
    const { cell_type: cellType } = cell
    const source = cellSource(cell['source'])
    if (typeof cellType !== 'string' || source === undefined) return undefined
    const title = `${index + 1}. ${CELL_TITLE[cellType] ?? `${cellType}-cella`}`
    blocks.push({ title, notes: [], lines: contextLines(source), hiddenLines: 0 })
  }
  return blocks
}

/** A blokkok a korlát nélkül; `undefined`, ha az alak ismeretlen. */
function rawBlocks(toolName: string, input: Record<string, unknown>): PreviewBlock[] | undefined {
  // Az `EDIT_TOOLS` minden elemének itt van ága: egy új fájlíró eszközre a fordító
  // (TS7030) és a lint `switch-exhaustiveness-check` szabálya is hibát ad, amíg nem kap előnézetet.
  if (!isEditTool(toolName)) return undefined
  switch (toolName) {
    case 'Write': {
      // A hook nem mondja meg, új-e a fájl vagy felülíródik — ezért „új tartalom", nem „új fájl".
      const { content, file_path: path } = input
      if (typeof content !== 'string') return undefined
      // Egy jegyzetfüzet nyers nbformat JSON-ja olvashatatlan; ami nem az, a nyers szövegnézetbe kerül.
      const cells = notebookCells(path, content)
      if (cells !== undefined) return cells
      const lines = contextLines(content)
      return [{ title: 'új tartalom', notes: lines.length === 0 ? ['üres'] : [], lines, hiddenLines: 0 }]
    }
    case 'Edit': {
      const block = editBlock(input, 'módosítás')
      return block === undefined ? undefined : [block]
    }
    case 'MultiEdit': {
      const { edits } = input
      if (!Array.isArray(edits) || edits.length === 0) return undefined
      const blocks: PreviewBlock[] = []
      for (const [index, edit] of edits.entries()) {
        // Egy olvashatatlan módosítás kihagyása elrejtené a jóváhagyandó tartalom egy részét:
        // inkább az egész kérés a nyers nézetbe kerül.
        const block = editBlock(edit, `${index + 1}. módosítás`)
        if (block === undefined) return undefined
        blocks.push(block)
      }
      return blocks
    }
    case 'NotebookEdit': {
      const block = notebookBlock(input)
      return block === undefined ? undefined : [block]
    }
  }
}

/**
 * Egy fájlíró kérés (`edit` fajta) előnézete: mit írna a fájlba. Soha nem dob; ismeretlen
 * eszköznél vagy alaknál `undefined` — a panel ilyenkor a nyers részleteket mutatja.
 *
 * Két korlát van: blokkonként `maxLines` sor, és az összes blokkra együtt `limit` karakter
 * (ugyanaz, mint a részleteknél). Ahol a karakterkeret elfogy, ott a sor is elvágódik, a blokk
 * többi sora rejtett sorként számít, a további blokkok pedig kimaradnak.
 */
export function editPreview(
  toolName: string,
  input: unknown,
  limit: number = DETAILS_LIMIT,
  maxLines: number = PREVIEW_LINES,
): EditPreview | undefined {
  if (!isRecord(input)) return undefined
  const all = rawBlocks(toolName, input)
  if (all === undefined) return undefined

  const blocks: PreviewBlock[] = []
  let budget = limit
  for (const block of all) {
    if (budget <= 0) return { blocks, truncated: true }
    const lines: PreviewLine[] = []
    for (const line of block.lines.slice(0, maxLines)) {
      if (line.text.length > budget) {
        lines.push({ ...line, text: line.text.slice(0, budget) })
        budget = 0
        blocks.push({ ...block, lines, hiddenLines: block.lines.length - lines.length })
        return { blocks, truncated: true }
      }
      lines.push(line)
      budget -= line.text.length
    }
    blocks.push({ ...block, lines, hiddenLines: block.lines.length - lines.length })
  }
  return { blocks, truncated: false }
}

export interface PanelContent {
  preview: EditPreview | undefined
  details: ToolDetails | undefined
}

/**
 * A panel görgethető részének tartalma az összefoglaló alatt: fájlírásnál az előnézet, ha az
 * alak ismert, különben (és a `tool` fajtánál) a nyers részletek. A kérdésnek és a tervnek
 * saját nézete van.
 */
export function panelContent(decision: { kind: DecisionKind; toolName: string; toolInput: unknown }): PanelContent {
  if (decision.kind === 'edit') {
    const preview = editPreview(decision.toolName, decision.toolInput)
    if (preview !== undefined) return { preview, details: undefined }
    const details = formatToolInput(decision.toolInput)
    return { preview: undefined, details: details.blocks.length > 0 ? details : undefined }
  }
  return { preview: undefined, details: toolDetails(decision) }
}
