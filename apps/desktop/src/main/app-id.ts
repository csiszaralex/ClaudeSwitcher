/**
 * The Application User Model ID of the app. Windows names a toast after it, and the installer's
 * Start menu shortcut carries the same ID (`resources/installer.nsh` `csApplyShortcut`, which takes
 * it from electron-builder's `appId`). A module without imports; `app-id.test.ts` checks that this
 * literal equals `appId` in `electron-builder.yml`.
 */
export const APP_USER_MODEL_ID = 'com.claudeswitcher.desktop'
