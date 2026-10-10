import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("exposes a browser-pure shared query subpath with an exact parser pin", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.exports["./tasknotes-query"]).toEqual({
    types: "./dist/query/tasknotes.d.ts", import: "./dist/query/tasknotes.js",
  });
  expect(manifest.dependencies["obsidian-bases-expression"]).toBe("0.3.0-rc.4");
  const result = await build({
    stdin: { contents: 'export * from "./src/query/tasknotes.ts"', resolveDir: root },
    bundle: true, write: false, platform: "browser", format: "esm", metafile: true,
  });
  expect(result.outputFiles[0]!.contents.length).toBeLessThan(64 * 1024);
  const output = Object.values(result.metafile!.outputs)[0]!;
  expect(output.exports.slice().sort()).toEqual([
    "TASKNOTES_QUERY_COMPILER_VERSION", "TASKNOTES_QUERY_PARSER_VERSION",
    "TaskNotesQueryError", "compileTaskNotesQuery",
  ].sort());
  const liveInputs = Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path);
  expect(liveInputs.some(path => path.endsWith("/query/tasknotes.ts"))).toBe(true);
  expect(liveInputs.some(path => path.includes("obsidian-bases-expression"))).toBe(true);
  for (const path of liveInputs) {
    expect(path).not.toMatch(/node:|@mdbase-dev\/sdk|\/src\/(host|vault|daemon|shared)\//);
    expect(path).not.toMatch(/\/(obsidian|moment)\//);
    expect(path).not.toMatch(/\/(evaluator|context|compile|mdbase)\.js$/);
  }
});
