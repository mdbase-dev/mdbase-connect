import type { GitHubAuthConfig } from "./github-auth.js";
import type { HostedProviderConfig } from "./hosted-provider.js";

export interface RuntimeConfig {
  host: string;
  publicUrl: string;
  devAuth: boolean;
  tailscaleAuth: boolean;
  githubAuth: GitHubAuthConfig | null;
  hostedCollections: boolean;
  hostedProvider: HostedProviderConfig | null;
  trustProxy: boolean;
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
  const authenticationModes = [config.devAuth, config.tailscaleAuth, Boolean(config.githubAuth)]
    .filter(Boolean).length;
  if (authenticationModes !== 1) {
    throw new Error("Exactly one identity provider must be configured before the server starts.");
  }
  if (config.githubAuth) {
    if (!config.githubAuth.clientId.trim() || !config.githubAuth.clientSecret.trim()) {
      throw new Error("GitHub authentication requires a client ID and client secret.");
    }
    if (config.githubAuth.allowedUserIds.size === 0) {
      throw new Error("GitHub authentication requires at least one allowed user ID.");
    }
    for (const id of config.githubAuth.allowedUserIds) {
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new Error("GitHub allowed user IDs must be positive numeric IDs.");
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
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  const hostedProviderUrl = env.MDBASE_CONNECT_HOSTED_PROVIDER_URL?.trim() ?? "";
  const hostedProviderInternalToken =
    env.MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN?.trim() ?? "";
  const hostedProviderConfigured = Boolean(hostedProviderUrl || hostedProviderInternalToken);
  return validateRuntimeConfig({
    host,
    publicUrl: env.PUBLIC_URL ?? `http://${host}:${port}`,
    devAuth: env.MDBASE_CONNECT_DEV_AUTH === "1",
    tailscaleAuth: env.MDBASE_CONNECT_TAILSCALE_AUTH === "1",
    githubAuth: githubConfigured ? { clientId, clientSecret, allowedUserIds } : null,
    hostedCollections: env.MDBASE_CONNECT_HOSTED_COLLECTIONS === "1",
    hostedProvider: hostedProviderConfigured
      ? { url: hostedProviderUrl, internalToken: hostedProviderInternalToken }
      : null,
    trustProxy: env.MDBASE_CONNECT_TRUST_PROXY === "1"
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
