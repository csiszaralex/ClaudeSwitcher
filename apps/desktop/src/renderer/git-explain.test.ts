import { describe, expect, it } from 'vitest'
import { explainGitCommand, gitExplanation, type GitLevel } from './git-explain.js'

/** The call and level of each line, the shape most tests compare. */
function calls(command: string): [string, GitLevel][] {
  return explainGitCommand(command).map((line) => [line.call, line.level])
}

/** The single line's call and level, or `undefined` when the command gets none. */
function only(command: string): [string, GitLevel] | undefined {
  const lines = calls(command)
  expect(lines.length).toBeLessThanOrEqual(1)
  return lines[0]
}

const READ_ONLY = 'Csak olvas, nem változtat semmit.'

describe('explainGitCommand: the read-only calls', () => {
  it.each([
    ['git status', 'git status'],
    ['git status --short', 'git status'],
    ['git diff', 'git diff'],
    ['git diff --cached src/alpha.ts', 'git diff'],
    ['git log --oneline -5', 'git log'],
    ['git show HEAD~1', 'git show'],
    ['git branch', 'git branch'],
    ['git branch -v', 'git branch'],
    ['git branch -vv', 'git branch'],
    ['git branch -a', 'git branch'],
    ['git branch -r', 'git branch'],
    ['git branch --list "feat/*"', 'git branch'],
    ['git branch --merged main', 'git branch'],
    ['git remote', 'git remote'],
    ['git remote -v', 'git remote'],
    ['git stash list', 'git stash list'],
    ['git stash show -p', 'git stash show'],
    ['git tag', 'git tag'],
    ['git tag -l "v1.*"', 'git tag'],
  ])('%s is read-only', (command, call) => {
    const [line] = explainGitCommand(command)
    expect(line?.call).toBe(call)
    expect(line?.level).toBe('normal')
    expect(line?.text).toContain(READ_ONLY)
  })

  it('says fetch downloads but leaves the work and the local branches alone', () => {
    expect(explainGitCommand('git fetch origin')).toEqual([
      {
        call: 'git fetch',
        level: 'normal',
        text: 'Letölti a távoli repó újdonságait, de a munkádhoz és a helyi branchekhez nem nyúl.',
      },
    ])
    expect(only('git fetch --all --prune')).toEqual(['git fetch', 'normal'])
  })

  it('gives fetch no line when it can move a local branch or delete a tag', () => {
    for (const command of [
      'git fetch origin main:main',
      'git fetch origin +refs/heads/x',
      'git fetch -f',
      'git fetch --force origin',
      'git fetch --prune-tags',
      'git fetch -P',
      'git fetch -u origin main:main',
    ]) {
      expect(only(command), command).toBeUndefined()
    }
  })

  it('gives no line to a read-only call that writes a file (`--output`)', () => {
    expect(only('git diff --output=changes.diff')).toBeUndefined()
    expect(only('git log --output changes.txt')).toBeUndefined()
    expect(only('git show --out=x.txt')).toBeUndefined()
  })

  it('gives the remote listing only to its own options: git remote has no -a, -r or --list', () => {
    expect(only('git remote --verbose')).toEqual(['git remote', 'normal'])
    expect(only('git remote -a')).toBeUndefined()
    expect(only('git remote --list')).toBeUndefined()
    expect(only('git remote add upstream https://example.invalid/x.git')).toBeUndefined()
    expect(only('git remote show origin')).toBeUndefined()
  })
})

