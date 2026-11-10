/** The full size of the overlay in DIPs. `createOverlay` creates the window with it. */
export const OVERLAY_WIDTH = 620
export const OVERLAY_HEIGHT = 600

/** A rectangle in DIPs, in the shape of Electron's `Rectangle`. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The overlay's position and size on a display's work area: centred horizontally, at a third
 * vertically, and always entirely inside the work area.
 *
 * It clamps the size to the work area too. On a work area lower than 600 DIPs (for example a
 * 768-pixel laptop at 125 %) the old calculation gave a negative offset, and the top of the overlay
 * stuck out of the screen. The caller sets position and size together with a single `setBounds`.
 */
export function overlayBounds(workArea: Bounds): Bounds {
  const width = Math.min(OVERLAY_WIDTH, Math.floor(workArea.width))
  const height = Math.min(OVERLAY_HEIGHT, Math.floor(workArea.height))
  const left = Math.ceil(workArea.x)
  const top = Math.ceil(workArea.y)
  const right = Math.floor(workArea.x + workArea.width)
  const bottom = Math.floor(workArea.y + workArea.height)
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = Math.round(workArea.y + (workArea.height - height) / 3)
  return {
    x: Math.min(Math.max(x, left), right - width),
    y: Math.min(Math.max(y, top), bottom - height),
    width,
    height,
  }
}
