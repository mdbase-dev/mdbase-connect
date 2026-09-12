const productionConnectOrigin = "https://connect.mdbase.dev";

export const configuredConnectServerUrl =
  import.meta.env.VITE_MDBASE_CONNECT_URL ?? productionConnectOrigin;

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
