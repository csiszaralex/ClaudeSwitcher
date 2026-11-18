import type { DecisionKind } from '@claudeswitcher/core'
import { BASH_TOOL, isRecord } from '@claudeswitcher/core/browser'

/**
 * A plain Hungarian line for each git call of a Bash permission request (the decision panel shows
 * them, `DecisionContent`). A fixed table of the common subcommands and the flags that change their
 * meaning; a call it cannot classify with confidence gets no line. Where git itself decides by what
 * exists in the repository (`git checkout <name>`: a file or a branch), the line names both outcomes.
 *
 * Pure and IO-free. It reads the command the way bash would split it, conservatively: it never
 * explains a command inside a `$(...)` or backtick substitution, and a call whose subcommand,
 * options or positional arguments come from an expansion (`$VAR`, `$(...)`, `{a,b}`) gets no line.
 * An option's value and a path after `--` may come from one.
 */

/** Two levels only: `danger` drops work or rewrites history. A read-only call is `normal`. */
export type GitLevel = 'normal' | 'danger'

export interface GitLine {
  /** The git call: the subcommand and the flag that decided the line, e.g. `git push --force`. */
  call: string
  level: GitLevel
  /** What the call does, in Hungarian. */
  text: string
}

interface GitSource {
  kind: DecisionKind
  toolName: string
  /** sanitizeState does not check `toolInput`, hence `unknown` (as in tool-details.ts). */
  toolInput: unknown
}

/**
 * The lines of a Bash request's command; empty for any other request, a command without git, or
 * an error in the parser (the panel must render either way).
 */
export function gitExplanation(decision: GitSource): GitLine[] {
  try {
    if (decision.kind !== 'tool' || decision.toolName !== BASH_TOOL || !isRecord(decision.toolInput)) return []
    const command = decision.toolInput['command']
    return typeof command === 'string' ? explainGitCommand(command) : []
  } catch {
    return []
  }
}

/**
 * One line per explained git call, in command order. The same line twice in a row (`git add a &&
 * git add b`) shows once. A command with an unclosed quote, substitution or arithmetic gets no lines
 * at all: bash runs the lines before it and refuses the rest, and where that rest ends is a guess.
 */
