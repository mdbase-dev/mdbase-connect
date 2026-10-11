// Test-carrier cleanup only. Never signal a discovered/unrelated PID: the
// caller supplies the exact ChildProcess it spawned. Cleanup uncertainty retains
// fixture state rather than certifying that a SIGKILL request finished.
export async function stopOwnedChild(child, timeoutMs = 3000) {
  if (!child) return;
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  if (stopped()) return;
  const waitForExit = () => new Promise((resolve) => {
    if (stopped()) { resolve(true); return; }
    const onExit = () => finish(true);
    const finish = (result) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const timer = setTimeout(() => finish(stopped()), timeoutMs);
    child.once("exit", onExit);
    if (stopped()) finish(true);
  });
  const terminate = waitForExit();
  child.kill("SIGTERM");
  if (await terminate) return;
  const killed = waitForExit();
  child.kill("SIGKILL");
  if (await killed) return;
  throw Error("Owned child cleanup unconfirmed; retain original fixture state");
}