describe('explainGitCommand: the normal changes', () => {
  it.each([
    ['git add src/alpha.ts', 'git add'],
    ['git add -A', 'git add'],
    ['git commit -m "Add alpha"', 'git commit'],
    ['git commit -am "Add alpha"', 'git commit'],
    ['git switch feat/alpha', 'git switch'],
    ['git switch -', 'git switch'],
    ['git switch -c feat/alpha', 'git switch -c'],
    ['git switch --create feat/alpha', 'git switch --create'],
    ['git switch --detach v1', 'git switch --detach'],
    ['git checkout -', 'git checkout -'],
    ['git checkout HEAD~2', 'git checkout'],
    ['git checkout @', 'git checkout'],
    ['git checkout main~1^2', 'git checkout'],
    ['git checkout @{-1}', 'git checkout'],
    ['git checkout main@{1}', 'git checkout'],
    ['git checkout main...feat/alpha', 'git checkout'],
    ['git checkout -b feat/alpha', 'git checkout -b'],
    ['git checkout -b feat/alpha origin/feat/alpha', 'git checkout -b'],
    ['git merge feat/alpha', 'git merge'],
    ['git merge --no-ff -m "Merge alpha" feat/alpha', 'git merge'],
    ['git pull', 'git pull'],
    ['git pull --ff-only origin main', 'git pull'],
    ['git pull --rebase=false', 'git pull --rebase=false'],
    ['git pull --rebase=no', 'git pull --rebase=no'],
    ['git pull --rebase', 'git pull --rebase'],
    ['git pull -r origin main', 'git pull -r'],
    ['git pull --rebase=merges', 'git pull --rebase=merges'],
    ['git push --force-if-includes', 'git push'],
    ['git stash', 'git stash'],
    ['git stash -u', 'git stash'],
    ['git stash -m "wip alpha"', 'git stash'],
    ['git stash push -m "wip alpha"', 'git stash push'],
    ['git stash save "wip alpha"', 'git stash save'],
    ['git stash pop', 'git stash pop'],
    ['git stash apply stash@{1}', 'git stash apply'],
    ['git tag v1.2.0', 'git tag'],
    ['git tag -a v1.2.0 -m "Release"', 'git tag'],
    ['git tag -f v1.2.0', 'git tag -f'],
    ['git tag -d v1.2.0', 'git tag -d'],
    ['git cherry-pick 1a2b3c4', 'git cherry-pick'],
    ['git restore --staged src/alpha.ts', 'git restore --staged'],
    ['git restore -S src/alpha.ts', 'git restore -S'],
    ['git push', 'git push'],
    ['git push -u origin feat/alpha', 'git push'],
    ['git push origin :', 'git push'],
    ['git reset', 'git reset'],
    ['git reset HEAD', 'git reset'],
    ['git reset -- src/alpha.ts', 'git reset'],
    ['git reset HEAD~1', 'git reset'],
    ['git reset --mixed HEAD~1', 'git reset --mixed'],
    ['git reset --soft HEAD~1', 'git reset --soft'],
    ['git branch feat/alpha', 'git branch'],
    ['git branch -d feat/alpha', 'git branch -d'],
    ['git branch --delete feat/alpha', 'git branch --delete'],
    ['git rebase --abort', 'git rebase --abort'],
  ])('%s is a normal change', (command, call) => {
    expect(only(command)).toEqual([call, 'normal'])
  })

  it('says what a plain reset keeps: the files', () => {
    expect(explainGitCommand('git reset')[0]?.text).toBe(
      'Visszavonja az összes előkészítést. A fájlokban lévő változtatások megmaradnak.',
    )
    expect(explainGitCommand('git reset HEAD -- src/alpha.ts')[0]?.text).toBe(
      'Visszavonja a megadott fájlok előkészítését. A fájlokban lévő változtatások megmaradnak.',
    )
    expect(explainGitCommand('git reset HEAD~1')[0]?.text).toBe(
      'A branchet a megadott commitra állítja, vagy visszavonja a fájlok előkészítését. A fájlokban lévő változtatások megmaradnak.',
    )
  })

  it('tells creating a branch from switching to it', () => {
    expect(explainGitCommand('git branch feat/alpha')[0]?.text).toBe('Létrehoz egy új branchet, de nem vált át rá.')
    expect(explainGitCommand('git checkout -b feat/alpha')[0]?.text).toBe('Létrehoz egy új branchet, és átvált rá.')
    expect(explainGitCommand('git switch feat/alpha')[0]?.text).toBe('Átvált egy másik branchre.')
  })

  it('says a dry run changes nothing', () => {
    expect(only('git push --dry-run --force')).toEqual(['git push --dry-run', 'normal'])
    expect(only('git push -n origin main')).toEqual(['git push -n', 'normal'])
    expect(only('git clean -fdn')).toEqual(['git clean -fdn', 'normal'])
    expect(only('git clean -f --dry-run')).toEqual(['git clean -f --dry-run', 'normal'])
    expect(only('git commit --amend --dry-run')).toEqual(['git commit --dry-run', 'normal'])
    expect(only('git add -n .')).toEqual(['git add -n', 'normal'])
  })
})

