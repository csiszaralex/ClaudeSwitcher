# ClaudeSwitcher M2 — Approve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Az overlayből lehessen dönteni egy Claude Code engedélykérésről — engedélyezés, tiltás indoklással, projekt- és gépszintű szabály szerkeszthető előnézettel, kérdés megválaszolása, terv elutasítása visszajelzéssel —, miközben a natív prompt a VSCode-ban és a telefonon végig megmarad, és az első döntés nyer.

**Architecture:** A `core` két tiszta modult kap: az egyik a `PermissionRequest` törzsét értelmezi és sorolja be (`tool` / `edit` / `question` / `plan`), a másik a felhasználó döntéséből építi a hook válasz-JSON-ját, és ott őrzi a tiltásokat (kérdést csak válasszal, tervet soha nem enged). A `daemon` egy `DecisionBroker`-t kap, ami a tartott HTTP kéréseket birtokolja, a natív döntést a `PreToolUse`→`PostToolUse` `tool_use_id`-n át ismeri fel, és 590 mp-nél elenged. Az Electron main IPC-n adja tovább a renderer döntését, a renderer pedig a kijelölt sessionhöz kinyíló döntési panelt kap. Az első feladat a teljes kódbázis szigorítása (TypeScript + typescript-eslint), hogy minden további kód ezen a hálón menjen át.

**Tech Stack:** TypeScript (a legszigorúbb kapcsolókkal), typescript-eslint `strict-type-checked`, pnpm workspace + Nx, Vitest, Hono + `@hono/node-server`, `ws`, Electron + electron-vite + React 19.

**Spec:** `docs/superpowers/specs/2026-09-04-claudeswitcher-design.md` (a 2026-10-08-i revízió: §3.4, §3.6, §5, §7, §8, §9, §10, §11). Mérési háttér: `spikes/m2-permission/RESULTS.md`.

## Global Constraints

Az M1 terv Global Constraints szakasza továbbra is érvényes (TDD-bizonyíték szó szerinti
futtatókimenettel; tesztfájlok típusellenőrzése `tsconfig.check.json`-nal; az
`ELECTRON_RUN_AS_NODE` törlése minden Electron-indítás előtt; Windows-only; Node 22+, pnpm 11+;
`CLAUDE_CONFIG_DIR`; liveness pid **és** creation time; csak `127.0.0.1` + bearer token;
workspace-függőségek a `dist/`-en át, `pnpm build` a közvetlen `pnpm --filter` hívások előtt;
React 19: `import type { JSX } from 'react'`). Ezen felül:

- **Szigorúság — a felhasználó kifejezett kérése: „a kód legyen a lehető legszigorúbb
  mindenhol, mert ez háló a munkának".** Az 1. feladat után a `tsconfig.base.json` a lent
  felsorolt összes kapcsolót tartalmazza, és a `typescript-eslint` `strict-type-checked`
  szabálykészlete fut. **Minden feladat végén `pnpm check-types` és `pnpm lint` exit 0.**
  Tilos: `eslint-disable` komment, `@ts-ignore`, `@ts-expect-error`, `as any`, `as unknown as`,
  és termékkódban a non-null assertion (`x!`). Ha egy szabály láthatóan rosszat követel, azt
  jelenteni kell, nem elnémítani.
- **Hook payloadok csak mért alakban.** Claude Code-tól érkező törzset a tesztek kizárólag a
  `packages/core/fixtures/hook-payloads.json`-ból vesznek (a spike naplójából kiemelt valódi
  törzsek). Kézzel kitalált payload-alak tilos: az M1-ben a dokumentációra hagyatkozás egy rossz
  mezőnevet eredményezett, ami pont úgy nézett ki, mint a hiányzó adat.
- **Szabályt az app soha nem ír fájlba.** Projekt- és gépszintű szabály kizárólag a hook
  válaszának `updatedPermissions` mezőjén át kerül be — a beírást a Claude Code végzi (spike K4,
  K5).
- **Kérdés csak válasszal, terv soha.** `AskUserQuestion`-re `allow` csak a felhasználó által
  megadott válaszokkal mehet ki; `ExitPlanMode`-ra `allow` soha (a Claude Code figyelmen kívül
  hagyja — spike K2, K2b, K2c). Ezt a `core` `buildHookResponse` kényszeríti ki, nem a UI.
- **Minden tartott kérés pontosan egyszer kap választ.** A daemon leállításakor a
  `DecisionBroker.releaseAll()` a `server.close()` **előtt** fut: a nyitva hagyott tartott
  kapcsolatok miatt a `server.close()` különben soha nem térne vissza.
- **Időzítés:** a `PermissionRequest` hook `timeout`-ja 600 mp, a daemon 590 mp-nél enged el
  (`RELEASE_AFTER_MS`). A Node HTTP-szerver `requestTimeout`-ja csak a kérés *fogadására*
  vonatkozik, a tartott válaszra nem — lemérve (1000 ms-os korlát mellett egy 3 mp-ig tartott
  válasz rendben megérkezett). A szerver időkorlátjaihoz ezért nem kell nyúlni.
- **IPC bemenet `unknown`.** A rendereren át érkező minden IPC-argumentumot a main processz
  `unknown`-ként fogad és ellenőriz, mielőtt a daemonnak továbbadná.
- **A felhasználó valódi `~/.claude/settings.json`-jához ágens nem ér**, billentyűt nem nyom,
  ablakot nem hoz előtérbe. Az Electron-ellenőrzés korlátos indítás (az M1 Task 16 mintája:
  `ELECTRON_RUN_AS_NODE` törölve, `ELECTRON_ENABLE_LOGGING=1`, `electron.exe` közvetlenül, egy
  előtérbeli blokkban indít–vár–leállít, és a `settings.json` hash-e előtte és utána egyezik).

## Fájltérkép

| Fájl | Feladat | Felelősség |
|---|---|---|
| `tsconfig.base.json`, `eslint.config.mjs`, `nx.json`, `package.json`-ok | 1 | szigorú fordító és linter, `lint` cél minden csomagban |
| `packages/core/src/decision.ts` (+ teszt) | 2 | `PermissionRequest` értelmezése és besorolása |
| `packages/core/src/decision-response.ts` (+ teszt) | 3 | döntés → hook válasz; a tiltások őrzője; IPC-döntés ellenőrzése |
| `packages/core/src/rule-text.ts` (+ teszt) | 3 | szabály ⇄ szerkeszthető szöveg |
| `packages/daemon/src/decision-broker.ts` (+ teszt) | 4 | a tartott kérések állapotgépe |
| `packages/daemon/src/hook-server.ts`, `daemon.ts`, `session-store.ts` (+ tesztek) | 5 | új hook-route-ok, bekötés, `state().decisions`, `decide()` |
| `apps/desktop/src/main/setup.ts` (+ teszt) | 6 | az új hookok telepítése, a régi `SessionStart` kivezetése |
| `apps/desktop/src/main/index.ts`, `preload/index.ts`, `renderer/state-message.ts`, `renderer/useDaemonState.ts` | 7 | IPC és állapot a rendererig |
| `apps/desktop/src/renderer/decision-keys.ts` (+ teszt), `DecisionPanel.tsx`, `RuleEditor.tsx`, `App.tsx`, `styles.css` | 8 | döntési panel: engedélyez, tilt, szabály, session-szerkesztés |
| `apps/desktop/src/renderer/question-form.ts` (+ teszt), `QuestionForm.tsx`, `PlanPanel.tsx` | 9 | kérdés-válasz és terv-elutasítás |
| — | 10 | a felhasználó elfogadási tesztje |

---

### Task 1: Szigorítás — fordító és linter a teljes kódbázison

**Files:**
- Modify: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Modify: `nx.json`
- Modify: `package.json` (gyökér — devDependencies)
- Modify: `packages/core/package.json`, `packages/daemon/package.json`, `packages/statusline/package.json`, `apps/desktop/package.json` — `lint` script
- Modify: a mért szabálysértések helyén a forráskód (lásd Step 4 táblázata)

**Interfaces:**
- Consumes: —
- Produces: `pnpm lint` cél; a további feladatok kódja ezekkel a kapcsolókkal fordul. **Az
  `apps/desktop/src/main/index.ts`-ben a daemon a `const running` nevű, nem-null konstansban
  érhető el** — a 7. feladat erre hivatkozik.

**Miért ez az első feladat.** A felhasználó kérése szerint a kód legyen a lehető legszigorúbb,
mert ez háló a munkának. Ha ez a végére kerülne, az M2 összes új kódja a szigorítás *nélkül*
születne, és utólag kellene átírni. Így minden további feladat már ezen a hálón megy át.

**Mérve a jelenlegi kódon (2026-10-08), hogy a feladat mérete ismert legyen:**

| Ellenőrzés | Találat |
|---|---|
| `noPropertyAccessFromIndexSignature` (TS4111) | 125 |
| `exactOptionalPropertyTypes` (TS2375, TS2379, TS2412, TS2322) | 8 |
| `noImplicitOverride` (TS4114) | 3 |
| `noImplicitReturns` (TS7030) | 1 |
| `noUnusedLocals` / `noUnusedParameters` (TS6133) | 1 |
| `isolatedModules`, `verbatimModuleSyntax` | 0 |
| typescript-eslint `strict-type-checked` | 77 (29 fájlban) + 13 elemzési hiba (a tesztfájlok — a `parserOptions.project` lent ezt megoldja) |

A lint-találatok szabályonként: `no-non-null-assertion` 21, `restrict-template-expressions` 14,
`no-confusing-void-expression` 13, `unbound-method` 6, `no-unnecessary-type-conversion` 3,
`no-dynamic-delete` 3, `no-unnecessary-condition` 3, `no-unnecessary-type-assertion` 1.
**`no-floating-promises`: 0** — az M1 review-jai után minden ígéret kezelve van.

- [ ] **Step 1: A fordító kapcsolói**

`tsconfig.base.json` — teljes tartalom:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Run: `pnpm check-types`
Expected: FAIL — a fenti mért hibák (~138). Ezt a Step 4 javítja.

- [ ] **Step 2: A linter**

```bash
pnpm add -Dw eslint@9 typescript-eslint@8
```

`eslint.config.mjs` (a repo gyökerében):

```js
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', 'spikes/**', 'eslint.config.mjs'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A build-tsconfig kizárja a teszteket, a check-tsconfig nem — típusinformáció nélkül a
        // tesztfájlok elemzési hibát adnának (lemérve: 13 ilyen).
        project: ['./packages/*/tsconfig.check.json', './apps/desktop/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Egy kimaradt `switch`-ág csendes hiba lenne — a döntés-fajtáknál (Task 2–3) pont ez a kockázat.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Szám a template stringben biztonságos; minden más (objektum, undefined) továbbra is hiba.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // A renderer böngészős csomag: a core fő belépési pontja Node-modulokat húz be (fs,
    // child_process), a daemon pedig szerver. Belőlük csak típus jöhet; érték csak a core
    // IO-mentes belépési pontjából (`@claudeswitcher/core/browser`, a 3. feladattól).
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@claudeswitcher/core',
              allowTypeImports: true,
              message: 'A rendererben értéket csak a @claudeswitcher/core/browser adhat.',
            },
            { name: '@claudeswitcher/daemon', allowTypeImports: true, message: 'A daemon szerver-kód.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      // Tesztben egy rossz `!` hangos tesztbukás, nem csendes termékhiba; a
      // `noUncheckedIndexedAccess` mellett a tesztek olvashatósága ezen múlik.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `expect(events.onX).toHaveBeenCalled()` — a vitest mockok így ellenőrizhetők.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
)
```

A `lint` script csomagonként (a gyökér `package.json`-ban a `"lint": "nx run-many -t lint"`
már megvan):

- `packages/core/package.json`, `packages/daemon/package.json`, `packages/statusline/package.json`
  — a `scripts`-be: `"lint": "eslint src"`
- `apps/desktop/package.json` — a `scripts`-be: `"lint": "eslint src electron.vite.config.ts"`

`nx.json` — a `targetDefaults` kiegészül (a típusos lintelés a függőségek `dist/` típusait olvassa):

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "targetDefaults": {
    "build": { "dependsOn": ["^build"], "cache": true },
    "test": { "dependsOn": ["^build"], "cache": true },
    "check-types": { "dependsOn": ["^build"], "cache": true },
    "lint": { "dependsOn": ["^build"], "cache": true },
    "dev": { "dependsOn": ["^build"], "cache": false }
  }
}
```

A `apps/desktop/package.json` `check-types` scriptje marad `tsc -p tsconfig.json --noEmit` — a
desktop `tsconfig.json`-ja a teszteket is tartalmazza (az M1 végső review-ja ellenőrizte).

Run: `pnpm lint`
Expected: FAIL — a mért ~77 találat, elemzési hiba nélkül.

- [ ] **Step 3: Mérd le magad, és jegyezd fel a kiinduló számokat**

Run: `pnpm check-types 2>&1 | Select-String "error TS" | Measure-Object` és `pnpm lint`
Expected: nagyjából a fenti táblázat. **A jelentésbe a valódi számok kerülnek.** Ha jelentősen
eltér (pl. kétszeres), állj meg és jelents — akkor a kód azóta változott, és a Step 4 szabályai
nem biztos, hogy fedik.

- [ ] **Step 4: Javítsd a kódot a szabályok szerint**

Minden szabálysértést **a kód** javításával kell megszüntetni, a táblázat szerinti módon.
Elnémítás (`eslint-disable`, `@ts-…`, `as any`, `as unknown as`) tilos.

| Szabály | Javítás |
|---|---|
| TS4111 `noPropertyAccessFromIndexSignature` | `obj.key` → `obj['key']`, ha `obj` típusa index-szignatúrás (`Record<string, unknown>`). Rögzített mezős interface-nél nem jelez — ott marad a pont |
| TS2375 / TS2379 / TS2412 / TS2322 `exactOptionalPropertyTypes` | Ha egy opcionális mezőbe legitim módon `undefined` kerülhet (pl. értelmezett bemenetből), a típus legyen `field?: T \| undefined`. Ha a mezőnek csak hiányoznia szabad, a hozzárendelés helyén maradjon el a kulcs (`...(value === undefined ? {} : { field: value })`) |
| TS4114 `noImplicitOverride` | `override` kulcsszó (React osztálykomponens `render`, `componentDidCatch`, `state`) |
| TS7030 `noImplicitReturns` | explicit `return` minden ágon |
| TS6133 | a nem használt név törlése; kötelező, de nem használt paraméternél `_` előtag |
| `no-non-null-assertion` (termékkód) | lásd lent az `index.ts`-t; máshol explicit ellenőrzés, ami hiba esetén dob vagy korán visszatér |
| `restrict-template-expressions` | nem-szám, nem-string értéknél `String(x)` vagy a mező explicit kiválasztása |
| `no-confusing-void-expression` | `() => valami()` rövid nyíl → `() => { valami() }` ott, ahol a visszatérési érték `void` |
| `no-dynamic-delete` | `delete obj[key]` helyett új objektum: `Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))` |
| `no-unnecessary-condition`, `no-unnecessary-type-conversion`, `no-unnecessary-type-assertion` | a fölösleges feltétel / konverzió / kényszerítés törlése — **előtte** győződj meg róla, hogy a típus tényleg kizárja az esetet; ha a futásidejű érték ettől eltérhet (pl. hálózatról jön), a típust kell pontosítani `unknown`-ra, nem a feltételt törölni |

**`packages/core/src/types.ts` — pontosan így.** A megosztott adattípusok opcionális mezői
értelmezett bemenetből kapnak értéket, ahol a `undefined` legitim; ezért mind `?: T | undefined`.
A Task 5 `session-store.ts`-e erre épül (lemérve: ezzel a daemon szigorú fordítása hibátlan).

`packages/core/src/types.ts` — teljes tartalom:

```ts
/** Nyers rekord a ~/.claude/sessions/<pid>.json fájlból. Nem dokumentált formátum. */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart?: string | undefined
  version?: string | undefined
  kind?: string | undefined
  entrypoint?: string | undefined
  name?: string | undefined
  bridgeSessionId?: string | null | undefined
}

/** Nyers rekord a ~/.claude/ide/<port>.lock fájlból. Nem dokumentált formátum. */
export interface IdeLock {
  port: number
  pid: number
  workspaceFolders: string[]
  ideName?: string | undefined
  transport?: string | undefined
}

export type SessionStatus = 'waiting' | 'working' | 'idle' | 'unknown'

export interface SessionActivity {
  lastAssistantText?: string | undefined
  runningTool?: string | undefined
  lastEventAt?: number | undefined
}

export interface LiveSession {
  record: SessionRecord
  window?: IdeLock | undefined
}

/** Amit a daemon a UI-nak küld. */
export interface SessionView {
  sessionId: string
  pid: number
  name: string
  cwd: string
  status: SessionStatus
  activity: SessionActivity
  windowPid?: number | undefined
  workspaceFolder?: string | undefined
  bridgeSessionId?: string | null | undefined
  waitingSince?: number | undefined
  notificationText?: string | undefined
}

export interface RateLimitWindow {
  used_percentage: number
  resets_at: number
}

