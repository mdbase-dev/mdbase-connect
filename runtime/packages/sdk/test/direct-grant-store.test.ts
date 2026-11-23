import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectDirect, createDirectGrantStore, directBackendOrigin } from "../src/direct.js";

import { bundle, firstSlot, pin, server as invitation, slotMs, token as pinnedToken } from "./direct-calendar.fixture.js";

const grant = { server: "https://collection.example:9443", token: "c".repeat(64) };
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("location", { origin: "https://ui.example" });
});
afterEach(() => vi.unstubAllGlobals());

it("persists one encrypted grant and keeps explicit app stores independent", async () => {
  const store = createDirectGrantStore("editor");
  const receipt = await store.save(grant);
  expect(await createDirectGrantStore("editor").read()).toEqual({ ...grant, receipt });
  expect(await createDirectGrantStore("tasknotes").read()).toBeUndefined();
  await expect(store.save({ ...grant, token: "d".repeat(64) })).rejects.toThrow();
  await store.forget("stale");
  expect((await store.read())?.receipt).toBe(receipt);
  await store.forget(receipt);
  const replacement = await store.save(grant);
  await store.forget(receipt);
  expect((await store.read())?.receipt).toBe(replacement);
  await store.forget();
  expect(await store.read()).toBeUndefined();
});


it.each([
  [grant.server, "https://other.example"],
  [invitation, invitation.replace(pin, "ee".repeat(32))],
  [invitation, "https://192.168.1.2"],
])("rejects ciphertext moved from %s to %s", async (server, other) => {
  const store = createDirectGrantStore("tasknotes");
  await store.save({ server, token: server === invitation ? pinnedToken : grant.token });
  const open = indexedDB.open("mdbase-direct:tasknotes");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const tx = db.transaction("grant", "readwrite"), table = tx.objectStore("grant");
    const request = table.get("browser");
    const sealed = await new Promise((resolve, reject) => {
      request.onsuccess = () => { resolve(request.result); table.put({ ...request.result, server: other }, "browser"); };
      request.onerror = () => reject(request.error);
    });
    expect(sealed).toMatchObject({ key: { extractable: false, algorithm: { name: "AES-GCM" } } });
    expect(Object.keys(sealed as object).sort()).toEqual(["ciphertext", "iv", "key", "receipt", "server"]);
    await expect(store.read()).rejects.toThrow();
    await store.forget();
  } finally { db.close(); }
});

it("refuses to persist invalid inputs", async () => {
  expect(() => createDirectGrantStore(" ")).toThrow();
  const store = createDirectGrantStore("editor");
  await expect(store.save({ ...grant, token: "12345678" })).rejects.toMatchObject({ code: "unauthenticated" });
  await expect(store.save({ ...grant, server: "https://tasks.mdbase.dev" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(await store.read()).toBeUndefined();
});

it.each(["https://tasknotes.dev", "https://app.tasknotes.dev./", "https://cloud.mdbase.dev", "https://a.tasknotes-app.pages.dev", "https://mdbase-connect-candidate-b.onrender.com", "https://["])("refuses managed or malformed backend %s", server => {
  expect(() => directBackendOrigin(server)).toThrow();
});

it("normalizes the bare backend origin before storing or connecting", () => {
  expect(directBackendOrigin("https://COLLECTION.Example:443/")).toBe("https://collection.example");
});

it("replaces the enrollment descriptor only after forgetting its receipt", async () => {
  const store = createDirectGrantStore("editor");
  const original = { token: pinnedToken, server: invitation };
  const server = invitation.replace(pin, "ee".repeat(32));
  const rotated = { server, token: JSON.stringify([server, bundle.replace(pin, "ee".repeat(32))]) };
  const receipt = await store.save(original);
  await expect(store.save(rotated)).rejects.toThrow();
  expect(await store.read()).toEqual({ ...original, receipt });
  await store.forget(receipt);
  const next = await store.save(rotated);
  await store.forget(receipt);
  expect(await store.read()).toEqual({ ...rotated, receipt: next });
});

it("retains the encrypted pinned grant on clock and network failure", async () => {
  const store = createDirectGrantStore("editor");
  const receipt = await store.save({ server: invitation, token: pinnedToken });
  const saved = (await store.read())!;
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await expect(connectDirect({ ...saved, app: { name: "test", version: "1" } })).rejects.toMatchObject({ code: "unavailable" });
    now.mockReturnValue(firstSlot * slotMs);
    vi.stubGlobal("WebTransport", undefined);
    await expect(connectDirect({ ...saved, app: { name: "test", version: "1" } })).rejects.toMatchObject({ code: "unavailable" });
    expect(await store.read()).toEqual({ server: invitation, token: pinnedToken, receipt });
  } finally { now.mockRestore(); }
});

it.each([
  [invitation, grant.token], [invitation, bundle], [grant.server, pinnedToken],
  [invitation.replace(":443", ":8443"), pinnedToken], [invitation.replace(pin, grant.token), pinnedToken],
])("refuses to store mixed grants", async (server, token) => {
  const store = createDirectGrantStore("editor");
  await expect(store.save({ server, token })).rejects.toMatchObject({ code: "unauthenticated" });
  expect(await store.read()).toBeUndefined();
});
