import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hostedProviderConfigFromEnv,
  runtimeConfigFromEnv,
  validateRuntimeConfig
} from "./runtime-config.js";

function config(overrides: Partial<Parameters<typeof validateRuntimeConfig>[0]> = {}) {
  return {
    host: "127.0.0.1",
    publicUrl: "http://127.0.0.1:8787",
    devAuth: false,
    tailscaleAuth: false,
    githubAuth: null,
    googleAuth: null,
    registration: "closed" as const,
    authRateLimitSecret: null,
    betaAccessOrigin: null,
    editorOrigin: null,
    authenticationLegalDocuments: null,
    transactionalEmail: null,
    hostedCollections: false,
    hostedProvider: null,
    allowInsecureHostedProvider: false,
    trustProxy: false,
    relayBroker: null,
    vapid: null,
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
    expect(() => validateRuntimeConfig(config())).toThrow(/authentication path/);
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
    })).toThrow(/mutually exclusive/);
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

  it("accepts invite-only registration without opening external providers", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
      MDBASE_CONNECT_ALLOWED_GOOGLE_SUBJECTS: "109876543210",
      MDBASE_CONNECT_REGISTRATION: "invite"
    });
    expect(value.registration).toBe("invite");
    expect(value.googleAuth?.allowedSubjects).toEqual(new Set(["109876543210"]));

    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
      MDBASE_CONNECT_REGISTRATION: "waitlist"
    })).toThrow(/closed, invite, or open/);
  });

  it("validates the shared authentication rate-limit digest secret", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32)
    });
    expect(value.authRateLimitSecret).toBe("x".repeat(32));
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "too-short"
    })).toThrow(/at least 32 bytes/);
  });

  it("enables beta requests only for a canonical origin with shared rate limiting", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32),
      MDBASE_CONNECT_BETA_ACCESS_ORIGIN: "https://mdbase.dev/"
    });
    expect(value.betaAccessOrigin).toBe("https://mdbase.dev");
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_BETA_ACCESS_ORIGIN: "https://mdbase.dev"
    })).toThrow(/RATE_LIMIT_SECRET/);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32),
      MDBASE_CONNECT_BETA_ACCESS_ORIGIN: "https://mdbase.dev/beta/"
    })).toThrow(/origin/);
  });

  it("normalizes the explicit editor management origins", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_MANAGEMENT_ORIGINS: "http://localhost:4173/, http://127.0.0.1:4173"
    });
    expect(value.managementOrigins).toEqual([
      "http://localhost:4173",
      "http://127.0.0.1:4173"
    ]);
    expect(value.editorOrigin).toBe("http://localhost:4173");
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_MANAGEMENT_ORIGINS: "https://editor.example/connect"
    })).toThrow(/origin/);
  });

  it("supports password-only authentication infrastructure and validates legal document URLs", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32),
      MDBASE_CONNECT_TERMS_URL: "https://mdbase.dev/terms/",
      MDBASE_CONNECT_PRIVACY_URL: "https://mdbase.dev/privacy/"
    });
    expect(value.authenticationLegalDocuments).toEqual({
      termsUrl: "https://mdbase.dev/terms/",
      privacyUrl: "https://mdbase.dev/privacy/"
    });
    expect(value.githubAuth).toBeNull();
    expect(value.googleAuth).toBeNull();

    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32),
      MDBASE_CONNECT_TERMS_URL: "https://mdbase.dev/terms/"
    })).toThrow(/configured together/);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32),
      MDBASE_CONNECT_TERMS_URL: "http://mdbase.dev/terms/",
      MDBASE_CONNECT_PRIVACY_URL: "https://mdbase.dev/privacy/"
    })).toThrow(/must use HTTPS/);
  });

  it("loads transactional email only when the provider key and sender are complete", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RESEND_API_KEY: "re_test",
      MDBASE_CONNECT_EMAIL_FROM: "mdbase connect <connect@example.com>"
    });
    expect(value.transactionalEmail).toEqual({
      apiKey: "re_test",
      from: "mdbase connect <connect@example.com>"
    });
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RESEND_API_KEY: "re_test"
    })).toThrow(/configured together/);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RESEND_API_KEY: "re_test",
      MDBASE_CONNECT_EMAIL_FROM: "connect@example.com\nBcc: other@example.com"
    })).toThrow(/invalid/);
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

    const dockerDevelopment = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_HOSTED_COLLECTIONS: "1",
      MDBASE_CONNECT_HOSTED_PROVIDER_URL: "http://host.docker.internal:8790",
      MDBASE_CONNECT_HOSTED_PROVIDER_PUBLIC_URL: "http://127.0.0.1:8790",
      MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN: "x".repeat(40),
      MDBASE_CONNECT_ALLOW_INSECURE_HOSTED_PROVIDER: "1"
    });
    expect(dockerDevelopment.hostedProvider).toMatchObject({
      url: "http://host.docker.internal:8790",
      publicUrl: "http://127.0.0.1:8790"
    });
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "https://connect.example",
      MDBASE_CONNECT_TAILSCALE_AUTH: "1",
      MDBASE_CONNECT_HOSTED_COLLECTIONS: "1",
      MDBASE_CONNECT_HOSTED_PROVIDER_URL: "http://provider.example",
      MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN: "x".repeat(40),
      MDBASE_CONNECT_ALLOW_INSECURE_HOSTED_PROVIDER: "1"
    })).toThrow(/development authentication/);
  });

  it("loads provider configuration independently for one-shot administration", () => {
    expect(hostedProviderConfigFromEnv({
      MDBASE_CONNECT_HOSTED_PROVIDER_URL: "https://provider.example/",
      MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN: "x".repeat(40)
    })).toEqual({
      url: "https://provider.example",
      internalToken: "x".repeat(40)
    });
    expect(() => hostedProviderConfigFromEnv({
      MDBASE_CONNECT_HOSTED_PROVIDER_URL: "https://provider.example"
    })).toThrow(/32 characters/);
  });

  it("validates an optional private NATS relay transport", () => {
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RELAY_NATS_URL: "nats://relay-a:4222,nats://relay-b:4222",
      MDBASE_CONNECT_RELAY_NATS_TOKEN: "x".repeat(40)
    });
    expect(value.relayBroker?.servers).toEqual([
      "nats://relay-a:4222",
      "nats://relay-b:4222"
    ]);

    const renderHost = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RELAY_NATS_URL: "mdbase-connect-relay-broker",
      MDBASE_CONNECT_RELAY_NATS_TOKEN: "x".repeat(40)
    });
    expect(renderHost.relayBroker?.servers).toEqual([
      "nats://mdbase-connect-relay-broker:4222"
    ]);

    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RELAY_NATS_URL: "nats://relay:4222"
    })).toThrow(/configured together/);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RELAY_NATS_URL: "https://relay.example:4222",
      MDBASE_CONNECT_RELAY_NATS_TOKEN: "x".repeat(40)
    })).toThrow(/nats:\/\//);
    expect(() => runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_RELAY_NATS_URL: "nats://relay:4222",
      MDBASE_CONNECT_RELAY_NATS_TOKEN: `unsafe ${"x".repeat(40)}`
    })).toThrow(/unsupported characters/);
  });

  it("loads FCM credentials and a rotatable webhook signing keyring", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const old = {
      ...publicKey.export({ format: "jwk" }),
      kid: "connect-old",
      alg: "EdDSA",
      use: "sig"
    };
    const value = runtimeConfigFromEnv({
      PUBLIC_URL: "http://localhost:8787",
      MDBASE_CONNECT_DEV_AUTH: "1",
      MDBASE_CONNECT_FCM_ENABLED: "1",
      MDBASE_CONNECT_FCM_CREDENTIALS_JSON: JSON.stringify({
        client_email: "sender@example.test"
      }),
      MDBASE_CONNECT_WEBHOOK_SIGNING_KEY_ID: "connect-current",
      MDBASE_CONNECT_WEBHOOK_SIGNING_PRIVATE_KEY: privateKey.export({
        format: "pem",
        type: "pkcs8"
      }).toString(),
      MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON: JSON.stringify([old])
    });
    expect(value.fcm?.credentials).toMatchObject({
      client_email: "sender@example.test"
    });
    expect(value.webhookSigning?.previousPublicKeys).toEqual([old]);
  });
});
