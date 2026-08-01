import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [headers, html] = await Promise.all([
  readFile(resolve(root, "public/_headers"), "utf8"),
  readFile(resolve(root, "dist/index.html"), "utf8")
]);
const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];
if (!policy) throw new Error("public/_headers does not define a Content-Security-Policy.");

const scriptDirective = policy.split(";")
  .map((directive) => directive.trim())
  .find((directive) => directive.startsWith("script-src "));
if (!scriptDirective) throw new Error("The Content-Security-Policy has no script-src directive.");
if (scriptDirective.includes("'unsafe-inline'")) {
  throw new Error("script-src must not allow unsafe-inline scripts.");
}
for (const required of [
  "https://accounts.google.com/gsi/client",
  "frame-src https://accounts.google.com/gsi/",
  "https://accounts.google.com/gsi/style"
]) {
  if (!policy.includes(required)) {
    throw new Error(`The Content-Security-Policy does not allow the account provider source: ${required}`);
  }
}

const allowedHashes = new Set(scriptDirective.match(/'sha256-[^']+'/g) ?? []);
const inlineScripts = [...html.matchAll(/<script(?![^>]+\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]);
for (const script of inlineScripts) {
  const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
  if (!allowedHashes.has(hash)) {
    throw new Error(`The built application contains an inline script not allowed by CSP: ${hash}`);
  }
}

console.log(`CSP passed: ${inlineScripts.length} inline script${inlineScripts.length === 1 ? "" : "s"} covered by hash.`);
