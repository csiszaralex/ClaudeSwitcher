// Checks that a diff changes only comments.
//
// Usage:
//   node scripts/check-comment-only-diff.mjs [--allow <file.json>] <base>          (base vs working tree)
//   node scripts/check-comment-only-diff.mjs [--allow <file.json>] <base>..<head>  (two commits)
//   pnpm check:comment-only -- [--allow <file.json>] <range>
//
// For every changed .ts/.tsx/.mts/.cts/.js/.mjs/.cjs file it parses the old and the new version with
// the TypeScript parser, collects the tokens without trivia (comments and whitespace), and compares
// the two token streams one by one. Two string literals may differ only when:
// - both are the title (first argument) of a `describe`/`it`/`test` call, including the
//   `.each(...)`, `.skip` and similar forms; or
// - the old value is listed in the `--allow` file, a JSON array of string values (the cooked value,
//   not the source text). It is meant for the non-GUI log and error texts a translation changes.
// Any other difference fails: a different token, a different token count, an added, deleted or
// renamed file (renames are not followed). Untracked files are not part of a git diff and are not
// checked. Exit code: 0 when every difference is allowed, 1 on a difference, 2 on a usage error.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import ts from 'typescript'

const run = promisify(execFile)
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|tsx|jsx)$/
const TITLE_FUNCTIONS = new Set(['describe', 'it', 'test'])
const USAGE = 'usage: check-comment-only-diff.mjs [--allow <file.json>] <base> | <base>..<head>'

/**
 * @param {readonly string[]} args
 * @returns {Promise<string>}
 */
async function git(args) {
  const { stdout } = await run('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/**
 * @param {readonly string[]} argv
 * @returns {{ base: string, head: string | null, allowFile: string | null } | null}
 */
function parseArgs(argv) {
  /** @type {string | null} */
  let allowFile = null
  /** @type {string[]} */
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--allow') {
      const value = argv[++i]
      if (value === undefined) return null
      allowFile = value
    } else if (arg !== undefined) {
      positional.push(arg)
    }
  }
  const [range] = positional
  if (positional.length !== 1 || range === undefined) return null
  const parts = range.split('..')
  if (parts.length === 1) return { base: range, head: null, allowFile }
  const [base, head] = parts
  if (parts.length !== 2 || !base || !head) return null
  return { base, head, allowFile }
}

/**
 * @param {string | null} file
 * @returns {Promise<Set<string>>}
 */
async function readAllowList(file) {
  if (file === null) return new Set()
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`${file}: expected a JSON array of strings`)
  }
  return new Set(/** @type {string[]} */ (parsed))
}

/**
 * @param {string} fileName
 * @returns {ts.ScriptKind}
 */
function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  return /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

/** @typedef {{ node: ts.Node, text: string, line: number, column: number }} Token */

/**
 * The tokens of a file without trivia. JSDoc nodes are comments; whitespace-only JSX text is trivia.
 * @param {string} fileName
 * @param {string} text
 * @returns {Token[]}
 */
function tokenize(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName))
  /** @type {Token[]} */
  const tokens = []
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(source)
    if (children.length > 0 && node.kind !== ts.SyntaxKind.JsxText) {
      children.forEach(visit)
      return
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return
    const raw = node.getText(source)
    const tokenText = node.kind === ts.SyntaxKind.JsxText ? raw.replace(/\s+/g, ' ').trim() : raw
    if (tokenText === '') return
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    tokens.push({ node, text: tokenText, line: line + 1, column: character + 1 })
  }
  visit(source)
  return tokens
}

/**
 * Whether a string or template literal is the title of a `describe`/`it`/`test` call.
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isTestTitle(node) {
  /** @type {ts.Node} */
  let argument = node
  while (ts.isTemplateSpan(argument.parent) || ts.isTemplateExpression(argument.parent)) {
    argument = argument.parent
  }
  const call = argument.parent
  if (!ts.isCallExpression(call) || call.arguments[0] !== argument) return false
  /** @type {ts.Expression} */
  let callee = call.expression
  while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) {
    callee = callee.expression
  }
  return ts.isIdentifier(callee) && TITLE_FUNCTIONS.has(callee.text)
}

/**
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isStringLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)
}

/**
 * @param {Token} before
 * @param {Token} after
 * @param {Set<string>} allowed
 * @returns {boolean}
 */
function isAllowedChange(before, after, allowed) {
  if (before.node.kind !== after.node.kind || !isStringLike(before.node)) return false
  if (isTestTitle(before.node) && isTestTitle(after.node)) return true
  return ts.isStringLiteral(before.node) || ts.isNoSubstitutionTemplateLiteral(before.node)
    ? allowed.has(before.node.text)
    : false
}

/**
 * @param {string} path
 * @param {string} before
 * @param {string} after
 * @param {Set<string>} allowed
 * @param {Set<string>} used
 * @returns {string | null} the first disallowed difference, or null
 */
function compareFile(path, before, after, allowed, used) {
  const oldTokens = tokenize(path, before)
  const newTokens = tokenize(path, after)
  const length = Math.max(oldTokens.length, newTokens.length)
  for (let i = 0; i < length; i++) {
    const oldToken = oldTokens[i]
    const newToken = newTokens[i]
    if (oldToken === undefined || newToken === undefined) {
      const where = oldToken ?? newToken
      const position = where === undefined ? '' : `:${String(where.line)}:${String(where.column)}`
      return `${path}${position}: token count differs (old ${String(oldTokens.length)}, new ${String(newTokens.length)})`
    }
    if (oldToken.text === newToken.text) continue
    if (isAllowedChange(oldToken, newToken, allowed)) {
      if (ts.isStringLiteral(oldToken.node) || ts.isNoSubstitutionTemplateLiteral(oldToken.node)) {
        used.add(oldToken.node.text)
      }
      continue
    }
    return (
      `${path}: old ${String(oldToken.line)}:${String(oldToken.column)} ${JSON.stringify(oldToken.text)}` +
      ` -> new ${String(newToken.line)}:${String(newToken.column)} ${JSON.stringify(newToken.text)}`
    )
  }
  return null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) {
    console.error(USAGE)
    return 2
  }
  const { base, head, allowFile } = options
  const allowed = await readAllowList(allowFile)
  const root = (await git(['rev-parse', '--show-toplevel'])).trim()
  const diffArgs = ['diff', '--name-status', '--no-renames', '-z', base, ...(head === null ? [] : [head])]
  const fields = (await git(['-C', root, ...diffArgs])).split('\0').filter((field) => field !== '')

  /** @type {string[]} */
  const failures = []
  /** @type {Set<string>} */
  const used = new Set()
  let checked = 0
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? ''
    const path = fields[i + 1] ?? ''
    if (!SOURCE_EXTENSIONS.test(path)) continue
    if (status !== 'M') {
      failures.push(`${path}: status ${status}, only modified files are allowed`)
      continue
    }
    const before = await git(['-C', root, 'show', `${base}:${path}`])
    const after =
      head === null ? await readFile(`${root}/${path}`, 'utf8') : await git(['-C', root, 'show', `${head}:${path}`])
    checked++
    const failure = compareFile(path, before, after, allowed, used)
    if (failure !== null) failures.push(failure)
  }

  for (const entry of allowed) {
    if (!used.has(entry)) console.warn(`warning: allow-list entry not used: ${JSON.stringify(entry)}`)
  }
  for (const failure of failures) console.error(failure)
  console.log(`${String(checked)} file(s) compared, ${String(failures.length)} with a non-comment change`)
  return failures.length === 0 ? 0 : 1
}

process.exitCode = await main()
