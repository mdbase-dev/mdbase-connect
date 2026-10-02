import { describe, expect, it, vi, afterEach } from "vitest";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import { ConnectGateway } from "./connect.js";
import { SecretBox } from "./security.js";

const id = "01911111-1111-7111-8111-111111111111";
const descriptor = { file_id: id, path: "assets/test.pdf", revision: "r1", content_digest: `sha256:${"a".repeat(64)}`, size: 10, media_class: "pdf", modified_at: "2026-08-04T00:00:00Z" };
function fixture(approved = true) {
  const secrets = new SecretBox(Buffer.alloc(32, 7));
  const gateway = new ConnectGateway({} as any, secrets, {} as any, "https://connect.example", {} as any, "https://mcp.example/callback");
  const row = { collection_id: id, operations: ["describe", "query"], credentials_ciphertext: secrets.encrypt(JSON.stringify({
    fileCapability: approved ? { kind: "files", protocol_version: 1, actions: ["list"], scope: { kind: "selected_folders", folders: ["assets"] } } : undefined,
    authority: { operationsUrl: "https://authority.example/operations", filesUrl: "https://authority.example/files", accessToken: "secret", proofPublicKey: "key" }
  })) };
  const fresh = vi.spyOn(gateway as any, "freshConnection").mockResolvedValue(row);
  vi.spyOn(gateway as any, "authorityProof").mockResolvedValue({});
  return { gateway, row, fresh };
}
afterEach(() => vi.unstubAllGlobals());

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

  it("cancels file lookup and rejects invalid targets before discovery", async () => {
    const { gateway } = fixture();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(gateway.statFile("tenant", "connection", { path: "assets/test.pdf" }, AbortSignal.abort())).rejects.toMatchObject({ code: "operation_cancelled" });
    await expect(gateway.statFile("tenant", "connection", { path: "../escape.pdf" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(gateway.statFile("tenant", "connection", { path: "assets/test.pdf", fileId: id } as any)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not require record read or describe for separately approved file-only lookup", async () => {
    const { gateway, row } = fixture(); row.operations = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/stat")
      ? { protocol_version: 1, type: "file_stat", file: descriptor }
      : { protocol_version: 1, type: "files_page", files: [], authority_capabilities: ["files-stat-v1"] })));
    expect(await gateway.statFile("tenant", "connection", { fileId: id })).toMatchObject({ fileId: id });
  });

  it("rechecks operation approval after authentication renewal", async () => {
    const { gateway, row, fresh } = fixture();
    fresh.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, operations: [] });
    const send = vi.spyOn(gateway as any, "sendOperation").mockResolvedValue({ ok: false, status: 401, body: {} });
    await expect(gateway.operation("tenant", "connection", "query", {})).rejects.toMatchObject({ code: "insufficient_collection_access" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("requires file list independently of record permissions", async () => {
    const { gateway } = fixture(false);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(gateway.statFile("tenant", "connection", { path: "assets/test.pdf" })).rejects.toMatchObject({ code: "not_authorized" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["discovery", "stat"])("rediscovering after %s 401 cannot borrow retired route capabilities", async stage => {
    const { gateway, fresh } = fixture();
    let renewed = false;
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      paths.push(url);
      if (!renewed && (stage === "discovery" || url.endsWith("/stat"))) { renewed = true; return Response.json({}, { status: 401 }); }
      return Response.json({ protocol_version: 1, type: "files_page", files: [descriptor], authority_capabilities: renewed ? [] : ["files-stat-v1"] });
    }));
    expect(await gateway.statFile("tenant", "connection", { path: descriptor.path })).toMatchObject({ path: descriptor.path });
    expect(fresh.mock.calls.map(call => call[2])).toEqual([false, true]);
    expect(paths.filter(path => path.endsWith("/stat"))).toHaveLength(stage === "stat" ? 1 : 0);
    expect(paths.at(-1)).toContain("folder=assets");
  });

  it.each(["file_list_changed", "not_authorized"])("preserves typed file discovery failures: %s", async code => {
    const { gateway } = fixture();
    const fetch = vi.fn(async () => Response.json({ error: { code, message: "Denied" } }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(gateway.statFile("tenant", "connection", { fileId: id })).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails malformed discovery explicitly instead of treating it as an old authority", async () => {
    const { gateway } = fixture();
    const fetch = vi.fn(async () => Response.json({ protocol_version: 1, type: "files_page", files: [], authority_capabilities: null }));
    vi.stubGlobal("fetch", fetch);
    await expect(gateway.statFile("tenant", "connection", { fileId: id })).rejects.toMatchObject({ code: "invalid_operation_response" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
