import type { GitHubAuthConfig } from "./github-auth.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import type { HostedProviderConfig } from "./hosted-provider.js";
import type { RelayBrokerConfig } from "./relay-broker.js";
import type { VapidConfig } from "./web-push.js";
import type { WebhookSigningConfig } from "./webhook.js";

export type RegistrationMode = "closed" | "invite" | "open";

export interface AuthenticationLegalDocuments {
  termsUrl: string;
  privacyUrl: string;
}

export interface TransactionalEmailConfig {
  apiKey: string;
  from: string;
}

export interface RuntimeConfig {
  host: string;
  publicUrl: string;
  devAuth: boolean;
  tailscaleAuth: boolean;
  githubAuth: GitHubAuthConfig | null;
  googleAuth: GoogleAuthConfig | null;
  registration: RegistrationMode;
  authRateLimitSecret: string | null;
  authenticationLegalDocuments: AuthenticationLegalDocuments | null;
  transactionalEmail: TransactionalEmailConfig | null;
  hostedCollections: boolean;
  hostedProvider: HostedProviderConfig | null;
  allowInsecureHostedProvider: boolean;
  trustProxy: boolean;
  relayBroker: RelayBrokerConfig | null;
  vapid: VapidConfig | null;
  fcm: { credentials?: Record<string, unknown> } | null;
  webhookSigning: WebhookSigningConfig | null;
}

