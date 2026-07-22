import { SecretBox } from "./security.js";

export interface McpRuntimeConfig {
  host: string;
  port: number;
  publicUrl: string;
  connectUrl: string;
  resource: string;
  masterKey: SecretBox;
  trustProxy: boolean;
}

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv): McpRuntimeConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = integer(env.PORT ?? "8790", "PORT", 1, 65_535);
  const publicUrl = origin(env.PUBLIC_URL ?? `http://${host}:${port}`, "PUBLIC_URL");
  const connectUrl = origin(env.MDBASE_CONNECT_URL ?? "http://127.0.0.1:8787", "MDBASE_CONNECT_URL");
  const publicHost = new URL(publicUrl).hostname;
  const connectHost = new URL(connectUrl).hostname;
  if (new URL(publicUrl).protocol !== "https:" && !isLoopback(publicHost)) {
    throw new Error("PUBLIC_URL must use HTTPS outside loopback development.");
  }
  if (new URL(connectUrl).protocol !== "https:" && !isLoopback(connectHost)) {
    throw new Error("MDBASE_CONNECT_URL must use HTTPS outside loopback development.");
  }
  const masterKey = env.MDBASE_MCP_MASTER_KEY?.trim();
  if (!masterKey) throw new Error("MDBASE_MCP_MASTER_KEY is required.");
  return {
    host,
    port,
    publicUrl,
    connectUrl,
    resource: `${publicUrl}/mcp`,
    masterKey: SecretBox.fromSecret(masterKey),
    trustProxy: env.MDBASE_MCP_TRUST_PROXY === "1"
  };
}

function origin(value: string, name: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without credentials, a path, a query, or a fragment.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} must use HTTP or HTTPS.`);
  return url.origin;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
