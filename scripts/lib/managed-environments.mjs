import { managedAppOrigins } from "./managed-app-origins.mjs";

export const managedEnvironments = Object.freeze({
  lab: Object.freeze({
    ...managedAppOrigins.lab,
    cloudflareAccountId: "a738af70299a1b59abd43fe1275f5892"
  }),
  staging: managedAppOrigins.staging,
  production: managedAppOrigins.production
});

export function normalizedEndpointOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS origin.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTP or HTTPS origin.`);
  }
  return url.origin;
}
