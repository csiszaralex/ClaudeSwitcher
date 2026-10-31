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

Egyszerre egy példány fut. A daemon a `127.0.0.1:47821` porton figyel (`apps/desktop/src/main/daemon-port.ts` `DAEMON_PORT`). Az alapértelmezett gyorsbillentyű a `Shift+Alt+Space`.

## A Claude Code integráció

A tálcamenü **„Claude Code integráció telepítése”** pontja a `~/.claude/settings.json`-ba ír (vagy a `CLAUDE_CONFIG_DIR` alá, ha be van állítva):
- egy HTTP hookot minden eseményre, amit az app figyel. A lista egy helyen él: `packages/core/src/hook-contract.ts` `HOOK_CONTRACT`. Mindegyik a `http://127.0.0.1:47821/hooks/...` címre megy, `Authorization: Bearer $CLAUDESWITCHER_TOKEN` fejléccel;
- az `env.CLAUDESWITCHER_TOKEN` értéket, a daemon tokenjét.

Az idegen hookokhoz és beállításokhoz nem nyúl. Az első olyan írás előtt, ami egy meglévő fájlt megváltoztat, egyszer biztonsági másolatot készít: `settings.json.claudeswitcher-backup` (egy meglévő másolatot soha nem ír felül). Ha a fájl nem olvasható vagy nem értelmezhető, nem ír semmit.

A **„Claude Code integráció eltávolítása”** csak a saját bejegyzéseket veszi ki, egy korábbi verzió kivezetett bejegyzéseivel együtt (`SessionStart` hook, a régi statusLine, `env.CLAUDESWITCHER_PORT`).

Ha a telepített hookok elavultak (egy újabb verzió új hookot vár), a tálcamenü ezt jelzi: „Integráció elavult, telepítsd újra”.

## Hol mi van

- **Config és token:** az Electron `userData` könyvtárában (`app.getPath('userData')`): `config.json` (gyorsbillentyű, tálcapipák) és `daemon-token`. A tálcamenü „Gyorsbillentyű átállítása…” pontja megnyitja a `config.json`-t; az új billentyű újraindítás után él.
- **`CLAUDESWITCHER_HOOK_LOG=<fájl>`:** ha be van állítva az app indításakor, a daemon minden beérkező hook nyers törzsét egy JSON-sorként hozzáfűzi ehhez a fájlhoz. Diagnosztika, alapból ki van kapcsolva.
- **`CS_PROBE_MEASURE=1`:** bekapcsolja a kézi processz-probe mérést (`apps/desktop/src/main/process-probe.measure.test.ts`), ami nélküle kihagyódik. Futtatás Git Bash-ből: `CS_PROBE_MEASURE=1 pnpm --filter @claudeswitcher/desktop test process-probe.measure`.

## Dokumentáció

- Terv és mért tények: [`docs/superpowers/specs/2026-09-04-claudeswitcher-design.md`](docs/superpowers/specs/2026-09-04-claudeswitcher-design.md)
- A teljes repó-átnézés és az eredménye: [`docs/reviews/2026-10-25-repo-review.md`](docs/reviews/2026-10-25-repo-review.md)
- Feature backlog, ütemezés és halasztott tételek: [`docs/backlog.md`](docs/backlog.md)
- Az M2 spike mérései: [`spikes/m2-permission/RESULTS.md`](spikes/m2-permission/RESULTS.md)
