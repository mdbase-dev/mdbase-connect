import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { LogServiceError, type LogServiceClient } from "./log-service-client.js";

/** The log service's `gc` batch: a full batch means more may remain. */
const GC_BATCH_OBJECTS = 1000;
const SWEEP_PAGE = 200;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Collections whose logs still hold data. A collection that left sync keeps its
 * log until erasure, so it stays here; a deletion stops counting at once.
 */
const HELD = `n.runtime = 'next' AND NOT EXISTS (
  SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id = n.collection_id)`;

/** The log was never created, or has been erased: nothing is stored. */
function holdsNothing(error: unknown): boolean {
  return error instanceof LogServiceError && (error.code === "not_found" || error.code === "gone");
}

/** Uploaded file bytes across the owner's collections; log text and snapshots don't count. Rejects when any collection can't answer, rather than under-reporting. */
export async function nextFileBytes(
  db: DatabaseQueryable,
  log: Pick<LogServiceClient, "storageStatus">,
  owner: string
): Promise<number> {
  const held = await db.query<{ collection_id: string }>(
    `SELECT n.collection_id FROM next_collections n WHERE n.owner_user_id = $1 AND ${HELD}`,
    [owner]
  );
  const bytes = await Promise.all(held.rows.map(({ collection_id: id }) =>
    log.storageStatus(id).then(status => status.fileBytes, (error: unknown) => {
      if (holdsNothing(error)) return 0;
      throw error;
    })
  ));
  return bytes.reduce((total, value) => total + value, 0);
}

/** Runs `gc` over every held collection. One collection's failure doesn't stop the others. */
export async function sweepObjects(
  db: DatabaseQueryable,
  log: Pick<LogServiceClient, "collectGarbage">,
  onError: (error: unknown) => void
): Promise<void> {
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await db.query<{ collection_id: string }>(
      `SELECT n.collection_id FROM next_collections n WHERE n.collection_id > $1 AND ${HELD}
       ORDER BY n.collection_id LIMIT $2`,
      [after, SWEEP_PAGE]
    );
    for (const { collection_id: id } of page.rows) {
      try {
        while (await log.collectGarbage(id) === GC_BATCH_OBJECTS);
      } catch (error) {
        if (!holdsNothing(error)) onError(error);
      }
      after = id;
    }
    if (page.rows.length < SWEEP_PAGE) return;
  }
}

/** Without this sweep, a deleted file's bytes stay in `used_bytes` indefinitely. */
export class ObjectGcWorker {
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<unknown> | null = null;

  constructor(
    private readonly db: DatabasePool,
    private readonly log: Pick<LogServiceClient, "collectGarbage">,
    private readonly onError: (error: unknown) => void,
    private readonly intervalMs = SWEEP_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweepOnce(), this.intervalMs);
    this.timer.unref();
    this.sweepOnce();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping;
  }

  private sweepOnce(): void {
    if (this.sweeping) return;
    this.sweeping = sweepObjects(this.db, this.log, this.onError)
      .catch(this.onError)
      .finally(() => {
        this.sweeping = null;
      });
  }
}
