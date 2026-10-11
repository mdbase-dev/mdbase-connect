import {it, expect} from "vitest";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

it("public live-query declarations accept omitted and undefined metadata with exact optional properties", () => {
  const sdk = fileURLToPath(new URL("..", import.meta.url));
  const directory = mkdtempSync(join(sdk, ".strict-live-types-"));
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  try {
    // Emit fresh public declarations with the production project configuration;
    // never consume a stale dist or alter a published/installed declaration.
    execFileSync(process.execPath, [compiler, "-p", "tsconfig.build.json", "--declaration", "--emitDeclarationOnly", "--outDir", join(directory, "dist")], {cwd: sdk, stdio: "pipe"});
    const consumer = join(directory, "consumer.ts");
    writeFileSync(consumer, `import type {LiveQuery, LiveQueryState} from "./dist/index.js";
declare const live: LiveQuery;
const borrowed: LiveQueryState = live;
const omitted: LiveQueryState = {records: [], complete: false, asOf: 0, stale: true};
const undefinedMetadata: LiveQueryState = {...omitted, metadata: undefined};
void borrowed; void undefinedMetadata;
`);
    const output = execFileSync(process.execPath, [compiler, consumer, "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck", "false", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--lib", "ES2022,DOM,DOM.Iterable"], {cwd: sdk, encoding: "utf8", stdio: "pipe"});
    expect(output).toBe("");
  } catch (error) {
    const diagnostics = error as {stdout?: Buffer | string; stderr?: Buffer | string};
    throw new Error(`Strict public consumer compilation failed:\n${String(diagnostics.stdout ?? "")}\n${String(diagnostics.stderr ?? "")}`, {cause: error});
  } finally {rmSync(directory, {recursive: true, force: true});}
}, 30_000);