export function explainGitCommand(command: string): GitLine[] {
  const calls = lexCalls(command)
  if (calls === undefined) return []
  const lines: GitLine[] = []
  for (const call of calls) {
    const line = explainCall(call)
    if (line === undefined) continue
    const last = lines.at(-1)
    if (last?.call === line.call && last.text === line.text) continue
    lines.push(line)
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// Splitting and tokenizing, bash style

interface Token {
  /** The word with its quotes removed; an expansion stays in it as written. */
  text: string
  /** The index in `text` where the first expansion starts; `text.length` when there is none. */
  dynamicAt: number
}

function isDynamic(token: Token): boolean {
  return token.dynamicAt < token.text.length
}

interface Call {
  tokens: Token[]
  /** An output redirection to a file (`> out.txt`; not `/dev/null`, `NUL` or a descriptor). */
  writesFile: boolean
}

/** Thrown at an unclosed quote, substitution or arithmetic (`explainGitCommand` then explains nothing). */
class Unterminated extends Error {}

interface Heredoc {
  delimiter: string
  /** `<<-`: leading tabs are stripped from the body lines, the closing one included. */
  strip: boolean
}

/**
 * The command as calls (split at `&&`, `||`, `;`, `|`, `&`, `(`, `)` and newlines, never inside
 * quotes or a substitution), each a list of words. Redirections and their targets, comments,
 * here-document bodies and `(( … ))` arithmetic are left out. `undefined` at an unclosed quote,
 * substitution or arithmetic.
 */
function lexCalls(src: string): Call[] | undefined {
  try {
    return new Lexer(src).run()
  } catch (error) {
    if (error instanceof Unterminated) return undefined
    throw error
  }
}

/** A brace expansion (`{a,b}`, `{1..3}`) starting at a `{`: bash turns it into several words. */
const BRACE_EXPANSION = /^\{[^\s{}]*(?:,|\.\.)[^\s{}]*\}/

/** The redirection targets that write no file. */
function isNullDevice(word: string): boolean {
  return word === '/dev/null' || word.toLowerCase() === 'nul'
}

class Lexer {
  private pos = 0
  private readonly calls: Call[] = []
  private tokens: Token[] = []
  private writesFile = false
  private word = ''
  private inWord = false
  private dynamicAt: number | undefined
  /** What the next finished word is: an argument, a redirection target or a here-document delimiter. */
  private next: 'arg' | 'target' | 'heredoc' = 'arg'
  /** Whether the pending redirection target is written (`>`), not read (`<`). */
  private targetWritten = false
  private heredocStrip = false
  private heredocs: Heredoc[] = []
  private readonly src: string

  constructor(src: string) {
    this.src = src
  }

  run(): Call[] {
    const src = this.src
    while (this.pos < src.length) {
      const c = src.charAt(this.pos)
      const n = src.charAt(this.pos + 1)
      if (c === ' ' || c === '\t' || c === '\r') {
        this.endWord()
        this.pos++
      } else if (c === '\n') {
        this.endWord()
        this.pos = skipHeredocBodies(src, this.pos + 1, this.heredocs)
        this.heredocs = []
        this.endCall()
      } else if (c === '#' && !this.inWord) {
        const end = src.indexOf('\n', this.pos)
        this.pos = end === -1 ? src.length : end
      } else if (c === '\\') {
        // A backslash before a newline continues the line; before anything else it quotes it.
        if (n !== '\n') this.append(n)
        this.pos += 2
      } else if (c === "'") {
        const end = src.indexOf("'", this.pos + 1)
        if (end === -1) throw new Unterminated()
        this.append(src.slice(this.pos + 1, end))
        this.pos = end + 1
      } else if (c === '"') {
        const double = readDouble(src, this.pos + 1)
        if (double.dynamicAt !== undefined) this.markDynamic(double.dynamicAt)
        this.append(double.text)
        this.pos = double.end
      } else if (c === '`') {
        this.appendDynamic(skipBackticks(src, this.pos + 1))
      } else if (c === '$' && (n === '(' || n === '{' || n === "'" || /[\w@*#?$!-]/.test(n))) {
        this.appendDynamic(skipDollar(src, this.pos))
      } else if ((c === '<' || c === '>') && n === '(') {
        // A process substitution: its own command, never explained.
        this.appendDynamic(skipParens(src, this.pos + 2))
      } else if (c === '<' || c === '>' || (c === '&' && n === '>')) {
        this.redirect()
      } else if (c === '(' && n === '(' && !this.inWord) {
        // `(( … ))` arithmetic: no command, and its `<<` is a shift, not a here-document.
        this.endCall()
        this.pos = skipArithmetic(src, this.pos + 2)
        this.endCall()
      } else if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') {
        this.endCall()
        this.pos++
      } else {
        if (c === '{' && BRACE_EXPANSION.test(src.slice(this.pos))) this.markDynamic(0)
        this.append(c)
        this.pos++
      }
    }
    this.endCall()
    return this.calls
  }

  private append(text: string): void {
    this.word += text
    this.inWord = true
  }

  private markDynamic(offset: number): void {
    this.dynamicAt ??= this.word.length + offset
  }

  /** Appends the raw text from `pos` to `end` as an expansion. */
  private appendDynamic(end: number): void {
    this.markDynamic(0)
    this.append(this.src.slice(this.pos, end))
    this.pos = end
  }

  /** A redirection (`>`, `2>&1`, `<<EOF`, `&>`, …): neither it nor its target is an argument. */
  private redirect(): void {
    const src = this.src
    // A file descriptor number right before the operator (`2>`) belongs to it.
    if (this.inWord && this.dynamicAt === undefined && /^\d+$/.test(this.word)) {
      this.word = ''
      this.inWord = false
    } else {
      this.endWord()
    }
    if (src.startsWith('<<<', this.pos)) {
      this.pos += 3
      this.next = 'target'
      this.targetWritten = false
      return
    }
    if (src.startsWith('<<', this.pos)) {
      this.pos += 2
      this.heredocStrip = src.charAt(this.pos) === '-'
      if (this.heredocStrip) this.pos++
      this.next = 'heredoc'
      return
    }
    let operator = ''
    while (this.pos < src.length && '<>&|'.includes(src.charAt(this.pos))) {
      operator += src.charAt(this.pos)
      this.pos++
    }
    if (operator.endsWith('&')) {
      // `>&2`, `2>&1`, `>&-`: a descriptor, no file name follows.
      const fd = /^(\d+|-)/.exec(src.slice(this.pos))
      if (fd !== null) {
        this.pos += fd[0].length
        return
      }
    }
    this.next = 'target'
    this.targetWritten = operator.includes('>')
  }

  private endWord(): void {
    if (!this.inWord) return
    if (this.next === 'heredoc') this.heredocs.push({ delimiter: this.word, strip: this.heredocStrip })
    else if (this.next === 'target') {
      // A target from an expansion may be any file.
      if (this.targetWritten && (this.dynamicAt !== undefined || !isNullDevice(this.word))) this.writesFile = true
    } else this.tokens.push({ text: this.word, dynamicAt: this.dynamicAt ?? this.word.length })
    this.next = 'arg'
    this.word = ''
    this.inWord = false
    this.dynamicAt = undefined
  }

  private endCall(): void {
    this.endWord()
    this.next = 'arg'
    if (this.tokens.length > 0) this.calls.push({ tokens: this.tokens, writesFile: this.writesFile })
    this.tokens = []
    this.writesFile = false
  }
}

/** The text of a double-quoted string starting after its `"`, and the index after the closing one. */
function readDouble(src: string, start: number): { text: string; dynamicAt: number | undefined; end: number } {
  let text = ''
  let dynamicAt: number | undefined
  let pos = start
  while (pos < src.length) {
    const c = src.charAt(pos)
    const n = src.charAt(pos + 1)
    if (c === '"') return { text, dynamicAt, end: pos + 1 }
    if (c === '\\') {
      if (n === '\n') {
        // A line continuation: nothing.
      } else if ('$`"\\'.includes(n) && n !== '') text += n
      else text += c + n
      pos += 2
    } else if (c === '`' || (c === '$' && (n === '(' || n === '{' || /[\w@*#?$!-]/.test(n)))) {
      const end = c === '`' ? skipBackticks(src, pos + 1) : skipDollar(src, pos)
      dynamicAt ??= text.length
      text += src.slice(pos, end)
      pos = end
    } else {
      text += c
      pos++
    }
  }
  throw new Unterminated()
}

/** The index after the closing backtick of a substitution starting after its opening one. */
function skipBackticks(src: string, start: number): number {
  for (let pos = start; pos < src.length; pos++) {
    const c = src.charAt(pos)
    if (c === '\\') pos++
    else if (c === '`') return pos + 1
  }
  throw new Unterminated()
}

/** The index after a `$` expansion starting at `pos`: `$(...)`, `$((...))`, `${...}`, `$'...'`, `$name`. */
function skipDollar(src: string, pos: number): number {
  const n = src.charAt(pos + 1)
  if (n === '(') return src.charAt(pos + 2) === '(' ? skipArithmetic(src, pos + 3) : skipParens(src, pos + 2)
  if (n === '{') return skipBraces(src, pos + 2)
  if (n === "'") {
    for (let at = pos + 2; at < src.length; at++) {
      const c = src.charAt(at)
      if (c === '\\') at++
      else if (c === "'") return at + 1
    }
    throw new Unterminated()
  }
  // `$name`, or one special parameter (`$?`, `$1`, …).
  const name = /^[A-Za-z_]\w*/.exec(src.slice(pos + 1))
  return pos + 1 + (name === null ? 1 : name[0].length)
}

/** The index after the `))` that closes an arithmetic whose content starts at `start`, by parentheses only. */
function skipArithmetic(src: string, start: number): number {
  let depth = 2
  for (let pos = start; pos < src.length; pos++) {
    const c = src.charAt(pos)
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return pos + 1
  }
  throw new Unterminated()
}

function skipBraces(src: string, start: number): number {
  let depth = 1
  for (let pos = start; pos < src.length; pos++) {
    const c = src.charAt(pos)
    if (c === '\\') pos++
    else if (c === "'") {
      pos = src.indexOf("'", pos + 1)
      if (pos === -1) throw new Unterminated()
    } else if (c === '"') pos = readDouble(src, pos + 1).end - 1
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return pos + 1
  }
  throw new Unterminated()
}

/**
 * The index after the `)` that closes a substitution whose content starts at `start`. Skips quotes,
 * nested substitutions, comments and here-document bodies (a commit message in `$(cat <<'EOF' … EOF)`
 * may contain anything). A `case` pattern's lone `)` is not handled: bash's own grammar is needed there.
 */
function skipParens(src: string, start: number): number {
  let depth = 1
  let heredocs: Heredoc[] = []
  let pos = start
  while (pos < src.length) {
    const c = src.charAt(pos)
    if (c === '\\') pos += 2
    else if (c === "'") {
      const end = src.indexOf("'", pos + 1)
      if (end === -1) throw new Unterminated()
      pos = end + 1
    } else if (c === '"') pos = readDouble(src, pos + 1).end
    else if (c === '`') pos = skipBackticks(src, pos + 1)
    else if (c === '#' && /[\s;&|()]/.test(src.charAt(pos - 1))) {
      const end = src.indexOf('\n', pos)
      pos = end === -1 ? src.length : end
    } else if (src.startsWith('<<', pos) && !src.startsWith('<<<', pos)) {
      const heredoc = readHeredocStart(src, pos + 2)
      heredocs.push(heredoc.heredoc)
      pos = heredoc.end
    } else if (c === '\n') {
      pos = skipHeredocBodies(src, pos + 1, heredocs)
      heredocs = []
    } else if (c === '(') {
      depth++
      pos++
    } else if (c === ')') {
      if (--depth === 0) return pos + 1
      pos++
    } else pos++
  }
  throw new Unterminated()
}

/** The delimiter of a here-document operator whose `<<` ends before `start`. */
function readHeredocStart(src: string, start: number): { heredoc: Heredoc; end: number } {
  let pos = start
  const strip = src.charAt(pos) === '-'
  if (strip) pos++
  while (src.charAt(pos) === ' ' || src.charAt(pos) === '\t') pos++
  let delimiter = ''
  while (pos < src.length && !/[\s;&|()<>]/.test(src.charAt(pos))) {
    const c = src.charAt(pos)
    if (c !== "'" && c !== '"' && c !== '\\') delimiter += c
    pos++
  }
  return { heredoc: { delimiter, strip }, end: pos }
}

/** Skips the bodies of the pending here-documents, which start at `pos` (after a newline), in order. */
function skipHeredocBodies(src: string, pos: number, heredocs: readonly Heredoc[]): number {
  let at = pos
  for (const { delimiter, strip } of heredocs) {
    while (at < src.length) {
      const end = src.indexOf('\n', at)
      const raw = src.slice(at, end === -1 ? src.length : end).replace(/\r$/, '')
      at = end === -1 ? src.length : end + 1
      if ((strip ? raw.replace(/^\t+/, '') : raw) === delimiter) break
    }
  }
  return at
}

// ---------------------------------------------------------------------------------------------
// Finding the git call

/** `FOO=bar` before the command name. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/

/**
 * Words before the command that still run it: shell keywords (`if git diff --quiet; then git
 * commit …`), `!`, `{`, and the wrappers. A wrapper followed by an option of its own (`sudo -u`,
 * `command -v`, `env -i`, `xargs -0`) gives no line.
 */
const LEADING_WORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'command', 'exec', 'sudo', 'nohup', 'xargs', 'env'])

/**
 * The words `xargs` appends to the command: unknown, so a positional from them makes the call
 * uncertain like an expansion does.
 */
const XARGS_INPUT: Token = { text: '<xargs>', dynamicAt: 0 }

/** Global options that take the next word as their value. */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--paginate', '-p', '--no-replace-objects', '--literal-pathspecs'])
const GLOBAL_WITH_EQUALS = ['--git-dir=', '--work-tree=', '--namespace=']

/**
 * Config sections whose keys change what the explained subcommands do (`pull.rebase`,
 * `push.default`, `clean.requireForce`, an alias). A `-c` setting one gives no line.
 */
const CONFIG_SECTIONS = ['pull.', 'push.', 'remote.', 'branch.', 'clean.', 'rebase.', 'alias.']

/** `git`, `git.exe`, also by a path (`/usr/bin/git`, `"C:\Program Files\Git\cmd\git.exe"`). */
function isGit(word: string): boolean {
  const name = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase()
  return name === 'git' || name === 'git.exe'
}

function explainCall({ tokens, writesFile }: Call): GitLine | undefined {
  let at = 0
  let fromXargs = false
  for (;;) {
    const token = tokens[at]
    if (token === undefined) return undefined
    if (ASSIGNMENT.test(token.text)) {
      // `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, …: they can set any key.
      if (token.text.startsWith('GIT_CONFIG')) return undefined
      at++
    } else if (!isDynamic(token) && LEADING_WORDS.has(token.text)) {
      if (tokens[at + 1]?.text.startsWith('-') === true) return undefined
      if (token.text === 'xargs') fromXargs = true
      at++
    } else break
  }
  const exe = tokens[at]
  if (exe === undefined || isDynamic(exe) || !isGit(exe.text)) return undefined
  at++
  for (;;) {
    const token = tokens[at]
    if (token === undefined || isDynamic(token)) return undefined
    if (token.text === '-c') {
      const setting = tokens[at + 1]
      if (setting === undefined || isDynamic(setting)) return undefined
      const key = setting.text.split('=')[0]?.toLowerCase() ?? ''
      if (CONFIG_SECTIONS.some((section) => key.startsWith(section))) return undefined
      at += 2
    } else if (GLOBAL_WITH_VALUE.has(token.text)) at += 2
    else if (GLOBAL_FLAGS.has(token.text) || GLOBAL_WITH_EQUALS.some((prefix) => token.text.startsWith(prefix))) at++
    else if (token.text.startsWith('-')) return undefined
    else break
  }
  const sub = tokens[at]?.text ?? ''
  const explain = SUBCOMMANDS.get(sub)
  if (explain === undefined) return undefined
  const args = tokens.slice(at + 1)
  const result = explain(fromXargs ? [...args, XARGS_INPUT] : args)
  // `git status > status.txt` writes a file: not read-only any more.
  if (result === undefined || (result.readOnly === true && writesFile)) return undefined
  return {
    call: result.decider === undefined ? `git ${sub}` : `git ${sub} ${result.decider}`,
    level: result.level,
    text: result.text,
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a subcommand's arguments

interface ArgSpec {
  /** Short options that take a value (attached, `-mtext`, or the next word). The letters are from `git <subcommand> -h`. */
  shortValues?: string
  /** Short options whose value is optional and only attached (`-S<keyid>`, `-uno`): never the next word. */
  shortOptional?: string
  /** Long options that take the next word as their value when no `=` is given. */
  longValues?: readonly string[]
  /**
   * The long options that decide the line, and any real option that is a prefix of one (`--prune`
   * of `--prune-tags`). git accepts any unambiguous prefix of a long option, so a strict prefix of
   * one of these that is not listed itself (`--am` for `--amend`) makes the call uncertain, and so
   * does the negated form (`--no-force`).
   */
  deciding?: readonly string[]
}

interface Args {
  /** A short option letter, and the word it came in (`-fdx`). */
  shorts: Map<string, string>
  /** A long option's name, and the word it came in (`--force-with-lease=main`). */
  longs: Map<string, string>
  /** The long option names in command order, repeats included. */
  longOrder: string[]
  /** The value after `=` of a long option. */
  longValues: Map<string, string>
  positionals: string[]
  /** Whether a bare `--` came, and the words after it. */
  dashDash: boolean
  paths: string[]
}

/**
 * Takes the next word as an option's value. `false` when there is none that can be one: a word
 * starting with `-` would be read as an option by the user, not as the value git takes (`-` alone,
 * stdin for `-F`, is a value).
 */
function takesValue(next: Token | undefined): boolean {
  return next === undefined || next.text === '-' || !next.text.startsWith('-')
}

/**
 * The arguments by kind, or `undefined` when the call is uncertain: a help request (`-h`,
 * `--help`), an abbreviated or negated deciding option, an option whose value looks like an option,
 * or an option or positional that comes from an expansion (it could be anything, `--force` too).
 * An option's value and a path after `--` may.
 */
function parseArgs(tokens: readonly Token[], spec: ArgSpec = {}): Args | undefined {
  const args: Args = {
    shorts: new Map(),
    longs: new Map(),
    longOrder: [],
    longValues: new Map(),
    positionals: [],
    dashDash: false,
    paths: [],
  }
  const deciding = spec.deciding ?? []
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]
    if (token === undefined) break
    const { text, dynamicAt } = token
    if (args.dashDash) {
      args.paths.push(text)
    } else if (text === '--') {
      args.dashDash = true
    } else if (text.startsWith('--')) {
      const equals = text.indexOf('=')
      const name = text.slice(2, equals === -1 ? undefined : equals)
      if (dynamicAt < (equals === -1 ? text.length : equals)) return undefined
      if (name === 'help') return undefined
      // `--force` itself is fine, though it is also a prefix of `--force-with-lease`.
      if (!deciding.includes(name) && deciding.some((full) => full.startsWith(name))) return undefined
      if (name.startsWith('no-') && deciding.includes(name.slice(3))) return undefined
      args.longs.set(name, text)
      args.longOrder.push(name)
      if (equals !== -1) args.longValues.set(name, text.slice(equals + 1))
      else if (spec.longValues?.includes(name) === true) {
        if (!takesValue(tokens[at + 1])) return undefined
        at++
      }
    } else if (text.startsWith('-') && text.length > 1) {
      if (text === '-h') return undefined
      for (let index = 1; index < text.length; index++) {
        if (index >= dynamicAt) return undefined
        const letter = text.charAt(index)
        args.shorts.set(letter, text)
        // The rest of the word is the value of an optional-value option: not more flags.
        if (spec.shortOptional?.includes(letter) === true) break
        if (spec.shortValues?.includes(letter) === true) {
          if (index === text.length - 1) {
            if (!takesValue(tokens[at + 1])) return undefined
            at++
          }
          break
        }
      }
    } else {
      if (isDynamic(token)) return undefined
      args.positionals.push(text)
    }
  }
  return args
}

/** The word in which the first of these options came (a short letter or a long name), if any. */
function flag(args: Args, short: string | undefined, ...longs: readonly string[]): string | undefined {
  if (short !== undefined) {
    const word = args.shorts.get(short)
    if (word !== undefined) return word
  }
  for (const long of longs) {
    const word = args.longs.get(long)
    if (word !== undefined) return word
  }
  return undefined
}

/** Whether the call has any option at all. */
function hasOptions(args: Args): boolean {
  return args.shorts.size > 0 || args.longs.size > 0
}

/** Whether every option of the call is one of these. */
function onlyOptions(args: Args, shorts: string, longs: readonly string[]): boolean {
  return [...args.shorts.keys()].every((letter) => shorts.includes(letter)) && [...args.longs.keys()].every((name) => longs.includes(name))
}

/** Two option words as a label, once when they are the same word (`-SW`, `-df`). */
function both(first: string, second: string): string {
  return first === second ? first : `${first} ${second}`
}

// ---------------------------------------------------------------------------------------------
// The table

interface Explained {
  /** The word or words that decided the line; shown after the subcommand. */
  decider?: string | undefined
  level: GitLevel
  text: string
  /** The line says the call changes nothing (read-only, or a dry run). */
  readOnly?: boolean
}

type Explain = (tokens: readonly Token[]) => Explained | undefined

const READ_ONLY = 'Csak olvas, nem változtat semmit.'

const normal = (text: string, decider?: string): Explained => ({ level: 'normal', text, decider })
const danger = (text: string, decider?: string): Explained => ({ level: 'danger', text, decider })
/** A line that says the call changes nothing: a read-only call or a dry run. */
const unchanged = (text: string, decider?: string): Explained => ({ level: 'normal', text, decider, readOnly: true })

/** `checkout -- <path>`, `checkout .`, `restore <path>`: the files go back, their changes are lost. */
const RESTORE_PATHS = 'Visszaállítja a megadott fájlokat, a munkakönyvtárban lévő változtatásaik elvesznek.'
/** `checkout -f`, `reset --hard` without a commit. Untracked files stay, hence "követett". */
const DISCARD_ALL = 'Eldobja a követett fájlok összes nem commitolt változtatását.'
const SWITCH_AND_DISCARD = 'Átvált a megadott branchre, és eldobja a követett fájlok nem commitolt változtatásait.'
const CREATE_AND_SWITCH = 'Létrehoz egy új branchet, és átvált rá.'
const SWITCH = 'Átvált egy másik branchre.'
const SWITCH_BACK = 'Visszavált az előző branchre.'
const DETACH = 'Átvált a megadott commitra, branch nélkül.'
const KEEP_FILES = 'A fájlokban lévő változtatások megmaradnak.'
const UNSTAGE_PATHS = `Visszavonja a megadott fájlok előkészítését. ${KEEP_FILES}`

/**
 * `git checkout <name>`: git decides by what exists. A file or a folder of that name is overwritten
 * (measured with a folder, `git checkout src`: its changes were lost), else it switches.
 */
const CHECKOUT_NAME = 'Ha a megadott név fájl vagy mappa, eldobja a változtatásait. Ha branch, átvált rá.'
/** The level of `CHECKOUT_NAME`: the one place to change it. */
const CHECKOUT_NAME_LEVEL: GitLevel = 'danger'

/**
 * The options that put `git branch` and `git tag` into list mode even with a name, which is then a
 * pattern (measured, git 2.55: `branch --points-at`, `branch --no-merged`, `tag --merged`).
 */
const LIST_MODE_OPTIONS = ['list', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at']

/** A read-only subcommand; `--output=<file>` would write a file, so it gets no line. */
function readOnly(text: string, options: { output: boolean }): Explain {
  return (tokens) => {
    const args = parseArgs(tokens, { deciding: options.output ? ['output'] : [] })
    if (args === undefined || (options.output && args.longs.has('output'))) return undefined
    return unchanged(`${text} ${READ_ONLY}`)
  }
}

/**
 * A revision by its suffix form only: `name~2`, `name^`, `HEAD~`, `name@{1}`, `@{-1}`, `@`, and
 * the merge base `a...b`. A leading `~`, or a `/` before the suffix (`src/notes~`), may be a file.
 * `a..b` is no revision for checkout: git takes it as a path (measured, git 2.55).
 */
function isRevision(word: string): boolean {
  if (word === '@') return true
  if (/^[^~^/:\s@{}]+(?:[~^]\d*)+$/.test(word)) return true
  if (/^[^~^/:\s@{}]*@\{[^}]+\}$/.test(word)) return true
  const sides = word.split('...')
  return sides.length === 2 && sides.every((side) => !/\.\.|\s/.test(side))
}

/**
 * A word git check-ref-format forbids in a branch name and that is no revision form: a leading `.`
 * (`.`, `./src`, `.env`), `..` (`a..b` too), a space, one of `*?[\`, or a trailing `/`. After
 * `checkout` it can only be a path, whatever `CHECKOUT_NAME_LEVEL` says.
 */
function isClearlyPath(word: string): boolean {
  return /^\.|\.\.|[\s*?[\\]|\/$/.test(word)
}

function checkout(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'bBU',
    shortOptional: 't',
    longValues: ['orphan', 'conflict', 'unified', 'pathspec-from-file'],
    deciding: ['force', 'patch', 'orphan', 'ours', 'theirs', 'pathspec-from-file'],
  })
  if (args === undefined) return undefined
  if (flag(args, 'p', 'patch', 'orphan', 'pathspec-from-file') !== undefined || args.shorts.has('B')) return undefined
  const force = flag(args, 'f', 'force')
  const hasPaths = args.dashDash && args.paths.length > 0
  if (force !== undefined) {
    if (hasPaths) return danger(RESTORE_PATHS, '--')
    return args.positionals.length > 0 ? danger(SWITCH_AND_DISCARD, force) : danger(DISCARD_ALL, force)
  }
  if (hasPaths || flag(args, undefined, 'ours', 'theirs') !== undefined) return danger(RESTORE_PATHS, hasPaths ? '--' : undefined)
  const create = args.shorts.get('b')
  if (create !== undefined) return normal(CREATE_AND_SWITCH, create)
  const [target, ...rest] = args.positionals
  if (target === undefined) return undefined
  // A revision before paths (`checkout main file.txt`) or several paths: files are overwritten.
  if (rest.length > 0) return danger(RESTORE_PATHS)
  if (target === '.') return danger(RESTORE_PATHS, '.')
  if (target === '-') return normal(SWITCH_BACK, '-')
  if (isRevision(target)) return normal(DETACH)
  if (isClearlyPath(target)) return danger(RESTORE_PATHS)
  return { level: CHECKOUT_NAME_LEVEL, text: CHECKOUT_NAME }
}

function switchBranch(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'cC',
    shortOptional: 't',
    longValues: ['create', 'force-create', 'orphan'],
    deciding: ['force', 'force-create', 'discard-changes', 'create', 'detach', 'orphan'],
  })
  if (args === undefined) return undefined
  if (flag(args, 'C', 'force-create', 'orphan') !== undefined) return undefined
  const force = flag(args, 'f', 'force', 'discard-changes')
  if (force !== undefined) return danger(SWITCH_AND_DISCARD, force)
  const create = flag(args, 'c', 'create')
  if (create !== undefined) return normal(CREATE_AND_SWITCH, create)
  if (args.positionals.length === 0) return undefined
  const detach = flag(args, 'd', 'detach')
  if (detach !== undefined) return normal(DETACH, detach)
  return normal(args.positionals[0] === '-' ? SWITCH_BACK : SWITCH)
}

/** The options of `git branch` that only list. */
const BRANCH_LIST_SHORTS = 'varl'
const BRANCH_LIST_LONGS = ['all', 'remotes', 'verbose', 'sort', 'format', 'color', 'no-color', 'column', 'no-column', 'ignore-case', 'abbrev', 'no-abbrev', ...LIST_MODE_OPTIONS]

function branch(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'u',
    shortOptional: 't',
    longValues: ['sort', 'format', 'points-at', 'set-upstream-to'],
    deciding: ['delete', 'force', 'list'],
  })
  if (args === undefined) return undefined
  const remote = flag(args, 'r', 'remotes')
  const forceDelete = args.shorts.get('D')
  const del = flag(args, 'd', 'delete')
  const force = flag(args, 'f', 'force')
  if (forceDelete !== undefined || (del !== undefined && force !== undefined)) {
    // `-dr` deletes a remote-tracking branch, not a local one.
    if (remote !== undefined) return undefined
    return danger(
      'Töröl egy helyi branchet akkor is, ha a commitjai nincsenek beolvasztva. Ezek a commitok elveszhetnek.',
      forceDelete ?? both(del ?? '', force ?? ''),
    )
  }
  if (del !== undefined) {
    if (remote !== undefined) return undefined
    return normal('Töröl egy helyi branchet, de csak akkor, ha már be van olvasztva.', del)
  }
  if (!onlyOptions(args, BRANCH_LIST_SHORTS, BRANCH_LIST_LONGS)) return undefined
  if (args.positionals.length === 0 || args.shorts.has('l') || LIST_MODE_OPTIONS.some((name) => args.longs.has(name))) {
    return unchanged(`Kilistázza a brancheket. ${READ_ONLY}`)
  }
  // `git branch -v name` creates too, but `-a` or `-r` with a name is refused (measured, git 2.55).
  if (hasOptions(args)) return undefined
  return normal('Létrehoz egy új branchet, de nem vált át rá.')
}

