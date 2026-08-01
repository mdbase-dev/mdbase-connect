import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectManagementClient, ManagementApiError } from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("ConnectManagementClient", () => {
  it("uses the account origin with explicit browser credentials", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: "person" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);
    const client = new ConnectManagementClient("https://connect.example/ignored/path");

    await client.overview();

    expect(fetch).toHaveBeenCalledWith(new URL("https://connect.example/v1/me"), expect.objectContaining({
      credentials: "include",
      headers: expect.objectContaining({ accept: "application/json" })
    }));
  });

  it("keeps server failures typed for authentication recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "not_authenticated", message: "Sign in first." }
    }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })));
    const client = new ConnectManagementClient("https://connect.example");

    await expect(client.overview()).rejects.toEqual(
      expect.objectContaining<Partial<ManagementApiError>>({ status: 401, message: "Sign in first." })
    );
  });
});
