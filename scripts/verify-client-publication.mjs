#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Deliberately fixed: staging, redirects and caller-supplied origins cannot qualify.
const connectOrigin = "https://connect.mdbase.dev";
const mcpOrigin = "https://mcp.mdbase.dev";
const providerOrigin = "https://sync.mdbase.dev";

export function verifyPublicationSource({ event, ref, sha, head, version, verifiedCommit }) {
  if (event !== "workflow_dispatch" || !/^[0-9a-f]{40}$/.test(sha ?? "") ||
      head !== sha || verifiedCommit !== sha ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "") ||
      ref !== `refs/tags/v${version}`) {
    throw new Error("Publication requires the exact version tag and independently production-verified full commit.");
  }
}

export async function verifyProductionReadiness(sha, version, fetchImpl = globalThis.fetch) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error("Exact publication source and version are required before production reads.");
  }
  async function get(origin, path) {
    const response = await fetchImpl(`${origin}${path}`, {
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`${origin}${path}: HTTP ${response.status}`);
    return response.json();
  }
  const connect = await get(connectOrigin, "/health");
  if (connect?.ok !== true || connect.service !== "mdbase-connect" ||
      connect.revision !== sha || connect.environment !== "production" ||
      connect.public_origin !== connectOrigin || connect.protocol_version !== 1 ||
      !Array.isArray(connect.capabilities) ||
      !connect.capabilities.every((item) => typeof item === "string") ||
      !connect.capabilities.includes("application-authorization-v2-issuance")) {
    throw new Error("Canonical production Connect identity or fresh-v2 issuance evidence is absent or mismatched.");
  }
  const ready = await get(connectOrigin, "/ready");
  if (ready?.ok !== true || ready.service !== "mdbase-connect") {
    throw new Error("Canonical production Connect is not ready.");
  }
  const provider = await get(providerOrigin, "/ready");
  if (provider?.status !== "ready" || provider.provider?.version !== version ||
      provider.notifications?.recovery !== "ok" || provider.notifications?.consecutive_failures !== 0 ||
      !Array.isArray(provider.provider?.capabilities) ||
      !provider.provider.capabilities.every((item) => typeof item === "string") ||
      !provider.provider.capabilities.includes("application-authorization-v2-issuance")) {
    throw new Error("Canonical production provider version, recovery or fresh-v2 issuance evidence is absent or mismatched.");
  }
  const mcp = await get(mcpOrigin, "/health");
  if (mcp?.ok !== true || mcp.service !== "mdbase-mcp" || mcp.revision !== sha) {
    throw new Error("Canonical production MCP identity is absent or mismatched.");
  }
}

export function verifyRemotePublicationTag({ ref, version, sha }, api) {
  const tag = api(`git/ref/tags/v${version}`);
  if (tag.ref !== ref || tag.object?.type !== "tag" || !/^[0-9a-f]{40}$/.test(tag.object.sha ?? "")) throw new Error("An existing annotated release tag is required.");
  const target = api(`git/tags/${tag.object.sha}`);
  if (target.tag !== `v${version}` || target.object?.type !== "commit" || target.object.sha !== sha) {
    throw new Error("Remote release tag does not resolve to the exact publication source.");
  }
}

export async function main(env = process.env) {
  const sha = env.GITHUB_SHA;
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  verifyPublicationSource({
    event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha, version,
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    verifiedCommit: env.PRODUCTION_VERIFIED_COMMIT
  });
  if (env.GITHUB_REPOSITORY !== "mdbase-dev/mdbase-connect") throw new Error("Unexpected publication repository.");
  const api = (path) => JSON.parse(execFileSync("gh", ["api", `repos/mdbase-dev/mdbase-connect/${path}`], { encoding: "utf8" }));
  verifyRemotePublicationTag({ ref: env.GITHUB_REF, version, sha }, api);
  await verifyProductionReadiness(sha, version);
  console.log(`Production endpoint checks passed for v${version} (${sha}). Independent ops verification remains required; health does not prove unique deployment identity.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
