const productionConnectOrigin = "https://connect.mdbase.dev";
// The native publisher sets only the application environment; derive its Connect
// portal the same way scripts/write-manifest.mjs pins it.
export function environmentConnectServerUrl(environment: string | undefined): string {
  return environment === "staging" ? "https://connect-staging.mdbase.dev" : productionConnectOrigin;
}

export const configuredConnectServerUrl =
  import.meta.env.VITE_MDBASE_CONNECT_URL ?? environmentConnectServerUrl(import.meta.env.VITE_MDBASE_ENV);

export function connectServerUrl(
  search = location.search,
  configuredServerUrl = configuredConnectServerUrl
): string {
  return new URLSearchParams(search).get("server") ?? configuredServerUrl;
}

export function applyConnectServerOverride(
  url: URL,
  serverUrl: string,
  configuredServerUrl = configuredConnectServerUrl
): URL {
  const activeOrigin = new URL(serverUrl).origin;
  const configuredOrigin = new URL(configuredServerUrl).origin;
  if (activeOrigin === configuredOrigin) url.searchParams.delete("server");
  else url.searchParams.set("server", activeOrigin);
  return url;
}
