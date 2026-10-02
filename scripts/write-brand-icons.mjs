import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Writes the favicon and application icons from the pixel-grid mark.
 *
 * The mark is drawn on a 16-unit grid (bars and row gaps of 2, segment gaps of 1,
 * a 1-unit margin) so that at 16 px every edge lands on a whole pixel. The app
 * icon scales the same mark to 10 units per grid unit on a 256 tile; sizes of 50 px
 * and below instead use a whole number of pixels per unit so the bars stay crisp.
 *
 * Needs `rsvg-convert` (librsvg), `magick` (ImageMagick) and `png2icns` (libicns).
 * Run `pnpm generate:icons` after changing the mark and commit the outputs.
 */

const ink = "#131921";
const accent = "#005c88";
const paper = "#fcfdff";
const edge = "#e2e7ed";

/** `[x, y, width]` on the 16-unit grid; every bar is 2 units tall. */
const inkBars = [
  [1, 1, 4], [6, 1, 4], [11, 1, 4],
  [1, 5, 2],
  [1, 9, 5], [7, 9, 8],
  [1, 13, 4], [6, 13, 4], [11, 13, 4],
];
const accentBar = [4, 5, 11];

const bar = ([x, y, width]) => `<rect x="${x}" y="${y}" width="${width}" height="2"/>`;

function markBody(indent = "  ") {
  return [
    `<g fill="${ink}">`,
    ...inkBars.map((b) => `  ${bar(b)}`),
    "</g>",
    bar(accentBar).replace("/>", ` fill="${accent}"/>`),
  ].map((line) => indent + line);
}

function favicon(title) {
  const head = title
    ? [
        "<svg",
        '  xmlns="http://www.w3.org/2000/svg"',
        '  viewBox="0 0 16 16"',
        '  role="img"',
        '  aria-labelledby="mdbase-favicon-title"',
        ">",
        `  <title id="mdbase-favicon-title">${title}</title>`,
      ]
    : ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'];
  return [...head, ...markBody(), "</svg>", ""].join("\n");
}

const tile = [
  `<rect width="256" height="256" rx="48" fill="${paper}"/>`,
  `<rect x=".75" y=".75" width="254.5" height="254.5" rx="47.25" fill="none" stroke="${edge}" stroke-width="1.5"/>`,
];

/** The 256-unit application icon; `unit` and `offset` place grid unit 0 on the tile. */
function appIcon({ title, unit = 10, offset = 48 } = {}) {
  const head = title
    ? [
        "<svg",
        '  xmlns="http://www.w3.org/2000/svg"',
        '  viewBox="0 0 256 256"',
        '  role="img"',
        '  aria-labelledby="mdbase-app-icon-title"',
        ">",
        `  <title id="mdbase-app-icon-title">${title}</title>`,
      ]
    : ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'];
  return [
    ...head,
    ...tile.map((line) => `  ${line}`),
    `  <g transform="translate(${offset} ${offset}) scale(${unit})">`,
    ...markBody("    "),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

/**
 * The app icon for one pixel size. Up to 50 px the mark uses whole pixels per grid
 * unit, centred on whole pixels; above that the master scales cleanly enough.
 */
function appIconAt(size) {
  if (size > 50) return appIcon();
  const pixels = Math.max(1, Math.round((size * 10) / 256));
  const left = (size - 14 * pixels) / 2;
  const toTile = 256 / size;
  return appIcon({ unit: pixels * toTile, offset: (left - pixels) * toTile });
}

const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "mdbase-icons-"));

async function png(svg, size, output, extra = []) {
  const source = join(work, `source-${size}.svg`);
  await writeFile(source, svg);
  execFileSync("rsvg-convert", ["--width", `${size}`, "--height", `${size}`, "--output", output, source]);
  if (extra.length) execFileSync("magick", [output, ...extra, output]);
  return output;
}

try {
  await writeFile(resolve(root, "assets/mdbase-favicon.svg"), favicon("mdbase"));
  for (const app of ["desktop", "editor", "portal"]) {
    await writeFile(resolve(root, `apps/${app}/public/mdbase-favicon.svg`), favicon());
  }
  await writeFile(resolve(root, "assets/mdbase-app-icon.svg"), appIcon({ title: "mdbase application icon" }));
  await writeFile(resolve(root, "apps/desktop/assets/app-icon.svg"), appIcon());

  for (const size of [120, 256, 512, 1024]) {
    await png(appIconAt(size), size, resolve(root, `assets/mdbase-app-icon-${size}.png`));
  }

  const desktop = resolve(root, "apps/desktop/assets");
  await png(appIconAt(1024), 1024, resolve(desktop, "app-icon.png"));

  const icoSizes = [256, 128, 64, 48, 32, 24, 16];
  const icoFrames = [];
  for (const size of icoSizes) icoFrames.push(await png(appIconAt(size), size, join(work, `ico-${size}.png`)));
  execFileSync("magick", [...icoFrames, resolve(desktop, "app-icon.ico")]);

  const icnsFrames = [];
  for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
    icnsFrames.push(await png(appIconAt(size), size, join(work, `icns-${size}.png`)));
  }
  // png2icns prints JasPer deprecation noise on stderr even when it succeeds.
  execFileSync("png2icns", [resolve(desktop, "app-icon.icns"), ...icnsFrames], { stdio: "pipe" });

  for (const size of [44, 50, 150]) {
    await png(appIconAt(size), size, resolve(desktop, `appx/SampleAppx.${size}x${size}.png`));
  }
  // The wide tile centres the 128 px icon on a transparent 310 × 150 canvas.
  await png(appIconAt(128), 128, resolve(desktop, "appx/SampleAppx.310x150.png"), [
    "-background", "none", "-gravity", "center", "-extent", "310x150",
  ]);
} finally {
  await rm(work, { recursive: true, force: true });
}

