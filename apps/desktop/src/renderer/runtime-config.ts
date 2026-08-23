export const PRODUCTION_CONNECT_ORIGIN = "https://connect.mdbase.dev";

export function defaultConnectServerUrl(value: string | undefined): string {
  const configured = value?.trim() || PRODUCTION_CONNECT_ORIGIN;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new TypeError("The default Connect server must be a valid origin.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"]
    .includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new TypeError(
      "The default Connect server must be a credential-free HTTPS origin."
    );
  }
  return url.origin;
}
