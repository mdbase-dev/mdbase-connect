import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Pairing } from "./authority-workflows";
import { api } from "./api";
vi.mock("./api", async importOriginal => ({...await importOriginal<typeof import("./api")>(),api:vi.fn()}));
const collections = [...Array.from({length:60},(_,i)=>({collection_id:`collection-${i}`,display_name:`[test] Notes ${i}`,role:"owner"})),{collection_id:"named-new",display_name:"New collection",role:"owner"},{collection_id:"named-create",display_name:"create collection",role:"owner"}];
function show(canCreate=true, selected="") {
  vi.mocked(api).mockClear();
  vi.mocked(api).mockResolvedValue({pairing:{connector_name:"Reader",approved_at:null,installation_device:true,kind:"app-runtime",account_selection_confirmed:true,attested:true,account_email:"test@example.test",app_origin:"https://reader.example",selected_collection_id:selected,can_create_collection:canCreate,collections}});
  render(<Pairing pairingId="pairing"/>);
  return screen.findByRole("listbox",{name:"Open in Reader"});
}
describe("approval collection chooser",()=>{
  it("pins explicit creation first, preserves stored names, and disables the empty placeholder",async()=>{
    const picker=await show();
    expect(picker).toHaveAttribute("size","6");
    const options=within(picker).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Choose a collection");
    expect(options[0]).toBeDisabled();
    expect(options[1]).toHaveTextContent("Create a new collection…");
    expect(screen.getByRole("option",{name:"New collection"})).toBeInTheDocument();
    expect(screen.getByRole("option",{name:"create collection"})).toBeInTheDocument();
    expect(picker).toHaveValue("");
  });
  it("filters the visible list without Escape, auto-selection or approval",async()=>{
    const picker=await show();picker.focus();
    fireEvent.change(screen.getByRole("searchbox",{name:"Find a collection"}),{target:{value:"notes 59"}});
    expect(within(picker).getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option",{name:"[test] Notes 59"})).toBeInTheDocument();
    expect(picker).toHaveValue("");expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("keeps the chosen collection visible when the query excludes it",async()=>{
    const picker=await show(false,"collection-8");fireEvent.change(screen.getByRole("searchbox",{name:"Find a collection"}),{target:{value:"notes 59"}});
    expect(picker).toHaveValue("collection-8");
    expect(screen.getByRole("option",{name:"[test] Notes 8"})).toHaveProperty("selected",true);
    expect(screen.queryByRole("option",{name:"Create a new collection…"})).not.toBeInTheDocument();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("announces no matches and restores the catalog after clearing search",async()=>{
    const picker=await show(false);const input=screen.getByRole("searchbox",{name:"Find a collection"});fireEvent.change(input,{target:{value:"absent-name"}});
    expect(screen.getByRole("status")).toHaveTextContent("No collections match");fireEvent.change(input,{target:{value:""}});
    expect(within(picker).getAllByRole("option")).toHaveLength(collections.length+1);
  });
  async function privateChoice(native="native-request") {
    vi.mocked(api).mockClear();
    vi.mocked(api).mockImplementation(async path=>String(path).endsWith("/approve") ? {ok:true} : {pairing:{
      connector_name:"Reader",approved_at:null,installation_device:true,kind:"app-runtime",account_selection_confirmed:true,attested:true,
      account_email:"test@example.test",fingerprint:"1234-5678-1234-5678",native_authorization_id:native||null,
      requested_create_collections:true,can_create_collection:true,
      collections:[{collection_id:"original-private",display_name:"[test] Original Private",role:"owner",kind:"private"}],
    }});
    render(<Pairing pairingId="pairing"/>);
    fireEvent.change(await screen.findByRole("listbox",{name:"Open in Reader"}),{target:{value:"original-private"}});
  }
  it("uses the SAME chooser/Approve for Private without creating or granting Hosted scopes",async()=>{
    await privateChoice();
    expect(screen.getByRole("listbox",{name:"Open in Reader"})).toHaveValue("original-private");
    expect(screen.queryByText("Advanced: allow more collections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Approve"}));
    await waitFor(()=>expect(vi.mocked(api)).toHaveBeenCalledWith("/v1/pairing-requests/pairing/approve",expect.objectContaining({method:"POST"})));
    const approval=vi.mocked(api).mock.calls.find(([path])=>String(path).endsWith("/approve"))!;
    expect(JSON.parse(approval[1]!.body as string)).toEqual({fingerprint:"1234-5678-1234-5678",collection_ids:[],create_collections:false,selected_collection_id:"original-private",selected_collection_kind:"private"});
    expect(vi.mocked(api).mock.calls.some(([path])=>String(path).endsWith("/collections"))).toBe(false);
  });
  it("does not approve Private from catalog metadata before its signed companion is prepared",async()=>{
    await privateChoice("");
    expect(screen.getByRole("button",{name:"Approve"})).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing Reader");
    expect(vi.mocked(api).mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
  });
});
