# Teljes repó-átnézés, 2026-10-25

Alap: `main @ cd83458`, tiszta munkafa. Cél: az app legyen jövőálló és stabil, mielőtt új funkció jön.

Öt független, csak olvasó átnéző nézte végig a repót, mindegyik más szemszögből:

| Jel | Szemszög | Modell |
|---|---|---|
| A | Döntési útvonal: helyesség és párhuzamosság (daemon, core) | opus |
| B | Biztonság és bizalmi határ | opus |
| C | Electron main processz, OS-integráció, hosszú futás | opus |
| D | Renderer UI és a tesztkészlet minősége | opus |
| E | Architektúra, karbantarthatóság, jövőállóság (teljes repó) | fable |

A döntő állításokat a vezető maga ellenőrizte a kódban. Ezeknél az „Ellenőrizve” oszlop szerepel. Ez saját ellenőrzés, nem független átnézés.

**Alapmérés (vezető, előtérben, Nx-cache nélkül):**
- `pnpm -r check-types`: 0.
- `pnpm lint --skip-nx-cache`: 0.
- `pnpm build --skip-nx-cache`: 0.
- `pnpm test --skip-nx-cache`, minden zöld:
  - core 152;
  - daemon 141;
  - desktop 231, plusz 1 kihagyott kézi mérés;
  - statusline 9.

D minden csomagot háromszor futtatott, és nem talált instabil tesztet.

**Súlyossági skála:**
- **P0:** hamis vagy elveszett engedélydöntés, sérült settings.json, összeomlás vagy fagyás, biztonsági rés.
- **P1:** valódi hiba, amibe valószínűleg belefutsz.
- **P2:** robusztussági vagy karbantarthatósági kockázat.
- **P3:** apró javítás.

A „VALÓSZÍNŰ” jelölésű tételeket mérés még nem igazolta. Ott a tétel leírja, mi döntené el.

---

## 1. Javítani

### 1. hullám: döntésbiztonság a billentyűzeten

Ezt három átnéző (A, B, D) egymástól függetlenül találta meg. Ez a legerősebb jel az egész átnézésben.

| # | Súly | Mi a hiba | Hol | Ellenőrizve |
|---|---|---|---|---|
| 1.1 | P0 | **Gépelés közben eltűnő mező.** Az X kéréshez épp indoklást gépelsz, közben X máshol lezárul: a VS Code-ban, egy subagent leállásával, vagy a kliens bontja a kapcsolatot. A panel ekkor újraépül Y kéréssel, a fókusz a `body`-ra esik, és a mondatod következő `a` betűje jóváhagyja Y-t. Az `s` betű a session összes további szerkesztését engedélyezi. Ha az egész sor eltűnik, a kijelölés a 0. sorra esik vissza, és a billentyűk annak a kéréseire hatnak. | `DecisionPanel.tsx` `onKey`, `selection.ts` `resolveSelectedIndex` | igen, a kódban |
| 1.2 | P1 | **Nyomva tartott vagy duplán nyomott A.** Az első jóváhagyás után a kijelölés a következő váró kérésre ugrik, és a billentyűismétlés (kb. 500 ms után 30/s) vagy a második koppintás azt is jóváhagyja. Az `event.repeat` nincs szűrve, és az új kérés azonnal élesedik. Kisebb ablakkal ugyanez a megnyitás után: az első betű még a régi panelre megy. | `DecisionPanel.tsx` `onKey`, `App.tsx` `afterDecision`, `onShown` | igen, a kódban |
| 1.3 | P1 | **Enter egy fókuszált gombon vagy `<summary>`-n a VS Code-ba ugrik,** ahelyett hogy megnyomná, mert az App `preventDefault`-ot hív. A Tab a gombok között lép, az Enter ezért a természetes következő billentyű. A tervpanelen így billentyűzettel csak a Tab+Space marad az elutasításra. | `App.tsx` `onKey` | igen, a kódban |
| 1.4 | P2 | **Vakon jóváhagyható kérés.** Ha a Claude Code formátumot vált, előfordulhat, hogy a Bash kérésnek nincs olvasható `command`-ja, vagy az Editnek nincs `file_path`-ja. A panel ekkor csak annyit mutat: „Bash”, és az `a` mégis engedi. A kérdésnél már van ilyen tiltás, a többi fajtánál nincs. | `core/decision.ts` `parsePermissionRequest`, `decision-response.ts` `buildHookResponse` | nem |
| 1.5 | P2 | **Rejtett tartalom a panelen.** | lásd lent | részben |
| 1.6 | P2 | **Korlát nélkül renderelt parancs.** Egy heredoc-os nagy Bash parancs teljes hosszában egy `<pre>`-be kerül. Ugyanez a fájl dokumentálja, hogy ez lefagyasztja az overlayt; a `DETAILS_LIMIT` a Bashre nem vonatkozik. | `DecisionPanel.tsx` `decision-summary`, `tool-details.ts` `NO_DETAILS_TOOLS` | nem |

