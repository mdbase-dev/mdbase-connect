import Fastify, { LogController } from "fastify";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { MdbaseAppManifest } from "@mdbase/connect-protocol";
import { ZodError, z } from "zod";
import type { DatabasePool } from "./db.js";
import type { McpRuntimeConfig } from "./config.js";
import { PostgresGrantKeyStore } from "./key-store.js";
import { ConnectGateway } from "./connect.js";
import { createMcpServer } from "./mcp.js";
import { MCP_SCOPES, OAuthError, OAuthService } from "./oauth.js";
import { verifyMasterKey } from "./security.js";

interface BuildOptions {
  db: DatabasePool;
  config: McpRuntimeConfig;
  revision?: string;
}

export async function buildApp(options: BuildOptions) {
  const { config } = options;
  await verifyMasterKey(options.db, config.masterKey);
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 40_000
  });
  const keyStore = new PostgresGrantKeyStore(options.db, config.masterKey);
  const manifest: MdbaseAppManifest = {
    manifest_version: 1,
    id: "dev.mdbase.mcp",
    name: "mdbase",
    homepage: config.publicUrl,
    redirect_uris: [`${config.publicUrl}/oauth/connect/callback`],
    requirements: { access: "full_collection", contracts: [] },
    provisions: { type_packs: [] }
  };
  const gateway = new ConnectGateway(
    options.db,
    config.masterKey,
    keyStore,
    config.connectUrl,
    manifest,
    `${config.publicUrl}/oauth/connect/callback`
  );
  const oauth = new OAuthService(options.db, gateway, keyStore, config.publicUrl, config.resource);
  const resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

  await app.register(formbody);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        styleSrc: ["'unsafe-inline'"]
      }
    },
    crossOriginEmbedderPolicy: false
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OAuthError) {
      return reply.code(400).send({ error: error.code, error_description: error.message });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        error_description: "The request is invalid.",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const statusCode = httpErrorStatus(error);
    if (statusCode === 413) {
      return reply.code(413).send({
        error: "invalid_request",
        error_description: "The request body exceeds the allowed size."
      });
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: "invalid_request",
        error_description: "The request body is invalid."
      });
    }
    request.log.error({ err: error }, "MCP gateway request failed");
    return reply.code(500).send({ error: "server_error", error_description: "The MCP gateway request failed." });
  });

  app.get("/health", async () => ({ ok: true, service: "mdbase-mcp", revision: options.revision ?? null }));
  app.get("/ready", async (_request, reply) => {
    try {
      await options.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(page(
    "mdbase",
    "Connect Claude, ChatGPT, and other MCP clients to collections you explicitly approve in mdbase connect."
  )));

  app.get("/.well-known/mdbase-app.json", async () => manifest);

  const protectedResourceMetadata = {
    resource: config.resource,
    authorization_servers: [config.publicUrl],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "mdbase collections"
  };
  app.get("/.well-known/oauth-protected-resource", async () => protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => protectedResourceMetadata);
  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    scopes_supported: MCP_SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  }));

  app.post("/oauth/register", async (request, reply) => {
    const client = await oauth.registerClient(request.body);
    return reply.code(201).send(client);
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const redirect = await oauth.beginAuthorization(request.query);
    return reply.redirect(redirect);
  });

  app.post("/oauth/token", async (request) => oauth.exchangeToken(request.body));

  app.get("/oauth/connect/callback", async (request, reply) => {
    const query = z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional()
    }).passthrough().parse(request.query);
    const completed = await oauth.completeUpstream(query);
    if (completed.redirect) return reply.redirect(completed.redirect);
    if (completed.error) return reply.code(400).type("text/html; charset=utf-8").send(page("Access not added", completed.error));
    return reply.type("text/html; charset=utf-8").send(page(
      "Collection connected",
      `${completed.connectionName ?? "The collection"} is now available. Return to your MCP application and list connections again.`
    ));
  });

  app.get("/connections/new", async (request, reply) => {
    const { ticket } = z.object({ ticket: z.string().min(1).max(200) }).parse(request.query);
    const redirect = await oauth.consumeConnectionTicket(ticket);
    return reply.redirect(redirect);
  });

  app.post("/mcp", async (request, reply) => {
    const context = await authenticateRequest(request.headers.authorization, oauth);
    if (!context) return unauthorized(reply, resourceMetadataUrl);
    const server = createMcpServer(context, gateway, oauth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP protocol request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        }));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (request, reply) => {
        const context = await authenticateRequest(request.headers.authorization, oauth);
        if (!context) return unauthorized(reply, resourceMetadataUrl);
        return reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed for this stateless MCP server." },
          id: null
        });
      }
    });
  }

  return { app, oauth, gateway };
}

async function authenticateRequest(authorization: string | undefined, oauth: OAuthService) {
  if (!authorization?.startsWith("Bearer ")) return null;
  return oauth.authenticate(authorization.slice(7));
}

function httpErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function unauthorized(reply: any, resourceMetadataUrl: string) {
  reply.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="${MCP_SCOPES.join(" ")}"`
  );
  return reply.code(401).send({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authorization required." },
    id: null
  });
}

function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · mdbase</title>
<style>
  :root { color: #20242b; background: #fff; font: 15px/1.55 system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { width: min(36rem, calc(100% - 3rem)); }
  .brand { font: 600 14px ui-monospace, monospace; margin-bottom: 3rem; }
  .dot { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: #2873a5; }
  h1 { margin: 0 0 .75rem; font-size: 1.55rem; }
  p { margin: 0; max-width: 60ch; color: #66707c; }
</style>
<main><div class="brand"><span class="dot"></span>mdbase</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!);
}
