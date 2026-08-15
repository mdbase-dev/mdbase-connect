import { createHash } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const contactSchema = JSON.stringify({
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["individual", "organisation", "group"] },
    primary_email: { type: "string", format: "email" },
    primary_phone: { type: "string", minLength: 1 },
    organisation: { type: "string", minLength: 1 },
    birthday: { type: "string", format: "date" }
  },
  additionalProperties: false
}, null, 2);
const contactContract = `---
kind: mdbase.contract
contract_type: record
id: mdbase.contact
version: 1.0.0
name: Contact
description: A compact application-facing view of a person or organisation.
record_schema:
  dialect: json-schema-2020-12
  ref: ../../schemas/mdbase.contact/1.0.0.schema.json
binding_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [display, communication]
    additionalProperties: false
    properties:
      archive:
        type: object
        required: [archived_tag]
        additionalProperties: false
        properties:
          archived_tag: { type: string, minLength: 1 }
      display:
        type: object
        required: [name_order]
        additionalProperties: false
        properties:
          name_order: { type: string, enum: [display, family_given] }
          show_organisation: { type: boolean }
      communication:
        type: object
        required: [accepted_formats, write_format]
        additionalProperties: false
        properties:
          accepted_formats:
            type: array
            minItems: 1
            uniqueItems: true
            items: { type: string, enum: [email, phone] }
          write_format: { type: string, enum: [email, phone] }
---
`;
const contactType = `---
kind: mdbase.type
name: contact
version: 1
description: A person or organisation you want to stay in touch with
match:
  where:
    type: contact
collection:
  display:
    name_field: name
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, name]
    properties:
      type: { const: contact }
      name: { type: string, minLength: 1 }
      kind: { type: string, enum: [individual, organisation, group], default: individual }
      email: { type: string, format: email }
      phone: { type: string, minLength: 1 }
      organisation: { type: string, minLength: 1 }
      birthday: { type: string, format: date }
      organizations:
        type: object
        propertyNames:
          type: string
          minLength: 1
        additionalProperties:
          type: object
          properties:
            name: { type: string, minLength: 1 }
          additionalProperties: false
    additionalProperties: true
implements:
  - contract: mdbase.contact
    version: 1.0.0
    fields:
      name: name
      kind: kind
      primary_email: email
      primary_phone: phone
      organisation: organisation
      birthday: birthday
    binding:
      display:
        name_order: display
      communication:
        accepted_formats: [email, phone]
        write_format: email
---
`;
const contactResources = [
  ["schema", "schemas/mdbase.contact/1.0.0.schema.json", "schemas/mdbase.contact/1.0.0.schema.json", contactSchema],
  ["contract", "contracts/mdbase.contact/1.0.0.md", "_contracts/mdbase.contact/1.0.0.md", contactContract],
  ["type", "types/contact/2.md", "_types/contact.md", contactType]
] as const;
const contactContractDigest =
  "sha256:411c128d1f0ccef547836bb67fd84abbd0614749a57eee53cabe466092cba783";
const runtimeRunContractDigest = `sha256:${"3".repeat(64)}`;
const contactProvision = {
  manifest: {
    kind: "mdbase.type-pack",
    id: "mdbase.contact",
    version: "1.0.0",
    resources: contactResources.map(([kind, source, target, document]) => ({
      kind,
      mode: kind === "type" ? "seed" : "managed",
      source,
      target,
      digest: sha256(document)
    }))
  },
  resources: contactResources.map(([, source, , document]) => ({ source, document })),
  provides: [{
    id: "mdbase.contact",
    version: "1.0.0",
    digest: contactContractDigest
  }]
};
const contactProvisionDocument = JSON.stringify(contactProvision);

test.beforeEach(async ({ page }) => {
  await page.route("https://mdbase.dev/contracts/catalog.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        catalog_version: 2,
        id: "dev.mdbase.first-party",
        name: "mdbase contracts",
        description: "Portable contracts and type packs published by mdbase.",
        homepage: "https://mdbase.dev/contracts/",
        publisher: {
          name: "mdbase",
          url: "https://mdbase.dev/"
        },
        contracts: [{
          id: "mdbase.contact",
          version: "1.0.0",
          name: "Contact",
          description: "A compact application-facing view of a person or organisation.",
          contract_type: "record",
          digest: contactContractDigest,
          artifact: "./artifacts/contracts/mdbase.contact/1.0.0.md",
          standards: []
        }],
        packs: [{
          id: "mdbase.contact",
          version: "1.0.0",
          name: "Contact type pack",
          description: "A compact contact contract and a friendly, editable Contact type.",
          digest: sha256(contactProvisionDocument),
          provision: "./packs/mdbase.contact/1.0.0.json",
          provides: [{
            id: "mdbase.contact",
            version: "1.0.0",
            digest: contactContractDigest
          }],
          resource_count: 3,
          display: {
            name: "Contact",
            summary: "Store people and organisations with names, email addresses, phone numbers, and notes.",
            category: "people",
            audience: "general",
            icon: "address-book",
            badges: ["Portable contact semantics"]
          },
          installation: {
            visibility: "default",
            recommendation: "user",
            primary_type: "contact",
            types: [{ name: "contact", label: "Contact" }]
          }
        }, {
          id: "mdbase.runtime.standard",
          version: "0.2.0",
          name: "mdbase durable runtime standard library",
          description: "Runtime records and contracts.",
          digest: `sha256:${"2".repeat(64)}`,
          provision: "./packs/mdbase.runtime.standard/0.2.0.json",
          provides: [{
            id: "mdbase.runtime.run",
            version: "1.0.0",
            digest: runtimeRunContractDigest
          }],
          resource_count: 43,
          display: {
            name: "Runtime standard library",
            summary: "Internal records and contracts for durable workflows, runs, timers, and diagnostics.",
            category: "infrastructure",
            audience: "infrastructure",
            icon: "terminal-window",
            badges: ["Runtime 0.2"]
          },
          installation: {
            visibility: "advanced",
            recommendation: "integration-managed",
            primary_type: null,
            types: [{ name: "runtime_run", label: "Runtime run" }],
            caution: "Most collections do not need this pack. Install it only when a runtime integration asks you to."
          }
        }]
      }
    });
  });
  await page.route("https://mdbase.dev/contracts/packs/mdbase.contact/1.0.0.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: contactProvisionDocument
    });
  });
});

async function expectSharedSelectControls(scope: Locator) {
  const controls = scope.locator("select");
  await expect(controls.first()).toBeVisible();
  expect(await controls.count()).toBeGreaterThan(0);
  const audit = await controls.evaluateAll((selects) => selects.map((select) => ({
    wrapped: select.parentElement?.classList.contains("select-control") ?? false,
    hasCaret: Boolean(select.parentElement?.querySelector("svg")),
    appearance: getComputedStyle(select).appearance,
    height: select.getBoundingClientRect().height
  })));
  expect(audit.every((control) =>
    control.wrapped
    && control.hasCaret
    && control.appearance === "none"
    && control.height === 34
  )).toBe(true);
}

test("keeps the application geometry visible while a collection opens", async ({ page }) => {
  await page.goto("?demo=80&delay=450");
  const opening = page.getByRole("main", { name: "Opening collection" });
  await expect(opening).toBeVisible();
  await expect(opening).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Reading its notes and types")).toBeVisible();
  expect(await opening.locator(":scope > *").count()).toBe(3);
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await expect(opening).not.toBeAttached();
});

