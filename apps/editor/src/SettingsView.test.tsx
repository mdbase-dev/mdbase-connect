import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DemoCollectionGateway } from "./demo-gateway";
import { defaultPreferences } from "./preferences";
import { SettingsView } from "./SettingsView";

describe("quiet settings document", () => {
  it("keeps labelled switches keyboard-operable and technical facts in Details", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(12);
    const description = await gateway.describe();
    const onChange = vi.fn();
    render(<SettingsView description={description} connection={gateway.sessionSnapshot().connections[0] ?? null} noteCount={12}
      preferences={defaultPreferences} directAccessBusy={false} onChange={onChange}
      onBack={vi.fn()} onForget={vi.fn()} onRequestDirectAccess={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    const vim = screen.getByRole("switch", { name: "Vim key bindings" });
    expect(vim).toHaveClass("mdbase-switch");
    expect(vim).toHaveAttribute("aria-checked", "false");
    vim.focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith({ ...defaultPreferences, vim: true });
    const collection = screen.getByRole("heading", { name: "Collection" }).closest("section")!;
    expect(within(collection).getByText("12")).toBeInTheDocument();
    const details = within(collection).getByText("Details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    await user.click(within(details).getByText("Details"));
    expect(details).toHaveAttribute("open");
    expect(within(details).getByText("Specification")).toBeVisible();
  });
});
