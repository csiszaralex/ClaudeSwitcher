import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_USER_MODEL_ID } from './app-id.js'

describe('APP_USER_MODEL_ID', () => {
  it('is the appId of the installer build', () => {
    const builderConfig = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../electron-builder.yml'),
      'utf8',
    )
    expect(/^appId:\s*(\S+)\s*$/m.exec(builderConfig)?.[1]).toBe(APP_USER_MODEL_ID)
  })
})