function remote(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, { deciding: ['verbose'] })
  // Only the listing form: no subcommand, at most `-v` (git remote takes no `-a`, `-r` or `--list`).
  if (args === undefined || args.positionals.length > 0 || args.dashDash || !onlyOptions(args, 'v', ['verbose'])) return undefined
  return unchanged(`Kilistázza a távoli repókat. ${READ_ONLY}`)
}

function fetch(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'jo',
    longValues: ['depth', 'deepen', 'shallow-since', 'shallow-exclude', 'refmap', 'upload-pack', 'jobs', 'negotiation-tip', 'server-option'],
    deciding: ['force', 'prune', 'prune-tags', 'update-head-ok'],
  })
  if (args === undefined) return undefined
  // These can move or delete local refs: a local branch (`main:main`, `-u`), a tag (`-P`, `-f`).
  if (flag(args, 'f', 'force') !== undefined || flag(args, 'P', 'prune-tags') !== undefined || flag(args, 'u', 'update-head-ok') !== undefined) {
    return undefined
  }
  if (args.positionals.some((word) => word.includes(':') || word.startsWith('+'))) return undefined
  return normal('Letölti a távoli repó újdonságait, de a munkádhoz és a helyi branchekhez nem nyúl.')
}

function add(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, { shortValues: 'U', longValues: ['pathspec-from-file', 'chmod', 'unified'], deciding: ['dry-run'] })
  if (args === undefined) return undefined
  const dry = flag(args, 'n', 'dry-run')
  if (dry !== undefined) return unchanged('Csak megmutatja, mit készítene elő. Nem változtat semmit.', dry)
  return normal('Előkészíti a megadott változtatásokat a következő commithoz.')
}

