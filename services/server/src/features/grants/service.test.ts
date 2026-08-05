import type {
  ApplicationAuthorizationProof,
  GrantSummary,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { syncHostedNotificationGrant } from "./service.js";

const collectionId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";
const applicationId = "00000000-0000-4000-8000-000000000003";
const applicationManifestDigest = "a".repeat(64);

const notificationCriteria: NotificationCriterion[] = [{
  id: "task.reminder",
  event: {
    id: "mdbase.runtime.timer.fired",
    version: "1.0.0",
    digest: `sha256:${"4".repeat(64)}`
  },
  presentation: {
    title: "Task reminder",
    body: "Open TaskNotes to view your task."
  }
}];

const applicationAuthorization = {
  binding: {
    protocol_version: 4,
    authorization_id: "00000000-0000-4000-8000-000000000004",
    application_id: applicationId,
    application_declaration_id: "dev.tasknotes.app",
    application_manifest_digest: applicationManifestDigest,
    application_installation_id: "installation",
    installation_signing_public_key: "installation-key",
    grant_agreement_public_key: "agreement-key",
    grant_signing_public_key: "signing-key",
    flow: "authorization_code",
    authorization_nonce: "nonce",
    issued_at: "2026-08-05T20:00:00.000Z",
    expires_at: "2026-08-05T20:10:00.000Z",
    redirect_uri: "https://app.tasknotes.dev/auth/mdbase/callback",
    code_challenge: "challenge",
    contracts: {
      operation_transport_protocol: 2,
      application_authorization_binding: 4,
      semantic_capabilities_contract: 1,
      durable_mutation_protocol: 1
    },
    requested_operations: ["query"]
  },
  signature: "signature"
} satisfies ApplicationAuthorizationProof;

describe("hosted notification grant synchronization", () => {
  it("sends the exact approved application identity required by the provider", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: grantId,
        application_id: applicationId,
        application_name: "TaskNotes",
        application_distribution: "web" as const,
        application_homepage: "https://app.tasknotes.dev/",
        application_project_url: null,
        application_origin: "https://app.tasknotes.dev",
        application_icon: "https://app.tasknotes.dev/icon.png",
        collection_id: collectionId,
        collection_name: "Tasks",
        operations: ["query"],
        scope: { contracts: [], access: "full_collection" as const },
        notification_criteria: notificationCriteria,
        file_capability: null,
        created_at: new Date("2026-08-05T20:00:00.000Z"),
        application_authorization: applicationAuthorization
      }],
      rowCount: 1
    }));
    const upsertNotificationGrant = vi.fn(async () => undefined);
    const db = { query } as unknown as DatabaseQueryable;
    const provider = { upsertNotificationGrant } as unknown as HostedProviderClient;

    await syncHostedNotificationGrant(db, provider, grantId);

    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      "a.distribution AS application_distribution"
    ), [grantId]);
    expect(upsertNotificationGrant).toHaveBeenCalledOnce();
    expect(upsertNotificationGrant).toHaveBeenCalledWith(
      collectionId,
      expect.objectContaining({
        application_declaration_id: "dev.tasknotes.app",
        application_manifest_digest: applicationManifestDigest,
        application_distribution: "web"
      }) satisfies Partial<GrantSummary>
    );
  });
});
