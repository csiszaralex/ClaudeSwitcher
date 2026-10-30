# ClaudeSwitcher M1 — Read-only monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Egy tálcán futó Electron app, ami globális hotkey-re megmutatja az összes élő Claude Code sessiont, az állapotukat, a limitek állását, és egy gombnyomással a megfelelő VSCode ablakra ugrik.

**Architecture:** Egy `core` csomag tartalmazza az összes IO-mentes logikát (session-felderítés, transcript-olvasás, settings-merge), egy `daemon` csomag adja a hook HTTP endpointot, a fájlfigyelőket és a WS hubot, és egy Electron app hosztolja a daemont a main processzében, plusz adja a tray-t és az overlayt. Az M1 nem vesz el döntést a Claude Code-tól: csak a `Notification` és életciklus hookokat használja, amelyek dokumentáltan nem tudnak blokkolni.

**Tech Stack:** TypeScript (strict), pnpm workspace + Nx, Vitest, Hono + `@hono/node-server`, `ws`, `chokidar`, Electron + electron-vite + React, `koffi` (Win32 ablakfókusz).

**Spec:** `docs/superpowers/specs/2026-09-04-claudeswitcher-design.md`

## Global Constraints

- **TDD-bizonyíték:** ahol egy task TDD-t ír elő, a jelentésnek a futtatott
  parancsot és a futtató **szó szerinti** kimenetét kell tartalmaznia, nem az
  elvárt kimenet leírását. Utólag rekonstruált RED-bizonyíték maga is hiba.
  Referenciaként a vitest 3.2.7 pontosan ezt adja hiányzó modulra (a repóban
  lemérve, nem emlékezetből):
  ```
  Error: Cannot find module './liveness.js' imported from '…/src/liveness.test.ts'
  Caused by: Error: Failed to load url ./liveness.js (resolved id: ./liveness.js)
  in …/src/liveness.test.ts. Does the file exist?
  ```
  A `Cannot find module` itt **helyes** — nem a rekonstrukció jele.
- **A tesztfájlokat is típusellenőrizzük.** A `tsconfig.json` kizárja az
  `src/**/*.test.ts`-t, mert a `dist/`-be nem kell teszt — de a Vitest esbuilddel
  fordít, ami *nem* típusellenőriz, tehát így egy elgépelt mezőnév a tesztben
  némán átcsúszna. Ezért minden csomag kap egy `tsconfig.check.json`-t, ami a
  build configot terjeszti ki a tesztekre, és a `check-types` script azt
  használja:
  ```json
  { "extends": "./tsconfig.json", "include": ["src/**/*"], "exclude": [] }
  ```
  `"check-types": "tsc -p tsconfig.check.json --noEmit"`
- **Electron indítása VSCode-ból vagy Claude Code-ból:** az `ELECTRON_RUN_AS_NODE=1`
  öröklődik a VSCode-ból, és az `electron.exe`-t sima Node-dá teszi. **Minden**
  Electron-indítás előtt törölni kell (`Remove-Item Env:ELECTRON_RUN_AS_NODE`), a
  Task 11–15 összes kézi ellenőrzésében. A felhasználó gépén, normál indításnál ez a
  változó nincs beállítva — ez a fejlesztői környezet csapdája, nem az appé.
- **Platform:** Windows-only. A kód futtatható más platformon (tesztek miatt), de nem támogatott.
- **Node:** 22+. **pnpm:** 11+.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true` minden csomagban.
- **Claude config dir:** mindig a `CLAUDE_CONFIG_DIR` env változó, ha be van állítva; egyébként `path.join(os.homedir(), '.claude')`. Soha ne legyen hardcode-olva.
- **Transcript-olvasás:** ismeretlen rekordtípus kihagyása kötelező, soha ne dobjon kivételt. (A valós fájlokban legalább ezek szerepelnek: `queue-operation`, `user`, `attachment`, `file-history-snapshot`, `ai-title`, `atis-latch`, `assistant`.)
- **Liveness:** pid önmagában soha nem elég. Mindig pid **és** process creation time egyeztetés — a `~/.claude/ide/` mappában elárvult lock fájlok vannak újrahasznosított pidekkel.
- **Settings-írás:** kizárólag atomikusan (temp fájl + rename), és kizárólag merge-elve. A meglévő kulcsok (`model`, `enabledPlugins`, `effortLevel`, `tui`, `permissions`) érintetlenül maradnak.
- **Hálózat:** a daemon HTTP és WS szervere kizárólag `127.0.0.1`-re bindol, és minden kérés bearer tokent követel.
- **Transcript-fájl megtalálása:** soha ne a `cwd`-ből képzett könyvtárnévvel. Mindig glob: `<claudeDir>/projects/*/<sessionId>.jsonl`. A könyvtárnév-kódolás nem dokumentált és változhat.
- **Workspace-függőségek build-je:** a csomagok egymást a lefordított `dist/`-en át érik el (`"main": "./dist/index.js"`). A `daemon` és a `desktop` tesztje vagy futtatása előtt a függőségeiknek build-elve kell lenniük. Az `nx.json` `test` és `dev` targetjei ezért `dependsOn: ["^build"]`-et használnak; ha egy taskban közvetlen `pnpm --filter` hívás szerepel, előtte `pnpm build` kell.
- **React 19 típusok:** nincs globális `JSX` névtér. Ahol JSX visszatérési típus kell, `import type { JSX } from 'react'` az explicit import.

---

## File Structure

```
claudeswitcher/
├─ package.json                       workspace root, Nx target-ek
├─ pnpm-workspace.yaml
├─ nx.json
├─ tsconfig.base.json
├─ packages/core/
│  ├─ src/types.ts                    minden megosztott típus
│  ├─ src/paths.ts                    claude config dir feloldás
│  ├─ src/session-registry.ts         sessions/*.json és ide/*.lock parse
│  ├─ src/liveness.ts                 ProcessProbe + resolveLiveSessions
│  ├─ src/transcript.ts               tail + SessionActivity kinyerés
│  ├─ src/settings-writer.ts          atomikus merge író
│  └─ src/index.ts                    public API re-export
├─ packages/daemon/
│  ├─ src/hook-server.ts              Hono app, auth, hook route-ok
│  ├─ src/session-store.ts            registry + események + activity → SessionView[]
│  ├─ src/watchers.ts                 chokidar + poll loop
│  ├─ src/hub.ts                      WS broadcast
│  ├─ src/rate-limits.ts              statusLine bemenet tárolása
│  └─ src/daemon.ts                   összeszerelés, start/stop
├─ packages/statusline/
│  └─ src/main.ts                     stdin JSON → POST a daemonnak + sor kiírása
└─ apps/desktop/
   ├─ src/main/index.ts               Electron main, daemon hosztolás
   ├─ src/main/tray.ts                tray ikon + badge
   ├─ src/main/overlay-window.ts      frameless always-on-top ablak
   ├─ src/main/hotkey.ts              globalShortcut
   ├─ src/main/focus-window.ts        koffi SetForegroundWindow + code -r fallback
   ├─ src/main/setup.ts               hookok + statusLine telepítése a settingsbe
   ├─ src/preload/index.ts            contextBridge
   └─ src/renderer/                   React overlay lista
```

---

### Task 1: Monorepo scaffolding

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig.base.json`, `.npmrc`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Test: `packages/core/src/smoke.test.ts`

**Interfaces:**
- Consumes: semmi
- Produces: a `@claudeswitcher/core` workspace csomag, futó `pnpm test`

- [ ] **Step 1: Root workspace fájlok**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`.npmrc`:
```
node-linker=isolated
strict-peer-dependencies=false
```

`package.json`:
```json
{
  "name": "claudeswitcher",
  "private": true,
  "packageManager": "pnpm@11.13.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "nx run-many -t build",
    "test": "nx run-many -t test",
    "check-types": "nx run-many -t check-types",
    "lint": "nx run-many -t lint"
  },
  "devDependencies": {
    "nx": "^21.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`nx.json`:
```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "targetDefaults": {
    "build": { "dependsOn": ["^build"], "cache": true },
    "test": { "dependsOn": ["^build"], "cache": true },
    "check-types": { "dependsOn": ["^build"], "cache": true },
    "dev": { "dependsOn": ["^build"], "cache": false }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 2: A core csomag váza**

`packages/core/package.json`:
```json
{
  "name": "@claudeswitcher/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check-types": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": { "@types/node": "^22.0.0" }
}
```

A `@types/node` kötelező: a `core` a `node:fs/promises`, `node:path`,
`node:child_process` és `console` API-kat használja a Task 3-tól kezdve, és
nélküle a `check-types` elszáll.

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
```

`packages/core/src/index.ts` — üres barrel, a Task 5 tölti fel. **Kötelező már
most:** a `tsconfig.json` `include`-ja `src/**/*`, az `exclude`-ja
`src/**/*.test.ts`, tehát ha a `src/` alatt csak tesztfájl van, a `tsc` nem talál
fordítandó bemenetet és `TS18003`-mal elszáll. Enélkül a `build` és a
`check-types` target nem működik, és a `dist/index.js` — amin az összes
csomagközi import múlik — soha nem jön létre.

```ts
// A publikus API-t a Task 5 exportálja innen.
export {}
```

- [ ] **Step 3: Írd meg a smoke tesztet**

`packages/core/src/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest'

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 4: Telepítés és a három target futtatása**

Mindhárom root script ebben a taskban készül el, tehát mindhármat futtatni kell.
Csak a `pnpm test` futtatása elrejtené, ha a `build` vagy a `check-types` nem
működik — a `dist/` pedig ettől a két targettől függ.

Run: `pnpm install && pnpm build && pnpm check-types && pnpm test`
Expected: mindhárom hibátlan; a `pnpm test` 1 tesztet futtat, és létrejön a
`packages/core/dist/index.js`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm + nx monorepo with core package"
```

---

### Task 2: core — típusok és nyers fájl-parse

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/session-registry.ts`
- Test: `packages/core/src/session-registry.test.ts`

**Interfaces:**
- Consumes: semmi
- Produces:
  - `SessionRecord`, `IdeLock`, `SessionStatus`, `SessionActivity`, `LiveSession`, `SessionView`, `RateLimitWindow`, `RateLimits` típusok
  - `parseSessionRecord(raw: unknown): SessionRecord | null`
  - `parseIdeLock(raw: unknown, port: number): IdeLock | null`

- [ ] **Step 1: Írd meg a failing tesztet**

`packages/core/src/session-registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseIdeLock, parseSessionRecord } from './session-registry.js'

const REAL_SESSION = {
  pid: 21548,
  sessionId: '5f8f1fc5-b7f1-4a9a-a80c-c83aff747732',
  cwd: 'p:\\proj\\alpha',
  startedAt: 1788447404737,
  procStart: '134329210033019891',
  version: '2.1.259',
  kind: 'interactive',
  entrypoint: 'claude-vscode',
  name: 'alpha-58',
  nameSource: 'derived',
  bridgeSessionId: 'session_01Qx7RmZ4kT9bWcN2vHs8LpD',
}

const REAL_LOCK = {
  pid: 8108,
  workspaceFolders: ['p:\\08_Apps\\ClaudeSwitcher'],
  ideName: 'Visual Studio Code',
  transport: 'ws',
  runningInWindows: true,
  authToken: '9602c76f-7555-46a2-be31-9507b93f4c64',
}

describe('parseSessionRecord', () => {
  it('parses a real session file', () => {
    const r = parseSessionRecord(REAL_SESSION)
    expect(r).not.toBeNull()
    expect(r!.pid).toBe(21548)
    expect(r!.sessionId).toBe('5f8f1fc5-b7f1-4a9a-a80c-c83aff747732')
    expect(r!.cwd).toBe('p:\\proj\\alpha')
    expect(r!.procStart).toBe('134329210033019891')
    expect(r!.name).toBe('alpha-58')
    expect(r!.bridgeSessionId).toBe('session_01Qx7RmZ4kT9bWcN2vHs8LpD')
  })

  it('tolerates a missing bridgeSessionId', () => {
    const r = parseSessionRecord({ ...REAL_SESSION, bridgeSessionId: null })
    expect(r!.bridgeSessionId).toBeNull()
  })

  it('survives unknown future fields', () => {
    const r = parseSessionRecord({ ...REAL_SESSION, somethingNew: { a: 1 } })
    expect(r).not.toBeNull()
  })

  it('returns null when a required field is missing', () => {
    const { sessionId, ...withoutId } = REAL_SESSION
    expect(parseSessionRecord(withoutId)).toBeNull()
    expect(parseSessionRecord(null)).toBeNull()
    expect(parseSessionRecord('nonsense')).toBeNull()
  })

  it('returns null when a required field has the wrong type', () => {
    expect(parseSessionRecord({ ...REAL_SESSION, pid: '21548' })).toBeNull()
    expect(parseSessionRecord({ ...REAL_SESSION, startedAt: 'yesterday' })).toBeNull()
    expect(parseSessionRecord({ ...REAL_SESSION, cwd: null })).toBeNull()
  })

  it('never throws, whatever shape it is handed', () => {
    // A never-throws szerződés globális megkötés: egy hibás fájl nem viheti
    // magával a többi sessiont. Ez a teszt tartja életben.
    for (const bad of [null, undefined, 'nonsense', 42, true, [], [REAL_SESSION]]) {
      expect(() => parseSessionRecord(bad)).not.toThrow()
      expect(parseSessionRecord(bad)).toBeNull()
    }
  })
})

describe('parseIdeLock', () => {
  it('parses a real lock file', () => {
    const l = parseIdeLock(REAL_LOCK, 50269)
    expect(l).not.toBeNull()
    expect(l!.port).toBe(50269)
    expect(l!.pid).toBe(8108)
    expect(l!.workspaceFolders).toEqual(['p:\\08_Apps\\ClaudeSwitcher'])
  })

  it('returns null without workspaceFolders', () => {
    const { workspaceFolders, ...bad } = REAL_LOCK
    expect(parseIdeLock(bad, 1)).toBeNull()
  })

  it('drops non-string entries from workspaceFolders', () => {
    const lock = parseIdeLock({ ...REAL_LOCK, workspaceFolders: [123, 'p:\\proj', null] }, 1)
    expect(lock!.workspaceFolders).toEqual(['p:\\proj'])
  })

  it('returns null when every workspace folder entry is unusable', () => {
    expect(parseIdeLock({ ...REAL_LOCK, workspaceFolders: [123, null] }, 1)).toBeNull()
  })

  it('never throws, whatever shape it is handed', () => {
    for (const bad of [null, undefined, 'nonsense', 42, true, []]) {
      expect(() => parseIdeLock(bad, 1)).not.toThrow()
      expect(parseIdeLock(bad, 1)).toBeNull()
    }
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/core test`
Expected: FAIL — `Failed to resolve import "./session-registry.js"`

- [ ] **Step 3: Írd meg a típusokat**

`packages/core/src/types.ts`:
```ts
/** Nyers rekord a ~/.claude/sessions/<pid>.json fájlból. Nem dokumentált formátum. */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart?: string
  version?: string
  kind?: string
  entrypoint?: string
  name?: string
  bridgeSessionId?: string | null
}

/** Nyers rekord a ~/.claude/ide/<port>.lock fájlból. Nem dokumentált formátum. */
export interface IdeLock {
  port: number
  pid: number
  workspaceFolders: string[]
  ideName?: string
  transport?: string
}

export type SessionStatus = 'waiting' | 'working' | 'idle' | 'unknown'

export interface SessionActivity {
  lastAssistantText?: string
  runningTool?: string
  lastEventAt?: number
}

export interface LiveSession {
  record: SessionRecord
  window?: IdeLock
}

/** Amit a daemon a UI-nak küld. */
export interface SessionView {
  sessionId: string
  pid: number
  name: string
  cwd: string
  status: SessionStatus
  activity: SessionActivity
  windowPid?: number
  workspaceFolder?: string
  bridgeSessionId?: string | null
  waitingSince?: number
  notificationText?: string
}

export interface RateLimitWindow {
  used_percentage: number
  resets_at: number
}

export interface RateLimits {
  five_hour?: RateLimitWindow
  seven_day?: RateLimitWindow
  spend_limit?: RateLimitWindow
}
```

- [ ] **Step 4: Írd meg a parse-olókat**

`packages/core/src/session-registry.ts`:
```ts
import type { IdeLock, SessionRecord } from './types.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Toleráns parse: ismeretlen mezőket figyelmen kívül hagy, hiányzó kötelező
 * mezőnél null-t ad. Soha nem dob — a formátum nem dokumentált, verzióváltásnál
 * változhat, és egy rossz fájl nem viheti magával a többi sessiont.
 */
export function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!isRecord(raw)) return null
  const { pid, sessionId, cwd, startedAt } = raw
  if (typeof pid !== 'number' || typeof sessionId !== 'string') return null
  if (typeof cwd !== 'string' || typeof startedAt !== 'number') return null

  return {
    pid,
    sessionId,
    cwd,
    startedAt,
    procStart: typeof raw.procStart === 'string' ? raw.procStart : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    kind: typeof raw.kind === 'string' ? raw.kind : undefined,
    entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    bridgeSessionId:
      typeof raw.bridgeSessionId === 'string' ? raw.bridgeSessionId
      : raw.bridgeSessionId === null ? null
      : undefined,
  }
}

export function parseIdeLock(raw: unknown, port: number): IdeLock | null {
  if (!isRecord(raw)) return null
  const { pid, workspaceFolders } = raw
  if (typeof pid !== 'number' || !Array.isArray(workspaceFolders)) return null
  const folders = workspaceFolders.filter((f): f is string => typeof f === 'string')
  if (folders.length === 0) return null

  return {
    port,
    pid,
    workspaceFolders: folders,
    ideName: typeof raw.ideName === 'string' ? raw.ideName : undefined,
    transport: typeof raw.transport === 'string' ? raw.transport : undefined,
  }
}
```

- [ ] **Step 5: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/core test`
Expected: PASS, 11 teszt a `session-registry.test.ts`-ben.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/session-registry.ts packages/core/src/session-registry.test.ts
git commit -m "feat(core): tolerant parsing of session registry and IDE lock files"
```

---

### Task 3: core — liveness és session/ablak párosítás

**Files:**
- Create: `packages/core/src/liveness.ts`
- Test: `packages/core/src/liveness.test.ts`

**Interfaces:**
- Consumes: `SessionRecord`, `IdeLock`, `LiveSession` (Task 2)
- Produces:
  - `interface ProcessProbe { isAlive(pid, procStart?): boolean; imageName(pid): string | undefined }`
  - `resolveLiveSessions(records: SessionRecord[], locks: IdeLock[], probe: ProcessProbe): LiveSession[]`
  - `createWin32ProcessProbe(ttlMs?: number): ProcessProbe`

- [ ] **Step 1: Írd meg a failing tesztet**

Ez a rendszer legfontosabb tesztje: a valós gépen 20 lock fájl van, és a 8108-as pid két különböző workspace-szel is szerepel. `procStart` nélkül rossz ablakra ugranánk.

`packages/core/src/liveness.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createWin32ProcessProbe, resolveLiveSessions, type ProcessProbe } from './liveness.js'
import type { IdeLock, SessionRecord } from './types.js'

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pid: 100,
    sessionId: 'sid-100',
    cwd: 'p:\\proj\\alpha',
    startedAt: 1,
    procStart: 'ps-100',
    ...over,
  }
}

function lock(over: Partial<IdeLock> = {}): IdeLock {
  return { port: 1000, pid: 900, workspaceFolders: ['p:\\proj\\alpha'], ...over }
}

interface FakeProcess {
  /** A process creation FILETIME, ahogy a session fájl tárolja. */
  procStart?: string
  /** A Get-Process `Name` megfelelője. */
  image?: string
}

/** Csak a felsorolt pidek élnek. Ami nincs a táblában, az halott. */
function probeFor(processes: Record<number, FakeProcess>): ProcessProbe {
  return {
    isAlive: (pid, procStart) => {
      const proc = processes[pid]
      if (proc === undefined) return false
      return procStart === undefined || proc.procStart === procStart
    },
    imageName: (pid) => processes[pid]?.image,
  }
}

/** A tipikus felállás: az élő session és a hozzá tartozó élő VSCode ablak. */
const ALIVE = { 100: { procStart: 'ps-100' }, 900: { image: 'Code' } }

describe('resolveLiveSessions', () => {
  it('drops sessions whose process is gone', () => {
    expect(resolveLiveSessions([session()], [lock()], probeFor({}))).toEqual([])
  })

  it('drops a session whose pid is alive but started at a different time', () => {
    // Pid-újrahasznosítás: a pid él, de már egy másik processz birtokolja.
    const probe = probeFor({ 100: { procStart: 'someone-else' }, 900: { image: 'Code' } })
    expect(resolveLiveSessions([session()], [lock()], probe)).toEqual([])
  })

  it('pairs a live session with the window whose workspace contains its cwd', () => {
    const out = resolveLiveSessions([session()], [lock()], probeFor(ALIVE))
    expect(out).toHaveLength(1)
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('matches a cwd nested below the workspace folder', () => {
    const s = session({ cwd: 'p:\\proj\\alpha\\apps\\api' })
    const out = resolveLiveSessions([s], [lock()], probeFor(ALIVE))
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('matches case-insensitively and ignores trailing separators', () => {
    const s = session({ cwd: 'P:/PROJ/Alpha/' })
    const out = resolveLiveSessions([s], [lock()], probeFor(ALIVE))
    expect(out[0]!.window?.pid).toBe(900)
  })

  it('does not match a sibling directory with a shared prefix', () => {
    const s = session({ cwd: 'p:\\proj\\alpha-two' })
    const out = resolveLiveSessions([s], [lock()], probeFor(ALIVE))
    expect(out[0]!.window).toBeUndefined()
  })

  it('ignores a lock whose process is gone', () => {
    const stale = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\beta'] })
    const out = resolveLiveSessions([session()], [stale, lock()], probeFor(ALIVE))
    expect(out[0]!.window?.port).toBe(1000)
  })

  it('rejects a VSCode lock whose recycled pid now belongs to something else', () => {
    // A veszélyes eset: elárvult lock ugyanarra a workspace-re, aminek a pidjét
    // időközben egy teljesen független processz kapta meg. Élő pid, egyező
    // útvonal — csak az image név árulja el, hogy nem VSCode ablak.
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'notepad' } })
    const vscodeLock = lock({ ideName: 'Visual Studio Code' })
    const out = resolveLiveSessions([session()], [vscodeLock], probe)
    expect(out[0]!.window).toBeUndefined()
  })

  it('accepts a VSCode lock whose pid really is a VSCode process', () => {
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code' } })
    const vscodeLock = lock({ ideName: 'Visual Studio Code' })
    expect(resolveLiveSessions([session()], [vscodeLock], probe)[0]!.window?.pid).toBe(900)
  })

  it('accepts Code - Insiders as a VSCode process', () => {
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'Code - Insiders' } })
    const vscodeLock = lock({ ideName: 'Visual Studio Code - Insiders' })
    expect(resolveLiveSessions([session()], [vscodeLock], probe)[0]!.window?.pid).toBe(900)
  })

  it('skips the image check for a lock from an IDE it does not know', () => {
    // Nem VSCode IDE-nél nem tudjuk, mi a helyes image név — inkább párosítunk,
    // mint hogy egy támogatott szerkesztőt kizárjunk.
    const probe = probeFor({ 100: { procStart: 'ps-100' }, 900: { image: 'cursor' } })
    const other = lock({ ideName: 'Cursor' })
    expect(resolveLiveSessions([session()], [other], probe)[0]!.window?.pid).toBe(900)
  })

  it('leaves window undefined when no lock matches', () => {
    const out = resolveLiveSessions([session()], [], probeFor(ALIVE))
    expect(out).toHaveLength(1)
    expect(out[0]!.window).toBeUndefined()
  })

  it('prefers the most specific workspace folder when several match', () => {
    const probe = probeFor({
      100: { procStart: 'ps-100' },
      900: { image: 'Code' },
      901: { image: 'Code' },
    })
    const broad = lock({ port: 1000, pid: 900, workspaceFolders: ['p:\\proj'] })
    const exact = lock({ port: 1001, pid: 901, workspaceFolders: ['p:\\proj\\alpha'] })
    const out = resolveLiveSessions([session()], [broad, exact], probe)
    expect(out[0]!.window?.pid).toBe(901)
  })
})

describe('createWin32ProcessProbe', () => {
  const onWindows = process.platform === 'win32'

  it.skipIf(!onWindows)('reports the current process as alive', () => {
    expect(createWin32ProcessProbe().isAlive(process.pid)).toBe(true)
  })

  it.skipIf(!onWindows)('reports an implausible pid as dead', () => {
    expect(createWin32ProcessProbe().isAlive(999_999_998)).toBe(false)
  })

  it.skipIf(!onWindows)('returns an image name for the current process', () => {
    expect(createWin32ProcessProbe().imageName(process.pid)).toMatch(/\S/)
  })

  it.skipIf(!onWindows)('rejects the current pid when the start time disagrees', () => {
    expect(createWin32ProcessProbe().isAlive(process.pid, 'not-a-filetime')).toBe(false)
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/core test liveness`
Expected: FAIL — `Failed to resolve import "./liveness.js"`

- [ ] **Step 3: Írd meg az implementációt**

