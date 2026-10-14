import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureLabWorkerError, sanitizedLabOutcome } from "./migration-lab-raw-error.js";
import type { LabOutcome } from "./migration-lab.js";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "lab-error-test-")); roots.push(root); return { root, file: join(root, "raw-error.json") }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const raw = { message: "synthetic failure", stack: "synthetic stack" };
const event = { step: "worker_run_reply", kind: "unknown", http_status: 500, raw_error: raw };

describe("protected LAB raw-error capture", () => {
  it("writes exclusive mode600 in owner-only mode700, not in stdout or the final result", () => {
    const { root, file } = fixture();
    const publicEvent = captureLabWorkerError(event, "lab", file);
    expect(publicEvent).toEqual({ step: "worker_run_reply", kind: "unknown", http_status: 500, raw_error_capture_status: "saved" });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(event);
    const outcome: Extract<LabOutcome, { stopped: unknown }> = { stopped: { step: "worker_run", reason: "worker_run_missing", inspect: "status", resume: "resume",
      worker_run_reply: { raw_error: raw, http_status: 500, worker_error_code: "migration_run_ready_failed", worker_error_class: "error",
        worker_error_stage: "unknown", worker_error_name: "Error", worker_error_detail_code: "unknown", transport_error_class: null, response_class: "json" } } };
    expect(JSON.stringify(sanitizedLabOutcome(outcome))).not.toContain("synthetic");
    expect(outcome.stopped.worker_run_reply?.raw_error).toEqual(raw);
  });

  it.each(["staging", "production", "LAB", undefined])("cannot capture outside literal LAB (%s)", environment => {
    const { file } = fixture();
    expect(captureLabWorkerError(event, environment, file).raw_error_capture_status).toBe("disabled");
    expect(() => statSync(file)).toThrow();
  });

  it("does not create a parent, follow a symlink or replace an original capture", () => {
    const { root, file } = fixture();
    writeFileSync(file, "original", { mode: 0o600 });
    expect(captureLabWorkerError(event, "lab", file).raw_error_capture_status).toBe("failed");
    expect(readFileSync(file, "utf8")).toBe("original");
    const link = join(root, "link.json"); symlinkSync(file, link);
    expect(captureLabWorkerError(event, "lab", link).raw_error_capture_status).toBe("failed");
    const publicDir = join(root, "public"); mkdirSync(publicDir, { mode: 0o755 });
    expect(captureLabWorkerError(event, "lab", join(publicDir, "raw.json")).raw_error_capture_status).toBe("failed");
    expect(captureLabWorkerError(event, "lab", join(root, "missing", "raw.json")).raw_error_capture_status).toBe("failed");
  });

  it("keeps missing-file, over-bound and failed-capture raw data out of stdout", () => {
    const { file } = fixture();
    expect(captureLabWorkerError(event, "lab", undefined).raw_error_capture_status).toBe("disabled");
    const huge = { ...event, raw_error: { message: "x".repeat(65536), stack: null } };
    const result = captureLabWorkerError(huge, "lab", file);
    expect(result.raw_error_capture_status).toBe("failed");
    expect(result).not.toHaveProperty("raw_error");
    expect(() => statSync(file)).toThrow();
    expect(captureLabWorkerError({ step: "worker_status" }, "lab", file)).toEqual({ step: "worker_status" });
  });
});
