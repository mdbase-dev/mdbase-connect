import { randomUUID } from "node:crypto";
import { inTransaction } from "../next/bootstrap-common.js";
import { collectionDisplayName } from "../next/collection-display-name.js";
import { createServiceCloudCopy, type CloudCopyBootstrapOptions } from "../next/service-cloud-copy.js";
import { currentInstallationPairingPortal, InstallationPairingError } from "./installation-pairing.js";

interface Creation { collection_id: string; display_name: string; completed_at: Date | null }
/** Persist one original intent before canonical creation. A retry resumes the
 * SAME target/name; no caller-supplied UUID, prior history, or setup state can
 * become fresh-creation provenance. Native keying/readiness is not claimed. */
export async function createInstallationPairingCollection(options: CloudCopyBootstrapOptions, input: {
  requestId: string; user: string; session: string; displayName: string;
}) {
  const displayName = collectionDisplayName(input.displayName);
  const current: Parameters<typeof createServiceCloudCopy>[1]["current"] =
    client => currentInstallationPairingPortal(client,input.requestId,input.user,input.session);
  const intent = await inTransaction(options.db,async client => {
    await current(client);
    let saved = (await client.query<Creation>("SELECT collection_id,display_name,completed_at FROM installation_pairing_collection_creations WHERE pairing_id=$1 FOR UPDATE",[input.requestId])).rows[0];
    if (!saved) {
      saved = {collection_id:randomUUID(),display_name:displayName,completed_at:null};
      await client.query("INSERT INTO installation_pairing_collection_creations(pairing_id,collection_id,display_name) VALUES($1,$2,$3)",[input.requestId,saved.collection_id,saved.display_name]);
    }
    if (saved.display_name!==displayName) throw new InstallationPairingError(409,"installation_original_creation_changed","Resume the original named collection creation.");
    return saved;
  });
  // Canonical #699 handles immutable collection/service identity and verified
  // genesis publication. It rechecks the exact current request/session throughout.
  await createServiceCloudCopy(options,{collection:intent.collection_id,owner:input.user,runtime:"next",displayName:intent.display_name,current});
  return inTransaction(options.db,async client => {
    await current(client);
    const completed = await client.query<{collection_id:string;display_name:string}>("UPDATE installation_pairing_collection_creations SET completed_at=COALESCE(completed_at,now()) WHERE pairing_id=$1 AND collection_id=$2 AND display_name=$3 RETURNING collection_id,display_name",[input.requestId,intent.collection_id,intent.display_name]);
    if (!completed.rows[0]) throw new Error("Original collection creation intent is missing.");
    return completed.rows[0];
  });
}
