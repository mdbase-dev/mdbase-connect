import { describe, expect, it, vi } from "vitest";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import { ConnectGateway } from "./connect.js";
import { SecretBox } from "./security.js";

const id = "01911111-1111-7111-8111-111111111111";
function fixture() {
  const gateway = new ConnectGateway({} as any, new SecretBox(Buffer.alloc(32, 7)), {} as any, "https://connect.example", {} as any, "https://mcp.example/callback");
  const row = { collection_id: id, operations: ["describe", "query"] };
  const fresh = vi.spyOn(gateway as any, "freshConnection").mockResolvedValue(row);
  return { gateway, row, fresh };
}

describe("MCP authority gates", () => {
  it.each([undefined, [], ["future"], ["query-metadata-v1"]])("sends no metadata query without complete advertisement %j", async flags => {
    const { gateway } = fixture();
    const send = vi.spyOn(gateway as any, "sendOperation").mockImplementation(async (_row, _op, _input, requestId) => ({ ok: true, status: 200, body: { protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION, request_id: requestId, ok: true, result: { protocol_version: 1, collection_id: id, authority_capabilities: flags } } }));
    await expect(gateway.operation("tenant", "connection", "query", { output: "metadata" })).rejects.toMatchObject({ code: "unsupported_authority_feature" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toBe("describe");
  });

  it("does not discover without describe approval or mistake discovery failure for missing support", async () => {
    const { gateway, row } = fixture();
    const send = vi.spyOn(gateway as any, "sendOperation").mockResolvedValue({ ok: false, status: 503, body: { error: { code: "temporarily_unavailable", message: "Offline" } } });
    row.operations = ["query"];
    await expect(gateway.operation("tenant", "connection", "query", { output: "metadata" })).rejects.toMatchObject({ code: "unsupported_authority_feature" });
    expect(send).not.toHaveBeenCalled();
    row.operations = ["query", "describe"];
    await expect(gateway.operation("tenant", "connection", "query", { output: "metadata" })).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("repeats metadata discovery after renewal rather than borrowing previous support", async () => {
    const { gateway, fresh } = fixture();
    const calls: string[] = [];
    const send = vi.spyOn(gateway as any, "sendOperation").mockImplementation(async (_row, operation, _input, requestId) => {
      calls.push(operation as string);
      if (operation === "query") return { ok: false, status: 401, body: {} };
      return { ok: true, status: 200, body: { protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION, request_id: requestId, ok: true,
        result: { protocol_version: 1, collection_id: id, authority_capabilities: calls.length === 1 ? ["query-metadata-v1", "query-record-revisions-v1"] : [] } } };
    });
    await expect(gateway.operation("tenant", "connection", "query", { output: "metadata" })).rejects.toMatchObject({ code: "unsupported_authority_feature" });
    expect(calls).toEqual(["describe", "query", "describe"]);
    expect(fresh.mock.calls.map(call => call[2])).toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("leaves ordinary queries unchanged without discovery or new permissions", async () => {
    const { gateway, row } = fixture(); row.operations = ["query"];
    const send = vi.spyOn(gateway as any, "sendOperation").mockImplementation(async (_row, _operation, _input, requestId) => ({ ok: true, status: 200,
      body: { protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION, request_id: requestId, ok: true, result: { valid: true, result: { results: [] } } } }));
    await expect(gateway.operation("tenant", "connection", "query", {})).resolves.toMatchObject({ valid: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toBe("query");
  });

  it("rechecks operation approval after authentication renewal", async () => {
    const { gateway, row, fresh } = fixture();
    fresh.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, operations: [] });
    const send = vi.spyOn(gateway as any, "sendOperation").mockResolvedValue({ ok: false, status: 401, body: {} });
    await expect(gateway.operation("tenant", "connection", "query", {})).rejects.toMatchObject({ code: "insufficient_collection_access" });
    expect(send).toHaveBeenCalledOnce();
  });
});
