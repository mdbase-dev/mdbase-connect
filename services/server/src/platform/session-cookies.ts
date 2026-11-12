import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * An HTTPS deployment issues only `__Host-mdbase_session`. The unprefixed name
 * is for plain-HTTP loopback development, and over HTTPS any sibling host could
 * set it, so an HTTPS deployment drops it before a handler reads the request.
 * Call after registering cookie parsing.
 */
export function acceptOnlyIssuedSessionCookie(app: FastifyInstance, publicUrl: string): void {
  if (sessionCookieName(publicUrl) === "mdbase_session") return;
  app.addHook("onRequest", async (request) => {
    delete request.cookies.mdbase_session;
  });
}

export function sessionToken(request: FastifyRequest): string | null {
  return request.cookies["__Host-mdbase_session"] ?? request.cookies.mdbase_session ?? null;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  publicUrl: string
): void {
  reply.setCookie(sessionCookieName(publicUrl), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: publicUrl.startsWith("https:"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie("mdbase_session", { path: "/" });
  reply.clearCookie("__Host-mdbase_session", { path: "/", secure: true });
}

export function sessionCookieName(publicUrl: string): string {
  return publicUrl.startsWith("https:")
    ? "__Host-mdbase_session"
    : "mdbase_session";
}

export function oauthStateCookieName(
  publicUrl: string,
  provider: "github" | "google"
): string {
  return publicUrl.startsWith("https:")
    ? `__Host-mdbase_oauth_${provider}`
    : `mdbase_oauth_${provider}`;
}
