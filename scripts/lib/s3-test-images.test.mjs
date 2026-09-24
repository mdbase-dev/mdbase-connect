import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const helper = new URL("./s3-test-images.mjs", import.meta.url).href;

// Each isolated Node child replaces spawn BEFORE loading the helper. These unit
// tests cannot invoke Docker or create a build cache, including on failure paths.
async function exercise(mode) {
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import cp from "node:child_process";
    import { EventEmitter } from "node:events";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const mode = ${JSON.stringify(mode)};
    const calls = [];
    cp.spawn = (command, args) => {
      const child = new EventEmitter();
      calls.push({ command, args });
      queueMicrotask(() => {
        const target = args[args.indexOf("--target") + 1];
        if (mode === "spawn-error") return child.emit("error", new Error("Docker unavailable"));
        if (mode === "build-failure" || (mode === "mc-failure" && target === "mc")) {
          return child.emit("exit", 13, null);
        }
        const id = mode === "invalid-id" ? "mutable:latest" :
          "sha256:" + (target === "minio" ? "a" : "b").repeat(64);
        writeFileSync(args[args.indexOf("--iidfile") + 1], id + "\\n");
        child.emit("exit", 0, null);
      });
      return child;
    };
    syncBuiltinESMExports();
    const { buildS3TestImages } = await import(${JSON.stringify(helper)});
    let result;
    try {
      const first = buildS3TestImages();
      assert.equal(first, buildS3TestImages(), "one build per process");
      result = await first;
      assert.ok(Object.isFrozen(result));
    } catch (error) { result = { error: error.message }; }
    console.log(JSON.stringify({ result, calls }));
  `]);
  const outcome = JSON.parse(stdout);
  for (const { command, args } of outcome.calls) {
    assert.equal(command, "docker");
    assert.equal(args[0], "build");
    assert.ok(args.includes("--pull"));
    assert.ok(args[args.indexOf("--file") + 1].endsWith("s3-images/Dockerfile") ||
      args[args.indexOf("--file") + 1].endsWith("s3-images\\Dockerfile"));
    await assert.rejects(access(dirname(args[args.indexOf("--iidfile") + 1])), { code: "ENOENT" });
  }
  return outcome;
}

test("returns immutable image IDs, builds each target once, and removes owned temporary files", async () => {
  const { result, calls } = await exercise("success");
  assert.deepEqual(result, { minio: "sha256:" + "a".repeat(64), mc: "sha256:" + "b".repeat(64) });
  assert.deepEqual(calls.map(({ args }) => args[args.indexOf("--target") + 1]), ["minio", "mc"]);
});

for (const [mode, count, message] of [
  ["spawn-error", 1, /Docker unavailable/u],
  ["build-failure", 1, /minio test image build failed/u],
  ["mc-failure", 2, /mc test image build failed/u],
  ["invalid-id", 1, /Invalid minio test image build ID/u]
]) {
  test(`fails closed without fallback or partial result: ${mode}`, async () => {
    const { result, calls } = await exercise(mode);
    assert.match(result.error, message);
    assert.equal(calls.length, count);
    assert.equal(result.minio, undefined);
  });
}

test("external images, source archives and toolchain behavior are pinned", async () => {
  const dockerfile = await readFile(new URL("../../test/fixtures/s3-images/Dockerfile", import.meta.url), "utf8");
  const external = [...dockerfile.matchAll(/^FROM (\S+)/gmu)]
    .map((match) => match[1]).filter((name) => !["toolchain", "runtime"].includes(name));
  assert.equal(external.length, 2);
  for (const image of external) assert.match(image, /@sha256:[a-f0-9]{64}$/u);
  assert.equal([...dockerfile.matchAll(/https:\/\/codeload\.github\.com\/minio\/(?:minio|mc)\/tar\.gz\/[a-f0-9]{40}/gu)].length, 2);
  assert.equal([...dockerfile.matchAll(/[a-f0-9]{64}  \/tmp\/source\.tar\.gz/gu)].length, 2);
  assert.equal([...dockerfile.matchAll(/sha256sum --check --strict/gu)].length, 2);
  assert.equal([...dockerfile.matchAll(/go mod verify/gu)].length, 2);
  assert.match(dockerfile, /GOTOOLCHAIN=local GOFLAGS=-mod=readonly/u);
  assert.doesNotMatch(dockerfile, /^ARG /mu);
});
