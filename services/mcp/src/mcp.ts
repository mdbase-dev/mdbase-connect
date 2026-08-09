import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import { ConnectGateway, GatewayOperationError } from "./connect.js";
import { OAuthService, type McpAuthContext } from "./oauth.js";

const connectionId = z.uuid().describe("Opaque connection ID returned by list_connections");
const path = z.string().min(1).max(1_024).describe("Collection-relative record path");
const revision = z.string().min(1).max(500);
const object = z.record(z.string(), z.unknown());

export function createMcpServer(
  context: McpAuthContext,
  gateway: ConnectGateway,
  oauth: OAuthService
): McpServer {
  const server = new McpServer({ name: "mdbase", version: "0.1.0-beta.54" });

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
  }, ({ connection_id }) => operationTool(gateway, context, connection_id, "describe", {}));

  server.registerTool("list_changes", {
    title: "List collection changes",
    description: "List changes after an optional collection change cursor.",
    inputSchema: {
      connection_id: connectionId,
      after: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(200).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "changes", input));

  server.registerTool("query_records", {
    title: "Query mdbase records",
    description: "Query records in one approved collection. Filters use the collection's native mdbase query format.",
    inputSchema: {
      connection_id: connectionId,
      types: z.array(z.string().min(1).max(200)).max(50).optional(),
      where: z.unknown().optional(),
      order_by: z.unknown().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
      include_body: z.boolean().optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "query", input));

  server.registerTool("read_record", {
    title: "Read an mdbase record",
    description: "Read one record by its collection-relative path.",
    inputSchema: { connection_id: connectionId, path },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, path }) => operationTool(gateway, context, connection_id, "read", { path }));

  server.registerTool("validate_collection", {
    title: "Validate an mdbase collection",
    description: "Run collection validation. Optional input is passed to the collection's validation operation.",
    inputSchema: { connection_id: connectionId, input: object.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, input }) => operationTool(gateway, context, connection_id, "validate", input ?? {}));

  server.registerTool("read_type", {
    title: "Read an mdbase type",
    description: "Read a type definition by name or collection-relative path.",
    inputSchema: {
      connection_id: connectionId,
      name: z.string().min(1).max(200).optional(),
      path: path.optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "read_type", input));

  if (context.scopes.includes("mdbase:write")) registerWriteTools(server, context, gateway);
  return server;
}

function registerWriteTools(server: McpServer, context: McpAuthContext, gateway: ConnectGateway): void {
  server.registerTool("create_record", {
    title: "Create an mdbase record",
    description: "Create a record in one approved collection.",
    inputSchema: {
      connection_id: connectionId,
      path: path.optional(),
      type: z.string().min(1).max(200).optional(),
      frontmatter: object.optional(),
      body: z.string().max(2_000_000).optional(),
      if_revision: revision.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "create", input));

  server.registerTool("update_record", {
    title: "Update an mdbase record",
    description: "Partially update a record. Supply if_revision when available to prevent overwriting a concurrent edit.",
    inputSchema: {
      connection_id: connectionId,
      path,
      patch: object,
      body: z.string().max(2_000_000).optional(),
      if_revision: revision.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "update", input));

  server.registerTool("delete_record", {
    title: "Delete an mdbase record",
    description: "Delete one record. Supply if_revision when available and check_backlinks before removing referenced records.",
    inputSchema: {
      connection_id: connectionId,
      path,
      check_backlinks: z.boolean().optional(),
      if_revision: revision.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "delete", input));

  server.registerTool("rename_record", {
    title: "Rename an mdbase record",
    description: "Rename or move a record within its collection and optionally update references.",
    inputSchema: {
      connection_id: connectionId,
      from: path,
      to: path,
      update_refs: z.boolean().optional(),
      if_revision: revision.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "rename", input));

  server.registerTool("create_type", {
    title: "Create an mdbase type",
    description: "Create a portable mdbase type definition in an approved collection.",
    inputSchema: {
      connection_id: connectionId,
      document: z.string().min(1).max(1_000_000),
      path: path.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "create_type", input));

  server.registerTool("update_type", {
    title: "Update an mdbase type",
    description: "Update a portable mdbase type definition using its current revision.",
    inputSchema: {
      connection_id: connectionId,
      name: z.string().min(1).max(200).optional(),
      path: path.optional(),
      document: z.string().min(1).max(1_000_000),
      if_revision: revision
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, ({ connection_id, ...input }) => operationTool(gateway, context, connection_id, "update_type", input));
}

async function operationTool(
  gateway: ConnectGateway,
  context: McpAuthContext,
  connectionId: string,
  operation: CollectionOperation,
  input: unknown
) {
  try {
    return toolResult(await gateway.operation(context.connectionSetId, connectionId, operation, input));
  } catch (error) {
    const value = error instanceof GatewayOperationError
      ? { error: { code: error.code, message: error.message } }
      : { error: { code: "operation_failed", message: "The collection operation failed." } };
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
