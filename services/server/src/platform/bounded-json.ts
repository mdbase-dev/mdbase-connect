// Small authenticated control replies only; not a limit on record/file APIs.
export async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
