import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rustSource = await readFile(
  new URL("../../crates/connect-protocol/src/lib.rs", import.meta.url),
  "utf8"
);
const desktopSource = await readFile(
  new URL("../../apps/desktop/src/main/control-client.ts", import.meta.url),
  "utf8"
);

function protocolVersion(source, pattern, owner) {
  const match = source.match(pattern);
  assert.ok(match, `${owner} must declare the local control protocol version`);
  return Number(match[1]);
}

test("the desktop and Rust daemon use one local control protocol", () => {
  const rustVersion = protocolVersion(
    rustSource,
    /pub const LOCAL_CONTROL_PROTOCOL_VERSION: u32 = (\d+);/u,
    "Rust protocol"
  );
  const desktopVersion = protocolVersion(
    desktopSource,
    /const LOCAL_CONTROL_PROTOCOL_VERSION = (\d+);/u,
    "desktop client"
  );
  assert.equal(desktopVersion, rustVersion);
});
