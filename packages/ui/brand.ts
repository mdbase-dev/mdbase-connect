export type MdbaseMarkRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}>;

export const MDBASE_MARK_VIEW_BOX = "18 18 84 84";

export const mdbaseMarkInkRects = [
  { x: 22, y: 22, width: 20, height: 10, rx: 2 },
  { x: 50, y: 22, width: 20, height: 10, rx: 2 },
  { x: 78, y: 22, width: 20, height: 10, rx: 2 },
  { x: 22, y: 44, width: 12, height: 10, rx: 2 },
  { x: 22, y: 66, width: 28, height: 10, rx: 2 },
  { x: 58, y: 66, width: 40, height: 10, rx: 2 },
  { x: 22, y: 88, width: 20, height: 10, rx: 2 },
  { x: 50, y: 88, width: 20, height: 10, rx: 2 },
  { x: 78, y: 88, width: 20, height: 10, rx: 2 }
] as const satisfies readonly MdbaseMarkRect[];

export const mdbaseMarkAccentRect = {
  x: 42,
  y: 44,
  width: 56,
  height: 10,
  rx: 2
} as const satisfies MdbaseMarkRect;