**Az 1.5 részei:**
- A Bash/PowerShell panel a parancson és a leíráson kívül minden mezőt elrejt, a `dangerouslyDisableSandbox: true`-t is. Egy sandbox nélküli futás így ugyanúgy néz ki, mint egy sandboxos.
- Sok sortörés vagy láthatatlan Unicode-karakter (U+200B, U+202E) mögé elbújhat egy parancsrész.
- A RuleEditor 3 soros, és az alá csúszó szabályok is beíródnak.
- A puszta `Bash` vagy a `Bash(*)` szabályra nincs figyelmeztetés.
- A `parseSuggestedRules` nem nézi a javaslat `behavior` mezőjét, és az üres `ruleContent`-ből puszta eszközszabályt csinál.
- A többsoros szabály nem megy át oda-vissza a szerkesztőn.
- Érintett: `tool-details.ts`, `RuleEditor.tsx`, `core/decision.ts` `parseSuggestedRules`, `rule-text.ts`. Ellenőrizve részben: a `rows={3}` igen.

**Javítás:**
- Egy tiszta `keyAction` függvény, tesztekkel. Ez fedi az 1.1 és az 1.2 hibát, és ez adja a ma hiányzó renderer-billentyűteszteket is. Feltételei:
  - az `event.repeat` tiltva;
  - kb. 400 ms élesítés minden új `decision.id`-nél és minden `overlay:shown`-nál;
  - 1,5 s szünet, ha nemrég szövegmezőbe gépeltél.
- **Miért nem megerősítő lépés:** megduplázná a billentyűket abban a munkafolyamatban, amiért az app létezik. Ezek a védelmek normál használatban nem kerülnek semmibe.
- Az 1.3 javítása: Enternél korai visszatérés, ha a cél `button, summary, a`.
- Az 1.4 javítása: fajtánként egy `readable` jelző a core-ban. Olvashatatlan kérésre a `buildHookResponse` minden allow-t elutasít, a tiltás és az ugrás marad. Így a tiltás egy helyen él, és a UI-ban nem kell megismételni.
- Az 1.5 javítása:
  - a Bash panel mutasson minden további mezőt, a `dangerouslyDisableSandbox` kiemelve;
  - „N sor” jelzés;
  - a láthatatlan karakterek látható escape-pel (`⟨U+202E⟩`);
  - a szabályszerkesztő méreteződjön a sorszámhoz;
  - a puszta eszközszabály piros megerősítést kérjen;
  - csak `behavior === 'allow'` javaslat jöjjön át.
- Az 1.6 javítása: a megjelenítés `DETAILS_LIMIT`-nél vágódjon. Az adat maradjon teljes.
- Méret: S, kivéve az 1.5-öt, ami S/M.

### 2. hullám: a settings.json és az app saját fájljai

