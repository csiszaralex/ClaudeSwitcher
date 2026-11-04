# ClaudeSwitcher: projektszabályok

Futtatás, telepítés, env változók: `README.md`. Terv és mért Claude Code viselkedés: `docs/superpowers/specs/2026-09-04-claudeswitcher-design.md`. Backlog és halasztott tételek: `docs/backlog.md`.

## Szigorúság
- Mindenhol a lehető legszigorúbb beállítás: `tsconfig.base.json` (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`…), ESLint `strictTypeChecked` + `switch-exhaustiveness-check` + `eqeqeq`, a tesztek is típusellenőrzöttek, `knip` a halott kódra. Lazítani csak indoklással, Alex OK-jával.
- `pnpm verify` (check-types, lint, test, build minden csomagra, utána a gyökér configok és a `knip`) exit 0 kell legyen **minden merge előtt a main-be**: a merge előtt a vezető a merge-elendő ág HEAD-jén frissen lefuttatja, és csak zöld eredménnyel mergel. A hookok (`simple-git-hooks`, a `pnpm install` telepíti): a pre-commit a gyors `pnpm verify:commit` (az érintett csomagok típusellenőrzése és lintje, plusz `knip`), a pre-push a teljes `pnpm verify`. Remote nélkül a pre-push nem fut, ezért a merge előtti futás kötelező. Megkerülni (`--no-verify`, `SKIP_SIMPLE_GIT_HOOKS`) csak Alex OK-jával.

## Tilos
- Szinkron gyerekprocessz (`execSync`, `execFileSync`, `spawnSync`) nem teszt kódban: megállítja az Electron főszálát, vele a daemont és minden session hookját. ESLint tiltja.
- A rendererben érték a `@claudeswitcher/core`-ból vagy a `@claudeswitcher/daemon`-ból: csak a `@claudeswitcher/core/browser` adhat értéket, a többiből csak típus jöhet. ESLint tiltja. A `/browser`-be csak `node:` importot nem tartalmazó modul kerülhet.
- `npx` (helyette `pnpm exec`, `pnpm dlx`), a függőségek kézi szerkesztése a `package.json`-ban, `git add -A` / `git add .`.

## Munkamódszer
- Egy implementáló agent dolgozik egyszerre, és `git add`-nál megáll, a pontos fájllistával. Soha nem commitol.
- A vezető maga ellenőriz (`pnpm verify`, a döntő állítások a kódban), utána Alex átnéz és élőben tesztel. Commit csak Alex OK-ja után.
- Független változásonként egy commit (Conventional Commits, egy scope, angolul, AI-attribúció nélkül). Ha két commit közös fájlt érint, az agent lépésenkénti pillanatképeket készít (`.superpowers/sdd/<kör>/<hullám>-split/C<n>/`) egy `apply_step.sh`-val, ami a munkafát az n. commit állapotára állítja és pontosan annak fájljait stage-eli, és egy `verify_steps.sh`-val, ami minden lépésre lefuttatja a `pnpm verify`-t.

## Kéz le
- Agent soha nem írja a valódi `~/.claude/settings.json`-t (azt csak Alex írja, a tálcamenü telepítőjével). A `~/.claude` agentnek csak olvasható.
- Agent nem indít Electront, nem nyúl ablakhoz és billentyűzethez, és nem lő le processzt.
- Fixture-be és tesztbe nem kerül valódi transcript-tartalom vagy helyi adat (session-azonosító, mappanév, felhasználónév, token). Kitalált, formailag érvényes értékek kellenek: friss UUID, `p:\proj\alpha`, `pidDomain: 'win32:user'`. A mért alak maradjon meg.
- Az élő átvételi teszt Alex dolga. Minden javítás után pontos, lépésenkénti teszt-protokollt kap a cs-spike-ra (`P:\08_Apps\cs-spike`): mit csináljon, és mit kell látnia.

## Nyelv
- Kód-azonosítók, parancsok és commit üzenetek angolul. Az új kommentek és dokumentáció angolul készülnek (a 8. hullámtól), a meglévő magyarokat a 8. hullám 2. része fordítja le. A GUI szövegei magyarok.
- Magyar szövegben mondaton belül soha nincs gondolatjel (– vagy —): vessző vagy új mondat.

## Egy tény egy helyen
Minden érték egy helyen él, mindenhol máshol arra hivatkozunk. A közös modulok a core-ban (a `/browser` is exportálja őket):
- `hook-contract.ts`: a telepített hookok (`HOOK_CONTRACT`), route-jaik, timeoutjuk, a 600 s-ból számolt elengedési idő (`PERMISSION_RELEASE_AFTER_MS`), a kivezetett hookok, a `lifecycle/*` fajták (`isLifecycleKind`, `lifecyclePath`).
- `timings.ts`: a több modul által használt időzítések (`POLL_INTERVAL_MS`, `PROBE_TTL_MS`).
- `protocol.ts`: a daemon és a renderer közti szerződés, vagyis a protokollverzió (`DAEMON_PROTOCOL`) és a daemon címe (`DAEMON_HOST`, `DAEMON_WS_PATH`, `DAEMON_WS_TOKEN_PARAM`, `daemonWsUrl`). A renderer CSP-je (`renderer-csp.ts`) a hostot saját literálként tartja, a tesztje köti a `DAEMON_HOST`-hoz.
- `guards.ts`: bemenet-őrök (`isRecord` stb.), a szöveg egy sorba lapítása és vágása (`flatText`, `truncate`).
- `tool-names.ts`: eszköznév-halmazok (szerkesztő és parancs eszközök). A döntésfajták (`DecisionKind`) a `decision.ts`-ben.

## Claude Code csatolási pontok
Nem dokumentált belsők, és hol olvassuk őket. Ha a Claude Code változik, itt kell kezdeni:
- `~/.claude/sessions/<pid>.json`: core `session-registry.ts` `parseSessionRecord`, beolvasás a daemon `scanner.ts`-ben. Hiányzó kötelező mezőnél a rekord csendben kiesik.
- `procStart` (FILETIME decimális szövegként) és a pid-élet: core `liveness.ts` (`isAlive`, `parsePowerShellSnapshot`), desktop `process-probe.ts`.
- `~/.claude/ide/<port>.lock` és a VS Code image nevek: `session-registry.ts` `parseIdeLock`, `liveness.ts` `VSCODE_IMAGE_NAMES`.
- Transcript `projects/<kódolt cwd>/<sessionId>.jsonl` és a blokkok alakja: core `transcript.ts` (`findTranscriptPath`, `readActivityFromLines`), `tool-detail.ts`.
- Subagent-fájlok (`subagents/agent-<id>.jsonl`, `.meta.json`): daemon `scanner.ts` `readSubagents`, core `subagent.ts`.
- Hook payloadok: daemon `hook-server.ts`, core `decision.ts` `parsePermissionRequest`. A mért alakok: `packages/core/fixtures/hook-payloads.json`, `spikes/m2-permission/RESULTS.md`.
- Hook válasz (`hookSpecificOutput`, `updatedPermissions`): core `decision-response.ts` `buildHookResponse`.
- Hook-konfiguráció a `settings.json`-ban: desktop `setup.ts`, a lista a `hook-contract.ts`-ben.
- Notification típusok és a ~6 mp-es késés: daemon `session-store.ts` `WAITING_TYPES`, `LATE_PROMPT_WINDOW_MS`.
- Tab-URI (`vscode://anthropic.claude-code/open?session=`), `entrypoint === 'claude-vscode'`: desktop `focus-window.ts` `tabFocusUri`, `VSCODE_ENTRYPOINT`.
- Eszköznevek és `tool_input` mezők: `tool-names.ts`, `decision.ts`, `tool-detail.ts`, renderer `edit-preview.ts`, `tool-details.ts`.

## Környezet
- Ezen a gépen a `P:` egy `subst` meghajtó (`D:\P`), és a processzindítás lassú (egy PowerShell-pillanatkép ~6 s). A `pnpm verify` itt több percig tart: előtérben, hosszú timeouttal fusson, soha nem háttérben.
- A `subst` meghajtó miatt a renderer gyökere az `electron.vite.config.ts`-ben valódi útvonal (`RENDERER_ROOT`, `realpathSync.native`). Enélkül a build elbukik.
- A `@types/node` főverziója az Electron Node-jáé (most 24), nem a gépen futó Node-é: az app azon fut. Csak a gyökér `package.json`-ban van deklarálva.
- Az élő Windows-tesztek bő időkorlátot kapnak lassú gépre (`focus-window.test.ts`), és a PowerShell probe-tartalék időkorlátja 30 s (`liveness.ts` `POWERSHELL_SNAPSHOT_TIMEOUT_MS`).
