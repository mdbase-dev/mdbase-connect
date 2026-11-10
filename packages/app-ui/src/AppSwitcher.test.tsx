// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { accessibleName, visibleLabel } from "../test/label-in-name.js";
import { AppSwitcher } from "./AppSwitcher.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppSwitcher", () => {
  it("shows the current app's wordmark as a closed menu button", () => {
    const markup = renderToStaticMarkup(<AppSwitcher current="writer" />);

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('class="mdbase-mark mdbase-app-mark is-writer wordmark-mark mdbase-motion-keys-first"');
    expect(markup).not.toContain('role="menu"');
  });

  it("names the trigger by the wordmark it shows", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<AppSwitcher current="writer" />));
    const trigger = container.querySelector(".mdbase-app-switcher")!;

    expect(visibleLabel(trigger)).toBe("mdbase writer");
    expect(accessibleName(trigger)).toContain(visibleLabel(trigger));
    act(() => root.unmount());
    container.remove();
  });

  it("ends the menu with a link to the SDK guide that the arrow keys reach", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<AppSwitcher current="writer" urls={{ editor: "https://editor.example", writer: "https://writer.example" }} />));
    act(() => container.querySelector<HTMLElement>(".mdbase-app-switcher")!.click());
    const items = [...container.querySelectorAll<HTMLAnchorElement>('[role="menu"] [role="menuitem"]:not([aria-disabled="true"])')];
    const build = items.at(-1)!;

    expect(items.map((item) => item.getAttribute("href"))).toEqual(["https://editor.example/", "https://mdbase.dev/sdk/"]);
    expect(build.textContent).toContain("Build your own");
    expect(build.target).toBe("_blank");
    act(() => root.unmount());
    container.remove();
  });
});
