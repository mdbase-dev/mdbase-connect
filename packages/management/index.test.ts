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

  it("exposes account management without leaking editor URLs into OAuth state", async () => {
    const fetch = vi.fn(async () => Response.json({
      client_id: "google-client",
      nonce: "nonce",
      redirect_to: "/account?linked=google"
    }));
    vi.stubGlobal("fetch", fetch);
    const client = new ConnectManagementClient("https://connect.example");

    expect(client.githubAccountFlowUrl("link")).toBe(
      "https://connect.example/v1/account/identities/github/link?return_to=%2Faccount"
    );
    expect(client.githubAccountFlowUrl("reauth_delete")).toBe(
      "https://connect.example/v1/account/reauth/github?return_to=%2Faccount"
    );
    await client.startGoogleAccountFlow("link");
    await client.completeGoogleAccountFlow("credential");
    await client.disconnectIdentity("google");
    await client.changePassword("old password", "a sufficiently long new password");
    await client.deleteAccount({
      confirmation: "DELETE",
      currentPassword: "old password",
      reauthenticationToken: "act_token"
    });

    expect(fetch).toHaveBeenNthCalledWith(1,
      new URL("https://connect.example/v1/account/identities/google/link?return_to=%2Faccount"),
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      new URL("https://connect.example/auth/google/callback"),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-mdbase-auth": "google" }),
        body: JSON.stringify({ credential: "credential" })
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(3,
      new URL("https://connect.example/v1/account/identities/google"),
      expect.objectContaining({ method: "DELETE", credentials: "include" })
    );
    expect(fetch).toHaveBeenNthCalledWith(4,
      new URL("https://connect.example/v1/account/password"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          current_password: "old password",
          new_password: "a sufficiently long new password"
        })
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(5,
      new URL("https://connect.example/v1/account"),
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          confirmation: "DELETE",
          current_password: "old password",
          reauth_token: "act_token"
        })
      })
    );
  });
});
