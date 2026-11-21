import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DAEMON_HOST,
  DAEMON_PROTOCOL,
  daemonWsUrl,
  hookPath,
  ideDir,
  projectsDir,
  sessionsDir,
  subagentMetaFile,
  subagentsDirOf,
  type AskQuestion,
  type HookRoute,
  type PermissionRule,
  type PromptSender,
  type SessionActivity,
  type SessionView,
  type SubagentView,
  type UsageLimit,
} from '@claudeswitcher/core'
import { fakeProbe, hookPayload, tempDir } from '@claudeswitcher/core/testing'
import { startDaemon, type Daemon, type PendingDecisionView } from '@claudeswitcher/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDaemonMessage, sanitizeState } from '../renderer/state-message.js'

/**
 * The contract between the daemon's state message and the renderer's `sanitizeState`. The daemon
 * builds the state with its real code (`startDaemon`: the registry scan, the transcripts, the hooks,
 * the held requests) and sends it over its real WebSocket; the renderer reads that very message with
 * `parseDaemonMessage`, as `useDaemonState` does, and the same state through a structured clone, as
 * the IPC path (`daemon:state`) carries it. Both must keep every session and request with every
 * field unchanged.
 *
 * The field lists below are typed against the daemon's types: a field added to one of the types
 * fails the type check until its list names it, and then this test until the daemon sends it here. A field
 * the sanitizer starts to require, or to check differently, drops the element and fails the test.
 *
 * It lives here, outside `renderer/`, because it runs the daemon's code: the renderer may import
 * only types from `@claudeswitcher/daemon` (`eslint.config.mjs`).
 */

/** Every field of the type, for the coverage checks: `satisfies` fails when the type gains or loses one. */
type FieldList<T> = Record<keyof T, true>

const SESSION_FIELDS = {
  sessionId: true,
  name: true,
  cwd: true,
  status: true,
  activity: true,
  pid: true,
  windowPid: true,
  workspaceFolder: true,
  bridgeSessionId: true,
  entrypoint: true,
  messagingSocketPath: true,
  waitingSince: true,
  notificationText: true,
  stoppedAt: true,
  subagents: true,
} satisfies FieldList<SessionView>

const ACTIVITY_FIELDS = {
  lastAssistantText: true,
  runningTool: true,
  toolDetail: true,
  lastEventAt: true,
  usageLimit: true,
  tabTitle: true,
  promptedBy: true,
} satisfies FieldList<SessionActivity>

const USAGE_LIMIT_FIELDS = { kind: true, resetsAt: true } satisfies FieldList<UsageLimit>
const SENDER_FIELDS = { pipe: true, name: true } satisfies FieldList<PromptSender>

const SUBAGENT_FIELDS = {
  agentId: true,
  agentType: true,
  description: true,
  runningTool: true,
  toolDetail: true,
  updatedAt: true,
} satisfies FieldList<SubagentView>

const DECISION_FIELDS = {
  id: true,
  createdAt: true,
  released: true,
  sessionId: true,
  cwd: true,
  toolName: true,
  toolInput: true,
  agentId: true,
  agentType: true,
  permissionMode: true,
  kind: true,
  summary: true,
  description: true,
  suggestedRules: true,
  questions: true,
  plan: true,
  readable: true,
} satisfies FieldList<PendingDecisionView>

const QUESTION_FIELDS = { question: true, header: true, multiSelect: true, options: true } satisfies FieldList<AskQuestion>
const OPTION_FIELDS = { label: true, description: true } satisfies FieldList<AskQuestion['options'][number]>
const RULE_FIELDS = { toolName: true, ruleContent: true } satisfies FieldList<PermissionRule>

/** The fields of a session the daemon always sends (`SessionView`'s required ones, and `pid`, which it always fills). */
const BARE_SESSION_FIELDS = ['activity', 'cwd', 'name', 'pid', 'sessionId', 'status']

/** The sorted union of the objects' own keys. */
function keysOf(objects: readonly object[]): string[] {
  return [...new Set(objects.flatMap((object) => Object.keys(object)))].sort()
}

function sorted(fields: object): string[] {
  return Object.keys(fields).sort()
}

