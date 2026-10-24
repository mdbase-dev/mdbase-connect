import source from "./main.tsx?raw";
import {expect,it} from "vitest";
it("Native callback leaves SAME popup lifetime to original SDK finish and custody ACK",()=>{
  expect(source).not.toMatch(/finally\(\(\)\s*=>\s*window\.close\(\)\)/);
});
