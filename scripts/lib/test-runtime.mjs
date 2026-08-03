import { createServer } from "node:net";

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function availableTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("Could not reserve a loopback TCP port");
  }
  await new Promise((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose())
  );
  return address.port;
}

export async function poll(
  action,
  failureMessage,
  attempts = 100,
  delayMilliseconds = 100
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(delayMilliseconds);
  }
  throw new Error(failureMessage, { cause: lastError });
}

export function phase(message, { prefix = "==", leadingNewline = true } = {}) {
  process.stdout.write(`${leadingNewline ? "\n" : ""}${prefix} ${message}\n`);
}
