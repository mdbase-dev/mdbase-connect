import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditorRail } from "./EditorRail";

function renderRail(links = false, mobileReturn = false) {
  const onTypes = vi.fn();
  const onSettings = vi.fn();
  const view = render(<EditorRail
    collectionName="Writing"
    noteCount={300}
    typeCount={1}
    surface="settings"
    notes={links ? { href: "/notes" } : { onClick: vi.fn() }}
    types={links ? { href: "/types" } : { onClick: onTypes }}
    settings={links ? { href: "/settings" } : { onClick: onSettings }}
    connectHref="/connect"
    onSwitch={vi.fn()}
    mobileReturn={mobileReturn ? { href: "/note", label: "Return to note" } : undefined}
    footer={<p role="status">Connected</p>}
  ><button>Notes folder</button><button>New folder</button></EditorRail>);
  return { ...view, onTypes, onSettings };
}

describe("collection rail regions", () => {
  it.each([false, true])("keeps tools out of the folder scroller with link destinations: %s", (links) => {
    const { container } = renderRail(links);
    const scroll = container.querySelector<HTMLElement>(".rail-scroll")!;
    const tools = screen.getByRole("group", { name: "Collection tools" });
    expect(within(scroll).getByRole(links ? "link" : "button", { name: "All notes, 300 total" })).toBeInTheDocument();
    expect(within(scroll).getByRole("button", { name: "Notes folder" })).toBeInTheDocument();
    expect(within(scroll).getByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(scroll).not.toContainElement(tools);
    expect([...tools.children].map((element) => element.textContent)).toEqual(["Types1", "Settings", "Connect"]);
    expect(within(tools).getByRole(links ? "link" : "button", { name: "Settings" })).toHaveClass("selected");
    expect(tools.parentElement).toBe(scroll.parentElement);
    expect(screen.getByRole("status").closest("footer")).toBe(tools.parentElement!.nextElementSibling);
  });

  it("tabs through the scroll contents, then Types, Settings, and Connect in visual order", async () => {
    const user = userEvent.setup();
    const { onTypes, onSettings } = renderRail();
    const order = [
      screen.getByRole("button", { name: "Switch collection, current collection Writing" }),
      screen.getByRole("button", { name: "All notes, 300 total" }),
      screen.getByRole("button", { name: "Notes folder" }),
      screen.getByRole("button", { name: "New folder" }),
      screen.getByRole("button", { name: "Types (1)" }),
      screen.getByRole("button", { name: "Settings" }),
      screen.getByRole("link", { name: "Connect" })
    ];
    for (const target of order) {
      await user.tab();
      expect(target).toHaveFocus();
    }
    await user.tab({ shift: true });
    expect(order[5]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSettings).toHaveBeenCalledOnce();
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(onTypes).toHaveBeenCalledOnce();
  });

  it("keeps the mobile Connect return outside the scroll and tools regions", () => {
    const { container } = renderRail(true, true);
    const back = screen.getByRole("link", { name: "Return to note" });
    expect(back.parentElement).toBe(screen.getByRole("navigation"));
    expect(container.querySelector(".rail-scroll")).not.toContainElement(back);
    expect(screen.getByRole("group", { name: "Collection tools" })).not.toContainElement(back);
  });
});