`packages/core/src/liveness.ts`:
```ts
import { execFileSync } from 'node:child_process'
import type { IdeLock, LiveSession, SessionRecord } from './types.js'

export interface ProcessProbe {
  /**
   * Igaz, ha a pid létezik ÉS — ha `procStart` meg van adva — a process
   * indulási ideje egyezik. A pid önmagában nem elég: a Windows újrahasznosítja
   * a pideket, és az elárvult lock fájlok miatt rossz ablakra ugranánk.
   */
  isAlive(pid: number, procStart?: string): boolean
  /**
   * A processz image neve (a `Get-Process` `Name` oszlopa), vagy `undefined`,
   * ha a pid nem él. A lock fájlok nem tárolnak `procStart`-ot, így náluk ez az
   * egyetlen fogódzó annak eldöntésére, hogy a pid tényleg a bejegyzett IDE-hez
   * tartozik-e, vagy időközben újrahasznosították.
   */
  imageName(pid: number): string | undefined
}

/** A `Get-Process` szerinti image nevek, amik VSCode ablakot jelentenek. */
const VSCODE_IMAGE_NAMES = new Set(['code', 'code - insiders'])

function normalize(p: string): string {
  return p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Igaz, ha `child` azonos `parent`-tel vagy alatta van. */
function isWithin(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(p + '\\')
}

/**
 * Igaz, ha a lock pidje tényleg az a fajta processz, aminek a lock mondja.
 *
 * A veszélyes eset, ami ellen véd: egy elárvult lock ugyanarra a workspace-re,
 * aminek a pidjét időközben egy független processz kapta meg. A pid él, az
 * útvonal egyezik — csak az image név árulja el, hogy nem VSCode ablak. Ismeretlen
 * IDE-nél nem szűrünk: inkább párosítunk, mint hogy egy támogatott szerkesztőt
 * kizárjunk egy tipp alapján.
 */
function ownsLock(lock: IdeLock, probe: ProcessProbe): boolean {
  const image = probe.imageName(lock.pid)
  if (image === undefined) return false
  if (lock.ideName === undefined || !/visual studio code/i.test(lock.ideName)) return true
  return VSCODE_IMAGE_NAMES.has(image.toLowerCase())
}

function bestWindow(cwd: string, locks: IdeLock[], probe: ProcessProbe): IdeLock | undefined {
  let best: IdeLock | undefined
  let bestLength = -1

  for (const lock of locks) {
    if (!ownsLock(lock, probe)) continue
    for (const folder of lock.workspaceFolders) {
      if (!isWithin(cwd, folder)) continue
      const length = normalize(folder).length
      if (length > bestLength) {
        best = lock
        bestLength = length
      }
    }
  }
  return best
}

export function resolveLiveSessions(
  records: SessionRecord[],
  locks: IdeLock[],
  probe: ProcessProbe,
): LiveSession[] {
  return records
    .filter((r) => probe.isAlive(r.pid, r.procStart))
    .map((record) => ({ record, window: bestWindow(record.cwd, locks, probe) }))
}

const SNAPSHOT_SCRIPT = [
  'Get-Process | ForEach-Object {',
  '  try { "$($_.Id)`t$($_.StartTime.ToFileTime())`t$($_.Name)" } catch { }',
  '}',
].join(' ')

interface ProcessInfo {
  startFileTime: string
  image: string
}

/**
 * Windows process probe. A `procStart` a session fájlban a process creation
 * FILETIME decimálisan; a PowerShell `StartTime.ToFileTime()` ugyanezt adja.
 *
 * Egyetlen pillanatképet vesz az összes processzről, és abból válaszol. Ez
 * szándékos: egy szkennelés 20-30 pidet kérdez meg, és pidenként egy
 * PowerShell indítása (~200 ms) a másodperces poll mellett elfogadhatatlan.
 * A pillanatkép `ttlMs`-ig érvényes, és hiba esetén az előzőt tartjuk meg —
 * egy elbukott lekérdezés ne tüntesse el az összes sessiont a listáról.
 */
export function createWin32ProcessProbe(ttlMs = 2000): ProcessProbe {
  let snapshot = new Map<number, ProcessInfo>()
  let takenAt = 0
  let primed = false

  function refresh(): void {
    const now = Date.now()
    // Amíg egyszer sem sikerült, sűrűbben próbálkozunk: az üres pillanatkép
    // minden sessiont halottnak mutatna, és a teljes TTL-t végigvárni ezzel a
    // hazugsággal rosszabb, mint egy gyors újrapróbálkozás.
    const interval = primed ? ttlMs : Math.min(ttlMs, 250)
    if (now - takenAt < interval) return
    takenAt = now

    let output: string
    try {
      output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      )
    } catch (error) {
      console.error('[probe] process snapshot failed, keeping the previous one', error)
      return
    }

    const next = new Map<number, ProcessInfo>()
    for (const line of output.split('\n')) {
      const [rawPid, startFileTime, image] = line.trim().split('\t')
      if (rawPid === undefined || startFileTime === undefined || image === undefined) continue
      const pid = Number.parseInt(rawPid, 10)
      if (!Number.isNaN(pid)) next.set(pid, { startFileTime, image })
    }
    if (next.size > 0) {
      snapshot = next
      primed = true
    }
  }

  return {
    isAlive(pid, procStart) {
      refresh()
      const proc = snapshot.get(pid)
      if (proc === undefined) return false
      if (procStart === undefined) return true
      return proc.startFileTime === procStart
    },
    imageName(pid) {
      refresh()
      return snapshot.get(pid)?.image
    },
  }
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/core test liveness`
Expected: PASS, 17 teszt (13 a `resolveLiveSessions`-re, 4 a valós Win32 probe-ra).

- [ ] **Step 5: Kézi ellenőrzés a valós gépen**

Ez azt igazolja, hogy a `procStart` formátumfeltevés helyes. Futtasd egy élő session pidjével:

```powershell
$s = Get-Content "$env:USERPROFILE\.claude\sessions\<pid>.json" -Raw | ConvertFrom-Json
"file: $($s.procStart)"
"proc: $((Get-Process -Id $s.pid).StartTime.ToFileTime())"
```
Expected: a két érték azonos. Ha nem, állítsd le a taskot és jelezd — a
`createWin32ProcessProbe` feltevése hibás, és a párosítás az egész M1 alapja.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/liveness.ts packages/core/src/liveness.test.ts
git commit -m "feat(core): liveness check with process start time and session/window pairing"
```

---

### Task 4: core — transcript-olvasás

**Files:**
- Create: `packages/core/src/transcript.ts`
- Test: `packages/core/src/transcript.test.ts`

**Interfaces:**
- Consumes: `SessionActivity` (Task 2)
- Produces:
  - `readActivityFromLines(lines: string[]): SessionActivity`
  - `findTranscriptPath(claudeDir: string, sessionId: string): Promise<string | undefined>`
  - `tailLines(filePath: string, maxBytes?: number): Promise<string[]>`

- [ ] **Step 1: Írd meg a failing tesztet**

`packages/core/src/transcript.test.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { findTranscriptPath, readActivityFromLines, tailLines } from './transcript.js'

const assistantText = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-04T10:00:00.000Z',
  message: { content: [{ type: 'text', text: 'Megnézem a konfigot.' }] },
})

const assistantTool = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-04T10:00:05.000Z',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
})

describe('readActivityFromLines', () => {
  it('returns the last assistant text', () => {
    const a = readActivityFromLines([assistantText])
    expect(a.lastAssistantText).toBe('Megnézem a konfigot.')
    expect(a.lastEventAt).toBe(Date.parse('2026-09-04T10:00:00.000Z'))
  })

  it('reports a running tool from the newest assistant message', () => {
    const a = readActivityFromLines([assistantText, assistantTool])
    expect(a.runningTool).toBe('Bash')
    expect(a.lastAssistantText).toBe('Megnézem a konfigot.')
  })

  it('clears the running tool once its result arrives', () => {
    const result = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-04T10:00:09.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
    })
    const a = readActivityFromLines([assistantTool, result])
    expect(a.runningTool).toBeUndefined()
  })

  it('skips unknown record types without throwing', () => {
    const noise = [
      JSON.stringify({ type: 'queue-operation', operation: 'x' }),
      JSON.stringify({ type: 'atis-latch', atis: 1 }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'x' }),
      JSON.stringify({ type: 'attachment', attachment: {} }),
      JSON.stringify({ type: 'brand-new-type-from-the-future' }),
    ]
    expect(() => readActivityFromLines(noise)).not.toThrow()
    expect(readActivityFromLines(noise).lastAssistantText).toBeUndefined()
  })

  it('skips malformed JSON and truncated lines', () => {
    const a = readActivityFromLines(['{"type":"assis', '', '   ', assistantText])
    expect(a.lastAssistantText).toBe('Megnézem a konfigot.')
  })

  it('returns an empty activity for no input', () => {
    expect(readActivityFromLines([])).toEqual({})
  })

  it('survives a null entry inside a content array', () => {
    // Valid JSON, és a `.type` olvasása rajta TypeError-t dobna. Ez a fajta
    // meglepetés az, amiért ez a modul egyáltalán toleráns.
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-04T10:00:00.000Z',
      message: { content: [null, { type: 'text', text: 'túléltem' }] },
    })
    expect(() => readActivityFromLines([line])).not.toThrow()
    expect(readActivityFromLines([line]).lastAssistantText).toBe('túléltem')
  })

  it('survives content blocks that are primitives', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [42, 'szöveg', true, { type: 'text', text: 'ok' }] },
    })
    expect(readActivityFromLines([line]).lastAssistantText).toBe('ok')
  })

  it('survives a message whose content is not an array', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: 'plain string' } }),
      JSON.stringify({ type: 'assistant', message: 'not an object' }),
      JSON.stringify({ type: 'assistant', message: null }),
    ]
    expect(() => readActivityFromLines(lines)).not.toThrow()
    expect(readActivityFromLines(lines)).toEqual({})
  })

  it('keeps the last tool when one message carries several tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'tool_use', name: 'Bash', input: {} },
        ],
      },
    })
    expect(readActivityFromLines([line]).runningTool).toBe('Bash')
  })
})

describe('findTranscriptPath', () => {
  async function projectsFixture(): Promise<string> {
    const claudeDir = await mkdtemp(path.join(tmpdir(), 'cs-tx-'))
    await mkdir(path.join(claudeDir, 'projects', 'some-encoded-name'), { recursive: true })
    return claudeDir
  }

  it('finds the transcript whatever the project directory is called', async () => {
    const claudeDir = await projectsFixture()
    const file = path.join(claudeDir, 'projects', 'some-encoded-name', 'sid-1.jsonl')
    await writeFile(file, '')
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBe(file)
  })

  it('ignores a directory that happens to carry the transcript name', async () => {
    const claudeDir = await projectsFixture()
    await mkdir(path.join(claudeDir, 'projects', 'some-encoded-name', 'sid-1.jsonl'))
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBeUndefined()
  })

  it('returns undefined when no project directory holds it', async () => {
    const claudeDir = await projectsFixture()
    expect(await findTranscriptPath(claudeDir, 'sid-missing')).toBeUndefined()
  })

  it('returns undefined when there is no projects directory at all', async () => {
    const claudeDir = await mkdtemp(path.join(tmpdir(), 'cs-tx-'))
    expect(await findTranscriptPath(claudeDir, 'sid-1')).toBeUndefined()
  })
})

describe('tailLines', () => {
  async function fileWith(content: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-tail-'))
    const file = path.join(dir, 'transcript.jsonl')
    await writeFile(file, content, 'utf8')
    return file
  }

  it('returns nothing for an empty file', async () => {
    expect(await tailLines(await fileWith(''))).toEqual([])
  })

  it('returns nothing for a file that does not exist', async () => {
    expect(await tailLines(path.join(tmpdir(), 'cs-nope', 'missing.jsonl'))).toEqual([])
  })

  it('returns nothing when the path is a directory', async () => {
    // Figyelem: ez NEM a catch ágat bizonyítja. Windowson a stat 0 méretet ad,
    // így a `length === 0` korai visszatérés fut le, és a catch szóba sem kerül;
    // csak POSIX-on dob a read EISDIR-rel. A teszt attól még ér valamit — a
    // hívóhoz egyik platformon sem szivároghat ki hiba —, de a hibakezelés
    // regressziós fedezetét a következő teszt adja.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-tail-'))
    expect(await tailLines(dir)).toEqual([])
  })

  it('returns nothing, and logs, when the read itself fails', async () => {
    // Egy megnyitás utáni olvasási hibát platformfüggetlenül nehéz előidézni.
    // Negatív ablakmérettel a `length` negatív lesz, és a `Buffer.alloc` dob —
    // a catch ágon belül, pontosan úgy, ahogy egy lemezhiba tenné. Ez az
    // egyetlen teszt, ami a hibakezelést ténylegesen végigfuttatja Windowson is.
    const file = await fileWith('egy\nkét\nhárom')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await tailLines(file, -1)).toEqual([])
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('read failed'), expect.anything())

    logged.mockRestore()
  })

  it('returns every line when the file is smaller than the window', async () => {
    expect(await tailLines(await fileWith('a\nb\nc'))).toEqual(['a', 'b', 'c'])
  })

  it('drops the truncated first line instead of returning mangled text', async () => {
    // A transcriptek nem ASCII szöveget tartalmaznak, tehát a seek egy több
    // bájtos karakter közepére eshet. A megtartott soroknak épnek kell lenniük.
    const lines = ['árvíztűrő tükörfúrógép', 'öt szép szűzlány', 'hűtőházi rendszer']
    const file = await fileWith(lines.join('\n'))
    const tail = await tailLines(file, 40)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.every((line) => !line.includes('�'))).toBe(true)
    expect(tail[tail.length - 1]).toBe('hűtőházi rendszer')
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/core test transcript`
Expected: FAIL — `Failed to resolve import "./transcript.js"`

- [ ] **Step 3: Írd meg az implementációt**

`packages/core/src/transcript.ts`:
```ts
import { open, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { SessionActivity } from './types.js'

interface ContentBlock {
  type?: unknown
  text?: unknown
  name?: unknown
}

function blocks(rec: Record<string, unknown>): ContentBlock[] {
  const message = rec.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  // A nem-objektum elemeket itt dobjuk el, nem a hívóban. Egy `null` blokk
  // valid JSON, és a `.type` olvasása rajta TypeError-t dobna — pontosan az a
  // fajta összeomlás, amit ennek a modulnak meg kell előznie.
  return content.filter(
    (block): block is ContentBlock => typeof block === 'object' && block !== null,
  )
}

/**
 * A transcript utolsó soraiból kiolvassa, mit csinál épp a session.
 * Ismeretlen rekordtípus némán kimarad — a formátum bővül, és egy új típus
 * nem törheti el a monitort.
 */
export function readActivityFromLines(lines: string[]): SessionActivity {
  const activity: SessionActivity = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    let rec: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) continue
      rec = parsed as Record<string, unknown>
    } catch {
      continue
    }

    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
    if (!Number.isNaN(at)) activity.lastEventAt = at

    if (rec.type === 'assistant') {
      for (const block of blocks(rec)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          activity.lastAssistantText = block.text.trim()
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          activity.runningTool = block.name
        }
      }
    } else if (rec.type === 'user') {
      // Egy tool_result lezárja a futó toolt.
      if (blocks(rec).some((b) => b.type === 'tool_result')) {
        activity.runningTool = undefined
      }
    }
  }

  return activity
}

/**
 * Megkeresi a session transcriptjét. Szándékosan glob-bal, nem a cwd-ből
 * képzett könyvtárnévvel: a kódolás nem dokumentált és változhat.
 */
export async function findTranscriptPath(
  claudeDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const projects = path.join(claudeDir, 'projects')
  let entries: string[]
  try {
    entries = await readdir(projects)
  } catch {
    return undefined
  }

  for (const entry of entries) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`)
    try {
      const handle = await open(candidate, 'r')
      try {
        // A puszta megnyithatóság nem elég: egy `<sessionId>.jsonl` nevű
        // *könyvtár* is megnyílik, és utána a tailLines vagy üres eredményt ad,
        // vagy EISDIR-rel száll el. A típusát is meg kell nézni.
        if ((await handle.stat()).isFile()) return candidate
      } finally {
        await handle.close()
      }
    } catch {
      // Nem létezik, vagy nem olvasható. A kettőt nem különböztetjük meg: a
      // visszatérési szerződés `string | undefined`, és egy jogosultsági hiba
      // ugyanúgy azt jelenti, hogy ezt a transcriptet nem tudjuk olvasni.
      continue
    }
  }
  return undefined
}

/** A fájl utolsó `maxBytes` bájtját olvassa, és eldobja az első, csonka sort. */
export async function tailLines(filePath: string, maxBytes = 256 * 1024): Promise<string[]> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length === 0) return []

    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines
  } catch (error) {
    // A megnyitás után is elszállhat az olvasás: lemezhiba, vírusirtó zárolása,
    // hálózati meghajtó, jogosultságváltás olvasás közben, vagy egy könyvtár
    // nem-Windows platformon (EISDIR). Egy transcript tartalma nem ér annyit,
    // hogy a hívó egész szkennelését megbuktassa — ez a függvény best-effort.
    // Naplózunk, mert ezt az ágat éles hibán kívül nehéz kiváltani: ha egyszer
    // lefut, legyen nyoma.
    console.error(`[transcript] read failed for ${filePath}`, error)
    return []
  } finally {
    await handle.close()
  }
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/core test transcript`
Expected: PASS, 20 teszt (10 a `readActivityFromLines`-ra, 4 a `findTranscriptPath`-ra,
6 a `tailLines`-ra).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transcript.ts packages/core/src/transcript.test.ts
git commit -m "feat(core): transcript tailing and activity extraction"
```

---

### Task 5: core — paths és atomikus settings-író

**Files:**
- Create: `packages/core/src/paths.ts`, `packages/core/src/settings-writer.ts`
- Create: `packages/core/tsconfig.check.json`
- Test: `packages/core/src/paths.test.ts`
- Modify: `packages/core/src/index.ts` — a Task 1 üres barreljét cseréld le a teljes re-exportra
- Modify: `packages/core/package.json` — a `check-types` script a check configra mutasson
- Test: `packages/core/src/settings-writer.test.ts`

**Interfaces:**
- Consumes: semmi
- Produces:
  - `resolveClaudeDir(env?: NodeJS.ProcessEnv): string`
  - `mergeSettings(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown>`
  - `updateSettingsFile(filePath: string, patch: Record<string, unknown>): Promise<void>`
  - `packages/core/src/index.ts` re-exportálja az összes eddigi publikus API-t és típust

- [ ] **Step 1: Írd meg a failing tesztet**

`packages/core/src/settings-writer.test.ts`:
```ts
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeSettings, updateSettingsFile } from './settings-writer.js'

describe('mergeSettings', () => {
  it('preserves unrelated keys', () => {
    const existing = {
      model: 'opus[1m]',
      effortLevel: 'xhigh',
      tui: 'fullscreen',
      permissions: { allow: ['Bash(pnpm build *)'] },
    }
    const out = mergeSettings(existing, { statusLine: { type: 'command', command: 'x' } })
    expect(out.model).toBe('opus[1m]')
    expect(out.effortLevel).toBe('xhigh')
    expect(out.tui).toBe('fullscreen')
    expect(out.permissions).toEqual({ allow: ['Bash(pnpm build *)'] })
    expect(out.statusLine).toEqual({ type: 'command', command: 'x' })
  })

  it('deep-merges nested objects instead of replacing them', () => {
    const existing = { permissions: { allow: ['a'], deny: ['b'] } }
    const out = mergeSettings(existing, { permissions: { ask: ['c'] } })
    expect(out.permissions).toEqual({ allow: ['a'], deny: ['b'], ask: ['c'] })
  })

  it('replaces arrays wholesale rather than concatenating', () => {
    const existing = { hooks: { Notification: [{ old: true }] } }
    const out = mergeSettings(existing, { hooks: { Notification: [{ fresh: true }] } })
    expect(out.hooks).toEqual({ Notification: [{ fresh: true }] })
  })

  it('does not mutate its inputs', () => {
    const existing = { permissions: { allow: ['a'] } }
    const frozen = JSON.stringify(existing)
    mergeSettings(existing, { permissions: { allow: ['b'] } })
    expect(JSON.stringify(existing)).toBe(frozen)
  })

  it('drops a __proto__ key instead of losing it into the prototype', () => {
    // JSON.parse kell: az objektum-literál `__proto__` kulcsát a parser
    // külön kezeli, és nem saját kulcsot hozna létre.
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const out = mergeSettings({ model: 'opus' }, patch)
    expect(out).toEqual({ model: 'opus' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((({} as Record<string, unknown>).polluted)).toBeUndefined()
  })
})

describe('updateSettingsFile', () => {
  it('creates the file when it does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { model: 'opus' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('merges into an existing file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ model: 'opus', tui: 'fullscreen' }))
    await updateSettingsFile(file, { statusLine: { type: 'command' } })
    const out = JSON.parse(await readFile(file, 'utf8'))
    expect(out).toEqual({
      model: 'opus',
      tui: 'fullscreen',
      statusLine: { type: 'command' },
    })
  })

  it('refuses to write when the existing file is unparseable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ this is not json')
    await expect(updateSettingsFile(file, { model: 'opus' })).rejects.toThrow(/parse/i)
    expect(await readFile(file, 'utf8')).toBe('{ this is not json')
  })

  it('serialises concurrent updates instead of interleaving them', async () => {
    // Sorbaállítás nélkül a három írás egymásba fésülődik, és a fájl
    // olvashatatlan JSON lesz — a pontos katasztrófa, amit ez a modul megelőz.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ model: 'opus' }))

    await Promise.all([
      updateSettingsFile(file, { statusLine: { type: 'command' } }),
      updateSettingsFile(file, { env: { CLAUDESWITCHER_PORT: '1' } }),
      updateSettingsFile(file, { hooks: { Stop: [] } }),
    ])

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      model: 'opus',
      statusLine: { type: 'command' },
      env: { CLAUDESWITCHER_PORT: '1' },
      hooks: { Stop: [] },
    })
  })

  it('keeps writing after a failed update on the same file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ broken')
    await expect(updateSettingsFile(file, { a: 1 })).rejects.toThrow(/parse/i)

    await writeFile(file, '{}')
    await updateSettingsFile(file, { b: 2 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ b: 2 })
  })

  it('leaves no temp files behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await updateSettingsFile(file, { model: 'opus' })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/core test settings-writer`
Expected: FAIL — `Failed to resolve import "./settings-writer.js"`

- [ ] **Step 3: Írd meg a paths és settings-writer modult**

`packages/core/src/paths.ts`:
```ts
import os from 'node:os'
import path from 'node:path'

/** A Claude Code konfigurációs könyvtára. CLAUDE_CONFIG_DIR felülírja. */
export function resolveClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override !== undefined && override !== '') return override
  return path.join(os.homedir(), '.claude')
}

export function sessionsDir(claudeDir: string): string {
  return path.join(claudeDir, 'sessions')
}

export function ideDir(claudeDir: string): string {
  return path.join(claudeDir, 'ide')
}

export function userSettingsPath(claudeDir: string): string {
  return path.join(claudeDir, 'settings.json')
}
```

`packages/core/src/settings-writer.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Rekurzív merge. Objektumokat mélyen egyesít, tömböket és skalárokat cserél.
 * A tömb-csere szándékos: a hook-konfigot idempotensen akarjuk újraírni, nem
 * duplikálni minden telepítéskor.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    // A `__proto__` értékadása a prototípus-settert hívná adatkulcs létrehozása
    // helyett, és a payload némán eltűnne. Nem valós Claude Code beállításkulcs,
    // de a csendes adatvesztést nem hagyjuk a kódban.
    if (key === '__proto__') continue
    const current = out[key]
    out[key] =
      isPlainObject(value) && isPlainObject(current)
        ? mergeSettings(current, value)
        : value
  }
  return out
}

/**
 * Célfájlonkénti sorbaállítás.
 *
 * Enélkül két egyidejű hívás ugyanarra a fájlra összefésült, olvashatatlan
 * JSON-t hagyna maga után — pont az a katasztrófa, amit ez a modul megelőzni
 * hivatott —, ráadásul a második beolvasás lemaradna az első írásáról, tehát az
 * egyik patch akkor is elveszne, ha a fájl épen marad.
 *
 * A Map csak annyi bejegyzést tart, ahány külön settings fájlt írunk (a
 * felhasználói és a projektszintű), tehát nem nő korlátlanul.
 */
const writeQueues = new Map<string, Promise<unknown>>()

export function updateSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const key = path.resolve(filePath)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // A következő hívónak arra kell várnia, hogy a fájlművelet *befejeződjön*, a
  // sikerére nem — ezért fut a lánc hiba után is tovább.
  const next = previous.then(
    () => writeMerged(filePath, patch),
    () => writeMerged(filePath, patch),
  )
  writeQueues.set(key, next.catch(() => undefined))
  return next
}

/**
 * Atomikus merge-írás: temp fájl + rename. Parse-olhatatlan meglévő fájlnál
 * dob, és nem ír — inkább ne módosítsunk semmit, mint hogy elveszítsük a
 * felhasználó beállításait.
 */
async function writeMerged(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  let existing: Record<string, unknown> = {}

  let raw: string | undefined
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    raw = undefined
  }

  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Cannot parse existing settings at ${filePath}; refusing to write`, { cause })
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`Settings at ${filePath} is not a JSON object; refusing to write`)
    }
    existing = parsed
  }

  const merged = mergeSettings(existing, patch)
  // Egyedi név processzenként ÉS híváson belül: a pid önmagában nem elég, mert
  // egy processzen belüli két írás ugyanarra a temp útvonalra esne.
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temp, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    // Ne hagyjunk törmeléket a ~/.claude/-ban. A célfájl érintetlen — ez a lényeg.
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
```

- [ ] **Step 3b: Írd meg a `paths.ts` tesztjét**

`packages/core/src/paths.test.ts`:
```ts
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ideDir, resolveClaudeDir, sessionsDir, userSettingsPath } from './paths.js'

describe('resolveClaudeDir', () => {
  it('prefers CLAUDE_CONFIG_DIR when it is set', () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: 'd:\\custom' })).toBe('d:\\custom')
  })

  it('trims incidental whitespace around the override', () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '  d:\\custom  ' })).toBe('d:\\custom')
  })

  it('falls back to the home directory when the override is absent or blank', () => {
    const fallback = path.join(os.homedir(), '.claude')
    expect(resolveClaudeDir({})).toBe(fallback)
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(fallback)
  })
})

describe('directory helpers', () => {
  it('derive their paths from the given claude dir', () => {
    expect(sessionsDir('d:\\c')).toBe(path.join('d:\\c', 'sessions'))
    expect(ideDir('d:\\c')).toBe(path.join('d:\\c', 'ide'))
    expect(userSettingsPath('d:\\c')).toBe(path.join('d:\\c', 'settings.json'))
  })
})
```

- [ ] **Step 4: Kapcsold be a tesztek típusellenőrzését**

`packages/core/tsconfig.check.json`:
```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*"],
  "exclude": []
}
```

A `packages/core/package.json`-ben a script mostantól ezt használja:
```json
"check-types": "tsc -p tsconfig.check.json --noEmit"
```

A `build` marad a szűk `tsconfig.json`-on — a `dist/`-be nem való tesztfájl.

- [ ] **Step 5: Írd meg a public API-t**

`packages/core/src/index.ts` — a Task 1 `export {}` placeholderét cseréld le erre:
```ts
export * from './types.js'
export * from './paths.js'
export * from './session-registry.js'
export * from './liveness.js'
export * from './transcript.js'
export * from './settings-writer.js'
```

- [ ] **Step 6: Futtasd a teszteket és a típusellenőrzést**

Run: `pnpm --filter @claudeswitcher/core test && pnpm --filter @claudeswitcher/core check-types && pnpm --filter @claudeswitcher/core build`
Expected: minden teszt PASS, típushiba nincs, a `dist/index.js` a teljes publikus
API-t exportálja. A `check-types` mostantól a tesztfájlokat is fordítja — ha egy
korábbi task tesztjében típushiba van, az itt fog először kiderülni.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/paths.ts packages/core/src/settings-writer.ts packages/core/src/settings-writer.test.ts packages/core/src/index.ts packages/core/tsconfig.check.json packages/core/package.json
git commit -m "feat(core): claude dir resolution and atomic settings merge writer"
```

