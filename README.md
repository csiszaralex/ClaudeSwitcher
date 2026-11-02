# ClaudeSwitcher

Windowsos tálcaalkalmazás a párhuzamosan futó Claude Code sessionökhöz (főleg a VS Code bővítményben). Egy gyorsbillentyűre előjön egy lista: melyik session dolgozik, melyik vár, melyik tétlen. Egy gombbal a session VS Code ablakára és Claude-tabjára ugrik, és a függő engedélykéréseket az appból is el lehet dönteni: engedélyezés, tiltás indoklással, projekt- vagy gépszintű szabály, kérdés megválaszolása, terv elutasítása. A natív prompt közben a VS Code-ban is megmarad, az első döntés nyer.

A részletes terv és a mért Claude Code viselkedés: [`docs/superpowers/specs/2026-09-04-claudeswitcher-design.md`](docs/superpowers/specs/2026-09-04-claudeswitcher-design.md).

## Követelmények

- Windows 11 (az ablakfókusz Win32 hívásokat használ, a többi platform nem cél).
- Node.js 24 vagy újabb (`package.json` `engines`). Ugyanez a főverzió fut az Electron 45-ben is.
- pnpm a corepackon át: a pontos verziót a `package.json` `packageManager` mezője rögzíti. Egyszer: `corepack enable`.
- VS Code a Claude Code bővítménnyel.

## Telepítés és ellenőrzés

```sh
pnpm install
```

A `prepare` szkript a `simple-git-hooks`-szal két hookot telepít:
- **pre-commit:** `pnpm verify:commit`, gyors. A típusellenőrzés és a lint csak a változás által érintett csomagokra fut (`nx affected --uncommitted`), utána a `knip`.
- **pre-push:** a teljes `pnpm verify`. Amíg a repónak nincs remote-ja, ez nem fut le, ezért a teljes ellenőrzés a merge előtt kézzel kötelező (`CLAUDE.md`).

Az Electron binárisa nem jön le a `pnpm install`-lal: a 42-es főverzió óta az `electron` csomag telepítéskor nem tölti le (Electron breaking changes, 42.0), és az electron-vite 6.0.0 a hiányzó binárist nem tölti le magától, hanem „Electron uninstall” hibával megáll. Ezért a desktop `predev` és `prestart` szkriptje az indítás előtt lefuttatja az `install-electron`-t. Ha a bináris már a helyén van, nem tölt le semmit. A buildhez és a `pnpm verify`-hoz nem kell.

```sh
pnpm verify
```

Ez minden csomagra lefuttatja a típusellenőrzést, a lintet, a teszteket és a buildet (Nx), utána a gyökér config fájlok ellenőrzését és a `knip`-et. A Windows-only élő tesztek más platformon, illetve futó VS Code nélkül láthatóan kihagyódnak.

## Az app futtatása

```sh
pnpm --filter @claudeswitcher/desktop build
pnpm --filter @claudeswitcher/desktop start
```

A `start` az `electron-vite preview`, a lefordított appot indítja. Fejlesztéshez, a renderer élő újratöltésével:

```sh
pnpm --filter @claudeswitcher/desktop dev
```

Egyszerre egy ClaudeSwitcher fut, akár telepített, akár a repóból indított. Ha ugyanaz a build indul újra, az új példány csendben kilép. Ha egy másik build fut (például a telepített app, és a repóból indul a `start`), az új példány megkérdezi, bezárja-e a futót és induljon-e helyette. Igen válasznál a futó app a rendes kilépési útján áll le, a függő engedélykéréseket elengedi. A daemon a `127.0.0.1:47821` porton figyel (`apps/desktop/src/main/daemon-port.ts` `DAEMON_PORT`). Az alapértelmezett gyorsbillentyű a `Shift+Alt+Space`.

## A telepítő

A Windows telepítő elkészítése:

```sh
pnpm --filter @claudeswitcher/desktop dist
```

Az eredmény az `apps/desktop/release/ClaudeSwitcher Setup <verzió>.exe` (a verzió a desktop `package.json`-jából jön). A telepítő NSIS alapú, a beállítása az `apps/desktop/electron-builder.yml`, a saját oldala és lépései az `apps/desktop/resources/installer.nsh`.

**Telepítés:** felhasználónként, rendszergazdai jog nélkül, a `%LOCALAPPDATA%\Programs\ClaudeSwitcher` alá. A telepítő nincs aláírva, ezért a SmartScreen az első futtatáskor figyelmeztet: „További információ” (More info), aztán „Futtatás mindenképp” (Run anyway). A telepítő egy oldalon megkérdezi, legyen-e Start menü parancsikon (alapból igen) és asztali parancsikon (alapból nem). A választást megjegyzi (`HKCU\Software\ClaudeSwitcher\Installer`), és egy későbbi telepítés vagy frissítés ezzel kezdi. Csendes telepítésnél (`/S`) egy megjegyzett Start menü vagy asztali parancsikont, amelynek a fájlját közben kézzel törölted, a telepítő nem hozza létre újra, és kikapcsoltnak jegyzi meg; a párbeszédes oldal a megjegyzett választást változatlanul mutatja. Ha közben fut egy telepített ClaudeSwitcher, a telepítő a rendes kilépési útján bezárja (`--quit`), soha nem lövi le. Ha ez nem sikerül, megkéri, hogy zárd be a tálcáról. A végén elindíthatod az új verziót.

