# Feature backlog és ütemezés

Alex kérései 2026-10-28-án, a döntéseivel együtt. A hibajavító kör (6–8. hullám) a `docs/reviews/2026-10-25-repo-review.md` szerint fut, ez a fájl az utána jövő munkáé.

## Hol tartunk (2026-10-29)

A teljes repó-átnézés (`docs/reviews/2026-10-25-repo-review.md`) javítási köréből ezek készültek el. Mind a `main`-en vannak, Alex élő tesztjével együtt.

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

**Következő lépés: 6/5, dokumentáció.** Ez még nem kezdődött el. A brief a gitignorált `.superpowers/sdd/2026-10-25-repo-review/w6e-docs-brief.md` fájlban van, ha átjön a másik gépre. A tartalma röviden:
- README és projekt CLAUDE.md;
- a spec elavult pontjainak javítása;
- az M1 halasztott tételeinek áthozása ide;
- „Eredmény” rész a review dokumentumba;
- a régi, halott IDE token kivétele a `docs/superpowers/plans/2026-09-04-claudeswitcher-m1-monitor.md`-ből;
- a tesztekben maradt valódi helyi adatok (session-azonosítók, mappanevek, egy helyi felhasználónév) cseréje kitalált értékekre.

**Utána:** 7. Electron-frissítés, majd a lenti ütemezés.

**A munkamódszer:**
- Egy implementáló agent dolgozik egyszerre, és `git add`-ig megy.
- A vezető ellenőrzi a `pnpm verify`-vel, Alex élőben teszteli a pontos teszt-protokoll alapján.
- OK után jön a commit, független változásonként külön commit. Közös fájloknál az agent `apply_step.sh` lépésenkénti változatokat készít.
- Végül fast-forward merge a `main`-be.

**Gépváltás után:** a `pnpm install` újratelepíti a pre-commit hookot.

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
3. **Elengedettre ne ugorjon vissza.** Ez hiba: a `selection.ts` `firstWaiting` az elengedett (590 mp utáni) kérést is várakozónak veszi. Elengedettre csak akkor ugorjon, ha más nem vár.
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
9. **„vagy telefonon” csak Remote Control mellett.** Ez hiba: a `session-marker.ts` és a `DecisionPanel.tsx` mindig kiírja.
10. **Villogó tálcaikon 9 perc után.** Pirosan villog, ha bármely kérés 540 mp-nél régebben vár. Az app 590 mp-nél engedi el a kérést.
11. **Hosszú parancsnál az indoklás görgetés nélkül.** A leírás a parancs fölé kerül.
12. **Fókusz vissza bezáráskor.** Megnyitáskor az app megjegyzi az előtérben lévő ablakot, Esc-re oda adja vissza. Enter (ugrás) után nem.

**+1. Mobil felület** (PWA vagy APK, WireGuardon át). Csak megjegyzés, a teljes app után kerül sorra.
- Ehhez a daemont ki kellene nyitni a hálózatra, ami hitelesítést, TLS-t és interfész-korlátozást igényel.
- Előtte tisztázni kell, mi hiányzik a Claude saját Remote Control-jából.
