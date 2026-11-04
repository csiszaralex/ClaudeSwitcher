/**
 * Azok az időzítések, amelyeket több modul használ, vagy amelyekre más modulok időzítése épül.
 *
 * Ami egyetlen modulban él, és sehol nincs másolata, az ott maradt, ahol használják (például a
 * `LATE_PROMPT_WINDOW_MS` a session-store-ban, a `PRE_TOOL_USE_TTL_MS` a DecisionBrokerben). IO-mentes.
 */

/**
 * How often the daemon re-reads the registry and the transcripts (the default of `startDaemon`'s
 * `pollMs`). The DecisionBroker's `ABSENT_SESSION_GRACE_MS` is derived from it. The session store's
 * `UNMATCHED_WAIT_GRACE_MS` is not: it is a fixed value, well over one poll. No measurement behind
 * this value: no commit or comment records one.
 */
export const POLL_INTERVAL_MS = 3000

/**
 * Ennyi ideig érvényes egy sikeres processz-pillanatkép (`createSnapshotProbe` `ttlMs` alapértéke,
 * a PowerShell és a natív probe is ezt kapja). Kisebb a `POLL_INTERVAL_MS`-nél, így minden poll
 * friss pillanatképet kér. Mért alapja nincs.
 */
export const PROBE_TTL_MS = 2000
