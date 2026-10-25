/** Az overlay teljes mérete DIP-ben. A `createOverlay` ezzel hozza létre az ablakot. */
export const OVERLAY_WIDTH = 620
export const OVERLAY_HEIGHT = 600

/** Egy téglalap DIP-ben, az Electron `Rectangle` alakjában. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Az overlay helye és mérete egy kijelző munkaterületén: vízszintesen középen, függőlegesen a
 * harmadánál, és mindig teljesen a munkaterületen belül.
 *
 * A méretet is a munkaterülethez szorítja. Egy 600 DIP-nél alacsonyabb munkaterületen (például
 * egy 768 pixeles laptop 125 %-on) a régi számítás negatív eltolást adott, és az overlay teteje
 * kilógott a képernyőről. A hívó egyetlen `setBounds`-szal állítja be helyet és méretet együtt.
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
