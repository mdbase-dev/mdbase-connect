import { readdir } from "node:fs/promises";

const directory = process.argv[2];
const origin = process.argv[3];
if (!directory || !origin) {
  throw new Error("Usage: node scripts/verify-deployment-assets.mjs <asset-directory> <origin>");
}

const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
if (files.length === 0) throw new Error(`No deployment assets found in ${directory}.`);

const attempts = positiveInteger(process.env.MDBASE_ASSET_VERIFY_ATTEMPTS, 1);
const delayMs = nonNegativeInteger(process.env.MDBASE_ASSET_VERIFY_DELAY_MS, 0);
let failure;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await Promise.all(files.map(async (file) => {
      const url = new URL(`assets/${file}`, origin);
      url.searchParams.set("deployment-check", `${Date.now()}-${attempt}`);
      const response = await fetch(url, { cache: "no-store" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || contentType.includes("text/html")) {
        throw new Error(`${file} returned HTTP ${response.status} with ${contentType || "no content type"}`);
      }
    }));
    console.log(`Verified ${files.length} editor assets at ${origin}`);
    process.exit(0);
  } catch (error) {
    failure = error;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
throw failure;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
