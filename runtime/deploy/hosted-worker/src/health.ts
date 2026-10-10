/** LAB-only liveness. Never opens a DO or claims collection readiness. */
export function labHealth(request: Request, lab = false): Response | null {
  if (!lab || new URL(request.url).pathname !== "/health") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return new Response(request.method === "HEAD" ? null : '{"status":"ok"}', {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
