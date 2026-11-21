import { describe, expect, it } from 'vitest'
import { createReplyOrder } from './useShownValue.js'

describe('createReplyOrder', () => {
  it('uses the replies that arrive in order', () => {
    const order = createReplyOrder()
    const first = order.issue()
    const second = order.issue()
    expect(order.accept(first)).toBe(true)
    expect(order.accept(second)).toBe(true)
  })

  it('drops an older reply that arrives after a newer one was used', () => {
    // A load on `shown` sent first, then a key's request; the key's reply came back first.
    const order = createReplyOrder()
    const load = order.issue()
    const key = order.issue()
    expect(order.accept(key)).toBe(true)
    expect(order.accept(load)).toBe(false)
  })

  it('uses a reply only once', () => {
    const order = createReplyOrder()
    const request = order.issue()
    expect(order.accept(request)).toBe(true)
    expect(order.accept(request)).toBe(false)
  })
})
