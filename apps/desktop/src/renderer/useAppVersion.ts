import { useEffect, useState } from 'react'

/**
 * This app's version from the IPC reply (`OVERLAY_CHANNELS.appVersion`): a non-empty string, or
 * `undefined` for anything else, so the status bar then shows no version.
 */
export function readAppVersion(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** The status bar's check time, after the version when there is one: `0.7.0 · ellenőrizve: 2 mp`. */
export function withAppVersion(version: string | undefined, text: string): string {
  return version === undefined ? text : `${version} · ${text}`
}

/**
 * This app's version, as the main process gives it (`app.getVersion()`). Read once, when the page
 * loads: it does not change while the app runs. `undefined` until the reply, or if it fails.
 */
export function useAppVersion(): string | undefined {
  const [version, setVersion] = useState<string | undefined>()

  useEffect(() => {
    let closed = false
    window.claudeswitcher
      .appVersion()
      .then((raw) => {
        if (!closed) setVersion(readAppVersion(raw))
      })
      .catch((error: unknown) => {
        console.error('[overlay] could not read the app version', error)
      })
    return () => {
      closed = true
    }
  }, [])

  return version
}
