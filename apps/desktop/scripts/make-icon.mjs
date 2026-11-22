// Writes the app's icon, `resources/icon.ico`: the logo of `src/main/app-logo.ts` (`appIconIco`) at
// every Windows icon size. electron-builder puts it on the exe and the installer (`win.icon` in
// `electron-builder.yml`). Run it from `apps/desktop` after changing the logo:
// `node scripts/make-icon.mjs`. The output is committed, and `app-logo.test.ts` fails until the
// committed file is what the logo draws.
//
// Node runs the logo's TypeScript itself (type stripping). Its relative imports name `.js` files, as
// the bundler wants; the hook below resolves such an import to the `.ts` file next to it.
import { writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('.') || !specifier.endsWith('.js')) return nextResolve(specifier, context)
    try {
      return nextResolve(specifier, context)
    } catch {
      return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context)
    }
  },
})

const { appIconIco } = await import('../src/main/app-logo.ts')
const target = new URL('../resources/icon.ico', import.meta.url)
const ico = appIconIco()
writeFileSync(target, ico)
console.log(`wrote resources/icon.ico (${ico.length} bytes)`)
