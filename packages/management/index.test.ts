import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectManagementClient, ManagementApiError } from "./index";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it("bounds a black-holed request with a typed timeout", async () => {
    vi.useFakeTimers();
    // Deliberately ignore AbortSignal to prove the public deadline is not
    // dependent on a cooperative fetch implementation.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const client = new ConnectManagementClient("https://connect.example");
    const pending = client.overview({ timeoutMs: 25 });
    const rejection = expect(pending).rejects.toMatchObject({ code: "timeout", status: 0 });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("does not dispatch a request cancelled by its caller in advance", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new ConnectManagementClient("https://connect.example");
    const controller = new AbortController();
    controller.abort("navigation");

    await expect(client.revokeGrant("grant", { signal: controller.signal }))
      .rejects.toMatchObject({
        code: "cancelled",
        details: { operation_outcome: "not_sent" }
      });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a black-holed mutation as outcome unknown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const client = new ConnectManagementClient("https://connect.example");
    const pending = client.revokeGrant("grant", { timeoutMs: 25 });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { operation_outcome: "unknown" }
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("rejects an invalid successful response at the boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>proxy error</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    })));
    const client = new ConnectManagementClient("https://connect.example");

    await expect(client.overview()).rejects.toMatchObject({
      code: "invalid_response",
      status: 200
    });
  });

  it("revokes an application through one exact batch request", async () => {
    const fetch = vi.fn(async () => Response.json({
      ok: true,
      results: [
        { grant_id: "grant-a", status: "revoked" },
        { grant_id: "grant-b", status: "revoking" }
      ]
    }));
    vi.stubGlobal("fetch", fetch);
    const client = new ConnectManagementClient("https://connect.example");

    await expect(client.revokeApplication(["grant-a", "grant-b", "grant-a"]))
      .resolves.toMatchObject({ results: [{ grant_id: "grant-a" }, { grant_id: "grant-b" }] });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://connect.example/v1/grants/revoke-batch"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ grant_ids: ["grant-a", "grant-b"] })
      })
    );
  });

  it("reports exact partial batch completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      results: [
        { grant_id: "grant-a", status: "revoked" },
        { grant_id: "grant-b", status: "conflict" }
      ]
    })));
    const client = new ConnectManagementClient("https://connect.example");

    await expect(client.revokeApplication(["grant-a", "grant-b"]))
      .rejects.toMatchObject({
        code: "partial_failure",
        details: {
          results: [
            { grant_id: "grant-a", status: "revoked" },
            { grant_id: "grant-b", status: "conflict" }
          ]
        }
      });
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