describe('explainGitCommand: the dangerous calls that drop work', () => {
  it.each([
    ['git reset --hard', 'git reset --hard'],
    ['git reset --hard origin/main', 'git reset --hard'],
    ['git reset -q --hard HEAD~1', 'git reset --hard'],
    ['git clean -f', 'git clean -f'],
    ['git clean -fd', 'git clean -fd'],
    ['git clean -fdx', 'git clean -fdx'],
    ['git clean -xdf', 'git clean -xdf'],
    ['git clean -d -f', 'git clean -d -f'],
    ['git clean --force -e build', 'git clean --force'],
    ['git branch -D feat/alpha', 'git branch -D'],
    ['git branch --delete --force feat/alpha', 'git branch --delete --force'],
    ['git branch -d -f feat/alpha', 'git branch -d -f'],
    ['git branch -df feat/alpha', 'git branch -df'],
    ['git checkout -- src/alpha.ts', 'git checkout --'],
    ['git checkout HEAD -- src/alpha.ts', 'git checkout --'],
    ['git checkout .', 'git checkout .'],
    ['git checkout ./src', 'git checkout'],
    ['git checkout main src/alpha.ts', 'git checkout'],
    ['git checkout -f feat/alpha', 'git checkout -f'],
    ['git checkout --theirs src/alpha.ts', 'git checkout'],
    ['git switch --discard-changes feat/alpha', 'git switch --discard-changes'],
    ['git restore src/alpha.ts', 'git restore'],
    ['git restore .', 'git restore'],
    ['git restore --source HEAD~1 src/alpha.ts', 'git restore'],
    ['git restore --staged --worktree src/alpha.ts', 'git restore --staged --worktree'],
    ['git stash drop', 'git stash drop'],
    ['git stash drop stash@{2}', 'git stash drop'],
    ['git stash clear', 'git stash clear'],
    ['git rebase --skip', 'git rebase --skip'],
  ])('%s is dangerous', (command, call) => {
    expect(only(command)).toEqual([call, 'danger'])
  })

  it('names what clean removes, by its flags', () => {
    expect(explainGitCommand('git clean -f')[0]?.text).toBe('Véglegesen törli a nem követett fájlokat.')
    expect(explainGitCommand('git clean -fd')[0]?.text).toBe('Véglegesen törli a nem követett fájlokat és mappákat.')
    expect(explainGitCommand('git clean -fdx')[0]?.text).toBe(
      'Véglegesen törli a nem követett fájlokat és mappákat, a gitignore szerint kihagyottakat is.',
    )
    expect(explainGitCommand('git clean -fX')[0]?.text).toBe('Véglegesen törli a gitignore szerint kihagyott fájlokat.')
  })

  it('warns about every bare checkout name: git decides by what exists, a file, a folder or a branch', () => {
    const hedged = 'Ha a megadott név fájl vagy mappa, eldobja a változtatásait. Ha branch, átvált rá.'
    for (const command of ['git checkout feat/alpha', 'git checkout src', 'git checkout README.md', 'git checkout 1a2b3c4', 'git checkout HEAD']) {
      expect(explainGitCommand(command), command).toEqual([{ call: 'git checkout', level: 'danger', text: hedged }])
    }
  })

  it('takes only the suffix forms for a revision: a leading `~` or a `/` before it may be a file', () => {
    expect(explainGitCommand('git checkout HEAD~')[0]?.text).toBe('Átvált a megadott commitra, branch nélkül.')
    for (const command of ['git checkout ~2', 'git checkout src/notes~', 'git checkout origin/main~1']) {
      expect(explainGitCommand(command)[0]?.text, command).toBe('Ha a megadott név fájl vagy mappa, eldobja a változtatásait. Ha branch, átvált rá.')
    }
    // `a..b` is a path for checkout (measured, git 2.55).
    expect(explainGitCommand('git checkout main..feat/alpha')[0]?.text).toBe(
      'Visszaállítja a megadott fájlokat, a munkakönyvtárban lévő változtatásaik elvesznek.',
    )
  })

  it('gives clean without -f no line: git refuses it by default', () => {
    expect(only('git clean -d')).toBeUndefined()
    expect(only('git clean')).toBeUndefined()
  })
})

