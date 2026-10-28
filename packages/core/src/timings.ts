/**
 * Azok az időzítések, amelyeket több modul használ, vagy amelyekre más modulok időzítése épül.
 *
 * Ami egyetlen modulban él, és sehol nincs másolata, az ott maradt, ahol használják (például a
 * `LATE_PROMPT_WINDOW_MS` a session-store-ban, a `PRE_TOOL_USE_TTL_MS` a DecisionBrokerben). IO-mentes.
 */

/**
 * A daemon ilyen gyakran olvassa újra a registryt és a transcripteket (`startDaemon` `pollMs`
 * alapértéke). Erre épül a session-store `UNMATCHED_WAIT_GRACE_MS`-e és a DecisionBroker
 * `ABSENT_SESSION_GRACE_MS`-e. Mért alapja nincs: a commitok és a kommentek nem rögzítenek mérést.
 */
export const POLL_INTERVAL_MS = 3000

/**
 * Ennyi ideig érvényes egy sikeres processz-pillanatkép (`createSnapshotProbe` `ttlMs` alapértéke,
 * a PowerShell és a natív probe is ezt kapja). Kisebb a `POLL_INTERVAL_MS`-nél, így minden poll
 * friss pillanatképet kér. Mért alapja nincs.
 */
export const PROBE_TTL_MS = 2000