function commit(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'mFCctU',
    shortOptional: 'Su',
    longValues: ['message', 'file', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'author', 'date', 'template', 'cleanup', 'trailer', 'pathspec-from-file', 'unified'],
    deciding: ['amend', 'dry-run', 'short', 'porcelain', 'long'],
  })
  if (args === undefined) return undefined
  // `--short`, `--porcelain` and `--long` imply `--dry-run` (measured: no commit made).
  const dry = flag(args, undefined, 'dry-run', 'short', 'porcelain', 'long')
  if (dry !== undefined) return unchanged('Csak megmutatja, mi kerülne a commitba. Nem rögzít semmit.', dry)
  const amend = args.longs.get('amend')
  if (amend !== undefined) return danger('Átírja az utolsó commitot, vagyis a történetet.', amend)
  return normal('Egy új commitban rögzíti a változtatásokat.')
}

function merge(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'mFsX',
    shortOptional: 'S',
    longValues: ['message', 'file', 'strategy', 'strategy-option', 'cleanup', 'into-name'],
    deciding: ['abort', 'quit', 'continue'],
  })
  if (args === undefined || flag(args, undefined, 'abort', 'quit', 'continue') !== undefined) return undefined
  return normal('Beolvaszt egy másik branchet az aktuális branchbe.')
}