test("renders linked collection images inline and in the file preview", async ({ page }) => {
  await page.goto("?demo=12");
  const image = page.getByRole("img", { name: "A durable piece of frontmatter" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => ({
    complete: (element as HTMLImageElement).complete,
    width: (element as HTMLImageElement).naturalWidth
  }))).toEqual({ complete: true, width: 960 });

  await page.getByRole("button", { name: "Open frontmatter.svg" }).click();
  const preview = page.getByRole("dialog", { name: "Preview frontmatter.svg" });
  await expect(preview.getByRole("img", { name: "frontmatter.svg" })).toBeVisible();
  await preview.getByRole("button", { name: "Close file preview" }).click();
  await expect(preview).not.toBeAttached();
});

test("focuses embedded PDFs in place and opens PDF wikilinks in the file workspace", async ({ page }) => {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await body.locator(".cm-line").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\n![[Documents/interface-notes.pdf]]\n\n[[Documents/interface-notes.pdf]]");
  await body.locator(".cm-line").first().click();

  const open = page.getByRole("button", { name: "Open interface-notes.pdf" });
  await expect(open).toBeVisible();
  await open.click();

  await expect(page.getByRole("dialog", { name: "Preview interface-notes.pdf" })).toHaveCount(0);
  const inlineViewer = page.getByRole("region", { name: "Embedded PDF, interface-notes.pdf" });
  await expect(inlineViewer).toBeFocused();
  const embedPdf = inlineViewer.getByLabel("PDF viewer, interface-notes.pdf");
  await expect(embedPdf).toBeVisible();
  await expect.poll(() => embedPdf.evaluate((viewer) => {
    const root = viewer.querySelector("embedpdf-container")?.shadowRoot;
    return [...(root?.querySelectorAll("img") ?? [])].some((image) => image.naturalWidth > 0);
  })).toBe(true);

  await page.getByRole("link", { name: "Documents/interface-notes.pdf" }).click();
  await expect(page.getByRole("main", { name: "File viewer, interface-notes.pdf" })).toBeVisible();
  const workspaceViewer = page.getByLabel("PDF viewer, interface-notes.pdf");
  await expect(workspaceViewer).toBeVisible();
  await expect.poll(async () => (await workspaceViewer.boundingBox())?.height ?? 0).toBeGreaterThan(300);
  await expect.poll(() => workspaceViewer.evaluate((viewer) => {
    const root = viewer.querySelector("embedpdf-container")?.shadowRoot;
    return [...(root?.querySelectorAll("img") ?? [])].some((image) => image.naturalWidth > 0);
  })).toBe(true);
});

