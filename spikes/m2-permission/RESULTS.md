# M2 spike — eredmények (2026-10-08)

Mérve a felhasználó gépén, VSCode bővítményben futó Claude Code-dal (`entrypoint:
claude-vscode`), egy eldobható mappában (`P:\08_Apps\cs-spike`) projekt-szintű hookokkal.
Eszköz: `server.mjs` (nyers napló + vezérelhető PermissionRequest válasz) és `log-hook.mjs`
(parancs-típusú iker). Minden állítás mögött a `spike-log.jsonl` egy-egy idővonala áll.

## A fő kérdés: megépíthető-e az M2?

**Igen, és egyszerűbben, mint a spec tervezte.**

| # | Kérdés | Eredmény |
|---|---|---|
| 1 | Lefut-e a `PermissionRequest` a bővítményben? | **Igen**, HTTP- és parancs-hookként is: Bash, Write, Edit, WebFetch, MCP tool, ExitPlanMode, AskUserQuestion |
| 2 | Tartás alatt mi látszik a VSCode-ban? | **A natív prompt azonnal megjelenik**, párhuzamosan a tartással |
| 3 | Elengedés (üres 200) után? | A prompt **megmarad és válaszolható** — 2,5 perccel az elengedés után is lefutott |
| 4 | VSCode-ban döntök tartás közben? | **Azonnal érvényes**; az app késői válaszát a Claude Code figyelmen kívül hagyja |
| 5 | Az app engedélyez, miközben a prompt látszik? | **A prompt eltűnik, a parancs ugyanabban a másodpercben lefut** |
| 6 | Tiltás az appból | Működik |
| 7 | Remote Control tartás alatt | **A telefonon is megjelenik, és onnan is el lehet fogadni** |
| 8 | Subagent azonosítása | `agent_id` és `agent_type` **benne van** a PermissionRequest-ben (a Notification-ben nincs) |
| 9 | Szabály-javaslat | `permission_suggestions`: a Claude Code maga adja a projekt-szabályt (pl. `Bash(echo x *)`, `WebFetch(domain:…)`) |
| 10 | Szabály beírása az appból | `updatedPermissions` + `destination: localSettings` → **a Claude Code maga írja** a `.claude/settings.local.json`-be |

## Ami ezzel a specből fölöslegessé válik

- **Lease-modell** (§5): a natív prompt sosem tűnik el, tehát nincs mit „visszaadni". Az app a
  hook timeoutjáig tarthat, utána üres 200 — a prompt marad.
- **Presence policy** (§6): a tartás nem veszi el a promptot sem a VSCode-tól, sem a telefontól.
- **RuleBuilder** (§7): a Claude Code `permission_suggestions`-ben adja a szabályt.
- **SettingsWriter az M2-ben** (§7): a Claude Code `updatedPermissions`-re maga írja be.
  (A gép-szintű `userSettings` célt nem mértük — a globális konfigurációt a spike nem érintette.)

## Amire az M2-nek figyelnie kell

1. **A natív döntést a kapcsolatból nem tudjuk meg.** Ha a felhasználó a VSCode-ban vagy a
   telefonon dönt, a Claude Code **nem bontja** a tartott HTTP kérést. Az app a függő sort a
   `PostToolUse`-ból veheti le (ugyanazon session + tool + input), elutasításnál pedig a
   következő `PreToolUse`/`Stop`-ból vagy a timeoutból.
2. **Az `AskUserQuestion` is PermissionRequest-ként jön.** Az appból „engedélyezni" ezt nem
   szabad: a kérdés válasz nélkül menne tovább. Átengedendő (üres 200), vagy külön kezelendő.
3. **Az `ExitPlanMode` is** — a jóváhagyás itt a terv elfogadását jelenti, nem egy parancsét.
4. **A `Notification` (permission_prompt) csak ~6 mp függés után jön.** A gyorsan
   megválaszolt kérések az M1 overlayben nem látszanak; az M2-ben a PermissionRequest azonnal
   jön, tehát ott látszanak.
5. **A `SessionStart` HTTP-hookként nem érkezik meg, csak parancsként.** Ez az M1 telepítését
   is érinti: a `SessionStart` HTTP-hookja sosem tüzel.

## Nyitva maradt

- **A beírt szabály tényleg megakadályozza-e a következő kérdést?** A beírás biztos. Az
  ugyanabban a sessionben 3 perccel később futtatott, átirányítást tartalmazó parancs megint
  kérdezett; az új sessionben végzett próba nem értékelhető (a Claude Code PowerShell-lel
  futtatta, a `Bash(...)` szabály eleve nem vonatkozott rá). Ugyanez a natív „don't ask again"
  gombra is igaz — a Claude Code illesztési logikája dönt, nem mi.
- **600 mp-nél hosszabb hook-timeout** — nem mértük; a lease-modell nélkül nincs rá szükség.
- **Folder-trust** — nem jött elő.
