import type { DatabasePool } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";

export interface AuthorizationRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
  drainProviderRevocations(): Promise<void>;
}