---

### Task 6: daemon — hook HTTP szerver

**Files:**
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/vitest.config.ts`
- Create: `packages/daemon/src/hook-server.ts`
- Test: `packages/daemon/src/hook-server.test.ts`

**Interfaces:**
- Consumes: semmi a core-ból (a szerver tiszta)
- Produces:
  - `interface HookEvents { onNotification(e: NotificationEvent): void; onLifecycle(e: LifecycleEvent): void; onRateLimits(r: RateLimits): void }`
  - `NotificationEvent = { sessionId: string; cwd: string; type: string; text?: string }`
  - `LifecycleEvent = { sessionId: string; cwd: string; kind: 'start' | 'end' | 'stop' }`
  - `createHookApp(token: string, events: HookEvents): Hono`

- [ ] **Step 1: A daemon csomag váza**

`packages/daemon/package.json`:
```json
{
  "name": "@claudeswitcher/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/daemon.js",
  "types": "./dist/daemon.d.ts",
  "exports": { ".": { "types": "./dist/daemon.d.ts", "default": "./dist/daemon.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check-types": "tsc -p tsconfig.check.json --noEmit"
  },
  "dependencies": {
    "@claudeswitcher/core": "workspace:*",
    "@hono/node-server": "^1.13.0",
    "chokidar": "^4.0.0",
    "hono": "^4.6.0",
    "ws": "^8.18.0"
  },
  "devDependencies": { "@types/ws": "^8.5.0" }
}
```

`packages/daemon/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/daemon/tsconfig.check.json`:
```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*"],
  "exclude": []
}
```

`packages/daemon/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 2: Írd meg a failing tesztet**

A Hono `app.request()` port nyitása nélkül tesztelhető.

`packages/daemon/src/hook-server.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { createHookApp, type HookEvents } from './hook-server.js'

const TOKEN = 'test-token'

function events(): HookEvents {
  return { onNotification: vi.fn(), onLifecycle: vi.fn(), onRateLimits: vi.fn() }
}

function post(app: ReturnType<typeof createHookApp>, url: string, body: unknown, token = TOKEN) {
  return app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

describe('hook app auth', () => {
  it('rejects a missing token', async () => {
    const app = createHookApp(TOKEN, events())
    const res = await app.request('/hooks/notification', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const app = createHookApp(TOKEN, events())
    expect((await post(app, '/hooks/notification', {}, 'nope')).status).toBe(401)
  })
})

describe('POST /hooks/notification', () => {
  it('forwards a permission_prompt notification', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    const res = await post(app, '/hooks/notification', {
      session_id: 'sid-1',
      cwd: 'p:\\proj\\alpha',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      notification_text: 'Claude needs permission to run pnpm test',
    })
    expect(res.status).toBe(200)
    expect(ev.onNotification).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      cwd: 'p:\\proj\\alpha',
      type: 'permission_prompt',
      text: 'Claude needs permission to run pnpm test',
    })
  })

  it('always answers 200 with an empty body so it never blocks a session', async () => {
    const ev = events()
    ;(ev.onNotification as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('handler exploded')
    })
    const app = createHookApp(TOKEN, ev)
    const res = await post(app, '/hooks/notification', {
      session_id: 'sid-1', cwd: 'c', notification_type: 'idle_prompt',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('ignores a payload without a session_id', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/hooks/notification', { notification_type: 'x' })).status).toBe(200)
    expect(ev.onNotification).not.toHaveBeenCalled()
  })

  it('contains an async handler rejection instead of letting it escape', async () => {
    // A kezelők `void | Promise<void>`-ot adhatnak vissza. Egy elkapatlan
    // elutasítás alapértelmezett Node beállításokkal az egész daemont megölné.
    const ev = events()
    const boom = new Error('async boom')
    ;(ev.onNotification as ReturnType<typeof vi.fn>).mockRejectedValue(boom)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post(createHookApp(TOKEN, ev), '/hooks/notification', {
      session_id: 'sid-1',
      cwd: 'c',
      notification_type: 'idle_prompt',
    })
    expect(res.status).toBe(200)

    await new Promise((resolve) => setImmediate(resolve))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('notification'), boom)
    logged.mockRestore()
  })
})

describe('POST /hooks/lifecycle/:kind', () => {
  it('forwards start, end and stop', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    for (const kind of ['start', 'end', 'stop'] as const) {
      await post(app, `/hooks/lifecycle/${kind}`, { session_id: 'sid-1', cwd: 'c' })
      expect(ev.onLifecycle).toHaveBeenCalledWith({ sessionId: 'sid-1', cwd: 'c', kind })
    }
  })

  it('ignores an unknown lifecycle kind', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/hooks/lifecycle/bogus', { session_id: 's', cwd: 'c' })).status).toBe(200)
    expect(ev.onLifecycle).not.toHaveBeenCalled()
  })
})

describe('POST /statusline', () => {
  it('forwards rate limits', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    await post(app, '/statusline', {
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    })
    expect(ev.onRateLimits).toHaveBeenCalledWith({
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    })
  })

  it('ignores a payload with no rate_limits (free plans, pre-first-response)', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    expect((await post(app, '/statusline', { model: { id: 'opus' } })).status).toBe(200)
    expect(ev.onRateLimits).not.toHaveBeenCalled()
  })

  it('ignores rate_limits whose windows are all unusable', async () => {
    const ev = events()
    const app = createHookApp(TOKEN, ev)
    await post(app, '/statusline', {
      rate_limits: { five_hour: { used_percentage: 'lots' }, seven_day: null },
    })
    expect(ev.onRateLimits).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Futtasd, hogy lásd a hibát**

A `daemon` a `core`-t a lefordított `dist/`-en át éri el, ezért előbb build kell —
de **csak a `core`-t**. A teljes `pnpm build` ebben a pillanatban elszállna
`TS18003`-mal, mert a `daemon` `src/`-jében még csak a kizárt tesztfájl van, és a
lánc a teszt futtatása előtt megállna.

Run: `pnpm install && pnpm --filter @claudeswitcher/core build && pnpm --filter @claudeswitcher/daemon test`
Expected: FAIL — `Cannot find module './hook-server.js'`, `Caused by: … Does the file exist?`

- [ ] **Step 4: Írd meg az implementációt**

`packages/daemon/src/hook-server.ts`:
```ts
import type { RateLimits, RateLimitWindow } from '@claudeswitcher/core'
import { Hono } from 'hono'

export interface NotificationEvent {
  sessionId: string
  cwd: string
  type: string
  text?: string
}

export interface LifecycleEvent {
  sessionId: string
  cwd: string
  kind: 'start' | 'end' | 'stop'
}

export interface HookEvents {
  onNotification(event: NotificationEvent): void | Promise<void>
  onLifecycle(event: LifecycleEvent): void | Promise<void>
  onRateLimits(limits: RateLimits): void | Promise<void>
}

/**
 * Egy hook-kezelő hibája soha nem eshet ki a route-ból. A szinkron dobást a
 * hívást körülvevő try/catch fogja el; az aszinkron elutasítást ez.
 *
 * Ez nem elméleti: a kezelők `void | Promise<void>`-ot adhatnak vissza, és egy
 * elkapatlan elutasítás alapértelmezett Node beállításokkal **az egész daemont
 * megölné** — vagyis minden session hook-kezelését, nem csak ezt az egy hívást.
 * Szándékosan nem `await`-eljük: a válasz azonnal megy, a kezelő a maga
 * tempójában fut.
 */
function contain(result: void | Promise<void>, what: string): void {
  void Promise.resolve(result).catch((error: unknown) => {
    console.error(`[hook] ${what} handler failed`, error)
  })
}

const LIFECYCLE_KINDS = new Set(['start', 'end', 'stop'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function limitWindow(v: unknown): RateLimitWindow | undefined {
  if (!isRecord(v)) return undefined
  const { used_percentage, resets_at } = v
  if (typeof used_percentage !== 'number' || typeof resets_at !== 'number') return undefined
  return { used_percentage, resets_at }
}

/**
 * Az M1 hook-szervere. Minden route feltétel nélkül 200-at ad üres törzzsel:
 * ezek display-only hookok, és a szerver hibája soha nem akaszthat meg egy
 * sessiont. A hibát naplózzuk, nem terjesztjük.
 */
export function createHookApp(token: string, events: HookEvents): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) {
      return c.text('unauthorized', 401)
    }
    await next()
  })

  async function body(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
    try {
      const parsed = await c.req.json()
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  app.post('/hooks/notification', async (c) => {
    try {
      const b = await body(c)
      const sessionId = str(b.session_id)
      const type = str(b.notification_type)
      if (sessionId !== undefined && type !== undefined) {
        contain(
          events.onNotification({
            sessionId,
            cwd: str(b.cwd) ?? '',
            type,
            text: str(b.notification_text),
          }),
          'notification',
        )
      }
    } catch (error) {
      console.error('[hook] notification handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/lifecycle/:kind', async (c) => {
    try {
      const kind = c.req.param('kind')
      const b = await body(c)
      const sessionId = str(b.session_id)
      if (sessionId !== undefined && LIFECYCLE_KINDS.has(kind)) {
        contain(
          events.onLifecycle({
            sessionId,
            cwd: str(b.cwd) ?? '',
            kind: kind as LifecycleEvent['kind'],
          }),
          'lifecycle',
        )
      }
    } catch (error) {
      console.error('[hook] lifecycle handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/statusline', async (c) => {
    try {
      const b = await body(c)
      const raw = b.rate_limits
      if (isRecord(raw)) {
        const limits: RateLimits = {}
        const five = limitWindow(raw.five_hour)
        const seven = limitWindow(raw.seven_day)
        const spend = limitWindow(raw.spend_limit)
        if (five) limits.five_hour = five
        if (seven) limits.seven_day = seven
        if (spend) limits.spend_limit = spend
        if (Object.keys(limits).length > 0) {
          contain(events.onRateLimits(limits), 'statusline')
        }
      }
    } catch (error) {
      console.error('[hook] statusline handler failed', error)
    }
    return c.body(null, 200)
  })

  return app
}
```

- [ ] **Step 5: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/daemon test && pnpm check-types && pnpm build`
Expected: PASS, 11 teszt; a `check-types` és a `build` hibátlan.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): loopback hook HTTP server for notification, lifecycle and statusline"
```

---

### Task 7: daemon — session store

**Files:**
- Create: `packages/daemon/src/session-store.ts`
- Test: `packages/daemon/src/session-store.test.ts`

**Interfaces:**
- Consumes: `LiveSession`, `SessionActivity`, `SessionView`, `SessionStatus` (core); `NotificationEvent`, `LifecycleEvent` (Task 6)
- Produces:
  - `class SessionStore` metódusokkal:
    - `applySnapshot(sessions: LiveSession[], activities: Map<string, SessionActivity>): void`
    - `applyNotification(event: NotificationEvent, now?: number): void`
    - `applyLifecycle(event: LifecycleEvent): void`
    - `views(): SessionView[]`
    - `onChange(listener: () => void): void`

- [ ] **Step 1: Írd meg a failing tesztet**

`packages/daemon/src/session-store.test.ts`:
```ts
import type { LiveSession, SessionActivity } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from './session-store.js'

function live(sessionId: string, over: Partial<LiveSession['record']> = {}): LiveSession {
  return {
    record: {
      pid: 1, sessionId, cwd: 'p:\\proj\\alpha', startedAt: 1,
      name: 'alpha-01', bridgeSessionId: 'session_01x', ...over,
    },
    window: { port: 1000, pid: 900, workspaceFolders: ['p:\\proj\\alpha'] },
  }
}

const noActivity = new Map<string, SessionActivity>()

describe('SessionStore', () => {
  it('projects a snapshot into views', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    const [view] = store.views()
    expect(view!.sessionId).toBe('s1')
    expect(view!.name).toBe('alpha-01')
    expect(view!.windowPid).toBe(900)
    expect(view!.workspaceFolder).toBe('p:\\proj\\alpha')
    expect(view!.bridgeSessionId).toBe('session_01x')
  })

  it('falls back to the directory name when the session has no name', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1', { name: undefined })], noActivity)
    expect(store.views()[0]!.name).toBe('alpha')
  })

  it('reports working while a tool is running', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]))
    expect(store.views()[0]!.status).toBe('working')
  })

  it('reports idle with no tool running', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], new Map([['s1', { lastAssistantText: 'kész' }]]))
    expect(store.views()[0]!.status).toBe('idle')
  })

  it('reports waiting after a permission_prompt notification', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification(
      { sessionId: 's1', cwd: 'c', type: 'permission_prompt', text: 'run pnpm test?' },
      5_000,
    )
    const [view] = store.views()
    expect(view!.status).toBe('waiting')
    expect(view!.waitingSince).toBe(5_000)
    expect(view!.notificationText).toBe('run pnpm test?')
  })

  it('treats agent_needs_input as waiting too', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'agent_needs_input' }, 1)
    expect(store.views()[0]!.status).toBe('waiting')
  })

  it('keeps waiting even when a later snapshot shows a running tool', () => {
    // A snapshot a transcriptből jön és lemaradhat; a hook a mérvadó jelzés.
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1)
    store.applySnapshot([live('s1')], new Map([['s1', { runningTool: 'Bash' }]]))
    expect(store.views()[0]!.status).toBe('waiting')
  })

  it('clears waiting on a stop lifecycle event', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 's1', cwd: 'c', type: 'permission_prompt' }, 1)
    store.applyLifecycle({ sessionId: 's1', cwd: 'c', kind: 'stop' })
    const [view] = store.views()
    expect(view!.status).toBe('idle')
    expect(view!.waitingSince).toBeUndefined()
  })

  it('drops a session that has left the snapshot', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2')], noActivity)
    store.applySnapshot([live('s2')], noActivity)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s2'])
  })

  it('sorts waiting sessions first, oldest wait at the top', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2'), live('s3')], noActivity)
    store.applyNotification({ sessionId: 's2', cwd: 'c', type: 'permission_prompt' }, 200)
    store.applyNotification({ sessionId: 's3', cwd: 'c', type: 'permission_prompt' }, 100)
    expect(store.views().map((v) => v.sessionId)).toEqual(['s3', 's2', 's1'])
  })

  it('notifies listeners when state changes', () => {
    const store = new SessionStore()
    const listener = vi.fn()
    store.onChange(listener)
    store.applySnapshot([live('s1')], noActivity)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores notifications for unknown sessions', () => {
    const store = new SessionStore()
    store.applySnapshot([live('s1')], noActivity)
    store.applyNotification({ sessionId: 'ghost', cwd: 'c', type: 'permission_prompt' }, 1)
    expect(store.views()).toHaveLength(1)
    expect(store.views()[0]!.status).toBe('idle')
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/daemon test session-store`
Expected: FAIL — `Failed to resolve import "./session-store.js"`

- [ ] **Step 3: Írd meg az implementációt**

`packages/daemon/src/session-store.ts`:
```ts
import type { LiveSession, SessionActivity, SessionView } from '@claudeswitcher/core'
import type { LifecycleEvent, NotificationEvent } from './hook-server.js'

const WAITING_TYPES = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

interface WaitState {
  since: number
  text?: string
}

function displayName(record: LiveSession['record']): string {
  if (record.name !== undefined && record.name !== '') return record.name
  const parts = record.cwd.split(/[\\/]/).filter((p) => p !== '')
  return parts[parts.length - 1] ?? record.sessionId
}

/**
 * A UI-nak küldött állapot egyetlen forrása. Három bemenetet egyesít:
 * a periodikus snapshotot (registry + transcript), a hook-eseményeket, és az
 * életciklus-eseményeket. Ütközésnél a hook nyer: a snapshot a transcriptből
 * származik és lemaradhat, a hook viszont a történés pillanatában érkezik.
 */
export class SessionStore {
  #sessions = new Map<string, LiveSession>()
  #activities = new Map<string, SessionActivity>()
  #waiting = new Map<string, WaitState>()
  #listeners: Array<() => void> = []

  onChange(listener: () => void): void {
    this.#listeners.push(listener)
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[store] listener failed', error)
      }
    }
  }

  applySnapshot(sessions: LiveSession[], activities: Map<string, SessionActivity>): void {
    const ids = new Set(sessions.map((s) => s.record.sessionId))
    this.#sessions = new Map(sessions.map((s) => [s.record.sessionId, s]))
    this.#activities = activities

    for (const id of [...this.#waiting.keys()]) {
      if (!ids.has(id)) this.#waiting.delete(id)
    }
    this.#emit()
  }

  applyNotification(event: NotificationEvent, now: number = Date.now()): void {
    if (!this.#sessions.has(event.sessionId)) return

    if (WAITING_TYPES.has(event.type)) {
      this.#waiting.set(event.sessionId, { since: now, text: event.text })
    } else {
      this.#waiting.delete(event.sessionId)
    }
    this.#emit()
  }

  applyLifecycle(event: LifecycleEvent): void {
    if (event.kind === 'end') {
      this.#sessions.delete(event.sessionId)
    }
    this.#waiting.delete(event.sessionId)
    this.#emit()
  }

  views(): SessionView[] {
    const views: SessionView[] = []

    for (const [sessionId, session] of this.#sessions) {
      const activity = this.#activities.get(sessionId) ?? {}
      const wait = this.#waiting.get(sessionId)

      const status =
        wait !== undefined ? 'waiting'
        : activity.runningTool !== undefined ? 'working'
        : 'idle'

      views.push({
        sessionId,
        pid: session.record.pid,
        name: displayName(session.record),
        cwd: session.record.cwd,
        status,
        activity,
        windowPid: session.window?.pid,
        workspaceFolder: session.window?.workspaceFolders[0],
        bridgeSessionId: session.record.bridgeSessionId,
        waitingSince: wait?.since,
        notificationText: wait?.text,
      })
    }

    return views.sort((a, b) => {
      if (a.status === 'waiting' && b.status !== 'waiting') return -1
      if (b.status === 'waiting' && a.status !== 'waiting') return 1
      if (a.status === 'waiting' && b.status === 'waiting') {
        return (a.waitingSince ?? 0) - (b.waitingSince ?? 0)
      }
      return a.name.localeCompare(b.name)
    })
  }
}
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/daemon test session-store`
Expected: PASS, 12 teszt.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session-store.ts packages/daemon/src/session-store.test.ts
git commit -m "feat(daemon): session store merging registry snapshots with hook events"
```

---

### Task 8: daemon — rate limit store és scanner

**Files:**
- Create: `packages/daemon/src/rate-limits.ts`, `packages/daemon/src/scanner.ts`
- Test: `packages/daemon/src/rate-limits.test.ts`, `packages/daemon/src/scanner.test.ts`

**Interfaces:**
- Consumes: `RateLimits`, `LiveSession`, `SessionActivity`, `ProcessProbe` (core)
- Produces:
  - `class RateLimitStore { update(l: RateLimits): void; current(now?: number): RateLimits }`
  - `scanSessions(claudeDir: string, probe: ProcessProbe): Promise<{ sessions: LiveSession[]; activities: Map<string, SessionActivity> }>`

- [ ] **Step 1: Írd meg a rate limit failing tesztet**

`packages/daemon/src/rate-limits.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { RateLimitStore } from './rate-limits.js'

const NOW = 1_000_000

describe('RateLimitStore', () => {
  it('starts empty', () => {
    expect(new RateLimitStore().current(NOW)).toEqual({})
  })

  it('keeps the most recent update', () => {
    const store = new RateLimitStore()
    store.update({ five_hour: { used_percentage: 10, resets_at: NOW / 1000 + 100 } })
    store.update({ five_hour: { used_percentage: 20, resets_at: NOW / 1000 + 100 } })
    expect(store.current(NOW).five_hour?.used_percentage).toBe(20)
  })

  it('merges windows reported in separate updates', () => {
    const store = new RateLimitStore()
    store.update({ five_hour: { used_percentage: 10, resets_at: NOW / 1000 + 100 } })
    store.update({ seven_day: { used_percentage: 40, resets_at: NOW / 1000 + 200 } })
    const current = store.current(NOW)
    expect(current.five_hour?.used_percentage).toBe(10)
    expect(current.seven_day?.used_percentage).toBe(40)
  })

  it('drops a window once its resets_at has passed', () => {
    // A Claude Code maga is eldobja a lejárt ablakot; a UI ne mutasson állottat.
    const store = new RateLimitStore()
    store.update({ five_hour: { used_percentage: 90, resets_at: NOW / 1000 - 1 } })
    expect(store.current(NOW).five_hour).toBeUndefined()
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/daemon test rate-limits`
Expected: FAIL — `Failed to resolve import "./rate-limits.js"`

- [ ] **Step 3: Írd meg a rate limit store-t**

`packages/daemon/src/rate-limits.ts`:
```ts
import type { RateLimits } from '@claudeswitcher/core'

/**
 * Account-szintű adat, ezért bármelyik session statusLine-ja frissítheti.
 * A lejárt ablakokat eldobjuk — a Claude Code is ezt teszi, és állott
 * százalékot mutatni rosszabb, mint semmit.
 */
export class RateLimitStore {
  #limits: RateLimits = {}

  update(limits: RateLimits): void {
    this.#limits = { ...this.#limits, ...limits }
  }

  current(now: number = Date.now()): RateLimits {
    const seconds = now / 1000
    const out: RateLimits = {}
    for (const key of ['five_hour', 'seven_day', 'spend_limit'] as const) {
      const window = this.#limits[key]
      if (window !== undefined && window.resets_at > seconds) out[key] = window
    }
    return out
  }
}
```

- [ ] **Step 4: Írd meg a scanner failing tesztet**

`packages/daemon/src/scanner.test.ts`:
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessProbe } from '@claudeswitcher/core'
import { describe, expect, it } from 'vitest'
import { scanSessions } from './scanner.js'

// A ProcessProbe-nak `imageName`-je is van a Task 3 óta: a lock fájlok nem
// tárolnak `procStart`-ot, így csak az image név árulja el, ha egy elárvult lock
// pidjét időközben egy másik processz kapta meg.
const aliveProbe: ProcessProbe = { isAlive: () => true, imageName: () => 'Code' }
const deadProbe: ProcessProbe = { isAlive: () => false, imageName: () => undefined }

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cs-scan-'))
  await mkdir(path.join(dir, 'sessions'), { recursive: true })
  await mkdir(path.join(dir, 'ide'), { recursive: true })
  await mkdir(path.join(dir, 'projects', 'encoded-alpha'), { recursive: true })

  await writeFile(
    path.join(dir, 'sessions', '100.json'),
    JSON.stringify({
      pid: 100, sessionId: 'sid-100', cwd: 'p:\\proj\\alpha',
      startedAt: 1, procStart: 'ps-100', name: 'alpha-01',
    }),
  )
  // Szemét, ami nem session fájl — nem szabad elszállni rajta.
  await writeFile(path.join(dir, 'sessions', '100.abc123'), JSON.stringify({ peerToken: 'x' }))
  await writeFile(path.join(dir, 'sessions', 'broken.json'), '{ not json')

  await writeFile(
    path.join(dir, 'ide', '50269.lock'),
    JSON.stringify({ pid: 900, workspaceFolders: ['p:\\proj\\alpha'], transport: 'ws' }),
  )

  await writeFile(
    path.join(dir, 'projects', 'encoded-alpha', 'sid-100.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-04T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    }) + '\n',
  )
  return dir
}

describe('scanSessions', () => {
  it('finds live sessions, pairs windows, and reads activity', async () => {
    const dir = await fixture()
    const { sessions, activities } = await scanSessions(dir, aliveProbe)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.record.sessionId).toBe('sid-100')
    expect(sessions[0]!.window?.pid).toBe(900)
    expect(activities.get('sid-100')?.runningTool).toBe('Bash')
  })

  it('returns nothing when no process is alive', async () => {
    const dir = await fixture()
    const { sessions } = await scanSessions(dir, deadProbe)
    expect(sessions).toEqual([])
  })

  it('survives a missing claude directory', async () => {
    const { sessions, activities } = await scanSessions(
      path.join(tmpdir(), 'cs-does-not-exist'),
      aliveProbe,
    )
    expect(sessions).toEqual([])
    expect(activities.size).toBe(0)
  })

  it('derives the lock port from the filename', async () => {
    const dir = await fixture()
    const { sessions } = await scanSessions(dir, aliveProbe)
    expect(sessions[0]!.window?.port).toBe(50269)
  })

  it('still returns the session when its transcript is not a readable file', async () => {
    // Figyelem: ez a `findTranscriptPath` isFile() védőágán megy át, nem a
    // scanner catch blokkján — az utóbbi védelem mélységben, és nincs rá
    // platformfüggetlen kiváltó. Amit ez bizonyít, az önmagában is fontos: egy
    // hiányzó vagy hibás transcript nem tünteti el a sessiont a listáról.
    const dir = await fixture()
    const projectDir = path.join(dir, 'projects', 'encoded-alpha')
    await rm(path.join(projectDir, 'sid-100.jsonl'))
    await mkdir(path.join(projectDir, 'sid-100.jsonl'))

    const { sessions, activities } = await scanSessions(dir, aliveProbe)
    expect(sessions).toHaveLength(1)
    expect(activities.get('sid-100')).toEqual({})
  })
})
```

- [ ] **Step 5: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/daemon test scanner`
Expected: FAIL — `Failed to resolve import "./scanner.js"`

- [ ] **Step 6: Írd meg a scannert**

