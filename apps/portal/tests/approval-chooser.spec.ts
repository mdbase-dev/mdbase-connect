import { expect, test } from "../../editor/tests/auth-portal";

for (const width of [1280, 390]) test(`names account readiness and policy refusal at ${width}px`, async ({page,authPortal}) => {
  await page.setViewportSize({width,height:844});
  let upgrade: "not_scheduled" | null = "not_scheduled";
  const mutations: string[] = [];
  await page.route(`${authPortal}/v1/**`, async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const action = new URL(request.url()).pathname.split("/").at(-1)!;
      mutations.push(action);
      if (action === "select-account") return route.fulfill({status:409,json:{error:{code:"installation_legacy_backend",message:"Upgrade needed",details:{upgrade:"not_scheduled"}}}});
      return route.fulfill({json:{ok:true}});
    }
    return route.fulfill({json:{pairing:{connector_name:"Reader",approved_at:null,installation_device:true,account_selection_confirmed:false,signed_in_account_email:"fixture@example.test",account_upgrade:upgrade,collections:[{collection_id:"notes",display_name:"Notes",role:"owner"}]}}});
  });
  await page.goto(`${authPortal}/pair/00000000-0000-4000-8000-000000000001`);
  await expect(page.getByRole("heading",{name:"Account upgrade needed"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Use this account"})).toHaveCount(0);
  expect(mutations).toEqual([]);
  upgrade = null;
  await page.getByRole("button",{name:"Check again"}).click();
  const picker = page.getByRole("listbox",{name:"Open in Reader"});
  const input = page.getByRole("combobox",{name:"Open in Reader"});
  const notes = picker.getByRole("option",{name:"Notes",exact:true});
  await expect(input).toHaveAttribute("data-value", "");
  await expect(picker.getByRole("option",{selected:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Open Reader",exact:true})).toBeDisabled();
  await notes.click();
  await expect(notes).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("data-value", "notes");
  expect(mutations).toEqual([]);
  await page.getByRole("button",{name:"Open Reader with Notes",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Account upgrade needed"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Sign-in cancelled"})).toHaveCount(0);
  await expect(page.locator(".mdbase-connect-lead",{hasText:"support@mdbase.dev"})).toBeVisible();
  expect(mutations).toEqual(["select-account","deny"]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for (const width of [1280, 390]) test(`searches approval collections without changing access at ${width}px`, async ({page,authPortal}) => {
  await page.setViewportSize({width,height:844});
  const calls:string[]=[];
  const collections=[...Array.from({length:60},(_,i)=>({collection_id:`collection-${i}`,display_name:`[test] Notes ${i}`,role:"owner"})),{collection_id:"named-new",display_name:"New collection",role:"owner"},{collection_id:"named-create",display_name:"create collection",role:"owner"}];
  await page.route(`${authPortal}/v1/**`, async route=>{
    calls.push(route.request().method());
    await route.fulfill({json:{pairing:{connector_name:"Reader",approved_at:null,installation_device:true,kind:"app-runtime",account_selection_confirmed:true,attested:true,account_email:"fixture@example.test",app_origin:"https://reader.example",can_create_collection:true,collections}}});
  });
  await page.goto(`${authPortal}/pair/00000000-0000-4000-8000-000000000001`);
  const picker=page.getByRole("listbox",{name:"Open in Reader"});
  const input=page.getByRole("combobox",{name:"Open in Reader"});
  const create=page.getByRole("button",{name:"Create a new collection…",exact:true});
  await expect(picker.getByRole("option")).toHaveCount(collections.length);
  await expect(picker.getByRole("option",{selected:true})).toHaveCount(0);
  await expect(input).toHaveAttribute("data-value", "");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await expect(picker).toHaveCSS("overflow-y", "auto");
  expect(await picker.evaluate(el=>el.scrollHeight>el.clientHeight && el.clientHeight>0 && el.clientHeight<=innerHeight*0.4)).toBe(true);
  await expect(create).toBeEnabled();
  await expect(create).toHaveAttribute("aria-pressed", "false");
  await expect(picker.getByRole("option",{name:"New collection",exact:true})).toHaveCount(1);
  await expect(picker.getByRole("option",{name:"create collection",exact:true})).toHaveCount(1);
  await input.fill("notes 59");
  const match=picker.getByRole("option",{name:"[test] Notes 59",exact:true});
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(match).toHaveAttribute("aria-selected", "false");
  await expect(input).toHaveAttribute("data-value", "");
  // Filtering and bare Enter cannot turn the sole match into consent.
  await input.press("Enter");
  await expect(input).toHaveAttribute("data-value", "");
  await expect(picker.getByRole("option",{selected:true})).toHaveCount(0);
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", (await match.getAttribute("id"))!);
  await expect(input).toHaveAttribute("data-value", "");
  await expect(match).toHaveAttribute("aria-selected", "false");
  await input.press("Enter");
  await expect(input).toHaveAttribute("data-value", "collection-59");
  await expect(match).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByRole("option",{selected:true})).toHaveCount(1);
  await input.fill("absent-name");
  await expect(picker.getByRole("option")).toHaveCount(0);
  await expect(input).toHaveAttribute("data-value", "collection-59");
  await expect(page.getByRole("status")).toContainText("No collections match");
  await expect(page.getByText("Selected: [test] Notes 59",{exact:true})).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(create).toHaveAttribute("aria-pressed", "false");
  await input.fill("");
  await expect(picker.getByRole("option")).toHaveCount(collections.length);
  await expect(match).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByRole("option",{selected:true})).toHaveCount(1);
  expect(calls.every(method=>method==="GET")).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
