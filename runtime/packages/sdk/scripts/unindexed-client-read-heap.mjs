/** Measurement-only, non-forcing CDP checkpoints. No GC, snapshots, or JS/WASM sum. */
export async function observeBrowserHeaps(context, page, origin) {
  const browser = context.browser();
  if (!browser) throw Error('Chromium browser CDP session unavailable');
  const root = await browser.newBrowserCDPSession();
  const main = await context.newCDPSession(page);
  let session, sequence = 0, attaching = false, closed = false, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const pending = new Map();
  const attach = async info => {
    if (closed || attaching || info.type !== 'worker' || info.url !== origin + '/worker.js') return;
    attaching = true;
    try { session = (await root.send('Target.attachToTarget', {targetId: info.targetId, flatten: false})).sessionId; resolveReady(); }
    catch (error) { resolveReady(error); }
  };
  root.on('Target.targetCreated', event => { void attach(event.targetInfo); });
  root.on('Target.targetInfoChanged', event => { void attach(event.targetInfo); });
  root.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== session) return;
    const message = JSON.parse(event.message), call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(Error(message.error.message)); else call.resolve(message.result);
  });
  await root.send('Target.setDiscoverTargets', {discover: true});
  const workerCall = async method => {
    let timer;
    try {
      const error = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('worker inspector attachment deadline')), 10000); })]);
      if (error) throw error;
    } finally { clearTimeout(timer); }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('worker heap checkpoint deadline')); }, 10000);
      pending.set(id, {resolve, reject, timer});
      root.send('Target.sendMessageToTarget', {sessionId: session, message: JSON.stringify({id, method})})
        .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  };
  const fields = value => {
    for (const key of ['usedSize', 'backingStorageSize']) {
      if (!Number.isFinite(value[key]) || value[key] < 0) throw Error('CDP missing ' + key);
    }
    return {usedSize: value.usedSize, totalSize: value.totalSize, backingStorageSize: value.backingStorageSize,
      embedderHeapUsedSize: value.embedderHeapUsedSize ?? null};
  };
  await page.exposeFunction('__readHeapPhase', async () => {
    const [window, worker] = await Promise.all([main.send('Runtime.getHeapUsage'), workerCall('Runtime.getHeapUsage')]);
    return {window: fields(window), worker: fields(worker), forceGcBeforeSample: false,
      method: 'CDP Runtime.getHeapUsage; non-forcing checkpoint samples, not whole-isolate/transient peaks'};
  });
  return async () => {
    closed = true;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('heap observer closed')); }
    pending.clear();
    await Promise.allSettled([main.detach(), root.detach()]);
  };
}