`packages/daemon/src/scanner.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type LiveSession,
  type ProcessProbe,
  type SessionActivity,
  type SessionRecord,
  type IdeLock,
  findTranscriptPath,
  ideDir,
  parseIdeLock,
  parseSessionRecord,
  readActivityFromLines,
  resolveLiveSessions,
  sessionsDir,
  tailLines,
} from '@claudeswitcher/core'

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readRecords(claudeDir: string): Promise<SessionRecord[]> {
  const dir = sessionsDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.json'))
  const records = await Promise.all(
    names.map(async (name) => parseSessionRecord(await readJson(path.join(dir, name)))),
  )
  return records.filter((r): r is SessionRecord => r !== null)
}

async function readLocks(claudeDir: string): Promise<IdeLock[]> {
  const dir = ideDir(claudeDir)
  const names = (await listDir(dir)).filter((n) => n.endsWith('.lock'))
  const locks = await Promise.all(
    names.map(async (name) => {
      const port = Number.parseInt(path.basename(name, '.lock'), 10)
      if (Number.isNaN(port)) return null
      return parseIdeLock(await readJson(path.join(dir, name)), port)
    }),
  )
  return locks.filter((l): l is IdeLock => l !== null)
}

/** Egy teljes állapot-pillanatkép: élő sessionök, párosított ablakok, aktivitás. */
export async function scanSessions(
  claudeDir: string,
  probe: ProcessProbe,
): Promise<{ sessions: LiveSession[]; activities: Map<string, SessionActivity> }> {
  const [records, locks] = await Promise.all([readRecords(claudeDir), readLocks(claudeDir)])
  const sessions = resolveLiveSessions(records, locks, probe)

  const entries = await Promise.all(
    sessions.map(async ({ record }): Promise<[string, SessionActivity]> => {
      try {
        const transcript = await findTranscriptPath(claudeDir, record.sessionId)
        if (transcript === undefined) return [record.sessionId, {}]
        return [record.sessionId, readActivityFromLines(await tailLines(transcript))]
      } catch (error) {
        // Védelem mélységben. A `Promise.all` egyetlen elutasításra eldobná az
        // egész szkennelést, vagyis MINDEN session eltűnne a listáról egy
        // olvashatatlan transcript miatt. A hívottak már best-effortok; ez arra
        // véd, ha egy későbbi módosítás behoz ide valami dobni képeset.
        console.error(`[scan] activity read failed for ${record.sessionId}`, error)
        return [record.sessionId, {}]
      }
    }),
  )

  return { sessions, activities: new Map(entries) }
}
```

- [ ] **Step 7: Futtasd az összes daemon tesztet**

Run: `pnpm --filter @claudeswitcher/daemon test`
Expected: PASS, minden teszt.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/rate-limits.ts packages/daemon/src/rate-limits.test.ts packages/daemon/src/scanner.ts packages/daemon/src/scanner.test.ts
git commit -m "feat(daemon): rate limit store and filesystem session scanner"
```

---

### Task 9: daemon — WS hub és összeszerelés

**Files:**
- Create: `packages/daemon/src/hub.ts`, `packages/daemon/src/daemon.ts`
- Test: `packages/daemon/src/daemon.test.ts`

**Interfaces:**
- Consumes: minden korábbi daemon modul
- Produces:
  - `interface DaemonState { sessions: SessionView[]; rateLimits: RateLimits }`
  - `interface Daemon { readonly port: number; readonly token: string; state(): DaemonState; refresh(): Promise<void>; stop(): Promise<void> }`
  - `class Hub` with `broadcastRaw(message: string): void` and `close(): Promise<void>`
  - `startDaemon(options: { claudeDir: string; probe: ProcessProbe; pollMs?: number }): Promise<Daemon>`

- [ ] **Step 1: Írd meg a failing tesztet**

`packages/daemon/src/daemon.test.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProcessProbe } from '@claudeswitcher/core'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startDaemon, type Daemon } from './daemon.js'

const aliveProbe: ProcessProbe = { isAlive: () => true, imageName: () => 'Code' }
let running: Daemon | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cs-daemon-'))
  await mkdir(path.join(dir, 'sessions'), { recursive: true })
  await writeFile(
    path.join(dir, 'sessions', '100.json'),
    JSON.stringify({
      pid: 100, sessionId: 'sid-100', cwd: 'p:\\proj\\alpha',
      startedAt: 1, procStart: 'ps-100', name: 'alpha-01',
    }),
  )
  return dir
}

describe('startDaemon', () => {
  it('binds to loopback on an ephemeral port and exposes a token', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    expect(running.port).toBeGreaterThan(0)
    expect(running.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('serves the scanned sessions', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    await running.refresh()
    expect(running.state().sessions.map((s) => s.sessionId)).toEqual(['sid-100'])
  })

  it('marks a session waiting when a notification hook posts', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    await running.refresh()

    const res = await fetch(`http://127.0.0.1:${running.port}/hooks/notification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${running.token}` },
      body: JSON.stringify({
        session_id: 'sid-100',
        cwd: 'p:\\proj\\alpha',
        notification_type: 'permission_prompt',
        notification_text: 'run pnpm test?',
      }),
    })
    expect(res.status).toBe(200)
    expect(running.state().sessions[0]!.status).toBe('waiting')
  })

  it('rejects an unauthenticated hook post', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const res = await fetch(`http://127.0.0.1:${running.port}/hooks/notification`, {
      method: 'POST', body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('accepts a websocket connection carrying the right token', async () => {
    // Pozitív kontroll. Enélkül a két elutasítós teszt akkor is átmenne, ha a
    // kapcsolat valami tőlünk független okból hiúsulna meg.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${running.token}`)

    await new Promise((resolve) => socket.on('open', resolve))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it('closes a websocket connection presenting the wrong token', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=wrong`)
    const messages: string[] = []
    socket.on('message', (data) => messages.push(String(data)))

    const code = await new Promise<number>((resolve) => socket.on('close', resolve))
    expect(code).toBe(1008)
    expect(messages).toHaveLength(0)
  })

  it('closes a websocket connection presenting no token', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws`)

    const code = await new Promise<number>((resolve) => socket.on('close', resolve))
    expect(code).toBe(1008)
  })

  it('does not re-broadcast an unchanged state', async () => {
    // A poll másodpercenként fut; azonos pillanatképet nem küldünk újra.
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    await running.refresh()

    const socket = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${running.token}`)
    const messages: string[] = []
    socket.on('message', (data) => messages.push(String(data)))
    await new Promise((resolve) => socket.on('open', resolve))

    await running.refresh()
    await running.refresh()
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.close()

    expect(messages).toHaveLength(0)
  })

  it('stores rate limits posted by the status line', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    await fetch(`http://127.0.0.1:${running.port}/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${running.token}` },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: resetsAt } } }),
    })
    expect(running.state().rateLimits.five_hour?.used_percentage).toBe(23.5)
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/daemon test daemon`
Expected: FAIL — `Failed to resolve import "./daemon.js"`

- [ ] **Step 3: Írd meg a hubot**

`packages/daemon/src/hub.ts`:
```ts
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

/** Broadcast-only WS hub: a kliensek (overlay) csak fogadnak, nem küldenek. */
export class Hub {
  #wss: WebSocketServer
  #clients = new Set<WebSocket>()

  constructor(server: Server, private readonly token: string) {
    this.#wss = new WebSocketServer({ server, path: '/ws' })
    this.#wss.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') !== this.token) {
        socket.close(1008, 'unauthorized')
        return
      }
      this.#clients.add(socket)
      socket.on('close', () => this.#clients.delete(socket))
      socket.on('error', () => this.#clients.delete(socket))
    })
  }

  /**
   * Már szerializált üzenetet küld.
   *
   * Szándékosan nincs `broadcast(payload: unknown)` kényelmi változat: a daemon
   * maga szerializál, hogy az azonos pillanatképeket ki tudja szűrni, tehát egy
   * ilyen metódusnak nem lenne hívója. Egy hívó nélküli, teszteletlen második
   * belépési pont rosszabb, mint a hiánya — ha később kell, egy sor visszatenni.
   */
  broadcastRaw(message: string): void {
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(message)
        } catch (error) {
          console.error('[hub] send failed', error)
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.terminate()
    this.#clients.clear()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
  }
}
```

- [ ] **Step 4: Írd meg a daemon összeszerelést**

`packages/daemon/src/daemon.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import type { ProcessProbe, RateLimits, SessionView } from '@claudeswitcher/core'
import { createHookApp } from './hook-server.js'
import { Hub } from './hub.js'
import { RateLimitStore } from './rate-limits.js'
import { scanSessions } from './scanner.js'
import { SessionStore } from './session-store.js'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
}

export interface Daemon {
  readonly port: number
  readonly token: string
  state(): DaemonState
  refresh(): Promise<void>
  stop(): Promise<void>
}

export interface DaemonOptions {
  claudeDir: string
  probe: ProcessProbe
  /** Poll periódus ms-ben. 0 kikapcsolja (tesztekhez). */
  pollMs?: number
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { claudeDir, probe, pollMs = 3000 } = options
  const token = randomBytes(16).toString('hex')

  const sessions = new SessionStore()
  const limits = new RateLimitStore()

  const app = createHookApp(token, {
    onNotification: (event) => sessions.applyNotification(event),
    onLifecycle: (event) => {
      sessions.applyLifecycle(event)
      void refresh()
    },
    onRateLimits: (received) => {
      limits.update(received)
      broadcast()
    },
  })

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port
  // A @hono/node-server `serve()` egy node:http Servert ad vissza a
  // default (nem HTTP/2) konfigurációval; a WS hub ezen osztozik.
  const hub = new Hub(server as HttpServer, token)

  function state(): DaemonState {
    return { sessions: sessions.views(), rateLimits: limits.current() }
  }

  // A SessionStore minden `apply*` híváskor jelez, akkor is, ha az állapot nem
  // változott — a másodperces poll így percenként hússzor küldene azonos
  // pillanatképet. A szűrés szándékosan itt van, nem a store-ban: a store dolga
  // annyi, hogy „történt valami", a hubé, hogy mit érdemes elküldeni. A
  // szerializált alak összehasonlítása pontos, ellentétben egy mezőnkénti
  // diffel, amit el lehet rontani.
  let lastBroadcast = ''
  function broadcast(): void {
    const message = JSON.stringify({ type: 'state', payload: state() })
    if (message === lastBroadcast) return
    lastBroadcast = message
    hub.broadcastRaw(message)
  }

  sessions.onChange(broadcast)

  let refreshing: Promise<void> | undefined
  async function refresh(): Promise<void> {
    // Egyszerre csak egy szkennelés fusson; a fájlfigyelő sűrűn tüzelhet.
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      try {
        const snapshot = await scanSessions(claudeDir, probe)
        sessions.applySnapshot(snapshot.sessions, snapshot.activities)
      } catch (error) {
        console.error('[daemon] refresh failed', error)
      } finally {
        refreshing = undefined
      }
    })()
    return refreshing
  }

  const timer = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : undefined
  timer?.unref()

  return {
    port,
    token,
    state,
    refresh,
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      // Megvárjuk a futó szkennelést: leállás után ne maradjon dolgozó ígéret,
      // ami a processzt életben tartja vagy egy már lezárt hubba írna.
      await refreshing?.catch(() => undefined)
      await hub.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
```

- [ ] **Step 5: Futtasd az összes daemon tesztet**

Run: `pnpm --filter @claudeswitcher/daemon test`
Expected: PASS, minden teszt.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/hub.ts packages/daemon/src/daemon.ts packages/daemon/src/daemon.test.ts
git commit -m "feat(daemon): websocket hub and daemon assembly with polling refresh"
```

---

### Task 10: statusLine script

**Files:**
- Create: `packages/statusline/package.json`, `packages/statusline/tsconfig.json`, `packages/statusline/vitest.config.ts`
- Create: `packages/statusline/src/render.ts`, `packages/statusline/src/main.ts`
- Test: `packages/statusline/src/render.test.ts`

**Interfaces:**
- Consumes: `RateLimits` (core)
- Produces:
  - `renderStatusLine(input: Record<string, unknown>): string`
  - futtatható script: stdin JSON → POST a daemonnak → egy sor a stdoutra

- [ ] **Step 1: Csomagváz**

`packages/statusline/package.json`:
```json
{
  "name": "@claudeswitcher/statusline",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "claudeswitcher-statusline": "./dist/main.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check-types": "tsc -p tsconfig.check.json --noEmit"
  },
  "devDependencies": { "@types/node": "^22.0.0" }
}
```

Szándékosan **nincs** `@claudeswitcher/core` függőség: ez a csomag nem importál
belőle semmit. A rate limit alakját a `renderStatusLine` a bemenetből olvassa ki
saját típusvizsgálattal, mert a Claude Code stdin JSON-ja amúgy sem a mi
típusunk. Ha később mégis kell, egy sor visszatenni.

`packages/statusline/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/statusline/tsconfig.check.json`:
```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*"],
  "exclude": []
}
```

`packages/statusline/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 2: Írd meg a failing tesztet**

A statusLine látható a TUI-ban, és a bevezetése elrejti a footer hintjeit — ezért hasznosat kell mutatnia, nem csak némán posztolnia.

`packages/statusline/src/render.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { renderStatusLine } from './render.js'

const base = {
  model: { display_name: 'Opus 5' },
  workspace: { current_dir: 'p:\\proj\\alpha' },
}

describe('renderStatusLine', () => {
  it('shows model and directory', () => {
    const line = renderStatusLine(base)
    expect(line).toContain('Opus 5')
    expect(line).toContain('alpha')
  })

  it('shows the five hour and seven day usage when present', () => {
    const line = renderStatusLine({
      ...base,
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1 },
        seven_day: { used_percentage: 41.2, resets_at: 1 },
      },
    })
    expect(line).toContain('5h 24%')
    expect(line).toContain('7d 41%')
  })

  it('omits a window that is absent', () => {
    const line = renderStatusLine({
      ...base,
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } },
    })
    expect(line).toContain('5h 10%')
    expect(line).not.toContain('7d')
  })

  it('renders without rate limits at all', () => {
    expect(() => renderStatusLine(base)).not.toThrow()
    expect(renderStatusLine(base)).not.toContain('5h')
  })

  it('survives a completely empty input', () => {
    expect(() => renderStatusLine({})).not.toThrow()
  })

  it('shows the git branch when present', () => {
    const line = renderStatusLine({ ...base, workspace: { current_dir: 'p:\\a', branch: 'main' } })
    expect(line).toContain('main')
  })
})
```

- [ ] **Step 3: Futtasd, hogy lásd a hibát**

Run: `pnpm --filter @claudeswitcher/statusline test`
Expected: FAIL — `Failed to resolve import "./render.js"`

- [ ] **Step 4: Írd meg a rendert**

`packages/statusline/src/render.ts`:
```ts
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pct(source: unknown): number | undefined {
  if (!isRecord(source)) return undefined
  const value = source.used_percentage
  return typeof value === 'number' ? Math.round(value) : undefined
}

export function renderStatusLine(input: Record<string, unknown>): string {
  const parts: string[] = []

  const model = isRecord(input.model) ? input.model.display_name : undefined
  if (typeof model === 'string') parts.push(model)

  const workspace = isRecord(input.workspace) ? input.workspace : {}
  const dir = workspace.current_dir
  if (typeof dir === 'string') {
    const name = dir.split(/[\\/]/).filter((s) => s !== '').pop()
    if (name !== undefined) parts.push(name)
  }
  if (typeof workspace.branch === 'string') parts.push(workspace.branch)

  const limits = isRecord(input.rate_limits) ? input.rate_limits : {}
  const fiveHour = pct(limits.five_hour)
  const sevenDay = pct(limits.seven_day)
  if (fiveHour !== undefined) parts.push(`5h ${fiveHour}%`)
  if (sevenDay !== undefined) parts.push(`7d ${sevenDay}%`)

  return parts.join('  ·  ')
}
```

- [ ] **Step 5: Írd meg az entry pointot**

`packages/statusline/src/main.ts`:
```ts
#!/usr/bin/env node
import { renderStatusLine } from './render.js'

/** Ennyit várunk a stdin lezárására, mielőtt üres bemenettel renderelünk. */
const STDIN_TIMEOUT_MS = 500

/**
 * Kiolvassa a streamet, de feladja `timeoutMs` után.
 *
 * Enélkül egy le nem zárt stdin örökre megállítaná a ciklust, és a statusLine
 * **semmit** nem írna ki — pont az a veszteség, ami ellen ez a csomag létezik.
 * A streamet paraméterként veszi át, mert így a feladási ág tesztelhető anélkül,
 * hogy a processz stdinjével kellene trükközni.
 */
export async function readAllOrGiveUp(
  stream: AsyncIterable<Buffer> & { destroy(): void },
  timeoutMs: number = STDIN_TIMEOUT_MS,
): Promise<string> {
  const read = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  })().catch(() => '')

  let timer: NodeJS.Timeout | undefined
  const giveUp = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      // A stream lezárása nélkül a processz a kiírás után is életben maradna.
      stream.destroy()
      resolve('')
    }, timeoutMs)
    timer.unref()
  })

  try {
    return await Promise.race([read, giveUp])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A Claude Code stdin-en adja a session JSON-t, és a stdoutot rendereli a
 * statusLine-ban. Mellékhatásként a rate limiteket elküldjük a daemonnak.
 * A POST soha nem blokkolhatja a sor kiírását: rövid timeout, hiba elnyelve.
 */
async function main(): Promise<void> {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readAllOrGiveUp(process.stdin))
    if (typeof parsed === 'object' && parsed !== null) {
      input = parsed as Record<string, unknown>
    }
  } catch {
    // Nincs értelmes bemenet — üres sort adunk, de nem hibázunk.
  }

  // Védőháló a renderelés köré is. Ma egyetlen bemenet sem dobat vele, de egy
  // későbbi módosítás elronthatná, és egy elkapatlan kivétel itt nulla kimenetet
  // ÉS nem-nulla kilépési kódot jelentene — a legrosszabb kimenet ebben a
  // scriptben, mert a felhasználó saját footerét rontaná el.
  let line = ''
  try {
    line = renderStatusLine(input)
  } catch {
    line = ''
  }
  process.stdout.write(line)

  const port = process.env.CLAUDESWITCHER_PORT
  const token = process.env.CLAUDESWITCHER_TOKEN
  if (port !== undefined && token !== undefined && input.rate_limits !== undefined) {
    try {
      await fetch(`http://127.0.0.1:${port}/statusline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ rate_limits: input.rate_limits }),
        signal: AbortSignal.timeout(1000),
      })
    } catch {
      // A daemon nem fut. A statusLine attól még helyes.
    }
  }
}

await main()
```

- [ ] **Step 5b: Írd meg a stdin-feladás tesztjét**

`packages/statusline/src/main.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { readAllOrGiveUp } from './main.js'

/** Stream, ami sosem ér véget, amíg le nem zárják. */
function neverEnding(): AsyncIterable<Buffer> & { destroy(): void } {
  let destroyed = false
  return {
    destroy() {
      destroyed = true
    },
    async *[Symbol.asyncIterator]() {
      while (!destroyed) await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

function finite(chunks: string[]): AsyncIterable<Buffer> & { destroy(): void } {
  return {
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk, 'utf8')
    },
  }
}

describe('readAllOrGiveUp', () => {
  it('returns everything a finite stream delivered', async () => {
    expect(await readAllOrGiveUp(finite(['{"a"', ':1}']), 1000)).toBe('{"a":1}')
  })

  it('gives up and returns empty when the stream never ends', async () => {
    expect(await readAllOrGiveUp(neverEnding(), 20)).toBe('')
  })

  it('destroys the stream when it gives up, so the process can exit', async () => {
    const stream = neverEnding()
    let destroyed = false
    const original = stream.destroy.bind(stream)
    stream.destroy = () => {
      destroyed = true
      original()
    }

    await readAllOrGiveUp(stream, 20)
    expect(destroyed).toBe(true)
  })
})
```

- [ ] **Step 6: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/statusline test`
Expected: PASS, 9 teszt (6 a `render`-re, 3 a `readAllOrGiveUp`-ra).

- [ ] **Step 7: Commit**

```bash
git add packages/statusline
git commit -m "feat(statusline): status line renderer that reports rate limits to the daemon"
```

---

### Task 11: desktop — Electron váz és daemon hosztolás

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`, `apps/desktop/src/renderer/main.tsx`

**Interfaces:**
- Consumes: `startDaemon`, `Daemon`, `DaemonState` (Task 9); `createWin32ProcessProbe`, `resolveClaudeDir` (core)
- Produces: futtatható Electron app, ami elindítja a daemont és megnyit egy ablakot

- [ ] **Step 1: Csomagváz**

`apps/desktop/package.json`:
```json
{
  "name": "@claudeswitcher/desktop",
  "version": "0.0.0",
  "private": true,
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "start": "electron-vite preview",
    "build": "electron-vite build",
    "check-types": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@claudeswitcher/core": "workspace:*",
    "@claudeswitcher/daemon": "workspace:*",
    "koffi": "^2.10.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^33.0.0",
    "electron-vite": "^2.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

`apps/desktop/electron.vite.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * A főprocessz CommonJS, és ez nem opcionális: az Electron 33 Node 20-at hoz, ahol a
 * CJS `require()` nem tud ES modult betölteni. A saját workspace csomagjaink viszont
 * ESM-only-k, ezért egy externalizált `require("@claudeswitcher/core")` induláskor
 * `ERR_REQUIRE_ESM`-mel hal meg. Ezt valódi Electron főprocesszben mértük le.
 *
 * Megoldás: a workspace csomagokat kizárjuk az externalizálásból, így beépülnek a
 * bundle-be, a tranzitív függőségeikkel (hono, ws, chokidar) együtt — azok nem
 * szerepelnek ennek az appnak a `dependencies`-ében, tehát nem externalizálódnak.
 *
 * Az ESM főprocessz nem járható alternatíva: az Electron 33 ESM-loadere elhasal, ha
 * egy ESM main CJS függőséget tölt be. Ezt is lemértük.
 */
const BUNDLED_WORKSPACE_PACKAGES = ['@claudeswitcher/core', '@claudeswitcher/daemon']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES })],
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] },
})
```

- [ ] **Step 2: Írd meg a main processzt**

`apps/desktop/src/main/index.ts`:
```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWin32ProcessProbe, resolveClaudeDir } from '@claudeswitcher/core'
import { startDaemon, type Daemon } from '@claudeswitcher/daemon'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'

const dirname = path.dirname(fileURLToPath(import.meta.url))

let daemon: Daemon | undefined
let overlay: BrowserWindow | undefined

function createOverlay(): BrowserWindow {
  const window = new BrowserWindow({
    width: 620,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(dirname, '../preload/index.js'),
      // Ezek az Electron 33 alapértelmezései. Szándékosan kiírjuk őket: így a
      // biztonsági állás önmagát dokumentálja, és egy jövőbeli Electron-verzió
      // megváltozott alapértéke sem tudja csendben meggyengíteni. A preload csak
      // contextBridge-et és ipcRenderer-t használ, ami sandboxban is működik.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  window.on('blur', () => window.hide())
  return window
}

app.whenReady().then(async () => {
  daemon = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: createWin32ProcessProbe(),
  })
  await daemon.refresh()

  ipcMain.handle('daemon:connection', () => ({ port: daemon!.port, token: daemon!.token }))
  ipcMain.handle('daemon:state', () => daemon!.state())

  // Indulási összegzés a főprocessz stdoutjára. Ez teszi a Step 5 ellenőrzését
  // automatizálhatóvá: nem kell DevTools-konzolba gépelni ahhoz, hogy lássuk,
  // a daemon elindult és tényleg megtalálta a futó sessionöket.
  console.log(
    `[claudeswitcher] daemon on 127.0.0.1:${daemon.port}, ` +
      `${daemon.state().sessions.length} session(s) discovered`,
  )

  overlay = createOverlay()
  overlay.showInactive()
}).catch((error: unknown) => {
  // Tálcaikonos app: ha az indulás elbukik — tipikusan a daemon —, nincs ablak és
  // nincs tálcaikon, a processz csendben halott maradna, a felhasználó pedig csak
  // azt látná, hogy „nem csinál semmit". A showErrorBox szinkron és ablak nélkül
  // is működik, tehát ez az egyetlen hely, ahol a hiba biztosan eljut hozzá.
  console.error('[claudeswitcher] startup failed', error)
  dialog.showErrorBox(
    'A ClaudeSwitcher nem tudott elindulni',
    error instanceof Error ? error.message : String(error),
  )
  app.quit()
})

app.on('window-all-closed', () => {
  // Tálcaikonos app: az ablak bezárása nem lépteti ki.
})

app.on('before-quit', () => {
  void daemon?.stop()
})
```

- [ ] **Step 3: Írd meg a preloadot**

`apps/desktop/src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron'

export interface DaemonConnection {
  port: number
  token: string
}

contextBridge.exposeInMainWorld('claudeswitcher', {
  connection: (): Promise<DaemonConnection> => ipcRenderer.invoke('daemon:connection'),
  state: (): Promise<unknown> => ipcRenderer.invoke('daemon:state'),
  focusSession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:focus', sessionId),
  hide: (): Promise<void> => ipcRenderer.invoke('overlay:hide'),
})
```

- [ ] **Step 4: Minimál renderer**

`apps/desktop/src/renderer/index.html`:
```html
<!doctype html>
<html lang="hu">
  <head>
    <meta charset="utf-8" />
    <title>ClaudeSwitcher</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/main.tsx`:
```tsx
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'

function App(): JSX.Element {
  return <div>ClaudeSwitcher</div>
}

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 5: Kézi ellenőrzés**

A `desktop` a `core`-t és a `daemon`-t a lefordított `dist/`-en át éri el.

Először a fordítás:

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop build`
Expected: mindkettő hibátlan, és létrejön az `apps/desktop/out/main/index.js`.

Aztán egy **korlátos** futtatás. Az Electron nem lép ki magától, ezért elindítjuk,
hagyunk neki időt, elmentjük a kimenetét, és megöljük. Három részlet mind mért
hibán alapul, egyik sem elhagyható:

- **Az `electron.exe`-t közvetlenül indítjuk**, nem a `pnpm`-en át: a `pnpm` egy
  `.cmd`/`.ps1` shim, amit a `Start-Process` nem tud futtatni ("not a valid Win32
  application"). Az izolált pnpm linker miatt az `apps/desktop/node_modules` alatt van.
- **Az `ELECTRON_RUN_AS_NODE` változót töröljük.** A VSCode maga is Electron, és
  ezt a változót örökíti minden gyerekfolyamatra — így a Claude Code-ra és minden
  általa indított parancsra is. Beállítva az `electron.exe` sima Node-ként fut, a
  `require("electron")` az npm csomag útvonal-stringjét adja vissza, és az app
  `Cannot read properties of undefined (reading 'whenReady')`-del hal meg.
- **`$ErrorActionPreference = 'Continue'`**, nem `SilentlyContinue` — utóbbi elnyeli
  a hibás útvonalat, és a két log üresen marad magyarázat nélkül.

```powershell
Set-Location apps\desktop
$exe = 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "electron.exe not found at $exe" }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $exe -ArgumentList '.' -PassThru -NoNewWindow `
  -RedirectStandardOutput out.log -RedirectStandardError err.log
Start-Sleep -Seconds 20
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Content out.log, err.log
```

