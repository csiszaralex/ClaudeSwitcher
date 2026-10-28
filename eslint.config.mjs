import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

const SYNC_SPAWN_NAMES = ['execSync', 'execFileSync', 'spawnSync']
const SYNC_SPAWN_PATTERN = `/^(${SYNC_SPAWN_NAMES.join('|')})$/`
const SYNC_SPAWN_MESSAGE =
  'A szinkron gyerekprocessz blokkolja az Electron főszálát, vele a daemont és minden session hookját. Használd az aszinkron változatot (execFile, spawn).'

export default defineConfig(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', 'spikes/**'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A build-tsconfig kizárja a teszteket, a check-tsconfig nem — típusinformáció nélkül a
        // tesztfájlok elemzési hibát adnának (lemérve: 13 ilyen). A desktopnál egy fájl az első
        // olyan projektből kap típust, amelyik tartalmazza: a renderer nem teszt fájljai így a
        // Node-mentes `tsconfig.web.json`-ból, a tesztjei a `tsconfig.web.test.json`-ból.
        project: [
          './packages/*/tsconfig.check.json',
          './apps/desktop/tsconfig.node.json',
          './apps/desktop/tsconfig.web.json',
          './apps/desktop/tsconfig.web.test.json',
          './tsconfig.eslint.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Egy kimaradt `switch`-ág csendes hiba lenne — a döntés-fajtáknál (Task 2–3) pont ez a kockázat.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Szám a template stringben biztonságos; minden más (objektum, undefined) továbbra is hiba.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // A renderer böngészős csomag: a core fő belépési pontja Node-modulokat húz be (fs,
    // child_process), a daemon pedig szerver. Belőlük csak típus jöhet; érték csak a core
    // IO-mentes belépési pontjából (`@claudeswitcher/core/browser`, a 3. feladattól).
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@claudeswitcher/core',
              allowTypeImports: true,
              message: 'A rendererben értéket csak a @claudeswitcher/core/browser adhat.',
            },
            { name: '@claudeswitcher/daemon', allowTypeImports: true, message: 'A daemon szerver-kód.' },
          ],
        },
      ],
    },
  },
  {
    // A szinkron gyerekprocessz megállítja az Electron főszálát, vele a daemont és minden session
    // hookját: ez okozta a fagyást (lásd `createSnapshotProbe` a core `liveness.ts`-ében). Tesztben
    // megengedett.
    // A mag `no-restricted-imports` szabálya külön szabály a fenti typescript-eslint változattól,
    // így a renderer blokkja nem írja felül.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/desktop/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:child_process', 'child_process'].map((name) => ({
            name,
            importNames: SYNC_SPAWN_NAMES,
            message: SYNC_SPAWN_MESSAGE,
          })),
        },
      ],
      // Névtér-importon (`cp.execSync`) vagy dinamikus import destrukturálásán át is tilos.
      'no-restricted-syntax': [
        'error',
        { selector: `MemberExpression[property.name=${SYNC_SPAWN_PATTERN}]`, message: SYNC_SPAWN_MESSAGE },
        { selector: `Property[key.name=${SYNC_SPAWN_PATTERN}]`, message: SYNC_SPAWN_MESSAGE },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      // Tesztben egy rossz `!` hangos tesztbukás, nem csendes termékhiba; a
      // `noUncheckedIndexedAccess` mellett a tesztek olvashatósága ezen múlik.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `expect(events.onX).toHaveBeenCalled()` — a vitest mockok így ellenőrizhetők.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
)
