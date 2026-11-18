import { isRecord } from './guards.js'
import type { UsageLimit } from './types.js'

/**
 * The `rateLimitType` values of the usage limits Claude Code reports, the one home of these raw
 * strings: `five_hour` (the 5-hour limit) and `seven_day` (the weekly limit), both measured (design
 * doc, "The usage limit record"). Any other value is kept as raw text, and the consumer treats it
 * as a generic limit.
 */
export const USAGE_LIMIT_KIND = {
  fiveHour: 'five_hour',
  sevenDay: 'seven_day',
} as const

/**
 * The field names of the synthetic assistant record Claude Code writes into the transcript when the
 * account hit a usage limit, the one home of them. Measured on 2.1.326 (2026-11-18, 5-hour limit):
 * `isApiErrorMessage: true`, `quotaLimits` and `apiErrorParams.rate_limit_info` both carry
 * `{ status: 'rejected', resetsAt: <Unix seconds>, rateLimitType: 'five_hour', … }`. The 2.1.268
 * records (2026-09-16) have `quotaLimits` only, without `apiErrorParams`, so `quotaLimits` is read
 * first and `rate_limit_info` is the fallback. Design doc, "The usage limit record".
 */
const RECORD = {
  isApiError: 'isApiErrorMessage',
  quota: 'quotaLimits',
  params: 'apiErrorParams',
  paramsInfo: 'rate_limit_info',
  status: 'status',
  rejected: 'rejected',
  resetsAt: 'resetsAt',
  kind: 'rateLimitType',
} as const

/** Whether the transcript record is one of Claude Code's synthetic API error records. */
export function isApiErrorRecord(rec: Record<string, unknown>): boolean {
  return rec[RECORD.isApiError] === true
}

function rejectedInfo(rec: Record<string, unknown>): Record<string, unknown> | undefined {
  const quota = rec[RECORD.quota]
  if (isRecord(quota) && quota[RECORD.status] === RECORD.rejected) return quota
  const params = rec[RECORD.params]
  const info = isRecord(params) ? params[RECORD.paramsInfo] : undefined
  if (isRecord(info) && info[RECORD.status] === RECORD.rejected) return info
  return undefined
}

/**
 * The usage limit an assistant record of the transcript reports, or `undefined` when the record is
 * not a usage limit record (see `RECORD`). `kind` is the raw `rateLimitType`; `resetsAt` is in epoch
 * ms, and absent when the field is missing or not a positive finite number.
 */
export function usageLimitOf(rec: Record<string, unknown>): UsageLimit | undefined {
  if (!isApiErrorRecord(rec)) return undefined
  const info = rejectedInfo(rec)
  if (info === undefined) return undefined
  const kind = info[RECORD.kind]
  const seconds = info[RECORD.resetsAt]
  return {
    kind: typeof kind === 'string' && kind !== '' ? kind : undefined,
    resetsAt: typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
  }
}
