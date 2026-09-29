import { expect, type Locator } from "@playwright/test";

/** Chooses a value in @mdbase-dev/ui's Select the way a person does: open it, press the option. */
export async function chooseOption(select: Locator, value: string): Promise<void> {
  await select.click();
  const list = select.page().locator(`[id="${await select.getAttribute("aria-controls")}"]`);
  await list.locator(`[role="option"][data-value="${value}"]`).click();
  await expect(select).toHaveAttribute("data-value", value);
  await expect(select).toHaveAttribute("aria-expanded", "false");
}