describe('explainGitCommand: the dangerous calls that rewrite history', () => {
  it.each([
    ['git commit --amend', 'git commit --amend'],
    ['git commit --amend --no-edit', 'git commit --amend'],
    ['git commit -a --amend -m "Fix alpha"', 'git commit --amend'],
    ['git rebase main', 'git rebase'],
    ['git rebase -i HEAD~3', 'git rebase'],
    ['git rebase --continue', 'git rebase'],
    ['git rebase --onto main feat/a feat/b', 'git rebase'],
    ['git push --force', 'git push --force'],
    ['git push -f origin feat/alpha', 'git push -f'],
    ['git push origin feat/alpha --force', 'git push --force'],
    ['git push -uf origin feat/alpha', 'git push -uf'],
    ['git push --force-with-lease', 'git push --force-with-lease'],
    ['git push --force-with-lease=feat/alpha origin feat/alpha', 'git push --force-with-lease=feat/alpha'],
    ['git push --force-if-includes --force-with-lease', 'git push --force-with-lease'],
    ['git push origin +feat/alpha', 'git push +feat/alpha'],
    ['git push origin +HEAD:feat/alpha', 'git push +HEAD:feat/alpha'],
    ['git push --delete origin feat/alpha', 'git push --delete'],
    ['git push -d origin feat/alpha', 'git push -d'],
    ['git push origin :feat/alpha', 'git push :feat/alpha'],
    ['git push --mirror', 'git push --mirror'],
    ['git push --prune origin "refs/heads/*:refs/heads/*"', 'git push --prune'],
  ])('%s is dangerous', (command, call) => {
    expect(only(command)).toEqual([call, 'danger'])
  })

  it('tells a lease push from a plain force push', () => {
    expect(explainGitCommand('git push --force')[0]?.text).toBe(
      'Erőltetve tölt fel, és átírhatja a távoli repó történetét. Ott commitok veszhetnek el.',
    )
    expect(explainGitCommand('git push --force-with-lease')[0]?.text).toBe(
      'Erőltetve tölt fel, ha közben más nem változtatta a távoli branchet. Átírhatja a távoli repó történetét.',
    )
  })
})

describe('explainGitCommand: what it cannot classify gets no line', () => {
  it.each([
    'git help push',
    'git frobnicate',
    'git co main',
    'git',
    'git --version',
    'git -C',
    'git push --help',
    'git commit -h',
    // An abbreviated deciding option: git takes an unambiguous prefix, or refuses an ambiguous one.
    'git commit --am',
    'git push --forc',
    'git reset --ha',
    'git checkout -B feat/alpha',
    'git checkout --orphan gh-pages',
    'git checkout -p',
    'git checkout',
    'git switch -C feat/alpha',
    'git switch',
    'git branch -m old-name new-name',
    'git branch -f feat/alpha main',
    'git branch -u origin/main',
    'git branch -v feat/alpha',
    'git branch -a feat/alpha',
    'git branch -dr origin/feat/alpha',
    'git branch --show-current',
    'git reset --keep HEAD~1',
    'git reset --merge',
    'git merge --abort',
    'git merge --continue',
    'git cherry-pick --abort',
    'git rebase --quit',
    'git rebase --edit-todo',
    'git stash branch feat/alpha',
    'git stash store 1a2b3c4',
    'git tag -v v1.2.0',
    'git pull --force',
    'git pull origin main:main',
  ])('%s', (command) => {
    expect(only(command)).toBeUndefined()
  })
})

describe('explainGitCommand: flags', () => {
  it('reads a flag in any position and any combined form', () => {
    expect(only('git push origin main -f')).toEqual(['git push -f', 'danger'])
    expect(only('git clean -x -d -f')).toEqual(['git clean -x -d -f', 'danger'])
    expect(only('git commit -m "msg" --amend')).toEqual(['git commit --amend', 'danger'])
  })

  it('does not take an option value for a flag', () => {
    // `-m` takes the rest of its word as the message: `-mf` is not `-m -f`.
    expect(only('git stash -mfoo')).toEqual(['git stash', 'normal'])
    expect(only('git commit -F - --amend')).toEqual(['git commit --amend', 'danger'])
    // The letters after an attached optional value are that value, not flags.
    expect(only('git commit -Sfkey -m "x"')).toEqual(['git commit', 'normal'])
    expect(only('git commit -uno -m "x"')).toEqual(['git commit', 'normal'])
  })

  it('gives no line when an option would take a word that starts with `-` as its value', () => {
    expect(only('git commit -m --amend')).toBeUndefined()
    expect(only('git push -o --force origin main')).toBeUndefined()
    expect(only('git restore --source --staged src/alpha.ts')).toBeUndefined()
    expect(only('git commit --message --amend')).toBeUndefined()
  })

  it('gives no line with a negated deciding option', () => {
    for (const command of ['git push --no-force', 'git push --no-force-with-lease', 'git commit --no-amend', 'git pull --no-rebase', 'git clean -f --no-dry-run']) {
      expect(only(command), command).toBeUndefined()
    }
  })

  it('takes a flag after `--` as a path', () => {
    expect(only('git add -- --force')).toEqual(['git add', 'normal'])
    expect(only('git push origin -- --force')).toEqual(['git push', 'normal'])
  })
})

