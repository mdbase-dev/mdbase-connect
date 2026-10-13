import { expect, test } from "../../editor/tests/auth-portal";

for (const width of [1280, 390]) test(`searches approval collections without changing access at ${width}px`, async ({page,authPortal}) => {
  await page.setViewportSize({width,height:844});
  const calls:string[]=[];
  const collections=[...Array.from({length:60},(_,i)=>({collection_id:`collection-${i}`,display_name:`[test] Notes ${i}`,role:"owner"})),{collection_id:"named-new",display_name:"New collection",role:"owner"},{collection_id:"named-create",display_name:"create collection",role:"owner"}];
  await page.route(`${authPortal}/v1/**`, async route=>{
    calls.push(route.request().method());
    await route.fulfill({json:{pairing:{connector_name:"Reader",approved_at:null,installation_device:true,kind:"app-runtime",account_selection_confirmed:true,attested:true,account_email:"fixture@example.test",app_origin:"https://reader.example",can_create_collection:true,collections}}});
  });
  await page.goto(`${authPortal}/pair/00000000-0000-4000-8000-000000000001`);
  const picker=page.getByRole("combobox",{name:"Open in Reader"});
  await picker.click();const list=page.getByRole("listbox");
  await expect(list.getByRole("option").first()).toHaveText("Create a new collection…");
  await expect(list.getByRole("option",{name:"Choose a collection",exact:true})).toHaveCount(0);
  await expect(list.getByRole("option",{name:"New collection",exact:true})).toHaveCount(1);
  await expect(list.getByRole("option",{name:"create collection",exact:true})).toHaveCount(1);
  await page.keyboard.press("Escape");await page.getByRole("searchbox",{name:"Find a collection"}).fill("notes 59");
  await picker.click();await expect(list.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");await page.keyboard.press("Enter");
  await expect(picker).toHaveText("[test] Notes 59");
  await page.getByRole("searchbox",{name:"Find a collection"}).fill("absent-name");
  await expect(picker).toHaveText("[test] Notes 59");await expect(page.getByRole("status")).toContainText("No collections match");
  expect(calls.every(method=>method==="GET")).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
