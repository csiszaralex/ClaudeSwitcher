/**
 * The timings that several modules use, or that other modules' timings are derived from.
 *
 * A timing that lives in one module and has no copy elsewhere stays where it is used (for example
 * `LATE_PROMPT_WINDOW_MS` in the session store, `PRE_TOOL_USE_TTL_MS` in the DecisionBroker). IO-free.
 */

/**
 * How often the daemon re-reads the registry and the transcripts (the default of `startDaemon`'s
 * `pollMs`). The DecisionBroker's `ABSENT_SESSION_GRACE_MS` is derived from it. The session store's
 * `UNMATCHED_WAIT_GRACE_MS` is not: it is a fixed value, well over one poll. No measurement behind
 * this value: no commit or comment records one.
 */
export const POLL_INTERVAL_MS = 3000

/**
 * How long a successful process snapshot stays valid (the default `ttlMs` of `createSnapshotProbe`;
 * both the PowerShell and the native probe get it). It is shorter than `POLL_INTERVAL_MS`, so every
 * poll asks for a fresh snapshot. No measurement behind this value.
 */
export const PROBE_TTL_MS = 2000
