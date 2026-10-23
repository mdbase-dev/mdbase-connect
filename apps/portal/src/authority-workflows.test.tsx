import { fireEvent, render, screen, waitFor, within } from "./test/render";
import { describe, expect, it, vi } from "vitest";
import { Pairing } from "./authority-workflows";
import { api } from "./api";
vi.mock("./api", async importOriginal => ({...await importOriginal<typeof import("./api")>(),api:vi.fn()}));
const collections = [...Array.from({length:160},(_,i)=>({collection_id:`collection-${i}`,display_name:`[test] Notes ${i}`,role:"owner"})),{collection_id:"named-new",display_name:"New collection",role:"owner"},{collection_id:"named-create",display_name:"create collection",role:"owner"}];
async function show(canCreate=true, selected="", hint=selected) {
  vi.mocked(api).mockClear();
  vi.mocked(api).mockResolvedValue({pairing:{connector_name:"Reader",approved_at:null,installation_device:true,kind:"app-runtime",account_selection_confirmed:true,attested:true,account_email:"test@example.test",app_origin:"https://reader.example",selected_collection_id:selected,collection_hint:hint,can_create_collection:canCreate,collections}});
  const view=render(<Pairing pairingId="pairing"/>);
  return {...view,picker:await screen.findByRole("listbox",{name:"Open in Reader"}),input:screen.getByRole("combobox",{name:"Open in Reader"})};
}
describe("approval collection chooser",()=>{
  it("replaces the native select with one combobox/listbox and an explicit creation button",async()=>{
    const f=await show();
    expect(f.container.querySelector("select")).toBeNull();
    expect(within(f.picker).getAllByRole("option")).toHaveLength(collections.length);
    expect(screen.getByRole("button",{name:"Create a new collection…"})).toBeInTheDocument();
    expect(screen.getByRole("option",{name:"New collection"})).toBeInTheDocument();
    expect(screen.getByRole("option",{name:"create collection"})).toBeInTheDocument();
    expect(screen.queryAllByRole("option",{selected:true})).toEqual([]);
    expect(screen.getByRole("button",{name:"Open Reader"})).toBeDisabled();
  });
  it("filters without Escape, auto-selection or approval and names the explicit choice",async()=>{
    const f=await show();f.input.focus();
    fireEvent.change(f.input,{target:{value:"notes 159"}});
    expect(within(f.picker).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(f.input,{key:"Enter"});expect(screen.queryAllByRole("option",{selected:true})).toEqual([]);
    fireEvent.keyDown(f.input,{key:"ArrowDown"});expect(screen.queryAllByRole("option",{selected:true})).toEqual([]);
    fireEvent.keyDown(f.input,{key:"Enter"});
    expect(screen.getByRole("option",{name:"[test] Notes 159"})).toHaveAttribute("aria-selected","true");
    expect(screen.getByRole("button",{name:"Open Reader with [test] Notes 159"})).toBeEnabled();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("does not preselect a collection hint on a fresh approval",async()=>{
    const f=await show(false,"","collection-8");
    expect(screen.queryAllByRole("option",{selected:true})).toEqual([]);
    expect(screen.getByRole("button",{name:"Open Reader"})).toBeDisabled();
    expect(screen.queryByRole("button",{name:"Create a new collection…"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option",{name:"[test] Notes 8"}));
    fireEvent.change(f.input,{target:{value:"notes 159"}});
    expect(screen.queryByRole("option",{name:"[test] Notes 8"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Open Reader with [test] Notes 8"})).toBeEnabled();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("announces no matches and restores the catalog after clearing search",async()=>{
    const f=await show(false);fireEvent.change(f.input,{target:{value:"absent-name"}});
    expect(screen.getByRole("status")).toHaveTextContent("No collections match");fireEvent.change(f.input,{target:{value:""}});
    expect(within(f.picker).getAllByRole("option")).toHaveLength(collections.length);
  });
  it("keeps creation an explicit choice with its named approval and no mutation from selection",async()=>{
    await show();fireEvent.click(screen.getByRole("button",{name:"Create a new collection…"}));
    expect(screen.getByRole("button",{name:"Open Reader with a new collection"})).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox",{name:"New collection name"}),{target:{value:"New notes"}});
    expect(screen.getByRole("button",{name:"Open Reader with New notes"})).toBeEnabled();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
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
    fireEvent.click(await screen.findByRole("option",{name:"[test] Original Private"}));
  }
  it("uses the SAME chooser/confirm for Private without creating or granting Hosted scopes",async()=>{
    await privateChoice();
    expect(screen.getByRole("option",{name:"[test] Original Private"})).toHaveAttribute("aria-selected","true");
    expect(screen.queryByText("Advanced: allow more collections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Open Reader with [test] Original Private"}));
    await waitFor(()=>expect(vi.mocked(api)).toHaveBeenCalledWith("/v1/pairing-requests/pairing/approve",expect.objectContaining({method:"POST"})));
    const approval=vi.mocked(api).mock.calls.find(([path])=>String(path).endsWith("/approve"))!;
    expect(JSON.parse(approval[1]!.body as string)).toEqual({fingerprint:"1234-5678-1234-5678",collection_ids:[],create_collections:false,selected_collection_id:"original-private",selected_collection_kind:"private"});
    expect(vi.mocked(api).mock.calls.some(([path])=>String(path).endsWith("/collections"))).toBe(false);
  });
  it("does not approve Private from catalog metadata before its signed companion is prepared",async()=>{
    await privateChoice("");
    expect(screen.getByRole("status")).toHaveTextContent("Preparing Reader");
    fireEvent.click(screen.getByRole("button",{name:"Open Reader with [test] Original Private"}));
    await waitFor(() => expect(screen.getByRole("button",{name:"Approving…"})).toBeDisabled());
    expect(vi.mocked(api).mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
  });
});
