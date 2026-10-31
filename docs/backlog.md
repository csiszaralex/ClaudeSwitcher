# Feature backlog és ütemezés

Alex kérései 2026-10-28-án, a döntéseivel együtt. A hibajavító kör (6–8. hullám) a `docs/reviews/2026-10-25-repo-review.md` szerint fut, ez a fájl az utána jövő munkáé.

## Hol tartunk (2026-10-30)

A teljes repó-átnézés (`docs/reviews/2026-10-25-repo-review.md`) javítási köréből ezek készültek el. Az 1. hullámtól a 6/4-ig mind a `main`-en vannak, Alex élő tesztjével együtt. A részletes eredmény hullámonként: a review „Eredmény” része.

| Hullám | Tartalom | Commitok |
|---|---|---|
| 1 | billentyűzet-védelem, a panel mutatja, mit hagysz jóvá, „N vár”, subagent neve | `63f59f9`–`272d5ab` |
| 2 | settings.json, token, config biztonságos írása, saját hook felismerése porttal | `46b1f68`–`8326bd7` |
| 3 | ablakkezelés (Alt+F4, `code` CLI `-r` nélkül, aszinkron restore, hibás gyorsbillentyű, elavult lockok) | `c8d7d04`–`de28c98` |
| 4 | PostToolUseFailure, StopFailure, elavult telepítés jelzése, párosítás agentenként | `511751f`–`ca05562` |
| 5 | Electron-keményítés, hibatűrés, CSP, időzítés-biztos token, natív válasz utáni várakozás törlése | `7a256b9`–`9f3fa37` |
| 6/1 | rate limit, statusline és chokidar eltávolítása | `ca9f528`–`01e75f0` |
| 6/2 | egy tény egy helyen (hook-szerződés, időzítések, guardok, eszköznevek, közös típusok, protokollverzió) | `c68cdaf`–`5c288f0` |
| 6/3 | `pnpm verify` + pre-commit hook, szinkron spawn tiltás, knip, tsconfig-szétválasztás, dev mód javítása | `505ee3d`–`89f7768` |
| 6/4 | tesztek takarítása, determinisztikus várások, gyors leállítás, kitalált token a fixture-ben | `4d85c0c`–`0116458` |
| gép | új gépen: a renderer build `subst` meghajtón, 30 s a PowerShell probe-tartaléknak, bő időkorlát az élő Windows-teszteknek | `b42f2c7`, `6ea2ee8`, `6537a05` |
| 6/5 | dokumentáció: README, projekt CLAUDE.md, a spec igazítása a kódhoz, az M1 halasztott tételei ide, „Eredmény” a review-ba, a halott IDE token és a tesztekben maradt valódi helyi adatok cseréje | a `docs/refresh` ág |

**A 6/5 kész.** Ezzel a review 6. hulláma lezárult.

**Következő lépés:** 7. Electron-frissítés, majd a lenti ütemezés.

A munkamódszer a `CLAUDE.md`-ben, a telepítés (a pre-commit hookkal együtt) a `README.md`-ben van.

## Ütemezés

1. 6/3–6/5: eszközök, tesztek, dokumentáció (a review 6. hulláma).
2. 7: Electron-frissítés.
3. **F1**, gyors UX-kör, csak renderer: 3, 9, 11, 7, 6, 2.
4. 8: telepítő és automatikus indulás (login item, nem Windows-szolgáltatás).
5. **F2**, main és tálca: 5, 10, 12, 8.
6. **F3**: 1, automatikus mód.
7. **F4**: 4, saját szabálymotor és AI-magyarázat, külön tervezéssel.
8. Később, csak a teljes app után: +1, mobil felület.

## A kérések

1. **Automatikus elfogadás mód.**
   - Sessionönként működik.
   - Csak elfogadás van, automatikus elutasítás nincs.
   - Csak azt a kérést fogadja el, amire a panel sima „Engedélyez” gombja is engedélyezne. Kérdést, tervet és olvashatatlan kérést soha.
   - Be- és kikapcsolás: a **Shift+A** legalább 3 mp-ig nyomva tartva.
   - A bekapcsolt sessiont a háttere jelzi: zöld.
