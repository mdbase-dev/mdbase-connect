import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileCapability } from "@mdbase-dev/connect-protocol";
import { MdbaseFileClient, type MdbaseFileStatTarget } from "./files.js";
import { connectError } from "./errors.js";
import { connectFailure, connectSuccess } from "./outcomes.js";
import { resolveConnectTimeouts } from "./request-budget.js";

const fileId = "01911111-1111-7111-8111-111111111111";
const descriptor = {
  file_id: fileId, path: "Assets/Café.pdf", revision: "opaque:1", content_digest: `sha256:${"0".repeat(64)}`,
  size: 1234, media_class: "pdf", modified_at: "2026-08-01T02:03:04Z"
};
const capability: FileCapability = { kind: "files", protocol_version: 1, actions: ["list"], scope: { kind: "selected_folders", folders: ["Assets"] } };
function client(request: any, supported = false, grant = capability) {
  return new MdbaseFileClient(() => grant, request, undefined, undefined, resolveConnectTimeouts(), async () => connectSuccess(supported));
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("capability-gated files.stat", () => {
  it.each([{ path: "Assets/Café.pdf" }, { fileId }])("sends advertised point requests for %j", async target => {
    const request = vi.fn(async () => ({ protocol_version: 1, type: "file_stat", file: descriptor }));
    const outcome = await client(request, true).stat(target);
    expect(outcome).toMatchObject({ ok: true, value: { fileId, path: descriptor.path, revision: "opaque:1" } });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0].slice(0, 3)).toEqual(["POST", "stat", {
      protocol_version: 1, type: "stat_file", ...("path" in target ? { path: target.path } : { file_id: target.fileId })
    }]);
  });
  it("returns null for authoritative missing/invisible targets without a listing retry", async () => {
    const request = vi.fn(async () => ({ protocol_version: 1, type: "file_stat", file: null }));
    expect(await client(request, true).stat({ fileId })).toMatchObject({ ok: true, value: null });
    expect(request).toHaveBeenCalledOnce();
  });
  it("accepts opaque UUID targets including nil, without inventing identity", async () => {
    const request = vi.fn(async () => ({ protocol_version: 1, type: "file_stat", file: null }));
    expect(await client(request, true).stat({ fileId: "00000000-0000-0000-0000-000000000000" })).toMatchObject({ ok: true, value: null });
  });
  it.each([{ path: "Assets/other.pdf" }, { fileId: "01922222-2222-7222-8222-222222222222" }])("rejects a response bound to a different target: %j", async target => {
    const request = vi.fn(async () => ({ protocol_version: 1, type: "file_stat", file: descriptor }));
    expect(await client(request, true).stat(target)).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
    expect(request).toHaveBeenCalledOnce();
  });
  it("falls back to narrowed paginated listings and portable identity for old authorities", async () => {
    const request = vi.fn(async (_method, path) => ({ protocol_version: 1, type: "files_page",
      files: path.includes("after=page-2") ? [descriptor] : [],
      ...(path.includes("after=page-2") ? {} : { next: "page-2" }) }));
    expect(await client(request).stat({ path: "assets/CAFE\u0301.PDF" })).toMatchObject({ ok: true, value: { fileId } });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [method, path, input] of request.mock.calls) {
      expect(method).toBe("GET"); expect(path).toContain("folder=assets"); expect(input).toBeUndefined();
    }
  });
  it.each([false, true])("uses the authority's Unicode-scalar portable key (advertised=%s)", async advertised => {
    const file = { ...descriptor, path: "Assets/οσ.pdf" };
    const request = vi.fn(async () => advertised
      ? { protocol_version: 1, type: "file_stat", file }
      : { protocol_version: 1, type: "files_page", files: [file] });
    expect(await client(request, advertised).stat({ path: "Assets/ΟΣ.pdf" })).toMatchObject({ ok: true, value: { fileId, path: file.path } });
  });
  it("ID fallback walks only the granted listing scope without a folder assumption", async () => {
    const request = vi.fn(async () => ({ protocol_version: 1, type: "files_page", files: [descriptor] }));
    expect(await client(request).stat({ fileId: fileId.toUpperCase() })).toMatchObject({ ok: true, value: { fileId } });
    expect(request.mock.calls[0][1]).toBe("?protocol_version=1");
  });
  it("returns null when the legacy inventory finishes without the target", async () => {
    const request = vi.fn(async () => ({ protocol_version: 1, type: "files_page", files: [] }));
    expect(await client(request).stat({ path: "Assets/missing.pdf" })).toMatchObject({ ok: true, value: null });
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([false, true])("list approval remains required (advertised=%s)", async supported => {
    const request = vi.fn();
    const support = vi.fn(async () => connectSuccess(supported));
    const files = new MdbaseFileClient(() => ({ ...capability, actions: ["read"] }), request,
      undefined, undefined, resolveConnectTimeouts(), support);
    expect(await files.stat({ fileId })).toMatchObject({ ok: false, problem: { code: "not_authorized" } });
    expect(support).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it.each(["file_list_changed", "access_denied", "operation_invalid", "temporarily_unavailable"] as const)("preserves %s without inferring support from errors", async code => {
    const request = vi.fn(async () => { throw connectError(code, "Original error"); });
    expect(await client(request).stat({ fileId })).toMatchObject({ ok: false, problem: { code } });
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not dispatch a stat or legacy list when discovery fails", async () => {
    const request = vi.fn();
    const support = vi.fn(async () => connectFailure(connectError("access_denied", "Denied discovery").problem));
    const files = new MdbaseFileClient(() => capability, request, undefined, undefined, resolveConnectTimeouts(), support);
    expect(await files.stat({ fileId })).toMatchObject({ ok: false, problem: { code: "access_denied" } });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{}, { path: null }, { fileId: null }, { path: "" }, { fileId: "not-uuid" }, { path: "a.pdf", fileId }, { path: "a.pdf", extra: true }, { path: "../secret.pdf" }, { path: "/secret.pdf" }, { path: "Assets\\bad.pdf" }, { path: "Assets//bad.pdf" }, { path: "Assets/.hidden.pdf" }])("rejects malformed targets before discovery: %j", async target => {
    const request = vi.fn();
    expect(await client(request, true).stat(target as MdbaseFileStatTarget)).toMatchObject({ ok: false, problem: { code: "invalid_request" } });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{ protocol_version: 1, type: "file_stat" }, { protocol_version: 2, type: "file_stat", file: null }, { protocol_version: 1, type: "file_stat", file: {} }])("rejects malformed stat responses %j", async response => {
    const request = vi.fn(async () => response);
    expect(await client(request, true).stat({ fileId })).toMatchObject({ ok: false, problem: { code: "invalid_operation_response" } });
    expect(request).toHaveBeenCalledOnce();
  });
  it("cancellation stops legacy iteration and retains its typed cancellation outcome", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return { protocol_version: 1, type: "files_page", files: [descriptor], next: "never" }; });
    expect(await client(request).stat({ fileId }, { signal: controller.signal })).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(request).toHaveBeenCalledOnce();
  });
  it("uses one timeout budget for discovery and all fallback pages", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => new Promise(() => {}));
    const pending = client(request).stat({ fileId }, { timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toMatchObject({ ok: false, problem: { code: "timeout" } });
    expect(request).toHaveBeenCalledOnce();
  });
});
