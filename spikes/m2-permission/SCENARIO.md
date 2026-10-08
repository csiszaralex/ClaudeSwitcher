# M2 spike — forgatókönyv

Cél: a spec §10 kérdéseinek **mérése** a VSCode bővítményben, mielőtt az M2-t megtervezzük.
A spike mappa (`P:\08_Apps\cs-spike`) saját, projekt-szintű `.claude/settings.json`-t kap,
tehát a hookok **csak az abban a mappában nyitott sessionre** hatnak. A globális
konfigurációd és a többi futó sessionöd érintetlen.

## Előkészítés

1. **Új PowerShell ablak — ez a szerver.** Hagyd nyitva, ide írja ki élőben, mi érkezik:
   ```powershell
   node P:\08_Apps\ClaudeSwitcher\spikes\m2-permission\server.mjs
   ```
2. **Második PowerShell ablak — ezzel váltasz módot** a fázisok között:
   ```powershell
   cd P:\08_Apps\ClaudeSwitcher\spikes\m2-permission
   node server.mjs mode pass
   ```
3. **VSCode:** *File → Open Folder* → `P:\08_Apps\cs-spike` (új ablakban). Ha rákérdez a
   megbízhatóságra, fogadd el. Nyiss egy **új** Claude Code sessiont.
4. **A beviteli mező alatt állítsd át az „Edit automatically" módot „Ask before edits"-re.**
   Enélkül a fájlírás és -szerkesztés nem kér engedélyt, és nem tudjuk mérni.

## A. Lefut-e egyáltalán? — `mode pass`

A szerver itt nem dönt, csak naplóz. Minden promptra a VSCode-ban válaszolj **„Yes"**-szel
(ne a „don't ask again" változattal). Egymás után kérd ezeket a sessiontől:

1. `Futtasd ezt a Bash paranccsal: echo spike-a > a.txt`
2. `Hozz létre egy b.txt fájlt "hello" tartalommal`
3. `Módosítsd a b.txt-t: a hello legyen szia`
4. `Töltsd le WebFetch-csel a https://example.com oldalt`
5. `Hívd meg a getDiagnostics MCP toolt`
6. Válts **Plan** módra, kérd: `Tervezd meg egy c.txt létrehozását`, majd hagyd jóvá a tervet.

Közben nézd a szerver ablakát: jön-e `→ PermissionRequest` sor.

## B. Tartás — `mode hold 60`

1. `Futtasd: echo spike-b > b2.txt`
2. **Ne nyúlj semmihez.** Figyeld: megjelenik-e a prompt a VSCode-ban **azonnal**, vagy csak
   a 60 másodperc **letelte után**? Jegyezd fel.
3. A szerver kiírja: `hold lejárt — üres 200`. Ha a prompt ezután is ott van, **várj még két
   percet**, és csak utána nyomj „Yes"-t. Kivárja-e a prompt?

## C. Párhuzamos döntés — `mode hold 60`

1. `Futtasd: echo spike-c > c2.txt`
2. Ha a prompt megjelenik **a tartás alatt**, kattints rá **azonnal** „Yes"-szel, még mielőtt a
   szerver elengedné. Mi történik? Lefut a parancs? Mit ír a szerver 60 mp múlva?

## D. Engedélyezés az appból — `mode allow`

1. `Futtasd: echo spike-d > d.txt`
2. Várt: **nincs prompt**, a parancs lefut.

## E. Tiltás — `mode deny`

1. `Futtasd: echo spike-e`
2. Várt: nem fut le, és a session tudja, hogy miért tiltottuk.

## F. Subagent — `mode pass`

1. `Indíts egy subagentet, ami Bash-sel lefuttatja: echo spike-f > f.txt`
2. „Yes" a promptra. A naplóban azt nézzük, van-e `agent_id` a PermissionRequest-ben.

## G. Telefon (Remote Control) — `mode hold 90`

1. Nyisd meg a telefonon ezt a sessiont.
2. `Futtasd: echo spike-g > g.txt`
3. Figyeld a telefont: látszik-e ott a prompt **a tartás alatt**, és **utána**?

## Végén

A szerver ablakában `Ctrl+C`. Szólj, és összesítem a naplót (`spike-log.jsonl`).
