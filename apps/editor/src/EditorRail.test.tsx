import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditorRail } from "./EditorRail";

const feedback = vi.hoisted(() => ({ enabled: false, open: vi.fn(), reportError: vi.fn(), wiggle: 0 }));
vi.mock("@mdbase-dev/ui/feedback", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mdbase-dev/ui/feedback")>(),
  useFeedback: () => feedback
}));

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
    switcher={<button>Shared switcher</button>}
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
    expect([...tools.children].map((element) => element.textContent)).toEqual(["Types1", "Settings"]);
    expect(within(tools).getByRole(links ? "link" : "button", { name: "Settings" })).toHaveClass("selected");
    expect(tools.parentElement).toBe(scroll.parentElement);
    expect(screen.getByRole("status").closest("footer")).toBe(tools.parentElement!.nextElementSibling);
  });

  it("tabs through the scroll contents, then Types and Settings in visual order", async () => {
    const user = userEvent.setup();
    const { onTypes, onSettings } = renderRail();
    const order = [
      screen.getByRole("button", { name: "Shared switcher" }),
      screen.getByRole("button", { name: "All notes, 300 total" }),
      screen.getByRole("button", { name: "Notes folder" }),
      screen.getByRole("button", { name: "New folder" }),
      screen.getByRole("button", { name: "Types (1)" }),
      screen.getByRole("button", { name: "Settings" })
    ];
    for (const target of order) {
      await user.tab();
      expect(target).toHaveFocus();
    }
    expect(order[5]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSettings).toHaveBeenCalledOnce();
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(onTypes).toHaveBeenCalledOnce();
  });

  it("ends the fixed tools group with the feedback entry when feedback is available", async () => {
    const user = userEvent.setup();
    feedback.enabled = true;
    try {
      renderRail();
      const tools = screen.getByRole("group", { name: "Collection tools" });
      expect([...tools.children].map((element) => element.textContent)).toEqual(["Types1", "Settings", "Send feedback"]);
      screen.getByRole("button", { name: "Settings" }).focus();
      await user.tab();
      const entry = within(tools).getByRole("button", { name: "Send feedback" });
      expect(entry).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(feedback.open).toHaveBeenCalledOnce();
      expect(feedback.open).toHaveBeenCalledWith();
    } finally {
      feedback.enabled = false;
    }
  });

  it("keeps the mobile return outside the scroll and tools regions", () => {
    const { container } = renderRail(true, true);
    const back = screen.getByRole("link", { name: "Return to note" });
    expect(back.parentElement).toBe(screen.getByRole("navigation"));
    expect(container.querySelector(".rail-scroll")).not.toContainElement(back);
    expect(screen.getByRole("group", { name: "Collection tools" })).not.toContainElement(back);
  });
});