| # | Súly | Mi a hiba | Hol | Ellenőrizve |
|---|---|---|---|---|
| 2.1 | P1 (hatása P0) | **A globális settings.json felülíródhat.** Ha az olvasás bármilyen okból hibát dob (EBUSY, EPERM, víruskereső), vagy épp egy másik író csonkolása közben üresen kapja el a fájlt, akkor `existing = {}` lesz. A Telepítés ekkor csak a mi kulcsainkkal írja felül a fájlt: a permissions, a model, a többi hook és az env mind elvész. Az Eltávolítás ugyanígy `{}`-t ír. | `core/settings-writer.ts` `writeTransformed` | igen, a kódban |
| 2.2 | P2 | **A token csendben lecserélődik.** Bármilyen olvasási hibánál új token jön létre, és onnantól minden telepített hook 401-et kap. A Claude Code ezt nem blokkoló hibaként kezeli, így a döntések csendben nem érkeznek meg. Ugyanez a minta a `config.ts` `readRaw`-ban. Az `updateConfig` nincs sorba állítva, és mindig ugyanazt a temp nevet használja. | `main/token.ts` `loadOrCreateToken`, `main/config.ts` | igen, a token |
| 2.3 | P2 | **Idegen hook törlődhet.** Az `isOurHook` tartalék ága nem nézi a portot, így a Telepítés törölheti egy másik eszköz `http://127.0.0.1:<más port>/hooks/notification` hookját. | `main/setup.ts` `isOurHook` | nem |

**Javítás:**
- Csak az `ENOENT` számít hiánynak, minden más hibát dobjon tovább.
- Az üres fájl ne számítson „nincs fájlnak”.
- `mtimeMs` és méret ellenőrzése a `rename` előtt, korlátozott újrapróbálással.
- Egyszeri `settings.json.claudeswitcher-backup` az első telepítés előtt.
- A `config.ts` és a `token.ts` használja a core sorba állító íróját.
- Az `isOurHook` tartalék ága a `DAEMON_PORT`-ra szűrjön, teszttel.
- **Miért nem zárfájl:** a Claude Code és a szerkesztők nem tisztelik, csak az optimista ellenőrzés vesz észre egy idegen írót.
- Méret: S.

### 3. hullám: ablakkezelés és a main processz

| # | Súly | Mi a hiba | Hol | Ellenőrizve |
|---|---|---|---|---|
| 3.1 | P1 | **Alt+F4 véglegesen megsemmisíti az overlayt.** Nincs `close` kezelő. Utána a gyorsbillentyű és a tálca „Megnyitás” menüpontja „Object has been destroyed” kivételt dob, a hookok közben tovább élnek. | `main/index.ts` `createOverlay`, `showOverlay` | igen, nincs `close` kezelő |
| 3.2 | P1 (VALÓSZÍNŰ, P0, ha igaz) | **`code -r <mappa>` lecserélheti a legutóbb aktív VS Code ablak munkaterületét,** ha a mappa sehol nincs nyitva. Ez újratölti azt az ablakot, a benne futó Claude Code sessionökkel együtt. Ez az út akkor fut, ha nincs párosított lock: terminálos, SDK-s, `claude -p` sessionöknél és elavult locknál. | `main/focus-window.ts` `focusByCli` | nem, mérés kell |
| 3.3 | P1 | **Feltétel nélküli `ShowWindow(hwnd, SW_RESTORE)`.** Visszaméretezi a maximalizált VS Code-ot. Ráadásul szinkron, folyamatok közötti hívás, így egy lefagyott VS Code a main szálat, vele a daemont, és ezen át minden session tool-hookját megakaszthatja. | `main/focus-window.ts` `focusByPid` | igen, a kódban |
| 3.4 | P2 | **Elgépelt gyorsbillentyű a config.json-ban,** és az app el sem indul. A hibaüzenet nem nevezi meg a fájlt. | `main/hotkey.ts` `registerHotkey` | nem |
| 3.5 | P2 (VALÓSZÍNŰ) | **Elavult IDE lockok és pid-újrahasznosítás.** A gépen 139 lockból 116 hét napnál régebbi. Egy újrahasznosított pid, amely bármelyik `Code.exe` segédprocesszre esik, átmegy az `ownsLock`-on, így rossz ablak vagy mappa jöhet ki. | `core/liveness.ts` `ownsLock`, `bestWindow` | nem |
| 3.6 | P3 | **Apróságok** (lásd lent). | `main/index.ts`, `daemon/hub.ts`, `focus-window.ts` | részben |

