import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("the workspace resolves exactly one Rustls crypto provider", async () => {
  const { stdout } = await run("cargo", [
    "tree",
    "--locked",
    "--offline",
    "--workspace",
    "--invert",
    "rustls",
    "--edges",
    "features"
  ], { cwd: root });

  assert.match(stdout, /rustls feature "aws-lc-rs"/u);
  assert.doesNotMatch(stdout, /rustls feature "ring"/u);
});
