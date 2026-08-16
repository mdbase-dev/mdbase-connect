import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import { ConnectGateway, GatewayOperationError } from "./connect.js";
import { OAuthService, type McpAuthContext } from "./oauth.js";

const connectionId = z.uuid().describe("Opaque connection ID returned by list_connections");
const path = z.string().min(1).max(1_024).describe("Collection-relative record path");
const revision = z.string().min(1).max(500);
const queryCursor = z.string().min(1).max(10_000).describe("Opaque hosted query cursor");
const object = z.record(z.string(), z.unknown());

export function createMcpServer(
  context: McpAuthContext,
  gateway: ConnectGateway,
  oauth: OAuthService
): McpServer {
  const server = new McpServer({ name: "mdbase", version: "0.1.0-beta.72" });

  server.registerTool("list_connections", {
    title: "List mdbase collections",
    description: "List the mdbase collections approved for this connector. Use the returned connection_id on every collection operation.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => toolResult({ connections: await gateway.listConnections(context.connectionSetId) }));

  server.registerTool("add_connection", {
    title: "Connect another mdbase collection",
    description: "Create a short-lived browser link where the user can explicitly approve another collection and its permissions.",
    annotations: { readOnlyHint: false, openWorldHint: true }
  }, async () => {
    const authorizationUrl = await oauth.createConnectionTicket(context);
    return toolResult({
      authorization_url: authorizationUrl,
      expires_in: 600,
      instruction: "Ask the user to open this link and approve a collection, then call list_connections again."
    });
  });

  server.registerTool("reconnect_collection", {
    title: "Reconnect an mdbase collection",
    description: "Create a short-lived browser link that preselects one existing collection so the user can renew or broaden its approval.",
    inputSchema: { connection_id: connectionId },
    annotations: { readOnlyHint: false, openWorldHint: true }
  }, async ({ connection_id }) => {
    const authorizationUrl = await oauth.createConnectionTicket(context, connection_id);
    return toolResult({
      authorization_url: authorizationUrl,
      connection_id,
      expires_in: 600,
      instruction: "Ask the user to open this link and review the preselected collection approval, then call list_connections again."
    });
  });

  server.registerTool("describe_collection", {
    title: "Describe an mdbase collection",
    description: "Return collection metadata, supported operations, types and contracts.",
    inputSchema: { connection_id: connectionId },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id }, { signal }) => operationTool(gateway, context, connection_id, "describe", {}, { signal }));

  server.registerTool("list_changes", {
    title: "List collection changes",
    description: "List changes after an optional collection change cursor.",
    inputSchema: {
      connection_id: connectionId,
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(200).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }, { signal }) => operationTool(gateway, context, connection_id, "changes", input, { signal }));

  server.registerTool("query_records", {
    title: "Query mdbase records",
    description: "Query records in one approved collection. Filters use the collection's native mdbase query format.",
    inputSchema: {
      connection_id: connectionId,
      types: z.array(z.string().min(1).max(200)).max(50).optional(),
      timezone: z.string().min(1).max(100).optional(),
      context: z.unknown().optional(),
      projections: z.unknown().optional(),
      where: z.unknown().optional(),
      select: z.unknown().optional(),
      order_by: z.unknown().optional(),
      group_by: z.unknown().optional(),
      summary_functions: z.unknown().optional(),
      summaries: z.unknown().optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
      offset: z.number().int().nonnegative().optional(),
      pagination: z.literal("cursor").optional(),
      cursor: queryCursor.optional(),
      snapshot: z.string().min(1).max(10_000).optional(),
      include_body: z.boolean().optional(),
      frontmatter_mode: z.enum(["effective", "persisted", "both"]).optional(),
      contract: z.unknown().optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }, { signal }) => operationTool(gateway, context, connection_id, "query", input, { signal }));

  server.registerTool("release_query_cursor", {
    title: "Release an mdbase query cursor",
    description: "Release an unfinished hosted query cursor promptly instead of waiting for bounded expiry.",
    inputSchema: { connection_id: connectionId, cursor: queryCursor },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, cursor }, { signal }) => operationTool(
    gateway,
    context,
    connection_id,
    "query",
    { release_cursor: cursor },
    { signal }
  ));

  server.registerTool("read_record", {
    title: "Read an mdbase record",
    description: "Read one record by its collection-relative path.",
    inputSchema: { connection_id: connectionId, path },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, path }, { signal }) => operationTool(gateway, context, connection_id, "read", { path }, { signal }));

  server.registerTool("validate_collection", {
    title: "Validate an mdbase collection",
    description: "Run collection validation. Optional input is passed to the collection's validation operation.",
    inputSchema: { connection_id: connectionId, input: object.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, input }, { signal }) => operationTool(gateway, context, connection_id, "validate", input ?? {}, { signal }));

  server.registerTool("read_type", {
    title: "Read an mdbase type",
    description: "Read a type definition by name or collection-relative path.",
    inputSchema: {
      connection_id: connectionId,
      name: z.string().min(1).max(200).optional(),
      path: path.optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }, { signal }) => operationTool(gateway, context, connection_id, "read_type", input, { signal }));

  if (context.scopes.includes("mdbase:write")) registerWriteTools(server, context, gateway);
  return server;
}

