/** LAB-only liveness. Never opens a DO or claims collection readiness. Names the
 * serving Worker version when bound, so a deploy can wait until it is served. */
export function labHealth(request: Request, lab = false, version?: string): Response | null {
  if (!lab || new URL(request.url).pathname !== "/health") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const body = JSON.stringify(version ? { status: "ok", version } : { status: "ok" });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
