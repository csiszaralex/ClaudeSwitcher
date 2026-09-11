function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pct(source: unknown): number | undefined {
  if (!isRecord(source)) return undefined
  const value = source.used_percentage
  return typeof value === 'number' ? Math.round(value) : undefined
}

export function renderStatusLine(input: Record<string, unknown>): string {
  const parts: string[] = []

  const model = isRecord(input.model) ? input.model.display_name : undefined
  if (typeof model === 'string') parts.push(model)

  const workspace = isRecord(input.workspace) ? input.workspace : {}
  const dir = workspace.current_dir
  if (typeof dir === 'string') {
    const name = dir.split(/[\\/]/).filter((s) => s !== '').pop()
    if (name !== undefined) parts.push(name)
  }
  if (typeof workspace.branch === 'string') parts.push(workspace.branch)

  const limits = isRecord(input.rate_limits) ? input.rate_limits : {}
  const fiveHour = pct(limits.five_hour)
  const sevenDay = pct(limits.seven_day)
  if (fiveHour !== undefined) parts.push(`5h ${fiveHour}%`)
  if (sevenDay !== undefined) parts.push(`7d ${sevenDay}%`)

  return parts.join('  ·  ')
}
