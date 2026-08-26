export const managedEnvironments = Object.freeze({
  lab: Object.freeze({
    connectOrigin: "https://connect-lab.mdbase.dev",
    editorOrigin: "https://editor-lab.mdbase.dev"
  }),
  staging: Object.freeze({
    connectOrigin: "https://connect-staging.mdbase.dev",
    editorOrigin: "https://editor-staging.mdbase.dev"
  }),
  production: Object.freeze({
    connectOrigin: "https://connect.mdbase.dev",
    editorOrigin: "https://editor.mdbase.dev"
  })
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