test("transcludes Markdown notes and opens the source note", async ({ page }) => {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await body.locator(".cm-line").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\n![[Journal/garden-notes-2]]");
  await body.locator(".cm-line").first().click();

  const transclusion = page.getByRole("region", { name: "Transclusion of Garden notes 2" });
  await expect(transclusion).toBeVisible();
  await expect(transclusion).toContainText("A generated note used to test a large collection.");
  await transclusion.getByRole("button", { name: "Open Garden notes 2" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
});

test("uses one fixed-choice control across settings, note creation, and type editing", async ({ page }) => {
  await page.goto("?demo=12");

  await page.getByRole("button", { name: "Settings" }).click();
  await expectSharedSelectControls(page.locator(".settings-view"));

  await page.getByRole("button", { name: /^Notes, / }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await expectSharedSelectControls(page.locator(".new-note-composer"));
  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("option", { name: /note/ }).click();
  await expectSharedSelectControls(page.locator(".type-inspector"));
});

test("edits and autosaves a Markdown note", async ({ page }) => {
  await page.goto("?demo=240");
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  const title = page.getByRole("textbox", { name: "Note title" });
  await expect(title).toHaveValue("The shape of useful tools");
  await title.fill("Useful tools, revised");
  await page.getByRole("textbox", { name: "Note body" }).fill("A deliberately quiet editing surface.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 2_000 });

  const body = page.getByRole("textbox", { name: "Note body" });
  const codeMirror = page.locator(".body-editor .cm-editor");
  await body.click();
  await expect(body).toBeFocused();
  expect(await codeMirror.evaluate((element) => ({
    outline: getComputedStyle(element).outlineStyle,
    shadow: getComputedStyle(element).boxShadow
  }))).toEqual({ outline: "none", shadow: "none" });
  await expect(page.locator(".body-editor .cm-cursorLayer")).toHaveCount(0);
  const caretColor = await body.evaluate((element) => getComputedStyle(element).caretColor);
  expect(caretColor).not.toBe("transparent");
  expect(caretColor).not.toBe("rgba(0, 0, 0, 0)");
});

test("keeps the writing measure while placing editor scrollbars at the pane edge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto("?demo=12");

  const title = page.getByRole("textbox", { name: "Note title" });
  const body = page.getByRole("textbox", { name: "Note body" });
  const longLine = "A long readable line ".repeat(100);
  await body.fill(Array.from({ length: 80 }, (_, index) => `${index + 1}. ${longLine}`).join("\n"));

  const wrapped = await page.locator(".writing-surface").evaluate((surface) => {
    const titleInput = surface.querySelector<HTMLElement>(".title-input");
    const scroller = surface.querySelector<HTMLElement>(".body-editor .cm-scroller");
    const line = surface.querySelector<HTMLElement>(".body-editor .cm-line");
    if (!titleInput || !scroller || !line) throw new Error("The writing surface is incomplete.");
    const surfaceBounds = surface.getBoundingClientRect();
    const titleBounds = titleInput.getBoundingClientRect();
    const scrollerBounds = scroller.getBoundingClientRect();
    const lineBounds = line.getBoundingClientRect();
    return {
      surfaceRight: surfaceBounds.right,
      scrollerRight: scrollerBounds.right,
      titleLeft: titleBounds.left,
      titleWidth: titleBounds.width,
      lineLeft: lineBounds.left,
      lineWidth: lineBounds.width,
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight
    };
  });

  expect(Math.abs(wrapped.surfaceRight - wrapped.scrollerRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(wrapped.titleLeft - wrapped.lineLeft)).toBeLessThanOrEqual(1);
  expect(wrapped.titleWidth).toBeLessThanOrEqual(760);
  expect(wrapped.lineWidth).toBeLessThanOrEqual(760);
  expect(wrapped.scrollWidth).toBeLessThanOrEqual(wrapped.clientWidth + 1);
  expect(wrapped.scrollHeight).toBeGreaterThan(wrapped.clientHeight);

  await page.evaluate(() => {
    localStorage.setItem("mdbase-editor:preferences", JSON.stringify({
      vim: false,
      lineWrapping: false,
      quietMarkdown: true,
      fontSize: 17
    }));
  });
  await page.reload();
  await expect(title).toBeVisible();
  await body.fill(longLine);

  const unwrapped = await page.locator(".writing-surface").evaluate((surface) => {
    const scroller = surface.querySelector<HTMLElement>(".body-editor .cm-scroller");
    if (!scroller) throw new Error("The note editor is incomplete.");
    return {
      surfaceRight: surface.getBoundingClientRect().right,
      scrollerRight: scroller.getBoundingClientRect().right,
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth
    };
  });

  expect(Math.abs(unwrapped.surfaceRight - unwrapped.scrollerRight)).toBeLessThanOrEqual(1);
  expect(unwrapped.scrollWidth).toBeGreaterThan(unwrapped.clientWidth);
});

test("formats, finds, and checks Markdown without adding permanent editor chrome", async ({ page }) => {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await body.fill("alpha beta");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+b");
  await expect(body).toHaveText("**alpha beta**");

  await page.keyboard.press("Control+f");
  const search = page.locator(".body-editor .cm-search");
  await expect(search).toBeVisible();
  await search.locator('input[name="search"]').fill("beta");
  await expect(page.locator(".body-editor .cm-searchMatch")).toHaveCount(1);
  await search.locator('button[name="close"]').click();
  await expect(search).not.toBeVisible();

  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/task");
  const completion = page.locator(".cm-tooltip-autocomplete");
  await expect(completion.getByText("Task", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Finish the polish");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Next thought");

  const task = page.locator(".body-editor .cm-task-checkbox");
  await expect(task).toHaveAttribute("aria-checked", "false");
  await task.click();
  await expect(task).toHaveAttribute("aria-checked", "true");
  await task.focus();
  await page.keyboard.press("Space");
  await expect(task).toHaveAttribute("aria-checked", "false");
  await task.click();
  await expect(task).toHaveAttribute("aria-checked", "true");
  await page.locator(".body-editor .cm-line").filter({ hasText: "Finish the polish" }).click();
  await expect(body).toContainText("- [x] Finish the polish");
  await expect(page.locator(".body-editor .cm-markdown-mark").first()).toBeVisible();
  await expect(page.locator(".body-editor .cm-gutters")).toHaveCount(0);
});

test("restores each note's caret and undo history", async ({ page }) => {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await body.fill("alpha beta");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 2_000 });

  await page.getByRole("option").filter({ hasText: "Garden notes 2" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  await page.getByRole("option").filter({ hasText: "The shape of useful tools" }).first().click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");

  await expect(body).toBeFocused();
  await page.keyboard.type("X");
  await expect(body).toHaveText("alpha Xbeta");
  await page.keyboard.press("Control+z");
  await expect(body).toHaveText("alpha beta");
});

test("modifier-clicks an internal Markdown link to open its note", async ({ page }) => {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await body.fill("[[Journal/garden-notes-2|Garden notes 2]]\n\nKeep writing.");
  await page.locator(".body-editor .cm-line").filter({ hasText: "Garden notes 2" }).click({ modifiers: ["Control"] });

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
});

test("creates a note from an unresolved Markdown link", async ({ page }) => {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await body.fill("[Fresh idea](fresh-idea.md)\n\nKeep writing.");
  await page.locator(".body-editor .cm-line").filter({ hasText: "Fresh idea" }).click({ modifiers: ["Control"] });

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Fresh idea");
  await expect(page.getByRole("button", { name: "Notes/fresh-idea.md" })).toBeVisible();
  await page.getByRole("button", { name: "Back in note history" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
});

test("moves backward and forward through opened notes", async ({ page }) => {
  await page.goto("?demo=12");
  const back = page.getByRole("button", { name: "Back in note history" });
  const forward = page.getByRole("button", { name: "Forward in note history" });
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  await page.getByRole("option").filter({ hasText: "Garden notes 2" }).click();
  await page.getByRole("option").filter({ hasText: "Reading list 4" }).click();
  await back.click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  await expect(forward).toBeEnabled();

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");

  await page.getByRole("option").filter({ hasText: "A quiet interface 3" }).click();
  await expect(forward).toBeDisabled();
});

test("previews sidebar notes and internal editor links on hover", async ({ page }) => {
  await page.goto("?demo=12");

  const gardenRow = page.getByRole("option").filter({ hasText: "Garden notes 2" });
  await gardenRow.hover();
  const preview = page.getByRole("tooltip");
  await expect(preview).toBeVisible({ timeout: 1_500 });
  await expect(preview).toHaveAccessibleName("Preview of Garden notes 2");
  await expect(preview).toContainText("Journal/garden-notes-2.md");

  await page.getByRole("textbox", { name: "Search notes and files" }).hover();
  await expect(preview).not.toBeVisible();

  const body = page.getByRole("textbox", { name: "Note body" });
  await body.fill("[[Journal/garden-notes-2|Garden notes 2]]\n\nKeep writing.");
  const linkedLine = page.locator(".body-editor .cm-line").filter({ hasText: "Garden notes 2" });
  const box = await linkedLine.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 42, box!.y + box!.height / 2);

  await expect(preview).toBeVisible({ timeout: 1_500 });
  await expect(preview).toHaveAccessibleName("Preview of Garden notes 2");
  await expect(preview).toContainText("Journal/garden-notes-2.md");
});

test("filters collection facets, follows backlinks, and completes wikilinks", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");

  const folders = page.getByRole("group", { name: "Folders" });
  const foldersToggle = folders.getByRole("button", { name: "Folders" });
  await expect(foldersToggle).toHaveAttribute("aria-expanded", "true");
  await foldersToggle.click();
  await expect(foldersToggle).toHaveAttribute("aria-expanded", "false");

  const tags = page.getByRole("group", { name: "Tags" });
  await tags.getByRole("button", { name: "Tags" }).click();
  await tags.getByRole("button", { name: /^Show notes tagged #ideas,/ }).click();
  await expect(page.getByRole("heading", { name: "#ideas" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(4);

  await page.getByRole("button", { name: /^Notes, / }).click();
  await page.getByRole("button", { name: "Backlinks" }).click();
  const backlinks = page.getByRole("complementary", { name: "Backlinks" });
  await expect(backlinks.getByText("1 note link here")).toBeVisible();
  await backlinks.getByRole("button", { name: /Garden notes 2/ }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");

  const body = page.getByRole("textbox", { name: "Note body" });
  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n[[");
  const completion = page.locator(".cm-tooltip-autocomplete");
  await expect(completion).toBeVisible();
  const appearance = await completion.evaluate((popup) => {
    const list = popup.querySelector<HTMLElement>("ul");
    const row = popup.querySelector<HTMLElement>("li");
    const label = popup.querySelector<HTMLElement>(".cm-completionLabel");
    const detail = popup.querySelector<HTMLElement>(".cm-completionDetail");
    if (!list || !row || !label || !detail) throw new Error("The completion popup is incomplete.");
    return {
      popupWidth: popup.getBoundingClientRect().width,
      listHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      rowHeight: row.getBoundingClientRect().height,
      listFont: getComputedStyle(list).fontFamily,
      labelFont: getComputedStyle(label).fontFamily,
      labelWeight: getComputedStyle(label).fontWeight,
      detailFont: getComputedStyle(detail).fontFamily
    };
  });
  expect(appearance.popupWidth).toBeGreaterThanOrEqual(320);
  expect(appearance.rowHeight).toBeGreaterThanOrEqual(40);
  expect(appearance.listHeight).toBeLessThanOrEqual(252);
  expect(appearance.listScrollHeight).toBeGreaterThan(appearance.listHeight);
  expect(appearance.listFont).toContain("Atkinson Hyperlegible");
  expect(appearance.labelFont).toContain("Atkinson Hyperlegible");
  expect(appearance.labelWeight).toBe("700");
  expect(appearance.detailFont).toContain("Azeret Mono");

  await page.keyboard.type("the shape");
  const selectedCompletion = completion.getByRole("option", { selected: true });
  await expect(selectedCompletion).toContainText("The shape of useful tools");
  await expect(body).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(body).toContainText("[[Notes/the-shape-of-useful-tools|The shape of useful tools]]");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 2_000 });
});

for (const trigger of ["@", "[["] as const) {
  test(`${trigger} picker remains usable when its query autosaves`, async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });

    await page.goto("?demo=12");
    const editor = page.getByRole("main", { name: "Note editor" });
    const body = page.getByRole("textbox", { name: "Note body" });
    const saveState = editor.locator(".save-state");
    await body.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(`\n\n${trigger}the shape`);

    const completion = page.locator(".cm-tooltip-autocomplete");
    await expect(completion).toBeVisible();
    await expect(saveState).toHaveText("Unsaved");
    await expect(saveState).toHaveText("Saved", { timeout: 2_000 });
    await expect(completion).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(body).toContainText("[[Notes/the-shape-of-useful-tools|The shape of useful tools]]");
    await expect(saveState).toHaveText("Unsaved");
    await expect(saveState).toHaveText("Saved", { timeout: 2_000 });
    await expect(page.getByText(/Couldn’t save/)).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
}

test("creates a note only after the creation form is complete", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.locator(".list-header p")).toContainText("4 notes");
  await page.getByRole("button", { name: "New note" }).click();

  const create = page.getByRole("button", { name: "Create note" });
  await expect(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Title" }).fill("A useful note");
  await expect(page.getByLabel("Suggested path")).toHaveText("A useful note.md");
  await page.getByRole("combobox", { name: "Type" }).selectOption("note");
  await expect(page.getByLabel("Suggested path")).toHaveText("Notes/A useful note.md");
  await page.locator(".new-note-properties > summary").click();
  await page.getByRole("button", { name: "Add property" }).click();
  await page.locator(".new-note-properties .property-options button").filter({ hasText: "tags" }).click();
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByLabel("tags value item 1").fill("captured");
  await page.getByRole("textbox", { name: "Note body" }).fill("The opening paragraph is already here.");
  await expect(create).toBeEnabled();
  const createStarted = Date.now();
  await create.click();

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("A useful note");
  const createReadyMs = Date.now() - createStarted;
  expect(createReadyMs).toBeLessThan(500);
  const body = page.getByRole("textbox", { name: "Note body" });
  await expect(body).toContainText("The opening paragraph is already here.");
  await expect(body).toBeFocused();
  await page.getByRole("button", { name: "Note properties" }).click();
  await expect(page.getByLabel("tags value item 1")).toHaveValue("captured");
  await expect(page.locator(".list-header p")).toContainText("5 notes");
  await expect(page.getByRole("button", { name: "Notes/A useful note.md" })).toBeVisible();
});

test("quick-opens notes with fuzzy keyboard search", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

  await page.keyboard.press("Control+p");
  const quickOpen = page.getByRole("dialog", { name: "Quick open" });
  await expect(quickOpen).toBeVisible();
  const finder = quickOpen.getByRole("combobox", { name: "Find a note" });
  await expect(finder).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await finder.fill("qstn kpng");
  await expect(quickOpen.getByRole("option", { name: /Questions worth keeping 7/ })).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Questions worth keeping 7");
});

test("shows the matching note text in sidebar and quick-open search results", async ({ page }) => {
  await page.goto("?demo=12");
  const query = "Record 4 remains lightweight";
  await page.getByRole("textbox", { name: "Search notes and files" }).fill(query);
  const sidebarResult = page.getByRole("option", { name: /Reading list 4/ });
  await expect(sidebarResult.locator(".note-search-context")).toContainText(query);
  expect(await sidebarResult.locator(".note-search-context mark").count()).toBeGreaterThanOrEqual(4);

  await page.keyboard.press("Control+p");
  const quickOpen = page.getByRole("dialog", { name: "Quick open" });
  await quickOpen.getByRole("combobox", { name: "Find a note" }).fill(query);
  const quickResult = quickOpen.getByRole("option", { name: /Reading list 4/ });
  await expect(quickResult.locator(".search-result-context")).toContainText(query);
  await expect(quickResult.locator(".search-result-context")).toHaveClass(/body/);
});

test("sorts notes and clears the active scope from view options", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.locator(".list-header p")).toHaveText("4 notes · 2 files · modified newest");

  await page.getByRole("button", { name: "View options" }).click();
  let menu = page.getByRole("menu", { name: "Note view options" });
  await expect(menu.getByRole("menuitemradio", { name: "Modified newest" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Title A–Z" }).click();
  await expect(page.locator(".note-row").first().locator(".note-title")).toHaveText("A quiet interface 3");
  await expect(page.locator(".list-header p")).toHaveText("4 notes · 2 files · title A–Z");
  expect(await page.evaluate(() => localStorage.getItem("mdbase-editor:note-sort"))).toBe("title-asc");

  await page.getByRole("textbox", { name: "Search notes and files" }).fill("quiet interface");
  await expect(page.locator(".list-header p")).toHaveText("1 found · relevance");
  await page.getByRole("button", { name: "Clear search" }).click();

  await page.getByRole("group", { name: "Folders" }).getByRole("button", { name: /^Show notes in Notes,/ }).click();
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  await page.getByRole("button", { name: "View options" }).click();
  menu = page.getByRole("menu", { name: "Note view options" });
  await expect(menu.getByRole("menuitemradio", { name: "Folder · Notes" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "All notes" }).click();

  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await expect(page.locator(".note-row")).toHaveCount(6);
});

test("creates a folder with its first note", async ({ page }) => {
  await page.goto("?demo=4");
  const folders = page.getByRole("group", { name: "Folders" });
  await folders.getByRole("button", { name: "New folder" }).click();

  const create = page.getByRole("button", { name: "Create folder" });
  await expect(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Folder name" }).fill("Research");
  await page.getByRole("textbox", { name: "First note" }).fill("Reading list");
  await expect(page.getByText("Research/Reading list.md")).toBeVisible();
  await create.click();

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Reading list");
  await expect(folders.getByRole("button", { name: /^Show notes in Research,/ })).toBeVisible();
});

test("creates and edits a contact through its declared display field", async ({ page }) => {
  await page.goto("?demo=4");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("button", { name: "Add a type" }).click();
  await page.getByRole("button", { name: "Add Contact" }).first().click();
  const confirmation = page.getByRole("alert").filter({ hasText: "Add Contact?" });
  await confirmation.getByRole("button", { name: "Add Contact" }).click();
  await expect(page.getByRole("button", { name: "Types (2)" })).toBeVisible();

  await page.getByRole("button", { name: /^Notes, / }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("combobox", { name: "Type" }).selectOption("contact");
  await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Name" }).fill("Ada Lovelace");
  await page.getByText("Properties", { selector: "summary > span" }).click();
  await expect(page.getByRole("combobox", { name: "kind value" })).toHaveValue('string:"individual"');
  await page.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("button", { name: /email/i }).click();
  await page.getByRole("textbox", { name: "email value" }).fill("ada@example.com");
  expect((await new AxeBuilder({ page }).include(".new-note-composer").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Create note" }).click();

  const title = page.getByRole("textbox", { name: "Note title" });
  await expect(title).toHaveValue("Ada Lovelace");
  await title.fill("Augusta Ada King");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Note properties" }).click();
  const panel = page.getByRole("complementary", { name: "Note properties" });
  await expect(panel.getByRole("textbox", { name: "name value" })).toHaveValue("Augusta Ada King");
  await expect(panel.getByRole("textbox", { name: "email value" })).toHaveValue("ada@example.com");
});

test("inspects type definitions and persists editor settings", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("button", { name: "Add a type" }).click();
  await expect(page.getByRole("heading", { name: "Add a type" })).toBeVisible();
  await expect(page.getByText("Contact", { exact: true })).toBeVisible();
  await expect(page.getByText("Adds 1 type")).toBeVisible();
  await expect(page.getByText("Runtime standard library")).not.toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.getByRole("link", { name: "View pack JSON" })).toHaveAttribute(
    "href",
    "https://mdbase.dev/contracts/packs/mdbase.contact/1.0.0.json"
  );
  await page.getByRole("button", { name: "Developer and infrastructure packs" }).click();
  await expect(page.getByText("Runtime standard library")).toBeVisible();
  await expect(page.getByText("Most collections do not need this pack.")).toBeVisible();
  const installButton = page.getByRole("button", { name: "Add Contact" }).first();
  const installButtonTop = await installButton.evaluate((element) => element.getBoundingClientRect().top);
  const packStatusTop = await page.getByText("Adds 1 type").first().evaluate((element) => element.getBoundingClientRect().top);
  await installButton.click();
  const packConfirmation = page.getByRole("alert").filter({ hasText: "Add Contact?" });
  await expect(packConfirmation).toContainText("ready-to-use Contact type");
  await expect(packConfirmation).toContainText("Existing files will not be overwritten");
  await expect.poll(() => installButton.evaluate((element) => element.getBoundingClientRect().top)).toBe(installButtonTop);
  await expect.poll(() => page.getByText("Adds 1 type").first().evaluate((element) => element.getBoundingClientRect().top)).toBe(packStatusTop);
  await packConfirmation.getByRole("button", { name: "Add Contact" }).click();
  await expect(page.getByRole("button", { name: "Types (2)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "contact" })).toBeVisible();
  await expect(page.locator(".visual-field-name input").first()).toHaveValue("type");
  await expect(page.locator(".visual-field-name input").nth(1)).toHaveValue("name");
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  const installedYaml = page.getByRole("textbox", { name: "contact type YAML" });
  await installedYaml.click();
  await page.keyboard.press("Control+End");
  await expect(installedYaml).toContainText("contract: mdbase.contact");
  await page.getByRole("button", { name: "Design" }).click();
  await page.getByRole("button", { name: "Add field" }).click();
  const localField = page.locator(".visual-field-name input").last();
  await expect(localField).toHaveValue("field");
  await localField.fill("local_context");
  await localField.press("Tab");
  await page.getByRole("heading", { name: "Works with applications" }).click();
  await expect(page.getByText("Mapping ready")).toBeVisible();
  const contractSettings = page.locator(".contract-settings");
  await contractSettings.locator("summary").click();
  await expect(contractSettings.getByText("Application behavior")).toBeVisible();
  const rootFields = contractSettings.locator(".contract-settings-body > .schema-object > .schema-object-fields");
  await expect(rootFields.locator(":scope > .schema-nested-value")).toHaveCount(2);
  const hierarchy = await contractSettings.evaluate((settings) => {
    const section = settings.querySelector<HTMLElement>(
      ".contract-settings-body > .schema-object > .schema-object-fields > .schema-nested-value"
    );
    const nestedFields = settings.querySelector<HTMLElement>(
      ".contract-settings-body > .schema-object > .schema-object-fields > .schema-nested-value > .schema-object > .schema-object-fields"
    );
    const addItem = [...settings.querySelectorAll<HTMLButtonElement>(".schema-add-trigger")]
      .find((button) => button.textContent?.includes("Add item"));
    if (!section || !nestedFields || !addItem) throw new Error("Contract setting hierarchy is incomplete.");
    return {
      sectionDivider: getComputedStyle(section).borderTopStyle,
      nestingGuide: getComputedStyle(nestedFields).borderLeftStyle,
      addItemBorder: getComputedStyle(addItem).borderTopWidth
    };
  });
  expect(hierarchy).toEqual({
    sectionDivider: "solid",
    nestingGuide: "solid",
    addItemBorder: "0px"
  });
  const addSetting = contractSettings.locator(
    ".contract-settings-body > .schema-object > .schema-add-trigger"
  );
  await addSetting.click();
  await contractSettings.locator(
    ".contract-settings-body > .schema-object > .schema-add-value select"
  ).selectOption("archive");
  await contractSettings.locator(
    ".contract-settings-body > .schema-object > .schema-add-value button"
  ).filter({ hasText: "Add" }).click();
  const addedArchive = rootFields.locator(":scope > .schema-nested-value").last();
  await expect(addedArchive.getByText("Archive", { exact: true })).toBeVisible();
  await addedArchive.getByLabel("archived_tag").fill("archived");
  const fieldOrder = await contractSettings.evaluate((settings) =>
    [...settings.querySelectorAll(
      ".contract-settings-body > .schema-object > .schema-object-fields > .schema-nested-value"
    )].map((section) => section.querySelector(".schema-value-label > span")?.textContent?.replace("Required", "").trim())
  );
  expect(fieldOrder).toEqual(["Display", "Communication", "Archive"]);
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  const yaml = page.getByRole("textbox", { name: "contact type YAML" });
  await yaml.click();
  await page.keyboard.press("Control+End");
  await expect(yaml).toContainText("contract: mdbase.contact");
  await expect(yaml).toContainText("local_context:");
  await expect(page.locator(".type-source .cm-lineNumbers")).toBeVisible();
  await expect(page.getByText("Collection-wide change")).toBeVisible();

  await page.getByRole("button", { name: /^Notes, / }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("combobox", { name: "Type" }).selectOption("contact");
  await page.getByText("Properties", { exact: true }).click();
  await page.getByRole("button", { name: "Add property" }).click();
  await page.getByRole("searchbox", { name: "Find a property" }).fill("organizations");
  await page.locator(".property-options button").filter({ hasText: "organizations" }).click();
  const organizations = page.getByRole("group", { name: "organizations value" });
  await expect(organizations.getByText("No entries yet.")).toBeVisible();
  await expect(organizations.getByRole("button", { name: "Add entry" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "organizations JSON value" })).toHaveCount(0);
  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog", { name: "Discard this note?" }).getByRole("button", { name: "Discard note" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  const vim = page.getByRole("switch", { name: "Vim key bindings" });
  const quietMarkdown = page.getByRole("switch", { name: "Quiet Markdown" });
  await expect(vim).toHaveAttribute("aria-checked", "false");
  await expect(quietMarkdown).toHaveAttribute("aria-checked", "true");
  await vim.click();
  await quietMarkdown.click();
  await expect(vim).toHaveAttribute("aria-checked", "true");
  await expect(quietMarkdown).toHaveAttribute("aria-checked", "false");

  await page.getByRole("button", { name: /^Notes, / }).click();
  await expect(page.getByText("vim", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("vim", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("switch", { name: "Quiet Markdown" })).toHaveAttribute("aria-checked", "false");
});

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("shows line numbers and diagnostics in source mode", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("button", { name: "YAML" }).click();
  const yaml = page.getByRole("textbox", { name: "note type YAML" });
  await expect(page.locator(".type-source .cm-lineNumbers")).toBeVisible();
  await yaml.fill("---\nname: [\n");
  await expect(page.locator(".type-source :is(.cm-lintRange-error, .cm-lintPoint-error)")).toBeAttached({ timeout: 3_000 });
  await expect(page.locator(".type-source .cm-lint-marker-error")).toBeVisible();
});

test("edits complete type membership, choices, and multiple required fields", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("heading", { name: "Type membership" })).toBeVisible();
  await page.getByRole("heading", { name: "Type membership" }).click();
  await expect(page.getByText("Explicit assignment", { exact: true })).toBeVisible();
  await expect(page.getByText("Automatic matching", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add path pattern" }).click();
  await page.getByRole("combobox", { name: "Path pattern 2" }).fill("Journal/**/*.md");
  await page.getByRole("combobox", { name: "Path pattern 2" }).press("Tab");
  await page.getByRole("button", { name: "Add field selector" }).click();
  await page.getByRole("combobox", { name: "Required match field 1" }).fill("title");
  await page.getByRole("combobox", { name: "Required match field 1" }).press("Tab");

  await page.getByRole("button", { name: "Expand title field" }).click();
  const description = page.getByRole("textbox", { name: "title description" });
  await description.pressSequentially("These are the titles for the notes.");
  await expect(description).toHaveValue("These are the titles for the notes.");
  await page.getByRole("button", { name: "Add choice" }).click();
  await page.getByRole("textbox", { name: "title choice 1" }).fill("journal");
  await page.getByRole("textbox", { name: "title choice 1" }).press("Enter");
  await page.getByRole("textbox", { name: "title choice 2" }).fill("reflection");
  await page.getByRole("textbox", { name: "title choice 2" }).press("Tab");

  for (const name of ["title", "tags"]) {
    const row = page.locator(".visual-field-row").filter({ has: page.locator(`.visual-field-name input[value="${name}"]`) });
    await row.getByRole("checkbox", { name: "Required" }).check();
  }

  const geometry = await page.locator(".visual-type-editor").evaluate((editor) => {
    const right = editor.getBoundingClientRect().left + editor.clientWidth;
    const controls = [...editor.querySelectorAll<HTMLElement>("input, select")];
    return {
      hasVerticalScroll: editor.scrollHeight > editor.clientHeight,
      noHorizontalScroll: editor.scrollWidth <= editor.clientWidth,
      controlsInside: controls.every((control) => control.getBoundingClientRect().right <= right + 0.5)
    };
  });
  expect(geometry).toEqual({ hasVerticalScroll: true, noHorizontalScroll: true, controlsInside: true });

  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "YAML" }).click();
  const source = page.getByRole("textbox", { name: "note type YAML" });
  await expect(source).toContainText("Journal/**/*.md");
  await expect(source).toContainText("fields_present:");
  await expect(source).toContainText("- title");
  await expect(source).toContainText("- tags");
  await expect(source).toContainText("- journal");
  await expect(source).toContainText("- reflection");
  await expect(source).toContainText("These are the titles for the notes.");
});

test("edits and reviews portable collection behaviour", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("heading", { name: "Collection behaviour" })).toBeVisible();
  await page.getByRole("heading", { name: "Collection behaviour" }).click();
  const visualScrollerGeometry = await page.locator(".type-inspector").evaluate((inspector) => {
    const scroller = inspector.querySelector<HTMLElement>(".visual-type-editor");
    if (!scroller) throw new Error("The visual type editor is not visible.");
    return {
      inspectorRight: inspector.getBoundingClientRect().right,
      scrollerRight: scroller.getBoundingClientRect().right,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight
    };
  });
  expect(Math.abs(visualScrollerGeometry.inspectorRight - visualScrollerGeometry.scrollerRight)).toBeLessThanOrEqual(1);
  expect(visualScrollerGeometry.scrollHeight).toBeGreaterThan(visualScrollerGeometry.clientHeight);

  await page.getByRole("combobox", { name: "Name field" }).selectOption("title");
  await page.getByRole("combobox", { name: "Display icon" }).fill("note");
  await page.getByRole("listbox", { name: "Phosphor icons" }).getByRole("option", { name: "note", exact: true }).click();

  await page.getByRole("button", { name: "Add default" }).click();
  await page.getByRole("combobox", { name: "Default field 1" }).selectOption("title");
  await page.getByRole("textbox", { name: "Default value for title" }).fill("Untitled note");

  await page.getByRole("button", { name: "Add link rule" }).click();
  await page.getByRole("combobox", { name: "Link field 1" }).selectOption("tags[]");
  await page.getByRole("combobox", { name: "tags[] link format" }).selectOption("wikilink");
  await page.getByRole("checkbox", { name: "Require an existing target" }).check();
  await page.getByRole("button", { name: "Add target type" }).click();
  await page.getByRole("combobox", { name: "tags[] target type 1", exact: true }).fill("note");
  await page.getByRole("combobox", { name: "tags[] target type 1", exact: true }).press("Tab");

  await page.getByRole("button", { name: "Add unique rule" }).click();
  await page.getByRole("combobox", { name: "Unique field 1" }).selectOption("title");
  await page.getByRole("combobox", { name: "title uniqueness scope" }).selectOption("collection");
  await page.getByRole("textbox", { name: "Path pattern", exact: true }).fill("Notes/{title}.md");
  const pathControlTops = await Promise.all([
    page.getByRole("textbox", { name: "Path pattern", exact: true }).evaluate((input) => input.getBoundingClientRect().top),
    page.getByRole("textbox", { name: "Path folder" }).evaluate((input) => input.getBoundingClientRect().top),
    page.getByRole("textbox", { name: "Path template" }).evaluate((input) => input.getBoundingClientRect().top)
  ]);
  expect(Math.max(...pathControlTops) - Math.min(...pathControlTops)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByText("Validation may change")).toBeVisible();
  await expect(page.getByText("Future file paths may change")).toBeVisible();
  await expect(page.locator(".type-collection-changes")).toContainText("Display metadata");
  await expect(page.locator(".type-collection-changes")).toContainText("Read defaults");
  await expect(page.locator(".type-collection-changes")).toContainText("Link rules");
  await expect(page.locator(".type-collection-changes")).toContainText("Uniqueness rules");
  await expect(page.locator(".type-collection-changes")).toContainText("Path policy");

  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "YAML" }).click();
  const source = page.getByRole("textbox", { name: "note type YAML" });
  await expect(source).toContainText("name_field: title");
  await expect(source).toContainText('title: "Untitled note"');
  await expect(source).toContainText("tags[]:");
  await expect(source).toContainText("target_type: note");
  await expect(source).toContainText("scope: collection");
  await expect(source).toContainText("pattern: Notes/{title}.md");
  const yamlScrollerGeometry = await page.locator(".type-inspector").evaluate((inspector) => {
    const scroller = inspector.querySelector<HTMLElement>(".type-source .cm-scroller");
    if (!scroller) throw new Error("The YAML type editor is not visible.");
    return {
      inspectorRight: inspector.getBoundingClientRect().right,
      scrollerRight: scroller.getBoundingClientRect().right
    };
  });
  expect(Math.abs(yamlScrollerGeometry.inspectorRight - yamlScrollerGeometry.scrollerRight)).toBeLessThanOrEqual(1);
});

test("builds and saves a recursive list-of-objects field", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");

  await page.getByRole("button", { name: "Add field", exact: true }).click();
  const fieldName = page.locator(".visual-field-name input").last();
  await fieldName.fill("contacts");
  await fieldName.press("Tab");
  await page.getByRole("combobox", { name: "contacts field kind" }).selectOption("array");
  await page.getByRole("combobox", { name: "contacts[] kind" }).selectOption("object");
  await page.getByRole("button", { name: "Add nested field" }).last().click();

  const nestedName = page.locator(".visual-field-name input").last();
  await nestedName.fill("value");
  await nestedName.press("Tab");
  const nestedRow = nestedName.locator("xpath=ancestor::div[contains(@class,'visual-field-row')]");
  await nestedRow.getByRole("checkbox", { name: "Required" }).check();

  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByRole("heading", { name: "Update this type?" })).toBeVisible();
  await expect(page.locator(".type-change-review dl > div").filter({ hasText: "Fields added" })).toContainText("2");
  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "YAML" }).click();
  const source = page.getByRole("textbox", { name: "note type YAML" });
  await expect(source).toContainText("contacts:");
  await expect(source).toContainText("items:");
  await expect(source).toContainText("- value");
});

test("resizes, collapses, and restores the desktop sidebars", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note body" })).toBeFocused();

  const collectionResize = page.getByRole("separator", { name: "Resize collections sidebar" });
  await collectionResize.focus();
  await page.keyboard.press("ArrowRight");
  await expect(collectionResize).toHaveAttribute("aria-valuenow", "184");

  const listResize = page.getByRole("separator", { name: "Resize notes sidebar" });
  const before = await page.locator(".note-list-pane").evaluate((element) => element.getBoundingClientRect().width);
  const handle = await listResize.boundingBox();
  if (!handle) throw new Error("The notes resize handle is not visible.");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 48, handle.y + 80);
  await page.mouse.up();
  const after = await page.locator(".note-list-pane").evaluate((element) => element.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 40);

  await page.getByRole("button", { name: "Hide collections sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Show collections sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Hide notes sidebar" }).click();
  await expect(page.getByRole("region", { name: "Notes" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Show notes sidebar" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Show collections sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show notes sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Show collections sidebar" }).click();
  await page.getByRole("button", { name: "Show notes sidebar" }).click();
  await expect(page.getByRole("separator", { name: "Resize collections sidebar" })).toHaveAttribute("aria-valuenow", "184");
  const restored = await page.locator(".note-list-pane").evaluate((element) => element.getBoundingClientRect().width);
  expect(restored).toBeCloseTo(after, 0);
});

test("keeps the current note inspector open and resizable between note switches", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Note properties" }).click();

  const panel = page.getByRole("complementary", { name: "Note properties" });
  await expect(panel).toContainText("Notes/the-shape-of-useful-tools.md");
  const resize = page.getByRole("separator", { name: "Resize note inspector" });
  const before = await panel.evaluate((element) => element.getBoundingClientRect().width);
  const handle = await resize.boundingBox();
  if (!handle) throw new Error("The inspector resize handle is not visible.");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 48, handle.y + 80);
  await page.mouse.up();
  const after = await panel.evaluate((element) => element.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 40);

  await page.getByRole("option").filter({ hasText: "Garden notes 2" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Journal/garden-notes-2.md");
  await expect(resize).toHaveAttribute("aria-valuenow", String(Math.round(after)));

  await page.reload();
  await page.getByRole("button", { name: "Note properties" }).click();
  await expect(page.getByRole("separator", { name: "Resize note inspector" })).toHaveAttribute("aria-valuenow", String(Math.round(after)));
  const restored = await panel.evaluate((element) => element.getBoundingClientRect().width);
  expect(restored).toBeCloseTo(after, 0);
});

test("keeps dense collection counts and footer controls inside the minimum rail", async ({ page }) => {
  await page.goto("?demo=10000");
  await expect(page.getByText("10,000 notes")).toBeVisible();

  const rail = page.getByRole("complementary", { name: "Collection navigation" });
  const wordmarkLabel = rail.locator(".wordmark-label");
  await expect(wordmarkLabel).toBeVisible();
  await expect(wordmarkLabel.locator("strong")).toBeHidden();
  const [compactLabelBox, compactCollapseBox] = await Promise.all([
    wordmarkLabel.boundingBox(),
    rail.getByRole("button", { name: "Hide collections sidebar" }).boundingBox()
  ]);
  if (!compactLabelBox || !compactCollapseBox) throw new Error("The compact collection header is not visible.");
  expect(compactLabelBox.x + compactLabelBox.width).toBeLessThanOrEqual(compactCollapseBox.x);

  const collectionResize = page.getByRole("separator", { name: "Resize collections sidebar" });
  await collectionResize.focus();
  await page.keyboard.press("End");
  await expect(wordmarkLabel.locator("strong")).toBeVisible();
  await collectionResize.focus();
  await page.keyboard.press("Home");
  await expect(collectionResize).toHaveAttribute("aria-valuenow", "144");
  await expect(wordmarkLabel).toBeHidden();

  const [markBox, collapseBox] = await Promise.all([
    rail.locator(".wordmark-mark").boundingBox(),
    rail.getByRole("button", { name: "Hide collections sidebar" }).boundingBox()
  ]);
  if (!markBox || !collapseBox) throw new Error("The collection header controls are not visible.");
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(collapseBox.x);

  const counts = rail.locator(".rail-filter-items small");
  await expect(counts.first()).toBeVisible();
  expect(await counts.evaluateAll((elements) => elements.every((element) => {
    const count = element.getBoundingClientRect();
    const container = element.closest(".collection-rail")?.getBoundingClientRect();
    return Boolean(container) && count.right <= container.right && element.scrollWidth <= element.clientWidth;
  }))).toBe(true);

  const statusLabel = rail.locator(".connection-footer p > span:last-child");
  const shortcuts = rail.getByRole("button", { name: "Keyboard shortcuts" });
  const [statusBox, shortcutBox] = await Promise.all([statusLabel.boundingBox(), shortcuts.boundingBox()]);
  if (!statusBox || !shortcutBox) throw new Error("Collection footer controls are not visible.");
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(shortcutBox.x);
  await expect(rail.locator(".disconnect-action > span")).toBeHidden();
});

test("uses the native caret in Vim insert mode", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mdbase-editor:preferences", JSON.stringify({
      vim: true,
      lineWrapping: true,
      fontSize: 17
    }));
  });
  await page.goto("?demo=12");

  const body = page.getByRole("textbox", { name: "Note body" });
  await body.click();
  const scroller = page.locator(".body-editor .cm-scroller");
  const blockCursor = page.locator(".body-editor .cm-vimCursorLayer .cm-fat-cursor");
  await expect(scroller).toHaveClass(/cm-vimMode/);
  await expect(blockCursor).toBeAttached();

  await page.keyboard.press("i");
  await expect(body).toBeFocused();
  await expect(scroller).not.toHaveClass(/cm-vimMode/);
  await expect(blockCursor).not.toBeAttached();
  await expect(page.locator(".body-editor .cm-cursorLayer:not(.cm-vimCursorLayer)")).toHaveCount(0);
  const caretColor = await body.evaluate((element) => getComputedStyle(element).caretColor);
  expect(caretColor).not.toBe("transparent");
  expect(caretColor).not.toBe("rgba(0, 0, 0, 0)");

  await page.keyboard.press("Control+f");
  await expect(page.locator(".body-editor .cm-search")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".body-editor .cm-search")).not.toBeVisible();
  await expect(scroller).toHaveClass(/cm-vimMode/);
  await expect(blockCursor).toBeVisible();
});

