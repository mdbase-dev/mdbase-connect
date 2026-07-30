import type { FastifyReply, FastifyRequest } from "fastify";

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
