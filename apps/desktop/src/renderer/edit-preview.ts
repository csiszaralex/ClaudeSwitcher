import type { DecisionKind } from '@claudeswitcher/core'
import { isEditTool, isRecord } from '@claudeswitcher/core/browser'
import { DETAILS_LIMIT, formatToolInput, toolDetails, type ToolDetails } from './tool-details.js'

/**
 * At most this many lines show in a block. The character limit (`DETAILS_LIMIT`) would kick in
 * too late for a file of many short lines: thousands of `<div>`s would stall the overlay too.
 */
export const PREVIEW_LINES = 200

/** `add`: goes into the file (`+`), `remove`: leaves it (`-`), `same`: unchanged context. */
export type LineSign = 'add' | 'remove' | 'same'

export interface PreviewLine {
  sign: LineSign
  text: string
}

interface PreviewBlock {
  title: string
  /** Short notes in the block header (e.g. the replace-all note, the cell mode). */
  notes: string[]
  lines: PreviewLine[]
  /** This many lines of the block do not show, because of the line or the character limit. */
  hiddenLines: number
}

export interface EditPreview {
  blocks: PreviewBlock[]
  /** True if something was left out because of the character limit. The panel says so. */
  truncated: boolean
}

/** The line's sign in the view, as in a diff. */
export const LINE_MARK = { add: '+', remove: '-', same: ' ' } as const satisfies Record<LineSign, string>

/** The documented NotebookEdit modes; an unknown mode is shown as it came. */
const NOTEBOOK_MODE: Record<string, string> = { replace: 'csere', insert: 'beszúrás', delete: 'törlés' }

const REPLACE_ALL = 'minden előfordulás'

/** Splits into lines; empty text has no line, and a trailing line break does not open a new one. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A simple line comparison without a diff library: the common first and last lines stay as
 * context, the old lines between them are `-`, the new ones `+`. An Edit's `old_string` typically
 * holds a few unchanged lines around the change too, and this way they are not red and green.
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

/** The block of one Edit or MultiEdit change; `undefined` if it is not readable. */
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

/** The Hungarian names of the cell types in the block title; an unknown type becomes `<type>-cella`. */
const CELL_TITLE: Record<string, string> = { code: 'kódcella', markdown: 'markdown-cella', raw: 'nyers cella' }

/** An nbformat cell's `source`: a string, or an array of strings joined as they are. */
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
 * Content written into an `.ipynb`, cell by cell as VS Code shows it, or `undefined` if the content
 * is not nbformat (not JSON, no `cells` array, or one of its cells is unreadable). Outputs and
 * metadata do not show: the content to approve is the cells' source.
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
    // As with MultiEdit: skipping a cell would hide part of the content to approve.
    if (!isRecord(cell)) return undefined
    const { cell_type: cellType } = cell
    const source = cellSource(cell['source'])
    if (typeof cellType !== 'string' || source === undefined) return undefined
    const title = `${index + 1}. ${CELL_TITLE[cellType] ?? `${cellType}-cella`}`
    blocks.push({ title, notes: [], lines: contextLines(source), hiddenLines: 0 })
  }
  return blocks
}

/** The blocks without the limit; `undefined` if the shape is unknown. */
function rawBlocks(toolName: string, input: Record<string, unknown>): PreviewBlock[] | undefined {
  // Every element of `EDIT_TOOLS` has a branch here: for a new file-writing tool both the compiler
  // (TS7030) and the lint rule `switch-exhaustiveness-check` report an error until it gets a preview.
  if (!isEditTool(toolName)) return undefined
  switch (toolName) {
    case 'Write': {
      // The hook does not say whether the file is new or overwritten, so the title says "new
      // content", not "new file".
      const { content, file_path: path } = input
      if (typeof content !== 'string') return undefined
      // A notebook's raw nbformat JSON is unreadable; anything that is not one goes to the raw text view.
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
        // Skipping an unreadable change would hide part of the content to approve: the whole
        // request goes to the raw view instead.
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
 * The preview of a file-writing request (`edit` kind): what it would write into the file. Never
 * throws; `undefined` for an unknown tool or shape, and the panel then shows the raw details.
 *
 * There are two limits: `maxLines` lines per block, and `limit` characters for all blocks together
 * (the same as for the details). Where the character budget runs out, the line is cut too, the
 * block's remaining lines count as hidden lines, and the further blocks are left out.
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
 * The content of the panel's scrollable part below the summary: for a file write the preview if
 * the shape is known, otherwise (and for the `tool` kind) the raw details. The question and the
 * plan have views of their own.
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