**A 3.6 apróságai:**
- a `syncTray` időzítő túléli a tálcát kilépéskor;
- a `render-process-gone` korlát nélkül tölt újra;
- a `WebSocketServer`-nek nincs `error` figyelője;
- a `code -r` timeout nélkül fut;
- az overlay pozíciója nincs a munkaterülethez szorítva, alacsony kijelzőn a teteje kilóg.

**A 3.2 mérése, kb. egy perc:**
1. Nyiss egy eldobható VS Code ablakot egy üres A mappára, és legyen ez a legutóbb aktív.
2. Terminálból futtasd: `code -r <üres B mappa>`.
3. Ha az ablak most B-t mutatja, a hiba igazolt.

**Javítás:**
- Bezáráskor `preventDefault` + `hide`, amíg nem lépünk ki. A `showOverlay` hozza újra létre, ha az ablak megsemmisült.
- A `-r` elhagyása: egy már nyitott mappát a VS Code így is előhoz, egy nem nyitottat pedig új ablakban nyit meg.
- `entrypoint !== 'claude-vscode'` esetén ne fusson CLI-fókusz.
- `IsIconic` + `ShowWindowAsync`.
- A `registerHotkey` adjon vissza `invalid` értéket, és ilyenkor az alapértelmezett billentyű éljen.
- A lock dobandó, ha a pid processze a lock utolsó írása után indult.
- Méret: S, a 3.5 S/M.

### 4. hullám: lezáratlan sorok, fantom várakozás

| # | Súly | Mi a hiba | Hol | Ellenőrizve |
|---|---|---|---|---|
| 4.1 | P1 | **Hiányzik a `PostToolUseFailure` hook.** Ha egy natívan jóváhagyott parancs hibával zárul (pl. kilépési kód 1), `PostToolUse` helyett `PostToolUseFailure` jön, amit nem telepítünk. A sor 590 mp-ig döntésre vár, utána „elengedett” marad a következő Stopig, a session pedig közben végig várakozónak látszik. | `main/setup.ts` `HOOK_ROUTES` | igen, a kódban és a hook-dokumentációban (code.claude.com/docs/en/hooks, 2026-10-25) |
| 4.2 | P2 | **Hiányzik a `StopFailure` hook.** API-hibával végződő turnnél (rate limit, overloaded) a Stop helyett `StopFailure` jön, így nincs „kész” jel, és a várakozás sem törlődik. | `main/setup.ts` `HOOK_ROUTES` | igen, a dokumentációban |
| 4.3 | P1 (VALÓSZÍNŰ) | **Natív Nem vagy Esc a VS Code-ban.** Valószínűleg a következő turn végéig, akár órákig, várakozónak látszik a session. A dokumentáció szerint egy elutasított engedélyre nem jön sem `PostToolUse`, sem `PostToolUseFailure`. A specben szereplő „a natív tiltást a Stop jelzi” állítást csak app-oldali tiltásra mértük, natívra sosem. | `decision-broker.ts` `sessionStopped`, `session-store.ts` `#waiting` | nem, mérés kell |
| 4.4 | P3 | **Párosítás `agent_id` nélkül.** A `#recentPre` bejegyzése `PostToolUse`-nál nem törlődik. Ha a fő agent és egy subagent ugyanazt a parancsot futtatja, vagy egy automatikusan engedélyezett hívás 60 mp-en belül ismétlődik, rossz sor záródik. Ez biztonságos irányba hibázik: üres 200 megy, a natív prompt marad. | `decision-broker.ts` `callKey`, `#takeRecentPre` | nem |

**A 4.3 mérése a cs-spike-on:**
1. Futtasd `CLAUDESWITCHER_HOOK_LOG`-gal.
2. Tarts egy kérést az appban, és nyomj Nem-et a VS Code-ban.
3. Nézd meg, jön-e Stop, és lezárul-e a permission-request kapcsolat.
4. Ugyanez Esc-kel.

