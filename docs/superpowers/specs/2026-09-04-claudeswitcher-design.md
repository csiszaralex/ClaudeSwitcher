# ClaudeSwitcher — design

**Dátum:** 2026-09-04 · **Revízió:** 2026-10-30
**Állapot:** az M1, az M2 és az M3 kész, élesben használt (§11). A 2026-10-25-i teljes
repó-átnézés javításai is benne vannak: `docs/reviews/2026-10-25-repo-review.md`, „Eredmény”.
**Platform:** Windows 11, VSCode + Claude Code extension (v2.1.259)

> **A 2026-10-30-i revízió.** A spec igazítása a kódhoz az átnézés után: a rate limit
> kivezetése (§3.5), a natív Nem/Esc mérése és a két hibás végű hook (§3.4), a core valódi
> felosztása (§4, §7), a poll a fájlfigyelő helyett (§7), a billentyűk (§4), az eldobott
> registry-rekord (§8), a natív tiltás jelei (§9), az Electron-keményítés (§7) és a
> mérföldkövek állapota (§11).

> **A 2026-10-08-i revízió lényege.** Az M2 spike (§10) megmutatta, hogy a VSCode
> bővítményben a natív prompt **a hook tartása alatt is látszik**, és az első döntés nyer,
> bárhonnan jön. Ezzel kiesik a lease-modell, a presence policy, a saját szabálygenerátor és
> a saját beállításfájl-író. Bekerül a kérdések megválaszolása, a terv elutasítása
> visszajelzéssel, és a szabály szerkeszthető előnézete. A limitkijelzés a bővítményben nem
> működik (§3.5). Részletek: `spikes/m2-permission/RESULTS.md`.

## 1. Probléma

A gépen rendszeresen fut 8–10 Claude Code session párhuzamosan, mind a VSCode
extensionben, gyakran több ugyanabban az ablakban. Nincs egységes nézet arról,
melyik vár approve-ra, melyik dolgozik, melyik végzett. Az oda-navigálás
manuális ablakvadászat, és nincs rálátás a session/heti limitek állására.

A hivatalos `claude agents` (Agent View) ezt nem oldja meg: dokumentáltan **csak
a háttérbe tett (`--bg`) sessionöket** mutatja, a VSCode extension sessionöket
nem — vagyis pont a releváns halmazt hagyja ki.

## 2. Célok

1. Egy helyen látni minden futó Claude Code sessiont és az állapotát. — **✅ M1**
2. Egy gombnyomással a megfelelő VSCode **ablakra és tabra** ugrani. — **ablak ✅ M1, tab ✅
   M3 (2026-10-21, saját bővítmény nélkül)**
3. Az appon belül approve-olni, ablakváltás nélkül — és nemcsak egyszer, hanem
   projekt- vagy gépszinten is engedélyezni. — **M2; a spike szerint megvalósítható,
   kivéve a terv jóváhagyását** (§10). A felhasználó kérésére bővült: kérdésre válasz és
   terv elutasítása visszajelzéssel is.
4. Látni a session (5 órás) és a heti limit állását, és hogy mikor újul. — **❌ a VSCode
   bővítményben nem teljesíthető** (§3.5); a felhasználó elengedte, a funkció 2026-10-27-én
   kikerült.

### Nem célok

- Nem helyettesíti a Remote Controlt, és nem használja transzportnak.
- Nem indít, állít le vagy vezérel sessionöket (nem küld promptot).
- Nem cross-platform: Windows-only.

## 3. Mért tények — az alapanyag

Minden alábbi a gépen ellenőrizve, Claude Code v2.1.259 mellett.

### 3.1 Élő session-regiszter (nem dokumentált)

`~/.claude/sessions/<pid>.json` — sessiononként egy fájl, valós tartalom:

```json
{
  "pid": 21548,
  "sessionId": "5f8f1fc5-b7f1-4a9a-a80c-c83aff747732",
  "cwd": "p:\\proj\\alpha",
  "startedAt": 1788447404737,
  "procStart": "134329210033019891",
  "version": "2.1.259",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle", "artifact_yield"],
  "kind": "interactive",
  "entrypoint": "claude-vscode",
  "pidDomain": "win32:user",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-2c65229760e23d2e33060f185c17dad9",
  "name": "alpha-58",
  "nameSource": "derived",
  "nameSince": 1788447404738,
  "bridgeSessionId": "session_01Qx7RmZ4kT9bWcN2vHs8LpD"
}
```

Mellette `<pid>.<hash>` fájl: `{"peerToken":"…","procStartFt":"…","pidDomain":"…"}`.

A `procStart` a Windows process creation FILETIME. **Liveness-ellenőrzéshez a
pid önmagában nem elég** — a `~/.claude/ide/` mappában jelenleg 20 lock fájl
van, és a 8108-as pid két különböző workspace-szel is szerepel (pid-újra-
hasznosítás). Liveness = pid létezik **és** a process creation time egyezik.

**Claude Code 2.1.296-tól** (mérve, 2026-10-20) a fájl állapotot is hordoz: `status`
(`idle` | `busy` | `waiting`), `waitingFor` (pl. `"permission prompt"`) és `statusUpdatedAt`
(ms). Az app ezt csak megjelenítésre használja: újraindulás után így látszik várakozónak egy
session, amelynek a kérése még az app indulása előtt érkezett (döntés nincs hozzá — azt csak
a VSCode hozhatja); a `busy` dolgozónak számít.