describe('explainGitCommand: parsing', () => {
  it('gives one line per git call, in command order', () => {
    expect(calls('git add -A && git commit -m "Add alpha" && git push --force')).toEqual([
      ['git add', 'normal'],
      ['git commit', 'normal'],
      ['git push --force', 'danger'],
    ])
    expect(calls('git status; git log -1 || git stash drop')).toEqual([
      ['git status', 'normal'],
      ['git log', 'normal'],
      ['git stash drop', 'danger'],
    ])
    expect(calls('git fetch\ngit reset --hard origin/main')).toEqual([
      ['git fetch', 'normal'],
      ['git reset --hard', 'danger'],
    ])
    expect(calls('git diff | head -20 & git clean -fd')).toEqual([
      ['git diff', 'normal'],
      ['git clean -fd', 'danger'],
    ])
    expect(calls('(cd p:/proj/alpha && git push -f)')).toEqual([['git push -f', 'danger']])
  })

  it('shows the same line twice in a row once, but keeps a repeat after another line', () => {
    expect(calls('git add src/a.ts && git add src/b.ts')).toEqual([['git add', 'normal']])
    expect(calls('git status && git add . && git status')).toEqual([
      ['git status', 'normal'],
      ['git add', 'normal'],
      ['git status', 'normal'],
    ])
  })

  it('explains only the git calls of a chain', () => {
    expect(calls('pnpm test && git commit -m "x" && echo done')).toEqual([['git commit', 'normal']])
  })

  it('does not split inside quotes', () => {
    expect(calls('git commit -m "Fix && git push --force"')).toEqual([['git commit', 'normal']])
    expect(calls("git commit -m 'a; git reset --hard | b'")).toEqual([['git commit', 'normal']])
    expect(calls('git commit -m "one\ngit push -f"')).toEqual([['git commit', 'normal']])
  })

  it('never explains the command inside a substitution', () => {
    expect(calls('echo $(git push --force)')).toEqual([])
    expect(calls('echo `git reset --hard`')).toEqual([])
    expect(calls('diff <(git show HEAD:a.txt) a.txt')).toEqual([])
  })

  it('reads the common commit message forms, a substitution with a here-document included', () => {
    const message = [
      `git commit -m "$(cat <<'EOF'`,
      'feat(desktop): add alpha',
      '',
      "It's done; git push --force && (x)",
      'EOF',
      ')" && git push',
    ].join('\n')
    expect(calls(message)).toEqual([
      ['git commit', 'normal'],
      ['git push', 'normal'],
    ])
    expect(calls('git commit -F - <<EOF\ngit reset --hard\nEOF\ngit push')).toEqual([
      ['git commit', 'normal'],
      ['git push', 'normal'],
    ])
    expect(calls('git commit -F - <<-EOF\n\tgit reset --hard\n\tEOF\ngit status')).toEqual([
      ['git commit', 'normal'],
      ['git status', 'normal'],
    ])
  })

  it('gives no line when a deciding word comes from an expansion', () => {
    expect(calls('git push $FLAGS')).toEqual([])
    expect(calls('git push origin "$BRANCH"')).toEqual([])
    expect(calls('git $CMD')).toEqual([])
    expect(calls('$GIT push')).toEqual([])
    expect(calls('git checkout "$(git rev-parse HEAD~1)"')).toEqual([])
  })

  it('allows an expansion in an option value or a path after `--`', () => {
    expect(calls('git commit -m "$MSG"')).toEqual([['git commit', 'normal']])
    expect(calls('git commit -m"$MSG"')).toEqual([['git commit', 'normal']])
    expect(calls('git log --since="$START"')).toEqual([['git log', 'normal']])
    expect(calls('git -C "$DIR" status')).toEqual([['git status', 'normal']])
    expect(calls('git checkout -- "$FILE"')).toEqual([['git checkout --', 'danger']])
  })

  it('ignores redirections and comments', () => {
    expect(calls('git push origin main 2>&1')).toEqual([['git push', 'normal']])
    expect(calls('git status 2> /dev/null')).toEqual([['git status', 'normal']])
    expect(calls('git diff > NUL')).toEqual([['git diff', 'normal']])
    expect(calls('git log < input.txt')).toEqual([['git log', 'normal']])
    expect(calls('git push origin main # --force later')).toEqual([['git push', 'normal']])
    expect(calls('# git reset --hard\ngit status')).toEqual([['git status', 'normal']])
  })

  it('treats escapes and line continuations like bash', () => {
    expect(calls('git push \\\n  --force')).toEqual([['git push --force', 'danger']])
    expect(calls('git commit -m a\\;b')).toEqual([['git commit', 'normal']])
    expect(calls('git commit -m "a \\" && git push -f"')).toEqual([['git commit', 'normal']])
  })

  it('gives no lines to a command bash could not parse', () => {
    expect(calls('git status && git commit -m "unclosed')).toEqual([])
    expect(calls("git status; echo 'unclosed")).toEqual([])
    expect(calls('git status; echo $(unclosed')).toEqual([])
  })

  it('skips leading environment assignments', () => {
    expect(calls('GIT_EDITOR=true git rebase --continue')).toEqual([['git rebase', 'danger']])
    expect(calls('A=1 B="two words" git status')).toEqual([['git status', 'normal']])
  })

  it('recognises git by a path and as git.exe', () => {
    expect(calls('/usr/bin/git status')).toEqual([['git status', 'normal']])
    expect(calls('git.exe status')).toEqual([['git status', 'normal']])
    expect(calls('"C:\\Program Files\\Git\\cmd\\git.exe" push -f')).toEqual([['git push -f', 'danger']])
    expect(calls("'C:\\Program Files\\Git\\cmd\\git.exe' status")).toEqual([['git status', 'normal']])
    expect(calls('"C:/Program Files/Git/cmd/Git.EXE" status')).toEqual([['git status', 'normal']])
  })

  it('skips the global options before the subcommand', () => {
    expect(calls('git -C p:/proj/alpha status')).toEqual([['git status', 'normal']])
    expect(calls('git -c core.pager=cat log')).toEqual([['git log', 'normal']])
    expect(calls('git --no-pager diff')).toEqual([['git diff', 'normal']])
    expect(calls('git -P log')).toEqual([['git log', 'normal']])
    expect(calls('git --paginate log')).toEqual([['git log', 'normal']])
    expect(calls('git --git-dir=p:/proj/alpha/.git --work-tree=p:/proj/alpha reset --hard')).toEqual([
      ['git reset --hard', 'danger'],
    ])
    expect(calls('git --git-dir p:/proj/alpha/.git status')).toEqual([['git status', 'normal']])
    expect(calls('git -C p:/proj/alpha -c user.name=alpha --no-pager push -f')).toEqual([['git push -f', 'danger']])
  })

  it('gives no line after an unknown global option', () => {
    expect(calls('git --bare status')).toEqual([])
    expect(calls('git --exec-path=p:/x status')).toEqual([])
  })

  it('ignores commands that only mention git', () => {
    for (const command of ['echo git push --force', 'gitk', 'gitk --all', 'legit push', 'git-lfs push', 'mygit status', 'echo "git reset --hard"']) {
      expect(calls(command), command).toEqual([])
    }
  })

  it('gives no lines to an empty command', () => {
    expect(calls('')).toEqual([])
    expect(calls('   \n ; && ')).toEqual([])
  })

  it('reads a CRLF command', () => {
    expect(calls('git status\r\ngit push -f\r\n')).toEqual([
      ['git status', 'normal'],
      ['git push -f', 'danger'],
    ])
  })

  it('does not take a prototype member for a subcommand', () => {
    expect(calls('git constructor')).toEqual([])
    expect(calls('git toString')).toEqual([])
  })
})

