import { describe, expect, it } from "vitest";
import { runtimeConfigFromEnv, validateRuntimeConfig } from "./runtime-config.js";

function config(overrides: Partial<Parameters<typeof validateRuntimeConfig>[0]> = {}) {
  return {
    host: "127.0.0.1",
    publicUrl: "http://127.0.0.1:8787",
    devAuth: false,
    tailscaleAuth: false,
    githubAuth: null,
    googleAuth: null,
    registration: "closed" as const,
    hostedCollections: false,
    hostedProvider: null,
    trustProxy: false,
    ...overrides
  };
}

describe("public runtime configuration", () => {
  it("allows explicit loopback development authentication", () => {
    expect(() => validateRuntimeConfig(config({
      host: "0.0.0.0",
      publicUrl: "http://localhost:8787",
      devAuth: true
    }))).not.toThrow();
  });

  it("refuses development authentication and plaintext on public origins", () => {
    expect(() => validateRuntimeConfig(config({
      host: "0.0.0.0",
      publicUrl: "https://connect.example",
      devAuth: true
    }))).toThrow(/Development authentication/);
    expect(() => validateRuntimeConfig(config({
      host: "0.0.0.0",
      publicUrl: "http://connect.example",
      tailscaleAuth: true
    }))).toThrow(/HTTPS/);
  });

  it("refuses to start without a real authentication mode", () => {
    expect(() => validateRuntimeConfig(config())).toThrow(/Exactly one authentication mode/);
  });

  it("accepts one allowlisted GitHub provider on a canonical HTTPS origin", () => {
    const value = validateRuntimeConfig(config({
      host: "0.0.0.0",
      publicUrl: "https://connect.example/",
      githubAuth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedUserIds: new Set(["12558714"])
      },
      trustProxy: true
    }));
    expect(value.publicUrl).toBe("https://connect.example");
    expect(value.githubAuth?.allowedUserIds.has("12558714")).toBe(true);
  });

  it("rejects partial GitHub configuration, invalid IDs, and conflicting authentication modes", () => {
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GITHUB_CLIENT_ID: "client-id"
    })).toThrow(/client secret/);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GITHUB_CLIENT_ID: "client-id",
      MDBASE_CONNECT_GITHUB_CLIENT_SECRET: "client-secret",
      MDBASE_CONNECT_ALLOWED_GITHUB_USER_IDS: "not-a-number"
    })).toThrow(/numeric IDs/);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_TAILSCALE_AUTH: "1"
    })).toThrow(/Exactly one authentication mode/);
  });

  it("supports Google and GitHub together while keeping registration policy explicit", () => {
    const value = validateRuntimeConfig(config({
      publicUrl: "https://connect.example",
      githubAuth: {
        clientId: "github-client",
        clientSecret: "github-secret",
        allowedUserIds: new Set(["12558714"])
      },
      googleAuth: {
        clientId: "google-client.apps.googleusercontent.com",
        allowedSubjects: new Set(["109876543210"])
      }
    }));
    expect(value.githubAuth).not.toBeNull();
    expect(value.googleAuth).not.toBeNull();

    const open = runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
      MDBASE_CONNECT_REGISTRATION: "open"
    });
    expect(open.registration).toBe("open");
    expect(open.googleAuth?.clientId).toContain("apps.googleusercontent.com");

    const closedBootstrap = runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com"
    });
    expect(closedBootstrap.registration).toBe("closed");
    expect(closedBootstrap.googleAuth?.allowedSubjects.size).toBe(0);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
      MDBASE_CONNECT_ALLOWED_GOOGLE_SUBJECTS: "not a subject"
    })).toThrow(/subject identifiers/);
  });

  it("rejects public URLs containing path or credential components", () => {
    expect(() => validateRuntimeConfig(config({
      publicUrl: "https://connect.example/control",
      tailscaleAuth: true
    }))).toThrow(/must be an origin/);
  });

  it("requires a canonical TLS provider and a strong internal credential for hosted mode", () => {
    expect(() => validateRuntimeConfig(config({
      tailscaleAuth: true,
      publicUrl: "https://connect.example",
      hostedCollections: true
    }))).toThrow(/storage provider/);
    expect(() => validateRuntimeConfig(config({
      tailscaleAuth: true,
      publicUrl: "https://connect.example",
      hostedCollections: true,
      hostedProvider: { url: "http://provider.example", internalToken: "x".repeat(40) }
    }))).toThrow(/HTTPS/);
    expect(() => validateRuntimeConfig(config({
      tailscaleAuth: true,
      publicUrl: "https://connect.example",
      hostedCollections: true,
      hostedProvider: { url: "https://provider.example/path", internalToken: "x".repeat(40) }
    }))).toThrow(/must be an origin/);
    expect(() => validateRuntimeConfig(config({
      tailscaleAuth: true,
      publicUrl: "https://connect.example",
      hostedCollections: true,
      hostedProvider: { url: "https://provider.example", internalToken: "short" }
    }))).toThrow(/32 characters/);

    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_HOSTED_COLLECTIONS: "1",
      MDBASE_CONNECT_HOSTED_PROVIDER_URL: "http://127.0.0.1:8790",
      MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN: "x".repeat(40)
    });
    expect(value.hostedProvider?.url).toBe("http://127.0.0.1:8790");
  });
});