export interface RateLimits {
  five_hour?: RateLimitWindow | undefined
  seven_day?: RateLimitWindow | undefined
  spend_limit?: RateLimitWindow | undefined
}
```

A `types.ts` változásának egy közvetlen következménye van: a renderer
`apps/desktop/src/renderer/format.ts` `summarize` függvényének paramétertípusában a
`notificationText?: string` legyen `notificationText?: string | undefined`, különben a
`summarize(view)` hívás egy `SessionView`-val nem fordul (lemérve: TS2379).

**`apps/desktop/src/main/index.ts` — pontosan így** (a 7. feladat ezekre a sorokra hivatkozik).
A `daemon = await startDaemon({` … `await daemon.refresh()` blokk és a három utána következő
`ipcMain.handle` helyére:

```ts
  // Egy helyi, nem-null konstans: a kezelők ezt fogják be, így nincs szükség `!`-re, és a típus
  // garantálja, hogy indulás után minden kezelő ugyanazt a futó daemont látja. A modulszintű
  // `daemon` csak a `before-quit`-nek kell.
  const running = await startDaemon({
    claudeDir: resolveClaudeDir(),
    probe: createWin32ProcessProbe(),
    port: DAEMON_PORT,
    token,
  })
  daemon = running
  await running.refresh()

  ipcMain.handle('daemon:connection', () => ({ port: running.port, token: running.token }))
  ipcMain.handle('daemon:state', () => running.state())

  ipcMain.handle('session:focus', async (_event, sessionId: unknown) => {
    // IPC-bemenet: a renderer bármit küldhet, ezért `unknown`, és itt ellenőrizzük.
    if (typeof sessionId !== 'string') return false
    const view = running.state().sessions.find((s) => s.sessionId === sessionId)
```

(A kezelő többi sora változatlan.) Ugyanebben a fájlban a további `daemon.` / `daemon!.`
hivatkozások — az indulási `console.log` és a `syncTray` — `running.`-ra cserélendők. A
`before-quit` kezelő `void daemon?.stop()` sora marad.

- [ ] **Step 5: Ellenőrzés**

Run: `pnpm check-types && pnpm lint && pnpm test && pnpm build`
Expected: mind exit 0. A tesztek száma **nem változik** (a jelenlegi: core 68, statusline 9,
daemon 49, desktop 67 — ha eltér, a jelentésben szerepeljen a valódi szám és az ok).

Run: korlátos indítás (Global Constraints), a `settings.json` hash-ével előtte–utána.
Expected: `daemon on 127.0.0.1:47821`, `tray ready, hotkey … registered`,
`[overlay] live updates connected`; a hash változatlan.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: strictest TypeScript and typescript-eslint strict-type-checked across the repo"
```

---

### Task 2: core — a `PermissionRequest` értelmezése és besorolása

**Files:**
- Create: `packages/core/src/decision.ts`
- Test: `packages/core/src/decision.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `packages/core/fixtures/hook-payloads.json` (már a repóban — a spike valódi törzsei)
- Produces:
  - `parsePermissionRequest(body: unknown): PermissionRequestInfo | undefined`
  - `interface PermissionRequestInfo { sessionId: string; cwd: string; toolName: string; toolInput: Record<string, unknown>; agentId?: string | undefined; agentType?: string | undefined; kind: DecisionKind; summary: string; suggestedRules: PermissionRule[]; questions: AskQuestion[]; plan?: string | undefined }`
  - `type DecisionKind = 'tool' | 'edit' | 'question' | 'plan'`
  - `interface PermissionRule { toolName: string; ruleContent?: string | undefined }`
  - `type RuleDestination = 'localSettings' | 'userSettings'`
  - `interface AskQuestion { question: string; header?: string | undefined; multiSelect: boolean; options: AskOption[] }`
  - `interface AskOption { label: string; description?: string | undefined }`

**Miért a mért alak.** A spike 15 valódi törzset rögzített (`packages/core/fixtures/hook-payloads.json`).
Három részletük nem következik a dokumentációból, és a kód mindhármat kezeli: az MCP-tool
javasolt szabályának **nincs** `ruleContent`-je (a szabály maga a tool neve); a Write/Edit
javaslata nem szabály, hanem `setMode` — ezért ott `suggestedRules` üres; és a subagent kérése a
**szülő** `session_id`-jával jön, csak az `agent_id` különbözteti meg.

- [ ] **Step 1: A teszt**

`packages/core/src/decision.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePermissionRequest, type PermissionRequestInfo } from './decision.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/** A spike-ban rögzített valódi törzs. Hiányzó névnél dob, hogy egy elgépelés ne csússzon át. */
function fixture(name: string): unknown {
  const value = fixtures[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function parsed(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(fixture(name))
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

describe('parsePermissionRequest — a spike valódi payloadjai', () => {
  it.each([
    ['permissionRequest_bash', 'Bash', 'tool', 'echo spike-a > a.txt'],
    ['permissionRequest_write', 'Write', 'edit', 'P:\\08_Apps\\cs-spike\\b.txt'],
    ['permissionRequest_edit', 'Edit', 'edit', 'P:\\08_Apps\\cs-spike\\b.txt'],
    ['permissionRequest_webFetch', 'WebFetch', 'tool', 'https://example.com'],
    ['permissionRequest_mcp', 'mcp__claude-vscode__getDiagnostics', 'tool', 'mcp__claude-vscode__getDiagnostics'],
    ['permissionRequest_askSingle', 'AskUserQuestion', 'question', 'Mi legyen a k1.txt tartalma?'],
    ['permissionRequest_plan', 'ExitPlanMode', 'plan', 'Terv: c.txt létrehozása'],
  ] as const)('%s → %s, %s', (name, toolName, kind, summary) => {
    const info = parsed(name)
    expect(info.toolName).toBe(toolName)
    expect(info.kind).toBe(kind)
    expect(info.summary).toBe(summary)
    expect(info.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('identifies a subagent by agent_id, since it shares the parent session_id', () => {
    // Mérve: a subagent kérése a SZÜLŐ session_id-jával jön, csak ez különbözteti meg.
    const subagent = parsed('permissionRequest_subagent')
    const parent = parsed('permissionRequest_bash')
    expect(subagent.sessionId).toBe(parent.sessionId)
    expect(subagent.agentId).toBe('ad0b11acf46ef176e')
    expect(subagent.agentType).toBe('general-purpose')
    expect(parent.agentId).toBeUndefined()
  })

  it('flattens Claude Code\'s own rule suggestions and ignores everything but addRules', () => {
    expect(parsed('permissionRequest_bash').suggestedRules).toEqual([
      { toolName: 'Bash', ruleContent: 'echo spike-a *' },
    ])
    expect(parsed('permissionRequest_webFetch').suggestedRules).toEqual([
      { toolName: 'WebFetch', ruleContent: 'domain:example.com' },
    ])
  })

  it('keeps an MCP suggestion without ruleContent — the rule is the tool name itself', () => {
    const [rule] = parsed('permissionRequest_mcp').suggestedRules
    expect(rule?.toolName).toBe('mcp__claude-vscode__getDiagnostics')
    expect(rule?.ruleContent).toBeUndefined()
  })

  it('offers no rule for a file write, whose suggestion is a mode change', () => {
    // A Write/Edit javaslata `setMode: acceptEdits` a sessionre, nem fájlba írható szabály.
    expect(parsed('permissionRequest_write').suggestedRules).toEqual([])
  })

  it('parses single- and multi-select questions with their options', () => {
    const { questions } = parsed('permissionRequest_askMulti')
    expect(questions.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)])).toEqual([
      ['Milyen gyümölcsöket szeretsz?', true, ['Alma', 'Banán', 'Eper', 'Narancs']],
      ['Mi a kedvenc színed?', false, ['Piros', 'Kék', 'Zöld']],
    ])
  })

  it('carries the plan text only for ExitPlanMode', () => {
    expect(parsed('permissionRequest_plan').plan?.startsWith('# Terv: c.txt létrehozása')).toBe(true)
    expect(parsed('permissionRequest_bash').plan).toBeUndefined()
    expect(parsed('permissionRequest_bash').questions).toEqual([])
  })

  it('returns undefined for anything that is not a usable request, and never throws', () => {
    for (const garbage of [null, 42, 'x', [], {}, { session_id: 's' }, { tool_name: 'Bash' }]) {
      expect(() => parsePermissionRequest(garbage)).not.toThrow()
      expect(parsePermissionRequest(garbage)).toBeUndefined()
    }
  })

  it('tolerates a missing tool_input by summarising with the tool name', () => {
    const info = parsePermissionRequest({ session_id: 's', tool_name: 'Bash' })
    expect(info?.toolInput).toEqual({})
    expect(info?.summary).toBe('Bash')
  })
})
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @claudeswitcher/core test decision`
Expected: FAIL — `Cannot find module './decision.js'` (a Global Constraints szerinti alak).

- [ ] **Step 3: Az implementáció**

`packages/core/src/decision.ts`:

```ts
/**
 * A PermissionRequest hook bemenetének értelmezése. Tiszta függvények, IO nélkül.
 *
 * A bemenet alakja a VSCode bővítményben MÉRVE (spikes/m2-permission/RESULTS.md), nem a
 * dokumentációból: a tesztek a packages/core/fixtures/hook-payloads.json valódi törzseit
 * használják.
 */

/** Egy jogosultsági szabály, ahogy a Claude Code `permission_suggestions`-ben adja. */
export interface PermissionRule {
  toolName: string
  /** Pl. `echo spike-a *`. MCP-toolnál nincs: ott a szabály maga a tool neve. */
  ruleContent?: string | undefined
}

/** Hova írja a Claude Code a szabályt: a projekt helyi beállításaiba, vagy a gépszintűbe. */
export type RuleDestination = 'localSettings' | 'userSettings'

export interface AskOption {
  label: string
  description?: string | undefined
}

export interface AskQuestion {
  question: string
  header?: string | undefined
  multiSelect: boolean
  options: AskOption[]
}

/**
 * Mit kínál az overlay a kérésre (spec §5 táblázata):
 * - `tool`: parancs, WebFetch, MCP — engedélyez / tilt / projekt- vagy gépszintű szabály
 * - `edit`: fájlírás — engedélyez / tilt / erre a sessionre automatikus szerkesztés
 * - `question`: AskUserQuestion — csak a felhasználó válaszával engedhető tovább
 * - `plan`: ExitPlanMode — elutasítható visszajelzéssel; jóváhagyni a hookból nem lehet
 */
export type DecisionKind = 'tool' | 'edit' | 'question' | 'plan'

export interface PermissionRequestInfo {
  sessionId: string
  cwd: string
  toolName: string
  toolInput: Record<string, unknown>
  /** Csak subagent kérésénél van. A subagent a SZÜLŐ session_id-jával jön; ez különbözteti meg. */
  agentId?: string | undefined
  agentType?: string | undefined
  kind: DecisionKind
  /** Egysoros leírás: a parancs, a fájl, az URL, az első kérdés vagy a terv címe. */
  summary: string
  /** A Claude Code `addRules` javaslatai, kilapítva. Üres, ha nincs (pl. Write/Edit). */
  suggestedRules: PermissionRule[]
  /** Csak `question` fajtánál nem üres. */
  questions: AskQuestion[]
  /** Csak `plan` fajtánál van. */
  plan?: string | undefined
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function kindOf(toolName: string): DecisionKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  if (EDIT_TOOLS.has(toolName)) return 'edit'
  return 'tool'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskOption[] = []
  for (const option of raw) {
    if (!isRecord(option)) continue
    const label = str(option['label'])
    if (label === undefined) continue
    options.push({ label, description: str(option['description']) })
  }
  return options
}

function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const question = str(item['question'])
    if (question === undefined) continue
    questions.push({
      question,
      header: str(item['header']),
      multiSelect: item['multiSelect'] === true,
      options: parseOptions(item['options']),
    })
  }
  return questions
}

function parseSuggestedRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return []
  const rules: PermissionRule[] = []
  for (const suggestion of raw) {
    if (!isRecord(suggestion) || suggestion['type'] !== 'addRules') continue
    const list = suggestion['rules']
    if (!Array.isArray(list)) continue
    for (const rule of list) {
      if (!isRecord(rule)) continue
      const toolName = str(rule['toolName'])
      if (toolName === undefined) continue
      rules.push({ toolName, ruleContent: str(rule['ruleContent']) })
    }
  }
  return rules
}

function summarize(
  kind: DecisionKind,
  toolName: string,
  input: Record<string, unknown>,
  questions: readonly AskQuestion[],
): string {
  if (kind === 'question') return questions[0]?.question ?? toolName
  if (kind === 'plan') {
    const title = str(input['plan'])
      ?.split('\n')
      .find((line) => line.trim() !== '')
    return title === undefined ? toolName : oneLine(title.replace(/^#+\s*/, ''))
  }
  const detail = str(input['command']) ?? str(input['file_path']) ?? str(input['url'])
  return detail === undefined ? toolName : oneLine(detail)
}

/** A PermissionRequest hook törzse, értelmezve; `undefined`, ha nem használható. Soha nem dob. */
export function parsePermissionRequest(body: unknown): PermissionRequestInfo | undefined {
  if (!isRecord(body)) return undefined
  const sessionId = str(body['session_id'])
  const toolName = str(body['tool_name'])
  if (sessionId === undefined || toolName === undefined) return undefined

  const rawInput = body['tool_input']
  const toolInput: Record<string, unknown> = isRecord(rawInput) ? rawInput : {}
  const kind = kindOf(toolName)
  const questions = kind === 'question' ? parseQuestions(toolInput['questions']) : []

  return {
    sessionId,
    cwd: str(body['cwd']) ?? '',
    toolName,
    toolInput,
    agentId: str(body['agent_id']),
    agentType: str(body['agent_type']),
    kind,
    summary: summarize(kind, toolName, toolInput, questions),
    suggestedRules: parseSuggestedRules(body['permission_suggestions']),
    questions,
    plan: kind === 'plan' ? str(toolInput['plan']) : undefined,
  }
}
```

`packages/core/src/index.ts` — új sor a végén: `export * from './decision.js'`

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @claudeswitcher/core test && pnpm --filter @claudeswitcher/core check-types && pnpm --filter @claudeswitcher/core lint`
Expected: PASS, a core tesztjei 68 → 83 (15 új: a 7 soros `it.each` + 8). check-types és lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decision.ts packages/core/src/decision.test.ts packages/core/src/index.ts
git commit -m "feat(core): parse and classify PermissionRequest from measured payloads"
```

---

### Task 3: core — döntés → hook válasz, a tiltások őrzője, és a szabály szövege

**Files:**
- Create: `packages/core/src/decision-response.ts`
- Create: `packages/core/src/rule-text.ts`
- Create: `packages/core/src/browser.ts` — IO-mentes belépési pont a renderernek
- Test: `packages/core/src/decision-response.test.ts`, `packages/core/src/rule-text.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json` (`exports`)

**Interfaces:**
- Consumes: `PermissionRequestInfo`, `PermissionRule`, `RuleDestination`, `parsePermissionRequest` (Task 2)
- Produces:
  - `type UserDecision = { type: 'allow' } | { type: 'deny'; message?: string | undefined } | { type: 'allow-with-rules'; rules: PermissionRule[]; destination: RuleDestination } | { type: 'allow-session-edits' } | { type: 'answer'; answers: Record<string, string> }`
  - `interface HookDecisionBody { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: Record<string, unknown> } }`
  - `type DecisionResult = { ok: true; body: HookDecisionBody } | { ok: false; reason: string }`
  - `buildHookResponse(request: PermissionRequestInfo, decision: UserDecision): DecisionResult`
  - `parseUserDecision(raw: unknown): UserDecision | undefined` — az IPC-határ ellenőrzője (Task 7)
  - `joinAnswerLabels(labels: readonly string[]): string`
  - `PLAN_APPROVAL_UNSUPPORTED: string`
  - `formatRule(rule: PermissionRule): string`
  - `parseRules(text: string): ParsedRules`, `type ParsedRules = { ok: true; rules: PermissionRule[] } | { ok: false; line: number; text: string }`

**A tiltások itt vannak, nem a UI-ban.** A spec két szabálya (kérdést csak válasszal, tervet
soha) a felhasználó munkáját védi: egy válasz nélkül továbbengedett kérdésnél a session rossz
feltevéssel megy tovább. Ha ez csak a UI-ban volna, egy UI-hiba áttörné. Itt a
`buildHookResponse` megtagadja a választ — a broker (Task 4) és az IPC (Task 7) is ezen megy át.

**A válaszformátum mérve.** A kérdés-válasz kulcsa a kérdés szövege, az értéke az opció
label-je (spike K1). Többválasztósnál a dokumentált `", "`-vel összefűzött szöveg: tömbként a
session ugyan helyesen értette, de a felület „Other"-ként mutatta (spike R1a). A tiltás
`message`-ét a modell megkapja (spike E), a terv-elutasítás visszajelzéséből újratervez (K3).

- [ ] **Step 1: A teszt — döntés-válasz**

`packages/core/src/decision-response.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePermissionRequest, type PermissionRequestInfo } from './decision.js'
import {
  buildHookResponse,
  joinAnswerLabels,
  parseUserDecision,
  PLAN_APPROVAL_UNSUPPORTED,
  type DecisionResult,
} from './decision-response.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function parsed(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(fixtures[name])
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

function decisionOf(result: DecisionResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.body.hookSpecificOutput.decision
}

const bash = parsed('permissionRequest_bash')
const write = parsed('permissionRequest_write')
const mcp = parsed('permissionRequest_mcp')
const askMulti = parsed('permissionRequest_askMulti')
const plan = parsed('permissionRequest_plan')

describe('buildHookResponse', () => {
  it('wraps every decision in the measured PermissionRequest envelope', () => {
    const result = buildHookResponse(bash, { type: 'allow' })
    expect(result).toEqual({
      ok: true,
      body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    })
  })

  it('refuses a bare allow for a question — it would continue without an answer', () => {
    expect(buildHookResponse(askMulti, { type: 'allow' }).ok).toBe(false)
  })

  it('refuses to approve a plan, which Claude Code ignores from a hook', () => {
    expect(buildHookResponse(plan, { type: 'allow' })).toEqual({ ok: false, reason: PLAN_APPROVAL_UNSUPPORTED })
  })

  it('denies with the trimmed message the model will read, or without one', () => {
    expect(decisionOf(buildHookResponse(bash, { type: 'deny', message: '  ne töröld  ' }))).toEqual({
      behavior: 'deny',
      message: 'ne töröld',
    })
    expect(decisionOf(buildHookResponse(bash, { type: 'deny' }))).toEqual({ behavior: 'deny' })
    expect(decisionOf(buildHookResponse(bash, { type: 'deny', message: '   ' }))).toEqual({ behavior: 'deny' })
  })

  it('rejects a plan only with feedback, because the session replans from it', () => {
    expect(buildHookResponse(plan, { type: 'deny' }).ok).toBe(false)
    expect(decisionOf(buildHookResponse(plan, { type: 'deny', message: 'a fájl neve más legyen' }))).toEqual({
      behavior: 'deny',
      message: 'a fájl neve más legyen',
    })
  })

  it('adds an edited rule at machine level, exactly as given', () => {
    // Mérve (K4, K5): a Claude Code egy általunk kitalált szabályt is beír, a megadott helyre.
    const decision = decisionOf(
      buildHookResponse(bash, {
        type: 'allow-with-rules',
        rules: [{ toolName: 'Bash', ruleContent: 'echo spike-a > a.txt' }],
        destination: 'userSettings',
      }),
    )
    expect(decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'echo spike-a > a.txt' }],
          behavior: 'allow',
          destination: 'userSettings',
        },
      ],
    })
  })

  it('omits ruleContent for an MCP rule instead of sending it as undefined', () => {
    const result = buildHookResponse(mcp, {
      type: 'allow-with-rules',
      rules: [{ toolName: 'mcp__claude-vscode__getDiagnostics' }],
      destination: 'localSettings',
    })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ruleContent')
  })

  it('refuses rules for a file write, and an empty rule list for anything', () => {
    expect(
      buildHookResponse(write, { type: 'allow-with-rules', rules: [{ toolName: 'Write' }], destination: 'localSettings' }).ok,
    ).toBe(false)
    expect(buildHookResponse(bash, { type: 'allow-with-rules', rules: [], destination: 'localSettings' }).ok).toBe(false)
  })

  it('switches the session to accept edits only for a file write', () => {
    expect(decisionOf(buildHookResponse(write, { type: 'allow-session-edits' }))).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(buildHookResponse(bash, { type: 'allow-session-edits' }).ok).toBe(false)
  })

  it('answers every question, keeping the original questions in updatedInput', () => {
    const answers = { 'Milyen gyümölcsöket szeretsz?': 'Alma, Banán', 'Mi a kedvenc színed?': 'levendula' }
    const decision = decisionOf(buildHookResponse(askMulti, { type: 'answer', answers }))
    expect(decision['behavior']).toBe('allow')
    expect(decision['updatedInput']).toEqual({ ...askMulti.toolInput, answers })
  })

  it('refuses an answer that leaves a question blank, or an answer to a non-question', () => {
    expect(
      buildHookResponse(askMulti, { type: 'answer', answers: { 'Milyen gyümölcsöket szeretsz?': 'Alma' } }).ok,
    ).toBe(false)
    expect(buildHookResponse(bash, { type: 'answer', answers: {} }).ok).toBe(false)
  })
})

describe('joinAnswerLabels', () => {
  it('joins with comma and space, the documented multi-select form', () => {
    expect(joinAnswerLabels(['Alma', 'Banán'])).toBe('Alma, Banán')
  })
})

describe('parseUserDecision — the IPC boundary', () => {
  it('accepts each well-formed decision', () => {
    expect(parseUserDecision({ type: 'allow' })).toEqual({ type: 'allow' })
    expect(parseUserDecision({ type: 'deny', message: 'x' })).toEqual({ type: 'deny', message: 'x' })
    expect(parseUserDecision({ type: 'deny' })).toEqual({ type: 'deny' })
    expect(parseUserDecision({ type: 'allow-session-edits' })).toEqual({ type: 'allow-session-edits' })
    expect(
      parseUserDecision({ type: 'allow-with-rules', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }] }),
    ).toEqual({ type: 'allow-with-rules', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }] })
    expect(parseUserDecision({ type: 'answer', answers: { q: 'a' } })).toEqual({ type: 'answer', answers: { q: 'a' } })
  })

  it('rejects anything malformed, and never throws', () => {
    for (const garbage of [
      null,
      'allow',
      { type: 'approve' },
      { type: 'deny', message: 7 },
      { type: 'allow-with-rules', destination: 'projectSettings', rules: [] },
      { type: 'allow-with-rules', destination: 'userSettings', rules: [{ ruleContent: 'x' }] },
      { type: 'answer', answers: { q: 1 } },
      { type: 'answer', answers: [] },
    ]) {
      expect(() => parseUserDecision(garbage)).not.toThrow()
      expect(parseUserDecision(garbage)).toBeUndefined()
    }
  })
})
```

- [ ] **Step 2: A teszt — szabály szövege**

`packages/core/src/rule-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatRule, parseRules } from './rule-text.js'

