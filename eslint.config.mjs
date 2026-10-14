import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', 'spikes/**', 'eslint.config.mjs'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A build-tsconfig kizárja a teszteket, a check-tsconfig nem — típusinformáció nélkül a
        // tesztfájlok elemzési hibát adnának (lemérve: 13 ilyen).
        project: ['./packages/*/tsconfig.check.json', './apps/desktop/tsconfig.json'],
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
