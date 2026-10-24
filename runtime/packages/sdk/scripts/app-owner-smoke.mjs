// Real Web Locks/Worker lifecycle smoke in two fresh localhost tabs.
// No existing profiles, SQLite/app accounts, Connect or production access.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "@playwright/test");
const owner = await readFile(new URL("../dist/app-host/owner.js", import.meta.url));
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/owner.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/owner.js" ? owner : "<!doctype html><title>isolated owner lifecycle smoke</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const scope = { account: "00000000-0000-4000-8000-000000000001", installation: "00000000-0000-4000-8000-000000000002", collection: "00000000-0000-4000-8000-000000000003" };
try {
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const first = await context.newPage(); const second = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await first.goto(origin); await second.goto(origin);
  await first.evaluate(async (scope) => {
    const { openOwnedAppWorker } = await import("/owner.js");
    let worker, url;
    const rpc = () => new Promise((resolve) => { worker.onmessage = () => resolve(); worker.postMessage("request"); });
    window.trace = [];
    window.owned = await openOwnedAppWorker({
      locks: navigator.locks, scope,
      create: () => {
        url = URL.createObjectURL(new Blob(["onmessage=()=>postMessage('ok')"], { type: "text/javascript" }));
        worker = new Worker(url);
        return { stop: async () => { await rpc(); window.trace.push("stopped"); }, terminate: () => { worker.terminate(); URL.revokeObjectURL(url); window.trace.push("terminated"); } };
      },
      initialize: async () => rpc(),
    });
  }, scope);
  const busy = await second.evaluate(async (scope) => {
    const { acquireAppReplicaLease } = await import("/owner.js");
    try { const lease = await acquireAppReplicaLease(navigator.locks, scope); await lease.release(); return "unexpected_owner"; }
    catch (error) { return error.reason; }
  }, scope);
  if (busy !== "busy") throw new Error("second tab acquired a live owner's lock");
  const otherCollection = await second.evaluate(async (scope) => {
    const { openOwnedAppWorker } = await import("/owner.js");
    let created = false;
    try {
      await openOwnedAppWorker({ locks: navigator.locks, scope: { ...scope, collection: scope.account },
        create: () => { created = true; throw Error("should not unwrap/open another Worker"); }, initialize: async () => {} });
      return { reason: "unexpected_owner", created };
    } catch (error) { return { reason: error.reason, created }; }
  }, scope);
  if (otherCollection.reason !== "busy" || otherCollection.created) throw new Error("second collection bypassed installation custody ownership");
  const trace = await first.evaluate(async () => { await window.owned.close(); return window.trace; });
  if (trace.join(",") !== "stopped,terminated") throw new Error("Worker did not stop before unlock");
  const afterClose = await second.evaluate(async (scope) => {
    const { acquireAppReplicaLease } = await import("/owner.js");
    const lease = await acquireAppReplicaLease(navigator.locks, scope); await lease.release();
    return (await navigator.locks.query()).held.length;
  }, scope);
  const hung = await first.evaluate(async (scope) => {
    const { openOwnedAppWorker } = await import("/owner.js");
    let worker, url; let terminated = false;
    const owned = await openOwnedAppWorker({
      locks: navigator.locks, scope, closeTimeoutMs: 25,
      create: () => {
        url = URL.createObjectURL(new Blob(["onmessage=()=>{}"], { type: "text/javascript" }));
        worker = new Worker(url);
        return { stop: () => new Promise(() => {}), terminate: () => { worker.terminate(); URL.revokeObjectURL(url); terminated = true; } };
      },
      initialize: async () => {},
    });
    await owned.close();
    return { terminated, held: (await navigator.locks.query()).held.length };
  }, scope);
  if (afterClose !== 0 || !hung.terminated || hung.held !== 0) throw new Error("owner lock/Worker leaked");
  console.log(JSON.stringify({ browser: browser.version(), secondTab: busy, otherCollection, trace, afterCloseHeld: afterClose, hung }));
  await context.close();
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
