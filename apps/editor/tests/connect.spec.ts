import { expect, test } from "@playwright/test";

// The /connect console is retired: collections, access and accounts are managed
// in mdbase itself, and old console links open the editor instead.
const retiredLinks = [
  "connect?server=http%3A%2F%2Fconnect.test&collection=collection",
  "connect/storage?server=http%3A%2F%2Fconnect.test&collection=collection",
  "connect/collections?server=http%3A%2F%2Fconnect.test",
  "connect/collections/native?server=http%3A%2F%2Fconnect.test&collection=native"
];

for (const link of retiredLinks) {
  test(`opens the editor for the retired console link /${link.split("?")[0]}`, async ({ page, baseURL }) => {
    const consoleRequests: string[] = [];
    await page.route("http://connect.test/**", async (route) => {
      consoleRequests.push(route.request().url());
      await route.abort();
    });

    await page.goto(link);

    await expect(page).toHaveURL(baseURL!);
    await expect(page.getByRole("complementary", { name: "mdbase connect navigation" })).toHaveCount(0);
    expect(consoleRequests).toEqual([]);
  });
}
