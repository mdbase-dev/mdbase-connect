import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ConnectGateway } from "./connect.js";
import { createMcpServer } from "./mcp.js";
import type { OAuthService } from "./oauth.js";

// Hosts and directory review read these without the plugin's skill, so the
// safety guidance has to live in the server metadata itself.
async function connect(scopes: string[]) {
  const server = createMcpServer(
    { clientId: "metadata-test", connectionSetId: "metadata-test", scopes },
    {} as ConnectGateway,
    {} as OAuthService
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metadata-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools;
  const instructions = client.getInstructions();
  await client.close();
  return { tools, instructions };
}

describe("MCP server metadata", () => {
  it("gives every tool explicit hints and a description of its behaviour", async () => {
    const { tools } = await connect(["mdbase:read", "mdbase:write"]);
    expect(tools.length).toBe(16);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe("boolean");
      expect(tool.annotations?.readOnlyHint && tool.annotations.destructiveHint, tool.name).toBe(false);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThanOrEqual(120);
    }
  });

  it("marks every tool that overwrites or removes data as destructive", async () => {
    const { tools } = await connect(["mdbase:read", "mdbase:write"]);
    const hints = Object.fromEntries(tools.map(({ name, annotations }) => [
      name,
      [annotations?.readOnlyHint, annotations?.destructiveHint, annotations?.openWorldHint]
    ]));
    // [readOnlyHint, destructiveHint, openWorldHint]
    const read = [true, false, false];
    const approvalLink = [false, false, false];
    const additive = [false, false, false];
    const overwrites = [false, true, false];
    expect(hints).toEqual({
      list_connections: read,
      add_connection: approvalLink,
      reconnect_collection: approvalLink,
      describe_collection: read,
      list_changes: read,
      query_records: read,
      release_query_cursor: read,
      read_record: read,
      validate_collection: read,
      read_type: read,
      create_record: additive,
      // A rename removes the old path and can rewrite links in other records.
      rename_record: overwrites,
      create_type: additive,
      update_record: overwrites,
      update_type: overwrites,
      delete_record: overwrites
    });
  });

  it("advertises server instructions to read-only and writable connections", async () => {
    for (const scopes of [["mdbase:read"], ["mdbase:read", "mdbase:write"]]) {
      const { instructions } = await connect(scopes);
      expect(instructions?.trim()).toBeTruthy();
      expect(instructions).toContain("list_connections");
      expect(instructions).toContain("add_connection");
    }
  });
});
