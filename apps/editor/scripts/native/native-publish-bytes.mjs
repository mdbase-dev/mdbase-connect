import {createHash} from "node:crypto";
import {constants} from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Publication BYTE evidence only. No SDK/proof authentication, admission, hosting
 * policy approval, upload, rebuild or rollback. Inventory AFTER offline-shell
 * generation, then assert the immutable upload directory against that inventory.
 * The caller must keep the artifact immutable while it is read/uploaded; portable
 * Node path APIs cannot defend against a hostile concurrent directory renamer.
 *
 * Limits are hard ceilings; options may lower them. Paths use a deliberately
 * conservative ASCII URL/portable-filesystem subset (including dotfiles).
 */
const MiB = 1024 * 1024;
export const BYTE_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxEntries: 20_000,
  maxFileBytes: 128 * MiB,
  maxTotalBytes: 512 * MiB,
  maxPathBytes: 1024,
  maxDepth: 32,
  concurrency: 4,
  attempts: 3,
  timeoutMs: 10_000,
  totalTimeoutMs: 180_000,
  retryDelayMs: 1000,
  maxResponseBytes: 128 * MiB,
  maxTotalResponseBytes: 1536 * MiB,
});
const READ_BYTES = 64 * 1024;
const CONTROLS = new Set(["_headers", "_redirects", "_routes.json"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
class ByteError extends Error {
  constructor(reason, retryable) {
    super(reason);
    this.byteReason = reason;
    this.retryable = retryable;
  }
}
const problem = (reason, retryable = false) => new ByteError(reason, retryable);
function limitsFor(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw problem("invalid-options");
  const limits = {...BYTE_LIMITS};
  for (const name of Object.keys(limits)) {
    if (options[name] === undefined) continue;
    const value = options[name];
    if (!Number.isSafeInteger(value) || value < (name === "retryDelayMs" ? 0 : 1) || value > limits[name]) throw problem("invalid-limit");
    limits[name] = value;
  }
  return limits;
}
function safePath(name, limits) {
  if (typeof name !== "string" || !name || Buffer.byteLength(name) > limits.maxPathBytes) throw problem("invalid-path");
  const segments = name.split("/");
  if (segments.length > limits.maxDepth) throw problem("depth-limit");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === ".." || segment.endsWith(".") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)) throw problem("invalid-path");
  }
  return name;
}
function register(name, kind, registry, limits) {
  safePath(name, limits);
  const parts = name.split("/");
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join("/");
    const type = i === parts.length - 1 ? kind : "directory";
    const key = prefix.toLowerCase();
    const prior = registry.get(key);
    if (prior && (prior.path !== prefix || prior.kind !== type)) throw problem("ambiguous-path");
    if (prior && type === "file") throw problem("duplicate-path");
    registry.set(key, {path: prefix, kind: type});
    if (registry.size > limits.maxEntries) throw problem("entry-count-limit");
  }
}
function validateInventory(expected, limits) {
  if (!Array.isArray(expected)) throw problem("invalid-inventory");
  if (expected.length > limits.maxFiles) throw problem("file-count-limit");
  const registry = new Map();
  let total = 0;
  const inventory = [];
  for (const item of expected) {
    if (!item || typeof item !== "object") throw problem("invalid-inventory");
    register(item.path, "file", registry, limits);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw problem("invalid-inventory");
    if (item.bytes > limits.maxFileBytes) throw problem("file-size-limit");
    total += item.bytes;
    if (total > limits.maxTotalBytes) throw problem("total-size-limit");
    inventory.push({path: item.path, bytes: item.bytes, sha256: item.sha256});
  }
  return inventory.sort(comparePath);
}
function unchanged(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function checkedStat(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw problem("symlink");
  return stat;
}
async function checkedRoot(root) {
  if (typeof root !== "string" || !root || root.includes("\0")) throw problem("invalid-root");
  // Resolving first could erase link/.. and inspect a different directory than
  // an uploader opening the original path. Reject before ANY normalization.
  if (root.replaceAll("\\", "/").split("/").includes("..")) throw problem("invalid-root");
  const absolute = path.resolve(root);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!(await checkedStat(current)).isDirectory()) throw problem("nonregular-directory");
  }
  if (!(await checkedStat(absolute)).isDirectory()) throw problem("nonregular-directory");
  return absolute;
}
async function hashFile(filename, initial, limits) {
  if (constants.O_NOFOLLOW === undefined) throw problem("nofollow-unavailable");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw problem("nonregular-file");
    if (!unchanged(initial, before)) throw problem("file-changed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    let bytes = 0;
    for (;;) {
      // At most one byte beyond the declared size to detect growth, never readFile.
      const length = Math.min(buffer.length, before.size - bytes + 1);
      const {bytesRead} = await handle.read(buffer, 0, length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limits.maxFileBytes || bytes > before.size) throw problem("file-size-limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (bytes !== before.size || !unchanged(before, await handle.stat()) || !unchanged(before, await checkedStat(filename))) throw problem("file-changed");
    return {bytes, sha256: hash.digest("hex")};
  } finally { await handle.close(); }
}

/** Returns sorted {path, bytes, sha256} for EVERY regular final-upload file. */
export async function inventoryDirectory(root, options = {}) {
  const limits = limitsFor(options);
  try {
    const absolute = await checkedRoot(root);
    const registry = new Map();
    const inventory = [];
    let total = 0;
    let entries = 0;
    async function walk(directory, relative) {
      const before = await checkedStat(directory);
      if (!before.isDirectory()) throw problem("nonregular-directory");
      const iterator = await fs.opendir(directory, {bufferSize: 32});
      for await (const dirent of iterator) {
        if (++entries > limits.maxEntries) throw problem("entry-count-limit");
        const name = relative ? `${relative}/${dirent.name}` : dirent.name;
        safePath(name, limits);
        const filename = path.join(directory, dirent.name);
        const stat = await checkedStat(filename);
        if (stat.isDirectory()) {
          register(name, "directory", registry, limits);
          await walk(filename, name);
        } else {
          if (!stat.isFile()) throw problem("nonregular-file");
          register(name, "file", registry, limits);
          if (inventory.length >= limits.maxFiles) throw problem("file-count-limit");
          if (!Number.isSafeInteger(stat.size) || stat.size > limits.maxFileBytes) throw problem("file-size-limit");
          total += stat.size;
          if (total > limits.maxTotalBytes) throw problem("total-size-limit");
          inventory.push({path: name, ...await hashFile(filename, stat, limits)});
        }
      }
      if (!unchanged(before, await checkedStat(directory))) throw problem("directory-changed");
    }
    await walk(absolute, "");
    await checkedRoot(absolute);
    return inventory.sort(comparePath);
  } catch (error) {
    throw error instanceof ByteError ? error : problem("filesystem-error");
  }
}

/** Exact path-set/size/hash assertion; throws with safe .differences on mismatch. */
export async function assertInventory(root, expected, options = {}) {
  const inventory = validateInventory(expected, limitsFor(options));
  const actual = await inventoryDirectory(root, options);
  const wanted = new Map(inventory.map((item) => [item.path, item]));
  const found = new Map(actual.map((item) => [item.path, item]));
  const differences = [];
  for (const item of inventory) {
    const seen = found.get(item.path);
    const reason = !seen ? "missing-file" : seen.bytes !== item.bytes ? "length-mismatch" : seen.sha256 !== item.sha256 ? "hash-mismatch" : null;
    if (reason) differences.push({path: item.path, reason});
  }
  for (const item of actual) if (!wanted.has(item.path)) differences.push({path: item.path, reason: "extra-file"});
  if (differences.length) {
    const error = problem("inventory-mismatch");
    error.differences = differences.sort(comparePath);
    throw error;
  }
  return actual;
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (typeof value !== "string" || url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw Error();
    return url.origin;
  } catch { throw problem("invalid-origin"); }
}
function routeURL(value, origin, reason) {
  // Reject normalization (dot segments, authority spelling, escapes, query/hash).
  if (typeof value !== "string") throw problem(reason);
  const pathname = value.startsWith(origin + "/") ? value.slice(origin.length) : value;
  if (!pathname.startsWith("/") || pathname.startsWith("//") || !/^\/[A-Za-z0-9._~\/-]*$/.test(pathname)) throw problem(reason);
  const pieces = pathname.slice(1).split("/");
  if (pieces.some((piece, i) => piece === "." || piece === ".." || (piece === "" && i !== pieces.length - 1))) throw problem(reason);
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.href !== origin + pathname) throw problem(reason);
  return url.href;
}
function canonicalHTML(name, origin) {
  if (name === "index.html" || !name.endsWith(".html")) return null;
  return origin + "/" + (name.endsWith("/index.html") ? name.slice(0, -10) : name.slice(0, -5));
}
function routesFor(inventory, origin, mapping) {
  if (mapping === undefined) mapping = {};
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))) throw problem("invalid-url-mapping");
  const names = new Set(inventory.map((item) => item.path));
  for (const name of Object.keys(mapping)) if (!names.has(name) || CONTROLS.has(path.posix.basename(name))) throw problem("invalid-url-mapping");
  const used = new Map();
  const routes = new Map();
  for (const item of inventory) {
    if (CONTROLS.has(path.posix.basename(item.path))) continue;
    const mapped = Object.hasOwn(mapping, item.path);
    const url = mapped ? routeURL(mapping[item.path], origin, "invalid-url-mapping") : origin + (item.path === "index.html" ? "/" : "/" + item.path);
    const canonical = mapped ? null : canonicalHTML(item.path, origin);
    // Refuse two files claiming either the initial or permitted canonical URL.
    for (const address of new Set([url, canonical].filter(Boolean))) {
      if (used.has(address) && used.get(address) !== item.path) throw problem("ambiguous-url");
      used.set(address, item.path);
    }
    routes.set(item.path, {url, canonical});
  }
  return routes;
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function timed(work, ms, controller, reason) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => { reject(problem(reason, reason === "timeout")); controller?.abort(); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* No body/error contents in evidence. */ }
}
async function fetchBytes(item, route, origin, transport, limits, budget) {
  const controller = new AbortController();
  const deadline = performance.now() + limits.timeoutMs;
  const checkTimeout = () => {
    if (controller.signal.aborted || performance.now() >= deadline) {
      cancel(body); // Also cancel a transport response arriving AFTER the race timed out.
      throw problem("timeout", true);
    }
  };
  let reader;
  let body;
  let completed = false;
  try {
    return await timed(async () => {
      let url = route.url;
      let response;
      for (let redirects = 0; ; redirects++) {
        response = await transport(url, {
          method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
          headers: {"Accept-Encoding": "identity"}, signal: controller.signal,
        });
        body = response?.body;
        checkTimeout();
        if (response?.redirected) throw problem("unsafe-redirect");
        if (response?.url && response.url !== url) throw problem("unexpected-response-url");
        if (!REDIRECTS.has(response?.status)) break;
        cancel(body);
        const destination = routeURL(response.headers?.get("location"), origin, "unsafe-redirect");
        if (redirects !== 0 || !route.canonical || destination !== route.canonical || destination === url) throw problem("unsafe-redirect");
        url = destination;
      }
      if (response?.status !== 200) {
        const status = response?.status;
        if (!Number.isInteger(status) || status < 100 || status > 599) throw problem("invalid-response");
        throw problem(`http-status-${status}`, status === 404 || status === 408 || status === 429 || status >= 500);
      }
      const length = response.headers?.get("content-length");
      if (length !== null && length !== undefined) {
        if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw problem("invalid-content-length");
        if (Number(length) > limits.maxResponseBytes || Number(length) > item.bytes) throw problem("response-too-large");
      }
      if (!body || typeof body.getReader !== "function") throw problem("missing-body", true);
      reader = body.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      for (;;) {
        const {done, value} = await reader.read();
        // Also check the clock in case a synthetic stream never yields to timers.
        checkTimeout();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw problem("invalid-body-chunk");
        bytes += value.byteLength;
        budget.bytes += value.byteLength;
        if (budget.bytes > limits.maxTotalResponseBytes) throw problem("total-response-limit");
        if (bytes > limits.maxResponseBytes || bytes > item.bytes) throw problem("response-too-large");
        hash.update(value);
      }
      if (bytes !== item.bytes) throw problem("length-mismatch", true);
      const sha256 = hash.digest("hex");
      if (sha256 !== item.sha256) throw problem("hash-mismatch", true);
      completed = true;
      return {path: item.path, bytes, sha256, url};
    }, limits.timeoutMs, controller, "timeout");
  } catch (error) {
    throw error instanceof ByteError ? error : problem("transport-error", true);
  } finally {
    if (!completed) controller.abort();
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* bounded best-effort cancellation */ }
    } else cancel(body);
  }
}

