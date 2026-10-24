// R5.8: an unintended public API change (export, member, signature) fails here.
// Intended change: `npm run api:update`, review `git diff public-api.txt`, commit.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error plain .mjs build script without declarations
import { publicApi, SNAPSHOT } from "../scripts/public-api.mjs";

it("public API matches the reviewed snapshot (npm run api:update after review)", () => {
  expect((publicApi as () => string)()).toBe(readFileSync(SNAPSHOT as string, "utf8"));
}, 60_000);
