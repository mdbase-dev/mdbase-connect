// @vitest-environment-options {"url": "https://editor-staging.mdbase.dev/"}
// Editor contract tests: real public grant crypto/storage, scripted CP, public
// SDK account-view fixture. NOT actual Worker sign-out/wipe/native admission.
// Muse's SDK cleanup and bound-inventory proofs remain separate release gates.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Mdbase } from "@mdbase-dev/sdk";
import { MdbaseAppGrants } from "@mdbase-dev/sdk/app-grant";
import { afterEach, expect, it, vi } from "vitest";
import { createEditorMdbase, SdkEditorRoot } from "./SdkEditorRoot";
import type { PrivateCollections } from "./private-collections";
import { closeNativeFixtures, testApp } from "./test/native-fixture";
import { ACCOUNT_A, ACCOUNT_B, PRIVATE_A, PRIVATE_B, NAME_A, NAME_B, deferred, privateGrantScript, type Completion } from "./test/private-grant-script";

type GrantOptions = ConstructorParameters<typeof MdbaseAppGrants>[0];
const injected = vi.hoisted(() => ({
  sdk: null as Mdbase | null,
  grant: null as Pick<GrantOptions, "store" | "fetch" | "callbacks"> | null,
  options: [] as Array<{ privateCollections?: boolean }>,
  connect: vi.fn(async () => { throw new Error("Unexpected raw Editor data-open attempt"); })
}));
vi.mock("@mdbase-dev/sdk", async (original) => {
  const actual = await original<typeof import("@mdbase-dev/sdk")>();
  return { ...actual, connect: injected.connect,
    createMdbase: vi.fn((_declaration, options = {}) => {
      if (!injected.sdk) throw new Error("Missing SDK account fixture");
      injected.options.push(options);
      return injected.sdk;
    })
  };
});
vi.mock("@mdbase-dev/sdk/app-grant", async (original) => {
  const actual = await original<typeof import("@mdbase-dev/sdk/app-grant")>();
  return { ...actual, MdbaseAppGrants: class extends actual.MdbaseAppGrants {
    constructor(options: GrantOptions) {
      if (!injected.grant) throw new Error("Missing isolated grant dependencies");
      super({ ...options, ...injected.grant });
    }
  } };
});
afterEach(() => {
  closeNativeFixtures(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
  injected.sdk = null; injected.grant = null; injected.options.length = 0;
});

async function setup() {
  const script = await privateGrantScript();
  injected.grant = script.options;
  const h = await testApp({ collections: [{ id: PRIVATE_A, name: NAME_A }], phase: "choosing" });
  const paired = h.mdbase.getSnapshot();
  if (!paired.signIn) throw new Error("Missing paired fixture account");
  const publish = (account: string, nativeGrants: readonly Completion[]) => {
    h.controls.publishSnapshot({ ...paired,
      signIn: { ...paired.signIn!, accountId: account, nativeGrants },
      collections: account === ACCOUNT_A ? paired.collections : [
        { collectionId: PRIVATE_B, displayName: NAME_B, role: "owner",
          ...(nativeGrants.some((grant) => grant.collection_id === PRIVATE_B)
            ? { kind: "private" as const, availability: { state: "available" as const } } : {}) }
      ]
    });
  };
  const mount = () => {
    injected.sdk = h.mdbase;
    const sdk = createEditorMdbase({ origin: location.origin, environment: script.declaration.environment });
    return render(<SdkEditorRoot sdk={sdk} renderNative={() => <p>Unexpected A data view</p>} />);
  };
  const connectors = vi.spyOn(MdbaseAppGrants.prototype, "connector");
  const authorizations = vi.spyOn(MdbaseAppGrants.prototype, "authorize");
  return { script, h, publish, mount, connectors, authorizations };
}

async function positiveA(f: Awaited<ReturnType<typeof setup>>) {
  const original = await f.script.begin();
  const completed = await original.finish;
  const completion = completed.nativeCompletion;
  if (!completion) throw new Error("Missing genuine completion");
  expect(await original.grants.verifiedStoredNativeGrant(completion)).toBe(true);
  expect(await original.grants.collections({ bindings: [completion] })).toContainEqual(expect.objectContaining({ collectionId: PRIVATE_A }));
  f.publish(ACCOUNT_A, [completion]);
  const view = f.mount();
  expect((await screen.findAllByText(NAME_A)).length).toBeGreaterThan(0);
  expect(injected.options.at(-1)).toMatchObject({ privateCollections: true });
  expect(screen.queryByRole("region", { name: "Private collections" })).toBeNull();
  return { ...original, completion, view };
}

async function assertBIsolation(f: Awaited<ReturnType<typeof setup>>, nativeGrants: readonly Completion[] = []) {
  await act(async () => { f.publish(ACCOUNT_B, nativeGrants); });
  await screen.findByText(NAME_B); // trusted account fixture stays usable, not hide-all
  if (nativeGrants.some((grant) => grant.collection_id === PRIVATE_B)) {
    expect(f.h.mdbase.getSnapshot().collections.find((item) => item.collectionId === PRIVATE_B)).toMatchObject({ kind: "private" });
  }
  expect(screen.queryByRole("region", { name: "Private collections" })).toBeNull();
  const stale = screen.queryByRole("button", { name: new RegExp(`^${NAME_A}`) });
  if (stale) {
    // A transport rejection is NOT an account-denial proof: record whether the
    // Editor even attempted the raw connector/data-open before asserting zero.
    await act(async () => { fireEvent.click(stale); });
    await waitFor(() => expect(injected.connect).toHaveBeenCalled());
  }
  expect(await f.script.backing.getGrant(PRIVATE_A)).toBeDefined(); // filtering never deletes residual authority
  expect(f.connectors).not.toHaveBeenCalled();
  expect(injected.connect).not.toHaveBeenCalled();
  expect(screen.queryAllByText(NAME_A)).toHaveLength(0);
  expect(screen.queryByText("Unexpected A data view")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add a Private collection" })).toBeNull();
  expect(f.authorizations).not.toHaveBeenCalled();
  expect(injected.options.at(-1)).toMatchObject({ privateCollections: true });
  // Real SDK expected-account validation refuses an A completion offered to B,
  // before persisting any replacement authority; no fake server B rejection.
  const held = await f.script.backing.getGrant(PRIVATE_A);
  const mismatch = await f.script.begin(ACCOUNT_B, PRIVATE_A, ACCOUNT_A);
  await expect(mismatch.finish).rejects.toMatchObject({ code: "unauthenticated" });
  expect(await f.script.backing.getGrant(PRIVATE_A)).toEqual(held);
  // The canonical action must survive the gate flag; removing every Add button
  // is not a shippable isolation fix. It forwards an untargeted SDK approval.
  const add = screen.getByRole("button", { name: /^Add a collection/ });
  expect(add).toBeVisible();
  fireEvent.click(add);
  await waitFor(() => expect(f.h.calls("approve")).toHaveLength(1));
  expect(f.h.calls("approve").at(-1)?.collectionId ?? null).toBeNull();
  expect(f.authorizations).not.toHaveBeenCalled();
}

it("isolates B after a sign-out notification even if A authority remains in browser storage", async () => {
  const f = await setup();
  await positiveA(f);
  // This is the PUBLIC account-view fixture, not the actual SDK wipe routine.
  await act(async () => { await f.h.mdbase.signOut(); });
  expect(await f.script.backing.getGrant(PRIVATE_A)).toBeDefined();
  await assertBIsolation(f);
});

it("isolates B after a real SDK forget throws while preserving B's own bound approval", async () => {
  const f = await setup();
  const a = await positiveA(f);
  const b = await f.script.begin(ACCOUNT_B, PRIVATE_B);
  const completion = (await b.finish).nativeCompletion;
  if (!completion) throw new Error("Missing B completion");
  expect(await b.grants.verifiedStoredNativeGrant(completion)).toBe(true);
  // A belongs only to A in this scenario. B's actual token sees only B; the
  // unsafe raw route instead picks the first retained token (A's).
  const bound = await b.grants.collections({ bindings: [completion] });
  expect(bound).toContainEqual(expect.objectContaining({ collectionId: PRIVATE_B }));
  expect(bound.some((item) => item.collectionId === PRIVATE_A)).toBe(false);
  const failure = new Error("fixture deletion refused");
  f.script.store.deleteGrant = vi.fn(async () => { throw failure; });
  await expect(a.grants.forget(PRIVATE_A)).rejects.toBe(failure);
  expect(await f.script.backing.getGrant(PRIVATE_A)).toBeDefined();
  await act(async () => { await f.h.mdbase.signOut(); });
  await assertBIsolation(f, [completion]);
});

it("isolates B after real credential persistence and page reconstruction before completion publication", async () => {
  const f = await setup();
  const persisted = deferred<void>();
  const release = deferred<void>();
  f.script.pauseNextWrite(async () => { persisted.resolve(); await release.promise; });
  const a = await f.script.begin();
  await persisted.promise;
  expect(await f.script.backing.getGrant(PRIVATE_A)).toBeDefined();
  expect(await a.grants.verifiedStoredNativeGrant(f.script.completion())).toBe(true);
  f.publish(ACCOUNT_A, []); // no protected reference has been published
  a.prepared.cancel();
  release.resolve();
  await expect(a.finish).rejects.toMatchObject({ code: "cancelled" });
  // A fresh production adapter instance is constructed over the SAME store.
  f.publish(ACCOUNT_B, []);
  f.mount();
  await assertBIsolation(f);
});

it("ignores custom grant adapters outside isolated test builds", async () => {
  const h = await testApp({ collections: [{ name: "SDK-owned notes" }], phase: "choosing" });
  const forbidden = vi.fn((): never => { throw new Error("A production custom grant adapter was accessed"); });
  const adapter: PrivateCollections = { collections: forbidden, authorize: forbidden, waitForAvailable: forbidden,
    open: forbidden, forget: forbidden, merge: forbidden };
  vi.stubEnv("MODE", "production");
  render(<SdkEditorRoot sdk={h.mdbase} privateCollections={adapter} />);
  await screen.findByText("SDK-owned notes");
  expect(forbidden).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Private collections" })).toBeNull();
});
