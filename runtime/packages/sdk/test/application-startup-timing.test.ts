import {afterEach,expect,it,vi} from "vitest";
import type {MdbasePhase} from "../src/application/phase.js";
import {ApplicationStartupTiming} from "../src/application/startup-timing.js";

const U="11111111-1111-4111-8111-111111111111";
const opening=(progress?:"opening_store"|"checking_setup"):MdbasePhase=>({kind:"opening",collectionId:U,displayName:null,slow:false,...(progress?{progress}:{})});
const usable={kind:"unsynced",collectionId:U,connection:{},rechecking:false} as unknown as MdbasePhase;
function clock(){
  let now=0;const measures:[string,number,number][]=[];
  vi.stubGlobal("performance",{now:()=>now,measure:(name:string,o:{start:number;end:number})=>{measures.push([name,o.start,o.end]);}});
  return {measures,advance(ms:number){now+=ms;}};
}
afterEach(()=>{vi.unstubAllGlobals();});

it("measures each step and phase once, with fixed names, until a collection is usable",async()=>{
  const c=clock(),timing=new ApplicationStartupTiming();
  c.advance(5);timing.observe({kind:"starting"});
  expect(await timing.time("registration",async()=>{c.advance(20);return 7;})).toBe(7);
  timing.observe({kind:"starting"});
  c.advance(10);timing.observe(opening());
  c.advance(30);timing.observe(opening("checking_setup"));
  // A step still running when the usable phase shows is measured when it settles.
  const unsynced=timing.time("unsynced",async()=>{c.advance(40);timing.observe(usable);c.advance(2);});
  await unsynced;
  // Nothing begun after the first usable phase: later openings are not startup.
  c.advance(50);timing.observe(opening());await timing.time("session",async()=>{c.advance(1);});
  expect(c.measures).toEqual([
    ["mdbase:startup:registration",5,25],
    ["mdbase:startup:starting",5,35],
    ["mdbase:startup:opening",35,65],
    ["mdbase:startup:opening:checking_setup",65,105],
    ["mdbase:startup:total",0,105],
    ["mdbase:startup:unsynced",65,107],
  ]);
});

it("ends without a total where the person is asked for something, and keeps a failed step's outcome",async()=>{
  const c=clock(),timing=new ApplicationStartupTiming();
  timing.observe({kind:"starting"});
  await expect(timing.time("session",async()=>{c.advance(3);throw new Error("refused");})).rejects.toThrow("refused");
  c.advance(4);timing.observe({kind:"signed_out",notice:null});
  c.advance(60_000);timing.observe(usable);
  expect(c.measures).toEqual([["mdbase:startup:session",0,3],["mdbase:startup:starting",0,7]]);
});

it("does nothing, and changes no outcome, without User Timing",async()=>{
  vi.stubGlobal("performance",undefined);
  const timing=new ApplicationStartupTiming();
  timing.observe({kind:"starting"});
  expect(await timing.time("capabilities",async()=>"ok")).toBe("ok");
  vi.stubGlobal("performance",{now:()=>0,measure:()=>{throw new Error("unsupported");}});
  const throwing=new ApplicationStartupTiming();
  throwing.observe({kind:"starting"});throwing.observe(usable);
  expect(await throwing.time("capabilities",async()=>"ok")).toBe("ok");
});
