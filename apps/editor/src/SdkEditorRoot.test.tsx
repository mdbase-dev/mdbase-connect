import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { isMdbaseError } from "@mdbase-dev/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorApplication, SdkEditorRoot, type EditorNativeScope } from "./SdkEditorRoot";
import { applicationFixture, closeNativeFixtures, paired, readyFixture } from "./test/native-fixture";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label, readOnly, footer }: { value: string; onChange?: (value: string) => void; label: string; readOnly?: boolean; footer?: ReactNode }) =>
    <><textarea aria-label={label} readOnly={readOnly} value={value} onChange={(event) => onChange?.(event.target.value)} />{footer}</>
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
  })
}));

afterEach(() => closeNativeFixtures());

function Capture({ scope, publish }: { scope: EditorNativeScope; publish(scope: EditorNativeScope): void }) {
  useEffect(() => { publish(scope); }, [scope, publish]);
  return <p role="status">Native test consumer</p>;
}

/** Public subscription instrumentation only; state and actions stay SDK-fixture owned. */
function observed(fixture: ReturnType<typeof applicationFixture>) {
  const subscriptions = new Set<() => void>();
  const application = {
    ...fixture.application,
    subscribe(listener: () => void) {
      const stop = fixture.application.subscribe(listener);
      subscriptions.add(stop);
      return () => { subscriptions.delete(stop); stop(); };
    }
  };
  return { sdk: { ...fixture.entry, application: () => application }, subscriptions };
}