### 3.2 VSCode-ablak leképezés (nem dokumentált)

`~/.claude/ide/<port>.lock`:

```json
{
  "pid": 8108,
  "workspaceFolders": ["p:\\08_Apps\\ClaudeSwitcher"],
  "ideName": "Visual Studio Code",
  "transport": "ws",
  "runningInWindows": true,
  "authToken": "9602c76f-…"
}
```

A `pid` a VSCode ablak processze (ellenőrizve: 8108 → a "ClaudeSwitcher – …"
című ablak `MainWindowTitle`-lel). Session → ablak párosítás: `session.cwd` ⊂
`lock.workspaceFolders`.

### 3.3 Transcript

`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, élőben appendelődik.
Rekordtípusok a valós fájlban: `queue-operation`, `user`, `attachment`,
`file-history-snapshot`, `ai-title`, `atis-latch`, `assistant`, és továbbiak.
Ebből kevés kell; **ismeretlen típus = kihagyás, soha ne dobjon kivételt.**

### 3.4 Hookok — mérve a VSCode bővítményben

Az eredeti szöveg a dokumentációból dolgozott. Az alábbi a **mért** viselkedés
(`entrypoint: claude-vscode`, nyers payload-napló alapján, M1 elfogadás + M2 spike).

- **`PermissionRequest`** — lefut HTTP- és parancs-hookként is, minden mért esetben: Bash,
  PowerShell, Write, Edit, WebFetch, MCP tool, **AskUserQuestion**, **ExitPlanMode**.
  Bemenet: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
  `effort`, `tool_name`, `tool_input`, `permission_suggestions`, MCP-nél `mcp_server`
  (`name`, `source`), **subagentnél `agent_id` és `agent_type`**. `tool_use_id` nincs benne.
  Kimenet — az eredeti spec itt hibás volt, a `decision` objektum:
  ```json
  {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
     "decision": {"behavior": "allow",
                  "updatedInput": {…},
                  "updatedPermissions": [{"type": "addRules", "rules": […],
                                          "behavior": "allow", "destination": "…"}]}}}
  ```
  Tiltás: `{"behavior": "deny", "message": "…"}` — a `message`-et a modell megkapja.
  Üres 200 = nincs döntés.
- **A natív prompt nem várja meg a hookot.** A VSCode panelen azonnal megjelenik, a hook
  tartása alatt is; a telefon (Remote Control) is megkapja. **Az első döntés nyer**:
  VSCode-kattintás, telefon, vagy a hook `allow`/`deny`-ja — az utóbbi esetén a panel promptja
  eltűnik, és a tool ugyanabban a másodpercben lefut. A hook elengedése (üres 200) után a
  prompt megmarad és korlátlanul válaszolható (2,5 perccel később mérve).
- **Natív engedélyezéskor a Claude Code nem bontja a tartott HTTP kérést**, a daemon a
  kapcsolatból nem tudja meg, hogy már eldőlt. A jel a `PostToolUse` (ugyanaz a `tool_use_id`),
  vagy a `PostToolUseFailure`, ha az elindult tool hibával zárult. Ha a kör közben véget ér, a
  session `Stop`-ja / `SessionEnd`-je, subagentnél a `SubagentStop` zárja a sort (§7
  `DecisionBroker`).
- **Natív Nem vagy Esc a VSCode-ban** (mérve, 2026-10-25): **egyetlen hook sem érkezik**, se
  `Stop`, se `PostToolUse`, se `Notification`. A Claude Code ehelyett **megszakítja a tartott
  `PermissionRequest` kapcsolatot**. A broker a megszakításra zárja a sort, és ha a sessionnek
  nem maradt más függő kérése, a daemon ugyanabban a változásban törli a `Notification` okozta
  várakozást is (`DecisionBroker` `DecisionChange.abortedSessionId`, `SessionStore`
  `applyPending`). ~6 mp-en belüli natív válaszra `Notification` sem jön.
- **`PostToolUseFailure` és `StopFailure`** (a hookdokumentáció szerint, 2026-10-25; a
  fixture-ök a dokumentációból készültek, élőben nem rögzítettük őket). Az elsőt egy elindult,
  de hibával zárult tool kapja a `PostToolUse` helyett, a másodikat egy API-hibával (rate limit,
  overloaded) végződő kör a `Stop` helyett. Mindkettő a sikeres párja route-jára megy
  (`hook-contract.ts` `HOOK_CONTRACT`).
- **`Notification`** — csak akkor jön `permission_prompt`, ha a prompt **~6 mp-ig** függ; a
  gyorsan megválaszolt kérések nem jeleznek. A szöveg a **`message`** mezőben van
  („Claude needs your permission to use Bash"), nem `notification_text`-ben. `agent_id`
  nincs benne: subagent kérése a szülő `session_id`-jával érkezik.
- **`Stop`** — megbízható, `last_assistant_message`-et is hoz. **`SessionEnd`** — jön.
- **`SessionStart`** — **HTTP-hookként soha nem érkezik meg, csak parancs-hookként.**
- **`PreToolUse` / `PostToolUse` / `SubagentStart` / `SubagentStop`** — HTTP-n jönnek.
- **Subagent-átiratok** külön fájlban: `<session>/subagents/agent-<id>.jsonl`
  (`isSidechain: true`, `agentId`, a **szülő** `sessionId`-jával); a fő átiratban nincsenek.

HTTP hook konfiguráció (változatlan):

```json
{"type": "http", "url": "http://127.0.0.1:<port>/hooks/permission-request",
 "timeout": 600, "headers": {"Authorization": "Bearer $CLAUDESWITCHER_TOKEN"},
 "allowedEnvVars": ["CLAUDESWITCHER_TOKEN"]}
