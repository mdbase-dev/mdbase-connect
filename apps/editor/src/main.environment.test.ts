import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createEditorMdbase, renderRoot } = vi.hoisted(() => ({ createEditorMdbase: vi.fn(() => ({})), renderRoot: vi.fn() }));
vi.mock("./SdkEditorRoot", () => ({ createEditorMdbase, SdkEditorRoot: () => null }));
vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => ({ render: renderRoot })) }));

beforeEach(() => {
  vi.resetModules();
  createEditorMdbase.mockClear(); renderRoot.mockClear();
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubEnv("VITE_MDBASE_EDITOR_DEMO", "0");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

// Exercise the actual entry's choice and declaration, not a copied selector.
// SDK registration/authentication and native admission are outside this double.
describe("native Editor target entry", () => {
  it("defaults the ordinary non-demo build to production", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_MDBASE_ENV", undefined);
    vi.stubGlobal("location", new URL("https://editor.mdbase.dev"));
    await import("./main");
    expect(createEditorMdbase).toHaveBeenCalledExactlyOnceWith({
      origin: "https://editor.mdbase.dev", environment: "production",
    });
    expect(renderRoot).toHaveBeenCalledOnce();
  });
  it.each([
    ["staging", "https://editor-staging.mdbase.dev"],
    ["production", "https://editor.mdbase.dev"],
    ["lab", "http://127.0.0.1:48219"],
  ])("selects the native SDK for %s without a legacy entry", async (environment, origin) => {
    vi.stubEnv("VITE_MDBASE_ENV", environment);
    vi.stubGlobal("location", new URL(origin));
    await import("./main");
    expect(createEditorMdbase).toHaveBeenCalledExactlyOnceWith({ origin, environment });
    expect(renderRoot).toHaveBeenCalledOnce();
  });
  it.each([
    ["staging", "https://editor.mdbase.dev"],
    ["staging", "http://127.0.0.1:48219"],
    ["production", "https://editor-staging.mdbase.dev"],
    ["production", "http://editor.mdbase.dev"],
    ["unknown", "https://editor-staging.mdbase.dev"],
  ])("refuses %s at %s before constructing the SDK", async (environment, origin) => {
    vi.stubEnv("VITE_MDBASE_ENV", environment);
    vi.stubGlobal("location", new URL(origin));
    await expect(import("./main")).rejects.toThrow(/environment|origin/);
    expect(createEditorMdbase).not.toHaveBeenCalled();
    expect(renderRoot).not.toHaveBeenCalled();
  });
  it("preserves the explicit demo-only E2E entry at loopback without constructing a native SDK", async () => {
    vi.stubEnv("VITE_MDBASE_ENV", "production");
    vi.stubEnv("VITE_MDBASE_EDITOR_DEMO", "1");
    vi.stubGlobal("location", new URL("http://127.0.0.1:42873/?demo=12"));
    await import("./main");
    expect(createEditorMdbase).not.toHaveBeenCalled();
    expect(renderRoot).toHaveBeenCalledOnce();
  });
  it.each([["0", "?demo=12"], ["1", ""]])("does not exempt the native entry for demo flag %s and query %s", async (flag, query) => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_MDBASE_ENV", "production");
    vi.stubEnv("VITE_MDBASE_EDITOR_DEMO", flag);
    vi.stubGlobal("location", new URL(`http://127.0.0.1:42873/${query}`));
    await expect(import("./main")).rejects.toThrow(/origin/);
    expect(createEditorMdbase).not.toHaveBeenCalled();
    expect(renderRoot).not.toHaveBeenCalled();
  });
});
