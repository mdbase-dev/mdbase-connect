import { act, render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ header, value, onChange, label, footer, readOnly }: { header?: ReactNode; value: string; onChange?: (value: string) => void; label: string; footer?: ReactNode; readOnly?: boolean }) =>
    <>{header}<textarea aria-label={label} value={value} readOnly={readOnly} onChange={(event) => onChange?.(event.target.value)} />{footer}</>
}));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({
  getTotalSize: () => count * 76,
  getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
}) }));

describe("Version history", () => {
  it("takes no typing while a restore writes, then shows the restored text", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(4);
    const path = (await gateway.mostRecentNote())!;
    const opened = await gateway.read(path);
    await gateway.updateDocument(path, `${opened.document}\nAn edit made since.\n`, opened.revision);
    const write = gateway.updateDocument.bind(gateway);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const restoring = vi.spyOn(gateway, "updateDocument").mockImplementation(async (target, document, revision) => {
      await held;
      return write(target, document, revision);
    });

    render(<App gateway={gateway} />);
    const body = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Note body" });
    await waitFor(() => expect(body.value).toContain("An edit made since."));
    await user.click(screen.getByRole("button", { name: "Version history" }));
    // The panel loads lazily: its placeholder shares the name, so look inside once the panel has loaded.
    const history = async () => {
      await screen.findByRole("heading", { name: "History" }, { timeout: 10_000 });
      return within(screen.getByRole("complementary", { name: "Version history" }));
    };
    await user.click(await (await history()).findByRole("button", { name: /Created/ }, { timeout: 10_000 }));
    await user.click(await (await history()).findByRole("button", { name: "Restore this version" }, { timeout: 10_000 }));
    await user.click(within(await screen.findByRole("dialog", { name: "Restore this version?" })).getByRole("button", { name: /^Restore$/ }));

    await waitFor(() => expect(restoring).toHaveBeenCalledOnce());
    expect(body).toHaveAttribute("readonly");
    await act(async () => release());
    await waitFor(() => expect(body.value).not.toContain("An edit made since."));
    expect(body).not.toHaveAttribute("readonly");
  });
});