**Eltávolítás** (Gépház, Alkalmazások): leveszi a programfájlokat, a parancsikonokat és a megjegyzett választást, és az app maga (`--uninstall`) kikapcsolja az automatikus indítást és kiveszi a Claude Code integrációt a `settings.json`-ból. Ha az integrációt nem tudja kivenni, szól, és folytatja. A `userData` könyvtárat (config és token) megtartja, kivéve ha az eltávolítót kézzel a `--delete-app-data` kapcsolóval indítják. Egy frissítés (új telepítés a régi fölé) a régi verzió eltávolítóját futtatja, de az integrációhoz, az automatikus indításhoz és a parancsikonokhoz nem nyúl.

**Közös `userData`:** a telepített app és a repóból indított buildek ugyanazt a könyvtárat használják, `%APPDATA%\@claudeswitcher\desktop` (`apps/desktop/src/main/user-data.ts` `userDataDir`). Ezért a token és vele a már telepített Claude Code hookok, valamint a beállítások túlélik a telepítést, a frissítést és a buildek közti váltást.

## A Claude Code integráció

Az integrációt a beállítások ablakban lehet kezelni (tálcamenü, „Beállítások…”, „Claude Code integráció” rész). A **„Telepítés”** gomb a `~/.claude/settings.json`-ba ír (vagy a `CLAUDE_CONFIG_DIR` alá, ha be van állítva):
- egy HTTP hookot minden eseményre, amit az app figyel. A lista egy helyen él: `packages/core/src/hook-contract.ts` `HOOK_CONTRACT`. Mindegyik a `http://127.0.0.1:47821/hooks/...` címre megy, `Authorization: Bearer $CLAUDESWITCHER_TOKEN` fejléccel;
- az `env.CLAUDESWITCHER_TOKEN` értéket, a daemon tokenjét.

Az idegen hookokhoz és beállításokhoz nem nyúl. Az első olyan írás előtt, ami egy meglévő fájlt megváltoztat, egyszer biztonsági másolatot készít: `settings.json.claudeswitcher-backup` (egy meglévő másolatot soha nem ír felül). Ha a fájl nem olvasható vagy nem értelmezhető, nem ír semmit.

Az **„Eltávolítás”** gomb csak a saját bejegyzéseket veszi ki, egy korábbi verzió kivezetett bejegyzéseivel együtt (`SessionStart` hook, a régi statusLine, `env.CLAUDESWITCHER_PORT`).

Az ablak a gombokat az állapothoz igazítja: nincs telepítve, csak „Telepítés”; telepítve, csak „Eltávolítás”; elavult vagy nem olvasható `settings.json`, mindkettő. Ha a telepített hookok elavultak (egy újabb verzió új hookot vár), a tálcamenü ezt egy sorral jelzi („Integráció elavult, telepítsd újra”), és a sorra kattintva megnyílik a beállítások ablak. A tálcamenüben nincs külön telepítő vagy eltávolító pont.

## Hol mi van

- **Config és token:** az Electron `userData` könyvtárában (`app.getPath('userData')`): `config.json` (gyorsbillentyű, tálcapipák, a felhasználó által megerősített beállítások) és `daemon-token`. A tálcapipák azonnal hatnak, és a módosított beállítást megerősítettnek jegyzik. Az automatikus indítást a Windows bejelentkezési eleme tárolja, és csak a telepített app állíthatja.
- **`CLAUDESWITCHER_HOOK_LOG=<fájl>`:** ha be van állítva az app indításakor, a daemon minden beérkező hook nyers törzsét egy JSON-sorként hozzáfűzi ehhez a fájlhoz. Diagnosztika, alapból ki van kapcsolva.
- **`CS_PROBE_MEASURE=1`:** bekapcsolja a kézi processz-probe mérést (`apps/desktop/src/main/process-probe.measure.test.ts`), ami nélküle kihagyódik. Futtatás Git Bash-ből: `CS_PROBE_MEASURE=1 pnpm --filter @claudeswitcher/desktop test process-probe.measure`.

## Dokumentáció

- Terv és mért tények: [`docs/superpowers/specs/2026-09-04-claudeswitcher-design.md`](docs/superpowers/specs/2026-09-04-claudeswitcher-design.md)
- A teljes repó-átnézés és az eredménye: [`docs/reviews/2026-10-25-repo-review.md`](docs/reviews/2026-10-25-repo-review.md)
- Feature backlog, ütemezés és halasztott tételek: [`docs/backlog.md`](docs/backlog.md)
- Az M2 spike mérései: [`spikes/m2-permission/RESULTS.md`](spikes/m2-permission/RESULTS.md)