A stderr-ben megjelenő `Electron Security Warning (Insecure Content-Security-Policy)`
fejlesztői figyelmeztetés, nem hiba — maga írja, hogy csomagolt appban nem jelenik
meg. A Task 14 CSP-t ad a rendererhez.

Expected: az `out.log` tartalmaz egy sort `[claudeswitcher] daemon on 127.0.0.1:<port>,
N session(s) discovered` formában, ahol **N a gépen épp futó Claude Code sessionök
száma** — ha nulla, miközben futnak sessionök, a felderítés nem működik, és ezt
jelezni kell, nem továbbmenni. Az `err.log`-ban nincs stack trace.

Egy keret nélküli ablak rövid időre megjelenik a képernyőn; ez várható.

Ehhez a `apps/desktop/package.json` kap egy `"start": "electron-vite preview"`
scriptet a `dev` mellé.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): electron shell hosting the daemon in the main process"
```

---

### Task 12: desktop — ablakfókusz

**Files:**
- Create: `apps/desktop/src/main/focus-window.ts`
- Create: `apps/desktop/vitest.config.ts` (az `apps/desktop` első tesztje ez)
- Test: `apps/desktop/src/main/focus-window.test.ts`
- Modify: `apps/desktop/src/main/index.ts` — az `ipcMain.handle('session:focus', …)` regisztrálása
- Modify: `apps/desktop/package.json` — `"test": "vitest run"` script

**Interfaces:**
- Consumes: `SessionView` (core)
- Produces:
  - `focusSessionWindow(view: SessionView): Promise<boolean>`
  - `findMainWindow(targetPid: number): number` — exportálva, hogy tesztelhető legyen
  - `foregroundWindow(): number` — csak olvas; a fókuszváltás ellenőrzéséhez
  - `isSafeForCli(folder: string): boolean` — a `code -r` tartalék védőfeltétele
  - `quoteForCli(folder: string): string` — CRT-helyes idézés a `code -r`-hez
  - `isFastFocusAvailable(): boolean` — a lusta koffi-betöltés eredménye

**Mit NEM ellenőriz ez a task, és miért.** A valódi ablakváltást egy háttérben futó
ágens nem végezheti el: elrántaná a fókuszt a felhasználó elől, és ha épp gépel, a
billentyűi egy másik ablakba — akár egy Claude Code chatbe — kerülnének. Ezt a
felhasználó ellenőrzi a Task 15 elfogadási tesztjében. Ez a task azt méri, ami
ablakváltás nélkül mérhető, és ami a legkockázatosabb: hogy a `koffi` kötések egyáltalán
betöltődnek és helyes típusokat adnak, és hogy az ablakkereső ciklus leáll.

- [ ] **Step 1: Írd meg a fókuszmodult**

A `windowPid` a lock fájlból származó VSCode ablak processze. Ez a gyors út.
Ha nincs (elárvult vagy hiányzó lock), a `code -r` a tartalék, ami lassabb, de
a workspace útvonalból is megtalálja az ablakot.

`apps/desktop/src/main/focus-window.ts`:
```ts
import { exec } from 'node:child_process'
import { createRequire } from 'node:module'
import type { SessionView } from '@claudeswitcher/core'

// Nem `require`-nek nevezzük: a CJS bundle modulburkolójában a `require` már
// paraméterként létezik, és egy azonos nevű `const` ütközne vele.
const requireNative = createRequire(import.meta.url)

const SW_RESTORE = 9
const GW_HWNDNEXT = 2

interface User32 {
  GetTopWindow(hWnd: number): number
  GetWindow(hWnd: number, uCmd: number): number
  GetWindowThreadProcessId(hWnd: number, pid: [number]): number
  IsWindowVisible(hWnd: number): number
  GetWindowTextLengthW(hWnd: number): number
  GetForegroundWindow(): number
  SetForegroundWindow(hWnd: number): number
  ShowWindow(hWnd: number, nCmdShow: number): number
}

/** `undefined`: még nem próbáltuk. `null`: a betöltés elbukott. */
let user32: User32 | null | undefined

/**
 * Lustán tölti be a user32 kötéseket, és egy hibát elnyel.
 *
 * Szándékosan nem modulszinten: a `focus-window.ts`-t az `index.ts` importálja még az
 * `app.whenReady()` előtt, így egy modulszintű koffi-hiba az indulási hibadialógus
 * bekötése ELŐTT dobna — és az app dialógus nélkül, csendben halna meg. Így egy
 * elérhetetlen natív modul csak a gyors fókuszutat kapcsolja ki; a `code -r` tartalék
 * tovább működik.
 */
function loadUser32(): User32 | null {
  if (user32 !== undefined) return user32
  try {
    const koffi = requireNative('koffi') as typeof import('koffi')
    const lib = koffi.load('user32.dll')
    user32 = {
      GetTopWindow: lib.func('intptr GetTopWindow(intptr hWnd)'),
      GetWindow: lib.func('intptr GetWindow(intptr hWnd, uint32 uCmd)'),
      GetWindowThreadProcessId: lib.func(
        'uint32 GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *pid)',
      ),
      // A Win32 BOOL egy 4 bájtos int, nem az 1 bájtos C bool.
      IsWindowVisible: lib.func('int IsWindowVisible(intptr hWnd)'),
      GetWindowTextLengthW: lib.func('int GetWindowTextLengthW(intptr hWnd)'),
      GetForegroundWindow: lib.func('intptr GetForegroundWindow()'),
      SetForegroundWindow: lib.func('int SetForegroundWindow(intptr hWnd)'),
      ShowWindow: lib.func('int ShowWindow(intptr hWnd, int nCmdShow)'),
    }
  } catch (error) {
    console.error('[focus] user32 bindings unavailable; falling back to code -r only', error)
    user32 = null
  }
  return user32
}

/**
 * Felső korlát a bejárt ablakok számára. Egy Windows asztalon jellemzően néhány száz
 * top-level ablak van. A korlát azt védi ki, hogy egy váratlan típus — például ha a
 * `koffi` az `intptr`-t BigInt-ként adná vissza, amitől a `hwnd !== 0` sosem lenne
 * hamis — végtelen ciklusba ejtse az Electron főprocesszt, ami az egész appot
 * lefagyasztaná.
 */
const MAX_WINDOWS_SCANNED = 10_000

/**
 * A megadott processz első látható, címmel rendelkező top-level ablaka, vagy 0.
 *
 * Szándékosan a GetTopWindow + GetWindow láncot járjuk be, nem az EnumWindows-t:
 * az EnumWindows callbacket vár, amit koffi-ban regisztrálni kell, és a
 * regisztrált callback élettartama Electron main processzben könnyen elszáll.
 * A lánc bejárása ugyanazt adja, csak sima skalár hívásokkal.
 */
export function findMainWindow(targetPid: number): number {
  const api = loadUser32()
  if (api === null) return 0

  const pidOut: [number] = [0]
  let hwnd = Number(api.GetTopWindow(0))

  for (let scanned = 0; hwnd !== 0 && scanned < MAX_WINDOWS_SCANNED; scanned++) {
    if (api.IsWindowVisible(hwnd) !== 0 && api.GetWindowTextLengthW(hwnd) > 0) {
      api.GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === targetPid) return hwnd
    }
    hwnd = Number(api.GetWindow(hwnd, GW_HWNDNEXT))
  }
  return 0
}

/**
 * Igaz, ha a gyors, pid-alapú fókuszút elérhető, azaz a user32 kötések betöltődtek.
 * Az indulási naplóhoz: a lusta betöltés miatt a `koffi` különben csak az első
 * fókuszkérésnél töltődne be, és addig semmi nem bizonyítaná, hogy az Electron
 * főprocesszben működik.
 */
export function isFastFocusAvailable(): boolean {
  return loadUser32() !== null
}

/** Az aktuálisan előtérben lévő ablak, vagy 0. Csak olvas, semmit nem hoz előre. */
export function foregroundWindow(): number {
  const api = loadUser32()
  return api === null ? 0 : Number(api.GetForegroundWindow())
}

function focusByPid(pid: number): boolean {
  const api = loadUser32()
  if (api === null) return false
  const hwnd = findMainWindow(pid)
  if (hwnd === 0) return false

  api.ShowWindow(hwnd, SW_RESTORE)
  api.SetForegroundWindow(hwnd)

  // A SetForegroundWindow visszatérési értéke nem megbízható. A Windows előtér-
  // zárolása mellett „sikert" jelenthet, miközben csak a tálcagombot villogtatja. Ha
  // ezt elhinnénk, a `code -r` tartalék sosem futna le, a felhasználó pedig azt
  // látná, hogy az overlay eltűnik, és semmi nem történik. Ezért megnézzük, mi
  // került ténylegesen előtérbe.
  return foregroundWindow() === hwnd
}

/**
 * Karakterek, amiket a cmd.exe idézőjelen belül is értelmez: a `%` környezeti
 * változóként bontódik ki, egy `"` pedig magát az idézést törné meg. Az `&`, `^`,
 * `|`, `<`, `>`, `(`, `)` idézőjelen belül ártalmatlan — ezt a review empirikusan
 * lemérte.
 */
const CMD_UNSAFE_IN_QUOTES = /[%"]/

/** Igaz, ha a mappa biztonságosan átadható a `code -r`-nek egy cmd.exe shellen át. */
export function isSafeForCli(folder: string): boolean {
  return !CMD_UNSAFE_IN_QUOTES.test(folder)
}

/**
 * Idézőjelbe tesz egy mappát úgy, hogy a Windows CRT argv-feldolgozója pontosan azt
 * adja vissza.
 *
 * A CRT a záró idézőjel előtti backslashokat escape-ként kezeli: N backslash és egy
 * `"` N/2 backslasht ad, páratlan N esetén pedig a `"`-t is literálisnak veszi. Egy
 * sima idézés mellett így egy `C:\` workspace `C:"`-ként érkezne, egy `\\server\share\`
 * elveszítené a lezárását, és egy `double\\` egy backslasht — vagyis a meghajtó- és
 * megosztásgyökér workspace-ek csendben rossz útvonalat kapnának. Mérve, nem
 * feltételezve: a sima idézés 7 esetből 4-ben rontotta el az útvonalat.
 *
 * A záró backslash-futam megduplázása ezt kiegyenlíti. Máshol a backslash literális, és
 * `"` a mappában nem fordulhat elő, mert az `isSafeForCli` kizárja.
 */
export function quoteForCli(folder: string): string {
  return `"${folder.replace(/(\\+)$/, '$1$1')}"`
}

function focusByCli(folder: string): Promise<boolean> {
  // Egy ilyen mappanévnél inkább nem próbálkozunk: a `%` kibontása csendben egy MÁSIK
  // útvonalat nyitna meg. Egy elmaradt fókusz jobb, mint egy rossz.
  if (!isSafeForCli(folder)) return Promise.resolve(false)

  // A `code` Windowson `code.cmd`, ezért kell a shell. A teljes parancsot egyetlen
  // stringként adjuk át, az idézést pedig a quoteForCli végzi, egy helyen és tesztelve.
  return new Promise((resolve) => {
    exec(`code -r ${quoteForCli(folder)}`, { windowsHide: true }, (error) => {
      resolve(error === null)
    })
  })
}

/**
 * Előtérbe hozza a session VSCode ablakát. Elsőként a lock fájlból ismert pid
 * alapján, mert az azonnali; ha az nem megy, a `code -r` a tartalék.
 */
export async function focusSessionWindow(view: SessionView): Promise<boolean> {
  if (view.windowPid !== undefined && focusByPid(view.windowPid)) return true
  const folder = view.workspaceFolder ?? view.cwd
  return focusByCli(folder)
}
```

- [ ] **Step 2: Kösd be az IPC handlert**

`apps/desktop/src/main/index.ts` — az `app.whenReady()` blokkba, a meglévő
`ipcMain.handle` hívások mellé:

```ts
  ipcMain.handle('session:focus', async (_event, sessionId: string) => {
    const view = daemon!.state().sessions.find((s) => s.sessionId === sessionId)
    if (view === undefined) return false
    // Előbb fókuszálunk, csak utána rejtjük el az overlayt. A Windows csak annak a
    // folyamatnak engedi a SetForegroundWindow-t, amelyik épp az előtérben van —
    // az overlay elrejtése ezt a jogot elvenné tőlünk, és a hívás csendben csak a
    // tálcagombot villogtatná. Ha így is elbukik, a `code -r` tartalék megoldja.
    const focused = await focusSessionWindow(view)
    overlay?.hide()
    return focused
  })

  ipcMain.handle('overlay:hide', () => {
    overlay?.hide()
  })
```

És a fájl tetejére: `import { focusSessionWindow, isFastFocusAvailable } from './focus-window.js'`

Valamint bővítsd a meglévő indulási naplósort, hogy a `koffi` betöltését induláskor
ténylegesen végrehajtsa és jelentse — csak olvas, ablakot nem hoz előre:

```ts
  console.log(
    `[claudeswitcher] daemon on 127.0.0.1:${daemon.port}, ` +
      `${daemon.state().sessions.length} session(s) discovered, ` +
      `fast focus ${isFastFocusAvailable() ? 'available' : 'UNAVAILABLE'}`,
  )
```

Enélkül a lusta betöltés miatt semmi nem bizonyítaná, hogy a `koffi` az Electron
főprocesszben is betöltődik — a Vitest a rendszer Node-ján fut, az Electron a sajátján.

- [ ] **Step 3: A koffi kötések tesztje**

Ez az `apps/desktop` első tesztje, ezért itt jön létre a Vitest beállítás is.

`apps/desktop/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
```

És az `apps/desktop/package.json` `scripts` blokkjába: `"test": "vitest run"`.

`apps/desktop/src/main/focus-window.test.ts`:
```ts
import { exec, execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  findMainWindow,
  foregroundWindow,
  isFastFocusAvailable,
  isSafeForCli,
  quoteForCli,
} from './focus-window.js'

const onWindows = process.platform === 'win32'

/** Egy futó, látható főablakkal rendelkező VSCode processz pidje, vagy undefined. */
function runningVSCodeWindowPid(): number | undefined {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process Code -ErrorAction SilentlyContinue | ' +
        'Where-Object { $_.MainWindowHandle -ne 0 } | ' +
        'Select-Object -First 1 -ExpandProperty Id',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  ).trim()
  const pid = Number.parseInt(out, 10)
  return Number.isNaN(pid) ? undefined : pid
}

describe('findMainWindow', () => {
  it.skipIf(!onWindows)('loads the koffi bindings and returns 0 for a pid owning no window', () => {
    // Bizonyítja, hogy a user32 kötések betöltődnek a deklarált szignatúrákkal, és
    // hogy a bejáró ciklus leáll. FIGYELEM: önmagában NEM bizonyítja, hogy a
    // GetWindowThreadProcessId kimeneti paramétere működik — ha a pid sosem íródna
    // ki, ez a teszt akkor is 0-t kapna és átmenne. Azt a harmadik teszt fedi.
    expect(findMainWindow(999_999_998)).toBe(0)
  })

  it.skipIf(!onWindows)('returns a plain number rather than a BigInt', () => {
    // Egy BigInt HWND-vel a `hwnd !== 0` sosem lenne hamis.
    expect(typeof findMainWindow(999_999_998)).toBe('number')
  })

  it.skipIf(!onWindows)('finds the main window of a running VSCode instance', (ctx) => {
    // Ez az a teszt, ami ténylegesen igazolja a kimeneti paramétert: nullánál
    // nagyobb értéket csak akkor kaphatunk, ha a GetWindowThreadProcessId kiírta a
    // pidet, és az egyezett. Ablakot NEM hoz előtérbe — csak megkeresi.
    const pid = runningVSCodeWindowPid()
    if (pid === undefined) {
      // Látható kihagyás, nem csendes átmenet: a futtatás kimenetében látszania kell.
      ctx.skip()
      return
    }
    expect(findMainWindow(pid)).toBeGreaterThan(0)
  })
})

describe('foregroundWindow', () => {
  it.skipIf(!onWindows)('reads the foreground handle through loaded bindings, without changing it', () => {
    // A focusByPid ezzel ellenőrzi, hogy a fókuszváltás ténylegesen megtörtént-e.
    // Az isFastFocusAvailable nélkül ez a teszt akkor is átmenne, ha a kötések el sem
    // töltődtek — a foregroundWindow ilyenkor 0-t ad, ami szintén véges szám. A
    // teszt csak olvas; nullánál nagyobb értéket nem követel, mert zárolt képernyőn
    // vagy fókuszváltás közben a Windows jogosan adhat 0-t.
    expect(isFastFocusAvailable()).toBe(true)
    const hwnd = foregroundWindow()
    expect(typeof hwnd).toBe('number')
    expect(Number.isFinite(hwnd)).toBe(true)
  })
})

describe('quoteForCli', () => {
  /** Átküldi az idézett tokent a valódi cmd.exe + CRT argv láncon, és visszaolvassa. */
  function roundTrip(folder: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        `node -e "process.stdout.write(process.argv[1])" ${quoteForCli(folder)}`,
        { windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
    })
  }

  it.skipIf(!onWindows)('survives the real CRT argv parser unchanged', async () => {
    // Nem a string alakját állítja, hanem hogy a valódi feldolgozó ugyanazt adja
    // vissza. A javítás előtti sima idézés ezek közül négyet elrontott.
    const folders = [
      'C:\\work\\normal-folder',
      'C:\\',
      'C:\\work\\trailing\\',
      'C:\\work\\double\\\\',
      '\\\\server\\share\\',
      'C:\\My Projects\\R&D (old)',
    ]
    for (const folder of folders) {
      expect(await roundTrip(folder)).toBe(folder)
    }
  })
})

describe('isSafeForCli', () => {
  it('accepts ordinary folders, including spaces, ampersands and parentheses', () => {
    expect(isSafeForCli('p:\\08_Apps\\ClaudeSwitcher')).toBe(true)
    expect(isSafeForCli('C:\\My Projects\\R&D (old)')).toBe(true)
  })

  it('rejects folders cmd.exe would reinterpret even inside quotes', () => {
    // A `%TEMP%` a review mérése szerint csendben egy MÁSIK útvonalra bontódik ki.
    expect(isSafeForCli('C:\\work\\%TEMP%')).toBe(false)
    expect(isSafeForCli('C:\\work\\a"b')).toBe(false)
  })
})
```

Run: `pnpm --filter @claudeswitcher/desktop test`
Expected: 7 teszt PASS. **A „finds the main window of a running VSCode instance"
tesztnek ténylegesen le kell futnia, nem kihagyva** — ezen a gépen fut VSCode. Ha a
kimenet `skipped`-et mutat rá, azt jelenteni kell: akkor a kimeneti paraméter
egyáltalán nincs igazolva.

- [ ] **Step 4: Build és típusellenőrzés**

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop build && pnpm --filter @claudeswitcher/desktop check-types`
Expected: mindhárom exit 0.

Ezután egy korlátos indítás a Task 11 Step 5 mintájára (az `ELECTRON_RUN_AS_NODE`
törlésével), ami azt igazolja, hogy a `koffi` **az Electron főprocesszben is**
betöltődik — nem csak a Vitest Node-jában. Egy natív modul, ami a tesztben működik,
az Electronban még elhasalhat. Expected: a `daemon on 127.0.0.1:<port>, N session(s)
discovered` sor megjelenik, és az `err.log`-ban nincs `koffi`-t említő hiba.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/focus-window.ts apps/desktop/src/main/focus-window.test.ts apps/desktop/src/main/index.ts apps/desktop/vitest.config.ts apps/desktop/package.json
git commit -m "feat(desktop): focus a session's VSCode window via Win32 with a code -r fallback"
```

---

### Task 13: desktop — tray, hotkey és overlay-viselkedés

**Files:**
- Create: `apps/desktop/src/main/tray.ts`, `apps/desktop/src/main/hotkey.ts`
- Create: `apps/desktop/resources/tray.png`, `apps/desktop/resources/tray-waiting.png`
- Test: `apps/desktop/src/main/tray-icons.test.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `Daemon` (Task 9)
- Produces:
  - `createTray(options: { onOpen(): void; onQuit(): void }): { setWaiting(count: number): void; destroy(): void }` — üres ikonnál dob
  - `registerHotkey(accelerator: string, handler: () => void): boolean`
  - `OVERLAY_HOTKEY: string` — a gyorsbillentyű egyetlen forrása

- [ ] **Step 1: Írd meg a tray modult**

Készítsd el a két tray ikont. Futtasd a repo gyökeréből:

```bash
node -e "
const z=require('zlib'),f=require('fs');
const png=(r,g,b)=>{const W=16,raw=Buffer.alloc(W*(W*4+1));
for(let y=0;y<W;y++){raw[y*(W*4+1)]=0;
for(let x=0;x<W;x++){const d=Math.hypot(x-7.5,y-7.5),a=d<6.5?255:0,o=y*(W*4+1)+1+x*4;
raw[o]=r;raw[o+1]=g;raw[o+2]=b;raw[o+3]=a;}}
const ck=(t,d)=>{const b=Buffer.concat([Buffer.from(t),d]),l=Buffer.alloc(4);l.writeUInt32BE(d.length);
const c=Buffer.alloc(4);c.writeUInt32BE(z.crc32?z.crc32(b):require('zlib').crc32(b));return Buffer.concat([l,b,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(W,4);ihdr[8]=8;ihdr[9]=6;
return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ck('IHDR',ihdr),ck('IDAT',z.deflateSync(raw)),ck('IEND',Buffer.alloc(0))]);};
f.mkdirSync('apps/desktop/resources',{recursive:true});
f.writeFileSync('apps/desktop/resources/tray.png',png(0x8a,0x88,0x80));
f.writeFileSync('apps/desktop/resources/tray-waiting.png',png(0xd9,0x77,0x57));
console.log('tray icons written');
"
```

Ha a Node verziód nem ismeri a `zlib.crc32`-t (Node 22 alatt), egyszerűbb két
16×16 PNG-t bármilyen képszerkesztővel elmenteni: `tray.png` szürke korong,
`tray-waiting.png` narancs korong. A méret és a szín az egyetlen követelmény.

`apps/desktop/src/main/tray.ts`:
```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Menu, Tray, nativeImage } from 'electron'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const resources = path.join(dirname, '../../resources')

export interface TrayHandle {
  setWaiting(count: number): void
  destroy(): void
}

/**
 * Betölt egy ikont, és hangosan elbukik, ha üres.
 *
 * A `nativeImage.createFromPath` hiányzó vagy hibás fájlnál NEM dob, hanem üres képet
 * ad vissza, és egy üres képpel létrehozott tálcaikon Windowson láthatatlan. Az app
 * így futna, a felhasználó pedig nem találná meg — csendes hiba egy olyan appban, aminek
 * a tálcaikon az egyetlen belépési pontja. A dobás az `app.whenReady()` hibakezelőjéhez
 * jut, ami hibadialógust mutat.
 */
function loadIcon(file: string): Electron.NativeImage {
  const iconPath = path.join(resources, file)
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`Tray icon missing or unreadable: ${iconPath}`)
  return image
}

export function createTray(options: { onOpen(): void; onQuit(): void }): TrayHandle {
  const idle = loadIcon('tray.png')
  const waiting = loadIcon('tray-waiting.png')

  const tray = new Tray(idle)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Megnyitás', click: options.onOpen },
      { type: 'separator' },
      { label: 'Kilépés', click: options.onQuit },
    ]),
  )
  tray.on('click', options.onOpen)

  let lastCount = -1
  return {
    setWaiting(count) {
      if (count === lastCount) return
      lastCount = count
      tray.setImage(count > 0 ? waiting : idle)
      tray.setToolTip(
        count > 0 ? `ClaudeSwitcher — ${count} session vár rád` : 'ClaudeSwitcher',
      )
    },
    destroy() {
      tray.destroy()
    },
  }
}
```

- [ ] **Step 2: Írd meg a hotkey modult**

`apps/desktop/src/main/hotkey.ts`:
```ts
import { globalShortcut } from 'electron'

/**
 * Az overlay globális gyorsbillentyűje. Egyetlen helyen, hogy egy sorral cserélhető
 * legyen.
 *
 * FIGYELEM: a `Control+Alt` Windowson azonos az `AltGr`-rel. Magyar és sok más európai
 * billentyűzetkiosztáson ez a kombináció globálisan elnyeli az `AltGr+Space`-t: ha
 * valaki `@`-t ír (`AltGr+V`), és még nyomva tartja az AltGr-t, amikor szóközt üt, az
 * overlay felugrik, a szóköz pedig elvész. A spec „pl."-ként említette, a felhasználó
 * ezt választotta — a Task 15 elfogadási tesztjénél döntsön róla.
 */
export const OVERLAY_HOTKEY = 'Control+Alt+Space'

/**
 * Igaz, ha sikerült regisztrálni.
 *
 * Ha egy másik alkalmazás foglalja a kombinációt, az Electron dokumentáltan NEM dob,
 * hanem `false`-t ad — ilyenkor az app fut tovább, csak a gyorsbillentyű nem él.
 *
 * Szándékosan nincs try/catch. Mivel a „foglalt" eset nem dob, egy kivétel itt csak
 * programozási hibát jelenthet, például egy elgépelt billentyűkombinációt. Ha azt
 * elnyelnénk, a hívó azt naplózná, hogy „egy másik alkalmazás foglalja", ami hamis
 * nyomra vinne. Így a hiba az `app.whenReady()` hibakezelőjéhez jut, és hibadialógust ad.
 */
export function registerHotkey(accelerator: string, handler: () => void): boolean {
  return globalShortcut.register(accelerator, handler)
}
```

- [ ] **Step 3: Kösd össze a main processzben**

`apps/desktop/src/main/index.ts` — cseréld le az `app.whenReady()` végén lévő
`overlay.showInactive()` sort erre. A hiányzó importok: `screen` és
`globalShortcut` az `electron`-ból, `createTray` a `./tray.js`-ből,
`OVERLAY_HOTKEY` és `registerHotkey` a `./hotkey.js`-ből.

