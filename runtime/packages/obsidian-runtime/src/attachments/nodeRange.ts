import type { FileHandle } from "node:fs/promises";
import { ATTACHMENT_RANGE_BYTES, AttachmentRangeError, type RangeBackend } from "./range.js";

/**
 * Native bounded IO over an ALREADY OPEN handle. Ownership transfers to the
 * backend. This does not resolve paths or establish vault/root confinement:
 * the host must safely open/confine the regular file before handing it over.
 * Import from the Node-only entry; never load Node APIs into mobile/web builds.
 */
export function nodeRangeBackend(handle: FileHandle): RangeBackend {
  return {
    async snapshot() {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink === 0n || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new AttachmentRangeError("unsupported");
      return {
        kind: "file" as const,
        identity: `${stat.dev}:${stat.ino}`,
        version: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
        size: Number(stat.size),
      };
    },
    async readInto(offset, target) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - target.length)
        throw new AttachmentRangeError("invalid_range");
      if (target.length > ATTACHMENT_RANGE_BYTES) throw new AttachmentRangeError("full");
      const result = await handle.read(target, 0, target.length, offset);
      return result.bytesRead;
    },
    close: () => handle.close(),
  };
}
