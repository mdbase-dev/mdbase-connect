import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const generatedPublicScripts = new Set(["mdbase-shell-register.js"]);

/** Classify and validate every measured file, including public files outside assets/. */
export async function loadBundleAssets(root, references) {
  const distribution = await realpath(resolve(root, "dist"));
  let manifest;
  try {
    const worker = await readFile(resolve(distribution, "mdbase-shell-sw.js"), "utf8");
    const match = worker.match(/installOfflineShell\(self, (\{[^\n]*\})\);/);
    if (!match) throw new Error("Generated shell worker has no build manifest.");
    manifest = JSON.parse(match[1]);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const base = manifest?.base ?? "/";
  if (!base.startsWith("/") || base.startsWith("//") || !base.endsWith("/") || /[?#\\]/.test(base)) {
    throw new Error("Invalid distribution base path.");
  }
  return Promise.all([...new Set(references)].map(async reference => {
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//") || /[?#\\]/.test(reference)) {
      throw new Error("Built asset must be a local, query-free distribution file.");
    }
    const decoded = decodeURIComponent(reference);
    if (decoded.startsWith("//") || /[?#\\]/.test(decoded) || [...decoded].some(char => char.charCodeAt(0) < 32) || decoded.split("/").some(part => part === "." || part === "..")) {
      throw new Error("Built asset contains an unsafe path.");
    }
    if (decoded.startsWith("/") && !decoded.startsWith(base)) throw new Error("Built asset is outside the distribution base.");
    const path = decoded.startsWith("/") ? decoded.slice(base.length) : decoded;
    const file = await realpath(resolve(distribution, path));
    if (!file.startsWith(distribution + sep)) throw new Error("Built asset escapes the distribution directory.");
    const content = await readFile(file);
    if (path.startsWith("assets/")) return { path, kind: "bundle", content };
    if (generatedPublicScripts.has(path)) {
      const expected = manifest?.assets?.find(asset => asset.path === path)?.sha256;
      if (!expected || createHash("sha256").update(content).digest("hex") !== expected) {
        throw new Error("Generated public asset does not match its shell manifest.");
      }
      return { path, kind: "generated", content };
    }
    const publicRoot = await realpath(resolve(root, "public"));
    const source = await realpath(resolve(publicRoot, path));
    if (!source.startsWith(publicRoot + sep) || !content.equals(await readFile(source))) {
      throw new Error("Public asset differs from its declared public source.");
    }
    return { path, kind: "public", content };
  }));
}