2. **Új jóváhagyandóra ugrás.** A kijelölés rá ugrik, de csak akkor, ha a kijelölt sornál épp nincs döntés. Gépelés vagy olvasás közben nem rántja el.
3. **Hiba: elengedettre ne ugorjon vissza.** A `selection.ts` `firstWaiting` az elengedett (590 mp utáni) kérést is várakozónak veszi. Elengedettre csak akkor ugorjon, ha más nem vár.
4. **Saját szabálymotor és AI.** Két részből áll:
   - (a) Algoritmikus jóváhagyás a Claude Code szabályainál kifejezőbb szabályokkal. Példa: törölhet, de csak a saját projektmappáján belül. Ez a `Bash(rm ./*)` szerű prefix-egyezésnél szigorúbb, útvonal-alapú ellenőrzés.
   - (b) Az AI elmagyarázza a parancsot, és kockázat szerint jelöli. Ezt kérésre kéri le az app, nem minden kérésnél.
   - Költség: Alexnek havi 100 USD AI kreditje van, ez gyakorlatilag fedezi.
   - A kulcs kezelése titokkezelés, külön tervezést igényel.
5. **Kész állapot a tálcaikonon.** A tálcaikon zöld, ha valami kész. Ha közben más vár: kívül zöld, belül narancs. Ha a sessiont az appból Enterrel megnyitja, a „kész” jelzés lekerül róla (nyugtázás).
6. **Szabályjavaslat jelzése.** Látszódjon, ha a Claude Code szabályt javasol, pl. a P/G gombon.
7. **Ctrl+Enter jelölése.** Ahol az Enter sort tör, legyen kiírva, hogy a Ctrl+Enter a jóváhagyás.
8. **Teljes billentyűzetes használat.**
   - A Space beviszi a fókuszt a panelbe.
   - A nyilak lépkednek.
   - A Space vagy az Enter kijelöl.
   - A Ctrl+Enter küld.
   - Főleg a kérdésekhez kell, ott ma nincs betűjel.
9. **Hiba: „vagy telefonon” csak Remote Control mellett.** A `session-marker.ts` és a `DecisionPanel.tsx` mindig kiírja.
10. **Villogó tálcaikon 9 perc után.** Pirosan villog, ha bármely kérés 540 mp-nél régebben vár. Az app 590 mp-nél engedi el a kérést.
11. **Hosszú parancsnál az indoklás görgetés nélkül.** A leírás a parancs fölé kerül.
12. **Fókusz vissza bezáráskor.** Megnyitáskor az app megjegyzi az előtérben lévő ablakot, Esc-re oda adja vissza. Enter (ugrás) után nem.

**+1. Mobil felület** (PWA vagy APK, WireGuardon át). Csak megjegyzés, a teljes app után kerül sorra.
- Ehhez a daemont ki kellene nyitni a hálózatra, ami hitelesítést, TLS-t és interfész-korlátozást igényel.
- Előtte tisztázni kell, mi hiányzik a Claude saját Remote Control-jából.

## Halasztott tételek

Az M1 implementálásakor és átnézésekor „minor (deferred)” jelzéssel félretett tételek, amelyek 2026-10-30-án a kód szerint még nyitottak. Korábban csak a gitignorált `.superpowers/sdd/2026-09-04-claudeswitcher-m1-monitor/progress.md` naplóban éltek. Ami azóta javult (például az állandó idejű tokenösszevetés, a CSP-szűkítés, az aszinkron probe, a `before-quit` sorrend), vagy a rate limittel együtt kikerült, az nincs itt. Mind kicsi, és egyik sem hiba, amibe ma bele lehet futni, hacsak a sor külön nem mondja.

