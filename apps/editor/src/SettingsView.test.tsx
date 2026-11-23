import { render, screen, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { managedAppOrigins } from "../../../scripts/lib/managed-app-origins.mjs";
import { DemoCollectionGateway } from "./demo-gateway";
import { editorEnvironment } from "./environment";
import { defaultPreferences } from "./preferences";
import { SettingsView } from "./settings/SettingsView";

describe("quiet settings document", () => {
  it.each(["available", "unavailable"] as const)("does not infer custody from %s reachability", async (directAccess) => {
    const gateway = new DemoCollectionGateway(4);
    const description = await gateway.describe();
    const props = { description, noteCount: 4, preferences: defaultPreferences, directAccessBusy: false, onChange: vi.fn(), onBack: vi.fn(), onForget: vi.fn(), onRequestDirectAccess: vi.fn() };
    const view = render(<SettingsView {...props} connection={{ collectionId: "test", operations: [], directAccess }} />);
    expect(screen.queryByText("Main copy")).not.toBeInTheDocument();
    view.rerender(<SettingsView {...props} connection={{ collectionId: "test", operations: [], authorityKind: "hosted", directAccess }} />);
    expect(screen.getByText("Main copy")).toBeInTheDocument();
    expect(screen.getByText("Hosted by mdbase")).toBeInTheDocument();
  });
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
    expect(screen.queryByRole("heading", { name: "Other apps" })).not.toBeInTheDocument();
  });

  it("shows Other apps and MCP setup for a real Connect collection", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });

    const gateway = new DemoCollectionGateway(4);
    const baseDescription = await gateway.describe();
    const collectionId = "col/abc 123";
    const description = { ...baseDescription, collectionId };
    const origins = managedAppOrigins[editorEnvironment];

    render(
      <SettingsView
        description={description}
        connection={{ collectionId, operations: ["read", "update"] }}
        noteCount={4}
        preferences={defaultPreferences}
        directAccessBusy={false}
        onChange={vi.fn()}
        onBack={vi.fn()}
        onForget={vi.fn()}
        onRequestDirectAccess={vi.fn()}
      />
    );

    const section = screen.getByRole("heading", { name: "Other apps" }).closest("section")!;
    expect(within(section).getByText("Open this collection in another mdbase app or connect an AI client.")).toBeInTheDocument();

    const encodedId = encodeURIComponent(collectionId);
    const expectedApps = [
      { name: "TaskNotes", origin: origins.tasknotesOrigin },
      { name: "Reader", origin: origins.readerOrigin },
      { name: "Writer", origin: origins.writerOrigin },
      { name: "Journal", origin: origins.journalOrigin }
    ];

    for (const app of expectedApps) {
      const link = within(section).getByRole("link", { name: `Open ${app.name}` });
      expect(link).toHaveAttribute("href", `${app.origin}?collection=${encodedId}`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }

    expect(within(section).getByText("https://mcp.mdbase.dev/mcp")).toBeInTheDocument();
    const setupLink = within(section).getByRole("link", { name: "Set up" });
    expect(setupLink).toHaveAttribute("href", "https://mdbase.dev/apps/mcp/");
    expect(setupLink).toHaveAttribute("target", "_blank");
    expect(setupLink).toHaveAttribute("rel", "noopener noreferrer");

    const copyButton = within(section).getByRole("button", { name: "Copy" });
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith("https://mcp.mdbase.dev/mcp");
    expect(within(section).getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("hides Other apps when there is no real collection connection", async () => {
    const gateway = new DemoCollectionGateway(4);
    const description = await gateway.describe();
    const props = {
      description,
      noteCount: 4,
      preferences: defaultPreferences,
      directAccessBusy: false,
      onChange: vi.fn(),
      onBack: vi.fn(),
      onForget: vi.fn(),
      onRequestDirectAccess: vi.fn()
    };

    const view = render(<SettingsView {...props} connection={null} />);
    expect(screen.queryByRole("heading", { name: "Other apps" })).not.toBeInTheDocument();

    const unsyncedGateway = Object.assign(new DemoCollectionGateway(4), {
      syncState: () => "unsynced" as const
    });
    view.rerender(
      <SettingsView
        {...props}
        gateway={unsyncedGateway}
        connection={{ collectionId: "local-unsynced", operations: ["read", "update"] }}
      />
    );
    expect(screen.queryByRole("heading", { name: "Other apps" })).not.toBeInTheDocument();
  });
});
