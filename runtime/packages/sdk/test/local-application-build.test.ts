import {test, expect} from "vitest";
import {mkdtempSync, mkdirSync, chmodSync, writeFileSync, existsSync, rmSync} from "node:fs";
import {resolve, join} from "node:path";
// @ts-expect-error plain build-only .mjs has no declarations
import {buildLocalApplication} from "../scripts/build-local-application.mjs";

for (const refusal of ["managed", "unprotected", "external-credentials", "existing-output"])
  test(`local SDK builder refuses ${refusal} before private inputs or overlay`, () => {
    const parent = resolve(".local-application-build-tests");
    mkdirSync(parent, {recursive: true, mode: 0o700});
    const directory = mkdtempSync(join(parent, "stack-"));
    try {
      chmodSync(directory, refusal === "unprotected" ? 0o755 : 0o700);
      const stackConfig = join(directory, "local-stack.json"), outputDirectory = join(directory, "output");
      writeFileSync(stackConfig, JSON.stringify({environment: refusal === "managed" ? "lab" : "local",
        connectEnvFile: join(directory, refusal === "external-credentials" ? "wrong.json" : "job-env.json")}));
      if (refusal === "existing-output") mkdirSync(outputDirectory);
      expect(() => buildLocalApplication({stackConfig, outputDirectory, verifier: "never-run", runtimeFile: "never-read"})).toThrow("local SDK application build refused");
      expect(existsSync(outputDirectory)).toBe(refusal === "existing-output");
    } finally { rmSync(directory, {recursive: true}); }
  });