/** The words git reads as a false boolean (`--rebase=no`; measured: then it merges). */
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

function pull(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'sXo',
    shortOptional: 'Sjr',
    longValues: ['depth', 'deepen', 'shallow-since', 'shallow-exclude', 'upload-pack', 'strategy', 'strategy-option', 'server-option'],
    deciding: ['rebase', 'force', 'dry-run'],
  })
  if (args === undefined) return undefined
  if (flag(args, 'f', 'force', 'dry-run') !== undefined) return undefined
  if (args.positionals.some((word) => word.includes(':') || word.startsWith('+'))) return undefined
  const rebase = flag(args, 'r', 'rebase')
  if (rebase === undefined) {
    // The config (`pull.rebase`) may choose a rebase; an `-c` that sets it gives no line (`CONFIG_SECTIONS`).
    return normal('Letölti a távoli repó újdonságait, és beépíti őket az aktuális branchbe. A beállítástól függően ezt rebase-zel teszi.')
  }
  if (FALSE_WORDS.has(args.longValues.get('rebase') ?? '')) {
    return normal('Letölti a távoli repó újdonságait, és beolvasztja őket az aktuális branchbe.', rebase)
  }
  return normal('Letölti a távoli repó újdonságait, és a tetejükre helyezi át a helyi commitjaidat.', rebase)
}