test("edits structured frontmatter without exposing an undifferentiated textarea", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("option").filter({ hasText: "Ideas for Sunday 12" }).click();
  await page.getByRole("button", { name: "Note properties" }).click();

  const panel = page.getByRole("complementary", { name: "Note properties" });
  await expect(panel.getByRole("heading", { name: "Properties" })).toBeVisible();
  const tags = panel.getByRole("group", { name: "tags" });
  await expect(tags.getByRole("button", { name: "Add tag" })).toBeVisible();
  await tags.getByRole("button", { name: "Add tag" }).click();
  await tags.getByRole("textbox", { name: "tags value item 3" }).fill("nested editing");
  await expect(panel.getByText("All changes saved")).toBeVisible();
  await panel.getByRole("button", { name: "Close properties" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: "Note properties" }).click();
  await panel.getByRole("tab", { name: /JSON/ }).click();
  await expect(panel.getByRole("textbox", { name: "Frontmatter JSON" })).toContainText('"nested editing"');
});

test("adds schema properties and edits the complete Markdown record", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("option").filter({ hasText: "Ideas for Sunday 12" }).click();
  await page.getByRole("button", { name: "Note properties" }).click();

  const panel = page.getByRole("complementary", { name: "Note properties" });
  await panel.getByRole("button", { name: "Add property" }).click();
  await panel.getByRole("searchbox", { name: "Find a property" }).fill("title");
  await panel.locator(".property-options button").filter({ hasText: "title" }).click();
  await expect(panel.getByLabel("title property kind")).toHaveCount(0);
  await panel.getByRole("textbox", { name: "title value" }).fill("Source-backed title");
  await expect(panel.getByText("All changes saved")).toBeVisible();
  await panel.getByRole("button", { name: "Close properties" }).click();
  await expect(panel).not.toBeVisible();

  await page.getByRole("button", { name: "Note properties" }).click();
  await panel.getByRole("tab", { name: "Source" }).click();
  const source = panel.getByRole("textbox", { name: "Complete record source" });
  await expect(source).toContainText("title: Source-backed title");
  const original = await source.textContent();
  await source.fill(`${original ?? ""}\nSource tail.\n`);
  await panel.getByRole("tab", { name: "Source" }).click();
  await expect(panel.getByText("Source saved")).toBeVisible();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close properties" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: "Note properties" }).click();
  await panel.getByRole("tab", { name: "Source" }).click();
  await expect(panel.getByRole("textbox", { name: "Complete record source" })).toContainText("Source tail.");
});