**Javítás:**
- A `PostToolUseFailure` a `post-tool-use`, a `StopFailure` a `lifecycle/stop` útra kerüljön. Új kezelő nem kell, de a meglévő telepítéseket újra kell telepíteni.
- Ezért indításkor kell egy ellenőrzés, amely összeveti a telepített hookokat a `HOOK_ROUTES`-szal, és szól, ha elavult.
- A 4.3-ra a mérés után: a transcriptbe írt `tool_result` (`tool_use_id`, `is_error`) zárja a sort. Ez egyetlen mechanizmussal fedi a tiltást, az Esc-et, a hibát és a sikert. Tartalék a registry `status` mezője, ha az a várakozás kezdeténél frissebb.
- A 4.4-re: `agentId` a `callKey`-be, és a `#recentPre` takarítása Post-nál.
- Méret: a 4.1 és a 4.2 S, a 4.3 M.

### 5. hullám: az Electron keményítése

| # | Súly | Mi a hiba | Hol |
|---|---|---|---|
| 5.1 | P2 | **Nincs navigációs, `window.open`- és engedélytiltás, és az IPC nem nézi a küldőt.** Ha egy jövőbeli hiba, vagy egy az ablakra húzott fájl vagy URL idegen oldalt tölt az overlaybe, az ugyanazt a preloadot kapja. Így megkapja a tokent és minden függő kérést, és egy gépszintű `Bash` engedélyt íratna a Claude Code-dal. | `main/index.ts` `createOverlay`, az `ipcMain.handle` hívások |
| 5.2 | P2 | **Egy render-hiba az egész overlayt lefagyasztja újraindításig.** Az ErrorBoundary nem áll vissza, és a `render-process-gone` erre nem fut le. | `renderer/ErrorBoundary.tsx`, `main.tsx` |
| 5.3 | P3 | **A CSP szűkítése (az M1-ből halasztva).** Hiányzik az `object-src 'none'`, a `base-uri 'none'` és a `form-action 'none'`, és a `ws://127.0.0.1:*` helyett pontos port kell. | `renderer/index.html` |
| 5.4 | P3 | **Token-higiénia.** `timingSafeEqual`, és a ws-hitelesítés a handshake előtt (`verifyClient`). | `daemon/hook-server.ts`, `daemon/hub.ts` |
| 5.5 | P3 | **`-`-vel kezdődő mappa a `code -r`-nek.** A mappa opcióként értelmeződik. Ehhez írási jog kell a `~/.claude`-hoz, ami már teljes kontroll. | `focus-window.ts` `isSafeForCli` |

**Javítás:**
- `will-navigate` → `preventDefault`.
- `setWindowOpenHandler` → `deny`.
- Mindent tiltó `setPermissionRequestHandler`.
- Minden handlerben egy `assertOverlaySender(event)`.
- Panelenként külön ErrorBoundary, és a felső boundary álljon vissza a következő állapotüzenetre.
- **Miért ez a CSP előtt:** a CSP nem állítja meg a felső szintű navigációt.
- Méret: S.

### 6. hullám: alapozás, hogy biztonságosan bővíthető legyen

| # | Súly | Mi a hiba | Javítás |
|---|---|---|---|
| 6.1 | P1 | **Semmi nem kényszeríti ki a szigorúságot.** Nincs CI, nincs pre-commit hook, és nincs dead-code ellenőrzés. Csak azon múlik, hogy a vezető minden feladat után lefuttatja-e a négy parancsot. | Gyökér `pnpm verify` (check-types, lint, test, build). Pre-commit hook, de a `.husky`-hoz Alex OK-ja kell. CI csak akkor, ha a repó GitHubra kerül: ma nincs remote. `knip` a lintben. ESLint-tiltás az `execFileSync`/`execSync`/`spawnSync`-re a nem teszt kódban: ma egyetlen teszt sem fogná meg, ha a fagyás visszajönne. |
| 6.2 | P2 | **Egyetlen tsconfig a main, a preload és a renderer számára,** DOM és Node típusokkal együtt. A rendererben a `process`, a mainben a `window` is átmegy a típusellenőrzésen. | `tsconfig.node.json` és `tsconfig.web.json`, az electron-vite szokása szerint. A `vitest.config.ts` fájlok lintje és típusellenőrzése. |
| 6.3 | P2 | **Tesztek: hiányok és higiénia.** | Lásd lent. |
| 6.4 | P2 | **Dokumentáció és elavult spec.** | Lásd lent. |
| 6.5 | P2 | **Egy tény egy helyen.** | Lásd lent. |