Az overlay mostantól **nem** jelenik meg induláskor — csak a gyorsbillentyűre vagy a
tálcaikonra kattintva.

```ts
  overlay = createOverlay()

  const tray = createTray({
    onOpen: () => showOverlay(),
    onQuit: () => app.quit(),
  })

  function showOverlay(): void {
    if (overlay === undefined) return
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    // getBounds(), nem getSize(): az Electron a getSize()-t `number[]`-ként típusozza,
    // amiből `noUncheckedIndexedAccess` mellett csak típus-kényszerítéssel lehetne
    // szélességet és magasságot kivenni. A getBounds() elnevezett mezőket ad.
    const { width, height } = overlay.getBounds()
    overlay.setPosition(
      Math.round(display.workArea.x + (display.workArea.width - width) / 2),
      Math.round(display.workArea.y + (display.workArea.height - height) / 3),
    )
    overlay.show()
    overlay.focus()
  }

  function toggleOverlay(): void {
    if (overlay?.isVisible() === true) overlay.hide()
    else showOverlay()
  }

  const hotkeyRegistered = registerHotkey(OVERLAY_HOTKEY, toggleOverlay)

  // A tálca és a gyorsbillentyű állapota a stdoutra. Ez teszi a Task 13 ellenőrzését
  // gomblenyomás nélkül mérhetővé: a createTray üres ikonnál dob, tehát ha ez a sor
  // megjelenik, a tálcaikon látható képet kapott.
  console.log(
    `[claudeswitcher] tray ready, hotkey ${OVERLAY_HOTKEY} ` +
      (hotkeyRegistered ? 'registered' : 'NOT registered (taken by another application)'),
  )

  const syncTray = (): void => {
    tray.setWaiting(daemon!.state().sessions.filter((s) => s.status === 'waiting').length)
  }
  syncTray()
  setInterval(syncTray, 1000).unref()

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    tray.destroy()
  })
```

- [ ] **Step 4: Az ikonfájlok tesztje**

**Mit NEM ellenőriz ez a task, és miért.** A gyorsbillentyű lenyomását, az overlay
pozícióját, az elrejtést fókuszvesztéskor és a tálca tooltipjének számát egy ágens nem
tudja ellenőrizni — ehhez billentyűt kellene nyomni és ablakot figyelni a felhasználó
gépén. A tálcaikon várakozó-állapotra váltásához pedig a daemonnak kellene POST-olni, a
token viszont szándékosan sehol nem naplózódik. Ezeket a felhasználó ellenőrzi a Task 15
elfogadási tesztjében. Ez a task azt méri, ami gombnyomás nélkül mérhető: hogy az
ikonok érvényesek, és hogy a tálca és a gyorsbillentyű ténylegesen létrejön.

`apps/desktop/src/main/tray-icons.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../resources')
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe.each(['tray.png', 'tray-waiting.png'])('%s', (file) => {
  it('is a 16x16 RGBA PNG', () => {
    // A PNG szerkezetét ellenőrzi: szignatúra, IHDR méret és színtípus. A teljes
    // dekódolást (CRC, IDAT) NEM — azt a futó app createTray-je méri, ami üres képnél
    // dob, tehát a korlátos indítás tálca-sora azt fedi le.
    const bytes = readFileSync(path.join(resources, file))
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    expect(bytes.readUInt32BE(16)).toBe(16)
    expect(bytes.readUInt32BE(20)).toBe(16)
    expect(bytes[25]).toBe(6)
  })
})
```

Run: `pnpm --filter @claudeswitcher/desktop test`
Expected: az eddigi 7 teszt mellett 2 új, összesen 9 PASS.

- [ ] **Step 5: Build, típusellenőrzés és korlátos indítás**

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop build && pnpm --filter @claudeswitcher/desktop check-types`
Expected: mindhárom exit 0.

Aztán a korlátos indítás a Task 11 Step 5 mintájára, az `ELECTRON_RUN_AS_NODE`
törlésével. Expected — **mindkét** sor megjelenik az `out.log`-ban:

```
[claudeswitcher] daemon on 127.0.0.1:<port>, N session(s) discovered, fast focus available
[claudeswitcher] tray ready, hotkey Control+Alt+Space registered
```

A `tray ready` sor megjelenése bizonyítja, hogy **mindkét ikon nem üres képként**
töltődött be az Electronban: a `createTray` üres ikonnál dob, a dobás pedig
hibadialógushoz és kilépéshez vezet, a sor meg sem jelenne. A gyorsbillentyű
`NOT registered` állapota nem a mi kódunk hibája — azt jelenti, hogy egy másik alkalmazás
foglalja —, de jelenteni kell.

Az indítás alatt **ablak nem jelenik meg** — az overlay mostantól csak gyorsbillentyűre
nyílik. A tálcán ~20 másodpercre megjelenik az ikon, és a `Control+Alt+Space` addig
globálisan regisztrálva van: ha a felhasználó épp megnyomja, az overlay felugrik.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/tray.ts apps/desktop/src/main/hotkey.ts apps/desktop/src/main/index.ts apps/desktop/src/main/tray-icons.test.ts apps/desktop/resources
git commit -m "feat(desktop): tray icon with waiting badge and global hotkey overlay toggle"
```

---

### Task 14: desktop — overlay lista

**Files:**
- Create: `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/useDaemonState.ts`, `apps/desktop/src/renderer/styles.css`
- Create: `apps/desktop/src/renderer/format.ts`, `apps/desktop/src/renderer/selection.ts`, `apps/desktop/src/renderer/state-message.ts`
- Modify: `apps/desktop/src/renderer/main.tsx`, `apps/desktop/src/renderer/index.html`
- Test: `apps/desktop/src/renderer/format.test.ts`, `selection.test.ts`, `state-message.test.ts`

**Interfaces:**
- Consumes: `DaemonState` (Task 9), a preload `window.claudeswitcher` API-ja (Task 11)
- Produces:
  - `resolveSelectedIndex(ids, selectedId): number` és `moveSelection(ids, selectedId, delta): string | undefined`
  - `parseStateMessage(data: unknown): DaemonState | undefined` — soha nem dob
  - működő overlay lista billentyűnavigációval

**Három hiba, amit ez a task a tervhez képest kijavít:**
- **Index szerinti kiválasztás.** A lista rendezett, a várakozó sessionök felülre ugranak.
  Egy index-alapú kiválasztás egy átrendeződéskor csendben egy MÁSIK sessionre mutatna,
  és az Enter rossz ablakra ugrana. A kiválasztás session-azonosító szerint követ.
- **Elveszett frissítés.** Az állapot IPC-n jön, a WebSocket csak utána nyílik. A kettő
  között érkező változás elveszne, és mivel a daemon az azonos pillanatképeket nem küldi
  újra, az overlay addig állott maradna, amíg valami újra meg nem változik. Kapcsolódáskor
  ezért újra lekérjük az állapotot.
- **Beragadó kiválasztás.** Üres listán a lefelé nyíl `-1`-re állította a kiválasztást.

**Mit NEM ellenőriz ez a task, és miért.** A gyorsbillentyűt, a nyilakat, az Entert és az
Esc-et egy ágens nem nyomhatja meg a felhasználó gépén. Ezeket a Task 15 elfogadási
tesztje ellenőrzi. Ez a task a tiszta logikát egységteszteli, a renderert pedig egy
korlátos indítással méri, ablak megjelenítése nélkül: a rejtett overlay is betölti az
oldalát, tehát a konzolkimenete bizonyítja, hogy a React lefutott, az IPC válaszolt, és
a WebSocket a tokennel kapcsolódott.

- [ ] **Step 1: Írd meg a formázók failing tesztjét**

`apps/desktop/src/renderer/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatDuration, formatResetsIn, summarize } from './format.js'

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45mp')
  })

  it('renders minutes and seconds', () => {
    expect(formatDuration(134_000)).toBe('2:14')
  })

  it('renders hours', () => {
    expect(formatDuration(3_700_000)).toBe('1:01:40')
  })

  it('clamps a negative duration to zero', () => {
    expect(formatDuration(-5)).toBe('0mp')
  })
})

describe('formatResetsIn', () => {
  it('renders hours until reset', () => {
    const now = 1_000_000_000_000
    expect(formatResetsIn(now / 1000 + 7200, now)).toBe('2h múlva')
  })

  it('renders minutes when under an hour', () => {
    const now = 1_000_000_000_000
    expect(formatResetsIn(now / 1000 + 600, now)).toBe('10p múlva')
  })
})

describe('summarize', () => {
  it('prefers the notification text when waiting', () => {
    const line = summarize({
      status: 'waiting',
      notificationText: 'Claude needs permission to run pnpm test',
      activity: { runningTool: 'Bash' },
    })
    expect(line).toBe('Claude needs permission to run pnpm test')
  })

  it('names the running tool when working', () => {
    expect(summarize({ status: 'working', activity: { runningTool: 'Bash' } })).toBe('Bash fut')
  })

  it('shows the last assistant text when idle', () => {
    expect(summarize({ status: 'idle', activity: { lastAssistantText: 'Kész.' } })).toBe('Kész.')
  })

  it('truncates a long summary', () => {
    const long = 'x'.repeat(200)
    expect(summarize({ status: 'idle', activity: { lastAssistantText: long } }).length).toBe(80)
  })

  it('falls back when there is nothing to say', () => {
    expect(summarize({ status: 'idle', activity: {} })).toBe('—')
  })

  it('survives a session whose activity is missing entirely', () => {
    // A daemon a típus szerint mindig ad `activity`-t, de egy hibás üzenet nem. Ez
    // renderelés közben dobna, és az egész overlay eltűnne.
    const broken = { status: 'idle' } as unknown as Parameters<typeof summarize>[0]
    expect(() => summarize(broken)).not.toThrow()
    expect(summarize(broken)).toBe('—')
  })
})
```

- [ ] **Step 2: Futtasd, hogy lásd a hibát**

A Vitest beállítás és a `test` script már létezik — a Task 12 hozta létre az
`apps/desktop` első tesztjével (`focus-window.test.ts`). Ne hozd létre újra.

Az `apps/desktop` `check-types`-ja az `electron-vite` miatt nem külön `tsconfig`
párra épül, hanem az egyetlen `tsconfig.json`-ra, ami a teszteket is tartalmazza
(nincs `tsc` build lépése, amiből ki kellene hagyni őket).

Run: `pnpm --filter @claudeswitcher/desktop test format`
Expected: FAIL — `Cannot find module './format.js'`, `Caused by: … Does the file exist?`

- [ ] **Step 3: Írd meg a formázókat**

`apps/desktop/src/renderer/format.ts`:
```ts
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
```

- [ ] **Step 4: Futtasd a teszteket**

Run: `pnpm --filter @claudeswitcher/desktop test format`
Expected: PASS, 11 teszt a `format.test.ts`-ben.

- [ ] **Step 4b: A kiválasztás és az üzenetfeldolgozás — teszt előbb**

`apps/desktop/src/renderer/selection.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { moveSelection, resolveSelectedIndex } from './selection.js'

describe('resolveSelectedIndex', () => {
  it('returns -1 for an empty list', () => {
    expect(resolveSelectedIndex([], 'a')).toBe(-1)
  })

  it('defaults to the first session when nothing is selected', () => {
    expect(resolveSelectedIndex(['a', 'b'], undefined)).toBe(0)
  })

  it('follows the selected session when the list re-sorts', () => {
    // A `b` az 1-es indexen volt; egy várakozni kezdő `c` felülre ugrik. Index
    // szerinti követéssel az Enter most az `a` ablakára ugrana.
    expect(resolveSelectedIndex(['c', 'a', 'b'], 'b')).toBe(2)
  })

  it('falls back to the first session when the selected one disappears', () => {
    expect(resolveSelectedIndex(['a', 'c'], 'b')).toBe(0)
  })
})

describe('moveSelection', () => {
  it('moves down and up by session, not by stale index', () => {
    expect(moveSelection(['a', 'b', 'c'], 'a', 1)).toBe('b')
    expect(moveSelection(['a', 'b', 'c'], 'c', -1)).toBe('b')
  })

  it('stops at both ends of the list', () => {
    expect(moveSelection(['a', 'b'], 'b', 1)).toBe('b')
    expect(moveSelection(['a', 'b'], 'a', -1)).toBe('a')
  })

  it('returns undefined for an empty list rather than an invalid position', () => {
    // A javítás előtt ez a kiválasztást -1-re állította, ahol beragadt.
    expect(moveSelection([], undefined, 1)).toBeUndefined()
  })
})
```

`apps/desktop/src/renderer/state-message.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseStateMessage } from './state-message.js'

describe('parseStateMessage', () => {
  it('returns the state carried by a well-formed state message', () => {
    const message = JSON.stringify({ type: 'state', payload: { sessions: [], rateLimits: {} } })
    expect(parseStateMessage(message)).toEqual({ sessions: [], rateLimits: {} })
  })

  it('ignores messages that are not state updates', () => {
    expect(parseStateMessage(JSON.stringify({ type: 'other', payload: {} }))).toBeUndefined()
    expect(parseStateMessage(JSON.stringify({ type: 'state', payload: { sessions: 'no' } }))).toBeUndefined()
  })

  it('never throws on garbage', () => {
    for (const garbage of ['not json', '', 'null', '42', '[]', undefined]) {
      expect(() => parseStateMessage(garbage)).not.toThrow()
      expect(parseStateMessage(garbage)).toBeUndefined()
    }
  })
})
```

Run: `pnpm --filter @claudeswitcher/desktop test selection state-message`
Expected: FAIL — `Cannot find module './selection.js'` és `'./state-message.js'`.

- [ ] **Step 4c: Írd meg a két tiszta modult**

`apps/desktop/src/renderer/selection.ts`:
```ts
/**
 * A kiválasztott session indexe a jelenlegi listában, vagy -1, ha a lista üres.
 *
 * A kiválasztást session-azonosító szerint követjük, nem index szerint. A lista
 * rendezett — a várakozó sessionök felülre ugranak —, így egy index-alapú kiválasztás
 * egy átrendeződéskor csendben egy MÁSIK sessionre mutatna, és az Enter rossz ablakra
 * ugrana. Ha a kiválasztott session eltűnt, az elsőre esünk vissza.
 */
export function resolveSelectedIndex(
  ids: readonly string[],
  selectedId: string | undefined,
): number {
  if (ids.length === 0) return -1
  const index = selectedId === undefined ? -1 : ids.indexOf(selectedId)
  return index === -1 ? 0 : index
}

/** A kiválasztás mozgatása `delta` lépéssel, a lista végein megállva. */
export function moveSelection(
  ids: readonly string[],
  selectedId: string | undefined,
  delta: number,
): string | undefined {
  if (ids.length === 0) return undefined
  const current = resolveSelectedIndex(ids, selectedId)
  const next = Math.min(Math.max(current + delta, 0), ids.length - 1)
  return ids[next]
}
```

`apps/desktop/src/renderer/state-message.ts`:
```ts
import type { RateLimits, SessionView } from '@claudeswitcher/core'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
}

/** Egy WebSocket üzenetből kiolvassa az állapotot, vagy `undefined`-ot ad. Soha nem dob. */
export function parseStateMessage(data: unknown): DaemonState | undefined {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch {
    return undefined
  }
  if (typeof message !== 'object' || message === null) return undefined

  const { type, payload } = message as { type?: unknown; payload?: unknown }
  if (type !== 'state' || typeof payload !== 'object' || payload === null) return undefined

  const { sessions, rateLimits } = payload as { sessions?: unknown; rateLimits?: unknown }
  if (!Array.isArray(sessions)) return undefined
  if (typeof rateLimits !== 'object' || rateLimits === null) return undefined

  return payload as DaemonState
}
```

Run: `pnpm --filter @claudeswitcher/desktop test`
Expected: PASS. A `format` (12), `selection` (7) és `state-message` (3) mellett a korábbi
`focus-window` (7) és `tray-icons` (2), plusz a `useDaemonState` (2) — összesen 33 teszt.

- [ ] **Step 5: Írd meg az állapot-hookot**

`apps/desktop/src/renderer/useDaemonState.ts`:
```ts
import { useEffect, useState } from 'react'
import { parseStateMessage, type DaemonState } from './state-message.js'

declare global {
  interface Window {
    claudeswitcher: {
      connection(): Promise<{ port: number; token: string }>
      state(): Promise<DaemonState>
      focusSession(sessionId: string): Promise<boolean>
      hide(): Promise<void>
    }
  }
}

export interface OverlayState extends DaemonState {
  /** Hamis, amíg nincs élő kapcsolat a daemonnal — a lista ilyenkor állott lehet. */
  connected: boolean
}

/**
 * Várakozás a hányadik újracsatlakozási próbálkozás előtt. Negyed másodpercről indul, és
 * tíz másodpercnél megáll: egy alvásból ébredt gép gyorsan visszakapcsolódik, egy tartósan
 * halott daemont viszont nem ostromlunk.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** Math.max(0, attempt - 1))
}

/** Élő állapot a daemon WebSocket hubjáról, újracsatlakozással. */
export function useDaemonState(): OverlayState {
  const [state, setState] = useState<DaemonState>({ sessions: [], rateLimits: {} })
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let socket: WebSocket | undefined
    let closed = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    // Ha már érkezett élő üzenet, egy később befutó IPC-lekérés nem írhatja felül: a két
    // csatorna külön utazik, és nincs köztük sorrendi garancia.
    let receivedLive = false
    // Kapcsolat-nemzedék. Újracsatlakozáskor nő, és minden kezelő a SAJÁT nemzedékére
    // ellenőriz. Enélkül egy előző, már lezárt kapcsolat közben indított állapot-lekérés
    // később futhatna be, mint egy újabb kapcsolat adata, és felülírná frissebbel. A
    // `receivedLive` önmagában nem véd ettől: azt az `onclose` nullázza.
    let generation = 0

    const scheduleRetry = (): void => {
      if (closed) return
      attempt += 1
      retry = setTimeout(attemptConnect, retryDelayMs(attempt))
    }

    const connect = async (): Promise<void> => {
      if (closed) return
      const myGeneration = ++generation

      const { port, token } = await window.claudeswitcher.connection()
      if (closed || myGeneration !== generation) return

      const next = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`)
      socket = next

      next.onopen = () => {
        if (closed || myGeneration !== generation) return
        attempt = 0
        setConnected(true)
        // Az állapotot szándékosan CSAK a kapcsolat megnyílása után kérjük le. Egy
        // megnyílás előtti lekérés és a socket élete között érkező változás elveszne, és
        // mivel a daemon az azonos pillanatképeket nem küldi újra, az overlay addig
        // állott maradna, amíg valami ÚJRA meg nem változik.
        void window.claudeswitcher.state().then((fresh) => {
          if (!closed && myGeneration === generation && !receivedLive) setState(fresh)
        })
        // A korlátos indítás ezt a sort keresi: a rejtett overlay is betölti az oldalát,
        // így ez bizonyítja, hogy a React lefutott, az IPC válaszolt, és a WebSocket a
        // tokennel kapcsolódott. Tokent nem ír ki.
        console.info('[overlay] live updates connected')
      }

      next.onmessage = (event) => {
        if (closed || myGeneration !== generation) return
        const parsed = parseStateMessage(event.data)
        if (parsed === undefined) return
        receivedLive = true
        setState(parsed)
      }

      next.onclose = () => {
        if (closed || myGeneration !== generation) return
        // Kapcsolatvesztés után az overlay némán állott maradna — egy monitorozó
        // eszközben ez ugyanolyan rossz, mint a hibás adat. Újracsatlakozunk, és addig
        // a felhasználó is látja, hogy nincs élő kapcsolat.
        setConnected(false)
        receivedLive = false
        scheduleRetry()
      }

      next.onerror = () => {
        // A `close` mindig követi; az újracsatlakozást ott ütemezzük.
        next.close()
      }
    }

    // MINDEN próbálkozás ezen megy át, az újraütemezettek is. Ha csak az első kapna
    // `catch`-et, egy későbbi próbálkozás elutasítása — például ha az IPC nem válaszol —
    // elkapatlan maradna, ÉS a ciklus némán leállna: több újraütemezés nem történne, az
    // overlay pedig örökre „nincs kapcsolat" állapotban maradna.
    function attemptConnect(): void {
      connect().catch((error: unknown) => {
        console.error('[overlay] could not reach the daemon', error)
        scheduleRetry()
      })
    }

    attemptConnect()

    return () => {
      closed = true
      if (retry !== undefined) clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { ...state, connected }
}
```

- [ ] **Step 6: Írd meg az App komponenst**

`apps/desktop/src/renderer/App.tsx`:
```tsx
import { useEffect, useState, type JSX } from 'react'
import { formatDuration, formatResetsIn, summarize } from './format.js'
import { moveSelection, resolveSelectedIndex } from './selection.js'
import { useDaemonState } from './useDaemonState.js'
import './styles.css'

const STATUS_LABEL = {
  waiting: '●',
  working: '◐',
  idle: '○',
  unknown: '?',
} as const

export function App(): JSX.Element {
  const { sessions, rateLimits, connected } = useDaemonState()
  // Session-azonosító, nem index: a lista átrendeződésekor a kiválasztás a sessionnel
  // együtt mozog. Lásd a selection.ts dokumentációját.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())

  const selected = resolveSelectedIndex(
    sessions.map((s) => s.sessionId),
    selectedId,
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const ids = sessions.map((s) => s.sessionId)
      if (event.key === 'Escape') void window.claudeswitcher.hide()
      if (event.key === 'ArrowDown') setSelectedId(moveSelection(ids, selectedId, 1))
      if (event.key === 'ArrowUp') setSelectedId(moveSelection(ids, selectedId, -1))
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const view = sessions[resolveSelectedIndex(ids, selectedId)]
        if (view !== undefined) void window.claudeswitcher.focusSession(view.sessionId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessions, selectedId])

  return (
    <div className="overlay">
      <ul className="sessions">
        {sessions.length === 0 && (
          // „Nincs session" és „nem érjük el a daemont" nem ugyanaz — a felhasználónak
          // látnia kell, melyikről van szó.
          <li className="empty">
            {connected ? 'Nincs futó session' : 'Nincs kapcsolat a daemonnal…'}
          </li>
        )}
        {sessions.map((view, index) => (
          <li
            key={view.sessionId}
            className={`session ${view.status} ${index === selected ? 'selected' : ''}`}
            onClick={() => void window.claudeswitcher.focusSession(view.sessionId)}
          >
            <span className="marker">{STATUS_LABEL[view.status]}</span>
            <span className="name">
              {view.name}
              {(view.bridgeSessionId === null || view.bridgeSessionId === undefined) && (
                // Remote Control nélkül ez a session telefonról nem érhető el.
                <span className="unbridged" title="Nincs Remote Control kapcsolata">
                  {' ⚑'}
                </span>
              )}
            </span>
            <span className="summary">{summarize(view)}</span>
            <span className="age">
              {view.waitingSince !== undefined ? formatDuration(now - view.waitingSince) : ''}
            </span>
          </li>
        ))}
      </ul>

      <div className="limits">
        {rateLimits.five_hour !== undefined && (
          <span>
            5h {Math.round(rateLimits.five_hour.used_percentage)}% ·{' '}
            {formatResetsIn(rateLimits.five_hour.resets_at, now)}
          </span>
        )}
        {rateLimits.seven_day !== undefined && (
          <span>
            7d {Math.round(rateLimits.seven_day.used_percentage)}% ·{' '}
            {formatResetsIn(rateLimits.seven_day.resets_at, now)}
          </span>
        )}
        {rateLimits.five_hour === undefined && rateLimits.seven_day === undefined && (
          <span className="muted">Limitadat még nincs</span>
        )}
        {!connected && <span className="muted">kapcsolat megszakadt — újracsatlakozás…</span>}
      </div>
    </div>
  )
}
```

`apps/desktop/src/renderer/styles.css`:
```css
:root { color-scheme: dark; }

body {
  margin: 0;
  font: 13px/1.4 "Segoe UI", system-ui, sans-serif;
  color: #e8e6e3;
  background: #1c1b1a;
}

.overlay { display: flex; flex-direction: column; height: 100vh; }
.sessions { flex: 1; margin: 0; padding: 6px; list-style: none; overflow-y: auto; }

.session {
  display: grid;
  grid-template-columns: 16px 130px 1fr 56px;
  gap: 8px;
  align-items: baseline;
  padding: 6px 8px;
  border-radius: 5px;
  cursor: pointer;
}

