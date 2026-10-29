import { expect, it } from "vitest";
import { collectionModeDigest } from "./collection-mode-proof.js";
const id = (n: number) => Buffer.alloc(16,n).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u,"$1-$2-$3-$4-$5");
it("matches the native mode proof vector and binds membership and prefix", () => {
  const input = {challenge:Buffer.alloc(32,7),connector:id(1),device:id(2),collection:id(3),request:id(4),target:"private" as const,finish:false,epoch:5n,seq:6n,chain:Buffer.alloc(32,9),members:[id(5),id(6)]};
  const original=Buffer.from(collectionModeDigest(input)).toString("hex");
  expect(original).toBe("1a43921d3da15d48921e70194727a6153d3f4b9d9195c9a8feeb5a092beeb45b");
  expect(Buffer.from(collectionModeDigest({...input,members:[id(5)]})).toString("hex")).not.toBe(original);
  expect(Buffer.from(collectionModeDigest({...input,seq:7n})).toString("hex")).not.toBe(original);
});
