// Optional local-browser feature smoke; isolated from production and account data.
// Build SDK first. Supply PLAYWRIGHT_MODULE if Playwright is installed elsewhere.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const requested = process.argv.slice(2);
const names = requested.length ? requested : ["chromium"];
if (names.some((n) => !["chromium", "firefox", "webkit"].includes(n))) {
  throw new Error("browser must be chromium, firefox or webkit");
}
const module = process.env.PLAYWRIGHT_MODULE;
const playwright = await import(module ? pathToFileURL(module).href : "@playwright/test");
const probe = await readFile(new URL("../dist/app-host/storage-probe.js", import.meta.url), "utf8");
const worker = `
import { probeAppStorage } from '/probe.js';
const result = await probeAppStorage({worker: true, storage: navigator.storage, randomUUID: () => crypto.randomUUID()});
let remainingFiles = null;
if (result.supported) {
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('.mdbase-app-probes');
  remainingFiles = 0;
  for await (const entry of directory.entries()) remainingFiles++;
}
postMessage({result, remainingFiles});
`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url?.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(req.url === "/probe.js" ? probe : req.url === "/worker.js" ? worker : "<!doctype html><title>isolated app storage probe</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  for (const name of names) {
    const browser = await playwright[name].launch({ headless: true });
    try {
      // Fresh temporary browser context: no existing profiles or application data.
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const result = await page.evaluate(() => new Promise((resolve, reject) => {
        const worker = new Worker("/worker.js", { type: "module" });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("probe timed out")); }, 15000);
        worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error("probe Worker failed")); };
      }));
      console.log(JSON.stringify({ browser: name, version: browser.version(), ...result }));
      if (result.result.supported && result.remainingFiles !== 0) throw new Error("probe leaked scratch files");
      // The Chromium smoke is a gate. Others report capability, never qualify it.
      if (name === "chromium" && !result.result.supported) throw new Error("Chromium OPFS probe unsupported");
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
