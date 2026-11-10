import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// The test files: exempt from the sync-spawn ban, and given the test rules (both blocks below).
const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx']
const SYNC_SPAWN_NAMES = ['execSync', 'execFileSync', 'spawnSync']
const SYNC_SPAWN_PATTERN = `/^(${SYNC_SPAWN_NAMES.join('|')})$/`
const SYNC_SPAWN_MESSAGE =
  'A synchronous child process blocks the Electron main thread, and with it the daemon and every session hook. Use the asynchronous variant (execFile, spawn).'

export default defineConfig(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', 'spikes/**'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The build tsconfig excludes the tests, the check tsconfig does not: without type information
        // the test files would give parse errors (measured: 13 of them). In the desktop app a file gets
        // its types from the first project that includes it, so the renderer's non-test files get them
        // from the Node-free `tsconfig.web.json`, its tests from `tsconfig.web.test.json`.
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
      // A missing `switch` branch would be a silent bug: exactly the risk with the decision kinds.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // A number in a template string is safe; anything else (an object, undefined) is still an error.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The renderer is a browser bundle: the core's main entry point pulls in Node modules (fs,
    // child_process), and the daemon is a server. Only types may come from them; values come only
    // from the core's IO-free entry point (`@claudeswitcher/core/browser`).
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@claudeswitcher/core',
              allowTypeImports: true,
              message: 'In the renderer only @claudeswitcher/core/browser may provide values.',
            },
            { name: '@claudeswitcher/daemon', allowTypeImports: true, message: 'The daemon is server code.' },
          ],
        },
      ],
    },
  },
  {
    // A synchronous child process stops the Electron main thread, and with it the daemon and every
    // session hook: this caused the freeze (see `createSnapshotProbe` in the core's `liveness.ts`).
    // Allowed in tests.
    // The core ESLint `no-restricted-imports` rule is a separate rule from the typescript-eslint
    // variant above, so the renderer block does not override it.
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/desktop/src/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
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
      // Also banned through a namespace import (`cp.execSync`) or by destructuring a dynamic import.
      'no-restricted-syntax': [
        'error',
        { selector: `MemberExpression[property.name=${SYNC_SPAWN_PATTERN}]`, message: SYNC_SPAWN_MESSAGE },
        { selector: `Property[key.name=${SYNC_SPAWN_PATTERN}]`, message: SYNC_SPAWN_MESSAGE },
      ],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      // In a test a wrong `!` is a loud test failure, not a silent product bug; with
      // `noUncheckedIndexedAccess` the tests' readability depends on it.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `expect(events.onX).toHaveBeenCalled()`: this is how vitest mocks are checked.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
)