```

Alapértelmezett timeout 600 s. Mivel a natív prompt a timeout után is megmarad, a timeout
csak azt korlátozza, meddig dönthet az app — azt nem, meddig dönthet a felhasználó.

### 3.5 Limitek (dokumentált, kivezetve)

> **Döntés (Alex, 2026-10-27): a rate-limit funkció kikerült** (`ca9f528`). Az indok: a VSCode
> bővítmény a statusLine-t nem futtatja (lent, mérve), a telepítés mégis beírt egy statusLine-t
> a globális `~/.claude/settings.json`-ba, amely ráadásul abszolút úttal a repó build-kimenetére
> mutatott. Egy olyan funkcióért írt a felhasználó globális konfigurációjába, amely a fő
> platformon nem működik. Kikerült a `packages/statusline`, a daemon `/statusline` route-ja és a
> renderer limitkijelzése. A telepítés és az eltávolítás a régi, `--claudeswitcher` jelölős
> statusLine-t és az `env.CLAUDESWITCHER_PORT`-ot felismeri és kiveszi (`setup.ts`
> `withoutOurStatusLine`), egy idegen statusLine-hoz nem nyúl. A lenti mérés a döntés alapja,
> ezért marad.

Az egyetlen forrás a statusLine script stdin-JSON-je:

```json
"rate_limits": {
  "five_hour":   {"used_percentage": 23.5, "resets_at": 1738425600},
  "seven_day":   {"used_percentage": 41.2, "resets_at": 1738857600},
  "spend_limit": {"used_percentage": 62.8, "resets_at": 1740787200}}
