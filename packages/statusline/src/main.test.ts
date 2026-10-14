import { describe, expect, it } from 'vitest'
import { readAllOrGiveUp } from './main.js'

/** Stream, ami sosem ér véget, amíg le nem zárják. */
function neverEnding(): AsyncIterable<Buffer> & { destroy(): void } {
  let destroyed = false
  return {
    destroy() {
      destroyed = true
    },
    async *[Symbol.asyncIterator]() {
      while (!destroyed) await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

function finite(chunks: string[]): AsyncIterable<Buffer> & { destroy(): void } {
  return {
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await Promise.resolve()
        yield Buffer.from(chunk, 'utf8')
      }
    },
  }
}

describe('readAllOrGiveUp', () => {
  it('returns everything a finite stream delivered', async () => {
    expect(await readAllOrGiveUp(finite(['{"a"', ':1}']), 1000)).toBe('{"a":1}')
  })

  it('gives up and returns empty when the stream never ends', async () => {
    expect(await readAllOrGiveUp(neverEnding(), 20)).toBe('')
  })

  it('destroys the stream when it gives up, so the process can exit', async () => {
    const stream = neverEnding()
    let destroyed = false
    const original = stream.destroy.bind(stream)
    stream.destroy = () => {
      destroyed = true
      original()
    }

    await readAllOrGiveUp(stream, 20)
    expect(destroyed).toBe(true)
  })
})