function stash(tokens: readonly Token[]): Explained | undefined {
  const first = tokens[0]
  if (first !== undefined && isDynamic(first)) return undefined
  // No subcommand, or options first (`git stash -u`, `git stash -- file`): that is `push`.
  const sub = first === undefined || first.text.startsWith('-') ? 'push' : first.text
  const rest = first === undefined || first.text.startsWith('-') ? tokens : tokens.slice(1)
  const args = parseArgs(rest, { shortValues: 'm', longValues: ['message', 'pathspec-from-file'] })
  if (args === undefined) return undefined
  const decider = sub === first?.text ? sub : undefined
  switch (sub) {
    case 'push':
    case 'save':
      return normal('Félreteszi a nem commitolt változtatásokat. Később visszahozhatók.', decider)
    case 'pop':
      return normal('Visszahozza a félretett változtatásokat, és ha sikerül, törli őket a félretettek közül.', decider)
    case 'apply':
      return normal('Visszahozza a félretett változtatásokat, és a félretettek között is megtartja őket.', decider)
    case 'list':
      return unchanged(`Kilistázza a félretett változtatásokat. ${READ_ONLY}`, decider)
    case 'show':
      return unchanged(`Megmutat egy félretett változtatást. ${READ_ONLY}`, decider)
    case 'drop':
      return danger('Töröl egy félretett változtatást. Utána csak nehezen hozható vissza.', decider)
    case 'clear':
      return danger('Törli az összes félretett változtatást. Utána csak nehezen hozhatók vissza.', decider)
    default:
      return undefined
  }
}

