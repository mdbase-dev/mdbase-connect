// @vitest-environment-options {"url": "https://editor.mdbase.dev/"}
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { isMdbaseError, type Mdbase } from "@mdbase-dev/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorMdbase, SdkEditorRoot, type EditorNativeScope } from "./SdkEditorRoot";
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

afterEach(() => { closeNativeFixtures(); vi.unstubAllGlobals(); });

function Capture({ scope, publish }: { scope: EditorNativeScope; publish(scope: EditorNativeScope): void }) {
  useEffect(() => { publish(scope); }, [scope, publish]);
  return <p role="status">Native test consumer</p>;
}

/** Counts live subscriptions through the public front door. */
function observed(mdbase: Mdbase) {
  const subscriptions = new Set<() => void>();
  const sdk: Mdbase = { ...mdbase, subscribe(listener) {
    const stop = mdbase.subscribe(listener);
    subscriptions.add(stop);
    return () => { subscriptions.delete(stop); stop(); };
  } };
  return { sdk, subscriptions };
}

const calls = (h: ReturnType<typeof applicationFixture>, action: string) => h.controls.observedActions().filter((call) => call.action === action);

describe("SdkEditorRoot behind the shared collection gate", () => {
  it("StrictMode starts the SDK and unmounting never closes it", async () => {
    const h = applicationFixture({ status: "not_started" });
    const { sdk, subscriptions } = observed(h.mdbase);
    const view = render(<StrictMode><SdkEditorRoot sdk={sdk} /></StrictMode>);
    await waitFor(() => expect(calls(h, "start").length).toBeGreaterThan(0));
    view.unmount();
    expect(subscriptions.size).toBe(0);
    expect(calls(h, "close")).toHaveLength(0);
  });

  it("signs out with signOut and never closes the shared entry", async () => {
    const h = applicationFixture({ status: "unselected", signIn: paired, collections: [{ collectionId: "c1", displayName: "Drafts", role: "owner" }] });
    const close = vi.spyOn(h.mdbase, "close");
    const native = vi.fn(() => <p>Never ready</p>);
    render(<SdkEditorRoot sdk={h.mdbase} renderNative={native} />);
    expect(await screen.findByText("Drafts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls(h, "signOut")).toHaveLength(1));
    expect(close).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("a refused registration logs only the developer detail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = applicationFixture({ status: "blocked", problem: "application_registration_refused",
      problemDetail: { name: "MdbaseError", code: "forbidden", registration: { code: "invalid_application_manifest", paths: ["/homepage"] } } });
    render(<SdkEditorRoot sdk={h.mdbase} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid manifest: /homepage")));
    expect(document.body).not.toHaveTextContent("/homepage");
    warn.mockRestore();
  });

  it("the gate hands the editor a gateway over the ready connection; losing readiness retires it", async () => {
    const h = await readyFixture({}, (replica) => replica.seed({ path: "notes/plan.md", frontmatter: { title: "Plan" }, body: "# Plan\n" }));
    const close = vi.spyOn(h.client, "close");
    const scopes: EditorNativeScope[] = [];
    const publish = (scope: EditorNativeScope) => scopes.push(scope);
    render(<StrictMode><SdkEditorRoot sdk={h.mdbase} renderNative={(scope) => <Capture scope={scope} publish={publish} />} /></StrictMode>);
    await screen.findByText("Native test consumer");
    const scope = scopes.at(-1);
    if (!scope) throw new Error("Missing native scope");
    expect(scope.connection.records).toBe(h.client);
    expect((await scope.gateway.read("notes/plan.md")).body).toBe("# Plan\n");
    await act(async () => h.publish({ status: "unselected", selectedCollectionId: null,
      selection: { state: "none", requested: { collectionId: null, source: "none", displayName: null, approved: false }, usable: null, problem: null } }));
    expect(screen.queryByText("Native test consumer")).toBeNull();
    await expect(scope.gateway.read("notes/plan.md")).rejects.toSatisfy((error: unknown) => isMdbaseError(error, "cancelled"));
    expect(close).not.toHaveBeenCalled();
    expect(h.metadata).not.toHaveBeenCalled();
  });

  it("opens the editor with the shared switcher in the rail, and switching selects through the SDK", async () => {
    const h = await readyFixture({}, (replica) => replica.seed({ path: "notes/plan.md", frontmatter: { title: "Plan" }, body: "# Plan\n\nNative body\n" }));
    h.publish({ collections: [...h.application.getSnapshot().collections, { collectionId: "archive-id", displayName: "Archive", role: "editor" }] });
    const { container } = render(<SdkEditorRoot sdk={h.mdbase} />);
    expect(await screen.findByRole("textbox", { name: "Note body" }, { timeout: 10_000 })).toHaveValue("Native body\n");
    const trigger = container.querySelector<HTMLButtonElement>(".collection-rail .mdbase-collections-trigger");
    if (!trigger) throw new Error("No collection switcher in the rail");
    expect(trigger).toHaveAccessibleName("Switch collection, current: Notes");
    fireEvent.click(trigger);
    const archive = [...document.querySelectorAll<HTMLElement>("[role=radio]")].find((row) => within(row).queryByText("Archive"));
    if (!archive) throw new Error("No Archive row in the switcher");
    fireEvent.click(archive);
    await waitFor(() => expect(calls(h, "select").at(-1)).toMatchObject({ collectionId: "archive-id" }));
  });
});

describe("createEditorMdbase", () => {
  it("constructs on the editor's own origin without allocating a Worker or claiming READY", () => {
    const worker = vi.fn();
    const channel = vi.fn();
    vi.stubGlobal("Worker", worker);
    vi.stubGlobal("MessageChannel", channel);
    const sdk = createEditorMdbase({ origin: location.origin, environment: "lab" });
    expect(sdk.connection("any")).toBeNull();
    expect(sdk.getSnapshot()).toMatchObject({ status: "not_started", problem: null, selection: { state: "none" }, readiness: { assessment: null } });
    expect(worker).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
  });
});
