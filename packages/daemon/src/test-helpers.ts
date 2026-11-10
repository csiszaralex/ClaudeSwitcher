/** Reads until the list is not empty and returns it. Throws on a timeout. */
export async function waitFor<T>(read: () => T[] | Promise<T[]>, timeoutMs = 2000): Promise<T[]> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value.length > 0) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