function tag(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'mFu',
    shortOptional: 'n',
    longValues: ['message', 'file', 'local-user', 'contains', 'no-contains', 'points-at', 'sort', 'format', 'cleanup'],
    deciding: ['delete', 'force', 'verify', 'list'],
  })
  if (args === undefined || flag(args, 'v', 'verify') !== undefined) return undefined
  const del = flag(args, 'd', 'delete')
  if (del !== undefined) return normal('Töröl egy helyi taget.', del)
  // `-n<k>` lists too, with a name as a pattern (measured: `git tag -n name` made no tag).
  if (args.positionals.length === 0 || args.shorts.has('l') || args.shorts.has('n') || LIST_MODE_OPTIONS.some((name) => args.longs.has(name))) {
    return unchanged(`Kilistázza a tageket. ${READ_ONLY}`)
  }
  const force = flag(args, 'f', 'force')
  if (force !== undefined) return normal('Létrehoz egy taget, és felülírja, ha már van ilyen nevű.', force)
  return normal('Létrehoz egy új taget.')
}

function cherryPick(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'mX',
    shortOptional: 'S',
    longValues: ['mainline', 'strategy', 'strategy-option'],
    deciding: ['abort', 'continue', 'skip', 'quit'],
  })
  if (args === undefined || flag(args, undefined, 'abort', 'continue', 'skip', 'quit') !== undefined) return undefined
  return normal('Átveszi a megadott commitok változtatásait az aktuális branchre.')
}

function restore(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'sU',
    longValues: ['source', 'pathspec-from-file', 'unified'],
    deciding: ['staged', 'worktree', 'ours', 'theirs', 'pathspec-from-file'],
  })
  if (args === undefined || args.longs.has('pathspec-from-file')) return undefined
  const staged = flag(args, 'S', 'staged')
  const worktree = flag(args, 'W', 'worktree')
  if (staged !== undefined && worktree === undefined) return normal(UNSTAGE_PATHS, staged)
  return danger(RESTORE_PATHS, staged !== undefined && worktree !== undefined ? both(staged, worktree) : undefined)
}

const RESET_MODES = ['hard', 'soft', 'mixed', 'keep', 'merge']

