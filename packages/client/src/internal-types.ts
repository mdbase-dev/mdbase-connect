import type {
  ApplicationNotifications,
  ApplicationRequirements,
  CollectionOperation,
  EncryptedRelayOperationRequest,
  GrantEncryption,
  FileCapability,
  GrantScope,
  MdbaseOperationRequest,
  MutationOperationIdentifier
} from "@mdbase-dev/connect-protocol";
import { encryptRelayRequest } from "./crypto.js";

export interface Application {
  id: string;
  family_identity: string;
  manifest_digest: string;
  name: string;
  distribution?: "web" | "portable";
  homepage?: string;
  project_url?: string;
  notifications?: ApplicationNotifications;
  requirements: ApplicationRequirements;
}

export interface StoredAuthorization {
  version: 1;
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  relayEncryption: "required" | "disabled";
  collectionId?: string;
  returnTo?: string;
  keyHandle?: string;
  authorizationId?: string;
  applicationAgreementPublicKey?: string;
  applicationSigningPublicKey?: string;
}

export interface StoredToken {
  version: 1;
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  collectionId: string;
  collectionName: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  expiresAt: number;
  refreshExpiresAt?: number;
  grantId?: string;
  encryption?: GrantEncryption;
  fileCapability?: FileCapability;
  applicationOrigin?: string;
  keyHandle?: string;
  savedAt: number;
  authority?: {
    operationsUrl: string;
    syncUrl: string;
    filesUrl: string;
    replicaId: string;
    accessToken: string;
    proofPublicKey?: string;
  };
}

export interface StoredConnectionIndex {
  version: 1;
  collectionIds: string[];
}

export interface PendingMutation {
  collectionId: string;
  grantId?: string;
  keyId?: string;
  keyHandle?: string;
  applicationId?: string;
  encryption?: GrantEncryption;
  operation: CollectionOperation;
  mutation?: MutationOperationIdentifier;
  inputFingerprint: string;
  requestId: string;
  envelope?: EncryptedRelayOperationRequest;
  /** Exact plaintext protocol request for transports that do not use a grant envelope. */
  request?: MdbaseOperationRequest;
  createdAt: number;
}

export interface OperationAttempt {
  response: Response;
  requestId: string;
  encryptedRequest?: Awaited<ReturnType<typeof encryptRelayRequest>>;
  directDeliveryUncertain?: boolean;
  pendingMutation?: boolean;
  pendingMutationRecord?: PendingMutation;
  resumingMutation?: boolean;
}

export const DEFAULT_OPERATIONS: CollectionOperation[] = ["describe", "changes", "read", "query"];