**6.3, tesztek:**
- A renderer billentyűkezelésének nincs egyetlen tesztje sem (nincs jsdom vagy happy-dom), pedig az 1. hullám hibái mind itt vannak.
- Az IPC handlerek a `whenReady`-n belüli closure-ök, ezért tesztelhetetlenek.
- Nincs daemon→renderer szerződésteszt.
- Kb. 4100 ottmaradt temp könyvtár a `%TEMP%`-ben, mert a 8 `mkdtemp`-es tesztfájl egyike sem takarít.
- Fix 50 ms-os várakozás a sentinel helyett 3 tesztben.
- Javítás:
  - először a tiszta függvények kiemelése (`keyAction`, `registerIpcHandlers`, `createDaemonConnection`);
  - temp-könyvtár segéd `onTestFinished` takarítással;
  - a sentinel tickre várás.

**6.4, dokumentáció:**
- Nincs README és projekt CLAUDE.md.
- Az M1 kb. 17 halasztott tétele a gitignorált `progress.md`-ben él, a repón kívül.
- A spec 10 ponton eltér a kódtól:
  - a fejléc elavult;
  - a „core IO-mentes” állítás nem igaz;
  - nem létező fájlfigyelőt ír le;
  - a §4 billentyűi rosszak;
  - a §8 „ismeretlen státuszt” ír, de a rekord valójában eldobódik;
  - a §9 ellentmond a §7-nek;
  - a §3.8 companion extension nincs áthúzva;
  - a §11 „következő” pontja már kész.
- A `chokidar` függőség, de sehol nincs importálva.
- Javítás: README, CLAUDE.md, egy spec-javító kör, a halasztott tételek átköltöztetése a `docs/`-ba, és a `pnpm remove chokidar`.

**6.5, egy tény egy helyen:**
- A hook-útvonalak három listában élnek két csomagban.
- A 600 s és a 590 s közötti kapcsolatot csak kommentek tartják, a UI szövege beégetett „590 mp”.
- Az `isRecord` 13 példányban él, és az egyik (`state-message.ts` `isObject`) már eltér: tömböt is elfogad.
- Az eszköznév-listák többször szerepelnek.
- A `DaemonState` és a `window.claudeswitcher` kétszer van deklarálva, és a kettő már eltér.
- A „régebbi daemon” kompatibilitás fikció, mert egy csomagban szállnak.
- Javítás:
  - egy `hook-contract.ts` és egy `timings.ts` a core-ban, a 590 a 600-ból számolva;
  - egy `guards.ts`;
  - a `DaemonState` típus importja;
  - a preload API típusa egy helyről;
  - `protocol: 1` az állapotüzenetben.
- Méret: S/M, gépies munka.

### 7. hullám: az Electron frissítése

| # | Súly | Mi a hiba | Javítás |
|---|---|---|---|
| 7.1 | P1 | **Az Electron 33.4.11 kb. 18 hónapja nem kap biztonsági javítást.** A támogatás a 36-os kiadással ért véget, és a main Node 20-a is lejárt. A felület kicsi (helyi fájlok, loopback, sandbox), ezért ez inkább karbantartási kockázat, de minden hónappal nagyobb lesz az ugrás: két Vite-főverzió van egyszerre a fában (5 és 7), és az electron-vite 2 → 4. | Önálló, mért feladat: Electron a jelenleg támogatott főverzióra, electron-vite 4 / Vite 7, az ESM-main kérdés újramérése, a koffi élő tesztjei. Utána élő átvételi teszt Alex gépén. Méret: M. |

---

## 2. Alex döntése kell

1. **Rate limit és statusline.** A vezető korábbi állítása, hogy a rate limit ki lett véve, téves volt.
   - Mi van ma:
     - a kód 11 fájlban bent van;
     - a Telepítés a globális settings.json-ba beírja a statusLine-t, és az a repó `packages/statusline/dist`-jére mutat abszolút úttal;
     - a telepítő ablak azt írja, hogy a limitek a build után megjelennek, de a VS Code-ban sosem jelennek meg.
   - A spec §3.5 szándékosan „alvó” funkcióként tartja meg.
   - Javaslat: ha terminálban nem futtatsz Claude Code-ot, töröljük. A statusLine telepítése is menjen ki, de a régi bejegyzés eltávolítása maradjon meg, ahogy a SessionStart-nál.
   - Ha terminálban is használod, legyen kapcsolható a tálcamenüből, és a szkript ne a repóból fusson.
   - **Miért nem marad alvó:** a globális Claude Code konfigurációba ír egy olyan funkcióért, amely a fő platformon nem működik.
