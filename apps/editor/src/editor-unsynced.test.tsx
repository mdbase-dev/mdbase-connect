// @vitest-environment-options {"url": "https://editor.mdbase.dev/"}
import { createMdbase } from "@mdbase-dev/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createEditorMdbase, SdkEditorRoot } from "./SdkEditorRoot";
import { editorUnsyncedEnabled } from "./editor-unsynced";
import { fireEvent, render, screen, waitFor } from "./test/locale";
import { closeNativeFixtures, testApp } from "./test/native-fixture";

vi.mock("@mdbase-dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mdbase-dev/sdk")>();
  return { ...actual, createMdbase: vi.fn(actual.createMdbase) };
});

afterEach(() => { closeNativeFixtures(); vi.clearAllMocks(); });

it("keeps work before connecting disabled until the SDK signed-out flow is fixed", () => {
  expect(editorUnsyncedEnabled()).toBe(false);
});

it("constructs the default Editor entry without automatic unsynced startup", () => {
  createEditorMdbase({ origin: location.origin, environment: "production" });
  expect(createMdbase).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origin: location.origin }), {
    privateCollections: true, unsynced: false
  });
});

it("defaults to Sign in signed out without offering Continue without connecting", async () => {
  const fixture = await testApp({ phase: "signed_out" });
  render(<SdkEditorRoot sdk={fixture.mdbase} />);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Continue without connecting" })).toBeNull();
  expect(fixture.calls("openUnsynced")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(fixture.calls("authorize")).toHaveLength(1));
});
