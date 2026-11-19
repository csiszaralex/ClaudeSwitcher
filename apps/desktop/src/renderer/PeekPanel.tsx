import type { ConversationEntry } from '@claudeswitcher/core'
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import type { ConversationReply } from '../shared/overlay-channels.js'
import { senderName, type LinkedSession } from '../shared/prompt-links.js'
import { shortenPath } from './format.js'
import {
  PEEK_REFRESH_MS,
  PEEK_TEXT,
  imagesNote,
  isAtBottom,
  peekNotice,
  readConversationReply,
  senderLabel,
  textPieces,
  toolLine,
} from './peek.js'
import type { StatusMarker } from './session-marker.js'

/**
 * An entry's text as plain text with its line breaks kept, its fenced code blocks in a monospace
 * block. Never as HTML: the transcript is untrusted text, and React escapes every string.
 */
function EntryText({ text, truncated }: { text: string; truncated: boolean }): JSX.Element {
  return (
    <>
      {textPieces(text).map((piece, index) =>
        piece.code ? (
          <pre key={index} className="peek-code">
            {piece.text}
          </pre>
        ) : (
          <p key={index} className="peek-text">
            {piece.text}
          </p>
        ),
      )}
      {truncated && <p className="peek-note">{PEEK_TEXT.truncated}</p>}
    </>
  )
}

function Entry({ entry, name }: { entry: ConversationEntry; name: (entry: ConversationEntry & { kind: 'message' }) => string | undefined }): JSX.Element {
  switch (entry.kind) {
    case 'prompt': {
      const note = imagesNote(entry.images)
      return (
        <div className="peek-entry peek-prompt">
          <EntryText text={entry.text} truncated={entry.truncated} />
          {note !== undefined && <p className="peek-note">{note}</p>}
        </div>
      )
    }
    case 'command':
      return <div className="peek-entry peek-prompt peek-command">{entry.text}</div>
    case 'answer':
      return (
        <div className="peek-entry peek-answer">
          <EntryText text={entry.text} truncated={entry.truncated} />
        </div>
      )
    case 'tool':
      return <div className="peek-tool">{toolLine(entry.name, entry.detail)}</div>
    case 'message':
      return (
        <div className="peek-entry peek-message">
          <p className="peek-sender">{senderLabel(name(entry))}:</p>
          <EntryText text={entry.text} truncated={entry.truncated} />
        </div>
      )
  }
}

interface Props {
  sessionId: string
  /** The row's shown name (`rows.ts` `Row.name`). */
  name: string
  /** The row's marker (`statusMarker`): the peek names the session's state the way the row shows it. */
  marker: StatusMarker
  /** The row's folder (`rows.ts` `rowFolder`). */
  folder: string | undefined
  /** The live sessions, for the names of the incoming messages' senders (`senderName`). */
  sessions: readonly LinkedSession[]
  /** The history's scroll box: App's key handler scrolls it (`peek.ts` `peekScrollTop`). */
  scrollRef: RefObject<HTMLDivElement | null>
}

/**
 * The peek: one session's recent conversation, read only, in place of the list. It asks the main
 * process every `PEEK_REFRESH_MS` and redraws only when the transcript changed (the reply's
 * `version`); it stays at the bottom only if the user was at the bottom.
 */
export function PeekPanel({ sessionId, name, marker, folder, sessions, scrollRef }: Props): JSX.Element {
  const [reply, setReply] = useState<ConversationReply | undefined>()
  // Whether the next drawing scrolls to the bottom: on the first one, and when the user was there.
  const stick = useRef(true)

  useEffect(() => {
    let closed = false
    let busy = false
    let version: string | undefined
    async function load(): Promise<void> {
      if (busy) return
      busy = true
      try {
        const next = readConversationReply(await window.claudeswitcher.conversation(sessionId))
        if (closed || (next.ok && next.version === version)) return
        version = next.ok ? next.version : undefined
        const box = scrollRef.current
        stick.current = box === null || isAtBottom(box)
        setReply(next)
      } catch (error: unknown) {
        console.error('[overlay] could not read the conversation', error)
        if (!closed) setReply({ ok: false, reason: 'unreadable' })
      } finally {
        busy = false
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, PEEK_REFRESH_MS)
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [sessionId])

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box !== null && stick.current) box.scrollTop = box.scrollHeight
  }, [reply])

  const notice = peekNotice(reply)
  const messageName = (entry: ConversationEntry & { kind: 'message' }): string | undefined =>
    senderName(entry.sender, sessionId, sessions)

  return (
    <section className="peek" aria-label={`${name} beszélgetése`}>
      <header className="peek-head">
        <span className={`marker tone-${marker.tone}`} title={marker.title}>
          {marker.glyph}
        </span>
        <span className="peek-name" title={name}>
          {name}
        </span>
        <span className="peek-state">{marker.title}</span>
        {folder !== undefined && (
          <span className="peek-folder" title={folder}>
            {shortenPath(folder)}
          </span>
        )}
      </header>
      <div className="peek-history" ref={scrollRef}>
        {notice !== undefined ? (
          <p className="empty">{notice}</p>
        ) : (
          reply?.ok === true && reply.entries.map((entry, index) => <Entry key={index} entry={entry} name={messageName} />)
        )}
      </div>
    </section>
  )
}