2. **`Co-Authored-By` a commitokban.**
   - 92 commit tartalmazza, 2026-09-04 és 2026-10-21 között, a szabály ellenére.
   - Az utolsó négy commit már tiszta.
   - Nincs remote, tehát a történet még helyben átírható: előbb egy mentő ág, utána `git filter-branch --msg-filter`. Minden hash megváltozik.
   - Javaslat: most írjuk át, mert push után már nem lehet.
3. **Csomagolás.** Az electron-builder, az autostart, a fix userData név és a koffi `asarUnpack` még az új funkciók előtt eldöntendő. A token, a config helye és a statusLine útvonala ettől függ, márpedig ezek már be vannak írva a gépeden. Ma az app csak a repóból indul (`pnpm --filter @claudeswitcher/desktop start`).
4. **`feat/m1-monitor`.** Be van olvasztva, törölhető.

---

## 3. Meghagyni

Ezek jó döntések. Egy átalakítás se rontsa el őket.

- **A döntés a saját HTTP-kapcsolatához van kötve, véletlen azonosítóval.**
  - A párosítás csak azt dönti el, mikor zárul le egy sor, azt soha, hogy ki kap választ. Így minden párosítási hiba „nincs döntés” lesz, nem hamis allow.
  - A permission-request út minden hibája üres 200, mérten.
  - Az A átnéző nem talált olyan utat, ahol hiba, timeout, megszakítás, leállás vagy hibás payload allow-t adna.
- **A `buildHookResponse` az egyetlen tiltási pont.** A kérdéshez válasz kell, a tervet nem lehet jóváhagyni, szabály csak `tool`-hoz kerülhet. A szabályokat a Claude Code írja az `updatedPermissions`-ből, az app soha. Egy hamis kérés így nem tud szabályt íratni.
- **Egyszeri válasz.** A `respond` retesze és a `#finish` egyetlen törlése garantálja, hogy egy kérésre pontosan egy válasz menjen. A `releaseAll` + `#closed` + `stopWithin` miatt a kilépés se nem akad meg, se nem tilt.
- **Hitelesítés és hálózat.** Bearer token minden úton, még a body olvasása előtt; kizárólag a `127.0.0.1`; 128 bites véletlen token; a böngészős CSRF és a DNS-rebinding ellen véd.
- **Electron.** `contextIsolation`, `sandbox: true`, `nodeIntegration: false`. A preload csak névvel ellátott függvényeket ad ki, és a `parseUserDecision` szigorúan szűri az IPC-t.
- **settings-writer.**
  - A hibás JSON-t nem írja felül.
  - Temp fájl + rename, fájlonkénti sor.
  - Hook-szintű tulajdonjog (`isOurHook`).
  - A régi SessionStart is eltávolítható.
- **Natív probe.**
  - Szinkron válasz, aszinkron frissítés, egyszerre csak egy frissítés, TTL, hiba esetén az előző pillanatkép marad.
  - Lusta, elkapott koffi-betöltés.
  - Struktúraméret-ellenőrzés, ciklus-korlátok, `CloseHandle` a `finally`-ben.
  - Mérve: a szkennelés 30 sessionnel nem blokkol 15 ms-nál tovább.
- **A `procStart` összevetése** a pid-újrahasznosítás ellen.
- **Tiszta őrfüggvények.**
  - `tabFocusUri`, minden feltétel felsorolva;
  - a kijelölés session-azonosító szerint, nem index szerint;
  - a `DecisionPanel` `key={decision.id}`, így egy panel csak a saját kérését döntheti el;
  - a `findMainWindow` több ablaknál nem találgat.
