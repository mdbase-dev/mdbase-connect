import { constants, closeSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LabOutcome } from "./migration-lab.js";
import { rehearsalDiagnostics } from "../../local-deployment.js";

/** Raw LAB diagnostics (Worker or target) belong only in the explicit private file. */
export function captureLabWorkerError(event: Record<string, unknown>, environment: string | undefined, path: string | undefined): Record<string, unknown> {
  const { raw_error, ...safe } = event;
  if (raw_error === undefined) return safe;
  if (!rehearsalDiagnostics(environment) || !path) return { ...safe, raw_error_capture_status: "disabled" };
  let fd: number | undefined;
  try {
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()) {
      throw new Error("raw_error_directory_not_private");
    }
    const payload = `${JSON.stringify({ ...safe, raw_error })}\n`;
    if (Buffer.byteLength(payload, "utf8") > 64 * 1024) throw new Error("raw_error_over_bound");
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, payload, "utf8");
    return { ...safe, raw_error_capture_status: "saved" };
  } catch {
    // Preserve the original file and run outcome. No path, message or stack in stdout.
    return { ...safe, raw_error_capture_status: "failed" };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Never mask the run outcome. */ } }
  }
}

/** The final stop reply must not duplicate raw data already captured privately. */
export function sanitizedLabOutcome(outcome: LabOutcome): LabOutcome {
  if (!("stopped" in outcome)) return outcome;
  const stopped = { ...outcome.stopped };
  if (stopped.worker_run_reply) {
    const { raw_error: _raw, ...safe } = stopped.worker_run_reply;
    stopped.worker_run_reply = safe;
  }
  if (stopped.target_reply) {
    const { raw_error: _raw, ...safe } = stopped.target_reply;
    stopped.target_reply = safe;
  }
  return { stopped };
}
