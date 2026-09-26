export function randomBase64Url(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

// Encrypted requests and responses carry whole records, so these run over
// megabytes: convert in chunks rather than one character at a time.
const CHUNK = 0x8000;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK) as unknown as number[]);
  }
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
  let end = encoded.length;
  while (end > 0 && encoded.charCodeAt(end - 1) === 61 /* = */) end -= 1;
  return encoded.slice(0, end);
}

export function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
