import { encodePng, rasterizeIcon, type IconPaint } from './icon-raster.js'
import type { TrayState } from './tray-state.js'

/**
 * The tray icon's colours, `#rrggbb`. The one home of the tray's colours; where the list shows the
 * same state, the value equals the list's CSS variable in `renderer/styles.css`, and
 * `tray-icon.test.ts` checks that the two agree.
 */
export const TRAY_COLORS = {
  /** Nothing waits. */
  idle: '#8a8880',
  /** A yes/no request or a Notification wait: `--accent`. */
  yesNo: '#d97757',
  /** A request that asks for a choice (a question or a plan): `--choice`. */
  choice: '#b8406a',
  /** Only requests the app has released: `--warning`, the list's ◆. */
  released: '#e3b341',
  /** A session finished and the user has not seen it yet: `--success`, the list's ✓. */
  done: '#8fbf7a',
  /** A session works: `--info`, the list's ◐. */
  working: '#7aa2c4',
  /** The flash frame of a request about to be released: `--danger`, the list's warning red. */
  flash: '#e0796b',
  /** The exclamation mark on the flash frame. */
  mark: '#ffffff',
} as const

/**
 * What the icon shows: a disc in one colour, or, with `ring`, a ring in that colour around a
 * smaller disc in `fill`. With `mark`, a white exclamation mark on the disc.
 */
export interface TrayLook {
  fill: string
  ring?: string | undefined
  mark?: boolean | undefined
}

/**
 * The flash frame: a red disc with a white exclamation mark. The red alone is too close to the
 * orange of a yes/no request (`--danger` against `--accent`) to be seen as a change on the taskbar;
 * the mark makes the frame differ in shape and brightness too.
 */
const FLASH_LOOK: TrayLook = { fill: TRAY_COLORS.flash, mark: true }

function waitColor(state: TrayState): string | undefined {
  switch (state.wait) {
    case 'none':
      return undefined
    case 'yes-no':
      return TRAY_COLORS.yesNo
    case 'choice':
      return TRAY_COLORS.choice
    case 'released':
      return TRAY_COLORS.released
  }
}

/**
 * The icon for a tray state. The centre, the first match winning: what waits (a request the app can
 * decide, else one it has released), a finish nobody has seen yet (green), a session at work (blue),
 * else idle grey. An unseen finish puts a green ring around a waiting centre, a released one
 * included: it waits for the user too, and the finish must not disappear behind it. A working session
 * gets no ring: it needs nothing from the user. While the state flashes, every frame with `flashOn`
 * is the flash frame instead, and the frames between are the normal icon (`main/tray.ts` alternates
 * `flashOn` on each tick).
 */
export function trayLook(state: TrayState, flashOn: boolean): TrayLook {
  if (state.flash && flashOn) return FLASH_LOOK
  const waiting = waitColor(state)
  const finished = state.finishedCount > 0
  if (waiting !== undefined) return finished ? { fill: waiting, ring: TRAY_COLORS.done } : { fill: waiting }
  if (finished) return { fill: TRAY_COLORS.done }
  return { fill: state.workingCount > 0 ? TRAY_COLORS.working : TRAY_COLORS.idle }
}

/**
 * The icon's size in device-independent pixels, the size Windows shows in the notification area at
 * 100 % scaling. The shapes below are described in these units; `trayIconSize` gives the pixels.
 */
const TRAY_ICON_UNITS = 16

/**
 * The icon's size in pixels on a display with this scale factor: 16 at 100 %, 20 at 125 %, 24 at
 * 150 % and 32 at 200 %. Drawn at exactly that size, Windows shows the icon without scaling it.
 */
export function trayIconSize(scaleFactor: number): number {
  return Math.round(TRAY_ICON_UNITS * scaleFactor)
}

/** The centre of the icon, on both axes. */
const CENTER = TRAY_ICON_UNITS / 2

/** The disc: 12 units across, the 12 px disc of the 16 px icon. */
const DISC_RADIUS = 6

/**
 * With a ring: the ring is the disc outside a radius of 5 (1 unit wide), and the centre a disc of
 * radius 4 (8 units across), with a 1 unit transparent gap between them, so the two colours do not
 * blur into one even at 16 px.
 */
const RING_INNER_RADIUS = 5
const CORE_RADIUS = 4

/**
 * The exclamation mark: 2 units wide in the middle, a bar and a dot below it, with a 1 unit gap. Its
 * edges are whole units, so at 16 px it is drawn in whole pixels.
 */
const MARK_LEFT = 7
const MARK_RIGHT = 9
const MARK_BAR_TOP = 3
const MARK_BAR_BOTTOM = 10
const MARK_DOT_TOP = 11
const MARK_DOT_BOTTOM = 13

/** The mark's edges, in units. */
interface MarkEdges {
  left: number
  right: number
  barTop: number
  barBottom: number
  dotTop: number
  dotBottom: number
}

/**
 * The mark's edges snapped to whole pixels at `size`, so its thin white strokes stay crisp on the red
 * at every size: at 20 and 24 px the unit edges fall on half pixels, which blurred the mark (seen in
 * the previews, 2026-11-22). Its sides snap outwards, so it stays centred (every size is even, the
 * centre a pixel boundary); its rows round to the nearest pixel, so the gap between the bar and the
 * dot never closes. At 16 px nothing moves.
 */
function markEdges(size: number): MarkEdges {
  const scale = size / TRAY_ICON_UNITS
  const snap = (units: number, round: (pixels: number) => number): number => round(units * scale) / scale
  return {
    left: snap(MARK_LEFT, Math.floor),
    right: snap(MARK_RIGHT, Math.ceil),
    barTop: snap(MARK_BAR_TOP, Math.round),
    barBottom: snap(MARK_BAR_BOTTOM, Math.round),
    dotTop: snap(MARK_DOT_TOP, Math.round),
    dotBottom: snap(MARK_DOT_BOTTOM, Math.round),
  }
}

function onMark(mark: MarkEdges, x: number, y: number): boolean {
  if (x < mark.left || x > mark.right) return false
  return (y >= mark.barTop && y <= mark.barBottom) || (y >= mark.dotTop && y <= mark.dotBottom)
}

/** The colour of a look at a point, in units, drawn at `size`; `undefined` where the icon is transparent. */
function paintOf(look: TrayLook, size: number): IconPaint {
  const mark = markEdges(size)
  return (x, y) => {
    const distance = Math.hypot(x - CENTER, y - CENTER)
    if (distance > DISC_RADIUS) return undefined
    if (look.mark === true && onMark(mark, x, y)) return TRAY_COLORS.mark
    if (look.ring === undefined) return look.fill
    if (distance > RING_INNER_RADIUS) return look.ring
    return distance <= CORE_RADIUS ? look.fill : undefined
  }
}

/**
 * The icon as `size` x `size` RGBA pixels (`rasterizeIcon`: anti-aliased, straight alpha, row by
 * row). Every size is the same drawing (`paintOf`).
 */
export function trayIconPixels(look: TrayLook, size: number): Buffer {
  return rasterizeIcon(size, TRAY_ICON_UNITS, paintOf(look, size))
}

/** The icon as a PNG file in memory (`encodePng`), for `nativeImage.createFromBuffer`. */
export function trayIconPng(look: TrayLook, size: number): Buffer {
  return encodePng(size, trayIconPixels(look, size))
}
