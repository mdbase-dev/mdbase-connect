import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ConnectGateway } from "./connect.js";
import { createMcpServer } from "./mcp.js";
import type { OAuthService } from "./oauth.js";

const repository = new URL("../../../", import.meta.url);
const plugin = new URL("plugins/mdbase/", repository);
const TOOL_NAME = /`((?:list|add|reconnect|describe|query|release|read|validate|create|update|delete|rename)_[a-z_]+)`/g;

describe("mdbase ChatGPT plugin", () => {
  it("names exactly the tools the gateway registers", async () => {
    const server = createMcpServer(
      { clientId: "plugin-test", connectionSetId: "plugin-test", scopes: ["mdbase:read", "mdbase:write"] },
      {} as ConnectGateway,
      {} as OAuthService
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plugin-test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const registered = new Set((await client.listTools()).tools.map((tool) => tool.name));
    await client.close();

    const mentioned = new Set<string>();
    for (const file of await skillFiles()) {
      for (const match of (await readFile(file, "utf8")).matchAll(TOOL_NAME)) mentioned.add(match[1]);
    }

    expect([...mentioned].filter((name) => !registered.has(name))).toEqual([]);
    expect([...registered].filter((name) => !mentioned.has(name))).toEqual([]);
  });

  it("points at the managed gateway and ships the canonical icons", async () => {
    const mcp = JSON.parse(await readFile(new URL("mcp.json", plugin), "utf8"));
    expect(mcp.mcpServers.mdbase).toEqual({ type: "streamable-http", url: "https://mcp.mdbase.dev/mcp" });

    for (const [packaged, source] of [
      ["assets/logo.png", "assets/mdbase-app-icon-512.png"],
      ["assets/composer-icon.png", "assets/mdbase-app-icon-120.png"]
    ]) {
      const packagedIcon = await readFile(new URL(packaged, plugin));
      const sourceIcon = await readFile(new URL(source, repository));
      expect(packagedIcon.equals(sourceIcon), packaged).toBe(true);
    }
  });

  it("includes listing URLs and five positive and three negative review cases", async () => {
    const manifest = JSON.parse(await readFile(new URL("plugin.json", plugin), "utf8"));
    const extension = manifest.extensions["com.openai"];
    const listing = extension.interface;
    expect(listing.displayName.length).toBeLessThanOrEqual(30);
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4_000);
    for (const field of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(new URL(listing[field]).protocol).toBe("https:");
    }
    expect(extension.review.test_cases.positive).toHaveLength(5);
    expect(extension.review.test_cases.negative).toHaveLength(3);
    for (const reviewCase of [...extension.review.test_cases.positive, ...extension.review.test_cases.negative]) {
      expect(reviewCase.description.trim()).not.toBe("");
      expect(reviewCase.prompt.trim()).not.toBe("");
      expect(reviewCase.expected_behavior.trim()).not.toBe("");
    }
    for (const reviewCase of extension.review.test_cases.positive) {
      expect(reviewCase.tools_triggered.trim()).not.toBe("");
    }
    expect(extension.review).not.toHaveProperty("test_credentials");
    expect(extension.review).not.toHaveProperty("reviewer_instructions");
    expect(manifest).not.toHaveProperty("apps");
    expect(extension).not.toHaveProperty("apps");
  });
});

describe("mdbase Claude plugin", () => {
  it("shares the ChatGPT package's identity and gateway, and meets the directory's file rules", async () => {
    const read = async (path: string) => JSON.parse(await readFile(new URL(path, plugin), "utf8"));
    const manifest = await read(".claude-plugin/plugin.json");
    const portable = await read("plugin.json");
    for (const field of ["name", "version", "author", "license"]) {
      expect(manifest[field], field).toEqual(portable[field]);
    }
    expect((await read(".mcp.json")).mcpServers.mdbase).toEqual({
      type: "http",
      url: (await read("mcp.json")).mcpServers.mdbase.url
    });

    const packagedIcon = await readFile(new URL(manifest.icon, plugin));
    expect(packagedIcon.equals(await readFile(new URL("assets/mdbase-app-icon-512.png", repository)))).toBe(true);
    for (const field of ["documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"]) {
      expect(new URL(manifest[field]).protocol).toBe("https:");
    }
    const readme = (await readFile(new URL("README.md", plugin), "utf8")).replace(/```[\s\S]*?```/g, "");
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
  });
});

async function skillFiles(): Promise<string[]> {
  const entries = await readdir(fileURLToPath(new URL("skills/", plugin)), { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => join(entry.parentPath, entry.name));
}
