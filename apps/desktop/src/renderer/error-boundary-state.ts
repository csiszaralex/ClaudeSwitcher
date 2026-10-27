/**
 * Az `ErrorBoundary` állapota és a visszaállás döntése, React nélkül, hogy tesztelhető legyen.
 *
 * - `message`: a hibaüzenet, amíg a határ le van állva; `undefined`, ha egészséges.
 * - `failedAt`: a visszaállító kulcs (`resetKey`) értéke a hiba pillanatában.
 */
export interface BoundaryState {
  message: string | undefined
  failedAt: number | undefined
}

/** A hibát követő állapot. A kulcsot a következő `nextBoundaryState` jegyzi fel. */
export function failedState(error: unknown): BoundaryState {
  return { message: error instanceof Error ? error.message : String(error), failedAt: undefined }
}

/**
 * A határ állapota az aktuális visszaállító kulccsal (React `getDerivedStateFromProps`).
 *
 * A határ akkor áll vissza, ha a kulcs a hiba óta megváltozott, vagyis új állapotüzenet jött. Ha a
 * hiba ugyanannál a kulcsnál ismétlődne, a határ lent marad a következő üzenetig: így egy mindig
 * hibás állapot nem pörgeti végtelen ciklusban a renderelést.
 *
 * Kulcs nélkül (`undefined`) a határ soha nem áll vissza magától. Ilyen a döntési panel határa,
 * amit a React `key`-e (a kérés azonosítója) épít újra.
 */
export function nextBoundaryState(state: BoundaryState, resetKey: number | undefined): BoundaryState {
  if (state.message === undefined || resetKey === undefined) return state
  if (state.failedAt === undefined) return { ...state, failedAt: resetKey }
  if (state.failedAt !== resetKey) return { message: undefined, failedAt: undefined }
  return state
}
