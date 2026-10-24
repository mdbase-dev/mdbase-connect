/** Stateless LAB bootstrap restriction. Call only inside the active fetch context.
 * The immutable deployment pins the binding and minimum epoch; neither comes from
 * restored SQL, request flags or a cached permit. R2 is a restriction, not CP auth.
 */
import { parsePitrBinding, readPitrPhase, type PitrBinding } from "./pitr-phase.ts";

export interface PitrFactorySettings {
  LAB?: string;
  SERVICE_KIND?: string;
  LAB_HOSTED_CONFIG?: string;
  PITR_BINDING?: string;
  PITR_MINIMUM_EPOCH?: string;
  PITR_ESCROW_SERVICE_TOKEN?: string;
}
export interface PitrFactory {
  binding: PitrBinding;
  /** Fresh checks before generation and before returning a wrapped record. */
  seedGuard(): (collection: string) => Promise<boolean>;
}
export function pitrFactory(settings: PitrFactorySettings, bucket: Pick<R2Bucket, "get"> | undefined): PitrFactory | null {
  if (settings.LAB !== "1" || settings.SERVICE_KIND !== "hosted" || settings.LAB_HOSTED_CONFIG !== undefined
      || !bucket || !/^[1-9][0-9]{0,15}$/.test(settings.PITR_MINIMUM_EPOCH ?? "")) return null;
  const binding = parsePitrBinding(settings.PITR_BINDING);
  const minimumEpoch = Number(settings.PITR_MINIMUM_EPOCH);
  if (!binding || !Number.isSafeInteger(minimumEpoch)) return null;
  const store = bucket;
  const key = `${binding.run}/phase.json`;
  return { binding, seedGuard() {
    let epoch: number | undefined;
    let subject: string | undefined;
    return async (collection) => {
      if (collection !== binding.active && collection !== binding.deleted) return false;
      if (subject === undefined) subject = collection;
      if (subject !== collection) return false;
      const phase = await readPitrPhase(async () => {
        // R2 get has no transport AbortSignal option. The reader races the shared
        // deadline and cancels late bodies; it does not promise provider cancellation.
        const object = await store.get(key);
        return object && "body" in object ? { size: object.size, body: object.body } : null;
      }, binding, Date.now, () => minimumEpoch);
      if (!phase || phase.phase !== "seed") return false; // valid CLOSED is non-null.
      if (epoch === undefined) epoch = phase.epoch;
      return phase.epoch === epoch;
    };
  } };
}