.session.selected { background: #2f2e2c; }
.session.waiting .marker { color: #d97757; }
.session.working .marker { color: #7aa2c4; }
.session.idle .marker { color: #6b6a67; }

.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unbridged { color: #6b6a67; font-weight: 400; }
.summary { color: #a8a6a2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.age { color: #6b6a67; text-align: right; font-variant-numeric: tabular-nums; }
.empty { padding: 24px; text-align: center; color: #6b6a67; }

.limits {
  display: flex;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid #2f2e2c;
  color: #a8a6a2;
  font-variant-numeric: tabular-nums;
}

.muted { color: #6b6a67; }
```

- [ ] **Step 6b: Írd meg az újracsatlakozási késleltetés tesztjét és az ErrorBoundaryt**

`apps/desktop/src/renderer/useDaemonState.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { retryDelayMs } from './useDaemonState.js'

describe('retryDelayMs', () => {
  it('backs off exponentially from a quarter second', () => {
    expect(retryDelayMs(1)).toBe(250)
    expect(retryDelayMs(2)).toBe(500)
    expect(retryDelayMs(3)).toBe(1000)
  })

  it('caps the wait at ten seconds so a dead daemon is not hammered', () => {
    expect(retryDelayMs(99)).toBe(10_000)
  })
})
```

`apps/desktop/src/renderer/ErrorBoundary.tsx`:
```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  message: string | undefined
}

/**
 * Egy renderelési hiba különben az egész overlayt leszedné, és üres ablakot hagyna. Egy
 * monitorozó eszközben ez a legrosszabb kimenet: pont akkor nem mutat semmit, amikor
 * ránézel — és úgy néz ki, mintha nem lenne futó session.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: undefined }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[overlay] render failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.message !== undefined) {
      return <div className="empty">Az overlay hibába futott: {this.state.message}</div>
    }
    return this.props.children
  }
}
```

- [ ] **Step 7: Kösd be a renderert, és adj neki Content-Security-Policy-t**

`apps/desktop/src/renderer/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
```

`apps/desktop/src/renderer/index.html` — a Task 11 óta nincs CSP-je, amire az Electron
fejlesztői figyelmeztetést ír. A `<head>`-be, a `charset` után:

```html
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*"
    />
```

A `connect-src ws://127.0.0.1:*` nélkül a böngésző megtagadná a WebSocketet a daemon
felé, és az overlay némán állott maradna. A port wildcard kötelező, mert a daemon
ideiglenes portot kap. A `script-src 'self'` a `file://`-ról betöltött bundle-t is
lefedi — ugyanezt a szabályt használja az electron-vite React sablonja.

- [ ] **Step 8: Build, típusellenőrzés és a renderer korlátos ellenőrzése**

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop build && pnpm --filter @claudeswitcher/desktop check-types`
Expected: mindhárom exit 0.

Aztán a korlátos indítás a Task 11 Step 5 mintájára, **egy kiegészítéssel**: az indítás
előtt `$env:ELECTRON_ENABLE_LOGGING = '1'`. Enélkül a renderer konzolkimenete nem jut el
a főprocessz stderr-jére, és a lenti sorok egyike sem látszana.

Expected:
- Az `out.log`-ban a két ismert sor: `daemon on …, N session(s) discovered, fast focus
  available` és `tray ready, hotkey Control+Alt+Space registered`.
- Az `err.log`-ban **szerepel** a `[overlay] live updates connected` sor. Ez bizonyítja,
  hogy a rejtett overlay oldala betöltődött, a React lefutott, az IPC válaszolt, a CSP
  engedte a WebSocketet, és az a tokennel kapcsolódott.
- Az `err.log`-ban **nem szerepel** `Insecure Content-Security-Policy` — ez bizonyítja,
  hogy a CSP érvényesül.
- Az `err.log`-ban **nem szerepel** `[overlay] could not reach the daemon`, és nincs
  `Refused to connect` vagy `Refused to load` CSP-elutasítás.

Ha a `live updates connected` sor hiányzik, az a legfontosabb jelentendő eredmény — azt
jelenti, hogy az overlay élesben üres vagy állott lenne.

Az indítás alatt ablak nem jelenik meg. A billentyűnavigáció, az Enter és az Esc
viselkedése a Task 15 elfogadási tesztjében ellenőrződik.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "feat(desktop): overlay session list with keyboard navigation and limit bar"
```

---

### Task 15: setup — a telepítés tiszta, veszteségmentes logikája

**Files:**
- Modify: `packages/core/src/settings-writer.ts` — `transformSettingsFile`; az `updateSettingsFile` erre épül
- Test: `packages/core/src/settings-writer.test.ts`
- Modify: `packages/daemon/src/daemon.ts` — `port` és `token` opció
- Test: `packages/daemon/src/daemon.test.ts`
- Create: `apps/desktop/src/main/setup.ts`, `apps/desktop/src/main/token.ts`
- Test: `apps/desktop/src/main/setup.test.ts`, `apps/desktop/src/main/token.test.ts`

**Interfaces:**
- Consumes: `mergeSettings`, `userSettingsPath` (core); `startDaemon` (daemon)
- Produces:
  - `transformSettingsFile(filePath, transform): Promise<void>` (core)
  - `DaemonOptions.port?: number` és `DaemonOptions.token?: string` (daemon)
  - `DAEMON_PORT: number`
  - `applyIntegration(existing, options): { settings; conflicts }`
  - `removeIntegration(existing): Record<string, unknown>`
  - `installIntegration(claudeDir, options): Promise<string[]>` — az ütközéseket adja vissza
  - `uninstallIntegration(claudeDir): Promise<void>`
  - `loadOrCreateToken(dir): Promise<string>`

**Miért tér el ez a task az eredeti tervtől.** Az eredeti Task 15 öt hibát hordozott:

1. **Ideiglenes port a telepített beállításokban.** A daemon minden induláskor új portot
   kapott, a telepítés pedig ezt írta a `settings.json`-ba. Az app újraindítása után
   minden session hookja egy halott portra mutatott volna, és egyetlen várakozás-jelzés
   sem érkezett volna. **Ez a funkciót törte volna, nem csak kockázatos volt.**
   Megoldás: fix port és tartós token.
2. **Telepítés minden induláskor.** Minden app-indítás — és minden ágens korlátos
   indítása — átírta volna a felhasználó globális Claude Code beállításait. Megoldás: a
   telepítés kifejezett, a tálcamenüből indított művelet (Task 16).
3. **A hook-tömbök egészben felülírva.** A `mergeSettings` a tömböket cseréli, tehát egy
   telepítés némán törölte volna a felhasználó saját `Notification`, `Stop`,
   `SessionStart` és `SessionEnd` hookjait. Megoldás: a saját bejegyzéseinket azonosítjuk
   és cseréljük, az idegeneket megtartjuk.
4. **Egy saját status line felülírva.** Megoldás: idegen status line-t nem írunk felül,
   hanem ütközésként jelentjük.
5. **Nincs eltávolítás.** Megoldás: `removeIntegration`, ami csak a saját bejegyzéseinket
   veszi ki. A telepítés és az eltávolítás együtt veszteségmentes — erre van teszt.

**Saját bejegyzés azonosítása.** Egy hook akkor a mienk, ha az `allowedEnvVars`-ában
szerepel a `CLAUDESWITCHER_TOKEN`. Ez portfüggetlen, tehát egy portváltás után is
felismerjük a régi telepítést, és egy idegen hook szinte biztosan nem hivatkozik erre a
változóra. Egy status line akkor a mienk, ha a parancsa a `packages/statusline/dist/main.js`-re
mutat.

**Ez a task semmit nem ír a felhasználó valódi `settings.json`-jába.** Minden teszt
ideiglenes könyvtárban fut.

- [ ] **Step 1: A core — transzformáló író, teszt előbb**

`packages/core/src/settings-writer.test.ts` — az import bővül
`import { mergeSettings, transformSettingsFile, updateSettingsFile } from './settings-writer.js'`,
és a meglévő `describe` blokkok mellé:

```ts
describe('transformSettingsFile', () => {
  it('passes the parsed file to the transform and writes its result', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ keep: 1, drop: 2 }))

    await transformSettingsFile(file, (existing) => {
      const { drop, ...rest } = existing
      return rest
    })

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ keep: 1 })
  })

  it('can remove nested keys, which a merge patch cannot express', async () => {
    // Ezért kell egyáltalán: az eltávolítás kulcsokat töröl, a mergeSettings csak ad.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ env: { A: '1', B: '2' } }))
    await transformSettingsFile(file, () => ({ env: { A: '1' } }))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ env: { A: '1' } })
  })

  it('refuses to write an unparseable file and never calls the transform', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, '{ broken')
    let called = false
    await expect(
      transformSettingsFile(file, (existing) => {
        called = true
        return existing
      }),
    ).rejects.toThrow(/parse/i)
    expect(called).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('{ broken')
  })

  it('shares one write queue with updateSettingsFile', async () => {
    // Közös sor nélkül egy telepítés és egy párhuzamos merge egymás írását dobná el.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({}))

    await Promise.all([
      updateSettingsFile(file, { a: 1 }),
      transformSettingsFile(file, (existing) => ({ ...existing, b: 2 })),
      updateSettingsFile(file, { c: 3 }),
    ])

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1, b: 2, c: 3 })
  })
})
```

Run: `pnpm --filter @claudeswitcher/core test settings-writer`
Expected: FAIL — a `transformSettingsFile` nem exportált.

- [ ] **Step 2: A core — implementáció**

`packages/core/src/settings-writer.ts` — a meglévő `updateSettingsFile`-t és a privát
`writeMerged`-et cseréld le erre a három függvényre. A `writeQueues`, a `mergeSettings` és
az `isPlainObject` változatlan marad:

```ts
/**
 * Atomikus, sorba állított, parse-biztos olvasás–transzformálás–írás. A `transform` a már
 * beolvasott objektumot kapja, és a kiírandót adja vissza.
 *
 * Azért kell a merge-patch mellé, mert az integráció eltávolítása kulcsokat töröl, amit
 * egy merge-patch nem tud kifejezni. Az `updateSettingsFile`-lal azonos sort használ, így
 * a kettő ugyanarra a fájlra nem tudja egymás írását eldobni.
 */
export function transformSettingsFile(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const key = path.resolve(filePath)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  // A következő hívónak arra kell várnia, hogy a fájlművelet *befejeződjön*, a
  // sikerére nem — ezért fut a lánc hiba után is tovább.
  const next = previous.then(
    () => writeTransformed(filePath, transform),
    () => writeTransformed(filePath, transform),
  )
  writeQueues.set(key, next.catch(() => undefined))
  return next
}

export function updateSettingsFile(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return transformSettingsFile(filePath, (existing) => mergeSettings(existing, patch))
}

/**
 * Parse-olhatatlan meglévő fájlnál dob, és NEM hívja a transzformációt és nem ír — inkább
 * ne módosítsunk semmit, mint hogy elveszítsük a felhasználó beállításait.
 */
async function writeTransformed(
  filePath: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  let existing: Record<string, unknown> = {}

  let raw: string | undefined
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    raw = undefined
  }

  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`Cannot parse existing settings at ${filePath}; refusing to write`, { cause })
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`Settings at ${filePath} is not a JSON object; refusing to write`)
    }
    existing = parsed
  }

  const next = transform(existing)
  // Egyedi név processzenként ÉS híváson belül: a pid önmagában nem elég.
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await rename(temp, filePath)
  } catch (error) {
    // Ne hagyjunk törmeléket a ~/.claude/-ban. A célfájl érintetlen — ez a lényeg.
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
```

Run: `pnpm --filter @claudeswitcher/core test && pnpm --filter @claudeswitcher/core check-types && pnpm --filter @claudeswitcher/core build`
Expected: minden korábbi core teszt és a 4 új PASS; a korábbi `updateSettingsFile` tesztek
változatlanul átmennek, mert az viselkedésben azonos maradt.

- [ ] **Step 3: A daemon — fix port és megadott token, teszt előbb**

`packages/daemon/src/daemon.test.ts` — a meglévő `describe('startDaemon', …)` blokkba:

```ts
  it('uses the token it is given instead of generating one', async () => {
    const token = 'a'.repeat(32)
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0, token })
    expect(running.token).toBe(token)
  })

  it('binds the port it is given, and fails loudly when that port is taken', async () => {
    // A desktop fix portot ad, hogy a telepített hookok az újraindítás után is élők
    // maradjanak. Egy foglalt port ezért indulási HIBA, nem csendes átállás egy másik
    // portra — az átállás pont a telepített hookokat tenné halottá.
    const first = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    try {
      await expect(
        startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0, port: first.port }),
      ).rejects.toThrow(/EADDRINUSE/)
    } finally {
      await first.stop()
    }
  })
```

Run: `pnpm --filter @claudeswitcher/daemon test daemon`
Expected: FAIL — a token-teszt eltérő tokent lát, a port-teszt nem utasít el.

- [ ] **Step 4: A daemon — implementáció**

`packages/daemon/src/daemon.ts` — a `DaemonOptions` bővül, és a `startDaemon` eleje meg a
szerverindítás változik:

```ts
export interface DaemonOptions {
  claudeDir: string
  probe: ProcessProbe
  /** Poll periódus ms-ben. 0 kikapcsolja (tesztekhez). */
  pollMs?: number
  /**
   * A port, amire a daemon köt. 0: ideiglenes (tesztekhez). A desktop fix portot ad, mert a
   * telepített hookok és a statusLine egy rögzített URL-t kapnak a settings.json-ban.
   */
  port?: number
  /** A daemon tokenje. Ha nincs megadva, véletlen. A desktop tartós tokent ad, ugyanezért. */
  token?: string
}
```

```ts
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { claudeDir, probe, pollMs = 3000, port: requestedPort = 0 } = options
  const token = options.token ?? randomBytes(16).toString('hex')
```

```ts
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: requestedPort }, () => resolve(s))
    // Foglalt porton a listen `error` eseményt emittál. Kezelő nélkül ez elkapatlan kivétel
    // lenne; így a startDaemon elutasít, a desktop pedig indulási hibadialógust mutat.
    s.on('error', reject)
  })
```

Run: `pnpm --filter @claudeswitcher/daemon test && pnpm check-types && pnpm build`
Expected: minden daemon teszt PASS, a 2 új is.

- [ ] **Step 5: A desktop — token és telepítési logika, teszt előbb**

`apps/desktop/src/main/token.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateToken } from './token.js'

describe('loadOrCreateToken', () => {
  it('creates a 32-hex-character token when none exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-token-'))
    expect(await loadOrCreateToken(dir)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns the same token on every later call', async () => {
    // A telepített settings.json `env` blokkja ezt a tokent kapja. Ha újraindításonként
    // változna, minden újraindítás elavulttá tenné a telepítést.
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-token-'))
    const first = await loadOrCreateToken(dir)
    expect(await loadOrCreateToken(dir)).toBe(first)
  })

  it('replaces a token file that does not hold a valid token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-token-'))
    await writeFile(path.join(dir, 'daemon-token'), 'not a token')
    const token = await loadOrCreateToken(dir)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect((await readFile(path.join(dir, 'daemon-token'), 'utf8')).trim()).toBe(token)
  })
})
```

`apps/desktop/src/main/setup.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyIntegration,
  installIntegration,
  removeIntegration,
  uninstallIntegration,
} from './setup.js'

const OPTIONS = {
  port: 47821,
  token: 'abc123',
  statusLineCommand: 'node "P:\\repo\\packages\\statusline\\dist\\main.js"',
}

/** A felhasználó valódi settings.json-jának alakja, a munkamenet elején lemérve. */
const USER_SETTINGS: Record<string, unknown> = {
  permissions: { allow: ['Bash(pnpm build *)', 'Read(//tmp/**)'] },
  model: 'opus[1m]',
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  effortLevel: 'xhigh',
  autoUpdatesChannel: 'latest',
  switchModelsOnFlag: true,
  tui: 'fullscreen',
}

const FOREIGN_NOTIFICATION = {
  hooks: [{ type: 'command', command: 'powershell -c [console]::beep()' }],
}

const FOREIGN_STATUS_LINE = { type: 'command', command: 'bash ~/my-statusline.sh' }

type HookGroups = Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>

describe('applyIntegration', () => {
  it('leaves every existing key of the real settings untouched', () => {
    const { settings } = applyIntegration(USER_SETTINGS, OPTIONS)
    for (const [key, value] of Object.entries(USER_SETTINGS)) {
      expect(settings[key]).toEqual(value)
    }
  })

  it('installs only the four non-blocking hook events', () => {
    const hooks = applyIntegration({}, OPTIONS).settings.hooks as Record<string, unknown>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'SessionEnd', 'SessionStart', 'Stop'])
    // A PermissionRequest az M2 hatásköre; az M1 egyetlen döntést sem vesz el.
    expect(hooks.PermissionRequest).toBeUndefined()
  })

  it('points each hook at the fixed loopback port with the token header', () => {
    const hooks = applyIntegration({}, OPTIONS).settings.hooks as HookGroups
    const hook = hooks.Notification![0]!.hooks[0]!
    expect(hook.type).toBe('http')
    expect(hook.url).toBe('http://127.0.0.1:47821/hooks/notification')
    expect(hook.timeout).toBe(5)
    expect((hook.headers as Record<string, string>).Authorization).toBe('Bearer $CLAUDESWITCHER_TOKEN')
    expect(hook.allowedEnvVars).toEqual(['CLAUDESWITCHER_TOKEN'])
  })

  it('keeps a foreign hook on the same event instead of overwriting it', () => {
    // Az eredeti terv a tömböt egészben cserélte, és ezt a hookot némán törölte volna.
    const existing = { hooks: { Notification: [FOREIGN_NOTIFICATION] } }
    const hooks = applyIntegration(existing, OPTIONS).settings.hooks as Record<string, unknown[]>
    expect(hooks.Notification).toHaveLength(2)
    expect(hooks.Notification![0]).toEqual(FOREIGN_NOTIFICATION)
  })

  it('is idempotent: installing twice changes nothing the second time', () => {
    const once = applyIntegration(USER_SETTINGS, OPTIONS).settings
    expect(applyIntegration(once, OPTIONS).settings).toEqual(once)
  })

  it('replaces our old entry when the port changes, rather than adding a second', () => {
    const old = applyIntegration({}, { ...OPTIONS, port: 11111 }).settings
    const hooks = applyIntegration(old, OPTIONS).settings.hooks as HookGroups
    expect(hooks.Stop).toHaveLength(1)
    expect(String(hooks.Stop![0]!.hooks[0]!.url)).toContain(':47821/')
  })

  it('installs the status line and adds the two env vars beside existing ones', () => {
    const { settings } = applyIntegration({ env: { OTHER: 'x' } }, OPTIONS)
    expect(settings.statusLine).toEqual({ type: 'command', command: OPTIONS.statusLineCommand, padding: 0 })
    expect(settings.env).toEqual({
      OTHER: 'x',
      CLAUDESWITCHER_PORT: '47821',
      CLAUDESWITCHER_TOKEN: 'abc123',
    })
  })

  it('refuses to overwrite a foreign status line and reports it as a conflict', () => {
    const { settings, conflicts } = applyIntegration({ statusLine: FOREIGN_STATUS_LINE }, OPTIONS)
    expect(settings.statusLine).toEqual(FOREIGN_STATUS_LINE)
    expect(conflicts).toHaveLength(1)
  })

  it('leaves a malformed hooks value alone and reports it', () => {
    const { settings, conflicts } = applyIntegration({ hooks: 'nonsense' }, OPTIONS)
    expect(settings.hooks).toBe('nonsense')
    expect(conflicts.length).toBeGreaterThan(0)
  })
})

describe('removeIntegration', () => {
  it('restores the real settings exactly after an install', () => {
    // A legfontosabb tulajdonság: telepítés + eltávolítás együtt veszteségmentes.
    const installed = applyIntegration(USER_SETTINGS, OPTIONS).settings
    expect(removeIntegration(installed)).toEqual(USER_SETTINGS)
  })

  it('keeps foreign hooks, foreign env vars and a foreign status line', () => {
    const existing = {
      hooks: { Notification: [FOREIGN_NOTIFICATION] },
      env: { OTHER: 'x' },
      statusLine: FOREIGN_STATUS_LINE,
    }
    const installed = applyIntegration(existing, OPTIONS).settings
    expect(removeIntegration(installed)).toEqual(existing)
  })

  it('is harmless on settings that never had the integration', () => {
    expect(removeIntegration(USER_SETTINGS)).toEqual(USER_SETTINGS)
  })
})

describe('installIntegration and uninstallIntegration on a real file', () => {
  it('round-trips the real settings through the file system unchanged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cs-setup-'))
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify(USER_SETTINGS, null, 2))

    expect(await installIntegration(dir, OPTIONS)).toEqual([])
    await uninstallIntegration(dir)

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(USER_SETTINGS)
  })
})
```

Run: `pnpm --filter @claudeswitcher/desktop test token setup`
Expected: FAIL — `Cannot find module './token.js'` és `'./setup.js'`.

- [ ] **Step 6: A desktop — implementáció**

`apps/desktop/src/main/token.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

/**
 * Tartós daemon-token. A telepített hookok és a statusLine a settings.json `env` blokkjából
 * kapják, tehát az app újraindításai között azonosnak kell maradnia — különben minden
 * újraindítás elavulttá tenné a telepítést. Egy nem érvényes tokent tartalmazó fájlt
 * lecserélünk, nem hibázunk rajta.
 */
export async function loadOrCreateToken(dir: string): Promise<string> {
  const file = path.join(dir, 'daemon-token')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch {
    // Még nincs token — létrehozzuk.
  }

  const token = randomBytes(16).toString('hex')
  await mkdir(dir, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, token, 'utf8')
  await rename(temp, file)
  return token
}
```

`apps/desktop/src/main/setup.ts`:
```ts
import { transformSettingsFile, userSettingsPath } from '@claudeswitcher/core'

/**
 * A daemon rögzített portja. Nem ideiglenes, mert a telepített hookok és a statusLine ezt
 * az URL-t kapják a settings.json-ban: egy újraindításonként változó port minden
 * újraindítás után halottá tenné őket.
 */
export const DAEMON_PORT = 47821

export interface IntegrationOptions {
  port: number
  token: string
  statusLineCommand: string
}

export interface IntegrationResult {
  settings: Record<string, unknown>
  /** Emberi olvasásra szánt leírások arról, amit szándékosan nem írtunk felül. */
  conflicts: string[]
}

const HOOK_ROUTES: Readonly<Record<string, string>> = {
  Notification: 'notification',
  SessionStart: 'lifecycle/start',
  SessionEnd: 'lifecycle/end',
  Stop: 'lifecycle/stop',
}

const TOKEN_ENV = 'CLAUDESWITCHER_TOKEN'
const PORT_ENV = 'CLAUDESWITCHER_PORT'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Igaz, ha egy matcher-csoport a mienk: van benne hook, aminek az `allowedEnvVars`-ában
 * szerepel a `CLAUDESWITCHER_TOKEN`. Portfüggetlen, így egy portváltás után is felismerjük
 * a régi telepítést.
 */
export function isOurHookEntry(entry: unknown): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false
  return entry.hooks.some(
    (hook) =>
      isPlainObject(hook) &&
      Array.isArray(hook.allowedEnvVars) &&
      hook.allowedEnvVars.includes(TOKEN_ENV),
  )
}

/** Igaz, ha a status line a mi scriptünket futtatja. */
export function isOurStatusLine(statusLine: unknown): boolean {
  return (
    isPlainObject(statusLine) &&
    typeof statusLine.command === 'string' &&
    /[\\/]packages[\\/]statusline[\\/]dist[\\/]main\.js/.test(statusLine.command)
  )
}

function ourHookEntry(port: number, route: string): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/hooks/${route}`,
        // Rövid timeout: display-only hookok, nem tudnak és nem is akarnak blokkolni.
        timeout: 5,
        headers: { Authorization: `Bearer $${TOKEN_ENV}` },
        allowedEnvVars: [TOKEN_ENV],
      },
    ],
  }
}

/**
 * A telepítés tiszta transzformációja. Az M1 kizárólag nem blokkoló hookokat telepít — a
 * PermissionRequest az M2 hatásköre, addig egyetlen döntést sem veszünk el.
 *
 * Semmit nem töröl és nem ír felül, ami nem a mienk: az idegen hookok megmaradnak az
 * eseményük tömbjében, egy idegen vagy hibás alakú érték pedig ütközésként jelentődik.
 */
export function applyIntegration(
  existing: Record<string, unknown>,
  options: IntegrationOptions,
): IntegrationResult {
  const settings: Record<string, unknown> = { ...existing }
  const conflicts: string[] = []

  const rawHooks = existing.hooks
  if (rawHooks !== undefined && !isPlainObject(rawHooks)) {
    conflicts.push('A "hooks" érték nem objektum, ezért a hookokat nem telepítettük.')
  } else {
    const hooks: Record<string, unknown> = isPlainObject(rawHooks) ? { ...rawHooks } : {}
    for (const [event, route] of Object.entries(HOOK_ROUTES)) {
      const current = hooks[event]
      if (current !== undefined && !Array.isArray(current)) {
        conflicts.push(`A "hooks.${event}" érték nem tömb, ezért ezt az eseményt kihagytuk.`)
        continue
      }
      const list: unknown[] = Array.isArray(current) ? current : []
      const foreign = list.filter((entry) => !isOurHookEntry(entry))
      hooks[event] = [...foreign, ourHookEntry(options.port, route)]
    }
    settings.hooks = hooks
  }

  if (existing.statusLine === undefined || isOurStatusLine(existing.statusLine)) {
    settings.statusLine = { type: 'command', command: options.statusLineCommand, padding: 0 }
  } else {
    conflicts.push(
      'Már van saját status line beállítva, ezt nem írtuk felül — a limitek így nem jelennek meg.',
    )
  }

  const rawEnv = existing.env
  if (rawEnv !== undefined && !isPlainObject(rawEnv)) {
    conflicts.push('Az "env" érték nem objektum, ezért a portot és a tokent nem állítottuk be.')
  } else {
    settings.env = {
      ...(isPlainObject(rawEnv) ? rawEnv : {}),
      [PORT_ENV]: String(options.port),
      [TOKEN_ENV]: options.token,
    }
  }

  return { settings, conflicts }
}

/**
 * Az eltávolítás tiszta transzformációja: csak a saját bejegyzéseinket veszi ki, és a
 * kiürült `hooks` / `env` kulcsot is törli, így egy telepítés utáni eltávolítás pontosan az
 * eredeti beállításokat adja vissza.
 */
export function removeIntegration(existing: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...existing }

  const rawHooks = existing.hooks
  if (isPlainObject(rawHooks)) {
    const hooks: Record<string, unknown> = { ...rawHooks }
    for (const event of Object.keys(HOOK_ROUTES)) {
      const current = hooks[event]
      if (!Array.isArray(current)) continue
      const foreign = current.filter((entry) => !isOurHookEntry(entry))
      if (foreign.length === 0) delete hooks[event]
      else hooks[event] = foreign
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
    else settings.hooks = hooks
  }

  if (isOurStatusLine(existing.statusLine)) delete settings.statusLine

  const rawEnv = existing.env
  if (isPlainObject(rawEnv)) {
    const env: Record<string, unknown> = { ...rawEnv }
    delete env[PORT_ENV]
    delete env[TOKEN_ENV]
    if (Object.keys(env).length === 0) delete settings.env
    else settings.env = env
  }

  return settings
}

/** Telepít a felhasználó settings.json-jába. Az ütközések leírását adja vissza. */
export async function installIntegration(
  claudeDir: string,
  options: IntegrationOptions,
): Promise<string[]> {
  let conflicts: string[] = []
  await transformSettingsFile(userSettingsPath(claudeDir), (existing) => {
    const result = applyIntegration(existing, options)
    conflicts = result.conflicts
    return result.settings
  })
  return conflicts
}

/** Eltávolítja a saját bejegyzéseinket a felhasználó settings.json-jából. */
export function uninstallIntegration(claudeDir: string): Promise<void> {
  return transformSettingsFile(userSettingsPath(claudeDir), removeIntegration)
}
```