test("keeps a ten-thousand-note collection responsive and virtualized", async ({ page }) => {
  const started = Date.now();
  await page.goto("?demo=10000");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  const firstUsableMs = Date.now() - started;
  expect(firstUsableMs).toBeLessThan(1_800);
  await expect(page.getByText("10,000 notes")).toBeVisible();
  const fullIndexMs = Date.now() - started;
  expect(fullIndexMs).toBeLessThan(2_500);

  const renderedRows = await page.locator(".note-row").count();
  expect(renderedRows).toBeLessThan(40);

  const searchStarted = Date.now();
  await page.getByRole("textbox", { name: "Search notes and files" }).fill("quiet interface 51");
  await expect(page.locator(".list-header p")).not.toHaveText("10,000 notes");
  const searchReadyMs = Date.now() - searchStarted;
  expect(searchReadyMs).toBeLessThan(900);

  const inputLatency = await page.getByRole("textbox", { name: "Search notes and files" }).evaluate((input) => {
    const samples: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const start = performance.now();
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "x", inputType: "insertText" }));
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length * 0.95)];
  });
  expect(inputLatency).toBeLessThan(16);

  console.log(JSON.stringify({ firstUsableMs, fullIndexMs, searchReadyMs, renderedRows, inputP95Ms: inputLatency }));
});

