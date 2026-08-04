import type { JsonObject, MdbaseApplicationSession } from "../../api-candidate/index.js";

interface PickleFrontmatter extends JsonObject {
  type: "pickle-request" | "pickle-response";
}

export async function pickleSpike(
  session: MdbaseApplicationSession<PickleFrontmatter>,
  deepLink: URL
): Promise<void> {
  const completed = await session.completeAuthorization(deepLink, { timeoutMs: 30_000 });
  if (!completed.ok) return;
  await completed.value.query({ types: ["pickle-request"] });
  await completed.value.create({
    path: "Pickle/response.md",
    frontmatter: { type: "pickle-response" },
    body: "approved"
  });
  const watch = await completed.value.watch({}, { timeoutMs: 10_000 });
  if (watch.ok) watch.value.subscribe(() => undefined, () => undefined);
}