describe('formatRule', () => {
  it('writes a rule the way the settings files and the native prompt show it', () => {
    expect(formatRule({ toolName: 'Bash', ruleContent: 'echo spike-a *' })).toBe('Bash(echo spike-a *)')
    expect(formatRule({ toolName: 'WebFetch', ruleContent: 'domain:example.com' })).toBe('WebFetch(domain:example.com)')
  })

  it('writes an MCP rule as the bare tool name', () => {
    expect(formatRule({ toolName: 'mcp__claude-vscode__getDiagnostics' })).toBe('mcp__claude-vscode__getDiagnostics')
  })
})

describe('parseRules', () => {
  it('reads one rule per non-empty line, round-tripping formatRule', () => {
    expect(parseRules('Bash(echo spike-a *)\n\n  mcp__claude-vscode__getDiagnostics  \n')).toEqual({
      ok: true,
      rules: [{ toolName: 'Bash', ruleContent: 'echo spike-a *' }, { toolName: 'mcp__claude-vscode__getDiagnostics' }],
    })
  })

  it('keeps parentheses that belong to the content', () => {
    expect(parseRules('Bash(echo (x) *)')).toEqual({ ok: true, rules: [{ toolName: 'Bash', ruleContent: 'echo (x) *' }] })
  })

  it('reports the first bad line with its 1-based number instead of guessing', () => {
    // Egy elgépelt szabály csendes javítása veszélyes lenne: más engedélyt adna, mint amit a
    // felhasználó lát. Inkább megmondjuk, melyik sor rossz.
    expect(parseRules('Bash(ls *)\nBash()\nWebFetch(domain:x)')).toEqual({ ok: false, line: 2, text: 'Bash()' })
    expect(parseRules('Bash(ls *')).toEqual({ ok: false, line: 1, text: 'Bash(ls *' })
    expect(parseRules('két szó')).toEqual({ ok: false, line: 1, text: 'két szó' })
  })

  it('returns an empty list for empty text — the caller decides whether that is allowed', () => {
    expect(parseRules('  \n ')).toEqual({ ok: true, rules: [] })
  })
})
```

- [ ] **Step 3: RED**

Run: `pnpm --filter @claudeswitcher/core test decision-response rule-text`
Expected: FAIL — `Cannot find module './decision-response.js'` és `'./rule-text.js'`.

- [ ] **Step 4: Az implementáció**

`packages/core/src/decision-response.ts`:

```ts
import type { PermissionRequestInfo, PermissionRule, RuleDestination } from './decision.js'

/** A felhasználó döntése egy függő kérésről — az overlayből, IPC-n át érkezik. */
export type UserDecision =
  | { type: 'allow' }
  | { type: 'deny'; message?: string | undefined }
  | { type: 'allow-with-rules'; rules: PermissionRule[]; destination: RuleDestination }
  | { type: 'allow-session-edits' }
  | { type: 'answer'; answers: Record<string, string> }

/** A PermissionRequest hook válasza, a VSCode bővítményben mért alakban. */
export interface HookDecisionBody {
  hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: Record<string, unknown> }
}

export type DecisionResult = { ok: true; body: HookDecisionBody } | { ok: false; reason: string }

/** Három független mérés szerint a Claude Code a hookból adott terv-jóváhagyást figyelmen kívül hagyja. */
export const PLAN_APPROVAL_UNSUPPORTED =
  'Tervet a hookból nem lehet jóváhagyni (Claude Code korlát) — hagyd jóvá a VSCode-ban.'

function accept(decision: Record<string, unknown>): DecisionResult {
  return { ok: true, body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } } }
}

function refuse(reason: string): DecisionResult {
  return { ok: false, reason }
}

/** `ruleContent` nélküli szabálynál a kulcs kimarad — `undefined`-ként nem utazhat a dróton. */
function toWire(rule: PermissionRule): Record<string, string> {
  return rule.ruleContent === undefined
    ? { toolName: rule.toolName }
    : { toolName: rule.toolName, ruleContent: rule.ruleContent }
}

/**
 * A felhasználó döntéséből a hook válasza — vagy annak megtagadása, ha a döntés az adott
 * kérésre nem érvényes. Ez az egyetlen hely, ahol a spec tiltásai érvényesülnek: kérdést csak
 * válasszal, tervet soha nem enged tovább.
 */
export function buildHookResponse(request: PermissionRequestInfo, decision: UserDecision): DecisionResult {
  switch (decision.type) {
    case 'allow':
      if (request.kind === 'question') return refuse('Kérdést csak válasszal lehet továbbengedni.')
      if (request.kind === 'plan') return refuse(PLAN_APPROVAL_UNSUPPORTED)
      return accept({ behavior: 'allow' })

    case 'deny': {
      const message = decision.message?.trim() ?? ''
      if (request.kind === 'plan' && message === '') {
        return refuse('A terv elutasításához visszajelzés kell — abból tervez újra a session.')
      }
      return accept(message === '' ? { behavior: 'deny' } : { behavior: 'deny', message })
    }

    case 'allow-with-rules':
      if (request.kind !== 'tool') return refuse('Szabályt csak parancsra, WebFetch-re vagy MCP-toolra lehet felvenni.')
      if (decision.rules.length === 0) return refuse('Legalább egy szabály kell.')
      return accept({
        behavior: 'allow',
        updatedPermissions: [
          { type: 'addRules', rules: decision.rules.map(toWire), behavior: 'allow', destination: decision.destination },
        ],
      })

    case 'allow-session-edits':
      if (request.kind !== 'edit') return refuse('Automatikus szerkesztés csak fájlírásnál kérhető.')
      return accept({
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      })

    case 'answer': {
      if (request.kind !== 'question') return refuse('Válasz csak kérdésre adható.')
      for (const question of request.questions) {
        if ((decision.answers[question.question] ?? '').trim() === '') {
          return refuse(`Hiányzik a válasz: „${question.question}"`)
        }
      }
      return accept({ behavior: 'allow', updatedInput: { ...request.toolInput, answers: decision.answers } })
    }
  }
}

/** Többválasztós válasz a dokumentált formában (a tömb „Other"-ként jelent meg — spike R1a). */
export function joinAnswerLabels(labels: readonly string[]): string {
  return labels.join(', ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRule(raw: unknown): PermissionRule | undefined {
  if (!isRecord(raw)) return undefined
  const toolName = raw['toolName']
  const ruleContent = raw['ruleContent']
  if (typeof toolName !== 'string' || toolName === '') return undefined
  if (ruleContent === undefined) return { toolName }
  return typeof ruleContent === 'string' ? { toolName, ruleContent } : undefined
}

/**
 * Egy IPC-n érkezett döntés ellenőrzése. A renderer bármit küldhet; ami nem pontosan egy
 * `UserDecision`, azt elutasítjuk, mielőtt a daemonhoz érne. Soha nem dob.
 */
export function parseUserDecision(raw: unknown): UserDecision | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw['type']) {
    case 'allow':
      return { type: 'allow' }
    case 'allow-session-edits':
      return { type: 'allow-session-edits' }
    case 'deny': {
      const message = raw['message']
      if (message === undefined) return { type: 'deny' }
      return typeof message === 'string' ? { type: 'deny', message } : undefined
    }
    case 'allow-with-rules': {
      const destination = raw['destination']
      const list = raw['rules']
      if (destination !== 'localSettings' && destination !== 'userSettings') return undefined
      if (!Array.isArray(list)) return undefined
      const rules: PermissionRule[] = []
      for (const item of list) {
        const rule = parseRule(item)
        if (rule === undefined) return undefined
        rules.push(rule)
      }
      return { type: 'allow-with-rules', destination, rules }
    }
    case 'answer': {
      const answers = raw['answers']
      if (!isRecord(answers)) return undefined
      const clean: Record<string, string> = {}
      for (const [question, answer] of Object.entries(answers)) {
        if (typeof answer !== 'string') return undefined
        clean[question] = answer
      }
      return { type: 'answer', answers: clean }
    }
    default:
      return undefined
  }
}
```

`packages/core/src/rule-text.ts`:

```ts
import type { PermissionRule } from './decision.js'

