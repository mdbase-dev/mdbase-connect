// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { accessibleName, visibleLabel } from "../test/label-in-name.js";
import { AppSwitcher } from "./AppSwitcher.js";
import { mcpSetupUrl } from "./apps.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    const build = items.at(-1)!;

    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "https://editor.example/",
      "https://reader.example/",
      mcpSetupUrl,
      "https://mdbase.dev/sdk/"
    ]);
    expect(container.textContent).not.toContain("Journal");
    expect(container.textContent).not.toContain("TaskNotes");
    expect(build.textContent).toContain("Build your own");
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
      mcpSetupUrl,
      "https://mdbase.dev/sdk/"
    ]);
    expect(container.querySelector(".mdbase-app-menu-mark.is-journal")).not.toBeNull();
    expect(container.querySelector(".mdbase-app-menu-mark.is-tasknotes")).not.toBeNull();
    unmount();
  });

  it("renders the AI clients (MCP) link by default and omits it when mcpUrl is null", () => {
    const shown = openMenu(
      <AppSwitcher current="writer" urls={{ editor: "https://editor.example", writer: "https://writer.example" }} />
    );
    const mcpLink = shown.container.querySelector<HTMLAnchorElement>(`[role="menu"] a[href="${mcpSetupUrl}"]`);

    expect(mcpLink).not.toBeNull();
    expect(mcpLink!.textContent).toContain("AI clients (MCP)");
    expect(mcpLink!.textContent).toContain("Claude, ChatGPT and Codex");
    expect(mcpLink!.target).toBe("_blank");
    expect(mcpLink!.rel).toBe("noopener");
    expect(shown.container.querySelector('[role="menu"] [role="separator"]')).not.toBeNull();
    shown.unmount();

    const hidden = openMenu(
      <AppSwitcher current="writer" urls={{ editor: "https://editor.example", writer: "https://writer.example" }} mcpUrl={null} />
    );
    const items = [...hidden.container.querySelectorAll<HTMLAnchorElement>('[role="menu"] [role="menuitem"]:not([aria-disabled="true"])')];

    expect(items.map((item) => item.getAttribute("href"))).toEqual(["https://editor.example/", "https://mdbase.dev/sdk/"]);
    expect(hidden.container.querySelector('[role="menu"] [role="separator"]')).toBeNull();
    expect(hidden.container.textContent).not.toContain("AI clients (MCP)");
    hidden.unmount();
  });
});
