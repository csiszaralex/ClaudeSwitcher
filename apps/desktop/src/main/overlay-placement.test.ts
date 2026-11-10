import { describe, expect, it } from 'vitest'
import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayBounds } from './overlay-placement.js'

/** The rectangle is entirely inside the work area. */
function inside(
  bounds: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  )
}

describe('overlayBounds', () => {
  it('centres the full size overlay horizontally, a third of the way down', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 }
    expect(overlayBounds(area)).toEqual({
      x: Math.round((1920 - OVERLAY_WIDTH) / 2),
      y: Math.round((1040 - OVERLAY_HEIGHT) / 3),
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    })
  })

  it('shrinks the height to a work area lower than the overlay, keeping the top on screen', () => {
    // The case a review found: a 768p laptop at 125 %, with a work area about 574 DIPs high.
    const area = { x: 0, y: 0, width: 1229, height: 574 }
    const bounds = overlayBounds(area)
    expect(bounds.height).toBe(574)
    expect(bounds.y).toBe(0)
    expect(inside(bounds, area)).toBe(true)
  })

  it('stays inside a work area that does not start at the origin', () => {
    // A second display on the left, the taskbar at the top: a negative x, a shifted y.
    const area = { x: -1280, y: 40, width: 1280, height: 984 }
    expect(inside(overlayBounds(area), area)).toBe(true)
  })

  it('shrinks the width to a work area narrower than the overlay', () => {
    const area = { x: 100, y: 0, width: 500, height: 800 }
    const bounds = overlayBounds(area)
    expect(bounds.width).toBe(500)
    expect(bounds.x).toBe(100)
    expect(inside(bounds, area)).toBe(true)
  })

  it('returns whole pixels', () => {
    const bounds = overlayBounds({ x: 0.5, y: 0.25, width: 1001, height: 777 })
    for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true)
  })
})
