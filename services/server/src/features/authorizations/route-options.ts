import type { DatabasePool } from "../../db.js";
import type { RelayHub } from "../relay/relay.js";
import type { PolicyEmitter } from "../next/policy-outbox.js";

export interface AuthorizationRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedCollections?: boolean;
  /** next: native cloud-copy creation is wired (`collection_creation_available`). */
  nativeCollectionCreation?: boolean;
  /** mdbase-next: verify and store an app's attested Noise key (`client_noise_key`). */
  nextClientKeys?: boolean;
  nativePolicyEmitter?: Pick<PolicyEmitter, "publishCommitted">;
}
