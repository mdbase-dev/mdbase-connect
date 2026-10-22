import { mdbaseMarkAccentRect, mdbaseMarkInkRects, type MdbaseMarkRect } from "./brand.js";

/**
 * The launch flock: small birds fly in from the edges of the screen, land on the
 * Frontmatter mark as two rows of dots per bar, and close up into the solid bars.
 * Everything here is a pure function of time, so a frame can be drawn at any moment
 * and tests can check where the birds end up.
 */

/** Seconds. The mark is solid at `solid`; the entrance hands over to the real mark at `end`. */
export const FLOCK_TIMING = {
  /** Spread of start times; each bird leaves within this window. */
  spread: 0.45,
  /** How long each bird is in the air. */
  flight: 0.85,
  /** When the first bars start closing up. */
  close: 1.2,
  /** Spread of the bars' close-up times, top to bottom with the highlight last. */
  closeStagger: 0.2,
  /** How long one bar takes to close up. */
  closeDuration: 0.3,
  solid: 1.8,
  end: 2.0
} as const;

const DOT = 3.4;
const PITCH = 5;

type FlockBird = Readonly<{
  /** Index of the bar this bird belongs to in `flockBars`. */
  bar: number;
  accent: boolean;
  /** Landed dot, in mark units (the 120-unit board the mark's rects use). */
  dotX: number;
  dotY: number;
  /** The share of its bar the bird grows into when the bar closes up. */
  cell: MdbaseMarkRect;
  seed: number;
}>;

type FlockBar = Readonly<{ rect: MdbaseMarkRect; accent: boolean }>;

export const flockBars: readonly FlockBar[] = [
  ...mdbaseMarkInkRects.map((rect) => ({ rect, accent: false })),
  { rect: mdbaseMarkAccentRect, accent: true }
];

function seeded(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Two rows of dots per bar; each dot's cell tiles its bar exactly. */
export const flockBirds: readonly FlockBird[] = flockBars.flatMap(({ rect, accent }, bar) => {
  const columns = Math.max(2, Math.round((rect.width - DOT) / PITCH) + 1);
  const span = (rect.width - DOT) / (columns - 1);
  const cellWidth = rect.width / columns;
  const cellHeight = rect.height / 2;
  return Array.from({ length: columns * 2 }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      bar,
      accent,
      dotX: rect.x + column * span,
      dotY: rect.y + 1 + row * 4.6,
      cell: { x: rect.x + column * cellWidth, y: rect.y + row * cellHeight, width: cellWidth, height: cellHeight },
      seed: bar * 31 + index
    };
  });
});

/** Where the mark sits on screen: its 84-unit artboard (viewBox 18 18 84 84) in pixels. */
type FlockStage = Readonly<{
  width: number;
  height: number;
  markLeft: number;
  markTop: number;
  markSize: number;
}>;

type FlockFrame = Readonly<{
  /** One rectangle per bird still drawn as a bird, in screen pixels. */
  birds: readonly (MdbaseMarkRect & { accent: boolean })[];
  /** Bars that have closed up completely, drawn as the real rectangles. */
  bars: readonly (MdbaseMarkRect & { accent: boolean })[];
}>;

/** How far bar `index` has closed up at time `t`, 0 to 1. */
export function flockBarClosed(index: number, t: number): number {
  const { rect, accent } = flockBars[index]!;
  const order = accent ? 1 : (rect.y - 22) / 66 * 0.7;
  return smooth((t - FLOCK_TIMING.close - order * FLOCK_TIMING.closeStagger) / FLOCK_TIMING.closeDuration);
}

/** Everything to draw at time `t` seconds into the entrance. */
export function flockFrame(stage: FlockStage, t: number): FlockFrame {
  const scale = stage.markSize / 84;
  const toX = (x: number): number => stage.markLeft + (x - 18) * scale;
  const toY = (y: number): number => stage.markTop + (y - 18) * scale;
  const closed = flockBars.map((_, index) => flockBarClosed(index, t));
  const dot = DOT * scale;
  const centreX = stage.width / 2;
  const centreY = stage.height / 2;
  const margin = 12;

  const birds = flockBirds.flatMap((bird) => {
    const close = closed[bird.bar]!;
    if (close >= 1) return [];
    const landX = toX(bird.dotX);
    const landY = toY(bird.dotY);
    // Each bird comes in roughly from the side of the screen nearest its spot, with a wide spread.
    const outward = Math.atan2(landY + dot / 2 - centreY, landX + dot / 2 - centreX);
    const angle = outward + (seeded(bird.seed + 11) - 0.5) * 2.6;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const edge = Math.min(
      ux > 0 ? (stage.width + margin - landX) / ux : ux < 0 ? (landX + margin) / -ux : Infinity,
      uy > 0 ? (stage.height + margin - landY) / uy : uy < 0 ? (landY + margin) / -uy : Infinity
    );
    const reach = edge + seeded(bird.seed + 13) * Math.min(stage.width, stage.height) * 0.15;
    const startX = landX + ux * reach;
    const startY = landY + uy * reach;
    const bend = (seeded(bird.seed + 19) - 0.5) * reach * 0.45;
    const midX = (startX + landX) / 2 - uy * bend;
    const midY = (startY + landY) / 2 + ux * bend;
    const order = seeded(bird.seed + 7) * 0.8 + seeded(bird.seed + 41) * 0.2;
    const u = Math.min(1, Math.max(0, (t - order * FLOCK_TIMING.spread) / FLOCK_TIMING.flight));
    const e = 1 - (1 - u) ** 3;
    const x = (1 - e) ** 2 * startX + 2 * (1 - e) * e * midX + e * e * landX;
    const y = (1 - e) ** 2 * startY + 2 * (1 - e) * e * midY + e * e * landY;
    // Small in flight, full size on landing; never thinner than 2px so it stays visible.
    const landed = smooth((u - 0.6) / 0.4);
    const size = Math.max(dot * (0.4 + 0.6 * landed), Math.min(dot, 2));
    const left = x + (dot - size) / 2;
    const top = y + (dot - size) / 2;
    // Closing up grows the dot into its share of the bar.
    const cellX = toX(bird.cell.x);
    const cellY = toY(bird.cell.y);
    return [{
      x: left + (cellX - left) * close,
      y: top + (cellY - top) * close,
      width: size + (bird.cell.width * scale - size) * close,
      height: size + (bird.cell.height * scale - size) * close,
      accent: bird.accent
    }];
  });

  const bars = flockBars.flatMap(({ rect, accent }, index) => closed[index]! < 1 ? [] : [{
    x: toX(rect.x),
    y: toY(rect.y),
    width: rect.width * scale,
    height: rect.height * scale,
    accent
  }]);

  return { birds, bars };
}
