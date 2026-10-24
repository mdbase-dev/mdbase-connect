import { describe, expect, it } from "vitest";
import * as legacy from "../src/index/sqliteIndex.js";

describe("original runtime storage compatibility", () => {
  it("scopes pool names by collection id", () => {
    expect(legacy.poolNames("0F8E3C3A-7D2B-4C55-9D7E-0B6F3D2A1C11")).toEqual({ vfs: "mdbase-0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11", directory: ".mdbase-index-0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11" });
    expect(() => legacy.poolNames("../x")).toThrow();
  });
});
