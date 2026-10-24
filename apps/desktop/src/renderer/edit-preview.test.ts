import { describe, expect, it } from 'vitest'
import { editPreview, panelContent, PREVIEW_LINES, type PreviewLine } from './edit-preview.js'
import { DETAILS_LIMIT } from './tool-details.js'

const same = (text: string): PreviewLine => ({ sign: 'same', text })
const add = (text: string): PreviewLine => ({ sign: 'add', text })
const remove = (text: string): PreviewLine => ({ sign: 'remove', text })

describe('editPreview — Write', () => {
  it('shows the content as new content, line by line', () => {
    expect(editPreview('Write', { file_path: 'p:\\a.ts', content: 'a\nb\n' })).toEqual({
      blocks: [{ title: 'új tartalom', notes: [], lines: [same('a'), same('b')], hiddenLines: 0 }],
      truncated: false,
    })
  })

  it('splits Windows line breaks too', () => {
    expect(editPreview('Write', { file_path: 'x', content: 'a\r\nb' })?.blocks[0]?.lines).toEqual([same('a'), same('b')])
  })

  it('says so when the content is empty', () => {
    expect(editPreview('Write', { file_path: 'x', content: '' })).toEqual({
      blocks: [{ title: 'új tartalom', notes: ['üres'], lines: [], hiddenLines: 0 }],
      truncated: false,
    })
  })
})