function reset(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, { shortValues: 'U', longValues: ['pathspec-from-file', 'unified'], deciding: [...RESET_MODES, 'patch'] })
  if (args === undefined || flag(args, 'p', 'patch') !== undefined) return undefined
  // Of several modes the last one wins.
  const mode = args.longOrder.filter((name) => RESET_MODES.includes(name)).at(-1)
  const decider = mode === undefined ? undefined : args.longs.get(mode)
  const [target, ...rest] = args.positionals
  const onHead = rest.length === 0 && (target === undefined || target === 'HEAD')
  if (mode === 'keep' || mode === 'merge') return undefined
  if (mode === 'hard') {
    if (onHead && args.paths.length === 0) return danger(DISCARD_ALL, decider)
    return danger('Eldobja a követett fájlok összes nem commitolt változtatását, a branchet pedig a megadott commitra állítja.', decider)
  }
  if (mode === 'soft') return normal('A branchet a megadott commitra állítja. A fájlok és az előkészítés megmaradnak.', decider)
  // `--mixed`, or no mode: the default, mixed.
  if (onHead && args.paths.length === 0) return normal(`Visszavonja az összes előkészítést. ${KEEP_FILES}`, decider)
  if (onHead) return normal(UNSTAGE_PATHS, decider)
  return normal(`A branchet a megadott commitra állítja, vagy visszavonja a fájlok előkészítését. ${KEEP_FILES}`, decider)
}

function clean(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, { shortValues: 'e', longValues: ['exclude'], deciding: ['force', 'dry-run'] })
  if (args === undefined) return undefined
  // The label shows the options as written (`-fdx`), without the exclude patterns.
  const options = [...new Set([...args.shorts.values(), ...args.longs.values()])]
    .filter((word) => !word.startsWith('-e') && !word.startsWith('--exclude'))
    .join(' ')
  if (flag(args, 'n', 'dry-run') !== undefined) return unchanged('Csak megmutatja, mit törölne. Nem töröl semmit.', options)
  // Without `-f` git refuses (`clean.requireForce` is on by default), unless the config turned it off.
  if (flag(args, 'f', 'force') === undefined) return undefined
  const what = args.shorts.has('d') ? 'fájlokat és mappákat' : 'fájlokat'
  if (args.shorts.has('X')) return danger(`Véglegesen törli a gitignore szerint kihagyott ${what}.`, options)
  if (args.shorts.has('x')) return danger(`Véglegesen törli a nem követett ${what}, a gitignore szerint kihagyottakat is.`, options)
  return danger(`Véglegesen törli a nem követett ${what}.`, options)
}

function rebase(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'sXxC',
    shortOptional: 'Sr',
    longValues: ['onto', 'strategy', 'strategy-option', 'exec'],
    deciding: ['abort', 'skip', 'quit', 'continue', 'edit-todo', 'show-current-patch'],
  })
  if (args === undefined || flag(args, undefined, 'quit', 'edit-todo', 'show-current-patch') !== undefined) return undefined
  const abort = args.longs.get('abort')
  if (abort !== undefined) return normal('Megszakítja a folyamatban lévő rebase-t, és visszaállítja a kiinduló állapotot.', abort)
  const skip = args.longs.get('skip')
  if (skip !== undefined) return danger('Kihagyja az éppen alkalmazott commitot, a változtatásai kimaradnak.', skip)
  return danger('Átírja a történetet: a régi commitok helyett újakat hoz létre.')
}

function push(tokens: readonly Token[]): Explained | undefined {
  const args = parseArgs(tokens, {
    shortValues: 'o',
    longValues: ['repo', 'receive-pack', 'exec', 'push-option'],
    deciding: ['force', 'force-with-lease', 'force-if-includes', 'delete', 'dry-run', 'prune', 'mirror'],
  })
  if (args === undefined) return undefined
  const dry = flag(args, 'n', 'dry-run')
  if (dry !== undefined) return unchanged('Csak kipróbálja a feltöltést, nem tölt fel semmit.', dry)
  // `:name` deletes it on the remote; a lone `:` pushes the matching branches.
  const deleted = flag(args, 'd', 'delete') ?? args.positionals.find((word) => word.startsWith(':') && word.length > 1)
  if (deleted !== undefined) return danger('Töröl egy branchet vagy taget a távoli repóból.', deleted)
  const mirror = args.longs.get('mirror')
  if (mirror !== undefined) return danger('A távoli repót a helyi állapotra írja át: brancheket törölhet és felülírhat.', mirror)
  const prune = args.longs.get('prune')
  if (prune !== undefined) return danger('Törli a távoli repóból azokat a brancheket, amelyek helyben nincsenek meg.', prune)
  const force = flag(args, 'f', 'force') ?? args.positionals.find((word) => word.startsWith('+'))
  if (force !== undefined) return danger('Erőltetve tölt fel, és átírhatja a távoli repó történetét. Ott commitok veszhetnek el.', force)
  // Without `--force-with-lease`, `--force-if-includes` is a no-op (git-push docs): a plain push.
  const lease = args.longs.get('force-with-lease')
  if (lease !== undefined) {
    return danger('Erőltetve tölt fel, ha közben más nem változtatta a távoli branchet. Átírhatja a távoli repó történetét.', lease)
  }
  return normal('Feltölti a helyi commitokat a távoli repóba.')
}

// A Map, not an object: a word like `constructor` must not find a prototype member.
const SUBCOMMANDS: ReadonlyMap<string, Explain> = new Map(
  Object.entries({
    status: readOnly('Megmutatja a munkakönyvtár állapotát.', { output: false }),
    diff: readOnly('Megmutatja a változtatásokat.', { output: true }),
    log: readOnly('Megmutatja a commitok történetét.', { output: true }),
    show: readOnly('Megmutatja egy commit vagy egy fájl tartalmát.', { output: true }),
    fetch,
    branch,
    remote,
    add,
    commit,
    switch: switchBranch,
    checkout,
    merge,
    pull,
    stash,
    tag,
    'cherry-pick': cherryPick,
    restore,
    push,
    reset,
    clean,
    rebase,
  }),
)
