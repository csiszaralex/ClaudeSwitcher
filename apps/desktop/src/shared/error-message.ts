/** The text shown or logged for a caught value: an `Error`'s message, anything else as a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
