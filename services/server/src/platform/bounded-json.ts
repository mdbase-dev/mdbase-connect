// Small authenticated control replies only; not a limit on record/file APIs.
export async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RangeError("Control reply exceeds its byte bound.");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) return undefined;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(response, limit)));
}