describe('gitExplanation', () => {
  const bash = (toolInput: unknown) => ({ kind: 'tool' as const, toolName: 'Bash', toolInput })

  it('explains the command of a Bash request', () => {
    expect(gitExplanation(bash({ command: 'git push --force', description: 'Push' }))).toEqual([
      expect.objectContaining({ call: 'git push --force', level: 'danger' }),
    ])
  })

  it('gives nothing for another tool, another kind, or a command that is not a string', () => {
    expect(gitExplanation({ kind: 'tool', toolName: 'PowerShell', toolInput: { command: 'git push --force' } })).toEqual([])
    expect(gitExplanation({ kind: 'edit', toolName: 'Bash', toolInput: { command: 'git push --force' } })).toEqual([])
    expect(gitExplanation(bash({ command: ['git', 'push'] }))).toEqual([])
    expect(gitExplanation(bash({}))).toEqual([])
    // At runtime the daemon's message can be anything; sanitizeState does not check toolInput.
    expect(gitExplanation(bash(null))).toEqual([])
    expect(gitExplanation(bash('git push --force'))).toEqual([])
  })

  it('gives nothing instead of throwing', () => {
    const input = {
      get command(): string {
        throw new Error('invented failure')
      },
    }
    expect(gitExplanation(bash(input))).toEqual([])
  })
})