// Invented sessions in the measured shapes: the ids, folders, pipes and names are made up.
const FINISHED = '7a1d0c4e-2b3f-4a5d-9e6f-1a2b3c4d5e01'
const WAITING = '7a1d0c4e-2b3f-4a5d-9e6f-1a2b3c4d5e02'
const BARE = '7a1d0c4e-2b3f-4a5d-9e6f-1a2b3c4d5e03'
const PIPE_FINISHED = String.raw`\\.\pipe\LOCAL\cc-msg-0a1b2c3d4e5f60718293a4b5c6d7e8f9`
const PIPE_WAITING = String.raw`\\.\pipe\LOCAL\cc-msg-f9e8d7c6b5a4938271605f4e3d2c1b0a`
const WORKSPACE = 'p:\\proj\\alpha'
const SUBAGENT = 'a1b2c3d4e5f60718'
const PROJECT = 'p--proj-alpha'
/** The command of the request without any optional field. */
const BARE_COMMAND = 'pnpm build'

const line = (record: Record<string, unknown>): string => JSON.stringify(record)

/** The claude directory: three registry records, a VS Code window, two transcripts and a subagent. */
async function claudeDir(): Promise<string> {
  const dir = await tempDir('cs-contract-')
  await mkdir(sessionsDir(dir), { recursive: true })
  const record = async (pid: number, fields: Record<string, unknown>): Promise<void> => {
    await writeFile(path.join(sessionsDir(dir), `${String(pid)}.json`), JSON.stringify({ pid, startedAt: 1, ...fields }))
  }
  // Every optional registry field the view carries.
  const full = { entrypoint: 'claude-vscode', bridgeSessionId: 'session_01AbCdEfGhIjKlMnOpQrStUv' }
  await record(101, { sessionId: FINISHED, cwd: `${WORKSPACE}\\app`, name: 'alpha-finished', messagingSocketPath: PIPE_FINISHED, ...full })
  await record(102, { sessionId: WAITING, cwd: WORKSPACE, name: 'alpha-waiting', messagingSocketPath: PIPE_WAITING, ...full })
  // Only the fields the registry parser requires, in a folder no window has open.
  await record(103, { sessionId: BARE, cwd: 'p:\\proj\\beta' })

  await mkdir(ideDir(dir), { recursive: true })
  await writeFile(path.join(ideDir(dir), '50269.lock'), JSON.stringify({ pid: 900, workspaceFolders: [WORKSPACE], transport: 'ws' }))

  const project = path.join(projectsDir(dir), PROJECT)
  await mkdir(project, { recursive: true })
  const limitInfo = { status: 'rejected', resetsAt: 1_795_000_000, rateLimitType: 'five_hour' }
  // The finished session: its tab title, an answer, the usage limit, then a message from the other
  // session waiting in its queue.
  await writeFile(
    path.join(project, `${FINISHED}.jsonl`),
    [
      line({ type: 'custom-title', customTitle: 'Kiadás előkészítése', sessionId: FINISHED }),
      line({ type: 'assistant', timestamp: '2026-11-21T09:00:00.000Z', message: { content: [{ type: 'text', text: 'Megnéztem a naplót.' }] } }),
      line({
        type: 'assistant',
        timestamp: '2026-11-21T09:01:00.000Z',
        isApiErrorMessage: true,
        quotaLimits: limitInfo,
        apiErrorParams: { rate_limit_info: limitInfo },
        message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'limit' }] },
      }),
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-11-21T09:02:00.000Z',
        content: `<cross-session-message from="uds:${PIPE_WAITING}" from-name="alpha-waiting" from-mode="prompting">\nNézd meg a hibát.`,
      }),
    ].join('\n') + '\n',
  )
  // The waiting session: a running tool, and a subagent with its own.
  const toolUse = (command: string, at: string): string =>
    line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
  const transcript = path.join(project, `${WAITING}.jsonl`)
  await writeFile(transcript, toolUse('pnpm test', '2026-11-21T09:03:00.000Z') + '\n')
  const subagents = subagentsDirOf(transcript)
  await mkdir(subagents, { recursive: true })
  await writeFile(path.join(subagents, `agent-${SUBAGENT}.jsonl`), toolUse('pnpm lint', '2026-11-21T09:04:00.000Z') + '\n')
  await writeFile(
    path.join(subagents, subagentMetaFile(SUBAGENT)),
    JSON.stringify({ agentType: 'general-purpose', description: 'A lint hibák átnézése' }),
  )
  return dir
}

let running: Daemon | undefined
const held: Promise<unknown>[] = []

afterEach(async () => {
  // Stopping answers every held request, so their posts settle.
  await running?.stop()
  running = undefined
  await Promise.allSettled(held.splice(0))
})

