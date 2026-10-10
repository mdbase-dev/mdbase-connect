// Minimal CDP client (Node 22 built-in WebSocket) for the e2e drivers.
export async function connect({ port = 9372, match = "app://obsidian.md", host = "127.0.0.1", tries = 60 } = {}) {
  let page;
  for (let i = 0; i < tries && !page; i++) {
    try {
      const list = await (await fetch(`http://${host}:${port}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes(match));
    } catch {}
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error(`no ${match} page on ${host}:${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else for (const h of handlers) h(m);
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  /** Evaluate an async JS expression in the page and return its JSON value. */
  const evaluate = async (expr, timeout = 600000) => {
    const r = await send("Runtime.evaluate", {
      expression: `(async () => JSON.stringify(await (async () => (${expr}))(), (k, v) => typeof v === "bigint" ? v.toString() : v))()`,
      awaitPromise: true,
      returnByValue: true,
      timeout,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 2000));
    if (r.error) throw new Error(JSON.stringify(r.error));
    const v = r.result?.result?.value;
    return v === undefined ? undefined : JSON.parse(v);
  };
  return { ws, send, evaluate, on: (h) => (handlers.add(h), () => handlers.delete(h)), close: () => ws.close() };
}

/** Wait until the e2e plugin is loaded, then run a suite. */
export async function waitPlugin(c, id = "mdbase-runtime-e2e") {
  for (let i = 0; i < 120; i++) {
    const ok = await c.evaluate(`!!(window.app?.plugins?.plugins?.["${id}"])`).catch(() => false);
    if (ok) return;
    // First start of a fresh profile: trust the vault's plugins (restricted mode off).
    await c
      .evaluate(`(async () => { const p = window.app?.plugins; if (p && !p.isEnabled?.()) { await p.setEnable(true); } if (p && !p.manifests?.["${id}"]) await p.loadManifests?.(); if (p && !p.plugins["${id}"]) await p.enablePluginAndSave?.("${id}"); return true; })()`)
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("plugin did not load");
}

export const suite = (c, name, opts = {}, id = "mdbase-runtime-e2e") => c.evaluate(`app.plugins.plugins["${id}"].suite(${JSON.stringify(name)}, ${JSON.stringify(opts)})`);