/**
 * verifyServedBytes(approvedExactHttpsOrigin, inventory, options?)
 * options: lower BYTE_LIMITS, fetch/sleep (unit-test transport only), and
 * urlMapping: parent-TRUSTED {inventoryPath: sameOriginPathOrAbsoluteURL}.
 * Default root index.html -> /; only .html -> extensionless and dir/index.html
 * -> dir/ canonical redirects are allowed (one hop). Mapped URLs are fetched
 * directly and may NOT redirect. No queries, credentials, login/arbitrary or
 * cross-origin redirect following, request headers or auth bypass options.
 *
 * totalTimeoutMs bounds the WHOLE verification (default/hard ceiling 180s),
 * including retries/delays; unstarted assets fail with attempts:0 on exhaustion.
 * Returns {verified, unverified, failures}, each sorted by path. verified entries
 * are {path,bytes,sha256,url,attempts}; failures {path,reason,attempts}. Every
 * _headers/_redirects/_routes.json (even nested) is unverified with its inventory
 * bytes/hash, requiring parent trusted route/header policy checks. NEVER treat
 * an empty failures list as full publication, hosting-policy or admission proof.
 * Malformed input throws; retrieval failures retain safe reasons, not bodies.
 */
export async function verifyServedBytes(approvedExactHttpsOrigin, expected, options = {}) {
  const limits = limitsFor(options);
  const origin = exactOrigin(approvedExactHttpsOrigin);
  const inventory = validateInventory(expected, limits);
  const routes = routesFor(inventory, origin, options.urlMapping);
  const transport = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  if (typeof transport !== "function" || typeof sleep !== "function") throw problem("invalid-transport");
  const verified = [];
  const failures = [];
  const unverified = inventory.filter((item) => CONTROLS.has(path.posix.basename(item.path)))
    .map((item) => ({...item, reason: "hosting-control-requires-trusted-policy-check"}));
  const assets = inventory.filter((item) => routes.has(item.path));
  const budget = {bytes: 0};
  const deadline = performance.now() + limits.totalTimeoutMs;
  let publicationExhausted = false;
  const timeLeft = () => publicationExhausted ? 0 : Math.max(0, deadline - performance.now());
  let next = 0;
  async function worker() {
    while (next < assets.length) {
      const item = assets[next++];
      if (timeLeft() <= 0) {
        failures.push({path: item.path, reason: "publication-timeout", attempts: 0});
        continue;
      }
      for (let attempt = 1; attempt <= limits.attempts; attempt++) {
        const remaining = timeLeft();
        const publicationBound = remaining <= limits.timeoutMs;
        try {
          if (remaining <= 0) throw problem("publication-timeout");
          if (budget.bytes >= limits.maxTotalResponseBytes) throw problem("total-response-limit");
          const evidence = await fetchBytes(item, routes.get(item.path), origin, transport,
            {...limits, timeoutMs: Math.min(limits.timeoutMs, remaining)}, budget);
          if (timeLeft() <= 0) throw problem("publication-timeout");
          verified.push({...evidence, attempts: attempt});
          break;
        } catch (error) {
          // Timer resolution may fire a fraction early. A timeout capped by the
          // publication budget exhausts that budget, rather than starting more IO.
          if (publicationBound && error instanceof ByteError && error.byteReason === "timeout") publicationExhausted = true;
          const expired = timeLeft() <= 0;
          const reason = expired ? "publication-timeout" : error instanceof ByteError ? error.byteReason : "transport-error";
          if (expired || !(error instanceof ByteError && error.retryable) || attempt === limits.attempts) {
            failures.push({path: item.path, reason, attempts: attempt});
            break;
          }
          const delayBudget = timeLeft();
          try {
            await timed(() => sleep(limits.retryDelayMs), Math.min(limits.timeoutMs, delayBudget), null, "retry-delay-timeout");
          } catch (error) {
            if (delayBudget <= limits.timeoutMs && error instanceof ByteError && error.byteReason === "retry-delay-timeout") publicationExhausted = true;
            failures.push({path: item.path, reason: timeLeft() <= 0 ? "publication-timeout" : "retry-delay-timeout", attempts: attempt});
            break;
          }
        }
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(limits.concurrency, assets.length)}, worker));
  return {verified: verified.sort(comparePath), unverified, failures: failures.sort(comparePath)};
}
