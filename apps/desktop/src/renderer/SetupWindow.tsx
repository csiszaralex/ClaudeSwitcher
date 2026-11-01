import { useCallback, useEffect, useState, type JSX } from 'react'
import type { SetupApi } from '../preload/setup-api.js'
import { hotkeyLabel } from '../shared/hotkey-status.js'
import { SETTINGS, type SettingDefinition, type SettingKey, type SettingValues } from '../shared/settings.js'
import {
  integrationActions,
  integrationLabel,
  readCaptured,
  mergeExternal,
  readInstallReply,
  readSaveReply,
  readSetupState,
  visibleSettings,
} from './setup-view.js'
import type { SetupState } from '../shared/setup-state.js'

/** What the user changed in the window, kept apart from the app's values (see `mergeExternal`). */
interface Form {
  values: SettingValues
  dirty: ReadonlySet<SettingKey>
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function definitionOf(key: SettingKey): SettingDefinition | undefined {
  return SETTINGS.find((setting) => setting.key === key)
}

/**
 * The first-run setup window ("Első beállítás") and, from the tray, the settings window
 * ("Beállítások"). "Mentés" confirms every setting the window shows; closing it with X confirms
 * nothing.
 */
export function SetupWindow({ api }: { api: SetupApi }): JSX.Element {
  const [state, setState] = useState<SetupState | undefined>()
  const [form, setForm] = useState<Form | undefined>()
  // The unconfirmed settings at the first load. A setting confirmed meanwhile (from the tray) stays
  // visible, so no row disappears under the user's cursor.
  const [firstAsk, setFirstAsk] = useState<SettingKey[] | undefined>()
  const [expanded, setExpanded] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [busy, setBusy] = useState<'saving' | 'integration' | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [installMessage, setInstallMessage] = useState<string | undefined>()

  const reload = useCallback(async (): Promise<void> => {
    let next: SetupState | undefined
    try {
      next = readSetupState(await api.load())
    } catch (loadError) {
      setError(`A beállítások nem tölthetők be: ${describeError(loadError)}`)
      return
    }
    if (next === undefined) {
      setError('A beállítások nem tölthetők be: érvénytelen válasz.')
      return
    }
    const loaded = next
    setState(loaded)
    setFirstAsk((previous) => previous ?? loaded.ask)
    setForm((previous) =>
      previous === undefined
        ? { values: loaded.values, dirty: new Set() }
        : { values: mergeExternal(previous.values, previous.dirty, loaded.values), dirty: previous.dirty },
    )
  }, [api])

  useEffect(() => {
    void reload()
    return api.onChanged(() => {
      void reload()
    })
  }, [api, reload])

  // The main process reads the keys while capturing (the Alt+Space family through temporary global
  // shortcuts, see `CAPTURE_SHORTCUTS`) and sends the result here.
  useEffect(
    () =>
      api.onCaptured((payload) => {
        setCapturing(false)
        const accelerator = readCaptured(payload)
        if (accelerator === undefined) return
        setForm((previous) =>
          previous === undefined
            ? previous
            : { values: { ...previous.values, hotkey: accelerator }, dirty: new Set([...previous.dirty, 'hotkey']) },
        )
        setError(undefined)
      }),
    [api],
  )

  if (state === undefined || form === undefined || firstAsk === undefined) {
    return <main className="setup">{error === undefined ? <p className="muted">Betöltés…</p> : <p className="setup-error">{error}</p>}</main>
  }

  const showAll = state.showAll || expanded
  const visible = visibleSettings({ ...state, ask: firstAsk }, showAll)
  const hiddenCount = SETTINGS.length - visible.length

  const change = <K extends SettingKey>(key: K, value: SettingValues[K]): void => {
    setForm((previous) => {
      if (previous === undefined) return previous
      return { values: { ...previous.values, [key]: value }, dirty: new Set([...previous.dirty, key]) }
    })
    setError(undefined)
  }

  const setCapture = (active: boolean): void => {
    setCapturing(active)
    api.setCapture(active).catch((captureError: unknown) => {
      setCapturing(false)
      setError(`A gyorsbillentyű felvétele nem indult el: ${describeError(captureError)}`)
    })
  }

  const save = async (): Promise<void> => {
    setBusy('saving')
    setError(undefined)
    try {
      const reply = readSaveReply(await api.save({ values: form.values, shown: visible }))
      if (reply.ok) {
        window.close()
        return
      }
      setError(reply.reason)
    } catch (saveError) {
      setError(`A mentés nem sikerült: ${describeError(saveError)}`)
    } finally {
      setBusy(undefined)
    }
  }

  const runIntegration = async (action: 'install' | 'uninstall'): Promise<void> => {
    setBusy('integration')
    setInstallMessage(undefined)
    try {
      const raw = action === 'install' ? await api.installIntegration() : await api.uninstallIntegration()
      setInstallMessage(readInstallReply(raw).message)
    } catch (actionError) {
      const what = action === 'install' ? 'A telepítés' : 'Az eltávolítás'
      setInstallMessage(`${what} nem sikerült: ${describeError(actionError)}`)
    } finally {
      setBusy(undefined)
    }
    await reload()
  }

  const row = (key: SettingKey): JSX.Element | undefined => {
    const setting = definitionOf(key)
    if (setting === undefined) return undefined
    if (key === 'hotkey') {
      const holds = state.hotkey.status === 'registered'
      return (
        <div className="setup-row" key={key}>
          <span className="setup-label">{setting.label}</span>
          <button
            type="button"
            className={capturing ? 'hotkey-capture capturing' : 'hotkey-capture'}
            onClick={() => {
              if (!capturing) setCapture(true)
            }}
            onBlur={() => {
              if (capturing) setCapture(false)
            }}
          >
            {capturing ? 'Nyomd le az új kombinációt' : form.values.hotkey}
          </button>
          {holds ? undefined : <span className="setup-note warning">{hotkeyLabel(state.hotkey)}</span>}
        </div>
      )
    }
    const unavailable = key === 'autostart' && !state.autostartAvailable
    return (
      <label className="setup-row" key={key}>
        <input
          type="checkbox"
          checked={form.values[key]}
          disabled={unavailable}
          onChange={(event) => {
            change(key, event.target.checked)
          }}
        />
        <span className="setup-label">{setting.label}</span>
        {unavailable ? <span className="setup-note">csak a telepített appban</span> : undefined}
      </label>
    )
  }

  return (
    <main className="setup">
      <h1>{state.showAll ? 'Beállítások' : 'Első beállítás'}</h1>
      {state.showAll ? undefined : (
        <p className="setup-intro muted">A Mentés elfogadja mindazt, amit itt látsz. Később a tálcamenüben a Beállítások alatt módosíthatod.</p>
      )}
      <section className="setup-section">{visible.map(row)}</section>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="setup-link"
          onClick={() => {
            setExpanded(true)
          }}
        >
          Minden beállítás
        </button>
      ) : undefined}
      <section className="setup-section">
        <h2>Claude Code integráció</h2>
        <div className="setup-row">
          <span className="setup-label">{integrationLabel(state.integration)}</span>
          {integrationActions(state.integration).map((action) => (
            <button
              type="button"
              key={action}
              disabled={busy !== undefined || capturing}
              onClick={() => {
                void runIntegration(action)
              }}
            >
              {action === 'install' ? 'Telepítés' : 'Eltávolítás'}
            </button>
          ))}
        </div>
        {installMessage === undefined ? undefined : <p className="setup-note">{installMessage}</p>}
      </section>
      {error === undefined ? undefined : <p className="setup-error">{error}</p>}
      <footer className="setup-footer">
        <button
          type="button"
          className="primary"
          disabled={busy !== undefined || capturing}
          onClick={() => {
            void save()
          }}
        >
          Mentés
        </button>
      </footer>
    </main>
  )
}