- **Állapot a rendererben.** A `sanitizeState` elemenként szűr, mindkét csatornán (ws és IPC). A `tick` szívverés különválasztja a „nincs változás” és a „leállt” állapotot. A generációszámláló véd az elavult IPC-állapot ellen.
- **Nincs gyorsbillentyű kérdésre és tervre,** és a `ctrlKey`/`altKey` szűrés miatt az AltGr nem süt el semmit.
- **Mért, anonimizált fixture-ök** (`hook-payloads.json`, `spikes/m2-permission/RESULTS.md`). Ez a fő védelem a nem dokumentált belsők ellen.
- **Az eszközlánc:** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strictTypeChecked`, `switch-exhaustiveness-check`, a renderer importhatár-szabálya, és a tesztek is típusellenőrzöttek.
- **A Windows-only integrációs tesztek láthatóan skipelnek, soha nem mennek át csendben.**

---

## 4. Fejleszteni

Rangsorolva. Ezek nem hibák.

1. **Diagnosztika.**
   - Mi a gond ma: ha a Claude Code átnevez egy mezőt, az app csendben rossz képet mutat (minden session tétlen, nincs subagent). Ugyanez, ha a token nem egyezik: a hookok 401-et kapnak.
   - A javaslat elemei:
     - egy állapotsor a tálcán: az integráció telepítve van és a token egyezik, az utolsó hook kora, az utolsó szkennelés kora, a probe módja;
     - naplófájl a userData-ban méretkorláttal, és „Napló megnyitása” menüpont;
     - `unhandledRejection`/`uncaughtException` kezelő;
     - számlálók: eldobott registry-rekordok, ismeretlen notification-típus, egy Claude Code verzió első észlelése, és „a döntést a Claude Code nem nyugtázta” (nem jött `PostToolUse`/`Stop` 10 mp-en belül);
     - a sorok lezárási okainak számlálója.
2. **Komponens-tesztek** (happy-dom + @testing-library/react) 5-10 kulcsfolyamatra: a mező eltűnése, Enter gombon, a mód visszaállása újraépüléskor. Hozzá a daemon→renderer szerződésteszt.
3. **A kérés eredete a panelen.** Entrypoint, permission_mode, teljes cwd, agent, és egy „ismeretlen session” jelzés. A hookok globálisak, ezért az SDK-s és a headless futások kérései is ide jönnek, és ma nem lehet őket megkülönböztetni.
4. **Állapot IPC-n a ws helyett.** A renderer így nem kapja meg a tokent, a CSP-ből kieshet a `ws:`, és egy tokenbirtokosnak nem marad hálózati olvasási csatornája.
5. **A daemon Electron `utilityProcess`-ben.** Így az ablak-FFI és a UI-munka sosem akaszthatja meg az összes session hookjait.
6. **Útvonal-gyorsítótár a `findTranscriptPath`-hoz.** Ma minden poll minden sessionre végigpróbálja az összes projektkönyvtárat. Mért adat: 21 projektnél 51 ms/szkennelés, 200-nál 143 ms, és ez a szám csak nő.
7. **Alvás/ébredés mérési protokoll** (soha nem mértük), és egy `powerMonitor.on('resume')` újraszkennelés.
8. **Tálcaikon @1.5x/@2x-ben.** Ma 16×16-os, és 125-150%-on elmosódik.

---

## Javasolt sorrend

1. Az **1. hullám** (billentyűzet) az első. Ez a leggyakoribb kockázat, a felhasználó naponta százszor nyom betűt, és a javítás S méretű.
2. A **2. hullám** (settings.json) a második. Ritka, de katasztrofális, és S méretű.
3. A **3. hullám** előtt Alex lefuttatja a 3.2 egyperces mérését. A **4. hullám** előtt a 4.3 mérését a cs-spike-on.
4. Az **5. és a 6. hullám** kis, gépies feladatokból áll, és sorban mehetnek.
5. A **7. hullám** (az Electron frissítése) a 6.1 után jöjjön, hogy a `pnpm verify` már védje.

Minden tétel a szokásos módon megy: egy implementáló agent, a vezető ellenőrzése, `git add`, Alex átnézése, commit.

Az átnézők teljes jelentései helyben, a gitignorált `.superpowers/sdd/2026-10-25-repo-review/` alatt vannak.
