# ClaudeSwitcher — design

**Dátum:** 2026-09-04
**Állapot:** jóváhagyott design, implementációs terv következik
**Platform:** Windows 11, VSCode + Claude Code extension (v2.1.259)

## 1. Probléma

A gépen rendszeresen fut 8–10 Claude Code session párhuzamosan, mind a VSCode
extensionben, gyakran több ugyanabban az ablakban. Nincs egységes nézet arról,
melyik vár approve-ra, melyik dolgozik, melyik végzett. Az oda-navigálás
manuális ablakvadászat, és nincs rálátás a session/heti limitek állására.

A hivatalos `claude agents` (Agent View) ezt nem oldja meg: dokumentáltan **csak
a háttérbe tett (`--bg`) sessionöket** mutatja, a VSCode extension sessionöket
nem — vagyis pont a releváns halmazt hagyja ki.

## 2. Célok

1. Egy helyen látni minden futó Claude Code sessiont és az állapotát.
2. Egy gombnyomással a megfelelő VSCode **ablakra és tabra** ugrani.
3. Az appon belül approve-olni, ablakváltás nélkül — és nemcsak egyszer, hanem
   projekt- vagy gépszinten is engedélyezni.
4. Látni a session (5 órás) és a heti limit állását, és hogy mikor újul.

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
  "sessionId": "02df22e9-0cb8-4e89-8124-fb3c597ee4f0",
  "cwd": "p:\\01_Fullstack\\journal",
  "startedAt": 1788447404737,
  "procStart": "134329210033019891",
  "version": "2.1.259",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle", "artifact_yield"],
  "kind": "interactive",
  "entrypoint": "claude-vscode",
  "pidDomain": "win32:alex",
  "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-c8069e676803e36cb1544f862324e43c",
  "name": "journal-58",
  "nameSource": "derived",
  "nameSince": 1788447404738,
  "bridgeSessionId": "session_01LtDxAq3W2y7XNbXfPk1nVF"
}
```

Mellette `<pid>.<hash>` fájl: `{"peerToken":"…","procStartFt":"…","pidDomain":"…"}`.

A `procStart` a Windows process creation FILETIME. **Liveness-ellenőrzéshez a
pid önmagában nem elég** — a `~/.claude/ide/` mappában jelenleg 20 lock fájl
van, és a 8108-as pid két különböző workspace-szel is szerepel (pid-újra-
hasznosítás). Liveness = pid létezik **és** a process creation time egyezik.

### 3.2 VSCode-ablak leképezés (nem dokumentált)

`~/.claude/ide/<port>.lock`:

```json
{
  "pid": 8108,
  "workspaceFolders": ["p:\\08_Apps\\ClaudeSwitcher"],
  "ideName": "Visual Studio Code",
  "transport": "ws",
  "runningInWindows": true,
  "authToken": "cc6b82e3-…"
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

### 3.4 Hookok (dokumentált, stabil felület)

- **`PermissionRequest`** — akkor fut, amikor egy tool-hívásnál engedély-döntés
  kell. Bemenet: `session_id`, `prompt_id`, `transcript_path`, `cwd`,
  `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`,
  `permission_decision_context` (`matched_rule`, `rule_type`, `confidence`).
  Kimenet:
  ```json
  {"hookSpecificOutput": {
     "hookEventName": "PermissionRequest",
     "decision": "allow" | "deny" | "plan",
     "permissionDecisionReason": "…"}}
  ```
  **Exit 0 üres kimenettel = nincs döntés → a hívás a normál permission flow-n
  megy tovább**, azaz megjelenik a natív prompt és vár. Timeout esetén a kimenet
  eldobásra kerül, azaz szintén nincs döntés. Ez a lease-modell alapja.
- **`Elicitation`** — MCP szerver felhasználói inputot kér; matcher a szerver
  nevére. Ugyanaz a mechanizmus.
- **`Notification`** — display-only, **nem tud blokkolni**. `notification_type`
  értékek közül releváns: `permission_prompt`, `idle_prompt`,
  `agent_needs_input`, `agent_completed`.
- **`SessionStart` / `SessionEnd` / `Stop`** — életciklus, pontosabb és
  olcsóbb, mint a pollozás.

HTTP hook konfiguráció:

```json
{"type": "http", "url": "http://127.0.0.1:<port>/hooks/permission-request",
 "timeout": 200, "headers": {"Authorization": "Bearer $CLAUDESWITCHER_TOKEN"},
 "allowedEnvVars": ["CLAUDESWITCHER_TOKEN"]}
```

Alapértelmezett timeout 600 s; nincs dokumentált felső korlát. Nem-2xx válasz =
hook-hiba, nem blokkol → normál flow.

### 3.5 Limitek (dokumentált)

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

### 3.6 Permission-szabályok írása (dokumentált)

A TUI "Yes, and don't ask again" a **git repo gyökerének**
`.claude/settings.local.json`-jébe ír. Gépszint: `~/.claude/settings.json` →
`permissions.allow`. Szintaxis: `Bash(pnpm test *)`, `Read(./.env)`,
`WebFetch(domain:example.com)`. Kiértékelés: deny → ask → allow, első találat
dönt. **Fájlmódosítási jóváhagyás (`Edit`/`Write`) nem menthető fájlba** — az a
TUI-ban is csak a session végéig él.

### 3.7 Remote Control

A gépen minden sessionre automatikusan bekapcsolt. A 9 élő sessionből 8 hordoz
`bridgeSessionId`-t (`session_01…` formátum).

**Kritikus következmény:** a Remote Control a **natív promptot** viszi ki a
telefonra. Ha a daemon elveszi a `PermissionRequest`-et, a natív prompt nem jön
létre, tehát a telefon sem kapja meg. Ezt a §6 presence-policy oldja fel.

### 3.8 VSCode extension parancsai

A hivatalos extension (`anthropic.claude-code-2.1.259-win32-x64`) többek között:
`claude-vscode.editor.openLast`, `claude-vscode.editor.open`,
`claude-vscode.focus`, `claude-vscode.markSessionUnread`,
`claude-vscode.renameSessionTab`. **Kívülről nem hívhatók** — ezért kell a saját
companion extension, ami a saját ablakából hívja őket.

## 4. Architektúra

```
claudeswitcher/                    pnpm workspace + Nx
├─ packages/core/          session-felderítés, transcript-parse,
│                          szabálygenerálás, settings-írás — tiszta TS, IO nélkül
├─ packages/daemon/        hook HTTP endpoint, WS hub, fájlfigyelők, presence
├─ apps/desktop/           Electron: tray, global hotkey, overlay
└─ apps/vscode-ext/        companion extension
```

**Stack:** 100% TypeScript. Electron (nem Tauri — a memória-érv 64 GB mellett
nem áll, és Tauri Rustot keverne egy egyébként tiszta TS repóba). A
`SetForegroundWindow` / `ShowWindow` hívás `koffi`-val (prebuilt FFI, nincs
node-gyp). Nx, mert az a repók alapértelmezése (axiom, hub) — négy csomaghoz nem
szükséges, de a belépési költség egy config fájl.

**A daemon az Electron main processzében fut**, nem külön processzként: egy
tulajdonosa van a WS hubnak, egyszerűbb az életciklus. A modulhatár viszont
megvan, ha később ki kell emelni.

**Form factor:** tálcaikon + global hotkey overlay. Normálisan láthatatlan, a
tray badge mutatja a várakozók számát; a hotkey előhoz egy kompakt listát
(Enter = approve, Tab = ugrás, Esc = eltűnik).

## 5. Adatfolyam

Négy bemenet táplál egy állapotgépet:

1. **Felderítés** — `sessions/*.json` + `ide/*.lock` figyelése, liveness pid +
   `procStart` alapján, párosítás `cwd` ⊂ `workspaceFolders`.
2. **Státusz** — transcript `.jsonl` tailelése → mit csinál épp.
3. **Események** — hookok: `Notification` (jelez), `PermissionRequest` és
   `Elicitation` (döntést tart), `SessionStart`/`SessionEnd`/`Stop` (életciklus).
4. **Limitek** — statusLine `rate_limits`.

### A döntés életciklusa

```
PermissionRequest ─→ PresencePolicy: take vagy defer?
                     │
   defer ────────────┴─→ üres 200 ─→ natív prompt a VSCode tabban,
                                      Remote Control kiviszi telefonra
   take ─→ PendingDecision, HTTP válasz felfüggesztve
           ├─→ overlay: sor megjelenik, tray badge nő
           ├─→ companion ext a session ablakában: toast, ugyanazok a gombok
           └─→ lease timer indul (alap: 3 perc, konfigurálható)

     bármelyik kattintás ─→ első nyer, idempotens resolve,
                            a többi felület törli magát
        ├─ Allow / Deny      → HTTP válasz: decision
        ├─ Projekt szinten   → szabály .claude/settings.local.json-be, majd Allow
        └─ Gép szinten       → szabály ~/.claude/settings.json-be, majd Allow

     lease lejár ─→ üres 200 ─→ natív prompt, vár a végtelenségig,
                                 telefon is megkapja (késleltetve)
```

A "Projekt/Gép szinten" gomboknál a generált szabály **szerkeszthetően
megjelenik, mielőtt bárhova beírnánk**. Ez az egyetlen pont, ahol az app
tartósan módosítja a konfigurációt.

**Lease és hook-timeout viszonya.** A lease-nek mindig rövidebbnek kell lennie,
mint a hook `timeout`-ja (alap: 180 s lease, 200 s timeout). Így az elengedést
mindig a daemon kezdeményezi kontrolláltan, üres 200-zal — nem a Claude Code
oldali timeout, ami hook-hibaként naplózódna. Az invariánst indításkor
ellenőrizni kell, és a hook-konfigot a daemon generálja, hogy a kettő ne
csúszhasson szét.

**Lease után érkező kattintás.** Az elengedéssel a `PendingDecision` lezárul, és
a felületek azonnal törlik a sort. Egy ezután érkező kattintás no-op: a resolve
idempotens, és a HTTP válasz már elment. A felhasználót ilyenkor a natív prompt
várja a VSCode tabban.

## 6. Presence policy

A modell: **az app arra való, amikor a gépnél vagy; a Remote Control arra,
amikor nem.** A daemon hook-időben dönt:

| Feltétel | Döntés | Miért |
| --- | --- | --- |
| Munkaállomás zárolva | azonnali defer | natív prompt → Remote Control → telefon |
| Input-idle > N perc (alap: 5) | azonnali defer | ugyanaz — nem vagy ott |
| A session VSCode ablaka előtérben | azonnali defer | megszokott natív prompt ott, ahol nézed |
| Egyéb | take | overlay + VSCode toast, lease alatt |

Az idle-mérés Win32 `GetLastInputInfo`. A küszöb és a lease hossza konfigurálható.

## 7. Komponensek

### `packages/core` — IO-mentes, a tesztelhető mag

- **`SessionRegistry`** — `sessions/*.json` és `ide/*.lock` parse, liveness,
  párosítás. Bemenete már beolvasott fájltartalom + egy `ProcessProbe`
  interface, így valós fájlok nélkül tesztelhető.
- **`TranscriptReader`** — utolsó N sor → `SessionActivity` (utolsó assistant
  üzenet, futó tool, időbélyeg). Ismeretlen rekordtípus kihagyása kötelező.
- **`RuleBuilder`** — `tool_name` + `tool_input` → javasolt permission szabály.
  A legkényesebb tiszta függvény: prefix-levágás, wildcardolás, és annak
  ismerete, mikor **nem** ajánlható szabály (`Edit`/`Write` fájlmódosítás).
- **`SettingsWriter`** — atomikus merge (temp + rename). Soha nem írja felül a
  fájlt, csak a `permissions.allow` tömböt bővíti; a meglévő kulcsok (`model`,
  `enabledPlugins`, `effortLevel`, `tui`, `hooks`) érintetlenek maradnak.

### `packages/daemon`

- **`HookServer`** — csak loopback bind, bearer token headerben.
- **`DecisionBroker`** — a `PendingDecision`-ök tulajdonosa: létrehozás, lease
  timer, idempotens resolve, release. **A rendszer egyetlen valódi konkurens
  állapotgépe**, ezért külön modul és külön tesztkészlet.
- **`PresencePolicy`** — §6 szerint; tiszta függvény + vékony Win32 probe.
- **`Watchers`** — fájlfigyelők debounce-szal.
- **`Hub`** — WS, közös csatorna az overlay és az extensionök felé.

### `apps/desktop`

Electron main: tray + badge, global hotkey, frameless always-on-top overlay,
`koffi` az ablakfókuszhoz. Renderer: a lista, sessiononként státusz, a
várakozóknál a tool és a bemenete, alul a limitsávok. Sessiononként Remote
Control deep link + QR (a `bridgeSessionId`-ből), és jelzés, ha egy session
**nem** bridge-elt — arra az idle-defer ág nem ad semmit.

### `apps/vscode-ext`

Csatlakozik a hubhoz, bejelenti `{workspaceFolders, pid}`. Két képessége van:
tabfókusz (`claude-vscode.editor.openLast` + `claude-vscode.focus`) és
approve-toast megjelenítése a saját ablakában.

## 8. Hibakezelés

Vezérelv: **az app hibája soha ne blokkoljon egy sessiont.**

- Daemon nem fut / port foglalt / crash → connection refused vagy nem-2xx →
  natív flow, változatlanul.
- Electron restart felfüggesztett döntésekkel → a kapcsolatok elhalnak → a
  Claude Code hook-hibát lát → natív flow. Elveszett döntés = biztonságos
  fallback, nem beragadás.
- **Ismeretlen `sessions/*.json` séma verzióváltás után** → az érintett session
  "ismeretlen" státusszal jelenik meg, de az approve továbbra is működik, mert
  az a hook `session_id`-jára épül, nem a registryre. Szándékos rétegzés: a
  törékeny felderítés bukása nem viszi magával a stabil részt.
- Parse-olhatatlan settings fájl → nem írunk, hibát mutatunk; az Allow attól még
  lemegy.
- Single instance: a második példány csak előhozza az overlay-t.

## 9. Tesztelés

- **`core`** — unit, fixture-alapú, a valós `sessions/`, `ide/` és transcript
  fájlok anonimizált snapshotjaival (beleértve a 20 elárvult lock fájlt és a
  pid-ütközést). A `RuleBuilder` táblázatos teszttel, a "nincs ajánlható
  szabály" esetekkel együtt.
- **`DecisionBroker`** — konkurencia: két felület egyszerre resolve-ol; lease
  lejár resolve közben; resolve lease után.
- **`HookServer`** — szerződéses teszt a dokumentált hook JSON-sémákra.
- **Integrációs spike (§10)** — kézi, de kötelező, kódolás előtt.

## 10. Spike — amit kódolás előtt ki kell mérni

Eldobható mappában, saját `.claude/settings.json`-nal, a futó sessionök
érintése nélkül:

1. A `PermissionRequest` pontosan mire fut le és mire nem: Bash, Edit, Write,
   WebFetch, MCP tool, plan-mode kilépés, folder-trust.
2. A lease-elengedés (üres 200, illetve timeout) tényleg natív promptot ad-e, és
   az tényleg végtelenségig vár-e.
3. Az interception valóban elveszi-e a promptot a Remote Controltól.
4. A `timeout` mező elfogad-e 600-nál nagyobb értéket.
5. A claude.ai session-URL pontos alakja a `bridgeSessionId`-ből.

## 11. Mérföldkövek

**M1 — read-only monitor (a "C" scope).** Felderítés, státusz, `Notification`
hook, ablakra ugrás (`code -r`), limitek statusLine-ból, tray + overlay. Nincs
`PermissionRequest`, nincs settings-írás, nincs companion extension.
*Önállóan használható, és kiméri a rendszer legtörékenyebb rétegét.*

**M2 — approve.** `PermissionRequest` + `Elicitation` hook, `DecisionBroker`,
`PresencePolicy`, `RuleBuilder` + `SettingsWriter`, projekt/gép szintű
engedélyezés.

**M3 — companion extension.** Tabfókusz és párhuzamos approve a VSCode
ablakban.

Az M1 → M2 átmenet előtt felül kell vizsgálni: ha az M1 alatt a session-
felderítés instabilnak bizonyul, az M2 kockázata nő.

## 12. Kockázatok

| Kockázat | Hatás | Kezelés |
| --- | --- | --- |
| `sessions/` és `ide/` formátum nem dokumentált, verzióváltásnál törhet | a lista elromlik | §8 rétegzés: az approve független tőle; séma-validáció, graceful degradation |
| A hookok a globális `~/.claude/settings.json`-be kerülnek → minden sessionre hatnak | szélesebb blast radius, mint az app | a hibamód biztonságos (defer); az M1 hookja blokkolni sem tud |
| Az interception elveszi a promptot a Remote Controltól | telefonos approve elvész | §6 presence policy |
| statusLine bevezetése elrejti a footer hinteket | apró UX-veszteség a TUI-ban | a statusLine hasznosat is mutat |
| A `RuleBuilder` túl bő szabályt generál | tartós, nem szándékolt engedély | a szabály szerkeszthetően megjelenik írás előtt |

## 13. Amit szándékosan nem építünk

- Remote Control mint transzport (felhő, nem dokumentált kliensprotokoll).
- A `messagingSocketPath` named pipe használata (nem dokumentált peer-protokoll;
  promptküldésre volna jó, ami nem cél).
- Auto-approve / turbo mód. Ha később kell, a `DecisionBroker` a helye.
- Session indítás, leállítás, promptküldés.
- Cross-platform támogatás.