function registerWriteTools(server: McpServer, context: McpAuthContext, gateway: ConnectGateway): void {
  const updateRecordInput = z.object({
    connection_id: connectionId,
    path,
    patch: object.optional(),
    body: z.string().max(2_000_000).optional(),
    document: z.string().max(2_000_000).optional(),
    if_revision: revision.optional(),
    mutation_id: z.uuid().optional()
  }).refine(
    ({ patch, body, document }) => patch !== undefined || body !== undefined || document !== undefined,
    { message: "Supply at least one of patch, body, or document." }
  );
  server.registerTool("create_record", {
    title: "Create an mdbase record",
    description: "Create a record in one approved collection.",
    inputSchema: {
      connection_id: connectionId,
      path: path.optional(),
      type: z.string().min(1).max(200).optional(),
      frontmatter: object.optional(),
      body: z.string().max(2_000_000).optional(),
      if_revision: revision.optional(),
      mutation_id: z.uuid().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, mutation_id, ...input }, { signal }) => mutationOperationTool(
    gateway, context, connection_id, "create", input, mutation_id, signal
  ));

  server.registerTool("update_record", {
    title: "Update an mdbase record",
    description: "Partially update a record. Supply if_revision when available to prevent overwriting a concurrent edit.",
    inputSchema: updateRecordInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, mutation_id, ...input }, { signal }) => mutationOperationTool(
    gateway, context, connection_id, "update", input, mutation_id, signal
  ));

  server.registerTool("delete_record", {
    title: "Delete an mdbase record",
    description: "Delete one record. Supply if_revision when available and check_backlinks before removing referenced records.",
    inputSchema: {
      connection_id: connectionId,
      path,
      check_backlinks: z.boolean().optional(),
      if_revision: revision.optional(),
      mutation_id: z.uuid().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, ({ connection_id, mutation_id, ...input }, { signal }) => mutationOperationTool(
    gateway, context, connection_id, "delete", input, mutation_id, signal
  ));

  server.registerTool("rename_record", {
    title: "Rename an mdbase record",
    description: "Rename or move a record within its collection and optionally update references.",
    inputSchema: {
      connection_id: connectionId,
      from: path,
      to: path,
      update_refs: z.boolean().optional(),
      if_revision: revision.optional(),
      mutation_id: z.uuid().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, mutation_id, ...input }, { signal }) => mutationOperationTool(
    gateway, context, connection_id, "rename", input, mutation_id, signal
  ));

  server.registerTool("create_type", {
    title: "Create an mdbase type",
    description: "Create a portable mdbase type definition in an approved collection.",
    inputSchema: {
      connection_id: connectionId,
      document: z.string().min(1).max(1_000_000),
      path: path.optional(),
      mutation_id: z.uuid().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, mutation_id, ...input }, { signal }) => mutationOperationTool(
    gateway, context, connection_id, "create_type", input, mutation_id, signal
  ));

  server.registerTool("update_type", {
    title: "Update an mdbase type",
    description: "Update a portable mdbase type definition using its current revision.",
    inputSchema: {
      connection_id: connectionId,
      name: z.string().min(1).max(200).optional(),
      path: path.optional(),
      document: z.string().min(1).max(1_000_000),
      if_revision: revision,
      mutation_id: z.uuid().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, mutation_id, ...input }, { signal }) => mutationOperationTool(
    gateway, context, connection_id, "update_type", input, mutation_id, signal
  ));
}

function mutationOperationTool(
  gateway: ConnectGateway,
  context: McpAuthContext,
  connectionId: string,
  operation: CollectionOperation,
  input: unknown,
  mutationId: string | undefined,
  signal: AbortSignal
) {
  const requestId = mutationId ?? randomUUID();
  return operationTool(gateway, context, connectionId, operation, input, {
    signal,
    requestId,
    mutationReceipt: true
  });
}

async function operationTool(
  gateway: ConnectGateway,
  context: McpAuthContext,
  connectionId: string,
  operation: CollectionOperation,
  input: unknown,
  options: { signal?: AbortSignal; requestId?: string; mutationReceipt?: boolean } = {}
) {
  try {
    const value = await gateway.operation(
      context.connectionSetId,
      connectionId,
      operation,
      input,
      { signal: options.signal, requestId: options.requestId }
    );
    return toolResult(options.mutationReceipt ? {
      mutation_receipt: {
        request_id: options.requestId,
        retry: "Reuse this request_id as mutation_id when retrying the exact mutation."
      },
      outcome: value
    } : value);
  } catch (error) {
    const value = error instanceof GatewayOperationError
      ? {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
            ...(options.mutationReceipt ? { request_id: options.requestId } : {})
          }
        }
      : {
          error: {
            code: "operation_failed",
            message: "The collection operation failed.",
            ...(options.mutationReceipt ? { request_id: options.requestId } : {})
          }
        };
    return {
      ...toolResult(value),
      isError: true
    };
  }
}

function toolResult(value: unknown) {
  const structuredContent = isObject(value) ? value : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
