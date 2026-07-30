import type { FastifyInstance } from "fastify";
import { accessView, requireCollectionAction, resolveHostedCollectionAccess, resolveLocalCollectionAccess } from "../../collection-access.js";
import {
  listHostedCollectionsVisibleToUser,
  listLocalCollectionsVisibleToUser
} from "../../collection-catalog.js";
import type { DatabasePool } from "../../db.js";
import {
  contractRequirements,
  effectiveHostedContractDescriptors,
  type HostedAuthorityRegistry
} from "../../hosted.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";
import type { AuthenticationPolicyStore } from "../../authentication-policy.js";
import { requireUser } from "../../platform/request-authentication.js";
import { sqlPlaceholders } from "../../platform/sql.js";
import { recoverExpiredAuthorityTransfers } from "../authority-transfer/lifecycle.js";
import { liveAuthorizationCollections } from "../authorizations/local-collections.js";
import { requiresHostedCollection } from "../grants/policy.js";
import { hostedMirrorReplicas } from "../hosted/service.js";

interface AccountOverviewRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  publicUrl: string;
  authenticationPolicy: AuthenticationPolicyStore;
  tailscaleAuth?: boolean;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReference?: HostedAuthorityRegistry;
}

export function registerAccountOverviewRoute(
  app: FastifyInstance,
  options: AccountOverviewRouteOptions
): void {
  app.get("/v1/me", async (request, reply) => {
    const authenticated = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!authenticated) return;
    if (options.hostedCollections) {
      await recoverExpiredAuthorityTransfers(
        options.db,
        options.hostedProvider,
        options.hostedReference
      );
    }
    const { authentication_provider: authenticationProvider, ...user } = authenticated;
    const connectors = await options.db.query(
      `SELECT c.id, c.name, c.last_seen_at, c.created_at
       FROM connectors c
       WHERE c.user_id = $1 AND c.revoked_at IS NULL
       ORDER BY c.created_at`,
      [user.id]
    );
    const localCatalog = await listLocalCollectionsVisibleToUser(
      options.db,
      user.id
    );
    const localAuthorityIds = localCatalog.map(
      (collection) => collection.authorityRowId
    );
    const collections = localAuthorityIds.length
      ? await options.db.query(
          `SELECT col.id, col.connector_id, col.local_id, col.display_name,
                  col.spec_version, col.enabled, col.authority_state,
                  col.authority_epoch, col.contracts, col.last_seen_at,
                  connector.name AS connector_name
           FROM collections col
           JOIN connectors connector ON connector.id = col.connector_id
           WHERE col.id IN (${sqlPlaceholders(localAuthorityIds.length)})
             AND connector.revoked_at IS NULL
             AND col.authority_state = 'active'
             AND col.present = true
           ORDER BY col.display_name`,
          localAuthorityIds
        )
      : { rows: [] };
    const hostedCatalog = options.hostedCollections
      ? (await listHostedCollectionsVisibleToUser(options.db, user.id))
          .filter((collection) =>
            collection.locator.authorityState !== "importing"
          )
      : [];
    const hostedCollections = {
      rows: await Promise.all(hostedCatalog.map(async (collection) => ({
        id: collection.locator.collectionId,
        display_name: collection.locator.displayName,
        template: collection.template,
        contracts: collection.contracts,
        provider_url: collection.locator.providerUrl ?? null,
        authority_state:
          collection.locator.authorityState as "active" | "transferring" | "transferred",
        authority_epoch: collection.locator.authorityEpoch,
        transferred_collection_id: collection.transferredCollectionId,
        created_at: collection.createdAt,
        access: accessView(requireCollectionAction(
          await resolveHostedCollectionAccess(
            options.db,
            user.id,
            collection.locator.collectionId
          ),
          "collection.discover"
        ))
      })))
    };
    const hostedReplicas = {
      rows: await hostedMirrorReplicas(
        options.db,
        hostedCollections.rows.map((collection) => collection.id)
      )
    };
    const hostedReplicaStatuses = new Map<string, {
      head: number;
      acknowledged_sequence: number;
      last_seen_at: string | null;
      token_expires_at: string;
    }>();
    if (options.hostedProvider) {
      const statusGroups = await Promise.all(
        hostedCollections.rows.map(async (collection) => {
          try {
            return await options.hostedProvider!.replicaStatuses(collection.id);
          } catch (error) {
            request.log.warn(
              { error, collection_id: collection.id },
              "Hosted mirror status is unavailable"
            );
            return [];
          }
        })
      );
      for (const status of statusGroups.flat()) {
        hostedReplicaStatuses.set(status.id, status);
      }
    }
    const grants = await options.db.query(
      `SELECT g.id, g.operations, g.scope, g.created_at, g.revoked_at,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              COALESCE(col.local_id, g.hosted_collection_id) AS collection_id,
              a.id AS application_id,
              a.family_identity AS application_family_id,
              a.distribution, a.name AS application_name,
              a.homepage, a.project_url, a.icon,
              COALESCE(col.display_name, hosted.display_name) AS collection_name,
              CASE WHEN g.hosted_collection_id IS NULL THEN 'local' ELSE 'hosted' END AS collection_kind
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
       WHERE g.user_id = $1
         AND (g.activated_at IS NOT NULL OR g.revoked_at IS NOT NULL)
       ORDER BY g.created_at DESC`,
      [user.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.flow, ar.user_code, ar.requested_operations,
              ar.collection_id, ar.expires_at,
              a.id AS application_id, a.distribution, a.name AS application_name,
              a.homepage, a.project_url, a.icon,
              a.requirements, a.provisions, a.notifications
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [user.id]
    );
    const authenticationSettings = await options.authenticationPolicy.current();
    return {
      user,
      hosted_collections_available: options.hostedCollections === true,
      authentication: {
        provider: authenticationProvider ?? (options.tailscaleAuth ? "tailscale" : "session"),
        registration: authenticationSettings.registrationMode
      },
      connectors: connectors.rows,
      collections: await Promise.all(collections.rows.map(async (collection) => {
        const access = await resolveLocalCollectionAccess(
          options.db,
          user.id,
          collection.id
        );
        return {
          ...collection,
          id: collection.local_id,
          ...(access ? {
            access: accessView(access),
            authority: {
              kind: "local",
              collection_id: access.collection.collectionId,
              epoch: access.collection.authorityEpoch,
              state: access.collection.authorityState
            }
          } : {})
        };
      })),
      hosted_collections: hostedCollections.rows.map((collection) => ({
        ...collection,
        provider_url: collection.provider_url ?? options.publicUrl,
        spec_version: "0.3.0",
        authority_epoch: Number(collection.authority_epoch),
        authority: {
          kind: "hosted",
          collection_id: collection.id,
          epoch: Number(collection.authority_epoch),
          state: collection.authority_state
        },
        contracts: contractRequirements(effectiveHostedContractDescriptors(
          collection.contracts,
          collection.template
        )),
        replicas: hostedReplicas.rows
          .filter((replica) => replica.collection_id === collection.id)
          .map((replica) => ({
            ...replica,
            sync_status: hostedReplicaStatuses.get(replica.id) ?? null
          }))
      })),
      grants: grants.rows.map((grant) => ({
        ...grant,
        application_origin: normalizedApplicationOrigin(grant.application_origin)
      })),
      pending_authorizations: await Promise.all(
        pendingAuthorizations.rows.map(async (authorization) => {
          const live = requiresHostedCollection(authorization.requirements)
            ? { collections: [], unavailable_connectors: [] }
            : await liveAuthorizationCollections(
                options.db,
                options.relay,
                user.id,
                authorization.id
              );
          return {
            ...authorization,
            available_collections: live.collections,
            unavailable_connectors: live.unavailable_connectors
          };
        })
      )
    };
  });
}

function normalizedApplicationOrigin(value: string): string {
  return value === "null" ? value : new URL(value).origin;
}