```

Csak Claude.ai Pro/Max előfizetőknél, és csak a session első API-válasza után.
Account-szintű adat, ezért egyetlen futó session is elég forrásnak. Ablakonként
eltűnik, amint a `resets_at` elmúlik.

**Ár:** be kell konfigurálni egy statusLine-t (jelenleg nincs). Egyéni statusLine
mellett a Claude Code elrejti a footer billentyű-hintjeit (`esc to interrupt`,
`? for shortcuts`), ezért a statusLine-nak hasznosat is kell mutatnia, nem csak
némán posztolnia.

**Mérve (M1 elfogadás): a VSCode bővítmény a statusLine parancsot nem futtatja.** Egy
`claude-vscode` session megkapta a telepített `env` változókat, mégsem érkezett egyetlen
jelentés sem; a script közvetlenül meghívva hibátlanul eljutott a daemonig. Más helyi forrás
nincs (`~/.claude` és hat projekt átirata átnézve). A limitkijelzés így csak terminálos
sessionökből kaphatott volna adatot. **A 4. cél ezen a platformon nem teljesíthető.**

### 3.6 Permission-szabályok írása (dokumentált)

A TUI "Yes, and don't ask again" a **git repo gyökerének**
`.claude/settings.local.json`-jébe ír. Gépszint: `~/.claude/settings.json` →
`permissions.allow`. Szintaxis: `Bash(pnpm test *)`, `Read(./.env)`,
`WebFetch(domain:example.com)`. Kiértékelés: deny → ask → allow, első találat
dönt. **Fájlmódosítási jóváhagyás (`Edit`/`Write`) nem menthető fájlba** — az a
TUI-ban is csak a session végéig él.

**Mérve (M2 spike): a szabályt nem nekünk kell kitalálni, és nem nekünk kell beírni.**
- A `PermissionRequest` `permission_suggestions` mezője hozza a Claude Code saját javaslatát:
  Bash → `Bash(echo x *)`, WebFetch → `WebFetch(domain:…)`, MCP → a tool neve, mind
  `localSettings` céllal; Write/Edit → `setMode: acceptEdits` a sessionre.
- Ha a hook `allow`-t ad vissza `updatedPermissions`-szel, **a Claude Code maga írja be** a
  szabályt: `localSettings` → `.claude/settings.local.json`, `userSettings` →
  `~/.claude/settings.json` (mindkettő mérve).
- **Tetszőleges, általunk megadott szabályt is elfogad**, nem csak a saját javaslatát — ez
  teszi lehetővé a szerkeszthető előnézetet.
- Nyitott: egy átirányítást (`>`) tartalmazó Bash-parancsra írt javasolt szabály ugyanabban a
  sessionben nem akadályozta meg a következő kérdést. Ez a Claude Code illesztési logikája,
  és a natív „don't ask again" gombra ugyanúgy vonatkozik.

### 3.7 Remote Control

A gépen minden sessionre automatikusan bekapcsolt. A 9 élő sessionből 8 hordoz
`bridgeSessionId`-t (`session_01…` formátum).

~~**Kritikus következmény:** ha a daemon elveszi a `PermissionRequest`-et, a natív
prompt nem jön létre, tehát a telefon sem kapja meg.~~ **Mérve (M2 spike): nem így van.**
A hook tartása alatt a prompt a telefonon is megjelenik, és onnan jóváhagyva a tool lefut. A
§6 presence policy ezért kikerült.

### 3.8 VSCode extension parancsai

A hivatalos extension (`anthropic.claude-code-2.1.259-win32-x64`) többek között:
`claude-vscode.editor.openLast`, `claude-vscode.editor.open`,
`claude-vscode.focus`, `claude-vscode.markSessionUnread`,
`claude-vscode.renameSessionTab`. **Kívülről nem hívhatók.** ~~Ezért kell a saját
companion extension, ami a saját ablakából hívja őket.~~ Nem kell: a tabfókuszt a bővítmény
saját URI-kezelője adja (§7, „Tabfókusz”), a companion extension nem készült el (§11, M3).

## 4. Architektúra

```
claudeswitcher/                    pnpm workspace + Nx
├─ packages/core/          session-felderítés, transcript-parse, döntés-modell, hook-szerződés
│                          két belépési ponttal: `index` (Node) és `/browser` (Node-mentes)
├─ packages/daemon/        hook HTTP endpoint, WS hub, poll, DecisionBroker
├─ apps/desktop/           Electron: tray, global hotkey, overlay
```

**A core nem IO-mentes.** A `liveness.ts` (PowerShell-tartalék probe), a `transcript.ts`, a
`settings-writer.ts` és a `paths.ts` `node:` modulokat használ. Ezért két belépési pontja van:
a fő `index` mindent exportál, a `/browser` csak a `node:` importot nem tartalmazó modulokat
(`browser.ts`: döntés-modell, guardok, hook-szerződés, protokoll, szabályszöveg, subagent,
tool-részletek, eszköznevek). A renderer csak a `/browser`-t importálhatja értékként; ezt egy
ESLint-szabály kényszeríti ki (`eslint.config.mjs`, `@typescript-eslint/no-restricted-imports`).

(Az eredetileg tervezett `apps/vscode-ext` companion extension nem készült el, és nem is
kell: a tabfókuszt a Claude Code saját URI-ja adja — lásd §7 és §11.)

**Stack:** 100% TypeScript. Electron (nem Tauri — a memória-érv 64 GB mellett
nem áll, és Tauri Rustot keverne egy egyébként tiszta TS repóba). A
`SetForegroundWindow` / `ShowWindowAsync` hívás `koffi`-val (prebuilt FFI, nincs
node-gyp). Nx, mert az a repók alapértelmezése (axiom, hub) — három csomaghoz nem
szükséges, de a belépési költség egy config fájl.

**A daemon az Electron main processzében fut**, nem külön processzként: egy
tulajdonosa van a WS hubnak, egyszerűbb az életciklus. A modulhatár viszont
megvan, ha később ki kell emelni.

**Form factor:** tálcaikon + global hotkey overlay. Normálisan láthatatlan, a
tray badge mutatja a várakozók számát; a hotkey előhoz egy kompakt listát.

**Billentyűk** (`App.tsx` `onKey`, `decision-actions.ts` `SHORTCUTS`):
- a nyilak a kijelölést mozgatják, az Esc elrejti az overlayt;
- az Enter a kijelölt session ablakára (és tabjára) ugrik, kivéve egy fókuszált gombon,
  `<summary>`-n vagy linken, ahol az elemé. A Tab is ugrik, de csak nyitott döntési panel nélkül:
  a panelen a gombok között lép;
- jóváhagyni a panel betűivel lehet: `tool` kérésnél A = engedélyez, D = tilt, P = projekt-szint,
  G = gép-szint; `edit` kérésnél A, D és S = a session további szerkesztései. Kérdésre és tervre
  nincs betű. Olvashatatlan kérésnél csak a D marad;
- szövegmezőben a gépelés az övé. A betűk ismétlésre, egy frissen megjelent panelen és gépelés
  után rövid ideig nem sülnek el (`key-guard.ts`).

## 5. Adatfolyam

Három bemenet táplál egy állapotgépet:

1. **Felderítés** — `sessions/*.json` + `ide/*.lock` pollozása (§7, `POLL_INTERVAL_MS`), liveness
   pid + `procStart` alapján, párosítás `cwd` ⊂ `workspaceFolders`.
2. **Státusz** — transcript `.jsonl` tailelése → mit csinál épp.
3. **Események** — hookok: `PermissionRequest` (döntést tart), `PostToolUse` /
   `PostToolUseFailure` / `PreToolUse` / `SubagentStop` (natív döntés észlelése),
   `Notification` (jelez), `Stop` / `StopFailure` / `SessionEnd` (életciklus). A teljes lista:
   `hook-contract.ts` `HOOK_CONTRACT`.
4. ~~**Limitek** — statusLine `rate_limits`~~: kivezetve (§3.5).

### A döntés életciklusa (M2, a spike után)

Az alapelv: **az app egy második hely, ahol dönteni lehet — nem veszi el az elsőt.** A natív
prompt a VSCode-ban és a telefonon a teljes idő alatt ott van (§3.4).

```
PermissionRequest ─→ PendingDecision, a HTTP válasz felfüggesztve
                     ├─→ overlay: sor jelenik meg, tray badge nő
                     └─→ közben a natív prompt már látszik a VSCode-ban és a telefonon

   ELSŐ DÖNTÉS NYER — három forrásból:
   ├─ az app (overlay)   → HTTP válasz: allow / deny (+ updatedInput / updatedPermissions)
   ├─ VSCode / telefon   → a daemon a PostToolUse/PostToolUseFailure-ből (allow), a
   │                       megszakított kapcsolatból (natív Nem/Esc, §3.4), vagy a
   │                       Stop/SessionEnd/SubagentStop-ból (a kör vége) tudja meg;
   │                       a függő kérésre üres 200 megy, amit a Claude Code eldob
   └─ elengedés          → 590 mp-nél üres 200 (a hook timeoutja 600); a sor
                           „döntés a VSCode-ban" állapotba vált, a prompt marad
```

**A kérés fajtái szerint mást kínál az overlay:**

| `tool_name` | Az overlay mutatja | Gombok | Válasz a hooknak |
|---|---|---|---|
| Bash, PowerShell, WebFetch, MCP, … | tool, bemenet, ki kéri (session vagy subagent) | Engedélyez · Tilt (indoklással) · Projekt-szinten · Gép-szinten | `allow` / `deny`+`message` / `allow`+`updatedPermissions` |
| Write, Edit | fájl, diff-összegzés | Engedélyez · Tilt · Erre a sessionre automatikusan | `allow` / `deny` / `allow`+`setMode acceptEdits session` |
| AskUserQuestion | a kérdések és az opciók | opció-választás (többválasztósnál több), szabad szöveg → Válasz | `allow`+`updatedInput.answers` (kulcs: kérdés szövege, érték: opció label; több label `", "`-vel összefűzve; szabad szöveg szó szerint) |
| ExitPlanMode | a terv szövege | Elutasít visszajelzéssel · **Jóváhagyás a VSCode-ban** (odaugrik) | `deny`+`message`; jóváhagyni a hookból nem lehet (§10) |

**Projekt- és gépszintű szabály.** A Claude Code javaslata (`permission_suggestions`)
**szerkeszthetően megjelenik**; a felhasználó átírhatja (szűkítheti), és a jóváhagyott
változatot a Claude Code maga írja be (`localSettings` / `userSettings`). Az app semmilyen
beállításfájlt nem ír. A gépszintű opció külön megerősítést kér, mert minden sessionre hat.

**Késői kattintás.** Ha a döntés már megszületett (bármelyik forrásból), az overlay sora
eltűnik; egy közben érkező kattintás no-op. Elengedés után a sor megmarad, de csak
„Ugrás a VSCode-ba" gombbal.

## 6. ~~Presence policy~~ — kikerült

Az eredeti design szerint a tartás elvette volna a natív promptot a telefontól, ezért a
daemon zárolt gépnél, tétlenségnél vagy előtérben lévő ablaknál lemondott volna a
döntésről. A spike megmutatta, hogy **a tartás semmit nem vesz el**: a VSCode és a telefon
ugyanúgy megkapja a promptot, és onnan is el lehet dönteni. Nincs mit védeni.

## 7. Komponensek

### `packages/core`, a tesztelhető mag

Nem IO-mentes; a Node-mentes rész a `/browser` belépési ponton érhető el (§4).

- **`SessionRegistry`** — `sessions/*.json` és `ide/*.lock` parse, liveness,
  párosítás. Bemenete már beolvasott fájltartalom + egy `ProcessProbe`
  interface, így valós fájlok nélkül tesztelhető.
- **`TranscriptReader`** — utolsó N sor → `SessionActivity` (utolsó assistant
  üzenet, futó tool, időbélyeg). Ismeretlen rekordtípus kihagyása kötelező.
- ~~**`RuleBuilder`**~~ — **kikerült**: a szabályt a Claude Code adja
  (`permission_suggestions`).
- **`DecisionModel`** (új, M2) — tiszta függvények a döntés két végére:
  - *besorolás*: `PermissionRequest` → `{ kind: 'tool' | 'edit' | 'question' | 'plan', … }`
    (§5 táblázata), a megjelenítendő adatokkal (tool, bemenet, kérdések, terv, kérő
    subagent);
  - *válasz*: a felhasználó döntése → a hook válasz-JSON-ja (`allow`/`deny`, `updatedInput`,
    `updatedPermissions`). A kérdés-válasz és a szabály-célok formátuma itt van egy helyen,
    táblázatos tesztekkel;
  - *szabály-előnézet*: `permission_suggestions` ⇄ szerkeszthető szöveg (`Bash(echo x *)`),
    érvénytelen szerkesztésnél hiba, nem csendes továbbengedés.
- **`SettingsWriter`** — az M1-ben a hookok telepítésére marad (atomikus, sorba állított,
  parse-biztos). **Az M2 nem használja szabályírásra**: azt a Claude Code végzi. Csak az
  `ENOENT` számít hiányzó fájlnak, minden más olvasási hiba és a tartósan üres olvasás dob; az
  átnevezés előtt `mtimeMs` és méret alapján ellenőrzi, hogy közben nem írt-e más a fájlba; az
  első írás előtt egyszer `settings.json.claudeswitcher-backup` másolatot készít. A desktop
  `config.ts` is ezen át ír.
- **Közös modulok, egy tény egy helyen:** `hook-contract.ts` (a telepített hookok, route-jaik,
  timeoutjuk és az elengedés ideje: `PERMISSION_RELEASE_AFTER_MS` a 600 mp-es timeoutból
  számolva), `timings.ts` (`POLL_INTERVAL_MS`, `PROBE_TTL_MS`), `guards.ts` (bemenet-őrök),
  `tool-names.ts` (eszköznév-halmazok), `protocol.ts` (`DAEMON_PROTOCOL`).

### `packages/daemon`

- **`HookServer`**: csak loopback bind, bearer token headerben, állandó idejű összevetéssel
  (`token-compare.ts`). A route-ok útvonala a core `HOOK_CONTRACT`-jából jön; a
  `PermissionRequest` tartott választ kap.
- **`DecisionBroker`** (M2) — a `PendingDecision`-ök tulajdonosa: létrehozás, idempotens
  resolve, elengedés 590 mp-nél. **A rendszer egyetlen valódi konkurens állapotgépe**,
  ezért külön modul és külön tesztkészlet. Lease-időzítő nincs; a natív döntést a
  `tool_use_id` alapján ismeri fel: a `PreToolUse` (ami közvetlenül a `PermissionRequest`
  előtt jön, ugyanazzal a session/tool/bemenettel) adja a `tool_use_id`-t, a
  `PostToolUse` (vagy a `PostToolUseFailure`) ugyanazzal zárja le. A párosítás kulcsa az
  `agent_id`-t is tartalmazza (`callKey`). Natív Nem/Esc: a Claude Code megszakítja a tartott
  kapcsolatot, a broker erre zár (§3.4). A kör vége: a session `Stop`-ja vagy `SessionEnd`-je,
  subagent kérésénél a `SubagentStop` (ugyanazzal az `agent_id`-vel).
  **Nem** a következő `PreToolUse`: a Claude Code egy sessionen belül párhuzamosan is indíthat
  tool-hívásokat, és egy másik hívás `PreToolUse`-ja egy még függő, jogos kérést zárna le.
  Ami így nyitva marad, azt az 590 mp-es elengedés zárja.
- ~~**`PresencePolicy`**~~ — **kikerült** (§6).
- ~~**`Watchers`** — fájlfigyelők debounce-szal.~~ Fájlfigyelő nincs: a daemon
  `POLL_INTERVAL_MS`-enként (3 mp) újraolvassa a registryt, a lockokat és a transcripteket, és
  minden `Stop`/`StopFailure`/`SessionEnd` hook után azonnal is (`daemon.ts` `refresh`, egyszerre
  csak egy fut). Minden sikeres szkennelés után `tick` megy az overlaynek.
- **`Hub`**: WS az overlay felé (extension nincs). A tokent a kézfogás előtt ellenőrzi
  (`verifyClient`), és minden üzenet hordozza a `protocol` verziót (`DAEMON_PROTOCOL`).

### `apps/desktop`

Electron main: tray + badge, global hotkey, frameless always-on-top overlay,
`koffi` az ablakfókuszhoz. Renderer: a lista, sessiononként státusz, a
várakozóknál a tool és a bemenete. Az M2-ben a várakozó sor kinyitható: a §5 táblázata
szerinti gombok, a kérdésekhez opció-választó, a tervhez a teljes szöveg és
visszajelzés-mező, a szabályhoz szerkeszthető előnézet. A billentyűzetes vezérlés
megmarad (nyilak, Enter, Esc), az overlay a döntés után sem zárul be automatikusan, ha más
is vár. ~~Limitsávok~~: kivezetve (§3.5).

**Keményítés** (az átnézés 5. hulláma): az overlay nem navigálhat (`will-navigate` tiltva), új
ablakot nem nyithat (`setWindowOpenHandler` → `deny`), és minden engedélykérést elutasít. Minden
IPC-kezelő ellenőrzi, hogy a hívás a saját rendererünkből jött (`ipc-sender.ts`
`isOverlaySender`). A renderer CSP-je egy helyen készül (`csp/renderer-csp.ts`): a WebSocket a
pontos daemon-portra (`DAEMON_PORT`, 47821) szűkül, `object-src`, `base-uri` és `form-action`
`'none'`, az `'unsafe-inline'` csak a dev szerveren.

**Elavult telepítés.** Indításkor és minden telepítés vagy eltávolítás után a main összeveti a
`settings.json` hookjait a `HOOK_CONTRACT`-tal (`setup.ts` `hookInstallState`). Ha hiányzik egy
hook, a tálcamenü figyelmeztet: „Integráció elavult, telepítsd újra”. A fájlt ez csak olvassa.

### Tabfókusz (M3) — saját bővítmény nélkül

A Claude Code bővítmény (2.1.304, kódból olvasva) URI-kezelője:
`vscode://anthropic.claude-code/open?session=<sessionId>` → `claude-vscode.primaryEditor.open`
→ ha a sessionnek van tabja, `reveal()`; ha a sidebar tartja, ott mutatja; különben **új** tabot
nyit. Mérve (2026-10-21): a URI a **legfelső, utoljára aktív** VSCode ablakhoz megy — ha az a
session ablaka, a jó tabra vált (akkor is, ha nem a VSCode van előtérben); ha másik, ott új tab
nyílik.

Ezért az app (`focus-window.ts`, `tabFocusUri`) előbb az ablakot hozza elő (M1 útvonal), és
csak akkor küldi a URI-t (`shell.openExternal`, ~200 ms várakozás után), ha az ablak a `pid`
úton ellenőrzötten, vagy a `code <workspaceFolder>` úton jött elő; a `cwd`-s `code`
(esetleg új ablak) és a sikertelen fókusz kizárva. A CLI 2026-10-25 óta `-r` nélkül fut, és
ismerten nem `claude-vscode` sessionre egyáltalán nem fut (indoklás: `focus-window.ts`
`codeCliCommand` és `focusWith`). Csak `entrypoint: claude-vscode` sessionre,
csak UUID-ra, és csak bekapcsolt „Ugrás a pontos Claude-tabra" tálcapipánál. Bármelyik feltétel
hiányában a viselkedés az M1-é: csak ablak.

Döntési felület a VSCode ablakában **nincs** (döntés 2026-10-20): a natív prompt ott amúgy is
látszik, egy második felület csak duplikáció és hibaforrás.

## 8. Hibakezelés

Vezérelv: **az app hibája soha ne blokkoljon egy sessiont.**

- Daemon nem fut / port foglalt / crash → connection refused → natív flow, változatlanul.
  **Mérve** (§10): pontosan úgy működik, mint hook nélkül.
- Electron restart vagy összeomlás felfüggesztett döntésekkel → a kapcsolatok elhalnak →
  **mérve:** a natív prompt marad és válaszolható, a Claude Code nem veszi tiltásnak. Az app
  hibája így soha nem tagad meg egy parancsot.
- **Az app nem dönthet vakon kérdésre és tervre**: az `AskUserQuestion`-re csak a
  felhasználó által választott opciókkal ad `allow`-t, `ExitPlanMode`-ra soha nem ad
  `allow`-t. Egy hibás besorolás tehát legfeljebb egy fölösleges sort jelent, nem egy
  válasz nélkül továbbengedett kérdést.
- **Ismeretlen `sessions/*.json` séma verzióváltás után** → ha egy kötelező mező (`pid`,
  `sessionId`, `cwd`, `startedAt`) hiányzik vagy rossz típusú, a `parseSessionRecord` `null`-t
  ad, és a scanner **eldobja a rekordot**, naplózás nélkül: a session nem jelenik meg a listában.
  Ismeretlen státusz nincs (a `SessionStatus` csak `waiting`, `working`, `idle`). Az approve
  továbbra is működik, mert az a hook `session_id`-jára épül, nem a registryre: a tartott kérés
  saját sorként látszik (`rows.ts`, árva sorok). Szándékos rétegzés: a törékeny felderítés
  bukása nem viszi magával a stabil részt.
- Parse-olhatatlan settings fájl → nem írunk, hibát mutatunk; az Allow attól még
  lemegy.
- Single instance: a második példány csak előhozza az overlay-t.

## 9. Tesztelés

- **`core`** — unit, fixture-alapú, a valós `sessions/`, `ide/` és transcript
  fájlok anonimizált snapshotjaival (beleértve a 20 elárvult lock fájlt és a
  pid-ütközést). A `DecisionModel` táblázatos teszttel, **a spike-ban rögzített valódi
  payloadokkal** fixture-ként (Bash, Write, Edit, WebFetch, MCP, AskUserQuestion,
  ExitPlanMode, subagent).
- **`DecisionBroker`** — konkurencia: app és natív döntés egyszerre; natív döntés a
  `PostToolUse`-ból és a `PostToolUseFailure`-ből; a kör vége a `Stop`/`SessionEnd`/
  `SubagentStop`-ból; a hook kliensének megszakítása (natív Nem/Esc, §3.4); elengedés 590
  mp-nél; kattintás elengedés után; azonos bemenetű párhuzamos hívások ugyanabban a sessionben,
  a fő agent és egy subagent külön párosítva. A következő `PreToolUse` **nem** zár sort (§7).
- **`HookServer`** — szerződéses teszt a **mért** hook JSON-sémákra (nem a dokumentáltakra:
  az M1-ben a dokumentációra hagyatkozás egy rossz mezőnevet eredményezett).
- **Elfogadási teszt** — a spike forgatókönyvének mintájára, a felhasználó gépén.

## 10. Spike — kimérve (2026-10-08)

Eldobható mappában (`P:\08_Apps\cs-spike`), projekt-szintű hookokkal, a futó sessionök és
a globális konfiguráció érintése nélkül (egyetlen kivétel a K5: egy ártalmatlan próbaszabály
a globális fájlban, utána eltávolítva, a fájl bitre azonos a mentéssel). Eszköz és teljes
eredmény: `spikes/m2-permission/` (`RESULTS.md`).

| Eredeti kérdés | Eredmény |
|---|---|
| 1. Mire fut le a `PermissionRequest`? | Bash, PowerShell, Write, Edit, WebFetch, MCP, AskUserQuestion, ExitPlanMode — mind. Folder-trust nem jött elő |
| 2. Elengedés után natív prompt, vár-e? | A prompt **eleve** látszik; elengedés után válaszolható marad |
| 3. Elveszi-e a promptot a Remote Controltól? | **Nem** |
| 4. Timeout > 600? | Nem mérve — a lease-modell nélkül nincs rá szükség |
| 5. claude.ai session-URL | Nem mérve — M3/QR-kód kérdés |

**Az új igényekre** (a felhasználó döntése: kérdésre és tervre az appból is lehessen
válaszolni; gépszintű szabály szerkeszthető előnézettel): kérdés-válasz ✅, terv elutasítása
visszajelzéssel ✅, **terv jóváhagyása ❌** (sima `allow`, `allow`+`setMode`, és `PreToolUse`
`allow` — mindhárom esetben a jóváhagyó ablak megmaradt; egybevág egy bejelentett Claude
Code-hibával), átírt szabály projekt- és gépszinten ✅.

**A spec jóváhagyása után kimérve (3. kör):**

1. **Biztonság ✅:** ha a hook-szerver nem fut, vagy tartás közben leáll, a natív prompt
   marad, és „Yes"-re a tool lefut. A Claude Code a hiba-hookot „nincs döntés"-nek veszi.
2. **Kérdés-válasz formátum:** szabad szöveg ✅ (a felületen „Other" alatt). Többválasztós:
   tömbként a session helyesen érti, de a felület „Other"-ként mutatja; az M2 a dokumentált
   `", "`-vel összefűzött szöveget küldi, és az elfogadási teszt ellenőrzi.
3. **Telefonos válasz ✅:** a `PostToolUse` a válasszal és a `tool_use_id`-vel érkezik, a
   daemon le tudja zárni a sort.

## 11. Mérföldkövek

**M1 — read-only monitor. ✅ Kész (2026-10-08), élesben használt.** Felderítés, státusz,
`Notification` hook a prompt szövegével, ablakra ugrás (több ablakos VSCode-processznél
`code -r`), állítható gyorsbillentyű, tray + overlay, veszteségmentes telepítés/eltávolítás.
Limitek: a bővítményben nem működik (§3.5). A session-felderítés élesben stabilnak bizonyult
(14 session, egy közös VSCode-pid mellett is helyes ablakválasztással).

**M2 — approve. ✅ Kész (2026-10-20).** Elkészült: engedélyezés, tiltás indoklással,
projekt- és gépszintű szabály, kérdés megválaszolása, terv elutasítása; az A–M elfogadási teszt
lefutott. Utójavítások: állapotpöttyök, Remote Control-pötty, alul rögzített gombsor, a
legrégebbi várakozó kijelölése (opcionális automatikus elrejtéssel), a teljes ág review-jának
javításai, újraindulás után a registry-alapú várakozás (§3.1). A fájlírásnál (Write, Edit,
MultiEdit, NotebookEdit) a panel előnézetet mutat: új tartalom, illetve `-`/`+` sorok
(a §5 „diff-összegzése"), méretkorláttal.

Az eredeti terv: `PermissionRequest` + `PreToolUse` + `PostToolUse` hook,
`DecisionModel`, `DecisionBroker`, az overlay döntési felülete (§5 táblázata): engedélyezés,
tiltás indoklással, projekt- és gépszintű szabály szerkeszthető előnézettel, kérdés
megválaszolása, terv elutasítása visszajelzéssel. Az első lépés a §10 nyitott pontjainak
mérése. Az M1 telepítéséből kikerül a soha nem tüzelő `SessionStart` HTTP-hook (az
eltávolítás a régi bejegyzést továbbra is felismeri és kiveszi).

**M3 — tabfókusz. ✅ Kész (2026-10-21), saját bővítmény nélkül.** A mérés előtti
kódolvasás megtalálta a Claude Code saját URI-kezelőjét (§7, „Tabfókusz"); a felhasználó mérése
szerint a jó ablak előhozása után ez a pontos tabra vált. A tervezett companion extension
emiatt elmaradt; a VSCode-on belüli döntési felület már korábban kikerült (2026-10-20).

~~**Következő:** a subagent-átiratok olvasása (`subagents/agent-*.jsonl`).~~ Kész
(2026-10-21, `0eee9b1`): a sor a futó subagent aktuális lépését is mutatja.

**Teljes repó-átnézés (2026-10-25) és javításai.** ✅ Az első hat hullám kész, a 7. (Electron-frissítés)
következik: `docs/reviews/2026-10-25-repo-review.md`, „Eredmény”. Az utána jövő funkciók
ütemezése: `docs/backlog.md`.

Az M1 még nyitott halasztott tételei a `docs/backlog.md` „Halasztott tételek” részében vannak.

## 12. Kockázatok

| Kockázat | Hatás | Kezelés |
| --- | --- | --- |
| `sessions/` és `ide/` formátum nem dokumentált, verzióváltásnál törhet | a lista elromlik | §8 rétegzés: az approve független tőle; séma-validáció, graceful degradation |
| A hookok a globális `~/.claude/settings.json`-be kerülnek → minden sessionre hatnak | szélesebb blast radius, mint az app | a natív prompt a tartás alatt is él (§3.4); a leállt vagy összeomló daemon mérten nem blokkol és nem tilt (§8) |
| ~~Az interception elveszi a promptot a Remote Controltól~~ | — | mérve: nem veszi el (§3.7) |
| ~~statusLine bevezetése elrejti a footer hinteket~~ | — | a statusLine kivezetve (§3.5) |
| Túl bő szabály kerül be projekt- vagy gépszinten | tartós, nem szándékolt engedély | a szabály szerkeszthetően megjelenik, a gépszint külön megerősítést kér |
| Az app „engedélyez" egy kérdést válasz nélkül | a session rossz feltevéssel megy tovább | a `DecisionModel` kérdésre csak kiválasztott opcióval ad `allow`-t |
| A dokumentálatlan viselkedés egy Claude Code frissítéssel változik | egy funkció csendben elromlik | a nyers hook-napló (`CLAUDESWITCHER_HOOK_LOG`) gyorsan megmutatja; a szerződéses tesztek a mért payloadokra épülnek |

## 13. Amit szándékosan nem építünk

- Remote Control mint transzport (felhő, nem dokumentált kliensprotokoll).
- A `messagingSocketPath` named pipe használata (nem dokumentált peer-protokoll;
  promptküldésre volna jó, ami nem cél).
- Auto-approve / turbo mód. Ha később kell, a `DecisionBroker` a helye.
- Session indítás, leállítás, promptküldés.
- Cross-platform támogatás.
