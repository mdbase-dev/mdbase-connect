// @vitest-environment jsdom
import { act, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accessibleName, visibleLabel } from "../test/label-in-name.js";
import { AppSwitcher } from "./AppSwitcher.js";
import { aiAssistants, mcpSetupUrl } from "./apps.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.getAnimations = () => [];

function openMenu(element: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(element));
  act(() => container.querySelector<HTMLElement>(".mdbase-app-switcher")!.click());
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

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

  it("stays backward-compatible when only Editor, Reader and Writer URLs are passed", () => {
    const { container, unmount } = openMenu(
      <AppSwitcher
        current="writer"
        urls={{ editor: "https://editor.example", reader: "https://reader.example", writer: "https://writer.example" }}
      />
    );
    const items = [...container.querySelectorAll<HTMLAnchorElement>('[role="menu"] [role="menuitem"]:not([aria-disabled="true"])')];
    const build = items.at(-2)!;

    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "https://editor.example/",
      "https://reader.example/",
      "https://mdbase.dev/sdk/",
      null
    ]);
    expect(container.textContent).not.toContain("Journal");
    expect(container.textContent).not.toContain("TaskNotes");
    expect(build.textContent).toContain("Your app here");
    expect(build.target).toBe("_blank");
    unmount();
  });

  it("renders Journal and TaskNotes with their marks and preserves shared query parameters", () => {
    window.history.replaceState(null, "", "/?collection=col_42&server=https%3A%2F%2Fconnect.example&source=ignored");
    const { container, unmount } = openMenu(
      <AppSwitcher
        current="editor"
        urls={{
          editor: "https://editor.example",
          reader: "https://reader.example",
          writer: "https://writer.example",
          journal: "https://journal.example",
          tasknotes: "https://tasks.example"
        }}
      />
    );
    const items = [...container.querySelectorAll<HTMLAnchorElement>('[role="menu"] [role="menuitem"]:not([aria-disabled="true"])')];
    const sharedQuery = "?collection=col_42&server=https%3A%2F%2Fconnect.example";

    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      `https://reader.example/${sharedQuery}`,
      `https://writer.example/${sharedQuery}`,
      `https://journal.example/${sharedQuery}`,
      `https://tasks.example/${sharedQuery}`,
      "https://mdbase.dev/sdk/",
      null
    ]);
    expect(container.querySelector(".mdbase-app-menu-mark.is-journal")).not.toBeNull();
    expect(container.querySelector(".mdbase-app-menu-mark.is-tasknotes")).not.toBeNull();
    expect(container.querySelector(".mdbase-menu-note")?.textContent).toBe("Opens in a new tab. Sign in to the app if prompted to open this collection.");
    unmount();

    window.history.replaceState(null, "", "/");
    const withoutCollection = openMenu(
      <AppSwitcher current="editor" urls={{ editor: "https://editor.example", journal: "https://journal.example" }} />
    );
    expect(withoutCollection.container.querySelector(".mdbase-menu-note")?.textContent).toBe("Opens in a new tab");
    withoutCollection.unmount();
  });

  it("opens the AI assistants submenu with the official listings, the MCP guide and Memory, and omits it when mcpUrl is null", () => {
    const shown = openMenu(
      <AppSwitcher current="writer" urls={{ editor: "https://editor.example", writer: "https://writer.example" }} />
    );
    const row = shown.container.querySelector<HTMLButtonElement>('[role="menu"] button[aria-haspopup="menu"]')!;

    expect(row.textContent).toContain("AI assistants");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    act(() => row.click());
    const submenu = document.getElementById(row.getAttribute("aria-controls")!)!;
    const links = [...submenu.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]')];

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(submenu.getAttribute("role")).toBe("menu");
    expect(links.map((link) => link.href)).toEqual([...aiAssistants.map((assistant) => assistant.url), mcpSetupUrl, "https://memory.mdbase.dev/"]);
    expect(links.map((link) => link.querySelector("strong")!.textContent)).toEqual(["Claude", "ChatGPT", "Other AI clients", "Memory"]);
    expect(links.every((link) => link.target === "_blank" && link.rel === "noopener")).toBe(true);
    expect(document.activeElement).toBe(links[0]);

    act(() => links[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(links[1]);
    act(() => links[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(row);
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement?.getAttribute("href")).toBe(aiAssistants[0]!.url);
    shown.unmount();

    const hidden = openMenu(
      <AppSwitcher current="writer" urls={{ editor: "https://editor.example", writer: "https://writer.example" }} mcpUrl={null} />
    );
    const items = [...hidden.container.querySelectorAll<HTMLAnchorElement>('[role="menu"] [role="menuitem"]:not([aria-disabled="true"])')];

    expect(items.map((item) => item.getAttribute("href"))).toEqual(["https://editor.example/", "https://mdbase.dev/sdk/"]);
    expect(hidden.container.querySelector('[role="menu"] [role="separator"]')).toBeNull();
    expect(hidden.container.textContent).not.toContain("AI assistants");
    hidden.unmount();
  });

  it("keeps the parent menu's arrow keys out of an open submenu", () => {
    const { container, unmount } = openMenu(<AppSwitcher current="writer" urls={{ editor: "https://editor.example" }} />);
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    const row = menu.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => row.click());
    act(() => row.focus());
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));

    expect(document.activeElement?.getAttribute("href")).toBe("https://editor.example/");
    unmount();
  });

  it("offers an empty slot for your own app that spins past every app's mark", () => {
    const { container, unmount } = openMenu(<AppSwitcher current="writer" urls={{ editor: "https://editor.example" }} />);
    const slot = container.querySelector<HTMLAnchorElement>('[role="menu"] a[href="https://mdbase.dev/sdk/"]')!;
    const reel = slot.querySelector<HTMLElement>(".mdbase-app-menu-reel")!;

    expect(slot.textContent).toContain("Your app here");
    expect(slot.target).toBe("_blank");
    expect(slot.querySelector(".mdbase-app-menu-slot")!.getAttribute("aria-hidden")).toBe("true");
    expect(reel.children).toHaveLength(Number(reel.style.getPropertyValue("--reel-stops")) + 1);
    for (const app of ["editor", "reader", "writer", "journal", "tasknotes"]) expect(reel.querySelector(`.is-${app}`)).not.toBeNull();
    expect(reel.lastElementChild!.className).toBe("mdbase-app-menu-slot-caret");
    unmount();
  });

  it("supports TaskNotes and Journal as current apps with custom trigger content and explicit collectionId", () => {
    const { container, unmount } = openMenu(
      <AppSwitcher
        current="tasknotes"
        className="wordmark"
        collectionId="col_99"
        urls={{
          editor: "https://editor.example",
          reader: "https://reader.example",
          writer: "https://writer.example",
          journal: "https://journal.example",
          tasknotes: "https://tasks.example"
        }}
      >
        <img alt="" src="/tasknotes-mark.svg" />
        <span>TaskNotes</span>
      </AppSwitcher>
    );
    const trigger = container.querySelector(".mdbase-app-switcher.wordmark")!;
    expect(visibleLabel(trigger)).toBe("TaskNotes");
    expect(accessibleName(trigger)).toContain("TaskNotes");

    const menu = container.querySelector('[role="menu"]')!;
    expect(menu.querySelector(".mdbase-menu-heading")?.textContent).toBe("Open this collection in");
    const currentItem = menu.querySelector('[aria-current="page"]')!;
    expect(currentItem.textContent).toContain("TaskNotes");
    expect(currentItem.textContent).toContain("Current");

    const items = [...menu.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "https://editor.example/?collection=col_99",
      "https://reader.example/?collection=col_99",
      "https://writer.example/?collection=col_99",
      "https://journal.example/?collection=col_99",
      "https://mdbase.dev/sdk/",
      null
    ]);
    unmount();

    const journalMarkup = renderToStaticMarkup(<AppSwitcher current="journal" />);
    expect(journalMarkup).toContain('class="mdbase-mark mdbase-app-mark is-journal wordmark-mark"');
    expect(journalMarkup).toContain("Journal");
  });
  it("has no trigger with variant none, opens from the app's anchor and returns focus to it", () => {
    let anchor: HTMLButtonElement | null = null;
    const onOpenChange = vi.fn();
    function Host() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <>
        <button ref={(element) => { anchorRef.current = element; anchor = element; }} type="button" onClick={() => setOpen(true)}>More</button>
        <AppSwitcher
          current="tasknotes"
          variant="none"
          anchorRef={anchorRef}
          collectionId="col_7"
          urls={{ editor: "https://editor.example" }}
          open={open}
          onOpenChange={(next) => { onOpenChange(next); setOpen(next); }}
        />
      </>;
    }
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<Host />));
    expect(container.querySelector(".mdbase-app-switcher")).toBeNull();
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => anchor!.click());
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("mdbase apps");
    expect(menu.querySelector('a[href="https://editor.example/?collection=col_7"]')).not.toBeNull();
    expect(menu.contains(document.activeElement)).toBe(true);

    // The anchor counts as part of the menu, so pressing it leaves the app to decide.
    act(() => { anchor!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(container.querySelector('[role="menu"][data-open="true"]')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    act(() => root.unmount());
    container.remove();
  });

  it("asks through onOpenChange when controlled, and keeps its own state otherwise", () => {
    const onOpenChange = vi.fn();
    const controlled = openMenu(<AppSwitcher current="writer" open={false} onOpenChange={onOpenChange} />);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(controlled.container.querySelector('[role="menu"]')).toBeNull();
    controlled.unmount();

    onOpenChange.mockClear();
    const own = openMenu(<AppSwitcher current="writer" onOpenChange={onOpenChange} />);
    expect(own.container.querySelector('[role="menu"]')).not.toBeNull();
    act(() => own.container.querySelector<HTMLElement>(".mdbase-app-switcher")!.click());
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    own.unmount();
  });
});
