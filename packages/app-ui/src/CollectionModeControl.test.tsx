// @vitest-environment jsdom
import { mkdir, writeFile } from "node:fs/promises";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "./i18n.js";
import { CollectionModeControl } from "./CollectionModeControl.js";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root: Root | undefined;
let host: HTMLDivElement;
const state = (mode="cloud_copy", change:unknown=null) => ({execution_available:true,current_mode:mode,change});
async function mount(load:()=>Promise<unknown>,change:(target:"private"|"cloud_copy",requestId:string)=>Promise<unknown>=vi.fn(async()=>({})),native=false,id="one") {
  host ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(host);
  await act(async()=>root!.render(<I18nProvider i18n={i18n}><CollectionModeControl collectionId={id} load={load} change={change} native={native}/></I18nProvider>));
  return change;
}
const click = async (label:string) => {const button=[...host.querySelectorAll("button")].find(b=>b.textContent===label)!; expect(button).toBeTruthy(); await act(async()=>button.click());};
afterEach(()=>{if(root) act(()=>root!.unmount());root=undefined; document.body.innerHTML="";host=undefined!;});
it("hides controls for older/unregistered executors, malformed status and non-owners",async()=>{
  for(const load of [async()=>({...state(),execution_available:false}),async()=>({current_mode:"cloud_copy",change:null}),async()=>({execution_available:true,current_mode:"wrong"}),async()=>{throw Error("forbidden");}]) {
    await mount(load);expect(host.textContent).toBe("");
    act(()=>root!.unmount());root=undefined;
  }
});
it("records portal intent without claiming completion or offering native consent",async()=>{
  let value=state(); const load=vi.fn(async()=>value);
  const change=vi.fn(async()=>{value=state("cloud_copy",{target_mode:"private",phase:"waiting_for_device"});return value;});
  await mount(load,change); await click("Make private");
  expect(change).toHaveBeenCalledWith("private",expect.any(String));
  expect(host.textContent).toContain("owner's devices");
  expect(host.textContent).not.toContain("Continue on this device");
  expect(host.textContent).toContain("Cloud copy");
});
it("preserves the request identifier after an uncertain intent response",async()=>{
  const change=vi.fn(async()=>{throw Error("lost response");});
  await mount(async()=>state(),change);await click("Make private");await click("Make private");
  expect(change.mock.calls[0]).toEqual(change.mock.calls[1]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("may already have started");
});
it("uses a fresh request on the next direction, not a completed operation",async()=>{
  let value=state();const change=vi.fn(async(target:string,_requestId:string)=>{value=state(target);return {};});
  await mount(async()=>value,change);await click("Make private");await click("Turn on Cloud copy");
  expect(change.mock.calls[0]?.[1]).not.toEqual(change.mock.calls[1]?.[1]);
});
it("shows native update blockers, retry time and continuation without claiming Private",async()=>{
  const value=state("cloud_copy",{target_mode:"private",phase:"waiting_for_device"});
  const change=vi.fn(async()=>({phase:"waiting_for_devices",devices:["device-one"],retry_at:"2030-01-01T00:00:00Z"}));
  await mount(async()=>value,change,true);await click("Continue on this device");
  expect(host.textContent).toContain("Update or revoke");expect(host.textContent).toContain("device-one");
  expect(host.querySelector("time")?.dateTime).toBe("2030-01-01T00:00:00Z");
  expect(host.textContent).toContain("Cloud copy");
  // Content-only fixture for batched real-browser light/dark/mobile layout checks.
  await mkdir("test-results",{recursive:true});
  await writeFile("test-results/mode-control.html",host.innerHTML);
});
it("ignores a stale response after switching collection",async()=>{
  let resolve!:(value:unknown)=>void;const old=new Promise<unknown>(r=>{resolve=r;});
  await mount(()=>old);await mount(async()=>state("private"),undefined,false,"two");
  await act(async()=>resolve(state("cloud_copy")));
  expect(host.textContent).toContain("Turn on Cloud copy");expect(host.textContent).not.toContain("Make private");
});