describe('the daemon state message and the renderer sanitizer', () => {
  it('keeps every field of every session and request the daemon sends', async () => {
    running = await startDaemon({ claudeDir: await claudeDir(), probe: fakeProbe(), pollMs: 0 })
    const daemon = running
    const post = (route: HookRoute, body: Record<string, unknown>): Promise<Response> =>
      fetch(`http://${DAEMON_HOST}:${String(daemon.port)}${hookPath(route)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
        body: JSON.stringify(body),
      })
    /** A measured hook body for one of the invented sessions. */
    const measured = (name: string, sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...hookPayload(name),
      session_id: sessionId,
      cwd: WORKSPACE,
      ...extra,
    })

    // The socket first: the daemon sends only changes, never the current state on connect.
    const socket = new WebSocket(daemonWsUrl(daemon.port, daemon.token))
    const messages: string[] = []
    socket.addEventListener('message', (event) => {
      messages.push(String(event.data))
    })
    await new Promise((resolve) => {
      socket.addEventListener('open', resolve)
    })

    await daemon.refresh()
    expect((await post('lifecycle/stop', measured('stop', FINISHED))).status).toBe(200)
    expect((await post('notification', measured('notification_permissionPrompt', WAITING))).status).toBe(200)
    // Held until the daemon stops. Every optional field of a request between them: a command with
    // its description, permission mode and suggested rules, a subagent's, a plan and a question.
    held.push(
      post('permission-request', measured('permissionRequest_bash', WAITING)),
      post('permission-request', measured('permissionRequest_subagent', WAITING, { agent_id: SUBAGENT })),
      post('permission-request', measured('permissionRequest_plan', WAITING)),
      post('permission-request', measured('permissionRequest_askSingle', WAITING)),
      // None of the optional fields: no description, mode, agent, plan or suggestions (and no cwd,
      // which the daemon sends as '').
      post('permission-request', { session_id: WAITING, tool_name: 'Bash', tool_input: { command: BARE_COMMAND } }),
    )
    await vi.waitFor(() => {
      expect(daemon.state().decisions).toHaveLength(5)
    })
    await daemon.refresh()

    // The last state message is the daemon's current state.
    const lastState = (): string | undefined => messages.filter((message) => message.includes('"type":"state"')).at(-1)
    await vi.waitFor(() => {
      const last = lastState()
      expect(last === undefined ? undefined : (JSON.parse(last) as { payload: unknown }).payload).toEqual(
        JSON.parse(JSON.stringify(daemon.state())),
      )
    })
    socket.close()

    const raw = lastState()!
    const wire = JSON.parse(raw) as { protocol: unknown; payload: { sessions: SessionView[]; decisions: PendingDecisionView[] } }
    expect(wire.protocol).toBe(DAEMON_PROTOCOL)
    const { sessions, decisions } = wire.payload
    expect(sessions.map((session) => session.sessionId)).toEqual([FINISHED, WAITING, BARE])

    // What the renderer keeps, from the WebSocket and from the IPC path: everything, unchanged.
    expect(parseDaemonMessage(raw)).toEqual({ kind: 'state', state: wire.payload })
    expect(sanitizeState(structuredClone(daemon.state()))).toEqual(daemon.state())

    // And the message carries every field, so the line above checked each of them.
    const activities = sessions.map((session) => session.activity)
    expect(keysOf(sessions)).toEqual(sorted(SESSION_FIELDS))
    expect(keysOf(activities)).toEqual(sorted(ACTIVITY_FIELDS))
    expect(keysOf(activities.flatMap((activity) => activity.usageLimit ?? []))).toEqual(sorted(USAGE_LIMIT_FIELDS))
    expect(keysOf(activities.flatMap((activity) => activity.promptedBy ?? []))).toEqual(sorted(SENDER_FIELDS))
    expect(keysOf(sessions.flatMap((session) => session.subagents ?? []))).toEqual(sorted(SUBAGENT_FIELDS))
    expect(keysOf(decisions)).toEqual(sorted(DECISION_FIELDS))
    const questions = decisions.flatMap((decision) => decision.questions)
    expect(keysOf(questions)).toEqual(sorted(QUESTION_FIELDS))
    expect(keysOf(questions.flatMap((question) => question.options))).toEqual(sorted(OPTION_FIELDS))
    expect(keysOf(decisions.flatMap((decision) => decision.suggestedRules))).toEqual(sorted(RULE_FIELDS))

    // The session with none of the optional fields, and its request.
    const bare = sessions.find((session) => session.sessionId === BARE)!
    expect(Object.keys(bare).sort()).toEqual(BARE_SESSION_FIELDS)
    expect(bare.activity).toEqual({})
    const bareRequest = decisions.find((decision) => decision.summary === BARE_COMMAND)!
    expect(Object.keys(bareRequest).sort()).toEqual(
      sorted(DECISION_FIELDS).filter((field) => !['agentId', 'agentType', 'description', 'permissionMode', 'plan'].includes(field)),
    )
  })
})
