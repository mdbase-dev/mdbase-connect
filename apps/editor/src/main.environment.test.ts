import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createEditorMdbase, renderRoot, appChunk, codeEditorChunk } = vi.hoisted(() => ({ createEditorMdbase: vi.fn(() => ({})), renderRoot: vi.fn(),
  appChunk: vi.fn(() => ({ App: () => null })), codeEditorChunk: vi.fn(() => ({ CodeEditor: () => null })) }));
vi.mock("./SdkEditorRoot", () => ({ createEditorMdbase, SdkEditorRoot: () => null }));
vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => ({ render: renderRoot })) }));

beforeEach(() => {
  vi.resetModules();
  createEditorMdbase.mockClear(); renderRoot.mockClear(); appChunk.mockClear(); codeEditorChunk.mockClear();
  // Registered per test: a mocked module is evaluated once per registration.
  vi.doMock("./App", () => appChunk());
  vi.doMock("./CodeEditor", () => codeEditorChunk());
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
  ])("refuses %s at %s before constructing the SDK", async (environment, origin) => {
    vi.stubEnv("VITE_MDBASE_ENV", environment);
    vi.stubGlobal("location", new URL(origin));
    await import("./main");
    expect(createEditorMdbase).not.toHaveBeenCalled();
    expect(renderRoot).toHaveBeenCalledOnce();
  });
  it("keeps an unknown configured environment an invariant failure", async () => {
    vi.stubEnv("VITE_MDBASE_ENV", "unknown");
    vi.stubGlobal("location", new URL("https://editor.mdbase.dev"));
    await expect(import("./main")).rejects.toThrow(/environment/);
    expect(createEditorMdbase).not.toHaveBeenCalled();
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
    await import("./main");
    expect(createEditorMdbase).not.toHaveBeenCalled();
    expect(renderRoot).toHaveBeenCalledOnce();
  });
});

// The SDK double never opens, and the root renders nothing: a chunk requested
// here was started at module load, independent of the collection opening.
describe("editor chunk preload", () => {
  // A mocked module resolves asynchronously; a refused page gets the same
  // window to (wrongly) request one.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  it.each([
    ["the native SDK", "production", "https://editor.mdbase.dev/", "0"],
    ["the demo entry", "production", "http://127.0.0.1:42873/?demo=12", "1"],
  ])("starts the editor chunks before anything renders on %s", async (_entry, environment, href, demo) => {
    vi.stubEnv("VITE_MDBASE_ENV", environment);
    vi.stubEnv("VITE_MDBASE_EDITOR_DEMO", demo);
    vi.stubGlobal("location", new URL(href));
    await import("./main");
    await vi.waitFor(() => {
      expect(appChunk).toHaveBeenCalledOnce();
      expect(codeEditorChunk).toHaveBeenCalledOnce();
    });
  });
  it.each([
    ["a refused origin", "https://editor-staging.mdbase.dev/"],
    ["the Private grant callback", "https://editor.mdbase.dev/?state=s&code=c"],
    ["a retired /connect bookmark", "https://editor.mdbase.dev/connect/account"],
    ["an invalid Connect server", "https://editor.mdbase.dev/?server=ftp://connect.mdbase.dev"],
  ])("does not fetch editor chunks for %s", async (_page, href) => {
    vi.stubEnv("VITE_MDBASE_ENV", "production");
    vi.stubGlobal("location", Object.assign(new URL(href), { replace: vi.fn() }));
    await import("./main");
    await settle();
    expect(createEditorMdbase).not.toHaveBeenCalled();
    expect(appChunk).not.toHaveBeenCalled();
    expect(codeEditorChunk).not.toHaveBeenCalled();
  });
  it.each([
    ["/connect/account?collection=c#k=v", "https://connect.mdbase.dev/account?collection=c#k=v"],
    ["/connect", "https://connect.mdbase.dev/"],
    ["/connect//other.example/x?server=https%3A%2F%2Fconnect.mdbase.dev", "https://connect.mdbase.dev//other.example/x"],
    ["/connect///other.example", "https://connect.mdbase.dev///other.example"],
  ])("forwards the retired %s link to the same path on the Connect portal", async (path, target) => {
    vi.stubEnv("VITE_MDBASE_ENV", "production");
    const replace = vi.fn();
    vi.stubGlobal("location", Object.assign(new URL(path, "https://editor.mdbase.dev"), { replace }));
    await import("./main");
    expect(replace).toHaveBeenCalledExactlyOnceWith(target);
  });
  // Vitest fails the run on an unhandled rejection, so this load failing
  // unobserved would fail here.
  it("leaves a failed chunk load to the boundary that renders it, without an unhandled rejection", async () => {
    appChunk.mockImplementationOnce(() => { throw new Error("chunk unavailable"); });
    codeEditorChunk.mockImplementationOnce(() => { throw new Error("chunk unavailable"); });
    vi.stubEnv("VITE_MDBASE_ENV", "production");
    vi.stubGlobal("location", new URL("https://editor.mdbase.dev/"));
    await import("./main");
    await vi.waitFor(() => {
      expect(appChunk).toHaveBeenCalledOnce();
      expect(codeEditorChunk).toHaveBeenCalledOnce();
    });
    await settle();
    expect(createEditorMdbase).toHaveBeenCalledOnce();
    expect(renderRoot).toHaveBeenCalledOnce();
  });
});