/** Egy szabály a beállításfájlok és a natív prompt írásmódjával: `Bash(ls *)`, vagy a puszta tool név. */
export function formatRule(rule: PermissionRule): string {
  return rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`
}

export type ParsedRules = { ok: true; rules: PermissionRule[] } | { ok: false; line: number; text: string }

/** Tool név, opcionálisan zárójeles tartalommal. A tartalomban lehet zárójel; üres `()` nem. */
const RULE = /^([A-Za-z0-9_-]+)(?:\(([\s\S]+)\))?$/

/**
 * Soronként egy szabály a szerkeszthető előnézetből. Az első hibás sort visszaadja, a számával
 * együtt — egy elgépelt szabály csendes „javítása" más engedélyt adna, mint amit a felhasználó lát.
 */
export function parseRules(text: string): ParsedRules {
  const rules: PermissionRule[] = []
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    const match = RULE.exec(line)
    const toolName = match?.[1]
    if (match === null || toolName === undefined) return { ok: false, line: index + 1, text: line }
    const content = match[2]
    rules.push(content === undefined ? { toolName } : { toolName, ruleContent: content })
  }
  return { ok: true, rules }
}
```

`packages/core/src/index.ts` — két új sor a végén:
```ts
export * from './decision-response.js'
export * from './rule-text.js'
```

**Külön belépési pont a renderernek.** A 8–9. feladatban a renderer a `formatRule`, `parseRules`
és `joinAnswerLabels` függvényt használja. A core fő `index.ts`-e viszont Node-modulokat is
behúz (`settings-writer` → `node:fs`, `liveness` → `node:child_process`), amit a renderer
böngészős csomagja nem tud lefordítani. Ezért a tiszta modulok külön belépési pontot kapnak; a
1. feladat linter-szabálya (`no-restricted-imports`) a rendererben a fő belépési pontból csak
típus-importot enged.

`packages/core/src/browser.ts`:

```ts
/**
 * A core IO-mentes része — a renderer (böngészős környezet) ezt importálja.
 *
 * A fő `index.ts` Node-modulokat is behúz (fs, child_process), amit a renderer csomagja nem
 * tud lefordítani. Ide csak olyan modul kerülhet, ami semmilyen `node:` modult nem importál.
 */
export * from './decision.js'
export * from './decision-response.js'
export * from './rule-text.js'
```

`packages/core/package.json` — az `exports` mező cseréje:

```json
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./browser": { "types": "./dist/browser.d.ts", "default": "./dist/browser.js" }
  },
```

- [ ] **Step 5: GREEN**

Run: `pnpm --filter @claudeswitcher/core test && pnpm --filter @claudeswitcher/core check-types && pnpm --filter @claudeswitcher/core lint && pnpm --filter @claudeswitcher/core build`
Expected: PASS, a core tesztjei 83 → 103 (14 + 6 új). Mind exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/decision-response.ts packages/core/src/decision-response.test.ts packages/core/src/rule-text.ts packages/core/src/rule-text.test.ts packages/core/src/browser.ts packages/core/src/index.ts packages/core/package.json
git commit -m "feat(core): build hook responses with the plan and question guards, and editable rule text"
```

---

### Task 4: daemon — a `DecisionBroker`, a tartott kérések állapotgépe

**Files:**
- Create: `packages/daemon/src/decision-broker.ts`
- Test: `packages/daemon/src/decision-broker.test.ts`

**Interfaces:**
- Consumes: `buildHookResponse`, `parsePermissionRequest`, `HookDecisionBody`, `PermissionRequestInfo`, `UserDecision` (core, Task 2–3)
- Produces:
  - `class DecisionBroker` — `constructor(clock?: BrokerClock, releaseAfterMs?: number)`; `onChange(listener: () => void): void`; `hold(request: PermissionRequestInfo): Promise<HookDecisionBody | undefined>`; `decide(id: string, decision: UserDecision): DecideResult`; `preToolUse(event: ToolUseEvent): void`; `postToolUse(event: { sessionId: string; toolUseId: string }): void`; `sessionStopped(sessionId: string): void`; `subagentStopped(sessionId: string, agentId: string): void`; `releaseAll(): void`; `views(): PendingDecisionView[]`
  - `interface PendingDecisionView extends PermissionRequestInfo { id: string; createdAt: number; released: boolean }`
  - `interface ToolUseEvent { sessionId: string; toolName: string; toolInput: Record<string, unknown>; toolUseId: string }`
  - `type DecideResult = { ok: true } | { ok: false; reason: string }`
  - `interface BrokerClock { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }`, `systemClock`
  - `RELEASE_AFTER_MS = 590_000`

**A rendszer egyetlen valódi konkurens állapotgépe** (spec §7). Három forrásból jöhet döntés, és
**az első nyer**: az app (`decide`), a VSCode vagy a telefon (amit a daemon csak a hookokból lát),
illetve az elengedés 590 mp-nél. Minden tartott kérés **pontosan egyszer** kap választ — ezt a
`respond` belső `settled` zára garantálja, nem a hívók fegyelme.

**Hogyan ismeri fel a natív döntést — mérve.** A `PermissionRequest`-ben nincs `tool_use_id`, de
a közvetlenül előtte érkező `PreToolUse`-ban van, ugyanazzal a sessionnel, toollal és bemenettel
(a fixture-ök `permissionRequest_bashCorrelated` / `preToolUse_bash` / `postToolUse_bash`
hármasa egyetlen hívás három hookja). A broker a `PreToolUse` `tool_use_id`-jét a függő
kéréshez köti, és az ugyanazzal érkező `PostToolUse` zárja le. Tiltásnál nincs `PostToolUse`:
akkor a session `Stop`-ja / `SessionEnd`-je, subagentnél a `SubagentStop` zár. **A következő
`PreToolUse` szándékosan nem zár**: egy sessionen belül párhuzamos tool-hívások is lehetnek, és
egy másik hívás `PreToolUse`-ja egy még jogosan függő kérést zárna le (spec §7).

- [ ] **Step 1: A teszt**

`packages/daemon/src/decision-broker.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { parsePermissionRequest, type HookDecisionBody, type PermissionRequestInfo } from '@claudeswitcher/core'
import { describe, expect, it, vi } from 'vitest'
import {
  DecisionBroker,
  RELEASE_AFTER_MS,
  type BrokerClock,
  type ToolUseEvent,
} from './decision-broker.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../../core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>

function payload(name: string): Record<string, unknown> {
  const value = fixtures[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function request(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(payload(name))
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

function toolUse(name: string): ToolUseEvent {
  const body = payload(name)
  const sessionId = body['session_id']
  const toolName = body['tool_name']
  const toolUseId = body['tool_use_id']
  const toolInput = body['tool_input']
  if (
    typeof sessionId !== 'string' ||
    typeof toolName !== 'string' ||
    typeof toolUseId !== 'string' ||
    typeof toolInput !== 'object' ||
    toolInput === null
  ) {
    throw new Error(`not a tool-use fixture: ${name}`)
  }
  return { sessionId, toolName, toolInput: toolInput as Record<string, unknown>, toolUseId }
}

/** Hamis óra: a 590 mp-et nem kell kivárni, és az időzítők determinisztikusan futnak. */
function fakeClock(): BrokerClock & { advance(ms: number): void } {
  let now = 1_000
  let nextId = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') timers.delete(handle)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
  }
}

/** Egy tartott kérés megfigyelése: megkapta-e már a választ, és mit. */
function observe(promise: Promise<HookDecisionBody | undefined>): { done: boolean; value: HookDecisionBody | undefined } {
  const state: { done: boolean; value: HookDecisionBody | undefined } = { done: false, value: undefined }
  void promise.then((value) => {
    state.done = true
    state.value = value
  })
  return state
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('DecisionBroker', () => {
  it('holds a request and answers it with the user\'s decision', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_bash')))
    const [view] = broker.views()
    expect(view?.kind).toBe('tool')
    expect(view?.released).toBe(false)

    expect(broker.decide(view!.id, { type: 'allow' })).toEqual({ ok: true })
    await flush()
    expect(held.done).toBe(true)
    expect(held.value?.hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(broker.views()).toEqual([])
  })

  it('refuses an invalid decision and keeps the request pending', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_plan')))
    const [view] = broker.views()

    const result = broker.decide(view!.id, { type: 'allow' })
    expect(result.ok).toBe(false)
    await flush()
    expect(held.done).toBe(false)
    expect(broker.views()).toHaveLength(1)
  })

  it('answers each request exactly once — a second decision is refused', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_bash')))
    const [view] = broker.views()

    expect(broker.decide(view!.id, { type: 'deny', message: 'nem' }).ok).toBe(true)
    expect(broker.decide(view!.id, { type: 'allow' }).ok).toBe(false)
    await flush()
    expect(held.value?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'nem' })
  })

  it('recognises a decision made in VS Code by the PostToolUse of the same call', async () => {
    // A fixture-hármas egyetlen hívás három hookja — mérve, nem kitalálva.
    const broker = new DecisionBroker(fakeClock())
    broker.preToolUse(toolUse('preToolUse_bash'))
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse(toolUse('postToolUse_bash'))
    await flush()
    expect(held.done).toBe(true)
    expect(held.value).toBeUndefined()
    expect(broker.views()).toEqual([])
  })

  it('ignores a PostToolUse of a different call', async () => {
    const broker = new DecisionBroker(fakeClock())
    broker.preToolUse(toolUse('preToolUse_bash'))
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse({ sessionId: toolUse('postToolUse_bash').sessionId, toolUseId: 'toolu_other' })
    await flush()
    expect(held.done).toBe(false)
  })

  it('still correlates when the PreToolUse arrives after the PermissionRequest', async () => {
    const broker = new DecisionBroker(fakeClock())
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))
    broker.preToolUse(toolUse('preToolUse_bash'))

    broker.postToolUse(toolUse('postToolUse_bash'))
    await flush()
    expect(held.done).toBe(true)
  })

  it('does not attach a PreToolUse older than a minute', async () => {
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    broker.preToolUse(toolUse('preToolUse_bash'))
    clock.advance(61_000)
    const held = observe(broker.hold(request('permissionRequest_bashCorrelated')))

    broker.postToolUse(toolUse('postToolUse_bash'))
    await flush()
    expect(held.done).toBe(false)
  })

  it('releases at 590 s with no decision, keeps the row, and refuses a late click', async () => {
    const clock = fakeClock()
    const broker = new DecisionBroker(clock)
    const held = observe(broker.hold(request('permissionRequest_bash')))
    const [view] = broker.views()

    clock.advance(RELEASE_AFTER_MS - 1)
    await flush()
    expect(held.done).toBe(false)

    clock.advance(1)
    await flush()
    expect(held.done).toBe(true)
    expect(held.value).toBeUndefined()
    // A natív prompt ott maradt, tehát a sor is — de onnan már csak a VSCode dönthet.
    expect(broker.views()[0]?.released).toBe(true)
    expect(broker.decide(view!.id, { type: 'allow' }).ok).toBe(false)

    broker.sessionStopped(view!.sessionId)
    expect(broker.views()).toEqual([])
  })

  it('closes only the session that stopped', async () => {
    const broker = new DecisionBroker(fakeClock())
    const mine = observe(broker.hold(request('permissionRequest_bash')))
    const other = observe(broker.hold({ ...request('permissionRequest_bash'), sessionId: 'other-session' }))

    broker.sessionStopped(request('permissionRequest_bash').sessionId)
    await flush()
    expect(mine.done).toBe(true)
    expect(other.done).toBe(false)
    expect(broker.views().map((v) => v.sessionId)).toEqual(['other-session'])
  })

  it('closes a subagent\'s request on its SubagentStop, not the parent\'s', async () => {
    // A subagent a szülő session_id-jával jön — csak az agent_id különbözteti meg.
    const broker = new DecisionBroker(fakeClock())
    const parent = observe(broker.hold(request('permissionRequest_bash')))
    const subagent = observe(broker.hold(request('permissionRequest_subagent')))

    const stop = payload('subagentStop')
    broker.subagentStopped(String(stop['session_id']), String(stop['agent_id']))
    await flush()
    expect(subagent.done).toBe(true)
    expect(parent.done).toBe(false)
  })

  it('answers every held request on releaseAll', async () => {
    const broker = new DecisionBroker(fakeClock())
    const first = observe(broker.hold(request('permissionRequest_bash')))
    const second = observe(broker.hold(request('permissionRequest_webFetch')))

    broker.releaseAll()
    await flush()
    expect([first.done, second.done]).toEqual([true, true])
    expect([first.value, second.value]).toEqual([undefined, undefined])
    expect(broker.views()).toEqual([])
  })

  it('notifies listeners on every change', () => {
    const broker = new DecisionBroker(fakeClock())
    const listener = vi.fn()
    broker.onChange(listener)

    void broker.hold(request('permissionRequest_bash'))
    expect(listener).toHaveBeenCalledTimes(1)
    broker.decide(broker.views()[0]!.id, { type: 'allow' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: RED**

Run: `pnpm build && pnpm --filter @claudeswitcher/daemon test decision-broker`
Expected: FAIL — `Cannot find module './decision-broker.js'`. (A `pnpm build` azért kell, mert a
daemon a core `dist/`-jét olvassa, és abban még nincs a Task 2–3 kódja, ha a build nem futott.)

- [ ] **Step 3: Az implementáció**

`packages/daemon/src/decision-broker.ts`:

```ts
import { randomUUID } from 'node:crypto'
import {
  buildHookResponse,
  type HookDecisionBody,
  type PermissionRequestInfo,
  type UserDecision,
} from '@claudeswitcher/core'

/**
 * A PermissionRequest hook timeoutja 600 mp (apps/desktop/src/main/setup.ts). 10 mp-cel előtte
 * engedünk el, hogy a lezárást mindig mi kezdeményezzük, üres 200-zal. A natív prompt ettől nem
 * tűnik el, és utána is válaszolható (mérve: 2,5 perccel az elengedés után is).
 */
export const RELEASE_AFTER_MS = 590_000

/** Ennyi ideig vár egy PreToolUse arra, hogy megérkezzen a hozzá tartozó PermissionRequest. */
const PRE_TOOL_USE_TTL_MS = 60_000
/** Felső korlát a párosítatlan PreToolUse-okra, hogy egy sűrű session se szivárogjon. */
const PRE_TOOL_USE_CAP = 500

export interface PendingDecisionView extends PermissionRequestInfo {
  id: string
  createdAt: number
  /** Igaz, ha az app elengedte (590 mp): onnan már csak a VSCode-ban vagy a telefonon dönthető. */
  released: boolean
}

/** Egy tool-hívás a PreToolUse / PostToolUse hookból. */
export interface ToolUseEvent {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
}

export type DecideResult = { ok: true } | { ok: false; reason: string }

/** Az idő és az időzítők. Tesztben hamisítható, hogy a 590 mp-et ne kelljen kivárni. */
export interface BrokerClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: BrokerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    // Egy tartott döntés ne tartsa életben a processzt kilépéskor.
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

interface Pending {
  view: PendingDecisionView
  key: string
  toolUseId: string | undefined
  timer: unknown
  respond: (body: HookDecisionBody | undefined) => void
}

/** Kulcssorrendtől független szerializálás, hogy a PreToolUse és a PermissionRequest bemenete egyezzen. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function callKey(sessionId: string, toolName: string, toolInput: Record<string, unknown>): string {
  return `${sessionId}\u0000${toolName}\u0000${stable(toolInput)}`
}

/**
 * A tartott PermissionRequest-ek tulajdonosa — a rendszer egyetlen valódi konkurens állapotgépe.
 *
 * Három forrásból jöhet döntés, és az első nyer: az app (`decide`), a VSCode vagy a telefon
 * (`postToolUse`, `sessionStopped`, `subagentStopped`), illetve az elengedés. Minden tartott
 * kérés pontosan egyszer kap választ: ezt a `respond` saját zára garantálja.
 */
export class DecisionBroker {
  readonly #clock: BrokerClock
  readonly #releaseAfterMs: number
  readonly #pending = new Map<string, Pending>()
  readonly #listeners: Array<() => void> = []
  #recentPre: Array<{ key: string; toolUseId: string; at: number }> = []

  constructor(clock: BrokerClock = systemClock, releaseAfterMs: number = RELEASE_AFTER_MS) {
    this.#clock = clock
    this.#releaseAfterMs = releaseAfterMs
  }

  onChange(listener: () => void): void {
    this.#listeners.push(listener)
  }

  /** A kérés tartása. A visszaadott ígéret a hook válaszával teljesül; `undefined` = nincs döntés. */
  hold(request: PermissionRequestInfo): Promise<HookDecisionBody | undefined> {
    const id = randomUUID()
    const key = callKey(request.sessionId, request.toolName, request.toolInput)
    const toolUseId = this.#takeRecentPre(key)

    return new Promise<HookDecisionBody | undefined>((resolve) => {
      let settled = false
      const pending: Pending = {
        view: { ...request, id, createdAt: this.#clock.now(), released: false },
        key,
        toolUseId,
        timer: undefined,
        respond: (body) => {
          if (settled) return
          settled = true
          resolve(body)
        },
      }
      pending.timer = this.#clock.setTimeout(() => {
        this.#release(id)
      }, this.#releaseAfterMs)
      this.#pending.set(id, pending)
      this.#emit()
    })
  }

  /** A felhasználó döntése az appból. Érvénytelen döntésnél a kérés függőben marad. */
  decide(id: string, decision: UserDecision): DecideResult {
    const pending = this.#pending.get(id)
    if (pending === undefined) return { ok: false, reason: 'Ez a kérés már lezárult.' }
    if (pending.view.released) {
      return { ok: false, reason: 'Az app már elengedte ezt a kérést — dönts a VSCode-ban.' }
    }
    const result = buildHookResponse(pending.view, decision)
    if (!result.ok) return result
    this.#finish(id, result.body)
    return { ok: true }
  }

  /** A PreToolUse hozza a `tool_use_id`-t, ami a PermissionRequest-ből hiányzik. */
  preToolUse(event: ToolUseEvent): void {
    const key = callKey(event.sessionId, event.toolName, event.toolInput)
    // Ha a PermissionRequest valamiért előbb ért ide, most kötjük hozzá.
    for (const pending of this.#pending.values()) {
      if (pending.key === key && pending.toolUseId === undefined) {
        pending.toolUseId = event.toolUseId
        return
      }
    }
    const now = this.#clock.now()
    this.#recentPre = this.#recentPre
      .filter((entry) => now - entry.at < PRE_TOOL_USE_TTL_MS)
      .slice(-(PRE_TOOL_USE_CAP - 1))
    this.#recentPre.push({ key, toolUseId: event.toolUseId, at: now })
  }

  /** A tool lefutott — a döntés tehát máshol (VSCode, telefon) már megszületett. */
  postToolUse(event: { sessionId: string; toolUseId: string }): void {
    this.#closeWhere((pending) => pending.toolUseId === event.toolUseId)
  }

  /** A session köre véget ért vagy a session leállt: nála már nincs függő döntés. */
  sessionStopped(sessionId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId)
  }

  /** Egy subagent leállt. A szülő session_id-ján fut, ezért az agent_id dönt. */
  subagentStopped(sessionId: string, agentId: string): void {
    this.#closeWhere((pending) => pending.view.sessionId === sessionId && pending.view.agentId === agentId)
  }

  /** Minden tartott kérés elengedése — a daemon leállásakor, a `server.close()` ELŐTT. */
  releaseAll(): void {
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer)
      pending.respond(undefined)
    }
    this.#pending.clear()
    this.#emit()
  }

  views(): PendingDecisionView[] {
    return [...this.#pending.values()].map((pending) => pending.view).sort((a, b) => a.createdAt - b.createdAt)
  }

  #takeRecentPre(key: string): string | undefined {
    const now = this.#clock.now()
    for (let index = this.#recentPre.length - 1; index >= 0; index--) {
      const entry = this.#recentPre[index]
      if (entry === undefined) continue
      if (entry.key === key && now - entry.at < PRE_TOOL_USE_TTL_MS) {
        this.#recentPre.splice(index, 1)
        return entry.toolUseId
      }
    }
    return undefined
  }

  #release(id: string): void {
    const pending = this.#pending.get(id)
    if (pending === undefined || pending.view.released) return
    pending.respond(undefined)
    // A sor marad: a natív prompt is marad. Lezárni a PostToolUse vagy a Stop fogja.
    pending.view = { ...pending.view, released: true }
    this.#emit()
  }

  #finish(id: string, body: HookDecisionBody | undefined): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#clock.clearTimeout(pending.timer)
    pending.respond(body)
    this.#pending.delete(id)
    this.#emit()
  }

  #closeWhere(predicate: (pending: Pending) => boolean): void {
    for (const [id, pending] of [...this.#pending]) {
      if (predicate(pending)) this.#finish(id, undefined)
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[decisions] listener failed', error)
      }
    }
  }
}
```

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @claudeswitcher/daemon test && pnpm --filter @claudeswitcher/daemon check-types && pnpm --filter @claudeswitcher/daemon lint`
Expected: PASS, a daemon tesztjei 49 → 61 (12 új). Mind exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/decision-broker.ts packages/daemon/src/decision-broker.test.ts
git commit -m "feat(daemon): decision broker — first decision wins, exactly one answer per held request"
```

---

### Task 5: daemon — az új hook-route-ok és a bekötés

**Files:**
- Modify (teljes tartalom): `packages/daemon/src/hook-server.ts`, `packages/daemon/src/daemon.ts`, `packages/daemon/src/session-store.ts`
- Modify (tesztek): `packages/daemon/src/hook-server.test.ts`, `packages/daemon/src/daemon.test.ts`, `packages/daemon/src/session-store.test.ts`

**Interfaces:**
- Consumes: `DecisionBroker`, `PendingDecisionView`, `ToolUseEvent`, `DecideResult` (Task 4); `parsePermissionRequest`, `UserDecision`, `HookDecisionBody`, `PermissionRequestInfo` (core)
- Produces:
  - HTTP: `POST /hooks/permission-request` (tartott válasz), `POST /hooks/pre-tool-use`, `POST /hooks/post-tool-use`, `POST /hooks/subagent-stop` — mind bearer tokennel
  - `interface DaemonState { sessions: SessionView[]; rateLimits: RateLimits; decisions: PendingDecisionView[] }`
  - `Daemon.decide(id: string, decision: UserDecision): DecideResult`
  - `SessionStore.views(pendingSince?: ReadonlyMap<string, number>): SessionView[]`

**Miért teljes fájlok.** Az 1. feladat ezeket a fájlokat átírja (index-szignatúrás hozzáférés,
`exactOptionalPropertyTypes`), ezért egy részleges szerkesztés horgonya bizonytalan lenne. A
lenti tartalom már megfelel minden szigorú kapcsolónak.

**Egy session a döntés tartása alatt várakozó** akkor is, ha a `Notification` még nem jött meg:
az csak ~6 mp függés után érkezik (mérve), a `PermissionRequest` viszont azonnal. A
`SessionStore.views` ezért megkapja a függő döntések kezdetét is.

- [ ] **Step 1: A tesztek**

`packages/daemon/src/session-store.test.ts` — új teszt a `describe('SessionStore', …)` blokk végére:

```ts
  it('marks a session waiting while a decision is held, before any Notification', () => {
    // A Notification csak ~6 mp függés után jön (mérve); a PermissionRequest azonnal.
    const store = new SessionStore()
    store.applySnapshot([live('s1'), live('s2')], noActivity)
    const views = store.views(new Map([['s2', 500]]))
    const s2 = views.find((v) => v.sessionId === 's2')
    expect(s2?.status).toBe('waiting')
    expect(s2?.waitingSince).toBe(500)
    expect(views[0]?.sessionId).toBe('s2')
  })
```

`packages/daemon/src/hook-server.test.ts` — az importok és az `events()` segédfüggvény cseréje
(a fájl elején):

```ts
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHookApp, type HookEvents } from './hook-server.js'

const TOKEN = 'test-token'

const fixtures = JSON.parse(
  readFileSync(new URL('../../core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function payload(name: string): unknown {
  const value = fixtures[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function events(): HookEvents {
  return {
    onNotification: vi.fn(),
    onLifecycle: vi.fn(),
    onRateLimits: vi.fn(),
    onPermissionRequest: vi.fn(() => Promise.resolve(undefined)),
    onPreToolUse: vi.fn(),
    onPostToolUse: vi.fn(),
    onSubagentStop: vi.fn(),
  }
}
```

és egy új `describe` blokk a fájl végére:

```ts
describe('M2 decision routes — measured payloads', () => {
  const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } as const

  it('answers a PermissionRequest with the handler\'s decision', async () => {
    const ev = { ...events(), onPermissionRequest: vi.fn(() => Promise.resolve(ALLOW)) }
    const res = await post(createHookApp(TOKEN, ev), '/hooks/permission-request', payload('permissionRequest_bash'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(ALLOW)
    expect(ev.onPermissionRequest).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Bash', kind: 'tool' }))
  })

  it('answers an empty 200 when there is no decision', async () => {
    const res = await post(createHookApp(TOKEN, events()), '/hooks/permission-request', payload('permissionRequest_bash'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers an empty 200 when the handler fails — never a denial', async () => {
    // Mérve (R3, R4): egy hibás hookot a Claude Code „nincs döntés"-nek vesz, a natív prompt marad.
    const ev = { ...events(), onPermissionRequest: vi.fn(() => Promise.reject(new Error('boom'))) }
    const res = await post(createHookApp(TOKEN, ev), '/hooks/permission-request', payload('permissionRequest_bash'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers an empty 200 for an unusable body without calling the handler', async () => {
    const ev = events()
    const res = await post(createHookApp(TOKEN, ev), '/hooks/permission-request', { nonsense: true })
    expect(res.status).toBe(200)
    expect(ev.onPermissionRequest).not.toHaveBeenCalled()
  })

  it('forwards a PreToolUse with its tool_use_id', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/pre-tool-use', payload('preToolUse_bash'))
    expect(ev.onPreToolUse).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      toolName: 'Bash',
      toolInput: { command: 'echo spike-c2 > c3.txt', description: 'Write spike-c2 to c3.txt' },
      toolUseId: 'toolu_014XMiXFVTin7eyaeqBvxbLQ',
    })
  })

  it('forwards a PostToolUse with the same tool_use_id', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/post-tool-use', payload('postToolUse_bash'))
    expect(ev.onPostToolUse).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      toolUseId: 'toolu_014XMiXFVTin7eyaeqBvxbLQ',
    })
  })

  it('forwards a SubagentStop with its agent_id', async () => {
    const ev = events()
    await post(createHookApp(TOKEN, ev), '/hooks/subagent-stop', payload('subagentStop'))
    expect(ev.onSubagentStop).toHaveBeenCalledWith({
      sessionId: '2160705c-b755-4914-b3cb-d4a8047bdacb',
      agentId: 'ad0b11acf46ef176e',
    })
  })

  it('rejects the new routes without the token', async () => {
    const app = createHookApp(TOKEN, events())
    for (const route of ['/hooks/permission-request', '/hooks/pre-tool-use', '/hooks/post-tool-use', '/hooks/subagent-stop']) {
      expect((await post(app, route, {}, 'nope')).status).toBe(401)
    }
  })
})
```

`packages/daemon/src/daemon.test.ts` — a meglévő importok mellé:

```ts
import { readFileSync } from 'node:fs'
```

és a fájl végére:

```ts
const payloads = JSON.parse(
  readFileSync(new URL('../../core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>

function payload(name: string): Record<string, unknown> {
  const value = payloads[name]
  if (value === undefined) throw new Error(`missing fixture: ${name}`)
  return value
}

function postHook(daemon: Daemon, route: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
    body: JSON.stringify(body),
  })
}

async function waitFor<T>(read: () => T[], timeoutMs = 2000): Promise<T[]> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value.length > 0) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('startDaemon — held decisions', () => {
  it('holds a PermissionRequest until the user decides, then answers with the decision', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    const response = postHook(daemon, '/hooks/permission-request', payload('permissionRequest_bash'))

    const [pending] = await waitFor(() => daemon.state().decisions)
    expect(daemon.decide(pending!.id, { type: 'allow' })).toEqual({ ok: true })
    const res = await response
    expect(await res.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(daemon.state().decisions).toEqual([])
  })

  it('closes a held request with an empty 200 when VS Code answers first', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await postHook(daemon, '/hooks/pre-tool-use', payload('preToolUse_bash'))
    const response = postHook(daemon, '/hooks/permission-request', payload('permissionRequest_bashCorrelated'))
    await waitFor(() => daemon.state().decisions)

    await postHook(daemon, '/hooks/post-tool-use', payload('postToolUse_bash'))
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(daemon.state().decisions).toEqual([])
  })

  it('marks the session waiting while its decision is held', async () => {
    running = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const daemon = running
    await daemon.refresh()
    // Valódi payload, a fixture-registry sessionjéhez igazítva.
    void postHook(daemon, '/hooks/permission-request', { ...payload('permissionRequest_bash'), session_id: 'sid-100' })

    await waitFor(() => daemon.state().decisions)
    expect(daemon.state().sessions[0]?.status).toBe('waiting')
  })

  it('answers held requests on stop instead of hanging the shutdown', async () => {
    // A tartott kapcsolatok miatt a server.close() különben soha nem térne vissza.
    const daemon = await startDaemon({ claudeDir: await fixture(), probe: aliveProbe, pollMs: 0 })
    const response = postHook(daemon, '/hooks/permission-request', payload('permissionRequest_bash'))
    await waitFor(() => daemon.state().decisions)

    await daemon.stop()
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @claudeswitcher/daemon test`
Expected: FAIL — a `HookEvents` típusban még nincsenek az új kezelők (a teszt a típusellenőrzésen
nem, de a futáson igen bukik: a route-ok 404-et adnak, a `views(pendingSince)` figyelmen kívül
hagyja a térképet, a `state().decisions` `undefined`). Jegyezd fel a bukó tesztek nevét.

- [ ] **Step 3: Az implementáció**

`packages/daemon/src/session-store.ts` — teljes tartalom:

```ts
import type { LiveSession, SessionActivity, SessionView } from '@claudeswitcher/core'
import type { LifecycleEvent, NotificationEvent } from './hook-server.js'

/**
 * Meddig tartunk meg egy olyan várakozást, aminek a sessionje még nem szerepel a
 * pillanatképben. Bőven több, mint a 3 másodperces poll — de nem végtelen, hogy egy soha
 * meg nem jelenő session ne szivárogjon.
 */
const UNMATCHED_WAIT_GRACE_MS = 10_000

const WAITING_TYPES = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

interface WaitState {
  since: number
  text?: string | undefined
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
  readonly #waiting = new Map<string, WaitState>()
  readonly #listeners: Array<() => void> = []

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

  applySnapshot(
    sessions: LiveSession[],
    activities: Map<string, SessionActivity>,
    now: number = Date.now(),
  ): void {
    const ids = new Set(sessions.map((s) => s.record.sessionId))
    this.#sessions = new Map(sessions.map((s) => [s.record.sessionId, s]))
    this.#activities = activities

    for (const [id, wait] of [...this.#waiting]) {
      if (ids.has(id)) continue
      // Egy FRISS várakozást nem dobunk el csak azért, mert a session még nem került be a
      // registry-be: a hook azonnal megérkezik, a registry-t viszont csak pár másodpercenként
      // olvassuk. A türelmi idő után viszont takarítunk, különben egy soha meg nem jelenő
      // session várakozása örökre a memóriában maradna.
      if (now - wait.since < UNMATCHED_WAIT_GRACE_MS) continue
      this.#waiting.delete(id)
    }
    this.#emit()
  }

  /**
   * Akkor is eltárolja a várakozást, ha a session még ismeretlen.
   *
   * A `views()` a sessionökön iterál, tehát egy párját nem talált bejegyzés láthatatlan —
   * viszont amint a következő pillanatkép felveszi a sessiont, azonnal `waiting`-ként
   * jelenik meg. Korábban az ilyen értesítés VÉGLEGESEN elveszett, és a felhasználó egy rá
   * várakozó sessiont látott idle-ként.
   */
  applyNotification(event: NotificationEvent, now: number = Date.now()): void {
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

  /**
   * @param pendingSince — sessionönként a legrégebbi függő döntés kezdete. Egy ilyen session
   * akkor is várakozó, ha a Notification még nem jött meg: az csak ~6 mp függés után érkezik
   * (mérve), a PermissionRequest viszont azonnal.
   */
  views(pendingSince: ReadonlyMap<string, number> = new Map()): SessionView[] {
    const views: SessionView[] = []

    for (const [sessionId, session] of this.#sessions) {
      const activity = this.#activities.get(sessionId) ?? {}
      const wait = this.#waiting.get(sessionId)
      const pending = pendingSince.get(sessionId)

      const status =
        wait !== undefined || pending !== undefined ? 'waiting'
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
        waitingSince: wait?.since ?? pending,
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

`packages/daemon/src/hook-server.ts` — teljes tartalom:

```ts
import { appendFile } from 'node:fs/promises'
import {
  parsePermissionRequest,
  type HookDecisionBody,
  type PermissionRequestInfo,
  type RateLimits,
  type RateLimitWindow,
} from '@claudeswitcher/core'
import { Hono } from 'hono'
import type { ToolUseEvent } from './decision-broker.js'

export interface NotificationEvent {
  sessionId: string
  cwd: string
  type: string
  text?: string | undefined
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
  /** A hook válasza: döntés, vagy `undefined` = nincs döntés (üres 200, a natív prompt marad). */
  onPermissionRequest(request: PermissionRequestInfo): Promise<HookDecisionBody | undefined>
  onPreToolUse(event: ToolUseEvent): void
  onPostToolUse(event: { sessionId: string; toolUseId: string }): void
  onSubagentStop(event: { sessionId: string; agentId: string }): void
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
  const usedPercentage = v['used_percentage']
  const resetsAt = v['resets_at']
  if (typeof usedPercentage !== 'number' || typeof resetsAt !== 'number') return undefined
  return { used_percentage: usedPercentage, resets_at: resetsAt }
}

function toolUseEvent(b: Record<string, unknown>): ToolUseEvent | undefined {
  const sessionId = str(b['session_id'])
  const toolName = str(b['tool_name'])
  const toolUseId = str(b['tool_use_id'])
  const toolInput = b['tool_input']
  if (sessionId === undefined || toolName === undefined || toolUseId === undefined || !isRecord(toolInput)) {
    return undefined
  }
  return { sessionId, toolName, toolInput, toolUseId }
}

/**
 * A daemon hook-szervere. A display-only route-ok feltétel nélkül 200-at adnak üres törzzsel: a
 * szerver hibája soha nem akaszthat meg egy sessiont. A PermissionRequest route a döntést tartja,
 * de bármilyen hiba esetén ott is üres 200 megy — mérve, hogy ezt a Claude Code „nincs döntés"-nek
 * veszi, nem tiltásnak.
 */
export function createHookApp(token: string, events: HookEvents, rawLogPath?: string): Hono {
  const app = new Hono()

  /**
   * Kiírja a NYERS hook-törzset, ha kértek naplót. Alapból kikapcsolva.
   *
   * Azért a nyers törzs, és nem a kiolvasott mezők: a hookok tényleges alakja nincs
   * dokumentálva, tehát épp a saját értelmezésünk a leggyanúsabb. Ha rossz mezőnevet
   * olvasunk, a feldolgozott adat ugyanúgy hiányos lesz — a nyers viszont megmutatja.
   *
   * Soha nem vár rá a válasz, és egy írási hiba sem látszik a hívón: egy diagnosztika
   * nem akaszthat meg egy sessiont.
   */
  function record(route: string, body: unknown): void {
    if (rawLogPath === undefined) return
    const line = `${JSON.stringify({ at: new Date().toISOString(), route, body })}\n`
    void appendFile(rawLogPath, line, 'utf8').catch((error: unknown) => {
      console.error('[hook] raw log write failed', error)
    })
  }

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) {
      return c.text('unauthorized', 401)
    }
    await next()
    return undefined
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
      record('/hooks/notification', b)
      const sessionId = str(b['session_id'])
      const type = str(b['notification_type'])
      if (sessionId !== undefined && type !== undefined) {
        contain(
          events.onNotification({
            sessionId,
            cwd: str(b['cwd']) ?? '',
            type,
            // A Claude Code `message`-ben küldi — a CLAUDESWITCHER_HOOK_LOG nyers naplójából
            // mérve. A `notification_text` csak tartalék, ha egy jövőbeli verzió átnevezné.
            text: str(b['message']) ?? str(b['notification_text']),
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
      record(`/hooks/lifecycle/${kind}`, b)
      const sessionId = str(b['session_id'])
      if (sessionId !== undefined && LIFECYCLE_KINDS.has(kind)) {
        contain(
          events.onLifecycle({
            sessionId,
            cwd: str(b['cwd']) ?? '',
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

  app.post('/hooks/permission-request', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/permission-request', b)
      const request = parsePermissionRequest(b)
      if (request === undefined) return c.body(null, 200)
      const decision = await events.onPermissionRequest(request)
      if (decision === undefined) return c.body(null, 200)
      return c.body(JSON.stringify(decision), 200, { 'content-type': 'application/json' })
    } catch (error) {
      // Bármilyen hiba itt „nincs döntés": a natív prompt a VSCode-ban és a telefonon amúgy is
      // ott van, és egy hibás hookot a Claude Code sem vesz tiltásnak (spike R3, R4).
      console.error('[hook] permission request failed', error)
      return c.body(null, 200)
    }
  })

  app.post('/hooks/pre-tool-use', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/pre-tool-use', b)
      const event = toolUseEvent(b)
      if (event !== undefined) events.onPreToolUse(event)
    } catch (error) {
      console.error('[hook] pre-tool-use handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/post-tool-use', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/post-tool-use', b)
      const sessionId = str(b['session_id'])
      const toolUseId = str(b['tool_use_id'])
      if (sessionId !== undefined && toolUseId !== undefined) events.onPostToolUse({ sessionId, toolUseId })
    } catch (error) {
      console.error('[hook] post-tool-use handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/hooks/subagent-stop', async (c) => {
    try {
      const b = await body(c)
      record('/hooks/subagent-stop', b)
      const sessionId = str(b['session_id'])
      const agentId = str(b['agent_id'])
      if (sessionId !== undefined && agentId !== undefined) events.onSubagentStop({ sessionId, agentId })
    } catch (error) {
      console.error('[hook] subagent-stop handler failed', error)
    }
    return c.body(null, 200)
  })

  app.post('/statusline', async (c) => {
    try {
      const b = await body(c)
      record('/statusline', b)
      const raw = b['rate_limits']
      if (isRecord(raw)) {
        const limits: RateLimits = {}
        const five = limitWindow(raw['five_hour'])
        const seven = limitWindow(raw['seven_day'])
        const spend = limitWindow(raw['spend_limit'])
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

`packages/daemon/src/daemon.ts` — teljes tartalom:

```ts
import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import type { ProcessProbe, RateLimits, SessionView, UserDecision } from '@claudeswitcher/core'
import { DecisionBroker, type DecideResult, type PendingDecisionView } from './decision-broker.js'
import { createHookApp } from './hook-server.js'
import { Hub } from './hub.js'
import { RateLimitStore } from './rate-limits.js'
import { scanSessions } from './scanner.js'
import { SessionStore } from './session-store.js'

export type { DecideResult, PendingDecisionView } from './decision-broker.js'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
  decisions: PendingDecisionView[]
}

export interface Daemon {
  readonly port: number
  readonly token: string
  state(): DaemonState
  refresh(): Promise<void>
  /** A felhasználó döntése egy függő kérésről (az overlayből, IPC-n át). */
  decide(id: string, decision: UserDecision): DecideResult
  stop(): Promise<void>
}

export interface DaemonOptions {
  claudeDir: string
  probe: ProcessProbe
  /** Poll periódus ms-ben. 0 kikapcsolja (tesztekhez). */
  pollMs?: number | undefined
  /**
   * A port, amire a daemon köt. 0: ideiglenes (tesztekhez). A desktop fix portot ad, mert a
   * telepített hookok és a statusLine egy rögzített URL-t kapnak a settings.json-ban.
   */
  port?: number | undefined
  /** A daemon tokenje. Ha nincs megadva, véletlen. A desktop tartós tokent ad, ugyanezért. */
  token?: string | undefined
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { claudeDir, probe, pollMs = 3000, port: requestedPort = 0 } = options
  const token = options.token ?? randomBytes(16).toString('hex')

  const sessions = new SessionStore()
  const limits = new RateLimitStore()
  const decisions = new DecisionBroker()

  const app = createHookApp(
    token,
    {
      onNotification: (event) => {
        sessions.applyNotification(event)
      },
      onLifecycle: (event) => {
        sessions.applyLifecycle(event)
        // Kör vége vagy session vége: nála már nincs függő döntés — ha a VSCode-ban tiltottak,
        // erről csak így értesülünk (a tiltásnak nincs PostToolUse-a).
        if (event.kind !== 'start') decisions.sessionStopped(event.sessionId)
        void refresh()
      },
      onRateLimits: (received) => {
        limits.update(received)
        broadcast()
      },
      onPermissionRequest: (request) => decisions.hold(request),
      onPreToolUse: (event) => {
        decisions.preToolUse(event)
      },
      onPostToolUse: (event) => {
        decisions.postToolUse(event)
      },
      onSubagentStop: (event) => {
        decisions.subagentStopped(event.sessionId, event.agentId)
      },
    },
    // Diagnosztika, alapból kikapcsolva. A hookok valódi alakja nincs dokumentálva, és egy
    // rosszul olvasott mezőnév ugyanúgy néz ki, mint egy hiányzó adat — ezzel a nyers
    // törzs megnézhető anélkül, hogy a kódot kellene átírni hozzá.
    process.env['CLAUDESWITCHER_HOOK_LOG'],
  )

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: requestedPort }, () => {
      resolve(s)
    })
    // Foglalt porton a listen `error` eseményt emittál. Kezelő nélkül ez elkapatlan kivétel
    // lenne; így a startDaemon elutasít, a desktop pedig indulási hibadialógust mutat.
    s.on('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  // A @hono/node-server `serve()` egy node:http Servert ad vissza a
  // default (nem HTTP/2) konfigurációval; a WS hub ezen osztozik.
  const hub = new Hub(server as HttpServer, token)

  function state(): DaemonState {
    const pending = decisions.views()
    // Sessionönként a legrégebbi függő döntés: amíg az tart, a session várakozó.
    const pendingSince = new Map<string, number>()
    for (const view of pending) {
      const earlier = pendingSince.get(view.sessionId)
      if (earlier === undefined || view.createdAt < earlier) pendingSince.set(view.sessionId, view.createdAt)
    }
    return { sessions: sessions.views(pendingSince), rateLimits: limits.current(), decisions: pending }
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
  decisions.onChange(broadcast)

  let refreshing: Promise<void> | undefined
  async function refresh(): Promise<void> {
    // Egyszerre csak egy szkennelés fusson; a fájlfigyelő sűrűn tüzelhet.
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      try {
        const snapshot = await scanSessions(claudeDir, probe)
        sessions.applySnapshot(snapshot.sessions, snapshot.activities)
        // Életjel MINDEN sikeres szkennelés után, akkor is, ha a pillanatkép nem változott.
        // Enélkül a kliens nem tudja megkülönböztetni azt, hogy „élünk, csak nincs
        // változás", attól, hogy „megállt a poll" — és épp a monitorozó eszköznél a
        // legrosszabb kimenet, ha egy állott lista élőnek látszik. Egy WebSocket-ping ezt
        // NEM fedné: a socket akkor is egészséges, ha a szkennelés halt meg.
        hub.broadcastRaw(JSON.stringify({ type: 'tick', at: Date.now() }))
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
    decide: (id, decision) => decisions.decide(id, decision),
    async stop() {
      if (timer !== undefined) clearInterval(timer)
      // A tartott kéréseket a szerver lezárása ELŐTT kell megválaszolni: a nyitott
      // kapcsolatok miatt a server.close() különben soha nem térne vissza.
      decisions.releaseAll()
      // Megvárjuk a futó szkennelést: leállás után ne maradjon dolgozó ígéret,
      // ami a processzt életben tartja vagy egy már lezárt hubba írna.
      await refreshing?.catch(() => undefined)
      await hub.close()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
```

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @claudeswitcher/daemon test && pnpm --filter @claudeswitcher/daemon check-types && pnpm --filter @claudeswitcher/daemon lint && pnpm build`
Expected: PASS, a daemon tesztjei 61 → 74 (1 + 8 + 4 új). Mind exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src
git commit -m "feat(daemon): hold PermissionRequest for the app, close it on the native decision"
```

---

### Task 6: desktop — az M2 hookjainak telepítése, a soha nem tüzelő `SessionStart` kivezetése

**Files:**
- Modify (teljes tartalom): `apps/desktop/src/main/setup.ts`
- Modify: `apps/desktop/src/main/setup.test.ts`

**Interfaces:**
- Consumes: `transformSettingsFile`, `userSettingsPath` (core); a daemon route-jai (Task 5)
- Produces: a telepített hookok — `Notification`, `SessionEnd`, `Stop` (5 mp), **`PermissionRequest` (600 mp)**,
  `PreToolUse`, `PostToolUse`, `SubagentStop` (5 mp); `isOurHook`, `isOurStatusLine`,
  `STATUS_LINE_MARKER`, `DAEMON_PORT`, `applyIntegration`, `removeIntegration`,
  `installIntegration`, `uninstallIntegration` (a jelenlegi szignatúrákkal)

**Mi változik.**
- **Bekerül a `PermissionRequest`**, 600 mp-es timeouttal — a `DecisionBroker` 590 mp-nél enged el,
  így a lezárást mindig a daemon kezdeményezi. Ez az első blokkolni képes hookunk; a spike mérése
  szerint egy elérhetetlen daemon mellett is „nincs döntés"-ként viselkedik (R3, R4).
- **Bekerül a `PreToolUse`, a `PostToolUse` és a `SubagentStop`**, mert a natív döntést csak
  ezekből lehet felismerni (spec §7). A `PreToolUse` és a `PostToolUse` *minden* tool-hívásnál
  lefut minden sessionben — a daemon azonnal válaszol, nem fut app esetén pedig a kapcsolat
  azonnal elutasítódik, ami mérten nem lassít érezhetően (R4).
- **Kikerül a `SessionStart`**: HTTP-hookként soha nem tüzel (M2 spike). A korábbi telepítés
  bejegyzését a telepítés **és** az eltávolítás is felismeri és kiveszi, hogy ne maradjon árva.
- **Nincs többé `delete`**: az 1. feladat `no-dynamic-delete` szabálya miatt a kulcsok kivétele új
  objektum építésével történik.

- [ ] **Step 1: A tesztek**

`apps/desktop/src/main/setup.test.ts` — cseréld a `installs only the four non-blocking hook events`
tesztet erre:

```ts
  it('installs the M2 hook events, including the blocking PermissionRequest', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as Record<string, unknown>
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionEnd',
      'Stop',
      'SubagentStop',
    ])
  })
```

és add hozzá ezeket a `describe('applyIntegration', …)` blokk végére:

```ts
  it('gives PermissionRequest the 600 s timeout the decision broker releases inside', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as HookGroups
    const permission = hooks['PermissionRequest']![0]!.hooks[0]!
    expect(permission['url']).toBe('http://127.0.0.1:47821/hooks/permission-request')
    expect(permission['timeout']).toBe(600)
    expect(hooks['PreToolUse']![0]!.hooks[0]!['timeout']).toBe(5)
  })

  it('no longer installs SessionStart, which never fires as an http hook', () => {
    const hooks = applyIntegration({}, OPTIONS).settings['hooks'] as Record<string, unknown>
    expect(hooks['SessionStart']).toBeUndefined()
  })

  it('removes the SessionStart entry an earlier version installed, keeping a foreign one', () => {
    // A korábbi verzió saját bejegyzése: a tokenre hivatkozik, a régi route-ra mutat.
    const legacy = {
      hooks: [
        {
          type: 'http',
          url: 'http://127.0.0.1:47821/hooks/lifecycle/start',
          allowedEnvVars: ['CLAUDESWITCHER_TOKEN'],
        },
      ],
    }
    const installedBefore = { hooks: { SessionStart: [legacy] } }
    const reinstalled = applyIntegration(installedBefore, OPTIONS).settings['hooks'] as Record<string, unknown>
    expect(reinstalled['SessionStart']).toBeUndefined()

    const withForeign = { hooks: { SessionStart: [legacy, FOREIGN_NOTIFICATION] } }
    expect(removeIntegration(withForeign)).toEqual({ hooks: { SessionStart: [FOREIGN_NOTIFICATION] } })
  })

  it('recognises its own hook on every new route, even with allowedEnvVars pruned', () => {
    for (const route of ['permission-request', 'pre-tool-use', 'post-tool-use', 'subagent-stop']) {
      const ours = { type: 'http', url: `http://127.0.0.1:47821/hooks/${route}` }
      expect(removeIntegration({ hooks: { PreToolUse: [{ hooks: [ours] }] } })).toEqual({})
    }
  })
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @claudeswitcher/desktop test setup`
Expected: FAIL — az új események hiányoznak, a `SessionStart` még települ, az új route-okat a
`isOurHook` nem ismeri fel. Jegyezd fel a bukó tesztek nevét.

- [ ] **Step 3: Az implementáció**

`apps/desktop/src/main/setup.ts` — teljes tartalom:

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

interface HookRoute {
  route: string
  /** Másodperc. */
  timeout: number
}

/**
 * A telepített hookok.
 *
 * A `PermissionRequest` az egyetlen, ami döntést tart: 600 mp-es timeoutját a DecisionBroker
 * 590 mp-nél előzi meg, hogy a lezárást mindig mi kezdeményezzük. A többi display-only, rövid
 * timeouttal. A `PreToolUse` / `PostToolUse` / `SubagentStop` azért kell, mert a VSCode-ban vagy
 * a telefonon hozott döntést csak ezekből lehet felismerni (spec §7).
 */
const HOOK_ROUTES: Readonly<Record<string, HookRoute>> = {
  Notification: { route: 'notification', timeout: 5 },
  SessionEnd: { route: 'lifecycle/end', timeout: 5 },
  Stop: { route: 'lifecycle/stop', timeout: 5 },
  PermissionRequest: { route: 'permission-request', timeout: 600 },
  PreToolUse: { route: 'pre-tool-use', timeout: 5 },
  PostToolUse: { route: 'post-tool-use', timeout: 5 },
  SubagentStop: { route: 'subagent-stop', timeout: 5 },
}

/**
 * Egy korábbi verzió telepítette, azóta kivezetve. A `SessionStart` HTTP-hookként soha nem
 * tüzel (mérve, M2 spike). Telepítéskor és eltávolításkor is kivesszük a mi bejegyzésünket.
 */
const LEGACY_EVENTS: readonly string[] = ['SessionStart']

const TOKEN_ENV = 'CLAUDESWITCHER_TOKEN'
const PORT_ENV = 'CLAUDESWITCHER_PORT'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Új objektum a megadott kulcsok nélkül — `delete` helyett, ami mutálna. */
function without(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)))
}

/** A saját hook-végpontjaink útvonalai, a kivezetett `lifecycle/start`-tal együtt. */
const OUR_HOOK_PATHS =
  /^\/hooks\/(notification|permission-request|pre-tool-use|post-tool-use|subagent-stop|lifecycle\/(start|end|stop))$/

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
  const allowed = hook['allowedEnvVars']
  if (Array.isArray(allowed) && allowed.includes(TOKEN_ENV)) return true
  const url = hook['url']
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    // A protokollt is nézni kell. A `new URL` a hostot és az útvonalat bármilyen sémára
    // kitölti, így e nélkül egy `file://127.0.0.1/hooks/notification` is a mienknek
    // számítana — túl tág azonosítás.
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return isHttp && parsed.hostname === '127.0.0.1' && OUR_HOOK_PATHS.test(parsed.pathname)
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
function stripOurHooks(list: readonly unknown[]): unknown[] {
  return list.flatMap((entry) => {
    if (!isPlainObject(entry)) return [entry]
    const hooks = entry['hooks']
    if (!Array.isArray(hooks)) return [entry]
    const foreign = hooks.filter((hook) => !isOurHook(hook))
    if (foreign.length === 0) return []
    if (foreign.length === hooks.length) return [entry]
    return [{ ...entry, hooks: foreign }]
  })
}

/** A megadott eseményekből kiveszi a mieinket; a kiürült eseménykulcs is eltűnik. */
function stripEvents(hooks: Record<string, unknown>, events: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { ...hooks }
  const emptied: string[] = []
  for (const event of events) {
    const current = result[event]
    if (!Array.isArray(current)) continue
    const foreign = stripOurHooks(current)
    if (foreign.length === 0) emptied.push(event)
    else result[event] = foreign
  }
  return without(result, emptied)
}

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
  if (!isPlainObject(statusLine)) return false
  const command = statusLine['command']
  return typeof command === 'string' && command.includes(STATUS_LINE_MARKER)
}

function ourHookEntry(port: number, { route, timeout }: HookRoute): Record<string, unknown> {
  return {
    hooks: [
      {
        type: 'http',
        url: `http://127.0.0.1:${port}/hooks/${route}`,
        timeout,
        headers: { Authorization: `Bearer $${TOKEN_ENV}` },
        allowedEnvVars: [TOKEN_ENV],
      },
    ],
  }
}

/**
 * A telepítés tiszta transzformációja.
 *
 * Semmit nem töröl és nem ír felül, ami nem a mienk: az idegen hookok megmaradnak az
 * eseményük tömbjében, egy idegen vagy hibás alakú érték pedig ütközésként jelentődik. A
 * korábbi verzió kivezetett eseményeiből a saját bejegyzésünket kivesszük.
 */
export function applyIntegration(
  existing: Record<string, unknown>,
  options: IntegrationOptions,
): IntegrationResult {
  const settings: Record<string, unknown> = { ...existing }
  const conflicts: string[] = []

  const rawHooks = existing['hooks']
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
      const foreign = stripOurHooks(Array.isArray(current) ? current : [])
      hooks[event] = [...foreign, ourHookEntry(options.port, route)]
    }
    settings['hooks'] = stripEvents(hooks, LEGACY_EVENTS)
  }

  const previousStatusLine = existing['statusLine']
  if (previousStatusLine === undefined || isOurStatusLine(previousStatusLine)) {
    const previousPadding = isPlainObject(previousStatusLine) ? previousStatusLine['padding'] : undefined
    settings['statusLine'] = {
      type: 'command',
      command: `${options.statusLineCommand} ${STATUS_LINE_MARKER}`,
      // A felhasználó által állított padding megmarad; enélkül minden újratelepítés
      // visszaállítaná nullára.
      padding: typeof previousPadding === 'number' ? previousPadding : 0,
    }
  } else {
    conflicts.push(
      'Már van saját status line beállítva, ezt nem írtuk felül — a limitek így nem jelennek meg.',
    )
  }

  const rawEnv = existing['env']
  if (rawEnv !== undefined && !isPlainObject(rawEnv)) {
    conflicts.push('Az "env" érték nem objektum, ezért a portot és a tokent nem állítottuk be.')
  } else {
    settings['env'] = {
      ...(isPlainObject(rawEnv) ? rawEnv : {}),
      [PORT_ENV]: String(options.port),
      [TOKEN_ENV]: options.token,
    }
  }

  return { settings, conflicts }
}

/**
 * Az eltávolítás tiszta transzformációja: csak a saját bejegyzéseinket veszi ki (a kivezetett
 * eseményekből is), és a kiürült `hooks` / `env` kulcsot is törli, így egy telepítés utáni
 * eltávolítás pontosan az eredeti beállításokat adja vissza.
 */
export function removeIntegration(existing: Record<string, unknown>): Record<string, unknown> {
  let settings: Record<string, unknown> = { ...existing }

  const rawHooks = existing['hooks']
  if (isPlainObject(rawHooks)) {
    const hooks = stripEvents(rawHooks, [...Object.keys(HOOK_ROUTES), ...LEGACY_EVENTS])
    settings = Object.keys(hooks).length === 0 ? without(settings, ['hooks']) : { ...settings, hooks }
  }

  if (isOurStatusLine(existing['statusLine'])) settings = without(settings, ['statusLine'])

  const rawEnv = existing['env']
  if (isPlainObject(rawEnv)) {
    const env = without(rawEnv, [PORT_ENV, TOKEN_ENV])
    settings = Object.keys(env).length === 0 ? without(settings, ['env']) : { ...settings, env }
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

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @claudeswitcher/desktop test && pnpm --filter @claudeswitcher/desktop check-types && pnpm --filter @claudeswitcher/desktop lint`
Expected: PASS, a desktop tesztjei 67 → 71 (a cserélt teszt + 4 új). Mind exit 0. **A meglévő
veszteségmentességi tesztek** (`restores the real settings exactly after an install`, a fájlrendszeres
round-trip) **változatlanul zöldek** — ez bizonyítja, hogy a `delete` kiváltása nem változtatott a
viselkedésen.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/setup.ts apps/desktop/src/main/setup.test.ts
git commit -m "feat(desktop): install the M2 hooks and retire the SessionStart hook that never fired"
```

---

### Task 7: desktop — a döntés útja: IPC, preload, renderer-állapot

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify (teljes tartalom): `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/state-message.ts`
- Modify: `apps/desktop/src/renderer/useDaemonState.ts`
- Modify: `apps/desktop/src/renderer/state-message.test.ts`

**Interfaces:**
- Consumes: `Daemon.decide`, `PendingDecisionView`, `DecideResult` (Task 5); `parseUserDecision`, `UserDecision` (core, Task 3); a `running` konstans az `index.ts`-ben (Task 1)
- Produces:
  - IPC: `decision:decide(id: unknown, decision: unknown) → DecideResult`
  - `window.claudeswitcher.decide(id: string, decision: UserDecision): Promise<unknown>`
  - renderer: `DaemonState.decisions: PendingDecisionView[]`, így az `OverlayState` (a `useDaemonState` visszatérése) is tartalmazza

**Az IPC-határ.** A renderer bármit küldhet — egy renderer-hiba vagy egy jövőbeli bővítmény sem
juttathat érvénytelen döntést a daemonhoz. A main az argumentumokat `unknown`-ként fogadja, a
döntést a core `parseUserDecision`-je ellenőrzi, az érvényességet pedig a broker
`buildHookResponse`-a (kérdést csak válasszal, tervet soha).

**A tálca jelzése nem változik**: a daemon (Task 5) a függő döntésű sessiont már várakozónak
jelöli, így a meglévő számlálás ezt is tartalmazza.

- [ ] **Step 1: A teszt**

`apps/desktop/src/renderer/state-message.test.ts` — az első teszt elvárása bővül:

```ts
  it('returns the state carried by a well-formed state message', () => {
    const message = JSON.stringify({ type: 'state', payload: { sessions: [], rateLimits: {}, decisions: [] } })
    expect(parseStateMessage(message)).toEqual({ sessions: [], rateLimits: {}, decisions: [] })
  })
```

a fájl elejére, a meglévő importok alá:

```ts
import { readFileSync } from 'node:fs'
import { parsePermissionRequest } from '@claudeswitcher/core/browser'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../../packages/core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/** Egy függő döntés úgy, ahogy a daemon küldi: a valódi payload értelmezve, broker-mezőkkel. */
function decisionFrom(name: string): Record<string, unknown> {
  const info = parsePermissionRequest(fixtures[name])
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return { ...info, id: `id-${name}`, createdAt: 1, released: false }
}
```

és a `describe('sanitizeState', …)` blokk végére:

```ts
  it('keeps a well-formed decision and drops the malformed ones', () => {
    // Egy hibás elem a panelen renderelési hibát dobna, és az ErrorBoundary miatt az egész
    // overlay hibaszövegbe fagyna — itt csendben kiesik.
    const good = decisionFrom('permissionRequest_askMulti')
    const clean = sanitizeState({
      sessions: [],
      rateLimits: {},
      decisions: [
        good,
        null,
        { ...good, id: 7 },
        { ...good, kind: 'other' },
        { ...good, questions: [{ question: 'q' }] },
        { ...good, suggestedRules: [{}] },
      ],
    })
    expect(clean?.decisions).toEqual([good])
  })

  it('defaults decisions to an empty list when an older daemon omits them', () => {
    expect(sanitizeState({ sessions: [], rateLimits: {} })?.decisions).toEqual([])
  })
```

- [ ] **Step 2: RED**

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop test state-message`
Expected: FAIL — a `decisions` mező még nincs a sanitizer kimenetében.

- [ ] **Step 3: Az implementáció**

`apps/desktop/src/renderer/state-message.ts` — teljes tartalom:

```ts
import type { RateLimits, SessionView } from '@claudeswitcher/core'
import type { PendingDecisionView } from '@claudeswitcher/daemon'

export interface DaemonState {
  sessions: SessionView[]
  rateLimits: RateLimits
  decisions: PendingDecisionView[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const DECISION_KINDS = new Set(['tool', 'edit', 'question', 'plan'])

function isQuestion(value: unknown): boolean {
  if (!isObject(value)) return false
  const options = value['options']
  return (
    typeof value['question'] === 'string' &&
    typeof value['multiSelect'] === 'boolean' &&
    Array.isArray(options) &&
    options.every((option: unknown) => isObject(option) && typeof option['label'] === 'string')
  )
}

/**
 * Egy függő döntés a daemontól. Csak azt engedjük át, amit a panel biztonságosan meg tud
 * jeleníteni: egy hibás elem itt csendben kiesik, ahelyett hogy a renderelésnél dobna, és az
 * ErrorBoundary miatt az egész overlayt hibaszövegbe fagyasztaná.
 */
function isDecision(value: unknown): value is PendingDecisionView {
  if (!isObject(value)) return false
  const kind = value['kind']
  const questions = value['questions']
  const rules = value['suggestedRules']
  return (
    typeof value['id'] === 'string' &&
    typeof value['sessionId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    typeof value['summary'] === 'string' &&
    typeof value['released'] === 'boolean' &&
    typeof kind === 'string' &&
    DECISION_KINDS.has(kind) &&
    Array.isArray(questions) &&
    questions.every(isQuestion) &&
    Array.isArray(rules) &&
    rules.every((rule: unknown) => isObject(rule) && typeof rule['toolName'] === 'string')
  )
}

/**
 * Megtisztít egy állapot-payloadot, vagy `undefined`-ot ad. Soha nem dob.
 *
 * MINDKÉT szállítási út ezen megy át — a WebSocket üzenet és az IPC-n kért kezdőállapot is.
 * Ez a lényeg: a kezdőállapot nem a WebSocketen jön, tehát ha csak a `parseStateMessage`
 * szűrne, az IPC-s út továbbra is beengedne hibás alakot.
 *
 * Az ELEMEKET is szűri, nem csak a konténereket. Egy `sessions: [null]` egy puszta
 * `Array.isArray` ellenőrzésen túljutna, az App pedig a `view.sessionId`-n dobna — és mivel
 * az ErrorBoundary nem áll vissza magától, az overlay onnantól véglegesen hibaszöveget
 * mutatna. Egy rossz alakú elemet inkább eldobunk, mint hogy az egész listát elveszítsük.
 */
export function sanitizeState(payload: unknown): DaemonState | undefined {
  if (!isObject(payload)) return undefined

  const sessions = payload['sessions']
  const rateLimits = payload['rateLimits']
  const decisions = payload['decisions']
  if (!Array.isArray(sessions)) return undefined
  if (!isObject(rateLimits)) return undefined

  return {
    sessions: sessions.filter(
      (view: unknown): view is SessionView => isObject(view) && typeof view['sessionId'] === 'string',
    ),
    // A `five_hour !== undefined` vizsgálat egy `null`-ra IGAZ, az App pedig utána a
    // `.used_percentage`-en dobna. Itt kiszűrve a megjelenítésnek nem kell erre gondolnia.
    rateLimits: Object.fromEntries(Object.entries(rateLimits).filter(([, window]) => isObject(window))),
    // Egy régebbi daemon nem küld döntéseket — az nem hiba, hanem „nincs függő döntés".
    decisions: Array.isArray(decisions) ? decisions.filter(isDecision) : [],
  }
}

/** Amit a daemontól érthetünk: egy új állapot, vagy egy életjel. */
export type DaemonMessage = { kind: 'state'; state: DaemonState } | { kind: 'tick' }

/**
 * Egy WebSocket üzenet értelmezése, vagy `undefined`. Soha nem dob.
 *
 * A `tick` azért kell, mert a daemon nem küldi újra az azonos pillanatképet: nélküle a
 * kliens nem tudná megkülönböztetni azt, hogy „él, de nincs változás", attól, hogy „megállt".
 */
export function parseDaemonMessage(data: unknown): DaemonMessage | undefined {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch {
    return undefined
  }
  if (!isObject(message)) return undefined
  if (message['type'] === 'tick') return { kind: 'tick' }
  if (message['type'] !== 'state') return undefined
  const state = sanitizeState(message['payload'])
  return state === undefined ? undefined : { kind: 'state', state }
}

/** Egy WebSocket üzenetből kiolvassa az állapotot, vagy `undefined`-ot ad. Soha nem dob. */
export function parseStateMessage(data: unknown): DaemonState | undefined {
  const parsed = parseDaemonMessage(data)
  return parsed?.kind === 'state' ? parsed.state : undefined
}
```

`apps/desktop/src/preload/index.ts` — teljes tartalom:

```ts
import { contextBridge, ipcRenderer } from 'electron'

export interface DaemonConnection {
  port: number
  token: string
}

contextBridge.exposeInMainWorld('claudeswitcher', {
  connection: (): Promise<DaemonConnection> => ipcRenderer.invoke('daemon:connection'),
  state: (): Promise<unknown> => ipcRenderer.invoke('daemon:state'),
  focusSession: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('session:focus', sessionId),
  hide: (): Promise<void> => ipcRenderer.invoke('overlay:hide'),
  // A választ a main processz `DecideResult`-ként adja; a renderer ellenőrizve olvassa.
  decide: (id: string, decision: unknown): Promise<unknown> => ipcRenderer.invoke('decision:decide', id, decision),
})
```

`apps/desktop/src/renderer/useDaemonState.ts` — két módosítás.

Az importok első két sora helyére:

```ts
import type { UserDecision } from '@claudeswitcher/core'
import { useEffect, useState } from 'react'
import { parseDaemonMessage, sanitizeState, type DaemonState } from './state-message.js'
```

A `declare global` blokkban a `hide(): Promise<void>` sor alá:

```ts
      /** A main `DecideResult`-ot ad; a renderer a `readDecideResult`-tal olvassa (Task 8). */
      decide(id: string, decision: UserDecision): Promise<unknown>
```

és a kezdőállapot sora (`useState<DaemonState>({ sessions: [], rateLimits: {} })`) helyére:

```ts
  const [state, setState] = useState<DaemonState>({ sessions: [], rateLimits: {}, decisions: [] })
```

`apps/desktop/src/main/index.ts` — három módosítás.

A core import sora:

```ts
import { createWin32ProcessProbe, parseUserDecision, resolveClaudeDir } from '@claudeswitcher/core'
```

A `ipcMain.handle('daemon:state', () => running.state())` sor alá:

```ts
  ipcMain.handle('decision:decide', (_event, id: unknown, raw: unknown) => {
    // IPC-bemenet: a renderer bármit küldhet. Csak egy pontosan érvényes döntés jut a
    // daemonhoz — annak érvényességét az adott kérésre a broker még külön ellenőrzi.
    if (typeof id !== 'string') return { ok: false, reason: 'Érvénytelen azonosító.' }
    const decision = parseUserDecision(raw)
    if (decision === undefined) return { ok: false, reason: 'Érvénytelen döntés.' }
    return running.decide(id, decision)
  })
```

A `createOverlay` `BrowserWindow`-jában a `height: 460,` helyére `height: 600,` — a döntési panel
(Task 8–9) a lista alatt kap helyet.

- [ ] **Step 4: GREEN és ellenőrzés**

Run: `pnpm build && pnpm --filter @claudeswitcher/desktop test && pnpm check-types && pnpm lint`
Expected: PASS, a desktop tesztjei 71 → 73 (2 új). Mind exit 0.

Run: korlátos indítás (Global Constraints).
Expected: a három ismert sor (`daemon on 127.0.0.1:47821`, `tray ready, hotkey … registered`,
`[overlay] live updates connected`), **nincs** `[overlay] render failed`; a `settings.json` hash-e
változatlan. Ez bizonyítja, hogy a bővített állapot (a `decisions` mező) a rendereren is átmegy.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/state-message.ts apps/desktop/src/renderer/state-message.test.ts apps/desktop/src/renderer/useDaemonState.ts
git commit -m "feat(desktop): carry held decisions to the renderer and decisions back over a checked IPC boundary"
```

---

### Task 8: renderer — a döntési panel: engedélyezés, tiltás, szabály, session-szerkesztés

**Files:**
- Create: `apps/desktop/src/renderer/decision-actions.ts`, `apps/desktop/src/renderer/DecisionPanel.tsx`, `apps/desktop/src/renderer/RuleEditor.tsx`
- Test: `apps/desktop/src/renderer/decision-actions.test.ts`
- Modify (teljes tartalom): `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.claudeswitcher.decide`, `OverlayState.decisions` (Task 7); `formatRule`, `parseRules` (`@claudeswitcher/core/browser`, Task 3); típusok: `UserDecision`, `PermissionRule`, `DecisionKind` (core), `PendingDecisionView` (daemon)
- Produces:
  - `shortcutFor(kind: DecisionKind, key: string): DecisionAction | undefined`, `type DecisionAction = 'allow' | 'deny' | 'rule-project' | 'rule-machine' | 'session-edits'`
  - `isTypingTarget(target: unknown): boolean`
  - `readDecideResult(raw: unknown): { ok: true } | { ok: false; reason: string }`
  - `<DecisionPanel decision={…} onJump={…} />` — a 9. feladat a `question` és a `plan` ágát tölti ki

**Hogyan működik a felületen.** Ha a kijelölt sessionnek függő döntése van, a lista alatt
megnyílik a panel: a kérés fajtája, a tool, a parancs/fájl, és ha subagent kéri, annak típusa.
A gombok mellett betűjel áll — `A` engedélyez, `D` tilt (indoklással), `P` projekt-szabály,
`G` gépszintű szabály, `S` erre a sessionre automatikus szerkesztés (fájlírásnál). A szabály
szerkeszthető előnézetben jelenik meg; a gépszint külön megerősítést kér. A nyilak és az Enter
(ugrás a VSCode-ba) változatlanul működnek; a `Tab` nyitott panelnél a gombok közt lép, nem ugrik.
**Szövegmezőben a billentyűk a mezőé** — a betűjelek, a nyilak és az `Esc` csak azon kívül hatnak.

Kérdésnél és tervnél ebben a feladatban a panel egy „Ugrás a VSCode-ba" gombot ad; a 9. feladat
cseréli valódi űrlapra.

- [ ] **Step 1: A teszt**

`apps/desktop/src/renderer/decision-actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isTypingTarget, readDecideResult, shortcutFor } from './decision-actions.js'

describe('shortcutFor', () => {
  it('maps the command keys, case-insensitively', () => {
    expect(['a', 'd', 'p', 'g', 'A'].map((key) => shortcutFor('tool', key))).toEqual([
      'allow',
      'deny',
      'rule-project',
      'rule-machine',
      'allow',
    ])
    expect(shortcutFor('tool', 'x')).toBeUndefined()
  })

  it('offers session edits for a file write, and no rules', () => {
    expect(shortcutFor('edit', 's')).toBe('session-edits')
    expect(shortcutFor('edit', 'p')).toBeUndefined()
    expect(shortcutFor('edit', 'g')).toBeUndefined()
  })

  it('has no key for a question — it can only be answered through the form', () => {
    for (const key of ['a', 'd', 'p', 'g', 's']) expect(shortcutFor('question', key)).toBeUndefined()
  })

  it('has no key for a plan — a stray key must not reject it, and approval happens in VS Code', () => {
    for (const key of ['a', 'd', 'p', 'g', 's']) expect(shortcutFor('plan', key)).toBeUndefined()
  })
})

describe('isTypingTarget', () => {
  it('is true for text fields, so keys there belong to the field', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('is false for everything else', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget('INPUT')).toBe(false)
  })
})

describe('readDecideResult', () => {
  it('reads the main process\'s answer, and turns anything else into a readable failure', () => {
    expect(readDecideResult({ ok: true })).toEqual({ ok: true })
    expect(readDecideResult({ ok: false, reason: 'lezárult' })).toEqual({ ok: false, reason: 'lezárult' })
    expect(readDecideResult(undefined).ok).toBe(false)
    expect(readDecideResult({ ok: false }).ok).toBe(false)
  })
})
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @claudeswitcher/desktop test decision-actions`
Expected: FAIL — `Cannot find module './decision-actions.js'`.

- [ ] **Step 3: Az implementáció**

`apps/desktop/src/renderer/decision-actions.ts`:

```ts
import type { DecisionKind } from '@claudeswitcher/core'

export type DecisionAction = 'allow' | 'deny' | 'rule-project' | 'rule-machine' | 'session-edits'

/**
 * Billentyű → művelet, fajtánként. Kérdésnél nincs: azt csak az űrlappal lehet megválaszolni
 * (válasz nélkül nem engedhető tovább). Tervnél sincs: jóváhagyni a hookból nem lehet, az
 * elutasításhoz pedig visszajelzés kell — egy félreütött betű ne utasíthasson el egy tervet.
 */
const SHORTCUTS: Readonly<Record<DecisionKind, Readonly<Record<string, DecisionAction>>>> = {
  tool: { a: 'allow', d: 'deny', p: 'rule-project', g: 'rule-machine' },
  edit: { a: 'allow', d: 'deny', s: 'session-edits' },
  question: {},
  plan: {},
}

export function shortcutFor(kind: DecisionKind, key: string): DecisionAction | undefined {
  return SHORTCUTS[kind][key.toLowerCase()]
}

/** Igaz, ha a billentyű egy szövegmezőé — ott a gépelés az övé, nem a listáé vagy a panelé. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable === true
  )
}

export type DecideOutcome = { ok: true } | { ok: false; reason: string }

/** A main processz `DecideResult`-ja, ellenőrizve — az IPC-n át bármi jöhet. */
export function readDecideResult(raw: unknown): DecideOutcome {
  if (typeof raw === 'object' && raw !== null) {
    const result = raw as { ok?: unknown; reason?: unknown }
    if (result.ok === true) return { ok: true }
    if (result.ok === false && typeof result.reason === 'string') return { ok: false, reason: result.reason }
  }
  return { ok: false, reason: 'Ismeretlen válasz a daemontól.' }
}
```

`apps/desktop/src/renderer/RuleEditor.tsx`:

```tsx
import type { PermissionRule } from '@claudeswitcher/core'
import { parseRules } from '@claudeswitcher/core/browser'
import { useState, type JSX } from 'react'

interface Props {
  /** A Claude Code javaslata, soronként egy szabály — a felhasználó átírhatja. */
  initial: string
  /** Gépszint: minden projektre és sessionre hat, ezért külön megerősítés kell. */
  machine: boolean
  busy: boolean
  onSubmit: (rules: PermissionRule[]) => void
  onCancel: () => void
}

/**
 * A szabály szerkeszthető előnézete. Amíg egy sor nem értelmezhető, nem lehet beküldeni: egy
 * csendben „javított" szabály más engedélyt adna, mint amit a felhasználó lát.
 */
export function RuleEditor({ initial, machine, busy, onSubmit, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial)
  const [confirmed, setConfirmed] = useState(false)

  const parsed = parseRules(text)
  const rules = parsed.ok ? parsed.rules : []
  const problem = !parsed.ok
    ? `A ${parsed.line}. sor nem szabály: „${parsed.text}"`
    : rules.length === 0
      ? 'Legalább egy szabály kell.'
      : undefined
  const canSubmit = problem === undefined && !busy && (!machine || confirmed)

  return (
    <form
      className="rule-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) onSubmit(rules)
      }}
    >
      <p className="muted">
        {machine
          ? 'Gépszintű szabály — minden projektre és sessionre érvényes (~/.claude/settings.json).'
          : 'Projekt-szabály — csak ebben a projektben (.claude/settings.local.json).'}
      </p>
      <textarea
        autoFocus
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
          if (event.key === 'Enter' && event.ctrlKey && canSubmit) {
            event.preventDefault()
            onSubmit(rules)
          }
        }}
      />
      {problem !== undefined && <p className="decision-error">{problem}</p>}
      {machine && (
        <label className="confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked)
            }}
          />{' '}
          Értem, hogy ez a gép minden sessionjére érvényes
        </label>
      )}
      <div className="decision-row">
        <button type="submit" disabled={!canSubmit}>
          Engedélyez és felveszi a szabályt
        </button>
        <button type="button" onClick={onCancel}>
          Mégse
        </button>
      </div>
    </form>
  )
}
```

`apps/desktop/src/renderer/DecisionPanel.tsx`:

```tsx
import type { UserDecision } from '@claudeswitcher/core'
import { formatRule } from '@claudeswitcher/core/browser'
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useState, type JSX } from 'react'
import { isTypingTarget, readDecideResult, shortcutFor, type DecisionAction } from './decision-actions.js'
import { RuleEditor } from './RuleEditor.js'

const KIND_LABEL = {
  tool: 'Engedélyt kér',
  edit: 'Fájlt írna',
  question: 'Kérdez',
  plan: 'Tervet hagyatna jóvá',
} as const

type Mode = 'buttons' | 'deny' | 'rule-project' | 'rule-machine'

interface Props {
  decision: PendingDecisionView
  /** Ugrás a session VSCode ablakára — ott a natív prompt végig megvan. */
  onJump: () => void
}

/**
 * Egy függő kérés döntési panelje. A döntést a main processzen át a daemon ellenőrzi és
 * továbbítja; siker esetén a következő állapot leveszi a kérést, és a panel eltűnik.
 */
export function DecisionPanel({ decision, onJump }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('buttons')
  const [denyText, setDenyText] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(choice: UserDecision): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      const result = readDecideResult(await window.claudeswitcher.decide(decision.id, choice))
      if (!result.ok) setError(result.reason)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  function run(action: DecisionAction): void {
    switch (action) {
      case 'allow':
        void submit({ type: 'allow' })
        return
      case 'session-edits':
        void submit({ type: 'allow-session-edits' })
        return
      case 'deny':
      case 'rule-project':
      case 'rule-machine':
        setMode(action)
        return
    }
  }

  // A betűjelek. Szövegmezőben, nyitott űrlapnál, futó kérés közben és elengedett kérésnél nem hatnak.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (decision.released || busy || mode !== 'buttons') return
      if (isTypingTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) return
      const action = shortcutFor(decision.kind, event.key)
      if (action === undefined) return
      event.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  })

  function jumpRow(text: string): JSX.Element {
    return (
      <div className="decision-row">
        <span className="muted">{text}</span>
        <button type="button" onClick={onJump}>
          Ugrás a VSCode-ba
        </button>
      </div>
    )
  }

  function body(): JSX.Element {
    if (decision.released) return jumpRow('Az app elengedte — a VSCode-ban vagy a telefonon dönthetsz.')

    if (mode === 'deny') {
      return (
        <form
          className="decision-row"
          onSubmit={(event) => {
            event.preventDefault()
            void submit({ type: 'deny', message: denyText })
          }}
        >
          <input
            autoFocus
            className="grow"
            value={denyText}
            placeholder="Indoklás a sessionnek (nem kötelező)"
            onChange={(event) => {
              setDenyText(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setMode('buttons')
              }
            }}
          />
          <button type="submit" disabled={busy}>
            Tilt
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('buttons')
            }}
          >
            Mégse
          </button>
        </form>
      )
    }

    if (mode === 'rule-project' || mode === 'rule-machine') {
      const destination = mode === 'rule-machine' ? 'userSettings' : 'localSettings'
      return (
        <RuleEditor
          initial={decision.suggestedRules.map(formatRule).join('\n')}
          machine={mode === 'rule-machine'}
          busy={busy}
          onSubmit={(rules) => {
            void submit({ type: 'allow-with-rules', rules, destination })
          }}
          onCancel={() => {
            setMode('buttons')
          }}
        />
      )
    }

    switch (decision.kind) {
      case 'tool':
        return (
          <div className="decision-row">
            <button type="button" disabled={busy} onClick={() => { run('allow') }}>
              <kbd>A</kbd> Engedélyez
            </button>
            <button type="button" disabled={busy} onClick={() => { run('deny') }}>
              <kbd>D</kbd> Tilt…
            </button>
            <button type="button" disabled={busy} onClick={() => { run('rule-project') }}>
              <kbd>P</kbd> Projekt-szabály…
            </button>
            <button type="button" disabled={busy} onClick={() => { run('rule-machine') }}>
              <kbd>G</kbd> Gépszintű szabály…
            </button>
          </div>
        )
      case 'edit':
        return (
          <div className="decision-row">
            <button type="button" disabled={busy} onClick={() => { run('allow') }}>
              <kbd>A</kbd> Engedélyez
            </button>
            <button type="button" disabled={busy} onClick={() => { run('deny') }}>
              <kbd>D</kbd> Tilt…
            </button>
            <button type="button" disabled={busy} onClick={() => { run('session-edits') }}>
              <kbd>S</kbd> Erre a sessionre automatikusan
            </button>
          </div>
        )
      case 'question':
        return jumpRow('A kérdést a VSCode-ban tudod megválaszolni.')
      case 'plan':
        return jumpRow('A tervet a VSCode-ban tudod jóváhagyni.')
    }
  }

  const agent = decision.agentType === undefined ? undefined : `subagent · ${decision.agentType}`

  return (
    <section className="decision">
      <header className="decision-head">
        <span className="decision-kind">{KIND_LABEL[decision.kind]}</span>
        <span className="decision-tool">{decision.toolName}</span>
        {agent !== undefined && <span className="decision-agent">{agent}</span>}
      </header>
      <pre className="decision-summary">{decision.summary}</pre>
      {body()}
      {error !== undefined && <p className="decision-error">{error}</p>}
    </section>
  )
}
```

`apps/desktop/src/renderer/App.tsx` — teljes tartalom:

```tsx
import type { PendingDecisionView } from '@claudeswitcher/daemon'
import { useEffect, useRef, useState, type JSX } from 'react'
import { DecisionPanel } from './DecisionPanel.js'
import { isTypingTarget } from './decision-actions.js'
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
  const { sessions, rateLimits, connected, checkedAt, decisions } = useDaemonState()
  // Session-azonosító, nem index: a lista átrendeződésekor a kiválasztás a sessionnel
  // együtt mozog. Lásd a selection.ts dokumentációját.
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [now, setNow] = useState(Date.now())

  const selected = resolveSelectedIndex(
    sessions.map((s) => s.sessionId),
    selectedId,
  )
  const selectedView = selected === -1 ? undefined : sessions[selected]

  // Sessionönként a legrégebbi függő döntés — a daemon létrehozás szerint rendezve küldi.
  const decisionBySession = new Map<string, PendingDecisionView>()
  for (const decision of decisions) {
    if (!decisionBySession.has(decision.sessionId)) decisionBySession.set(decision.sessionId, decision)
  }
  const decision = selectedView === undefined ? undefined : decisionBySession.get(selectedView.sessionId)

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])

  // A kijelölt sor legördítése. A lista scrollozható, tehát nélküle a nyilakkal a
  // kijelölés kifuthat a látható területről, és az Enter egy olyan sessiont aktiválna,
  // amit a felhasználó nem is lát — a legrosszabb fajta hiba ebben az appban, mert
  // ugyanúgy „működik", csak nem azt teszi, amit vártál.
  const selectedRow = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      // Szövegmezőben a gépelés az övé: se a nyilak, se az Enter, se az Esc ne vezérelje a listát.
      if (isTypingTarget(event.target)) return
      const ids = sessions.map((s) => s.sessionId)
      if (event.key === 'Escape') void window.claudeswitcher.hide()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Enélkül a nyíl a listát is elscrollozná a kijelölés mozgatása mellett.
        event.preventDefault()
        setSelectedId(moveSelection(ids, selectedId, event.key === 'ArrowDown' ? 1 : -1))
      }
      // Nyitott döntési panelnél a Tab a gombok között lép — ott nem ugrás.
      if (event.key === 'Enter' || (event.key === 'Tab' && decision === undefined)) {
        event.preventDefault()
        const view = sessions[resolveSelectedIndex(ids, selectedId)]
        if (view !== undefined) void window.claudeswitcher.focusSession(view.sessionId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [sessions, selectedId, decision])

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
        {sessions.map((view, index) => {
          const pending = decisionBySession.get(view.sessionId)
          return (
            <li
              key={view.sessionId}
              ref={index === selected ? selectedRow : null}
              className={`session ${view.status} ${index === selected ? 'selected' : ''}`}
              onClick={() => {
                setSelectedId(view.sessionId)
              }}
              onDoubleClick={() => {
                void window.claudeswitcher.focusSession(view.sessionId)
              }}
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
              <span className="summary">
                {pending === undefined ? summarize(view) : `${pending.toolName}: ${pending.summary}`}
              </span>
              <span className="age">
                {view.waitingSince !== undefined ? formatDuration(now - view.waitingSince) : ''}
              </span>
            </li>
          )
        })}
      </ul>

      {decision !== undefined && selectedView !== undefined && (
        <DecisionPanel
          key={decision.id}
          decision={decision}
          onJump={() => {
            void window.claudeswitcher.focusSession(selectedView.sessionId)
          }}
        />
      )}

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
        {/*
          Az életjel ideje. Ez az egyetlen jel, amiből látszik, hogy a lista ÉL, csak nincs
          változás — a daemon az azonos pillanatképet nem küldi újra, tehát egy tétlen gépen
          a mozdulatlan lista és a megállt poll különben pont ugyanúgy néz ki.
        */}
        <span className="muted">
          {checkedAt === undefined
            ? 'ellenőrizve: még nem'
            : `ellenőrizve: ${formatDuration(now - checkedAt)}`}
        </span>
        {!connected && <span className="muted">kapcsolat megszakadt — újracsatlakozás…</span>}
      </div>
    </div>
  )
}
```

> **Két viselkedésváltozás a listán, szándékosan.** (1) A sorra kattintás most **kijelöl**
> (megnyitja a panelt), az ugrás dupla kattintás vagy Enter — különben a panelt egérrel nem
> lehetne elérni, mert a kattintás azonnal elvinne a VSCode-ba. (2) A „Limitadat még nincs"
> felirat kikerült: a VSCode bővítményben a limitadat soha nem érkezik meg (spec §3.5), így a
> felirat csak egy örök, félrevezető ígéret volt. Ha egyszer jön adat, a sávok megjelennek.

`apps/desktop/src/renderer/styles.css` — a fájl végére:

```css
.decision {
  max-height: 55vh;
  overflow-y: auto;
  margin: 0 6px 6px;
  padding: 10px 12px;
  border: 1px solid #3a3836;
  border-radius: 6px;
  background: #242321;
}
.decision-head { display: flex; gap: 10px; align-items: baseline; }
.decision-kind { color: #d97757; font-weight: 600; }
.decision-tool { color: #a8a6a2; }
.decision-agent { color: #7aa2c4; margin-left: auto; }
.decision-summary {
  margin: 8px 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px/1.4 Consolas, "Cascadia Mono", monospace;
  color: #e8e6e3;
}
.decision-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
.decision-error { margin: 6px 0 0; color: #e0796b; }
.decision button {
  padding: 4px 10px;
  border: 1px solid #4a4845;
  border-radius: 4px;
  background: #2f2e2c;
  color: #e8e6e3;
  font: inherit;
  cursor: pointer;
}
.decision button:disabled { opacity: 0.45; cursor: default; }
.decision button:focus-visible { outline: 2px solid #d97757; outline-offset: 1px; }
.decision kbd {
  padding: 0 4px;
  border: 1px solid #5a5855;
  border-radius: 3px;
  font: 11px Consolas, monospace;
  color: #d97757;
}
.decision input, .decision textarea {
  box-sizing: border-box;
  padding: 5px 7px;
  border: 1px solid #4a4845;
  border-radius: 4px;
  background: #1c1b1a;
  color: #e8e6e3;
  font: 12px/1.4 Consolas, "Cascadia Mono", monospace;
}
.decision .grow { flex: 1; min-width: 200px; }
.rule-editor textarea { width: 100%; resize: vertical; }
.rule-editor .confirm { display: block; margin-top: 6px; color: #e0796b; }
```

- [ ] **Step 4: GREEN és ellenőrzés**

Run: `pnpm --filter @claudeswitcher/desktop test && pnpm check-types && pnpm lint && pnpm build`
Expected: PASS, a desktop tesztjei 73 → 80 (7 új). Mind exit 0 — a `pnpm lint` a 1. feladat
`no-restricted-imports` szabályával azt is bizonyítja, hogy a renderer a core-ból értéket csak a
`/browser` belépési pontból húz.

Run: korlátos indítás (Global Constraints).
Expected: a három ismert sor; **nincs** `[overlay] render failed`; a `settings.json` hash-e
változatlan. (A panelt magát billentyű nélkül megnyitni nem lehet — azt a 10. feladat méri.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "feat(desktop): decision panel — allow, deny with reason, editable project and machine rules"
```

---

### Task 9: renderer — kérdés megválaszolása és terv elutasítása az appból

**Files:**
- Create: `apps/desktop/src/renderer/question-form.ts`, `apps/desktop/src/renderer/QuestionForm.tsx`, `apps/desktop/src/renderer/PlanPanel.tsx`
- Test: `apps/desktop/src/renderer/question-form.test.ts`
- Modify: `apps/desktop/src/renderer/DecisionPanel.tsx` (a `question` és a `plan` ág)
- Modify: `apps/desktop/src/renderer/styles.css`

**Interfaces:**
- Consumes: `AskQuestion` (core típus); `joinAnswerLabels`, `parsePermissionRequest`, `buildHookResponse` (`@claudeswitcher/core/browser`); `DecisionPanel` belső `submit`-ja (Task 8)
- Produces:
  - `type FormState = Record<string, QuestionState>`, `interface QuestionState { selected: string[]; other: string }`
  - `initialFormState`, `toggleOption`, `setOtherText`, `buildAnswers`, `isComplete`
  - `<QuestionForm questions busy onSubmit />`, `<PlanPanel plan busy onReject onJump />`

**A válasz formátuma mérve** (spike K1, R1): kulcs a kérdés szövege; egyválasztósnál az opció
label-je; többválasztósnál a label-ek **a kérdés opcióinak sorrendjében** `", "`-vel összefűzve; a
szabad szöveg szó szerint („Other"). Egyválasztósnál a szabad szöveg kizárja a választott opciót —
a natív felület „Other" mezője is így viselkedik.

- [ ] **Step 1: A teszt**

`apps/desktop/src/renderer/question-form.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { buildHookResponse, parsePermissionRequest, type PermissionRequestInfo } from '@claudeswitcher/core/browser'
import { describe, expect, it } from 'vitest'
import { buildAnswers, initialFormState, isComplete, setOtherText, toggleOption } from './question-form.js'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../../packages/core/fixtures/hook-payloads.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function request(name: string): PermissionRequestInfo {
  const info = parsePermissionRequest(fixtures[name])
  if (info === undefined) throw new Error(`fixture did not parse: ${name}`)
  return info
}

// A spike valódi kérdései: egy többválasztós (gyümölcsök) és egy egyválasztós (szín).
const ask = request('permissionRequest_askMulti')
const [fruits, colour] = ask.questions
if (fruits === undefined || colour === undefined) throw new Error('fixture has two questions')

describe('question form', () => {
  it('starts incomplete — an empty answer must not reach the hook', () => {
    expect(isComplete(ask.questions, initialFormState(ask.questions))).toBe(false)
  })

  it('joins multi-select labels in option order, not click order', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Banán')
    state = toggleOption(state, fruits, 'Alma')
    expect(buildAnswers(ask.questions, state)['Milyen gyümölcsöket szeretsz?']).toBe('Alma, Banán')
  })

  it('toggles a multi-select option off again', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Alma')
    state = toggleOption(state, fruits, 'Alma')
    expect(buildAnswers(ask.questions, state)['Milyen gyümölcsöket szeretsz?']).toBe('')
  })

  it('adds free text after the chosen options for a multi-select question', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Eper')
    state = setOtherText(state, fruits, '  kiwi ')
    expect(buildAnswers(ask.questions, state)['Milyen gyümölcsöket szeretsz?']).toBe('Eper, kiwi')
  })

  it('replaces the previous choice for a single-select question', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, colour, 'Piros')
    state = toggleOption(state, colour, 'Kék')
    expect(buildAnswers(ask.questions, state)['Mi a kedvenc színed?']).toBe('Kék')
  })

  it('lets free text replace the chosen option for a single-select question', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, colour, 'Piros')
    state = setOtherText(state, colour, 'levendula')
    expect(buildAnswers(ask.questions, state)['Mi a kedvenc színed?']).toBe('levendula')
  })

  it('produces answers the core accepts as a complete reply', () => {
    let state = initialFormState(ask.questions)
    state = toggleOption(state, fruits, 'Alma')
    state = toggleOption(state, colour, 'Zöld')
    expect(isComplete(ask.questions, state)).toBe(true)
    const result = buildHookResponse(ask, { type: 'answer', answers: buildAnswers(ask.questions, state) })
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @claudeswitcher/desktop test question-form`
Expected: FAIL — `Cannot find module './question-form.js'`.

- [ ] **Step 3: Az implementáció**

`apps/desktop/src/renderer/question-form.ts`:

```ts
import type { AskQuestion } from '@claudeswitcher/core'
import { joinAnswerLabels } from '@claudeswitcher/core/browser'

export interface QuestionState {
  selected: string[]
  other: string
}

/** Kérdésenként a választás — kulcs a kérdés szövege, mint a hook válaszában. */
export type FormState = Record<string, QuestionState>

const EMPTY: QuestionState = { selected: [], other: '' }

export function initialFormState(questions: readonly AskQuestion[]): FormState {
  return Object.fromEntries(questions.map((question) => [question.question, EMPTY]))
}

function stateOf(state: FormState, question: AskQuestion): QuestionState {
  return state[question.question] ?? EMPTY
}

/** Egyválasztósnál a választás lecseréli az előzőt és törli a szabad szöveget; többválasztósnál ki-be kapcsol. */
export function toggleOption(state: FormState, question: AskQuestion, label: string): FormState {
  const current = stateOf(state, question)
  if (!question.multiSelect) return { ...state, [question.question]: { selected: [label], other: '' } }
  const selected = current.selected.includes(label)
    ? current.selected.filter((chosen) => chosen !== label)
    : [...current.selected, label]
  return { ...state, [question.question]: { selected, other: current.other } }
}

/** Egyválasztósnál a szabad szöveg kizárja a választott opciót — a natív „Other" is így viselkedik. */
export function setOtherText(state: FormState, question: AskQuestion, text: string): FormState {
  const current = stateOf(state, question)
  const selected = question.multiSelect || text.trim() === '' ? current.selected : []
  return { ...state, [question.question]: { selected, other: text } }
}

/**
 * A válaszok a hook formátumában (mérve, spike K1 és R1): kulcs a kérdés szövege, érték az opció
 * label-je; több opció a kérdés sorrendjében `", "`-vel; a szabad szöveg szó szerint.
 */
export function buildAnswers(questions: readonly AskQuestion[], state: FormState): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const { selected, other } = stateOf(state, question)
    const ordered = question.options.map((option) => option.label).filter((label) => selected.includes(label))
    const extra = other.trim()
    if (question.multiSelect) {
      answers[question.question] = joinAnswerLabels(extra === '' ? ordered : [...ordered, extra])
    } else {
      answers[question.question] = extra !== '' ? extra : (ordered[0] ?? '')
    }
  }
  return answers
}

/** Igaz, ha minden kérdésre van nem üres válasz — csak ekkor küldhető el. */
export function isComplete(questions: readonly AskQuestion[], state: FormState): boolean {
  const answers = buildAnswers(questions, state)
  return questions.every((question) => (answers[question.question] ?? '').trim() !== '')
}
```

`apps/desktop/src/renderer/QuestionForm.tsx`:

```tsx
import type { AskQuestion } from '@claudeswitcher/core'
import { useState, type JSX } from 'react'
import { buildAnswers, initialFormState, isComplete, setOtherText, toggleOption } from './question-form.js'

interface Props {
  questions: readonly AskQuestion[]
  busy: boolean
  onSubmit: (answers: Record<string, string>) => void
}

/** A session kérdései válaszolható formában. Amíg minden kérdésre nincs válasz, nem küldhető el. */
export function QuestionForm({ questions, busy, onSubmit }: Props): JSX.Element {
  const [state, setState] = useState(() => initialFormState(questions))
  const complete = isComplete(questions, state)

  return (
    <form
      className="question-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (complete && !busy) onSubmit(buildAnswers(questions, state))
      }}
    >
      {questions.map((question, index) => (
        <fieldset key={question.question}>
          <legend>
            {question.header === undefined ? '' : `${question.header} — `}
            {question.question}
          </legend>
          {question.options.map((option) => (
            <label key={option.label} className="option">
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`question-${String(index)}`}
                checked={state[question.question]?.selected.includes(option.label) ?? false}
                onChange={() => {
                  setState((current) => toggleOption(current, question, option.label))
                }}
              />{' '}
              {option.label}
              {option.description !== undefined && <span className="muted"> — {option.description}</span>}
            </label>
          ))}
          <input
            className="other"
            placeholder="Egyéb (szabad szöveg)"
            value={state[question.question]?.other ?? ''}
            onChange={(event) => {
              const text = event.target.value
              setState((current) => setOtherText(current, question, text))
            }}
          />
        </fieldset>
      ))}
      <div className="decision-row">
        <button type="submit" disabled={!complete || busy}>
          Válasz elküldése
        </button>
      </div>
    </form>
  )
}
```

`apps/desktop/src/renderer/PlanPanel.tsx`:

```tsx
import { useState, type JSX } from 'react'

interface Props {
  plan: string | undefined
  busy: boolean
  onReject: (feedback: string) => void
  onJump: () => void
}

/**
 * A terv a teljes szövegével. Elutasítani itt is lehet, visszajelzéssel — abból tervez újra a
 * session (mérve, spike K3). Jóváhagyni csak a VSCode-ban: a hookból adott jóváhagyást a Claude
 * Code figyelmen kívül hagyja (három független mérés, spike K2/K2b/K2c).
 */
export function PlanPanel({ plan, busy, onReject, onJump }: Props): JSX.Element {
  const [feedback, setFeedback] = useState('')
  const canReject = feedback.trim() !== '' && !busy

  return (
    <div className="plan-panel">
      <pre className="plan">{plan ?? '(a terv szövege nem érkezett meg)'}</pre>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canReject) onReject(feedback)
        }}
      >
        <textarea
          rows={2}
          value={feedback}
          placeholder="Mit változtasson a terven? (elutasításhoz kötelező)"
          onChange={(event) => {
            setFeedback(event.target.value)
          }}
        />
        <div className="decision-row">
          <button type="submit" disabled={!canReject}>
            Elutasítás visszajelzéssel
          </button>
          <button type="button" onClick={onJump}>
            Jóváhagyás a VSCode-ban →
          </button>
        </div>
      </form>
    </div>
  )
}
```

`apps/desktop/src/renderer/DecisionPanel.tsx` — az importok közé:

```tsx
import { PlanPanel } from './PlanPanel.js'
import { QuestionForm } from './QuestionForm.js'
```

és a `body()` `switch`-ének utolsó két ága (`case 'question':` … `case 'plan':` …) helyére:

```tsx
      case 'question':
        return (
          <QuestionForm
            questions={decision.questions}
            busy={busy}
            onSubmit={(answers) => {
              void submit({ type: 'answer', answers })
            }}
          />
        )
      case 'plan':
        return (
          <PlanPanel
            plan={decision.plan}
            busy={busy}
            onReject={(feedback) => {
              void submit({ type: 'deny', message: feedback })
            }}
            onJump={onJump}
          />
        )
```

`apps/desktop/src/renderer/styles.css` — a fájl végére:

```css
.question-form fieldset { margin: 6px 0; padding: 6px 10px; border: 1px solid #3a3836; border-radius: 5px; }
.question-form legend { padding: 0 4px; color: #e8e6e3; font-weight: 600; }
.question-form .option { display: block; padding: 2px 0; cursor: pointer; }
.question-form .other { width: 100%; margin-top: 4px; }
.plan {
  max-height: 30vh;
  overflow-y: auto;
  margin: 0 0 8px;
  padding: 8px;
  border-radius: 4px;
  background: #1c1b1a;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px/1.45 Consolas, "Cascadia Mono", monospace;
}
.plan-panel textarea { width: 100%; resize: vertical; }
```

- [ ] **Step 4: GREEN és ellenőrzés**

Run: `pnpm --filter @claudeswitcher/desktop test && pnpm check-types && pnpm lint && pnpm build`
Expected: PASS, a desktop tesztjei 80 → 87 (7 új). Mind exit 0.

Run: korlátos indítás (Global Constraints).
Expected: a három ismert sor; nincs `[overlay] render failed`; a `settings.json` hash-e változatlan.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer
git commit -m "feat(desktop): answer questions and reject plans with feedback from the overlay"
```

---

### Task 10: Az M2 elfogadási teszt — a felhasználó végzi, az ágens mellette mér

**Files:** — (nincs kódváltozás; az ágens csak olvas, illetve a K–N pontoknál a spike-mappa és egy
próbaszabály takarítását végzi)

**Interfaces:**
- Consumes: a teljes M2 (Task 1–9), a `CLAUDESWITCHER_HOOK_LOG` nyers napló, a spike mappa (`P:\08_Apps\cs-spike`)
- Produces: a mért eredmények a `.superpowers/sdd/…/progress.md` naplóban, és a döntés az M2 lezárásáról

**Mire való.** Amit ágens nem tud igazolni — billentyű, kattintás, ablakváltás, telefon, és a
hookok élő viselkedése a felhasználó saját sessionjeiben —, azt itt a felhasználó méri. Az ágens a
nyers hook-naplóból és a beállításfájlokból **mellette** ellenőriz, minden pontnál ugyanazzal a
mércével, mint a spike-ban.

- [ ] **Step 1: Előkészítés — az ágens**

1. A spike mappa projekt-szintű hookjainak kikapcsolása, hogy ne fusson két `PermissionRequest`
   hook egyszerre: a `P:\08_Apps\cs-spike\.claude\settings.json` és `settings.local.json` törlése
   (a spike eszköze a repóban `spikes/m2-permission/` alatt megmarad, a beállítás mintája
   `spike-settings.example.json`).
2. Ellenőrzés, hogy a globális `~/.claude/settings.json`-ben nincs `cs-spike` / `cs-acceptance`
   próbaszabály (a K5 utáni takarítás megmaradt).

- [ ] **Step 2: Előkészítés — a felhasználó**

1. Önálló PowerShell ablakban, friss mentés:
   `Copy-Item "$env:USERPROFILE\.claude\settings.json" "$env:USERPROFILE\.claude\settings.json.bak" -Force`
2. `cd P:\08_Apps\ClaudeSwitcher; pnpm build`
3. Az app indítása nyers naplóval:
   ```powershell
   $env:CLAUDESWITCHER_HOOK_LOG = "$env:TEMP\cs-hooks-m2.jsonl"
   pnpm --filter @claudeswitcher/desktop start
   ```
4. Tálcaikon → **Claude Code integráció telepítése** (újratelepítés: az M2 új hookokat hoz).
5. **Az ágens** összeveti a `settings.json`-t a mentéssel: a meglévő kulcsok változatlanok; a
   `hooks` alatt pontosan `Notification`, `PermissionRequest` (timeout 600), `PostToolUse`,
   `PreToolUse`, `SessionEnd`, `Stop`, `SubagentStop`; **nincs** `SessionStart`.
6. A VSCode-ban nyiss egy **új** Claude Code sessiont a `P:\08_Apps\cs-spike` mappában, és a
   beviteli mező alatt állítsd a módot **„Ask before edits"**-re.

- [ ] **Step 3: A mérések — a felhasználó végzi, az ágens a naplóból ellenőriz**

Minden pontnál: a kérés után nyisd meg az overlayt (`Shift+Alt+Space`), jelöld ki a sessiont
(nyilak vagy kattintás), és a lista alatt megjelenik a döntési panel.

| # | Mit kérsz a sessiontől | Mit csinálsz | Várt eredmény |
|---|---|---|---|
| A | `Futtasd Bash-sel: node -e "console.log('m2-a')"` | `A` (Engedélyez) | lefut; **a VSCode promptja magától eltűnik**; a panel eltűnik |
| B | `Futtasd Bash-sel: node -e "console.log('m2-b')"` | `D` → „most nem kell" → Tilt | nem fut le; a session **az indoklást visszamondja** |
| C | `Futtasd Bash-sel: node -e "console.log('m2-c')"` | `P` → a javasolt szabályt **írd át** (pl. `Bash(node -e *)`) → Engedélyez | lefut; az ágens a `cs-spike\.claude\settings.local.json`-ben **az átírt** szabályt látja |
| D | `Futtasd Bash-sel: echo cs-acceptance-probe` | `G` → a szabály legyen `Bash(echo cs-acceptance-probe *)` → pipáld a megerősítést → Engedélyez | lefut; az ágens a **globális** `settings.json`-ben látja a szabályt, **majd kiveszi**, és a fájl `EQUAL` a mentéssel |
| E | `Hozz létre egy m2-e.txt fájlt "e" tartalommal` | `S` (Erre a sessionre automatikusan) | létrejön; egy következő fájlírás már nem kér engedélyt |
| F | `Kérdezz meg AskUserQuestion-nel egyszerre két dologról: többválasztós (gyümölcsök, 4 opció) és egyválasztós (szín, 3 opció), utána mondd vissza a választ` | a panelen pipálj **két** gyümölcsöt, a színnél írj szabad szöveget → Válasz elküldése | a session a válaszokat helyesen visszamondja; **a VSCode-ban a két gyümölcs jelölőnégyzete legyen bepipálva**, ne „Other"-ként jelenjen meg (spike R1a nyitott pontja) |
| G | Plan módban: `Tervezd meg egy m2-g.txt létrehozását` | a panelen írj visszajelzést („a neve legyen m2-g2.txt") → Elutasítás | a session **a visszajelzés szerint újratervez**; az új tervnél a „Jóváhagyás a VSCode-ban →" gomb a VSCode ablakára visz, ott hagyd jóvá |
| H | `Futtasd Bash-sel: node -e "console.log('m2-h')"` | **a VSCode-ban** nyomj „Yes"-t | lefut; **az overlay panelje magától eltűnik** (PostToolUse) |
| I | ugyanez, `m2-i` | **a telefonon** fogadd el | lefut; a panel eltűnik |
| J | `Indíts egy subagentet, ami Bash-sel lefuttatja: node -e "console.log('m2-j')"` | nézd a panelt, majd `A` | a panel fejlécében **„subagent · general-purpose"**; lefut |
| K | `Futtasd Bash-sel: node -e "console.log('m2-k')"` | amíg a panel látszik, **lépj ki az appból** a tálcáról | a VSCode prompt **megmarad**, „Yes"-re lefut |
| L | (opcionális, 10 perc) egy kérés, amire nem válaszolsz | várj 10 percet | a panel: „Az app elengedte — a VSCode-ban vagy a telefonon dönthetsz."; a VSCode prompt továbbra is válaszolható |
| M | — | `Shift+Alt+Space` egy böngészőből, nyilak, Enter egy session nélküli döntésen | az M1 viselkedése változatlan: az Enter a helyes projekt ablakára ugrik |

- [ ] **Step 4: Veszteségmentesség — az ágens, az élő fájl érintése nélkül**

A valódi `uninstallIntegration` futtatása a mostani `settings.json` **másolatán**, összevetés a
Step 2-es mentéssel (az M1 14. pontjának módszere): `EQUAL` — ez bizonyítja, hogy az M2 új
hookjai és a kivezetett `SessionStart` mellett is veszteségmentes az eltávolítás.

- [ ] **Step 5: Jelentés**

A naplóba (`progress.md`) pontonként: a felhasználó megfigyelése, a nyers hook-napló vonatkozó
idővonala, és ahol eltérés van, annak oka. Különösen: **F** (bepipálódnak-e a többválasztós
opciók), és **A/H/I** (az „első döntés nyer" mindhárom forrásból).

---

## Önellenőrzés — a spec és a terv megfeleltetése

| Spec (2026-10-08-i revízió) | Feladat |
|---|---|
| §2 cél 3: approve az appból, projekt- és gépszinten | 3 (válaszépítés), 4–5 (tartás), 8 (panel), 10 A–D |
| §2 cél 3 bővítés: kérdés-válasz, terv-elutasítás | 3 (`answer`, tervtiltás), 9, 10 F–G |
| §3.4: natív prompt párhuzamosan él, első döntés nyer | 4 (`DecisionBroker`), 5 (route-ok), 10 A, H, I |
| §3.4: natív döntés a kapcsolatból nem látszik → `PreToolUse`/`PostToolUse` korreláció | 4 (`preToolUse`/`postToolUse`), 5, 6 (hookok telepítése) |
| §3.4: `SessionStart` HTTP-n nem tüzel | 6 (kivezetés, régi bejegyzés takarítása) |
| §3.4: subagent `agent_id` | 2 (értelmezés), 4 (`subagentStopped`), 8 (panel-fejléc), 10 J |
| §3.6: szabály a `permission_suggestions`-ből, szerkeszthetően, a Claude Code írja be | 2 (`suggestedRules`), 3 (`allow-with-rules`, `rule-text`), 8 (`RuleEditor`), 10 C–D |
| §5: fajtánkénti gombok | 2 (`kind`), 8–9 |
| §5: gépszint külön megerősítés | 8 (`RuleEditor` jelölőnégyzet) |
| §5: elengedés 590 mp-nél, a sor „döntés a VSCode-ban" állapotba vált | 4 (`RELEASE_AFTER_MS`, `released`), 8 (`jumpRow`), 10 L |
| §7: `DecisionModel` tiszta függvényei | 2–3 |
| §7: `DecisionBroker`, tiltás a `Stop`/`SessionEnd`/`SubagentStop`-ból, **nem** a következő `PreToolUse`-ból | 4 |
| §7: `SettingsWriter` az M2-ben nem ír szabályt | Global Constraints, 3 (csak `updatedPermissions`) |
| §8: az app hibája soha nem tilt | 5 (route: hiba → üres 200), 10 K |
| §8: kérdést csak válasszal, tervet soha | 3 (`buildHookResponse`), 7 (IPC-ellenőrzés), 8 (nincs betűjel) |
| §9: tesztek a mért payloadokra | Global Constraints, 2–5, 7, 9 (`hook-payloads.json`) |
| §11: a halasztott M1-tételek | **nem része ennek a tervnek** — a végső review után kell dönteni róluk |
| A felhasználó kérése: a lehető legszigorúbb kód | 1, Global Constraints |

**Ellenőrzés a terv megírása közben (2026-10-09).** A 2–9. feladat kódját a tervből automatikusan
kiírva, sorrendben alkalmazva le is futtattam egy tiszta munkapéldányon, majd visszaállítottam:
- a build (az Electron-csomaggal együtt) sikeres;
- **minden teszt a tervben jósolt számmal zöld**: core 68 → 103, daemon 49 → 74, desktop 67 → 87;
- a szigorú fordító (az 1. feladat összes kapcsolójával) a terv fájljaiban **0 hibát** ad; a
  fennmaradók az 1. feladat mechanikus javításai a meglévő fájlokban;
- a tervben szereplő pontos `eslint.config.mjs` a terv fájljaira **0 találatot** ad.

Közben talált és a tervben javított hibák: egy `{}`-unió miatti indexelési hiba (Task 2), a
`types.ts` `exactOptionalPropertyTypes`-következménye (Task 1-be kiemelve, a `format.ts`-sel
együtt), pontos mezőhozzáférés az új tesztekben (Task 6), két `() => void …` nyíl (Task 8), egy
fölösleges típuskényszerítés (Task 7), és egy architekturális buktató: a renderer a core fő
belépési pontjából Node-modulokat húzott volna be — ezért kapott a core egy `/browser` belépési
pontot és egy őrző linter-szabályt (Task 1, 3).
