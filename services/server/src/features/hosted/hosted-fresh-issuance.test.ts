import { afterEach, expect, it, vi } from "vitest";
import { type ApplicationRequirements, APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY } from "@mdbase-dev/connect-protocol";
import { HostedProviderClient, HostedProviderResponseError } from "./hosted-provider.js";

afterEach(() => vi.restoreAllMocks());

const setupInput = (version: 1 | 2) => ({
  applicationId: "dev.mdbase.fixture",
  declarationDigest: "sha256:test",
  // v1 remains a supported legacy wire input, not a new manifest default.
  requirements: { contracts: [], capabilities: { contract_version: version, required: ["collection.read"] } } as ApplicationRequirements,
  provisions: { type_packs: [] }
});

it("binds fresh v2 setup to the actual receiver after successful capability checks, without legacy fallback", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready", provider: {
      capabilities: [APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY]
    } })))
    // Immutable beta.95 has no fresh-v2-only setup route.
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  const provider = new HostedProviderClient({ url: "https://provider.example", internalToken: "test" });
  await provider.assertFreshV2AuthorizationSupport();
  const result = provider.provisionApplicationSetup("collection", setupInput(2));
  await expect(result).rejects.toBeInstanceOf(HostedProviderResponseError);
  await expect(result).rejects.toMatchObject({ status: 404 });
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    ["https://provider.example/ready", "GET"],
    ["https://provider.example/internal/v1/collections/collection/fresh-application-setup-v2", "POST"]
  ]);
});

it("keeps v1 setup on the legacy path", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ contracts: [] })));
  const provider = new HostedProviderClient({ url: "https://provider.example", internalToken: "test" });
  await provider.provisionApplicationSetup("collection", setupInput(1));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://provider.example/internal/v1/collections/collection/application-setup");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).requirements.capabilities.contract_version).toBe(1);
});
it.each([undefined, null, [], ["application-setup-evidence-v2"], ["unknown-issuance"],
  APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY, [APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY, 2]].map(capabilities => ({ capabilities })))(
  "fails closed on missing or malformed fresh support $capabilities", async ({ capabilities }) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "ready", provider: { capabilities, contract_support: { semantic_capabilities: [2, 1] } }
    })));
    const provider = new HostedProviderClient({ url: "https://provider.example", internalToken: "test" });
    await expect(provider.assertFreshV2AuthorizationSupport()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
  }
);
it("checks fresh support again rather than caching a replaced provider", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready", provider: {
      capabilities: [APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY]
    } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready", provider: { capabilities: [] } })));
  const provider = new HostedProviderClient({ url: "https://provider.example", internalToken: "test" });
  await provider.assertFreshV2AuthorizationSupport();
  await expect(provider.assertFreshV2AuthorizationSupport()).rejects.toThrow();
});
