import document from "./person-setup.pack.json?raw";
import { afterEach, expect, it, vi } from "vitest";
import { loadPersonSetup } from "./person-setup";

const bytes = new TextEncoder().encode(document);
afterEach(() => vi.unstubAllGlobals());
it("loads the exact SHA-pinned canonical People/Contact provision without a catalog request", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes).buffer));
  vi.stubGlobal("fetch", fetcher);
  const provision = await loadPersonSetup();
  expect(provision).toEqual(JSON.parse(document));
  expect(provision.manifest.id).toBe("mdbase.contact");
  expect(provision.manifest.version).toBe("1.1.0");
  expect(provision.manifest.resources).toHaveLength(6);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).not.toContain("mdbase.dev/contracts");
});
it("rejects a tampered bundled provision before collection assessment", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(document + " ")));
  await expect(loadPersonSetup()).rejects.toThrow("does not match its catalog digest");
});
