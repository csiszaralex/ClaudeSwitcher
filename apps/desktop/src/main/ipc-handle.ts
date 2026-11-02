import { isRendererSender, type RendererLocation } from './ipc-sender.js'

/** The part of Electron's `IpcMainInvokeEvent` the sender check reads. */
export interface InvokeEvent {
  readonly senderFrame: { readonly url: string } | null
}

export type InvokeListener = (event: InvokeEvent, ...args: unknown[]) => unknown

/** The part of `ipcMain` that registers a handler; injected so the check is testable. */
interface IpcHandleRegistry {
  handle: (channel: string, listener: InvokeListener) => void
}

/** The reason a foreign sender gets, in the failure replies and in the thrown error alike. */
const FOREIGN_SENDER = 'Ismeretlen küldő.'

/**
 * Registers a handler that answers only the given page of ours (see `isRendererSender`).
 *
 * A foreign sender never reaches the handler. It is logged with the channel: if our own page's URL
 * ever differed, the only symptom would otherwise be a silent, empty window. It gets `onForeign`'s
 * reply, for the handlers whose reply has a failure shape; without one the handler throws, which is
 * a rejected promise in the renderer.
 */
export function createHandleFrom(ipc: IpcHandleRegistry) {
  return function handleFrom(
    page: RendererLocation,
    channel: string,
    handler: (...args: unknown[]) => unknown,
    onForeign?: (reason: string) => unknown,
  ): void {
    ipc.handle(channel, (event, ...args) => {
      const url = event.senderFrame?.url
      if (isRendererSender(url, page)) return handler(...args)
      console.error(`[claudeswitcher] refused ${channel} from a foreign sender: ${url ?? '(no frame)'}`)
      if (onForeign === undefined) throw new Error(FOREIGN_SENDER)
      return onForeign(FOREIGN_SENDER)
    })
  }
}
