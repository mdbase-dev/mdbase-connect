import { readFile, readdir } from "node:fs/promises";

// Linux stat field22 (start time) prevents signalling/verifying a reused PID.
export function parseStat(text) {
  const end = text.lastIndexOf(")");
  if (end < 0) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  return /^[0-9]+$/.test(fields[19] ?? "") ? { state: fields[0], start: fields[19] } : null;
}
export async function ownedTree(pid) {
  const owned = [];
  const seen = new Set();
  async function visit(id) {
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) return;
    seen.add(id);
    try {
      const stat = parseStat(await readFile(`/proc/${id}/stat`, "utf8"));
      if (!stat) return;
      owned.push({ pid: id, start: stat.start });
      // children is per THREAD, not per process; Chromium/libuv may fork from
      // a non-leader thread. Read every task's numeric child list.
      const tasks = await readdir(`/proc/${id}/task`).catch(() => []);
      const lists = await Promise.all(tasks.filter(tid => /^[0-9]+$/.test(tid))
        .map(tid => readFile(`/proc/${id}/task/${tid}/children`, "utf8").catch(() => "")));
      for (const child of lists.join(" ").trim().split(/\s+/).filter(Boolean)) await visit(Number(child));
    } catch {}
  }
  await visit(pid);
  return owned;
}
async function alive(process) {
  try {
    const stat = parseStat(await readFile(`/proc/${process.pid}/stat`, "utf8"));
    return stat?.start === process.start && stat.state !== "Z";
  } catch { return false; }
}
export async function portListening(port) {
  try { await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) }); return true; }
  catch { return false; }
}
export async function verifyStopped(owned, port, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    if (!(await Promise.all(owned.map(alive))).some(Boolean) && !await portListening(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return false;
}