describe("SdkEditorRoot over the public SDK fixture", () => {
  it("StrictMode starts once, aborts the caller signal on unmount and never closes the SDK", async () => {
    const h = applicationFixture({ status: "not_started" });
    const { sdk, subscriptions } = observed(h);
    const view = render(<StrictMode><SdkEditorRoot sdk={sdk} /></StrictMode>);
    await waitFor(() => expect(h.controls.observedActions().filter((call) => call.action === "start")).toHaveLength(1));
    const signal = h.controls.observedActions().find((call) => call.action === "start")?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(subscriptions.size).toBe(0);
    expect(h.controls.observedActions().some((call) => call.action === "close")).toBe(false);
  });

  it("sign in calls SDK authorize in the gesture and opens no app popup", () => {
    const h = applicationFixture();
    const open = vi.spyOn(window, "open");
    render(<SdkEditorRoot sdk={h.entry} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(h.controls.observedActions().filter((call) => call.action === "authorize")).toHaveLength(1);
    expect(h.controls.observedActions().some((call) => call.action === "start")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("shows the SDK account and selects the original collection ID", () => {
    const h = applicationFixture({ status: "unselected", signIn: paired, collections: [{ collectionId: "selected-id", displayName: "Notes", role: "owner" }] });
    render(<SdkEditorRoot sdk={h.entry} />);
    expect(screen.getByText("Signed in as editor-user on GitHub")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(h.controls.observedActions().find((call) => call.action === "select")).toMatchObject({ collectionId: "selected-id", signal: expect.any(AbortSignal) });
    expect(screen.queryByText(/fixture-account/)).toBeNull();
  });

  it("a failed close does not report sign-out or leak its detail", async () => {
    const h = applicationFixture({ status: "unselected", signIn: paired });
    const signedOut = vi.fn();
    h.controls.setHandler("close", () => { throw new Error("private-detail"); });
    render(<SdkEditorRoot sdk={h.entry} onSignedOut={signedOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("alert");
    expect(signedOut).not.toHaveBeenCalled();
    expect(screen.queryByText("private-detail")).toBeNull();
  });

  it("a late close on a retired owner cannot sign out its replacement", async () => {
    const h = applicationFixture({ status: "unselected", signIn: paired });
    const { sdk, subscriptions } = observed(h);
    const next = applicationFixture();
    const signedOut = vi.fn();
    let finish!: () => void;
    h.controls.setHandler("close", () => new Promise<void>((resolve) => { finish = resolve; }));
    const view = render(<SdkEditorRoot sdk={sdk} onSignedOut={signedOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    view.rerender(<SdkEditorRoot sdk={next.entry} onSignedOut={signedOut} />);
    await act(async () => finish());
    expect(signedOut).not.toHaveBeenCalled();
    expect(subscriptions.size).toBe(0);
  });

  it("the unavailable shell offers no sign-in, setup or editor", () => {
    const h = applicationFixture({ status: "blocked", problem: "application_not_yet_available" });
    render(<SdkEditorRoot sdk={h.entry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("isn't available");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up mdbase editor" })).toBeNull();
  });

  it("setup delegates to SDK configure without treating its success as ready", async () => {
    const h = applicationFixture({ status: "setup_required" });
    const native = vi.fn(() => <p>Never ready</p>);
    render(<SdkEditorRoot sdk={h.entry} renderNative={native} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up mdbase editor" }));
    await waitFor(() => expect(h.controls.observedActions().some((call) => call.action === "configure")).toBe(true));
    expect(native).not.toHaveBeenCalled();
  });

  it("ready hands the editor a gateway over the same client; losing readiness retires it", async () => {
    const h = await readyFixture({}, (replica) => replica.seed({ path: "notes/plan.md", frontmatter: { title: "Plan" }, body: "# Plan\n" }));
    const close = vi.spyOn(h.client, "close");
    const scopes: EditorNativeScope[] = [];
    const publish = (scope: EditorNativeScope) => scopes.push(scope);
    render(<StrictMode><SdkEditorRoot sdk={h.entry} renderNative={(scope) => <Capture scope={scope} publish={publish} />} /></StrictMode>);
    await screen.findByText("Native test consumer");
    const scope = scopes.at(-1);
    if (!scope) throw new Error("Missing native scope");
    expect(scope.connection.records).toBe(h.client);
    expect((await scope.gateway.read("notes/plan.md")).body).toBe("# Plan\n");
    await act(async () => h.publish({ readiness: { ...h.application.getSnapshot().readiness, checking: true, assessment: null } }));
    expect(screen.queryByText("Native test consumer")).toBeNull();
    await expect(scope.gateway.read("notes/plan.md")).rejects.toSatisfy((error: unknown) => isMdbaseError(error, "cancelled"));
    expect(close).not.toHaveBeenCalled();
    expect(h.metadata).not.toHaveBeenCalled();
  });

  it("unknown readiness and a retired connection never render the native editor", async () => {
    const h = await readyFixture();
    const native = vi.fn(() => <p>Not permitted</p>);
    h.current.mockReturnValue(false);
    const view = render(<SdkEditorRoot sdk={h.entry} renderNative={native} />);
    await act(async () => undefined);
    expect(native).not.toHaveBeenCalled();
    h.current.mockReturnValue(true);
    await act(async () => h.publish({ readiness: { ...h.application.getSnapshot().readiness, assessment: null } }));
    view.rerender(<SdkEditorRoot sdk={h.entry} renderNative={native} />);
    await act(async () => undefined);
    expect(native).not.toHaveBeenCalled();
  });

  it("ready opens the existing editor over the native gateway and switches collection through the SDK", async () => {
    const h = await readyFixture({}, (replica) => {
      replica.seed({ path: "notes/plan.md", frontmatter: { title: "Plan" }, body: "# Plan\n\nNative body\n" });
    });
    const close = vi.spyOn(h.client, "close");
    render(<SdkEditorRoot sdk={h.entry} />);
    expect(await screen.findByRole("textbox", { name: "Note body" }, { timeout: 10_000 })).toHaveValue("Native body\n");
    expect(screen.getAllByText("Plan").length).toBeGreaterThan(0);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("createEditorApplication", () => {
  it("builds the public declaration from the checked-in manifest and stays an explicit unavailable shell", () => {
    const sdk = createEditorApplication({ registeredApplicationId: "dev.mdbase.editor", environment: "lab" });
    expect(sdk.connection("any")).toBeNull();
    render(<SdkEditorRoot sdk={sdk} />);
    expect(screen.queryByRole("textbox", { name: "Note body" })).toBeNull();
  });
});
