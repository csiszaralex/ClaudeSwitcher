import path from 'node:path'

/**
 * Where the tray icons live.
 *
 * Packaged, `extraResources` in `electron-builder.yml` copies them to `resources/icons`,
 * next to `app.asar`. From the repo (`dev`, `start`), the bundle runs from `out/main`, so
 * the source folder is two levels up.
 */
export function resourcesDir(packaged: boolean, resourcesPath: string, moduleDir: string): string {
  return packaged ? path.join(resourcesPath, 'icons') : path.join(moduleDir, '../../resources')
}