describe('explainGitCommand: review round 1', () => {
  it('makes no read-only claim on a call that writes its output to a file', () => {
    for (const command of [
      'git status > status.txt',
      'git log >> log.txt',
      'git diff &> changes.diff',
      'git show HEAD >| out.txt',
      'git branch > "$OUT"',
      'git push -n > push.txt',
    ]) {
      expect(calls(command), command).toEqual([])
    }
    // A line that does not claim read-only stays: the redirection does not make it harmless.
    expect(calls('git push --force > push.log 2>&1')).toEqual([['git push --force', 'danger']])
  })

  it('gives no line when a `-c` or the environment sets a config key that changes the call', () => {
    for (const command of [
      'git -c pull.rebase=true pull',
      'git -c push.default=matching push',
      'git -c clean.requireForce=false clean -d',
      'git -c alias.st=status st',
      'git -c Branch.autoSetupRebase=always status',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=pull.rebase GIT_CONFIG_VALUE_0=true git pull',
      'git -c "$SETTING" status',
    ]) {
      expect(calls(command), command).toEqual([])
    }
    expect(calls('git -c core.pager=cat log')).toEqual([['git log', 'normal']])
    expect(calls('git -c user.name=alpha commit -m "x"')).toEqual([['git commit', 'normal']])
  })

  it('says a plain pull may rebase, and what a rebase pull does', () => {
    expect(explainGitCommand('git pull')[0]).toEqual({
      call: 'git pull',
      level: 'normal',
      text: 'Letölti a távoli repó újdonságait, és beépíti őket az aktuális branchbe. A beállítástól függően ezt rebase-zel teszi.',
    })
    expect(explainGitCommand('git pull --rebase')[0]?.text).toBe(
      'Letölti a távoli repó újdonságait, és a tetejükre helyezi át a helyi commitjaidat.',
    )
    expect(explainGitCommand('git pull --rebase=false')[0]?.text).toBe(
      'Letölti a távoli repó újdonságait, és beolvasztja őket az aktuális branchbe.',
    )
  })

  it('skips the shell keywords and wrappers before git', () => {
    expect(calls('if git diff --quiet; then git commit -m "x"; else git stash drop; fi')).toEqual([
      ['git diff', 'normal'],
      ['git commit', 'normal'],
      ['git stash drop', 'danger'],
    ])
    expect(calls('while git fetch; do sleep 1; done')).toEqual([['git fetch', 'normal']])
    expect(calls('until git push; do sleep 1; done')).toEqual([['git push', 'normal']])
    expect(calls('! git diff --quiet')).toEqual([['git diff', 'normal']])
    expect(calls('{ git status; }')).toEqual([['git status', 'normal']])
    expect(calls('time git push -f')).toEqual([['git push -f', 'danger']])
    expect(calls('command git push -f')).toEqual([['git push -f', 'danger']])
    expect(calls('exec git status')).toEqual([['git status', 'normal']])
    expect(calls('sudo git clean -fdx')).toEqual([['git clean -fdx', 'danger']])
    expect(calls('nohup git fetch')).toEqual([['git fetch', 'normal']])
    expect(calls('env GIT_EDITOR=true git rebase --continue')).toEqual([['git rebase', 'danger']])
    expect(calls('if true; then :; elif git reset --hard; then :; fi')).toEqual([['git reset --hard', 'danger']])
  })

  it('gives no line when a wrapper has options of its own', () => {
    for (const command of ['command -v git', 'sudo -u alpha git status', 'env -i git status', 'xargs -0 git add', 'time -p git status']) {
      expect(calls(command), command).toEqual([])
    }
  })

  it('takes the words xargs appends as unknown', () => {
    // They could be names or options: the listing becomes a branch creation, a message an `--amend`.
    expect(calls('xargs git branch')).toEqual([])
    expect(calls('xargs git commit')).toEqual([])
    expect(calls('xargs git checkout --')).toEqual([['git checkout --', 'danger']])
  })

  it('gives checkout and restore no line with `--pathspec-from-file` or an abbreviated `--ours`, `--theirs`', () => {
    expect(calls('git checkout --pathspec-from-file=list.txt main')).toEqual([])
    expect(calls('git restore --pathspec-from-file=list.txt')).toEqual([])
    expect(calls('git restore --staged --pathspec-from-file list.txt')).toEqual([])
    expect(calls('git checkout --ou src/alpha.ts')).toEqual([])
    expect(calls('git checkout --the src/alpha.ts')).toEqual([])
  })

  it('takes a brace expansion as dynamic', () => {
    expect(calls('git push origin {main,feat/alpha}')).toEqual([])
    expect(calls('git checkout v{1..3}')).toEqual([])
    expect(calls('git checkout -- src/{a,b}.ts')).toEqual([['git checkout --', 'danger']])
    // No comma and no `..`: no expansion.
    expect(calls('git stash drop stash@{1}')).toEqual([['git stash drop', 'danger']])
  })

  it('lists tags with -n', () => {
    expect(explainGitCommand('git tag -n5')[0]?.text).toBe('Kilistázza a tageket. Csak olvas, nem változtat semmit.')
    expect(explainGitCommand('git tag -n v1.2.0')[0]?.text).toBe('Kilistázza a tageket. Csak olvas, nem változtat semmit.')
  })

  it('takes commit --short, --porcelain and --long as dry runs', () => {
    expect(only('git commit --short')).toEqual(['git commit --short', 'normal'])
    expect(only('git commit --porcelain -a')).toEqual(['git commit --porcelain', 'normal'])
    expect(only('git commit --amend --long')).toEqual(['git commit --long', 'normal'])
  })

  it('says a push may delete a tag too', () => {
    expect(explainGitCommand('git push origin :v1.2.0')[0]?.text).toBe('Töröl egy branchet vagy taget a távoli repóból.')
  })

  it('takes the last reset mode', () => {
    expect(only('git reset --hard --soft HEAD~1')).toEqual(['git reset --soft', 'normal'])
    expect(only('git reset --soft --hard HEAD~1')).toEqual(['git reset --hard', 'danger'])
    expect(only('git reset --hard --keep HEAD~1')).toBeUndefined()
  })

  it('says a reset --hard without a commit only drops the changes', () => {
    expect(explainGitCommand('git reset --hard')[0]?.text).toBe('Eldobja a követett fájlok összes nem commitolt változtatását.')
    expect(explainGitCommand('git reset --hard HEAD')[0]?.text).toBe('Eldobja a követett fájlok összes nem commitolt változtatását.')
    expect(explainGitCommand('git reset --hard HEAD~1')[0]?.text).toBe(
      'Eldobja a követett fájlok összes nem commitolt változtatását, a branchet pedig a megadott commitra állítja.',
    )
  })

  it('gives reset -p no line', () => {
    expect(only('git reset -p')).toBeUndefined()
    expect(only('git reset --patch HEAD~1')).toBeUndefined()
  })

  it('does not repeat a combined restore flag', () => {
    expect(only('git restore -SW src/alpha.ts')).toEqual(['git restore -SW', 'danger'])
  })

  it('does not open a here-document in an arithmetic', () => {
    expect(calls('(( x = 1 << 2 ))\ngit push -f')).toEqual([['git push -f', 'danger']])
    expect(calls('echo $(( 1 << 2 ))\ngit push -f')).toEqual([['git push -f', 'danger']])
    expect(calls('git status; (( x = 1 << 2 ')).toEqual([])
  })

  it('words the Hungarian lines as agreed', () => {
    expect(explainGitCommand('git status')[0]?.text).toBe('Megmutatja a munkakönyvtár állapotát. Csak olvas, nem változtat semmit.')
    expect(explainGitCommand('git branch -D feat/alpha')[0]?.text).toBe(
      'Töröl egy helyi branchet akkor is, ha a commitjai nincsenek beolvasztva. Ezek a commitok elveszhetnek.',
    )
    expect(explainGitCommand('git stash pop')[0]?.text).toBe(
      'Visszahozza a félretett változtatásokat, és ha sikerül, törli őket a félretettek közül.',
    )
    expect(explainGitCommand('git restore src/alpha.ts')[0]?.text).toBe(
      'Visszaállítja a megadott fájlokat, a munkakönyvtárban lévő változtatásaik elvesznek.',
    )
  })
})