describe('editPreview — Write of a notebook', () => {
  // A mért alak: így írta a Claude Code az `m3-nb.ipynb`-t a cs-spike live teszten.
  const measured =
    '{"cells":[{"cell_type":"code","execution_count":null,"metadata":{},"outputs":[],"source":["print(\\"hello\\")"]}],' +
    '"metadata":{"kernelspec":{"display_name":"Python 3","language":"python","name":"python3"},' +
    '"language_info":{"name":"python"}},"nbformat":4,"nbformat_minor":5}'

  it('shows the measured notebook as its cells, not as nbformat JSON', () => {
    expect(editPreview('Write', { file_path: 'p:\\cs-spike\\m3-nb.ipynb', content: measured })).toEqual({
      blocks: [{ title: '1. kódcella', notes: [], lines: [same('print("hello")')], hiddenLines: 0 }],
      truncated: false,
    })
  })

  it('numbers the cells, names them by type, and joins an array source as-is', () => {
    const content = JSON.stringify({
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Cím\n', 'szöveg'] },
        { cell_type: 'code', metadata: {}, outputs: [{ output_type: 'stream', text: ['kimenet'] }], source: 'a = 1\nb = 2\n' },
        { cell_type: 'raw', metadata: {}, source: [] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
    expect(editPreview('Write', { file_path: 'N.IPYNB', content })).toEqual({
      blocks: [
        { title: '1. markdown-cella', notes: [], lines: [same('# Cím'), same('szöveg')], hiddenLines: 0 },
        { title: '2. kódcella', notes: [], lines: [same('a = 1'), same('b = 2')], hiddenLines: 0 },
        { title: '3. nyers cella', notes: [], lines: [], hiddenLines: 0 },
      ],
      truncated: false,
    })
  })

  it('shows an unknown cell type by its name', () => {
    const content = JSON.stringify({ cells: [{ cell_type: 'widget', source: 'x' }] })
    expect(editPreview('Write', { file_path: 'n.ipynb', content })?.blocks[0]?.title).toBe('1. widget-cella')
  })

  it('says so when the notebook has no cells', () => {
    expect(editPreview('Write', { file_path: 'n.ipynb', content: '{"cells":[]}' })).toEqual({
      blocks: [{ title: 'új jegyzetfüzet', notes: ['nincs cellája'], lines: [], hiddenLines: 0 }],
      truncated: false,
    })
  })

  it('falls back to the raw text for anything that is not nbformat, and never throws', () => {
    const raw = (content: string): unknown => editPreview('Write', { file_path: 'n.ipynb', content })?.blocks
    const asText = (content: string): unknown => editPreview('Write', { file_path: 'n.txt', content })?.blocks
    for (const content of [
      '',
      'not json',
      '{"cells":',
      'null',
      '[1,2]',
      '"cells"',
      '{"cells":{}}',
      '{"metadata":{}}',
      '{"cells":[1]}',
      '{"cells":[{"cell_type":"code"}]}',
      '{"cells":[{"cell_type":"code","source":[1]}]}',
      '{"cells":[{"cell_type":1,"source":"x"}]}',
      '{"cells":[{"source":"x"}]}',
    ]) {
      expect(raw(content)).toEqual(asText(content))
    }
  })

  it('treats only a .ipynb path as a notebook', () => {
    for (const file_path of ['n.json', 'n.ipynb.bak', 'ipynb']) {
      expect(editPreview('Write', { file_path, content: measured })?.blocks[0]?.title).toBe('új tartalom')
    }
    // Útvonal nélkül sem jegyzetfüzet — a Write előnézete eddig sem kérte az útvonalat.
    expect(editPreview('Write', { content: measured })?.blocks[0]?.title).toBe('új tartalom')
  })

  it('applies the same caps to the cells', () => {
    const source = Array.from({ length: PREVIEW_LINES + 3 }, (_, i) => `l${i}`).join('\n')
    const content = JSON.stringify({ cells: [{ cell_type: 'code', source }, { cell_type: 'code', source: 'tail' }] })
    const preview = editPreview('Write', { file_path: 'n.ipynb', content }, 12)
    expect(preview?.truncated).toBe(true)
    expect(preview?.blocks).toHaveLength(1)
    const big = editPreview('Write', { file_path: 'n.ipynb', content })?.blocks[0]
    expect(big?.lines).toHaveLength(PREVIEW_LINES)
    expect(big?.hiddenLines).toBe(3)
  })
})

describe('editPreview — Edit', () => {
  it('shows the changed lines as - and +, the shared ones around them as context', () => {
    const preview = editPreview('Edit', {
      file_path: 'x',
      old_string: 'keep1\nold\nkeep2',
      new_string: 'keep1\nnew A\nnew B\nkeep2',
      replace_all: false,
    })
    expect(preview).toEqual({
      blocks: [
        {
          title: 'módosítás',
          notes: [],
          lines: [same('keep1'), remove('old'), add('new A'), add('new B'), same('keep2')],
          hiddenLines: 0,
        },
      ],
      truncated: false,
    })
  })

  it('shows a full replacement as all removed, then all added', () => {
    expect(editPreview('Edit', { file_path: 'x', old_string: 'a\nb', new_string: 'c' })?.blocks[0]?.lines).toEqual([
      remove('a'),
      remove('b'),
      add('c'),
    ])
  })

  it('shows a pure deletion with no added line', () => {
    expect(editPreview('Edit', { file_path: 'x', old_string: 'gone', new_string: '' })?.blocks[0]?.lines).toEqual([
      remove('gone'),
    ])
  })

  it('notes replace_all', () => {
    expect(
      editPreview('Edit', { file_path: 'x', old_string: 'a', new_string: 'b', replace_all: true })?.blocks[0]?.notes,
    ).toEqual(['minden előfordulás'])
  })

  it('has no preview without both strings — the panel falls back to the raw input', () => {
    expect(editPreview('Edit', { file_path: 'x', old_string: 'a' })).toBeUndefined()
    expect(editPreview('Edit', { file_path: 'x', old_string: 1, new_string: 'b' })).toBeUndefined()
  })
})

describe('editPreview — MultiEdit', () => {
  it('shows each edit as its own numbered block', () => {
    const preview = editPreview('MultiEdit', {
      file_path: 'x',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd', replace_all: true },
      ],
    })
    expect(preview).toEqual({
      blocks: [
        { title: '1. módosítás', notes: [], lines: [remove('a'), add('b')], hiddenLines: 0 },
        { title: '2. módosítás', notes: ['minden előfordulás'], lines: [remove('c'), add('d')], hiddenLines: 0 },
      ],
      truncated: false,
    })
  })

  it('has no preview when any edit is unreadable — hiding one would hide part of what is approved', () => {
    expect(
      editPreview('MultiEdit', { file_path: 'x', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c' }] }),
    ).toBeUndefined()
    expect(editPreview('MultiEdit', { file_path: 'x', edits: [] })).toBeUndefined()
    expect(editPreview('MultiEdit', { file_path: 'x', edits: 'nope' })).toBeUndefined()
  })
})

describe('editPreview — NotebookEdit', () => {
  it('shows the new cell source with the edit mode and cell type', () => {
    expect(
      editPreview('NotebookEdit', {
        notebook_path: 'n.ipynb',
        cell_id: 'c1',
        new_source: 'print(1)',
        cell_type: 'code',
        edit_mode: 'insert',
      }),
    ).toEqual({
      blocks: [{ title: 'új cellatartalom', notes: ['beszúrás', 'code', 'cella: c1'], lines: [same('print(1)')], hiddenLines: 0 }],
      truncated: false,
    })
  })

  it('treats a missing edit mode as a replacement, the documented default', () => {
    expect(editPreview('NotebookEdit', { notebook_path: 'n', new_source: 'x' })?.blocks[0]?.notes).toEqual(['csere'])
  })

  it('shows a deletion without a source', () => {
    expect(editPreview('NotebookEdit', { notebook_path: 'n', cell_id: 'c2', edit_mode: 'delete' })).toEqual({
      blocks: [{ title: 'cella törlése', notes: ['törlés', 'cella: c2'], lines: [], hiddenLines: 0 }],
      truncated: false,
    })
  })

  it('shows an unknown edit mode as it came', () => {
    expect(editPreview('NotebookEdit', { notebook_path: 'n', new_source: 'x', edit_mode: 'merge' })?.blocks[0]?.notes).toEqual([
      'merge',
    ])
  })

  it('has no preview without a source for a non-delete edit', () => {
    expect(editPreview('NotebookEdit', { notebook_path: 'n', edit_mode: 'replace' })).toBeUndefined()
  })
})

describe('editPreview — unknown shapes', () => {
  it('has no preview for an unknown tool or a malformed input, and never throws', () => {
    expect(editPreview('Frobnicate', { file_path: 'x', content: 'a' })).toBeUndefined()
    expect(editPreview('Write', { file_path: 'x' })).toBeUndefined()
    expect(editPreview('Write', null)).toBeUndefined()
    expect(editPreview('Write', 'content')).toBeUndefined()
    expect(editPreview('Write', ['content'])).toBeUndefined()
  })
})

describe('editPreview — size caps', () => {
  it('caps the lines of a block and counts the rest', () => {
    const content = Array.from({ length: PREVIEW_LINES + 50 }, (_, i) => `l${i}`).join('\n')
    const block = editPreview('Write', { file_path: 'x', content })?.blocks[0]
    expect(block?.lines).toHaveLength(PREVIEW_LINES)
    expect(block?.hiddenLines).toBe(50)
  })

  it('caps the total characters so a huge file cannot freeze the overlay', () => {
    const preview = editPreview('Write', { file_path: 'x', content: 'y'.repeat(DETAILS_LIMIT * 50) })
    expect(preview?.truncated).toBe(true)
    const total = preview?.blocks.reduce((sum, b) => sum + b.lines.reduce((s, l) => s + l.text.length, 0), 0)
    expect(total).toBeLessThanOrEqual(DETAILS_LIMIT)
  })

  it('cuts the line where the budget ends, counts the unshown lines, and drops the later blocks', () => {
    const preview = editPreview(
      'MultiEdit',
      {
        file_path: 'x',
        edits: [
          { old_string: 'abc', new_string: 'def\nghi\njkl' },
          { old_string: 'm', new_string: 'n' },
        ],
      },
      5,
    )
    expect(preview).toEqual({
      blocks: [{ title: '1. módosítás', notes: [], lines: [remove('abc'), add('de')], hiddenLines: 2 }],
      truncated: true,
    })
  })

  it('honours a custom line cap', () => {
    expect(editPreview('Write', { file_path: 'x', content: 'a\nb\nc' }, DETAILS_LIMIT, 2)?.blocks[0]).toEqual({
      title: 'új tartalom',
      notes: [],
      lines: [same('a'), same('b')],
      hiddenLines: 1,
    })
  })
})

describe('panelContent', () => {
  it('gives an edit request its preview and no generic details', () => {
    const content = panelContent({ kind: 'edit', toolName: 'Write', toolInput: { file_path: 'x', content: 'a' } })
    expect(content.preview?.blocks).toHaveLength(1)
    expect(content.details).toBeUndefined()
  })

  it('falls back to the generic details for an edit of unknown shape', () => {
    const content = panelContent({ kind: 'edit', toolName: 'Write', toolInput: { file_path: 'x', body: 'a' } })
    expect(content.preview).toBeUndefined()
    expect(content.details?.blocks).toEqual([{ text: '{\n  "file_path": "x",\n  "body": "a"\n}' }])
  })

  it('shows nothing extra for an edit with an empty or malformed input', () => {
    expect(panelContent({ kind: 'edit', toolName: 'Write', toolInput: null })).toEqual({ preview: undefined, details: undefined })
    expect(panelContent({ kind: 'edit', toolName: 'Write', toolInput: {} })).toEqual({ preview: undefined, details: undefined })
  })

  it('keeps the generic details for a tool request and nothing for the other kinds', () => {
    expect(panelContent({ kind: 'tool', toolName: 'WebFetch', toolInput: { url: 'u' } }).details?.blocks).toHaveLength(1)
    expect(panelContent({ kind: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } })).toEqual({
      preview: undefined,
      details: undefined,
    })
    expect(panelContent({ kind: 'plan', toolName: 'ExitPlanMode', toolInput: { plan: 'p' } })).toEqual({
      preview: undefined,
      details: undefined,
    })
  })
})
