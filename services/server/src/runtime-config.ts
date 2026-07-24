import type { GitHubAuthConfig } from "./github-auth.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import type { HostedProviderConfig } from "./hosted-provider.js";
import type { RelayBrokerConfig } from "./relay-broker.js";
import type { VapidConfig } from "./web-push.js";

export type RegistrationMode = "closed" | "open";

export interface RuntimeConfig {
  host: string;
  publicUrl: string;
  devAuth: boolean;
  tailscaleAuth: boolean;
  githubAuth: GitHubAuthConfig | null;
  googleAuth: GoogleAuthConfig | null;
  registration: RegistrationMode;
  hostedCollections: boolean;
  hostedProvider: HostedProviderConfig | null;
  trustProxy: boolean;
  relayBroker: RelayBrokerConfig | null;
  vapid: VapidConfig | null;
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
  if (authenticationModes !== 1) {
    throw new Error("Exactly one authentication mode must be configured before the server starts.");
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
  let hostedProvider = config.hostedProvider;
  if (config.hostedCollections && !hostedProvider) {
    throw new Error("Hosted collections require a configured hosted storage provider.");
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
    if (providerUrl.protocol !== "https:" && !isLoopback(providerUrl.hostname)) {
      throw new Error("The hosted storage provider URL must use HTTPS outside loopback development.");
    }
    if (hostedProvider.internalToken.length < 32) {
      throw new Error("The hosted storage provider internal token must contain at least 32 characters.");
    }
    hostedProvider = { ...hostedProvider, url: providerUrl.origin };
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
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  const hostedProviderUrl = env.MDBASE_CONNECT_HOSTED_PROVIDER_URL?.trim() ?? "";
  const hostedProviderInternalToken =
    env.MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN?.trim() ?? "";
  const hostedProviderConfigured = Boolean(hostedProviderUrl || hostedProviderInternalToken);
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
    hostedCollections: env.MDBASE_CONNECT_HOSTED_COLLECTIONS === "1",
    hostedProvider: hostedProviderConfigured
      ? { url: hostedProviderUrl, internalToken: hostedProviderInternalToken }
      : null,
    trustProxy: env.MDBASE_CONNECT_TRUST_PROXY === "1",
    relayBroker: normalizedRelayBrokerServers.length > 0
      ? { servers: normalizedRelayBrokerServers, token: relayBrokerToken }
      : null,
    vapid: vapidConfigured
      ? { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey }
      : null
  });
}

function commaSeparatedSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function registrationMode(value: string | undefined): RegistrationMode {
  const normalized = value?.trim() || "closed";
  if (normalized !== "closed" && normalized !== "open") {
    throw new Error("MDBASE_CONNECT_REGISTRATION must be either closed or open.");
  }
  return normalized;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
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