Run: `pnpm --filter @claudeswitcher/desktop test && pnpm --filter @claudeswitcher/desktop check-types`
Expected: PASS. Az eddigi **33** desktop teszt mellett 3 token- és 13 setup-teszt, összesen
**49**. (A terv korábban 46-ot mondott, mert még a Task 14 javítási körei előtt íródott: azok
adták a `useDaemonState.test.ts` 2 tesztjét és a `format.test.ts` egy új esetét. Ha 49-től
eltérőt látsz, azt jelentsd — ne igazíts hozzá semmit a számhoz.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/settings-writer.ts packages/core/src/settings-writer.test.ts packages/daemon/src/daemon.ts packages/daemon/src/daemon.test.ts apps/desktop/src/main/setup.ts apps/desktop/src/main/setup.test.ts apps/desktop/src/main/token.ts apps/desktop/src/main/token.test.ts
git commit -m "feat: lossless, idempotent integration install and uninstall with a fixed daemon port"
```

#### Task 15 — javítási kör 1

A felülvizsgálat két Important hibát talált, és mindkettő ugyanabból ered: **a „ez a mienk"
felismerés az egyik oldalon túl tág, a másikon túl durva.** A hookoknál a jelölő
(`CLAUDESWITCHER_TOKEN`) egyedi, de a *granularitás* rossz; a status line-nál a granularitás
jó, de a *jelölő* nem azonosít. A core és a daemon változásai minden próbát kiálltak — ez a
kör csak a `setup.ts`-t és a tesztjeit érinti.

Csak ez a két fájl változik: `apps/desktop/src/main/setup.ts`, `apps/desktop/src/main/setup.test.ts`.

**1. hiba — egy idegen status line-t a sajátunknak nézünk, felülírjuk, majd töröljük.**
Az `isOurStatusLine` egy horgonyozatlan útvonaltöredékre illeszt
(`packages/statusline/dist/main.js`), amiben egy termék neve sem szerepel. Ez egy elterjedt
elrendezés: bármely másik monorepo ugyanilyen status line-ja a mienknek látszik. A telepítés
**nulla ütközést jelentve** felülírja, az eltávolítás pedig kitörli a kulcsot. Ugyanez az út
nullázza a *saját* status line-unkon a felhasználó által beállított `padding`-et is.

**2. hiba — egy csoport, amiben a mi hookunk és egy idegen is benne van, egészben elvész.**
Az `isOurHookEntry` csoportszinten dönt („van benne a mi env-változónkra hivatkozó hook"), de
az `applyIntegration` és a `removeIntegration` az **egész csoportot** dobja el. A telepített
csoportunkon nincs `matcher`, tehát kézzel szerkesztve semmi nem jelzi, hogy az a mienk — és a
saját parancsot épp abba a `hooks` tömbbe befűzni a természetes mozdulat, hiszen az olvasatban
„az esemény hookjainak listája". A meglévő teszt a *testvér*-csoport esetét fedi; ez a beágyazott
eset a rés.

- [ ] **Fix Step 1: hook-szintű felismerés, URL-tartalékkal**

`apps/desktop/src/main/setup.ts` — az `isOurHookEntry` helyére:

```ts
/** A saját hook-végpontjaink útvonalai. */
const OUR_HOOK_PATHS = /^\/hooks\/(notification|lifecycle\/(start|end|stop))$/

/**
 * Igaz, ha EGY hook a mienk.
 *
 * Elsődleges jel: az `allowedEnvVars` hivatkozik a tokenünkre. Portfüggetlen, tehát egy
 * portváltás után is felismeri a régi telepítést.
 *
 * Tartalék jel: a saját loopback-végpontunkra mutat. Azért kell, mert az `allowedEnvVars`
 * nem feltétele annak, hogy a hook lefusson — csak az env-változó behelyettesítését
 * engedélyezi. Ha valaki kiveszi, a bejegyzés felismerhetetlen árvává válna: minden újabb
 * telepítés egy újabb duplikátumot tenne mellé, az eltávolítás pedig soha nem vinné el.
 */
export function isOurHook(hook: unknown): boolean {
  if (!isPlainObject(hook)) return false
  if (Array.isArray(hook.allowedEnvVars) && hook.allowedEnvVars.includes(TOKEN_ENV)) return true
  if (typeof hook.url !== 'string') return false
  try {
    const url = new URL(hook.url)
    return url.hostname === '127.0.0.1' && OUR_HOOK_PATHS.test(url.pathname)
  } catch {
    return false
  }
}

/**
 * Kiveszi a saját hookjainkat egy esemény matcher-csoportjaiból.
 *
 * HOOK-szinten dolgozik, nem csoportszinten: ha a felhasználó a saját parancsát a mi
 * csoportunk `hooks` tömbjébe fűzte be, a csoport egészének eldobása az ő hookját is
 * elvinné. Egy csoport csak akkor tűnik el, ha kizárólag a mi hookjainkból állt.
 */
function stripOurHooks(list: unknown[]): unknown[] {
  return list.flatMap((entry) => {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return [entry]
    const foreign = entry.hooks.filter((hook) => !isOurHook(hook))
    if (foreign.length === 0) return []
    if (foreign.length === entry.hooks.length) return [entry]
    return [{ ...entry, hooks: foreign }]
  })
}
```

Az `applyIntegration` hookágában a szűrés sora:
```ts
      const foreign = stripOurHooks(Array.isArray(current) ? current : [])
      hooks[event] = [...foreign, ourHookEntry(options.port, route)]
```
(a `const list: unknown[] = …` sor elhagyható)

A `removeIntegration` hookágában:
```ts
      const foreign = stripOurHooks(current)
```

- [ ] **Fix Step 2: a status line kifejezett jelölővel azonosítja magát**

`apps/desktop/src/main/setup.ts` — az `isOurStatusLine` helyére:

```ts
/**
 * Jelölő a status line parancsunk végén.
 *
 * Azért kell, mert az útvonal önmagában nem azonosít: a `packages/statusline/dist/main.js`
 * elrendezés nem a miénk, hanem elterjedt, és egy másik repó ugyanilyen status line-ját a
 * sajátunknak néznénk — ütközésjelzés nélkül felülírnánk, majd az eltávolításnál törölnénk.
 * A statusline scriptünk az argumentumait nem olvassa (a bemenete stdin), így a jelölő
 * ártalmatlan, viszont egyértelmű.
 */
export const STATUS_LINE_MARKER = '--claudeswitcher'

/** Igaz, ha a status line a mienk — a jelölőnk alapján, nem az útvonala alapján. */
export function isOurStatusLine(statusLine: unknown): boolean {
  return (
    isPlainObject(statusLine) &&
    typeof statusLine.command === 'string' &&
    statusLine.command.includes(STATUS_LINE_MARKER)
  )
}
```

Az `applyIntegration` status line ága:
```ts
  const previousStatusLine = existing.statusLine
  if (previousStatusLine === undefined || isOurStatusLine(previousStatusLine)) {
    const previousPadding = isPlainObject(previousStatusLine) ? previousStatusLine.padding : undefined
    settings.statusLine = {
      type: 'command',
      command: `${options.statusLineCommand} ${STATUS_LINE_MARKER}`,
      // A felhasználó által állított padding megmarad; enélkül minden újratelepítés
      // visszaállítaná nullára.
      padding: typeof previousPadding === 'number' ? previousPadding : 0,
    }
  } else {
```

- [ ] **Fix Step 3: tesztek — előbb RED**

`apps/desktop/src/main/setup.test.ts` — a `FOREIGN_STATUS_LINE` konstans cseréje egy olyanra,
ami a RÉGI felismerést becsapta volna, és négy új teszt.

```ts
/** Egy másik repó status line-ja, ugyanazzal az elterjedt útvonal-elrendezéssel. */
const FOREIGN_STATUS_LINE = {
  type: 'command',
  command: 'node /home/u/otherrepo/packages/statusline/dist/main.js',
  padding: 2,
}
```

Az `applyIntegration` describe blokkba:
```ts
  it('does not mistake another repo\'s statusline for ours', () => {
    // A régi felismerés puszta útvonaltöredékre illesztett, így ezt a sajátunknak nézte,
    // ütközésjelzés nélkül felülírta, majd az eltávolításnál törölte volna.
    const { settings, conflicts } = applyIntegration({ statusLine: FOREIGN_STATUS_LINE }, OPTIONS)
    expect(settings.statusLine).toEqual(FOREIGN_STATUS_LINE)
    expect(conflicts).toHaveLength(1)
  })

  it('keeps the padding the user set on our own status line', () => {
    const once = applyIntegration({}, OPTIONS).settings
    const tuned = { ...(once.statusLine as Record<string, unknown>), padding: 3 }
    const again = applyIntegration({ ...once, statusLine: tuned }, OPTIONS).settings
    expect((again.statusLine as Record<string, unknown>).padding).toBe(3)
  })

  it('keeps a foreign hook that sits inside our own matcher group', () => {
    // Kézzel szerkesztve ez a természetes mozdulat: a saját parancsot a meglévő `hooks`
    // tömbbe fűzni. Csoportszintű eldobás ezt is elvinné.
    const installed = applyIntegration({}, OPTIONS).settings as { hooks: HookGroups }
    const theirs = { type: 'command', command: 'their-beep' }
    installed.hooks.Stop![0]!.hooks.push(theirs)

    const hooks = applyIntegration(installed, OPTIONS).settings.hooks as HookGroups
    const survivors = hooks.Stop!.flatMap((group) => group.hooks)
    expect(survivors).toContainEqual(theirs)
    expect(removeIntegration({ hooks })).toEqual({ hooks: { Stop: [{ hooks: [theirs] }] } })
  })

  it('still recognises our hook after its allowedEnvVars is pruned', () => {
    // Az allowedEnvVars nem feltétele a futásnak, tehát kieshet. Enélkül a bejegyzés
    // felismerhetetlen árva lenne, és minden telepítés duplikálná.
    const installed = applyIntegration({}, OPTIONS).settings as { hooks: HookGroups }
    delete installed.hooks.Stop![0]!.hooks[0]!.allowedEnvVars

    const hooks = applyIntegration(installed, OPTIONS).settings.hooks as HookGroups
    expect(hooks.Stop).toHaveLength(1)
    expect(removeIntegration({ hooks }).hooks).toBeUndefined()
  })
```

Az `installs the status line and adds the two env vars beside existing ones` teszt elvárása
a jelölővel bővül:
```ts
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: `${OPTIONS.statusLineCommand} --claudeswitcher`,
      padding: 0,
    })
```

Run: `pnpm --filter @claudeswitcher/desktop test setup`
Expected: **előbb RED** a négy új teszten és a módosított status line elváráson, majd a
javítás után GREEN. A desktop összesen **53** teszt (49 + 4).

- [ ] **Fix Step 4: Commit**

```bash
git add apps/desktop/src/main/setup.ts apps/desktop/src/main/setup.test.ts
git commit -m "fix(desktop): identify our own entries precisely so an install cannot destroy foreign ones"
```

---

### Task 16: desktop — telepítés a tálcamenüből, és az M1 elfogadási teszt

**Files:**
- Modify: `apps/desktop/src/main/tray.ts` — `onInstall` és `onUninstall` menüpontok
- Modify: `apps/desktop/src/main/index.ts` — fix port, tartós token, telepítés-kezelők

**Interfaces:**
- Consumes: `DAEMON_PORT`, `installIntegration`, `uninstallIntegration`, `loadOrCreateToken` (Task 15)
- Produces: `createTray(options: { onOpen; onQuit; onInstall; onUninstall })`

**A telepítés kifejezett művelet, nem induláskori mellékhatás.** Az app indulása soha nem
ír a felhasználó `settings.json`-jába. A telepítést és az eltávolítást a felhasználó
indítja a tálcamenüből. Ez azt is jelenti, hogy a lenti korlátos indítás **nem módosíthatja**
a valódi beállításokat — és ezt mérni is kell.

- [ ] **Step 1: A tálcamenü két új pontja**

`apps/desktop/src/main/tray.ts` — a `createTray` szignatúrája és a menü:

```ts
export function createTray(options: {
  onOpen(): void
  onQuit(): void
  onInstall(): void
  onUninstall(): void
}): TrayHandle {
```

```ts
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Megnyitás', click: options.onOpen },
      { type: 'separator' },
      { label: 'Claude Code integráció telepítése', click: options.onInstall },
      { label: 'Claude Code integráció eltávolítása', click: options.onUninstall },
      { type: 'separator' },
      { label: 'Kilépés', click: options.onQuit },
    ]),
  )
```

- [ ] **Step 2: Fix port, tartós token és a kezelők**

`apps/desktop/src/main/index.ts` — új importok:
`import { DAEMON_PORT, installIntegration, uninstallIntegration } from './setup.js'` és
`import { loadOrCreateToken } from './token.js'`.

A `startDaemon` hívás cseréje az `app.whenReady()` elején:

```ts
  // A token tartós, a port rögzített: a telepített hookok és a statusLine ezeket kapják
  // a settings.json-ban, így az app újraindítása után is érvényesek maradnak. Foglalt
  // porton a startDaemon elutasít, és az indulási hibadialógus jelenik meg.
  const token = await loadOrCreateToken(app.getPath('userData'))
  daemon = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: createWin32ProcessProbe(),
    port: DAEMON_PORT,
    token,
  })
```

**Invariáns: a token EGYSZER töltődik be, és ugyanaz a `token` változó megy a `startDaemon`-nak,
az `installIntegration`-nek és — a `daemon.token`-en keresztül — a renderernek.** Ne olvasd
újra a tokenfájlt hívásonként, és ne generálj újat sehol. Azért fontos, mert a `hub.ts` a
WebSocket-upgrade *után* ellenőrzi a tokent (`close(1008)`), a renderer pedig minden
újracsatlakozási kísérletnél újra lekéri a `{port, token}` párt: ha a renderer valaha a
daemonétól eltérő tokent kapna, az `onopen` → `attempt = 0` → `onclose` ciklus másodpercenként
négy kísérlettel, végtelenül pörögne. Egyetlen forrásból származó tokennel ez elérhetetlen.

A `createTray` hívás cseréje:

```ts
  // Csak fejlesztői build: abszolút útvonal ennek a repónak a lefordított statusline
  // scriptjére. Ha a repó elköltözik vagy a dist törlődik, újra kell telepíteni.
  const statusLineCommand = `node "${path.join(dirname, '../../../../packages/statusline/dist/main.js')}"`

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  const tray = createTray({
    onOpen: () => showOverlay(),
    onQuit: () => app.quit(),
    onInstall: () => {
      installIntegration(resolveClaudeDir(), { port: DAEMON_PORT, token, statusLineCommand })
        .then((conflicts) => {
          void dialog.showMessageBox({
            type: conflicts.length === 0 ? 'info' : 'warning',
            title: 'ClaudeSwitcher',
            message:
              conflicts.length === 0
                ? 'A Claude Code integráció telepítve.'
                : 'A Claude Code integráció csak részben települt.',
            detail: [
              ...conflicts,
              'Az újonnan indított Claude Code sessionök már jelentenek. A már futó sessionöket lehet, hogy újra kell indítani.',
            ].join('\n\n'),
          })
        })
        .catch((error: unknown) => {
          dialog.showErrorBox('A telepítés nem sikerült', describeError(error))
        })
    },
    onUninstall: () => {
      uninstallIntegration(resolveClaudeDir())
        .then(() => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'ClaudeSwitcher',
            message: 'A Claude Code integráció eltávolítva.',
          })
        })
        .catch((error: unknown) => {
          dialog.showErrorBox('Az eltávolítás nem sikerült', describeError(error))
        })
    },
  })
```

- [ ] **Step 3: Build, típusellenőrzés, és bizonyíték, hogy az indítás nem ír a beállításokba**

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop build && pnpm --filter @claudeswitcher/desktop check-types && pnpm test`
Expected: mind exit 0; a teljes workspace tesztcsomag zöld.

A korlátos indítás a Task 14 Step 8 mintájára (`ELECTRON_RUN_AS_NODE` törölve,
`ELECTRON_ENABLE_LOGGING=1`), **előtte és utána** a valódi beállítások ujjlenyomatával:

```powershell
$settings = "$env:USERPROFILE\.claude\settings.json"
$before = (Get-FileHash $settings).Hash
$keysBefore = ((Get-Content $settings -Raw | ConvertFrom-Json).PSObject.Properties.Name) -join ','
# ... korlátos indítás ...
$after = (Get-FileHash $settings).Hash
$keysAfter = ((Get-Content $settings -Raw | ConvertFrom-Json).PSObject.Properties.Name) -join ','
"hash unchanged: $($before -eq $after)"
"keys before: $keysBefore"
"keys after:  $keysAfter"
```

Expected:
- A három ismert sor megjelenik (`daemon on 127.0.0.1:47821, … fast focus available`,
  `tray ready, hotkey … registered`, `[overlay] live updates connected`). **A port most
  47821** — ha más, a fix port nem érvényesült.
- **A hash változatlan, és nincs új `hooks`, `statusLine` vagy `env` kulcs.** Ez bizonyítja,
  hogy az indulás nem telepít. Ha a hash mégis eltér, de a kulcsok azonosak, a Claude Code
  írhatott a fájlba az indítás alatt — ezt jelenteni kell, nem feltételezni.
- A tokenfájl létrejött az Electron `userData` könyvtárában (`%APPDATA%\@claudeswitcher\desktop\daemon-token`).

Ablak nem jelenik meg. A telepítést egy ágens **nem** indítja el — az a felhasználó dolga
a Step 5-ben.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/tray.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): install and uninstall the Claude Code integration from the tray menu"
```

- [ ] **Step 5: Az M1 elfogadási teszt — a felhasználó végzi**

Ez az egyetlen lépés, ami a valódi `~/.claude/settings.json`-ba ír, és minden olyat
ellenőriz, amit ágens nem tudott: billentyűket, ablakváltást, és a hookok élő bekötését.

1. A repo gyökerében: `pnpm build`.
2. Biztonsági másolat:
   `Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak"`
3. Indítsd az appot **egy önálló PowerShell ablakból** — ne a VSCode beépített
   termináljából, mert az `ELECTRON_RUN_AS_NODE`-ot örökít, és az app nem indul el:
   `pnpm --filter @claudeswitcher/desktop start`
4. Tálcaikon → **Claude Code integráció telepítése**. Várt: „telepítve" üzenet, ütközés nélkül.
5. A `settings.json`-ban a `permissions`, `model`, `enabledPlugins`, `effortLevel`,
   `autoUpdatesChannel`, `switchModelsOnFlag` és `tui` **változatlan**, mellettük új
   `hooks`, `statusLine` és `env`.
6. Indíts egy **új** Claude Code sessiont. A TUI alján megjelenik a status line
   (modell · mappa · ág · 5h % · 7d %), és pár másodpercen belül a limitek az overlay alján.
7. Kérj a sessiontől egy engedélyköteles műveletet. A tálcaikon narancsra vált; az overlayben
   (`Shift+Alt+Space`) a session legfelül, `●` jelöléssel. **A natív prompt a VSCode-ban
   ugyanúgy megjelenik** — az M1 semmit nem vesz el.

   **7b. Subagent engedélykérése — mérés, nem feltételezés.** Kérj olyan műveletet, ahol egy
   **subagent** kér engedélyt (pl. adj a sessionnek olyan taskot, amit subagenttel végez el,
   és a subagent futtat egy engedélyköteles parancsot). Jegyezd fel, MELYIK igaz:
   (a) a szülő session `●` várakozóra vált — akkor a hook a szülő azonosítójával jön, és ez
   jó nekünk; (b) semmi nem történik az overlayben — akkor a `Notification` hook subagentre
   nem tüzel, és a rá várakozó munka láthatatlan; (c) új sor jelenik meg — akkor a subagent
   önálló sessionként regisztrálódik.
   Miért külön pont: a subagentek aktivitását a transzkriptből amúgy is olvassuk (a sidechain
   bejegyzéseket nem szűrjük), de az ENGEDÉLYKÉRÉS hookon jön, és a spec §10 szerint a hookok
   lefedettsége mérésre szorul. Ez a válasz dönti el, hogy az M2 megoldható-e csak hookokkal,
   vagy a subagent-promptokhoz más jel is kell.
8. **Válaszolj a promptra a VSCode-ban, sima „Yes"-szel** (ne „don't ask again"-nel, mert az
   a 14. pont összevetését elrontaná). Pár másodpercen belül a session **kilép a várakozásból**.
   Ha nem, a `Stop` hook bekötése hibás.
9. Kattints egy másik alkalmazásba (pl. böngésző), és onnan nyomd meg a `Shift+Alt+Space`-t.
   Az overlay a kurzor melletti kijelzőn jelenik meg, **és a nyilak mozgatják a kijelölést**.
   Ha az overlay látszik, de a nyilakra nem reagál, a Windows megtagadta tőle a fókuszt.
10. Válassz egy sessiont, aminek a VSCode ablaka más ablakok mögött van, és nyomj Entert. Az
    ablak előre jön, az overlay eltűnik.
11. Nyitott overlay mellett érj el, hogy egy **másik** session várakozni kezdjen. A kijelölés
    **azon a sessionön marad**, amit előtte kiválasztottál, akkor is, ha a lista átrendeződik.
12. **Alvás és ébredés.** Altasd el a gépet (vagy csukd le a laptopot), majd ébreszd fel, és
    nyisd meg az overlayt. A listának **élőnek kell lennie**: indíts egy új sessiont vagy
    zárj be egyet, és az overlaynek pár másodpercen belül követnie kell.
    Miért ez a lépés: a felülvizsgálat kimutatta, hogy a WebSocketet semmi nem pingeli, tehát
    egy félig nyitva maradt kapcsolat esetén az overlay „kapcsolódva" állapotban ragadna egy
    néma, elavult listával — épp az alvás/ébredés eset, amire az újracsatlakozás készült. A
    kapcsolat egyetlen Electron-processzen belül, 127.0.0.1-en fut, ezért ezt nem tartom
    elérhetőnek — de ez érvelés, nem mérés, és ez a lépés méri le. Ha a lista megáll, vagy a
    lábléc „kapcsolat megszakadt — újracsatlakozás…" feliratban ragad, azt jelentsd: a javítás
    egy periodikus ping, nem nagy munka.
13. **A gyorsbillentyű állítható.** A tálcamenü felső részén látszik az élő kombináció, és
    hogy sikerült-e lefoglalni. A `Ctrl+Alt+Space`-t a Claude desktop app foglalja (lemérve:
    a regisztráció következetesen elbukott rá), ezért az alapérték `Shift+Alt+Space`, ami az
    `AltGr`-t is elkerüli — a `Control+Alt` Windowson azonos az AltGr-rel, tehát a régi
    választás magyar kiosztáson a `@` (`AltGr+V`) utáni szóközt is elnyelte volna.
    Ha át akarod állítani: tálcamenü → **Gyorsbillentyű átállítása…**, írd át a `hotkey`
    értékét, majd indítsd újra az appot. Ellenőrizd, hogy az új kombináció él, és a
    tálcamenü azt mutatja. Egy elrontott fájl nem akadályozza az indulást: ilyenkor az
    alapértékre esik vissza, és a fájlt érintetlenül hagyja, hogy ki tudd javítani.
14. Tálcaikon → **Claude Code integráció eltávolítása**, majd hasonlítsd össze a mentéssel:
    ```powershell
    node -e "const fs=require('fs'),u=require('util');const r=p=>JSON.parse(fs.readFileSync(p,'utf8'));console.log(u.isDeepStrictEqual(r(process.argv[1]),r(process.argv[2]))?'EQUAL':'DIFFERENT')" "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak"
    ```
    Várt: `EQUAL`.

Ha bármelyik lépés elbukik, állítsd vissza a mentést, mielőtt a hibát keresnéd:
`Copy-Item "$env:USERPROFILE\.claude\settings.json.bak" "$env:USERPROFILE\.claude\settings.json" -Force`

---

## M1 elfogadási kritériumok

Gépi ellenőrzések (ágens végzi):

- [ ] `pnpm test` zöld a repo gyökerében.
- [ ] `pnpm check-types` és `pnpm build` hibátlan.
- [ ] A korlátos indítás három sora megjelenik: `daemon on 127.0.0.1:47821, N session(s)
      discovered, fast focus available`, `tray ready, hotkey … registered`, és
      `[overlay] live updates connected`.
- [ ] Az `N` egyezik a `~/.claude/sessions/*.json` fájlok valódi számával.
- [ ] Az indítás **nem** módosítja a `~/.claude/settings.json`-t.

Emberi ellenőrzések (a Task 16 Step 5 elfogadási tesztje):

- [ ] A telepítés után a `settings.json` minden korábbi kulcsa érintetlen.
- [ ] A status line megjelenik egy új sessionben, és a limitek az overlay alján.
- [ ] A tálcaikon a várakozó sessionök számát tükrözi.
- [ ] `Ctrl+Alt+Space` megmutatja az élő sessionöket, **és a nyilak működnek** akkor is,
      ha egy másik alkalmazásból nyitod.
- [ ] Enter a helyes VSCode ablakra ugrik, akkor is, ha az más ablakok mögött van.
- [ ] A kijelölés a kiválasztott sessionön marad, ha a lista közben átrendeződik.
- [ ] Egyetlen permission prompt sem tűnt el a VSCode-ból — az M1 nem vesz el döntést.
- [ ] A VSCode-ban megválaszolt prompt után a session kilép a várakozásból.
- [ ] Az eltávolítás után a `settings.json` a mentéssel megegyezik.
- [ ] Döntés a `Ctrl+Alt+Space` és az `AltGr+Space` ütközéséről.

## Szándékosan M2-be halasztva a spec §7-ből

A spec az `apps/desktop` leírásában sessiononkénti **Remote Control deep linket
és QR kódot** is előír a `bridgeSessionId`-ből. Ez az M1-ben nem valósul meg,
mert a claude.ai session-URL alakja mérendő (§10.5), és találgatásból generált
link rosszabb, mint semmi. Az M1 a mérhető felét szállítja: a lista jelzi, ha
egy sessionnek nincs Remote Control kapcsolata. A deep link és a QR az M2 első
feladata, amint a spike megvan.

## Az M2 tervezése előtt kimérendő

A spec §10 pontjai. Az M1 egyikre sem támaszkodik, de az M2 mindegyikre igen:

1. A `PermissionRequest` pontosan mely tool-hívásokra fut le (Bash, Edit, Write,
   WebFetch, MCP tool, plan-mode kilépés, folder-trust).
2. Az elengedett hook (üres 200) tényleg natív promptot ad-e, ami végtelenségig vár.
3. Az interception elveszi-e a promptot a Remote Controltól.
4. A hook `timeout` elfogad-e 600-nál nagyobb értéket.
5. A claude.ai session-URL alakja a `bridgeSessionId`-ből.