test("uses one navigable pane at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("?demo=80");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Back to notes" }).click();
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await page.getByRole("option").first().click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Back to notes" }).click();
  await page.getByRole("button", { name: "Collections" }).click();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toBeVisible();
});

test("maps browser history to the mobile pane stack", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("?demo=40");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("region", { name: "Notes" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note title" })).not.toBeVisible();

  await page.goBack();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toBeVisible();
});

test("protects an unfinished note draft with a modal confirmation", async ({ page }) => {
  await page.goto("?demo=40");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("A draft worth keeping");
  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "Discard this note?" });
  await expect(confirmation).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("A draft worth keeping");

  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();
  await confirmation.getByRole("button", { name: "Discard note" }).click();
  await expect(page.getByRole("main", { name: "Create note" })).not.toBeVisible();
});

test("keeps every editor action reachable at the minimum mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await expect(body).toBeVisible();

  const bounds = await page.locator(".editor-pane").evaluate((pane) => {
    const action = pane.querySelector<HTMLElement>(".note-actions");
    const surface = pane.querySelector<HTMLElement>(".writing-surface");
    if (!action || !surface) throw new Error("The note editor is incomplete.");
    return {
      paneRight: pane.getBoundingClientRect().right,
      actionRight: action.getBoundingClientRect().right,
      surfaceRight: surface.getBoundingClientRect().right,
      viewportWidth: window.innerWidth
    };
  });

  expect(bounds.paneRight).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.actionRight).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.surfaceRight).toBeLessThanOrEqual(bounds.viewportWidth);

  await body.click();
  await page.keyboard.press("Control+f");
  const searchBounds = await page.locator(".body-editor .cm-search").evaluate((search) => ({
    right: search.getBoundingClientRect().right,
    width: search.clientWidth,
    scrollWidth: search.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  expect(searchBounds.right).toBeLessThanOrEqual(searchBounds.viewportWidth);
  expect(searchBounds.scrollWidth).toBeLessThanOrEqual(searchBounds.width);
  await page.locator('.body-editor .cm-search button[name="close"]').click();

  await page.getByLabel("More note actions").click();
  await expect(page.getByRole("menuitem", { name: "Check note" })).toBeVisible();
});

test("keeps type editing usable at the minimum mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Back to notes" }).click();
  await page.getByRole("button", { name: "Collections" }).click();
  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("option", { name: /note/ }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");
  await expect(page.getByRole("heading", { name: "Collection behaviour" })).toBeVisible();
  const collectionGeometry = await page.locator(".collection-behaviour-section").evaluate((section) => {
    const bounds = section.getBoundingClientRect();
    const controls = [...section.querySelectorAll<HTMLElement>("input, select, button")];
    return {
      pageInsideViewport: document.documentElement.scrollWidth <= window.innerWidth,
      controlsInside: controls.every((control) => {
        const controlBounds = control.getBoundingClientRect();
        return controlBounds.left >= bounds.left - 0.5 && controlBounds.right <= bounds.right + 0.5;
      })
    };
  });
  expect(collectionGeometry).toEqual({ pageInsideViewport: true, controlsInside: true });
  await page.getByRole("button", { name: "YAML" }).click();
  const typeEditor = page.getByRole("textbox", { name: "note type YAML" });
  await expect(typeEditor).toBeVisible();
  await expect(typeEditor).toHaveAttribute("tabindex", "0");

  const rightEdges = await page.locator(".type-inspector").evaluate((inspector) => ({
    inspector: inspector.getBoundingClientRect().right,
    source: inspector.querySelector<HTMLElement>(".type-source")!.getBoundingClientRect().right,
    actions: inspector.querySelector<HTMLElement>(".type-editor-actions")!.getBoundingClientRect().right,
    viewport: window.innerWidth
  }));
  expect(rightEdges.inspector).toBeLessThanOrEqual(rightEdges.viewport);
  expect(rightEdges.source).toBeLessThanOrEqual(rightEdges.viewport);
  expect(rightEdges.actions).toBeLessThanOrEqual(rightEdges.viewport);

  await page.getByRole("button", { name: "Back to types" }).click();
  await page.getByRole("button", { name: "New type" }).click();
  await expect(page.getByText("New", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review changes" })).toBeVisible();
});

test("keeps a catalog pack summary fixed when mobile confirmation opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Back to notes" }).click();
  await page.getByRole("button", { name: "Collections" }).click();
  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("button", { name: "Add a type" }).click();

  const installButton = page.getByRole("button", { name: "Add Contact" }).first();
  const status = page.getByText("Adds 1 type");
  const before = {
    install: await installButton.evaluate((element) => element.getBoundingClientRect().top),
    status: await status.evaluate((element) => element.getBoundingClientRect().top)
  };

  await installButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "Add Contact?" })).toBeVisible();
  await expect.poll(() => installButton.evaluate((element) => element.getBoundingClientRect().top)).toBe(before.install);
  await expect.poll(() => status.evaluate((element) => element.getBoundingClientRect().top)).toBe(before.status);
});

test("has no automatically detectable accessibility violations across editor surfaces", async ({ page }) => {
  await page.goto("?demo=80");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("main", { name: "Create note" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("main", { name: "Editor settings" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