export function validateRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const publicUrl = new URL(config.publicUrl);
  const localPublicOrigin = isLoopback(publicUrl.hostname);
  if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin without credentials, a path, a query, or a fragment.");
  }
  if (publicUrl.protocol !== "https:" && !localPublicOrigin) {
    throw new Error("PUBLIC_URL must use HTTPS outside loopback development.");
  }
  if (config.devAuth && !localPublicOrigin) {
    throw new Error("Development authentication cannot be enabled on a public origin.");
  }
  const externalAuth = Boolean(config.githubAuth || config.googleAuth);
  const authenticationModes = [config.devAuth, config.tailscaleAuth, externalAuth]
    .filter(Boolean).length;
  if (authenticationModes > 1) {
    throw new Error(
      "Development, Tailscale, and external-provider authentication modes are mutually exclusive."
    );
  }
  if (authenticationModes === 0 && config.authRateLimitSecret === null) {
    throw new Error(
      "At least one authentication path must be configured before the server starts."
    );
  }
  if (config.githubAuth) {
    if (!config.githubAuth.clientId.trim() || !config.githubAuth.clientSecret.trim()) {
      throw new Error("GitHub authentication requires a client ID and client secret.");
    }
    for (const id of config.githubAuth.allowedUserIds) {
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new Error("GitHub allowed user IDs must be positive numeric IDs.");
      }
    }
    if (config.registration === "closed" && config.githubAuth.allowedUserIds.size === 0) {
      throw new Error("Closed GitHub authentication requires at least one allowed user ID.");
    }
  }
  if (config.googleAuth) {
    if (!config.googleAuth.clientId.trim()) {
      throw new Error("Google authentication requires a web client ID.");
    }
    for (const subject of config.googleAuth.allowedSubjects) {
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(subject)) {
        throw new Error("Google allowed subjects must be valid account subject identifiers.");
      }
    }
  }
  if (
    config.authRateLimitSecret !== null
    && Buffer.byteLength(config.authRateLimitSecret, "utf8") < 32
  ) {
    throw new Error(
      "Authentication rate-limit digest secret must contain at least 32 bytes."
    );
  }
  if (config.authenticationLegalDocuments) {
    validatePublicDocumentUrl(
      config.authenticationLegalDocuments.termsUrl,
      "MDBASE_CONNECT_TERMS_URL"
    );
    validatePublicDocumentUrl(
      config.authenticationLegalDocuments.privacyUrl,
      "MDBASE_CONNECT_PRIVACY_URL"
    );
  }
  if (config.transactionalEmail) {
    if (
      !config.transactionalEmail.apiKey.trim()
      || !config.transactionalEmail.from.trim()
      || /[\r\n]/u.test(config.transactionalEmail.from)
    ) {
      throw new Error("Transactional email configuration is invalid.");
    }
  }
  let hostedProvider = config.hostedProvider;
  if (config.hostedCollections && !hostedProvider) {
    throw new Error("Hosted collections require a configured hosted storage provider.");
  }
  if (config.allowInsecureHostedProvider && !config.devAuth) {
    throw new Error(
      "Insecure hosted provider transport is only available with development authentication."
    );
  }
  if (hostedProvider) {
    const providerUrl = new URL(hostedProvider.url);
    if (
      providerUrl.username
      || providerUrl.password
      || providerUrl.pathname !== "/"
      || providerUrl.search
      || providerUrl.hash
    ) {
      throw new Error("MDBASE_CONNECT_HOSTED_PROVIDER_URL must be an origin.");
    }
    if (
      providerUrl.protocol !== "https:"
      && !isLoopback(providerUrl.hostname)
      && !config.allowInsecureHostedProvider
    ) {
      throw new Error("The hosted storage provider URL must use HTTPS outside loopback development.");
    }
    const providerPublicUrl = new URL(hostedProvider.publicUrl ?? hostedProvider.url);
    if (
      providerPublicUrl.username
      || providerPublicUrl.password
      || providerPublicUrl.pathname !== "/"
      || providerPublicUrl.search
      || providerPublicUrl.hash
    ) {
      throw new Error("MDBASE_CONNECT_HOSTED_PROVIDER_PUBLIC_URL must be an origin.");
    }
    if (
      providerPublicUrl.protocol !== "https:"
      && !isLoopback(providerPublicUrl.hostname)
    ) {
      throw new Error(
        "The public hosted storage provider URL must use HTTPS outside loopback development."
      );
    }
    if (hostedProvider.internalToken.length < 32) {
      throw new Error("The hosted storage provider internal token must contain at least 32 characters.");
    }
    hostedProvider = {
      ...hostedProvider,
      url: providerUrl.origin,
      ...(hostedProvider.publicUrl
        ? { publicUrl: providerPublicUrl.origin }
        : {})
    };
  }
  if (config.relayBroker) {
    if (config.relayBroker.token.length < 32) {
      throw new Error("The relay broker token must contain at least 32 characters.");
    }
    if (!/^[A-Za-z0-9_+=./-]+$/.test(config.relayBroker.token)) {
      throw new Error("The relay broker token contains unsupported characters.");
    }
    for (const server of config.relayBroker.servers) validateRelayBrokerServer(server);
    if (config.relayBroker.servers.length === 0) {
      throw new Error("At least one relay broker server must be configured.");
    }
  }
  if (config.vapid) {
    if (!/^(mailto:|https:\/\/)/.test(config.vapid.subject)) {
      throw new Error("MDBASE_CONNECT_VAPID_SUBJECT must be a mailto: or HTTPS URI.");
    }
    if (!config.vapid.publicKey || !config.vapid.privateKey) {
      throw new Error("Web Push requires both VAPID public and private keys.");
    }
  }
  if (config.webhookSigning) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(config.webhookSigning.keyId)) {
      throw new Error("MDBASE_CONNECT_WEBHOOK_SIGNING_KEY_ID is invalid.");
    }
    if (!config.webhookSigning.privateKeyPem.includes("PRIVATE KEY")) {
      throw new Error("Webhook signing requires a PEM-encoded Ed25519 private key.");
    }
    const keyIds = new Set([config.webhookSigning.keyId]);
    for (const key of config.webhookSigning.previousPublicKeys ?? []) {
      if (
        key.kty !== "OKP"
        || key.crv !== "Ed25519"
        || key.alg !== "EdDSA"
        || typeof key.x !== "string"
        || !key.x
        || typeof key.kid !== "string"
        || !/^[A-Za-z0-9._-]{1,100}$/.test(key.kid)
      ) {
        throw new Error("Previous webhook verification keys must be Ed25519 public JWKs.");
      }
      if (keyIds.has(key.kid)) {
        throw new Error("Webhook signing key IDs must be unique.");
      }
      keyIds.add(key.kid);
    }
  }
  return { ...config, publicUrl: publicUrl.origin, hostedProvider };
}

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv): RuntimeConfig {
  const clientId = env.MDBASE_CONNECT_GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.MDBASE_CONNECT_GITHUB_CLIENT_SECRET?.trim() ?? "";
  const allowedUserIds = new Set(
    (env.MDBASE_CONNECT_ALLOWED_GITHUB_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const githubConfigured = Boolean(clientId || clientSecret || allowedUserIds.size);
  const googleClientId = env.MDBASE_CONNECT_GOOGLE_CLIENT_ID?.trim() ?? "";
  const allowedGoogleSubjects = commaSeparatedSet(env.MDBASE_CONNECT_ALLOWED_GOOGLE_SUBJECTS);
  const googleConfigured = Boolean(googleClientId || allowedGoogleSubjects.size);
  const registration = registrationMode(env.MDBASE_CONNECT_REGISTRATION);
  const authRateLimitSecret =
    env.MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET?.trim() || null;
  const termsUrl = env.MDBASE_CONNECT_TERMS_URL?.trim() ?? "";
  const privacyUrl = env.MDBASE_CONNECT_PRIVACY_URL?.trim() ?? "";
  if (Boolean(termsUrl) !== Boolean(privacyUrl)) {
    throw new Error(
      "MDBASE_CONNECT_TERMS_URL and MDBASE_CONNECT_PRIVACY_URL must be configured together."
    );
  }
  const authenticationLegalDocuments = termsUrl && privacyUrl
    ? { termsUrl, privacyUrl }
    : null;
  const resendApiKey = env.MDBASE_CONNECT_RESEND_API_KEY?.trim() ?? "";
  const emailFrom = env.MDBASE_CONNECT_EMAIL_FROM?.trim() ?? "";
  if (Boolean(resendApiKey) !== Boolean(emailFrom)) {
    throw new Error(
      "MDBASE_CONNECT_RESEND_API_KEY and MDBASE_CONNECT_EMAIL_FROM must be configured together."
    );
  }
  const transactionalEmail = resendApiKey && emailFrom
    ? { apiKey: resendApiKey, from: emailFrom }
    : null;
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  const hostedProviderUrl = env.MDBASE_CONNECT_HOSTED_PROVIDER_URL?.trim() ?? "";
  const hostedProviderPublicUrl =
    env.MDBASE_CONNECT_HOSTED_PROVIDER_PUBLIC_URL?.trim() ?? "";
  const hostedProviderInternalToken =
    env.MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN?.trim() ?? "";
  const hostedProviderConfigured = Boolean(
    hostedProviderUrl || hostedProviderPublicUrl || hostedProviderInternalToken
  );
  const relayBrokerServers = (env.MDBASE_CONNECT_RELAY_NATS_URL ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedRelayBrokerServers = relayBrokerServers.map(normalizeRelayBrokerServer);
  const relayBrokerToken = env.MDBASE_CONNECT_RELAY_NATS_TOKEN?.trim() ?? "";
  const vapidSubject = env.MDBASE_CONNECT_VAPID_SUBJECT?.trim() ?? "";
  const vapidPublicKey = env.MDBASE_CONNECT_VAPID_PUBLIC_KEY?.trim() ?? "";
  const vapidPrivateKey = env.MDBASE_CONNECT_VAPID_PRIVATE_KEY?.trim() ?? "";
  const vapidConfigured = Boolean(vapidSubject || vapidPublicKey || vapidPrivateKey);
  const fcmCredentialsSource = env.MDBASE_CONNECT_FCM_CREDENTIALS_JSON?.trim() ?? "";
  const fcmEnabled = env.MDBASE_CONNECT_FCM_ENABLED === "1" || Boolean(fcmCredentialsSource);
  const fcmCredentials = fcmCredentialsSource
    ? parseJsonObject(fcmCredentialsSource, "MDBASE_CONNECT_FCM_CREDENTIALS_JSON")
    : undefined;
  const webhookKeyId = env.MDBASE_CONNECT_WEBHOOK_SIGNING_KEY_ID?.trim() ?? "";
  const webhookPrivateKey = env.MDBASE_CONNECT_WEBHOOK_SIGNING_PRIVATE_KEY?.trim() ?? "";
  const webhookPreviousKeysSource =
    env.MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON?.trim() ?? "";
  const webhookPreviousPublicKeys = webhookPreviousKeysSource
    ? parseWebhookPublicKeys(webhookPreviousKeysSource)
    : [];
  const webhookConfigured = Boolean(
    webhookKeyId || webhookPrivateKey || webhookPreviousKeysSource
  );
  if (vapidConfigured && !(vapidSubject && vapidPublicKey && vapidPrivateKey)) {
    throw new Error(
      "MDBASE_CONNECT_VAPID_SUBJECT, MDBASE_CONNECT_VAPID_PUBLIC_KEY, and MDBASE_CONNECT_VAPID_PRIVATE_KEY must be configured together."
    );
  }
  if ((relayBrokerServers.length > 0) !== Boolean(relayBrokerToken)) {
    throw new Error(
      "MDBASE_CONNECT_RELAY_NATS_URL and MDBASE_CONNECT_RELAY_NATS_TOKEN must be configured together."
    );
  }
  if (webhookConfigured && !(webhookKeyId && webhookPrivateKey)) {
    throw new Error(
      "MDBASE_CONNECT_WEBHOOK_SIGNING_KEY_ID and MDBASE_CONNECT_WEBHOOK_SIGNING_PRIVATE_KEY must be configured together."
    );
  }
  return validateRuntimeConfig({
    host,
    publicUrl: env.PUBLIC_URL ?? `http://${host}:${port}`,
    devAuth: env.MDBASE_CONNECT_DEV_AUTH === "1",
    tailscaleAuth: env.MDBASE_CONNECT_TAILSCALE_AUTH === "1",
    githubAuth: githubConfigured ? { clientId, clientSecret, allowedUserIds } : null,
    googleAuth: googleConfigured
      ? { clientId: googleClientId, allowedSubjects: allowedGoogleSubjects }
      : null,
    registration,
    authRateLimitSecret,
    authenticationLegalDocuments,
    transactionalEmail,
    hostedCollections: env.MDBASE_CONNECT_HOSTED_COLLECTIONS === "1",
    hostedProvider: hostedProviderConfigured
      ? {
          url: hostedProviderUrl,
          ...(hostedProviderPublicUrl ? { publicUrl: hostedProviderPublicUrl } : {}),
          internalToken: hostedProviderInternalToken
        }
      : null,
    allowInsecureHostedProvider:
      env.MDBASE_CONNECT_ALLOW_INSECURE_HOSTED_PROVIDER === "1",
    trustProxy: env.MDBASE_CONNECT_TRUST_PROXY === "1",
    relayBroker: normalizedRelayBrokerServers.length > 0
      ? { servers: normalizedRelayBrokerServers, token: relayBrokerToken }
      : null,
    vapid: vapidConfigured
      ? { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey }
      : null,
    fcm: fcmEnabled ? { ...(fcmCredentials ? { credentials: fcmCredentials } : {}) } : null,
    webhookSigning: webhookConfigured
      ? {
          keyId: webhookKeyId,
          privateKeyPem: webhookPrivateKey,
          previousPublicKeys: webhookPreviousPublicKeys
        }
      : null
  });
}

function parseWebhookPublicKeys(
  value: string
): NonNullable<WebhookSigningConfig["previousPublicKeys"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON must be valid JSON."
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON must contain an array."
    );
  }
  return parsed as NonNullable<WebhookSigningConfig["previousPublicKeys"]>;
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function commaSeparatedSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function registrationMode(value: string | undefined): RegistrationMode {
  const normalized = value?.trim() || "closed";
  if (normalized !== "closed" && normalized !== "invite" && normalized !== "open") {
    throw new Error(
      "MDBASE_CONNECT_REGISTRATION must be closed, invite, or open."
    );
  }
  return normalized;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function validatePublicDocumentUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (
    url.username
    || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new Error(`${name} must use HTTPS outside loopback development.`);
  }
}

function validateRelayBrokerServer(server: string): void {
  const url = new URL(server);
  if ((url.protocol !== "nats:" && url.protocol !== "tls:")
      || url.username
      || url.password
      || url.pathname !== ""
      || url.search
      || url.hash
      || !url.hostname
      || !url.port) {
    throw new Error("Relay broker servers must be nats:// or tls:// host-and-port URLs without credentials.");
  }
}

function normalizeRelayBrokerServer(value: string): string {
  const url = new URL(value.includes("://") ? value : `nats://${value}`);
  if (!url.port) url.port = "4222";
  return url.toString();
}
