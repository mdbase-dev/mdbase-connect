// Predecessor public usage: no translation of declarations or exact operations.
import {
  MdbaseConnect, MdbaseMemorySelection,
  type MdbaseAppManifest, type ApplicationCapabilityRequirements,
  type MdbaseAuthorizeOptions, type MdbaseConnection
} from "../../src/index.js";
import { MdbaseSession } from "../../src/advanced.js";
import type { ApplicationRequirements } from "@mdbase-dev/connect-protocol";

const capabilities: ApplicationCapabilityRequirements = {
  contract_version: 1,
  required: ["records.query", "records.update"],
  optional: ["files.read", "notifications.background-delivery", "sync.offline-replica"]
};
const manifest: MdbaseAppManifest = {
  manifest_version: 1, id: "dev.predecessor.example", name: "Predecessor example",
  homepage: "https://example.test", redirect_uris: ["https://example.test/callback"],
  requirements: {
    access: "full_collection", contracts: [], capabilities,
    files: { actions: ["read", "replace"], scope: { kind: "collection" } }
  }
};
const options: MdbaseAuthorizeOptions = { operations: ["query", "update"] };

export async function unchangedLegacyUsage(connection: MdbaseConnection) {
  const connect = new MdbaseConnect({ serverUrl: "https://connect.example", manifest });
  await connect.authorize(options);
  await connection.authorize({ operations: ["update"] });
  await connection.requestOperations(["update"]);
  const session = new MdbaseSession(connect, { selection: new MdbaseMemorySelection(), operations: ["query", "update"] });
  await session.start();
  await session.authorize("selected");
  await session.ensureOperations(["update"]);
  const application = connect.application({ selection: new MdbaseMemorySelection() });
  await application.start();
  await application.ensureCapabilities(["records.update"]);
  return application.getSnapshot();
}

const v2Only: ApplicationRequirements = {
  contracts: [], access: "full_collection",
  // @ts-expect-error The protocol's canonical public type remains v2-only.
  capabilities: { contract_version: 1, required: [] }
};
void v2Only;
