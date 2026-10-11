import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppWebSignInSnapshot } from "@mdbase-dev/sdk/app-host";
import { ConnectScreen } from "./ConnectionScreens";
import { App } from "./App";
import type { CollectionGateway } from "./model";
import { SignInTabBlocked } from "./native-signin-ui";
import type { NativeSignInBinding } from "./native-signin-ui";

afterEach(cleanup);
let key = 0;
function binding(initial: Partial<AppWebSignInSnapshot> = {}) {
  let snapshot: AppWebSignInSnapshot = { status: "signed_out", signIn: null, collections: [], selectedCollectionId: null, problem: null, timing: null, ...initial };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<AppWebSignInSnapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const result: NativeSignInBinding = {
    viewKey: ++key, portal: { reserve: vi.fn(), open: vi.fn(), cancel: vi.fn() },
    session: {
      getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      start: vi.fn(async () => snapshot), authorize: vi.fn(async () => { publish({ status: "authorizing" }); return snapshot; }),
      renewExpiredPairing: vi.fn(async () => { publish({ problem: null }); return snapshot; }),
      forget: vi.fn(async () => snapshot), close: vi.fn(async () => { publish({ status: "closed", signIn: null }); }), setForeground: vi.fn(),
    },
  };
  return { result, publish };
}
const paired: NonNullable<AppWebSignInSnapshot["signIn"]> = {
  requestId: "request", installationId: "installation", deviceId: "device", appId: "app", kind: "app-runtime", verificationUri: "https://mdbase.test/approve", state: "paired", accountId: "account", accountEmail: "editor@example.test", collectionIds: [], createCollections: false, requestedCreateCollections: false,
};
function mount(result: NativeSignInBinding, onSignedOut = vi.fn()) {
  return render(<ConnectScreen nativeSignIn={{ binding: result, onSignedOut }} />);
}
it("native App binding never initializes the legacy gateway or invents a legacy snapshot", () => {
  const gateway = new Proxy({} as CollectionGateway, { get() { throw new Error("Legacy gateway must not be used by native sign-in"); } });
  const h = binding(); const view = render(<App nativeSignIn={{ binding: h.result, onSignedOut: vi.fn() }} />);
  expect(screen.getByRole("button", { name: /^Sign in$/ })).toBeTruthy();
  view.rerender(<App gateway={gateway} nativeSignIn={{ binding: h.result, onSignedOut: vi.fn() }} />);
  expect(screen.getByRole("button", { name: /^Sign in$/ })).toBeTruthy();
});
it("a blocked popup has a user action and does not start SDK authorization", async () => {
  const h = binding(); vi.mocked(h.result.portal.reserve).mockImplementation(() => { throw new SignInTabBlocked(); }); mount(h.result);
  fireEvent.click(screen.getByRole("button", { name: /^Sign in$/ }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Your browser blocked the sign-in tab."));
  expect(screen.getByRole("button", { name: "Open sign-in" })).toBeTruthy(); expect(h.result.session.authorize).not.toHaveBeenCalled();
});
it("one expired retry reserves before asynchronous SDK renewal", async () => {
  const h = binding({ status: "blocked", problem: "expired" }); mount(h.result);
  fireEvent.click(screen.getByRole("button", { name: /^Sign in$/ }));
  await waitFor(() => expect(h.result.session.authorize).toHaveBeenCalledOnce());
  expect(vi.mocked(h.result.portal.reserve).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(h.result.session.renewExpiredPairing).mock.invocationCallOrder[0]!);
});
it("one Sign in gesture reserves the popup before SDK authorization", async () => {
  const h = binding(); mount(h.result);
  fireEvent.click(screen.getByRole("button", { name: /^Sign in$/ }));
  await waitFor(() => expect(h.result.session.authorize).toHaveBeenCalledOnce());
  expect(vi.mocked(h.result.portal.reserve).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(h.result.session.authorize).mock.invocationCallOrder[0]!);
  expect(screen.getByRole("status").textContent).toBe("Waiting for approval in the mdbase tab…");
});
it("paired authorizing stays open; approval publication closes the popup and shows real email", async () => {
  const h = binding({ status: "authorizing", signIn: paired }); mount(h.result);
  expect(h.result.portal.cancel).not.toHaveBeenCalled();
  await act(async () => h.publish({ status: "unselected" }));
  expect(h.result.portal.cancel).toHaveBeenCalledOnce();
  expect(screen.getByText("Signed in as editor@example.test")).toBeTruthy();
  expect(screen.getByText("Opening collections isn't available in this build yet.")).toBeTruthy();
  expect(h.result.session.authorize).not.toHaveBeenCalled();
});
it.each(["unselected", "opening", "setup_required", "ready", "blocked", "closed"] as const)("cleans up own popup at %s, never borrowed SDK on teardown", async (status) => {
  const h = binding({ status: "authorizing", signIn: paired }); const view = mount(h.result);
  await act(async () => h.publish({ status })); expect(h.result.portal.cancel).toHaveBeenCalledOnce();
  view.unmount(); expect(h.result.session.close).not.toHaveBeenCalled();
});
it("sign-out callback waits for successful SDK close; failed close is not sign-out", async () => {
  const h = binding({ status: "unselected", signIn: paired }); const onSignedOut = vi.fn();
  vi.mocked(h.result.session.close).mockRejectedValueOnce(new Error("private diagnostic"));
  let finish!: () => void; vi.mocked(h.result.session.close).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mount(h.result, onSignedOut);
  fireEvent.click(screen.getByRole("button", { name: /^Sign out$/ }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Sign-in was interrupted. Please try again."));
  expect(onSignedOut).not.toHaveBeenCalled(); expect(screen.queryByText("private diagnostic")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Sign out$/ })); expect(onSignedOut).not.toHaveBeenCalled();
  await act(async () => finish()); expect(onSignedOut).toHaveBeenCalledOnce();
});
it("forgets the SDK's original selected ID and cancels only owned popup on unmount", async () => {
  const h = binding({ status: "unselected", signIn: paired, selectedCollectionId: "original-selected" }); const view = mount(h.result);
  fireEvent.click(screen.getByRole("button", { name: "Forget collection" }));
  await waitFor(() => expect(h.result.session.forget).toHaveBeenCalledWith("original-selected"));
  view.unmount(); expect(h.result.session.close).not.toHaveBeenCalled();
});
it("retired action cannot publish sign-out into replacement UI", async () => {
  const first = binding({ status: "unselected", signIn: paired }); let finish!: () => void;
  vi.mocked(first.result.session.close).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onSignedOut = vi.fn(); const view = mount(first.result, onSignedOut);
  fireEvent.click(screen.getByRole("button", { name: /^Sign out$/ }));
  const next = binding(); view.rerender(<ConnectScreen nativeSignIn={{ binding: next.result, onSignedOut }} />);
  await act(async () => finish()); expect(onSignedOut).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^Sign in$/ })).toBeTruthy();
  expect(first.result.portal.cancel).toHaveBeenCalled(); expect(next.result.portal.reserve).not.toHaveBeenCalled();
});
