import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Pairing } from "./authority-workflows";
import { api } from "./api";
vi.mock("./api", async importOriginal => ({...await importOriginal<typeof import("./api")>(),api:vi.fn()}));
const collections = [...Array.from({length:60},(_,i)=>({collection_id:`collection-${i}`,display_name:`[test] Notes ${i}`,role:"owner"})),{collection_id:"named-new",display_name:"New collection",role:"owner"},{collection_id:"named-create",display_name:"create collection",role:"owner"}];
function show(canCreate=true, selected="") {
  vi.mocked(api).mockClear();
  vi.mocked(api).mockResolvedValue({pairing:{connector_name:"Reader",approved_at:null,installation_device:true,kind:"app-runtime",account_selection_confirmed:true,attested:true,account_email:"test@example.test",app_origin:"https://reader.example",selected_collection_id:selected,can_create_collection:canCreate,collections}});
  render(<Pairing pairingId="pairing"/>);
  return screen.findByRole("combobox",{name:"Open in Reader"});
}
describe("approval collection chooser",()=>{
  it("pins explicit creation first, preserves stored names, and omits a selectable placeholder",async()=>{
    const picker=await show();fireEvent.click(picker);
    const options=within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Create a new collection…");
    expect(screen.queryByRole("option",{name:"Choose a collection"})).not.toBeInTheDocument();
    expect(screen.getByRole("option",{name:"New collection"})).toBeInTheDocument();
    expect(screen.getByRole("option",{name:"create collection"})).toBeInTheDocument();
  });
  it("filters by substring without auto-selecting or approving anything",async()=>{
    const picker=await show();fireEvent.change(screen.getByRole("searchbox",{name:"Find a collection"}),{target:{value:"notes 59"}});fireEvent.click(picker);
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option",{name:"[test] Notes 59"})).toBeInTheDocument();
    expect(picker).toHaveAttribute("data-value","");expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("keeps the chosen collection visible when the query excludes it",async()=>{
    const picker=await show(false,"collection-8");fireEvent.change(screen.getByRole("searchbox",{name:"Find a collection"}),{target:{value:"notes 59"}});
    expect(picker).toHaveTextContent("[test] Notes 8");fireEvent.click(picker);
    expect(screen.getByRole("option",{name:"[test] Notes 8"})).toHaveAttribute("aria-selected","true");
    expect(screen.queryByRole("option",{name:"Create a new collection…"})).not.toBeInTheDocument();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
  it("announces no matches and restores the catalog after clearing search",async()=>{
    const picker=await show(false);const input=screen.getByRole("searchbox",{name:"Find a collection"});fireEvent.change(input,{target:{value:"absent-name"}});
    expect(screen.getByRole("status")).toHaveTextContent("No collections match");fireEvent.change(input,{target:{value:""}});fireEvent.click(picker);
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(collections.length);
  });
});
