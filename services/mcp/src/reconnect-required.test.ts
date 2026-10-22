import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ConnectGateway } from "./connect.js";
import { GatewayOperationError } from "./errors.js";
import { createMcpServer } from "./mcp.js";
import type { OAuthService } from "./oauth.js";

describe("reconnect_required tool error", () => {
  it("carries a one-click re-approval link for the connection", async () => {
    const gateway = {
      operation: vi.fn(async () => { throw new GatewayOperationError("reconnect_required", "Notes needs to be approved again for the updated mdbase.", { connection_id: "01911111-1111-7111-8111-111111111111" }); })
    } as unknown as ConnectGateway;
    const createConnectionTicket = vi.fn(async () => "https://mcp.example/connect/ticket-1");
    const context = { clientId: "client", connectionSetId: "set-1", scopes: [] };
    const server = createMcpServer(context, gateway, { createConnectionTicket } as unknown as OAuthService);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const result = await client.callTool({ name: "query_records", arguments: { connection_id: "01911111-1111-7111-8111-111111111111" } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
      error: {
        code: "reconnect_required",
        message: "Notes needs to be approved again for the updated mdbase.",
        details: {
          connection_id: "01911111-1111-7111-8111-111111111111",
          authorization_url: "https://mcp.example/connect/ticket-1",
          expires_in: 600,
          instruction: "Ask the user to open this link and approve the collection again, then retry."
        }
      }
    });
    expect(createConnectionTicket).toHaveBeenCalledWith(context, "01911111-1111-7111-8111-111111111111");
    await client.close();
  });
});