**Core**
- `transcript.ts` `tailLines`: nem nézi a `handle.read` `bytesRead` értékét, egyetlen teljes olvasást feltételez. Helyi lemezen ez igaz, hálózati megosztáson nem garantált: egy rövid olvasás NUL bájtokkal zárná az utolsó sort.
- `types.ts` `SessionActivity.runningTool` egyetlen szöveg: egy üzenet több párhuzamos `tool_use` blokkjából csak az utolsó látszik.
- `liveness.ts` `bestWindow`: két azonos hosszú illeszkedő munkaterület-mappánál az első lock nyer (szigorú `>`). Determinisztikus, de nincs dokumentálva és tesztelve.
- `liveness.ts` `normalize`: a puszta meghajtógyökérről (`C:\`) leveszi az elválasztót (`c:`). Az `isWithin` így is helyesen dönt, de az alak meglepő.
- `settings-writer.ts` `writeQueues`: a kulcs a `path.resolve`, kis- és nagybetű-normalizálás nélkül. Ugyanannak a Windows-útnak két eltérő írásmódja két külön sort kapna. Ma minden hívó ugyanúgy képzi az utat.
- `settings-writer.ts` `writeFileAtomic`: a `rename` nem próbálkozik újra, ha egy víruskereső vagy szerkesztő épp fogja a `settings.json`-t (EBUSY, EPERM). A telepítés ilyenkor hibával áll meg, a fájl érintetlen.

**Daemon**
- `scanner.ts` `readLocks`: a `Number.parseInt` a lock nevének végén lévő szemetet elfogadja (`50269abc.lock` → 50269).
- `hub.ts`: a WebSocket a tokent az URL query-ben kapja (`?token=`), mert a böngésző WebSocket API-ja nem tud fejlécet küldeni. A loopback korlátozza a kitettséget; egy sikertelen kézfogás URL-jét a Chromium a renderer konzoljára írja. Ezt a review 4. részének 4. pontja (állapot IPC-n) szüntetné meg.
- Teszthiányok: nincs teszt arra, hogy a hitelesítés egy route nélküli úton is előbb fut (`hook-server.test.ts`); arra, hogy egy dobó `onChange` figyelő után a többi is lefut (`session-store.ts`); a `scanner.test.ts` `aliveProbe` `'Code'` image neve hatástalan, mert a fixture lockjában nincs `ideName`; és a `100.abc123` testvérfájlos eset a `.json` szűrő nélkül is átmenne.

**Desktop**
- ~~`electron.vite.config.ts` `BUNDLED_WORKSPACE_PACKAGES`: kézzel vezetett lista; a CJS főprocessz újramérése az Electron 45-ön.~~ Kész (7/2. hullám): a főprocessz ES modul, a lista a desktop `package.json` `workspace:` függőségeiből jön (`workspaceDependencies`), és ha üres, a build megáll. A bundle csomagolási okból maradt, a mérés és az indoklás a config kommentjében.
- `focus-window.ts`: a user32 deklarációkon nincs `__stdcall`. A koffi x64-en figyelmen kívül hagyja, csak 32 biten számítana.
- `index.ts` `syncTray`: a tálca másodpercenként lekérdezi az állapotot (`setInterval(syncTray, 1000)`), ahelyett hogy feliratkozna a változásra.
- `tray.ts`: az ikonok útja `../../resources`. Dev és preview módban jó, egy csomagolt appban nem (a telepítő a fenti ütemezésben a 8-as tétel).
- `setup.ts` `removeIntegration`: egy már meglévő, de üres `hooks: {}` vagy `env: {}` eltávolításkor törlődik, így az oda-vissza út erre az alakra nem bájtazonos. Szándékos: a tiszta függvény nem tudja, hogy a tároló korábban is létezett, és a fordított döntés minden hook nélküli felhasználónál `hooks: {}`-t hagyna maga után.
- `setup.ts` `applyIntegration`: a megtartott idegen bejegyzéseket referenciaként osztja meg a bemenettel. Ma semmi nem dolgozza utólag fel az eredményt; ha valami egyszer fogja, a hívó objektumát mutálná.
- `setup.ts` `isOurStatusLine`: egy saját status line-wrapper, amelynek a parancsa tartalmazza a `--claudeswitcher` jelölőt, a mienknek számít, és a telepítés vagy az eltávolítás kiveszi.

**Eszközlánc**
- ~~`pnpm-workspace.yaml` `allowBuilds`: az `electron`, `esbuild`, `koffi` és `nx` engedélyének nincs indoklása.~~ Kész (7/3. hullám): minden kulcs mellett ott az ok, a `pnpm-workspace.yaml`-ban.
- ~~`@types/node` a gyökér mellett a `packages/core` és az `apps/desktop` `package.json`-jában is szerepel.~~ Kész (7/3. hullám): csak a gyökérben van. A csomagok a `node_modules` feloldással a gyökérét kapják, ahogy a daemon eddig is.
- TypeScript 7 (a `latest` 7.0.2): a `typescript-eslint` 8.72.1 peerje `typescript >=4.8.4 <6.1.0` (`pnpm view typescript-eslint@8.72.1 peerDependencies`), ezért a 6.0.3-on állunk. Ha a `typescript-eslint` stabil kiadása támogatja a 7-et, akkor frissíthető.
- ~~knip 6.44.0: a pnpm 12 `minimumReleaseAge` (1440 perc) miatt csak a kiadás után egy nappal telepíthető kivétel nélkül.~~ Kész (2026-10-31): `^6.44.0`, `minimumReleaseAgeExclude` nélkül. A pnpm a még egy napnál fiatalabb verziókat (ma a 6.44.1-et) magától kihagyja.
- Node 26 (a legújabb LTS, 26.13.0, „Lithium”, 2026-10-28; `https://nodejs.org/dist/index.json`): a gépen 24.22.1 fut, ezért az `engines` `>=24`. Alex lépése: a Node 26 LTS telepítése, utána az `engines` emelése és egy `pnpm verify`. A `@types/node` az Electron Node-ján (24) marad, mert az app azon fut.

Az M1 elfogadási tesztjéből egy pont maradt el, az alvás/ébredés mérése. Ez a review 4. részének 7. pontjában van.
