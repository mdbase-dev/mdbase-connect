// The hosted Worker's migration status (DATA only) and the idle predicates the
// managed driver (migration-lab.ts) and the operator re-arm (migration-rearm.ts) share.
import { z } from "zod";

/** Native Driver steps (`hosted_import::Step`, mirrored by the Worker's status). */
export const STEP = { fenced: 6, drained: 7, verified: 8, cutoverIntent: 10, routed: 13, rollingBack: 20, rolledBack: 21, failed: 22, gone: 23 } as const;

export const statusSchema = z.object({
  run: z.object({ state: z.string(), reason: z.string().nullable(), backup_hold: z.string(), migration_id: z.string().nullable(),
    stop_before_flip: z.boolean().optional(), resumed_run_sequence: z.number().int().positive().nullable().optional(),
    /** The last prepared action; timeline DATA only, absent from older Workers. */
    last: z.object({ sequence: z.number().int().nonnegative(), kind: z.number().int().nonnegative() }).nullable().optional() }).nullable(),
  native: z.union([
    z.object({ error: z.string() }),
    z.object({
      /** Current immutable native run sequence; absent from Workers without the operator entry. */
      run_sequence: z.number().int().positive().nullable().optional(),
      checkpoint: z.object({ step: z.number().int().nonnegative(), fenced: z.boolean() }).nullable(),
      outstanding: z.object({ sequence: z.number().int().positive(), kind: z.number().int().nonnegative() }).nullable()
    })
  ])
});
export type WorkerStatus = z.infer<typeof statusSchema>;

/** A Worker with nothing in flight: never dispatched, or its run fully rolled back and unfenced. */
export const workerIdle = ({ run, native }: WorkerStatus) => !("error" in native) && !native.outstanding && (run === null
  ? !native.checkpoint : (run.state === "stopped" || run.state === "done") && native.checkpoint?.step === STEP.rolledBack && !native.checkpoint.fenced);
/** A re-armed account's member still shows an earlier attempt's rolled-back run (another hold):
 * not this attempt's dispatch. Its `run` with this attempt's hold supersedes it in the Worker. */
export const currentAttempt = (status: WorkerStatus, rearmed: boolean | undefined, hold: string | undefined): WorkerStatus =>
  rearmed === true && status.run !== null && status.run.backup_hold !== hold && workerIdle(status)
    ? { run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } } : status;
