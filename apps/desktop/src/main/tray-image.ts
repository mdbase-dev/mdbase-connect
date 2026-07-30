import { nativeImage, type NativeImage } from "electron";

export function createTrayImage(): NativeImage {
  const width = 18;
  const height = 18;
  const bitmap = Buffer.alloc(width * height * 4);
  const pixel = (
    x: number,
    y: number,
    red: number,
    green: number,
    blue: number,
    alpha = 255
  ) => {
    const offset = (y * width + x) * 4;
    bitmap[offset] = blue;
    bitmap[offset + 1] = green;
    bitmap[offset + 2] = red;
    bitmap[offset + 3] = alpha;
  };
  for (let y = 5; y < 16; y += 1) {
    for (let x = 2; x < 16; x += 1) pixel(x, y, 32, 51, 75);
  }
  for (let y = 3; y < 6; y += 1) {
    for (let x = 3; x < 9; x += 1) pixel(x, y, 32, 51, 75);
  }
  for (let y = 8; y < 13; y += 1) {
    for (let x = 5; x < 13; x += 1) pixel(x, y, 61, 105, 255);
  }
  for (let y = 1; y < 6; y += 1) {
    for (let x = 12; x < 17; x += 1) {
      const dx = x - 14;
      const dy = y - 3;
      if (dx * dx + dy * dy <= 5) pixel(x, y, 40, 167, 124);
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
}
